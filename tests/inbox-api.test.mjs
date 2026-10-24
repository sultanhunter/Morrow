// v1 PR 15: the Inbox and activity reads of the workspace API in Node
// (packages/work/src/inbox/http.ts; GET /work/inbox and GET /work/activity). Reads only, no
// switch. Over a scripted SQL connection: each item and entry is filtered on the server by
// the rule of its own screen (questions by question.read view, connection problems by the
// store's disconnect right, proposals' records by the approvals read rule, stops by the
// same stop right, runs by the store's product read on the run's fields); a denied source
// marks its section and is never "nothing"; the statements select ids, codes and times only
// (never a person's stop reason or review comment). The catalog-apply lab drives the same
// handler against PostgreSQL 17 (I1-I6).
import test from "node:test";
import assert from "node:assert/strict";
import { apiDispatch } from "../apps/api/src/worker.ts";
import { envelopeFamily } from "../apps/api/src/session-limit.ts";
import {
  createInboxApiHandler,
  inboxPathPattern,
  inboxRoutes,
} from "../packages/work/src/inbox/http.ts";
import { inboxStatements } from "../packages/work/src/inbox/sql.ts";
import {
  inboxApprovalItems,
  inboxApprovals,
  inboxChangeItems,
  inboxLimits,
  inboxScan,
} from "../packages/work/src/inbox/read.ts";
import { activityLimits } from "../packages/work/src/inbox/activity.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { encodeCursor } from "../packages/work/src/contract-mapping.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { workPermissions } from "../packages/contracts/src/work-permissions.ts";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

const ctx = { waitUntil() {} };
const base = "/workspace/ws_w/work";
const readHeaders = () => ({
  Cookie: "__Host-morrow_session=" + workGuardSecret,
  "Sec-Fetch-Site": "same-origin",
});
const get = (path) =>
  new Request(workGuardOrigin + path, { method: "GET", headers: new Headers(readHeaders()) });
const quiet = async (t, body) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const result = await body();
  return { result, lines };
};
async function envelope(response, status, code, name) {
  assert.equal(response.status, status, name);
  const body = await response.json();
  assert.ok(validateDefinition("core", "ErrorEnvelope", body), name);
  if (code) assert.equal(body.code, code, name);
  assert.equal(response.headers.has("set-cookie"), false, name);
  return body;
}

test("the routes and the api dispatch: /work/inbox and /work/activity go to the inbox handler", () => {
  assert.deepEqual(
    inboxRoutes.map((r) => r.method + " " + r.pattern + " " + r.query.join(",")),
    ["GET /inbox ", "GET /activity after,limit"],
  );
  for (const path of [base + "/inbox", base + "/activity"]) {
    assert.ok(inboxPathPattern.test(path), path);
    assert.equal(apiDispatch(path), "inbox", path);
    assert.equal(envelopeFamily(path), "inbox", path);
  }
  for (const [path, row] of [
    [base + "/inbox/items", "work"],
    [base + "/activity/1", "work"],
    [base + "/approvals", "review"],
    [base + "/questions", "work"],
    ["/workspace/ws_w/inbox", "workspace"],
  ])
    assert.equal(apiDispatch(path), row, path);
});

test("the statements select ids, codes, counts and times: never a reason text, comment or content", () => {
  for (const [name, text] of Object.entries(inboxStatements)) {
    assert.equal(workStatements[name], text, name);
    // A stop control's reason is a person's text (stop_controls.reason); its code is fine.
    assert.doesNotMatch(text, /\bs\.reason\b(?!_code)/, name + " selects no stop reason text");
    assert.doesNotMatch(text, /comment|canonical|snapshot|body|prompt|sealed|token/i, name);
    assert.doesNotMatch(text, /\$[4-9]/, name + " binds at most three values");
  }
  // The operation transition's reason is a code column (t.reason), checked by its pattern.
  assert.match(inboxStatements.activityPage, /t\.reason AS reason/);
  assert.doesNotMatch(inboxStatements.inboxConnectionStops, /s\.reason[^_]/);
});

test("unbound, wrong method, bad limit and bad cursor answer before any connection opens", async (t) => {
  assert.equal((await createInboxApiHandler().fetch(get(base + "/inbox"), {}, ctx)).status, 401);
  let opens = 0;
  const handler = createInboxApiHandler({
    origin: workGuardOrigin,
    connector: {
      async open() {
        opens++;
        throw Error("NO_DATABASE");
      },
    },
    now: Date.now,
  });
  await quiet(t, async () => {
    const post = new Request(workGuardOrigin + base + "/inbox", {
      method: "POST",
      headers: new Headers({
        ...readHeaders(),
        Origin: workGuardOrigin,
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
        "Idempotency-Key": "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      }),
      body: "{}",
    });
    await envelope(await handler.fetch(post, {}, ctx), 405, "denied", "post");
    for (const query of [
      "?limit=0",
      "?limit=51",
      "?limit=x",
      "?after=%%%",
      "?after=bm9wZQ",
      "?other=1",
    ])
      await envelope(
        await handler.fetch(get(base + "/activity" + query), {}, ctx),
        400,
        "missing_input",
        query,
      );
    await envelope(
      await handler.fetch(get(base + "/inbox?limit=5"), {}, ctx),
      400,
      "missing_input",
    );
  });
  assert.equal(opens, 0);
  // A connection that fails is the read class of 503 (nothing ran).
  await quiet(t, async () => {
    const body = await envelope(
      await handler.fetch(get(base + "/inbox"), {}, ctx),
      503,
      "unavailable",
    );
    assert.equal(body.retryClass, "safe_read_retry");
  });
  assert.equal(opens, 1);
});

// ---------------------------------------------------------------------------
// A scripted SQL connection: each statement's reply by name, every call recorded.
const statementNames = new Map(Object.entries(workStatements).map(([name, text]) => [text, name]));
const O = "org_o",
  W = "ws_w",
  S = "store_s",
  C = "connection_c",
  I = "installation_i";
const workspace = {
  organizationId: O,
  workspaceId: W,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: W,
};
const storeRes = {
  organizationId: O,
  workspaceId: W,
  storeId: S,
  connectionId: C,
  kind: "store",
  id: S,
};
const installationRes = { ...storeRes, kind: "installation", id: I };
const actorRef = (principalId = "person_a", membershipId = "membership_a") => ({
  kind: "human",
  principalId,
  organizationId: O,
  workspaceId: W,
  membershipId,
  installationId: null,
  mandateId: null,
});
const grant = (capabilityId, verbs, fields, resource = workspace) => ({
  id: "grant_" + capabilityId.replaceAll(".", "_") + "_" + resource.kind,
  principal: actorRef(),
  capabilityId,
  verbs,
  scope: {
    organizationId: O,
    workspaceId: W,
    storeIds: resource.storeId === null ? [] : [resource.storeId],
    accountIds: [],
    resources: [resource],
    fields,
  },
  issuedBy: actorRef(),
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
});
const questionRead = grant(
  "workspace.question.request",
  ["view"],
  [...workPermissions["question.read"].fields],
);
const disconnectRight = grant(
  "governance.connection.disconnect",
  ["execute"],
  ["connectionId", "control"],
  storeRes,
);
const stopRight = grant(
  "agents.installation.disable",
  ["execute"],
  ["control", "installationId"],
  installationRes,
);
const nowUs = () => String(Date.now() * 1000);
const contextRow = (grants) => [
  {
    principal_id: "person_a",
    organization_id: O,
    workspace_id: W,
    membership_id: "membership_a",
    policy_revision: "1",
    grants: JSON.stringify(grants),
    grant_count: String(grants.length),
    grants_digest: "c".repeat(64),
    database_now_us: nowUs(),
  },
];
function scripted(replies) {
  const calls = [];
  const connection = {
    async query(text, values) {
      const name = statementNames.get(text);
      calls.push({ name, values });
      const reply = replies[name];
      const rows = typeof reply === "function" ? reply(values, calls) : reply;
      if (rows instanceof Error) throw rows;
      return { rows: rows ?? [] };
    },
    async close() {},
  };
  return {
    calls,
    handler: createInboxApiHandler({
      origin: workGuardOrigin,
      connector: { open: async () => connection },
      now: Date.now,
    }),
  };
}
const at = "2026-10-23T14:04:00.000Z";
const questionRow = (id, prompt) => ({
  id,
  organization_id: O,
  workspace_id: W,
  revision: "1",
  task_id: "task_t",
  status: "open",
  prompt,
  respondent_principal_id: "person_a",
  answer_id: null,
  answer_digest: null,
  answered_by_principal_id: null,
  answered_by_membership_id: null,
  created_at: at,
  updated_at: at,
  cursor_us: "1761228240000000",
});
const operationRow = (id, status, over = {}) => ({
  id,
  task_id: "task_t",
  store_id: S,
  proposal_id: "proposal_hidden",
  status,
  uncertainty_reason: status === "uncertain" ? "unknown_submission" : null,
  reason: status === "uncertain" ? "fence_expired" : "provider_rejected",
  updated_at: at,
  ...over,
});
const stopRow = (over = {}) => ({
  id: "stop_1",
  store_id: S,
  connection_id: C,
  set_by_kind: "human",
  reason_code: "human_disconnect",
  created_at: at,
  ...over,
});

test("GET /work/inbox: questions, connection problems and hidden proposals, decided on the server", async (t) => {
  const s = scripted({
    enterContext: () => contextRow([questionRead, disconnectRight]),
    questionPageForRespondent: [questionRow("q_1", "Which collection first?")],
    pendingApprovalPage: [],
    inboxOperations: [operationRow("op_1", "uncertain"), operationRow("op_2", "failed")],
    // The viewer is neither reviewer nor proposer of that proposal: as absent (RLS or rule).
    proposalById: [],
    inboxConnectionStops: [
      stopRow(),
      stopRow({ id: "stop_2", connection_id: "connection_other", store_id: "store_other" }),
    ],
    // The store is not linked again; store_other is (a new connection settled it).
    storeAssociation: (values) =>
      values[0] === "store_other"
        ? [{ store_id: "store_other", connection_id: "connection_new", database_now: at }]
        : [],
  });
  const { result } = await quiet(t, () => s.handler.fetch(get(base + "/inbox"), {}, ctx));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.sections, {
    questions: "ok",
    approvals: "ok",
    changes: "ok",
    connections: "ok",
  });
  assert.deepEqual(body.items, [
    {
      kind: "connection",
      reason: "disconnected",
      id: C,
      storeId: S,
      setBy: "human",
      since: at,
      open: true,
    },
    {
      kind: "question",
      id: "q_1",
      taskId: "task_t",
      prompt: "Which collection first?",
      createdAt: at,
      open: true,
    },
  ]);
  assert.equal(body.more, false);
  assert.equal(body.schemaVersion, 1);
  // One READ ONLY transaction; the questions are this person's open ones only.
  assert.equal(s.calls[0].name, "prologueReadOnly");
  const q = s.calls.find((c) => c.name === "questionPageForRespondent");
  assert.deepEqual(q.values, ["person_a", "open", null, null, "51"]);
  assert.equal(s.calls.at(-1).name, "commit");
});

test("GET /work/inbox: a denied question read marks its section; no disconnect right, no problem shown", async (t) => {
  const s = scripted({
    enterContext: () => contextRow([]),
    pendingApprovalPage: [],
    inboxOperations: [],
    inboxConnectionStops: [
      stopRow({ set_by_kind: "system", reason_code: "shopify_app_uninstalled" }),
    ],
    storeAssociation: [],
  });
  const { result } = await quiet(t, () => s.handler.fetch(get(base + "/inbox"), {}, ctx));
  const body = await result.json();
  assert.equal(body.sections.questions, "denied");
  assert.deepEqual(body.items, []);
  assert.equal(
    s.calls.some((c) => c.name === "questionPageForRespondent"),
    false,
    "a denied section reads nothing",
  );
  // The same stop for the steward: an uninstall.
  const steward = scripted({
    enterContext: () => contextRow([disconnectRight]),
    pendingApprovalPage: [],
    inboxOperations: [],
    inboxConnectionStops: [
      stopRow({ set_by_kind: "system", reason_code: "shopify_app_uninstalled" }),
    ],
    storeAssociation: [],
  });
  const second = await quiet(t, () => steward.handler.fetch(get(base + "/inbox"), {}, ctx));
  const items = (await second.result.json()).items;
  assert.deepEqual(
    items.map((i) => [i.kind, i.reason, i.setBy]),
    [["connection", "uninstalled", "system"]],
  );
});

test("the Inbox's changes to review: only what this person may decide, counted only while the store is linked", async () => {
  // One page of the approvals list as the approvals library maps it (its own rule decided
  // each viewerRole); the Inbox keeps the reviewer's items and asks once per store whether
  // it is linked now.
  const summary = (id, viewerRole, storeId) => ({
    approval: { expiresAt: "2026-10-26T12:00:00.000Z" },
    approvalRef: { id: "approval_" + id },
    proposalRef: { id: "proposal_" + id, storeId },
    capabilityId: "catalog.content.publish",
    targetCount: 2,
    viewerRole,
  });
  const asked = [];
  const linked = async (storeId) => {
    asked.push(storeId);
    return storeId === "store_linked";
  };
  const items = await inboxApprovalItems(
    [
      summary("mine", "proposer", "store_linked"),
      summary("decide", "reviewer", "store_linked"),
      summary("gone", "reviewer", "store_gone"),
      summary("workspace", "reviewer", null),
    ],
    linked,
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.proposalId, i.storeLinked, i.open]),
    [
      ["approval_decide", "proposal_decide", true, true],
      ["approval_gone", "proposal_gone", false, false],
      ["approval_workspace", "proposal_workspace", true, true],
    ],
  );
  // A proposer's own change is never an Inbox item, and its store is not even looked up.
  assert.deepEqual(asked, ["store_linked", "store_gone"]);
  assert.ok(items.every((i) => i.kind === "approval" && Object.isFrozen(i)));
  assert.deepEqual(await inboxApprovalItems([summary("x", "proposer", null)], linked), []);
});

test("GET /work/inbox: `more` only when something this person may see waits past the limit", async (t) => {
  // The statement puts unknown outcomes first: past 50, a not-applied change is information
  // (never counted), while an unknown one may wait on this person. Here the viewer may see
  // none of the proposals (as absent), so nothing is shown and nothing says more waits:
  // records they can't see never set `more` (F2: it said "0+" beside "all caught up").
  const read = async (rows) => {
    const s = scripted({
      enterContext: () => contextRow([questionRead]),
      questionPageForRespondent: [],
      pendingApprovalPage: [],
      inboxOperations: rows,
      proposalById: [],
      inboxConnectionStops: [],
    });
    const { result } = await quiet(t, () => s.handler.fetch(get(base + "/inbox"), {}, ctx));
    assert.equal(result.status, 200);
    return (await result.json()).more;
  };
  const ops = (n, status) => Array.from({ length: n }, (_, i) => operationRow(`op_${i}`, status));
  assert.equal(await read([...ops(50, "uncertain"), operationRow("op_x", "failed")]), false);
  assert.equal(await read(ops(51, "failed")), false);
  assert.equal(await read(ops(51, "uncertain")), false);
  assert.equal(await read(ops(101, "uncertain")), false);
  assert.equal(await read(ops(50, "uncertain")), false);
  // The statement scans past hidden rows: 100, and one more to tell its bound from the end.
  assert.match(inboxStatements.inboxOperations, /LIMIT 101$/);
  assert.equal(inboxScan.changes, 100);
});

test("the Inbox's problems: the first 50 this person may see, `more` only for one more they may see", async () => {
  const row = (n, status = "uncertain") =>
    operationRow(`op_${n}`, status, { proposal_id: `proposal_${n}` });
  const rows = (from, to, status) =>
    Array.from({ length: to - from }, (_, i) => row(from + i, status));
  // `shown` decides which proposals this person may see (the operation read's rule).
  const run = async (list, shown) => {
    const asked = [];
    const result = await inboxChangeItems(list, async (proposalId) => {
      asked.push(proposalId);
      return shown(Number(proposalId.slice("proposal_".length))) ? { proposalId } : null;
    });
    return { ...result, ids: result.items.map((i) => i.id), asked };
  };
  const all = () => true;
  const none = () => false;
  assert.equal(inboxLimits.changes, 50);
  // Nothing visible: no items, no `more`, whatever lies past (F2).
  for (const list of [rows(0, 51), rows(0, 101), [...rows(0, 50), row(50, "failed")]])
    assert.deepEqual(
      [(await run(list, none)).items.length, (await run(list, none)).more],
      [0, false],
    );
  // Everything visible: past the 50, one more unknown outcome sets it; a not-applied change
  // is information and ends the search.
  assert.equal((await run(rows(0, 51), all)).more, true);
  assert.equal((await run(rows(0, 50), all)).more, false);
  const failedNext = await run([...rows(0, 50), row(50, "failed"), row(51)], all);
  assert.equal(failedNext.more, false);
  assert.equal(failedNext.asked.length, 50, "the first not-applied change ends the search");
  // Hidden rows are skipped, so later visible ones fill the page (scanned past 50 rows).
  const mixed = await run(rows(0, 90), (n) => n >= 30);
  assert.equal(mixed.items.length, 50);
  assert.equal(mixed.ids[0], "op_30");
  assert.equal(mixed.more, true);
  // Past a full page, hidden unknown outcomes don't set it; a visible one further on does.
  assert.equal((await run(rows(0, 80), (n) => n < 50)).more, false);
  assert.equal((await run(rows(0, 80), (n) => n < 50 || n === 79)).more, true);
  // A not-applied change the person may see is listed, never open.
  const listed = await run([row(0), row(1, "failed")], all);
  assert.deepEqual(
    listed.items.map((i) => [i.id, i.reason, i.open]),
    [
      ["op_0", "uncertain_operation", true],
      ["op_1", "failed_operation", false],
    ],
  );
  // At the scan's bound (101 rows sent, 100 scanned), undecided: `more` only beside a full
  // page, never beside fewer.
  const bound = await run(rows(0, 101), (n) => n < 50);
  assert.deepEqual([bound.items.length, bound.more, bound.asked.length], [50, true, 100]);
  const partial = await run(rows(0, 101), (n) => n >= 60);
  assert.deepEqual([partial.items.length, partial.more, partial.asked.length], [40, false, 100]);
  assert.equal((await run(rows(0, 100), (n) => n < 50)).more, false, "the end, not the bound");
  // A malformed row is still refused, even past the page.
  await assert.rejects(run([...rows(0, 50), row(50, "verified")], all));
});

test("the Inbox's changes to review: paged until 25 this person may decide; `more` only for one more", async () => {
  const summary = (n, viewerRole) => ({
    approval: { expiresAt: "2026-10-26T12:00:00.000Z" },
    approvalRef: { id: `approval_${n}` },
    proposalRef: { id: `proposal_${n}`, storeId: null },
    capabilityId: "catalog.content.publish",
    targetCount: 1,
    viewerRole,
  });
  const many = (from, n, role) => Array.from({ length: n }, (_, i) => summary(from + i, role));
  const run = async (pages) => {
    const cursors = [];
    const result = await inboxApprovals(
      async (after) => {
        cursors.push(after);
        return pages[cursors.length - 1];
      },
      async () => true,
    );
    return { ...result, cursors };
  };
  // A page of a proposer's own changes (the approvals list's page holds 25 items) says
  // nothing about what this person may decide: the next page is read, and the end is the end.
  const own = await run([
    { items: many(0, 25, "proposer"), next: "c1" },
    { items: many(25, 3, "reviewer"), next: null },
  ]);
  assert.deepEqual([own.items.length, own.more, own.cursors], [3, false, [null, "c1"]]);
  const nothing = await run([
    { items: many(0, 25, "proposer"), next: "c1" },
    { items: [], next: null },
  ]);
  assert.deepEqual([nothing.items.length, nothing.more], [0, false]);
  // A full page of 25 to decide, and one more on the next page: `more`.
  const full = await run([
    { items: many(0, 25, "reviewer"), next: "c1" },
    { items: many(25, 1, "reviewer"), next: null },
  ]);
  assert.deepEqual([full.items.length, full.more], [25, true]);
  assert.equal(full.items.at(-1).id, "approval_24");
  // Exactly 25, then only proposer items or the end: no `more`.
  const exact = await run([
    { items: many(0, 25, "reviewer"), next: "c1" },
    { items: many(25, 4, "proposer"), next: null },
  ]);
  assert.deepEqual([exact.items.length, exact.more], [25, false]);
  // The scan's bound: four pages, then `more` only beside a full 25.
  const endless = (role) =>
    Array.from({ length: 6 }, (_, i) => ({ items: many(i * 25, 25, role), next: `c${i + 1}` }));
  const hidden = await run(endless("proposer"));
  assert.deepEqual(
    [hidden.items.length, hidden.more, hidden.cursors.length],
    [0, false, inboxScan.approvalPages],
  );
  const some = await run([
    { items: many(0, 10, "reviewer"), next: "c1" },
    ...endless("proposer").slice(1),
  ]);
  assert.deepEqual([some.items.length, some.more, some.cursors.length], [10, false, 4]);
});

test("GET /work/inbox: a malformed row is a 503 read failure, never a partial Inbox", async (t) => {
  const s = scripted({
    enterContext: () => contextRow([disconnectRight]),
    pendingApprovalPage: [],
    inboxOperations: [operationRow("op_1", "verified")],
  });
  const { result } = await quiet(t, () => s.handler.fetch(get(base + "/inbox"), {}, ctx));
  const body = await envelope(result, 503, "unavailable");
  assert.equal(body.retryClass, "safe_read_retry");
});

// ---------------------------------------------------------------------------
const activityRow = (kind, n, over = {}) => ({
  kind,
  id: kind[0] + String(n).padStart(32, "0"),
  at: new Date(Date.UTC(2026, 9, 23, 14, 0) - n * 60000).toISOString(),
  cursor_us: String((Date.UTC(2026, 9, 23, 14, 0) - n * 60000) * 1000),
  actor_principal_id: null,
  proposal_id: null,
  task_id: null,
  store_id: S,
  connection_id: C,
  target_id: null,
  code: null,
  reason: null,
  product_count: null,
  products_drafted: null,
  products_failed: null,
  fields: null,
  ...over,
});
const stopByB = (n) =>
  activityRow("stop", n, {
    actor_principal_id: "person_b",
    target_id: I,
    code: "agents.installation.disable",
    reason: "active",
  });
const page = [
  stopByB(1),
  activityRow("stop", 2, {
    actor_principal_id: "person_b",
    target_id: C,
    code: "governance.connection.disconnect",
    reason: "already_stopped",
  }),
  activityRow("system_stop", 3, { target_id: C, code: "shopify_scopes_changed" }),
  activityRow("installation", 4, {
    actor_principal_id: "person_b",
    target_id: I,
    code: "morrow.listings",
  }),
  activityRow("run", 5, {
    actor_principal_id: "person_b",
    task_id: "task_t",
    target_id: "run_r",
    code: "succeeded",
    product_count: "3",
    products_drafted: "2",
    products_failed: "1",
    fields: '["title","tags"]',
  }),
  activityRow("decision", 6, {
    actor_principal_id: "person_b",
    proposal_id: "proposal_hidden",
    code: "approve",
  }),
  activityRow("change", 7, {
    proposal_id: "proposal_hidden",
    task_id: "task_t",
    target_id: "op_1",
    code: "verified",
    reason: "readback_matched",
  }),
];

test("GET /work/activity: each entry only for a person who may see its record", async (t) => {
  const run = async (grants) => {
    const s = scripted({
      enterContext: () => contextRow(grants),
      activityPage: page,
      proposalById: [],
    });
    const { result } = await quiet(t, () => s.handler.fetch(get(base + "/activity"), {}, ctx));
    assert.equal(result.status, 200);
    return { body: await result.json(), calls: s.calls };
  };
  // Someone with no rights on the store sees nothing of it.
  const none = await run([]);
  assert.deepEqual(none.body.entries, []);
  assert.equal(none.body.next, null);
  assert.deepEqual(none.calls.find((c) => c.name === "activityPage").values, [null, null, "101"]);
  // The steward: the disconnect and the scope change; the installation's stopper: the
  // stop and the agent added; a product reader with task.read: the run.
  const taskRead = grant(
    "workspace.task.create",
    ["view"],
    [...workPermissions["task.read"].fields],
  );
  const productRead = grant("catalog.products.read", ["view"], ["title", "tags"], storeRes);
  const all = await run([disconnectRight, stopRight, taskRead, productRead]);
  assert.deepEqual(
    all.body.entries.map((e) => [e.kind, e.actor.kind]),
    [
      ["ai_work_stopped", "person"],
      ["store_disconnected", "person"],
      ["store_ended", "shopify"],
      ["agent_added", "person"],
      ["drafts_requested", "person"],
    ],
  );
  const [stopped, disconnected, ended, added, drafts] = all.body.entries;
  assert.deepEqual(stopped, {
    id: page[0].id,
    at: page[0].at,
    actor: { kind: "person", principalId: "person_b" },
    kind: "ai_work_stopped",
    storeId: S,
    agent: "listings",
    alreadyStopped: false,
  });
  assert.equal(disconnected.alreadyStopped, true);
  assert.equal(ended.reason, "scopes_changed");
  assert.equal(added.agent, "listings");
  assert.deepEqual(
    [drafts.productCount, drafts.drafted, drafts.failed, drafts.status, drafts.taskId],
    [3, 2, 1, "succeeded", "task_t"],
  );
  // No product id, comment or reason text reaches an entry.
  assert.doesNotMatch(JSON.stringify(all.body), /product:|reason"\s*:\s*"[A-Z]/);
  // A product read on other fields does not show the run.
  const narrow = await run([
    taskRead,
    grant("catalog.products.read", ["view"], ["title"], storeRes),
  ]);
  assert.deepEqual(narrow.body.entries, []);
});

test("GET /work/activity: a person sees their own stop without the stop right", async (t) => {
  const s = scripted({
    enterContext: () => contextRow([]),
    activityPage: [
      activityRow("stop", 1, {
        actor_principal_id: "person_a",
        target_id: I,
        code: "agents.installation.disable",
        reason: "active",
      }),
    ],
  });
  const { result } = await quiet(t, () => s.handler.fetch(get(base + "/activity"), {}, ctx));
  const entries = (await result.json()).entries;
  assert.deepEqual(
    entries.map((e) => [e.kind, e.actor.principalId]),
    [["ai_work_stopped", "person_a"]],
  );
});

test("GET /work/activity: pages follow the last scanned record, whatever was hidden", async (t) => {
  const scan = activityLimits.scan;
  // A full scan with nothing visible: the next page starts after the last record scanned.
  const hidden = Array.from({ length: scan + 1 }, (_, n) => stopByB(n + 1));
  const s1 = scripted({ enterContext: () => contextRow([]), activityPage: hidden });
  const r1 = await quiet(t, () => s1.handler.fetch(get(base + "/activity"), {}, ctx));
  const b1 = await r1.result.json();
  assert.deepEqual(b1.entries, []);
  assert.equal(b1.next, encodeCursor(hidden[scan - 1]));
  // The cursor travels as two bind values, and the limit as the page's own.
  const s2 = scripted({
    enterContext: () => contextRow([stopRight]),
    activityPage: hidden.slice(0, 3),
  });
  const r2 = await quiet(t, () =>
    s2.handler.fetch(get(base + "/activity?limit=2&after=" + b1.next), {}, ctx),
  );
  const b2 = await r2.result.json();
  assert.equal(b2.entries.length, 2);
  assert.equal(b2.next, encodeCursor(hidden[1]));
  assert.deepEqual(s2.calls.find((c) => c.name === "activityPage").values, [
    hidden[scan - 1].cursor_us,
    hidden[scan - 1].id,
    String(scan + 1),
  ]);
  // The last page: fewer rows than asked for, no cursor.
  const s3 = scripted({
    enterContext: () => contextRow([stopRight]),
    activityPage: hidden.slice(0, 2),
  });
  const b3 = await (
    await quiet(t, () => s3.handler.fetch(get(base + "/activity?limit=5"), {}, ctx))
  ).result.json();
  assert.equal(b3.entries.length, 2);
  assert.equal(b3.next, null);
});

test("GET /work/activity: an unknown kind or code is a 503, never a guess", async (t) => {
  for (const row of [
    activityRow("mystery", 1),
    activityRow("stop", 1, {
      actor_principal_id: "person_b",
      target_id: I,
      code: "agents.other",
      reason: "active",
    }),
    activityRow("change", 1, {
      proposal_id: "p",
      task_id: "t",
      target_id: "o",
      code: "authorized",
    }),
  ]) {
    const s = scripted({ enterContext: () => contextRow([stopRight]), activityPage: [row] });
    const { result } = await quiet(t, () => s.handler.fetch(get(base + "/activity"), {}, ctx));
    await envelope(result, 503, "unavailable", row.kind);
  }
});
