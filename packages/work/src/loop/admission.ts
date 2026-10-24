import type {
  Current_AgentRunManifest,
  Current_PlanStepRun,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { defaultLoopProfile, loopEntry, type LoopEntry } from "@morrow/policy/loop-catalogue";
import { routedSystemTextDigest } from "@morrow/policy/loop-prompts";
import {
  offeredTools,
  toolCatalogueDigest,
  toolCatalogueVersion,
} from "@morrow/policy/tool-catalogue";
import type { StepRunIntent } from "@morrow/policy/projects";
import { agentLoopOn, agentLoopVar } from "../../../identity/src/broker-protocol.js";
import { generatedLoopCatalogue } from "../../../policy/src/generated/loop-catalogue.js";
import { canonicalJson } from "../digest.js";

// Agent-run admission in code (ADR-0027 items 1, 6, 9 and 12), the part the api composes
// before cmd_agent_run_admit, which derives the same caps and hold itself and refuses a
// manifest that differs (its CHECK proves the canonical text is exactly the run's). While
// the agent-loop switch (docs/decisions/agent-loop-staging.json, committed off) is off,
// nothing here is reached: admission answers switch_off before any statement, and the plan
// start's agent and specialist steps stay not_started with agent_loop_off.

/** The agent-loop switch as the Workers compose it (the var MORROW_AGENT_LOOP, exactly "on"). */
export type AgentLoopSwitch = "on" | "off";
/** The switch of an environment record: on only for exactly "on" (anything else is off). */
export function agentLoopSwitchOf(env: unknown): AgentLoopSwitch {
  if (env === null || typeof env !== "object") return "off";
  const descriptor = Object.getOwnPropertyDescriptor(env, agentLoopVar);
  return descriptor && "value" in descriptor && descriptor.value === agentLoopOn ? "on" : "off";
}

/** The caps and the hold of a routed run, exactly as cmd_agent_run_admit derives them. */
export interface RoutedRunCaps {
  readonly turnLimit: number;
  readonly holdUsd: string;
  readonly worstCaseTurnUsd: string;
  readonly maxToolCallsPerTurn: number;
  readonly maxToolCallsPerRun: number;
  readonly maxQuestions: number;
  readonly maxInputTokensPerTurn: number;
  readonly maxOutputTokensPerTurn: number;
  readonly wallTimeSeconds: number;
}
// 10^-12 USD as numeric(20,8) text, rounded up (the SQL entry's worst case is rounded up).
const usd8Up = (units: bigint) => (units + 9_999n) / 10_000n;
const usdText = (usd8: bigint) =>
  `${usd8 / 100_000_000n}.${String(usd8 % 100_000_000n).padStart(8, "0")}`;
/**
 * A routed run's caps (ADR-0027 items 6 and 12): the version's turn limit lowered so that it
 * times the entry's worst-case turn (rounded up to the cent's millionth, as SQL stores it)
 * fits the run backstop; the hold the lower of that product and the backstop; a routed run
 * must afford one turn (cap_below_turn otherwise). The limits are the version's.
 */
export function routedRunCaps(entry: LoopEntry): RoutedRunCaps | "cap_below_turn" {
  const limits = loopLimits(entry.catalogueVersion);
  const worst8 = usd8Up(entry.worstCaseTurnUsd12);
  const cap8 = BigInt(limits.runCostCapUsd12) / 10_000n;
  if (worst8 <= 0n) return "cap_below_turn";
  const turnLimit = Math.min(limits.maxTurnsPerRun, Number(cap8 / worst8));
  const hold8 = BigInt(turnLimit) * worst8 < cap8 ? BigInt(turnLimit) * worst8 : cap8;
  if (turnLimit < 1 || hold8 < worst8) return "cap_below_turn";
  return Object.freeze({
    turnLimit,
    holdUsd: usdText(hold8),
    worstCaseTurnUsd: usdText(worst8),
    maxToolCallsPerTurn: limits.maxToolCallsPerTurn,
    maxToolCallsPerRun: limits.maxToolCallsPerRun,
    maxQuestions: limits.maxQuestionsPerRun,
    maxInputTokensPerTurn: limits.maxInputTokensPerTurn,
    maxOutputTokensPerTurn: entry.maxOutputTokens,
    wallTimeSeconds: limits.wallTimeMinutes * 60,
  });
}
function loopLimits(version: number) {
  const v = generatedLoopCatalogue.versions.find((x) => x.version === version);
  if (!v) throw Error("LOOP_VERSION_UNKNOWN");
  return v.limits;
}

/**
 * The tools a routed run is offered (ADR-0027 item 3): the release's declared tools within
 * the routed context, and only those this build can dispatch, in catalogue order (a stable
 * cached prefix). A skill never adds a tool.
 */
export function routedTools(
  declared: readonly string[],
  available: readonly string[],
): readonly string[] {
  return Object.freeze(offeredTools("routed", declared).filter((t) => available.includes(t)));
}

export interface RoutedManifestInput {
  readonly runId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string;
  readonly connectionId: string;
  /** The child task T' the run works on. */
  readonly childTaskId: string;
  readonly installationId: string;
  readonly requester: { readonly principalId: string; readonly membershipId: string };
  readonly release: { readonly id: string; readonly revision: number; readonly digest: string };
  readonly tools: readonly string[];
  /** ModelProfile@1: an installation's model and effort (its kind's default until PR 12). */
  readonly profile: { readonly model: string; readonly effort: string; readonly catalogueVersion: number };
  /** The database time admission reads first (ms precision). */
  readonly admittedAt: string;
}
/**
 * A routed run's AgentRunManifest@1 and its RFC 8785 text, validated with the generated
 * contract: ids, digests, codes, caps and the hold only (no content). Refused: an entry the
 * catalogue lacks (entry_not_offered), caps below one turn (cap_below_turn), no tool.
 */
export function routedManifest(
  input: RoutedManifestInput,
):
  | { readonly ok: true; readonly manifest: Current_AgentRunManifest; readonly canonical: string; readonly caps: RoutedRunCaps }
  | { readonly ok: false; readonly code: "entry_not_offered" | "cap_below_turn" | "no_tools" | "invalid" } {
  const entry = loopEntry(input.profile.catalogueVersion, input.profile.model, input.profile.effort);
  if (!entry) return Object.freeze({ ok: false as const, code: "entry_not_offered" as const });
  const caps = routedRunCaps(entry);
  if (caps === "cap_below_turn") return Object.freeze({ ok: false as const, code: caps });
  if (input.tools.length === 0) return Object.freeze({ ok: false as const, code: "no_tools" as const });
  const manifest = {
    schemaVersion: 1,
    workflow: "agent-run@1",
    runId: input.runId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    connectionId: input.connectionId,
    kind: "routed",
    taskId: input.childTaskId,
    installationId: input.installationId,
    mandateId: null,
    triggerId: null,
    requester: {
      kind: "human",
      principalId: input.requester.principalId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      membershipId: input.requester.membershipId,
      installationId: null,
      mandateId: null,
    },
    release: { ...input.release },
    systemTextDigest: routedSystemTextDigest,
    toolCatalogueVersion,
    toolCatalogueDigest,
    tools: [...input.tools],
    modelProfile: { ...input.profile },
    caps: {
      maxTurns: caps.turnLimit,
      maxToolCallsPerTurn: caps.maxToolCallsPerTurn,
      maxToolCallsPerRun: caps.maxToolCallsPerRun,
      maxQuestions: caps.maxQuestions,
      maxInputTokensPerTurn: caps.maxInputTokensPerTurn,
      maxOutputTokensPerTurn: caps.maxOutputTokensPerTurn,
      wallTimeSeconds: caps.wallTimeSeconds,
      deadline: null,
      holdUsd: caps.holdUsd,
    },
    specDigest: null,
    dataClasses: null,
    admittedAt: input.admittedAt,
  };
  if (!validateCurrentDefinition("AgentRunManifest", manifest))
    return Object.freeze({ ok: false as const, code: "invalid" as const });
  return Object.freeze({
    ok: true as const,
    manifest: manifest as Current_AgentRunManifest,
    canonical: canonicalJson(manifest),
    caps,
  });
}
/** An installed agent's default model profile in a loop version (ADR-0027 item 12). */
export function installedProfile(catalogueVersion: number) {
  return Object.freeze({ ...defaultLoopProfile(catalogueVersion, "installed"), catalogueVersion });
}

/**
 * The seam the plan start admits its agent and specialist steps through (ADR-0034 item 6;
 * PR 18's planStepRuns). While the agent-loop switch is off it admits nothing: every step
 * that would start a run is not_started with agent_loop_off, exactly what the start
 * reports today. With the switch on, each intent is one admission of its own (a refusal
 * leaves that step not_started with its reason); the admitter that does so is the Ask's
 * (PR 12) and Listings on the runner's, behind the same switch.
 */
export interface PlanStepAdmitter {
  readonly agentLoop: AgentLoopSwitch;
  admit(intents: readonly StepRunIntent[]): Promise<readonly Current_PlanStepRun[]>;
}
export const planStepAdmitterOff: PlanStepAdmitter = Object.freeze({
  agentLoop: "off" as const,
  async admit(intents: readonly StepRunIntent[]): Promise<readonly Current_PlanStepRun[]> {
    return Object.freeze(
      intents.map((i) =>
        Object.freeze({ stepKey: i.stepKey, status: "not_started" as const, reason: "agent_loop_off" }),
      ),
    );
  },
});
