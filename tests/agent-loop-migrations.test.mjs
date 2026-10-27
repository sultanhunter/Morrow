// Plan row H7a (ADR-0041 item 4, with items 3, 5 to 7, 9, 12 to 14, 16, 17, 20 and 28 to 34):
// static checks of the agent-runs migration (located by slug, never by number: the lead
// renumbers it at merge), its manifest row, the runner contract, FORCE RLS on every table of the
// one data model, the content classes, the CHECKs as safety ranges only, the closed codes against
// H6's contracts (drift), the catalogues, safety template and context policy against the
// generated data (drift), the runtime definers (ids only, one call each, executable only by
// morrow_runtime_executor), the lease sources, the retention clocks, the conformance registry
// and the switch record. The behaviour is proved against PostgreSQL 17 by lab:agent-runs (one
// case per lease source of ADR-0041 item 7's table) and lab:tenant-conformance.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import { loadMigrationChain } from "../scripts/migration-chain.mjs";
import { agentLoopPrerequisites } from "../scripts/generate-agent-platform.mjs";
import { executorLogins, workFunctions, workTables } from "./tenant-conformance/registry.mjs";
import { generatedLoopCatalogue } from "../packages/policy/src/generated/loop-catalogue.ts";
import { generatedToolCatalogue } from "../packages/policy/src/generated/tool-catalogue.ts";
import { generatedContextPolicy } from "../packages/policy/src/generated/context-policy.ts";
import { replyStoredBytes } from "../packages/policy/src/fake-model-gateway.ts";
import { runSafetyProfile1 } from "../packages/policy/src/run-safety.ts";
import { canonicalJson } from "../packages/work/src/digest.ts";
import { agentRunSql } from "../packages/work/src/loop/steps.ts";
import { loopStatements } from "../packages/work/src/loop/sql.ts";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const code = (text) => text.replace(/--.*$/gm, "");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const slug = "agent-runs";
const row = manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const text = readFileSync("migrations/" + row.file, "utf8");
const sql = code(text);
const core = JSON.parse(readFileSync("docs/contracts/schemas/v1.1/core.schema.json", "utf8")).$defs;
const contractEnum = (name) => {
  assert.ok(core[name]?.enum, name);
  return [...core[name].enum];
};
const platformTables = [
  "loop_catalogue_versions",
  "loop_catalogue_entries",
  "tool_catalogue_entries",
  "context_policy_versions",
];
// ADR-0041 item 4's one data model (the memory tables are H12's; ADR-0040's conversation
// tables are P07.T03's).
const tenantTables = [
  "jobs",
  "agent_contexts",
  "context_epochs",
  "agent_runs",
  "agent_calls",
  "agent_run_questions",
  "run_waits",
  "context_checkpoints",
  "run_turns",
  "run_tool_calls",
  "agent_model_calls",
  "run_plans",
  "run_plan_revisions",
  "run_events",
  "teammate_results",
  "result_items",
  "result_item_pages",
  "run_detector_state",
  "run_segments",
  "run_taint_sources",
  "run_memory_reads",
  "upkeep_triggers",
];
const newTables = [...platformTables, ...tenantTables];
// Content lives only here (the registry's class workspace); every other table holds ids,
// codes, counts, digests and times.
const contentTables = [
  "agent_run_questions",
  "context_checkpoints",
  "run_turns",
  "run_plan_revisions",
  "teammate_results",
  "result_items",
  "result_item_pages",
];
// The runtime definers ADR-0041 names, and the Workflow's entry lookups.
const runtimeDefiners = [
  "agent_run_lease_renew",
  "agent_run_resume",
  "admit_upkeep_run",
  "agent_run_wake_candidates",
  "agent_run_segment_roll",
];
const entryLookups = ["agent_run_pending_starts", "agent_run_resume_lease", "agent_run_start"];
const tableBody = (name) => {
  const start = sql.indexOf("CREATE TABLE morrow_work." + name + " (");
  assert.ok(start >= 0, name);
  return sql.slice(start, sql.indexOf("\n);", start));
};
const fnBody = (name) => {
  const start = sql.indexOf(`CREATE FUNCTION morrow_work.${name}(`);
  assert.ok(start >= 0, name);
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2);
};
// The quoted values of `<column> IN (...)` in a table's body (or any text), in order.
const inList = (body, column) => {
  const found = new RegExp(
    "(?<![a-z_])" + column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " (?:NOT )?IN \\(",
  ).exec(body);
  assert.ok(found, column);
  const open = found.index + found[0].length - 1;
  let depth = 0;
  let end = open;
  for (; end < body.length; end++) {
    if (body[end] === "(") depth++;
    if (body[end] === ")" && --depth === 0) break;
  }
  return [...body.slice(open, end).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
};
const columns = (name) =>
  [...tableBody(name).matchAll(/^ ([a-z_0-9]+) ([a-z_.]+(?:\[\])?)/gm)]
    .filter((m) => !["PRIMARY", "FOREIGN", "UNIQUE", "CONSTRAINT"].includes(m[1]))
    .map((m) => ({ name: m[1], type: m[2] }));

test("manifest: the last row, executeAs the work owner, its packet and digest, no prerequisites", () => {
  assert.ok(row);
  assert.equal(row.file, String(row.sequence).padStart(4, "0") + "." + slug + ".sql");
  assert.equal(row, manifest.migrations.at(-1));
  assert.deepEqual([row.executeAs, row.reviewRef], ["morrow_work_owner", "docs/packets/H7a.md"]);
  assert.ok(readFileSync(row.reviewRef, "utf8").includes("# H7a"));
  assert.equal(row.sha256, sha(text));
  assert.equal(row.prerequisites, undefined);
  const before = (s) => manifest.migrations.find((m) => m.file.endsWith("." + s + ".sql"));
  for (const s of [
    "listings-runs",
    "runtime-operations",
    "projects-goal-measures",
    "shop-knowledge",
    "connection-health-work",
    "credits-only-catalogue",
  ])
    assert.ok(before(s).sequence < row.sequence, s);
  const chain = loadMigrationChain();
  assert.equal(chain.find((e) => e.sequence === row.sequence).executeAs, "morrow_work_owner");
});

test("the runner contract: one transaction, fixed prerequisites, pinned paths, no role or RLS escape", () => {
  assert.deepEqual(migrationSqlViolations(text), []);
  assert.match(text, /^BEGIN;\n/);
  assert.match(text, /\nCOMMIT;\n?$/);
  assert.match(text, /RAISE EXCEPTION 'AGENT_RUNS_PREREQUISITES_INVALID'/);
  for (const m of text.matchAll(/CREATE (?:OR REPLACE )?FUNCTION /g)) {
    const rest = text.slice(m.index);
    const header = rest.slice(0, rest.indexOf("$$"));
    assert.match(header, /SET search_path=pg_catalog/, header.slice(0, 80));
  }
  // Dynamic SQL only through format() over the fixed table lists.
  assert.doesNotMatch(sql, /\bEXECUTE\s+(?!format\(|FUNCTION\b|ON\b|'CREATE POLICY )/);
  assert.doesNotMatch(sql, /GRANT[^;]*\b(DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*ON/);
  assert.doesNotMatch(sql, /TO PUBLIC/);
  assert.doesNotMatch(sql, /CREATE ROLE|ALTER ROLE|GRANT morrow_[a-z_]+ TO/);
  assert.doesNotMatch(sql, /BYPASSRLS|NO FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL/);
  assert.doesNotMatch(sql, /schema_migrations|migration_history/i);
  // It changes no shared CHECK or table: run.admit and question.answer are recorded already.
  assert.doesNotMatch(sql, /ALTER TABLE morrow_work\.(commands|outbox_events|tasks|work_leases)/);
  // Nothing in the vault: the broker's turn fence is H7c's (plan row H7a).
  assert.doesNotMatch(sql, /morrow_vault\./);
  // CREATE on the schema only for the ownership transfer, revoked before the end.
  const grant = sql.indexOf("GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;");
  const revoke = sql.indexOf("REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;");
  assert.ok(grant > 0 && revoke > grant);
  assert.ok(
    sql
      .slice(grant, revoke)
      .split("\n")
      .slice(1, -1)
      .every((l) => /^(ALTER FUNCTION| text,|$)/.test(l)),
  );
});

test("ADR-0041 item 4's one data model: every table FORCE RLS, tenant policies from the session or the lease, no DELETE", () => {
  const created = [...sql.matchAll(/CREATE TABLE morrow_work\.([a-z_]+) \(/g)].map((m) => m[1]);
  assert.deepEqual(created, newTables);
  const loops = [...sql.matchAll(/FOREACH t IN ARRAY ARRAY\[([^\]]*)\] LOOP/g)].map((m) =>
    [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
  );
  // ENABLE + FORCE + the owner policy on all; the platform read on the four platform tables;
  // the session and lease templates on every tenant table; the api's read on runs and jobs;
  // the append-only triggers on all.
  assert.deepEqual(loops, [
    newTables,
    platformTables,
    tenantTables,
    ["agent_runs", "jobs"],
    newTables,
  ]);
  assert.match(
    sql,
    /EXECUTE format\('ALTER TABLE morrow_work\.%I ENABLE ROW LEVEL SECURITY',t\);\s+EXECUTE format\('ALTER TABLE morrow_work\.%I FORCE ROW LEVEL SECURITY',t\);/,
  );
  assert.match(
    sql,
    /CREATE POLICY tenant_command ON morrow_work\.%I TO morrow_work_command\s+USING \(\(organization_id::text,workspace_id::text\)=\(SELECT c\.organization_id,c\.workspace_id FROM morrow_work\.current_tenant\(\) c\)\)/,
  );
  assert.match(
    sql,
    /CREATE POLICY tenant_lease ON morrow_work\.%I TO morrow_work_command\s+USING \(\(organization_id::text,workspace_id::text\)=\(SELECT c\.organization_id,c\.workspace_id FROM morrow_work\.current_lease\(\) c\)\)/,
  );
  assert.match(sql, /CREATE TRIGGER append_only BEFORE DELETE ON morrow_work\.%I/);
  assert.match(sql, /CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work\.%I/);
  // Composite tenant keys on every tenant table.
  for (const t of tenantTables) {
    const body = tableBody(t);
    assert.match(
      body,
      /^ organization_id morrow_work\.record_id NOT NULL,\n workspace_id morrow_work\.record_id NOT NULL,/m,
      t,
    );
    assert.match(body, /PRIMARY KEY \(organization_id,workspace_id,/, t);
  }
  // The runtime login's cross-tenant reads are SELECT only, ids and codes of open rows.
  for (const [policy, table, filter] of [
    ["runtime_agent_open", "agent_runs", "status IN ('queued','running','waiting')"],
    ["runtime_wait_open", "run_waits", "state IN ('open','resolvable')"],
    ["runtime_upkeep_read", "upkeep_triggers", "state IN ('pending','admitted')"],
  ])
    assert.ok(
      sql.includes(
        `CREATE POLICY ${policy} ON morrow_work.${table} FOR SELECT TO morrow_work_command\n USING (session_user='morrow_runtime_executor' AND ${filter});`,
      ),
      policy,
    );
  // The only run lease the runtime definers insert: agent_lease_issuable's three shapes.
  assert.match(
    sql,
    /CREATE POLICY lease_agent_issue ON morrow_work\.work_leases FOR INSERT TO morrow_work_command\s+WITH CHECK \(session_user='morrow_runtime_executor' AND morrow_work\.agent_lease_issuable\(/,
  );
  // Every table and its parents are in the conformance registry, with the right content class.
  for (const t of newTables) assert.ok(workTables[t], t);
  for (const t of tenantTables) assert.equal(workTables[t].lease, true, t);
  assert.deepEqual(
    newTables.filter((t) => workTables[t].content === "workspace"),
    contentTables,
  );
  // The api reads only agent_runs and jobs, column by column: no manifest text, lease,
  // envelope, wait, taint, digest, request or command.
  const apiGrants = [
    ...sql.matchAll(/GRANT SELECT \(([^)]*)\)\s+ON morrow_work\.([a-z_]+) TO morrow_work_api;/g),
  ];
  assert.deepEqual(
    apiGrants.map((m) => m[2]),
    ["agent_runs", "jobs"],
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?!SELECT \(|EXECUTE ON FUNCTION morrow_work\.cmd_agent_run_admit\()[^;]*TO morrow_work_api;/,
  );
  const runColumns = apiGrants[0][1].split(",").map((c) => c.trim());
  for (const hidden of [
    "manifest_canonical",
    "manifest_digest",
    "lease_id",
    "envelope_id",
    "work_envelope_id",
    "hop_id",
    "wait_id",
    "taint",
    "read_tags",
    "safety",
    "request_digest",
    "command_id",
    "system_text_digest",
    "tools",
    "workflow_instance_id",
  ])
    assert.ok(!runColumns.includes(hidden), hidden);
  assert.ok(runColumns.includes("ended_reason") && runColumns.includes("credits_drawn"));
});

test("content lives only in the content tables; the rest is ids, codes, counts, digests and times", () => {
  // Text or JSON columns of a content-free table are ids, codes, digests, or metadata whose
  // CHECK bounds it to ids and codes (read tags, taint, audience, subjects, sections, notices,
  // the safety profile and policy, a wait's condition, an epoch's opening of references, the
  // detectors' ring and counters, the manifest proven to be the run's own columns).
  const metadata = new Set([
    "read_tags",
    "taint",
    "audience",
    "source_subjects",
    "section_tokens",
    "notices",
    "safety",
    "safety_template",
    "policy",
    "condition",
    "opening",
    "ring",
    "counters",
    "manifest_canonical",
    "tools",
    "contexts",
  ]);
  const codeLike =
    /_id$|_ids$|_key$|_kind$|_code$|^(code|kind|status|state|outcome|refusal|verb|replay_class|tool|provider|ended_reason|scope|origin|purpose|reason|mode|label|raw_stop_reason|source|next|validation_result|validation_code|change_kind|cache_ttl|resolution_lease_source|family|workflow_instance_id|parent_tool_use_id|tool_use_id|media_type)$/;
  for (const t of newTables.filter((x) => !contentTables.includes(x))) {
    const free = columns(t)
      .filter((c) => /^(text|jsonb|text\[\])$/.test(c.type))
      .map((c) => c.name)
      .filter((c) => !codeLike.test(c) && !metadata.has(c));
    assert.deepEqual(free, [], t);
  }
  // run_events: no JSON at all (ADR-0041 item 36).
  assert.ok(columns("run_events").every((c) => c.type !== "jsonb"));
  // The content columns, by table.
  const contentColumns = (t) =>
    columns(t)
      .filter((c) => /^(text|jsonb)$/.test(c.type))
      .map((c) => c.name)
      .filter((c) => !codeLike.test(c) && !metadata.has(c));
  assert.deepEqual(contentColumns("run_turns"), ["input", "output"]);
  assert.deepEqual(contentColumns("agent_run_questions"), ["question", "choices", "answer"]);
  assert.deepEqual(contentColumns("context_checkpoints"), ["summary", "block", "content"]);
  assert.deepEqual(contentColumns("run_plan_revisions"), ["plan"]);
  assert.deepEqual(contentColumns("teammate_results"), ["result"]);
  assert.deepEqual(contentColumns("result_items"), ["title", "columns"]);
  assert.deepEqual(contentColumns("result_item_pages"), ["content"]);
  // Derived content rows carry an audience and their source subjects (ADR-0041 item 25).
  for (const t of ["context_checkpoints", "run_plan_revisions", "teammate_results", "result_items"])
    for (const c of ["read_tags", "audience", "source_subjects", "taint"])
      assert.ok(
        columns(t).some((x) => x.name === c),
        t + "." + c,
      );
  // The manifest's trigger proves its canonical text is exactly the run's own columns.
  assert.match(
    fnBody("agent_run_guard"),
    /NOT morrow_work\.agent_manifest_matches\(NEW\.manifest_canonical,to_jsonb\(NEW\)\)/,
  );
  assert.match(
    tableBody("agent_runs"),
    /CONSTRAINT agent_runs_manifest CHECK \(manifest_digest::text=morrow_work\.sha256_text\(manifest_canonical\)\)/,
  );
});

test("CHECKs are safety ranges only (ADR-0041 Values): no turn, call, question, time or money limit", () => {
  // Turns 1 to 100,000 (a run's turns and its counter).
  assert.match(
    tableBody("run_turns"),
    /^ turn integer NOT NULL CHECK \(turn BETWEEN 1 AND 100000\),$/m,
  );
  assert.match(
    tableBody("agent_runs"),
    /turns_taken bigint NOT NULL CHECK \(turns_taken BETWEEN 0 AND 100000\)/,
  );
  // Tool calls per turn 1 to 64: ordinals 0 to 63 and at most 64 tool_use blocks in a reply.
  assert.match(
    tableBody("run_tool_calls"),
    /ordinal integer NOT NULL CHECK \(ordinal BETWEEN 0 AND 63\)/,
  );
  assert.match(fnBody("loop_assistant_message_valid"), /WHERE b->>'type'='tool_use'\)<=64/);
  // max_output_tokens up to 128,000; a call budget up to 1,800,000 ms.
  for (const t of ["agent_runs", "loop_catalogue_entries", "agent_model_calls"])
    assert.match(
      tableBody(t),
      /max_output_tokens integer NOT NULL CHECK \(max_output_tokens BETWEEN 1 AND 128000\)/,
      t,
    );
  for (const t of ["run_turns", "agent_model_calls"])
    assert.match(
      tableBody(t),
      /budget_ms integer NOT NULL CHECK \(budget_ms BETWEEN 1000 AND 1800000\)/,
      t,
    );
  assert.match(
    tableBody("agent_runs"),
    /call_budget_ms integer NOT NULL CHECK \(call_budget_ms BETWEEN 1000 AND 1800000\)/,
  );
  // A wait on a person lasts 1 to 365 days; any other at most 365 days.
  assert.match(
    tableBody("run_waits"),
    /WHEN kind IN \('question','checkin','detector','credits'\)\s+THEN lapses_at IS NOT NULL AND lapses_at BETWEEN opened_at\+interval '1 day' AND opened_at\+interval '365 days'/,
  );
  assert.match(
    fnBody("agent_safety_valid"),
    /\(p#>>'\{personWait,ms\}'\)::bigint NOT BETWEEN 86400000 AND 31536000000/,
  );
  // The stored message (384 KiB, ContextPolicy@1's storedMessageBytes) and the reply's own
  // stored size (H6's carry-forward N3): 4 MiB of jsonb text, twice replyStoredBytes' compact
  // JSON, so every reply replyFit lets through fits.
  assert.match(fnBody("loop_user_message_valid"), /octet_length\(p::text\)>393216/);
  assert.match(fnBody("loop_assistant_message_valid"), /octet_length\(p::text\)>4194304/);
  assert.equal(2 * replyStoredBytes, 4194304);
  for (const row of generatedContextPolicy.versions.flatMap((v) => v.rows))
    assert.equal(row.storedMessageBytes, 393216);
  // No limit column anywhere: no turn, tool-call, question or wall-time limit, no final turn,
  // no hold, booking or money cap (credits are the only budget, held by H8).
  const gone =
    /^ (turn_limit|max_turns_per_run|max_turns_per_coordinator_run|max_tool_calls_per_turn|max_tool_calls_per_run|max_questions_per_run|question_wait_hours|wall_time_minutes|wall_time_ms|max_input_tokens_per_turn|final|hold_usd|booked_usd|overflow_usd|worst_case_turn_usd|cost_usd|answer_by|deadline|run_cost_cap_usd|workspace_daily_cost_cap_usd) /m;
  for (const t of newTables) assert.doesNotMatch(tableBody(t), gone, t);
  // The credit columns of ADR-0039 PR 3 (whole credits; H8 fills them under the wallet's lock).
  for (const c of ["credits_held", "credits_drawn", "credits_refunded", "credits_absorbed"])
    assert.match(
      tableBody("agent_runs"),
      new RegExp(`^ ${c} bigint NOT NULL CHECK \\(${c} BETWEEN 0 AND 999999999999999999\\),$`, "m"),
      c,
    );
  for (const c of ["credits_held", "credits_drawn"])
    assert.match(tableBody("agent_model_calls"), new RegExp(`^ ${c} bigint CHECK`, "m"), c);
  // No definer writes a limit ending: the old limit reasons stay in the CHECKs' enums for old
  // records only, and no definer refuses or ends a run on a limit or on money.
  const bodies = [...sql.matchAll(/CREATE FUNCTION morrow_work\.([a-z_]+)\(/g)]
    .map((m) => m[1])
    .filter((name) => !name.endsWith("_valid"))
    .map((name) => fnBody(name))
    .join("\n");
  for (const reason of [
    "turn_limit",
    "tool_call_limit",
    "question_limit",
    "wall_time",
    "deadline",
    "credits_exhausted",
    "cost_budget",
    "budget_exhausted",
    "daily_backstop",
    "cap_below_turn",
    "unrecovered_cost_cap",
    "insufficient_credits",
  ])
    assert.ok(!bodies.includes(`'${reason}'`), reason);
});

test("the closed codes are H6's contracts (drift): end reasons, kinds, waits, events, notices, sources", () => {
  const same = (actual, name, label = name) => assert.deepEqual(actual, contractEnum(name), label);
  const runs = tableBody("agent_runs");
  same(inList(runs, "ended_reason"), "AgentRunEndReason");
  same(inList(runs, "kind"), "AgentRunKind");
  same(inList(runs, "purpose"), "AgentRunPurpose");
  same(inList(tableBody("agent_contexts"), "scope"), "ContextScope");
  same(inList(tableBody("context_epochs"), "kind"), "ContextEpochKind");
  same(inList(tableBody("run_turns"), "purpose"), "ModelCallPurpose", "run_turns.purpose");
  same(inList(tableBody("agent_model_calls"), "purpose"), "ModelCallPurpose", "model call purpose");
  same(inList(tableBody("run_turns"), "outcome"), "ModelTurnOutcome", "run_turns.outcome");
  same(inList(tableBody("agent_model_calls"), "outcome"), "ModelTurnOutcome", "model call outcome");
  same(inList(tableBody("run_tool_calls"), "outcome"), "ToolCallOutcome");
  same(inList(tableBody("run_tool_calls"), "refusal"), "ToolRefusalCode");
  const waits = tableBody("run_waits");
  same(inList(waits, "kind"), "RunWaitKind");
  same(inList(waits, "resolution_code"), "RunWaitResolution");
  assert.deepEqual(
    inList(waits, "resolvable_code"),
    contractEnum("RunWaitResolution").filter((c) => !["stopped", "lapsed", "released"].includes(c)),
  );
  same(inList(waits, "resolution_lease_source"), "LeaseSource");
  same(inList(tableBody("run_events"), "kind"), "RunEventKind");
  same(inList(tableBody("teammate_results"), "outcome"), "TeammateOutcome");
  same(inList(tableBody("teammate_results"), "next"), "TeammateNext");
  same(inList(tableBody("result_items"), "kind"), "ResultItemKind");
  same(inList(fnBody("harness_notices_valid"), "(n->>'code')"), "ModelNoticeCode");
  same(inList(fnBody("loop_user_message_valid"), "(b->>'kind')"), "ModelStateKind");
  // Every untrusted source list (data blocks, taint kinds, taint sources) is ModelUntrustedSource.
  same(inList(fnBody("loop_user_message_valid"), "(b->>'source')"), "ModelUntrustedSource");
  same(inList(fnBody("harness_derived_taint_valid"), "(k#>>'{}')"), "ModelUntrustedSource");
  same(inList(tableBody("run_taint_sources"), "source"), "ModelUntrustedSource");
  // A wait's condition names its own kind, for every kind.
  const condition = fnBody("run_wait_condition_valid");
  for (const kind of contractEnum("RunWaitKind")) assert.ok(condition.includes(`'${kind}'`), kind);
});

test("catalogues, the safety template and the context policy are the generated data (drift), all proposed", () => {
  // Loop catalogue version 2: the generated digest, proposed, no limit or money column, and
  // AgentRunSafety@1's template (without the entry's max_tokens) in place of AgentRunCaps.
  const v = generatedLoopCatalogue.versions.find((x) => x.version === 2);
  assert.equal(v.status, "proposed");
  assert.equal(generatedLoopCatalogue.activeVersion, null);
  assert.deepEqual(
    columns("loop_catalogue_versions").map((c) => c.name),
    [
      "version",
      "status",
      "digest",
      "safety_profile_version",
      "safety_template",
      "safety_template_digest",
    ],
  );
  const version =
    /SELECT 2,'proposed','([a-f0-9]{64})',1,t::jsonb,morrow_work\.sha256_text\(t\)\nFROM \(VALUES \('(\{[^']*\})'\)\) v\(t\);/.exec(
      sql,
    );
  assert.ok(version);
  assert.equal(version[1], v.digest);
  assert.equal(version[2], canonicalJson(runSafetyProfile1));
  assert.deepEqual(JSON.parse(version[2]), JSON.parse(JSON.stringify(runSafetyProfile1)));
  assert.match(
    tableBody("loop_catalogue_versions"),
    /morrow_work\.agent_safety_valid\(morrow_work\.agent_safety_compose\(safety_template,1\)\)/,
  );
  // The models and efforts, rates in 10^-12 USD per token (metering's prices, never a cap).
  const models = [
    ...sql.matchAll(
      /\('(claude_[a-z0-9_]+)','([a-z0-9-]+)',([0-9]+)(?:::bigint)?,([0-9]+)(?:::bigint)?,([0-9]+)(?:::bigint)?,([0-9]+)(?:::bigint)?,[0-9]\)/g,
    ),
  ].map((m) => ({
    key: m[1],
    providerModelId: m[2],
    usd12PerToken: {
      input: Number(m[3]),
      output: Number(m[4]),
      cacheWrite: Number(m[5]),
      cacheRead: Number(m[6]),
    },
  }));
  assert.deepEqual(
    models,
    v.models.map((m) => ({
      key: m.key,
      providerModelId: m.providerModelId,
      usd12PerToken: m.usd12PerToken,
    })),
  );
  const efforts = [...sql.matchAll(/\('(low|medium|high)',([0-9]+),[0-9]\)/g)].map((m) => [
    m[1],
    Number(m[2]),
  ]);
  assert.deepEqual(
    efforts,
    v.efforts.map((e) => [e.key, e.maxOutputTokens]),
  );
  // ToolCatalogue@1 version 4: each tool's family, pair, replay class and contexts.
  const tools = [
    ...sql.matchAll(
      /\(([0-9]+),'([a-z.]+)','([a-z]+)',(?:'([a-z._]+)'|NULL),(?:'([a-z]+)'|NULL),'([a-z_]+)',ARRAY\[([^\]]*)\]\)/g,
    ),
  ].map((m) => ({
    version: Number(m[1]),
    name: m[2],
    family: m[3],
    capabilityId: m[4] ?? null,
    verb: m[5] ?? null,
    replayClass: m[6],
    contexts: [...m[7].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
  }));
  assert.deepEqual(
    tools,
    generatedToolCatalogue.tools.map((t) => ({
      version: generatedToolCatalogue.version,
      name: t.name,
      family: t.family,
      capabilityId: t.capabilityId,
      verb: t.verb,
      replayClass: t.replayClass,
      contexts: [...t.contexts],
    })),
  );
  // The harness and memory tools grant nothing; no tool has an external effect.
  for (const t of tools) {
    assert.equal(["memory", "harness"].includes(t.family), t.capabilityId === null, t.name);
    assert.ok(
      t.verb === null || ["view", "propose", "execute", "delegate"].includes(t.verb),
      t.name,
    );
  }
  // ContextPolicy@1 version 1: every generated row, its digest the SHA-256 of its RFC 8785
  // text, which SQL recomputes in its CHECK; proposed, so admission takes none.
  const policyRows = [
    ...sql.matchAll(
      /\(1,'(claude_[a-z0-9_]+)','([a-z]+)','(proposed|active|retired)','(\{[^']*\})'\)/g,
    ),
  ];
  const generated = generatedContextPolicy.versions.find((x) => x.version === 1);
  assert.equal(generated.status, "proposed");
  assert.equal(generatedContextPolicy.activeVersion, null);
  assert.deepEqual(
    policyRows.map((m) => [m[1], m[2], m[3]]),
    generated.rows.map((r) => [r.model, r.effort, "proposed"]),
  );
  for (const [i, m] of policyRows.entries()) {
    const { digest, ...policy } = generated.rows[i];
    assert.equal(m[4], canonicalJson(policy), m[1] + m[2]);
    assert.equal(sha(m[4]), digest, m[1] + m[2]);
  }
  assert.match(
    tableBody("context_policy_versions"),
    /digest::text=morrow_work\.sha256_text\(morrow_work\.harness_jcs\(policy\)\)/,
  );
  // Admission takes only active rows of each.
  const admit = fnBody("cmd_agent_run_admit");
  assert.ok(
    admit.includes(
      "FROM morrow_work.loop_catalogue_versions y WHERE y.version=p_catalogue_version::integer AND y.status='active'",
    ),
  );
  assert.ok(
    admit.includes("AND x.model_key=p_model AND x.effort_key=p_effort AND x.status='active'"),
  );
});

test("definers: command-owned, explicit ACLs, ids only; the runtime definers executable only by the runtime login", () => {
  // Every function has its PUBLIC revoke and is registered with its kind and grantees.
  const looped = new Set(
    [...sql.matchAll(/p\.proname IN \(([^)]*)\)/g)].flatMap((m) =>
      [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    ),
  );
  for (const [, name] of sql.matchAll(/CREATE FUNCTION morrow_work\.([a-z_]+)\(/g)) {
    assert.ok(looped.has(name), name);
    assert.ok(
      Object.keys(workFunctions).some((k) => k.startsWith(name + "(")),
      name,
    );
  }
  // The runtime definers and entry lookups: SECURITY DEFINER, owned by the command role,
  // EXECUTE for morrow_runtime_executor alone (one GRANT), ids and codes in, ids and codes out.
  const runtimeGrant = /GRANT EXECUTE ON FUNCTION ([^;]*) TO morrow_runtime_executor;/.exec(sql)[1];
  const granted = [...runtimeGrant.matchAll(/morrow_work\.([a-z_]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(granted, [...runtimeDefiners, ...entryLookups].sort());
  assert.equal(sql.split("TO morrow_runtime_executor;").length, 2);
  for (const name of [...runtimeDefiners, ...entryLookups]) {
    const fn = fnBody(name);
    assert.match(fn, /SECURITY DEFINER/, name);
    assert.match(
      sql,
      new RegExp(`ALTER FUNCTION morrow_work\\.${name}\\([^)]*\\) OWNER TO morrow_work_command;`),
      name,
    );
    const params = fn.slice(fn.indexOf("(") + 1, fn.indexOf(")"));
    assert.match(params, /^(p_[a-z_]+ text)?(,p_[a-z_]+ text)*$/, name);
    assert.doesNotMatch(params, /jsonb|principal|membership|actor|role|sql|lease_id/, name);
    const registered = Object.entries(workFunctions).find(([k]) => k.startsWith(name + "("))[1];
    assert.deepEqual(registered.grantees, ["morrow_runtime_executor"], name);
    assert.equal(registered.kind, "runtime", name);
    assert.ok(
      executorLogins.morrow_runtime_executor.some((f) => f.startsWith("morrow_work." + name + "(")),
      name,
    );
  }
  // Those that take no tenant find their run only through the entered run lease
  // (agent_run_entered, which also takes the run's lock); those that name a tenant check the
  // runtime login and refuse inside a session or a lease.
  for (const name of ["agent_run_lease_renew", "agent_run_segment_roll", "agent_run_start"])
    assert.match(fnBody(name), /FROM morrow_work\.agent_run_entered\(\)/, name);
  for (const name of ["agent_run_resume", "admit_upkeep_run"]) {
    const fn = fnBody(name);
    assert.match(fn, /work_executor_safe\('morrow_runtime_executor'\)/, name);
    assert.match(fn, /current_setting\('morrow\.work_session_digest',true\),''\)<>''/, name);
    assert.match(fn, /current_setting\('morrow\.work_lease_id',true\),''\)<>''/, name);
    assert.deepEqual(
      workFunctions[Object.keys(workFunctions).find((k) => k.startsWith(name + "("))]
        .tenantParameters,
      ["p_organization_id", "p_workspace_id"],
    );
  }
  // The cross-tenant lists are STABLE: they read and never write or issue a lease.
  for (const name of ["agent_run_wake_candidates", "agent_run_pending_starts"]) {
    const fn = fnBody(name);
    assert.match(fn, /LANGUAGE plpgsql STABLE SECURITY DEFINER/, name);
    assert.doesNotMatch(fn, /INSERT|UPDATE|lease_open|enter_lease/, name);
    assert.ok(workFunctions[name + "()"].crossTenant, name);
  }
  // The api's two commands, a person's act: EXECUTE for the api alone.
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION morrow_work\.cmd_agent_run_admit\([a-z,\s]*\),\s+morrow_work\.cmd_agent_run_answer\(text,text,text,text,text\) TO morrow_work_api;/,
  );
  assert.deepEqual(
    workFunctions[Object.keys(workFunctions).find((k) => k.startsWith("cmd_agent_run_admit("))]
      .grantees,
    ["morrow_work_api"],
  );
  // The api's statement sends exactly the definer's parameters.
  const admitParams = fnBody("cmd_agent_run_admit")
    .match(/\(([^)]*)\)\nRETURNS/)[1]
    .split(",").length;
  assert.equal(admitParams, 24);
  assert.equal(loopStatements.cmdAgentRunAdmit.split("$").length - 1, admitParams);
});

test("the PR 11 step definers and the broker's fence are gone: H7b's runner and H7c's broker replace them", () => {
  // The PR 11 runner's statements name definers this migration does not create (it stays off
  // the reachable path: the agent-loop switch's harness_runner prerequisite), except its start
  // and its two lookups, which keep their shapes.
  const created = new Set(
    [...sql.matchAll(/CREATE FUNCTION morrow_work\.([a-z_]+)\(/g)].map((m) => m[1]),
  );
  const named = Object.fromEntries(
    Object.entries(agentRunSql).map(([k, s]) => [k, /FROM morrow_work\.([a-z_]+)\(/.exec(s)[1]]),
  );
  assert.deepEqual(
    Object.entries(named)
      .filter(([, fn]) => created.has(fn))
      .map(([k]) => k)
      .sort(),
    ["pendingStarts", "resumeLease", "start"],
  );
  assert.deepEqual(
    Object.values(named)
      .filter((fn) => !created.has(fn))
      .sort(),
    [
      "agent_question_ask",
      "agent_run_answers",
      "agent_run_conversation",
      "agent_run_finish",
      "agent_run_objective",
      "agent_run_state",
      "agent_run_wait",
      "agent_tool_call_begin",
      "agent_tool_call_finish",
      "agent_turn_open",
      "agent_turn_settle",
    ],
  );
  for (const fn of [
    "agent_runs_close_stale",
    "agent_turn_close_uncertain",
    "agent_turn_begin",
    "agent_turn_end",
  ])
    assert.ok(!sql.includes(fn), fn);
  // The broker's vault statements name a fence no migration creates.
  const vault = readFileSync("apps/broker/src/vault-statements-model.ts", "utf8");
  assert.match(vault, /morrow_vault\.agent_turn_begin\(/);
  for (const file of manifest.migrations.map((m) => m.file))
    assert.ok(
      !readFileSync("migrations/" + file, "utf8").includes(
        "FUNCTION morrow_vault.agent_turn_begin(",
      ),
      file,
    );
});

test("admission is a person's act: the safety profile and pins derived in SQL, no limit or money refusal", () => {
  const admit = fnBody("cmd_agent_run_admit");
  for (const piece of [
    "morrow_work.command_prelude(p_command_id,p_request_digest)",
    "'catalogue_inactive'",
    "'entry_not_offered'",
    "'version_unknown'",
    "v_safety:=morrow_work.agent_safety_compose(v.safety_template,e.max_output_tokens);",
    "subscription_key !~ '^morrow:operator_entitlement:'",
    "'no_billing_period'",
    "morrow_work.lease_open('run',p_run_id,p_store_id,s.connection_id,i.id)",
    "morrow_work.stop_active(",
    "'routed'=ANY(t.contexts)",
    "morrow_work.loop_tool_fields(v_tools)",
    "'run.admitted','person_act'",
    // The job envelope: 7 days and 24 hours active from now (the safety profile's).
    "v_admitted+(v_safety#>>'{envelope,wallMs}')::bigint*interval '1 millisecond'",
    // Segment 1, incarnation 1, its instance id.
    "p_run_id||'-s1-i1'",
  ])
    assert.ok(admit.includes(piece), piece);
  for (const gone of [
    "turn_limit",
    "hold",
    "worst_case",
    "daily",
    "unrecovered",
    "wall_time",
    "agent_runs_close_stale",
  ])
    assert.ok(!admit.includes(gone), gone);
  // It writes the job, its context (one writer, one per job and agent), the run and segment 1.
  for (const table of ["jobs", "agent_contexts", "agent_runs", "run_segments"])
    assert.ok(admit.includes("INSERT INTO morrow_work." + table + "("), table);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX agent_runs_one_writer ON morrow_work\.agent_runs \(organization_id,workspace_id,context_id\)\s+WHERE status IN \('queued','running','waiting'\);/,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX agent_contexts_one_per_job_agent ON morrow_work\.agent_contexts/,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX run_waits_one_open ON morrow_work\.run_waits \(organization_id,workspace_id,run_id\) WHERE state IN \('open','resolvable'\);/,
  );
  // Only routed and upkeep runs are written here: mandate, call, review, coordinator (forks)
  // and standing-request runs are admitted by later rows' definers (H10, H11, H17, ADR-0024's).
  const kinds = [
    ...sql.matchAll(
      /INSERT INTO morrow_work\.agent_runs\([^)]*\)\s+VALUES \([^,]*,[^,]*,[^,]*,1,'([a-z]+)'/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(kinds.sort(), ["routed", "upkeep"]);
  for (const fn of [
    "admit_mandate_agent_run",
    "admit_standing_request_run",
    "agent_call_admit",
    "admit_review_run",
  ])
    assert.ok(!sql.includes(fn), fn);
  // source_inbox_id and conversation_id land without their foreign keys: P07.T03's
  // conversations and conversation_inbox have not landed (plan row H4).
  assert.match(tableBody("agent_runs"), /^ source_inbox_id morrow_work\.record_id,$/m);
  assert.doesNotMatch(sql, /REFERENCES morrow_work\.(conversations|conversation_inbox|messages)/);
});

test("ADR-0041 item 7's lease sources: renewal, wait resolution, upkeep admission, the sweep, the answer", () => {
  // Per-step renewal: superseded first (no write), admission's checks again, the envelope's
  // expiry checks the run in, any other failure ends it; a new lease <run>:l<n>; the entered
  // one released.
  const renew = fnBody("agent_run_lease_renew");
  const order = [
    "'superseded'",
    "morrow_work.agent_run_admission_check(e.organization_id,e.workspace_id,e.run_id,false)",
    "IF v_reason='envelope_expired' THEN",
    '\'checkin\',\'{"kind":"checkin","code":"envelope"}\'::jsonb',
    "morrow_work.agent_run_end(e.organization_id,e.workspace_id,e.run_id,'cancelled',v_reason)",
    "e.run_id||':l'||(r.lease_renewals+1)",
    "v_end:=morrow_work.lease_release();",
  ].map((p) => renew.indexOf(p));
  assert.ok(
    order.every((i) => i > 0),
    JSON.stringify(order),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  // Wait resolution: never a question; refused with no write past the envelope; the lease
  // entered, then admission's checks, then the wait resolved with its lease source.
  const resume = fnBody("agent_run_resume");
  const steps = [
    "w.kind='question' THEN NULL",
    "RETURN QUERY SELECT 'envelope_expired'",
    "INSERT INTO morrow_work.work_leases",
    "morrow_work.enter_lease(v_lease,'1')",
    "morrow_work.agent_run_admission_check(p_organization_id,p_workspace_id,p_run_id,false)",
    "resolution_lease_source='wait_resume'",
  ].map((p) => resume.indexOf(p));
  assert.ok(
    steps.every((i) => i > 0),
    JSON.stringify(steps),
  );
  assert.deepEqual(
    [...steps].sort((a, b) => a - b),
    steps,
  );
  // Upkeep admission: one pending trigger, the requester's lease entered first, the upkeep
  // tool set fixed in SQL, the trigger skipped when the agent is no longer active.
  const upkeep = fnBody("admit_upkeep_run");
  for (const piece of [
    "'admitted_before'",
    "v_run||':u:'||p_trigger_id",
    "ARRAY['notebook.write','memory.search','memory.read','run.complete']",
    "ARRAY['memory.read','run.complete']",
    "SET state='skipped'",
    "'run.admitted','upkeep_admission'",
  ])
    assert.ok(upkeep.includes(piece), piece);
  assert.match(sql, /CREATE UNIQUE INDEX upkeep_triggers_one_open ON morrow_work\.upkeep_triggers/);
  // The sweep lists one action per open run and issues no lease: resume, check_in, lapse,
  // close_lapsed (a lease expired unrenewed) and wake (only while the lease is unexpired).
  const sweep = fnBody("agent_run_wake_candidates");
  for (const action of ["'lapse'", "'check_in'", "'resume'", "'close_lapsed'", "'wake'"])
    assert.ok(sweep.includes(action), action);
  assert.match(
    sweep,
    /a\.status='running' AND a\.lease_expires_at>pg_catalog\.clock_timestamp\(\)/,
  );
  // The requester's answer: a person's act that resumes the run and renews its envelope.
  const answer = fnBody("cmd_agent_run_answer");
  for (const piece of [
    "morrow_work.agent_run_admission_check(p.organization_id,p.workspace_id,r.id,true)",
    "morrow_work.lease_open('run',r.id||':w'||w.wait_sequence",
    "resolution_lease_source='person_act'",
    "envelope_active_base_ms=x.active_ms",
  ])
    assert.ok(answer.includes(piece), piece);
  // Segment rolls: <run>-s<segment+1>-i<incarnation>, replay-safe, another incarnation superseded.
  const roll = fnBody("agent_run_segment_roll");
  for (const piece of [
    "'rolled_before'",
    "'superseded'",
    "e.run_id||'-s'||v_next||'-i'||r.incarnation",
  ])
    assert.ok(roll.includes(piece), piece);
  assert.match(
    tableBody("agent_runs"),
    /CHECK \(workflow_instance_id=id::text\|\|'-s'\|\|segment\|\|'-i'\|\|incarnation\)/,
  );
  // Admission's checks: the member, the envelope, stops, the installation and release, the
  // tasks and the delegation envelope and hop.
  const check = fnBody("agent_run_admission_check");
  for (const piece of [
    "morrow_identity.work_lease_member_current(",
    "'envelope_expired'",
    "morrow_work.stop_active(",
    "x.status='published'",
    "'task_closed'",
    "FROM morrow_work.work_envelopes x",
    "FROM morrow_work.delegation_hops x",
  ])
    assert.ok(check.includes(piece), piece);
});

test("retention: content on its epoch's 90-day clock, content-free records 365 days", () => {
  for (const t of [
    "context_checkpoints",
    "run_turns",
    "run_plan_revisions",
    "teammate_results",
    "result_items",
    "result_item_pages",
  ])
    assert.match(tableBody(t), /expires_at>=created_at\+interval '90 days'/, t);
  assert.match(
    tableBody("agent_run_questions"),
    /CHECK \(expires_at>=created_at\+interval '90 days'\)/,
  );
  assert.match(
    fnBody("agent_run_question_guard"),
    /NEW\.expires_at<>NEW\.created_at\+interval '90 days'/,
  );
  assert.match(tableBody("context_epochs"), /expires_at>=closed_at\+interval '90 days'/);
  for (const [t, clock] of [
    ["run_tool_calls", "expires_at=started_at+interval '365 days'"],
    ["run_waits", "expires_at=opened_at+interval '365 days'"],
    ["run_events", "expires_at=at+interval '365 days'"],
    ["run_segments", "expires_at=started_at+interval '365 days'"],
    ["run_taint_sources", "expires_at=joined_at+interval '365 days'"],
    ["run_memory_reads", "expires_at=read_at+interval '365 days'"],
    ["upkeep_triggers", "expires_at=created_at+interval '365 days'"],
    ["run_detector_state", "expires_at>=updated_at+interval '365 days'"],
    ["jobs", "expires_at=ended_at+interval '365 days'"],
    ["agent_calls", "expires_at=ended_at+interval '365 days'"],
  ])
    assert.ok(tableBody(t).includes(clock), t);
  // Thinking goes when it stops being sent: a turn's reply may lose only its reasoning blocks.
  assert.match(fnBody("run_turn_guard"), /WHERE b->>'type'<>'reasoning'/);
});

test("the agent-loop switch record is committed off with every prerequisite unrecorded, harness_runner among them", () => {
  const record = JSON.parse(readFileSync("docs/decisions/agent-loop-staging.json", "utf8"));
  assert.equal(record.switch, "off");
  assert.equal(record.workflow, "agent-run@1");
  assert.deepEqual(Object.keys(record.prerequisites).sort(), [...agentLoopPrerequisites].sort());
  assert.ok(agentLoopPrerequisites.includes("harness_runner"));
  assert.ok(Object.values(record.prerequisites).every((p) => p === null));
  assert.match(record.scope, /harness_runner: plan row H7b's runner/);
});
