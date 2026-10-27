// M2 PR-2 (ADR-0008 item 1 as amended 2026-10-20): the broker's hand-written Shopify
// checks, pinned against Shopify's documented OAuth HMAC example and against the locked
// @shopify/shopify-api 15.0.0 (a development dependency used here only, never deployed).
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import "@shopify/shopify-api/adapters/node";
import { generateLocalHmac } from "../node_modules/@shopify/shopify-api/dist/esm/lib/utils/hmac-validator.mjs";
import {
  constantTimeEqual,
  exchangeShopifyCode,
  expandShopifyScopes,
  minimiseShopifyWebhook,
  shopifyComplianceOrdersMax,
  parseShopifyQuery,
  readShopifyIdentity,
  shopifyScopesExact,
  shopifyShopIdentityDocument,
  verifyShopifyQuery,
  verifyShopifyWebhookHmac,
} from "../apps/broker/src/shopify.ts";

// Shopify's documented example (Verify a request from Shopify: the OAuth callback query,
// app secret "hush").
const documented = {
  secret: "hush",
  query:
    "code=0907a61c0c8d55e99db179b68161bc00&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173",
  timestamp: 1337178173,
};

test("the documented OAuth callback example verifies; any change to it does not", async () => {
  const params = await verifyShopifyQuery(
    documented.secret,
    documented.query,
    documented.timestamp,
  );
  assert.ok(params);
  assert.equal(params.get("shop"), "some-shop.myshopify.com");
  assert.equal(
    parseShopifyQuery(documented.query).message,
    "code=0907a61c0c8d55e99db179b68161bc00&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173",
  );
  // Another secret, a changed value, a reordered query (still valid: order is canonical),
  // a stale or future timestamp, an uppercase hmac and an added parameter.
  assert.equal(await verifyShopifyQuery("other", documented.query, documented.timestamp), null);
  assert.equal(
    await verifyShopifyQuery(
      documented.secret,
      documented.query.replace("some-shop", "some-shoq"),
      documented.timestamp,
    ),
    null,
  );
  const reordered = documented.query.split("&").reverse().join("&");
  assert.ok(await verifyShopifyQuery(documented.secret, reordered, documented.timestamp));
  assert.equal(
    await verifyShopifyQuery(documented.secret, documented.query, documented.timestamp + 91),
    null,
  );
  assert.equal(
    await verifyShopifyQuery(documented.secret, documented.query, documented.timestamp - 91),
    null,
  );
  assert.ok(
    await verifyShopifyQuery(documented.secret, documented.query, documented.timestamp + 90),
  );
  assert.equal(
    await verifyShopifyQuery(
      documented.secret,
      documented.query.replace("hmac=700e", "hmac=700E"),
      documented.timestamp,
    ),
    null,
  );
  assert.equal(
    await verifyShopifyQuery(
      documented.secret,
      documented.query + "&extra=1",
      documented.timestamp,
    ),
    null,
  );
});

test("canonicalisation equals the locked library's for launch queries with encoded values", async () => {
  const secret = randomBytes(16).toString("hex");
  const local = generateLocalHmac({ apiSecretKey: secret });
  const host = Buffer.from("admin.shopify.com/store/dev-shop").toString("base64");
  const cases = [
    { shop: "dev-shop.myshopify.com", host, timestamp: "1760950000" },
    {
      shop: "dev-shop.myshopify.com",
      host,
      timestamp: "1760950000",
      locale: "en-GB",
      embedded: "0",
    },
    { shop: "dev-shop.myshopify.com", timestamp: "1760950000", state: "a b+c/d=e", code: "x~y.z" },
  ];
  for (const values of cases) {
    const hmac = await local(values);
    const query = new URLSearchParams({ ...values, hmac }).toString();
    const parsed = parseShopifyQuery(query);
    assert.ok(parsed, query);
    assert.equal(createHmac("sha256", secret).update(parsed.message).digest("hex"), hmac, query);
    assert.ok(await verifyShopifyQuery(secret, query, 1760950000), query);
  }
});

test("a repeated, malformed or oversize query is refused before any signature check", async () => {
  const refused = [
    "",
    "shop=a.myshopify.com&shop=b.myshopify.com&hmac=" + "a".repeat(64) + "&timestamp=1",
    "=x",
    "shop",
    "Shop=a.myshopify.com",
    "shop=%ZZ",
    "shop=a%00b",
    "shop=a.myshopify.com&x=" + "y".repeat(2048),
    "shop=a.myshopify.com\n",
    "signature=abc&shop=a.myshopify.com",
  ];
  for (const query of refused) {
    const parsed = parseShopifyQuery(query);
    const verified = await verifyShopifyQuery("secret", query, 1);
    assert.ok(parsed === null || verified === null, query);
    assert.equal(verified, null, query);
  }
  // A foreign host as shop is refused even with a valid signature.
  const secret = "s3cret";
  const message = "shop=evil.example.com&timestamp=100";
  const hmac = createHmac("sha256", secret).update(message).digest("hex");
  assert.equal(await verifyShopifyQuery(secret, `${message}&hmac=${hmac}`, 100), null);
});

test("constant-time equality is exact", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual(null, "a"), false);
});

test("scopes: write_products alone satisfies read_products; extra or missing scopes are refused", () => {
  assert.deepEqual([...expandShopifyScopes("write_products")], ["read_products", "write_products"]);
  assert.deepEqual([...shopifyScopesExact("write_products")], ["read_products", "write_products"]);
  assert.deepEqual(
    [...shopifyScopesExact("read_products,write_products")],
    ["read_products", "write_products"],
  );
  assert.deepEqual(
    [...shopifyScopesExact(" write_products , read_products ")],
    ["read_products", "write_products"],
  );
  for (const granted of [
    "read_products",
    "write_products,read_orders",
    "write_products,write_customers",
    "",
    "WRITE_PRODUCTS",
    null,
  ])
    assert.equal(shopifyScopesExact(granted), null, String(granted));
  assert.deepEqual(
    [...expandShopifyScopes("unauthenticated_write_checkouts")],
    ["unauthenticated_read_checkouts", "unauthenticated_write_checkouts"],
  );
});

test("webhook HMAC is base64 over the raw bytes, compared in constant time", async () => {
  const secret = randomBytes(16).toString("hex");
  const body = new TextEncoder().encode('{"shop_id":1,"shop_domain":"x.myshopify.com"}');
  const good = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(await verifyShopifyWebhookHmac(secret, body, good), true);
  assert.equal(await verifyShopifyWebhookHmac("other", body, good), false);
  const changed = new Uint8Array(body);
  changed[2] ^= 1;
  assert.equal(await verifyShopifyWebhookHmac(secret, changed, good), false);
  for (const bad of [undefined, "", good.slice(1), good.toLowerCase() + "x", "%%%"])
    assert.equal(await verifyShopifyWebhookHmac(secret, body, bad), false);
});

test("compliance bodies are minimised to ids and a keyed customer digest", async () => {
  const secret = "app-secret";
  const shop = "x.myshopify.com";
  const redact = await minimiseShopifyWebhook(
    secret,
    "customers/redact",
    {
      shop_id: 954889,
      shop_domain: shop,
      customer: { id: 191167, email: "john@example.com", phone: "555-625-1199" },
      orders_to_redact: [299938, 280263, 220458],
    },
    shop,
  );
  // SD3: the listed order ids are kept (numeric ids, distinct, ascending), never the
  // customer's email or phone.
  assert.deepEqual(Object.keys(redact).sort(), ["customerDigest", "ordersToRedact", "shopId"]);
  assert.equal(redact.shopId, "954889");
  assert.match(redact.customerDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(redact.ordersToRedact, ["220458", "280263", "299938"]);
  assert.ok(Object.isFrozen(redact.ordersToRedact));
  assert.ok(!JSON.stringify(redact).includes("john") && !JSON.stringify(redact).includes("1199"));
  const request = await minimiseShopifyWebhook(
    secret,
    "customers/data_request",
    {
      shop_id: 954889,
      shop_domain: shop,
      customer: { id: 191167, email: "john@example.com" },
      orders_requested: [299938],
      data_request: { id: 9999 },
    },
    shop,
  );
  assert.deepEqual(request, {
    shopId: "954889",
    customerDigest: redact.customerDigest,
    dataRequestId: "9999",
    ordersRequested: ["299938"],
  });
  // SD3: duplicates collapse, digit strings are accepted and the order is numeric, not
  // lexical; an empty list is a list.
  assert.deepEqual(
    (
      await minimiseShopifyWebhook(
        secret,
        "customers/redact",
        {
          shop_id: 954889,
          shop_domain: shop,
          customer: { id: 1 },
          orders_to_redact: [10, "9", 10, "100000000000000000"],
        },
        shop,
      )
    ).ordersToRedact,
    ["9", "10", "100000000000000000"],
  );
  assert.deepEqual(
    (
      await minimiseShopifyWebhook(
        secret,
        "customers/data_request",
        {
          shop_id: 954889,
          shop_domain: shop,
          customer: {},
          orders_requested: [],
          data_request: { id: 1 },
        },
        shop,
      )
    ).ordersRequested,
    [],
  );
  assert.deepEqual(
    await minimiseShopifyWebhook(
      secret,
      "shop/redact",
      { shop_id: 954889, shop_domain: shop },
      shop,
    ),
    { shopId: "954889" },
  );
  assert.deepEqual(
    await minimiseShopifyWebhook(
      secret,
      "app/uninstalled",
      { id: 1, email: "a@b.c", myshopify_domain: shop },
      shop,
    ),
    { shopId: "1" },
  );
  assert.deepEqual(
    await minimiseShopifyWebhook(secret, "app/uninstalled", { id: 1, email: "a@b.c" }, shop),
    { shopId: "1" },
  );
  assert.deepEqual(
    await minimiseShopifyWebhook(
      secret,
      "app/scopes_update",
      { previous: ["read_products"], current: ["write_products", "read_products"] },
      shop,
    ),
    { previous: ["read_products"], current: ["read_products", "write_products"] },
  );
  // M2 PR-3: the topic header is not signed, so a body must be its topic's: another topic's
  // body, a body naming another shop than the header's, or a missing id is refused.
  for (const [topic, body] of [
    ["orders/create", { id: 1 }],
    ["shop/redact", []],
    ["shop/redact", { shop_id: 954889, shop_domain: "other.myshopify.com" }],
    ["shop/redact", { shop_id: 954889 }],
    ["shop/redact", { shop_id: 954889, shop_domain: shop, customer: { id: 1 } }],
    ["shop/redact", { shop_id: 954889, shop_domain: shop, orders_to_redact: [] }],
    ["app/uninstalled", { shop_id: 954889, shop_domain: shop }],
    ["app/uninstalled", { id: 1, myshopify_domain: "other.myshopify.com" }],
    ["app/uninstalled", { name: "no id" }],
    ["customers/redact", { shop_id: 954889, shop_domain: shop }],
    [
      "customers/redact",
      { shop_id: 954889, shop_domain: shop, customer: {}, data_request: { id: 1 } },
    ],
    ["customers/data_request", { shop_id: 954889, shop_domain: shop, customer: { id: 1 } }],
    // SD3: a request's order list is required, numeric and bounded; a list Morrow cannot read
    // is refused (Shopify retries), never recorded as empty. A body may not carry the other
    // request's list.
    ["customers/redact", { shop_id: 954889, shop_domain: shop, customer: { id: 1 } }],
    [
      "customers/redact",
      { shop_id: 954889, shop_domain: shop, customer: { id: 1 }, orders_to_redact: [0] },
    ],
    [
      "customers/redact",
      { shop_id: 954889, shop_domain: shop, customer: { id: 1 }, orders_to_redact: ["#1001"] },
    ],
    [
      "customers/redact",
      { shop_id: 954889, shop_domain: shop, customer: { id: 1 }, orders_to_redact: [1.5] },
    ],
    [
      "customers/redact",
      { shop_id: 954889, shop_domain: shop, customer: { id: 1 }, orders_to_redact: "1" },
    ],
    [
      "customers/redact",
      {
        shop_id: 954889,
        shop_domain: shop,
        customer: { id: 1 },
        orders_to_redact: Array.from({ length: shopifyComplianceOrdersMax + 1 }, (_, i) => i + 1),
      },
    ],
    [
      "customers/redact",
      {
        shop_id: 954889,
        shop_domain: shop,
        customer: { id: 1 },
        orders_to_redact: [],
        orders_requested: [],
      },
    ],
    [
      "customers/data_request",
      { shop_id: 954889, shop_domain: shop, customer: { id: 1 }, data_request: { id: 1 } },
    ],
    [
      "customers/data_request",
      {
        shop_id: 954889,
        shop_domain: shop,
        customer: { id: 1 },
        data_request: { id: 1 },
        orders_requested: [Number.MAX_SAFE_INTEGER + 2],
      },
    ],
    [
      "customers/data_request",
      {
        shop_id: 954889,
        shop_domain: shop,
        customer: { id: 1 },
        data_request: { id: 1 },
        orders_requested: [],
        orders_to_redact: [],
      },
    ],
    ["app/scopes_update", { previous: ["read_products"] }],
    ["app/scopes_update", { previous: [], current: ["Read"] }],
    ["app/scopes_update", { previous: [], current: [], shop_id: 1 }],
  ])
    assert.equal(await minimiseShopifyWebhook(secret, topic, body, shop), null, topic);
  // A customer without an id is still a request to answer: its digest is null.
  assert.deepEqual(
    await minimiseShopifyWebhook(
      secret,
      "customers/redact",
      { shop_id: 954889, shop_domain: shop, customer: { email: "x@y.z" }, orders_to_redact: [] },
      shop,
    ),
    { shopId: "954889", customerDigest: null, ordersToRedact: [] },
  );
  // The largest list is kept whole.
  const most = await minimiseShopifyWebhook(
    secret,
    "customers/redact",
    {
      shop_id: 954889,
      shop_domain: shop,
      customer: { id: 1 },
      orders_to_redact: Array.from({ length: shopifyComplianceOrdersMax }, (_, i) => 5e12 + i),
    },
    shop,
  );
  assert.equal(most.ordersToRedact.length, shopifyComplianceOrdersMax);
  assert.equal(most.ordersToRedact[0], "5000000000000");
});

// A recording fetch over fixed replies.
function fakeFetch(replies) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetcher, calls };
}
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("the code exchange: once, offline and non-expiring; uncertain after sending, never retried", async () => {
  const clientId = "a".repeat(32);
  const ok = fakeFetch([
    json({ access_token: "shpat_" + "x".repeat(32), scope: "write_products" }),
  ]);
  const result = await exchangeShopifyCode(
    ok.fetcher,
    "dev.myshopify.com",
    clientId,
    "secret",
    "code123",
    1000,
  );
  assert.deepEqual(result, {
    kind: "token",
    token: "shpat_" + "x".repeat(32),
    scopes: "write_products",
  });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, "https://dev.myshopify.com/admin/oauth/access_token");
  assert.equal(ok.calls[0].init.method, "POST");
  assert.equal(ok.calls[0].init.redirect, "manual");
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), {
    client_id: clientId,
    client_secret: "secret",
    code: "code123",
    expiring: "0",
  });
  for (const [reply, kind] of [
    [new Error("socket"), "uncertain"],
    [json({}, 502), "uncertain"],
    [json({ error: "invalid_request" }, 400), "refused"],
    [new Response(null, { status: 302, headers: { location: "https://evil.test" } }), "refused"],
    [
      json({ access_token: "shpat_" + "x".repeat(32), scope: "write_products", expires_in: 86399 }),
      "refused",
    ],
    [
      json({
        access_token: "shpat_" + "x".repeat(32),
        scope: "write_products",
        associated_user: {},
      }),
      "refused",
    ],
    [json({ scope: "write_products" }), "refused"],
    [new Response("x".repeat(9000), { status: 200 }), "refused"],
  ]) {
    const f = fakeFetch([reply]);
    const r = await exchangeShopifyCode(
      f.fetcher,
      "dev.myshopify.com",
      clientId,
      "secret",
      "code123",
      1000,
    );
    assert.equal(r.kind, kind);
    assert.equal(f.calls.length, 1);
  }
  // A foreign shop or a malformed client id never reaches fetch.
  const none = fakeFetch([]);
  assert.equal(
    (await exchangeShopifyCode(none.fetcher, "evil.test", clientId, "s", "c", 1000)).kind,
    "refused",
  );
  assert.equal(
    (await exchangeShopifyCode(none.fetcher, "dev.myshopify.com", "X", "s", "c", 1000)).kind,
    "refused",
  );
  assert.equal(none.calls.length, 0);
});

test("ShopIdentity: one fixed document; development flag, id and domain; THROTTLED waits once", async () => {
  const reply = (development, domain = "dev.myshopify.com") =>
    json({
      data: {
        shop: {
          id: "gid://shopify/Shop/1234",
          myshopifyDomain: domain,
          plan: { partnerDevelopment: development },
        },
      },
    });
  const f = fakeFetch([reply(true)]);
  const identity = await readShopifyIdentity(
    f.fetcher,
    "dev.myshopify.com",
    "tok",
    Date.now() + 5000,
  );
  assert.deepEqual(identity, {
    kind: "identity",
    shopId: "1234",
    domain: "dev.myshopify.com",
    development: true,
  });
  assert.equal(f.calls[0].url, "https://dev.myshopify.com/admin/api/2026-10/graphql.json");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { query: shopifyShopIdentityDocument });
  assert.equal(f.calls[0].init.headers["x-shopify-access-token"], "tok");
  assert.equal(
    (
      await readShopifyIdentity(
        fakeFetch([reply(false)]).fetcher,
        "dev.myshopify.com",
        "t",
        Date.now() + 5000,
      )
    ).development,
    false,
  );
  assert.equal(
    (
      await readShopifyIdentity(
        fakeFetch([reply(true, "other.myshopify.com")]).fetcher,
        "dev.myshopify.com",
        "t",
        Date.now() + 5000,
      )
    ).kind,
    "refused",
  );
  const throttled = () =>
    json({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 100 } } },
    });
  const slept = [];
  const t = fakeFetch([throttled(), reply(true)]);
  const after = await readShopifyIdentity(
    t.fetcher,
    "dev.myshopify.com",
    "t",
    Date.now() + 5000,
    Date.now,
    async (ms) => {
      slept.push(ms);
    },
  );
  assert.equal(after.kind, "identity");
  // ShopIdentity's known cost (2 points) at 100 a second (M2 PR-3 review: the wait covers
  // the query's cost, not a fixed 10 points).
  assert.deepEqual(slept, [20]);
  // The reply's requestedQueryCost, when present, prices the wait.
  const reported = [];
  const priced = fakeFetch([
    json({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: {
        cost: {
          requestedQueryCost: 7,
          throttleStatus: { currentlyAvailable: 1, restoreRate: 100 },
        },
      },
    }),
    reply(true),
  ]);
  assert.equal(
    (
      await readShopifyIdentity(
        priced.fetcher,
        "dev.myshopify.com",
        "t",
        Date.now() + 5000,
        Date.now,
        async (ms) => {
          reported.push(ms);
        },
      )
    ).kind,
    "identity",
  );
  assert.deepEqual(reported, [60]);
  const twice = fakeFetch([throttled(), throttled()]);
  assert.equal(
    (
      await readShopifyIdentity(
        twice.fetcher,
        "dev.myshopify.com",
        "t",
        Date.now() + 5000,
        Date.now,
        async () => {},
      )
    ).kind,
    "refused",
  );
  assert.equal(twice.calls.length, 2);
  for (const bad of [
    json({ errors: [{ message: "x" }] }),
    json({}, 401),
    new Error("socket"),
    new Response("{", { status: 200 }),
  ])
    assert.equal(
      (
        await readShopifyIdentity(
          fakeFetch([bad]).fetcher,
          "dev.myshopify.com",
          "t",
          Date.now() + 5000,
        )
      ).kind,
      "refused",
    );
});
