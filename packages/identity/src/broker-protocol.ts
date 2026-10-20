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
// webhook signing secret, bound only to the broker, in development and staging only.
export const brokerStripeSecrets: readonly string[] = Object.freeze([
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);
// Development and staging: every secret, the vault's and Stripe's included (16 names).
// P05.T01ab (ADR-0019 item 6): the Turnstile secret is the one provider credential admitted
// beside WorkOS under v0. It verifies tokens and cannot mint them.
export const brokerRequiredSecrets: readonly string[] = Object.freeze([
  "WORKOS_API_KEY",
  "TURNSTILE_SECRET_KEY",
  ...brokerNeonRoleNames.map(brokerPasswordSecret),
  brokerPasswordSecret(brokerVaultRole),
  ...brokerVaultKekSecrets,
  ...brokerStripeSecrets,
]);
// Production holds the vault and Stripe (trust model v1 custody is development and staging
// only, ADR-0022 item 7, until the ADR-0007 item 9 production custody ADR), so a production
// deploy requires neither a KEK, the vault login's password nor a Stripe secret (12 names).
export const brokerVaultSecrets: readonly string[] = Object.freeze([
  brokerPasswordSecret(brokerVaultRole),
  ...brokerVaultKekSecrets,
]);
export function brokerRequiredSecretsFor(
  environment: "development" | "staging" | "production",
): readonly string[] {
  return environment === "production"
    ? Object.freeze(
        brokerRequiredSecrets.filter(
          (name) => !brokerVaultSecrets.includes(name) && !brokerStripeSecrets.includes(name),
        ),
      )
    : brokerRequiredSecrets;
}
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
  // metadata and URLs from the database. Results are the closed JSON strings below.
  stripeCustomerEnsure(operationId: string, budgetMs: number): Promise<string>;
  stripeCheckoutCreate(operationId: string, budgetMs: number): Promise<string>;
  stripePortalCreate(operationId: string, budgetMs: number): Promise<string>;
  // The raw webhook body, base64 so the bytes stay exact, and the Stripe-Signature header.
  stripeWebhookVerify(
    rawBodyBase64: string,
    signatureHeader: string,
    budgetMs: number,
  ): Promise<string>;
}
// M2 PR-1 (ADR-0022 item 7, spine §4): the connector's and the orchestrator's own
// entrypoints. PR-1 gives each its health and its own role lease; the Shopify and model
// methods join with the PRs that add their database definers (M2 PR-2/PR-3, M3, M4).
export interface ConnectorBrokerRpc {
  health(): Promise<boolean>;
  neonLease(namespaceJson: string): Promise<string>;
}
export interface RuntimeBrokerRpc {
  health(): Promise<boolean>;
  neonLease(namespaceJson: string): Promise<string>;
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
