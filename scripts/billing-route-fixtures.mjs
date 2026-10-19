// P01.T04a PR-B: builders over the `library` section of
// docs/contracts/fixtures/P01.T04a.json, shared by scripts/verify-billing.mjs and
// the billing tests. They assemble the raw facts a trusted billing reader would
// return (§6, §8.8); the billing library is the only implementation that reads
// them. Runs under tsx.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./foundation.mjs";
import {
  parseWorkspaceBillingFacts,
  workspaceBillingState,
} from "../packages/policy/src/billing-state.ts";
import { allocationDigest } from "./billing-checks.mjs";

export const routeFixturePath = "docs/contracts/fixtures/P01.T04a.json";
const fixture = JSON.parse(readFileSync(resolve(root, routeFixturePath), "utf8"));
const base = fixture.library;

/** A fresh, mutable copy of the fixture's library section. */
export const library = () => structuredClone(base);
export const templates = () => structuredClone(fixture.templates);
export const scopeW = Object.freeze({
  organizationId: base.organizationId,
  workspaceId: base.workspaceId,
});
export const scopeW2 = Object.freeze({
  organizationId: base.organizationId,
  workspaceId: base.otherWorkspaceId,
});

/** A copy of a record (or of every record in an array) in `live` mode, for production cases. */
export function live(value) {
  const copy = structuredClone(value);
  const visit = (node) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      if (node.mode === "test") node.mode = "live";
      for (const child of Object.values(node)) if (child && typeof child === "object") visit(child);
    }
  };
  visit(copy);
  return copy;
}

const associationFor = (installationId) =>
  Object.values(base.associations).find((a) => a.installationId === installationId) ?? null;

/**
 * One payer's facts from the library's account `key` ("morrow_w", "shopify_a", ...).
 * Overrides replace the account, entitlement, association or reversals; the
 * association defaults to the account's installation.
 */
export function payerFacts(key, overrides = {}) {
  const account =
    overrides.account === undefined ? structuredClone(base.accounts[key]) : overrides.account;
  const entitlement =
    overrides.entitlement === undefined
      ? structuredClone(base.entitlements[key])
      : overrides.entitlement;
  const association =
    overrides.association === undefined
      ? account?.installationId
        ? structuredClone(associationFor(account.installationId))
        : null
      : overrides.association;
  return { account, entitlement, association, openReversals: overrides.openReversals ?? [] };
}

/**
 * Raw facts as the reader returns them. A payer's association is synchronised
 * with the workspace association of the same installation, as the reader's
 * join would give it.
 */
export function rawFacts({
  route = base.routes.open,
  associations = [],
  payers = [],
  conflicts = [],
  checkoutIntentPending = false,
  testSeed = null,
} = {}) {
  const links = structuredClone(associations);
  return {
    route: structuredClone(route),
    associations: links,
    payers: payers.map((p) => ({
      ...structuredClone(p),
      association:
        p.association === null
          ? null
          : (structuredClone(
              links.find((a) => a.installationId === p.association.installationId),
            ) ?? structuredClone(p.association)),
    })),
    conflicts: structuredClone(conflicts),
    checkoutIntentPending,
    testSeed: structuredClone(testSeed),
  };
}

/** Parses raw facts for `scope` and derives the state at `now` in `environment`. */
export function billingState(
  raw,
  { environment = "staging", now = base.now, scope = scopeW } = {},
) {
  return workspaceBillingState(
    parseWorkspaceBillingFacts(raw, scope, environment),
    now,
    environment,
  );
}

/** An association copy with overrides, e.g. `link("iA", { current: false })`. */
export const link = (key, overrides = {}) => ({
  ...structuredClone(base.associations[key]),
  ...overrides,
});
/**
 * An association of the morrow_direct workspace: linked after its route was
 * fixed at t0, the only order R2 and R3 allow (the facts parser refuses an
 * older one).
 */
export const directLink = (key, overrides = {}) => ({
  ...structuredClone(base.directAssociations[key]),
  ...overrides,
});

const simulatorPayers = {
  morrow: ["morrow_w"],
  shopify: ["shopify_a", "shopify_b"],
};
/**
 * Simulator facts, a one-share CostAllocation@2 and a vendor reservation for a
 * morrow_direct (`morrow`) or Shopify-route (`shopify`) workspace with iA and iB
 * linked (after the route on morrow_direct), for `ContractCreditLedger`
 * (scripts/billing-checks.mjs, §7).
 */
export function simulatorExample(
  kind,
  { wallet = "100", target = null, environment = "staging" } = {},
) {
  const keys = simulatorPayers[kind];
  const byId = (pick) =>
    Object.fromEntries(keys.map((k) => [base.accounts[k].id, structuredClone(pick(k))]));
  const facts = {
    now: base.now,
    organizationId: "org_o",
    workspaceId: "workspace_w",
    rootRunId: "run_1",
    taskId: "task_1",
    authenticated: true,
    currentMembership: true,
    spendingGrant: true,
    providerQualified: true,
    rateQualified: true,
    economicAdmission: true,
    rateRevision: 1,
    termsRevision: 1,
    meterKey: "agent-work",
    authorizedStoreIds: ["store_a", "store_b"],
    rootMaximumCredits: "500",
    vendorId: "openai",
    costScheduleRevision: 1,
    vendorBudget: { amount: "50", currency: "USD" },
    accounts: byId((k) => base.accounts[k]),
    entitlements: byId((k) => base.entitlements[k]),
    entitlementRevisions: byId(() => 1),
    entitlementEvidence: byId((k) => base.entitlements[k].providerEvidenceRef),
    wallets: byId((k) => ({
      schemaVersion: 1,
      billingAccountId: base.accounts[k].id,
      available: wallet,
      reserved: "0",
      consumed: "0",
      rateRevision: 1,
      termsRevision: 1,
      revision: 1,
    })),
    monetaryCeilings: byId(() => ({ amount: "10", currency: "USD" })),
    environment,
    routes: {
      workspace_w: structuredClone(
        kind === "morrow" ? base.routes.morrow_direct : base.routes.shopify_app_pricing,
      ),
    },
    links: kind === "morrow" ? [directLink("iA"), directLink("iB")] : [link("iA"), link("iB")],
    workStoreIds: [],
    usageCaps: {},
  };
  if (target) facts.paymentTarget = target;
  const account = base.accounts[keys[0]];
  const allocation = {
    schemaVersion: 2,
    id: "allocation_1",
    organizationId: "org_o",
    workspaceId: "workspace_w",
    taskId: "task_1",
    rootRunId: "run_1",
    revision: 1,
    rateRevision: 1,
    meterKey: "agent-work",
    maximumCredits: "30",
    shares: [
      {
        billingAccountId: account.id,
        installationId: account.installationId,
        storeId: account.storeId,
        entitlementRevision: 1,
        maximumCredits: "30",
        maximumLiability: { amount: "3.00", currency: "USD" },
      },
    ],
    allocationDigest: "0".repeat(64),
  };
  allocation.allocationDigest = allocationDigest(allocation);
  facts.approvedAllocationDigest = allocation.allocationDigest;
  const vendorReservation = {
    schemaVersion: 1,
    id: "vendor_reservation_1",
    rootRunId: "run_1",
    vendorId: "openai",
    costScheduleRevision: 1,
    maximumCost: { amount: "1.5", currency: "USD" },
    status: "reserved",
  };
  return { facts, allocation, vendorReservation };
}
