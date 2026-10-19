import type { Current_ReviewPolicy } from "@morrow/contracts";
import type { WorkTx } from "../connection.js";
import type { WorkAuthority } from "../context.js";
import {
  ApprovalMappingError,
  decodeApproval,
  decodeDecision,
  decodePolicy,
  decodeProposal,
  type StoredApprovalRow,
  type StoredDecisionRow,
  type StoredProposalRow,
} from "./mapping.js";
import type { ProjectionFacts } from "./projection.js";

// Unlocked reads of one review family under the api role's tenant policy, and
// the review facts of review_context. They are never trusted as current: the
// command functions re-read under lock.

export interface ReviewFamily {
  readonly root: StoredProposalRow;
  /** Every proposal of the family (root first), by id. */
  readonly proposals: ReadonlyMap<string, StoredProposalRow>;
  /** Every approval of the family, by proposal id. */
  readonly approvals: ReadonlyMap<string, StoredApprovalRow>;
  readonly decisions: readonly StoredDecisionRow[];
}
export interface ReviewContext {
  readonly policy: Current_ReviewPolicy | null;
  readonly policyRevision: number | null;
  readonly defaultsDigest: string;
  readonly capability: {
    readonly effect: string;
    readonly irreversible: boolean;
    readonly reviewRequired: boolean;
    readonly killSwitch: boolean;
    readonly risk: string;
  } | null;
  readonly ownerPrincipalId: string | null;
  readonly ownerMembershipId: string | null;
  readonly activeHumanMembershipCount: number;
  readonly lastMembershipChangeAt: string | null;
  readonly claimedApprovalId: string | null;
  /** Database time (UtcTime, ms) when the facts were read. */
  readonly databaseNow: string;
}

const tenantOf = (a: WorkAuthority) => ({
  organizationId: a.actor.organizationId,
  workspaceId: a.actor.workspaceId!,
});
const bool = (value: unknown): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApprovalMappingError();
};
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new ApprovalMappingError();
  return value;
};
const opt = (value: unknown): string | null => (value === null ? null : str(value));

export async function readContext(
  tx: WorkTx,
  a: WorkAuthority,
  capabilityId: string,
  familyRootId: string | null,
): Promise<ReviewContext> {
  const rows = await tx.run("reviewContext", [capabilityId, familyRootId]);
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new ApprovalMappingError();
  const policyCanonical = opt(row.policy_canonical);
  const policyDigest = opt(row.policy_digest);
  const policy =
    policyCanonical === null || policyDigest === null
      ? null
      : decodePolicy(policyCanonical, policyDigest, tenantOf(a));
  const effect = opt(row.capability_effect);
  const count = str(row.active_human_membership_count);
  if (!/^(0|[1-9][0-9]{0,8})$/.test(count)) throw new ApprovalMappingError();
  return Object.freeze({
    policy,
    policyRevision: policy === null ? null : policy.revision,
    defaultsDigest: str(row.defaults_digest),
    capability:
      effect === null
        ? null
        : Object.freeze({
            effect,
            irreversible: bool(row.capability_irreversible),
            reviewRequired: bool(row.capability_review_required),
            killSwitch: bool(row.capability_kill_switch),
            risk: str(row.risk),
          }),
    ownerPrincipalId: opt(row.owner_principal_id),
    ownerMembershipId: opt(row.owner_membership_id),
    activeHumanMembershipCount: Number(count),
    lastMembershipChangeAt: opt(row.last_membership_change_at),
    claimedApprovalId: opt(row.claimed_approval_id),
    databaseNow: str(row.database_now),
  });
}

/** The proposal row by id, or null when absent or not in this workspace (RLS). */
export async function readProposalRow(
  tx: WorkTx,
  a: WorkAuthority,
  proposalId: string,
): Promise<StoredProposalRow | null> {
  const rows = await tx.run("proposalById", [proposalId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new ApprovalMappingError();
  return decodeProposal(rows[0]!, tenantOf(a));
}

export async function readFamily(
  tx: WorkTx,
  a: WorkAuthority,
  familyRootId: string,
): Promise<ReviewFamily | null> {
  const t = tenantOf(a);
  const proposalRows = await tx.run("proposalFamily", [familyRootId]);
  const proposals = new Map<string, StoredProposalRow>();
  for (const row of proposalRows) {
    const p = decodeProposal(row, t);
    if (p.familyRootId !== familyRootId) throw new ApprovalMappingError();
    proposals.set(p.proposal.id, p);
  }
  const root = proposals.get(familyRootId);
  if (!root) return null;
  if (root.derivedFromId !== null) throw new ApprovalMappingError();
  const approvals = new Map<string, StoredApprovalRow>();
  for (const row of await tx.run("approvalFamily", [familyRootId])) {
    const approval = decodeApproval(row, t);
    if (!proposals.has(approval.proposalId) || approvals.has(approval.proposalId))
      throw new ApprovalMappingError();
    approvals.set(approval.proposalId, approval);
  }
  const decisions = (await tx.run("decisionFamily", [familyRootId])).map((row) =>
    decodeDecision(row, t),
  );
  const ordered = new Map([
    [root.proposal.id, root],
    ...[...proposals].filter(([id]) => id !== root.proposal.id),
  ]);
  return Object.freeze({ root, proposals: ordered, approvals, decisions });
}

/** The projection facts of a family at review_context time. */
export function projectionFacts(
  ctx: ReviewContext,
  familyRootId: string,
  f: ReviewFamily,
): ProjectionFacts {
  const claimed =
    ctx.claimedApprovalId !== null &&
    [...f.approvals.values()].some(
      (x) => x.id === ctx.claimedApprovalId && x.familyRootId === familyRootId,
    );
  return Object.freeze({
    hasClaim: claimed,
    currentPolicyRevision: ctx.policyRevision,
    ownerPrincipalId: ctx.ownerPrincipalId,
    activeHumanMembershipCount: ctx.activeHumanMembershipCount,
    lastMembershipChangeAt: ctx.lastMembershipChangeAt,
  });
}

/**
 * WorkspaceOwnershipFacts for the review library. With no designated owner the
 * library still needs an Id, so the actor is named with a zero member count:
 * solo status then never holds (soloOwnerStatus requires a count of one).
 */
export function ownershipFacts(ctx: ReviewContext, a: WorkAuthority) {
  return ctx.ownerPrincipalId === null || ctx.ownerMembershipId === null
    ? {
        ownerPrincipalId: a.actor.principalId,
        ownerMembershipId: a.actor.membershipId!,
        activeHumanMembershipCount: 0,
        lastMembershipChangeAt: null,
      }
    : {
        ownerPrincipalId: ctx.ownerPrincipalId,
        ownerMembershipId: ctx.ownerMembershipId,
        activeHumanMembershipCount: ctx.activeHumanMembershipCount,
        lastMembershipChangeAt: ctx.lastMembershipChangeAt,
      };
}
