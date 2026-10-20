import { createWorkersFixedWorkosLoginPort } from "../../../packages/identity/src/fixed-workos-login-port.js";
import type { FixedWorkosLoginPort } from "../../../packages/identity/src/standalone-login.js";
import {
  parseLoginConfiguration,
  type LoginControl,
} from "../../../packages/identity/src/standalone-login-protocol.js";
import {
  brokerNeonRoleNames,
  brokerPasswordSecret,
  brokerPasswordValid,
  neonLeaseNamespace,
  parseBrokerDatabaseBinding,
  parseTurnstileConfiguration,
  turnstileKeyPattern,
  workosSessionNamespace,
} from "../../../packages/identity/src/broker-protocol.js";
import { loginJson } from "../../../packages/identity/src/standalone-login-protocol.js";

// Broker v0 trust model (ADR-0007 item 3): every holder of the ApiBroker binding
// is trusted for these pre-authentication identity calls and role leases only.
// No merchant, model or other provider credential may be added under it; the
// Turnstile secret is the one admitted beside WorkOS (ADR-0019 item 6).

export type BrokerMethod = "health" | "neonLease" | "workosSessionPage" | "challengeVerify";
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
// P05.T01ab: siteverify for the configured hostname and the two configured actions.
export interface BrokerChallenge {
  readonly secret: string;
  readonly hostname: string;
  readonly actions: readonly string[];
}
export interface BrokerCapabilities {
  readonly sessions: Readonly<BrokerSessions> | null;
  readonly database: Readonly<BrokerDatabase> | null;
  readonly challenge: Readonly<BrokerChallenge> | null;
  // Hosted environments sign in only behind the guard (ADR-0019 item 6), so their
  // health also needs the challenge capability; development may run without it.
  readonly challengeRequired: boolean;
}

const nothing: Readonly<BrokerCapabilities> = Object.freeze({
  sessions: null,
  database: null,
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

function database(env: object, environment: string): Readonly<BrokerDatabase> | null {
  try {
    const binding = parseBrokerDatabaseBinding(own(env, "MORROW_DATABASE_BINDING_JSON"));
    if (binding.environment !== environment) return null;
    const leases = new Map<string, string>();
    for (const role of brokerNeonRoleNames) {
      const password = own(env, brokerPasswordSecret(role));
      if (!brokerPasswordValid(password)) return null;
      leases.set(neonLeaseNamespace(binding, role), password);
    }
    return Object.freeze({ leases });
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
        database: database(env, environment),
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

// Every failure becomes the single error BROKER_HELD plus one fixed log line.
// No value, URL, namespace field or secret is logged or returned.
export async function invokeBrokerMethod<T>(
  method: BrokerMethod,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code: BrokerFailureCode =
      error instanceof BrokerHold ? error.code : "CAPABILITY_UNAVAILABLE";
    console.log(JSON.stringify({ event: "morrow_broker", method, code }));
    throw Error("BROKER_HELD");
  }
}

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

export function brokerInputInvalid(method: BrokerMethod): Promise<never> {
  return invokeBrokerMethod(method, () => Promise.reject(new BrokerHold("INPUT_INVALID")));
}
