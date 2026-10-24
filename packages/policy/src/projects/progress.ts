import type {
  Current_AreaTemplateId,
  Current_CriteriaList,
  Current_GoalAssistant,
  Current_GoalHealth,
  Current_GoalHealthReason,
  Current_GoalMeasure,
  Current_GoalMeasureProgress,
  Current_GoalProgress,
  Current_GoalStatus,
  Current_GoalValueClass,
  Current_ReadTag,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { areaTemplate } from "./area-templates";
import {
  measureDirection,
  measureSource,
  measureValueClass,
  onTargetSide,
  readTagsFor,
  type GoalDirection,
} from "./measures";

// GoalProgress@1 (ADR-0033 item 4): values and health come from code, per viewer, from the
// values that viewer may see. Nothing here reads a model, a request body or a stored
// measured number: the goal record holds targets and dates only, and every value is an
// append-only row with server-derived read tags, class and clock.
//
// The rules, in order, for one measured goal:
//   * Visibility. A goal whose read tags the viewer may not view is left out: not shown,
//     not counted, never a hidden count. A customer-class goal is left out of every
//     project_update and the Coordinator's context whatever the viewer holds.
//   * Values. Only unexpired values whose every tag the viewer may view; for a hand check
//     only counted ones in the measure's current assistant, on one of its current product
//     rows (a check in another assistant, or on a row a revise removed, never counts). The
//     start is the oldest kept value.
//   * A hand-checked goal is judged only on check dates: "Not checked yet", then
//     "Starting point", then words; a check past its cadence is Needs you ("Check overdue
//     since [day]"), never On track.
//   * An undated area goal is On track on the target's side of its template's threshold,
//     otherwise Behind, and never Done.
//   * A dated goal is Done when its latest value meets the target; past its date without
//     that it is Needs you (ended); otherwise On track on the target's side of the straight
//     line from its oldest kept value to its target, and on the other side Behind, but only
//     after 25% of its time (before that, On track as too early to judge).
// A project shows Done only after Finish; Needs you to a viewer someone waits on and once a
// dated project has ended; otherwise its worst shown goal (a Done goal counts as On track).

export interface GoalRecordFacts {
  readonly id: string;
  readonly revision: number;
  readonly status: Current_GoalStatus;
  readonly createdAtMs: number;
  readonly dueAtMs: number | null;
  readonly areaTemplateId: Current_AreaTemplateId | null;
  readonly successCriteria: Current_CriteriaList;
}
export interface GoalValueFacts {
  readonly key: string;
  readonly productId: string | null;
  readonly value: number;
  readonly observedAtMs: number;
  readonly counted: boolean;
  /** A hand check's assistant (the value's own row); null for a value code wrote. */
  readonly assistant: Current_GoalAssistant | null;
  readonly readTags: readonly Current_ReadTag[];
  readonly dataClass: Current_GoalValueClass;
  readonly expiresAtMs: number | null;
}
/** The viewer's read-tag decisions, from the policy kernel under live grants. */
export interface ProgressViewer {
  mayView(tag: Current_ReadTag): boolean;
}
export type ProgressAudience = "viewer" | "project_update" | "coordinator";
export interface ProgressContext {
  readonly nowMs: number;
  /** The stores the workspace's measures read (the connected store at launch). */
  readonly storeIds: readonly string[];
  /** Finish's results record, once the project was finished. */
  readonly finished: { readonly outcome: "achieved" | "cancelled"; readonly atMs: number } | null;
  /** Someone waits on this viewer in this project (a question, an approval, a step). */
  readonly waitingOnViewer: boolean;
  readonly audience: ProgressAudience;
}

const weekMs = 7 * 86_400_000;
const dayMs = 86_400_000;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const rank: Readonly<Record<Current_GoalHealth, number>> = Object.freeze({
  not_measured: 0,
  done: 1,
  on_track: 2,
  behind: 3,
  needs_you: 4,
});

interface Judgement {
  readonly health: Current_GoalHealth;
  readonly reason: Current_GoalHealthReason;
  readonly sinceMs: number | null;
  readonly value: { readonly value: number; readonly observedAtMs: number } | null;
}
const judgement = (
  health: Current_GoalHealth,
  reason: Current_GoalHealthReason,
  sinceMs: number | null,
  value: Judgement["value"],
): Judgement => ({ health, reason, sinceMs, value });

/** True when the goal is shown to this audience: every tag of its measure viewable. */
export function goalVisible(
  measure: Current_GoalMeasure,
  viewer: ProgressViewer,
  ctx: Pick<ProgressContext, "storeIds" | "audience">,
): boolean {
  const customer = measureValueClass(measure) === "customer";
  if (customer && ctx.audience !== "viewer") return false;
  const tags = readTagsFor(measure, ctx.storeIds);
  if (tags.length === 0) return !customer;
  return tags.every((tag) => viewer.mayView(tag));
}

/**
 * A goal record's criteria as one viewer may read them (ADR-0033 Consequences: a
 * customer-class goal, such as Customer emails' "Replied within a day", is seen only by
 * members who may read customer data). A customer-class criterion is left out unless the
 * viewer may view every one of its read tags on the workspace's stores (goalVisible's rule);
 * every other criterion is kept. Null when nothing is left: the record is not shown to this
 * viewer at all, never as an empty or hidden count.
 */
export function criteriaForViewer(
  criteria: Current_CriteriaList,
  viewer: ProgressViewer,
  storeIds: readonly string[],
): Current_CriteriaList | null {
  const kept = criteria.filter(
    (c) =>
      c.measure === undefined ||
      c.measure === null ||
      measureValueClass(c.measure) !== "customer" ||
      goalVisible(c.measure, viewer, { storeIds, audience: "viewer" }),
  );
  return kept.length === 0 ? null : (kept as Current_CriteriaList);
}
/** True when a record holds a customer-class criterion (its reads need the viewer's tags). */
export const holdsCustomerGoal = (criteria: Current_CriteriaList): boolean =>
  criteria.some(
    (c) =>
      c.measure !== undefined && c.measure !== null && measureValueClass(c.measure) === "customer",
  );

/** The values one viewer may see of one goal, oldest first. */
export function visibleValues(
  key: string,
  measure: Current_GoalMeasure,
  values: readonly GoalValueFacts[],
  viewer: ProgressViewer,
  nowMs: number,
): readonly GoalValueFacts[] {
  return values
    .filter(
      (v) =>
        v.key === key &&
        (v.expiresAtMs === null || v.expiresAtMs > nowMs) &&
        v.readTags.every((tag) => viewer.mayView(tag)) &&
        // A hand check counts only in the measure's current assistant and on one of its
        // current product rows (ADR-0033 item 3), whatever the row's stored flag says.
        (measure.kind !== "manual" ||
          (v.counted &&
            v.assistant === measure.assistant &&
            measure.rows.some((r) => r.productId === v.productId))) &&
        // Metric and checklist goals are judged on their goal-level rows.
        (measure.kind === "manual" ? v.productId !== null : v.productId === null),
    )
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
}

/**
 * A hand check's value per check day: the sum, over its product rows, of each row's
 * latest counted value up to that day. Days ascending.
 */
function handCheckSeries(values: readonly GoalValueFacts[]) {
  const days = [...new Set(values.map((v) => v.observedAtMs - (v.observedAtMs % dayMs)))].sort(
    (a, b) => a - b,
  );
  return days.map((day) => {
    const latest = new Map<string, GoalValueFacts>();
    for (const v of values) if (v.observedAtMs < day + dayMs) latest.set(v.productId ?? "", v);
    let sum = 0;
    let at = day;
    for (const v of latest.values()) {
      sum += v.value;
      at = Math.max(at, v.observedAtMs);
    }
    return { value: sum, observedAtMs: at };
  });
}

function judge(
  record: GoalRecordFacts,
  key: string,
  measure: Current_GoalMeasure,
  values: readonly GoalValueFacts[],
  nowMs: number,
): Judgement {
  const direction: GoalDirection = measureDirection(measure);
  const series =
    measure.kind === "manual"
      ? handCheckSeries(values)
      : values.map((v) => ({ value: v.value, observedAtMs: v.observedAtMs }));
  const latest = series.at(-1) ?? null;
  if (measure.kind === "manual") {
    const last = latest?.observedAtMs ?? record.createdAtMs;
    const nextDue = last + measure.cadenceWeeks * weekMs;
    if (nowMs > nextDue) return judgement("needs_you", "check_overdue", nextDue, latest);
    if (series.length === 0) return judgement("not_measured", "not_checked_yet", null, null);
    if (series.length === 1)
      return judgement("not_measured", "starting_point", latest!.observedAtMs, latest);
  } else if (!latest) return judgement("not_measured", "no_value", null, null);
  const current = latest!;
  // An undated area goal: the template's threshold for its own goal, else its target.
  if (record.areaTemplateId !== null) {
    const t = areaTemplate(record.areaTemplateId);
    const threshold = t && t.goal.key === key ? t.goal.onTrackThreshold : measure.target;
    return onTargetSide(direction, current.value, threshold)
      ? judgement("on_track", "on_target_side", null, current)
      : judgement("behind", "off_target_side", current.observedAtMs, current);
  }
  if (onTargetSide(direction, current.value, measure.target))
    return judgement("done", "target_met", current.observedAtMs, current);
  const dueMs = measure.dueAt !== null ? Date.parse(measure.dueAt) : record.dueAtMs;
  if (dueMs === null) return judgement("not_measured", "no_value", null, current);
  if (nowMs > dueMs) return judgement("needs_you", "ended", dueMs, current);
  const start = series[0]!;
  if (series.length === 1 || dueMs <= start.observedAtMs)
    return judgement("on_track", "starting_point", start.observedAtMs, current);
  const share = Math.min(
    1,
    Math.max(0, (nowMs - start.observedAtMs) / (dueMs - start.observedAtMs)),
  );
  const expected = start.value + (measure.target - start.value) * share;
  if (onTargetSide(direction, current.value, expected))
    return judgement("on_track", "on_target_side", null, current);
  const quarter = record.createdAtMs + 0.25 * (dueMs - record.createdAtMs);
  if (nowMs < quarter) return judgement("on_track", "too_early_to_judge", null, current);
  return judgement("behind", "off_target_side", current.observedAtMs, current);
}

/** GoalProgress@1 for one viewer and audience. */
export function goalProgress(
  record: GoalRecordFacts,
  values: readonly GoalValueFacts[],
  viewer: ProgressViewer,
  ctx: ProgressContext,
): Current_GoalProgress {
  const goals: Current_GoalMeasureProgress[] = [];
  for (const criterion of record.successCriteria) {
    const measure = criterion.measure;
    if (measure === undefined || measure === null || criterion.key === undefined) continue;
    if (!goalVisible(measure, viewer, ctx)) continue;
    const seen = visibleValues(criterion.key, measure, values, viewer, ctx.nowMs);
    const j = judge(record, criterion.key, measure, seen, ctx.nowMs);
    goals.push({
      key: criterion.key,
      health: j.health,
      reason: j.reason,
      since: iso(j.sinceMs),
      value:
        j.value === null
          ? null
          : {
              value: j.value.value,
              source: measureSource(measure),
              observedAt: new Date(j.value.observedAtMs).toISOString(),
            },
      target: measure.target,
      direction: measureDirection(measure),
      dueAt: measure.dueAt ?? iso(record.dueAtMs),
    });
  }
  let health: Current_GoalHealth;
  let reason: Current_GoalHealthReason;
  let sinceMs: number | null = null;
  if (ctx.finished) {
    [health, reason, sinceMs] = ["done", "finished", ctx.finished.atMs];
  } else if (ctx.waitingOnViewer) {
    [health, reason] = ["needs_you", "waiting_on_you"];
  } else if (record.dueAtMs !== null && ctx.nowMs > record.dueAtMs) {
    [health, reason, sinceMs] = ["needs_you", "ended", record.dueAtMs];
  } else if (goals.length === 0) {
    [health, reason] = ["not_measured", "no_value"];
  } else {
    // The worst shown goal; a Done goal is On track until the project is finished.
    const worst = goals.reduce((a, b) =>
      rank[b.health === "done" ? "on_track" : b.health] >
      rank[a.health === "done" ? "on_track" : a.health]
        ? b
        : a,
    );
    health = worst.health === "done" ? "on_track" : worst.health;
    reason = worst.reason;
    sinceMs = worst.since === null ? null : Date.parse(worst.since);
  }
  const progress: Current_GoalProgress = {
    schemaVersion: 1,
    goalId: record.id,
    goalRevision: record.revision,
    health,
    reason,
    since: iso(sinceMs),
    goals,
    computedAt: new Date(ctx.nowMs).toISOString(),
  };
  if (!validateCurrentDefinition("GoalProgress", progress))
    throw new TypeError("GOAL_PROGRESS_INVALID");
  return progress;
}

/** Code's own view for Finish's results record: every tag, every audience rule kept. */
export const codeViewer: ProgressViewer = Object.freeze({ mayView: () => true });

export interface StepFacts {
  readonly startsAtMs: number | null;
  readonly lastMovedAtMs: number;
  readonly ended: boolean;
}
export type StepHealth =
  | { readonly kind: "not_started"; readonly startsAt: string }
  | { readonly kind: "no_progress"; readonly since: string }
  | { readonly kind: "moving" };
/**
 * A step's own word (flow-contracts.md): a launch milestone shows "Not started" before its
 * date; a step unmoved for 3 days shows "No progress since [day]".
 */
export function stepHealth(step: StepFacts, nowMs: number): StepHealth {
  if (step.ended) return { kind: "moving" };
  if (step.startsAtMs !== null && nowMs < step.startsAtMs)
    return { kind: "not_started", startsAt: new Date(step.startsAtMs).toISOString() };
  if (nowMs - step.lastMovedAtMs >= 3 * dayMs)
    return { kind: "no_progress", since: new Date(step.lastMovedAtMs).toISOString() };
  return { kind: "moving" };
}
