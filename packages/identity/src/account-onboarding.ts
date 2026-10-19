import { executorRoleMemberSql } from "./executor-role-preflight.js";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { identitySql } from "./index.js";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";
import { standaloneJson, type GuardedAccountRequest } from "./standalone-request-guard.js";
import {
  runFixedSqlTransaction,
  type FixedSqlPool,
  type FixedSqlTransactionProfile,
} from "./fixed-sql-transaction.js";

// Account routes (P05.T01x Part B, ADR-0009): GET /workspaces and POST /organizations.
// The principal derives only from the session digest, inside SQL. Bodies are closed and
// carry no tenant, principal, subject or email field. Error bodies are fixed.

export type { GuardedAccountRequest } from "./standalone-request-guard.js";

export const accountOverviewSql =
  "SELECT onboarding,workspaces::text AS workspaces FROM morrow_identity.account_overview($1,$2)";
export const accountOnboardingSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
  role: `SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,pg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,${executorRoleMemberSql} FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: "SET LOCAL statement_timeout = '2s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
  create:
    "SELECT outcome,organization_id,workspace_id FROM morrow_identity.create_first_organization($1,$2,$3,$4,$5)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});

const held = () => Error("ACCOUNT_ONBOARDING_HELD");
function onlyRow(
  rows: readonly Record<string, unknown>[],
  names: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!Array.isArray(rows) || rows.length > 1) throw held();
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) throw held();
  const descriptors = Object.getOwnPropertyDescriptors(row);
  if (
    Reflect.ownKeys(row).sort().join(",") !== [...names].sort().join(",") ||
    names.some((name) => !Object.hasOwn(descriptors[name]!, "value"))
  )
    throw held();
  return Object.freeze(Object.fromEntries(names.map((name) => [name, descriptors[name]!.value])));
}

const overviewProfile: Readonly<FixedSqlTransactionProfile> = Object.freeze({
  begin: identitySql.begin,
  role: identitySql.role,
  settings: Object.freeze([identitySql.timeout, identitySql.idleTimeout]),
  commit: identitySql.commit,
  rollback: identitySql.rollback,
  requireRole(rows: readonly Record<string, unknown>[]) {
    const r = onlyRow(rows, [
      "role",
      "login",
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "owner_member",
    ]);
    if (
      !r ||
      r.role !== "morrow_api" ||
      r.login !== "morrow_api" ||
      r.rolsuper !== false ||
      r.rolbypassrls !== false ||
      r.rolcreatedb !== false ||
      r.rolcreaterole !== false ||
      r.owner_member !== false
    )
      throw held();
  },
});
const onboardingRoleNames = [
  "role",
  "login",
  "rolsuper",
  "rolbypassrls",
  "rolcreatedb",
  "rolcreaterole",
  "rolreplication",
  "rolinherit",
  "owner_member",
  "role_member",
] as const;
const onboardingProfile: Readonly<FixedSqlTransactionProfile> = Object.freeze({
  begin: accountOnboardingSql.begin,
  role: accountOnboardingSql.role,
  settings: Object.freeze([accountOnboardingSql.timeout, accountOnboardingSql.idleTimeout]),
  commit: accountOnboardingSql.commit,
  rollback: accountOnboardingSql.rollback,
  requireRole(rows: readonly Record<string, unknown>[]) {
    const r = onlyRow(rows, onboardingRoleNames);
    if (
      !r ||
      r.role !== "morrow_identity_onboarding" ||
      r.login !== "morrow_identity_onboarding" ||
      onboardingRoleNames.slice(2).some((name) => r[name] !== false)
    )
      throw held();
  },
});

// One display-name rule, shared by TS, SQL display_name_valid and P05.T01x-AC30: after NFC
// and trimming leading and trailing W, 1-100 code points, still NFC, well formed, and no
// code point in F. W and F are the packet's explicit sets, not String.prototype.trim.
const W =
  "\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const F =
  "\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\uFEFF";
const edges = new RegExp(`^[${W}]+|[${W}]+$`, "gu");
const forbidden = new RegExp(`[${F}]`, "u");
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
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024 || !wellFormed(value)) return null;
  const name = value.normalize("NFC").replace(edges, "");
  if (name !== name.normalize("NFC") || forbidden.test(name)) return null;
  let count = 0;
  for (const _ of name) if (++count > 100) return null;
  return count >= 1 ? name : null;
}

// Closed parse of {"schemaVersion":1,"organizationName":s,"workspaceName":s}: exactly
// these keys once each, string names (unchecked here) and the number 1. Lone surrogate
// escapes survive to normalizeDisplayName, so they answer invalid_name, not a parse error.
export function parseOrganizationSignupBody(
  text: string,
): Readonly<{ organizationName: string; workspaceName: string }> | null {
  try {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > 2048) return null;
    let at = 0;
    const space = () => {
      while (at < text.length && " \t\r\n".includes(text[at]!)) at++;
    };
    const string = (): string => {
      if (text[at] !== '"') throw held();
      const start = at++;
      while (at < text.length) {
        const character = text[at++]!;
        if (character === '"') {
          const decoded: unknown = JSON.parse(text.slice(start, at));
          if (typeof decoded !== "string") throw held();
          return decoded;
        }
        if (character === "\\") at++;
      }
      throw held();
    };
    const values = new Map<string, unknown>();
    space();
    if (text[at++] !== "{") return null;
    for (;;) {
      space();
      const key = string();
      if (values.has(key)) return null;
      space();
      if (text[at++] !== ":") return null;
      space();
      if (text[at] === '"') values.set(key, string());
      else {
        const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
        if (!number) return null;
        at += number[0].length;
        values.set(key, Number(number[0]));
      }
      space();
      const separator = text[at++];
      if (separator === "}") break;
      if (separator !== ",") return null;
    }
    space();
    if (at !== text.length) return null;
    if (
      [...values.keys()].sort().join(",") !== "organizationName,schemaVersion,workspaceName" ||
      values.get("schemaVersion") !== 1 ||
      typeof values.get("organizationName") !== "string" ||
      typeof values.get("workspaceName") !== "string"
    )
      return null;
    return Object.freeze({
      organizationName: values.get("organizationName") as string,
      workspaceName: values.get("workspaceName") as string,
    });
  } catch {
    return null;
  }
}

export type SignupSqlOutcome =
  | "created"
  | "replayed"
  | "invalid"
  | "unauthenticated"
  | "not_eligible"
  | "signup_disabled"
  | "already_onboarded"
  | "idempotency_conflict"
  | "rate_limited"
  | "denied";
// The section 9 outcome-to-HTTP table. created and replayed also carry both ids.
export const signupResponses: Readonly<
  Record<SignupSqlOutcome, Readonly<{ status: number; body: unknown }>>
> = Object.freeze({
  created: Object.freeze({
    status: 201,
    body: Object.freeze({ schemaVersion: 1, outcome: "created" }),
  }),
  replayed: Object.freeze({
    status: 200,
    body: Object.freeze({ schemaVersion: 1, outcome: "replayed" }),
  }),
  invalid: Object.freeze({
    status: 400,
    body: Object.freeze({ schemaVersion: 1, outcome: "invalid_name" }),
  }),
  unauthenticated: Object.freeze({
    status: 401,
    body: Object.freeze({ code: "authentication_required" }),
  }),
  not_eligible: Object.freeze({
    status: 403,
    body: Object.freeze({ schemaVersion: 1, outcome: "signup_unavailable" }),
  }),
  signup_disabled: Object.freeze({
    status: 403,
    body: Object.freeze({ schemaVersion: 1, outcome: "signup_unavailable" }),
  }),
  already_onboarded: Object.freeze({
    status: 409,
    body: Object.freeze({ schemaVersion: 1, outcome: "already_onboarded" }),
  }),
  idempotency_conflict: Object.freeze({
    status: 409,
    body: Object.freeze({ schemaVersion: 1, outcome: "idempotency_conflict" }),
  }),
  rate_limited: Object.freeze({
    status: 429,
    body: Object.freeze({ schemaVersion: 1, outcome: "rate_limited" }),
  }),
  denied: Object.freeze({ status: 503, body: Object.freeze({ code: "unavailable" }) }),
});
const signupOutcomes = Object.keys(signupResponses) as SignupSqlOutcome[];
const recordId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const unavailableResponse = () => standaloneJson(503, { code: "unavailable" });
const unknownResponse = () => standaloneJson(503, { schemaVersion: 1, outcome: "outcome_unknown" });

function decodeOverview(rows: readonly Record<string, unknown>[]) {
  const row = onlyRow(rows, ["onboarding", "workspaces"]);
  if (!row) return null;
  if (
    (row.onboarding !== "available" && row.onboarding !== "unavailable") ||
    typeof row.workspaces !== "string"
  )
    throw held();
  const listed = parseWorkosSessionStatusJson(row.workspaces, 524288);
  if (!Array.isArray(listed) || listed.length > 101) throw held();
  // jsonb reorders keys; the reply uses one fixed member order. Shapes are validated below.
  const entry = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw held();
    const w = value as Record<string, unknown>;
    return {
      organizationId: w.organizationId,
      organizationName: w.organizationName,
      workspaceId: w.workspaceId,
      workspaceName: w.workspaceName,
      ...(Object.keys(w).length === 4 ? {} : { unexpected: true }),
    };
  };
  const body = {
    schemaVersion: 1 as const,
    workspaces: listed.slice(0, 100).map(entry),
    truncated: listed.length > 100,
    onboarding: row.onboarding,
  };
  if (
    !validateCurrentDefinition("AccountOverview", body) ||
    new Set(body.workspaces.map((w) => (w as { workspaceId: string }).workspaceId)).size !==
      body.workspaces.length
  )
    throw held();
  return body;
}

// GET /workspaces. Zero rows (no current family for the configured profile) is 401; any
// failure is 503 with no effect. One read-only statement over one snapshot.
export async function executeAccountOverview(
  identityPool: FixedSqlPool,
  profileId: string,
  c: Readonly<GuardedAccountRequest>,
): Promise<Response> {
  try {
    if (!recordId(profileId) || c.commandId !== null || c.bodyText !== null) throw held();
    const result = await runFixedSqlTransaction(identityPool, c, overviewProfile, async (query) =>
      decodeOverview(await query(accountOverviewSql, [c.sessionDigest, profileId])),
    );
    if (!result.ok) return unavailableResponse();
    if (result.value === null) return standaloneJson(401, { code: "authentication_required" });
    return standaloneJson(200, result.value);
  } catch {
    return unavailableResponse();
  }
}

function decodeSignup(rows: readonly Record<string, unknown>[]) {
  const row = onlyRow(rows, ["outcome", "organization_id", "workspace_id"]);
  if (!row || !signupOutcomes.includes(row.outcome as SignupSqlOutcome)) throw held();
  const outcome = row.outcome as SignupSqlOutcome;
  if (outcome === "created" || outcome === "replayed") {
    if (
      !recordId(row.organization_id) ||
      !recordId(row.workspace_id) ||
      row.organization_id === row.workspace_id
    )
      throw held();
    return Object.freeze({
      outcome,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
    });
  }
  if (row.organization_id !== null || row.workspace_id !== null) throw held();
  return Object.freeze({ outcome, organizationId: null, workspaceId: null });
}

// POST /organizations. A failure before markSubmitted() is 503 unavailable with no effect;
// any loss after it, before a confirmed COMMIT, is 503 outcome_unknown. The server never
// retries: the client's same-key resubmission is the reconciliation.
export async function executeFirstOrganization(
  onboardingPool: FixedSqlPool,
  profileId: string,
  c: Readonly<GuardedAccountRequest>,
): Promise<Response> {
  let submitted = false;
  try {
    if (!recordId(profileId) || c.commandId === null || c.bodyText === null) throw held();
    const parsed = parseOrganizationSignupBody(c.bodyText);
    if (!parsed) return standaloneJson(400, { code: "request_denied" });
    const organizationName = normalizeDisplayName(parsed.organizationName),
      workspaceName = normalizeDisplayName(parsed.workspaceName);
    if (organizationName === null || workspaceName === null)
      return standaloneJson(signupResponses.invalid.status, signupResponses.invalid.body);
    const commandId = c.commandId;
    const result = await runFixedSqlTransaction(
      onboardingPool,
      c,
      onboardingProfile,
      async (query) => {
        submitted = true;
        c.markSubmitted();
        return decodeSignup(
          await query(accountOnboardingSql.create, [
            c.sessionDigest,
            commandId,
            profileId,
            organizationName,
            workspaceName,
          ]),
        );
      },
    );
    if (!result.ok) return submitted ? unknownResponse() : unavailableResponse();
    const { outcome, organizationId, workspaceId } = result.value;
    const selected = signupResponses[outcome];
    const body =
      outcome === "created" || outcome === "replayed"
        ? { schemaVersion: 1, outcome, organizationId, workspaceId }
        : selected.body;
    if (
      selected.status !== 401 &&
      selected.status !== 503 &&
      !validateCurrentDefinition("OrganizationSignupResult", body)
    )
      throw held();
    const response = standaloneJson(selected.status, body);
    if (outcome === "rate_limited") response.headers.set("Retry-After", "600");
    return response;
  } catch {
    return submitted ? unknownResponse() : unavailableResponse();
  }
}
