// M5 PR-1: the SQL billing facts reader's row mappers and the terms module
// (packages/work/src/billing/facts.ts, terms.ts). Every row maps to the v1.1 billing
// definitions (BillingAccount@2, EntitlementSnapshot@2, CreditWallet@1) or fails closed;
// the reader checks every row against the scope and yields the parseWorkspaceBillingFacts
// input plus the billing period M3 keys its ledger on. The terms file's revisions parse,
// keep their published digests and price the beta at USD 49 with 300 credits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountFromRow,
  associationFromRow,
  conflictFromRow,
  createBillingFactsReader,
  intentFromRow,
  parseTermsDocument,
  periodFromRow,
  snapshotFromRow,
  subscriptionEntry,
  termsDocumentDigest,
  termsFromRow,
  walletFromRow,
} from "../packages/work/src/billing/index.ts";
import {
  createBillingConstraintsReader,
  parseWorkspaceBillingFacts,
  workspaceBillingState,
} from "../packages/policy/src/billing-state.ts";
import { validateCurrentBillingDefinition } from "../packages/contracts/src/validation.ts";

const org = "org_facts";
const ws = "ws_facts";
const account = "00000000-0000-4000-8000-0000000000a1";
const later = (days) => new Date(Date.now() + days * 86400000).toISOString();
const rows = {
  route: {
    organization_id: org,
    workspace_id: ws,
    origin: "website",
    shopify_bound_at: null,
    route: "morrow_direct",
    mode: "test",
    route_fixed_at: later(-1),
    fixing_payment_key: "stripe:invoice:in_" + "A".repeat(16),
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
    subscription_key: "stripe:sub:sub_" + "B".repeat(16),
    status: "active",
    provider_evidence_ref: "c".repeat(64),
    verified_at: later(-1),
    valid_until: later(29),
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
  period: { period_start: later(-1), period_end: later(29) },
  intent: {
    id: "00000000-0000-4000-8000-0000000000b1",
    status: "open",
    price_key: "stripe:price:price_MorrowDevBeta0049",
    expires_at: later(0.04),
  },
};

test("row mappers yield the v1.1 billing definitions and refuse any other shape", () => {
  const a = accountFromRow(rows.account);
  assert.ok(validateCurrentBillingDefinition("BillingAccount", a));
  assert.equal(a.schemaVersion, 2);
  assert.equal(a.installationId, null);
  const s = snapshotFromRow(rows.snapshot);
  assert.ok(validateCurrentBillingDefinition("EntitlementSnapshot", s));
  assert.equal(s.subscriptionId, rows.snapshot.subscription_key);
  const w = walletFromRow(rows.wallet);
  assert.ok(validateCurrentBillingDefinition("CreditWallet", w.wallet));
  assert.equal(w.wallet.available, "300");
  assert.deepEqual(periodFromRow(rows.period), {
    start: rows.period.period_start,
    end: rows.period.period_end,
  });
  assert.equal(intentFromRow(rows.intent).status, "open");
  for (const [map, row] of [
    [accountFromRow, { ...rows.account, extra: 1 }],
    [accountFromRow, { ...rows.account, revision: "0" }],
    [accountFromRow, { ...rows.account, currency: "usd" }],
    [snapshotFromRow, { ...rows.snapshot, status: "billable" }],
    [snapshotFromRow, { ...rows.snapshot, subscription_key: "sub_x" }],
    [walletFromRow, { ...rows.wallet, available: "-1" }],
    [walletFromRow, { ...rows.wallet, available: 300 }],
    [periodFromRow, { period_start: later(1), period_end: later(0) }],
    [intentFromRow, { ...rows.intent, status: "expired" }],
    [intentFromRow, { ...rows.intent, price_key: "price_x" }],
    [
      conflictFromRow,
      {
        route: "shopify_app_pricing",
        subscription_key: "stripe:sub:sub_" + "B".repeat(16),
        code: "ROUTE_MISMATCH",
      },
    ],
    [
      conflictFromRow,
      {
        route: "morrow_direct",
        subscription_key: "stripe:sub:sub_" + "B".repeat(16),
        code: "OTHER",
      },
    ],
    [
      associationFromRow,
      {
        installation_id: "i",
        store_id: "s",
        connection_id: "c",
        status: "gone",
        linked_at: later(-1),
      },
    ],
  ])
    assert.throws(() => map(row), /BILLING_FACTS_ROW_INVALID/, JSON.stringify(row));
  // Associations: only `linked` is current (the M2 bridge's statuses).
  for (const [status, current] of [
    ["linked", true],
    ["unlinked", false],
    ["suspended", false],
    ["uninstalled", false],
  ])
    assert.equal(
      associationFromRow({
        installation_id: "inst_1",
        store_id: "store_1",
        connection_id: "conn_1",
        status,
        linked_at: later(-1),
      }).current,
      current,
    );
});

function reader(overrides = {}) {
  const calls = [];
  const answers = {
    workspaceBillingRoute: [rows.route],
    billingAssociations: [],
    billingAccount: [rows.account],
    billingSnapshotLatest: [rows.snapshot],
    billingWallet: [rows.wallet],
    billingConflicts: [],
    billingIntentCurrent: [],
    billingPeriodLatest: [rows.period],
    ...overrides,
  };
  return {
    calls,
    reader: createBillingFactsReader(async (name, values) => {
      calls.push([name, values]);
      if (!Object.hasOwn(answers, name)) throw Error("UNEXPECTED " + name);
      return answers[name];
    }),
  };
}

test("the reader: the facts input, the wallet and the billing period; any foreign row fails closed", async () => {
  const scope = { organizationId: org, workspaceId: ws };
  const { reader: r, calls } = reader();
  const read = await r.read(scope);
  assert.deepEqual(read.billingPeriod, {
    start: rows.period.period_start,
    end: rows.period.period_end,
  });
  assert.equal(read.wallet.available, "300");
  assert.equal(read.facts.payers.length, 1);
  assert.equal(read.facts.testSeed, null);
  // Every statement names the scope's workspace only (the tenant is current_tenant()).
  assert.ok(calls.every(([, values]) => values.every((v) => v === ws || v === account)));
  const state = workspaceBillingState(
    parseWorkspaceBillingFacts(read.facts, scope, "development"),
    new Date().toISOString(),
    "development",
  );
  assert.equal(state.phase, "morrow_direct");
  assert.equal(state.state, "billable");
  // The facts reader M3 consumes through createBillingConstraintsReader.
  assert.equal(typeof createBillingConstraintsReader, "function");
  assert.deepEqual(await r.facts(scope), read.facts);
  // Before the route is fixed: no payer, no period.
  const open = await reader({
    workspaceBillingRoute: [
      {
        ...rows.route,
        route: null,
        mode: null,
        route_fixed_at: null,
        fixing_payment_key: null,
        revision: "1",
      },
    ],
    billingAccount: [],
    billingPeriodLatest: [],
    billingIntentCurrent: [rows.intent],
  }).reader.read(scope);
  assert.equal(open.facts.payers.length, 0);
  assert.equal(open.billingPeriod, null);
  assert.equal(open.facts.checkoutIntentPending, true);
  for (const overrides of [
    { workspaceBillingRoute: [{ ...rows.route, workspace_id: "ws_other" }] },
    { billingAccount: [{ ...rows.account, organization_id: "org_other" }] },
    {
      billingSnapshotLatest: [
        { ...rows.snapshot, billing_account_id: "00000000-0000-4000-8000-0000000000ff" },
      ],
    },
    { billingWallet: [{ ...rows.wallet, workspace_id: "ws_other" }] },
    { billingAccount: [rows.account, rows.account] },
    { billingAssociations: Array(101).fill({}) },
  ])
    await assert.rejects(
      reader(overrides).reader.read(scope),
      /BILLING_FACTS_ROW_INVALID/,
      JSON.stringify(Object.keys(overrides)),
    );
  await assert.rejects(
    reader().reader.read({ organizationId: org, workspaceId: "bad id" }),
    /BILLING_FACTS_ROW_INVALID/,
  );
});

test("terms: the published revisions parse, keep their digests and price the beta at USD 49 / 300 credits", async () => {
  const file = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8"));
  const [revision] = file.environments.development;
  const document = parseTermsDocument(revision.terms, revision.offers);
  assert.equal(await termsDocumentDigest(revision.terms, revision.offers), revision.digest);
  const entry = subscriptionEntry(document.terms, "stripe:price:price_MorrowDevBeta0049", "test");
  assert.deepEqual(
    [entry.route, entry.kind, entry.currency, entry.creditUnits, entry.mode],
    ["morrow_direct", "subscription_period", "USD", "300", "test"],
  );
  assert.equal(document.offers[0].unitAmount, "4900");
  assert.equal(
    subscriptionEntry(document.terms, "stripe:price:price_MorrowDevBeta0049", "live"),
    null,
  );
  assert.equal(subscriptionEntry(document.terms, "stripe:price:price_Other00000001", "test"), null);
  // The digest moves with any change, so a published revision cannot change silently.
  const changed = structuredClone(revision);
  changed.terms.entries[0].creditUnits = "301";
  assert.notEqual(await termsDocumentDigest(changed.terms, changed.offers), revision.digest);
  // Offers are closed, monthly, in whole minor units, and name a subscription entry.
  for (const offers of [
    [],
    [{ ...revision.offers[0], interval: "year" }],
    [{ ...revision.offers[0], unitAmount: "49.00" }],
    [{ ...revision.offers[0], priceKey: "stripe:price:price_Other00000001" }],
    [{ ...revision.offers[0], currency: "EUR" }],
    [{ ...revision.offers[0], extra: 1 }],
    [revision.offers[0], revision.offers[0]],
  ])
    assert.throws(() => parseTermsDocument(revision.terms, offers), /BILLING_TERMS_INVALID/);
  // The row the api reads.
  const row = {
    terms_revision: "1",
    terms: JSON.stringify(revision.terms),
    offers: JSON.stringify(revision.offers),
    digest: revision.digest,
  };
  assert.equal(termsFromRow(row).termsRevision, 1);
  for (const bad of [
    { ...row, terms_revision: "2" },
    { ...row, digest: "x" },
    { ...row, extra: "1" },
    { ...row, terms: "{" },
  ])
    assert.throws(() => termsFromRow(bad), /BILLING_TERMS_INVALID/);
  // Staging has no revision until the owner's test-mode Price; production none until M6.
  assert.deepEqual(file.environments.staging, []);
  assert.deepEqual(file.environments.production, []);
});
