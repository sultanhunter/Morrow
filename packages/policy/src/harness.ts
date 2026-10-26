// Harness rules in code (ADR-0041; harness contracts, H6): which end reasons and refusal codes
// new code may write, the safety profile's orderings that JSON Schema cannot state, and the id
// rules of segments and wake events. Pure: no I/O, clock or randomness, and no validator table,
// so the runner (H7b), the broker (H7c) and the screens can share it.
import type {
  Current_AgentRunEndReason,
  Current_AgentRunSafety,
  Current_DerivedTaint,
  Current_JobState,
  Current_ModelUntrustedSource,
  Current_OperationStatus,
  Current_RunWaitKind,
  Current_ToolRefusalCode,
} from "@morrow/contracts";

/**
 * End reasons ADR-0041 item 34 retires: kept in the enum for old records, never written. A run
 * no longer ends at a turn, tool-call, time or input limit, on an unanswered question (a lapsed
 * person wait is person_wait_expired) or on the provider's spend limit (it parks).
 */
export const retiredRunEndReasons: readonly Current_AgentRunEndReason[] = Object.freeze([
  "turn_limit",
  "tool_call_limit",
  "wall_time",
  "deadline",
  "question_unanswered",
  "spend_limit",
]);
/** End reasons a run may be closed with (ADR-0041 items 3 and 34). */
export const liveRunEndReasons: readonly Current_AgentRunEndReason[] = Object.freeze([
  "completed",
  "cost_budget",
  "invalid_output",
  "refusal",
  "provider_error",
  "prefix_mismatch",
  "stopped",
  "lease_ended",
  "mandate_ended",
  "task_closed",
  "switch_off",
  "person_wait_expired",
  "checkin_unanswered",
  "envelope_expired",
  "lease_lapsed",
  "internal_error",
  "released",
]);
/**
 * End reasons that draw nothing; H8's settlement refunds the run's holds (OD-2026-10-26-2: "a run
 * that ends because of an error on Morrow's side or the AI provider's is free"). ADR-0039 item
 * 2(g)'s free list, which ADR-0041 keeps (ADR-0039's 2026-10-26 amendment of 2(g); ADR-0041
 * "Does not change"), less the retired spend_limit, wall_time and deadline: provider_error,
 * invalid_output, refusal, prefix_mismatch, lease_ended and switch_off. Then internal_error,
 * which ADR-0041 item 3(d) names free, and three readings of the same rule that the owner
 * confirms before H8 settles with them (docs/briefs/h6-harness-contracts.md): lease_lapsed (the
 * runner failed to renew, so Morrow ended the run, as with lease_ended), envelope_expired
 * (Morrow's absolute bound, the successor of 2(g)'s free wall_time and deadline) and cost_budget
 * (a booking above any possible worst case is Morrow's or the provider's error).
 */
export const freeRunEndReasons: readonly Current_AgentRunEndReason[] = Object.freeze([
  "provider_error",
  "invalid_output",
  "refusal",
  "prefix_mismatch",
  "lease_ended",
  "switch_off",
  "internal_error",
  "lease_lapsed",
  "envelope_expired",
  "cost_budget",
]);
/**
 * End reasons that draw what the run's turns metered (OD-2026-10-26-2: "a run that still gives
 * an answer, or that a person stops, draws what it used"). ADR-0039 item 2(g)'s charged list less
 * its retired limit endings: completed, stopped, task_closed and mandate_ended. Then the
 * successors of its charged question_unanswered (a person did not answer: person_wait_expired,
 * ADR-0039's amendment of item 5, and checkin_unanswered) and released (an idle teammate
 * context, its result delivered, closes when its job ends). With freeRunEndReasons it covers
 * every live reason exactly once (tests/harness-contracts.test.mjs).
 */
export const meteredRunEndReasons: readonly Current_AgentRunEndReason[] = Object.freeze([
  "completed",
  "stopped",
  "task_closed",
  "mandate_ended",
  "person_wait_expired",
  "checkin_unanswered",
  "released",
]);
/**
 * A durable wait lapsed (ADR-0041 item 3(e)): the run closes and keeps its context, so a
 * person's Continue can pick the work up; an idle teammate context likewise closes released
 * when its job ends. No ending seeds a successor by itself (item 20).
 */
export const lapsedWaitEndReasons: readonly Current_AgentRunEndReason[] = Object.freeze([
  "person_wait_expired",
  "checkin_unanswered",
  "released",
]);
/** Whether new code may close a run with this reason. */
export function writableEndReason(reason: unknown): reason is Current_AgentRunEndReason {
  return typeof reason === "string" && (liveRunEndReasons as readonly string[]).includes(reason);
}

/** Tool refusal codes ADR-0041 retires: the 40-call rule and the specialist deadline. */
export const retiredToolRefusals: readonly Current_ToolRefusalCode[] = Object.freeze([
  "tool_call_limit",
  "deadline_passed",
]);

/** Waits that ask a person: Continue, an answer, or Add credits (ADR-0041 items 9, 17 and 18). */
export const personWaitKinds: readonly Current_RunWaitKind[] = Object.freeze([
  "question",
  "checkin",
  "detector",
  "credits",
]);

/**
 * Operation statuses whose outcome is not yet reconciled: the ledger shows them "UNKNOWN: being
 * checked; do not assume it happened; do not repeat it" (ContextLedger@1, ADR-0041 item 13), they
 * keep approval and gateway waits open (item 17), and they hold the request card in checking
 * (JobStatus@1, ADR-0040 item 5). cancel_requested is one: the gateway enters it from submitted
 * or uncertain while reconciliation continues, and it can still end verifying, the change
 * applied (migration 0020's operation machine). The ledger's schema binding is checked against
 * this set, so the renderer (H7d) and the card's projection (H14) read one list.
 */
export const unknownOperationStatuses: readonly Current_OperationStatus[] = Object.freeze([
  "dispatching",
  "submitted",
  "verifying",
  "uncertain",
  "cancel_requested",
]);

/** Every taint kind (ModelUntrustedSource), in its schema order; a test pins it to the schema. */
export const taintKindOrder: readonly Current_ModelUntrustedSource[] = Object.freeze([
  "product",
  "inventory",
  "order_summary",
  "support_mail",
  "knowledge_page",
  "artifact",
  "report",
  "upload",
  "sandbox_output",
  "tool_result",
  "message",
  "teammate_result",
  "result_item",
  "notebook_entry",
  "conversation_summary",
  "person_memory",
  "context_checkpoint",
  "thread_post",
  "other_member",
]);
const maxTaintSources = 2_147_483_647;
/**
 * Joins taints without loss (ADR-0041 item 34: taint never truncates): the union of every kind,
 * in taintKindOrder, and the sum of source counts, which may count one source twice but never
 * fewer than there are (saturating at the column's range). A run that reads a derived row joins
 * the row's taint into its own; a derived row takes its writer's.
 */
export function joinTaint(...taints: readonly Current_DerivedTaint[]): Current_DerivedTaint {
  const kinds = new Set<Current_ModelUntrustedSource>();
  let sourceCount = 0;
  for (const taint of taints) {
    for (const kind of taint.kinds) kinds.add(kind);
    sourceCount = Math.min(sourceCount + taint.sourceCount, maxTaintSources);
  }
  return Object.freeze({
    kinds: Object.freeze(taintKindOrder.filter((kind) => kinds.has(kind))),
    sourceCount,
  }) as Current_DerivedTaint;
}

/** The request card's terminal states (ADR-0040 item 5); checking overrides them while it lasts. */
export const terminalJobStates: readonly Current_JobState[] = Object.freeze([
  "not_started",
  "done",
  "stopped",
  "failed",
]);

/** A step that makes no model call times out after 10 minutes (ADR-0041 item 6). */
export const otherStepTimeoutMs = 600_000;
/** A turn step's timeout: its call budget plus 2 minutes, at most 30 minutes (ADR-0041 item 6). */
export function turnStepTimeoutMs(safety: Current_AgentRunSafety): number {
  return Math.min(safety.turn.callBudgetMs + 120_000, 1_800_000);
}
/**
 * Whether a step renews the run's lease at its entry (ADR-0041 item 7), so that the lease kept
 * covers the whole step. A turn step always renews: its timeout (30 minutes at the seeds' 28-
 * minute call budget) is longer than renewBelowMs (20 minutes), so renewing only "if less than
 * 20 minutes remain" would let a turn start with 20 minutes left and the lease lapse mid-call;
 * the sweep would then close healthy work lease_lapsed after the call was paid. Any other step
 * renews when less than renewBelowMs remains. Each renewal re-runs admission's checks inside
 * the envelope, so renewing more often only checks authority more often.
 */
export function leaseRenewalDue(
  safety: Current_AgentRunSafety,
  step: "turn" | "other",
  remainingMs: number,
): boolean {
  return step === "turn" || !(remainingMs >= safety.lease.renewBelowMs);
}

/**
 * The orderings a safety profile must keep (ADR-0041 items 6, 7, 8, 17 and 18), beyond its
 * schema's ranges. Returns problems; an empty list passes.
 */
export function checkRunSafety(safety: Current_AgentRunSafety): readonly string[] {
  const problems: string[] = [];
  const d = safety.detectors;
  const ascending = (values: readonly number[]) =>
    values.every((value, i) => i === 0 || value > values[i - 1]!);
  if (d.repetition.nudgeAt >= d.repetition.tripAt) problems.push("repetition: nudge before trip");
  if (d.errorStreak.nudgeAt >= d.errorStreak.tripAt)
    problems.push("errorStreak: nudge before trip");
  if (d.alternation.nudgeAfterSteps >= d.alternation.tripAfterSteps)
    problems.push("alternation: nudge before trip");
  if (d.signatureRing < d.alternation.tripAfterSteps || d.signatureRing < d.repetition.tripAt)
    problems.push("detectors: the signature ring holds a trip's window");
  if (safety.lease.renewBelowMs >= safety.lease.ms) problems.push("lease: renew before it lapses");
  // The turn step's timeout is the call budget plus 2 minutes, at most 30 minutes (item 6).
  if (safety.turn.callBudgetMs + 120_000 > 1_800_000)
    problems.push("turn: the call budget plus 2 minutes fits 30 minutes");
  // The lease kept after leaseRenewalDue's check at a step's entry covers that step.
  if (safety.lease.ms < turnStepTimeoutMs(safety))
    problems.push("lease: a renewal at a turn step's entry covers the turn step");
  if (safety.lease.renewBelowMs < otherStepTimeoutMs)
    problems.push("lease: the lease kept at any other step's entry covers its 10 minutes");
  if (safety.envelope.activeMs > safety.envelope.wallMs)
    problems.push("envelope: active time fits the wall clock");
  if (safety.checkIns.activeMs > safety.envelope.activeMs)
    problems.push("checkIns: the active-time check-in comes no later than the envelope");
  if (safety.checkIns.sinceRequesterActMs > safety.envelope.wallMs)
    problems.push("checkIns: the requester's-act check-in comes no later than the envelope");
  if (safety.checkIns.children > 32) problems.push("checkIns: the kernel allows 32 children");
  const reminders = safety.personWait.remindersMs;
  if (!ascending(reminders) || reminders.some((ms) => ms >= safety.personWait.ms))
    problems.push("personWait: reminders ascend inside the wait");
  const backoff = safety.providerBackoff;
  if (!ascending(backoff.scheduleMs)) problems.push("providerBackoff: the schedule ascends");
  if (backoff.thenEveryMs < backoff.scheduleMs[backoff.scheduleMs.length - 1]!)
    problems.push("providerBackoff: the steady interval is the longest");
  if (backoff.checkInAfterMs <= backoff.scheduleMs[0]!)
    problems.push("providerBackoff: the check-in comes after the first back-off");
  if (safety.segments.rollBeforeWaitMs > safety.lease.ms)
    problems.push("segments: a run rolls before any wait longer than its lease");
  return Object.freeze(problems);
}

// Cloudflare Workflows instance ids: at most 100 characters, letters, digits, "-" and "_".
const instanceIdPattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
const positive = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

/**
 * A segment's Workflow instance id, <runId>-s<segment>-i<incarnation> (ADR-0041 item 6): from
 * server ids, never reused. Throws when the run id cannot make a valid instance id.
 */
export function segmentInstanceId(runId: string, segment: number, incarnation: number): string {
  if (typeof runId !== "string" || !positive(segment, 1_000_000) || !positive(incarnation, 1000))
    throw new RangeError("SEGMENT_INSTANCE_INVALID");
  const id = `${runId}-s${segment}-i${incarnation}`;
  if (!instanceIdPattern.test(id)) throw new RangeError("SEGMENT_INSTANCE_INVALID");
  return id;
}

/** A wait's wake event type, w-<waitSequence>, read from SQL (ADR-0041 item 6). */
export function waitEventType(waitSequence: number): string {
  if (!positive(waitSequence, 1_000_000)) throw new RangeError("WAIT_SEQUENCE_INVALID");
  return `w-${waitSequence}`;
}
