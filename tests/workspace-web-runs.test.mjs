// M3 PR-2: the workspace SPA's side of the runs routes on a fake fetch. Closed requests
// (ids, product ids, listing fields and opaque catalogue keys; never a provider string,
// price or credit amount), closed decoders that accept exactly what the server sends (the
// server's own read bodies, from runRunRead over a scripted transaction) and refuse
// anything wider (a provider model string, content fields), the outcome mapping, the Ask
// screen's product parsing, the fixture adapter's runs and the re-entry marker. No browser
// and no network; lab:listings-runs proves the server side over PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort, requests } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeReconciled,
  decodeRun,
  decodeRunAdmitted,
  decodeRunDetail,
  decodeRunsOfTask,
} from "../apps/workspace-web/src/http/runs-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { fixtureStore, fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { createPending } from "../apps/workspace-web/src/pending.ts";
import { portMethods } from "../packages/workspace-ui/src/port.ts";
import { copy } from "../packages/workspace-ui/src/copy.ts";
import { parseProducts } from "../packages/workspace-ui/src/screens/ask.tsx";
import { runRunRead } from "../packages/work/src/runs/commands.ts";
import { json, MemoryStorage, recordingTransport } from "./fixtures/workspace-web.mjs";

const ws = "ws-1";
const task = "task-1";
const key = () => randomUUID();
const run1 = "00000000-0000-4000-8000-000000000001";
const admitBody = (over = {}) => ({
  storeId: "store-1",
  products: ["product:1", "product:2"],
  fields: ["title", "descriptionHtml"],
  selection: { model: "claude_sonnet_5_5", effort: "low" },
  ...over,
});

test("the port: four new methods, all composed over HTTP", () => {
  for (const method of ["runs.admit", "runs.listOfTask", "runs.get", "runs.reconcile"]) {
    assert.ok(portMethods.includes(method), method);
    assert.equal(composed[method], true, method);
  }
});

test("requests: fixed paths under /workspace/:ws/work, closed bodies, refused before sending", () => {
  const k = key();
  assert.deepEqual(requests.admitRun(ws, task, { key: k, body: admitBody() }), {
    method: "POST",
    path: "/workspace/ws-1/work/tasks/task-1/runs",
    body: JSON.stringify({
      storeId: "store-1",
      products: ["product:1", "product:2"],
      fields: ["descriptionHtml", "title"],
      selection: { model: "claude_sonnet_5_5", effort: "low" },
    }),
    key: k,
  });
  assert.equal(
    JSON.parse(requests.admitRun(ws, task, { key: k, body: admitBody({ selection: null }) }).body)
      .selection,
    null,
  );
  assert.deepEqual(requests.runsOfTask(ws, task), {
    method: "GET",
    path: "/workspace/ws-1/work/tasks/task-1/runs",
  });
  assert.deepEqual(requests.run(ws, run1), {
    method: "GET",
    path: "/workspace/ws-1/work/runs/" + run1,
  });
  assert.deepEqual(requests.reconcileRuns(ws, { key: k, body: {} }), {
    method: "POST",
    path: "/workspace/ws-1/work/runs-reconcile",
    body: "{}",
    key: k,
  });
  for (const refused of [
    requests.admitRun("bad id", task, { key: k, body: admitBody() }),
    requests.admitRun(ws, task, { key: "NOT-A-KEY", body: admitBody() }),
    requests.admitRun(ws, task, { key: k, body: admitBody({ products: [] }) }),
    requests.admitRun(ws, task, { key: k, body: admitBody({ products: ["123"] }) }),
    requests.admitRun(ws, task, {
      key: k,
      body: admitBody({ products: ["product:1", "product:1"] }),
    }),
    requests.admitRun(ws, task, {
      key: k,
      body: admitBody({ products: Array.from({ length: 26 }, (_, i) => "product:" + (i + 1)) }),
    }),
    requests.admitRun(ws, task, { key: k, body: admitBody({ fields: ["seo.title"] }) }),
    requests.admitRun(ws, task, { key: k, body: admitBody({ fields: ["price"] }) }),
    requests.admitRun(ws, task, {
      key: k,
      body: admitBody({ selection: { model: "claude-sonnet-5-5", effort: "low" } }),
    }),
    requests.admitRun(ws, task, {
      key: k,
      body: admitBody({ selection: { model: "claude_sonnet_5_5", effort: "low", price: 1 } }),
    }),
    requests.run(ws, "not-a-run"),
    requests.runsOfTask(ws, "task/../x"),
    requests.reconcileRuns(ws, { key: k, body: { all: true } }),
  ])
    assert.equal(refused, null);
});

// The server's own bodies, from runRunRead over a scripted transaction.
const contextRow = {
  principal_id: "person_owner",
  organization_id: "org_o",
  workspace_id: "ws_w",
  membership_id: "membership_owner",
  policy_revision: "1",
  grants: "[]",
  grant_count: "0",
  grants_digest: "e".repeat(64),
  database_now_us: String(Date.parse("2026-10-22T12:00:00.000Z") * 1000),
};
const runRow = {
  id: run1,
  revision: "4",
  task_id: "task_root",
  child_task_id: "00000000-0000-4000-8000-0000000000c1",
  store_id: "store_a",
  installation_id: "installation_a",
  status: "succeeded",
  ended_reason: null,
  catalogue_version: "1",
  model_key: "claude_sonnet_5_5",
  effort_key: "low",
  credits_per_product: "1",
  product_count: "2",
  fields: '["descriptionHtml", "title"]',
  products_drafted: "1",
  products_failed: "1",
  requester_principal_id: "person_owner",
  created_at: "2026-10-22T11:00:00.000Z",
  started_at: "2026-10-22T11:00:01.000Z",
  ended_at: "2026-10-22T11:01:00.000Z",
  updated_at: "2026-10-22T11:01:00.000Z",
};
function serverRead(read, params, replies) {
  const tx = {
    async run(name) {
      return replies[name] ?? [];
    },
    markSubmitted() {},
    rollbackOnly() {},
  };
  return runRunRead(
    tx,
    {
      route: { method: "GET", pattern: "", query: [] },
      workspaceId: "ws_w",
      params,
      query: new Map(),
      sessionDigest: "d".repeat(64),
      commandId: null,
      body: null,
    },
    read,
  );
}

test("decoders accept the server's own bodies exactly and refuse anything wider", async () => {
  const detail = await serverRead(
    "run.get",
    { runId: run1 },
    {
      enterContext: [contextRow],
      runById: [
        {
          ...runRow,
          credits_reserved: "2",
          credits_settled: "1",
          credit_status: "settled",
          attempts: "3",
          input_tokens: "2700",
          output_tokens: "900",
        },
      ],
      runProductsOfRun: [
        {
          product_index: "0",
          product_id: "product:1",
          status: "drafted",
          attempts: "1",
          failure_code: null,
          proposal_id: "00000000-0000-4000-8000-0000000000p1".replace("p", "a"),
          flags: '{"newUrls": 1, "newEmails": 0, "newPhones": 0, "tagsAdded": 2, "tagsRemoved": 0}',
        },
        {
          product_index: "1",
          product_id: "product:2",
          status: "failed",
          attempts: "2",
          failure_code: "invalid_output",
          proposal_id: null,
          flags: null,
        },
      ],
      runInterrupted: [{ interrupted: "false" }],
    },
  );
  const body = JSON.parse(JSON.stringify({ schemaVersion: 1, ...detail.body }));
  const decoded = decodeRunDetail(body, run1);
  assert.ok(decoded);
  assert.equal(decoded.run.status, "succeeded");
  assert.deepEqual(decoded.run.fields, ["descriptionHtml", "title"]);
  assert.deepEqual(decoded.credits, { reserved: 2, settled: 1, status: "settled" });
  assert.deepEqual(decoded.usage, { attempts: 3, inputTokens: 2700, outputTokens: 900 });
  assert.equal(decoded.products[0].flags.tagsAdded, 2);
  assert.equal(decoded.products[1].failureCode, "invalid_output");
  assert.equal(copy.runs.flags(decoded.products[0].flags), "1 new link · 2 tags added");
  assert.ok(copy.runs.failureCodes[decoded.products[1].failureCode]);
  const list = await serverRead(
    "run.list_of_task",
    { taskId: "task_root" },
    {
      enterContext: [contextRow],
      runsOfTask: [runRow],
    },
  );
  const listBody = JSON.parse(JSON.stringify({ schemaVersion: 1, ...list.body }));
  assert.equal(decodeRunsOfTask(listBody, "task_root")?.length, 1);
  // Another task's run, a provider model string, a content field or an extra key: refused.
  assert.equal(decodeRunsOfTask(listBody, "task_other"), null);
  const providerString = structuredClone(body);
  providerString.run.selection.model = "claude-sonnet-5-5";
  const content = structuredClone(body);
  content.products[0].title = "Linen shirt";
  const extra = structuredClone(body);
  extra.run.providerModelId = "claude-sonnet-5-5";
  const wrongCount = structuredClone(body);
  wrongCount.products.pop();
  for (const bad of [providerString, content, extra, wrongCount, { ...body, schemaVersion: 2 }])
    assert.equal(decodeRunDetail(bad, run1), null);
  assert.equal(decodeRunDetail(body, "00000000-0000-4000-8000-000000000009"), null);
  assert.equal(decodeRun({ ...body.run, status: "Running!" }), null);
  // Every status and reason the server writes has a label.
  for (const s of ["queued", "running", "succeeded", "failed", "cancelled"])
    assert.ok(copy.status.run[s], s);
  for (const s of ["pending", "in_progress", "drafted", "failed", "skipped"])
    assert.ok(copy.status.runProduct[s], s);
  for (const r of [
    "breaker",
    "unrecovered_cost_cap",
    "spend_limit",
    "provider_error",
    "cost_overflow",
    "reservation_exhausted",
    "time_budget",
    "delegation_denied",
    "entitlement",
    "broker_held",
    "read_unavailable",
    "nothing_drafted",
    "stopped",
    "lease_ended",
  ])
    assert.ok(copy.runs.endedReasons[r], r);
  // The admission and reconcile replies.
  const admitted = {
    schemaVersion: 1,
    runId: run1,
    status: "queued",
    childTaskId: "00000000-0000-4000-8000-0000000000c1",
    productCount: 2,
    creditsReserved: 2,
    catalogueVersion: 1,
    selection: { model: "claude_sonnet_5_5", effort: "low" },
  };
  assert.deepEqual(decodeRunAdmitted(admitted), {
    runId: run1,
    childTaskId: admitted.childTaskId,
    productCount: 2,
    creditsReserved: 2,
    selection: { model: "claude_sonnet_5_5", effort: "low" },
  });
  assert.ok(decodeRunAdmitted({ ...admitted, replayed: true }));
  for (const bad of [
    { ...admitted, creditsReserved: "2" },
    { ...admitted, selection: { model: "claude-sonnet-5-5", effort: "low" } },
    { ...admitted, defaulted: true },
  ])
    assert.equal(decodeRunAdmitted(bad), null);
  assert.deepEqual(decodeReconciled({ schemaVersion: 1, closed: 2 }), { closed: 2 });
  assert.equal(decodeReconciled({ schemaVersion: 1, closed: -1 }), null);
});

test("the HTTP port: admission, reads and the outcome mapping", async () => {
  const replies = [];
  const recorded = recordingTransport(() => replies.shift());
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion,
    navigationSignal: () => undefined,
  });
  const envelope = (status, code, retryClass, safeMessage) =>
    json(status, {
      schemaVersion: 1,
      code,
      retryClass,
      safeMessage,
      correlationId: "c-1",
      operationId: null,
      retryAfterSeconds: null,
      inputRequestIds: [],
    });
  replies.push(
    json(201, {
      schemaVersion: 1,
      runId: run1,
      status: "queued",
      childTaskId: "00000000-0000-4000-8000-0000000000c1",
      productCount: 2,
      creditsReserved: 2,
      catalogueVersion: 1,
      selection: { model: "claude_sonnet_5_5", effort: "low" },
    }),
  );
  const k = key();
  const admitted = await port.runs.admit(ws, task, { key: k, body: admitBody() });
  assert.equal(admitted.kind, "ok");
  const sent = recorded.calls[0];
  assert.equal(sent.path, "/workspace/ws-1/work/tasks/task-1/runs");
  assert.equal(new Headers(sent.init.headers).get("Idempotency-Key"), k);
  // The refusals map to their outcomes, and the safe message is what the screen shows.
  replies.push(envelope(409, "budget_exhausted", "never", "Not enough credits for this run."));
  const poor = await port.runs.admit(ws, task, { key: key(), body: admitBody() });
  assert.equal(poor.kind, "conflict");
  assert.equal(poor.message, "Not enough credits for this run.");
  replies.push(
    envelope(403, "denied", "never", "That model or effort is above your workspace's limit."),
  );
  assert.equal((await port.runs.admit(ws, task, { key: key(), body: admitBody() })).kind, "denied");
  replies.push(
    envelope(503, "unavailable", "recheck_before_retry", "AI drafting is not available yet."),
  );
  const off = await port.runs.admit(ws, task, { key: key(), body: admitBody() });
  assert.ok(["unavailable", "uncertain"].includes(off.kind), off.kind);
  // A refused request sends nothing and is terminal.
  const before = recorded.calls.length;
  assert.deepEqual(
    await port.runs.admit(ws, task, { key: key(), body: admitBody({ products: ["x"] }) }),
    { kind: "invalid", field: null },
  );
  assert.equal(recorded.calls.length, before);
  // An undecodable 2xx is uncertain for a command.
  replies.push(json(201, { schemaVersion: 1, runId: run1 }));
  assert.equal(
    (await port.runs.admit(ws, task, { key: key(), body: admitBody() })).kind,
    "uncertain",
  );
});

test("Ask: product numbers or product ids, one per line, no repeats", () => {
  assert.deepEqual(parseProducts("123\nproduct:456\n\n  789  "), [
    "product:123",
    "product:456",
    "product:789",
  ]);
  assert.deepEqual(parseProducts(""), []);
  for (const bad of ["abc", "0", "product:", "123\n123", "product:1\n1", "gid://shopify/Product/1"])
    assert.equal(parseProducts(bad), null, bad);
});

test("the fixture adapter: a run on an enabled store, refusals, and the task's runs", async () => {
  const port = createFixtureAdapter("ready");
  const W = fixtureWorkspace.id;
  const S = fixtureStore.storeId;
  const goal = await port.work.createGoal(W, {
    key: key(),
    body: { objective: "Better listings", criteria: ["Done"] },
  });
  const t = await port.work.createTask(W, {
    key: key(),
    body: { goalId: goal.value.goalId, objective: "Shorter titles" },
  });
  const taskId = t.value.taskId;
  const body = {
    storeId: S,
    products: ["product:1", "product:13"],
    fields: ["title"],
    selection: null,
  };
  // Not enabled yet: refused.
  assert.equal((await port.runs.admit(W, taskId, { key: key(), body })).kind, "conflict");
  const doc = await port.agents.listingsDocument(W, S, { key: key(), body: {} });
  await port.agents.listingsEnable(W, S, {
    key: key(),
    body: { documentDigest: doc.value.documentDigest, nonce: doc.value.nonce },
  });
  const c = { key: key(), body };
  const admitted = await port.runs.admit(W, taskId, c);
  assert.equal(admitted.kind, "ok");
  assert.equal(admitted.value.creditsReserved, 2);
  assert.equal((await port.runs.admit(W, taskId, c)).replayed, true);
  const runs = await port.runs.listOfTask(W, taskId);
  assert.equal(runs.value.length, 1);
  const detail = await port.runs.get(W, runs.value[0].runId);
  assert.deepEqual(
    detail.value.products.map((p) => p.status),
    ["drafted", "failed"],
  );
  assert.equal(detail.value.credits.settled, 1);
  assert.deepEqual((await port.runs.reconcile(W, { key: key(), body: {} })).value, { closed: 0 });
  // Above the product limit of Opus high (nine products).
  const many = Array.from({ length: 10 }, (_, i) => "product:" + (i + 100));
  assert.equal(
    (
      await port.runs.admit(W, taskId, {
        key: key(),
        body: { ...body, products: many, selection: { model: "claude_opus_5_5", effort: "high" } },
      })
    ).kind,
    "conflict",
  );
});

test("re-entry markers know the run command", () => {
  const pending = createPending(new MemoryStorage());
  const marker = pending.addMarker(ws, "run");
  assert.equal(marker.kind, "run");
  assert.ok(copy.reentry.kinds.run);
});
