// PR 18 (ADR-0033, ADR-0034): static checks of the projects migration (located by slug,
// never by number: integration renumbers it), its manifest row, the runner contract, FORCE
// RLS on every new table, explicit per-function ACLs, command-owned definers whose tenant
// and actor come only from the session, the goal record's CHECKs and guards, and the
// conformance registry. The behaviour is proved against PostgreSQL 17 by lab:plan-start
// and lab:tenant-conformance.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import { loadMigrationChain } from "../scripts/migration-chain.mjs";
import { workFunctions, workTables } from "./tenant-conformance/registry.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const code = (text) => text.replace(/--.*$/gm, "");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const slug = "projects-goal-measures";
const row = manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const text = readFileSync("migrations/" + row.file, "utf8");
const sql = code(text);
const newTables = [
  "projects",
  "goal_measure_values",
  "goal_finish_results",
  "plan_draft_revisions",
  "plan_start_documents",
];
const apiDefiners = [
  "begin_project_command(text,text,text)",
  "plan_start_document(text)",
  "cmd_goal_revise(text,text,text,text,text,text,text,text,text)",
  "cmd_goal_check(text,text,text,text,text,text,text,text,text)",
  "cmd_plan_start_document(text,text,text,text,text,text,text,text)",
  "cmd_plan_start(text,text,text,text,text,text,text)",
];
const body = (name) => {
  const start = sql.indexOf("CREATE FUNCTION morrow_work." + name + "(");
  assert.ok(start >= 0, name);
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2);
};

test("manifest: the last row, executeAs the work owner, its brief and digest, no prerequisites", () => {
  assert.ok(row);
  assert.equal(row.file, String(row.sequence).padStart(4, "0") + "." + slug + ".sql");
  assert.equal(row.sequence, manifest.migrations.length);
  assert.deepEqual(
    [row.executeAs, row.reviewRef],
    ["morrow_work_owner", "docs/briefs/projects-backend.md"],
  );
  assert.equal(row.sha256, sha(text));
  assert.equal(row.prerequisites, undefined);
  // Forward only, after M3 PR-2's listings runs.
  assert.match(manifest.migrations[row.sequence - 2].file, /\.listings-runs\.sql$/);
  const chain = loadMigrationChain();
  assert.equal(chain.find((e) => e.sequence === row.sequence).executeAs, "morrow_work_owner");
});

test("the runner contract: one transaction, fixed prerequisites, pinned paths, no role or RLS escape", () => {
  assert.deepEqual(migrationSqlViolations(text), []);
  assert.match(text, /^BEGIN;\n/);
  assert.match(text, /\nCOMMIT;\n?$/);
  assert.match(text, /RAISE EXCEPTION 'PROJECTS_PREREQUISITES_INVALID'/);
  // The shared CHECKs and the trigger it revises are asserted exactly as the head defines
  // them, so a later revision is never overwritten blind.
  for (const name of [
    "commands_command_type_check",
    "commands_check",
    "goals_valid_criteria",
    "enforce_status()",
  ])
    assert.ok(text.includes(name), name);
  for (const m of text.matchAll(/CREATE (?:OR REPLACE )?FUNCTION /g)) {
    const rest = text.slice(m.index);
    const header = rest.slice(0, rest.indexOf("$$"));
    assert.match(header, /SET search_path=pg_catalog/, header.slice(0, 80));
  }
  assert.doesNotMatch(sql, /\bEXECUTE\s+(?!format\(|FUNCTION\b|ON\b)/);
  assert.doesNotMatch(sql, /GRANT[^;]*\b(DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*ON/);
  assert.doesNotMatch(sql, /TO PUBLIC/);
  assert.doesNotMatch(sql, /CREATE ROLE|ALTER ROLE|GRANT morrow_[a-z_]+ TO/);
  assert.doesNotMatch(sql, /BYPASSRLS|NO FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL/);
  assert.doesNotMatch(sql, /schema_migrations|migration_history/i);
});

test("FORCE RLS on every new table, the tenant policies, append-only values and results", () => {
  const created = [...sql.matchAll(/CREATE TABLE morrow_work\.([a-z_]+) \(/g)].map((m) => m[1]);
  assert.deepEqual(created, newTables);
  const loop =
    /FOREACH t IN ARRAY ARRAY\[([^\]]*)\] LOOP\s+EXECUTE format\('ALTER TABLE morrow_work\.%I ENABLE ROW LEVEL SECURITY',t\);\s+EXECUTE format\('ALTER TABLE morrow_work\.%I FORCE ROW LEVEL SECURITY',t\);/.exec(
      sql,
    );
  assert.ok(loop);
  assert.deepEqual(
    [...loop[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    newTables,
  );
  // The tenant policy reads the tenant only from current_tenant(); the api role reads every
  // table but the start documents (the actor's own one only through its read definer).
  assert.match(
    sql,
    /CREATE POLICY tenant_command ON morrow_work\.%I TO morrow_work_command\s+USING \(\(organization_id::text,workspace_id::text\)=\(SELECT c\.organization_id,c\.workspace_id FROM morrow_work\.current_tenant\(\) c\)\)/,
  );
  const readable =
    /FOREACH t IN ARRAY ARRAY\[([^\]]*)\] LOOP\s+EXECUTE format\('CREATE POLICY tenant_read/.exec(
      sql,
    );
  assert.deepEqual(
    [...readable[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    newTables.filter((t) => t !== "plan_start_documents"),
  );
  assert.doesNotMatch(sql, /ON morrow_work\.plan_start_documents TO morrow_work_api/);
  // Values and results are append-only; projects, results and card revisions are never
  // deleted outside the owner's maintenance; no new table is truncated.
  assert.match(
    sql,
    /ARRAY\['goal_measure_values','goal_finish_results'\] LOOP\s+EXECUTE format\('CREATE TRIGGER append_only BEFORE UPDATE/,
  );
  assert.match(
    sql,
    /ARRAY\['projects','goal_finish_results','plan_draft_revisions'\] LOOP\s+EXECUTE format\('CREATE TRIGGER append_only_delete BEFORE DELETE/,
  );
  assert.match(sql, /CREATE TRIGGER no_truncate BEFORE TRUNCATE/);
  // The command role updates only the columns its definers change.
  for (const grant of [
    "GRANT UPDATE (objective,due_at,success_criteria) ON morrow_work.goals TO morrow_work_command;",
    "GRANT UPDATE (revision,title,pin_position,updated_at) ON morrow_work.projects TO morrow_work_command;",
    "GRANT UPDATE (consumed_at,consumed_command_id,purge_after) ON morrow_work.plan_start_documents TO morrow_work_command;",
  ])
    assert.ok(sql.includes(grant), grant);
  assert.equal([...sql.matchAll(/GRANT UPDATE/g)].length, 3);
});

test("definers: command-owned, api-only, tenant and actor from the session, never a run", () => {
  for (const signature of apiDefiners) {
    const name = signature.slice(0, signature.indexOf("("));
    const fn = body(name);
    assert.match(fn, /SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp/, name);
    assert.ok(
      sql.includes(`ALTER FUNCTION morrow_work.${signature} OWNER TO morrow_work_command;`),
      name,
    );
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION morrow_work.${signature} FROM PUBLIC;`), name);
    // No parameter names a tenant, workspace, actor, grant or role.
    const params = fn.slice(fn.indexOf("(") + 1, fn.indexOf(")"));
    assert.doesNotMatch(params, /organization|workspace|principal|membership|grant_id|role/, name);
    // The tenant and actor come only from current_tenant() or the command prelude.
    assert.match(fn, /current_tenant\(\)|command_prelude\(/, name);
    // Nothing here admits a run, reserves money or dispatches.
    assert.doesNotMatch(
      fn,
      /INSERT INTO morrow_work\.runs|morrow_billing|work_leases|dispatch/,
      name,
    );
  }
  const granted = /GRANT EXECUTE ON FUNCTION ([^;]*?) TO morrow_work_api;/.exec(sql)[1];
  assert.deepEqual(
    granted
      .split(/,\s*(?=morrow_)/)
      .map((f) =>
        f
          .trim()
          .replace(/^morrow_work\./, "")
          .replace(/\s+/g, ""),
      )
      .sort(),
    [...apiDefiners].sort(),
  );
  assert.equal(
    [...sql.matchAll(/TO morrow_work_api;/g)].length,
    6,
    "five column reads and one EXECUTE",
  );
  // Every function has its PUBLIC revoke.
  for (const [, name] of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION morrow_work\.([a-z_]+)\(/g))
    if (name !== "enforce_status")
      assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION morrow_work\\.${name}\\(`), name);
  // The start re-checks the actor, the session, the nonce and the grant summary under lock,
  // consumes the document once and records one command.
  const start = body("cmd_plan_start");
  for (const piece of [
    "FOR UPDATE",
    "doc.actor_principal_id<>p.principal_id",
    "doc.session_digest IS DISTINCT FROM pg_catalog.current_setting('morrow.work_session_digest',true)",
    "doc.consumed_at IS NOT NULL OR v_now>=doc.expires_at OR doc.nonce_digest<>p_nonce_digest",
    "doc.grant_summary_digest<>p_grant_summary_digest",
    "morrow_work.target_recheck(",
    "morrow_work.stop_active(",
    "'repeating_unavailable'",
    "SET consumed_at=v_now",
    "morrow_work.record_command(",
  ])
    assert.ok(start.includes(piece), piece);
  // Every refusal returns before the first write.
  const firstWrite = start.indexOf("INSERT INTO");
  for (const refusal of ["'stale'", "'actor_ineligible'", "'stopped'", "'limit_reached'"])
    assert.ok(start.lastIndexOf(refusal) < firstWrite, refusal);
  // The document's issuer binds it to this session and stores only the nonce's digest.
  const issue = body("cmd_plan_start_document");
  assert.ok(issue.includes("pg_catalog.current_setting('morrow.work_session_digest',true)"));
  assert.ok(issue.includes("v_created+interval '5 minutes'"));
  assert.doesNotMatch(issue, /p_nonce\b/);
});

test("goal records: a stored start value, a fourth measure, a dated area and Finish's guards", () => {
  // startRef is always null in a stored measure (the server derives the start).
  assert.ok(body("valid_goal_measure").includes("m->'startRef'<>'null'::jsonb THEN RETURN false"));
  assert.ok(body("valid_goal_criteria").includes("RETURN v_measured<=3;"));
  for (const check of [
    "ADD CONSTRAINT goals_due_or_area CHECK (due_at IS NULL OR area_template_id IS NULL)",
    "ADD CONSTRAINT goals_valid_criteria CHECK (morrow_work.valid_goal_criteria(success_criteria,due_at))",
    "CREATE UNIQUE INDEX goals_one_area ON morrow_work.goals (organization_id,workspace_id,area_template_id)",
  ])
    assert.ok(sql.includes(check), check);
  const guard = body("goal_kind_guard");
  assert.ok(guard.includes("RAISE EXCEPTION 'GOAL_KIND_IMMUTABLE'"));
  assert.ok(guard.includes("f.goal_revision=NEW.revision AND f.outcome='achieved'"));
  assert.ok(guard.includes("RAISE EXCEPTION 'GOAL_FINISH_RESULTS_MISSING'"));
  assert.ok(guard.includes("t.status NOT IN ('succeeded','failed','cancelled')"));
  assert.ok(guard.includes("RAISE EXCEPTION 'GOAL_TASKS_OPEN'"));
  // An area or Quick tasks record counts only tasks not ended toward its 200-task cap.
  assert.ok(
    body("goal_task_count").includes(
      "(g.area_template_id IS NULL OR t.status NOT IN ('succeeded','failed','cancelled'))",
    ),
  );
  // Values: no customer-tagged value here; an order value on its 90-day clock; a person
  // records only a hand check.
  for (const name of [
    "goal_measure_values_no_customer",
    "goal_measure_values_clock",
    "goal_measure_values_recorder",
  ])
    assert.ok(sql.includes("CONSTRAINT " + name + " CHECK"), name);
  assert.ok(sql.includes(`read_tags @> '[{"capabilityId":"support.case.read"}]'::jsonb`));
  assert.ok(sql.includes("+interval '90 days'"));
  // A card's edit keeps revision 1's taint and restricted sources; a start document lasts
  // five minutes and its nonce is single use.
  const card = body("plan_draft_guard");
  assert.ok(
    card.includes(
      "f.context_taint<>NEW.context_taint OR f.restricted_sources<>NEW.restricted_sources",
    ),
  );
  assert.ok(
    sql.includes(
      "CONSTRAINT plan_start_documents_window CHECK (expires_at=created_at+interval '5 minutes')",
    ),
  );
  assert.ok(sql.includes("UNIQUE (nonce_digest)"));
});

test("registry: every new table and function is registered with its class", () => {
  for (const table of newTables) assert.ok(workTables[table], table);
  assert.equal(workTables.plan_start_documents.class, "tenant_internal");
  for (const table of newTables.filter((t) => t !== "plan_start_documents"))
    assert.equal(workTables[table].class, "tenant_readable", table);
  for (const [, name] of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION morrow_work\.([a-z_]+)\(/g))
    assert.ok(
      Object.keys(workFunctions).some((signature) => signature.startsWith(name + "(")),
      name,
    );
  for (const signature of apiDefiners) {
    assert.equal(workFunctions[signature].kind, "api", signature);
    assert.deepEqual(workFunctions[signature].grantees, ["morrow_work_api"], signature);
  }
});
