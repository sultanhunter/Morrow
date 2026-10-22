// M5 PR-1: the broker's webhook verification (apps/broker/src/stripe.ts stripeWebhookVerify)
// and the Stripe capability (apps/broker/src/capabilities.ts). Events are signed by the fake
// Stripe origin; the object is read back from it with the broker's key; the receipt record
// is an in-memory stand-in for migration 0029's stripe_receipt_record (lab:billing runs the
// SQL). Covers: the HMAC over the raw bytes in constant time, the 300 s tolerance both
// ways, several v1 values, malformed headers and bodies, livemode, the readback proving the
// account (404 elsewhere), the closed normalised object and its digest, duplicates, and
// the fixed refusal reasons (never provider text).
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import {
  StripeHold,
  constantTimeEqual,
  parseStripeSignature,
  stripeWebhookVerify,
} from "../apps/broker/src/stripe.ts";
import { billingVaultStatements } from "../apps/broker/src/vault-statements-billing.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import {
  brokerStripeCustomerEnsure,
  brokerStripeWebhookVerify,
} from "../apps/broker/src/stripe-broker.ts";
import {
  brokerNeonRoleNames,
  brokerPasswordSecret,
  decodeStripeCheckoutResult,
  decodeStripePortalResult,
  decodeStripeWebhookResult,
  encodeStripeWebhookResult,
  parseStripeConfiguration,
} from "../packages/identity/src/broker-protocol.ts";
import { stripeObjectDigest } from "../packages/work/src/billing/stripe-objects.ts";
import {
  createStripeFake,
  fakeStripeKey,
  fakeStripePrice,
  fakeStripeVersion,
  fakeStripeWebhookSecret,
} from "../scripts/fixtures/stripe-fake.mjs";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";

const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));

const operationId = "00000000-0000-4000-8000-0000000000aa";
const ids = {
  morrow_operation_id: operationId,
  morrow_workspace_id: "ws_w",
  morrow_organization_id: "org_o",
};
async function call(fake, method, path, form = null) {
  const response = await fake.fetch(
    new Request("https://api.stripe.com" + path, {
      method,
      headers: {
        authorization: "Bearer " + fakeStripeKey,
        "stripe-version": fakeStripeVersion,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    }),
  );
  return response.json();
}
// A completed Checkout in the fake: the customer, the session, the subscription and its
// first paid invoice.
async function completed(fake) {
  const customer = await call(fake, "POST", "/v1/customers", {
    ...Object.fromEntries(Object.entries(ids).map(([k, v]) => [`metadata[${k}]`, v])),
  });
  const session = await call(fake, "POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer: customer.id,
    "line_items[0][price]": fakeStripePrice,
    "line_items[0][quantity]": "1",
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    ...Object.fromEntries(Object.entries(ids).map(([k, v]) => [`metadata[${k}]`, v])),
    ...Object.fromEntries(
      Object.entries(ids).map(([k, v]) => [`subscription_data[metadata][${k}]`, v]),
    ),
  });
  fake.requests.length = 0;
  return { customer, ...fake.complete(session.id) };
}
function recorder({ outcome = "recorded", attributed = "true" } = {}) {
  const calls = [];
  const seen = new Map();
  const transaction = async (budgetMs, body) =>
    body(async (text, values) => {
      assert.equal(text, billingVaultStatements.stripeReceiptRecord);
      assert.ok(values.every((v) => typeof v === "string"));
      calls.push(values);
      const [eventId, , , , , , , digest] = values;
      if (seen.has(eventId))
        return [
          {
            outcome: "duplicate",
            receipt_id: seen.get(eventId),
            attributed,
            object_digest: digest,
          },
        ];
      const id = "00000000-0000-4000-8000-" + randomBytes(6).toString("hex");
      seen.set(eventId, id);
      return [{ outcome, receipt_id: id, attributed, object_digest: digest }];
    });
  return { calls, transaction };
}
const deps = (fake, r, now = () => Date.now()) => ({
  stripe: {
    environment: "development",
    restrictedKey: fakeStripeKey,
    webhookSecret: fakeStripeWebhookSecret,
    configuration: {
      portalConfigurationId: "bpc_" + "A".repeat(24),
      automaticTax: false,
      billingAddressCollection: "auto",
    },
    returnOrigin: "https://workspace.example.test",
  },
  fetch: fake.fetch,
  transaction: r.transaction,
  now,
});
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
async function verify(fake, r, delivery, options = {}) {
  const reasons = [];
  const result = await stripeWebhookVerify(
    deps(fake, r, options.now),
    options.raw ?? b64(delivery.body),
    options.signature ?? delivery.signature,
    5000,
    (reason) => reasons.push(reason),
  );
  return { result, reasons };
}

test("invoice.paid: verified over the raw bytes, read back with the broker key, recorded as the closed object", async () => {
  const fake = createStripeFake();
  const { invoice, subscription } = await completed(fake);
  const r = recorder();
  const delivery = fake.signedEvent("invoice.paid", invoice);
  const { result, reasons } = await verify(fake, r, delivery);
  assert.equal(result.verdict, "recorded");
  assert.equal(result.attributed, true);
  assert.deepEqual(reasons, []);
  // The readback: the invoice and its subscription, with the broker's key.
  assert.deepEqual(
    fake.requests.map((x) => [x.method, x.path, x.authorised]),
    [
      ["GET", "/v1/invoices/" + invoice.id, true],
      ["GET", "/v1/subscriptions/" + subscription.id, true],
    ],
  );
  const [values] = r.calls;
  assert.equal(values[0], delivery.id);
  assert.deepEqual(values.slice(1, 6), [
    "invoice.paid",
    "false",
    "invoice",
    invoice.id,
    invoice.customer,
  ]);
  const object = JSON.parse(values[6]);
  // The operation comes from parent.subscription_details.metadata on the pinned version.
  assert.deepEqual(object.metadata, {
    operationId,
    organizationId: "org_o",
    workspaceId: "ws_w",
  });
  assert.equal(object.billingReason, "subscription_create");
  assert.equal(object.amountPaid, "4900");
  assert.equal(object.price, fakeStripePrice);
  assert.equal(values[7], await stripeObjectDigest(object));
  assert.equal(result.objectDigest, values[7]);
  // Ids, amounts, statuses and times only: no URL, email, address or card data.
  assert.doesNotMatch(values[6], /https?:|@|address|card|email/i);
  // The same event again is the same receipt.
  const again = await verify(fake, r, delivery);
  assert.equal(again.result.verdict, "duplicate");
  assert.equal(again.result.receiptId, result.receiptId);
});

test("signature: wrong secret, tampered body, stale or future timestamps, malformed headers are rejected", async () => {
  const fake = createStripeFake();
  const { invoice } = await completed(fake);
  const r = recorder();
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    [
      fake.signedEvent("invoice.paid", invoice, { secret: "whsec_" + "B".repeat(32) }),
      {},
      "signature_invalid",
    ],
    [
      fake.signedEvent("invoice.paid", invoice, { timestamp: now - 301 }),
      {},
      "timestamp_outside_tolerance",
    ],
    [
      fake.signedEvent("invoice.paid", invoice, { timestamp: now + 301 }),
      {},
      "timestamp_outside_tolerance",
    ],
  ];
  const good = fake.signedEvent("invoice.paid", invoice);
  cases.push([good, { raw: b64(good.body + " ") }, "signature_invalid"]);
  cases.push([good, { raw: b64(good.body.replace("4900", "4901")) }, "signature_invalid"]);
  for (const header of [
    "v1=" + "a".repeat(64),
    "t=abc,v1=" + "a".repeat(64),
    `t=${now},t=${now},v1=${"a".repeat(64)}`,
    `t=${now},v1=${"A".repeat(64)}`,
    `t=${now},v0=${"a".repeat(64)}`,
    `t=${now}`,
    "garbage",
  ])
    cases.push([good, { signature: header }, "signature_invalid"]);
  for (const [delivery, options, reason] of cases) {
    fake.requests.length = 0;
    const { result, reasons } = await verify(fake, r, delivery, options);
    assert.deepEqual(
      result,
      { verdict: "rejected", receiptId: null, objectDigest: null, attributed: null },
      reason,
    );
    assert.deepEqual(reasons, [reason]);
    assert.equal(fake.requests.length, 0, "nothing is read back before the signature holds");
  }
  assert.equal(r.calls.length, 0);
  // Several v1 values: one valid among others is accepted; each is compared.
  const v1 = good.signature.split("v1=")[1];
  const several = `t=${good.signature.split(",")[0].slice(2)},v1=${"0".repeat(64)},v1=${v1}`;
  assert.equal((await verify(fake, r, good, { signature: several })).result.verdict, "recorded");
  assert.equal(parseStripeSignature(several).signatures.length, 2);
  assert.equal(constantTimeEqual("ab", "ab"), true);
  assert.equal(constantTimeEqual("ab", "ac"), false);
  assert.equal(constantTimeEqual("ab", "abc"), false);
});

test("mode, account and shape: live events, another account's object and unknown types", async () => {
  const fake = createStripeFake();
  const { invoice, subscription, session } = await completed(fake);
  const r = recorder();
  // livemode true in development or staging.
  const live = fake.signedEvent("invoice.paid", invoice, { livemode: true });
  assert.deepEqual((await verify(fake, r, live)).reasons, ["mode_mismatch"]);
  // An object the broker's key cannot read (another account's): 404 on readback.
  const foreign = fake.signedEvent("invoice.paid", { ...invoice, id: "in_" + "F".repeat(16) });
  assert.deepEqual((await verify(fake, r, foreign)).reasons, ["object_not_found"]);
  // An event type outside the six is ignored without a readback or a record.
  fake.requests.length = 0;
  const other = fake.signedEvent("customer.created", { id: invoice.customer, object: "customer" });
  assert.equal((await verify(fake, r, other)).result.verdict, "ignored");
  assert.equal(fake.requests.length, 0);
  // Correctly signed bytes that are not JSON, not an event, or carry no object.
  const signed = (body) => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", fakeStripeWebhookSecret).update(`${t}.${body}`).digest("hex");
    return { body, signature: `t=${t},v1=${v1}` };
  };
  const event = JSON.parse(fake.signedEvent("invoice.paid", invoice).body);
  for (const body of [
    "not json",
    "[]",
    JSON.stringify({ ...event, object: "evento" }),
    JSON.stringify({ ...event, id: "evt bad" }),
    JSON.stringify({ ...event, data: { object: null } }),
    JSON.stringify({ ...event, data: { object: { ...invoice, id: "sub_" + "X".repeat(16) } } }),
  ])
    assert.deepEqual((await verify(fake, r, signed(body))).reasons, ["event_invalid"], body);
  // The other two object kinds read back their own object.
  for (const [type, object, path] of [
    ["customer.subscription.updated", subscription, "/v1/subscriptions/" + subscription.id],
    ["checkout.session.completed", session, "/v1/checkout/sessions/" + session.id],
  ]) {
    fake.requests.length = 0;
    const { result } = await verify(fake, r, fake.signedEvent(type, object));
    assert.equal(result.verdict, "recorded", type);
    assert.deepEqual(
      fake.requests.map((x) => x.path),
      [path],
    );
  }
  // A failing readback is held (the api answers 503 and Stripe retries).
  fake.faults.push({ method: "GET", path: "/v1/invoices/" + invoice.id, kind: "500_before" });
  await assert.rejects(verify(fake, r, fake.signedEvent("invoice.paid", invoice)), (error) => {
    assert.ok(error instanceof StripeHold);
    assert.equal(error.code, "PROVIDER_HELD");
    return true;
  });
  // A subscribed event whose read-back object is outside the closed shape is never
  // acknowledged and dropped: it is held (the api answers 503, Stripe keeps retrying and
  // its dashboard shows the failures) with its own fixed reason and the event type, and
  // nothing is recorded.
  const recorded = r.calls.length;
  const stored = fake.state.invoices.get(invoice.id);
  const amountPaid = stored.amount_paid;
  stored.amount_paid = String(amountPaid);
  const logged = [];
  const outOfShape = fake.signedEvent("invoice.paid", invoice);
  await assert.rejects(
    stripeWebhookVerify(
      deps(fake, r),
      b64(outOfShape.body),
      outOfShape.signature,
      5000,
      (reason, eventType) => logged.push([reason, eventType]),
    ),
    (error) => error instanceof StripeHold && error.code === "PROVIDER_HELD",
  );
  assert.deepEqual(logged, [["object_invalid", "invoice.paid"]]);
  assert.equal(r.calls.length, recorded);
  stored.amount_paid = amountPaid;
  // A body over 256 KiB or not base64 is refused before any check.
  const big = fake.signedEvent("invoice.paid", invoice);
  assert.deepEqual(
    (await verify(fake, r, big, { raw: Buffer.alloc(262145, 32).toString("base64") })).reasons,
    ["body_invalid"],
  );
  assert.deepEqual((await verify(fake, r, big, { raw: "%%%" })).reasons, ["body_invalid"]);
});

test("result codecs: closed JSON with fixed codes; hosted URLs only on Stripe's own hosts", () => {
  const receipt = {
    verdict: "recorded",
    receiptId: "00000000-0000-4000-8000-000000000001",
    objectDigest: "a".repeat(64),
    attributed: true,
  };
  assert.deepEqual(decodeStripeWebhookResult(encodeStripeWebhookResult(receipt)), receipt);
  for (const bad of [
    { ...receipt, verdict: "accepted" },
    { ...receipt, verdict: "rejected" },
    { ...receipt, objectDigest: "x" },
  ])
    assert.throws(() => encodeStripeWebhookResult(bad));
  const checkout = (url) =>
    JSON.stringify({ schemaVersion: 1, outcome: "verified", checkoutUrl: url, expiresAtMs: 1 });
  assert.equal(
    decodeStripeCheckoutResult(checkout("https://checkout.stripe.com/c/pay/cs_test_x")).checkoutUrl,
    "https://checkout.stripe.com/c/pay/cs_test_x",
  );
  for (const url of [
    "https://evil.example/c/pay",
    "http://checkout.stripe.com/c/pay",
    "https://checkout.stripe.com:444/c/pay",
    "https://user@checkout.stripe.com/c/pay",
    "javascript:alert(1)",
  ])
    assert.throws(() => decodeStripeCheckoutResult(checkout(url)), url);
  assert.throws(() =>
    decodeStripePortalResult(
      JSON.stringify({
        schemaVersion: 1,
        outcome: "verified",
        portalUrl: "https://checkout.stripe.com/x",
      }),
    ),
  );
  assert.throws(() =>
    decodeStripeCheckoutResult(
      JSON.stringify({
        schemaVersion: 1,
        outcome: "failed",
        checkoutUrl: "https://checkout.stripe.com/x",
        expiresAtMs: null,
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// The Stripe capability: development and staging only, with the vault, an rk_test_ key, a
// whsec_ secret, the closed configuration and an https login origin.
const login = JSON.parse(
  createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" })
    .configurationJson,
);
function brokerEnv(environment = "development", change = {}) {
  const env = {
    MORROW_ENVIRONMENT: environment,
    LOGIN_CONFIGURATION_JSON: JSON.stringify({ ...login, retentionTier: environment }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify({
      schemaVersion: 1,
      environment,
      projectId: "morrow-stripe-unit",
      branchId: "br-stripe-unit",
      hostname: "ep-stripe-unit.c-14.us-east-1.aws.neon.tech",
      database: "morrow",
    }),
    WORKOS_API_KEY: "sk_test_" + randomBytes(16).toString("hex"),
    TURNSTILE_SECRET_KEY: "0x" + randomBytes(16).toString("hex"),
    TURNSTILE_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      hostname: "workspace.example.test",
      actions: { login: "account_login", signup: "organization_signup" },
    }),
    ...Object.fromEntries(
      [...brokerNeonRoleNames, "morrow_vault_broker"].map((role) => [
        brokerPasswordSecret(role),
        "role-" + randomBytes(12).toString("hex"),
      ]),
    ),
    MORROW_VAULT_KEK_V1: randomBytes(32).toString("hex"),
    // M5: the Stripe switch on (owner decision (c), 2026-10-21; its runtime image).
    MORROW_STRIPE_MODE: "test",
    STRIPE_RESTRICTED_KEY: "rk_test_" + randomBytes(16).toString("hex"),
    STRIPE_WEBHOOK_SECRET: "whsec_" + randomBytes(16).toString("hex"),
    STRIPE_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      portalConfigurationId: "bpc_" + "C".repeat(24),
      automaticTax: false,
      billingAddressCollection: "auto",
    }),
    ...change,
  };
  for (const [name, value] of Object.entries(change)) if (value === undefined) delete env[name];
  return env;
}

test("capability: rk_test_ only, whsec_, the closed configuration, never production or without the vault", async () => {
  const ready = await brokerCapabilities(brokerEnv());
  assert.notEqual(ready.stripe, null);
  assert.equal(ready.stripeMode, "test");
  assert.equal(ready.stripe.environment, "development");
  assert.equal(ready.stripe.returnOrigin, "https://workspace.example.test");
  assert.equal(ready.stripe.configuration.billingAddressCollection, "auto");
  assert.notEqual((await brokerCapabilities(brokerEnv("staging"))).stripe, null);
  for (const change of [
    { STRIPE_RESTRICTED_KEY: "sk_test_" + "a".repeat(32) },
    { STRIPE_RESTRICTED_KEY: "rk_live_" + "a".repeat(32) },
    { STRIPE_RESTRICTED_KEY: "rk_test_short" },
    { STRIPE_RESTRICTED_KEY: undefined },
    { STRIPE_WEBHOOK_SECRET: "wh_" + "a".repeat(32) },
    { STRIPE_WEBHOOK_SECRET: undefined },
    { STRIPE_CONFIGURATION_JSON: undefined },
    { STRIPE_CONFIGURATION_JSON: '{"schemaVersion":1}' },
    { MORROW_VAULT_KEK_V1: undefined },
    { MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: undefined },
  ]) {
    const capabilities = await brokerCapabilities(brokerEnv("development", change));
    assert.equal(capabilities.stripe, null, JSON.stringify(Object.keys(change)));
    // Stripe holds alone: the api's leases stay.
    assert.notEqual(capabilities.database, null);
  }
  const production = await brokerCapabilities(brokerEnv("production"));
  assert.equal(production.stripe, null);
  assert.equal(production.stripeMode, "off");
  assert.throws(() =>
    parseStripeConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        portalConfigurationId: "bpc_" + "C".repeat(24),
        automaticTax: false,
        billingAddressCollection: "auto",
        portalConfigurationId2: "x",
      }),
    ),
  );
  const init = logs.map((l) => JSON.parse(l)).filter((l) => l.event === "morrow_broker_init");
  assert.ok(init.some((l) => l.stripe === true) && init.some((l) => l.stripe === false));
  // No key, secret or configuration value is ever logged.
  const text = logs.join("\n");
  assert.doesNotMatch(text, /rk_test_|whsec_|bpc_/);
});

test("broker handlers: closed inputs first, then BROKER_HELD; an unreachable vault login holds", async () => {
  logs.length = 0;
  const env = brokerEnv();
  const held = async (pending) => {
    await assert.rejects(pending, (error) => error.message === "BROKER_HELD");
  };
  await held(brokerStripeCustomerEnsure(env, "not-a-uuid", 1000));
  await held(brokerStripeCustomerEnsure(env, operationId, 0));
  await held(brokerStripeCustomerEnsure(env, operationId, 10001));
  await held(brokerStripeWebhookVerify(env, "", "t=1", 1000));
  await held(brokerStripeWebhookVerify(env, "e30=", "", 1000));
  await held(brokerStripeWebhookVerify(env, "e30=", "x".repeat(4097), 1000));
  // Valid inputs: the operation is first opened on the vault login (M2 PR-2's transport).
  // Here its one pinned socket is refused (and the driver's own Upgrade fallback to the same
  // host fails too), so the call holds before any Stripe request. Production has no Stripe
  // capability at all.
  const sockets = [];
  const fetches = [];
  const { WebSocket: nativeSocket, fetch: nativeFetch } = globalThis;
  globalThis.WebSocket = function (url) {
    sockets.push(String(url));
    throw Error("lab: no network");
  };
  globalThis.fetch = async (request) => {
    fetches.push(String(request?.url ?? request));
    throw Error("lab: no network");
  };
  try {
    await held(brokerStripeCustomerEnsure(env, operationId, 1000));
    await held(brokerStripeCustomerEnsure(brokerEnv("production"), operationId, 1000));
  } finally {
    globalThis.WebSocket = nativeSocket;
    globalThis.fetch = nativeFetch;
  }
  const { hostname } = JSON.parse(env.MORROW_DATABASE_BINDING_JSON);
  assert.deepEqual(sockets, [`wss://${hostname}/v2?address=${hostname}:5432`]);
  assert.ok(fetches.every((url) => url === `https://${hostname}/v2?address=${hostname}:5432`));
  const codes = logs
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "morrow_broker")
    .map((l) => [l.method, l.code]);
  assert.deepEqual(codes, [
    ["stripeCustomerEnsure", "INPUT_INVALID"],
    ["stripeCustomerEnsure", "BUDGET_INVALID"],
    ["stripeCustomerEnsure", "BUDGET_INVALID"],
    ["stripeWebhookVerify", "INPUT_INVALID"],
    ["stripeWebhookVerify", "INPUT_INVALID"],
    ["stripeWebhookVerify", "INPUT_INVALID"],
    ["stripeCustomerEnsure", "CAPABILITY_UNAVAILABLE"],
    // Production has no Stripe switch: off, refused before anything else.
    ["stripeCustomerEnsure", "STRIPE_UNAVAILABLE"],
  ]);
});

// M5, the Stripe switch (owner decision (c), 2026-10-21). Off (no MORROW_STRIPE_MODE, the
// committed staging state) or any value but "test": the broker reads no Stripe secret or
// configuration (`stripe` null, init stripeMode "off"), and each of the four Stripe methods
// is BROKER_HELD with the fixed code STRIPE_UNAVAILABLE before its inputs are checked, with
// no vault socket, no fetch and no Stripe request, even with every Stripe secret bound.
test("switch off: every Stripe method is STRIPE_UNAVAILABLE before inputs, database or Stripe", async () => {
  const { brokerStripeCheckoutCreate, brokerStripePortalCreate } = await import(
    "../apps/broker/src/stripe-broker.ts"
  );
  for (const environment of ["development", "staging"])
    for (const change of [
      { MORROW_STRIPE_MODE: undefined },
      { MORROW_STRIPE_MODE: "live" },
      { MORROW_STRIPE_MODE: "TEST" },
      { MORROW_STRIPE_MODE: "on" },
      { MORROW_STRIPE_MODE: "" },
    ]) {
      const capabilities = await brokerCapabilities(brokerEnv(environment, change));
      assert.equal(capabilities.stripeMode, "off", JSON.stringify(change));
      assert.equal(capabilities.stripe, null);
      // Nothing else depends on the switch.
      assert.notEqual(capabilities.vault, null);
      assert.notEqual(capabilities.database, null);
    }
  const env = brokerEnv("staging", { MORROW_STRIPE_MODE: undefined });
  logs.length = 0;
  const sockets = [];
  const fetches = [];
  const { WebSocket: nativeSocket, fetch: nativeFetch } = globalThis;
  globalThis.WebSocket = function (url) {
    sockets.push(String(url));
    throw Error("unit: no network");
  };
  globalThis.fetch = async (request) => {
    fetches.push(String(request?.url ?? request));
    throw Error("unit: no network");
  };
  try {
    for (const pending of [
      brokerStripeCustomerEnsure(env, operationId, 1000),
      brokerStripeCheckoutCreate(env, operationId, 1000),
      brokerStripePortalCreate(env, operationId, 1000),
      brokerStripeWebhookVerify(env, "e30=", "t=1,v1=" + "a".repeat(64), 1000),
      // Malformed inputs are not even looked at.
      brokerStripeCustomerEnsure(env, "not-a-uuid", 0),
      brokerStripeWebhookVerify(env, "", "", 1000),
    ])
      await assert.rejects(pending, (error) => error.message === "BROKER_HELD");
  } finally {
    globalThis.WebSocket = nativeSocket;
    globalThis.fetch = nativeFetch;
  }
  assert.deepEqual(sockets, []);
  assert.deepEqual(fetches, []);
  const rows = logs.map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.filter((l) => l.event === "morrow_broker").map((l) => [l.method, l.code]),
    [
      ["stripeCustomerEnsure", "STRIPE_UNAVAILABLE"],
      ["stripeCheckoutCreate", "STRIPE_UNAVAILABLE"],
      ["stripePortalCreate", "STRIPE_UNAVAILABLE"],
      ["stripeWebhookVerify", "STRIPE_UNAVAILABLE"],
      ["stripeCustomerEnsure", "STRIPE_UNAVAILABLE"],
      ["stripeWebhookVerify", "STRIPE_UNAVAILABLE"],
    ],
  );
  const init = rows.filter((l) => l.event === "morrow_broker_init");
  assert.equal(init.length, 1);
  assert.equal(init[0].stripe, false);
  assert.equal(init[0].stripeMode, "off");
  assert.doesNotMatch(logs.join("\n"), /rk_test_|whsec_|bpc_/);
});
