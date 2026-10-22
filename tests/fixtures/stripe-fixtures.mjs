// Synthetic Stripe objects on the pinned API version (M5 PR-1), built from the JSON files in
// tests/fixtures/stripe/ (hand-built from the 2025-03-31.basil API reference; replaced by
// recorded test-mode objects after the owner-approved smoke). `stripeFixture` clones one
// and rewrites its synthetic ids and fields for a test, so unit tests, lab:billing, the fake
// Stripe origin and lab:billing-workers share one source.
import { readFileSync } from "node:fs";

const base = new URL("./stripe/", import.meta.url);
const cache = new Map();
const load = (name) => {
  if (!cache.has(name)) cache.set(name, readFileSync(new URL(name + ".json", base), "utf8"));
  return cache.get(name);
};
export const stripeFixtureNames = Object.freeze([
  "invoice.paid.subscription_create",
  "invoice.paid.subscription_cycle",
  "invoice.payment_failed",
  "subscription.active",
  "subscription.cancel_at",
  "subscription.cancel_at_period_end",
  "subscription.deleted",
  "checkout.session.open",
  "checkout.session.completed",
  "checkout.session.expired",
]);
// The synthetic ids every fixture uses, and the patch key that replaces each.
const synthetic = Object.freeze({
  customer: "cus_1SynthCustomer01",
  subscription: "sub_1SynthSubscr0001",
  session: "cs_test_a1SynthSession0001",
  price: "price_MorrowDevBeta0049",
  operationId: "00000000-0000-4000-8000-0000000000c1",
  workspaceId: "ws_billing",
  organizationId: "org_billing",
});
const invoiceIds = Object.freeze({
  "invoice.paid.subscription_create": "in_1SynthCreate0001",
  "invoice.paid.subscription_cycle": "in_1SynthCycle00001",
  "invoice.payment_failed": "in_1SynthFailed0001",
});

/**
 * One fixture with its ids replaced: {customer, subscription, session, price, operationId,
 * workspaceId, organizationId, invoice} and then field overrides through `edit(object)`.
 * A null metadata id removes that key.
 */
export function stripeFixture(name, patch = {}, edit = null) {
  if (!stripeFixtureNames.includes(name)) throw Error("STRIPE_FIXTURE_UNKNOWN:" + name);
  let text = load(name);
  for (const [key, value] of Object.entries(synthetic))
    if (Object.hasOwn(patch, key) && patch[key] !== null)
      text = text.replaceAll(JSON.stringify(value), JSON.stringify(patch[key]));
  if (patch.invoice && invoiceIds[name])
    text = text.replaceAll(invoiceIds[name], patch.invoice.replace(/^in_/, "in_"));
  const object = JSON.parse(text);
  delete object._synthetic;
  const metadata =
    object.object === "invoice" ? object.parent?.subscription_details?.metadata : object.metadata;
  for (const [key, field] of [
    ["operationId", "morrow_operation_id"],
    ["workspaceId", "morrow_workspace_id"],
    ["organizationId", "morrow_organization_id"],
  ])
    if (metadata && Object.hasOwn(patch, key) && patch[key] === null) delete metadata[field];
  if (edit) edit(object);
  return object;
}
/** A Stripe event envelope around one object (the shape Stripe posts). */
export function stripeEvent(id, type, object, { livemode = false, created = 1760000100 } = {}) {
  return {
    id,
    object: "event",
    api_version: "2025-03-31.basil",
    created,
    data: { object },
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
}
