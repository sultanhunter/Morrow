// The tool catalogue rules (PR 10; ADR-0027 items 2, 3 and 8, ADR-0024 item 6, ADR-0037
// items 1 to 3, ADR-0041 item 24). Pure: no I/O, clock or randomness. The data is generated
// from docs/contracts/tool-catalogue.json (scripts/generate-agent-platform.mjs), which
// inspects it first.
//
// - Tools are named by the closed ToolName enum and offered by context: the Coordinator's
//   fixed set, a person's routed run (a hand-off), a mandate run, a look-for-work pass (reads,
//   suggestions, memory reads and its own plan and completion) or a called teammate's run (no
//   question, post or memory suggestion to the person; it builds result items with
//   result.write and ends with run.complete's child form). agent.* tools are the Coordinator's
//   only.
// - Two kinds of tool (ADR-0041 item 24). A grant tool is one capability and verb: a run is
//   offered its package's declared grant tools intersected with its context's, and the agent
//   loop re-checks the intersection at every call. A context tool (the memory and harness
//   families) holds no capability: it grants nothing, writes only its run's own rows or reads
//   what code decides per target, and every run of a context is offered its context's set;
//   a package never declares one and a card never picks one. A skill never adds a tool, and
//   nothing here grants anything.
// - The model sees wire names and strict input schemas only, in catalogue order, so the
//   cached prefix of a run stays byte-stable. A recorded tool_use carries the same strict
//   shape (ToolModelInput*); the tool-call step validates it again with the full ToolInput
//   definition (checkToolInput), and a limit breach is that call's invalid_input.
// - Catalogue version 4 retired the specialist context and the Specialist ceiling with the
//   specialist kind (ADR-0037 item 7), and folded agent.result.read into memory.read and
//   result.submit into run.complete's child form (ADR-0041 item 24).
import type {
  Current_AgentRunKind,
  Current_CapabilityVerbs,
  Current_ToolContext,
  Current_ToolFamily,
  Current_ToolName,
  Current_ToolReplayClass,
  CurrentDefinitionName,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { generatedToolCatalogue } from "./generated/tool-catalogue";

export type ToolName = Current_ToolName;
export type ToolContext = Current_ToolContext;
export type PermissionVerb = Current_CapabilityVerbs["verbs"][number];

/** One tool as the loop and the broker see it. */
export interface ToolEntry {
  readonly name: ToolName;
  readonly wireName: string;
  readonly family: Current_ToolFamily;
  /** Null for a context tool (memory and harness families): it holds no capability. */
  readonly capabilityId: string | null;
  readonly verb: PermissionVerb | null;
  readonly replayClass: Current_ToolReplayClass;
  readonly resultMaxBytes: number;
  readonly inputDefinition: string;
  readonly contexts: readonly ToolContext[];
  readonly description: string;
  readonly inputSchema: unknown;
}
/** The provider-neutral tool definition the broker sends (strict, ADR-0027 item 4). */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
  readonly strict: true;
}

export class ToolCatalogueError extends Error {
  constructor(readonly code: "TOOL_CATALOGUE_INPUT_INVALID") {
    super(code);
    this.name = "ToolCatalogueError";
  }
}
const invalid = () => new ToolCatalogueError("TOOL_CATALOGUE_INPUT_INVALID");

const entries: readonly ToolEntry[] = Object.freeze(
  generatedToolCatalogue.tools.map((tool) => Object.freeze(tool as unknown as ToolEntry)),
);
const byName = new Map(entries.map((tool) => [tool.name as string, tool]));
const byWire = new Map(entries.map((tool) => [tool.wireName, tool]));
const contexts: readonly ToolContext[] = [
  "coordinator",
  "routed",
  "mandate",
  "look_for_work",
  "call",
];

/** The catalogue version and digest a run manifest pins. */
export const toolCatalogueVersion: number = generatedToolCatalogue.version;
export const toolCatalogueDigest: string = generatedToolCatalogue.digest;
/** Every tool, in catalogue order. */
export const toolCatalogue: readonly ToolEntry[] = entries;

/** One tool by its Morrow name, or null. */
export function toolEntry(name: unknown): ToolEntry | null {
  return typeof name === "string" ? (byName.get(name) ?? null) : null;
}
/** One tool by the name the model sees, or null (an unknown name is an invalid tool_use). */
export function toolByWireName(wireName: unknown): ToolEntry | null {
  return typeof wireName === "string" ? (byWire.get(wireName) ?? null) : null;
}
/**
 * The context a run's tools come from. Look-for-work is a mandate run's pass; a teammate call
 * is a routed run (ADR-0037 item 2) offered the call context's tools.
 */
export function runContext(
  kind: Current_AgentRunKind,
  lookForWork: boolean,
  called = false,
): ToolContext {
  if (
    !["coordinator", "routed", "mandate"].includes(kind) ||
    typeof lookForWork !== "boolean" ||
    typeof called !== "boolean" ||
    (lookForWork && kind !== "mandate") ||
    (called && (kind !== "routed" || lookForWork))
  )
    throw invalid();
  return lookForWork ? "look_for_work" : called ? "call" : kind;
}
/**
 * A called teammate's result item tool (ADR-0041 items 22 and 24): the call context's only. It
 * returns its result with run.complete's child form, in place of ADR-0037's result.submit.
 */
export const teammateItemTool = "result.write";
/** The tool every job and call finishes with (ADR-0041 items 16 and 24). */
export const completionTool = "run.complete";
/** The agent.* tools (ADR-0037 item 2): the Coordinator's only, never a teammate's. */
export function isAgentTool(name: unknown): boolean {
  return typeof name === "string" && name.startsWith("agent.") && byName.has(name);
}
/**
 * Whether a tool is a context tool (ADR-0041 item 24: the memory and harness families): it
 * holds no capability, grants nothing and is offered by its context, never declared.
 */
export function isContextTool(name: unknown): boolean {
  const tool = toolEntry(name);
  return tool !== null && (tool.family === "memory" || tool.family === "harness");
}
/** The tools a context may be offered, in catalogue order. */
export function toolsForContext(context: ToolContext): readonly ToolName[] {
  if (!contexts.includes(context)) throw invalid();
  return Object.freeze(entries.filter((t) => t.contexts.includes(context)).map((t) => t.name));
}
/** A context's grant tools (each one capability and verb), in catalogue order. */
export function grantToolsForContext(context: ToolContext): readonly ToolName[] {
  return Object.freeze(toolsForContext(context).filter((name) => !isContextTool(name)));
}
/** A context's context tools (memory and harness), in catalogue order: every run gets them. */
export function contextToolsForContext(context: ToolContext): readonly ToolName[] {
  return Object.freeze(toolsForContext(context).filter((name) => isContextTool(name)));
}
/**
 * The tools one run is offered, in catalogue order: the release's declared grant tools
 * intersected with its context's, and the context's context tools (ADR-0041 item 24). The
 * Coordinator has no package: it gets its fixed set. An unknown or repeated declared name, or
 * a declared context tool, throws (a release that declares one fails its review, never here).
 */
export function offeredTools(
  context: ToolContext,
  declared: readonly string[] | null,
): readonly ToolName[] {
  const allowed = toolsForContext(context);
  if (context === "coordinator") {
    if (declared !== null) throw invalid();
    return allowed;
  }
  if (
    !Array.isArray(declared) ||
    declared.length > 32 ||
    new Set(declared).size !== declared.length ||
    declared.some((name) => !byName.has(name) || isContextTool(name))
  )
    throw invalid();
  return Object.freeze(
    allowed.filter((name) => declared.includes(name) || isContextTool(name)),
  );
}
/** The broker's tool definitions for offered tools, in catalogue order (a stable prefix). */
export function modelToolDefinitions(names: readonly string[]): readonly ModelToolDefinition[] {
  if (
    !Array.isArray(names) ||
    new Set(names).size !== names.length ||
    names.some((n) => !byName.has(n))
  )
    throw invalid();
  return Object.freeze(
    entries
      .filter((tool) => names.includes(tool.name))
      .map((tool) =>
        Object.freeze({
          name: tool.wireName,
          description: tool.description,
          input_schema: tool.inputSchema,
          strict: true as const,
        }),
      ),
  );
}

/** The tool-call step's validation of one input (ADR-0027 item 2). */
export type ToolInputCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: "invalid_input"; readonly refusal: "input_invalid" };
const inputValid: ToolInputCheck = Object.freeze({ ok: true });
const inputInvalid: ToolInputCheck = Object.freeze({
  ok: false,
  outcome: "invalid_input",
  refusal: "input_invalid",
});
/**
 * The tool-call step's validation (ADR-0027 item 2), after lease re-entry and replay and
 * before ids in scope, authority, the hold and dispatch. A recorded tool_use input is
 * inside the tool's strict shape, which carries no length, range or pattern limits; this
 * validates it again with the tool's full ToolInput definition. A breach is the call's
 * invalid_input, recorded with refusal input_invalid and returned to the model, which may
 * call again within the run's tool-call caps. An unknown tool throws: that reply was an
 * invalid output, which ends the run before any tool-call step.
 */
export function checkToolInput(name: unknown, input: unknown): ToolInputCheck {
  const tool = toolEntry(name);
  if (!tool) throw invalid();
  return validateCurrentDefinition(tool.inputDefinition as CurrentDefinitionName, input)
    ? inputValid
    : inputInvalid;
}
