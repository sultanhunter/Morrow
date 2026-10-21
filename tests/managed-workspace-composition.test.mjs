// M2 PR-2 review: the deployed composition of the Shopify link. apps/api/src/deployed-worker.ts
// composes the policy package's connection kernel into the managed workspace api, whose
// handler selects the route by path and runs createManagedWorkspaceExecution on the
// request's pools. Over a scripted linking pool (no network, no database): the composed
// kernel is the real one; GET /workspace/:ws/connections reaches workspace_connections
// after the authority read; a preview runs the issuer before the lookup; and without a
// kernel no issue statement is ever sent and no install link is offered. The SQL runs in
// lab:shopify-install and lab:shopify-connect-workers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { composeApiDependencies } from "../apps/api/src/deployed-worker.ts";
import { mapApiEnvironment } from "../apps/api/src/environment.ts";
import { createWorkersManagedWorkspaceApi } from "../packages/identity/src/managed-workspace-api.ts";
import {
  createManagedWorkspaceExecution,
  managedWorkspaceRoute,
} from "../packages/identity/src/managed-workspace-request.ts";
import { createStandaloneRequestGuard } from "../packages/identity/src/standalone-request-guard.ts";
import { workspaceStoreLinkingControlSql as sql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const origin = "https://workspace.example.test";
const config = JSON.stringify({ schemaVersion: 1, mode: "https", origin });
const secret = Buffer.alloc(32, 41).toString("base64url");
const handoffToken = Buffer.alloc(32, 43).toString("base64url");
const command = "0b5e2a3c-7d41-4e2f-9a10-3c4d5e6f7a8b";
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
const connectGrant = {
  id: "grant_connect",
  principal: actor,
  capabilityId: "governance.connection.connect",
  verbs: ["administer", "approve"],
  scope: {
    organizationId: org,
    workspaceId: ws,
    storeIds: [],
    accountIds: [],
    resources: [
      {
        organizationId: org,
        workspaceId: ws,
        storeId: null,
        connectionId: null,
        kind: "workspace",
        id: ws,
      },
    ],
    fields: ["providerId", "installationProof", "scope"],
  },
  issuedBy: { ...actor, kind: "service", principalId: "morrow.onboarding", membershipId: null },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
};
const nowMs = Date.parse("2026-10-21T00:00:00.000Z");

// The deployed composition: a development environment the api's mapper accepts.
function composed() {
  const provider = createPlatformWorkosProviderOracle({ origin });
  const base = JSON.parse(provider.configurationJson);
  const auth = JSON.parse(base.authenticationBindingJson);
  // Workers with nodejs_compat_do_not_populate_process_env expose an empty process.env.
  const saved = process.env;
  process.env = {};
  let mapped;
  try {
    mapped = mapApiEnvironment({
      MORROW_ENVIRONMENT: "development",
      BROKER: Object.freeze({
        fetch() {},
        health() {},
        neonLease() {
          throw Error("NO_DATABASE_IN_THIS_TEST");
        },
        workosSessionPage() {},
        challengeVerify() {},
      }),
      LOGIN_CONFIGURATION_JSON: JSON.stringify({ ...base, retentionTier: "development" }),
      WORKSPACE_CONFIGURATION_JSON: config,
      LOGOUT_CONFIGURATION_JSON: JSON.stringify({
        schemaVersion: 1,
        protocol: "morrow-self-logout-v1",
        origin,
        providerId: "workos",
        environmentId: auth.environmentId,
        applicationId: auth.applicationId,
        clientId: auth.clientId,
        profileId: base.profileId,
      }),
      MORROW_DATABASE_BINDING_JSON: JSON.stringify({
        schemaVersion: 1,
        environment: "development",
        projectId: "morrow-composition-unit",
        branchId: "br-composition-unit",
        hostname: "ep-composition-unit.c-14.us-east-1.aws.neon.tech",
        database: "morrow",
      }),
      LOGIN_CAPSULE_KEYRING: JSON.stringify({
        schemaVersion: 1,
        purpose: "morrow.login.capsule/1",
        configurationDigest: "a".repeat(64),
        currentKeyId: "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
        versions: [],
      }),
    });
  } finally {
    process.env = saved;
  }
  assert.equal(mapped.ok, true, mapped.code);
  return composeApiDependencies(mapped.values, mapped.broker, () => nowMs);
}

// A scripted linking pool: the role row, then fixed answers by statement; every statement
// is recorded in order.
function linkingPool(answers) {
  const sent = [];
  return {
    sent,
    async connect() {
      return {
        async query(text, values) {
          sent.push(text);
          if (text === sql.role)
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
          assert.ok(values.every((v) => typeof v === "string"));
          return { rows: text in answers ? answers[text]() : [] };
        },
        async release() {},
      };
    },
  };
}
const identityPool = {
  async connect() {
    throw Error("THE_IDENTITY_POOL_IS_NOT_USED_HERE");
  },
};
const authority = () => [
  {
    principal_id: actor.principalId,
    organization_id: org,
    workspace_id: ws,
    membership_id: actor.membershipId,
    policy_revision: "1",
    grants: JSON.stringify([connectGrant]),
    grant_count: 1,
    database_now_ms: String(nowMs),
  },
];
const installUrl = "https://admin.shopify.com/oauth/install_custom_app?client_id=abc&signature=x";
const connections = () => [
  {
    installations: "[]",
    app_registered: true,
    install_url: installUrl,
    route: "morrow_direct",
    linked: false,
    owner: true,
  },
];
const statements = (pool) =>
  pool.sent.filter((text) =>
    [sql.authority, sql.connections, sql.issue, sql.lookup].includes(text),
  );
function previewContext() {
  return Object.freeze({
    workspaceId: ws,
    sessionDigest: sha(secret),
    commandId: command,
    nonceDigest: sha(handoffToken),
    csrfToken: null,
    control: Object.freeze({
      deadlineMs: Date.now() + 30000,
      signal: new AbortController().signal,
    }),
    check: () => Date.now(),
    wait: (p) => p,
  });
}

test("the deployed route table selects connections, preview, status, apply and bootstrap by path", () => {
  for (const [path, route] of [
    [`/workspace/${ws}/connections`, "connections"],
    [`/workspace/${ws}/bootstrap`, "bootstrap"],
    [`/workspace/${ws}/store-links/preview`, "preview"],
    [`/workspace/${ws}/store-links/status`, "status"],
    [`/workspace/${ws}/store-links`, "apply"],
    ["/workspaces", "workspaces"],
    ["/organizations", "organizations"],
    ["/auth/logout", "logout"],
    ["/auth/rotate", "rotate"],
  ])
    assert.equal(managedWorkspaceRoute(path), route, path);
});

test("composeApiDependencies wires the policy package's connection kernel into the managed api", async () => {
  const { dependencies } = composed();
  assert.equal(typeof dependencies.connections, "function");
  // The composed kernel is the real one: it allows the actor's connect/administer grant and
  // picks it, and denies an actor without one.
  const facts = (grants) => ({
    principalId: actor.principalId,
    organizationId: org,
    workspaceId: ws,
    membershipId: actor.membershipId,
    policyRevision: 1,
    grants,
    databaseNowMs: nowMs,
  });
  assert.deepEqual(await dependencies.connections(facts([connectGrant])), {
    allowed: true,
    grantId: "grant_connect",
  });
  assert.equal((await dependencies.connections(facts([]))).allowed, false);
  // The managed api accepts the composed dependencies, kernel included, and refuses a
  // kernel that is not a function.
  assert.doesNotThrow(() => createWorkersManagedWorkspaceApi(dependencies));
  assert.throws(
    () => createWorkersManagedWorkspaceApi({ ...dependencies, connections: 1 }),
    /MANAGED_WORKSPACE_API_CONFIGURATION_INVALID/,
  );
});

test("GET /workspace/:ws/connections reads authority then workspace_connections and answers WorkspaceConnections@1", async () => {
  const { dependencies } = composed();
  const pool = linkingPool({ [sql.authority]: authority, [sql.connections]: connections });
  const execute = createManagedWorkspaceExecution({
    configurationJson: config,
    identityPool,
    linkingPool: pool,
    now: () => Date.now(),
    connections: dependencies.connections,
  });
  const guard = createStandaloneRequestGuard(config, () => Date.now());
  const path = `/workspace/${ws}/connections`;
  const route = managedWorkspaceRoute(path);
  const response = await guard.handle(
    new Request(origin + path, { headers: { Cookie: `__Host-morrow_session=${secret}` } }),
    route,
    (context) => execute(route, context),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(validateCurrentDefinition("WorkspaceConnections", body));
  assert.deepEqual(body.installLink, { offered: true, url: installUrl, reason: "offered" });
  assert.deepEqual(statements(pool), [sql.authority, sql.connections]);
});

test("a preview runs the Shopify issuer before the lookup; without a kernel nothing is issued or offered", async () => {
  const { dependencies } = composed();
  const answers = {
    [sql.authority]: authority,
    [sql.issue]: () => [{ outcome: "issued" }],
    [sql.connections]: connections,
  };
  const withKernel = linkingPool(answers);
  const execute = createManagedWorkspaceExecution({
    configurationJson: config,
    identityPool,
    linkingPool: withKernel,
    now: () => Date.now(),
    connections: dependencies.connections,
  });
  // The lookup answers no row here (404); the order of the statements is the point.
  await execute("preview", previewContext());
  assert.deepEqual(statements(withKernel), [sql.authority, sql.issue, sql.lookup]);
  // Without a kernel: the unchanged P05.T03b lookup only, and no install link.
  const without = linkingPool(answers);
  const bare = createManagedWorkspaceExecution({
    configurationJson: config,
    identityPool,
    linkingPool: without,
    now: () => Date.now(),
  });
  await bare("preview", previewContext());
  const read = await bare("connections", {
    ...previewContext(),
    nonceDigest: null,
    commandId: null,
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).installLink.reason, "not_permitted");
  assert.ok(!without.sent.includes(sql.issue));
  assert.deepEqual(statements(without), [sql.lookup, sql.authority, sql.connections]);
});
