// M3 PR-1 (ADR-0022 items 3, 15 and 16, with the item 3 amendment of 2026-10-20): the
// Listings agent's records, its kernel requests and its commands, with no I/O. The SQL
// side of every rule runs against PostgreSQL 17 in lab:listings-authority.
//   * The release manifest, scope, grant set, owner disable grant and installation
//     document are exactly what the listings-authority migration seeds and checks.
//   * Enable and resume need agents.installation.activate {execute} on the store resource
//     (its exact_approval obligation is met by the confirmed document) and every verb the
//     installation receives; "Stop AI work" needs agents.installation.disable {execute} on
//     the installation resource; the model default needs governance.model_default.revise.
//   * The commands run the kernel before their definer, rerun it at confirmation, never
//     send a definer after a denial, and "Stop AI work" never reads entitlement or credits.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  validateCurrentDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { storeLinkGrantTemplate } from "../packages/policy/src/store-link-template.ts";
import { canonicalJson } from "../packages/work/src/digest.ts";
import { WorkReject } from "../packages/work/src/connection.ts";
import {
  agentRequestDigest,
  enableAllowed,
  prepareAgentCommand,
  reviseAllowed,
  runAgentCommand,
  runAgentRead,
  stopAllowed,
} from "../packages/work/src/agents/commands.ts";
import {
  parseDocumentBody,
  parseEnableBody,
  parseModelDefaultBody,
  parseStopBody,
} from "../packages/work/src/agents/bodies.ts";
import {
  buildInstallationDocument,
  disableFields,
  documentLifetimeMs,
  enableRequestFields,
  installationGrants,
  installationResource,
  installationScope,
  listingsConfiguration,
  listingsConfigurationDigest,
  listingsGrantSet,
  listingsReleaseDigest,
  listingsReleaseManifest,
  listingsScope,
  ownerDisableGrant,
  parseInstallationDocument,
} from "../packages/work/src/agents/listings.ts";
import { agentStatements } from "../packages/work/src/agents/sql.ts";
import { workStatements } from "../packages/work/src/sql.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// Migrations are found by slug, never by number (they are renumbered at rebase).
const migration = (slug) =>
  readFileSync(
    "migrations/" + manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql")).file,
    "utf8",
  );
const authoritySql = migration("listings-authority");
const identitySql = migration("listings-identity-bridge");

const O = "org_o",
  W = "ws_w",
  S = "store_a",
  C = "connection_a",
  I = "installation_a";
const nowMs = Date.parse("2026-10-20T12:00:00.000Z");
const owner = Object.freeze({
  kind: "human",
  principalId: "person_owner",
  organizationId: O,
  workspaceId: W,
  membershipId: "membership_owner",
  installationId: null,
  mandateId: null,
});
const member = Object.freeze({
  ...owner,
  principalId: "person_member",
  membershipId: "membership_member",
});
const workspace = {
  organizationId: O,
  workspaceId: W,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: W,
};
const store = () => storeResource(O, W, S, C);
const linking = { ...owner, kind: "service", principalId: "morrow.linking", membershipId: null };
function grant(id, principal, capabilityId, verbs, resource, fields, overrides = {}) {
  const g = {
    id,
    principal: structuredClone(principal),
    capabilityId,
    verbs,
    scope: {
      organizationId: O,
      workspaceId: W,
      storeIds: resource.storeId === null ? [] : [resource.storeId],
      accountIds: [],
      resources: [structuredClone(resource)],
      fields,
    },
    issuedBy: structuredClone(linking),
    validFrom: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...overrides,
  };
  assert.equal(validateCurrentDefinition("Grant", g), true, id);
  return g;
}
const activateFields = ["evaluation", "grant", "installationId", "revision"];
const reviseFields = ["effort", "expectedRevision", "maxCreditsPerProduct", "model"];
// The linked owner of M2 PR-2's store-link template, plus the disable grant of an enabled
// installation and the model-default capability of signup template v2 (M5 PR-1).
function ownerGrants(who = owner, { activate = true, disable = true, revise = true } = {}) {
  const tag = who.principalId;
  const list = [
    grant(tag + "_read", who, "catalog.products.read", ["view", "delegate"], store(), [
      ...listingFieldPaths,
    ]),
    grant(tag + "_propose", who, "catalog.content.propose", ["execute", "delegate"], store(), [
      ...listingFieldPaths,
    ]),
    grant(
      tag + "_publish",
      who,
      "catalog.content.publish",
      ["propose", "approve", "execute", "delegate"],
      store(),
      [...listingFieldPaths],
    ),
  ];
  if (activate)
    list.push(
      grant(tag + "_activate", who, "agents.installation.activate", ["execute"], store(), [
        ...activateFields,
      ]),
    );
  if (disable)
    list.push(
      grant(
        tag + "_disable",
        who,
        "agents.installation.disable",
        ["execute"],
        installationResource(store(), I),
        ["control", "installationId"],
      ),
    );
  if (revise)
    list.push(
      grant(tag + "_revise", who, "governance.model_default.revise", ["execute"], workspace, [
        ...reviseFields,
      ]),
    );
  return list;
}
const authority = (grants = ownerGrants(), who = owner) => ({
  actor: structuredClone(who),
  policyRevision: 1,
  grants,
  databaseNowMs: nowMs,
  resource: structuredClone(workspace),
});

// ---------------------------------------------------------------------------
test("the release manifest and configuration are exactly what the migration seeds", async () => {
  assert.ok(authoritySql.includes("('" + listingsReleaseManifest + "')"));
  assert.equal(await listingsReleaseDigest(), sha(listingsReleaseManifest));
  const parsed = JSON.parse(listingsReleaseManifest);
  assert.deepEqual(parsed.fields, [...listingFieldPaths]);
  // The release carries exactly the installation's verbs: never approve or execute on
  // catalog.content.publish.
  assert.deepEqual(
    parsed.capabilities,
    Object.fromEntries(listingsGrantSet.map((g) => [g.capabilityId, [...g.verbs]])),
  );
  assert.equal(canonicalJson(parsed), listingsReleaseManifest);
  assert.ok(authoritySql.includes("morrow_work.sha256_text('" + listingsConfiguration + "')"));
  assert.equal(await listingsConfigurationDigest(), sha(listingsConfiguration));
  assert.deepEqual(
    listingsGrantSet.map((g) => [g.capabilityId, [...g.verbs]]),
    [
      ["catalog.content.propose", ["execute"]],
      ["catalog.content.publish", ["propose"]],
      ["catalog.products.read", ["view"]],
    ],
  );
  // The SQL grant set (listings_grant_set) names the same rows in the same order.
  for (const g of listingsGrantSet)
    assert.ok(
      authoritySql.includes(
        `jsonb_build_object('capabilityId','${g.capabilityId}','verbs','${JSON.stringify(g.verbs)}'::jsonb`,
      ),
      g.capabilityId,
    );
  // The identity bridge's allowlist is the same three grants and never more.
  assert.match(identitySql, /'catalog\.products\.read' AND g->'verbs'='\["view"\]'::jsonb/);
  assert.match(identitySql, /'catalog\.content\.propose' AND g->'verbs'='\["execute"\]'::jsonb/);
  assert.match(identitySql, /'catalog\.content\.publish' AND g->'verbs'='\["propose"\]'::jsonb/);
});

test("scopes: the installation owns exactly its store resource; the owner its installation", () => {
  const scope = listingsScope(store());
  assert.deepEqual(scope, {
    organizationId: O,
    workspaceId: W,
    storeIds: [S],
    accountIds: [],
    resources: [store()],
    fields: [...listingFieldPaths],
  });
  const resource = installationResource(store(), I);
  assert.deepEqual(resource, {
    organizationId: O,
    workspaceId: W,
    storeId: S,
    connectionId: C,
    kind: "installation",
    id: I,
  });
  assert.deepEqual(installationScope(store(), I), {
    organizationId: O,
    workspaceId: W,
    storeIds: [S],
    accountIds: [],
    resources: [resource],
    fields: ["control", "installationId"],
  });
  assert.throws(() => installationResource(store(), "bad id"), /LISTINGS_RECORD_INVALID/);
});

test("the installation document: server-built, bound to the actor, five minutes, canonical", async () => {
  const id = randomUUID();
  const built = await buildInstallationDocument({
    id,
    purpose: "enable",
    store: store(),
    installationId: I,
    actor: owner,
    createdAtMs: nowMs,
  });
  const d = built.document;
  assert.equal(built.canonical, canonicalJson(JSON.parse(built.canonical)));
  assert.equal(built.digest, sha(built.canonical));
  assert.equal(documentLifetimeMs, 300000);
  assert.deepEqual(
    [d.schemaVersion, d.kind, d.id, d.purpose, d.installationId, d.createdAt, d.expiresAt],
    [
      1,
      "morrow.agent_installation_document",
      id,
      "enable",
      I,
      "2026-10-20T12:00:00.000Z",
      "2026-10-20T12:05:00.000Z",
    ],
  );
  assert.deepEqual(d.actor, { principalId: owner.principalId, membershipId: owner.membershipId });
  assert.deepEqual(d.release, {
    id: "morrow.listings",
    revision: 1,
    digest: sha(listingsReleaseManifest),
  });
  assert.deepEqual(d.store, store());
  assert.deepEqual(
    d.grants.map((g) => [g.capabilityId, g.verbs, g.scope]),
    listingsGrantSet.map((g) => [g.capabilityId, [...g.verbs], listingsScope(store())]),
  );
  assert.deepEqual(d.ownerGrant, {
    capabilityId: "agents.installation.disable",
    verbs: ["execute"],
    scope: installationScope(store(), I),
  });
  // The SQL check (enable_document_matches) rebuilds exactly these keys.
  for (const key of Object.keys(d))
    assert.ok(authoritySql.includes(`'${key}'`), "enable_document_matches names " + key);
  // A resume document differs only in its purpose, so the digest changes.
  const resume = await buildInstallationDocument({
    id,
    purpose: "resume",
    store: store(),
    installationId: I,
    actor: owner,
    createdAtMs: nowMs,
  });
  assert.notEqual(resume.digest, built.digest);
  assert.deepEqual(parseInstallationDocument(built.canonical), JSON.parse(built.canonical));
  // Any other text is refused: a non-canonical rendering, another kind, a bad store, a
  // widened grant, another owner grant, another release or an extra key.
  const tampered = (edit) => {
    const value = JSON.parse(built.canonical);
    edit(value);
    return canonicalJson(value);
  };
  for (const bad of [
    tampered((v) => v.grants[1].verbs.push("execute")),
    tampered((v) => (v.grants[0].scope.fields = ["title"])),
    tampered((v) => v.grants.pop()),
    tampered((v) => (v.ownerGrant.scope.resources[0].id = "installation_b")),
    tampered((v) => (v.release.id = "morrow.other")),
    tampered((v) => (v.store = storeResource(O, W, "store_b", C))),
    tampered((v) => (v.extra = 1)),
    JSON.stringify(JSON.parse(built.canonical), null, 1),
    built.canonical.replace('"enable"', '"install"'),
    built.canonical.replace('"kind":"store"', '"kind":"workspace"'),
    "{",
    42,
    "x".repeat(16385),
  ])
    assert.throws(() => parseInstallationDocument(bad), /LISTINGS_RECORD_INVALID/);
  // Only a human member of the store's own tenant, with exact ids and an integer time.
  for (const change of [
    { actor: { ...owner, kind: "agent", membershipId: null, installationId: I } },
    { actor: { ...owner, membershipId: null } },
    { actor: { ...owner, organizationId: "org_p" } },
    { actor: { ...owner, workspaceId: "ws_other" } },
    { id: "not-a-uuid" },
    { installationId: "bad id" },
    { createdAtMs: nowMs + 0.5 },
  ])
    await assert.rejects(
      buildInstallationDocument({
        id,
        purpose: "enable",
        store: store(),
        installationId: I,
        actor: owner,
        createdAtMs: nowMs,
        ...change,
      }),
      /LISTINGS_RECORD_INVALID/,
    );
});

test("installation grants: the owner issues exactly the release's verbs to the agent", () => {
  const agentPrincipalId = "agent_" + randomUUID();
  const grants = installationGrants({
    store: store(),
    installationId: I,
    agentPrincipalId,
    issuer: owner,
    validFrom: "2026-10-20T12:00:00.000Z",
    policyRevision: 3,
    ids: ["g1", "g2", "g3"],
  });
  assert.equal(grants.length, 3);
  for (const [i, g] of grants.entries()) {
    assert.equal(validateCurrentDefinition("Grant", g), true);
    // A v1 reader refuses a store-scoped grant (fails closed).
    assert.equal(validateDefinition("core", "Grant", g), false);
    assert.deepEqual(g.principal, {
      kind: "agent",
      principalId: agentPrincipalId,
      organizationId: O,
      workspaceId: W,
      membershipId: null,
      installationId: I,
      mandateId: null,
    });
    assert.deepEqual(g.issuedBy, owner);
    assert.deepEqual(
      [g.capabilityId, g.verbs],
      [listingsGrantSet[i].capabilityId, [...listingsGrantSet[i].verbs]],
    );
    assert.deepEqual(g.scope, listingsScope(store()));
    assert.deepEqual([g.expiresAt, g.revokedAt, g.policyRevision], [null, null, 3]);
  }
  const verbsOf = (c) => grants.find((g) => g.capabilityId === c).verbs;
  assert.deepEqual(verbsOf("catalog.content.publish"), ["propose"]);
  assert.throws(
    () =>
      installationGrants({
        store: store(),
        installationId: I,
        agentPrincipalId,
        issuer: owner,
        validFrom: "2026-10-20T12:00:00.000Z",
        policyRevision: 3,
        ids: ["g1", "g2"],
      }),
    /LISTINGS_RECORD_INVALID/,
  );
  const disable = ownerDisableGrant({
    store: store(),
    installationId: I,
    owner,
    validFrom: "2026-10-20T12:00:00.000Z",
    policyRevision: 3,
    id: "g4",
  });
  assert.deepEqual(disable.principal, owner);
  assert.deepEqual(
    [disable.capabilityId, disable.verbs, disable.issuedBy.kind, disable.issuedBy.principalId],
    ["agents.installation.disable", ["execute"], "service", "morrow.agents"],
  );
  assert.deepEqual(disable.scope, installationScope(store(), I));
  assert.equal(validateCurrentDefinition("Grant", disable), true);
});

// ---------------------------------------------------------------------------
// M2 PR-2's store-link template (store_link_grants_v1() in its migration and the TypeScript
// twin) is what the linking owner holds on the store, and the linking owner is the
// organization's founding principal (ADR-0022 item 3 and its 2026-10-21 amendment). The
// installation and the enable request stay inside it, and nothing in M3 issues
// agents.installation.activate. lab:listings-authority G3 and G4 prove the same on the
// applied catalog; lab:shopify-install K4 and L16 prove the founder-only link.
const shopifySql = migration("shopify-install-identity");
const code = (sql) => sql.replace(/--[^\n]*/g, "");
function sqlStoreLinkTemplate() {
  const body =
    /CREATE FUNCTION morrow_identity\.store_link_grants_v1\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
      shopifySql,
    )?.[1];
  assert.ok(body, "store_link_grants_v1 body");
  return [...body.matchAll(/\('([a-z.]+)','(\[[^\]]*\])','(\[[^\]]*\])'\)/g)].map((m) => ({
    capabilityId: m[1],
    verbs: JSON.parse(m[2]),
    fields: JSON.parse(m[3]),
  }));
}

// The grants of listings_grant_set's body, in order (capability, verbs; each one's scope is
// listings_scope, whose fields are listingFieldPaths).
function sqlListingsGrantSet(sql = authoritySql) {
  const body =
    /CREATE FUNCTION morrow_work\.listings_grant_set\([^)]*\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
      sql,
    )?.[1];
  assert.ok(body, "listings_grant_set body");
  const row =
    /jsonb_build_object\('capabilityId','([a-z._]+)','verbs','(\[[^\]]*\])'::jsonb,'scope',morrow_work\.listings_scope\(p_org,p_ws,p_store,p_connection\)\)/g;
  const rows = [...body.matchAll(row)].map((m) => ({
    capabilityId: m[1],
    verbs: JSON.parse(m[2]),
    fields: [...listingFieldPaths],
  }));
  // None is missed, however it is spelled: with each row read above replaced by one token
  // and whitespace removed, the body is exactly one jsonb_build_array of those rows, so any
  // other element or text in it fails here.
  assert.equal(
    body.replace(row, "ROW").replace(/\s+/g, ""),
    `SELECTjsonb_build_array(${rows.map(() => "ROW").join(",")})`,
    "listings_grant_set is one jsonb_build_array of readable grants",
  );
  return rows;
}
// The lab's G3 count over a grant set: the grants inside the template (a row of the same
// capability whose verbs and fields contain the grant's, carrying delegate) and all of
// them. Equal only when no grant falls outside the template.
const insideTemplate = (set, rows) => ({
  inside: set.filter((g) => {
    const r = rows.find((t) => t.capabilityId === g.capabilityId);
    return (
      r !== undefined &&
      g.verbs.every((v) => r.verbs.includes(v)) &&
      r.verbs.includes("delegate") &&
      g.fields.every((f) => r.fields.includes(f))
    );
  }).length,
  total: set.length,
});

test("the installation and the enable request stay inside M2's store-link template", () => {
  const sqlRows = sqlStoreLinkTemplate();
  assert.equal(sqlRows.length, 4);
  // Every grant of the grant set, counted: the SQL set is the TypeScript one, and the
  // template-matched count equals its length against both templates.
  const sqlSet = sqlListingsGrantSet();
  const tsSet = listingsGrantSet.map((g) => ({
    capabilityId: g.capabilityId,
    verbs: [...g.verbs],
    fields: [...listingsScope(store()).fields],
  }));
  assert.deepEqual(sqlSet, tsSet);
  for (const rows of [storeLinkGrantTemplate, sqlRows])
    for (const set of [tsSet, sqlSet])
      assert.deepEqual(insideTemplate(set, rows), { inside: 3, total: 3 });
  // Negative controls: one more grant outside the template (a capability with no row; a
  // verb or a field its row lacks; the activate row, which carries no delegate) is counted
  // in the total only.
  for (const extra of [
    { capabilityId: "governance.model_default.revise", verbs: ["execute"], fields: ["model"] },
    { capabilityId: "catalog.content.propose", verbs: ["approve"], fields: [...listingFieldPaths] },
    { capabilityId: "catalog.products.read", verbs: ["view"], fields: ["vendor"] },
    {
      capabilityId: "agents.installation.activate",
      verbs: ["execute"],
      fields: ["evaluation", "grant", "installationId", "revision"],
    },
  ])
    for (const rows of [storeLinkGrantTemplate, sqlRows])
      assert.deepEqual(
        insideTemplate([...sqlSet, extra], rows),
        { inside: 3, total: 4 },
        extra.capabilityId,
      );
  // And at the source: a body with one more grant outside the template parses to four
  // grants, three inside, so the equality above would fail; one the parser cannot read
  // fails the parser.
  const widened = authoritySql.replace(
    "jsonb_build_object('capabilityId','catalog.products.read'",
    "jsonb_build_object('capabilityId','governance.model_default.revise','verbs','[\"execute\"]'::jsonb,'scope',morrow_work.listings_scope(p_org,p_ws,p_store,p_connection)),\n  jsonb_build_object('capabilityId','catalog.products.read'",
  );
  assert.notEqual(widened, authoritySql);
  assert.deepEqual(insideTemplate(sqlListingsGrantSet(widened), sqlRows), { inside: 3, total: 4 });
  const unreadable = authoritySql.replace(
    "jsonb_build_object('capabilityId','catalog.products.read'",
    "jsonb_build_object('capabilityId','governance.model_default.revise','verbs','[\"execute\"]'::jsonb,'scope','{}'::jsonb),\n  jsonb_build_object('capabilityId','catalog.products.read'",
  );
  assert.throws(() => sqlListingsGrantSet(unreadable), assert.AssertionError);
  // Nor one spelled without the 'capabilityId' token: a jsonb literal element, or a grant
  // appended to the array.
  for (const [from, to] of [
    [
      "jsonb_build_object('capabilityId','catalog.products.read'",
      `'{"capabilityId":"governance.model_default.revise","verbs":["execute"]}'::jsonb,\n  jsonb_build_object('capabilityId','catalog.products.read'`,
    ],
    [
      "listings_scope(p_org,p_ws,p_store,p_connection)))\n$$",
      `listings_scope(p_org,p_ws,p_store,p_connection)))||jsonb_build_array(morrow_work.listings_scope(p_org,p_ws,p_store,p_connection))\n$$`,
    ],
  ]) {
    const planted = authoritySql.replace(from, to);
    assert.notEqual(planted, authoritySql, from);
    assert.throws(() => sqlListingsGrantSet(planted), assert.AssertionError);
  }
  const scope = listingsScope(store());
  for (const rows of [storeLinkGrantTemplate, sqlRows]) {
    const row = (id) => rows.find((r) => r.capabilityId === id);
    // Enable and resume: agents.installation.activate {execute} with the request's fields.
    const activate = row("agents.installation.activate");
    assert.ok(activate?.verbs.includes("execute"));
    for (const field of enableRequestFields) assert.ok(activate.fields.includes(field), field);
    // Each grant the installation receives: its verbs, delegate (the owner delegates what
    // the installation receives) and every field of the installation's scope.
    for (const g of listingsGrantSet) {
      const r = row(g.capabilityId);
      assert.ok(r, g.capabilityId);
      for (const verb of [...g.verbs, "delegate"])
        assert.ok(r.verbs.includes(verb), g.capabilityId + " " + verb);
      for (const field of scope.fields)
        assert.ok(r.fields.includes(field), g.capabilityId + " " + field);
    }
    // The owner's disable grant is not the template's: morrow.agents issues it at enable.
    assert.equal(row("agents.installation.disable"), undefined);
  }
  // The SQL grant set and scope fields are the TypeScript ones (pinned above), so the
  // definers' derivation (listings_grant_set, listing_fields) stays inside too.
  assert.ok(authoritySql.includes(`SELECT '${JSON.stringify([...listingFieldPaths])}'::jsonb`));
  assert.deepEqual([...disableFields], ["control", "installationId"]);
});

test("only the founding principal holds agents.installation.activate: M3 never issues it", () => {
  // M3's grants are the installation's three and the owner's disable grant.
  const grants = installationGrants({
    store: store(),
    installationId: I,
    agentPrincipalId: "agent_" + randomUUID(),
    issuer: owner,
    validFrom: "2026-10-20T12:00:00.000Z",
    policyRevision: 1,
    ids: ["g1", "g2", "g3"],
  });
  assert.ok(grants.every((g) => g.capabilityId.startsWith("catalog.")));
  const disable = ownerDisableGrant({
    store: store(),
    installationId: I,
    owner,
    validFrom: "2026-10-20T12:00:00.000Z",
    policyRevision: 1,
    id: "g4",
  });
  assert.equal(disable.capabilityId, "agents.installation.disable");
  // No migration's code names agents.installation.activate except M2's template rows (its
  // version 1, and version 2 with the disconnect backfill's match on version 1's activate
  // row) and the review-capability row (0018); M3's migrations name it in comments only.
  const named = manifest.migrations
    .filter((m) =>
      code(readFileSync("migrations/" + m.file, "utf8")).includes("agents.installation.activate"),
    )
    .map((m) => m.file.replace(/^[0-9]+\./, ""));
  assert.deepEqual(named, [
    "approval-records.sql",
    "shopify-install-identity.sql",
    "disconnect-store-identity.sql",
  ]);
  // The template is issued only by link_workspace_store, only when applied, and only to the
  // founding principal: any other actor is actor_ineligible. Version 1: CREATE, REVOKE and
  // 0026's link, one use in v1 PR 1's replacement (which keeps every other check), and the
  // disconnect migration's prerequisite check; version 2: the identity migration's
  // prerequisite check, CREATE, REVOKE and the one link that replaces v1 PR 1's, and the
  // work migration's prerequisite check.
  const uses = (pattern) =>
    manifest.migrations.flatMap((m) =>
      [...code(readFileSync("migrations/" + m.file, "utf8")).matchAll(pattern)].map(() =>
        m.file.replace(/^[0-9]+\./, ""),
      ),
    );
  assert.deepEqual(uses(/store_link_grants_v1\(\)/g), [
    "shopify-install-identity.sql",
    "shopify-install-identity.sql",
    "shopify-install-identity.sql",
    "shopify-live-store-identity.sql",
    "disconnect-store-identity.sql",
  ]);
  assert.deepEqual(uses(/store_link_grants_v2\(\)/g), [
    "disconnect-store-identity.sql",
    "disconnect-store-identity.sql",
    "disconnect-store-identity.sql",
    "disconnect-store-identity.sql",
    "disconnect-store-work.sql",
  ]);
  // Version 2's only issuing use is the link.
  assert.equal(
    code(migration("disconnect-store-identity")).split(
      "FROM morrow_identity.store_link_grants_v2() x",
    ).length,
    2,
  );
  const linkOf = (sql) =>
    /CREATE OR REPLACE FUNCTION morrow_identity\.link_workspace_store\([\s\S]*?END \$\$;/.exec(
      code(sql),
    )?.[0];
  const liveSql = migration("shopify-live-store-identity");
  for (const sql of [shopifySql, liveSql]) {
    const link = linkOf(sql);
    assert.ok(link, "link_workspace_store");
    assert.ok(link.includes("FROM morrow_identity.store_link_grants_v1() x"));
    assert.ok(
      link.includes(
        "owner_ok:=c.proof_kind<>'shopify_oauth' OR EXISTS(SELECT 1 FROM morrow_identity.organization_signups s\n   WHERE s.organization_id=h.organization_id AND s.principal_id=h.actor_principal_id);",
      ),
    );
    assert.ok(link.includes("WHEN NOT actor_ok OR owner_ok IS NOT TRUE THEN 'actor_ineligible'"));
    assert.ok(
      link.indexOf("IF reason_code='applied' THEN") <
        link.indexOf("INSERT INTO morrow_identity.grants"),
    );
  }
  // The current definition is v1 PR 1's with exactly the template version changed.
  const linkV2 = linkOf(migration("disconnect-store-identity"));
  assert.ok(linkV2, "link_workspace_store v2");
  assert.equal(
    linkV2,
    linkOf(liveSql).replace("store_link_grants_v1() x", "store_link_grants_v2() x"),
  );
});

test("enable needs activate on the store and every verb the installation receives", async () => {
  assert.equal(await enableAllowed(authority(), store()), true);
  // No activate grant; activate on another store; activate without the request's fields.
  assert.equal(
    await enableAllowed(authority(ownerGrants(owner, { activate: false })), store()),
    false,
  );
  assert.equal(await enableAllowed(authority(), storeResource(O, W, "store_b", C)), false);
  assert.equal(await enableAllowed(authority(), storeResource(O, W, S, "connection_b")), false);
  const narrow = ownerGrants().map((g) =>
    g.capabilityId === "agents.installation.activate"
      ? { ...g, scope: { ...g.scope, fields: ["installationId"] } }
      : g,
  );
  assert.equal(await enableAllowed(authority(narrow), store()), false);
  // An installation never exceeds its owner: each catalogue verb it receives is required.
  for (const [capabilityId, verb] of [
    ["catalog.products.read", "view"],
    ["catalog.content.propose", "execute"],
    ["catalog.content.publish", "propose"],
  ]) {
    const without = ownerGrants().map((g) =>
      g.capabilityId === capabilityId ? { ...g, verbs: g.verbs.filter((v) => v !== verb) } : g,
    );
    assert.equal(await enableAllowed(authority(without), store()), false, capabilityId);
    const fields = ownerGrants().map((g) =>
      g.capabilityId === capabilityId ? { ...g, scope: { ...g.scope, fields: ["title"] } } : g,
    );
    assert.equal(await enableAllowed(authority(fields), store()), false, capabilityId + " fields");
  }
  // A revoked or expired activate grant, or one from a later policy revision.
  for (const change of [
    { revokedAt: "2026-10-19T00:00:00.000Z" },
    { expiresAt: "2026-10-20T11:59:59.999Z" },
    { policyRevision: 2 },
    { validFrom: "2026-10-20T12:00:00.001Z" },
  ]) {
    const grants = ownerGrants().map((g) =>
      g.capabilityId === "agents.installation.activate" ? { ...g, ...change } : g,
    );
    assert.equal(await enableAllowed(authority(grants), store()), false, JSON.stringify(change));
  }
  // A member without the store-link grants cannot enable.
  assert.equal(
    await enableAllowed(authority(ownerGrants(member, { activate: false }), member), store()),
    false,
  );
});

test("Stop AI work needs disable on the installation; the model default needs revise", async () => {
  const target = installationResource(store(), I);
  assert.equal(await stopAllowed(authority(), target), true);
  assert.equal(await stopAllowed(authority(ownerGrants(owner, { disable: false })), target), false);
  assert.equal(
    await stopAllowed(authority(), installationResource(store(), "installation_b")),
    false,
  );
  // activate confers no stop; a stop on the store resource is not the installation's.
  assert.equal(await stopAllowed(authority(), store()), false);
  assert.equal(await reviseAllowed(authority()), true);
  assert.equal(await reviseAllowed(authority(ownerGrants(owner, { revise: false }))), false);
  const narrow = ownerGrants().map((g) =>
    g.capabilityId === "governance.model_default.revise"
      ? { ...g, scope: { ...g.scope, fields: ["model", "effort"] } }
      : g,
  );
  assert.equal(await reviseAllowed(authority(narrow)), false);
});

test("request digests and closed bodies", async () => {
  const body = { control: { reason: "Pause please", sourceProposalRef: null } };
  const digest = await agentRequestDigest("installation.stop", W, [S], body);
  assert.equal(
    digest,
    sha(
      '["morrow.work.command",1,"installation.stop","ws_w",["store_a"],{"control":{"reason":"Pause please","sourceProposalRef":null}}]',
    ),
  );
  for (const other of [
    agentRequestDigest("installation.enable", W, [S], body),
    agentRequestDigest("installation.stop", "ws_x", [S], body),
    agentRequestDigest("installation.stop", W, ["store_b"], body),
    agentRequestDigest("installation.stop", W, [S], { control: { ...body.control, reason: "x" } }),
  ])
    assert.notEqual(await other, digest);
  assert.deepEqual(parseDocumentBody({}), {});
  for (const bad of [null, [], { x: 1 }, Object.create({ a: 1 })])
    assert.equal(parseDocumentBody(bad), null);
  const hex = "a".repeat(64);
  assert.deepEqual(parseEnableBody({ documentDigest: hex, nonce: hex }), {
    documentDigest: hex,
    nonce: hex,
  });
  for (const bad of [
    { documentDigest: hex },
    { documentDigest: hex, nonce: "A".repeat(64) },
    { documentDigest: hex, nonce: hex, storeId: S },
    { documentDigest: "a".repeat(63), nonce: hex },
  ])
    assert.equal(parseEnableBody(bad), null, JSON.stringify(bad));
  assert.deepEqual(parseStopBody(body), body);
  for (const bad of [
    { control: { reason: "   ", sourceProposalRef: null } },
    { control: { reason: "", sourceProposalRef: null } },
    { control: { reason: "x".repeat(1025), sourceProposalRef: null } },
    { control: { reason: "Pause" } },
    { control: { reason: "Pause", sourceProposalRef: null }, installationId: I },
  ])
    assert.equal(parseStopBody(bad), null, JSON.stringify(bad));
  const revise = {
    model: "claude_opus_5_5",
    effort: "high",
    maxCreditsPerProduct: 6,
    expectedRevision: null,
  };
  assert.deepEqual(parseModelDefaultBody(revise), revise);
  for (const change of [
    { model: "claude-opus-5-5" },
    { effort: "XHIGH" },
    { maxCreditsPerProduct: 0 },
    { maxCreditsPerProduct: 100 },
    { maxCreditsPerProduct: 1.5 },
    { expectedRevision: 0 },
    { catalogueVersion: 1 },
  ])
    assert.equal(parseModelDefaultBody({ ...revise, ...change }), null, JSON.stringify(change));
});

// ---------------------------------------------------------------------------
// The commands against a scripted transaction: every statement is recorded, each reply
// comes from the script, and nothing else runs.
const sessionDigest = "d".repeat(64);
function contextRow(grants, who = owner) {
  return {
    principal_id: who.principalId,
    organization_id: O,
    workspace_id: W,
    membership_id: who.membershipId,
    policy_revision: "1",
    grants: JSON.stringify(grants),
    grant_count: String(grants.length),
    grants_digest: "e".repeat(64),
    database_now_us: String(nowMs * 1000),
  };
}
const installationRow = (status = "active", change = {}) => ({
  id: I,
  revision: "1",
  store_id: S,
  connection_id: C,
  agent_principal_id: "agent_" + "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12),
  owner_principal_id: owner.principalId,
  owner_membership_id: owner.membershipId,
  status,
  release_id: "morrow.listings",
  release_revision: "1",
  release_digest: sha(listingsReleaseManifest),
  scope: JSON.stringify(listingsScope(storeResource(O, W, S, change.connection_id ?? C))),
  updated_at: "2026-10-20T11:00:00.000Z",
  ...change,
});
// A person's own "Stop AI work" (its KillSwitchRecord), the only stop a resume lifts.
const ownStop = (change = {}) => ({
  id: "stop_1",
  set_by_kind: "human",
  reason_code: "human_stop_ai_work",
  kill_switch_record_id: "r1",
  created_at: "x",
  ...change,
});
const reviewContextRow = {
  policy_revision: "1",
  policy_canonical: "{}",
  policy_digest: "f".repeat(64),
  defaults_digest: "f".repeat(64),
  capability_effect: "control",
  capability_irreversible: "false",
  capability_review_required: "false",
  capability_kill_switch: "true",
  risk: "medium",
  owner_principal_id: owner.principalId,
  owner_membership_id: owner.membershipId,
  active_human_membership_count: "1",
  last_membership_change_at: null,
  claimed_approval_id: null,
  database_now: "2026-10-20T12:00:00.000Z",
};
function scriptedTx(replies) {
  const sent = [];
  const tx = {
    submitted: false,
    rolledBack: false,
    sent,
    async run(name, values) {
      assert.ok(Object.hasOwn(workStatements, name), name);
      sent.push([name, [...values]]);
      const reply = replies[name];
      return typeof reply === "function" ? reply(values) : (reply ?? []);
    },
    markSubmitted() {
      tx.submitted = true;
    },
    rollbackOnly() {
      tx.rolledBack = true;
    },
  };
  return tx;
}
const guarded = (method, pattern, body, params = { storeId: S }) => ({
  route: { method, pattern, query: [] },
  workspaceId: W,
  params,
  query: new Map(),
  sessionDigest,
  commandId: method === "GET" ? null : randomUUID(),
  body,
});
const names = (tx) => tx.sent.map(([name]) => name);
const billing = /billing|credit|wallet|entitlement|reservation|unrecovered/i;
const applied = (result) => [{ outcome: "applied", result: JSON.stringify(result) }];

test("Stop AI work: kernel, kill-switch target check, then the record commits with the stop", async () => {
  const body = { control: { reason: "Pause the agent", sourceProposalRef: null } };
  const g = guarded("POST", "/stores/:storeId/agents/listings/stop", body);
  const prepared = await prepareAgentCommand("installation.stop", g);
  const tx = scriptedTx({
    enterContext: [contextRow(ownerGrants())],
    beginAgentCommand: [{ outcome: "new", aggregate_type: null, aggregate_id: null, result: null }],
    listingsInstallation: [installationRow()],
    reviewContext: [reviewContextRow],
    installationStop: [],
    cmdStopAiWork: (values) =>
      applied({ status: "disabled", killSwitchRecordId: JSON.parse(values[5]).id }),
  });
  const result = await runAgentCommand(tx, g, prepared, "corr_1");
  assert.equal(result.status, 200);
  assert.deepEqual(names(tx), [
    "enterContext",
    "beginAgentCommand",
    "listingsInstallation",
    "reviewContext",
    "installationStop",
    "cmdStopAiWork",
  ]);
  // No billing, credit or entitlement statement is ever sent (ADR-0011 Q8).
  for (const [name] of tx.sent) {
    assert.doesNotMatch(name, billing);
    assert.doesNotMatch(workStatements[name], billing, name);
  }
  const [, values] = tx.sent.at(-1);
  assert.deepEqual(values.slice(0, 5), [g.commandId, prepared.digest, "corr_1", S, I]);
  const record = JSON.parse(values[5]);
  assert.equal(values[5], canonicalJson(record));
  assert.equal(values[6], sha(values[5]));
  assert.equal(validateCurrentDefinition("KillSwitchRecord", record), true);
  assert.deepEqual(
    [record.capabilityId, record.actor, record.control, record.commandId, record.requestDigest],
    ["agents.installation.disable", owner, body.control, g.commandId, prepared.digest],
  );
  assert.deepEqual(record.targets, [installationResource(store(), I)]);
  assert.deepEqual(
    [record.priorStateObserved, record.storeId, record.revision, record.createdAt],
    ["active", S, 1, "2026-10-20T12:00:00.000Z"],
  );
  // Already stopped: the record says so, and the definer keeps the existing stop.
  const again = scriptedTx({
    ...{
      enterContext: [contextRow(ownerGrants())],
      beginAgentCommand: [
        { outcome: "new", aggregate_type: null, aggregate_id: null, result: null },
      ],
      listingsInstallation: [installationRow("disabled")],
      reviewContext: [reviewContextRow],
      installationStop: [ownStop()],
      cmdStopAiWork: applied({ status: "disabled" }),
    },
  });
  await runAgentCommand(again, g, prepared, "corr_2");
  assert.equal(JSON.parse(again.sent.at(-1)[1][5]).priorStateObserved, "already_stopped");
});

test("Stop AI work without the disable grant, or with no installation, sends no definer", async () => {
  const body = { control: { reason: "Pause", sourceProposalRef: null } };
  const g = guarded("POST", "/stores/:storeId/agents/listings/stop", body);
  const prepared = await prepareAgentCommand("installation.stop", g);
  for (const [grants, installation, reason] of [
    [ownerGrants(owner, { disable: false }), [installationRow()], "denied"],
    [ownerGrants(), [], "not_found"],
  ]) {
    const tx = scriptedTx({
      enterContext: [contextRow(grants)],
      beginAgentCommand: [
        { outcome: "new", aggregate_type: null, aggregate_id: null, result: null },
      ],
      listingsInstallation: installation,
      reviewContext: [reviewContextRow],
    });
    await assert.rejects(
      runAgentCommand(tx, g, prepared, "corr"),
      (e) => e instanceof WorkReject && e.reason === reason,
    );
    assert.equal(tx.submitted, false);
    assert.equal(names(tx).includes("cmdStopAiWork"), false);
  }
  // A replay returns the recorded result, rolls back and sends nothing else.
  const tx = scriptedTx({
    enterContext: [contextRow(ownerGrants())],
    beginAgentCommand: [
      {
        outcome: "replay",
        aggregate_type: "installation",
        aggregate_id: I,
        result: '{"status":"disabled"}',
      },
    ],
  });
  const replay = await runAgentCommand(tx, g, prepared, "corr");
  assert.deepEqual(replay.body, { status: "disabled", replayed: true });
  assert.equal(tx.rolledBack, true);
  assert.deepEqual(names(tx), ["enterContext", "beginAgentCommand"]);
});

test("Enable step 1 builds the document server-side; only a person's stop resumes", async () => {
  const g = guarded("POST", "/stores/:storeId/agents/listings/document", {});
  const prepared = await prepareAgentCommand("installation.document", g);
  const replies = (installation, stop = []) => ({
    enterContext: [contextRow(ownerGrants())],
    beginAgentCommand: [{ outcome: "new", aggregate_type: null, aggregate_id: null, result: null }],
    storeAssociation: [{ store_id: S, connection_id: C, database_now: "x" }],
    listingsInstallation: installation,
    installationStop: stop,
    cmdListingsEnableDocument: (values) =>
      applied({
        documentId: values[6],
        documentDigest: values[8],
        installationId: values[5],
        purpose: values[4],
        expiresAt: "2026-10-20T12:05:00.000Z",
      }),
  });
  const tx = scriptedTx(replies([]));
  const result = await runAgentCommand(tx, g, prepared, "corr");
  assert.equal(result.status, 201);
  const [, values] = tx.sent.at(-1);
  const document = parseInstallationDocument(values[7]);
  assert.equal(values[8], sha(values[7]));
  assert.equal(values[4], "enable");
  assert.equal(document.purpose, "enable");
  assert.deepEqual(document.store, store());
  // The nonce goes to the owner once; only its digest is stored.
  assert.match(result.body.nonce, /^[a-f0-9]{64}$/);
  assert.equal(values[9], sha(result.body.nonce));
  assert.deepEqual(result.body.document, document);
  // Resume: the owner's own stop (a person's) on a disabled installation.
  const resume = scriptedTx(replies([installationRow("disabled")], [ownStop()]));
  await runAgentCommand(resume, g, prepared, "corr");
  assert.equal(resume.sent.at(-1)[1][4], "resume");
  assert.equal(resume.sent.at(-1)[1][5], I);
  // The resume document is exactly the installation it reactivates: its store resource
  // with the installation's connection, its release digest and its grant set.
  const resumed = parseInstallationDocument(resume.sent.at(-1)[1][7]);
  assert.deepEqual(resumed.store, store());
  assert.deepEqual(resumed.release, {
    id: "morrow.listings",
    revision: 1,
    digest: sha(listingsReleaseManifest),
  });
  for (const g of resumed.grants)
    assert.deepEqual(g.scope, JSON.parse(installationRow("disabled").scope));
  // The ADR-0022 item 3 amendment: an installation that differs from the document the
  // owner would confirm is refused, with no definer: pinned to another connection of the
  // store, to another release or release digest, or with another scope.
  const old = "connection_old";
  for (const change of [
    {
      connection_id: old,
      scope: JSON.stringify(listingsScope(storeResource(O, W, S, old))),
    },
    { connection_id: old },
    { release_revision: "2" },
    { release_digest: "f".repeat(64) },
    { release_id: "morrow.other" },
    { scope: JSON.stringify(listingsScope(storeResource(O, W, S, old))) },
  ]) {
    const differs = scriptedTx(replies([installationRow("disabled", change)], [ownStop()]));
    await assert.rejects(
      runAgentCommand(differs, g, prepared, "corr"),
      (e) => e instanceof WorkReject && e.reason === "state_conflict",
      JSON.stringify(change),
    );
    assert.equal(differs.submitted, false, JSON.stringify(change));
  }
  // An active installation, or a disabled one with no stop or a system or operator stop
  // (those lift only through their own paths), is a state conflict with no definer.
  for (const [installation, stop] of [
    [[installationRow("active")], []],
    [[installationRow("disabled")], []],
    [
      [installationRow("disabled")],
      [
        ownStop({
          set_by_kind: "system",
          reason_code: "app_uninstalled",
          kill_switch_record_id: null,
        }),
      ],
    ],
    [
      [installationRow("disabled")],
      [ownStop({ set_by_kind: "operator", reason_code: "lab_stop", kill_switch_record_id: null })],
    ],
    // A person's stop that is not "Stop AI work" with its record does not resume this way.
    [[installationRow("disabled")], [ownStop({ reason_code: "human_other" })]],
    [[installationRow("disabled")], [ownStop({ kill_switch_record_id: null })]],
  ]) {
    const conflict = scriptedTx(replies(installation, stop));
    await assert.rejects(
      runAgentCommand(conflict, g, prepared, "corr"),
      (e) => e instanceof WorkReject && e.reason === "state_conflict",
    );
    assert.equal(conflict.submitted, false);
  }
  // No current association: not found. No activate grant: denied. Neither sends a definer.
  const unlinked = scriptedTx({ ...replies([]), storeAssociation: [] });
  await assert.rejects(
    runAgentCommand(unlinked, g, prepared, "corr"),
    (e) => e.reason === "not_found",
  );
  const denied = scriptedTx({
    ...replies([]),
    enterContext: [contextRow(ownerGrants(owner, { activate: false }))],
  });
  await assert.rejects(runAgentCommand(denied, g, prepared, "corr"), (e) => e.reason === "denied");
  for (const t of [unlinked, denied]) assert.equal(t.submitted, false);
});

test("Enable step 2 reruns the kernel and sends grants the definer checks against the document", async () => {
  const built = await buildInstallationDocument({
    id: randomUUID(),
    purpose: "enable",
    store: store(),
    installationId: I,
    actor: owner,
    createdAtMs: nowMs,
  });
  const nonce = "c".repeat(64);
  const g = guarded("POST", "/stores/:storeId/agents/listings", {
    documentDigest: built.digest,
    nonce,
  });
  const prepared = await prepareAgentCommand("installation.enable", g);
  const replies = (grants, canonical = built.canonical) => ({
    enterContext: [contextRow(grants)],
    beginAgentCommand: [{ outcome: "new", aggregate_type: null, aggregate_id: null, result: null }],
    storeAssociation: [{ store_id: S, connection_id: C, database_now: "x" }],
    agentEnableDocument: [
      {
        id: built.document.id,
        purpose: "enable",
        store_id: S,
        connection_id: C,
        installation_id: I,
        canonical,
        expires_at: built.document.expiresAt,
        consumed: "false",
      },
    ],
    cmdListingsEnable: applied({ installationId: I, revision: 1, status: "active" }),
  });
  const tx = scriptedTx(replies(ownerGrants()));
  const result = await runAgentCommand(tx, g, prepared, "corr");
  assert.equal(result.status, 200);
  const [name, values] = tx.sent.at(-1);
  assert.equal(name, "cmdListingsEnable");
  assert.deepEqual(values.slice(3, 6), [S, built.digest, nonce]);
  assert.match(values[6], /^agent_[a-f0-9-]{36}$/);
  assert.match(values[7], /^agent_[a-f0-9-]{36}$/);
  assert.notEqual(values[6], values[7]);
  const texts = JSON.parse(values[8]);
  assert.equal(texts.length, 3);
  for (const [i, text] of texts.entries()) {
    const payload = JSON.parse(text);
    assert.equal(text, canonicalJson(payload));
    assert.equal(validateCurrentDefinition("Grant", payload), true);
    assert.deepEqual(
      { capabilityId: payload.capabilityId, verbs: payload.verbs, scope: payload.scope },
      JSON.parse(JSON.stringify(built.document.grants[i])),
    );
    assert.equal(payload.principal.principalId, values[6]);
    assert.equal(payload.principal.installationId, I);
    assert.deepEqual(payload.issuedBy, owner);
    assert.equal(payload.validFrom, "2026-10-20T12:00:00.000Z");
  }
  const ownerGrant = JSON.parse(values[9]);
  assert.deepEqual(ownerGrant.scope, built.document.ownerGrant.scope);
  assert.deepEqual(ownerGrant.principal, owner);
  // Authority lost between the document and the confirmation: denied before any definer.
  for (const grants of [
    ownerGrants(owner, { activate: false }),
    ownerGrants().filter((x) => x.capabilityId !== "catalog.content.publish"),
  ]) {
    const lost = scriptedTx(replies(grants));
    await assert.rejects(runAgentCommand(lost, g, prepared, "corr"), (e) => e.reason === "denied");
    assert.equal(lost.submitted, false);
    assert.equal(names(lost).includes("agentEnableDocument"), false);
  }
  // A stored document of another store is not this request's.
  const other = await buildInstallationDocument({
    id: randomUUID(),
    purpose: "enable",
    store: storeResource(O, W, "store_b", C),
    installationId: I,
    actor: owner,
    createdAtMs: nowMs,
  });
  const foreign = scriptedTx(replies(ownerGrants(), other.canonical));
  await assert.rejects(
    runAgentCommand(foreign, g, prepared, "corr"),
    (e) => e.reason === "not_found",
  );
  assert.equal(foreign.submitted, false);
  // A resume confirmation sends no grants and no principals.
  const resumeDoc = await buildInstallationDocument({
    id: randomUUID(),
    purpose: "resume",
    store: store(),
    installationId: I,
    actor: owner,
    createdAtMs: nowMs,
  });
  const resumeReplies = (installation) => ({
    ...replies(ownerGrants(), resumeDoc.canonical),
    listingsInstallation: installation,
  });
  const resume = scriptedTx(resumeReplies([installationRow("disabled")]));
  await runAgentCommand(resume, g, prepared, "corr");
  assert.deepEqual(resume.sent.at(-1)[1].slice(6), [null, null, null, null]);
  assert.ok(names(resume).includes("listingsInstallation"));
  // At confirmation too: the installation must still be the document (disabled, on the
  // document's connection and release, with its scope), or no definer is sent.
  for (const installation of [
    [],
    [installationRow("active")],
    [installationRow("disabled", { connection_id: "connection_old" })],
    [installationRow("disabled", { release_digest: "f".repeat(64) })],
    [installationRow("disabled", { id: "installation_other" })],
  ]) {
    const differs = scriptedTx(resumeReplies(installation));
    await assert.rejects(
      runAgentCommand(differs, g, prepared, "corr"),
      (e) => e instanceof WorkReject && e.reason === "state_conflict",
      JSON.stringify(installation),
    );
    assert.equal(differs.submitted, false);
  }
  // A refusal from the definer is the mapped rejection, after a rollback.
  for (const [outcome, reason] of [
    ["guard_failed", "guard_failed"],
    ["stopped", "state_conflict"],
    ["state_conflict", "state_conflict"],
    ["stale_authority", "stale_authority"],
    ["something_else", "unavailable"],
  ]) {
    const refused = scriptedTx({
      ...replies(ownerGrants()),
      cmdListingsEnable: [{ outcome, result: null }],
    });
    await assert.rejects(runAgentCommand(refused, g, prepared, "corr"), (e) => e.reason === reason);
    assert.equal(refused.rolledBack, true);
  }
});

test("the model default: revise only, keys of the active catalogue, a ceiling that admits it", async () => {
  const body = {
    model: "claude_opus_5_5",
    effort: "high",
    maxCreditsPerProduct: 6,
    expectedRevision: null,
  };
  const g = guarded("PUT", "/settings/model-default", body, {});
  const prepared = await prepareAgentCommand("model_default.revise", g);
  const replies = (grants) => ({
    enterContext: [contextRow(grants)],
    beginAgentCommand: [{ outcome: "new", aggregate_type: null, aggregate_id: null, result: null }],
    cmdModelDefaultRevise: applied({
      revision: 1,
      model: "claude_opus_5_5",
      effort: "high",
      maxCreditsPerProduct: 6,
    }),
  });
  const tx = scriptedTx(replies(ownerGrants()));
  const result = await runAgentCommand(tx, g, prepared, "corr");
  // The body is the definer's recorded result, so a replay returns the same body.
  assert.deepEqual(result.body, {
    revision: 1,
    model: "claude_opus_5_5",
    effort: "high",
    maxCreditsPerProduct: 6,
  });
  // The active catalogue version (3 since ADR-0036).
  assert.deepEqual(tx.sent.at(-1)[1].slice(3), ["3", "claude_opus_5_5", "high", "6", null]);
  // A member without governance.model_default.revise is denied before the definer.
  const member = scriptedTx(replies(ownerGrants(owner, { revise: false })));
  await assert.rejects(runAgentCommand(member, g, prepared, "corr"), (e) => e.reason === "denied");
  assert.equal(member.submitted, false);
  // A ceiling below the default's credits, an unknown key or a retired model is invalid.
  for (const change of [
    { maxCreditsPerProduct: 5 },
    { model: "claude_opus_9" },
    { effort: "xhigh" },
  ]) {
    const bad = { ...body, ...change };
    const gb = guarded("PUT", "/settings/model-default", bad, {});
    const tb = scriptedTx(replies(ownerGrants()));
    await assert.rejects(
      runAgentCommand(tb, gb, await prepareAgentCommand("model_default.revise", gb), "corr"),
      (e) => e.reason === "invalid",
      JSON.stringify(change),
    );
    assert.equal(tb.submitted, false);
  }
  // A body that fails the contract never reaches a transaction.
  await assert.rejects(
    prepareAgentCommand(
      "model_default.revise",
      guarded("PUT", "/settings/model-default", { ...body, model: "claude-opus-5-5" }, {}),
    ),
    (e) => e instanceof WorkReject && e.reason === "invalid",
  );
});

test("the Listings status: blocked by a platform or connection stop; resume only when it matches", async () => {
  const read = async (replies) => {
    const tx = scriptedTx({
      enterContext: [contextRow(ownerGrants())],
      storeAssociation: [{ store_id: S, connection_id: C, database_now: "x" }],
      ...replies,
    });
    const body = (
      await runAgentRead(
        tx,
        guarded("GET", "/stores/:storeId/agents/listings", null),
        "listings.status",
      )
    ).body;
    return { body, tx };
  };
  const active = await read({ listingsInstallation: [installationRow()] });
  assert.equal(active.body.blocked, false);
  assert.deepEqual(
    active.tx.sent.find(([name]) => name === "storeStops"),
    ["storeStops", [C]],
  );
  // An open platform or connection stop: blocked, although the installation is active.
  const blocked = await read({
    listingsInstallation: [installationRow()],
    storeStops: [{ scope: "platform" }],
  });
  assert.equal(blocked.body.blocked, true);
  assert.equal(blocked.body.installation.status, "active");
  // Resume is offered after the owner's own stop only when the installation is the store's
  // current connection on the current release.
  const stopped = await read({
    listingsInstallation: [installationRow("disabled")],
    installationStop: [ownStop()],
  });
  assert.equal(stopped.body.actions.resume, true);
  for (const change of [{ connection_id: "connection_old" }, { release_digest: "f".repeat(64) }]) {
    const differs = await read({
      listingsInstallation: [installationRow("disabled", change)],
      installationStop: [ownStop()],
    });
    assert.equal(differs.body.actions.resume, false, JSON.stringify(change));
  }
  // An installation whose store is no longer linked still reads, with linked false.
  const unlinked = await read({
    storeAssociation: [],
    listingsInstallation: [installationRow("disabled")],
    installationStop: [ownStop()],
  });
  assert.equal(unlinked.body.linked, false);
  assert.equal(unlinked.body.actions.resume, false);
});

test("GET /models: the active catalogue, the member ceiling, no provider strings", async () => {
  const read = async (grants, row = []) => {
    const tx = scriptedTx({ enterContext: [contextRow(grants)], workspaceModelDefault: row });
    return (await runAgentRead(tx, guarded("GET", "/models", null, {}), "models.list")).body;
  };
  const memberView = await read(ownerGrants(owner, { revise: false }));
  // Catalogue version 3 (ADR-0036): Opus 5.5 at medium by default, the default ceiling 4.
  assert.equal(memberView.catalogueVersion, 3);
  assert.equal(memberView.ceiling, 4);
  assert.equal(memberView.canRevise, false);
  assert.deepEqual(memberView.workspaceDefault, { model: "claude_opus_5_5", effort: "medium" });
  const allowed = memberView.entries
    .filter((e) => e.allowedForMember)
    .map((e) => e.creditsPerProduct);
  assert.ok(allowed.includes(4) && allowed.every((c) => c <= 4));
  // A default stored at version 1 that version 3 also lists is kept, with its ceiling.
  const stored = await read(ownerGrants(owner, { revise: false }), [
    {
      catalogue_version: "1",
      model_key: "claude_sonnet_5_5",
      effort_key: "low",
      max_credits_per_product: "1",
      revision: "1",
      updated_at: "2026-10-20T11:00:00.000Z",
    },
  ]);
  assert.deepEqual(stored.workspaceDefault, { model: "claude_sonnet_5_5", effort: "low" });
  assert.equal(stored.ceiling, 1);
  const text = JSON.stringify(memberView);
  assert.doesNotMatch(text, /claude-|anthropic|usd|price|cost|token/i);
  // The owner may pick every entry; after the ceiling is raised to 6 so may the member.
  const ownerView = await read(ownerGrants());
  assert.ok(ownerView.entries.every((e) => e.allowedForMember));
  const raised = await read(ownerGrants(owner, { revise: false }), [
    {
      catalogue_version: "1",
      model_key: "claude_opus_5_5",
      effort_key: "high",
      max_credits_per_product: "6",
      revision: "2",
      updated_at: "2026-10-20T11:00:00.000Z",
    },
  ]);
  assert.equal(raised.ceiling, 6);
  assert.equal(raised.revision, 2);
  assert.deepEqual(raised.workspaceDefault, { model: "claude_opus_5_5", effort: "high" });
  assert.ok(raised.entries.every((e) => e.allowedForMember));
});

test("every agents statement is fixed, parameterised text in workStatements", () => {
  for (const [name, text] of Object.entries(agentStatements)) {
    assert.equal(workStatements[name], text, name);
    assert.doesNotMatch(
      text,
      /SET (LOCAL )?ROLE|set_config|\bINSERT\b|\bUPDATE\b|\bDELETE\b/,
      name,
    );
    assert.match(text, /^SELECT /, name);
  }
});
