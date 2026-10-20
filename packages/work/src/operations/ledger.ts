import transitions from "../../../../docs/contracts/state-transitions.json";

// The OperationLedger's TypeScript half (P06.T01c minimum; mvp-architecture §8; migration
// 0020). The edges are the `operation` rows of docs/contracts/state-transitions.json,
// unchanged; 0020 seeds the same rows into morrow_work.transition_rules, and
// morrow_work.operation_transition applies one edge under the operation's row lock. Pure:
// no I/O, clock or randomness. A consumer's definer calls operation_transition with the
// arguments `operationTransitionArguments` returns, and maps its row with
// `decodeOperationTransition`. Nothing here ever promotes an unknown outcome: `uncertain`
// leaves only through readback (`verifying`), a proven no-effect (`failed`) or an owner's
// cancel request.

export const operationStatuses = Object.freeze([
  "planned",
  "awaiting_approval",
  "authorized",
  "reserved",
  "dispatching",
  "submitted",
  "verifying",
  "verified",
  "rejected",
  "conflict",
  "failed",
  "uncertain",
  "cancel_requested",
  "cancelled",
] as const);
export type OperationStatus = (typeof operationStatuses)[number];
export const uncertaintyReasons = Object.freeze([
  "transport_after_dispatch",
  "provider_job_pending",
  "partial_result",
  "verification_unavailable",
  "unknown_submission",
] as const);
export type UncertaintyReason = (typeof uncertaintyReasons)[number];
export interface OperationEdge {
  readonly from: OperationStatus;
  readonly to: OperationStatus;
  readonly actor: string;
  readonly guard: string;
}
export class OperationLedgerError extends Error {
  constructor(readonly code: "OPERATION_TRANSITION_INVALID" | "OPERATION_RESULT_INVALID") {
    super(code);
    this.name = "OperationLedgerError";
  }
}

const statusSet: readonly string[] = operationStatuses;
const machine = (transitions as { transitions: Record<string, unknown> }).transitions.operation;
function loadEdges(): readonly OperationEdge[] {
  if (!Array.isArray(machine)) throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
  return Object.freeze(
    machine.map((edge: Record<string, unknown>) => {
      if (
        !edge ||
        Object.keys(edge).sort().join(",") !== "actor,from,guard,to" ||
        !statusSet.includes(edge.from as string) ||
        !statusSet.includes(edge.to as string) ||
        typeof edge.actor !== "string" ||
        typeof edge.guard !== "string"
      )
        throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
      return Object.freeze({
        from: edge.from as OperationStatus,
        to: edge.to as OperationStatus,
        actor: edge.actor,
        guard: edge.guard,
      });
    }),
  );
}
/** Every edge of the operation machine, in file order. */
export const operationEdges: readonly OperationEdge[] = loadEdges();
/** Statuses no edge leaves. */
export const terminalOperationStatuses: readonly OperationStatus[] = Object.freeze(
  operationStatuses.filter((s) => !operationEdges.some((e) => e.from === s)),
);

/** The one edge from `from` to `to`, optionally pinned to its guard; null when absent or ambiguous. */
export function operationEdge(
  from: OperationStatus,
  to: OperationStatus,
  guard?: string,
): OperationEdge | null {
  const found = operationEdges.filter(
    (e) => e.from === from && e.to === to && (guard === undefined || e.guard === guard),
  );
  return found.length === 1 ? found[0]! : null;
}

export interface OperationTransitionRequest {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly from: OperationStatus;
  readonly to: OperationStatus;
  /** Pins the edge when two edges join the same statuses; required then. */
  readonly guard?: string;
  readonly reason: string | null;
  readonly uncertaintyReason: UncertaintyReason | null;
  /** The lease a background change ran under; null for a session command. */
  readonly leaseId: string | null;
}
const recordId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reasonPattern = /^[a-z][a-z0-9_]{2,63}$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;

/**
 * The ten bind values of morrow_work.operation_transition(org, ws, operation, expected
 * revision, to, actor, guard, reason, uncertainty reason, lease), in order, for one edge
 * of the machine. It refuses what the SQL helper refuses: an unknown or ambiguous edge,
 * a malformed id or reason, and `uncertain` without exactly one reason.
 */
export function operationTransitionArguments(
  request: OperationTransitionRequest,
): readonly (string | null)[] {
  const r = request;
  const edge =
    r && statusSet.includes(r.from) && statusSet.includes(r.to)
      ? operationEdge(r.from, r.to, r.guard)
      : null;
  if (
    !edge ||
    ![r.organizationId, r.workspaceId, r.operationId].every((v) => exact(recordId, v)) ||
    !Number.isSafeInteger(r.expectedRevision) ||
    r.expectedRevision < 1 ||
    (r.reason !== null && !exact(reasonPattern, r.reason)) ||
    (r.leaseId !== null && !exact(recordId, r.leaseId)) ||
    (r.to === "uncertain") !== (r.uncertaintyReason !== null) ||
    (r.uncertaintyReason !== null &&
      !(uncertaintyReasons as readonly string[]).includes(r.uncertaintyReason))
  )
    throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
  return Object.freeze([
    r.organizationId,
    r.workspaceId,
    r.operationId,
    String(r.expectedRevision),
    edge.to,
    edge.actor,
    edge.guard,
    r.reason,
    r.uncertaintyReason,
    r.leaseId,
  ]);
}

export type OperationTransitionResult =
  | { readonly outcome: "applied"; readonly revision: number }
  | { readonly outcome: "revision_conflict" | "state_conflict"; readonly revision: number }
  | { readonly outcome: "invalid" | "not_found" };
/** Decodes the one row operation_transition returns. */
export function decodeOperationTransition(
  rows: readonly Record<string, unknown>[],
): OperationTransitionResult {
  const invalid = () => new OperationLedgerError("OPERATION_RESULT_INVALID");
  if (!Array.isArray(rows) || rows.length !== 1) throw invalid();
  const row = rows[0]!;
  if (Object.keys(row).sort().join(",") !== "outcome,revision") throw invalid();
  const revision =
    typeof row.revision === "string" && /^[1-9][0-9]{0,15}$/.test(row.revision)
      ? Number(row.revision)
      : row.revision === null
        ? null
        : undefined;
  switch (row.outcome) {
    case "applied":
    case "revision_conflict":
    case "state_conflict":
      if (typeof revision !== "number") throw invalid();
      return Object.freeze({ outcome: row.outcome, revision });
    case "invalid":
    case "not_found":
      if (revision !== null) throw invalid();
      return Object.freeze({ outcome: row.outcome });
    default:
      throw invalid();
  }
}

// ---------------------------------------------------------------------------
// The spine §8 outcome rules, as edges. The broker reports one write outcome per
// operation, after the send fence: a reply proving nothing ran (THROTTLED, 429, 401,
// ACCESS_DENIED) is `not_sent`; userErrors are `rejected`; a timeout or transport loss
// after the send is `uncertain`, never success.
export type ProviderWriteOutcome = "submitted" | "rejected" | "not_sent" | "uncertain";
export interface PlannedEdge {
  readonly to: OperationStatus;
  readonly guard: string;
  readonly reason: string | null;
  readonly uncertaintyReason: UncertaintyReason | null;
}
const planned = (
  from: OperationStatus,
  to: OperationStatus,
  guard: string,
  reason: string | null = null,
  uncertaintyReason: UncertaintyReason | null = null,
): PlannedEdge => {
  if (!operationEdge(from, to, guard))
    throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
  return Object.freeze({ to, guard, reason, uncertaintyReason });
};

/** dispatching -> submitted, failed or uncertain, from the broker's write outcome. */
export function writeOutcomeEdge(outcome: ProviderWriteOutcome, reason?: string): PlannedEdge {
  switch (outcome) {
    case "submitted":
      return planned("dispatching", "submitted", "provider_submission_receipt");
    case "rejected":
      return planned("dispatching", "failed", "verified_no_effect", "provider_rejected");
    case "not_sent":
      if (reason !== undefined && !exact(reasonPattern, reason))
        throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
      return planned("dispatching", "failed", "verified_no_effect", reason ?? "provider_not_sent");
    case "uncertain":
      return planned(
        "dispatching",
        "uncertain",
        "unknown_external_outcome",
        null,
        "transport_after_dispatch",
      );
    default:
      throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
  }
}

/**
 * Readback after `submitted -> verifying`: every approved field equal under the canonical
 * comparison is `verified`; anything else is `uncertain` (partial_result). With no
 * credential left the readback cannot run: `verification_unavailable`. A partial result
 * whose every field still equals the snapshot then moves `uncertain -> failed`
 * (`noEffectEdge`).
 */
export function readbackEdge(verdict: "all_applied" | "partial" | "unavailable"): PlannedEdge {
  switch (verdict) {
    case "all_applied":
      return planned("verifying", "verified", "declared_postconditions_verified");
    // The machine has one verifying -> uncertain edge (guard verification_unavailable);
    // the uncertainty reason records which case it was.
    case "partial":
      return planned("verifying", "uncertain", "verification_unavailable", null, "partial_result");
    case "unavailable":
      return planned(
        "verifying",
        "uncertain",
        "verification_unavailable",
        null,
        "verification_unavailable",
      );
    default:
      throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
  }
}
/** uncertain -> failed, once readback proves no field changed. */
export const noEffectEdge = (): PlannedEdge =>
  planned("uncertain", "failed", "verified_no_effect", "verified_no_effect");
/** authorized -> conflict at the dispatch check (store uninstalled, stop, stale source). */
export const preconditionConflictEdge = (reason: string): PlannedEdge => {
  if (!exact(reasonPattern, reason)) throw new OperationLedgerError("OPERATION_TRANSITION_INVALID");
  return planned("authorized", "conflict", "precondition_changed_before_dispatch", reason);
};
