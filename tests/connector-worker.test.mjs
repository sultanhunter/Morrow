// M2 PR-2: the connector Worker (apps/shopify-connector/worker) with a faked broker and a
// faked database login: the fail-closed environment, the exact route table, the state
// cookie, the authorize redirect, the callback's cookie rule and continuation redirect,
// the webhook contract (M2 PR-3: 200 only once the broker recorded the delivery, the row
// applied after the response and the token destroyed when the applier says so; 401, 400 and
// 503 otherwise), the cron's re-drives, the per-address ingress limits and the fixed pages.
// No network and no database.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  encodeShopifyCredentialResult,
  encodeShopifyInstallResult,
  encodeShopifyLaunchVerdict,
  encodeShopifyWebhookVerdict,
} from "../packages/identity/src/broker-protocol.ts";
import { createConnectorHandler } from "../apps/shopify-connector/worker/connector.ts";
import { mapConnectorEnvironment as mapEnvironment } from "../apps/shopify-connector/worker/environment.ts";
import {
  readStateCookie,
  sameState,
  stateCookie,
  stateCookieClear,
} from "../apps/shopify-connector/worker/oauth-state.ts";
import { connectorPage } from "../apps/shopify-connector/worker/pages.ts";
import { selectConnectorRoute } from "../apps/shopify-connector/worker/routes.ts";
import deployed from "../apps/shopify-connector/worker/index.ts";

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
      if (answers.installThrows) throw new Error("BROKER_HELD");
      return answers.install;
    },
    async shopifyWebhookVerify(appKey, headersJson, body) {
      calls.push(["webhook", appKey, JSON.parse(headersJson), body]);
      if (answers.webhookThrows) throw new Error("BROKER_HELD");
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
  };
  const handler = createConnectorHandler({
    configuration: { origin, apiOrigin },
    broker,
    database,
    ...(limiters === undefined ? {} : { limiters }),
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
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), stateCookieClear);
  }
  assert.deepEqual(ok.calls, []);
  const response = await ok.handler.fetch(
    new Request(origin + "/shopify/a/dev-app/callback?" + query, {
      headers: { cookie: `__Host-morrow_shopify_state=${state}` },
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `${apiOrigin}/w/ws_1/connections#handoff=${token}`,
  );
  assert.equal(response.headers.get("set-cookie"), stateCookieClear);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(ok.calls, [["install", "dev-app", query, sha(state), 9000]]);
  // A duplicate state parameter never matches.
  const twice = harness();
  const dup = await twice.handler.fetch(
    new Request(origin + `/shopify/a/dev-app/callback?state=${state}&state=${state}`, {
      headers: { cookie: `__Host-morrow_shopify_state=${state}` },
    }),
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
  const page = async (answers) => harness(answers).handler.fetch(request());
  const linked = await page({
    install: encodeShopifyInstallResult({
      outcome: "reauthorised",
      workspaceId: "ws_1",
      continuationToken: null,
    }),
  });
  assert.equal(linked.status, 303);
  assert.equal(linked.headers.get("location"), `${apiOrigin}/w/ws_1/connections`);
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
  }
  const held = await page({ installThrows: true });
  assert.equal(held.status, 503);
});

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
      ],
    );
    assert.deepEqual(
      { ...counts },
      { inbox: 2, applied: 1, credentials: 2, destroyed: 2, unavailable: 0 },
    );
    // An unavailable id read still runs the credential re-drive.
    const down = harness({ pendingThrows: true });
    assert.equal((await down.handler.redrive()).unavailable, 1);
    assert.deepEqual(
      down.calls.map((c) => c[0]),
      ["inboxPending", "credentialsPending"],
    );
  } finally {
    console.log = saved;
  }
  assert.deepEqual(logged.filter((row) => row.event === "morrow_connector_redrive").length, 2);
  assert.ok(!JSON.stringify(logged).includes("installation_2"));
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
