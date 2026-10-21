import { ajv, digest } from "./contract-checks.mjs";
import { read } from "./foundation.mjs";
// P01.T04a §7: the simulator runs under tsx and uses the billing library as the
// only implementation of payment classification, and the generated v1.1
// validators for the route records.
import { classifyPayment } from "../packages/policy/src/billing-state.ts";
import { validateCurrentBillingDefinition } from "../packages/contracts/src/validation.ts";

export const billing = read("docs/contracts/schemas/v1/billing.schema.json");
ajv.addSchema(billing);
export const billingValidators = Object.fromEntries(
  Object.keys(billing.$defs).map((k) => [k, ajv.compile({ $ref: billing.$id + "#/$defs/" + k })]),
);
const assert = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
export function units(value) {
  assert(billingValidators.CreditUnits(value), "CREDIT_UNITS_INVALID");
  return BigInt(value);
}
export function money(value) {
  assert(billingValidators.BillingMoney(value), "MONEY_INVALID");
  const [whole, fraction = ""] = value.amount.split(".");
  return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
}
// The exact decimal amount of a non-negative nanounit total (the inverse of `money`).
const amountOf = (nanos) => {
  const fraction = (nanos % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
  return (nanos / 1000000000n).toString() + (fraction ? "." + fraction : "");
};
/** One cycle of a Shopify payer's UsageCap: its account, subscription and period start. */
export const capCycleKey = (cap) =>
  `${cap.billingAccountId}|${cap.subscriptionKey}|${cap.periodStart}`;
export const allocationDigest = (allocation) => {
  const { allocationDigest, ...payload } = allocation;
  return digest(payload);
};
export const meterDigest = (event) => {
  const { payloadDigest, status, attemptCount, providerReceiptRef, ...payload } = event;
  return digest(payload);
};
const sameScope = (a, b) =>
  a.organizationId === b.organizationId && a.workspaceId === b.workspaceId;
const matchesPayer = (a, b) =>
  a.billingAccountId === b.id && a.installationId === b.installationId && a.storeId === b.storeId;
const validTime = (value) => Number.isFinite(Date.parse(value));

// Trusted facts in these examples are fixture inputs, never a browser/model authority claim.
// A CostAllocation@2 (contract v1.1, P01.T04a §7) also needs `facts.environment`,
// `facts.routes[workspaceId]` and `facts.links` (the workspace's associations):
// a share whose account route or mode disagrees with the workspace route or the
// environment gives PAYER_ROUTE_INVALID, a share or work store
// (`facts.workStoreIds`) that is not currently linked gives PAYER_NOT_LINKED,
// and a payer with an open reversal (`facts.reversals[accountId]`) gives
// PAYER_INACTIVE. On a Shopify payer, credits beyond the wallet are reserved only
// within the cycle's UsageCap (`facts.usageCaps[accountId]`): its credits less
// `facts.capUsed[capCycleKey(cap)]`, and its USD liability less
// `facts.capLiability[capCycleKey(cap)]`, where a share that draws on the cap
// counts its whole `maximumLiability` (settlement meters that share's whole
// liability). Each cycle (account, subscription, period start) has its own
// usage. P01.A04's frozen v1 rows read as Shopify-route arithmetic and keep
// their v1 checks.
const v11 = (name, value) => validateCurrentBillingDefinition(name, value);
const modeOf = (environment) =>
  environment === "production"
    ? "live"
    : environment === "development" || environment === "staging"
      ? "test"
      : null;
const currentLink = (links, share, now) =>
  Array.isArray(links) &&
  links.some(
    (l) =>
      l.storeId === share.storeId &&
      (share.installationId === undefined || l.installationId === share.installationId) &&
      l.current === true &&
      Date.parse(l.associatedAt) <= Date.parse(now),
  );
export function inspectAllocation(allocation, facts, { checkAvailable = true } = {}) {
  const errors = [];
  const current = allocation?.schemaVersion === 2;
  if (current ? !v11("CostAllocation", allocation) : !billingValidators.CostAllocation(allocation))
    return ["ALLOCATION_SCHEMA_INVALID"];
  if (!validTime(facts.now)) return ["SERVER_TIME_INVALID"];
  if (!facts.authenticated || !facts.currentMembership || !facts.spendingGrant)
    errors.push("SPENDING_AUTHORITY_DENIED");
  if (!facts.providerQualified) errors.push("PROVIDER_NOT_QUALIFIED");
  if (!facts.rateQualified || !facts.economicAdmission) errors.push("RATE_NOT_QUALIFIED");
  if (
    !sameScope(allocation, facts) ||
    allocation.rootRunId !== facts.rootRunId ||
    allocation.taskId !== facts.taskId
  )
    errors.push("ALLOCATION_SCOPE_MISMATCH");
  if (
    allocation.allocationDigest !== allocationDigest(allocation) ||
    allocation.allocationDigest !== facts.approvedAllocationDigest
  )
    errors.push("ALLOCATION_REVIEW_CHANGED");
  if (allocation.rateRevision !== facts.rateRevision || allocation.meterKey !== facts.meterKey)
    errors.push("RATE_CHANGED");
  const storeShares = allocation.shares.filter((s) => s.storeId !== null);
  if (
    new Set(allocation.shares.map((s) => s.billingAccountId)).size !== allocation.shares.length ||
    new Set(storeShares.map((s) => s.storeId)).size !== storeShares.length
  )
    errors.push("DUPLICATE_PAYER_OR_STORE");
  if (
    allocation.shares.reduce((sum, s) => sum + units(s.maximumCredits), 0n) !==
    units(allocation.maximumCredits)
  )
    errors.push("ALLOCATION_TOTAL_MISMATCH");
  const mode = modeOf(facts.environment);
  const route = current ? facts.routes?.[allocation.workspaceId] : null;
  if (current) {
    if (
      mode === null ||
      !v11("WorkspaceBillingRoute", route) ||
      route.route === null ||
      route.mode !== mode ||
      !sameScope(route, allocation)
    )
      errors.push("PAYER_ROUTE_INVALID");
    for (const storeId of facts.workStoreIds ?? [])
      if (!currentLink(facts.links, { storeId }, facts.now)) errors.push("PAYER_NOT_LINKED");
  }
  for (const share of allocation.shares) {
    const account = facts.accounts?.[share.billingAccountId],
      entitlement = facts.entitlements?.[share.billingAccountId],
      wallet = facts.wallets?.[share.billingAccountId];
    if (
      !(current ? v11("BillingAccount", account) : billingValidators.BillingAccount(account)) ||
      !(current
        ? v11("EntitlementSnapshot", entitlement)
        : billingValidators.EntitlementSnapshot(entitlement)) ||
      !billingValidators.CreditWallet(wallet)
    ) {
      errors.push("PAYER_FACTS_INVALID");
      continue;
    }
    if (
      !sameScope(account, allocation) ||
      !matchesPayer(share, account) ||
      (share.storeId !== null && !facts.authorizedStoreIds?.includes(share.storeId))
    )
      errors.push("PAYER_SCOPE_DENIED");
    if (current) {
      // R5, R6, R9: one route, its own mode, and a share's store currently linked.
      if (
        route?.route !== account.route ||
        account.mode !== mode ||
        entitlement.mode !== mode ||
        entitlement.route !== account.route
      )
        errors.push("PAYER_ROUTE_INVALID");
      if (share.storeId !== null && !currentLink(facts.links, share, facts.now))
        errors.push("PAYER_NOT_LINKED");
    }
    // R11: an open reversal makes the payer non-billable while the provider reports active.
    if ((facts.reversals?.[account.id] ?? []).some((r) => r.status === "open"))
      errors.push("PAYER_INACTIVE");
    if (account.status !== "active" || entitlement.status !== "active")
      errors.push("PAYER_INACTIVE");
    if (
      !sameScope(entitlement, account) ||
      !matchesPayer(entitlement, account) ||
      entitlement.revision !== share.entitlementRevision ||
      entitlement.revision !== facts.entitlementRevisions?.[account.id] ||
      entitlement.providerEvidenceRef !== facts.entitlementEvidence?.[account.id]
    )
      errors.push("ENTITLEMENT_NOT_CURRENT");
    if (
      Date.parse(entitlement.verifiedAt) > Date.parse(facts.now) ||
      Date.parse(entitlement.validUntil) <= Date.parse(facts.now) ||
      Date.parse(entitlement.validUntil) <= Date.parse(entitlement.verifiedAt)
    )
      errors.push("ENTITLEMENT_EXPIRED");
    if (
      wallet.billingAccountId !== account.id ||
      wallet.rateRevision !== allocation.rateRevision ||
      wallet.termsRevision !== facts.termsRevision
    )
      errors.push("WALLET_REVISION_CHANGED");
    if (checkAvailable && units(share.maximumCredits) > units(wallet.available)) {
      // R10: Shopify-route extra credits are post-paid usage within a Morrow cap.
      const cap =
        current && account.route === "shopify_app_pricing"
          ? usageCapFor(facts, account, entitlement)
          : null;
      if (cap === null) errors.push("CREDITS_EXHAUSTED");
      else {
        const cycle = capCycleKey(cap);
        const liabilityUsed = money({
          amount: facts.capLiability?.[cycle] ?? "0",
          currency: cap.maximumLiability.currency,
        });
        if (
          units(share.maximumCredits) - units(wallet.available) >
            units(cap.maximumCredits) - units(facts.capUsed?.[cycle] ?? "0") ||
          share.maximumLiability.currency !== cap.maximumLiability.currency ||
          money(share.maximumLiability) > money(cap.maximumLiability) - liabilityUsed
        )
          errors.push("USAGE_CAP_EXCEEDED");
      }
    }
    const ceiling = facts.monetaryCeilings?.[account.id];
    if (
      !billingValidators.BillingMoney(ceiling) ||
      account.currency !== share.maximumLiability.currency ||
      ceiling?.currency !== account.currency ||
      money(share.maximumLiability) > money(ceiling)
    )
      errors.push("MONETARY_LIMIT_DENIED");
  }
  return [...new Set(errors)];
}
// The cycle's cap: bound to the payer's account, installation, store and current subscription.
function usageCapFor(facts, account, entitlement) {
  const cap = facts.usageCaps?.[account.id];
  return v11("UsageCap", cap) &&
    cap.billingAccountId === account.id &&
    cap.installationId === account.installationId &&
    cap.storeId === account.storeId &&
    cap.subscriptionKey === entitlement.subscriptionId &&
    sameScope(cap, account)
    ? cap
    : null;
}

export function inspectUsage(usage) {
  if (!billingValidators.UsageLiability(usage)) return ["USAGE_SCHEMA_INVALID"];
  if (usage.providerCostStatus === "known" && usage.providerCost === null)
    return ["KNOWN_COST_MISSING"];
  if (
    usage.providerCostStatus === "uncertain" &&
    (usage.providerCost !== null || usage.status !== "uncertain")
  )
    return ["UNCERTAIN_COST_MISREPRESENTED"];
  if (usage.status === "reconciled" && usage.providerCostStatus !== "known")
    return ["UNRECONCILED_PROVIDER_COST"];
  return [];
}
export function inspectMeter(event, usage, entitlement) {
  if (
    !billingValidators.MeterEvent(event) ||
    inspectUsage(usage).length ||
    !billingValidators.EntitlementSnapshot(entitlement)
  )
    return ["METER_INPUT_INVALID"];
  const errors = [];
  if (event.payloadDigest !== meterDigest(event)) errors.push("METER_PAYLOAD_CHANGED");
  if (
    event.usageLiabilityId !== usage.id ||
    event.billingAccountId !== usage.billingAccountId ||
    event.billingAccountId !== entitlement.billingAccountId ||
    event.subscriptionId !== entitlement.subscriptionId ||
    event.rateRevision !== usage.rateRevision ||
    event.merchantCredits !== usage.merchantCredits ||
    digest(event.merchantLiability) !== digest(usage.merchantLiability)
  )
    errors.push("METER_LIABILITY_MISMATCH");
  if (usage.status !== "reconciled") errors.push("USAGE_NOT_RECONCILED");
  if (event.status === "accepted" && event.providerReceiptRef === null)
    errors.push("METER_RECEIPT_MISSING");
  if (event.status === "pending" && event.attemptCount !== 0) errors.push("METER_ATTEMPT_INVALID");
  if (event.status !== "pending" && event.attemptCount === 0) errors.push("METER_ATTEMPT_INVALID");
  return [...new Set(errors)];
}

// Deterministic P01 review model. Production requires transactions, durable records,
// authorization services, leases and verified provider readback in later packages.
// P01.T04a §7 adds `grant(event, terms)` (payment classification through the billing
// library, one wallet credit per (route, mode, paymentKey)), `reverse(reversal)`,
// Shopify-route post-paid usage within a UsageCap, and USAGE_PREDATES_RESERVATION.
export class ContractCreditLedger {
  #facts;
  #target = null;
  #reservations = new Map();
  #usedUsageIds = new Set();
  #usedOperations = new Set();
  #meterEvents = new Map();
  #rootReserved = 0n;
  #rootConsumed = 0n;
  #vendorReserved = 0n;
  #vendorConsumed = 0n;
  #payerMoney = new Map();
  #capUsed = new Map();
  #capLiability = new Map();
  #grantedKeys = new Map();
  #grants = [];
  #reversals = new Map();
  #meterDrafts = [];
  constructor(facts) {
    assert(validTime(facts.now), "SERVER_TIME_INVALID");
    units(facts.rootMaximumCredits);
    money(facts.vendorBudget);
    assert(
      Number.isSafeInteger(facts.costScheduleRevision) && facts.costScheduleRevision > 0,
      "COST_SCHEDULE_INVALID",
    );
    const { paymentTarget = null, ...rest } = facts;
    // The payment target holds a library-issued state, kept by reference.
    this.#target = paymentTarget;
    this.#facts = structuredClone(rest);
  }
  snapshot() {
    return structuredClone({
      wallets: this.#facts.wallets,
      reservations: [...this.#reservations.values()],
      rootReserved: this.#rootReserved.toString(),
      rootConsumed: this.#rootConsumed.toString(),
      vendorReserved: this.#vendorReserved.toString(),
      vendorConsumed: this.#vendorConsumed.toString(),
      payerMoney: Object.fromEntries([...this.#payerMoney].map(([k, v]) => [k, v.toString()])),
      capUsed: Object.fromEntries([...this.#capUsed].map(([k, v]) => [k, v.toString()])),
      capLiability: Object.fromEntries([...this.#capLiability].map(([k, v]) => [k, amountOf(v)])),
      meterEvents: [...this.#meterEvents.values()],
      grants: this.#grants,
      meterDrafts: this.#meterDrafts,
    });
  }
  // Simulates fresh trusted server facts; callers cannot grant authority through payloads.
  refresh(facts) {
    const allowed = [
      "now",
      "authenticated",
      "currentMembership",
      "spendingGrant",
      "providerQualified",
      "rateQualified",
      "economicAdmission",
      "accounts",
      "entitlements",
      "entitlementRevisions",
      "entitlementEvidence",
      "authorizedStoreIds",
      "approvedAllocationDigest",
      "rateRevision",
      "meterKey",
      "termsRevision",
      "monetaryCeilings",
      "environment",
      "routes",
      "links",
      "workStoreIds",
      "usageCaps",
      "paymentTarget",
    ];
    assert(
      Object.keys(facts).every((k) => allowed.includes(k)),
      "REFRESH_FIELD_DENIED",
    );
    const { paymentTarget, ...rest } = facts;
    if (paymentTarget !== undefined) this.#target = paymentTarget;
    this.#facts = { ...this.#facts, ...structuredClone(rest) };
  }
  // The facts every allocation check reads: the ledger's own reversals, each
  // attached at check time to the payer its payment credited (so a reversal
  // verified before its payment's grant blocks that payer once the grant
  // lands), and post-paid usage per cap cycle.
  #current() {
    const reversals = {};
    for (const reversal of this.#reversals.values()) {
      const accountId = this.#grantedKeys.get(reversal.paymentKey);
      if (accountId !== undefined) (reversals[accountId] ??= []).push(reversal);
    }
    return {
      ...this.#facts,
      reversals,
      capUsed: Object.fromEntries([...this.#capUsed].map(([k, v]) => [k, v.toString()])),
      capLiability: Object.fromEntries([...this.#capLiability].map(([k, v]) => [k, amountOf(v)])),
    };
  }
  reserve(id, allocation, vendorReservation) {
    assert(
      billingValidators.CreditReservation({
        schemaVersion: 1,
        id,
        allocationId: allocation?.id,
        allocationDigest: allocation?.allocationDigest,
        rootRunId: allocation?.rootRunId,
        status: "reserved",
        createdAt: this.#facts.now,
        settledUsageDigest: null,
      }),
      "RESERVATION_SCHEMA_INVALID",
    );
    assert(
      billingValidators.VendorCostReservation(vendorReservation),
      "VENDOR_RESERVATION_INVALID",
    );
    const existing = this.#reservations.get(id);
    if (existing) {
      assert(
        digest(existing.allocation) === digest(allocation) &&
          digest(existing.vendorOriginal) === digest(vendorReservation),
        "RESERVATION_REPLAY_CONFLICT",
      );
      return structuredClone(existing.record);
    }
    const errors = inspectAllocation(allocation, this.#current());
    assert(!errors.length, errors.join(","));
    assert(
      vendorReservation.status === "reserved" &&
        vendorReservation.rootRunId === allocation.rootRunId &&
        vendorReservation.vendorId === this.#facts.vendorId &&
        vendorReservation.costScheduleRevision === this.#facts.costScheduleRevision &&
        vendorReservation.maximumCost.currency === this.#facts.vendorBudget.currency,
      "VENDOR_SCOPE_DENIED",
    );
    assert(
      ![...this.#reservations.values()].some((r) => r.vendorOriginal.id === vendorReservation.id),
      "VENDOR_RESERVATION_REUSED",
    );
    const credits = units(allocation.maximumCredits),
      cost = money(vendorReservation.maximumCost);
    assert(
      this.#rootReserved + this.#rootConsumed + credits <= units(this.#facts.rootMaximumCredits),
      "ROOT_CREDIT_LIMIT",
    );
    assert(
      this.#vendorReserved + this.#vendorConsumed + cost <= money(this.#facts.vendorBudget),
      "VENDOR_COST_LIMIT",
    );
    for (const share of allocation.shares)
      assert(
        (this.#payerMoney.get(share.billingAccountId) ?? 0n) + money(share.maximumLiability) <=
          money(this.#facts.monetaryCeilings[share.billingAccountId]),
        "PAYER_MONETARY_LIMIT",
      );
    for (const share of allocation.shares) {
      const w = this.#facts.wallets[share.billingAccountId];
      assert(
        units(w.available) + units(w.reserved) + units(w.consumed) <= 999999999999999999n &&
          w.revision < Number.MAX_SAFE_INTEGER - 1,
        "WALLET_RANGE_INVALID",
      );
    }
    // All checks finish before any payer is changed. The wallet pays first; only
    // a Shopify payer's cap (checked above) covers the rest, as post-paid usage.
    const split = [];
    for (const share of allocation.shares) {
      const w = this.#facts.wallets[share.billingAccountId],
        credits = units(share.maximumCredits),
        fromWallet = credits <= units(w.available) ? credits : units(w.available),
        fromCap = credits - fromWallet;
      w.available = (units(w.available) - fromWallet).toString();
      w.reserved = (units(w.reserved) + fromWallet).toString();
      w.revision++;
      // The cycle inspectAllocation checked; a later cycle starts at zero.
      const cycle =
        fromCap > 0n ? capCycleKey(this.#facts.usageCaps[share.billingAccountId]) : null;
      if (cycle !== null) {
        this.#capUsed.set(cycle, (this.#capUsed.get(cycle) ?? 0n) + fromCap);
        this.#capLiability.set(
          cycle,
          (this.#capLiability.get(cycle) ?? 0n) + money(share.maximumLiability),
        );
      }
      split.push({
        billingAccountId: share.billingAccountId,
        fromWallet: fromWallet.toString(),
        fromCap: fromCap.toString(),
        cycle,
      });
      this.#payerMoney.set(
        share.billingAccountId,
        (this.#payerMoney.get(share.billingAccountId) ?? 0n) + money(share.maximumLiability),
      );
    }
    this.#rootReserved += credits;
    this.#vendorReserved += cost;
    const record = {
      schemaVersion: 1,
      id,
      allocationId: allocation.id,
      allocationDigest: allocation.allocationDigest,
      rootRunId: allocation.rootRunId,
      status: "reserved",
      createdAt: this.#facts.now,
      settledUsageDigest: null,
    };
    const entitlements = Object.fromEntries(
      allocation.shares.map((s) => [
        s.billingAccountId,
        this.#facts.entitlements[s.billingAccountId],
      ]),
    );
    const caps = Object.fromEntries(
      allocation.shares.map((s) => [
        s.billingAccountId,
        this.#facts.usageCaps?.[s.billingAccountId] ?? null,
      ]),
    );
    this.#reservations.set(
      id,
      structuredClone({
        record,
        allocation,
        vendorOriginal: vendorReservation,
        entitlements,
        caps,
        split,
      }),
    );
    return structuredClone(record);
  }
  #get(id) {
    const r = this.#reservations.get(id);
    assert(r, "RESERVATION_NOT_FOUND");
    return r;
  }
  dispatch(id) {
    const r = this.#get(id);
    assert(r.record.status === "reserved", "DISPATCH_STATE_INVALID");
    const errors = inspectAllocation(r.allocation, this.#current(), { checkAvailable: false });
    assert(!errors.length, errors.join(","));
    r.record.status = "dispatched";
    return structuredClone(r.record);
  }
  uncertain(id) {
    const r = this.#get(id);
    assert(["dispatched", "uncertain"].includes(r.record.status), "UNCERTAIN_STATE_INVALID");
    r.record.status = "uncertain";
    return structuredClone(r.record);
  }
  release(id) {
    const r = this.#get(id);
    if (r.record.status === "released") return structuredClone(r.record);
    assert(r.record.status === "reserved", "SUBMITTED_LIABILITY_RETAINED");
    this.#applySettlement(
      r,
      r.allocation.shares.map((s) => ({
        billingAccountId: s.billingAccountId,
        merchantCredits: "0",
        merchantLiability: { currency: s.maximumLiability.currency, amount: "0" },
      })),
      0n,
    );
    r.record.status = "released";
    return structuredClone(r.record);
  }
  settle(id, usage, { verifiedProviderEvidence = false, verifiedRateEvidence = false } = {}) {
    const r = this.#get(id);
    assert(Array.isArray(usage), "USAGE_LIST_INVALID");
    const usageDigest = digest(usage);
    if (r.record.status === "settled") {
      assert(r.record.settledUsageDigest === usageDigest, "SETTLEMENT_REPLAY_CONFLICT");
      return structuredClone(r.record);
    }
    assert(["dispatched", "uncertain"].includes(r.record.status), "SETTLEMENT_STATE_INVALID");
    assert(verifiedProviderEvidence && verifiedRateEvidence, "SETTLEMENT_EVIDENCE_REQUIRED");
    assert(
      usage.length === r.allocation.shares.length &&
        new Set(usage.map((u) => u.billingAccountId)).size === usage.length,
      "USAGE_PAYER_SET_INVALID",
    );
    let actualCost = 0n;
    const ids = new Set(),
      operations = new Set();
    for (const u of usage) {
      assert(
        !inspectUsage(u).length && u.status === "reconciled" && u.providerCostStatus === "known",
        "USAGE_UNRECONCILED",
      );
      const share = r.allocation.shares.find((s) => s.billingAccountId === u.billingAccountId);
      assert(
        share && u.reservationId === id && u.rateRevision === r.allocation.rateRevision,
        "USAGE_BINDING_INVALID",
      );
      assert(
        u.merchantLiability.currency === share.maximumLiability.currency &&
          units(u.merchantCredits) <= units(share.maximumCredits) &&
          money(u.merchantLiability) <= money(share.maximumLiability),
        "USAGE_EXCEEDS_RESERVATION",
      );
      assert(
        u.providerCost.currency === r.vendorOriginal.maximumCost.currency,
        "PROVIDER_CURRENCY_MISMATCH",
      );
      assert(
        validTime(u.observedAt) && Date.parse(u.observedAt) <= Date.parse(this.#facts.now),
        "USAGE_TIME_INVALID",
      );
      // No retroactive charge: usage observed before the reservation existed is not its usage.
      assert(
        Date.parse(u.observedAt) >= Date.parse(r.record.createdAt),
        "USAGE_PREDATES_RESERVATION",
      );
      const operationKey = u.billingAccountId + ":" + u.operationId;
      assert(
        !ids.has(u.id) &&
          !this.#usedUsageIds.has(u.id) &&
          !operations.has(operationKey) &&
          !this.#usedOperations.has(operationKey),
        "DUPLICATE_USAGE",
      );
      ids.add(u.id);
      operations.add(operationKey);
      actualCost += money(u.providerCost);
    }
    assert(actualCost <= money(r.vendorOriginal.maximumCost), "PROVIDER_COST_EXCEEDS_RESERVATION");
    this.#applySettlement(r, usage, actualCost);
    for (const key of ids) this.#usedUsageIds.add(key);
    for (const key of operations) this.#usedOperations.add(key);
    r.record.status = "settled";
    r.record.settledUsageDigest = usageDigest;
    r.usage = structuredClone(usage);
    return structuredClone(r.record);
  }
  #applySettlement(r, usage, actualCost) {
    for (const u of usage)
      assert(
        this.#facts.wallets[u.billingAccountId].revision < Number.MAX_SAFE_INTEGER,
        "WALLET_REVISION_EXHAUSTED",
      );
    let actualCredits = 0n;
    for (const u of usage) {
      const s = r.allocation.shares.find((s) => s.billingAccountId === u.billingAccountId),
        part = r.split.find((p) => p.billingAccountId === u.billingAccountId),
        w = this.#facts.wallets[u.billingAccountId];
      const fromWallet = units(part.fromWallet),
        fromCap = units(part.fromCap),
        used = units(u.merchantCredits),
        walletUsed = used <= fromWallet ? used : fromWallet,
        capUsed = used - walletUsed;
      actualCredits += used;
      w.available = (units(w.available) + fromWallet - walletUsed).toString();
      w.reserved = (units(w.reserved) - fromWallet).toString();
      w.consumed = (units(w.consumed) + walletUsed).toString();
      w.revision++;
      if (fromCap > 0n) {
        // Settled against the cycle the reservation drew on, even after a refresh.
        this.#capUsed.set(part.cycle, this.#capUsed.get(part.cycle) - fromCap + capUsed);
        this.#capLiability.set(
          part.cycle,
          this.#capLiability.get(part.cycle) -
            money(s.maximumLiability) +
            (capUsed > 0n ? money(u.merchantLiability) : 0n),
        );
      }
      // Post-paid usage settles as a liability and a meter event bound to the
      // cycle's subscription and meter, never as a CreditGrant (R10).
      if (capUsed > 0n) {
        const cap = r.caps[u.billingAccountId];
        this.#meterDrafts.push({
          usageLiabilityId: u.id,
          billingAccountId: u.billingAccountId,
          subscriptionId: cap.subscriptionKey,
          meterKey: cap.meterKey,
          periodStart: cap.periodStart,
          merchantCredits: capUsed.toString(),
          merchantLiability: structuredClone(u.merchantLiability),
          status: "pending",
        });
      }
      this.#payerMoney.set(
        u.billingAccountId,
        this.#payerMoney.get(u.billingAccountId) -
          money(s.maximumLiability) +
          money(u.merchantLiability),
      );
    }
    this.#rootReserved -= units(r.allocation.maximumCredits);
    this.#rootConsumed += actualCredits;
    this.#vendorReserved -= money(r.vendorOriginal.maximumCost);
    this.#vendorConsumed += actualCost;
  }
  // R10: applies the billing library's classifyPayment with the ledger's own key
  // set. Only `grant` and `fix_route_and_grant` credit a wallet, once per
  // (route, mode, paymentKey); replays, held payments, no-charge events,
  // conflicts and refusals leave every wallet unchanged.
  grant(event, terms) {
    assert(this.#target !== null, "PAYMENT_TARGET_REQUIRED");
    const outcome = classifyPayment(this.#target, event, terms, new Set(this.#grantedKeys.keys()));
    if (outcome.outcome !== "grant" && outcome.outcome !== "fix_route_and_grant") return outcome;
    const account = outcome.account;
    const accountId =
      account.kind === "existing"
        ? account.billingAccountId
        : "account:" + (account.installationId ?? event.workspaceId);
    const w = (this.#facts.wallets[accountId] ??= {
      schemaVersion: 1,
      billingAccountId: accountId,
      available: "0",
      reserved: "0",
      consumed: "0",
      rateRevision: this.#facts.rateRevision,
      termsRevision: outcome.grant.termsRevision,
      revision: 1,
    });
    w.available = (units(w.available) + units(outcome.grant.creditUnits)).toString();
    w.revision++;
    this.#grantedKeys.set(outcome.paymentKey, accountId);
    this.#grants.push({
      ...structuredClone(outcome.grant),
      id: "grant-" + (this.#grants.length + 1),
      billingAccountId: accountId,
    });
    return outcome;
  }
  // R11: records a verified refund or dispute by its payment key. While it is
  // open, the payer its payment credited cannot reserve, including when the
  // reversal was verified before the payment was granted (webhooks arrive in no
  // order); a reversal of a payment that is never granted blocks no payer. The
  // result names the payer credited so far (null before any grant).
  reverse(reversal) {
    assert(v11("PaymentReversal", reversal), "REVERSAL_INVALID");
    const prior = this.#reversals.get(reversal.paymentKey);
    assert(!prior || reversal.revision > prior.revision, "REVERSAL_REVISION_STALE");
    this.#reversals.set(reversal.paymentKey, structuredClone(reversal));
    return {
      paymentKey: reversal.paymentKey,
      billingAccountId: this.#grantedKeys.get(reversal.paymentKey) ?? null,
      status: reversal.status,
    };
  }
  recordMeter(event) {
    const r = [...this.#reservations.values()].find((r) =>
      r.usage?.some((u) => u.id === event.usageLiabilityId),
    );
    const usage = r?.usage.find((u) => u.id === event.usageLiabilityId);
    const entitlement = r?.entitlements[event.billingAccountId];
    assert(!inspectMeter(event, usage, entitlement).length, "METER_INVALID");
    assert(event.meterKey === r.allocation.meterKey, "METER_KEY_CHANGED");
    const prior = this.#meterEvents.get(event.id);
    if (prior) {
      assert(prior.payloadDigest === event.payloadDigest, "METER_REPLAY_CONFLICT");
      if (digest(prior) === digest(event)) return structuredClone(prior);
      const allowed = {
        pending: ["submitted"],
        submitted: ["uncertain", "accepted", "rejected"],
        uncertain: ["accepted", "rejected"],
        accepted: [],
        rejected: [],
      };
      assert(allowed[prior.status].includes(event.status), "METER_TRANSITION_DENIED");
      assert(
        event.attemptCount ===
          (prior.status === "pending" ? prior.attemptCount + 1 : prior.attemptCount),
        "METER_ATTEMPT_CHANGED",
      );
    } else {
      assert(
        event.status === "pending" &&
          ![...this.#meterEvents.values()].some(
            (e) => e.usageLiabilityId === event.usageLiabilityId,
          ),
        "METER_DUPLICATE_LIABILITY",
      );
    }
    this.#meterEvents.set(event.id, structuredClone(event));
    return structuredClone(event);
  }
}

// P01.T04a §1: the paid-work table (docs/contracts/paid-work.json). This predicate
// is the reviewers' specification, written independently of
// packages/policy/src/paid-work.ts; tests/billing.test.mjs compares the two over
// every catalogue (capability, verb) pair. Failures: PAID_WORK_TABLE_INVALID:<rule>.
export const capabilityEffects = [
  "read",
  "internal_write",
  "external_write",
  "spend",
  "communication",
  "control",
  "billable_job",
];
export const permissionVerbs = ["view", "propose", "approve", "execute", "delegate", "administer"];
// M5 PR-1: owner-bootstrap-v2 (ADR-0022 item 3) is the signup template from 0028 on; v1 stays
// recorded for the signups made before it.
export const grantTemplateIds = [
  "owner-bootstrap-v1",
  "owner-bootstrap-v2",
  "workspace-member-v1",
  "workspace-admin-v1",
];
export function paidWorkPredicate(table, catalogue) {
  const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c])),
    effects = new Set(table.paidEffects),
    free = new Set(table.neverGatedVerbs);
  return (id, verb) => {
    const c = capabilities.get(id);
    if (!c) return true;
    if (c.kill_switch) return false;
    return effects.has(c.effect) && !free.has(verb);
  };
}
export function inspectPaidWork(table, catalogue, templates) {
  const errors = [],
    fail = (rule) => errors.push("PAID_WORK_TABLE_INVALID:" + rule);
  const members = (value, allowed) =>
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((x) => allowed.includes(x));
  // PW1: closed object; unique enum members; execute and administer always gated; reads and approvals never (ADR-0015 item 5).
  if (
    !table ||
    typeof table !== "object" ||
    Array.isArray(table) ||
    Object.keys(table).sort().join() !== "adr,neverGatedVerbs,paidEffects,schema_version" ||
    table.schema_version !== 1 ||
    !Array.isArray(table.adr) ||
    !table.adr.length ||
    new Set(table.adr).size !== table.adr.length ||
    !table.adr.every((a) => typeof a === "string" && /^ADR-\d{4}$/.test(a)) ||
    !members(table.paidEffects, capabilityEffects) ||
    !members(table.neverGatedVerbs, permissionVerbs) ||
    table.neverGatedVerbs.some((v) => ["execute", "administer"].includes(v)) ||
    !["view", "approve"].every((v) => table.neverGatedVerbs.includes(v))
  ) {
    fail("PW1");
    return errors;
  }
  const paid = paidWorkPredicate(table, catalogue);
  // PW2: no kill switch is paid for any verb (ADR-0011 Q8).
  if (
    catalogue.capabilities.some((c) => c.kill_switch && permissionVerbs.some((v) => paid(c.id, v)))
  )
    fail("PW2");
  // PW3: every capability whose execute carries budget_reservation is paid.
  if (
    catalogue.capabilities.some(
      (c) => ["spend", "billable_job"].includes(c.effect) && !paid(c.id, "execute"),
    )
  )
    fail("PW3");
  // PW4: no read, internal_write or control capability is paid (linking, exports, privacy, billing management).
  if (
    catalogue.capabilities.some(
      (c) =>
        ["read", "internal_write", "control"].includes(c.effect) &&
        permissionVerbs.some((v) => paid(c.id, v)),
    )
  )
    fail("PW4");
  // PW5: no row of the ADR grant templates is paid with its template verbs.
  if (
    !templates ||
    typeof templates !== "object" ||
    Object.keys(templates).sort().join() !== [...grantTemplateIds].sort().join()
  )
    fail("PW5");
  else
    for (const id of grantTemplateIds)
      if (
        !Array.isArray(templates[id]) ||
        !templates[id].length ||
        templates[id].some(
          (r) =>
            !Array.isArray(r?.verbs) ||
            !r.verbs.length ||
            r.verbs.some((v) => paid(r.capabilityId, v)),
        )
      )
        fail("PW5:" + id);
  return errors;
}
