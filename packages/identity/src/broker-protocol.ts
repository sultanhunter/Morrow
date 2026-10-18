import { loginJson } from "./standalone-login-protocol.js";

// The api/broker service-binding protocol (P04.T02a D4, ADR-0007). Pure and
// additive: it imports only `loginJson`, never SQL, pools, the driver or
// validators, so the broker bundle stays free of them. Only strings, booleans
// and integer budgets cross the binding.

// THE single role/purpose table. P05.T01x edits only this table; the broker's
// `secrets.required` and the pools' borrowed namespaces must follow it.
export const brokerNeonRoles = Object.freeze({
  morrow_identity_login: "primary_and_one_same_role_observer",
  morrow_identity_preauth: "primary_and_one_same_role_observer",
  morrow_identity_resolution: "primary_and_one_same_role_observer",
  morrow_identity_sessions: "primary_and_one_same_role_observer",
  morrow_api: "workspace_primary_and_one_same_role_observer",
  morrow_identity_linking: "workspace_primary_and_one_same_role_observer",
  morrow_identity_logout: "workspace_primary_and_one_same_role_observer",
  // P06.T01a (ADR-0010 item 2): the api Worker's work login, one connection per request.
  morrow_api_worker: "work_request_transaction",
} as const);
export type BrokerNeonRole = keyof typeof brokerNeonRoles;
export const brokerNeonRoleNames = Object.freeze(Object.keys(brokerNeonRoles) as BrokerNeonRole[]);
export const brokerPasswordSecret = (role: BrokerNeonRole) =>
  `MORROW_DB_PASSWORD_${role.toUpperCase()}`;
export const brokerRequiredSecrets: readonly string[] = Object.freeze([
  "WORKOS_API_KEY",
  ...brokerNeonRoleNames.map(brokerPasswordSecret),
]);
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
}

const invalid = () => Error("BROKER_PROTOCOL_INVALID");
const encoder = new TextEncoder();
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;

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
