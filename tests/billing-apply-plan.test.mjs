// M5 PR-1: the receipt application planner (packages/work/src/billing/apply-plan.ts) over
// the pinned-version fixtures (tests/fixtures/stripe/, synthetic until the test-mode smoke
// records real ones). Pure: receipt_begin's facts in, one closed plan out. receipt_apply
// re-derives the money in SQL (lab:billing D and F); this file pins the planner's choices:
// the operation from parent.subscription_details.metadata, the first paid invoice fixing
// the route and granting, held, no-charge and conflict outcomes, the cancellation fold with
// validUntil = min(period end, cancel_at), and the checkout intent transitions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeCheckoutSession,
  normalizeInvoice,
  normalizeSubscription,
  parseReceiptFacts,
  paymentEventFor,
  planReceiptApplication,
  receiptModeAccepted,
  stripeObjectDigest,
  subscriptionValidUntil,
} from "../packages/work/src/billing/index.ts";
import { stripeFixture } from "./fixtures/stripe-fixtures.mjs";

const terms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8")).environments
  .development[0].terms;
const org = "org_billing";
const ws = "ws_billing";
const operationId = "00000000-0000-4000-8000-0000000000c1";
const intentId = "00000000-0000-4000-8000-0000000000d1";
const accountId = "00000000-0000-4000-8000-0000000000e1";
const now = new Date().toISOString();
const nowS = Math.floor(Date.now() / 1000);
const period = (o) => {
  if (o.object === "invoice") o.lines.data[0].period = { start: nowS - 60, end: nowS + 30 * 86400 };
  if (o.object === "subscription") o.items.data[0].current_period_end = nowS + 30 * 86400;
};
const subscription = (name = "subscription.active", edit = period) => stripeFixture(name, {}, edit);
const invoice = (name = "invoice.paid.subscription_create", patch = {}, edit = period) =>
  normalizeInvoice(stripeFixture(name, patch, edit), subscription());

async function receipt(eventType, object, { attributed = true, livemode = false } = {}) {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    organizationId: attributed ? org : null,
    workspaceId: attributed ? ws : null,
    eventId: "evt_" + "A".repeat(24),
    eventType,
    livemode,
    mode: livemode ? "live" : "test",
    objectType: object.kind,
    objectId: object.id,
    customerId: object.customer,
    object,
    objectDigest: await stripeObjectDigest(object),
    observedAt: new Date(Date.now() - 1000).toISOString(),
  };
}
const routeRow = (fixed = false) => ({
  organization_id: org,
  workspace_id: ws,
  origin: "website",
  shopify_bound_at: null,
  route: fixed ? "morrow_direct" : null,
  mode: fixed ? "test" : null,
  route_fixed_at: fixed ? new Date(Date.now() - 86400000).toISOString() : null,
  fixing_payment_key: fixed ? "stripe:invoice:in_" + "P".repeat(16) : null,
  revision: fixed ? "2" : "1",
});
const accountRow = {
  organization_id: org,
  workspace_id: ws,
  id: accountId,
  route: "morrow_direct",
  mode: "test",
  currency: "USD",
  status: "active",
  revision: "1",
};
const snapshotRow = (status = "active") => ({
  organization_id: org,
  workspace_id: ws,
  billing_account_id: accountId,
  revision: "1",
  route: "morrow_direct",
  mode: "test",
  subscription_key: "stripe:sub:sub_1SynthSubscr0001",
  status,
  provider_evidence_ref: "a".repeat(64),
  verified_at: new Date(Date.now() - 86400000).toISOString(),
  valid_until: new Date(Date.now() + 29 * 86400000).toISOString(),
});
function facts(r, records = {}) {
  if (r.organizationId === null) return JSON.stringify({ receipt: r });
  return JSON.stringify({
    receipt: r,
    route: routeRow(),
    associations: [],
    account: null,
    snapshot: null,
    conflicts: [],
    intentPending: true,
    terms: { termsRevision: "1", terms },
    payment:
      r.objectType === "invoice"
        ? { paymentKey: "stripe:invoice:" + r.objectId, granted: false, recorded: false }
        : null,
    checkoutOperation: { operationId, intentId },
    intent: { id: intentId, status: "open", revision: "2" },
    ...records,
  });
}
const planFor = async (eventType, object, records = {}, options = {}) =>
  planReceiptApplication(
    parseReceiptFacts(facts(await receipt(eventType, object, options), records)),
    "development",
    now,
  );

test("pinned version: invoice.paid resolves its operation through parent.subscription_details.metadata", async () => {
  const paid = invoice();
  assert.deepEqual(paid.metadata, { operationId, organizationId: org, workspaceId: ws });
  assert.equal(paid.billingReason, "subscription_create");
  assert.equal(paid.price, "price_MorrowDevBeta0049");
  assert.equal(paid.subscription, "sub_1SynthSubscr0001");
  assert.equal(paid.amountPaid, "4900");
  assert.equal(paid.currency, "usd");
  assert.equal(paid.subscriptionState.status, "active");
  const event = paymentEventFor(await receipt("invoice.paid", paid), operationId);
  assert.equal(event.operationId, operationId);
  assert.equal(event.paymentKey, "stripe:invoice:in_1SynthCreate0001");
  assert.equal(event.priceKey, "stripe:price:price_MorrowDevBeta0049");
  assert.deepEqual(event.amountPaid, { amount: "49.00", currency: "USD" });
  // The invoice's own metadata (empty on the pinned version) is never the source.
  assert.equal(
    stripeFixture("invoice.paid.subscription_create").metadata.morrow_operation_id,
    undefined,
  );
  // A metadata workspace other than the mapping's is not Morrow-initiated: no operation.
  const foreign = invoice("invoice.paid.subscription_create", { workspaceId: "ws_other" });
  assert.equal(
    paymentEventFor(await receipt("invoice.paid", foreign), operationId).operationId,
    null,
  );
  // An operation that is not this tenant's checkout operation is not traced either.
  assert.equal(paymentEventFor(await receipt("invoice.paid", paid), null).operationId, null);
});

test("the first paid invoice in phase open fixes the route, grants once and verifies the intent", async () => {
  const plan = await planFor("invoice.paid", invoice());
  assert.deepEqual(plan, {
    schemaVersion: 1,
    outcome: "applied",
    code: null,
    payment: { action: "fix_route_and_grant", outcome: "granted", code: null, termsRevision: 1 },
    snapshot: { revision: 1 },
    intent: { intentId, to: "verified" },
  });
  // The same payment again: already granted, never a second grant.
  const again = await planFor("invoice.paid", invoice(), {
    payment: { paymentKey: "stripe:invoice:in_1SynthCreate0001", granted: true, recorded: true },
  });
  assert.equal(again.outcome, "already_granted");
  assert.equal(again.payment, null);
  // A completed intent (checkout.session.completed first) is verified the same way.
  const completedFirst = await planFor("invoice.paid", invoice(), {
    intent: { id: intentId, status: "completed", revision: "3" },
  });
  assert.deepEqual(completedFirst.intent, { intentId, to: "verified" });
});

test("a later period on a fixed route grants again and folds the snapshot forward", async () => {
  const cycle = invoice("invoice.paid.subscription_cycle");
  const plan = await planFor("invoice.paid", cycle, {
    route: routeRow(true),
    account: accountRow,
    snapshot: snapshotRow(),
    intentPending: false,
    // The subscription's metadata still names the first checkout operation, now verified.
    intent: { id: intentId, status: "verified", revision: "4" },
  });
  assert.equal(plan.outcome, "applied");
  assert.deepEqual(plan.payment, {
    action: "grant",
    outcome: "granted",
    code: null,
    termsRevision: 1,
  });
  assert.deepEqual(plan.snapshot, { revision: 2 });
  assert.equal(plan.intent, null);
});

test("held, no-charge, unattributed and terms outcomes", async () => {
  // An unmapped customer: held without any record of a tenant.
  const unmapped = await planFor("invoice.paid", invoice(), {}, { attributed: false });
  assert.deepEqual(
    [unmapped.outcome, unmapped.code, unmapped.payment],
    ["held", "CUSTOMER_NOT_MAPPED", null],
  );
  // A billing reason Morrow does not map: held TERMS_MISMATCH, no payment event.
  for (const reason of ["manual", "subscription_update", "subscription_threshold"]) {
    const plan = await planFor(
      "invoice.paid",
      invoice("invoice.paid.subscription_create", {}, (o) => {
        period(o);
        o.billing_reason = reason;
      }),
    );
    assert.deepEqual(
      [plan.outcome, plan.code, plan.payment],
      ["held", "TERMS_MISMATCH", null],
      reason,
    );
  }
  // A non-USD invoice has no safe minor-unit conversion: held TERMS_MISMATCH.
  const eur = await planFor(
    "invoice.paid",
    invoice("invoice.paid.subscription_create", {}, (o) => {
      period(o);
      o.currency = "eur";
    }),
  );
  assert.deepEqual([eur.outcome, eur.code], ["held", "TERMS_MISMATCH"]);
  // A price outside the current terms.
  const otherPrice = await planFor(
    "invoice.paid",
    invoice("invoice.paid.subscription_create", { price: "price_Unknown000001" }),
  );
  assert.deepEqual(
    [otherPrice.outcome, otherPrice.code, otherPrice.payment?.action],
    ["held", "TERMS_MISMATCH", "record"],
  );
  // A zero-amount invoice never fixes or grants.
  const zero = await planFor(
    "invoice.paid",
    invoice("invoice.paid.subscription_create", {}, (o) => {
      period(o);
      o.amount_paid = 0;
    }),
  );
  assert.equal(zero.outcome, "no_charge");
  assert.equal(zero.payment.action, "record");
  // An invoice that traces to no checkout operation of this tenant is not Morrow-initiated.
  const untraced = await planFor("invoice.paid", invoice(), { checkoutOperation: null });
  assert.deepEqual(
    [untraced.outcome, untraced.code, untraced.payment?.action],
    ["held", "NOT_MORROW_INITIATED", "record"],
  );
  const foreign = await planFor(
    "invoice.paid",
    invoice("invoice.paid.subscription_create", { workspaceId: "ws_other" }),
  );
  assert.deepEqual([foreign.outcome, foreign.code], ["held", "NOT_MORROW_INITIATED"]);
  // No terms row: held.
  assert.equal((await planFor("invoice.paid", invoice(), { terms: null })).code, "TERMS_MISMATCH");
});

test("a payment after a store association is a route conflict, never morrow_direct (defence case)", async () => {
  const plan = await planFor("invoice.paid", invoice(), {
    associations: [
      {
        installation_id: "inst_1",
        store_id: "store_1",
        connection_id: "conn_1",
        status: "linked",
        linked_at: new Date(Date.now() - 3600000).toISOString(),
      },
    ],
  });
  assert.equal(plan.outcome, "conflict");
  assert.equal(plan.code, "ROUTE_MISMATCH");
  assert.equal(plan.payment.action, "record");
  assert.equal(plan.payment.outcome, "conflict");
  assert.equal(plan.intent, null);
});

test("cancellation: cancel_at and cancel_at_period_end fold active until the earlier end, then cancelled", async () => {
  const end = nowS + 30 * 86400;
  const cancelAt = nowS + 10 * 86400;
  const atPeriodEnd = normalizeSubscription(
    stripeFixture("subscription.cancel_at_period_end", {}, (o) => {
      o.items.data[0].current_period_end = end;
    }),
  );
  assert.equal(atPeriodEnd.cancelAtPeriodEnd, true);
  assert.equal(subscriptionValidUntil(atPeriodEnd, now), new Date(end * 1000).toISOString());
  const scheduled = normalizeSubscription(
    stripeFixture("subscription.cancel_at", {}, (o) => {
      o.items.data[0].current_period_end = end;
      o.cancel_at = cancelAt;
    }),
  );
  assert.equal(scheduled.cancelAt, String(cancelAt));
  assert.equal(subscriptionValidUntil(scheduled, now), new Date(cancelAt * 1000).toISOString());
  assert.equal(
    subscriptionValidUntil({ ...scheduled, cancelAt: null, currentPeriodEnd: null }, now),
    now,
  );
  const fixed = {
    route: routeRow(true),
    account: accountRow,
    snapshot: snapshotRow(),
    intentPending: false,
    intent: null,
    checkoutOperation: null,
  };
  for (const object of [atPeriodEnd, scheduled]) {
    const plan = await planFor("customer.subscription.updated", object, fixed);
    assert.deepEqual([plan.outcome, plan.snapshot], ["applied", { revision: 2 }]);
  }
  const deleted = normalizeSubscription(stripeFixture("subscription.deleted"));
  assert.equal(deleted.status, "canceled");
  const ended = await planFor("customer.subscription.deleted", deleted, fixed);
  assert.deepEqual([ended.outcome, ended.snapshot], ["applied", { revision: 2 }]);
  // A cancelled snapshot is absorbing: a later live observation does not fold.
  const after = await planFor("customer.subscription.updated", atPeriodEnd, {
    ...fixed,
    snapshot: snapshotRow("cancelled"),
  });
  assert.equal(after.snapshot, null);
  // No account yet: nothing to fold.
  assert.deepEqual(
    [(await planFor("customer.subscription.updated", atPeriodEnd)).code],
    ["NO_ACCOUNT"],
  );
});

test("checkout events move only an open intent; any other is not applicable", async () => {
  const completed = normalizeCheckoutSession(stripeFixture("checkout.session.completed"));
  const expired = normalizeCheckoutSession(stripeFixture("checkout.session.expired"));
  assert.deepEqual((await planFor("checkout.session.completed", completed)).intent, {
    intentId,
    to: "completed",
  });
  assert.deepEqual((await planFor("checkout.session.expired", expired)).intent, {
    intentId,
    to: "expired",
  });
  const closed = await planFor("checkout.session.expired", expired, {
    intent: { id: intentId, status: "verified", revision: "4" },
  });
  assert.deepEqual(
    [closed.outcome, closed.code, closed.intent],
    ["ignored", "NOT_APPLICABLE", null],
  );
  // The session's status must match the event's.
  const mismatch = await planFor("checkout.session.completed", expired);
  assert.equal(mismatch.outcome, "ignored");
});

test("receipt facts are closed: shape, mode and digest are checked before planning", async () => {
  const r = await receipt("invoice.paid", invoice());
  assert.ok(receiptModeAccepted(r, "development"));
  assert.ok(!receiptModeAccepted({ ...r, livemode: true, mode: "live" }, "staging"));
  for (const bad of [
    { ...r, mode: "live" },
    { ...r, extra: 1 },
    { ...r, objectDigest: "x" },
    { ...r, objectType: "subscription" },
    { ...r, organizationId: null },
    { ...r, eventType: "customer.created" },
  ])
    assert.throws(() => parseReceiptFacts(facts(bad)), { code: "RECEIPT_FACTS_INVALID" });
  assert.throws(() => parseReceiptFacts("{"), { code: "RECEIPT_FACTS_INVALID" });
  assert.throws(() => parseReceiptFacts(JSON.stringify({ receipt: r, route: null })), {
    code: "RECEIPT_FACTS_INVALID",
  });
});
