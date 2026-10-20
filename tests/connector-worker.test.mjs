// M2 PR-2: the connector Worker (apps/shopify-connector/worker) with a faked broker and a
// faked database login: the fail-closed environment, the exact route table, the state
// cookie, the authorize redirect, the callback's cookie rule and continuation redirect,
// the webhook 401/503 contract and the fixed pages. No network and no database.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
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
const goodEnv = (extra = {}) => ({
  MORROW_ENVIRONMENT: "staging",
  CONNECTOR_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, origin, apiOrigin }),
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  BROKER: brokerStub(),
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
  ];
  for (const [env, code] of codes) {
    const result = mapConnectorEnvironment(env);
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
  }
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
function harness(answers = {}) {
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
      return answers.webhook ?? encodeShopifyWebhookVerdict({ verdict: "refused" });
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
  };
  const handler = createConnectorHandler({
    configuration: { origin, apiOrigin },
    broker,
    database,
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

test("webhooks: missing headers or a refused signature are 401; a verified delivery is 503 until PR-3", async () => {
  const body = '{"shop_id":1}';
  const headers = {
    "x-shopify-api-version": "2026-10",
    "x-shopify-hmac-sha256": "x".repeat(43) + "=",
    "x-shopify-shop-domain": "dev-1.myshopify.com",
    "x-shopify-topic": "shop/redact",
    "x-shopify-webhook-id": "id-1",
  };
  const post = (h, extra = {}) =>
    h.handler.fetch(
      new Request(origin + "/shopify/a/dev-app/webhooks", {
        method: "POST",
        body,
        headers: { ...headers, ...extra },
      }),
    );
  const refused = harness();
  assert.equal((await post(refused)).status, 401);
  assert.deepEqual(refused.calls[0][2], headers);
  assert.equal(refused.calls[0][3], Buffer.from(body).toString("base64"));
  const missing = harness();
  const { ["x-shopify-topic"]: _, ...rest } = headers;
  const response = await missing.handler.fetch(
    new Request(origin + "/shopify/a/dev-app/webhooks", { method: "POST", body, headers: rest }),
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
      )
    ).status,
    401,
  );
  assert.deepEqual(big.calls, []);
  const verified = harness({
    webhook: encodeShopifyWebhookVerdict({
      verdict: "verified",
      topic: "shop/redact",
      shopDomain: "dev-1.myshopify.com",
      webhookId: "id-1",
      minimisedBody: { shopId: "1" },
    }),
  });
  const delivered = await post(verified);
  assert.equal(delivered.status, 503);
  assert.deepEqual(await delivered.json(), { code: "webhook_inbox_unavailable" });
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
  } finally {
    process.env = saved;
  }
});
