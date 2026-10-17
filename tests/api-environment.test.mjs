import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { apiEnvironmentValueBindings, mapApiEnvironment } from "../apps/api/src/environment.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";

// P04.T02a AC07, AC09 and the mapper side of AC08. Markers are built at runtime.
const provider = createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" });
const base = JSON.parse(provider.configurationJson);
const auth = JSON.parse(base.authenticationBindingJson);
function values(environment = "development", change = {}) {
  const login = JSON.stringify({ ...base, retentionTier: change.retentionTier ?? environment });
  return {
    LOGIN_CONFIGURATION_JSON: login,
    WORKSPACE_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      mode: "https",
      origin: base.origin,
    }),
    LOGOUT_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      protocol: "morrow-local-self-logout-85",
      origin: base.origin,
      providerId: "workos",
      environmentId: auth.environmentId,
      applicationId: auth.applicationId,
      clientId: auth.clientId,
      profileId: base.profileId,
    }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify({
      schemaVersion: 1,
      environment: change.bindingEnvironment ?? environment,
      projectId: "morrow-mapper-unit",
      branchId: "br-mapper-unit",
      hostname: "ep-mapper-unit.c-14.us-east-1.aws.neon.tech",
      database: "morrow",
    }),
    LOGIN_CAPSULE_KEYRING: JSON.stringify({
      schemaVersion: 1,
      purpose: "morrow.login.capsule/1",
      configurationDigest: "a".repeat(64),
      currentKeyId: randomUUID(),
      versions: [],
    }),
  };
}
const broker = () =>
  Object.freeze({ fetch() {}, health() {}, neonLease() {}, workosSessionPage() {} });
const env = (environment = "development", change = {}) => ({
  MORROW_ENVIRONMENT: environment,
  BROKER: broker(),
  ...values(environment, change),
});
// Workers with nodejs_compat_do_not_populate_process_env expose an empty process.env.
function map(record, processEnv = {}) {
  const saved = process.env;
  process.env = processEnv;
  try {
    return mapApiEnvironment(record);
  } finally {
    process.env = saved;
  }
}
const code = (record, processEnv) => {
  const mapped = map(record, processEnv);
  return mapped.ok ? "OK" : mapped.code;
};

test("a complete development or staging record maps once, frozen", () => {
  for (const environment of ["development", "staging"]) {
    const mapped = map(env(environment));
    assert.equal(mapped.ok, true);
    assert.equal(mapped.environment, environment);
    assert.ok(Object.isFrozen(mapped) && Object.isFrozen(mapped.values));
    assert.deepEqual(Object.keys(mapped.values).sort(), [
      "binding",
      "keyring",
      "login",
      "logout",
      "workspace",
    ]);
  }
});

test("every committed environment is unbound: only MORROW_ENVIRONMENT and BROKER", () => {
  for (const environment of ["development", "staging", "production"])
    assert.equal(code({ MORROW_ENVIRONMENT: environment, BROKER: broker() }), "API_ENV_UNBOUND");
});

test("AC07: any provider or credential-like binding keeps the api unbound", () => {
  const marker = randomBytes(12).toString("hex");
  for (const name of [
    "WORKOS_API_KEY",
    "MORROW_DB_PASSWORD_MORROW_API",
    "NEON_HOST",
    "PGPASSWORD",
    "SHOPIFY_API_SECRET",
    "X_TOKEN",
    "OPENAI_API_KEY",
    "E2B_API_KEY",
    "workos_client",
    "DEPLOY_SECRET",
  ])
    assert.equal(
      code({ ...env(), [name]: ["sk", "test", marker].join("_") }),
      "API_ENV_FORBIDDEN_CREDENTIAL_BINDING",
      name,
    );
  assert.equal(code(env()), "OK");
});

test("AC08 (mapper): a populated process.env is refused before anything else", () => {
  assert.equal(code(env(), { MORROW_ENVIRONMENT: "development" }), "API_ENV_PROCESS_ENV_POPULATED");
  assert.equal(code(env(), {}), "OK");
});

test("AC09: missing, empty, oversized, ill-formed or object values have fixed codes", () => {
  for (const [name, , limit] of apiEnvironmentValueBindings) {
    const missing = env();
    delete missing[name];
    assert.equal(code(missing), "API_ENV_PARTIAL", name + " missing");
    assert.equal(code({ ...env(), [name]: "" }), "API_ENV_VALUE_INVALID", name + " empty");
    assert.equal(
      code({ ...env(), [name]: "x".repeat(limit + 1) }),
      "API_ENV_VALUE_INVALID",
      name + " oversized",
    );
    assert.equal(
      code({ ...env(), [name]: '{"a":"\ud800"}' }),
      "API_ENV_VALUE_INVALID",
      name + " UTF-16",
    );
    assert.equal(
      code({ ...env(), [name]: { value: "{}" } }),
      "API_ENV_VALUE_INVALID",
      name + " object",
    );
  }
  const record = env();
  const binding = JSON.parse(record.MORROW_DATABASE_BINDING_JSON);
  const padded = JSON.stringify({ ...binding, projectId: binding.projectId }) + " ".repeat(5000);
  assert.equal(Buffer.byteLength(padded) > 5000, true);
  assert.equal(code({ ...record, MORROW_DATABASE_BINDING_JSON: padded }), "API_ENV_VALUE_INVALID");
  const getter = env();
  Object.defineProperty(getter, "LOGIN_CAPSULE_KEYRING", {
    get: () => values().LOGIN_CAPSULE_KEYRING,
    enumerable: true,
  });
  assert.equal(code(getter), "API_ENV_VALUE_INVALID");
});

test("AC09: cross-binding mismatches and production always fail step 7", () => {
  assert.equal(
    code(env("development", { bindingEnvironment: "staging" })),
    "API_ENV_CROSS_BINDING_MISMATCH",
  );
  assert.equal(
    code(env("staging", { retentionTier: "development" })),
    "API_ENV_CROSS_BINDING_MISMATCH",
  );
  assert.equal(
    code(env("production", { bindingEnvironment: "staging", retentionTier: "production" })),
    "API_ENV_CROSS_BINDING_MISMATCH",
  );
  assert.equal(
    code(env("production", { bindingEnvironment: "production" })),
    "API_ENV_CROSS_BINDING_MISMATCH",
  );
  const record = env();
  assert.equal(
    code({
      ...record,
      WORKSPACE_CONFIGURATION_JSON: JSON.stringify({
        schemaVersion: 1,
        mode: "https",
        origin: "https://other.example.test",
      }),
    }),
    "API_ENV_CROSS_BINDING_MISMATCH",
  );
});

test("records, environments, keyrings and the broker binding have their own codes", () => {
  for (const value of [null, undefined, 1, "env", [], () => {}])
    assert.equal(code(value), "API_ENV_RECORD_INVALID");
  assert.equal(code({ ...env(), [Symbol("x")]: 1 }), "API_ENV_RECORD_INVALID");
  for (const environment of [undefined, "", "prod", "Development", 1])
    assert.equal(
      code({ ...env(), MORROW_ENVIRONMENT: environment }),
      "API_ENV_ENVIRONMENT_INVALID",
    );
  const keyring = JSON.parse(values().LOGIN_CAPSULE_KEYRING);
  assert.equal(
    code({ ...env(), LOGIN_CAPSULE_KEYRING: JSON.stringify({ ...keyring, purpose: "other" }) }),
    "API_ENV_VALUE_INVALID",
  );
  assert.equal(code({ ...env(), LOGIN_CAPSULE_KEYRING: "not json" }), "API_ENV_VALUE_INVALID");
  for (const value of [undefined, null, "BROKER", {}, { fetch: "x" }]) {
    const record = env();
    if (value === undefined) delete record.BROKER;
    else record.BROKER = value;
    assert.equal(code(record), "API_ENV_BROKER_BINDING_INVALID");
  }
});

test("1,000 fuzzed records never throw and never map a non-development/staging record", () => {
  const pick = (items) => items[Math.floor(Math.random() * items.length)];
  const names = [
    "MORROW_ENVIRONMENT",
    "BROKER",
    ...apiEnvironmentValueBindings.map(([name]) => name),
    "WORKOS_API_KEY",
    "ASSETS",
    "__proto__",
    "constructor",
  ];
  const samples = [
    undefined,
    null,
    "",
    "development",
    "production",
    1,
    true,
    {},
    [],
    "{}",
    "\ud800",
    "x".repeat(40000),
    broker(),
    ...Object.values(values()),
  ];
  for (let i = 0; i < 1000; i++) {
    const record = Math.random() < 0.5 ? env(pick(["development", "staging", "production"])) : {};
    for (let j = 0; j < 1 + Math.floor(Math.random() * 4); j++)
      Object.defineProperty(record, pick(names), {
        value: pick(samples),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    let mapped;
    assert.doesNotThrow(() => (mapped = map(record)));
    if (mapped.ok) assert.ok(["development", "staging"].includes(mapped.environment));
    else assert.match(mapped.code, /^API_ENV_[A-Z_]+$/);
  }
});
