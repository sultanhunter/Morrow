// The tool catalogue rules (PR 10; ADR-0027 items 2, 3 and 8, ADR-0024 item 6, ADR-0028
// item 2). Pure: no I/O, clock or randomness. The data is generated from
// docs/contracts/tool-catalogue.json and docs/contracts/specialist-ceiling.json
// (scripts/generate-agent-platform.mjs), which inspects it first.
//
// - Tools are named by the closed ToolName enum and offered by context: the Coordinator's
//   fixed set, a person's routed run, a mandate run, a look-for-work pass (reads and
//   suggestions only) or a specialist run. A run is offered its package's declared tools
//   intersected with its context's; a skill never adds a tool.
// - A tool is one capability and verb. The agent loop (PR 11) re-checks the intersection at
//   every call; nothing here grants anything.
// - The model sees wire names and strict input schemas only, in catalogue order, so the
//   cached prefix of a run stays byte-stable.
// - The Specialist ceiling is fixed ids; a specialist's capabilities are its tools' pairs
//   inside it, at most 16.
import type {
  Current_AgentRunKind,
  Current_CapabilityVerbs,
  Current_ToolContext,
  Current_ToolFamily,
  Current_ToolName,
  Current_ToolReplayClass,
} from "@morrow/contracts";
import { generatedSpecialistCeiling } from "./generated/specialist-ceiling";
import { generatedToolCatalogue } from "./generated/tool-catalogue";

export type ToolName = Current_ToolName;
export type ToolContext = Current_ToolContext;
export type PermissionVerb = Current_CapabilityVerbs["verbs"][number];

/** One tool as the loop and the broker see it. */
export interface ToolEntry {
  readonly name: ToolName;
  readonly wireName: string;
  readonly family: Current_ToolFamily;
  readonly capabilityId: string;
  readonly verb: PermissionVerb;
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
  constructor(readonly code: "TOOL_CATALOGUE_INPUT_INVALID" | "TOOL_OUTSIDE_CEILING") {
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
  "specialist",
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
/** The context a run's tools come from. Look-for-work is a mandate run's pass. */
export function runContext(kind: Current_AgentRunKind, lookForWork: boolean): ToolContext {
  if (
    !["coordinator", "routed", "mandate", "specialist"].includes(kind) ||
    typeof lookForWork !== "boolean" ||
    (lookForWork && kind !== "mandate")
  )
    throw invalid();
  return lookForWork ? "look_for_work" : kind;
}
/** The tools a context may be offered, in catalogue order. */
export function toolsForContext(context: ToolContext): readonly ToolName[] {
  if (!contexts.includes(context)) throw invalid();
  return Object.freeze(entries.filter((t) => t.contexts.includes(context)).map((t) => t.name));
}
/**
 * The tools one run is offered: the release's declared tools intersected with its context's,
 * in catalogue order. The Coordinator has no package: it gets its fixed set. An unknown or
 * repeated declared name throws (a release that declares one fails its review, never here).
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
    declared.some((name) => !byName.has(name))
  )
    throw invalid();
  return Object.freeze(allowed.filter((name) => declared.includes(name)));
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

/** The Specialist ceiling (ADR-0028 item 2): fixed ids, at most 16. */
export const specialistCeiling: readonly Current_CapabilityVerbs[] = Object.freeze(
  generatedSpecialistCeiling.capabilities.map((row) =>
    Object.freeze({
      capabilityId: row.capabilityId,
      verbs: Object.freeze([...row.verbs]) as unknown as PermissionVerb[],
    }),
  ),
);
export const specialistCeilingDigest: string = generatedSpecialistCeiling.digest;
/** Whether a capability and verb are inside the Specialist ceiling. */
export function withinSpecialistCeiling(capabilityId: unknown, verb: unknown): boolean {
  return specialistCeiling.some(
    (row) => row.capabilityId === capabilityId && (row.verbs as readonly unknown[]).includes(verb),
  );
}
/**
 * A specialist's capabilities (ADR-0027 item 10): the pairs of the tools its eligible
 * skills declare that the specialist context offers, inside the ceiling, grouped by
 * capability in ceiling order. Never from the skill ids the model picked; a tool outside the
 * ceiling throws TOOL_OUTSIDE_CEILING.
 */
export function specialistCapabilities(
  tools: readonly string[],
): readonly Current_CapabilityVerbs[] {
  const offered = offeredTools("specialist", tools);
  if (offered.length !== tools.length) throw new ToolCatalogueError("TOOL_OUTSIDE_CEILING");
  const pairs = offered.map((name) => byName.get(name)!);
  if (pairs.some((tool) => !withinSpecialistCeiling(tool.capabilityId, tool.verb)))
    throw new ToolCatalogueError("TOOL_OUTSIDE_CEILING");
  const rows: Current_CapabilityVerbs[] = [];
  for (const row of specialistCeiling) {
    const verbs = (row.verbs as readonly PermissionVerb[]).filter((verb) =>
      pairs.some((tool) => tool.capabilityId === row.capabilityId && tool.verb === verb),
    );
    if (verbs.length) rows.push(Object.freeze({ capabilityId: row.capabilityId, verbs }));
  }
  if (rows.length > generatedSpecialistCeiling.maxCapabilities)
    throw new ToolCatalogueError("TOOL_OUTSIDE_CEILING");
  return Object.freeze(rows);
}
