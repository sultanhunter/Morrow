import { executorRoleMemberSql } from "./executor-role-preflight.js";
import { validateDefinition } from "@morrow/contracts/validation";
import type { IdentitySqlClient, IdentitySqlPool } from "./index.js";

// Internal persistence only. No installation verifier, review issuer, session
// issuer or public route is provided. Proof digests never become result data.
export interface WorkspaceStoreLinkInput {
  readonly handoffId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly sessionDigest: string;
  readonly nonceDigest: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly purpose:
    | "install_first"
    | "workspace_first"
    | "existing_account"
    | "additional_store"
    | "cross_host_resume";
  readonly expectedPolicyRevision: number;
  readonly expectedOwnershipRevision: number;
}
export type WorkspaceStoreLinkResult =
  | Readonly<{
      outcome: "applied";
      linkId: string;
      ownershipRevision: number;
      policyRevision: number;
      auditId: string;
    }>
  | Readonly<{
      outcome: "denied" | "conflict";
      linkId: null;
      ownershipRevision: null;
      policyRevision: null;
      auditId: null;
    }>
  | Readonly<{
      outcome: "denied";
      linkId: null;
      ownershipRevision: null;
      policyRevision: number;
      auditId: string;
    }>;
export class WorkspaceStoreLinkingError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_LINKING_INPUT_INVALID"
      | "WORKSPACE_LINKING_UNAVAILABLE"
      | "WORKSPACE_LINKING_UNCERTAIN",
    readonly commandId: string | null,
  ) {
    super(code);
    this.name = "WorkspaceStoreLinkingError";
  }
}
export const workspaceStoreLinkingSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  role: `SELECT current_user AS role, session_user AS login, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
pg_catalog.pg_has_role(current_user, 'morrow_identity_owner', 'MEMBER') AS owner_member,
${executorRoleMemberSql}
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: "SET LOCAL statement_timeout = '5s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  apply:
    "SELECT outcome,link_id,ownership_revision,policy_revision,audit_id FROM morrow_identity.link_workspace_store($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
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
function snapshotInput(value: unknown): WorkspaceStoreLinkInput {
  // Reject all caller objects without inspecting their prototype, keys or values.
  if (typeof value !== "string" || value.length > 8192)
    throw new WorkspaceStoreLinkingError("WORKSPACE_LINKING_INPUT_INVALID", null);
  try {
    const fields = closedRecord(JSON.parse(value), [
      "handoffId",
      "commandId",
      "requestDigest",
      "sessionDigest",
      "nonceDigest",
      "organizationId",
      "workspaceId",
      "installationId",
      "purpose",
      "expectedPolicyRevision",
      "expectedOwnershipRevision",
    ]);
    for (const key of ["handoffId", "commandId", "organizationId", "workspaceId", "installationId"])
      if (!validateDefinition("core", "Id", fields[key])) throw Error();
    for (const key of ["requestDigest", "sessionDigest", "nonceDigest"])
      if (!validateDefinition("core", "Digest", fields[key])) throw Error();
    if (
      !validateDefinition("core", "Revision", fields.expectedPolicyRevision) ||
      !validateDefinition("core", "Revision", fields.expectedOwnershipRevision) ||
      ![
        "install_first",
        "workspace_first",
        "existing_account",
        "additional_store",
        "cross_host_resume",
      ].includes(fields.purpose as string)
    )
      throw Error();
    return Object.freeze(fields) as unknown as WorkspaceStoreLinkInput;
  } catch {
    throw new WorkspaceStoreLinkingError("WORKSPACE_LINKING_INPUT_INVALID", null);
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
    "rolinherit",
    "owner_member",
    "role_member",
  ]);
  if (
    role.role !== "morrow_identity_linking" ||
    role.login !== "morrow_identity_linking" ||
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
    throw Error("INVALID_INTERNAL_ROLE");
}
function revision(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value))
    throw Error("INVALID_INTERNAL_RESULT");
  const parsed = Number(value);
  if (!validateDefinition("core", "Revision", parsed)) throw Error("INVALID_INTERNAL_RESULT");
  return parsed;
}
function decodeResult(
  rows: readonly Record<string, unknown>[],
  input: WorkspaceStoreLinkInput,
): WorkspaceStoreLinkResult {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error("INVALID_INTERNAL_RESULT");
  const row = closedRecord(rows[0], [
    "outcome",
    "link_id",
    "ownership_revision",
    "policy_revision",
    "audit_id",
  ]);
  if (!["applied", "denied", "conflict"].includes(row.outcome as string))
    throw Error("INVALID_INTERNAL_RESULT");
  for (const key of ["link_id", "audit_id"])
    if (row[key] !== null && !validateDefinition("core", "Id", row[key]))
      throw Error("INVALID_INTERNAL_RESULT");
  const ownershipRevision = revision(row.ownership_revision),
    policyRevision = revision(row.policy_revision);
  if (row.outcome === "applied") {
    if (
      row.link_id === null ||
      row.audit_id === null ||
      ownershipRevision !== input.expectedOwnershipRevision + 1 ||
      policyRevision !== input.expectedPolicyRevision + 1
    )
      throw Error("INVALID_INTERNAL_RESULT");
  } else if (
    row.link_id !== null ||
    ownershipRevision !== null ||
    (row.outcome === "conflict" && (policyRevision !== null || row.audit_id !== null)) ||
    (row.outcome === "denied" && (policyRevision === null) !== (row.audit_id === null))
  )
    throw Error("INVALID_INTERNAL_RESULT");
  return Object.freeze({
    outcome: row.outcome,
    linkId: row.link_id,
    ownershipRevision,
    policyRevision,
    auditId: row.audit_id,
  }) as WorkspaceStoreLinkResult;
}

export function createWorkspaceStoreLinks(pool: IdentitySqlPool) {
  return Object.freeze({
    async apply(value: unknown): Promise<WorkspaceStoreLinkResult> {
      const input = snapshotInput(value);
      const parameters = Object.freeze([
        input.handoffId,
        input.commandId,
        input.requestDigest,
        input.sessionDigest,
        input.nonceDigest,
        input.organizationId,
        input.workspaceId,
        input.installationId,
        input.purpose,
        String(input.expectedPolicyRevision),
        String(input.expectedOwnershipRevision),
      ]);
      let client: IdentitySqlClient;
      try {
        client = await pool.connect();
      } catch {
        throw new WorkspaceStoreLinkingError("WORKSPACE_LINKING_UNAVAILABLE", input.commandId);
      }
      let transactionOpen = false,
        commitAttempted = false,
        discard = false;
      let result: WorkspaceStoreLinkResult | undefined;
      let failure: WorkspaceStoreLinkingError | undefined;
      try {
        // A lost BEGIN acknowledgement still needs rollback/discard.
        transactionOpen = true;
        await client.query(workspaceStoreLinkingSql.begin);
        requireDedicatedRole((await client.query(workspaceStoreLinkingSql.role)).rows);
        await client.query(workspaceStoreLinkingSql.timeout);
        await client.query(workspaceStoreLinkingSql.idleTimeout);
        result = decodeResult(
          (await client.query(workspaceStoreLinkingSql.apply, parameters)).rows,
          input,
        );
        // Denials can contain a durable attributable audit. Never retry a write.
        commitAttempted = true;
        await client.query(workspaceStoreLinkingSql.commit);
        transactionOpen = false;
      } catch {
        discard = true;
        if (commitAttempted)
          failure = new WorkspaceStoreLinkingError("WORKSPACE_LINKING_UNCERTAIN", input.commandId);
        else {
          if (transactionOpen)
            try {
              await client.query(workspaceStoreLinkingSql.rollback);
            } catch {
              /* Redacted; discard. */
            }
          failure = new WorkspaceStoreLinkingError(
            "WORKSPACE_LINKING_UNAVAILABLE",
            input.commandId,
          );
        }
      } finally {
        try {
          await client.release(discard);
        } catch {
          failure = new WorkspaceStoreLinkingError(
            commitAttempted ? "WORKSPACE_LINKING_UNCERTAIN" : "WORKSPACE_LINKING_UNAVAILABLE",
            input.commandId,
          );
        }
      }
      if (failure) throw failure;
      return result!;
    },
  });
}
