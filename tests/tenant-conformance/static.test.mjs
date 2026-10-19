// Static tenant-isolation checks S1-S6 (P06.T01a §4.12) against the real catalog
// of a PostgreSQL 17 database migrated through the whole manifest. Any miss fails.
// Run by `npm run lab:tenant-conformance` (pg-work group), not by `npm test`.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { withWorkDatabase } from "./harness.mjs";
import {
  bridgeFunctions,
  registeredRoutes,
  workDomains,
  workFunctions,
  workRouteProbes,
  workRoles,
  workTables,
} from "./registry.mjs";
import { conformanceReport, recordConformance } from "./report.mjs";
import { morrowSetRowsSql } from "../../scripts/fixtures/createrole-administrator.mjs";

conformanceReport("static");

let db, release, started;
before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  // The hosted administrator shape (ADR-0020, P04.T01j D7): a non-superuser CREATEROLE
  // login applies the chain with the D4 runner protocol.
  started = withWorkDatabase(
    "P06.T01a.conformance-static",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole" },
  );
  await Promise.race([opened, started]);
  assert.ok(db, "database started");
});
after(async () => {
  release?.();
  await started;
});
const rows = (query) => db.rows(query);
const names = (list) => [...list].sort();
const tenantTables = Object.entries(workTables)
  .filter(([, t]) => t.class !== "platform")
  .map(([name]) => name);
const readable = Object.entries(workTables)
  .filter(([, t]) => t.class === "tenant_readable")
  .map(([name]) => name);
const tenantPredicate =
  "(((organization_id)::text, (workspace_id)::text) = ( SELECT c.organization_id,\n    c.workspace_id\n   FROM morrow_work.current_tenant() c(organization_id, workspace_id, principal_id, membership_id, policy_revision)))";

test("S1: every morrow_work object is registered and nothing else exists", () => {
  const tables = rows(
    "SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace='morrow_work'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')",
  );
  assert.deepEqual(names(tables.map((t) => t.relname)), names(Object.keys(workTables)));
  assert.ok(tables.every((t) => t.relkind === "r"));
  const functions = rows(
    "SELECT regexp_replace(p.oid::regprocedure::text,'^morrow_work\\.','') AS signature FROM pg_proc p WHERE p.pronamespace='morrow_work'::regnamespace",
  );
  assert.deepEqual(names(functions.map((f) => f.signature)), names(Object.keys(workFunctions)));
  const types = rows(
    "SELECT t.typname, t.typtype FROM pg_type t WHERE t.typnamespace='morrow_work'::regnamespace AND t.typtype='d'",
  );
  assert.deepEqual(names(types.map((t) => t.typname)), names(workDomains));
  const bridge = rows(
    "SELECT regexp_replace(p.oid::regprocedure::text,'^morrow_identity\\.','') AS signature FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname LIKE 'work\\_%'",
  );
  assert.deepEqual(names(bridge.map((f) => f.signature)), names(bridgeFunctions));
  recordConformance("S1", true);
});

test("S2: every table has ENABLE and FORCE row-level security", () => {
  const tables = rows(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace='morrow_work'::regnamespace AND relkind='r'",
  );
  assert.equal(tables.length, Object.keys(workTables).length);
  for (const t of tables) assert.ok(t.relrowsecurity && t.relforcerowsecurity, t.relname);
  recordConformance("S2", true);
});

test("S3: tenant keys, composite parents and the one tenant policy template", () => {
  for (const table of tenantTables) {
    const columns = rows(
      `SELECT attname, attnotnull FROM pg_attribute WHERE attrelid='morrow_work.${table}'::regclass AND attname IN ('organization_id','workspace_id') AND NOT attisdropped`,
    );
    assert.equal(columns.length, 2, table);
    assert.ok(
      columns.every((c) => c.attnotnull),
      table,
    );
    const pk = rows(
      `SELECT (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns FROM pg_constraint c WHERE c.conrelid='morrow_work.${table}'::regclass AND c.contype='p'`,
    );
    assert.deepEqual(pk[0].columns.slice(0, 2), ["organization_id", "workspace_id"], table);
    const fks = rows(
      `SELECT c.confrelid::regclass::text AS parent,(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns FROM pg_constraint c WHERE c.conrelid='morrow_work.${table}'::regclass AND c.contype='f'`,
    );
    for (const parent of workTables[table].parents) {
      const qualified = parent.includes(".") ? parent : "morrow_work." + parent;
      assert.ok(
        fks.some(
          (fk) =>
            fk.parent === qualified &&
            fk.columns[0] === "organization_id" &&
            fk.columns[1] === "workspace_id",
        ),
        table + " -> " + parent,
      );
    }
    const policies = rows(
      `SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='morrow_work' AND tablename='${table}' ORDER BY policyname`,
    );
    const expected = ["tenant_command", "work_owner"].concat(
      readable.includes(table) ? ["tenant_read"] : [],
    );
    assert.deepEqual(names(policies.map((p) => p.policyname)), names(expected), table);
    for (const policy of policies) {
      if (policy.policyname === "work_owner") {
        assert.equal(policy.roles, "{morrow_work_owner}");
        assert.equal(policy.qual, "true");
      } else if (policy.policyname === "tenant_command") {
        assert.equal(policy.roles, "{morrow_work_command}");
        assert.equal(policy.cmd, "ALL");
        assert.equal(policy.qual, tenantPredicate, table);
        assert.equal(policy.with_check, tenantPredicate, table);
      } else {
        assert.equal(policy.roles, "{morrow_work_api}");
        assert.equal(policy.cmd, "SELECT");
        assert.equal(policy.qual, tenantPredicate, table);
      }
    }
  }
  const platform = rows(
    "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='morrow_work.transition_rules'::regclass AND attname IN ('organization_id','workspace_id')",
  );
  assert.equal(platform[0].n, 0);
  recordConformance("S3", true);
});

test("S4: the api role reads readable tables column by column; no runtime DELETE or TRUNCATE", () => {
  const tableAcl = rows(
    "SELECT c.relname, a.grantee::regrole::text AS grantee, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace='morrow_work'::regnamespace AND a.grantee<>0",
  );
  assert.ok(!tableAcl.some((a) => a.grantee === workRoles.api || a.grantee === workRoles.login));
  for (const a of tableAcl.filter((x) => x.grantee === workRoles.command))
    assert.ok(["SELECT", "INSERT"].includes(a.privilege_type), a.relname + " " + a.privilege_type);
  const columnAcl = rows(
    "SELECT c.relname, a.grantee::regrole::text AS grantee, a.privilege_type FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid, aclexplode(t.attacl) a WHERE c.relnamespace='morrow_work'::regnamespace AND t.attacl IS NOT NULL",
  );
  for (const a of columnAcl.filter((x) => x.grantee === workRoles.api)) {
    assert.equal(a.privilege_type, "SELECT");
    assert.ok(readable.includes(a.relname), a.relname);
  }
  for (const a of columnAcl.filter((x) => x.grantee === workRoles.command))
    assert.equal(a.privilege_type, "UPDATE", a.relname);
  for (const table of readable)
    assert.ok(
      columnAcl.some((a) => a.grantee === workRoles.api && a.relname === table),
      table,
    );
  for (const role of Object.values(workRoles))
    for (const table of Object.keys(workTables)) {
      const [p] = rows(
        `SELECT has_table_privilege('${role}','morrow_work.${table}','DELETE') AS d, has_table_privilege('${role}','morrow_work.${table}','TRUNCATE') AS t`,
      );
      if (role !== workRoles.owner) assert.ok(!p.d && !p.t, role + " " + table);
    }
  const platformApi = rows(
    "SELECT has_any_column_privilege('morrow_work_api','morrow_work.transition_rules','SELECT') AS s",
  );
  assert.equal(platformApi[0].s, false);
  const views = rows(
    "SELECT relname, reloptions FROM pg_class WHERE relnamespace='morrow_work'::regnamespace AND relkind='v'",
  );
  for (const view of views) assert.ok((view.reloptions ?? []).includes("security_invoker=true"));
  recordConformance("S4", true);
});

test("S5: definers, owners, search paths, grants, parameters, roles and memberships", () => {
  const functions = rows(
    "SELECT regexp_replace(p.oid::regprocedure::text,'^morrow_work\\.','') AS signature, p.prosecdef, p.proowner::regrole::text AS owner, p.proconfig, p.proacl::text AS acl, pg_get_function_identity_arguments(p.oid) AS arguments, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public FROM pg_proc p WHERE p.pronamespace='morrow_work'::regnamespace",
  );
  for (const f of functions) {
    const spec = workFunctions[f.signature];
    assert.ok(spec, f.signature);
    assert.ok(f.acl !== null && f.public === 0, "no PUBLIC EXECUTE " + f.signature);
    assert.deepEqual(f.grantees, spec.grantees, f.signature);
    assert.ok(
      (f.proconfig ?? []).some((c) => c.startsWith("search_path=pg_catalog")),
      "search_path " + f.signature,
    );
    const definer = spec.kind === "api" || spec.kind === "resolver";
    assert.equal(f.prosecdef, definer, f.signature);
    if (definer || spec.kind === "helper") assert.equal(f.owner, workRoles.command, f.signature);
    else assert.equal(f.owner, workRoles.owner, f.signature);
    if (spec.kind === "api")
      for (const name of f.arguments
        .split(", ")
        .filter(Boolean)
        .map((a) => a.split(" ")[0]))
        assert.ok(
          (spec.tenantParameters ?? []).includes(name) ||
            // Targets (assignee, respondent) are not the actor; the actor comes only
            // from current_tenant().
            !(
              /organization|workspace|actor|membership/.test(name) ||
              /^p_principal(_id)?$/.test(name)
            ),
          f.signature + " " + name,
        );
  }
  const roles = [
    "morrow_work_owner",
    "morrow_work_command",
    "morrow_work_api",
    "morrow_api_worker",
    "morrow_api",
    "morrow_identity_owner",
    "morrow_identity_lifecycle",
    "morrow_identity_linking",
    "morrow_identity_preauth",
    "morrow_identity_resolution",
    "morrow_identity_sessions",
    "morrow_identity_login",
    "morrow_identity_login_maintenance",
    "morrow_identity_logout",
    "morrow_identity_onboarding",
  ];
  for (const signature of bridgeFunctions)
    for (const role of roles) {
      const [p] = rows(
        `SELECT has_function_privilege('${role}','morrow_identity.${signature}','EXECUTE') AS x, p.prosecdef, p.proowner::regrole::text AS owner FROM pg_proc p WHERE p.oid='morrow_identity.${signature}'::regprocedure`,
      );
      assert.equal(
        p.x,
        role === workRoles.command || role === "morrow_identity_owner",
        role + " " + signature,
      );
      assert.ok(p.prosecdef && p.owner === "morrow_identity_owner");
    }
  // 0014 replaces the three organization-interlocked identity functions with
  // CREATE OR REPLACE, which keeps each ACL. Over the whole chain each keeps exactly
  // its pre-0014 EXECUTE grantees, so 0013's revocation of admit_browser_family from
  // morrow_identity_sessions survives; a later DROP and CREATE plus GRANT would fail here.
  const admitBrowserFamily = `admit_browser_family(${Array(27).fill("text").join(",")})`;
  for (const [signature, grantees] of [
    [
      "revoke_workspace_access(text,text,text,text,text,text,text,text)",
      ["morrow_identity_lifecycle"],
    ],
    [
      "link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)",
      ["morrow_identity_linking"],
    ],
    [admitBrowserFamily, []],
  ]) {
    const [f] = rows(
      `SELECT p.proowner::regrole::text AS owner, p.proacl IS NOT NULL AS acl, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public FROM pg_proc p WHERE p.oid='morrow_identity.${signature}'::regprocedure`,
    );
    assert.equal(f.owner, "morrow_identity_owner", signature);
    assert.ok(f.acl && f.public === 0, "no PUBLIC EXECUTE " + signature);
    assert.deepEqual(f.grantees, grantees, signature);
  }
  const [sessions] = rows(
    `SELECT has_function_privilege('morrow_identity_sessions','morrow_identity.${admitBrowserFamily}','EXECUTE') AS x`,
  );
  assert.equal(
    sessions.x,
    false,
    "0013 revoked admit_browser_family from morrow_identity_sessions",
  );
  // ADR-0020: the work owner executes exactly the three read-only membership helpers
  // that 0015 checks (granted by 0014); no other work role executes any of the five.
  const workOwnerHelpers = [
    "morrow_identity.memberships_closed(name)",
    "morrow_identity.morrow_memberships_closed()",
    "morrow_identity.recorded_administrator()",
  ];
  const identityFunctions = rows(
    "SELECT p.oid::regprocedure::text AS signature, has_function_privilege('morrow_work_command',p.oid,'EXECUTE') AS c, has_function_privilege('morrow_work_api',p.oid,'EXECUTE') AS a, has_function_privilege('morrow_work_owner',p.oid,'EXECUTE') AS o, has_function_privilege('morrow_api_worker',p.oid,'EXECUTE') AS l FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace",
  );
  for (const f of identityFunctions) {
    const bridge = bridgeFunctions.includes(f.signature.replace("morrow_identity.", ""));
    assert.equal(f.c, bridge, f.signature);
    assert.equal(f.o, workOwnerHelpers.includes(f.signature), f.signature);
    assert.ok(!f.a && !f.l, f.signature);
  }
  assert.equal(identityFunctions.filter((f) => f.o).length, workOwnerHelpers.length);
  // The five ADR-0020 helpers: owned by the identity owner, no PUBLIC EXECUTE, and no
  // executor may run any of them.
  const helperAcl = rows(
    "SELECT p.oid::regprocedure::text AS signature, p.proowner::regrole::text AS owner, p.proacl IS NOT NULL AS acl, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname IN ('preserve_migration_administrator','recorded_administrator','memberships_closed','morrow_memberships_closed','executor_memberships_closed')",
  );
  assert.equal(helperAcl.length, 5);
  for (const h of helperAcl) {
    assert.equal(h.owner, "morrow_identity_owner", h.signature);
    assert.ok(h.acl && h.public === 0, "no PUBLIC EXECUTE " + h.signature);
    assert.deepEqual(
      h.grantees,
      workOwnerHelpers.includes(h.signature) ? ["morrow_work_owner"] : [],
      h.signature,
    );
  }
  // Across every Morrow role: the owner executes all five and the work owner exactly its
  // three; no executor, login or other role executes any of them.
  const helperExecutors = rows(
    "SELECT r.rolname AS role, p.oid::regprocedure::text AS signature FROM pg_roles r, pg_proc p WHERE r.rolname LIKE 'morrow\\_%' AND p.pronamespace='morrow_identity'::regnamespace AND p.proname IN ('preserve_migration_administrator','recorded_administrator','memberships_closed','morrow_memberships_closed','executor_memberships_closed') AND has_function_privilege(r.oid,p.oid,'EXECUTE')",
  );
  assert.deepEqual(
    helperExecutors.map((x) => x.role + " " + x.signature).sort(),
    [
      ...helperAcl.map((h) => "morrow_identity_owner " + h.signature),
      ...workOwnerHelpers.map((signature) => workRoles.owner + " " + signature),
    ].sort(),
  );
  const attributes = rows(
    "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls, rolreplication, rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker')",
  );
  assert.equal(attributes.length, 4);
  for (const r of attributes) {
    assert.equal(r.rolcanlogin, r.rolname === workRoles.login, r.rolname);
    for (const flag of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolinherit",
      "rolbypassrls",
      "rolreplication",
    ])
      assert.equal(r[flag], false, r.rolname + " " + flag);
    assert.equal(r.has_password, false, "no PASSWORD clause " + r.rolname);
  }
  const forbidden = rows(
    "SELECT rolname FROM pg_roles WHERE rolname ~ '^morrow_(work_(relay|maintenance|operations)|orchestrator_worker)$'",
  );
  assert.deepEqual(forbidden, []);
  // ADR-0020 (P04.T01j D7): the recorded administrator is the login that applied the
  // chain, and the rows naming a work role are exact. The two reviewed rows are granted by
  // the recorded administrator. In createrole mode each work role also has its one
  // PG16+ creation row (member the administrator, grantor the bootstrap superuser oid 10,
  // admin true, inherit false, set false); a local superuser setup has none.
  const createrole = db.administrator === "createrole";
  const [record] = rows(
    "SELECT a.role_oid::bigint AS oid, a.role_name AS name, (SELECT count(*) FROM morrow_identity.migration_administrator)::int AS n FROM morrow_identity.migration_administrator a",
    { role: "morrow_identity_owner" },
  );
  assert.equal(record.n, 1);
  assert.equal(record.name, createrole ? "neondb_owner" : "postgres");
  assert.equal(createrole, record.oid !== 10);
  const members = rows(
    "SELECT g.rolname AS role, u.rolname AS member, m.grantor::bigint AS grantor, m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE g.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker') OR u.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker')",
  );
  const shape = (m) =>
    [m.role, m.member, m.grantor, m.admin_option, m.inherit_option, m.set_option].join(" ");
  assert.deepEqual(
    members.map(shape).sort(),
    [
      ["morrow_work_api", "morrow_api_worker", record.oid, false, false, true],
      ["morrow_work_command", "morrow_work_owner", record.oid, false, false, true],
      ...(createrole
        ? ["morrow_work_owner", "morrow_work_command", "morrow_work_api", "morrow_api_worker"].map(
            (role) => [role, record.name, 10, true, false, false],
          )
        : []),
    ]
      .map((row) => row.join(" "))
      .sort(),
  );
  // Every Morrow role is closed, evaluated as the owner from a superuser session (so the
  // in-transaction runner rule (C) cannot apply), and no SET row names a Morrow role
  // except the two reviewed rows.
  const [closed] = rows("SELECT morrow_identity.morrow_memberships_closed() AS closed", {
    role: "morrow_identity_owner",
  });
  assert.equal(closed.closed, true);
  const [setRows] = rows(morrowSetRowsSql.replace("SELECT count(*)", "SELECT count(*)::int AS n"));
  assert.equal(setRows.n, 0);
  recordConformance("S5", true);
});

test("S6: workRoutes and the registry match one-to-one", () => {
  assert.deepEqual(names(registeredRoutes), names(Object.keys(workRouteProbes)));
  assert.equal(new Set(registeredRoutes).size, registeredRoutes.length);
  recordConformance("S6", true);
});
