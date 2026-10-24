// v1 PR 15: the Sunrise Inbox, the exception screen and the activity log in the SPA. The
// HTTP adapter sends exactly GET /work/inbox, /work/activity and /work/operations/:id, and
// decodes the server's own replies (the inbox handler's, over a scripted connection) and
// nothing else; the Inbox preview (`samples.inbox`) is a default-off switch that sends
// nothing; Home, the sidebar and the Inbox count the same read; the fixture's scenarios
// answer every state the boards draw; a question's words render as text, never markup; and
// the copy holds none of ADR-0032 item 4's internal words. No browser and no network;
// `npm run ui:check` renders the screens.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeActivity,
  decodeInbox,
  decodeOperationDetail,
} from "../apps/workspace-web/src/http/inbox-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { createInboxApiHandler } from "../packages/work/src/inbox/http.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import {
  byInboxUrgency,
  inboxComplete,
  inboxCountLabel,
  inboxTab,
  inboxTabCount,
  openItems,
} from "../packages/workspace-ui/src/inbox-model.ts";
import { InboxRow, needsYouItems } from "../packages/workspace-ui/src/screens/inbox.tsx";
import { describeActivity, activityDay } from "../packages/workspace-ui/src/screens/activity.tsx";
import { exceptionKind } from "../packages/workspace-ui/src/screens/exception.tsx";
import { inboxCopy } from "../packages/workspace-ui/src/sunrise/inbox-copy.ts";
import { ServicesProvider } from "../packages/workspace-ui/src/services.tsx";
import { recordingTransport, json } from "./fixtures/workspace-web.mjs";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

// tsx compiles the components' JSX with the classic runtime here: React must be in scope.
globalThis.React = React;
const h = React.createElement;
const ws = fixtureWorkspace.id;
const markupServices = {
  navigate() {},
  setDirty() {},
  subscribe: () => () => {},
  version: () => 0,
};
const markup = (element) =>
  renderToStaticMarkup(h(ServicesProvider, { value: markupServices }, element));
const port = (responder) => {
  const recorded = recordingTransport(responder);
  return {
    calls: recorded.calls,
    port: createHttpPort({
      client: createClient({ transport: recorded.transport, online: () => true }),
      composed,
      loginBodyVersion,
      navigationSignal: () => undefined,
    }),
  };
};

// ---------------------------------------------------------------------------
// The server's own replies, from the inbox handler over a scripted connection.
const statementNames = new Map(Object.entries(workStatements).map(([n, t]) => [t, n]));
const O = "org_o",
  W = "ws_w",
  S = "store_s",
  C = "connection_c";
const storeRes = {
  organizationId: O,
  workspaceId: W,
  storeId: S,
  connectionId: C,
  kind: "store",
  id: S,
};
const actorRef = {
  kind: "human",
  principalId: "person_a",
  organizationId: O,
  workspaceId: W,
  membershipId: "membership_a",
  installationId: null,
  mandateId: null,
};
const disconnectRight = {
  id: "grant_disconnect",
  principal: actorRef,
  capabilityId: "governance.connection.disconnect",
  verbs: ["execute"],
  scope: {
    organizationId: O,
    workspaceId: W,
    storeIds: [S],
    accountIds: [],
    resources: [storeRes],
    fields: ["connectionId", "control"],
  },
  issuedBy: actorRef,
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
};
async function serverReply(path, replies) {
  const connection = {
    async query(text) {
      const reply = replies[statementNames.get(text)];
      return { rows: (typeof reply === "function" ? reply() : reply) ?? [] };
    },
    async close() {},
  };
  const handler = createInboxApiHandler({
    origin: workGuardOrigin,
    connector: { open: async () => connection },
    now: Date.now,
  });
  const original = console.log;
  console.log = () => {};
  try {
    const response = await handler.fetch(
      new Request(workGuardOrigin + path, {
        headers: {
          Cookie: "__Host-morrow_session=" + workGuardSecret,
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      {},
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    return response.json();
  } finally {
    console.log = original;
  }
}
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
    database_now_us: String(Date.now() * 1000),
  },
];

test("the SPA decodes the server's own Inbox and activity replies", async () => {
  const inbox = await serverReply(`/workspace/${W}/work/inbox`, {
    enterContext: () => contextRow([disconnectRight]),
    pendingApprovalPage: [],
    inboxOperations: [],
    inboxConnectionStops: [
      {
        id: "stop_1",
        store_id: S,
        connection_id: C,
        set_by_kind: "human",
        reason_code: "human_disconnect",
        created_at: "2026-10-23T14:04:00.000Z",
      },
    ],
    storeAssociation: [],
  });
  const view = decodeInbox(inbox);
  assert.ok(view, JSON.stringify(inbox));
  assert.equal(view.sections.questions, "denied");
  assert.deepEqual(
    view.items.map((i) => [i.kind, i.reason, i.open]),
    [["connection", "disconnected", true]],
  );
  const activity = await serverReply(`/workspace/${W}/work/activity?limit=5`, {
    enterContext: () => contextRow([disconnectRight]),
    activityPage: [
      {
        kind: "stop",
        id: "k" + "0".repeat(32),
        at: "2026-10-23T14:04:00.000Z",
        cursor_us: "1761228240000000",
        actor_principal_id: "person_a",
        proposal_id: null,
        task_id: null,
        store_id: S,
        connection_id: C,
        target_id: C,
        code: "governance.connection.disconnect",
        reason: "active",
        product_count: null,
        products_drafted: null,
        products_failed: null,
        fields: null,
      },
    ],
  });
  const log = decodeActivity(activity);
  assert.ok(log, JSON.stringify(activity));
  assert.deepEqual(
    log.entries.map((e) => [e.kind, e.actor.kind]),
    [["store_disconnected", "person"]],
  );
  assert.equal(log.next, null);
});

const inboxBody = (items, sections = {}, more = false) => ({
  schemaVersion: 1,
  sections: { questions: "ok", approvals: "ok", changes: "ok", connections: "ok", ...sections },
  items,
  more,
});
const question = {
  kind: "question",
  id: "q_1",
  taskId: "t_1",
  prompt: "Which collection first?",
  createdAt: "2026-10-23T14:00:00.000Z",
  open: true,
};
const approval = {
  kind: "approval",
  id: "a_1",
  proposalId: "p_1",
  storeId: S,
  capabilityId: "catalog.content.publish",
  targetCount: 2,
  expiresAt: "2026-10-26T14:00:00.000Z",
  storeLinked: true,
  open: true,
};
const exception = {
  kind: "exception",
  reason: "uncertain_operation",
  id: "00000000-0000-4000-9000-000000000001",
  proposalId: "p_1",
  taskId: "t_1",
  storeId: S,
  status: "uncertain",
  reasonCode: "fence_expired",
  updatedAt: "2026-10-23T13:00:00.000Z",
  open: true,
};

test("decodeInbox: exact shapes only; a mismatch is null, never a guess", () => {
  assert.ok(decodeInbox(inboxBody([question, approval, exception])));
  for (const [name, body] of [
    ["extra key", { ...inboxBody([]), extra: 1 }],
    ["schema", { ...inboxBody([]), schemaVersion: 2 }],
    ["unknown kind", inboxBody([{ ...question, kind: "mention" }])],
    ["extra item key", inboxBody([{ ...question, storeId: S }])],
    // A change for a store that isn't linked is never counted.
    ["blocked approval open", inboxBody([{ ...approval, storeLinked: false, open: true }])],
    // Only an unknown outcome waits on a person; the reason follows the status.
    ["failed open", inboxBody([{ ...exception, status: "failed", reason: "failed_operation" }])],
    ["reason mismatch", inboxBody([{ ...exception, reason: "failed_operation" }])],
    // A denied section sends none of its items.
    ["denied with items", inboxBody([question], { questions: "denied" })],
    ["section state", inboxBody([], { approvals: "maybe" })],
    ["duplicate", inboxBody([question, question])],
    ["empty prompt", inboxBody([{ ...question, prompt: "" }])],
    ["bad operation id", inboxBody([{ ...exception, id: "op_1" }])],
  ])
    assert.equal(decodeInbox(body), null, name);
});

test("decodeActivity and decodeOperationDetail: closed kinds, newest first, the path's operation", () => {
  const entry = {
    id: "e_1",
    at: "2026-10-23T14:00:00.000Z",
    actor: { kind: "morrow" },
    kind: "change_outcome",
    outcome: "verified",
    reasonCode: "readback_matched",
    operationId: exception.id,
    proposalId: "p_1",
    taskId: "t_1",
    storeId: S,
  };
  const older = { ...entry, id: "e_2", at: "2026-10-22T14:00:00.000Z" };
  assert.ok(decodeActivity({ schemaVersion: 1, entries: [entry, older], next: "abc" }));
  for (const [name, entries] of [
    ["order", [older, entry]],
    ["actor", [{ ...entry, actor: { kind: "person", principalId: "p" } }]],
    ["outcome", [{ ...entry, outcome: "done" }]],
    ["extra", [{ ...entry, productId: "product:1" }]],
    ["duplicate", [entry, entry]],
  ])
    assert.equal(decodeActivity({ schemaVersion: 1, entries, next: null }), null, name);
  const operation = {
    operationId: exception.id,
    taskId: "t_1",
    storeId: S,
    proposalId: "p_1",
    productId: "product:1",
    targetIndex: 0,
    status: "uncertain",
    reason: "fence_expired",
    uncertaintyReason: "unknown_submission",
    verdict: null,
    attempt: 1,
    sendStartedAt: "2026-10-23T13:00:00.000Z",
    submittedAt: null,
    createdAt: "2026-10-23T13:00:00.000Z",
    updatedAt: "2026-10-23T13:00:00.000Z",
  };
  const doc = {
    schemaVersion: 1,
    operation,
    transitions: [
      {
        revision: 1,
        from: "authorized",
        to: "dispatching",
        reason: null,
        occurredAt: "2026-10-23T13:00:00.000Z",
      },
    ],
    readbacks: [
      {
        sequence: 1,
        observedAt: "2026-10-23T13:01:00.000Z",
        outcome: "unavailable",
        verdict: null,
        fields: null,
      },
    ],
  };
  const decoded = decodeOperationDetail(doc, exception.id);
  assert.equal(decoded.storeId, S);
  assert.equal(decoded.readbacks.length, 1);
  assert.equal(decodeOperationDetail(doc, "00000000-0000-4000-9000-000000000002"), null);
  assert.equal(decodeOperationDetail({ ...doc, extra: 1 }, exception.id), null);
  // The exception screen words the status alone: a change a person checked in Shopify is
  // still unconfirmed to Morrow (never done), and says it was set aside.
  const kind = (status) => exceptionKind({ ...decoded, operation: { ...operation, status } });
  assert.deepEqual(["uncertain", "cancel_requested", "failed", "conflict", "verified"].map(kind), [
    "uncertain",
    "set_aside",
    "failed",
    "failed",
    "settled",
  ]);
});

test("the HTTP adapter: three GETs with no body, and the preview sends nothing", async () => {
  const { calls, port: p } = port(({ path }) =>
    path.endsWith("/inbox")
      ? json(200, inboxBody([question]))
      : path.includes("/activity")
        ? json(200, { schemaVersion: 1, entries: [], next: null })
        : json(404, {}),
  );
  assert.equal(composed["inbox.read"], true);
  assert.equal(composed["inbox.operation"], true);
  assert.equal(composed["inbox.activity"], true);
  assert.equal(composed["samples.inbox"], false);
  const read = await p.inbox.read(ws);
  assert.equal(read.kind, "ok");
  assert.equal((await p.inbox.activity(ws, "abc_DEF-1")).kind, "ok");
  assert.deepEqual(await p.samples.inbox(ws), { kind: "not_in_build" });
  // An operation id outside the server's pattern names nothing: not found, nothing sent.
  assert.deepEqual(await p.inbox.operation(ws, "op_1"), { kind: "not_found" });
  assert.deepEqual(
    calls.map((c) => [c.path, c.init.method ?? "GET", c.init.body ?? null]),
    [
      [`/workspace/${ws}/work/inbox`, "GET", null],
      [`/workspace/${ws}/work/activity?limit=25&after=abc_DEF-1`, "GET", null],
    ],
  );
  // A reply that doesn't decode is an unconfirmed read, never a guess.
  const bad = port(() => json(200, { ...inboxBody([]), extra: true }));
  assert.equal((await bad.port.inbox.read(ws)).kind, "unavailable");
});

test("one count: Home, the sidebar and the Inbox count the open items of the same read", () => {
  const blocked = { ...approval, id: "a_2", storeLinked: false, open: false };
  const failed = {
    ...exception,
    id: "00000000-0000-4000-9000-000000000002",
    status: "failed",
    reason: "failed_operation",
    open: false,
  };
  const view = decodeInbox(inboxBody([question, approval, blocked, exception, failed]));
  assert.equal(openItems(view).length, 3);
  assert.equal(inboxCountLabel(view), "3");
  assert.equal(inboxCountLabel({ ...view, more: true }), "3+");
  assert.deepEqual(
    ["all", "review", "questions", "problems"].map((t) => inboxTabCount(view, t)),
    [3, 1, 1, 1],
  );
  assert.deepEqual(
    view.items.map((i) => inboxTab(i)),
    ["questions", "review", "review", "problems", "problems"],
  );
  // The most urgent first: what went wrong, then changes, then questions, then information.
  assert.deepEqual(
    byInboxUrgency(view.items).map((i) => i.id),
    [exception.id, "a_1", "q_1", failed.id, "a_2"],
  );
  assert.deepEqual(
    needsYouItems(view).map((i) => i.id),
    [exception.id, "a_1", "q_1"],
  );
  assert.equal(inboxComplete(view), true);
  assert.equal(
    inboxComplete({ ...view, sections: { ...view.sections, changes: "denied" } }),
    false,
  );
});

test("the fixture answers the boards' states from its own state", async () => {
  const ready = (await createFixtureAdapter("ready").inbox.read(ws)).value;
  assert.deepEqual(
    ready.items.map((i) => [i.kind, i.open]),
    [
      ["approval", true],
      ["question", true],
      ["question", true],
    ],
  );
  const problems = (await createFixtureAdapter("inbox_problems").inbox.read(ws)).value;
  assert.deepEqual(
    problems.items.map((i) => [i.kind, i.reason ?? null, i.open]),
    [
      ["connection", "disconnected", true],
      ["exception", "uncertain_operation", true],
      ["exception", "failed_operation", false],
      ["approval", null, false],
      ["question", null, true],
      ["question", null, true],
    ],
  );
  // Each fixture reply is one the HTTP decoder accepts.
  for (const view of [ready, problems])
    assert.deepEqual(decodeInbox({ schemaVersion: 1, ...view }), view);
  const empty = (await createFixtureAdapter("empty").inbox.read(ws)).value;
  assert.equal(empty.items.length, 0);
  const denied = (await createFixtureAdapter("home_partial_denied").inbox.read(ws)).value;
  assert.equal(denied.sections.questions, "denied");
  // The preview answers only in its own scenario.
  assert.equal((await createFixtureAdapter("ready").samples.inbox(ws)).kind, "not_in_build");
  const preview = await createFixtureAdapter("inbox_preview").samples.inbox(ws);
  assert.deepEqual(
    preview.value.items.map((i) => i.kind),
    ["run_question", "reconnect"],
  );
  // The log pages: four at a time in activity_more, with a next cursor.
  const more = createFixtureAdapter("activity_more");
  const first = (await more.inbox.activity(ws, null)).value;
  assert.equal(first.entries.length, 4);
  const second = (await more.inbox.activity(ws, first.next)).value;
  assert.notEqual(second.entries[0].id, first.entries[0].id);
  assert.ok(decodeActivity({ schemaVersion: 1, ...first }));
  // The exception screen's operation.
  const op = await createFixtureAdapter("inbox_problems").inbox.operation(
    ws,
    "00000000-0000-4000-9000-000000000201",
  );
  assert.equal(op.value.operation.status, "uncertain");
});

test("a question's words are text: markup in a prompt renders escaped, never as HTML", () => {
  const html = markup(
    h(InboxRow, {
      ws,
      item: { ...question, prompt: '<img src=x onerror="alert(1)"><b>Bold?</b>' },
      shop: "linen.example",
    }),
  );
  assert.ok(
    html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;b&gt;Bold?&lt;/b&gt;"),
    html,
  );
  assert.ok(!html.includes("<img") && !html.includes("<b>"), html);
  assert.match(html, new RegExp(`href="/w/${ws}/inbox/questions/q_1"`));
  // Each kind opens its own screen.
  const row = (item) => markup(h(InboxRow, { ws, item, shop: "linen.example" }));
  assert.match(row(approval), new RegExp(`href="/w/${ws}/review/p_1"`));
  assert.match(row(exception), new RegExp(`href="/w/${ws}/inbox/exceptions/${exception.id}"`));
  assert.match(
    row({
      kind: "connection",
      reason: "disconnected",
      id: C,
      storeId: S,
      setBy: "human",
      since: "2026-10-23T14:04:00.000Z",
      open: true,
    }),
    new RegExp(`href="/w/${ws}/connections/${C}"`),
  );
  // An unknown outcome never reads as done: Needs attention, with the three dots.
  assert.match(row(exception), /Needs attention/);
  assert.doesNotMatch(row(exception), /Applied|Updated in Shopify/);
  // No screen of this PR renders HTML from a string.
  for (const file of ["inbox.tsx", "exception.tsx", "activity.tsx"])
    assert.doesNotMatch(
      readFileSync(`packages/workspace-ui/src/screens/${file}`, "utf8"),
      /dangerouslySetInnerHTML|innerHTML/,
      file,
    );
});

test("the activity log in plain words: what happened, never more than the record says", () => {
  const base = { id: "e", at: "2026-10-23T14:00:00.000Z" };
  const person = { kind: "person", principalId: "prn-sample-7f3a" };
  const line = (r) => describeActivity({ ...base, ...r });
  assert.deepEqual(
    line({
      actor: { kind: "morrow" },
      kind: "change_outcome",
      outcome: "unknown",
      reasonCode: "fence_expired",
      operationId: exception.id,
      proposalId: "p",
      taskId: "t",
      storeId: S,
    }),
    {
      actor: { kind: "morrow", name: "Morrow" },
      what: "couldn’t confirm a change reached Shopify",
      detail: "Morrow won’t send it again until it knows what happened.",
      badge: "needs_you",
      category: "store",
    },
  );
  const verified = line({
    actor: { kind: "morrow" },
    kind: "change_outcome",
    outcome: "verified",
    reasonCode: null,
    operationId: exception.id,
    proposalId: "p",
    taskId: "t",
    storeId: S,
  });
  assert.equal(verified.badge, "updated_in_shopify");
  const declined = line({
    actor: person,
    kind: "approval_decided",
    decision: "reject",
    proposalId: "p",
    taskId: null,
    storeId: S,
    targetCount: 1,
  });
  // A person is an opaque label, never "You" and never a name the server didn't send.
  assert.equal(declined.actor.name, "Member · 7f3a");
  assert.equal(declined.what, "declined changes to 1 product");
  assert.match(declined.detail, /Nothing changed in your store/);
  const drafts = line({
    actor: person,
    kind: "drafts_requested",
    taskId: "t",
    storeId: S,
    productCount: 3,
    status: "succeeded",
    drafted: 2,
    failed: 1,
  });
  assert.equal(drafts.what, "asked Listings to suggest changes for 3 products");
  assert.equal(drafts.detail, "2 suggestions ready to review · 1 product couldn’t be done");
  assert.equal(drafts.category, "work");
  // A disconnect of a store whose connection was already stopped says so.
  const disconnect = (alreadyStopped) =>
    line({ actor: person, kind: "store_disconnected", storeId: S, alreadyStopped }).detail;
  assert.equal(disconnect(false), inboxCopy.activity.disconnectedDetail);
  assert.equal(disconnect(true), inboxCopy.activity.alreadyDisconnected);
  const now = new Date(2026, 9, 23, 18, 0);
  assert.match(
    activityDay(new Date(2026, 9, 23, 9, 0).toISOString(), now),
    /^Today, Friday, October 23$/,
  );
  assert.match(activityDay(new Date(2026, 9, 22, 9, 0).toISOString(), now), /^Yesterday, /);
  assert.equal(activityDay(new Date(2026, 9, 2, 9, 0).toISOString(), now), "Friday, October 2");
});

// ADR-0032 item 4: internal terms stay out of the interface (the team test's list).
const banned =
  /\b(?:runs?|tokens?|digests?|mandates?|tool calls?|workflows?|triggers?|webhooks?|queues?|retry|retries|scopes?|api|prompts?|sandbox(?:es)?|artifacts?|releases?|install(?:ed|s|ing)?|coordinator|delegat\w*|threads?|operations?|proposals?|idempotency|reconcile\w*)\b/i;
function strings(value, path, out) {
  if (typeof value === "string") out.push([path, value]);
  else if (typeof value === "function") {
    // Copy functions take text and counts in turn; a few take lists of words.
    let result;
    try {
      result = value(...Array.from({ length: value.length }, (_, i) => (i % 2 ? 3 : "Sample")));
    } catch {
      result = value(...Array.from({ length: value.length }, () => ["Sample", "Words"]));
    }
    strings(result, path + "()", out);
  } else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  return out;
}
test("copy: plain words, none of the internal terms", () => {
  const all = strings(inboxCopy, "inboxCopy", []);
  assert.ok(all.length > 80, String(all.length));
  assert.deepEqual(
    all.filter(([, text]) => banned.test(text)),
    [],
  );
  // The buttons start with a verb.
  for (const label of [
    inboxCopy.showEverything,
    inboxCopy.tryAgain,
    inboxCopy.banner.open,
    inboxCopy.detail.openReview,
    inboxCopy.activity.showEarlier,
  ])
    assert.match(label, /^(Show|Try|Open)\b/);
});
