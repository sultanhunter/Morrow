import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { mock } from "node:test";
import {
  challengeBudgetMs,
  createAbuseGuard,
  ipv6LimiterPrefixBits,
  limiterKey,
  limiterSubject,
} from "../apps/api/src/abuse-guard.ts";
import { createBrokerChallengeVerifier } from "../apps/api/src/broker-client.ts";
import { challengeLimits } from "../packages/identity/src/broker-protocol.ts";
import {
  createWorkersManagedWorkspaceApi,
  managedApiRoute,
} from "../packages/identity/src/managed-workspace-api.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

// P05.T01ab-AC01, AC02, AC04, AC05, AC09 and AC10 over the guard with fake limiters,
// a fake verifier and a recording router. No network, database or Worker runtime.
const origin = "https://workspace.example.test";
const siteKey = "0x4AAAAAAA" + randomBytes(12).toString("hex");
const actions = { login: "account_login", signup: "organization_signup" };
const challenge = { schemaVersion: 1, provider: "turnstile", siteKey, actions };
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));

function harness({ limiters = "allow", verifier = "passed", configured = true } = {}) {
  const calls = [];
  const limiter = (name) => ({
    async limit(options) {
      calls.push(["limit", name, options]);
      if (typeof limiters === "function") return limiters(name, options);
      return { success: limiters === "allow" };
    },
  });
  const verify = async (action, token, budgetMs, signal) => {
    calls.push(["verify", action, token, budgetMs, signal instanceof AbortSignal]);
    if (typeof verifier === "function") return verifier(action, token);
    return verifier;
  };
  const guard = createAbuseGuard(
    {
      challenge: configured ? challenge : null,
      limiters:
        limiters === null
          ? null
          : {
              loginStart: limiter("loginStart"),
              loginCallback: limiter("loginCallback"),
              signup: limiter("signup"),
            },
    },
    verify,
  );
  const forwarded = [];
  const next = async (request) => {
    calls.push(["next", request.method, new URL(request.url).pathname]);
    forwarded.push(request);
    return new Response("routed", { status: 299 });
  };
  const send = (request) => guard.handle(request, next);
  return { guard, calls, forwarded, send };
}
const token = () => "tok." + randomBytes(32).toString("base64url");
// A POST carries X-Morrow-Request: 1, as the SPA's does, unless `morrowRequest` is false.
const request = (path, { method = "POST", headers = {}, body, morrowRequest = true } = {}) =>
  new Request(origin + path, {
    method,
    headers: {
      "CF-Connecting-IP": "198.51.100.7",
      ...(method === "POST" && morrowRequest ? { "X-Morrow-Request": "1" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body } : method === "POST" ? { body: "{}" } : {}),
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
const bodyOf = async (response) => ({
  status: response.status,
  body: await response.text(),
  headers: Object.fromEntries(response.headers),
});
const guardEvents = () =>
  logs.map((line) => JSON.parse(line)).filter((row) => row.event === "morrow_edge_guard");
const standardHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// A body that counts its pulls and only produces bytes when asked.
const countedBody = () => {
  const counter = { pulls: 0 };
  const stream = new ReadableStream(
    {
      pull(controller) {
        counter.pulls++;
        controller.enqueue(new TextEncoder().encode('{"schemaVersion":2}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { counter, stream };
};
// Every Body-mixin read; the guard must call none of them.
const bodyReads = ["text", "json", "arrayBuffer", "blob", "formData", "bytes"];
function watchBodyReads() {
  const seen = [];
  const saved = bodyReads.map((name) => [name, Request.prototype[name]]);
  for (const [name, original] of saved)
    Request.prototype[name] = function (...args) {
      seen.push(name);
      return original.apply(this, args);
    };
  return { seen, restore: () => saved.forEach(([name, fn]) => (Request.prototype[name] = fn)) };
}

test("P05.T01ab-AC01: limiter, then challenge, then the router; the guard reads no body", async () => {
  const { calls, forwarded, send } = harness();
  const { stream } = countedBody();
  const supplied = token();
  const watch = watchBodyReads();
  let response;
  try {
    response = await send(
      request("/auth/login", {
        headers: {
          "X-Morrow-Challenge": supplied,
          Origin: origin,
          "X-Morrow-Request": "1",
          "Content-Type": "application/json",
        },
        body: stream,
      }),
    );
  } finally {
    watch.restore();
  }
  assert.equal(response.status, 299);
  assert.deepEqual(watch.seen, [], "no Body read before the router");
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["limit", "verify", "next"],
  );
  assert.deepEqual(calls[1], ["verify", actions.login, supplied, challengeBudgetMs, true]);
  // AC06: the forwarded request is the original minus X-Morrow-Challenge, with the
  // original body stream (Node's Request copy pipes it; workerd transfers it).
  const [routed] = forwarded;
  assert.equal(routed.method, "POST");
  assert.equal(routed.url, origin + "/auth/login");
  assert.equal(routed.headers.has("x-morrow-challenge"), false);
  assert.equal(routed.headers.get("origin"), origin);
  assert.equal(routed.headers.get("x-morrow-request"), "1");
  assert.equal(routed.headers.get("cf-connecting-ip"), "198.51.100.7");
  assert.equal(await routed.text(), '{"schemaVersion":2}');
});

test("P05.T01ab-AC01: a rejected request's body is never pulled", async () => {
  for (const [options, status] of [
    [{}, 403],
    [{ morrowRequest: false }, 403],
    [{ limiters: "deny" }, 429],
    [{ verifier: "failed" }, 403],
    [{ verifier: () => Promise.reject(Error("held")) }, 503],
  ]) {
    const { counter, stream } = countedBody();
    const sent = request("/organizations", {
      headers: options.limiters || options.verifier ? { "X-Morrow-Challenge": token() } : {},
      body: stream,
      morrowRequest: options.morrowRequest ?? true,
    });
    const { calls, send } = harness(options);
    assert.equal((await send(sent)).status, status);
    assert.equal(counter.pulls, 0, String(status));
    assert.equal(sent.bodyUsed, false);
    assert.equal(
      calls.some((call) => call[0] === "next"),
      false,
    );
  }
});

test("P05.T01ab-AC01: the guard and the router agree on the edge paths", async () => {
  // [path, method, expected route class, guarded limiter or null]
  const cases = [
    ["/auth/login", "POST", "login_start", "loginStart"],
    ["/auth/login?x=1", "POST", "login_start", "loginStart"],
    ["/auth/login/", "POST", "auth", null],
    ["/auth/%6Cogin", "POST", "auth", null],
    ["/auth/LOGIN", "POST", "auth", null],
    ["/auth//login", "POST", "auth", null],
    // Another method is the route's, but never counted: the router's own 405.
    ["/auth/login", "GET", "login_start", null],
    ["/auth/workos/callback?code=a&state=b", "GET", "login_callback", "loginCallback"],
    ["/auth/workos/callback", "HEAD", "login_callback", null],
    ["/organizations", "OPTIONS", "signup", null],
    ["/auth/workos/callback/", "GET", "auth", null],
    ["/auth/workos/%63allback", "GET", "auth", null],
    ["/organizations", "POST", "signup", "signup"],
    ["/organizations?x=1", "POST", "signup", "signup"],
    ["/organizations/", "POST", "not_found", null],
    ["/%6Frganizations", "POST", "not_found", null],
    ["/auth/logout", "POST", "logout", null],
    // P05.T01y's rotation is the workspace handler's, like logout, and never guarded.
    ["/auth/rotate", "POST", "rotate", null],
    ["/auth/rotate/", "POST", "auth", null],
    ["/auth/challenge", "GET", "challenge", null],
    ["/workspaces", "GET", "workspace", null],
    ["/workspace/w1/bootstrap", "GET", "workspace", null],
    ["/healthz", "GET", "not_found", null],
  ];
  // The unconfigured router's answer by family: 503 auth, 401 workspace, 404 other.
  // Every POST carries X-Morrow-Request, so only the path and method decide.
  const router = createWorkersManagedWorkspaceApi();
  const family = { 503: "auth", 401: "workspace", 404: "not_found" };
  for (const [path, method, route, limiter] of cases) {
    const url = new URL(origin + path);
    assert.equal(managedApiRoute(url.pathname), route, path);
    const routed = await router.fetch(new Request(url, { method }), {}, { waitUntil() {} });
    assert.equal(
      family[routed.status],
      ["signup", "workspace"].includes(route)
        ? "workspace"
        : route === "not_found"
          ? "not_found"
          : "auth",
      path,
    );
    const { calls, send } = harness({ configured: false });
    await send(request(path, { method, ...(method === "POST" ? {} : { body: undefined }) }));
    const limited = calls.filter((call) => call[0] === "limit").map((call) => call[1]);
    assert.deepEqual(limited, limiter ? [limiter] : [], path + " " + method);
    assert.equal(calls.at(-1)[0], "next", path);
  }
});

test("P05.T01ab-AC01: the callback is only rate-limited; another method is neither counted nor challenged", async () => {
  for (const [path, method, expected] of [
    ["/auth/workos/callback?code=a&state=b", "GET", ["limit", "next"]],
    ["/auth/workos/callback", "HEAD", ["next"]],
    ["/auth/workos/callback", "POST", ["next"]],
    ["/auth/workos/callback", "OPTIONS", ["next"]],
    ["/auth/login", "GET", ["next"]],
    ["/auth/login", "HEAD", ["next"]],
    ["/auth/login", "OPTIONS", ["next"]],
    ["/organizations", "PUT", ["next"]],
    ["/organizations", "OPTIONS", ["next"]],
  ]) {
    // Even with every bucket empty, another method reaches the router's own 405.
    for (const limiters of ["allow", "deny"]) {
      const { calls, send } = harness({ verifier: "failed", limiters });
      const response = await send(
        request(path, {
          method,
          ...(["GET", "HEAD", "OPTIONS"].includes(method) ? { body: undefined } : {}),
        }),
      );
      const want = expected[0] === "limit" && limiters === "deny" ? ["limit"] : expected;
      assert.equal(response.status, want.at(-1) === "next" ? 299 : 429, path + " " + method);
      assert.deepEqual(
        calls.map((call) => call[0]),
        want,
        path + " " + method,
      );
    }
  }
});

test("P05.T01ab-AC01: a request a cross-site page can send without a preflight is never counted", async () => {
  logs.length = 0;
  // A simple cross-site POST (no X-Morrow-Request, which needs a preflight): the
  // route's own 403, with no limit, verification, router or body read.
  for (const [path, body] of [
    ["/auth/login", '{"schemaVersion":1,"outcome":"login_unavailable"}'],
    ["/organizations", '{"code":"request_denied"}'],
  ])
    for (const headers of [
      { "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" },
      { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Mode": "navigate" },
      { "X-Morrow-Request": "0", "X-Morrow-Challenge": token() },
      { "X-Morrow-Challenge": token() },
    ])
      for (const limiters of ["allow", "deny"]) {
        const { counter, stream } = countedBody();
        const { calls, send } = harness({ limiters });
        const reply = await bodyOf(
          await send(request(path, { headers, body: stream, morrowRequest: false })),
        );
        assert.equal(reply.status, 403, path + " " + JSON.stringify(headers));
        assert.equal(reply.body, body);
        assert.deepEqual(reply.headers, standardHeaders);
        assert.deepEqual(calls, [], "no limit, verification or router");
        assert.equal(counter.pulls, 0);
      }
  // A callback GET that is no top-level document navigation (an <img>, a fetch, a
  // frame, a prefetch): the handler's own 303 to the result page, never counted.
  for (const headers of [
    { "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" },
    { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
    { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" },
    { "Sec-Fetch-Mode": "no-cors" },
    { "Sec-Fetch-Dest": "script" },
  ])
    for (const limiters of ["allow", "deny"]) {
      const { calls, send } = harness({ limiters });
      const reply = await bodyOf(
        await send(
          request("/auth/workos/callback?code=a&state=b", {
            method: "GET",
            headers,
            body: undefined,
          }),
        ),
      );
      assert.equal(reply.status, 303, JSON.stringify(headers));
      assert.equal(reply.body, "");
      assert.deepEqual(reply.headers, {
        location: "/auth/result",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      assert.deepEqual(calls, []);
    }
  // A top-level navigation, or a client without Fetch Metadata, is counted.
  for (const headers of [
    { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Mode": "navigate" },
    { "Sec-Fetch-Dest": "document" },
    {},
  ]) {
    const { calls, send } = harness({ limiters: "deny" });
    const response = await send(
      request("/auth/workos/callback?code=a&state=b", { method: "GET", headers, body: undefined }),
    );
    assert.equal(response.status, 429, JSON.stringify(headers));
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["limit"],
    );
  }
  // None of these needs the address, so none fails closed or logs.
  const { calls, send } = harness();
  const bare = request("/auth/login", { morrowRequest: false });
  bare.headers.delete("cf-connecting-ip");
  assert.equal((await send(bare)).status, 403);
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, [], "uncounted refusals log nothing");
});

test("P05.T01ab-AC02: a missing or malformed header is 403 challenge_required with no verification", async () => {
  logs.length = 0;
  for (const path of ["/auth/login", "/organizations"])
    for (const value of [
      undefined,
      "",
      "a".repeat(2049),
      "a b",
      "a, b",
      "a+b",
      "a/b",
      "a=b",
      "toké",
    ]) {
      const { calls, send } = harness();
      const headers = value === undefined ? {} : { "X-Morrow-Challenge": value };
      // Node refuses only NUL, CR and LF in a header value, so every value here builds;
      // anything the guard throws fails the test.
      const reply = await bodyOf(await send(request(path, { headers })));
      assert.equal(reply.status, 403, path + " " + String(value).slice(0, 10));
      assert.equal(reply.body, '{"schemaVersion":1,"outcome":"challenge_required"}');
      assert.deepEqual(reply.headers, standardHeaders);
      assert.ok(validateCurrentDefinition("SignInGuardOutcome", JSON.parse(reply.body)));
      assert.deepEqual(
        calls.map((call) => call[0]),
        ["limit"],
      );
    }
  assert.deepEqual(logs, [], "rejections log nothing");
});

test("P05.T01ab-AC03 (guard): failed is 403 challenge_failed; signup verifies its own action", async () => {
  logs.length = 0;
  const { calls, send } = harness({ verifier: "failed" });
  const reply = await bodyOf(
    await send(request("/organizations", { headers: { "X-Morrow-Challenge": token() } })),
  );
  assert.equal(reply.status, 403);
  assert.equal(reply.body, '{"schemaVersion":1,"outcome":"challenge_failed"}');
  assert.equal(calls[1][1], actions.signup);
  assert.equal(
    calls.some((call) => call[0] === "next"),
    false,
  );
  assert.deepEqual(logs, []);
});

test("P05.T01ab-AC04: a held or late verification is 503 with the route's existing body", async () => {
  logs.length = 0;
  for (const [path, body] of [
    ["/auth/login", '{"schemaVersion":1,"outcome":"login_unavailable"}'],
    ["/organizations", '{"code":"unavailable"}'],
  ]) {
    for (const verifier of [
      () => Promise.reject(Error("API_BROKER_HELD")),
      () => "maybe",
      () => undefined,
    ]) {
      const { calls, send } = harness({ verifier });
      const reply = await bodyOf(
        await send(request(path, { headers: { "X-Morrow-Challenge": token() } })),
      );
      // Anything but a verdict is held, never a pass and never a 403.
      assert.equal(reply.status, 503, path);
      assert.equal(reply.body, body);
      assert.deepEqual(reply.headers, standardHeaders);
      assert.equal(
        calls.some((call) => call[0] === "next"),
        false,
      );
    }
  }
  assert.deepEqual(
    guardEvents(),
    Array(6).fill({ event: "morrow_edge_guard", code: "CHALLENGE_HELD" }),
  );
});

test("P05.T01ab-AC04: through the broker adapter, a silent broker is held within the budget", async () => {
  let rpcs = 0;
  const silent = { challengeVerify: () => (rpcs++, new Promise(() => {})) };
  const verify = createBrokerChallengeVerifier(silent);
  // Mocked timers, so the bound is exact on any host load: held at the budget plus the
  // 250 ms RPC allowance, not one millisecond before.
  mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  let pending;
  try {
    pending = verify(actions.login, token(), 100, new AbortController().signal);
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(349);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "still waiting at 349 ms");
    mock.timers.tick(1);
  } finally {
    mock.timers.reset();
  }
  await assert.rejects(pending, /API_BROKER_HELD/);
  assert.equal(rpcs, 1, "exactly one RPC, no retry");
  for (const answer of ["passed", "failed"])
    assert.equal(
      await createBrokerChallengeVerifier({ challengeVerify: async () => answer })(
        actions.login,
        token(),
        1000,
        new AbortController().signal,
      ),
      answer,
    );
  for (const answer of ["PASSED", true, null, { verdict: "passed" }])
    await assert.rejects(
      createBrokerChallengeVerifier({ challengeVerify: async () => answer })(
        actions.login,
        token(),
        1000,
        new AbortController().signal,
      ),
      /API_BROKER_HELD/,
    );
  let sent = 0;
  const counting = { challengeVerify: async () => (sent++, "passed") };
  for (const [action, value, budget] of [
    [actions.login, "", 1000],
    [actions.login, "a b", 1000],
    [actions.login, token(), 0],
    [actions.login, token(), challengeLimits.budgetMaxMs + 1],
    [1, token(), 1000],
  ])
    await assert.rejects(
      createBrokerChallengeVerifier(counting)(action, value, budget, new AbortController().signal),
      /API_BROKER_HELD/,
    );
  assert.equal(sent, 0);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    createBrokerChallengeVerifier(counting)(actions.login, token(), 1000, aborted.signal),
    /API_BROKER_HELD/,
  );
  assert.ok(challengeBudgetMs >= 1 && challengeBudgetMs <= challengeLimits.budgetMaxMs);
});

test("P05.T01ab-AC05: over the limit is 429 rate_limited with Retry-After: 60 on every guarded route", async () => {
  logs.length = 0;
  for (const [path, method] of [
    ["/auth/login", "POST"],
    ["/auth/workos/callback", "GET"],
    ["/organizations", "POST"],
  ]) {
    const { calls, send } = harness({ limiters: "deny" });
    const reply = await bodyOf(
      await send(
        request(path, {
          method,
          headers: { "X-Morrow-Challenge": token() },
          ...(method === "POST" ? {} : { body: undefined }),
        }),
      ),
    );
    assert.equal(reply.status, 429, path + " " + method);
    assert.equal(reply.body, '{"schemaVersion":1,"outcome":"rate_limited"}');
    assert.deepEqual(reply.headers, { ...standardHeaders, "retry-after": "60" });
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["limit"],
    );
  }
  assert.ok(
    validateCurrentDefinition("SignInGuardOutcome", { schemaVersion: 1, outcome: "rate_limited" }),
  );
  assert.deepEqual(logs, [], "a 429 logs nothing");
});

test("P05.T01ab-AC05: keys are route plus 32 hex of SHA-256; IPv6 is keyed by its /56", async () => {
  assert.equal(ipv6LimiterPrefixBits, 56);
  const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);
  assert.equal(
    await limiterKey("login", "ipv4:198.51.100.7"),
    "login:" + digest("ipv4:198.51.100.7"),
  );
  const subject = (value) => limiterSubject(value);
  assert.equal(subject("198.51.100.7"), "ipv4:198.51.100.7");
  assert.equal(subject("::ffff:198.51.100.7"), "ipv4:198.51.100.7");
  assert.equal(subject("::ffff:c633:6407"), "ipv4:198.51.100.7");
  const site = subject("2001:db8:1234:5600::1");
  assert.equal(site, "ipv6/56:20010db8123456");
  for (const same of [
    "2001:db8:1234:56ff:ffff:ffff:ffff:ffff",
    "2001:0DB8:1234:5600:0:0:0:0",
    "2001:db8:1234:5642::abcd",
    "2001:db8:1234:5600::198.51.100.7",
  ])
    assert.equal(subject(same), site, same);
  for (const other of ["2001:db8:1234:5700::1", "2001:db8:1235:5600::1", "::1", "::"])
    assert.notEqual(subject(other), site, other);
  for (const invalid of [
    "",
    "198.51.100",
    "198.51.100.256",
    "198.051.100.7",
    "2001:db8::1::2",
    "2001:db8:1:2:3:4:5:6:7",
    "fe80::1%eth0",
    "[2001:db8::1]",
    "2001:db8::g",
    "unknown",
    "198.51.100.7, 203.0.113.9",
  ])
    assert.equal(subject(invalid), null, invalid);
  // The limiter sees only the derived key, never the address.
  const seen = [];
  const { send } = harness({
    limiters: (_name, options) => (seen.push(options), { success: true }),
  });
  for (const address of ["2001:db8:1234:5600::1", "2001:db8:1234:56ff::2", "203.0.113.9"])
    await send(
      request("/auth/workos/callback", {
        method: "GET",
        headers: { "CF-Connecting-IP": address },
        body: undefined,
      }),
    );
  assert.deepEqual(
    seen.map((options) => Object.keys(options)),
    [["key"], ["key"], ["key"]],
  );
  assert.equal(seen[0].key, seen[1].key);
  assert.notEqual(seen[0].key, seen[2].key);
  assert.match(seen[0].key, /^callback:[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(seen).includes("2001") && !JSON.stringify(seen).includes("203.0"));
});

test("P05.T01ab-AC05/AC10: a missing or invalid address or a failing limiter fails closed with one line", async () => {
  logs.length = 0;
  const address = "203.0.113.77";
  const cases = [
    [{ "CF-Connecting-IP": undefined }, "allow", "ADDRESS_MISSING"],
    [{ "CF-Connecting-IP": "not-an-address" }, "allow", "ADDRESS_INVALID"],
    [{}, () => Promise.reject(Error(address)), "LIMITER_FAILED"],
    [{}, () => ({ success: "yes" }), "LIMITER_FAILED"],
    [{}, () => null, "LIMITER_FAILED"],
    [
      {},
      () => {
        throw Error(address);
      },
      "LIMITER_FAILED",
    ],
  ];
  for (const [path, body] of [
    ["/auth/login", '{"schemaVersion":1,"outcome":"login_unavailable"}'],
    ["/auth/workos/callback", '{"schemaVersion":1,"outcome":"login_unavailable"}'],
    ["/organizations", '{"code":"unavailable"}'],
  ])
    for (const [headers, limiters, code] of cases) {
      logs.length = 0;
      const { calls, send } = harness({ limiters });
      const built = request(path, {
        method: path.includes("callback") ? "GET" : "POST",
        headers: { "X-Morrow-Challenge": token(), "CF-Connecting-IP": address, ...headers },
        ...(path.includes("callback") ? { body: undefined } : {}),
      });
      if (headers["CF-Connecting-IP"] === undefined && "CF-Connecting-IP" in headers)
        built.headers.delete("cf-connecting-ip");
      const reply = await bodyOf(await send(built));
      assert.equal(reply.status, 503, path + " " + code);
      assert.equal(reply.body, body);
      assert.equal(
        calls.some((call) => call[0] === "verify" || call[0] === "next"),
        false,
      );
      assert.deepEqual(guardEvents(), [{ event: "morrow_edge_guard", code }]);
      assert.ok(!logs.join("").includes(address) && !logs.join("").includes("not-an-address"));
    }
});

test("P05.T01ab-AC09: GET /auth/challenge returns the exact configuration, no-store", async () => {
  const configured = harness().guard;
  const reply = await bodyOf(
    configured.configurationResponse(new Request(origin + "/auth/challenge")),
  );
  assert.equal(reply.status, 200);
  assert.equal(
    reply.body,
    JSON.stringify({ schemaVersion: 1, provider: "turnstile", siteKey, actions }),
  );
  assert.deepEqual(reply.headers, standardHeaders);
  assert.ok(validateCurrentDefinition("LoginChallengeConfiguration", JSON.parse(reply.body)));
  const head = await bodyOf(
    configured.configurationResponse(new Request(origin + "/auth/challenge", { method: "HEAD" })),
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  const post = await bodyOf(
    configured.configurationResponse(new Request(origin + "/auth/challenge", { method: "POST" })),
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  const none = await bodyOf(
    harness({ configured: false }).guard.configurationResponse(
      new Request(origin + "/auth/challenge"),
    ),
  );
  assert.equal(none.status, 200);
  assert.equal(none.body, '{"provider":"none"}');
  assert.ok(validateCurrentDefinition("LoginChallengeConfiguration", JSON.parse(none.body)));
  for (const invalid of [
    { provider: "none", schemaVersion: 1 },
    { schemaVersion: 1, provider: "turnstile", siteKey: "1x00000000000000000000AA", actions },
    { schemaVersion: 1, provider: "turnstile", siteKey, actions: { login: "a" } },
  ])
    assert.equal(validateCurrentDefinition("LoginChallengeConfiguration", invalid), false);
  for (const [value, valid] of [
    ["a._-Z9", true],
    ["a".repeat(2048), true],
    ["a".repeat(2049), false],
    ["a b", false],
    ["", false],
  ])
    assert.equal(validateCurrentDefinition("ChallengeToken", value), valid);
});

test("P05.T01ab: development without a guard passes every request through untouched", async () => {
  const { calls, forwarded, send } = harness({ limiters: null, configured: false });
  const sent = request("/auth/login", { headers: { "X-Morrow-Challenge": token() } });
  assert.equal((await send(sent)).status, 299);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["next"],
  );
  assert.equal(forwarded[0], sent, "the very same Request object");
  // Limiters without a challenge: rate-limited, never challenged.
  const limited = harness({ configured: false });
  assert.equal((await limited.send(request("/auth/login"))).status, 299);
  assert.deepEqual(
    limited.calls.map((call) => call[0]),
    ["limit", "next"],
  );
});
