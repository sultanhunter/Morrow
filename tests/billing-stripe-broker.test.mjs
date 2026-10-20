// M5 PR-1: the broker's Stripe writes (apps/broker/src/stripe.ts) against the fake Stripe
// origin (scripts/fixtures/stripe-fake.mjs), with the broker login's definers replaced by
// an in-memory operation that follows migration 0027's stripe_op_begin/settle rules. The
// SQL itself runs in lab:billing (section G drives this same code over PostgreSQL 17).
// Covers: closed request builders on the pinned version, the operation-bound
// Idempotency-Key, the request digest recomputed from the database's parameters, outcome
// mapping (2xx readback, 4xx, one 429 resend, 5xx, transport loss), and reconciliation by
// readback first, then a same-key replay only within 23 hours, never a new key.
import assert from "node:assert/strict";
import test from "node:test";
import {
  StripeHold,
  stripeCheckoutCreate,
  stripeCustomerEnsure,
  stripePortalCreate,
} from "../apps/broker/src/stripe.ts";
import { billingVaultStatements } from "../apps/broker/src/vault-statements-billing.ts";
import { vaultStatements } from "../apps/broker/src/vault.ts";
import {
  stripeApiVersion,
  stripeRequestDigest,
} from "../packages/work/src/billing/stripe-objects.ts";
import {
  createStripeFake,
  fakeStripeKey,
  fakeStripePrice,
  fakeStripeWebhookSecret,
} from "../scripts/fixtures/stripe-fake.mjs";

const org = "org_billing_unit";
const ws = "ws_billing_unit";
const returnOrigin = "https://workspace.example.test";
const portalConfigurationId = "bpc_" + "LabPortalConfig".padEnd(24, "0");
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const purposeParts = {
  customer_create: (op, p) => [op, p.organizationId, p.workspaceId],
  checkout_session_create: (op, p) => [
    op,
    p.organizationId,
    p.workspaceId,
    p.intentId,
    p.priceKey,
    p.expiresAt,
    p.termsRevision,
  ],
  portal_session_create: (op, p) => [op, p.organizationId, p.workspaceId, p.customerId],
};

// One stripe_write operation as migration 0027 keeps it: authorized -> (send fence)
// dispatching -> verified | failed | uncertain; a fenced dispatching operation begins
// again as uncertain ('reconcile'); settle never promotes without a provider result.
function operation(purpose, params = {}, { createdAtMs = Date.now() } = {}) {
  const id = uuid();
  const p = { organizationId: org, workspaceId: ws, operationId: id, ...params };
  return {
    id,
    purpose,
    params: p,
    status: "authorized",
    fenced: false,
    attempts: 0,
    providerObjectId: null,
    createdAtMs,
    digest: null,
    settles: [],
  };
}
function vault(ops, { digestOverride = null, settleFails = false } = {}) {
  const calls = [];
  const byId = new Map(ops.map((op) => [op.id, op]));
  const transaction = async (budgetMs, body) => {
    assert.ok(Number.isSafeInteger(budgetMs) && budgetMs > 0);
    return body(async (text, values) => {
      // Only registered statements, text values only (the transport's rule).
      assert.ok(Object.values(vaultStatements).includes(text), text);
      assert.ok(values.every((v) => typeof v === "string"));
      calls.push([text, values]);
      const op = byId.get(values[0]);
      if (text === billingVaultStatements.stripeOpBegin) {
        if (!op) return [{ ...emptyBegin, outcome: "not_found" }];
        let outcome;
        if (op.status === "authorized") {
          op.status = "dispatching";
          op.fenced = true;
          op.attempts++;
          outcome = "send";
        } else if (op.status === "dispatching" && op.fenced) {
          op.status = "uncertain";
          outcome = "reconcile";
        } else
          outcome =
            { uncertain: "reconcile", verified: "verified", failed: "failed" }[op.status] ??
            "state_conflict";
        if (op.purpose === "checkout_session_create" && !op.params.customerId)
          outcome = "customer_pending";
        op.digest ??= await stripeRequestDigest([
          op.purpose,
          ...purposeParts[op.purpose](op.id, op.params),
        ]);
        return [
          {
            outcome,
            purpose: op.purpose,
            status: op.status,
            request_digest: digestOverride ?? op.digest,
            params: JSON.stringify(op.params),
            provider_object_id: op.providerObjectId,
            created_at_ms: String(op.createdAtMs),
          },
        ];
      }
      if (text === billingVaultStatements.stripeOpSettle) {
        if (settleFails) throw Error("VAULT_OUTCOME_UNKNOWN");
        const [, result, object] = values;
        op.settles.push([result, object]);
        if (result === "verified") {
          if (op.status === "verified")
            return [{ outcome: op.providerObjectId === object ? "already_verified" : "conflict" }];
          op.status = "verified";
          op.providerObjectId = object;
          return [{ outcome: "verified" }];
        }
        if (result === "failed") {
          if (op.status === "failed") return [{ outcome: "already_failed" }];
          op.status = "failed";
          return [{ outcome: "failed" }];
        }
        if (op.status === "dispatching") op.status = "uncertain";
        return [{ outcome: "uncertain" }];
      }
      throw Error("UNEXPECTED_STATEMENT");
    });
  };
  return { calls, transaction };
}
const emptyBegin = {
  purpose: null,
  status: null,
  request_digest: null,
  params: null,
  provider_object_id: null,
  created_at_ms: null,
};
function deps(fake, v, now = () => Date.now()) {
  return {
    stripe: {
      environment: "development",
      restrictedKey: fakeStripeKey,
      webhookSecret: fakeStripeWebhookSecret,
      configuration: {
        portalConfigurationId,
        automaticTax: false,
        billingAddressCollection: "auto",
      },
      returnOrigin,
    },
    fetch: fake.fetch,
    transaction: v.transaction,
    now,
  };
}
const posts = (fake) => fake.requests.filter((r) => r.method === "POST");
const stateCode = async (pending) => {
  try {
    await pending;
  } catch (error) {
    assert.ok(error instanceof StripeHold);
    assert.equal(error.message, "STRIPE_HELD");
    return error.code;
  }
  assert.fail("expected a hold");
};

test("customer: one POST on the pinned version with the operation's key, ids in metadata, no email; readback then verified", async () => {
  const fake = createStripeFake();
  const op = operation("customer_create");
  const v = vault([op]);
  assert.deepEqual(await stripeCustomerEnsure(deps(fake, v), op.id, 5000), {
    outcome: "verified",
  });
  const [post] = posts(fake);
  assert.equal(posts(fake).length, 1);
  assert.equal(post.path, "/v1/customers");
  assert.equal(post.idempotencyKey, "morrow-development-" + op.id);
  assert.ok(fake.requests.every((r) => r.authorised));
  assert.deepEqual(post.form, {
    "metadata[morrow_operation_id]": op.id,
    "metadata[morrow_workspace_id]": ws,
    "metadata[morrow_organization_id]": org,
  });
  assert.ok(!Object.keys(post.form).some((k) => /email|name|address|phone/.test(k)));
  // The 2xx is read back (GET with the broker key) before the operation settles.
  assert.deepEqual(
    fake.requests.map((r) => [r.method, r.path.replace(/cus_\w+/, "cus_*")]),
    [
      ["POST", "/v1/customers"],
      ["GET", "/v1/customers/cus_*"],
    ],
  );
  assert.equal(op.status, "verified");
  assert.match(op.providerObjectId, /^cus_/);
  assert.equal(stripeApiVersion, "2025-03-31.basil");
});

test("the request digest is recomputed from the database's parameters before any send", async () => {
  const fake = createStripeFake();
  const op = operation("customer_create");
  assert.equal(
    await stateCode(
      stripeCustomerEnsure(
        deps(fake, vault([op], { digestOverride: "0".repeat(64) })),
        op.id,
        5000,
      ),
    ),
    "STATE_INVALID",
  );
  assert.equal(fake.requests.length, 0);
  // Another purpose than the method's own is refused as input.
  const portal = operation("portal_session_create", { customerId: "cus_" + "A".repeat(14) });
  assert.equal(
    await stateCode(stripeCustomerEnsure(deps(fake, vault([portal])), portal.id, 5000)),
    "INPUT_INVALID",
  );
  assert.equal(
    await stateCode(stripeCustomerEnsure(deps(fake, vault([])), uuid(), 5000)),
    "INPUT_INVALID",
  );
  assert.equal(fake.requests.length, 0);
});

test("first send: a 4xx or a repeated 429 fails; a 5xx or a lost reply is uncertain, never failed", async () => {
  for (const [faults, outcome, sends] of [
    [["400"], "failed", 1],
    [["429", "429"], "failed", 2],
    [["429"], "verified", 2],
    [["500_before"], "uncertain", 1],
    [["500_after"], "uncertain", 1],
    [["lost_before"], "uncertain", 1],
    [["lost_after"], "uncertain", 1],
  ]) {
    const fake = createStripeFake();
    for (const kind of faults) fake.faults.push({ method: "POST", path: "/v1/customers", kind });
    const op = operation("customer_create");
    const result = await stripeCustomerEnsure(deps(fake, vault([op])), op.id, 5000);
    assert.equal(result.outcome, outcome, faults.join());
    assert.equal(posts(fake).length, sends, faults.join());
    // Every send of one operation carries the same key.
    assert.deepEqual(
      [...new Set(posts(fake).map((r) => r.idempotencyKey))],
      ["morrow-development-" + op.id],
    );
    assert.equal(op.status, outcome === "uncertain" ? "uncertain" : outcome);
  }
});

test("reconcile: readback first, a same-key replay only after proven absence and within 23 hours", async () => {
  // The first send created the customer but its reply was lost: the readback finds it,
  // and nothing is sent again.
  const fake = createStripeFake();
  fake.faults.push({ method: "POST", path: "/v1/customers", kind: "lost_after" });
  const op = operation("customer_create");
  const v = vault([op]);
  assert.equal((await stripeCustomerEnsure(deps(fake, v), op.id, 5000)).outcome, "uncertain");
  assert.equal(fake.state.customers.size, 1);
  assert.equal((await stripeCustomerEnsure(deps(fake, v), op.id, 5000)).outcome, "verified");
  assert.equal(posts(fake).length, 1);
  assert.ok(fake.requests.some((r) => r.path === "/v1/customers/search"));
  assert.equal(fake.state.customers.size, 1);
  assert.equal(op.status, "verified");

  // Search lags: absence is not proven by search alone, so the replay uses the same key
  // and Stripe's saved result returns the same customer (no second customer).
  const lagging = createStripeFake();
  lagging.options.searchLag = true;
  lagging.faults.push({ method: "POST", path: "/v1/customers", kind: "lost_after" });
  const op2 = operation("customer_create");
  const v2 = vault([op2]);
  await stripeCustomerEnsure(deps(lagging, v2), op2.id, 5000);
  assert.equal((await stripeCustomerEnsure(deps(lagging, v2), op2.id, 5000)).outcome, "verified");
  assert.equal(lagging.state.customers.size, 1);
  assert.deepEqual(
    posts(lagging).map((r) => r.idempotencyKey),
    ["morrow-development-" + op2.id, "morrow-development-" + op2.id],
  );

  // Older than 23 hours: no replay; the operation stays uncertain.
  const old = createStripeFake();
  old.options.searchLag = true;
  old.faults.push({ method: "POST", path: "/v1/customers", kind: "lost_before" });
  const op3 = operation("customer_create", {}, { createdAtMs: Date.now() - 23 * 3600 * 1000 - 1 });
  const v3 = vault([op3]);
  await stripeCustomerEnsure(deps(old, v3), op3.id, 5000);
  assert.equal((await stripeCustomerEnsure(deps(old, v3), op3.id, 5000)).outcome, "uncertain");
  assert.equal(posts(old).length, 1);
  assert.equal(op3.status, "uncertain");

  // A replay that a saved 500 answers, or that a 4xx refuses, leaves the operation
  // uncertain: a replay's refusal says nothing about the first send.
  for (const kind of ["500_after", "400"]) {
    const saved = createStripeFake();
    saved.options.searchLag = true;
    saved.faults.push({ method: "POST", path: "/v1/customers", kind: "500_after" });
    const op4 = operation("customer_create");
    const v4 = vault([op4]);
    await stripeCustomerEnsure(deps(saved, v4), op4.id, 5000);
    if (kind === "400") saved.faults.push({ method: "POST", path: "/v1/customers", kind: "400" });
    assert.equal((await stripeCustomerEnsure(deps(saved, v4), op4.id, 5000)).outcome, "uncertain");
    assert.equal(op4.status, "uncertain", kind);
    assert.ok(!op4.settles.some(([result]) => result === "failed"), kind);
  }
});

test("a lost settle acknowledgement leaves the outcome uncertain for the caller", async () => {
  const fake = createStripeFake();
  const op = operation("customer_create");
  const result = await stripeCustomerEnsure(
    deps(fake, vault([op], { settleFails: true })),
    op.id,
    5000,
  );
  assert.equal(result.outcome, "uncertain");
});

test("checkout: subscription mode on the mapped customer, the terms' price, both metadata, the intent's expiry", async () => {
  const fake = createStripeFake();
  const customerOp = operation("customer_create");
  const customer = await stripeCustomerEnsure(deps(fake, vault([customerOp])), customerOp.id, 5000);
  assert.equal(customer.outcome, "verified");
  const customerId = customerOp.providerObjectId;
  const expiresAt = String(Math.floor(Date.now() / 1000) + 3600);
  const op = operation("checkout_session_create", {
    intentId: uuid(),
    priceKey: "stripe:price:" + fakeStripePrice,
    mode: "test",
    expiresAt,
    termsRevision: "1",
    customerId,
  });
  const v = vault([op]);
  const result = await stripeCheckoutCreate(deps(fake, v), op.id, 5000);
  assert.equal(result.outcome, "verified");
  assert.match(result.checkoutUrl, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  assert.equal(result.expiresAtMs, Number(expiresAt) * 1000);
  const post = posts(fake).at(-1);
  assert.equal(post.path, "/v1/checkout/sessions");
  assert.equal(post.idempotencyKey, "morrow-development-" + op.id);
  const ids = { morrow_operation_id: op.id, morrow_workspace_id: ws, morrow_organization_id: org };
  assert.deepEqual(post.form, {
    mode: "subscription",
    customer: customerId,
    "line_items[0][price]": fakeStripePrice,
    "line_items[0][quantity]": "1",
    expires_at: expiresAt,
    success_url: `${returnOrigin}/w/${ws}/settings/billing?checkout=complete`,
    cancel_url: `${returnOrigin}/w/${ws}/settings/billing?checkout=cancelled`,
    ...Object.fromEntries(Object.entries(ids).map(([k, x]) => [`metadata[${k}]`, x])),
    ...Object.fromEntries(
      Object.entries(ids).map(([k, x]) => [`subscription_data[metadata][${k}]`, x]),
    ),
    billing_address_collection: "auto",
    "automatic_tax[enabled]": "false",
    allow_promotion_codes: "false",
  });
  // Never an email, a trial or a client-chosen URL.
  assert.ok(!Object.keys(post.form).some((k) => /email|trial|discount|coupon/.test(k)));
  // The session is read back; its URL is returned and never sent to the database.
  assert.ok(
    fake.requests.some((r) => r.method === "GET" && r.path.startsWith("/v1/checkout/sessions/cs_")),
  );
  assert.ok(v.calls.every(([, values]) => !values.some((x) => x.includes("checkout.stripe.com"))));
  // A replay of the verified operation returns the open session's URL without a send.
  const before = posts(fake).length;
  const again = await stripeCheckoutCreate(deps(fake, v), op.id, 5000);
  assert.deepEqual(again, result);
  assert.equal(posts(fake).length, before);
  // After Stripe expires it, the operation answers closed.
  fake.expire(op.providerObjectId);
  assert.deepEqual(await stripeCheckoutCreate(deps(fake, v), op.id, 5000), {
    outcome: "closed",
    checkoutUrl: null,
    expiresAtMs: null,
  });
});

test("checkout: a pending customer sends nothing; reconcile lists the customer's sessions first", async () => {
  const fake = createStripeFake();
  const pending = operation("checkout_session_create", {
    intentId: uuid(),
    priceKey: "stripe:price:" + fakeStripePrice,
    mode: "test",
    expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
    termsRevision: "1",
    customerId: null,
  });
  assert.deepEqual(await stripeCheckoutCreate(deps(fake, vault([pending])), pending.id, 5000), {
    outcome: "pending",
    checkoutUrl: null,
    expiresAtMs: null,
  });
  assert.equal(fake.requests.length, 0);

  const c = operation("customer_create");
  await stripeCustomerEnsure(deps(fake, vault([c])), c.id, 5000);
  const op = operation("checkout_session_create", {
    intentId: uuid(),
    priceKey: "stripe:price:" + fakeStripePrice,
    mode: "test",
    expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
    termsRevision: "1",
    customerId: c.providerObjectId,
  });
  fake.faults.push({ method: "POST", path: "/v1/checkout/sessions", kind: "lost_after" });
  const v = vault([op]);
  assert.equal((await stripeCheckoutCreate(deps(fake, v), op.id, 5000)).outcome, "uncertain");
  const sends = posts(fake).length;
  const reconciled = await stripeCheckoutCreate(deps(fake, v), op.id, 5000);
  assert.equal(reconciled.outcome, "verified");
  assert.equal(posts(fake).length, sends, "readback found the session: no replay");
  assert.ok(fake.requests.some((r) => r.path === "/v1/checkout/sessions" && r.method === "GET"));
  assert.equal(fake.state.sessions.size, 1);

  // A live-mode intent is never sent from development or staging.
  const live = operation("checkout_session_create", {
    intentId: uuid(),
    priceKey: "stripe:price:" + fakeStripePrice,
    mode: "live",
    expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
    termsRevision: "1",
    customerId: c.providerObjectId,
  });
  assert.equal(
    await stateCode(stripeCheckoutCreate(deps(fake, vault([live])), live.id, 5000)),
    "STATE_INVALID",
  );
});

test("portal: the saved configuration, the mapped customer, the billing page; replay only within 23 hours", async () => {
  const fake = createStripeFake();
  const c = operation("customer_create");
  await stripeCustomerEnsure(deps(fake, vault([c])), c.id, 5000);
  const op = operation("portal_session_create", { customerId: c.providerObjectId });
  const v = vault([op]);
  const result = await stripePortalCreate(deps(fake, v), op.id, 5000);
  assert.equal(result.outcome, "verified");
  assert.match(result.portalUrl, /^https:\/\/billing\.stripe\.com\/p\/session\//);
  assert.deepEqual(posts(fake).at(-1).form, {
    customer: c.providerObjectId,
    configuration: portalConfigurationId,
    return_url: `${returnOrigin}/w/${ws}/settings/billing`,
  });
  assert.equal(posts(fake).at(-1).idempotencyKey, "morrow-development-" + op.id);

  // Uncertain (no retrieve endpoint exists): the same-key replay returns the saved session.
  const lost = operation("portal_session_create", { customerId: c.providerObjectId });
  fake.faults.push({ method: "POST", path: "/v1/billing_portal/sessions", kind: "lost_after" });
  const lv = vault([lost]);
  assert.equal((await stripePortalCreate(deps(fake, lv), lost.id, 5000)).outcome, "uncertain");
  const replay = await stripePortalCreate(deps(fake, lv), lost.id, 5000);
  assert.equal(replay.outcome, "verified");
  assert.equal(fake.state.portals.size, 2);

  // Past 23 hours an uncertain portal operation is not replayed.
  const stale = operation(
    "portal_session_create",
    { customerId: c.providerObjectId },
    { createdAtMs: Date.now() - 24 * 3600 * 1000 },
  );
  fake.faults.push({ method: "POST", path: "/v1/billing_portal/sessions", kind: "lost_before" });
  const sv = vault([stale]);
  await stripePortalCreate(deps(fake, sv), stale.id, 5000);
  const sends = posts(fake).length;
  assert.equal((await stripePortalCreate(deps(fake, sv), stale.id, 5000)).outcome, "uncertain");
  assert.equal(posts(fake).length, sends);
});

test("only the Stripe API origin is ever called, and no provider text reaches a result", async () => {
  const fake = createStripeFake();
  const urls = [];
  const op = operation("customer_create");
  const d = deps(fake, vault([op]));
  d.fetch = (request) => {
    urls.push(new URL(request.url).origin);
    assert.equal(request.redirect, "manual");
    return fake.fetch(request);
  };
  fake.faults.push({ method: "POST", path: "/v1/customers", kind: "400" });
  const result = await stripeCustomerEnsure(d, op.id, 5000);
  assert.deepEqual(result, { outcome: "failed" });
  assert.deepEqual([...new Set(urls)], ["https://api.stripe.com"]);
});
