import type { CapabilityId, Core_ApprovalRef, Core_ProposalRef } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { WorkTx } from "../connection.js";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalText } from "./digests.js";
import { projectionFacts, readContext, readFamily, readProposalRow } from "./family.js";
import { eligibleReviewer, memberAuthority, permits, snapshotGrants } from "./kernel.js";
import { storedApprovalRef, storedProjection } from "./mapping.js";
import type { ReviewCode } from "./producers.js";
import { projectApproval } from "./projection.js";
import { viewerRole } from "./reads.js";

// The consumer half of the one-use claim (§5 Claim). A consumer (P05.T01z,
// P05.T02a, later the P11.T02 gateway) names the capability it executes and calls
// this in its own READ WRITE transaction, then its own api-executable definer runs
// command_prelude_exclusive and morrow_work.approval_claim with these exact values
// (capability included), then its identity effect, all in one commit. An approval
// confers no authority: the claimant needs its own current execute grant, and
// every counted reviewer must still be eligible (kernel here, digest and expiry
// window again in SQL under lock). This prepares a first claim only: a claimed
// family is APPROVAL_ALREADY_CLAIMED here, before any projection, as in SQL. A
// consumer reads back an unknown commit (P06.T01a) by resending its definer call
// with the same prepared values and consumer command ID, without a new prepare:
// approval_claim then returns `replayed` and the stored documents to that same
// claimant, consumer and command ID, and writes nothing.

export interface CountedReviewers {
  readonly evaluatedAt: string;
  readonly reviewers: readonly {
    readonly principalId: string;
    readonly membershipId: string;
    readonly grantsDigest: string;
  }[];
}
export interface PreparedClaim {
  readonly approvalId: string;
  readonly approvalRevision: number;
  readonly approvalDigest: string;
  readonly proposalId: string;
  readonly proposalDigest: string;
  /** The capability the consumer executes; approval_claim binds it to the proposal. */
  readonly capabilityId: string;
  readonly counted: CountedReviewers;
  /** The counted set as the JSON text approval_claim takes. */
  readonly countedJson: string;
}
export type ClaimRefusal =
  | ReviewCode
  | "not_found"
  | "denied"
  | "stale_authority"
  | "state_conflict";

export async function prepareApprovalClaim(
  tx: WorkTx,
  a: WorkAuthority,
  ref: {
    readonly proposalRef: Core_ProposalRef;
    readonly approvalRef: Core_ApprovalRef;
    /** The capability this consumer executes (a constant of the consumer, never request input). */
    readonly capabilityId: CapabilityId;
  },
): Promise<PreparedClaim | { readonly code: ClaimRefusal }> {
  const tenant = { organizationId: a.actor.organizationId, workspaceId: a.actor.workspaceId! };
  if (
    !validateCurrentDefinition("ProposalRef", ref.proposalRef) ||
    !validateCurrentDefinition("ApprovalRef", ref.approvalRef) ||
    ref.proposalRef.organizationId !== tenant.organizationId ||
    ref.proposalRef.workspaceId !== tenant.workspaceId ||
    ref.approvalRef.organizationId !== tenant.organizationId ||
    ref.approvalRef.workspaceId !== tenant.workspaceId
  )
    return { code: "not_found" };
  const stored = await readProposalRow(tx, a, ref.proposalRef.id);
  if (!stored || (await viewerRole(a, stored)) === null) return { code: "not_found" };
  const family = await readFamily(tx, a, stored.familyRootId);
  if (!family) throw new WorkContextUnavailable();
  const approval = family.approvals.get(stored.proposal.id);
  if (!approval || approval.id !== ref.approvalRef.id) return { code: "not_found" };
  const current = storedApprovalRef(approval);
  if (
    canonicalText(current) !== canonicalText(ref.approvalRef) ||
    ref.proposalRef.digest !== stored.proposal.proposalDigest ||
    ref.proposalRef.revision !== 1 ||
    ref.proposalRef.storeId !== null ||
    ref.capabilityId !== stored.proposal.capabilityId
  )
    return { code: "DIGEST_MISMATCH" };
  const ctx = await readContext(tx, a, stored.proposal.capabilityId, stored.familyRootId);
  const atMs = Date.parse(ctx.databaseNow);
  // A claimed family is consumed: the SQL order, before any projection or status.
  const facts = projectionFacts(ctx, stored.familyRootId, family);
  if (facts.hasClaim) return { code: "APPROVAL_ALREADY_CLAIMED" };
  const projected = projectApproval(storedProjection(approval, family.decisions), facts, atMs);
  if (projected.code !== null) return { code: projected.code };
  if (approval.status !== "approved" || approval.effectiveAt === null)
    return { code: "state_conflict" };
  if (atMs < Date.parse(approval.effectiveAt)) return { code: "APPROVAL_NOT_EFFECTIVE" };
  // The claimant's own current execute grant on the capability over every target.
  if (!(await permits(a, "approval.claim", stored.proposal))) return { code: "denied" };
  // Every counted reviewer is still a member and still eligible for this proposal.
  const countedIds = approval.countedReviewerPrincipalIds ?? [];
  if (!countedIds.length) throw new WorkContextUnavailable();
  const rows = await tx.run("reviewerSnapshot", [
    stored.proposal.capabilityId,
    JSON.stringify(countedIds),
  ]);
  const derived = stored.derivedFromId !== null;
  const root = family.root.proposal;
  const selected = derived ? stored.proposal.derivedFrom!.selectedTargetIndexes : null;
  const reviewers: CountedReviewers["reviewers"][number][] = [];
  let evaluatedAt = ctx.databaseNow;
  for (const id of countedIds) {
    const row = rows.find((r) => r.principal_id === id);
    if (!row) return { code: "REVIEWER_AUTHORITY_LOST" };
    if (
      typeof row.membership_id !== "string" ||
      typeof row.grants_digest !== "string" ||
      typeof row.evaluated_at !== "string"
    )
      throw new WorkContextUnavailable();
    evaluatedAt = row.evaluated_at;
    const grants = snapshotGrants(row.grants, row.grant_count);
    if (grants === "overflow") return { code: "REVIEWER_AUTHORITY_LOST" };
    const member = memberAuthority(a, id, row.membership_id, grants);
    if (!(await eligibleReviewer(member, root, selected, Date.parse(row.evaluated_at))))
      return { code: "REVIEWER_AUTHORITY_LOST" };
    reviewers.push({
      principalId: id,
      membershipId: row.membership_id,
      grantsDigest: row.grants_digest,
    });
  }
  const counted: CountedReviewers = Object.freeze({
    evaluatedAt,
    reviewers: Object.freeze(reviewers),
  });
  return Object.freeze({
    approvalId: approval.id,
    approvalRevision: approval.revision,
    approvalDigest: current.digest,
    proposalId: stored.proposal.id,
    proposalDigest: stored.proposal.proposalDigest,
    capabilityId: stored.proposal.capabilityId,
    counted,
    countedJson: canonicalText(counted),
  });
}
