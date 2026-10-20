import type {
  Core_ActorRef as ActorRef,
  Current_Grant,
  Current_ResourceRef,
} from "@morrow/contracts";
import { validateCurrentDefinition, validateDefinition } from "@morrow/contracts/validation";

// Server-only persistence port. No issuer, cookie parser or request authenticator
// is supplied here. A qualified WorkOS boundary must produce the session proof.
// The digest is bearer-equivalent: never accept it from a tenant selector/log it.
export interface IdentitySqlClient {
  query(
    text: string,
    values?: readonly string[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
  release(discard: boolean): void;
}
export interface IdentitySqlPool {
  connect(): Promise<IdentitySqlClient>;
}
export interface ResolvedIdentity {
  readonly actor: ActorRef;
  readonly policyRevision: number;
}
export class IdentityAccessError extends Error {
  constructor(readonly code: "IDENTITY_DENIED" | "IDENTITY_UNAVAILABLE") {
    super(code);
    this.name = "IdentityAccessError";
  }
}
export const identitySql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  role: "SELECT current_user AS role, session_user AS login, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, pg_catalog.pg_has_role(current_user, 'morrow_identity_owner', 'MEMBER') AS owner_member FROM pg_catalog.pg_roles WHERE rolname = current_user",
  timeout: "SET LOCAL statement_timeout = '5s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  bind: "SELECT pg_catalog.set_config('morrow.session_digest', $1, true) IS NOT NULL AND pg_catalog.set_config('morrow.requested_workspace', $2, true) IS NOT NULL AS configured",
  resolve:
    "SELECT principal_id, organization_id, workspace_id, membership_id, policy_revision::text FROM morrow_identity.resolved_context()",
  workspace:
    "SELECT id::text, organization_id::text, display_name FROM morrow_identity.workspaces WHERE id::text = $1",
  workspaceAuthority: `WITH context AS MATERIALIZED (SELECT * FROM morrow_identity.resolved_context())
SELECT c.principal_id, c.organization_id, c.workspace_id, c.membership_id, c.policy_revision::text,
COALESCE((SELECT jsonb_agg(g.payload ORDER BY g.id) FROM
 (SELECT id, payload FROM morrow_identity.grants
  WHERE organization_id::text=c.organization_id AND workspace_id::text=c.workspace_id
    AND membership_id::text=c.membership_id AND principal_id::text=c.principal_id
  ORDER BY id LIMIT 1001) g), '[]'::jsonb) AS grants
FROM context c JOIN morrow_identity.workspaces w ON w.id::text=c.workspace_id AND w.organization_id::text=c.organization_id`,
  commit: "COMMIT",
  rollback: "ROLLBACK",
});

export interface CurrentWorkspaceAuthority {
  readonly identity: ResolvedIdentity;
  readonly resource: Current_ResourceRef;
  readonly grants: readonly Current_Grant[];
}
export interface IdentityReadScope {
  readonly identity: ResolvedIdentity;
  readWorkspaceAuthority(): Promise<CurrentWorkspaceAuthority>;
  readWorkspace(): Promise<{ id: string; organizationId: string; displayName: string }>;
}
const denied = () => new IdentityAccessError("IDENTITY_DENIED");
function decodeContext(
  rows: readonly Record<string, unknown>[],
  requestedWorkspace: string,
): ResolvedIdentity {
  const row = rows[0];
  if (
    !row ||
    rows.length !== 1 ||
    Object.keys(row).sort().join(",") !==
      "membership_id,organization_id,policy_revision,principal_id,workspace_id"
  )
    throw denied();
  if (typeof row.policy_revision !== "string" || !/^[1-9][0-9]{0,15}$/.test(row.policy_revision))
    throw denied();
  const revision = Number(row.policy_revision);
  const actor = {
    kind: "human",
    principalId: row.principal_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    membershipId: row.membership_id,
    installationId: null,
    mandateId: null,
  };
  if (
    !validateDefinition("core", "ActorRef", actor) ||
    !validateDefinition("core", "Revision", revision) ||
    actor.workspaceId !== requestedWorkspace ||
    actor.membershipId === null
  )
    throw denied();
  return Object.freeze({ actor: Object.freeze(actor) as ActorRef, policyRevision: revision });
}

// Narrow read scope only, not an authorization grant or dispatch API. Every
// protected SQL statement checks current durable membership under READ COMMITTED.
// Callbacks cannot get the connection or retain a usable scope after completion.
export async function withIdentityRead<T>(
  pool: IdentitySqlPool,
  serverSessionDigest: string,
  requestedWorkspace: string,
  read: (scope: IdentityReadScope) => Promise<T>,
): Promise<T> {
  if (
    typeof serverSessionDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(serverSessionDigest) ||
    !validateDefinition("core", "Id", requestedWorkspace)
  )
    throw denied();
  let client: IdentitySqlClient;
  try {
    client = await pool.connect();
  } catch {
    throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
  }
  let open = false;
  let live = false;
  let discard = false;
  try {
    // Mark uncertain before BEGIN: even a lost response needs rollback/discard.
    open = true;
    await client.query(identitySql.begin);
    const { rows: roles } = await client.query(identitySql.role);
    if (
      roles.length !== 1 ||
      roles[0]?.role !== "morrow_api" ||
      roles[0]?.login !== "morrow_api" ||
      roles[0]?.rolsuper !== false ||
      roles[0]?.rolbypassrls !== false ||
      roles[0]?.rolcreatedb !== false ||
      roles[0]?.rolcreaterole !== false ||
      roles[0]?.owner_member !== false
    )
      throw denied();
    await client.query(identitySql.timeout);
    await client.query(identitySql.idleTimeout);
    await client.query(identitySql.bind, [serverSessionDigest, requestedWorkspace]);
    const identity = decodeContext(
      (await client.query(identitySql.resolve)).rows,
      requestedWorkspace,
    );
    live = true;
    const scope: IdentityReadScope = Object.freeze({
      identity,
      async readWorkspaceAuthority() {
        if (!live) throw denied();
        const rows = (await client.query(identitySql.workspaceAuthority)).rows;
        if (!live) throw denied();
        const row = rows[0];
        if (
          !row ||
          rows.length !== 1 ||
          Object.keys(row).sort().join(",") !==
            "grants,membership_id,organization_id,policy_revision,principal_id,workspace_id" ||
          !Array.isArray(row.grants) ||
          row.grants.length > 1000 ||
          // Current Grant (ADR-0022 item 2): a store-link grant names the store resource.
          !row.grants.every((g) => validateCurrentDefinition("Grant", g))
        )
          throw denied();
        const { grants, ...context } = row;
        const current = decodeContext([context], requestedWorkspace);
        if (
          current.actor.principalId !== identity.actor.principalId ||
          current.actor.membershipId !== identity.actor.membershipId ||
          current.actor.organizationId !== identity.actor.organizationId
        )
          throw denied();
        const resource: Current_ResourceRef = {
          organizationId: current.actor.organizationId,
          workspaceId: requestedWorkspace,
          storeId: null,
          connectionId: null,
          kind: "workspace",
          id: requestedWorkspace,
        };
        return { identity: current, resource, grants: grants as Current_Grant[] };
      },
      async readWorkspace() {
        if (!live) throw denied();
        const rows = (await client.query(identitySql.workspace, [requestedWorkspace])).rows;
        if (!live) throw denied();
        const row = rows[0];
        if (
          rows.length !== 1 ||
          !row ||
          Object.keys(row).sort().join(",") !== "display_name,id,organization_id" ||
          row.id !== requestedWorkspace ||
          row.organization_id !== identity.actor.organizationId ||
          typeof row.display_name !== "string" ||
          row.display_name.length < 1 ||
          row.display_name.length > 200
        )
          throw denied();
        return {
          id: requestedWorkspace,
          organizationId: row.organization_id as string,
          displayName: row.display_name,
        };
      },
    });
    const result = await read(scope);
    live = false;
    await client.query(identitySql.commit);
    open = false;
    return result;
  } catch (error) {
    live = false;
    if (open) {
      try {
        await client.query(identitySql.rollback);
      } catch {
        discard = true;
      }
    }
    if (error instanceof IdentityAccessError) throw error;
    throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
  } finally {
    live = false;
    try {
      client.release(discard);
    } catch {
      throw new IdentityAccessError("IDENTITY_UNAVAILABLE");
    }
  }
}
