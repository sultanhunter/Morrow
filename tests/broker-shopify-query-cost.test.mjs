// Plan row SD5 (docs/briefs/sd5-shopify-query-cost.md): per-shop buckets for Shopify's API
// query cost, Shopify's rate limit in its cost points (never money), over a faked vault
// database and a faked Shopify (no network, no database). The broker's take and settle
// statements and their closed rows; the settle's parameters (Shopify's values outside the
// table's safety ranges dropped, never clamped); when a wait is spent in the broker and when a
// read parks; bucketedShopifyCall's take, wait, send, settle and THROTTLED retake; the reader
// with the switch on (the first take in the resolution's transaction, after a resolved
// resolution only; the token opened only when the document is sent; a parked read answered
// as the protocol's closed `parked` result and never sent; an agent read parked where a
// person read waits) and off (M2 PR-3's path, no bucket statement); the protocol's parked
// result; the Listings product read; the switch record and edge:check's guard; and the
// migration's shape, grants and policy against the broker's constants (drift). The real SQL
// runs in lab:shopify-query-cost.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeShopifyReadResult,
  shopifyQueryCostOn,
  shopifyQueryCostVar,
  shopifyReadLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { productReadOf } from "../packages/work/src/runs/workflow.ts";
import { createShopifyReader } from "../apps/broker/src/shopify-read.ts";
import {
  bucketedShopifyCall,
  queryCostClasses,
  settleShopifyQueryCost,
  shopifyQueryCostPolicy,
  shopifyQueryCostSettleValues,
  shopifyQueryCostWaits,
  takeShopifyQueryCost,
  waitsInline,
} from "../apps/broker/src/shopify-query-cost.ts";
import {
  shopifyAdminGraphql,
  shopifyAdminGraphqlOnce,
  shopifyCostReport,
  shopifyReadCosts,
  shopifyReadDocuments,
} from "../apps/broker/src/shopify.ts";
import { shopifyWriteDocuments } from "../apps/broker/src/shopify-write.ts";
import {
  VaultError,
  createVaultKeyring,
  sealVaultRecord,
  vaultBytesHex,
  vaultStatements,
} from "../apps/broker/src/vault.ts";
import { shopifyOracleCosts } from "../scripts/fixtures/shopify-oracle.mjs";
import {
  edgeQueryCostVar,
  edgeQueryCostVarNames,
  edgeVarNames,
  edgeWorkers,
  reviewedQueryCostRecord,
  verifyEdgeConfig,
} from "../scripts/edge.mjs";

const read = (path) => readFileSync(path, "utf8");
const manifest = JSON.parse(read("migrations/manifest.json"));
const slug = "shopify-query-cost";
const row = manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const sql = read("migrations/" + row.file);
const flat = (text) => text.replace(/--.*$/gm, "").replace(/\s+/g, " ");

const kek = randomBytes(32).toString("hex");
const token = "shpat_" + randomBytes(16).toString("hex");
const shop = "dev-store-1.myshopify.com";
const lease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ids = {
  org: "org_cost",
  ws: "ws_cost",
  store: "store_cost",
  connection: "connection_cost",
  installation: "installation_cost",
  credential: "credential_cost",
};
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-broker-unit",
  branchId: "br-broker-unit",
  hostname: "ep-broker-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const env = (queryCost) => ({
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
  ...(queryCost === undefined ? {} : { MORROW_SHOPIFY_QUERY_COST: queryCost }),
});
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));

// ---------------------------------------------------------------------------
// The statements and their rows.
const names = new Map(Object.entries(vaultStatements).map(([name, text]) => [text, name]));
function fakeQuery(rows) {
  const sent = [];
  const query = async (text, values) => {
    assert.ok(names.has(text), "a registered statement");
    assert.ok(values.every((v) => typeof v === "string"));
    sent.push([names.get(text), values]);
    const next = typeof rows === "function" ? rows(names.get(text), values) : rows.shift();
    return next;
  };
  return { query, sent };
}

test("the take: one registered statement, closed inputs, closed rows", async () => {
  assert.equal(
    vaultStatements.shopifyQueryCostTake,
    "SELECT outcome,wait_ms FROM morrow_vault.shopify_query_cost_take($1,$2,$3)",
  );
  const cases = [
    [{ outcome: "admitted", wait_ms: "0" }, { kind: "admitted" }],
    [{ outcome: "wait", wait_ms: "340" }, { kind: "wait", waitMs: 340 }],
    [{ outcome: "wait", wait_ms: "3600000" }, { kind: "wait", waitMs: 3_600_000 }],
    [{ outcome: "too_costly", wait_ms: null }, { kind: "refused", reason: "too_costly" }],
    [{ outcome: "not_found", wait_ms: null }, { kind: "refused", reason: "not_found" }],
    [{ outcome: "invalid", wait_ms: null }, { kind: "refused", reason: "invalid" }],
    [{ outcome: "denied", wait_ms: null }, { kind: "refused", reason: "denied" }],
  ];
  for (const [rowValue, expected] of cases) {
    const q = fakeQuery([[rowValue]]);
    assert.deepEqual(
      await takeShopifyQueryCost(q.query, ids.installation, "person_read", 27),
      expected,
    );
    assert.deepEqual(q.sent, [
      ["shopifyQueryCostTake", [ids.installation, "person_read", "27"]],
    ]);
  }
  // Malformed rows are a VaultError, never an admission.
  for (const rows of [
    [],
    [{ outcome: "admitted", wait_ms: "0" }, { outcome: "admitted", wait_ms: "0" }],
    [{ outcome: "admitted", wait_ms: "5" }],
    [{ outcome: "admitted" }],
    [{ outcome: "admitted", wait_ms: "0", extra: 1 }],
    [{ outcome: "wait", wait_ms: "0" }],
    [{ outcome: "wait", wait_ms: "3600001" }],
    [{ outcome: "wait", wait_ms: null }],
    [{ outcome: "not_found", wait_ms: "1" }],
    [{ outcome: "yes", wait_ms: null }],
  ])
    await assert.rejects(
      takeShopifyQueryCost(fakeQuery([rows]).query, ids.installation, "agent_read", 2),
      (e) => e instanceof VaultError && e.code === "VAULT_RECORD_INVALID",
      JSON.stringify(rows),
    );
  // Closed inputs: nothing is sent for a bad class, cost or installation id.
  for (const [installation, cls, cost] of [
    [ids.installation, "everything", 2],
    [ids.installation, "agent_read", 0],
    [ids.installation, "agent_read", 1001],
    [ids.installation, "agent_read", 2.5],
    [ids.installation, "agent_read", "2"],
    ["has space", "agent_read", 2],
    ["", "agent_read", 2],
  ]) {
    const q = fakeQuery([]);
    await assert.rejects(
      takeShopifyQueryCost(q.query, installation, cls, cost),
      (e) => e instanceof VaultError && e.code === "VAULT_INPUT_INVALID",
    );
    assert.equal(q.sent.length, 0);
  }
});

test("the settle: Shopify's report as decimal text; values outside the safety ranges dropped", async () => {
  assert.equal(
    vaultStatements.shopifyQueryCostSettle,
    "SELECT morrow_vault.shopify_query_cost_settle($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),$7) AS outcome",
  );
  const report = (over = {}) => ({
    requested: 27,
    actual: 20,
    available: 1973.5,
    maximum: 2000,
    restoreRate: 100,
    ...over,
  });
  assert.deepEqual(shopifyQueryCostSettleValues(27, report(), false), [
    "27",
    "20",
    "1973.500",
    "2000.000",
    "100.000",
    "false",
  ]);
  assert.deepEqual(shopifyQueryCostSettleValues(27, null, true), ["27", "", "", "", "", "true"]);
  // Out of range or not whole: dropped (the bucket keeps what it had), never clamped.
  assert.deepEqual(
    shopifyQueryCostSettleValues(
      27,
      report({ actual: 1.5, available: -1, maximum: 50, restoreRate: 0.5 }),
      false,
    ),
    ["27", "", "", "", "", "false"],
  );
  assert.deepEqual(
    shopifyQueryCostSettleValues(
      27,
      report({ actual: 1001, available: 1_000_001, maximum: 1_000_001, restoreRate: 100_001 }),
      false,
    ),
    ["27", "", "", "", "", "false"],
  );
  assert.deepEqual(shopifyQueryCostSettleValues(27, report({ available: 0 }), false)[2], "0.000");
  // The definer's own decimal pattern admits every value the broker sends.
  const decimal = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/;
  for (const v of [0, 0.001, 99.999, 100, 1_000_000])
    assert.match(shopifyQueryCostSettleValues(1, report({ available: v }), false)[2], decimal);
  const q = fakeQuery([[{ outcome: "settled" }]]);
  assert.equal(await settleShopifyQueryCost(q.query, ids.installation, 27, report(), false), "settled");
  assert.deepEqual(q.sent, [
    [
      "shopifyQueryCostSettle",
      [ids.installation, "27", "20", "1973.500", "2000.000", "100.000", "false"],
    ],
  ]);
  for (const outcome of ["not_found", "invalid", "denied"])
    assert.equal(
      await settleShopifyQueryCost(
        fakeQuery([[{ outcome }]]).query,
        ids.installation,
        2,
        null,
        true,
      ),
      outcome,
    );
  for (const rows of [[], [{ outcome: "maybe" }], [{ outcome: "settled", more: 1 }]])
    await assert.rejects(
      settleShopifyQueryCost(fakeQuery([rows]).query, ids.installation, 2, null, true),
      (e) => e instanceof VaultError && e.code === "VAULT_RECORD_INVALID",
    );
});

test("waits: a person read waits within its budget, an agent read only briefly, the rest park", () => {
  const now = 1000;
  const reserve = shopifyQueryCostWaits.sendReserveMs;
  assert.equal(waitsInline("person_read", 4000, now, now + 4000 + reserve), true);
  assert.equal(waitsInline("person_read", 4000, now, now + 4000 + reserve - 1), false);
  assert.equal(waitsInline("agent_read", 1000, now, now + 15000), true);
  assert.equal(waitsInline("agent_read", 1001, now, now + 15000), false);
  assert.equal(waitsInline("agent_read", 500, now, now + 500 + reserve - 1), false);
  for (const cls of ["reconciliation", "bulk"])
    assert.equal(waitsInline(cls, 1, now, now + 60000), false, cls);
});

// ---------------------------------------------------------------------------
// bucketedShopifyCall over a scripted bucket.
function scriptedCall({ takes, sends, settleFails = false, cls = "agent_read", budget = 15000 }) {
  const events = [];
  const clock = { ms: 5_000_000 };
  const takeRows = [...takes];
  const sendReplies = [...sends];
  const call = {
    installationId: ids.installation,
    cls,
    cost: 27,
    deadlineMs: clock.ms + budget,
    now: () => clock.ms,
    sleep: async (ms) => {
      events.push("sleep:" + ms);
      clock.ms += ms;
    },
    transact: async (body) =>
      body(async (text, values) => {
        const name = names.get(text);
        events.push(name + ":" + values.join(","));
        if (name === "shopifyQueryCostTake") return [takeRows.shift()];
        if (settleFails) throw new VaultError("VAULT_DATABASE_UNAVAILABLE");
        return [{ outcome: "settled" }];
      }),
    send: async () => {
      const reply = sendReplies.shift();
      events.push("send:" + (reply.throttled ? "throttled" : "data"));
      return reply;
    },
  };
  return { call, events };
}
const data = (cost = { requested: 27, actual: 25, available: 900, maximum: 1000, restoreRate: 50 }) => ({
  reply: "data",
  cost,
  throttled: false,
  answered: true,
});
const throttledReply = {
  reply: "throttled",
  cost: { requested: 27, actual: null, available: 3, maximum: 1000, restoreRate: 50 },
  throttled: true,
  answered: true,
};
const admitted = { outcome: "admitted", wait_ms: "0" };
const wait = (ms) => ({ outcome: "wait", wait_ms: String(ms) });

test("a bucketed call: take, send once, settle from Shopify's report", async () => {
  const s = scriptedCall({ takes: [admitted], sends: [data()] });
  assert.deepEqual(await bucketedShopifyCall(s.call), { kind: "reply", reply: "data" });
  assert.deepEqual(s.events, [
    "shopifyQueryCostTake:installation_cost,agent_read,27",
    "send:data",
    "shopifyQueryCostSettle:installation_cost,27,25,900.000,1000.000,50.000,false",
  ]);
  // A reply with no cost report settles nothing (the charge stands); a failed settle is dropped.
  const quiet = scriptedCall({
    takes: [admitted],
    sends: [{ reply: "data", cost: null, throttled: false, answered: true }],
  });
  assert.deepEqual(await bucketedShopifyCall(quiet.call), { kind: "reply", reply: "data" });
  assert.deepEqual(quiet.events, ["shopifyQueryCostTake:installation_cost,agent_read,27", "send:data"]);
  const failing = scriptedCall({ takes: [admitted], sends: [data()], settleFails: true });
  assert.deepEqual(await bucketedShopifyCall(failing.call), { kind: "reply", reply: "data" });
  // A reply Shopify never answered (a transport failure) is not settled either.
  const lost = scriptedCall({
    takes: [admitted],
    sends: [{ reply: "lost", cost: null, throttled: false, answered: false }],
  });
  assert.deepEqual(await bucketedShopifyCall(lost.call), { kind: "reply", reply: "lost" });
  assert.equal(lost.events.length, 2);
});

test("a bucketed call: a short wait in the broker, a long one parks unsent, a refusal sends nothing", async () => {
  const short = scriptedCall({ takes: [wait(400), admitted], sends: [data()] });
  assert.deepEqual(await bucketedShopifyCall(short.call), { kind: "reply", reply: "data" });
  assert.deepEqual(short.events.slice(0, 3), [
    "shopifyQueryCostTake:installation_cost,agent_read,27",
    "sleep:400",
    "shopifyQueryCostTake:installation_cost,agent_read,27",
  ]);
  // An agent read past its inline wait parks: nothing is sent, nothing settled.
  const long = scriptedCall({ takes: [wait(2500)], sends: [] });
  assert.deepEqual(await bucketedShopifyCall(long.call), { kind: "parked", retryAfterMs: 2500 });
  assert.deepEqual(long.events, ["shopifyQueryCostTake:installation_cost,agent_read,27"]);
  // The same wait is spent by a person read within its budget, and parks past it.
  const person = scriptedCall({ cls: "person_read", takes: [wait(2500), admitted], sends: [data()] });
  assert.deepEqual(await bucketedShopifyCall(person.call), { kind: "reply", reply: "data" });
  assert.ok(person.events.includes("sleep:2500"));
  const late = scriptedCall({ cls: "person_read", budget: 4000, takes: [wait(2500)], sends: [] });
  assert.deepEqual(await bucketedShopifyCall(late.call), { kind: "parked", retryAfterMs: 2500 });
  // The caller's first take is used as is (the resolution's transaction made it).
  const first = scriptedCall({ takes: [], sends: [] });
  assert.deepEqual(
    await bucketedShopifyCall({ ...first.call, first: { kind: "wait", waitMs: 90_000 } }),
    { kind: "parked", retryAfterMs: 90_000 },
  );
  assert.deepEqual(first.events, []);
  for (const reason of ["too_costly", "not_found", "invalid", "denied"]) {
    const refused = scriptedCall({ takes: [{ outcome: reason, wait_ms: null }], sends: [] });
    assert.deepEqual(await bucketedShopifyCall(refused.call), { kind: "refused", reason });
    assert.ok(!refused.events.some((e) => e.startsWith("send")));
  }
  // At most maxTakes takes: a bucket that keeps saying "wait" parks.
  const spinning = scriptedCall({
    cls: "person_read",
    takes: Array.from({ length: 10 }, () => wait(10)),
    sends: [],
  });
  assert.deepEqual(await bucketedShopifyCall(spinning.call), { kind: "parked", retryAfterMs: 10 });
  assert.equal(
    spinning.events.filter((e) => e.startsWith("shopifyQueryCostTake")).length,
    shopifyQueryCostWaits.maxTakes,
  );
});

test("a bucketed call: THROTTLED refunds and settles, then takes again from the corrected bucket", async () => {
  const s = scriptedCall({
    cls: "person_read",
    takes: [admitted, wait(1500), admitted],
    sends: [throttledReply, data()],
  });
  assert.deepEqual(await bucketedShopifyCall(s.call), { kind: "reply", reply: "data" });
  assert.deepEqual(s.events, [
    "shopifyQueryCostTake:installation_cost,person_read,27",
    "send:throttled",
    "shopifyQueryCostSettle:installation_cost,27,,3.000,1000.000,50.000,true",
    "shopifyQueryCostTake:installation_cost,person_read,27",
    "sleep:1500",
    "shopifyQueryCostTake:installation_cost,person_read,27",
    "send:data",
    "shopifyQueryCostSettle:installation_cost,27,25,900.000,1000.000,50.000,false",
  ]);
  // THROTTLED on every take: parked after maxTakes, never sent past it.
  const always = scriptedCall({
    cls: "person_read",
    takes: Array.from({ length: 6 }, () => admitted),
    sends: Array.from({ length: 6 }, () => throttledReply),
  });
  assert.deepEqual(await bucketedShopifyCall(always.call), {
    kind: "parked",
    retryAfterMs: shopifyQueryCostWaits.unknownWaitMs,
  });
  assert.equal(
    always.events.filter((e) => e === "send:throttled").length,
    shopifyQueryCostWaits.maxTakes,
  );
});

// ---------------------------------------------------------------------------
// Shopify's single attempt and its cost report.
test("one attempt: data and THROTTLED carry Shopify's cost report; no time left sends nothing", async () => {
  const extensions = {
    cost: {
      requestedQueryCost: 27,
      actualQueryCost: 12,
      throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1988, restoreRate: 100 },
    },
  };
  assert.deepEqual(shopifyCostReport({ extensions }), {
    requested: 27,
    actual: 12,
    available: 1988,
    maximum: 2000,
    restoreRate: 100,
  });
  assert.equal(shopifyCostReport({ data: {} }), null);
  assert.deepEqual(
    shopifyCostReport({ extensions: { cost: { requestedQueryCost: "27", throttleStatus: null } } }),
    { requested: null, actual: null, available: null, maximum: null, restoreRate: null },
  );
  const fetchOf = (body, status = 200) => {
    const calls = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      },
    };
  };
  const ok = fetchOf({ data: { shop: { id: 1 } }, extensions });
  const reply = await shopifyAdminGraphqlOnce(ok.fetch, shop, token, "query X { shop { id } }", {}, Date.now() + 5000);
  assert.equal(reply.kind, "data");
  assert.deepEqual(reply.cost, shopifyCostReport({ extensions }));
  const throttled = fetchOf({
    errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    extensions,
  });
  const t = await shopifyAdminGraphqlOnce(throttled.fetch, shop, token, "query X { a }", {}, Date.now() + 5000);
  assert.deepEqual(t, { kind: "throttled", cost: shopifyCostReport({ extensions }) });
  assert.equal(throttled.calls.length, 1, "one attempt: no wait, no resend");
  const late = fetchOf({ data: {} });
  assert.deepEqual(
    await shopifyAdminGraphqlOnce(late.fetch, shop, token, "query X { a }", {}, Date.now() - 1),
    { kind: "refused", reason: "deadline" },
  );
  assert.equal(late.calls.length, 0);
  assert.deepEqual(
    await shopifyAdminGraphqlOnce(fetchOf({}, 401).fetch, shop, token, "q", {}, Date.now() + 5000),
    { kind: "unauthorized", reason: "http_401" },
  );
  assert.deepEqual(
    await shopifyAdminGraphqlOnce(
      fetchOf({ errors: [{ message: "x" }] }).fetch,
      shop,
      token,
      "q",
      {},
      Date.now() + 5000,
    ),
    { kind: "refused", reason: "graphql_errors" },
  );
  // M2 PR-3's wrapper is unchanged: one THROTTLED wait for the requested cost, then a resend.
  let n = 0;
  const waits = [];
  const once = async () => {
    n++;
    return new Response(
      JSON.stringify(
        n === 1
          ? {
              errors: [{ extensions: { code: "THROTTLED" } }],
              extensions: {
                cost: {
                  requestedQueryCost: 27,
                  throttleStatus: { currentlyAvailable: 2, restoreRate: 50, maximumAvailable: 1000 },
                },
              },
            }
          : { data: { ok: true } },
      ),
    );
  };
  const wrapped = await shopifyAdminGraphql(
    once,
    shop,
    token,
    "query X { a }",
    {},
    Date.now() + 10000,
    Date.now,
    async (ms) => waits.push(ms),
  );
  assert.deepEqual(wrapped, { kind: "data", data: { ok: true } });
  assert.deepEqual(waits, [500]);
});

// ---------------------------------------------------------------------------
// The reader with the switch on and off.
async function readerHarness(options = {}) {
  const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
  const envelope = await sealVaultRecord(
    keyring,
    {
      kind: "shopify_offline_token",
      organizationId: ids.org,
      workspaceId: ids.ws,
      credentialId: ids.credential,
      subjectId: ids.installation,
      provider: "shopify",
      version: 2,
    },
    new TextEncoder().encode(token),
  );
  const events = [];
  const takes = [...(options.takes ?? [admitted])];
  const transaction = async (vault, budgetMs, body) => {
    assert.ok(vault.keyring && vault.binding, "the vault capability");
    assert.ok(Number.isSafeInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 3000);
    events.push("begin");
    const value = await body(async (text, values) => {
      const name = names.get(text);
      assert.ok(name, "a registered statement");
      events.push(name);
      if (name === "shopifyReadResolve")
        return [
          {
            outcome: options.outcome ?? "resolved",
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
      if (name === "shopifyQueryCostTake") {
        assert.deepEqual(values.slice(0, 1), [ids.installation]);
        events.push("take:" + values[1] + ":" + values[2]);
        return [takes.shift()];
      }
      if (name === "shopifyQueryCostSettle") {
        events.push("settle:" + values.slice(1).join(","));
        return [{ outcome: "settled" }];
      }
      assert.fail("unexpected statement " + name);
    });
    events.push("commit");
    return value;
  };
  const replies = [...(options.replies ?? [])];
  const requests = [];
  const fetch = async (url, init) => {
    events.push("fetch");
    const body = JSON.parse(init.body);
    requests.push({ url, body, token: new Headers(init.headers).get("x-shopify-access-token") });
    const next = replies.shift();
    if (next) return Response.json(next);
    return Response.json({
      data: {
        product: {
          id: body.variables?.id ?? "gid://shopify/Product/1",
          title: "Linen shirt",
          descriptionHtml: "<p>Soft.</p>",
          tags: ["linen"],
          seo: { title: null, description: null },
        },
        collections: {
          nodes: [{ id: "gid://shopify/Collection/5", title: "Summer" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      extensions: {
        cost: {
          requestedQueryCost: 27,
          actualQueryCost: 20,
          throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 960, restoreRate: 50 },
        },
      },
    });
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
  const environment = env("switch" in options ? options.switch : "on");
  const readAs = (caller, query, variables, budget = 10000) =>
    reader.read(environment, caller, lease, 1, "subject_1", query, JSON.stringify(variables), budget);
  return { readAs, events, requests };
}

test("switch on: a person read takes its known cost in the resolution's transaction, then settles", async () => {
  const h = await readerHarness();
  const result = JSON.parse(await h.readAs("api", "collectionsPage", { after: null }));
  assert.deepEqual(result.collections, [{ id: "collection:5", title: "Summer" }]);
  assert.deepEqual(h.events, [
    "begin",
    "shopifyReadResolve",
    "shopifyQueryCostTake",
    "take:person_read:" + shopifyReadCosts.collectionsPage,
    "commit",
    "fetch",
    "begin",
    "shopifyQueryCostSettle",
    "settle:27,20,960.000,1000.000,50.000,false",
    "commit",
  ]);
  assert.equal(h.requests[0].token, token);
  // An agent read (RuntimeBroker) is the agent_read class at the product document's cost.
  const agent = await readerHarness();
  await agent.readAs("runtime", "productContent", { productId: "product:1" });
  assert.ok(agent.events.includes("take:agent_read:" + shopifyReadCosts.productContent));
});

test("switch on: a read the bucket cannot yet cover parks unsent; an agent parks where a person waits", async () => {
  const parked = await readerHarness({ takes: [wait(2500)] });
  const text = await parked.readAs("runtime", "productContent", { productId: "product:1" });
  assert.deepEqual(JSON.parse(text), { schemaVersion: 1, outcome: "parked", retryAfterMs: 2500 });
  assert.deepEqual(decodeShopifyReadResult("productContent", text), JSON.parse(text));
  // Nothing was sent and the token was never needed.
  assert.equal(parked.requests.length, 0);
  assert.ok(!parked.events.includes("fetch"));
  assert.deepEqual(productReadOf(text), { outcome: "unavailable" });
  // The same wait for a person read is spent in the broker, then the read is sent.
  const person = await readerHarness({ takes: [wait(2500), admitted] });
  const page = JSON.parse(await person.readAs("api", "collectionsPage", { after: null }));
  assert.equal(page.outcome, "read");
  assert.ok(person.events.includes("sleep:2500"));
  assert.equal(person.requests.length, 1);
  // Past the person read's budget it parks too, as the catalogue routes' 429.
  const late = await readerHarness({ takes: [wait(9000)] });
  assert.deepEqual(JSON.parse(await late.readAs("api", "collectionsPage", { after: null }, 10000)), {
    schemaVersion: 1,
    outcome: "parked",
    retryAfterMs: 9000,
  });
  assert.equal(late.requests.length, 0);
});

test("switch on: THROTTLED settles the refund and Shopify's report, then the corrected bucket decides", async () => {
  const h = await readerHarness({
    takes: [admitted, wait(600), admitted],
    replies: [
      {
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: {
          cost: {
            requestedQueryCost: 27,
            throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 4, restoreRate: 50 },
          },
        },
      },
    ],
  });
  const result = JSON.parse(await h.readAs("api", "collectionsPage", { after: null }));
  assert.equal(result.outcome, "read");
  assert.deepEqual(
    h.events.filter((e) => /^(take|settle|fetch|sleep)/.test(e)),
    [
      "take:person_read:27",
      "fetch",
      "settle:27,,4.000,1000.000,50.000,true",
      "take:person_read:27",
      "sleep:600",
      "take:person_read:27",
      "fetch",
      "settle:27,20,960.000,1000.000,50.000,false",
    ],
  );
});

test("switch on: a refused resolution takes nothing; a refused take sends nothing", async () => {
  const unresolved = await readerHarness({ outcome: "refused" });
  await assert.rejects(
    unresolved.readAs("api", "collectionsPage", { after: null }),
    (e) => e.code === "READ_REFUSED",
  );
  assert.ok(!unresolved.events.includes("shopifyQueryCostTake"));
  for (const outcome of ["too_costly", "not_found", "invalid", "denied"]) {
    const h = await readerHarness({ takes: [{ outcome, wait_ms: null }] });
    await assert.rejects(
      h.readAs("api", "collectionsPage", { after: null }),
      (e) => e.code === "READ_REFUSED",
      outcome,
    );
    assert.equal(h.requests.length, 0, outcome);
  }
});

test("switch off (the committed state) or any other value: M2 PR-3's read, no bucket statement", async () => {
  for (const value of [undefined, "off", "ON", "on "]) {
    const h = await readerHarness({ switch: value });
    await h.readAs("api", "collectionsPage", { after: null });
    assert.deepEqual(h.events, ["begin", "shopifyReadResolve", "commit", "fetch"], String(value));
  }
  assert.equal(shopifyQueryCostVar, "MORROW_SHOPIFY_QUERY_COST");
  assert.equal(shopifyQueryCostOn, "on");
});

// ---------------------------------------------------------------------------
// The protocol's parked result.
test("the protocol: a parked read is closed (1 ms to an hour, whole ms, no other key)", () => {
  for (const query of ["shopIdentity", "collectionsPage", "productsPage", "productContent"])
    assert.deepEqual(
      decodeShopifyReadResult(
        query,
        JSON.stringify({ schemaVersion: 1, outcome: "parked", retryAfterMs: 1 }),
      ),
      { schemaVersion: 1, outcome: "parked", retryAfterMs: 1 },
    );
  assert.equal(shopifyReadLimits.parkedMaxMs, shopifyQueryCostPolicy.maxWaitMs);
  for (const bad of [
    { schemaVersion: 1, outcome: "parked", retryAfterMs: 0 },
    { schemaVersion: 1, outcome: "parked", retryAfterMs: 3_600_001 },
    { schemaVersion: 1, outcome: "parked", retryAfterMs: 2.5 },
    { schemaVersion: 1, outcome: "parked", retryAfterMs: "10" },
    { schemaVersion: 1, outcome: "parked" },
    { schemaVersion: 2, outcome: "parked", retryAfterMs: 10 },
    { schemaVersion: 1, outcome: "parked", retryAfterMs: 10, reason: "throttled" },
  ])
    assert.throws(() => decodeShopifyReadResult("productContent", JSON.stringify(bad)), JSON.stringify(bad));
});

// ---------------------------------------------------------------------------
// The switch.
test("the query-cost switch: committed off, the staging broker's var only", () => {
  const record = JSON.parse(read("docs/decisions/shopify-query-cost-staging.json"));
  assert.deepEqual(reviewedQueryCostRecord(record), { switch: "off" });
  for (const bad of [
    { ...record, switch: "maybe" },
    { ...record, environment_kind: "production" },
    { ...record, extra: true },
    { ...record, schema_version: 2 },
    null,
    [],
  ])
    assert.throws(() => reviewedQueryCostRecord(bad), /EDGE_STAGING_QUERY_COST_RECORD/);
  assert.equal(edgeQueryCostVar, shopifyQueryCostVar);
  assert.deepEqual(edgeQueryCostVarNames("broker", "staging"), ["MORROW_SHOPIFY_QUERY_COST"]);
  for (const [worker, environment] of [
    ["broker", "development"],
    ["broker", "production"],
    ["api", "staging"],
    ["connector", "staging"],
    ["orchestrator", "staging"],
  ])
    assert.deepEqual(edgeQueryCostVarNames(worker, environment), [], worker + " " + environment);
  // The switch is edgeVarNames' eighth argument (after v1 PR 5's clean-up switch).
  assert.ok(
    edgeVarNames("broker", "staging", "off", "off", "off", "off", "off", "on").includes(
      "MORROW_SHOPIFY_QUERY_COST",
    ),
  );
  assert.ok(
    !edgeVarNames("broker", "staging", "off", "off", "off", "off", "off", "off").includes(
      "MORROW_SHOPIFY_QUERY_COST",
    ),
  );
  for (const worker of ["api", "connector", "orchestrator"])
    assert.ok(
      !edgeVarNames(worker, "staging", "off", "off", "off", "off", "off", "on").includes(
        "MORROW_SHOPIFY_QUERY_COST",
      ),
      worker,
    );
  for (const worker of ["api", "broker", "workers", "shopify-connector"])
    assert.ok(!read(`apps/${worker}/wrangler.jsonc`).includes("MORROW_SHOPIFY_QUERY_COST"), worker);
});

test("edge:check: the query-cost record and the staging broker's var agree, or it is a mixed state", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "morrow-query-cost-switch-")));
  try {
    const committed = JSON.parse(read("docs/decisions/shopify-query-cost-staging.json"));
    const parseConfig = (text) =>
      JSON.parse(
        text
          .split("\n")
          .filter((line) => !line.trim().startsWith("//"))
          .join("\n")
          .replace(/,(\s*[}\]])/g, "$1"),
      );
    let copies = 0;
    const check = async (mutate, value) => {
      const root = join(scratch, "tree-" + ++copies);
      for (const worker of edgeWorkers) {
        mkdirSync(join(root, worker.dir), { recursive: true });
        const config = parseConfig(read(join(worker.dir, "wrangler.jsonc")));
        mutate[worker.key]?.(config);
        writeFileSync(join(root, worker.dir, "wrangler.jsonc"), JSON.stringify(config, null, 2));
      }
      const queryCostPath = join(scratch, "query-cost-" + copies + ".json");
      writeFileSync(queryCostPath, JSON.stringify({ ...committed, switch: value }));
      const verdict = await verifyEdgeConfig({ root, queryCostPath });
      return {
        codes: [...new Set(verdict.problems.map((problem) => problem.split(":")[0]))].sort(),
        queryCostSwitch: verdict.queryCostSwitch,
      };
    };
    const set =
      (value, where = (c) => c.env.staging.vars) =>
      (c) =>
        (where(c).MORROW_SHOPIFY_QUERY_COST = value);
    assert.deepEqual(await check({}, "off"), { codes: [], queryCostSwitch: "off" });
    assert.deepEqual((await check({ broker: set("on") }, "off")).codes, [
      "EDGE_QUERY_COST_SWITCH_MIXED",
      "EDGE_VARS",
    ]);
    assert.deepEqual(await check({ broker: set("on") }, "on"), {
      codes: [],
      queryCostSwitch: "on",
    });
    assert.deepEqual((await check({}, "on")).codes, ["EDGE_QUERY_COST_SWITCH_MIXED", "EDGE_VARS"]);
    assert.deepEqual((await check({ broker: set("yes") }, "on")).codes, ["EDGE_VARS"]);
    for (const [index, mutate] of [
      { broker: set("on"), api: set("on") },
      { broker: set("on"), connector: set("on") },
      { broker: set("on"), orchestrator: set("on") },
    ].entries()) {
      const { codes } = await check(mutate, "on");
      assert.ok(codes.includes("EDGE_VARS"), index + ": " + codes.join(","));
      assert.ok(
        codes.every((code) =>
          ["EDGE_VARS", "EDGE_QUERY_COST_SWITCH_MIXED", "EDGE_CONFIG_DIAGNOSTIC"].includes(code),
        ),
        index + ": " + codes.join(","),
      );
    }
    assert.deepEqual(await check({}, "maybe"), {
      codes: ["EDGE_STAGING_QUERY_COST_RECORD"],
      queryCostSwitch: "off",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The migration against the broker's constants.
test("migration shopify-query-cost: a forward work-owner migration after 0056, with its brief", () => {
  // Written as the next free number on main (0057; pull request 92 also holds 0057, so the
  // lead renumbers whichever merges second); found by slug.
  assert.equal(row.file, String(row.sequence).padStart(4, "0") + "." + slug + ".sql");
  const previous = manifest.migrations.find((m) => m.sequence === row.sequence - 1);
  assert.ok(previous, "the row before it");
  assert.match(sql, /^-- Executes AS morrow_work_owner, after 0056 \(credits-only-catalogue\)\./m);
  assert.equal(row.executeAs, "morrow_work_owner");
  assert.equal(row.sha256, createHash("sha256").update(sql).digest("hex"));
  assert.equal(row.reviewRef, "docs/briefs/sd5-shopify-query-cost.md");
  assert.ok(read(row.reviewRef).includes("## Test checklist"));
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
});

test("drift: the SQL policy equals the broker's, and the oracle prices the read documents as the broker does", () => {
  const f = flat(sql);
  const p = shopifyQueryCostPolicy;
  const classes = queryCostClasses
    .map((cls, i) => `('${cls}',${i + 1},${p.floorShare[cls].toFixed(2)}::numeric)`)
    .join(",");
  assert.ok(
    f.replaceAll(", (", ",(").includes(`FROM (VALUES ${classes}) c(class,priority,floor_share)`),
    "classes and shares",
  );
  assert.ok(
    f.includes(
      `SELECT 'shopify'::text,'query_cost_points'::text,c.class,c.priority,c.floor_share,${p.defaultCapacity}::numeric,${p.defaultRestoreRate}::numeric,${p.maxCost}`,
    ),
    "defaults and the dearest document",
  );
  assert.ok(
    f.includes(
      `p_class NOT IN (${queryCostClasses.map((c) => `'${c}'`).join(",")})`,
    ),
    "the definer's closed class list",
  );
  assert.ok(f.includes(`least(${p.maxWaitMs},greatest(1,v_wait))`), "the longest wait");
  assert.ok(
    f.includes(`capacity numeric(12,3) NOT NULL CHECK (capacity BETWEEN ${p.capacityRange[0]} AND ${p.capacityRange[1]})`),
  );
  assert.ok(
    f.includes(
      `restore_rate numeric(12,3) NOT NULL CHECK (restore_rate BETWEEN ${p.restoreRateRange[0]} AND ${p.restoreRateRange[1]})`,
    ),
  );
  assert.ok(f.includes(`(p_available IS NOT NULL AND (p_available<0 OR p_available>${p.availableMax}))`));
  // Shares grow down the priority order: each class leaves more for those above it.
  const shares = queryCostClasses.map((c) => p.floorShare[c]);
  assert.deepEqual([...shares].sort((a, b) => a - b), shares);
  assert.equal(p.floorShare.write, 0);
  // Every read document's known cost fits the default bucket in every class (never
  // too_costly before Shopify's first report).
  for (const [name, cost] of Object.entries(shopifyReadCosts)) {
    assert.ok(Number.isSafeInteger(cost) && cost >= 1 && cost <= p.maxCost, name);
    for (const cls of queryCostClasses)
      assert.ok(p.defaultCapacity * p.floorShare[cls] + cost <= p.defaultCapacity, name + " " + cls);
  }
  // The lab's synthetic Shopify charges each read document what the broker takes.
  const operations = {
    shopIdentity: "ShopIdentity",
    collectionsPage: "CollectionsPage",
    productsPage: "ProductsPage",
    collectionProductsPage: "CollectionProductsPage",
    productContent: "ProductContent",
  };
  for (const [name, operation] of Object.entries(operations)) {
    assert.ok(shopifyReadDocuments[name].includes(" " + operation), name);
    assert.equal(shopifyOracleCosts[operation], shopifyReadCosts[name], name);
  }
  assert.ok(shopifyWriteDocuments.productUpdate.startsWith("mutation ProductUpdate("));
  assert.equal(shopifyOracleCosts.ProductUpdate, 10);
});

test("migration shopify-query-cost: the broker's definers alone, tenant from the installation, ids in", () => {
  const f = flat(sql);
  // EXECUTE: the two definers for the broker's own login only, the helpers for the command
  // role only; nothing for PUBLIC.
  assert.ok(
    f.includes(
      "GRANT EXECUTE ON FUNCTION morrow_vault.shopify_query_cost_take(text,text,text), morrow_vault.shopify_query_cost_settle(text,text,text,text,text,text,text) TO morrow_vault_broker;",
    ),
  );
  assert.ok(
    f.includes(
      "GRANT EXECUTE ON FUNCTION morrow_work.rate_bucket_policy(), morrow_work.rate_bucket_take(text,text,text,text,text,integer), morrow_work.rate_bucket_settle(text,text,text,text,integer,integer,numeric,numeric,numeric,boolean) TO morrow_work_command;",
    ),
  );
  assert.equal((f.match(/GRANT EXECUTE/g) ?? []).length, 2);
  assert.ok(f.includes("FROM PUBLIC;"));
  for (const definer of ["shopify_query_cost_take", "shopify_query_cost_settle"]) {
    const body = f.slice(f.indexOf("CREATE FUNCTION morrow_vault." + definer));
    const end = body.indexOf("END $$;");
    const text = body.slice(0, end);
    assert.ok(text.includes("SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp"), definer);
    // The executor guard runs first; the tenant comes only from the installation row.
    assert.ok(
      text.indexOf("work_executor_safe('morrow_vault_broker')") < text.indexOf("work_shopify_check_target"),
      definer,
    );
    assert.ok(text.includes("t.organization_id||'|'||t.workspace_id||'|shopify|'||p_installation_id"), definer);
    // The setting is cleared before the definer returns.
    assert.ok(text.includes("set_config('morrow.vault_rate_bucket','',true)"), definer);
    assert.ok(!/p_(org|ws|organization|workspace)/.test(text.slice(0, text.indexOf("RETURNS"))), definer);
    assert.ok(f.includes(`ALTER FUNCTION morrow_vault.${definer}(`), definer);
  }
  // The broker's context: its own login and exactly the one subject the definer named.
  assert.ok(
    f.includes(
      "CREATE POLICY broker_rate_bucket ON morrow_work.rate_buckets TO morrow_work_command USING (session_user='morrow_vault_broker' AND organization_id::text||'|'||workspace_id::text||'|'||provider||'|'||subject_id::text=pg_catalog.current_setting('morrow.vault_rate_bucket',true))",
    ),
  );
  assert.ok(f.includes("ALTER TABLE morrow_work.rate_buckets FORCE ROW LEVEL SECURITY;"));
  assert.ok(
    f.includes(
      "CREATE POLICY tenant_command ON morrow_work.rate_buckets FOR SELECT TO morrow_work_command",
    ),
  );
  // No runtime DELETE or TRUNCATE; UPDATE column by column; a guard on every row.
  assert.ok(f.includes("GRANT SELECT,INSERT ON morrow_work.rate_buckets TO morrow_work_command;"));
  assert.ok(!/GRANT[^;]*DELETE[^;]*rate_buckets/.test(f));
  assert.ok(f.includes("BEFORE INSERT OR UPDATE OR DELETE ON morrow_work.rate_buckets"));
  // No money: the record names no credit, wallet or US$ column.
  assert.ok(!/credit|wallet|usd|cost_usd/i.test(f.slice(f.indexOf("CREATE TABLE morrow_work.rate_buckets"), f.indexOf("CREATE UNIQUE INDEX rate_buckets_subject"))));
  // A write never waits on the bucket; every other class waits below its share.
  assert.ok(f.includes("IF p_class='write' OR v_avail-p_cost>=v_floor THEN"));
});
