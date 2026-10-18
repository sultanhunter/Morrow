// P01.T04a: the billing state library. PR-A covers the §4.4 test entitlement
// seed branch (AC33; ADR-0015 follow-up decision OQ-2 (a)).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BillingBoundaryError,
  evaluateTestEntitlementSeed,
  testSeedEntitles,
  testSeedEnvironments,
} from "../packages/policy/src/billing-state.ts";
import { createHumanPolicyService } from "../packages/policy/src/index.ts";
import { validateCurrentBillingDefinition } from "../packages/contracts/src/validation.ts";

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
