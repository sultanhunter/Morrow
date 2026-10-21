// The staging test entitlement (owner decision (b), 2026-10-21; the ADR-0022 item 5
// amendment; migration 0030): the contract v1.1 billing shapes it writes, the terms entry
// its credits come from, and how the api's facts reader and the billing library read the
// result. The SQL itself runs in lab:test-entitlement (pg-http).
//   * OperatorEntitlementKey; a test-mode Morrow-direct WorkspaceBillingRoute and
//     EntitlementSnapshot naming it; never a payment key, never live, never Shopify.
//   * BillingTerms' one operator entry (no price, no offer); the offers and checkout never
//     see it.
//   * The facts reader maps the rows; staging reads the workspace billable for storeless
//     work and any linked store; production refuses the test route (R9).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentBillingDefinition } from "../packages/contracts/src/validation.ts";
import {
  createBillingFactsReader,
  currentOffers,
  parseTermsDocument,
  snapshotFromRow,
  subscriptionEntry,
} from "../packages/work/src/billing/index.ts";
import { workspaceBillingRouteFromRow } from "../packages/work/src/billing-route.ts";
import {
  entitlementFor,
  parseBillingTerms,
  parseWorkspaceBillingFacts,
  purchaseDecision,
  workspaceBillingState,
} from "../packages/policy/src/billing-state.ts";
import { billingStatements } from "../packages/work/src/billing/sql.ts";

const org = "org_operator";
const ws = "ws_operator";
const grant = "00000000-0000-4000-8000-0000000000e1";
const key = "morrow:operator_entitlement:" + grant;
const account = "00000000-0000-4000-8000-0000000000a1";
const at = (days) => new Date(Date.now() + days * 86400000).toISOString();
const start = at(-1);
const end = at(29);
const rows = {
  route: {
    organization_id: org,
    workspace_id: ws,
    origin: "website",
    shopify_bound_at: null,
    route: "morrow_direct",
    mode: "test",
    route_fixed_at: start,
    fixing_payment_key: key,
    revision: "2",
  },
  account: {
    organization_id: org,
    workspace_id: ws,
    id: account,
    route: "morrow_direct",
    mode: "test",
    currency: "USD",
    status: "active",
    revision: "1",
  },
  snapshot: {
    organization_id: org,
    workspace_id: ws,
    billing_account_id: account,
    revision: "1",
    route: "morrow_direct",
    mode: "test",
    subscription_key: key,
    status: "active",
    provider_evidence_ref: "e".repeat(64),
    verified_at: start,
    valid_until: end,
  },
  wallet: {
    organization_id: org,
    workspace_id: ws,
    billing_account_id: account,
    available: "300",
    reserved: "0",
    consumed: "0",
    rate_revision: "1",
    terms_revision: "1",
    revision: "2",
  },
};
const stagingTerms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8"))
  .environments.staging[0];
const developmentTerms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8"))
  .environments.development[0];

test("contract: the operator key, route and snapshot are test-mode Morrow-direct only", () => {
  const valid = (name, value) => validateCurrentBillingDefinition(name, value);
  assert.ok(valid("OperatorEntitlementKey", key));
  for (const bad of [
    "morrow:operator_entitlement:" + grant.toUpperCase(),
    "morrow:operator_entitlement:abc",
    "stripe:invoice:in_" + "A".repeat(16),
    "morrow:operator_grant:" + grant,
  ])
    assert.ok(!valid("OperatorEntitlementKey", bad), bad);
  // Never a payment, subscription or price key.
  for (const name of ["PaymentKey", "StripePaymentKey", "SubscriptionKey", "PriceKey"])
    assert.ok(!valid(name, key), name);
  const route = workspaceBillingRouteFromRow(rows.route);
  assert.equal(route.fixingPaymentKey, key);
  for (const change of [
    { mode: "live" },
    { origin: "shopify_install" },
    { shopify_bound_at: start },
    { route: "shopify_app_pricing" },
    { fixing_payment_key: "morrow:operator_entitlement:nope" },
  ])
    assert.throws(
      () => workspaceBillingRouteFromRow({ ...rows.route, ...change }),
      /BILLING_ROUTE_ROW_INVALID/,
      JSON.stringify(change),
    );
  const snapshot = snapshotFromRow(rows.snapshot);
  assert.equal(snapshot.subscriptionId, key);
  for (const change of [{ mode: "live" }, { route: "shopify_app_pricing" }])
    assert.throws(
      () => snapshotFromRow({ ...rows.snapshot, ...change }),
      /BILLING_FACTS_ROW_INVALID/,
      JSON.stringify(change),
    );
  // A Stripe-fixed route and snapshot are unchanged.
  assert.ok(
    workspaceBillingRouteFromRow({
      ...rows.route,
      mode: "live",
      fixing_payment_key: "stripe:invoice:in_" + "A".repeat(16),
    }),
  );
});

test("terms: one operator entry with no price or offer; checkout and offers never see it", () => {
  const document = parseTermsDocument(stagingTerms.terms, stagingTerms.offers);
  assert.deepEqual(document.offers, []);
  const [entry] = document.terms.entries;
  assert.deepEqual(entry, {
    route: "morrow_direct",
    mode: "test",
    priceKey: "morrow:operator_plan:beta",
    kind: "operator_test_entitlement",
    currency: "USD",
    creditUnits: "300",
  });
  assert.equal(subscriptionEntry(document.terms, entry.priceKey, "test"), null);
  const revision = {
    termsRevision: 1,
    terms: document.terms,
    offers: document.offers,
    digest: stagingTerms.digest,
  };
  assert.deepEqual(currentOffers(revision, "staging"), []);
  // An offer naming the operator entry is refused; so are a live, a priced, a second or a
  // Shopify operator entry.
  assert.throws(
    () =>
      parseTermsDocument(stagingTerms.terms, [
        {
          priceKey: "morrow:operator_plan:beta",
          unitAmount: "4900",
          currency: "USD",
          interval: "month",
        },
      ]),
    /BILLING_TERMS_INVALID/,
  );
  const withEntry = (change) => ({
    ...stagingTerms.terms,
    entries: [{ ...entry, ...change }],
  });
  for (const change of [
    { mode: "live" },
    { priceKey: "stripe:price:price_MorrowDevBeta0049" },
    { route: "shopify_app_pricing" },
    { currency: "EUR" },
  ])
    assert.throws(() => parseBillingTerms(withEntry(change)), /BILLING_INPUT_INVALID/);
  assert.throws(
    () =>
      parseBillingTerms({
        ...stagingTerms.terms,
        entries: [entry, { ...entry, creditUnits: "301" }],
      }),
    /BILLING_INPUT_INVALID/,
  );
  // A priced revision still needs its offer.
  assert.throws(
    () =>
      parseTermsDocument(
        { ...developmentTerms.terms, entries: [...developmentTerms.terms.entries, entry] },
        [],
      ),
    /BILLING_TERMS_INVALID/,
  );
  // Beside a priced entry (staging's revision once the Stripe switch is on), the offer is
  // the priced one alone.
  const both = parseTermsDocument(
    {
      ...developmentTerms.terms,
      entries: [...developmentTerms.terms.entries, entry],
    },
    developmentTerms.offers,
  );
  assert.deepEqual(
    currentOffers(
      { termsRevision: 1, terms: both.terms, offers: both.offers, digest: "a".repeat(64) },
      "development",
    ).map((o) => o.priceKey),
    [developmentTerms.offers[0].priceKey],
  );
});

test("the facts reader and the billing library: staging billable, production refused, no new subscription while it is active", async () => {
  const reader = createBillingFactsReader(async (name) => {
    const answers = {
      workspaceBillingRoute: [rows.route],
      billingAssociations: [],
      billingAccount: [rows.account],
      billingSnapshotLatest: [rows.snapshot],
      billingWallet: [rows.wallet],
      billingConflicts: [],
      billingIntentCurrent: [],
      billingPeriodLatest: [{ period_start: start, period_end: end }],
      billingSetupHold: [],
    };
    if (!Object.hasOwn(answers, name)) throw Error("UNEXPECTED " + name);
    return answers[name];
  });
  const scope = { organizationId: org, workspaceId: ws };
  const read = await reader.read(scope);
  assert.deepEqual(read.billingPeriod, { start, end });
  assert.equal(read.wallet.available, "300");
  const now = new Date().toISOString();
  const request = (storeId) => ({
    principal: { kind: "human", id: "person_operator" },
    capabilityId: "catalog.content.propose",
    verb: "execute",
    resource: { organizationId: org, workspaceId: ws, storeId, kind: "workspace", id: ws },
  });
  const staging = workspaceBillingState(
    parseWorkspaceBillingFacts(read.facts, scope, "staging"),
    now,
    "staging",
  );
  assert.equal(staging.phase, "morrow_direct");
  assert.equal(staging.state, "billable");
  assert.equal(staging.expiresAt, end);
  assert.equal(staging.payers[0].subscriptionKey, key);
  assert.ok(entitlementFor(staging, request(null), now));
  // No new subscription while it is active; the plan page only.
  assert.equal(purchaseDecision(staging, { action: "subscribe" }).allowed, false);
  // Production: the test route is refused (R9); nothing entitles.
  const production = workspaceBillingState(
    parseWorkspaceBillingFacts(read.facts, scope, "production"),
    now,
    "production",
  );
  assert.equal(production.state, "not_billable");
  assert.equal(production.payers[0].status, "mode_refused");
  assert.ok(!entitlementFor(production, request(null), now));
  // After its 30-day period the workspace is no longer billable (no renewal).
  const later = at(31);
  const expired = workspaceBillingState(
    parseWorkspaceBillingFacts(read.facts, scope, "staging"),
    later,
    "staging",
  );
  assert.equal(expired.state, "not_billable");
  assert.equal(expired.payers[0].status, "entitlement_stale");
});

test("the billing period statement reads an operator entitlement's snapshot period", () => {
  const text = billingStatements.billingPeriodLatest;
  assert.match(text, /FROM morrow_billing\.verified_payment_events v/);
  assert.match(text, /FROM morrow_billing\.entitlement_snapshots s/);
  assert.match(text, /s\.subscription_key ~ '\^morrow:operator_entitlement:'/);
  // The api role reads snapshot columns only by name, and never receipt_id.
  assert.doesNotMatch(text, /receipt_id/);
});
