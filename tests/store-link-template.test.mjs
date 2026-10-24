// M2 PR-2: the store-link grant template (ADR-0022 item 3); "Disconnect store": its version
// 2 (the item 3 amendment of 2026-10-22). The SQL functions morrow_identity.store_link_grants_v1()
// and _v2() are the authority; packages/policy's twins must equal them row for row, and
// every grant link_workspace_store builds from the current one must be a valid current Grant
// on the store resource that the human kernel then allows exactly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  createHumanPolicyService,
  disconnectFields,
  listingFieldPaths,
  storeLinkGrantTemplate,
  storeLinkGrantTemplateV1,
  storeLinkIssuer,
  storeLinkTemplateId,
  storeResource,
} from "../packages/policy/src/index.ts";
import catalogue from "../docs/contracts/capabilities.json" with { type: "json" };

// The migrations are located by their slugs, never their numbers (renumbered at the final
// rebase).
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const migration = (slug) =>
  readFileSync(
    "migrations/" + manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql")).file,
    "utf8",
  );
const sqlV1 = migration("shopify-install-identity");
const sqlV2 = migration("disconnect-store-identity");

function sqlTemplate(sql, version) {
  const body = new RegExp(
    `CREATE FUNCTION morrow_identity\\.store_link_grants_${version}\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
  ).exec(sql)?.[1];
  assert.ok(body, `store_link_grants_${version} body`);
  const row = /\('([a-z.]+)','(\[[^\]]*\])','(\[[^\]]*\])'\)/g;
  const rows = [...body.matchAll(row)].map((m) => ({
    capabilityId: m[1],
    verbs: JSON.parse(m[2]),
    fields: JSON.parse(m[3]),
  }));
  // Nothing else is in the body: with each row read above replaced by one token and
  // whitespace removed, it is exactly the one VALUES list of those rows.
  assert.equal(
    body.replace(row, "ROW").replace(/\s+/g, ""),
    `SELECTc,v::jsonb,f::jsonbFROM(VALUES${rows.map(() => "ROW").join(",")})t(c,v,f)`,
  );
  return rows;
}
const plain = (rows) =>
  rows.map((r) => ({ capabilityId: r.capabilityId, verbs: [...r.verbs], fields: [...r.fields] }));

test("the TypeScript templates equal store_link_grants_v1() and _v2() row for row", () => {
  const v1 = sqlTemplate(sqlV1, "v1");
  const v2 = sqlTemplate(sqlV2, "v2");
  assert.equal(v1.length, 4);
  assert.deepEqual(v1, plain(storeLinkGrantTemplateV1));
  assert.equal(v2.length, 5);
  assert.deepEqual(v2, plain(storeLinkGrantTemplate));
  // Version 2 is version 1 and exactly one more row: the disconnect kill switch.
  assert.deepEqual(v2.slice(0, 4), v1);
  assert.deepEqual(v2[4], {
    capabilityId: "governance.connection.disconnect",
    verbs: ["execute"],
    fields: ["connectionId", "control"],
  });
  assert.deepEqual([...disconnectFields], ["connectionId", "control"]);
  assert.equal(storeLinkTemplateId, "store-link-v2");
  // The catalogue grants use exactly the listing FieldPaths; activate its v1 input names.
  for (const r of storeLinkGrantTemplate.slice(0, 3))
    assert.deepEqual([...r.fields], [...listingFieldPaths], r.capabilityId);
  assert.deepEqual(
    [...storeLinkGrantTemplate[3].fields],
    ["evaluation", "grant", "installationId", "revision"],
  );
  for (const t of [storeLinkGrantTemplate, storeLinkGrantTemplateV1]) {
    assert.ok(Object.isFrozen(t));
    assert.ok(t.every((r) => Object.isFrozen(r) && Object.isFrozen(r.verbs)));
  }
});

test("each template capability exists and each verb is a Grant verb", () => {
  const ids = new Set(catalogue.capabilities.map((c) => c.id));
  for (const r of storeLinkGrantTemplate) {
    assert.ok(ids.has(r.capabilityId), r.capabilityId);
    assert.equal(new Set(r.verbs).size, r.verbs.length);
  }
  // The one governance capability, and the one kill switch, is "Disconnect store" (ADR-0022
  // item 3 as amended 2026-10-22): execute only, never delegated, approved or administered.
  const governance = storeLinkGrantTemplate.filter((r) => r.capabilityId.startsWith("governance."));
  assert.deepEqual(plain(governance), [
    {
      capabilityId: "governance.connection.disconnect",
      verbs: ["execute"],
      fields: ["connectionId", "control"],
    },
  ]);
  const killSwitches = new Set(
    catalogue.capabilities.filter((c) => c.kill_switch).map((c) => c.id),
  );
  assert.deepEqual(
    storeLinkGrantTemplate
      .filter((r) => killSwitches.has(r.capabilityId))
      .map((r) => r.capabilityId),
    ["governance.connection.disconnect"],
  );
  // Its input fields are exactly the grant's.
  const disconnect = catalogue.capabilities.find(
    (c) => c.id === "governance.connection.disconnect",
  );
  assert.deepEqual(Object.keys(disconnect.input.fields).sort(), [...disconnectFields]);
  assert.equal(disconnect.executor, "human_only");
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
  // "Disconnect store" is a kill switch: allowed with the kill_switch_record obligation and
  // no approval, never paid work (an unentitled workspace can still disconnect).
  const disconnect = await decide(
    "governance.connection.disconnect",
    "execute",
    ["connectionId", "control"],
    resource,
    false,
  );
  assert.equal(disconnect.decision.allowed, true);
  assert.ok(disconnect.obligations.includes("kill_switch_record"));
  assert.ok(!disconnect.obligations.includes("exact_approval"));
  // Only its own store and connection: another connection of the same store id is out of
  // scope, and so is the workspace resource.
  const otherConnection = storeResource(
    ids.org,
    ids.ws,
    ids.store,
    "9f7b8c1e-1111-4222-8333-444455556666",
  );
  assert.equal(
    (await decide("governance.connection.disconnect", "execute", ["connectionId"], otherConnection))
      .decision.reason,
    "scope_denied",
  );
  assert.equal(
    (
      await decide("governance.connection.disconnect", "execute", ["connectionId"], {
        organizationId: ids.org,
        workspaceId: ids.ws,
        storeId: null,
        connectionId: null,
        kind: "workspace",
        id: ids.ws,
      })
    ).decision.reason,
    "scope_denied",
  );
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
