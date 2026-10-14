import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

// Independent RFC8785 oracle: never use the engine's digest to manufacture refs.
export const digest = (value) => createHash("sha256").update(canonicalize(value)).digest("hex");
export const at = "2026-10-15T12:00:00.000Z";
export const from = "2026-10-01T00:00:00.000Z";
export const until = "2026-11-01T00:00:00.000Z";
export const clone = (value) => structuredClone(value);
export function actor(principalId, kind = "human", installationId = null) {
  return {
    kind,
    principalId,
    organizationId: "org_a",
    workspaceId: "workspace_a",
    membershipId: kind === "human" ? `member_${principalId}` : null,
    installationId,
    mandateId: null,
  };
}
export function resource(kind = "product", id = "product_a") {
  return {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    connectionId: kind === "task" ? null : "connection_a",
    kind,
    id,
  };
}
export function scope(resources = [resource()], fields = ["title", "description"]) {
  return {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeIds: ["store_a"],
    accountIds: ["account_a"],
    resources: clone(resources),
    fields: [...fields],
  };
}
export function ref(kind, id, revision = 1, contentDigest = "c".repeat(64)) {
  return {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    kind,
    id,
    revision,
    digest: contentDigest,
  };
}
export function grant(id, principal, capabilityId, verbs, grantedScope, issuer = actor("owner")) {
  return {
    id,
    principal: clone(principal),
    capabilityId,
    verbs: [...verbs],
    scope: clone(grantedScope),
    issuedBy: clone(issuer),
    validFrom: from,
    expiresAt: until,
    revokedAt: null,
    policyRevision: 3,
  };
}
export function authority(who, grants = []) {
  return {
    actor: clone(who),
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    policyRevision: 7,
    grantsRevision: 7,
    grants: clone(grants),
  };
}
export function synchronizeExecutor(facts) {
  const agent = facts.executor;
  const revisions = new Map(
    agent.grantRecords.map((record) => [record.payload.id, record.recordRevision]),
  );
  agent.grantRecords = agent.current.grants.map((payload) => ({
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    recordRevision: revisions.get(payload.id) ?? 41,
    payload: clone(payload),
  }));
  agent.installation.grantRefs = agent.grantRecords.map((record) =>
    ref("grant", record.payload.id, record.recordRevision, digest(record.payload)),
  );
  return facts;
}
export function synchronizeMandate(facts) {
  facts.executor.installation.mandateRefs = [
    ref(
      "mandate",
      facts.mandate.payload.id,
      facts.mandate.recordRevision,
      digest(facts.mandate.payload),
    ),
  ];
  return facts;
}
export function delegationFixture() {
  const owner = actor("owner");
  const coordinator = actor("coordinator", "agent");
  const specialist = actor("specialist", "agent", "installation_specialist");
  const operation = {
    capabilityId: "catalog.products.read",
    verb: "view",
    resource: resource(),
    accountId: "account_a",
    fields: ["title", "description"],
  };
  const task = resource("task", "task_root");
  const dispatchScope = scope([task], ["taskId", "installationId", "mandate"]);
  dispatchScope.accountIds = [];
  const origin = authority(owner, [
    grant("owner_tool", owner, operation.capabilityId, [operation.verb], scope()),
    grant("owner_tool_delegate", owner, operation.capabilityId, ["delegate"], scope()),
    grant("owner_delegate", owner, "workspace.task.delegate", ["delegate"], dispatchScope),
  ]);
  const current = authority(specialist, [
    grant("specialist_tool", specialist, operation.capabilityId, [operation.verb], scope()),
  ]);
  const installation = {
    schemaVersion: 1,
    id: specialist.installationId,
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    revision: 11,
    createdAt: from,
    updatedAt: from,
    releaseRef: ref("release", "release_specialist"),
    owner: clone(owner),
    status: "active",
    configurationRef: ref("config", "config_specialist"),
    scope: scope(),
    grantRefs: [],
    mandateRefs: [],
    dependencies: [],
    evaluationRef: ref("evaluation", "evaluation_specialist"),
    provisionalExpiresAt: null,
  };
  const facts = {
    envelope: {
      schemaVersion: 1,
      id: "envelope_root",
      revision: 2,
      taskId: "task_root",
      taskRevision: 4,
      organizationId: "org_a",
      workspaceId: "workspace_a",
      requester: clone(owner),
      authorizer: clone(owner),
      capabilityIds: [operation.capabilityId],
      verbs: [operation.verb],
      scope: scope(),
      validFrom: from,
      expiresAt: until,
      revokedAt: null,
      maximumDepth: 4,
      maximumChildren: 4,
    },
    origin,
    hops: [
      {
        id: "hop_one",
        revision: 1,
        parentTaskId: "task_root",
        parentTaskRevision: 4,
        parentTaskResource: clone(task),
        childTaskId: "task_child",
        childTaskRevision: 1,
        parentEnvelopeId: "envelope_root",
        parentEnvelopeRevision: 2,
        childEnvelopeId: "envelope_child",
        childEnvelopeRevision: 1,
        dispatcher: {
          kind: "builtin_coordinator",
          current: authority(coordinator, [
            grant(
              "coordinator_dispatch",
              coordinator,
              "workspace.task.delegate",
              ["delegate"],
              dispatchScope,
            ),
          ]),
          installed: null,
        },
        recipient: clone(specialist),
        capabilityIds: [operation.capabilityId],
        verbs: [operation.verb],
        scope: scope(),
        validFrom: from,
        expiresAt: until,
        revokedAt: null,
        parentChildCount: 0,
      },
    ],
    executor: { installation, current, owner: clone(origin), grantRecords: [] },
    constraints: {
      resource: resource(),
      accountId: "account_a",
      providerAllowed: true,
      entitlementAllowed: true,
    },
  };
  synchronizeExecutor(facts);
  return {
    input: { envelopeId: facts.envelope.id, executorInstallationId: installation.id, operation },
    facts,
  };
}
export function automationFixture() {
  const delegated = delegationFixture();
  const { executor, constraints } = delegated.facts;
  const payload = {
    schemaVersion: 1,
    id: "mandate_a",
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    revision: 13,
    createdAt: from,
    updatedAt: from,
    owner: clone(executor.installation.owner),
    installationId: executor.installation.id,
    capabilityIds: [delegated.input.operation.capabilityId],
    scope: scope(),
    budgetRef: ref("budget", "budget_a"),
    startsAt: from,
    expiresAt: until,
    revokedAt: null,
    reviewPolicyRef: ref("policy", "review_a"),
    triggerRef: ref("schedule", "schedule_a"),
    maximumChildren: 4,
    maximumDepth: 4,
  };
  const facts = {
    mandate: {
      organizationId: "org_a",
      workspaceId: "workspace_a",
      storeId: "store_a",
      recordRevision: 13,
      payload,
    },
    executor,
    constraints,
  };
  synchronizeMandate(facts);
  return {
    input: {
      mandateId: payload.id,
      executorInstallationId: executor.installation.id,
      operation: delegated.input.operation,
    },
    facts,
  };
}

export function delegationChainFixture(length = 2, installedIntermediate = false) {
  const f = delegationFixture();
  const template = clone(f.facts.hops[0]);
  const dispatchers = Array.from({ length }, (_, i) =>
    i === 0 ? clone(template.dispatcher.current.actor) : actor(`coordinator_${i}`, "agent"),
  );
  if (installedIntermediate) dispatchers[1].installationId = "installation_dispatcher";
  f.facts.envelope.maximumDepth = length;
  f.facts.hops = dispatchers.map((dispatcher, index) => {
    const parentTaskId = index === 0 ? "task_root" : `task_child_${index}`;
    const task = resource("task", parentTaskId);
    const dispatchScope = scope([task], ["taskId", "installationId", "mandate"]);
    dispatchScope.accountIds = [];
    const current = authority(dispatcher, [
      grant(
        `dispatch_${index}`,
        dispatcher,
        "workspace.task.delegate",
        ["delegate"],
        dispatchScope,
      ),
    ]);
    let installed = null;
    if (installedIntermediate && index === 1) {
      const administrator = actor("dispatch_administrator");
      const owner = authority(administrator, [
        grant(
          "dispatcher_owner_domain",
          administrator,
          f.input.operation.capabilityId,
          [f.input.operation.verb],
          scope(),
        ),
        grant(
          "dispatcher_owner_parent",
          administrator,
          "workspace.task.delegate",
          ["delegate"],
          dispatchScope,
        ),
      ]);
      installed = {
        installation: {
          ...clone(f.facts.executor.installation),
          id: dispatcher.installationId,
          owner: clone(administrator),
          scope: clone(dispatchScope),
          grantRefs: [],
        },
        current: clone(current),
        owner,
        grantRecords: [],
      };
      synchronizeExecutor({ executor: installed });
    }
    return {
      ...clone(template),
      id: `hop_${index + 1}`,
      parentTaskId,
      parentTaskRevision: index === 0 ? 4 : 1,
      parentTaskResource: task,
      childTaskId: `task_child_${index + 1}`,
      childTaskRevision: 1,
      parentEnvelopeId: index === 0 ? "envelope_root" : `envelope_child_${index}`,
      parentEnvelopeRevision: index === 0 ? 2 : 1,
      childEnvelopeId: `envelope_child_${index + 1}`,
      childEnvelopeRevision: 1,
      dispatcher: {
        kind: installed ? "installed_agent" : "builtin_coordinator",
        current,
        installed,
      },
      recipient: clone(
        index === length - 1 ? f.facts.executor.current.actor : dispatchers[index + 1],
      ),
    };
  });
  return f;
}
