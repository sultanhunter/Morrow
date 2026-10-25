// M2 PR-3 review: the deployed catalogue routes, composed with the work origin and
// connector and the ApiBroker's shopifyRead reader, and passed by the deployed Worker as
// createWorkspaceApiWorker's fifth argument (a catalogue GET reaches the fake broker with
// the lease, query, variables and budget; a bound route reaches the database step).
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
import { composeApiDependencies, runAdmissionOpen } from "../apps/api/src/deployed-worker.ts";
import { runtimeProductReadAvailable } from "../packages/identity/src/broker-protocol.ts";
import { mapApiEnvironment } from "../apps/api/src/environment.ts";
import { createWorkersManagedWorkspaceApi } from "../packages/identity/src/managed-workspace-api.ts";
import {
  createManagedWorkspaceExecution,
  managedWorkspaceRoute,
} from "../packages/identity/src/managed-workspace-request.ts";
import { createStandaloneRequestGuard } from "../packages/identity/src/standalone-request-guard.ts";
import { workspaceStoreLinkingControlSql as sql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { workStatements } from "../packages/work/src/sql.ts";
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

// The deployed environment: a development environment the api's mapper accepts. `extra`
// adds bindings (M5: MORROW_STRIPE_MODE); `brokerCalls` counts every Stripe method call;
// `brokerMethods` adds ApiBroker methods (M2 PR-3: shopifyRead).
function apiEnv(extra = {}, brokerCalls = [], brokerMethods = {}) {
  const provider = createPlatformWorkosProviderOracle({ origin });
  const base = JSON.parse(provider.configurationJson);
  const auth = JSON.parse(base.authenticationBindingJson);
  return {
    MORROW_ENVIRONMENT: "development",
    BROKER: Object.freeze({
      fetch() {},
      health() {},
      neonLease() {
        throw Error("NO_DATABASE_IN_THIS_TEST");
      },
      workosSessionPage() {},
      challengeVerify() {},
      ...Object.fromEntries(
        [
          "stripeCustomerEnsure",
          "stripeCheckoutCreate",
          "stripePortalCreate",
          "stripeWebhookVerify",
        ].map((name) => [
          name,
          async () => {
            brokerCalls.push(name);
            throw Error("BROKER_HELD");
          },
        ]),
      ),
      ...brokerMethods,
    }),
    ...extra,
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
  };
}
// Workers with nodejs_compat_do_not_populate_process_env expose an empty process.env.
function withWorkerEnv(run) {
  const saved = process.env;
  process.env = {};
  try {
    return run();
  } finally {
    process.env = saved;
  }
}
// The deployed composition of that environment.
function composed(
  extra = {},
  brokerCalls = [],
  { modeArgument = true, broker = {}, productRead } = {},
) {
  const mapped = withWorkerEnv(() => mapApiEnvironment(apiEnv(extra, brokerCalls, broker)));
  assert.equal(mapped.ok, true, mapped.code);
  return modeArgument
    ? composeApiDependencies(
        mapped.values,
        mapped.broker,
        () => nowMs,
        mapped.environment,
        mapped.stripe,
        mapped.model,
        ...(productRead === undefined ? [] : [productRead]),
      )
    : composeApiDependencies(mapped.values, mapped.broker, () => nowMs, mapped.environment);
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

// M5, the Stripe switch (owner decision (c), 2026-10-21): off (no MORROW_STRIPE_MODE, the
// committed state) composes the billing API and the webhook with no broker Stripe port, so
// the deployed Worker answers the webhook 503 {"code":"unavailable"} and never calls a
// Stripe method; "test" composes the ApiBroker's four Stripe methods. The default is off.
test("M5: the deployed composition has Stripe adapters only while the switch is on", async () => {
  const calls = [];
  const off = composed({}, calls);
  assert.equal(off.billing.broker, null);
  assert.equal(off.webhook.broker, null);
  assert.equal(off.billing.environment, "development");
  const on = composed({ MORROW_STRIPE_MODE: "test" }, calls);
  for (const port of [on.billing.broker, on.webhook.broker])
    assert.deepEqual(Object.keys(port).sort(), [
      "checkoutCreate",
      "customerEnsure",
      "portalCreate",
      "webhookVerify",
    ]);
  const { createWorkspaceApiWorker } = await import("../apps/api/src/worker.ts");
  const ctx = { waitUntil() {} };
  const deliver = (deps) =>
    createWorkspaceApiWorker(deps.dependencies, deps.work, deps.billing, deps.webhook).fetch(
      new Request(origin + "/api/billing/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=" + "a".repeat(64) },
        body: "{}",
      }),
      {},
      ctx,
    );
  const offReply = await deliver(off);
  assert.equal(offReply.status, 503);
  assert.equal(await offReply.text(), '{"code":"unavailable"}');
  assert.deepEqual(calls, []);
  // On, the same request reaches the broker's verify method (held here: 503 for a retry).
  const onReply = await deliver(on);
  assert.equal(onReply.status, 503);
  assert.deepEqual(await onReply.json(), { received: false });
  assert.deepEqual(calls, ["stripeWebhookVerify"]);
  // A composition without the mode argument has no adapters either (the default is off).
  const defaulted = composed({ MORROW_STRIPE_MODE: "test" }, calls, { modeArgument: false });
  assert.equal(defaulted.billing.broker, null);
  assert.equal(defaulted.webhook.broker, null);
});

// M2 PR-3 review: the catalogue routes of the deployed composition.
const store = "store_a",
  connection = "connection_a",
  lease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const catalogGrant = {
  ...connectGrant,
  id: "grant_catalog_read",
  capabilityId: "catalog.products.read",
  verbs: ["view"],
  scope: {
    organizationId: org,
    workspaceId: ws,
    storeIds: [store],
    accountIds: [],
    resources: [storeResource(org, ws, store, connection)],
    fields: [...listingFieldPaths],
  },
  issuedBy: { ...actor, kind: "service", principalId: "morrow.linking", membershipId: null },
};
// A scripted work connection: the session's authority, the store association and the read
// lease; every other statement (the prologue, COMMIT) answers no rows.
function catalogConnection(sent) {
  const names = new Map(Object.entries(workStatements).map(([name, text]) => [text, name]));
  return {
    async query(text) {
      const name = names.get(text) ?? text;
      sent.push(name);
      if (name === "enterContext")
        return {
          rows: [
            {
              principal_id: actor.principalId,
              organization_id: org,
              workspace_id: ws,
              membership_id: actor.membershipId,
              policy_revision: "1",
              grants: JSON.stringify([catalogGrant]),
              grant_count: "1",
              grants_digest: "a".repeat(64),
              database_now_us: String(nowMs * 1000),
            },
          ],
        };
      if (name === "storeAssociation")
        return {
          rows: [
            {
              store_id: store,
              connection_id: connection,
              database_now: "2026-10-21T00:00:00.000Z",
            },
          ],
        };
      if (name === "catalogReadLease")
        return {
          rows: [
            {
              outcome: "opened",
              lease_id: lease,
              generation: "1",
              expires_at_ms: "1",
              subject_id: "subject_1",
            },
          ],
        };
      return { rows: [] };
    },
    async close() {},
  };
}
const catalogRequest = () =>
  new Request(origin + `/workspace/${ws}/stores/${store}/catalog/collections`, {
    headers: { Cookie: "__Host-morrow_session=" + secret, "Sec-Fetch-Site": "same-origin" },
  });

test("M2 PR-3: the composed catalogue route reads under its lease through ApiBroker.shopifyRead", async (t) => {
  t.mock.method(console, "log", () => {});
  const reads = [];
  const reply = JSON.stringify({
    schemaVersion: 1,
    outcome: "read",
    collections: [{ id: "collection:5", title: "Summer" }],
    nextCursor: null,
  });
  const deps = composed({}, [], {
    broker: {
      async shopifyRead(...args) {
        reads.push(args);
        return reply;
      },
    },
  });
  // The catalogue dependencies are the work origin and connector and the broker's reader.
  assert.equal(deps.catalog.origin, deps.work.origin);
  assert.equal(deps.catalog.connector, deps.work.connector);
  assert.equal(typeof deps.catalog.reader?.read, "function");
  const { createWorkspaceApiWorker } = await import("../apps/api/src/worker.ts");
  const sent = [];
  // The composed reader over a scripted work connection (the Neon connector needs a database).
  const api = createWorkspaceApiWorker(deps.dependencies, deps.work, deps.billing, deps.webhook, {
    ...deps.catalog,
    connector: { open: async () => catalogConnection(sent) },
  });
  const response = await api.fetch(catalogRequest(), {}, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    collections: [{ id: "collection:5", title: "Summer" }],
    nextCursor: null,
    storeId: store,
  });
  assert.ok(sent.includes("catalogReadLease"));
  assert.equal(reads.length, 1);
  const [leaseId, generation, subjectId, queryName, variables, budget] = reads[0];
  assert.deepEqual(
    [leaseId, generation, subjectId, queryName, variables],
    [lease, 1, "subject_1", "collectionsPage", '{"after":null}'],
  );
  assert.ok(Number.isSafeInteger(budget) && budget >= 1 && budget <= 8750, String(budget));
  // Without the fifth argument the catalogue route is unbound: 401, no read.
  const unbound = createWorkspaceApiWorker(
    deps.dependencies,
    deps.work,
    deps.billing,
    deps.webhook,
  );
  assert.equal((await unbound.fetch(catalogRequest(), {}, { waitUntil() {} })).status, 401);
  assert.equal(reads.length, 1);
});

test("M2 PR-3: the deployed Worker binds the catalogue route (it reaches the database step, never 401)", async (t) => {
  t.mock.method(console, "log", () => {});
  const reads = [];
  const env = apiEnv({}, [], {
    async shopifyRead(...args) {
      reads.push(args);
      return "{}";
    },
  });
  const { default: deployed } = await import("../apps/api/src/deployed-worker.ts");
  const response = await withWorkerEnv(() =>
    deployed.fetch(catalogRequest(), env, { waitUntil() {} }),
  );
  // The work connector asked the broker for its lease, which this test refuses: 503
  // unavailable (a safe read retry). An unbound catalogue route would have answered 401.
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "unavailable");
  assert.equal(body.retryClass, "safe_read_retry");
  assert.equal(reads.length, 0);
});

// M3 PR-2 review: the api's run admission opens on the model-provider switch and M2 PR-3's
// product read together, as the orchestrator's dispatch does, so no run, lease or credit
// reservation exists without a Workflow to execute it. The read exists since M2 PR-3 and M3
// PR-2 were integrated, so the switch (on in staging since model-provider-on, 2026-10-25) is the
// only gate.
test("M3 PR-2: run admission opens only with the model switch and the product read", () => {
  assert.equal(runtimeProductReadAvailable, true);
  for (const [mode, read, open] of [
    ["off", false, false],
    ["off", true, false],
    ["anthropic", false, false],
    ["anthropic", true, true],
  ])
    assert.equal(runAdmissionOpen(mode, read), open, mode + ":" + read);
  // The committed state (the switch off) keeps admission closed; the switch on opens it.
  assert.equal(composed({}).runs.admission, false);
  assert.equal(composed({ MORROW_MODEL_PROVIDER: "anthropic" }).runs.admission, true);
  // A build without the product read keeps it closed even with the switch on.
  assert.equal(
    composed({ MORROW_MODEL_PROVIDER: "anthropic" }, [], { productRead: false }).runs.admission,
    false,
  );
  assert.equal(
    composed({ MORROW_MODEL_PROVIDER: "anthropic" }, [], { productRead: true }).runs.admission,
    true,
  );
  assert.equal(composed({}, [], { productRead: true }).runs.admission, false);
});
