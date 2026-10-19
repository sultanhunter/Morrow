import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  brokerNeonRoleNames,
  brokerPasswordSecret,
  challengeLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { brokerCapabilities, brokerHealth } from "../apps/broker/src/capabilities.ts";
import { brokerChallengeVerify, siteverifyUrl } from "../apps/broker/src/challenge.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";

// P05.T01ab-AC03 (and the broker half of AC04 and AC10): challengeVerify against a
// recording fetch. Every secret and token is built at runtime; none is written.
const origin = "https://workspace.example.test";
const hostname = new URL(origin).hostname;
const provider = createPlatformWorkosProviderOracle({ origin });
const login = JSON.parse(provider.configurationJson);
const actions = { login: "account_login", signup: "organization_signup" };
const secret = () => "0x" + randomBytes(24).toString("base64url");
function brokerEnv(environment = "development", change = {}) {
  return {
    MORROW_ENVIRONMENT: environment,
    LOGIN_CONFIGURATION_JSON: JSON.stringify({ ...login, retentionTier: environment }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify({
      schemaVersion: 1,
      environment,
      projectId: "morrow-challenge-unit",
      branchId: "br-challenge-unit",
      hostname: "ep-challenge-unit.c-14.us-east-1.aws.neon.tech",
      database: "morrow",
    }),
    WORKOS_API_KEY: "sk_test_" + randomBytes(16).toString("hex"),
    ...Object.fromEntries(
      brokerNeonRoleNames.map((role) => [
        brokerPasswordSecret(role),
        "role-" + randomBytes(12).toString("hex"),
      ]),
    ),
    TURNSTILE_SECRET_KEY: secret(),
    TURNSTILE_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, hostname, actions }),
    ...change,
  };
}
const token = () => "tok." + randomBytes(48).toString("base64url");
const logs = [];
const requests = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));
const verdict = (change = {}) => ({
  success: true,
  challenge_ts: new Date().toISOString(),
  hostname,
  "error-codes": [],
  action: actions.login,
  cdata: "",
  ...change,
});
let reply = () => Response.json(verdict());
globalThis.fetch = async (url, init = {}) => {
  requests.push({
    url: String(url),
    method: init.method,
    redirect: init.redirect,
    contentType: new Headers(init.headers).get("content-type"),
    body: String(init.body),
    signal: init.signal,
  });
  return reply(url, init);
};
const events = () => logs.map((line) => JSON.parse(line));
const brokerCodes = () =>
  events()
    .filter((row) => row.event === "morrow_broker" && row.method === "challengeVerify")
    .map((row) => row.code);
const challengeLines = () => events().filter((row) => row.event === "morrow_challenge");
async function held(pending) {
  try {
    await pending;
  } catch (error) {
    assert.equal(error.message, "BROKER_HELD");
    assert.deepEqual(Object.keys(error), []);
    return;
  }
  assert.fail("expected BROKER_HELD");
}
const reset = () => {
  logs.length = 0;
  requests.length = 0;
};
// Initialises the broker (its one morrow_broker_init line) before a case counts logs.
const ready = async (env) => {
  await brokerCapabilities(env);
  reset();
  return env;
};

test("P05.T01ab-AC03: passed needs success, the hostname, the action and a fresh challenge_ts", async () => {
  const env = await ready(brokerEnv());
  const supplied = token();
  reply = () => Response.json(verdict());
  assert.equal(await brokerChallengeVerify(env, actions.login, supplied, 3000), "passed");
  assert.equal(requests.length, 1);
  const [sent] = requests;
  assert.equal(sent.url, siteverifyUrl);
  assert.equal(sent.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(sent.method, "POST");
  // workerd refuses redirect:"error"; a 3xx is never followed and is held (below).
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.contentType, "application/x-www-form-urlencoded");
  const form = new URLSearchParams(sent.body);
  assert.deepEqual([...form.keys()], ["secret", "response"]);
  assert.equal(form.get("secret"), env.TURNSTILE_SECRET_KEY);
  assert.equal(form.get("response"), supplied);
  assert.deepEqual(logs, [], "a pass logs nothing");
  reply = () => Response.json(verdict({ action: actions.signup }));
  assert.equal(await brokerChallengeVerify(env, actions.signup, token(), 3000), "passed");
  const now = Date.now();
  for (const at of [now - 329000, now + 29000]) {
    reply = () => Response.json(verdict({ challenge_ts: new Date(at).toISOString() }));
    assert.equal(await brokerChallengeVerify(env, actions.login, token(), 3000), "passed");
  }
});

test("P05.T01ab-AC03: each mismatch is failed, with one fixed morrow_challenge line", async () => {
  const env = await ready(brokerEnv());
  const now = Date.now();
  const mismatches = [
    { success: false, "error-codes": ["invalid-input-response"] },
    { success: "true" },
    { success: 1 },
    { hostname: "other.example.test" },
    { hostname: hostname.toUpperCase() },
    { action: actions.signup },
    { action: undefined },
    { challenge_ts: new Date(now - 331000).toISOString() },
    { challenge_ts: new Date(now + 31000).toISOString() },
    { challenge_ts: "yesterday" },
    { challenge_ts: String(now) },
    { challenge_ts: undefined },
  ];
  for (const change of mismatches) {
    reset();
    reply = () => Response.json(verdict(change));
    assert.equal(
      await brokerChallengeVerify(env, actions.login, token(), 3000),
      "failed",
      JSON.stringify(change),
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(
      logs.map((line) => JSON.parse(line)),
      [{ event: "morrow_challenge", code: "failed" }],
    );
  }
  for (const body of ["[]", "null", '"ok"', "{}"]) {
    reset();
    reply = () => new Response(body, { headers: { "content-type": "application/json" } });
    assert.equal(await brokerChallengeVerify(env, actions.login, token(), 3000), "failed", body);
    assert.equal(challengeLines().length, 1);
  }
});

test("P05.T01ab-AC03: secrets, budgets, tokens and actions outside the rules make no request", async () => {
  for (const value of [
    "1x0000000000000000000000000000000AA",
    "2x0000000000000000000000000000000AB",
    "3x0000000000000000000000000000000FF",
    "0x" + "a".repeat(19),
    "0x" + "a".repeat(129),
    "0x" + "a".repeat(30) + "!",
    "",
  ]) {
    const env = brokerEnv("development", { TURNSTILE_SECRET_KEY: value });
    reset();
    await held(brokerChallengeVerify(env, actions.login, token(), 3000));
    assert.deepEqual(brokerCodes(), ["CAPABILITY_UNAVAILABLE"], value.slice(0, 4));
    assert.equal((await brokerCapabilities(env)).challenge, null);
  }
  const env = await ready(brokerEnv());
  for (const budget of [0, 5001, 1.5, -1, Number.NaN, "5000", undefined, null])
    await held(brokerChallengeVerify(env, actions.login, token(), budget));
  assert.deepEqual(brokerCodes(), Array(8).fill("BUDGET_INVALID"));
  reset();
  for (const value of ["", "a".repeat(2049), "a b", "a,b", "a+b", "a/b", "a=b", "é", 1, null])
    await held(brokerChallengeVerify(env, actions.login, value, 3000));
  for (const action of ["other_action", "", 1, null])
    await held(brokerChallengeVerify(env, action, token(), 3000));
  assert.deepEqual(brokerCodes(), Array(14).fill("INPUT_INVALID"));
  assert.equal(requests.length, 0, "no request for a refused input");
  assert.equal(challengeLimits.budgetMaxMs, 5000);
  reply = () => Response.json(verdict());
  assert.equal(await brokerChallengeVerify(env, actions.login, "a".repeat(2048), 5000), "passed");
  assert.equal(await brokerChallengeVerify(env, actions.login, "a._-Z9", 1), "passed");
});

test("P05.T01ab-AC03: the configured hostname must be the login origin's", async () => {
  for (const configuration of [
    { schemaVersion: 1, hostname: "other.example.test", actions },
    { schemaVersion: 2, hostname, actions },
    { schemaVersion: 1, hostname: "Workspace.Example.Test", actions },
    { schemaVersion: 1, hostname, actions: { login: "same", signup: "same" } },
    { schemaVersion: 1, hostname, actions, extra: 1 },
  ]) {
    const env = brokerEnv("development", {
      TURNSTILE_CONFIGURATION_JSON: JSON.stringify(configuration),
    });
    assert.equal((await brokerCapabilities(env)).challenge, null, JSON.stringify(configuration));
  }
  const missing = brokerEnv();
  delete missing.TURNSTILE_CONFIGURATION_JSON;
  assert.equal((await brokerCapabilities(missing)).challenge, null);
});

test("P05.T01ab-AC04 (broker): status, redirect, size, transport and timeout are held after one request", async () => {
  const env = await ready(brokerEnv());
  const cases = [
    () => new Response("{}", { status: 500 }),
    () => new Response("{}", { status: 400 }),
    () => new Response(null, { status: 302, headers: { location: siteverifyUrl } }),
    () => new Response(null, { status: 307, headers: { location: "https://other.example/" } }),
    () => Promise.reject(Error("network")),
    () => new Response(" ".repeat(4096) + "x", { headers: { "content-type": "application/json" } }),
    () =>
      new Response(JSON.stringify(verdict()), {
        headers: { "content-type": "application/json", "content-length": "5000" },
      }),
    () => new Response("{not json", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0x7b, 0xff, 0x7d])),
    (_url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(Error("aborted"))),
      ),
  ];
  for (const [index, make] of cases.entries()) {
    reset();
    reply = make;
    const started = performance.now();
    await held(brokerChallengeVerify(env, actions.login, token(), 50));
    assert.ok(performance.now() - started < 2000, "budget honoured " + index);
    assert.equal(requests.length, 1, "exactly one request, never retried " + index);
    assert.deepEqual(brokerCodes(), ["PROVIDER_HELD"], String(index));
    assert.equal(challengeLines().length, 0);
  }
  // A body exactly at the limit is read.
  reset();
  const exact = JSON.stringify(verdict());
  reply = () => new Response(exact + " ".repeat(4096 - Buffer.byteLength(exact)));
  assert.equal(await brokerChallengeVerify(env, actions.login, token(), 3000), "passed");
  reply = () => Response.json(verdict());
});

test("P05.T01ab-AC10 (broker): no log line holds the secret, the token or the reply", async () => {
  const env = await ready(brokerEnv());
  const supplied = token();
  reply = () => Response.json(verdict({ success: false, cdata: "marker-cdata" }));
  await brokerChallengeVerify(env, actions.login, supplied, 3000);
  reply = () => Promise.reject(Error(env.TURNSTILE_SECRET_KEY));
  await held(brokerChallengeVerify(env, actions.login, supplied, 3000));
  const text = logs.join("\n");
  for (const value of [env.TURNSTILE_SECRET_KEY, supplied, "marker-cdata", hostname])
    assert.ok(!text.includes(value));
  assert.deepEqual(events(), [
    { event: "morrow_challenge", code: "failed" },
    { event: "morrow_broker", method: "challengeVerify", code: "PROVIDER_HELD" },
  ]);
  reply = () => Response.json(verdict());
});

test("P05.T01ab: hosted health needs the challenge capability; development does not", async () => {
  assert.equal(await brokerHealth(brokerEnv("development")), true);
  const bare = brokerEnv("development");
  delete bare.TURNSTILE_SECRET_KEY;
  assert.equal(await brokerHealth(bare), true);
  assert.equal(await brokerHealth(brokerEnv("staging")), true);
  const hosted = brokerEnv("staging");
  delete hosted.TURNSTILE_SECRET_KEY;
  assert.equal(await brokerHealth(hosted), false);
  reset();
  await brokerCapabilities(brokerEnv("staging"));
  assert.deepEqual(events(), [
    { event: "morrow_broker_init", sessions: true, database: true, challenge: true },
  ]);
});
