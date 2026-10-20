import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  brokerNeonRoleNames,
  brokerPasswordSecret,
  challengeLimits,
  parseTurnstileConfiguration,
  turnstileHostnameMismatch,
} from "../packages/identity/src/broker-protocol.ts";
import { brokerCapabilities, brokerHealth } from "../apps/broker/src/capabilities.ts";
import {
  brokerChallengeVerify,
  challengePassed,
  siteverifyUrl,
} from "../apps/broker/src/challenge.ts";
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
  // Through the broker the clock is its own, so these stay 20 s inside the window;
  // the exact boundaries are tested on challengePassed below.
  for (const offset of [-310000, 10000]) {
    reply = () =>
      Response.json(verdict({ challenge_ts: new Date(Date.now() + offset).toISOString() }));
    assert.equal(await brokerChallengeVerify(env, actions.login, token(), 3000), "passed");
  }
});

test("P05.T01ab-AC03: the freshness window is 300 s plus 30 s of skew, both boundaries exact", () => {
  assert.equal(challengeLimits.freshnessMs + challengeLimits.skewMs, 330000);
  assert.equal(challengeLimits.skewMs, 30000);
  const now = Date.parse("2026-10-19T12:00:00.000Z");
  const at = (offset) => verdict({ challenge_ts: new Date(now + offset).toISOString() });
  for (const [offset, passed] of [
    [0, true],
    [-330000, true],
    [-330001, false],
    [30000, true],
    [30001, false],
  ])
    assert.equal(challengePassed(at(offset), hostname, actions.login, now), passed, String(offset));
  // An offset timestamp is the same instant.
  assert.equal(
    challengePassed(
      verdict({ challenge_ts: "2026-10-19T13:00:30+01:00" }),
      hostname,
      actions.login,
      now,
    ),
    true,
  );
  for (const change of [
    { hostname: "other.example.test" },
    { action: actions.signup },
    { success: false },
  ])
    assert.equal(challengePassed(verdict(change), hostname, actions.login, now), false);
  assert.equal(challengePassed(at(0), hostname, actions.login, now), true);
});

test("P05.T01ab-AC03: each mismatch is failed, with one fixed morrow_challenge line", async () => {
  const env = await ready(brokerEnv());
  // Timestamps are taken when the stub replies, 60 s outside the window, so a slow
  // host cannot move them inside it (the exact boundaries are tested above).
  const ago = (ms) => () => new Date(Date.now() - ms).toISOString();
  const mismatches = [
    { success: false, "error-codes": ["invalid-input-response"] },
    { success: "true" },
    { success: 1 },
    { hostname: "other.example.test" },
    { hostname: hostname.toUpperCase() },
    { action: actions.signup },
    { action: undefined },
    { challenge_ts: ago(390000) },
    { challenge_ts: ago(-90000) },
    { challenge_ts: "yesterday" },
    { challenge_ts: String(Date.now()) },
    { challenge_ts: undefined },
  ];
  for (const change of mismatches) {
    reset();
    reply = () =>
      Response.json(
        verdict(
          typeof change.challenge_ts === "function"
            ? { challenge_ts: change.challenge_ts() }
            : change,
        ),
      );
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
  const valid = JSON.stringify({ schemaVersion: 1, hostname, actions });
  const padded = (bytes) => valid + " ".repeat(bytes - valid.length);
  for (const configuration of [
    { schemaVersion: 1, hostname: "other.example.test", actions },
    { schemaVersion: 2, hostname, actions },
    { schemaVersion: 1, hostname: "Workspace.Example.Test", actions },
    { schemaVersion: 1, hostname, actions: { login: "same", signup: "same" } },
    { schemaVersion: 1, hostname, actions, extra: 1 },
    // JSON.parse reads these two as the valid configuration; the broker does not.
    `{"schemaVersion":1,"hostname":"other.example.test","hostname":${JSON.stringify(hostname)},` +
      `"actions":${JSON.stringify(actions)}}`,
    padded(1025),
  ]) {
    const text = typeof configuration === "string" ? configuration : JSON.stringify(configuration);
    const env = brokerEnv("development", { TURNSTILE_CONFIGURATION_JSON: text });
    assert.equal((await brokerCapabilities(env)).challenge, null, text.slice(0, 120));
  }
  const boundary = brokerEnv("development", { TURNSTILE_CONFIGURATION_JSON: padded(1024) });
  assert.deepEqual((await brokerCapabilities(boundary)).challenge?.actions, [
    actions.login,
    actions.signup,
  ]);
  const missing = brokerEnv();
  delete missing.TURNSTILE_CONFIGURATION_JSON;
  assert.equal((await brokerCapabilities(missing)).challenge, null);
});

// The one parser the broker and the staging deploy's gate 4 share: a hostname that is not
// the login origin's is the only failure with its own message.
test("P05.T01ab: parseTurnstileConfiguration is strict and names only a hostname mismatch", () => {
  const valid = JSON.stringify({ schemaVersion: 1, hostname, actions });
  assert.deepEqual(parseTurnstileConfiguration(valid, origin), { hostname, actions });
  assert.ok(Object.isFrozen(parseTurnstileConfiguration(valid, origin)));
  for (const loginOrigin of ["https://other.example.test", "not a url", null, undefined, 1])
    assert.throws(() => parseTurnstileConfiguration(valid, loginOrigin), {
      message: turnstileHostnameMismatch,
    });
  for (const json of [
    null,
    "",
    "[]",
    valid + " ".repeat(1025 - valid.length),
    valid.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    JSON.stringify({ schemaVersion: 1, hostname: "Workspace.Example.Test", actions }),
    JSON.stringify({ schemaVersion: 1, hostname, actions: { login: "a" } }),
  ])
    assert.throws(() => parseTurnstileConfiguration(json, origin), {
      message: "BROKER_PROTOCOL_INVALID",
    });
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
    // M2 PR-1 (trust model v1): the fixed line also names the entrypoint.
    {
      event: "morrow_broker",
      entrypoint: "ApiBroker",
      method: "challengeVerify",
      code: "PROVIDER_HELD",
    },
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
  // M2 PR-1: the init line also reports the connector's and the orchestrator's leases and
  // the vault (held here: this environment binds no KEK or vault login).
  assert.deepEqual(events(), [
    {
      event: "morrow_broker_init",
      sessions: true,
      database: true,
      connector: true,
      runtime: true,
      vault: false,
      challenge: true,
    },
  ]);
});
