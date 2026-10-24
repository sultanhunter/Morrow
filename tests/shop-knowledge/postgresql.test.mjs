// lab:shop-knowledge (PR 20; docs/briefs/shop-knowledge.md): the knowledge and notebook routes
// through the real handler, and the agent tools' server-side commands through a fake caller
// under a real run lease, against PostgreSQL 17 with the whole migration manifest applied by
// the Neon-shaped createrole administrator. The committed switch answers 503 with no connection;
// with the routes on (this lab's own configuration, never a committed one) a person writes
// pages and versions with sources; every read, list and search is filtered per viewer by read
// tags under live grants (ADR-0031 item 6), and another tenant sees nothing; customer-tagged
// content is refused by CHECK and by the propose step; an agent proposes through
// knowledge.propose (grants nothing, idempotent per run and tool call, a page the run cannot see
// is out of scope) and only a person accepts or rejects the exact digest (a page that changed
// since is stale); the accepted brand voice reaches Listings only as one marked data block; an
// agent's notebook is per installation, per viewer, clocked 90 days, capped at 100 live entries
// and cleared only by a person who sees every entry; the deletion path erases a page's every
// version, its search entry and its pending proposals in one transaction and records it, and
// no runtime role can delete a row. Synthetic fixtures only; no provider, credential or
// merchant data. Run by `npm run lab:shop-knowledge` (CI's postgres `http` leg, last).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createKnowledgeApiHandler } from "../../packages/work/src/knowledge/http.ts";
import {
  knowledgeProposeStep,
  knowledgeSearchForRun,
  listingsBrandVoice,
  notebookWriteStep,
} from "../../packages/work/src/knowledge/run-steps.ts";
import {
  brandVoiceInstruction,
  shopKnowledgeRecord,
} from "../../packages/policy/src/knowledge/index.ts";
import { storeResource } from "../../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../../packages/contracts/src/validation.ts";
// The SPA's closed decoders (apps/workspace-web), proven here against the server's real replies.
import {
  decodeKnowledgeDeleted,
  decodeKnowledgePage,
  decodeKnowledgePages,
  decodeKnowledgeProposals,
  decodeKnowledgeWritten,
  decodeNotebook,
  decodeSuggestionDecided,
} from "../../apps/workspace-web/src/http/knowledge-decoders.ts";
import {
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

const STORE = "store_k",
  CONNECTION = "connection_k",
  STORE_INSTALLATION = "storeinst_k",
  INSTALLATION = "installation_k";
let db, release, started, P, held, open, connector, AGENT;
before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  started = withWorkDatabase(
    "PR20.shop-knowledge",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole" },
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
  // Grants. The store's resource carries the store-scoped tags; the workspace resource the
  // approve and notebook grants (the work API decides them on the workspace).
  const store = storeResource(O, W, STORE, CONNECTION);
  // A v1.1 grant on the store resource (a v1 Grant cannot name one), as lab:catalog-apply builds it.
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
  const statements = [];
  // A: the person who writes, accepts, deletes and clears; sees everything on the store.
  // B: reads knowledge on the store, but not the catalogue: product facts are hidden from B.
  // C: no knowledge grant at all. R: approves (writes) but never administers (deletes).
  for (const p of [P.A, P.B, P.R])
    statements.push(
      storeGrant(p, "workspace.knowledge.read", ["view"], ["query", "resourceScope"]),
      grantInsert(
        p,
        fixtureGrant(p, "workspace.knowledge.read", ["view"], ["query", "resourceScope"]),
      ),
    );
  for (const p of [P.A, P.R])
    statements.push(
      storeGrant(p, "catalog.products.read", ["view"], ["productId"]),
      storeGrant(p, "workspace.artifact.read", ["view"], ["artifactId", "revision"]),
    );
  statements.push(
    grantInsert(
      P.A,
      fixtureGrant(P.A, "workspace.knowledge.approve", ["execute", "administer"], approve),
    ),
    grantInsert(P.R, fixtureGrant(P.R, "workspace.knowledge.approve", ["execute"], approve)),
    grantInsert(P.A, fixtureGrant(P.A, "workspace.notebook.write", ["administer"], ["text"])),
    grantInsert(P.B, fixtureGrant(P.B, "workspace.notebook.write", ["administer"], ["text"])),
    // Y (the other tenant) holds the same on its own workspace.
    grantInsert(
      P.Y,
      fixtureGrant(P.Y, "workspace.knowledge.read", ["view"], ["query", "resourceScope"]),
    ),
    grantInsert(
      P.Y,
      fixtureGrant(P.Y, "workspace.knowledge.approve", ["execute", "administer"], approve),
    ),
  );
  db.admin(statements.join("\n"));
  // The Listings installation whose run proposes (owner-seeded, as lab:listings-authority does).
  AGENT = "agent_" + randomUUID();
  db.admin(`INSERT INTO morrow_identity.principals VALUES(${literal(AGENT)},'agent',true);
INSERT INTO morrow_identity.agent_principals VALUES(${literal(AGENT)},'agent',${literal(O)},${literal(W)},'installation',${literal(INSTALLATION)},date_trunc('milliseconds',clock_timestamp()));`);
  db.workOwner(`BEGIN; INSERT INTO morrow_work.agent_installations(organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,connection_id,agent_principal_id,owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at)
SELECT ${literal(O)},${literal(W)},${literal(INSTALLATION)},1,r.id,r.revision,r.digest,${literal(STORE)},${literal(CONNECTION)},${literal(AGENT)},${literal(P.A.principal)},${literal(P.A.membership)},'active',morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(STORE)},${literal(CONNECTION)}),(SELECT jsonb_agg(jsonb_build_object('organizationId',${literal(O)},'workspaceId',${literal(W)},'storeId',${literal(STORE)},'kind','grant','id','g_ref_'||n,'revision',1,'digest',repeat('a',64))) FROM generate_series(1,3) n),repeat('b',64),t,t FROM morrow_work.agent_releases r, (SELECT date_trunc('milliseconds',clock_timestamp()) AS t) x WHERE r.id='morrow.listings' AND r.revision=1; COMMIT;`);
  // PostgreSQL error text reaches the console only when MORROW_LAB_DEBUG=1.
  connector = db.connector({
    stderr: (text) => process.env.MORROW_LAB_DEBUG === "1" && process.stderr.write(text),
  });
  const configured = (knowledge) =>
    createKnowledgeApiHandler({
      origin: workFixtureOrigin,
      connector,
      now: Date.now,
      knowledge,
    });
  held = configured(shopKnowledgeRecord.switch);
  open = configured("on");
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
const footprint = () =>
  Object.fromEntries(
    [
      "knowledge_pages",
      "knowledge_versions",
      "knowledge_proposals",
      "knowledge_search_entries",
      "knowledge_deletions",
      "agent_notebook_entries",
      "commands",
    ].map((t) => [t, count(t)]),
  );
const refusedSql = (statements, pattern) => {
  const r = db.tryRun(statements);
  assert.equal(r.ok, false, statements.slice(0, 120));
  assert.match(r.stderr, pattern);
};

// The fake caller: one transaction of the runtime login under an entered run lease, the way
// runLeaseStep runs the loop's tool-call step (enter_lease first, then the step's statements).
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
const allTags = { mayView: () => true };
const runFacts = (overrides = {}) => ({
  context: "routed",
  readTags: [{ storeId: STORE, capability: "catalog.products.read" }],
  taint: "untrusted_external",
  agentTools: "on",
  ...overrides,
});

test("K1 held: the committed switch answers 503 on every route with no connection", async () => {
  assert.equal(shopKnowledgeRecord.switch, "off");
  const before = footprint();
  const opened = connector.metrics.opened;
  for (const [method, path, body] of [
    ["GET", "/knowledge/pages"],
    ["POST", "/knowledge/pages", { kind: "policy", title: "x", text: "y", sources: [] }],
    ["GET", "/knowledge/proposals"],
    ["GET", "/knowledge/search?text=returns"],
    ["GET", `/agents/${INSTALLATION}/notebook`],
    ["POST", `/agents/${INSTALLATION}/notebook/clear`, {}],
  ]) {
    const r = await send(held, P.A, method, path, body);
    assert.equal(r.status, 503, path);
    assert.equal(r.body.safeMessage, "Shop knowledge is not available yet.");
  }
  assert.equal(connector.metrics.opened, opened);
  assert.deepEqual(footprint(), before);
});

const pages = {};
test("K2 a person writes pages and versions with sources; one brand voice; revisions checked", async () => {
  const brand = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "brand_voice",
    title: "Our voice",
    text: "Warm, plain and short. We say thank you.",
    sources: [{ kind: "note", value: "Written by the owner" }],
  });
  assert.equal(brand.status, 201, JSON.stringify(brand.body));
  assert.equal(brand.body.version, 1);
  assert.deepEqual(decodeKnowledgeWritten(brand.body, null), {
    pageId: brand.body.pageId,
    version: 1,
  });
  pages.brand = brand.body.pageId;
  const again = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "brand_voice",
    title: "Second voice",
    text: "Loud.",
    sources: [],
  });
  assert.equal(again.status, 409);
  const policy = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "policy",
    title: "Returns",
    text: "Returns within thirty days, unused, with the receipt. Zebrafinch.",
    sources: [{ kind: "note", value: "Policy page, October" }],
  });
  assert.equal(policy.status, 201);
  pages.policy = policy.body.pageId;
  const fact = await send(open, P.A, "POST", "/knowledge/pages", {
    kind: "product_fact",
    title: "Linen shirt care",
    text: "Cold wash, line dry. Quokkaberry.",
    sources: [{ kind: "product", value: "product:4242" }],
  });
  assert.equal(fact.status, 201);
  pages.fact = fact.body.pageId;
  // A source must match its kind; a body never names tags, authors or versions.
  for (const body of [
    { kind: "policy", title: "x", text: "y", sources: [{ kind: "product", value: "4242" }] },
    { kind: "policy", title: "x", text: "y", sources: [], readTags: [] },
    { kind: "customer", title: "x", text: "y", sources: [] },
    { kind: "policy", title: "x".repeat(121), text: "y", sources: [] },
  ]) {
    const r = await send(open, P.A, "POST", "/knowledge/pages", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // The next version at the version read; a stale one is a conflict.
  const v2 = await send(open, P.A, "POST", `/knowledge/pages/${pages.policy}/versions`, {
    expectedVersion: 1,
    title: "Returns",
    text: "Returns within thirty days, unused. Zebrafinch.",
    sources: [],
  });
  assert.equal(v2.status, 201);
  assert.equal(v2.body.version, 2);
  const stale = await send(open, P.A, "POST", `/knowledge/pages/${pages.policy}/versions`, {
    expectedVersion: 1,
    title: "Returns",
    text: "Old.",
    sources: [],
  });
  assert.equal(stale.status, 409);
  // A replay of the same command returns its recorded result and changes nothing.
  const key = randomUUID();
  const body = {
    expectedVersion: 2,
    title: "Returns",
    text: "Thirty days. Zebrafinch.",
    sources: [],
  };
  const first = await send(open, P.A, "POST", `/knowledge/pages/${pages.policy}/versions`, body, {
    key,
  });
  const before = footprint();
  const replay = await send(open, P.A, "POST", `/knowledge/pages/${pages.policy}/versions`, body, {
    key,
  });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.version, 3);
  assert.deepEqual(decodeKnowledgeWritten(replay.body, pages.policy), {
    pageId: pages.policy,
    version: 3,
  });
  assert.deepEqual(footprint(), before);
  // A Member without workspace.knowledge.approve writes nothing.
  const member = await send(open, P.B, "POST", "/knowledge/pages", {
    kind: "decision",
    title: "x",
    text: "y",
    sources: [],
  });
  assert.equal(member.status, 403);
  // Read tags are the server's: the linked store's knowledge tag, and a product fact's catalogue tag.
  const [brandRow] = db.rows(
    `SELECT read_tags FROM morrow_work.knowledge_pages WHERE id=${literal(pages.brand)}`,
  );
  assert.deepEqual(brandRow.read_tags, [
    { storeId: STORE, capability: "workspace.knowledge.read" },
  ]);
  const [factRow] = db.rows(
    `SELECT read_tags FROM morrow_work.knowledge_pages WHERE id=${literal(pages.fact)}`,
  );
  assert.deepEqual(factRow.read_tags, [
    { storeId: STORE, capability: "catalog.products.read" },
    { storeId: STORE, capability: "workspace.knowledge.read" },
  ]);
  // Every version is a person's own act, with a content digest.
  assert.equal(
    count(
      "knowledge_versions",
      "author_kind='person' AND author_principal_id=accepted_by_principal_id",
    ),
    count("knowledge_versions"),
  );
});

test("K3 reads, lists and search cover only what the viewer may see; another tenant sees nothing", async () => {
  const list = async (p) => (await send(open, p, "GET", "/knowledge/pages")).body;
  const a = await list(P.A);
  assert.deepEqual(a.pages.map((x) => x.id).sort(), [pages.brand, pages.policy, pages.fact].sort());
  for (const page of a.pages) assert.ok(validateCurrentDefinition("KnowledgePageSummary", page));
  // The Shop knowledge screen reads exactly this reply: an excerpt per page and what A may do.
  const screen = decodeKnowledgePages(a);
  assert.ok(screen, JSON.stringify(a));
  assert.equal(screen.facts.length, 3);
  assert.equal(screen.may.write, true);
  const b = await list(P.B);
  assert.deepEqual(b.pages.map((x) => x.id).sort(), [pages.brand, pages.policy].sort());
  assert.deepEqual((await list(P.C)).pages, []);
  assert.deepEqual((await list(P.Y)).pages, []);
  // A direct read of a hidden page is the same 404 as an absent one; nothing names a tag.
  const hidden = await send(open, P.B, "GET", `/knowledge/pages/${pages.fact}`);
  const absent = await send(open, P.B, "GET", `/knowledge/pages/${randomUUID()}`);
  assert.equal(hidden.status, 404);
  assert.equal(absent.status, 404);
  assert.equal(hidden.body.safeMessage, absent.body.safeMessage);
  assert.equal((await send(open, P.Y, "GET", `/knowledge/pages/${pages.brand}`)).status, 404);
  const page = await send(open, P.A, "GET", `/knowledge/pages/${pages.policy}`);
  assert.equal(page.status, 200);
  assert.ok(validateCurrentDefinition("KnowledgePage", page.body.page));
  assert.equal(page.body.page.current.version, 3);
  assert.equal(page.body.page.versionCount, 3);
  assert.deepEqual(
    page.body.versions.map((v) => v.version),
    [3, 2, 1],
  );
  assert.equal(JSON.stringify(page.body).includes("readTags"), false);
  const form = decodeKnowledgePage(page.body, pages.policy);
  assert.ok(form, JSON.stringify(page.body));
  assert.equal(form.version, 3);
  const v1 = await send(open, P.A, "GET", `/knowledge/pages/${pages.policy}/versions/1`);
  assert.equal(v1.status, 200);
  assert.match(v1.body.version.text, /receipt/);
  assert.deepEqual(v1.body.version.sources, [{ kind: "note", value: "Policy page, October" }]);
  // Search: per viewer, no tags in the reply.
  const search = async (p, term) =>
    (await send(open, p, "GET", "/knowledge/search?text=" + encodeURIComponent(term))).body;
  assert.deepEqual(
    (await search(P.A, "quokkaberry")).results.map((r) => r.pageId),
    [pages.fact],
  );
  assert.deepEqual((await search(P.B, "quokkaberry")).results, []);
  assert.deepEqual(
    (await search(P.B, "zebrafinch")).results.map((r) => r.pageId),
    [pages.policy],
  );
  assert.deepEqual((await search(P.Y, "zebrafinch")).results, []);
  assert.deepEqual((await search(P.C, "zebrafinch")).results, []);
  assert.equal((await send(open, P.A, "GET", "/knowledge/search?text=")).status, 400);
});

test("K4 customer data never enters knowledge: CHECK on every table, refused by the tools", async () => {
  const O = P.A.org,
    W = P.A.workspace;
  const customer = `'[{"storeId":"${STORE}","capability":"support.case.read"}]'::jsonb`;
  refusedSql(
    asCommandRole(
      P.A,
      `INSERT INTO morrow_work.knowledge_pages(organization_id,workspace_id,id,kind,revision,current_version,title,read_tags,created_by_principal_id,created_by_membership_id,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},'policy',1,1,'x',${customer},${literal(P.A.principal)},${literal(P.A.membership)},date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()));`,
    ),
    /knowledge_pages_no_customer|knowledge_tags_valid|check constraint/,
  );
  const before = footprint();
  const lease = openRunLease("run_k4");
  const result = await underLease(lease, (query) =>
    knowledgeProposeStep(query, {
      toolUseId: "toolu_k4",
      input: {
        pageId: null,
        kind: "policy",
        title: "Refund",
        text: "Customer said x.",
        sources: [],
      },
      run: runFacts({
        readTags: [{ storeId: STORE, capability: "support.case.read" }],
      }),
      viewer: allTags,
    }),
  );
  assert.deepEqual(result, { outcome: "refused", refusal: "customer_data" });
  const note = await underLease(lease, (query) =>
    notebookWriteStep(query, {
      toolUseId: "toolu_k4n",
      input: { text: "A customer named x" },
      run: runFacts({ readTags: [{ storeId: STORE, capability: "support.case.read" }] }),
      viewer: allTags,
    }),
  );
  assert.deepEqual(note, { outcome: "refused", refusal: "customer_data" });
  // The definer refuses it too, with the code checks bypassed.
  const direct = db
    .sql(
      `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(lease.id)},'1'); SELECT outcome FROM morrow_work.run_knowledge_propose('toolu_k4d',NULL,'policy','x','y','[]',${literal(`[{"storeId":"${STORE}","capability":"support.case.read"}]`)},'none'); ROLLBACK;`,
      { user: "morrow_runtime_executor" },
    )
    .split("\n");
  assert.deepEqual(direct, ["entered", "customer_data"]);
  assert.deepEqual(footprint(), before);
});

const proposals = {};
test("K5 an agent proposes through knowledge.propose; it grants nothing and a person decides", async () => {
  const lease = openRunLease("run_k5");
  const input = {
    pageId: pages.brand,
    kind: "brand_voice",
    title: "Our voice",
    text: "Warm, plain and short. We say thank you and sign with the shop's name.",
    sources: [{ kind: "product", value: "product:4242" }],
  };
  const before = footprint();
  const made = await underLease(lease, (query) =>
    knowledgeProposeStep(query, { toolUseId: "toolu_k5", input, run: runFacts(), viewer: allTags }),
  );
  assert.equal(made.outcome, "ok");
  assert.equal(made.record.kind, "knowledge_proposal");
  assert.equal(made.replayed, false);
  proposals.voice = made.record.id;
  // A proposal changes no page.
  assert.equal(count("knowledge_versions"), before.knowledge_versions);
  // The same call again returns its first record; another input under that id is a defect.
  const replay = await underLease(lease, (query) =>
    knowledgeProposeStep(query, { toolUseId: "toolu_k5", input, run: runFacts(), viewer: allTags }),
  );
  assert.deepEqual(replay, { outcome: "ok", record: made.record, replayed: true });
  await assert.rejects(
    underLease(lease, (query) =>
      knowledgeProposeStep(query, {
        toolUseId: "toolu_k5",
        input: { ...input, text: "Different." },
        run: runFacts(),
        viewer: allTags,
      }),
    ),
    /RUNTIME_KNOWLEDGE_HELD/,
  );
  // Refusals in code: a page the run cannot see, a kind that is not the page's, the switch,
  // a context that does not offer the tool, and an input outside the full definition.
  const call = (overrides) =>
    underLease(lease, (query) =>
      knowledgeProposeStep(query, {
        toolUseId: "toolu_k5_" + randomUUID().slice(0, 8),
        input,
        run: runFacts(),
        viewer: allTags,
        ...overrides,
      }),
    );
  assert.deepEqual(await call({ viewer: { mayView: () => false } }), {
    outcome: "refused",
    refusal: "id_out_of_scope",
  });
  assert.deepEqual(await call({ input: { ...input, kind: "policy" } }), {
    outcome: "refused",
    refusal: "id_out_of_scope",
  });
  assert.deepEqual(await call({ input: { ...input, pageId: randomUUID() } }), {
    outcome: "refused",
    refusal: "id_out_of_scope",
  });
  assert.deepEqual(await call({ run: runFacts({ agentTools: "off" }) }), {
    outcome: "refused",
    refusal: "switch_off",
  });
  assert.deepEqual(await call({ run: runFacts({ context: "look_for_work" }) }), {
    outcome: "refused",
    refusal: "not_offered",
  });
  assert.deepEqual(await call({ input: { ...input, title: "x".repeat(121) } }), {
    outcome: "invalid_input",
    refusal: "input_invalid",
  });
  assert.equal(count("knowledge_proposals"), before.knowledge_proposals + 1);
  // The row: the server's tags (the page kind's and the run's), taint and author.
  const [row] = db.rows(
    `SELECT read_tags,context_taint,installation_id,agent_principal_id,run_id,base_version,status FROM morrow_work.knowledge_proposals WHERE id=${literal(proposals.voice)}`,
  );
  assert.deepEqual(row.read_tags, [
    { storeId: STORE, capability: "catalog.products.read" },
    { storeId: STORE, capability: "workspace.knowledge.read" },
  ]);
  assert.equal(row.context_taint, "untrusted_external");
  assert.equal(row.agent_principal_id, AGENT);
  assert.equal(row.base_version, 1);
  // Per viewer: B may not view the catalogue tag, so B neither sees nor counts it.
  const a = await send(open, P.A, "GET", "/knowledge/proposals");
  assert.equal(a.status, 200);
  assert.equal(a.body.proposals.length, 1);
  assert.ok(validateCurrentDefinition("KnowledgeProposal", a.body.proposals[0]));
  assert.equal(a.body.proposals[0].contextTaint, "untrusted_external");
  const suggested = decodeKnowledgeProposals(a.body);
  assert.ok(suggested, JSON.stringify(a.body));
  assert.equal(suggested[0].untrusted, true);
  assert.deepEqual((await send(open, P.B, "GET", "/knowledge/proposals")).body.proposals, []);
  assert.equal((await send(open, P.B, "GET", "/knowledge/pages")).body.pendingProposals, 0);
  assert.equal((await send(open, P.A, "GET", "/knowledge/pages")).body.pendingProposals, 1);
  const digest = a.body.proposals[0].digest;
  // Only a person with workspace.knowledge.approve decides, on the exact digest.
  assert.equal(
    (await send(open, P.B, "POST", `/knowledge/proposals/${proposals.voice}/accept`, { digest }))
      .status,
    403,
  );
  assert.equal(
    (
      await send(open, P.A, "POST", `/knowledge/proposals/${proposals.voice}/accept`, {
        digest: "f".repeat(64),
      })
    ).status,
    409,
  );
  const accepted = await send(open, P.A, "POST", `/knowledge/proposals/${proposals.voice}/accept`, {
    digest,
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.deepEqual(
    { pageId: accepted.body.pageId, version: accepted.body.version },
    { pageId: pages.brand, version: 2 },
  );
  assert.deepEqual(decodeSuggestionDecided(accepted.body, proposals.voice, "accept"), {
    decision: "accept",
  });
  const [version] = db.rows(
    `SELECT author_kind,author_principal_id,author_installation_id,accepted_by_principal_id,proposal_id,body FROM morrow_work.knowledge_versions WHERE page_id=${literal(pages.brand)} AND version=2`,
  );
  assert.deepEqual(
    { ...version, body: undefined },
    {
      author_kind: "agent",
      author_principal_id: AGENT,
      author_installation_id: INSTALLATION,
      accepted_by_principal_id: P.A.principal,
      proposal_id: proposals.voice,
      body: undefined,
    },
  );
  assert.equal(version.body, input.text);
  // The decided proposal keeps only its digest.
  const [decided] = db.rows(
    `SELECT status,title,body,sources,digest FROM morrow_work.knowledge_proposals WHERE id=${literal(proposals.voice)}`,
  );
  assert.deepEqual(
    [decided.status, decided.title, decided.body, decided.sources],
    ["accepted", null, null, null],
  );
  assert.equal(decided.digest, digest);
  // The page's tags grew by the run's; B, who cannot view the catalogue, no longer sees it.
  assert.equal((await send(open, P.B, "GET", `/knowledge/pages/${pages.brand}`)).status, 404);
  // A second decision of the same proposal is a conflict.
  assert.equal(
    (await send(open, P.A, "POST", `/knowledge/proposals/${proposals.voice}/reject`, { digest }))
      .status,
    409,
  );
  // Reject: the text is erased.
  const other = await underLease(lease, (query) =>
    knowledgeProposeStep(query, {
      toolUseId: "toolu_k5_reject",
      input: {
        pageId: null,
        kind: "supplier",
        title: "Linen mill",
        text: "Lead time six weeks.",
        sources: [],
      },
      run: runFacts({ readTags: [], taint: "none" }),
      viewer: allTags,
    }),
  );
  assert.equal(other.outcome, "ok");
  const pending = (await send(open, P.A, "GET", "/knowledge/proposals")).body.proposals;
  const supplier = pending.find((p) => p.id === other.record.id);
  assert.equal(supplier.contextTaint, "none");
  const rejected = await send(open, P.A, "POST", `/knowledge/proposals/${supplier.id}/reject`, {
    digest: supplier.digest,
  });
  assert.equal(rejected.status, 200);
  assert.deepEqual(decodeSuggestionDecided(rejected.body, supplier.id, "reject"), {
    decision: "reject",
  });
  assert.equal(
    count(
      "knowledge_proposals",
      `id=${literal(supplier.id)} AND status='rejected' AND body IS NULL`,
    ),
    1,
  );
  // Stale: a proposal made at version 2 of the policy page, then a person writes version 4.
  const stale = await underLease(lease, (query) =>
    knowledgeProposeStep(query, {
      toolUseId: "toolu_k5_stale",
      input: {
        pageId: pages.policy,
        kind: "policy",
        title: "Returns",
        text: "Sixty days.",
        sources: [],
      },
      run: runFacts({ readTags: [] }),
      viewer: allTags,
    }),
  );
  const staleRow = (await send(open, P.A, "GET", "/knowledge/proposals")).body.proposals.find(
    (p) => p.id === stale.record.id,
  );
  assert.equal(staleRow.baseVersion, 3);
  await send(open, P.R, "POST", `/knowledge/pages/${pages.policy}/versions`, {
    expectedVersion: 3,
    title: "Returns",
    text: "Thirty days, with the receipt. Zebrafinch.",
    sources: [],
  });
  const late = await send(open, P.A, "POST", `/knowledge/proposals/${stale.record.id}/accept`, {
    digest: staleRow.digest,
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.safeMessage, "This changed since you opened it. Open it again.");
  proposals.stale = stale.record.id;
});

test("K6 Listings gets the accepted brand voice only as one marked data block", async () => {
  const lease = openRunLease("run_k6");
  // While the switch's agent_tools is off (as committed), Listings gets nothing and reads nothing.
  assert.equal(shopKnowledgeRecord.agent_tools, "off");
  const noRead = () => {
    throw Error("no read while the switch is off");
  };
  assert.deepEqual(await listingsBrandVoice(noRead, allTags, shopKnowledgeRecord.agent_tools), []);
  const blocks = await underLease(lease, (query) => listingsBrandVoice(query, allTags, "on"));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: brandVoiceInstruction });
  assert.deepEqual(blocks[1], {
    type: "data",
    source: "knowledge_page",
    sourceId: pages.brand,
    text: "Warm, plain and short. We say thank you and sign with the shop's name.",
  });
  for (const block of blocks)
    assert.ok(
      validateCurrentDefinition(block.type === "data" ? "ModelDataBlock" : "ModelTextBlock", block),
    );
  // A run that may not view the page's tags gets nothing.
  assert.deepEqual(
    await underLease(lease, (query) => listingsBrandVoice(query, { mayView: () => false }, "on")),
    [],
  );
  // knowledge.search's candidates, per run viewer.
  const hits = await underLease(lease, (query) =>
    knowledgeSearchForRun(query, allTags, "zebrafinch", 5),
  );
  assert.deepEqual(
    hits.map((h) => h.pageId),
    [pages.policy],
  );
  const none = await underLease(lease, (query) =>
    knowledgeSearchForRun(query, { mayView: () => false }, "zebrafinch", 5),
  );
  assert.deepEqual(none, []);
  // Without a lease (or with a read lease) the runtime reads return nothing.
  assert.equal(
    db
      .sql("BEGIN; SELECT count(*) FROM morrow_work.run_brand_voice(); ROLLBACK;", {
        user: "morrow_runtime_executor",
      })
      .split("\n")
      .at(-1),
    "0",
  );
});

test("K7 an agent's notebook: its own installation, per viewer, 90-day clock, 100 live entries, cleared by a person", async () => {
  const lease = openRunLease("run_k7");
  const write = (toolUseId, text, readTags = []) =>
    underLease(lease, (query) =>
      notebookWriteStep(query, {
        toolUseId,
        input: { text },
        run: runFacts({ readTags }),
        viewer: allTags,
      }),
    );
  const first = await write("toolu_n1", "Titles on linen shirts run long; keep under 60.");
  assert.equal(first.outcome, "ok");
  assert.equal(first.record.kind, "notebook_entry");
  assert.deepEqual(await write("toolu_n1", "Titles on linen shirts run long; keep under 60."), {
    ...first,
    replayed: true,
  });
  await write("toolu_n2", "Product 4242 needs care facts.", [
    { storeId: STORE, capability: "catalog.products.read" },
  ]);
  const read = async (p) => {
    const r = await send(open, p, "GET", `/agents/${INSTALLATION}/notebook`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const a = await read(P.A);
  assert.deepEqual(
    a.entries.map((e) => e.text),
    ["Product 4242 needs care facts.", "Titles on linen shirts run long; keep under 60."],
  );
  for (const entry of a.entries) assert.ok(validateCurrentDefinition("NotebookEntry", entry));
  // The agent page reads exactly this reply (the SPA's closed decoder), newest first.
  assert.deepEqual(
    decodeNotebook(a, INSTALLATION)?.entries.map((e) => e.text),
    ["Product 4242 needs care facts.", "Titles on linen shirts run long; keep under 60."],
  );
  // B may view neither the store's artifact tag nor its catalogue: nothing is shown.
  assert.deepEqual((await read(P.B)).entries, []);
  assert.equal((await send(open, P.A, "GET", `/agents/installation_absent/notebook`)).status, 404);
  // Every entry carries the store's artifact tag and its 90-day clock.
  assert.equal(
    count(
      "agent_notebook_entries",
      `read_tags @> '[{"storeId":"${STORE}","capability":"workspace.artifact.read"}]' AND expires_at=created_at+interval '90 days'`,
    ),
    2,
  );
  refusedSql(
    asCommandRole(
      P.A,
      `UPDATE morrow_work.agent_notebook_entries SET expires_at=expires_at+interval '1 day';`,
    ),
    /AGENT_NOTEBOOK_INVALID|permission denied/,
  );
  // The 101st live entry supersedes the oldest.
  db.sql(
    `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(lease.id)},'1'); SELECT count(*) FROM (SELECT morrow_work.run_notebook_write('toolu_bulk_'||g,'Bulk note '||g,'[]') FROM generate_series(1,99) g) x; COMMIT;`,
    { user: "morrow_runtime_executor" },
  );
  assert.equal(count("agent_notebook_entries", "erased_at IS NULL"), 100);
  assert.equal(count("agent_notebook_entries", "erased_reason='superseded'"), 1);
  assert.equal(
    count(
      "agent_notebook_entries",
      `tool_use_id='toolu_n1' AND erased_reason='superseded' AND body IS NULL`,
    ),
    1,
  );
  // B holds administer but cannot see the entries: no blind clear. A clears it.
  const blind = await send(open, P.B, "POST", `/agents/${INSTALLATION}/notebook/clear`, {});
  assert.equal(blind.status, 403);
  assert.equal(count("agent_notebook_entries", "erased_at IS NULL"), 100);
  const noGrant = await send(open, P.C, "POST", `/agents/${INSTALLATION}/notebook/clear`, {});
  assert.equal(noGrant.status, 403);
  const cleared = await send(open, P.A, "POST", `/agents/${INSTALLATION}/notebook/clear`, {});
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(count("agent_notebook_entries", "erased_at IS NULL OR body IS NOT NULL"), 0);
  assert.deepEqual((await read(P.A)).entries, []);
});

test("K8 the deletion path: a page's every version, search entry and pending proposal erased, and recorded", async () => {
  const before = await send(open, P.A, "GET", `/knowledge/pages/${pages.policy}`);
  const version = before.body.page.current.version;
  // R may write but not administer: no deletion.
  assert.equal(
    (
      await send(open, P.R, "POST", `/knowledge/pages/${pages.policy}/delete`, {
        expectedVersion: version,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send(open, P.A, "POST", `/knowledge/pages/${pages.policy}/delete`, {
        expectedVersion: version - 1,
      })
    ).status,
    409,
  );
  const deleted = await send(open, P.A, "POST", `/knowledge/pages/${pages.policy}/delete`, {
    expectedVersion: version,
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(decodeKnowledgeDeleted(deleted.body, pages.policy), { pageId: pages.policy });
  assert.deepEqual(
    {
      versionsErased: deleted.body.versionsErased,
      searchEntriesErased: deleted.body.searchEntriesErased,
      proposalsClosed: deleted.body.proposalsClosed,
    },
    { versionsErased: version, searchEntriesErased: 1, proposalsClosed: 1 },
  );
  // Nothing of the content remains anywhere in the knowledge tables.
  const id = literal(pages.policy);
  assert.equal(
    count(
      "knowledge_versions",
      `page_id=${id} AND (body IS NOT NULL OR title IS NOT NULL OR sources IS NOT NULL OR erased_at IS NULL)`,
    ),
    0,
  );
  assert.equal(
    count(
      "knowledge_search_entries",
      `page_id=${id} AND (document IS NOT NULL OR erased_at IS NULL)`,
    ),
    0,
  );
  assert.equal(
    count("knowledge_pages", `id=${id} AND (title IS NOT NULL OR deleted_at IS NULL)`),
    0,
  );
  assert.equal(
    count("knowledge_proposals", `page_id=${id} AND (status<>'closed' OR body IS NOT NULL)`),
    0,
  );
  assert.equal(
    count("knowledge_versions", `body ILIKE '%zebrafinch%' OR title ILIKE '%zebrafinch%'`) +
      count("knowledge_search_entries", `document @@ to_tsquery('simple','zebrafinch')`),
    0,
  );
  // Recorded: the content-free deletion record and the command.
  const [record] = db.rows(
    `SELECT kind,versions_erased,search_entries_erased,proposals_closed,deleted_by_principal_id FROM morrow_work.knowledge_deletions WHERE page_id=${id}`,
  );
  assert.deepEqual(record, {
    kind: "policy",
    versions_erased: version,
    search_entries_erased: 1,
    proposals_closed: 1,
    deleted_by_principal_id: P.A.principal,
  });
  assert.equal(count("commands", `command_type='knowledge.delete' AND aggregate_id=${id}`), 1);
  // Gone for every reader: 404, absent from lists and search, and its proposal with it.
  assert.equal((await send(open, P.A, "GET", `/knowledge/pages/${pages.policy}`)).status, 404);
  assert.equal(
    (await send(open, P.A, "GET", `/knowledge/pages/${pages.policy}/versions/1`)).status,
    404,
  );
  assert.deepEqual(
    (await send(open, P.A, "GET", "/knowledge/search?text=zebrafinch")).body.results,
    [],
  );
  assert.equal(
    (await send(open, P.A, "GET", "/knowledge/proposals")).body.proposals.some(
      (p) => p.id === proposals.stale,
    ),
    false,
  );
  // A deleted page takes no further version or deletion.
  assert.equal(
    (
      await send(open, P.A, "POST", `/knowledge/pages/${pages.policy}/versions`, {
        expectedVersion: version,
        title: "x",
        text: "y",
        sources: [],
      })
    ).status,
    404,
  );
});

test("K9 no runtime role deletes or rewrites knowledge; erased rows stay erased", () => {
  for (const table of [
    "knowledge_pages",
    "knowledge_versions",
    "knowledge_proposals",
    "knowledge_search_entries",
    "knowledge_deletions",
    "agent_notebook_entries",
  ])
    refusedSql(asCommandRole(P.A, `DELETE FROM morrow_work.${table};`), /permission denied/);
  // A version's text never changes; an erased one is never restored.
  refusedSql(
    asCommandRole(
      P.A,
      `UPDATE morrow_work.knowledge_versions SET body='Changed.' WHERE page_id=${literal(pages.brand)} AND version=1;`,
    ),
    /KNOWLEDGE_VERSION_INVALID/,
  );
  refusedSql(
    asCommandRole(
      P.A,
      `UPDATE morrow_work.knowledge_pages SET title='Back',deleted_at=NULL,deleted_by_principal_id=NULL,deleted_by_membership_id=NULL,revision=revision+1 WHERE id=${literal(pages.policy)};`,
    ),
    /KNOWLEDGE_PAGE_INVALID|knowledge_pages_deleted/,
  );
  // The owner's maintenance cannot delete knowledge either (append-only).
  refusedSql(
    `SET ROLE morrow_work_owner; DELETE FROM morrow_work.knowledge_versions WHERE page_id=${literal(pages.brand)};`,
    /WORK_RECORD_IMMUTABLE/,
  );
  // The api role reads but never writes.
  refusedSql(
    `BEGIN; SET LOCAL ROLE morrow_work_api; UPDATE morrow_work.knowledge_pages SET title='x'; ROLLBACK;`,
    /permission denied/,
  );
});
