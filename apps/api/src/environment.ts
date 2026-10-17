import type { ApiBrokerRpc } from "../../../packages/identity/src/broker-protocol.js";
import { captureManagedWorkspaceBinding } from "../../../packages/identity/src/managed-workspace-binding.js";
import { loginJson } from "../../../packages/identity/src/standalone-login-protocol.js";

// Synchronous Worker env -> ManagedWorkspaceApiDependencies inputs (P04.T02a D6).
// It never throws; the first failing check decides the code, and any failure
// keeps the api on the existing deny-all instance. Production never maps here
// (ADR-0007 item 9).

export type ApiEnvironmentCode =
  | "API_ENV_RECORD_INVALID"
  | "API_ENV_PROCESS_ENV_POPULATED"
  | "API_ENV_FORBIDDEN_CREDENTIAL_BINDING"
  | "API_ENV_ENVIRONMENT_INVALID"
  | "API_ENV_UNBOUND"
  | "API_ENV_PARTIAL"
  | "API_ENV_VALUE_INVALID"
  | "API_ENV_CROSS_BINDING_MISMATCH"
  | "API_ENV_BROKER_BINDING_INVALID";
export type ApiEnvironmentName = "development" | "staging" | "production";
export interface ApiEnvironmentValues {
  readonly login: string;
  readonly workspace: string;
  readonly logout: string;
  readonly binding: string;
  readonly keyring: string;
}
export type ApiEnvironmentMapping =
  | Readonly<{
      ok: true;
      environment: ApiEnvironmentName;
      values: Readonly<ApiEnvironmentValues>;
      broker: ApiBrokerRpc;
    }>
  | Readonly<{ ok: false; code: ApiEnvironmentCode }>;

// Binding name, value key and the identity byte limit it must not exceed.
export const apiEnvironmentValueBindings = Object.freeze([
  ["LOGIN_CONFIGURATION_JSON", "login", 32768],
  ["WORKSPACE_CONFIGURATION_JSON", "workspace", 2048],
  ["LOGOUT_CONFIGURATION_JSON", "logout", 8192],
  ["MORROW_DATABASE_BINDING_JSON", "binding", 4096],
  ["LOGIN_CAPSULE_KEYRING", "keyring", 4096],
] as const);
const environments: readonly string[] = ["development", "staging", "production"];
const providerPrefix = /^(WORKOS_|MORROW_DB_PASSWORD_|SHOPIFY_|OPENAI_|E2B_|NEON_|PG)/i;
const credentialWord = /KEY|SECRET|PASSWORD|TOKEN/i;
const encoder = new TextEncoder();
const fail = (code: ApiEnvironmentCode): ApiEnvironmentMapping =>
  Object.freeze({ ok: false, code });

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function dataProperty(record: object, name: string): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor)) throw Error("API_ENV_ACCESSOR");
  return { present: true, value: descriptor.value };
}

export function mapApiEnvironment(env: unknown): ApiEnvironmentMapping {
  // 1. A plain record with string keys only.
  let keys: string[];
  try {
    if (env === null || typeof env !== "object" || Array.isArray(env))
      return fail("API_ENV_RECORD_INVALID");
    const own = Reflect.ownKeys(env);
    if (own.some((key) => typeof key !== "string")) return fail("API_ENV_RECORD_INVALID");
    keys = own as string[];
  } catch {
    return fail("API_ENV_RECORD_INVALID");
  }
  const record = env as object;
  // 2. Workers must not copy text bindings into process.env (the pool's ambient() guard).
  try {
    const processEnv = (globalThis as { process?: { env?: unknown } }).process?.env;
    if (processEnv && typeof processEnv === "object" && Object.keys(processEnv).length > 0)
      return fail("API_ENV_PROCESS_ENV_POPULATED");
  } catch {
    return fail("API_ENV_PROCESS_ENV_POPULATED");
  }
  // 3. Provider credentials bind only to the broker; the keyring is the api's own key.
  if (
    keys.some(
      (key) =>
        providerPrefix.test(key) || (key !== "LOGIN_CAPSULE_KEYRING" && credentialWord.test(key)),
    )
  )
    return fail("API_ENV_FORBIDDEN_CREDENTIAL_BINDING");
  // 4. The Worker's own environment.
  let environment: ApiEnvironmentName;
  try {
    const value = dataProperty(record, "MORROW_ENVIRONMENT").value;
    if (typeof value !== "string" || !environments.includes(value))
      return fail("API_ENV_ENVIRONMENT_INVALID");
    environment = value as ApiEnvironmentName;
  } catch {
    return fail("API_ENV_ENVIRONMENT_INVALID");
  }
  // 5. All five configuration bindings, or none (every committed environment is unbound).
  const present = apiEnvironmentValueBindings.filter(([name]) => Object.hasOwn(record, name));
  if (present.length === 0) return fail("API_ENV_UNBOUND");
  if (present.length !== apiEnvironmentValueBindings.length) return fail("API_ENV_PARTIAL");
  // 6. Well-formed, non-empty strings within the identity limits.
  const values: Record<string, string> = {};
  try {
    for (const [name, key, limit] of apiEnvironmentValueBindings) {
      const value = dataProperty(record, name).value;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        !wellFormed(value) ||
        encoder.encode(value).length > limit
      )
        return fail("API_ENV_VALUE_INVALID");
      values[key] = value;
    }
  } catch {
    return fail("API_ENV_VALUE_INVALID");
  }
  const mapped = Object.freeze(values) as unknown as Readonly<ApiEnvironmentValues>;
  // 7. One origin and selector set, bound to this environment on both sides.
  try {
    captureManagedWorkspaceBinding({
      loginConfigurationJson: mapped.login,
      workspaceConfigurationJson: mapped.workspace,
      logoutConfigurationJson: mapped.logout,
      bindingJson: mapped.binding,
    });
    const login = loginJson(mapped.login, 32768, [
      "schemaVersion",
      "controllerProtocol",
      "origin",
      "retentionTier",
      "authenticationBindingJson",
      "verificationProfileJson",
      "profileId",
      "profileRecordRevision",
    ]);
    const binding = loginJson(mapped.binding, 4096, [
      "schemaVersion",
      "environment",
      "projectId",
      "branchId",
      "hostname",
      "database",
    ]);
    if (binding.environment !== environment || login.retentionTier !== environment)
      return fail("API_ENV_CROSS_BINDING_MISMATCH");
  } catch {
    return fail("API_ENV_CROSS_BINDING_MISMATCH");
  }
  // 8. Keyring shape only; its digest binding stays request-budgeted in login.
  try {
    const keyring = loginJson(mapped.keyring, 4096, [
      "schemaVersion",
      "purpose",
      "configurationDigest",
      "currentKeyId",
      "versions",
    ]);
    if (keyring.schemaVersion !== 1 || keyring.purpose !== "morrow.login.capsule/1")
      return fail("API_ENV_VALUE_INVALID");
  } catch {
    return fail("API_ENV_VALUE_INVALID");
  }
  // 9. The broker service binding (ApiBroker entrypoint).
  try {
    const broker = dataProperty(record, "BROKER").value;
    if (
      broker === null ||
      typeof broker !== "object" ||
      typeof (broker as { fetch?: unknown }).fetch !== "function"
    )
      return fail("API_ENV_BROKER_BINDING_INVALID");
    return Object.freeze({
      ok: true,
      environment,
      values: mapped,
      broker: broker as ApiBrokerRpc,
    });
  } catch {
    return fail("API_ENV_BROKER_BINDING_INVALID");
  }
}
