import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localIdentityPool } from "./local-identity-sql.mjs";
import { createWorkspacePermissionBoundary } from "../packages/policy/src/index.ts";
import { writeArtifact } from "./artifacts.mjs";
const checks = [];
const check = (name, condition) => {
  if (!condition) throw Error("PERMISSION_DATABASE_CHECK_FAILED:" + name);
  checks.push({ name, passed: true });
};
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// This preserved regression keeps its qualified pre-login-custody schema.
if (!Array.isArray(manifest.migrations) || manifest.migrations.length < 9)
  throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const selectedMigrations = manifest.migrations.slice(0, 9);
if (selectedMigrations.length !== 9) throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const migrations = selectedMigrations.map((m, index) => {
  const text = readFileSync("migrations/" + m.file, "utf8");
  if (m.sequence !== index + 1 || createHash("sha256").update(text).digest("hex") !== m.sha256)
    throw Error("MIGRATION_CHECKSUM");
  return { record: m, text };
});
const digests = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
const fixture = (letter) => {
  const actor = {
    kind: "human",
    principalId: "human_" + letter,
    organizationId: "org_" + letter,
    workspaceId: "workspace_" + letter,
    membershipId: "membership_" + letter,
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
    id: "grant_" + letter,
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
const a = fixture("a"),
  b = fixture("b");
// P01.T04a AC31: a paid capability (billable_job) next to the unpaid setup grant.
const paid = {
  grant: {
    ...a.grant,
    id: "grant_a_paid",
    capabilityId: "creative.image.generate",
    scope: { ...a.grant.scope, fields: ["briefRef"] },
  },
  request: { ...a.request, capabilityId: "creative.image.generate", fields: ["briefRef"] },
};
const observed = await localPostgresLab("P05.T02b", async ({ id, sql, image, version }) => {
  sql("CREATE DATABASE morrow; CREATE DATABASE morrow_grants_rollback;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  for (const { text } of migrations) sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  sql("GRANT CREATE ON DATABASE morrow_grants_rollback TO morrow_identity_owner;");
  sql("SET ROLE morrow_identity_owner;\n" + migrations[0].text, "morrow_grants_rollback");
  const failedMigration = containerCommand(
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
      "morrow_grants_rollback",
    ],
    "SET ROLE morrow_identity_owner;\n" +
      migrations[1].text.replace(/COMMIT;\s*$/, "SELECT 1 / 0; COMMIT;"),
    true,
  );
  check(
    "failed_grant_migration_rolls_back_table",
    failedMigration.status !== 0 &&
      sql("SELECT to_regclass('morrow_identity.grants') IS NULL;", "morrow_grants_rollback") ===
        "t",
  );
  check(
    "failed_grant_migration_preserves_prior_schema_and_constraint_set",
    sql(
      "SELECT count(*) FROM pg_catalog.pg_constraint WHERE conname='membership_principal_binding' AND conrelid='morrow_identity.memberships'::regclass;",
      "morrow_grants_rollback",
    ) === "0",
  );
  sql("ALTER ROLE morrow_api LOGIN;");
  const admin = (text) => sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  admin(`INSERT INTO morrow_identity.organizations (id,display_name,active) VALUES ('org_a','Synthetic A',true),('org_b','Synthetic B',true);
 INSERT INTO morrow_identity.principals (id,kind,active) VALUES ('human_a','human',true),('human_b','human',true);
 INSERT INTO morrow_identity.memberships (id,organization_id,principal_id,active) VALUES ('membership_a','org_a','human_a',true),('membership_b','org_b','human_b',true);
 INSERT INTO morrow_identity.workspaces (id,organization_id,display_name,active) VALUES ('workspace_a','org_a','Workspace A',true),('workspace_b','org_b','Workspace B',true);
 INSERT INTO morrow_identity.workspace_memberships VALUES ('org_a','workspace_a','membership_a',true),('org_b','workspace_b','membership_b',true);
 INSERT INTO morrow_identity.sessions VALUES ('session_a','human_a','org_a',${literal(digests[0])},'workos','synthetic_a',statement_timestamp()+interval '1 hour',NULL),('session_b','human_b','org_b',${literal(digests[1])},'workos','synthetic_b',statement_timestamp()+interval '1 hour',NULL);`);
  for (const f of [a, b, { ...a, grant: paid.grant }])
    admin(
      `INSERT INTO morrow_identity.grants VALUES (${literal(f.grant.id)},${literal(f.actor.organizationId)},${literal(f.actor.workspaceId)},${literal(f.actor.membershipId)},${literal(f.actor.principalId)},${literal(JSON.stringify(f.grant))}::jsonb);`,
    );
  const pool = localIdentityPool(id);
  try {
    let constraintsRead = 0;
    const boundary = createWorkspacePermissionBoundary(pool, {
      async readCurrent() {
        constraintsRead++;
        return { providerAllowed: true, entitlementAllowed: true };
      },
    });
    const decide = (digest, workspace, request) => boundary.decide(digest, workspace, request);
    check(
      "real_application_transaction_and_kernel_allow_exact_sql_grant",
      (await decide(digests[0], "workspace_a", a.request)).decision.allowed,
    );
    check(
      "second_merchant_has_independent_sql_grant",
      (await decide(digests[1], "workspace_b", b.request)).decision.allowed,
    );
    const deniedCount = constraintsRead;
    const foreign = await decide(digests[0], "workspace_a", b.request);
    check(
      "foreign_target_denied_before_constraint_lookup",
      !foreign.decision.allowed &&
        foreign.decision.reason === "scope_denied" &&
        constraintsRead === deniedCount,
    );
    const badSession = await decide(digests[0], "workspace_b", b.request).then(
      () => false,
      (error) => error.code === "IDENTITY_DENIED",
    );
    check("foreign_workspace_session_denied_by_actual_sql", badSession);
    const forged = await decide(randomBytes(32).toString("hex"), "workspace_a", a.request).then(
      () => false,
      (error) => error.code === "IDENTITY_DENIED",
    );
    check("forged_session_denied_by_actual_application_boundary", forged);
    const field = await decide(digests[0], "workspace_a", {
      ...a.request,
      fields: ["objective", "cost"],
    });
    check("actual_stored_grant_denies_field_extension", field.decision.reason === "field_denied");
    admin(
      "BEGIN; UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE id='grant_a'; UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id='org_a'; COMMIT;",
    );
    check(
      "actual_committed_grant_revocation_denies_next_call",
      (await decide(digests[0], "workspace_a", a.request)).decision.reason === "capability_denied",
    );
    admin(
      "UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}','null'::jsonb) WHERE id='grant_a';",
    );
    const changing = createWorkspacePermissionBoundary(pool, {
      async readCurrent() {
        admin(
          "UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id='org_a';",
        );
        return { providerAllowed: true, entitlementAllowed: true };
      },
    });
    check(
      "policy_change_during_constraint_wait_cannot_return_stale_allow",
      (await changing.decide(digests[0], "workspace_a", a.request)).decision.reason ===
        "precondition_conflict",
    );
    const removing = createWorkspacePermissionBoundary(pool, {
      async readCurrent() {
        admin(
          "BEGIN; UPDATE morrow_identity.memberships SET active=false WHERE id='membership_a'; UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id='org_a'; COMMIT;",
        );
        return { providerAllowed: true, entitlementAllowed: true };
      },
    });
    check(
      "membership_removed_during_constraint_wait_denies",
      await removing.decide(digests[0], "workspace_a", a.request).then(
        () => false,
        (error) => error.code === "IDENTITY_UNAVAILABLE",
      ),
    );
    admin("UPDATE morrow_identity.memberships SET active=true WHERE id='membership_a';");
    const provider = createWorkspacePermissionBoundary(pool, {
      async readCurrent() {
        return { providerAllowed: false, entitlementAllowed: true };
      },
    });
    check(
      "sql_identity_does_not_bypass_provider_constraints",
      (await provider.decide(digests[0], "workspace_a", a.request)).decision.reason ===
        "provider_denied",
    );
    const entitlement = createWorkspacePermissionBoundary(pool, {
      async readCurrent() {
        return { providerAllowed: true, entitlementAllowed: false };
      },
    });
    // Entitlement gates only paid work (P01.T04a AC31): setup stays allowed.
    check(
      "unrouted_setup_not_billing_gated",
      (await entitlement.decide(digests[0], "workspace_a", a.request)).decision.allowed,
    );
    check(
      "sql_identity_does_not_bypass_entitlement_constraints",
      (await entitlement.decide(digests[0], "workspace_a", paid.request)).decision.reason ===
        "entitlement_denied",
    );
    admin("UPDATE morrow_identity.grants SET payload=payload-'validFrom' WHERE id='grant_a';");
    check(
      "malformed_stored_grant_fails_closed_in_real_read_transaction",
      await decide(digests[0], "workspace_a", a.request).then(
        () => false,
        (error) => error.code === "IDENTITY_UNAVAILABLE",
      ),
    );
    admin(
      `UPDATE morrow_identity.grants SET payload=${literal(JSON.stringify(a.grant))}::jsonb WHERE id='grant_a';`,
    );
    check(
      "subsequent_clean_read_still_works_after_denied_transaction",
      (await decide(digests[0], "workspace_a", a.request)).decision.allowed,
    );
    admin(
      "UPDATE morrow_identity.sessions SET revoked_at=statement_timestamp() WHERE id='session_a';",
    );
    check(
      "actual_revoked_session_denies_application_permission",
      await decide(digests[0], "workspace_a", a.request).then(
        () => false,
        (error) => error.code === "IDENTITY_DENIED",
      ),
    );
    check(
      "other_merchant_unaffected_by_session_revocation",
      (await decide(digests[1], "workspace_b", b.request)).decision.allowed,
    );
    // Attack the table directly without the application read-only wrapper.
    const attacker = (text) =>
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
        true,
      );
    check(
      "direct_grant_write_denied",
      /42501:/.test(attacker("UPDATE morrow_identity.grants SET payload='{}';").stderr),
    );
    check(
      "missing_session_cannot_enumerate_grants",
      attacker("SELECT count(payload) FROM morrow_identity.grants;").stdout.trim() === "0",
    );
    const badBinding = containerCommand(
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
      "SET ROLE morrow_identity_owner; UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{principal,organizationId}','\"org_b\"'::jsonb) WHERE id='grant_a';",
      true,
    );
    check(
      "relational_and_json_tenant_binding_cannot_drift",
      badBinding.status !== 0 && /23514:/.test(badBinding.stderr),
    );
    check(
      "new_grant_table_force_rls_enabled",
      sql(
        "SELECT relrowsecurity AND relforcerowsecurity FROM pg_catalog.pg_class WHERE oid='morrow_identity.grants'::regclass;",
        "morrow",
      ) === "t",
    );
    const logs = containerCommand(["logs", id]);
    check(
      "all_psql_and_container_output_excludes_session_proofs",
      !digests.some(
        (d) =>
          logs.stdout.includes(d) ||
          logs.stderr.includes(d) ||
          pool.observed.some((o) => o.stdout.includes(d) || o.stderr.includes(d)),
      ),
    );
  } finally {
    await pool.close();
  }
  return { image, version };
});
writeArtifact(
  "labs/permissions.json",
  JSON.stringify(
    {
      task: "P05.T02b",
      observed_at: new Date().toISOString(),
      scope:
        "Actual application identity read transaction and shared permission kernel against owned isolated PostgreSQL17.11 grant/workspace records. Scripts-only psql adapter and synthetic session issuer/provider/entitlement facts; no production driver/WorkOS/HTTP/dispatch qualification.",
      ...observed,
      migrations: migrations.map((m) => ({ file: m.record.file, sha256: m.record.sha256 })),
      checks,
      limitations: [
        "Only the preserved migrations1–9 are installed; migration10 login custody is not installed or qualified by this regression.",
        "Grant issuance/audited lifecycle commands and dispatch serialization remain pending.",
        "Only identity-owned workspace resources resolve; other domain resource ownership awaits its integration.",
        "psql protocol adapter is local test-only, not a production pool, TLS/IAM proof or authenticator.",
        "Provider/entitlement constraints in this lab are explicit synthetic trusted-reader fixtures.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS: " +
    checks.length +
    " real application/SQL permission boundary checks; hosted/provider activation pending.",
);
