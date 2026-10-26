import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, read, sha } from "./foundation.mjs";
import {
  allocationDigest,
  ContractCreditLedger,
  billing,
  inspectPaidWork,
  paidWorkPredicate,
} from "./billing-checks.mjs";
import { inspectReadiness } from "./provider-checks.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { checkDecisionTables } from "./billing-decision-tables.mjs";
import {
  billingState,
  directLink,
  library,
  link,
  live,
  payerFacts,
  rawFacts,
  simulatorExample,
  templates as templateRows,
} from "./billing-route-fixtures.mjs";
import {
  billingCallToAction,
  classifyPayment,
  createBillingConstraintsReader,
  entitlementFor,
  morrowPurchaseActions,
  originForCreation,
  purchaseDecision,
  selectPayers,
} from "../packages/policy/src/billing-state.ts";
import { isPaidWork } from "../packages/policy/src/paid-work.ts";
import { parseTermsDocument } from "../packages/work/src/billing/terms.ts";
import { stripeCanonicalJson } from "../packages/work/src/billing/stripe-objects.ts";
import { createHash } from "node:crypto";
import { operatorRaise, raiseRecordPath, raiseRecordProblem } from "./terms-raise.mjs";

// Runs under tsx (npm run verify:billing): the walkthroughs use
// packages/policy/src/billing-state.ts as the only implementation.

const f = read("docs/contracts/fixtures/P01.A04.json");
f.allocation.allocationDigest = allocationDigest(f.allocation);
f.facts.approvedAllocationDigest = f.allocation.allocationDigest;
const checks = [],
  errors = [];
function check(name, run) {
  try {
    if (!run()) throw new Error("unexpected outcome");
    checks.push({ name, passed: true });
  } catch (e) {
    checks.push({ name, passed: false });
    errors.push(name + ": " + e.message);
  }
}
check("small brand retains installation payer", () => {
  const x = structuredClone(f);
  x.allocation.shares.splice(1);
  x.allocation.maximumCredits = "30";
  x.allocation.allocationDigest = allocationDigest(x.allocation);
  x.facts.approvedAllocationDigest = x.allocation.allocationDigest;
  const l = new ContractCreditLedger(x.facts);
  l.reserve("reservation-1", x.allocation, x.vendorReservation);
  return (
    l.snapshot().wallets["payer-1"].available === "70" &&
    l.snapshot().wallets["payer-2"].available === "100"
  );
});
check("specialist team reconciles two payers and one vendor cost", () => {
  const l = new ContractCreditLedger(f.facts);
  l.reserve("reservation-1", f.allocation, f.vendorReservation);
  l.refresh({ now: "2026-10-06T13:05:00Z" });
  l.dispatch("reservation-1");
  l.uncertain("reservation-1");
  l.settle("reservation-1", f.usage, {
    verifiedProviderEvidence: true,
    verifiedRateEvidence: true,
  });
  const s = l.snapshot();
  return (
    s.rootConsumed === "25" &&
    s.rootReserved === "0" &&
    s.vendorConsumed === "300000000" &&
    s.wallets["payer-2"].available === "90"
  );
});
check("unqualified real billing design cannot dispatch", () => {
  const x = structuredClone(f);
  x.facts.rateQualified = false;
  const l = new ContractCreditLedger(x.facts);
  try {
    l.reserve("reservation-1", x.allocation, x.vendorReservation);
  } catch (e) {
    return e.message.includes("RATE_NOT_QUALIFIED");
  }
  return false;
});
// P01.T04a §1: paid work, rules PW1-PW5, with deliberate negative tables.
const paidWork = read("docs/contracts/paid-work.json"),
  catalogue = read("docs/contracts/capabilities.json"),
  templates = read("docs/contracts/fixtures/P01.T04a.json").templates;
for (const e of inspectPaidWork(paidWork, catalogue, templates)) errors.push(e);
const paidCapabilities = catalogue.capabilities
  .filter((c) => paidWork.paidEffects.includes(c.effect) && !c.kill_switch)
  .map((c) => c.id)
  .sort();
check("paid work is execute on the paid-effect capabilities that are not kill switches", () => {
  const paid = paidWorkPredicate(paidWork, catalogue);
  return (
    JSON.stringify(
      catalogue.capabilities
        .filter((c) => paid(c.id, "execute"))
        .map((c) => c.id)
        .sort(),
    ) === JSON.stringify(paidCapabilities) && paid("invented.capability", "view")
  );
});
for (const [name, change, expected] of [
  ["read as a paid effect", (t) => t.paidEffects.push("read"), "PAID_WORK_TABLE_INVALID:PW4"],
  [
    "billable_job dropped",
    (t) => t.paidEffects.splice(t.paidEffects.indexOf("billable_job"), 1),
    "PAID_WORK_TABLE_INVALID:PW3",
  ],
  ["execute never gated", (t) => t.neverGatedVerbs.push("execute"), "PAID_WORK_TABLE_INVALID:PW1"],
  [
    "administer never gated",
    (t) => t.neverGatedVerbs.push("administer"),
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
  [
    "an extra key",
    (t) => {
      t.killSwitchesPaid = true;
    },
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
])
  check("paid-work table rejects " + name, () => {
    const t = structuredClone(paidWork);
    change(t);
    return inspectPaidWork(t, catalogue, templates).includes(expected);
  });
check("paid-work table rejects a paid template row", () => {
  const t = structuredClone(templates);
  t["workspace-member-v1"].push({
    capabilityId: "creative.image.generate",
    verbs: ["execute"],
    fields: ["briefRef"],
  });
  return inspectPaidWork(paidWork, catalogue, t).includes(
    "PAID_WORK_TABLE_INVALID:PW5:workspace-member-v1",
  );
});
// P01.T04a §5: the two decision tables match their rule lists (--check).
for (const e of checkDecisionTables()) errors.push(e);

// P01.T04a §7: five walkthroughs over docs/contracts/fixtures/P01.T04a.json.
const L = library();
const W = L.workspaceId;
const workRequest = (capabilityId, verb, storeId = null) => ({
  capabilityId,
  verb,
  resource: {
    organizationId: L.organizationId,
    workspaceId: W,
    storeId,
    connectionId: null,
    kind: storeId === null ? "workspace" : "product",
    id: storeId === null ? W : "product_1",
  },
  accountId: null,
  fields: ["briefRef"],
});
const actor = {
  kind: "human",
  principalId: "human_o",
  organizationId: L.organizationId,
  workspaceId: W,
  membershipId: "membership_o",
  installationId: null,
  mandateId: null,
};
const classify = (state, event, granted = []) =>
  classifyPayment({ kind: "workspace", state }, event, L.terms, new Set(granted));
const event = (key, overrides = {}) => ({ ...structuredClone(L.events[key]), ...overrides });
// Payers are selected at the state's evaluation time.
const select = (state, work, spending, shares = null) =>
  selectPayers(
    state,
    {
      organizationId: L.organizationId,
      workspaceId: W,
      workStoreIds: work,
      spending,
      allocation:
        shares === null
          ? null
          : {
              schemaVersion: 2,
              id: "allocation_1",
              organizationId: L.organizationId,
              workspaceId: W,
              taskId: "task_1",
              rootRunId: "run_1",
              revision: 1,
              rateRevision: 1,
              meterKey: "agent-work",
              maximumCredits: "50",
              shares,
              allocationDigest: "e".repeat(64),
            },
    },
    state.evaluatedAt,
  );
const morrowRefused = (state) =>
  morrowPurchaseActions.every(
    (action) => purchaseDecision(state, { action }).code === "PURCHASE_ROUTE_MISMATCH",
  );
async function walkthrough(name, run) {
  try {
    if (!(await run())) throw new Error("unexpected outcome");
    checks.push({ name, passed: true });
  } catch (e) {
    checks.push({ name, passed: false });
    errors.push(name + ": " + e.message);
  }
}
await walkthrough(
  "website workspace sets up and invites but cannot run paid work before its first payment",
  async () => {
    if (originForCreation({ kind: "website_signup", installHandoffPending: false }) !== "website")
      return false;
    const raw = rawFacts({ route: L.routes.open });
    let billingReads = 0;
    const reader = createBillingConstraintsReader(
      { readCurrent: async () => ({ providerAllowed: true, entitlementAllowed: false }) },
      async () => {
        billingReads++;
        return structuredClone(raw);
      },
      "staging",
      () => new Date(L.now),
    );
    for (const rows of Object.values(templateRows()))
      for (const row of rows)
        for (const verb of row.verbs) {
          const c = await reader.readCurrent(workRequest(row.capabilityId, verb), actor);
          if (c.entitlementAllowed !== false || isPaidWork(row.capabilityId, verb)) return false;
        }
    if (billingReads !== 0) return false;
    const paid = await reader.readCurrent(workRequest("creative.image.generate", "execute"), actor);
    const s = billingState(raw);
    return (
      paid.entitlementAllowed === false &&
      billingReads === 1 &&
      s.phase === "open" &&
      s.state === "no_route" &&
      select(s, [], { workspace: true, storeIds: [] }).code === "BILLING_NO_ROUTE" &&
      purchaseDecision(s, { action: "subscribe" }).allowed === true &&
      purchaseDecision(s, { action: "top_up" }).code === "SUBSCRIPTION_REQUIRED" &&
      billingCallToAction(s).kind === "morrow_plans"
    );
  },
);
await walkthrough(
  "Shopify-origin workspace never reaches Morrow checkout and becomes billable through App Pricing",
  () => {
    if (originForCreation({ kind: "install_continuation" }) !== "shopify_install") return false;
    const bound = billingState(
      rawFacts({ route: L.routes.shopify_install_bound, associations: [link("iA")] }),
    );
    const stripe = classify(bound, event("stripe_period"));
    const fixed = classify(bound, event("shopify_period_a"));
    const after = billingState(
      rawFacts({
        route: L.routes.shopify_app_pricing,
        associations: [link("iA")],
        payers: [payerFacts("shopify_a")],
      }),
    );
    return (
      morrowRefused(bound) &&
      billingCallToAction(bound).kind === "shopify_plan_page" &&
      stripe.outcome === "conflict" &&
      stripe.code === "ROUTE_MISMATCH" &&
      fixed.outcome === "fix_route_and_grant" &&
      fixed.fixRoute.route === "shopify_app_pricing" &&
      after.state === "billable" &&
      after.purchaseSurface === "shopify" &&
      morrowRefused(after) &&
      entitlementFor(after, workRequest("creative.image.generate", "execute", "store_a"), L.now)
    );
  },
);
await walkthrough(
  "a merchant who loses the install handoff still gets a Shopify-origin workspace",
  () => {
    // The handoff is kept after it expires, so it is still pending at signup.
    const origin = originForCreation({ kind: "website_signup", installHandoffPending: true });
    const route = { ...L.routes.shopify_install, origin };
    const unlinked = billingState(rawFacts({ route }));
    const linked = billingState(
      rawFacts({
        route: { ...route, shopifyBoundAt: "2026-10-18T09:30:00Z" },
        associations: [link("iA")],
      }),
    );
    return (
      origin === "shopify_install" &&
      unlinked.phase === "shopify_bound" &&
      morrowRefused(unlinked) &&
      billingCallToAction(unlinked).kind === "none" &&
      morrowRefused(linked) &&
      billingCallToAction(linked).kind === "shopify_plan_page"
    );
  },
);
await walkthrough(
  "website workspace pays, then links two stores: one route, one payer, no retroactive charge",
  () => {
    const open = billingState(rawFacts({ route: L.routes.open }));
    const x = simulatorExample("morrow", { target: { kind: "workspace", state: open } });
    const ledger = new ContractCreditLedger(x.facts);
    const fixed = ledger.grant(event("stripe_period"), L.terms);
    const credited = ledger.snapshot();
    const paid = billingState(
      rawFacts({ route: L.routes.morrow_direct, payers: [payerFacts("morrow_w")] }),
    );
    const linked = billingState(
      rawFacts({
        // Linked after the route was fixed: the only order R2 and R3 allow.
        route: L.routes.morrow_direct,
        associations: [directLink("iA"), directLink("iB")],
        payers: [payerFacts("morrow_w")],
      }),
    );
    ledger.refresh({ links: [directLink("iA"), directLink("iB"), directLink("iC")] });
    const implicit = select(linked, ["store_a", "store_b"], { workspace: true, storeIds: [] });
    return (
      fixed.outcome === "fix_route_and_grant" &&
      fixed.fixRoute.route === "morrow_direct" &&
      fixed.account.installationId === null &&
      credited.grants.length === 1 &&
      JSON.stringify(ledger.snapshot()) === JSON.stringify(credited) &&
      linked.route === paid.route &&
      linked.payers.length === 1 &&
      JSON.stringify(linked.payers) === JSON.stringify(paid.payers) &&
      JSON.stringify(linked.coveredStoreIds) === JSON.stringify(["store_a", "store_b"]) &&
      implicit.ok &&
      implicit.shares.length === 1 &&
      implicit.shares[0].storeId === null &&
      classify(linked, event("shopify_period_b")).code === "ROUTE_MISMATCH" &&
      purchaseDecision(linked, { action: "shopify_plan_page", storeId: "store_a" }).code ===
        "PURCHASE_ROUTE_MISMATCH"
    );
  },
);
await walkthrough(
  "Shopify multi-store work needs an explicit allocation, and duplicate, cross-route, $0, held and test-mode payments grant nothing in production",
  () => {
    const state = billingState(
      live(
        rawFacts({
          route: L.routes.shopify_app_pricing,
          associations: [link("iA"), link("iB")],
          payers: [payerFacts("shopify_a"), payerFacts("shopify_b")],
        }),
      ),
      { environment: "production" },
    );
    const spending = { workspace: true, storeIds: ["store_a", "store_b"] };
    const share = (key, credits) => ({
      billingAccountId: L.accounts[key].id,
      installationId: L.accounts[key].installationId,
      storeId: L.accounts[key].storeId,
      entitlementRevision: 1,
      maximumCredits: credits,
      maximumLiability: { amount: "3.00", currency: "USD" },
    });
    const x = simulatorExample("shopify", { environment: "production" });
    const facts = live(x.facts);
    facts.paymentTarget = { kind: "workspace", state };
    const ledger = new ContractCreditLedger(facts);
    const before = ledger.snapshot();
    const nextCycle = { paymentKey: "shopify:app:7:shop:42:cycle:2026-11-18T10:00:00Z" };
    const outcomes = [
      ledger.grant(
        live(
          event("shopify_period_a", {
            ...nextCycle,
            subscriptionKey: "shopify:app:7:shop:42:created:2026-10-19T09:00:00Z",
          }),
        ),
        L.terms,
      ),
      ledger.grant(live(event("stripe_period")), L.terms),
      ledger.grant(
        live(
          event("shopify_period_a", {
            ...nextCycle,
            amountPaid: { amount: "0.00", currency: "USD" },
          }),
        ),
        L.terms,
      ),
      ledger.grant(
        live(event("shopify_period_a", { ...nextCycle, priceKey: "shopify:plan:unknown" })),
        L.terms,
      ),
      ledger.grant(event("shopify_period_a", nextCycle), L.terms),
    ].map((o) => o.code ?? o.reason ?? o.outcome);
    const unchanged = JSON.stringify(ledger.snapshot()) === JSON.stringify(before);
    const granted = ledger.grant(live(event("shopify_period_a", nextCycle)), L.terms);
    const replay = ledger.grant(live(event("shopify_period_a", nextCycle)), L.terms);
    return (
      select(state, ["store_a", "store_b"], spending).code === "ALLOCATION_REQUIRED" &&
      select(state, ["store_a", "store_b"], spending, [
        share("shopify_a", "30"),
        share("shopify_b", "20"),
      ]).selection === "explicit" &&
      JSON.stringify(outcomes) ===
        JSON.stringify([
          "DUPLICATE_SUBSCRIPTION",
          "ROUTE_MISMATCH",
          "no_charge",
          "TERMS_MISMATCH",
          "PAYMENT_MODE_REFUSED",
        ]) &&
      unchanged &&
      granted.outcome === "grant" &&
      replay.outcome === "already_granted" &&
      ledger.snapshot().grants.length === 1
    );
  },
);

const decisions = read("docs/decisions/readiness.json");
check(
  "local design packet ready with pending external reviews",
  () => inspectReadiness(decisions.local_design_packet, decisions.consumed_decisions).ready,
);
check("unresolved consumed structural decision blocks Ready", () => {
  const copy = structuredClone(decisions.consumed_decisions);
  copy[0].status = "unresolved";
  return !inspectReadiness(decisions.local_design_packet, copy).ready;
});
check(
  "missing controlled account still blocks integrated qualification",
  () =>
    !inspectReadiness(
      { ...decisions.local_design_packet, requiresControlledAccount: true },
      decisions.consumed_decisions,
    ).ready,
);
check(
  "unqualified package still blocks consumers",
  () =>
    !inspectReadiness(
      {
        ...decisions.local_design_packet,
        requiresQualifiedPackage: true,
        packageInputStatus: "in_review",
      },
      decisions.consumed_decisions,
    ).ready,
);
for (const d of decisions.consumed_decisions) {
  const original = read("docs/decisions/dependencies.json").find((x) => x.id === d.id);
  if (
    !original ||
    original.status !== "Design recorded" ||
    original.activation !== "blocked_until_qualified"
  )
    errors.push("readiness/activation drift " + d.id);
  if (!d.reviewRef || !existsSync(resolve(root, d.reviewRef)))
    errors.push("review record missing " + d.id);
}
// M5 PR-1: docs/decisions/billing-terms.json, Morrow's published BillingTerms@1 revisions
// per environment (R10; ADR-0022 item 11). Each revision parses (parseBillingTerms and the
// closed offers), revisions are contiguous from 1, each digest is SHA-256 of the canonical
// JSON of {terms, offers}, and every published revision keeps its pinned digest: a change
// is a new revision appended here deliberately. The beta subscription entry is USD 49 a
// month with 300 credits (owner, 2026-10-19), test mode only before M6, and production has
// no revision. ADR-0022 item 5 amendment (owner decision (b), 2026-10-21): a development or
// staging revision may carry one operator_test_entitlement entry, the beta plan's 300 test
// credits with no price and no offer (other credits only with the owner's committed record,
// below); a revision is either priced (at least one beta subscription entry) or
// operator-only (staging's revision 1 while the Stripe switch is off).
const publishedTermsDigests = Object.freeze({
  development: ["4c6ccd12dc283abcde21532208ecdabd6551865458c86ba5629b65d9c177e411"],
  staging: ["88744622d6efbddb2136154fe11e8f4472e99519559c19d629d68e4199fed350"],
  production: [],
});
const termsFile = read("docs/decisions/billing-terms.json");
check("billing terms: closed file, three environments", () => {
  return (
    termsFile.schema_version === 1 &&
    Object.keys(termsFile).sort().join() === "description,environments,schema_version" &&
    Object.keys(termsFile.environments).sort().join() === "development,production,staging"
  );
});
// Review R2 of v1 build order PR 6 (ADR-0035 item 4): an operator entry with any credits
// other than the beta plan's 300 is accepted only when its revision names a committed
// owner record (`ownerRecord`) that names that revision and those credits and quotes the
// owner's words naming the amount (scripts/terms-raise.mjs); a revision without a raise
// names none. staging:seed-platform applies the same rule to the record as committed.
const readRepositoryRecord = (path) =>
  raiseRecordPath.test(path) && existsSync(resolve(root, path))
    ? readFileSync(resolve(root, path), "utf8")
    : null;
function revisionValid(environment, revision, index, pinned, readRecord) {
  const keys = Object.keys(revision ?? {})
    .sort()
    .join();
  if (keys !== "digest,offers,terms" && keys !== "digest,offers,ownerRecord,terms") return false;
  const document = parseTermsDocument(revision.terms, revision.offers);
  const digest = createHash("sha256")
    .update(stripeCanonicalJson({ terms: revision.terms, offers: revision.offers }))
    .digest("hex");
  const offerFor = (priceKey) => document.offers.find((o) => o.priceKey === priceKey);
  const subscriptions = document.terms.entries.filter(
    (e) => e.route === "morrow_direct" && e.kind === "subscription_period",
  );
  const operator = document.terms.entries.filter((e) => e.kind === "operator_test_entitlement");
  const raise = operatorRaise(revision);
  const recorded =
    raise === null
      ? !Object.hasOwn(revision, "ownerRecord")
      : typeof revision.ownerRecord === "string" &&
        raiseRecordPath.test(revision.ownerRecord) &&
        raiseRecordProblem(readRecord(revision.ownerRecord), {
          environment,
          termsRevision: index + 1,
          creditUnits: raise,
        }) === null;
  return (
    document.terms.termsRevision === index + 1 &&
    revision.digest === digest &&
    (index >= pinned.length || pinned[index] === digest) &&
    (subscriptions.length >= 1 || (operator.length === 1 && document.terms.entries.length === 1)) &&
    operator.length <= 1 &&
    (operator.length === 0 || environment !== "production") &&
    operator.every(
      (e) =>
        e.route === "morrow_direct" &&
        e.priceKey === "morrow:operator_plan:beta" &&
        e.currency === "USD" &&
        /^[1-9][0-9]{0,17}$/.test(e.creditUnits),
    ) &&
    recorded &&
    document.offers.every((o) => !operator.some((e) => e.priceKey === o.priceKey)) &&
    document.terms.entries.every((e) => e.mode === "test") &&
    subscriptions.every(
      (e) =>
        e.currency === "USD" &&
        e.creditUnits === "300" &&
        offerFor(e.priceKey)?.unitAmount === "4900" &&
        offerFor(e.priceKey)?.interval === "month",
    )
  );
}
for (const [environment, revisions] of Object.entries(termsFile.environments ?? {}))
  check(
    `billing terms: ${environment} revisions parse, are contiguous and keep their digests`,
    () => {
      if (!Array.isArray(revisions)) return false;
      const pinned = publishedTermsDigests[environment] ?? [];
      if (revisions.length < pinned.length) return false;
      if (environment === "production" && revisions.length !== 0) return false;
      return revisions.every((revision, index) =>
        revisionValid(environment, revision, index, pinned, readRepositoryRecord),
      );
    },
  );
// R2's rule on a synthetic staging revision 2 that raises the operator credits to 1,000:
// refused without a record, with a record that names another revision or amount or does
// not quote the owner naming it, and with a record on a revision that raises nothing;
// accepted only with the owner's record.
check("billing terms: an operator raise needs the owner's committed record (review R2)", () => {
  const base = structuredClone(termsFile.environments.staging[0]);
  const raised = structuredClone(base);
  raised.terms.termsRevision = 2;
  raised.terms.entries[0].creditUnits = "1000";
  raised.digest = createHash("sha256")
    .update(stripeCanonicalJson({ terms: raised.terms, offers: raised.offers }))
    .digest("hex");
  const path = ["docs/evidence/live/2026-11-20-test-credits-raise", "md"].join(".");
  const record = (revision, credits, words) =>
    `# Test credits raise\n\n- Terms revision: \`${revision}\`\n- Credits per period: \`${credits}\`\n- Owner's words: "${words}"\n`;
  const yes = record("staging.2", "1000", "Yes, raise my test credits to 1,000 a period.");
  const valid = (revision, text) =>
    revisionValid("staging", revision, 1, [], (p) => (p === path ? text : null));
  return (
    !valid(raised, yes) &&
    !valid(
      { ...raised, ownerRecord: ["docs/evidence/live/2026-11-20-other", "md"].join(".") },
      yes,
    ) &&
    !valid({ ...raised, ownerRecord: path }, null) &&
    !valid({ ...raised, ownerRecord: path }, record("staging.3", "1000", "Yes, 1,000.")) &&
    !valid({ ...raised, ownerRecord: path }, record("staging.2", "2000", "Yes, 2,000.")) &&
    !valid({ ...raised, ownerRecord: path }, record("staging.2", "1000", "Yes, raise them.")) &&
    !valid({ ...raised, ownerRecord: path }, record("staging.2", "1000", "Yes to 10000.")) &&
    !valid({ ...raised, ownerRecord: path }, yes + "- Terms revision: `staging.2`\n") &&
    !revisionValid("staging", { ...base, ownerRecord: path }, 0, [], () => yes) &&
    valid({ ...raised, ownerRecord: path }, yes) &&
    revisionValid("staging", base, 0, [], () => null)
  );
});
check("billing terms: a changed published revision is refused", () => {
  const first = structuredClone(termsFile.environments.development[0]);
  first.terms.entries[0].creditUnits = "400";
  const digest = createHash("sha256")
    .update(stripeCanonicalJson({ terms: first.terms, offers: first.offers }))
    .digest("hex");
  return digest !== publishedTermsDigests.development[0];
});

const inputs = [
  "docs/decisions/billing-terms.json",
  "packages/work/src/billing/terms.ts",
  "docs/contracts/schemas/v1/billing.schema.json",
  "docs/contracts/decision-tables/classify-payment.rules.json",
  "docs/contracts/decision-tables/classify-payment.tsv",
  "docs/contracts/decision-tables/purchase-decision.rules.json",
  "docs/contracts/decision-tables/purchase-decision.tsv",
  "packages/policy/src/billing-state.ts",
  "packages/policy/src/paid-work.ts",
  "scripts/billing-decision-tables.mjs",
  "scripts/billing-route-fixtures.mjs",
  "tests/billing-state.test.mjs",
  "tests/billing-decision-tables.test.mjs",
  "docs/contracts/schemas/v1.1/billing.schema.json",
  "docs/contracts/paid-work.json",
  "docs/contracts/fixtures/P01.T04a.json",
  "docs/contracts/fixtures/P01.A04.json",
  "docs/contracts/billing-entitlements.md",
  "docs/contracts/budgets.md",
  "docs/decisions/billing-ownership.md",
  "docs/decisions/readiness.json",
  "docs/decisions/reviews/P01.T04-review.md",
  "scripts/billing-checks.mjs",
  "scripts/terms-raise.mjs",
  "tests/billing.test.mjs",
];
const report = {
  task: "P01.T04",
  generated_at: new Date().toISOString(),
  billing_definitions: Object.keys(billing.$defs).length,
  paid_work_capabilities: paidCapabilities.length,
  decision_tables: ["classify-payment", "purchase-decision"],
  checks,
  scope:
    "Synthetic design, exact arithmetic and semantic walkthroughs only. No concurrent database, rate activation, provider charge, independent review or merchant usability proof.",
  input_digests: Object.fromEntries(
    inputs.map((p) => [p, sha(readFileSync(resolve(root, p), "utf8"))]),
  ),
  errors,
};
writeArtifact("verify/billing.json", report);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${report.billing_definitions} billing definitions, ${report.paid_work_capabilities} paid-work capabilities (PW1-PW5), 2 decision tables and ${checks.length} billing/readiness checks and walkthroughs. Billing activation remains blocked.`,
  );
