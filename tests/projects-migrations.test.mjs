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
import { goalMetrics } from "../packages/policy/src/projects/measures.ts";

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

test("manifest: its row, executeAs the work owner, its brief and digest, no prerequisites", () => {
  assert.ok(row);
  assert.equal(row.file, String(row.sequence).padStart(4, "0") + "." + slug + ".sql");
  // 0046 at integration; later links of the merge train append after it, never between
  // (v1 PR 4's catalog-undo first; the no-gap rule is migration-history's).
  assert.equal(row.sequence, 46);
  assert.ok(
    manifest.migrations
      .slice(manifest.migrations.indexOf(row) + 1)
      .every((m) => m.sequence > row.sequence),
  );
  assert.deepEqual(
    [row.executeAs, row.reviewRef],
    ["morrow_work_owner", "docs/briefs/projects-backend.md"],
  );
  assert.equal(row.sha256, sha(text));
  assert.equal(row.prerequisites, undefined);
  // Forward only, after M3 PR-2's listings runs and v1 PR 1's live-store pair.
  const before = (s) => manifest.migrations.find((m) => m.file.endsWith("." + s + ".sql"));
  for (const s of ["listings-runs", "shopify-live-store-identity", "shopify-live-store-vault"])
    assert.ok(before(s).sequence < row.sequence, s);
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
    "outbox_events_event_type_check",
    "outbox_events_check3",
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
  for (const refusal of [
    "'stale'",
    "'actor_ineligible'",
    "'owner_only'",
    "'state_conflict'",
    "'invalid'",
    "'stopped'",
    "'limit_reached'",
  ])
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
  assert.ok(sql.includes(`read_tags @> '[{"capability":"support.case.read"}]'::jsonb`));
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

test("review fixes: card digests, Quick tasks and areas, a project's criteria, bounded checks", () => {
  // A card's digest covers only its draft: two cards, or an edit back to an earlier draft,
  // share one, so it is not unique (every lookup is by message and revision).
  const cards = sql.slice(sql.indexOf("CREATE TABLE morrow_work.plan_draft_revisions ("));
  const table = cards.slice(0, cards.indexOf(");\n"));
  assert.doesNotMatch(table, /UNIQUE \(organization_id,workspace_id,digest\)/);
  assert.match(table, /PRIMARY KEY \(organization_id,workspace_id,message_id,revision\)/);
  // A dated project or an area holds 1 to 3 criteria, all measured; Quick tasks none.
  const project = body("valid_project_criteria");
  assert.ok(project.includes("IF p_due IS NULL AND p_area IS NULL THEN RETURN true; END IF;"));
  assert.ok(project.includes("IF p_area='quick_tasks' THEN RETURN v_measured=0; END IF;"));
  assert.ok(
    project.includes("RETURN v_measured BETWEEN 1 AND 3 AND v_measured=jsonb_array_length(c);"),
  );
  assert.ok(
    sql.includes(
      "ADD CONSTRAINT goals_project_criteria CHECK (morrow_work.valid_project_criteria(success_criteria,due_at,area_template_id))",
    ),
  );
  assert.ok(
    body("cmd_goal_revise").includes(
      "morrow_work.valid_project_criteria(v_criteria,v_due,g.area_template_id)",
    ),
  );
  const start = body("cmd_plan_start");
  assert.equal([...start.matchAll(/morrow_work\.valid_project_criteria\(/g)].length, 2);
  // A plan change never revises Quick tasks (cmd_goal_revise's own rule).
  assert.ok(start.includes("x.due_at,x.area_template_id,x.success_criteria INTO g"));
  assert.ok(
    start.includes(
      "IF g.area_template_id='quick_tasks' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;",
    ),
  );
  assert.ok(body("cmd_goal_revise").includes("g.area_template_id='quick_tasks'"));
  // Quick tasks is always open; an area never ends.
  const guard = body("goal_kind_guard");
  assert.ok(guard.includes("RAISE EXCEPTION 'QUICK_TASKS_ALWAYS_OPEN'"));
  assert.ok(guard.includes("RAISE EXCEPTION 'AREA_NEVER_ENDS'"));
  // Only the Owner gets and confirms a Quick tasks document, under the interlock.
  const owner =
    "morrow_identity.work_ownership_facts(p.organization_id) o\n   WHERE o.owner_principal_id=p.principal_id AND o.owner_membership_id=p.membership_id";
  assert.ok(body("cmd_plan_start_document").includes(owner));
  assert.ok(start.includes(owner));
  assert.ok(
    start.indexOf("morrow_identity.work_ownership_facts") <
      start.indexOf("morrow_work.target_recheck("),
  );
  assert.ok(
    text.includes(
      "has_function_privilege('morrow_work_command','morrow_identity.work_ownership_facts(text)','EXECUTE')",
    ),
  );
  // At most 3 checks per goal, key, product row and UTC day.
  const check = body("cmd_goal_check");
  assert.ok(check.includes("x.observed_at>=v_day AND x.observed_at<v_day+interval '1 day')>=3"));
  assert.ok(check.indexOf("'limit_reached'") < check.indexOf("INSERT INTO"));
});

test("second review fixes: goal.revised on the stream; a plan change keeps customer-class goals", () => {
  // The outbox CHECKs this file revises are pinned as 0038 left them, then widened by
  // goal.revised with an empty payload (ids and revision ride in the envelope).
  const md5 = (name) =>
    new RegExp(`c\\.conname='${name}'\\)\\n  IS DISTINCT FROM '[a-f0-9]{32}'`).test(text);
  assert.ok(md5("outbox_events_event_type_check") && md5("outbox_events_check3"));
  const outbox = sql.slice(sql.indexOf("ALTER TABLE morrow_work.outbox_events"));
  const altered = outbox.slice(0, outbox.indexOf(";\n"));
  assert.match(
    altered,
    /DROP CONSTRAINT outbox_events_event_type_check, DROP CONSTRAINT outbox_events_check3,/,
  );
  assert.match(altered, /'run\.admitted','run\.status_changed','goal\.revised'\)\)/);
  assert.ok(
    altered.includes("WHEN event_type='goal.revised' THEN payload='{}'::jsonb\n  ELSE false END)"),
  );
  // The registry row: aggregate goal, the empty payload, pinned in the release baseline.
  const registry = JSON.parse(readFileSync("docs/contracts/event-registry.json", "utf8"));
  const revised = registry.events.find((e) => e.eventType === "goal.revised");
  assert.deepEqual(
    [revised.aggregateType, revised.payloadDefinition, revised.since],
    ["goal", "EmptyEventPayload", "1.1"],
  );
  const baseline = JSON.parse(readFileSync("docs/contracts/release-baseline.json", "utf8"));
  assert.ok(Object.hasOwn(baseline.event_registry.rows, "goal.revised"));
  // Both writers of a goal revision append exactly one goal.revised at the new revision,
  // before the command row, in the same transaction.
  const revise = body("cmd_goal_revise");
  const event =
    "PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'goal.revised','goal',";
  assert.equal(revise.split(event).length, 2);
  assert.ok(
    revise.includes(event + "p_goal_id,v_revision,NULL,\n  '{}'::jsonb,p_correlation_id,v_at);"),
  );
  assert.ok(revise.indexOf(event) < revise.indexOf("morrow_work.record_command("));
  const start = body("cmd_plan_start");
  assert.equal(start.split(event).length, 2);
  assert.ok(
    start.includes(event + "v_goal_id,v_revision,NULL,\n   '{}'::jsonb,p_correlation_id,v_now);"),
  );
  const change = start.slice(start.indexOf("v_revision:=g.revision+1;"));
  assert.ok(change.indexOf("UPDATE morrow_work.goals") < change.indexOf(event));
  // A plan change never drops a customer-class goal, refused under lock before any write.
  // The SQL names the one customer-class metric code has (measures.ts).
  assert.deepEqual(
    Object.entries(goalMetrics)
      .filter(([, m]) => m.valueClass === "customer")
      .map(([id]) => id),
    ["replied_within_a_day"],
  );
  const keep =
    "e#>>'{measure,metricId}'='replied_within_a_day'\n     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_records#>'{goal,successCriteria}') n WHERE n=e)) THEN\n    RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;";
  assert.ok(start.includes(keep));
  assert.ok(start.indexOf(keep) < start.indexOf("INSERT INTO morrow_work.goals"));
});
