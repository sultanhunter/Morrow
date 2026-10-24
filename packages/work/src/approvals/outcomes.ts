import { WorkContextUnavailable } from "../context.js";
import type { WorkTx } from "../connection.js";
import type { ReviewCode } from "./producers.js";

// Outcomes of the approval commands and their fixed ErrorEnvelope mapping (§7),
// used by the PR-2 routes. Review codes follow P01.T02a §7 item 13; the
// interim quorum refusal and SOLO_OWNER_STATUS_LOST are `never`.

export type ApprovalRefusal =
  | ReviewCode
  | "unauthenticated"
  | "not_found"
  | "invalid"
  | "denied"
  | "producer_missing"
  | "quorum_unreachable"
  | "revision_conflict"
  | "state_conflict"
  | "stale_authority"
  | "command_conflict"
  | "limit_reached"
  // v1 PR 3: a store-bound proposal whose store is no longer linked through the connection
  // its targets name (relinked or disconnected) is never decided or claimed.
  | "link_changed";

export interface ApprovalErrorMapping {
  readonly status: 400 | 401 | 403 | 404 | 409;
  readonly code: "missing_input" | "denied" | "conflict" | "approval_expired";
  readonly retryClass: "never" | "recheck_before_retry";
}
const m = (
  status: ApprovalErrorMapping["status"],
  code: ApprovalErrorMapping["code"],
  retryClass: ApprovalErrorMapping["retryClass"],
): ApprovalErrorMapping => Object.freeze({ status, code, retryClass });
const recheck = m(409, "conflict", "recheck_before_retry");
const final = m(409, "conflict", "never");
const forbidden = m(403, "denied", "never");
const malformed = m(400, "missing_input", "never");
const absent = m(404, "denied", "never");
export const approvalErrors: Readonly<Record<ApprovalRefusal, ApprovalErrorMapping>> =
  Object.freeze({
    unauthenticated: m(401, "denied", "never"),
    not_found: absent,
    producer_missing: absent,
    invalid: malformed,
    SELECTION_INVALID: malformed,
    PARTIAL_APPROVAL_NOT_ALLOWED: malformed,
    denied: forbidden,
    REVIEWER_DENIED: forbidden,
    SELF_APPROVAL_DENIED: forbidden,
    CONFIRMATION_MISMATCH: forbidden,
    CANCEL_NOT_ALLOWED: forbidden,
    // checkProposal codes never reach a route (submit maps them to invalid).
    RISK_CLASS_MISMATCH: malformed,
    IRREVERSIBLE_MISMATCH: malformed,
    REQUESTED_BY_MISMATCH: malformed,
    BENEFICIARIES_MISMATCH: malformed,
    CONTEXT_TAINT_MISMATCH: malformed,
    PROPOSED_BY_MISMATCH: malformed,
    TASK_MISMATCH: malformed,
    TASK_REQUIRED: malformed,
    TENANT_MISMATCH: malformed,
    TARGET_SCOPE_MISMATCH: malformed,
    PARAMETERS_DIGEST_MISMATCH: malformed,
    PROPOSAL_DIGEST_MISMATCH: malformed,
    CREDITS_SUM_MISMATCH: malformed,
    COST_SUM_MISMATCH: malformed,
    DIGEST_MISMATCH: recheck,
    STALE_REVISION: recheck,
    revision_conflict: recheck,
    FAMILY_CONFLICT: recheck,
    REVIEW_POLICY_NOT_CURRENT: recheck,
    COMMAND_CONFLICT: recheck,
    command_conflict: recheck,
    DUPLICATE_REVIEWER: recheck,
    REVIEWER_AUTHORITY_LOST: recheck,
    APPROVAL_NOT_PENDING: recheck,
    APPROVAL_NOT_EFFECTIVE: recheck,
    NOT_APPROVED: recheck,
    state_conflict: recheck,
    stale_authority: recheck,
    SOLO_OWNER_STATUS_LOST: final,
    QUORUM_UNREACHABLE: final,
    quorum_unreachable: final,
    limit_reached: final,
    link_changed: final,
    APPROVAL_ALREADY_CLAIMED: final,
    APPROVAL_EXPIRED: m(409, "approval_expired", "never"),
  });

/** SQL outcomes of the approval command functions that are not `applied`. */
const sqlRefusals: ReadonlySet<string> = new Set([
  "invalid",
  "not_found",
  "revision_conflict",
  "state_conflict",
  "stale_authority",
  "command_conflict",
  "limit_reached",
  "DIGEST_MISMATCH",
  "FAMILY_CONFLICT",
  "APPROVAL_NOT_PENDING",
  "SELF_APPROVAL_DENIED",
  "CONFIRMATION_MISMATCH",
  "CANCEL_NOT_ALLOWED",
  "DUPLICATE_REVIEWER",
  "REVIEWER_DENIED",
  "REVIEWER_AUTHORITY_LOST",
  "SELECTION_INVALID",
  "PARTIAL_APPROVAL_NOT_ALLOWED",
  "APPROVAL_EXPIRED",
  "REVIEW_POLICY_NOT_CURRENT",
  "SOLO_OWNER_STATUS_LOST",
  "APPROVAL_ALREADY_CLAIMED",
  "APPROVAL_NOT_EFFECTIVE",
]);
export function sqlRefusal(outcome: string): ApprovalRefusal {
  if (outcome === "ineligible") return "unauthenticated";
  if (outcome === "not_proposer") return "denied";
  if (sqlRefusals.has(outcome)) return outcome as ApprovalRefusal;
  throw new WorkContextUnavailable();
}

export type Begun =
  | { readonly kind: "new" }
  | { readonly kind: "conflict" | "ineligible" | "invalid" }
  | {
      readonly kind: "replay";
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly result: Readonly<Record<string, unknown>>;
    };

/** The replay check (P06.T01a §4.7 step 3) for an approval command type. */
export async function beginApprovalCommand(
  tx: WorkTx,
  type: "proposal.submit" | "approval.decide" | "approval.withdraw",
  commandId: string,
  requestDigest: string,
): Promise<Begun> {
  const rows = await tx.run("beginApprovalCommand", [type, commandId, requestDigest]);
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.outcome !== "string")
    throw new WorkContextUnavailable();
  if (row.outcome === "new") return { kind: "new" };
  if (row.outcome === "conflict" || row.outcome === "ineligible" || row.outcome === "invalid")
    return { kind: row.outcome };
  if (row.outcome !== "replay" || typeof row.result !== "string")
    throw new WorkContextUnavailable();
  return {
    kind: "replay",
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    result: decodeResult(row.result),
  };
}

export function decodeResult(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") throw new WorkContextUnavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WorkContextUnavailable();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new WorkContextUnavailable();
  return parsed as Readonly<Record<string, unknown>>;
}

/** The single row of a command function, or a server fault. */
export function commandRow(rows: readonly Record<string, unknown>[]): {
  outcome: string;
  result: unknown;
} {
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.outcome !== "string")
    throw new WorkContextUnavailable();
  return { outcome: row.outcome, result: row.result };
}
