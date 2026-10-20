import test from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  isCommandKey,
  newCommandKey,
} from "../apps/workspace-web/src/http/client.ts";
import { byteLimits, createHttpPort, requests } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  createLoginAttempt,
  loginStartInput,
} from "../packages/identity/src/standalone-login-protocol.ts";
import { json, recordingTransport } from "./fixtures/workspace-web.mjs";

// P14.T01a AC05 (sign-in request), AC08 (request discipline) and the §4.2 composed
// table, on a fake fetch. No browser and no network.
const authorize =
  "https://api.workos.com/user_management/authorize?client_id=client_x&redirect_uri=https%3A%2F%2Fw.test%2Fauth%2Fworkos%2Fcallback&response_type=code&provider=authkit&state=s&code_challenge=c&code_challenge_method=S256";
const port = (responder, overrides = {}) => {
  const recorded = recordingTransport(responder);
  const client = createClient({
    transport: recorded.transport,
    online: () => true,
    ...overrides.client,
  });
  return {
    calls: recorded.calls,
    port: createHttpPort({
      client,
      composed: overrides.composed ?? composed,
      loginBodyVersion: overrides.loginBodyVersion ?? loginBodyVersion,
      navigationSignal: overrides.navigationSignal ?? (() => undefined),
    }),
  };
};
const headers = (init) => new Headers(init.headers);

test("AC05: one sign-in POST with the request header, JSON type, no key and the composed v2 body", async () => {
  assert.equal(loginBodyVersion, 2);
  const { calls, port: p } = port(() =>
    json(200, { schemaVersion: 1, authorizationUrl: authorize }),
  );
  const outcome = await p.session.startSignIn("ws-1");
  assert.deepEqual(outcome, { kind: "ok", value: { navigateTo: authorize }, replayed: false });
  assert.equal(calls.length, 1);
  const [{ path, init }] = calls;
  assert.equal(path, "/auth/login");
  assert.equal(init.method, "POST");
  // v2 names no workspace, even when the sign-in starts from a workspace link.
  assert.equal(init.body, '{"schemaVersion":2}');
  assert.equal(headers(init).get("x-morrow-request"), "1");
  assert.equal(headers(init).get("content-type"), "application/json");
  assert.equal(headers(init).has("idempotency-key"), false);
  assert.equal(headers(init).has("authorization"), false);
  assert.equal(Object.hasOwn(init, "mode"), false);
});
test("AC05: at body v2 the start is exactly {schemaVersion:2}; at v1 without a workspace nothing is sent", async () => {
  const v2 = port(() => json(200, { schemaVersion: 1, authorizationUrl: authorize }), {
    loginBodyVersion: 2,
  });
  await v2.port.session.startSignIn(null);
  assert.equal(v2.calls[0].init.body, '{"schemaVersion":2}');
  const v1 = port(() => json(200, {}), { loginBodyVersion: 1 });
  assert.equal((await v1.port.session.startSignIn(null)).kind, "invalid");
  assert.equal((await v1.port.session.startSignIn("a/b")).kind, "invalid");
  assert.equal(v1.calls.length, 0);
  await v1.port.session.startSignIn("ws-1");
  assert.equal(v1.calls[0].init.body, '{"schemaVersion":1,"workspaceId":"ws-1"}');
});
test("P05.T01ab-AC08: a challenge token travels only as X-Morrow-Challenge on the start POST", async () => {
  const token = "tok." + "A".repeat(64);
  const { calls, port: p } = port(() =>
    json(200, { schemaVersion: 1, authorizationUrl: authorize }),
  );
  assert.equal((await p.session.startSignIn("ws-1", token)).kind, "ok");
  assert.equal(headers(calls[0].init).get("x-morrow-challenge"), token);
  assert.equal(calls[0].init.body, '{"schemaVersion":2}');
  await p.session.startSignIn("ws-1", null);
  assert.equal(headers(calls[1].init).has("x-morrow-challenge"), false);
  // A malformed token is refused before anything is sent.
  for (const bad of ["", "a b", "a".repeat(2049), "tok\u00e9"])
    assert.equal((await p.session.startSignIn("ws-1", bad)).kind, "invalid");
  assert.equal(calls.length, 2);
  assert.deepEqual(requests.login(2, null, token), {
    method: "POST",
    path: "/auth/login",
    body: '{"schemaVersion":2}',
    key: null,
    challenge: token,
  });
  assert.equal(requests.login(2, null, "a b"), null);
  assert.equal(Object.hasOwn(requests.login(2, null), "challenge"), false);
  // The client itself refuses a malformed token and sends nothing.
  const recorded = [];
  const client = createClient({
    transport: async (path, init) => (recorded.push(init), json(200, {})),
    online: () => true,
  });
  assert.deepEqual(await client.post("/auth/login", "{}", null, "a/b"), {
    kind: "not_sent",
    offline: false,
  });
  assert.equal(recorded.length, 0);
});
test("P05.T01ab: a guard 403 or 429 on the start is 'couldn't start', and nothing navigates", async () => {
  for (const [status, outcome] of [
    [403, "challenge_required"],
    [403, "challenge_failed"],
    [429, "rate_limited"],
  ]) {
    const { port: p } = port(() =>
      json(status, { schemaVersion: 1, outcome }, status === 429 ? { "retry-after": "60" } : {}),
    );
    assert.deepEqual(await p.session.startSignIn("ws-1", "tok.a"), {
      kind: "unavailable",
      offline: false,
    });
  }
});
test("AC05: only the pinned WorkOS origin and path navigate; anything else is 'couldn't start'", async () => {
  for (const authorizationUrl of [
    "https://evil.example/user_management/authorize?x=1",
    "https://api.workos.com/user_management/other?x=1",
    "http://api.workos.com/user_management/authorize?x=1",
    "https://user:pass@api.workos.com/user_management/authorize?x=1",
    "https://api.workos.com/user_management/authorize?x=1#frag",
    "https://api.workos.com.evil.example/user_management/authorize",
    "/user_management/authorize",
    42,
  ]) {
    const { port: p } = port(() => json(200, { schemaVersion: 1, authorizationUrl }));
    assert.deepEqual(await p.session.startSignIn("ws-1"), { kind: "unavailable", offline: false });
  }
  const limited = port(() => json(503, { schemaVersion: 1, outcome: "login_unavailable" }));
  assert.deepEqual(await limited.port.session.startSignIn("ws-1"), {
    kind: "unavailable",
    offline: false,
  });
});
test("the login body version agrees with the server's current login start", async () => {
  // Coordination guard (§4.14): the client's composed body must pass the server's current
  // login start. P05.T01x Part B moved the server to the v2 body, so this build is at v2;
  // the test fails if the two disagree again.
  const request = requests.login(loginBodyVersion, "ws-1");
  const attempt = createLoginAttempt(Date.now, new AbortController().signal, 5000);
  const accepted = await loginStartInput(
    new Request("https://w.test/auth/login", {
      method: "POST",
      headers: {
        Origin: "https://w.test",
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
      body: request.body,
    }),
    attempt,
  ).then(
    () => true,
    () => false,
  );
  assert.equal(accepted, true);
});
test("AC08: reads are relative GETs with no body, type or key, and the Id is sent unencoded", async () => {
  const { calls, port: p } = port(() =>
    json(200, {
      schemaVersion: 1,
      workspace: { id: "a:b.c", displayName: "Sample" },
      policyRevision: 3,
    }),
  );
  const outcome = await p.workspace.bootstrap("a:b.c");
  assert.equal(outcome.kind, "ok");
  const [{ path, init }] = calls;
  assert.equal(path, "/workspace/a:b.c/bootstrap");
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.equal(Object.hasOwn(init, "mode"), false);
  assert.deepEqual([...headers(init).keys()], ["x-morrow-request"]);
  for (const bad of ["a/b", "", "%3A", "../x", "a b", "x".repeat(129)])
    assert.equal((await p.workspace.bootstrap(bad)).kind, "not_found", bad);
  assert.equal(calls.length, 1);
});
test("AC08: commands carry lowercase UUID v4 keys; bodies are closed and carry no tenant key", () => {
  const key = newCommandKey();
  assert.ok(isCommandKey(key));
  assert.equal(key, key.toLowerCase());
  const command = (body) => ({ key, body });
  const built = [
    requests.createGoal("ws", command({ objective: "Grow", criteria: ["One"] })),
    requests.createTask("ws", command({ goalId: "g-1", objective: "Do" })),
    requests.markReady("ws", "t-1", command({ expectedRevision: 2 })),
    requests.assign("ws", "t-1", command({ assigneeId: "p-1", expectedRevision: 2 })),
    requests.ask("ws", "t-1", command({ question: "Why?", respondentId: "p-1" })),
    requests.answer("ws", "q-1", command({ text: "Because", expectedRevision: 1 })),
    requests.cancelQuestion("ws", "q-1", command({ expectedRevision: 1 })),
    requests.createOrganization(command({ organizationName: "Org", workspaceName: "Main" })),
  ];
  for (const request of built) {
    assert.equal(request.method, "POST");
    assert.equal(request.key, key);
    const body = JSON.parse(request.body);
    for (const forbidden of ["organizationId", "workspaceId", "principalId"])
      assert.equal(Object.hasOwn(body, forbidden), false, request.path);
  }
  assert.deepEqual(JSON.parse(built[0].body), {
    objective: "Grow",
    storeIds: [],
    successCriteria: [
      { description: "One", verificationCapabilityId: null, evidenceRequired: false },
    ],
  });
  assert.deepEqual(JSON.parse(built[1].body), {
    goalId: "g-1",
    objective: "Do",
    allowedResources: [],
  });
  assert.equal(built[2].path, "/workspace/ws/work/tasks/t-1/status");
  assert.equal(
    requests.createGoal("ws", { key: "NOT-A-KEY", body: { objective: "x", criteria: ["y"] } }),
    null,
  );
  assert.equal(requests.logout().key, null);
  assert.equal(requests.login(1, "ws").key, null);
});
test("AC08: zero or 21 criteria, an oversize body or an invalid id send nothing", () => {
  const key = newCommandKey();
  assert.equal(requests.createGoal("ws", { key, body: { objective: "x", criteria: [] } }), null);
  assert.equal(
    requests.createGoal("ws", { key, body: { objective: "x", criteria: Array(21).fill("c") } }),
    null,
  );
  assert.notEqual(
    requests.createGoal("ws", { key, body: { objective: "x", criteria: Array(20).fill("c") } }),
    null,
  );
  const wide = "€".repeat(2048);
  assert.equal(
    requests.createGoal("ws", { key, body: { objective: "x", criteria: Array(20).fill(wide) } }),
    null,
    "over 64 KiB",
  );
  assert.equal(byteLimits.work, 65536);
  assert.equal(requests.getTask("ws", "a/b"), null);
  assert.equal(requests.markReady("w s", "t", { key, body: { expectedRevision: 1 } }), null);
  assert.equal(
    requests.answer("ws", "q", { key, body: { text: "a\0b", expectedRevision: 1 } }),
    null,
  );
  assert.equal(
    requests.createOrganization({
      key,
      body: { organizationName: "€".repeat(400), workspaceName: "€".repeat(400) },
    }),
    null,
    "over 2048 bytes",
  );
});
test("AC08: only documented query parameters, with the cursor encoded", () => {
  const paths = [
    requests.listGoals("ws", "a/b&c=d").path,
    requests.listTasks("ws", "g-1", null).path,
    requests.listTaskQuestions("ws", "t-1", "n").path,
    requests.listMyOpenQuestions("ws", null).path,
  ];
  assert.equal(paths[0], "/workspace/ws/work/goals?limit=25&after=a%2Fb%26c%3Dd");
  assert.equal(paths[3], "/workspace/ws/work/questions?respondent=me&status=open&limit=50");
  for (const path of paths)
    for (const key of new URL(path, "https://w.test").searchParams.keys())
      assert.ok(["after", "limit", "goalId", "respondent", "status"].includes(key), key);
});
test("§4.2: an uncomposed method returns not_in_build without a request", async () => {
  // The PR-1 table (session and bootstrap only): every other method sends nothing.
  const pr1 = Object.fromEntries(
    Object.keys(composed).map((method) => [
      method,
      ["session.startSignIn", "session.signOut", "workspace.bootstrap"].includes(method),
    ]),
  );
  const { calls, port: p } = port(() => json(200, {}), { composed: pr1 });
  for (const outcome of [
    await p.account.overview(),
    await p.work.listGoals("ws", null),
    await p.work.createGoal("ws", {
      key: newCommandKey(),
      body: { objective: "x", criteria: ["y"] },
    }),
    await p.people.list("ws"),
    await p.session.keepAlive(),
  ])
    assert.deepEqual(outcome, { kind: "not_in_build" });
  assert.equal(calls.length, 0);
  // PR-2 composes account.* and work.* (tests/workspace-web-account-work.test.mjs).
  assert.equal(composed["account.overview"], true);
  assert.equal(composed["people.list"], false);
});
test("sign-out sends {schemaVersion:1} with no key; a lost reply is uncertain, offline sends nothing", async () => {
  const ended = port(() => json(200, { schemaVersion: 1, outcome: "session_ended" }));
  assert.equal((await ended.port.session.signOut()).kind, "ok");
  assert.equal(ended.calls[0].init.body, '{"schemaVersion":1}');
  assert.equal(headers(ended.calls[0].init).has("idempotency-key"), false);
  const lost = port(() => Promise.reject(new TypeError("network")));
  assert.deepEqual(await lost.port.session.signOut(), { kind: "uncertain" });
  const offline = port(() => json(200, {}), { client: { online: () => false } });
  assert.deepEqual(await offline.port.session.signOut(), { kind: "unavailable", offline: true });
  assert.equal(offline.calls.length, 0);
});
test("reads time out as unavailable, commands as uncertain; navigation aborts reads only", async () => {
  const slow = port(
    (call) =>
      new Promise((_, reject) =>
        call.init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
    {
      client: { readTimeoutMs: 20, commandTimeoutMs: 20 },
    },
  );
  assert.deepEqual(await slow.port.workspace.bootstrap("ws"), {
    kind: "unavailable",
    offline: false,
  });
  assert.deepEqual(await slow.port.session.signOut(), { kind: "uncertain" });
  const controller = new AbortController();
  const navigating = port(
    (call) =>
      new Promise((_, reject) =>
        call.init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
    { navigationSignal: () => controller.signal },
  );
  const read = navigating.port.workspace.bootstrap("ws");
  controller.abort();
  assert.deepEqual(await read, { kind: "unavailable", offline: false });
});
test("a redirect is refused by fetch and never followed", async () => {
  const { calls, port: p } = port(() => Promise.reject(new TypeError("redirect mode is error")));
  assert.deepEqual(await p.workspace.bootstrap("ws"), { kind: "unavailable", offline: false });
  assert.equal(calls[0].init.redirect, "error");
});
