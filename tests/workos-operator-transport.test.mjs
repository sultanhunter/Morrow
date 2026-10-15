import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createWorkosOperatorTransport,
  parseWorkosOperatorProfile,
  workosOperatorEnvironmentAllowed,
} from "../scripts/workos-operator-transport.mjs";
import { parseWorkosOperatorJson } from "../scripts/workos-operator-json.mjs";
import {
  buildWorkosSessionTokenFixture,
  createWorkosSessionTokenSigningKey,
} from "./fixtures/workos-session-token.mjs";
const profile = readFileSync("docs/decisions/workos-operator-qualification.json", "utf8"),
  p = JSON.parse(profile);
const sharedKey = createWorkosSessionTokenSigningKey("synthetic-operator-key");
const verifier = Buffer.alloc(32, 1).toString("base64url"),
  code = " exact e\u0301 😀\u0000 code ";
const input = JSON.stringify({ code, verifier });
function response(body, url, options = {}) {
  const r = new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
  Object.defineProperty(r, "url", { value: options.url ?? url });
  if (options.redirected) Object.defineProperty(r, "redirected", { value: true });
  return r;
}
function fixture(fetcher, options = {}) {
  const f = buildWorkosSessionTokenFixture({
    key: sharedKey,
    profile: {
      environmentId: p.environment_id,
      applicationId: p.application_id,
      clientId: p.client_id,
      issuer: p.issuer,
    },
  });
  const calls = [];
  let beforePosts = 0;
  const payload = {
    access_token: f.sign(),
    refresh_token: ["synthetic", "refresh", "fixture"].join("_"),
    user: { id: f.claims.sub, email: "private@example.test" },
  };
  const transport = createWorkosOperatorTransport(profile, {
    mode: "synthetic",
    clock: f.clock,
    fetch: async (...args) => {
      calls.push(args);
      return fetcher
        ? fetcher(...args, { f, payload, calls })
        : response(
            JSON.stringify(args[1].method === "GET" ? { keys: [f.publicJwk] } : payload),
            args[0],
          );
    },
    ...options,
  });
  return {
    f,
    payload,
    calls,
    transport,
    get beforePosts() {
      return beforePosts;
    },
    run: (control = {}, value = input) =>
      transport.exchangeOnce(value, {
        beforePost: async () => {
          beforePosts++;
          return true;
        },
        ...control,
      }),
  };
}
function safe(value, category, f) {
  assert.ok(Object.isFrozen(value));
  assert.deepEqual(Object.keys(value).sort(), [
    "category",
    "outcome",
    "providerSessionCleanup",
    "statusClass",
  ]);
  assert.equal(value.category, category);
  assert.equal(
    value.outcome,
    category === "cryptographically_verified_candidate" ? category : "held",
  );
  assert.equal(value.providerSessionCleanup, "unknown");
  const serialized = JSON.stringify(value);
  for (const privateValue of [
    code,
    verifier,
    f?.payload.access_token,
    f?.payload.refresh_token,
    f?.f.claims.sub,
    f?.f.claims.sid,
    "private@example.test",
  ].filter(Boolean))
    assert.ok(!serialized.includes(privateValue));
}
function counts(f, gets, posts) {
  assert.equal(f.calls.filter((call) => call[1].method === "GET").length, gets);
  assert.equal(f.calls.filter((call) => call[1].method === "POST").length, posts);
}
test("independent RSA fixture GET then recheck then exact keyless POST returns only cryptographic evidence", async () => {
  const events = [],
    f = fixture(async (url, init, { f, payload }) => {
      events.push(init.method);
      return response(
        JSON.stringify(init.method === "GET" ? { keys: [f.publicJwk] } : payload),
        url,
      );
    });
  const result = await f.run({
    beforePost: async () => {
      events.push("recheck");
      return true;
    },
  });
  safe(result, "cryptographically_verified_candidate", f);
  assert.deepEqual(events, ["GET", "recheck", "POST"]);
  counts(f, 1, 1);
  const [get, post] = f.calls;
  assert.equal(get[0], p.jwks_endpoint);
  assert.equal(post[0], p.token_endpoint);
  assert.deepEqual(get[1].headers, { accept: "application/json" });
  assert.equal(get[1].body, undefined);
  assert.deepEqual(post[1].headers, {
    "content-type": "application/json",
    accept: "application/json",
  });
  assert.deepEqual(JSON.parse(post[1].body), {
    client_id: p.client_id,
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });
  for (const [, init] of f.calls) {
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
  }
  safe(await f.run(), "already_used", f);
  counts(f, 1, 1);
});
test("synchronous single-use entry prevents concurrent GET or POST replay", async () => {
  let finish;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(async (url, init, { f, payload }) => {
    if (init.method === "GET") await wait;
    return response(JSON.stringify(init.method === "GET" ? { keys: [f.publicJwk] } : payload), url);
  });
  const pending = f.run();
  safe(await f.run(), "already_used", f);
  counts(f, 1, 0);
  finish();
  safe(await pending, "cryptographically_verified_candidate", f);
  counts(f, 1, 1);
});
test("profile/native configuration cannot widen endpoints, issuer, limits or inject native networking", () => {
  for (const change of [
    { plan_sequence: 71 },
    { jwks_endpoint: "https://foreign.example/keys" },
    { issuer: "https://api.workos.com" },
    { max_jwks_reads: 2 },
    { max_posts: 2 },
    { max_jwks_response_bytes: 65537 },
    { max_post_seconds: 16 },
    { client_id: "foreign" },
    { extra: true },
  ])
    assert.throws(
      () => parseWorkosOperatorProfile(JSON.stringify({ ...p, ...change })),
      /TRANSPORT_DENIED/,
    );
  assert.throws(
    () => createWorkosOperatorTransport(profile, { mode: "native", fetch: async () => {} }),
    /TRANSPORT_DENIED/,
  );
  assert.throws(
    () => createWorkosOperatorTransport(profile, { mode: "native", clock: () => 0 }),
    /TRANSPORT_DENIED/,
  );
  assert.throws(
    () => createWorkosOperatorTransport(profile, { mode: "synthetic" }),
    /TRANSPORT_DENIED/,
  );
  assert.throws(
    () =>
      createWorkosOperatorTransport(profile, {
        mode: "synthetic",
        fetch: async () => {},
        clock: 3,
      }),
    /TRANSPORT_DENIED/,
  );
  assert.throws(
    () =>
      parseWorkosOperatorProfile(
        profile.replace('"schema_version": 1', '"schema_version":1,"schema_version":1'),
      ),
    /TRANSPORT_DENIED/,
  );
});
test("private primitive JSON gates and mandatory beforePost reject before any GET", async () => {
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
  for (const value of [
    hostile,
    {},
    [],
    new String(input),
    null,
    "null",
    "[]",
    "{}",
    input + "x",
    input.replace('"code":', '"code":"first","code":'),
    JSON.stringify({ code: "\ud800", verifier }),
    JSON.stringify({ code: "x".repeat(4097), verifier }),
    JSON.stringify({ code, verifier: "wrong" }),
  ]) {
    const f = fixture();
    safe(await f.run({}, value), "input_denied", f);
    counts(f, 0, 0);
  }
  assert.equal(traps, 0);
  const f = fixture();
  safe(await f.transport.exchangeOnce(input), "before_post_denied", f);
  counts(f, 0, 0);
});
test("ambient keys, proxies and TLS/config overrides never fall back or fetch", async () => {
  for (const [key, value] of [
    ["WORKOS_API_KEY", "synthetic"],
    ["workos_CLIENT_ID", "synthetic"],
    ["HTTP_PROXY", "synthetic"],
    ["HTTPS_PROXY", "synthetic"],
    ["ALL_PROXY", "synthetic"],
    ["NO_PROXY", "synthetic"],
    ["NODE_USE_ENV_PROXY", "1"],
    ["NODE_EXTRA_CA_CERTS", "synthetic"],
    ["NODE_OPTIONS", "synthetic"],
    ["SSL_CERT_FILE", "synthetic"],
    ["SSL_CERT_DIR", "synthetic"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
  ]) {
    const original = process.env[key];
    process.env[key] = value;
    try {
      assert.equal(workosOperatorEnvironmentAllowed(), false);
      const f = fixture();
      safe(await f.run(), "configuration_denied", f);
      counts(f, 0, 0);
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
});
test("GET response guards deny foreign URLs, redirects and every non200 without a POST", async () => {
  for (const options of [
    { url: "https://foreign.example/keys" },
    { redirected: true },
    ...[201, 302, 400, 404, 429, 503].map((status) => ({ status })),
  ]) {
    const f = fixture(async (url, _init, { f }) =>
      response(JSON.stringify({ keys: [f.publicJwk] }), url, options),
    );
    safe(
      await f.run(),
      options.url || options.redirected ? "response_origin_denied" : "http_rejected",
      f,
    );
    counts(f, 1, 0);
    assert.equal(f.beforePosts, 0);
  }
});
test("GET content/body/strictJSON/private and ambiguous key failures are rejected before recheck/POST", async () => {
  const cases = [
    { body: "{}", headers: { "content-type": "text/plain" }, category: "content_denied" },
    { body: "{}", headers: { "content-length": "65537" }, category: "body_denied" },
    { body: "x".repeat(65537), category: "body_denied" },
    { body: new Uint8Array([255]), category: "shape_denied" },
    { body: new Uint8Array([0xef, 0xbb, 0xbf, 123, 125]), category: "shape_denied" },
    { body: '{"keys":[],"\\u006beys":[]}', category: "shape_denied" },
    { body: "{", category: "shape_denied" },
    { body: "null", category: "shape_denied" },
    { body: JSON.stringify({ keys: [] }), category: "shape_denied" },
    {
      body: JSON.stringify({ keys: [{ ...sharedKey.publicJwk, d: "private" }] }),
      category: "shape_denied",
    },
    {
      body: JSON.stringify({ keys: [sharedKey.publicJwk, sharedKey.publicJwk] }),
      category: "shape_denied",
    },
  ];
  for (const item of cases) {
    const f = fixture(async (url) => response(item.body, url, { headers: item.headers }));
    safe(await f.run(), item.category, f);
    counts(f, 1, 0);
    assert.equal(f.beforePosts, 0);
  }
});
test("observed certificate metadata is bounded and discarded without becoming a trust source", async () => {
  const certificate = Buffer.from(
    "synthetic encoding-only metadata, not a trusted certificate",
  ).toString("base64");
  const thumbprint = Buffer.alloc(32, 7).toString("base64url");
  for (const metadata of [
    { x5c: [certificate], "x5t#S256": thumbprint },
    { x5c: [certificate] },
    { "x5t#S256": thumbprint },
    { x5c: [Buffer.alloc(8192, 1).toString("base64"), Buffer.alloc(8192, 2).toString("base64")] },
    { x5c: Array.from({ length: 4 }, (_, i) => Buffer.alloc(4096, i).toString("base64")) },
  ]) {
    const f = fixture(async (url, init, { f, payload }) =>
      response(
        JSON.stringify(
          init.method === "GET" ? { keys: [{ ...f.publicJwk, ...metadata }] } : payload,
        ),
        url,
      ),
    );
    const result = await f.run();
    safe(result, "cryptographically_verified_candidate", f);
    assert.ok(!JSON.stringify(result).includes(certificate));
    assert.ok(!JSON.stringify(result).includes(thumbprint));
    counts(f, 1, 1);
  }
});
test("malformed, oversized or noncanonical certificate metadata denies before recheck or POST", async () => {
  const certificate = Buffer.from("synthetic metadata").toString("base64");
  const thumbprint = Buffer.alloc(32, 7).toString("base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonicalThumb =
    thumbprint.slice(0, -1) + alphabet[alphabet.indexOf(thumbprint.at(-1)) + 1];
  assert.deepEqual(
    Buffer.from(noncanonicalThumb, "base64url"),
    Buffer.from(thumbprint, "base64url"),
  );
  for (const metadata of [
    { x5c: null },
    { x5c: certificate },
    { x5c: [] },
    { x5c: [null] },
    { x5c: [3] },
    { x5c: [""] },
    { x5c: [certificate + "\n"] },
    { x5c: ["https://foreign.example/cert"] },
    { x5c: ["AA"] },
    { x5c: ["AB=="] },
    { x5c: ["__8="] },
    { x5c: Array(5).fill(certificate) },
    { x5c: [Buffer.alloc(8193).toString("base64")] },
    { x5c: [Buffer.alloc(8192).toString("base64"), Buffer.alloc(8192).toString("base64"), "AA=="] },
    { "x5t#S256": null },
    { "x5t#S256": [] },
    { "x5t#S256": "" },
    { "x5t#S256": thumbprint + "=" },
    { "x5t#S256": noncanonicalThumb },
    { "x5t#S256": Buffer.alloc(31).toString("base64url") },
  ]) {
    const f = fixture(async (url, _init, { f }) =>
      response(JSON.stringify({ keys: [{ ...f.publicJwk, ...metadata }] }), url),
    );
    safe(await f.run(), "shape_denied", f);
    counts(f, 1, 0);
    assert.equal(f.beforePosts, 0);
  }
});
test("certificate projection never drops unknown/private/URL fields or repairs invalid RSA values", async () => {
  const metadata = {
    x5c: [Buffer.from("synthetic").toString("base64")],
    "x5t#S256": Buffer.alloc(32, 3).toString("base64url"),
  };
  for (const change of [
    ...["d", "p", "q", "dp", "dq", "qi", "oth", "x5u", "jku", "jwk", "x5t", "unknown"].map(
      (name) => ({ [name]: "synthetic" }),
    ),
    { n: "AA" },
    { e: "Aw" },
    { alg: "HS256" },
    { use: "enc" },
    { key_ops: ["sign"] },
  ]) {
    const f = fixture(async (url, _init, { f }) =>
      response(JSON.stringify({ keys: [{ ...f.publicJwk, ...metadata, ...change }] }), url),
    );
    safe(await f.run(), "shape_denied", f);
    counts(f, 1, 0);
  }
  const unknownRoot = fixture(async (url, _init, { f }) =>
    response(JSON.stringify({ keys: [{ ...f.publicJwk, ...metadata }], extra: true }), url),
  );
  safe(await unknownRoot.run(), "shape_denied", unknownRoot);
  counts(unknownRoot, 1, 0);
  const otherKey = createWorkosSessionTokenSigningKey("other-public-key");
  for (const changedKey of [{ n: otherKey.publicJwk.n }, { kid: "different-selected-kid" }]) {
    const f = fixture(async (url, init, { f, payload }) =>
      response(
        JSON.stringify(
          init.method === "GET"
            ? { keys: [{ ...f.publicJwk, ...metadata, ...changedKey }] }
            : payload,
        ),
        url,
      ),
    );
    safe(await f.run(), "token_denied", f);
    counts(f, 1, 1);
  }
});
test("escaped duplicate certificate metadata is rejected before projection", async () => {
  const certificate = Buffer.from("synthetic").toString("base64"),
    thumbprint = Buffer.alloc(32, 3).toString("base64url");
  for (const field of ["x5c", "x5t#S256"]) {
    const f = fixture(async (url, _init, { f }) => {
      const raw = JSON.stringify({
        keys: [{ ...f.publicJwk, x5c: [certificate], "x5t#S256": thumbprint }],
      });
      const duplicate =
        field === "x5c"
          ? raw.replace('"x5c":', '"\\u00785c":[],"x5c":')
          : raw.replace('"x5t#S256":', '"x5t\\u0023S256":"unused","x5t#S256":');
      return response(duplicate, url);
    });
    safe(await f.run(), "shape_denied", f);
    counts(f, 1, 0);
    assert.equal(f.beforePosts, 0);
  }
});
test("postGET trusted recheck is required once and false/throw cannot POST", async () => {
  for (const beforePost of [
    async () => false,
    async () => undefined,
    async () => ({ allowed: true }),
    async () => {
      throw Error("private_recheck");
    },
  ]) {
    const f = fixture();
    safe(await f.run({ beforePost }), "before_post_denied", f);
    counts(f, 1, 0);
  }
});
test("postGET recheck cancellation, TLS, deadline and clock regression are rechecked before POST", async () => {
  for (const mode of ["abort", "tls", "deadline", "regression"]) {
    const f = fixture(),
      aborter = new AbortController(),
      original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      const result = await f.run({
        signal: aborter.signal,
        beforePost: async () => {
          if (mode === "abort") aborter.abort();
          if (mode === "tls") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
          if (mode === "deadline") f.f.setNow(f.f.now + 15000);
          if (mode === "regression") f.f.setNow(f.f.now - 1);
          return true;
        },
      });
      safe(
        result,
        mode === "abort" ? "cancelled" : mode === "deadline" ? "timeout" : "configuration_denied",
        f,
      );
      counts(f, 1, 0);
    } finally {
      if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
    }
  }
});
test("clock-side environment changes after the trusted recheck still deny before POST", async () => {
  let changed = false,
    f;
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    f = fixture(undefined, {
      clock: () => {
        if (changed) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        return f.f.now;
      },
    });
    safe(
      await f.run({
        beforePost: async () => {
          changed = true;
          return true;
        },
      }),
      "configuration_denied",
      f,
    );
    counts(f, 1, 0);
  } finally {
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
  }
});
test("a late beforePost completion cannot send after the overall timer returned timeout", async () => {
  let finish;
  const wait = new Promise((resolve) => {
      finish = resolve;
    }),
    f = fixture();
  safe(await f.run({ deadlineMs: f.f.now + 15, beforePost: () => wait }), "timeout", f);
  counts(f, 1, 0);
  finish(true);
  await new Promise((resolve) => setImmediate(resolve));
  counts(f, 1, 0);
});
test("POST response must be fixed-origin exact200 strict bounded JSON, never a second exchange", async () => {
  const cases = [
    { url: "https://foreign.example/token", category: "response_origin_denied" },
    { redirected: true, category: "response_origin_denied" },
    ...[201, 302, 400, 429, 503].map((status) => ({ status, category: "http_rejected" })),
    { headers: { "content-type": "text/plain" }, category: "content_denied" },
    { headers: { "content-length": "131073" }, category: "body_denied" },
    { body: "x".repeat(131073), category: "body_denied" },
    { body: new Uint8Array([255]), category: "shape_denied" },
    { body: '{"access_token":"x","\\u0061ccess_token":"y"}', category: "shape_denied" },
    { body: "{}", category: "shape_denied" },
    { body: "null", category: "shape_denied" },
  ];
  for (const item of cases) {
    const f = fixture(async (url, init, { f, payload }) =>
      response(
        init.method === "GET"
          ? JSON.stringify({ keys: [f.publicJwk] })
          : (item.body ?? JSON.stringify(payload)),
        url,
        init.method === "GET" ? {} : item,
      ),
    );
    safe(await f.run(), item.category, f);
    counts(f, 1, 1);
    safe(await f.run(), "already_used", f);
    counts(f, 1, 1);
  }
});
test("signed token/profile/time/class failures and unsigned user mixup cannot become evidence", async () => {
  for (const change of [
    { iss: "https://api.workos.com" },
    { client_id: "client_" + "X".repeat(26) },
    { aud: p.client_id },
    { act: null },
    { sub_profile: "ai_agent" },
    { exp: -1 },
    { iat: 1, exp: 3602 },
  ]) {
    const f = fixture(async (url, init, { f, payload }) =>
      response(
        JSON.stringify(
          init.method === "GET"
            ? { keys: [f.publicJwk] }
            : { ...payload, access_token: f.sign(change) },
        ),
        url,
      ),
    );
    safe(await f.run(), "token_denied", f);
    counts(f, 1, 1);
  }
  const f = fixture(async (url, init, { f, payload }) =>
    response(
      JSON.stringify(
        init.method === "GET"
          ? { keys: [f.publicJwk] }
          : { ...payload, user: { id: "user_" + "X".repeat(26) } },
      ),
      url,
    ),
  );
  safe(await f.run(), "token_denied", f);
  counts(f, 1, 1);
});
test("unknown kid, altered signature and malformed token strings stay held after one POST", async () => {
  for (const mode of ["unknown", "corrupt", "malformed"]) {
    const f = fixture(async (url, init, { f, payload }) => {
      let token = mode === "unknown" ? f.sign({}, { kid: "unknown" }) : f.sign();
      if (mode === "corrupt") {
        const parts = token.split("."),
          sig = Buffer.from(parts[2], "base64url");
        sig[0] ^= 1;
        token = parts.slice(0, 2).join(".") + "." + sig.toString("base64url");
      }
      if (mode === "malformed") token = "malformed";
      return response(
        JSON.stringify(
          init.method === "GET" ? { keys: [f.publicJwk] } : { ...payload, access_token: token },
        ),
        url,
      );
    });
    safe(await f.run(), "token_denied", f);
    counts(f, 1, 1);
  }
});
test("one real overall timer bounds stalled GET, beforePost, POST and body cancellation", async () => {
  for (const stage of ["get_fetch", "get_body", "post_fetch", "post_body"]) {
    let cancelled = 0;
    const f = fixture(async (url, init, { f, payload }) => {
      const isStage =
        (stage.startsWith("get") && init.method === "GET") ||
        (stage.startsWith("post") && init.method === "POST");
      if (isStage && stage.endsWith("fetch")) return new Promise(() => {});
      if (isStage)
        return response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          url,
        );
      return response(
        JSON.stringify(init.method === "GET" ? { keys: [f.publicJwk] } : payload),
        url,
      );
    });
    const start = Date.now();
    safe(await f.run({ deadlineMs: f.f.now + 15 }), "timeout", f);
    assert.ok(Date.now() - start < 1000);
    counts(f, 1, stage.startsWith("post") ? 1 : 0);
    if (stage.endsWith("body")) assert.equal(cancelled, 1);
  }
});
test("late GET and POST responses are canceled locally after the outer timeout already returned", async () => {
  for (const stage of ["GET", "POST"]) {
    let release,
      cancelled = 0;
    const delayed = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture(async (url, init, { f, payload }) => {
      if (init.method === stage) return delayed;
      return response(
        JSON.stringify(init.method === "GET" ? { keys: [f.publicJwk] } : payload),
        url,
      );
    });
    safe(await f.run({ deadlineMs: f.f.now + 15 }), "timeout", f);
    counts(f, 1, stage === "POST" ? 1 : 0);
    const body = new ReadableStream({
      cancel() {
        cancelled++;
      },
    });
    release(response(body, stage === "GET" ? p.jwks_endpoint : p.token_endpoint));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
    counts(f, 1, stage === "POST" ? 1 : 0);
    safe(await f.run(), "already_used", f);
  }
});
test("preflight cancellation/deadline and hostile provider errors expose no details or getter effects", async () => {
  const abort = new AbortController();
  abort.abort();
  const a = fixture();
  safe(await a.run({ signal: abort.signal }), "cancelled", a);
  counts(a, 0, 0);
  const b = fixture();
  safe(await b.run({ deadlineMs: b.f.now }), "timeout", b);
  counts(b, 0, 0);
  let traps = 0;
  const error = new Proxy(
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
  const c = fixture(async () => {
    throw error;
  });
  safe(await c.run(), "transport_failed", c);
  assert.equal(traps, 0);
  counts(c, 1, 0);
});
test("bounded unique JSON preserves opaque strings and rejects escaped duplicate keys at every depth", () => {
  assert.deepEqual(parseWorkosOperatorJson('{"code":" e\\u0301 😀 ","nested":[{"x":1}]}', 1000), {
    code: " e\u0301 😀 ",
    nested: [{ x: 1 }],
  });
  for (const text of [
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"a":[{"x":1,"x":2}]}',
    '{"x":"\\ud800"}',
    "\ufeff{}",
    '{"x":01}',
    "{}{}",
    "[1,]",
    '["' + "x".repeat(1000) + '"]',
    "[".repeat(34) + "0" + "]".repeat(34),
  ])
    assert.throws(
      () => parseWorkosOperatorJson(text, 1000),
      /^Error: WORKOS_OPERATOR_JSON_INVALID$/,
    );
  assert.throws(() => parseWorkosOperatorJson('"😀"', 5), /JSON_INVALID/);
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
    },
  );
  for (const value of [proxy, {}, [], new String("{}"), null])
    assert.throws(() => parseWorkosOperatorJson(value, 1000), /JSON_INVALID/);
  assert.equal(traps, 0);
});
