// M2 PR-3: shopifyRead (apps/broker/src/shopify-read.ts) over a faked vault database and a
// faked Shopify (no network, no database). Closed inputs per entrypoint (the api's pages and
// shop identity, the orchestrator's one product), the vault resolution alone in its own
// transaction before any provider call (review finding B1), the token opened only with the
// additional data that binds its store installation as the subject, one fixed document with
// variables built in the broker, THROTTLED once within the budget, 401 and any other error
// refused with nothing changed, and results minimised to the protocol's closed JSON.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decodeShopifyReadResult,
  parseShopifyReadVariables,
  shopifyReadLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { createShopifyReader } from "../apps/broker/src/shopify-read.ts";
import { shopifyReadDocuments } from "../apps/broker/src/shopify.ts";
import {
  VaultError,
  createVaultKeyring,
  sealVaultRecord,
  vaultBytesHex,
  vaultStatements,
} from "../apps/broker/src/vault.ts";

const kek = randomBytes(32).toString("hex");
const token = "shpat_" + randomBytes(16).toString("hex");
const shop = "dev-store-1.myshopify.com";
const lease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ids = {
  org: "org_read",
  ws: "ws_read",
  store: "store_read",
  connection: "connection_read",
  installation: "installation_read",
  credential: "credential_read",
};
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-broker-unit",
  branchId: "br-broker-unit",
  hostname: "ep-broker-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const env = () => ({
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
});
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));

async function harness(options = {}) {
  const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
  const envelope = await sealVaultRecord(
    keyring,
    {
      kind: "shopify_offline_token",
      organizationId: ids.org,
      workspaceId: ids.ws,
      credentialId: ids.credential,
      subjectId: options.sealedSubject ?? ids.installation,
      provider: "shopify",
      version: 2,
    },
    new TextEncoder().encode(token),
  );
  const events = [];
  const resolved = [];
  const transaction = async (vault, budgetMs, body) => {
    assert.ok(vault.keyring && vault.binding, "the vault capability");
    assert.ok(Number.isSafeInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 3000);
    events.push("begin");
    const value = await body(async (text, values) => {
      assert.equal(text, vaultStatements.shopifyReadResolve);
      assert.ok(values.every((x) => typeof x === "string"));
      resolved.push(values);
      const outcome = options.outcome ?? "resolved";
      if (outcome !== "resolved")
        return [
          {
            outcome,
            organization_id: null,
            workspace_id: null,
            lease_kind: null,
            store_id: null,
            connection_id: null,
            installation_id: null,
            shop_domain: null,
            credential_id: null,
            credential_version: null,
            kek_version: null,
            wrapped_key: null,
            sealed_value: null,
          },
        ];
      return [
        {
          outcome: "resolved",
          organization_id: ids.org,
          workspace_id: ids.ws,
          lease_kind: values[3] === "productContent" ? "run" : "read",
          store_id: ids.store,
          connection_id: ids.connection,
          installation_id: ids.installation,
          shop_domain: shop,
          credential_id: ids.credential,
          credential_version: "2",
          kek_version: "1",
          wrapped_key: vaultBytesHex(envelope.wrappedKey),
          sealed_value: vaultBytesHex(envelope.sealedValue),
        },
      ];
    });
    events.push("commit");
    return value;
  };
  const requests = [];
  const reply = options.reply ?? defaultReply;
  const fetch = async (url, init) => {
    events.push("fetch");
    const body = JSON.parse(init.body);
    requests.push({ url, headers: new Headers(init.headers), body });
    return reply(body, requests.length);
  };
  const clock = { ms: 1_760_950_000_000 };
  const reader = createShopifyReader({
    transaction,
    fetch,
    now: () => clock.ms,
    sleep: async (ms) => {
      events.push("sleep:" + ms);
      clock.ms += ms;
    },
  });
  const read = (caller, query, variables, budget = 10000, generation = 1, subject = "subject_1") =>
    reader.read(
      env(),
      caller,
      lease,
      generation,
      subject,
      query,
      typeof variables === "string" ? variables : JSON.stringify(variables),
      budget,
    );
  return { read, events, requests, resolved, clock };
}
const product = (n, extra = {}) => ({
  id: "gid://shopify/Product/" + n,
  title: "Product " + n,
  status: "ACTIVE",
  vendor: "Hidden vendor",
  ...extra,
});
function defaultReply(body) {
  const q = body.query;
  if (q === shopifyReadDocuments.shopIdentity)
    return Response.json({
      data: {
        shop: {
          id: "gid://shopify/Shop/987",
          myshopifyDomain: shop,
          plan: { partnerDevelopment: true },
        },
      },
    });
  if (q === shopifyReadDocuments.collectionsPage)
    return Response.json({
      data: {
        collections: {
          nodes: [{ id: "gid://shopify/Collection/5", title: "Summer", handle: "summer" }],
          pageInfo: { hasNextPage: true, endCursor: "eyJsYXN0IjoxfQ==" },
        },
      },
    });
  if (q === shopifyReadDocuments.productsPage)
    return Response.json({
      data: {
        products: {
          nodes: [product(1), product(2, { status: "DRAFT" })],
          pageInfo: { hasNextPage: false, endCursor: "x" },
        },
      },
    });
  if (q === shopifyReadDocuments.collectionProductsPage)
    return Response.json({
      data:
        body.variables.id === "gid://shopify/Collection/404"
          ? { collection: null }
          : {
              collection: {
                products: {
                  nodes: [product(3)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
    });
  if (q === shopifyReadDocuments.productContent)
    return Response.json({
      data:
        body.variables.id === "gid://shopify/Product/404"
          ? { product: null }
          : {
              product: {
                id: body.variables.id,
                title: "Linen shirt",
                descriptionHtml: "<p>Soft linen.</p>",
                tags: ["linen", "summer"],
                seo: { title: null, description: "A soft shirt" },
                vendor: "Hidden vendor",
                totalInventory: 12,
              },
            },
    });
  return Response.json({ errors: [{ message: "unexpected document" }] });
}
const refused = (error) => error.code === "READ_REFUSED";
const invalidInput = (error) => error.code === "INPUT_INVALID";

test("reads: the api's pages and shop identity under a read lease, minimised and closed", async () => {
  const h = await harness();
  const identity = JSON.parse(await h.read("api", "shopIdentity", {}));
  assert.deepEqual(identity, {
    schemaVersion: 1,
    outcome: "read",
    shop: { shopId: "987", development: true },
  });
  const collections = JSON.parse(await h.read("api", "collectionsPage", { after: null }));
  assert.deepEqual(collections, {
    schemaVersion: 1,
    outcome: "read",
    collections: [{ id: "collection:5", title: "Summer" }],
    nextCursor: "eyJsYXN0IjoxfQ==",
  });
  const products = JSON.parse(
    await h.read("api", "productsPage", { after: null, collectionId: null, search: "linen shirt" }),
  );
  assert.deepEqual(products.products, [
    { id: "product:1", title: "Product 1", status: "active" },
    { id: "product:2", title: "Product 2", status: "draft" },
  ]);
  assert.equal(products.nextCursor, null);
  // The broker builds the documents' variables: a page of 25, Shopify's title search from
  // letters and digits only, and a collection's products by its gid.
  const sent = h.requests.map((r) => r.body);
  assert.deepEqual(sent[1].variables, { first: 25, after: null });
  assert.deepEqual(sent[2].variables, {
    first: 25,
    after: null,
    query: "title:linen* AND title:shirt*",
  });
  const inCollection = JSON.parse(
    await h.read("api", "productsPage", {
      after: "abc",
      collectionId: "collection:7",
      search: null,
    }),
  );
  assert.deepEqual(inCollection.products, [
    { id: "product:3", title: "Product 3", status: "active" },
  ]);
  assert.deepEqual(h.requests.at(-1).body, {
    query: shopifyReadDocuments.collectionProductsPage,
    variables: { id: "gid://shopify/Collection/7", first: 25, after: "abc" },
  });
  assert.deepEqual(
    JSON.parse(
      await h.read("api", "productsPage", {
        after: null,
        collectionId: "collection:404",
        search: null,
      }),
    ),
    { schemaVersion: 1, outcome: "not_found" },
  );
  // Every request is the pinned API version, the token as Shopify's header, never followed.
  for (const r of h.requests) {
    assert.equal(r.url, `https://${shop}/admin/api/2026-10/graphql.json`);
    assert.equal(r.headers.get("x-shopify-access-token"), token);
  }
  // The resolution names the lease, its generation, the subject, the query and no product.
  assert.deepEqual(h.resolved[0], [lease, "1", "subject_1", "shopIdentity", ""]);
  // Each vault transaction ends before its Shopify call (B1).
  assert.deepEqual(h.events.slice(0, 3), ["begin", "commit", "fetch"]);
  assert.doesNotMatch(
    logs.join("\n") + JSON.stringify([identity, collections, products]),
    new RegExp(token),
  );
  assert.doesNotMatch(JSON.stringify(products), /Hidden vendor/);
});

test("reads: the orchestrator's one product under a run lease; not_found when Shopify has none", async () => {
  const h = await harness();
  const read = JSON.parse(
    await h.read("runtime", "productContent", { productId: "product:42" }, 15000, 3, "run_1"),
  );
  assert.deepEqual(read, {
    schemaVersion: 1,
    outcome: "read",
    product: {
      productId: "product:42",
      title: "Linen shirt",
      descriptionHtml: "<p>Soft linen.</p>",
      seo: { title: null, description: "A soft shirt" },
      tags: ["linen", "summer"],
    },
  });
  assert.deepEqual(decodeShopifyReadResult("productContent", JSON.stringify(read)), read);
  assert.deepEqual(h.resolved[0], [lease, "3", "run_1", "productContent", "product:42"]);
  assert.deepEqual(h.requests[0].body.variables, { id: "gid://shopify/Product/42" });
  assert.deepEqual(
    JSON.parse(await h.read("runtime", "productContent", { productId: "product:404" })),
    { schemaVersion: 1, outcome: "not_found" },
  );
});

test("reads: each entrypoint serves only its own queries; variables, ids and budgets are closed", async () => {
  const h = await harness();
  for (const [caller, query, variables] of [
    ["api", "productContent", { productId: "product:1" }],
    ["runtime", "productsPage", { after: null, collectionId: null, search: null }],
    ["runtime", "shopIdentity", {}],
    ["api", "productUpdate", {}],
    ["api", "collectionsPage", { after: null, extra: 1 }],
    ["api", "collectionsPage", { after: "has space" }],
    ["api", "collectionsPage", {}],
    ["api", "productsPage", { after: null, collectionId: "collection:1", search: "x" }],
    [
      "api",
      "productsPage",
      { after: null, collectionId: "gid://shopify/Collection/1", search: null },
    ],
    ["api", "productsPage", { after: null, collectionId: null, search: "title:x OR 1" }],
    ["api", "productsPage", { after: null, collectionId: null, search: "a  b" }],
    ["api", "productsPage", { after: null, collectionId: null, search: "x".repeat(65) }],
    ["runtime", "productContent", { productId: "42" }],
    ["runtime", "productContent", { productId: "product:01" }],
    ["api", "shopIdentity", "[]"],
    ["api", "shopIdentity", '{"after":null}'],
  ])
    await assert.rejects(
      () => h.read(caller, query, variables),
      invalidInput,
      `${caller} ${query}`,
    );
  for (const [generation, subject] of [
    [0, "subject_1"],
    [1.5, "subject_1"],
    ["1", "subject_1"],
    [1, "bad subject"],
  ])
    await assert.rejects(
      () => h.read("api", "shopIdentity", {}, 1000, generation, subject),
      invalidInput,
    );
  for (const budget of [0, shopifyReadLimits.budgetMaxMs + 1, 1.5])
    await assert.rejects(
      () => h.read("api", "shopIdentity", {}, budget),
      (error) => error.code === "BUDGET_INVALID",
    );
  assert.equal(h.requests.length, 0);
  assert.equal(h.resolved.length, 0);
  // The protocol parser is the one the api and the broker share.
  assert.equal(
    parseShopifyReadVariables("collectionsPage", '{"after":null}')?.query,
    "collectionsPage",
  );
  assert.equal(parseShopifyReadVariables("collectionsPage", '{"after":null,"after":null}'), null);
});

test("reads: a refused resolution reaches no provider; the token opens only for its own installation", async () => {
  for (const outcome of [
    "denied",
    "not_found",
    "ended",
    "expired",
    "member_inactive",
    "purpose_mismatch",
    "subject_mismatch",
    "stopped",
    "connection_inactive",
    "credential_unavailable",
    "product_not_in_run",
  ]) {
    const h = await harness({ outcome });
    await assert.rejects(() => h.read("api", "collectionsPage", { after: null }), refused, outcome);
    assert.equal(h.requests.length, 0, outcome);
  }
  // An envelope sealed for another subject (another installation) does not open.
  const h = await harness({ sealedSubject: "installation_other" });
  await assert.rejects(
    () => h.read("api", "collectionsPage", { after: null }),
    (error) => error instanceof VaultError && error.code === "VAULT_OPEN_FAILED",
  );
  assert.equal(h.requests.length, 0);
});

test("reads: THROTTLED waits once within the budget; 401, errors and other shapes are refused", async () => {
  const throttled = await harness({
    reply: (body, n) =>
      n === 1
        ? Response.json({
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } },
          })
        : defaultReply(body),
  });
  const read = JSON.parse(await throttled.read("api", "collectionsPage", { after: null }));
  assert.equal(read.outcome, "read");
  assert.ok(throttled.events.includes("sleep:200"));
  // Not within the budget: refused without waiting.
  const tight = await harness({
    reply: () =>
      Response.json({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 1 } } },
      }),
  });
  await assert.rejects(() => tight.read("api", "collectionsPage", { after: null }, 2000), refused);
  for (const reply of [
    () => new Response("unauthorized", { status: 401 }),
    () => new Response("server", { status: 500 }),
    () =>
      Response.json({
        errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }],
      }),
    () =>
      Response.json({
        data: {
          collections: {
            nodes: [{ id: "gid://shopify/Product/1", title: "x" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    () =>
      Response.json({
        data: { collections: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } },
      }),
    () => Response.json({ data: null }),
    () => new Response("x".repeat(shopifyReadLimits.resultMaxBytes + 1), { status: 200 }),
    () => {
      throw new TypeError("network lost");
    },
  ]) {
    const h = await harness({ reply });
    await assert.rejects(() => h.read("api", "collectionsPage", { after: null }), refused);
  }
  // A product reply naming another product's shape (a missing listing field) is refused.
  const broken = await harness({
    reply: () =>
      Response.json({ data: { product: { id: "gid://shopify/Product/1", title: "x", tags: [] } } }),
  });
  await assert.rejects(
    () => broken.read("runtime", "productContent", { productId: "product:1" }),
    refused,
  );
});
