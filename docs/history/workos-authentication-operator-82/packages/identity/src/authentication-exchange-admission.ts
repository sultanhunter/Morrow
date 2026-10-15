import { createHash, randomBytes, randomUUID } from "node:crypto";
import { validateDefinition } from "@morrow/contracts/validation";
import type { IdentitySqlClient, IdentitySqlPool } from "./index.js";

// Private pre-authentication correlation only: no provider request, reusable
// exchange permit, authenticated identity, session, tenant or capability grant.
export interface AuthenticationExchangeBinding {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly returnPath: string;
}
export interface AuthenticationExchangeInitiation {
  readonly challengeId: string;
  readonly state: string;
  readonly browserProof: string;
  readonly verifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}
export type AuthenticationExchangeCorrelation =
  | Readonly<{ outcome: "newly_reserved"; admissionId: string; commandId: string }>
  | Readonly<{ outcome: "held"; admissionId: string | null; commandId: string }>
  | Readonly<{ outcome: "denied" | "conflict"; admissionId: null; commandId: string }>;
export class AuthenticationExchangeAdmissionError extends Error {
  constructor(
    readonly code:
      | "AUTH_EXCHANGE_INPUT_INVALID"
      | "AUTH_EXCHANGE_UNAVAILABLE"
      | "AUTH_EXCHANGE_UNCERTAIN",
    readonly commandId: string | null,
  ) {
    super(code);
    this.name = "AuthenticationExchangeAdmissionError";
  }
}
export const authenticationExchangeAdmissionSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  beginReadOnly: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  role: `SELECT current_user AS role, session_user AS login, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
pg_catalog.pg_has_role(current_user, 'morrow_identity_owner', 'MEMBER') AS owner_member,
EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS role_member
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: "SET LOCAL statement_timeout = '5s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  create:
    "SELECT challenge_id FROM morrow_identity.begin_authentication_exchange($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
  admit:
    "SELECT outcome,admission_id FROM morrow_identity.admit_authentication_exchange($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
  reconcile:
    "SELECT outcome,admission_id FROM morrow_identity.reconcile_authentication_exchange($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
const invalid = () => new AuthenticationExchangeAdmissionError("AUTH_EXCHANGE_INPUT_INVALID", null);
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw Error();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    own = Reflect.ownKeys(value);
  if (
    own.some((key) => typeof key !== "string") ||
    own.sort().join(",") !== [...keys].sort().join(",")
  )
    throw Error();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw Error();
    copy[key] = descriptor.value;
  }
  return copy;
}
function parse(value: unknown, maximum: number, keys: readonly string[]) {
  // In particular, do not reflect on a caller object/proxy or boxed string.
  if (typeof value !== "string" || value.length > maximum) throw invalid();
  try {
    return Object.freeze(closedRecord(JSON.parse(value), keys));
  } catch {
    throw invalid();
  }
}
function bindingOf(value: unknown): AuthenticationExchangeBinding {
  const b = parse(value, 8192, [
    "bindingId",
    "bindingRevision",
    "environmentId",
    "applicationId",
    "clientId",
    "redirectUri",
    "returnPath",
  ]);
  try {
    if (
      !validateDefinition("core", "Id", b.bindingId) ||
      !validateDefinition("core", "Revision", b.bindingRevision) ||
      typeof b.environmentId !== "string" ||
      !/^environment_[A-Z0-9]{26}$/.test(b.environmentId) ||
      typeof b.applicationId !== "string" ||
      !/^app_[A-Z0-9]{26}$/.test(b.applicationId) ||
      typeof b.clientId !== "string" ||
      !/^client_[A-Z0-9]{26}$/.test(b.clientId) ||
      typeof b.redirectUri !== "string" ||
      b.redirectUri.length > 2048 ||
      typeof b.returnPath !== "string" ||
      b.returnPath.length > 512 ||
      !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(b.returnPath)
    )
      throw Error();
    const url = new URL(b.redirectUri);
    if (
      url.href !== b.redirectUri ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      b.redirectUri.includes("#") ||
      b.redirectUri.includes("?") ||
      b.redirectUri.includes("*") ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw Error();
    return b as unknown as AuthenticationExchangeBinding;
  } catch {
    throw invalid();
  }
}
function canonicalProof(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}
export function authenticationExchangeCodeChallenge(verifier: unknown): string {
  if (!canonicalProof(verifier)) throw invalid();
  // RFC7636 S256 hashes the verifier ASCII text, not the original random seed.
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
function validUtf16(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function commandOf(value: unknown): string {
  const input = parse(value, 8192, ["commandId"]);
  if (!validateDefinition("core", "Id", input.commandId)) throw invalid();
  return input.commandId as string;
}
function callbackOf(value: unknown) {
  const input = parse(value, 16384, [
    "commandId",
    "challengeId",
    "state",
    "browserProof",
    "verifier",
    "code",
  ]);
  if (
    !validateDefinition("core", "Id", input.commandId) ||
    !uuid(input.challengeId) ||
    !canonicalProof(input.state) ||
    !canonicalProof(input.browserProof) ||
    !canonicalProof(input.verifier) ||
    typeof input.code !== "string" ||
    input.code.length === 0 ||
    input.code.length > 4096 ||
    !validUtf16(input.code)
  )
    throw invalid();
  return Object.freeze({
    commandId: input.commandId as string,
    challengeId: input.challengeId,
    stateDigest: digest(input.state),
    browserDigest: digest(input.browserProof),
    verifierDigest: digest(input.verifier),
    codeDigest: digest(input.code),
  });
}
function requireRole(rows: readonly Record<string, unknown>[]) {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error();
  const role = closedRecord(rows[0], [
    "role",
    "login",
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "rolinherit",
    "owner_member",
    "role_member",
  ]);
  if (
    role.role !== "morrow_identity_preauth" ||
    role.login !== "morrow_identity_preauth" ||
    [
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "rolinherit",
      "owner_member",
      "role_member",
    ].some((key) => role[key] !== false)
  )
    throw Error();
}
async function transaction<T>(
  pool: IdentitySqlPool,
  readOnly: boolean,
  commandId: string,
  operation: string,
  parameters: readonly string[],
  decode: (rows: readonly Record<string, unknown>[]) => T,
): Promise<T> {
  let client: IdentitySqlClient;
  try {
    client = await pool.connect();
  } catch {
    throw new AuthenticationExchangeAdmissionError("AUTH_EXCHANGE_UNAVAILABLE", commandId);
  }
  let open = false,
    commitAttempted = false,
    discard = false;
  let result: T | undefined, failure: AuthenticationExchangeAdmissionError | undefined;
  try {
    open = true;
    await client.query(
      readOnly
        ? authenticationExchangeAdmissionSql.beginReadOnly
        : authenticationExchangeAdmissionSql.begin,
    );
    requireRole((await client.query(authenticationExchangeAdmissionSql.role)).rows);
    await client.query(authenticationExchangeAdmissionSql.timeout);
    await client.query(authenticationExchangeAdmissionSql.idleTimeout);
    result = decode((await client.query(operation, parameters)).rows);
    commitAttempted = true;
    await client.query(authenticationExchangeAdmissionSql.commit);
    open = false;
  } catch {
    discard = true;
    if (commitAttempted)
      failure = new AuthenticationExchangeAdmissionError("AUTH_EXCHANGE_UNCERTAIN", commandId);
    else {
      if (open)
        try {
          await client.query(authenticationExchangeAdmissionSql.rollback);
        } catch {
          /* Discard without raw errors. */
        }
      failure = new AuthenticationExchangeAdmissionError("AUTH_EXCHANGE_UNAVAILABLE", commandId);
    }
  } finally {
    try {
      await client.release(discard);
    } catch {
      failure = new AuthenticationExchangeAdmissionError(
        commitAttempted ? "AUTH_EXCHANGE_UNCERTAIN" : "AUTH_EXCHANGE_UNAVAILABLE",
        commandId,
      );
    }
  }
  if (failure) throw failure;
  return result!;
}
function correlation(
  rows: readonly Record<string, unknown>[],
  commandId: string,
  readOnly: boolean,
): AuthenticationExchangeCorrelation {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error();
  const row = closedRecord(rows[0], ["outcome", "admission_id"]);
  if (
    readOnly
      ? row.outcome !== "held"
      : !["newly_reserved", "held", "denied", "conflict"].includes(row.outcome as string)
  )
    throw Error();
  if (row.admission_id !== null && !uuid(row.admission_id)) throw Error();
  if (
    (row.outcome === "newly_reserved" && row.admission_id === null) ||
    (["denied", "conflict"].includes(row.outcome as string) && row.admission_id !== null)
  )
    throw Error();
  return Object.freeze({
    outcome: row.outcome,
    admissionId: row.admission_id,
    commandId,
  }) as AuthenticationExchangeCorrelation;
}
export function createAuthenticationExchangeAdmission(pool: IdentitySqlPool, bindingJson: unknown) {
  const binding = bindingOf(bindingJson);
  const configuration = Object.freeze([
    binding.bindingId,
    String(binding.bindingRevision),
    binding.environmentId,
    binding.applicationId,
    binding.clientId,
    binding.redirectUri,
    binding.returnPath,
  ]);
  const callback = (value: unknown, readOnly: boolean) => {
    const input = callbackOf(value);
    const parameters = Object.freeze([
      input.commandId,
      input.challengeId,
      ...configuration,
      input.stateDigest,
      input.browserDigest,
      input.verifierDigest,
      input.codeDigest,
    ]);
    return transaction(
      pool,
      readOnly,
      input.commandId,
      readOnly
        ? authenticationExchangeAdmissionSql.reconcile
        : authenticationExchangeAdmissionSql.admit,
      parameters,
      (rows) => correlation(rows, input.commandId, readOnly),
    );
  };
  return Object.freeze({
    async begin(value: unknown): Promise<AuthenticationExchangeInitiation | null> {
      const commandId = commandOf(value);
      const material = Object.freeze({
        challengeId: randomUUID(),
        state: randomBytes(32).toString("base64url"),
        browserProof: randomBytes(32).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
      });
      const parameters = Object.freeze([
        material.challengeId,
        commandId,
        ...configuration,
        digest(material.state),
        digest(material.browserProof),
        digest(material.verifier),
      ]);
      const created = await transaction(
        pool,
        false,
        commandId,
        authenticationExchangeAdmissionSql.create,
        parameters,
        (rows) => {
          if (!Array.isArray(rows)) throw Error();
          if (rows.length === 0) return false;
          if (
            rows.length !== 1 ||
            closedRecord(rows[0], ["challenge_id"]).challenge_id !== material.challengeId
          )
            throw Error();
          return true;
        },
      );
      return created
        ? Object.freeze({
            ...material,
            codeChallenge: authenticationExchangeCodeChallenge(material.verifier),
            codeChallengeMethod: "S256" as const,
          })
        : null;
    },
    async admit(value: unknown) {
      return callback(value, false);
    },
    async reconcile(value: unknown) {
      return callback(value, true);
    },
  });
}
