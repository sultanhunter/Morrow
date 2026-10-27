// The closed-input code rules of tool catalogue version 4's harness, memory and orchestration
// tools (ADR-0041 items 14, 16, 17, 21, 22 and 24; plan row H5). Pure: no I/O, clock or
// randomness, and no node:* import. A strict tool input carries no length, range, pattern or
// cross-field rule (the API refuses those keywords), so the tool-call step validates every
// input again with its full ToolInput definition (checkToolInput) and then with the rules
// here; a breach is the call's invalid_input, returned to the model, never an ended run.
//
// What these rules never decide: authority. A harness tool grants nothing and writes only its
// run's own rows, checked by the lease; a memory read is decided per target by its own rule;
// the loop's dispatch checks every id against SQL (a plan's keys, a call's state, an item's
// owner). Here only the shape of one input, and the context it is offered in.
import type {
  Current_RunPlanChange,
  Current_RunPlanFollowThroughInput,
  Current_RunPlanSetInput,
  Current_ToolInputContextCheckpoint,
  Current_ToolInputMemoryRead,
  Current_ToolInputResultWrite,
  Current_ToolInputRunComplete,
  Current_ToolInputRunPlan,
  Current_ToolInputRunWait,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { agentAskValid, agentMapValid, teammateResultInputValid } from "./teammates";
import {
  checkToolInput,
  type ToolContext,
  ToolCatalogueError,
  type ToolInputCheck,
  toolEntry,
} from "./tool-catalogue";

/** PostgreSQL text holds no NUL: refused in code, never sent to a definer. */
const storable = (text: string | null) => text === null || !text.includes("\u0000");
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;

// --- run.plan (ADR-0041 item 16) --------------------------------------------------------------
const followThroughValid = (f: Current_RunPlanFollowThroughInput) =>
  f.condition === "time" ? f.at !== null && f.id === null : f.id !== null && f.at === null;
/** Whether a set of dependencies over keys has no cycle (each key's dependsOn). */
function acyclic(items: readonly { itemKey: string; dependsOn: readonly string[] }[]): boolean {
  const deps = new Map(items.map((i) => [i.itemKey, i.dependsOn]));
  const state = new Map<string, "open" | "done">();
  const visit = (key: string): boolean => {
    if (state.get(key) === "done") return true;
    if (state.get(key) === "open") return false;
    state.set(key, "open");
    for (const next of deps.get(key) ?? []) if (!visit(next)) return false;
    state.set(key, "done");
    return true;
  };
  return items.every((i) => visit(i.itemKey));
}
/**
 * A plan's code rules: item and follow-through keys unique across the plan; each item's
 * criteria are indexes of the plan's criteria; dependencies name the plan's items, never
 * themselves, with no cycle; follow-through conditions typed (an id for a proposal or call,
 * a time for time); understood and steps exactly in Morrow's jobs (the coordinator context).
 */
export function runPlanSetValid(plan: Current_RunPlanSetInput, context: ToolContext): boolean {
  const items = plan.phases.flatMap((p) => p.items);
  const keys = [...items.map((i) => i.itemKey), ...plan.followThrough.map((f) => f.itemKey)];
  if (!distinct(keys)) return false;
  const itemKeys = new Set(items.map((i) => i.itemKey));
  if (
    items.some(
      (i) =>
        i.criteria.some((c) => c >= plan.criteria.length) ||
        i.dependsOn.some((d) => d === i.itemKey || !itemKeys.has(d)),
    )
  )
    return false;
  if (!acyclic(items) || !plan.followThrough.every(followThroughValid)) return false;
  const morrow = context === "coordinator";
  return morrow
    ? plan.understood !== null && plan.steps !== null
    : plan.understood === null && plan.steps === null;
}
/** One change's code rules: each kind takes its own fields and leaves the others null. */
export function runPlanChangeValid(change: Current_RunPlanChange): boolean {
  const only = (...names: (keyof Current_RunPlanChange)[]) =>
    (
      [
        "itemKey",
        "status",
        "reason",
        "phase",
        "item",
        "note",
        "followThrough",
        "criterion",
      ] as const
    ).every((name) => names.includes(name) === (change[name] !== null)) &&
    (names.includes("evidence") || change.evidence.length === 0);
  switch (change.kind) {
    case "item_status":
      // A drop or a block says why; done may say nothing more than its evidence.
      return change.status === "done"
        ? only("itemKey", "status", "evidence") || only("itemKey", "status", "evidence", "reason")
        : only("itemKey", "status", "reason", "evidence");
    case "add_item":
      return (
        only("phase", "item") && change.item!.dependsOn.every((d) => d !== change.item!.itemKey)
      );
    case "add_note":
      return only("note");
    case "add_follow_through":
      return only("followThrough") && followThroughValid(change.followThrough!);
    case "change_criterion":
      // A frozen criterion changes only with a stated reason (or the requester's message).
      return only("criterion", "reason");
  }
}
/** run.plan's code rules: set takes plan, update takes changes, read takes neither. */
export function runPlanInputValid(
  input: unknown,
  context: ToolContext,
): input is Current_ToolInputRunPlan {
  if (!validateCurrentDefinition("ToolInputRunPlan", input)) return false;
  const i = input as Current_ToolInputRunPlan;
  switch (i.action) {
    case "set":
      return i.plan !== null && i.changes === null && runPlanSetValid(i.plan, context);
    case "update":
      return i.plan === null && i.changes !== null && i.changes.every(runPlanChangeValid);
    case "read":
      return i.plan === null && i.changes === null;
  }
}

// --- run.complete (ADR-0041 items 16, 23 and 24) ----------------------------------------------
/**
 * run.complete's code rules: criteria reported once each; a called teammate gives its result
 * (the child form, with its own rules) and no reply, never waiting; Morrow's job gives the
 * reply it posts and no result; any other job gives no result. Look-for-work never waits: a
 * waiting completion opens a durable wait (ADR-0041 item 17), and its pass is reads and
 * suggestions only (ADR-0024 item 6). What a teammate needs goes only with blocked or partial.
 * The gate (plan, open calls and questions, unknown outcomes, typed checks, the review) runs at
 * dispatch against SQL.
 */
export function runCompleteInputValid(
  input: unknown,
  context: ToolContext,
): input is Current_ToolInputRunComplete {
  if (!validateCurrentDefinition("ToolInputRunComplete", input)) return false;
  const i = input as Current_ToolInputRunComplete;
  if (!distinct(i.criteria.map((c) => c.index)) || !storable(i.reply)) return false;
  if (context === "call")
    return (
      i.result !== null &&
      i.reply === null &&
      i.outcome !== "waiting" &&
      teammateResultInputValid(i.result) &&
      (i.result.needs === null || i.outcome === "blocked" || i.outcome === "partial")
    );
  if (i.result !== null) return false;
  if (context === "look_for_work" && i.outcome === "waiting") return false;
  return context === "coordinator" ? i.reply !== null : true;
}

// --- run.wait (ADR-0041 item 17) ----------------------------------------------------------------
/**
 * run.wait's code rules: children (only Morrow has them) takes match and optional call ids;
 * proposals takes match and proposal ids; time takes until; the rest null.
 */
export function runWaitInputValid(
  input: unknown,
  context: ToolContext,
): input is Current_ToolInputRunWait {
  if (!validateCurrentDefinition("ToolInputRunWait", input)) return false;
  const i = input as Current_ToolInputRunWait;
  switch (i.kind) {
    case "children":
      return (
        context === "coordinator" && i.match !== null && i.proposalIds === null && i.until === null
      );
    case "proposals":
      return i.match !== null && i.proposalIds !== null && i.callIds === null && i.until === null;
    case "time":
      return i.until !== null && i.match === null && i.callIds === null && i.proposalIds === null;
  }
}

// --- result.write (ADR-0041 items 22 and 24) ---------------------------------------------------
/**
 * result.write's code rules: starting an item (itemId null) names its title, kind and media
 * type (a table its columns, and text/csv); appending names none of them; text goes only to
 * text and file items, rows only to tables, each row one cell per column of a new table (an
 * append's widths are checked against the stored columns at dispatch); an append carries text,
 * rows or a close; nothing holds NUL.
 */
export function resultWriteInputValid(input: unknown): input is Current_ToolInputResultWrite {
  if (!validateCurrentDefinition("ToolInputResultWrite", input)) return false;
  const i = input as Current_ToolInputResultWrite;
  if (!storable(i.title) || !storable(i.text)) return false;
  if (i.rows !== null && i.rows.some((row) => row.some((cell) => cell.includes("\u0000"))))
    return false;
  if (i.columns !== null && i.columns.some((c) => c.includes("\u0000"))) return false;
  if (i.text !== null && i.rows !== null) return false;
  if (i.itemId === null) {
    if (i.title === null || i.kind === null || i.mediaType === null) return false;
    if (i.kind === "table")
      return (
        i.columns !== null &&
        i.mediaType === "text/csv" &&
        i.text === null &&
        (i.rows === null || i.rows.every((row) => row.length === i.columns!.length))
      );
    return i.columns === null && i.rows === null;
  }
  return (
    i.title === null &&
    i.kind === null &&
    i.mediaType === null &&
    i.columns === null &&
    (i.text !== null || i.rows !== null || i.close)
  );
}

// --- memory.read (ADR-0041 items 14 and 24) ----------------------------------------------------
/**
 * memory.read's code rules: a label only for kind label; a message range (from at most to, the
 * conversation by id) only for messages; a sequence only for a teammate result; an id for every
 * kind but label.
 */
export function memoryReadInputValid(input: unknown): input is Current_ToolInputMemoryRead {
  if (!validateCurrentDefinition("ToolInputMemoryRead", input)) return false;
  const t = (input as Current_ToolInputMemoryRead).target;
  const range = t.fromPosition !== null || t.toPosition !== null;
  switch (t.kind) {
    case "label":
      return t.label !== null && t.id === null && t.sequence === null && !range;
    case "messages":
      return (
        t.id !== null &&
        t.label === null &&
        t.sequence === null &&
        t.fromPosition !== null &&
        t.toPosition !== null &&
        t.fromPosition <= t.toPosition
      );
    case "teammate_result":
      return t.id !== null && t.label === null && !range;
    default:
      return t.id !== null && t.label === null && t.sequence === null && !range;
  }
}

// --- context.checkpoint (ADR-0041 items 11 and 13) ---------------------------------------------
/** context.checkpoint's code rule beyond its schema: no text holds NUL. */
export function contextCheckpointInputValid(
  input: unknown,
): input is Current_ToolInputContextCheckpoint {
  return (
    validateCurrentDefinition("ToolInputContextCheckpoint", input) &&
    !JSON.stringify(input).includes("\\u0000")
  );
}

// --- The tool-call step's one entry -------------------------------------------------------------
const invalidInput: ToolInputCheck = Object.freeze({
  ok: false,
  outcome: "invalid_input",
  refusal: "input_invalid",
});
/**
 * The tool-call step's validation of one input in its context (ADR-0027 item 2): the tool's
 * full ToolInput definition (checkToolInput), then the code rules above for the tools that
 * have them. An unknown tool, or one its context does not offer, throws: that reply was an
 * invalid output (an unoffered tool_use), which the step never dispatches.
 */
export function checkToolInputInContext(
  name: unknown,
  input: unknown,
  context: ToolContext,
): ToolInputCheck {
  const tool = toolEntry(name);
  if (!tool || !tool.contexts.includes(context))
    throw new ToolCatalogueError("TOOL_CATALOGUE_INPUT_INVALID");
  const base = checkToolInput(tool.name, input);
  if (!base.ok) return base;
  const rules: Partial<Record<string, (value: unknown) => boolean>> = {
    "agent.ask": agentAskValid,
    "agent.map": agentMapValid,
    "run.plan": (value) => runPlanInputValid(value, context),
    "run.complete": (value) => runCompleteInputValid(value, context),
    "run.wait": (value) => runWaitInputValid(value, context),
    "result.write": resultWriteInputValid,
    "memory.read": memoryReadInputValid,
    "context.checkpoint": contextCheckpointInputValid,
  };
  const rule = rules[tool.name];
  return rule === undefined || rule(input) ? base : invalidInput;
}
