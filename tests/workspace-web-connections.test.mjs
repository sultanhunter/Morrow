// M2 PR-2 (P09.T02a; mvp-architecture §2 step 5): the SPA half of the Shopify link. The
// install continuation is captured from exactly /w/:ws/connections#handoff=<token> and the
// fragment is replaced before the router reads the address; the HTTP adapter builds the
// connections read and the store-link preview, apply and status with the handoff's one key
// (apply alone carries X-Morrow-CSRF), and those requests pass the api's real request guard;
// the decoders agree with the WorkspaceConnections@1 contract; the fixture adapter scripts
// the connection states ui:check renders. No browser and no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { captureHandoff, handoffTokenPattern } from "../apps/workspace-web/src/handoff.ts";
import { readLocation } from "../apps/workspace-web/src/router.ts";
import { createClient, newCommandKey } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort, requests } from "../apps/workspace-web/src/http/api.ts";
import { composed } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeConnections,
  decodeConnectionsBody,
  decodeStoreLinkPreview,
  decodeStoreLinkResult,
} from "../apps/workspace-web/src/http/connection-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { scenarioNames } from "../apps/workspace-web/src/fixtures/scenarios.ts";
import {
  fixtureCsrfToken,
  fixtureHandoffToken,
  fixtureStore,
  fixtureWorkspace,
} from "../apps/workspace-web/src/fixtures/seed.ts";
import { createStandaloneRequestGuard } from "../packages/identity/src/standalone-request-guard.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createPending } from "../apps/workspace-web/src/pending.ts";
import { json, recordingTransport, fakeWindow, MemoryStorage } from "./fixtures/workspace-web.mjs";

const token = Buffer.alloc(32, 7).toString("base64url");
const otherToken = Buffer.alloc(32, 9).toString("base64url");
const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const response = (status, body) => ({
  kind: "response",
  status,
  headers: new Headers(),
  body,
  json: true,
});
const installation = (overrides = {}) => ({
  schemaVersion: 1,
  id: "inst_1",
  organizationId: "org_1",
  workspaceId: "ws_1",
  storeId: "store_1",
  revision: 1,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:05:00.000Z",
  shopId: "424242",
  shopDomain: "lab-dev-store.myshopify.com",
  connectionId: "conn_1",
  status: "unlinked",
  owningWorkspaceId: null,
  grantedScopes: ["read_products", "write_products"],
  providerCredentialVersion: 1,
  providerCredentialRef: "cred_1",
  ...overrides,
});
const offered = {
  offered: true,
  url: "https://admin.shopify.com/oauth/install_custom_app?client_id=abc&signature=x",
  reason: "offered",
};

test("handoff: exactly /w/:ws/connections#handoff=<canonical token> is captured and the fragment replaced", () => {
  const win = fakeWindow(`/w/ws-1/connections#handoff=${token}`);
  const handoff = captureHandoff(win, newCommandKey);
  assert.equal(handoff.workspaceId, "ws-1");
  assert.equal(handoff.token, token);
  assert.match(handoff.key, keyPattern);
  assert.ok(Object.isFrozen(handoff));
  // The entry is replaced (not pushed), so neither the address nor history keeps the token.
  assert.deepEqual(win.entries, ["/w/ws-1/connections"]);
  assert.equal(readLocation(win.location).match.id, "connections");
  // Each capture mints its own key.
  const again = captureHandoff(fakeWindow(`/w/ws-1/connections#handoff=${token}`), newCommandKey);
  assert.notEqual(again.key, handoff.key);
});
test("handoff: any other path, query or fragment is left alone and still renders NotFound", () => {
  for (const start of [
    `/w/ws-1/connections?x=1#handoff=${token}`,
    `/w/ws-1/work#handoff=${token}`,
    `/w/ws-1/connections/conn-1#handoff=${token}`,
    `/w/ws-1#handoff=${token}`,
    `/#handoff=${token}`,
    `/w/ws-1/connections#handoff=${token}x`,
    `/w/ws-1/connections#handoff=${token.slice(0, 42)}B`,
    `/w/ws-1/connections#handoff=${token.slice(0, 42)}`,
    `/w/ws-1/connections#handoff=${token}&x=1`,
    `/w/ws-1/connections#token=${token}`,
    `/w/ws-1/connections#handoff=`,
    `/w/ws-1/connections`,
    `/w/a%2Fb/connections#handoff=${token}`,
  ]) {
    const win = fakeWindow(start);
    const before = [...win.entries];
    let minted = 0;
    assert.equal(
      captureHandoff(win, () => {
        minted++;
        return newCommandKey();
      }),
      null,
      start,
    );
    assert.deepEqual(win.entries, before, start);
    assert.equal(minted, 0, start);
    if (start.includes("#") || start.includes("?"))
      assert.equal(readLocation(win.location).match, null, start);
  }
});
test("handoff: memory only; the module and the app never write it to storage or a log", () => {
  const source = readFileSync("apps/workspace-web/src/handoff.ts", "utf8");
  assert.doesNotMatch(source, /Storage|console\.|localStorage|sessionStorage|document\.cookie/);
  const app = readFileSync("apps/workspace-web/src/app.tsx", "utf8");
  // Captured once in createAppRuntime (before the router), and forgotten when a session ends.
  assert.match(app, /const handoff = captureHandoff\(window, newCommandKey\);\n[^]*createRouter\(/);
  assert.match(app, /const ended = \(\) => \{\n[^\n]*\n\s*runtime\.handoff = null;/);
  for (const file of [
    "packages/workspace-ui/src/screens/connections.tsx",
    "apps/workspace-web/src/http/connection-decoders.ts",
  ])
    assert.doesNotMatch(readFileSync(file, "utf8"), /Storage|console\./, file);
});

test("requests: the connections read and the three store-link POSTs, closed and keyed", () => {
  const key = newCommandKey();
  const c = { key, body: { handoffToken: token } };
  assert.deepEqual(requests.connections("ws:1.a"), {
    method: "GET",
    path: "/workspace/ws:1.a/connections",
  });
  const preview = requests.storeLink("preview", "ws-1", c);
  assert.deepEqual(preview, {
    method: "POST",
    path: "/workspace/ws-1/store-links/preview",
    body: JSON.stringify({ handoffToken: token }),
    key,
  });
  const apply = requests.storeLink("apply", "ws-1", c, fixtureCsrfToken);
  assert.deepEqual(apply, {
    method: "POST",
    path: "/workspace/ws-1/store-links",
    body: JSON.stringify({ handoffToken: token }),
    key,
    csrf: fixtureCsrfToken,
  });
  assert.equal(requests.storeLink("status", "ws-1", c).path, "/workspace/ws-1/store-links/status");
  // Refused before sending: a bad workspace, token, key or CSRF value, a CSRF value on
  // preview or status, or none on apply.
  for (const built of [
    requests.connections("a/b"),
    requests.storeLink("preview", "a/b", c),
    requests.storeLink("preview", "ws-1", { key, body: { handoffToken: "short" } }),
    requests.storeLink("preview", "ws-1", { key: "NOT-A-KEY", body: { handoffToken: token } }),
    requests.storeLink("preview", "ws-1", c, fixtureCsrfToken),
    requests.storeLink("status", "ws-1", c, fixtureCsrfToken),
    requests.storeLink("apply", "ws-1", c),
    requests.storeLink("apply", "ws-1", c, "x".repeat(43)),
  ])
    assert.equal(built, null);
  assert.ok(handoffTokenPattern.test(fixtureHandoffToken));
});

test("HTTP port: preview, apply and status reuse the handoff's key; only apply sends X-Morrow-CSRF", async () => {
  const csrf = Buffer.alloc(32, 3).toString("base64url");
  const recorded = recordingTransport(({ path }) =>
    path.endsWith("/preview")
      ? json(200, {
          schemaVersion: 1,
          link: {
            installationId: "inst_1",
            purpose: "workspace_first",
            expectedPolicyRevision: 2,
            expectedOwnershipRevision: 1,
          },
          csrfToken: csrf,
        })
      : path.endsWith("/status")
        ? json(200, {
            schemaVersion: 1,
            outcome: "applied",
            linkId: "link_1",
            ownershipRevision: 2,
            policyRevision: 3,
            auditId: "audit_1",
          })
        : json(503, { schemaVersion: 1, outcome: "outcome_unknown" }),
  );
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion: 2,
    navigationSignal: () => undefined,
  });
  const c = { key: newCommandKey(), body: { handoffToken: token } };
  assert.deepEqual(await port.storeLinks.preview("ws-1", c), {
    kind: "ok",
    value: { installationId: "inst_1", csrfToken: csrf },
    replayed: false,
  });
  assert.deepEqual(await port.storeLinks.apply("ws-1", c, csrf), { kind: "uncertain" });
  assert.deepEqual(await port.storeLinks.status("ws-1", c), {
    kind: "ok",
    value: { outcome: "applied" },
    replayed: false,
  });
  assert.deepEqual(
    recorded.calls.map(({ path, init }) => {
      const h = new Headers(init.headers);
      return [path, init.method, init.body, h.get("idempotency-key"), h.get("x-morrow-csrf")];
    }),
    [
      ["/workspace/ws-1/store-links/preview", "POST", `{"handoffToken":"${token}"}`, c.key, null],
      ["/workspace/ws-1/store-links", "POST", `{"handoffToken":"${token}"}`, c.key, csrf],
      ["/workspace/ws-1/store-links/status", "POST", `{"handoffToken":"${token}"}`, c.key, null],
    ],
  );
  for (const call of recorded.calls) {
    const h = new Headers(call.init.headers);
    assert.equal(h.get("x-morrow-request"), "1");
    assert.equal(h.get("content-type"), "application/json");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.credentials, "same-origin");
  }
  // An invalid CSRF value never leaves the page.
  const before = recorded.calls.length;
  assert.deepEqual(await port.storeLinks.apply("ws-1", c, "bad"), {
    kind: "invalid",
    field: null,
  });
  assert.equal(recorded.calls.length, before);
  // The client itself refuses a malformed X-Morrow-CSRF value.
  const client = createClient({ transport: recorded.transport, online: () => true });
  assert.deepEqual(await client.post("/x", "{}", c.key, null, "bad value"), {
    kind: "not_sent",
    offline: false,
  });
  assert.equal(recorded.calls.length, before);
  for (const method of [
    "connections.list",
    "storeLinks.preview",
    "storeLinks.apply",
    "storeLinks.status",
  ])
    assert.equal(composed[method], true, method);
});

// The api's per-address session limit (apps/api/src/session-limit.ts) answers before the
// store-link guard: a hold for Retry-After, and an apply already unknown stays unknown.
test("HTTP port: the session limit's 429 on a store link is a hold, never a new unknown", async () => {
  const limited = () =>
    json(429, { schemaVersion: 1, outcome: "rate_limited" }, { "retry-after": "60" });
  const replies = [
    limited(), // preview
    json(503, { schemaVersion: 1, outcome: "outcome_unknown" }), // apply
    limited(), // status
    json(200, {
      schemaVersion: 1,
      outcome: "applied",
      linkId: "link_1",
      ownershipRevision: 2,
      policyRevision: 3,
      auditId: "audit_1",
    }), // status again
  ];
  const recorded = recordingTransport(({ index }) => replies[index]);
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion: 2,
    navigationSignal: () => undefined,
  });
  const pending = createPending({ storage: new MemoryStorage() });
  const c = { key: newCommandKey(), body: { handoffToken: token } };
  const run = (send) => pending.run(c, null, send);
  const csrf = Buffer.alloc(32, 3).toString("base64url");
  assert.deepEqual(await run(() => port.storeLinks.preview("ws-1", c)), {
    kind: "rate_limited",
    retryAfterSeconds: 60,
  });
  assert.equal(pending.blocking(), false, "nothing ran, so nothing is unknown");
  assert.deepEqual(await run(() => port.storeLinks.apply("ws-1", c, csrf)), {
    kind: "uncertain",
  });
  assert.deepEqual(
    await run(() => port.storeLinks.status("ws-1", c)),
    { kind: "uncertain" },
    "a 429 after an unknown apply stays unknown",
  );
  assert.deepEqual(await run(() => port.storeLinks.status("ws-1", c)), {
    kind: "ok",
    value: { outcome: "applied" },
    replayed: false,
  });
  assert.equal(pending.blocking(), false);
  assert.equal(
    new Set(recorded.calls.map(({ init }) => new Headers(init.headers).get("idempotency-key")))
      .size,
    1,
  );
});

test("the SPA's requests pass the api's real store-link guard; the preview's CSRF value opens apply", async () => {
  const origin = "https://workspace.example.test";
  const session = Buffer.alloc(32, 27).toString("base64url");
  const guard = createStandaloneRequestGuard(
    JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
    () => Date.now(),
  );
  const recorded = recordingTransport(() => json(500, {}));
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion: 2,
    navigationSignal: () => undefined,
  });
  const c = { key: newCommandKey(), body: { handoffToken: token } };
  // What a browser adds to a same-origin fetch: the cookie, the exact Origin and the
  // Fetch Metadata site.
  const asBrowser = ({ path, init }) =>
    new Request(origin + path, {
      method: init.method,
      body: init.body,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Cookie: `__Host-morrow_session=${session}`,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
  await port.storeLinks.preview("ws-1", c);
  let csrf = null;
  const previewed = await guard.handle(asBrowser(recorded.calls[0]), "preview", async (context) => {
    assert.equal(context.workspaceId, "ws-1");
    assert.equal(context.commandId, c.key);
    assert.equal(context.nonceDigest, createHash("sha256").update(token).digest("hex"));
    csrf = context.csrfToken;
    return json(200, {});
  });
  assert.equal(previewed.status, 200);
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  await port.storeLinks.apply("ws-1", c, csrf);
  let applied = false;
  const apply = await guard.handle(asBrowser(recorded.calls[1]), "apply", async () => {
    applied = true;
    return json(200, {});
  });
  assert.equal(apply.status, 200);
  assert.equal(applied, true);
  // The same key with another continuation has another CSRF value: refused before running.
  await port.storeLinks.apply("ws-1", { key: c.key, body: { handoffToken: otherToken } }, csrf);
  const mismatched = await guard.handle(asBrowser(recorded.calls[2]), "apply", async () => {
    throw Error("must not run");
  });
  assert.equal(mismatched.status, 403);
  await port.storeLinks.status("ws-1", c);
  const status = await guard.handle(asBrowser(recorded.calls[3]), "status", async () =>
    json(200, {}),
  );
  assert.equal(status.status, 200);
  await port.connections.list("ws-1");
  const read = await guard.handle(asBrowser(recorded.calls[4]), "connections", async (ctx) => {
    assert.equal(ctx.commandId, null);
    return json(200, {});
  });
  assert.equal(read.status, 200);
});

test("decoders: WorkspaceConnections@1 bodies the contract accepts decode, and nothing else", () => {
  const body = {
    schemaVersion: 1,
    installations: [
      installation(),
      installation({ id: "inst_2", connectionId: "conn_2", status: "linked" }),
    ],
    installLink: offered,
  };
  assert.equal(validateCurrentDefinition("WorkspaceConnections", body), true);
  assert.deepEqual(decodeConnectionsBody(body, "ws_1"), {
    installations: [
      {
        installationId: "inst_1",
        connectionId: "conn_1",
        storeId: "store_1",
        shopDomain: "lab-dev-store.myshopify.com",
        status: "unlinked",
        grantedScopes: ["read_products", "write_products"],
        updatedAt: "2026-10-20T10:05:00.000Z",
      },
      {
        installationId: "inst_2",
        connectionId: "conn_2",
        storeId: "store_1",
        shopDomain: "lab-dev-store.myshopify.com",
        status: "linked",
        grantedScopes: ["read_products", "write_products"],
        updatedAt: "2026-10-20T10:05:00.000Z",
      },
    ],
    installLink: offered,
  });
  for (const reason of ["linked", "not_permitted", "not_registered", "route_not_ready"]) {
    const refused = {
      schemaVersion: 1,
      installations: [],
      installLink: { offered: false, url: null, reason },
    };
    assert.equal(validateCurrentDefinition("WorkspaceConnections", refused), true);
    assert.equal(decodeConnectionsBody(refused, "ws_1").installLink.reason, reason);
  }
  // Each malformed body is refused by the contract and by the decoder.
  for (const bad of [
    { ...body, installations: [installation({ workspaceId: "ws_other" })] },
    { ...body, installations: [installation({ shopDomain: "evil.example.com" })] },
    { ...body, installLink: { ...offered, url: "http://admin.shopify.com/x" } },
    { ...body, installLink: { ...offered, url: "https://evil.test/install" } },
    { ...body, installLink: { offered: false, url: offered.url, reason: "linked" } },
    { ...body, installLink: { offered: true, url: null, reason: "offered" } },
    { ...body, installLink: { offered: false, url: null, reason: "offered" } },
    {
      ...body,
      installations: Array.from({ length: 51 }, (_, i) => installation({ connectionId: "c" + i })),
    },
    { ...body, schemaVersion: 2 },
  ])
    assert.equal(decodeConnectionsBody(bad, "ws_1"), null, JSON.stringify(bad).slice(0, 120));
  assert.equal(
    decodeConnectionsBody({ ...body, installations: [installation(), installation()] }, "ws_1"),
    null,
    "duplicate connections",
  );
  // Read outcomes.
  assert.equal(decodeConnections(response(200, body), "ws_1").kind, "ok");
  assert.deepEqual(decodeConnections(response(200, { schemaVersion: 1 }), "ws_1"), {
    kind: "unavailable",
    offline: false,
  });
  assert.equal(
    decodeConnections(response(401, { code: "authentication_required" }), "ws_1").kind,
    "unauthenticated",
  );
  assert.equal(decodeConnections(response(403, { code: "request_denied" }), "ws_1").kind, "denied");
  assert.equal(
    decodeConnections(response(404, { code: "request_denied" }), "ws_1").kind,
    "not_found",
  );
  assert.equal(
    decodeConnections(response(503, { code: "unavailable" }), "ws_1").kind,
    "unavailable",
  );
  assert.equal(decodeConnections({ kind: "lost" }, "ws_1").kind, "unavailable");
});

test("decoders: the store-link preview, apply and status rows", () => {
  const csrf = Buffer.alloc(32, 3).toString("base64url");
  const previewBody = {
    schemaVersion: 1,
    link: {
      installationId: "inst_1",
      purpose: "workspace_first",
      expectedPolicyRevision: 2,
      expectedOwnershipRevision: 1,
    },
    csrfToken: csrf,
  };
  const limited = { schemaVersion: 1, outcome: "rate_limited" };
  const rows = [
    [decodeStoreLinkPreview(response(200, previewBody)), "ok"],
    [decodeStoreLinkPreview(response(200, { ...previewBody, csrfToken: "short" })), "uncertain"],
    [decodeStoreLinkPreview(response(404, { code: "linking_not_found" })), "not_found"],
    [decodeStoreLinkPreview(response(409, { code: "billing_route_required" })), "conflict"],
    [decodeStoreLinkPreview(response(403, { code: "request_denied" })), "denied"],
    [decodeStoreLinkPreview(response(400, { code: "request_denied" })), "invalid"],
    [decodeStoreLinkPreview(response(401, { code: "authentication_required" })), "unauthenticated"],
    [decodeStoreLinkPreview(response(503, { code: "unavailable" })), "unavailable"],
    [decodeStoreLinkPreview({ kind: "lost" }), "uncertain"],
    [decodeStoreLinkPreview({ kind: "not_sent", offline: true }), "unavailable"],
    // The api's session limit answered before the guard: nothing ran, a hold.
    [decodeStoreLinkPreview(response(429, limited)), "rate_limited"],
    [decodeStoreLinkPreview(response(429, { code: "rate_limited" })), "uncertain"],
    [
      decodeStoreLinkPreview(response(429, { schemaVersion: 2, outcome: "rate_limited" })),
      "uncertain",
    ],
    [
      decodeStoreLinkResult(
        response(200, {
          schemaVersion: 1,
          outcome: "applied",
          linkId: "link_1",
          ownershipRevision: 2,
          policyRevision: 3,
          auditId: "audit_1",
        }),
      ),
      "ok:applied",
    ],
    [decodeStoreLinkResult(response(200, { schemaVersion: 1, outcome: "applied" })), "uncertain"],
    [decodeStoreLinkResult(response(403, { schemaVersion: 1, outcome: "denied" })), "ok:denied"],
    [
      decodeStoreLinkResult(
        response(200, {
          schemaVersion: 1,
          outcome: "denied",
          linkId: null,
          ownershipRevision: null,
          policyRevision: 3,
          auditId: "audit_2",
        }),
      ),
      "ok:denied",
    ],
    [decodeStoreLinkResult(response(409, { schemaVersion: 1, outcome: "conflict" })), "conflict"],
    [
      decodeStoreLinkResult(response(503, { schemaVersion: 1, outcome: "outcome_unknown" })),
      "uncertain",
    ],
    [decodeStoreLinkResult(response(503, { code: "unavailable" })), "unavailable"],
    [decodeStoreLinkResult(response(404, { code: "linking_not_found" })), "not_found"],
    [decodeStoreLinkResult(response(403, { code: "request_denied" })), "denied"],
    [decodeStoreLinkResult(response(500, {})), "uncertain"],
    [decodeStoreLinkResult({ kind: "timeout" }), "uncertain"],
    [decodeStoreLinkResult(response(429, limited)), "rate_limited"],
    [decodeStoreLinkResult(response(429, { code: "rate_limited" })), "uncertain"],
    [decodeStoreLinkResult(response(429, {})), "uncertain"],
  ];
  assert.deepEqual(
    rows.map(([outcome]) =>
      outcome.kind === "ok" && "outcome" in outcome.value
        ? "ok:" + outcome.value.outcome
        : outcome.kind,
    ),
    rows.map(([, expected]) => expected),
  );
});

test("fixture: the handoff scenarios script preview, apply and status per key", async () => {
  const ws = fixtureWorkspace.id;
  const c = { key: newCommandKey(), body: { handoffToken: fixtureHandoffToken } };
  const port = createFixtureAdapter("connections_handoff");
  const before = await port.connections.list(ws);
  assert.deepEqual(
    before.value.installations.map((i) => [i.connectionId, i.status]),
    [[fixtureStore.connectionId, "unlinked"]],
  );
  assert.equal(before.value.installLink.reason, "offered");
  assert.deepEqual(await port.storeLinks.preview(ws, c), {
    kind: "ok",
    value: { installationId: fixtureStore.installationId, csrfToken: fixtureCsrfToken },
    replayed: false,
  });
  assert.equal((await port.storeLinks.apply(ws, c, "wrong")).kind, "denied");
  assert.deepEqual(await port.storeLinks.apply(ws, c, fixtureCsrfToken), {
    kind: "ok",
    value: { outcome: "applied" },
    replayed: false,
  });
  assert.equal((await port.storeLinks.apply(ws, c, fixtureCsrfToken)).replayed, true);
  const after = await port.connections.list(ws);
  assert.deepEqual(
    [after.value.installations[0].status, after.value.installLink.reason],
    ["linked", "linked"],
  );
  // The lost apply is answered by status with the same key.
  const lost = createFixtureAdapter("connections_link_uncertain");
  await lost.storeLinks.preview(ws, c);
  assert.equal((await lost.storeLinks.apply(ws, c, fixtureCsrfToken)).kind, "uncertain");
  assert.deepEqual(await lost.storeLinks.status(ws, c), {
    kind: "ok",
    value: { outcome: "applied" },
    replayed: false,
  });
  assert.equal(
    (await createFixtureAdapter("connections_handoff").storeLinks.status(ws, c)).kind,
    "not_found",
  );
  assert.equal(
    (await createFixtureAdapter("connections_handoff_route").storeLinks.preview(ws, c)).kind,
    "conflict",
  );
  assert.equal(
    (await createFixtureAdapter("connections_handoff_expired").storeLinks.preview(ws, c)).kind,
    "not_found",
  );
  for (const [scenario, reason] of [
    ["connections_offered", "offered"],
    ["connections_not_permitted", "not_permitted"],
    ["connections_route_not_ready", "route_not_ready"],
    ["ready", "linked"],
  ])
    assert.equal(
      (await createFixtureAdapter(scenario).connections.list(ws)).value.installLink.reason,
      reason,
      scenario,
    );
  // The connection methods never call fetch either, in any scenario.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls++;
    return original(...args);
  };
  try {
    for (const scenario of scenarioNames) {
      const p = createFixtureAdapter(scenario);
      const settle = (promise) =>
        Promise.race([promise, new Promise((r) => setTimeout(() => r(null), 5))]);
      await settle(p.connections.list(ws));
      await settle(p.storeLinks.preview(ws, c));
      await settle(p.storeLinks.apply(ws, c, fixtureCsrfToken));
      await settle(p.storeLinks.status(ws, c));
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});
