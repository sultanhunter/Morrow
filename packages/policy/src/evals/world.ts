// The eval world's fixed data, version 2 (ADR-0041; harness plan row H18): the agents, the
// tools each run is offered (tool catalogue version 4, item 24), the safety profile (item 18's
// check-ins and detectors and item 12's per-turn calls), the context policy's seeds (item 12)
// and the fake wallet (item 9). Pure data and checks; the replay (replay.ts) runs a case in it.
//
// What version 2 removed (item 3, "safety never ends work early"): the turn limits (6 for
// Morrow, 16 for a teammate) and the final turn with no tools; the 4-calls-per-turn rule
// (16 calls run per turn, extras answered `parallel_limit` and re-issued next turn); the
// 40-calls-per-run rule (a check-in at 10,000 calls parks the job); the final-turn reserve and
// `credits_exhausted` (an empty wallet parks the whole job until a top-up, item 9); and an
// unoffered or invalid tool_use ending the run (it gets an error result, item 8).
//
// Everything here is a fake for the replay: the safety values are ADR-0041's seeds, which the
// catalogue may tune with evidence; the credit prices are invented round numbers (rate card v1
// is not published, ADR-0039 item 3). Nothing here is a money cap: the wallet's balance is the
// only spend limit (ADR-0039 item 1, OD-2026-10-26-12).
import { fakeIds } from "../agent-platform-fakes";
import {
  checkToolInput,
  isAgentTool,
  isContextTool,
  offeredTools,
  toolEntry,
  type ToolContext,
  type ToolEntry,
} from "../tool-catalogue";
import type { EvalAgentRef, EvalArm, EvalTeammateRef } from "./format";

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
 * The grant tools each first-party teammate's package declares in the eval world (provisional:
 * the launch packages are build order PRs 22 to 25). Context tools (memory and harness) are
 * never declared: every run gets its context's set. A teammate never holds an `agent.*` tool
 * (ADR-0037 item 2, depth 1).
 */
export const evalTeammateTools: Readonly<Record<EvalTeammateRef, readonly string[]>> =
  Object.freeze({
    listings: Object.freeze([
      "knowledge.search",
      "products.read",
      "message.post",
      "inbox.ask",
      "suggestion.create",
      "proposal.listing",
      "notebook.write",
    ]),
    business_analyst: Object.freeze([
      "knowledge.search",
      "products.read",
      "orders.summary",
      "message.post",
      "inbox.ask",
      "suggestion.create",
      "report.write",
      "notebook.write",
    ]),
    inventory: Object.freeze([
      "products.read",
      "inventory.read",
      "orders.summary",
      "message.post",
      "inbox.ask",
      "suggestion.create",
      "notebook.write",
    ]),
    support: Object.freeze([
      "knowledge.search",
      "support.thread.read",
      "message.post",
      "inbox.ask",
      "proposal.reply",
      "notebook.write",
    ]),
  });

/**
 * The kind of a run in the eval world (ADR-0041 item 4's kinds as a case uses them):
 * `conversation`, Morrow's main thread in a person's Ask; `job`, Morrow's job (a project
 * request or a fork of the main thread); `routed`, a teammate's job (asked directly, or a
 * hand-off); `call`, a called teammate (an agent.ask, a follow-up or an agent.map batch);
 * `review`, a review run of a teammate's view verbs (agent.ask with mode review).
 */
export type EvalRunKind = "conversation" | "job" | "routed" | "call" | "review";
export const evalRunContext: Readonly<Record<EvalRunKind, ToolContext>> = Object.freeze({
  conversation: "coordinator",
  job: "coordinator",
  routed: "routed",
  call: "call",
  review: "call",
});

/**
 * What each arm changes in the world. Arms that differ only in a live round (recitation and
 * clearing are prompt and request choices the replay cannot see) change nothing here.
 */
export interface EvalArmRules {
  readonly planTool: boolean;
  readonly mapTool: boolean;
  readonly reviewMode: boolean;
  readonly followUps: boolean;
  readonly asyncCalls: boolean;
}
export function evalArmRules(arm: EvalArm): EvalArmRules {
  return Object.freeze({
    planTool: arm !== "no_plan@1",
    mapTool: arm !== "separate_calls@1",
    reviewMode: arm !== "no_review@1",
    followUps: arm !== "fresh_calls@1",
    asyncCalls: arm !== "sync_calls@1",
  });
}

/**
 * The tools a run is offered, by agent, run kind and arm, in catalogue order. Morrow has no
 * package: its fixed set is the coordinator context's. A teammate gets its declared grant tools
 * intersected with its context's, plus the context's memory and harness tools (ADR-0041 item
 * 24); a review run only the `view` verbs of those, plus memory reads and run.complete.
 */
export function evalOfferedTools(
  agent: EvalAgentRef,
  kind: EvalRunKind,
  arm: EvalArm,
): ReadonlyMap<string, ToolEntry> {
  const rules = evalArmRules(arm);
  const context = evalRunContext[kind];
  let names: readonly string[];
  if (agent === "morrow") {
    if (kind !== "conversation" && kind !== "job") throw Error("EVAL_WORLD_KIND");
    names = offeredTools("coordinator", null);
  } else {
    if (kind === "conversation" || kind === "job") throw Error("EVAL_WORLD_KIND");
    names = offeredTools(context, [...evalTeammateTools[agent]]);
    if (kind === "review")
      names = names.filter((name) => {
        const entry = toolEntry(name)!;
        return isContextTool(name)
          ? ["memory.search", "memory.read", "run.complete"].includes(name)
          : entry.verb === "view";
      });
  }
  const kept = names.filter(
    (name) => (rules.planTool || name !== "run.plan") && (rules.mapTool || name !== "agent.map"),
  );
  return new Map(kept.map((name) => [name, toolEntry(name)!]));
}

// Drift guards, run once at load: every tool the world serves is in the catalogue, in the
// context it is served in, and no teammate is ever offered an agent.* tool.
{
  for (const [agent, tools] of Object.entries(evalTeammateTools)) {
    for (const tool of tools)
      if (!toolEntry(tool) || isContextTool(tool) || isAgentTool(tool))
        throw Error("EVAL_WORLD_DRIFT:" + agent + ":" + tool);
    for (const kind of ["routed", "call", "review"] as const)
      for (const name of evalOfferedTools(agent as EvalTeammateRef, kind, "harness@1").keys())
        if (isAgentTool(name)) throw Error("EVAL_WORLD_DRIFT:depth:" + agent);
  }
  if (evalOfferedTools("listings", "call", "harness@1").has("message.post"))
    throw Error("EVAL_WORLD_DRIFT:call_post");
}

/**
 * The safety profile (AgentRunSafety@1's seeds, ADR-0041 items 12 and 18). Backstops and
 * detectors park the job with a check-in; none ends it. Catalogue values, tuned by evidence.
 */
export interface EvalSafetyProfile {
  /** Calls run per turn; extras are answered `parallel_limit` and re-issued next turn. */
  readonly toolCallsPerTurn: number;
  readonly checkIns: {
    readonly modelTurns: number;
    readonly toolCalls: number;
    /** The kernel's children per envelope (ADR-0041 item 21). */
    readonly children: number;
  };
  readonly detectors: {
    readonly repeat: { readonly nudge: number; readonly trip: number };
    readonly errorStreak: { readonly nudge: number; readonly trip: number };
    readonly idleTurns: number;
    readonly alternationSteps: number;
    readonly outputCuts: number;
  };
}
export const evalSafetyProfile: EvalSafetyProfile = Object.freeze({
  toolCallsPerTurn: 16,
  checkIns: Object.freeze({ modelTurns: 1000, toolCalls: 10000, children: 32 }),
  detectors: Object.freeze({
    repeat: Object.freeze({ nudge: 3, trip: 4 }),
    errorStreak: Object.freeze({ nudge: 3, trip: 5 }),
    idleTurns: 3,
    alternationSteps: 8,
    outputCuts: 3,
  }),
});

/** ContextPolicy v1's seeds the world uses (ADR-0041 item 12). */
export const evalContextPolicy = Object.freeze({
  workingWindow: 200_000,
  compactAtShare: 0.8,
  /** A compaction must cut at least 40% (the progress guard). */
  progressGuardShare: 0.4,
});

/**
 * The fake wallet (ADR-0041 item 9; ADR-0039). Metered use in micro-credits. Before each send a
 * turn holds the broker's input estimate at the input rate (the previous response's usage, or
 * `openingTokens` for a context's or an epoch's first send, which code renders) and
 * `max_tokens` (32,000 at `medium`, 64,000 at `high`, item 8) at the output rate. After it, the
 * metered use is drawn while the wallet covers it and otherwise absorbed as Morrow's own cost;
 * only a booking above any possible worst case (more output than `max_tokens`) is
 * `cost_budget`. When a hold cannot be covered, the whole job parks on credits and resumes on a
 * top-up; nothing is drawn while parked. A failed ending caused by Morrow or the provider is
 * refunded at settlement (OD-2026-10-26-2). Prices are invented; the replay never reads a
 * recorded turn to size a hold.
 */
export interface EvalWalletRules {
  readonly microCreditsPerToken: { readonly input: number; readonly output: number };
  readonly maxTokens: { readonly medium: number; readonly high: number };
  readonly openingTokens: number;
}
export const evalWalletRules: EvalWalletRules = Object.freeze({
  microCreditsPerToken: Object.freeze({ input: 1000, output: 5000 }),
  maxTokens: Object.freeze({ medium: 32_000, high: 64_000 }),
  openingTokens: 4000,
});
export const microPerCredit = 1_000_000;
/** ADR-0041 item 2: Morrow at `high`, every other agent at `medium`. */
export const evalEffort = (agent: EvalAgentRef): "medium" | "high" =>
  agent === "morrow" ? "high" : "medium";

/** The tool-call step's full input check (ADR-0027 item 2): catalogue version 4's definitions. */
export function evalInputValid(tool: string, input: unknown): boolean {
  return checkToolInput(tool, input).ok;
}

/**
 * The code's claim screen on model-written text (ADR-0041 item 13): a summary, checkpoint or
 * reply that says an approval, a consent, an apply or a payment happened. The eval world's
 * stand-in for H7d's validator, which also compares stated states with SQL.
 */
const claimPattern =
  /\b(?<!\bnot )(?<!n't )(?:owner|person|they|she|he|it|was|were|been|has|have|had|is|are|already)\s+(?:already\s+)?(?:approved|consented|applied|paid)\b|\b(?<!\bnot )approved by\b|\bapproval (?:was |has been |is )?(?:given|granted|received)\b|\bgo-ahead\b/i;
export function evalClaimsApproval(text: string): boolean {
  return claimPattern.test(text);
}
