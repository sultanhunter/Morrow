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
// v1 PR 5 ("Keep the store connection healthy"; ADR-0025 items 9 and 10; ADR-0031 item 3):
//   launch    an uninstalled installation launches OAuth (a reinstall: a new installation,
//             a new token, born unlinked, so only a person links it again); a live one that
//             lacks a scope or whose token Shopify refused (reconnect) launches OAuth too,
//             and the re-authorisation records the new token's scopes (the Reconnect item's
//             path). A suspended installation (a person's disconnect) stays ineligible.
//   webhooks  the applier is connector_inbox_apply_v2: app/scopes_update keeps the
//             connection and its token, stops only the agents that need a missing scope and
//             raises the Reconnect item; with the clean-up switch on it then asks the broker
//             to read the granted scopes back (deliveries can arrive out of order) and
//             reconciles again from what Shopify answered.
//   cron      always: the open Reconnect items, and every live connection that needs
//             reconnecting without one, reconciled again (cleared once the scopes are back;
//             an agent a person resumed while a scope is missing is stopped again).
//             With the connection clean-up switch on (MORROW_CONNECTION_CLEANUP, committed
//             off): the daily read-back of every live installation (a missed scope change, or
//             a token Shopify refused: a missed uninstall is reconciled into a Reconnect
//             item, never assumed), the 48-hour deletion of an installation whose shop/redact
//             never completed (once, with its record; its token destroyed first), and the
//             stuck-delivery close (logged INBOX_STUCK). All ids only; each step runs in its
//             tenant from the row it names.
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
  decodeShopifyConnectionCheck,
  decodeShopifyCredentialResult,
  decodeShopifyInstallResult,
  decodeShopifyLaunchVerdict,
  decodeShopifyWebhookVerdict,
  type ConnectorBrokerRpc,
  type ShopifyCredentialReason,
} from "../../../packages/identity/src/broker-protocol.js";
import { limitAddress } from "../../../packages/identity/src/edge-limiter.js";
import type { ConnectorConfiguration, ConnectorLimiters } from "./environment.js";
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
    | "shopifyLaunchVerify"
    | "shopifyInstallComplete"
    | "shopifyWebhookVerify"
    | "shopifyCredentialDestroy"
    | "shopifyConnectionCheck"
  >;
  readonly database: ConnectorDatabase;
  /** The ingress limits; null or absent only in development (a lab without them). */
  readonly limiters?: Readonly<ConnectorLimiters> | null;
  /**
   * v1 PR 5: the connection clean-up switch (MORROW_CONNECTION_CLEANUP exactly "on");
   * absent or false is off: no read-back, no 48-hour deletion, no stuck-delivery close.
   */
  readonly cleanup?: boolean;
}
// RPC and SQL budgets inside the platform's request time. The install RPC's own timer
// adds installSlackMs to the broker's budget: the broker returns by its deadline (its last
// transaction's close never waits past it), and the slack covers the RPC's two hops, so a
// committed install is not reported as "Not confirmed".
export const connectorBudgets = Object.freeze({
  launchMs: 4000,
  stateOpenMs: 3000,
  installMs: 9000,
  installSlackMs: 1500,
  webhookMs: 4000,
  // M2 PR-3: one inbox row's applier transaction, the token's destruction, a re-drive's id
  // read (and the privacy deadline check), and the whole cron run (its last apply starts
  // before this much has passed).
  applyMs: 6000,
  destroyMs: 4000,
  pendingMs: 3000,
  redriveMs: 60000,
  // v1 PR 5: one read-back of an installation's scopes (the broker's two vault steps and
  // the Shopify call) and the RPC's slack, one reconcile, one 48-hour deletion step.
  checkMs: 8000,
  checkSlackMs: 1500,
  reconcileMs: 4000,
  deletionMs: 6000,
});
/** A request's context: the response may return before work handed to waitUntil ends. */
export type ConnectorContext = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
const log = (event: string, value: Record<string, string | number>) =>
  console.log(JSON.stringify({ event, ...value }));
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
  const limiters = deps.limiters ?? null;
  const cleanup = deps.cleanup === true;
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
    // A person's disconnect (suspended) needs the app uninstalled first. v1 PR 5: an
    // uninstalled installation launches a reinstall, and reconnect a re-authorisation.
    if (verdict.installation === "suspended")
      return connectorPage("ineligible", { shop: verdict.shop });
    if (statusOnly)
      return verdict.installation === "unlinked"
        ? connectorPage("installed_unlinked", { shop: verdict.shop, link })
        : verdict.installation === "reconnect"
          ? connectorPage("reconnect", { shop: verdict.shop, link })
          : verdict.installation === "uninstalled"
            ? connectorPage("ineligible", { shop: verdict.shop })
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
    try {
      const outcome = decodeShopifyCredentialResult(
        await rpc(
          () => broker.shopifyCredentialDestroy(installationId, reason),
          connectorBudgets.destroyMs,
        ),
      );
      if (outcome === "destroyed" || outcome === "already_destroyed") return true;
      log("morrow_connector_credential", { code: "DESTROY_" + outcome.toUpperCase() });
    } catch {
      log("morrow_connector_credential", { code: "DESTROY_UNAVAILABLE" });
    }
    return false;
  }
  // v1 PR 5: one reconcile of an installation's agent stops and Reconnect item, from its
  // recorded state. Failures are the cron's (the open item is reconciled again).
  async function reconcile(installationId: string): Promise<boolean> {
    try {
      const r = await database.healthReconcile(installationId, connectorBudgets.reconcileMs);
      return r.outcome === "reconciled" || r.outcome === "ended";
    } catch {
      log("morrow_connector_health", { code: "RECONCILE_UNAVAILABLE" });
      return false;
    }
  }
  // v1 PR 5 (ADR-0025 item 10; the clean-up switch on): the broker reads the installation's
  // granted scopes back with its own token and records what Shopify answered; then the
  // reconcile. Nothing is assumed from an unclear answer.
  async function readBack(installationId: string): Promise<"observed" | "refused" | "skipped"> {
    let outcome;
    try {
      outcome = decodeShopifyConnectionCheck(
        await rpc(
          () => broker.shopifyConnectionCheck(installationId, connectorBudgets.checkMs),
          connectorBudgets.checkMs + connectorBudgets.checkSlackMs,
        ),
      );
    } catch {
      log("morrow_connector_health", { code: "CHECK_UNAVAILABLE" });
      return "skipped";
    }
    if (outcome !== "observed" && outcome !== "token_refused") {
      if (outcome === "unavailable") log("morrow_connector_health", { code: "CHECK_UNAVAILABLE" });
      return "skipped";
    }
    if (outcome === "token_refused") log("morrow_connector_health", { code: "TOKEN_REFUSED" });
    await reconcile(installationId);
    return outcome === "observed" ? "observed" : "refused";
  }
  // Applies one recorded inbox row; when the applier reports the installation's token still
  // to destroy, destroys it, and a shop/redact waiting on that destruction is applied once
  // more so its privacy request completes. Anything left is the cron's. v1 PR 5: a scope
  // change keeps the token; with the clean-up switch on its scopes are then read back.
  async function apply(inboxId: string): Promise<"applied" | "pending" | "failed"> {
    for (let round = 0; round < 2; round++) {
      let applied;
      try {
        applied = await database.inboxApply(inboxId, connectorBudgets.applyMs);
      } catch {
        log("morrow_connector_inbox", { code: "APPLY_UNAVAILABLE" });
        return "failed";
      }
      const tokenPending =
        applied.credential === "pending" &&
        applied.installationId !== null &&
        applied.reason !== null;
      if (applied.outcome === "applied" || applied.outcome === "settled") {
        if (tokenPending) await destroy(applied.installationId!, applied.reason!);
        if (
          cleanup &&
          applied.outcome === "applied" &&
          applied.topic === "app/scopes_update" &&
          applied.installationId !== null
        )
          await readBack(applied.installationId);
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

  // v1 PR 5: one 48-hour deletion (ADR-0031 item 3): its handlers, then the token's
  // destruction when it is still recorded as pending, then the deletion once more so its
  // record completes. Anything left is the next cron's.
  async function deletion(installationId: string): Promise<"applied" | "pending" | "failed"> {
    for (let round = 0; round < 2; round++) {
      let d;
      try {
        d = await database.deletionApply(installationId, connectorBudgets.deletionMs);
      } catch {
        log("morrow_connector_deletion", { code: "DELETION_UNAVAILABLE" });
        return "failed";
      }
      if (d.outcome === "applied" || d.outcome === "settled") return "applied";
      if (d.outcome !== "pending") {
        log("morrow_connector_deletion", { code: "DELETION_" + d.outcome.toUpperCase() });
        return "failed";
      }
      if (d.credential !== "pending" || !(await destroy(installationId, "uninstalled")))
        return "pending";
    }
    return "pending";
  }

  // The cron's re-drives (ids only, both cross-tenant): received inbox rows, then the tokens
  // of ended installations whose destruction is not yet recorded; then the privacy deadline
  // check (M2 PR-3 review; ADR-0022 item 14): open requests past their target or their
  // 30-day due time, each logged with a fixed code an alert can match. v1 PR 5: then the
  // open Reconnect items, and, with the clean-up switch on, the read-backs due, the 48-hour
  // deletions due and the stuck deliveries.
  async function redrive(): Promise<Readonly<Record<string, number>>> {
    const deadline = Date.now() + connectorBudgets.redriveMs;
    const counts = {
      inbox: 0,
      applied: 0,
      credentials: 0,
      destroyed: 0,
      targetMissed: 0,
      dueMissed: 0,
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
    };
    let ids: readonly string[] = [];
    try {
      ids = await database.inboxPending(connectorBudgets.pendingMs);
    } catch {
      counts.unavailable++;
    }
    for (const id of ids) {
      if (Date.now() > deadline) break;
      counts.inbox++;
      if ((await apply(id)) === "applied") counts.applied++;
    }
    let tokens: Awaited<ReturnType<typeof database.credentialsPending>> = [];
    try {
      tokens = await database.credentialsPending(connectorBudgets.pendingMs);
    } catch {
      counts.unavailable++;
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
    } catch {
      counts.unavailable++;
      log("morrow_connector_privacy", { code: "PRIVACY_CHECK_UNAVAILABLE" });
    }
    // v1 PR 5: the open Reconnect items and the live connections that need reconnecting,
    // reconciled again from each installation's state.
    let notices: readonly string[] = [];
    try {
      notices = await database.noticesDue(connectorBudgets.pendingMs);
    } catch {
      counts.unavailable++;
    }
    for (const id of notices) {
      if (Date.now() > deadline) break;
      counts.notices++;
      if (await reconcile(id)) counts.reconciled++;
    }
    if (cleanup) {
      // The daily read-back of every live installation (a missed scope change or uninstall
      // is reconciled from what Shopify answers, never assumed).
      let checks: readonly string[] = [];
      try {
        checks = await database.checksDue(connectorBudgets.pendingMs);
      } catch {
        counts.unavailable++;
      }
      for (const id of checks) {
        if (Date.now() > deadline) break;
        counts.checks++;
        const read = await readBack(id);
        if (read === "observed") counts.observed++;
        else if (read === "refused") counts.refused++;
      }
      // The 48-hour deletions whose shop/redact never completed.
      let deletions: readonly string[] = [];
      try {
        deletions = await database.deletionsDue(connectorBudgets.pendingMs);
      } catch {
        counts.unavailable++;
      }
      for (const id of deletions) {
        if (Date.now() > deadline) break;
        counts.deletions++;
        if ((await deletion(id)) === "applied") counts.deleted++;
      }
      // Stuck deliveries: a scope change still received after 24 hours is closed (the
      // read-back reconciles its scopes); every other topic is counted and logged only.
      try {
        const stuck = await database.inboxStuck(connectorBudgets.pendingMs);
        counts.stuckClosed = stuck.closed;
        counts.stuck = stuck.stuck;
        if (stuck.stuck > 0)
          log("morrow_connector_inbox", { code: "INBOX_STUCK", deliveries: stuck.stuck });
      } catch {
        counts.unavailable++;
      }
    }
    log("morrow_connector_redrive", counts);
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
        return callback(request, selected.appKey, selected.rawQuery);
      return launch(request, selected.appKey, selected.rawQuery, selected.route === "status");
    },
  });
}
