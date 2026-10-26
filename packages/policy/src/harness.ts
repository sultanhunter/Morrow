// Harness rules in code (ADR-0041; harness contracts, H6): which end reasons and refusal codes
// new code may write, the safety profile's orderings that JSON Schema cannot state, and the id
// rules of segments and wake events. Pure: no I/O, clock or randomness, and no validator table,
// so the runner (H7b), the broker (H7c) and the screens can share it.
import type {
  Current_AgentRunEndReason,
  Current_AgentRunSafety,
  Current_JobState,
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
/** End reasons that are free (OD-2026-10-26-2): an unrecoverable error on either side. */
export const freeRunEndReasons: readonly Current_AgentRunEndReason[] = Object.freeze([
  "invalid_output",
  "refusal",
  "provider_error",
  "prefix_mismatch",
  "internal_error",
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

/** The request card's terminal states (ADR-0040 item 5); checking overrides them while it lasts. */
export const terminalJobStates: readonly Current_JobState[] = Object.freeze([
  "not_started",
  "done",
  "stopped",
  "failed",
]);

/**
 * The orderings a safety profile must keep (ADR-0041 items 7, 8, 17 and 18), beyond its
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
