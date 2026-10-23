import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient, isCommandKey } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort, requests } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeAccountOverview,
  decodeOrganizationSignup,
  identityOutcome,
} from "../apps/workspace-web/src/http/identity-decoders.ts";
import {
  decodeAnswer,
  decodeGoal,
  decodePage,
  decodeQuestion,
  decodeTask,
  isUtcTime,
} from "../apps/workspace-web/src/http/work-decoders.ts";
import { createPending } from "../apps/workspace-web/src/pending.ts";
import {
  validateCurrentDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";
import { json, MemoryStorage, recordingTransport } from "./fixtures/workspace-web.mjs";

// P14.T01a PR-2 on a fake fetch: the composed account and work methods (§4.2), their
// requests (AC08, AC22, AC25, AC27, AC28), the record decoders and their parity with the
// generated validators (§4.8), and unknown outcomes through the pending store (AC10,
// AC11, AC25). No browser and no network; the journey lab proves the same over HTTP.
const ws = "ws-1";
const actor = (principalId) => ({
  kind: "human",
  principalId,
  organizationId: "org-1",
  workspaceId: ws,
  membershipId: "m-" + principalId,
  installationId: null,
  mandateId: null,
});
const scope = {
  organizationId: "org-1",
  workspaceId: ws,
  storeIds: [],
  accountIds: [],
  resources: [],
  fields: [],
};
const goal = (id = "g-1", extra = {}) => ({
  schemaVersion: 1,
  id,
  organizationId: "org-1",
  workspaceId: ws,
  storeId: null,
  revision: 1,
  createdAt: "2026-10-19T09:00:00.000000Z",
  updatedAt: "2026-10-19T09:00:00.000000Z",
  status: "draft",
  objective: "Grow repeat purchases",
  scope,
  owner: actor("p-a"),
  successCriteria: [
    { description: "Revenue grows", verificationCapabilityId: null, evidenceRequired: false },
  ],
  taskIds: [],
  ...extra,
});
const task = (id = "t-1", extra = {}) => ({
  schemaVersion: 1,
  id,
  organizationId: "org-1",
  workspaceId: ws,
  storeId: null,
  revision: 2,
  createdAt: "2026-10-19T09:00:00.000Z",
  updatedAt: "2026-10-19T09:01:00.000Z",
  goalId: "g-1",
  parentTaskId: null,
  status: "draft",
  objective: "Draft titles",
  scope,
  initiatingPrincipal: actor("p-a"),
  owner: actor("p-a"),
  dependencyIds: [],
  acceptedArtifactRefs: [],
  completionEvidenceRefs: [],
  leaseGeneration: 0,
  activeRunId: null,
  ...extra,
});
const question = (id = "q-1", extra = {}) => ({
  schemaVersion: 1,
  id,
  organizationId: "org-1",
  workspaceId: ws,
  storeId: null,
  revision: 1,
  createdAt: "2026-10-19T09:00:00Z",
  updatedAt: "2026-10-19T09:00:00Z",
  taskId: "t-1",
  status: "open",
  prompt: "Which supplier?",
  answerSchemaRef: {
    organizationId: "org-1",
    workspaceId: ws,
    storeId: null,
    kind: "schema",
    id: "morrow.answer.text",
    revision: 1,
    digest: "a".repeat(64),
  },
  eligibleRespondentIds: ["p-b"],
  blocksTask: false,
  expiresAt: null,
  answerRef: null,
  answeredBy: null,
  ...extra,
});
const port = (responder, overrides = {}) => {
  const recorded = recordingTransport(responder);
  return {
    calls: recorded.calls,
    port: createHttpPort({
      client: createClient({ transport: recorded.transport, online: () => true }),
      composed: overrides.composed ?? composed,
      loginBodyVersion,
      navigationSignal: () => undefined,
    }),
  };
};
const headers = (init) => new Headers(init.headers);
const command = (body, key = "0b6f2a8e-5c1d-4e7f-9a2b-3c4d5e6f7a8b") => ({ key, body });

test("§4.2 PR-2: account.* and work.* are composed; keepAlive and people.list are not", async () => {
  // T7 PR 19: the project screens' default-off methods are uncomposed too, until their
  // routes land (tests/workspace-ui-projects.test.mjs).
  const { projectPortMethods } = await import("../packages/workspace-ui/src/port.ts");
  assert.deepEqual(
    Object.entries(composed)
      .filter(([, on]) => !on)
      .map(([method]) => method),
    ["session.keepAlive", "people.list", ...projectPortMethods],
  );
  const { calls, port: p } = port(() => json(200, {}));
  assert.deepEqual(await p.people.list(ws), { kind: "not_in_build" });
  assert.deepEqual(await p.session.keepAlive(), { kind: "not_in_build" });
  assert.equal(calls.length, 0);
});

test("AC22: GET /workspaces decodes in server order; a 401 is unauthenticated", async () => {
  const listed = {
    schemaVersion: 1,
    workspaces: [
      { organizationId: "o-2", organizationName: "B Org", workspaceId: "w-9", workspaceName: "Z" },
      { organizationId: "o-1", organizationName: "A Org", workspaceId: "w-1", workspaceName: "A" },
    ],
    truncated: true,
    onboarding: "unavailable",
  };
  assert.equal(validateCurrentDefinition("AccountOverview", listed), true);
  const { calls, port: p } = port(() => json(200, listed));
  assert.deepEqual(await p.account.overview(), {
    kind: "ok",
    value: {
      workspaces: [
        { workspaceId: "w-9", displayName: "Z", organizationName: "B Org" },
        { workspaceId: "w-1", displayName: "A", organizationName: "A Org" },
      ],
      truncated: true,
      onboarding: "unavailable",
    },
    replayed: false,
  });
  const [{ path, init }] = calls;
  assert.equal(path, "/workspaces");
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.deepEqual([...headers(init).keys()], ["x-morrow-request"]);
  const expired = port(() => json(401, { code: "authentication_required" }));
  assert.deepEqual(await expired.port.account.overview(), { kind: "unauthenticated" });
  const down = port(() => json(503, { code: "unavailable" }));
  assert.deepEqual(await down.port.account.overview(), { kind: "unavailable", offline: false });
});

test("AC22: the overview decoder agrees with the v1.1 validator on rendered fields", () => {
  const entry = {
    organizationId: "o-1",
    organizationName: "Org",
    workspaceId: "w-1",
    workspaceName: "Main",
  };
  const body = (change = {}, entries = [entry]) => ({
    schemaVersion: 1,
    workspaces: entries,
    truncated: false,
    onboarding: "available",
    ...change,
  });
  const variants = [
    body(),
    body({}, []),
    body({ onboarding: "maybe" }),
    body({ truncated: "no" }),
    body({ schemaVersion: 2 }),
    body({}, [{ ...entry, workspaceId: "bad id" }]),
    body({}, [{ ...entry, organizationName: "" }]),
    body({}, [{ ...entry, workspaceName: "x".repeat(201) }]),
    body({}, [{ ...entry, organizationId: 7 }]),
    body(
      {},
      Array.from({ length: 101 }, (_, i) => ({ ...entry, workspaceId: "w-" + i })),
    ),
  ];
  for (const variant of variants)
    assert.equal(
      decodeAccountOverview(variant) !== null,
      validateCurrentDefinition("AccountOverview", variant),
      JSON.stringify(variant).slice(0, 120),
    );
  // Stricter than the schema where it matters to the UI: a duplicate workspace id.
  assert.equal(decodeAccountOverview(body({}, [entry, entry])), null);
  assert.notEqual(decodeAccountOverview({ ...body(), extra: true }), null, "unknown ignored");
});

test("AC25: one signup POST with a lowercase UUID key and the closed body; each §9 row", async () => {
  const created = {
    schemaVersion: 1,
    outcome: "created",
    organizationId: "o-1",
    workspaceId: "w-1",
  };
  assert.equal(validateCurrentDefinition("OrganizationSignupResult", created), true);
  const { calls, port: p } = port(() => json(201, created));
  const c = command({ organizationName: "Linen", workspaceName: "Main" });
  assert.deepEqual(await p.account.createOrganization(c), {
    kind: "ok",
    value: { workspaceId: "w-1" },
    replayed: false,
  });
  const [{ path, init }] = calls;
  assert.equal(path, "/organizations");
  assert.equal(init.body, '{"schemaVersion":1,"organizationName":"Linen","workspaceName":"Main"}');
  assert.equal(headers(init).get("idempotency-key"), c.key);
  assert.ok(isCommandKey(headers(init).get("idempotency-key")));
  assert.equal(headers(init).get("content-type"), "application/json");
  const rows = [
    [201, created, { kind: "ok", value: { workspaceId: "w-1" }, replayed: false }],
    [
      200,
      { ...created, outcome: "replayed" },
      { kind: "ok", value: { workspaceId: "w-1" }, replayed: true },
    ],
    [200, created, { kind: "uncertain" }],
    [201, { ...created, workspaceId: "o-1" }, { kind: "uncertain" }],
    [400, { schemaVersion: 1, outcome: "invalid_name" }, { kind: "invalid", field: "name" }],
    [400, { code: "request_denied" }, { kind: "invalid", field: null }],
    [403, { code: "request_denied" }, { kind: "denied", message: "", reference: null }],
    [
      403,
      { schemaVersion: 1, outcome: "signup_unavailable" },
      { kind: "denied", message: "", reference: null },
    ],
    [
      409,
      { schemaVersion: 1, outcome: "already_onboarded" },
      { kind: "conflict", recheck: true, message: "" },
    ],
    [503, { schemaVersion: 1, outcome: "outcome_unknown" }, { kind: "uncertain" }],
    [503, { code: "unavailable" }, { kind: "unavailable", offline: false }],
  ];
  for (const [status, body, expected] of rows) {
    const one = port(() => json(status, body));
    assert.deepEqual(await one.port.account.createOrganization(c), expected, `${status}`);
  }
  const limited = port(() =>
    json(429, { schemaVersion: 1, outcome: "rate_limited" }, { "retry-after": "600" }),
  );
  assert.deepEqual(await limited.port.account.createOrganization(c), {
    kind: "rate_limited",
    retryAfterSeconds: 600,
  });
  // A name the client can't send is refused before anything leaves the page.
  const none = port(() => json(201, created));
  assert.equal(
    (
      await none.port.account.createOrganization(
        command({ organizationName: "", workspaceName: "x" }),
      )
    ).kind,
    "invalid",
  );
  assert.equal(none.calls.length, 0);
});

test("AC25: 503 outcome_unknown keeps the key; Check again replays; a later 429 or 503 stays unknown", async () => {
  const replies = [
    json(503, { schemaVersion: 1, outcome: "outcome_unknown" }),
    json(503, { code: "unavailable" }),
    json(429, { schemaVersion: 1, outcome: "rate_limited" }, { "retry-after": "600" }),
    json(200, { schemaVersion: 1, outcome: "replayed", organizationId: "o-1", workspaceId: "w-1" }),
  ];
  const { calls, port: p } = port(({ index }) => replies[index]);
  const pending = createPending({ storage: new MemoryStorage() });
  const c = command({ organizationName: "Linen", workspaceName: "Main" });
  const run = () => pending.run(c, null, () => p.account.createOrganization(c));
  assert.equal((await run()).kind, "uncertain");
  assert.equal((await run()).kind, "uncertain", "a 503 after uncertain stays uncertain");
  assert.equal((await run()).kind, "uncertain", "a 429 after uncertain stays uncertain");
  assert.deepEqual(await run(), { kind: "ok", value: { workspaceId: "w-1" }, replayed: true });
  assert.equal(new Set(calls.map((call) => headers(call.init).get("idempotency-key"))).size, 1);
  assert.equal(new Set(calls.map((call) => call.init.body)).size, 1);
  assert.equal(pending.blocking(), false);
});

// P05.T01ab (P04.T01i D5) on the create-organization form: the token travels only as
// X-Morrow-Challenge on POST /organizations, and the guard's replies keep their meaning.
test("P05.T01ab: a signup token travels only as X-Morrow-Challenge on POST /organizations", async () => {
  const created = {
    schemaVersion: 1,
    outcome: "created",
    organizationId: "o-1",
    workspaceId: "w-1",
  };
  const token = "tok." + "S".repeat(64);
  const { calls, port: p } = port(({ path }) =>
    path === "/workspaces"
      ? json(200, { schemaVersion: 1, workspaces: [], truncated: false, onboarding: "available" })
      : json(201, created),
  );
  const c = command({ organizationName: "Linen", workspaceName: "Main" });
  assert.equal((await p.account.overview()).kind, "ok");
  assert.equal((await p.account.createOrganization(c, token)).kind, "ok");
  await p.account.createOrganization(c, null);
  await p.account.createOrganization(c);
  assert.deepEqual(
    calls.map((call) => [call.path, headers(call.init).get("x-morrow-challenge")]),
    [
      ["/workspaces", null],
      ["/organizations", token],
      ["/organizations", null],
      ["/organizations", null],
    ],
  );
  // The token changes nothing else: same body and key.
  assert.equal(calls[1].init.body, calls[2].init.body);
  assert.equal(headers(calls[1].init).get("idempotency-key"), c.key);
  // A malformed token is refused before anything is sent.
  for (const bad of ["", "a b", "a".repeat(2049), "tok\u00e9", "a/b"])
    assert.deepEqual(await p.account.createOrganization(c, bad), { kind: "invalid", field: null });
  assert.equal(calls.length, 4);
  assert.deepEqual(requests.createOrganization(c, token), {
    method: "POST",
    path: "/organizations",
    body: '{"schemaVersion":1,"organizationName":"Linen","workspaceName":"Main"}',
    key: c.key,
    challenge: token,
  });
  assert.equal(Object.hasOwn(requests.createOrganization(c), "challenge"), false);
  assert.equal(requests.createOrganization(c, "a b"), null);
});

test("P05.T01ab: the guard's 403 challenge_* is unavailable and its 429 a hold; after an unknown outcome both stay unknown", async () => {
  const c = command({ organizationName: "Linen", workspaceName: "Main" });
  const guard = (status, outcome) =>
    json(status, { schemaVersion: 1, outcome }, status === 429 ? { "retry-after": "60" } : {});
  for (const outcome of ["challenge_required", "challenge_failed"]) {
    const one = port(() => guard(403, outcome));
    assert.deepEqual(await one.port.account.createOrganization(c, "tok.a"), {
      kind: "unavailable",
      offline: false,
    });
  }
  const limited = port(() => guard(429, "rate_limited"));
  assert.deepEqual(await limited.port.account.createOrganization(c, "tok.a"), {
    kind: "rate_limited",
    retryAfterSeconds: 60,
  });
  // Check again after an unknown outcome sends the same key and body with a new token;
  // a guard refusal in between is not a terminal reply, so the command stays unknown.
  const replies = [
    json(503, { schemaVersion: 1, outcome: "outcome_unknown" }),
    guard(403, "challenge_failed"),
    guard(429, "rate_limited"),
    json(200, { schemaVersion: 1, outcome: "replayed", organizationId: "o-1", workspaceId: "w-1" }),
  ];
  const { calls, port: p } = port(({ index }) => replies[index]);
  const pending = createPending({ storage: new MemoryStorage() });
  let n = 0;
  const run = () => pending.run(c, null, () => p.account.createOrganization(c, "tok." + ++n));
  assert.equal((await run()).kind, "uncertain");
  assert.equal((await run()).kind, "uncertain", "a challenge 403 after uncertain stays uncertain");
  assert.equal((await run()).kind, "uncertain", "a guard 429 after uncertain stays uncertain");
  assert.deepEqual(await run(), { kind: "ok", value: { workspaceId: "w-1" }, replayed: true });
  assert.deepEqual(
    calls.map((call) => headers(call.init).get("x-morrow-challenge")),
    ["tok.1", "tok.2", "tok.3", "tok.4"],
  );
  assert.equal(new Set(calls.map((call) => headers(call.init).get("idempotency-key"))).size, 1);
  assert.equal(new Set(calls.map((call) => call.init.body)).size, 1);
});

test("AC27: work reads decode v1 records and pages; a record of another workspace or id is not shown", async () => {
  const page = { schemaVersion: 1, items: [goal("g-1"), goal("g-2")], next: "cursor_1" };
  const { calls, port: p } = port(({ path }) =>
    path.startsWith("/workspace/ws-1/work/goals?")
      ? json(200, page)
      : path === "/workspace/ws-1/work/tasks/t-1"
        ? json(200, { schemaVersion: 1, task: task("t-1") })
        : path === "/workspace/ws-1/work/tasks/t-2"
          ? json(200, { schemaVersion: 1, task: task("t-1") })
          : path === "/workspace/ws-1/work/goals/g-9"
            ? json(200, { schemaVersion: 1, goal: goal("g-9", { workspaceId: "ws-2" }) })
            : json(404, {}),
  );
  const goals = await p.work.listGoals(ws, null);
  assert.equal(goals.kind, "ok");
  assert.deepEqual(
    goals.value.items.map((g) => [g.id, g.criteria, g.owner.principalId, g.owner.label]),
    [
      ["g-1", ["Revenue grows"], "p-a", null],
      ["g-2", ["Revenue grows"], "p-a", null],
    ],
  );
  assert.equal(goals.value.next, "cursor_1");
  await p.work.listGoals(ws, "cursor_1");
  assert.equal(calls[1].path, "/workspace/ws-1/work/goals?limit=25&after=cursor_1");
  const read = await p.work.getTask(ws, "t-1");
  assert.equal(read.kind, "ok");
  assert.deepEqual(
    [read.value.id, read.value.goalId, read.value.status, read.value.revision],
    ["t-1", "g-1", "draft", 2],
  );
  assert.deepEqual(await p.work.getTask(ws, "t-2"), { kind: "unavailable", offline: false });
  assert.deepEqual(await p.work.getGoal(ws, "g-9"), { kind: "unavailable", offline: false });
  // An id the client can't send is a record that can't exist: nothing is sent.
  const before = calls.length;
  assert.deepEqual(await p.work.getTask(ws, "a/b"), { kind: "not_found" });
  assert.equal(calls.length, before);
});

test("AC27: empty and denied are distinct; field_denied is denied, never partial", async () => {
  const envelope = (code, retryClass, safeMessage) => ({
    schemaVersion: 1,
    code,
    retryClass,
    safeMessage,
    correlationId: "corr-1",
    operationId: null,
    retryAfterSeconds: null,
    inputRequestIds: [],
  });
  const empty = port(() => json(200, { schemaVersion: 1, items: [], next: null }));
  assert.deepEqual(await empty.port.work.listGoals(ws, null), {
    kind: "ok",
    value: { items: [], next: null },
    replayed: false,
  });
  const denied = port(() =>
    json(403, envelope("denied", "never", "The requested fields are not permitted.")),
  );
  assert.deepEqual(await denied.port.work.listGoals(ws, null), {
    kind: "denied",
    message: "The requested fields are not permitted.",
    reference: "corr-1",
  });
  // One item that doesn't decode makes the whole page undecoded (never a partial list).
  const partial = port(() =>
    json(200, {
      schemaVersion: 1,
      items: [goal("g-1"), { ...goal("g-2"), objective: "" }],
      next: null,
    }),
  );
  assert.deepEqual(await partial.port.work.listGoals(ws, null), {
    kind: "unavailable",
    offline: false,
  });
});

test("AC27, AC28: create, mark ready and answer bodies are closed; results decode", async () => {
  const replies = {
    "/workspace/ws-1/work/goals": json(201, { schemaVersion: 1, goalId: "g-1", revision: 1 }),
    "/workspace/ws-1/work/tasks": json(201, { schemaVersion: 1, taskId: "t-1", revision: 1 }),
    "/workspace/ws-1/work/tasks/t-1/status": json(200, {
      schemaVersion: 1,
      status: "ready",
      revision: 3,
    }),
    "/workspace/ws-1/work/questions/q-1/answer": json(200, {
      schemaVersion: 1,
      answerRevision: 1,
      answerRef: { kind: "answer" },
      replayed: true,
    }),
  };
  const { calls, port: p } = port(({ path }) => replies[path] ?? json(404, {}));
  assert.deepEqual(
    await p.work.createGoal(ws, command({ objective: "Grow", criteria: ["One", "Two"] })),
    { kind: "ok", value: { goalId: "g-1" }, replayed: false },
  );
  assert.deepEqual(await p.work.createTask(ws, command({ goalId: "g-1", objective: "Do it" })), {
    kind: "ok",
    value: { taskId: "t-1" },
    replayed: false,
  });
  assert.deepEqual(await p.work.markReady(ws, "t-1", command({ expectedRevision: 2 })), {
    kind: "ok",
    value: { revision: 3 },
    replayed: false,
  });
  assert.deepEqual(
    await p.work.answer(ws, "q-1", command({ text: "Supplier A", expectedRevision: 1 })),
    { kind: "ok", value: { answerRevision: 1 }, replayed: true },
  );
  const bodies = calls.map((call) => JSON.parse(call.init.body));
  assert.deepEqual(Object.keys(bodies[0]).sort(), ["objective", "storeIds", "successCriteria"]);
  assert.deepEqual(bodies[0].storeIds, []);
  assert.equal(bodies[0].successCriteria.length, 2);
  assert.deepEqual(bodies[1], { goalId: "g-1", objective: "Do it", allowedResources: [] });
  assert.deepEqual(bodies[2], { to: "ready", expectedRevision: 2 });
  assert.deepEqual(bodies[3], { text: "Supplier A", expectedRevision: 1 });
  for (const call of calls) assert.ok(isCommandKey(headers(call.init).get("idempotency-key")));
});

test("AC28: answers decode with an opaque author; the inbox reads only open questions for me", async () => {
  const answer = {
    id: "a-1",
    questionId: "q-1",
    body: "Supplier A",
    answeredBy: actor("p-b"),
    createdAt: "2026-10-19T09:05:00.000Z",
  };
  const { calls, port: p } = port(({ path }) =>
    path === "/workspace/ws-1/work/questions/q-1/answer"
      ? json(200, { schemaVersion: 1, answer })
      : json(200, { schemaVersion: 1, items: [question("q-1")], next: null }),
  );
  const read = await p.work.getAnswer(ws, "q-1");
  assert.deepEqual(read, {
    kind: "ok",
    value: {
      id: "a-1",
      questionId: "q-1",
      text: "Supplier A",
      answeredBy: { principalId: "p-b", kind: "human", label: null, isSelf: null },
      createdAt: "2026-10-19T09:05:00.000Z",
    },
    replayed: false,
  });
  const inbox = await p.work.listMyOpenQuestions(ws, null);
  assert.equal(inbox.value.items[0].respondent.principalId, "p-b");
  assert.equal(calls[1].path, "/workspace/ws-1/work/questions?respondent=me&status=open&limit=50");
  assert.equal(decodeAnswer({ ...answer, questionId: "q-2" }, "q-1", ws), null);
});

test("§4.8: an owner or an answer's author of another tenant does not decode", async () => {
  const person = (extra) => ({ ...actor("p-x"), ...extra });
  const otherWorkspace = person({ workspaceId: "ws-2" });
  const otherOrganization = person({ organizationId: "org-2" });
  const otherTenant = person({ organizationId: "org-2", workspaceId: "ws-2" });
  for (const owner of [
    otherWorkspace,
    otherOrganization,
    otherTenant,
    person({ workspaceId: undefined }),
  ]) {
    assert.equal(decodeGoal(goal("g-1", { owner }), ws), null, JSON.stringify(owner));
    assert.equal(decodeTask(task("t-1", { owner }), ws), null, JSON.stringify(owner));
  }
  // An organization-level actor (no workspace) of the record's own organization is not
  // another tenant; of another organization it is.
  assert.notEqual(decodeGoal(goal("g-1", { owner: person({ workspaceId: null }) }), ws), null);
  assert.equal(
    decodeTask(task("t-1", { owner: person({ organizationId: "org-2", workspaceId: null }) }), ws),
    null,
  );
  const answer = {
    id: "a-1",
    questionId: "q-1",
    body: "Supplier A",
    answeredBy: actor("p-b"),
    createdAt: "2026-10-19T09:05:00.000Z",
  };
  assert.notEqual(decodeAnswer(answer, "q-1", ws), null);
  // An answer names no organization, so its author must name the path's workspace.
  for (const answeredBy of [otherWorkspace, otherTenant, person({ workspaceId: null })])
    assert.equal(decodeAnswer({ ...answer, answeredBy }, "q-1", ws), null);
  // Through the port: a foreign author is unavailable, never rendered.
  const { port: p } = port(() =>
    json(200, { schemaVersion: 1, answer: { ...answer, answeredBy: otherTenant } }),
  );
  assert.deepEqual(await p.work.getAnswer(ws, "q-1"), { kind: "unavailable", offline: false });
});

test("decoders and validators agree on every Goal, Task and Question fixture and rendered-field variant", () => {
  const fixtures = JSON.parse(readFileSync("docs/contracts/fixtures/P01.A02.json", "utf8")).filter(
    (f) => ["Goal", "Task", "Question"].includes(f.definition),
  );
  const decoders = { Goal: decodeGoal, Task: decodeTask, Question: decodeQuestion };
  for (const fixture of fixtures) {
    const decoded = decoders[fixture.definition](fixture.value, fixture.value.workspaceId) !== null;
    // Statuses decode as any string by design (§4.8): an unknown one renders as text.
    if (fixture.id.endsWith("unknown_task_state")) assert.equal(decoded, true, fixture.id);
    else assert.equal(decoded, fixture.valid, fixture.id);
  }
  const cases = [
    ["Goal", goal()],
    ["Goal", goal("g", { objective: "" })],
    ["Goal", goal("g", { objective: "x".repeat(8193) })],
    ["Goal", goal("g", { successCriteria: [] })],
    ["Goal", goal("g", { successCriteria: [{ description: "" }] })],
    ["Goal", goal("g", { owner: { ...actor("p"), kind: "robot" } })],
    ["Goal", goal("g", { owner: { ...actor("p"), principalId: "bad id" } })],
    ["Goal", goal("g", { updatedAt: "yesterday" })],
    ["Goal", goal("g", { revision: 0 })],
    ["Goal", goal("bad id")],
    ["Task", task()],
    ["Task", task("t", { goalId: "bad id" })],
    ["Task", task("t", { objective: 7 })],
    ["Task", task("t", { owner: null })],
    ["Task", task("t", { updatedAt: "2026-10-19T09:00:00+02:00" })],
    ["Question", question()],
    ["Question", question("q", { prompt: "" })],
    ["Question", question("q", { eligibleRespondentIds: ["bad id"] })],
    ["Question", question("q", { expiresAt: "soon" })],
    ["Question", question("q", { taskId: null })],
  ];
  for (const [definition, value] of cases)
    assert.equal(
      decoders[definition](value, ws) !== null,
      validateDefinition("core", definition, value),
      `${definition} ${JSON.stringify(value).slice(0, 100)}`,
    );
  assert.equal(isUtcTime("2026-10-19T09:00:00.123456Z"), true);
  assert.equal(isUtcTime("2026-13-19T09:00:00Z"), false);
  assert.equal(
    decodePage({ schemaVersion: 1, items: [], next: 7 }, () => 1),
    null,
  );
});

test("the signup decoder accepts only created on 201 and replayed on 200", () => {
  const body = (outcome) => ({ schemaVersion: 1, outcome, organizationId: "o", workspaceId: "w" });
  assert.deepEqual(decodeOrganizationSignup(body("created"), 201), { workspaceId: "w" });
  assert.deepEqual(decodeOrganizationSignup(body("replayed"), 200), { workspaceId: "w" });
  assert.equal(decodeOrganizationSignup(body("replayed"), 201), null);
  assert.equal(decodeOrganizationSignup(body("created"), 202), null);
  assert.deepEqual(
    identityOutcome(
      { kind: "response", status: 200, headers: new Headers(), body: body("replayed"), json: true },
      "command",
      decodeOrganizationSignup,
    ),
    { kind: "ok", value: { workspaceId: "w" }, replayed: true },
  );
});
