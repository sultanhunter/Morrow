// P06.T01a migration and laboratory wiring checks that need no database. The
// PostgreSQL 17 behaviour itself is qualified by lab:work-postgresql and
// lab:tenant-conformance (pg-linking), and in workerd by lab:work-workers (pg-http).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectMigrations } from "../scripts/delivery-checks.mjs";
import { workStatements } from "../packages/work/src/sql.ts";

const read = (path) => readFileSync(path, "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const manifest = JSON.parse(read("migrations/manifest.json"));
const bridge = read("migrations/0014.work-identity-bridge.sql");
const state = read("migrations/0015.work-state.sql");
const roles = read("infra/work-role-prerequisites.sql");
const pkg = JSON.parse(read("package.json"));

test("manifest: the work migrations follow 0012 with executeAs and reviewRef", () => {
  const work = manifest.migrations.filter((m) => /work-(identity-bridge|state)/.test(m.file));
  assert.deepEqual(
    work.map((m) => [m.file, m.executeAs, m.reviewRef]),
    [
      ["0014.work-identity-bridge.sql", "morrow_identity_owner", "docs/packets/P06.T01a.md"],
      ["0015.work-state.sql", "morrow_work_owner", "docs/packets/P06.T01a.md"],
    ],
  );
  for (const m of work) assert.equal(sha(read("migrations/" + m.file)), m.sha256);
  // Only entries after the identity chain carry executeAs; its default is the identity owner.
  for (const m of manifest.migrations.filter((x) => x.sequence <= 12))
    assert.equal(m.executeAs, undefined, m.file);
  const files = Object.fromEntries(
    manifest.migrations.map((m) => [m.file, read("migrations/" + m.file)]),
  );
  assert.deepEqual(inspectMigrations(manifest, files), []);
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
  assert.equal(
    bridge.match(/SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp/g).length,
    4,
  );
  assert.doesNotMatch(
    bridge,
    /GRANT EXECUTE[^;]*TO[^;]*\b(PUBLIC|morrow_work_api|morrow_api_worker|morrow_work_owner)\b/,
  );
  // BEGIN ATOMIC records the dependency on session_eligibility (AC24).
  assert.match(
    bridge,
    /work_session_context[\s\S]*?BEGIN ATOMIC[\s\S]*?morrow_identity\.session_eligibility\(p_digest,p_workspace\)/,
  );
  // No identity table, function or grant is changed.
  assert.doesNotMatch(bridge, /\b(ALTER|DROP)\s+(TABLE|FUNCTION)\b|CREATE OR REPLACE/);
  assert.doesNotMatch(bridge, /\bEXECUTE\s+format\b/);
});

test("work state: definers have fixed search paths and no dynamic SQL; tasks stop at ready", () => {
  assert.match(state, /^BEGIN;/);
  assert.match(state, /COMMIT;\s*$/);
  assert.match(state, /current_user<>'morrow_work_owner'/);
  const bodies = [
    ...state.matchAll(/CREATE FUNCTION morrow_work\.(\w+)\([\s\S]*?(?:\$\$;|END \$\$;)/g),
  ];
  assert.equal(bodies.length, 20);
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

test("laboratories: each P06.T01a lab runs once, in a PostgreSQL group", () => {
  assert.equal(
    pkg.scripts["lab:work-postgresql"],
    "node --import tsx scripts/work-postgresql-lab.mjs",
  );
  assert.equal(pkg.scripts["lab:work-workers"], "node --import tsx scripts/work-workers-lab.mjs");
  assert.equal(
    pkg.scripts["lab:tenant-conformance"],
    "node --import tsx --test --test-concurrency=1 tests/tenant-conformance/static.test.mjs tests/tenant-conformance/probes.test.mjs",
  );
  assert.match(
    pkg.scripts["lab:group:pg-linking"],
    /npm run lab:tenant-conformance && npm run lab:work-postgresql$/,
  );
  assert.match(pkg.scripts["lab:group:pg-http"], /npm run lab:work-workers$/);
});
