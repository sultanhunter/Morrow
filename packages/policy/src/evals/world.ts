// The eval world's fixed data (ADR-0037 item 10): the agents, the tools each design offers
// them, the run limits and the fake wallet's prices. Pure data and checks; the replay
// (replay.ts) runs a case in it. Everything here is a fake for the replay: the run limits
// are catalogue version 2's proposed values (ADR-0027 item 6; ADR-0039 item 5), and the
// credit prices are invented round numbers, since rate card v1 is not published (ADR-0039
// item 3). Nothing here is a money cap: the wallet's balance is the only spend limit
// (ADR-0039 item 1).
import { fakeIds } from "../agent-platform-fakes";
import { checkToolInput, offeredTools, toolEntry, toolsForContext } from "../tool-catalogue";
import type { EvalAgentRef, EvalDesign, EvalTeammateRef, EvalToolName } from "./format";
import { evalCatalogueTools } from "./format";

/** Each teammate's installation id in the eval world (synthetic, as agent-platform-fakes'). */
export const evalInstallationIds: Readonly<Record<EvalTeammateRef, string>> = Object.freeze({
  listings: fakeIds.listingsInstallationId,
  business_analyst: "inst_business_analyst",
  inventory: "inst_inventory",
  support: fakeIds.supportInstallationId,
});
export function teammateByInstallationId(id: unknown): EvalTeammateRef | null {
  for (const [agent, installationId] of Object.entries(evalInstallationIds))
    if (installationId === id) return agent as EvalTeammateRef;
  return null;
}

/**
 * The tools each first-party teammate's package declares in the eval world (provisional:
 * the launch packages are build order PRs 22 to 25). A teammate never holds an `agent.*`
 * tool (ADR-0037 item 2, depth 1).
 */
export const evalTeammateTools: Readonly<Record<EvalTeammateRef, readonly EvalToolName[]>> =
  Object.freeze({
    listings: Object.freeze([
      "knowledge.search",
      "products.read",
      "message.post",
      "suggestion.create",
      "proposal.listing",
    ] as const),
    business_analyst: Object.freeze([
      "knowledge.search",
      "products.read",
      "orders.summary",
      "message.post",
      "suggestion.create",
      "report.write",
    ] as const),
    inventory: Object.freeze([
      "products.read",
      "inventory.read",
      "orders.summary",
      "message.post",
      "suggestion.create",
    ] as const),
    support: Object.freeze([
      "knowledge.search",
      "support.thread.read",
      "message.post",
      "proposal.reply",
    ] as const),
  });

/**
 * How a tool is served: from the tool catalogue, a provisional ADR-0037 shape, or
 * `catalogue_v2`: catalogue version 2's one-way `agent.route` (a string brief of at most
 * 2,000 characters, once per run), which handoff_only@1 replays. Catalogue version 4 (ADR-0037's
 * contracts) replaced that input with a structured brief, so the world keeps its shape here.
 */
export type EvalToolSource = "catalogue" | "provisional" | "catalogue_v2";
export interface EvalToolSpec {
  readonly name: EvalToolName;
  readonly source: EvalToolSource;
  readonly capabilityId: string;
  readonly verb: string;
}
const catalogueSpec = (name: EvalToolName): EvalToolSpec => {
  const entry = toolEntry(name);
  if (!entry) throw Error("EVAL_WORLD_TOOL_UNKNOWN:" + name);
  return Object.freeze({
    name,
    source: "catalogue",
    capabilityId: entry.capabilityId,
    verb: entry.verb,
  });
};
const provisionalSpecs: Readonly<Record<string, EvalToolSpec>> = Object.freeze({
  // ADR-0037 item 1: `agent.ask` on workspace.task.delegate, like `agent.route`.
  "agent.ask": {
    name: "agent.ask",
    source: "provisional",
    capabilityId: "workspace.task.delegate",
    verb: "delegate",
  },
  // ADR-0037 item 3: `agent.route` with a structured brief and no once-per-run limit.
  "agent.route": {
    name: "agent.route",
    source: "provisional",
    capabilityId: "workspace.task.delegate",
    verb: "delegate",
  },
  // ADR-0037 item 1 names no capability for it ("grants nothing else"); a read here.
  "agent.result.read": {
    name: "agent.result.read",
    source: "provisional",
    capabilityId: "workspace.artifact.read",
    verb: "view",
  },
  // ADR-0037 item 1: `agent.propose` on agents.builder.describe, granting nothing.
  "agent.propose": {
    name: "agent.propose",
    source: "provisional",
    capabilityId: "agents.builder.describe",
    verb: "execute",
  },
});

// handoff_only@1's hand-off: catalogue version 2's agent.route, on the same capability and verb.
const handoffOnlyRoute: EvalToolSpec = Object.freeze({
  name: "agent.route",
  source: "catalogue_v2",
  capabilityId: "workspace.task.delegate",
  verb: "delegate",
});

const morrowCatalogueTools = [
  "knowledge.search",
  "work.read",
  "message.post",
  "task.create",
] as const;
/** The tools a run is offered, by agent, run kind and design. */
export type EvalRunKind = "coordinator" | "routed" | "called";
export function evalOfferedTools(
  agent: EvalAgentRef,
  kind: EvalRunKind,
  design: EvalDesign,
): ReadonlyMap<string, EvalToolSpec> {
  const specs: EvalToolSpec[] = [];
  if (agent === "morrow") {
    if (kind !== "coordinator") throw Error("EVAL_WORLD_KIND");
    specs.push(...morrowCatalogueTools.map(catalogueSpec));
    if (design === "teammates@1")
      specs.push(
        provisionalSpecs["agent.route"]!,
        provisionalSpecs["agent.ask"]!,
        provisionalSpecs["agent.result.read"]!,
        provisionalSpecs["agent.propose"]!,
      );
    else specs.push(handoffOnlyRoute);
  } else {
    if (kind === "coordinator") throw Error("EVAL_WORLD_KIND");
    // A called teammate cannot talk to the person (ADR-0037 item 3(a)): no posts or questions.
    const declared = evalTeammateTools[agent].filter(
      (tool) => kind === "routed" || tool !== "message.post",
    );
    specs.push(...declared.map(catalogueSpec));
  }
  return new Map(specs.map((spec) => [spec.name as string, spec]));
}
// Drift guards, run once at load: every catalogue tool the world serves is in the catalogue
// with the context it is served in, so a catalogue change cannot silently widen what an eval
// agent is offered.
{
  const coordinator = toolsForContext("coordinator") as readonly string[];
  for (const tool of [...morrowCatalogueTools, "agent.route"])
    if (!coordinator.includes(tool)) throw Error("EVAL_WORLD_DRIFT:coordinator:" + tool);
  // handoff_only@1's fixed hand-off keeps the catalogue's capability and verb for agent.route.
  const route = toolEntry("agent.route");
  if (route?.capabilityId !== handoffOnlyRoute.capabilityId || route.verb !== handoffOnlyRoute.verb)
    throw Error("EVAL_WORLD_DRIFT:agent.route");
  for (const [agent, tools] of Object.entries(evalTeammateTools)) {
    if (offeredTools("routed", [...tools]).length !== tools.length)
      throw Error("EVAL_WORLD_DRIFT:routed:" + agent);
    if (tools.some((tool) => !(evalCatalogueTools as readonly string[]).includes(tool)))
      throw Error("EVAL_WORLD_DRIFT:catalogue:" + agent);
  }
}

/** Run limits: catalogue version 2's proposed values (ADR-0027 item 6, ADR-0039 item 5). */
export const evalRunLimits = Object.freeze({
  turns: Object.freeze({ morrow: 6, teammate: 16 }),
  toolCallsPerTurn: 4,
  toolCallsPerRun: 40,
  /** The delegation kernel's bound (`maximumChildren`), unchanged by ADR-0037 item 3. */
  childrenPerEnvelope: 32,
});

/**
 * The fake wallet (ADR-0039 item 2). Whole credits; metered use in micro-credits. Prices are
 * invented for the replay. The two readings still open with the owner
 * (Q-adr-0039-carried-out-values) are built as proposed and switchable here: the final-turn
 * reserve (items 2(d), 2(e)) and failed runs drawing their metered use (item 2(g)).
 */
export interface EvalWalletRules {
  readonly worstCaseTurnCredits: { readonly morrow: number; readonly teammate: number };
  readonly microCreditsPerToken: { readonly input: number; readonly output: number };
  readonly finalTurnReserve: boolean;
  readonly failedRunsDraw: boolean;
}
export const evalWalletRules: EvalWalletRules = Object.freeze({
  worstCaseTurnCredits: Object.freeze({ morrow: 10, teammate: 8 }),
  microCreditsPerToken: Object.freeze({ input: 500, output: 2500 }),
  finalTurnReserve: true,
  failedRunsDraw: true,
});
export const microPerCredit = 1_000_000;

// --- Tool inputs --------------------------------------------------------------------------
/**
 * One recorded call's input check, as the loop makes it (ADR-0027 item 2): `shape` is the
 * strict shape the model is given (types, enums, required keys, closed objects): outside it
 * the reply is invalid output, which ends the run. `limits` is the full definition: a breach
 * is that call's invalid_input. Catalogue tools use catalogue version 2's definitions; the
 * provisional tools their working shapes below.
 */
export type EvalInputCheck = "ok" | "shape" | "limits";
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
function briefCheck(value: unknown): EvalInputCheck {
  if (!isObject(value) || !exactKeys(value, ["installationId", "brief"])) return "shape";
  const brief = value.brief;
  if (typeof value.installationId !== "string" || !isObject(brief)) return "shape";
  if (!exactKeys(brief, ["objective", "recordIds", "fields"])) return "shape";
  if (typeof brief.objective !== "string" || !strings(brief.recordIds)) return "shape";
  const fields = brief.fields;
  if (
    !Array.isArray(fields) ||
    !fields.every(
      (f) =>
        isObject(f) &&
        exactKeys(f, ["name", "value"]) &&
        typeof f.name === "string" &&
        typeof f.value === "string",
    )
  )
    return "shape";
  // ADR-0037 item 3(a): structured, with no character cap on the objective or a field.
  const fieldNames = (fields as { name: string }[]).map((f) => f.name);
  if (
    !/^inst_[a-z][a-z0-9_]{1,40}$/.test(value.installationId) ||
    brief.objective.length < 1 ||
    brief.recordIds.length > 64 ||
    new Set(brief.recordIds).size !== brief.recordIds.length ||
    brief.recordIds.some((id) => id.length < 1 || id.length > 64) ||
    fields.length > 32 ||
    new Set(fieldNames).size !== fieldNames.length ||
    fieldNames.some((name) => !/^[a-z][a-z0-9_]{0,31}$/.test(name))
  )
    return "limits";
  return "ok";
}
function resultReadCheck(value: unknown): EvalInputCheck {
  if (!isObject(value) || !exactKeys(value, ["itemId", "page"])) return "shape";
  if (typeof value.itemId !== "string" || typeof value.page !== "number") return "shape";
  if (!Number.isInteger(value.page)) return "shape";
  if (!/^item_[a-z0-9_-]{1,59}$/.test(value.itemId) || value.page < 1 || value.page > 1000)
    return "limits";
  return "ok";
}
/** Catalogue version 2's agent.route input: an Id and a string brief of 1 to 2,000 characters. */
function handoffRouteCheck(value: unknown): EvalInputCheck {
  if (!isObject(value) || !exactKeys(value, ["installationId", "brief"])) return "shape";
  if (typeof value.installationId !== "string" || typeof value.brief !== "string") return "shape";
  const length = [...value.brief].length;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.installationId) ||
    length < 1 ||
    length > 2000 ||
    !/\S/.test(value.brief)
  )
    return "limits";
  return "ok";
}
/** ADR-0037 item 5: never on a card: `agent.*`, `workspace.task.delegate` or human-only. */
const cardTools: readonly string[] = evalCatalogueTools.filter((tool) => tool !== "agent.route");
function proposeCheck(value: unknown): EvalInputCheck {
  const keys = ["name", "purpose", "instructions", "tools", "skillIds"];
  if (!isObject(value) || !exactKeys(value, keys)) return "shape";
  const { name, purpose, instructions, tools, skillIds } = value;
  if (typeof name !== "string" || typeof purpose !== "string" || typeof instructions !== "string")
    return "shape";
  if (!strings(tools) || !strings(skillIds)) return "shape";
  if (
    name.length < 1 ||
    name.length > 60 ||
    purpose.length < 1 ||
    purpose.length > 300 ||
    instructions.length < 1 ||
    tools.length < 1 ||
    tools.length > 16 ||
    new Set(tools).size !== tools.length ||
    tools.some((tool) => !cardTools.includes(tool)) ||
    skillIds.length > 8
  )
    return "limits";
  return "ok";
}
export function checkEvalToolInput(spec: EvalToolSpec, input: unknown): EvalInputCheck {
  if (spec.source === "catalogue") return checkToolInput(spec.name, input).ok ? "ok" : "limits";
  if (spec.source === "catalogue_v2") return handoffRouteCheck(input);
  if (spec.name === "agent.ask" || spec.name === "agent.route") return briefCheck(input);
  if (spec.name === "agent.result.read") return resultReadCheck(input);
  return proposeCheck(input);
}
