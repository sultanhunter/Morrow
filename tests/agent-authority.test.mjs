import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createAgentAuthorityService,
  canonicalPayloadDigest,
  AgentAuthorityError,
} from "../packages/policy/src/agent-authority.ts";
import { createHumanPolicyService } from "../packages/policy/src/index.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import {
  delegationFixture,
  delegationChainFixture,
  automationFixture,
  synchronizeExecutor,
  synchronizeMandate,
  actor,
  authority,
  resource,
  scope,
  grant,
  digest,
  clone,
  at,
  from,
  until,
} from "./fixtures/agent-authority.mjs";

function harness(fixture, mode = "delegation", overrides = {}) {
  const calls = [];
  const reader = {
    async readDelegationCurrent(input) {
      calls.push(input);
      return JSON.stringify(fixture.facts);
    },
    async readAutomationCurrent(input) {
      calls.push(input);
      return JSON.stringify(fixture.facts);
    },
    ...overrides,
  };
  const service = createAgentAuthorityService(reader, () => new Date(at));
  const decide = () =>
    mode === "delegation"
      ? service.decideDelegation(JSON.stringify(fixture.input))
      : service.decideAutomation(JSON.stringify(fixture.input));
  return { calls, service, decide };
}
async function allowed(fixture, mode = "delegation") {
  const result = await harness(fixture, mode).decide();
  assert.equal(result.decision.allowed, true);
  assert.equal(validateDefinition("core", "PolicyDecision", result.decision), true);
  assert.ok(result.obligations.includes("recheck_at_dispatch"));
  assert.ok(result.obligations.includes("qualified_dispatch"));
  assert.ok(result.lineage);
  return result;
}
async function denied(fixture, mode = "delegation") {
  const result = await harness(fixture, mode).decide();
  assert.equal(result.decision.allowed, false);
  assert.equal(validateDefinition("core", "PolicyDecision", result.decision), true);
  assert.equal(result.lineage, null);
  assert.deepEqual(result.obligations, []);
  return result;
}
async function unavailable(fixture, mode = "delegation") {
  await assert.rejects(harness(fixture, mode).decide(), (error) => {
    assert.ok(error instanceof AgentAuthorityError);
    assert.equal(error.code, "AGENT_POLICY_AUTHORITY_UNAVAILABLE");
    return true;
  });
}
function retarget(fixture, capabilityId, verb, kind = "order", fields = ["refund_amount"]) {
  const operation = fixture.input.operation;
  Object.assign(operation, {
    capabilityId,
    verb,
    resource: resource(kind, `${kind}_a`),
    fields: [...fields],
  });
  const domainScope = scope([operation.resource], fields);
  if (fixture.facts.envelope) {
    const { envelope, hops, origin } = fixture.facts;
    Object.assign(envelope, {
      capabilityIds: [capabilityId],
      verbs: [verb],
      scope: clone(domainScope),
    });
    for (const hop of hops)
      Object.assign(hop, {
        capabilityIds: [capabilityId],
        verbs: [verb],
        scope: clone(domainScope),
      });
    origin.grants[0] = grant("owner_tool", origin.actor, capabilityId, [verb], domainScope);
    origin.grants[1] = grant(
      "owner_tool_delegate",
      origin.actor,
      capabilityId,
      ["delegate"],
      domainScope,
    );
  } else {
    fixture.facts.mandate.payload.capabilityIds = [capabilityId];
    fixture.facts.mandate.payload.scope = clone(domainScope);
  }
  const executor = fixture.facts.executor;
  executor.installation.scope = clone(domainScope);
  executor.current.grants = [
    grant("specialist_tool", executor.current.actor, capabilityId, [verb], domainScope),
  ];
  executor.owner.grants[0] = grant(
    "installation_owner_tool",
    executor.owner.actor,
    capabilityId,
    [verb],
    domainScope,
  );
  fixture.facts.constraints.resource = clone(operation.resource);
  synchronizeExecutor(fixture.facts);
  if (fixture.facts.mandate) synchronizeMandate(fixture.facts);
  return fixture;
}

test("owner delegates through a built-in coordinator lacking the domain tool to a qualified specialist", async () => {
  const f = delegationFixture();
  const dispatcher = f.facts.hops[0].dispatcher;
  assert.equal(dispatcher.kind, "builtin_coordinator");
  assert.equal(dispatcher.installed, null);
  assert.equal(dispatcher.current.actor.installationId, null);
  assert.ok(
    dispatcher.current.grants.every(
      (g) => g.capabilityId === "workspace.task.delegate" && g.verbs.includes("delegate"),
    ),
  );
  const result = await allowed(f);
  assert.deepEqual(clone(result.lineage.requester), f.facts.envelope.requester);
  assert.deepEqual(clone(result.lineage.authorizer), f.facts.envelope.authorizer);
  assert.deepEqual(clone(result.lineage.executor), f.facts.executor.current.actor);
  assert.deepEqual(clone(result.lineage.dispatchers), [dispatcher.current.actor]);
  assert.equal(result.lineage.envelopeId, f.input.envelopeId);
  assert.ok(result.obligations.includes("atomic_delegation_admission"));
});

test("a qualified refund specialist cannot expand the originating SEO principal's authority", async () => {
  const f = retarget(delegationFixture(), "orders.refund.create", "execute");
  await allowed(f);
  f.facts.origin.grants = [
    grant("seo_view", f.facts.origin.actor, "catalog.products.read", ["view", "delegate"], scope()),
    f.facts.origin.grants.find((g) => g.capabilityId === "workspace.task.delegate"),
  ];
  await denied(f);
});

test("a teammate can use an administrator-owned installation, with both humans' independent authority", async () => {
  const f = delegationFixture();
  const admin = actor("administrator");
  f.facts.executor.installation.owner = clone(admin);
  f.facts.executor.owner = authority(admin, [
    grant(
      "administrator_tool",
      admin,
      f.input.operation.capabilityId,
      [f.input.operation.verb],
      scope(),
    ),
  ]);
  await allowed(f);
  f.facts.executor.owner.membershipActive = false;
  await denied(f);
});

test("shared installation owner power cannot repair missing requester or installation-owner grants", async () => {
  const f = delegationFixture();
  const admin = actor("administrator");
  f.facts.executor.installation.owner = clone(admin);
  f.facts.executor.owner = authority(admin, [
    grant("admin_tool", admin, f.input.operation.capabilityId, ["view", "execute"], scope()),
  ]);
  f.facts.origin.grants[0].scope.fields = ["title"];
  await denied(f);
  f.facts.origin.grants[0].scope.fields = ["title", "description"];
  f.facts.executor.owner.grants = [];
  await denied(f);
});

test("dispatch permission is a whole parent-task grant separate from domain execute and delegation", async () => {
  for (const change of [
    (f) => {
      f.facts.hops[0].dispatcher.current.grants = [];
    },
    (f) => {
      f.facts.hops[0].dispatcher.current.grants[0].verbs = ["execute"];
    },
    (f) => {
      f.facts.hops[0].dispatcher.current.grants[0].scope.resources[0].id = "other_parent_task";
    },
    (f) => {
      f.facts.hops[0].dispatcher.current.grants[0].scope.fields = ["taskId", "installationId"];
    },
    (f) => {
      f.facts.origin.grants = f.facts.origin.grants.filter((g) => !g.verbs.includes("delegate"));
    },
  ]) {
    const f = delegationFixture();
    change(f);
    await denied(f);
  }
});

test("a storeless parent task uses its explicit scope rather than the child tool's store", async () => {
  const f = delegationFixture();
  const parent = f.facts.hops[0].parentTaskResource;
  parent.storeId = null;
  for (const current of [f.facts.origin, f.facts.hops[0].dispatcher.current]) {
    const dispatch = current.grants.find((g) => g.capabilityId === "workspace.task.delegate");
    dispatch.scope.storeIds = [];
    dispatch.scope.resources = [clone(parent)];
  }
  await allowed(f);
});

test("no layer may union two partial field grants into one whole operation", async () => {
  for (const select of [
    (f) => f.facts.origin,
    (f) => f.facts.executor.owner,
    (f) => f.facts.executor.current,
  ]) {
    const f = delegationFixture();
    const target = select(f);
    const complete = target.grants.find(
      (g) => g.capabilityId === f.input.operation.capabilityId && g.verbs.includes("view"),
    );
    complete.scope.fields = ["title"];
    const fragment = clone(complete);
    fragment.id += "_fragment";
    fragment.scope.fields = ["description"];
    target.grants.push(fragment);
    synchronizeExecutor(f.facts);
    await denied(f);
  }
});

test("separate resource and store grants cannot be joined into synthetic authority", async () => {
  const f = delegationFixture();
  const first = f.facts.origin.grants[0];
  const second = clone(first);
  second.id += "_other";
  first.scope.resources[0].id = "other_product";
  second.scope.storeIds = ["other_store"];
  f.facts.origin.grants.push(second);
  await denied(f);
});

test("larger current grants never widen an original envelope or a narrowed hop", async () => {
  for (const select of [
    (f) => f.facts.envelope.scope,
    (f) => f.facts.hops[0].scope,
    (f) => f.facts.executor.installation.scope,
  ]) {
    const f = delegationFixture();
    select(f).fields = ["title"];
    await denied(f);
  }
});

test("origin execution and same-capability delegation are independent whole-operation grants", async () => {
  for (const verb of ["view", "delegate"]) {
    const f = delegationFixture();
    const g = f.facts.origin.grants.find(
      (grant) =>
        grant.capabilityId === f.input.operation.capabilityId && grant.verbs.includes(verb),
    );
    g.scope.fields = ["title"];
    await denied(f);
  }
});

test("exact installed grant record revision is independent from its policy revision", async () => {
  const f = delegationFixture();
  assert.equal(f.facts.executor.grantRecords[0].recordRevision, 41);
  assert.equal(f.facts.executor.grantRecords[0].payload.policyRevision, 3);
  assert.equal(f.facts.executor.installation.grantRefs[0].revision, 41);
  await allowed(f);
  f.facts.executor.installation.grantRefs[0].revision = 3;
  await denied(f);
});

test("installation grant refs bind ID, record revision, digest, organization, workspace and store", async () => {
  for (const [key, value] of [
    ["id", "foreign_grant"],
    ["revision", 42],
    ["digest", "f".repeat(64)],
    ["organizationId", "other_org"],
    ["workspaceId", "other_workspace"],
    ["storeId", null],
  ]) {
    const f = delegationFixture();
    f.facts.executor.installation.grantRefs[0][key] = value;
    await denied(f);
  }
});

test("a correctly rehashed but revoked executor grant is still denied", async () => {
  const f = delegationFixture();
  f.facts.executor.current.grants[0].revokedAt = at;
  synchronizeExecutor(f.facts);
  await denied(f);
});

test("record payload and current-grant drift, duplicate records or dangling refs never authorize", async () => {
  for (const change of [
    (f) => {
      f.facts.executor.grantRecords[0].payload.scope.fields = ["title"];
    },
    (f) => {
      f.facts.executor.grantRecords[0].recordRevision++;
    },
    (f) => {
      f.facts.executor.grantRecords[0].storeId = null;
    },
    (f) => {
      f.facts.executor.grantRecords.push(clone(f.facts.executor.grantRecords[0]));
    },
    (f) => {
      f.facts.executor.grantRecords = [];
    },
  ]) {
    const f = delegationFixture();
    change(f);
    await denied(f);
  }
});

test("caller cannot transfer requester/authorizer lineage to a stronger human", async () => {
  for (const field of ["requester", "authorizer"]) {
    const f = delegationFixture();
    f.facts.envelope[field] = actor("another_admin");
    await denied(f);
  }
});

test("widened or broken child envelopes deny even when the requested tool itself fits", async () => {
  for (const change of [
    (h) => {
      h.scope.fields.push("price");
    },
    (h) => {
      h.scope.resources.push(resource("product", "product_extra"));
    },
    (h) => {
      h.capabilityIds.push("orders.read");
    },
    (h) => {
      h.verbs.push("execute");
    },
    (h) => {
      h.validFrom = "2026-09-01T00:00:00.000Z";
    },
    (h) => {
      h.expiresAt = "2026-12-01T00:00:00.000Z";
    },
    (h) => {
      h.parentTaskId = "foreign_task";
    },
    (h) => {
      h.parentTaskRevision++;
    },
    (h) => {
      h.parentEnvelopeId = "foreign_envelope";
    },
    (h) => {
      h.parentEnvelopeRevision++;
    },
    (h) => {
      h.childTaskId = "task_root";
    },
    (h) => {
      h.childEnvelopeId = "envelope_root";
    },
    (h) => {
      h.recipient = actor("foreign_executor", "agent", "foreign_installation");
    },
  ]) {
    const f = delegationFixture();
    change(f.facts.hops[0]);
    await denied(f);
  }
});

test("depth and child capacity eligibility is bounded and never claims atomic admission", async () => {
  const f = delegationFixture();
  f.facts.envelope.maximumDepth = 1;
  f.facts.envelope.maximumChildren = 32;
  f.facts.hops[0].parentChildCount = 31;
  const result = await allowed(f);
  assert.ok(result.obligations.includes("atomic_delegation_admission"));
  f.facts.hops[0].parentChildCount = 32;
  await denied(f);
  f.facts.hops[0].parentChildCount = 0;
  f.facts.envelope.maximumDepth = 0;
  await denied(f);
});

test("owner, dispatcher, executor and installation-owner departure/current revision drift denies", async () => {
  for (const select of [
    (f) => f.facts.origin,
    (f) => f.facts.hops[0].dispatcher.current,
    (f) => f.facts.executor.current,
    (f) => f.facts.executor.owner,
  ])
    for (const flag of [
      "principalActive",
      "organizationActive",
      "workspaceActive",
      "membershipActive",
    ]) {
      const f = delegationFixture();
      if (flag === "membershipActive" && select(f).actor.kind !== "human") continue;
      select(f)[flag] = false;
      await denied(f);
    }
  const f = delegationFixture();
  f.facts.executor.current.grantsRevision--;
  await denied(f);
});

test("revoked, expired and not-yet-valid envelopes, hops and grants deny", async () => {
  for (const select of [
    (f) => f.facts.envelope,
    (f) => f.facts.hops[0],
    (f) => f.facts.origin.grants[0],
  ])
    for (const change of [{ revokedAt: at }, { expiresAt: at }, { validFrom: until }]) {
      const f = delegationFixture();
      Object.assign(select(f), change);
      await denied(f);
    }
});

test("disabled, reassigned or unqualified service installations do not act", async () => {
  for (const change of [
    (f) => {
      f.facts.executor.installation.status = "disabled";
    },
    (f) => {
      f.facts.executor.installation.owner = actor("foreign_owner");
    },
    (f) => {
      f.facts.executor.current.actor.kind = "service";
    },
    (f) => {
      f.facts.hops[0].dispatcher.current.actor.kind = "service";
    },
  ]) {
    const f = delegationFixture();
    change(f);
    await denied(f);
  }
});

test("current actual resource, account, provider and entitlement constraints always intersect", async () => {
  for (const change of [
    (c) => {
      c.resource.id = "foreign_product";
    },
    (c) => {
      c.resource.organizationId = "foreign_org";
    },
    (c) => {
      c.accountId = "foreign_account";
    },
    (c) => {
      c.providerAllowed = false;
    },
    (c) => {
      c.entitlementAllowed = false;
    },
  ]) {
    const f = delegationFixture();
    change(f.facts.constraints);
    await denied(f);
  }
});

test("background automation uses durable owner eligibility without requiring a browser session", async () => {
  const f = automationFixture();
  assert.equal(Object.hasOwn(f.facts.executor.owner, "sessionCurrent"), false);
  const result = await allowed(f, "automation");
  assert.equal(result.lineage.mandateId, f.input.mandateId);
  assert.equal(result.lineage.envelopeId, null);
  assert.deepEqual(clone(result.lineage.requester), f.facts.mandate.payload.owner);
  assert.deepEqual(clone(result.lineage.executor), f.facts.executor.current.actor);
});

test("automation mandate and installation owner must match, even for a powerful teammate", async () => {
  const f = automationFixture();
  const owner = actor("another_admin");
  f.facts.mandate.payload.owner = owner;
  synchronizeMandate(f.facts);
  await denied(f, "automation");
});

test("a correctly rehashed mandate cannot repair departure, scope, expiry or capability denial", async () => {
  for (const change of [
    (f) => {
      f.facts.executor.owner.membershipActive = false;
    },
    (f) => {
      f.facts.executor.owner.grants[0].revokedAt = at;
    },
    (f) => {
      f.facts.mandate.payload.revokedAt = at;
    },
    (f) => {
      f.facts.mandate.payload.expiresAt = at;
    },
    (f) => {
      f.facts.mandate.payload.startsAt = until;
    },
    (f) => {
      f.facts.mandate.payload.capabilityIds = ["orders.read"];
    },
    (f) => {
      f.facts.mandate.payload.scope.fields = ["title"];
    },
    (f) => {
      f.facts.mandate.payload.installationId = "foreign_installation";
    },
  ]) {
    const f = automationFixture();
    change(f);
    synchronizeMandate(f.facts);
    await denied(f, "automation");
  }
});

test("mandate refs bind current ID, revision, content digest, tenant and store", async () => {
  for (const [key, value] of [
    ["id", "foreign_mandate"],
    ["revision", 14],
    ["digest", "e".repeat(64)],
    ["organizationId", "foreign_org"],
    ["workspaceId", "foreign_workspace"],
    ["storeId", null],
  ]) {
    const f = automationFixture();
    f.facts.executor.installation.mandateRefs[0][key] = value;
    await denied(f, "automation");
  }
});

test("approval and budget references never supply missing authority or satisfy execution controls", async () => {
  const f = retarget(automationFixture(), "orders.refund.create", "execute");
  const result = await allowed(f, "automation");
  assert.ok(result.obligations.includes("exact_approval"));
  assert.ok(result.obligations.includes("provider_effect_verification"));
  f.facts.executor.owner.grants = [];
  await denied(f, "automation");
});

test("the same reader is called afresh after current authority changes", async () => {
  const f = delegationFixture();
  const h = harness(f);
  assert.equal((await h.decide()).decision.allowed, true);
  f.facts.origin.grants[0].revokedAt = at;
  const result = await h.decide();
  assert.equal(result.decision.allowed, false);
  assert.equal(h.calls.length, 2);
  assert.equal(result.lineage, null);
});

test("input is snapshotted before the awaited reader and cannot be retargeted during loading", async () => {
  const f = delegationFixture();
  const original = clone(f.input);
  const h = harness(f, "delegation", {
    async readDelegationCurrent(received) {
      assert.deepEqual(clone(received), original);
      f.input.envelopeId = "foreign_envelope";
      f.input.executorInstallationId = "foreign_installation";
      f.input.operation.resource.id = "foreign_product";
      f.input.operation.fields.push("price");
      await Promise.resolve();
      assert.deepEqual(clone(received), original);
      return JSON.stringify(f.facts);
    },
  });
  assert.equal((await h.decide()).decision.allowed, true);
});

test("caller input cannot contain authority, symbols, getters, proxies, sparse arrays or cycles", async () => {
  let accesses = 0;
  const inputs = [];
  const extra = delegationFixture().input;
  extra.approved = true;
  inputs.push(extra);
  const accessor = delegationFixture().input;
  Object.defineProperty(accessor, "envelopeId", {
    enumerable: true,
    get() {
      accesses++;
      return "envelope_root";
    },
  });
  inputs.push(accessor);
  const symbol = delegationFixture().input;
  symbol[Symbol("grant")] = true;
  inputs.push(symbol);
  inputs.push(
    new Proxy(delegationFixture().input, {
      getPrototypeOf() {
        accesses++;
        throw Error("private trap");
      },
    }),
  );
  const inherited = Object.assign(Object.create({ grant: true }), delegationFixture().input);
  inputs.push(inherited);
  const sparse = delegationFixture().input;
  sparse.operation.fields = Array(2);
  inputs.push(sparse);
  const cycle = delegationFixture().input;
  cycle.operation.loop = cycle;
  inputs.push(cycle);
  for (const input of inputs) {
    const f = delegationFixture();
    f.input = input;
    const h = harness(f);
    await assert.rejects(
      h.service.decideDelegation(input),
      (error) =>
        error instanceof AgentAuthorityError && error.code === "AGENT_POLICY_INPUT_INVALID",
    );
    assert.equal(h.calls.length, 0);
  }
  assert.equal(accesses, 0);
});

test("malformed reader facts fail closed without invoking getters or proxy traps", async () => {
  let accesses = 0;
  for (const mutate of [
    (f) => {
      f.facts.secret = "private-reader-content";
    },
    (f) => {
      f.facts.origin.policyRevision = "7";
    },
    (f) => {
      f.facts.origin[Symbol("private")] = true;
    },
    (f) => {
      Object.defineProperty(f.facts.origin, "membershipActive", {
        enumerable: true,
        get() {
          accesses++;
          return true;
        },
      });
    },
    (f) => {
      f.facts.origin = new Proxy(f.facts.origin, {
        ownKeys() {
          accesses++;
          throw Error("private trap");
        },
      });
    },
    (f) => {
      f.facts.hops = Array(1);
    },
    (f) => {
      f.facts.origin.grants.push(f.facts.origin.grants[0]);
    },
    (f) => {
      f.facts.envelope.loop = f.facts;
    },
  ]) {
    const f = delegationFixture();
    mutate(f);
    await assert.rejects(
      harness(f, "delegation", {
        async readDelegationCurrent() {
          return f.facts;
        },
      }).decide(),
      (error) => error.code === "AGENT_POLICY_AUTHORITY_UNAVAILABLE",
    );
  }
  assert.equal(accesses, 0);
});

test("reader and clock failures expose only fixed authority errors", async () => {
  const f = delegationFixture();
  const throwing = Object.defineProperty(Error(), "message", {
    get() {
      throw Error("private proof");
    },
  });
  for (const error of [
    Error("private proof"),
    throwing,
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw Error("private proof");
        },
      },
    ),
  ]) {
    const h = harness(f, "delegation", {
      async readDelegationCurrent() {
        throw error;
      },
    });
    await assert.rejects(h.decide(), (received) => {
      assert.equal(received.code, "AGENT_POLICY_AUTHORITY_UNAVAILABLE");
      assert.ok(!JSON.stringify(received).includes("private proof"));
      return true;
    });
  }
  const service = createAgentAuthorityService(
    {
      async readDelegationCurrent() {
        return JSON.stringify(f.facts);
      },
    },
    () => {
      throw Error("private clock");
    },
  );
  await assert.rejects(
    service.decideDelegation(JSON.stringify(f.input)),
    (error) => error.code === "AGENT_POLICY_AUTHORITY_UNAVAILABLE",
  );
});

test("canonical digest matches an independent RFC8785 oracle and rejects executable input", () => {
  for (const value of [
    { z: 1, a: [true, null, "é", "😀", 1e-7, -0] },
    delegationFixture().facts.executor.grantRecords[0].payload,
    automationFixture().facts.mandate.payload,
  ])
    assert.equal(canonicalPayloadDigest(JSON.stringify(value)), digest(value));
  assert.equal(canonicalPayloadDigest('{"a":1,"z":2}'), canonicalPayloadDigest('{"z":2,"a":1}'));
  let invoked = 0;
  const accessor = {
    get private() {
      invoked++;
      return "secret";
    },
  };
  for (const value of [
    accessor,
    {
      toJSON() {
        invoked++;
        return {};
      },
    },
    new Proxy({}, {}),
    { bad: Infinity },
  ])
    assert.throws(
      () => canonicalPayloadDigest(value),
      (error) => error.code === "AGENT_POLICY_INPUT_INVALID",
    );
  assert.equal(invoked, 0);
});

test("existing human policy entry point still denies agent installation authority", async () => {
  const f = delegationFixture();
  const current = f.facts.executor.current;
  const service = createHumanPolicyService(
    {
      async readCurrent() {
        return {
          ...current,
          sessionCurrent: true,
          resource: clone(f.input.operation.resource),
          accountId: "account_a",
          providerAllowed: true,
          entitlementAllowed: true,
        };
      },
    },
    () => new Date(at),
  );
  const result = await service.decide(f.input.operation);
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.reason, "origin_denied");
});

test("multiple distinct authorized resources remain valid after the JSON snapshot", async () => {
  const f = delegationFixture();
  const extra = resource("product", "product_extra");
  for (const scoped of [
    f.facts.envelope.scope,
    f.facts.hops[0].scope,
    f.facts.executor.installation.scope,
  ])
    scoped.resources.push(clone(extra));
  for (const current of [f.facts.origin, f.facts.executor.owner, f.facts.executor.current])
    for (const g of current.grants.filter((g) => g.capabilityId === f.input.operation.capabilityId))
      g.scope.resources.push(clone(extra));
  synchronizeExecutor(f.facts);
  await allowed(f);
});

test("eight linked narrow delegations are eligible without reserving capacity", async () => {
  const f = delegationChainFixture(8);
  const result = await allowed(f);
  assert.equal(result.lineage.dispatchers.length, 8);
  assert.ok(result.obligations.includes("atomic_delegation_admission"));
  f.facts.envelope.maximumDepth = 7;
  await denied(f);
});

test("duplicate/cyclic hop, actor, envelope and task lineage cannot be reused", async () => {
  for (const change of [
    (f) => {
      f.facts.hops[1].id = f.facts.hops[0].id;
    },
    (f) => {
      f.facts.hops[1].childTaskId = f.facts.envelope.taskId;
    },
    (f) => {
      f.facts.hops[1].childEnvelopeId = f.facts.envelope.id;
    },
    (f) => {
      f.facts.hops[1].parentTaskRevision++;
    },
    (f) => {
      f.facts.hops[1].parentEnvelopeRevision++;
    },
    (f) => {
      f.facts.hops[1].dispatcher = clone(f.facts.hops[0].dispatcher);
    },
    (f) => {
      f.facts.hops[0].recipient = clone(f.facts.executor.current.actor);
    },
  ]) {
    const f = delegationChainFixture(2);
    change(f);
    await denied(f);
  }
});

test("a global principal ID cannot represent both a human and a coordinator or installed agent", async () => {
  const coordinatorAlias = delegationFixture();
  const dispatcher = coordinatorAlias.facts.hops[0].dispatcher.current;
  dispatcher.actor.principalId = coordinatorAlias.facts.origin.actor.principalId;
  for (const g of dispatcher.grants) g.principal = clone(dispatcher.actor);
  await denied(coordinatorAlias);

  for (const mode of ["delegation", "automation"]) {
    const f = mode === "delegation" ? delegationFixture() : automationFixture();
    const executor = f.facts.executor;
    const administrator = actor("installation_administrator");
    executor.installation.owner = clone(administrator);
    executor.owner.actor = clone(administrator);
    for (const g of executor.owner.grants) g.principal = clone(administrator);
    if (mode === "automation") {
      f.facts.mandate.payload.owner = clone(administrator);
      synchronizeMandate(f.facts);
    }
    await allowed(f, mode);

    executor.current.actor.principalId = administrator.principalId;
    for (const g of executor.current.grants) g.principal = clone(executor.current.actor);
    if (mode === "delegation") f.facts.hops.at(-1).recipient = clone(executor.current.actor);
    synchronizeExecutor(f.facts);
    await denied(f, mode);
  }

  const crossInstallation = delegationChainFixture(2, true);
  await allowed(crossInstallation);
  const intermediate = crossInstallation.facts.hops[1].dispatcher;
  const finalExecutor = crossInstallation.facts.executor;
  const aliasedHumanOwner = actor(intermediate.current.actor.principalId);
  finalExecutor.installation.owner = clone(aliasedHumanOwner);
  finalExecutor.owner.actor = clone(aliasedHumanOwner);
  for (const g of finalExecutor.owner.grants) g.principal = clone(aliasedHumanOwner);
  assert.notEqual(
    intermediate.current.actor.principalId,
    intermediate.installed.owner.actor.principalId,
  );
  assert.notEqual(finalExecutor.current.actor.principalId, aliasedHumanOwner.principalId);
  assert.notEqual(crossInstallation.facts.origin.actor.principalId, aliasedHumanOwner.principalId);
  await denied(crossInstallation);
});

test("an installed intermediate dispatcher intersects its owner's domain and parent-task authority", async () => {
  const f = delegationChainFixture(2, true);
  await allowed(f);
  assert.ok(
    f.facts.hops[1].dispatcher.current.grants.every(
      (g) => g.capabilityId === "workspace.task.delegate",
    ),
  );
  f.facts.hops[1].dispatcher.installed.owner.grants[0].scope.fields = ["title"];
  await denied(f);
  f.facts.hops[1].dispatcher.installed.owner.grants[0].scope.fields = ["title", "description"];
  f.facts.hops[1].dispatcher.installed.owner.grants[1].scope.fields = ["taskId"];
  await denied(f);
});

test("operator-only and human-review-only capabilities remain unavailable to agent authority", async () => {
  for (const capability of [
    "agents.release.publish",
    "governance.approval.decide",
    "creative.image.approve",
  ])
    await denied(retarget(delegationFixture(), capability, "execute"));
  for (const verb of ["approve", "administer", "delegate"])
    await denied(retarget(delegationFixture(), "catalog.products.read", verb));
});

test("connection administration cannot enter either agent API through a permitted target verb", async () => {
  for (const mode of ["delegation", "automation"])
    for (const verb of ["view", "propose", "execute"])
      await denied(
        retarget(
          mode === "delegation" ? delegationFixture() : automationFixture(),
          "governance.connection.connect",
          verb,
          "workspace",
          ["status"],
        ),
        mode,
      );
});

test("billable generation leaves budget, approval, provider and dispatch obligations unfulfilled", async () => {
  const f = retarget(automationFixture(), "creative.image.generate", "execute", "product", [
    "image",
  ]);
  const result = await allowed(f, "automation");
  assert.ok(result.obligations.includes("budget_reservation"));
  assert.ok(result.obligations.includes("provider_effect_verification"));
  assert.ok(result.obligations.includes("qualified_dispatch"));
  assert.equal(Object.hasOwn(result, "reservationId"), false);
});

test("primitive JSON boundary rejects malformed, ambiguous and authority-bearing caller content", async () => {
  const f = delegationFixture();
  const h = harness(f);
  const proto = JSON.parse(JSON.stringify(f.input));
  Object.defineProperty(proto, "__proto__", { value: { polluted: true }, enumerable: true });
  const sparse = clone(f.input);
  sparse.operation.fields = [null];
  for (const wire of [
    "{",
    "null",
    "[]",
    "42",
    JSON.stringify("string"),
    JSON.stringify(proto),
    JSON.stringify(sparse),
    JSON.stringify({ ...f.input, approved: true }),
    " ".repeat(2 * 1024 * 1024 + 1),
  ])
    await assert.rejects(
      h.service.decideDelegation(wire),
      (error) => error.code === "AGENT_POLICY_INPUT_INVALID",
    );
  assert.equal(h.calls.length, 0);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(
    canonicalPayloadDigest('{"__proto__":{"polluted":true},"a":1}'),
    digest(JSON.parse('{"__proto__":{"polluted":true},"a":1}')),
  );
  assert.equal(Object.prototype.polluted, undefined);
});

test("JSON reader content rejects unknown fields, invalid records and dangerous own keys", async () => {
  for (const mutate of [
    (f) => {
      f.facts.secret = "private content";
    },
    (f) => {
      f.facts.origin.policyRevision = "7";
    },
    (f) => {
      f.facts.hops = [null];
    },
    (f) => {
      f.facts.origin.grants.push(clone(f.facts.origin.grants[0]));
    },
    (f) => {
      Object.defineProperty(f.facts, "__proto__", { value: { polluted: true }, enumerable: true });
    },
  ]) {
    const f = delegationFixture();
    mutate(f);
    await unavailable(f);
  }
  const f = delegationFixture();
  for (const wire of ["{", "null", "[]", "false", '"string"'])
    await assert.rejects(
      harness(f, "delegation", {
        async readDelegationCurrent() {
          return wire;
        },
      }).decide(),
      (error) => error.code === "AGENT_POLICY_AUTHORITY_UNAVAILABLE",
    );
  assert.equal(Object.prototype.polluted, undefined);
});

test("automation facts also reload after owner revocation and primitive inputs reject before traps", async () => {
  const f = automationFixture();
  const h = harness(f, "automation");
  assert.equal((await h.decide()).decision.allowed, true);
  f.facts.executor.owner.membershipActive = false;
  assert.equal((await h.decide()).decision.allowed, false);
  assert.equal(h.calls.length, 2);
  let traps = 0;
  const proxy = new Proxy(f.input, {
    getPrototypeOf() {
      traps++;
      throw Error("private trap");
    },
  });
  await assert.rejects(
    h.service.decideAutomation(proxy),
    (error) => error.code === "AGENT_POLICY_INPUT_INVALID",
  );
  assert.equal(traps, 0);
  assert.equal(h.calls.length, 2);
});

// P01.T02a PR-A (AC07): agents get no verb on a human_only capability except
// propose, and only where a proposal path exists (ADR-0005).
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const humanOnly = catalogue.capabilities.filter((c) => c.executor === "human_only");
// Conditions that already denied agents before v1.1 still apply.
const deniedBefore = (c) =>
  c.id === "governance.connection.connect" ||
  c.eligible_principal.startsWith("operator_") ||
  c.eligible_principal.startsWith("eligible_human_");
async function reasonFor(f, mode) {
  return (await harness(f, mode).decide()).decision.reason;
}
test("AC07: agents with otherwise-sufficient grants cannot view or execute any human_only capability", async () => {
  assert.ok(humanOnly.some((c) => c.id === "ads.campaign.pause"));
  assert.ok(humanOnly.some((c) => c.id === "workspace.task.takeover"));
  for (const c of humanOnly)
    for (const mode of ["delegation", "automation"])
      for (const verb of ["view", "execute"]) {
        const make = mode === "delegation" ? delegationFixture : automationFixture;
        const f = retarget(make(), c.id, verb, "task", ["status"]);
        assert.equal(await reasonFor(f, mode), "capability_denied", `${mode} ${verb} ${c.id}`);
        await denied(f, mode);
      }
});
test("AC07: agents may propose a human_only capability exactly when it is a kill switch or reviewed", async () => {
  const proposable = [];
  for (const c of humanOnly) {
    const expected = (c.kill_switch || c.review_required) && !deniedBefore(c);
    for (const mode of ["delegation", "automation"]) {
      const make = mode === "delegation" ? delegationFixture : automationFixture;
      const f = retarget(make(), c.id, "propose", "task", ["status"]);
      if (expected) {
        const result = await allowed(f, mode);
        assert.ok(!result.obligations.includes("exact_approval"));
      } else assert.equal(await reasonFor(f, mode), "capability_denied", `${mode} ${c.id}`);
    }
    if (expected) proposable.push(c.id);
  }
  assert.ok(proposable.includes("ads.campaign.pause"));
  assert.ok(proposable.includes("governance.membership.revoke"));
  assert.ok(!proposable.includes("workspace.task.takeover"));
  assert.ok(!proposable.includes("agents.release.revoke"));
});
test("AC07: the pause an agent proposes is a stop only a human can execute", async () => {
  const pause = (verb) =>
    retarget(delegationFixture(), "ads.campaign.pause", verb, "campaign", ["delivery_status"]);
  await allowed(pause("propose"));
  assert.equal(await reasonFor(pause("execute")), "capability_denied");
  // Agent-direct capabilities keep their existing behaviour.
  await allowed(retarget(delegationFixture(), "orders.refund.create", "execute"));
  await allowed(
    retarget(delegationFixture(), "catalog.products.read", "view", "product", ["title"]),
  );
});
