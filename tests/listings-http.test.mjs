// M3 PR-1: the agents routes of the workspace API in Node. Every guard case (exact
// Origin, Fetch Metadata, X-Morrow-Request, a JSON content type, one session cookie and
// an Idempotency-Key; PUT follows the POST rules) and every closed-body refusal is decided
// before any SQL connection opens; responses carry the fixed error envelope, never
// Set-Cookie or CORS headers; the unbound default artifact answers 401 with no I/O; and the
// api Worker sends exactly the agents paths here. lab:listings-authority drives the same
// handler against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import defaultWorker, { createWorkspaceApiWorker } from "../apps/api/src/worker.ts";
import {
  agentRoutes,
  agentsPathPattern,
  createAgentsApiHandler,
} from "../packages/work/src/agents/http.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

const ctx = { waitUntil() {} };
const key = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b";
const stopBody = JSON.stringify({ control: { reason: "Pause it", sourceProposalRef: null } });
const reviseBody = JSON.stringify({
  model: "claude_sonnet_5_5",
  effort: "low",
  maxCreditsPerProduct: 1,
  expectedRevision: null,
});
const enableBody = JSON.stringify({ documentDigest: "a".repeat(64), nonce: "b".repeat(64) });
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
function request(method, path, { headers, body, bytes } = {}) {
  const h = new Headers();
  const all = headers ?? (method === "GET" ? readHeaders() : writeHeaders());
  for (const [name, value] of Object.entries(all)) if (value !== null) h.set(name, value);
  const init = { method, headers: h };
  if (method !== "GET" && method !== "DELETE") {
    if (bytes) init.body = new Uint8Array(bytes);
    else if (body !== undefined) init.body = body;
  }
  return new Request(workGuardOrigin + path, init);
}
const stop = "/workspace/ws_w/stores/store_a/agents/listings/stop";
const enable = "/workspace/ws_w/stores/store_a/agents/listings";
const document_ = "/workspace/ws_w/stores/store_a/agents/listings/document";
const models = "/workspace/ws_w/models";
const revise = "/workspace/ws_w/settings/model-default";
// [name, method, path, options, status, allow?]
const writes = [
  ["stop", "POST", stop, stopBody],
  ["revise", "PUT", revise, reviseBody],
  ["enable", "POST", enable, enableBody],
  ["document", "POST", document_, "{}"],
];
const cases = [];
for (const [name, method, path, body] of writes) {
  const w = (headers) => ({ headers: writeHeaders(headers), body });
  cases.push(
    [name + ":missing_origin", method, path, w({ Origin: null }), 403],
    [name + ":foreign_origin", method, path, w({ Origin: "https://evil.example.test" }), 403],
    [name + ":foreign_host", method, path, w({ Host: "evil.example.test" }), 403],
    [name + ":cross_site", method, path, w({ "Sec-Fetch-Site": "cross-site" }), 403],
    [name + ":same_site", method, path, w({ "Sec-Fetch-Site": "same-site" }), 403],
    [name + ":navigate", method, path, w({ "Sec-Fetch-Mode": "navigate" }), 403],
    [name + ":document_dest", method, path, w({ "Sec-Fetch-Dest": "document" }), 403],
    [name + ":no_x_morrow_request", method, path, w({ "X-Morrow-Request": null }), 403],
    [name + ":text_plain", method, path, w({ "Content-Type": "text/plain" }), 403],
    [name + ":authorization", method, path, w({ Authorization: "Bearer x" }), 401],
    [name + ":no_cookie", method, path, w({ Cookie: null }), 401],
    [
      name + ":two_cookies",
      method,
      path,
      w({
        Cookie: `__Host-morrow_session=${workGuardSecret}; __Host-morrow_session=${workGuardSecret}`,
      }),
      401,
    ],
    [name + ":no_key", method, path, w({ "Idempotency-Key": null }), 400],
    [name + ":upper_key", method, path, w({ "Idempotency-Key": key.toUpperCase() }), 400],
    [
      name + ":huge_body",
      method,
      path,
      { headers: writeHeaders(), body: JSON.stringify({ x: "y".repeat(65537) }) },
      400,
    ],
    [
      name + ":bad_utf8",
      method,
      path,
      { headers: writeHeaders(), bytes: [0x7b, 0xff, 0xfe, 0x7d] },
      400,
    ],
    [name + ":not_json", method, path, { headers: writeHeaders(), body: "{" }, 400],
    [name + ":nul", method, path, { headers: writeHeaders(), body: '{"a":"\\u0000"}' }, 400],
    // Closed bodies: tenant, store, installation or actor values are never body fields.
    [
      name + ":tenant_key",
      method,
      path,
      {
        headers: writeHeaders(),
        body: JSON.stringify({ ...JSON.parse(body), workspaceId: "ws_w" }),
      },
      400,
    ],
    [
      name + ":installation_key",
      method,
      path,
      {
        headers: writeHeaders(),
        body: JSON.stringify({ ...JSON.parse(body), installationId: "installation_a" }),
      },
      400,
    ],
  );
}
cases.push(
  // Bodies that pass the guard but not their parser.
  [
    "stop:blank_reason",
    "POST",
    stop,
    {
      headers: writeHeaders(),
      body: JSON.stringify({ control: { reason: " ", sourceProposalRef: null } }),
    },
    400,
  ],
  [
    "stop:agent_proposal",
    "POST",
    stop,
    {
      headers: writeHeaders(),
      body: JSON.stringify({
        control: {
          reason: "x",
          sourceProposalRef: {
            organizationId: "org_o",
            workspaceId: "ws_w",
            storeId: null,
            kind: "proposal",
            id: "p",
            revision: 1,
            digest: "a".repeat(64),
          },
        },
      }),
    },
    400,
  ],
  [
    "revise:provider_string",
    "PUT",
    revise,
    { headers: writeHeaders(), body: reviseBody.replace("claude_sonnet_5_5", "claude-sonnet-5-5") },
    400,
  ],
  [
    "revise:ceiling_100",
    "PUT",
    revise,
    {
      headers: writeHeaders(),
      body: reviseBody.replace('"maxCreditsPerProduct":1', '"maxCreditsPerProduct":100'),
    },
    400,
  ],
  [
    "enable:short_nonce",
    "POST",
    enable,
    {
      headers: writeHeaders(),
      body: JSON.stringify({ documentDigest: "a".repeat(64), nonce: "b" }),
    },
    400,
  ],
  // Reads: no body, no content type, no key, no query.
  [
    "models:content_type",
    "GET",
    models,
    { headers: readHeaders({ "Content-Type": "application/json" }) },
    400,
  ],
  ["models:key", "GET", models, { headers: readHeaders({ "Idempotency-Key": key }) }, 400],
  ["models:query", "GET", models + "?model=x", {}, 400],
  [
    "models:foreign_origin",
    "GET",
    models,
    { headers: readHeaders({ Origin: "https://evil.example.test" }) },
    403,
  ],
  ["status:no_cookie", "GET", enable, { headers: readHeaders({ Cookie: null }) }, 401],
  // Paths and methods.
  ["bad_store_id", "GET", "/workspace/ws_w/stores/%20/agents/listings", {}, 400],
  ["bad_workspace_id", "GET", "/workspace/%20/models", {}, 400],
  ["unknown_agent", "GET", "/workspace/ws_w/stores/store_a/agents/ads", {}, 404],
  ["unknown_tail", "GET", "/workspace/ws_w/stores/store_a/agents/listings/runs", {}, 404],
  ["delete_listings", "DELETE", enable, { headers: readHeaders() }, 405, "GET, POST"],
  ["post_models", "POST", models, { headers: writeHeaders(), body: "{}" }, 405, "GET"],
  ["post_revise", "POST", revise, { headers: writeHeaders(), body: reviseBody }, 405, "PUT"],
  ["get_stop", "GET", stop, {}, 405, "POST"],
  ["put_document", "PUT", document_, { headers: writeHeaders(), body: "{}" }, 405, "POST"],
);
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
const quiet = async (t, body) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const result = await body();
  return { result, lines };
};
async function expectEnvelope(response, status, name) {
  assert.equal(response.status, status, name);
  const body = await response.json();
  assert.ok(validateDefinition("core", "ErrorEnvelope", body), name);
  assert.equal(response.headers.has("set-cookie"), false, name);
  assert.equal(response.headers.has("access-control-allow-origin"), false, name);
  assert.equal(response.headers.get("cache-control"), "no-store", name);
  return body;
}

test("every guard and body case is refused before any SQL connection opens", async (t) => {
  const { counter, connector } = countingConnector();
  const handler = createAgentsApiHandler({ origin: workGuardOrigin, connector, now: Date.now });
  const { lines } = await quiet(t, async () => {
    for (const [name, method, path, options, status, allow] of cases) {
      const response = await handler.fetch(request(method, path, options), undefined, ctx);
      await expectEnvelope(response, status, name);
      if (allow) assert.equal(response.headers.get("allow"), allow, name);
    }
  });
  assert.equal(counter.opens, 0);
  assert.equal(lines.length, cases.length);
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record), ["event", "route", "outcome", "correlationId"]);
    assert.equal(record.event, "morrow_agents");
  }
});

test("a request that passes the guard and its body reaches the connector exactly once", async (t) => {
  for (const [method, path, body, code] of [
    ["POST", stop, stopBody, "unavailable"],
    ["PUT", revise, reviseBody, "unavailable"],
    ["POST", enable, enableBody, "unavailable"],
    ["POST", document_, "{}", "unavailable"],
    ["GET", models, undefined, "unavailable_read"],
    ["GET", enable, undefined, "unavailable_read"],
  ]) {
    const { counter, connector } = countingConnector();
    const handler = createAgentsApiHandler({ origin: workGuardOrigin, connector, now: Date.now });
    const { result } = await quiet(t, () =>
      handler.fetch(
        request(method, path, {
          body: body,
          headers: method === "GET" ? readHeaders() : writeHeaders(),
        }),
        undefined,
        ctx,
      ),
    );
    const envelope = await expectEnvelope(result, 503, method + " " + path);
    assert.equal(envelope.code, code === "unavailable_read" ? "unavailable" : code);
    assert.equal(counter.opens, 1, method + " " + path);
  }
});

test("the route table: six routes in three guard families, and one dispatch pattern", () => {
  // M5 PR-1's guard takes one fixed prefix per family; each pattern is relative to it.
  assert.deepEqual(
    agentRoutes.map((r) => [r.method, r.prefix, r.pattern, r.path, r.op]),
    [
      [
        "GET",
        "stores",
        "/:storeId/agents/listings",
        "/stores/:storeId/agents/listings",
        "listings.status",
      ],
      [
        "POST",
        "stores",
        "/:storeId/agents/listings/document",
        "/stores/:storeId/agents/listings/document",
        "installation.document",
      ],
      [
        "POST",
        "stores",
        "/:storeId/agents/listings",
        "/stores/:storeId/agents/listings",
        "installation.enable",
      ],
      [
        "POST",
        "stores",
        "/:storeId/agents/listings/stop",
        "/stores/:storeId/agents/listings/stop",
        "installation.stop",
      ],
      ["GET", "models", "", "/models", "models.list"],
      ["PUT", "settings/model-default", "", "/settings/model-default", "model_default.revise"],
    ],
  );
  for (const path of [enable, stop, document_, models, revise, "/workspace/ws_w/stores/x/agents"])
    assert.equal(agentsPathPattern.test(path), true, path);
  for (const path of [
    "/workspace/ws_w/work/goals",
    "/workspace/ws_w/stores/store_a/catalog/products",
    "/workspace/ws_w/connections",
    "/workspace/ws_w/models/extra",
    "/workspace/ws_w/settings/model-defaults",
    "/workspace/ws_w/settings",
    "/workspace/ws_w/store-links",
    "/workspace/bad id/models",
    "/api/models",
  ])
    assert.equal(agentsPathPattern.test(path), false, path);
});

test("the unbound default artifact answers every agents route with 401 and no I/O", async (t) => {
  const fetches = t.mock.method(globalThis, "fetch", () => {
    throw Error("NO_NETWORK");
  });
  const { lines } = await quiet(t, async () => {
    for (const [method, path, body] of [
      ["GET", enable],
      ["POST", enable, enableBody],
      ["POST", document_, "{}"],
      ["POST", stop, stopBody],
      ["GET", models],
      ["PUT", revise, reviseBody],
      ["DELETE", stop],
    ]) {
      const response = await defaultWorker.fetch(
        request(method, path, {
          body,
          headers: method === "GET" || method === "DELETE" ? readHeaders() : writeHeaders(),
        }),
        undefined,
        ctx,
      );
      const envelope = await expectEnvelope(response, 401, method + " " + path);
      assert.equal(envelope.code, "denied");
    }
  });
  assert.equal(fetches.mock.callCount(), 0);
  assert.ok(lines.every((line) => JSON.parse(line).outcome === "unbound"));
});

test("the api Worker sends agents paths to the agents handler and work paths to work", async (t) => {
  const seen = [];
  const recording = (label) => ({
    async open() {
      seen.push(label);
      throw Error("NO_DATABASE_IN_THIS_TEST");
    },
  });
  // One connector per dependency set: the agents handler shares the work dependencies.
  const worker = createWorkspaceApiWorker(undefined, {
    origin: workGuardOrigin,
    connector: recording("work-dependencies"),
    now: Date.now,
  });
  const { lines } = await quiet(t, async () => {
    const agents = await worker.fetch(request("GET", models), undefined, ctx);
    assert.equal(agents.status, 503);
    const work = await worker.fetch(request("GET", "/workspace/ws_w/work/goals"), undefined, ctx);
    assert.equal(work.status, 503);
  });
  assert.deepEqual(seen, ["work-dependencies", "work-dependencies"]);
  const events = lines.map((line) => JSON.parse(line).event);
  assert.ok(events.includes("morrow_agents"));
  assert.ok(events.some((e) => e !== "morrow_agents"));
});
