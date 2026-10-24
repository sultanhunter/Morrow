// Build order PR 11 (ADR-0027): static checks of the agent-runs migration (located by slug,
// never by number: integration renumbers it), its manifest row, the runner contract, FORCE
// RLS on every new table, the content classes (ids and codes in the run, its tool calls and
// the broker's fence; content only in run_turns and the questions), explicit per-function
// ACLs, the catalogue v2 and ToolCatalogue rows against the generated data (drift), the
// retention CHECKs, the conformance registry and the switch record. The behaviour is proved
// against PostgreSQL 17 by lab:agent-loop and lab:tenant-conformance.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import { loadMigrationChain } from "../scripts/migration-chain.mjs";
import { agentLoopPrerequisites } from "../scripts/generate-agent-platform.mjs";
import {
  executorLogins,
  vaultFunctions,
  workFunctions,
  workTables,
} from "./tenant-conformance/registry.mjs";
import { generatedLoopCatalogue } from "../packages/policy/src/generated/loop-catalogue.ts";
import { generatedToolCatalogue } from "../packages/policy/src/generated/tool-catalogue.ts";
import { loopEntries } from "../packages/policy/src/loop-catalogue.ts";
import { routedRunCaps } from "../packages/work/src/loop/admission.ts";
import { agentRunSql } from "../packages/work/src/loop/steps.ts";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const code = (text) => text.replace(/--.*$/gm, "");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const slug = "agent-runs";
const row = manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const text = readFileSync("migrations/" + row.file, "utf8");
const sql = code(text);
const newTables = [
  "loop_catalogue_versions",
  "loop_catalogue_entries",
  "tool_catalogue_entries",
  "agent_runs",
  "run_turns",
  "run_tool_calls",
  "agent_model_calls",
  "agent_run_questions",
];
const tableBody = (name) => {
  const start = sql.indexOf("CREATE TABLE morrow_work." + name + " (");
  assert.ok(start >= 0, name);
  return sql.slice(start, sql.indexOf("\n);", start));
};
const fnBody = (schema, name) => {
  const start = sql.indexOf(`CREATE FUNCTION ${schema}.${name}(`);
  assert.ok(start >= 0, name);
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2);
};

test("manifest: the last row, executeAs the work owner, its brief and digest, no prerequisites", () => {
  assert.ok(row);
  assert.equal(row.file, String(row.sequence).padStart(4, "0") + "." + slug + ".sql");
  assert.equal(row, manifest.migrations.at(-1));
  assert.deepEqual(
    [row.executeAs, row.reviewRef],
    ["morrow_work_owner", "docs/briefs/t4-agent-loop.md"],
  );
  assert.equal(row.sha256, sha(text));
  assert.equal(row.prerequisites, undefined);
  const before = (s) => manifest.migrations.find((m) => m.file.endsWith("." + s + ".sql"));
  for (const s of ["listings-runs", "runtime-operations", "projects-goal-measures"])
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
  // It changes no shared CHECK: run.admit and question.answer are recorded already.
  assert.doesNotMatch(sql, /ALTER TABLE morrow_work\.(commands|outbox_events|tasks)/);
  // CREATE on the schemas only for the ownership transfer, revoked before the end.
  const grant = sql.indexOf(
    "GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;",
  );
  const revoke = sql.indexOf(
    "REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;",
  );
  assert.ok(grant > 0 && revoke > grant);
  assert.ok(
    sql
      .slice(grant, revoke)
      .split("\n")
      .slice(1, -1)
      .every((l) => /^ ?(ALTER FUNCTION|text\)|$)/.test(l.trim()) || l.startsWith(" text")),
  );
});

test("FORCE RLS on every new table, tenant policies from the session or the lease, no DELETE", () => {
  const created = [...sql.matchAll(/CREATE TABLE morrow_work\.([a-z_]+) \(/g)].map((m) => m[1]);
  assert.deepEqual(created, newTables);
  const loop =
    /FOREACH t IN ARRAY ARRAY\[([^\]]*)\] LOOP\s+EXECUTE format\('ALTER TABLE morrow_work\.%I ENABLE ROW LEVEL SECURITY',t\);\s+EXECUTE format\('ALTER TABLE morrow_work\.%I FORCE ROW LEVEL SECURITY',t\);/.exec(
      sql,
    );
  assert.deepEqual(
    [...loop[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    newTables,
  );
  assert.match(
    sql,
    /CREATE POLICY tenant_command ON morrow_work\.%I TO morrow_work_command\s+USING \(\(organization_id::text,workspace_id::text\)=\(SELECT c\.organization_id,c\.workspace_id FROM morrow_work\.current_tenant\(\) c\)\)/,
  );
  assert.match(
    sql,
    /CREATE POLICY tenant_lease ON morrow_work\.%I TO morrow_work_command\s+USING \(\(organization_id::text,workspace_id::text\)=\(SELECT c\.organization_id,c\.workspace_id FROM morrow_work\.current_lease\(\) c\)\)/,
  );
  // The broker's policies need its own login and its own transaction-local setting.
  for (const name of ["broker_agent_run", "broker_agent_turn", "broker_agent_call"])
    assert.match(
      sql,
      new RegExp(
        `CREATE POLICY ${name} ON morrow_work\\.[a-z_]+ TO morrow_work_command\\s+USING \\(session_user=''morrow_vault_broker'' AND`,
      ),
      name,
    );
  // Append-only: no DELETE or TRUNCATE on any new table, and no grant of either.
  assert.match(
    sql,
    /FOREACH t IN ARRAY ARRAY\['loop_catalogue_versions','loop_catalogue_entries','tool_catalogue_entries','agent_runs','run_turns','run_tool_calls',\s*'agent_model_calls','agent_run_questions'\] LOOP\s+EXECUTE format\('CREATE TRIGGER append_only BEFORE DELETE/,
  );
  assert.match(sql, /CREATE TRIGGER no_truncate BEFORE TRUNCATE/);
  // The api reads only agent_runs, column by column: no manifest text, lease, envelope, hop,
  // digest, request or command; nothing of the turns, calls, fence or questions.
  const apiGrants = [
    ...sql.matchAll(/GRANT ([^;]*?) ON morrow_work\.([a-z_]+) TO morrow_work_api;/g),
  ];
  assert.deepEqual(
    apiGrants.map((m) => m[2]),
    ["agent_runs"],
  );
  const columns = /SELECT \(([^)]*)\)/
    .exec(apiGrants[0][1])[1]
    .split(",")
    .map((c) => c.trim());
  for (const hidden of [
    "manifest_canonical",
    "manifest_digest",
    "lease_id",
    "envelope_id",
    "hop_id",
    "prefix_digest",
    "request_digest",
    "command_id",
    "system_text_digest",
    "tools",
  ])
    assert.ok(!columns.includes(hidden), hidden);
  assert.ok(columns.includes("hold_usd") && columns.includes("ended_reason"));
});

test("content lives only in run_turns and the questions; the rest is ids, digests, codes and amounts", () => {
  // Free text or JSON columns, per table.
  const free = (name) =>
    [...tableBody(name).matchAll(/^ ([a-z_]+) (jsonb|text)\b/gm)]
      .map((m) => m[1])
      .filter(
        (c) =>
          !/_id$|_key$|^(kind|status|outcome|refusal|verb|replay_class|tool|provider|ended_reason|release_id|record_kind|tools|raw_stop_reason|provider_model_id|provider_request_id|tool_use_id|capability_id|effort_key|model_key)$/.test(
            c,
          ),
      );
  assert.deepEqual(free("agent_runs"), ["manifest_canonical"]);
  assert.deepEqual(free("run_tool_calls"), []);
  assert.deepEqual(free("agent_model_calls"), []);
  assert.deepEqual(free("run_turns"), ["input", "output", "tool_results", "read_tags"]);
  assert.deepEqual(free("agent_run_questions"), ["question", "choices", "answer"]);
  // The manifest's CHECK proves its canonical text is exactly the run's own columns.
  assert.match(
    tableBody("agent_runs"),
    /CONSTRAINT agent_runs_manifest CHECK \(manifest_digest::text=morrow_work\.sha256_text\(manifest_canonical\)\s+AND morrow_work\.agent_manifest_matches\(/,
  );
  // Retention (ADR-0031 item 1): turns 90 days after the run ends (at least 90 after made),
  // tool calls 365 days; the run end strips reasoning blocks.
  assert.match(tableBody("run_turns"), /expires_at>=created_at\+interval '90 days'/);
  assert.match(tableBody("run_tool_calls"), /expires_at=started_at\+interval '365 days'/);
  const end = fnBody("morrow_work", "agent_run_end");
  assert.match(end, /WHERE b->>'type'<>'reasoning'/);
  assert.match(end, /expires_at=greatest\(t\.expires_at,v_now\+interval '90 days'\)/);
  // A question's answer by: 72 hours.
  assert.match(tableBody("agent_run_questions"), /answer_by=created_at\+interval '72 hours'/);
  // The read definers return content inside a step only, to the runtime login alone.
  for (const name of ["agent_run_objective", "agent_run_conversation", "agent_run_answers"])
    assert.ok(workFunctions[name + "()"].grantees.join() === "morrow_runtime_executor", name);
});

test("catalogue v2 in SQL is the generated catalogue's, committed proposed (drift)", () => {
  const v = generatedLoopCatalogue.versions.find((x) => x.version === 2);
  assert.equal(v.status, "proposed");
  assert.equal(generatedLoopCatalogue.activeVersion, null);
  const versionRow =
    /VALUES \(2,'proposed','([a-f0-9]{64})',([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9.]+),([0-9.]+),([0-9.]+)\);/.exec(
      sql,
    );
  assert.ok(versionRow);
  const usd12 = (t) => {
    const [w, f = ""] = t.split(".");
    return BigInt(w) * 10n ** 12n + BigInt(f.padEnd(12, "0"));
  };
  const l = v.limits;
  assert.deepEqual(
    [
      versionRow[1],
      ...versionRow.slice(2, 10).map(Number),
      ...versionRow.slice(10).map((t) => usd12(t)),
    ],
    [
      v.digest,
      l.maxInputTokensPerTurn,
      l.maxTurnsPerRun,
      l.maxTurnsPerCoordinatorRun,
      l.maxToolCallsPerTurn,
      l.maxToolCallsPerRun,
      l.maxQuestionsPerRun,
      l.questionWaitHours,
      l.wallTimeMinutes,
      BigInt(l.runCostCapUsd12),
      BigInt(l.workspaceDailyCostCapUsd12),
      BigInt(l.workspacePeriodUnrecoveredCostCapUsd12),
    ],
  );
  // The models and efforts, rates in 10^-12 USD per token, the worst case rounded up.
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
  assert.match(
    sql,
    /ceil\(\(64000::numeric\*m\.cache_write\+e\.max_output_tokens::numeric\*m\.output\)\/10000\)\/100000000/,
  );
  // No xhigh or max (ADR-0027 item 12); nine entries; every call budget within 600 s.
  assert.equal(loopEntries(2).length, 9);
  assert.ok(loopEntries(2).every((e) => e.callBudgetMs <= 600_000));
  // The SQL worst case equals the code's for every entry (what admission compares).
  for (const e of loopEntries(2)) {
    const m = models.find((x) => x.key === e.model).usd12PerToken;
    const units = 64000n * BigInt(m.cacheWrite) + BigInt(e.maxOutputTokens) * BigInt(m.output);
    const u8 = (units + 9_999n) / 10_000n;
    assert.equal(
      routedRunCaps(e).worstCaseTurnUsd,
      `${u8 / 100_000_000n}.${String(u8 % 100_000_000n).padStart(8, "0")}`,
    );
  }
});

test("ToolCatalogue rows in SQL are the generated catalogue's: pairs, replay classes, contexts", () => {
  const rows = [
    ...sql.matchAll(
      /\(([0-9]+),'([a-z.]+)','([a-z._]+)','([a-z]+)','([a-z_]+)',ARRAY\[([^\]]*)\]\)/g,
    ),
  ].map((m) => ({
    version: Number(m[1]),
    name: m[2],
    capabilityId: m[3],
    verb: m[4],
    replayClass: m[5],
    contexts: [...m[6].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
  }));
  assert.deepEqual(
    rows,
    generatedToolCatalogue.tools.map((t) => ({
      version: generatedToolCatalogue.version,
      name: t.name,
      capabilityId: t.capabilityId,
      verb: t.verb,
      replayClass: t.replayClass,
      contexts: [...t.contexts],
    })),
  );
  // No tool has an external effect: the store change is a proposal for the gateway.
  for (const r of rows)
    assert.ok(["view", "propose", "execute", "delegate"].includes(r.verb), r.name);
});

test("definers: command-owned, explicit ACLs, ids only; the runtime lookups and the broker's fence", () => {
  // Every function has its PUBLIC revoke (in the ACL loop or by name).
  const looped = new Set(
    [...sql.matchAll(/p\.proname IN \(([^)]*)\)/g)].flatMap((m) =>
      [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    ),
  );
  for (const [, schema, name] of sql.matchAll(/CREATE FUNCTION ([a-z_]+)\.([a-z_]+)\(/g))
    assert.ok(
      looped.has(name) || new RegExp(`REVOKE ALL ON FUNCTION ${schema}\\.${name}\\(`).test(sql),
      name,
    );
  // Every new function is registered with its kind and grantees.
  for (const [, schema, name] of sql.matchAll(/CREATE FUNCTION ([a-z_]+)\.([a-z_]+)\(/g)) {
    const registry = schema === "morrow_vault" ? vaultFunctions : workFunctions;
    assert.ok(
      Object.keys(registry).some((k) => k.startsWith(name + "(")),
      schema + "." + name,
    );
  }
  for (const t of newTables) assert.ok(workTables[t], t);
  // The runtime login executes exactly the step definers the code sends.
  const steps = Object.values(agentRunSql).map((s) => /FROM morrow_work\.([a-z_]+)\(/.exec(s)[1]);
  for (const name of steps)
    assert.ok(
      executorLogins.morrow_runtime_executor.some((f) => f.startsWith("morrow_work." + name + "(")),
      name,
    );
  assert.ok(
    executorLogins.morrow_vault_broker.some((f) => f.startsWith("morrow_vault.agent_turn_begin(")),
  );
  // The step definers find their run only through the entered lease (agent_run_entered);
  // none takes a tenant, actor or run id but the two ids-only lookups.
  for (const name of [
    "agent_run_start",
    "agent_run_state",
    "agent_run_objective",
    "agent_run_conversation",
    "agent_run_answers",
    "agent_turn_open",
    "agent_turn_settle",
    "agent_tool_call_begin",
    "agent_tool_call_finish",
    "agent_question_ask",
    "agent_run_wait",
    "agent_run_finish",
  ]) {
    const fn = fnBody("morrow_work", name);
    assert.match(fn, /morrow_work\.agent_run_entered\(\)/, name);
    const params = fn.slice(fn.indexOf("(") + 1, fn.indexOf(")"));
    assert.doesNotMatch(params, /organization|workspace|principal|membership|run_id|lease/, name);
  }
  assert.deepEqual(workFunctions["agent_run_resume_lease(text,text,text)"].tenantParameters, [
    "p_organization_id",
    "p_workspace_id",
  ]);
  // The broker's fence resolves the lease (resolve_call, purpose model) under the stop
  // interlock before it reads the run; the close needs no lease.
  const begin = fnBody("morrow_vault", "agent_turn_begin");
  const order = [
    "work_executor_safe('morrow_vault_broker')",
    "pg_advisory_xact_lock_shared",
    "morrow_vault.resolve_call(p_lease_id,p_generation,'model'",
    "morrow.vault_agent_run",
    "INSERT INTO morrow_work.agent_model_calls",
  ].map((n) => begin.indexOf(n));
  assert.ok(
    order.every((i) => i > 0),
    JSON.stringify(order),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  const end = fnBody("morrow_vault", "agent_turn_end");
  assert.doesNotMatch(end, /resolve_call/);
  // Never promoted: an uncertain close books the worst case, a late close is already_closed.
  assert.match(end, /IF v_outcome='uncertain' THEN v_cost:=r\.worst_case_turn_usd;/);
  assert.match(end, /'already_closed'/);
  // Admission: the switch is the Worker's; SQL takes only an active catalogue version and
  // derives the caps, the hold, the envelope's pairs and the billing facts itself.
  const admit = fnBody("morrow_work", "cmd_agent_run_admit");
  for (const piece of [
    "y.status='active'",
    "'catalogue_inactive'",
    "'cap_below_turn'",
    "subscription_key !~ '^morrow:operator_entitlement:'",
    "'daily_backstop'",
    "'unrecovered_cost_cap'",
    "morrow_work.lease_open('run'",
    "morrow_work.stop_active(",
    "'routed'=ANY(t.contexts)",
  ])
    assert.ok(admit.includes(piece), piece);
});

test("the agent-loop switch record is committed off with every prerequisite unrecorded", () => {
  const record = JSON.parse(readFileSync("docs/decisions/agent-loop-staging.json", "utf8"));
  assert.equal(record.switch, "off");
  assert.equal(record.workflow, "agent-run@1");
  assert.deepEqual(Object.keys(record.prerequisites).sort(), [...agentLoopPrerequisites].sort());
  assert.ok(Object.values(record.prerequisites).every((p) => p === null));
});
