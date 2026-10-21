// A synthetic Shopify for the M2 PR-2 labs (lab:shopify-install, lab:shopify-connect-workers).
// It is shaped from Shopify's documentation, never from a live store: it signs launch and
// callback queries with the app secret (hmac over the sorted, form-encoded parameters),
// answers the authorization-code exchange (a non-expiring offline token, the granted
// scope), the one ShopIdentity Admin GraphQL document, and signs webhook bodies (base64
// HMAC of the raw bytes). Faults are opt-in: a lost exchange, a 5xx, THROTTLED once, an
// oversize reply, a non-development store and another granted scope. Recorded
// development-store fixtures replace or augment it after the owner-approved smoke.
import { createHmac, randomBytes } from "node:crypto";

export const shopifyOracleIdentityDocument =
  "query ShopIdentity { shop { id myshopifyDomain plan { partnerDevelopment } } }";

export function createShopifyOracle({
  secret,
  clientId,
  shop,
  shopId = "987654321",
  now = () => Date.now(),
} = {}) {
  if (typeof secret !== "string" || !/^[a-f0-9]{32}$/.test(clientId ?? "") || !shop)
    throw Error("SHOPIFY_ORACLE_INPUT_INVALID");
  const state = {
    development: true,
    scope: "write_products",
    fault: null,
    codes: new Map(),
    tokens: [],
    calls: [],
  };
  const sign = (values) => {
    const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const message = new URLSearchParams(entries).toString().replace(/\+/g, "%20");
    const hmac = createHmac("sha256", secret).update(message).digest("hex");
    return new URLSearchParams([...entries, ["hmac", hmac]]).toString();
  };
  const timestamp = () => String(Math.trunc(now() / 1000));
  const host = Buffer.from(`admin.shopify.com/store/${shop.split(".")[0]}`).toString("base64url");
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  return {
    state,
    /** Shopify opens the app's application_url with this query. */
    launchQuery(overrides = {}) {
      return sign({ host, shop, timestamp: timestamp(), ...overrides });
    },
    /** Shopify's redirect to the callback after the merchant accepts the scopes. */
    callbackQuery(stateParam, overrides = {}) {
      const code = randomBytes(16).toString("hex");
      state.codes.set(code, { used: false });
      return sign({ code, host, shop, state: stateParam, timestamp: timestamp(), ...overrides });
    },
    webhook(topic, body, overrides = {}) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      return {
        body: raw,
        headers: {
          "x-shopify-api-version": "2026-10",
          "x-shopify-hmac-sha256": createHmac("sha256", overrides.secret ?? secret)
            .update(raw)
            .digest("base64"),
          "x-shopify-shop-domain": overrides.shop ?? shop,
          "x-shopify-topic": topic,
          "x-shopify-webhook-id": overrides.webhookId ?? randomBytes(8).toString("hex"),
        },
      };
    },
    /** The broker's outbound fetch: only this shop's two endpoints answer. */
    async fetch(url, init = {}) {
      const target = new URL(url);
      state.calls.push({ path: target.pathname, host: target.host });
      if (target.host !== shop) return json({ errors: "Not Found" }, 404);
      if (target.pathname === "/admin/oauth/access_token" && init.method === "POST") {
        if (state.fault === "exchange_lost") throw new TypeError("network connection lost");
        if (state.fault === "exchange_500") return json({ errors: "Internal" }, 500);
        const body = JSON.parse(init.body);
        const code = state.codes.get(body.code);
        if (body.client_id !== clientId || body.client_secret !== secret || !code || code.used)
          return json({ error: "invalid_request" }, 400);
        code.used = true;
        const token = "shpat_" + randomBytes(16).toString("hex");
        state.tokens.push(token);
        return json({ access_token: token, scope: state.scope });
      }
      if (target.pathname === "/admin/api/2026-10/graphql.json" && init.method === "POST") {
        const headers = new Headers(init.headers);
        if (!state.tokens.includes(headers.get("x-shopify-access-token") ?? ""))
          return json({ errors: "[API] Invalid API key or access token" }, 401);
        if (JSON.parse(init.body).query !== shopifyOracleIdentityDocument)
          return json({ errors: [{ message: "unexpected document" }] }, 200);
        if (state.fault === "throttled_once") {
          state.fault = null;
          return json({
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: {
              cost: {
                throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
              },
            },
          });
        }
        if (state.fault === "oversize") return new Response("x".repeat(70000), { status: 200 });
        return json({
          data: {
            shop: {
              id: `gid://shopify/Shop/${shopId}`,
              myshopifyDomain: shop,
              plan: { partnerDevelopment: state.development },
            },
          },
          extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1 } },
        });
      }
      return json({ errors: "Not Found" }, 404);
    },
  };
}
