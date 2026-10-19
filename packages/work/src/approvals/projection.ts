import type { Current_ApprovalStatus } from "@morrow/contracts";
import type { ReviewCode } from "./producers.js";

// The lazy projection of a stored approval (§5), mirroring
// morrow_work.approval_projection exactly (mirror-tested in the PostgreSQL lab).
// It applies only to stored pending or approved rows, in order: a claim, expiry,
// a newer review policy, lost solo-owner status. Each condition is monotone, so a
// projected status never reverts. Commands and claims return the code and roll
// back; reads display the status and never write.

export interface StoredApproval {
  readonly status: Current_ApprovalStatus;
  readonly expiresAt: string;
  /** The ReviewPolicy revision the proposal and approval are bound to. */
  readonly boundPolicyRevision: number;
  /** The confirming solo reviewer and decision time, when the approval is a solo one. */
  readonly soloReviewerPrincipalId: string | null;
  readonly soloDecidedAt: string | null;
  readonly quietPeriodSeconds: number;
}
export interface ProjectionFacts {
  readonly hasClaim: boolean;
  /** The workspace's current ReviewPolicy revision (null: none, which never happens with a stored approval). */
  readonly currentPolicyRevision: number | null;
  readonly ownerPrincipalId: string | null;
  readonly activeHumanMembershipCount: number;
  readonly lastMembershipChangeAt: string | null;
}
export interface Projection {
  readonly status: Current_ApprovalStatus;
  readonly code: ReviewCode | null;
}

const ms = (t: string): number => {
  const value = Date.parse(t);
  if (!Number.isFinite(value)) throw Error("APPROVAL_PROJECTION_INVALID");
  return value;
};

export function projectApproval(row: StoredApproval, f: ProjectionFacts, atMs: number): Projection {
  if (row.status !== "pending" && row.status !== "approved")
    return Object.freeze({ status: row.status, code: null });
  if (f.hasClaim) return Object.freeze({ status: row.status, code: "APPROVAL_ALREADY_CLAIMED" });
  if (!Number.isFinite(atMs) || atMs >= ms(row.expiresAt))
    return Object.freeze({ status: "expired", code: "APPROVAL_EXPIRED" });
  if (f.currentPolicyRevision === null || row.boundPolicyRevision < f.currentPolicyRevision)
    return Object.freeze({ status: "invalidated", code: "REVIEW_POLICY_NOT_CURRENT" });
  if (row.soloReviewerPrincipalId !== null) {
    const last = f.lastMembershipChangeAt === null ? null : ms(f.lastMembershipChangeAt);
    const holds =
      row.soloReviewerPrincipalId === f.ownerPrincipalId &&
      f.activeHumanMembershipCount === 1 &&
      (last === null ||
        (atMs >= last + row.quietPeriodSeconds * 1000 &&
          row.soloDecidedAt !== null &&
          last <= ms(row.soloDecidedAt)));
    if (!holds) return Object.freeze({ status: "invalidated", code: "SOLO_OWNER_STATUS_LOST" });
  }
  return Object.freeze({ status: row.status, code: null });
}
