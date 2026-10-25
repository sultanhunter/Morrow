import { loginJson } from "./standalone-login-protocol.js";

// The api/broker service-binding protocol (P04.T02a D4, ADR-0007). Pure and
// additive: it imports only `loginJson`, never SQL, pools, the driver or
// validators, so the broker bundle stays free of them. Only strings, booleans
// and integer budgets cross the binding.

// THE single role/purpose table. The broker's `secrets.required` and the pools'
// borrowed namespaces must follow it. P05.T01x (ADR-0009 item 4) dropped the login
// selection role and added the first-owner signup executor; P06.T01a (ADR-0010
// item 2) added the api Worker's work login. M2 PR-1 (ADR-0022 items 7-8) adds the
// connector's and the orchestrator's membership-free executor logins, so it holds ten.
export const brokerNeonRoles = Object.freeze({
  morrow_identity_login: "primary_and_one_same_role_observer",
  morrow_identity_preauth: "primary_and_one_same_role_observer",
  morrow_identity_sessions: "primary_and_one_same_role_observer",
  morrow_api: "workspace_primary_and_one_same_role_observer",
  morrow_identity_linking: "workspace_primary_and_one_same_role_observer",
  morrow_identity_logout: "workspace_primary_and_one_same_role_observer",
  morrow_identity_onboarding: "workspace_primary_and_one_same_role_observer",
  // P06.T01a (ADR-0010 item 2): the api Worker's work login, one connection per request.
  morrow_api_worker: "work_request_transaction",
  // M2 PR-1: the connector Worker's login, one connection per request (M2 PR-2/PR-3).
  morrow_connector_ingress: "connector_request_transaction",
  // M2 PR-1: the orchestrator's login, one connection per Workflow step (spine §5).
  morrow_runtime_executor: "runtime_step_transaction",
} as const);
export type BrokerNeonRole = keyof typeof brokerNeonRoles;
export const brokerNeonRoleNames = Object.freeze(Object.keys(brokerNeonRoles) as BrokerNeonRole[]);
// Broker trust model v1 (ADR-0022 item 7): each caller binds its own entrypoint, and
// neonLease serves only that caller's roles. The api keeps the eight roles of v0.
export type BrokerCaller = "api" | "connector" | "runtime";
export const brokerCallerRoles: Readonly<Record<BrokerCaller, readonly BrokerNeonRole[]>> =
  Object.freeze({
    api: Object.freeze([
      "morrow_identity_login",
      "morrow_identity_preauth",
      "morrow_identity_sessions",
      "morrow_api",
      "morrow_identity_linking",
      "morrow_identity_logout",
      "morrow_identity_onboarding",
      "morrow_api_worker",
    ] as const),
    connector: Object.freeze(["morrow_connector_ingress"] as const),
    runtime: Object.freeze(["morrow_runtime_executor"] as const),
  });
// The broker's own database login (the vault definers), never leased to any caller.
export const brokerVaultRole = "morrow_vault_broker";
// The vault key-encryption keys the broker holds, one secret per KEK version
// (ADR-0022 item 7). A rotation adds the next version here before any row uses it.
export const brokerVaultKekSecrets: readonly string[] = Object.freeze(["MORROW_VAULT_KEK_V1"]);
export const brokerPasswordSecret = (role: BrokerNeonRole | typeof brokerVaultRole) =>
  `MORROW_DB_PASSWORD_${role.toUpperCase()}`;
// M5 PR-1 (ADR-0022 items 7 and 12): the Stripe restricted key (rk_test_ only) and the
// webhook signing secret, bound only to the broker, and only while the Stripe switch is on.
export const brokerStripeSecrets: readonly string[] = Object.freeze([
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);
// The reviewed Stripe switch (owner decision (c), 2026-10-21: "Merge with Stripe off"). It
// is off by default everywhere. It is turned on by one reviewed commit of `switch` in
// docs/decisions/stripe-staging.json, which edge:check and the staging tools read (staging
// only: development's committed config never carries Stripe, and production holds it until
// the ADR-0007 item 9 custody ADR). While it is off the broker requires no Stripe secret
// and the Stripe methods and billing purchase routes answer a fixed unavailable code.
export type BrokerStripeSwitch = "off" | "on";
// The switch's one runtime image: the api's and the broker's var MORROW_STRIPE_MODE, exactly
// "test" while the switch is on and absent while it is off (live mode waits for M6). The
// broker treats any other value as off; the api refuses it (API_ENV_VALUE_INVALID).
export const stripeModeVar = "MORROW_STRIPE_MODE";
export const stripeModeTest = "test";
// Development and staging with the switch off (the deployed broker's 14 names). P05.T01ab
// (ADR-0019 item 6): the Turnstile secret is the one provider credential admitted beside
// WorkOS under v0. It verifies tokens and cannot mint them.
export const brokerRequiredSecrets: readonly string[] = Object.freeze([
  "WORKOS_API_KEY",
  "TURNSTILE_SECRET_KEY",
  ...brokerNeonRoleNames.map(brokerPasswordSecret),
  brokerPasswordSecret(brokerVaultRole),
  ...brokerVaultKekSecrets,
]);
// Production holds the vault and Stripe (trust model v1 custody is development and staging
// only, ADR-0022 item 7, until the ADR-0007 item 9 production custody ADR), so a production
// deploy requires neither a KEK, the vault login's password nor a Stripe secret (12 names).
export const brokerVaultSecrets: readonly string[] = Object.freeze([
  brokerPasswordSecret(brokerVaultRole),
  ...brokerVaultKekSecrets,
]);
const brokerRequiredSecretsWithStripe: readonly string[] = Object.freeze([
  ...brokerRequiredSecrets,
  ...brokerStripeSecrets,
]);
// M3 PR-2 (ADR-0022 items 7 and 10): the Anthropic Console workspace's API key, bound only
// to the broker and only while the reviewed model-provider switch is on. The switch is
// docs/decisions/model-provider-staging.json `switch`, committed "off": while it is off the
// broker requires no model secret, modelRespond answers BROKER_HELD (MODEL_UNAVAILABLE)
// before any input, database or provider access, run admission answers 503 before any
// reservation and ListingsRunWorkflow throws dispatch_disabled before any step. Its runtime
// image is the var MORROW_MODEL_PROVIDER, exactly "anthropic" while the switch is on, on the
// staging api, broker and orchestrator; any other value is off. Production has no switch
// until the ADR-0007 item 9 custody ADR.
export const brokerModelSecrets: readonly string[] = Object.freeze(["ANTHROPIC_API_KEY"]);
export type BrokerModelSwitch = "off" | "on";
export const modelProviderVar = "MORROW_MODEL_PROVIDER";
export const modelProviderAnthropic = "anthropic";
/** An Anthropic Console API key (sk-ant-api03-…); never logged, never returned. */
export const anthropicKeyPattern = /^sk-ant-api03-[A-Za-z0-9_-]{80,200}$/;
// Build order PR 7 (ADR-0029 items 3 and 10): the E2B API key, bound only to the broker and
// required only while the reviewed runtime switch is not off. The switch is
// docs/decisions/runtime-staging.json `switch` ("off", "cleanup_only" or "on"), committed
// "off": while it is off the broker reads no runtime secret, runtimeExecute and runtimeSweep
// answer BROKER_HELD (RUNTIME_UNAVAILABLE) before any input, database or provider access, and
// no adapter is composed. Its runtime image is the broker's var MORROW_RUNTIME_SWITCH, exactly
// "on" or "cleanup_only" while the switch is on or cleanup-only (cleanup-only reconciles and
// kills, and creates nothing); any other value is off. Production has no switch until the
// ADR-0007 item 9 custody ADR.
export const brokerRuntimeSecrets: readonly string[] = Object.freeze(["E2B_API_KEY"]);
export type BrokerRuntimeSwitch = "off" | "cleanup_only" | "on";
export const runtimeSwitchVar = "MORROW_RUNTIME_SWITCH";
export const runtimeSwitchValues: readonly Exclude<BrokerRuntimeSwitch, "off">[] = Object.freeze([
  "on",
  "cleanup_only",
]);
/** The one runtime provider ADR-0029 selects. */
export const runtimeProviderE2b = "e2b";
/** An E2B API key (e2b_…, E2B's documented shape); never logged, never returned. */
export const e2bKeyPattern = /^e2b_[A-Za-z0-9]{20,128}$/;
const brokerRequiredSecretsInProduction: readonly string[] = Object.freeze(
  brokerRequiredSecrets.filter((name) => !brokerVaultSecrets.includes(name)),
);
// The broker's exact `secrets.required` (development and staging: 14 with every switch off,
// 16 with Stripe on, 15 with the model provider on, 15 with the runtime switch on or
// cleanup-only, and each combination's sum; production: 12). Production has no switch: "on"
// (or cleanup-only) there is refused.
export function brokerRequiredSecretsFor(
  environment: "development" | "staging" | "production",
  stripe: BrokerStripeSwitch = "off",
  model: BrokerModelSwitch = "off",
  runtime: BrokerRuntimeSwitch = "off",
): readonly string[] {
  if ((stripe !== "off" && stripe !== "on") || (environment === "production" && stripe === "on"))
    throw Error("BROKER_STRIPE_SWITCH_INVALID");
  if ((model !== "off" && model !== "on") || (environment === "production" && model === "on"))
    throw Error("BROKER_MODEL_SWITCH_INVALID");
  if (
    (runtime !== "off" && runtime !== "on" && runtime !== "cleanup_only") ||
    (environment === "production" && runtime !== "off")
  )
    throw Error("BROKER_RUNTIME_SWITCH_INVALID");
  if (environment === "production") return brokerRequiredSecretsInProduction;
  const base = stripe === "on" ? brokerRequiredSecretsWithStripe : brokerRequiredSecrets;
  const withModel = model === "on" ? [...base, ...brokerModelSecrets] : base;
  if (runtime === "off") return model === "on" ? Object.freeze(withModel) : base;
  return Object.freeze([...withModel, ...brokerRuntimeSecrets]);
}
// The names a staging broker may hold beyond its required ones: the E2B key, placed ahead of
// the runtime switch only by the owner's explicit choice (`staging:put-secret E2B_API_KEY
// --while-runtime-off`). While the switch is off the broker never reads it; gate 6 and
// secrets-status accept it present or absent. Development and production admit none.
export function brokerOptionalSecretsFor(
  environment: "development" | "staging" | "production",
  runtime: BrokerRuntimeSwitch = "off",
): readonly string[] {
  if (runtime !== "off" && runtime !== "on" && runtime !== "cleanup_only")
    throw Error("BROKER_RUNTIME_SWITCH_INVALID");
  return environment === "staging" && runtime === "off" ? brokerRuntimeSecrets : Object.freeze([]);
}
// RuntimeBroker.runtimeExecute and runtimeSweep (build order PR 7; ADR-0029): an execute's
// budget holds a create, the inputs, one 120 s exec, the outputs and the kill; a sweep
// reconciles at most one batch of stale operations.
export const runtimeGatewayLimits = Object.freeze({
  executeBudgetMinMs: 60_000,
  executeBudgetMaxMs: 600_000,
  sweepBudgetMinMs: 30_000,
  sweepBudgetMaxMs: 300_000,
  sweepBatch: 25,
});
export const brokerLimits = Object.freeze({
  namespaceMaxBytes: 1024,
  selectorMaxBytes: 2048,
  sessionPageMaxMs: 10000,
  sessionPageMaxBytes: 131072,
  healthMaxMs: 1000,
  healthCacheMs: 30000,
});
export interface BrokerDatabaseBinding {
  schemaVersion: 1;
  environment: "development" | "staging";
  projectId: string;
  branchId: string;
  hostname: string;
  database: string;
}
export interface ApiBrokerRpc {
  health(): Promise<boolean>;
  neonLease(namespaceJson: string): Promise<string>;
  workosSessionPage(namespaceJson: string, selectorJson: string, budgetMs: number): Promise<string>;
  // P05.T01ab (ADR-0019 item 6): one siteverify call; held is the error BROKER_HELD.
  challengeVerify(action: string, token: string, budgetMs: number): Promise<ChallengeVerdict>;
  // M5 PR-1 (ADR-0022 items 7 and 12): Stripe on one pinned API version, ids only. Each
  // write names an authorized stripe_write operation; the broker loads its customer, price,
  // metadata and URLs from the database. Results are the closed JSON strings below. While
  // the Stripe switch is off (no MORROW_STRIPE_MODE), each one is BROKER_HELD with the fixed
  // code STRIPE_UNAVAILABLE before any input, database or Stripe access.
  stripeCustomerEnsure(operationId: string, budgetMs: number): Promise<string>;
  stripeCheckoutCreate(operationId: string, budgetMs: number): Promise<string>;
  stripePortalCreate(operationId: string, budgetMs: number): Promise<string>;
  // The raw webhook body, base64 so the bytes stay exact, and the Stripe-Signature header.
  stripeWebhookVerify(
    rawBodyBase64: string,
    signatureHeader: string,
    budgetMs: number,
  ): Promise<string>;
  // M2 PR-3 (spine §4): one fixed Admin GraphQL read under a read lease (shopIdentity,
  // collectionsPage, productsPage), named by the lease, its generation and its subject (the
  // read's request id). The closed result JSON below; any refusal is BROKER_HELD.
  shopifyRead(
    leaseId: string,
    generation: number,
    subjectId: string,
    queryName: string,
    variablesJson: string,
    budgetMs: number,
  ): Promise<string>;
  // v1 PR 3 (ADR-0022 items 7 and 9): the gateway's apply of one dispatching catalog_write
  // operation (the claimant's own session moved it there), and the read-back of one
  // operation. Ids and a budget only; the closed results above (encodeShopifyApplyResult,
  // encodeShopifyReconcileResult). While the apply switch is off, shopifyProductApply is
  // BROKER_HELD (WRITE_UNAVAILABLE) before any input, database or Shopify access; the
  // read-back is never blocked by the switch.
  shopifyProductApply(operationId: string, budgetMs: number): Promise<string>;
  shopifyProductReconcile(operationId: string, budgetMs: number): Promise<string>;
  // "Disconnect store" (ADR-0022 items 7 and 13; the M2 brief's PR-3 checklist): after the
  // api's disconnect committed, destroys that installation's offline token and records the
  // destruction on it. The reason is fixed (`disconnected`): the api can destroy only a token
  // whose installation records a person's disconnect, and the vault refuses any other
  // (ineligible). The closed result is encodeShopifyCredentialResult's; a held broker throws
  // BROKER_HELD. Idempotent: the connector's cron re-drives one that did not complete.
  shopifyCredentialDestroy(installationId: string): Promise<string>;
}
// M2 PR-1 (ADR-0022 item 7, spine §4): the connector's and the orchestrator's own
// entrypoints. PR-1 gives each its health and its own role lease; the Shopify and model
// methods join with the PRs that add their database definers (M2 PR-2/PR-3, M3, M4).
// M2 PR-2 (ADR-0008 item 2, amended item 1): the connector's three Shopify methods. Each
// takes the raw request text the connector received and returns one closed JSON string
// (encode/decode below); a held broker throws BROKER_HELD.
export interface ConnectorBrokerRpc {
  health(): Promise<boolean>;
  neonLease(namespaceJson: string): Promise<string>;
  shopifyLaunchVerify(appKey: string, rawQuery: string): Promise<string>;
  shopifyInstallComplete(
    appKey: string,
    rawCallbackQuery: string,
    stateDigest: string,
    budgetMs: number,
  ): Promise<string>;
  // M2 PR-3: the webhook's signature check also records the delivery in the inbox, in the
  // same vault transaction; the verdict carries only the inbox id (encodeShopifyWebhookVerdict).
  shopifyWebhookVerify(appKey: string, headersJson: string, rawBodyBase64: string): Promise<string>;
  // M2 PR-3: destroys an ended installation's offline token, only with the end reason its
  // row records, and records the destruction on it (encodeShopifyCredentialResult).
  shopifyCredentialDestroy(installationId: string, reason: string): Promise<string>;
  // Shop-specific webhook subscriptions (docs/briefs/shopify-shop-specific-webhooks.md): a
  // budget only. The broker takes the active installations whose app/uninstalled and
  // app/scopes_update subscriptions are not registered, or were registered 24 hours ago
  // (a re-check: Shopify removes a subscription whose deliveries keep failing), from its
  // own vault login, lists each store's subscriptions of those topics with its token and
  // creates only a missing one, to the connector's webhook path built from its own
  // configuration; counts only come back (encodeShopifyWebhookSyncResult). Held without the
  // vault or that configuration.
  shopifyWebhookSubscriptionsSync(budgetMs: number): Promise<string>;
}
export interface RuntimeBrokerRpc {
  health(): Promise<boolean>;
  neonLease(namespaceJson: string): Promise<string>;
  // M2 PR-3 (spine §4): productContent under a run lease, for a product of that run.
  shopifyRead(
    leaseId: string,
    generation: number,
    subjectId: string,
    queryName: string,
    variablesJson: string,
    budgetMs: number,
  ): Promise<string>;
  // M3 PR-2 (ADR-0022 item 10; spine §4 and §9): the provider-neutral model gateway. The
  // lease is the run's; callJson is ModelCall@1 (closed: no selection, catalogue version or
  // provider); the result is a ModelResult@1 string. The broker reads the selection and the
  // catalogue version from the run its lease names and fences every attempt in SQL before any
  // provider request. A held broker (the model-provider switch off, an invalid call, a stop,
  // a spent reservation, an open call) throws BROKER_HELD.
  modelRespond(
    leaseId: string,
    generation: number,
    callJson: string,
    budgetMs: number,
  ): Promise<string>;
  // Build order PR 7 (ADR-0029): the computer's one door. The lease is the run's; jobJson is
  // RuntimeJob@1 (closed: a step key, a script, minimised extracts and declared outputs; no
  // command, template, network, environment or limit); the result is a RuntimeResult@1
  // string. The broker commits the operation's send mark in SQL before any create, never
  // retries one, always kills, and returns only checked PNG, CSV and XLSX outputs. While the
  // runtime switch is off (committed, docs/decisions/runtime-staging.json) both methods are
  // BROKER_HELD before any input, database or provider access.
  runtimeExecute(
    leaseId: string,
    generation: number,
    jobJson: string,
    budgetMs: number,
  ): Promise<string>;
  // Reconciles stale runtime operations by their metadata (kills leftovers; never creates);
  // runs under "on" and "cleanup_only". The result counts only, no ids.
  runtimeSweep(budgetMs: number): Promise<string>;
}
/**
 * M2 PR-3's RuntimeBroker.shopifyRead(productContent) exists: a reviewed constant (an RPC stub
 * answers any method name, so it is never probed), true since M2 PR-3 and M3 PR-2 were
 * integrated. The api's run admission and the orchestrator's dispatch both require it with
 * the model-provider switch, so the switch (committed off, docs/decisions/
 * model-provider-staging.json) is now the only gate: no run, lease or reservation exists
 * while it is off.
 */
export const runtimeProductReadAvailable: boolean = true;
export const modelGatewayLimits = Object.freeze({
  callMaxBytes: 200_000,
  resultMaxBytes: 200_000,
  budgetMinMs: 1_000,
  // The official TypeScript SDK's default timeout for a non-streaming request of up to about
  // 21,000 max_tokens; migration listings-runs bounds the fence's budget_ms the same way.
  budgetMaxMs: 600_000,
});
// Sizing one non-streaming Messages send (ADR-0022 item 10 sends no stream): the send is
// given the time to produce its effort's whole max_tokens at the floor output rate, plus a
// first-token allowance, so a long reply is never cut off by a budget that could not fit it
// (an aborted send is uncertain and booked at its worst case). The floor is 128,000 output
// tokens an hour (about 35.6 a second), the rate the official SDK assumes when it decides a
// non-streaming request fits its 10-minute default. It is an assumption until the staging
// smoke measures each model and effort (M3 brief, owner question 6). A call's budget adds
// the fence transaction's and the free count's ceilings and the close's second.
export const modelSendTiming = Object.freeze({
  floorOutputTokensPerHour: 128_000,
  firstTokenAllowanceMs: 30_000,
  fenceMaxMs: 10_000,
  countMaxMs: 15_000,
  closeMarginMs: 1_000,
});
/** The send's own window for an effort's max_tokens (the floor rate plus the allowance). */
export function modelSendWindowMs(maxOutputTokens: number): number {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 128_000)
    throw invalid();
  return (
    modelSendTiming.firstTokenAllowanceMs +
    Math.ceil((maxOutputTokens * 3_600_000) / modelSendTiming.floorOutputTokensPerHour)
  );
}
/** One modelRespond's budget for an effort's max_tokens: fence, count, send and close. */
export function modelCallBudgetMs(maxOutputTokens: number): number {
  return (
    modelSendTiming.fenceMaxMs +
    modelSendTiming.countMaxMs +
    modelSendWindowMs(maxOutputTokens) +
    modelSendTiming.closeMarginMs
  );
}

// P05.T01ab: the challenge protocol shared by the api guard and the broker.
export type ChallengeVerdict = "passed" | "failed";
export type ChallengeActionName = "login" | "signup";
export type ChallengeActions = Readonly<Record<ChallengeActionName, string>>;
export const challengeLimits = Object.freeze({
  tokenMaxBytes: 2048,
  budgetMaxMs: 5000,
  replyMaxBytes: 4096,
  freshnessMs: 300000,
  skewMs: 30000,
});
// The X-Morrow-Challenge header and the token the broker accepts: 1-2048 bytes.
export const challengeTokenPattern = /^[A-Za-z0-9._-]{1,2048}$/;
// Cloudflare's published dummy keys start 1x, 2x or 3x; only a real 0x key passes.
export const turnstileKeyPattern = /^0x[0-9A-Za-z_-]{20,128}$/;
// Turnstile actions: up to 32 characters of [A-Za-z0-9_-].
const actionPattern = /^[A-Za-z0-9_-]{1,32}$/;

const invalid = () => Error("BROKER_PROTOCOL_INVALID");
const encoder = new TextEncoder();
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;

export function challengeTokenValid(value: unknown): value is string {
  return exact(challengeTokenPattern, value);
}

// Exactly {login, signup}, two distinct Turnstile action names.
export function parseChallengeActions(value: unknown): ChallengeActions {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "login,signup"
  )
    throw invalid();
  const { login, signup } = value as Record<string, unknown>;
  if (!exact(actionPattern, login) || !exact(actionPattern, signup) || login === signup)
    throw invalid();
  return Object.freeze({ login, signup });
}

// The broker's TURNSTILE_CONFIGURATION_JSON {schemaVersion:1, hostname, actions}: one
// parser for the broker's challenge setup and the staging deploy's gate 4, so the gate
// admits exactly what the broker will. loginJson(…, 1024) bounds the bytes and rejects
// duplicate member names. The hostname is a lower-case DNS name equal to the login
// origin's (Turnstile reports where it was solved); a mismatch alone throws
// turnstileHostnameMismatch, every other failure BROKER_PROTOCOL_INVALID.
export interface TurnstileConfiguration {
  readonly hostname: string;
  readonly actions: ChallengeActions;
}
export const turnstileHostnameMismatch = "BROKER_PROTOCOL_HOSTNAME_MISMATCH";
const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export function parseTurnstileConfiguration(
  json: unknown,
  loginOrigin: unknown,
): Readonly<TurnstileConfiguration> {
  let hostname: string;
  let actions: ChallengeActions;
  try {
    const configuration = loginJson(json, 1024, ["schemaVersion", "hostname", "actions"]);
    if (configuration.schemaVersion !== 1 || !exact(hostnamePattern, configuration.hostname))
      throw invalid();
    hostname = configuration.hostname;
    actions = parseChallengeActions(configuration.actions);
  } catch {
    throw invalid();
  }
  let loginHostname: string | null = null;
  try {
    loginHostname = typeof loginOrigin === "string" ? new URL(loginOrigin).hostname : null;
  } catch {
    loginHostname = null;
  }
  if (loginHostname !== hostname) throw Error(turnstileHostnameMismatch);
  return Object.freeze({ hostname, actions });
}

export function brokerUtf8Bytes(value: string): number {
  return encoder.encode(value).length;
}
export function brokerWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
// The pool's own password rules (controlled-neon-login-pool.ts :694-698).
export function brokerPasswordValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 1024 &&
    !/[\x00-\x20\x7f]/.test(value) &&
    brokerWellFormed(value)
  );
}

// loginJson(…, 4096) plus the managed-workspace-binding.ts regexes, without
// importing that module (it reaches the logout and SQL modules).
export function parseBrokerDatabaseBinding(json: unknown): Readonly<BrokerDatabaseBinding> {
  try {
    const n = loginJson(json, 4096, [
      "schemaVersion",
      "environment",
      "projectId",
      "branchId",
      "hostname",
      "database",
    ]);
    if (
      n.schemaVersion !== 1 ||
      (n.environment !== "development" && n.environment !== "staging") ||
      !exact(/^[a-z0-9][a-z0-9-]{0,79}$/, n.projectId) ||
      !exact(/^br-[a-z0-9-]{1,77}$/, n.branchId) ||
      !exact(/^ep-[a-z0-9-]+\.(?:c-[0-9]+\.)?[a-z0-9-]+\.(aws|azure)\.neon\.tech$/, n.hostname) ||
      n.hostname.length > 253 ||
      n.hostname.split(".")[0]!.includes("-pooler") ||
      !exact(/^[a-z][a-z0-9_]{0,62}$/, n.database)
    )
      throw invalid();
    return Object.freeze({
      schemaVersion: 1,
      environment: n.environment,
      projectId: n.projectId,
      branchId: n.branchId,
      hostname: n.hostname,
      database: n.database,
    });
  } catch {
    throw invalid();
  }
}

// Byte-identical to the namespace the pool borrows (controlled-neon-login-pool.ts :307-319).
export function neonLeaseNamespace(
  b: Readonly<BrokerDatabaseBinding>,
  role: BrokerNeonRole,
): string {
  if (!Object.hasOwn(brokerNeonRoles, role)) throw invalid();
  return JSON.stringify({
    schemaVersion: 1,
    providerId: "neon",
    environment: b.environment,
    projectId: b.projectId,
    branchId: b.branchId,
    hostname: b.hostname,
    database: b.database,
    role,
    purpose: brokerNeonRoles[role],
  });
}

// Synchronous; equal to the namespace the login port borrows (fixed-workos-login-port.ts :391-398).
export function workosSessionNamespace(loginConfigurationJson: string): string {
  try {
    const c = loginJson(loginConfigurationJson, 32768, [
      "schemaVersion",
      "controllerProtocol",
      "origin",
      "retentionTier",
      "authenticationBindingJson",
      "verificationProfileJson",
      "profileId",
      "profileRecordRevision",
    ]);
    const b = loginJson(c.authenticationBindingJson, 8192, [
      "bindingId",
      "bindingRevision",
      "environmentId",
      "applicationId",
      "clientId",
      "redirectUri",
      "returnPath",
    ]);
    if (
      c.schemaVersion !== 1 ||
      !exact(/^environment_[A-Z0-9]{26}$/, b.environmentId) ||
      !exact(/^app_[A-Z0-9]{26}$/, b.applicationId) ||
      !exact(/^client_[A-Z0-9]{26}$/, b.clientId)
    )
      throw invalid();
    return JSON.stringify({
      schemaVersion: 1,
      providerId: "workos",
      environmentId: b.environmentId,
      applicationId: b.applicationId,
      clientId: b.clientId,
      purpose: "list_active_sessions",
    });
  } catch {
    throw invalid();
  }
}

export function encodeNeonLeaseGrant(password: string): string {
  if (!brokerPasswordValid(password)) throw invalid();
  return JSON.stringify({ schemaVersion: 1, password });
}

// Closed keys and the pool's password rules; anything else is BROKER_PROTOCOL_INVALID.
export function decodeNeonLeaseGrant(text: unknown): string {
  try {
    const grant = loginJson(text, 8192, ["schemaVersion", "password"]);
    if (grant.schemaVersion !== 1 || !brokerPasswordValid(grant.password)) throw invalid();
    return grant.password;
  } catch {
    throw invalid();
  }
}

// ---------------------------------------------------------------------------
// M2 PR-2: the ConnectorBroker Shopify protocol (ADR-0022 items 4 and 7; ADR-0008 item 2,
// item 1 as amended 2026-10-20). Only strings and an integer budget cross the binding. The
// broker checks every Shopify signature with the app secret it decrypts from its vault,
// performs the code exchange and the one fixed Admin GraphQL read, and writes the install
// through its own login; the connector learns only these closed verdicts, never a token,
// secret or provider text. Shared by the broker (encode) and the connector (decode), so
// both sides admit exactly the same shapes.
export const shopifyLimits = Object.freeze({
  /** The launch, status or callback query string, without the leading "?". */
  queryMaxBytes: 2048,
  /** A webhook's raw body (Shopify's own limit is far larger; compliance bodies are small). */
  webhookBodyMaxBytes: 262144,
  /** The selected X-Shopify-* headers as one JSON object. */
  webhookHeadersMaxBytes: 4096,
  /** The install's whole budget: claim, exchange, identity read and the install write. */
  budgetMaxMs: 10000,
  /** A Shopify-signed query's timestamp may differ from the broker's clock by this much. */
  timestampToleranceSeconds: 90,
  /** A verdict string. */
  verdictMaxBytes: 8192,
});
export const shopifyAppKeyPattern = /^[a-z0-9][a-z0-9-]{2,62}$/;
// A *.myshopify.com domain as Shopify sends it in `shop` (lowercase, no scheme or path).
export const shopifyShopPattern = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
// The OAuth state, a continuation token: 32 random bytes as canonical base64url (43 chars).
export const shopifySecretPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const shopifyDigestPattern = /^[a-f0-9]{64}$/;
const workspacePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export type ShopifyInstallationState = "none" | "unlinked" | "linked" | "suspended" | "uninstalled";
const installationStates: readonly string[] = [
  "none",
  "unlinked",
  "linked",
  "suspended",
  "uninstalled",
];
export type ShopifyLaunchVerdict =
  | Readonly<{
      verdict: "verified";
      shop: string;
      installation: ShopifyInstallationState;
      workspaceId: string;
    }>
  | Readonly<{ verdict: "refused" }>;
export type ShopifyInstallOutcome =
  | "installed"
  | "reauthorised"
  | "refused"
  | "state_invalid"
  | "scopes_mismatch"
  | "store_not_development"
  | "exchange_uncertain"
  | "outcome_unknown";
export const shopifyInstallOutcomes: readonly ShopifyInstallOutcome[] = Object.freeze([
  "installed",
  "reauthorised",
  "refused",
  "state_invalid",
  "scopes_mismatch",
  "store_not_development",
  "exchange_uncertain",
  "outcome_unknown",
]);
export interface ShopifyInstallResult {
  readonly outcome: ShopifyInstallOutcome;
  /** The invited workspace, for installed and reauthorised only. */
  readonly workspaceId: string | null;
  /** Only when a continuation was created (an unlinked installation). */
  readonly continuationToken: string | null;
}
// The five topics ADR-0022 item 4 subscribes (no product topics).
export const shopifyWebhookTopics = Object.freeze([
  "app/uninstalled",
  "app/scopes_update",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const);
export type ShopifyWebhookTopic = (typeof shopifyWebhookTopics)[number];
// Shopify CLI 4.9 refuses app-specific subscriptions with use_legacy_install_flow (the
// connector's own authorization-code install), so the app configuration subscribes only the
// three compliance topics (they are always app-specific), and the broker registers the two
// app topics for each installation as shop-specific subscriptions through the Admin API, to
// the same signed webhook path (docs/briefs/shopify-shop-specific-webhooks.md).
export const shopifyComplianceWebhookTopics = Object.freeze([
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const);
export const shopifyShopWebhookTopics = Object.freeze([
  "app/uninstalled",
  "app/scopes_update",
] as const);
// The selected X-Shopify-* headers, lower-case, that the connector forwards as JSON.
export const shopifyWebhookHeaderNames = Object.freeze([
  "x-shopify-api-version",
  "x-shopify-hmac-sha256",
  "x-shopify-shop-domain",
  "x-shopify-topic",
  "x-shopify-webhook-id",
] as const);
// M2 PR-3: the broker verifies the signature over the raw body, minimises the body and
// records the delivery in the inbox (morrow_identity.shopify_webhook_inbox) in one vault
// transaction; the connector learns only the inbox id. recorded: a new row; duplicate: the
// row of an earlier delivery of the same webhook id, with whether it is already settled;
// refused: not Shopify's signature, or not this app's shop (401); invalid: Shopify-signed,
// but not a body of its topic (400).
export type ShopifyWebhookVerdict =
  | Readonly<{ verdict: "recorded"; inboxId: string; settled: false }>
  | Readonly<{ verdict: "duplicate"; inboxId: string; settled: boolean }>
  | Readonly<{ verdict: "refused"; inboxId: null; settled: null }>
  | Readonly<{ verdict: "invalid"; inboxId: null; settled: null }>;
const inboxIdPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const verdictJson = (value: unknown, names: readonly string[]) => {
  try {
    return loginJson(value, shopifyLimits.verdictMaxBytes, names);
  } catch {
    throw invalid();
  }
};
export function encodeShopifyLaunchVerdict(v: ShopifyLaunchVerdict): string {
  if (v.verdict === "refused")
    return JSON.stringify({
      schemaVersion: 1,
      verdict: "refused",
      shop: null,
      installation: null,
      workspaceId: null,
    });
  if (
    !exact(shopifyShopPattern, v.shop) ||
    !installationStates.includes(v.installation) ||
    !exact(workspacePattern, v.workspaceId)
  )
    throw invalid();
  return JSON.stringify({
    schemaVersion: 1,
    verdict: "verified",
    shop: v.shop,
    installation: v.installation,
    workspaceId: v.workspaceId,
  });
}
export function decodeShopifyLaunchVerdict(text: unknown): ShopifyLaunchVerdict {
  const v = verdictJson(text, ["schemaVersion", "verdict", "shop", "installation", "workspaceId"]);
  if (v.schemaVersion !== 1) throw invalid();
  if (v.verdict === "refused") {
    if (v.shop !== null || v.installation !== null || v.workspaceId !== null) throw invalid();
    return Object.freeze({ verdict: "refused" });
  }
  if (
    v.verdict !== "verified" ||
    !exact(shopifyShopPattern, v.shop) ||
    typeof v.installation !== "string" ||
    !installationStates.includes(v.installation) ||
    !exact(workspacePattern, v.workspaceId)
  )
    throw invalid();
  return Object.freeze({
    verdict: "verified",
    shop: v.shop,
    installation: v.installation as ShopifyInstallationState,
    workspaceId: v.workspaceId,
  });
}
export function encodeShopifyInstallResult(r: ShopifyInstallResult): string {
  const text = JSON.stringify({
    schemaVersion: 1,
    outcome: r.outcome,
    workspaceId: r.workspaceId,
    continuationToken: r.continuationToken,
  });
  decodeShopifyInstallResult(text);
  return text;
}
export function decodeShopifyInstallResult(text: unknown): ShopifyInstallResult {
  const v = verdictJson(text, ["schemaVersion", "outcome", "workspaceId", "continuationToken"]);
  const outcome = v.outcome as ShopifyInstallOutcome;
  const done = outcome === "installed" || outcome === "reauthorised";
  if (
    v.schemaVersion !== 1 ||
    !shopifyInstallOutcomes.includes(outcome) ||
    (done ? !exact(workspacePattern, v.workspaceId) : v.workspaceId !== null) ||
    (done
      ? !(v.continuationToken === null || exact(shopifySecretPattern, v.continuationToken))
      : v.continuationToken !== null)
  )
    throw invalid();
  return Object.freeze({
    outcome,
    workspaceId: v.workspaceId as string | null,
    continuationToken: v.continuationToken as string | null,
  });
}
export function encodeShopifyWebhookVerdict(v: ShopifyWebhookVerdict): string {
  const text = JSON.stringify({
    schemaVersion: 1,
    verdict: v.verdict,
    inboxId: v.inboxId,
    settled: v.settled,
  });
  decodeShopifyWebhookVerdict(text);
  return text;
}
export function decodeShopifyWebhookVerdict(text: unknown): ShopifyWebhookVerdict {
  const v = verdictJson(text, ["schemaVersion", "verdict", "inboxId", "settled"]);
  if (v.schemaVersion !== 1) throw invalid();
  if (v.verdict === "refused" || v.verdict === "invalid") {
    if (v.inboxId !== null || v.settled !== null) throw invalid();
    return Object.freeze(
      v.verdict === "refused"
        ? { verdict: "refused" as const, inboxId: null, settled: null }
        : { verdict: "invalid" as const, inboxId: null, settled: null },
    );
  }
  if (
    (v.verdict !== "recorded" && v.verdict !== "duplicate") ||
    !exact(inboxIdPattern, v.inboxId) ||
    typeof v.settled !== "boolean" ||
    (v.verdict === "recorded" && v.settled !== false)
  )
    throw invalid();
  return Object.freeze(
    v.verdict === "recorded"
      ? { verdict: "recorded" as const, inboxId: v.inboxId, settled: false as const }
      : { verdict: "duplicate" as const, inboxId: v.inboxId, settled: v.settled },
  );
}
// M2 PR-3: the token's destruction. The reason must be the end the installation records
// (uninstalled; or the suspension's reason); anything else is ineligible and changes nothing.
export const shopifyCredentialReasons = Object.freeze([
  "uninstalled",
  "scopes_changed",
  "disconnected",
] as const);
export type ShopifyCredentialReason = (typeof shopifyCredentialReasons)[number];
export const shopifyCredentialOutcomes = Object.freeze([
  "destroyed",
  "already_destroyed",
  "ineligible",
  "not_found",
] as const);
export type ShopifyCredentialOutcome = (typeof shopifyCredentialOutcomes)[number];
export const shopifyInstallationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function encodeShopifyCredentialResult(outcome: ShopifyCredentialOutcome): string {
  const text = JSON.stringify({ schemaVersion: 1, outcome });
  decodeShopifyCredentialResult(text);
  return text;
}
export function decodeShopifyCredentialResult(text: unknown): ShopifyCredentialOutcome {
  const v = verdictJson(text, ["schemaVersion", "outcome"]);
  if (
    v.schemaVersion !== 1 ||
    !(shopifyCredentialOutcomes as readonly unknown[]).includes(v.outcome)
  )
    throw invalid();
  return v.outcome as ShopifyCredentialOutcome;
}

// ---------------------------------------------------------------------------
// Shop-specific webhook subscriptions (docs/briefs/shopify-shop-specific-webhooks.md). One
// sync takes at most `batch` installations from the vault's pending list (the identity
// bridge's LIMIT) within its budget. Each installation ends in one closed outcome:
// registered (both subscriptions exist with exactly the connector's webhook path as their
// uri), failed (not both registered, and nothing unproven: a list or create that failed or
// was refused, a reconciled create, or a token the broker cannot use), unknown (a create
// whose outcome the broker could not prove and the reconciling list did not settle),
// unauthorized (Shopify refused the token), or skipped (the installation ended, its
// credential changed, or the outcome could not be recorded). The first four are what the
// vault records; the result carries only the counts.
export const shopifyWebhookSyncLimits = Object.freeze({
  budgetMinMs: 2000,
  budgetMaxMs: 25000,
  batch: 10,
});
// The connector's own origin, from the reviewed CONNECTOR_CONFIGURATION_JSON the broker binds
// byte-equal to the connector's ({schemaVersion: 1, origin, apiOrigin}, at most 1024 bytes):
// an https origin exactly (no path, credentials or port), or loopback http in development
// only (the workerd lab), as the connector's own parser admits it. The broker builds each
// subscription's callback URL from this origin and the app key alone. Throws otherwise.
export function parseConnectorWebhookOrigin(json: unknown, environment: string): string {
  let c: Readonly<Record<string, unknown>>;
  try {
    c = loginJson(json, 1024, ["schemaVersion", "origin", "apiOrigin"]);
  } catch {
    throw invalid();
  }
  const origin = (value: unknown): string | null => {
    if (typeof value !== "string" || value.length > 300) return null;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.origin !== value || url.username || url.password) return null;
    if (url.protocol === "https:" && url.port === "") return value;
    if (
      environment === "development" &&
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) &&
      Number(url.port) <= 65535
    )
      return value;
    return null;
  };
  const own = origin(c.origin);
  const api = origin(c.apiOrigin);
  if (c.schemaVersion !== 1 || own === null || api === null || own === api) throw invalid();
  return own;
}
/** One app's webhook callback URL: the connector's signed webhook route for that app key. */
export function shopifyWebhookCallbackUrl(origin: string, appKey: string): string {
  if (!exact(shopifyAppKeyPattern, appKey)) throw invalid();
  return `${origin}/shopify/a/${appKey}/webhooks`;
}
export const shopifyWebhookRegistrationStatuses = Object.freeze([
  "registered",
  "failed",
  "unknown",
  "unauthorized",
] as const);
export type ShopifyWebhookRegistrationStatus = (typeof shopifyWebhookRegistrationStatuses)[number];
export interface ShopifyWebhookSyncResult {
  readonly checked: number;
  readonly registered: number;
  readonly failed: number;
  readonly unknown: number;
  readonly unauthorized: number;
  readonly skipped: number;
}
const webhookSyncCounts = ["registered", "failed", "unknown", "unauthorized", "skipped"] as const;
const syncCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= shopifyWebhookSyncLimits.batch;
export function encodeShopifyWebhookSyncResult(r: ShopifyWebhookSyncResult): string {
  const text = JSON.stringify({
    schemaVersion: 1,
    checked: r.checked,
    registered: r.registered,
    failed: r.failed,
    unknown: r.unknown,
    unauthorized: r.unauthorized,
    skipped: r.skipped,
  });
  decodeShopifyWebhookSyncResult(text);
  return text;
}
export function decodeShopifyWebhookSyncResult(text: unknown): ShopifyWebhookSyncResult {
  const v = verdictJson(text, ["schemaVersion", "checked", ...webhookSyncCounts]);
  if (
    v.schemaVersion !== 1 ||
    !syncCount(v.checked) ||
    !webhookSyncCounts.every((name) => syncCount(v[name])) ||
    webhookSyncCounts.reduce((sum, name) => sum + (v[name] as number), 0) !== v.checked
  )
    throw invalid();
  return Object.freeze({
    checked: v.checked,
    registered: v.registered as number,
    failed: v.failed as number,
    unknown: v.unknown as number,
    unauthorized: v.unauthorized as number,
    skipped: v.skipped as number,
  });
}

// ---------------------------------------------------------------------------
// M2 PR-3: shopifyRead (spine §4; ADR-0022 items 4 and 7). One fixed Admin GraphQL document
// per query, in the broker only; the caller names a live lease, its generation and its
// subject, and closed variables. The api reads under a read lease (the pages and the shop
// identity), the orchestrator under a run lease (one product's listing fields, of a product
// of that run); the broker refuses any other pair (ApiBroker and RuntimeBroker each expose
// their own queries, and the vault resolution checks the lease kind again). Results are the
// closed JSON below: ids, titles, the listing fields and Shopify's page cursor only.
export const shopifyReadQueries = Object.freeze({
  api: Object.freeze(["shopIdentity", "collectionsPage", "productsPage"] as const),
  runtime: Object.freeze(["productContent"] as const),
});
export type ShopifyReadQuery =
  | "shopIdentity"
  | "collectionsPage"
  | "productsPage"
  | "productContent";
export const shopifyReadLimits = Object.freeze({
  /** The whole read: the vault resolution, the Admin call and a THROTTLED wait. */
  budgetMaxMs: 15000,
  variablesMaxBytes: 2048,
  resultMaxBytes: 262144,
  pageSize: 25,
  /**
   * Shopify's opaque page cursor (M2 PR-3 review): a title-sorted cursor is base64 of JSON
   * that holds the last node's title, so a 255-character title in 4-byte UTF-8 with its
   * JSON stays within this; the variables carrying it within variablesMaxBytes.
   */
  cursorMaxChars: 1536,
  searchMaxChars: 64,
});
export type ShopifyReadVariables =
  | Readonly<{ query: "shopIdentity" }>
  | Readonly<{ query: "collectionsPage"; after: string | null }>
  | Readonly<{
      query: "productsPage";
      after: string | null;
      collectionId: string | null;
      search: string | null;
    }>
  | Readonly<{ query: "productContent"; productId: string }>;
const cursorPattern = /^[A-Za-z0-9+/=_-]{1,1536}$/;
const gidRef = (kind: "product" | "collection") => new RegExp(`^${kind}:[1-9][0-9]{0,19}$`);
// Letters, digits and single spaces only: the broker builds Shopify's search syntax itself.
const searchPattern = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+){0,4}$/u;
const nullable = (value: unknown, pattern: RegExp): value is string | null =>
  value === null || exact(pattern, value);
/** The closed variables of one query, or null (never a partial or extra key). */
export function parseShopifyReadVariables(
  queryName: unknown,
  variablesJson: unknown,
): ShopifyReadVariables | null {
  try {
    if (typeof variablesJson !== "string") return null;
    if (brokerUtf8Bytes(variablesJson) > shopifyReadLimits.variablesMaxBytes) return null;
    switch (queryName) {
      case "shopIdentity":
        loginJson(variablesJson, shopifyReadLimits.variablesMaxBytes, []);
        return Object.freeze({ query: "shopIdentity" });
      case "collectionsPage": {
        const v = loginJson(variablesJson, shopifyReadLimits.variablesMaxBytes, ["after"]);
        return nullable(v.after, cursorPattern)
          ? Object.freeze({ query: "collectionsPage", after: v.after })
          : null;
      }
      case "productsPage": {
        const v = loginJson(variablesJson, shopifyReadLimits.variablesMaxBytes, [
          "after",
          "collectionId",
          "search",
        ]);
        if (
          !nullable(v.after, cursorPattern) ||
          !nullable(v.collectionId, gidRef("collection")) ||
          !(
            v.search === null ||
            (typeof v.search === "string" &&
              [...v.search].length <= shopifyReadLimits.searchMaxChars &&
              searchPattern.test(v.search))
          ) ||
          (v.collectionId !== null && v.search !== null)
        )
          return null;
        return Object.freeze({
          query: "productsPage",
          after: v.after,
          collectionId: v.collectionId,
          search: v.search as string | null,
        });
      }
      case "productContent": {
        const v = loginJson(variablesJson, shopifyReadLimits.variablesMaxBytes, ["productId"]);
        return exact(gidRef("product"), v.productId)
          ? Object.freeze({ query: "productContent", productId: v.productId })
          : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
export interface ShopifyListingSnapshot {
  readonly productId: string;
  readonly title: string;
  readonly descriptionHtml: string;
  readonly seo: { readonly title: string | null; readonly description: string | null };
  readonly tags: readonly string[];
}
export type ShopifyReadResult =
  | Readonly<{
      schemaVersion: 1;
      outcome: "read";
      shop: Readonly<{ shopId: string; development: boolean }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      outcome: "read";
      collections: readonly Readonly<{ id: string; title: string }>[];
      nextCursor: string | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      outcome: "read";
      products: readonly Readonly<{ id: string; title: string; status: string }>[];
      nextCursor: string | null;
    }>
  | Readonly<{ schemaVersion: 1; outcome: "read"; product: ShopifyListingSnapshot }>
  | Readonly<{ schemaVersion: 1; outcome: "not_found" }>;
const title = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && brokerWellFormed(value);
const listingText = (value: unknown, max: number): value is string =>
  typeof value === "string" && brokerUtf8Bytes(value) <= max && brokerWellFormed(value);
const plain = (value: unknown, names: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
/**
 * The closed result of one query (the broker encodes through it; the api and the
 * orchestrator decode with it). Throws BROKER_PROTOCOL_INVALID on any other shape.
 */
export function decodeShopifyReadResult(
  queryName: ShopifyReadQuery,
  text: unknown,
): ShopifyReadResult {
  let v: unknown;
  try {
    if (typeof text !== "string" || brokerUtf8Bytes(text) > shopifyReadLimits.resultMaxBytes)
      throw invalid();
    v = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const notFound =
    plain(v, ["schemaVersion", "outcome"]) && v.schemaVersion === 1 && v.outcome === "not_found";
  if (notFound && (queryName === "productsPage" || queryName === "productContent"))
    return Object.freeze({ schemaVersion: 1, outcome: "not_found" });
  const page = (key: string) =>
    plain(v, ["schemaVersion", "outcome", key, "nextCursor"]) &&
    v.schemaVersion === 1 &&
    v.outcome === "read" &&
    Array.isArray(v[key]) &&
    (v[key] as unknown[]).length <= shopifyReadLimits.pageSize &&
    nullable(v.nextCursor, cursorPattern);
  switch (queryName) {
    case "shopIdentity": {
      if (
        plain(v, ["schemaVersion", "outcome", "shop"]) &&
        v.schemaVersion === 1 &&
        v.outcome === "read" &&
        plain(v.shop, ["shopId", "development"]) &&
        exact(/^[1-9][0-9]{0,19}$/, v.shop.shopId) &&
        typeof v.shop.development === "boolean"
      )
        return Object.freeze({
          schemaVersion: 1,
          outcome: "read",
          shop: Object.freeze({ shopId: v.shop.shopId, development: v.shop.development }),
        });
      break;
    }
    case "collectionsPage": {
      if (
        page("collections") &&
        (v as { collections: unknown[] }).collections.every(
          (c) => plain(c, ["id", "title"]) && exact(gidRef("collection"), c.id) && title(c.title),
        )
      ) {
        const r = v as { collections: { id: string; title: string }[]; nextCursor: string | null };
        return Object.freeze({
          schemaVersion: 1,
          outcome: "read",
          collections: Object.freeze(
            r.collections.map((c) => Object.freeze({ id: c.id, title: c.title })),
          ),
          nextCursor: r.nextCursor,
        });
      }
      break;
    }
    case "productsPage": {
      if (
        page("products") &&
        (v as { products: unknown[] }).products.every(
          (p) =>
            plain(p, ["id", "title", "status"]) &&
            exact(gidRef("product"), p.id) &&
            title(p.title) &&
            exact(/^[a-z][a-z_]{0,31}$/, p.status),
        )
      ) {
        const r = v as {
          products: { id: string; title: string; status: string }[];
          nextCursor: string | null;
        };
        return Object.freeze({
          schemaVersion: 1,
          outcome: "read",
          products: Object.freeze(
            r.products.map((p) => Object.freeze({ id: p.id, title: p.title, status: p.status })),
          ),
          nextCursor: r.nextCursor,
        });
      }
      break;
    }
    case "productContent": {
      const p = plain(v, ["schemaVersion", "outcome", "product"]) ? v.product : undefined;
      if (
        plain(v, ["schemaVersion", "outcome", "product"]) &&
        v.schemaVersion === 1 &&
        v.outcome === "read" &&
        plain(p, ["productId", "title", "descriptionHtml", "seo", "tags"]) &&
        exact(gidRef("product"), p.productId) &&
        listingText(p.title, 4096) &&
        listingText(p.descriptionHtml, 196608) &&
        plain(p.seo, ["title", "description"]) &&
        (p.seo.title === null || listingText(p.seo.title, 4096)) &&
        (p.seo.description === null || listingText(p.seo.description, 4096)) &&
        Array.isArray(p.tags) &&
        p.tags.length <= 250 &&
        p.tags.every((t) => listingText(t, 1024))
      ) {
        const seo = p.seo as { title: string | null; description: string | null };
        return Object.freeze({
          schemaVersion: 1,
          outcome: "read",
          product: Object.freeze({
            productId: p.productId,
            title: p.title,
            descriptionHtml: p.descriptionHtml,
            seo: Object.freeze({ title: seo.title, description: seo.description }),
            tags: Object.freeze([...(p.tags as string[])]),
          }),
        });
      }
      break;
    }
  }
  throw invalid();
}

// v1 PR 3: the gateway's apply and read-back (ADR-0022 items 7 and 9; spine §8). The api
// names one catalog_write operation of its own claim and a budget; the broker loads the
// operation, its lease, the store, the credential and the claimed proposal's item itself,
// fences the send in SQL before any request, writes the product at most once and records
// the outcome; the read-back is keyed by the operation, needs no lease and is never blocked
// by a stop or the switch. Results are closed JSON with fixed codes: never Shopify's text,
// a product value or a token.
//
// The reviewed apply switch (docs/decisions/shopify-write-staging.json, committed "off"): its
// one runtime image is the var MORROW_SHOPIFY_WRITE, exactly "on", on the staging api and
// broker. While it is off the api's apply answers 503 before any database access and the
// broker's apply answers BROKER_HELD (WRITE_UNAVAILABLE) before any input, database or
// Shopify access. Any other value is off. Production has no switch until the ADR-0007
// item 9 custody ADR.
export type BrokerShopifyWriteSwitch = "off" | "on";
export const shopifyWriteVar = "MORROW_SHOPIFY_WRITE";
export const shopifyWriteOn = "on";
export const shopifyWriteLimits = Object.freeze({
  budgetMinMs: 1,
  /** One apply call: the resolution, the pre-send read, the fence, the send and the close. */
  budgetMaxMs: 30000,
  resultMaxBytes: 512,
  /** The pre-send read and each read-back (the THROTTLED wait included). */
  readMs: 10000,
  /** The one send (and its single THROTTLED resend, inside the same fence). */
  sendMs: 15000,
  replyMaxBytes: 262144,
});
export const shopifyApplyOutcomes = Object.freeze([
  "submitted",
  "failed",
  "uncertain",
  "refused",
  "held",
  "in_flight",
  "settled",
] as const);
export type ShopifyApplyOutcome = (typeof shopifyApplyOutcomes)[number];
export const shopifyReconcileOutcomes = Object.freeze([
  "recorded",
  "closed",
  "too_soon",
  "unavailable",
  "held",
  "settled",
] as const);
export type ShopifyReconcileOutcome = (typeof shopifyReconcileOutcomes)[number];
export const operationStatusNames = Object.freeze([
  "planned",
  "awaiting_approval",
  "authorized",
  "reserved",
  "dispatching",
  "submitted",
  "verifying",
  "verified",
  "rejected",
  "conflict",
  "failed",
  "uncertain",
  "cancel_requested",
  "cancelled",
] as const);
export type OperationStatusName = (typeof operationStatusNames)[number];
export interface ShopifyApplyResult {
  readonly outcome: ShopifyApplyOutcome;
  /** The operation's status after the call, or null when it is not known (held). */
  readonly status: OperationStatusName | null;
  /** The recorded reason code of a refusal or a close, or null. */
  readonly reason: string | null;
}
export interface ShopifyReconcileResult {
  readonly outcome: ShopifyReconcileOutcome;
  readonly status: OperationStatusName | null;
  readonly verdict: "approved" | "source" | "mixed" | "missing" | null;
}
const reasonCode = /^[a-z][a-z0-9_]{2,63}$/;
export const shopifyOperationIdValid = (value: unknown): value is string =>
  exact(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, value);
export const shopifyWriteBudgetValid = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= shopifyWriteLimits.budgetMinMs &&
  (value as number) <= shopifyWriteLimits.budgetMaxMs;
function closedResult(text: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof text !== "string" || brokerUtf8Bytes(text) > shopifyWriteLimits.resultMaxBytes)
    throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",") ||
    (value as Record<string, unknown>).schemaVersion !== 1
  )
    throw invalid();
  return value as Record<string, unknown>;
}
const statusOrNull = (value: unknown): value is OperationStatusName | null =>
  value === null || (operationStatusNames as readonly unknown[]).includes(value);
export function encodeShopifyApplyResult(r: ShopifyApplyResult): string {
  if (
    !(shopifyApplyOutcomes as readonly string[]).includes(r.outcome) ||
    !statusOrNull(r.status) ||
    !(r.reason === null || exact(reasonCode, r.reason))
  )
    throw invalid();
  return JSON.stringify({
    schemaVersion: 1,
    outcome: r.outcome,
    status: r.status,
    reason: r.reason,
  });
}
export function decodeShopifyApplyResult(text: unknown): ShopifyApplyResult {
  const v = closedResult(text, ["schemaVersion", "outcome", "status", "reason"]);
  if (
    !(shopifyApplyOutcomes as readonly unknown[]).includes(v.outcome) ||
    !statusOrNull(v.status) ||
    !(v.reason === null || exact(reasonCode, v.reason))
  )
    throw invalid();
  return Object.freeze({
    outcome: v.outcome as ShopifyApplyOutcome,
    status: v.status as OperationStatusName | null,
    reason: v.reason as string | null,
  });
}
const verdicts: readonly unknown[] = ["approved", "source", "mixed", "missing", null];
export function encodeShopifyReconcileResult(r: ShopifyReconcileResult): string {
  if (
    !(shopifyReconcileOutcomes as readonly string[]).includes(r.outcome) ||
    !statusOrNull(r.status) ||
    !verdicts.includes(r.verdict)
  )
    throw invalid();
  return JSON.stringify({
    schemaVersion: 1,
    outcome: r.outcome,
    status: r.status,
    verdict: r.verdict,
  });
}
export function decodeShopifyReconcileResult(text: unknown): ShopifyReconcileResult {
  const v = closedResult(text, ["schemaVersion", "outcome", "status", "verdict"]);
  if (
    !(shopifyReconcileOutcomes as readonly unknown[]).includes(v.outcome) ||
    !statusOrNull(v.status) ||
    !verdicts.includes(v.verdict)
  )
    throw invalid();
  return Object.freeze({
    outcome: v.outcome as ShopifyReconcileOutcome,
    status: v.status as OperationStatusName | null,
    verdict: v.verdict as ShopifyReconcileResult["verdict"],
  });
}

// M5 PR-1: the ApiBroker Stripe protocol. Closed result JSON with fixed codes; never
// provider text. A hosted URL is returned to the caller and never stored (ADR-0022
// item 13); it is accepted only on Stripe's own hosts.
export const stripeLimits = Object.freeze({
  budgetMinMs: 1,
  budgetMaxMs: 10000,
  webhookBodyMaxBytes: 262144,
  // base64 of the largest body.
  webhookBase64MaxBytes: 349528,
  signatureMaxBytes: 4096,
  resultMaxBytes: 4096,
  urlMaxBytes: 2048,
});
export type StripeWriteOutcome = "verified" | "failed" | "uncertain";
/**
 * A customer operation also answers "held": still uncertain once no replay or send can
 * run, Stripe proved neither outcome, and the operation waits for the operator.
 */
export interface StripeCustomerResult {
  readonly outcome: StripeWriteOutcome | "held";
}
export interface StripeCheckoutResult {
  readonly outcome: StripeWriteOutcome | "closed" | "pending";
  readonly checkoutUrl: string | null;
  readonly expiresAtMs: number | null;
}
export interface StripePortalResult {
  readonly outcome: StripeWriteOutcome;
  readonly portalUrl: string | null;
}
export interface StripeWebhookResult {
  readonly verdict: "recorded" | "duplicate" | "rejected" | "ignored";
  readonly receiptId: string | null;
  readonly objectDigest: string | null;
  readonly attributed: boolean | null;
}
const operationIdPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const stripeOperationIdValid = (value: unknown): value is string =>
  exact(operationIdPattern, value);
export const stripeBudgetValid = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= stripeLimits.budgetMinMs &&
  (value as number) <= stripeLimits.budgetMaxMs;
const stripeUrl = (value: unknown, host: "checkout.stripe.com" | "billing.stripe.com") => {
  if (typeof value !== "string" || brokerUtf8Bytes(value) > stripeLimits.urlMaxBytes) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === host &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      url.href === value
    );
  } catch {
    return false;
  }
};
const stripeTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 8640000000000000;
const writeOutcomes: readonly string[] = ["verified", "failed", "uncertain"];

const customerOutcomes: readonly string[] = [...writeOutcomes, "held"];
export function encodeStripeCustomerResult(r: StripeCustomerResult): string {
  if (!customerOutcomes.includes(r.outcome)) throw invalid();
  return JSON.stringify({ schemaVersion: 1, outcome: r.outcome });
}
export function decodeStripeCustomerResult(text: unknown): StripeCustomerResult {
  try {
    const r = loginJson(text, stripeLimits.resultMaxBytes, ["schemaVersion", "outcome"]);
    if (r.schemaVersion !== 1 || !customerOutcomes.includes(r.outcome as string)) throw invalid();
    return Object.freeze({ outcome: r.outcome as StripeCustomerResult["outcome"] });
  } catch {
    throw invalid();
  }
}
export function encodeStripeCheckoutResult(r: StripeCheckoutResult): string {
  const value = {
    schemaVersion: 1,
    outcome: r.outcome,
    checkoutUrl: r.checkoutUrl,
    expiresAtMs: r.expiresAtMs,
  };
  decodeStripeCheckoutResult(JSON.stringify(value));
  return JSON.stringify(value);
}
export function decodeStripeCheckoutResult(text: unknown): StripeCheckoutResult {
  try {
    const r = loginJson(text, stripeLimits.resultMaxBytes, [
      "schemaVersion",
      "outcome",
      "checkoutUrl",
      "expiresAtMs",
    ]);
    const verified = r.outcome === "verified";
    if (
      r.schemaVersion !== 1 ||
      ![...writeOutcomes, "closed", "pending"].includes(r.outcome as string) ||
      (verified
        ? !stripeUrl(r.checkoutUrl, "checkout.stripe.com") || !stripeTime(r.expiresAtMs)
        : r.checkoutUrl !== null || r.expiresAtMs !== null)
    )
      throw invalid();
    return Object.freeze({
      outcome: r.outcome as StripeCheckoutResult["outcome"],
      checkoutUrl: r.checkoutUrl as string | null,
      expiresAtMs: r.expiresAtMs as number | null,
    });
  } catch {
    throw invalid();
  }
}
export function encodeStripePortalResult(r: StripePortalResult): string {
  const value = { schemaVersion: 1, outcome: r.outcome, portalUrl: r.portalUrl };
  decodeStripePortalResult(JSON.stringify(value));
  return JSON.stringify(value);
}
export function decodeStripePortalResult(text: unknown): StripePortalResult {
  try {
    const r = loginJson(text, stripeLimits.resultMaxBytes, [
      "schemaVersion",
      "outcome",
      "portalUrl",
    ]);
    if (
      r.schemaVersion !== 1 ||
      !writeOutcomes.includes(r.outcome as string) ||
      (r.outcome === "verified"
        ? !stripeUrl(r.portalUrl, "billing.stripe.com")
        : r.portalUrl !== null)
    )
      throw invalid();
    return Object.freeze({
      outcome: r.outcome as StripeWriteOutcome,
      portalUrl: r.portalUrl as string | null,
    });
  } catch {
    throw invalid();
  }
}
export function encodeStripeWebhookResult(r: StripeWebhookResult): string {
  const value = {
    schemaVersion: 1,
    verdict: r.verdict,
    receiptId: r.receiptId,
    objectDigest: r.objectDigest,
    attributed: r.attributed,
  };
  decodeStripeWebhookResult(JSON.stringify(value));
  return JSON.stringify(value);
}
export function decodeStripeWebhookResult(text: unknown): StripeWebhookResult {
  try {
    const r = loginJson(text, stripeLimits.resultMaxBytes, [
      "schemaVersion",
      "verdict",
      "receiptId",
      "objectDigest",
      "attributed",
    ]);
    const stored = r.verdict === "recorded" || r.verdict === "duplicate";
    if (
      r.schemaVersion !== 1 ||
      !["recorded", "duplicate", "rejected", "ignored"].includes(r.verdict as string) ||
      (stored
        ? !exact(operationIdPattern, r.receiptId) ||
          !exact(/^[a-f0-9]{64}$/, r.objectDigest) ||
          typeof r.attributed !== "boolean"
        : r.receiptId !== null || r.objectDigest !== null || r.attributed !== null)
    )
      throw invalid();
    return Object.freeze({
      verdict: r.verdict as StripeWebhookResult["verdict"],
      receiptId: r.receiptId as string | null,
      objectDigest: r.objectDigest as string | null,
      attributed: r.attributed as boolean | null,
    });
  } catch {
    throw invalid();
  }
}

// The broker's STRIPE_CONFIGURATION_JSON var (M5 PR-1): reviewed identifiers, not secrets.
// The saved customer portal configuration (bpc_), whether Checkout computes tax, and the
// billing-address rule; at most 1024 bytes, closed, no duplicate member. Shared by the
// broker's Stripe capability and the edge and staging checks. Anything else is
// BROKER_PROTOCOL_INVALID, and the broker's Stripe capability stays held (503).
export interface StripeConfiguration {
  readonly portalConfigurationId: string;
  readonly automaticTax: boolean;
  readonly billingAddressCollection: "auto" | "required";
}
export function parseStripeConfiguration(json: unknown): Readonly<StripeConfiguration> {
  try {
    const c = loginJson(json, 1024, [
      "schemaVersion",
      "portalConfigurationId",
      "automaticTax",
      "billingAddressCollection",
    ]);
    if (
      c.schemaVersion !== 1 ||
      !exact(/^bpc_[A-Za-z0-9]{8,64}$/, c.portalConfigurationId) ||
      typeof c.automaticTax !== "boolean" ||
      (c.billingAddressCollection !== "auto" && c.billingAddressCollection !== "required")
    )
      throw invalid();
    return Object.freeze({
      portalConfigurationId: c.portalConfigurationId,
      automaticTax: c.automaticTax,
      billingAddressCollection: c.billingAddressCollection,
    });
  } catch {
    throw invalid();
  }
}
// Only a restricted test key and a webhook signing secret are admitted (development and
// staging); a secret sk_ key and any live key are refused.
export const stripeRestrictedKeyPattern = /^rk_test_[A-Za-z0-9]{16,250}$/;
export const stripeWebhookSecretPattern = /^whsec_[A-Za-z0-9+/=_-]{16,256}$/;
