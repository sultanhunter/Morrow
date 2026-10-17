import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { identitySql } from "../packages/identity/src/index.ts";
import { writeArtifact } from "./artifacts.mjs";
const checks = [];
function check(name, condition) {
  if (!condition) throw Error("IDENTITY_LAB_CHECK_FAILED:" + name);
  checks.push({ name, passed: true });
}
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const migration = readFileSync("migrations/0001.identity-foundation.sql", "utf8");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const migrationDigest = createHash("sha256").update(migration).digest("hex");
if (manifest.migrations[0]?.sha256 !== migrationDigest) throw Error("MIGRATION_CHECKSUM");
const digests = Array.from({ length: 3 }, () => randomBytes(32).toString("hex"));
const session = (digest, workspace = "workspace_a") =>
  `${identitySql.begin};\n${identitySql.timeout};\n${identitySql.idleTimeout};\nPREPARE identity_bind(text,text) AS ${identitySql.bind};\nEXECUTE identity_bind(${literal(digest)},${literal(workspace)});\nDEALLOCATE identity_bind;\n`;
const visible = "SELECT count(*) FROM morrow_identity.workspaces;";
const report = await localPostgresLab("P05.T01a", async ({ id, sql, image, version }) => {
  sql("CREATE DATABASE morrow; CREATE DATABASE morrow_rollback;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  sql("GRANT CREATE ON DATABASE morrow_rollback TO morrow_identity_owner;");
  sql("SET ROLE morrow_identity_owner;\n" + migration, "morrow");
  const api = (text, allowFailure = false) =>
    containerCommand(
      [
        "exec",
        "--interactive",
        id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-U",
        "morrow_api",
        "-d",
        "morrow",
      ],
      text,
      allowFailure,
    );
  // Only this owned ephemeral lab grants LOGIN and trusts the private Unix socket.
  // Actual regional IAM/TLS/LOGIN must be separately qualified in P04.
  sql("ALTER ROLE morrow_api LOGIN;");
  check(
    "unprivileged_service_login",
    api(identitySql.role + ";").stdout.trim() === "morrow_api|morrow_api|f|f|f|f|f",
  );
  const broken = containerCommand(
    [
      "exec",
      "--interactive",
      id,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "morrow_rollback",
    ],
    "SET ROLE morrow_identity_owner;\n" + migration.replace(/COMMIT;\s*$/, "SELECT 1 / 0; COMMIT;"),
    true,
  );
  check(
    "failed_migration_rolls_back_schema",
    broken.status !== 0 &&
      sql(
        "SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='morrow_identity';",
        "morrow_rollback",
      ) === "0",
  );
  sql(
    `SET ROLE morrow_identity_owner;
 INSERT INTO morrow_identity.organizations (id,display_name,active) VALUES ('org_a','Synthetic A',true),('org_b','Synthetic B',true);
 INSERT INTO morrow_identity.principals (id,kind,active) VALUES ('human_a','human',true),('human_b','human',true);
 INSERT INTO morrow_identity.memberships (id,organization_id,principal_id,active) VALUES ('membership_a','org_a','human_a',true),('membership_b','org_b','human_b',true);
 INSERT INTO morrow_identity.workspaces (id,organization_id,display_name,active) VALUES ('workspace_a','org_a','Workspace A',true),('workspace_b','org_b','Workspace B',true),('workspace_a2','org_a','Unassigned A',true);
 INSERT INTO morrow_identity.workspace_memberships VALUES ('org_a','workspace_a','membership_a',true),('org_b','workspace_b','membership_b',true);
 INSERT INTO morrow_identity.sessions VALUES ('session_a','human_a','org_a',${literal(digests[0])},'workos','synthetic_provider_a',statement_timestamp()+interval '1 hour',NULL),('session_b','human_b','org_b',${literal(digests[1])},'workos','synthetic_provider_b',statement_timestamp()+interval '1 hour',NULL),('session_expired','human_a','org_a',${literal(digests[2])},'workos','synthetic_expired',statement_timestamp()-interval '1 second',NULL);`,
    "morrow",
  );
  check("missing_context_returns_no_rows", api(visible).stdout.trim() === "0");
  check(
    "exact_typed_workspace_query_reads_only_eligible_projection",
    api(
      session(digests[0]) +
        `PREPARE identity_workspace(text) AS ${identitySql.workspace}; EXECUTE identity_workspace('workspace_a'); DEALLOCATE identity_workspace; COMMIT;`,
    ).stdout.trim() === "t\nworkspace_a|org_a|Workspace A",
  );

  check(
    "valid_session_only_sees_assigned_workspace",
    api(session(digests[0]) + visible + "\n" + identitySql.commit + ";").stdout.trim() === "t\n1",
  );
  check(
    "another_merchant_session_only_sees_their_workspace",
    api(
      session(digests[1], "workspace_b") + visible + "\n" + identitySql.commit + ";",
    ).stdout.trim() === "t\n1",
  );
  for (const [name, digest, workspace] of [
    ["forged_session", randomBytes(32).toString("hex"), "workspace_a"],
    ["cross_organization", digests[0], "workspace_b"],
    ["unassigned_same_organization_workspace", digests[0], "workspace_a2"],
    ["expired_session", digests[2], "workspace_a"],
  ])
    check(
      name + "_returns_no_rows",
      api(session(digest, workspace) + visible + "\n" + identitySql.commit + ";").stdout.trim() ===
        "t\n0",
    );
  check(
    "client_organization_guc_confers_no_authority",
    api(
      session(digests[0], "workspace_b") +
        "SET LOCAL morrow.organization_id = 'org_b';\n" +
        visible +
        "\nCOMMIT;",
    ).stdout.trim() === "t\n0",
  );
  check(
    "transaction_context_cleared_after_commit",
    api(session(digests[0]) + visible + "\nCOMMIT;\n" + visible).stdout.trim() === "t\n1\n0",
  );
  check(
    "transaction_context_cleared_after_rollback",
    api(session(digests[0]) + visible + "\nROLLBACK;\n" + visible).stdout.trim() === "t\n1\n0",
  );
  check(
    "same_connection_next_merchant_is_isolated",
    api(
      session(digests[0]) +
        visible +
        "\nCOMMIT;\n" +
        session(digests[1], "workspace_b") +
        "SELECT id FROM morrow_identity.workspaces;\nCOMMIT;",
    ).stdout.trim() === "t\n1\nt\nworkspace_b",
  );
  for (const [name, statement] of [
    ["private_sessions_read", "SELECT session_digest FROM morrow_identity.sessions;"],
    ["private_memberships_read", "SELECT * FROM morrow_identity.memberships;"],
    ["private_principals_read", "SELECT * FROM morrow_identity.principals;"],
    [
      "session_issuer_write",
      "INSERT INTO morrow_identity.sessions SELECT * FROM morrow_identity.sessions;",
    ],
    ["workspace_write", "UPDATE morrow_identity.workspaces SET display_name='Forged';"],
    ["workspace_truncate", "TRUNCATE morrow_identity.workspaces CASCADE;"],
    ["owner_role_escalation", "SET ROLE morrow_identity_owner;"],
    ["disable_rls", "ALTER TABLE morrow_identity.workspaces DISABLE ROW LEVEL SECURITY;"],
    ["row_security_off", "SET row_security=off; " + visible],
    ["create_schema_object", "CREATE TABLE morrow_identity.forged(id text);"],
  ]) {
    // Bypass the application read-only wrapper deliberately: SQL privileges must
    // still deny writes/escalation on a normal read/write transaction.
    const result = api(session(digests[0]).replace(identitySql.begin, "BEGIN") + statement, true);
    check(name + "_denied", result.status !== 0 && /42501:/.test(result.stderr));
  }
  check(
    "force_rls_on_all_identity_tables",
    sql(
      "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='morrow_identity' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;",
      "morrow",
    ) === "6",
  );
  const fk = containerCommand(
    [
      "exec",
      "--interactive",
      id,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
      "-U",
      "postgres",
      "-d",
      "morrow",
    ],
    "SET ROLE morrow_identity_owner; INSERT INTO morrow_identity.workspace_memberships VALUES ('org_a','workspace_b','membership_a',true);",
    true,
  );
  check(
    "composite_fk_rejects_cross_organization_membership",
    fk.status !== 0 && /23503:/.test(fk.stderr),
  );
  // Same live service transaction: first statement resolves before revocation;
  // a later statement sees committed removal under READ COMMITTED, never a cache.
  async function concurrentRevocation() {
    const child = spawn(
      "docker",
      [
        "exec",
        "--interactive",
        id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "morrow_api",
        "-d",
        "morrow",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    let resolvedReady;
    const ready = new Promise((resolve) => {
      resolvedReady = resolve;
    });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("READY\n")) resolvedReady();
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const done = new Promise((resolve, reject) => {
      child.on("error", () => reject(Error("LOCAL_IDENTITY_CLIENT_FAILED")));
      child.on("exit", (code) => resolve(code));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvedReady();
    }, 8000);
    try {
      child.stdin.write(session(digests[0]) + identitySql.resolve + ";\nSELECT 'READY';\n");
      await ready;
      if (!out.includes("READY\n")) throw Error("LOCAL_IDENTITY_CLIENT_TIMEOUT");
      sql(
        "SET ROLE morrow_identity_owner; BEGIN; UPDATE morrow_identity.memberships SET active=false WHERE id='membership_a'; UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id='org_a'; COMMIT;",
        "morrow",
      );
      child.stdin.end(visible + "\nCOMMIT;");
      check(
        "committed_revocation_denies_next_statement_in_same_transaction",
        (await done) === 0 &&
          out.includes("human_a|org_a|workspace_a|membership_a|1\n") &&
          out.trim().endsWith("READY\n0"),
      );
      check(
        "concurrent_client_output_contains_no_session_proof",
        !digests.some((d) => out.includes(d) || err.includes(d)),
      );
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
  await concurrentRevocation();
  sql(
    "SET ROLE morrow_identity_owner; UPDATE morrow_identity.memberships SET active=true WHERE id='membership_a'; UPDATE morrow_identity.sessions SET revoked_at=statement_timestamp() WHERE id='session_a';",
    "morrow",
  );
  check(
    "revoked_session_returns_no_rows",
    api(session(digests[0]) + visible + "\nCOMMIT;").stdout.trim() === "t\n0",
  );
  check(
    "another_merchant_unaffected_by_revocation",
    api(session(digests[1], "workspace_b") + visible + "\nCOMMIT;").stdout.trim() === "t\n1",
  );
  const logs = containerCommand(["logs", id]);
  check(
    "container_stdout_stderr_contains_no_session_proof",
    !digests.some((d) => logs.stdout.includes(d) || logs.stderr.includes(d)),
  );
  return { image, version };
});
const source = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
writeArtifact(
  "labs/identity.json",
  JSON.stringify(
    {
      task: "P05.T01a",
      plan_sequence: source.sources.plan.sequence,
      observed_at: new Date().toISOString(),
      scope:
        "Actual isolated PostgreSQL17.11 immutable application migration and unprivileged SQL tenant boundary. Synthetic issuer/session data only; no WorkOS/provider/production authentication or capability authorization.",
      ...report,
      migration_sha256: migrationDigest,
      checks,
      limitations: [
        "Private local Unix socket trust is not regional TLS/IAM authentication.",
        "Typed SQL port has no production pool/WorkOS issuer yet.",
        "READ COMMITTED statement revocation is not cancellation of already running reads or provider effects.",
        "Identity-owner maintenance policy is explicitly privileged; actual role graph/hosted policies still require qualification.",
        "Audited lifecycle commands, teams, SSO/SCIM, linking, grants and automation remain follow-on work.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS: " +
    checks.length +
    " actual PostgreSQL identity boundary checks; provider/hosted acceptance pending.",
);
