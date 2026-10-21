// M2 PR-2: the store-link grant template (ADR-0022 item 3). The SQL function
// morrow_identity.store_link_grants_v1() is the authority; packages/policy's twin must equal
// it row for row, and every grant link_workspace_store builds from it must be a valid
// current Grant on the store resource that the human kernel then allows exactly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  createHumanPolicyService,
  listingFieldPaths,
  storeLinkGrantTemplate,
  storeLinkIssuer,
  storeResource,
} from "../packages/policy/src/index.ts";
import catalogue from "../docs/contracts/capabilities.json" with { type: "json" };

// The migration is located by its slug, never its number (renumbered at the final rebase).
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const file = manifest.migrations.find((m) => m.file.endsWith(".shopify-install-identity.sql"));
const sql = readFileSync("migrations/" + file.file, "utf8");

function sqlTemplate() {
  const body =
    /CREATE FUNCTION morrow_identity\.store_link_grants_v1\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
      sql,
    )?.[1];
  assert.ok(body, "store_link_grants_v1 body");
  return [...body.matchAll(/\('([a-z.]+)','(\[[^\]]*\])','(\[[^\]]*\])'\)/g)].map((m) => ({
    capabilityId: m[1],
    verbs: JSON.parse(m[2]),
    fields: JSON.parse(m[3]),
  }));
}

test("the TypeScript template equals store_link_grants_v1() row for row", () => {
  const rows = sqlTemplate();
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows,
    storeLinkGrantTemplate.map((r) => ({
      capabilityId: r.capabilityId,
      verbs: [...r.verbs],
      fields: [...r.fields],
    })),
  );
  // The catalogue grants use exactly the listing FieldPaths; activate its v1 input names.
  for (const r of storeLinkGrantTemplate.slice(0, 3))
    assert.deepEqual([...r.fields], [...listingFieldPaths], r.capabilityId);
  assert.deepEqual(
    [...storeLinkGrantTemplate[3].fields],
    ["evaluation", "grant", "installationId", "revision"],
  );
  assert.ok(Object.isFrozen(storeLinkGrantTemplate));
  assert.ok(storeLinkGrantTemplate.every((r) => Object.isFrozen(r) && Object.isFrozen(r.verbs)));
});

test("each template capability exists and each verb is a Grant verb", () => {
  const ids = new Set(catalogue.capabilities.map((c) => c.id));
  for (const r of storeLinkGrantTemplate) {
    assert.ok(ids.has(r.capabilityId), r.capabilityId);
    assert.equal(new Set(r.verbs).size, r.verbs.length);
  }
  // No template grant names a kill switch or a governance capability (ADR-0022 item 3).
  for (const r of storeLinkGrantTemplate)
    assert.ok(!r.capabilityId.startsWith("governance."), r.capabilityId);
});

// The payload link_workspace_store writes, as its jsonb_build_object builds it.
function linkedGrant(row, ids) {
  const resource = storeResource(ids.org, ids.ws, ids.store, ids.connection);
  return {
    id: "grant_" + row.capabilityId.replaceAll(".", "_"),
    principal: {
      kind: "human",
      principalId: ids.principal,
      organizationId: ids.org,
      workspaceId: ids.ws,
      membershipId: ids.membership,
      installationId: null,
      mandateId: null,
    },
    capabilityId: row.capabilityId,
    verbs: [...row.verbs],
    scope: {
      organizationId: ids.org,
      workspaceId: ids.ws,
      storeIds: [ids.store],
      accountIds: [],
      resources: [{ ...resource }],
      fields: [...row.fields],
    },
    issuedBy: {
      kind: "service",
      principalId: storeLinkIssuer,
      organizationId: ids.org,
      workspaceId: ids.ws,
      membershipId: null,
      installationId: null,
      mandateId: null,
    },
    validFrom: "2026-10-20T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 2,
  };
}

test("every linked grant is a valid current Grant that the kernel allows only on its store", async () => {
  const ids = {
    org: "org_1",
    ws: "ws_1",
    store: "6f7b8c1e-1111-4222-8333-444455556666",
    connection: "7f7b8c1e-1111-4222-8333-444455556666",
    principal: "person_1",
    membership: "membership_1",
  };
  const grants = storeLinkGrantTemplate.map((row) => linkedGrant(row, ids));
  for (const grant of grants) assert.ok(validateCurrentDefinition("Grant", grant), grant.id);
  const resource = storeResource(ids.org, ids.ws, ids.store, ids.connection);
  const authority = (requested, entitlementAllowed) => ({
    readCurrent: async () => ({
      actor: grants[0].principal,
      policyRevision: 2,
      grantsRevision: 2,
      principalActive: true,
      organizationActive: true,
      workspaceActive: true,
      membershipActive: true,
      sessionCurrent: true,
      resource: requested,
      accountId: null,
      providerAllowed: true,
      entitlementAllowed,
      grants,
    }),
  });
  const decide = (capabilityId, verb, fields, requested = resource, entitled = true) =>
    createHumanPolicyService(authority(requested, entitled)).decide({
      capabilityId,
      verb,
      resource: requested,
      accountId: null,
      fields,
    });
  for (const row of storeLinkGrantTemplate)
    for (const verb of row.verbs) {
      const result = await decide(row.capabilityId, verb, [...row.fields]);
      assert.equal(result.decision.allowed, true, row.capabilityId + " " + verb);
    }
  // Publishing is paid work: the entitlement still gates execute (P01.T04a §1).
  assert.equal(
    (await decide("catalog.content.publish", "execute", ["title"], resource, false)).decision
      .reason,
    "entitlement_denied",
  );
  // Verbs the template does not give are denied.
  assert.equal(
    (await decide("catalog.products.read", "execute", ["title"])).decision.reason,
    "capability_denied",
  );
  // Another store is out of scope.
  const other = storeResource(
    ids.org,
    ids.ws,
    "8f7b8c1e-1111-4222-8333-444455556666",
    ids.connection,
  );
  assert.equal(
    (await decide("catalog.content.propose", "execute", ["title"], other)).decision.reason,
    "scope_denied",
  );
  // A field outside the listing FieldPaths is denied.
  assert.equal(
    (await decide("catalog.content.propose", "execute", ["vendor"])).decision.reason,
    "field_denied",
  );
});
