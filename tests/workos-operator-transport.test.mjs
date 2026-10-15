import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createWorkosOperatorTransport,
  parseWorkosOperatorProfile,
  workosOperatorEnvironmentAllowed,
} from "../scripts/workos-operator-transport.mjs";
const profile = readFileSync("docs/decisions/workos-operator-qualification.json", "utf8"),
  p = JSON.parse(profile);
const verifier = Buffer.alloc(32, 1).toString("base64url"),
  code = " exact e\u0301 😀\u0000 code ";
const input = JSON.stringify({ code, verifier });
const payload = {
  access_token: ["synthetic", "access", "fixture"].join("_"),
  refresh_token: ["synthetic", "refresh", "fixture"].join("_"),
  user: { id: "user_" + "A".repeat(26), email: "private@example.com" },
};
function response(body = JSON.stringify(payload), options = {}) {
  const r = new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
  Object.defineProperty(r, "url", { value: options.url ?? p.token_endpoint });
  if (options.redirected) Object.defineProperty(r, "redirected", { value: true });
  return r;
}
function fixture(fetcher = async () => response(), options = {}) {
  const calls = [];
  const transport = createWorkosOperatorTransport(profile, {
    mode: "synthetic",
    fetch: async (...args) => {
      calls.push(args);
      return fetcher(...args);
    },
    ...options,
  });
  return { transport, calls };
}
function safe(value, category) {
  assert.ok(Object.isFrozen(value));
  assert.equal(value.category, category);
  assert.equal(
    value.outcome,
    category === "response_shape_received" ? "response_shape_received" : "held",
  );
  assert.equal(value.providerSessionCleanup, "unknown");
  assert.deepEqual(Object.keys(value).sort(), [
    "category",
    "outcome",
    "providerSessionCleanup",
    "statusClass",
  ]);
  for (const raw of [
    code,
    verifier,
    payload.access_token,
    payload.refresh_token,
    payload.user.email,
    payload.user.id,
  ])
    assert.ok(!JSON.stringify(value).includes(raw));
}
test("fixed keyless synthetic exchange sends exact opaque bytes once and returns no token/user authority", async () => {
  const f = fixture(),
    result = await f.transport.exchangeOnce(input);
  safe(result, "response_shape_received");
  assert.equal(result.statusClass, "2xx");
  assert.equal(f.transport.mode, "synthetic");
  assert.equal(f.calls.length, 1);
  const [url, request] = f.calls[0];
  assert.equal(url, p.token_endpoint);
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.deepEqual(request.headers, {
    "content-type": "application/json",
    accept: "application/json",
  });
  assert.deepEqual(JSON.parse(request.body), {
    client_id: p.client_id,
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });
  safe(await f.transport.exchangeOnce(input), "already_used");
  assert.equal(f.calls.length, 1);
});
test("concurrent calls have a single synchronous winner before a delayed fetch", async () => {
  let finish;
  const pending = new Promise((resolve) => {
      finish = resolve;
    }),
    f = fixture(() => pending);
  const one = f.transport.exchangeOnce(input),
    two = f.transport.exchangeOnce(input);
  safe(await two, "already_used");
  assert.equal(f.calls.length, 1);
  finish(response());
  safe(await one, "response_shape_received");
});
test("profile and native seams cannot select another client, endpoint, limit or injected native fetch", () => {
  assert.ok(Object.isFrozen(parseWorkosOperatorProfile(profile)));
  for (const patch of [
    { client_id: "foreign" },
    { token_endpoint: "https://foreign.example/auth" },
    { max_posts: 2 },
    { max_post_seconds: 16 },
    { origin: "http://localhost:4110" },
    { extra: true },
  ])
    assert.throws(
      () =>
        createWorkosOperatorTransport(JSON.stringify({ ...p, ...patch }), {
          mode: "synthetic",
          fetch() {},
        }),
      /WORKOS_OPERATOR_TRANSPORT_DENIED/,
    );
  for (const options of [
    { mode: "synthetic" },
    { mode: "native", fetch() {} },
    { mode: "native", clock: Date.now },
    { mode: "auto" },
    { mode: "synthetic", fetch() {}, apiKey: "not_allowed" },
  ])
    assert.throws(
      () => createWorkosOperatorTransport(profile, options),
      /WORKOS_OPERATOR_TRANSPORT_DENIED/,
    );
  assert.throws(() => parseWorkosOperatorProfile(p), /WORKOS_OPERATOR_TRANSPORT_DENIED/);
});
test("private input rejects objects/proxies/getters before reflection and consumes no network", async () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
    },
  );
  for (const value of [
    hostile,
    {
      get code() {
        traps++;
        throw Error();
      },
    },
    {},
    "{bad",
    JSON.stringify({ code, verifier, client_id: p.client_id }),
    JSON.stringify({ code: "", verifier }),
    JSON.stringify({ code: "x".repeat(4097), verifier }),
    JSON.stringify({ code: "\ud800", verifier }),
    JSON.stringify({ code, verifier: "a".repeat(43) }),
  ]) {
    const f = fixture();
    safe(await f.transport.exchangeOnce(value), "input_denied");
    assert.equal(f.calls.length, 0);
    safe(await f.transport.exchangeOnce(input), "already_used");
  }
  assert.equal(traps, 0);
});
test("ambient credentials/proxies/TLS/config overrides deny before fetch without fallback", async () => {
  for (const key of [
    "WORKOS_API_KEY",
    "WORKOS_API_HOSTNAME",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ]) {
    const previous = process.env[key];
    process.env[key] = key === "NODE_TLS_REJECT_UNAUTHORIZED" ? "0" : "private_override";
    try {
      assert.equal(workosOperatorEnvironmentAllowed(), false);
      const f = fixture();
      safe(await f.transport.exchangeOnce(input), "configuration_denied");
      assert.equal(f.calls.length, 0);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
});
test("deadline/cancellation preflight and clock-side configuration drift never fetch", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const a = fixture();
  safe(await a.transport.exchangeOnce(input, { signal: aborted.signal }), "cancelled");
  assert.equal(a.calls.length, 0);
  const b = fixture();
  safe(await b.transport.exchangeOnce(input, { deadlineMs: Date.now() - 1 }), "timeout");
  assert.equal(b.calls.length, 0);
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    const c = fixture(undefined, {
      clock: () => {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        return Date.now();
      },
    });
    safe(await c.transport.exchangeOnce(input), "configuration_denied");
    assert.equal(c.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});
test("foreign/redirected responses and all non200 statuses hold without another POST", async () => {
  for (const options of [
    { url: "https://foreign.example/auth" },
    { redirected: true },
    { status: 201 },
    { status: 302 },
    { status: 400 },
    { status: 429 },
    { status: 503 },
  ]) {
    const f = fixture(async () => response("private_provider_body", options));
    const result = await f.transport.exchangeOnce(input);
    safe(result, options.url || options.redirected ? "response_origin_denied" : "http_rejected");
    safe(await f.transport.exchangeOnce(input), "already_used");
    assert.equal(f.calls.length, 1);
  }
});
test("content/length/body/UTF8/JSON/token shape errors hold and cancel rejected bodies", async () => {
  const cases = [
    [() => response("private", { headers: { "content-type": "text/html" } }), "content_denied"],
    [() => response("private", { headers: { "content-length": "131073" } }), "body_denied"],
    [() => response("private", { headers: { "content-length": "not_a_length" } }), "body_denied"],
    [() => response("x".repeat(131073)), "body_denied"],
    [() => response(new Uint8Array([0xff])), "shape_denied"],
    [() => response("{bad"), "shape_denied"],
    ...[
      null,
      [],
      {},
      { ...payload, access_token: "" },
      { ...payload, refresh_token: 3 },
      { ...payload, user: { id: "foreign" } },
    ].map((value) => [() => response(JSON.stringify(value)), "shape_denied"]),
  ];
  for (const [make, category] of cases) {
    const f = fixture(async () => make());
    safe(await f.transport.exchangeOnce(input), category);
    assert.equal(f.calls.length, 1);
  }
  let cancelled = 0;
  const stream = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  const f = fixture(async () => response(stream, { headers: { "content-length": "131073" } }));
  safe(await f.transport.exchangeOnce(input), "body_denied");
  assert.equal(cancelled, 1);
});
test("overall deadline bounds a never-settling fetch and a stalled body with cancellation", async () => {
  // A fixed trusted synthetic clock makes preflight deterministic even when
  // parallel CI work delays this test; the real overall timer must still fire.
  const epoch = 1000;
  const f = fixture(() => new Promise(() => {}), { clock: () => epoch });
  const started = Date.now();
  safe(await f.transport.exchangeOnce(input, { deadlineMs: epoch + 15 }), "timeout");
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.calls.length, 1);
  let cancelled = 0;
  const g = fixture(
    async () =>
      response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
    { clock: () => epoch },
  );
  safe(await g.transport.exchangeOnce(input, { deadlineMs: epoch + 15 }), "timeout");
  assert.equal(cancelled, 1);
  assert.equal(g.calls.length, 1);
});
test("in-flight cancellation is bounded and hostile thrown errors are never inspected", async () => {
  const abort = new AbortController(),
    f = fixture(() => new Promise(() => {}));
  const pending = f.transport.exchangeOnce(input, { signal: abort.signal });
  abort.abort();
  safe(await pending, "cancelled");
  assert.equal(f.calls.length, 1);
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  const g = fixture(async () => {
    throw hostile;
  });
  safe(await g.transport.exchangeOnce(input), "transport_failed");
  assert.equal(traps, 0);
});
