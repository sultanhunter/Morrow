import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { executorRoleMemberSql } from "../packages/identity/src/executor-role-preflight.ts";
import {
  administrator as A,
  applyChainAsAdministrator,
  applyChainAsSuperuser,
  classifyFailure,
  createAdministrator,
  d4Transaction,
  identityExecutors,
  manifestChain,
  migrationBody,
  morrowMembershipCensusSql,
  morrowRoles,
  morrowSetRowsSql,
  psqlAs,
} from "./fixtures/createrole-administrator.mjs";

// P04.T01j D8 (ADR-0020): the non-superuser migration administrator. Three throwaway
// network-none PostgreSQL 17 containers, one at a time:
//   B  a Neon-shaped NOBYPASSRLS CREATEROLE administrator: the apply-time boundary cases,
//      the chain with the D4 runner protocol, the positive state, the N1-N13 negative
//      matrix and the in-transaction (C) cases;
//   A  the same administrator with BYPASSRLS: the chain and the positives;
//   S  the local superuser shape of every other lab: its record and its zero-row census.
// The local superuser is used only for the D7 setup, the lab-only probe definer and the
// shapes marked "sim", which are impossible on Neon. No provider, credential or password:
// every login uses the container's local trust socket.
const hash = (v) => createHash("sha256").update(v).digest("hex");
const checks = [];
const check = (name, passed) => {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(name) || checks.some((c) => c.name === name))
    throw Error("CREATEROLE_ADMINISTRATOR_LAB_CHECK_NAME");
  if (passed !== true) {
    console.error("CREATEROLE_ADMINISTRATOR_LAB_FAILED_CHECK " + JSON.stringify({ check: name }));
    throw Error("CREATEROLE_ADMINISTRATOR_LAB_FAILED:" + name);
  }
  checks.push({ name, passed: true });
  console.log(JSON.stringify({ check: name, passed: true }));
};
const chain = manifestChain();
if (chain.length < 15 || chain[14].file !== "0015.work-state.sql")
  throw Error("CREATEROLE_ADMINISTRATOR_LAB_CHAIN_REQUIRED");
const sourcePaths = [
  "scripts/createrole-administrator-lab.mjs",
  "scripts/fixtures/createrole-administrator.mjs",
  "scripts/local-postgres-lab.mjs",
  "packages/identity/src/executor-role-preflight.ts",
  "infra/local-engine.json",
  "migrations/manifest.json",
  ...chain.map((m) => "migrations/" + m.file),
  ...chain.flatMap((m) => m.prerequisites.map((p) => p.file)),
];
const sourceHashes = Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(p))]));

const reviewed = [
  ["morrow_work_api", "morrow_api_worker"],
  ["morrow_work_command", "morrow_work_owner"],
];
const helpers = [
  "executor_memberships_closed",
  "memberships_closed",
  "morrow_memberships_closed",
  "preserve_migration_administrator",
  "recorded_administrator",
];
const workOwnerHelpers = [
  "memberships_closed",
  "morrow_memberships_closed",
  "recorded_administrator",
];
// Each run-time guard at the chain head calls executor_memberships_closed this many times
// (P04.T01j D3, after the later CREATE OR REPLACE redefinitions in 0013 and 0014).
const helperCallsAtHead = {
  bound_workspace_linking_handoff: 1,
  end_self_browser_family: 3,
  executor_role_safe: 1,
  link_workspace_store: 1,
  preauth_role_safe: 1,
  resolve_provider_subject_selection: 1,
};
const linkCall =
  "BEGIN;\nSELECT outcome FROM morrow_identity.link_workspace_store('h1','c1',repeat('a',64),repeat('b',64),repeat('c',64),'o1','w1','i1','install_first','1','1');\n" +
  "SELECT count(*) FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid();\nROLLBACK;\n";
const preflightSql = `SELECT ${executorRoleMemberSql} FROM pg_catalog.pg_roles r WHERE r.rolname=current_user;`;
const helperProbe =
  "DO $$ DECLARE s text:=''; BEGIN\n" +
  [
    "morrow_identity.recorded_administrator()",
    "morrow_identity.memberships_closed('morrow_api')",
    "morrow_identity.morrow_memberships_closed()",
    "morrow_identity.executor_memberships_closed('morrow_api')",
  ]
    .map(
      (call) =>
        ` BEGIN PERFORM ${call}; s:=s||'ok,'; EXCEPTION WHEN OTHERS THEN s:=s||SQLSTATE||','; END;\n`,
    )
    .join("") +
  " PERFORM pg_catalog.set_config('lab.helpers',s,false);\nEND $$;\nSELECT pg_catalog.current_setting('lab.helpers');";

function session(id) {
  const q = (text, user = "postgres") => psqlAs(id, text, { user });
  const attempt = (text, user = "postgres") => {
    const r = psqlAs(id, text, { user, allowFailure: true });
    return r.ok
      ? { ok: true, sqlstate: null, code: null }
      : { ok: false, ...classifyFailure(r.stderr) };
  };
  const asOwner = (text) => q("SET ROLE morrow_identity_owner;\n" + text);
  const closed = () => asOwner("SELECT morrow_identity.morrow_memberships_closed();") === "t";
  const setRows = () => Number(q(morrowSetRowsSql + ";"));
  const census = () =>
    q(morrowMembershipCensusSql + ";")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));
  const setupProbe = () =>
    q(
      "CREATE SCHEMA lab_probe AUTHORIZATION morrow_identity_owner;\nSET ROLE morrow_identity_owner;\n" +
        "CREATE FUNCTION lab_probe.guards() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$\n" +
        " SELECT concat_ws('|',COALESCE(morrow_identity.executor_role_safe(session_user::text)::text,'null'),\n" +
        "  CASE WHEN session_user='morrow_identity_preauth' THEN COALESCE(morrow_identity.preauth_role_safe()::text,'null') ELSE '-' END,\n" +
        "  COALESCE(morrow_identity.executor_memberships_closed(session_user)::text,'null')) $$;\n" +
        "REVOKE ALL ON FUNCTION lab_probe.guards() FROM PUBLIC;\n" +
        `GRANT USAGE ON SCHEMA lab_probe TO ${identityExecutors.join(",")};\n` +
        `GRANT EXECUTE ON FUNCTION lab_probe.guards() TO ${identityExecutors.join(",")};`,
    );
  const guards = (executor) => q("SELECT lab_probe.guards();", executor);
  const guardsPass = (executor) =>
    guards(executor) ===
    (executor === "morrow_identity_preauth" ? "true|true|true" : "true|-|true");
  const preflight = (executor) => q(preflightSql, executor);
  const linkLocks = () => {
    const [outcome, locks] = q(linkCall, "morrow_identity_linking").split("\n");
    return { outcome, locks: Number(locks) };
  };
  return {
    q,
    attempt,
    asOwner,
    closed,
    setRows,
    census,
    setupProbe,
    guards,
    guardsPass,
    preflight,
    linkLocks,
  };
}

const sameRows = (actual, expected) =>
  JSON.stringify(actual.map((r) => r.join("|")).sort()) ===
  JSON.stringify(expected.map((r) => r.join("|")).sort());
const createroleCensus = (admin) => [
  ...morrowRoles.map((role) => [role, admin, "t", "postgres", "t", "f", "f"]),
  ...reviewed.map(([role, member]) => [role, member, "f", admin, "f", "f", "t"]),
];

// The positive state shared by both createrole variants (AC04, AC06, AC13).
function positives(s, v) {
  check(`${v}_no_morrow_set_row_at_rest`, s.setRows() === 0);
  check(
    `${v}_census_is_15_creation_rows_and_2_reviewed_rows`,
    sameRows(s.census(), createroleCensus(A)),
  );
  const record = s.asOwner(
    "SELECT a.role_oid::bigint::text||'|'||a.role_name||'|'||(a.role_oid=r.oid)::text FROM morrow_identity.migration_administrator a, pg_catalog.pg_roles r WHERE r.rolname='neondb_owner';",
  );
  check(`${v}_record_is_the_administrator`, /^[0-9]+\|neondb_owner\|true$/.test(record));
  check(`${v}_every_morrow_role_closed`, s.closed());
  s.q(identityExecutors.map((e) => `ALTER ROLE ${e} LOGIN;`).join("\n"), A);
  s.setupProbe();
  check(
    `${v}_nine_executors_pass_their_guards`,
    identityExecutors.every((e) => s.guardsPass(e)),
  );
  check(
    `${v}_preflight_false_for_nine_executors`,
    identityExecutors.every((e) => s.preflight(e) === "f"),
  );
  const link = s.linkLocks();
  check(
    `${v}_link_workspace_store_passes_its_guard`,
    link.outcome === "denied" && link.locks === 1,
  );
}

// The shapes of the negative matrix (D8). setup and undo are [user, SQL]; "sim" marks a
// shape that only a superuser can produce.
const negatives = [
  {
    n: "n1_second_admin_granted_by_administrator",
    setup: [
      A,
      "GRANT morrow_identity_linking TO lab_other WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;",
    ],
    undo: [A, "REVOKE morrow_identity_linking FROM lab_other GRANTED BY neondb_owner;"],
    runtime: true,
    preflight: true,
  },
  {
    n: "n2_second_admin_bootstrap_grantor_sim",
    setup: [
      "postgres",
      "GRANT morrow_identity_linking TO lab_other WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY postgres;",
    ],
    undo: ["postgres", "REVOKE morrow_identity_linking FROM lab_other GRANTED BY postgres;"],
    runtime: true,
    preflight: true,
  },
  {
    n: "n3_creation_row_gains_inherit_sim",
    setup: [
      "postgres",
      "GRANT morrow_identity_linking TO neondb_owner WITH INHERIT TRUE GRANTED BY postgres;",
    ],
    undo: [
      "postgres",
      "GRANT morrow_identity_linking TO neondb_owner WITH INHERIT FALSE GRANTED BY postgres;",
    ],
    runtime: true,
    preflight: true,
  },
  {
    n: "n4_creation_row_gains_set_sim",
    setup: [
      "postgres",
      "GRANT morrow_identity_linking TO neondb_owner WITH SET TRUE GRANTED BY postgres;",
    ],
    undo: [
      "postgres",
      "GRANT morrow_identity_linking TO neondb_owner WITH SET FALSE GRANTED BY postgres;",
    ],
    runtime: true,
    preflight: true,
  },
  {
    n: "n5_administrator_regrants_itself",
    setup: [A, "GRANT morrow_identity_linking TO neondb_owner WITH INHERIT TRUE;"],
    undo: [A, "REVOKE morrow_identity_linking FROM neondb_owner GRANTED BY neondb_owner;"],
    runtime: true,
    preflight: true,
  },
  {
    n: "n6_runner_set_row_on_owner_at_rest",
    setup: [
      A,
      "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;",
    ],
    undo: [A, "REVOKE morrow_identity_owner FROM neondb_owner GRANTED BY neondb_owner;"],
    runtime: true,
    preflight: false,
  },
  {
    n: "n7_executor_member_of_predefined_role_sim",
    setup: ["postgres", "GRANT pg_read_all_data TO morrow_identity_linking;"],
    undo: ["postgres", "REVOKE pg_read_all_data FROM morrow_identity_linking;"],
    runtime: true,
    preflight: true,
  },
  {
    n: "n8_linking_granted_to_morrow_api",
    setup: [A, "GRANT morrow_identity_linking TO morrow_api;"],
    undo: [A, "REVOKE morrow_identity_linking FROM morrow_api;"],
    runtime: true,
    preflight: true,
  },
  {
    n: "n9_member_of_the_administrator_sim",
    setup: ["postgres", "GRANT neondb_owner TO lab_outsider WITH INHERIT FALSE, SET TRUE;"],
    undo: ["postgres", "REVOKE neondb_owner FROM lab_outsider;"],
    runtime: true,
    preflight: false,
  },
  {
    n: "n10_record_tampered_sim",
    setup: [
      "postgres",
      "ALTER TABLE morrow_identity.migration_administrator DISABLE TRIGGER migration_administrator_immutable;\nUPDATE morrow_identity.migration_administrator SET role_name='lab_other';",
    ],
    undo: [
      "postgres",
      "UPDATE morrow_identity.migration_administrator SET role_name='neondb_owner';\nALTER TABLE morrow_identity.migration_administrator ENABLE TRIGGER migration_administrator_immutable;",
    ],
    runtime: true,
    preflight: false,
  },
  {
    n: "n11_administrator_superuser_sim",
    setup: ["postgres", "ALTER ROLE neondb_owner SUPERUSER;"],
    undo: ["postgres", "ALTER ROLE neondb_owner NOSUPERUSER;"],
    runtime: true,
    preflight: true,
  },
  {
    n: "n12_reviewed_pair_gains_admin",
    setup: [A, "GRANT morrow_work_api TO morrow_api_worker WITH ADMIN TRUE;"],
    undo: [
      A,
      "REVOKE ADMIN OPTION FOR morrow_work_api FROM morrow_api_worker GRANTED BY neondb_owner;",
    ],
    runtime: false,
    preflight: false,
  },
  {
    n: "n13_morrow_role_under_createrole_self_grant",
    setup: [
      A,
      "SET createrole_self_grant='set, inherit';\nCREATE ROLE morrow_probe_selfgrant NOLOGIN NOINHERIT;",
    ],
    undo: [A, "DROP ROLE morrow_probe_selfgrant;"],
    runtime: false,
    preflight: false,
  },
];

// The (C) cases (AC08), each inside one administrator transaction that is rolled back.
const inTransaction = [
  {
    c: "c1_runner_row_tolerated_for_identity_owner",
    sql: "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\nSET LOCAL ROLE morrow_identity_owner;\nSELECT morrow_identity.morrow_memberships_closed();",
    expected: "t",
  },
  {
    c: "c2_runner_row_with_inherit_denied",
    sql: "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;\nSET LOCAL ROLE morrow_identity_owner;\nSELECT morrow_identity.morrow_memberships_closed();",
    expected: "f",
  },
  {
    c: "c3_other_owner_row_denied",
    sql: "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\nGRANT morrow_work_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\nSET LOCAL ROLE morrow_identity_owner;\nSELECT morrow_identity.morrow_memberships_closed();",
    expected: "f",
  },
  {
    c: "c4_set_row_on_executor_denied",
    sql: "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\nGRANT morrow_identity_linking TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\nSET LOCAL ROLE morrow_identity_owner;\nSELECT morrow_identity.memberships_closed('morrow_identity_linking') OR morrow_identity.morrow_memberships_closed();",
    expected: "f",
  },
  {
    c: "c5_runner_row_tolerated_for_work_owner",
    sql: "GRANT morrow_work_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\nSET LOCAL ROLE morrow_work_owner;\nSELECT morrow_identity.morrow_memberships_closed();",
    expected: "t",
  },
];

const containers = [];
const engines = [];

// Variant B: NOBYPASSRLS, everything.
const negativeMatrix = await localPostgresLab("P04.T01j.createrole-b", async (engine) => {
  containers.push(engine.id);
  engines.push({ variant: "B", version: engine.version, image: engine.image });
  const s = session(engine.id);
  createAdministrator(engine.id, { bypassrls: false });
  check(
    "b_prefix_0001_0004_applied_with_d4",
    JSON.stringify(applyChainAsAdministrator(engine.id, chain, { stopBefore: 5 })) ===
      JSON.stringify([1, 2, 3, 4]),
  );
  const entry5 = chain[4];
  const setRoleOnly = (entry) =>
    `BEGIN;\nSET LOCAL ROLE ${entry.executeAs};\n${migrationBody(entry)}COMMIT;\n`;
  const nothingFrom0005 = () =>
    s.q(
      "SELECT to_regclass('morrow_identity.migration_administrator') IS NULL AND to_regclass('morrow_identity.linking_candidates') IS NULL AND to_regprocedure('morrow_identity.memberships_closed(name)') IS NULL;",
    ) === "t" && s.setRows() === 0;
  // AC09: a second CREATEROLE administrator has no ADMIN on the roles the first created.
  s.q("CREATE ROLE lab_second_admin LOGIN NOINHERIT CREATEROLE;");
  let r = s.attempt(d4Transaction(entry5, "lab_second_admin"), "lab_second_admin");
  check(
    "b_second_administrator_fails_at_runner_grant",
    !r.ok &&
      r.sqlstate === "42501" &&
      r.code === "GRANT_REQUIRES_ADMIN_OPTION" &&
      nothingFrom0005(),
  );
  // ... and with a SET row given by the superuser (sim), the closed set refuses it.
  s.q("GRANT morrow_identity_owner TO lab_second_admin WITH INHERIT FALSE, SET TRUE;");
  r = s.attempt(setRoleOnly(entry5), "lab_second_admin");
  s.q("REVOKE morrow_identity_owner FROM lab_second_admin;\nDROP ROLE lab_second_admin;");
  check(
    "b_second_administrator_with_sim_set_row_fails_linking_check",
    !r.ok && r.code === "LINKING_ROLE_PREREQUISITES_INVALID" && nothingFrom0005(),
  );
  // AC05 and AC09: a morrow_* session user or a login without CREATEROLE is never recorded.
  for (const [name, attributes, label] of [
    ["morrow_lab_applier", "LOGIN NOINHERIT CREATEROLE", "b_morrow_session_user_fails_at_0005"],
    ["lab_plain_login", "LOGIN NOINHERIT", "b_non_createrole_session_user_fails_at_0005"],
  ]) {
    s.q(
      `CREATE ROLE ${name} ${attributes};\nGRANT morrow_identity_owner TO ${name} WITH INHERIT FALSE, SET TRUE;`,
    );
    r = s.attempt(setRoleOnly(entry5), name);
    s.q(`REVOKE morrow_identity_owner FROM ${name};\nDROP ROLE ${name};`);
    check(label, !r.ok && r.code === "MIGRATION_ADMINISTRATOR_INVALID" && nothingFrom0005());
  }
  // AC09: a Morrow role left over from createrole_self_grant='set, inherit' (N13).
  s.q(
    "SET createrole_self_grant='set, inherit';\nCREATE ROLE morrow_probe_selfgrant NOLOGIN NOINHERIT;",
    A,
  );
  r = s.attempt(d4Transaction(entry5), A);
  s.q("DROP ROLE morrow_probe_selfgrant;", A);
  check(
    "b_leftover_self_grant_role_fails_linking_check",
    !r.ok && r.code === "LINKING_ROLE_PREREQUISITES_INVALID" && nothingFrom0005(),
  );
  check(
    "b_0005_0014_applied_with_d4",
    JSON.stringify(applyChainAsAdministrator(engine.id, chain.slice(4, 14))) ===
      JSON.stringify([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
  );
  // AC09: N12 before 0015.
  s.q("GRANT morrow_work_api TO morrow_api_worker WITH ADMIN TRUE;", A);
  r = s.attempt(d4Transaction(chain[14]), A);
  s.q("REVOKE ADMIN OPTION FOR morrow_work_api FROM morrow_api_worker GRANTED BY neondb_owner;", A);
  check(
    "b_reviewed_pair_with_admin_fails_0015",
    !r.ok &&
      r.code === "WORK_ROLE_PREREQUISITES_INVALID" &&
      s.q("SELECT to_regnamespace('morrow_work') IS NULL;") === "t" &&
      s.setRows() === 0,
  );
  const rest = applyChainAsAdministrator(engine.id, chain.slice(14));
  check("b_chain_head_applied_with_d4", rest[0] === 15 && rest.at(-1) === chain.length);
  positives(s, "b");

  // AC05: the record refuses every write, even by its owner; nobody else may read it.
  for (const [label, statement] of [
    [
      "insert",
      "INSERT INTO morrow_identity.migration_administrator(singleton,role_oid,role_name) VALUES(true,10,'postgres');",
    ],
    ["update", "UPDATE morrow_identity.migration_administrator SET role_name='postgres';"],
    ["delete", "DELETE FROM morrow_identity.migration_administrator;"],
    ["truncate", "TRUNCATE morrow_identity.migration_administrator;"],
  ]) {
    r = s.attempt("SET ROLE morrow_identity_owner;\n" + statement);
    check(
      `b_record_${label}_by_owner_refused`,
      !r.ok && r.code === "MIGRATION_ADMINISTRATOR_IMMUTABLE",
    );
  }
  // The administrator writes every table through neon_superuser's pg_write_all_data (a
  // residual of ADR-0020); the statement trigger still refuses each write to the record.
  for (const [label, statement] of [
    [
      "insert",
      "INSERT INTO morrow_identity.migration_administrator(singleton,role_oid,role_name) VALUES(true,10,'postgres');",
    ],
    ["update", "UPDATE morrow_identity.migration_administrator SET role_name='postgres';"],
    ["delete", "DELETE FROM morrow_identity.migration_administrator;"],
  ]) {
    r = s.attempt(statement, A);
    check(
      `b_record_${label}_by_administrator_refused`,
      !r.ok && r.code === "MIGRATION_ADMINISTRATOR_IMMUTABLE",
    );
  }
  check(
    "b_executors_denied_every_helper",
    [...identityExecutors, "morrow_api_worker"].every(
      (e) => s.q(helperProbe, e) === "42501,42501,42501,42501,",
    ),
  );
  // AC10: the five helpers' owner and ACLs.
  const acl = s
    .q(
      "SELECT p.proname||'|'||p.proowner::regrole::text||'|'||(p.proacl IS NOT NULL)||'|'||(SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)||'|'||has_function_privilege('morrow_work_owner',p.oid,'EXECUTE')||'|'||" +
        "(SELECT count(*) FROM pg_catalog.pg_roles x WHERE x.rolname LIKE 'morrow\\_%' AND x.rolname NOT IN ('morrow_identity_owner','morrow_work_owner') AND has_function_privilege(x.oid,p.oid,'EXECUTE')) " +
        `FROM pg_catalog.pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname IN (${helpers.map((h) => `'${h}'`).join(",")}) ORDER BY 1;`,
    )
    .split("\n");
  check(
    "b_helpers_owned_by_owner_no_public_three_for_work_owner",
    JSON.stringify(acl) ===
      JSON.stringify(
        helpers.map((h) => `${h}|morrow_identity_owner|true|0|${workOwnerHelpers.includes(h)}|0`),
      ),
  );
  // AC11: coverage at the chain head.
  check(
    "b_only_the_helpers_read_pg_auth_members",
    s.q(
      "SELECT string_agg(p.proname,',' ORDER BY p.proname) FROM pg_catalog.pg_proc p WHERE p.pronamespace IN ('morrow_identity'::regnamespace,'morrow_work'::regnamespace) AND p.prosrc LIKE '%pg_auth_members%';",
    ) === "memberships_closed,recorded_administrator",
  );
  const calls = s
    .q(
      "SELECT p.proname||':'||((length(p.prosrc)-length(replace(p.prosrc,'executor_memberships_closed(','')))/length('executor_memberships_closed(')) FROM pg_catalog.pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname<>'executor_memberships_closed' AND p.prosrc LIKE '%executor_memberships_closed(%' ORDER BY 1;",
    )
    .split("\n");
  check(
    "b_guards_call_the_helper_as_expected",
    JSON.stringify(calls) ===
      JSON.stringify(Object.entries(helperCallsAtHead).map(([name, n]) => `${name}:${n}`)),
  );

  // AC07 and AC13: the negative matrix. Each shape is checked, then removed, and the
  // positive state must return.
  s.q("CREATE ROLE lab_other NOLOGIN NOINHERIT;", A);
  s.q("CREATE ROLE lab_outsider NOLOGIN NOINHERIT;");
  const matrix = [];
  for (const shape of negatives) {
    s.q(shape.setup[1], shape.setup[0]);
    const closedNow = s.closed();
    const guard = s.guards("morrow_identity_linking");
    const link = s.linkLocks();
    const preflight = s.preflight("morrow_identity_linking");
    const reviewedExact =
      s
        .census()
        .filter((row) => reviewed.some(([g, u]) => row[0] === g && row[1] === u))
        .map((row) => row.slice(4).join(""))
        .join(",") === "fft,fft";
    s.q(shape.undo[1], shape.undo[0]);
    const restored =
      s.closed() &&
      s.guardsPass("morrow_identity_linking") &&
      s.linkLocks().locks === 1 &&
      s.setRows() === 0;
    matrix.push({
      shape: shape.n,
      closed: closedNow,
      guard,
      locks: link.locks,
      preflight,
      reviewedExact,
      restored,
    });
    check(`b_${shape.n}_denied_at_apply_time`, closedNow === false);
    if (shape.runtime)
      check(
        `b_${shape.n}_denied_at_run_time`,
        guard.endsWith("|false") && guard.startsWith("false|") && link.locks === 0,
      );
    check(`b_${shape.n}_preflight_${shape.preflight}`, preflight === (shape.preflight ? "t" : "f"));
    if (shape.n.startsWith("n12_"))
      check(`b_${shape.n}_reviewed_rows_not_exact`, reviewedExact === false);
    check(`b_${shape.n}_restored`, restored);
  }
  s.q("DROP ROLE lab_other;", A);
  s.q("DROP ROLE lab_outsider;");

  // AC08: (C) holds only inside the administrator's own transaction, for the current
  // executeAs owner; it never commits.
  for (const c of inTransaction) {
    const out = s.q(`BEGIN;\n${c.sql}\nROLLBACK;`, A);
    check(`b_${c.c}`, out === c.expected && s.setRows() === 0);
  }
  check(
    "b_final_state_positive",
    s.closed() && s.setRows() === 0 && sameRows(s.census(), createroleCensus(A)),
  );
  return matrix;
});

// Variant A: BYPASSRLS, the chain and the positives.
await localPostgresLab("P04.T01j.createrole-a", async (engine) => {
  containers.push(engine.id);
  engines.push({ variant: "A", version: engine.version, image: engine.image });
  const s = session(engine.id);
  createAdministrator(engine.id, { bypassrls: true });
  const applied = applyChainAsAdministrator(engine.id, chain);
  check("a_chain_applied_with_d4", applied.length === chain.length && applied[0] === 1);
  positives(s, "a");
});

// Superuser mode, as every other lab applies the chain (AC03, AC13).
await localPostgresLab("P04.T01j.superuser", async (engine) => {
  containers.push(engine.id);
  engines.push({ variant: "S", version: engine.version, image: engine.image });
  const s = session(engine.id);
  psqlAs(engine.id, "CREATE DATABASE morrow;", { database: "morrow_lab" });
  const applied = applyChainAsSuperuser(engine.id, chain);
  check("s_chain_applied_as_superuser", applied.length === chain.length);
  check(
    "s_record_is_the_bootstrap_superuser",
    s.asOwner(
      "SELECT a.role_oid::bigint::text||'|'||a.role_name FROM morrow_identity.migration_administrator a;",
    ) === "10|postgres",
  );
  check(
    "s_census_is_the_2_reviewed_rows",
    sameRows(
      s.census(),
      reviewed.map(([role, member]) => [role, member, "t", "postgres", "f", "f", "t"]),
    ),
  );
  check("s_every_morrow_role_closed", s.closed() && s.setRows() === 0);
  s.q(identityExecutors.map((e) => `ALTER ROLE ${e} LOGIN;`).join("\n"));
  s.setupProbe();
  check(
    "s_nine_executors_pass_their_guards",
    identityExecutors.every((e) => s.guardsPass(e)),
  );
  check(
    "s_preflight_false_for_nine_executors",
    identityExecutors.every((e) => s.preflight(e) === "f"),
  );
  const link = s.linkLocks();
  check("s_link_workspace_store_passes_its_guard", link.outcome === "denied" && link.locks === 1);
});

check(
  "all_source_bytes_stable",
  sourcePaths.every((p) => sourceHashes[p] === hash(readFileSync(p))),
);
const absent = containers.every(
  (id) => containerCommand(["inspect", id], undefined, true).status !== 0,
);
check("owned_containers_absent", absent && containers.length === 3);
const report = {
  schema_version: 1,
  packet: "P04.T01j",
  adr: "ADR-0020",
  acceptance: [
    "P04.T01j-AC03",
    "P04.T01j-AC04",
    "P04.T01j-AC05",
    "P04.T01j-AC06",
    "P04.T01j-AC07",
    "P04.T01j-AC08",
    "P04.T01j-AC09",
    "P04.T01j-AC10",
    "P04.T01j-AC11",
    "P04.T01j-AC13",
  ],
  migrations: chain.map((m) => ({ sequence: m.sequence, file: m.file, executeAs: m.executeAs })),
  source_hashes: sourceHashes,
  checks,
  checks_passed: checks.length,
  engines,
  negative_matrix: negativeMatrix,
  containers_absent: absent,
  provider_requests: 0,
  limitations: [
    "A local emulation of Neon's administrator model (neon_superuser, neondb_owner); the bootstrap superuser is postgres here and cloud_admin on Neon. The hosted confirmation is P04.T01i M-N1+ (P04.T01j AC15).",
    "Shapes marked sim were produced by the local superuser; they are impossible for the hosted administrator.",
    "The runner ledger (morrow_migrations.applied) and its unknown-outcome handling belong to P04.T01i PR-B; this lab applies D4 without a ledger row.",
  ],
};
writeArtifact("labs/createrole-administrator.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    packet: report.packet,
    checks: checks.length,
    passed: true,
    provider_requests: 0,
    containers_absent: absent,
  }),
);
