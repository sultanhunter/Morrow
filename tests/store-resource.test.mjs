// M2 PR-2a (ADR-0022 items 1-3): the store resource. The v1.1 ResourceRef gains kind
// store; Scope and Grant are replaced only to name it. The kernels and the work,
// identity and billing-state readers validate grants with the current definitions, so
// a linked owner's store-link grants parse, every v1 grant still parses, and a store
// grant covers only requests on exactly that store resource.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createHumanPolicyService,
  createWorkspacePermissionBoundary,
  PolicyBoundaryError,
} from "../packages/policy/src/index.ts";
import {
  isStoreResource,
  listingFieldPaths,
  storeResource,
  StoreResourceError,
} from "../packages/policy/src/store-resource.ts";
import * as policyIndex from "../packages/policy/src/index.ts";
import {
  AgentAuthorityError,
  createAgentAuthorityService,
} from "../packages/policy/src/agent-authority.ts";
import { spendingScope } from "../packages/policy/src/billing-state.ts";
import { decodeGrants, WorkContextUnavailable } from "../packages/work/src/context.ts";
import { snapshotGrants } from "../packages/work/src/approvals/kernel.ts";
import { identitySql, IdentityAccessError } from "../packages/identity/src/index.ts";
import {
  validateCurrentDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";
import {
  delegationFixture,
  synchronizeExecutor,
  grant as agentGrant,
  scope as agentScope,
  clone,
  at as agentAt,
} from "./fixtures/agent-authority.mjs";

const at = "2026-10-20T12:00:00.000Z";
const O = "org_a",
  W = "workspace_a",
  S = "store_a",
  C = "connection_a";
const owner = {
  kind: "human",
  principalId: "human_a",
  organizationId: O,
  workspaceId: W,
  membershipId: "membership_a",
  installationId: null,
  mandateId: null,
};
const linking = {
  kind: "service",
  principalId: "morrow.linking",
  organizationId: O,
  workspaceId: W,
  membershipId: null,
  installationId: null,
  mandateId: null,
};
const workspace = {
  organizationId: O,
  workspaceId: W,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: W,
};
const store = () => storeResource(O, W, S, C);
// A store-link grant (ADR-0022 item 3): the store resource, its store id, no accounts,
// the listing field paths, issued by the linking service, never expiring.
function storeGrant(id, capabilityId, verbs, overrides = {}) {
  return {
    id,
    principal: structuredClone(owner),
    capabilityId,
    verbs,
    scope: {
      organizationId: O,
      workspaceId: W,
      storeIds: [S],
      accountIds: [],
      resources: [structuredClone(store())],
      fields: [...listingFieldPaths],
    },
    issuedBy: structuredClone(linking),
    validFrom: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...overrides,
  };
}
// An owner-bootstrap-v1 grant: the workspace resource, no stores (unchanged v1 shape).
function workspaceGrant(id, capabilityId, verbs, fields) {
  return {
    id,
    principal: structuredClone(owner),
    capabilityId,
    verbs,
    scope: {
      organizationId: O,
      workspaceId: W,
      storeIds: [],
      accountIds: [],
      resources: [structuredClone(workspace)],
      fields,
    },
    issuedBy: { ...structuredClone(linking), principalId: "morrow.onboarding" },
    validFrom: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  };
}
// A linked owner: the v1 workspace template plus the four store-link grants.
function linkedGrants() {
  return [
    workspaceGrant("grant_goal", "workspace.goal.create", ["execute"], ["objective"]),
    storeGrant("grant_read", "catalog.products.read", ["view", "delegate"]),
    storeGrant("grant_propose", "catalog.content.propose", ["execute", "delegate"]),
    storeGrant("grant_publish", "catalog.content.publish", [
      "propose",
      "approve",
      "execute",
      "delegate",
    ]),
    storeGrant("grant_activate", "agents.installation.activate", ["execute"], {
      scope: {
        ...storeGrant("x", "x", ["view"]).scope,
        fields: ["evaluation", "grant", "installationId", "revision"],
      },
    }),
  ];
}
function authority(resource, grants = linkedGrants()) {
  return {
    actor: structuredClone(owner),
    policyRevision: 1,
    grantsRevision: 1,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource: structuredClone(resource),
    accountId: null,
    providerAllowed: true,
    entitlementAllowed: true,
    grants: structuredClone(grants),
  };
}
const request = (capabilityId, verb, resource, fields = [...listingFieldPaths]) => ({
  capabilityId,
  verb,
  resource: structuredClone(resource),
  accountId: null,
  fields,
});
const decide = (a, r) =>
  createHumanPolicyService({ readCurrent: async () => a }, () => new Date(at)).decide(r);
const reason = async (a, r) => (await decide(a, r)).decision.reason;

test("storeResource builds the exact store resource; listingFieldPaths is ADR-0022 item 1", () => {
  const r = store();
  assert.deepEqual(r, {
    organizationId: O,
    workspaceId: W,
    storeId: S,
    connectionId: C,
    kind: "store",
    id: S,
  });
  assert.ok(Object.isFrozen(r));
  assert.equal(validateCurrentDefinition("ResourceRef", r), true);
  assert.equal(validateDefinition("core", "ResourceRef", r), false);
  assert.equal(isStoreResource(r), true);
  assert.equal(isStoreResource(workspace), false);
  assert.equal(isStoreResource({ ...r, id: "store_b" }), false);
  assert.equal(isStoreResource({ ...r, connectionId: null }), false);
  for (const args of [
    ["", W, S, C],
    [O, W, S, null],
    [O, W, null, C],
    [O, "bad id", S, C],
    [O, W, S, "x".repeat(129)],
    [O, W, { toString: () => S }, C],
  ])
    assert.throws(
      () => storeResource(...args),
      (e) => e instanceof StoreResourceError && e.code === "STORE_RESOURCE_INPUT_INVALID",
      JSON.stringify(args),
    );
  assert.deepEqual(listingFieldPaths, [
    "descriptionHtml",
    "seo.description",
    "seo.title",
    "tags",
    "title",
  ]);
  assert.ok(Object.isFrozen(listingFieldPaths));
  assert.deepEqual([...listingFieldPaths].sort(), [...listingFieldPaths]);
  for (const field of listingFieldPaths)
    assert.equal(validateCurrentDefinition("FieldPath", field), true, field);
  // One constructor: the package root re-exports the same functions and list.
  assert.equal(policyIndex.storeResource, storeResource);
  assert.equal(policyIndex.listingFieldPaths, listingFieldPaths);
  // ADR-0022 item 1: both content capabilities add tags (catalogue:render keeps the
  // rendered catalogue in step).
  const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
  for (const id of ["catalog.content.propose", "catalog.content.publish"]) {
    const c = catalogue.capabilities.find((x) => x.id === id);
    assert.deepEqual(c.field_scope, [
      "title",
      "description",
      "SEO title",
      "SEO description",
      "tags",
    ]);
  }
  for (const doc of ["capabilities.md", "permission-matrix.md"])
    assert.match(
      readFileSync("docs/contracts/" + doc, "utf8"),
      /title, description, SEO title, SEO description, tags/,
      doc,
    );
});

test("human kernel: a store grant allows exactly its store resource and listing fields", async () => {
  const r = store();
  for (const [capabilityId, verb] of [
    ["catalog.products.read", "view"],
    ["catalog.products.read", "delegate"],
    ["catalog.content.propose", "execute"],
    ["catalog.content.publish", "propose"],
    ["catalog.content.publish", "approve"],
    ["catalog.content.publish", "execute"],
  ]) {
    const result = await decide(authority(r), request(capabilityId, verb, r));
    assert.equal(result.decision.allowed, true, capabilityId + " " + verb);
    assert.equal(validateCurrentDefinition("PolicyDecision", result.decision), true);
  }
  // The publish write carries the external-write obligations (ADR-0011): exact approval
  // and provider verification, as on any other resource.
  const publish = await decide(authority(r), request("catalog.content.publish", "execute", r));
  assert.deepEqual(publish.obligations, [
    "recheck_at_dispatch",
    "exact_approval",
    "provider_effect_verification",
  ]);
  const activate = request("agents.installation.activate", "execute", r, [
    "grant",
    "installationId",
  ]);
  assert.equal((await decide(authority(r), activate)).decision.allowed, true);
  // A subset of the listing fields is allowed; any other field is not.
  assert.equal(
    await reason(authority(r), request("catalog.content.propose", "execute", r, ["tags"])),
    "allowed",
  );
  assert.equal(
    await reason(
      authority(r),
      request("catalog.content.propose", "execute", r, ["title", "variants"]),
    ),
    "field_denied",
  );
  // Verbs the template does not grant stay denied.
  for (const [capabilityId, verb] of [
    ["catalog.products.read", "execute"],
    ["catalog.content.propose", "approve"],
    ["catalog.content.publish", "administer"],
    ["agents.installation.activate", "delegate"],
  ])
    assert.equal(
      await reason(authority(r), request(capabilityId, verb, r)),
      "capability_denied",
      capabilityId + " " + verb,
    );
});

test("human kernel: a store grant covers no other resource, store or connection", async () => {
  const r = store();
  const product = { ...r, kind: "product", id: "product:1" };
  const otherStore = storeResource(O, W, "store_b", C);
  const otherConnection = storeResource(O, W, S, "connection_b");
  // Kernels match resources exactly: a store grant is not a grant on each product.
  for (const target of [product, otherStore, otherConnection, workspace])
    assert.equal(
      await reason(authority(target), request("catalog.products.read", "view", target)),
      "scope_denied",
      JSON.stringify(target),
    );
  // A workspace-level grant does not reach the store resource.
  const workspaceRead = workspaceGrant(
    "grant_ws_read",
    "catalog.products.read",
    ["view"],
    [...listingFieldPaths],
  );
  assert.equal(
    await reason(authority(r, [workspaceRead]), request("catalog.products.read", "view", r)),
    "scope_denied",
  );
  // The storeIds rule is unchanged: the grant must list the store.
  const unlisted = storeGrant("grant_unlisted", "catalog.products.read", ["view"]);
  unlisted.scope.storeIds = [];
  assert.equal(
    await reason(authority(r, [unlisted]), request("catalog.products.read", "view", r)),
    "scope_denied",
  );
  // The authority's resource must be the request's (scope_denied otherwise).
  assert.equal(
    await reason(authority(workspace), request("catalog.products.read", "view", r)),
    "scope_denied",
  );
  // The workspace permission boundary decides on the session's workspace resource
  // only, so a store-resource request is denied there, never unavailable.
  const boundary = createWorkspacePermissionBoundary(
    linkedPool().pool,
    { readCurrent: async () => ({ providerAllowed: true, entitlementAllowed: true }) },
    () => new Date(at),
  );
  const result = await boundary.decide(
    "c".repeat(64),
    W,
    request("catalog.products.read", "view", r),
  );
  assert.equal(result.decision.reason, "scope_denied");
});

test("human kernel: the store rule (id = storeId) fails closed on requests and grants", async () => {
  const r = store();
  const misnamed = { ...r, id: "store_b" };
  await assert.rejects(
    decide(authority(r), request("catalog.products.read", "view", misnamed)),
    (e) => e instanceof PolicyBoundaryError && e.code === "POLICY_INPUT_INVALID",
  );
  for (const resource of [
    { ...r, storeId: null },
    { ...r, connectionId: null },
  ])
    await assert.rejects(
      decide(authority(r), request("catalog.products.read", "view", resource)),
      (e) => e instanceof PolicyBoundaryError && e.code === "POLICY_INPUT_INVALID",
    );
  const bad = storeGrant("grant_bad", "catalog.products.read", ["view"]);
  bad.scope.resources = [misnamed];
  await assert.rejects(
    decide(authority(r, [...linkedGrants(), bad]), request("catalog.products.read", "view", r)),
    (e) => e instanceof PolicyBoundaryError && e.code === "POLICY_AUTHORITY_UNAVAILABLE",
  );
  // An authority resource that breaks the rule is unavailable too.
  await assert.rejects(
    decide(authority(misnamed), request("catalog.products.read", "view", r)),
    (e) => e instanceof PolicyBoundaryError && e.code === "POLICY_AUTHORITY_UNAVAILABLE",
  );
});

test("a linked owner's workspace work keeps working: store grants parse beside v1 grants", async () => {
  // Before ADR-0022 item 2 every grant was re-validated against frozen v1, so one
  // store-link grant made every decision for the owner POLICY_AUTHORITY_UNAVAILABLE.
  const goal = request("workspace.goal.create", "execute", workspace, ["objective"]);
  assert.equal(await reason(authority(workspace), goal), "allowed");
  for (const g of linkedGrants().slice(1))
    assert.equal(validateDefinition("core", "Grant", g), false, g.id);
  assert.equal(validateDefinition("core", "Grant", linkedGrants()[0]), true);
  // The same through the identity reader and the workspace permission boundary.
  const db = linkedPool();
  const boundary = createWorkspacePermissionBoundary(
    db.pool,
    { readCurrent: async () => ({ providerAllowed: true, entitlementAllowed: false }) },
    () => new Date(at),
  );
  const result = await boundary.decide("c".repeat(64), W, goal);
  assert.equal(result.decision.allowed, true);
  // A grant row that breaks the store rule denies the read (fail closed).
  const broken = linkedPool({ misnamed: true });
  const denied = createWorkspacePermissionBoundary(
    broken.pool,
    { readCurrent: async () => ({ providerAllowed: true, entitlementAllowed: false }) },
    () => new Date(at),
  );
  await assert.rejects(
    denied.decide("c".repeat(64), W, goal),
    (e) => e instanceof IdentityAccessError && e.code === "IDENTITY_UNAVAILABLE",
  );
});

test("work context and approval snapshots decode store grants; a misnamed store fails closed", () => {
  const grants = linkedGrants();
  const decoded = decodeGrants(JSON.stringify(grants), String(grants.length));
  assert.deepEqual(clone(decoded), grants);
  assert.ok(Object.isFrozen(decoded));
  assert.deepEqual(clone(snapshotGrants(JSON.stringify(grants), String(grants.length))), grants);
  const bad = linkedGrants();
  bad[1].scope.resources[0].id = "store_b";
  assert.throws(
    () => decodeGrants(JSON.stringify(bad), String(bad.length)),
    WorkContextUnavailable,
  );
  const nulled = linkedGrants();
  nulled[1].scope.resources[0].connectionId = null;
  assert.throws(
    () => decodeGrants(JSON.stringify(nulled), String(nulled.length)),
    WorkContextUnavailable,
  );
  // Every v1 grant still decodes: the P01.A02 Grant case and an owner-bootstrap-v1 row.
  const fixture = JSON.parse(readFileSync("docs/contracts/fixtures/P01.A02.json", "utf8")).find(
    (f) => f.id === "P01.A02.schema.valid.Grant",
  ).value;
  const v1 = [fixture, linkedGrants()[0]];
  assert.deepEqual(clone(decodeGrants(JSON.stringify(v1), "2")), v1);
});

test("billing spendingScope reads store grants: paid store work names its store", () => {
  const r = store();
  const scope = spendingScope(
    linkedGrants(),
    owner,
    request("catalog.content.publish", "execute", r),
    1,
    at,
  );
  assert.deepEqual(clone(scope), { workspace: true, storeIds: [S] });
  // Unpaid verbs stay empty, as before.
  assert.deepEqual(
    clone(spendingScope(linkedGrants(), owner, request("catalog.products.read", "view", r), 1, at)),
    { workspace: false, storeIds: [] },
  );
  const bad = linkedGrants();
  bad[3].scope.resources[0].id = "store_b";
  assert.throws(
    () => spendingScope(bad, owner, request("catalog.content.publish", "execute", r), 1, at),
    /BILLING_INPUT_INVALID/,
  );
  assert.throws(
    () =>
      spendingScope(
        linkedGrants(),
        owner,
        request("catalog.content.publish", "execute", { ...r, id: "store_b" }),
        1,
        at,
      ),
    /BILLING_INPUT_INVALID/,
  );
});

test("agent kernel: store-scoped grants and installations parse; a misnamed store fails closed", async () => {
  const run = (f) =>
    createAgentAuthorityService(
      {
        readDelegationCurrent: async () => JSON.stringify(f.facts),
        readAutomationCurrent: async () => JSON.stringify(f.facts),
      },
      () => new Date(agentAt),
    ).decideDelegation(JSON.stringify(f.input));
  // A store-link grant held by the origin, and a store-scoped grant held by the installed
  // specialist (with its record and ref), leave an allowed delegation allowed.
  const f = delegationFixture();
  const storeScope = agentScope([store()], [...listingFieldPaths]);
  storeScope.accountIds = [];
  f.facts.origin.grants.push(
    agentGrant(
      "owner_store_read",
      f.facts.origin.actor,
      "catalog.products.read",
      ["view"],
      storeScope,
    ),
  );
  f.facts.executor.current.grants.push(
    agentGrant(
      "specialist_store_read",
      f.facts.executor.current.actor,
      "catalog.products.read",
      ["view"],
      storeScope,
    ),
  );
  synchronizeExecutor(f.facts);
  const allowed = await run(f);
  assert.equal(allowed.decision.allowed, true);
  // The same facts with the store grant misnamed fail closed.
  const broken = clone(f);
  broken.facts.origin.grants.at(-1).scope.resources[0].id = "store_b";
  await assert.rejects(
    run(broken),
    (e) => e instanceof AgentAuthorityError && e.code === "AGENT_POLICY_AUTHORITY_UNAVAILABLE",
  );
  // An agent request on the store resource itself parses (current ResourceRef), and since
  // M3 PR-1 so does a store-scoped installation (AgentInstallation v1.1, a declared
  // superset). With an envelope, hop and grants that do not name the store, the kernel
  // denies it; tests/agent-delegation-reader.test.mjs covers the admitted store run.
  const onStore = delegationFixture();
  onStore.input.operation.resource = store();
  onStore.input.operation.accountId = null;
  onStore.input.operation.fields = ["title"];
  onStore.facts.constraints.resource = store();
  onStore.facts.constraints.accountId = null;
  onStore.facts.executor.installation.scope = storeScope;
  const denied = await run(onStore);
  assert.equal(denied.decision.allowed, false);
  assert.equal(denied.lineage, null);
  // A misnamed store in the installation's scope still fails closed (the store rule).
  const misnamedScope = clone(onStore);
  misnamedScope.facts.executor.installation.scope.resources[0].id = "store_b";
  await assert.rejects(
    run(misnamedScope),
    (e) => e instanceof AgentAuthorityError && e.code === "AGENT_POLICY_AUTHORITY_UNAVAILABLE",
  );
  // A malformed store resource in the request is refused as input.
  const misnamed = delegationFixture();
  misnamed.input.operation.resource = { ...store(), id: "store_b" };
  await assert.rejects(
    run(misnamed),
    (e) => e instanceof AgentAuthorityError && e.code === "AGENT_POLICY_INPUT_INVALID",
  );
});

// An identity pool whose workspace authority row carries the linked owner's grants.
function linkedPool({ misnamed = false } = {}) {
  const context = {
    principal_id: owner.principalId,
    organization_id: O,
    workspace_id: W,
    membership_id: owner.membershipId,
    policy_revision: "1",
  };
  const grants = linkedGrants();
  if (misnamed) grants[1].scope.resources[0].id = "store_b";
  const client = {
    async query(text) {
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
      if (text === identitySql.resolve) return { rows: [context] };
      if (text === identitySql.workspaceAuthority) return { rows: [{ ...context, grants }] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } };
}
