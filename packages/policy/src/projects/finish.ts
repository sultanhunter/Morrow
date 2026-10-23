import { createHash } from "node:crypto";
import type {
  Current_CriteriaList,
  Current_GoalMeasure,
  Current_GoalProgress,
  Current_GoalStatus,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { isCustomerMeasure } from "./measures";
import { codeViewer, goalProgress, type GoalRecordFacts, type GoalValueFacts } from "./progress";

// "Finish project" and "Stop this project's steps" (ADR-0033 items 5 and 11), built from
// existing controls, with no model. Both are a person's act under that person's live grants
// (the kernel decides each piece; the definer rechecks under lock). Neither adds a stop
// scope or a kill switch. Finish and the cancelling half of Stop steps wait on the P06 task
// cancel edges (ADR-0010 item 5): until they exist, a record with any task that has not
// ended refuses Finish (`tasks_open`), and Stop steps turns the routines off and reports its
// unstarted tasks as `cancel_unavailable`, cancelling none.

/** Task states (state-transitions.json); the v1 tables reach only draft and ready. */
export type TaskStatus =
  | "draft"
  | "ready"
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "paused"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";
const ended: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);
const unstarted: ReadonlySet<TaskStatus> = new Set(["draft", "ready", "queued"]);
export const taskEnded = (s: TaskStatus) => ended.has(s);
export const taskUnstarted = (s: TaskStatus) => unstarted.has(s);

/**
 * Finish's results record (goal_finish_results): permanent, with no read tags and no clock,
 * and readable by every member, so it holds only each goal's key and health code. It never
 * holds a measured number (an order-derived number would outlive its 90-day clock and
 * escape its read tags) and never a customer-class goal (ADR-0033 item 4: customer values
 * never leave their content: customer table). Code decides `achieved` on its own full view;
 * the numbers it saw are not stored.
 */
export interface FinishResultsRecord {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly outcome: "achieved" | "cancelled";
  readonly goals: readonly {
    readonly key: string;
    readonly health: string;
  }[];
  readonly computedAt: string;
}
/** sha256 of the canonical JSON of a results record (sorted keys). */
export function finishResultsDigest(record: FinishResultsRecord): string {
  const canonical = (v: unknown): string =>
    v === null || typeof v !== "object"
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? "[" + v.map(canonical).join(",") + "]"
        : "{" +
          Object.keys(v as object)
            .sort()
            .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
            .join(",") +
          "}";
  return createHash("sha256").update(canonical(record), "utf8").digest("hex");
}

/** The Product pages area's goal record, when "Keep the monthly check" moves into it. */
export interface AreaRecordFacts {
  readonly goalId: string;
  readonly revision: number;
  readonly objective: string;
  readonly successCriteria: Current_CriteriaList;
}
export interface FinishInput {
  readonly record: GoalRecordFacts;
  readonly values: readonly GoalValueFacts[];
  readonly tasks: readonly { readonly id: string; readonly status: TaskStatus }[];
  readonly storeIds: readonly string[];
  readonly nowMs: number;
  readonly keepMonthlyCheck: boolean;
  readonly productPagesArea: AreaRecordFacts | null;
  readonly cancelEdgesAvailable: boolean;
}
export type FinishRefusal =
  | "not_a_project"
  | "already_finished"
  | "tasks_open"
  | "no_monthly_check"
  | "area_missing"
  | "area_goal_limit";
export interface FinishPlan {
  readonly to: Extract<Current_GoalStatus, "achieved" | "cancelled">;
  readonly results: FinishResultsRecord;
  readonly resultsDigest: string;
  /** Unstarted tasks to cancel first (only once the P06 cancel edges exist). */
  readonly cancelTaskIds: readonly string[];
  /** workspace.goal.revise on the Product pages area, when the monthly check moves. */
  readonly areaRevision: {
    readonly goalId: string;
    readonly expectedRevision: number;
    readonly objective: string;
    readonly dueAt: null;
    readonly successCriteria: Current_CriteriaList;
  } | null;
}
const areaNamedKey = "ai_named";

/**
 * Finish (ADR-0033 item 5): `achieved` when code finds every measured goal Done, otherwise
 * `cancelled` (both read "Finished"); with "Keep the monthly check in Product pages" ticked,
 * the hand check's product rows join the area's goal "AI assistants name your products"
 * through workspace.goal.revise, refusing when that would make a 4th measured goal.
 */
export function planFinish(input: FinishInput): FinishPlan | { readonly refusal: FinishRefusal } {
  const { record } = input;
  if (record.areaTemplateId !== null || record.dueAtMs === null)
    return { refusal: "not_a_project" };
  if (record.status === "achieved" || record.status === "cancelled")
    return { refusal: "already_finished" };
  const open = input.tasks.filter((t) => !taskEnded(t.status));
  if (
    open.some((t) => !taskUnstarted(t.status)) ||
    (open.length > 0 && !input.cancelEdgesAvailable)
  )
    return { refusal: "tasks_open" };
  const progress: Current_GoalProgress = goalProgress(record, input.values, codeViewer, {
    nowMs: input.nowMs,
    storeIds: input.storeIds,
    finished: null,
    waitingOnViewer: false,
    audience: "viewer",
  });
  const measured = record.successCriteria.filter(
    (c) => c.measure !== undefined && c.measure !== null,
  );
  const allDone =
    measured.length > 0 &&
    progress.goals.length === measured.length &&
    progress.goals.every((g) => g.health === "done");
  const customerKeys = new Set(
    measured.filter((c) => isCustomerMeasure(c.measure!)).map((c) => c.key),
  );
  const results: FinishResultsRecord = {
    goalId: record.id,
    goalRevision: record.revision,
    outcome: allDone ? "achieved" : "cancelled",
    goals: progress.goals
      .filter((g) => !customerKeys.has(g.key))
      .map((g) => ({ key: g.key, health: g.health })),
    computedAt: new Date(input.nowMs).toISOString(),
  };
  let areaRevision: FinishPlan["areaRevision"] = null;
  if (input.keepMonthlyCheck) {
    const check = measured.find((c) => c.measure!.kind === "manual")?.measure as
      | Extract<Current_GoalMeasure, { kind: "manual" }>
      | undefined;
    if (!check) return { refusal: "no_monthly_check" };
    const area = input.productPagesArea;
    if (!area) return { refusal: "area_missing" };
    const criteria = area.successCriteria.map((c) => structuredClone(c));
    const existing = criteria.find((c) => c.key === areaNamedKey && c.measure?.kind === "manual");
    if (existing && existing.measure && existing.measure.kind === "manual") {
      const rows = [...existing.measure.rows];
      for (const row of check.rows)
        if (!rows.some((r) => r.productId === row.productId)) rows.push(structuredClone(row));
      if (rows.length > 20) return { refusal: "area_goal_limit" };
      existing.measure = { ...existing.measure, rows };
    } else {
      if (criteria.filter((c) => c.measure !== undefined && c.measure !== null).length >= 3)
        return { refusal: "area_goal_limit" };
      criteria.push({
        description: "AI assistants name your products",
        verificationCapabilityId: null,
        evidenceRequired: false,
        key: areaNamedKey,
        measure: { ...structuredClone(check), dueAt: null, startRef: null },
      });
    }
    if (!validateCurrentDefinition("CriteriaList", criteria)) return { refusal: "area_goal_limit" };
    areaRevision = {
      goalId: area.goalId,
      expectedRevision: area.revision,
      objective: area.objective,
      dueAt: null,
      successCriteria: criteria,
    };
  }
  return {
    to: results.outcome,
    results,
    resultsDigest: finishResultsDigest(results),
    cancelTaskIds: open.map((t) => t.id),
    areaRevision,
  };
}

export interface StopStepsInput {
  readonly routines: readonly {
    readonly id: string;
    readonly status: "active" | "disabled";
    readonly revision: number;
  }[];
  readonly tasks: readonly { readonly id: string; readonly status: TaskStatus }[];
  readonly cancelEdgesAvailable: boolean;
}
export interface StopStepsPlan {
  /** workspace.routine.configure revisions: each leaves the routine disabled. */
  readonly disableRoutines: readonly {
    readonly routineId: string;
    readonly expectedRevision: number;
  }[];
  /** workspace.task.cancel for each unstarted task (once the cancel edges exist). */
  readonly cancelTaskIds: readonly string[];
  /** Running tasks keep their own Stop. */
  readonly keepRunningTaskIds: readonly string[];
  /** Unstarted tasks left as they are because the cancel edges do not exist yet. */
  readonly cancelUnavailableTaskIds: readonly string[];
}
/**
 * "Stop this project's steps" (ADR-0033 item 11): turns off the project's repeating tasks
 * (a configure revision, which never activates one) and cancels unstarted tasks. Approvals
 * waiting stay in the Inbox; turning a routine back on is workspace.routine.activate
 * (human_only); cancelled steps are added again, never revived.
 */
export function planStopSteps(input: StopStepsInput): StopStepsPlan {
  const unstartedIds = input.tasks.filter((t) => taskUnstarted(t.status)).map((t) => t.id);
  return {
    disableRoutines: input.routines
      .filter((r) => r.status === "active")
      .map((r) => ({ routineId: r.id, expectedRevision: r.revision })),
    cancelTaskIds: input.cancelEdgesAvailable ? unstartedIds : [],
    keepRunningTaskIds: input.tasks
      .filter((t) => !taskEnded(t.status) && !taskUnstarted(t.status))
      .map((t) => t.id),
    cancelUnavailableTaskIds: input.cancelEdgesAvailable ? [] : unstartedIds,
  };
}
