// M5 PR-1: the purchase guard and the billing routes without a database (P18.T01a; P01.T04a
// §5 and §9). The closed path -> action table; the action never from the request; an
// unmapped path 404 and every malformed request refused before any connection opens or
// any broker method runs; the closed bodies; the generalised workspace request guard with
// PUT under the POST rules; and the api Worker's ordered dispatch table. The denials that
// need a session are in lab:billing, where the broker spy also counts zero calls: a member
// without the grant (B) and a Shopify-bound workspace (D8, F). These routes take a browser
// session only, which no agent principal holds.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  billingRoutes,
  createBillingApiHandler,
  createStripeWebhookHandler,
  guardPurchase,
  isMorrowPurchaseRoute,
  morrowPurchaseRoutes,
  parseCheckoutBody,
  parsePortalBody,
} from "../packages/work/src/billing/index.ts";
import {
  WorkGuardError,
  guardWorkspaceRequest,
  workspacePathPattern,
} from "../packages/work/src/http-guard.ts";
import { apiDispatch, createWorkspaceApiWorker } from "../apps/api/src/worker.ts";
import {
  parseWorkspaceBillingFacts,
  workspaceBillingState,
} from "../packages/policy/src/billing-state.ts";
import { billingFactsInput } from "../packages/work/src/billing/facts.ts";
import { billingRequestAbortMs } from "../packages/work/src/billing/http.ts";
import { brokerStripeBudgetMs } from "../apps/api/src/broker-client.ts";

const origin = "https://work.morrow.test";
const ws = "ws_cmd";
const org = "org_cmd";
const cookie = () => "__Host-morrow_session=" + randomBytes(32).toString("base64url");
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));

// Spies: a connector and a broker that record every touch.
function spies() {
  const touched = { opens: 0, broker: 0 };
  const connector = {
    open: async () => {
      touched.opens++;
      throw Error("NO_DATABASE_IN_THIS_TEST");
    },
  };
  const count = async () => {
    touched.broker++;
    throw Error("NO_BROKER_IN_THIS_TEST");
  };
  const broker = {
    customerEnsure: count,
    checkoutCreate: count,
    portalCreate: count,
    webhookVerify: count,
  };
  return { touched, connector, broker };
}
function request(method, path, { body, headers = {} } = {}) {
  const base = {
    Cookie: cookie(),
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
  const write =
    method === "GET"
      ? {}
      : {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Morrow-Request": "1",
          "Idempotency-Key": randomUUID(),
        };
  const merged = { ...base, ...write, ...headers };
  for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
  return new Request(origin + path, {
    method,
    headers: merged,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = { waitUntil() {} };

test("the purchase route table is closed: three routes under /morrow/, each with fixed actions", () => {
  assert.deepEqual(Object.keys(morrowPurchaseRoutes).sort(), [
    "GET /morrow/plans",
    "POST /morrow/checkout",
    "POST /morrow/portal",
  ]);
  assert.deepEqual(morrowPurchaseRoutes["POST /morrow/checkout"], ["subscribe"]);
  assert.deepEqual(morrowPurchaseRoutes["POST /morrow/portal"], ["billing_portal"]);
  for (const key of ["POST /morrow/topup", "GET /morrow/checkout", "__proto__", "toString", ""])
    assert.equal(isMorrowPurchaseRoute(key), false, key);
  assert.ok(Object.isFrozen(morrowPurchaseRoutes));
  assert.deepEqual(
    billingRoutes.map((r) => r.key),
    ["GET ", "GET /morrow/plans", "POST /morrow/checkout", "POST /morrow/portal"],
  );
});

test("the guard decides from the billing state: open subscribes, a bound or Shopify workspace is denied", () => {
  const scope = { organizationId: org, workspaceId: ws };
  const route = (patch = {}) => ({
    schemaVersion: 1,
    organizationId: org,
    workspaceId: ws,
    origin: "website",
    shopifyBoundAt: null,
    route: null,
    mode: null,
    routeFixedAt: null,
    fixingPaymentKey: null,
    revision: 1,
    ...patch,
  });
  const state = (r, associations = []) =>
    workspaceBillingState(
      parseWorkspaceBillingFacts(
        billingFactsInput(
          {
            route: r,
            associations,
            account: null,
            snapshot: null,
            conflicts: [],
            checkoutIntentPending: false,
          },
          scope,
        ),
        scope,
        "development",
      ),
      new Date().toISOString(),
      "development",
    );
  const open = guardPurchase(state(route()), "POST /morrow/checkout");
  assert.deepEqual(open, { allowed: true, actions: ["subscribe"] });
  // The portal needs a Morrow-direct customer: denied in phase open.
  assert.equal(guardPurchase(state(route()), "POST /morrow/portal").allowed, false);
  // A Shopify-bound workspace never reaches checkout.
  const bound = guardPurchase(
    state(route({ shopifyBoundAt: new Date(Date.now() - 1000).toISOString() })),
    "POST /morrow/checkout",
  );
  assert.equal(bound.allowed, false);
  assert.equal(bound.denial.code, "PURCHASE_ROUTE_MISMATCH");
  // A current store association too (the defence case of ADR-0022 item 5).
  const linked = guardPurchase(
    state(route(), [
      {
        installationId: "inst_1",
        storeId: "store_1",
        associatedAt: new Date(Date.now() - 1000).toISOString(),
        current: true,
      },
    ]),
    "POST /morrow/checkout",
  );
  assert.equal(linked.allowed, false);
  assert.throws(() => guardPurchase(state(route()), "POST /morrow/topup"), /UNMAPPED/);
});

test("bodies are closed: {priceKey} for checkout, {} for the portal", () => {
  const priceKey = "stripe:price:price_MorrowDevBeta0049";
  assert.deepEqual(parseCheckoutBody({ priceKey }), { priceKey });
  for (const body of [
    {},
    { priceKey, action: "subscribe" },
    { priceKey, route: "morrow_direct" },
    { priceKey: "price_MorrowDevBeta0049" },
    { priceKey: "stripe:price:" },
    [priceKey],
    null,
    "x",
  ])
    assert.equal(parseCheckoutBody(body), null, JSON.stringify(body));
  assert.equal(parsePortalBody({}), true);
  for (const body of [{ returnUrl: "https://evil.example" }, [], null])
    assert.equal(parsePortalBody(body), false);
});

test("every malformed or unmapped request is refused before any connection or broker call", async () => {
  const { touched, connector, broker } = spies();
  const api = createBillingApiHandler({
    origin,
    connector,
    environment: "development",
    broker,
    now: () => Date.now(),
  });
  const priceKey = "stripe:price:price_MorrowDevBeta0049";
  for (const [label, req, status] of [
    [
      "unmapped purchase path",
      request("POST", `/workspace/${ws}/billing/morrow/topup`, { body: {} }),
      404,
    ],
    ["unmapped read", request("GET", `/workspace/${ws}/billing/morrow/checkout`), 405],
    [
      "outside the prefix",
      request("POST", `/workspace/${ws}/billing/checkout`, { body: { priceKey } }),
      404,
    ],
    ["no cookie", request("GET", `/workspace/${ws}/billing`, { headers: { Cookie: null } }), 401],
    [
      "two cookies",
      request("GET", `/workspace/${ws}/billing`, {
        headers: { Cookie: cookie() + "; " + cookie() },
      }),
      401,
    ],
    [
      "no idempotency key",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, {
        body: { priceKey },
        headers: { "Idempotency-Key": null },
      }),
      400,
    ],
    [
      "foreign origin",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, {
        body: { priceKey },
        headers: { Origin: "https://evil.example" },
      }),
      403,
    ],
    [
      "cross-site",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, {
        body: { priceKey },
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
      403,
    ],
    [
      "no custom header",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, {
        body: { priceKey },
        headers: { "X-Morrow-Request": null },
      }),
      403,
    ],
    [
      "form content type",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, {
        body: "priceKey=x",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      403,
    ],
    [
      "an action in the body",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, {
        body: { priceKey, action: "billing_portal" },
      }),
      400,
    ],
    [
      "a price that is not a key",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, { body: { priceKey: "free" } }),
      400,
    ],
    [
      "a portal return URL",
      request("POST", `/workspace/${ws}/billing/morrow/portal`, { body: { returnUrl: origin } }),
      400,
    ],
    [
      "a body over 1 KiB",
      request("POST", `/workspace/${ws}/billing/morrow/checkout`, {
        body: { priceKey: "x".repeat(1100) },
      }),
      400,
    ],
    ["a query on the view", request("GET", `/workspace/${ws}/billing?route=morrow_direct`), 400],
    ["a bad workspace id", request("GET", `/workspace/${"%20"}/billing`), 400],
  ]) {
    const response = await api.fetch(req, {}, ctx);
    assert.equal(response.status, status, label);
    const body = await response.json();
    assert.equal(body.schemaVersion, 1, label);
    assert.ok(!("checkoutUrl" in body), label);
  }
  assert.deepEqual(touched, { opens: 0, broker: 0 });
  // With no broker Stripe adapters a purchase is 503 before any connection.
  const unbound = createBillingApiHandler({
    origin,
    connector,
    environment: "development",
    broker: null,
    now: () => Date.now(),
  });
  const held = await unbound.fetch(
    request("POST", `/workspace/${ws}/billing/morrow/checkout`, { body: { priceKey } }),
    {},
    ctx,
  );
  assert.equal(held.status, 503);
  assert.equal(touched.opens, 0);
  // No dependencies at all: 401, no network or database.
  const bare = createBillingApiHandler();
  assert.equal((await bare.fetch(request("GET", `/workspace/${ws}/billing`), {}, ctx)).status, 401);
  // Every response is no-store, never a cookie or CORS header.
  const r = await api.fetch(request("GET", `/workspace/${ws}/billing/morrow/x`), {}, ctx);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("the generalised guard: route-family prefixes, and PUT under the POST rules", async () => {
  const routes = Object.freeze([
    Object.freeze({ method: "GET", pattern: "/model-default", query: Object.freeze([]) }),
    Object.freeze({ method: "PUT", pattern: "/model-default", query: Object.freeze([]) }),
  ]);
  const guard = (req) =>
    guardWorkspaceRequest(origin, "settings", routes, req, new AbortController().signal, {
      bodyLimitBytes: 1024,
    }).then(
      (g) => g,
      (error) => {
        assert.ok(error instanceof WorkGuardError);
        return error.status;
      },
    );
  const path = `/workspace/${ws}/settings/model-default`;
  const ok = await guard(request("PUT", path, { body: { model: "m" } }));
  assert.equal(ok.route.method, "PUT");
  assert.match(ok.commandId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(ok.body, { model: "m" });
  for (const [headers, status] of [
    [{ Origin: null }, 403],
    [{ Origin: "https://evil.example" }, 403],
    [{ "X-Morrow-Request": null }, 403],
    [{ "Content-Type": "text/plain" }, 403],
    [{ "Idempotency-Key": null }, 400],
    [{ "Idempotency-Key": "not-a-uuid" }, 400],
    [{ "Sec-Fetch-Site": "same-site" }, 403],
    [{ Cookie: null }, 401],
    [{ Authorization: "Bearer x" }, 401],
  ])
    assert.equal(
      await guard(request("PUT", path, { body: {}, headers })),
      status,
      JSON.stringify(headers),
    );
  assert.equal(await guard(request("DELETE", path, { body: {} })), 405);
  assert.equal(await guard(request("GET", `/workspace/${ws}/settings/other`)), 404);
  assert.equal(await guard(request("GET", `/workspace/${ws}/work`)), 404);
  // Prefixes are fixed lowercase segments, never a parameter or a pattern.
  for (const prefix of ["", "Billing", "billing/:id", "a/b/c/d/e", "../x", "x*"])
    assert.throws(() => workspacePathPattern(prefix), /WORKSPACE_ROUTE_PREFIX_INVALID/, prefix);
  assert.ok(workspacePathPattern("billing").test(`/workspace/${ws}/billing/morrow/plans`));
  assert.ok(!workspacePathPattern("billing").test(`/workspace/${ws}/billingx`));
});

test("the api dispatch table: work, billing and the exact webhook path; everything else is P05's", async () => {
  for (const [path, owner] of [
    [`/workspace/${ws}/work`, "work"],
    [`/workspace/${ws}/work/tasks`, "work"],
    [`/workspace/${ws}/billing`, "billing"],
    [`/workspace/${ws}/billing/morrow/checkout`, "billing"],
    ["/api/billing/stripe/webhook", "stripe_webhook"],
    ["/api/billing/stripe/webhook/", "workspace"],
    ["/api/billing/stripe/webhookx", "workspace"],
    ["/api/billing/stripe", "workspace"],
    [`/workspace/${ws}/billingx`, "workspace"],
    [`/workspace/${ws}/connections`, "workspace"],
    [`/workspace/${ws}/store-links`, "workspace"],
    ["/workspaces", "workspace"],
  ])
    assert.equal(apiDispatch(path), owner, path);
  // The unbound Worker: billing 401 and the webhook 404, with no network or database.
  const worker = createWorkspaceApiWorker();
  const billing = await worker.fetch(request("GET", `/workspace/${ws}/billing`), {}, ctx);
  assert.equal(billing.status, 401);
  const webhook = await worker.fetch(
    new Request(origin + "/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=" + "a".repeat(64) },
      body: "{}",
    }),
    {},
    ctx,
  );
  assert.equal(webhook.status, 404);
  // The configured webhook handler: method, path, signature and size are checked before
  // the broker, and a rejected signature is 400 with no database access.
  const { touched, connector } = spies();
  let verified = 0;
  const handler = createStripeWebhookHandler({
    connector,
    environment: "development",
    now: () => Date.now(),
    broker: {
      customerEnsure: async () => assert.fail(),
      checkoutCreate: async () => assert.fail(),
      portalCreate: async () => assert.fail(),
      webhookVerify: async (raw, signature) => {
        verified++;
        assert.equal(Buffer.from(raw, "base64").toString("utf8"), '{"exact": "bytes"}');
        assert.equal(signature, "t=1,v1=" + "a".repeat(64));
        return { verdict: "rejected", receiptId: null, objectDigest: null, attributed: null };
      },
    },
  });
  const post = (
    headers = {},
    body = '{"exact": "bytes"}',
    method = "POST",
    path = "/api/billing/stripe/webhook",
  ) =>
    handler.fetch(
      new Request(origin + path, {
        method,
        headers: { "stripe-signature": "t=1,v1=" + "a".repeat(64), ...headers },
        body: method === "POST" ? body : undefined,
      }),
      {},
      ctx,
    );
  assert.equal((await post()).status, 400);
  assert.equal(verified, 1);
  assert.equal((await post({}, "", "GET")).status, 405);
  assert.equal((await post({ "stripe-signature": "" })).status, 400);
  assert.equal((await post({}, "x".repeat(262145))).status, 413);
  assert.equal((await post({}, "")).status, 400);
  assert.equal((await post({}, "{}", "POST", "/api/billing/stripe/webhook?x=1")).status, 404);
  assert.equal(verified, 1);
  assert.equal(touched.opens, 0);
  // A held broker is 503, so Stripe retries.
  const held = createStripeWebhookHandler({
    connector,
    environment: "development",
    now: () => Date.now(),
    broker: {
      customerEnsure: async () => assert.fail(),
      checkoutCreate: async () => assert.fail(),
      portalCreate: async () => assert.fail(),
      webhookVerify: async () => {
        throw Error("API_BROKER_HELD");
      },
    },
  });
  const heldResponse = await held.fetch(
    new Request(origin + "/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=" + "a".repeat(64) },
      body: "{}",
    }),
    {},
    ctx,
  );
  assert.equal(heldResponse.status, 503);
  assert.equal(touched.opens, 0);
});

test("the request's abort covers the database phase and both broker calls of a first checkout", () => {
  // 5 s of database, then the customer and the session, each the broker's budget plus the
  // RPC allowance the api races it with, and a second to spare: a slow but successful
  // pair is never cut short into "uncertain".
  assert.equal(brokerStripeBudgetMs, 8000);
  assert.equal(billingRequestAbortMs, 5000 + 2 * (brokerStripeBudgetMs + 500) + 1000);
});
