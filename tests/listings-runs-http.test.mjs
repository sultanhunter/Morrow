// M3 PR-2: the runs routes of the workspace API in Node (packages/work/src/runs/http.ts).
// While the model-provider switch is off, run admission answers 503 runs_unavailable before
// any database access (no run, lease or reservation exists without the gateway). Every guard
// case and every closed-body refusal is decided before any SQL connection opens: a body that
// names a tenant, an installation, a provider model id, a price, a credit amount or a
// catalogue version is refused. The unbound default artifact answers 401 with no I/O, and
// the api Worker sends exactly the runs paths here, ahead of the work API.
// lab:listings-runs drives the same handler against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import defaultWorker, { apiDispatch } from "../apps/api/src/worker.ts";
import {
  createRunsApiHandler,
  runRoutes,
  runsPathPattern,
} from "../packages/work/src/runs/http.ts";
import { parseAdmitBody } from "../packages/work/src/runs/commands.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

const ctx = { waitUntil() {} };
const key = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b";
const admitBody = (over = {}) =>
  JSON.stringify({
    storeId: "store_a",
    products: ["product:1", "product:2"],
    fields: ["title", "descriptionHtml"],
    selection: { model: "claude_sonnet_5_5", effort: "low" },
    ...over,
  });
const writeHeaders = (overrides = {}) => ({
  Cookie: "__Host-morrow_session=" + workGuardSecret,
  Origin: workGuardOrigin,
  "Content-Type": "application/json",
  "X-Morrow-Request": "1",
  "Idempotency-Key": key,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  ...overrides,
});
const readHeaders = (overrides = {}) => ({
  Cookie: "__Host-morrow_session=" + workGuardSecret,
  "Sec-Fetch-Site": "same-origin",
  ...overrides,
});
function request(method, path, { headers, body } = {}) {
  const h = new Headers();
  const all = headers ?? (method === "GET" ? readHeaders() : writeHeaders());
  for (const [name, value] of Object.entries(all)) if (value !== null) h.set(name, value);
  const init = { method, headers: h };
  if (method !== "GET" && body !== undefined) init.body = body;
  return new Request(workGuardOrigin + path, init);
}
const admit = "/workspace/ws_w/work/tasks/task_root/runs";
const runPath = "/workspace/ws_w/work/runs/00000000-0000-4000-8000-000000000001";
const reconcile = "/workspace/ws_w/work/runs-reconcile";
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
const handlerWith = (admission, connector) =>
  createRunsApiHandler({
    origin: workGuardOrigin,
    connector,
    now: Date.now,
    environment: "development",
    admission,
  });
const quiet = async (t, body) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const result = await body();
  return { result, lines };
};
async function envelope(response, status, name) {
  assert.equal(response.status, status, name);
  const body = await response.json();
  assert.ok(validateDefinition("core", "ErrorEnvelope", body), name);
  assert.equal(response.headers.has("set-cookie"), false, name);
  assert.equal(response.headers.has("access-control-allow-origin"), false, name);
  assert.equal(response.headers.get("cache-control"), "no-store", name);
  return body;
}

test("the routes and the api dispatch: runs paths go to the runs handler, ahead of work", () => {
  assert.deepEqual(
    runRoutes.map((r) => r.method + " " + r.pattern),
    [
      "POST /tasks/:taskId/runs",
      "GET /tasks/:taskId/runs",
      "GET /runs/:runId",
      "POST /runs-reconcile",
    ],
  );
  for (const path of [admit, runPath, reconcile]) {
    assert.ok(runsPathPattern.test(path), path);
    assert.equal(apiDispatch(path), "runs", path);
  }
  for (const [path, row] of [
    ["/workspace/ws_w/work/tasks/task_root", "work"],
    ["/workspace/ws_w/work/tasks/task_root/runs/extra", "work"],
    ["/workspace/ws_w/work/runs", "work"],
    ["/workspace/ws_w/work/runs/a/b", "work"],
    ["/workspace/ws_w/stores/store_a/agents/listings", "agents"],
  ])
    assert.equal(apiDispatch(path), row, path);
});

test("the unbound artifact answers 401 on every runs route with no I/O", async (t) => {
  await quiet(t, async () => {
    for (const [method, path, body] of [
      ["POST", admit, admitBody()],
      ["GET", admit],
      ["GET", runPath],
      ["POST", reconcile, "{}"],
    ]) {
      const response = await defaultWorker.fetch(request(method, path, { body }), {}, ctx);
      await envelope(response, 401, method + " " + path);
    }
  });
  assert.throws(
    () =>
      createRunsApiHandler({
        origin: workGuardOrigin,
        connector: countingConnector().connector,
        now: Date.now,
        environment: "test",
        admission: true,
      }),
    /RUNS_API_CONFIGURATION_INVALID/,
  );
  assert.throws(
    () =>
      createRunsApiHandler({
        origin: workGuardOrigin,
        connector: countingConnector().connector,
        now: Date.now,
        environment: "staging",
        admission: "yes",
      }),
    /RUNS_API_CONFIGURATION_INVALID/,
  );
});

test("switch off: admission is 503 runs_unavailable before any database access", async (t) => {
  const { counter, connector } = countingConnector();
  const handler = handlerWith(false, connector);
  const { lines } = await quiet(t, async () => {
    const response = await handler.fetch(request("POST", admit, { body: admitBody() }), {}, ctx);
    const body = await envelope(response, 503, "admit");
    assert.deepEqual([body.code, body.retryClass], ["unavailable", "recheck_before_retry"]);
    assert.equal(body.safeMessage, "AI drafting is not available yet.");
  });
  assert.equal(counter.opens, 0);
  assert.ok(lines.some((l) => JSON.parse(l).outcome === "runs_unavailable"));
  // The reads and the stale-run close still reach the database (credits come back).
  await quiet(t, async () => {
    for (const [method, path, body] of [
      ["GET", admit],
      ["GET", runPath],
      ["POST", reconcile, "{}"],
    ])
      await handler.fetch(request(method, path, { body }), {}, ctx);
  });
  assert.equal(counter.opens, 3);
});

test("switch on: every guard and closed-body case is refused before any SQL connection opens", async (t) => {
  const { counter, connector } = countingConnector();
  const handler = handlerWith(true, connector);
  const w = (headers, body = admitBody()) => ({ headers: writeHeaders(headers), body });
  const cases = [
    ["missing_origin", "POST", admit, w({ Origin: null }), 403],
    ["foreign_origin", "POST", admit, w({ Origin: "https://evil.example.test" }), 403],
    ["cross_site", "POST", admit, w({ "Sec-Fetch-Site": "cross-site" }), 403],
    ["no_x_morrow_request", "POST", admit, w({ "X-Morrow-Request": null }), 403],
    ["text_plain", "POST", admit, w({ "Content-Type": "text/plain" }), 403],
    ["authorization", "POST", admit, w({ Authorization: "Bearer x" }), 401],
    ["no_cookie", "POST", admit, w({ Cookie: null }), 401],
    ["no_key", "POST", admit, w({ "Idempotency-Key": null }), 400],
    ["not_json", "POST", admit, w({}, "{"), 400],
    // Closed bodies: never a tenant, installation, actor, provider, price or credit value.
    ...[
      { workspaceId: "ws_w" },
      { organizationId: "org_o" },
      { installationId: "installation_a" },
      { requesterPrincipalId: "p" },
      { catalogueVersion: 1 },
      { maximumCredits: "10" },
      { model: "claude-sonnet-5-5" },
      { selection: { model: "claude-sonnet-5-5", effort: "low" } },
      { selection: { model: "claude_sonnet_5_5", effort: "low", provider: "anthropic" } },
      { selection: { model: "claude_sonnet_5_5" } },
      { products: [] },
      { products: ["product:1", "product:1"] },
      { products: ["gid://shopify/Product/1"] },
      { products: Array.from({ length: 26 }, (_, i) => "product:" + (i + 1)) },
      { fields: ["seo.title"] },
      { fields: ["price"] },
      { fields: [] },
      { storeId: "" },
    ].map((over) => ["body:" + JSON.stringify(over), "POST", admit, w({}, admitBody(over)), 400]),
    ["reconcile_body", "POST", reconcile, w({}, '{"all":true}'), 400],
    ["get_reconcile", "GET", reconcile, {}, 405],
    ["put_admit", "PUT", admit, w({}), 405],
    ["post_run", "POST", runPath, w({}, "{}"), 405],
    ["read_key", "GET", runPath, { headers: readHeaders({ "Idempotency-Key": key }) }, 400],
    ["read_query", "GET", runPath + "?x=1", {}, 400],
  ];
  await quiet(t, async () => {
    for (const [name, method, path, options, status] of cases) {
      const response = await handler.fetch(request(method, path, options), {}, ctx);
      await envelope(response, status, name);
    }
  });
  assert.equal(counter.opens, 0);
  // A well-formed admission opens exactly one connection (here it fails: 503, never success).
  await quiet(t, async () => {
    const response = await handler.fetch(request("POST", admit, { body: admitBody() }), {}, ctx);
    const body = await envelope(response, 503, "admit");
    assert.equal(body.code, "unavailable");
  });
  assert.equal(counter.opens, 1);
});

test("the admission body: sorted fields, null selection is the workspace default", () => {
  assert.deepEqual(parseAdmitBody(JSON.parse(admitBody())), {
    storeId: "store_a",
    products: ["product:1", "product:2"],
    fields: ["descriptionHtml", "title"],
    selection: { model: "claude_sonnet_5_5", effort: "low" },
  });
  assert.equal(parseAdmitBody(JSON.parse(admitBody({ selection: null }))).selection, null);
  assert.equal(
    parseAdmitBody(
      JSON.parse(admitBody({ fields: ["seo.title", "seo.description"] })),
    ).fields.join(),
    "seo.description,seo.title",
  );
  assert.equal(parseAdmitBody(Object.create({ storeId: "x" })), null);
  assert.equal(parseAdmitBody(null), null);
});
