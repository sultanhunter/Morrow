// Shop-specific webhook subscriptions (docs/briefs/shopify-shop-specific-webhooks.md;
// apps/broker/src/shopify-webhooks.ts) over a faked vault and a faked Shopify (recorded
// GraphQL shapes; no network, no database). The broker, the only holder of the store token,
// lists the store's app/uninstalled and app/scopes_update subscriptions with one fixed
// document and creates only a missing one, with exactly the connector's webhook path built
// from its own configuration; every other subscription is left as it is. userErrors, 401,
// 429, THROTTLED, 5xx, timeouts and malformed replies map to closed outcomes; a create
// whose outcome is not proven is reconciled by listing before anything else. The vault
// steps run in their own transactions (pending ids, one target with its envelope, the
// record), counts only come back, and the token never leaves. Also: deliveries of both
// topics reach the connector's one signed path and the broker's one verification, whether
// the subscription is app-specific or shop-specific.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  decodeShopifyWebhookSyncResult,
  decodeShopifyWebhookVerdict,
  encodeShopifyWebhookSyncResult,
  parseConnectorWebhookOrigin,
  shopifyComplianceWebhookTopics,
  shopifyShopWebhookTopics,
  shopifyWebhookCallbackUrl,
  shopifyWebhookSyncLimits,
  shopifyWebhookTopics,
} from "../packages/identity/src/broker-protocol.ts";
import {
  classifyWebhookCreate,
  createShopifyWebhookSync,
  registerShopWebhooks,
  shopifyShopWebhookEnums,
  shopifyWebhookDocuments,
  shopifyWebhookListResult,
} from "../apps/broker/src/shopify-webhooks.ts";
import { createShopifyBroker } from "../apps/broker/src/shopify-install.ts";
import { shopifyApiVersion } from "../apps/broker/src/shopify.ts";
import {
  VaultError,
  createVaultKeyring,
  sealVaultRecord,
  vaultBytesHex,
  vaultStatements,
} from "../apps/broker/src/vault.ts";
import { parseConnectorConfiguration } from "../apps/shopify-connector/worker/environment.ts";
import { readWebhook } from "../apps/shopify-connector/worker/webhooks.ts";
import { shopifyAppToml } from "../scripts/shopify-app.mjs";

const kek = randomBytes(32).toString("hex");
const token = "shpat_" + randomBytes(16).toString("hex");
const secret = "shpss_" + randomBytes(16).toString("hex");
const shop = "dev-store-1.myshopify.com";
const appKey = "dev-store-1";
const origin = "https://connector.morrow.test";
const apiOrigin = "https://api.morrow.test";
const callbackUrl = `${origin}/shopify/a/${appKey}/webhooks`;
const graphqlUrl = `https://${shop}/admin/api/2026-10/graphql.json`;
const ids = {
  org: "org_hooks",
  ws: "ws_hooks",
  installation: "installation_hooks",
  credential: "credential_hooks",
};
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-broker-unit",
  branchId: "br-broker-unit",
  hostname: "ep-broker-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const connectorConfiguration = JSON.stringify({ schemaVersion: 1, origin, apiOrigin });
const env = (extra = {}) => ({
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
  CONNECTOR_CONFIGURATION_JSON: connectorConfiguration,
  ...extra,
});
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));

const gid = (id) => "gid://shopify/WebhookSubscription/" + id;
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

// A faked store's subscriptions, answering the two fixed documents the way Shopify does
// (recorded shapes: nodes of id, topic and uri; userErrors on a taken address). `script`
// replaces the reply of the n-th request (1-based) to fault it.
function store(options = {}) {
  const seeded = options.subscriptions ?? [];
  const state = {
    subscriptions: [...seeded],
    next: Math.max(9000, ...seeded.map((s) => Number(s.id))) + 1,
    requests: [],
  };
  const reply = (body) => {
    if (body.query === shopifyWebhookDocuments.subscriptions) {
      const nodes = state.subscriptions.filter((s) =>
        ["APP_UNINSTALLED", "APP_SCOPES_UPDATE"].includes(s.topic),
      );
      return json({
        data: {
          webhookSubscriptions: {
            nodes: nodes.map((s) => ({ id: gid(s.id), topic: s.topic, uri: s.uri })),
            pageInfo: { hasNextPage: options.hasNextPage ?? false },
          },
        },
        extensions: { cost: { requestedQueryCost: 27, actualQueryCost: 3 } },
      });
    }
    if (body.query === shopifyWebhookDocuments.subscriptionCreate) {
      const { topic, uri } = body.variables;
      if (state.subscriptions.some((s) => s.topic === topic && s.uri === uri))
        return json({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [
                {
                  field: ["webhookSubscription", "callbackUrl"],
                  message: "Address for this topic has already been taken",
                },
              ],
            },
          },
        });
      const created = { id: String(state.next++), topic, uri };
      state.subscriptions.push(created);
      return json({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: { id: gid(created.id), topic, uri },
            userErrors: [],
          },
        },
        extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10 } },
      });
    }
    return json({ errors: [{ message: "unexpected document" }] });
  };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    state.requests.push({
      url,
      method: init.method,
      redirect: init.redirect,
      headers: new Headers(init.headers),
      body,
    });
    const scripted = options.script?.[state.requests.length];
    if (scripted) return scripted(body, () => reply(body));
    return reply(body);
  };
  return { state, fetch };
}
const clockAt = () => {
  const clock = { ms: 1_760_950_000_000 };
  return {
    clock,
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.ms += ms;
    },
  };
};
async function register(options = {}) {
  const s = store(options);
  const c = clockAt();
  // Each request takes `advanceMs` of the clock (a slow store).
  const fetch = async (url, init) => {
    c.clock.ms += options.advanceMs ?? 0;
    return s.fetch(url, init);
  };
  const outcome = await registerShopWebhooks(
    { transaction: null, fetch, now: c.now, sleep: c.sleep },
    shop,
    token,
    options.callbackUrl ?? callbackUrl,
    c.clock.ms + (options.budgetMs ?? 15000),
  );
  return { outcome, ...s, operations: s.state.requests.map((r) => operation(r.body)) };
}
const operation = (body) =>
  body.query === shopifyWebhookDocuments.subscriptions
    ? "list"
    : body.query === shopifyWebhookDocuments.subscriptionCreate
      ? "create:" + body.variables.topic
      : "other";
const ours = (s) => s.state.subscriptions.filter((x) => x.uri === callbackUrl);

test("documents: two fixed documents in the pinned version, uri only, no caller text", () => {
  assert.equal(shopifyApiVersion, "2026-10");
  assert.deepEqual(Object.keys(shopifyWebhookDocuments), ["subscriptions", "subscriptionCreate"]);
  // The list takes no variables; the create takes the topic's enum value and the URL.
  assert.doesNotMatch(shopifyWebhookDocuments.subscriptions, /\$/);
  assert.match(
    shopifyWebhookDocuments.subscriptions,
    /topics: \[APP_UNINSTALLED, APP_SCOPES_UPDATE\]/,
  );
  assert.deepEqual(
    [...shopifyWebhookDocuments.subscriptionCreate.matchAll(/\$([a-zA-Z]+):/g)].map((m) => m[1]),
    ["topic", "uri"],
  );
  // 2026-10 deprecates endpoint and callbackUrl: neither is sent or read.
  for (const document of Object.values(shopifyWebhookDocuments)) {
    assert.doesNotMatch(document, /endpoint|callbackUrl|webhookSubscriptionUpdate|Delete/);
    assert.match(document, /^(query|mutation) Webhook/);
  }
  assert.deepEqual(
    shopifyShopWebhookEnums.map((t) => [t.topic, t.value]),
    [
      ["app/uninstalled", "APP_UNINSTALLED"],
      ["app/scopes_update", "APP_SCOPES_UPDATE"],
    ],
  );
  assert.deepEqual(
    shopifyShopWebhookEnums.map((t) => t.topic),
    [...shopifyShopWebhookTopics],
  );
  // With the TOML's three compliance topics, exactly the five topics the broker accepts.
  assert.deepEqual(
    [...shopifyComplianceWebhookTopics, ...shopifyShopWebhookTopics].sort(),
    [...shopifyWebhookTopics].sort(),
  );
});

test("register: lists, creates only the missing topics with exactly the connector's URL, never touches another", async () => {
  const foreign = [
    { id: "501", topic: "APP_UNINSTALLED", uri: "https://other.example.test/shopify/webhooks" },
    { id: "502", topic: "APP_UNINSTALLED", uri: "pubsub://project:topic" },
    { id: "503", topic: "APP_SCOPES_UPDATE", uri: callbackUrl + "/" },
    { id: "504", topic: "APP_SCOPES_UPDATE", uri: origin + "/shopify/a/another-app/webhooks" },
  ];
  const r = await register({ subscriptions: foreign });
  assert.deepEqual(r.outcome, {
    status: "registered",
    uninstalledId: "9001",
    scopesUpdateId: "9002",
  });
  assert.deepEqual(r.operations, ["list", "create:APP_UNINSTALLED", "create:APP_SCOPES_UPDATE"]);
  // Every request: one POST to the store's own Admin GraphQL in the pinned version, the
  // token in its header, redirects never followed; the list sends no variables.
  for (const request of r.state.requests) {
    assert.equal(request.url, graphqlUrl);
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("x-shopify-access-token"), token);
  }
  assert.deepEqual(Object.keys(r.state.requests[0].body), ["query"]);
  assert.deepEqual(r.state.requests[1].body.variables, {
    topic: "APP_UNINSTALLED",
    uri: callbackUrl,
  });
  assert.deepEqual(r.state.requests[2].body.variables, {
    topic: "APP_SCOPES_UPDATE",
    uri: callbackUrl,
  });
  // The other subscriptions (another address, Pub/Sub, a near-miss URL, another app's path)
  // are exactly as they were.
  assert.deepEqual(r.state.subscriptions.slice(0, 4), foreign);
  assert.equal(r.state.subscriptions.length, 6);
  // Idempotent: a second round lists, finds both and creates nothing.
  const again = await registerShopWebhooks(
    {
      transaction: null,
      fetch: store({ subscriptions: r.state.subscriptions }).fetch,
      now: Date.now,
    },
    shop,
    token,
    callbackUrl,
    Date.now() + 15000,
  );
  assert.deepEqual(again, r.outcome);
});

test("register: both present is one list; one present creates only the other", async () => {
  const both = await register({
    subscriptions: [
      { id: "11", topic: "APP_SCOPES_UPDATE", uri: callbackUrl },
      { id: "10", topic: "APP_UNINSTALLED", uri: callbackUrl },
    ],
  });
  assert.deepEqual(both.outcome, {
    status: "registered",
    uninstalledId: "10",
    scopesUpdateId: "11",
  });
  assert.deepEqual(both.operations, ["list"]);
  const one = await register({
    subscriptions: [{ id: "10", topic: "APP_UNINSTALLED", uri: callbackUrl }],
  });
  assert.deepEqual(one.outcome, {
    status: "registered",
    uninstalledId: "10",
    scopesUpdateId: "9001",
  });
  assert.deepEqual(one.operations, ["list", "create:APP_SCOPES_UPDATE"]);
});

test("register: a list that fails or is partial creates nothing", async () => {
  const fault = (response) => ({ 1: () => response() });
  const cases = [
    [
      "401",
      fault(() => json({ errors: "[API] Invalid API key or access token" }, 401)),
      "unauthorized",
    ],
    ["429", fault(() => json({ errors: "Throttled" }, 429)), "failed"],
    ["500", fault(() => json({ errors: "Internal" }, 500)), "failed"],
    ["502", fault(() => new Response("bad gateway", { status: 502 })), "failed"],
    [
      "302",
      fault(() => new Response(null, { status: 302, headers: { location: "https://x.test" } })),
      "failed",
    ],
    [
      "timeout",
      fault(() => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
      "failed",
    ],
    ["graphql error", fault(() => json({ errors: [{ message: "Internal error" }] })), "failed"],
    ["not json", fault(() => new Response("<html>", { status: 200 })), "failed"],
    ["oversize", fault(() => new Response("x".repeat(70000), { status: 200 })), "failed"],
    [
      "malformed node",
      fault(() =>
        json({
          data: {
            webhookSubscriptions: {
              nodes: [{ id: "WebhookSubscription/1", topic: "APP_UNINSTALLED", uri: callbackUrl }],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ),
      "failed",
    ],
  ];
  for (const [name, script, status] of cases) {
    const r = await register({ script });
    assert.deepEqual(r.outcome, { status }, name);
    assert.deepEqual(r.operations, ["list"], name);
    assert.equal(r.state.subscriptions.length, 0, name);
  }
  // A page with more subscriptions than it shows proves no absence.
  const partial = await register({ hasNextPage: true });
  assert.deepEqual(partial.outcome, { status: "failed" });
  assert.deepEqual(partial.operations, ["list"]);
  // But both found on a partial page are registered.
  const found = await register({
    hasNextPage: true,
    subscriptions: [
      { id: "10", topic: "APP_UNINSTALLED", uri: callbackUrl },
      { id: "11", topic: "APP_SCOPES_UPDATE", uri: callbackUrl },
    ],
  });
  assert.equal(found.outcome.status, "registered");
  // THROTTLED once on the list waits for the bucket and lists again within the budget.
  const throttled = await register({
    script: {
      1: () =>
        json({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: {
            cost: {
              requestedQueryCost: 27,
              throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
            },
          },
        }),
    },
  });
  assert.equal(throttled.outcome.status, "registered");
  assert.deepEqual(throttled.operations, [
    "list",
    "list",
    "create:APP_UNINSTALLED",
    "create:APP_SCOPES_UPDATE",
  ]);
});

test("register: a create that proves nothing ran is failed with no reconciling list", async () => {
  const throttledGraphql = () =>
    json({
      data: { webhookSubscriptionCreate: null },
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: {
        cost: {
          requestedQueryCost: 10,
          throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
        },
      },
    });
  const cases = [
    ["429", { 2: () => json({ errors: "Throttled" }, 429) }],
    ["THROTTLED twice", { 2: throttledGraphql, 3: throttledGraphql }],
    [
      "ACCESS_DENIED",
      {
        2: () =>
          json({
            data: { webhookSubscriptionCreate: null },
            errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }],
          }),
      },
    ],
  ];
  for (const [name, script] of cases) {
    const r = await register({ script });
    assert.deepEqual(r.outcome, { status: "failed" }, name);
    assert.ok(!r.operations.slice(2).includes("list"), name);
    assert.equal(ours(r).length, 0, name);
  }
  // THROTTLED once is resent inside the budget and creates.
  const once = await register({ script: { 2: throttledGraphql } });
  assert.equal(once.outcome.status, "registered");
  assert.deepEqual(once.operations, [
    "list",
    "create:APP_UNINSTALLED",
    "create:APP_UNINSTALLED",
    "create:APP_SCOPES_UPDATE",
  ]);
  // No time left before the first create: nothing is sent; none before the list either.
  const late = await register({ budgetMs: 2000, advanceMs: 2500 });
  assert.deepEqual(late.outcome, { status: "failed" });
  assert.deepEqual(late.operations, ["list"]);
  const none = await register({ budgetMs: 0 });
  assert.deepEqual(none.outcome, { status: "failed" });
  assert.deepEqual(none.operations, []);
  // A refused token on a create is unauthorized.
  const revoked = await register({ script: { 3: () => json({ errors: "Unauthorized" }, 401) } });
  assert.deepEqual(revoked.outcome, { status: "unauthorized" });
  assert.deepEqual(revoked.operations, [
    "list",
    "create:APP_UNINSTALLED",
    "create:APP_SCOPES_UPDATE",
  ]);
});

test("register: userErrors and unproven replies are reconciled by listing before anything else", async () => {
  // A concurrent sync created it between the list and the create: userErrors, then the
  // reconciling list shows it.
  const raced = await register({
    script: {
      2: (body, reply) => {
        reply(); // the other sync's create lands first
        return json({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [
                {
                  field: ["webhookSubscription", "callbackUrl"],
                  message: "Address for this topic has already been taken",
                },
              ],
            },
          },
        });
      },
    },
  });
  assert.deepEqual(raced.outcome, { status: "failed" });
  assert.deepEqual(raced.operations, ["list", "create:APP_UNINSTALLED", "list"]);
  assert.equal(ours(raced).length, 1);
  // A 5xx after Shopify created it: the list shows it; the other topic waits for the next
  // round, which lists before it creates.
  const lost = await register({ script: { 2: (_b, reply) => (reply(), json({}, 503)) } });
  assert.deepEqual(lost.outcome, { status: "failed" });
  assert.deepEqual(lost.operations, ["list", "create:APP_UNINSTALLED", "list"]);
  const next = await registerShopWebhooks(
    {
      transaction: null,
      fetch: store({ subscriptions: lost.state.subscriptions }).fetch,
      now: Date.now,
    },
    shop,
    token,
    callbackUrl,
    Date.now() + 15000,
  );
  assert.deepEqual(next, { status: "registered", uninstalledId: "9001", scopesUpdateId: "9002" });
  // On the last create, the reconciling list completes the pair.
  const lastLost = await register({ script: { 3: (_b, reply) => (reply(), json({}, 500)) } });
  assert.deepEqual(lastLost.outcome, {
    status: "registered",
    uninstalledId: "9001",
    scopesUpdateId: "9002",
  });
  assert.deepEqual(lastLost.operations, [
    "list",
    "create:APP_UNINSTALLED",
    "create:APP_SCOPES_UPDATE",
    "list",
  ]);
  // Unproven, not created, and the list proves it absent: failed (retried after a list).
  for (const [name, fault] of [
    ["503", () => json({}, 503)],
    [
      "timeout",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
    ["lost connection", () => Promise.reject(new TypeError("network connection lost"))],
    ["graphql error", () => json({ errors: [{ message: "Internal error" }] })],
    ["malformed", () => new Response("{", { status: 200 })],
    ["404", () => json({ errors: "Not Found" }, 404)],
    [
      "another uri",
      () =>
        json({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: gid(77), topic: "APP_UNINSTALLED", uri: "https://x.test" },
              userErrors: [],
            },
          },
        }),
    ],
    [
      "another topic",
      () =>
        json({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: { id: gid(77), topic: "APP_SCOPES_UPDATE", uri: callbackUrl },
              userErrors: [],
            },
          },
        }),
    ],
  ]) {
    const r = await register({ script: { 2: fault } });
    assert.deepEqual(r.outcome, { status: "failed" }, name);
    assert.deepEqual(r.operations, ["list", "create:APP_UNINSTALLED", "list"], name);
  }
  // Unproven, and the reconciling list fails too: unknown (never promoted to registered).
  const unknown = await register({
    script: { 2: () => json({}, 503), 3: () => json({}, 503) },
  });
  assert.deepEqual(unknown.outcome, { status: "unknown" });
  // ...or shows a partial page without it: still unknown.
  const partial = await register({
    script: {
      2: () => json({}, 503),
      3: () =>
        json({
          data: {
            webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: true } },
          },
        }),
    },
  });
  assert.deepEqual(partial.outcome, { status: "unknown" });
  // userErrors whose reconciling list fails: failed (Shopify created nothing).
  const rejected = await register({
    script: {
      2: () =>
        json({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [{ field: ["webhookSubscription", "uri"], message: "Invalid" }],
            },
          },
        }),
      3: () => json({}, 500),
    },
  });
  assert.deepEqual(rejected.outcome, { status: "failed" });
  // A refused token on the reconciling list is unauthorized.
  const revoked = await register({
    script: { 2: () => json({}, 503), 3: () => json({ errors: "Unauthorized" }, 401) },
  });
  assert.deepEqual(revoked.outcome, { status: "unauthorized" });
});

test("classify and list: closed shapes only", () => {
  const created = (subscription, userErrors = []) =>
    classifyWebhookCreate(
      {
        kind: "data",
        data: { webhookSubscriptionCreate: { webhookSubscription: subscription, userErrors } },
        requestId: null,
      },
      "APP_UNINSTALLED",
      callbackUrl,
    );
  assert.deepEqual(created({ id: gid(5), topic: "APP_UNINSTALLED", uri: callbackUrl }), {
    kind: "created",
    id: "5",
  });
  assert.deepEqual(created(null, [{ field: null, message: "x" }]), { kind: "rejected" });
  assert.deepEqual(created({ id: "5", topic: "APP_UNINSTALLED", uri: callbackUrl }), {
    kind: "uncertain",
  });
  assert.deepEqual(created({ id: gid(0), topic: "APP_UNINSTALLED", uri: callbackUrl }), {
    kind: "uncertain",
  });
  assert.deepEqual(
    classifyWebhookCreate(
      { kind: "data", data: {}, requestId: null },
      "APP_UNINSTALLED",
      callbackUrl,
    ),
    { kind: "uncertain" },
  );
  for (const kind of ["not_sent", "throttled", "access_denied"])
    assert.deepEqual(classifyWebhookCreate({ kind }, "APP_UNINSTALLED", callbackUrl), {
      kind: "not_created",
    });
  for (const kind of ["transport", "server_error", "status", "graphql_error", "malformed"])
    assert.deepEqual(classifyWebhookCreate({ kind }, "APP_UNINSTALLED", callbackUrl), {
      kind: "uncertain",
    });
  assert.deepEqual(
    classifyWebhookCreate({ kind: "unauthorized" }, "APP_UNINSTALLED", callbackUrl),
    {
      kind: "unauthorized",
    },
  );
  const listed = shopifyWebhookListResult(
    {
      webhookSubscriptions: {
        nodes: [
          { id: gid(1), topic: "APP_UNINSTALLED", uri: callbackUrl },
          { id: gid(2), topic: "ORDERS_CREATE", uri: callbackUrl },
          { id: gid(3), topic: "APP_SCOPES_UPDATE", uri: "https://x.test" },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
    callbackUrl,
  );
  assert.deepEqual([...listed.found], [["app/uninstalled", "1"]]);
  assert.equal(listed.complete, true);
  assert.equal(
    shopifyWebhookListResult({ webhookSubscriptions: { nodes: [], pageInfo: {} } }, callbackUrl),
    null,
  );
  assert.equal(
    shopifyWebhookListResult(
      {
        webhookSubscriptions: {
          nodes: Array.from({ length: 26 }, (_, i) => ({
            id: gid(i + 1),
            topic: "APP_UNINSTALLED",
            uri: "https://x.test/" + i,
          })),
          pageInfo: { hasNextPage: false },
        },
      },
      callbackUrl,
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// The sync: the vault steps and the counts.
async function vaultFake(options = {}) {
  const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
  const installations = options.installations ?? [
    { id: ids.installation, appKey, shop, version: "2" },
  ];
  const envelopes = new Map();
  for (const i of installations)
    envelopes.set(
      i.id,
      await sealVaultRecord(
        keyring,
        {
          kind: "shopify_offline_token",
          organizationId: ids.org,
          workspaceId: ids.ws,
          credentialId: ids.credential,
          subjectId: i.sealedSubject ?? i.id,
          provider: "shopify",
          version: Number(i.version),
        },
        new TextEncoder().encode(i.token ?? token),
      ),
    );
  const events = [];
  const records = [];
  const handlers = {
    [vaultStatements.shopifyWebhookRegistrationsPending]: () => {
      events.push("pending");
      if (options.pendingRows) return options.pendingRows;
      return installations.map((i) => ({ installation_id: i.id }));
    },
    [vaultStatements.shopifyWebhookTarget]: ([id]) => {
      events.push("target:" + id);
      const i = installations.find((x) => x.id === id);
      const none = (outcome, version = null) => [
        {
          outcome,
          organization_id: null,
          workspace_id: null,
          app_key: null,
          shop_domain: null,
          credential_id: null,
          credential_version: version,
          kek_version: null,
          wrapped_key: null,
          sealed_value: null,
        },
      ];
      if (!i || i.target === "not_found") return none("not_found");
      if (i.target === "credential_unavailable") return none("credential_unavailable", i.version);
      const e = envelopes.get(id);
      return [
        {
          outcome: "found",
          organization_id: ids.org,
          workspace_id: ids.ws,
          app_key: i.appKey,
          shop_domain: i.shop,
          credential_id: ids.credential,
          credential_version: i.version,
          kek_version: "1",
          wrapped_key: vaultBytesHex(e.wrappedKey),
          sealed_value: vaultBytesHex(e.sealedValue),
        },
      ];
    },
    [vaultStatements.shopifyWebhookRegistrationRecord]: (values) => {
      events.push("record:" + values[0]);
      records.push(values);
      if (options.recordThrows) throw new VaultError("VAULT_OUTCOME_UNKNOWN");
      return [{ outcome: options.recordOutcome ?? "recorded" }];
    },
  };
  const budgets = [];
  const transaction = async (vault, budgetMs, body) => {
    assert.ok(vault.keyring && vault.databasePassword && vault.binding, "the vault capability");
    assert.ok(
      Number.isSafeInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 3000,
      String(budgetMs),
    );
    budgets.push(budgetMs);
    events.push("begin");
    if (options.gate) await options.gate;
    const value = await body(async (text, values) => {
      const handler = handlers[text];
      assert.ok(handler, "registered statement");
      assert.ok(values.every((x) => typeof x === "string"));
      return handler(values);
    });
    events.push("commit");
    return value;
  };
  return { events, records, transaction, budgets };
}
async function syncHarness(options = {}) {
  const vault = await vaultFake(options);
  const shopify = store(options);
  const c = clockAt();
  const fetch = async (url, init) => {
    vault.events.push("fetch");
    if (options.fetchAdvancesMs) c.clock.ms += options.fetchAdvancesMs;
    return shopify.fetch(url, init);
  };
  const sync = createShopifyWebhookSync({
    transaction: vault.transaction,
    fetch,
    now: c.now,
    sleep: c.sleep,
  });
  return { ...vault, shopify, sync, clock: c.clock };
}
const holdCode = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code ?? error.message;
  }
  return "resolved";
};

test("sync: pending ids alone, then the target, Shopify and the record; counts only", async () => {
  logs.length = 0;
  const h = await syncHarness();
  const result = decodeShopifyWebhookSyncResult(await h.sync.sync(env(), 15000));
  assert.deepEqual(result, {
    checked: 1,
    registered: 1,
    failed: 0,
    unknown: 0,
    unauthorized: 0,
    skipped: 0,
  });
  // The pending read commits alone before anything else; the target commits before any
  // request to Shopify; the record follows the requests in its own transaction.
  assert.deepEqual(h.events, [
    "begin",
    "pending",
    "commit",
    "begin",
    "target:" + ids.installation,
    "commit",
    "fetch",
    "fetch",
    "fetch",
    "begin",
    "record:" + ids.installation,
    "commit",
  ]);
  assert.deepEqual(h.records, [[ids.installation, "2", "registered", "9001", "9002"]]);
  // The URL is the connector's own origin and the target's app key.
  assert.deepEqual(
    h.shopify.state.subscriptions.map((s) => s.uri),
    [callbackUrl, callbackUrl],
  );
  // The token stays in the broker: not in the result, the record or any log.
  const result1 = await (await syncHarness()).sync.sync(env(), 15000);
  for (const text of [result1, JSON.stringify(h.records), logs.join("\n")]) {
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(shop));
  }
});

test("sync: each installation's own app path, failed, unauthorized and skipped outcomes", async () => {
  const other = "other-store.myshopify.com";
  const h = await syncHarness({
    installations: [
      { id: "installation_a", appKey: "app-a", shop, version: "1" },
      { id: "installation_b", appKey: "app-b", shop: other, version: "3" },
      { id: "installation_gone", appKey: "app-c", shop, version: "1", target: "not_found" },
      {
        id: "installation_wrong",
        appKey: "app-d",
        shop,
        version: "1",
        sealedSubject: "installation_other",
      },
      {
        id: "installation_nocred",
        appKey: "app-e",
        shop,
        version: "1",
        target: "credential_unavailable",
      },
    ],
  });
  const counts = decodeShopifyWebhookSyncResult(await h.sync.sync(env(), 25000));
  assert.deepEqual(counts, {
    checked: 5,
    registered: 2,
    failed: 2,
    unknown: 0,
    unauthorized: 0,
    skipped: 1,
  });
  const urls = h.shopify.state.requests
    .filter((r) => r.body.variables)
    .map((r) => [new URL(r.url).host, r.body.variables.uri]);
  assert.deepEqual(urls, [
    [shop, `${origin}/shopify/a/app-a/webhooks`],
    [shop, `${origin}/shopify/a/app-a/webhooks`],
    [other, `${origin}/shopify/a/app-b/webhooks`],
    [other, `${origin}/shopify/a/app-b/webhooks`],
  ]);
  // A target that is gone sends nothing and records nothing. One with no active envelope
  // for its current version, or whose envelope does not open for this installation, sends
  // nothing and is recorded failed for that version (it waits for its backoff instead of
  // heading every pending list).
  assert.deepEqual(
    h.records.map((r) => [r[0], r[1], r[2], r[3], r[4]]),
    [
      ["installation_a", "1", "registered", "9001", "9002"],
      ["installation_b", "3", "registered", "9003", "9004"],
      ["installation_wrong", "1", "failed", "", ""],
      ["installation_nocred", "1", "failed", "", ""],
    ],
  );
  // Unauthorized and failed are recorded with no ids (the empty string, NULL in SQL).
  const revoked = await syncHarness({ script: { 1: () => json({ errors: "x" }, 401) } });
  assert.equal(
    decodeShopifyWebhookSyncResult(await revoked.sync.sync(env(), 15000)).unauthorized,
    1,
  );
  assert.deepEqual(revoked.records, [[ids.installation, "2", "unauthorized", "", ""]]);
  const down = await syncHarness({ script: { 1: () => json({}, 500) } });
  assert.equal(decodeShopifyWebhookSyncResult(await down.sync.sync(env(), 15000)).failed, 1);
  assert.deepEqual(down.records, [[ids.installation, "2", "failed", "", ""]]);
  const unknown = await syncHarness({ script: { 2: () => json({}, 503), 3: () => json({}, 503) } });
  assert.equal(decodeShopifyWebhookSyncResult(await unknown.sync.sync(env(), 15000)).unknown, 1);
  assert.deepEqual(unknown.records, [[ids.installation, "2", "unknown", "", ""]]);
  // A record that is stale (a newer token, or the installation ended) or whose outcome is
  // unknown counts as skipped; the installation stays pending.
  for (const options of [{ recordOutcome: "stale" }, { recordThrows: true }]) {
    const r = await syncHarness(options);
    assert.equal(decodeShopifyWebhookSyncResult(await r.sync.sync(env(), 15000)).skipped, 1);
  }
});

test("sync: closed budget, held without the vault or the connector origin, one per isolate", async () => {
  const h = await syncHarness();
  for (const budget of [
    undefined,
    "15000",
    1999,
    25001,
    1.5,
    Number.NaN,
    shopifyWebhookSyncLimits.budgetMaxMs + 1,
  ])
    assert.equal(await holdCode(h.sync.sync(env(), budget)), "BUDGET_INVALID");
  for (const extra of [
    { CONNECTOR_CONFIGURATION_JSON: undefined },
    { CONNECTOR_CONFIGURATION_JSON: "{}" },
    {
      CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
        schemaVersion: 1,
        origin: origin + "/x",
        apiOrigin,
      }),
    },
    {
      CONNECTOR_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, origin, apiOrigin: origin }),
    },
    { MORROW_VAULT_KEK_V1: undefined },
  ]) {
    const e = env(extra);
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete e[k];
    assert.equal(await holdCode(h.sync.sync(e, 15000)), "WEBHOOKS_UNAVAILABLE");
  }
  assert.deepEqual(h.events, []);
  // One sync per isolate at a time.
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const busy = await syncHarness({ gate });
  const e = env();
  const first = busy.sync.sync(e, 15000);
  for (let i = 0; i < 20 && busy.events.length === 0; i++) await new Promise(setImmediate);
  assert.equal(await holdCode(busy.sync.sync(e, 15000)), "WEBHOOKS_BUSY");
  open();
  assert.equal(decodeShopifyWebhookSyncResult(await first).registered, 1);
  // A pending list that is not ids only holds the whole sync (the connector logs it).
  for (const pendingRows of [
    [{ installation_id: "bad id!" }],
    [{ installation_id: "a", extra: "x" }],
    Array.from({ length: 11 }, (_, i) => ({ installation_id: "i" + i })),
  ]) {
    const bad = await syncHarness({ pendingRows });
    assert.equal(await holdCode(bad.sync.sync(env(), 15000)), "VAULT_RECORD_INVALID");
  }
});

test("sync: an installation starts only with a whole round's time left", async () => {
  const h = await syncHarness({
    fetchAdvancesMs: 3000,
    installations: [
      { id: "installation_a", appKey: "app-a", shop, version: "1" },
      { id: "installation_b", appKey: "app-b", shop, version: "1" },
      { id: "installation_c", appKey: "app-c", shop, version: "1" },
    ],
  });
  const counts = decodeShopifyWebhookSyncResult(await h.sync.sync(env(), 15000));
  // a: a list and two creates (9 s of the 13 s Shopify may use); b starts with 6 s left, its
  // list and first create fit, its second create has no time (failed, retried after a
  // list); c never starts (under 4 s left).
  assert.deepEqual(counts, {
    checked: 2,
    registered: 1,
    failed: 1,
    unknown: 0,
    unauthorized: 0,
    skipped: 0,
  });
  assert.deepEqual(
    h.records.map((r) => [r[0], r[2]]),
    [
      ["installation_a", "registered"],
      ["installation_b", "failed"],
    ],
  );
  assert.ok(h.budgets.every((b) => b >= 1 && b <= 3000));
});

test("protocol: the connector origin, the callback URL and the closed counts", () => {
  for (const [json, environment] of [
    [connectorConfiguration, "staging"],
    [connectorConfiguration, "development"],
    [
      JSON.stringify({ schemaVersion: 1, origin: "http://127.0.0.1:8787", apiOrigin }),
      "development",
    ],
  ]) {
    assert.equal(parseConnectorWebhookOrigin(json, environment), JSON.parse(json).origin);
    // The broker reads it exactly as the connector does.
    assert.equal(parseConnectorConfiguration(json, environment).origin, JSON.parse(json).origin);
  }
  for (const [json, environment] of [
    [JSON.stringify({ schemaVersion: 1, origin: "http://127.0.0.1:8787", apiOrigin }), "staging"],
    [JSON.stringify({ schemaVersion: 1, origin: "http://c.test", apiOrigin }), "development"],
    [JSON.stringify({ schemaVersion: 1, origin: origin + "/", apiOrigin }), "staging"],
    [JSON.stringify({ schemaVersion: 1, origin: "https://u:p@c.test", apiOrigin }), "staging"],
    [JSON.stringify({ schemaVersion: 1, origin: "https://c.test:8443", apiOrigin }), "staging"],
    [JSON.stringify({ schemaVersion: 2, origin, apiOrigin }), "staging"],
    [JSON.stringify({ schemaVersion: 1, origin, apiOrigin, extra: 1 }), "staging"],
    [JSON.stringify({ schemaVersion: 1, origin }), "staging"],
    [JSON.stringify({ schemaVersion: 1, origin, apiOrigin: origin }), "staging"],
    ["not json", "staging"],
    [undefined, "staging"],
    ["{" + " ".repeat(1100) + "}", "staging"],
  ]) {
    assert.throws(() => parseConnectorWebhookOrigin(json, environment), undefined, String(json));
    assert.equal(parseConnectorConfiguration(json, environment), null, String(json));
  }
  assert.equal(shopifyWebhookCallbackUrl(origin, appKey), callbackUrl);
  for (const bad of ["", "A", "ab", "a/b", "a..b?", "-ab", "x".repeat(64)])
    assert.throws(() => shopifyWebhookCallbackUrl(origin, bad));
  // The app TOML's compliance subscription and the shop-specific ones name the same path.
  const staging = "https://morrow-staging-connector.example.workers.dev";
  const toml = shopifyAppToml({
    environment: "staging",
    "app-key": appKey,
    "client-id": "c".repeat(32),
    name: "Morrow",
    "connector-origin": staging,
  });
  assert.ok(toml.includes(`uri = "${shopifyWebhookCallbackUrl(staging, appKey)}"`), toml);
  const counts = {
    checked: 4,
    registered: 1,
    failed: 1,
    unknown: 1,
    unauthorized: 0,
    skipped: 1,
  };
  assert.deepEqual(decodeShopifyWebhookSyncResult(encodeShopifyWebhookSyncResult(counts)), counts);
  for (const bad of [
    { ...counts, checked: 5 },
    { ...counts, skipped: -1, checked: 2 },
    { ...counts, checked: 11, skipped: 8 },
    { ...counts, failed: 1.5 },
  ])
    assert.throws(() => encodeShopifyWebhookSyncResult(bad));
  for (const text of [
    "{}",
    JSON.stringify({ schemaVersion: 1, ...counts, extra: 0 }),
    JSON.stringify({ schemaVersion: 2, ...counts }),
  ])
    assert.throws(() => decodeShopifyWebhookSyncResult(text));
});

// ---------------------------------------------------------------------------
// Webhook receipt: one signed path for both kinds of subscription.
test("receipt: app/uninstalled and app/scopes_update reach the same path and verification, shop-specific or app-specific", async () => {
  const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
  const envelope = await sealVaultRecord(
    keyring,
    { kind: "app_secret", appKey, provider: "shopify", version: 1 },
    new TextEncoder().encode(secret),
  );
  const recorded = [];
  const inbox = new Map();
  const handlers = {
    [vaultStatements.appSecretGet]: () => [
      {
        outcome: "found",
        version: "1",
        kek_version: "1",
        wrapped_key: vaultBytesHex(envelope.wrappedKey),
        sealed_value: vaultBytesHex(envelope.sealedValue),
      },
    ],
    [vaultStatements.shopifyWebhookRecord]: ([key, domain, topic, webhookId, apiVersion, body]) => {
      recorded.push({ key, domain, topic, webhookId, apiVersion, body: JSON.parse(body) });
      const existing = inbox.get(webhookId);
      if (existing) return [{ outcome: "duplicate", inbox_id: existing, settled: "false" }];
      const id = randomUUID();
      inbox.set(webhookId, id);
      return [{ outcome: "recorded", inbox_id: id, settled: "false" }];
    },
  };
  const broker = createShopifyBroker({
    transaction: async (_vault, _budget, body) =>
      body(async (text, values) => handlers[text](values)),
    fetch: async () => {
      throw Error("no Shopify call on a delivery");
    },
    now: () => Date.now(),
  });
  const e = env();
  const deliveries = [
    ["app/uninstalled", { id: 987, name: "Dev", myshopify_domain: shop }],
    ["app/scopes_update", { id: 987, previous: ["write_products"], current: ["read_products"] }],
  ];
  const results = [];
  for (const [topic, payload] of deliveries)
    for (const kind of ["app-specific", "shop-specific"]) {
      const raw = JSON.stringify(payload);
      const headers = {
        "content-type": "application/json",
        "x-shopify-api-version": "2026-10",
        "x-shopify-hmac-sha256": createHmac("sha256", secret).update(raw).digest("base64"),
        "x-shopify-shop-domain": shop,
        "x-shopify-topic": topic,
        "x-shopify-webhook-id": randomUUID(),
        // Delivery metadata that varies between deliveries is not forwarded or signed.
        "x-shopify-triggered-at": "2026-10-25T00:00:00.000Z",
        "x-shopify-event-id": randomUUID(),
        ...(kind === "shop-specific" ? { "x-shopify-webhook-subscription-id": "9001" } : {}),
      };
      const request = new Request(callbackUrl, { method: "POST", headers, body: raw });
      const input = await readWebhook(request);
      assert.deepEqual(Object.keys(JSON.parse(input.headersJson)), [
        "x-shopify-api-version",
        "x-shopify-hmac-sha256",
        "x-shopify-shop-domain",
        "x-shopify-topic",
        "x-shopify-webhook-id",
      ]);
      const verdict = decodeShopifyWebhookVerdict(
        await broker.webhookVerify(e, appKey, input.headersJson, input.rawBodyBase64),
      );
      results.push([topic, kind, verdict.verdict]);
      // A forged signature on the same path is refused before any record.
      const forged = JSON.parse(input.headersJson);
      forged["x-shopify-hmac-sha256"] = createHmac("sha256", "wrong").update(raw).digest("base64");
      assert.equal(
        decodeShopifyWebhookVerdict(
          await broker.webhookVerify(e, appKey, JSON.stringify(forged), input.rawBodyBase64),
        ).verdict,
        "refused",
      );
    }
  assert.deepEqual(results, [
    ["app/uninstalled", "app-specific", "recorded"],
    ["app/uninstalled", "shop-specific", "recorded"],
    ["app/scopes_update", "app-specific", "recorded"],
    ["app/scopes_update", "shop-specific", "recorded"],
  ]);
  assert.deepEqual(
    recorded.map((r) => [r.key, r.domain, r.topic, r.apiVersion, JSON.stringify(r.body)]),
    [
      [appKey, shop, "app/uninstalled", "2026-10", '{"shopId":"987"}'],
      [appKey, shop, "app/uninstalled", "2026-10", '{"shopId":"987"}'],
      [
        appKey,
        shop,
        "app/scopes_update",
        "2026-10",
        '{"previous":["write_products"],"current":["read_products"]}',
      ],
      [
        appKey,
        shop,
        "app/scopes_update",
        "2026-10",
        '{"previous":["write_products"],"current":["read_products"]}',
      ],
    ],
  );
});
