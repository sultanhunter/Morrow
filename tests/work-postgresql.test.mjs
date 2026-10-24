// P06.T01a migration and laboratory wiring checks that need no database. The
// PostgreSQL 17 behaviour itself is qualified by lab:work-postgresql and
// lab:tenant-conformance, and in workerd by lab:work-workers (the pg-work group).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectMigrations } from "../scripts/delivery-checks.mjs";
import { workStatements } from "../packages/work/src/sql.ts";
import { loadMigrationChain } from "../scripts/migration-chain.mjs";
import {
  migrationPlan,
  organizationInterlockSql,
  revocationSql,
  restoreSql,
} from "./tenant-conformance/harness.mjs";

const read = (path) => readFileSync(path, "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const manifest = JSON.parse(read("migrations/manifest.json"));
const bridge = read("migrations/0014.work-identity-bridge.sql");
const admission = read("migrations/0008.browser-session-admission.sql");
const state = read("migrations/0015.work-state.sql");
const roles = read("infra/work-role-prerequisites.sql");
const pkg = JSON.parse(read("package.json"));

test("manifest: the work migrations follow 0013 with executeAs and reviewRef", () => {
  const work = manifest.migrations.filter((m) => /work-(identity-bridge|state)/.test(m.file));
  assert.deepEqual(
    work.map((m) => [m.file, m.executeAs, m.reviewRef]),
    [
      ["0014.work-identity-bridge.sql", "morrow_identity_owner", "docs/packets/P06.T01a.md"],
      ["0015.work-state.sql", "morrow_work_owner", "docs/packets/P06.T01a.md"],
    ],
  );
  for (const m of work) assert.equal(sha(read("migrations/" + m.file)), m.sha256);
  // Every row carries executeAs (P03.T04e §3.1); the identity chain runs as the identity owner.
  for (const m of manifest.migrations.filter((x) => x.sequence <= 13))
    assert.equal(m.executeAs, "morrow_identity_owner", m.file);
  // The work roles are pinned on 0014, the first migration that names them.
  assert.deepEqual(
    work.map((m) => (m.prerequisites ?? []).map((p) => p.file)),
    [["infra/work-role-prerequisites.sql"], []],
  );
  const files = Object.fromEntries(
    manifest.migrations.map((m) => [m.file, read("migrations/" + m.file)]),
  );
  const prerequisites = Object.fromEntries(
    manifest.migrations.flatMap((m) => (m.prerequisites ?? []).map((p) => [p.file, read(p.file)])),
  );
  assert.deepEqual(inspectMigrations(manifest, files, prerequisites), []);
});

test("roles: four reviewed roles, two SET-only memberships, no PASSWORD and idempotent", () => {
  const statements = roles.replace(/--.*$/gm, "");
  assert.doesNotMatch(statements, /PASSWORD/i);
  for (const role of ["morrow_work_owner", "morrow_work_command", "morrow_work_api"])
    assert.match(
      roles,
      new RegExp(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;`,
      ),
    );
  assert.match(
    roles,
    /CREATE ROLE morrow_api_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;/,
  );
  assert.equal(roles.match(/IF NOT EXISTS/g).length, 4);
  assert.match(roles, /GRANT morrow_work_api TO morrow_api_worker WITH INHERIT FALSE, SET TRUE;/);
  assert.match(
    roles,
    /GRANT morrow_work_command TO morrow_work_owner WITH INHERIT FALSE, SET TRUE;/,
  );
  assert.doesNotMatch(statements, /morrow_work_(relay|maintenance|operations)|orchestrator/);
});

test("bridge: four definers with fixed search paths, EXECUTE for the command role only", () => {
  assert.match(bridge, /^BEGIN;/);
  assert.match(bridge, /COMMIT;\s*$/);
  assert.match(bridge, /current_user<>'morrow_identity_owner'/);
  const functions = [...bridge.matchAll(/CREATE FUNCTION morrow_identity\.(\w+)\(/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(functions, [
    "work_session_context",
    "work_actor_authority",
    "work_lock_and_recheck",
    "work_member_authority",
  ]);
  for (const name of functions) {
    assert.match(
      bridge,
      new RegExp(`REVOKE ALL ON FUNCTION morrow_identity\\.${name}\\([^)]*\\) FROM PUBLIC;`),
    );
    assert.match(
      bridge,
      new RegExp(
        `GRANT EXECUTE ON FUNCTION morrow_identity\\.${name}\\([^)]*\\) TO morrow_work_command;`,
      ),
    );
  }
  // Four bridge definers plus the three interlock replacements (below).
  assert.equal(
    bridge.match(/SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp/g).length,
    7,
  );
  // ADR-0020 (P04.T01j D2): the one EXECUTE grant to the work owner is the three
  // read-only membership helpers that 0015 checks while it runs as the work owner.
  const helperGrant =
    "GRANT EXECUTE ON FUNCTION morrow_identity.recorded_administrator(),morrow_identity.memberships_closed(name),morrow_identity.morrow_memberships_closed() TO morrow_work_owner;\n";
  assert.equal(bridge.split(helperGrant).length, 2);
  assert.doesNotMatch(
    bridge.replace(helperGrant, ""),
    /GRANT EXECUTE[^;]*TO[^;]*\b(PUBLIC|morrow_work_api|morrow_api_worker|morrow_work_owner)\b/,
  );
  // BEGIN ATOMIC records the dependency on session_eligibility (AC24).
  assert.match(
    bridge,
    /work_session_context[\s\S]*?BEGIN ATOMIC[\s\S]*?morrow_identity\.session_eligibility\(p_digest,p_workspace\)/,
  );
  // No identity table is changed, and no function is dropped or altered.
  assert.doesNotMatch(bridge, /\b(ALTER|DROP)\s+(TABLE|FUNCTION)\b/);
  assert.doesNotMatch(bridge, /\bEXECUTE\s+format\b/);
  assert.equal(bridge.match(/^(GRANT|REVOKE) /gm).length, 13);
});

// One key for the organization interlock: work_lock_and_recheck takes it shared;
// every identity function that locks an organization FOR UPDATE takes it
// exclusively first (a row FOR SHARE alone would let overlapping commands
// starve a waiting revocation).
const interlock = (mode, key) =>
  `PERFORM pg_catalog.pg_advisory_xact_lock${mode}(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',${key})::text,0));`;
const definition = (sql, name) => {
  const match = sql.match(
    new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION morrow_identity\\.${name}\\([\\s\\S]*?\\nEND \\$\\$;`,
    ),
  );
  assert.ok(match, name);
  return match[0];
};
test("bridge: the organization interlock is shared in commands and exclusive in identity writers", () => {
  const recheck = definition(bridge, "work_lock_and_recheck");
  const shared = recheck.indexOf(interlock("_shared", "v_org"));
  assert.ok(shared > 0 && shared < recheck.indexOf("FOR SHARE;"));
  for (const [name, key] of [
    ["revoke_workspace_access", "p_organization_id"],
    ["link_workspace_store", "p_org"],
    ["admit_browser_family", "org_key"],
  ]) {
    // The 0008 definition, unchanged but for the one interlock statement, which
    // precedes the organization FOR UPDATE.
    const replaced = definition(
      bridge.slice(bridge.indexOf("-- The organization interlock")),
      name,
    );
    const line = replaced.split("\n").find((l) => l.trim() === interlock("", key));
    assert.ok(line, name);
    const lock = replaced.indexOf(line);
    assert.ok(
      lock <
        replaced.indexOf(
          "FROM morrow_identity.organizations WHERE id::text=" + key + " FOR UPDATE",
        ),
      name,
    );
    assert.equal(
      replaced.replace(line + "\n", ""),
      definition(admission, name).replace(/^CREATE FUNCTION /, "CREATE OR REPLACE FUNCTION "),
      name,
    );
  }
  // No later migration redefines them without the interlock. M2 PR-2's identity migration,
  // v1 PR 1's live-store migration and "Disconnect store"'s (store-link template v2), each
  // located by slug, replace link_workspace_store; each new definition keeps the exclusive
  // interlock before the organization FOR UPDATE.
  for (const m of manifest.migrations.filter((x) => x.sequence > 14)) {
    const text = read("migrations/" + m.file);
    assert.doesNotMatch(
      text,
      /FUNCTION morrow_identity\.(revoke_workspace_access|admit_browser_family)\(/,
      m.file,
    );
    if (!/FUNCTION morrow_identity\.link_workspace_store\(/.test(text)) continue;
    assert.ok(
      m.file.endsWith(".shopify-install-identity.sql") ||
        m.file.endsWith(".shopify-live-store-identity.sql") ||
        m.file.endsWith(".disconnect-store-identity.sql"),
      m.file,
    );
    const replaced = definition(text, "link_workspace_store");
    const lock = replaced.indexOf(interlock("", "p_org"));
    assert.ok(
      lock > 0 &&
        lock <
          replaced.indexOf("FROM morrow_identity.organizations WHERE id::text=p_org FOR UPDATE"),
      m.file,
    );
    assert.equal(replaced.split(interlock("", "p_org")).length, 2, m.file);
  }
  // The laboratory's owner-maintenance revocation reproduces the same lock order.
  for (const sql of [revocationSql, restoreSql].map((f) =>
    f({ org: "org_o", workspace: "ws_w", membership: "m" }),
  )) {
    const at = sql.indexOf(organizationInterlockSql("org_o"));
    assert.ok(at > 0 && at < sql.indexOf("FOR UPDATE"));
  }
  assert.match(
    organizationInterlockSql("org_o"),
    /jsonb_build_array\('morrow\.identity\.organization','org_o'::text\)/,
  );
});

test("bridge: from 0014 on, every organization FOR UPDATE follows the exclusive interlock", () => {
  // The 0014 rule: any later identity function that locks an organization FOR
  // UPDATE takes the same exclusive interlock first, in the same body.
  const exclusive =
    "pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',";
  const found = [];
  for (const m of manifest.migrations.filter((x) => x.sequence >= 14)) {
    const sql = read("migrations/" + m.file).replace(/--.*$/gm, "");
    // The body search below relies on plain $$ quoting.
    assert.doesNotMatch(sql, /\$[A-Za-z_]\w*\$/, m.file);
    for (const lock of sql.matchAll(
      /FROM morrow_identity\.organizations\b[^;]*\bFOR (?:NO KEY )?UPDATE\b/g,
    )) {
      const before = sql.slice(0, lock.index);
      // Every body in these migrations is $$-quoted, so the last $$ (or BEGIN ATOMIC)
      // opens the body holding the lock; outside a body it closes the previous one.
      const body = before.slice(
        Math.max(0, before.lastIndexOf("$$"), before.lastIndexOf("BEGIN ATOMIC")),
      );
      assert.ok(body.includes(exclusive), m.file + ": " + lock[0].slice(0, 80));
      found.push(m.file);
    }
  }
  // Not vacuous: the three 0014 replacements are found.
  assert.equal(found.filter((f) => f === "0014.work-identity-bridge.sql").length, 3);
});

test("harness: the chain module supplies each row's pinned prerequisites and executeAs", () => {
  const chain = loadMigrationChain();
  const plan = migrationPlan(chain);
  // Every pinned prerequisite runs once, immediately before the first row that pins it,
  // and every manifest row runs under its own executeAs: no private file map remains.
  const expected = manifest.migrations.flatMap((m) => [
    ...(m.prerequisites ?? []).map((p) => ["prerequisite", p.file]),
    ["migration", m.file, m.executeAs],
  ]);
  assert.deepEqual(
    plan.map((step) =>
      step.kind === "prerequisite"
        ? [step.kind, step.file]
        : [step.kind, step.file, step.executeAs],
    ),
    expected,
  );
  for (const step of plan)
    if (step.kind === "prerequisite") assert.equal(step.text, read(step.file), step.file);
  const harness = read("tests/tenant-conformance/harness.mjs");
  assert.doesNotMatch(harness, /-prerequisites\.sql/);
  assert.match(harness, /loadMigrationChain/);
});

test("work state: definers have fixed search paths and no dynamic SQL; tasks stop at ready", () => {
  assert.match(state, /^BEGIN;/);
  assert.match(state, /COMMIT;\s*$/);
  assert.match(state, /current_user<>'morrow_work_owner'/);
  const bodies = [
    ...state.matchAll(/CREATE FUNCTION morrow_work\.(\w+)\([\s\S]*?(?:\$\$;|END \$\$;)/g),
  ];
  assert.equal(bodies.length, 21);
  for (const [body, name] of bodies) {
    assert.match(body, /SET search_path=pg_catalog,(morrow_work,)?pg_temp/, name);
    assert.doesNotMatch(body, /\bEXECUTE\b(?!\s+FUNCTION)/, name);
    if (/SECURITY DEFINER/.test(body))
      assert.ok(
        ["current_tenant", "enter_context", "begin_command", "target_member"].includes(name) ||
          name.startsWith("cmd_"),
        name,
      );
  }
  assert.match(state, /status text NOT NULL CHECK \(status IN \('draft','ready'\)\)/);
  assert.match(
    state,
    /ALTER DEFAULT PRIVILEGES FOR ROLE morrow_work_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;/,
  );
  assert.match(
    state,
    /GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;[\s\S]*REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;\s*COMMIT;\s*$/,
  );
  assert.doesNotMatch(
    state.replace(/--.*$/gm, ""),
    /GRANT[^;]*\b(DELETE|TRUNCATE)\b[^;]*TO morrow_work_(api|command)/,
  );
  // No runs, operations, leases or dispatch (hard ordering a).
  assert.doesNotMatch(state, /CREATE TABLE morrow_work\.(runs|operations|leases|dispatch)/);
});

test("statements: one fixed prologue and parameter-only statements", () => {
  assert.equal(
    workStatements.prologueReadWrite,
    "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE; SET LOCAL ROLE morrow_work_api; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='5s'; SET LOCAL transaction_timeout='5s'",
  );
  assert.equal(
    workStatements.prologueReadOnly,
    workStatements.prologueReadWrite.replace("READ WRITE", "READ ONLY"),
  );
  for (const [name, text] of Object.entries(workStatements)) {
    if (name.startsWith("prologue") || name === "commit" || name === "rollback") continue;
    assert.match(text, /^SELECT /, name);
    assert.doesNotMatch(text, /SET ROLE|set_config|\bINSERT\b|\bUPDATE\b|\bDELETE\b/, name);
  }
  // The only SET ROLE anywhere in the work package is the prologue's.
  const sources = [
    "connection",
    "neon-connector",
    "commands",
    "queries",
    "context",
    "eligibility",
    "http",
    "http-guard",
  ].map((f) => read("packages/work/src/" + f + ".ts"));
  for (const source of sources) assert.doesNotMatch(source, /SET (LOCAL )?ROLE/);
});

test("laboratories: each P06.T01a lab runs once, in the pg-work group", () => {
  assert.equal(
    pkg.scripts["lab:work-postgresql"],
    "node --import tsx scripts/work-postgresql-lab.mjs",
  );
  assert.equal(pkg.scripts["lab:work-workers"], "node --import tsx scripts/work-workers-lab.mjs");
  assert.equal(
    pkg.scripts["lab:tenant-conformance"],
    "node --import tsx --test --test-concurrency=1 tests/tenant-conformance/static.test.mjs tests/tenant-conformance/probes.test.mjs",
  );
  // M2 PR-1 appends its spine foundation lab to the same group.
  assert.equal(
    pkg.scripts["lab:spine-foundation"],
    "node --import tsx scripts/spine-foundation-lab.mjs",
  );
  // M2 PR-2 appends its workerd install-and-link lab; M5 PR-1 its workerd api and broker
  // billing lab; M3 PR-1 its listings authority lab (its run-credits lab rides pg-linking);
  // M2 PR-3 its webhooks, privacy and catalogue-read lab; M3 PR-2 its listings runs lab; v1
  // PR 2 its "Disconnect store" lab; build order PR 7 its runtime operations lab.
  assert.equal(
    pkg.scripts["lab:group:pg-work"],
    "npm run lab:tenant-conformance && npm run lab:work-postgresql && npm run lab:work-workers && npm run lab:spine-foundation && npm run lab:shopify-connect-workers && npm run lab:billing-workers && npm run lab:listings-authority && npm run lab:shopify-privacy && npm run lab:listings-runs && npm run lab:disconnect-store",
  );
  assert.equal(
    pkg.scripts["lab:plan-start"],
    "node --import tsx --test --test-concurrency=1 tests/plan-start/postgresql.test.mjs",
  );
  assert.equal(
    pkg.scripts["lab:disconnect-store"],
    "node --import tsx scripts/disconnect-store-lab.mjs",
  );
  assert.equal(
    pkg.scripts["lab:runtime-operations"],
    "node --import tsx scripts/runtime-operations-lab.mjs",
  );
  // pg-work passed its 14-minute cap, so build order PR 7's runtime operations lab, then v1
  // PR 3's review, approve and apply lab (about two minutes of real read-back spacing) and
  // last PR 18's plan-start lab (with it, pg-work passed its cap: hosted run 40060794401
  // cancelled the work leg at 14 minutes, every lab passed) ride pg-linking after
  // run-credits, in that order.
  assert.equal(
    pkg.scripts["lab:group:pg-linking"],
    "npm run lab:workspace-store-linking && npm run lab:browser-session-admission && npm run lab:workspace-linking-read && npm run lab:account-onboarding && npm run lab:shopify-install && npm run lab:run-credits && npm run lab:runtime-operations && npm run lab:catalog-apply && npm run lab:plan-start",
  );
  assert.equal(pkg.scripts["lab:catalog-apply"], "node --import tsx scripts/catalog-apply-lab.mjs");
  assert.equal(
    pkg.scripts["lab:shopify-privacy"],
    "node --import tsx scripts/shopify-privacy-lab.mjs",
  );
  assert.equal(pkg.scripts["lab:listings-runs"], "node --import tsx scripts/listings-runs-lab.mjs");
  assert.equal(
    pkg.scripts["lab:billing-workers"],
    "node --import tsx scripts/billing-workers-lab.mjs",
  );
  assert.equal(
    pkg.scripts["lab:listings-authority"],
    "node --import tsx scripts/listings-authority-lab.mjs",
  );
  assert.equal(pkg.scripts["lab:run-credits"], "node --import tsx scripts/run-credits-lab.mjs");
  // The `work` leg of the ci.yml postgres matrix (P03.T04f).
  assert.match(
    read(".github/workflows/ci.yml"),
    /leg: \[core, http, linking, work\]\n[^]*if: matrix\.leg == 'work'\n\s+run: npm run lab:group:pg-work\n/,
  );
});
