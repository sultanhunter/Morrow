import assert from "node:assert/strict";
import test from "node:test";
import {
  brokerLimits,
  brokerNeonRoleNames,
  brokerNeonRoles,
  brokerPasswordSecret,
  brokerPasswordValid,
  brokerRequiredSecrets,
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

test("one role table drives the seven role secrets and the broker's required secrets", () => {
  assert.ok(Object.isFrozen(brokerNeonRoles) && Object.isFrozen(brokerRequiredSecrets));
  assert.deepEqual(brokerNeonRoleNames, [
    "morrow_identity_login",
    "morrow_identity_preauth",
    "morrow_identity_resolution",
    "morrow_identity_sessions",
    "morrow_api",
    "morrow_identity_linking",
    "morrow_identity_logout",
  ]);
  assert.equal(brokerPasswordSecret("morrow_api"), "MORROW_DB_PASSWORD_MORROW_API");
  assert.deepEqual(brokerRequiredSecrets, [
    "WORKOS_API_KEY",
    ...brokerNeonRoleNames.map((role) => "MORROW_DB_PASSWORD_" + role.toUpperCase()),
  ]);
  assert.deepEqual(brokerLimits, {
    namespaceMaxBytes: 1024,
    selectorMaxBytes: 2048,
    sessionPageMaxMs: 10000,
    sessionPageMaxBytes: 131072,
    healthMaxMs: 1000,
    healthCacheMs: 30000,
  });
});

test("neonLeaseNamespace is byte-equal to the namespace every pool borrows", async (t) => {
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
  const parsed = parseBrokerDatabaseBinding(JSON.stringify(binding));
  assert.deepEqual(
    [...borrowed].sort(),
    brokerNeonRoleNames.map((role) => neonLeaseNamespace(parsed, role)).sort(),
  );
  assert.equal(borrowed.length, 7);
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
