import { loginJson } from "./standalone-login-protocol.js";

// The api/broker service-binding protocol (P04.T02a D4, ADR-0007). Pure and
// additive: it imports only `loginJson`, never SQL, pools, the driver or
// validators, so the broker bundle stays free of them. Only strings, booleans
// and integer budgets cross the binding.

// THE single role/purpose table. The broker's `secrets.required` and the pools'
// borrowed namespaces must follow it. P05.T01x (ADR-0009 item 4) dropped the login
// selection role and added the first-owner signup executor; P06.T01a (ADR-0010
// item 2) added the api Worker's work login, so it holds eight.
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
} as const);
export type BrokerNeonRole = keyof typeof brokerNeonRoles;
export const brokerNeonRoleNames = Object.freeze(Object.keys(brokerNeonRoles) as BrokerNeonRole[]);
export const brokerPasswordSecret = (role: BrokerNeonRole) =>
  `MORROW_DB_PASSWORD_${role.toUpperCase()}`;
// P05.T01ab (ADR-0019 item 6): the Turnstile secret is the one provider credential
// admitted beside WorkOS. It verifies tokens and cannot mint them.
export const brokerRequiredSecrets: readonly string[] = Object.freeze([
  "WORKOS_API_KEY",
  "TURNSTILE_SECRET_KEY",
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
  // P05.T01ab (ADR-0019 item 6): one siteverify call; held is the error BROKER_HELD.
  challengeVerify(action: string, token: string, budgetMs: number): Promise<ChallengeVerdict>;
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
