import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  apiEnvironmentValueBindings,
  mapAbuseGuard,
  mapApiEnvironment,
} from "../apps/api/src/environment.ts";
import { resolvedEdgeConfig } from "../scripts/edge.mjs";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";
import { appliedLegacyLoginControllerProtocol } from "../scripts/fixtures/standalone-login-fixture.mjs";

// P04.T02a AC07, AC09 and the mapper side of AC08. Markers are built at runtime.
const provider = createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" });
const base = JSON.parse(provider.configurationJson);
const auth = JSON.parse(base.authenticationBindingJson);
function values(environment = "development", change = {}) {
  const login = JSON.stringify({
    ...base,
    controllerProtocol: change.controllerProtocol ?? base.controllerProtocol,
    retentionTier: change.retentionTier ?? environment,
  });
  return {
    LOGIN_CONFIGURATION_JSON: login,
    WORKSPACE_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      mode: "https",
      origin: base.origin,
    }),
    LOGOUT_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      protocol: change.logoutProtocol ?? "morrow-self-logout-v1",
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
  Object.freeze({
    fetch() {},
    health() {},
    neonLease() {},
    workosSessionPage() {},
    challengeVerify() {},
  });
// P05.T01ab: the abuse-guard bindings that staging and production require.
const siteKey = "0x" + "4AAAAAAA" + randomBytes(12).toString("hex");
const challengeJson = (change = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    provider: "turnstile",
    siteKey,
    actions: { login: "account_login", signup: "organization_signup" },
    ...change,
  });
const limiter = () => Object.freeze({ limit: async () => ({ success: true }) });
const guard = () => ({
  LOGIN_CHALLENGE_JSON: challengeJson(),
  LOGIN_START_LIMITER: limiter(),
  LOGIN_CALLBACK_LIMITER: limiter(),
  SIGNUP_LIMITER: limiter(),
  SESSION_LIMITER: limiter(),
});
const env = (environment = "development", change = {}) => ({
  MORROW_ENVIRONMENT: environment,
  BROKER: broker(),
  ...values(environment, change),
  ...(environment === "development" ? {} : guard()),
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
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    // M2 PR-1: the vault KEK binds only to the broker (ADR-0022 item 7).
    "MORROW_VAULT_KEK_V1",
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

// Migration 0012 (P05.T01x Part A): captureManagedWorkspaceBinding admits only the
// current login and logout protocols, so a retired or unknown one keeps the api unbound.
test("AC09: a retired or unknown login or logout protocol fails step 7", () => {
  assert.equal(base.controllerProtocol, "morrow-login-v1");
  assert.equal(code(env()), "OK");
  for (const controllerProtocol of [appliedLegacyLoginControllerProtocol(), "morrow-login-v2", ""])
    assert.equal(
      code(env("development", { controllerProtocol })),
      "API_ENV_CROSS_BINDING_MISMATCH",
      controllerProtocol,
    );
  for (const logoutProtocol of ["morrow-self-logout-v2", "morrow-login-v1", ""])
    assert.equal(
      code(env("staging", { logoutProtocol })),
      "API_ENV_CROSS_BINDING_MISMATCH",
      logoutProtocol,
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

// P05.T01ab-AC07: mapper step 10. Staging and production need LOGIN_CHALLENGE_JSON and
// all three limiters; development may run without either, but a present part must be
// valid and the limiters come all three or none.
const without = (record, ...names) => {
  const copy = { ...record };
  for (const name of names) delete copy[name];
  return copy;
};
const limiterNames = [
  "LOGIN_START_LIMITER",
  "LOGIN_CALLBACK_LIMITER",
  "SIGNUP_LIMITER",
  "SESSION_LIMITER",
];
const limiterKeys = ["loginStart", "loginCallback", "signup", "session"];

test("P05.T01ab-AC07: staging without the guard is API_ENV_ABUSE_GUARD_MISSING", () => {
  const record = env("staging");
  assert.equal(code(record), "OK");
  for (const missing of [["LOGIN_CHALLENGE_JSON"], limiterNames, ...limiterNames.map((n) => [n])])
    assert.equal(code(without(record, ...missing)), "API_ENV_ABUSE_GUARD_MISSING", missing.join());
  assert.equal(
    code(without(record, "LOGIN_CHALLENGE_JSON", ...limiterNames)),
    "API_ENV_ABUSE_GUARD_MISSING",
  );
  const mapped = map(record);
  assert.equal(mapped.ok, true);
  assert.ok(Object.isFrozen(mapped.guard));
  assert.deepEqual(mapped.guard.challenge, {
    schemaVersion: 1,
    provider: "turnstile",
    siteKey,
    actions: { login: "account_login", signup: "organization_signup" },
  });
  assert.deepEqual(Object.keys(mapped.guard.limiters), limiterKeys);
  assert.equal(mapped.guard.limiters.signup, record.SIGNUP_LIMITER);
  assert.equal(mapped.guard.limiters.session, record.SESSION_LIMITER);
});

test("P05.T01ab-AC07: invalid challenge configuration or limiter bindings fail closed", () => {
  const record = env("staging");
  for (const value of [
    "",
    "{}",
    challengeJson({ provider: "recaptcha" }),
    challengeJson({ schemaVersion: 2 }),
    challengeJson({ siteKey: "1x00000000000000000000AA" }),
    challengeJson({ siteKey: "0xshort" }),
    challengeJson({ actions: { login: "same", signup: "same" } }),
    challengeJson({ actions: { login: "account_login" } }),
    challengeJson({ actions: { login: "a b", signup: "organization_signup" } }),
    challengeJson({ extra: true }),
    challengeJson().replace("{", '{"provider":"turnstile",'),
    "x".repeat(2049),
    { value: challengeJson() },
  ])
    assert.equal(
      code({ ...record, LOGIN_CHALLENGE_JSON: value }),
      "API_ENV_ABUSE_GUARD_MISSING",
      String(value).slice(0, 60),
    );
  for (const value of [null, "LIMITER", {}, { limit: "x" }, 1])
    for (const name of ["SIGNUP_LIMITER", "SESSION_LIMITER"])
      assert.equal(code({ ...record, [name]: value }), "API_ENV_ABUSE_GUARD_MISSING", name);
  const getter = env("staging");
  Object.defineProperty(getter, "LOGIN_START_LIMITER", { get: limiter, enumerable: true });
  assert.equal(code(getter), "API_ENV_ABUSE_GUARD_MISSING");
});

test("P05.T01ab-AC07: production never maps; step 7 fails it with or without the guard", () => {
  assert.equal(
    code(without(env("production", { bindingEnvironment: "production" }), "SIGNUP_LIMITER")),
    "API_ENV_CROSS_BINDING_MISMATCH",
  );
  // Production never maps (ADR-0007 item 9); its record still names the guard.
  assert.equal(
    code(env("production", { bindingEnvironment: "staging", retentionTier: "production" })),
    "API_ENV_CROSS_BINDING_MISMATCH",
  );
});

test("P05.T01ab-AC07: step 10 itself needs the whole guard in staging and production", () => {
  // Production fails at step 7 first (ADR-0007 item 9), so step 10's rule for it is
  // tested here directly: it is the staging rule, whatever step 7 later allows.
  for (const environment of ["staging", "production"]) {
    const full = mapAbuseGuard(guard(), environment);
    assert.ok(full && Object.isFrozen(full), environment);
    assert.equal(full.challenge.siteKey, siteKey);
    assert.deepEqual(Object.keys(full.limiters), limiterKeys);
    for (const missing of [
      ["LOGIN_CHALLENGE_JSON"],
      limiterNames,
      ...limiterNames.map((name) => [name]),
      ["LOGIN_CHALLENGE_JSON", ...limiterNames],
    ])
      assert.equal(
        mapAbuseGuard(without(guard(), ...missing), environment),
        null,
        environment + " " + missing.join(),
      );
    assert.equal(mapAbuseGuard({}, environment), null, environment);
  }
  assert.deepEqual(mapAbuseGuard({}, "development"), { challenge: null, limiters: null });
  assert.equal(mapAbuseGuard(without(guard(), "SIGNUP_LIMITER"), "development"), null);
  // The session routes' limiter is no optional extra: without it development's limiters
  // are partial, and staging's and production's guard is missing.
  assert.equal(mapAbuseGuard(without(guard(), "SESSION_LIMITER"), "development"), null);
  for (const environment of ["staging", "production"])
    assert.equal(mapAbuseGuard(without(guard(), "SESSION_LIMITER"), environment), null);
});

test("P05.T01ab-AC07: development maps with no guard, limiters only, or the full guard", () => {
  const plain = map(env());
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.guard, { challenge: null, limiters: null });
  const limited = map({ ...env(), ...without(guard(), "LOGIN_CHALLENGE_JSON") });
  assert.equal(limited.ok, true);
  assert.equal(limited.guard.challenge, null);
  assert.equal(typeof limited.guard.limiters.loginStart.limit, "function");
  const full = map({ ...env(), ...guard() });
  assert.equal(full.ok, true);
  assert.equal(full.guard.challenge.siteKey, siteKey);
  assert.equal(
    code({ ...env(), LOGIN_START_LIMITER: limiter() }),
    "API_ENV_ABUSE_GUARD_MISSING",
    "the limiters come all four or none",
  );
  assert.equal(
    code({ ...env(), LOGIN_CHALLENGE_JSON: challengeJson({ siteKey: "2x" + "0".repeat(22) }) }),
    "API_ENV_ABUSE_GUARD_MISSING",
  );
});

test("P05.T01ab: the Turnstile secret is a credential the api mapper refuses", () => {
  for (const environment of ["development", "staging"])
    assert.equal(
      code({ ...env(environment), TURNSTILE_SECRET_KEY: "0x" + "A".repeat(30) }),
      "API_ENV_FORBIDDEN_CREDENTIAL_BINDING",
    );
});

// P04.T01i PR-D part 1: the committed staging vars, as wrangler resolves them, are what the
// mapper accepts. Until the owner's keyring is placed the api has four of the five values
// and stays on its deny-all instance.
test("P04.T01i PR-D: the committed staging vars map once the keyring is bound", async () => {
  const { vars } = await resolvedEdgeConfig("api", "staging");
  const bound = {
    ...vars,
    BROKER: broker(),
    LOGIN_START_LIMITER: limiter(),
    LOGIN_CALLBACK_LIMITER: limiter(),
    SIGNUP_LIMITER: limiter(),
    SESSION_LIMITER: limiter(),
  };
  assert.equal(code(bound), "API_ENV_PARTIAL");
  const mapped = map({ ...bound, LOGIN_CAPSULE_KEYRING: values("staging").LOGIN_CAPSULE_KEYRING });
  assert.equal(mapped.ok, true, mapped.code);
  assert.equal(mapped.environment, "staging");
  assert.equal(mapped.values.login, vars.LOGIN_CONFIGURATION_JSON);
  assert.equal(mapped.values.binding, vars.MORROW_DATABASE_BINDING_JSON);
  assert.equal(mapped.guard.challenge.siteKey, "0x4AAAAAAFdwF1eDox4vfBd2");
  assert.deepEqual(mapped.guard.challenge.actions, {
    login: "account_login",
    signup: "organization_signup",
  });
  // Without the limiters the staging guard is missing: fail closed.
  const { LOGIN_START_LIMITER: _start, ...unguarded } = bound;
  assert.equal(
    code({ ...unguarded, LOGIN_CAPSULE_KEYRING: values("staging").LOGIN_CAPSULE_KEYRING }),
    "API_ENV_ABUSE_GUARD_MISSING",
  );
  const { SESSION_LIMITER: _session, ...unlimited } = bound;
  assert.equal(
    code({ ...unlimited, LOGIN_CAPSULE_KEYRING: values("staging").LOGIN_CAPSULE_KEYRING }),
    "API_ENV_ABUSE_GUARD_MISSING",
  );
});
