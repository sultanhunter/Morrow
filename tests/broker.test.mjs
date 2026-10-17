import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  brokerNeonRoleNames,
  brokerPasswordSecret,
  neonLeaseNamespace,
  parseBrokerDatabaseBinding,
  workosSessionNamespace,
} from "../packages/identity/src/broker-protocol.ts";
import { brokerCapabilities, brokerHealth } from "../apps/broker/src/capabilities.ts";
import { brokerNeonLease } from "../apps/broker/src/neon-lease.ts";
import { brokerWorkosSessionPage } from "../apps/broker/src/workos-session.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";
import { appliedLegacyLoginControllerProtocol } from "../scripts/fixtures/standalone-login-fixture.mjs";

// P04.T02a AC10 (prototype), AC11, AC13 (broker side), AC14 and AC29 over the
// broker handlers. Every marker is built at runtime; none is written to disk.
const provider = createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" });
const login = JSON.parse(provider.configurationJson);
const binding = (environment) => ({
  schemaVersion: 1,
  environment,
  projectId: "morrow-broker-unit",
  branchId: "br-broker-unit",
  hostname: "ep-broker-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
});
const marker = (prefix) => prefix + randomBytes(16).toString("hex");
function brokerEnv(environment = "development", change = {}) {
  const passwords = Object.fromEntries(
    brokerNeonRoleNames.map((role) => [role, marker("role-" + role.slice(-6) + "-")]),
  );
  const env = {
    MORROW_ENVIRONMENT: environment,
    LOGIN_CONFIGURATION_JSON: JSON.stringify({
      ...login,
      controllerProtocol: change.controllerProtocol ?? login.controllerProtocol,
      retentionTier: change.retentionTier ?? environment,
    }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding(change.bindingEnvironment ?? environment)),
    WORKOS_API_KEY: change.key ?? marker("sk_test_"),
    ...Object.fromEntries(
      brokerNeonRoleNames.map((role) => [brokerPasswordSecret(role), passwords[role]]),
    ),
  };
  return { env, passwords };
}
// Captured logs and a recording fetch, installed before the port captures fetch.
const logs = [];
const requests = [];
let reply = () =>
  new Response('{"object":"list","data":[]}', { headers: { "content-type": "application/json" } });
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
globalThis.fetch = async (url, init = {}) => {
  requests.push({
    url: String(url),
    method: init.method,
    authorization: new Headers(init.headers).get("authorization"),
  });
  const response = await reply(url, init);
  Object.defineProperty(response, "url", { value: String(url) });
  return response;
};
test.after(() => (console.log = originalLog));
const codes = (method) =>
  logs
    .map((line) => JSON.parse(line))
    .filter((row) => row.event === "morrow_broker" && row.method === method)
    .map((row) => row.code);
async function failure(pending) {
  try {
    await pending;
  } catch (error) {
    assert.equal(error.message, "BROKER_HELD");
    assert.deepEqual(Object.keys(error), []);
    return;
  }
  assert.fail("expected BROKER_HELD");
}
const selector = (subject = "user_" + "B".repeat(26)) =>
  JSON.stringify({ schemaVersion: 1, subjectId: subject, after: null, limit: 100, order: "asc" });

test("AC11: neonLease returns each role's own password for exactly its namespace (7x7)", async () => {
  const { env, passwords } = brokerEnv();
  const parsed = parseBrokerDatabaseBinding(env.MORROW_DATABASE_BINDING_JSON);
  for (const role of brokerNeonRoleNames) {
    const grant = JSON.parse(await brokerNeonLease(env, neonLeaseNamespace(parsed, role)));
    assert.deepEqual(Object.keys(grant), ["schemaVersion", "password"]);
    for (const other of brokerNeonRoleNames)
      assert.equal(grant.password === passwords[other], other === role, role + " vs " + other);
  }
});

test("AC11: neonLease denies other roles, purposes, bindings and encodings", async () => {
  const { env } = brokerEnv();
  const parsed = parseBrokerDatabaseBinding(env.MORROW_DATABASE_BINDING_JSON);
  const valid = neonLeaseNamespace(parsed, "morrow_api");
  const object = JSON.parse(valid);
  const variants = [
    ...[
      "morrow_identity_owner",
      "morrow_identity_lifecycle",
      "morrow_identity_login_maintenance",
      "postgres",
    ].map((role) => JSON.stringify({ ...object, role })),
    JSON.stringify({ ...object, purpose: "primary_and_one_same_role_observer" }),
    ...["environment", "projectId", "branchId", "hostname", "database"].map((key) =>
      JSON.stringify({
        ...object,
        [key]: object[key] === "development" ? "staging" : object[key] + "x",
      }),
    ),
    JSON.stringify(Object.fromEntries(Object.entries(object).reverse())),
    JSON.stringify(object, null, 1),
    valid + " ",
    " ".repeat(1025),
    valid + " ".repeat(1024),
  ];
  logs.length = 0;
  for (const variant of variants) await failure(brokerNeonLease(env, variant));
  for (const value of [undefined, null, 1, {}, [valid], new String(valid)])
    await failure(brokerNeonLease(env, value));
  assert.deepEqual(new Set(codes("neonLease")), new Set(["NAMESPACE_DENIED"]));
  assert.equal(codes("neonLease").length, variants.length + 6);
});

test("AC11/AC13: workosSessionPage makes one keyed GET for its own namespace only", async () => {
  const { env } = brokerEnv();
  const namespace = workosSessionNamespace(env.LOGIN_CONFIGURATION_JSON);
  requests.length = 0;
  logs.length = 0;
  const page = await brokerWorkosSessionPage(env, namespace, selector(), 5000);
  assert.equal(page, '{"object":"list","data":[]}');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(
    requests[0].url,
    "https://api.workos.com/user_management/users/user_" +
      "B".repeat(26) +
      "/sessions?limit=100&order=asc",
  );
  assert.equal(requests[0].authorization, "Bearer " + env.WORKOS_API_KEY);
  await failure(
    brokerWorkosSessionPage(
      env,
      namespace.replace("list_active_sessions", "other"),
      selector(),
      5000,
    ),
  );
  await failure(brokerWorkosSessionPage(env, namespace + " ", selector(), 5000));
  for (const budget of [0, -1, 1.5, 10001, Number.NaN, "5000", undefined])
    await failure(brokerWorkosSessionPage(env, namespace, selector(), budget));
  await failure(brokerWorkosSessionPage(env, namespace, "x".repeat(2049), 5000));
  assert.deepEqual(codes("workosSessionPage"), [
    "NAMESPACE_DENIED",
    "NAMESPACE_DENIED",
    ...Array(7).fill("BUDGET_INVALID"),
    "INPUT_INVALID",
  ]);
  assert.equal(requests.length, 1);
  for (const line of logs) assert.ok(!line.includes(env.WORKOS_API_KEY) && !line.includes("user_"));
});

test("AC13: a provider failure is PROVIDER_HELD after exactly one request, never retried", async () => {
  const { env } = brokerEnv();
  const namespace = workosSessionNamespace(env.LOGIN_CONFIGURATION_JSON);
  for (const make of [
    () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
    () => new Response("{}", { status: 302, headers: { location: "https://api.workos.com/x" } }),
    () => Promise.reject(Error("network")),
    () => new Response(" ".repeat(131073), { headers: { "content-type": "application/json" } }),
  ]) {
    reply = make;
    requests.length = 0;
    logs.length = 0;
    await failure(brokerWorkosSessionPage(env, namespace, selector(), 2000));
    assert.equal(requests.length, 1);
    assert.deepEqual(codes("workosSessionPage"), ["PROVIDER_HELD"]);
  }
  reply = () =>
    new Response('{"object":"list","data":[]}', {
      headers: { "content-type": "application/json" },
    });
});

test("AC14: a key from the wrong tier disables sessions only", async () => {
  for (const [environment, key] of [
    ["development", marker("sk_live_")],
    ["staging", marker("sk_live_")],
    ["development", marker("sk_other_")],
  ]) {
    const { env } = brokerEnv(environment, { key });
    logs.length = 0;
    await failure(
      brokerWorkosSessionPage(
        env,
        workosSessionNamespace(env.LOGIN_CONFIGURATION_JSON),
        selector(),
        1000,
      ),
    );
    assert.deepEqual(codes("workosSessionPage"), ["CAPABILITY_UNAVAILABLE"]);
    assert.equal(await brokerHealth(env), false);
    const parsed = parseBrokerDatabaseBinding(env.MORROW_DATABASE_BINDING_JSON);
    assert.ok(
      JSON.parse(await brokerNeonLease(env, neonLeaseNamespace(parsed, "morrow_api"))).password,
    );
  }
  const production = brokerEnv("production", {
    key: marker("sk_test_"),
    bindingEnvironment: "staging",
  }).env;
  assert.equal(await brokerHealth(production), false);
  const capabilities = await brokerCapabilities(production);
  assert.deepEqual([capabilities.sessions, capabilities.database], [null, null]);
  const ready = brokerEnv("staging").env;
  assert.equal(await brokerHealth(ready), true);
  assert.equal(
    await brokerHealth(brokerEnv("staging", { retentionTier: "development" }).env),
    false,
  );
});

// Migration 0012: the broker parses the login configuration with the same
// parseLoginConfiguration, so a retired or unknown protocol disables sessions only.
test("AC14: a retired or unknown login protocol disables sessions only", async () => {
  assert.equal(login.controllerProtocol, "morrow-login-v1");
  for (const controllerProtocol of [appliedLegacyLoginControllerProtocol(), "morrow-login-v2"]) {
    const { env } = brokerEnv("staging", { controllerProtocol });
    logs.length = 0;
    const sent = requests.length;
    await failure(
      brokerWorkosSessionPage(
        env,
        workosSessionNamespace(env.LOGIN_CONFIGURATION_JSON),
        selector(),
        1000,
      ),
    );
    assert.deepEqual(codes("workosSessionPage"), ["CAPABILITY_UNAVAILABLE"]);
    assert.equal(requests.length, sent);
    assert.equal(await brokerHealth(env), false);
    const capabilities = await brokerCapabilities(env);
    assert.equal(capabilities.sessions, null);
    assert.notEqual(capabilities.database, null);
  }
});

test("AC29: 20 concurrent first calls share one initialisation; a failure stays held", async () => {
  const { env } = brokerEnv();
  logs.length = 0;
  const namespace = neonLeaseNamespace(
    parseBrokerDatabaseBinding(env.MORROW_DATABASE_BINDING_JSON),
    "morrow_api",
  );
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      i % 2 ? brokerHealth(env) : brokerNeonLease(env, namespace),
    ),
  );
  assert.equal(results.length, 20);
  assert.equal(logs.filter((line) => JSON.parse(line).event === "morrow_broker_init").length, 1);
  assert.equal(await brokerCapabilities(env), await brokerCapabilities(env));
  const broken = brokerEnv().env;
  broken.MORROW_DATABASE_BINDING_JSON = "{}";
  assert.equal(await brokerHealth(broken), false);
  broken.MORROW_DATABASE_BINDING_JSON = env.MORROW_DATABASE_BINDING_JSON;
  assert.equal(await brokerHealth(broken), false);
  for (const value of [undefined, null, "env"]) assert.equal(await brokerHealth(value), false);
});

test("AC10: ApiBroker has exactly three prototype methods, arity checks and a 404 default", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-broker-entry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundled = await build({
    entryPoints: ["apps/broker/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    plugins: [
      {
        name: "cloudflare-workers-stub",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "stub",
            namespace: "stub",
          }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents:
              "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
          }));
        },
      },
    ],
  });
  const file = join(directory, "broker.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);
  const module = await import(pathToFileURL(file).href);
  assert.deepEqual(Object.getOwnPropertyNames(module.ApiBroker.prototype).sort(), [
    "constructor",
    "health",
    "neonLease",
    "workosSessionPage",
  ]);
  assert.deepEqual(Object.keys(module.default), ["fetch"]);
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await module.default.fetch(new Request("https://broker.test/x", { method }));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '{"code":"not_found"}');
  }
  const { env } = brokerEnv();
  const entry = new module.ApiBroker({}, env);
  logs.length = 0;
  await failure(entry.health(1));
  await failure(entry.neonLease());
  await failure(entry.neonLease("a", "b"));
  await failure(entry.workosSessionPage("a", "b"));
  assert.deepEqual(
    logs.map((line) => JSON.parse(line).code),
    ["INPUT_INVALID", "INPUT_INVALID", "INPUT_INVALID", "INPUT_INVALID"],
  );
  assert.equal(await entry.health(), true);
});
