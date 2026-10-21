import {
  parseBrokerDatabaseBinding,
  type BrokerDatabaseBinding,
  type ConnectorBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";
import { loginJson } from "../../../packages/identity/src/standalone-login-protocol.js";
import type { RateLimiter } from "../../../packages/identity/src/edge-limiter.js";

// Synchronous Worker env -> the connector's configuration (M2 PR-2; ADR-0022 item 6;
// ADR-0008 items 2, 5 and 6). It never throws; the first failing check decides the code,
// and any failure keeps the connector on its deny-all instance (503 everywhere, /healthz
// ready false). The connector binds no secret and no provider credential (ADR-0008 item 2):
// every name that looks like one is refused, so a mistaken binding fails closed instead of
// being carried. Committed configuration binds only MORROW_ENVIRONMENT and the broker;
// CONNECTOR_CONFIGURATION_JSON and MORROW_DATABASE_BINDING_JSON are reviewed staging
// identifiers that arrive through the P04.T01i PR-D path. Production never maps (its
// database binding is refused until ADR-0007 item 9). The two per-address Workers rate
// limits (INSTALL_LIMITER, WEBHOOK_LIMITER; scripts/edge.mjs edgeConnectorRateLimits) are
// committed for every environment and required outside development (both or neither).

export type ConnectorEnvironmentCode =
  | "CONNECTOR_ENV_RECORD_INVALID"
  | "CONNECTOR_ENV_PROCESS_ENV_POPULATED"
  | "CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING"
  | "CONNECTOR_ENV_ENVIRONMENT_INVALID"
  | "CONNECTOR_ENV_UNBOUND"
  | "CONNECTOR_ENV_PARTIAL"
  | "CONNECTOR_ENV_VALUE_INVALID"
  | "CONNECTOR_ENV_CROSS_BINDING_MISMATCH"
  | "CONNECTOR_ENV_BROKER_BINDING_INVALID"
  | "CONNECTOR_ENV_LIMITER_INVALID";
export type ConnectorEnvironmentName = "development" | "staging" | "production";
/** The connector's ingress limits: launch, status and callback; webhooks. */
export interface ConnectorLimiters {
  readonly install: RateLimiter;
  readonly webhooks: RateLimiter;
}
export interface ConnectorConfiguration {
  /** The connector's own https origin (its own hostname, ADR-0022 item 6). */
  readonly origin: string;
  /** The api origin the merchant is sent to (the SPA's /w/:ws/connections). */
  readonly apiOrigin: string;
}
export type ConnectorEnvironmentMapping =
  | Readonly<{
      ok: true;
      environment: Exclude<ConnectorEnvironmentName, "production">;
      configuration: Readonly<ConnectorConfiguration>;
      binding: Readonly<BrokerDatabaseBinding>;
      broker: ConnectorBrokerRpc;
      /** Null only in development without the committed limiters (a lab). */
      limiters: Readonly<ConnectorLimiters> | null;
    }>
  | Readonly<{ ok: false; code: ConnectorEnvironmentCode }>;

export const connectorEnvironmentValueBindings = Object.freeze([
  ["CONNECTOR_CONFIGURATION_JSON", 1024],
  ["MORROW_DATABASE_BINDING_JSON", 4096],
] as const);
export const connectorLimiterBindings = Object.freeze([
  ["INSTALL_LIMITER", "install"],
  ["WEBHOOK_LIMITER", "webhooks"],
] as const);
const environments: readonly string[] = ["development", "staging", "production"];
// Provider credentials, database passwords and the vault keys bind only to the broker.
const providerPrefix =
  /^(WORKOS_|MORROW_DB_PASSWORD_|MORROW_VAULT_|SHOPIFY_|ANTHROPIC_|OPENAI_|STRIPE_|E2B_|NEON_|PG)/i;
const credentialWord = /KEY|SECRET|PASSWORD|TOKEN/i;
const fail = (code: ConnectorEnvironmentCode): ConnectorEnvironmentMapping =>
  Object.freeze({ ok: false, code });
function dataProperty(record: object, name: string): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor)) throw Error("CONNECTOR_ENV_ACCESSOR");
  return { present: true, value: descriptor.value };
}
// An https origin exactly (no path, credentials, port or trailing slash), at most 253 bytes
// of host; loopback http only in development (the workerd lab).
function origin(value: unknown, environment: string): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) return null;
    if (url.protocol === "https:" && url.port === "") return value;
    if (
      environment === "development" &&
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) &&
      Number(url.port) <= 65535
    )
      return value;
    return null;
  } catch {
    return null;
  }
}
export function parseConnectorConfiguration(
  json: unknown,
  environment: string,
): Readonly<ConnectorConfiguration> | null {
  try {
    const c = loginJson(json, 1024, ["schemaVersion", "origin", "apiOrigin"]);
    const own = origin(c.origin, environment);
    const api = origin(c.apiOrigin, environment);
    if (c.schemaVersion !== 1 || !own || !api || own === api) return null;
    return Object.freeze({ origin: own, apiOrigin: api });
  } catch {
    return null;
  }
}

export function mapConnectorEnvironment(env: unknown): ConnectorEnvironmentMapping {
  // 1. A plain record with string keys only.
  let keys: string[];
  try {
    if (env === null || typeof env !== "object" || Array.isArray(env))
      return fail("CONNECTOR_ENV_RECORD_INVALID");
    const own = Reflect.ownKeys(env);
    if (own.some((key) => typeof key !== "string")) return fail("CONNECTOR_ENV_RECORD_INVALID");
    keys = own as string[];
  } catch {
    return fail("CONNECTOR_ENV_RECORD_INVALID");
  }
  const record = env as object;
  // 2. Workers must not copy text bindings into process.env.
  try {
    const processEnv = (globalThis as { process?: { env?: unknown } }).process?.env;
    if (processEnv && typeof processEnv === "object" && Object.keys(processEnv).length > 0)
      return fail("CONNECTOR_ENV_PROCESS_ENV_POPULATED");
  } catch {
    return fail("CONNECTOR_ENV_PROCESS_ENV_POPULATED");
  }
  // 3. No provider credential, secret, password or token, ever (ADR-0008 item 2).
  if (keys.some((key) => providerPrefix.test(key) || credentialWord.test(key)))
    return fail("CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING");
  // 4. The Worker's own environment.
  let environment: ConnectorEnvironmentName;
  try {
    const value = dataProperty(record, "MORROW_ENVIRONMENT").value;
    if (typeof value !== "string" || !environments.includes(value))
      return fail("CONNECTOR_ENV_ENVIRONMENT_INVALID");
    environment = value as ConnectorEnvironmentName;
  } catch {
    return fail("CONNECTOR_ENV_ENVIRONMENT_INVALID");
  }
  // 5. Both configuration bindings, or none (every committed environment is unbound).
  const present = connectorEnvironmentValueBindings.filter(([name]) => Object.hasOwn(record, name));
  if (present.length === 0) return fail("CONNECTOR_ENV_UNBOUND");
  if (present.length !== connectorEnvironmentValueBindings.length)
    return fail("CONNECTOR_ENV_PARTIAL");
  let configuration: Readonly<ConnectorConfiguration> | null;
  let binding: Readonly<BrokerDatabaseBinding>;
  try {
    configuration = parseConnectorConfiguration(
      dataProperty(record, "CONNECTOR_CONFIGURATION_JSON").value,
      environment,
    );
    if (!configuration) return fail("CONNECTOR_ENV_VALUE_INVALID");
    binding = parseBrokerDatabaseBinding(
      dataProperty(record, "MORROW_DATABASE_BINDING_JSON").value,
    );
  } catch {
    return fail("CONNECTOR_ENV_VALUE_INVALID");
  }
  // 6. The database binding is this environment's (production is never bound here).
  if (binding.environment !== environment) return fail("CONNECTOR_ENV_CROSS_BINDING_MISMATCH");
  // 7. The broker service binding (ConnectorBroker entrypoint).
  let broker: ConnectorBrokerRpc;
  try {
    const value = dataProperty(record, "BROKER").value;
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function") ||
      typeof (value as { fetch?: unknown }).fetch !== "function"
    )
      return fail("CONNECTOR_ENV_BROKER_BINDING_INVALID");
    broker = value as ConnectorBrokerRpc;
  } catch {
    return fail("CONNECTOR_ENV_BROKER_BINDING_INVALID");
  }
  // 8. The ingress limits: both, each with a limit function; neither only in development.
  let limiters: Readonly<ConnectorLimiters> | null = null;
  try {
    const present = connectorLimiterBindings.filter(([name]) => Object.hasOwn(record, name));
    if (present.length === 0) {
      if (environment !== "development") return fail("CONNECTOR_ENV_LIMITER_INVALID");
    } else {
      if (present.length !== connectorLimiterBindings.length)
        return fail("CONNECTOR_ENV_LIMITER_INVALID");
      const bound: Partial<Record<keyof ConnectorLimiters, RateLimiter>> = {};
      for (const [name, key] of connectorLimiterBindings) {
        const value = dataProperty(record, name).value;
        if (
          value === null ||
          (typeof value !== "object" && typeof value !== "function") ||
          typeof (value as { limit?: unknown }).limit !== "function"
        )
          return fail("CONNECTOR_ENV_LIMITER_INVALID");
        bound[key] = value as RateLimiter;
      }
      limiters = Object.freeze(bound as ConnectorLimiters);
    }
  } catch {
    return fail("CONNECTOR_ENV_LIMITER_INVALID");
  }
  return Object.freeze({
    ok: true,
    environment: binding.environment,
    configuration,
    binding,
    broker,
    limiters,
  });
}
