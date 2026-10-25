// Build order PR 8 (ADR-0029 items 1 to 3, as amended by ADR-0035 item 6): the E2B adapter
// (apps/broker/src/runtime-e2b.ts) over a recorded-HTTP fake of E2B's documented API
// (tests/fixtures/e2b-wire.mjs). No E2B endpoint is called.
//   * PR 7's runtime port conformance suite passes over the wire.
//   * The exact requests: two fixed origins, redirect "manual", the key only to the platform
//     API, the sandbox's token only to envd, the create's closed body (internet off, no
//     public traffic, no pause, metadata only the operation, the profile's timeout) with an
//     idempotency key, envd's octet-stream upload and its Connect-framed Start.
//   * The closed outcome table: 401, 404, 409, 422, 429, 5xx, timeouts, transport loss,
//     redirects and malformed bodies; a lone 404 never means absence; a broken reply is marked.
//   * The adapter never throws, never follows a redirect, never reads a reply past its bound.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  createE2bRuntime,
  e2bCreateBody,
  e2bPinnedTemplate,
  e2bReplyLimits,
} from "../apps/broker/src/runtime-e2b.ts";
import { computerProfile } from "../packages/policy/src/runtime-computer.ts";
import { createE2bWire, wireScript } from "./fixtures/e2b-wire.mjs";
import { runtimePortConformance } from "./fixtures/runtime-conformance.mjs";

const template = "morrow-computer-test-v1";
const budget = 5_000;
function wireWorld(options = {}) {
  let now = Date.parse("2026-10-24T10:00:00.000Z");
  const credential = "e2b_" + randomBytes(20).toString("hex");
  const wire = createE2bWire({ credential, now: () => now, templates: [template], ...options });
  const fetches = [];
  const adapter = createE2bRuntime(async (request) => {
    fetches.push(request.url);
    return wire.fetch(request);
  });
  return { wire, adapter, credential, fetches, advance: (ms) => (now += ms) };
}
const request = (operationId = randomUUID(), over = {}) => ({
  operationId,
  template,
  timeoutSeconds: computerProfile.sandboxTimeoutSeconds,
  internet: false,
  metadata: { operation: operationId },
  ...over,
});
const command = Object.freeze({
  argv: computerProfile.command,
  cwd: computerProfile.workDirectory,
  user: computerProfile.user,
  timeoutSeconds: computerProfile.execTimeoutSeconds,
});
async function sandboxOf(w, operationId = randomUUID()) {
  const r = await w.adapter.create(request(operationId), w.credential, budget);
  assert.equal(r.outcome, "created");
  return { sandboxRef: r.sandboxRef, accessToken: r.accessToken, operationId };
}
const clean = (w) => assert.deepEqual(w.wire.violations, []);

// ---------------------------------------------------------------------------
const faults = {
  create_lost_created: { route: "create", kind: "lost" },
  create_lost_absent: { route: "create", kind: "drop" },
  create_quota: {
    route: "create",
    kind: "status",
    status: 429,
    body: { code: 429, message: "Rate limit exceeded" },
    headers: { "retry-after": "30" },
  },
  create_billing: {
    route: "create",
    kind: "status",
    status: 403,
    body: { code: 403, message: "team is blocked" },
  },
  status_unknown: { route: "list", kind: "status", status: 500 },
  status_paused: { route: "list", kind: "paused" },
  kill_lost_killed: { route: "kill", kind: "lost" },
  write_unknown: { route: "write", kind: "lost" },
  exec_unknown: { route: "exec", kind: "cut" },
  read_unknown: { route: "read", kind: "status", status: 500 },
};
const names = runtimePortConformance(test, "e2b", async () => {
  const w = wireWorld();
  return {
    adapter: w.adapter,
    credential: w.credential,
    template,
    advance: w.advance,
    alive: () => w.wire.alive(),
    created: () => w.wire.created(),
    inject: (name) => {
      assert.ok(Object.hasOwn(faults, name), name);
      w.wire.fault(faults[name]);
    },
    guest: () => w.wire.guest,
    script: wireScript,
  };
});
test("the E2B adapter runs every case of PR 7's conformance suite", () => {
  assert.ok(names.length >= 15);
});

// ---------------------------------------------------------------------------
test("the create: one POST to the platform API, the closed body, the key, no redirect", async () => {
  const w = wireWorld();
  const op = randomUUID();
  const r = await w.adapter.create(request(op), w.credential, budget);
  assert.equal(r.outcome, "created");
  assert.match(r.sandboxRef, /^i[0-9a-f]{20}$/);
  assert.equal(r.accessToken, w.wire.sandboxes.get(r.sandboxRef).token);
  const [sent] = w.wire.requests;
  assert.equal(w.wire.requests.length, 1);
  assert.equal(sent.method, "POST");
  assert.equal(sent.origin + sent.path, "https://api.e2b.app/v2/sandboxes");
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.headers["x-api-key"], "<api-key>");
  assert.equal(sent.headers["idempotency-key"], op.replaceAll("-", ""));
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers["x-access-token"], undefined);
  const body = JSON.parse(new TextDecoder().decode(sent.body));
  assert.deepEqual(body, {
    templateID: template,
    timeout: 900,
    autoPause: false,
    allow_internet_access: false,
    network: { allowPublicTraffic: false },
    metadata: { operation: op },
  });
  assert.deepEqual(body, e2bCreateBody(request(op)));
  // Never sent: environment, MCP, IAM, volumes, auto-resume, a proxy or another network rule.
  for (const field of ["envVars", "mcp", "iam", "volumeMounts", "autoResume", "secure"])
    assert.equal(Object.hasOwn(body, field), false, field);
  assert.deepEqual(Object.keys(body.network), ["allowPublicTraffic"]);
  // The reply's traffic token is never kept or returned.
  assert.doesNotMatch(JSON.stringify(r), /traffic/);
  clean(w);
});

test("the create's outcome table: only a well-formed 201 is created; quota and billing are named", async () => {
  const cases = [
    [{ kind: "status", status: 400 }, { outcome: "unknown_effect" }],
    [{ kind: "status", status: 401 }, { outcome: "unknown_effect" }],
    [{ kind: "status", status: 404 }, { outcome: "unknown_effect" }],
    [
      {
        kind: "status",
        status: 409,
        body: { code: 409, message: "in progress", error_code: "idempotency_in_progress" },
      },
      { outcome: "unknown_effect" },
    ],
    [{ kind: "status", status: 422 }, { outcome: "unknown_effect" }],
    [{ kind: "status", status: 500 }, { outcome: "unknown_effect" }],
    [{ kind: "status", status: 502 }, { outcome: "unknown_effect" }],
    [
      {
        kind: "status",
        status: 503,
        body: { code: 503, message: "no capacity", error_code: "sandbox_capacity_unavailable" },
      },
      { outcome: "unknown_effect" },
    ],
    [{ kind: "status", status: 504 }, { outcome: "unknown_effect" }],
    [{ kind: "status", status: 429 }, { outcome: "quota_exhausted" }],
    [{ kind: "status", status: 402 }, { outcome: "billing_blocked" }],
    [{ kind: "status", status: 403 }, { outcome: "billing_blocked" }],
    [
      { kind: "status", status: 418 },
      { outcome: "unknown_effect", broken: true },
    ],
    [{ kind: "redirect" }, { outcome: "unknown_effect", broken: true }],
    [{ kind: "drop" }, { outcome: "unknown_effect" }],
    [{ kind: "lost" }, { outcome: "unknown_effect" }],
    [{ kind: "hang" }, { outcome: "unknown_effect" }],
    [
      { kind: "body", status: 201, body: "not json" },
      { outcome: "unknown_effect", broken: true },
    ],
    [
      { kind: "body", status: 201, body: "[]" },
      { outcome: "unknown_effect", broken: true },
    ],
    [
      { kind: "body", status: 200, body: "{}" },
      { outcome: "unknown_effect", broken: true },
    ],
  ];
  for (const [index, [fault, expected]] of cases.entries()) {
    const w = wireWorld();
    w.wire.fault({ route: "create", ...fault });
    const r = await w.adapter.create(request(), w.credential, fault.kind === "hang" ? 100 : budget);
    assert.deepEqual(r, expected, index + ": " + JSON.stringify(fault));
    // A redirect is never followed: the one request is the create's.
    assert.deepEqual(w.fetches, ["https://api.e2b.app/v2/sandboxes"], String(index));
  }
});

test("a 201 that breaks the documented shape is never a sandbox Morrow uses", async () => {
  const good = {
    templateID: template,
    sandboxID: "i0123456789abcdef0123",
    clientID: "6532622b",
    envdVersion: "0.2.4",
    envdAccessToken: "a".repeat(40),
    trafficAccessToken: null,
    domain: null,
  };
  const variants = [
    { envdAccessToken: undefined },
    { envdAccessToken: "short" },
    { sandboxID: "../etc" },
    { sandboxID: undefined },
    { templateID: "someone-elses-template" },
    { envdVersion: "latest" },
    { domain: "attacker.example" },
  ];
  for (const variant of variants) {
    const w = wireWorld();
    const body = JSON.stringify({ ...good, ...variant });
    w.wire.fault({ route: "create", kind: "body", status: 201, body });
    assert.deepEqual(
      await w.adapter.create(request(), w.credential, budget),
      { outcome: "unknown_effect", broken: true },
      JSON.stringify(variant),
    );
  }
  // The documented domain and an alias match are accepted.
  for (const variant of [{ domain: "e2b.app" }, { templateID: "x9y8z7", alias: template }]) {
    const w = wireWorld();
    w.wire.fault({
      route: "create",
      kind: "body",
      status: 201,
      body: JSON.stringify({ ...good, ...variant }),
    });
    const r = await w.adapter.create(request(), w.credential, budget);
    assert.equal(r.outcome, "created", JSON.stringify(variant));
  }
});

test("nothing leaves for a create that is not the profile's or a key of the wrong shape", async () => {
  const w = wireWorld();
  const op = randomUUID();
  for (const [bad, key] of [
    [request(op, { internet: true }), w.credential],
    [request(op, { timeoutSeconds: 901 }), w.credential],
    [request(op, { timeoutSeconds: 0 }), w.credential],
    [request(op, { metadata: { operation: op, shop: "x" } }), w.credential],
    [request(op, { template: "Bad Template" }), w.credential],
    [request(op, { operationId: "not-a-uuid" }), w.credential],
    [request(op), "sk-ant-not-e2b"],
    [null, w.credential],
  ])
    assert.deepEqual(await w.adapter.create(bad, key, budget), { outcome: "not_sent" });
  assert.equal(w.wire.requests.length, 0);
});

// ---------------------------------------------------------------------------
test("status: E2B's list by the operation's metadata, then the sandbox by its id; both must agree", async () => {
  const w = wireWorld();
  const s = await sandboxOf(w);
  const before = w.wire.requests.length;
  assert.deepEqual(await w.adapter.status(s.operationId, null, w.credential, budget), {
    outcome: "running",
    sandboxRef: s.sandboxRef,
  });
  const list = w.wire.requests[before];
  assert.equal(list.origin + list.path, "https://api.e2b.app/v2/sandboxes");
  assert.deepEqual(list.query, {
    metadata: "operation=" + s.operationId,
    state: "running,paused",
    limit: "100",
  });
  assert.match(list.rawQuery, /metadata=operation%3D[0-9a-f-]{36}&state=running%2Cpaused/);
  assert.deepEqual(await w.adapter.status(s.operationId, s.sandboxRef, w.credential, budget), {
    outcome: "running",
    sandboxRef: s.sandboxRef,
  });
  const detail = w.wire.requests.at(-1);
  assert.equal(detail.method, "GET");
  assert.equal(detail.path, "/sandboxes/" + s.sandboxRef);
  // Another operation's id never answers for this one.
  assert.equal(
    (await w.adapter.status(randomUUID(), s.sandboxRef, w.credential, budget)).outcome,
    "unknown",
  );
  clean(w);
});

test("a lone 404 never means absence", async () => {
  // The sandbox by its id says 404 while the list still shows it: unknown.
  {
    const w = wireWorld();
    const s = await sandboxOf(w);
    w.wire.fault({ route: "detail", kind: "status", status: 404 });
    assert.equal(
      (await w.adapter.status(s.operationId, s.sandboxRef, w.credential, budget)).outcome,
      "unknown",
    );
  }
  // A 404 that is not E2B's own body (an edge's HTML page): unknown, for a lookup and a kill.
  {
    const w = wireWorld();
    const s = await sandboxOf(w);
    await w.adapter.kill(s.sandboxRef, w.credential, budget);
    w.wire.fault({
      route: "detail",
      kind: "status",
      status: 404,
      body: "<html>not here</html>",
      contentType: "text/html",
    });
    assert.equal(
      (await w.adapter.status(s.operationId, s.sandboxRef, w.credential, budget)).outcome,
      "unknown",
    );
    w.wire.fault({
      route: "kill",
      kind: "status",
      status: 404,
      body: "<html>not here</html>",
      contentType: "text/html",
    });
    assert.equal((await w.adapter.kill(s.sandboxRef, w.credential, budget)).outcome, "unknown");
  }
  // The kill's 404 is read back: a sandbox the detail still shows is not "not found".
  {
    const w = wireWorld();
    const s = await sandboxOf(w);
    w.wire.fault({ route: "kill", kind: "status", status: 404 });
    assert.equal((await w.adapter.kill(s.sandboxRef, w.credential, budget)).outcome, "unknown");
    assert.equal(w.wire.alive().length, 1);
    // ...and the read-back failing is unknown too.
    await w.adapter.kill(s.sandboxRef, w.credential, budget);
    w.wire.fault({ route: "detail", kind: "status", status: 500 });
    assert.equal((await w.adapter.kill(s.sandboxRef, w.credential, budget)).outcome, "unknown");
  }
  // Both reads agree it is gone: not_found (which the gateway still never counts as deleted).
  {
    const w = wireWorld();
    const s = await sandboxOf(w);
    await w.adapter.kill(s.sandboxRef, w.credential, budget);
    assert.equal(
      (await w.adapter.status(s.operationId, s.sandboxRef, w.credential, budget)).outcome,
      "not_found",
    );
    assert.equal((await w.adapter.kill(s.sandboxRef, w.credential, budget)).outcome, "not_found");
  }
});

test("status: a broken or partial list is unknown, and a setting the profile never makes is paused", async () => {
  const listed = (over = {}) => ({
    templateID: template,
    sandboxID: "i0123456789abcdef0123",
    clientID: "6532622b",
    startedAt: "2026-10-24T10:00:00.000Z",
    endAt: "2026-10-24T10:15:00.000Z",
    cpuCount: 2,
    memoryMB: 1024,
    diskSizeMB: 10240,
    state: "running",
    envdVersion: "0.2.4",
    ...over,
  });
  const op = randomUUID();
  const cases = [
    [{ kind: "status", status: 401 }, "unknown"],
    [{ kind: "status", status: 429 }, "unknown"],
    [{ kind: "status", status: 503 }, "unknown"],
    [{ kind: "redirect" }, "unknown"],
    [{ kind: "hang" }, "unknown"],
    [{ kind: "drop" }, "unknown"],
    [{ kind: "body", status: 200, body: "{}" }, "unknown"],
    [{ kind: "body", status: 200, body: "not json" }, "unknown"],
    // A second page means the answer is incomplete.
    [{ kind: "body", status: 200, body: "[]", headers: { "x-next-token": "abc" } }, "unknown"],
    // An item for another operation (E2B's filter did not hold) or a malformed one.
    [
      {
        kind: "body",
        status: 200,
        body: JSON.stringify([listed({ metadata: { operation: randomUUID() } })]),
      },
      "unknown",
    ],
    [
      {
        kind: "body",
        status: 200,
        body: JSON.stringify([listed({ metadata: { operation: op } })]),
      },
      "running",
    ],
    [
      {
        kind: "body",
        status: 200,
        body: JSON.stringify([listed({ metadata: { operation: op }, state: "deleted" })]),
      },
      "unknown",
    ],
    // Two sandboxes for one operation: never guessed.
    [
      {
        kind: "body",
        status: 200,
        body: JSON.stringify([
          listed({ metadata: { operation: op } }),
          listed({ metadata: { operation: op }, sandboxID: "i9999999999999999999a" }),
        ]),
      },
      "unknown",
    ],
    [{ kind: "body", status: 200, body: "[]" }, "not_found"],
  ];
  for (const [index, [fault, expected]] of cases.entries()) {
    const w = wireWorld();
    w.wire.fault({ route: "list", ...fault });
    const r = await w.adapter.status(op, null, w.credential, fault.kind === "hang" ? 100 : budget);
    assert.equal(r.outcome, expected, index + ": " + JSON.stringify(fault));
  }
  // The detail shows internet on or pause on timeout: a profile violation (killed, held).
  for (const over of [
    { allowInternetAccess: true },
    { lifecycle: { autoResume: false, onTimeout: "pause" } },
    { lifecycle: { autoResume: true, onTimeout: "kill" } },
  ]) {
    const w = wireWorld();
    const s = await sandboxOf(w);
    const detail = {
      ...listed({ sandboxID: s.sandboxRef, metadata: { operation: s.operationId } }),
      ...over,
    };
    w.wire.fault({ route: "detail", kind: "body", status: 200, body: JSON.stringify(detail) });
    assert.deepEqual(
      await w.adapter.status(s.operationId, s.sandboxRef, w.credential, budget),
      { outcome: "paused", sandboxRef: s.sandboxRef },
      JSON.stringify(over),
    );
  }
});

test("the kill: DELETE with the key; only a 204 is killed", async () => {
  for (const [fault, expected] of [
    [null, "killed"],
    [{ kind: "status", status: 401 }, "unknown"],
    [{ kind: "status", status: 429 }, "unknown"],
    [{ kind: "status", status: 500 }, "unknown"],
    [{ kind: "redirect" }, "unknown"],
    [{ kind: "lost" }, "unknown"],
    [{ kind: "hang" }, "unknown"],
    [{ kind: "body", status: 200, body: "{}" }, "unknown"],
  ]) {
    const w = wireWorld();
    const s = await sandboxOf(w);
    if (fault) w.wire.fault({ route: "kill", ...fault });
    const r = await w.adapter.kill(
      s.sandboxRef,
      w.credential,
      fault?.kind === "hang" ? 100 : budget,
    );
    assert.equal(r.outcome, expected, JSON.stringify(fault));
    const sent = w.wire.requests.find((q) => q.method === "DELETE");
    assert.equal(sent.path, "/sandboxes/" + s.sandboxRef);
    assert.equal(sent.headers["x-api-key"], "<api-key>");
  }
  const w = wireWorld();
  for (const bad of ["", "a/b", "../x", "x".repeat(200)])
    assert.equal((await w.adapter.kill(bad, w.credential, budget)).outcome, "unknown");
  assert.equal((await w.adapter.kill("i0", "not-a-key", budget)).outcome, "unknown");
  assert.equal(w.wire.requests.length, 0);
});

// ---------------------------------------------------------------------------
test("envd: files go up as octet-stream to the sandbox, with its token and the agent user", async () => {
  const w = wireWorld();
  const s = await sandboxOf(w);
  const bytes = new TextEncoder().encode("sku,title\nA1,Shirt\n");
  assert.deepEqual(await w.adapter.writeFile(s, "/home/agent/input/products.csv", bytes, budget), {
    outcome: "written",
  });
  const sent = w.wire.requests.at(-1);
  assert.equal(sent.method, "POST");
  assert.equal(sent.origin + sent.path, "https://sandbox.e2b.app/files");
  assert.deepEqual(sent.query, { path: "/home/agent/input/products.csv", username: "agent" });
  assert.equal(sent.headers["e2b-sandbox-id"], s.sandboxRef);
  assert.equal(sent.headers["e2b-sandbox-port"], "49983");
  assert.equal(sent.headers["x-access-token"], "<sandbox-token>");
  assert.equal(sent.headers["x-api-key"], undefined);
  assert.equal(sent.headers["content-type"], "application/octet-stream");
  assert.deepEqual([...sent.body], [...bytes]);
  // A path outside the profile's directories, a missing token, a forged ref: nothing leaves.
  const count = w.wire.requests.length;
  for (const [handle, path] of [
    [s, "/etc/passwd"],
    [s, "/home/agent/input/../../etc/x.csv"],
    [s, "/home/agent/input/products.sh"],
    [{ ...s, accessToken: null }, "/home/agent/input/products.csv"],
    [{ ...s, sandboxRef: "a/b" }, "/home/agent/input/products.csv"],
  ])
    assert.deepEqual(await w.adapter.writeFile(handle, path, bytes, budget), {
      outcome: "unknown",
    });
  assert.equal(w.wire.requests.length, count);
  clean(w);
});

test("envd writes: transient failures are unknown; a refused token or a broken reply is marked", async () => {
  for (const [fault, expected] of [
    [
      { kind: "status", status: 401 },
      { outcome: "unknown", broken: true },
    ],
    [
      { kind: "status", status: 400 },
      { outcome: "unknown", broken: true },
    ],
    [{ kind: "redirect" }, { outcome: "unknown", broken: true }],
    [
      { kind: "body", status: 200, body: "{}" },
      { outcome: "unknown", broken: true },
    ],
    [
      { kind: "body", status: 200, body: '[{"path":"/x","type":"file"}]' },
      { outcome: "unknown", broken: true },
    ],
    [
      {
        kind: "status",
        status: 502,
        body: { sandboxId: "i0", message: "The sandbox was not found", code: 502 },
      },
      { outcome: "unknown" },
    ],
    [{ kind: "status", status: 507 }, { outcome: "unknown" }],
    [{ kind: "status", status: 500 }, { outcome: "unknown" }],
    [{ kind: "status", status: 429 }, { outcome: "unknown" }],
    [{ kind: "lost" }, { outcome: "unknown" }],
    [{ kind: "hang" }, { outcome: "unknown" }],
  ]) {
    const w = wireWorld();
    const s = await sandboxOf(w);
    w.wire.fault({ route: "write", ...fault });
    assert.deepEqual(
      await w.adapter.writeFile(
        s,
        computerProfile.jobPath,
        new Uint8Array([1]),
        fault.kind === "hang" ? 100 : budget,
      ),
      expected,
      JSON.stringify(fault),
    );
  }
});

test("envd reads: bounded by the caller, identity only; a 404 is missing only with E2B's body", async () => {
  const w = wireWorld();
  const s = await sandboxOf(w);
  const png = new Uint8Array(64).fill(7);
  await w.adapter.writeFile(s, "/home/agent/output/chart.png", png, budget);
  const read = await w.adapter.readFile(s, "/home/agent/output/chart.png", 64, budget);
  assert.equal(read.outcome, "read");
  assert.deepEqual([...read.bytes], [...png]);
  const sent = w.wire.requests.at(-1);
  assert.equal(sent.method, "GET");
  assert.deepEqual(sent.query, { path: "/home/agent/output/chart.png", username: "agent" });
  assert.equal(sent.headers["accept-encoding"], "identity");
  assert.deepEqual(await w.adapter.readFile(s, "/home/agent/output/chart.png", 63, budget), {
    outcome: "too_large",
  });
  assert.deepEqual(await w.adapter.readFile(s, "/home/agent/output/none.png", 64, budget), {
    outcome: "missing",
  });
  const big = "x".repeat(100);
  for (const [fault, expected] of [
    // Too large while streaming, with no declared length.
    [
      {
        kind: "body",
        status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(big));
            c.close();
          },
        }),
        contentType: "application/octet-stream",
      },
      { outcome: "too_large" },
    ],
    [
      { kind: "body", status: 200, body: big, headers: { "content-encoding": "gzip" } },
      { outcome: "unknown", broken: true },
    ],
    [
      { kind: "status", status: 404, body: "<html>404</html>", contentType: "text/html" },
      { outcome: "unknown", broken: true },
    ],
    [
      { kind: "status", status: 401 },
      { outcome: "unknown", broken: true },
    ],
    [
      { kind: "status", status: 406 },
      { outcome: "unknown", broken: true },
    ],
    [{ kind: "redirect" }, { outcome: "unknown", broken: true }],
    [{ kind: "status", status: 500 }, { outcome: "unknown" }],
    [{ kind: "status", status: 502 }, { outcome: "unknown" }],
    [{ kind: "drop" }, { outcome: "unknown" }],
  ]) {
    w.wire.fault({ route: "read", ...fault });
    assert.deepEqual(
      await w.adapter.readFile(s, "/home/agent/output/chart.png", 64, budget),
      expected,
      JSON.stringify({ ...fault, body: typeof fault.body }),
    );
  }
});

test("envd exec: one Connect-framed Start of the profile's command, as agent, no environment, no stdin", async () => {
  const w = wireWorld();
  const s = await sandboxOf(w);
  await w.adapter.writeFile(
    s,
    computerProfile.jobPath,
    wireScript({ stdout: "done", stderr: "warned" }),
    budget,
  );
  const ran = await w.adapter.exec(s, command, budget);
  assert.deepEqual(ran, { outcome: "exited", exitCode: 0, stdout: "done\n", stderr: "warned\n" });
  const sent = w.wire.requests.at(-1);
  assert.equal(sent.origin + sent.path, "https://sandbox.e2b.app/process.Process/Start");
  assert.equal(sent.headers["content-type"], "application/connect+json");
  assert.equal(sent.headers["connect-protocol-version"], "1");
  assert.equal(sent.headers["connect-timeout-ms"], "120000");
  assert.equal(sent.headers.authorization, "Basic " + btoa("agent:"));
  assert.equal(sent.headers["x-access-token"], "<sandbox-token>");
  assert.equal(sent.body[0], 0);
  const length = new DataView(sent.body.buffer, sent.body.byteOffset).getUint32(1, false);
  assert.equal(sent.body.length, 5 + length);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sent.body.subarray(5))), {
    process: {
      cmd: "/usr/bin/python3",
      args: ["-I", "-B", "/home/agent/work/job.py"],
      envs: {},
      cwd: "/home/agent/work",
    },
    stdin: false,
  });
  const [run] = w.wire.guest.commands;
  assert.deepEqual(run.argv, [...computerProfile.command]);
  assert.equal(run.user, "agent");
  assert.deepEqual(run.environment, {});
  assert.equal(run.stdin, false);
  // Logs are cut to the profile's 4 KiB by the adapter.
  await w.adapter.writeFile(
    s,
    computerProfile.jobPath,
    wireScript({ stdout: "y".repeat(10_000), exitCode: 4 }),
    budget,
  );
  const long = await w.adapter.exec(s, command, budget);
  assert.equal(long.outcome, "exited");
  assert.equal(long.exitCode, 4);
  assert.equal(long.stdout, "y".repeat(4096));
  // Not the profile's command: nothing leaves.
  const count = w.wire.requests.length;
  for (const bad of [
    { ...command, argv: ["/bin/sh", "-c", "curl x"] },
    { ...command, user: "root" },
    { ...command, cwd: "/" },
    { ...command, timeoutSeconds: 121 },
  ])
    assert.deepEqual(await w.adapter.exec(s, bad, budget), { outcome: "unknown" });
  assert.equal(w.wire.requests.length, count);
  clean(w);
});

test("envd exec: deadlines are timed_out; a cut, refused or malformed stream is unknown", async () => {
  const frame = (message, flags = 0) => {
    const body = new TextEncoder().encode(JSON.stringify(message));
    const out = new Uint8Array(5 + body.length);
    out[0] = flags;
    new DataView(out.buffer).setUint32(1, body.length, false);
    out.set(body, 5);
    return out;
  };
  const join = (...frames) => Buffer.concat(frames.map((f) => Buffer.from(f)));
  const startFrame = frame({ event: { start: { pid: 1 } } });
  const streamed = (bytes) => ({
    kind: "body",
    status: 200,
    body: bytes,
    contentType: "application/connect+json",
  });
  const cases = [
    [
      streamed(join(startFrame, frame({ error: { code: "deadline_exceeded", message: "x" } }, 2))),
      { outcome: "timed_out" },
    ],
    [
      streamed(join(startFrame, frame({ error: { code: "unavailable", message: "x" } }, 2))),
      { outcome: "unknown" },
    ],
    [
      streamed(join(startFrame, frame({ error: "weird" }, 2))),
      { outcome: "unknown", broken: true },
    ],
    // The stream ends with no end event, or with no end-of-stream message.
    [streamed(join(startFrame, frame({}, 2))), { outcome: "unknown", broken: true }],
    [
      streamed(join(startFrame, frame({ event: { end: { exited: true } } }))),
      { outcome: "unknown" },
    ],
    // Data before start, an unknown event, two events in one, a bad exit code, bad base64.
    [
      streamed(join(frame({ event: { data: { stdout: "eA==" } } }))),
      { outcome: "unknown", broken: true },
    ],
    [
      streamed(join(startFrame, frame({ event: { surprise: {} } }))),
      { outcome: "unknown", broken: true },
    ],
    [
      streamed(join(startFrame, frame({ event: { keepalive: {}, end: {} } }))),
      { outcome: "unknown", broken: true },
    ],
    [
      streamed(join(startFrame, frame({ event: { end: { exitCode: "0" } } }), frame({}, 2))),
      { outcome: "unknown", broken: true },
    ],
    [
      streamed(join(startFrame, frame({ event: { data: { stdout: "%%%" } } }))),
      { outcome: "unknown", broken: true },
    ],
    // A frame flag outside the protocol, or a frame longer than the bound.
    [
      streamed(join(Uint8Array.of(4, 0, 0, 0, 2), new TextEncoder().encode("{}"))),
      { outcome: "unknown", broken: true },
    ],
    [streamed(Uint8Array.of(0, 0x7f, 0xff, 0xff, 0xff)), { outcome: "unknown", broken: true }],
    // The wrong media type, a refused token, a redirect: broken. A 502 or a cut: unknown.
    [
      { kind: "body", status: 200, body: "{}", contentType: "application/json" },
      { outcome: "unknown", broken: true },
    ],
    [
      { kind: "status", status: 401 },
      { outcome: "unknown", broken: true },
    ],
    [{ kind: "redirect" }, { outcome: "unknown", broken: true }],
    [{ kind: "status", status: 502 }, { outcome: "unknown" }],
    [{ kind: "cut" }, { outcome: "unknown" }],
    [{ kind: "drop" }, { outcome: "unknown" }],
  ];
  for (const [index, [fault, expected]] of cases.entries()) {
    const w = wireWorld();
    const s = await sandboxOf(w);
    w.wire.fault({ route: "exec", ...fault });
    assert.deepEqual(await w.adapter.exec(s, command, budget), expected, String(index));
  }
  // A zero exit code left out (proto3 JSON) is 0, and a keepalive after the end is fine.
  {
    const w = wireWorld();
    const s = await sandboxOf(w);
    w.wire.fault({
      route: "exec",
      ...streamed(
        join(
          startFrame,
          frame({ event: { end: { exited: true, status: "exit status 0" } } }),
          frame({ event: { keepalive: {} } }),
          frame({}, 2),
        ),
      ),
    });
    assert.deepEqual(await w.adapter.exec(s, command, budget), {
      outcome: "exited",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  }
  // envd never ends the stream: the adapter's own stop past the command's timeout.
  {
    const w = wireWorld();
    const s = await sandboxOf(w);
    await w.adapter.writeFile(s, computerProfile.jobPath, wireScript({ stall: true }), budget);
    const started = Date.now();
    const r = await w.adapter.exec(s, { ...command, timeoutSeconds: 1 }, 30_000);
    assert.deepEqual(r, { outcome: "timed_out" });
    const took = Date.now() - started;
    assert.ok(took >= 1000 && took < 1000 + e2bReplyLimits.commandGraceMs + 5000, String(took));
  }
  // The caller's budget ends first: unknown, never timed_out.
  {
    const w = wireWorld();
    const s = await sandboxOf(w);
    await w.adapter.writeFile(s, computerProfile.jobPath, wireScript({ stall: true }), budget);
    assert.deepEqual(await w.adapter.exec(s, command, 200), { outcome: "unknown" });
  }
});

// The hosted runner's `npm test` hung on this file (2026-10-25): a full collection inside a
// "hang" fault's or a stalled stream's wait cut the caller's abort off from the wire, because
// a Request's signal follows the caller's only while the Request is alive, and the adapter
// keeps none. The wire holds each waiting Request until its abort; here the heap is collected
// every few milliseconds through each wait, and a wait that never ends fails within its bound
// instead of holding the run.
test("the wire's waits end on the caller's abort however often the heap is collected", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc");
  const within = async (label, promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(label + ": never settled")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const collector = setInterval(collect, 5);
  try {
    for (const route of ["create", "list", "kill", "write"]) {
      const w = wireWorld();
      const s = await sandboxOf(w);
      w.wire.fault({ route, kind: "hang" });
      const r = await within(
        route,
        route === "create"
          ? w.adapter.create(request(), w.credential, 100)
          : route === "list"
            ? w.adapter.status(s.operationId, null, w.credential, 100)
            : route === "kill"
              ? w.adapter.kill(s.sandboxRef, w.credential, 100)
              : w.adapter.writeFile(s, computerProfile.jobPath, wireScript({}), 100),
      );
      assert.equal(r.outcome, route === "create" ? "unknown_effect" : "unknown", route);
    }
    const w = wireWorld();
    const s = await sandboxOf(w);
    await w.adapter.writeFile(s, computerProfile.jobPath, wireScript({ stall: true }), budget);
    assert.deepEqual(await within("exec", w.adapter.exec(s, command, 200)), {
      outcome: "unknown",
    });
  } finally {
    clearInterval(collector);
  }
});

// ---------------------------------------------------------------------------
test("custody: the key reaches only the platform API, the token only envd, nothing reaches a guest", async () => {
  const w = wireWorld();
  const s = await sandboxOf(w);
  await w.adapter.writeFile(s, "/home/agent/input/products.csv", new Uint8Array([65]), budget);
  await w.adapter.writeFile(s, computerProfile.jobPath, wireScript({ exitCode: 0 }), budget);
  await w.adapter.exec(s, command, budget);
  await w.adapter.readFile(s, "/home/agent/input/products.csv", 10, budget);
  await w.adapter.status(s.operationId, s.sandboxRef, w.credential, budget);
  await w.adapter.kill(s.sandboxRef, w.credential, budget);
  for (const r of w.wire.requests) {
    const headers = JSON.stringify(r.headers);
    if (r.origin === "https://api.e2b.app") {
      assert.match(headers, /<api-key>/);
      assert.doesNotMatch(headers, /<sandbox-token>/);
    } else {
      assert.equal(r.origin, "https://sandbox.e2b.app");
      assert.match(headers, /<sandbox-token>/);
      assert.doesNotMatch(headers, /<api-key>/);
    }
    assert.equal(r.redirect, "manual");
    const body = new TextDecoder().decode(r.body);
    assert.ok(!body.includes(w.credential) && !body.includes(s.accessToken), r.path);
  }
  const guest = JSON.stringify(w.wire.guest, (k, v) => (v instanceof Uint8Array ? [...v] : v));
  assert.ok(!guest.includes(w.credential) && !guest.includes(s.accessToken));
  assert.doesNotMatch(guest, /https?:\/\/|myshopify\.com|workers\.dev/);
  clean(w);
});

test("the adapter's source: plain fetch to two fixed origins, no SDK, no Node, no redirect followed", () => {
  const source = readFileSync("apps/broker/src/runtime-e2b.ts", "utf8");
  assert.doesNotMatch(source, /from "e2b"|from "@e2b|require\(|from "node:/);
  assert.doesNotMatch(source, /redirect: "follow"|redirect: "error"/);
  assert.match(source, /redirect: "manual"/);
  assert.deepEqual([...new Set(source.match(/https:\/\/[a-z0-9.-]+/g))].sort(), [
    "https://api.e2b.app",
    "https://sandbox.e2b.app",
  ]);
  // The only paths: the v2 create and list, one sandbox by id (GET and DELETE), envd's files
  // and its Start. Never a pause, resume, connect, refresh, timeout change or network update.
  const paths = [...new Set(source.match(/"\/[A-Za-z0-9_./?=]*/g))].sort();
  assert.deepEqual(paths, [
    '"/files?path=',
    '"/process.Process/Start',
    '"/sandboxes/',
    '"/v2/sandboxes',
    '"/v2/sandboxes?',
  ]);
  // The broker declares no dependency at all (the old lab adapters' SDK pin in
  // packages/runtime-adapters never reaches it; edge:check's bundle allowlist holds that).
  const broker = JSON.parse(readFileSync("apps/broker/package.json", "utf8"));
  assert.equal(broker.dependencies, undefined);
  for (const file of ["runtime-gateway.ts", "runtime-ledger.ts", "index.ts"])
    assert.doesNotMatch(
      readFileSync("apps/broker/src/" + file, "utf8"),
      /runtime-adapters|from "e2b"|@e2b\//,
    );
});

test("only the broker composes the adapter: no other Worker names E2B, its key or its origins", () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".wrangler", ".artifacts"].includes(entry.name)) continue;
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|js|mjs|jsonc?)$/.test(entry.name)) sources.push(path);
    }
  };
  walk("apps");
  const naming = sources.filter((path) =>
    /E2B_API_KEY|e2b\.app|runtime-e2b|@e2b\/|from "e2b"/.test(readFileSync(path, "utf8")),
  );
  assert.ok(naming.length > 0);
  for (const path of naming) assert.match(path, /^apps\/broker\/src\//, path);
  // Inside the broker, only the composition root imports the adapter.
  const importers = naming.filter((path) =>
    /from "\.\/runtime-e2b\.js"/.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(importers, ["apps/broker/src/index.ts"]);
});

test("the pinned template is the owner's build record (none until it is built and qualified)", () => {
  const record = JSON.parse(readFileSync("infra/e2b/morrow-computer/template.json", "utf8"));
  assert.equal(e2bPinnedTemplate, record.template_id);
  assert.equal(e2bPinnedTemplate, null);
});

// Review F1 (2026-10-24): E2B's builder runs its provisioning (root's password cleared;
// sudo, openssh-server with root and empty-password logins, curl, socat, git, iptables) and
// its default user `user` before the recipe's steps, and its finalize step (`user` with an
// empty password and passwordless sudo, /usr/local writable by all) after them. As root,
// before `USER agent`, the recipe closes each way from agent to root and stops the build if
// one did not take. Reproduced offline in Debian trixie: without these lines, `su agent -c
// "su root -c id"` printed uid=0; with them, su answers "Permission denied" to agent.
const recipeHardening = [
  "RUN passwd -l root \\",
  " && dpkg-statoverride --update --add root root 4750 /usr/bin/su \\",
  " && dpkg-statoverride --update --add root root 4750 /usr/bin/sudo \\",
  " && if dpkg-query -W -f='${Status}' openssh-server 2>/dev/null | grep -q 'ok installed'; then \\",
  "      DEBIAN_FRONTEND=noninteractive apt-get purge -y openssh-server; \\",
  "    fi \\",
  " && test \"$(passwd -S root | cut -d' ' -f2)\" = L \\",
  ' && test "$(stat -c %a:%U:%G /usr/bin/su)" = 4750:root:root \\',
  ' && if [ -e /usr/bin/sudo ]; then test "$(stat -c %a:%U:%G /usr/bin/sudo)" = 4750:root:root; fi \\',
  " && test ! -e /usr/sbin/sshd \\",
  ' && test "$(id -nG agent)" = agent',
].join("\n");

test("the template recipe: Debian's Python and data libraries, no browser or network tool, agent last", () => {
  const recipe = readFileSync("infra/e2b/morrow-computer/e2b.Dockerfile", "utf8");
  const record = JSON.parse(readFileSync("infra/e2b/morrow-computer/template.json", "utf8"));
  const readme = readFileSync("infra/e2b/morrow-computer/README.md", "utf8");
  assert.equal(
    createHash("sha256").update(recipe).digest("hex"),
    record.recipe_sha256,
    "a recipe change needs a new record (and a new build and qualification)",
  );
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "agent_canary",
      "build_id",
      "built_on",
      "cli",
      "cpu_count",
      "envd_version",
      "memory_mb",
      "name",
      "profile",
      "project",
      "recipe",
      "recipe_sha256",
      "schema_version",
      "scope",
      "template_id",
    ].sort(),
  );
  assert.equal(record.profile, computerProfile.id + "@" + computerProfile.version);
  assert.equal(record.cpu_count, computerProfile.vcpu);
  assert.equal(record.memory_mb, computerProfile.memoryMiB);
  // Built or not, as one: the pin is the template's id, recorded with the one build PR 9
  // qualifies (E2B starts a template's newest ready build; no create by build is documented).
  const built = [record.template_id, record.build_id, record.envd_version, record.built_on];
  assert.ok(built.every((v) => v === null) || built.every((v) => typeof v === "string"));
  if (record.template_id !== null) assert.doesNotMatch(record.template_id, /:/);
  assert.match(record.scope, /new build of the same template/);
  const all = recipe
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join("\n");
  // The hardening step (review F1) is pinned on its own below; everything else is checked here.
  assert.ok(all.includes(recipeHardening), "the hardening step, exactly");
  const lines = all.replace(recipeHardening + "\n", "");
  // One base, Debian's packages only (no pip, no download, no copied file), no secret.
  assert.equal((lines.match(/^FROM /gm) ?? []).length, 1);
  assert.match(lines, /^FROM debian:[a-z]+-slim$/m);
  const forbiddenTools = /\bpip3?\b|curl|wget|\bgit\b|ssh|netcat|\bnc\b|nmap|socat/;
  assert.doesNotMatch(lines, forbiddenTools);
  // The one install installs exactly these (so never sudo, an SSH server or a network tool).
  const install =
    /apt-get install -y --no-install-recommends \\\n((?:[ ]+[a-z0-9.+-]+ \\\n)+) && apt-get clean/.exec(
      lines,
    );
  assert.ok(install, "one apt-get install");
  assert.deepEqual(install[1].replace(/\\/g, "").trim().split(/\s+/), [
    "python3",
    "python3-numpy",
    "python3-pandas",
    "python3-matplotlib",
    "python3-openpyxl",
    "python3-xlsxwriter",
    "fonts-dejavu-core",
  ]);
  assert.equal((lines.match(/apt-get install/g) ?? []).length, 1);
  assert.doesNotMatch(lines, /chrom|firefox|playwright|puppeteer|selenium|webkit|xvfb/i);
  assert.doesNotMatch(lines, /^(ADD|COPY|ENV|ARG|EXPOSE|CMD|ENTRYPOINT) /m);
  assert.doesNotMatch(lines, /sudo|wheel|--groups|usermod|setuid|E2B_|KEY|TOKEN/);
  assert.doesNotMatch(lines, /gcc|g\+\+|build-essential|\bmake\b/);
  for (const library of [
    "python3",
    "python3-numpy",
    "python3-pandas",
    "python3-matplotlib",
    "python3-openpyxl",
    "python3-xlsxwriter",
  ])
    assert.match(lines, new RegExp("^\\s+" + library + " \\\\$", "m"), library);
  // The profile's user, directories and command: /usr/bin/python3 is Debian's python3.
  for (const dir of [
    computerProfile.workDirectory,
    computerProfile.inputDirectory,
    computerProfile.outputDirectory,
  ])
    assert.ok(lines.includes(dir), dir);
  assert.match(lines, /useradd [^\n]*--user-group agent/);
  assert.equal(computerProfile.command[0], "/usr/bin/python3");
  assert.deepEqual(lines.trim().split("\n").slice(-2), [
    "USER " + computerProfile.user,
    "WORKDIR " + computerProfile.workDirectory,
  ]);
  // The owner's exact command matches the record; the README never asks for a key.
  assert.ok(
    readme.includes(
      `npx --yes ${record.cli} template create ${record.name} --path infra/e2b/morrow-computer --dockerfile e2b.Dockerfile --cpu-count ${record.cpu_count} --memory-mb ${record.memory_mb}`,
    ),
  );
  assert.doesNotMatch(readme, /E2B_API_KEY=|export E2B|e2b_[A-Za-z0-9]{8}/);
});

test("the template recipe closes every way from agent to root that E2B's build leaves (review F1)", () => {
  const recipe = readFileSync("infra/e2b/morrow-computer/e2b.Dockerfile", "utf8");
  const record = JSON.parse(readFileSync("infra/e2b/morrow-computer/template.json", "utf8"));
  const readme = readFileSync("infra/e2b/morrow-computer/README.md", "utf8");
  const steps = recipe
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join("\n");
  // Exactly once, as root (no USER before it), after agent exists, right before USER agent.
  const at = steps.indexOf(recipeHardening);
  assert.ok(at > 0, "the hardening step, exactly");
  assert.equal(steps.indexOf(recipeHardening, at + 1), -1);
  assert.equal(steps.lastIndexOf("\nUSER ", at), -1, "it runs as root");
  assert.ok(steps.indexOf("useradd ") < at, "agent exists before it");
  assert.deepEqual(
    steps
      .slice(at + recipeHardening.length)
      .trim()
      .split("\n"),
    ["USER " + computerProfile.user, "WORKDIR " + computerProfile.workDirectory],
  );
  // Nothing in the recipe gives agent a group, sudo or a password.
  const rest = steps.replace(recipeHardening, "");
  assert.doesNotMatch(rest, /sudo|wheel|--groups|usermod|chpasswd|passwd|NOPASSWD|setcap|chmod/);
  // PR 9's recorded check tries each way as agent on the exact build.
  assert.deepEqual(record.agent_canary, [
    { try: "su root -c id", expect: "refused" },
    { try: "su user -c 'sudo -n id'", expect: "refused" },
    { try: "sudo -n id", expect: "refused" },
    { try: "ssh user@127.0.0.1 id; ssh root@127.0.0.1 id", expect: "refused" },
    { try: "read /proc/<envd pid>/environ and /proc/<envd pid>/mem", expect: "refused" },
    { try: "write a file under /usr/local/bin and /usr/local/sbin", expect: "recorded" },
    { try: "list every setuid or setgid file and its mode", expect: "recorded" },
  ]);
  assert.match(record.scope, /agent_canary/);
  // The owner is told what E2B adds and that egress is the platform's, not the image's.
  assert.doesNotMatch(readme, /It has no browser, no network tool|never as root/);
  for (const tool of ["curl", "socat", "git", "iptables", "SSH server", "sudo", "/usr/local"])
    assert.ok(readme.includes(tool), tool);
  assert.match(readme, /It is E2B,\s+not the image, that keeps the sandbox off the internet/);
  assert.match(readme, /agent_canary/);
});
