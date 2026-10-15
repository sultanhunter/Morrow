import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localProviderSubjectPool } from "./local-provider-subject-sql.mjs";
import {
  createWorkosWorkspaceSelection,
  workspaceSelectionSql,
} from "../packages/identity/src/workos-workspace-selection.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "../tests/fixtures/workos-authentication-evidence.mjs";

const checks = [];
const check = (name, ok) => {
  if (!ok) throw Error("PROVIDER_SUBJECT_LAB_FAILED:" + name);
  checks.push({ name, passed: true });
};
const hash = (s) => createHash("sha256").update(s).digest("hex");
const literal = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const wid = (prefix, n) => prefix + "_" + String(n).padStart(26, "0");
const tables = [
  "identity_verification_profiles",
  "provider_subject_mappings",
  "provider_subject_profile_bindings",
];
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// Preserve the original seven-migration resolver laboratory after later appends.
const migrations = manifest.migrations.slice(0, 7).map((m) => {
  const text = readFileSync("migrations/" + m.file, "utf8");
  if (hash(text) !== m.sha256) throw Error("MIGRATION_CHECKSUM");
  return { m, text };
});
if (migrations.length !== 7 || migrations[6].m.sequence !== 7)
  throw Error("RESOLUTION_MIGRATION_REQUIRED");
// Capture the measured plan at startup; later plan changes cannot relabel a run.
const planSequence = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan
  .sequence;
if (!Number.isSafeInteger(planSequence) || planSequence < 78)
  throw Error("SELECTED_POLICY_PLAN_REQUIRED");
const adapterMetrics = [];
const faultInjectionMetrics = [];
const outcome = await localPostgresLab("P05.T01k", async ({ id, sql, image, version }) => {
  sql("CREATE DATABASE morrow; CREATE DATABASE morrow_subject_rollback;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  for (const m of migrations) sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow");
  const admin = (text) => sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  const exec = (text, role = "morrow_identity_resolution", failure = false, database = "morrow") =>
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
        role,
        "-d",
        database,
      ],
      text,
      failure,
    );
  const ownerDenies = (
    name,
    text,
    state = "P0001",
    fixed = "PROVIDER_IDENTITY_RECORD_IMMUTABLE",
  ) => {
    const result = exec("SET ROLE morrow_identity_owner;\n" + text, "postgres", true);
    check(
      name,
      result.status !== 0 &&
        result.stderr.includes(state) &&
        (fixed === null || result.stderr.includes(fixed)),
    );
  };
  check(
    "resolution_preparation_nologin_safe",
    sql(
      "SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) FROM pg_roles r WHERE rolname='morrow_identity_resolution';",
      "morrow",
    ) === "t",
  );
  // The rollback database installs the preceding bytes independently. An error
  // inside migration7 must leave no partial tables, function or privileges.
  sql("GRANT CREATE ON DATABASE morrow_subject_rollback TO morrow_identity_owner;");
  for (const m of migrations.slice(0, 6))
    sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow_subject_rollback");
  const failedMigration = exec(
    "SET ROLE morrow_identity_owner;\n" +
      migrations[6].text.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;"),
    "postgres",
    true,
    "morrow_subject_rollback",
  );
  check(
    "migration7_transaction_rolls_back",
    failedMigration.status !== 0 && /22012/.test(failedMigration.stderr),
  );
  check(
    "rollback_preserves_previous_schema",
    sql(
      "SELECT to_regclass('morrow_identity.authentication_exchange_admissions') IS NOT NULL AND to_regclass('morrow_identity.provider_subject_mappings') IS NULL AND to_regprocedure('morrow_identity.resolve_provider_subject_selection(text,text,text,text,text,text,text,text,text)') IS NULL;",
      "morrow_subject_rollback",
    ) === "t",
  );
  for (const [name, enable, disable] of [
    [
      "executor_login",
      "ALTER ROLE morrow_identity_resolution LOGIN;",
      "ALTER ROLE morrow_identity_resolution NOLOGIN;",
    ],
    [
      "executor_replication",
      "ALTER ROLE morrow_identity_resolution REPLICATION;",
      "ALTER ROLE morrow_identity_resolution NOREPLICATION;",
    ],
    [
      "owner_login",
      "ALTER ROLE morrow_identity_owner LOGIN;",
      "ALTER ROLE morrow_identity_owner NOLOGIN;",
    ],
    [
      "service_assumes_owner",
      "GRANT morrow_identity_owner TO morrow_identity_preauth;",
      "REVOKE morrow_identity_owner FROM morrow_identity_preauth;",
    ],
  ]) {
    sql(enable);
    const denied = exec(
      "SET ROLE morrow_identity_owner;\n" + migrations[6].text,
      "postgres",
      true,
      "morrow_subject_rollback",
    );
    check(
      "migration_prerequisite_" + name + "_denies",
      denied.status !== 0 &&
        denied.stderr.includes("P0001") &&
        denied.stderr.includes("RESOLUTION_ROLE_PREREQUISITES_INVALID"),
    );
    sql(disable);
  }
  check(
    "prerequisite_denials_leave_no_partial_schema",
    sql(
      "SELECT to_regclass('morrow_identity.provider_subject_mappings') IS NULL;",
      "morrow_subject_rollback",
    ) === "t",
  );
  // Local-only trust socket login; deployed role remains NOLOGIN by default.
  sql(
    "ALTER ROLE morrow_identity_resolution LOGIN; ALTER ROLE morrow_api LOGIN; ALTER ROLE morrow_identity_lifecycle LOGIN; ALTER ROLE morrow_identity_linking LOGIN; ALTER ROLE morrow_identity_preauth LOGIN;",
  );

  let sequence = 0;
  function fixture(options = {}) {
    const n = ++sequence;
    const f = {
      n,
      environment: options.environment ?? wid("environment", n),
      application: options.application ?? wid("app", n),
      client: options.client ?? wid("client", n),
      subject: options.subject ?? wid("user", n),
      profile: "profile_" + n,
      mapping: "mapping_" + n,
      principal: "person_" + n,
      organization: "organization_" + n,
      workspace: "workspace_" + n,
      membership: "membership_" + n,
      tokenDigest: options.tokenDigest ?? "a".repeat(64),
      tokenRevision: options.tokenRevision ?? 1,
      recordRevision: options.recordRevision ?? 1,
    };
    f.issuer = "https://api.workos.com/user_management/" + f.client;
    admin(`INSERT INTO morrow_identity.principals VALUES(${literal(f.principal)},'human',true);
INSERT INTO morrow_identity.organizations VALUES(${literal(f.organization)},'Synthetic',true,1);
INSERT INTO morrow_identity.workspaces VALUES(${literal(f.workspace)},${literal(f.organization)},'Synthetic',true);
INSERT INTO morrow_identity.memberships VALUES(${literal(f.membership)},${literal(f.organization)},${literal(f.principal)},true);
INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(f.organization)},${literal(f.workspace)},${literal(f.membership)},true);
INSERT INTO morrow_identity.identity_verification_profiles VALUES(${literal(f.profile)},'workos',${literal(f.environment)},${literal(f.application)},${literal(f.client)},${literal(f.issuer)},${literal(f.tokenRevision)},${literal(f.tokenDigest)},${literal(f.recordRevision)},'active');
INSERT INTO morrow_identity.provider_subject_mappings VALUES(${literal(f.mapping)},'workos',${literal(f.environment)},${literal(f.subject)},${literal(f.principal)},${literal(f.recordRevision)},'active');
INSERT INTO morrow_identity.provider_subject_profile_bindings VALUES(${literal(f.mapping)},${literal(f.profile)},'workos',${literal(f.environment)},${literal(f.recordRevision)},'active');`);
    return f;
  }
  const params = (f) => [
    "workos",
    f.environment,
    f.application,
    f.client,
    f.issuer,
    String(f.tokenRevision),
    f.tokenDigest,
    f.subject,
    f.workspace,
  ];
  const lookupSql = (values) =>
    "SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)::text FROM (SELECT * FROM morrow_identity.resolve_provider_subject_selection(" +
    values.map(literal).join(",") +
    ")) r;";
  const resolve = (f, replacements = {}) => {
    const values = params(f);
    for (const [index, value] of Object.entries(replacements)) values[Number(index)] = value;
    const result = exec(lookupSql(values));
    return JSON.parse(result.stdout.trim());
  };
  const baseline = fixture();
  const positive = resolve(baseline);
  check(
    "current_eligible_selector_one_closed_row",
    positive.length === 1 &&
      Object.keys(positive[0]).sort().join(",") ===
        "binding_revision,mapping_id,mapping_revision,membership_id,organization_id,policy_revision,principal_id,profile_id,profile_record_revision,workspace_id",
  );
  check(
    "all_output_ids_and_text_revisions_exact",
    JSON.stringify(positive[0]) ===
      JSON.stringify({
        profile_id: baseline.profile,
        profile_record_revision: "1",
        mapping_id: baseline.mapping,
        mapping_revision: "1",
        binding_revision: "1",
        principal_id: baseline.principal,
        organization_id: baseline.organization,
        workspace_id: baseline.workspace,
        membership_id: baseline.membership,
        policy_revision: "1",
      }),
  );
  for (const t of tables) {
    check(
      t + "_owner_force_rls",
      sql(
        `SELECT relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)='morrow_identity_owner' FROM pg_class WHERE oid='morrow_identity.${t}'::regclass;`,
        "morrow",
      ) === "t",
    );
    for (const role of [
      "morrow_identity_resolution",
      "morrow_api",
      "morrow_identity_lifecycle",
      "morrow_identity_linking",
      "morrow_identity_preauth",
    ]) {
      const select = exec(`SELECT * FROM morrow_identity.${t};`, role, true);
      check(role + "_cannot_enumerate_" + t, select.status !== 0 && /42501/.test(select.stderr));
      const update = exec(`UPDATE morrow_identity.${t} SET state='inactive';`, role, true);
      check(role + "_cannot_mutate_" + t, update.status !== 0 && /42501/.test(update.stderr));
      check(
        role + "_no_private_acl_" + t,
        sql(
          `SELECT NOT has_table_privilege(${literal(role)},'morrow_identity.${t}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');`,
          "morrow",
        ) === "t",
      );
    }
  }
  for (const role of [
    "morrow_api",
    "morrow_identity_lifecycle",
    "morrow_identity_linking",
    "morrow_identity_preauth",
  ]) {
    const denied = exec(lookupSql(params(baseline)), role, true);
    check(role + "_no_resolver_execution", denied.status !== 0 && /42501/.test(denied.stderr));
    check(
      role + "_cannot_assume_resolver",
      exec("SET ROLE morrow_identity_resolution;", role, true).status !== 0,
    );
  }
  sql("CREATE ROLE subject_public_test LOGIN NOINHERIT;");
  check(
    "public_has_no_schema_or_execution",
    exec(lookupSql(params(baseline)), "subject_public_test", true).status !== 0,
  );
  check(
    "set_role_does_not_change_session_user",
    JSON.parse(
      exec(
        "SET ROLE morrow_identity_resolution;\n" + lookupSql(params(baseline)),
        "postgres",
      ).stdout.trim(),
    ).length === 0,
  );
  check(
    "resolver_search_path_fixed_and_definer",
    sql(
      "SELECT prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=pg_catalog, morrow_identity, pg_temp'] FROM pg_proc WHERE oid='morrow_identity.resolve_provider_subject_selection(text,text,text,text,text,text,text,text,text)'::regprocedure;",
      "morrow",
    ) === "t",
  );
  const readOnly = exec("BEGIN READ ONLY;\n" + lookupSql(params(baseline)) + "\nCOMMIT;");
  check(
    "resolver_works_in_real_read_only_transaction",
    readOnly.status === 0 && JSON.parse(readOnly.stdout.trim()).length === 1,
  );
  check(
    "read_only_transaction_refuses_owner_write",
    exec(
      "SET ROLE morrow_identity_owner; BEGIN READ ONLY; UPDATE morrow_identity.principals SET active=false;",
      "postgres",
      true,
    ).status !== 0,
  );

  for (const [index, value] of [
    [0, "other"],
    [1, wid("environment", 9999)],
    [2, wid("app", 9999)],
    [3, wid("client", 9999)],
    [4, "https://untrusted.example/"],
    [5, "2"],
    [6, "b".repeat(64)],
    [7, wid("user", 9999)],
    [8, "foreign_workspace"],
  ])
    check(
      "exact_selector_field_" + index + "_mismatch_denies",
      resolve(baseline, { [index]: value }).length === 0,
    );
  for (const value of [
    "",
    "0",
    "01",
    "-1",
    "1.0",
    "1e0",
    "9007199254740992",
    "9".repeat(200),
    "NaN",
  ])
    check(
      "malformed_revision_" + hash(value).slice(0, 8) + "_zero_rows",
      resolve(baseline, { 5: value }).length === 0,
    );
  for (const index of Array.from({ length: 9 }, (_, n) => n)) {
    const p = params(baseline).map(literal);
    p[index] = "NULL";
    check(
      "null_selector_" + index + "_zero_rows",
      JSON.parse(
        exec(
          "SELECT COALESCE(json_agg(row_to_json(r)),'[]'::json)::text FROM (SELECT * FROM morrow_identity.resolve_provider_subject_selection(" +
            p.join(",") +
            ")) r;",
        ).stdout.trim(),
      ).length === 0,
    );
  }
  const otherEnvironment = fixture({ subject: baseline.subject });
  check(
    "same_subject_other_environment_distinct_person",
    resolve(otherEnvironment)[0].principal_id !== positive[0].principal_id,
  );
  check(
    "provider_environment_selector_cannot_cross_mapping",
    resolve(baseline, { 1: otherEnvironment.environment }).length === 0,
  );
  for (let n = 2; n <= 3; n++) {
    const client = wid("client", 10000 + n),
      app = wid("app", 10000 + n),
      profile = "sibling_profile_" + n;
    admin(
      `INSERT INTO morrow_identity.identity_verification_profiles VALUES(${literal(profile)},'workos',${literal(baseline.environment)},${literal(app)},${literal(client)},${literal("https://api.workos.com/user_management/" + client)},1,${literal(baseline.tokenDigest)},1,'active');` +
        (n === 2
          ? `INSERT INTO morrow_identity.provider_subject_profile_bindings VALUES(${literal(baseline.mapping)},${literal(profile)},'workos',${literal(baseline.environment)},1,'active');`
          : ""),
    );
    const result = resolve(baseline, {
      2: app,
      3: client,
      4: "https://api.workos.com/user_management/" + client,
    });
    check(
      n === 2 ? "second_explicit_client_same_human" : "unbound_sibling_client_denies",
      n === 2
        ? result.length === 1 &&
            result[0].principal_id === baseline.principal &&
            result[0].mapping_id === baseline.mapping
        : result.length === 0,
    );
  }
  const secondOrganization = "organization_second",
    secondWorkspace = "workspace_second",
    secondMembership = "membership_second";
  admin(
    `INSERT INTO morrow_identity.organizations VALUES('${secondOrganization}','Synthetic',true,6); INSERT INTO morrow_identity.workspaces VALUES('${secondWorkspace}','${secondOrganization}','Synthetic',true); INSERT INTO morrow_identity.memberships VALUES('${secondMembership}','${secondOrganization}',${literal(baseline.principal)},true); INSERT INTO morrow_identity.workspace_memberships VALUES('${secondOrganization}','${secondWorkspace}','${secondMembership}',true);`,
  );
  check(
    "second_eligible_organization_independent_selection",
    resolve(baseline, { 8: secondWorkspace })[0].organization_id === secondOrganization &&
      resolve(baseline)[0].organization_id === baseline.organization,
  );
  check(
    "foreign_existing_workspace_zero_rows",
    resolve(baseline, { 8: otherEnvironment.workspace }).length === 0,
  );
  ownerDenies(
    "stable_subject_unique",
    `INSERT INTO morrow_identity.provider_subject_mappings VALUES('duplicate_mapping','workos',${literal(baseline.environment)},${literal(baseline.subject)},${literal(otherEnvironment.principal)},1,'active');`,
    "23505",
    null,
  );
  ownerDenies(
    "exact_profile_namespace_unique",
    `INSERT INTO morrow_identity.identity_verification_profiles SELECT 'duplicate_profile',provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,1,'active' FROM morrow_identity.identity_verification_profiles WHERE id=${literal(baseline.profile)};`,
    "23505",
    null,
  );
  ownerDenies(
    "explicit_binding_pair_unique",
    `INSERT INTO morrow_identity.provider_subject_profile_bindings SELECT * FROM morrow_identity.provider_subject_profile_bindings WHERE mapping_id=${literal(baseline.mapping)} AND profile_id=${literal(baseline.profile)};`,
    "23505",
    null,
  );
  ownerDenies(
    "binding_mapping_environment_composite_fk",
    `INSERT INTO morrow_identity.provider_subject_profile_bindings VALUES(${literal(baseline.mapping)},${literal(otherEnvironment.profile)},'workos',${literal(otherEnvironment.environment)},1,'active');`,
    "23503",
    null,
  );
  ownerDenies(
    "binding_profile_environment_composite_fk",
    `INSERT INTO morrow_identity.provider_subject_profile_bindings VALUES(${literal(baseline.mapping)},${literal(otherEnvironment.profile)},'workos',${literal(baseline.environment)},1,'active');`,
    "23503",
    null,
  );
  ownerDenies(
    "mapping_must_reference_existing_principal",
    `INSERT INTO morrow_identity.provider_subject_mappings VALUES('missing_person_mapping','workos',${literal(baseline.environment)},${literal(wid("user", 88888))},'missing_person',1,'active');`,
    "23503",
    null,
  );
  ownerDenies(
    "profile_issuer_must_match_client",
    `INSERT INTO morrow_identity.identity_verification_profiles VALUES('wrong_issuer','workos',${literal(wid("environment", 88888))},${literal(wid("app", 88888))},${literal(wid("client", 88888))},'https://other.example',1,${literal("a".repeat(64))},1,'active');`,
    "23514",
    null,
  );

  for (const t of tables) {
    const where =
      t === "identity_verification_profiles"
        ? `id=${literal(baseline.profile)}`
        : t === "provider_subject_mappings"
          ? `id=${literal(baseline.mapping)}`
          : `mapping_id=${literal(baseline.mapping)} AND profile_id=${literal(baseline.profile)}`;
    ownerDenies(t + "_cannot_delete", `DELETE FROM morrow_identity.${t} WHERE ${where};`);
    ownerDenies(
      t + "_same_revision_update_denies",
      `UPDATE morrow_identity.${t} SET state='inactive' WHERE ${where};`,
      "P0001",
      "PROVIDER_IDENTITY_REVISION_INVALID",
    );
    ownerDenies(
      t + "_decreasing_revision_denies",
      `UPDATE morrow_identity.${t} SET record_revision=0 WHERE ${where};`,
      "23514",
      null,
    );
    ownerDenies(
      t + "_invalid_state_denies",
      `UPDATE morrow_identity.${t} SET record_revision=record_revision+1,state='other' WHERE ${where};`,
      "23514",
      null,
    );
  }
  ownerDenies(
    "grouped_truncate_cannot_reset_identity",
    `TRUNCATE morrow_identity.identity_verification_profiles,morrow_identity.provider_subject_mappings,morrow_identity.provider_subject_profile_bindings;`,
  );
  ownerDenies(
    "binding_only_truncate_cannot_reset_revision",
    `TRUNCATE morrow_identity.provider_subject_profile_bindings;`,
  );
  check(
    "all_three_statement_truncate_guards_installed",
    sql(
      "SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('morrow_identity.identity_verification_profiles'::regclass,'morrow_identity.provider_subject_mappings'::regclass,'morrow_identity.provider_subject_profile_bindings'::regclass) AND NOT tgisinternal AND (tgtype & 32)=32 AND (tgtype & 2)=2;",
      "morrow",
    ) === "3",
  );
  check("grouped_truncate_keeps_rows", resolve(baseline).length === 1);
  for (const [table, field, value, where] of [
    [tables[0], "id", "renamed_profile", `id=${literal(baseline.profile)}`],
    [tables[0], "client_id", wid("client", 77777), `id=${literal(baseline.profile)}`],
    [tables[0], "environment_id", wid("environment", 77777), `id=${literal(baseline.profile)}`],
    [tables[1], "subject_id", wid("user", 77777), `id=${literal(baseline.mapping)}`],
    [tables[1], "principal_id", otherEnvironment.principal, `id=${literal(baseline.mapping)}`],
    [
      tables[2],
      "profile_id",
      otherEnvironment.profile,
      `mapping_id=${literal(baseline.mapping)} AND profile_id=${literal(baseline.profile)}`,
    ],
  ])
    ownerDenies(
      "immutable_" + table + "_" + field,
      `UPDATE morrow_identity.${table} SET ${field}=${literal(value)},record_revision=record_revision+1 WHERE ${where};`,
    );
  const mutations = [
    [
      "profile",
      (f) =>
        `UPDATE morrow_identity.identity_verification_profiles SET state='inactive',record_revision=record_revision+1 WHERE id=${literal(f.profile)};`,
    ],
    [
      "mapping",
      (f) =>
        `UPDATE morrow_identity.provider_subject_mappings SET state='inactive',record_revision=record_revision+1 WHERE id=${literal(f.mapping)};`,
    ],
    [
      "binding",
      (f) =>
        `UPDATE morrow_identity.provider_subject_profile_bindings SET state='inactive',record_revision=record_revision+1 WHERE mapping_id=${literal(f.mapping)};`,
    ],
    [
      "principal",
      (f) => `UPDATE morrow_identity.principals SET active=false WHERE id=${literal(f.principal)};`,
    ],
    [
      "nonhuman",
      (f) => `UPDATE morrow_identity.principals SET kind='agent' WHERE id=${literal(f.principal)};`,
    ],
    [
      "organization",
      (f) =>
        `UPDATE morrow_identity.organizations SET active=false WHERE id=${literal(f.organization)};`,
    ],
    [
      "workspace",
      (f) => `UPDATE morrow_identity.workspaces SET active=false WHERE id=${literal(f.workspace)};`,
    ],
    [
      "membership",
      (f) =>
        `UPDATE morrow_identity.memberships SET active=false WHERE id=${literal(f.membership)};`,
    ],
    [
      "workspace_membership",
      (f) =>
        `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(f.workspace)};`,
    ],
  ];
  for (const [name, mutation] of mutations) {
    const f = fixture();
    admin(mutation(f));
    check(name + "_ineligible_zero_rows", resolve(f).length === 0);
  }
  for (const t of tables) {
    const f = fixture(),
      where =
        t === tables[0]
          ? `id=${literal(f.profile)}`
          : t === tables[1]
            ? `id=${literal(f.mapping)}`
            : `mapping_id=${literal(f.mapping)}`;
    admin(
      `UPDATE morrow_identity.${t} SET state='revoked',record_revision=record_revision+1 WHERE ${where};`,
    );
    check(t + "_revoked_denies", resolve(f).length === 0);
    ownerDenies(
      t + "_tombstone_cannot_reactivate",
      `UPDATE morrow_identity.${t} SET state='active',record_revision=record_revision+1 WHERE ${where};`,
      "P0001",
      "PROVIDER_IDENTITY_REVISION_INVALID",
    );
  }
  const revisionFixture = fixture();
  ownerDenies(
    "revision_jump_not_supported",
    `UPDATE morrow_identity.identity_verification_profiles SET record_revision=9007199254740991 WHERE id=${literal(revisionFixture.profile)};`,
    "P0001",
    "PROVIDER_IDENTITY_REVISION_INVALID",
  );
  ownerDenies(
    "revision_domain_rejects_unsafe_integer",
    `INSERT INTO morrow_identity.identity_verification_profiles VALUES('unsafe_revision','workos',${literal(wid("environment", 55555))},${literal(wid("app", 55555))},${literal(wid("client", 55555))},${literal("https://api.workos.com/user_management/" + wid("client", 55555))},1,${literal("a".repeat(64))},9007199254740992,'active');`,
    "23514",
    null,
  );
  admin(
    `UPDATE morrow_identity.identity_verification_profiles SET token_profile_revision=2,token_profile_digest=${literal("b".repeat(64))},record_revision=record_revision+1 WHERE id=${literal(revisionFixture.profile)};`,
  );
  check("profile_update_invalidates_original_token_profile", resolve(revisionFixture).length === 0);
  check(
    "updated_profile_revision_and_digest_exact",
    resolve(revisionFixture, { 5: "2", 6: "b".repeat(64) })[0].profile_record_revision === "2",
  );
  for (const flag of [
    "SUPERUSER",
    "BYPASSRLS",
    "CREATEDB",
    "CREATEROLE",
    "REPLICATION",
    "INHERIT",
  ]) {
    sql("ALTER ROLE morrow_identity_resolution " + flag + ";");
    check(
      "unsafe_executor_" + flag.toLowerCase() + "_definer_denies",
      resolve(baseline).length === 0,
    );
    sql("ALTER ROLE morrow_identity_resolution NO" + flag + ";");
  }
  for (const flag of [
    "LOGIN",
    "SUPERUSER",
    "BYPASSRLS",
    "CREATEDB",
    "CREATEROLE",
    "REPLICATION",
    "INHERIT",
  ]) {
    sql("ALTER ROLE morrow_identity_owner " + flag + ";");
    check("unsafe_owner_" + flag.toLowerCase() + "_definer_denies", resolve(baseline).length === 0);
    sql("ALTER ROLE morrow_identity_owner NO" + flag + ";");
  }
  sql("CREATE ROLE subject_membership_bridge NOLOGIN NOINHERIT;");
  for (const [name, grant, revoke] of [
    [
      "executor_inherits_role",
      "GRANT subject_membership_bridge TO morrow_identity_resolution;",
      "REVOKE subject_membership_bridge FROM morrow_identity_resolution;",
    ],
    [
      "role_can_assume_executor",
      "GRANT morrow_identity_resolution TO subject_membership_bridge;",
      "REVOKE morrow_identity_resolution FROM subject_membership_bridge;",
    ],
    [
      "api_can_assume_owner",
      "GRANT morrow_identity_owner TO morrow_api;",
      "REVOKE morrow_identity_owner FROM morrow_api;",
    ],
    [
      "owner_can_assume_preauth",
      "GRANT morrow_identity_preauth TO morrow_identity_owner;",
      "REVOKE morrow_identity_preauth FROM morrow_identity_owner;",
    ],
    [
      "transitive_service_owner",
      "GRANT morrow_identity_owner TO subject_membership_bridge; GRANT subject_membership_bridge TO morrow_identity_linking;",
      "REVOKE subject_membership_bridge FROM morrow_identity_linking; REVOKE morrow_identity_owner FROM subject_membership_bridge;",
    ],
  ]) {
    sql(grant);
    check(name + "_definer_denies", resolve(baseline).length === 0);
    sql(revoke);
  }
  sql("GRANT morrow_identity_owner TO subject_membership_bridge;");
  check("separate_admin_owner_maintenance_grant_preserved", resolve(baseline).length === 1);
  sql("REVOKE morrow_identity_owner FROM subject_membership_bridge;");
  const privateIds = [];
  const makeReader = (f) => {
    const handle = Object.freeze({}),
      at = Date.now();
    const evidence = Object.freeze({
      providerId: "workos",
      environmentId: f.environment,
      applicationId: f.application,
      clientId: f.client,
      issuer: f.issuer,
      subjectId: f.subject,
      providerSessionId: wid("session", f.n),
      tokenProvenance: "signature_verified",
      sessionClientBinding: "expected_only",
      sessionLiveness: "not_guaranteed",
      issuedAtMs: at - 1000,
      observedAtMs: at,
      expiresAtMs: at + 5000,
      tokenProfileRevision: f.tokenRevision,
      tokenProfileDigest: f.tokenDigest,
      keySetDigest: "c".repeat(64),
      observationProfileDigest: "d".repeat(64),
    });
    privateIds.push(evidence.providerSessionId);
    return { handle, readEvidence: (value) => (value === handle ? evidence : null) };
  };
  const trackPool = (options = {}) => {
    const p = localProviderSubjectPool(id, options);
    adapterMetrics.push(p.metrics);
    return p;
  };
  const runSelection = async (f, options = {}) => {
    const reader = makeReader(f),
      pool = trackPool(options),
      cancel = new AbortController();
    const service = createWorkosWorkspaceSelection({
      readEvidence: reader.readEvidence,
      pool,
      now: Date.now,
      signal: cancel.signal,
    });
    let timer;
    if (options.cancelAfterMs) timer = setTimeout(() => cancel.abort(), options.cancelAfterMs);
    try {
      return await service.resolve(
        reader.handle,
        JSON.stringify({ schemaVersion: 1, workspaceId: f.workspace }),
      );
    } finally {
      clearTimeout(timer);
      await pool.close();
      check(
        "pool_" + adapterMetrics.length + "_host_and_backend_cleanup",
        pool.metrics.connections === pool.metrics.closed &&
          pool.metrics.connections === pool.metrics.backendCleanupVerified,
      );
      check(
        "pool_" + adapterMetrics.length + "_no_session_id_in_sql_output",
        pool.observed.every((o) =>
          privateIds.every((s) => !o.stdout.includes(s) && !o.stderr.includes(s)),
        ),
      );
    }
  };
  const maximum = fixture({ recordRevision: 9007199254740991 });
  const maximumRow = resolve(maximum)[0];
  check(
    "maximum_safe_revisions_return_canonical_decimal_text",
    maximumRow.profile_record_revision === "9007199254740991" &&
      maximumRow.mapping_revision === "9007199254740991" &&
      maximumRow.binding_revision === "9007199254740991",
  );
  check(
    "maximum_safe_revisions_decode_through_actual_driver",
    (await runSelection(maximum)).selection?.mappingRevision === 9007199254740991,
  );
  const selected = await runSelection(baseline);
  check(
    "real_sql_application_private_synthetic_reader_positive",
    selected.outcome === "selected" &&
      selected.selection.workspaceId === baseline.workspace &&
      selected.selection.policyRevision === 1,
  );
  const driftMutations = [
    [
      "profile",
      (f) =>
        `UPDATE morrow_identity.identity_verification_profiles SET record_revision=record_revision+1 WHERE id=${literal(f.profile)};`,
    ],
    [
      "mapping",
      (f) =>
        `UPDATE morrow_identity.provider_subject_mappings SET record_revision=record_revision+1 WHERE id=${literal(f.mapping)};`,
    ],
    [
      "binding",
      (f) =>
        `UPDATE morrow_identity.provider_subject_profile_bindings SET record_revision=record_revision+1 WHERE mapping_id=${literal(f.mapping)};`,
    ],
    [
      "policy",
      (f) =>
        `UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(f.organization)};`,
    ],
    [
      "membership",
      (f) =>
        `UPDATE morrow_identity.memberships SET active=false WHERE id=${literal(f.membership)};`,
    ],
    [
      "workspace_membership",
      (f) =>
        `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(f.workspace)};`,
    ],
  ];
  for (const [name, mutation] of driftMutations) {
    const f = fixture();
    let first = false;
    const result = await runSelection(f, {
      afterResolve: async (count) => {
        if (count === 1) {
          first = true;
          admin(mutation(f));
        }
      },
    });
    check("separate_read_committed_" + name + "_drift_held", first && result.outcome === "held");
  }
  const stalled = await runSelection(fixture(), { stallLookup: true });
  check("actual_statement_timeout_no_selection", stalled.outcome === "held");
  const cancelled = await runSelection(fixture(), { stallLookup: true, cancelAfterMs: 120 });
  check("pending_lookup_cancellation_no_selection", cancelled.outcome === "held");
  const startupPool = trackPool({ stallStartup: true }),
    startupControl = { deadlineMs: Date.now() + 150, signal: new AbortController().signal };
  let startupRejected = false;
  try {
    await startupPool.connect(startupControl);
  } catch {
    startupRejected = true;
  }
  await startupPool.close();
  check(
    "startup_deadline_rejection_waits_actual_backend_cleanup",
    startupRejected &&
      startupPool.metrics.connections === startupPool.metrics.backendCleanupVerified &&
      startupPool.metrics.connections === startupPool.metrics.closed,
  );
  const preStartupCancel = new AbortController(),
    earlyPool = trackPool({ beforeStartup: () => preStartupCancel.abort() });
  let earlyRejected = false;
  try {
    await earlyPool.connect({ deadlineMs: Date.now() + 5000, signal: preStartupCancel.signal });
  } catch {
    earlyRejected = true;
  }
  await earlyPool.close();
  check(
    "cancellation_before_guest_startup_checks_absence_after_exec_closure",
    earlyRejected &&
      earlyPool.metrics.connections === earlyPool.metrics.closed &&
      earlyPool.metrics.backendCleanupVerified === 1,
  );
  const faultReader = makeReader(baseline),
    faultPool = localProviderSubjectPool(id, { killHostAfterStartup: true });
  const faultService = createWorkosWorkspaceSelection({
    readEvidence: faultReader.readEvidence,
    pool: faultPool,
    now: Date.now,
  });
  const faultResult = await faultService.resolve(
    faultReader.handle,
    JSON.stringify({ schemaVersion: 1, workspaceId: baseline.workspace }),
  );
  let faultReleaseRejected = false;
  try {
    await faultPool.close();
  } catch {
    faultReleaseRejected = true;
  }
  faultInjectionMetrics.push({ ...faultPool.metrics, fault: "host_sigkill_after_startup" });
  check(
    "actual_host_sigkill_yields_only_held_and_unverified_cleanup",
    faultResult.outcome === "held" &&
      faultReleaseRejected &&
      faultPool.metrics.connections === 1 &&
      faultPool.metrics.closed === 1 &&
      faultPool.metrics.backendCleanupVerified === 0 &&
      faultPool.metrics.unverifiedHostClosures === 1,
  );
  check(
    "fault_targeted_backend_absence_observed_but_container_fence_still_required",
    sql(
      "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_identity_resolution' AND application_name LIKE 'morrow_subject_%';",
      "morrow",
    ) === "0",
  );
  // Independent native RSA signer -> real owning T01i handle -> actual SQL.
  const realAt = Date.now(),
    rsa = buildWorkosAuthenticationEvidenceFixture({
      claims: { iat: Math.floor(realAt / 1000) - 1, exp: Math.floor(realAt / 1000) + 120 },
      snapshot: { observedAtMs: realAt - 1000, expiresAtMs: realAt + 299000 },
    });
  const evidenceFactory = createWorkosAuthenticationEvidence(rsa.profileJson, rsa.snapshotJson, {
    readPage: async () =>
      rsa.page([
        rsa.session({
          auth_method: "oauth",
          created_at: new Date(realAt - 60000).toISOString(),
          updated_at: new Date(realAt - 1000).toISOString(),
          expires_at: new Date(realAt + 60000).toISOString(),
        }),
      ]),
    currentProfile: () => rsa.profileJson,
    now: Date.now,
  });
  const verified = await evidenceFactory.verify(rsa.token);
  check("independent_rsa_owning_evidence_created", verified.outcome === "verified_active_evidence");
  const evidence = evidenceFactory.readEvidence(verified.handle);
  const genuine = fixture({
    environment: evidence.environmentId,
    application: evidence.applicationId,
    client: evidence.clientId,
    subject: evidence.subjectId,
    tokenDigest: evidence.tokenProfileDigest,
    tokenRevision: evidence.tokenProfileRevision,
  });
  const genuinePool = trackPool(),
    genuineService = createWorkosWorkspaceSelection({
      readEvidence: evidenceFactory.readEvidence,
      pool: genuinePool,
      now: Date.now,
    });
  const genuineResult = await genuineService.resolve(
    verified.handle,
    JSON.stringify({ schemaVersion: 1, workspaceId: genuine.workspace }),
  );
  await genuinePool.close();
  check(
    "native_rsa_owning_t01i_to_actual_sql_selection",
    genuineResult.outcome === "selected" &&
      genuineResult.selection.principalId === genuine.principal,
  );
  check(
    "genuine_composition_disposable_backend_closed",
    genuinePool.metrics.backendCleanupVerified === 1 && genuinePool.metrics.closed === 1,
  );
  check(
    "no_attributable_session_backends_remain",
    sql(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'morrow_subject_%';",
      "morrow",
    ) === "0",
  );
  check(
    "no_issuer_or_session_mutations",
    admin(
      "SELECT (SELECT count(*) FROM morrow_identity.sessions)=0 AND (SELECT count(*) FROM morrow_identity.authentication_exchange_admissions)=0;",
    ) === "t",
  );
  return { image, version };
});

mkdirSync("docs/evidence/P05.T01m", { recursive: true });
writeFileSync(
  "docs/evidence/P05.T01m/legacy-provider-subject-resolution-lab.json",
  JSON.stringify(
    {
      packet: "P05.T01k",
      planSequence,
      selectedPolicySequence: 78,
      synthetic: true,
      qualificationScope:
        "Current selected human-session policy with explicit oauth fixture through unchanged token/composition/selection into isolated SQL; SQL-specific fault and constraint scenarios use labeled trusted synthetic readers. No provider or issuer qualification.",
      historicalReport: {
        path: "docs/evidence/P05.T01j/postgresql-lab.json",
        sha256: "5a06e6fc90e3368873c86ede58e2f11f12f6f0daeece0459ed06f5ffca21f826",
      },
      providerRequests: 0,
      engine: outcome.image,
      version: outcome.version,
      checks,
      checkCount: checks.length,
      adapterMetrics,
      faultInjectionMetrics,
      cleanup: {
        containerRemoved: true,
        finalContainerFence: true,
        expectedUnverifiedFaults: faultInjectionMetrics.length,
      },
      sourceDigests: Object.fromEntries(
        [
          "migrations/0007.provider-subject-resolution.sql",
          "infra/identity-role-prerequisites.sql",
          "scripts/local-provider-subject-sql.mjs",
          "scripts/provider-subject-resolution-lab.mjs",
          "packages/identity/src/workos-workspace-selection.ts",
          "packages/identity/src/workos-authentication-evidence.ts",
          "packages/identity/src/workos-session-token.ts",
          "packages/identity/src/workos-session-status.ts",
          "packages/identity/src/workos-session-status-json.ts",
          "tests/fixtures/workos-authentication-evidence.mjs",
          "scripts/local-postgres-lab.mjs",
          "infra/local-engine.json",
          "migrations/manifest.json",
          ...migrations.slice(0, 6).map(({ m }) => "migrations/" + m.file),
        ].map((path) => [path, hash(readFileSync(path))]),
      ),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    packet: "P05.T01k",
    checks: checks.length,
    passed: checks.length,
    providerRequests: 0,
    containerRemoved: true,
  }),
);
