// v1 PR 4: Undo, the history's undo state and "Approve several at once", in Node with fakes
// (no database, no Shopify). The undo's item (each field back to the value read before the
// apply) and the bounds Morrow can write; the undo check's comparison with what the apply
// left (fail-safe: anything it cannot prove unchanged is changed); the broker's undo check
// over a scripted vault and Shopify (one read, never a write, codes only across the
// binding); the closed undo-check result; Undo's "what changed" message; the batch's one
// phrase, its availability and its closed decision body; and the routes (paths, closed
// bodies, a port without the undo check answering 503). lab:catalog-undo drives the same
// code against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { apiDispatch } from "../apps/api/src/worker.ts";
import {
  brokerNeonRoleNames,
  brokerPasswordSecret,
  decodeShopifyUndoCheckResult,
  encodeShopifyUndoCheckResult,
} from "../packages/identity/src/broker-protocol.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { createShopifyWriter } from "../apps/broker/src/shopify-write.ts";
import { sealVaultRecord, vaultBytesHex, vaultStatements } from "../apps/broker/src/vault.ts";
import { listingSnapshotText } from "../packages/work/src/runs/listing-canonical.ts";
import { appliedStateVerdicts } from "../packages/work/src/runs/listing-compare.ts";
import { undoRequestDigest, undoSet, undoSetWritable } from "../packages/work/src/review/undo.ts";
import {
  batchConfirmation,
  batchDigest,
  batchLimits,
  batchPhrase,
  parseBatchDecision,
} from "../packages/work/src/review/batch.ts";
import {
  changedMessage,
  createReviewApiHandler,
  reviewPathPattern,
} from "../packages/work/src/review/http.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const originalLog = console.log;
console.log = () => {};
test.after(() => (console.log = originalLog));

const before = () => ({
  productId: "product:7",
  title: "Linen shirt",
  descriptionHtml: "<p>Original</p>",
  seo: { title: null, description: "Old SEO" },
  tags: ["summer", "linen"],
});
const approved = { title: "Linen shirt - improved", tags: ["summer", "linen", "improved"] };

// ---------------------------------------------------------------------------
// The undo's item and the comparison with what the apply left.
test("the undo sets exactly the change's fields back to the values read before the apply", () => {
  assert.deepEqual(undoSet(before(), ["tags", "title"]), {
    title: "Linen shirt",
    tags: ["summer", "linen"],
  });
  // The SEO pair travels as one object; a missing SEO value is "" (as the read-back compares).
  assert.deepEqual(undoSet(before(), ["seo.title"]), {
    seo: { title: "", description: "Old SEO" },
  });
  assert.deepEqual(Object.keys(undoSet(before(), ["descriptionHtml"])), ["descriptionHtml"]);
  assert.ok(undoSetWritable(undoSet(before(), ["descriptionHtml", "seo.title", "tags", "title"])));
  // A value Morrow cannot write is not undone automatically.
  for (const set of [
    { title: "" },
    { title: "x".repeat(256) },
    { descriptionHtml: "x".repeat(10001) },
    { seo: { title: "x".repeat(71), description: "" } },
    { seo: { title: "", description: "x".repeat(321) } },
    { tags: Array.from({ length: 51 }, (_, i) => "t" + i) },
    { tags: ["a", "a"] },
    { tags: [""] },
    { tags: ["x".repeat(65)] },
  ])
    assert.equal(undoSetWritable(set), false, JSON.stringify(set).slice(0, 60));
});

test("the undo check: unchanged only when every field still holds what the apply left", () => {
  const left = { ...before(), title: approved.title, tags: [...approved.tags] };
  const same = appliedStateVerdicts(left, before(), approved);
  assert.equal(same.verdict, "unchanged");
  assert.deepEqual(Object.keys(same.fields).sort(), [
    "descriptionHtml",
    "seo.description",
    "seo.title",
    "tags",
    "title",
  ]);
  // Shopify's own tag reformatting is still what the apply left.
  assert.equal(
    appliedStateVerdicts({ ...left, tags: ["Improved", "LINEN", "summer"] }, before(), approved)
      .verdict,
    "unchanged",
  );
  // Someone edited a field the change wrote, or one it did not: Undo stops.
  const edited = appliedStateVerdicts({ ...left, title: "Edited in Shopify" }, before(), approved);
  assert.equal(edited.verdict, "changed");
  assert.equal(edited.fields.title, "changed");
  assert.equal(edited.fields.tags, "unchanged");
  const other = appliedStateVerdicts(
    { ...left, descriptionHtml: "<p>Edited</p>" },
    before(),
    approved,
  );
  assert.equal(other.verdict, "changed");
  assert.equal(other.fields.descriptionHtml, "changed");
  // The values from before the apply are not what it left: changed.
  assert.equal(appliedStateVerdicts(before(), before(), approved).verdict, "changed");
});

test("Undo's message names the fields that changed, in plain words, and nothing else", () => {
  assert.equal(
    changedMessage(["title"]),
    "The title changed in Shopify after Morrow applied this change, so Undo stopped. Nothing was written.",
  );
  assert.equal(
    changedMessage(["title", "tags", "seo.description"]),
    "The title, the tags and the SEO description changed in Shopify after Morrow applied this change, so Undo stopped. Nothing was written.",
  );
  assert.equal(
    changedMessage(["<script>"]),
    "This product changed after Morrow applied the change, so Undo stopped. Nothing was written.",
  );
});

test("the undo check's result is closed: codes only, and the verdict follows the codes", () => {
  const fields = {
    descriptionHtml: "unchanged",
    "seo.description": "unchanged",
    "seo.title": "unchanged",
    tags: "unchanged",
    title: "unchanged",
  };
  const ok = { outcome: "recorded", sequence: 3, verdict: "unchanged", fields };
  assert.deepEqual(decodeShopifyUndoCheckResult(encodeShopifyUndoCheckResult(ok)), ok);
  const missing = { outcome: "recorded", sequence: 1, verdict: "missing", fields: null };
  assert.deepEqual(decodeShopifyUndoCheckResult(encodeShopifyUndoCheckResult(missing)), missing);
  for (const outcome of ["not_applied", "unavailable", "too_soon", "link_changed", "held"])
    assert.equal(
      decodeShopifyUndoCheckResult(
        encodeShopifyUndoCheckResult({ outcome, sequence: null, verdict: null, fields: null }),
      ).outcome,
      outcome,
    );
  for (const bad of [
    { ...ok, verdict: "changed" },
    { ...ok, fields: { ...fields, title: "changed" } },
    { ...ok, fields: { ...fields, title: "Linen shirt" } },
    { ...ok, sequence: 0 },
    { ...ok, outcome: "applied" },
    { outcome: "too_soon", sequence: 1, verdict: null, fields: null },
  ])
    assert.throws(() => encodeShopifyUndoCheckResult(bad));
  // The encoder writes only the five known fields; the decoder refuses any other key.
  assert.throws(() =>
    decodeShopifyUndoCheckResult(JSON.stringify({ schemaVersion: 1, ...ok, value: "x" })),
  );
  assert.throws(() =>
    decodeShopifyUndoCheckResult(
      JSON.stringify({ schemaVersion: 1, ...ok, fields: { ...fields, extra: "unchanged" } }),
    ),
  );
});

// ---------------------------------------------------------------------------
// The broker's undo check over a scripted vault and Shopify.
const shop = "unit-shop.myshopify.com";
const token = "shpat_" + "c".repeat(32);
const operationId = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b";
const gid = "gid://shopify/Product/7";
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
      projectId: "morrow-undo-unit",
      branchId: "br-undo-unit",
      hostname: "ep-undo-unit.c-14.us-east-1.aws.neon.tech",
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
async function resolvedRow(env, over = {}) {
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
    outcome: "resolved",
    organization_id: "org_o",
    workspace_id: "ws_w",
    shop_domain: shop,
    product_id: "product:7",
    fields: "tags,title",
    item: JSON.stringify({ targetIndex: 0, productId: "product:7", set: approved }),
    source: listingSnapshotText(before()),
    store_installation_id: "storeinst_unit",
    credential_id: "credential_unit",
    credential_version: "1",
    kek_version: "1",
    wrapped_key: vaultBytesHex(sealed.wrappedKey),
    sealed_value: vaultBytesHex(sealed.sealedValue),
    ...over,
  };
}
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function scriptedShopify(product) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      assert.equal(new URL(url).host, shop);
      assert.equal(new Headers(init.headers).get("x-shopify-access-token"), token);
      const operation = /^(?:query|mutation) ([A-Za-z]+)/.exec(JSON.parse(init.body).query)[1];
      calls.push(operation);
      if (operation !== "ProductWriteState") return json(500, {});
      return json(200, {
        data: {
          product:
            product === null
              ? null
              : {
                  id: gid,
                  title: product.title,
                  descriptionHtml: product.descriptionHtml,
                  tags: product.tags,
                  seo: product.seo,
                  updatedAt: "2026-10-24T10:00:00Z",
                },
        },
      });
    },
  };
}
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
        return typeof reply === "function" ? reply(values) : reply;
      }),
  };
}

test("broker: the undo check reads the product once, records codes and its read, never writes", async () => {
  const env = brokerEnv(); // the apply switch is off: the check only reads
  const left = { ...before(), title: approved.title, tags: [...approved.tags] };
  const shopify = scriptedShopify(left);
  const vault = scriptedVault({
    catalogUndoResolve: [await resolvedRow(env)],
    catalogUndoRecord: (values) => {
      assert.equal(values[0], operationId);
      assert.equal(values[1], "read");
      // The read is stored as the product's snapshot: the undo's "before".
      assert.equal(values[2], listingSnapshotText({ ...left, productId: "product:7" }));
      assert.deepEqual(JSON.parse(values[3]), {
        descriptionHtml: "unchanged",
        "seo.description": "unchanged",
        "seo.title": "unchanged",
        tags: "unchanged",
        title: "unchanged",
      });
      assert.equal(values[4], "unchanged");
      return [{ outcome: "recorded", sequence: "1", verdict: "unchanged" }];
    },
  });
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  const text = await writer.undoCheck(env, operationId, 10000);
  assert.deepEqual(decodeShopifyUndoCheckResult(text), {
    outcome: "recorded",
    sequence: 1,
    verdict: "unchanged",
    fields: {
      descriptionHtml: "unchanged",
      "seo.description": "unchanged",
      "seo.title": "unchanged",
      tags: "unchanged",
      title: "unchanged",
    },
  });
  assert.deepEqual(shopify.calls, ["ProductWriteState"]);
  assert.deepEqual(
    vault.log.map((l) => l.name),
    ["catalogUndoResolve", "catalogUndoRecord"],
  );
  // What crosses the binding is codes only.
  assert.ok(!text.includes("Linen") && !text.includes(token));
});

test("broker: an edited product is recorded changed; a deleted one missing; refusals read nothing", async () => {
  const env = brokerEnv();
  const edited = { ...before(), title: "Edited in Shopify", tags: [...approved.tags] };
  const vault = scriptedVault({
    catalogUndoResolve: [await resolvedRow(env)],
    catalogUndoRecord: (values) => {
      assert.equal(values[4], "changed");
      assert.equal(JSON.parse(values[3]).title, "changed");
      return [{ outcome: "recorded", sequence: "2", verdict: "changed" }];
    },
  });
  const shopify = scriptedShopify(edited);
  const writer = createShopifyWriter({
    transaction: vault.transaction,
    fetch: shopify.fetch,
    now: Date.now,
  });
  const changed = decodeShopifyUndoCheckResult(await writer.undoCheck(env, operationId, 10000));
  assert.equal(changed.verdict, "changed");
  assert.equal(changed.fields.title, "changed");
  assert.deepEqual(shopify.calls, ["ProductWriteState"]);

  const gone = scriptedVault({
    catalogUndoResolve: [await resolvedRow(env)],
    catalogUndoRecord: (values) => {
      assert.deepEqual(values, [operationId, "not_found", "", "", "missing"]);
      return [{ outcome: "recorded", sequence: "3", verdict: "missing" }];
    },
  });
  const missing = createShopifyWriter({
    transaction: gone.transaction,
    fetch: scriptedShopify(null).fetch,
    now: Date.now,
  });
  assert.deepEqual(decodeShopifyUndoCheckResult(await missing.undoCheck(env, operationId, 10000)), {
    outcome: "recorded",
    sequence: 3,
    verdict: "missing",
    fields: null,
  });

  for (const outcome of ["not_applied", "unavailable", "too_soon", "link_changed"]) {
    const shopify2 = scriptedShopify(edited);
    const refused = scriptedVault({
      catalogUndoResolve: [
        Object.fromEntries(
          Object.keys(await resolvedRow(env)).map((k) => [k, k === "outcome" ? outcome : null]),
        ),
      ],
    });
    const w = createShopifyWriter({
      transaction: refused.transaction,
      fetch: shopify2.fetch,
      now: Date.now,
    });
    assert.equal(
      decodeShopifyUndoCheckResult(await w.undoCheck(env, operationId, 10000)).outcome,
      outcome,
    );
    assert.deepEqual(shopify2.calls, []);
    assert.deepEqual(
      refused.log.map((l) => l.name),
      ["catalogUndoResolve"],
    );
  }
  // Closed inputs are refused before the vault.
  const none = scriptedVault({});
  const w = createShopifyWriter({ transaction: none.transaction, fetch: () => {}, now: Date.now });
  await assert.rejects(w.undoCheck(env, "x", 1000), (e) => e.code === "INPUT_INVALID");
  await assert.rejects(w.undoCheck(env, operationId, -1), (e) => e.code === "BUDGET_INVALID");
  assert.deepEqual(none.log, []);
});

// ---------------------------------------------------------------------------
// "Approve several at once".
test("the batch's one phrase sums the changes and credits of every member", () => {
  assert.equal(
    batchPhrase([
      { targetCount: 2, credits: 2n },
      { targetCount: 1, credits: 0n },
    ]),
    "approve 3 changes for 2 credits",
  );
  assert.equal(batchPhrase([{ targetCount: 1, credits: 1n }]), "approve 1 change for 1 credits");
  const m = (phrase, cost = false) => ({ targetCount: 1, credits: 1n, phrase, cost });
  assert.deepEqual(batchConfirmation([m(null)]), {
    unavailable: "too_few",
    confirmation: { required: false, phrase: null },
  });
  assert.deepEqual(batchConfirmation([m(null), m(null)]), {
    unavailable: null,
    confirmation: { required: false, phrase: null },
  });
  assert.deepEqual(batchConfirmation([m("p"), m("p")]), {
    unavailable: null,
    confirmation: { required: true, phrase: "approve 2 changes for 2 credits" },
  });
  // Only some members need the phrase, or one that does has a money cost: not offered.
  assert.equal(batchConfirmation([m("p"), m(null)]).unavailable, "mixed_confirmation");
  assert.equal(batchConfirmation([m("p"), m("p", true)]).unavailable, "cost_confirmation");
  assert.equal(batchConfirmation([m("p"), m("p", true)]).confirmation.phrase, null);
  // A team's member with a cost needs no phrase and batches.
  assert.equal(batchConfirmation([m(null, true), m(null)]).unavailable, null);
  assert.deepEqual(batchLimits, { min: 2, max: 10, lifetimeMs: 300_000 });
});

test("the batch decision body is closed: 2 to 10 distinct exact refs and a bounded phrase", () => {
  const item = (n) => ({
    proposalId: "proposal_" + n,
    digest: String(n).repeat(64).slice(0, 64),
    approvalId: "approval_" + n,
    revision: 1,
  });
  const body = {
    documentDigest: "a".repeat(64),
    issuedAt: "2026-10-24T10:00:00.000Z",
    soloOwnerConfirmation: null,
    items: [item(1), item(2)],
  };
  assert.deepEqual(parseBatchDecision(body), body);
  assert.deepEqual(
    parseBatchDecision({ ...body, soloOwnerConfirmation: "approve 2 changes for 2 credits" })
      ?.soloOwnerConfirmation,
    "approve 2 changes for 2 credits",
  );
  for (const bad of [
    { ...body, soloOwnerConfirmation: undefined },
    { ...body, soloOwnerConfirmation: "" },
    { ...body, soloOwnerConfirmation: "x".repeat(257) },
    { ...body, items: [item(1)] },
    { ...body, items: Array.from({ length: 11 }, (_, i) => item(i + 1)) },
    { ...body, items: [item(1), item(1)] },
    { ...body, items: [item(1), { ...item(2), revision: 0 }] },
    { ...body, items: [item(1), { ...item(2), extra: 1 }] },
    { ...body, documentDigest: "A".repeat(64) },
    { ...body, issuedAt: "2026-10-24" },
    { ...body, workspaceId: "ws_w" },
    [body],
    null,
  ])
    assert.equal(parseBatchDecision(bad), null, JSON.stringify(bad)?.slice(0, 80));
});

test("the batch document's digest binds the person, the session, its time and each exact ref", async () => {
  const a = { actor: { principalId: "principal_a", membershipId: "membership_a" } };
  const items = [
    { proposalId: "p1", digest: "1".repeat(64), approvalId: "a1", revision: 1 },
    { proposalId: "p2", digest: "2".repeat(64), approvalId: "a2", revision: 1 },
  ];
  const at = "2026-10-24T10:00:00.000Z";
  const base = await batchDigest("ws_w", a, "s".repeat(64), at, items);
  assert.match(base, /^[a-f0-9]{64}$/);
  const variants = [
    batchDigest("ws_x", a, "s".repeat(64), at, items),
    batchDigest("ws_w", { actor: { ...a.actor, principalId: "b" } }, "s".repeat(64), at, items),
    batchDigest("ws_w", a, "t".repeat(64), at, items),
    batchDigest("ws_w", a, "s".repeat(64), "2026-10-24T10:00:00.001Z", items),
    batchDigest("ws_w", a, "s".repeat(64), at, [items[1], items[0]]),
    batchDigest("ws_w", a, "s".repeat(64), at, [items[0], { ...items[1], revision: 2 }]),
    batchDigest("ws_w", a, "s".repeat(64), at, [items[0], { ...items[1], digest: "3".repeat(64) }]),
  ];
  for (const v of await Promise.all(variants)) assert.notEqual(v, base);
  // The members' display fields are not part of what is confirmed.
  assert.equal(
    await batchDigest(
      "ws_w",
      a,
      "s".repeat(64),
      at,
      items.map((i) => ({ ...i, targetCount: 9, expiresAt: "x" })),
    ),
    base,
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

test("the undo and batch routes go to the review handler; others do not", () => {
  for (const path of [
    "/workspace/ws_w/work/operations/" + operationId + "/undo",
    "/workspace/ws_w/work/proposals/p_1/batch",
    "/workspace/ws_w/work/proposals/p_1/batch-decision",
  ]) {
    assert.ok(reviewPathPattern.test(path), path);
    assert.equal(apiDispatch(path), "review", path);
  }
  for (const path of [
    "/workspace/ws_w/work/operations/" + operationId + "/undo/x",
    "/workspace/ws_w/work/proposals/p_1/batch/x",
  ])
    assert.equal(apiDispatch(path), "work", path);
});

test("undo and batch-decision take closed bodies, refused before any database access", async (t) => {
  t.mock.method(console, "log", () => {});
  let opens = 0;
  let checks = 0;
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
      apply: async () => "",
      reconcile: async () => "",
      undoCheck: async () => (checks++, ""),
    },
  });
  const undo = "/workspace/ws_w/work/operations/" + operationId + "/undo";
  for (const body of [{ operationId }, { set: { title: "x" } }, []]) {
    const r = await handler.fetch(request("POST", undo, body), {}, { waitUntil() {} });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const decision = "/workspace/ws_w/work/proposals/p_1/batch-decision";
  for (const body of [{}, { documentDigest: "a".repeat(64), issuedAt: "x", items: [] }]) {
    const r = await handler.fetch(request("POST", decision, body), {}, { waitUntil() {} });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(validateDefinition("core", "ErrorEnvelope", await r.json()));
  }
  assert.equal(opens, 0);
  assert.equal(checks, 0);
  // A well-formed undo reaches the database first (the person's checks), never the broker
  // before them; Undo is not behind the apply switch (its own apply is).
  const empty = await handler.fetch(request("POST", undo, {}), {}, { waitUntil() {} });
  assert.equal(empty.status, 503);
  assert.equal(opens, 1);
  assert.equal(checks, 0);
});

test("the undo command's request digest names the workspace and the operation only", async () => {
  const d = await undoRequestDigest("ws_w", operationId);
  assert.match(d, /^[a-f0-9]{64}$/);
  assert.notEqual(d, await undoRequestDigest("ws_x", operationId));
  assert.notEqual(d, await undoRequestDigest("ws_w", "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7c"));
  assert.equal(d, await undoRequestDigest("ws_w", operationId));
  assert.equal(sha("x").length, 64);
});
