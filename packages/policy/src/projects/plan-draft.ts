import type {
  Current_ContextTaint,
  Current_GoalMeasure,
  Current_PlanDraft,
  Current_PlanDraftToolAssignee,
  Current_PlanDraftToolMeasure,
  Current_PlanDraftToolTarget,
  Current_PlanStepAssignee,
  Current_PlanTarget,
  Current_RestrictedSource,
  Current_ToolInputPlanDraft,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import planDraftsSwitch from "../../../../docs/decisions/plan-drafts-staging.json";
import { type TeamSwitchState, teamSwitchState } from "../teammates";
import { type ToolEntry, toolEntry } from "../tool-catalogue";
import { canonicalText, sha256Hex } from "./digest";

// ADR-0034: Morrow drafts; a person's tap creates. Everything here is a code check outside
// any model prompt: the tool's closed input, the refusal in a turn holding a report, the
// Coordinator's launch tool subset, Morrow's tools in a private Ask, the choice-question
// budget, @Morrow's verbs and the taint a card keeps through edits.

/** docs/decisions/plan-drafts-staging.json, read once (committed off and held). */
export const planDraftsRecord: Readonly<{
  switch: "on" | "off";
  start_routes: "held" | "ready";
}> = Object.freeze({
  switch: planDraftsSwitch.switch === "on" ? "on" : "off",
  start_routes: planDraftsSwitch.start_routes === "ready" ? "ready" : "held",
});

/**
 * The switch may be on only after the agent loop is on and P05.T04b's Ask-bound envelope
 * exists (ADR-0034 item 10); edge checks refuse a mixed state with this.
 */
export function planDraftsSwitchAllowed(state: {
  readonly planDrafts: "on" | "off";
  readonly agentLoop: "on" | "off";
  readonly askEnvelope: boolean;
}): boolean {
  return state.planDrafts === "off" || (state.agentLoop === "on" && state.askEnvelope);
}

/**
 * plan.draft (ADR-0034 item 2) as ToolCatalogue@1 lists it since version 2: a coordination tool on
 * workspace.conversation.post (execute, internal-write replay, 8 KiB results), offered to the
 * Coordinator only. It posts one card holding a closed, digested PlanDraft@1, creates no
 * other record and grants nothing (a catalogue entry names no grant).
 */
export const planDraftTool: ToolEntry = (() => {
  const entry = toolEntry("plan.draft");
  if (entry === null) throw Error("PLAN_DRAFT_TOOL_MISSING");
  return entry;
})();

/**
 * ADR-0027 item 8's Coordinator set with plan.draft, ADR-0037 item 1's teammate tools and
 * ADR-0041 items 24 and 33's orchestration, memory and harness tools (ToolCatalogue@1 version
 * 4: agent.propose in place of specialist.draft; agent.ask, agent.map, agent.message and
 * agent.cancel; knowledge.propose; memory.search, memory.read in place of agent.result.read,
 * and memory.suggest; run.plan, run.complete, run.wait and context.checkpoint); it keeps
 * task.create.
 */
export const coordinatorGrantTools = Object.freeze([
  "knowledge.search",
  "work.read",
  "message.post",
  "inbox.ask",
  "task.create",
  "agent.route",
  "agent.ask",
  "agent.map",
  "agent.message",
  "agent.cancel",
  "agent.propose",
  "plan.draft",
  "knowledge.propose",
  "memory.search",
  "memory.read",
  "memory.suggest",
  "run.plan",
  "run.complete",
  "run.wait",
  "context.checkpoint",
] as const);
export type CoordinatorTool = (typeof coordinatorGrantTools)[number];
/**
 * Morrow's tools in catalogue version 4 whose path for Morrow a later plan row builds, so no
 * Morrow context is offered them yet: memory.suggest with person memory and its switch (H12b),
 * and knowledge.propose with Morrow's own principal-keyed proposals (H12d; PR 20's definer
 * keys a proposal by the run's installation, which Morrow's run has none of, so it would fail
 * closed). knowledge/tools.ts refuses Morrow's knowledge.propose too, until then.
 */
export const pendingMorrowTools = Object.freeze(["memory.suggest", "knowledge.propose"] as const);
/** The teammate-call tools (ADR-0041 items 21 and 22), all behind the teammate-calls switch. */
const teammateCallTools: readonly CoordinatorTool[] = [
  "agent.ask",
  "agent.map",
  "agent.message",
  "agent.cancel",
];
/**
 * The morrow.coordinator release's launch subset (ADR-0034 item 1, a product choice), fixed
 * when a context is admitted (tools never change inside a context, ADR-0041 item 2):
 * task.create is left out, so Morrow creates no task at launch. plan.draft is in it only
 * while the plan-drafts switch is on; agent.ask, agent.map, agent.message and agent.cancel
 * only while the teammate-calls switch is on, and agent.propose only while the agent-cards
 * switch is on (ADR-0037 item 9; both committed off). Two tools wait for the plan rows that
 * build their paths for Morrow, and are left out until then (pendingMorrowTools). The memory
 * reads and the harness tools grant nothing and sit behind the agent-loop switch itself.
 */
export function coordinatorLaunchTools(
  switchState: "on" | "off" = planDraftsRecord.switch,
  team: TeamSwitchState = teamSwitchState(),
) {
  return Object.freeze(
    coordinatorGrantTools.filter(
      (t) =>
        t !== "task.create" &&
        !(pendingMorrowTools as readonly string[]).includes(t) &&
        (t !== "plan.draft" || switchState === "on") &&
        (!teammateCallTools.includes(t) || team.teammateCalls === "on") &&
        (t !== "agent.propose" || team.agentCards === "on"),
    ),
  );
}
/**
 * Morrow's tools in a private Ask (ADR-0034 item 7), only under P05.T04b's Ask-bound
 * envelope: never task.create, agent.propose, inbox.ask or a mention. agent.route once per
 * run, for one active added agent's read-only answer. ADR-0037 item 3 replaces this with
 * read-only agent.ask calls, as many as the work needs and no hand-off; its implementation
 * plan's PR 5 (Morrow's tools) carries that change, before any Ask runs an agent (P05.T04b).
 */
export const askTools = Object.freeze([
  "knowledge.search",
  "work.read",
  "message.post",
  "plan.draft",
  "agent.route",
] as const);
/** The @Morrow run (ADR-0034 item 8): answers, choice questions and task or change cards. */
export const mentionRunTools = Object.freeze([
  "knowledge.search",
  "work.read",
  "message.post",
  "plan.draft",
] as const);

export type ConversationKind = "project" | "task" | "ask";
export type ToolRefusal =
  | "plan_drafts_off"
  | "report_in_context"
  | "ask_envelope_missing"
  | "tool_not_in_subset"
  | "route_used"
  | "choice_budget_spent"
  | "card_kind_not_allowed"
  | "input_invalid";
export interface TurnFacts {
  readonly conversation: ConversationKind;
  /** The run was started by @Morrow or "Plan next steps" in a project conversation. */
  readonly mentionRun: boolean;
  /** The turn's context holds a report (ADR-0027 item 10): plan.draft is refused. */
  readonly holdsReport: boolean;
  /** P05.T04b's Ask-bound envelope binds this run (required for any Ask work). */
  readonly askEnvelope: boolean;
  readonly agentRoutesUsed: number;
  readonly choiceQuestionsAsked: number;
  readonly switchState: "on" | "off";
}
/** The tools one Coordinator turn may call, from code (never from the model or a skill). */
export function turnTools(turn: TurnFacts): readonly string[] {
  if (turn.conversation === "ask") {
    if (!turn.askEnvelope || turn.switchState === "off") return Object.freeze([]);
    return Object.freeze(askTools.filter((t) => t !== "agent.route" || turn.agentRoutesUsed === 0));
  }
  if (turn.mentionRun)
    return Object.freeze(
      mentionRunTools.filter((t) => t !== "plan.draft" || turn.switchState === "on"),
    );
  return coordinatorLaunchTools(turn.switchState);
}

/** The words of a title: 2 to 6 (flow-contracts.md). */
const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;
const isoMs = (text: string) => Date.parse(text);

/**
 * PlanDraft@1's code rules beyond its schema: the title's word count; the kind's shape;
 * unique goal and step keys; dependencies on earlier steps only (so no cycle); goal
 * measures with a null startRef, no later than the new project's date; a repeat naming
 * only a goal of the card or of its target; specialist steps only in a project.
 */
export function planDraftValid(value: unknown): value is Current_PlanDraft {
  if (!validateCurrentDefinition("PlanDraft", value)) return false;
  const d = value as Current_PlanDraft;
  if (words(d.title) < 2 || words(d.title) > 6) return false;
  const goalKeys = d.goals.map((g) => g.key);
  const stepKeys = d.steps.map((s) => s.key);
  if (new Set(goalKeys).size !== goalKeys.length || new Set(stepKeys).size !== stepKeys.length)
    return false;
  for (const [i, step] of d.steps.entries())
    if (step.dependsOn.some((k) => !stepKeys.slice(0, i).includes(k))) return false;
  if (d.goals.some((g) => g.measure.startRef !== null)) return false;
  const repeats = d.steps.filter((s) => s.repeat !== null);
  const specialists = d.steps.filter((s) => s.assignee.kind === "specialist");
  switch (d.kind) {
    case "project": {
      if (d.target.kind !== "new_project" || d.goals.length < 1) return false;
      const due = isoMs(d.target.dueAt);
      if (d.goals.some((g) => g.measure.dueAt !== null && isoMs(g.measure.dueAt) > due))
        return false;
      if (repeats.some((s) => s.repeat!.goalKey !== null && !goalKeys.includes(s.repeat!.goalKey)))
        return false;
      break;
    }
    case "task":
      if (d.goals.length !== 0 || d.steps.length !== 1 || repeats.length !== 0) return false;
      if (d.target.kind === "new_project" || specialists.length !== 0) return false;
      break;
    case "repeating":
      if (d.goals.length !== 0 || d.steps.length !== 1 || repeats.length !== 1) return false;
      if (d.target.kind !== "area" && d.target.kind !== "existing_project") return false;
      if (specialists.length !== 0) return false;
      break;
    case "plan_change":
      if (d.target.kind !== "existing_project") return false;
      break;
  }
  return true;
}

const nulls = (...values: readonly unknown[]) => values.every((v) => v === null);
function targetOf(t: Current_PlanDraftToolTarget): Current_PlanTarget | null {
  switch (t.kind) {
    case "new_project":
      return t.dueAt !== null && nulls(t.projectId, t.goalRevision, t.areaTemplateId)
        ? { kind: t.kind, dueAt: t.dueAt }
        : null;
    case "existing_project":
      return t.projectId !== null && t.goalRevision !== null && nulls(t.dueAt, t.areaTemplateId)
        ? { kind: t.kind, projectId: t.projectId, goalRevision: t.goalRevision }
        : null;
    case "area":
      return t.areaTemplateId !== null && nulls(t.dueAt, t.projectId, t.goalRevision)
        ? { kind: t.kind, areaTemplateId: t.areaTemplateId }
        : null;
    case "quick_tasks":
      return nulls(t.dueAt, t.projectId, t.goalRevision, t.areaTemplateId)
        ? { kind: t.kind }
        : null;
  }
}
function measureOf(m: Current_PlanDraftToolMeasure): Current_GoalMeasure | null {
  const clock = { target: m.target, dueAt: m.dueAt, startRef: null };
  switch (m.kind) {
    case "metric":
      return m.metricId !== null &&
        nulls(m.checklistId, m.assistant, m.cadenceWeeks) &&
        m.productIds.length === 0 &&
        m.rows.length === 0
        ? { kind: m.kind, metricId: m.metricId, ...clock }
        : null;
    case "checklist":
      return m.checklistId !== null &&
        nulls(m.metricId, m.assistant, m.cadenceWeeks) &&
        m.rows.length === 0
        ? { kind: m.kind, checklistId: m.checklistId, productIds: [...m.productIds], ...clock }
        : null;
    case "manual":
      return m.assistant !== null &&
        m.cadenceWeeks !== null &&
        nulls(m.metricId, m.checklistId) &&
        m.productIds.length === 0
        ? {
            kind: m.kind,
            assistant: m.assistant,
            cadenceWeeks: m.cadenceWeeks,
            rows: m.rows.map((r) => ({ productId: r.productId, checkItems: [...r.checkItems] })),
            ...clock,
          }
        : null;
  }
}
function assigneeOf(a: Current_PlanDraftToolAssignee): Current_PlanStepAssignee | null {
  switch (a.kind) {
    case "person":
      return a.principalId !== null && nulls(a.installationId, a.purpose)
        ? { kind: a.kind, principalId: a.principalId }
        : null;
    case "agent":
      return a.installationId !== null && nulls(a.principalId, a.purpose)
        ? { kind: a.kind, installationId: a.installationId }
        : null;
    case "specialist":
      return a.purpose !== null && nulls(a.principalId, a.installationId)
        ? { kind: a.kind, purpose: a.purpose }
        : null;
    case "code":
      return nulls(a.principalId, a.installationId, a.purpose) ? { kind: a.kind } : null;
  }
}
/**
 * The recorded plan.draft input (ToolInputPlanDraft, the full definition the tool-call step
 * validates) as PlanDraft@1: schemaVersion 1, every startRef null, each flattened choice
 * mapped to its branch. A field outside its kind's set that is not null (or empty) is
 * refused, so one input names one draft. Null when it maps to nothing; PlanDraft@1's
 * schema and code rules are checked by planDraftValid.
 */
export function planDraftFromToolInput(input: unknown): Current_PlanDraft | null {
  if (!validateCurrentDefinition("ToolInputPlanDraft", input)) return null;
  const i = input as Current_ToolInputPlanDraft;
  const target = targetOf(i.target);
  const goals = i.goals.map((g) => {
    const measure = measureOf(g.measure);
    return measure && { key: g.goalKey, description: g.description, measure };
  });
  const steps = i.steps.map((s) => {
    const assignee = assigneeOf(s.assignee);
    return (
      assignee && {
        key: s.stepKey,
        title: s.title,
        assignee,
        dependsOn: [...s.dependsOn],
        repeat: s.repeat && { cadence: s.repeat.cadence, goalKey: s.repeat.goalKey },
      }
    );
  });
  if (target === null || goals.some((g) => g === null) || steps.some((s) => s === null))
    return null;
  return {
    schemaVersion: 1,
    kind: i.kind,
    title: i.title,
    why: i.why,
    doneWhen: i.doneWhen,
    goals: goals as Current_PlanDraft["goals"],
    steps: steps as Current_PlanDraft["steps"],
    target,
  };
}

/** sha256 of the canonical JSON (RFC 8785 over closed JSON) of a draft. */
export const planDraftDigest = (draft: Current_PlanDraft): Promise<string> =>
  sha256Hex(canonicalText(draft));

/**
 * One plan.draft call, decided in code. Refused while the switch is off, in a turn holding
 * a report (`report_in_context`), in an Ask without its envelope, outside the turn's tool
 * subset; a mention run drafts only task or plan-change cards. The input is the recorded
 * tool_use input (ToolInputPlanDraft, ToolCatalogue@1 since version 2), mapped to the closed
 * PlanDraft@1 by planDraftFromToolInput; nothing a model writes names a capability, scope,
 * grant, cap, model, recipient, sender or store.
 */
export async function decidePlanDraft(
  turn: TurnFacts,
  input: unknown,
): Promise<
  | { readonly ok: true; readonly draft: Current_PlanDraft; readonly digest: string }
  | { readonly ok: false; readonly refusal: ToolRefusal }
> {
  if (turn.switchState === "off") return { ok: false, refusal: "plan_drafts_off" };
  if (turn.holdsReport) return { ok: false, refusal: "report_in_context" };
  if (turn.conversation === "ask" && !turn.askEnvelope)
    return { ok: false, refusal: "ask_envelope_missing" };
  if (!turnTools(turn).includes("plan.draft")) return { ok: false, refusal: "tool_not_in_subset" };
  const mapped = planDraftFromToolInput(input);
  if (mapped === null || !planDraftValid(mapped)) return { ok: false, refusal: "input_invalid" };
  if (turn.mentionRun && mapped.kind !== "task" && mapped.kind !== "plan_change")
    return { ok: false, refusal: "card_kind_not_allowed" };
  const draft = structuredClone(mapped);
  return { ok: true, draft, digest: await planDraftDigest(draft) };
}

/** A choice question: Coordinator only, at most 2 per run (ADR-0034 item 7). */
export function decideChoiceQuestion(
  turn: TurnFacts,
  authorIsCoordinator: boolean,
): ToolRefusal | "ok" {
  if (!authorIsCoordinator) return "tool_not_in_subset";
  if (turn.switchState === "off") return "plan_drafts_off";
  if (turn.conversation === "ask" && !turn.askEnvelope) return "ask_envelope_missing";
  if (turn.choiceQuestionsAsked >= 2) return "choice_budget_spent";
  return "ok";
}
/** agent.route in an Ask: once per run, one active added agent, read-only (ADR-0034 item 7). */
export function decideAskRoute(
  turn: TurnFacts,
  target: { readonly active: boolean; readonly added: boolean },
): ToolRefusal | "ok" {
  if (turn.conversation !== "ask") return "ok";
  if (turn.switchState === "off") return "plan_drafts_off";
  if (!turn.askEnvelope) return "ask_envelope_missing";
  if (turn.agentRoutesUsed > 0) return "route_used";
  if (!target.active || !target.added) return "input_invalid";
  return "ok";
}

/**
 * @Morrow (ADR-0034 item 8): a typed mention with target coordinator and request ask. Its
 * author, and anyone tapping "Plan next steps", needs execute on
 * workspace.conversation.create (the human_only right to open an Ask), execute on
 * workspace.conversation.post and goal view of the project. Human-authored only;
 * MENTION_NOT_ALLOWED in an Ask and, at launch, in a task conversation (owner question 3).
 */
export interface MentionFacts {
  readonly authorKind: "human" | "agent" | "system";
  readonly conversation: ConversationKind;
  readonly conversationCreateExecute: boolean;
  readonly conversationPostExecute: boolean;
  readonly projectGoalView: boolean;
  readonly switchState: "on" | "off";
}
export type MentionRefusal =
  | "AGENT_MENTION_DENIED"
  | "MENTION_NOT_ALLOWED"
  | "PERMISSION_DENIED"
  | "plan_drafts_off";
export function decideCoordinatorMention(m: MentionFacts): MentionRefusal | "ok" {
  if (m.authorKind !== "human") return "AGENT_MENTION_DENIED";
  if (m.conversation !== "project") return "MENTION_NOT_ALLOWED";
  if (!m.conversationCreateExecute || !m.conversationPostExecute || !m.projectGoalView)
    return "PERMISSION_DENIED";
  if (m.switchState === "off") return "plan_drafts_off";
  return "ok";
}

/** One revision of a card (plan_draft_revisions, FORCE RLS). */
export interface PlanDraftRevision {
  readonly messageId: string;
  readonly revision: number;
  readonly draft: Current_PlanDraft;
  readonly digest: string;
  readonly editorPrincipalId: string | null;
  readonly contextTaint: Current_ContextTaint;
  readonly restrictedSources: readonly Current_RestrictedSource[];
}
/**
 * A person's edit (ADR-0034 item 3): a new revision with the editor and a new digest,
 * keeping the original's taint and restricted sources (ADR-0024 item 8). An edit can never
 * clear a taint, and the edited draft passes the same code rules.
 */
export async function reviseDraft(
  current: PlanDraftRevision,
  edited: unknown,
  editorPrincipalId: string,
): Promise<PlanDraftRevision | null> {
  if (!planDraftValid(edited)) return null;
  if (edited.kind !== current.draft.kind) return null;
  const draft = structuredClone(edited);
  return Object.freeze({
    messageId: current.messageId,
    revision: current.revision + 1,
    draft,
    digest: await planDraftDigest(draft),
    editorPrincipalId,
    contextTaint: current.contextTaint,
    restrictedSources: current.restrictedSources,
  });
}
