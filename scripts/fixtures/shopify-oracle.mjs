// A synthetic Shopify for the M2 labs (lab:shopify-install, lab:shopify-connect-workers,
// lab:shopify-privacy). It is shaped from Shopify's documentation, never from a live store:
// it signs launch and callback queries with the app secret (hmac over the sorted,
// form-encoded parameters), answers the authorization-code exchange (a non-expiring
// offline token, the granted scope), the ShopIdentity Admin GraphQL document and (M2 PR-3)
// the catalogue reads by operation name (CollectionsPage, ProductsPage,
// CollectionProductsPage, ProductContent) from a synthetic catalogue, and signs webhook
// bodies (base64 HMAC of the raw bytes). The shop-specific webhook subscriptions
// (docs/briefs/shopify-shop-specific-webhooks.md): WebhookSubscriptions lists the shop's
// subscriptions of the queried topics (id, topic, uri) and WebhookSubscriptionCreate adds
// one, refusing a second of the same topic and address with userErrors, as Shopify does;
// `state.subscriptions` may be seeded with another app path's subscription. Every GraphQL
// call is recorded with its operation and variables. Faults are opt-in: a lost exchange, a 5xx, THROTTLED once, an oversize
// reply, a non-development store and another granted scope; `extraFields` adds keys no
// document asked for (the broker's minimiser must drop them). Recorded development-store
// fixtures replace or augment it after the owner-approved smoke.
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
    extraFields: false,
    // The shop's webhook subscriptions ({id, topic, uri}); ids count up from 7001.
    subscriptions: [],
    nextSubscriptionId: 7001,
    // The synthetic catalogue: two collections, thirty products (the first five in Summer).
    catalog: {
      collections: [
        { id: "11", title: "Summer" },
        { id: "12", title: "Winter" },
      ],
      products: Array.from({ length: 30 }, (_, i) => ({
        id: String(101 + i),
        title: (i < 5 ? "Summer dress " : "Plain shirt ") + String(i + 1).padStart(2, "0"),
        status: i === 29 ? "DRAFT" : "ACTIVE",
        collection: i < 5 ? "11" : "12",
        descriptionHtml: "<p>Synthetic product " + (i + 1) + "</p>",
        tags: ["lab"],
      })),
    },
  };
  // One page of a list after an opaque cursor ("c" and the last index served).
  const page = (items, first, after, node) => {
    const start =
      after === null || after === undefined ? 0 : Number(/^c([0-9]+)$/.exec(after)?.[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(first) || first < 1 || first > 250)
      return null;
    const slice = items.slice(start, start + first);
    const end = start + slice.length;
    return {
      nodes: slice.map((item) => ({
        ...node(item),
        ...(state.extraFields ? { vendor: "x" } : {}),
      })),
      pageInfo: { hasNextPage: end < items.length, endCursor: slice.length ? "c" + end : null },
    };
  };
  const productNode = (p) => ({
    id: "gid://shopify/Product/" + p.id,
    title: p.title,
    status: p.status,
  });
  // The read documents, by operation name; null for a document this oracle does not serve.
  function readData(operation, v) {
    const { collections, products } = state.catalog;
    switch (operation) {
      case "CollectionsPage":
        return {
          collections: page(collections, v.first, v.after, (c) => ({
            id: "gid://shopify/Collection/" + c.id,
            title: c.title,
          })),
        };
      case "ProductsPage": {
        // Shopify's search syntax as the broker builds it: title:<word>* joined by AND.
        const words =
          v.query === null || v.query === undefined
            ? []
            : String(v.query)
                .split(" AND ")
                .map(
                  (term) => /^title:([A-Za-z0-9]+)\*$/.exec(term)?.[1]?.toLowerCase() ?? "\u0000",
                );
        const matched = products.filter((p) =>
          words.every((w) =>
            p.title
              .toLowerCase()
              .split(" ")
              .some((t) => t.startsWith(w)),
          ),
        );
        return { products: page(matched, v.first, v.after, productNode) };
      }
      case "CollectionProductsPage": {
        const id = /^gid:\/\/shopify\/Collection\/([0-9]+)$/.exec(v.id ?? "")?.[1];
        if (!collections.some((c) => c.id === id)) return { collection: null };
        return {
          collection: {
            products: page(
              products.filter((p) => p.collection === id),
              v.first,
              v.after,
              productNode,
            ),
          },
        };
      }
      case "WebhookSubscriptions": {
        // The broker's fixed list: both app topics, no variables, one page of 25.
        const topics = ["APP_UNINSTALLED", "APP_SCOPES_UPDATE"];
        const nodes = state.subscriptions.filter((w) => topics.includes(w.topic));
        return {
          webhookSubscriptions: {
            nodes: nodes.slice(0, 25).map((w) => ({
              id: "gid://shopify/WebhookSubscription/" + w.id,
              topic: w.topic,
              uri: w.uri,
            })),
            pageInfo: { hasNextPage: nodes.length > 25 },
          },
        };
      }
      case "WebhookSubscriptionCreate": {
        const topic = v.topic;
        const uri = v.uri;
        if (
          !["APP_UNINSTALLED", "APP_SCOPES_UPDATE"].includes(topic) ||
          typeof uri !== "string" ||
          !/^https:\/\//.test(uri)
        )
          return {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [{ field: ["webhookSubscription", "uri"], message: "Invalid" }],
            },
          };
        if (state.subscriptions.some((w) => w.topic === topic && w.uri === uri))
          return {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [
                {
                  field: ["webhookSubscription", "uri"],
                  message: "Address for this topic has already been taken",
                },
              ],
            },
          };
        const created = { id: String(state.nextSubscriptionId++), topic, uri };
        state.subscriptions.push(created);
        return {
          webhookSubscriptionCreate: {
            webhookSubscription: {
              id: "gid://shopify/WebhookSubscription/" + created.id,
              topic,
              uri,
            },
            userErrors: [],
          },
        };
      }
      case "ProductContent": {
        const id = /^gid:\/\/shopify\/Product\/([0-9]+)$/.exec(v.id ?? "")?.[1];
        const p = products.find((x) => x.id === id);
        return {
          product: p
            ? {
                id: "gid://shopify/Product/" + p.id,
                title: p.title,
                descriptionHtml: p.descriptionHtml,
                tags: p.tags,
                seo: { title: null, description: null },
              }
            : null,
        };
      }
      default:
        return null;
    }
  }
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
      const call = { path: target.pathname, host: target.host };
      state.calls.push(call);
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
        const request = JSON.parse(init.body);
        call.operation = /^(?:query|mutation) ([A-Za-z]+)/.exec(request.query ?? "")?.[1] ?? null;
        call.variables = request.variables ?? null;
        const identity = request.query === shopifyOracleIdentityDocument;
        const data = identity ? null : readData(call.operation, request.variables ?? {});
        if (!identity && data === null)
          return json({ errors: [{ message: "unexpected document" }] }, 200);
        if (state.fault === "throttled_once") {
          state.fault = null;
          // Shopify's THROTTLED reply names the query's requested cost (a page of 25 costs
          // 27, a collection's page 28, an object read 2) and the bucket's state.
          const requestedQueryCost =
            { CollectionsPage: 27, ProductsPage: 27, CollectionProductsPage: 28 }[call.operation] ??
            2;
          return json({
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: {
              cost: {
                requestedQueryCost,
                throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
              },
            },
          });
        }
        if (state.fault === "oversize") return new Response("x".repeat(70000), { status: 200 });
        if (!identity)
          return json({
            data,
            extensions: { cost: { requestedQueryCost: 3, actualQueryCost: 3 } },
          });
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
