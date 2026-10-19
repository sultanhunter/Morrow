import test from "node:test";
import assert from "node:assert/strict";
import {
  createHumanPolicyService,
  createWorkspacePermissionBoundary,
} from "../packages/policy/src/index.ts";
import { createBillingConstraintsReader } from "../packages/policy/src/billing-state.ts";
import { withIdentityRead, identitySql } from "../packages/identity/src/index.ts";
import { directLink, library, payerFacts, rawFacts } from "../scripts/billing-route-fixtures.mjs";
const proof = "b".repeat(64);
const actor = {
  kind: "human",
  principalId: "human_a",
  organizationId: "org_a",
  workspaceId: "workspace_a",
  membershipId: "membership_a",
  installationId: null,
  mandateId: null,
};
const resource = {
  organizationId: "org_a",
  workspaceId: "workspace_a",
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: "workspace_a",
};
function fixture() {
  const grant = {
    id: "grant_a",
    principal: structuredClone(actor),
    capabilityId: "workspace.goal.create",
    verbs: ["execute"],
    scope: {
      organizationId: "org_a",
      workspaceId: "workspace_a",
      storeIds: [],
      accountIds: [],
      resources: [structuredClone(resource)],
      fields: ["objective"],
    },
    issuedBy: structuredClone(actor),
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  };
  let revision = "1",
    member = true;
  const calls = [],
    releases = [];
  const context = () => ({
    principal_id: "human_a",
    organization_id: "org_a",
    workspace_id: "workspace_a",
    membership_id: "membership_a",
    policy_revision: revision,
  });
  const state = {
    grant,
    extra: null,
    setRevision(v) {
      revision = v;
    },
    revokeMember() {
      member = false;
    },
    queries: 0,
  };
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text === identitySql.role)
        return {
          rows: [
            {
              role: "morrow_api",
              login: "morrow_api",
              rolsuper: false,
              rolbypassrls: false,
              rolcreatedb: false,
              rolcreaterole: false,
              owner_member: false,
            },
          ],
        };
      if (text === identitySql.resolve) return { rows: [context()] };
      if (text === identitySql.workspaceAuthority) {
        state.queries++;
        return { rows: member ? [{ ...context(), grants: [grant], ...(state.extra ?? {}) }] : [] };
      }
      return { rows: [] };
    },
    release(discard) {
      releases.push(discard);
    },
  };
  return {
    state,
    calls,
    releases,
    pool: {
      async connect() {
        return client;
      },
    },
    request: {
      capabilityId: "workspace.goal.create",
      verb: "execute",
      resource: structuredClone(resource),
      accountId: null,
      fields: ["objective"],
    },
  };
}
const clock = () => new Date("2026-10-06T18:00:00.000Z");
test("SQL workspace authority is loaded both before and after constraints", async () => {
  const f = fixture();
  let count = 0;
  const boundary = createWorkspacePermissionBoundary(
    f.pool,
    {
      async readCurrent() {
        count++;
        return { providerAllowed: true, entitlementAllowed: true };
      },
    },
    clock,
  );
  const result = await boundary.decide(proof, "workspace_a", f.request);
  assert.equal(result.decision.allowed, true);
  assert.equal(count, 1);
  assert.equal(f.state.queries, 2);
  assert.equal(f.calls.at(-1).text, identitySql.commit);
  assert.deepEqual(f.releases, [false]);
});
for (const change of [
  (f) => (f.request.resource.id = "workspace_b"),
  (f) => (f.request.resource.kind = "product"),
  (f) => (f.request.accountId = "account_b"),
  (f) => f.request.fields.push("cost"),
])
  test("invalid scope/fields never reach the constraint reader", async () => {
    const f = fixture();
    change(f);
    let count = 0;
    const boundary = createWorkspacePermissionBoundary(
      f.pool,
      {
        async readCurrent() {
          count++;
          return { providerAllowed: true, entitlementAllowed: true };
        },
      },
      clock,
    );
    const r = await boundary.decide(proof, "workspace_a", f.request);
    assert.equal(r.decision.allowed, false);
    assert.equal(count, 0);
    assert.equal(f.state.queries, 1);
  });
test("grant revocation during asynchronous constraints cannot allow", async () => {
  const f = fixture();
  const boundary = createWorkspacePermissionBoundary(
    f.pool,
    {
      async readCurrent() {
        f.state.grant.revokedAt = clock().toISOString();
        return { providerAllowed: true, entitlementAllowed: true };
      },
    },
    clock,
  );
  assert.equal(
    (await boundary.decide(proof, "workspace_a", f.request)).decision.reason,
    "capability_denied",
  );
  assert.equal(f.state.queries, 2);
});
test("changed policy revision after constraint lookup rejects a stale permission", async () => {
  const f = fixture();
  const boundary = createWorkspacePermissionBoundary(
    f.pool,
    {
      async readCurrent() {
        f.state.setRevision("2");
        return { providerAllowed: true, entitlementAllowed: true };
      },
    },
    clock,
  );
  assert.equal(
    (await boundary.decide(proof, "workspace_a", f.request)).decision.reason,
    "precondition_conflict",
  );
});
test("membership removal after constraint lookup rolls back the read", async () => {
  const f = fixture();
  const boundary = createWorkspacePermissionBoundary(
    f.pool,
    {
      async readCurrent() {
        f.state.revokeMember();
        return { providerAllowed: true, entitlementAllowed: true };
      },
    },
    clock,
  );
  await assert.rejects(
    boundary.decide(proof, "workspace_a", f.request),
    (e) => e.code === "IDENTITY_UNAVAILABLE",
  );
  assert.equal(f.calls.at(-1).text, identitySql.rollback);
});
for (const extra of [
  { unexpected: "private" },
  { principal_id: "human_b" },
  { membership_id: "membership_b" },
  { policy_revision: "unsafe" },
  { grants: [{ scope: "broken" }] },
])
  test("corrupt SQL authority cannot become a permission", async () => {
    const f = fixture();
    f.state.extra = extra;
    await assert.rejects(
      withIdentityRead(f.pool, proof, "workspace_a", (scope) => scope.readWorkspaceAuthority()),
      (e) => e.code === "IDENTITY_DENIED",
    );
    assert.equal(f.calls.at(-1).text, identitySql.rollback);
  });
test("retained authority scope cannot read after connection release", async () => {
  const f = fixture();
  let retained;
  await withIdentityRead(f.pool, proof, "workspace_a", async (scope) => {
    retained = scope;
  });
  const count = f.calls.length;
  await assert.rejects(retained.readWorkspaceAuthority(), (e) => e.code === "IDENTITY_DENIED");
  assert.equal(f.calls.length, count);
});
test("request authority injection denies before connecting to SQL", async () => {
  const f = fixture();
  let connects = 0;
  const boundary = createWorkspacePermissionBoundary(
    {
      async connect() {
        connects++;
        throw Error();
      },
    },
    {
      async readCurrent() {
        throw Error();
      },
    },
    clock,
  );
  await assert.rejects(
    boundary.decide(proof, "workspace_a", { ...f.request, actor }),
    (e) => e.code === "POLICY_INPUT_INVALID",
  );
  assert.equal(connects, 0);
});
test("constraint reader failure is redacted and read transaction rolls back", async () => {
  const f = fixture();
  const boundary = createWorkspacePermissionBoundary(
    f.pool,
    {
      async readCurrent() {
        throw Error("private/provider payload");
      },
    },
    clock,
  );
  await assert.rejects(
    boundary.decide(proof, "workspace_a", f.request),
    (e) => e.message === "IDENTITY_UNAVAILABLE" && e.cause === undefined,
  );
  assert.equal(f.calls.at(-1).text, identitySql.rollback);
});
// P01.T04a AC29 (defence in depth): only a plain, closed pair of booleans from the
// constraints reader is copied; anything else fails closed before it is read.
class ConstraintFacts {
  providerAllowed = true;
  entitlementAllowed = true;
}
for (const [name, conditions] of [
  ["a class instance", () => new ConstraintFacts()],
  ["an extra field", () => ({ providerAllowed: true, entitlementAllowed: true, paid: true })],
  ["a missing field", () => ({ providerAllowed: true })],
  ["a non-boolean entitlement", () => ({ providerAllowed: true, entitlementAllowed: "yes" })],
  ["a non-boolean provider flag", () => ({ providerAllowed: 1, entitlementAllowed: false })],
  [
    "a getter",
    () => ({
      providerAllowed: true,
      get entitlementAllowed() {
        return true;
      },
    }),
  ],
  ["null", () => null],
])
  test(`constraint reader returning ${name} fails closed and rolls back`, async () => {
    const f = fixture();
    const boundary = createWorkspacePermissionBoundary(
      f.pool,
      {
        async readCurrent() {
          return conditions();
        },
      },
      clock,
    );
    await assert.rejects(
      boundary.decide(proof, "workspace_a", f.request),
      (e) => e.message === "IDENTITY_UNAVAILABLE" && e.cause === undefined,
    );
    assert.equal(f.calls.at(-1).text, identitySql.rollback);
  });

// P01.T04a AC26: the composed billing constraints reader fails closed at the SQL
// boundary, and non-paid requests never call the billing reader. The fixture's
// tenant is O/W; this pool's is org_a/workspace_a, so the facts are re-tenanted.
const L = library();
const retenant = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll('"workspace_w2"', '"workspace_b"')
      .replaceAll('"workspace_w"', '"workspace_a"')
      .replaceAll('"org_o"', '"org_a"'),
  );
const billableFacts = () =>
  retenant(
    rawFacts({
      route: L.routes.morrow_direct,
      associations: [directLink("iA")],
      payers: [payerFacts("morrow_w")],
    }),
  );
const openFacts = () => retenant(rawFacts({ route: L.routes.open }));
const billingClock = () => new Date(L.now);
function billingBoundary(f, billing, environment = "staging") {
  const scopes = [];
  let calls = 0;
  const constraints = createBillingConstraintsReader(
    {
      async readCurrent() {
        return { providerAllowed: true, entitlementAllowed: false };
      },
    },
    async (scope) => {
      calls++;
      scopes.push(scope);
      return billing(scope);
    },
    environment,
    billingClock,
  );
  return {
    boundary: createWorkspacePermissionBoundary(f.pool, constraints, billingClock),
    constraints,
    calls: () => calls,
    scopes,
  };
}
const retarget = (f, capabilityId, verb) => {
  f.state.grant.capabilityId = capabilityId;
  f.state.grant.verbs = [verb];
  f.request.capabilityId = capabilityId;
  f.request.verb = verb;
  return f;
};
const throwingBilling = () => {
  throw new Error("billing facts reader down");
};
test("AC26: non-paid work never calls the billing reader, even while it is down", async () => {
  for (const [capabilityId, verb] of [
    ["governance.usage.read", "view"],
    ["governance.approval.decide", "approve"],
    ["governance.membership.revoke", "execute"],
    ["workspace.goal.create", "execute"],
  ]) {
    const f = retarget(fixture(), capabilityId, verb);
    const b = billingBoundary(f, throwingBilling);
    const r = await b.boundary.decide(proof, "workspace_a", f.request);
    assert.equal(r.decision.allowed, true, capabilityId);
    assert.equal(b.calls(), 0, capabilityId);
  }
});
test("AC26: paid work fails closed on a billing reader failure and releases the client", async () => {
  const f = retarget(fixture(), "creative.image.generate", "execute");
  const b = billingBoundary(f, throwingBilling);
  await assert.rejects(
    b.boundary.decide(proof, "workspace_a", f.request),
    (e) => e.message === "IDENTITY_UNAVAILABLE",
  );
  assert.equal(b.calls(), 1);
  assert.equal(f.calls.at(-1).text, identitySql.rollback);
  assert.deepEqual(f.releases, [false]);
});
test("AC26: paid work follows the facts of the SQL actor's workspace", async () => {
  const billable = retarget(fixture(), "creative.image.generate", "execute");
  const b = billingBoundary(billable, billableFacts);
  const allowed = await b.boundary.decide(proof, "workspace_a", billable.request);
  assert.equal(allowed.decision.allowed, true);
  assert.deepEqual(b.scopes, [{ organizationId: "org_a", workspaceId: "workspace_a" }]);
  const open = retarget(fixture(), "creative.image.generate", "execute");
  assert.equal(
    (await billingBoundary(open, openFacts).boundary.decide(proof, "workspace_a", open.request))
      .decision.reason,
    "entitlement_denied",
  );
  const many = Array.from({ length: 101 }, (_, i) => ({
    installationId: `installation_${i}`,
    storeId: `store_${i}`,
    associatedAt: "2026-10-18T09:30:00Z",
    current: false,
  }));
  for (const [name, facts] of [
    [
      "foreign workspace facts",
      () => ({ ...openFacts(), route: { ...openFacts().route, workspaceId: "workspace_b" } }),
    ],
    ["an unknown field", () => ({ ...billableFacts(), paid: true })],
    ["101 associations", () => ({ ...openFacts(), associations: many })],
  ]) {
    const f = retarget(fixture(), "creative.image.generate", "execute");
    await assert.rejects(
      billingBoundary(f, facts).boundary.decide(proof, "workspace_a", f.request),
      (e) => e.message === "IDENTITY_UNAVAILABLE",
      name,
    );
    assert.deepEqual(f.releases, [false], name);
  }
});
test("AC26: through createHumanPolicyService a throwing billing reader gives POLICY_AUTHORITY_UNAVAILABLE", async () => {
  const f = retarget(fixture(), "creative.image.generate", "execute");
  const { constraints } = billingBoundary(f, throwingBilling);
  const service = createHumanPolicyService(
    {
      async readCurrent(request) {
        const conditions = await constraints.readCurrent(request, actor);
        return {
          actor,
          policyRevision: 1,
          grantsRevision: 1,
          principalActive: true,
          organizationActive: true,
          workspaceActive: true,
          membershipActive: true,
          sessionCurrent: true,
          resource: request.resource,
          accountId: null,
          providerAllowed: conditions.providerAllowed,
          entitlementAllowed: conditions.entitlementAllowed,
          grants: [f.state.grant],
        };
      },
    },
    billingClock,
  );
  await assert.rejects(service.decide(f.request), (e) => e.code === "POLICY_AUTHORITY_UNAVAILABLE");
  // A provider reader that is not a closed boolean pair fails closed as well.
  const odd = createBillingConstraintsReader(
    {
      async readCurrent() {
        return { providerAllowed: true };
      },
    },
    async () => openFacts(),
    "staging",
    billingClock,
  );
  await assert.rejects(
    odd.readCurrent(f.request, actor),
    (e) => e.code === "BILLING_FACTS_INVALID",
  );
});
