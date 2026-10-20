// M2 PR-2 (P09.T02a): the identity half of the link over a faked linking pool: the request
// guard's GET /workspace/:ws/connections route, the issuer's outcome mapping in the
// store-link preview, the connections read and its install-link offer, and the policy
// package's connection kernel. The SQL itself runs in lab:shopify-install.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createStandaloneRequestGuard } from "../packages/identity/src/standalone-request-guard.ts";
import { createStandaloneStoreLinkingExecution } from "../packages/identity/src/standalone-store-linking.ts";
import {
  executeWorkspaceConnections,
  runShopifyLinkIssuer,
} from "../packages/identity/src/shopify-link-issuer.ts";
import { workspaceStoreLinkingControlSql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { controlledNeonWorkspaceProfiles } from "../packages/identity/src/controlled-neon-workspace-profiles.ts";
import {
  connectRequestFields,
  createConnectionKernel,
} from "../packages/policy/src/connection-authority.ts";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const origin = "https://workspace.example.test";
const secret = Buffer.alloc(32, 27).toString("base64url");
const handoffToken = Buffer.alloc(32, 31).toString("base64url");
const command = "e519ea9d-c5eb-4613-906c-26a870c0e9e8";
const config = JSON.stringify({ schemaVersion: 1, mode: "https", origin });
const ws = "workspace_a";
const org = "org_a";
const actor = {
  kind: "human",
  principalId: "human_a",
  organizationId: org,
  workspaceId: ws,
  membershipId: "membership_a",
  installationId: null,
  mandateId: null,
};
const workspaceResource = {
  organizationId: org,
  workspaceId: ws,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: ws,
};
const grant = (overrides = {}) => ({
  id: "grant_connect",
  principal: actor,
  capabilityId: "governance.connection.connect",
  verbs: ["administer", "approve"],
  scope: {
    organizationId: org,
    workspaceId: ws,
    storeIds: [],
    accountIds: [],
    resources: [workspaceResource],
    fields: ["providerId", "installationProof", "scope"],
  },
  issuedBy: { ...actor, kind: "service", principalId: "morrow.onboarding", membershipId: null },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
  ...overrides,
});
const facts = (grants) => ({
  principalId: actor.principalId,
  organizationId: org,
  workspaceId: ws,
  membershipId: actor.membershipId,
  policyRevision: 1,
  grants,
  databaseNowMs: Date.parse("2026-10-20T00:00:00.000Z"),
});

test("connection kernel: allows the actor's connect/administer grant and picks it; denies the rest", async () => {
  const kernel = createConnectionKernel();
  assert.deepEqual([...connectRequestFields], ["installationProof", "providerId", "scope"]);
  assert.deepEqual(await kernel(facts([grant()])), { allowed: true, grantId: "grant_connect" });
  // The first matching grant by id.
  assert.deepEqual(await kernel(facts([grant({ id: "grant_z" }), grant({ id: "grant_b" })])), {
    allowed: true,
    grantId: "grant_b",
  });
  for (const [name, grants] of [
    ["none", []],
    ["view only", [grant({ verbs: ["view"] })]],
    ["revoked", [grant({ revokedAt: "2026-02-01T00:00:00.000Z" })]],
    ["expired", [grant({ expiresAt: "2026-02-01T00:00:00.000Z" })]],
    ["not yet valid", [grant({ validFrom: "2027-01-01T00:00:00.000Z" })]],
    ["missing field", [grant({ scope: { ...grant().scope, fields: ["providerId", "scope"] } })]],
    ["another principal", [grant({ principal: { ...actor, principalId: "human_b" } })]],
    ["later policy", [grant({ policyRevision: 2 })]],
    [
      "store scoped",
      [
        grant({
          scope: {
            ...grant().scope,
            storeIds: ["s1"],
            resources: [
              {
                organizationId: org,
                workspaceId: ws,
                storeId: "s1",
                connectionId: "c1",
                kind: "store",
                id: "s1",
              },
            ],
          },
        }),
      ],
    ],
    ["malformed", [{ id: "x" }]],
  ])
    assert.deepEqual(await kernel(facts(grants)), { allowed: false, grantId: null }, name);
});

test("the linking pool admits the three new statements with their arities only", () => {
  const statements = controlledNeonWorkspaceProfiles.linkingPool.statements;
  assert.deepEqual(
    ["authority", "issue", "connections"].map((name) => [
      statements[name].text,
      statements[name].arity,
    ]),
    [
      [workspaceStoreLinkingControlSql.authority, 2],
      [workspaceStoreLinkingControlSql.issue, 5],
      [workspaceStoreLinkingControlSql.connections, 2],
    ],
  );
});

// A faked linking pool: the role row, then fixed answers by statement.
function pool(answers) {
  const sent = [];
  return {
    sent,
    async connect() {
      return {
        async query(text, values) {
          sent.push([text, [...values]]);
          if (text === workspaceStoreLinkingControlSql.role)
            return {
              rows: [
                {
                  role: "morrow_identity_linking",
                  login: "morrow_identity_linking",
                  rolsuper: false,
                  rolbypassrls: false,
                  rolcreatedb: false,
                  rolcreaterole: false,
                  rolinherit: false,
                  owner_member: false,
                  role_member: false,
                  rolreplication: false,
                },
              ],
            };
          if (text in answers) return { rows: answers[text]() };
          return { rows: [] };
        },
        async release() {},
      };
    },
  };
}
const authorityRow = (grants = [grant()]) => [
  {
    principal_id: actor.principalId,
    organization_id: org,
    workspace_id: ws,
    membership_id: actor.membershipId,
    policy_revision: "1",
    grants: JSON.stringify(grants),
    grant_count: grants.length,
    database_now_ms: String(Date.parse("2026-10-20T00:00:00.000Z")),
  },
];
function context(nonceDigest = sha(handoffToken)) {
  const abort = new AbortController();
  return Object.freeze({
    workspaceId: ws,
    sessionDigest: sha(secret),
    commandId: command,
    nonceDigest,
    csrfToken: null,
    control: Object.freeze({ deadlineMs: Date.now() + 30000, signal: abort.signal }),
    check: () => Date.now(),
    wait: (p) => p,
  });
}

test("issuer: kernel denial stops before the write; outcomes map to proceed, 404 or 409", async () => {
  const kernel = createConnectionKernel();
  const denied = pool({ [workspaceStoreLinkingControlSql.authority]: () => authorityRow([]) });
  const noGrant = await runShopifyLinkIssuer(denied, Date.now, kernel, context());
  assert.equal(noGrant.status, 404);
  assert.deepEqual(await noGrant.json(), { code: "linking_not_found" });
  assert.ok(!denied.sent.some(([text]) => text === workspaceStoreLinkingControlSql.issue));
  const ineligible = pool({});
  assert.equal((await runShopifyLinkIssuer(ineligible, Date.now, kernel, context())).status, 404);
  for (const [outcome, expected] of [
    ["issued", "proceed"],
    ["exists", "proceed"],
    ["not_found", "proceed"],
    ["denied", 404],
    ["invalid", 404],
    ["route_not_ready", 409],
  ]) {
    const p = pool({
      [workspaceStoreLinkingControlSql.authority]: () => authorityRow(),
      [workspaceStoreLinkingControlSql.issue]: () => [{ outcome }],
    });
    const verdict = await runShopifyLinkIssuer(p, Date.now, kernel, context());
    if (expected === "proceed") assert.equal(verdict, "proceed", outcome);
    else {
      assert.equal(verdict.status, expected, outcome);
      if (expected === 409)
        assert.deepEqual(await verdict.json(), { code: "billing_route_required" });
    }
    const issue = p.sent.find(([text]) => text === workspaceStoreLinkingControlSql.issue);
    assert.deepEqual(
      issue[1],
      [sha(secret), ws, sha(handoffToken), command, "grant_connect"],
      outcome,
    );
  }
  // An unexpected outcome or a malformed authority row is held (the caller answers 503).
  const garbled = pool({
    [workspaceStoreLinkingControlSql.authority]: () => authorityRow(),
    [workspaceStoreLinkingControlSql.issue]: () => [{ outcome: "linked" }],
  });
  await assert.rejects(() => runShopifyLinkIssuer(garbled, Date.now, kernel, context()));
});

test("preview runs the issuer before the lookup only when a kernel is configured", async () => {
  const p = pool({
    [workspaceStoreLinkingControlSql.authority]: () => authorityRow(),
    [workspaceStoreLinkingControlSql.issue]: () => [{ outcome: "route_not_ready" }],
  });
  const withKernel = createStandaloneStoreLinkingExecution({
    configurationJson: config,
    pool: p,
    now: Date.now,
    connections: createConnectionKernel(),
  });
  const response = await withKernel.execute("preview", context());
  assert.equal(response.status, 409);
  assert.ok(!p.sent.some(([text]) => text === workspaceStoreLinkingControlSql.lookup));
  const legacy = pool({});
  const without = createStandaloneStoreLinkingExecution({
    configurationJson: config,
    pool: legacy,
    now: Date.now,
  });
  assert.equal((await without.execute("preview", context())).status, 404);
  assert.ok(!legacy.sent.some(([text]) => text === workspaceStoreLinkingControlSql.issue));
  assert.ok(legacy.sent.some(([text]) => text === workspaceStoreLinkingControlSql.lookup));
});

const installation = {
  schemaVersion: 1,
  id: "6f7b8c1e-1111-4222-8333-444455556666",
  organizationId: org,
  workspaceId: ws,
  storeId: "7f7b8c1e-1111-4222-8333-444455556666",
  revision: 1,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  shopId: "424242",
  shopDomain: "lab-dev.myshopify.com",
  connectionId: "8f7b8c1e-1111-4222-8333-444455556666",
  status: "unlinked",
  owningWorkspaceId: null,
  grantedScopes: ["read_products", "write_products"],
  providerCredentialVersion: 1,
  providerCredentialRef: "9f7b8c1e-1111-4222-8333-444455556666",
};
const url = "https://admin.shopify.com/oauth/install_custom_app?client_id=abc&signature=x";
const connectionsRow = (overrides = {}) => [
  {
    installations: JSON.stringify([installation]),
    app_registered: true,
    install_url: url,
    route: "morrow_direct",
    linked: false,
    ...overrides,
  },
];
async function read(answers, kernel = createConnectionKernel()) {
  const response = await executeWorkspaceConnections(
    pool(answers),
    Date.now,
    kernel === null ? undefined : kernel,
    context(null),
  );
  return { status: response.status, body: await response.json() };
}

test("connections: any member reads; the link is offered only to a connect holder of a paid, registered, unlinked workspace", async () => {
  const offered = await read({
    [workspaceStoreLinkingControlSql.authority]: () => authorityRow(),
    [workspaceStoreLinkingControlSql.connections]: () => connectionsRow(),
  });
  assert.equal(offered.status, 200);
  assert.deepEqual(offered.body.installLink, { offered: true, url, reason: "offered" });
  assert.deepEqual(offered.body.installations, [installation]);
  for (const [authority, row, reason] of [
    [authorityRow([]), connectionsRow(), "not_permitted"],
    [authorityRow(), connectionsRow({ linked: true }), "linked"],
    [authorityRow([]), connectionsRow({ linked: true }), "linked"],
    [
      authorityRow(),
      connectionsRow({ app_registered: false, install_url: null }),
      "not_registered",
    ],
    [authorityRow(), connectionsRow({ route: "unfixed" }), "route_not_ready"],
    [authorityRow(), connectionsRow({ route: "missing" }), "route_not_ready"],
    [authorityRow(), connectionsRow({ route: "shopify_app_pricing" }), "route_not_ready"],
  ]) {
    const r = await read({
      [workspaceStoreLinkingControlSql.authority]: () => authority,
      [workspaceStoreLinkingControlSql.connections]: () => row,
    });
    assert.deepEqual(r.body.installLink, { offered: false, url: null, reason }, reason);
  }
  // Without a kernel nothing is offered.
  const unconfigured = await read(
    {
      [workspaceStoreLinkingControlSql.authority]: () => authorityRow(),
      [workspaceStoreLinkingControlSql.connections]: () => connectionsRow(),
    },
    null,
  );
  assert.equal(unconfigured.body.installLink.reason, "not_permitted");
  // Not session-eligible: 401. Another tenant's or a malformed installation: 503.
  assert.equal((await read({})).status, 401);
  for (const bad of [
    { ...installation, workspaceId: "workspace_b" },
    { ...installation, providerCredentialVersion: 0 },
    { ...installation, token: "x" },
  ])
    assert.equal(
      (
        await read({
          [workspaceStoreLinkingControlSql.authority]: () => authorityRow(),
          [workspaceStoreLinkingControlSql.connections]: () =>
            connectionsRow({ installations: JSON.stringify([bad]) }),
        })
      ).status,
      503,
    );
  assert.equal(
    (
      await read({
        [workspaceStoreLinkingControlSql.authority]: () => authorityRow(),
        [workspaceStoreLinkingControlSql.connections]: () =>
          connectionsRow({ install_url: "http://evil.test/install" }),
      })
    ).status,
    503,
  );
});

test("guard: GET /workspace/:ws/connections is a bootstrap-style read; anything else is refused", async () => {
  const guard = createStandaloneRequestGuard(config, () => Date.now());
  const run = (init = {}, path = `/workspace/${ws}/connections`) =>
    guard.handle(
      new Request(origin + path, {
        method: init.method ?? "GET",
        headers: { Cookie: `__Host-morrow_session=${secret}`, ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
      }),
      "connections",
      async (context) => {
        assert.equal(context.sessionDigest, sha(secret));
        assert.equal(context.workspaceId, ws);
        assert.equal(context.commandId, null);
        assert.equal(context.nonceDigest, null);
        return new Response("{}", { status: 200 });
      },
    );
  assert.equal((await run()).status, 200);
  assert.equal(
    (await run({ headers: { "Sec-Fetch-Site": "same-origin", Origin: origin } })).status,
    200,
  );
  const post = await run({
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET");
  for (const [init, path, status] of [
    [{ headers: { "Sec-Fetch-Site": "none" } }, undefined, 403],
    [{ headers: { "Sec-Fetch-Site": "cross-site" } }, undefined, 403],
    [{ headers: { Origin: "https://evil.test" } }, undefined, 403],
    [{ headers: { "Idempotency-Key": command } }, undefined, 400],
    [{ headers: { "X-Morrow-CSRF": "x" } }, undefined, 400],
    [{ headers: { "Content-Type": "application/json" } }, undefined, 400],
    [{}, `/workspace/${ws}/connections/`, 404],
    [{}, `/workspace/${ws}/connections?x=1`, 403],
    [{ headers: { Cookie: "" } }, undefined, 401],
  ])
    assert.equal((await run(init, path)).status, status, JSON.stringify([init, path]));
});
