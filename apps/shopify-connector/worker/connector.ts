// The connector's request handler (M2 PR-2; ADR-0022 items 4-6; ADR-0008 items 2 and 5;
// mvp-architecture §2 step 4). It serves only launch, callback, status and webhooks; it
// is never a workspace session and authorizes nothing (invariant 23): it forwards raw
// Shopify requests to the broker, stores one state digest through its own login, and sends
// the merchant to the api origin. The workspace always comes from the broker's registry
// read, never from shop, host or a query value.
//   launch    the broker verifies the query HMAC and the shop against the registry. A linked
//             installation shows status with no OAuth. Otherwise one state is opened (its
//             digest only) and the browser goes to Shopify's authorize URL for the verified
//             shop with the exact redirect_uri, the fixed scopes and no per-user option
//             (an offline token), holding the state in a __Host- cookie on this host.
//   callback  the cookie must equal the query's state before any broker call; the broker
//             claims it, verifies, exchanges, reads and stores. The merchant then lands on
//             the api's connections screen with the continuation token in the fragment
//             (#handoff=..., never sent to any server); the cookie is always cleared.
//   status    a Shopify-signed GET: a status page with no workspace data.
//   webhooks  see webhooks.ts.
import {
  decodeShopifyInstallResult,
  decodeShopifyLaunchVerdict,
  decodeShopifyWebhookVerdict,
  type ConnectorBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";
import type { ConnectorConfiguration } from "./environment.js";
import type { ConnectorDatabase } from "./database.js";
import {
  newOAuthState,
  oauthStateDigest,
  readStateCookie,
  sameState,
  stateCookie,
  stateCookieClear,
} from "./oauth-state.js";
import { connectionsUrl, connectorJson, connectorPage } from "./pages.js";
import { selectConnectorRoute } from "./routes.js";
import { readWebhook } from "./webhooks.js";

export interface ConnectorDependencies {
  readonly configuration: Readonly<ConnectorConfiguration>;
  readonly broker: Pick<
    ConnectorBrokerRpc,
    "shopifyLaunchVerify" | "shopifyInstallComplete" | "shopifyWebhookVerify"
  >;
  readonly database: ConnectorDatabase;
}
// RPC and SQL budgets inside the platform's request time.
export const connectorBudgets = Object.freeze({
  launchMs: 4000,
  stateOpenMs: 3000,
  installMs: 9000,
  webhookMs: 4000,
});
const held = () => Error("CONNECTOR_BROKER_HELD");

// One RPC raced against a timer; a late reply is discarded and nothing is retried.
async function rpc<T>(start: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(held()), ms);
  });
  void stopped.catch(() => {});
  try {
    const pending = Promise.resolve().then(start);
    void pending.catch(() => {});
    return await Promise.race([pending, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createConnectorHandler(deps: Readonly<ConnectorDependencies>) {
  const { configuration, broker, database } = deps;
  const redirectUri = (appKey: string) => `${configuration.origin}/shopify/a/${appKey}/callback`;

  async function launch(appKey: string, rawQuery: string, statusOnly: boolean): Promise<Response> {
    let verdict;
    try {
      verdict = decodeShopifyLaunchVerdict(
        await rpc(() => broker.shopifyLaunchVerify(appKey, rawQuery), connectorBudgets.launchMs),
      );
    } catch {
      return connectorPage("unavailable");
    }
    if (verdict.verdict !== "verified") return connectorPage("invalid");
    const link = connectionsUrl(configuration.apiOrigin, verdict.workspaceId);
    if (verdict.installation === "linked")
      return connectorPage("connected", { shop: verdict.shop, link });
    if (verdict.installation === "suspended" || verdict.installation === "uninstalled")
      return connectorPage("ineligible", { shop: verdict.shop });
    if (statusOnly)
      return verdict.installation === "unlinked"
        ? connectorPage("installed_unlinked", { shop: verdict.shop, link })
        : connectorPage("invalid");
    const state = newOAuthState();
    let opened;
    try {
      opened = await database.stateOpen(
        appKey,
        verdict.shop,
        await oauthStateDigest(state),
        connectorBudgets.stateOpenMs,
      );
    } catch {
      return connectorPage("unavailable");
    }
    if (opened.outcome === "limited") return connectorPage("limited");
    if (opened.outcome !== "opened") return connectorPage("invalid");
    const authorize = new URL(`https://${verdict.shop}/admin/oauth/authorize`);
    authorize.search = new URLSearchParams([
      ["client_id", opened.clientId],
      ["scope", opened.scopes],
      ["redirect_uri", redirectUri(appKey)],
      ["state", state],
    ]).toString();
    const headers = new Headers({
      location: authorize.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    headers.append("set-cookie", stateCookie(state));
    return new Response(null, { status: 302, headers });
  }

  async function callback(request: Request, appKey: string, rawQuery: string): Promise<Response> {
    const cookie = readStateCookie(request.headers.get("cookie"));
    let queryState: string | null = null;
    try {
      const states = new URLSearchParams(rawQuery).getAll("state");
      queryState = states.length === 1 ? states[0]! : null;
    } catch {
      queryState = null;
    }
    // No cookie, or a state that is not this browser's: nothing reaches the broker.
    if (!cookie || queryState === null || !sameState(cookie, queryState))
      return connectorPage("invalid", { setCookie: stateCookieClear });
    // The digest of the cookie's state, which equals the query's; the broker rechecks it.
    const digest = await oauthStateDigest(cookie);
    let installed;
    try {
      installed = decodeShopifyInstallResult(
        await rpc(
          () => broker.shopifyInstallComplete(appKey, rawQuery, digest, connectorBudgets.installMs),
          connectorBudgets.installMs + 500,
        ),
      );
    } catch {
      return connectorPage("uncertain", { setCookie: stateCookieClear });
    }
    switch (installed.outcome) {
      case "installed":
      case "reauthorised": {
        const location = connectionsUrl(
          configuration.apiOrigin,
          installed.workspaceId!,
          installed.continuationToken ?? undefined,
        );
        const headers = new Headers({
          location,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        headers.append("set-cookie", stateCookieClear);
        return new Response(null, { status: 303, headers });
      }
      case "state_invalid":
        return connectorPage("expired", { setCookie: stateCookieClear });
      case "store_not_development":
        return connectorPage("not_development", { setCookie: stateCookieClear });
      case "scopes_mismatch":
        return connectorPage("scopes_mismatch", { setCookie: stateCookieClear });
      case "exchange_uncertain":
      case "outcome_unknown":
        return connectorPage("uncertain", { setCookie: stateCookieClear });
      default:
        return connectorPage("invalid", { setCookie: stateCookieClear });
    }
  }

  async function webhooks(request: Request, appKey: string): Promise<Response> {
    const input = await readWebhook(request);
    if (!input) return connectorJson(401, { code: "unauthorized" });
    let verdict;
    try {
      verdict = decodeShopifyWebhookVerdict(
        await rpc(
          () => broker.shopifyWebhookVerify(appKey, input.headersJson, input.rawBodyBase64),
          connectorBudgets.webhookMs,
        ),
      );
    } catch {
      return connectorJson(503, { code: "unavailable" });
    }
    if (verdict.verdict !== "verified") return connectorJson(401, { code: "unauthorized" });
    // M2 PR-3 adds the durable inbox; until then Shopify retries a verified delivery.
    return connectorJson(503, { code: "webhook_inbox_unavailable" });
  }

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const selected = selectConnectorRoute(request);
      if ("refused" in selected)
        return connectorJson(selected.refused, {
          code:
            selected.refused === 404
              ? "not_found"
              : selected.refused === 405
                ? "method_not_allowed"
                : "invalid_request",
        });
      if (selected.route === "webhooks") return webhooks(request, selected.appKey);
      if (selected.route === "callback")
        return callback(request, selected.appKey, selected.rawQuery);
      return launch(selected.appKey, selected.rawQuery, selected.route === "status");
    },
  });
}
