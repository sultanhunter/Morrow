import { createWorkersFixedWorkosLoginPort } from "../../../packages/identity/src/fixed-workos-login-port.js";
import type { FixedWorkosLoginPort } from "../../../packages/identity/src/standalone-login.js";
import {
  loginJson,
  parseLoginConfiguration,
  type LoginControl,
} from "../../../packages/identity/src/standalone-login-protocol.js";
import {
  brokerCallerRoles,
  brokerPasswordSecret,
  brokerPasswordValid,
  brokerVaultKekSecrets,
  brokerVaultRole,
  neonLeaseNamespace,
  parseBrokerDatabaseBinding,
  parseTurnstileConfiguration,
  turnstileKeyPattern,
  workosSessionNamespace,
  type BrokerCaller,
  type BrokerDatabaseBinding,
} from "../../../packages/identity/src/broker-protocol.js";
import { createVaultKeyring, type VaultKeyring } from "./vault.js";

// Broker v0 trust model (ADR-0007 item 3): every holder of the ApiBroker binding
// is trusted for these pre-authentication identity calls and role leases only.
// No merchant, model or other provider credential may be added under it; the
// Turnstile secret is the one admitted beside WorkOS (ADR-0019 item 6).
// Trust model v1 (ADR-0022 item 7) adds one entrypoint per caller, each serving only
// its own role lease; the vault keys stay inside the broker and never cross RPC.

export type BrokerEntrypoint = "ApiBroker" | "ConnectorBroker" | "RuntimeBroker";
// Append-only: each PR adds its own entrypoint's methods (M2 PR-2: ConnectorBroker's three
// Shopify methods).
export type BrokerMethod =
  | "health"
  | "neonLease"
  | "workosSessionPage"
  | "challengeVerify"
  | "shopifyLaunchVerify"
  | "shopifyInstallComplete"
  | "shopifyWebhookVerify";
export type BrokerFailureCode =
  | "INPUT_INVALID"
  | "NAMESPACE_DENIED"
  | "CAPABILITY_UNAVAILABLE"
  | "BUDGET_INVALID"
  | "PROVIDER_HELD";
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

async function initialise(env: object): Promise<Readonly<BrokerCapabilities>> {
  let result = nothing;
  try {
    const environment = own(env, "MORROW_ENVIRONMENT");
    if (
      typeof environment === "string" &&
      (environments as readonly string[]).includes(environment)
    )
      result = Object.freeze({
        sessions: await sessions(env, environment),
        database: database(env, environment, "api"),
        connector: database(env, environment, "connector"),
        runtime: database(env, environment, "runtime"),
        vault: await vault(env, environment),
        challenge: challenge(env),
        challengeRequired: environment !== "development",
      });
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
    }),
  );
  return result;
}

// Memoised per isolate (per env object) with one in-flight initialisation that
// concurrent first calls share. It never rejects; a failure stays held.
export function brokerCapabilities(env: unknown): Promise<Readonly<BrokerCapabilities>> {
  if (!env || typeof env !== "object") return Promise.resolve(nothing);
  let pending = initialisations.get(env);
  if (!pending) {
    pending = initialise(env).catch(() => nothing);
    initialisations.set(env, pending);
  }
  return pending;
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
