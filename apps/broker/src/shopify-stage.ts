// The Shopify launch and install stage line (fix-shopify-install-live). The first live
// launch and callback failed with only `{"event":"morrow_broker",...,"code":
// "CAPABILITY_UNAVAILABLE"}`, which a deadline, a missing vault and a driver error all
// produce. A launch or install that does not succeed now emits exactly one more line, built
// here from closed values only:
//   {"event":"morrow_broker_shopify_stage","method","stage","result","reason","vault",
//    "vaultPhase","vaultCause","statements","connectMs","txMs","txBudgetMs","totalMs",
//    "secretCache","installation","coldIsolate"}
// `stage` is the last step entered; `reason` one closed code of that step; the vault fields
// describe the last vault transaction (vault-database.ts VaultTransactionObservation);
// durations are floored to 50 ms and capped at 20 s. The line never holds a shop, host,
// session, locale, id_token, timestamp, hmac, state, digest, code, token, client id, app
// key, workspace or installation id, header, body, provider text or error message: every
// field is checked against its closed set here, and anything else becomes "unknown" or
// null. Building and printing it never throws and never changes an outcome.
//
// Emitted by the broker only, from inside the ConnectorBroker RPC (a JS RPC invocation is
// traced with its method name, not a request URL), and only for a call that did not
// succeed, so a successful launch or install logs nothing new. The connector, whose
// Workers Logs events carry the request URL (the callback's code, state and hmac), emits
// nothing here (docs/briefs/fix-signin-clock-and-stage-log.md, request URL).
import type { VaultErrorCode } from "./vault.js";
import {
  vaultTransactionCauses,
  vaultTransactionPhases,
  type VaultTransactionObservation,
} from "./vault-database.js";
import {
  shopifyAdminReasons,
  shopifyExchangeReasons,
  shopifyQueryShapeReasons,
} from "./shopify.js";

export const shopifyStageEvent = "morrow_broker_shopify_stage";
export const shopifyStageMethods = Object.freeze([
  "shopifyLaunchVerify",
  "shopifyInstallComplete",
] as const);
export type ShopifyStageMethod = (typeof shopifyStageMethods)[number];

const shapeReasons = [
  "app_key_shape",
  "digest_shape",
  "query_bytes",
  "state_shape",
  "state_mismatch",
  "code_missing",
  ...shopifyQueryShapeReasons,
] as const;
// Each stage's closed reasons. "unexpected" (a throw that is neither a BrokerHold nor a
// VaultError) is admitted at every stage.
export const shopifyStageReasons = Object.freeze({
  input: ["input_invalid"],
  budget: ["budget_invalid"],
  shape: shapeReasons,
  capability: ["vault_absent"],
  preverify: ["secret_refused"],
  ingress: ["ingress_busy"],
  launch_context: ["vault_error", "secret_not_found", "registry_not_found", "registry_invalid"],
  verify: ["hmac_mismatch", "shop_mismatch"],
  claim_tx: ["vault_error", "secret_not_found", "hmac_mismatch", "shop_mismatch"],
  claim: ["claim_expired", "claim_replayed", "claim_not_found", "claim_invalid"],
  shop_digest: ["shop_digest_mismatch"],
  reserve: ["budget_exhausted"],
  exchange: shopifyExchangeReasons,
  scopes: ["scopes_mismatch"],
  identity: shopifyAdminReasons,
  store_tx: [
    "vault_error",
    "admission_refused",
    "prepare_state_invalid",
    "prepare_refused",
    "seal_failed",
    "store_state_invalid",
    "store_refused",
  ],
  done: [],
} as const satisfies Record<string, readonly string[]>);
export type ShopifyStage = keyof typeof shopifyStageReasons;
export const shopifyLaunchStages = Object.freeze([
  "input",
  "shape",
  "capability",
  "preverify",
  "ingress",
  "launch_context",
  "verify",
  "done",
] as const satisfies readonly ShopifyStage[]);
export const shopifyInstallStages = Object.freeze([
  "input",
  "budget",
  "shape",
  "capability",
  "preverify",
  "ingress",
  "claim_tx",
  "claim",
  "shop_digest",
  "reserve",
  "exchange",
  "scopes",
  "identity",
  "store_tx",
  "done",
] as const satisfies readonly ShopifyStage[]);
export const shopifyLaunchResults = Object.freeze(["verified", "refused", "held"] as const);
export const shopifyInstallResults = Object.freeze([
  "installed",
  "reauthorised",
  "refused",
  "state_invalid",
  "scopes_mismatch",
  "store_not_development",
  "exchange_uncertain",
  "outcome_unknown",
  "held",
] as const);
export const shopifyStageSecretCaches = Object.freeze(["none", "fresh", "stale"] as const);
// Every VaultError code (vault.ts); `satisfies` keeps the list inside the type.
const vaultErrorCodes = Object.freeze([
  "VAULT_INPUT_INVALID",
  "VAULT_KEK_UNAVAILABLE",
  "VAULT_OPEN_FAILED",
  "VAULT_RECORD_INVALID",
  "VAULT_DATABASE_UNAVAILABLE",
  "VAULT_STATEMENT_DENIED",
  "VAULT_OUTCOME_UNKNOWN",
] as const satisfies readonly VaultErrorCode[]);
const installations = ["none", "unlinked", "linked", "suspended", "uninstalled"] as const;
/** The key set of the line, in order. */
export const shopifyStageKeys = Object.freeze([
  "event",
  "method",
  "stage",
  "result",
  "reason",
  "vault",
  "vaultPhase",
  "vaultCause",
  "statements",
  "connectMs",
  "txMs",
  "txBudgetMs",
  "totalMs",
  "secretCache",
  "installation",
  "coldIsolate",
] as const);
const maxMs = 20000;

/** One call's record, filled in as it goes (every field may be anything; the line checks). */
export interface ShopifyStageTrace {
  method: ShopifyStageMethod;
  stage: ShopifyStage;
  result: string | null;
  reason: string | null;
  vault: string | null;
  vaultPhase: string | null;
  vaultCause: string | null;
  statements: number | null;
  connectMs: number | null;
  txMs: number | null;
  txBudgetMs: number | null;
  totalMs: number | null;
  secretCache: string | null;
  installation: string | null;
  coldIsolate: boolean | null;
}
export function newShopifyStageTrace(method: ShopifyStageMethod): ShopifyStageTrace {
  return {
    method,
    stage: "input",
    result: null,
    reason: null,
    vault: null,
    vaultPhase: null,
    vaultCause: null,
    statements: null,
    connectMs: null,
    txMs: null,
    txBudgetMs: null,
    totalMs: null,
    secretCache: null,
    installation: null,
    coldIsolate: null,
  };
}
/** Copies one vault transaction's observation into the trace (closed values only). */
export function recordVaultObservation(
  trace: ShopifyStageTrace,
  budgetMs: number,
  observation: Readonly<VaultTransactionObservation> | null,
  elapsedMs: number,
): void {
  trace.txBudgetMs = budgetMs;
  trace.vaultPhase = observation?.phase ?? null;
  trace.vaultCause = observation?.cause ?? null;
  trace.statements = observation?.statements ?? null;
  trace.connectMs = observation?.connectMs ?? null;
  trace.txMs = observation?.txMs ?? elapsedMs;
}

const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};
const member = <T extends string>(set: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (set as readonly string[]).includes(value) ? (value as T) : null;
const ms = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(maxMs, Math.floor(value / 50) * 50)
    : null;

/**
 * The line for one trace, as JSON with exactly shopifyStageKeys. Pure; never throws: a
 * hostile or unknown value becomes "unknown" (method, stage, result, reason) or null.
 */
export function shopifyStageLine(trace: unknown): string {
  const method = member(shopifyStageMethods, own(trace, "method"));
  const stages: readonly string[] =
    method === "shopifyInstallComplete" ? shopifyInstallStages : shopifyLaunchStages;
  const stage = member(stages as readonly ShopifyStage[], own(trace, "stage"));
  const results: readonly string[] =
    method === "shopifyInstallComplete" ? shopifyInstallResults : shopifyLaunchResults;
  const rawReason = own(trace, "reason");
  const reason =
    rawReason === null || rawReason === undefined
      ? null
      : stage !== null &&
          (rawReason === "unexpected" ||
            member(shopifyStageReasons[stage] as readonly string[], rawReason) !== null)
        ? (rawReason as string)
        : "unknown";
  const statements = own(trace, "statements");
  const coldIsolate = own(trace, "coldIsolate");
  return JSON.stringify({
    event: shopifyStageEvent,
    method: method ?? "unknown",
    stage: stage ?? "unknown",
    result: member(results, own(trace, "result")) ?? "unknown",
    reason,
    vault: member(vaultErrorCodes, own(trace, "vault")),
    vaultPhase: member(vaultTransactionPhases, own(trace, "vaultPhase")),
    vaultCause: member(vaultTransactionCauses, own(trace, "vaultCause")),
    statements:
      typeof statements === "number" &&
      Number.isSafeInteger(statements) &&
      statements >= 0 &&
      statements <= 16
        ? statements
        : null,
    connectMs: ms(own(trace, "connectMs")),
    txMs: ms(own(trace, "txMs")),
    txBudgetMs: ms(own(trace, "txBudgetMs")),
    totalMs: ms(own(trace, "totalMs")),
    secretCache: member(shopifyStageSecretCaches, own(trace, "secretCache")),
    installation: member(installations, own(trace, "installation")),
    coldIsolate: typeof coldIsolate === "boolean" ? coldIsolate : null,
  });
}
/** Prints the line; a throwing console changes nothing. */
export function emitShopifyStage(trace: Readonly<ShopifyStageTrace>): void {
  try {
    console.log(shopifyStageLine(trace));
  } catch {
    /* The line never changes an outcome. */
  }
}
