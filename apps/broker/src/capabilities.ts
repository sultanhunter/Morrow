import { createWorkersFixedWorkosLoginPort } from "../../../packages/identity/src/fixed-workos-login-port.js";
import type { FixedWorkosLoginPort } from "../../../packages/identity/src/standalone-login.js";
import {
  loginJson,
  parseLoginConfiguration,
  type LoginControl,
} from "../../../packages/identity/src/standalone-login-protocol.js";
import {
  agentLoopOn,
  agentLoopVar,
  anthropicKeyPattern,
  brokerCallerRoles,
  brokerPasswordSecret,
  brokerPasswordValid,
  brokerVaultKekSecrets,
  brokerVaultRole,
  e2bKeyPattern,
  modelProviderAnthropic,
  modelProviderVar,
  neonLeaseNamespace,
  parseBrokerDatabaseBinding,
  parseConnectorWebhookOrigin,
  runtimeProviderE2b,
  runtimeSwitchVar,
  parseStripeConfiguration,
  parseTurnstileConfiguration,
  shopifyWriteOn,
  shopifyWriteVar,
  stripeModeTest,
  stripeModeVar,
  stripeRestrictedKeyPattern,
  stripeWebhookSecretPattern,
  turnstileKeyPattern,
  workosSessionNamespace,
  type BrokerCaller,
  type BrokerDatabaseBinding,
} from "../../../packages/identity/src/broker-protocol.js";
import type { BrokerStripe } from "./stripe.js";
import { createVaultKeyring, type VaultKeyring } from "./vault.js";

// Broker v0 trust model (ADR-0007 item 3): every holder of the ApiBroker binding
// is trusted for these pre-authentication identity calls and role leases only.
// No merchant, model or other provider credential may be added under it; the
// Turnstile secret is the one admitted beside WorkOS (ADR-0019 item 6).
// Trust model v1 (ADR-0022 item 7) adds one entrypoint per caller, each serving only
// its own role lease; the vault keys stay inside the broker and never cross RPC.

export type BrokerEntrypoint = "ApiBroker" | "ConnectorBroker" | "RuntimeBroker";
// Append-only: each PR adds its own entrypoint's methods (M2 PR-2: ConnectorBroker's three
// Shopify methods; M5 PR-1: ApiBroker's four Stripe methods).
export type BrokerMethod =
  | "health"
  | "neonLease"
  | "workosSessionPage"
  | "challengeVerify"
  | "shopifyLaunchVerify"
  | "shopifyInstallComplete"
  | "shopifyWebhookVerify"
  // M2 PR-3: the token's destruction (ConnectorBroker) and the fixed reads (ApiBroker,
  // RuntimeBroker).
  | "shopifyCredentialDestroy"
  | "shopifyRead"
  // M5 PR-1 (ApiBroker): Stripe on one pinned API version, ids only.
  | "stripeCustomerEnsure"
  | "stripeCheckoutCreate"
  | "stripePortalCreate"
  | "stripeWebhookVerify"
  // M3 PR-2 (RuntimeBroker): the provider-neutral model gateway.
  | "modelRespond"
  // Build order PR 11 (RuntimeBroker): the agent loop's turn gateway (ModelCall@2).
  | "modelTurn"
  // Build order PR 7 (RuntimeBroker): the computer's door and its reconciliation sweep.
  | "runtimeExecute"
  | "runtimeSweep"
  // v1 PR 3 (ApiBroker): the gateway's apply and read-back of one catalog_write operation.
  | "shopifyProductApply"
  | "shopifyProductReconcile"
  // v1 PR 4 (ApiBroker): the undo check of one verified catalog_write operation.
  | "shopifyProductUndoCheck"
  // ConnectorBroker: the shop-specific app/uninstalled and app/scopes_update subscriptions.
  | "shopifyWebhookSubscriptionsSync";
export type BrokerFailureCode =
  | "INPUT_INVALID"
  | "NAMESPACE_DENIED"
  | "CAPABILITY_UNAVAILABLE"
  | "BUDGET_INVALID"
  | "PROVIDER_HELD"
  // M2 PR-2 review: the isolate's Shopify ingress slots on the vault login are all in use.
  | "INGRESS_BUSY"
  | "STATE_INVALID"
  // M5 (owner decision (c), 2026-10-21): the Stripe switch is off; no Stripe method runs.
  | "STRIPE_UNAVAILABLE"
  // M2 PR-3: a read the vault resolution refused (lease, stop, store or credential), or a
  // reply Shopify refused; and a vault COMMIT whose acknowledgement was lost (the caller
  // retries: every M2 PR-3 write is idempotent).
  | "READ_REFUSED"
  // M2 PR-3 review: the isolate's read slots on the vault login are all in use.
  | "READ_BUSY"
  | "OUTCOME_UNKNOWN"
  // M3 PR-2: the model-provider switch is off (or its key is missing); no model call runs.
  | "MODEL_UNAVAILABLE"
  // Build order PR 7: the runtime switch is off (or its key, adapter or template is
  // missing); no sandbox is created or reconciled.
  | "RUNTIME_UNAVAILABLE"
  // v1 PR 3: the apply switch is off; no Shopify write runs. And the isolate's one write
  // slot on the vault login is in use.
  | "WRITE_UNAVAILABLE"
  | "WRITE_BUSY"
  // Shop-specific webhook subscriptions: no connector origin or no vault in this broker, and
  // the isolate's one sync is already running.
  | "WEBHOOKS_UNAVAILABLE"
  | "WEBHOOKS_BUSY";
export class BrokerHold extends Error {
  constructor(readonly code: BrokerFailureCode) {
    super("BROKER_HELD");
  }
}
export interface BrokerSessions {
  readonly namespace: string;
  readonly port: Readonly<FixedWorkosLoginPort>;
}
export interface BrokerDatabase {
  // Exact namespace JSON -> that role's static password. Lookup is byte equality.
  readonly leases: ReadonlyMap<string, string>;
}
// The vault (ADR-0022 item 7): the KEK keyring and the broker's own database login, with
// the database binding its transport connects to (M2 PR-2, vault-database.ts). None of it
// is ever returned by a method.
export interface BrokerVault {
  readonly keyring: VaultKeyring;
  readonly databasePassword: string;
  readonly binding: Readonly<BrokerDatabaseBinding>;
}
// P05.T01ab: siteverify for the configured hostname and the two configured actions.
export interface BrokerChallenge {
  readonly secret: string;
  readonly hostname: string;
  readonly actions: readonly string[];
}
// M3 PR-2 (ADR-0022 items 7 and 10): the model provider's credential, the Anthropic Console
// workspace's API key. It never crosses RPC; the Claude adapter receives it per request.
export interface BrokerModel {
  readonly provider: "anthropic";
  readonly apiKey: string;
}
// Build order PR 7 (ADR-0029 item 3): the computer's provider credential, E2B's API key. It
// never crosses RPC and never enters a sandbox; an adapter receives it per request. (Named
// `computer` because `runtime` is the orchestrator's role lease above.)
export interface BrokerComputer {
  readonly provider: "e2b";
  readonly apiKey: string;
}
export interface BrokerCapabilities {
  readonly sessions: Readonly<BrokerSessions> | null;
  /** The api caller's eight role leases (ApiBroker). */
  readonly database: Readonly<BrokerDatabase> | null;
  /** The connector's own role lease (ConnectorBroker). */
  readonly connector: Readonly<BrokerDatabase> | null;
  /** The orchestrator's own role lease (RuntimeBroker). */
  readonly runtime: Readonly<BrokerDatabase> | null;
  readonly vault: Readonly<BrokerVault> | null;
  readonly challenge: Readonly<BrokerChallenge> | null;
  /** M5 PR-1: the Stripe restricted test key, webhook secret and configuration (ApiBroker). */
  readonly stripe: Readonly<BrokerStripe> | null;
  /**
   * The Stripe switch as this broker sees it: "test" only with MORROW_STRIPE_MODE exactly
   * "test" in development or staging; "off" otherwise, and then `stripe` is null and no
   * Stripe secret or configuration is read.
   */
  readonly stripeMode: "off" | "test";
  /** M3 PR-2: the model provider's key, only while the model-provider switch is on. */
  readonly model: Readonly<BrokerModel> | null;
  /** The model-provider switch as this broker sees it (MORROW_MODEL_PROVIDER "anthropic"). */
  readonly modelMode: "off" | "anthropic";
  /** Build order PR 7: the E2B key, only while the runtime switch is not off. */
  readonly computer: Readonly<BrokerComputer> | null;
  /** The runtime switch as this broker sees it (MORROW_RUNTIME_SWITCH). */
  readonly computerMode: "off" | "cleanup_only" | "on";
  /**
   * v1 PR 3: the apply switch as this broker sees it: "on" only with MORROW_SHOPIFY_WRITE
   * exactly "on", in development or staging, with the vault (the fence's definers run on the
   * broker's own login). Absent (the committed state) or anything else is off.
   */
  readonly shopifyWrite: "off" | "on";
  /**
   * Build order PR 11: the agent-loop switch as this broker sees it: "on" only with
   * MORROW_AGENT_LOOP exactly "on", in development or staging, with the vault (the turn
   * fence's definers run on the broker's own login). Absent (the committed state) or anything
   * else is off, and modelTurn holds every call.
   */
  readonly agentLoop: "off" | "on";
  /**
   * Shop-specific webhook subscriptions: the connector's own origin, from
   * CONNECTOR_CONFIGURATION_JSON (byte-equal to the connector's, which edge:check holds), in
   * development or staging and only with the vault (the registration definers run on the
   * broker's own login). The broker builds every subscription's callback URL from it alone;
   * absent or malformed holds the sync (WEBHOOKS_UNAVAILABLE).
   */
  readonly shopifyWebhookOrigin: string | null;
  // Hosted environments sign in only behind the guard (ADR-0019 item 6), so their
  // health also needs the challenge capability; development may run without it.
  readonly challengeRequired: boolean;
}

const nothing: Readonly<BrokerCapabilities> = Object.freeze({
  sessions: null,
  database: null,
  connector: null,
  runtime: null,
  vault: null,
  challenge: null,
  stripe: null,
  stripeMode: "off",
  model: null,
  modelMode: "off",
  computer: null,
  computerMode: "off",
  shopifyWrite: "off",
  agentLoop: "off",
  shopifyWebhookOrigin: null,
  challengeRequired: true,
});
const environments = ["development", "staging", "production"] as const;
const initialisations = new WeakMap<object, Promise<Readonly<BrokerCapabilities>>>();

// Fixed binding names, read as own data properties only (no getters, no prototype).
function own(env: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

async function sessions(
  env: object,
  environment: string,
): Promise<Readonly<BrokerSessions> | null> {
  try {
    const configurationJson = own(env, "LOGIN_CONFIGURATION_JSON");
    const key = own(env, "WORKOS_API_KEY");
    if (typeof configurationJson !== "string" || typeof key !== "string") return null;
    const configuration = await parseLoginConfiguration(configurationJson);
    const keyPattern =
      environment === "production"
        ? /^sk_live_[\x21-\x7e]{8,4088}$/
        : /^sk_test_[\x21-\x7e]{8,4088}$/;
    if (configuration.retentionTier !== environment || !keyPattern.test(key)) return null;
    const namespace = workosSessionNamespace(configurationJson);
    // Broker-local custody: this borrow is reachable only from the port below,
    // only for the one session-catalogue namespace, and never crosses RPC.
    const sessionCredentialBroker = Object.freeze({
      borrow(namespaceJson: string, control: Readonly<LoginControl>): Promise<unknown> {
        if (namespaceJson !== namespace) return Promise.reject(Error("BROKER_KEY_DENIED"));
        return Promise.resolve(
          Object.freeze({
            namespaceJson,
            credential: key,
            expiresAtMs: control.deadlineMs,
            revocationSignal: new AbortController().signal,
            release: async () => {},
          }),
        );
      },
    });
    const port = await createWorkersFixedWorkosLoginPort({
      configurationJson,
      sessionCredentialBroker,
      now: () => Date.now(),
    });
    return Object.freeze({ namespace, port });
  } catch {
    return null;
  }
}

// One caller's leases: every role of that caller must hold a valid password, else none.
function database(
  env: object,
  environment: string,
  caller: BrokerCaller,
): Readonly<BrokerDatabase> | null {
  try {
    const binding = parseBrokerDatabaseBinding(own(env, "MORROW_DATABASE_BINDING_JSON"));
    if (binding.environment !== environment) return null;
    const leases = new Map<string, string>();
    for (const role of brokerCallerRoles[caller]) {
      const password = own(env, brokerPasswordSecret(role));
      if (!brokerPasswordValid(password)) return null;
      leases.set(neonLeaseNamespace(binding, role), password);
    }
    return Object.freeze({ leases });
  } catch {
    return null;
  }
}

// The vault needs every configured KEK version and the broker's own database login, in an
// environment with a database binding. A missing or malformed secret disables the vault
// only; no other capability depends on it. Production holds it: trust model v1 custody is
// for development and staging (ADR-0022 item 7) until the production custody ADR
// (ADR-0007 item 9), whatever secrets are bound.
async function vault(env: object, environment: string): Promise<Readonly<BrokerVault> | null> {
  if (environment === "production") return null;
  try {
    const binding = parseBrokerDatabaseBinding(own(env, "MORROW_DATABASE_BINDING_JSON"));
    if (binding.environment !== environment) return null;
    const databasePassword = own(env, brokerPasswordSecret(brokerVaultRole));
    if (!brokerPasswordValid(databasePassword)) return null;
    const keks = new Map<number, unknown>();
    for (const name of brokerVaultKekSecrets) {
      const match = /^MORROW_VAULT_KEK_V([1-9][0-9]{0,2})$/.exec(name);
      if (!match) return null;
      keks.set(Number(match[1]), own(env, name));
    }
    const keyring = await createVaultKeyring(environment, keks);
    return Object.freeze({ keyring, databasePassword, binding });
  } catch {
    return null;
  }
}

// TURNSTILE_CONFIGURATION_JSON {schemaVersion:1, hostname, actions} and the 0x secret.
// The hostname must be the login origin's: Turnstile reports where it was solved.
// parseTurnstileConfiguration is shared with the staging deploy's gate 4.
function challenge(env: object): Readonly<BrokerChallenge> | null {
  try {
    const secret = own(env, "TURNSTILE_SECRET_KEY");
    if (typeof secret !== "string" || turnstileKeyPattern.exec(secret)?.[0] !== secret) return null;
    const login = loginJson(own(env, "LOGIN_CONFIGURATION_JSON"), 32768, [
      "schemaVersion",
      "controllerProtocol",
      "origin",
      "retentionTier",
      "authenticationBindingJson",
      "verificationProfileJson",
      "profileId",
      "profileRecordRevision",
    ]);
    const { hostname, actions } = parseTurnstileConfiguration(
      own(env, "TURNSTILE_CONFIGURATION_JSON"),
      login.origin,
    );
    return Object.freeze({
      secret,
      hostname,
      actions: Object.freeze([actions.login, actions.signup]),
    });
  } catch {
    return null;
  }
}

// The Stripe switch (owner decision (c), 2026-10-21): on only with the reviewed var
// MORROW_STRIPE_MODE exactly "test", in development or staging. Absent (the committed
// staging state while the switch is off) or any other value is off.
function stripeMode(env: object, environment: string): "off" | "test" {
  return environment !== "production" && own(env, stripeModeVar) === stripeModeTest
    ? "test"
    : "off";
}

// M5 PR-1 (ADR-0022 items 7 and 12): the restricted test key (rk_test_ only: a secret sk_
// key or any live key is refused), the webhook signing secret, STRIPE_CONFIGURATION_JSON
// (the saved portal configuration and the tax and address flags, a reviewed staging
// identifier) and the workspace origin Checkout returns to. Development and staging only,
// only while the switch is on, and only with the vault: the Stripe definers run on the
// broker's own login. Anything missing or malformed holds Stripe only (its methods answer
// BROKER_HELD; billing 503). While the switch is off nothing here is read.
function stripe(
  env: object,
  environment: string,
  vaultCapability: Readonly<BrokerVault> | null,
): Readonly<BrokerStripe> | null {
  if (
    environment === "production" ||
    stripeMode(env, environment) !== "test" ||
    vaultCapability === null
  )
    return null;
  try {
    const restrictedKey = own(env, "STRIPE_RESTRICTED_KEY");
    const webhookSecret = own(env, "STRIPE_WEBHOOK_SECRET");
    if (
      typeof restrictedKey !== "string" ||
      stripeRestrictedKeyPattern.exec(restrictedKey)?.[0] !== restrictedKey ||
      typeof webhookSecret !== "string" ||
      stripeWebhookSecretPattern.exec(webhookSecret)?.[0] !== webhookSecret
    )
      return null;
    const configuration = parseStripeConfiguration(own(env, "STRIPE_CONFIGURATION_JSON"));
    const login = loginJson(own(env, "LOGIN_CONFIGURATION_JSON"), 32768, [
      "schemaVersion",
      "controllerProtocol",
      "origin",
      "retentionTier",
      "authenticationBindingJson",
      "verificationProfileJson",
      "profileId",
      "profileRecordRevision",
    ]);
    const origin = login.origin;
    if (typeof origin !== "string" || login.retentionTier !== environment) return null;
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:") return null;
    return Object.freeze({
      environment: environment as "development" | "staging",
      restrictedKey,
      webhookSecret,
      configuration,
      returnOrigin: origin,
    });
  } catch {
    return null;
  }
}

// The model-provider switch (M3 PR-2): on only with MORROW_MODEL_PROVIDER exactly
// "anthropic", in development or staging, with the vault (the fence's definers run on the
// broker's own login) and an Anthropic Console key of the expected shape. Absent (the
// committed state while the switch is off) or anything else is off, and then the key is not
// read at all.
function modelMode(env: object, environment: string): "off" | "anthropic" {
  return environment !== "production" && own(env, modelProviderVar) === modelProviderAnthropic
    ? "anthropic"
    : "off";
}
function model(
  env: object,
  environment: string,
  vaultCapability: Readonly<BrokerVault> | null,
): Readonly<BrokerModel> | null {
  if (modelMode(env, environment) !== "anthropic" || vaultCapability === null) return null;
  const apiKey = own(env, "ANTHROPIC_API_KEY");
  if (typeof apiKey !== "string" || anthropicKeyPattern.exec(apiKey)?.[0] !== apiKey) return null;
  return Object.freeze({ provider: "anthropic" as const, apiKey });
}

// The runtime switch (build order PR 7; ADR-0029 item 10): "on" or "cleanup_only" only with
// MORROW_RUNTIME_SWITCH exactly that value, in development or staging; absent (the committed
// state while the switch is off) or anything else is off, and then E2B_API_KEY is not read at
// all, even if the owner placed it ahead of the switch.
function computerMode(env: object, environment: string): "off" | "cleanup_only" | "on" {
  if (environment === "production") return "off";
  const value = own(env, runtimeSwitchVar);
  return value === "on" ? "on" : value === "cleanup_only" ? "cleanup_only" : "off";
}
function computer(
  env: object,
  environment: string,
  vaultCapability: Readonly<BrokerVault> | null,
): Readonly<BrokerComputer> | null {
  if (computerMode(env, environment) === "off" || vaultCapability === null) return null;
  const apiKey = own(env, "E2B_API_KEY");
  if (typeof apiKey !== "string" || e2bKeyPattern.exec(apiKey)?.[0] !== apiKey) return null;
  return Object.freeze({ provider: runtimeProviderE2b, apiKey });
}
// The apply switch (v1 PR 3): on only with MORROW_SHOPIFY_WRITE exactly "on", in development
// or staging, and only with the vault. Production holds it until the custody ADR.
function shopifyWrite(
  env: object,
  environment: string,
  vaultCapability: Readonly<BrokerVault> | null,
): "off" | "on" {
  return environment !== "production" &&
    vaultCapability !== null &&
    own(env, shopifyWriteVar) === shopifyWriteOn
    ? "on"
    : "off";
}

// The agent-loop switch (build order PR 11): on only with MORROW_AGENT_LOOP exactly "on",
// in development or staging, and only with the vault.
function agentLoop(
  env: object,
  environment: string,
  vaultCapability: Readonly<BrokerVault> | null,
): "off" | "on" {
  return environment !== "production" &&
    vaultCapability !== null &&
    own(env, agentLoopVar) === agentLoopOn
    ? "on"
    : "off";
}

// Shop-specific webhook subscriptions: the connector's origin from its own reviewed
// configuration, parsed as the connector parses it; development or staging, and only with
// the vault. Production holds it with the vault.
function shopifyWebhookOrigin(
  env: object,
  environment: string,
  vaultCapability: Readonly<BrokerVault> | null,
): string | null {
  if (environment === "production" || vaultCapability === null) return null;
  try {
    return parseConnectorWebhookOrigin(own(env, "CONNECTOR_CONFIGURATION_JSON"), environment);
  } catch {
    return null;
  }
}

async function initialise(env: object): Promise<Readonly<BrokerCapabilities>> {
  let result = nothing;
  try {
    const environment = own(env, "MORROW_ENVIRONMENT");
    if (
      typeof environment === "string" &&
      (environments as readonly string[]).includes(environment)
    ) {
      const vaultCapability = await vault(env, environment);
      result = Object.freeze({
        sessions: await sessions(env, environment),
        database: database(env, environment, "api"),
        connector: database(env, environment, "connector"),
        runtime: database(env, environment, "runtime"),
        vault: vaultCapability,
        challenge: challenge(env),
        stripe: stripe(env, environment, vaultCapability),
        stripeMode: stripeMode(env, environment),
        model: model(env, environment, vaultCapability),
        modelMode: modelMode(env, environment),
        computer: computer(env, environment, vaultCapability),
        computerMode: computerMode(env, environment),
        shopifyWrite: shopifyWrite(env, environment, vaultCapability),
        agentLoop: agentLoop(env, environment, vaultCapability),
        shopifyWebhookOrigin: shopifyWebhookOrigin(env, environment, vaultCapability),
        challengeRequired: environment !== "development",
      });
    }
  } catch {
    result = nothing;
  }
  console.log(
    JSON.stringify({
      event: "morrow_broker_init",
      sessions: result.sessions !== null,
      database: result.database !== null,
      connector: result.connector !== null,
      runtime: result.runtime !== null,
      vault: result.vault !== null,
      challenge: result.challenge !== null,
      stripe: result.stripe !== null,
      stripeMode: result.stripeMode,
      model: result.model !== null,
      modelMode: result.modelMode,
      computer: result.computer !== null,
      computerMode: result.computerMode,
      shopifyWrite: result.shopifyWrite,
      agentLoop: result.agentLoop,
      shopifyWebhooks: result.shopifyWebhookOrigin !== null,
    }),
  );
  return result;
}

// Memoised per isolate (per env object) with one in-flight initialisation that
// concurrent first calls share. It never rejects; a failure stays held.
const initialised = new WeakSet<object>();
export function brokerCapabilities(env: unknown): Promise<Readonly<BrokerCapabilities>> {
  if (!env || typeof env !== "object") return Promise.resolve(nothing);
  let pending = initialisations.get(env);
  if (!pending) {
    pending = initialise(env)
      .catch(() => nothing)
      .finally(() => initialised.add(env));
    initialisations.set(env, pending);
  }
  return pending;
}
/**
 * Whether this isolate has finished initialising the capabilities of `env` (a call that
 * finds false waits for the initialisation: a cold isolate, for the Shopify stage line).
 */
export function brokerCapabilitiesWarm(env: unknown): boolean {
  return !!env && typeof env === "object" && initialised.has(env);
}

// Every failure becomes the single error BROKER_HELD plus one fixed log line naming the
// entrypoint and method. No value, URL, namespace field or secret is logged or returned.
export async function invokeBrokerMethod<T>(
  method: BrokerMethod,
  run: () => Promise<T>,
  entrypoint: BrokerEntrypoint = "ApiBroker",
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code: BrokerFailureCode =
      error instanceof BrokerHold ? error.code : "CAPABILITY_UNAVAILABLE";
    console.log(JSON.stringify({ event: "morrow_broker", entrypoint, method, code }));
    throw Error("BROKER_HELD");
  }
}

export const brokerEntrypoints: Readonly<Record<BrokerCaller, BrokerEntrypoint>> = Object.freeze({
  api: "ApiBroker",
  connector: "ConnectorBroker",
  runtime: "RuntimeBroker",
});

export function brokerHealth(env: unknown): Promise<boolean> {
  return invokeBrokerMethod("health", async () => {
    const capabilities = await brokerCapabilities(env);
    return (
      capabilities.sessions !== null &&
      capabilities.database !== null &&
      (capabilities.challenge !== null || !capabilities.challengeRequired)
    );
  });
}

// The connector and the orchestrator are ready when their own lease and the vault are.
export function brokerCallerHealth(
  env: unknown,
  caller: "connector" | "runtime",
): Promise<boolean> {
  return invokeBrokerMethod(
    "health",
    async () => {
      const capabilities = await brokerCapabilities(env);
      return capabilities[caller] !== null && capabilities.vault !== null;
    },
    brokerEntrypoints[caller],
  );
}

export function brokerInputInvalid(
  method: BrokerMethod,
  entrypoint: BrokerEntrypoint = "ApiBroker",
): Promise<never> {
  return invokeBrokerMethod(
    method,
    () => Promise.reject(new BrokerHold("INPUT_INVALID")),
    entrypoint,
  );
}
