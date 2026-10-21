// M3 PR-1 (P05.T04b minimum; mvp-architecture §5 and §9): the agent kernel on its SQL
// fact reader. Rows shaped exactly as morrow_work.delegation_facts returns them (one run
// lease, its envelope and hops, the installations they name and every actor's filtered
// grants, as morrow_identity.work_delegation_actor_facts selects them) go through
// createLeaseDelegationReader into the unchanged createAgentAuthorityService
// ().decideDelegation. A correctly admitted run is allowed; the P05.A02 and P05.A03 cases
// are denied. Entitlement comes only from entitlementFor over the billing facts port; a
// reader failure denies. lab:listings-authority runs the same reader over PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import {
  AgentAuthorityError,
  createAgentAuthorityService,
} from "../packages/policy/src/agent-authority.ts";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import {
  createLeaseDelegationReader,
  DelegationFactsUnavailable,
} from "../packages/work/src/agents/delegation-reader.ts";
import { createBillingFactsReader } from "../packages/work/src/billing/facts.ts";
import { listingsScope } from "../packages/work/src/agents/listings.ts";
import { directLink, payerFacts, rawFacts, library } from "../scripts/billing-route-fixtures.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const L = library();
// The billing fixture's tenant: org_o / workspace_w, Morrow-direct, store_a covered.
const O = L.organizationId,
  W = L.workspaceId,
  S = "store_a",
  C = "connection_a",
  I = "installation_listings";
const at = "2026-10-20T10:00:00.000Z";
const from = "2026-10-20T09:00:00.000Z";
const until = "2026-10-20T20:00:00.000Z";
const store = storeResource(O, W, S, C);
const scope = () => JSON.parse(JSON.stringify(listingsScope(store)));
const caps = ["catalog.content.propose", "catalog.content.publish", "catalog.products.read"];
const human = (principalId) => ({
  kind: "human",
  principalId,
  organizationId: O,
  workspaceId: W,
  membershipId: "membership_" + principalId,
  installationId: null,
  mandateId: null,
});
const agentActor = (principalId, installationId) => ({
  kind: "agent",
  principalId,
  organizationId: O,
  workspaceId: W,
  membershipId: null,
  installationId,
  mandateId: null,
});
const merchant = human("merchant");
const owner = human("owner");
const coordinator = agentActor("agent_coordinator", null);
const listings = agentActor("agent_listings", I);
const linking = { ...owner, kind: "service", principalId: "morrow.linking", membershipId: null };
const task = {
  organizationId: O,
  workspaceId: W,
  storeId: null,
  connectionId: null,
  kind: "task",
  id: "task_root",
};
function grant(id, principal, capabilityId, verbs, grantScope, issuedBy, extra = {}) {
  return {
    id,
    principal,
    capabilityId,
    verbs,
    scope: grantScope,
    issuedBy,
    validFrom: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...extra,
  };
}
// A linked human's store-link grants (M2 PR-2's template).
const linkedGrants = (who) => [
  grant(
    who.principalId + "_read",
    who,
    "catalog.products.read",
    ["view", "delegate"],
    scope(),
    linking,
  ),
  grant(
    who.principalId + "_propose",
    who,
    "catalog.content.propose",
    ["execute", "delegate"],
    scope(),
    linking,
  ),
  grant(
    who.principalId + "_publish",
    who,
    "catalog.content.publish",
    ["propose", "approve", "execute", "delegate"],
    scope(),
    linking,
  ),
];
// The installation's grants, issued by its owner at enable (the identity bridge's allowlist).
const installationGrants = () => [
  grant("i_propose", listings, "catalog.content.propose", ["execute"], scope(), owner),
  grant("i_publish", listings, "catalog.content.publish", ["propose"], scope(), owner),
  grant("i_read", listings, "catalog.products.read", ["view"], scope(), owner),
];
const coordinatorGrant = (extra = {}) =>
  grant(
    "coordinator_delegate",
    coordinator,
    "workspace.task.delegate",
    ["delegate"],
    {
      organizationId: O,
      workspaceId: W,
      storeIds: [],
      accountIds: [],
      resources: [task],
      fields: ["installationId", "mandate", "taskId"],
    },
    merchant,
    { validFrom: from, expiresAt: until, ...extra },
  );
const operation = (capabilityId = "catalog.products.read", verb = "view") => ({
  capabilityId,
  verb,
  resource: store,
  accountId: null,
  fields: ["descriptionHtml", "title"],
});
// The world as SQL would return it; `edit` changes it before the rows are rendered.
function world(edit = () => {}) {
  const w = {
    lease: {
      organizationId: O,
      workspaceId: W,
      leaseId: "00000000-0000-4000-8000-000000000001",
      kind: "run",
      storeId: S,
      connectionId: C,
      installationId: I,
      initiatorPrincipalId: merchant.principalId,
      initiatorMembershipId: merchant.membershipId,
    },
    envelope: {
      id: "envelope_root",
      revision: 1,
      task_id: "task_root",
      task_revision: 1,
      requester_principal_id: merchant.principalId,
      requester_membership_id: merchant.membershipId,
      store_id: S,
      installation_id: I,
      capability_ids: [...caps],
      verbs: ["execute", "propose", "view"],
      scope: scope(),
      valid_from: from,
      expires_at: until,
      revoked_at: null,
      maximum_depth: 1,
      maximum_children: 1,
    },
    hops: [
      {
        id: "hop_1",
        revision: 1,
        parent_task_id: "task_root",
        parent_task_revision: 1,
        child_task_id: "task_child",
        child_task_revision: 1,
        parent_envelope_id: "envelope_root",
        parent_envelope_revision: 1,
        child_envelope_id: "envelope_child",
        child_envelope_revision: 1,
        dispatcher_kind: "builtin_coordinator",
        dispatcher_principal_id: coordinator.principalId,
        dispatcher_installation_id: null,
        recipient_principal_id: listings.principalId,
        recipient_installation_id: I,
        capability_ids: [...caps],
        verbs: ["execute", "propose", "view"],
        scope: scope(),
        valid_from: from,
        expires_at: until,
        revoked_at: null,
        parent_child_count: 0,
      },
    ],
    installationStatus: "active",
    installationGrants: installationGrants(),
    grantDigestDrift: false,
    merchantGrants: linkedGrants(merchant),
    ownerGrants: linkedGrants(owner),
    coordinatorGrants: [coordinatorGrant()],
    ownerMembershipActive: true,
    merchantMembershipActive: true,
    agentActive: true,
    policyRevision: 1,
    storeCurrent: true,
  };
  edit(w);
  return w;
}
// Renders the rows: actors filtered by capability exactly as work_delegation_actor_facts
// filters them (the origin and owners: the operation's capability and the delegate one;
// the installation's agent: its three; a Coordinator: its delegate grants on the parent).
function rows(w, capabilityId) {
  const humanCaps = [capabilityId, "workspace.task.delegate"];
  const actor = (principalId, membershipId, grants, extra) => ({
    principal_id: principalId,
    kind: membershipId === null ? "agent" : "human",
    membership_id: membershipId,
    installation_id: null,
    role: null,
    principal_active: true,
    organization_active: true,
    workspace_active: true,
    membership_active: membershipId !== null,
    policy_revision: w.policyRevision,
    grants,
    grant_count: grants.length,
    ...extra,
  });
  const refs = w.installationGrants.map((payload) => ({
    organizationId: O,
    workspaceId: W,
    storeId: S,
    kind: "grant",
    id: payload.id,
    revision: 1,
    digest: w.grantDigestDrift ? "0".repeat(64) : sha(canonicalize(payload)),
  }));
  const installation = {
    id: I,
    revision: 1,
    release_id: "morrow.listings",
    release_revision: 1,
    release_digest: "a".repeat(64),
    store_id: S,
    connection_id: C,
    agent_principal_id: listings.principalId,
    owner_principal_id: owner.principalId,
    owner_membership_id: owner.membershipId,
    status: w.installationStatus,
    scope: scope(),
    grant_refs: refs,
    configuration_digest: "b".repeat(64),
    created_at: "2026-10-19T00:00:00.000Z",
    updated_at: "2026-10-19T00:00:00.000Z",
  };
  const parentTasks = new Set(w.hops.map((h) => h.parent_task_id));
  const actors = [
    actor(
      merchant.principalId,
      merchant.membershipId,
      w.merchantGrants.filter((g) => humanCaps.includes(g.capabilityId)),
      { membership_active: w.merchantMembershipActive },
    ),
    actor(
      listings.principalId,
      null,
      w.installationGrants.filter((g) => caps.includes(g.capabilityId)),
      {
        installation_id: I,
        role: "installation",
        principal_active: w.agentActive,
      },
    ),
    actor(
      owner.principalId,
      owner.membershipId,
      w.ownerGrants.filter((g) => humanCaps.includes(g.capabilityId)),
      { membership_active: w.ownerMembershipActive },
    ),
    actor(
      coordinator.principalId,
      null,
      w.coordinatorGrants.filter((g) => g.scope.resources.some((r) => parentTasks.has(r.id))),
      { role: "coordinator" },
    ),
  ];
  return {
    lease: JSON.stringify(w.lease),
    envelope: JSON.stringify(w.envelope),
    hops: JSON.stringify(w.hops),
    installations: JSON.stringify([installation]),
    actors: JSON.stringify(actors),
    storeCurrent: w.storeCurrent,
  };
}
// The Morrow-direct workspace with store_a linked and an active subscription.
const entitled = () =>
  rawFacts({
    route: L.routes.morrow_direct,
    associations: [directLink("iA")],
    payers: [payerFacts("morrow_w")],
  });
function decide(w, op = operation(), { billing, facts } = {}) {
  const reads = [];
  const reader = createLeaseDelegationReader({
    facts: async (envelopeId, installationId, capabilityId) => {
      reads.push([envelopeId, installationId, capabilityId]);
      return facts ? facts(w, capabilityId) : rows(w, capabilityId);
    },
    billing: billing ?? { read: async () => ({ facts: entitled(), billingPeriod: null }) },
    environment: "staging",
    clock: () => new Date(at),
  });
  const service = createAgentAuthorityService(reader, () => new Date(at));
  const result = service.decideDelegation(
    JSON.stringify({ envelopeId: "envelope_root", executorInstallationId: I, operation: op }),
  );
  return { result, reads };
}
const reason = async (w, op, options) => (await decide(w, op, options).result).decision.reason;

test("a correctly admitted run is allowed, step by step, on every Listings capability", async () => {
  for (const [capabilityId, verb] of [
    ["catalog.products.read", "view"],
    ["catalog.content.propose", "execute"],
    ["catalog.content.publish", "propose"],
  ]) {
    const { result, reads } = decide(world(), operation(capabilityId, verb));
    const r = await result;
    assert.equal(r.decision.reason, "allowed", capabilityId);
    assert.equal(r.decision.allowed, true);
    assert.deepEqual(r.lineage.requester, merchant);
    assert.deepEqual(r.lineage.dispatchers, [coordinator]);
    assert.deepEqual(r.lineage.executor, listings);
    assert.ok(r.obligations.includes("atomic_delegation_admission"));
    // The facts are read again on every call, for exactly this step.
    assert.deepEqual(reads, [["envelope_root", I, capabilityId]]);
  }
  // A solo owner who is also the requester is the usual MVP case.
  const solo = world((w) => {
    w.envelope.requester_principal_id = owner.principalId;
    w.envelope.requester_membership_id = owner.membershipId;
    w.coordinatorGrants = [coordinatorGrant({ issuedBy: owner })];
    w.lease.initiatorPrincipalId = owner.principalId;
    w.lease.initiatorMembershipId = owner.membershipId;
  });
  assert.equal(await reason(solo), "allowed");
});

test("P05.A03: an expired envelope, a disabled installation or a departed member is denied", async () => {
  const cases = [
    ["envelope expired", (w) => (w.envelope.expires_at = "2026-10-20T09:59:59.999Z")],
    ["envelope revoked", (w) => (w.envelope.revoked_at = "2026-10-20T09:30:00.000Z")],
    ["installation disabled", (w) => (w.installationStatus = "disabled")],
    ["installation uninstalled", (w) => (w.installationStatus = "uninstalled")],
    ["requester removed", (w) => (w.merchantMembershipActive = false)],
    ["owner departed", (w) => (w.ownerMembershipActive = false)],
    ["agent principal inactive", (w) => (w.agentActive = false)],
    ["hop revoked", (w) => (w.hops[0].revoked_at = "2026-10-20T09:30:00.000Z")],
    ["hop outlives its envelope", (w) => (w.hops[0].expires_at = "2026-10-20T21:00:00.000Z")],
    ["depth zero", (w) => (w.envelope.maximum_depth = 0)],
    ["no children", (w) => (w.envelope.maximum_children = 0)],
  ];
  for (const [name, edit] of cases) {
    const r = await reason(world(edit));
    assert.notEqual(r, "allowed", name);
  }
  assert.equal(
    await reason(world((w) => (w.envelope.expires_at = "2026-10-20T09:59:59.999Z"))),
    "origin_denied",
  );
  assert.equal(await reason(world((w) => (w.installationStatus = "disabled"))), "origin_denied");
  assert.equal(
    await reason(world((w) => (w.merchantMembershipActive = false))),
    "membership_revoked",
  );
});

test("lost grants: the requester's view or delegate, the Coordinator's, the owner's", async () => {
  const without = (list, id, verb) =>
    list.map((g) => (g.id === id ? { ...g, verbs: g.verbs.filter((v) => v !== verb) } : g));
  assert.equal(
    await reason(
      world((w) => (w.merchantGrants = without(w.merchantGrants, "merchant_read", "view"))),
    ),
    "capability_denied",
  );
  assert.equal(
    await reason(
      world((w) => (w.merchantGrants = without(w.merchantGrants, "merchant_read", "delegate"))),
    ),
    "capability_denied",
  );
  assert.equal(
    await reason(
      world(
        (w) =>
          (w.coordinatorGrants = [coordinatorGrant({ expiresAt: "2026-10-20T09:59:59.999Z" })]),
      ),
    ),
    "capability_denied",
  );
  assert.equal(await reason(world((w) => (w.coordinatorGrants = []))), "capability_denied");
  // The Coordinator's grant on another task does not cover this hop's parent.
  assert.equal(
    await reason(
      world(
        (w) =>
          (w.coordinatorGrants = [
            {
              ...coordinatorGrant(),
              scope: { ...coordinatorGrant().scope, resources: [{ ...task, id: "task_other" }] },
            },
          ]),
      ),
    ),
    "capability_denied",
  );
  // The installation never exceeds its owner.
  assert.equal(
    await reason(world((w) => (w.ownerGrants = without(w.ownerGrants, "owner_read", "view")))),
    "capability_denied",
  );
  // A revoked installation grant (its digest no longer matches the reference).
  assert.notEqual(
    await reason(
      world((w) => (w.installationGrants[2] = { ...w.installationGrants[2], revokedAt: at })),
    ),
    "allowed",
  );
  // The grant references drifted from the stored grants.
  assert.equal(await reason(world((w) => (w.grantDigestDrift = true))), "origin_denied");
  // A policy revision the facts no longer agree on.
  assert.notEqual(
    await reason(world(), operation(), {
      facts: (w, c) => {
        const r = rows(w, c);
        const actors = JSON.parse(r.actors);
        actors[1].policy_revision = 2;
        return { ...r, actors: JSON.stringify(actors) };
      },
    }),
    "allowed",
  );
});

test("P05.A02: a refund through the Listings route is denied; so is any capability outside it", async () => {
  const refund = {
    capabilityId: "orders.refund.create",
    verb: "propose",
    resource: store,
    accountId: null,
    fields: ["title"],
  };
  assert.notEqual(await reason(world(), refund), "allowed");
  // Even when the requester holds it and the hop names it, the envelope and the
  // installation do not.
  const widened = world((w) => {
    w.merchantGrants.push(
      grant(
        "merchant_refund",
        merchant,
        "orders.refund.create",
        ["propose", "delegate"],
        scope(),
        linking,
      ),
    );
    w.hops[0].capability_ids.push("orders.refund.create");
  });
  assert.equal(await reason(widened, refund), "origin_denied");
  // approve or execute on catalog.content.publish is never the agent's.
  for (const verb of ["approve", "execute"])
    assert.notEqual(
      await reason(world(), operation("catalog.content.publish", verb)),
      "allowed",
      verb,
    );
  // A field outside the listing fields, or another store's resource.
  assert.notEqual(await reason(world(), { ...operation(), fields: ["vendor"] }), "allowed");
  assert.notEqual(
    await reason(world(), { ...operation(), resource: storeResource(O, W, "store_b", C) }),
    "allowed",
  );
});

test("providers and entitlement: a stopped or unlinked store, and no entitlement, deny", async () => {
  assert.equal(await reason(world((w) => (w.storeCurrent = false))), "provider_denied");
  // An open route (no subscription) gives no entitlement; only entitlementFor decides.
  assert.equal(
    await reason(world(), operation(), {
      billing: {
        read: async () => ({ facts: rawFacts({ route: L.routes.open }), billingPeriod: null }),
      },
    }),
    "entitlement_denied",
  );
  // A store the subscription does not cover.
  assert.equal(
    await reason(world(), operation(), {
      billing: {
        read: async () => ({
          facts: rawFacts({
            route: L.routes.morrow_direct,
            associations: [],
            payers: [payerFacts("morrow_w")],
          }),
          billingPeriod: null,
        }),
      },
    }),
    "entitlement_denied",
  );
});

test("missing or malformed facts, or a billing reader failure, deny", async () => {
  const unavailable = (e) =>
    e instanceof AgentAuthorityError && e.code === "AGENT_POLICY_AUTHORITY_UNAVAILABLE";
  for (const facts of [
    () => null,
    (w, c) => ({ ...rows(w, c), lease: JSON.stringify({ ...w.lease, kind: "read" }) }),
    (w, c) => ({ ...rows(w, c), lease: JSON.stringify({ ...w.lease, installationId: "other" }) }),
    (w, c) => ({ ...rows(w, c), envelope: "{" }),
    (w, c) => ({ ...rows(w, c), installations: "[]" }),
    (w, c) => {
      const r = rows(w, c);
      const actors = JSON.parse(r.actors);
      actors[0].grant_count = 99;
      return { ...r, actors: JSON.stringify(actors) };
    },
    (w, c) => {
      const r = rows(w, c);
      return { ...r, actors: JSON.stringify(JSON.parse(r.actors).slice(1)) };
    },
    (w, c) => {
      const r = rows(w, c);
      const hops = JSON.parse(r.hops);
      hops[0].dispatcher_kind = "unknown";
      return { ...r, hops: JSON.stringify(hops) };
    },
  ])
    await assert.rejects(decide(world(), operation(), { facts }).result, unavailable);
  // A billing reader that throws denies.
  await assert.rejects(
    decide(world(), operation(), {
      billing: {
        read: async () => {
          throw Error("down");
        },
      },
    }).result,
    unavailable,
  );
  // M5 PR-1's own reader (@morrow/work/billing createBillingFactsReader): a failed read
  // denies, and a workspace with no billing records is never entitled.
  const down = createBillingFactsReader(async () => {
    throw Error("down");
  });
  await assert.rejects(down.read({ organizationId: O, workspaceId: W }), /down/);
  await assert.rejects(decide(world(), operation(), { billing: down }).result, unavailable);
  const empty = createBillingFactsReader(async () => []);
  assert.equal((await empty.read({ organizationId: O, workspaceId: W })).billingPeriod, null);
  assert.equal(await reason(world(), operation(), { billing: empty }), "entitlement_denied");
  // The reader requires every port, and automation never authorises anything.
  assert.throws(() => createLeaseDelegationReader({}), DelegationFactsUnavailable);
  const reader = createLeaseDelegationReader({
    facts: async () => null,
    billing: down,
    environment: "staging",
    clock: () => new Date(at),
  });
  await assert.rejects(reader.readAutomationCurrent(), DelegationFactsUnavailable);
  const service = createAgentAuthorityService(reader, () => new Date(at));
  await assert.rejects(
    service.decideAutomation(
      JSON.stringify({ mandateId: "mandate_1", executorInstallationId: I, operation: operation() }),
    ),
    unavailable,
  );
});

test("the reader is the only agent fact writer of entitlementAllowed (boundary allowlist)", async () => {
  const { entitlementWriterAllowlist, inspectEntitlementWriters } = await import(
    "../scripts/boundary-checks.mjs"
  );
  const { readFileSync } = await import("node:fs");
  const file = "packages/work/src/agents/delegation-reader.ts";
  assert.deepEqual([...entitlementWriterAllowlist[file]], ["createLeaseDelegationReader"]);
  assert.deepEqual(inspectEntitlementWriters(file, readFileSync(file, "utf8")), []);
  // Any other function writing it is flagged.
  const forged = "export function other() { return { entitlementAllowed: true }; }";
  assert.notDeepEqual(inspectEntitlementWriters(file, forged), []);
  assert.ok(listingFieldPaths.length === 5);
});
