import { createHash } from "node:crypto";
import type { Core_ProposalRef, Current_ApprovalStatus, Current_Proposal } from "@morrow/contracts";
import { canonicalDigest } from "@morrow/policy/review";
import { canonicalJson } from "../digest.js";

// The digests P06.T01b defines and SQL recomputes (§3). Each is SHA-256 of the
// RFC 8785 canonical JSON of a closed value: the review library's
// canonicalDigest, so TS and SQL agree byte for byte (AC22 vectors).

/** RFC 8785 text of a closed JSON value (keys by UTF-16 code unit, no whitespace). */
export const canonicalText = (value: unknown): string => canonicalJson(value);
/** sha256 hex of a UTF-8 text, as morrow_work.sha256_text. */
export const sha256Text = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Approval@2 scopeDigest: sha256(JCS(proposal.scope)), over Proposal@2's own scope. */
export function scopeDigest(scope: Current_Proposal["scope"]): string {
  return canonicalDigest(scope);
}

/** The fields an ApprovalRef digest binds: the stored approval at one revision. */
export interface ApprovalRefFields {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly id: string;
  readonly revision: number;
  readonly proposalDigest: string;
  readonly scopeDigest: string;
  readonly status: Current_ApprovalStatus;
  readonly effectiveAt: string | null;
  readonly expiresAt: string;
}
/**
 * ApprovalRef.digest (§3): sha256 of the fixed-key JCS object of the stored
 * approval at revision R, as morrow_work.approval_ref_digest. A claim compares it,
 * so any status, expiry or revision change voids an older reference.
 */
export function approvalRefDigest(f: ApprovalRefFields): string {
  return canonicalDigest({
    effectiveAt: f.effectiveAt,
    expiresAt: f.expiresAt,
    id: f.id,
    kind: "approval",
    organizationId: f.organizationId,
    proposalDigest: f.proposalDigest,
    revision: f.revision,
    scopeDigest: f.scopeDigest,
    status: f.status,
    workspaceId: f.workspaceId,
  });
}

/** The deterministic id of a partial approval's derived proposal (P01.T02a §7 item 8). */
export function derivedProposalId(parentRef: Core_ProposalRef, indexes: readonly number[]): string {
  return "derived_" + canonicalDigest({ parentRef, selectedTargetIndexes: [...indexes] });
}

/** A database instant (epoch ms) as utc_text renders it; ms precision, Z. */
export const utcText = (ms: number): string => new Date(ms).toISOString();
