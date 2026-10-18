import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createHumanPolicyService,
  isCurrentGrant,
  isPaidWork,
} from "../packages/policy/src/index.ts";
import { paidWorkCapabilityIds } from "../packages/policy/src/paid-work.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
const at = "2026-10-06T18:00:00.000Z";
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
  storeId: "store_a",
  connectionId: "connection_a",
  kind: "product",
  id: "product_a",
};
function fixture() {
  const request = {
    capabilityId: "catalog.products.read",
    verb: "view",
    resource: structuredClone(resource),
    accountId: "account_a",
    fields: ["title", "description"],
  };
  const grant = {
    id: "grant_a",
    principal: structuredClone(actor),
    capabilityId: request.capabilityId,
    verbs: ["view"],
    scope: {
      organizationId: "org_a",
      workspaceId: "workspace_a",
      storeIds: ["store_a"],
      accountIds: ["account_a"],
      resources: [structuredClone(resource)],
      fields: ["title", "description"],
    },
    issuedBy: structuredClone(actor),
    validFrom: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  };
  const authority = {
    actor: structuredClone(actor),
    policyRevision: 2,
    grantsRevision: 2,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource: structuredClone(resource),
    accountId: "account_a",
    providerAllowed: true,
    entitlementAllowed: true,
    grants: [grant],
  };
  return { request, grant, authority };
}
const service = (a) =>
  createHumanPolicyService(
    {
      async readCurrent() {
        return a;
      },
    },
    () => new Date(at),
  );
async function reason(f) {
  return (await service(f.authority).decide(f.request)).decision.reason;
}
test("exact eligible grant returns canonical decision and no execution authority", async () => {
  const f = fixture(),
    r = await service(f.authority).decide(f.request);
  assert.equal(r.decision.allowed, true);
  assert.equal(r.decision.policyRevision, 2);
  assert.ok(validateDefinition("core", "PolicyDecision", r.decision));
  assert.deepEqual(r.obligations, ["recheck_at_dispatch"]);
});
for (const verb of ["propose", "approve", "execute", "delegate", "administer"])
  test("view cannot manufacture " + verb + " permission", async () => {
    const f = fixture();
    f.request.verb = verb;
    assert.equal(await reason(f), "capability_denied");
  });
for (const [name, change, expected] of [
  ["organization", (f) => (f.request.resource.organizationId = "org_b"), "scope_denied"],
  ["workspace", (f) => (f.request.resource.workspaceId = "workspace_b"), "scope_denied"],
  ["store", (f) => (f.request.resource.storeId = "store_b"), "scope_denied"],
  ["connection", (f) => (f.request.resource.connectionId = "connection_b"), "scope_denied"],
  ["resource", (f) => (f.request.resource.id = "product_b"), "scope_denied"],
  ["account", (f) => (f.request.accountId = "account_b"), "scope_denied"],
  ["ungranted store", (f) => (f.grant.scope.storeIds = ["store_b"]), "scope_denied"],
  ["ungranted account", (f) => (f.grant.scope.accountIds = ["account_b"]), "scope_denied"],
  ["ungranted resource", (f) => (f.grant.scope.resources[0].id = "product_b"), "scope_denied"],
  ["ungranted field", (f) => f.request.fields.push("cost"), "field_denied"],
  ["revoked grant", (f) => (f.grant.revokedAt = at), "capability_denied"],
  ["expired grant", (f) => (f.grant.expiresAt = at), "capability_denied"],
  ["future grant", (f) => (f.grant.validFrom = "2026-10-07T00:00:00.000Z"), "capability_denied"],
  ["future policy grant", (f) => (f.grant.policyRevision = 3), "capability_denied"],
  ["wrong grant actor", (f) => (f.grant.principal.principalId = "human_b"), "capability_denied"],
  [
    "wrong membership grant",
    (f) => (f.grant.principal.membershipId = "membership_b"),
    "capability_denied",
  ],
  [
    "wrong issuer organization",
    (f) => (f.grant.issuedBy.organizationId = "org_b"),
    "capability_denied",
  ],
  [
    "wrong issuer workspace",
    (f) => (f.grant.issuedBy.workspaceId = "workspace_b"),
    "capability_denied",
  ],
  ["stale grants snapshot", (f) => (f.authority.grantsRevision = 1), "precondition_conflict"],
  ["provider denied", (f) => (f.authority.providerAllowed = false), "provider_denied"],
  // P01.T04a: entitlement gates only paid work, so the denial row uses a billable job.
  [
    "entitlement denied on paid work",
    (f) => {
      retarget(f, "creative.image.generate", "execute", "artifact", ["briefRef"]);
      f.authority.entitlementAllowed = false;
    },
    "entitlement_denied",
  ],
  [
    "unknown capability",
    (f) => (f.request.capabilityId = "invented.capability.read"),
    "capability_denied",
  ],
])
  test("deny " + name, async () => {
    const f = fixture();
    change(f);
    const r = await service(f.authority).decide(f.request);
    assert.equal(r.decision.reason, expected);
    assert.equal(r.decision.allowed, false);
    assert.deepEqual(r.obligations, []);
    assert.ok(!r.decision.safeMessage.includes("product_b"));
  });
for (const flag of [
  "principalActive",
  "organizationActive",
  "workspaceActive",
  "membershipActive",
  "sessionCurrent",
])
  test("inactive " + flag + " denies despite grant", async () => {
    const f = fixture();
    f.authority[flag] = false;
    assert.equal(await reason(f), "membership_revoked");
  });
for (const change of [
  (f) => (f.authority.actor.kind = "agent"),
  (f) => (f.authority.actor.kind = "service"),
  (f) => (f.authority.actor.installationId = "installation_a"),
  (f) => (f.authority.actor.mandateId = "mandate_a"),
])
  test("nonhuman/installation/automation is denied until qualified intersection", async () => {
    const f = fixture();
    change(f);
    assert.equal(await reason(f), "origin_denied");
  });
test("partial grants cannot be unioned into a broader field grant", async () => {
  const f = fixture();
  const other = structuredClone(f.grant);
  other.id = "grant_b";
  f.grant.scope.fields = ["title"];
  other.scope.fields = ["description"];
  f.authority.grants.push(other);
  assert.equal(await reason(f), "field_denied");
});
test("a store-specific grant cannot become storeless workspace scope", async () => {
  const f = fixture();
  f.request.resource.storeId = null;
  f.authority.resource.storeId = null;
  f.grant.scope.resources[0].storeId = null;
  assert.equal(await reason(f), "scope_denied");
});
test("an account-specific grant cannot become accountless authority", async () => {
  const f = fixture();
  f.request.accountId = null;
  f.authority.accountId = null;
  assert.equal(await reason(f), "scope_denied");
});
test("approval never manufactures execution, and execution retains exact-review/spend obligations", async () => {
  const f = fixture();
  f.request.capabilityId = "orders.refund.create";
  f.request.verb = "execute";
  f.grant.capabilityId = f.request.capabilityId;
  f.grant.verbs = ["approve"];
  assert.equal(await reason(f), "capability_denied");
  f.grant.verbs = ["execute"];
  const r = await service(f.authority).decide(f.request);
  assert.deepEqual(r.obligations, [
    "recheck_at_dispatch",
    "exact_approval",
    "budget_reservation",
    "provider_effect_verification",
  ]);
});
test("connection setup requires explicit connection capability/administer grant", async () => {
  const f = fixture();
  f.request.capabilityId = "governance.connection.connect";
  f.grant.capabilityId = f.request.capabilityId;
  f.request.verb = "execute";
  f.grant.verbs = ["execute"];
  assert.equal(await reason(f), "capability_denied");
  f.request.verb = "administer";
  f.grant.verbs = ["administer"];
  const result = await service(f.authority).decide(f.request);
  assert.equal(result.decision.reason, "allowed");
  assert.deepEqual(result.obligations, ["recheck_at_dispatch", "exact_approval"]);
});
test("a connect reviewer needs an explicit approve grant; approve never performs the connect", async () => {
  const f = fixture();
  f.request.capabilityId = "governance.connection.connect";
  f.grant.capabilityId = f.request.capabilityId;
  f.request.verb = "approve";
  f.grant.verbs = ["administer"];
  assert.equal(await reason(f), "capability_denied");
  f.grant.verbs = ["administer", "approve"];
  const result = await service(f.authority).decide(f.request);
  assert.equal(result.decision.reason, "allowed");
  assert.deepEqual(result.obligations, ["recheck_at_dispatch"]);
  for (const verb of ["view", "propose", "execute", "delegate"]) {
    f.request.verb = verb;
    f.grant.verbs = ["view", "propose", "approve", "execute", "delegate", "administer"];
    assert.equal(await reason(f), "capability_denied", verb);
  }
  // An approve-only holder cannot perform the connect itself.
  f.request.verb = "administer";
  f.grant.verbs = ["approve"];
  assert.equal(await reason(f), "capability_denied");
  // Agents, installations and mandates never review a connect, even with the grant.
  f.request.verb = "approve";
  f.grant.verbs = ["administer", "approve"];
  for (const change of [
    (a) => (a.kind = "agent"),
    (a) => (a.installationId = "installation_a"),
    (a) => (a.mandateId = "mandate_a"),
  ]) {
    const g = structuredClone(f);
    change(g.authority.actor);
    change(g.grant.principal);
    g.authority.grants = [g.grant];
    assert.equal(await reason(g), "origin_denied");
  }
});
test("workspace linking needs one grant covering the actual connection input fields before review", async () => {
  const f = fixture();
  const target = {
    ...resource,
    kind: "workspace",
    id: "workspace_a",
    storeId: null,
    connectionId: null,
  };
  f.request = {
    capabilityId: "governance.connection.connect",
    verb: "administer",
    resource: target,
    accountId: null,
    fields: ["providerId", "installationProof", "scope"],
  };
  f.authority.resource = target;
  f.authority.accountId = null;
  f.grant.capabilityId = f.request.capabilityId;
  f.grant.verbs = ["administer"];
  f.grant.scope = {
    ...f.grant.scope,
    storeIds: [],
    accountIds: [],
    resources: [target],
    fields: [...f.request.fields],
  };
  let result = await service(f.authority).decide(f.request);
  assert.equal(result.decision.allowed, true);
  assert.ok(result.obligations.includes("exact_approval"));
  for (const field of f.request.fields) {
    f.grant.scope.fields = f.request.fields.filter((value) => value !== field);
    result = await service(f.authority).decide(f.request);
    assert.equal(result.decision.reason, "field_denied");
    assert.deepEqual(result.obligations, []);
  }
});
test("fresh authority is loaded every time; removal revokes next decision", async () => {
  const f = fixture();
  let reads = 0;
  const policy = createHumanPolicyService(
    {
      async readCurrent() {
        reads++;
        return f.authority;
      },
    },
    () => new Date(at),
  );
  assert.equal((await policy.decide(f.request)).decision.allowed, true);
  f.authority.membershipActive = false;
  f.authority.policyRevision++;
  f.authority.grantsRevision++;
  assert.equal((await policy.decide(f.request)).decision.reason, "membership_revoked");
  assert.equal(reads, 2);
});
test("grant expiry uses evaluation time after the authority read", async () => {
  const f = fixture();
  f.grant.expiresAt = at;
  let now = "2026-10-06T17:00:00.000Z";
  const policy = createHumanPolicyService(
    {
      async readCurrent() {
        now = at;
        return f.authority;
      },
    },
    () => new Date(now),
  );
  assert.equal((await policy.decide(f.request)).decision.reason, "capability_denied");
});
for (const change of [
  (f) => (f.request.role = "owner"),
  (f) => (f.request.authority = f.authority),
  (f) => (f.request.verb = "connect"),
  (f) => (f.request.fields = []),
  (f) => (f.request.fields = ["*"]),
  (f) => (f.request.fields = ["title", "title"]),
  (f) => (f.request.accountId = 4),
  (f) => (f.request.resource.extra = "forged"),
])
  test("malformed/client authority input never reaches trusted reader", async () => {
    const f = fixture();
    change(f);
    let reads = 0;
    const policy = createHumanPolicyService({
      async readCurrent() {
        reads++;
        return f.authority;
      },
    });
    await assert.rejects(policy.decide(f.request), (e) => e.code === "POLICY_INPUT_INVALID");
    assert.equal(reads, 0);
  });
for (const change of [
  (f) => f.authority.grants.push(structuredClone(f.grant)),
  (f) => (f.grant.scope.fields = ["*"]),
  (f) => (f.authority.policyRevision = "2"),
  (f) => delete f.authority.providerAllowed,
  (f) => (f.authority.extra = "private_payload"),
])
  test("malformed/ambiguous server facts fail closed", async () => {
    const f = fixture();
    change(f);
    await assert.rejects(
      service(f.authority).decide(f.request),
      (e) => e.message === "POLICY_AUTHORITY_UNAVAILABLE",
    );
  });
test("getter input is rejected without invoking it", async () => {
  const f = fixture();
  let calls = 0;
  Object.defineProperty(f.request, "role", {
    enumerable: true,
    get() {
      calls++;
      throw Error("private payload");
    },
  });
  await assert.rejects(
    service(f.authority).decide(f.request),
    (e) => e.code === "POLICY_INPUT_INVALID",
  );
  assert.equal(calls, 0);
});
test("reader errors never reveal private/provider messages", async () => {
  const f = fixture();
  const policy = createHumanPolicyService({
    async readCurrent() {
      throw Error("private/provider payload");
    },
  });
  await assert.rejects(
    policy.decide(f.request),
    (e) => e.message === "POLICY_AUTHORITY_UNAVAILABLE" && e.cause === undefined,
  );
});

test("selectors cannot be mutated by the trusted reader", async () => {
  const f = fixture();
  const policy = createHumanPolicyService(
    {
      async readCurrent(request) {
        request.resource.id = "product_b";
        return f.authority;
      },
    },
    () => new Date(at),
  );
  await assert.rejects(policy.decide(f.request), (e) => e.code === "POLICY_AUTHORITY_UNAVAILABLE");
  assert.equal(f.request.resource.id, "product_a");
});
test("caller mutation while facts load cannot retarget the captured request", async () => {
  const f = fixture();
  let ready;
  const loaded = new Promise((resolve) => {
    ready = resolve;
  });
  let finish;
  const release = new Promise((resolve) => {
    finish = resolve;
  });
  const policy = createHumanPolicyService(
    {
      async readCurrent() {
        ready();
        await release;
        return f.authority;
      },
    },
    () => new Date(at),
  );
  const result = policy.decide(f.request);
  await loaded;
  f.request.resource.id = "product_b";
  finish();
  assert.equal((await result).decision.allowed, true);
});
for (const change of [
  (f) => (f.request.fields = new Array(1)),
  (f) => {
    f.request[Symbol("hidden")] = true;
  },
  (f) => {
    f.request.fields.extra = "hidden";
  },
])
  test("non-JSON selectors are rejected", async () => {
    const f = fixture();
    change(f);
    await assert.rejects(
      service(f.authority).decide(f.request),
      (e) => e.code === "POLICY_INPUT_INVALID",
    );
  });
test("proxy trap failure cannot expose arbitrary request details", async () => {
  const f = fixture();
  const value = new Proxy(f.request, {
    getPrototypeOf() {
      throw Error("private payload");
    },
  });
  await assert.rejects(
    service(f.authority).decide(value),
    (e) => e.message === "POLICY_INPUT_INVALID",
  );
});

for (const capability of [
  "agents.skill.research",
  "agents.release.evaluate",
  "agents.release.publish",
  "agents.release.revoke",
])
  test("merchant authority cannot authorize operator capability: " + capability, async () => {
    const f = fixture();
    f.request.capabilityId = capability;
    f.grant.capabilityId = capability;
    f.request.verb = "administer";
    f.grant.verbs = ["administer"];
    const target = {
      ...resource,
      kind: "release",
      id: "release_a",
      storeId: null,
      connectionId: null,
    };
    f.request.resource = structuredClone(target);
    f.authority.resource = structuredClone(target);
    f.grant.scope.resources = [structuredClone(target)];
    f.request.accountId = null;
    f.authority.accountId = null;
    f.grant.scope.storeIds = [];
    f.grant.scope.accountIds = [];
    f.request.fields = ["digest"];
    f.grant.scope.fields = ["digest"];
    assert.equal(await reason(f), "capability_denied");
  });

// P01.T02a PR-A (AC08): kill switches act without a second approver (ADR-0005).
function retarget(f, capabilityId, verb, kind, fields) {
  const target = { ...resource, kind, id: `${kind}_a` };
  f.request = { capabilityId, verb, resource: target, accountId: "account_a", fields };
  f.authority.resource = structuredClone(target);
  f.grant.capabilityId = capabilityId;
  f.grant.verbs = [verb];
  f.grant.scope.resources = [structuredClone(target)];
  f.grant.scope.fields = [...fields];
  return f;
}
for (const [capabilityId, kind, fields, verification] of [
  ["governance.membership.revoke", "member", ["membership"], []],
  ["governance.connection.disconnect", "workspace", ["connection_state"], []],
  ["agents.installation.disable", "installation", ["dispatch_state"], []],
  ["ads.campaign.pause", "campaign", ["delivery_status"], ["provider_effect_verification"]],
])
  test("AC08: a human executes " + capabilityId + " with no approval obligation", async () => {
    const f = retarget(fixture(), capabilityId, "execute", kind, fields);
    const r = await service(f.authority).decide(f.request);
    assert.equal(r.decision.allowed, true);
    assert.deepEqual(r.obligations, ["recheck_at_dispatch", "kill_switch_record", ...verification]);
    assert.ok(!r.obligations.includes("exact_approval"));
    assert.ok(!r.obligations.includes("budget_reservation"));
    // Proposing a stop records nothing and needs no approval either.
    const proposal = retarget(fixture(), capabilityId, "propose", kind, fields);
    assert.deepEqual((await service(proposal.authority).decide(proposal.request)).obligations, [
      "recheck_at_dispatch",
    ]);
    // A stop still needs a current grant for the verb.
    f.grant.verbs = ["view"];
    assert.equal(await reason(f), "capability_denied");
  });
test("AC08: reversals still require exact approval", async () => {
  const f = retarget(fixture(), "ads.campaign.activate", "execute", "campaign", [
    "delivery_status",
  ]);
  assert.deepEqual((await service(f.authority).decide(f.request)).obligations, [
    "recheck_at_dispatch",
    "exact_approval",
    "budget_reservation",
    "provider_effect_verification",
  ]);
  for (const [capabilityId, kind] of [
    ["agents.installation.activate", "installation"],
    ["governance.membership.invite", "member"],
    ["governance.grants.revise", "member"],
  ]) {
    const g = retarget(fixture(), capabilityId, "execute", kind, ["status"]);
    assert.deepEqual((await service(g.authority).decide(g.request)).obligations, [
      "recheck_at_dispatch",
      "exact_approval",
    ]);
  }
});
// P01.T02a PR-B (AC26): stops are never billing-gated, but stay provider-limited (ADR-0011 Q8).
test("AC26: entitlement never blocks a kill switch; provider limits still apply", async () => {
  for (const [capabilityId, kind, fields, verification] of [
    ["governance.connection.disconnect", "workspace", ["connection_state"], []],
    ["ads.campaign.pause", "campaign", ["delivery_status"], ["provider_effect_verification"]],
  ]) {
    const f = retarget(fixture(), capabilityId, "execute", kind, fields);
    f.authority.entitlementAllowed = false;
    const r = await service(f.authority).decide(f.request);
    assert.equal(r.decision.allowed, true, capabilityId);
    assert.deepEqual(r.obligations, ["recheck_at_dispatch", "kill_switch_record", ...verification]);
    assert.ok(!r.obligations.includes("budget_reservation"));
  }
  const activate = retarget(fixture(), "ads.campaign.activate", "execute", "campaign", [
    "delivery_status",
  ]);
  activate.authority.entitlementAllowed = false;
  assert.equal(await reason(activate), "entitlement_denied");
  const pause = retarget(fixture(), "ads.campaign.pause", "execute", "campaign", [
    "delivery_status",
  ]);
  pause.authority.providerAllowed = false;
  assert.equal(await reason(pause), "provider_denied");
  pause.authority.entitlementAllowed = false;
  assert.equal(await reason(pause), "provider_denied");
});

// P01.T04a PR-A: entitlement gates only paid work (ADR-0015 item 5, ADR-0011 Q8).
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const templates = JSON.parse(
  readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8"),
).templates;
const allVerbs = ["view", "propose", "approve", "execute", "delegate", "administer"];
const without = ({ decisionId, ...decision }) => decision;
test("P01.T04a: an unpaid read is allowed without entitlement", async () => {
  const f = fixture();
  f.authority.entitlementAllowed = false;
  const r = await service(f.authority).decide(f.request);
  assert.equal(r.decision.allowed, true);
  assert.deepEqual(r.obligations, ["recheck_at_dispatch"]);
});
test("P01.T04a AC02: entitlement changes a decision only for paid work, across the catalogue", async () => {
  const deniedForBilling = new Set();
  let unpaid = 0;
  for (const capability of catalogue.capabilities)
    for (const verb of allVerbs) {
      const decide = async (entitled) => {
        const f = fixture();
        f.request.capabilityId = capability.id;
        f.request.verb = verb;
        f.grant.capabilityId = capability.id;
        f.grant.verbs = [...allVerbs];
        f.authority.entitlementAllowed = entitled;
        const r = await service(f.authority).decide(f.request);
        return { decision: without(r.decision), obligations: [...r.obligations] };
      };
      const entitled = await decide(true),
        unentitled = await decide(false);
      const label = `${capability.id} ${verb}`;
      if (!isPaidWork(capability.id, verb) || !entitled.decision.allowed) {
        assert.deepEqual(unentitled, entitled, label);
        if (entitled.decision.allowed) unpaid++;
      } else {
        assert.equal(unentitled.decision.reason, "entitlement_denied", label);
        assert.equal(unentitled.decision.allowed, false, label);
        assert.deepEqual(unentitled.obligations, [], label);
        assert.ok(["execute", "administer"].includes(verb), label);
        deniedForBilling.add(capability.id);
      }
    }
  // Every paid capability a merchant can hold is billing-gated; operator
  // capabilities are denied earlier under both. Reads, setup, linking,
  // invitations, approvals, exports, privacy, propose and stops are not.
  const merchantPaid = paidWorkCapabilityIds.filter(
    (id) =>
      !catalogue.capabilities.find((c) => c.id === id).eligible_principal.startsWith("operator_"),
  );
  assert.deepEqual([...deniedForBilling].sort(), merchantPaid);
  assert.ok(unpaid > 300, String(unpaid));
  for (const id of [
    "governance.usage.read",
    "governance.membership.invite",
    "governance.connection.disconnect",
    "governance.audit.export",
    "governance.privacy.export",
    "workspace.goal.create",
    "ads.campaign.pause",
  ])
    assert.ok(!deniedForBilling.has(id), id);
});
test("P01.T04a AC03: administer is gated on paid work and allowed on linking", async () => {
  const paid = retarget(fixture(), "creative.image.generate", "administer", "artifact", [
    "briefRef",
  ]);
  paid.authority.entitlementAllowed = false;
  assert.equal(await reason(paid), "entitlement_denied");
  paid.authority.entitlementAllowed = true;
  assert.equal(await reason(paid), "allowed");
  const connect = retarget(fixture(), "governance.connection.connect", "administer", "workspace", [
    "providerId",
  ]);
  connect.authority.entitlementAllowed = false;
  assert.equal(await reason(connect), "allowed");
});
test("P01.T04a AC04: every kill switch executes without entitlement; provider limits still apply", async () => {
  const stops = catalogue.capabilities.filter((c) => c.kill_switch);
  assert.equal(stops.length, 5);
  for (const stop of stops) {
    const f = retarget(fixture(), stop.id, "execute", "member", ["control"]);
    f.authority.entitlementAllowed = false;
    const r = await service(f.authority).decide(f.request);
    assert.equal(isPaidWork(stop.id, "execute"), false, stop.id);
    // A release revocation is an operator capability, denied to merchants under both.
    if (stop.eligible_principal.startsWith("operator_")) {
      assert.equal(r.decision.reason, "capability_denied", stop.id);
      continue;
    }
    assert.equal(r.decision.allowed, true, stop.id);
    assert.ok(r.obligations.includes("kill_switch_record"), stop.id);
    assert.ok(!r.obligations.includes("budget_reservation"), stop.id);
  }
  const pause = retarget(fixture(), "ads.campaign.pause", "execute", "campaign", [
    "delivery_status",
  ]);
  pause.authority.providerAllowed = false;
  pause.authority.entitlementAllowed = false;
  assert.equal(await reason(pause), "provider_denied");
  const activate = retarget(fixture(), "ads.campaign.activate", "execute", "campaign", [
    "delivery_status",
  ]);
  activate.authority.entitlementAllowed = false;
  assert.equal(await reason(activate), "entitlement_denied");
});
test("P01.T04a AC05: every ADR grant template row works without entitlement; paid execute does not", async () => {
  const workspace = {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: "workspace_a",
  };
  let rows = 0,
    connectApprove = 0;
  for (const [template, list] of Object.entries(templates))
    for (const row of list)
      for (const verb of row.verbs) {
        const decide = async (entitled) => {
          const f = fixture();
          f.request = {
            capabilityId: row.capabilityId,
            verb,
            resource: structuredClone(workspace),
            accountId: null,
            fields: [...row.fields],
          };
          f.authority.resource = structuredClone(workspace);
          f.authority.accountId = null;
          f.grant.capabilityId = row.capabilityId;
          f.grant.verbs = [...row.verbs];
          f.grant.scope = {
            ...f.grant.scope,
            storeIds: [],
            accountIds: [],
            resources: [structuredClone(workspace)],
            fields: [...row.fields],
          };
          f.authority.entitlementAllowed = entitled;
          const r = await service(f.authority).decide(f.request);
          return { decision: without(r.decision), obligations: [...r.obligations] };
        };
        const unentitled = await decide(false);
        const label = `${template} ${row.capabilityId} ${verb}`;
        assert.deepEqual(unentitled, await decide(true), label);
        // Billing never decides a template row: every row is allowed without an
        // entitlement, including connect `approve`, which the connection rule
        // allows since P05.T01x Part B (ADR-0011 Q5, ADR-0009 item 7).
        assert.notEqual(unentitled.decision.reason, "entitlement_denied", label);
        assert.equal(unentitled.decision.allowed, true, label);
        if (row.capabilityId === "governance.connection.connect" && verb === "approve")
          connectApprove++;
        rows++;
      }
  assert.ok(rows >= 40, String(rows));
  // owner-bootstrap-v1 and workspace-admin-v1 each hold connect `approve`.
  assert.equal(connectApprove, 2);
  for (const capabilityId of [
    "creative.image.generate",
    "catalog.content.publish",
    "support.reply.send",
    "orders.refund.create",
  ]) {
    const f = retarget(fixture(), capabilityId, "execute", "product", ["title"]);
    f.authority.entitlementAllowed = false;
    assert.equal(await reason(f), "entitlement_denied", capabilityId);
    const proposal = retarget(fixture(), capabilityId, "propose", "product", ["title"]);
    proposal.authority.entitlementAllowed = false;
    assert.equal(await reason(proposal), "allowed", capabilityId);
  }
});
test("P01.T04a: isCurrentGrant is the evaluator's current-grant rule", () => {
  const { grant } = fixture();
  const now = Date.parse(at);
  assert.equal(isCurrentGrant(grant, actor, "catalog.products.read", "view", 2, now), true);
  for (const [name, args] of [
    ["verb", [grant, actor, "catalog.products.read", "execute", 2, now]],
    ["capability", [grant, actor, "catalog.products.write", "view", 2, now]],
    ["policy revision", [grant, actor, "catalog.products.read", "view", 0, now]],
    [
      "before validity",
      [grant, actor, "catalog.products.read", "view", 2, Date.parse("2026-09-01T00:00:00Z")],
    ],
    ["revoked", [{ ...grant, revokedAt: at }, actor, "catalog.products.read", "view", 2, now]],
    ["expired", [{ ...grant, expiresAt: at }, actor, "catalog.products.read", "view", 2, now]],
    [
      "other actor",
      [grant, { ...actor, principalId: "human_b" }, "catalog.products.read", "view", 2, now],
    ],
    [
      "foreign issuer",
      [
        { ...grant, issuedBy: { ...actor, workspaceId: "workspace_b" } },
        actor,
        "catalog.products.read",
        "view",
        2,
        now,
      ],
    ],
  ])
    assert.equal(isCurrentGrant(...args), false, name);
});
