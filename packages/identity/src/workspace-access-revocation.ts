import { validateDefinition } from "@morrow/contracts/validation";
import type { IdentitySqlClient, IdentitySqlPool } from "./index.js";

// Internal persistence only. No receipt issuer, authenticator or HTTP route.
// Session digests are bearer-equivalent private input, never result/evidence data.
export interface WorkspaceAccessRevocationInput {
  readonly receiptId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly sessionDigest: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly targetMembershipId: string;
  readonly expectedRevision: number;
}
export type WorkspaceAccessRevocationResult =
  | Readonly<{ outcome: "applied"; revocationId: string; policyRevision: number; auditId: string }>
  | Readonly<{ outcome: "conflict"; revocationId: null; policyRevision: null; auditId: null }>
  | Readonly<{ outcome: "denied"; revocationId: null; policyRevision: null; auditId: null }>
  | Readonly<{ outcome: "denied"; revocationId: null; policyRevision: number; auditId: string }>;
export class WorkspaceAccessRevocationError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_REVOCATION_INPUT_INVALID"
      | "WORKSPACE_REVOCATION_UNAVAILABLE"
      | "WORKSPACE_REVOCATION_UNCERTAIN",
    readonly commandId: string | null,
  ) {
    super(code);
    this.name = "WorkspaceAccessRevocationError";
  }
}
export const workspaceAccessRevocationSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  role: `SELECT current_user AS role, session_user AS login, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
pg_catalog.pg_has_role(current_user, 'morrow_identity_owner', 'MEMBER') AS owner_member,
EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS role_member
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: "SET LOCAL statement_timeout = '5s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  apply:
    "SELECT outcome,revocation_id,policy_revision,audit_id FROM morrow_identity.revoke_workspace_access($1,$2,$3,$4,$5,$6,$7,$8)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw Error("INVALID_INTERNAL_RECORD");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (
    own.some((key) => typeof key !== "string") ||
    own.sort().join(",") !== [...keys].sort().join(",")
  )
    throw Error("INVALID_INTERNAL_RECORD");
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw Error("INVALID_INTERNAL_RECORD");
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
function snapshotInput(value: unknown): WorkspaceAccessRevocationInput {
  try {
    const fields = closedRecord(value, [
      "receiptId",
      "commandId",
      "requestDigest",
      "sessionDigest",
      "organizationId",
      "workspaceId",
      "targetMembershipId",
      "expectedRevision",
    ]);
    for (const key of [
      "receiptId",
      "commandId",
      "organizationId",
      "workspaceId",
      "targetMembershipId",
    ])
      if (!validateDefinition("core", "Id", fields[key])) throw Error();
    for (const key of ["requestDigest", "sessionDigest"])
      if (!validateDefinition("core", "Digest", fields[key])) throw Error();
    if (!validateDefinition("core", "Revision", fields.expectedRevision)) throw Error();
    return Object.freeze(fields) as unknown as WorkspaceAccessRevocationInput;
  } catch {
    throw new WorkspaceAccessRevocationError("WORKSPACE_REVOCATION_INPUT_INVALID", null);
  }
}
function requireDedicatedRole(rows: readonly Record<string, unknown>[]) {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error("INVALID_INTERNAL_ROLE");
  const role = closedRecord(rows[0], [
    "role",
    "login",
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "owner_member",
    "role_member",
  ]);
  if (
    role.role !== "morrow_identity_lifecycle" ||
    role.login !== "morrow_identity_lifecycle" ||
    [
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "owner_member",
      "role_member",
    ].some((key) => role[key] !== false)
  )
    throw Error("INVALID_INTERNAL_ROLE");
}
function decodeResult(
  rows: readonly Record<string, unknown>[],
  expectedRevision: number,
): WorkspaceAccessRevocationResult {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error("INVALID_INTERNAL_RESULT");
  const row = closedRecord(rows[0], ["outcome", "revocation_id", "policy_revision", "audit_id"]);
  if (!["applied", "denied", "conflict"].includes(row.outcome as string))
    throw Error("INVALID_INTERNAL_RESULT");
  for (const key of ["revocation_id", "audit_id"])
    if (row[key] !== null && !validateDefinition("core", "Id", row[key]))
      throw Error("INVALID_INTERNAL_RESULT");
  let policyRevision: number | null = null;
  if (row.policy_revision !== null) {
    if (typeof row.policy_revision !== "string" || !/^[1-9][0-9]{0,15}$/.test(row.policy_revision))
      throw Error("INVALID_INTERNAL_RESULT");
    policyRevision = Number(row.policy_revision);
    if (!validateDefinition("core", "Revision", policyRevision))
      throw Error("INVALID_INTERNAL_RESULT");
  }
  if (row.outcome === "applied") {
    if (
      row.revocation_id === null ||
      row.audit_id === null ||
      policyRevision !== expectedRevision + 1
    )
      throw Error("INVALID_INTERNAL_RESULT");
  } else if (
    row.revocation_id !== null ||
    (row.outcome === "conflict" && (row.audit_id !== null || policyRevision !== null)) ||
    (row.outcome === "denied" && (row.audit_id === null) !== (policyRevision === null))
  )
    throw Error("INVALID_INTERNAL_RESULT");
  return Object.freeze({
    outcome: row.outcome as WorkspaceAccessRevocationResult["outcome"],
    revocationId: row.revocation_id as string | null,
    policyRevision,
    auditId: row.audit_id as string | null,
  }) as WorkspaceAccessRevocationResult;
}

export function createWorkspaceAccessRevocations(pool: IdentitySqlPool) {
  return Object.freeze({
    async apply(value: unknown): Promise<WorkspaceAccessRevocationResult> {
      // Copy scalars before the first await; caller mutation cannot retarget work.
      const input = snapshotInput(value);
      const parameters = Object.freeze([
        input.receiptId,
        input.commandId,
        input.requestDigest,
        input.sessionDigest,
        input.organizationId,
        input.workspaceId,
        input.targetMembershipId,
        String(input.expectedRevision),
      ]);
      let client: IdentitySqlClient;
      try {
        client = await pool.connect();
      } catch {
        throw new WorkspaceAccessRevocationError(
          "WORKSPACE_REVOCATION_UNAVAILABLE",
          input.commandId,
        );
      }
      let transactionOpen = false;
      let commitAttempted = false;
      let discard = false;
      let result: WorkspaceAccessRevocationResult | undefined;
      let failure: WorkspaceAccessRevocationError | undefined;
      try {
        // Even a lost BEGIN response requires cleanup; it has not committed a command.
        transactionOpen = true;
        await client.query(workspaceAccessRevocationSql.begin);
        requireDedicatedRole((await client.query(workspaceAccessRevocationSql.role)).rows);
        await client.query(workspaceAccessRevocationSql.timeout);
        await client.query(workspaceAccessRevocationSql.idleTimeout);
        result = decodeResult(
          (await client.query(workspaceAccessRevocationSql.apply, parameters)).rows,
          input.expectedRevision,
        );
        // Expected denials/conflicts are durable results, including attributable audits.
        // Once COMMIT is attempted, no acknowledgement error proves rollback/failure.
        commitAttempted = true;
        await client.query(workspaceAccessRevocationSql.commit);
        transactionOpen = false;
      } catch {
        discard = true;
        if (commitAttempted) {
          failure = new WorkspaceAccessRevocationError(
            "WORKSPACE_REVOCATION_UNCERTAIN",
            input.commandId,
          );
        } else {
          if (transactionOpen) {
            try {
              await client.query(workspaceAccessRevocationSql.rollback);
            } catch {
              /* Discard; raw database details never enter errors or evidence. */
            }
          }
          failure = new WorkspaceAccessRevocationError(
            "WORKSPACE_REVOCATION_UNAVAILABLE",
            input.commandId,
          );
        }
      } finally {
        try {
          // Await also supports an adapter whose connection cleanup is asynchronous.
          await client.release(discard);
        } catch {
          failure = new WorkspaceAccessRevocationError(
            commitAttempted ? "WORKSPACE_REVOCATION_UNCERTAIN" : "WORKSPACE_REVOCATION_UNAVAILABLE",
            input.commandId,
          );
        }
      }
      if (failure) throw failure;
      return result!;
    },
  });
}
