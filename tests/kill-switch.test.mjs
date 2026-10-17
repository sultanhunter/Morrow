// P01.T02a PR-A: kill-switch target rules (AC09) in packages/policy/src/kill-switch.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkKillSwitchTarget,
  killSwitchCapabilityIds,
  KillSwitchBoundaryError,
} from "../packages/policy/src/kill-switch.ts";
import { createHumanPolicyService } from "../packages/policy/src/index.ts";

const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const v11 = JSON.parse(readFileSync("docs/contracts/schemas/v1.1/core.schema.json", "utf8"));
const tenant = { organizationId: "org_a", workspaceId: "workspace_a" };
const control = { reason: "Overspend on a misconfigured campaign", sourceProposalRef: null };
const campaign = (id, overrides = {}) => ({
  ...tenant,
  storeId: "store_a",
  connectionId: "connection_a",
  kind: "campaign",
  id,
  ...overrides,
});
const record = (kind, id, overrides = {}) => ({
  kind,
  id,
  ...tenant,
  storeId: null,
  connectionId: null,
  revision: null,
  digest: null,
  ...overrides,
});
const releaseRef = {
  ...tenant,
  storeId: null,
  kind: "release",
  id: "release_a",
  revision: 3,
  digest: "b".repeat(64),
};
const proposalRef = {
  ...tenant,
  storeId: "store_a",
  kind: "proposal",
  id: "proposal_a",
  revision: 2,
  digest: "a".repeat(64),
};
function facts() {
  return {
    ...tenant,
    records: [
      record("campaign", "campaign_a", { storeId: "store_a", connectionId: "connection_a" }),
      record("campaign", "campaign_b", { storeId: "store_a", connectionId: "connection_a" }),
      record("campaign", "campaign_foreign", {
        organizationId: "org_b",
        workspaceId: "workspace_b",
        storeId: "store_a",
        connectionId: "connection_a",
      }),
      record("campaign", "campaign_ungranted", {
        storeId: "store_b",
        connectionId: "connection_b",
      }),
      record("installation", "installation_a"),
      record("installation", "installation_store_a", { storeId: "store_a" }),
      record("installation", "installation_ungranted", { storeId: "store_b" }),
      record("member", "membership_owner"),
      record("member", "membership_b"),
      record("member", "membership_c"),
      record("connection", "connection_a", { storeId: "store_a", connectionId: "connection_a" }),
      record("connection", "connection_b", { storeId: "store_b", connectionId: "connection_b" }),
      record("release", "release_a", { revision: 3, digest: "b".repeat(64) }),
    ],
    // A store-and-connection grant and a storeless (workspace-level) grant.
    grants: [
      { storeIds: ["store_a"], connectionIds: ["connection_a"] },
      { storeIds: [], connectionIds: [] },
    ],
    sourceProposal: null,
    ownership: {
      ownerPrincipalId: "human_owner",
      ownerMembershipId: "membership_owner",
      activeHumanMembershipCount: 3,
      lastMembershipChangeAt: null,
    },
  };
}
const pause = (...campaigns) => ({
  capabilityId: "ads.campaign.pause",
  input: { campaigns, control },
});
const revoke = (membershipId, source = null) => ({
  capabilityId: "governance.membership.revoke",
  input: { membershipId, control: { ...control, sourceProposalRef: source } },
});
const notFound = {
  allowed: false,
  code: "TARGET_NOT_FOUND",
  category: "denied",
  retry: "never",
  safeMessage: "The requested target is not available.",
};

test("the kill-switch set is the catalogue's, and the KillSwitchRecord enum matches it", () => {
  const ids = catalogue.capabilities.filter((c) => c.kill_switch).map((c) => c.id);
  assert.deepEqual([...killSwitchCapabilityIds].sort(), [...ids].sort());
  assert.deepEqual(
    [...v11.$defs.KillSwitchRecord.properties.capabilityId.enum].sort(),
    [...ids].sort(),
  );
});

test("AC09: a granted campaign in the trusted tenant can be paused", () => {
  const result = checkKillSwitchTarget(
    pause(campaign("campaign_a"), campaign("campaign_b")),
    facts(),
  );
  assert.deepEqual(result, {
    allowed: true,
    capabilityId: "ads.campaign.pause",
    targets: [
      { kind: "campaign", id: "campaign_a" },
      { kind: "campaign", id: "campaign_b" },
    ],
    membershipChange: false,
  });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.targets));
});

test("AC09: foreign-tenant, unknown and ungranted campaigns are indistinguishable", () => {
  const results = [
    // The ref names another tenant.
    pause(campaign("campaign_foreign", { organizationId: "org_b", workspaceId: "workspace_b" })),
    // The ref claims this tenant, but the record lives in another.
    pause(campaign("campaign_foreign")),
    pause(campaign("campaign_unknown")),
    pause(campaign("campaign_ungranted", { storeId: "store_b", connectionId: "connection_b" })),
    // A ref that misstates the record's store or connection.
    pause(campaign("campaign_a", { storeId: "store_b" })),
    pause(campaign("campaign_a", { connectionId: "connection_b" })),
    // One bad target denies the whole stop.
    pause(campaign("campaign_a"), campaign("campaign_unknown")),
  ].map((request) => checkKillSwitchTarget(request, facts()));
  for (const result of results) assert.deepEqual(result, notFound);
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.doesNotMatch(JSON.stringify(results), /campaign_|org_b|store_b/);
});

test("AC09: a campaign must fit one grant; grants are never unioned", () => {
  const f = facts();
  f.grants = [
    { storeIds: ["store_a"], connectionIds: ["connection_z"] },
    { storeIds: ["store_z"], connectionIds: ["connection_a"] },
  ];
  assert.deepEqual(checkKillSwitchTarget(pause(campaign("campaign_a")), f), notFound);
  f.grants = [];
  assert.deepEqual(checkKillSwitchTarget(pause(campaign("campaign_a")), f), notFound);
  // A storeless campaign needs a storeless grant.
  f.records[0].storeId = null;
  f.grants = [{ storeIds: ["store_a"], connectionIds: ["connection_a"] }];
  const storeless = pause(campaign("campaign_a", { storeId: null }));
  assert.deepEqual(checkKillSwitchTarget(storeless, f), notFound);
  f.grants = [{ storeIds: [], connectionIds: ["connection_a"] }];
  assert.equal(checkKillSwitchTarget(storeless, f).allowed, true);
});

test("AC09: a source proposal must be same-tenant, same-capability and cover the targets", () => {
  const withSource = (request, sourceProposal) => {
    const f = facts();
    f.sourceProposal = sourceProposal;
    return checkKillSwitchTarget(request, f);
  };
  const source = {
    ref: proposalRef,
    capabilityId: "governance.membership.revoke",
    targets: [{ kind: "member", id: "membership_b" }],
  };
  assert.equal(withSource(revoke("membership_b", proposalRef), source).allowed, true);
  const foreign = { ...proposalRef, workspaceId: "workspace_b" };
  for (const [request, sourceProposal] of [
    // From another workspace, whether or not the reader resolves it.
    [revoke("membership_b", foreign), { ...source, ref: foreign }],
    [revoke("membership_b", foreign), null],
    // For another capability.
    [revoke("membership_b", proposalRef), { ...source, capabilityId: "ads.campaign.pause" }],
    // For other targets.
    [revoke("membership_c", proposalRef), source],
    // A different revision or digest than the one resolved.
    [revoke("membership_b", { ...proposalRef, revision: 3 }), source],
    [revoke("membership_b", { ...proposalRef, digest: "c".repeat(64) }), source],
    // Not resolved at all.
    [revoke("membership_b", proposalRef), null],
  ])
    assert.deepEqual(withSource(request, sourceProposal), notFound);
});

test("AC09: the owner membership is protected; a non-owner revocation is a membership change", async () => {
  assert.deepEqual(checkKillSwitchTarget(revoke("membership_owner"), facts()), {
    allowed: false,
    code: "OWNER_MEMBERSHIP_PROTECTED",
    category: "denied",
    retry: "never",
    safeMessage:
      "The workspace owner's membership cannot be revoked by a stop. Transfer ownership first.",
  });
  // A non-owner (human_b) holding a current execute grant revokes another non-owner.
  const actor = {
    kind: "human",
    principalId: "human_b",
    ...tenant,
    membershipId: "membership_b",
    installationId: null,
    mandateId: null,
  };
  const target = {
    ...tenant,
    storeId: null,
    connectionId: null,
    kind: "member",
    id: "membership_c",
  };
  const fields = ["membership", "sessions"];
  const policy = createHumanPolicyService(
    {
      async readCurrent() {
        return {
          actor,
          policyRevision: 1,
          grantsRevision: 1,
          principalActive: true,
          organizationActive: true,
          workspaceActive: true,
          membershipActive: true,
          sessionCurrent: true,
          resource: target,
          accountId: null,
          providerAllowed: true,
          entitlementAllowed: true,
          grants: [
            {
              id: "grant_revoke",
              principal: actor,
              capabilityId: "governance.membership.revoke",
              verbs: ["execute"],
              scope: {
                ...tenant,
                storeIds: [],
                accountIds: [],
                resources: [target],
                fields,
              },
              issuedBy: actor,
              validFrom: "2026-10-01T00:00:00.000Z",
              expiresAt: null,
              revokedAt: null,
              policyRevision: 1,
            },
          ],
        };
      },
    },
    () => new Date("2026-10-17T12:00:00.000Z"),
  );
  const permission = await policy.decide({
    capabilityId: "governance.membership.revoke",
    verb: "execute",
    resource: target,
    accountId: null,
    fields,
  });
  assert.equal(permission.decision.allowed, true);
  assert.deepEqual(permission.obligations, ["recheck_at_dispatch", "kill_switch_record"]);
  // The membership change advances lastMembershipChangeAt, which starts the
  // solo-owner quiet period (ADR-0011 Q2; P05.T01z persists it).
  assert.deepEqual(checkKillSwitchTarget(revoke("membership_c"), facts()), {
    allowed: true,
    capabilityId: "governance.membership.revoke",
    targets: [{ kind: "member", id: "membership_c" }],
    membershipChange: true,
  });
});

test("AC09: installation, connection and release targets resolve in the trusted tenant", () => {
  const ok = (capabilityId, input) =>
    checkKillSwitchTarget({ capabilityId, input: { ...input, control } }, facts());
  assert.equal(
    ok("agents.installation.disable", { installationId: "installation_a" }).allowed,
    true,
  );
  assert.equal(
    ok("governance.connection.disconnect", { connectionId: "connection_a" }).allowed,
    true,
  );
  assert.equal(ok("agents.release.revoke", { releaseRef }).allowed, true);
  for (const result of [
    ok("agents.installation.disable", { installationId: "installation_unknown" }),
    ok("governance.connection.disconnect", { connectionId: "connection_unknown" }),
    ok("agents.release.revoke", { releaseRef: { ...releaseRef, revision: 4 } }),
    ok("agents.release.revoke", { releaseRef: { ...releaseRef, digest: "c".repeat(64) } }),
    ok("agents.release.revoke", { releaseRef: { ...releaseRef, workspaceId: "workspace_b" } }),
  ])
    assert.deepEqual(result, notFound);
  const f = facts();
  f.records.find((r) => r.kind === "installation").workspaceId = "workspace_b";
  assert.deepEqual(
    checkKillSwitchTarget(
      {
        capabilityId: "agents.installation.disable",
        input: { installationId: "installation_a", control },
      },
      f,
    ),
    notFound,
  );
});

test("AC09: installation, connection, membership and release targets must each fit one grant", () => {
  const check = (capabilityId, input, grants) => {
    const f = facts();
    if (grants) f.grants = grants;
    return checkKillSwitchTarget({ capabilityId, input: { ...input, control } }, f);
  };
  const disable = (installationId, grants) =>
    check("agents.installation.disable", { installationId }, grants);
  const disconnect = (connectionId, grants) =>
    check("governance.connection.disconnect", { connectionId }, grants);
  // Granted targets are allowed.
  assert.equal(disable("installation_store_a").allowed, true);
  assert.equal(disconnect("connection_a").allowed, true);
  const results = [
    // A connection in a store outside every grant.
    disconnect("connection_b"),
    // A disconnect, a revoke and a release revoke with no grants at all.
    disconnect("connection_a", []),
    checkKillSwitchTarget(revoke("membership_c"), { ...facts(), grants: [] }),
    check("agents.release.revoke", { releaseRef }, []),
    // A connection must fit a single grant: store and connection are never unioned.
    disconnect("connection_a", [
      { storeIds: ["store_a"], connectionIds: ["connection_z"] },
      { storeIds: ["store_z"], connectionIds: ["connection_a"] },
    ]),
    // An installation in an ungranted store.
    disable("installation_ungranted"),
    disable("installation_store_a", [{ storeIds: ["store_b"], connectionIds: [] }]),
    // A storeless installation needs a storeless grant.
    disable("installation_a", [{ storeIds: ["store_a"], connectionIds: ["connection_a"] }]),
    // A membership revoke under only a store-scoped grant.
    checkKillSwitchTarget(revoke("membership_c"), {
      ...facts(),
      grants: [{ storeIds: ["store_a"], connectionIds: ["connection_a"] }],
    }),
  ];
  for (const result of results) assert.deepEqual(result, notFound);
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.doesNotMatch(JSON.stringify(results), /installation_|connection_|membership_|store_/);
});

test("malformed requests and facts fail closed at the boundary", () => {
  const invalid = (request, f = facts(), code = "KILL_SWITCH_INPUT_INVALID") =>
    assert.throws(
      () => checkKillSwitchTarget(request, f),
      (error) =>
        error instanceof KillSwitchBoundaryError &&
        error.code === code &&
        error.message === code &&
        error.cause === undefined,
    );
  invalid({ capabilityId: "ads.campaign.activate", input: { campaigns: [], control } });
  invalid({ ...pause(campaign("campaign_a")), approved: true });
  invalid({ capabilityId: "ads.campaign.pause", input: { campaigns: [], control } });
  invalid({
    capabilityId: "governance.membership.revoke",
    input: { membershipId: "membership_b", expectedRevision: 1, control },
  });
  invalid({
    ...revoke("membership_b"),
    input: { membershipId: "membership_b", control: { reason: " ", sourceProposalRef: null } },
  });
  invalid(
    new Proxy(revoke("membership_b"), {
      getPrototypeOf() {
        throw Error("private payload");
      },
    }),
  );
  const bad = (mutate) => {
    const f = facts();
    mutate(f);
    invalid(revoke("membership_b"), f, "KILL_SWITCH_FACTS_INVALID");
  };
  bad((f) => f.records.push(record("member", "membership_b", { workspaceId: "workspace_b" })));
  bad((f) => (f.records[0].revision = 1));
  bad((f) => (f.extra = true));
  bad((f) => (f.ownership.activeHumanMembershipCount = -1));
  bad((f) => (f.ownership.lastMembershipChangeAt = "yesterday"));
  bad((f) => (f.grants = [{ storeIds: ["store_a", "store_a"], connectionIds: [] }]));
  // A source proposal resolved for a request that names none is an inconsistent reader.
  bad(
    (f) =>
      (f.sourceProposal = {
        ref: proposalRef,
        capabilityId: "governance.membership.revoke",
        targets: [{ kind: "member", id: "membership_b" }],
      }),
  );
});
