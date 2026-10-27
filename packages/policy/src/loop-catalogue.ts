// The agent-loop catalogue rules (PR 10; ADR-0027 items 6 and 12, ADR-0026 item 4). Pure: no
// I/O, clock or randomness. The data is generated from the loop versions of
// docs/decisions/model-policy.json (scripts/generate-model-catalogue.mjs). Every amount is an
// exact bigint count of 10^-12 USD; a record converts it to numeric(20,8) text, rounding a
// hold up.
//
// - A worst-case turn is the input cap at the 5-minute cache-write rate (the dearest input
//   rate; only the fixed prefix is cached) plus the effort's whole max_tokens at the output
//   rate. An expected turn reads the 12,000-token prefix from the cache, except the first,
//   which writes it.
// - A run's turn limit is its kind's (6 for the Coordinator, 16 otherwise). ADR-0039 item 5:
//   no money value lowers it (it was lowered so that it times the worst-case turn fit the
//   US$7 run backstop, which ADR-0039 removed with the daily backstop and the look-for-work
//   cap; loop version 2 carries none of them).
// - Until ADR-0039 PR 2 replaces these rules with credit holds, a run holds the lower of its
//   turn limit times its worst-case turn and its credit cap (a specialist's share of the
//   grant, null when the run has none). A run whose hold cannot cover one worst-case turn, or
//   two for a run that must call a tool (a specialist or a mandate run), is not admitted:
//   cap_below_turn. Nothing on main admits a loop run.
// - A turn starts only if the hold left covers it; it is the final turn (tool_choice none)
//   when the hold left cannot also cover a final turn after it (cost_budget) or it is the
//   last the limit allows.
// - A profile is never authority: none of this changes a tool, capability or cap.
import type { Current_AgentRunKind, Current_RunHold } from "@morrow/contracts";
import { modelCallBudgetMs, modelGatewayLimits } from "../../identity/src/broker-protocol.js";
import { generatedLoopCatalogue } from "./generated/loop-catalogue";

export type LoopProfileKind = "coordinator" | "specialist" | "installed";
/**
 * A loop run's kind for holds. "specialist" is no longer an AgentRunKind (ADR-0037 retired the
 * kind; its contracts PR dropped it from agent-run@1): its hold, the 5% credit cap, stays here
 * only until ADR-0039's contracts PR removes the money caps with this module's holds.
 */
export type LoopRunKind = Current_AgentRunKind | "specialist";
export type LoopCatalogueStatus = "active" | "retired" | "proposed";
export interface LoopSelectionKeys {
  readonly model: string;
  readonly effort: string;
}
/** One entry of one loop version: a model at an effort. */
export interface LoopEntry {
  readonly catalogueVersion: number;
  readonly status: LoopCatalogueStatus;
  readonly model: string;
  readonly effort: string;
  readonly maxOutputTokens: number;
  readonly expectedOutputTokens: number;
  readonly worstCaseTurnUsd12: bigint;
  readonly expectedFirstTurnUsd12: bigint;
  readonly expectedTurnUsd12: bigint;
  /** modelCallBudgetMs at the effort's max_tokens (at most 600 s, the non-streaming ceiling). */
  readonly callBudgetMs: number;
}
/** RunHold@1's bindings; `run_backstop` is never produced since ADR-0039 (old records only). */
export type HoldBinding = "turn_limit" | "run_backstop" | "credit_cap";
export type RunHoldResult =
  | {
      readonly ok: true;
      readonly turnLimit: number;
      readonly holdUsd12: bigint;
      readonly binding: HoldBinding;
      readonly toolTurnsRequired: 1 | 2;
      /** How many worst-case turns the hold covers (at most the turn limit). */
      readonly worstCaseTurns: number;
    }
  | { readonly ok: false; readonly code: "cap_below_turn" };
export type NextTurn =
  | {
      readonly start: true;
      readonly final: boolean;
      readonly reason: "turn_limit" | "cost_budget" | null;
    }
  | { readonly start: false; readonly reason: "turn_limit" | "cost_budget" };

export class LoopCatalogueError extends Error {
  constructor(readonly code: "LOOP_CATALOGUE_INPUT_INVALID") {
    super(code);
    this.name = "LoopCatalogueError";
  }
}
const invalid = () => new LoopCatalogueError("LOOP_CATALOGUE_INPUT_INVALID");
const runKinds = ["coordinator", "routed", "mandate", "specialist"];
const usd12 = (value: number) => BigInt(value);
const nonNegative = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n;

type VersionData = (typeof generatedLoopCatalogue.versions)[number];
const versions: readonly VersionData[] = generatedLoopCatalogue.versions;
const versionData = (version: unknown) =>
  typeof version === "number" ? (versions.find((v) => v.version === version) ?? null) : null;

function entryOf(v: VersionData, model: string, effort: string): LoopEntry | null {
  const m = v.models.find((x) => x.key === model);
  const e = v.efforts.find((x) => x.key === effort);
  if (!m || !e) return null;
  const rate = m.usd12PerToken;
  const input = BigInt(v.limits.maxInputTokensPerTurn);
  const worst = input * usd12(rate.cacheWrite) + BigInt(e.maxOutputTokens) * usd12(rate.output);
  const prefix = BigInt(v.expectedTurn.cachedPrefixTokens);
  const rest = BigInt(v.expectedTurn.inputTokens) - prefix;
  const out = BigInt(e.expectedOutputTokens) * usd12(rate.output);
  return Object.freeze({
    catalogueVersion: v.version,
    status: v.status as LoopCatalogueStatus,
    model,
    effort,
    maxOutputTokens: e.maxOutputTokens,
    expectedOutputTokens: e.expectedOutputTokens,
    worstCaseTurnUsd12: worst,
    expectedFirstTurnUsd12: rest * usd12(rate.input) + prefix * usd12(rate.cacheWrite) + out,
    expectedTurnUsd12: rest * usd12(rate.input) + prefix * usd12(rate.cacheRead) + out,
    callBudgetMs: modelCallBudgetMs(e.maxOutputTokens),
  });
}

/** The loop versions, newest last (a proposed one is for previews and tests). */
export function loopVersions(): readonly number[] {
  return versions.map((v) => v.version);
}
/**
 * The loop shape's own active version, or null until one publishes. The per-product pointer
 * (listings-run@1) is the model catalogue's and never names a loop version.
 */
export function activeLoopVersion(): number | null {
  const active: number | null = generatedLoopCatalogue.activeVersion;
  // Widened: the committed data has no active loop version yet.
  const status = versionData(active)?.status as LoopCatalogueStatus | undefined;
  return active !== null && status === "active" ? active : null;
}
/** Every entry of a version, models then efforts in catalogue order. */
export function loopEntries(version: number): readonly LoopEntry[] {
  const v = versionData(version);
  if (!v) return [];
  return Object.freeze(v.models.flatMap((m) => v.efforts.map((e) => entryOf(v, m.key, e.key)!)));
}
/** One entry at any status, or null. Admission uses publishedLoopEntry. */
export function loopEntry(version: number, model: unknown, effort: unknown): LoopEntry | null {
  const v = versionData(version);
  return v && typeof model === "string" && typeof effort === "string"
    ? entryOf(v, model, effort)
    : null;
}
/** One entry of a published (active or retired) version, or null: admission substitutes nothing. */
export function publishedLoopEntry(
  version: number,
  model: unknown,
  effort: unknown,
): LoopEntry | null {
  const entry = loopEntry(version, model, effort);
  return entry && entry.status !== "proposed" ? entry : null;
}
/** The default profile of a kind in a version (ADR-0027 item 12). */
export function defaultLoopProfile(version: number, kind: LoopProfileKind): LoopSelectionKeys {
  const v = versionData(version);
  if (!v || !["coordinator", "specialist", "installed"].includes(kind)) throw invalid();
  const profile = v.defaultProfiles[kind];
  return Object.freeze({ model: profile.model, effort: profile.effort });
}
/** Whether every entry's call budget fits the protocol's 600 s non-streaming ceiling. */
export function callBudgetsFit(version: number): boolean {
  const entries = loopEntries(version);
  return (
    entries.length > 0 && entries.every((e) => e.callBudgetMs <= modelGatewayLimits.budgetMaxMs)
  );
}

function limitsOf(version: number) {
  const v = versionData(version);
  if (!v) throw invalid();
  return v.limits;
}
/** A mandate run (look-for-work included) and a specialist must call a tool: two turns. */
export function toolTurnsRequired(kind: LoopRunKind): 1 | 2 {
  if (!runKinds.includes(kind)) throw invalid();
  return kind === "mandate" || kind === "specialist" ? 2 : 1;
}
/** The kind's turn limit: 6 for the Coordinator, 16 otherwise; no money value lowers it. */
export function turnLimit(entry: LoopEntry, kind: LoopRunKind): number {
  if (!runKinds.includes(kind) || !entry || entry.worstCaseTurnUsd12 <= 0n) throw invalid();
  const limits = limitsOf(entry.catalogueVersion);
  return kind === "coordinator" ? limits.maxTurnsPerCoordinatorRun : limits.maxTurnsPerRun;
}
/**
 * A run's hold (ADR-0026 item 4, without ADR-0039's removed run backstop): the lower of its
 * turn limit times its worst-case turn and its credit cap (null when the run has none), or
 * cap_below_turn. ADR-0039 PR 2 replaces it with the credit hold of each step.
 */
export function runHold(input: {
  readonly entry: LoopEntry;
  readonly kind: LoopRunKind;
  readonly creditCapUsd12: bigint | null;
}): RunHoldResult {
  const { entry, kind, creditCapUsd12 } = input;
  if (creditCapUsd12 !== null && !nonNegative(creditCapUsd12)) throw invalid();
  const limit = turnLimit(entry, kind);
  let hold = BigInt(limit) * entry.worstCaseTurnUsd12;
  let binding: HoldBinding = "turn_limit";
  if (creditCapUsd12 !== null && creditCapUsd12 < hold) {
    hold = creditCapUsd12;
    binding = "credit_cap";
  }
  const required = toolTurnsRequired(kind);
  if (limit < required || hold < BigInt(required) * entry.worstCaseTurnUsd12)
    return Object.freeze({ ok: false, code: "cap_below_turn" });
  const covered = Number(hold / entry.worstCaseTurnUsd12);
  return Object.freeze({
    ok: true,
    turnLimit: limit,
    holdUsd12: hold,
    binding,
    toolTurnsRequired: required,
    worstCaseTurns: Math.min(limit, covered),
  });
}
/**
 * Whether the next turn starts and whether it is the final one (ADR-0027 item 6): it
 * starts only if the hold left covers a worst-case turn and the limit allows one; it is
 * final when it is the last the limit allows or the hold left cannot also cover a final
 * turn after it.
 */
export function nextTurn(input: {
  readonly entry: LoopEntry;
  readonly turnLimit: number;
  readonly turnsTaken: number;
  readonly holdLeftUsd12: bigint;
}): NextTurn {
  const { entry, turnLimit: limit, turnsTaken, holdLeftUsd12 } = input;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16 ||
    !Number.isSafeInteger(turnsTaken) ||
    turnsTaken < 0 ||
    !nonNegative(holdLeftUsd12)
  )
    throw invalid();
  if (turnsTaken >= limit) return Object.freeze({ start: false, reason: "turn_limit" });
  if (holdLeftUsd12 < entry.worstCaseTurnUsd12)
    return Object.freeze({ start: false, reason: "cost_budget" });
  if (turnsTaken + 1 === limit)
    return Object.freeze({ start: true, final: true, reason: "turn_limit" });
  if (holdLeftUsd12 < 2n * entry.worstCaseTurnUsd12)
    return Object.freeze({ start: true, final: true, reason: "cost_budget" });
  return Object.freeze({ start: true, final: false, reason: null });
}
/** The expected cost of a run of n turns: the first writes the cached prefix, the rest read it. */
export function expectedRunUsd12(entry: LoopEntry, turns: number): bigint {
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > 16) throw invalid();
  return entry.expectedFirstTurnUsd12 + BigInt(turns - 1) * entry.expectedTurnUsd12;
}
/**
 * The vendor cost a share of the monthly grant buys under the margin rule (ADR-0026 items 4
 * and 5): the plan price after the fee, times the vendor share, times the cap's share. With
 * the 17.9% fee and the 50% share, 5% at US$149 is about US$3.06 (a specialist's cap) and 1%
 * about US$0.61 (the former look-for-work cap). ADR-0039 removes the specialist caps; PR 2
 * removes this rule with RateCard@1's caps.
 */
export function creditCapUsd12(input: {
  readonly planPriceUsd: string;
  readonly capBasisPoints: number;
  readonly feeBasisPoints?: number;
  readonly vendorShareBasisPoints?: number;
}): bigint {
  const {
    planPriceUsd,
    capBasisPoints,
    feeBasisPoints = 1790,
    vendorShareBasisPoints = 5000,
  } = input;
  if (
    typeof planPriceUsd !== "string" ||
    !/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/.test(planPriceUsd) ||
    !Number.isSafeInteger(capBasisPoints) ||
    capBasisPoints < 1 ||
    capBasisPoints > 10_000 ||
    !Number.isSafeInteger(feeBasisPoints) ||
    feeBasisPoints < 0 ||
    feeBasisPoints >= 10_000 ||
    !Number.isSafeInteger(vendorShareBasisPoints) ||
    vendorShareBasisPoints < 1 ||
    vendorShareBasisPoints > 10_000
  )
    throw invalid();
  const [whole, fraction = ""] = planPriceUsd.split(".");
  const price12 = BigInt(whole!) * 10n ** 12n + BigInt(fraction.padEnd(2, "0")) * 10n ** 10n;
  return (
    (price12 *
      BigInt(10_000 - feeBasisPoints) *
      BigInt(vendorShareBasisPoints) *
      BigInt(capBasisPoints)) /
    10n ** 12n
  );
}
/** 10^-12 USD as numeric(20,8) text: a hold rounds up, a cost down. */
export function usd12Text(units: bigint, rounding: "up" | "down"): string {
  if (!nonNegative(units) || units >= 10n ** 24n || !["up", "down"].includes(rounding))
    throw invalid();
  const usd8 = rounding === "up" ? (units + 9_999n) / 10_000n : units / 10_000n;
  return `${usd8 / 100_000_000n}.${String(usd8 % 100_000_000n).padStart(8, "0")}`;
}
/** RunHold@1, the record admission writes for a held run. */
export function runHoldRecord(
  entry: LoopEntry,
  hold: Extract<RunHoldResult, { ok: true }>,
): Current_RunHold {
  return Object.freeze({
    catalogueVersion: entry.catalogueVersion,
    model: entry.model,
    effort: entry.effort,
    turnLimit: hold.turnLimit,
    worstCaseTurnUsd: usd12Text(entry.worstCaseTurnUsd12, "up"),
    holdUsd: usd12Text(hold.holdUsd12, "up"),
    binding: hold.binding,
    toolTurnsRequired: hold.toolTurnsRequired,
  });
}
