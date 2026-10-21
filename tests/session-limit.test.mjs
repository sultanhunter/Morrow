import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import deployed from "../apps/api/src/deployed-worker.ts";
import { createSessionLimit, sessionLimitedRoutes } from "../apps/api/src/session-limit.ts";
import { workPath } from "../apps/api/src/worker.ts";
import { decodeLogout } from "../apps/workspace-web/src/http/identity-decoders.ts";
import { workOutcome } from "../apps/workspace-web/src/http/work-decoders.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { managedApiRoute } from "../packages/identity/src/managed-workspace-api.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";

// The session routes' per-address limit (apps/api/src/session-limit.ts; ADR-0019 item 8
// applied to them). Over a fake limiter and a recording router, then over the deployed
// composition (apps/api/src/deployed-worker.ts) with a broker whose lease is recorded and
// refused. No network, database or Worker runtime; lab:edge-workers runs the real bundle.
const origin = "https://workspace.example.test";
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));
const guardEvents = () =>
  logs.map((line) => JSON.parse(line)).filter((row) => row.event === "morrow_edge_guard");

// A canonical session secret: 32 random bytes in base64url, 43 characters.
const secret = () => randomBytes(32).toString("base64url");
const session = (value = secret()) => "__Host-morrow_session=" + value;
const standardHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const rateLimited = '{"schemaVersion":1,"outcome":"rate_limited"}';

function harness(limiter = "allow") {
  const calls = [];
  const fake = {
    async limit(options) {
      calls.push(["limit", options]);
      if (typeof limiter === "function") return limiter(options);
      return { success: limiter === "allow" };
    },
  };
  const limit = createSessionLimit(limiter === null ? null : fake);
  const forwarded = [];
  const next = async (request) => {
    calls.push(["next", request.method, new URL(request.url).pathname]);
    forwarded.push(request);
    return new Response("routed", { status: 299 });
  };
  return { calls, forwarded, send: (request) => limit.handle(request, next) };
}
const request = (
  path,
  { method = "GET", cookie = session(), address = "198.51.100.7", headers = {}, body } = {},
) =>
  new Request(origin + path, {
    method,
    headers: {
      ...(address === null ? {} : { "CF-Connecting-IP": address }),
      ...(cookie === null ? {} : { Cookie: cookie }),
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
const bodyOf = async (response) => ({
  status: response.status,
  body: await response.text(),
  headers: Object.fromEntries(response.headers),
});
// [path, method, counted]: the router's matcher decides, exact WHATWG pathnames.
const routeCases = [
  ["/workspaces", "GET", true],
  ["/workspaces?x=1", "GET", true],
  ["/workspace", "GET", true],
  ["/workspace/workspace_a/bootstrap", "GET", true],
  ["/workspace/workspace_a/bootstrap", "HEAD", true],
  ["/workspace/workspace_a/connections", "GET", true],
  ["/workspace/workspace_a/store-links/preview", "POST", true],
  ["/workspace/workspace_a/store-links", "POST", true],
  ["/workspace/workspace_a/work/goals", "GET", true],
  ["/workspace/workspace_a/work/goals", "POST", true],
  ["/workspace/workspace_a/work/goals", "PUT", true],
  ["/auth/logout", "POST", true],
  ["/auth/rotate", "POST", true],
  ["/workspaces/", "GET", false],
  ["/%77orkspaces", "GET", false],
  ["/auth/logout/", "POST", false],
  ["/auth/%72otate", "POST", false],
  // Signup is the abuse guard's (SIGNUP_LIMITER), never counted twice.
  ["/organizations", "POST", false],
  ["/auth/login", "POST", false],
  ["/auth/workos/callback", "GET", false],
  ["/auth/challenge", "GET", false],
  ["/auth/result", "GET", false],
  ["/api/x", "GET", false],
  ["/healthz", "GET", false],
  ["/", "GET", false],
];
const bodyFor = (method) => (["GET", "HEAD"].includes(method) ? undefined : "{}");

test("the session limit and the router agree on the session paths", async () => {
  assert.deepEqual([...sessionLimitedRoutes].sort(), ["logout", "rotate", "workspace"]);
  assert.ok(Object.isFrozen(sessionLimitedRoutes));
  for (const [path, method, counted] of routeCases) {
    const url = new URL(origin + path);
    assert.equal(sessionLimitedRoutes.includes(managedApiRoute(url.pathname)), counted, path);
    const { calls, forwarded, send } = harness();
    const sent = request(path, { method, body: bodyFor(method) });
    assert.equal((await send(sent)).status, 299, path);
    assert.deepEqual(
      calls.map((call) => call[0]),
      counted ? ["limit", "next"] : ["next"],
      path + " " + method,
    );
    assert.equal(forwarded[0], sent, "the very same Request object");
  }
  // The work API's own paths are a subset of the counted workspace paths.
  assert.ok(workPath.test("/workspace/workspace_a/work/goals"));
  assert.equal(managedApiRoute("/workspace/workspace_a/work/goals"), "workspace");
});

test("step 0: without exactly one canonical session cookie nothing is counted", async () => {
  logs.length = 0;
  const canonical = secret();
  const uncounted = [
    null,
    "",
    "theme=dark",
    session(canonical.slice(0, 42)),
    session(canonical.slice(0, 42) + "B"),
    session(canonical + "A"),
    session(canonical) + "; " + session(secret()),
    "__host-morrow_session=" + canonical,
    "__Host-morrow_login=" + canonical,
    session(canonical) + "; garbage",
    session(canonical) + "; a=" + "b".repeat(4096),
    session(canonical) + "; " + Array.from({ length: 32 }, (_, i) => "c" + i + "=1").join("; "),
    session(canonical) + "; d=é",
  ];
  for (const cookie of uncounted)
    for (const address of ["198.51.100.7", null, "not-an-address"]) {
      // Even with every bucket empty and no address, the router answers its own refusal.
      const { calls, forwarded, send } = harness("deny");
      const sent = request("/workspaces", { cookie, address });
      assert.equal((await send(sent)).status, 299, String(cookie).slice(0, 80));
      assert.deepEqual(calls, [["next", "GET", "/workspaces"]]);
      assert.equal(forwarded[0], sent);
    }
  assert.deepEqual(logs, [], "uncounted requests log nothing");
  // Other cookies beside exactly one canonical session cookie: counted.
  for (const cookie of [
    "theme=dark; " + session(canonical),
    session(canonical) + ";theme=dark",
    "__Host-morrow_login=" + secret() + "; " + session(canonical),
  ]) {
    const { calls, send } = harness("deny");
    assert.equal((await send(request("/workspaces", { cookie }))).status, 429, cookie);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["limit"],
    );
  }
});

test("a counted request: one key of session plus 32 hex, then the very same request", async () => {
  const seen = [];
  const { calls, forwarded, send } = harness((options) => (seen.push(options), { success: true }));
  // A POST's body is never read: the stream is pulled only by the router.
  const counter = { pulls: 0 };
  const stream = new ReadableStream(
    {
      pull(controller) {
        counter.pulls++;
        controller.enqueue(new TextEncoder().encode('{"schemaVersion":1}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const sent = request("/workspace/workspace_a/work/goals", { method: "POST", body: stream });
  assert.equal((await send(sent)).status, 299);
  assert.equal(forwarded[0], sent);
  assert.equal(counter.pulls, 0);
  assert.equal(sent.bodyUsed, false);
  for (const address of ["2001:db8:1234:5600::1", "2001:db8:1234:56ff::2", "203.0.113.9"])
    await send(request("/workspaces", { address }));
  const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);
  assert.deepEqual(seen[0], { key: "session:" + digest("ipv4:198.51.100.7") });
  assert.equal(seen[1].key, seen[2].key, "one IPv6 /56 is one bucket");
  assert.notEqual(seen[1].key, seen[3].key);
  assert.ok(seen.every((options) => /^session:[0-9a-f]{32}$/.test(options.key)));
  assert.ok(!JSON.stringify(seen).includes("2001") && !JSON.stringify(seen).includes("203.0"));
  assert.equal(calls.filter((call) => call[0] === "limit").length, 4);
});

// The work API's 429: its own ErrorEnvelope, code rate_limited, the read class on GET.
const workLimited = (method) => (reply) => {
  const value = JSON.parse(reply.body);
  return (
    validateCurrentDefinition("ErrorEnvelope", value) &&
    value.code === "rate_limited" &&
    value.retryClass === (method === "GET" ? "safe_read_retry" : "recheck_before_retry") &&
    value.retryAfterSeconds === 60 &&
    value.operationId === null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.correlationId,
    ) &&
    reply.headers["retry-after"] === "60" &&
    reply.headers["cache-control"] === "no-store" &&
    reply.headers["content-type"] === "application/json; charset=utf-8"
  );
};

test("over the limit: 429 rate_limited with Retry-After: 60, no router and no log", async () => {
  logs.length = 0;
  for (const [path, method, counted] of routeCases) {
    if (!counted) continue;
    const { calls, send } = harness("deny");
    const reply = await bodyOf(await send(request(path, { method, body: bodyFor(method) })));
    assert.equal(reply.status, 429, path + " " + method);
    if (workPath.test(new URL(origin + path).pathname))
      assert.ok(workLimited(method)(reply), path + " " + method + " " + reply.body);
    else {
      assert.equal(reply.body, rateLimited);
      assert.deepEqual(reply.headers, { ...standardHeaders, "retry-after": "60" });
    }
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["limit"],
    );
  }
  assert.ok(validateCurrentDefinition("SignInGuardOutcome", JSON.parse(rateLimited)));
  assert.deepEqual(logs, [], "a 429 logs nothing");
  // The SPA reads it as a hold on a work route and as nothing done on logout.
  const reply = (body) => ({
    kind: "response",
    status: 429,
    headers: new Headers({ "retry-after": "60" }),
    body,
  });
  for (const method of ["GET", "POST"]) {
    const { send } = harness("deny");
    const response = await send(
      request("/workspace/workspace_a/work/goals", { method, body: bodyFor(method) }),
    );
    assert.deepEqual(
      workOutcome(reply(await response.json()), method === "GET" ? "read" : "command", () => 1),
      { kind: "rate_limited", retryAfterSeconds: 60 },
    );
  }
  assert.deepEqual(decodeLogout(reply(JSON.parse(rateLimited))), {
    kind: "unavailable",
    offline: false,
  });
});

test("fail closed: no address, a bad address or a failed limiter is the route's 503 and one line", async () => {
  const address = "203.0.113.77";
  const causes = [
    [null, "allow", "ADDRESS_MISSING"],
    ["not-an-address", "allow", "ADDRESS_INVALID"],
    ["198.51.100.7, 203.0.113.9", "allow", "ADDRESS_INVALID"],
    [address, () => Promise.reject(Error(address)), "LIMITER_FAILED"],
    [
      address,
      () => {
        throw Error(address);
      },
      "LIMITER_FAILED",
    ],
    [address, () => ({ success: "yes" }), "LIMITER_FAILED"],
    [address, () => null, "LIMITER_FAILED"],
  ];
  const envelope = (retryClass) => (body) => {
    const value = JSON.parse(body);
    return (
      validateCurrentDefinition("ErrorEnvelope", value) &&
      value.code === "unavailable" &&
      value.retryClass === retryClass &&
      value.safeMessage === "Work is temporarily unavailable." &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value.correlationId,
      )
    );
  };
  const exact = (text) => (body) => body === text;
  const routes = [
    ["/workspaces", "GET", exact('{"code":"unavailable"}')],
    ["/workspace/workspace_a/bootstrap", "GET", exact('{"code":"unavailable"}')],
    ["/workspace/workspace_a/store-links/preview", "POST", exact('{"code":"unavailable"}')],
    ["/auth/logout", "POST", exact('{"schemaVersion":1,"outcome":"logout_unavailable"}')],
    ["/auth/rotate", "POST", exact('{"schemaVersion":1,"outcome":"rotation_unavailable"}')],
    ["/workspace/workspace_a/work/goals", "GET", envelope("safe_read_retry")],
    ["/workspace/workspace_a/work/goals", "POST", envelope("recheck_before_retry")],
  ];
  for (const [path, method, expected] of routes)
    for (const [from, limiter, code] of causes) {
      logs.length = 0;
      const { calls, send } = harness(limiter);
      const response = await send(request(path, { method, address: from, body: bodyFor(method) }));
      const reply = await bodyOf(response);
      assert.equal(reply.status, 503, path + " " + code);
      assert.ok(expected(reply.body), path + " " + reply.body);
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal(reply.headers["cache-control"], "no-store");
      assert.equal(reply.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(
        calls.some((call) => call[0] === "next"),
        false,
      );
      assert.deepEqual(guardEvents(), [{ event: "morrow_edge_guard", code }]);
      assert.ok(!logs.join("").includes("203.0.113") && !logs.join("").includes("not-an"));
    }
  // The SPA reads each as "unavailable", never as an unknown outcome.
  const reply = (status, body) => ({ kind: "response", status, headers: new Headers(), body });
  assert.deepEqual(decodeLogout(reply(503, { schemaVersion: 1, outcome: "logout_unavailable" })), {
    kind: "unavailable",
    offline: false,
  });
  for (const method of ["GET", "POST"]) {
    const { send } = harness(() => null);
    const response = await send(
      request("/workspace/workspace_a/work/goals", { method, body: bodyFor(method) }),
    );
    assert.deepEqual(
      workOutcome(
        reply(503, await response.json()),
        method === "GET" ? "read" : "command",
        () => 1,
      ),
      { kind: "unavailable", offline: false },
    );
  }
});

test("development without limiters forwards every session request untouched", async () => {
  const { calls, forwarded, send } = harness(null);
  const sent = request("/workspaces", { address: null });
  assert.equal((await send(sent)).status, 299);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["next"],
  );
  assert.equal(forwarded[0], sent);
});

// ---- The deployed composition: the limit runs before any broker lease or SQL ----------
const provider = createPlatformWorkosProviderOracle({ origin });
const login = JSON.parse(provider.configurationJson);
const auth = JSON.parse(login.authenticationBindingJson);
function deployedEnv(sessionLimiter) {
  const events = [];
  const limiter = (name, answer = () => ({ success: true })) =>
    Object.freeze({
      async limit(options) {
        events.push(["limit", name, options.key.split(":")[0]]);
        return answer();
      },
    });
  const env = {
    MORROW_ENVIRONMENT: "development",
    BROKER: Object.freeze({
      fetch() {},
      async health() {
        return true;
      },
      async neonLease() {
        events.push(["neonLease"]);
        throw Error("NO_DATABASE_IN_THIS_TEST");
      },
      workosSessionPage() {},
      challengeVerify() {},
    }),
    LOGIN_CONFIGURATION_JSON: JSON.stringify({ ...login, retentionTier: "development" }),
    WORKSPACE_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
    LOGOUT_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      protocol: "morrow-self-logout-v1",
      origin,
      providerId: "workos",
      environmentId: auth.environmentId,
      applicationId: auth.applicationId,
      clientId: auth.clientId,
      profileId: login.profileId,
    }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify({
      schemaVersion: 1,
      environment: "development",
      projectId: "morrow-session-limit-unit",
      branchId: "br-session-limit-unit",
      hostname: "ep-session-limit-unit.c-14.us-east-1.aws.neon.tech",
      database: "morrow",
    }),
    LOGIN_CAPSULE_KEYRING: JSON.stringify({
      schemaVersion: 1,
      purpose: "morrow.login.capsule/1",
      configurationDigest: "a".repeat(64),
      currentKeyId: "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      versions: [],
    }),
    LOGIN_START_LIMITER: limiter("loginStart"),
    LOGIN_CALLBACK_LIMITER: limiter("loginCallback"),
    SIGNUP_LIMITER: limiter("signup"),
    SESSION_LIMITER: limiter("session", sessionLimiter),
  };
  const ctx = { waitUntil() {} };
  let mapped = false;
  const fetch = async (path, init = {}) => {
    const sent = new Request(origin + path, {
      ...init,
      headers: { "CF-Connecting-IP": "198.51.100.40", ...init.headers },
    });
    // The first request maps the environment; Workers expose an empty process.env.
    const saved = process.env;
    if (!mapped) process.env = {};
    let pending;
    try {
      pending = deployed.fetch(sent, env, ctx);
    } finally {
      process.env = saved;
      mapped = true;
    }
    const response = await pending;
    return { status: response.status, body: await response.text() };
  };
  return { events, fetch };
}
const sessionCalls = (events) =>
  events.filter((event) => event[0] === "limit" && event[1] === "session").length;
const leases = (events) => events.filter((event) => event[0] === "neonLease").length;
const accountHeaders = { "X-Morrow-Request": "1", "Sec-Fetch-Site": "same-origin" };
const proofHeaders = {
  Origin: origin,
  "Content-Type": "application/json",
  "X-Morrow-Request": "1",
};

test("deployed: a request without a canonical session cookie is refused before any lease, uncounted", async () => {
  logs.length = 0;
  const { events, fetch } = deployedEnv(() => ({ success: false }));
  const requests = [
    ["/workspaces", { headers: accountHeaders }, 401],
    ["/workspace/workspace_a/bootstrap", {}, 401],
    ["/workspace/workspace_a/connections", {}, 401],
    ["/workspace/workspace_a/work/goals", {}, 401],
    ["/auth/rotate", { method: "POST", headers: proofHeaders, body: '{"schemaVersion":1}' }, 401],
    ["/auth/logout", { method: "POST", headers: proofHeaders, body: '{"schemaVersion":1}' }, 403],
  ];
  for (const cookie of [null, session(secret().slice(0, 42)), session() + "; " + session()])
    for (const [path, init, status] of requests) {
      const reply = await fetch(path, {
        ...init,
        headers: { ...init.headers, ...(cookie === null ? {} : { Cookie: cookie }) },
      });
      assert.equal(reply.status, status, path + " " + String(cookie).slice(0, 40));
    }
  assert.equal(sessionCalls(events), 0, "never counted, even with the bucket empty");
  assert.equal(leases(events), 0, "no broker lease, so no SQL");
  assert.deepEqual(guardEvents(), []);
});

test("deployed: a counted request is limited before the broker lease; 429 and 503 reach neither", async () => {
  // Allowed: counted first, then the router leases (refused here: 503).
  const allowed = deployedEnv();
  for (const path of ["/workspaces", "/workspace/workspace_a/work/goals"]) {
    const before = allowed.events.length;
    const reply = await allowed.fetch(path, {
      headers: { ...accountHeaders, Cookie: session() },
    });
    assert.equal(reply.status, 503, path);
    const order = allowed.events.slice(before).map((event) => event[1] ?? event[0]);
    assert.equal(order[0], "session", path + ": the limit comes first");
    assert.ok(order.includes("neonLease"), path + ": the counted request reached the lease");
  }
  // Over the limit: 429 and nothing else.
  const limited = deployedEnv(() => ({ success: false }));
  for (const [path, init] of [
    ["/workspaces", { headers: accountHeaders }],
    ["/workspace/workspace_a/work/goals", {}],
    ["/auth/logout", { method: "POST", headers: proofHeaders, body: '{"schemaVersion":1}' }],
    ["/auth/rotate", { method: "POST", headers: proofHeaders, body: '{"schemaVersion":1}' }],
  ]) {
    const reply = await limited.fetch(path, {
      ...init,
      headers: { ...init.headers, Cookie: session() },
    });
    assert.equal(reply.status, 429, path);
    if (path.includes("/work/")) assert.equal(JSON.parse(reply.body).code, "rate_limited");
    else assert.equal(reply.body, rateLimited);
  }
  assert.equal(sessionCalls(limited.events), 4);
  assert.equal(leases(limited.events), 0);
  // A failed limiter: the route's 503 and one line, no lease.
  logs.length = 0;
  const failed = deployedEnv(() => {
    throw Error("limiter down");
  });
  const reply = await failed.fetch("/workspaces", {
    headers: { ...accountHeaders, Cookie: session() },
  });
  assert.deepEqual(reply, { status: 503, body: '{"code":"unavailable"}' });
  assert.equal(leases(failed.events), 0);
  assert.deepEqual(guardEvents(), [{ event: "morrow_edge_guard", code: "LIMITER_FAILED" }]);
  // The sign-in routes keep their own limiters; signup never touches the session one.
  const signup = deployedEnv(() => ({ success: false }));
  await signup.fetch("/organizations", {
    method: "POST",
    headers: { ...proofHeaders, Cookie: session(), "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
  assert.equal(sessionCalls(signup.events), 0);
  assert.deepEqual(
    signup.events.filter((event) => event[0] === "limit").map((event) => event[1]),
    ["signup"],
  );
});
