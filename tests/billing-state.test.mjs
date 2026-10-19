// P01.T04a: the billing state library. PR-A covers the §4.4 test entitlement
// seed branch (AC33; ADR-0015 follow-up decision OQ-2 (a)). PR-B covers the
// route library: AC05 (library parts), AC06-AC09, AC12-AC24, AC28, AC32 and the
// seed folded into the workspace state. The decision tables (AC10, AC27) are in
// tests/billing-decision-tables.test.mjs, the composed reader at the SQL
// boundary (AC26) in tests/workspace-policy.test.mjs and the simulator parts in
// tests/billing.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BILLING_CALL_TO_ACTION_LABELS,
  BILLING_DENIAL_ENVELOPES,
  BillingBoundaryError,
  billingCallToAction,
  canonicalShopifyKey,
  classifyPayment,
  createBillingConstraintsReader,
  entitlementFor,
  evaluateTestEntitlementSeed,
  foldEntitlementEvidence,
  mapProviderStatus,
  morrowPurchaseActions,
  originForCreation,
  parseBillingTerms,
  parseWorkspaceBillingFacts,
  purchaseDecision,
  selectPayers,
  spendingScope,
  stripePaymentKind,
  testSeedEntitles,
  testSeedEnvironments,
  workspaceBillingState,
} from "../packages/policy/src/billing-state.ts";
import { createHumanPolicyService, isPaidWork } from "../packages/policy/src/index.ts";
import {
  validateCurrentBillingDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";
import {
  billingState,
  library,
  link,
  live,
  payerFacts,
  rawFacts,
  scopeW,
  scopeW2,
  templates,
} from "../scripts/billing-route-fixtures.mjs";

const fixture = JSON.parse(readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8"));
const seedCase = (id) => fixture.cases.find((c) => c.id === `P01.T04a.${id}`).value;
const seed = () => structuredClone(seedCase("seed.valid"));
const scope = { organizationId: "org_o", workspaceId: "workspace_w" };
const t0 = "2026-10-18T10:00:00Z";
const during = "2026-10-20T10:00:00Z";
const boundary = (code) => (e) => e instanceof BillingBoundaryError && e.code === code;

const actor = {
  kind: "human",
  principalId: "human_o",
  organizationId: "org_o",
  workspaceId: "workspace_w",
  membershipId: "membership_o",
  installationId: null,
  mandateId: null,
};
const resourceOn = (storeId, workspaceId = "workspace_w") => ({
  organizationId: "org_o",
  workspaceId,
  storeId,
  connectionId: null,
  kind: storeId === null ? "workspace" : "product",
  id: storeId === null ? workspaceId : "product_1",
});
const request = (capabilityId, verb, storeId, workspaceId) => ({
  capabilityId,
  verb,
  resource: resourceOn(storeId, workspaceId),
  accountId: null,
  fields: ["briefRef"],
});
// The reader under test sets entitlement from the seed branch only, as the
// composed reader (PR-B) will; tests are outside inspectEntitlementWriters.
async function decide(evaluation, req) {
  const grant = {
    id: "grant_o",
    principal: actor,
    capabilityId: req.capabilityId,
    verbs: [req.verb],
    scope: {
      organizationId: "org_o",
      workspaceId: req.resource.workspaceId,
      storeIds: req.resource.storeId === null ? [] : [req.resource.storeId],
      accountIds: [],
      resources: [req.resource],
      fields: ["briefRef"],
    },
    issuedBy: actor,
    validFrom: "2026-10-01T00:00:00Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  };
  const policy = createHumanPolicyService(
    {
      async readCurrent(current) {
        return {
          actor: { ...actor, workspaceId: req.resource.workspaceId },
          policyRevision: 1,
          grantsRevision: 1,
          principalActive: true,
          organizationActive: true,
          workspaceActive: true,
          membershipActive: true,
          sessionCurrent: true,
          resource: current.resource,
          accountId: null,
          providerAllowed: true,
          entitlementAllowed: testSeedEntitles(evaluation, current, during),
          grants: [
            {
              ...grant,
              principal: { ...actor, workspaceId: req.resource.workspaceId },
              issuedBy: { ...actor, workspaceId: req.resource.workspaceId },
            },
          ],
        };
      },
    },
    () => new Date(during),
  );
  return (await policy.decide(req)).decision.reason;
}

test("AC33 (a): development and staging accept a current seed for its workspace and named stores", async () => {
  assert.deepEqual([...testSeedEnvironments], ["development", "staging"]);
  for (const environment of testSeedEnvironments) {
    const evaluation = evaluateTestEntitlementSeed(seed(), scope, during, environment);
    assert.equal(evaluation.status, "accepted");
    assert.equal(evaluation.environment, environment);
    assert.deepEqual(evaluation.coveredStoreIds, ["store_a", "store_b"]);
    assert.deepEqual(evaluation.payer, {
      kind: "test_seed",
      seedId: "seed_m4_1",
      seedRevision: 1,
      mode: "test",
      installationId: null,
      storeId: null,
      creditUnits: "500",
      validUntil: "2026-10-25T10:00:00Z",
    });
    // One storeless payer: storeless work and the named stores are covered.
    assert.equal(
      testSeedEntitles(evaluation, request("creative.image.generate", "execute", null), during),
      true,
    );
    assert.equal(
      testSeedEntitles(
        evaluation,
        request("creative.image.generate", "execute", "store_a"),
        during,
      ),
      true,
    );
    assert.equal(
      testSeedEntitles(
        evaluation,
        request("creative.image.generate", "execute", "store_c"),
        during,
      ),
      false,
    );
    assert.equal(
      testSeedEntitles(
        evaluation,
        request("creative.image.generate", "execute", null, "workspace_w2"),
        during,
      ),
      false,
    );
    // Through the human evaluator: M4's paid execute on a named store runs, an unnamed store does not.
    assert.equal(
      await decide(evaluation, request("inventory.quantity.adjust", "execute", "store_a")),
      "allowed",
    );
    assert.equal(
      await decide(evaluation, request("inventory.quantity.adjust", "execute", "store_c")),
      "entitlement_denied",
    );
    assert.equal(
      await decide(evaluation, request("creative.image.generate", "execute", null)),
      "allowed",
    );
  }
  const storeless = evaluateTestEntitlementSeed(
    seedCase("seed.storeless"),
    scope,
    during,
    "development",
  );
  assert.deepEqual(storeless.coveredStoreIds, []);
  assert.equal(
    testSeedEntitles(storeless, request("creative.image.generate", "execute", null), during),
    true,
  );
  assert.equal(
    testSeedEntitles(storeless, request("creative.image.generate", "execute", "store_a"), during),
    false,
  );
});

test("AC33 (b): production readers refuse every seed without reading it", async () => {
  let reads = 0;
  const watched = new Proxy(seed(), {
    get(target, key) {
      reads++;
      return target[key];
    },
    ownKeys(target) {
      reads++;
      return Reflect.ownKeys(target);
    },
  });
  for (const value of [seed(), watched, { malformed: true }, null]) {
    const evaluation = evaluateTestEntitlementSeed(value, scope, during, "production");
    assert.deepEqual(evaluation, {
      status: "refused",
      reason: "SEED_REFUSED_IN_PRODUCTION",
      organizationId: "org_o",
      workspaceId: "workspace_w",
      environment: "production",
    });
    for (const storeId of [null, "store_a"])
      assert.equal(
        testSeedEntitles(
          evaluation,
          request("creative.image.generate", "execute", storeId),
          during,
        ),
        false,
      );
    assert.equal(
      await decide(evaluation, request("inventory.quantity.adjust", "execute", "store_a")),
      "entitlement_denied",
    );
    // Reads and proposals never read entitlement.
    assert.equal(
      await decide(evaluation, request("inventory.quantity.adjust", "propose", "store_a")),
      "allowed",
    );
  }
  assert.equal(reads, 0);
  // The environment is a composition-root value: anything else fails closed.
  for (const environment of ["prod", "test", "", null, "Production"])
    assert.throws(
      () => evaluateTestEntitlementSeed(seed(), scope, during, environment),
      boundary("BILLING_INPUT_INVALID"),
    );
});

test("AC33 (c): a seed fixes no route, creates no account and is never a payment", () => {
  const value = seed();
  const evaluation = evaluateTestEntitlementSeed(value, scope, during, "staging");
  assert.deepEqual(Object.keys(evaluation).sort(), [
    "coveredStoreIds",
    "environment",
    "organizationId",
    "payer",
    "status",
    "workspaceId",
  ]);
  assert.equal(
    JSON.stringify(evaluation).match(/route|paymentKey|subscription|billingAccount/),
    null,
  );
  // The seed record is none of the route, account, payment or grant records.
  for (const name of [
    "WorkspaceBillingRoute",
    "BillingAccount",
    "EntitlementSnapshot",
    "VerifiedPaymentEvent",
    "CreditGrant",
  ])
    assert.equal(validateCurrentBillingDefinition(name, value), false, name);
  // And no route, payment or live mode can be written into one.
  for (const id of ["seed.route_field", "seed.payment_key_field", "seed.live_mode"])
    assert.throws(
      () => evaluateTestEntitlementSeed(seedCase(id), scope, during, "development"),
      boundary("BILLING_FACTS_INVALID"),
      id,
    );
});

test("AC33 (d): the seed is capped, expiring, tenant-bound and pure", () => {
  const before = evaluateTestEntitlementSeed(seed(), scope, "2026-10-18T09:59:59Z", "staging");
  assert.equal(before.status, "inactive");
  assert.equal(before.reason, "SEED_NOT_YET_VALID");
  assert.equal(evaluateTestEntitlementSeed(seed(), scope, t0, "staging").status, "accepted");
  const expired = evaluateTestEntitlementSeed(seed(), scope, "2026-10-25T10:00:00Z", "staging");
  assert.equal(expired.reason, "SEED_EXPIRED");
  for (const evaluation of [before, expired])
    assert.equal(
      testSeedEntitles(evaluation, request("creative.image.generate", "execute", null), during),
      false,
    );
  // A retained accepted evaluation stops entitling at its seed's validUntil.
  const accepted = evaluateTestEntitlementSeed(seed(), scope, during, "staging");
  const storelessWork = request("creative.image.generate", "execute", null);
  assert.equal(testSeedEntitles(accepted, storelessWork, "2026-10-25T09:59:59Z"), true);
  for (const later of ["2026-10-25T10:00:00Z", "2026-11-01T00:00:00Z"])
    assert.equal(testSeedEntitles(accepted, storelessWork, later), false, later);
  for (const bad of ["yesterday", "2026-10-20T10:00:00+01:00", "", null, undefined])
    assert.throws(
      () => testSeedEntitles(accepted, storelessWork, bad),
      boundary("BILLING_INPUT_INVALID"),
      String(bad),
    );
  for (const [name, value] of [
    ["inverted window", { ...seed(), validFrom: "2026-10-25T10:00:00Z", validUntil: t0 }],
    ["empty window", { ...seed(), validUntil: t0 }],
    ["other workspace", { ...seed(), workspaceId: "workspace_w2" }],
    ["other organization", { ...seed(), organizationId: "org_p" }],
    ["unknown field", { ...seed(), extra: true }],
    ["101 stores", seedCase("seed.too_many_stores")],
    ["duplicate stores", seedCase("seed.duplicate_stores")],
  ])
    assert.throws(
      () => evaluateTestEntitlementSeed(value, scope, during, "development"),
      boundary("BILLING_FACTS_INVALID"),
      name,
    );
  for (const [name, args] of [
    ["bad time", [seed(), scope, "yesterday", "development"]],
    ["offset time", [seed(), scope, "2026-10-20T10:00:00+01:00", "development"]],
    ["bad scope", [seed(), { organizationId: "org_o" }, during, "development"]],
    ["extra scope", [seed(), { ...scope, storeId: "store_a" }, during, "development"]],
  ])
    assert.throws(
      () => evaluateTestEntitlementSeed(...args),
      boundary("BILLING_INPUT_INVALID"),
      name,
    );
  // A hand-built evaluation never entitles; only the library's results do.
  const forged = {
    status: "accepted",
    organizationId: "org_o",
    workspaceId: "workspace_w",
    environment: "staging",
    coveredStoreIds: ["store_a"],
    payer: { ...evaluateTestEntitlementSeed(seed(), scope, during, "staging").payer },
  };
  assert.equal(
    testSeedEntitles(forged, request("creative.image.generate", "execute", "store_a"), during),
    false,
  );
  // Pure: repeated calls deep-equal, outputs frozen, later input mutation changes nothing.
  const value = seed();
  const first = evaluateTestEntitlementSeed(value, scope, during, "development");
  value.storeIds.push("store_c");
  value.creditUnits = "999999";
  assert.deepEqual(first, evaluateTestEntitlementSeed(seed(), scope, during, "development"));
  assert.ok(
    Object.isFrozen(first) &&
      Object.isFrozen(first.payer) &&
      Object.isFrozen(first.coveredStoreIds),
  );
  assert.equal(
    testSeedEntitles(first, request("creative.image.generate", "execute", "store_c"), during),
    false,
  );
});

// ---------------------------------------------------------------------------
// PR-B: the route library.
// ---------------------------------------------------------------------------
const L = library();
const now = L.now;
const W = L.workspaceId;
const facts = (raw, environment = "staging") =>
  parseWorkspaceBillingFacts(raw, scopeW, environment);
const workspace = (state) => ({ kind: "workspace", state });
const classify = (state, event, { terms = L.terms, granted = [] } = {}) =>
  classifyPayment(workspace(state), event, terms, new Set(granted));
const ev = (key, overrides = {}) => ({ ...structuredClone(L.events[key]), ...overrides });
const factsError = (e) => e instanceof BillingBoundaryError && e.code === "BILLING_FACTS_INVALID";
const inputError = (e) => e instanceof BillingBoundaryError && e.code === "BILLING_INPUT_INVALID";
const routeRequest = (capabilityId, verb, storeId = null, workspaceId = W) => ({
  capabilityId,
  verb,
  resource: {
    organizationId: "org_o",
    workspaceId,
    storeId,
    connectionId: null,
    kind: storeId === null ? "workspace" : "product",
    id: storeId === null ? workspaceId : "product_1",
  },
  accountId: null,
  fields: ["briefRef"],
});
const openFacts = (overrides = {}) => rawFacts({ route: L.routes.open, ...overrides });
const morrowFacts = ({ links = [], payer = payerFacts("morrow_w"), ...rest } = {}) =>
  rawFacts({ route: L.routes.morrow_direct, associations: links, payers: [payer], ...rest });
const shopifyFacts = ({
  links = [link("iA"), link("iB")],
  payers = [payerFacts("shopify_a"), payerFacts("shopify_b")],
  ...rest
} = {}) => rawFacts({ route: L.routes.shopify_app_pricing, associations: links, payers, ...rest });
const shopifyBoundFacts = (links = [link("iA")]) =>
  rawFacts({ route: L.routes.shopify_install_bound, associations: links });
const allocation = (shares) => ({
  schemaVersion: 2,
  id: "allocation_1",
  organizationId: "org_o",
  workspaceId: W,
  taskId: "task_1",
  rootRunId: "run_1",
  revision: 1,
  rateRevision: 1,
  meterKey: "agent-work",
  maximumCredits: String(shares.reduce((n, s) => n + Number(s.maximumCredits), 0)),
  shares,
  allocationDigest: "e".repeat(64),
});
const share = (accountKey, credits = "30", revision = 1) => {
  const a = L.accounts[accountKey];
  return {
    billingAccountId: a.id,
    installationId: a.installationId,
    storeId: a.storeId,
    entitlementRevision: revision,
    maximumCredits: credits,
    maximumLiability: { amount: "3.00", currency: "USD" },
  };
};
const select = (
  state,
  { work = [], spending = { workspace: true, storeIds: [] }, shares = null, scope = scopeW } = {},
) =>
  selectPayers(state, {
    ...scope,
    workStoreIds: work,
    spending,
    allocation: shares === null ? null : allocation(shares),
  });

// The composed reader in front of the human evaluator (§6): the billing reader is
// called only for paid work, and only through createBillingConstraintsReader.
const routeActor = {
  kind: "human",
  principalId: "human_o",
  organizationId: "org_o",
  workspaceId: W,
  membershipId: "membership_o",
  installationId: null,
  mandateId: null,
};
async function decideBilling(raw, req, { environment = "staging", at = now, reader } = {}) {
  let calls = 0;
  const constraints = createBillingConstraintsReader(
    {
      async readCurrent() {
        return { providerAllowed: true, entitlementAllowed: false };
      },
    },
    async (scope) => {
      calls++;
      assert.deepEqual(scope, scopeW);
      if (reader) return reader(scope);
      return structuredClone(raw);
    },
    environment,
    () => new Date(at),
  );
  const policy = createHumanPolicyService(
    {
      async readCurrent(current) {
        const conditions = await constraints.readCurrent(current, routeActor);
        return {
          actor: routeActor,
          policyRevision: 1,
          grantsRevision: 1,
          principalActive: true,
          organizationActive: true,
          workspaceActive: true,
          membershipActive: true,
          sessionCurrent: true,
          resource: current.resource,
          accountId: null,
          providerAllowed: conditions.providerAllowed,
          entitlementAllowed: conditions.entitlementAllowed,
          grants: [
            {
              id: "grant_route",
              principal: routeActor,
              capabilityId: current.capabilityId,
              verbs: ["view", "propose", "approve", "execute", "delegate", "administer"],
              scope: {
                organizationId: "org_o",
                workspaceId: W,
                storeIds: current.resource.storeId === null ? [] : [current.resource.storeId],
                accountIds: [],
                resources: [current.resource],
                fields: [...current.fields],
              },
              issuedBy: routeActor,
              validFrom: "2026-10-01T00:00:00Z",
              expiresAt: null,
              revokedAt: null,
              policyRevision: 1,
            },
          ],
        };
      },
    },
    () => new Date(at),
  );
  const result = await policy.decide(req);
  return { reason: result.decision.reason, calls };
}

test("AC05: an open website workspace sets up and invites but cannot run paid work", async () => {
  const raw = openFacts();
  const s = billingState(raw);
  assert.equal(s.phase, "open");
  assert.equal(s.state, "no_route");
  assert.equal(s.purchaseSurface, "morrow");
  assert.equal(s.origin, "website");
  // Every ADR template row is allowed, and none reads billing facts.
  let rows = 0;
  for (const list of Object.values(templates()))
    for (const row of list)
      for (const verb of row.verbs) {
        const { reason, calls } = await decideBilling(raw, routeRequest(row.capabilityId, verb));
        assert.equal(reason, "allowed", `${row.capabilityId} ${verb}`);
        assert.equal(calls, 0);
        rows++;
      }
  assert.ok(rows >= 40);
  for (const capabilityId of [
    "creative.image.generate",
    "catalog.content.publish",
    "support.reply.send",
    "orders.refund.create",
  ]) {
    const paid = await decideBilling(raw, routeRequest(capabilityId, "execute", "store_a"));
    assert.deepEqual(paid, { reason: "entitlement_denied", calls: 1 }, capabilityId);
    const proposal = await decideBilling(raw, routeRequest(capabilityId, "propose", "store_a"));
    assert.deepEqual(proposal, { reason: "allowed", calls: 0 }, capabilityId);
  }
  assert.equal(select(s).code, "BILLING_NO_ROUTE");
  assert.equal(purchaseDecision(s, { action: "subscribe" }).allowed, true);
  for (const action of ["top_up", "change_plan", "billing_portal"])
    assert.equal(purchaseDecision(s, { action }).code, "SUBSCRIPTION_REQUIRED", action);
  for (const action of ["shopify_plan_page", "shopify_usage_cap"])
    assert.equal(
      purchaseDecision(s, { action, storeId: "store_a" }).code,
      "PURCHASE_ROUTE_MISMATCH",
      action,
    );
  assert.deepEqual(billingCallToAction(s), {
    kind: "morrow_plans",
    href: "/workspace/workspace_w/billing/morrow/plans",
    label: "Choose a plan",
  });
});

test("AC06: the origin is website only for a signup without a pending install handoff", () => {
  assert.equal(
    originForCreation({ kind: "website_signup", installHandoffPending: false }),
    "website",
  );
  const proxy = new Proxy(
    { kind: "website_signup", installHandoffPending: false },
    {
      ownKeys() {
        throw new Error("hostile");
      },
    },
  );
  for (const flow of [
    // A pending handoff, unexpired or expired (handoffs are kept after expiry).
    { kind: "website_signup", installHandoffPending: true },
    { kind: "install_continuation" },
    { kind: "workspace_in_existing_organization" },
    { kind: "operator_seed" },
    { kind: "fixture" },
    { kind: "invented_flow" },
    { kind: "website_signup", installHandoffPending: false, origin: "website" },
    { kind: "website_signup" },
    { kind: "website_signup", installHandoffPending: "false" },
    "website_signup",
    null,
    undefined,
    [],
    proxy,
  ])
    assert.equal(
      originForCreation(flow),
      "shopify_install",
      flow === proxy ? "proxy" : JSON.stringify(flow),
    );
  // A missing route record reads as shopify_install: no Morrow checkout.
  const s = billingState(rawFacts({ route: null }));
  assert.equal(s.origin, "shopify_install");
  assert.equal(s.phase, "shopify_bound");
  for (const action of morrowPurchaseActions)
    assert.equal(purchaseDecision(s, { action }).code, "PURCHASE_ROUTE_MISMATCH", action);
  assert.deepEqual(billingCallToAction(s), { kind: "none" });
});

test("AC07: a Shopify-origin workspace never reaches Morrow checkout and becomes billable through App Pricing", () => {
  const variants = {
    shopify_install: billingState(shopifyBoundFacts()),
    missing_route: billingState(rawFacts({ route: null, associations: [link("iA")] })),
    shopify_app_pricing: billingState(shopifyFacts()),
  };
  const envelopes = [];
  for (const [name, s] of Object.entries(variants)) {
    for (const action of morrowPurchaseActions) {
      const decision = purchaseDecision(s, { action });
      assert.equal(decision.code, "PURCHASE_ROUTE_MISMATCH", `${name} ${action}`);
      envelopes.push(decision.envelope);
    }
    assert.notEqual(billingCallToAction(s).kind, "morrow_plans", name);
    assert.equal(billingCallToAction(s).kind, "shopify_plan_page", name);
    const stripe = classify(s, ev("stripe_period"));
    assert.equal(stripe.outcome, "conflict", name);
    assert.equal(stripe.code, "ROUTE_MISMATCH", name);
    assert.ok(!("fixRoute" in stripe) && !("grant" in stripe), name);
  }
  for (const e of envelopes) assert.deepEqual(e, envelopes[0]);
  // The first completed App Pricing period on the associated iA fixes the Shopify route.
  const fixed = classify(variants.shopify_install, ev("shopify_period_a"));
  assert.equal(fixed.outcome, "fix_route_and_grant");
  assert.deepEqual(fixed.fixRoute, {
    route: "shopify_app_pricing",
    mode: "test",
    fixingPaymentKey: L.events.shopify_period_a.paymentKey,
  });
  assert.deepEqual(fixed.account, {
    kind: "create",
    route: "shopify_app_pricing",
    mode: "test",
    installationId: "installation_a",
    storeId: "store_a",
    currency: "USD",
  });
  assert.equal(fixed.grant.creditUnits, "1000");
  // After the transaction: W is billable through iA, and the surface stays Shopify.
  const after = billingState(
    rawFacts({
      route: L.routes.shopify_app_pricing,
      associations: [link("iA")],
      payers: [payerFacts("shopify_a")],
    }),
  );
  assert.equal(after.state, "billable");
  assert.equal(after.purchaseSurface, "shopify");
  assert.deepEqual(after.coveredStoreIds, ["store_a"]);
  assert.deepEqual(billingCallToAction(after), {
    kind: "shopify_plan_page",
    storeIds: ["store_a"],
    label: "Manage plan",
  });
});

test("AC08: linking before paying binds the workspace to Shopify for good", async () => {
  const linked = rawFacts({ route: L.routes.website_bound, associations: [link("iA")] });
  const s = billingState(linked);
  assert.equal(s.phase, "shopify_bound");
  assert.equal(s.origin, "website");
  for (const action of morrowPurchaseActions)
    assert.equal(purchaseDecision(s, { action }).code, "PURCHASE_ROUTE_MISMATCH");
  assert.equal(
    purchaseDecision(s, { action: "shopify_plan_page", storeId: "store_a" }).allowed,
    true,
  );
  // After iA disconnects: still Shopify-bound, no surface, no plan page.
  const disconnected = billingState(
    rawFacts({ route: L.routes.website_bound, associations: [link("iA", { current: false })] }),
  );
  assert.equal(disconnected.phase, "shopify_bound");
  assert.equal(disconnected.purchaseSurface, "none");
  assert.equal(
    purchaseDecision(disconnected, { action: "shopify_plan_page", storeId: "store_a" }).code,
    "STORE_NOT_LINKED",
  );
  assert.equal(classify(disconnected, ev("stripe_period")).code, "ROUTE_MISMATCH");
  // Linking is never denied for billing reasons, in any phase, even when billing is down.
  for (const raw of [
    openFacts(),
    linked,
    morrowFacts(),
    shopifyFacts(),
    rawFacts({ route: null }),
  ]) {
    const result = await decideBilling(
      raw,
      routeRequest("governance.connection.connect", "administer"),
      {
        reader: () => {
          throw new Error("billing reader down");
        },
      },
    );
    assert.deepEqual(result, { reason: "allowed", calls: 0 });
  }
});

test("AC09: a website workspace pays, then links two stores: one route, one payer", () => {
  const first = classify(billingState(openFacts()), ev("stripe_period"));
  assert.equal(first.outcome, "fix_route_and_grant");
  assert.deepEqual(first.fixRoute, {
    route: "morrow_direct",
    mode: "test",
    fixingPaymentKey: "stripe:invoice:in_TESTW00000001",
  });
  assert.deepEqual(first.account, {
    kind: "create",
    route: "morrow_direct",
    mode: "test",
    installationId: null,
    storeId: null,
    currency: "USD",
  });
  const paid = billingState(morrowFacts());
  const linked = billingState(morrowFacts({ links: [link("iA"), link("iB")] }));
  // Linking changes neither the route, the account nor its revision.
  for (const key of ["phase", "route", "mode", "state", "payers", "origin"])
    assert.deepEqual(linked[key], paid[key], key);
  assert.deepEqual(linked.coveredStoreIds, ["store_a", "store_b"]);
  assert.equal(entitlementFor(linked, routeRequest("creative.image.generate", "execute")), true);
  for (const store of ["store_a", "store_b"])
    assert.equal(
      entitlementFor(linked, routeRequest("creative.image.generate", "execute", store)),
      true,
    );
  assert.equal(
    entitlementFor(linked, routeRequest("creative.image.generate", "execute", "store_c")),
    false,
  );
  assert.equal(select(linked, { work: ["store_c"] }).code, "STORE_NOT_LINKED");
  assert.deepEqual(select(linked, { work: ["store_a", "store_b"] }), {
    ok: true,
    selection: "implicit",
    shares: [
      {
        billingAccountId: "account_morrow_w",
        installationId: null,
        storeId: null,
        entitlementRevision: 1,
      },
    ],
  });
  assert.equal(
    select(linked, { work: ["store_a", "store_b"], spending: { workspace: false, storeIds: [] } })
      .code,
    "PAYER_NOT_BILLABLE",
  );
  for (const action of ["shopify_plan_page", "shopify_usage_cap"])
    assert.equal(
      purchaseDecision(linked, { action, storeId: "store_a" }).code,
      "PURCHASE_ROUTE_MISMATCH",
    );
  assert.equal(billingCallToAction(linked).kind, "morrow_plans");
});

test("AC12: a completed payment means money collected; credits come only from the terms table", () => {
  const open = billingState(openFacts());
  // A $0 invoice for a trial, a 100% coupon, a customer balance and a credit note.
  for (const [n, amount] of ["0", "0.00", "0.0", "0.000000000"].entries()) {
    const outcome = classify(
      open,
      ev("stripe_period", {
        paymentKey: `stripe:invoice:in_TESTZERO000${n}`,
        amountPaid: { amount, currency: "USD" },
      }),
    );
    assert.deepEqual(outcome, {
      outcome: "no_charge",
      paymentKey: `stripe:invoice:in_TESTZERO000${n}`,
    });
  }
  // An App Pricing period in trial, a free plan, a 100% discount, a $0 development-store contract.
  const bound = billingState(shopifyBoundFacts());
  for (const n of [1, 2, 3, 4])
    assert.equal(
      classify(
        bound,
        ev("shopify_period_a", {
          paymentKey: `shopify:app:7:shop:42:cycle:2026-10-0${n}T10:00:00Z`,
          amountPaid: { amount: "0.00", currency: "USD" },
        }),
      ).outcome,
      "no_charge",
    );
  assert.equal(billingState(openFacts()).phase, "open");
  // An event can never carry its own credits.
  assert.throws(() => classify(open, { ...ev("stripe_period"), creditUnits: "1000" }), inputError);
  // Terms mismatches are held, never granted.
  for (const [name, event] of [
    ["unknown price", ev("stripe_period", { priceKey: "stripe:price:price_TESTUNKNOWN1" })],
    [
      "currency mismatch",
      ev("stripe_period", { amountPaid: { amount: "49.00", currency: "EUR" } }),
    ],
    [
      "top-up price as a period",
      ev("stripe_period", { priceKey: "stripe:price:price_TESTTOPUP001" }),
    ],
  ])
    assert.deepEqual(
      classify(open, event),
      { outcome: "held", reason: "TERMS_MISMATCH", paymentKey: event.paymentKey },
      name,
    );
  assert.equal(stripePaymentKind("subscription_create"), "subscription_period");
  assert.equal(stripePaymentKind("subscription_cycle"), "subscription_period");
  assert.equal(stripePaymentKind("subscription_update"), "plan_change");
  assert.equal(stripePaymentKind("manual"), "top_up");
  for (const reason of ["subscription_threshold", "upcoming", "quote_accept", "", null, undefined])
    assert.equal(stripePaymentKind(reason), "TERMS_MISMATCH", String(reason));
  assert.equal(
    mapProviderStatus({ provider: "stripe", status: "trialing", cancelAtPeriodEnd: false }),
    "pending",
  );
  // The terms parser rejects a repeated price key with other values.
  const repeated = JSON.parse(
    readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8"),
  ).cases.find((c) => c.id === "P01.T04a.terms.repeated_price_key_other_credits").value;
  assert.equal(validateCurrentBillingDefinition("BillingTerms", repeated), true);
  assert.throws(() => parseBillingTerms(repeated), inputError);
  assert.throws(() => classify(open, ev("stripe_period"), { terms: repeated }), inputError);
  const selfChange = structuredClone(L.terms);
  selfChange.planChanges[0].toPriceKey = selfChange.planChanges[0].fromPriceKey;
  assert.throws(() => parseBillingTerms(selfChange), inputError);
  assert.ok(Object.isFrozen(parseBillingTerms(L.terms).entries[0]));
});

test("AC13: canonical keys", () => {
  const cases = JSON.parse(readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8")).cases;
  const key = (id) => cases.find((c) => c.id === "P01.T04a.key." + id).value;
  assert.equal(validateCurrentBillingDefinition("PaymentKey", key("stripe_invoice")), true);
  for (const id of ["payment_intent", "checkout_session", "charge"])
    assert.equal(validateCurrentBillingDefinition("PaymentKey", key(id)), false, id);
  assert.equal(
    canonicalShopifyKey(
      "cycle",
      "gid://shopify/App/7",
      "gid://shopify/Shop/42",
      "2026-10-18T10:00:00.000Z",
    ),
    "shopify:app:7:shop:42:cycle:2026-10-18T10:00:00Z",
  );
  assert.equal(
    canonicalShopifyKey(
      "update",
      "gid://shopify/App/7",
      "gid://shopify/Shop/42",
      "2026-10-25T10:00:00Z",
    ),
    "shopify:app:7:shop:42:update:2026-10-25T10:00:00Z",
  );
  const created = canonicalShopifyKey(
    "created",
    "gid://shopify/App/7",
    "gid://shopify/Shop/42",
    "2026-10-18T09:59:00Z",
  );
  assert.equal(created, L.entitlements.shopify_a.subscriptionId);
  for (const k of [created, "shopify:app:7:shop:42:cycle:2026-10-18T10:00:00Z"])
    assert.equal(validateDefinition("core", "Id", k), true);
  for (const [name, args] of [
    [
      "raw GID in a part",
      ["cycle", "gid://shopify/App/7/extra", "gid://shopify/Shop/42", "2026-10-18T10:00:00Z"],
    ],
    [
      "foreign GID type",
      ["cycle", "gid://shopify/Product/7", "gid://shopify/Shop/42", "2026-10-18T10:00:00Z"],
    ],
    [
      "swapped GIDs",
      ["cycle", "gid://shopify/Shop/42", "gid://shopify/App/7", "2026-10-18T10:00:00Z"],
    ],
    [
      "leading zero",
      ["cycle", "gid://shopify/App/07", "gid://shopify/Shop/42", "2026-10-18T10:00:00Z"],
    ],
    ["bare number", ["cycle", "7", "gid://shopify/Shop/42", "2026-10-18T10:00:00Z"]],
    [
      "non-UTC time",
      ["cycle", "gid://shopify/App/7", "gid://shopify/Shop/42", "2026-10-18T10:00:00+01:00"],
    ],
    ["unparsable time", ["cycle", "gid://shopify/App/7", "gid://shopify/Shop/42", "yesterday"]],
    [
      "impossible date",
      ["cycle", "gid://shopify/App/7", "gid://shopify/Shop/42", "2026-02-30T10:00:00Z"],
    ],
    [
      "fractional second",
      ["cycle", "gid://shopify/App/7", "gid://shopify/Shop/42", "2026-10-18T10:00:00.500Z"],
    ],
    [
      "unknown part",
      ["period", "gid://shopify/App/7", "gid://shopify/Shop/42", "2026-10-18T10:00:00Z"],
    ],
  ])
    assert.throws(() => canonicalShopifyKey(...args), inputError, name);
  for (const id of [
    "raw_gid",
    "leading_zero_gid",
    "fractional_seconds",
    "offset_time",
    "created_as_payment",
  ])
    assert.equal(validateCurrentBillingDefinition("PaymentKey", key(id)), false, id);
});

test("AC14: plan changes are granted once, never as a duplicate subscription or a second period", () => {
  const paid = billingState(morrowFacts());
  const change = ev("stripe_plan_change");
  const granted = classify(paid, change, { granted: ["stripe:invoice:in_TESTW00000001"] });
  assert.equal(granted.outcome, "grant");
  assert.equal(granted.grant.creditUnits, "500");
  assert.equal(granted.grant.kind, "included");
  assert.deepEqual(granted.account, { kind: "existing", billingAccountId: "account_morrow_w" });
  // The draft is a CreditGrant@2 once the writer assigns its id and account.
  assert.equal(
    validateCurrentBillingDefinition("CreditGrant", {
      ...granted.grant,
      id: "grant_1",
      billingAccountId: "account_morrow_w",
    }),
    true,
  );
  assert.equal(
    classify(paid, change, { terms: { ...L.terms, planChanges: [] } }).reason,
    "TERMS_MISMATCH",
  );
  assert.equal(
    classify(paid, { ...change, amountPaid: { amount: "0", currency: "USD" } }).outcome,
    "no_charge",
  );
  // Before its subscription's first period is accepted, a plan change waits.
  const early = classify(billingState(openFacts()), change);
  assert.deepEqual(early, {
    outcome: "held",
    reason: "SUBSCRIPTION_NOT_CURRENT",
    paymentKey: change.paymentKey,
  });
  assert.equal(classify(paid, change).outcome, "grant");
  // The next cycle grants the new price's period entry.
  const next = classify(
    paid,
    ev("stripe_period_next", { priceKey: "stripe:price:price_TESTSCALE001" }),
    {
      granted: ["stripe:invoice:in_TESTW00000001", change.paymentKey],
    },
  );
  assert.equal(next.outcome, "grant");
  assert.equal(next.grant.creditUnits, "2000");
  // The Shopify update key behaves the same.
  const shopify = billingState(shopifyFacts());
  const update = classify(shopify, ev("shopify_plan_change_a"));
  assert.equal(update.outcome, "grant");
  assert.equal(update.grant.creditUnits, "500");
  assert.deepEqual(update.account, { kind: "existing", billingAccountId: "account_shopify_a" });
  const unknownA = billingState(
    shopifyFacts({
      payers: [payerFacts("shopify_a", { entitlement: null }), payerFacts("shopify_b")],
    }),
  );
  assert.equal(classify(unknownA, ev("shopify_plan_change_a")).reason, "SUBSCRIPTION_NOT_CURRENT");
});

test("AC15: no double billing, with one conflict key per subscription", () => {
  // (a) An App Pricing period on iB of a morrow_direct workspace.
  const direct = billingState(morrowFacts({ links: [link("iA"), link("iB")] }));
  const conflict = classify(direct, ev("shopify_period_b"));
  assert.equal(conflict.code, "ROUTE_MISMATCH");
  const key = {
    route: "shopify_app_pricing",
    subscriptionKey: L.entitlements.shopify_b.subscriptionId,
    paymentKey: null,
  };
  assert.deepEqual(conflict.key, key);
  const recorded = billingState(
    morrowFacts({
      links: [link("iA"), link("iB")],
      conflicts: [{ ...key, code: "ROUTE_MISMATCH" }],
    }),
  );
  assert.deepEqual(recorded.conflicts, [{ ...key, code: "ROUTE_MISMATCH" }]);
  assert.equal(recorded.state, "billable");
  const repeat = classify(
    recorded,
    ev("shopify_period_b", { paymentKey: "shopify:app:7:shop:43:cycle:2026-11-18T11:00:00Z" }),
  );
  assert.deepEqual(repeat.key, key);
  assert.throws(
    () =>
      parseWorkspaceBillingFacts(
        morrowFacts({
          conflicts: [
            { ...key, code: "ROUTE_MISMATCH" },
            { ...key, code: "DUPLICATE_SUBSCRIPTION" },
          ],
        }),
        scopeW,
        "staging",
      ),
    factsError,
  );
  // (b) A second Stripe subscription while the first is active.
  const second = classify(
    direct,
    ev("stripe_period", {
      paymentKey: "stripe:invoice:in_TESTW00000009",
      subscriptionKey: "stripe:sub:sub_TESTW00000002",
    }),
  );
  assert.equal(second.code, "DUPLICATE_SUBSCRIPTION");
  assert.deepEqual(second.key, {
    route: "morrow_direct",
    subscriptionKey: "stripe:sub:sub_TESTW00000002",
    paymentKey: null,
  });
  // (c) A second App Pricing subscription for iA while its current one is active.
  const shopify = billingState(shopifyFacts());
  assert.equal(
    classify(
      shopify,
      ev("shopify_period_a", {
        paymentKey: "shopify:app:7:shop:42:cycle:2026-10-19T10:00:00Z",
        subscriptionKey: "shopify:app:7:shop:42:created:2026-10-19T09:00:00Z",
      }),
    ).code,
    "DUPLICATE_SUBSCRIPTION",
  );
  // (d) No second subscription on an active morrow_direct workspace.
  assert.equal(purchaseDecision(direct, { action: "subscribe" }).code, "SUBSCRIPTION_EXISTS");
  // (e) A morrow_direct account paired with an App Pricing snapshot.
  const paired = billingState(
    morrowFacts({
      payer: payerFacts("morrow_w", {
        entitlement: {
          ...L.entitlements.shopify_a,
          billingAccountId: "account_morrow_w",
        },
      }),
    }),
  );
  assert.equal(paired.payers[0].status, "record_mismatch");
  assert.equal(paired.state, "not_billable");
});

test("AC16: payments without a current link", () => {
  // (a) iC paid before any association: held, never refunded automatically.
  const pre = classifyPayment(
    { kind: "unattributed", reason: "INSTALLATION_NOT_ASSOCIATED", environment: "staging" },
    ev("shopify_period_c", { organizationId: null, workspaceId: null }),
    L.terms,
    new Set(),
  );
  assert.deepEqual(pre, {
    outcome: "held",
    reason: "INSTALLATION_NOT_ASSOCIATED",
    paymentKey: L.events.shopify_period_c.paymentKey,
  });
  // Re-classified in the link transaction.
  assert.equal(
    classify(billingState(shopifyBoundFacts([link("iC")])), ev("shopify_period_c")).outcome,
    "fix_route_and_grant",
  );
  assert.equal(
    classify(billingState(morrowFacts({ links: [link("iC")] })), ev("shopify_period_c")).code,
    "ROUTE_MISMATCH",
  );
  // (b) iA disconnects without uninstalling: its next period is still its own, and is not spendable.
  const away = shopifyFacts({ links: [link("iA", { current: false }), link("iB")] });
  const s = billingState(away);
  const next = classify(
    s,
    ev("shopify_period_a", { paymentKey: "shopify:app:7:shop:42:cycle:2026-11-18T10:00:00Z" }),
  );
  assert.equal(next.outcome, "grant");
  assert.deepEqual(next.account, { kind: "existing", billingAccountId: "account_shopify_a" });
  assert.equal(s.payers.find((p) => p.storeId === "store_a").status, "not_linked");
  assert.equal(
    entitlementFor(s, routeRequest("creative.image.generate", "execute", "store_a")),
    false,
  );
  assert.equal(select(s, { work: ["store_a"] }).code, "STORE_NOT_LINKED");
  assert.deepEqual(
    select(s, { spending: { workspace: true, storeIds: ["store_a", "store_b"] } }).shares.map(
      (x) => x.storeId,
    ),
    ["store_b"],
  );
  const back = billingState(shopifyFacts());
  assert.equal(back.payers.find((p) => p.storeId === "store_a").status, "billable");
  assert.equal(
    entitlementFor(back, routeRequest("creative.image.generate", "execute", "store_a")),
    true,
  );
  // (c) An unmapped customer, and a mapped customer's invoice that traces to no Morrow operation.
  assert.equal(
    classifyPayment(
      { kind: "unattributed", reason: "CUSTOMER_NOT_MAPPED", environment: "staging" },
      ev("stripe_period", { organizationId: null, workspaceId: null }),
      L.terms,
      new Set(),
    ).reason,
    "CUSTOMER_NOT_MAPPED",
  );
  assert.equal(
    classify(billingState(openFacts()), ev("stripe_period", { operationId: null })).reason,
    "NOT_MORROW_INITIATED",
  );
  assert.equal(
    classifyPayment(
      { kind: "unattributed", reason: "NOT_MORROW_INITIATED", environment: "staging" },
      ev("stripe_period", { operationId: null }),
      L.terms,
      new Set(),
    ).reason,
    "NOT_MORROW_INITIATED",
  );
});

test("AC17: the checkout race and the connect offer", () => {
  assert.equal(billingState(openFacts({ checkoutIntentPending: true })).connectStoreOffered, false);
  assert.equal(billingState(openFacts()).connectStoreOffered, true);
  assert.equal(
    billingState(morrowFacts({ checkoutIntentPending: true })).connectStoreOffered,
    true,
  );
  // Paid at Stripe at t0, linked at t0+1 min, verified at t0+2 min: Morrow's order decides.
  const raced = billingState(
    rawFacts({
      route: { ...L.routes.website_bound, shopifyBoundAt: "2026-10-18T10:01:00Z" },
      associations: [link("iA", { associatedAt: "2026-10-18T10:01:00Z" })],
    }),
    { now: "2026-10-18T10:02:00Z" },
  );
  const outcome = classify(raced, ev("stripe_period", { verifiedAt: "2026-10-18T10:02:00Z" }));
  assert.deepEqual(outcome, {
    outcome: "conflict",
    code: "ROUTE_MISMATCH",
    key: {
      route: "morrow_direct",
      subscriptionKey: "stripe:sub:sub_TESTW00000001",
      paymentKey: null,
    },
    paymentKey: "stripe:invoice:in_TESTW00000001",
  });
  assert.equal(raced.phase, "shopify_bound");
});

test("AC18: an open reversal makes the payer non-billable while Stripe reports active", () => {
  const dispute = L.reversals.dispute_morrow_open;
  const s = billingState(
    morrowFacts({ payer: payerFacts("morrow_w", { openReversals: [dispute] }) }),
  );
  assert.equal(s.payers[0].status, "payment_reversed");
  assert.equal(s.state, "not_billable");
  assert.equal(entitlementFor(s, routeRequest("creative.image.generate", "execute")), false);
  assert.equal(select(s).code, "BILLING_NOT_ACTIVE");
  const cleared = billingState(
    morrowFacts({
      payer: payerFacts("morrow_w", {
        openReversals: [{ ...dispute, status: "cleared", revision: 2 }],
      }),
    }),
  );
  assert.equal(cleared.state, "billable");
  // A reversal of a payment that granted nothing is not attached to any payer (§8.11).
  assert.equal(billingState(morrowFacts()).payers[0].status, "billable");
  // A new period paid while the reversal is open is granted; the payer stays reversed.
  const period = classify(s, ev("stripe_period_next"), {
    granted: ["stripe:invoice:in_TESTW00000001"],
  });
  assert.equal(period.outcome, "grant");
  assert.equal(s.payers[0].status, "payment_reversed");
  // A top-up is refused while the payer is reversed.
  assert.equal(classify(s, ev("stripe_top_up")).code, "SUBSCRIPTION_REQUIRED");
  assert.equal(classify(billingState(morrowFacts()), ev("stripe_top_up")).grant.kind, "purchased");
});

test("AC19: test mode outside production and live mode only in production", async () => {
  const open = billingState(openFacts());
  assert.equal(classify(open, ev("stripe_period", { mode: "live" })).code, "PAYMENT_MODE_REFUSED");
  assert.equal(classify(open, ev("stripe_period")).outcome, "fix_route_and_grant");
  const prodOpen = billingState(live(openFacts()), { environment: "production" });
  assert.equal(classify(prodOpen, ev("stripe_period")).code, "PAYMENT_MODE_REFUSED");
  assert.equal(classify(prodOpen, live(ev("stripe_period"))).outcome, "fix_route_and_grant");
  // Test-mode records in production: refused, paid work denied, reads allowed.
  for (const raw of [morrowFacts(), shopifyFacts()]) {
    const s = billingState(raw, { environment: "production" });
    assert.ok(s.payers.every((p) => p.status === "mode_refused"));
    assert.equal(entitlementFor(s, routeRequest("creative.image.generate", "execute")), false);
    const paid = await decideBilling(raw, routeRequest("creative.image.generate", "execute"), {
      environment: "production",
    });
    assert.equal(paid.reason, "entitlement_denied");
    const read = await decideBilling(raw, routeRequest("governance.usage.read", "view"), {
      environment: "production",
    });
    assert.deepEqual(read, { reason: "allowed", calls: 0 });
  }
  // A test-mode route record alone is refused too.
  const mixed = live(morrowFacts());
  mixed.route.mode = "test";
  assert.equal(billingState(mixed, { environment: "production" }).payers[0].status, "mode_refused");
  // Live records in production are billable; in staging they are refused.
  assert.equal(billingState(live(shopifyFacts()), { environment: "production" }).state, "billable");
  assert.equal(billingState(live(shopifyFacts())).state, "not_billable");
  // The environment is only a factory or function parameter.
  for (const environment of ["prod", "test", "", null, "Production"]) {
    assert.throws(() => parseWorkspaceBillingFacts(openFacts(), scopeW, environment), inputError);
    assert.throws(
      () =>
        createBillingConstraintsReader(
          { readCurrent: async () => ({}) },
          async () => null,
          environment,
        ),
      inputError,
    );
  }
  assert.throws(() => workspaceBillingState(facts(openFacts()), now, "production"), inputError);
});

test("AC20: provider reads fold monotonically, idempotently and order-independently", () => {
  const current = structuredClone(L.entitlements.morrow_w);
  const observe = (overrides = {}) => {
    const { schemaVersion, revision, verifiedAt, ...rest } = current;
    return { ...rest, observedAt: verifiedAt, ...overrides };
  };
  assert.deepEqual(foldEntitlementEvidence(current, observe()), { result: "unchanged" });
  assert.deepEqual(
    foldEntitlementEvidence(
      current,
      observe({ observedAt: "2026-10-17T10:00:00Z", providerEvidenceRef: "1".repeat(64) }),
    ),
    { result: "stale_observation" },
  );
  const next = foldEntitlementEvidence(
    current,
    observe({
      observedAt: "2026-10-19T10:00:00Z",
      providerEvidenceRef: "2".repeat(64),
      status: "past_due",
    }),
  );
  assert.equal(next.result, "next");
  assert.equal(next.snapshot.revision, 2);
  assert.equal(next.snapshot.verifiedAt, "2026-10-19T10:00:00Z");
  assert.equal(next.snapshot.status, "past_due");
  assert.equal(validateCurrentBillingDefinition("EntitlementSnapshot", next.snapshot), true);
  const cancelled = { ...current, status: "cancelled" };
  assert.deepEqual(
    foldEntitlementEvidence(
      cancelled,
      observe({ observedAt: "2026-10-19T10:00:00Z", providerEvidenceRef: "3".repeat(64) }),
    ),
    { result: "terminal_revival_refused" },
  );
  assert.deepEqual(
    foldEntitlementEvidence(
      current,
      observe({
        providerEvidenceRef: "4".repeat(64),
        subscriptionId: "stripe:sub:sub_TESTW00000002",
      }),
    ),
    { result: "identity_changed" },
  );
  assert.deepEqual(
    foldEntitlementEvidence(
      current,
      observe({ providerEvidenceRef: "4".repeat(64), billingAccountId: "account_other" }),
    ),
    { result: "identity_changed" },
  );
  // A new subscription after a terminal one replaces it.
  assert.equal(
    foldEntitlementEvidence(
      cancelled,
      observe({
        observedAt: "2026-10-19T10:00:00Z",
        providerEvidenceRef: "5".repeat(64),
        subscriptionId: "stripe:sub:sub_TESTW00000002",
      }),
    ).result,
    "next",
  );
  // Equal observedAt, different evidence: the more restrictive status wins in both orders.
  const at = "2026-10-19T12:00:00Z";
  const active = observe({ observedAt: at, providerEvidenceRef: "f".repeat(64), status: "active" });
  const suspended = observe({
    observedAt: at,
    providerEvidenceRef: "0".repeat(64),
    status: "suspended",
  });
  const apply = (sequence) =>
    sequence.reduce((snapshot, o) => {
      const fold = foldEntitlementEvidence(snapshot, o);
      return fold.result === "next" ? fold.snapshot : snapshot;
    }, null);
  assert.equal(apply([active, suspended]).status, "suspended");
  assert.equal(apply([suspended, active]).status, "suspended");
  const five = [
    observe({
      observedAt: "2026-10-18T09:00:00Z",
      providerEvidenceRef: "6".repeat(64),
      status: "pending",
    }),
    observe({
      observedAt: "2026-10-18T10:00:00Z",
      providerEvidenceRef: "7".repeat(64),
      status: "active",
    }),
    observe({
      observedAt: "2026-10-18T11:00:00Z",
      providerEvidenceRef: "8".repeat(64),
      status: "past_due",
    }),
    active,
    suspended,
  ];
  const permutations = (list) =>
    list.length <= 1
      ? [list]
      : list.flatMap((x, i) =>
          permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]),
        );
  const results = new Set(
    permutations(five).map((p) => {
      const s = apply(p);
      return JSON.stringify([s.status, s.providerEvidenceRef, s.verifiedAt]);
    }),
  );
  assert.equal(permutations(five).length, 120);
  assert.deepEqual([...results], [JSON.stringify(["suspended", "0".repeat(64), at])]);
  // Malformed reads are refused, and an unknown read is no observation.
  assert.throws(() => foldEntitlementEvidence(current, { ...observe(), extra: 1 }), inputError);
  assert.throws(() => foldEntitlementEvidence(current, observe({ status: "paused" })), inputError);
  // §4.2 status table.
  const stripe = (status, cancelAtPeriodEnd = false) =>
    mapProviderStatus({ provider: "stripe", status, cancelAtPeriodEnd });
  assert.deepEqual(
    [
      "active",
      "trialing",
      "incomplete",
      "incomplete_expired",
      "past_due",
      "unpaid",
      "paused",
      "canceled",
    ].map((s) => stripe(s)),
    [
      "active",
      "pending",
      "pending",
      "cancelled",
      "past_due",
      "suspended",
      "suspended",
      "cancelled",
    ],
  );
  assert.equal(stripe("active", true), "active");
  const shopify = (overrides) =>
    mapProviderStatus({
      provider: "shopify_app_pricing",
      uninstalled: false,
      subscriptionPresent: true,
      canceled: false,
      frozen: false,
      inTrial: false,
      currentBillingCycle: true,
      effectivePriceZero: false,
      cancelAtEndOfCycle: false,
      ...overrides,
    });
  assert.equal(shopify({}), "active");
  assert.equal(shopify({ inTrial: true }), "pending");
  assert.equal(shopify({ currentBillingCycle: false }), "pending");
  assert.equal(shopify({ effectivePriceZero: true }), "pending");
  assert.equal(shopify({ frozen: true }), "suspended");
  assert.equal(shopify({ cancelAtEndOfCycle: true }), "active");
  assert.equal(shopify({ subscriptionPresent: false }), "cancelled");
  assert.equal(shopify({ canceled: true }), "cancelled");
  assert.equal(shopify({ uninstalled: true }), "uninstalled");
  for (const bad of [
    { provider: "stripe", status: "unknown_status", cancelAtPeriodEnd: false },
    { provider: "stripe", status: "active" },
    { provider: "paypal", status: "active", cancelAtPeriodEnd: false },
    { provider: "shopify_app_pricing", frozen: true },
    null,
  ])
    assert.throws(() => mapProviderStatus(bad), inputError, JSON.stringify(bad));
});

test("AC21: payer statuses in order", () => {
  const morrow = (overrides) =>
    billingState(morrowFacts({ payer: payerFacts("morrow_w", overrides) })).payers[0].status;
  const accountWith = (key, status) => ({ ...L.accounts[key], status });
  const entWith = (key, overrides) => ({ ...L.entitlements[key], ...overrides });
  assert.equal(
    morrow({ account: accountWith("morrow_w", "cancelled"), entitlement: null }),
    "subscription_inactive",
  );
  assert.equal(morrow({ account: accountWith("morrow_w", "suspended") }), "subscription_inactive");
  assert.equal(
    morrow({ entitlement: entWith("morrow_w", { status: "past_due" }) }),
    "subscription_inactive",
  );
  assert.equal(morrow({ openReversals: [L.reversals.dispute_morrow_open] }), "payment_reversed");
  assert.equal(morrow({ account: accountWith("morrow_w", "pending") }), "subscription_pending");
  assert.equal(morrow({ entitlement: null }), "subscription_pending");
  assert.equal(
    morrow({ entitlement: entWith("morrow_w", { verifiedAt: "2026-10-21T10:00:00Z" }) }),
    "entitlement_stale",
  );
  assert.equal(
    morrow({ entitlement: entWith("morrow_w", { validUntil: now }) }),
    "entitlement_stale",
  );
  const shopifyA = (overrides, links = [link("iA"), link("iB")]) =>
    billingState(
      shopifyFacts({
        links,
        payers: [payerFacts("shopify_a", overrides), payerFacts("shopify_b")],
      }),
    ).payers[0].status;
  assert.equal(
    shopifyA({
      account: accountWith("shopify_a", "uninstalled"),
      entitlement: entWith("shopify_a", { status: "pending" }),
    }),
    "subscription_inactive",
  );
  assert.equal(
    shopifyA({
      entitlement: { ...L.entitlements.shopify_b, billingAccountId: "account_shopify_a" },
    }),
    "record_mismatch",
  );
  assert.equal(shopifyA({}, [link("iA", { current: false }), link("iB")]), "not_linked");
  assert.equal(
    shopifyA({}, [link("iA", { associatedAt: "2026-10-21T00:00:00Z" }), link("iB")]),
    "not_linked",
  );
  assert.equal(
    shopifyA({ account: null, entitlement: null, association: link("iA") }),
    "account_missing",
  );
  assert.equal(shopifyA({}), "billable");
});

test("AC22: Shopify multi-store work and unrelated shops", () => {
  const s = billingState(shopifyFacts());
  const spending = { workspace: true, storeIds: ["store_a", "store_b"] };
  const shares = (r) => r.shares.map((x) => x.storeId);
  assert.deepEqual(select(s, { work: ["store_a"], spending }), {
    ok: true,
    selection: "implicit",
    shares: [
      {
        billingAccountId: "account_shopify_a",
        installationId: "installation_a",
        storeId: "store_a",
        entitlementRevision: 1,
      },
    ],
  });
  assert.equal(select(s, { work: ["store_a", "store_b"], spending }).code, "ALLOCATION_REQUIRED");
  const explicit = select(s, {
    work: ["store_a", "store_b"],
    spending,
    shares: [share("shopify_a", "30"), share("shopify_b", "20")],
  });
  assert.equal(explicit.selection, "explicit");
  assert.deepEqual(shares(explicit), ["store_a", "store_b"]);
  assert.equal(select(s, { spending }).code, "PAYER_SELECTION_REQUIRED");
  assert.deepEqual(shares(select(s, { spending, shares: [share("shopify_b")] })), ["store_b"]);
  assert.equal(
    select(s, { work: ["store_a"], spending, shares: [share("shopify_b")] }).code,
    "PAYER_OUTSIDE_WORK_SCOPE",
  );
  // C linked but cancelled: no other shop pays for work on C.
  const withC = (cOverrides, links = [link("iA"), link("iB"), link("iC")]) =>
    billingState(
      shopifyFacts({
        links,
        payers: [
          payerFacts("shopify_a"),
          payerFacts("shopify_b"),
          payerFacts("shopify_c", cOverrides),
        ],
      }),
    );
  const cancelledC = withC({ entitlement: { ...L.entitlements.shopify_c, status: "cancelled" } });
  assert.equal(
    select(cancelledC, {
      work: ["store_a", "store_c"],
      spending: { workspace: true, storeIds: ["store_a", "store_b", "store_c"] },
      shares: [share("shopify_a")],
    }).code,
    "STORE_NOT_BILLABLE",
  );
  // Every unusable share gets the same denial.
  const foreign = {
    ...share("shopify_a"),
    billingAccountId: "account_shopify_w2",
    installationId: "installation_w2",
    storeId: "store_w2",
  };
  const unknown = {
    ...share("shopify_a"),
    billingAccountId: "account_unknown",
    installationId: "installation_x",
    storeId: "store_x",
  };
  const all = { workspace: true, storeIds: ["store_a", "store_b", "store_c"] };
  const denials = [
    select(s, { spending, shares: [foreign] }),
    select(s, { spending, shares: [unknown] }),
    select(withC({}, [link("iA"), link("iB"), link("iC", { current: false })]), {
      spending: all,
      shares: [share("shopify_c")],
    }),
    select(withC({}), { spending, shares: [share("shopify_c")] }),
    select(cancelledC, { spending: all, shares: [share("shopify_c")] }),
    select(
      withC({
        openReversals: [
          {
            ...structuredClone(L.reversals.dispute_morrow_open),
            route: "shopify_app_pricing",
            paymentKey: L.events.shopify_period_c.paymentKey,
          },
        ],
      }),
      {
        spending: all,
        shares: [share("shopify_c")],
      },
    ),
    select(s, { spending: { workspace: true, storeIds: [] } }),
  ];
  for (const d of denials) assert.deepEqual(d, denials[0]);
  assert.equal(denials[0].code, "PAYER_NOT_BILLABLE");
  assert.equal(
    select(s, { spending, shares: [share("shopify_a"), share("shopify_a")] }).code,
    "DUPLICATE_PAYER_OR_STORE",
  );
  // An allocation mixing a storeless Morrow-direct share with a store-bound Shopify share.
  const mixed = [share("morrow_w"), share("shopify_a")];
  assert.equal(select(s, { spending, shares: mixed }).code, "PAYER_NOT_BILLABLE");
  const direct = billingState(morrowFacts({ links: [link("iA")] }));
  assert.equal(select(direct, { spending, shares: mixed }).code, "PAYER_NOT_BILLABLE");
  assert.equal(select(direct, { spending, shares: [share("morrow_w")] }).selection, "explicit");
});

test("AC23: losing a shop, the review-bound allocation and the spending scope", () => {
  const bound = [share("shopify_a")];
  const spending = { workspace: true, storeIds: ["store_a", "store_b"] };
  const before = billingState(
    shopifyFacts({ links: [link("iA")], payers: [payerFacts("shopify_a")] }),
  );
  assert.equal(select(before, { spending, shares: bound }).selection, "explicit");
  const uninstalled = {
    account: { ...L.accounts.shopify_a, status: "uninstalled" },
    entitlement: { ...L.entitlements.shopify_a, status: "uninstalled" },
  };
  const lost = [
    billingState(
      shopifyFacts({ links: [link("iA")], payers: [payerFacts("shopify_a", uninstalled)] }),
    ),
    billingState(
      shopifyFacts({ links: [link("iA", { current: false })], payers: [payerFacts("shopify_a")] }),
    ),
  ];
  assert.equal(lost[0].payers[0].status, "subscription_inactive");
  assert.equal(lost[1].payers[0].status, "not_linked");
  for (const s of lost) {
    assert.equal(s.state, "not_billable");
    assert.equal(s.phase, "shopify_app_pricing");
    for (const action of morrowPurchaseActions)
      assert.equal(purchaseDecision(s, { action }).code, "PURCHASE_ROUTE_MISMATCH");
  }
  // iB subscribes: W is billable through B, and the bound [iA] allocation still cannot pay.
  for (const a of [payerFacts("shopify_a", uninstalled), payerFacts("shopify_a")]) {
    const links =
      a.account.status === "uninstalled"
        ? [link("iA"), link("iB")]
        : [link("iA", { current: false }), link("iB")];
    const s = billingState(shopifyFacts({ links, payers: [a, payerFacts("shopify_b")] }));
    assert.equal(s.state, "billable");
    assert.equal(select(s, { spending, shares: bound }).code, "PAYER_NOT_BILLABLE");
  }
  const revised = billingState(
    shopifyFacts({
      payers: [
        payerFacts("shopify_a"),
        payerFacts("shopify_b", { entitlement: { ...L.entitlements.shopify_b, revision: 2 } }),
      ],
    }),
  );
  assert.equal(
    select(revised, { spending, shares: [share("shopify_b", "30", 1)] }).code,
    "ENTITLEMENT_NOT_CURRENT",
  );
  assert.equal(
    select(revised, { spending, shares: [share("shopify_b", "30", 2)] }).selection,
    "explicit",
  );
  // Spending scope.
  const actor = {
    kind: "human",
    principalId: "human_o",
    organizationId: "org_o",
    workspaceId: W,
    membershipId: "membership_o",
    installationId: null,
    mandateId: null,
  };
  let grantCount = 0;
  const grant = (overrides = {}, scopeOverrides = {}) => ({
    id: `grant_${++grantCount}`,
    principal: actor,
    capabilityId: "creative.image.generate",
    verbs: ["execute"],
    scope: {
      organizationId: "org_o",
      workspaceId: W,
      storeIds: ["store_a"],
      accountIds: [],
      resources: [routeRequest("creative.image.generate", "execute", "store_a").resource],
      fields: ["briefRef"],
      ...scopeOverrides,
    },
    issuedBy: actor,
    validFrom: "2026-10-01T00:00:00Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...overrides,
  });
  const work = routeRequest("creative.image.generate", "execute", "store_a");
  assert.deepEqual(spendingScope([grant()], actor, work, 1, now), {
    workspace: true,
    storeIds: ["store_a"],
  });
  const nothing = [
    grant({ revokedAt: "2026-10-19T00:00:00Z" }),
    grant({ expiresAt: "2026-10-19T00:00:00Z" }),
    grant({ capabilityId: "catalog.content.publish" }),
    grant({ verbs: ["view"] }),
    grant({}, { workspaceId: "workspace_w2" }),
    grant({ issuedBy: { ...actor, workspaceId: "workspace_w2" } }),
  ];
  assert.deepEqual(spendingScope(nothing, actor, work, 1, now), { workspace: false, storeIds: [] });
  // Not paid work: nothing to charge.
  assert.deepEqual(
    spendingScope(
      [grant({ verbs: ["propose"] })],
      actor,
      routeRequest("creative.image.generate", "propose", "store_a"),
      1,
      now,
    ),
    { workspace: false, storeIds: [] },
  );
  assert.throws(() => spendingScope([{ ...grant(), extra: 1 }], actor, work, 1, now), inputError);
});

test("AC24: tenant binding, input bounds and retained work", async () => {
  const w2 = billingState(rawFacts({ route: L.routes.other_workspace }), { scope: scopeW2 });
  assert.equal(entitlementFor(w2, routeRequest("creative.image.generate", "execute")), false);
  assert.equal(select(w2).code, "PAYER_NOT_BILLABLE");
  // W′ facts read for W, a W′ event and malformed facts.
  assert.throws(() => facts(rawFacts({ route: L.routes.other_workspace })), factsError);
  assert.throws(
    () => classify(billingState(openFacts()), ev("stripe_period", { workspaceId: "workspace_w2" })),
    inputError,
  );
  const many = Array.from({ length: 101 }, (_, i) => ({
    ...link("iA"),
    installationId: `installation_${i}`,
    storeId: `store_${i}`,
    current: false,
  }));
  for (const [name, raw] of [
    ["101 associations", rawFacts({ route: L.routes.shopify_install_bound, associations: many })],
    [
      "duplicate installations",
      rawFacts({
        route: L.routes.shopify_install_bound,
        associations: [link("iA"), link("iA", { storeId: "store_z", current: false })],
      }),
    ],
    [
      "two current links of one store",
      rawFacts({
        route: L.routes.shopify_install_bound,
        associations: [link("iA"), link("iB", { storeId: "store_a" })],
      }),
    ],
    ["unknown field", { ...openFacts(), extra: true }],
    ["missing field", (({ conflicts, ...rest }) => rest)(openFacts())],
    [
      "schema-invalid account",
      morrowFacts({
        payer: payerFacts("morrow_w", {
          account: { ...L.accounts.morrow_w, installationId: "installation_a" },
        }),
      }),
    ],
    [
      "an entitlement without its account",
      shopifyFacts({ payers: [payerFacts("shopify_a", { account: null })] }),
    ],
    [
      "a payer before the route is fixed",
      rawFacts({
        route: L.routes.shopify_install_bound,
        associations: [link("iA")],
        payers: [payerFacts("shopify_a")],
      }),
    ],
    ["no payer on morrow_direct", rawFacts({ route: L.routes.morrow_direct })],
    ["a storeless payer on the Shopify route", shopifyFacts({ payers: [payerFacts("morrow_w")] })],
    [
      "a payer association that is not the workspace's",
      shopifyFacts({
        payers: [
          {
            ...payerFacts("shopify_a"),
            association: link("iA", { associatedAt: "2026-10-18T09:31:00Z" }),
          },
        ],
      }),
    ],
    [
      "a getter",
      Object.defineProperty(openFacts(), "conflicts", { get: () => [], enumerable: true }),
    ],
  ]) {
    const value = structuredClone(raw);
    if (name === "a getter") assert.throws(() => facts(raw), factsError, name);
    else if (name === "a payer association that is not the workspace's") {
      value.payers[0].association = link("iA", { associatedAt: "2026-10-18T09:31:00Z" });
      assert.throws(() => facts(value), factsError, name);
    } else assert.throws(() => facts(value), factsError, name);
  }
  assert.throws(
    () => parseWorkspaceBillingFacts(openFacts(), { organizationId: "org_o" }, "staging"),
    inputError,
  );
  assert.throws(
    () => workspaceBillingState(structuredClone(facts(openFacts())), now, "staging"),
    inputError,
  );
  // Approving already-reserved work stays allowed on a non-billable workspace.
  const cancelled = morrowFacts({
    payer: payerFacts("morrow_w", {
      entitlement: { ...L.entitlements.morrow_w, status: "cancelled" },
    }),
  });
  assert.deepEqual(
    await decideBilling(cancelled, routeRequest("governance.approval.decide", "approve")),
    { reason: "allowed", calls: 0 },
  );
  assert.equal(
    (await decideBilling(cancelled, routeRequest("creative.image.generate", "execute"))).reason,
    "entitlement_denied",
  );
  // Replay comes before every other rule; a foreign or malformed key set is refused.
  const open = billingState(openFacts());
  assert.equal(
    classify(open, ev("stripe_period"), { granted: ["stripe:invoice:in_TESTW00000001"] }).outcome,
    "already_granted",
  );
  assert.equal(
    classifyPayment(
      { kind: "unattributed", reason: "CUSTOMER_NOT_MAPPED", environment: "staging" },
      ev("stripe_period", { organizationId: null, workspaceId: null }),
      L.terms,
      new Set(["stripe:invoice:in_TESTW00000001"]),
    ).outcome,
    "already_granted",
  );
  assert.equal(
    classify(open, ev("stripe_period", { mode: "live" }), {
      granted: ["stripe:invoice:in_TESTW00000001"],
    }).outcome,
    "refused",
  );
  assert.throws(
    () =>
      classifyPayment(workspace(open), ev("stripe_period"), L.terms, [
        "stripe:invoice:in_TESTW00000001",
      ]),
    inputError,
  );
  assert.throws(
    () =>
      classifyPayment(
        { kind: "workspace", state: structuredClone(open) },
        ev("stripe_period"),
        L.terms,
        new Set(),
      ),
    inputError,
  );
  for (const [reason, key] of [
    ["INSTALLATION_NOT_ASSOCIATED", "stripe_period"],
    ["CUSTOMER_NOT_MAPPED", "shopify_period_c"],
    ["NOT_MORROW_INITIATED", "shopify_period_c"],
  ])
    assert.throws(
      () =>
        classifyPayment(
          { kind: "unattributed", reason, environment: "staging" },
          ev(key, { organizationId: null, workspaceId: null }),
          L.terms,
          new Set(),
        ),
      inputError,
      reason,
    );
  assert.throws(
    () =>
      classifyPayment(
        { kind: "unattributed", reason: "TERMS_MISMATCH", environment: "staging" },
        ev("stripe_period"),
        L.terms,
        new Set(),
      ),
    inputError,
  );
});

test("AC28: one frozen denial row per code, and route-neutral surfaces", () => {
  const expected = {
    BILLING_NO_ROUTE: [
      "denied",
      "recheck_before_retry",
      "Paid work starts once this workspace has an active plan.",
    ],
    BILLING_NOT_ACTIVE: [
      "denied",
      "recheck_before_retry",
      "A plan covering this work is not active.",
    ],
    STORE_NOT_BILLABLE: [
      "denied",
      "recheck_before_retry",
      "A plan covering this work is not active.",
    ],
    STORE_NOT_LINKED: [
      "denied",
      "recheck_before_retry",
      "This store is not connected to this workspace.",
    ],
    ALLOCATION_REQUIRED: [
      "missing_input",
      "recheck_before_retry",
      "Choose which store pays for this work.",
    ],
    PAYER_SELECTION_REQUIRED: [
      "missing_input",
      "recheck_before_retry",
      "Choose which store pays for this work.",
    ],
    PAYER_NOT_BILLABLE: ["denied", "recheck_before_retry", "This payer cannot pay for this work."],
    PAYER_OUTSIDE_WORK_SCOPE: [
      "denied",
      "recheck_before_retry",
      "This payer cannot pay for this work.",
    ],
    DUPLICATE_PAYER_OR_STORE: [
      "denied",
      "recheck_before_retry",
      "This payer cannot pay for this work.",
    ],
    ENTITLEMENT_NOT_CURRENT: [
      "conflict",
      "recheck_before_retry",
      "Billing changed; review the work again.",
    ],
    PURCHASE_ROUTE_MISMATCH: [
      "denied",
      "never",
      "Manage this workspace's plan where it was purchased.",
    ],
    SUBSCRIPTION_EXISTS: [
      "conflict",
      "never",
      "This workspace already has a plan; change it instead.",
    ],
    SUBSCRIPTION_REQUIRED: ["missing_input", "recheck_before_retry", "Choose a plan first."],
    BILLING_FACTS_INVALID: [
      "unavailable",
      "safe_read_retry",
      "Billing status is unavailable. Try again.",
    ],
    BILLING_INPUT_INVALID: [
      "unavailable",
      "safe_read_retry",
      "Billing status is unavailable. Try again.",
    ],
  };
  assert.deepEqual(Object.keys(BILLING_DENIAL_ENVELOPES).sort(), Object.keys(expected).sort());
  assert.ok(Object.isFrozen(BILLING_DENIAL_ENVELOPES));
  const forbidden = /stripe|shopify|checkout|price|usd|eur|\$/i;
  for (const [code, [kind, retryClass, safeMessage]] of Object.entries(expected)) {
    const row = BILLING_DENIAL_ENVELOPES[code];
    assert.deepEqual(row, { code: kind, retryClass, safeMessage }, code);
    assert.ok(Object.isFrozen(row), code);
    assert.doesNotMatch(row.safeMessage, forbidden, code);
    assert.equal(
      validateDefinition("core", "ErrorEnvelope", {
        schemaVersion: 1,
        ...row,
        correlationId: "correlation_1",
        operationId: null,
        retryAfterSeconds: null,
        inputRequestIds: [],
      }),
      true,
      code,
    );
  }
  for (const code of ["PAYER_OUTSIDE_WORK_SCOPE", "DUPLICATE_PAYER_OR_STORE"])
    assert.equal(BILLING_DENIAL_ENVELOPES[code], BILLING_DENIAL_ENVELOPES.PAYER_NOT_BILLABLE);
  for (const raw of [
    openFacts(),
    shopifyBoundFacts(),
    rawFacts({ route: null }),
    morrowFacts(),
    shopifyFacts(),
    shopifyFacts({ links: [link("iA", { current: false }), link("iB", { current: false })] }),
  ]) {
    const s = billingState(raw);
    const cta = billingCallToAction(s);
    assert.ok(Object.isFrozen(cta));
    if (cta.kind !== "none")
      assert.ok(Object.values(BILLING_CALL_TO_ACTION_LABELS).includes(cta.label));
    if (s.phase === "shopify_bound" || s.phase === "shopify_app_pricing") {
      // The label and the target (the `kind` discriminator is not shown).
      const { kind, ...shown } = cta;
      assert.notEqual(kind, "morrow_plans");
      const text = JSON.stringify(shown);
      assert.doesNotMatch(text, forbidden, s.phase);
      assert.ok(!text.includes("/billing/morrow/"), s.phase);
    }
  }
});

test("AC32: the library is pure: repeatable, frozen and isolated from its inputs", () => {
  const raw = shopifyFacts();
  const f = facts(raw);
  const s1 = workspaceBillingState(f, now, "staging");
  const s2 = workspaceBillingState(facts(shopifyFacts()), now, "staging");
  assert.deepEqual(s1, s2);
  // Mutating the inputs afterwards changes nothing.
  raw.payers[0].entitlement.status = "cancelled";
  raw.associations.pop();
  assert.deepEqual(workspaceBillingState(f, now, "staging"), s1);
  assert.equal(s1.state, "billable");
  const frozenDeep = (value) =>
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(frozenDeep));
  assert.ok(frozenDeep(f) && frozenDeep(s1));
  const event = ev("shopify_period_c");
  const outcome = classify(billingState(shopifyBoundFacts([link("iC")])), event);
  event.paymentKey = "changed";
  assert.equal(outcome.paymentKey, L.events.shopify_period_c.paymentKey);
  assert.ok(frozenDeep(outcome));
  assert.deepEqual(
    outcome,
    classify(billingState(shopifyBoundFacts([link("iC")])), ev("shopify_period_c")),
  );
  for (const value of [
    purchaseDecision(s1, { action: "subscribe" }),
    billingCallToAction(s1),
    select(s1, { spending: { workspace: true, storeIds: ["store_a"] } }),
    parseBillingTerms(L.terms),
  ])
    assert.ok(frozenDeep(value));
  // An input is copied once and the copy is what is validated and read, so a
  // value that changes between reads cannot slip past validation.
  let reads = 0;
  const shifting = new Proxy(ev("stripe_period"), {
    get(target, key) {
      if (key === "paymentKey" && reads++ > 0) return "stripe:invoice:in_FORGED000001";
      return target[key];
    },
  });
  assert.equal(
    classify(billingState(openFacts()), shifting).paymentKey,
    "stripe:invoice:in_TESTW00000001",
  );
  // A state this module did not issue is never trusted.
  const forged = structuredClone(s1);
  assert.equal(entitlementFor(forged, routeRequest("creative.image.generate", "execute")), false);
  assert.throws(() => purchaseDecision(forged, { action: "subscribe" }), inputError);
  assert.throws(() => billingCallToAction(forged), inputError);
  assert.throws(() => select(forged), inputError);
  assert.throws(() => purchaseDecision(s1, { action: "checkout" }), inputError);
  assert.throws(() => purchaseDecision(s1, { action: "shopify_plan_page" }), inputError);
});

test("AC33 (PR-B): an accepted seed folds into the state over currently linked stores only", async () => {
  const testSeed = seed();
  const raw = rawFacts({
    route: L.routes.shopify_install_bound,
    associations: [link("iA"), link("iB", { current: false }), link("iC")],
    testSeed,
  });
  const s = billingState(raw, { now: during });
  assert.equal(s.phase, "shopify_bound");
  assert.equal(s.state, "no_route");
  assert.equal(s.testSeed.status, "accepted");
  assert.deepEqual(s.testSeed.coveredStoreIds, ["store_a"]);
  assert.equal(s.testSeed.payer.creditUnits, "500");
  assert.deepEqual(s.payers, []);
  assert.equal(entitlementFor(s, routeRequest("inventory.quantity.adjust", "execute")), true);
  assert.equal(
    entitlementFor(s, routeRequest("inventory.quantity.adjust", "execute", "store_a")),
    true,
  );
  for (const store of ["store_b", "store_c"])
    assert.equal(
      entitlementFor(s, routeRequest("inventory.quantity.adjust", "execute", store)),
      false,
      store,
    );
  // It fixes no route, opens no purchase and gives no route payer.
  assert.equal(select(s).code, "BILLING_NO_ROUTE");
  assert.equal(purchaseDecision(s, { action: "subscribe" }).code, "PURCHASE_ROUTE_MISMATCH");
  assert.equal(
    (
      await decideBilling(raw, routeRequest("inventory.quantity.adjust", "execute", "store_a"), {
        at: during,
      })
    ).reason,
    "allowed",
  );
  assert.equal(
    (
      await decideBilling(raw, routeRequest("inventory.quantity.adjust", "execute", "store_c"), {
        at: during,
      })
    ).reason,
    "entitlement_denied",
  );
  // Production refuses it without reading it.
  let reads = 0;
  const watched = new Proxy(seed(), {
    get(target, key) {
      reads++;
      return target[key];
    },
    ownKeys(target) {
      reads++;
      return Reflect.ownKeys(target);
    },
  });
  const prodRaw = {
    ...live(rawFacts({ route: L.routes.shopify_install_bound, associations: [link("iA")] })),
    testSeed: watched,
  };
  const prod = workspaceBillingState(
    parseWorkspaceBillingFacts(prodRaw, scopeW, "production"),
    during,
    "production",
  );
  assert.deepEqual(prod.testSeed, { status: "refused", reason: "SEED_REFUSED_IN_PRODUCTION" });
  assert.equal(
    entitlementFor(prod, routeRequest("inventory.quantity.adjust", "execute", "store_a")),
    false,
  );
  assert.equal(reads, 0);
  // Expired, foreign and malformed seeds.
  assert.deepEqual(billingState(raw, { now: "2026-10-25T10:00:00Z" }).testSeed, {
    status: "inactive",
    reason: "SEED_EXPIRED",
  });
  assert.throws(
    () =>
      billingState(rawFacts({ testSeed: { ...seed(), workspaceId: "workspace_w2" } }), {
        now: during,
      }),
    factsError,
  );
});
