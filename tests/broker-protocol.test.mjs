import assert from "node:assert/strict";
import test from "node:test";
import {
  brokerCallerRoles,
  brokerLimits,
  brokerNeonRoleNames,
  brokerNeonRoles,
  brokerPasswordSecret,
  brokerPasswordValid,
  brokerRequiredSecrets,
  brokerRequiredSecretsFor,
  brokerStripeSecrets,
  decodeNeonLeaseGrant,
  encodeNeonLeaseGrant,
  neonLeaseNamespace,
  parseBrokerDatabaseBinding,
  workosSessionNamespace,
} from "../packages/identity/src/broker-protocol.ts";
import { captureManagedWorkspaceBinding } from "../packages/identity/src/managed-workspace-binding.ts";
import {
  createWorkersControlledNeonLoginPools,
  createWorkersRequestBoundNeonWorkspacePools,
} from "../packages/identity/src/controlled-neon-login-pool.ts";
import { createSyntheticFixedWorkosLoginPort } from "../packages/identity/src/fixed-workos-login-port.ts";
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
import {
  bindManagedLoginRequestNamespace,
  createManagedLoginRequestOwner,
} from "../packages/identity/src/managed-login-request-scope.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";
import { createNeonWorkConnector } from "../packages/work/src/neon-connector.ts";

// P04.T02a D4: the single role table, byte-equal namespaces and the closed grant.
const binding = Object.freeze({
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-protocol-unit",
  branchId: "br-protocol-unit",
  hostname: "ep-protocol-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
});
const provider = createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" });
const control = () =>
  Object.freeze({ deadlineMs: Date.now() + 5000, signal: new AbortController().signal });

test("one role table drives the ten role secrets and the broker's required secrets", () => {
  assert.ok(Object.isFrozen(brokerNeonRoles) && Object.isFrozen(brokerRequiredSecrets));
  // P05.T01x (ADR-0009 item 4): the login selection role left; the signup executor joined.
  // P06.T01a (ADR-0010 item 2): the api Worker's work login joined.
  // M2 PR-1 (ADR-0022 items 7-8): the connector's and the orchestrator's executor logins.
  assert.deepEqual(brokerNeonRoleNames, [
    "morrow_identity_login",
    "morrow_identity_preauth",
    "morrow_identity_sessions",
    "morrow_api",
    "morrow_identity_linking",
    "morrow_identity_logout",
    "morrow_identity_onboarding",
    "morrow_api_worker",
    "morrow_connector_ingress",
    "morrow_runtime_executor",
  ]);
  assert.equal(brokerNeonRoles.morrow_api_worker, "work_request_transaction");
  assert.equal(brokerNeonRoles.morrow_connector_ingress, "connector_request_transaction");
  assert.equal(brokerNeonRoles.morrow_runtime_executor, "runtime_step_transaction");
  assert.equal(brokerPasswordSecret("morrow_api_worker"), "MORROW_DB_PASSWORD_MORROW_API_WORKER");
  assert.equal(brokerPasswordSecret("morrow_api"), "MORROW_DB_PASSWORD_MORROW_API");
  // Each caller's roles partition the table; the api keeps the eight of v0.
  assert.ok(Object.isFrozen(brokerCallerRoles));
  assert.deepEqual(
    [...brokerCallerRoles.api, ...brokerCallerRoles.connector, ...brokerCallerRoles.runtime],
    brokerNeonRoleNames,
  );
  assert.deepEqual(brokerCallerRoles.connector, ["morrow_connector_ingress"]);
  assert.deepEqual(brokerCallerRoles.runtime, ["morrow_runtime_executor"]);
  // The broker's own vault login is never leased, so it is not in the table.
  assert.equal(Object.hasOwn(brokerNeonRoles, "morrow_vault_broker"), false);
  // P05.T01ab (ADR-0019 item 6): the Turnstile secret is the one provider credential
  // admitted beside WorkOS under v0.
  assert.deepEqual(brokerRequiredSecrets, [
    "WORKOS_API_KEY",
    "TURNSTILE_SECRET_KEY",
    ...brokerNeonRoleNames.map((role) => "MORROW_DB_PASSWORD_" + role.toUpperCase()),
    "MORROW_DB_PASSWORD_MORROW_VAULT_BROKER",
    "MORROW_VAULT_KEK_V1",
    // M5 PR-1 (ADR-0022 items 7 and 12): Stripe, development and staging only.
    "STRIPE_RESTRICTED_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]);
  assert.equal(brokerRequiredSecrets.length, 16);
  assert.deepEqual(brokerStripeSecrets, ["STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET"]);
  // Production holds the vault and Stripe (ADR-0022 item 7; ADR-0007 item 9): a production
  // deploy requires neither the vault login's password, a KEK nor a Stripe secret (12).
  assert.equal(brokerRequiredSecretsFor("development"), brokerRequiredSecrets);
  assert.equal(brokerRequiredSecretsFor("staging"), brokerRequiredSecrets);
  assert.deepEqual(
    brokerRequiredSecretsFor("production"),
    brokerRequiredSecrets.filter((name) => !/VAULT|STRIPE/.test(name)),
  );
  assert.equal(brokerRequiredSecretsFor("production").length, 12);
  assert.deepEqual(brokerLimits, {
    namespaceMaxBytes: 1024,
    selectorMaxBytes: 2048,
    sessionPageMaxMs: 10000,
    sessionPageMaxBytes: 131072,
    healthMaxMs: 1000,
    healthCacheMs: 30000,
  });
});

test("neonLeaseNamespace is byte-equal to the namespace every pool and the work connector borrow", async (t) => {
  const borrowed = [];
  const recorder = {
    borrow(namespaceJson) {
      borrowed.push(namespaceJson);
      return Promise.reject(Error("RECORDED_ONLY"));
    },
  };
  const dependencies = {
    bindingJson: JSON.stringify(binding),
    credentialBroker: recorder,
    now: Date.now,
  };
  const login = await createWorkersControlledNeonLoginPools(dependencies);
  for (const pool of Object.values(login)) await assert.rejects(pool.connect(control()));
  const parent = new AbortController();
  const attempt = createLoginAttempt(Date.now, parent.signal, 5000);
  t.after(() => attempt.end());
  const owner = createManagedLoginRequestOwner({ waitUntil() {} }, attempt);
  bindManagedLoginRequestNamespace(owner.scope, owner.ownerToken, "a".repeat(64));
  const workspace = await createWorkersRequestBoundNeonWorkspacePools(
    dependencies,
    owner.scope,
    owner.ownerToken,
    "a".repeat(64),
  );
  for (const pool of Object.values(workspace)) await assert.rejects(pool.connect(control()));
  // P06.T01a: the api Worker's work login borrows its own namespace per request.
  await assert.rejects(
    createNeonWorkConnector(binding, recorder).open({ ...control(), waitUntil() {} }),
  );
  const parsed = parseBrokerDatabaseBinding(JSON.stringify(binding));
  assert.deepEqual(
    [...borrowed].sort(),
    brokerCallerRoles.api.map((role) => neonLeaseNamespace(parsed, role)).sort(),
  );
  assert.equal(borrowed.length, 8);
});

test("workosSessionNamespace equals the login port's session-catalogue borrow", async () => {
  const seen = [];
  const port = await createSyntheticFixedWorkosLoginPort({
    configurationJson: provider.configurationJson,
    now: Date.now,
    fetch: () => Promise.reject(Error("NO_NETWORK")),
    sessionCredentialBroker: {
      borrow(namespaceJson) {
        seen.push(namespaceJson);
        return Promise.reject(Error("RECORDED_ONLY"));
      },
    },
  });
  const selector = JSON.stringify({
    schemaVersion: 1,
    subjectId: "user_" + "A".repeat(26),
    after: null,
    limit: 100,
    order: "asc",
  });
  await assert.rejects(port.readSessionPage(selector, control()));
  assert.deepEqual(seen, [workosSessionNamespace(provider.configurationJson)]);
  assert.throws(() => workosSessionNamespace("{}"), /BROKER_PROTOCOL_INVALID/);
});

test("the broker binding parser agrees with captureManagedWorkspaceBinding over a corpus", () => {
  const login = JSON.parse(provider.configurationJson);
  const auth = JSON.parse(login.authenticationBindingJson);
  const captureAccepts = (bindingJson) => {
    try {
      captureManagedWorkspaceBinding({
        loginConfigurationJson: provider.configurationJson,
        workspaceConfigurationJson: JSON.stringify({
          schemaVersion: 1,
          mode: "https",
          origin: login.origin,
        }),
        logoutConfigurationJson: JSON.stringify({
          schemaVersion: 1,
          protocol: "morrow-self-logout-v1",
          origin: login.origin,
          providerId: "workos",
          environmentId: auth.environmentId,
          applicationId: auth.applicationId,
          clientId: auth.clientId,
          profileId: login.profileId,
        }),
        bindingJson,
      });
      return true;
    } catch {
      return false;
    }
  };
  const brokerAccepts = (bindingJson) => {
    try {
      parseBrokerDatabaseBinding(bindingJson);
      return true;
    } catch {
      return false;
    }
  };
  const corpus = [
    binding,
    { ...binding, environment: "development" },
    { ...binding, environment: "production" },
    { ...binding, schemaVersion: 2 },
    { ...binding, hostname: "ep-protocol-unit-pooler.c-14.us-east-1.aws.neon.tech" },
    { ...binding, hostname: "ep-x.us-east-1.aws.neon.tech" },
    { ...binding, hostname: "ep-x.us-east-1.gcp.neon.tech" },
    { ...binding, hostname: "localhost" },
    { ...binding, branchId: "main" },
    { ...binding, projectId: "-bad" },
    { ...binding, database: "Morrow" },
    { ...binding, database: "morrow;drop" },
    { ...binding, extra: true },
  ].map((value) => JSON.stringify(value));
  corpus.push(
    JSON.stringify(binding).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    JSON.stringify({ ...binding, projectId: "p".repeat(4100) }),
    "[]",
    "null",
    "not json",
  );
  for (const sample of corpus)
    assert.equal(brokerAccepts(sample), captureAccepts(sample), sample.slice(0, 80));
  assert.equal(brokerAccepts(corpus[0]), true);
});

test("the lease grant has closed keys and the pool's password rules", () => {
  const password = "Synthetic-" + "x".repeat(20);
  const grant = encodeNeonLeaseGrant(password);
  assert.equal(grant, JSON.stringify({ schemaVersion: 1, password }));
  assert.equal(decodeNeonLeaseGrant(grant), password);
  for (const bad of [
    '{"schemaVersion":1,"password":"' + password + '","extra":1}',
    '{"schemaVersion":2,"password":"' + password + '"}',
    '{"password":"' + password + '"}',
    "not json",
    { schemaVersion: 1, password },
    JSON.stringify({ schemaVersion: 1, password: "short" }),
    JSON.stringify({ schemaVersion: 1, password: "has space " + "x".repeat(20) }),
    JSON.stringify({ schemaVersion: 1, password: "x".repeat(1025) }),
    JSON.stringify({ schemaVersion: 1, password: "\ud800" + "x".repeat(20) }),
  ])
    assert.throws(() => decodeNeonLeaseGrant(bad), /BROKER_PROTOCOL_INVALID/);
  assert.equal(brokerPasswordValid("x".repeat(16)), true);
  assert.throws(() => encodeNeonLeaseGrant("x"), /BROKER_PROTOCOL_INVALID/);
});

// M2 PR-2: the ConnectorBroker Shopify verdicts are closed JSON strings, encoded by the
// broker and decoded by the connector with the same rules; anything else is refused.
test("Shopify verdicts: closed shapes both ways; no secret, token or extra field crosses", async () => {
  const {
    brokerRequiredSecretsFor: required,
    decodeShopifyInstallResult,
    decodeShopifyLaunchVerdict,
    decodeShopifyWebhookVerdict,
    encodeShopifyInstallResult,
    encodeShopifyLaunchVerdict,
    encodeShopifyWebhookVerdict,
    shopifyLimits,
  } = await import("../packages/identity/src/broker-protocol.ts");
  // No broker secret name is added for Shopify: app secrets and tokens are vault rows.
  assert.equal(required("development").length, 14);
  assert.equal(required("production").length, 12);
  assert.ok(!required("development").some((name) => name.startsWith("SHOPIFY_")));
  assert.deepEqual(
    { ...shopifyLimits },
    {
      queryMaxBytes: 2048,
      webhookBodyMaxBytes: 262144,
      webhookHeadersMaxBytes: 4096,
      budgetMaxMs: 10000,
      timestampToleranceSeconds: 90,
      verdictMaxBytes: 8192,
    },
  );
  const launch = {
    verdict: "verified",
    shop: "dev-1.myshopify.com",
    installation: "unlinked",
    workspaceId: "ws_1",
  };
  assert.deepEqual(decodeShopifyLaunchVerdict(encodeShopifyLaunchVerdict(launch)), launch);
  assert.deepEqual(decodeShopifyLaunchVerdict(encodeShopifyLaunchVerdict({ verdict: "refused" })), {
    verdict: "refused",
  });
  for (const bad of [
    { ...launch, shop: "evil.example.com" },
    { ...launch, installation: "active" },
    { ...launch, workspaceId: "../x" },
  ])
    assert.throws(() => encodeShopifyLaunchVerdict(bad), /BROKER_PROTOCOL_INVALID/);
  for (const text of [
    "{}",
    JSON.stringify({
      schemaVersion: 1,
      verdict: "refused",
      shop: "a.myshopify.com",
      installation: null,
      workspaceId: null,
    }),
    JSON.stringify({ schemaVersion: 1, ...launch, extra: 1 }),
    JSON.stringify({ schemaVersion: 2, ...launch }),
    '{"schemaVersion":1,"verdict":"verified","verdict":"refused","shop":null,"installation":null,"workspaceId":null}',
  ])
    assert.throws(() => decodeShopifyLaunchVerdict(text), /BROKER_PROTOCOL_INVALID/, text);
  const token = "A".repeat(42) + "w";
  const installed = { outcome: "installed", workspaceId: "ws_1", continuationToken: token };
  assert.deepEqual(decodeShopifyInstallResult(encodeShopifyInstallResult(installed)), installed);
  assert.deepEqual(
    decodeShopifyInstallResult(
      encodeShopifyInstallResult({
        outcome: "reauthorised",
        workspaceId: "ws_1",
        continuationToken: null,
      }),
    ).continuationToken,
    null,
  );
  for (const outcome of [
    "refused",
    "state_invalid",
    "scopes_mismatch",
    "store_not_development",
    "exchange_uncertain",
    "outcome_unknown",
  ])
    assert.equal(
      decodeShopifyInstallResult(
        encodeShopifyInstallResult({ outcome, workspaceId: null, continuationToken: null }),
      ).outcome,
      outcome,
    );
  for (const bad of [
    { outcome: "refused", workspaceId: "ws_1", continuationToken: null },
    { outcome: "installed", workspaceId: null, continuationToken: null },
    { outcome: "installed", workspaceId: "ws_1", continuationToken: "short" },
    { outcome: "stored", workspaceId: null, continuationToken: null },
  ])
    assert.throws(() => encodeShopifyInstallResult(bad), /BROKER_PROTOCOL_INVALID/);
  const webhook = {
    verdict: "verified",
    topic: "customers/redact",
    shopDomain: "dev-1.myshopify.com",
    webhookId: "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
    minimisedBody: { shopId: "1", customerDigest: "a".repeat(64) },
  };
  assert.deepEqual(decodeShopifyWebhookVerdict(encodeShopifyWebhookVerdict(webhook)), webhook);
  for (const bad of [
    { ...webhook, topic: "orders/create" },
    { ...webhook, minimisedBody: { email: "a@b.test" } },
    { ...webhook, minimisedBody: { shopId: "1", note: "free text with spaces" } },
  ])
    assert.throws(() => encodeShopifyWebhookVerdict(bad), /BROKER_PROTOCOL_INVALID/);
});
