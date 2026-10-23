import type { Core_ApprovalRef, Core_ProposalRef, Current_Proposal } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { storeResource, type StoreResource } from "@morrow/policy/store-resource";
import {
  claimedApprovalCurrent,
  prepareApprovalClaim,
  proposalStore,
  storeLinkCurrent,
  type ClaimRefusal,
} from "../approvals/index.js";
import { readProposalRow } from "../approvals/family.js";
import { viewerRole } from "../approvals/reads.js";
import type { WorkTx } from "../connection.js";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import { changeItemText } from "../runs/listing-canonical.js";
import { claimantMayApply } from "./claimant.js";

// The gateway's first slice for Listings' product content (v1 PR 3; spine §2 steps 11-14;
// ADR-0022 items 3, 7, 9 and 15; ADR-0011). Everything here runs in the claimant's own
// session, one short transaction at a time; the broker does the Shopify side.
//   * admitApply: the approved proposal's claim. The proposal must be visible to the actor,
//     a store-bound catalog.content.publish proposal whose store is still linked through the
//     connection its targets name. prepareApprovalClaim checks the exact approval (digests,
//     revision, expiry, policy, counted reviewers) and the claimant's own `execute` on the
//     store resource with entitlement (claimantMayApply); the Worker builds each target's
//     exact approved item from the stored parameters and its digest; cmd_catalog_apply
//     consumes the approval once and records one authorized operation per product under an
//     operation lease. A family the same person already claimed continues (a retry, a double
//     click or a second tab adds nothing); one claimed by anyone else is refused.
//   * dispatchOperation: before each product, the claimant's authority again (the kernel, with
//     entitlement), the claimed approval again (still approved, unexpired, its reviewers
//     still eligible), then cmd_catalog_dispatch, which rechecks the lease, the stops, the link,
//     the installation, the scope and the approval's expiry under the row lock. Only a
//     dispatching operation reaches the broker.

export const applyConsumer = "catalog.apply";
const capability = "catalog.content.publish";
export type ApplyRefusal =
  | ClaimRefusal
  | "link_changed"
  | "not_catalog"
  | "already_claimed"
  | "stopped"
  | "scope_missing"
  | "installation_inactive"
  | "limit_reached"
  | "invalid"
  | "stale_authority"
  | "command_conflict";
export class ApplyReject extends Error {
  constructor(readonly reason: ApplyRefusal) {
    super("APPLY_REJECTED");
    this.name = "ApplyReject";
  }
}
export interface ApplyBody {
  readonly proposalRef: Core_ProposalRef;
  readonly approvalRef: Core_ApprovalRef;
}
/** POST /proposals/:proposalId/apply: exactly {proposalRef, approvalRef}, of that proposal. */
export function parseApplyBody(body: unknown, proposalId: string): ApplyBody | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).sort().join(",") !== "approvalRef,proposalRef") return null;
  const b = body as { proposalRef: unknown; approvalRef: unknown };
  if (
    !validateCurrentDefinition("ProposalRef", b.proposalRef) ||
    !validateCurrentDefinition("ApprovalRef", b.approvalRef) ||
    (b.proposalRef as Core_ProposalRef).id !== proposalId
  )
    return null;
  return Object.freeze({
    proposalRef: b.proposalRef as Core_ProposalRef,
    approvalRef: b.approvalRef as Core_ApprovalRef,
  });
}
/** The apply command's request digest: the work API's command digest of its body. */
export function applyRequestDigest(
  workspaceId: string,
  proposalId: string,
  body: ApplyBody,
): Promise<string> {
  return sha256Hex(
    canonicalJson(["morrow.work.command", 1, applyConsumer, workspaceId, [proposalId], body]),
  );
}

const text = (row: Record<string, unknown>, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
/** The union of the fields of the targets, in first-seen order. */
const fieldsOf = (p: Current_Proposal) => [...new Set(p.targets.flatMap((t) => t.fields))];

/** The claimed proposal's items, in its target order, as cmd_catalog_apply takes them. */
export async function applyItems(
  proposal: Current_Proposal,
  parameters: unknown,
): Promise<readonly { targetIndex: number; canonical: string; digest: string }[]> {
  const items = (parameters as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new WorkContextUnavailable();
  const selected = proposal.derivedFrom?.selectedTargetIndexes ?? null;
  const out = [];
  for (const [i, target] of proposal.targets.entries()) {
    const root = selected === null ? i : selected[i]!;
    const item = items.find(
      (x: unknown) => !!x && typeof x === "object" && (x as { targetIndex?: unknown }).targetIndex === root,
    ) as { targetIndex: number; productId: string; set: unknown } | undefined;
    if (!item || item.productId !== target.resource.id) throw new WorkContextUnavailable();
    const canonical = changeItemText(item);
    out.push(Object.freeze({ targetIndex: root, canonical, digest: await sha256Hex(canonical) }));
  }
  return Object.freeze(out);
}

export interface ClaimRecord {
  readonly familyRootId: string;
  readonly replayed: boolean;
}
async function familyClaim(tx: WorkTx, proposalId: string) {
  const rows = await tx.run("catalogClaimOf", [proposalId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new WorkContextUnavailable();
  const row = rows[0]!;
  return {
    principalId: text(row, "claimant_principal_id"),
    membershipId: text(row, "claimant_membership_id"),
    consumer: text(row, "consumer"),
    commandId: text(row, "consumer_command_id"),
  };
}

/** The claim (or the claimant's own earlier one), in one api transaction. */
export async function admitApply(
  tx: WorkTx,
  a: WorkAuthority,
  commandId: string,
  proposalId: string,
  body: ApplyBody,
  environment: "development" | "staging" | "production",
): Promise<ClaimRecord> {
  const stored = await readProposalRow(tx, a, proposalId);
  if (!stored || (await viewerRole(a, stored)) === null) throw new ApplyReject("not_found");
  const proposal = stored.proposal;
  const store = proposalStore(proposal);
  if (proposal.capabilityId !== capability || store === null) throw new ApplyReject("not_catalog");
  if (store === "invalid") throw new ApplyReject("not_found");
  // A family already claimed: the same person's claim continues; anyone else's is final.
  const claimed = await familyClaim(tx, proposalId);
  if (claimed) {
    if (
      claimed.principalId === a.actor.principalId &&
      claimed.membershipId === a.actor.membershipId &&
      claimed.consumer === applyConsumer
    ) {
      tx.rollbackOnly();
      return Object.freeze({ familyRootId: stored.familyRootId, replayed: true });
    }
    throw new ApplyReject("already_claimed");
  }
  if (!(await storeLinkCurrent(tx, store))) throw new ApplyReject("link_changed");
  const prepared = await prepareApprovalClaim(
    tx,
    a,
    { proposalRef: body.proposalRef, approvalRef: body.approvalRef, capabilityId: capability },
    (p) => claimantMayApply(tx, a, store, fieldsOf(p), environment),
  );
  if ("code" in prepared) throw new ApplyReject(prepared.code);
  const parametersRows = await tx.run("parametersById", [stored.parametersId]);
  const parametersRow = parametersRows[0];
  if (parametersRows.length !== 1 || !parametersRow) throw new WorkContextUnavailable();
  if (parametersRow.digest !== proposal.parametersDigest) throw new WorkContextUnavailable();
  let parameters: unknown;
  try {
    parameters = JSON.parse(text(parametersRow, "canonical"));
  } catch {
    throw new WorkContextUnavailable();
  }
  const items = await applyItems(proposal, parameters);
  const digest = await applyRequestDigest(a.resource.workspaceId, proposalId, body);
  tx.markSubmitted();
  const rows = await tx.run("cmdCatalogApply", [
    commandId,
    digest,
    prepared.approvalId,
    String(prepared.approvalRevision),
    prepared.approvalDigest,
    prepared.proposalId,
    prepared.proposalDigest,
    prepared.countedJson,
    JSON.stringify(items),
  ]);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome === "applied" || row.outcome === "replayed")
    return Object.freeze({
      familyRootId: stored.familyRootId,
      replayed: row.outcome === "replayed",
    });
  tx.rollbackOnly();
  const known: readonly string[] = [
    "invalid",
    "stale_authority",
    "command_conflict",
    "link_changed",
    "installation_inactive",
    "scope_missing",
    "limit_reached",
    "stopped",
    "not_found",
    "state_conflict",
    "DIGEST_MISMATCH",
    "APPROVAL_ALREADY_CLAIMED",
    "APPROVAL_EXPIRED",
    "APPROVAL_NOT_EFFECTIVE",
    "REVIEWER_AUTHORITY_LOST",
    "REVIEW_POLICY_NOT_CURRENT",
    "SOLO_OWNER_STATUS_LOST",
  ];
  if (row.outcome === "ineligible") throw new ApplyReject("stale_authority");
  if (known.includes(row.outcome)) throw new ApplyReject(row.outcome as ApplyRefusal);
  throw new WorkContextUnavailable();
}

export interface OperationRow {
  readonly operationId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly targetIndex: number;
  readonly productId: string;
  readonly proposalId: string;
  readonly approvalId: string;
  readonly approvalRevision: number;
  readonly familyRootId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly uncertaintyReason: string | null;
  readonly verdict: string | null;
  readonly attempt: number;
  readonly sendStartedAt: string | null;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
const integer = (row: Record<string, unknown>, key: string) => {
  const value = text(row, key);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new WorkContextUnavailable();
  return Number(value);
};
const nullable = (row: Record<string, unknown>, key: string) =>
  row[key] === null ? null : text(row, key);
export function decodeOperation(row: Record<string, unknown>): OperationRow {
  return Object.freeze({
    operationId: text(row, "id"),
    revision: integer(row, "revision"),
    taskId: text(row, "task_id"),
    storeId: text(row, "store_id"),
    connectionId: text(row, "connection_id"),
    targetIndex: integer(row, "target_index"),
    productId: text(row, "product_id"),
    proposalId: text(row, "proposal_id"),
    approvalId: text(row, "approval_id"),
    approvalRevision: integer(row, "approval_revision"),
    familyRootId: text(row, "family_root_id"),
    status: text(row, "status"),
    reason: nullable(row, "reason"),
    uncertaintyReason: nullable(row, "uncertainty_reason"),
    verdict: nullable(row, "verdict"),
    attempt: integer(row, "attempt"),
    sendStartedAt: nullable(row, "send_started_at"),
    submittedAt: nullable(row, "submitted_at"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  });
}
export async function familyOperations(
  tx: WorkTx,
  familyRootId: string,
): Promise<readonly OperationRow[]> {
  return (await tx.run("operationsOfFamily", [familyRootId])).map(decodeOperation);
}

export type DispatchOutcome =
  | { readonly kind: "dispatching" }
  | { readonly kind: "settled"; readonly status: string; readonly reason: string | null };

/**
 * One operation's dispatch check, in the claimant's session. The kernel and the claimed
 * approval are decided here, in code, then cmd_catalog_dispatch rechecks the data rules under
 * the row lock; a failed recheck records authorized -> conflict and nothing is sent.
 */
export async function dispatchOperation(
  tx: WorkTx,
  a: WorkAuthority,
  operationId: string,
  environment: "development" | "staging" | "production",
): Promise<DispatchOutcome> {
  const rows = await tx.run("operationById", [operationId]);
  if (rows.length !== 1) throw new ApplyReject("not_found");
  const op = decodeOperation(rows[0]!);
  if (op.status !== "authorized") {
    tx.rollbackOnly();
    return Object.freeze({ kind: "settled", status: op.status, reason: op.reason });
  }
  const stored = await readProposalRow(tx, a, op.proposalId);
  if (!stored) throw new WorkContextUnavailable();
  const selected = stored.proposal.derivedFrom?.selectedTargetIndexes ?? null;
  const at = selected === null ? op.targetIndex : selected.indexOf(op.targetIndex);
  const target = stored.proposal.targets[at];
  if (!target || target.resource.id !== op.productId) throw new WorkContextUnavailable();
  let store: StoreResource;
  try {
    store = storeResource(a.actor.organizationId, a.resource.workspaceId, op.storeId, op.connectionId);
  } catch {
    throw new WorkContextUnavailable();
  }
  let conflict: "authority_lost" | "not_entitled" | "approval_invalid" | null = null;
  const approval = await claimedApprovalCurrent(tx, a, {
    proposalId: op.proposalId,
    approvalId: op.approvalId,
    approvalRevision: op.approvalRevision,
  });
  if (approval !== "ok") conflict = "approval_invalid";
  else {
    const decided = await claimantMayApply(tx, a, store, target.fields, environment);
    if (decided === "denied") conflict = "authority_lost";
    else if (decided === "not_entitled") conflict = "not_entitled";
  }
  tx.markSubmitted();
  const out = await tx.run("cmdCatalogDispatch", [operationId, conflict]);
  const row = out.length === 1 ? out[0] : undefined;
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome === "dispatching") return Object.freeze({ kind: "dispatching" });
  if (row.outcome === "conflict" || row.outcome === "unchanged")
    return Object.freeze({
      kind: "settled",
      status: text(row, "status"),
      reason: row.reason === null ? null : text(row, "reason"),
    });
  tx.rollbackOnly();
  if (row.outcome === "not_found") throw new ApplyReject("not_found");
  if (row.outcome === "not_claimant") throw new ApplyReject("already_claimed");
  if (row.outcome === "stale_authority" || row.outcome === "ineligible")
    throw new ApplyReject("stale_authority");
  throw new WorkContextUnavailable();
}

/** Whether the actor may see an operation: it may read the operation's proposal. */
export async function operationVisible(
  tx: WorkTx,
  a: WorkAuthority,
  op: OperationRow,
): Promise<boolean> {
  const stored = await readProposalRow(tx, a, op.proposalId);
  return !!stored && (await viewerRole(a, stored)) !== null;
}
