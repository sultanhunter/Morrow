// lab:memory (H12a, docs/briefs/memory-foundation.md; ADR-0041 items 25 to 30): the memory
// foundation against PostgreSQL 17, with the manifest applied by the Neon-shaped createrole
// administrator up to 0056 and 0057 applied here, under the runner's D4 protocol. M1: the re-key
// is refused while any notebook entry exists and applies once none does. Then, through the real
// run steps under a real run lease (a fake caller, as the agent loop will call them) and the real
// knowledge routes: pg_trgm in its own schema that only the command role reaches; the notebook
// keyed by agent principal, written only by its own agent's runs, never from a private Ask, after
// customer data or after person memory, with replays that return what the call did; replace and
// retire with lineage closed over knowledge pages, taint and tags unioned, and a tainted run only
// flagging a clean entry; deletion following the source (a deleted page erases every live entry
// derived from it, however indirectly, in the same transaction, and a racing write waits for it);
// memory.search and memory.read applying every layer's predicates (read tags, source subjects,
// audience) before ranking; use counts; the 90-day clock's handler; a person's clear at the
// revision their check read, blocked by entries they cannot see; and no runtime role deleting or
// rewriting memory. Synthetic fixtures only; no provider, credential or merchant data. Run by
// `npm run lab:memory` (CI's postgres `http` leg).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createKnowledgeApiHandler } from "../../packages/work/src/knowledge/http.ts";
import {
  notebookOperationStep,
  notebookWriteStep,
} from "../../packages/work/src/knowledge/run-steps.ts";
import { memoryReadForRun, memorySearchForRun } from "../../packages/work/src/memory/run-steps.ts";
import {
  memoryAudienceReadable,
  memorySubjectsViewable,
  memoryTaintUnion,
} from "../../packages/policy/src/memory/index.ts";
import { storeResource } from "../../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../../packages/contracts/src/validation.ts";
import {
  administrator,
  d4Transaction,
  morrowSetRows,
  psqlAs,
} from "../../scripts/fixtures/createrole-administrator.mjs";
import { loadMigrationChain } from "../../scripts/migration-chain.mjs";
import {
  asApi,
  asCommandRole,
  fixtureGrant,
  grantInsert,
  literal,
  seedWorkFixtures,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
} from "../tenant-conformance/harness.mjs";

const STORE = "store_m",
  CONNECTION = "connection_m",
  STORE_INSTALLATION = "storeinst_m",
  INSTALLATION = "installation_m";
let db, release, started, P, open, AGENT;
before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  started = withWorkDatabase(
    "H12a.memory",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole", stopBefore: 57 },
  );
  await Promise.race([opened, started]);
  P = seedWorkFixtures(db);
  const O = P.A.org,
    W = P.A.workspace;
  db.admin(
    storeInstallationSql({
      org: O,
      workspace: W,
      principal: P.A.principal,
      storeId: STORE,
      connectionId: CONNECTION,
      installationId: STORE_INSTALLATION,
    }),
  );
  const store = storeResource(O, W, STORE, CONNECTION);
  const actorOf = (p) => ({
    kind: "human",
    principalId: p.principal,
    organizationId: p.org,
    workspaceId: p.workspace,
    membershipId: p.membership,
    installationId: null,
    mandateId: null,
  });
  const storeGrant = (p, capabilityId, verbs, fields) => {
    const g = {
      id: "grant_" + p.key.toLowerCase() + "_store_" + capabilityId.replaceAll(".", "_"),
      principal: actorOf(p),
      capabilityId,
      verbs,
      scope: {
        organizationId: O,
        workspaceId: W,
        storeIds: [STORE],
        accountIds: [],
        resources: [store],
        fields,
      },
      issuedBy: actorOf(p),
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 1,
    };
    if (!validateCurrentDefinition("Grant", g)) throw Error("LAB_GRANT_INVALID");
    return grantInsert(p, g);
  };
  const approve = ["expectedRevision", "recordId", "sourceRefs"];
  // A writes, deletes and clears and sees the store's knowledge and artifacts. B reads the
  // store's knowledge but none of its artifacts, so no notebook entry is shown to B.
  db.admin(
    [
      storeGrant(P.A, "workspace.knowledge.read", ["view"], ["query", "resourceScope"]),
      grantInsert(
        P.A,
        fixtureGrant(P.A, "workspace.knowledge.read", ["view"], ["query", "resourceScope"]),
      ),
      storeGrant(P.A, "workspace.artifact.read", ["view"], ["artifactId", "revision"]),
      storeGrant(P.A, "catalog.products.read", ["view"], ["productId"]),
      grantInsert(
        P.A,
        fixtureGrant(P.A, "workspace.knowledge.approve", ["execute", "administer"], approve),
      ),
      grantInsert(P.A, fixtureGrant(P.A, "workspace.notebook.write", ["administer"], ["text"])),
      storeGrant(P.B, "workspace.knowledge.read", ["view"], ["query", "resourceScope"]),
      grantInsert(P.B, fixtureGrant(P.B, "workspace.notebook.write", ["administer"], ["text"])),
    ].join("\n"),
  );
  // The Listings installation whose runs write the notebook (owner-seeded, as lab:shop-knowledge).
  AGENT = "agent_" + randomUUID();
  db.admin(`INSERT INTO morrow_identity.principals VALUES(${literal(AGENT)},'agent',true);
INSERT INTO morrow_identity.agent_principals VALUES(${literal(AGENT)},'agent',${literal(O)},${literal(W)},'installation',${literal(INSTALLATION)},date_trunc('milliseconds',clock_timestamp()));`);
  db.workOwner(`BEGIN; INSERT INTO morrow_work.agent_installations(organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,connection_id,agent_principal_id,owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at)
SELECT ${literal(O)},${literal(W)},${literal(INSTALLATION)},1,r.id,r.revision,r.digest,${literal(STORE)},${literal(CONNECTION)},${literal(AGENT)},${literal(P.A.principal)},${literal(P.A.membership)},'active',morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(STORE)},${literal(CONNECTION)}),(SELECT jsonb_agg(jsonb_build_object('organizationId',${literal(O)},'workspaceId',${literal(W)},'storeId',${literal(STORE)},'kind','grant','id','g_ref_'||n,'revision',1,'digest',repeat('a',64))) FROM generate_series(1,3) n),repeat('b',64),t,t FROM morrow_work.agent_releases r, (SELECT date_trunc('milliseconds',clock_timestamp()) AS t) x WHERE r.id='morrow.listings' AND r.revision=1; COMMIT;`);
  const connector = db.connector({
    stderr: (text) => process.env.MORROW_LAB_DEBUG === "1" && process.stderr.write(text),
  });
  open = createKnowledgeApiHandler({
    origin: workFixtureOrigin,
    connector,
    now: Date.now,
    knowledge: "on",
  });
});
after(async () => {
  release?.();
  await started;
});

const quietly = async (body) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await body();
  } finally {
    console.log = log;
  }
};
async function send(handler, p, method, path, body, options) {
  return quietly(async () => {
    const response = await handler.fetch(workRequest(p, method, path, body, options), undefined, {
      waitUntil() {},
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) };
  });
}
const count = (table, where = "true") =>
  Number(db.sql(`SELECT count(*) FROM morrow_work.${table} WHERE ${where};`));
const scalar = (text) => db.sql(text).split("\n").at(-1);
const refusedSql = (statements, pattern, options) => {
  const r = db.tryRun(statements, options);
  assert.equal(r.ok, false, statements.slice(0, 160));
  assert.match(r.stderr, pattern);
};

// One run lease of the Listings installation, opened by A (the requester).
function openRunLease(subject) {
  const out = db
    .sql(
      asCommandRole(
        P.A,
        `SELECT concat_ws('|',outcome,lease_id,generation) FROM morrow_work.lease_open('run',${literal(subject)},${literal(STORE)},${literal(CONNECTION)},${literal(INSTALLATION)});`,
        { end: "COMMIT" },
      ),
    )
    .split("\n")
    .at(-1);
  const [outcome, id, generation] = out.split("|");
  assert.equal(outcome, "opened");
  return { id, generation, subject };
}
// The fake caller: one transaction of the runtime login under an entered run lease.
async function underLease(lease, body) {
  const connection = await db.connector({ user: "morrow_runtime_executor" }).open({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 60000,
    waitUntil() {},
  });
  const signal = new AbortController().signal;
  const query = async (text, values = []) =>
    (await connection.query(text, [...values], signal)).rows;
  try {
    await query("BEGIN");
    const [entered] = await query("SELECT outcome FROM morrow_work.enter_lease($1,$2)", [
      lease.id,
      lease.generation,
    ]);
    assert.equal(entered.outcome, "entered");
    const value = await body(query);
    await query("COMMIT");
    return value;
  } catch (error) {
    await query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await connection.close();
  }
}
// Statements of the runtime login under an entered lease, in one transaction (rolled back).
const underLeaseSql = (lease, statements, end = "ROLLBACK") =>
  db.sql(
    `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(lease.id)},${literal(lease.generation)}); ${statements} ${end};`,
    { user: "morrow_runtime_executor" },
  );

const allTags = { mayView: () => true };
const clean = { kinds: [], sources: [], omitted: 0 };
const untrusted = {
  kinds: ["untrusted_external"],
  sources: [{ source: "product", sourceId: "product:4242" }],
  omitted: 0,
};
const tag = (capability, storeId = STORE) => ({ storeId, capability });
const artifactTag = tag("workspace.artifact.read");
const knowledgeTag = tag("workspace.knowledge.read");
const viewAll = [artifactTag, knowledgeTag, tag("catalog.products.read")];
const G1 = { kind: "goal", id: "goal_m1" },
  G2 = { kind: "goal", id: "goal_m2" };
// A run's memory facts (the loop computes them; a model never does).
const facts = (over = {}) => ({
  taint: clean,
  audience: { kind: "workspace" },
  sourceSubjects: [],
  personMemoryLoaded: false,
  viewableTags: viewAll,
  subjectScope: { kinds: [], ids: [] },
  ...over,
});
const runFor = (memory, over = {}) => ({
  context: "routed",
  readTags: [],
  taint: memory.taint.kinds.includes("untrusted_external") ? "untrusted_external" : "none",
  agentTools: "on",
  memory,
  ...over,
});
const write = (lease, toolUseId, operation, memory = facts(), runOver = {}) =>
  underLease(lease, (query) =>
    notebookOperationStep(query, {
      toolUseId,
      operation,
      run: runFor(memory, runOver),
      viewer: allTags,
    }),
  );
const add = (title, text, over = {}) => ({
  op: "add",
  kind: "lesson",
  title,
  text,
  derivedFrom: [],
  ...over,
});
const search = (lease, memory, queries, layers = ["notebook", "knowledge"], limit = 20) =>
  underLease(lease, (query) => memorySearchForRun(query, memory, { queries, layers, limit }));
const read = (lease, memory, layer, itemId) =>
  underLease(lease, (query) => memoryReadForRun(query, memory, { layer, itemId }));
const entry = (id) =>
  db.rows(
    `SELECT id::text AS id,kind,title,body,read_tags,taint,derived_from,audience,source_subjects,agent_principal_id::text AS agent,requester_principal_id::text AS requester,renewals,use_count,erased_reason,erased_run_id::text AS erased_run,expires_at=renewed_at+interval '90 days' AS clocked FROM morrow_work.agent_notebook_entries WHERE id=${literal(id)}`,
  )[0];
const notebook = () =>
  db.rows(
    `SELECT revision::int AS revision,live_entries FROM morrow_work.agent_notebooks WHERE agent_principal_id=${literal(AGENT)}`,
  )[0];
// The v2 definer called directly (TypeScript bypassed): its own refusals.
const directWrite = (lease, args) =>
  underLeaseSql(
    lease,
    `SELECT outcome FROM morrow_work.run_notebook_write_v2(${args.map(literal).join(",")});`,
  )
    .split("\n")
    .at(-1);
const directArgs = (over = {}) => {
  const a = {
    toolUseId: "toolu_direct",
    op: "add",
    target: null,
    kind: "lesson",
    title: "Direct",
    text: "Direct note.",
    readTags: "[]",
    taint: JSON.stringify(clean),
    audience: '{"kind":"workspace"}',
    subjects: "[]",
    derivedFrom: "[]",
    viewable: JSON.stringify(viewAll),
    scope: '{"kinds":[],"ids":[]}',
    personMemory: "false",
    ...over,
  };
  return [
    a.toolUseId,
    a.op,
    a.target,
    a.kind,
    a.title,
    a.text,
    a.readTags,
    a.taint,
    a.audience,
    a.subjects,
    a.derivedFrom,
    a.viewable,
    a.scope,
    a.personMemory,
  ];
};
const ids = {};

test("M1 0057 is refused while any notebook entry exists, and re-keys the notebooks once none does", async () => {
  assert.deepEqual(db.applied.at(-1), 56);
  // A notebook entry written under 0052 (its installation-keyed definer).
  const lease = openRunLease("run_m1");
  assert.equal(
    underLeaseSql(
      lease,
      `SELECT outcome FROM morrow_work.run_notebook_write('toolu_m1','Written before the re-key.','[]');`,
      "COMMIT",
    )
      .split("\n")
      .at(-1),
    "applied",
  );
  const entry57 = loadMigrationChain().find((e) => e.sequence === 57);
  assert.equal(entry57.executeAs, "morrow_work_owner");
  const refused = psqlAs(db.id, d4Transaction(entry57), {
    user: administrator,
    allowFailure: true,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /MEMORY_FOUNDATION_NOTEBOOKS_NOT_EMPTY/);
  // Nothing of it stayed: no SET row, no new table, no extension, the 0052 columns.
  assert.equal(morrowSetRows(db.id), 0);
  assert.equal(scalar("SELECT to_regclass('morrow_work.memory_derivations') IS NULL;"), "t");
  assert.equal(scalar("SELECT count(*) FROM pg_extension WHERE extname='pg_trgm';"), "0");
  assert.equal(count("agent_notebook_entries", `installation_id=${literal(INSTALLATION)}`), 1);
  // The owner's maintenance removes the entry (the deployed notebooks are empty: agent_tools is
  // committed off), and the re-key applies.
  db.workOwner(
    "BEGIN; DELETE FROM morrow_work.agent_notebook_entries; DELETE FROM morrow_work.agent_notebooks; COMMIT;",
  );
  const applied = psqlAs(db.id, d4Transaction(entry57), {
    user: administrator,
    allowFailure: true,
  });
  assert.equal(applied.ok, true, applied.stderr);
  assert.equal(morrowSetRows(db.id), 0);
  assert.equal(
    scalar(
      "SELECT string_agg(a.attname,',' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid='morrow_work.agent_notebooks'::regclass AND a.attnum>0 AND NOT a.attisdropped;",
    ),
    "organization_id,workspace_id,revision,next_sequence,live_entries,created_at,updated_at,agent_principal_id",
  );
});

test("M2 the shape: pg_trgm reached only by the command role, FORCE RLS, 0052's notebook definers fail closed", () => {
  assert.equal(
    scalar(
      "SELECT concat_ws('|',e.extversion,n.nspname,n.nspowner::regrole::text,n.nspacl::text) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm';",
    ),
    "1.6|extensions|morrow_work_owner|{morrow_work_owner=UC/morrow_work_owner,morrow_work_command=U/morrow_work_owner}",
  );
  for (const role of [
    "morrow_work_api",
    "morrow_api_worker",
    "morrow_runtime_executor",
    "morrow_connector_ingress",
    "morrow_vault_broker",
    "morrow_identity_owner",
  ])
    assert.equal(scalar(`SELECT has_schema_privilege('${role}','extensions','USAGE');`), "f", role);
  for (const table of ["memory_derivations", "memory_repairs", "memory_settings"])
    assert.equal(
      scalar(
        `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='morrow_work.${table}'::regclass;`,
      ),
      "t",
      table,
    );
  // The index of an entry's text is an expression of the row: erasing the text erases it.
  assert.equal(
    scalar(
      "SELECT count(*) FROM pg_indexes WHERE schemaname='morrow_work' AND indexname IN ('agent_notebook_entries_document','agent_notebook_entries_trigram','knowledge_versions_trigram') AND indexdef LIKE '%WHERE (erased_at IS NULL)%';",
    ),
    "3",
  );
  // 0052's write and clear stay registered but cannot write on the re-keyed tables.
  const lease = openRunLease("run_m2");
  refusedSql(
    `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(lease.id)},${literal(lease.generation)}); SELECT outcome FROM morrow_work.run_notebook_write('toolu_m2','Old path.','[]'); COMMIT;`,
    /installation_id/,
    { user: "morrow_runtime_executor" },
  );
  refusedSql(
    asApi(
      P.A,
      `SELECT outcome FROM morrow_work.cmd_notebook_clear(${literal(randomUUID())},repeat('c',64),'corr-m2',${literal(INSTALLATION)},'1');`,
    ),
    /installation_id/,
    { user: "morrow_api_worker" },
  );
  assert.equal(count("agent_notebook_entries"), 0);
});

test("M3 notebook.write: the lease's own agent, replays, renewal, and never from an Ask, customer data or person memory", async () => {
  const lease = openRunLease("run_m3");
  // The v1.1 input: an add of a lesson titled from its first line.
  const first = await underLease(lease, (query) =>
    notebookWriteStep(query, {
      toolUseId: "toolu_m3_first",
      input: { text: "Linen shirt titles run long.\nKeep them under sixty characters." },
      run: runFor(facts(), { readTags: [tag("catalog.products.read")] }),
      viewer: allTags,
    }),
  );
  assert.equal(first.outcome, "ok");
  assert.equal(first.effect, "applied");
  assert.equal(first.replayed, false);
  ids.first = first.record.id;
  const row = entry(ids.first);
  assert.equal(row.agent, AGENT);
  assert.equal(row.requester, P.A.principal);
  assert.equal(row.kind, "lesson");
  assert.equal(row.title, "Linen shirt titles run long.");
  assert.deepEqual(row.audience, { kind: "workspace" });
  assert.deepEqual(row.source_subjects, []);
  assert.deepEqual(row.taint, clean);
  assert.deepEqual(row.derived_from, []);
  assert.equal(row.clocked, true);
  // The store's artifact tag on every entry, with the run's.
  assert.deepEqual(row.read_tags, [tag("catalog.products.read"), artifactTag]);
  // A replay returns the first record; the same call id with other content is a defect.
  const again = await underLease(lease, (query) =>
    notebookWriteStep(query, {
      toolUseId: "toolu_m3_first",
      input: { text: "Linen shirt titles run long.\nKeep them under sixty characters." },
      run: runFor(facts(), { readTags: [tag("catalog.products.read")] }),
      viewer: allTags,
    }),
  );
  assert.deepEqual(again, { ...first, replayed: true });
  await assert.rejects(
    write(lease, "toolu_m3_first", add("Other", "Other text.")),
    /RUNTIME_KNOWLEDGE_HELD/,
  );
  // The same lesson again (same scope and tags) is re-affirmed, not duplicated; its replay
  // returns the renewal without renewing again.
  const lesson = add("Care labels", "Care labels go on the left side seam.");
  const a = await write(lease, "toolu_m3_a", lesson);
  const renewed = await write(lease, "toolu_m3_b", lesson);
  assert.deepEqual(
    { effect: renewed.effect, id: renewed.record.id },
    { effect: "renewed", id: a.record.id },
  );
  assert.deepEqual(await write(lease, "toolu_m3_b", lesson), { ...renewed, replayed: true });
  assert.equal(entry(a.record.id).renewals, 1);
  assert.equal(entry(a.record.id).clocked, true);
  // Each renewing call keeps its own record (wave 5 review, H12A-R2): a later renewal never
  // makes an earlier call's replay renew again, and a replay after the entry is retired returns
  // the entry it renewed, never a new one.
  const hem = add("Hems", "Hems are double-stitched.");
  const h1 = await write(lease, "toolu_m3_h1", hem);
  const h2 = await write(lease, "toolu_m3_h2", hem);
  const h3 = await write(lease, "toolu_m3_h3", hem);
  assert.deepEqual(
    [h2.effect, h2.record.id, h3.effect, h3.record.id],
    ["renewed", h1.record.id, "renewed", h1.record.id],
  );
  const renewedRevision = notebook().revision;
  assert.deepEqual(await write(lease, "toolu_m3_h2", hem), { ...h2, replayed: true });
  assert.equal(entry(h1.record.id).renewals, 2);
  assert.equal(notebook().revision, renewedRevision);
  assert.deepEqual(
    db.rows(
      `SELECT tool_use_id,renewal FROM morrow_work.agent_notebook_renewals WHERE run_id='run_m3' AND tool_use_id LIKE 'toolu_m3_h%' ORDER BY renewal`,
    ),
    [
      { tool_use_id: "toolu_m3_h2", renewal: 1 },
      { tool_use_id: "toolu_m3_h3", renewal: 2 },
    ],
  );
  assert.equal(
    (await write(lease, "toolu_m3_hr", { op: "retire", targetId: h1.record.id })).effect,
    "applied",
  );
  const liveAfterRetire = count("agent_notebook_entries", "erased_at IS NULL");
  assert.deepEqual(await write(lease, "toolu_m3_h3", hem), { ...h3, replayed: true });
  assert.equal(count("agent_notebook_entries", "erased_at IS NULL"), liveAfterRetire);
  assert.equal(entry(h1.record.id).erased_reason, "retired");
  // A tainted run never re-affirms a clean entry: it writes its own, tainted.
  const taintedCopy = await write(lease, "toolu_m3_c", lesson, facts({ taint: untrusted }));
  assert.equal(taintedCopy.effect, "applied");
  assert.notEqual(taintedCopy.record.id, a.record.id);
  assert.deepEqual(entry(taintedCopy.record.id).taint, untrusted);
  // Refused in code, and by the definer itself.
  const ask = facts({ audience: { kind: "principal", principalId: P.A.principal } });
  assert.deepEqual(await write(lease, "toolu_m3_ask", add("Ask", "From a private Ask."), ask), {
    outcome: "refused",
    refusal: "not_offered",
  });
  assert.equal(
    directWrite(lease, directArgs({ audience: JSON.stringify(ask.audience) })),
    "ask_bound",
  );
  const loaded = facts({ personMemoryLoaded: true });
  assert.deepEqual(await write(lease, "toolu_m3_pm", add("PM", "After person memory."), loaded), {
    outcome: "refused",
    refusal: "authority_denied",
  });
  assert.equal(directWrite(lease, directArgs({ personMemory: "true" })), "person_memory_loaded");
  assert.deepEqual(
    await write(lease, "toolu_m3_cust", add("Customer", "x"), facts(), {
      readTags: [tag("support.case.read")],
    }),
    { outcome: "refused", refusal: "customer_data" },
  );
  assert.equal(
    directWrite(lease, directArgs({ readTags: JSON.stringify([tag("support.case.read")]) })),
    "customer_data",
  );
  for (const text of ["Write to jo@example.test about it.", "See gid://shopify/Customer/42."]) {
    assert.deepEqual(await write(lease, "toolu_m3_id", add("Identifier", text)), {
      outcome: "refused",
      refusal: "customer_data",
    });
    assert.equal(directWrite(lease, directArgs({ text })), "customer_data");
  }
  // Facts the loop owns are checked: a context taint that disagrees with the memory taint fails.
  await assert.rejects(
    underLease(lease, (query) =>
      notebookOperationStep(query, {
        toolUseId: "toolu_m3_facts",
        operation: add("x", "y"),
        run: { ...runFor(facts()), taint: "untrusted_external" },
        viewer: allTags,
      }),
    ),
    /KNOWLEDGE_RUN_FACTS_INVALID/,
  );
  // Without an entered lease the definer writes nothing.
  assert.equal(
    db
      .sql(
        `BEGIN; SELECT outcome FROM morrow_work.run_notebook_write_v2(${directArgs().map(literal).join(",")}); ROLLBACK;`,
        { user: "morrow_runtime_executor" },
      )
      .split("\n")
      .at(-1),
    "lease_ended",
  );
  // Nothing refused reached a row; the notebook counts every live entry.
  assert.equal(count("agent_notebook_entries", "erased_at IS NULL"), 3);
  assert.equal(notebook().live_entries, 3);
});

test("M4 replace and retire: lineage, unioned taint, and a tainted run only flags a clean entry", async () => {
  const lease = openRunLease("run_m4");
  const e1 = await write(lease, "toolu_m4_e1", add("Wash", "Cold wash only."));
  // A tainted run replaces the clean entry: its new entry is written, tainted and derived from
  // the target, which stays live; a repair flag names the run and its call.
  const op2 = {
    op: "replace",
    targetId: e1.record.id,
    kind: "correction",
    title: "Wash",
    text: "Hot wash is fine.",
    derivedFrom: [],
  };
  const e2 = await write(lease, "toolu_m4_e2", op2, facts({ taint: untrusted }));
  assert.equal(e2.effect, "flagged");
  assert.equal(entry(e1.record.id).erased_reason, null);
  const r2 = entry(e2.record.id);
  assert.deepEqual(r2.derived_from, [{ kind: "notebook_entry", id: e1.record.id }]);
  assert.deepEqual(r2.taint, untrusted);
  assert.equal(
    count(
      "memory_repairs",
      `target_id=${literal(e1.record.id)} AND reason='tainted_flag' AND status='open' AND run_id='run_m4' AND tool_use_id='toolu_m4_e2'`,
    ),
    1,
  );
  assert.equal(
    count(
      "memory_derivations",
      `derived_id=${literal(e2.record.id)} AND source_kind='notebook_entry' AND source_id=${literal(e1.record.id)}`,
    ),
    1,
  );
  assert.deepEqual(await write(lease, "toolu_m4_e2", op2, facts({ taint: untrusted })), {
    ...e2,
    replayed: true,
  });
  // A tainted retire of the clean entry is only a flag (no entry), replayed as such.
  const retire1 = { op: "retire", targetId: e1.record.id };
  const flagged = await write(lease, "toolu_m4_r1", retire1, facts({ taint: untrusted }));
  assert.deepEqual(flagged, { outcome: "ok", effect: "flagged", record: null, replayed: false });
  assert.deepEqual(await write(lease, "toolu_m4_r1", retire1, facts({ taint: untrusted })), {
    ...flagged,
    replayed: true,
  });
  assert.equal(entry(e1.record.id).erased_reason, null);
  // A clean run replaces the tainted entry: the new entry inherits its taint (sticky), the target
  // is retired by this call.
  const op3 = {
    op: "replace",
    targetId: e2.record.id,
    kind: "lesson",
    title: "Wash",
    text: "Cold wash; the hot-wash note was wrong.",
    derivedFrom: [],
  };
  const e3 = await write(lease, "toolu_m4_e3", op3);
  assert.equal(e3.effect, "applied");
  const r3 = entry(e3.record.id);
  assert.deepEqual(r3.taint, untrusted);
  assert.deepEqual(
    db.rows(
      `SELECT erased_reason,erased_run_id::text AS run,erased_tool_use_id AS tool,title IS NULL AND body IS NULL AS gone FROM morrow_work.agent_notebook_entries WHERE id=${literal(e2.record.id)}`,
    )[0],
    { erased_reason: "retired", run: "run_m4", tool: "toolu_m4_e3", gone: true },
  );
  assert.deepEqual(await write(lease, "toolu_m4_e3", op3), { ...e3, replayed: true });
  // A clean run retires a clean entry; its replay says so; a retired or absent target is out of
  // scope, never an error.
  const retire = { op: "retire", targetId: e1.record.id };
  const done = await write(lease, "toolu_m4_r2", retire);
  assert.deepEqual(done, { outcome: "ok", effect: "applied", record: null, replayed: false });
  assert.deepEqual(await write(lease, "toolu_m4_r2", retire), { ...done, replayed: true });
  assert.deepEqual(await write(lease, "toolu_m4_r3", retire), {
    outcome: "refused",
    refusal: "id_out_of_scope",
  });
  assert.deepEqual(await write(lease, "toolu_m4_r4", { op: "retire", targetId: randomUUID() }), {
    outcome: "refused",
    refusal: "id_out_of_scope",
  });
  // A source the run may not read is out of scope: an entry tagged with a tag it cannot view.
  const narrow = facts({ viewableTags: [knowledgeTag] });
  assert.deepEqual(
    await write(
      lease,
      "toolu_m4_narrow",
      add("x", "y", { derivedFrom: [{ kind: "notebook_entry", id: e3.record.id }] }),
      narrow,
    ),
    { outcome: "refused", refusal: "id_out_of_scope" },
  );
  ids.wash = e3.record.id;
});

test("M5 deletion follows the source: a deleted page erases every live entry derived from it, however indirectly", async () => {
  const page = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "policy",
    title: "Shipping",
    text: "Coast deliveries take one extra day. Albatrossberry.",
    sources: [],
  });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  const pageId = page.body.pageId;
  const lease = openRunLease("run_m5");
  const ref = { kind: "knowledge_page", id: pageId };
  const e4 = await write(
    lease,
    "toolu_m5_e4",
    add("Coast", "Say coast orders take a day more.", { derivedFrom: [ref] }),
  );
  assert.deepEqual(entry(e4.record.id).read_tags, [artifactTag, knowledgeTag]);
  // Replacing it, then deriving from the replacement: the page joins each new entry's lineage.
  const e5 = await write(lease, "toolu_m5_e5", {
    op: "replace",
    targetId: e4.record.id,
    kind: "lesson",
    title: "Coast",
    text: "Coast orders take one more day; say so in shipping copy.",
    derivedFrom: [],
  });
  const e6 = await write(
    lease,
    "toolu_m5_e6",
    add("Coast copy", "Shipping copy names the coast delay.", {
      derivedFrom: [{ kind: "notebook_entry", id: e5.record.id }],
    }),
  );
  for (const e of [e5, e6])
    assert.ok(
      entry(e.record.id).derived_from.some((r) => r.kind === "knowledge_page" && r.id === pageId),
      "closed over the page",
    );
  // A new version flags them (stale, never expired).
  const v2 = await send(open, P.A, "POST", `/knowledge/pages/${pageId}/versions`, {
    expectedVersion: 1,
    title: "Shipping",
    text: "Coast deliveries take two extra days. Albatrossberry.",
    sources: [],
  });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  for (const e of [e5, e6])
    assert.equal(
      count(
        "memory_repairs",
        `target_id=${literal(e.record.id)} AND reason='source_changed' AND status='open'`,
      ),
      1,
    );
  assert.equal(entry(e5.record.id).erased_reason, null);
  // The deletion erases both, in its own transaction, with a content-free repair each.
  const before = notebook();
  const deleted = await send(open, P.A, "POST", `/knowledge/pages/${pageId}/delete`, {
    expectedVersion: 2,
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  for (const e of [e5, e6]) {
    const r = entry(e.record.id);
    assert.deepEqual(
      { reason: r.erased_reason, title: r.title, body: r.body },
      { reason: "source_erased", title: null, body: null },
    );
    assert.equal(
      count(
        "memory_repairs",
        `target_id=${literal(e.record.id)} AND reason='source_erased' AND source_kind='knowledge_page' AND source_id=${literal(pageId)}`,
      ),
      1,
    );
  }
  const now = notebook();
  assert.equal(now.live_entries, before.live_entries - 2);
  assert.ok(now.revision > before.revision);
  // A deleted page cannot be named again.
  assert.deepEqual(
    await write(lease, "toolu_m5_late", add("Late", "Late note.", { derivedFrom: [ref] })),
    {
      outcome: "refused",
      refusal: "id_out_of_scope",
    },
  );
});

test("M6 a write racing a page's deletion: the deletion waits for it, then erases the new entry with the page", async () => {
  const page = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "decision",
    title: "Suppliers",
    text: "We buy linen from one mill. Shearwaterberry.",
    sources: [],
  });
  assert.equal(page.status, 201);
  const pageId = page.body.pageId;
  const lease = openRunLease("run_m6");
  const run = await db.connector({ user: "morrow_runtime_executor" }).open({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120000,
    waitUntil() {},
  });
  const signal = new AbortController().signal;
  const query = async (sql, values = []) => (await run.query(sql, [...values], signal)).rows;
  let written;
  try {
    await query("BEGIN");
    await query("SELECT outcome FROM morrow_work.enter_lease($1,$2)", [lease.id, lease.generation]);
    written = await notebookOperationStep(query, {
      toolUseId: "toolu_m6",
      operation: add("Mill", "One linen mill supplies us.", {
        derivedFrom: [{ kind: "knowledge_page", id: pageId }],
      }),
      run: runFor(facts()),
      viewer: allTags,
    });
    assert.equal(written.effect, "applied");
    // The person's deletion starts while the write holds the page's share lock: it waits.
    const deletion = send(open, P.A, "POST", `/knowledge/pages/${pageId}/delete`, {
      expectedVersion: 1,
    });
    // (Every api connection of the lab's connector is named morrow_work_lab_*; the run's own
    // connection is idle in its transaction, not waiting.)
    assert.ok(
      await db.waitForLockWait("application_name LIKE 'morrow\\_work\\_lab\\_%'"),
      "the deletion waits on the write",
    );
    await query("COMMIT");
    const deleted = await deletion;
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  } finally {
    await query("ROLLBACK").catch(() => {});
    await run.close();
  }
  assert.equal(entry(written.record.id).erased_reason, "source_erased");
  assert.equal(entry(written.record.id).body, null);
});

test("M7 memory.search ranks only what the reader may read: every predicate before ranking", async () => {
  const lease = openRunLease("run_m7");
  const page = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "policy",
    title: "Linen care",
    text: "Linen shirts: cold wash, line dry. Puffinberry.",
    sources: [],
  });
  assert.equal(page.status, 201);
  const pageId = page.body.pageId;
  // Entries of every scope: the workspace's, a project's (goal G1, written by a run working on
  // it), one tagged with the catalogue, and a tainted one.
  const ew = await write(
    lease,
    "toolu_m7_w",
    add("Puffinberry linen", "Puffinberry linen shirts sell in spring."),
  );
  const g1 = facts({
    audience: { kind: "subject", subject: G1 },
    sourceSubjects: [G1],
    subjectScope: { kinds: [], ids: [G1] },
  });
  const eg = await write(
    lease,
    "toolu_m7_g",
    add("Puffinberry project", "Puffinberry launch copy is for the spring project."),
    g1,
  );
  assert.deepEqual(entry(eg.record.id).source_subjects, [G1]);
  const ec = await write(
    lease,
    "toolu_m7_c",
    add("Puffinberry catalogue", "Puffinberry product titles carry the colour."),
    facts(),
    { readTags: [tag("catalog.products.read")] },
  );
  const et = await write(
    lease,
    "toolu_m7_t",
    add("Puffinberry rumour", "Puffinberry stock may run out."),
    facts({ taint: untrusted }),
  );
  const found = async (memory, queries = ["puffinberry"], layers, limit) =>
    (await search(lease, memory, queries, layers, limit)).map((h) => h.itemId);
  // A workspace-audience reader with the artifact and knowledge tags: the workspace's entries
  // and the page, never the project's (its audience) or the catalogue's (its tag).
  const workspaceReader = facts({ viewableTags: [artifactTag, knowledgeTag] });
  const w = await found(workspaceReader);
  assert.ok(
    w.includes(ew.record.id) && w.includes(et.record.id) && w.includes(pageId),
    JSON.stringify(w),
  );
  assert.ok(!w.includes(eg.record.id) && !w.includes(ec.record.id), JSON.stringify(w));
  // The project's run sees the project's entry; another project's does not; a private Ask whose
  // owner may view the project does (subject rows reach a person's private work).
  assert.ok((await found(g1)).includes(eg.record.id));
  const g2 = facts({
    audience: { kind: "subject", subject: G2 },
    sourceSubjects: [G2],
    subjectScope: { kinds: ["goal"], ids: [] },
  });
  assert.ok(!(await found(g2)).includes(eg.record.id));
  const ask = facts({
    audience: { kind: "principal", principalId: P.A.principal },
    subjectScope: { kinds: [], ids: [G1] },
  });
  assert.ok((await found(ask)).includes(eg.record.id));
  // The same Ask without a view of the project: the source-subject rule drops it.
  const blindAsk = facts({ audience: ask.audience, subjectScope: { kinds: [], ids: [] } });
  assert.ok(!(await found(blindAsk)).includes(eg.record.id));
  // The oracles agree with SQL on these cases.
  assert.equal(memoryAudienceReadable({ kind: "subject", subject: G1 }, g2.audience), false);
  assert.equal(memoryAudienceReadable({ kind: "subject", subject: G1 }, ask.audience), true);
  assert.equal(memorySubjectsViewable([G1], blindAsk.subjectScope), false);
  // The limit applies after the predicates: a reader who may see one entry gets it at limit 1.
  const onlyArtifact = facts({ viewableTags: [artifactTag] });
  const top = await search(lease, onlyArtifact, ["puffinberry"], ["notebook"], 1);
  assert.equal(top.length, 1);
  assert.ok([ew.record.id, et.record.id].includes(top[0].itemId));
  // Best first: the entry that matches both queries by both signals leads.
  const best = await search(lease, workspaceReader, ["puffinberry linen", "spring"]);
  assert.equal(best[0].itemId, ew.record.id, JSON.stringify(best.map((h) => [h.itemId, h.score])));
  // Hits carry their trust class, tags and taint.
  const hits = await search(lease, workspaceReader, ["puffinberry"]);
  const tainted = hits.find((h) => h.itemId === et.record.id);
  assert.deepEqual(tainted.taint, untrusted);
  assert.equal(tainted.trust, "agent_lesson");
  assert.equal(tainted.requesterPrincipalId, P.A.principal);
  const pageHit = hits.find((h) => h.itemId === pageId);
  assert.deepEqual(
    { trust: pageHit.trust, version: pageHit.version, taint: pageHit.taint },
    { trust: "approved_knowledge", version: 1, taint: clean },
  );
  // The trigram half finds a misspelling the full-text half cannot.
  assert.ok((await found(workspaceReader, ["puffinbery"])).includes(ew.record.id));
  // A layer is searched only when asked for.
  assert.deepEqual(await found(workspaceReader, ["puffinberry"], ["knowledge"]), [pageId]);
  // No lease, no rows; malformed facts are a defect before any SQL.
  assert.equal(
    db
      .sql(
        `SELECT count(*) FROM morrow_work.run_memory_search('["puffinberry"]','["notebook"]','[]','{"kinds":[],"ids":[]}','{"kind":"workspace"}','5');`,
        { user: "morrow_runtime_executor" },
      )
      .split("\n")
      .at(-1),
    "0",
  );
  await assert.rejects(
    search(lease, { ...workspaceReader, audience: { kind: "everyone" } }, ["x"]),
    /RUNTIME_MEMORY_HELD/,
  );
  ids.ew = ew.record.id;
  ids.eg = eg.record.id;
  ids.et = et.record.id;
  ids.page = pageId;
});

test("M8 memory.read opens one item under the same predicates; only clean reads of clean entries count", async () => {
  const lease = openRunLease("run_m8");
  const reader = facts({ viewableTags: [artifactTag, knowledgeTag] });
  const item = await read(lease, reader, "notebook", ids.ew);
  assert.equal(item.text, "Puffinberry linen shirts sell in spring.");
  assert.equal(item.trust, "agent_lesson");
  assert.deepEqual(item.sourceSubjects, []);
  // Two reads within the same millisecond both count (the count moves without its time).
  underLeaseSql(
    lease,
    `SELECT count(*) FROM morrow_work.run_memory_read('notebook',${literal(ids.ew)},${literal(JSON.stringify(reader.viewableTags))},'{"kinds":[],"ids":[]}','{"kind":"workspace"}','false') first_read,morrow_work.run_memory_read('notebook',${literal(ids.ew)},${literal(JSON.stringify(reader.viewableTags))},'{"kinds":[],"ids":[]}','{"kind":"workspace"}','false') second_read;`,
    "COMMIT",
  );
  assert.equal(entry(ids.ew).use_count, 3);
  // A tainted run's read and a read of a tainted entry count nothing.
  await read(lease, facts({ ...reader, taint: untrusted }), "notebook", ids.ew);
  await read(lease, reader, "notebook", ids.et);
  assert.equal(entry(ids.ew).use_count, 3);
  assert.equal(entry(ids.et).use_count, 0);
  // Out of reach is the same as absent.
  assert.equal(await read(lease, reader, "notebook", ids.eg), null);
  assert.equal(
    await read(lease, facts({ viewableTags: [knowledgeTag] }), "notebook", ids.ew),
    null,
  );
  assert.equal(await read(lease, reader, "notebook", randomUUID()), null);
  // A page, in full, with its version; no use count.
  const page = await read(lease, reader, "knowledge", ids.page);
  assert.deepEqual(
    { text: page.text, version: page.version, trust: page.trust },
    {
      text: "Linen shirts: cold wash, line dry. Puffinberry.",
      version: 1,
      trust: "approved_knowledge",
    },
  );
  assert.equal(
    await read(lease, facts({ viewableTags: [artifactTag] }), "knowledge", ids.page),
    null,
  );
});

test("M9 the 90-day clock: past it an entry is out of reach, and the sweep's handler erases it", async () => {
  const lease = openRunLease("run_m9");
  // An entry whose clock ran out (owner-seeded, backdated 91 days).
  const id = randomUUID();
  const O = P.A.org,
    W = P.A.workspace;
  db.workOwner(`BEGIN;
UPDATE morrow_work.agent_notebooks SET next_sequence=next_sequence+1,live_entries=live_entries+1,revision=revision+1 WHERE agent_principal_id=${literal(AGENT)};
INSERT INTO morrow_work.agent_notebook_entries(organization_id,workspace_id,agent_principal_id,sequence,id,kind,title,body,read_tags,taint,derived_from,audience,source_subjects,requester_principal_id,requester_membership_id,run_id,tool_use_id,digest,created_at,renewed_at,renewals,use_count,last_used_at,expires_at)
SELECT ${literal(O)},${literal(W)},${literal(AGENT)},n.next_sequence-1,${literal(id)},'lesson','Old','Gannetberry is old news.','[{"storeId":"${STORE}","capability":"workspace.artifact.read"}]','{"kinds":[],"sources":[],"omitted":0}','[]','{"kind":"workspace"}','[]',${literal(P.A.principal)},${literal(P.A.membership)},'run_m9_old','toolu_old',morrow_work.memory_entry_digest('lesson','Old','Gannetberry is old news.'),t,t,0,0,NULL,t+interval '90 days'
FROM morrow_work.agent_notebooks n,(SELECT date_trunc('milliseconds',clock_timestamp())-interval '91 days' AS t) x WHERE n.agent_principal_id=${literal(AGENT)};
COMMIT;`);
  const reader = facts({ viewableTags: [artifactTag, knowledgeTag] });
  assert.deepEqual((await search(lease, reader, ["gannetberry"])).length, 0);
  assert.equal(await read(lease, reader, "notebook", id), null);
  assert.deepEqual(await write(lease, "toolu_m9_r", { op: "retire", targetId: id }), {
    outcome: "refused",
    refusal: "id_out_of_scope",
  });
  const before = notebook();
  refusedSql(
    `SET ROLE morrow_work_owner; SELECT morrow_work.memory_erase_expired(${literal(O)},${literal(W)},clock_timestamp(),0);`,
    /MEMORY_SWEEP_INVALID/,
  );
  assert.equal(
    scalar(
      `SET ROLE morrow_work_owner; SELECT morrow_work.memory_erase_expired(${literal(O)},${literal(W)},date_trunc('milliseconds',clock_timestamp()),100);`,
    ),
    "1",
  );
  const r = entry(id);
  assert.deepEqual(
    { reason: r.erased_reason, title: r.title, body: r.body },
    { reason: "expired", title: null, body: null },
  );
  assert.equal(notebook().live_entries, before.live_entries - 1);
});

test("M10 a person's clear: hidden and project-scoped entries block it; then it erases at the revision its check read", async () => {
  // The agent page shows A the workspace's entries A may see, never a project's (until H9c gives
  // people their subject view) and never B, who may not view the store's artifacts.
  const page = await send(open, P.A, "GET", `/agents/${INSTALLATION}/notebook`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const shown = page.body.entries.map((e) => e.id);
  assert.ok(shown.includes(ids.ew) && !shown.includes(ids.eg), JSON.stringify(shown));
  for (const e of page.body.entries) assert.ok(validateCurrentDefinition("NotebookEntry", e));
  assert.deepEqual(
    (await send(open, P.B, "GET", `/agents/${INSTALLATION}/notebook`)).body.entries,
    [],
  );
  // The project's entry cannot be shown, so no one clears the notebook blind.
  const blocked = await send(open, P.A, "POST", `/agents/${INSTALLATION}/notebook/clear`, {});
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.equal(count("agent_notebook_entries", `id=${literal(ids.eg)} AND erased_at IS NULL`), 1);
  // A run of that project retires it; then A clears every live entry.
  const lease = openRunLease("run_m10");
  const g1 = facts({
    audience: { kind: "subject", subject: G1 },
    sourceSubjects: [G1],
    subjectScope: { kinds: [], ids: [G1] },
  });
  assert.equal(
    (await write(lease, "toolu_m10", { op: "retire", targetId: ids.eg }, g1)).effect,
    "applied",
  );
  const live = count("agent_notebook_entries", "erased_at IS NULL");
  assert.ok(live > 0);
  // The definer refuses any other revision under its lock (TypeScript bypassed).
  const revision = notebook().revision;
  for (const expected of [revision - 1, revision + 1])
    assert.equal(
      db
        .sql(
          asApi(
            P.A,
            `SELECT outcome FROM morrow_work.cmd_notebook_clear_v2(${literal(randomUUID())},repeat('c',64),'corr-m10',${literal(INSTALLATION)},${literal(String(expected))});`,
          ),
          { user: "morrow_api_worker" },
        )
        .split("\n")
        .at(-1),
      "revision_conflict",
    );
  const cleared = await send(open, P.A, "POST", `/agents/${INSTALLATION}/notebook/clear`, {});
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body, {
    schemaVersion: 1,
    installationId: INSTALLATION,
    entriesErased: live,
  });
  assert.equal(
    count("agent_notebook_entries", "erased_at IS NULL OR body IS NOT NULL OR title IS NOT NULL"),
    0,
  );
  assert.equal(notebook().live_entries, 0);
  assert.equal(count("agent_notebook_entries", "erased_reason='cleared'"), live);
});

test("M11 no runtime role deletes or rewrites memory; each row changes only as its guard allows", () => {
  const anyEntry = scalar("SELECT id FROM morrow_work.agent_notebook_entries LIMIT 1;");
  const command = (statements) => asCommandRole(P.A, statements);
  refusedSql(
    command(
      `UPDATE morrow_work.agent_notebook_entries SET renewals=renewals+1 WHERE id=${literal(anyEntry)};`,
    ),
    /AGENT_NOTEBOOK_INVALID|permission denied/,
  );
  refusedSql(command(`DELETE FROM morrow_work.agent_notebook_entries;`), /permission denied/);
  for (const table of [
    "memory_derivations",
    "memory_repairs",
    "memory_settings",
    "agent_notebook_renewals",
  ]) {
    refusedSql(command(`DELETE FROM morrow_work.${table};`), /permission denied/);
    refusedSql(command(`TRUNCATE morrow_work.${table};`), /permission denied/);
  }
  refusedSql(
    command(`UPDATE morrow_work.memory_derivations SET source_id=source_id;`),
    /permission denied/,
  );
  refusedSql(
    `SET ROLE morrow_work_owner; UPDATE morrow_work.memory_derivations SET created_at=created_at;`,
    /WORK_RECORD_IMMUTABLE/,
  );
  // A renewing call's record never changes, so its replay always finds what it renewed.
  refusedSql(
    command(`UPDATE morrow_work.agent_notebook_renewals SET renewal=renewal;`),
    /permission denied/,
  );
  refusedSql(
    `SET ROLE morrow_work_owner; UPDATE morrow_work.agent_notebook_renewals SET renewal=renewal;`,
    /WORK_RECORD_IMMUTABLE/,
  );
  // A repair resolves once; it never reopens.
  const repair = scalar("SELECT id FROM morrow_work.memory_repairs WHERE status='open' LIMIT 1;");
  db.sql(
    asCommandRole(
      P.A,
      `UPDATE morrow_work.memory_repairs SET status='resolved',resolved_at=date_trunc('milliseconds',clock_timestamp()),expires_at=date_trunc('milliseconds',clock_timestamp())+interval '365 days' WHERE id=${literal(repair)};`,
      { end: "COMMIT" },
    ),
  );
  assert.equal(count("memory_repairs", `id=${literal(repair)} AND status='resolved'`), 1);
  refusedSql(
    command(
      `UPDATE morrow_work.memory_repairs SET status='open',resolved_at=NULL,expires_at=NULL WHERE id=${literal(repair)};`,
    ),
    /MEMORY_REPAIR_INVALID/,
  );
  // Settings are born at revision 1 (H12b writes them).
  refusedSql(
    command(
      `INSERT INTO morrow_work.memory_settings VALUES(${literal(P.A.org)},${literal(P.A.workspace)},${literal(P.A.principal)},${literal(P.A.membership)},2,'on','private_chats',date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()));`,
    ),
    /MEMORY_SETTINGS_INVALID/,
  );
  // The api login reads repairs and settings in its tenant, never the lineage.
  refusedSql(
    asApi(P.A, "SELECT count(*) FROM morrow_work.memory_derivations;"),
    /permission denied/,
    { user: "morrow_api_worker" },
  );
  assert.equal(
    db
      .sql(asApi(P.Y, "SELECT count(*) FROM morrow_work.memory_repairs;"), {
        user: "morrow_api_worker",
      })
      .split("\n")
      .at(-1),
    "0",
  );
  // The taint union is the oracle's: sticky kinds, distinct sources.
  assert.deepEqual(memoryTaintUnion(untrusted, untrusted), untrusted);
});

test("M12 the deletion path takes the notebook before its entries: a clear racing a page deletion waits, never deadlocks", async () => {
  // Wave 5 review, H12A-R5: every notebook definer locks the notebook, then its entries; the
  // deletion path now does the same, so neither side holds what the other waits for.
  const page = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "decision",
    title: "Dyes",
    text: "We dye with plant colours only. Kittiwakeberry.",
    sources: [],
  });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  const pageId = page.body.pageId;
  const lease = openRunLease("run_m12");
  const derived = await write(
    lease,
    "toolu_m12",
    add("Dyes", "Plant dyes only.", { derivedFrom: [{ kind: "knowledge_page", id: pageId }] }),
  );
  assert.equal(derived.effect, "applied");
  // cmd_notebook_clear_v2's own statements, in its order (the notebook FOR UPDATE, then every
  // live entry), in a session held open between the two.
  const session = await db.connector({ user: "postgres" }).open({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 120000,
    waitUntil() {},
  });
  const signal = new AbortController().signal;
  const q = async (text) => (await session.query(text, [], signal)).rows;
  const at = "date_trunc('milliseconds',clock_timestamp())";
  try {
    await q("BEGIN");
    await q("SET LOCAL ROLE morrow_work_owner");
    await q(
      `SELECT revision FROM morrow_work.agent_notebooks WHERE agent_principal_id=${literal(AGENT)} FOR UPDATE`,
    );
    // The person's page deletion starts: its trigger reaches the notebook and waits there,
    // holding none of its entries.
    const deletion = send(open, P.A, "POST", `/knowledge/pages/${pageId}/delete`, {
      expectedVersion: 1,
    });
    assert.ok(
      await db.waitForLockWait("usename='morrow_api_worker'"),
      "the deletion waits on the notebook",
    );
    // The clear goes on to the entries: nothing holds them, so it neither waits nor deadlocks.
    await q(
      `UPDATE morrow_work.agent_notebook_entries SET title=NULL,body=NULL,erased_at=greatest(${at},renewed_at),erased_reason='cleared' WHERE agent_principal_id=${literal(AGENT)} AND erased_at IS NULL`,
    );
    await q(
      `UPDATE morrow_work.agent_notebooks SET live_entries=0,revision=revision+1,updated_at=greatest(${at},updated_at) WHERE agent_principal_id=${literal(AGENT)}`,
    );
    await q("COMMIT");
    const deleted = await deletion;
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  } finally {
    await q("ROLLBACK").catch(() => {});
    await session.close();
  }
  // The clear erased the entry first; the deletion then found nothing of it left to erase.
  assert.equal(entry(derived.record.id).erased_reason, "cleared");
  assert.equal(
    count("memory_repairs", `target_id=${literal(derived.record.id)} AND reason='source_erased'`),
    0,
  );
  assert.equal(notebook().live_entries, 0);
});

test("M13 the notebook's bounds: a tainted run at the cap never erases a clean entry; an overflow is a refusal, never a held step", async () => {
  const lease = openRunLease("run_m13");
  const live = () => count("agent_notebook_entries", "erased_at IS NULL");
  assert.equal(live(), 0);
  // 1,000 clean entries, owner-seeded in one statement, renewed oldest first (cap_1 the oldest).
  db.workOwner(`BEGIN;
UPDATE morrow_work.agent_notebooks SET next_sequence=next_sequence+1000,live_entries=1000,revision=revision+1 WHERE agent_principal_id=${literal(AGENT)};
INSERT INTO morrow_work.agent_notebook_entries(organization_id,workspace_id,agent_principal_id,sequence,id,kind,title,body,read_tags,taint,derived_from,audience,source_subjects,requester_principal_id,requester_membership_id,run_id,tool_use_id,digest,created_at,renewed_at,renewals,use_count,expires_at)
SELECT n.organization_id,n.workspace_id,n.agent_principal_id,n.next_sequence-1001+g,gen_random_uuid()::text,'lesson','Cap '||g,'Cap note '||g,${literal(JSON.stringify([artifactTag]))},'{"kinds":[],"sources":[],"omitted":0}','[]','{"kind":"workspace"}','[]',${literal(P.A.principal)},${literal(P.A.membership)},'run_m13_seed','toolu_cap_'||g,morrow_work.memory_entry_digest('lesson','Cap '||g,'Cap note '||g),t-(1001-g)*interval '1 second',t-(1001-g)*interval '1 second',0,0,t-(1001-g)*interval '1 second'+interval '90 days'
 FROM morrow_work.agent_notebooks n,generate_series(1,1000) g,(SELECT date_trunc('milliseconds',clock_timestamp()) AS t) x WHERE n.agent_principal_id=${literal(AGENT)};
COMMIT;`);
  assert.equal(live(), 1000);
  const seeded = (g) =>
    scalar(`SELECT id FROM morrow_work.agent_notebook_entries WHERE tool_use_id='toolu_cap_${g}';`);
  const oldest = seeded(1),
    newest = seeded(1000);
  const tainted = facts({ taint: untrusted });
  const flags = () => count("memory_repairs", "reason='tainted_flag'");
  const superseded = () => count("agent_notebook_entries", "erased_reason='superseded'");
  const unchanged = [1000, flags(), superseded(), notebook().revision];
  const state = () => [live(), flags(), superseded(), notebook().revision];
  // Wave 5 review, H12A-R1. With no tainted entry to supersede, a tainted run at the cap is
  // refused and writes nothing: no flag, no entry, no supersede (before, its replace flagged the
  // oldest clean entry and then superseded that very entry).
  const replaceOldest = {
    op: "replace",
    targetId: oldest,
    kind: "correction",
    title: "Cap",
    text: "A tainted correction of the oldest note.",
    derivedFrom: [],
  };
  const full = { outcome: "refused", refusal: "pending_limit" };
  assert.deepEqual(await write(lease, "toolu_m13_r1", replaceOldest, tainted), full);
  assert.deepEqual(
    await write(lease, "toolu_m13_a1", add("Rumour", "A tainted rumour."), tainted),
    full,
  );
  assert.deepEqual(state(), unchanged);
  assert.equal(entry(oldest).erased_reason, null);
  // A clean retire frees one place, and a tainted add takes it.
  assert.equal(
    (await write(lease, "toolu_m13_ret", { op: "retire", targetId: newest })).effect,
    "applied",
  );
  const t1 = await write(lease, "toolu_m13_t1", add("Rumour", "A tainted rumour."), tainted);
  assert.equal(t1.effect, "applied");
  assert.equal(live(), 1000);
  // Now the tainted replace flags the oldest clean entry and supersedes the one tainted entry,
  // never its own target; its replay returns what it did.
  const flagged = await write(lease, "toolu_m13_r2", replaceOldest, tainted);
  assert.equal(flagged.effect, "flagged");
  assert.equal(entry(oldest).erased_reason, null);
  assert.equal(entry(t1.record.id).erased_reason, "superseded");
  assert.deepEqual(entry(flagged.record.id).derived_from, [{ kind: "notebook_entry", id: oldest }]);
  assert.equal(
    count(
      "memory_repairs",
      `target_id=${literal(oldest)} AND reason='tainted_flag' AND tool_use_id='toolu_m13_r2'`,
    ),
    1,
  );
  assert.equal(live(), 1000);
  assert.deepEqual(await write(lease, "toolu_m13_r2", replaceOldest, tainted), {
    ...flagged,
    replayed: true,
  });
  // A clean run at the cap still supersedes the least recently renewed entry.
  assert.equal(
    (await write(lease, "toolu_m13_c1", add("Clean", "A clean lesson at the cap."))).effect,
    "applied",
  );
  assert.equal(entry(oldest).erased_reason, "superseded");
  assert.equal(live(), 1000);

  // Wave 5 review, H12A-R3. What the definer's unions carry past an entry's bounds is a refusal
  // of the input as composed, never 'invalid' (which the step holds, and the loop would retry
  // forever). Subjects: a run on 32 projects names an entry from a 33rd.
  const overflow = { outcome: "invalid_input", refusal: "input_invalid" };
  const G33 = { kind: "goal", id: "goal_m13_other" };
  const source = await write(
    lease,
    "toolu_m13_s",
    add("Other project", "A lesson from another project."),
    facts({ sourceSubjects: [G33], subjectScope: { kinds: ["goal"], ids: [] } }),
  );
  assert.equal(source.effect, "applied");
  const projects = Array.from({ length: 32 }, (_, i) => ({
    kind: "goal",
    id: "goal_m13_" + String(i).padStart(2, "0"),
  }));
  const before = state();
  assert.deepEqual(
    await write(
      lease,
      "toolu_m13_subjects",
      add("Many", "Derived across projects.", {
        derivedFrom: [{ kind: "notebook_entry", id: source.record.id }],
      }),
      facts({ sourceSubjects: projects, subjectScope: { kinds: ["goal"], ids: [] } }),
    ),
    overflow,
  );
  // Lineage: a replace naming 64 sources reaches 65 references with its target.
  const ids65 = db
    .rows(
      `SELECT id::text AS id FROM morrow_work.agent_notebook_entries WHERE tool_use_id LIKE 'toolu_cap_%' AND erased_at IS NULL ORDER BY sequence LIMIT 65`,
    )
    .map((r) => r.id);
  assert.equal(ids65.length, 65);
  assert.deepEqual(
    await write(lease, "toolu_m13_lineage", {
      op: "replace",
      targetId: ids65[64],
      kind: "lesson",
      title: "Everything",
      text: "A summary of 64 notes.",
      derivedFrom: ids65.slice(0, 64).map((id) => ({ kind: "notebook_entry", id })),
    }),
    overflow,
  );
  // Read tags: a run holding 24 tags, plus the store's artifact tag on every entry, makes 25.
  const tags24 = Array.from({ length: 24 }, (_, i) =>
    tag("catalog.products.read", "store_t" + String(i).padStart(2, "0")),
  );
  assert.deepEqual(
    await write(lease, "toolu_m13_tags", add("Tags", "Across many stores."), facts(), {
      readTags: tags24,
    }),
    overflow,
  );
  assert.deepEqual(state(), before);
  // A notebook whose million sequences are used takes no new entry: a refusal, not a defect.
  db.workOwner(
    `UPDATE morrow_work.agent_notebooks SET next_sequence=1000001,revision=revision+1 WHERE agent_principal_id=${literal(AGENT)};`,
  );
  assert.deepEqual(await write(lease, "toolu_m13_last", add("Last", "One note too many.")), full);
});
