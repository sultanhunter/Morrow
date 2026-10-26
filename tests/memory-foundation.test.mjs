// H12a, the memory foundation (docs/briefs/memory-foundation.md; ADR-0041 items 25 to 30). In
// Node, with no database: the code rules and their SQL twins (closed shapes, the read
// predicates, lineage unions, the identifier backstop and the bounds), notebook.write's checks
// for the v1.1 input and for a full operation, the memory steps' closed decoders, and migration
// 0057's static shape. lab:memory drives the same code against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanTaint,
  memoryAudienceNarrow,
  memoryAudienceReadable,
  memoryAudienceValid,
  memoryLimits,
  memoryRunFactsValid,
  memorySubjectScopeValid,
  memorySubjectsValid,
  memorySubjectsViewable,
  memoryTagsViewable,
  memoryTaintSources,
  memoryTaintUnion,
  memoryTaintValid,
  memoryTextRefused,
  memoryViewableTagsValid,
  notebookEntryKinds,
  notebookTitleFrom,
} from "../packages/policy/src/memory/index.ts";
import {
  decideNotebookOperation,
  decideNotebookWrite,
  knowledgeLimits,
} from "../packages/policy/src/knowledge/index.ts";
import {
  knowledgeRunSql,
  notebookOperationStep,
  notebookWriteStep,
} from "../packages/work/src/knowledge/run-steps.ts";
import {
  memoryReadForRun,
  memoryRunSql,
  memorySearchForRun,
} from "../packages/work/src/memory/run-steps.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { workspaceContentHandlers } from "../packages/work/src/redaction.ts";
import { executorLogins, workFunctions, workTables } from "./tenant-conformance/registry.mjs";

const STORE = "store_m";
const tag = (capability, storeId = STORE) => ({ storeId, capability });
const G1 = { kind: "goal", id: "goal_1" };
const T1 = { kind: "task", id: "task_1" };
const untrusted = {
  kinds: ["untrusted_external"],
  sources: [{ source: "product", sourceId: "product:1" }],
  omitted: 0,
};
const memory = (over = {}) => ({
  taint: cleanTaint,
  audience: { kind: "workspace" },
  sourceSubjects: [],
  personMemoryLoaded: false,
  viewableTags: [tag("workspace.artifact.read")],
  subjectScope: { kinds: [], ids: [] },
  ...over,
});
const run = (over = {}) => ({
  context: "routed",
  readTags: [],
  taint: "none",
  agentTools: "on",
  memory: memory(),
  ...over,
});
const uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";

test("closed shapes: subjects, audiences, taint, subject views and viewable tags", () => {
  assert.ok(memorySubjectsValid([G1, T1]));
  for (const bad of [
    [G1, G1],
    [{ kind: "project", id: "p" }],
    [{ kind: "goal", id: "has space" }],
    [{ kind: "goal", id: "g", extra: 1 }],
    Array.from({ length: 33 }, (_, i) => ({ kind: "task", id: "t" + i })),
    {},
  ])
    assert.equal(memorySubjectsValid(bad), false, JSON.stringify(bad));
  for (const ok of [
    { kind: "workspace" },
    { kind: "subject", subject: G1 },
    { kind: "principal", principalId: "principal_a" },
  ])
    assert.ok(memoryAudienceValid(ok));
  for (const bad of [
    { kind: "workspace", subject: G1 },
    { kind: "subject" },
    { kind: "principal", principalId: "" },
    { kind: "everyone" },
  ])
    assert.equal(memoryAudienceValid(bad), false, JSON.stringify(bad));
  assert.ok(memoryTaintValid(cleanTaint));
  assert.ok(memoryTaintValid(untrusted));
  assert.ok(memoryTaintValid({ kinds: ["other_member"], sources: [], omitted: 3 }));
  for (const bad of [
    { kinds: [], sources: [{ source: "product", sourceId: null }], omitted: 0 },
    { kinds: ["untrusted_external"], sources: [], omitted: 0 },
    { kinds: ["untrusted_external", "other_member"], sources: [], omitted: 1 },
    { kinds: ["untrusted_external"], sources: [{ source: "web", sourceId: null }], omitted: 0 },
    { ...untrusted, sources: [...untrusted.sources, ...untrusted.sources] },
    { ...untrusted, omitted: -1 },
    { ...untrusted, extra: true },
  ])
    assert.equal(memoryTaintValid(bad), false, JSON.stringify(bad));
  // The taint sources are ModelUntrustedSource's eleven and ADR-0041's eight additions.
  assert.equal(memoryTaintSources.length, 19);
  assert.ok(memorySubjectScopeValid({ kinds: ["goal"], ids: [T1] }));
  assert.equal(memorySubjectScopeValid({ kinds: ["goal", "goal"], ids: [] }), false);
  assert.ok(memoryViewableTagsValid([tag("support.case.read"), tag("orders.read")]));
  assert.equal(memoryViewableTagsValid([tag("orders.read"), tag("orders.read")]), false);
  assert.equal(memoryViewableTagsValid([{ storeId: STORE, capability: "x.y" }]), false);
  assert.ok(memoryRunFactsValid(memory()));
  assert.equal(memoryRunFactsValid({ ...memory(), extra: 1 }), false);
});

test("the read predicates: audience, source subjects and tags, as 0057 applies them before ranking", () => {
  const ws = { kind: "workspace" };
  const g1 = { kind: "subject", subject: G1 };
  const g2 = { kind: "subject", subject: { kind: "goal", id: "goal_2" } };
  const a = { kind: "principal", principalId: "principal_a" };
  const b = { kind: "principal", principalId: "principal_b" };
  // Workspace rows to anyone; a subject's rows to that subject's work or a person's private
  // work; a person's rows only to that person's private work.
  assert.deepEqual(
    [ws, g1, a].map((row) =>
      [ws, g1, g2, a, b].map((reader) => memoryAudienceReadable(row, reader)),
    ),
    [
      [true, true, true, true, true],
      [false, true, false, true, true],
      [false, false, false, true, false],
    ],
  );
  assert.ok(memorySubjectsViewable([G1, T1], { kinds: ["task"], ids: [G1] }));
  assert.equal(memorySubjectsViewable([G1, T1], { kinds: ["task"], ids: [] }), false);
  assert.ok(memorySubjectsViewable([], { kinds: [], ids: [] }));
  assert.ok(memoryTagsViewable([], []));
  assert.ok(memoryTagsViewable([tag("orders.read")], [tag("orders.read"), tag("x.y.z")]));
  assert.equal(memoryTagsViewable([tag("orders.read", "other")], [tag("orders.read")]), false);
  // The narrower audience; none when no one audience covers both.
  assert.deepEqual(memoryAudienceNarrow(ws, g1), g1);
  assert.deepEqual(memoryAudienceNarrow(g1, a), a);
  assert.equal(memoryAudienceNarrow(g1, g2), null);
  assert.equal(memoryAudienceNarrow(a, b), null);
});

test("taint is sticky: a union keeps every kind and source, 256 inline and the rest counted", () => {
  const u = memoryTaintUnion(untrusted, { kinds: ["other_member"], sources: [], omitted: 2 });
  assert.deepEqual(u.kinds, ["other_member", "untrusted_external"]);
  assert.equal(u.omitted, 2);
  assert.deepEqual(memoryTaintUnion(untrusted, untrusted), untrusted);
  const many = (prefix, n) => ({
    kinds: ["untrusted_external"],
    sources: Array.from({ length: n }, (_, i) => ({ source: "tool_result", sourceId: prefix + i })),
    omitted: 0,
  });
  const big = memoryTaintUnion(many("a", 200), many("b", 100));
  assert.equal(big.sources.length, 256);
  assert.equal(big.omitted, 44);
  assert.ok(memoryTaintValid(big));
  // Sources sort as SQL's COLLATE "C" with nulls first.
  assert.deepEqual(
    memoryTaintUnion(
      { kinds: ["untrusted_external"], sources: [{ source: "upload", sourceId: "b" }], omitted: 0 },
      {
        kinds: ["untrusted_external"],
        sources: [
          { source: "upload", sourceId: null },
          { source: "artifact", sourceId: "Z" },
        ],
        omitted: 0,
      },
    ).sources,
    [
      { source: "artifact", sourceId: "Z" },
      { source: "upload", sourceId: null },
      { source: "upload", sourceId: "b" },
    ],
  );
});

test("a title for a text that has none: its first line, cut at 120 characters", () => {
  assert.equal(notebookTitleFrom("\n  Titles  run long.\nSecond line."), "Titles run long.");
  const long = notebookTitleFrom("word ".repeat(40));
  assert.equal([...long].length, 120);
  assert.ok(long.endsWith("…"));
  assert.equal(notebookTitleFrom("é".repeat(130)).length, 120);
});

test("notebook.write in code: an add of a lesson for the v1.1 input; full operations; every refusal", () => {
  const ok = decideNotebookWrite({ text: "Care labels go left.\nAlways." }, run());
  assert.deepEqual(ok.args.operation, {
    op: "add",
    kind: "lesson",
    title: "Care labels go left.",
    text: "Care labels go left.\nAlways.",
    derivedFrom: [],
  });
  assert.deepEqual(ok.args.memory, memory());
  const refused = (refusal) => ({ ok: false, outcome: "refused", refusal });
  const invalid = { ok: false, outcome: "invalid_input", refusal: "input_invalid" };
  // A private Ask is never offered notebook.write; person memory and identifiers are refused.
  assert.deepEqual(
    decideNotebookWrite(
      { text: "x" },
      run({ memory: memory({ audience: { kind: "principal", principalId: "p" } }) }),
    ),
    refused("not_offered"),
  );
  assert.deepEqual(
    decideNotebookWrite({ text: "x" }, run({ memory: memory({ personMemoryLoaded: true }) })),
    refused("authority_denied"),
  );
  for (const text of ["Mail jo@example.test", "gid://shopify/Customer/7"])
    assert.deepEqual(decideNotebookWrite({ text }, run()), refused("customer_data"));
  assert.deepEqual(
    decideNotebookWrite({ text: "x" }, run({ readTags: [tag("support.case.read")] })),
    refused("customer_data"),
  );
  // The loop's facts are checked: missing, malformed or disagreeing with the context taint.
  for (const bad of [
    run({ memory: undefined }),
    run({ memory: { ...memory(), taint: { kinds: ["x"], sources: [], omitted: 0 } } }),
    run({ taint: "untrusted_external" }),
    run({ memory: memory({ taint: untrusted }) }),
  ])
    assert.throws(() => decideNotebookWrite({ text: "x" }, bad), /KNOWLEDGE_RUN_FACTS_INVALID/);
  assert.ok(
    decideNotebookWrite(
      { text: "x" },
      run({ taint: "untrusted_external", memory: memory({ taint: untrusted }) }),
    ).ok,
  );
  // Full operations (tool catalogue version 4's seam).
  const replace = {
    op: "replace",
    targetId: uuid,
    kind: "correction",
    title: "Wash",
    text: "Cold wash.",
    derivedFrom: [{ kind: "knowledge_page", id: "page_1" }],
  };
  assert.deepEqual(decideNotebookOperation(replace, run()).args.operation, replace);
  assert.deepEqual(
    decideNotebookOperation({ op: "retire", targetId: uuid }, run()).args.operation,
    { op: "retire", targetId: uuid },
  );
  for (const bad of [
    { ...replace, targetId: "not-a-uuid" },
    { ...replace, kind: "rumour" },
    { ...replace, title: "" },
    { ...replace, title: "x".repeat(121) },
    { ...replace, text: "x".repeat(2001) },
    { ...replace, text: "a\u0000b" },
    { ...replace, derivedFrom: [{ kind: "url", id: "x" }] },
    { op: "add", kind: "lesson", title: "x", text: "y" },
    { op: "retire", targetId: uuid, text: "y" },
    { op: "erase", targetId: uuid },
  ])
    assert.deepEqual(decideNotebookOperation(bad, run()), invalid, JSON.stringify(bad));
  assert.deepEqual(
    decideNotebookOperation(replace, run({ agentTools: "off" })),
    refused("switch_off"),
  );
  assert.deepEqual(
    decideNotebookOperation(replace, run({ context: "look_for_work" })),
    refused("not_offered"),
  );
  // A retire carries no text, so only the Ask and person-memory rules apply to it.
  assert.ok(decideNotebookOperation({ op: "retire", targetId: uuid }, run()).ok);
});

test("the notebook step sends the operation and the run's facts, and decodes each effect closed", async () => {
  const sent = [];
  const answering = (row) => async (text, values) => {
    sent.push({ text, values });
    return [row];
  };
  const call = (
    row,
    operation = { op: "add", kind: "lesson", title: "T", text: "B", derivedFrom: [] },
  ) =>
    notebookOperationStep(answering(row), {
      toolUseId: "toolu_1",
      operation,
      run: run({ readTags: [tag("catalog.products.read")] }),
      viewer: { mayView: () => true },
    });
  const applied = await call({ outcome: "applied", entry_id: uuid, sequence: "7" });
  assert.deepEqual(applied, {
    outcome: "ok",
    effect: "applied",
    record: { kind: "notebook_entry", id: uuid },
    replayed: false,
  });
  assert.equal(sent[0].text, knowledgeRunSql.notebookWrite);
  assert.deepEqual(sent[0].values, [
    "toolu_1",
    "add",
    "",
    "lesson",
    "T",
    "B",
    JSON.stringify([tag("catalog.products.read")]),
    JSON.stringify(cleanTaint),
    '{"kind":"workspace"}',
    "[]",
    "[]",
    JSON.stringify([tag("workspace.artifact.read")]),
    '{"kinds":[],"ids":[]}',
    "false",
  ]);
  assert.equal(
    (await call({ outcome: "replay_renewed", entry_id: uuid, sequence: "7" })).effect,
    "renewed",
  );
  const retire = { op: "retire", targetId: uuid };
  assert.deepEqual(
    await call({ outcome: "replay_flagged", entry_id: null, sequence: null }, retire),
    {
      outcome: "ok",
      effect: "flagged",
      record: null,
      replayed: true,
    },
  );
  assert.deepEqual(await call({ outcome: "audience_conflict", entry_id: null, sequence: null }), {
    outcome: "refused",
    refusal: "id_out_of_scope",
  });
  // Anything else is a defect the loop retries, never a result the model sees.
  for (const [row, operation] of [
    [{ outcome: "conflict", entry_id: null, sequence: null }],
    [{ outcome: "ask_bound", entry_id: null, sequence: null }],
    [{ outcome: "applied", entry_id: null, sequence: null }],
    [{ outcome: "applied", entry_id: uuid, sequence: "7" }, retire],
    [{ outcome: "applied", entry_id: uuid, sequence: "0" }],
    [{ outcome: "applied", entry_id: uuid, sequence: "7", extra: 1 }],
  ])
    await assert.rejects(call(row, operation), /RUNTIME_KNOWLEDGE_HELD/, JSON.stringify(row));
  // The v1.1 input goes through the same definer.
  const v1 = await notebookWriteStep(
    answering({ outcome: "replay", entry_id: uuid, sequence: "3" }),
    {
      toolUseId: "toolu_2",
      input: { text: "Short note." },
      run: run(),
      viewer: { mayView: () => true },
    },
  );
  assert.deepEqual(v1, {
    outcome: "ok",
    effect: "applied",
    record: { kind: "notebook_entry", id: uuid },
    replayed: true,
  });
});

test("memory.search and memory.read: closed requests and decoders, best first", async () => {
  const hit = (over = {}) => ({
    layer: "notebook",
    item_id: uuid,
    version: null,
    kind: "lesson",
    title: "Care",
    snippet: "Care labels go left.",
    trust: "agent_lesson",
    requester_principal_id: "principal_a",
    read_tags: JSON.stringify([tag("workspace.artifact.read")]),
    taint: JSON.stringify(cleanTaint),
    score: "0.032000000",
    ...over,
  });
  const page = hit({
    layer: "knowledge",
    item_id: "page_1",
    version: "2",
    kind: "policy",
    trust: "approved_knowledge",
    requester_principal_id: null,
    read_tags: JSON.stringify([tag("workspace.knowledge.read")]),
    score: "0.020000000",
  });
  let seen;
  const rows = (list) => async (text, values) => {
    seen = { text, values };
    return list;
  };
  const request = { queries: ["care labels", "seam"], layers: ["notebook", "knowledge"], limit: 5 };
  const hits = await memorySearchForRun(rows([hit(), page]), memory(), request);
  assert.equal(seen.text, memoryRunSql.search);
  assert.deepEqual(seen.values, [
    '["care labels","seam"]',
    '["notebook","knowledge"]',
    JSON.stringify([tag("workspace.artifact.read")]),
    '{"kinds":[],"ids":[]}',
    '{"kind":"workspace"}',
    "5",
  ]);
  assert.deepEqual(
    hits.map((h) => [h.layer, h.itemId, h.version, h.trust, h.score]),
    [
      ["notebook", uuid, null, "agent_lesson", 0.032],
      ["knowledge", "page_1", 2, "approved_knowledge", 0.02],
    ],
  );
  for (const bad of [
    { ...request, queries: [] },
    { ...request, queries: ["a", "b", "c", "d", "e", "f"] },
    { ...request, queries: [" "] },
    { ...request, queries: ["x".repeat(201)] },
    { ...request, layers: ["notebook", "notebook"] },
    { ...request, layers: ["person"] },
    { ...request, limit: 21 },
  ])
    await assert.rejects(memorySearchForRun(rows([]), memory(), bad), /RUNTIME_MEMORY_HELD/);
  // A row outside the closed shape, out of order or past the limit is a defect.
  for (const list of [
    [hit({ trust: "approved_knowledge" })],
    [hit({ version: "1" })],
    [hit({ taint: '{"kinds":["untrusted_external"],"sources":[],"omitted":0}' })],
    [page, hit()],
    [hit(), hit()],
    [hit({ score: "1" })],
    [hit({ snippet: "x".repeat(281) })],
    Array.from({ length: 6 }, (_, i) => hit({ item_id: "e" + i })),
  ])
    await assert.rejects(memorySearchForRun(rows(list), memory(), request), /RUNTIME_MEMORY_HELD/);
  await assert.rejects(
    memorySearchForRun(rows([hit()]), memory(), { ...request, layers: ["knowledge"] }),
    /RUNTIME_MEMORY_HELD/,
  );
  // memory.read: one item in full, or null; the tainted flag is the run's.
  const item = {
    ...hit(),
    body: "Care labels go on the left side seam.",
    source_subjects: JSON.stringify([G1]),
    derived_from: JSON.stringify([{ kind: "knowledge_page", id: "page_1" }]),
    created_at: "2026-10-26T10:00:00.000Z",
    renewed_at: "2026-10-26T11:00:00.000Z",
  };
  delete item.snippet;
  delete item.score;
  const opened = await memoryReadForRun(rows([item]), memory({ taint: untrusted }), {
    layer: "notebook",
    itemId: uuid,
  });
  assert.equal(seen.text, memoryRunSql.read);
  assert.equal(seen.values.at(-1), "true");
  assert.deepEqual(opened.sourceSubjects, [G1]);
  assert.equal(opened.text, "Care labels go on the left side seam.");
  assert.equal(
    await memoryReadForRun(rows([]), memory(), { layer: "notebook", itemId: uuid }),
    null,
  );
  await assert.rejects(
    memoryReadForRun(rows([{ ...item, item_id: "other" }]), memory(), {
      layer: "notebook",
      itemId: uuid,
    }),
    /RUNTIME_MEMORY_HELD/,
  );
});

const sql = readFileSync("migrations/0057.memory-foundation.sql", "utf8");
test("migration 0057: forward only, guarded on empty notebooks, FORCE RLS, no runtime DELETE", () => {
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8")).migrations;
  const row = manifest.find((m) => m.file === "0057.memory-foundation.sql");
  assert.deepEqual(
    { sequence: row.sequence, executeAs: row.executeAs, reviewRef: row.reviewRef },
    { sequence: 57, executeAs: "morrow_work_owner", reviewRef: "docs/briefs/memory-foundation.md" },
  );
  assert.equal(manifest.at(-1).file, "0057.memory-foundation.sql");
  // Re-keying is refused while any notebook or entry exists, before any change.
  const guard = sql.indexOf("MEMORY_FOUNDATION_NOTEBOOKS_NOT_EMPTY");
  assert.ok(guard > 0 && guard < sql.indexOf("ALTER TABLE"));
  assert.match(sql, /CREATE EXTENSION pg_trgm WITH SCHEMA extensions VERSION '1\.6';/);
  assert.match(sql, /REVOKE ALL ON SCHEMA extensions FROM PUBLIC;/);
  assert.match(sql, /GRANT USAGE ON SCHEMA extensions TO morrow_work_command;/);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE/);
  assert.doesNotMatch(sql, /BYPASSRLS/);
  for (const table of ["memory_derivations", "memory_repairs", "memory_settings"]) {
    assert.ok(sql.includes(`'${table}'`), table);
    assert.ok(workTables[table], table);
  }
  assert.match(sql, /ALTER TABLE morrow_work\.%I FORCE ROW LEVEL SECURITY/);
  // Every definer is registered with its one grantee, and each runtime one is the executor's.
  for (const [signature, grantee] of [
    ["cmd_notebook_clear_v2(text,text,text,text,text)", "morrow_work_api"],
    [
      "run_notebook_write_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text)",
      "morrow_runtime_executor",
    ],
    ["run_memory_search(text,text,text,text,text,text)", "morrow_runtime_executor"],
    ["run_memory_read(text,text,text,text,text,text)", "morrow_runtime_executor"],
  ]) {
    assert.deepEqual(workFunctions[signature].grantees, [grantee], signature);
    if (grantee === "morrow_runtime_executor")
      assert.ok(executorLogins.morrow_runtime_executor.includes("morrow_work." + signature));
  }
  // The work API and the run steps send the new definers only.
  assert.match(workStatements.cmdNotebookClear, /cmd_notebook_clear_v2\(/);
  assert.match(knowledgeRunSql.notebookWrite, /run_notebook_write_v2\(/);
  assert.match(memoryRunSql.search, /run_memory_search\(/);
  assert.match(memoryRunSql.read, /run_memory_read\(/);
});

test("0057's predicates come before ranking, and its bounds and backstop match the code's", () => {
  // The search's candidate sets carry every predicate; ranking (row_number) comes after them.
  const ranked = sql.slice(sql.indexOf("CREATE FUNCTION morrow_work.memory_search_ranked("));
  const candidates = ranked.slice(
    ranked.indexOf("nb AS MATERIALIZED"),
    ranked.indexOf("hits AS ("),
  );
  for (const predicate of [
    "e.agent_principal_id=p_agent",
    "e.erased_at IS NULL",
    "e.expires_at>p_at",
    "e.read_tags<@p_tags",
    "morrow_work.memory_subjects_viewable(e.source_subjects,p_scope)",
    "morrow_work.memory_audience_readable(e.audience,p_audience)",
    "p.deleted_at IS NULL",
    "p.read_tags<@p_tags",
  ])
    assert.ok(candidates.includes(predicate), predicate);
  assert.ok(ranked.indexOf("row_number()") > ranked.indexOf("hits AS ("));
  // The read applies the same predicates.
  const read = sql.slice(sql.indexOf("CREATE FUNCTION morrow_work.run_memory_read("));
  for (const predicate of [
    "e.read_tags<@v_tags",
    "morrow_work.memory_subjects_viewable(e.source_subjects,v_scope)",
    "morrow_work.memory_audience_readable(e.audience,v_audience)",
  ])
    assert.ok(read.includes(predicate), predicate);
  // Bounds held alike.
  assert.match(sql, /live_entries BETWEEN 0 AND 1000/);
  assert.equal(memoryLimits.notebookLiveEntries, 1000);
  assert.equal(knowledgeLimits.notebookLiveEntries, 1000);
  assert.match(sql, /jsonb_array_length\(s\)>32/);
  assert.equal(memoryLimits.sourceSubjects, 32);
  assert.match(sql, /memory_refs_valid\(derived_from,64\)/);
  assert.equal(memoryLimits.derivedFrom, 64);
  assert.match(sql, /jsonb_array_length\(t->'sources'\)<=256/);
  assert.equal(memoryLimits.taintSources, 256);
  assert.match(sql, /left\(nb\.body,280\)/);
  assert.equal(memoryLimits.snippetChars, 280);
  assert.match(sql, /expires_at=renewed_at\+interval '90 days'/);
  assert.equal(memoryLimits.notebookDays, 90);
  for (const kind of notebookEntryKinds) assert.ok(sql.includes(`'${kind}'`), kind);
  // The identifier backstop is the same pattern in both.
  assert.ok(
    sql.includes(
      "p_text ~* '[A-Z0-9._%+-]+@[A-Z0-9-]+(\\.[A-Z0-9-]+)*\\.[A-Z]{2,}' OR p_text ~* 'gid://shopify/Customer/'",
    ),
  );
  assert.ok(memoryTextRefused("A@B.CO") && memoryTextRefused("gid://shopify/customer/1"));
  assert.equal(memoryTextRefused("order #1001 and gid://shopify/Order/5"), false);
  // Every taint source the code names, the SQL names.
  for (const source of memoryTaintSources) assert.ok(sql.includes(`'${source}'`), source);
});

test("the deletion path: a clear, deletion following the source, and the clock, each by a registered function", () => {
  const notebookHandlers = workspaceContentHandlers.filter(
    (h) => h.table === "morrow_work.agent_notebook_entries",
  );
  assert.deepEqual(
    notebookHandlers.map((h) => [h.trigger, h.executor]),
    [
      ["notebook_clear", "morrow_work.cmd_notebook_clear_v2"],
      ["source_erased", "morrow_work.memory_erase_derived"],
      ["clock_expired", "morrow_work.memory_erase_expired"],
    ],
  );
  for (const h of notebookHandlers)
    assert.ok(
      Object.keys(workFunctions).some((s) =>
        s.startsWith(h.executor.replace("morrow_work.", "") + "("),
      ),
      h.executor,
    );
  // The source-following triggers fire on every erasure path of a page and of an entry.
  assert.match(
    sql,
    /CREATE TRIGGER memory_page_follow AFTER UPDATE ON morrow_work\.knowledge_pages FOR EACH ROW\s+WHEN \(\(NEW\.deleted_at IS NOT NULL AND OLD\.deleted_at IS NULL\) OR NEW\.current_version<>OLD\.current_version\)/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER memory_entry_follow AFTER UPDATE ON morrow_work\.agent_notebook_entries FOR EACH ROW\s+WHEN \(OLD\.erased_at IS NULL AND NEW\.erased_at IS NOT NULL AND NEW\.erased_reason IN \('cleared','source_erased'\)\)/,
  );
  for (const table of ["memory_derivations", "memory_repairs", "memory_settings"])
    assert.equal(workTables[table].content, "none", table);
});
