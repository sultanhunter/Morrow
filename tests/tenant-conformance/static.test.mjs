// Static tenant-isolation checks S1-S6 (P06.T01a §4.12) against the real catalog
// of a PostgreSQL 17 database migrated through the whole manifest. Any miss fails.
// Run by `npm run lab:tenant-conformance` (pg-work group), not by `npm test`.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { withWorkDatabase } from "./harness.mjs";
import {
  billingFunctions,
  billingTables,
  bridgeFunctions,
  executorLogins,
  registeredRoutes,
  vaultFunctions,
  vaultTables,
  workDomains,
  workFunctions,
  workRouteProbes,
  workRoles,
  workTables,
} from "./registry.mjs";
import { contentProblems, registeredTables } from "./content.mjs";
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
// The options carry `role` (SET ROLE before the query) through to the harness.
const rows = (query, options) => db.rows(query, options);
const names = (list) => [...list].sort();
const tenantTables = Object.entries(workTables)
  .filter(([, t]) => t.class !== "platform")
  .map(([name]) => name);
// The api role reads tenant-readable tables and the tenant rows plus platform rows of
// tenant_or_platform tables.
const readable = Object.entries(workTables)
  .filter(([, t]) => t.class === "tenant_readable" || t.class === "tenant_or_platform")
  .map(([name]) => name);
const tenantPredicate =
  "(((organization_id)::text, (workspace_id)::text) = ( SELECT c.organization_id,\n    c.workspace_id\n   FROM morrow_work.current_tenant() c(organization_id, workspace_id, principal_id, membership_id, policy_revision)))";
// The lease-context twin (M2 PR-1): the same row comparison against current_lease().
const leasePredicate =
  "(((organization_id)::text, (workspace_id)::text) = ( SELECT c.organization_id,\n    c.workspace_id\n   FROM morrow_work.current_lease() c(organization_id, workspace_id, lease_id, generation, kind, subject_id, store_id, connection_id, installation_id, initiator_principal_id, initiator_membership_id, expires_at)))";
const orPlatform = (predicate) => "((organization_id IS NULL) OR " + predicate + ")";
// The exactly-checked extra policies (registry `policies`): [command, roles, qual, check].
const extraPolicies = {
  lease_self: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND ((id)::text = current_setting('morrow.work_lease_id'::text, true)))",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND ((id)::text = current_setting('morrow.work_lease_id'::text, true)))",
  ],
  lease_pending: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND (status = 'active'::text) AND (started_at IS NULL) AND (kind = ANY (ARRAY['run'::text, 'operation'::text])))",
    null,
  ],
  route_signup: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((origin = 'website'::text) AND (route IS NULL) AND (mode IS NULL) AND (route_fixed_at IS NULL) AND (fixing_payment_key IS NULL) AND ((revision)::bigint = 1))",
  ],
  vault_broker: [
    "ALL",
    "{morrow_work_command}",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
  ],
};
// One table's policies against the template of its class and its registry extras.
function checkPolicies(schema, table, spec) {
  const policies = rows(
    `SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' ORDER BY policyname`,
  );
  const mixed = spec.class === "tenant_or_platform";
  const vault = spec.class === "vault_platform" || spec.class === "vault_tenant";
  const expected = ["work_owner"]
    .concat(vault ? ["vault_broker"] : ["tenant_command"])
    .concat(spec.class === "tenant_readable" || mixed ? ["tenant_read"] : [])
    .concat(spec.lease || mixed ? ["tenant_lease"] : [])
    .concat(spec.policies ?? []);
  assert.deepEqual(names(policies.map((p) => p.policyname)), names(expected), table);
  for (const policy of policies) {
    const shape = [policy.cmd, policy.roles, policy.qual, policy.with_check];
    if (policy.policyname === "work_owner")
      assert.deepEqual(shape, ["ALL", "{morrow_work_owner}", "true", "true"], table);
    else if (policy.policyname === "tenant_command")
      assert.deepEqual(
        shape,
        [
          "ALL",
          "{morrow_work_command}",
          mixed ? orPlatform(tenantPredicate) : tenantPredicate,
          tenantPredicate,
        ],
        table,
      );
    else if (policy.policyname === "tenant_lease")
      assert.deepEqual(
        shape,
        mixed
          ? ["SELECT", "{morrow_work_command}", orPlatform(leasePredicate), null]
          : ["ALL", "{morrow_work_command}", leasePredicate, leasePredicate],
        table,
      );
    else if (policy.policyname === "tenant_read")
      assert.deepEqual(
        shape,
        [
          "SELECT",
          "{morrow_work_api}",
          mixed ? orPlatform(tenantPredicate) : tenantPredicate,
          null,
        ],
        table,
      );
    else assert.deepEqual(shape, extraPolicies[policy.policyname], table + " " + policy.policyname);
  }
}

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
    const mixed = workTables[table].class === "tenant_or_platform";
    const columns = rows(
      `SELECT attname, attnotnull FROM pg_attribute WHERE attrelid='morrow_work.${table}'::regclass AND attname IN ('organization_id','workspace_id') AND NOT attisdropped`,
    );
    assert.equal(columns.length, 2, table);
    // Platform rows of a tenant_or_platform table have both keys null (its CHECK).
    assert.ok(
      columns.every((c) => c.attnotnull === !mixed),
      table,
    );
    const keys = rows(
      `SELECT c.contype AS kind,(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns FROM pg_constraint c WHERE c.conrelid='morrow_work.${table}'::regclass AND c.contype IN ('p','u')`,
    );
    // The primary key leads with the tenant keys. A tenant_or_platform table has a global
    // id primary key instead, and a unique (organization_id, workspace_id, id) key that its
    // children's composite foreign keys reference.
    const pk = keys.find((k) => k.kind === "p").columns;
    if (mixed) {
      assert.deepEqual(pk, ["id"], table);
      assert.ok(
        keys.some((k) => k.columns.join() === "organization_id,workspace_id,id"),
        table,
      );
    } else assert.deepEqual(pk.slice(0, 2), ["organization_id", "workspace_id"], table);
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
    checkPolicies("morrow_work", table, workTables[table]);
  }
  for (const [table, spec] of Object.entries(workTables).filter(
    ([, t]) => t.class === "platform",
  )) {
    const platform = rows(
      `SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='morrow_work.${table}'::regclass AND attname IN ('organization_id','workspace_id')`,
    );
    assert.equal(platform[0].n, 0, table);
    assert.deepEqual(spec.parents, [], table);
  }
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
  for (const [table] of Object.entries(workTables).filter(([, t]) => t.class === "platform")) {
    const platformApi = rows(
      `SELECT has_any_column_privilege('morrow_work_api','morrow_work.${table}','SELECT') AS s`,
    );
    assert.equal(platformApi[0].s, false, table);
  }
  const views = rows(
    "SELECT relname, reloptions FROM pg_class WHERE relnamespace='morrow_work'::regnamespace AND relkind='v'",
  );
  for (const view of views) assert.ok((view.reloptions ?? []).includes("security_invoker=true"));
  recordConformance("S4", true);
});

// Definer kinds: the api functions, the resolvers, and (M2 PR-1) the runtime, vault and
// signup-bridge definers. Every definer is owned by the command role; operator functions
// are INVOKER and owned by the owner, like triggers and checks.
const definerKinds = ["api", "resolver", "runtime", "vault", "bridge_in"];

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
    const definer = definerKinds.includes(spec.kind);
    assert.equal(f.prosecdef, definer, f.signature);
    if (definer || spec.kind === "helper") assert.equal(f.owner, workRoles.command, f.signature);
    else assert.equal(f.owner, workRoles.owner, f.signature);
    if (spec.kind === "api" || spec.kind === "runtime")
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
  // The one cross-tenant definer returns exactly its registered id columns (spine §5).
  for (const [signature, spec] of Object.entries(workFunctions).filter(([, f]) => f.crossTenant)) {
    const [result] = rows(
      `SELECT array_to_string(p.proargnames[p.pronargs+1:],',') AS columns, p.proretset FROM pg_proc p WHERE p.oid='morrow_work.${signature}'::regprocedure`,
    );
    assert.equal(result.columns, spec.columns.join(","), signature);
    assert.equal(result.proretset, true, signature);
  }
  const roles = [
    ...Object.keys(executorLogins),
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
  // No executor login executes any identity function (ADR-0022 item 8).
  const loginIdentity = rows(
    `SELECT r.rolname, p.oid::regprocedure::text AS signature FROM pg_roles r, pg_proc p WHERE r.rolname IN (${Object.keys(
      executorLogins,
    )
      .map((l) => `'${l}'`)
      .join(
        ",",
      )}) AND p.pronamespace='morrow_identity'::regnamespace AND has_function_privilege(r.oid,p.oid,'EXECUTE')`,
  );
  assert.deepEqual(loginIdentity, []);
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
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls, rolreplication, rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker',${Object.keys(
      executorLogins,
    )
      .map((l) => `'${l}'`)
      .join(",")})`,
  );
  assert.equal(attributes.length, 4 + Object.keys(executorLogins).length);
  for (const r of attributes) {
    assert.equal(
      r.rolcanlogin,
      r.rolname === workRoles.login || Object.hasOwn(executorLogins, r.rolname),
      r.rolname,
    );
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
  // chain, and the rows naming a work role are exact. The suite runs in the hosted shape
  // only: a non-superuser CREATEROLE administrator. The two reviewed rows are granted by
  // the recorded administrator, and each work role also has its one PG16+ creation row
  // (member the administrator, grantor the bootstrap superuser oid 10, admin true, inherit
  // false, set false). The local superuser shape, which has no creation rows, is checked
  // by container S of lab:createrole-administrator.
  assert.equal(db.administrator, "createrole");
  // The owner reads the record through its identity_owner SELECT policy (FORCE RLS).
  const [record] = rows(
    "SELECT current_user AS reader, a.role_oid::bigint AS oid, a.role_name AS name, (SELECT count(*) FROM morrow_identity.migration_administrator)::int AS n FROM morrow_identity.migration_administrator a",
    { role: "morrow_identity_owner" },
  );
  assert.equal(record.reader, "morrow_identity_owner");
  assert.equal(record.n, 1);
  assert.equal(record.name, "neondb_owner");
  assert.notEqual(record.oid, 10);
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
      ...["morrow_work_owner", "morrow_work_command", "morrow_work_api", "morrow_api_worker"].map(
        (role) => [role, record.name, 10, true, false, false],
      ),
    ]
      .map((row) => row.join(" "))
      .sort(),
  );
  // The executor logins are membership-free (ADR-0022 item 8): each has exactly its PG16+
  // creation row and no other row names it, in either direction.
  const loginMembers = rows(
    `SELECT g.rolname AS role, u.rolname AS member, m.grantor::bigint AS grantor, m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE g.rolname IN (${Object.keys(
      executorLogins,
    )
      .map((l) => `'${l}'`)
      .join(",")}) OR u.rolname IN (${Object.keys(executorLogins)
      .map((l) => `'${l}'`)
      .join(",")})`,
  );
  assert.deepEqual(
    loginMembers.map(shape).sort(),
    Object.keys(executorLogins)
      .map((login) => [login, record.name, 10, true, false, false].join(" "))
      .sort(),
  );
  // Every Morrow role is closed, evaluated as the owner from a superuser session (so the
  // in-transaction runner rule (C) cannot apply), and no SET row names a Morrow role
  // except the two reviewed rows.
  const [closed] = rows(
    "SELECT current_user AS caller, morrow_identity.morrow_memberships_closed() AS closed",
    { role: "morrow_identity_owner" },
  );
  assert.equal(closed.caller, "morrow_identity_owner");
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

// M2 PR-1 (0020): morrow_billing and morrow_vault follow S1-S5 in their own registries,
// and each executor login executes exactly its registered functions.
test("S7: the billing and vault schemas, and what each executor login may execute", () => {
  for (const [schema, tables, functions] of [
    ["morrow_billing", billingTables, billingFunctions],
    ["morrow_vault", vaultTables, vaultFunctions],
  ]) {
    // S1: every object registered and nothing else; no domain, view or sequence.
    const relations = rows(
      `SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace='${schema}'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')`,
    );
    assert.deepEqual(names(relations.map((t) => t.relname)), names(Object.keys(tables)), schema);
    assert.ok(relations.every((t) => t.relkind === "r"));
    const types = rows(
      `SELECT t.typname FROM pg_type t WHERE t.typnamespace='${schema}'::regnamespace AND t.typtype='d'`,
    );
    assert.deepEqual(types, [], schema);
    const schemaAcl = rows(
      `SELECT n.nspowner::regrole::text AS owner, (SELECT COALESCE(array_agg(a.grantee::regrole::text||':'||a.privilege_type ORDER BY 1),'{}') FROM aclexplode(n.nspacl) a WHERE a.grantee<>n.nspowner) AS grants FROM pg_namespace n WHERE n.nspname='${schema}'`,
    );
    assert.equal(schemaAcl[0].owner, workRoles.owner, schema);
    assert.deepEqual(
      [...schemaAcl[0].grants].sort(),
      schema === "morrow_billing"
        ? ["morrow_identity_owner:USAGE", "morrow_work_api:USAGE", "morrow_work_command:USAGE"]
        : ["morrow_vault_broker:USAGE", "morrow_work_command:USAGE"],
      schema,
    );
    for (const [table, spec] of Object.entries(tables)) {
      // S2 and S3.
      const [t] = rows(
        `SELECT relrowsecurity, relforcerowsecurity, relowner::regrole::text AS owner FROM pg_class WHERE oid='${schema}.${table}'::regclass`,
      );
      assert.ok(t.relrowsecurity && t.relforcerowsecurity && t.owner === workRoles.owner, table);
      checkPolicies(schema, table, spec);
      if (spec.class !== "vault_platform") {
        const fks = rows(
          `SELECT c.confrelid::regclass::text AS parent,(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns FROM pg_constraint c WHERE c.conrelid='${schema}.${table}'::regclass AND c.contype='f'`,
        );
        for (const parent of spec.parents)
          assert.ok(
            fks.some(
              (fk) =>
                fk.parent === parent &&
                fk.columns[0] === "organization_id" &&
                fk.columns[1] === "workspace_id",
            ),
            table + " -> " + parent,
          );
      }
      // S4: the command role holds SELECT (and, for the route, INSERT); the api role reads
      // only the route, column by column; nobody else holds anything; no DELETE or TRUNCATE.
      const acl = rows(
        `SELECT a.grantee::regrole::text AS grantee, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid='${schema}.${table}'::regclass AND a.grantee<>c.relowner`,
      );
      assert.deepEqual(
        acl.map((a) => a.grantee + ":" + a.privilege_type).sort(),
        schema === "morrow_billing"
          ? ["morrow_work_command:INSERT", "morrow_work_command:SELECT"]
          : ["morrow_work_command:SELECT"],
        table,
      );
      const columns = rows(
        `SELECT DISTINCT a.grantee::regrole::text AS grantee, a.privilege_type FROM pg_attribute t, aclexplode(t.attacl) a WHERE t.attrelid='${schema}.${table}'::regclass AND t.attacl IS NOT NULL`,
      );
      assert.deepEqual(
        columns.map((a) => a.grantee + ":" + a.privilege_type),
        schema === "morrow_billing" ? ["morrow_work_api:SELECT"] : [],
        table,
      );
    }
    // S5: functions.
    const fns = rows(
      `SELECT regexp_replace(p.oid::regprocedure::text,'^${schema}\\.','') AS signature, p.prosecdef, p.proowner::regrole::text AS owner, p.proconfig, p.proacl IS NOT NULL AS acl, pg_get_function_identity_arguments(p.oid) AS arguments, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public FROM pg_proc p WHERE p.pronamespace='${schema}'::regnamespace`,
    );
    assert.deepEqual(names(fns.map((f) => f.signature)), names(Object.keys(functions)), schema);
    for (const f of fns) {
      const spec = functions[f.signature];
      assert.ok(f.acl && f.public === 0, "no PUBLIC EXECUTE " + f.signature);
      assert.deepEqual([...f.grantees].sort(), spec.grantees, f.signature);
      assert.ok(
        (f.proconfig ?? []).some((c) => c.startsWith("search_path=pg_catalog")),
        "search_path " + f.signature,
      );
      const definer = definerKinds.includes(spec.kind);
      assert.equal(f.prosecdef, definer, f.signature);
      assert.equal(f.owner, definer ? workRoles.command : workRoles.owner, f.signature);
      if (definer)
        for (const name of f.arguments
          .split(", ")
          .filter(Boolean)
          .map((a) => a.split(" ")[0]))
          assert.ok(
            (spec.tenantParameters ?? []).includes(name) ||
              !/organization|workspace|actor|membership|principal/.test(name),
            f.signature + " " + name,
          );
    }
  }
  // Every function an executor login may execute, in any schema, is exactly its list; it
  // holds no table, column, sequence or schema privilege beyond USAGE on those schemas.
  for (const [login, allowed] of Object.entries(executorLogins)) {
    const executable = rows(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'morrow\\_%' AND has_function_privilege('${login}',p.oid,'EXECUTE')`,
    );
    assert.deepEqual(names(executable.map((f) => f.signature)), names(allowed), login);
    const [privileges] = rows(
      `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'morrow\\_%' AND (has_table_privilege('${login}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('${login}',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))::int AS tables, (SELECT COALESCE(array_agg(n.nspname ORDER BY 1),'{}') FROM pg_namespace n WHERE n.nspname LIKE 'morrow\\_%' AND has_schema_privilege('${login}',n.oid,'USAGE')) AS schemas, (SELECT count(*) FROM pg_namespace n WHERE n.nspname LIKE 'morrow\\_%' AND has_schema_privilege('${login}',n.oid,'CREATE'))::int AS creates`,
    );
    assert.equal(privileges.tables, 0, login);
    assert.equal(privileges.creates, 0, login);
    assert.deepEqual(
      privileges.schemas,
      [...new Set(allowed.map((signature) => signature.split(".")[0]))].sort(),
      login,
    );
  }
  recordConformance("S7", true);
});

// M2 PR-1 (P09.T05a; mvp-architecture §11): every registered table, which S1 and S7 tie to
// the live catalog, declares its content class, and every store-content table has exactly
// one cleanup handler in packages/work/src/redaction.ts.
test("S8: content classes and the store-content cleanup handlers", () => {
  const live = new Set(
    db
      .rows(
        "SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('morrow_work','morrow_billing','morrow_vault')",
      )
      .map((r) => r.name),
  );
  assert.deepEqual(
    registeredTables()
      .map(([name]) => name)
      .sort(),
    [...live].sort(),
  );
  assert.deepEqual(contentProblems(), []);
  recordConformance("S8", true);
});
