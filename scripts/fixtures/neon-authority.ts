// Trusted operator laboratory only. Never deploy or accept merchant content.
import { Client } from "@neondatabase/serverless";
import { createNeonIdentityClient, withNeonIdentityRead } from "../../packages/identity/src/neon";
import { createWorkspacePermissionBoundary } from "../../packages/policy/src/index";
import type { IdentitySqlPool, IdentityReadScope } from "../../packages/identity/src/index";
interface Input {
  hostname: string;
  database: string;
  ownerUser: string;
  ownerPassword: string;
  environment: "staging";
  projectId: string;
  branchId: string;
  runtimePassword: string;
  runId: string;
  proofs: string[];
  migrations: string[];
}
const closed = async (c: Client) => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      c.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("CLOSE_FAILED")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
};
const ok = (value: unknown) => {
  if (!value) throw Error("CHECK_FAILED");
};
export default {
  async fetch(request: Request, env: { QUALIFICATION: string }) {
    const action = new URL(request.url).pathname.slice(1);
    if (
      request.method !== "POST" ||
      !["inspect", "install", "resume-roles", "seed", "test", "cleanup"].includes(action)
    )
      return new Response(null, { status: 404 });
    const i = JSON.parse(env.QUALIFICATION) as Input;
    const binding = {
      environment: i.environment,
      projectId: i.projectId,
      branchId: i.branchId,
      hostname: i.hostname,
      database: i.database,
    };
    const operator = async () => {
      const c = new Client({
        host: i.hostname,
        port: 5432,
        database: i.database,
        user: i.ownerUser,
        password: i.ownerPassword,
        ssl: false,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
        application_name: "morrow-authority-qualification",
      });
      c.neonConfig.useSecureWebSocket = true;
      c.neonConfig.forceDisablePgSSL = true;
      c.neonConfig.wsProxy = `${i.hostname}/v2`;
      c.neonConfig.pipelineConnect = false;
      c.neonConfig.webSocketConstructor = WebSocket;
      c.on("error", () => {});
      try {
        await c.connect();
        const r = (
          await c.query(
            "SELECT current_database() AS db,current_user AS login,current_setting('server_version_num') AS version",
          )
        ).rows[0];
        ok(
          r.db === i.database &&
            r.login === i.ownerUser &&
            Number(r.version) >= 170000 &&
            Number(r.version) < 180000,
        );
        return c;
      } catch (e) {
        await closed(c);
        throw e;
      }
    };
    const checks: string[] = [];
    const check = (name: string, value: unknown) => {
      ok(value);
      checks.push(name);
    };
    const id = (suffix: string) => i.runId + "_" + suffix;
    const fixture = (letter: string) => {
      const actor = {
        kind: "human",
        principalId: id("human_" + letter),
        organizationId: id("org_" + letter),
        workspaceId: id("workspace_" + letter),
        membershipId: id("membership_" + letter),
        installationId: null,
        mandateId: null,
      };
      const resource = {
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        storeId: null,
        connectionId: null,
        kind: "workspace",
        id: actor.workspaceId,
      };
      const grant = {
        id: id("grant_" + letter),
        principal: actor,
        capabilityId: "workspace.goal.create",
        verbs: ["execute"],
        scope: {
          organizationId: actor.organizationId,
          workspaceId: actor.workspaceId,
          storeIds: [],
          accountIds: [],
          resources: [resource],
          fields: ["objective"],
        },
        issuedBy: actor,
        validFrom: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        policyRevision: 1,
      };
      return {
        actor,
        resource,
        grant,
        request: {
          capabilityId: grant.capabilityId,
          verb: "execute",
          resource,
          accountId: null,
          fields: ["objective"],
        },
      };
    };
    let admin: Client | undefined;
    let step: string | undefined;
    try {
      if (["inspect", "install", "resume-roles"].includes(action)) {
        admin = await operator();
        const state = (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('morrow_api','morrow_identity_owner')) AS roles,(SELECT count(*)::int FROM pg_namespace WHERE nspname='morrow_identity') AS schemas",
          )
        ).rows[0];
        if (action === "inspect") {
          const details = {
            operator: (
              await admin.query(
                "SELECT rolcreaterole,rolcreatedb,rolsuper,pg_has_role(current_user,'neon_superuser','MEMBER') AS neon_member FROM pg_roles WHERE rolname=current_user",
              )
            ).rows,
            roles: (
              await admin.query(
                "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname IN ('morrow_api','morrow_identity_owner') ORDER BY rolname",
              )
            ).rows,
            memberships: (
              await admin.query(
                "SELECT r.rolname AS role,m.rolname AS member,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname IN ('morrow_api','morrow_identity_owner') OR m.rolname IN ('morrow_api','morrow_identity_owner') ORDER BY r.rolname,m.rolname",
              )
            ).rows,
            owner_set:
              state.roles === 2
                ? (
                    await admin.query(
                      "SELECT pg_has_role(current_user,'morrow_identity_owner','SET') AS can_set,has_database_privilege('morrow_identity_owner',current_database(),'CREATE') AS db_create",
                    )
                  ).rows
                : [],
            tables: (
              await admin.query(
                "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='morrow_identity' AND c.relkind='r' ORDER BY c.relname",
              )
            ).rows,
          };

          await closed(admin);
          admin = undefined;
          return Response.json({ passed: true, state, details });
        }
        step = "role_prerequisites";
        ok(state.schemas === 0 && state.roles === (action === "install" ? 0 : 2));
        ok(/^[a-f0-9]{64}$/.test(i.runtimePassword));
        ok(i.migrations.length === 3);
        if (action === "install") {
          await admin.query("BEGIN");
          await admin.query(
            "CREATE ROLE morrow_identity_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
          );
          await admin.query(
            "CREATE ROLE morrow_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '" +
              i.runtimePassword +
              "'",
          );
          await admin.query("GRANT CREATE ON DATABASE morrow_staging TO morrow_identity_owner");
          await admin.query("COMMIT");
        }
        const before = (
          await admin.query(
            "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname IN ('morrow_api','morrow_identity_owner') ORDER BY rolname",
          )
        ).rows;
        ok(
          before.length === 2 &&
            before.every(
              (r) =>
                !r.rolsuper &&
                !r.rolcreatedb &&
                !r.rolcreaterole &&
                !r.rolinherit &&
                !r.rolbypassrls,
            ) &&
            before[0].rolcanlogin === true &&
            before[1].rolcanlogin === false,
        );
        ok(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname IN ('morrow_api'))",
            )
          ).rows[0].n === 0,
        );
        step = "operator_owner_set";
        await admin.query(
          "GRANT morrow_identity_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE",
        );
        step = "switch_to_owner";
        await admin.query("SET ROLE morrow_identity_owner");
        for (const [index, migration] of i.migrations.entries()) {
          step = "migration_" + (index + 1);
          await admin.query(migration);
        }
        await admin.query("RESET ROLE");
        step = "installed_role_validation";
        const roles = (
          await admin.query(
            "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname IN ('morrow_api','morrow_identity_owner') ORDER BY rolname",
          )
        ).rows;
        ok(
          roles.length === 2 &&
            roles.every(
              (r) =>
                !r.rolsuper &&
                !r.rolcreatedb &&
                !r.rolcreaterole &&
                !r.rolinherit &&
                !r.rolbypassrls,
            ),
        );
        ok(roles[0].rolcanlogin === true && roles[1].rolcanlogin === false);
        const privileges = (
          await admin.query(
            "SELECT pg_has_role('morrow_api','morrow_identity_owner','MEMBER') AS owner_member,has_database_privilege('morrow_api',current_database(),'CREATE') AS db_create,has_schema_privilege('morrow_api','morrow_identity','CREATE') AS schema_create,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='morrow_api')) AS inherited_role",
          )
        ).rows[0];
        ok(
          !privileges.owner_member &&
            !privileges.db_create &&
            !privileges.schema_create &&
            !privileges.inherited_role,
        );
        const tables = (
          await admin.query(
            "SELECT count(*)::int AS count,bool_and(relrowsecurity AND relforcerowsecurity) AS forced FROM pg_class WHERE relnamespace='morrow_identity'::regnamespace AND relkind='r'",
          )
        ).rows[0];
        ok(tables.count === 9 && tables.forced);
        checks.push(
          "restricted_role_flags_and_membership",
          "three_immutable_migrations",
          "nine_force_rls_tables",
        );
      } else if (action === "seed" || action === "cleanup") {
        admin = await operator();
        await admin.query("BEGIN");
        await admin.query("SET LOCAL ROLE morrow_identity_owner");
        if (action === "seed") {
          for (const [index, letter] of ["a", "b"].entries()) {
            const f = fixture(letter),
              a = f.actor;
            await admin.query(
              "INSERT INTO morrow_identity.organizations(id,display_name,active) VALUES($1,'Synthetic qualification',true)",
              [a.organizationId],
            );
            await admin.query(
              "INSERT INTO morrow_identity.principals(id,kind,active) VALUES($1,'human',true)",
              [a.principalId],
            );
            await admin.query(
              "INSERT INTO morrow_identity.memberships(id,organization_id,principal_id,active) VALUES($1,$2,$3,true)",
              [a.membershipId, a.organizationId, a.principalId],
            );
            await admin.query(
              "INSERT INTO morrow_identity.workspaces(id,organization_id,display_name,active) VALUES($1,$2,'Synthetic workspace',true)",
              [a.workspaceId, a.organizationId],
            );
            await admin.query(
              "INSERT INTO morrow_identity.workspace_memberships VALUES($1,$2,$3,true)",
              [a.organizationId, a.workspaceId, a.membershipId],
            );
            await admin.query(
              "INSERT INTO morrow_identity.sessions VALUES($1,$2,$3,$4,'workos',$5,statement_timestamp()+interval '1 hour',NULL)",
              [
                id("session_" + letter),
                a.principalId,
                a.organizationId,
                i.proofs[index],
                id("provider_" + letter),
              ],
            );
            await admin.query(
              "INSERT INTO morrow_identity.grants VALUES($1,$2,$3,$4,$5,$6::jsonb)",
              [
                f.grant.id,
                a.organizationId,
                a.workspaceId,
                a.membershipId,
                a.principalId,
                JSON.stringify(f.grant),
              ],
            );
          }
          checks.push("two_synthetic_tenants_seeded");
        } else {
          for (const letter of ["a", "b"]) {
            const a = fixture(letter).actor;
            for (const [table, column, value] of [
              ["grants", "id", id("grant_" + letter)],
              ["sessions", "id", id("session_" + letter)],
              ["workspace_memberships", "workspace_id", a.workspaceId],
              ["workspaces", "id", a.workspaceId],
              ["memberships", "id", a.membershipId],
              ["principals", "id", a.principalId],
              ["organizations", "id", a.organizationId],
            ]) {
              await admin.query(`DELETE FROM morrow_identity.${table} WHERE ${column}::text=$1`, [
                value,
              ]);
              ok(
                (
                  await admin.query(
                    `SELECT count(*)::int AS n FROM morrow_identity.${table} WHERE ${column}::text=$1`,
                    [value],
                  )
                ).rows[0].n === 0,
              );
            }
          }
          checks.push("run_owned_fixture_cleanup_verified");
        }
        await admin.query("COMMIT");
      } else {
        const a = fixture("a"),
          b = fixture("b");
        const read = (
          proof: string,
          workspace: string,
          cb: (s: IdentityReadScope) => Promise<unknown>,
        ) => withNeonIdentityRead(binding, i.runtimePassword, proof, workspace, cb);
        const denied = async (fn: () => Promise<unknown>) => {
          try {
            await fn();
            return false;
          } catch (e) {
            return (e as { code?: string }).code === "IDENTITY_DENIED";
          }
        };
        let retained: IdentityReadScope | undefined;
        const mine = await read(i.proofs[0]!, a.actor.workspaceId, async (s) => {
          retained = s;
          return s.readWorkspace();
        });
        check("actual_adapter_own_workspace", (mine as { id: string }).id === a.actor.workspaceId);
        check("retained_scope_denied", await denied(() => retained!.readWorkspace()));
        check(
          "cross_tenant_proof_denied",
          await denied(() => read(i.proofs[0]!, b.actor.workspaceId, (s) => s.readWorkspace())),
        );
        check(
          "missing_proof_denied",
          await denied(() => read("0".repeat(64), a.actor.workspaceId, (s) => s.readWorkspace())),
        );
        await Promise.all([
          read(i.proofs[0]!, a.actor.workspaceId, async (s) => {
            ok((await s.readWorkspace()).id === a.actor.workspaceId);
          }),
          read(i.proofs[1]!, b.actor.workspaceId, async (s) => {
            ok((await s.readWorkspace()).id === b.actor.workspaceId);
          }),
        ]);
        checks.push("concurrent_tenant_context_isolation");
        const c = createNeonIdentityClient(binding, i.runtimePassword);
        c.on("error", () => {});
        try {
          await c.connect();
          const role = (await c.query("SELECT session_user AS login,current_user AS role")).rows[0];
          check("runtime_direct_login", role.login === "morrow_api" && role.role === "morrow_api");
          check(
            "no_context_no_visibility",
            (await c.query("SELECT count(*)::int AS n FROM morrow_identity.workspaces")).rows[0]
              .n === 0,
          );
          await c.query("BEGIN READ ONLY");
          await c.query(
            "SELECT set_config('morrow.session_digest',$1,true),set_config('morrow.requested_workspace',$2,true)",
            [i.proofs[0], a.actor.workspaceId],
          );
          await c.query("COMMIT");
          check(
            "commit_context_cleared",
            !(await c.query("SELECT current_setting('morrow.session_digest',true) AS v")).rows[0].v,
          );
          await c.query("BEGIN READ ONLY");
          await c.query("SELECT set_config('morrow.session_digest',$1,true)", [i.proofs[0]]);
          await c.query("ROLLBACK");
          check(
            "rollback_context_cleared",
            !(await c.query("SELECT current_setting('morrow.session_digest',true) AS v")).rows[0].v,
          );
          for (const [name, sql] of [
            ["private_sessions_denied", "SELECT session_digest FROM morrow_identity.sessions"],
            [
              "private_challenges_denied",
              "SELECT * FROM morrow_identity.authentication_challenges",
            ],
            [
              "runtime_write_denied",
              "UPDATE morrow_identity.workspaces SET display_name='forbidden'",
            ],
            ["owner_escalation_denied", "SET ROLE morrow_identity_owner"],
            ["grant_write_denied", "DELETE FROM morrow_identity.grants"],
          ]) {
            let refused = false;
            try {
              await c.query(sql!);
            } catch (e) {
              refused = (e as { code?: string }).code === "42501";
            }
            check(name!, refused);
          }
        } finally {
          await closed(c);
        }
        admin = await operator();
        await admin.query("SET ROLE morrow_identity_owner");
        const endings: Promise<void>[] = [];
        const pool: IdentitySqlPool = {
          async connect() {
            const client = createNeonIdentityClient(binding, i.runtimePassword);
            client.on("error", () => {});
            try {
              await client.connect();
            } catch (e) {
              await closed(client);
              throw e;
            }
            let released = false;
            return {
              async query(text, values = []) {
                ok(!released);
                return client.query(text, [...values]);
              },
              release() {
                ok(!released);
                released = true;
                const ending = closed(client);
                ending.catch(() => {});
                endings.push(ending);
              },
            };
          },
        };
        const decide = async (
          proof: string,
          workspace: string,
          value: unknown,
          change?: () => Promise<void>,
        ) => {
          try {
            return await createWorkspacePermissionBoundary(pool, {
              async readCurrent() {
                if (change) await change();
                return { providerAllowed: true, entitlementAllowed: true };
              },
            }).decide(proof, workspace, value);
          } finally {
            await Promise.all(endings.splice(0));
          }
        };
        check(
          "real_kernel_exact_sql_grant",
          (await decide(i.proofs[0]!, a.actor.workspaceId, a.request)).decision.allowed,
        );
        check(
          "foreign_resource_denied",
          !(await decide(i.proofs[0]!, a.actor.workspaceId, b.request)).decision.allowed,
        );
        const revised = await decide(i.proofs[0]!, a.actor.workspaceId, a.request, async () => {
          await admin!.query(
            "UPDATE morrow_identity.organizations SET policy_revision=2 WHERE id::text=$1",
            [a.actor.organizationId],
          );
        });
        check("revision_changed_during_wait_denied", !revised.decision.allowed);
        await admin.query(
          "UPDATE morrow_identity.organizations SET policy_revision=1 WHERE id::text=$1",
          [a.actor.organizationId],
        );
        check(
          "membership_revoked_between_reads",
          await denied(() =>
            read(i.proofs[0]!, a.actor.workspaceId, async (s) => {
              await s.readWorkspace();
              await admin!.query(
                "UPDATE morrow_identity.memberships SET active=false WHERE id::text=$1",
                [a.actor.membershipId],
              );
              return s.readWorkspace();
            }),
          ),
        );
        await admin.query("UPDATE morrow_identity.memberships SET active=true WHERE id::text=$1", [
          a.actor.membershipId,
        ]);
        await admin.query(
          "UPDATE morrow_identity.sessions SET revoked_at=clock_timestamp() WHERE id::text=$1",
          [id("session_a")],
        );
        check(
          "revoked_proof_denied",
          await denied(() => read(i.proofs[0]!, a.actor.workspaceId, (s) => s.readWorkspace())),
        );
        await admin.query(
          "UPDATE morrow_identity.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id::text=$1",
          [id("session_b")],
        );
        check(
          "expired_proof_denied",
          await denied(() => read(i.proofs[1]!, b.actor.workspaceId, (s) => s.readWorkspace())),
        );
      }
      if (admin) {
        await closed(admin);
        admin = undefined;
      }
      return Response.json({ passed: true, checks });
    } catch (error) {
      if (admin) {
        try {
          await admin.query("ROLLBACK");
        } catch {}
        try {
          await closed(admin);
        } catch {}
      }
      return Response.json(
        {
          passed: false,
          code: "NEON_AUTHORITY_FAILED",
          phase: action,
          ...(step ? { step } : {}),
          ...(error &&
          typeof error === "object" &&
          "code" in error &&
          ["42501", "42601", "23505", "23503", "42P01", "42704", "25P02"].includes(
            String(error.code),
          )
            ? { sqlstate: String(error.code) }
            : {}),
        },
        { status: 503 },
      );
    }
  },
};
