// PR 18: the goal and plan-start routes of the workspace API in Node
// (packages/work/src/projects/http.ts; ADR-0033, ADR-0034). Both switches default off and
// answer before any connection opens: the goal routes until T7 uses them, the start routes
// while docs/decisions/plan-drafts-staging.json holds them, and a Morrow card while plan
// drafts are off. Every closed-body refusal is decided before any SQL connection opens: a
// body naming a tenant, an actor, a grant or a start value is refused. Over a scripted SQL
// connection: an Everyday work area's start (document, then the one transaction) as the
// person's own commands, an area whose agent is not added, a card for someone else, an
// unknown digest and a changed grant summary. lab:plan-start drives the same handler
// against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import defaultWorker, { apiDispatch } from "../apps/api/src/worker.ts";
import {
  createProjectsApiHandler,
  projectRoutes,
  projectsPathPattern,
} from "../packages/work/src/projects/http.ts";
import { startGate } from "../packages/work/src/projects/commands.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { planDraftsRecord } from "../packages/policy/src/projects/plan-draft.ts";
import {
  validateCurrentDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";
import { sessionCookieDigest } from "../packages/identity/src/request-primitives.ts";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

const ctx = { waitUntil() {} };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const sessionDigest = await sessionCookieDigest("__Host-morrow_session=" + workGuardSecret);
let keys = 0;
const nextKey = () =>
  "0b6f2c1e-5d4a-4f8e-9c3b-" + String(++keys).padStart(12, "0").replace(/^0/, "a");
const writeHeaders = (overrides = {}) => ({
  Cookie: "__Host-morrow_session=" + workGuardSecret,
  Origin: workGuardOrigin,
  "Content-Type": "application/json",
  "X-Morrow-Request": "1",
  "Idempotency-Key": nextKey(),
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  ...overrides,
});
const readHeaders = () => ({
  Cookie: "__Host-morrow_session=" + workGuardSecret,
  "Sec-Fetch-Site": "same-origin",
});
function request(method, path, body) {
  const headers = new Headers(method === "GET" ? readHeaders() : writeHeaders());
  const init = { method, headers };
  if (method !== "GET") init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(workGuardOrigin + path, init);
}
const base = "/workspace/ws_w/work";
const revise = base + "/goals/goal_a/revise";
const checks = base + "/goals/goal_a/checks";
const progress = base + "/goals/goal_a/progress";
const startDocument = base + "/plans/start-document";
const start = base + "/plans/start";
const criteria = [
  {
    description: "Every product has a complete listing",
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: "pages_complete",
    measure: {
      kind: "checklist",
      checklistId: "product_facts_complete",
      productIds: [],
      target: 100,
      dueAt: null,
      startRef: null,
    },
  },
];
const reviseBody = (over = {}) => ({
  expectedRevision: 2,
  objective: "Every product has a complete listing",
  dueAt: "2026-12-01T00:00:00.000Z",
  successCriteria: criteria,
  ...over,
});
const checkBody = (over = {}) => ({
  key: "ai_named",
  productId: "product:1",
  assistant: "chatgpt",
  answers: ["named_this_product"],
  ...over,
});
const areaCard = { card: { kind: "area", areaTemplateId: "product_pages" } };
const draftCard = { messageId: "message_1", draftDigest: "d".repeat(64) };
const startBody = { documentDigest: "a".repeat(64), nonce: "b".repeat(64) };

function countingConnector() {
  const counter = { opens: 0 };
  return {
    counter,
    connector: {
      async open() {
        counter.opens++;
        throw Error("NO_DATABASE_IN_THIS_TEST");
      },
    },
  };
}
const handlerWith = (options, connector) =>
  createProjectsApiHandler({
    origin: workGuardOrigin,
    connector,
    now: Date.now,
    goals: options.goals ?? false,
    planDrafts: options.planDrafts ?? { switch: "off", start_routes: "held" },
  });
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
  assert.equal(response.headers.get("cache-control"), "no-store", name);
  return body;
}

test("the routes and the api dispatch: goal and plan paths go to the projects handler", () => {
  assert.deepEqual(
    projectRoutes.map((r) => r.method + " " + r.pattern),
    [
      "POST /goals/:goalId/revise",
      "POST /goals/:goalId/checks",
      "GET /goals/:goalId/progress",
      "POST /plans/start-document",
      "POST /plans/start",
    ],
  );
  for (const path of [revise, checks, progress, startDocument, start]) {
    assert.ok(projectsPathPattern.test(path), path);
    assert.equal(apiDispatch(path), "projects", path);
  }
  for (const [path, row] of [
    [base + "/goals", "work"],
    [base + "/goals/goal_a", "work"],
    [base + "/goals/goal_a/status", "work"],
    [base + "/goals/goal_a/revise/extra", "work"],
    [base + "/plans", "work"],
    [base + "/plans/start/again", "work"],
  ])
    assert.equal(apiDispatch(path), row, path);
  // The api composes the committed record: off, with the start routes held.
  assert.deepEqual({ ...planDraftsRecord }, { switch: "off", start_routes: "held" });
});

test("the unbound artifact answers 401 on every projects route with no I/O", async (t) => {
  await quiet(t, async () => {
    for (const [method, path, body] of [
      ["POST", revise, reviseBody()],
      ["POST", checks, checkBody()],
      ["GET", progress],
      ["POST", startDocument, areaCard],
      ["POST", start, startBody],
    ]) {
      const response = await defaultWorker.fetch(request(method, path, body), {}, ctx);
      await envelope(response, 401, "denied", method + " " + path);
    }
  });
  const { connector } = countingConnector();
  for (const bad of [
    { goals: "yes" },
    { planDrafts: { switch: "maybe", start_routes: "held" } },
    { planDrafts: { switch: "off", start_routes: "open" } },
    { planDrafts: null },
  ])
    assert.throws(
      () =>
        createProjectsApiHandler({
          origin: workGuardOrigin,
          connector,
          now: Date.now,
          goals: false,
          planDrafts: { switch: "off", start_routes: "held" },
          ...bad,
        }),
      /PROJECTS_API_CONFIGURATION_INVALID/,
    );
});

test("default off: the goal routes and the held start routes answer 503 before any connection", async (t) => {
  const { counter, connector } = countingConnector();
  const off = handlerWith({}, connector);
  const { lines } = await quiet(t, async () => {
    for (const [method, path, body] of [
      ["POST", revise, reviseBody()],
      ["POST", checks, checkBody()],
      ["GET", progress],
    ]) {
      const response = await off.fetch(request(method, path, body), {}, ctx);
      const e = await envelope(response, 503, "unavailable", method + " " + path);
      assert.equal(e.safeMessage, "Goals are not available yet.");
    }
    // Held: every start, a code-built card included, before any document, lock or record.
    for (const [path, body] of [
      [startDocument, areaCard],
      [startDocument, { card: { kind: "quick_tasks" } }],
      [startDocument, draftCard],
      [start, startBody],
    ]) {
      const response = await off.fetch(request("POST", path, body), {}, ctx);
      const e = await envelope(response, 503, "unavailable", path);
      assert.equal(e.safeMessage, "Starting plans is not available yet.");
    }
  });
  assert.equal(counter.opens, 0);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).outcome),
    [
      "goals_unavailable",
      "goals_unavailable",
      "goals_unavailable",
      "start_unavailable",
      "start_unavailable",
      "start_unavailable",
      "start_unavailable",
    ],
  );
  // Ready with the switch off: a Morrow card is refused before any connection, while a
  // code-built card (an area, Quick tasks) reaches the database.
  const ready = handlerWith({ planDrafts: { switch: "off", start_routes: "ready" } }, connector);
  await quiet(t, async () => {
    const draft = await ready.fetch(request("POST", startDocument, draftCard), {}, ctx);
    const e = await envelope(draft, 503, "unavailable", "draft card");
    assert.equal(e.safeMessage, "Morrow's plan cards are not available yet.");
    assert.equal(counter.opens, 0);
    for (const body of [areaCard, { card: { kind: "quick_tasks" } }]) {
      const coded = await ready.fetch(request("POST", startDocument, body), {}, ctx);
      await envelope(coded, 503, "unavailable", "code-built card reaches the connector");
    }
    assert.equal(counter.opens, 2);
  });
  // The gate itself, as a pure function.
  const held = { switch: "off", start_routes: "held" };
  const openOff = { switch: "off", start_routes: "ready" };
  const on = { switch: "on", start_routes: "ready" };
  assert.equal(startGate("goal.revise", {}, held), "ok");
  assert.equal(startGate("plan.start", {}, held), "start_unavailable");
  assert.equal(startGate("plan.start_document", { kind: "draft" }, openOff), "plan_drafts_off");
  assert.equal(startGate("plan.start_document", { kind: "area" }, openOff), "ok");
  assert.equal(startGate("plan.start_document", { kind: "draft" }, on), "ok");
  // The confirmation carries no card kind: the transaction refuses a Morrow card's document
  // while the switch is off (plan_drafts_off), after reading it.
  assert.equal(startGate("plan.start", {}, openOff), "ok");
});

test("closed bodies: tenants, actors, grants and start values are refused before any connection", async (t) => {
  const { counter, connector } = countingConnector();
  const open = handlerWith(
    { goals: true, planDrafts: { switch: "on", start_routes: "ready" } },
    connector,
  );
  const withStart = structuredClone(criteria);
  withStart[0].measure.startRef = "value_1";
  const fourMeasured = [0, 1, 2, 3].map((i) => ({
    ...structuredClone(criteria[0]),
    key: "goal_" + i,
  }));
  const late = structuredClone(criteria);
  late[0].measure.dueAt = "2027-01-01T00:00:00.000Z";
  const cases = [
    [revise, reviseBody({ successCriteria: withStart })],
    [revise, reviseBody({ successCriteria: fourMeasured })],
    [revise, reviseBody({ successCriteria: late })],
    [revise, reviseBody({ workspaceId: "ws_other" })],
    [revise, reviseBody({ goalId: "goal_b" })],
    [revise, { ...reviseBody(), expectedRevision: undefined }],
    [checks, checkBody({ value: 3 })],
    [checks, checkBody({ readTags: [] })],
    [checks, checkBody({ assistant: "claude" })],
    [checks, checkBody({ answers: ["named_this_product", "maybe"] })],
    [startDocument, { ...draftCard, actor: "person_b" }],
    [startDocument, { ...draftCard, organizationId: "org_o" }],
    [startDocument, { messageId: "message_1", draftDigest: "not-a-digest" }],
    [startDocument, { card: { kind: "area", areaTemplateId: "quick_tasks" } }],
    [startDocument, { card: { kind: "area", areaTemplateId: "warehouse" } }],
    [startDocument, { card: { kind: "quick_tasks", grants: [] } }],
    [startDocument, { card: { kind: "finish" } }],
    [startDocument, { ...areaCard, records: {} }],
    [start, { ...startBody, nonce: "short" }],
    [start, { ...startBody, actor: "person_a" }],
    [start, { documentDigest: "a".repeat(64) }],
    [start, "not json"],
  ];
  await quiet(t, async () => {
    for (const [index, [path, body]] of cases.entries()) {
      const response = await open.fetch(request("POST", path, body), {}, ctx);
      await envelope(response, 400, "missing_input", index + " " + path);
    }
  });
  assert.equal(counter.opens, 0);
});

// ---------------------------------------------------------------------------
// A scripted SQL connection: each statement's reply by name, every call recorded.
const statementNames = new Map(Object.entries(workStatements).map(([name, text]) => [text, name]));
const W = {
  organizationId: "org_o",
  workspaceId: "ws_w",
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: "ws_w",
};
const actorRef = {
  kind: "human",
  principalId: "person_a",
  organizationId: "org_o",
  workspaceId: "ws_w",
  membershipId: "membership_a",
  installationId: null,
  mandateId: null,
};
const grant = (capabilityId, verbs, fields, over = {}) => ({
  id: "grant_" + capabilityId.replaceAll(".", "_"),
  principal: actorRef,
  capabilityId,
  verbs,
  scope: {
    organizationId: "org_o",
    workspaceId: "ws_w",
    storeIds: [],
    accountIds: [],
    resources: [W],
    fields,
  },
  issuedBy: actorRef,
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
  ...over,
});
const startGrants = () => [
  grant("workspace.goal.create", ["view", "execute"], ["objective", "storeIds", "successCriteria"]),
  grant("workspace.project.create", ["view", "execute"], ["goalId", "tabs", "title"]),
];
const nowUs = () => String(Date.now() * 1000);
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
  return { calls, connector: { open: async () => connection } };
}
const contextRow = (grants = startGrants()) => [
  {
    principal_id: "person_a",
    organization_id: "org_o",
    workspace_id: "ws_w",
    membership_id: "membership_a",
    policy_revision: "1",
    grants: JSON.stringify(grants),
    grant_count: String(grants.length),
    grants_digest: "c".repeat(64),
    database_now_us: nowUs(),
  },
];
const readyOff = { planDrafts: { switch: "off", start_routes: "ready" } };

test("an area's start: the server-built document, then one transaction as the person's own commands", async (t) => {
  let stored = null;
  const document = scripted({
    enterContext: () => contextRow(),
    beginProjectCommand: [{ outcome: "new" }],
    areaGoal: [],
    areaAgentAdded: [{ added: "1" }],
    cmdPlanStartDocument: (values) => {
      stored = values;
      return [
        {
          outcome: "applied",
          result: JSON.stringify({
            documentId: values[3],
            documentDigest: values[5],
            expiresAt: JSON.parse(values[4]).expiresAt,
          }),
        },
      ];
    },
  });
  const issued = await quiet(t, () =>
    handlerWith(readyOff, document.connector).fetch(
      request("POST", startDocument, areaCard),
      {},
      ctx,
    ),
  );
  const response = issued.result;
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.ok(validateCurrentDefinition("PlanStartDocument", body.document));
  assert.equal(body.document.purpose, "area");
  assert.deepEqual(body.document.actor, actorRef);
  assert.deepEqual(body.document.target, { kind: "area", areaTemplateId: "product_pages" });
  assert.equal(body.document.records.goal.areaTemplateId, "product_pages");
  assert.equal(body.document.records.goal.dueAt, null);
  assert.deepEqual(body.document.records.project, { title: "Product pages", pin: false });
  assert.equal(body.document.contextTaint, "none");
  assert.equal(
    Date.parse(body.document.expiresAt) - Date.parse(body.document.createdAt),
    5 * 60 * 1000,
  );
  assert.match(body.nonce, /^[a-f0-9]{64}$/);
  // The definer stores the canonical text, its digest and only the nonce's digest.
  assert.equal(stored[5], sha(stored[4]));
  assert.equal(body.documentDigest, stored[5]);
  assert.equal(stored[6], sha(body.nonce));
  assert.notEqual(stored[6], body.nonce);
  assert.deepEqual(
    document.calls.map((c) => c.name),
    [
      "prologueReadWrite",
      "enterContext",
      "beginProjectCommand",
      "areaGoal",
      "areaAgentAdded",
      "cmdPlanStartDocument",
      "commit",
    ],
  );
  // The session the cookie names, never a body value.
  assert.deepEqual(document.calls[1].values, [sessionDigest, "ws_w"]);

  // The confirmation: the document read by digest, every piece again under live grants.
  let startValues = null;
  const confirm = scripted({
    enterContext: () => contextRow(),
    beginProjectCommand: [{ outcome: "new" }],
    planStartDocument: [
      {
        id: stored[3],
        purpose: "area",
        canonical: stored[4],
        message_id: null,
        draft_revision: null,
        expires_at: body.document.expiresAt,
        consumed: "false",
      },
    ],
    areaAgentAdded: [{ added: "1" }],
    cmdPlanStart: (values) => {
      startValues = values;
      return [
        {
          outcome: "applied",
          result: JSON.stringify({
            goalId: "goal_new",
            projectId: "project_new",
            taskIds: [],
            routineIds: [],
          }),
        },
      ];
    },
  });
  const started = await quiet(t, () =>
    handlerWith(readyOff, confirm.connector).fetch(
      request("POST", start, { documentDigest: body.documentDigest, nonce: body.nonce }),
      {},
      ctx,
    ),
  );
  assert.equal(started.result.status, 201);
  const result = await started.result.json();
  const { schemaVersion, ...plain } = result;
  assert.equal(schemaVersion, 1);
  assert.ok(validateCurrentDefinition("PlanStartResult", plain));
  assert.deepEqual(result, {
    schemaVersion: 1,
    goalId: "goal_new",
    projectId: "project_new",
    taskIds: [],
    routineIds: [],
    runs: [],
  });
  assert.equal(startValues[3], body.documentDigest);
  assert.equal(startValues[4], sha(body.nonce));
  assert.equal(startValues[5], body.document.grantSummaryDigest);
  assert.equal(startValues[6], "{}");

  // A grant revoked, narrowed or issued since the document: stale, no definer.
  const narrowed = scripted({
    enterContext: () => contextRow(startGrants().slice(0, 1)),
    beginProjectCommand: [{ outcome: "new" }],
    planStartDocument: [confirmRow(stored, body)],
    areaAgentAdded: [{ added: "1" }],
  });
  const stale = await quiet(t, () =>
    handlerWith(readyOff, narrowed.connector).fetch(
      request("POST", start, { documentDigest: body.documentDigest, nonce: body.nonce }),
      {},
      ctx,
    ),
  );
  await envelope(stale.result, 409, "conflict", "changed grants");
  assert.ok(!narrowed.calls.some((c) => c.name === "cmdPlanStart"));
  assert.equal(narrowed.calls.at(-1).name, "rollback");

  // Unknown, consumed or expired: stale before any lock or write.
  for (const row of [
    [],
    [{ ...confirmRow(stored, body), consumed: "true" }],
    [{ ...confirmRow(stored, body), expires_at: "2026-01-01T00:00:00.000Z" }],
  ]) {
    const s = scripted({
      enterContext: () => contextRow(),
      beginProjectCommand: [{ outcome: "new" }],
      planStartDocument: row,
    });
    const r = await quiet(t, () =>
      handlerWith(readyOff, s.connector).fetch(
        request("POST", start, { documentDigest: body.documentDigest, nonce: body.nonce }),
        {},
        ctx,
      ),
    );
    await envelope(r.result, 409, "conflict", "stale document");
    assert.ok(!s.calls.some((c) => c.name === "cmdPlanStart"));
  }
});
function confirmRow(stored, body) {
  return {
    id: stored[3],
    purpose: "area",
    canonical: stored[4],
    message_id: null,
    draft_revision: null,
    expires_at: body.document.expiresAt,
    consumed: "false",
  };
}

test("refusals before the definer: no agent added, an area that exists, a Member without project.create", async (t) => {
  const run = async (replies, body = areaCard) => {
    const s = scripted({
      enterContext: () => contextRow(),
      beginProjectCommand: [{ outcome: "new" }],
      ...replies,
    });
    const { result } = await quiet(t, () =>
      handlerWith(readyOff, s.connector).fetch(request("POST", startDocument, body), {}, ctx),
    );
    assert.ok(!s.calls.some((c) => c.name === "cmdPlanStartDocument"));
    assert.equal(s.calls.at(-1).name, "rollback");
    return result;
  };
  const notAdded = await run({ areaGoal: [], areaAgentAdded: [{ added: "0" }] });
  const e = await envelope(notAdded, 409, "conflict", "agent not added");
  assert.equal(e.safeMessage, "Add this area's agent first.");
  // Quick tasks needs no agent, only the Owner's tap (ADR-0033 item 7): the Owner is read
  // from the solo-owner facts before anything else.
  const ownerRow = (principal, membership) => [
    { owner_principal_id: principal, owner_membership_id: membership },
  ];
  for (const [name, owner] of [
    ["another member is the Owner", ownerRow("person_b", "membership_b")],
    ["no Owner", ownerRow(null, null)],
    ["the Owner's principal under another membership", ownerRow("person_a", "membership_old")],
  ]) {
    const notOwner = scripted({
      enterContext: () => contextRow(),
      beginProjectCommand: [{ outcome: "new" }],
      reviewContext: owner,
      areaGoal: [],
    });
    const refused = await quiet(t, () =>
      handlerWith(readyOff, notOwner.connector).fetch(
        request("POST", startDocument, { card: { kind: "quick_tasks" } }),
        {},
        ctx,
      ),
    );
    const body = await envelope(refused.result, 403, "denied", name);
    assert.equal(body.safeMessage, "Only the workspace owner can set up Quick tasks.");
    assert.ok(
      !notOwner.calls.some((c) => c.name === "areaGoal" || c.name === "cmdPlanStartDocument"),
    );
    assert.equal(notOwner.calls.at(-1).name, "rollback");
  }
  const quick = scripted({
    enterContext: () => contextRow(),
    beginProjectCommand: [{ outcome: "new" }],
    reviewContext: ownerRow("person_a", "membership_a"),
    areaGoal: [],
    cmdPlanStartDocument: (values) => [
      {
        outcome: "applied",
        result: JSON.stringify({
          documentId: values[3],
          documentDigest: values[5],
          expiresAt: JSON.parse(values[4]).expiresAt,
        }),
      },
    ],
  });
  const quickResponse = await quiet(t, () =>
    handlerWith(readyOff, quick.connector).fetch(
      request("POST", startDocument, { card: { kind: "quick_tasks" } }),
      {},
      ctx,
    ),
  );
  assert.equal(quickResponse.result.status, 201);
  assert.ok(!quick.calls.some((c) => c.name === "areaAgentAdded"));
  assert.deepEqual(quick.calls[3], {
    name: "reviewContext",
    values: ["workspace.goal.create", null],
  });
  // The definer's own Owner check under lock answers owner_only the same way.
  const raced = scripted({
    enterContext: () => contextRow(),
    beginProjectCommand: [{ outcome: "new" }],
    reviewContext: ownerRow("person_a", "membership_a"),
    areaGoal: [],
    cmdPlanStartDocument: [{ outcome: "owner_only", result: null }],
  });
  const racedResponse = await quiet(t, () =>
    handlerWith(readyOff, raced.connector).fetch(
      request("POST", startDocument, { card: { kind: "quick_tasks" } }),
      {},
      ctx,
    ),
  );
  await envelope(racedResponse.result, 403, "denied", "the definer's Owner check");
  // At most one per template.
  await envelope(await run({ areaGoal: [{ id: "goal_area" }] }), 409, "conflict", "exists");
  // A Member without workspace.project.create: denied, nothing recorded.
  const member = scripted({
    enterContext: () => contextRow(startGrants().slice(0, 1)),
    beginProjectCommand: [{ outcome: "new" }],
    areaGoal: [],
    areaAgentAdded: [{ added: "1" }],
  });
  const denied = await quiet(t, () =>
    handlerWith(readyOff, member.connector).fetch(
      request("POST", startDocument, areaCard),
      {},
      ctx,
    ),
  );
  await envelope(denied.result, 403, "denied", "member without project.create");
  assert.ok(!member.calls.some((c) => c.name === "cmdPlanStartDocument"));
});

test("a Morrow card: only the asker gets a document, and only for the digest the server holds", async (t) => {
  const on = { planDrafts: { switch: "on", start_routes: "ready" } };
  const draft = {
    schemaVersion: 1,
    kind: "task",
    title: "Fix product photos",
    why: "Two products have no photo.",
    doneWhen: "Both products have photos.",
    goals: [],
    steps: [
      {
        key: "photos",
        title: "Add the missing photos",
        assignee: { kind: "person", principalId: "person_b" },
        dependsOn: [],
        repeat: null,
      },
    ],
    target: { kind: "quick_tasks" },
  };
  assert.ok(validateCurrentDefinition("PlanDraft", draft));
  const canonical = JSON.stringify(draft);
  const row = (over = {}) => ({
    message_id: "message_1",
    revision: "1",
    kind: "task",
    canonical,
    digest: "d".repeat(64),
    asker_principal_id: "person_b",
    asker_membership_id: "membership_b",
    context_taint: "none",
    ...over,
  });
  const run = async (rows) => {
    const s = scripted({
      enterContext: () => contextRow(),
      beginProjectCommand: [{ outcome: "new" }],
      planDraftLatest: rows,
    });
    const { result } = await quiet(t, () =>
      handlerWith(on, s.connector).fetch(request("POST", startDocument, draftCard), {}, ctx),
    );
    assert.ok(!s.calls.some((c) => c.name === "cmdPlanStartDocument"));
    return result;
  };
  // An unknown message, or a digest the server does not hold (an older revision): stale.
  await envelope(await run([]), 409, "conflict", "unknown card");
  await envelope(await run([row({ digest: "e".repeat(64) })]), 409, "conflict", "other digest");
  // Someone else's card: actor_ineligible (owner question 2), before any kernel or definer.
  const e = await envelope(await run([row()]), 403, "denied", "not the asker");
  assert.equal(e.safeMessage, "Only the person who asked can start this card.");
});

test("a plan change aimed at the Quick tasks project is refused before any kernel or definer", async (t) => {
  const on = { planDrafts: { switch: "on", start_routes: "ready" } };
  const change = {
    schemaVersion: 1,
    kind: "plan_change",
    title: "Measure quick tasks",
    why: "Quick tasks should have a goal.",
    doneWhen: "Twelve facts on the tote.",
    goals: [
      {
        key: "facts",
        description: "Page complete",
        measure: {
          kind: "checklist",
          checklistId: "product_facts_complete",
          productIds: ["product:1"],
          target: 12,
          dueAt: null,
          startRef: null,
        },
      },
    ],
    steps: [
      {
        key: "facts",
        title: "Add the tote's facts",
        assignee: { kind: "person", principalId: "person_a" },
        dependsOn: [],
        repeat: null,
      },
    ],
    target: { kind: "existing_project", projectId: "project_quick", goalRevision: 2 },
  };
  assert.ok(validateCurrentDefinition("PlanDraft", change));
  // Goal view (status among its fields) reads the target's goal record first.
  const viewer = [
    grant(
      "workspace.goal.create",
      ["view", "execute"],
      ["objective", "status", "storeIds", "successCriteria"],
    ),
    ...startGrants().slice(1),
  ];
  const run = async (area) => {
    const s = scripted({
      enterContext: () => contextRow(viewer),
      beginProjectCommand: [{ outcome: "new" }],
      planDraftLatest: [
        {
          message_id: "message_1",
          revision: "1",
          kind: "plan_change",
          canonical: JSON.stringify(change),
          digest: "d".repeat(64),
          asker_principal_id: "person_a",
          asker_membership_id: "membership_a",
          context_taint: "none",
        },
      ],
      projectTarget: [
        {
          id: "project_quick",
          goal_id: "goal_quick",
          revision: "2",
          due_at: null,
          area_template_id: area,
          owner_principal_id: "person_a",
          owner_membership_id: "membership_a",
        },
      ],
      projectGoal: [
        goalRow({
          id: "goal_quick",
          area_template_id: area,
          success_criteria: JSON.stringify(
            area === "quick_tasks"
              ? [{ ...criteria[0], key: "quick_tasks", measure: null }]
              : criteria,
          ),
        }),
      ],
    });
    const { result } = await quiet(t, () =>
      handlerWith(on, s.connector).fetch(request("POST", startDocument, draftCard), {}, ctx),
    );
    return { result, calls: s.calls.map((c) => c.name) };
  };
  const quick = await run("quick_tasks");
  await envelope(quick.result, 409, "conflict", "a plan change of Quick tasks");
  assert.ok(!quick.calls.includes("cmdPlanStartDocument"));
  assert.equal(quick.calls.at(-1), "rollback");
  // The same card aimed at an area goes on to the kernel (here refused for want of grants).
  const area = await run("product_pages");
  assert.notEqual(area.result.status, 409);
});

// The target's goal record as projectGoal reads it (a dated record of person_a's own).
function goalRow(over = {}) {
  return {
    id: "goal_target",
    revision: "2",
    status: "active",
    success_criteria: JSON.stringify(criteria),
    owner_principal_id: "person_a",
    owner_membership_id: "membership_a",
    created_at: "2026-10-01T00:00:00.000Z",
    due_at: null,
    area_template_id: null,
    ...over,
  };
}

test("a plan change: goal view and hidden goals as revise answers; customer-class goals are kept", async (t) => {
  const on = { planDrafts: { switch: "on", start_routes: "ready" } };
  const due = "2026-12-01T00:00:00.000Z";
  const replied = {
    description: "Replied within a day",
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: "replied_in_a_day",
    measure: {
      kind: "metric",
      metricId: "replied_within_a_day",
      target: 95,
      dueAt: null,
      startRef: null,
    },
  };
  const facts = (key) => ({
    key,
    description: "Page complete",
    measure: {
      kind: "checklist",
      checklistId: "product_facts_complete",
      productIds: ["product:1"],
      target: 12,
      dueAt: null,
      startRef: null,
    },
  });
  const change = (goals) => ({
    schemaVersion: 1,
    kind: "plan_change",
    title: "Tighten the pages",
    why: "The tote's page is thin.",
    doneWhen: "Twelve facts on the tote.",
    goals,
    steps: [
      {
        key: "facts",
        title: "Add the tote's facts",
        assignee: { kind: "person", principalId: "person_a" },
        dependsOn: [],
        repeat: null,
      },
    ],
    target: { kind: "existing_project", projectId: "project_target", goalRevision: 2 },
  });
  const S = "store_s";
  const C = "connection_c";
  const storeRef = {
    organizationId: "org_o",
    workspaceId: "ws_w",
    storeId: S,
    connectionId: C,
    kind: "store",
    id: S,
  };
  const goalGrants = [
    grant(
      "workspace.goal.create",
      ["view", "execute"],
      ["objective", "status", "storeIds", "successCriteria"],
    ),
    grant(
      "workspace.goal.revise",
      ["execute"],
      ["dueAt", "expectedRevision", "goalId", "objective", "successCriteria"],
    ),
    grant("workspace.task.create", ["execute"], ["allowedResources", "goalId", "objective"]),
  ];
  // A support.case.read view grant on the store (its fields are the grant's own: a read tag
  // names none, so the kernel is asked with the fields the grant holds).
  const customerReader = grant("support.case.read", ["view"], [], {
    scope: {
      organizationId: "org_o",
      workspaceId: "ws_w",
      storeIds: [S],
      accountIds: [],
      resources: [storeRef],
      fields: ["transcript"],
    },
  });
  let stored = null;
  const run = async ({ goals, record, grants = goalGrants }) => {
    stored = null;
    const s = scripted({
      enterContext: () => contextRow(grants),
      beginProjectCommand: [{ outcome: "new" }],
      planDraftLatest: [
        {
          message_id: "message_1",
          revision: "1",
          kind: "plan_change",
          canonical: JSON.stringify(change(goals)),
          digest: "d".repeat(64),
          asker_principal_id: "person_a",
          asker_membership_id: "membership_a",
          context_taint: "none",
        },
      ],
      projectTarget: [
        {
          id: "project_target",
          goal_id: "goal_target",
          revision: "2",
          due_at: record.due_at ?? null,
          area_template_id: record.area_template_id ?? null,
          owner_principal_id: "person_a",
          owner_membership_id: "membership_a",
        },
      ],
      projectGoal: [goalRow(record)],
      workspaceStores: [{ store_id: S }],
      storeAssociation: [{ store_id: S, connection_id: C, database_now: "x" }],
      cmdPlanStartDocument: (values) => {
        stored = values;
        return [
          {
            outcome: "applied",
            result: JSON.stringify({
              documentId: values[3],
              documentDigest: values[5],
              expiresAt: JSON.parse(values[4]).expiresAt,
            }),
          },
        ];
      },
    });
    const { result } = await quiet(t, () =>
      handlerWith(on, s.connector).fetch(request("POST", startDocument, draftCard), {}, ctx),
    );
    return { result, calls: s.calls.map((c) => c.name) };
  };
  const mixed = {
    due_at: due,
    success_criteria: JSON.stringify([criteria[0], replied]),
  };
  const emails = {
    area_template_id: "customer_emails",
    success_criteria: JSON.stringify([replied]),
  };

  // Without goal view: 404 before the target is read (the goal reads' rule).
  const blind = await run({
    goals: [facts("facts")],
    record: mixed,
    grants: goalGrants.slice(1),
  });
  await envelope(blind.result, 404, "denied", "no goal view");
  assert.ok(!blind.calls.includes("projectTarget"));
  assert.equal(blind.calls.at(-1), "rollback");
  // A record holding only a goal this viewer may not see reads as absent: 404 for any card.
  for (const goals of [[facts("facts")], []]) {
    const absent = await run({ goals, record: emails });
    await envelope(absent.result, 404, "denied", "only a customer goal");
    assert.ok(!absent.calls.includes("cmdPlanStartDocument"));
  }
  // A goal-changing plan change of a record with a goal this person may not see would
  // replace it: 403, as revise answers. A card that changes only the steps goes on.
  const hidden = await run({ goals: [facts("facts")], record: mixed });
  await envelope(hidden.result, 403, "denied", "a hidden goal");
  assert.ok(!hidden.calls.includes("cmdPlanStartDocument"));
  const steps = await run({ goals: [], record: mixed });
  assert.equal(steps.result.status, 201, JSON.stringify(await steps.result.clone().json()));
  assert.equal(JSON.parse(stored[4]).records.goal, null);

  // A person who may read customer data: the card's goals, then the customer-class goal
  // kept unchanged (Morrow's card never sees it), so the plan change never drops it.
  const reader = [...goalGrants, customerReader];
  const kept = await run({ goals: [facts("facts")], record: mixed, grants: reader });
  assert.equal(kept.result.status, 201, JSON.stringify(await kept.result.clone().json()));
  const document = (await kept.result.json()).document;
  assert.ok(validateCurrentDefinition("PlanStartDocument", document));
  assert.deepEqual(
    document.records.goal.successCriteria.map((c) => c.key),
    ["facts", "replied_in_a_day"],
  );
  assert.deepEqual(document.records.goal.successCriteria[1], replied);
  assert.equal(document.records.goal.dueAt, due);
  assert.equal(JSON.parse(stored[4]).records.goal.successCriteria[1].key, "replied_in_a_day");
  // A support.case.read grant on the workspace, not the store, is no view of the store's tag.
  const workspaceReader = grant("support.case.read", ["view"], ["transcript"]);
  const elsewhere = await run({
    goals: [facts("facts")],
    record: mixed,
    grants: [...goalGrants, workspaceReader],
  });
  await envelope(elsewhere.result, 403, "denied", "a grant off the store");

  // The progress read decides the same tags (it once asked the kernel with no fields, which
  // the kernel refuses as invalid input: 503 as soon as the workspace had a store).
  // The checklist goal's tag is the store's catalogue: a catalogue view grant shows it.
  const catalogReader = grant("catalog.products.read", ["view"], [], {
    scope: { ...customerReader.scope, fields: ["descriptionHtml", "title"] },
  });
  for (const [grants, keys] of [
    [goalGrants, []],
    [[...goalGrants, catalogReader], ["pages_complete"]],
    [
      [...reader, catalogReader],
      ["pages_complete", "replied_in_a_day"],
    ],
  ]) {
    const s = scripted({
      enterContext: () => contextRow(grants),
      projectGoal: [goalRow(mixed)],
      workspaceStores: [{ store_id: S }],
      storeAssociation: [{ store_id: S, connection_id: C, database_now: "x" }],
      goalValues: [],
      goalFinish: [],
      goalWaitingOn: [{ waiting: "0" }],
    });
    const { result } = await quiet(t, () =>
      handlerWith({ goals: true }, s.connector).fetch(
        request("GET", base + "/goals/goal_target/progress"),
        {},
        ctx,
      ),
    );
    const body = await result.json();
    assert.equal(result.status, 200, JSON.stringify(body));
    assert.ok(validateCurrentDefinition("GoalProgress", body.progress));
    assert.deepEqual(
      body.progress.goals.map((g) => g.key),
      keys,
    );
  }

  // A kept key the card also names, or a 4th measured goal: 409, nothing issued.
  for (const goals of [
    [{ ...facts("replied_in_a_day") }],
    [facts("one"), facts("two"), facts("three")],
  ]) {
    const refused = await run({ goals, record: mixed, grants: reader });
    await envelope(refused.result, 409, "conflict", "kept goals do not fit");
    assert.ok(!refused.calls.includes("cmdPlanStartDocument"));
  }
});
