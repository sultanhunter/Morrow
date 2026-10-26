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
//   webhooks  see webhooks.ts. M2 PR-3: the broker verifies the signature and records the
//             delivery in the inbox in one vault transaction; the connector answers 200
//             only once that row exists (an unknown outcome is 503, and Shopify's retry
//             finds the row by its webhook id), then applies the row after the response
//             (waitUntil) through its own login's applier (connector_inbox_apply), and asks
//             the broker to destroy the installation's token when the applier says so.
//   cron      (M2 PR-3; review finding B8) every five minutes, the ids-only re-drives:
//             inbox rows still received two minutes after they arrived are applied again,
//             and every installation whose token's destruction is not yet recorded is
//             destroyed again. The inbox row is the queue: no Queue resource exists. Then
//             (M2 PR-3 review) the count of open privacy requests past their target or
//             their 30-day due time, logged as PRIVACY_TARGET_MISSED / PRIVACY_DUE_MISSED.
//             Then the shop-specific webhook subscriptions (below). The run happens inside
//             the ConnectorCron Durable Object, beside the database (worker/cron.ts;
//             fix-connector-cron-latency), so its transactions and RPCs keep their budgets.
//   subscriptions  Shopify CLI 4.9 admits no app-specific app/uninstalled or
//             app/scopes_update subscription under the legacy install flow, so the broker
//             registers both for each active installation as shop-specific subscriptions to
//             this connector's webhook path (docs/briefs/shopify-shop-specific-webhooks.md).
//             The connector only asks, with a budget: after an install or re-authorisation
//             (waitUntil, after the redirect: the install never waits for it or depends on
//             it) and from the cron, which catches every installation that still lacks them
//             (installed before this existed, or a failed or unknown attempt). Counts only
//             come back; one fixed-code morrow_connector_webhooks line per sync.
// Ingress limits (M2 PR-2 review, layer 1 of apps/broker/src/shopify-install.ts; ADR-0019
// items 6 and 8 applied to the second public Worker): every request that would reach the
// broker is first counted per client address (CF-Connecting-IP, the api's P05.T01ab key),
// launch, status and callback against INSTALL_LIMITER (20 a minute) and webhooks against
// WEBHOOK_LIMITER (300 a minute: Shopify's delivery addresses carry every store's
// webhooks), so one address cannot keep the broker's vault login busy. Workers rate limits
// count per Cloudflare location. Refusals that reach nothing (the route table, the
// callback's cookie rule) are not counted. Over the limit is 429; a missing or invalid
// address or a failed limiter fails closed (503) with one fixed-code
// morrow_connector_guard line.
import {
  decodeShopifyCredentialResult,
  decodeShopifyInstallResult,
  decodeShopifyLaunchVerdict,
  decodeShopifyWebhookSyncResult,
  decodeShopifyWebhookVerdict,
  type ConnectorBrokerRpc,
  type ShopifyCredentialReason,
} from "../../../packages/identity/src/broker-protocol.js";
import { limitAddress } from "../../../packages/identity/src/edge-limiter.js";
import type { ConnectorConfiguration, ConnectorLimiters } from "./environment.js";
import {
  connectorSqlObservation,
  connectorTransactionCauses,
  connectorTransactionPhases,
  type ConnectorDatabase,
} from "./database.js";
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
    | "shopifyLaunchVerify"
    | "shopifyInstallComplete"
    | "shopifyWebhookVerify"
    | "shopifyCredentialDestroy"
    | "shopifyWebhookSubscriptionsSync"
  >;
  readonly database: ConnectorDatabase;
  /** The ingress limits; null or absent only in development (a lab without them). */
  readonly limiters?: Readonly<ConnectorLimiters> | null;
}
// RPC and SQL budgets inside the platform's request time. The install RPC's own timer
// adds installSlackMs to the broker's budget: the broker returns by its deadline (its last
// transaction's close never waits past it), and the slack covers the RPC's two hops, so a
// committed install is not reported as "Not confirmed".
// fix-shopify-install-live: the launch RPC's timer is the broker's launch budget
// (shopifyBrokerBudgets.launchMs, 5 s) plus 1.5 s for a cold broker isolate's start and
// the RPC's hops; the state's own transaction and the install get the same headroom for a
// Neon compute waking from suspend. The staging connector runs in Neon's region (its
// wrangler.jsonc placement), where each of these takes well under a second;
// tests/connector-worker.test.mjs ties these numbers to the broker's.
export const connectorBudgets = Object.freeze({
  launchMs: 6500,
  stateOpenMs: 5000,
  installMs: 10000,
  installSlackMs: 1500,
  webhookMs: 4000,
  // M2 PR-3: one inbox row's applier transaction, the token's destruction, a re-drive's id
  // read (and the privacy deadline check), and the whole cron run (its last apply starts
  // before this much has passed).
  applyMs: 6000,
  destroyMs: 4000,
  pendingMs: 3000,
  redriveMs: 60000,
  // The shop-specific webhook subscriptions: the broker's budget after an install and from
  // the cron (within shopifyWebhookSyncLimits), and the RPC timer's slack over it.
  subscriptionsMs: 15000,
  subscriptionsCronMs: 20000,
  subscriptionsSlackMs: 2000,
});
/** A request's context: the response may return before work handed to waitUntil ends. */
export type ConnectorContext = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
const log = (event: string, value: Record<string, string | number | null>) =>
  console.log(JSON.stringify({ event, ...value }));
// fix-connector-cron-latency: why a broker RPC did not give an answer: the connector's timer
// fired first ("timeout"), the broker refused or failed ("refused": its own line names the
// method), or the reply did not decode ("invalid").
class BrokerRpcFailure extends Error {
  readonly reason: "timeout" | "refused";
  constructor(reason: "timeout" | "refused") {
    super("CONNECTOR_BROKER_HELD");
    this.reason = reason;
  }
}

// One RPC raced against a timer; a late reply is discarded and nothing is retried.
async function rpc<T>(start: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrokerRpcFailure("timeout")), ms);
  });
  void stopped.catch(() => {});
  try {
    const pending = Promise.resolve()
      .then(start)
      .catch(() => {
        throw new BrokerRpcFailure("refused");
      });
    void pending.catch(() => {});
    return await Promise.race([pending, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// fix-connector-cron-latency: the stage of a failed step, on its fixed-code line. Closed
// values only, and durations floored to 50 ms (at most 20 s): never a text, an id or a
// value. A database step names where its transaction ended (connectorSqlObservation); a
// broker RPC names its reason and how long it waited.
const stageMs = (ms: number | null, capMs = 20000) =>
  ms === null || !Number.isFinite(ms) ? null : Math.min(capMs, Math.max(0, ms - (ms % 50)));
function sqlStage(error: unknown): Record<string, string | number | null> {
  const seen = connectorSqlObservation(error);
  if (!seen)
    return { phase: "unknown", cause: "unknown", statements: null, connectMs: null, txMs: null };
  return {
    phase: (connectorTransactionPhases as readonly string[]).includes(seen.phase)
      ? seen.phase
      : "unknown",
    cause: (connectorTransactionCauses as readonly string[]).includes(seen.cause)
      ? seen.cause
      : "unknown",
    statements: Number.isSafeInteger(seen.statements) ? Math.min(seen.statements, 20) : null,
    connectMs: stageMs(seen.connectMs),
    txMs: stageMs(seen.txMs),
  };
}
const rpcStage = (error: unknown, startedAt: number): Record<string, string | number | null> => ({
  reason: error instanceof BrokerRpcFailure ? error.reason : "invalid",
  elapsedMs: stageMs(Date.now() - startedAt),
});

export function createConnectorHandler(deps: Readonly<ConnectorDependencies>) {
  const { configuration, broker, database } = deps;
  const limiters = deps.limiters ?? null;
  const redirectUri = (appKey: string) => `${configuration.origin}/shopify/a/${appKey}/callback`;

  // One count for this request's address; "allowed" when no limiter is bound (development).
  async function admit(
    request: Request,
    kind: keyof ConnectorLimiters,
  ): Promise<"allowed" | "limited" | "unavailable"> {
    if (!limiters) return "allowed";
    const limit = await limitAddress(
      limiters[kind],
      kind === "install" ? "shopify_install" : "shopify_webhooks",
      request.headers.get("cf-connecting-ip"),
    );
    if (limit === "allowed" || limit === "limited") return limit;
    console.log(
      JSON.stringify({
        event: "morrow_connector_guard",
        code:
          limit === "address_missing"
            ? "ADDRESS_MISSING"
            : limit === "address_invalid"
              ? "ADDRESS_INVALID"
              : "LIMITER_FAILED",
      }),
    );
    return "unavailable";
  }

  async function launch(
    request: Request,
    appKey: string,
    rawQuery: string,
    statusOnly: boolean,
  ): Promise<Response> {
    const admitted = await admit(request, "install");
    if (admitted !== "allowed")
      return connectorPage(admitted === "limited" ? "limited" : "unavailable");
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

  // The shop-specific webhook subscriptions: one broker sync with this budget. Never throws;
  // one fixed-code line with the counts, or SUBSCRIPTIONS_UNAVAILABLE with its stage.
  async function subscriptions(budgetMs: number) {
    const startedAt = Date.now();
    try {
      const result = decodeShopifyWebhookSyncResult(
        await rpc(
          () => broker.shopifyWebhookSubscriptionsSync(budgetMs),
          budgetMs + connectorBudgets.subscriptionsSlackMs,
        ),
      );
      log("morrow_connector_webhooks", { code: "SUBSCRIPTIONS_SYNCED", ...result });
      return result;
    } catch (error) {
      log("morrow_connector_webhooks", {
        code: "SUBSCRIPTIONS_UNAVAILABLE",
        ...rpcStage(error, startedAt),
      });
      return null;
    }
  }

  async function callback(
    request: Request,
    appKey: string,
    rawQuery: string,
    ctx: ConnectorContext,
  ): Promise<Response> {
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
    const admitted = await admit(request, "install");
    if (admitted !== "allowed")
      return connectorPage(admitted === "limited" ? "limited" : "unavailable", {
        setCookie: stateCookieClear,
      });
    // The digest of the cookie's state, which equals the query's; the broker rechecks it.
    const digest = await oauthStateDigest(cookie);
    let installed;
    try {
      installed = decodeShopifyInstallResult(
        await rpc(
          () => broker.shopifyInstallComplete(appKey, rawQuery, digest, connectorBudgets.installMs),
          connectorBudgets.installMs + connectorBudgets.installSlackMs,
        ),
      );
    } catch {
      return connectorPage("uncertain", { setCookie: stateCookieClear });
    }
    switch (installed.outcome) {
      case "installed":
      case "reauthorised": {
        // The store's app/uninstalled and app/scopes_update subscriptions, after the
        // response: the install is complete whatever this does, and the cron retries.
        ctx.waitUntil(subscriptions(connectorBudgets.subscriptionsMs));
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

  // The token of an ended installation, with the reason its row records (idempotent).
  async function destroy(installationId: string, reason: ShopifyCredentialReason) {
    const startedAt = Date.now();
    try {
      const outcome = decodeShopifyCredentialResult(
        await rpc(
          () => broker.shopifyCredentialDestroy(installationId, reason),
          connectorBudgets.destroyMs,
        ),
      );
      if (outcome === "destroyed" || outcome === "already_destroyed") return true;
      log("morrow_connector_credential", { code: "DESTROY_" + outcome.toUpperCase() });
    } catch (error) {
      log("morrow_connector_credential", {
        code: "DESTROY_UNAVAILABLE",
        ...rpcStage(error, startedAt),
      });
    }
    return false;
  }
  // Applies one recorded inbox row; when the applier reports the installation's token still
  // to destroy, destroys it, and a shop/redact waiting on that destruction is applied once
  // more so its privacy request completes. Anything left is the cron's.
  async function apply(inboxId: string): Promise<"applied" | "pending" | "failed"> {
    for (let round = 0; round < 2; round++) {
      let applied;
      try {
        applied = await database.inboxApply(inboxId, connectorBudgets.applyMs);
      } catch (error) {
        log("morrow_connector_inbox", { code: "APPLY_UNAVAILABLE", ...sqlStage(error) });
        return "failed";
      }
      const tokenPending =
        applied.credential === "pending" &&
        applied.installationId !== null &&
        applied.reason !== null;
      if (applied.outcome === "applied" || applied.outcome === "settled") {
        if (tokenPending) await destroy(applied.installationId!, applied.reason!);
        return "applied";
      }
      if (applied.outcome !== "pending") {
        log("morrow_connector_inbox", { code: "APPLY_" + applied.outcome.toUpperCase() });
        return "failed";
      }
      if (!tokenPending || !(await destroy(applied.installationId!, applied.reason!)))
        return "pending";
    }
    return "pending";
  }

  async function webhooks(
    request: Request,
    appKey: string,
    ctx: ConnectorContext,
  ): Promise<Response> {
    // Counted before the body is read: only Shopify sends webhooks, so a junk sender
    // spends only its own address's budget.
    const admitted = await admit(request, "webhooks");
    if (admitted === "limited") {
      const limited = connectorJson(429, { code: "rate_limited" });
      limited.headers.set("retry-after", "60");
      return limited;
    }
    if (admitted !== "allowed") return connectorJson(503, { code: "unavailable" });
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
      // Not recorded, or not known to be: Shopify retries, de-duplicated by webhook id.
      return connectorJson(503, { code: "unavailable" });
    }
    if (verdict.verdict === "refused") return connectorJson(401, { code: "unauthorized" });
    if (verdict.verdict === "invalid") {
      log("morrow_connector_webhook", { code: "WEBHOOK_BODY_INVALID" });
      return connectorJson(400, { code: "invalid_request" });
    }
    // The delivery is durable: applied after the response; a settled duplicate needs nothing.
    if (!verdict.settled) {
      const inboxId = verdict.inboxId;
      ctx.waitUntil(apply(inboxId).catch(() => "failed"));
    }
    return connectorJson(200, { schemaVersion: 1, received: true });
  }

  // The cron's re-drives (ids only, both cross-tenant): received inbox rows, then the tokens
  // of ended installations whose destruction is not yet recorded; then the privacy deadline
  // check (M2 PR-3 review; ADR-0022 item 14): open requests past their target or their
  // 30-day due time, each logged with a fixed code an alert can match.
  // fix-connector-cron-latency: each step that fails logs its stage (an id read on
  // morrow_connector_cron, the others on their own lines), and the run's line adds its
  // duration (elapsedMs: seconds far from the database, well under one beside it).
  async function redrive(): Promise<Readonly<Record<string, number>>> {
    const startedAt = Date.now();
    const deadline = startedAt + connectorBudgets.redriveMs;
    const counts = {
      inbox: 0,
      applied: 0,
      credentials: 0,
      destroyed: 0,
      targetMissed: 0,
      dueMissed: 0,
      subscriptionsChecked: 0,
      subscriptionsRegistered: 0,
      unavailable: 0,
    };
    let ids: readonly string[] = [];
    try {
      ids = await database.inboxPending(connectorBudgets.pendingMs);
    } catch (error) {
      counts.unavailable++;
      log("morrow_connector_cron", { code: "INBOX_PENDING_UNAVAILABLE", ...sqlStage(error) });
    }
    for (const id of ids) {
      if (Date.now() > deadline) break;
      counts.inbox++;
      if ((await apply(id)) === "applied") counts.applied++;
    }
    let tokens: Awaited<ReturnType<typeof database.credentialsPending>> = [];
    try {
      tokens = await database.credentialsPending(connectorBudgets.pendingMs);
    } catch (error) {
      counts.unavailable++;
      log("morrow_connector_cron", {
        code: "CREDENTIALS_PENDING_UNAVAILABLE",
        ...sqlStage(error),
      });
    }
    for (const token of tokens) {
      if (Date.now() > deadline) break;
      counts.credentials++;
      if (await destroy(token.installationId, token.reason)) counts.destroyed++;
    }
    try {
      const overdue = await database.privacyOverdue(connectorBudgets.pendingMs);
      counts.targetMissed = overdue.targetMissed;
      counts.dueMissed = overdue.dueMissed;
      if (overdue.targetMissed > 0)
        log("morrow_connector_privacy", {
          code: "PRIVACY_TARGET_MISSED",
          requests: overdue.targetMissed,
        });
      if (overdue.dueMissed > 0)
        log("morrow_connector_privacy", {
          code: "PRIVACY_DUE_MISSED",
          requests: overdue.dueMissed,
        });
    } catch (error) {
      counts.unavailable++;
      log("morrow_connector_privacy", { code: "PRIVACY_CHECK_UNAVAILABLE", ...sqlStage(error) });
    }
    // The shop-specific webhook subscriptions of every active installation that lacks them,
    // when the run still has the sync's whole budget.
    if (
      deadline - Date.now() >=
      connectorBudgets.subscriptionsCronMs + connectorBudgets.subscriptionsSlackMs
    ) {
      const synced = await subscriptions(connectorBudgets.subscriptionsCronMs);
      if (synced) {
        counts.subscriptionsChecked = synced.checked;
        counts.subscriptionsRegistered = synced.registered;
      } else counts.unavailable++;
    }
    log("morrow_connector_redrive", {
      ...counts,
      elapsedMs: stageMs(Date.now() - startedAt, 120000),
    });
    return Object.freeze(counts);
  }

  return Object.freeze({
    redrive,
    async fetch(request: Request, ctx: ConnectorContext): Promise<Response> {
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
      if (selected.route === "webhooks") return webhooks(request, selected.appKey, ctx);
      if (selected.route === "callback")
        return callback(request, selected.appKey, selected.rawQuery, ctx);
      return launch(request, selected.appKey, selected.rawQuery, selected.route === "status");
    },
  });
}
