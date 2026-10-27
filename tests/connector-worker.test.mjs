// M2 PR-2: the connector Worker (apps/shopify-connector/worker) with a faked broker and a
// faked database login: the fail-closed environment, the exact route table, the state
// cookie, the authorize redirect, the callback's cookie rule and continuation redirect,
// the webhook contract (M2 PR-3: 200 only once the broker recorded the delivery, the row
// applied after the response and the token destroyed when the applier says so; 401, 400 and
// 503 otherwise), the cron's re-drives, the per-address ingress limits and the fixed pages.
// No network and no database.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { mock } from "node:test";
import {
  encodeShopifyConnectionCheck,
  encodeShopifyCredentialResult,
  encodeShopifyInstallResult,
  encodeShopifyLaunchVerdict,
  encodeShopifyWebhookSyncResult,
  encodeShopifyWebhookVerdict,
  shopifyLimits,
  shopifyWebhookSyncLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { shopifyBrokerBudgets } from "../apps/broker/src/shopify-install.ts";
import {
  connectorBudgets,
  createConnectorHandler,
} from "../apps/shopify-connector/worker/connector.ts";
import { mapConnectorEnvironment as mapEnvironment } from "../apps/shopify-connector/worker/environment.ts";
import {
  readStateCookie,
  sameState,
  stateCookie,
  stateCookieClear,
} from "../apps/shopify-connector/worker/oauth-state.ts";
import { connectorPage } from "../apps/shopify-connector/worker/pages.ts";
import { selectConnectorRoute } from "../apps/shopify-connector/worker/routes.ts";
import { loadConnectorEntry } from "./fixtures/connector-entry.mjs";

// fix-connector-cron-latency: the deployed entry imports cloudflare:workers, so it is
// bundled with that module stubbed (tests/connector-cron.test.mjs covers its cron).
const deployed = (await loadConnectorEntry()).default;

const sha = (text) => createHash("sha256").update(text).digest("hex");
const origin = "https://connector.morrow.test";
const apiOrigin = "https://api.morrow.test";
const binding = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-connector-unit",
  branchId: "br-connector-unit",
  hostname: "ep-connector-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const brokerStub = () => ({ fetch() {}, health: async () => true });
// A Workers rate limit: `allow` decides each count; every key is recorded.
const limiterStub = (allow = () => true) => {
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: allow(key) };
    },
  };
};
const goodEnv = (extra = {}) => ({
  MORROW_ENVIRONMENT: "staging",
  CONNECTOR_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, origin, apiOrigin }),
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  BROKER: brokerStub(),
  INSTALL_LIMITER: limiterStub(),
  WEBHOOK_LIMITER: limiterStub(),
  ...extra,
});

// Workers with nodejs_compat_do_not_populate_process_env expose an empty process.env.
function withEmptyProcessEnv(run, processEnv = {}) {
  const saved = process.env;
  process.env = processEnv;
  try {
    return run();
  } finally {
    process.env = saved;
  }
}
const mapConnectorEnvironment = (env, processEnv) =>
  withEmptyProcessEnv(() => mapEnvironment(env), processEnv);

test("environment: every failure is a fixed code and keeps the deny-all instance", () => {
  assert.equal(
    mapConnectorEnvironment(goodEnv(), { LEAKED: "1" }).code,
    "CONNECTOR_ENV_PROCESS_ENV_POPULATED",
  );
  const mapped = mapConnectorEnvironment(goodEnv());
  assert.equal(mapped.ok, true);
  assert.deepEqual(mapped.configuration, { origin, apiOrigin });
  const codes = [
    [null, "CONNECTOR_ENV_RECORD_INVALID"],
    [{ MORROW_ENVIRONMENT: "staging" }, "CONNECTOR_ENV_UNBOUND"],
    [goodEnv({ SHOPIFY_API_SECRET: "x" }), "CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING"],
    [goodEnv({ MORROW_VAULT_KEK_V1: "x" }), "CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING"],
    [goodEnv({ STRIPE_WEBHOOK_SECRET: "x" }), "CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING"],
    [goodEnv({ APP_TOKEN: "x" }), "CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING"],
    [
      goodEnv({ MORROW_DB_PASSWORD_MORROW_CONNECTOR_INGRESS: "x" }),
      "CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING",
    ],
    [goodEnv({ MORROW_ENVIRONMENT: "test" }), "CONNECTOR_ENV_ENVIRONMENT_INVALID"],
    [
      { MORROW_ENVIRONMENT: "staging", CONNECTOR_CONFIGURATION_JSON: "{}" },
      "CONNECTOR_ENV_PARTIAL",
    ],
    [
      goodEnv({
        CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
          schemaVersion: 1,
          origin: "http://c.test",
          apiOrigin,
        }),
      }),
      "CONNECTOR_ENV_VALUE_INVALID",
    ],
    [
      goodEnv({
        CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
          schemaVersion: 1,
          origin,
          apiOrigin: origin,
        }),
      }),
      "CONNECTOR_ENV_VALUE_INVALID",
    ],
    [
      goodEnv({
        CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
          schemaVersion: 1,
          origin: origin + "/x",
          apiOrigin,
        }),
      }),
      "CONNECTOR_ENV_VALUE_INVALID",
    ],
    [
      goodEnv({
        MORROW_DATABASE_BINDING_JSON: JSON.stringify({ ...binding, environment: "development" }),
      }),
      "CONNECTOR_ENV_CROSS_BINDING_MISMATCH",
    ],
    [goodEnv({ MORROW_ENVIRONMENT: "production" }), "CONNECTOR_ENV_CROSS_BINDING_MISMATCH"],
    [
      goodEnv({
        MORROW_ENVIRONMENT: "production",
        MORROW_DATABASE_BINDING_JSON: JSON.stringify({ ...binding, environment: "production" }),
      }),
      "CONNECTOR_ENV_VALUE_INVALID",
    ],
    [goodEnv({ BROKER: {} }), "CONNECTOR_ENV_BROKER_BINDING_INVALID"],
    // The ingress limits: both, each a limiter, outside development.
    [
      (() => {
        const { INSTALL_LIMITER: _a, WEBHOOK_LIMITER: _b, ...rest } = goodEnv();
        return rest;
      })(),
      "CONNECTOR_ENV_LIMITER_INVALID",
    ],
    [
      (() => {
        const { WEBHOOK_LIMITER: _b, ...rest } = goodEnv();
        return rest;
      })(),
      "CONNECTOR_ENV_LIMITER_INVALID",
    ],
    [goodEnv({ INSTALL_LIMITER: {} }), "CONNECTOR_ENV_LIMITER_INVALID"],
    [goodEnv({ WEBHOOK_LIMITER: null }), "CONNECTOR_ENV_LIMITER_INVALID"],
  ];
  for (const [env, code] of codes) {
    const result = mapConnectorEnvironment(env);
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
  }
  // Development (a lab) may omit both limiters, but not one.
  const development = (extra) => {
    const {
      INSTALL_LIMITER: _a,
      WEBHOOK_LIMITER: _b,
      ...rest
    } = goodEnv({
      MORROW_ENVIRONMENT: "development",
      CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
        schemaVersion: 1,
        origin: "http://127.0.0.1:8788",
        apiOrigin: "http://127.0.0.1:8787",
      }),
      MORROW_DATABASE_BINDING_JSON: JSON.stringify({ ...binding, environment: "development" }),
    });
    return { ...rest, ...extra };
  };
  const bare = mapConnectorEnvironment(development({}));
  assert.equal(bare.ok, true);
  assert.equal(bare.limiters, null);
  assert.equal(
    mapConnectorEnvironment(development({ INSTALL_LIMITER: limiterStub() })).code,
    "CONNECTOR_ENV_LIMITER_INVALID",
  );
  assert.equal(Object.isFrozen(mapped.limiters), true);
  assert.deepEqual(Object.keys(mapped.limiters), ["install", "webhooks"]);
});

test("routes: the four exact paths, their methods and bounded signed queries only", () => {
  const route = (url, init = {}) => selectConnectorRoute(new Request(url, init));
  assert.deepEqual(route(origin + "/shopify/a/dev-app/launch?shop=x"), {
    route: "launch",
    appKey: "dev-app",
    rawQuery: "shop=x",
  });
  assert.equal(
    route(origin + "/shopify/a/dev-app/webhooks", { method: "POST", body: "{}" }).route,
    "webhooks",
  );
  for (const [url, init, refused] of [
    [origin + "/shopify/a/dev-app/launch/?shop=x", {}, 404],
    [origin + "/shopify/a/Dev-App/launch?shop=x", {}, 404],
    [origin + "/shopify/a/ab/launch?shop=x", {}, 404],
    [origin + "/shopify/a/dev%2Dapp/launch?shop=x", {}, 404],
    [origin + "/shopify/a/dev-app/install?shop=x", {}, 404],
    [origin + "/", {}, 404],
    [origin + "/shopify/a/dev-app/launch?shop=x", { method: "POST", body: "x" }, 405],
    [origin + "/shopify/a/dev-app/webhooks", {}, 405],
    [origin + "/shopify/a/dev-app/launch", {}, 400],
    [origin + "/shopify/a/dev-app/launch?" + "x".repeat(2049), {}, 400],
    [origin + "/shopify/a/dev-app/webhooks?x=1", { method: "POST", body: "{}" }, 400],
  ])
    assert.equal(route(url, init).refused, refused, url);
});

test("state cookie: __Host-, Secure, HttpOnly, SameSite=Lax, Path=/, ten minutes; exactly one", () => {
  const state = randomBytes(32).toString("base64url");
  assert.equal(
    stateCookie(state),
    `__Host-morrow_shopify_state=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  assert.equal(
    stateCookieClear,
    "__Host-morrow_shopify_state=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  assert.equal(readStateCookie(`a=b; __Host-morrow_shopify_state=${state}`), state);
  assert.equal(
    readStateCookie(`__Host-morrow_shopify_state=${state}; __Host-morrow_shopify_state=${state}`),
    null,
  );
  assert.equal(readStateCookie("__Host-morrow_shopify_state=short"), null);
  assert.equal(readStateCookie(`__Host-morrow_session=${state}`), null);
  assert.equal(readStateCookie(null), null);
  assert.equal(sameState(state, state), true);
  assert.equal(sameState(state, randomBytes(32).toString("base64url")), false);
  assert.throws(() => stateCookie("x"));
});

// A faked broker and database login recording every call.
function harness(answers = {}, limiters = undefined) {
  const calls = [];
  const broker = {
    async shopifyLaunchVerify(appKey, rawQuery) {
      calls.push(["launch", appKey, rawQuery]);
      if (answers.launchDelayMs)
        await new Promise((resolve) => setTimeout(resolve, answers.launchDelayMs));
      return (
        answers.launch ??
        encodeShopifyLaunchVerdict({
          verdict: "verified",
          shop: "dev-1.myshopify.com",
          installation: "none",
          workspaceId: "ws_1",
        })
      );
    },
    async shopifyInstallComplete(appKey, rawQuery, digest, budget) {
      calls.push(["install", appKey, rawQuery, digest, budget]);
      if (answers.installDelayMs)
        await new Promise((resolve) => setTimeout(resolve, answers.installDelayMs));
      if (answers.installThrows) throw new Error("BROKER_HELD");
      return answers.install;
    },
    async shopifyWebhookVerify(appKey, headersJson, body) {
      calls.push(["webhook", appKey, JSON.parse(headersJson), body]);
      if (answers.webhookThrows) throw new Error("BROKER_HELD");
      if (answers.webhookHangs) return new Promise(() => {});
      return (
        answers.webhook ??
        encodeShopifyWebhookVerdict({ verdict: "refused", inboxId: null, settled: null })
      );
    },
    async shopifyCredentialDestroy(installationId, reason) {
      calls.push(["destroy", installationId, reason]);
      if (answers.destroyThrows) throw new Error("BROKER_HELD");
      return encodeShopifyCredentialResult(answers.destroy ?? "destroyed");
    },
    // The shop-specific webhook subscriptions: a budget in, counts out.
    async shopifyWebhookSubscriptionsSync(budgetMs) {
      calls.push(["subscriptions", budgetMs]);
      if (answers.syncThrows) throw new Error("BROKER_HELD");
      if (answers.syncHangs) return new Promise(() => {});
      return (
        answers.sync ??
        encodeShopifyWebhookSyncResult({
          checked: 0,
          registered: 0,
          failed: 0,
          unknown: 0,
          unauthorized: 0,
          skipped: 0,
        })
      );
    },
    // v1 PR 5: the read-back of an installation's granted scopes.
    async shopifyConnectionCheck(installationId, budget) {
      calls.push(["check", installationId, budget]);
      const next = answers.check?.shift?.() ?? "observed";
      if (next === "throw") throw new Error("BROKER_HELD");
      return encodeShopifyConnectionCheck(next);
    },
  };
  const database = {
    async stateOpen(appKey, shop, digest, budget) {
      calls.push(["stateOpen", appKey, shop, digest, budget]);
      return (
        answers.stateOpen ?? {
          outcome: "opened",
          clientId: "c".repeat(32),
          scopes: "read_products,write_products",
        }
      );
    },
    async inboxApply(inboxId, budget) {
      calls.push(["apply", inboxId, budget]);
      const next = answers.apply?.shift?.() ?? answers.applyDefault;
      if (next === "throw" || next === undefined) throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return next;
    },
    async inboxPending(budget) {
      calls.push(["inboxPending", budget]);
      if (answers.pendingThrows) throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return answers.inboxPending ?? [];
    },
    async credentialsPending(budget) {
      calls.push(["credentialsPending", budget]);
      return answers.credentialsPending ?? [];
    },
    async privacyOverdue(budget) {
      calls.push(["privacyOverdue", budget]);
      if (answers.overdueThrows) throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return answers.privacyOverdue ?? { targetMissed: 0, dueMissed: 0 };
    },
    // v1 PR 5 (connection-health-work).
    async healthReconcile(installationId, budget) {
      calls.push(["reconcile", installationId, budget]);
      const next = answers.reconcile?.shift?.();
      if (next === "throw") throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return next ?? { outcome: "reconciled", notice: "unchanged", stopped: 0, newly: 0 };
    },
    async noticesDue(budget) {
      calls.push(["noticesDue", budget]);
      if (answers.noticesThrows) throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return answers.noticesDue ?? [];
    },
    async checksDue(budget) {
      calls.push(["checksDue", budget]);
      return answers.checksDue ?? [];
    },
    async deletionsDue(budget) {
      calls.push(["deletionsDue", budget]);
      return answers.deletionsDue ?? [];
    },
    async deletionApply(installationId, budget) {
      calls.push(["deletion", installationId, budget]);
      const next = answers.deletion?.shift?.();
      if (next === "throw" || next === undefined) throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return next;
    },
    async inboxStuck(budget) {
      calls.push(["inboxStuck", budget]);
      if (answers.stuckThrows) throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return answers.inboxStuck ?? { closed: 0, stuck: 0 };
    },
    // SD3: the inbox's 7-day purge.
    async privacyPurge(budget) {
      calls.push(["privacyPurge", budget]);
      if (answers.purgeThrows) throw new Error("CONNECTOR_SQL_UNAVAILABLE");
      return answers.privacyPurge ?? { purged: 0, held: 0 };
    },
  };
  const handler = createConnectorHandler({
    configuration: { origin, apiOrigin },
    broker,
    database,
    ...(limiters === undefined ? {} : { limiters }),
    ...(answers.cleanup === undefined ? {} : { cleanup: answers.cleanup }),
  });
  return { calls, handler };
}

test("launch: no installation opens one state and redirects to the verified shop's authorize URL", async () => {
  const h = harness();
  const response = await h.handler.fetch(
    new Request(origin + "/shopify/a/dev-app/launch?shop=dev-1.myshopify.com&hmac=x"),
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(
    location.origin + location.pathname,
    "https://dev-1.myshopify.com/admin/oauth/authorize",
  );
  assert.deepEqual(
    [...location.searchParams.keys()],
    ["client_id", "scope", "redirect_uri", "state"],
  );
  assert.equal(location.searchParams.get("client_id"), "c".repeat(32));
  assert.equal(location.searchParams.get("scope"), "read_products,write_products");
  assert.equal(location.searchParams.get("redirect_uri"), origin + "/shopify/a/dev-app/callback");
  assert.ok(!location.searchParams.has("grant_options[]"), "offline: no per-user option");
  const state = location.searchParams.get("state");
  assert.equal(response.headers.get("set-cookie"), stateCookie(state));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ["launch", "stateOpen"],
  );
  assert.deepEqual(h.calls[1].slice(1, 4), ["dev-app", "dev-1.myshopify.com", sha(state)]);
  // The state in the browser is never the stored value: only its digest reaches SQL.
  assert.ok(!JSON.stringify(h.calls).includes(state));
});

test("launch: linked shows status with no OAuth; refused, held and limited stop early", async () => {
  const linked = harness({
    launch: encodeShopifyLaunchVerdict({
      verdict: "verified",
      shop: "dev-1.myshopify.com",
      installation: "linked",
      workspaceId: "ws_1",
    }),
  });
  const page = await linked.handler.fetch(new Request(origin + "/shopify/a/dev-app/launch?shop=x"));
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(`href="${apiOrigin}/w/ws_1/connections"`));
  assert.deepEqual(
    linked.calls.map((c) => c[0]),
    ["launch"],
  );
  assert.equal(page.headers.get("set-cookie"), null);
  const refused = harness({ launch: encodeShopifyLaunchVerdict({ verdict: "refused" }) });
  assert.equal(
    (await refused.handler.fetch(new Request(origin + "/shopify/a/dev-app/launch?shop=x"))).status,
    403,
  );
  assert.deepEqual(
    refused.calls.map((c) => c[0]),
    ["launch"],
  );
  const garbled = harness({ launch: '{"schemaVersion":1,"verdict":"verified"}' });
  assert.equal(
    (await garbled.handler.fetch(new Request(origin + "/shopify/a/dev-app/launch?shop=x"))).status,
    503,
  );
  const limited = harness({ stateOpen: { outcome: "limited" } });
  assert.equal(
    (await limited.handler.fetch(new Request(origin + "/shopify/a/dev-app/launch?shop=x"))).status,
    429,
  );
  const unknown = harness();
  assert.equal(
    (await unknown.handler.fetch(new Request(origin + "/shopify/a/x/launch?shop=x"))).status,
    404,
  );
  assert.deepEqual(unknown.calls, []);
});

test("callback: the cookie must equal the state before any broker call; the redirect carries the fragment", async () => {
  const token = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const query = `code=abc&hmac=x&shop=dev-1.myshopify.com&state=${state}&timestamp=1`;
  const ok = harness({
    install: encodeShopifyInstallResult({
      outcome: "installed",
      workspaceId: "ws_1",
      continuationToken: token,
    }),
  });
  const refusedContext = context();
  for (const cookie of [
    null,
    "",
    `__Host-morrow_shopify_state=${randomBytes(32).toString("base64url")}`,
  ]) {
    const response = await ok.handler.fetch(
      new Request(
        origin + "/shopify/a/dev-app/callback?" + query,
        cookie === null ? {} : { headers: { cookie } },
      ),
      refusedContext.ctx,
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), stateCookieClear);
  }
  assert.deepEqual(ok.calls, []);
  assert.equal(refusedContext.pending.length, 0);
  const c = context();
  const response = await ok.handler.fetch(
    new Request(origin + "/shopify/a/dev-app/callback?" + query, {
      headers: { cookie: `__Host-morrow_shopify_state=${state}` },
    }),
    c.ctx,
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `${apiOrigin}/w/ws_1/connections#handoff=${token}`,
  );
  assert.equal(response.headers.get("set-cookie"), stateCookieClear);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  // The store's shop-specific webhook subscriptions are asked for after the response
  // (waitUntil), with the install's budget, and nothing else.
  assert.equal(c.pending.length, 1);
  await c.settle();
  assert.deepEqual(ok.calls, [
    ["install", "dev-app", query, sha(state), 10000],
    ["subscriptions", connectorBudgets.subscriptionsMs],
  ]);
  // A duplicate state parameter never matches.
  const twice = harness();
  const dup = await twice.handler.fetch(
    new Request(origin + `/shopify/a/dev-app/callback?state=${state}&state=${state}`, {
      headers: { cookie: `__Host-morrow_shopify_state=${state}` },
    }),
    context().ctx,
  );
  assert.equal(dup.status, 403);
  assert.deepEqual(twice.calls, []);
});

test("callback outcomes map to fixed pages; a linked re-authorisation redirects without a fragment", async () => {
  const state = randomBytes(32).toString("base64url");
  const request = () =>
    new Request(origin + `/shopify/a/dev-app/callback?state=${state}&shop=x`, {
      headers: { cookie: `__Host-morrow_shopify_state=${state}` },
    });
  let last;
  const page = async (answers) => {
    last = { ...context(), h: harness(answers) };
    return last.h.handler.fetch(request(), last.ctx);
  };
  const linked = await page({
    install: encodeShopifyInstallResult({
      outcome: "reauthorised",
      workspaceId: "ws_1",
      continuationToken: null,
    }),
  });
  assert.equal(linked.status, 303);
  assert.equal(linked.headers.get("location"), `${apiOrigin}/w/ws_1/connections`);
  // A re-authorisation (a new token version) asks for the subscriptions too.
  await last.settle();
  assert.deepEqual(
    last.h.calls.map((c) => c[0]),
    ["install", "subscriptions"],
  );
  for (const [outcome, status] of [
    ["refused", 403],
    ["state_invalid", 400],
    ["scopes_mismatch", 403],
    ["store_not_development", 403],
    ["exchange_uncertain", 503],
    ["outcome_unknown", 503],
  ]) {
    const response = await page({
      install: encodeShopifyInstallResult({ outcome, workspaceId: null, continuationToken: null }),
    });
    assert.equal(response.status, status, outcome);
    assert.equal(response.headers.get("set-cookie"), stateCookieClear, outcome);
    assert.equal(response.headers.get("location"), null, outcome);
    // Nothing installed: no subscription sync.
    assert.equal(last.pending.length, 0, outcome);
  }
  const held = await page({ installThrows: true });
  assert.equal(held.status, 503);
  assert.equal(last.pending.length, 0);
});

test("callback: the install never waits for or depends on the subscription sync", async () => {
  const state = randomBytes(32).toString("base64url");
  const request = () =>
    new Request(origin + `/shopify/a/dev-app/callback?state=${state}&shop=x`, {
      headers: { cookie: `__Host-morrow_shopify_state=${state}` },
    });
  const install = encodeShopifyInstallResult({
    outcome: "installed",
    workspaceId: "ws_1",
    continuationToken: randomBytes(32).toString("base64url"),
  });
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  try {
    // A sync that never answers: the redirect is already final; the RPC timer gives up
    // after the budget and its slack (mock timers: no real wait), with one fixed line.
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_760_950_000_000 });
    try {
      const c = context();
      const hung = harness({ install, syncHangs: true });
      const response = await hung.handler.fetch(request(), c.ctx);
      assert.equal(response.status, 303);
      assert.equal(c.pending.length, 1);
      await yieldUntil(() => hung.calls.length >= 2, "the subscription sync is called");
      mock.timers.tick(connectorBudgets.subscriptionsMs + connectorBudgets.subscriptionsSlackMs);
      assert.equal(await c.pending[0], null);
    } finally {
      mock.timers.reset();
    }
    // A held broker: the same redirect, one fixed line.
    const c = context();
    const response = await harness({ install, syncThrows: true }).handler.fetch(request(), c.ctx);
    assert.equal(response.status, 303);
    await c.settle();
    // A sync with counts logs them, never an id, shop or token.
    const counted = context();
    await harness({
      install,
      sync: encodeShopifyWebhookSyncResult({
        checked: 3,
        registered: 1,
        failed: 1,
        unknown: 0,
        unauthorized: 0,
        skipped: 1,
      }),
    }).handler.fetch(request(), counted.ctx);
    await counted.settle();
    // A malformed broker answer is unavailable too.
    const garbled = context();
    await harness({ install, sync: '{"schemaVersion":1}' }).handler.fetch(request(), garbled.ctx);
    await garbled.settle();
  } finally {
    console.log = saved;
  }
  // fix-connector-cron-latency: each unavailable line names why and how long it waited:
  // the connector's timer (after the budget and its slack), the broker's refusal, a reply
  // that did not decode.
  // The last three ran on the real clock: their waits are any whole 50 ms step.
  const unavailable = (reason, elapsedMs) => ({
    event: "morrow_connector_webhooks",
    code: "SUBSCRIPTIONS_UNAVAILABLE",
    reason,
    elapsedMs,
  });
  const lines = logged.filter((row) => row.event === "morrow_connector_webhooks");
  for (const line of lines.slice(1))
    if (line.code === "SUBSCRIPTIONS_UNAVAILABLE") {
      assert.ok(Number.isSafeInteger(line.elapsedMs) && line.elapsedMs % 50 === 0);
      line.elapsedMs = 0;
    }
  assert.deepEqual(lines, [
    unavailable(
      "timeout",
      connectorBudgets.subscriptionsMs + connectorBudgets.subscriptionsSlackMs,
    ),
    unavailable("refused", 0),
    {
      event: "morrow_connector_webhooks",
      code: "SUBSCRIPTIONS_SYNCED",
      checked: 3,
      registered: 1,
      failed: 1,
      unknown: 0,
      unauthorized: 0,
      skipped: 1,
    },
    unavailable("invalid", 0),
  ]);
  // Both budgets sit inside the broker's closed range, and the after-response sync inside
  // the platform's 30 seconds of waitUntil after a response.
  for (const budget of [connectorBudgets.subscriptionsMs, connectorBudgets.subscriptionsCronMs])
    assert.ok(
      budget >= shopifyWebhookSyncLimits.budgetMinMs &&
        budget <= shopifyWebhookSyncLimits.budgetMaxMs,
    );
  assert.ok(connectorBudgets.subscriptionsMs + connectorBudgets.subscriptionsSlackMs < 30000);
});

// fix-shopify-install-live: the connector's RPC timers cover the broker's budgets plus a
// cold broker isolate, so a slow but successful broker answer is never "Unavailable" or
// "Not confirmed" (mock timers: no real wait).
test("budgets: the launch and install timers cover the broker's budgets and a cold isolate", async () => {
  assert.ok(connectorBudgets.launchMs >= shopifyBrokerBudgets.launchMs + 1500);
  assert.ok(
    connectorBudgets.installMs >=
      shopifyBrokerBudgets.claimMs + shopifyBrokerBudgets.storeReserveMs + 1000,
  );
  assert.ok(connectorBudgets.installMs <= shopifyLimits.budgetMaxMs);
  assert.ok(connectorBudgets.stateOpenMs >= 5000, "a fresh connection while Neon wakes");
  assert.ok(connectorBudgets.webhookMs > shopifyBrokerBudgets.ingressMs);
  assert.ok(connectorBudgets.webhookMs < 5000, "inside Shopify's webhook timeout");
  const timed = async (answers, request, waitMs) => {
    const h = harness(answers);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = h.handler.fetch(request(), context().ctx);
      await yieldUntil(() => h.calls.length > 0, "the broker is called");
      mock.timers.tick(waitMs);
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      return { response: await pending, calls: h.calls };
    } finally {
      mock.timers.reset();
    }
  };
  const launch = () => new Request(origin + "/shopify/a/dev-app/launch?shop=x");
  // A cold broker isolate (1 s to start) that then spends its whole launch budget still
  // reaches the authorize redirect; past the connector's timer it is "Unavailable".
  const slow = shopifyBrokerBudgets.launchMs + 1000;
  const ok = await timed({ launchDelayMs: slow }, launch, slow);
  assert.equal(ok.response.status, 302);
  assert.deepEqual(
    ok.calls.map((c) => c[0]),
    ["launch", "stateOpen"],
  );
  assert.equal(ok.calls[1][4], connectorBudgets.stateOpenMs);
  const late = await timed(
    { launchDelayMs: connectorBudgets.launchMs + 1 },
    launch,
    connectorBudgets.launchMs + 1,
  );
  assert.equal(late.response.status, 503);
  // The install: the broker's whole budget plus the RPC's hops is still confirmed.
  const state = randomBytes(32).toString("base64url");
  const callbackRequest = () =>
    new Request(origin + `/shopify/a/dev-app/callback?state=${state}&shop=x`, {
      headers: { cookie: `__Host-morrow_shopify_state=${state}` },
    });
  const installed = encodeShopifyInstallResult({
    outcome: "reauthorised",
    workspaceId: "ws_1",
    continuationToken: null,
  });
  const confirmed = await timed(
    { install: installed, installDelayMs: connectorBudgets.installMs + 1000 },
    callbackRequest,
    connectorBudgets.installMs + 1000,
  );
  assert.equal(confirmed.response.status, 303);
  assert.deepEqual(confirmed.calls[0].slice(-1), [connectorBudgets.installMs]);
});

// Yields to the event loop until `ready()` holds. The fake-clock tests tick only once the code
// under test has armed its timers. On a loaded machine its Web Crypto work can take far more
// than a few turns, and ticking early leaves those timers unfired forever: the intermittent
// CI hang that the per-test limit (#85) named on 2026-10-26. A condition never reached fails
// with its name instead of hanging.
const yieldUntil = async (ready, what) => {
  for (let i = 0; i < 100_000 && !ready(); i++) await new Promise(setImmediate);
  assert.ok(ready(), `never reached: ${what}`);
};

// A request context recording what the handler leaves running after its response.
const context = () => {
  const pending = [];
  return {
    pending,
    ctx: { waitUntil: (p) => pending.push(p) },
    settle: () => Promise.all(pending),
  };
};
const inboxId = "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043";
const applied = (overrides = {}) => ({
  outcome: "applied",
  topic: "app/uninstalled",
  installationId: "installation_1",
  credential: "pending",
  reason: "uninstalled",
  ...overrides,
});
test("webhooks: 401 unsigned, 400 invalid, 503 unknown; 200 only once recorded, applied after the response", async () => {
  const body = '{"shop_id":1}';
  const headers = {
    "x-shopify-api-version": "2026-10",
    "x-shopify-hmac-sha256": "x".repeat(43) + "=",
    "x-shopify-shop-domain": "dev-1.myshopify.com",
    "x-shopify-topic": "shop/redact",
    "x-shopify-webhook-id": "id-1",
  };
  const post = (h, ctx = context().ctx, extra = {}) =>
    h.handler.fetch(
      new Request(origin + "/shopify/a/dev-app/webhooks", {
        method: "POST",
        body,
        headers: { ...headers, ...extra },
      }),
      ctx,
    );
  const refused = harness();
  assert.equal((await post(refused)).status, 401);
  assert.deepEqual(refused.calls[0][2], headers);
  assert.equal(refused.calls[0][3], Buffer.from(body).toString("base64"));
  const missing = harness();
  const { ["x-shopify-topic"]: _, ...rest } = headers;
  const response = await missing.handler.fetch(
    new Request(origin + "/shopify/a/dev-app/webhooks", { method: "POST", body, headers: rest }),
    context().ctx,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(missing.calls, []);
  const big = harness();
  assert.equal(
    (
      await big.handler.fetch(
        new Request(origin + "/shopify/a/dev-app/webhooks", {
          method: "POST",
          body: "x".repeat(262145),
          headers,
        }),
        context().ctx,
      )
    ).status,
    401,
  );
  assert.deepEqual(big.calls, []);
  // A Shopify-signed body that is not its topic's: 400, one fixed log line, nothing applied.
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  try {
    const invalid = harness({
      webhook: encodeShopifyWebhookVerdict({ verdict: "invalid", inboxId: null, settled: null }),
    });
    const r = await post(invalid);
    assert.equal(r.status, 400);
    assert.deepEqual(
      invalid.calls.map((c) => c[0]),
      ["webhook"],
    );
    assert.deepEqual(logged, [{ event: "morrow_connector_webhook", code: "WEBHOOK_BODY_INVALID" }]);
  } finally {
    console.log = saved;
  }
  // Not recorded, or not known to be: 503, so Shopify retries (de-duplicated by webhook id).
  const held = harness({ webhookThrows: true });
  assert.equal((await post(held)).status, 503);
  // A record still pending when the webhook budget (connectorBudgets.webhookMs) ends is
  // 503 too, before Shopify's own timeout; nothing is applied (mock timers: no real wait).
  {
    const slow = harness({ webhookHangs: true });
    const c = context();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = post(slow, c.ctx);
      await yieldUntil(() => slow.calls.length > 0, "the webhook is recorded");
      assert.deepEqual(
        slow.calls.map((x) => x[0]),
        ["webhook"],
      );
      mock.timers.tick(connectorBudgets.webhookMs - 1);
      await new Promise(setImmediate);
      mock.timers.tick(1);
      const r = await pending;
      assert.equal(r.status, 503);
      assert.equal(c.pending.length, 0);
    } finally {
      mock.timers.reset();
    }
    assert.ok(connectorBudgets.webhookMs < 5000, "inside Shopify's five-second delivery timeout");
  }
  // Recorded: 200 at once; the row is applied after the response and the installation's
  // token destroyed with the reason its row records.
  const c = context();
  const recorded = harness({
    webhook: encodeShopifyWebhookVerdict({ verdict: "recorded", inboxId, settled: false }),
    apply: [applied()],
  });
  const delivered = await post(recorded, c.ctx);
  assert.equal(delivered.status, 200);
  assert.deepEqual(await delivered.json(), { schemaVersion: 1, received: true });
  assert.equal(c.pending.length, 1);
  await c.settle();
  assert.deepEqual(
    recorded.calls.slice(1).map((x) => x.slice(0, 3)),
    [
      ["apply", inboxId, 6000],
      ["destroy", "installation_1", "uninstalled"],
    ],
  );
  // A redelivery of an unsettled row is applied again; a settled one needs nothing.
  const again = context();
  const unsettled = harness({
    webhook: encodeShopifyWebhookVerdict({ verdict: "duplicate", inboxId, settled: false }),
    apply: [applied({ outcome: "settled", credential: null, reason: null })],
  });
  assert.equal((await post(unsettled, again.ctx)).status, 200);
  await again.settle();
  assert.deepEqual(
    unsettled.calls.map((x) => x[0]),
    ["webhook", "apply"],
  );
  const done = context();
  const settled = harness({
    webhook: encodeShopifyWebhookVerdict({ verdict: "duplicate", inboxId, settled: true }),
  });
  assert.equal((await post(settled, done.ctx)).status, 200);
  assert.equal(done.pending.length, 0);
});

test("apply: shop/redact waits on the token, then completes; failures are the cron's", async () => {
  const run = async (answers) => {
    const c = context();
    const h = harness({
      webhook: encodeShopifyWebhookVerdict({ verdict: "recorded", inboxId, settled: false }),
      ...answers,
    });
    const r = await h.handler.fetch(
      new Request(origin + "/shopify/a/dev-app/webhooks", {
        method: "POST",
        body: "{}",
        headers: {
          "x-shopify-api-version": "2026-10",
          "x-shopify-hmac-sha256": "x".repeat(43) + "=",
          "x-shopify-shop-domain": "dev-1.myshopify.com",
          "x-shopify-topic": "shop/redact",
          "x-shopify-webhook-id": "id-2",
        },
      }),
      c.ctx,
    );
    assert.equal(r.status, 200);
    await c.settle();
    return h.calls.slice(1).map((x) => (x[0] === "apply" ? "apply" : x.slice(0, 3).join(":")));
  };
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  try {
    // shop/redact with the token still live: destroy it, then apply once more to complete.
    assert.deepEqual(
      await run({
        apply: [
          applied({ outcome: "pending", topic: "shop/redact" }),
          applied({ topic: "shop/redact", credential: "destroyed" }),
        ],
      }),
      ["apply", "destroy:installation_1:uninstalled", "apply"],
    );
    // The token is already destroyed: nothing more.
    assert.deepEqual(await run({ apply: [applied({ credential: "destroyed" })] }), ["apply"]);
    // A destruction that fails leaves the redaction pending (the cron's), logged.
    assert.deepEqual(
      await run({
        apply: [applied({ outcome: "pending", topic: "shop/redact" })],
        destroyThrows: true,
      }),
      ["apply", "destroy:installation_1:uninstalled"],
    );
    assert.deepEqual(
      await run({
        apply: [applied({ outcome: "pending", topic: "shop/redact" })],
        destroy: "ineligible",
      }),
      ["apply", "destroy:installation_1:uninstalled"],
    );
    // The applier unavailable: nothing else runs.
    assert.deepEqual(await run({ apply: ["throw"] }), ["apply"]);
  } finally {
    console.log = saved;
  }
  assert.deepEqual(
    logged.map((row) => row.code),
    ["DESTROY_UNAVAILABLE", "DESTROY_INELIGIBLE", "APPLY_UNAVAILABLE"],
  );
});

test("cron: the ids-only re-drives apply received rows, then destroy pending tokens", async () => {
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  try {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const h = harness({
      inboxPending: ids,
      apply: [applied({ credential: "destroyed" }), "throw"],
      credentialsPending: [
        { installationId: "installation_2", reason: "scopes_changed" },
        { installationId: "installation_3", reason: "uninstalled" },
      ],
    });
    const counts = await h.handler.redrive();
    assert.deepEqual(
      h.calls.map((c) => c.slice(0, 3).join(":")),
      [
        "inboxPending:3000",
        "apply:" + ids[0] + ":6000",
        "apply:" + ids[1] + ":6000",
        "credentialsPending:3000",
        "destroy:installation_2:scopes_changed",
        "destroy:installation_3:uninstalled",
        "privacyOverdue:3000",
        // Then the shop-specific webhook subscriptions of every active installation that
        // lacks them, with the cron's budget.
        "subscriptions:" + connectorBudgets.subscriptionsCronMs,
        // v1 PR 5: the open Reconnect items, always; nothing else with the clean-up switch off.
        "noticesDue:3000",
      ],
    );
    assert.deepEqual(
      { ...counts },
      {
        inbox: 2,
        applied: 1,
        credentials: 2,
        destroyed: 2,
        targetMissed: 0,
        dueMissed: 0,
        subscriptionsChecked: 0,
        subscriptionsRegistered: 0,
        unavailable: 0,
        notices: 0,
        reconciled: 0,
        checks: 0,
        observed: 0,
        refused: 0,
        deletions: 0,
        deleted: 0,
        stuckClosed: 0,
        stuck: 0,
        purged: 0,
        held: 0,
      },
    );
    // An unavailable id read still runs the credential re-drive, the deadline check and the
    // subscriptions.
    const down = harness({ pendingThrows: true });
    assert.equal((await down.handler.redrive()).unavailable, 1);
    assert.deepEqual(
      down.calls.map((c) => c[0]),
      ["inboxPending", "credentialsPending", "privacyOverdue", "subscriptions", "noticesDue"],
    );
  } finally {
    console.log = saved;
  }
  assert.deepEqual(logged.filter((row) => row.event === "morrow_connector_redrive").length, 2);
  assert.ok(!JSON.stringify(logged).includes("installation_2"));
  // Nothing overdue logs no privacy line.
  assert.equal(logged.filter((row) => row.event === "morrow_connector_privacy").length, 0);
});

test("cron: open privacy requests past their target or due time log fixed codes (M2 PR-3 review)", async () => {
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  let overdue, partial, failed;
  try {
    overdue = await harness({
      privacyOverdue: { targetMissed: 3, dueMissed: 1 },
    }).handler.redrive();
    partial = await harness({
      privacyOverdue: { targetMissed: 2, dueMissed: 0 },
    }).handler.redrive();
    failed = await harness({ overdueThrows: true }).handler.redrive();
  } finally {
    console.log = saved;
  }
  assert.deepEqual([overdue.targetMissed, overdue.dueMissed, overdue.unavailable], [3, 1, 0]);
  assert.deepEqual([partial.targetMissed, partial.dueMissed], [2, 0]);
  assert.deepEqual([failed.targetMissed, failed.dueMissed, failed.unavailable], [0, 0, 1]);
  assert.deepEqual(
    logged.filter((row) => row.event === "morrow_connector_privacy"),
    [
      { event: "morrow_connector_privacy", code: "PRIVACY_TARGET_MISSED", requests: 3 },
      { event: "morrow_connector_privacy", code: "PRIVACY_DUE_MISSED", requests: 1 },
      { event: "morrow_connector_privacy", code: "PRIVACY_TARGET_MISSED", requests: 2 },
      // fix-connector-cron-latency: the stage fields; this fake's plain error has none.
      {
        event: "morrow_connector_privacy",
        code: "PRIVACY_CHECK_UNAVAILABLE",
        phase: "unknown",
        cause: "unknown",
        statements: null,
        connectMs: null,
        txMs: null,
      },
    ],
  );
});

// v1 PR 5 ("Keep the store connection healthy"; ADR-0025 item 10; ADR-0031 item 3).
test("v1 PR 5 webhooks: a scope change keeps the token; the read-back runs only with the clean-up switch on", async () => {
  const scopes = applied({ topic: "app/scopes_update", credential: "none", reason: null });
  const run = async (answers) => {
    const c = context();
    const h = harness({
      webhook: encodeShopifyWebhookVerdict({ verdict: "recorded", inboxId, settled: false }),
      apply: [scopes],
      ...answers,
    });
    const r = await h.handler.fetch(
      new Request(origin + "/shopify/a/dev-app/webhooks", {
        method: "POST",
        body: '{"id":1,"previous":["write_products"],"current":["read_products"]}',
        headers: {
          "x-shopify-api-version": "2026-10",
          "x-shopify-hmac-sha256": "x".repeat(43) + "=",
          "x-shopify-shop-domain": "dev-1.myshopify.com",
          "x-shopify-topic": "app/scopes_update",
          "x-shopify-webhook-id": "id-scopes",
        },
      }),
      c.ctx,
    );
    assert.equal(r.status, 200);
    await c.settle();
    return h.calls.slice(1).map((x) => x.slice(0, 3).join(":"));
  };
  // Off (the committed default): the applier alone; no token is destroyed, nothing is read.
  assert.deepEqual(await run({}), ["apply:" + inboxId + ":6000"]);
  assert.deepEqual(await run({ cleanup: false }), ["apply:" + inboxId + ":6000"]);
  // On: the broker reads the scopes back, then the reconcile runs from what it recorded.
  assert.deepEqual(await run({ cleanup: true }), [
    "apply:" + inboxId + ":6000",
    "check:installation_1:" + connectorBudgets.checkMs,
    "reconcile:installation_1:" + connectorBudgets.reconcileMs,
  ]);
  // An unclear answer (or a stale token, or none) records nothing and reconciles nothing.
  for (const outcome of ["unavailable", "stale", "not_applicable", "throw"])
    assert.deepEqual(await run({ cleanup: true, check: [outcome] }), [
      "apply:" + inboxId + ":6000",
      "check:installation_1:" + connectorBudgets.checkMs,
    ]);
  // Another topic never asks for a read-back.
  assert.deepEqual(await run({ cleanup: true, apply: [applied({ credential: "destroyed" })] }), [
    "apply:" + inboxId + ":6000",
  ]);
});

test("v1 PR 5 cron: open Reconnect items are reconciled; the switch off runs no read-back, deletion or stuck close", async () => {
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  let counts, h;
  try {
    h = harness({
      noticesDue: ["installation_a", "installation_b"],
      reconcile: [undefined, "throw"],
      checksDue: ["installation_c"],
      deletionsDue: ["installation_d"],
    });
    counts = await h.handler.redrive();
  } finally {
    console.log = saved;
  }
  assert.deepEqual(
    h.calls.map((c) => c.slice(0, 2).join(":")),
    [
      "inboxPending:3000",
      "credentialsPending:3000",
      "privacyOverdue:3000",
      "subscriptions:" + connectorBudgets.subscriptionsCronMs,
      "noticesDue:3000",
      "reconcile:installation_a",
      "reconcile:installation_b",
    ],
  );
  assert.deepEqual(
    [counts.notices, counts.reconciled, counts.checks, counts.deletions],
    [2, 1, 0, 0],
  );
  assert.deepEqual(
    logged.filter((row) => row.event === "morrow_connector_health"),
    // fix-connector-cron-latency: the stage fields; this fake's plain error has none.
    [
      {
        event: "morrow_connector_health",
        code: "RECONCILE_UNAVAILABLE",
        phase: "unknown",
        cause: "unknown",
        statements: null,
        connectMs: null,
        txMs: null,
      },
    ],
  );
  // The item list unavailable is counted; nothing else changes.
  const down = harness({ noticesThrows: true });
  console.log = () => {};
  try {
    assert.equal((await down.handler.redrive()).unavailable, 1);
  } finally {
    console.log = saved;
  }
  assert.ok(!JSON.stringify(logged).includes("installation_"));
});

test("v1 PR 5 cron (switch on): read-backs, then 48-hour deletions that wait for the token, then stuck deliveries", async () => {
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  const deletion = (outcome, credential) => ({
    outcome,
    installationId: ["applied", "pending", "settled"].includes(outcome) ? "installation_d" : null,
    credential: ["applied", "pending", "settled"].includes(outcome) ? credential : null,
    reason: ["applied", "pending", "settled"].includes(outcome) ? "uninstalled" : null,
  });
  let counts, h;
  try {
    h = harness({
      cleanup: true,
      checksDue: ["installation_c1", "installation_c2", "installation_c3"],
      check: ["observed", "token_refused", "unavailable"],
      deletionsDue: ["installation_d", "installation_e", "installation_f"],
      deletion: [
        // d: its token still to destroy, then complete.
        deletion("pending", "pending"),
        deletion("applied", "destroyed"),
        // e: not yet 48 hours (raced), logged with a fixed code.
        deletion("ineligible", null),
        // f: unavailable.
        "throw",
      ],
      inboxStuck: { closed: 1, stuck: 2 },
      privacyPurge: { purged: 7, held: 1 },
    });
    counts = await h.handler.redrive();
  } finally {
    console.log = saved;
  }
  // After the re-drives, the deadline check, the subscription sync and the item list.
  assert.deepEqual(
    h.calls.slice(5).map((c) => c.slice(0, 2).join(":")),
    [
      "checksDue:3000",
      "check:installation_c1",
      "reconcile:installation_c1",
      "check:installation_c2",
      "reconcile:installation_c2",
      "check:installation_c3",
      "deletionsDue:3000",
      "deletion:installation_d",
      "destroy:installation_d",
      "deletion:installation_d",
      "deletion:installation_e",
      "deletion:installation_f",
      "inboxStuck:3000",
      // SD3: the inbox's 7-day purge, last.
      "privacyPurge:3000",
    ],
  );
  assert.equal(h.calls.find((c) => c[0] === "destroy")[2], "uninstalled");
  assert.deepEqual(
    [counts.checks, counts.observed, counts.refused, counts.deletions, counts.deleted],
    [3, 1, 1, 3, 1],
  );
  assert.deepEqual([counts.stuckClosed, counts.stuck], [1, 2]);
  assert.deepEqual([counts.purged, counts.held], [7, 1]);
  assert.deepEqual(
    logged.filter((row) => row.event !== "morrow_connector_redrive").map((row) => row.code),
    [
      "SUBSCRIPTIONS_SYNCED",
      "TOKEN_REFUSED",
      "CHECK_UNAVAILABLE",
      "DELETION_INELIGIBLE",
      "DELETION_UNAVAILABLE",
      "INBOX_STUCK",
      "INBOX_EXPIRED_HELD",
    ],
  );
  assert.equal(logged.find((row) => row.code === "INBOX_STUCK").deliveries, 2);
  assert.equal(logged.find((row) => row.code === "INBOX_EXPIRED_HELD").deliveries, 1);
  // Ids never reach a log line.
  assert.ok(!JSON.stringify(logged).includes("installation_"));
  // A deletion whose token cannot be destroyed now stays pending for the next run.
  const waiting = harness({
    cleanup: true,
    deletionsDue: ["installation_d"],
    deletion: [deletion("pending", "pending")],
    destroyThrows: true,
  });
  console.log = () => {};
  try {
    const run = await waiting.handler.redrive();
    assert.deepEqual([run.deletions, run.deleted], [1, 0]);
  } finally {
    console.log = saved;
  }
  assert.deepEqual(
    waiting.calls.filter((c) => c[0] === "deletion" || c[0] === "destroy").map((c) => c[0]),
    ["deletion", "destroy"],
  );
});

test("v1 PR 5 environment: the clean-up switch is on only for the exact value", () => {
  for (const [value, on] of [
    [undefined, false],
    ["off", false],
    ["ON", false],
    ["on ", false],
    [true, false],
    ["on", true],
  ]) {
    const env = goodEnv(value === undefined ? {} : { MORROW_CONNECTION_CLEANUP: value });
    const mapped = mapConnectorEnvironment(env);
    assert.equal(mapped.ok, true, String(value));
    assert.equal(mapped.cleanup, on, String(value));
  }
});

test("cron: the subscription sync's counts, an unavailable sync, and no sync without its whole budget", async () => {
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  let synced, held;
  try {
    synced = await harness({
      sync: encodeShopifyWebhookSyncResult({
        checked: 2,
        registered: 1,
        failed: 0,
        unknown: 1,
        unauthorized: 0,
        skipped: 0,
      }),
    }).handler.redrive();
    held = await harness({ syncThrows: true }).handler.redrive();
  } finally {
    console.log = saved;
  }
  assert.deepEqual(
    [synced.subscriptionsChecked, synced.subscriptionsRegistered, synced.unavailable],
    [2, 1, 0],
  );
  assert.deepEqual(
    [held.subscriptionsChecked, held.subscriptionsRegistered, held.unavailable],
    [0, 0, 1],
  );
  assert.deepEqual(
    logged.filter((row) => row.event === "morrow_connector_webhooks").map((row) => row.code),
    ["SUBSCRIPTIONS_SYNCED", "SUBSCRIPTIONS_UNAVAILABLE"],
  );
  // A run whose re-drives used its time leaves the sync to the next run: here 45 of the
  // run's 60 seconds pass before the re-drives finish (mock clock), so less than the sync's
  // budget and slack is left.
  mock.timers.enable({ apis: ["Date"], now: 1_760_950_000_000 });
  const quiet = console.log;
  console.log = () => {};
  try {
    const h = harness();
    const run = h.handler.redrive();
    mock.timers.tick(45000);
    const counts = await run;
    assert.equal(counts.subscriptionsChecked, 0);
    assert.equal(counts.unavailable, 0);
    // v1 PR 5's open Reconnect items are still listed after it (its loops stop at the run's
    // deadline, not at the sync's budget).
    assert.deepEqual(
      h.calls.map((c) => c[0]),
      ["inboxPending", "credentialsPending", "privacyOverdue", "noticesDue"],
    );
  } finally {
    console.log = quiet;
    mock.timers.reset();
  }
});

test("ingress limits: counted per address before any broker call; 429 over, 503 without an address", async () => {
  const state = randomBytes(32).toString("base64url");
  const from = (address, init = {}) =>
    address === null
      ? init
      : { ...init, headers: { ...(init.headers ?? {}), "cf-connecting-ip": address } };
  const launchUrl = origin + "/shopify/a/dev-app/launch?shop=dev-1.myshopify.com&hmac=x";
  const webhookInit = {
    method: "POST",
    body: '{"shop_id":1}',
    headers: {
      "x-shopify-api-version": "2026-10",
      "x-shopify-hmac-sha256": "x".repeat(43) + "=",
      "x-shopify-shop-domain": "dev-1.myshopify.com",
      "x-shopify-topic": "shop/redact",
      "x-shopify-webhook-id": "id-1",
    },
  };
  // Allowed: one count per broker-bound request, keyed by route and the hashed address.
  const install = limiterStub();
  const webhooks = limiterStub();
  const open = harness({}, { install, webhooks });
  assert.equal(
    (await open.handler.fetch(new Request(launchUrl, from("198.51.100.7")))).status,
    302,
  );
  assert.equal(install.keys.length, 1);
  assert.match(install.keys[0], /^shopify_install:[a-f0-9]{32}$/);
  assert.ok(!install.keys[0].includes("198.51.100.7"));
  // The callback's cookie refusal reaches nothing and is not counted.
  await open.handler.fetch(
    new Request(origin + `/shopify/a/dev-app/callback?state=${state}`, from("198.51.100.7")),
  );
  assert.equal(install.keys.length, 1);
  await open.handler.fetch(
    new Request(origin + "/shopify/a/dev-app/webhooks", from("203.0.113.9", webhookInit)),
  );
  assert.equal(webhooks.keys.length, 1);
  assert.match(webhooks.keys[0], /^shopify_webhooks:[a-f0-9]{32}$/);
  assert.deepEqual(
    open.calls.map((c) => c[0]),
    ["launch", "stateOpen", "webhook"],
  );
  // Over the limit: 429, and nothing reaches the broker.
  const limited = harness(
    {},
    { install: limiterStub(() => false), webhooks: limiterStub(() => false) },
  );
  const launch = await limited.handler.fetch(new Request(launchUrl, from("198.51.100.7")));
  assert.equal(launch.status, 429);
  const callback = await limited.handler.fetch(
    new Request(
      origin + `/shopify/a/dev-app/callback?state=${state}&shop=x`,
      from("198.51.100.7", { headers: { cookie: `__Host-morrow_shopify_state=${state}` } }),
    ),
  );
  assert.equal(callback.status, 429);
  assert.equal(callback.headers.get("set-cookie"), stateCookieClear);
  const hook = await limited.handler.fetch(
    new Request(origin + "/shopify/a/dev-app/webhooks", from("203.0.113.9", webhookInit)),
  );
  assert.equal(hook.status, 429);
  assert.equal(hook.headers.get("retry-after"), "60");
  assert.deepEqual(await hook.json(), { code: "rate_limited" });
  assert.deepEqual(limited.calls, []);
  // No address, an invalid one or a failing limiter: fail closed (503), nothing sent.
  const logged = [];
  const saved = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  try {
    for (const [address, limiters, code] of [
      [null, { install: limiterStub(), webhooks: limiterStub() }, "ADDRESS_MISSING"],
      ["not-an-address", { install: limiterStub(), webhooks: limiterStub() }, "ADDRESS_INVALID"],
      [
        "198.51.100.7",
        {
          install: {
            limit: async () => {
              throw Error("down");
            },
          },
          webhooks: { limit: async () => ({}) },
        },
        "LIMITER_FAILED",
      ],
    ]) {
      const h = harness({}, limiters);
      assert.equal((await h.handler.fetch(new Request(launchUrl, from(address)))).status, 503);
      const w = await h.handler.fetch(
        new Request(origin + "/shopify/a/dev-app/webhooks", from(address, webhookInit)),
      );
      assert.equal(w.status, 503);
      assert.deepEqual(h.calls, []);
      assert.ok(logged.some((row) => row.event === "morrow_connector_guard" && row.code === code));
    }
  } finally {
    console.log = saved;
  }
  assert.ok(!JSON.stringify(logged).includes("198.51.100.7"));
});

test("pages: no script, style, form or frame; escaped shop; CSP default-src 'none'", async () => {
  const response = connectorPage("connected", {
    shop: "dev-1.myshopify.com",
    link: `${apiOrigin}/w/ws_1/connections`,
  });
  const html = await response.text();
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!/<script|<style|<form|<iframe|<img/i.test(html));
  assert.ok(html.includes("dev-1.myshopify.com"));
  assert.ok(
    !(await connectorPage("connected", { shop: "<x>.myshopify.com" }).text()).includes("<x>"),
  );
});

test("the deployed entry: unconfigured is 503 everywhere and /healthz ready false", async () => {
  const saved = process.env;
  process.env = {};
  try {
    for (const env of [
      {},
      { MORROW_ENVIRONMENT: "staging" },
      { MORROW_ENVIRONMENT: "production", BROKER: brokerStub() },
      goodEnv({ SHOPIFY_API_SECRET: "x" }),
    ]) {
      for (const path of ["/shopify/a/dev-app/launch?shop=x", "/", "/shopify/a/dev-app/webhooks"]) {
        const response = await deployed.fetch(new Request(origin + path), env);
        assert.equal(response.status, 503, path);
      }
      const health = await deployed.fetch(new Request(origin + "/healthz"), env);
      assert.deepEqual(await health.json(), {
        schemaVersion: 1,
        service: "connector",
        ready: false,
      });
    }
    // Configured: ready follows the broker's ConnectorBroker health.
    const configured = goodEnv();
    const health = await deployed.fetch(new Request(origin + "/healthz"), configured);
    assert.deepEqual(await health.json(), { schemaVersion: 1, service: "connector", ready: true });
    const unhealthy = goodEnv({ BROKER: { fetch() {}, health: async () => false } });
    const down = await deployed.fetch(new Request(origin + "/healthz"), unhealthy);
    assert.equal((await down.json()).ready, false);
    assert.equal((await deployed.fetch(new Request(origin + "/x"), configured)).status, 404);
    // M2 PR-3: an unconfigured connector's cron does nothing.
    const scheduled = context();
    await deployed.scheduled({}, { MORROW_ENVIRONMENT: "staging" }, scheduled.ctx);
    assert.equal(scheduled.pending.length, 0);
  } finally {
    process.env = saved;
  }
});
