// v1 PR 3: review, approve and apply to Shopify, in Node with fakes (no database, no
// Shopify). The digest binding of the source (the broker's pre-send read computes exactly the
// draft's expectedSourceRevision) and of each operation's exact approved item; the read-back
// comparison; the classification of every Shopify reply; the broker's writer over a scripted
// vault (switch first, one send at most, a lost reply uncertain and read back, never resent);
// the api's apply loop; the review view; and the routes (the switch answers 503 before any
// database access). lab:catalog-apply drives the same code against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { apiDispatch } from "../apps/api/src/worker.ts";
import {
  brokerNeonRoleNames,
  brokerPasswordSecret,
  decodeShopifyApplyResult,
  decodeShopifyReconcileResult,
  encodeShopifyApplyResult,
  shopifyWriteLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { BrokerHold, brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import {
  classifyProductUpdate,
  createShopifyWriter,
  productUpdateInput,
  shopifyAdminWrite,
  shopifyWriteDocuments,
} from "../apps/broker/src/shopify-write.ts";
import { sealVaultRecord, vaultBytesHex, vaultStatements } from "../apps/broker/src/vault.ts";
import { snapshotCanonical } from "../packages/work/src/runs/drafting.ts";
import {
  changeItemText,
  listingSnapshotText,
} from "../packages/work/src/runs/listing-canonical.ts";
import { normalisedValue, readbackVerdicts } from "../packages/work/src/runs/listing-compare.ts";
import { applyItems, parseApplyBody } from "../packages/work/src/review/apply.ts";
import {
  applyThroughBroker,
  createReviewApiHandler,
  reviewPathPattern,
  reviewRoutes,
} from "../packages/work/src/review/http.ts";
import { buildProductReviews } from "../packages/work/src/review/view.ts";
import { reviewedApplyRecord, edgeApplyVarNames, edgeVarNames } from "../scripts/edge.mjs";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
// The broker's one init line per environment object stays out of the test output.
const originalLog = console.log;
console.log = () => {};
test.after(() => (console.log = originalLog));
const shop = "unit-shop.myshopify.com";

// ---------------------------------------------------------------------------
// Digest binding.
const product = (over = {}) => ({
  productId: "product:7",
  title: "Linen shirt",
  descriptionHtml: "<p>Original</p>",
  seo: { title: null, description: "Old SEO" },
  tags: ["summer", "linen"],
  ...over,
});

test("the source digest: the broker's canonical text is exactly the draft's snapshot text", () => {
  for (const p of [
    product(),
    product({ tags: [] }),
    product({ tags: ["b", "a", "b"] }),
    product({ title: "Ünïcode — “quotes” \\ backslash", seo: { title: "t", description: null } }),
    product({ descriptionHtml: "" }),
  ]) {
    // The draft's snapshot is the product as read with exact duplicate tags dropped.
    const snapshot = { ...p, tags: [...new Set(p.tags)] };
    assert.equal(listingSnapshotText(p), snapshotCanonical(snapshot));
    assert.equal(sha(listingSnapshotText(p)), sha(snapshotCanonical(snapshot)));
  }
  // Any change to a listing field changes the digest (the stale-product refusal).
  const base = sha(listingSnapshotText(product()));
  for (const changed of [
    product({ title: "Linen shirt!" }),
    product({ descriptionHtml: "<p>Original </p>" }),
    product({ seo: { title: "", description: "Old SEO" } }),
    product({ tags: ["linen", "summer"] }),
    product({ productId: "product:8" }),
  ])
    assert.notEqual(sha(listingSnapshotText(changed)), base);
});

test("each operation binds the exact approved item: its canonical text and digest", async () => {
  const items = [
    { targetIndex: 0, productId: "product:1", set: { title: "A", tags: ["x"] } },
    { targetIndex: 1, productId: "product:2", set: { title: "B" } },
    { targetIndex: 2, productId: "product:3", set: { seo: { title: "s", description: "d" } } },
  ];
  const target = (id, fields) => ({ resource: { id }, fields });
  const root = {
    targets: [
      target("product:1", ["tags", "title"]),
      target("product:2", ["title"]),
      target("product:3", ["seo.description", "seo.title"]),
    ],
    derivedFrom: null,
  };
  const all = await applyItems(root, { items });
  assert.deepEqual(
    all.map((i) => i.targetIndex),
    [0, 1, 2],
  );
  for (const [n, i] of all.entries()) {
    assert.equal(i.canonical, changeItemText(items[n]));
    assert.equal(i.digest, sha(i.canonical));
  }
  // Key order and whitespace never change it; any value does.
  assert.equal(
    changeItemText({ set: { tags: ["x"], title: "A" }, productId: "product:1", targetIndex: 0 }),
    all[0].canonical,
  );
  assert.notEqual(
    changeItemText({ ...items[0], set: { title: "A ", tags: ["x"] } }),
    all[0].canonical,
  );
  // A derived proposal (approve some) binds the root's items of exactly its selection.
  const derived = {
    targets: [root.targets[2], root.targets[0]],
    derivedFrom: { selectedTargetIndexes: [2, 0] },
  };
  const some = await applyItems(derived, { items });
  assert.deepEqual(
    some.map((i) => [i.targetIndex, i.digest]),
    [
      [2, all[2].digest],
      [0, all[0].digest],
    ],
  );
  // An item that names another product, or a missing one, is never applied.
  await assert.rejects(
    applyItems(root, { items: [items[1], items[1], items[2]] }),
    (e) => e.name === "WorkContextUnavailable" || /WORK/.test(String(e)),
  );
  await assert.rejects(applyItems(root, { items: items.slice(0, 2) }));
  await assert.rejects(applyItems(root, null));
});

test("the apply body is exactly {proposalRef, approvalRef} of the route's proposal", () => {
  const ref = (kind, id) => ({
    organizationId: "org_o",
    workspaceId: "ws_w",
    storeId: kind === "proposal" ? "store_a" : null,
    kind,
    id,
    revision: 1,
    digest: "a".repeat(64),
  });
  const body = {
    proposalRef: ref("proposal", "proposal_1"),
    approvalRef: ref("approval", "approval_1"),
  };
  assert.deepEqual(parseApplyBody(body, "proposal_1"), body);
  assert.equal(parseApplyBody(body, "proposal_2"), null);
  assert.equal(parseApplyBody({ ...body, extra: 1 }, "proposal_1"), null);
  assert.equal(parseApplyBody({ proposalRef: body.proposalRef }, "proposal_1"), null);
  assert.equal(
    parseApplyBody({ ...body, approvalRef: { ...body.approvalRef, digest: "x" } }, "proposal_1"),
    null,
  );
  assert.equal(
    parseApplyBody(
      { ...body, proposalRef: { ...body.proposalRef, organizationId: "" } },
      "proposal_1",
    ),
    null,
  );
  for (const bad of [null, [], "x", 1, {}]) assert.equal(parseApplyBody(bad, "proposal_1"), null);
});

// ---------------------------------------------------------------------------
// The read-back comparison.
test("read-back verdicts: Shopify's known reformatting is approved, anything else is not", () => {
  const source = product();
  const approved = {
    title: "Linen shirt - improved",
    descriptionHtml: "<p>Better <strong>linen</strong></p>",
    seo: { title: "SEO title", description: "SEO text" },
    tags: ["summer", "linen", "improved"],
  };
  const fields = ["descriptionHtml", "seo.description", "seo.title", "tags", "title"];
  const exact = readbackVerdicts(
    { ...source, ...approved, seo: { ...approved.seo } },
    approved,
    source,
    fields,
  );
  assert.equal(exact.verdict, "approved");
  // Tags reordered and re-cased, HTML whitespace changed, strings trimmed: approved.
  const reformatted = readbackVerdicts(
    {
      ...source,
      title: "  Linen shirt - improved ",
      descriptionHtml: "<p>\n  Better <strong>linen</strong> </p>",
      seo: { title: "SEO title", description: "SEO text" },
      tags: ["IMPROVED", "Linen", "summer"],
    },
    approved,
    source,
    fields,
  );
  assert.equal(reformatted.verdict, "approved", JSON.stringify(reformatted));
  // Nothing applied: every field as drafted.
  const untouched = readbackVerdicts(source, approved, source, fields);
  assert.equal(untouched.verdict, "source");
  // A merchant's edit at the same moment: mixed, the edited field other.
  const edited = readbackVerdicts(
    { ...source, ...approved, seo: { ...approved.seo }, title: "Merchant's title" },
    approved,
    source,
    fields,
  );
  assert.equal(edited.verdict, "mixed");
  assert.equal(edited.fields.title, "other");
  assert.equal(edited.fields.descriptionHtml, "approved");
  // Approved wins when the approved value equals the source value.
  const same = readbackVerdicts(source, { title: source.title }, source, ["title"]);
  assert.deepEqual(same, { fields: { title: "approved" }, verdict: "approved" });
  // Without the snapshot (expired), nothing is "source".
  assert.equal(readbackVerdicts(source, approved, null, ["title"]).fields.title, "other");
  // A null SEO value equals "" for approved, never for source (raw comparison).
  assert.equal(normalisedValue("seo.title", null), normalisedValue("seo.title", ""));
  assert.equal(
    readbackVerdicts({ ...source, seo: { title: "", description: "Old SEO" } }, approved, source, [
      "seo.title",
    ]).fields["seo.title"],
    "other",
  );
  // Fail safe: an attribute or a dropped tag never compares equal to the approved HTML.
  assert.notEqual(
    normalisedValue("descriptionHtml", '<p onclick="x">Better</p><script>1</script>'),
    normalisedValue("descriptionHtml", "<p>Better</p><p>more</p>"),
  );
  assert.throws(() => readbackVerdicts(source, approved, source, ["price"]));
  assert.throws(() => readbackVerdicts(source, { title: "x" }, source, ["tags"]));
});

// ---------------------------------------------------------------------------
// Shopify replies.
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const gid = "gid://shopify/Product/7";
const accepted = (id = gid) =>
  json(
    200,
    {
      data: {
        productUpdate: { product: { id, updatedAt: "2026-10-23T10:00:00Z" }, userErrors: [] },
      },
    },
    { "x-request-id": "req-0001-abcd" },
  );

test("every productUpdate reply is classified; only proof of no execution is failed", async () => {
  const run = async (responses) => {
    const sent = [];
    const reply = await shopifyAdminWrite(
      async (url, init) => {
        sent.push(JSON.parse(init.body));
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      shop,
      "shpat_" + "a".repeat(32),
      shopifyWriteDocuments.productUpdate,
      { product: { id: gid, title: "x" } },
      Date.now() + 5000,
      Date.now,
      async () => {},
    );
    return { reply, sent: sent.length, outcome: classifyProductUpdate(reply, gid) };
  };
  const throttled = () =>
    json(200, {
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: {
        cost: {
          requestedQueryCost: 10,
          throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
        },
      },
    });
  const cases = [
    [[accepted()], "submitted", "provider_accepted", 1],
    [[throttled(), accepted()], "submitted", "provider_accepted", 2],
    [[throttled(), throttled()], "failed", "throttled", 2],
    [[json(429, {})], "failed", "throttled", 1],
    [[json(401, {})], "failed", "connection_unauthorized", 1],
    [
      [json(200, { errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }] })],
      "failed",
      "access_denied",
      1,
    ],
    [
      [
        json(200, {
          data: {
            productUpdate: { product: null, userErrors: [{ field: ["title"], message: "x" }] },
          },
        }),
      ],
      "failed",
      "provider_rejected",
      1,
    ],
    [[json(502, {})], "uncertain", "server_error", 1],
    [[json(403, {})], "uncertain", "unexpected_status", 1],
    [[json(200, { errors: [{ message: "boom" }] })], "uncertain", "graphql_error", 1],
    [[new Response("not json", { status: 200 })], "uncertain", "reply_malformed", 1],
    [[accepted("gid://shopify/Product/8")], "uncertain", "reply_malformed", 1],
    [[new TypeError("connection lost")], "uncertain", "transport_lost", 1],
  ];
  for (const [responses, outcome, reason, sent] of cases) {
    const r = await run([...responses]);
    assert.deepEqual(
      [r.outcome.outcome, r.outcome.reason, r.sent],
      [outcome, reason, sent],
      reason,
    );
  }
  // No time left before the first request: nothing sent at all.
  const none = await shopifyAdminWrite(
    async () => {
      throw Error("never");
    },
    shop,
    "t",
    shopifyWriteDocuments.productUpdate,
    {},
    Date.now() - 1,
  );
  assert.deepEqual(classifyProductUpdate(none, gid), { outcome: "failed", reason: "not_sent" });
  // Never another host.
  assert.equal(
    (
      await shopifyAdminWrite(
        async () => accepted(),
        "evil.example.com",
        "t",
        "",
        {},
        Date.now() + 1000,
      )
    ).kind,
    "not_sent",
  );
});

test("the productUpdate input carries the product id and only the approved keys", () => {
  assert.deepEqual(productUpdateInput(gid, { title: "A" }), { id: gid, title: "A" });
  assert.deepEqual(
    productUpdateInput(gid, { tags: ["a"], seo: { title: "t", description: "d" } }),
    { id: gid, tags: ["a"], seo: { title: "t", description: "d" } },
  );
  assert.deepEqual(
    Object.keys(
      productUpdateInput(gid, {
        title: "A",
        descriptionHtml: "<p>x</p>",
        seo: { title: "t", description: "d" },
        tags: [],
      }),
    ).sort(),
    ["descriptionHtml", "id", "seo", "tags", "title"],
  );
});

// ---------------------------------------------------------------------------
// The broker's writer over a scripted vault and a scripted Shopify.
const login = JSON.parse(
  createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" })
    .configurationJson,
);
function brokerEnv(extra = {}) {
  return {
    MORROW_ENVIRONMENT: "development",
    LOGIN_CONFIGURATION_JSON: JSON.stringify({ ...login, retentionTier: "development" }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify({
      schemaVersion: 1,
      environment: "development",
      projectId: "morrow-apply-unit",
      branchId: "br-apply-unit",
      hostname: "ep-apply-unit.c-14.us-east-1.aws.neon.tech",
      database: "morrow",
    }),
    WORKOS_API_KEY: "sk_test_" + randomBytes(16).toString("hex"),
    ...Object.fromEntries(
      [...brokerNeonRoleNames, "morrow_vault_broker"].map((role) => [
        brokerPasswordSecret(role),
        "role-" + randomBytes(16).toString("hex"),
      ]),
    ),
    MORROW_VAULT_KEK_V1: randomBytes(32).toString("hex"),
    ...extra,
  };
}
const operationId = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b";
const token = "shpat_" + "b".repeat(32);
const item = {
  targetIndex: 0,
  productId: "product:7",
  set: { title: "Linen shirt - improved", tags: ["summer", "linen", "improved"] },
};
async function sealedRow(env) {
  const capabilities = await brokerCapabilities(env);
  const sealed = await sealVaultRecord(
    capabilities.vault.keyring,
    {
      kind: "shopify_offline_token",
      organizationId: "org_o",
      workspaceId: "ws_w",
      credentialId: "credential_unit",
      subjectId: "storeinst_unit",
      provider: "shopify",
      version: 1,
    },
    new TextEncoder().encode(token),
  );
  return {
    organization_id: "org_o",
    workspace_id: "ws_w",
    shop_domain: shop,
    product_id: "product:7",
    fields: "tags,title",
    item: JSON.stringify(item),
    store_installation_id: "storeinst_unit",
    credential_id: "credential_unit",
    credential_version: "1",
    kek_version: "1",
    wrapped_key: vaultBytesHex(sealed.wrappedKey),
    sealed_value: vaultBytesHex(sealed.sealedValue),
  };
}
// A Shopify of one product: ProductWriteState answers its state; ProductUpdate applies
// (or follows the queued fault) and is counted.
function scriptedShopify(state, faults = []) {
  const calls = [];
  return {
    calls,
    updates: () => calls.filter((c) => c === "ProductUpdate").length,
    async fetch(url, init) {
      assert.equal(new URL(url).host, shop);
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("x-shopify-access-token"), token);
      const body = JSON.parse(init.body);
      const operation = /^(?:query|mutation) ([A-Za-z]+)/.exec(body.query)[1];
      calls.push(operation);
      if (operation === "ProductWriteState") {
        const fault = faults[0] === "read_500" ? faults.shift() : null;
        if (fault) return json(500, {});
        return json(200, { data: { product: { id: gid, ...structuredClone(state) } } });
      }
      const fault = faults.shift() ?? null;
      if (fault === "lost_unapplied") throw new TypeError("lost");
      const input = body.variables.product;
      assert.deepEqual(Object.keys(input).sort(), ["id", "tags", "title"]);
      Object.assign(state, {
        title: input.title,
        tags: input.tags,
        updatedAt: "2026-10-23T10:00:01Z",
      });
      if (fault === "lost") throw new TypeError("lost");
      return accepted();
    },
  };
}
const shopState = () => ({
  title: "Linen shirt",
  descriptionHtml: "<p>Original</p>",
  tags: ["summer", "linen"],
  seo: { title: null, description: "Old SEO" },
  updatedAt: "2026-10-23T09:00:00Z",
});
const sourceOf = (s) => ({
  productId: "product:7",
  title: s.title,
  descriptionHtml: s.descriptionHtml,
  seo: { ...s.seo },
  tags: [...s.tags],
});
// A scripted vault: each fixed statement answers from `script` (a row list, a function of
// the values, or an Error); every call is logged by statement name.
function scriptedVault(script) {
  const log = [];
  const names = new Map(Object.entries(vaultStatements).map(([k, v]) => [v, k]));
  return {
    log,
    transaction: async (_vault, _budget, body) =>
      body(async (text, values) => {
        const name = names.get(text);
        assert.ok(name, "only fixed statements");
        log.push({ name, values: [...values] });
        const reply = script[name];
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? reply(values) : reply;
      }),
  };
}
const resolved = async (env, over = {}) => [
  {
    outcome: "resolved",
    status: "dispatching",
    reason: null,
    ...(await sealedRow(env)),
    request_digest: sha(changeItemText(item)),
    expected_source_revision: sha(listingSnapshotText(sourceOf(shopState()))),
    ...over,
  },
];

test("writer: the switch first; off holds before any input, vault or Shopify access", async () => {
  const vault = scriptedVault({});
  const shopify = scriptedShopify(shopState());
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  for (const env of [brokerEnv(), brokerEnv({ MORROW_SHOPIFY_WRITE: "yes" })])
    await assert.rejects(
      writer.apply(env, "not-an-id", -1),
      (e) => e instanceof BrokerHold && e.code === "WRITE_UNAVAILABLE",
    );
  assert.deepEqual(vault.log, []);
  assert.deepEqual(shopify.calls, []);
  // On: closed inputs are refused before the vault.
  const on = brokerEnv({ MORROW_SHOPIFY_WRITE: "on" });
  await assert.rejects(writer.apply(on, "x", 1000), (e) => e.code === "INPUT_INVALID");
  await assert.rejects(
    writer.apply(on, operationId, shopifyWriteLimits.budgetMaxMs + 1),
    (e) => e.code === "BUDGET_INVALID",
  );
  assert.deepEqual(vault.log, []);
});

test("writer: resolve, pre-send read, fence, one send of the approved keys, close", async () => {
  const env = brokerEnv({ MORROW_SHOPIFY_WRITE: "on" });
  const state = shopState();
  const shopify = scriptedShopify(state);
  const vault = scriptedVault({
    catalogWriteResolve: await resolved(env),
    catalogWriteBegin: [{ outcome: "send", status: "dispatching", reason: null }],
    catalogWriteEnd: [{ outcome: "recorded" }],
  });
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  const result = decodeShopifyApplyResult(await writer.apply(env, operationId, 20000));
  assert.deepEqual(result, {
    outcome: "submitted",
    status: "submitted",
    reason: "provider_accepted",
  });
  assert.deepEqual(
    vault.log.map((l) => l.name),
    ["catalogWriteResolve", "catalogWriteBegin", "catalogWriteEnd"],
  );
  // The fence carries the pre-send read's digest and updatedAt, and the credential version.
  const begin = vault.log[1].values;
  assert.deepEqual(begin, [
    operationId,
    "read",
    sha(listingSnapshotText(sourceOf(shopState()))),
    "2026-10-23T09:00:00Z",
    "1",
  ]);
  assert.deepEqual(vault.log[2].values, [
    operationId,
    "submitted",
    "provider_accepted",
    "req-0001-abcd",
  ]);
  assert.deepEqual(shopify.calls, ["ProductWriteState", "ProductUpdate"]);
  assert.equal(state.title, "Linen shirt - improved");
});

test("writer: an item that does not hash to the operation's digest is never sent or read", async () => {
  const env = brokerEnv({ MORROW_SHOPIFY_WRITE: "on" });
  const shopify = scriptedShopify(shopState());
  const vault = scriptedVault({
    catalogWriteResolve: await resolved(env, { request_digest: "f".repeat(64) }),
    catalogWriteBegin: (values) => {
      assert.deepEqual(values.slice(1, 4), ["mismatch", "", ""]);
      return [{ outcome: "refused", status: "failed", reason: "request_mismatch" }];
    },
  });
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  const result = decodeShopifyApplyResult(await writer.apply(env, operationId, 20000));
  assert.deepEqual(result, { outcome: "refused", status: "failed", reason: "request_mismatch" });
  assert.deepEqual(shopify.calls, []);
});

test("writer: a refusal, an operation in flight or settled, and a transient read send nothing", async () => {
  const env = brokerEnv({ MORROW_SHOPIFY_WRITE: "on" });
  for (const [script, expected] of [
    [
      {
        catalogWriteResolve: [
          { ...(await resolved(env))[0], outcome: "refused", status: "failed", reason: "stopped" },
        ],
      },
      { outcome: "refused", status: "failed", reason: "stopped" },
    ],
    [
      { catalogWriteResolve: [{ ...(await resolved(env))[0], outcome: "in_flight" }] },
      { outcome: "in_flight", status: "dispatching", reason: null },
    ],
    [
      {
        catalogWriteResolve: await resolved(env),
        catalogWriteBegin: [{ outcome: "refused", status: "failed", reason: "source_changed" }],
      },
      { outcome: "refused", status: "failed", reason: "source_changed" },
    ],
    [
      {
        catalogWriteResolve: await resolved(env),
        catalogWriteBegin: [{ outcome: "in_flight", status: "dispatching", reason: null }],
      },
      { outcome: "in_flight", status: "dispatching", reason: null },
    ],
  ]) {
    const shopify = scriptedShopify(shopState());
    const vault = scriptedVault(script);
    const writer = createShopifyWriter({
      transaction: vault.transaction,
      fetch: shopify.fetch,
      now: Date.now,
    });
    assert.deepEqual(
      decodeShopifyApplyResult(await writer.apply(env, operationId, 20000)),
      expected,
    );
    assert.equal(shopify.updates(), 0);
  }
  // A pre-send read that fails for a transient reason holds, with no fence.
  const shopify = scriptedShopify(shopState(), ["read_500"]);
  const vault = scriptedVault({ catalogWriteResolve: await resolved(env) });
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  assert.deepEqual(decodeShopifyApplyResult(await writer.apply(env, operationId, 20000)), {
    outcome: "held",
    status: "dispatching",
    reason: null,
  });
  assert.deepEqual(
    vault.log.map((l) => l.name),
    ["catalogWriteResolve"],
  );
  assert.equal(shopify.updates(), 0);
});

test("writer: a lost reply is uncertain and a lost close is uncertain; neither is ever resent", async () => {
  const env = brokerEnv({ MORROW_SHOPIFY_WRITE: "on" });
  const shopify = scriptedShopify(shopState(), ["lost"]);
  const vault = scriptedVault({
    catalogWriteResolve: await resolved(env),
    catalogWriteBegin: [{ outcome: "send", status: "dispatching", reason: null }],
    catalogWriteEnd: [{ outcome: "recorded" }],
  });
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  assert.deepEqual(decodeShopifyApplyResult(await writer.apply(env, operationId, 20000)), {
    outcome: "uncertain",
    status: "uncertain",
    reason: "transport_lost",
  });
  assert.deepEqual(vault.log[2].values, [operationId, "uncertain", "transport_lost", ""]);
  assert.equal(shopify.updates(), 1);
  // The close fails after the send: uncertain (the read-back settles the open fence).
  const shopify2 = scriptedShopify(shopState());
  const vault2 = scriptedVault({
    catalogWriteResolve: await resolved(env),
    catalogWriteBegin: [{ outcome: "send", status: "dispatching", reason: null }],
    catalogWriteEnd: Error("connection lost"),
  });
  const writer2 = createShopifyWriter({
    transaction: vault2.transaction,
    fetch: shopify2.fetch,
    now: Date.now,
  });
  assert.deepEqual(decodeShopifyApplyResult(await writer2.apply(env, operationId, 20000)), {
    outcome: "uncertain",
    status: null,
    reason: "close_unknown",
  });
  assert.equal(shopify2.updates(), 1);
});

test("writer: the read-back records per-field verdict codes and never a value", async () => {
  const env = brokerEnv();
  const state = shopState();
  const source = sourceOf(state);
  Object.assign(state, {
    title: item.set.title,
    tags: ["IMPROVED", "Linen", "summer"],
    updatedAt: "2026-10-23T10:00:01Z",
  });
  const shopify = scriptedShopify(state);
  const row = await sealedRow(env);
  const vault = scriptedVault({
    catalogReconcileResolve: [
      {
        outcome: "resolved",
        status: "uncertain",
        ...row,
        source: listingSnapshotText(source),
        source_updated_at: "2026-10-23T09:00:00Z",
      },
    ],
    catalogReconcileRecord: (values) => {
      assert.deepEqual(values, [
        operationId,
        "read",
        "2026-10-23T10:00:01Z",
        JSON.stringify({ tags: "approved", title: "approved" }),
        "approved",
      ]);
      return [{ outcome: "recorded", status: "verified" }];
    },
  });
  // The read-back is never blocked by the apply switch (off here).
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  assert.deepEqual(decodeShopifyReconcileResult(await writer.reconcile(env, operationId, 10000)), {
    outcome: "recorded",
    status: "verified",
    verdict: "approved",
  });
  assert.deepEqual(shopify.calls, ["ProductWriteState"]);
  for (const entry of vault.log)
    for (const v of entry.values) assert.ok(!String(v).includes("Linen shirt"));
  // Too soon or settled: no read at all.
  const columns = [
    "outcome",
    "status",
    "organization_id",
    "workspace_id",
    "shop_domain",
    "product_id",
    "fields",
    "item",
    "source",
    "source_updated_at",
    "store_installation_id",
    "credential_id",
    "credential_version",
    "kek_version",
    "wrapped_key",
    "sealed_value",
  ];
  const early = scriptedVault({
    catalogReconcileResolve: [
      {
        ...Object.fromEntries(columns.map((c) => [c, null])),
        outcome: "too_soon",
        status: "uncertain",
      },
    ],
  });
  const shopify2 = scriptedShopify(shopState());
  const writer2 = createShopifyWriter({
    transaction: early.transaction,
    fetch: shopify2.fetch,
    now: Date.now,
  });
  assert.equal(
    decodeShopifyReconcileResult(await writer2.reconcile(env, operationId, 10000)).outcome,
    "too_soon",
  );
  assert.deepEqual(shopify2.calls, []);
});

// ---------------------------------------------------------------------------
// The api's apply loop over one dispatching operation.
test("apply through the broker: an unknown outcome is read back, never sent again", async () => {
  const run = async (applies) => {
    const calls = [];
    const port = {
      async apply() {
        calls.push("apply");
        const next = applies.shift();
        if (next instanceof Error) throw next;
        return encodeShopifyApplyResult(next);
      },
      async reconcile() {
        calls.push("reconcile");
        return JSON.stringify({
          schemaVersion: 1,
          outcome: "recorded",
          status: "verified",
          verdict: "approved",
        });
      },
    };
    await applyThroughBroker(
      port,
      operationId,
      Date.now() + 50000,
      new AbortController().signal,
      Date.now,
      async () => {},
    );
    return calls;
  };
  assert.deepEqual(await run([Error("rpc lost")]), ["apply", "reconcile"]);
  assert.deepEqual(
    await run([{ outcome: "uncertain", status: "uncertain", reason: "transport_lost" }]),
    ["apply", "reconcile"],
  );
  assert.deepEqual(
    await run([{ outcome: "submitted", status: "submitted", reason: "provider_accepted" }]),
    ["apply", "reconcile"],
  );
  assert.deepEqual(
    await run([{ outcome: "refused", status: "failed", reason: "source_changed" }]),
    ["apply"],
  );
  assert.deepEqual(
    await run([{ outcome: "failed", status: "failed", reason: "provider_rejected" }]),
    ["apply"],
  );
  // A held pre-send read (nothing fenced, nothing sent) is tried once more, then left.
  assert.deepEqual(
    await run([
      { outcome: "held", status: "dispatching", reason: null },
      { outcome: "held", status: "dispatching", reason: null },
    ]),
    ["apply", "apply"],
  );
  // No time left: nothing is called.
  const calls = [];
  await applyThroughBroker(
    { apply: async () => calls.push("apply"), reconcile: async () => calls.push("reconcile") },
    operationId,
    Date.now() + 1000,
    new AbortController().signal,
    Date.now,
  );
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// The review view.
test("the review view: before and after per field, tag changes, flags, expired and derived", () => {
  const target = (id, fields) => ({ resource: { id }, fields });
  const proposal = {
    targets: [target("product:1", ["tags", "title"]), target("product:2", ["descriptionHtml"])],
    derivedFrom: null,
  };
  const parameters = {
    items: [
      { targetIndex: 0, productId: "product:1", set: { title: "New", tags: ["A", "c"] } },
      { targetIndex: 1, productId: "product:2", set: { descriptionHtml: "<p>new</p>" } },
    ],
  };
  const snapshot = JSON.stringify({ ...product({ productId: "product:1", tags: ["a", "b"] }) });
  const sources = [
    { targetIndex: 0, productId: "product:1", state: "available", snapshot },
    { targetIndex: 1, productId: "product:2", state: "expired", snapshot: null },
  ];
  const flags = new Map([
    [
      "product:1",
      JSON.stringify({ newEmails: 0, newPhones: 0, newUrls: 1, tagsAdded: 1, tagsRemoved: 1 }),
    ],
  ]);
  const [first, second] = buildProductReviews(proposal, parameters, sources, flags);
  assert.deepEqual(first.changes, [
    { field: "title", before: "Linen shirt", after: "New" },
    { field: "tags", before: ["a", "b"], after: ["A", "c"] },
  ]);
  assert.deepEqual(first.tags, { added: ["c"], removed: ["b"] });
  assert.equal(first.flags.newUrls, 1);
  assert.equal(second.source, "expired");
  assert.deepEqual(second.changes, [
    { field: "descriptionHtml", before: null, after: "<p>new</p>" },
  ]);
  assert.equal(second.flags, null);
  // A derived proposal maps its targets to the root's indexes.
  const derived = { targets: [proposal.targets[1]], derivedFrom: { selectedTargetIndexes: [1] } };
  const [only] = buildProductReviews(derived, parameters, sources, flags);
  assert.equal(only.targetIndex, 1);
  // A record that does not match is a server fault, never a partial view.
  assert.throws(() =>
    buildProductReviews(
      proposal,
      { items: [parameters.items[1], parameters.items[1]] },
      sources,
      flags,
    ),
  );
});

// ---------------------------------------------------------------------------
// The routes.
const key = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7c";
function request(method, path, body) {
  const headers = {
    Cookie: "__Host-morrow_session=" + workGuardSecret,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
  if (method !== "GET")
    Object.assign(headers, {
      Origin: workGuardOrigin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Idempotency-Key": key,
    });
  return new Request(workGuardOrigin + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("the review routes and the api dispatch: review paths go to the review handler", () => {
  assert.deepEqual(
    reviewRoutes.map((r) => r.method + " " + r.pattern),
    [
      "GET /approvals",
      "GET /proposals/:proposalId/review",
      "POST /proposals/:proposalId/decision",
      "POST /proposals/:proposalId/apply",
      "GET /tasks/:taskId/operations",
      "GET /operations/:operationId",
      "POST /operations/:operationId/reconcile",
    ],
  );
  for (const path of [
    "/workspace/ws_w/work/approvals",
    "/workspace/ws_w/work/proposals/p_1/review",
    "/workspace/ws_w/work/proposals/p_1/decision",
    "/workspace/ws_w/work/proposals/p_1/apply",
    "/workspace/ws_w/work/tasks/t_1/operations",
    "/workspace/ws_w/work/operations/" + operationId,
    "/workspace/ws_w/work/operations/" + operationId + "/reconcile",
  ]) {
    assert.ok(reviewPathPattern.test(path), path);
    assert.equal(apiDispatch(path), "review", path);
  }
  for (const [path, row] of [
    ["/workspace/ws_w/work/tasks/t_1", "work"],
    ["/workspace/ws_w/work/proposals/p_1", "work"],
    ["/workspace/ws_w/work/proposals/p_1/apply/x", "work"],
    ["/workspace/ws_w/work/tasks/t_1/runs", "runs"],
  ])
    assert.equal(apiDispatch(path), row, path);
});

test("apply with the switch off answers 503 before any database or broker access", async (t) => {
  t.mock.method(console, "log", () => {});
  let opens = 0;
  let brokerCalls = 0;
  const handler = createReviewApiHandler({
    origin: workGuardOrigin,
    connector: {
      async open() {
        opens++;
        throw Error("NO_DATABASE_IN_THIS_TEST");
      },
    },
    now: Date.now,
    environment: "development",
    applyOpen: false,
    broker: {
      apply: async () => (brokerCalls++, ""),
      reconcile: async () => (brokerCalls++, ""),
    },
  });
  const response = await handler.fetch(
    request("POST", "/workspace/ws_w/work/proposals/p_1/apply", {
      proposalRef: {},
      approvalRef: {},
    }),
    {},
    { waitUntil() {} },
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.ok(validateDefinition("core", "ErrorEnvelope", body));
  assert.equal(body.code, "unavailable");
  assert.equal(body.safeMessage, "Applying changes to Shopify is not switched on yet.");
  assert.equal(opens, 0);
  assert.equal(brokerCalls, 0);
  // The unbound handler answers 401 with no I/O; a bad configuration never builds.
  const unbound = await createReviewApiHandler().fetch(
    request("GET", "/workspace/ws_w/work/approvals"),
    {},
    { waitUntil() {} },
  );
  assert.equal(unbound.status, 401);
  assert.throws(
    () =>
      createReviewApiHandler({
        origin: workGuardOrigin,
        connector: { open() {} },
        now: Date.now,
        environment: "test",
        applyOpen: true,
        broker: null,
      }),
    /REVIEW_API_CONFIGURATION_INVALID/,
  );
});

// ---------------------------------------------------------------------------
// The reviewed switch.
test("the apply switch is committed off and appears only on the staging api and broker", () => {
  const record = JSON.parse(readFileSync("docs/decisions/shopify-write-staging.json", "utf8"));
  assert.deepEqual(reviewedApplyRecord(record), { switch: "off" });
  for (const bad of [
    { ...record, switch: "maybe" },
    { ...record, environment_kind: "production" },
    { ...record, extra: true },
    null,
  ])
    assert.throws(() => reviewedApplyRecord(bad), /EDGE_STAGING_APPLY_RECORD/);
  assert.deepEqual(edgeApplyVarNames("api", "staging"), ["MORROW_SHOPIFY_WRITE"]);
  assert.deepEqual(edgeApplyVarNames("broker", "staging"), ["MORROW_SHOPIFY_WRITE"]);
  for (const [worker, environment] of [
    ["orchestrator", "staging"],
    ["connector", "staging"],
    ["api", "development"],
    ["broker", "production"],
  ])
    assert.deepEqual(edgeApplyVarNames(worker, environment), [], worker + " " + environment);
  assert.ok(edgeVarNames("api", "staging", "off", "off", "on").includes("MORROW_SHOPIFY_WRITE"));
  assert.ok(!edgeVarNames("api", "staging", "off", "off", "off").includes("MORROW_SHOPIFY_WRITE"));
  // No wrangler configuration carries the var while the record is off.
  for (const worker of ["api", "broker", "workers", "shopify-connector"])
    assert.ok(
      !readFileSync(`apps/${worker}/wrangler.jsonc`, "utf8").includes("MORROW_SHOPIFY_WRITE"),
      worker,
    );
});

test("a derived proposal's id is morrow_work.derived_proposal_id's, store or no store", async () => {
  const { derivedProposalIdOf, previewSelection } = await import(
    "../packages/policy/src/review.ts"
  );
  const { derivedProposalId } = await import("../packages/work/src/approvals/digests.ts");
  // 0018's SQL: the parent by tenant, id and digest, with "storeId":null, then the indexes.
  const sqlId = (org, ws, id, digest, indexes) =>
    "derived_" +
    sha(
      `{"parentRef":{"digest":"${digest}","id":"${id}","kind":"proposal","organizationId":"${org}","revision":1,"storeId":null,"workspaceId":"${ws}"},"selectedTargetIndexes":[${indexes.join(",")}]}`,
    );
  const parentRef = (storeId) => ({
    organizationId: "org_o",
    workspaceId: "ws_w",
    storeId,
    kind: "proposal",
    id: "proposal_1",
    revision: 1,
    digest: "d".repeat(64),
  });
  for (const storeId of [null, "store_a"]) {
    assert.equal(
      derivedProposalIdOf(parentRef(storeId), [0, 2]),
      sqlId("org_o", "ws_w", "proposal_1", "d".repeat(64), [0, 2]),
    );
    assert.equal(
      derivedProposalId(parentRef(storeId), [1]),
      sqlId("org_o", "ws_w", "proposal_1", "d".repeat(64), [1]),
    );
  }
  assert.equal(typeof previewSelection, "function");
});
