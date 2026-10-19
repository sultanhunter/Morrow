import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { read } from "../scripts/foundation.mjs";
import { digest } from "../scripts/contract-checks.mjs";
import {
  billingValidators,
  units,
  money,
  allocationDigest,
  meterDigest,
  inspectAllocation,
  inspectUsage,
  inspectMeter,
  ContractCreditLedger,
  inspectPaidWork,
  paidWorkPredicate,
  permissionVerbs,
} from "../scripts/billing-checks.mjs";
import {
  isPaidWork,
  paidWorkCapabilityIds,
  paidWorkTableValid,
} from "../packages/policy/src/paid-work.ts";
import { validateCurrentBillingDefinition } from "../packages/contracts/src/validation.ts";
import {
  billingState,
  library,
  link,
  payerFacts,
  rawFacts,
  simulatorExample as currentExample,
} from "../scripts/billing-route-fixtures.mjs";

function example() {
  const f = structuredClone(read("docs/contracts/fixtures/P01.A04.json"));
  f.allocation.allocationDigest = allocationDigest(f.allocation);
  f.facts.approvedAllocationDigest = f.allocation.allocationDigest;
  return f;
}
// The reservation is created at 13:00; P01.A04's usage is observed at 13:01, so
// the ledger's clock moves to 13:05 before any settlement (P01.T04a §7).
const settleTime = "2026-10-06T13:05:00Z";
function ready() {
  const f = example(),
    ledger = new ContractCreditLedger(f.facts);
  ledger.reserve("reservation-1", f.allocation, f.vendorReservation);
  ledger.refresh({ now: settleTime });
  return { ...f, ledger };
}
function settled() {
  const f = ready();
  f.ledger.dispatch("reservation-1");
  f.ledger.settle("reservation-1", f.usage, {
    verifiedProviderEvidence: true,
    verifiedRateEvidence: true,
  });
  return f;
}
function meter(f) {
  const u = f.usage[0];
  const e = {
    schemaVersion: 1,
    id: "meter-1",
    usageLiabilityId: u.id,
    billingAccountId: u.billingAccountId,
    subscriptionId: f.facts.entitlements[u.billingAccountId].subscriptionId,
    meterKey: "agent-work",
    merchantCredits: u.merchantCredits,
    merchantLiability: u.merchantLiability,
    rateRevision: 1,
    payloadDigest: "0".repeat(64),
    status: "pending",
    attemptCount: 0,
    providerReceiptRef: null,
  };
  e.payloadDigest = meterDigest(e);
  return e;
}
test("credits remain exact above JavaScript safe integer range", () =>
  assert.equal(units("999999999999999999") - units("999999999999999998"), 1n));
test("monetary arithmetic preserves nanounits without floating point", () =>
  assert.equal(
    money({ amount: "0.1", currency: "USD" }) + money({ amount: "0.2", currency: "USD" }),
    money({ amount: "0.3", currency: "USD" }),
  ));
for (const value of [1, 1.5, -1, "-1", "1.0", "01", "1e3", "1000000000000000000", "NaN"])
  test("deny malformed credit units " + JSON.stringify(value), () =>
    assert.throws(() => units(value), /CREDIT_UNITS_INVALID/),
  );
for (const amount of [0.1, "-0.01", "1e2", "0.0000000001", "01", "Infinity"])
  test("deny malformed money " + JSON.stringify(amount), () =>
    assert.throws(() => money({ amount, currency: "USD" }), /MONEY_INVALID/),
  );

const denialCases = [
  ["missing spending grant", (f) => (f.facts.spendingGrant = false), "SPENDING_AUTHORITY_DENIED"],
  ["revoked membership", (f) => (f.facts.currentMembership = false), "SPENDING_AUTHORITY_DENIED"],
  ["unqualified provider", (f) => (f.facts.providerQualified = false), "PROVIDER_NOT_QUALIFIED"],
  ["unqualified prices", (f) => (f.facts.rateQualified = false), "RATE_NOT_QUALIFIED"],
  [
    "failed low-token margin admission",
    (f) => (f.facts.economicAdmission = false),
    "RATE_NOT_QUALIFIED",
  ],
  [
    "wrong workspace",
    (f) => (f.facts.workspaceId = "workspace-other"),
    "ALLOCATION_SCOPE_MISMATCH",
  ],
  ["wrong root run", (f) => (f.facts.rootRunId = "run-other"), "ALLOCATION_SCOPE_MISMATCH"],
  [
    "unapproved split",
    (f) => {
      f.allocation.shares[0].maximumCredits = "31";
      f.allocation.shares[1].maximumCredits = "19";
    },
    "ALLOCATION_REVIEW_CHANGED",
  ],
  ["rate revision change", (f) => (f.facts.rateRevision = 2), "RATE_CHANGED"],
  [
    "duplicate payer",
    (f) => (f.allocation.shares[1] = structuredClone(f.allocation.shares[0])),
    "DUPLICATE_PAYER_OR_STORE",
  ],
  [
    "incorrect share total",
    (f) => (f.allocation.maximumCredits = "51"),
    "ALLOCATION_TOTAL_MISMATCH",
  ],
  ["store outside grant", (f) => (f.facts.authorizedStoreIds = ["store-1"]), "PAYER_SCOPE_DENIED"],
  [
    "replaced installation",
    (f) => (f.facts.accounts["payer-2"].installationId = "installation-new"),
    "PAYER_SCOPE_DENIED",
  ],
  [
    "uninstalled account",
    (f) => (f.facts.accounts["payer-2"].status = "uninstalled"),
    "PAYER_INACTIVE",
  ],
  [
    "past due entitlement",
    (f) => (f.facts.entitlements["payer-2"].status = "past_due"),
    "PAYER_INACTIVE",
  ],
  [
    "stale entitlement",
    (f) => (f.facts.entitlementRevisions["payer-2"] = 2),
    "ENTITLEMENT_NOT_CURRENT",
  ],
  [
    "substituted entitlement evidence",
    (f) => (f.facts.entitlementEvidence["payer-2"] = "a".repeat(64)),
    "ENTITLEMENT_NOT_CURRENT",
  ],
  [
    "expired entitlement",
    (f) => (f.facts.entitlements["payer-2"].validUntil = f.facts.now),
    "ENTITLEMENT_EXPIRED",
  ],
  [
    "future entitlement evidence",
    (f) => (f.facts.entitlements["payer-2"].verifiedAt = "2026-10-07T00:00:00Z"),
    "ENTITLEMENT_EXPIRED",
  ],
  [
    "changed credit terms",
    (f) => (f.facts.wallets["payer-2"].termsRevision = 2),
    "WALLET_REVISION_CHANGED",
  ],
  [
    "insufficient last payer",
    (f) => (f.facts.wallets["payer-2"].available = "19"),
    "CREDITS_EXHAUSTED",
  ],
  [
    "currency substitution",
    (f) => (f.allocation.shares[0].maximumLiability.currency = "EUR"),
    "MONETARY_LIMIT_DENIED",
  ],
  [
    "money ceiling exceeded",
    (f) => (f.facts.monetaryCeilings["payer-1"].amount = "2.99"),
    "MONETARY_LIMIT_DENIED",
  ],
  [
    "client credential smuggling",
    (f) => (f.allocation.apiKey = "secret"),
    "ALLOCATION_SCHEMA_INVALID",
  ],
];
for (const [name, mutate, reason] of denialCases)
  test("allocation denies " + name, () => {
    const f = example();
    mutate(f);
    assert.ok(inspectAllocation(f.allocation, f.facts).includes(reason));
  });

test("all billing definitions are closed and accept representative shapes", () => {
  const f = ready(),
    r = f.ledger.snapshot().reservations[0].record,
    e = meter(f);
  const values = {
    CreditUnits: "50",
    BillingMoney: { amount: "1", currency: "USD" },
    BillingAccount: f.facts.accounts["payer-1"],
    EntitlementSnapshot: f.facts.entitlements["payer-1"],
    CreditWallet: f.facts.wallets["payer-1"],
    AllocationShare: f.allocation.shares[0],
    CostAllocation: f.allocation,
    CreditReservation: r,
    UsageLiability: f.usage[0],
    MeterEvent: e,
    CreditGrant: {
      schemaVersion: 1,
      id: "grant-1",
      billingAccountId: "payer-1",
      kind: "purchased",
      creditUnits: "100",
      termsRevision: 1,
      purchaseEvidenceRef: "a".repeat(64),
      effectiveAt: f.facts.now,
      expiresAt: null,
    },
    VendorCostReservation: f.vendorReservation,
  };
  for (const [key, value] of Object.entries(values)) {
    assert.equal(billingValidators[key](value), true, key);
    if (typeof value === "object")
      assert.equal(billingValidators[key]({ ...value, unexpected: true }), false, key);
  }
});
test("small brand reserves only its named installation", () => {
  const f = example();
  f.allocation.shares.splice(1);
  f.allocation.maximumCredits = "30";
  f.allocation.allocationDigest = allocationDigest(f.allocation);
  f.facts.approvedAllocationDigest = f.allocation.allocationDigest;
  const l = new ContractCreditLedger(f.facts);
  l.reserve("reservation-1", f.allocation, f.vendorReservation);
  assert.equal(l.snapshot().wallets["payer-1"].available, "70");
  assert.deepEqual(l.snapshot().wallets["payer-2"], f.facts.wallets["payer-2"]);
});
test("specialist multi-store allocation reserves both exact shares", () => {
  const f = ready(),
    s = f.ledger.snapshot();
  assert.equal(s.wallets["payer-1"].available, "70");
  assert.equal(s.wallets["payer-2"].available, "80");
  assert.equal(s.rootReserved, "50");
  assert.equal(s.vendorReserved, "1500000000");
});
test("failure at last payer leaves every balance unchanged", () => {
  const f = example();
  f.facts.wallets["payer-2"].available = "19";
  const l = new ContractCreditLedger(f.facts),
    before = l.snapshot();
  assert.throws(
    () => l.reserve("reservation-1", f.allocation, f.vendorReservation),
    /CREDITS_EXHAUSTED/,
  );
  assert.deepEqual(l.snapshot(), before);
});
test("vendor budget denial leaves credit wallets untouched", () => {
  const f = example();
  f.facts.vendorBudget.amount = "1";
  const l = new ContractCreditLedger(f.facts),
    before = l.snapshot();
  assert.throws(
    () => l.reserve("reservation-1", f.allocation, f.vendorReservation),
    /VENDOR_COST_LIMIT/,
  );
  assert.deepEqual(l.snapshot(), before);
});
test("vendor currency mismatch cannot be treated as an exchange rate", () => {
  const f = example();
  f.vendorReservation.maximumCost.currency = "EUR";
  const l = new ContractCreditLedger(f.facts);
  assert.throws(
    () => l.reserve("reservation-1", f.allocation, f.vendorReservation),
    /VENDOR_SCOPE_DENIED/,
  );
});
test("reservation replay never deducts twice and changed payload is denied", () => {
  const f = ready(),
    before = f.ledger.snapshot();
  f.ledger.reserve("reservation-1", f.allocation, f.vendorReservation);
  assert.deepEqual(f.ledger.snapshot(), before);
  f.vendorReservation.maximumCost.amount = "1.6";
  assert.throws(
    () => f.ledger.reserve("reservation-1", f.allocation, f.vendorReservation),
    /RESERVATION_REPLAY_CONFLICT/,
  );
  assert.deepEqual(f.ledger.snapshot(), before);
});
test("all child work consumes one root credit ceiling", () => {
  const f = ready();
  f.facts.rootMaximumCredits = "50";
  const l = new ContractCreditLedger(f.facts);
  l.reserve("reservation-1", f.allocation, f.vendorReservation);
  const a = structuredClone(f.allocation),
    v = structuredClone(f.vendorReservation);
  a.id = "allocation-2";
  a.allocationDigest = allocationDigest(a);
  v.id = "vendor-2";
  l.refresh({ approvedAllocationDigest: a.allocationDigest });
  const before = l.snapshot();
  assert.throws(() => l.reserve("reservation-2", a, v), /ROOT_CREDIT_LIMIT/);
  assert.deepEqual(l.snapshot(), before);
});
test("concurrent-intent admissions cannot exceed remaining payer money", () => {
  const f = ready();
  f.ledger.refresh({
    monetaryCeilings: {
      "payer-1": { amount: "5", currency: "USD" },
      "payer-2": { amount: "5", currency: "USD" },
    },
  });
  const a = structuredClone(f.allocation),
    v = structuredClone(f.vendorReservation);
  a.id = "allocation-2";
  a.allocationDigest = allocationDigest(a);
  v.id = "vendor-2";
  f.ledger.refresh({ approvedAllocationDigest: a.allocationDigest });
  const before = f.ledger.snapshot();
  assert.throws(() => f.ledger.reserve("reservation-2", a, v), /PAYER_MONETARY_LIMIT/);
  assert.deepEqual(f.ledger.snapshot(), before);
});
test("dispatch rechecks uninstall after successful reservation", () => {
  const f = ready();
  f.facts.accounts["payer-1"].status = "uninstalled";
  f.ledger.refresh({ accounts: f.facts.accounts });
  assert.throws(() => f.ledger.dispatch("reservation-1"), /PAYER_INACTIVE/);
  assert.equal(f.ledger.snapshot().rootReserved, "50");
});
test("unused reservation releases once after cancellation", () => {
  const f = ready();
  f.ledger.refresh({ spendingGrant: false });
  f.ledger.release("reservation-1");
  const s = f.ledger.snapshot();
  assert.equal(s.wallets["payer-1"].available, "100");
  assert.equal(s.rootReserved, "0");
  assert.equal(s.vendorReserved, "0");
  f.ledger.release("reservation-1");
  assert.deepEqual(f.ledger.snapshot(), s);
});
test("unknown submitted outcome retains credit and vendor reservations", () => {
  const f = ready();
  f.ledger.dispatch("reservation-1");
  f.ledger.uncertain("reservation-1");
  f.ledger.refresh({ spendingGrant: false });
  const before = f.ledger.snapshot();
  assert.throws(() => f.ledger.release("reservation-1"), /SUBMITTED_LIABILITY_RETAINED/);
  assert.deepEqual(f.ledger.snapshot(), before);
  assert.equal(before.rootReserved, "50");
  assert.equal(before.vendorReserved, "1500000000");
});
test("settlement needs rate and verified provider evidence", () => {
  const f = ready();
  f.ledger.dispatch("reservation-1");
  assert.throws(() => f.ledger.settle("reservation-1", f.usage), /SETTLEMENT_EVIDENCE_REQUIRED/);
  assert.equal(f.ledger.snapshot().rootConsumed, "0");
});
test("uncertain provider cost cannot masquerade as zero usage", () => {
  const f = ready();
  f.ledger.dispatch("reservation-1");
  f.usage[0].providerCost = null;
  f.usage[0].providerCostStatus = "uncertain";
  f.usage[0].status = "uncertain";
  assert.deepEqual(inspectUsage(f.usage[0]), []);
  assert.throws(
    () =>
      f.ledger.settle("reservation-1", f.usage, {
        verifiedProviderEvidence: true,
        verifiedRateEvidence: true,
      }),
    /USAGE_UNRECONCILED/,
  );
  assert.equal(f.ledger.snapshot().vendorReserved, "1500000000");
});
test("known provider cost requires a value", () => {
  const f = example();
  f.usage[0].providerCost = null;
  assert.ok(inspectUsage(f.usage[0]).includes("KNOWN_COST_MISSING"));
});
test("unknown cost cannot carry a fabricated zero", () => {
  const f = example();
  f.usage[0].providerCostStatus = "uncertain";
  f.usage[0].providerCost.amount = "0";
  assert.ok(inspectUsage(f.usage[0]).includes("UNCERTAIN_COST_MISREPRESENTED"));
});
test("settlement releases proven unused shares and records separate vendor cost", () => {
  const f = settled(),
    s = f.ledger.snapshot();
  assert.equal(s.wallets["payer-1"].available, "85");
  assert.equal(s.wallets["payer-1"].consumed, "15");
  assert.equal(s.wallets["payer-2"].available, "90");
  assert.equal(s.wallets["payer-2"].consumed, "10");
  assert.equal(s.rootConsumed, "25");
  assert.equal(s.rootReserved, "0");
  assert.equal(s.vendorConsumed, "300000000");
  assert.equal(s.vendorReserved, "0");
  assert.equal(s.payerMoney["payer-1"], "1500000000");
});
test("settlement replay cannot charge twice or rewrite historical usage", () => {
  const f = settled(),
    before = f.ledger.snapshot();
  f.ledger.settle("reservation-1", f.usage);
  assert.deepEqual(f.ledger.snapshot(), before);
  f.usage[0].merchantCredits = "16";
  assert.throws(() => f.ledger.settle("reservation-1", f.usage), /SETTLEMENT_REPLAY_CONFLICT/);
  assert.deepEqual(f.ledger.snapshot(), before);
});
test("revoked entitlement does not erase previously incurred liability", () => {
  const f = ready();
  f.ledger.dispatch("reservation-1");
  f.facts.entitlements["payer-1"].status = "cancelled";
  f.ledger.refresh({ entitlements: f.facts.entitlements, spendingGrant: false });
  f.ledger.uncertain("reservation-1");
  f.ledger.settle("reservation-1", f.usage, {
    verifiedProviderEvidence: true,
    verifiedRateEvidence: true,
  });
  assert.equal(f.ledger.snapshot().rootConsumed, "25");
});
for (const [name, change, reason] of [
  ["too many credits", (u) => (u[0].merchantCredits = "31"), "USAGE_EXCEEDS_RESERVATION"],
  [
    "too much merchant liability",
    (u) => (u[0].merchantLiability.amount = "3.01"),
    "USAGE_EXCEEDS_RESERVATION",
  ],
  [
    "too much provider cost",
    (u) => (u[0].providerCost.amount = "2"),
    "PROVIDER_COST_EXCEEDS_RESERVATION",
  ],
  [
    "wrong provider currency",
    (u) => (u[0].providerCost.currency = "EUR"),
    "PROVIDER_CURRENCY_MISMATCH",
  ],
  ["wrong reservation", (u) => (u[0].reservationId = "other"), "USAGE_BINDING_INVALID"],
  ["missing payer", (u) => u.pop(), "USAGE_PAYER_SET_INVALID"],
  ["duplicate usage id", (u) => (u[1].id = u[0].id), "DUPLICATE_USAGE"],
  ["future usage", (u) => (u[0].observedAt = "2027-01-01T00:00:00Z"), "USAGE_TIME_INVALID"],
])
  test("failed settlement is atomic: " + name, () => {
    const f = ready();
    f.ledger.dispatch("reservation-1");
    change(f.usage);
    const before = f.ledger.snapshot();
    assert.throws(
      () =>
        f.ledger.settle("reservation-1", f.usage, {
          verifiedProviderEvidence: true,
          verifiedRateEvidence: true,
        }),
      new RegExp(reason),
    );
    assert.deepEqual(f.ledger.snapshot(), before);
  });
test("returned snapshots and records cannot mutate ledger balances", () => {
  const f = ready();
  const s = f.ledger.snapshot();
  s.wallets["payer-1"].available = "999";
  s.reservations[0].record.status = "released";
  assert.equal(f.ledger.snapshot().wallets["payer-1"].available, "70");
  assert.equal(f.ledger.snapshot().reservations[0].record.status, "reserved");
});
test("meter event binds exact settled credits, liability and subscription", () => {
  const f = settled(),
    e = meter(f);
  assert.deepEqual(inspectMeter(e, f.usage[0], f.facts.entitlements["payer-1"]), []);
  e.merchantCredits = "16";
  assert.ok(
    inspectMeter(e, f.usage[0], f.facts.entitlements["payer-1"]).includes(
      "METER_LIABILITY_MISMATCH",
    ),
  );
});
test("unknown meter submission cannot get a new id or blind retry", () => {
  const f = settled(),
    e = meter(f);
  f.ledger.recordMeter(e);
  e.status = "submitted";
  e.attemptCount = 1;
  f.ledger.recordMeter(e);
  e.status = "uncertain";
  f.ledger.recordMeter(e);
  const before = f.ledger.snapshot();
  assert.throws(
    () =>
      f.ledger.recordMeter({
        ...e,
        id: "meter-2",
        payloadDigest: meterDigest({ ...e, id: "meter-2" }),
        status: "pending",
        attemptCount: 0,
      }),
    /METER_DUPLICATE_LIABILITY/,
  );
  assert.throws(
    () => f.ledger.recordMeter({ ...e, status: "submitted", attemptCount: 2 }),
    /METER_TRANSITION_DENIED/,
  );
  assert.deepEqual(f.ledger.snapshot(), before);
});
test("meter can reconcile an unknown result with the same immutable identity", () => {
  const f = settled(),
    e = meter(f);
  f.ledger.recordMeter(e);
  e.status = "submitted";
  e.attemptCount = 1;
  f.ledger.recordMeter(e);
  e.status = "uncertain";
  f.ledger.recordMeter(e);
  e.status = "accepted";
  e.providerReceiptRef = digest({ qualifiedReceipt: "fixture-only" });
  f.ledger.recordMeter(e);
  const before = f.ledger.snapshot();
  f.ledger.recordMeter(e);
  assert.deepEqual(f.ledger.snapshot(), before);
});
test("meter cannot change subscription or rate on retry", () => {
  const f = settled(),
    e = meter(f);
  f.ledger.recordMeter(e);
  e.subscriptionId = "subscription-other";
  e.payloadDigest = meterDigest(e);
  assert.throws(() => f.ledger.recordMeter(e), /METER_INVALID/);
});
test("accepted meter needs a receipt and a previous submission", () => {
  const f = settled(),
    e = meter(f);
  e.status = "accepted";
  e.attemptCount = 1;
  assert.ok(
    inspectMeter(e, f.usage[0], f.facts.entitlements["payer-1"]).includes("METER_RECEIPT_MISSING"),
  );
  e.providerReceiptRef = "a".repeat(64);
  assert.throws(() => f.ledger.recordMeter(e), /METER_DUPLICATE_LIABILITY/);
});

// P01.T04a AC01: the paid-work table (docs/contracts/paid-work.json), rules PW1-PW5.
const paidWork = read("docs/contracts/paid-work.json"),
  catalogue = read("docs/contracts/capabilities.json"),
  templates = read("docs/contracts/fixtures/P01.T04a.json").templates;
test("AC01: the paid-work table passes PW1-PW5", () =>
  assert.deepEqual(inspectPaidWork(paidWork, catalogue, templates), []));
test("AC01: execute is paid exactly on the paid-effect capabilities that are not kill switches (27 today)", () => {
  const expected = catalogue.capabilities
    .filter((c) => paidWork.paidEffects.includes(c.effect) && !c.kill_switch)
    .map((c) => c.id)
    .sort();
  assert.deepEqual([...paidWorkCapabilityIds], expected);
  assert.equal(expected.length, 27);
  assert.equal(
    catalogue.capabilities.filter((c) => paidWork.paidEffects.includes(c.effect)).length,
    28,
  );
  assert.ok(Object.isFrozen(paidWorkCapabilityIds));
});
test("AC01: an unknown capability is paid work (fail closed)", () => {
  for (const verb of permissionVerbs) assert.equal(isPaidWork("invented.capability", verb), true);
  assert.equal(isPaidWork("constructor", "view"), true);
  assert.equal(isPaidWork("__proto__", "view"), true);
});
test("AC01: the library and the reviewers' predicate agree on every catalogue pair", () => {
  const spec = paidWorkPredicate(paidWork, catalogue);
  for (const c of catalogue.capabilities)
    for (const verb of permissionVerbs)
      assert.equal(isPaidWork(c.id, verb), spec(c.id, verb), c.id + " " + verb);
});
for (const [name, change, expected] of [
  ["read added to paidEffects", (t) => t.paidEffects.push("read"), "PAID_WORK_TABLE_INVALID:PW4"],
  [
    "control added to paidEffects",
    (t) => t.paidEffects.push("control"),
    "PAID_WORK_TABLE_INVALID:PW4",
  ],
  [
    "billable_job dropped",
    (t) => t.paidEffects.splice(t.paidEffects.indexOf("billable_job"), 1),
    "PAID_WORK_TABLE_INVALID:PW3",
  ],
  [
    "spend dropped",
    (t) => t.paidEffects.splice(t.paidEffects.indexOf("spend"), 1),
    "PAID_WORK_TABLE_INVALID:PW3",
  ],
  ["execute never gated", (t) => t.neverGatedVerbs.push("execute"), "PAID_WORK_TABLE_INVALID:PW1"],
  [
    "administer never gated",
    (t) => t.neverGatedVerbs.push("administer"),
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
  [
    "view gated",
    (t) => t.neverGatedVerbs.splice(t.neverGatedVerbs.indexOf("view"), 1),
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
  [
    "an extra key",
    (t) => {
      t.killSwitchesPaid = true;
    },
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
  ["a duplicate effect", (t) => t.paidEffects.push("spend"), "PAID_WORK_TABLE_INVALID:PW1"],
  ["an unknown effect", (t) => t.paidEffects.push("model_call"), "PAID_WORK_TABLE_INVALID:PW1"],
  ["an unknown verb", (t) => t.neverGatedVerbs.push("connect"), "PAID_WORK_TABLE_INVALID:PW1"],
  [
    "a missing ADR",
    (t) => {
      t.adr = [];
    },
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
])
  test("AC01: the paid-work table rejects " + name, () => {
    const t = structuredClone(paidWork);
    change(t);
    assert.ok(
      inspectPaidWork(t, catalogue, templates).includes(expected),
      JSON.stringify(inspectPaidWork(t, catalogue, templates)),
    );
  });
// The library repeats PW1 at import, so a malformed table never loads (PAID_WORK_TABLE_INVALID).
test("AC01: the library accepts the reviewed table and rejects every PW1 failure", () => {
  assert.equal(paidWorkTableValid(paidWork), true);
  for (const [name, change] of [
    ["execute never gated", (t) => t.neverGatedVerbs.push("execute")],
    ["administer never gated", (t) => t.neverGatedVerbs.push("administer")],
    ["view gated", (t) => t.neverGatedVerbs.splice(t.neverGatedVerbs.indexOf("view"), 1)],
    ["approve gated", (t) => t.neverGatedVerbs.splice(t.neverGatedVerbs.indexOf("approve"), 1)],
    [
      "an extra key",
      (t) => {
        t.killSwitchesPaid = true;
      },
    ],
    [
      "a missing key",
      (t) => {
        delete t.adr;
      },
    ],
    [
      "schema version 2",
      (t) => {
        t.schema_version = 2;
      },
    ],
    ["a duplicate effect", (t) => t.paidEffects.push("spend")],
    ["an unknown effect", (t) => t.paidEffects.push("model_call")],
    [
      "a typo in an effect",
      (t) => {
        t.paidEffects[t.paidEffects.indexOf("billable_job")] = "billable-job";
      },
    ],
    ["an unknown verb", (t) => t.neverGatedVerbs.push("connect")],
    ["a duplicate verb", (t) => t.neverGatedVerbs.push("view")],
    [
      "a missing ADR",
      (t) => {
        t.adr = [];
      },
    ],
    [
      "a malformed ADR",
      (t) => {
        t.adr = ["ADR-15"];
      },
    ],
    [
      "a string of effects",
      (t) => {
        t.paidEffects = "spend";
      },
    ],
    [
      "a string of verbs",
      (t) => {
        t.neverGatedVerbs = "view";
      },
    ],
    [
      "no effects",
      (t) => {
        t.paidEffects = [];
      },
    ],
    ["a non-string effect", (t) => t.paidEffects.push(1)],
  ]) {
    const t = structuredClone(paidWork);
    change(t);
    assert.equal(paidWorkTableValid(t), false, name);
  }
  for (const value of [null, [], "table", 1])
    assert.equal(paidWorkTableValid(value), false, String(value));
});
test("AC01: kill switches are never paid (PW2); a spending kill switch is caught by PW3", () => {
  for (const c of catalogue.capabilities.filter((x) => x.kill_switch))
    for (const verb of permissionVerbs)
      assert.equal(isPaidWork(c.id, verb), false, c.id + " " + verb);
  const c = structuredClone(catalogue);
  c.capabilities.find((x) => x.id === "governance.membership.revoke").effect = "spend";
  assert.deepEqual(inspectPaidWork(paidWork, c, templates), ["PAID_WORK_TABLE_INVALID:PW3"]);
});
for (const id of ["owner-bootstrap-v1", "workspace-member-v1", "workspace-admin-v1"])
  test("AC01: a paid row added to " + id + " fails PW5", () => {
    const t = structuredClone(templates);
    t[id].push({
      capabilityId: "creative.image.generate",
      verbs: ["execute"],
      fields: ["briefRef"],
    });
    assert.deepEqual(inspectPaidWork(paidWork, catalogue, t), [
      "PAID_WORK_TABLE_INVALID:PW5:" + id,
    ]);
    const u = structuredClone(templates);
    u[id].push({ capabilityId: "invented.capability", verbs: ["view"], fields: ["x"] });
    assert.deepEqual(inspectPaidWork(paidWork, catalogue, u), [
      "PAID_WORK_TABLE_INVALID:PW5:" + id,
    ]);
  });
test("AC01: the three template lists must all be present", () => {
  const t = structuredClone(templates);
  delete t["workspace-admin-v1"];
  assert.deepEqual(inspectPaidWork(paidWork, catalogue, t), ["PAID_WORK_TABLE_INVALID:PW5"]);
});

// ---------------------------------------------------------------------------
// P01.T04a PR-B (§7): the simulator on contract v1.1 allocations. Routes, links,
// reversals, Shopify-route usage caps, grants through the billing library and
// USAGE_PREDATES_RESERVATION (AC12, AC18, AC22, AC24, AC25 simulator parts).
// ---------------------------------------------------------------------------
const L = library();
const morrowTarget = () => ({
  kind: "workspace",
  state: billingState(
    rawFacts({
      route: L.routes.morrow_direct,
      associations: [link("iA"), link("iB")],
      payers: [payerFacts("morrow_w")],
    }),
  ),
});
const usageFor = (x, credits, observedAt = "2026-10-20T10:01:00Z") => [
  {
    schemaVersion: 1,
    id: "usage_1",
    reservationId: "reservation-1",
    operationId: "operation_1",
    billingAccountId: x.allocation.shares[0].billingAccountId,
    merchantCredits: credits,
    merchantLiability: { amount: "1", currency: "USD" },
    providerCost: { amount: "0.2", currency: "USD" },
    providerCostStatus: "known",
    rateRevision: 1,
    observedAt,
    status: "reconciled",
  },
];
const settleOptions = { verifiedProviderEvidence: true, verifiedRateEvidence: true };

test("P01.T04a: a v1.1 morrow_direct allocation reserves, dispatches and settles", () => {
  const x = currentExample("morrow");
  assert.deepEqual(inspectAllocation(x.allocation, x.facts), []);
  const l = new ContractCreditLedger(x.facts);
  l.reserve("reservation-1", x.allocation, x.vendorReservation);
  l.dispatch("reservation-1");
  l.refresh({ now: "2026-10-20T10:05:00Z" });
  l.settle("reservation-1", usageFor(x, "20"), settleOptions);
  const s = l.snapshot();
  assert.equal(s.wallets.account_morrow_w.available, "80");
  assert.equal(s.wallets.account_morrow_w.consumed, "20");
  assert.deepEqual(s.meterDrafts, []);
});

test("AC12 (simulator): only a granted payment credits a wallet, once per payment key", () => {
  const x = currentExample("morrow", { target: morrowTarget() });
  const l = new ContractCreditLedger(x.facts);
  const before = l.snapshot();
  const event = (key, overrides = {}) => ({ ...structuredClone(L.events[key]), ...overrides });
  for (const [name, e, outcome] of [
    [
      "$0 invoice",
      event("stripe_period_next", { amountPaid: { amount: "0.00", currency: "USD" } }),
      "no_charge",
    ],
    [
      "test mode refused in production terms",
      event("stripe_period_next", { mode: "live" }),
      "refused",
    ],
    [
      "held for terms",
      event("stripe_period_next", { priceKey: "stripe:price:price_TESTUNKNOWN1" }),
      "held",
    ],
    ["cross-route payment", event("shopify_period_b"), "conflict"],
    [
      "duplicate subscription",
      event("stripe_period_next", { subscriptionKey: "stripe:sub:sub_TESTW00000002" }),
      "conflict",
    ],
  ]) {
    assert.equal(l.grant(e, L.terms).outcome, outcome, name);
    assert.deepEqual(l.snapshot(), before, name);
  }
  const granted = l.grant(event("stripe_period_next"), L.terms);
  assert.equal(granted.outcome, "grant");
  const after = l.snapshot();
  assert.equal(after.wallets.account_morrow_w.available, "1100");
  assert.equal(after.grants.length, 1);
  assert.equal(validateCurrentBillingDefinition("CreditGrant", after.grants[0]), true);
  assert.equal(l.grant(event("stripe_period_next"), L.terms).outcome, "already_granted");
  assert.deepEqual(l.snapshot(), after);
  // A top-up is a purchased grant on a billable morrow_direct payer.
  assert.equal(l.grant(event("stripe_top_up"), L.terms).grant.kind, "purchased");
  assert.equal(l.snapshot().wallets.account_morrow_w.available, "1500");
});

test("AC18 (simulator): an open reversal blocks the wallet it credited until it clears", () => {
  const x = currentExample("morrow", { target: morrowTarget() });
  const l = new ContractCreditLedger(x.facts);
  l.grant({ ...structuredClone(L.events.stripe_period_next) }, L.terms);
  const dispute = {
    ...structuredClone(L.reversals.dispute_morrow_open),
    paymentKey: L.events.stripe_period_next.paymentKey,
  };
  assert.deepEqual(l.reverse(dispute), {
    paymentKey: dispute.paymentKey,
    billingAccountId: "account_morrow_w",
    status: "open",
  });
  const before = l.snapshot();
  assert.throws(
    () => l.reserve("reservation-1", x.allocation, x.vendorReservation),
    /PAYER_INACTIVE/,
  );
  assert.deepEqual(l.snapshot(), before);
  assert.throws(() => l.reverse(dispute), /REVERSAL_REVISION_STALE/);
  l.reverse({ ...dispute, status: "cleared", revision: 2 });
  l.reserve("reservation-1", x.allocation, x.vendorReservation);
  // A reversal that lands after reservation stops dispatch.
  l.reverse({ ...dispute, status: "open", revision: 3 });
  assert.throws(() => l.dispatch("reservation-1"), /PAYER_INACTIVE/);
  // A reversal of a payment that granted nothing is recorded only.
  const y = currentExample("morrow", { target: morrowTarget() });
  const m = new ContractCreditLedger(y.facts);
  assert.equal(
    m.reverse({ ...dispute, paymentKey: "stripe:invoice:in_TESTW00000099" }).billingAccountId,
    null,
  );
  m.reserve("reservation-1", y.allocation, y.vendorReservation);
  assert.equal(m.snapshot().wallets.account_morrow_w.available, "70");
});

test("AC22 (simulator): a share whose route differs from the workspace route is refused", () => {
  for (const kind of ["morrow", "shopify"]) {
    const x = currentExample(kind);
    x.facts.accounts.account_morrow_w = structuredClone(L.accounts.morrow_w);
    x.facts.accounts.account_shopify_a = structuredClone(L.accounts.shopify_a);
    x.facts.entitlements.account_morrow_w = structuredClone(L.entitlements.morrow_w);
    x.facts.entitlements.account_shopify_a = structuredClone(L.entitlements.shopify_a);
    for (const id of ["account_morrow_w", "account_shopify_a"]) {
      x.facts.wallets[id] ??= {
        ...structuredClone(Object.values(x.facts.wallets)[0]),
        billingAccountId: id,
      };
      x.facts.monetaryCeilings[id] ??= { amount: "10", currency: "USD" };
    }
    const mixed = JSON.parse(
      readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8"),
    ).cases.find((c) => c.id === "P01.T04a.allocation.two_routes").value;
    assert.ok(inspectAllocation(mixed, x.facts).includes("PAYER_ROUTE_INVALID"), kind);
  }
  // A share in another mode than the environment's, and a route record of another mode.
  const x = currentExample("morrow");
  x.facts.environment = "production";
  assert.ok(inspectAllocation(x.allocation, x.facts).includes("PAYER_ROUTE_INVALID"));
  const y = currentExample("morrow");
  y.facts.routes = {};
  assert.ok(inspectAllocation(y.allocation, y.facts).includes("PAYER_ROUTE_INVALID"));
});

test("AC24 (simulator): no credits, cancellation and disconnects stop reservation or dispatch", () => {
  const empty = currentExample("morrow", { wallet: "0" });
  assert.throws(
    () =>
      new ContractCreditLedger(empty.facts).reserve(
        "reservation-1",
        empty.allocation,
        empty.vendorReservation,
      ),
    /CREDITS_EXHAUSTED/,
  );
  const x = currentExample("morrow");
  const l = new ContractCreditLedger(x.facts);
  l.reserve("reservation-1", x.allocation, x.vendorReservation);
  l.refresh({
    entitlements: { account_morrow_w: { ...L.entitlements.morrow_w, status: "cancelled" } },
  });
  assert.throws(() => l.dispatch("reservation-1"), /PAYER_INACTIVE/);
  // A Shopify share whose store's link is no longer current, and unlinked work stores.
  const s = currentExample("shopify");
  const m = new ContractCreditLedger(s.facts);
  m.reserve("reservation-1", s.allocation, s.vendorReservation);
  m.refresh({ links: [link("iA", { current: false }), link("iB")] });
  assert.throws(() => m.dispatch("reservation-1"), /PAYER_NOT_LINKED/);
  const w = currentExample("morrow");
  w.facts.workStoreIds = ["store_c"];
  assert.ok(inspectAllocation(w.allocation, w.facts).includes("PAYER_NOT_LINKED"));
});

test("AC25 (simulator): no retroactive charge, and Shopify extra credits are post-paid within a cap", () => {
  const x = currentExample("morrow", { target: morrowTarget() });
  const l = new ContractCreditLedger(x.facts);
  l.reserve("reservation-1", x.allocation, x.vendorReservation);
  const before = l.snapshot();
  // A link refresh changes no reservation, liability, meter event or wallet.
  l.refresh({ links: [link("iA"), link("iB"), link("iC")] });
  assert.deepEqual(l.snapshot(), before);
  l.dispatch("reservation-1");
  l.refresh({ now: "2026-10-20T10:05:00Z" });
  const dispatched = l.snapshot();
  assert.throws(
    () => l.settle("reservation-1", usageFor(x, "20", "2026-10-20T09:59:00Z"), settleOptions),
    /USAGE_PREDATES_RESERVATION/,
  );
  assert.deepEqual(l.snapshot(), dispatched);
  // Fixing a route creates no liability for earlier usage.
  const open = currentExample("morrow", {
    target: { kind: "workspace", state: billingState(rawFacts({ route: L.routes.open })) },
  });
  const o = new ContractCreditLedger(open.facts);
  const fixed = o.grant(structuredClone(L.events.stripe_period), L.terms);
  assert.equal(fixed.outcome, "fix_route_and_grant");
  const snapshot = o.snapshot();
  assert.deepEqual(
    [snapshot.reservations, snapshot.meterDrafts, snapshot.meterEvents],
    [[], [], []],
  );
  // A Shopify payer with an empty wallet: no cap, no reservation.
  const s = currentExample("shopify", { wallet: "0" });
  assert.throws(
    () =>
      new ContractCreditLedger(s.facts).reserve("reservation-1", s.allocation, s.vendorReservation),
    /CREDITS_EXHAUSTED/,
  );
  s.facts.usageCaps = { account_shopify_a: structuredClone(L.usageCaps.shopify_a) };
  const m = new ContractCreditLedger(s.facts);
  m.reserve("reservation-1", s.allocation, s.vendorReservation);
  assert.equal(m.snapshot().capUsed.account_shopify_a, "30");
  assert.equal(m.snapshot().wallets.account_shopify_a.available, "0");
  const second = structuredClone(s.allocation);
  second.id = "allocation_2";
  second.allocationDigest = allocationDigest(second);
  m.refresh({ approvedAllocationDigest: second.allocationDigest });
  const vendor = { ...s.vendorReservation, id: "vendor_reservation_2" };
  const capped = m.snapshot();
  assert.throws(() => m.reserve("reservation-2", second, vendor), /USAGE_CAP_EXCEEDED/);
  assert.deepEqual(m.snapshot(), capped);
  // Settlement drafts a liability and a meter event on the cycle's subscription; no grant.
  m.refresh({ approvedAllocationDigest: s.allocation.allocationDigest });
  m.dispatch("reservation-1");
  m.refresh({ now: "2026-10-20T10:05:00Z" });
  m.settle("reservation-1", usageFor(s, "20"), settleOptions);
  const settled = m.snapshot();
  assert.deepEqual(settled.meterDrafts, [
    {
      usageLiabilityId: "usage_1",
      billingAccountId: "account_shopify_a",
      subscriptionId: L.usageCaps.shopify_a.subscriptionKey,
      meterKey: "agent-work",
      periodStart: L.usageCaps.shopify_a.periodStart,
      merchantCredits: "20",
      merchantLiability: { amount: "1", currency: "USD" },
      status: "pending",
    },
  ]);
  assert.deepEqual(settled.grants, []);
  assert.equal(settled.capUsed.account_shopify_a, "20");
  assert.equal(settled.wallets.account_shopify_a.available, "0");
  // A cap bound to another subscription is no cap; a morrow_direct payer never has one.
  const t = currentExample("shopify", { wallet: "0" });
  t.facts.usageCaps = {
    account_shopify_a: {
      ...L.usageCaps.shopify_a,
      subscriptionKey: L.entitlements.shopify_b.subscriptionId,
    },
  };
  assert.ok(inspectAllocation(t.allocation, t.facts).includes("CREDITS_EXHAUSTED"));
  const capCases = JSON.parse(readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8")).cases;
  for (const id of ["usage_cap.morrow_direct_account", "usage_cap.non_usd"])
    assert.equal(
      validateCurrentBillingDefinition(
        "UsageCap",
        capCases.find((c) => c.id === "P01.T04a." + id).value,
      ),
      false,
      id,
    );
});
