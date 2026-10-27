// The context policy (ContextPolicy@1; ADR-0041 items 10 to 12; harness contracts, H6): the
// rows of docs/decisions/context-policy.json as generated, a row's selection by version, model
// and effort, and the token thresholds the context engine (H7d) and the broker's hard guard use.
// Pure data and arithmetic: no I/O, clock or randomness. Version 1 is proposed, so no version is
// active and activeContextPolicyRow answers null: admission refuses version_unknown until one
// reviewed commit activates a version with its eval record (ADR-0041 item 37).
import type { Current_ContextPolicy, Current_ContextScope } from "@morrow/contracts";
import { generatedContextPolicy } from "./generated/context-policy";

export type ContextPolicyRow = Current_ContextPolicy & { readonly digest: string };
export type ContextPolicyStatus = "proposed" | "active" | "retired";

const versions = generatedContextPolicy.versions as unknown as readonly {
  readonly version: number;
  readonly status: ContextPolicyStatus;
  readonly evalRecord: string | null;
  readonly rows: readonly ContextPolicyRow[];
}[];

/** The active version, or null while none is active (version 1 is proposed). */
export const activeContextPolicyVersion: number | null = generatedContextPolicy.activeVersion as
  | number
  | null;

/** A version's status, or null for an unknown version. */
export function contextPolicyStatus(version: number): ContextPolicyStatus | null {
  return versions.find((entry) => entry.version === version)?.status ?? null;
}

/** One row by version, model and effort, or null (an unknown row refuses admission). */
export function contextPolicyRow(
  version: number,
  model: string,
  effort: string,
): ContextPolicyRow | null {
  const entry = versions.find((v) => v.version === version);
  return entry?.rows.find((row) => row.model === model && row.effort === effort) ?? null;
}

/** The active version's row for a model and effort, or null while no version is active. */
export function activeContextPolicyRow(model: string, effort: string): ContextPolicyRow | null {
  return activeContextPolicyVersion === null
    ? null
    : contextPolicyRow(activeContextPolicyVersion, model, effort);
}

/** The thresholds one row sets, in tokens (shares of W floored to whole tokens). */
export interface ContextThresholds {
  readonly workingWindowTokens: number;
  readonly clearFromTokens: number;
  readonly minimumClearTokens: number;
  readonly compactAtTokens: number;
  readonly backgroundCompactFromTokens: number | null;
  readonly newEpochTargetTokens: number;
  readonly keptTailTokens: number;
  readonly ledgerTokens: number;
  readonly checkpointTokens: number;
  readonly fixedOpeningTokens: number;
  readonly perTurnResultTokens: number;
  readonly inlineResultTokens: number;
  readonly previewTokens: number;
  /** input plus max_tokens above this is refused input_over_cap, non-terminal (ADR-0041 item 8). */
  readonly hardGuardTokens: number;
}

const share = (basisPoints: number, window: number): number =>
  Math.floor((basisPoints * window) / 10000);

export function contextThresholds(row: Current_ContextPolicy): ContextThresholds {
  const W = row.workingWindowTokens;
  const o = row.opening;
  return Object.freeze({
    workingWindowTokens: W,
    clearFromTokens: share(row.clear.fromBasisPoints, W),
    minimumClearTokens: share(row.clear.minimumBasisPoints, W),
    compactAtTokens: share(row.compact.atBasisPoints, W),
    backgroundCompactFromTokens:
      row.compact.backgroundFromBasisPoints === null
        ? null
        : share(row.compact.backgroundFromBasisPoints, W),
    newEpochTargetTokens: share(row.newEpoch.targetBasisPoints, W),
    keptTailTokens: share(row.newEpoch.keptTailBasisPoints, W),
    ledgerTokens: share(o.ledgerBasisPoints, W),
    checkpointTokens: share(o.checkpointBasisPoints, W),
    fixedOpeningTokens:
      o.factsTokens +
      o.teammatesTokens +
      o.pinnedKnowledgeTokens +
      o.personMemoryTokens +
      o.knowledgeIndexTokens +
      o.notebookIndexTokens +
      o.conversationSummariesTokens,
    perTurnResultTokens: share(row.results.perTurnBasisPoints, W),
    inlineResultTokens: row.results.inlineTokens,
    previewTokens: row.results.previewTokens,
    hardGuardTokens: share(row.hardGuardBasisPoints, row.modelWindowTokens),
  });
}

/** What the context engine does before a send, given the estimated input (ADR-0041 item 11). */
export type ContextStep = "send" | "clear" | "compact" | "refuse_input_over_cap";

/**
 * The reduction ladder's decision for one send: compact at the threshold (before the send),
 * else clear from its start (provider strategy only; the fallback has no server clearing), else
 * send. A send whose input plus max_tokens passes the hard guard is refused input_over_cap,
 * which is never terminal: it forces compaction.
 */
export function contextStep(
  row: Current_ContextPolicy,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  providerStrategy: boolean,
): ContextStep {
  if (
    !Number.isInteger(estimatedInputTokens) ||
    estimatedInputTokens < 0 ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1
  )
    throw new RangeError("CONTEXT_STEP_INPUT_INVALID");
  const t = contextThresholds(row);
  if (estimatedInputTokens + maxOutputTokens > t.hardGuardTokens) return "refuse_input_over_cap";
  if (estimatedInputTokens >= t.compactAtTokens) return "compact";
  if (providerStrategy && estimatedInputTokens >= t.clearFromTokens) return "clear";
  return "send";
}

/** The cache lifetimes of one context scope, for the context's whole life (ADR-0041 item 10). */
export function cacheTtls(
  row: Current_ContextPolicy,
  scope: Current_ContextScope,
): { readonly system: "5m" | "1h"; readonly rest: "5m" | "1h" } {
  return row.cache[scope];
}
