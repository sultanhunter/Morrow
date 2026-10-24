// Shop-specific webhook subscriptions (docs/briefs/shopify-shop-specific-webhooks.md; ADR-0022
// items 4 and 7; ADR-0008 item 1 as amended: hand-written fetch, no Shopify library). Shopify
// CLI 4.9 refuses app-specific webhook topics while use_legacy_install_flow is on (the
// connector's own authorization-code install), so the app configuration subscribes only the
// three compliance topics, and the broker, the only holder of each store's offline token,
// registers app/uninstalled and app/scopes_update for each active installation as
// shop-specific subscriptions to the connector's signed webhook path. Deliveries of both kinds
// reach the same route and the same verification (shopifyWebhookVerify).
//
// ConnectorBroker.shopifyWebhookSubscriptionsSync(budgetMs), at most one per isolate at a time
// (WEBHOOKS_BUSY), held without the vault or the connector's origin (WEBHOOKS_UNAVAILABLE):
//   1. One vault transaction, alone: the pending installations (at most
//      shopifyWebhookSyncLimits.batch): active, of an active app, whose current credential
//      version has no registered row (shopify-webhook-registrations-identity).
//   2. Per installation, while the budget allows:
//      a. one vault transaction: its tenant, app key, shop domain and the active envelope of
//         its current credential version, opened with the KEK (the additional data binds the
//         tenant, the credential, the installation and the version);
//      b. the callback URL, built here from the connector's own reviewed origin and the app
//         key: `<origin>/shopify/a/<appKey>/webhooks`, never from a caller or the database;
//      c. one fixed list (WebhookSubscriptions: both topics, at most 25 nodes, each node's
//         id, topic and uri). A subscription counts only when its uri is exactly that
//         callback URL; every other subscription is left as it is. Nothing is ever updated
//         or deleted;
//      d. for each topic still missing, in a fixed order, one fixed create
//         (WebhookSubscriptionCreate) with the topic's enum value and that URL (its uri) as
//         its only variables, in the pinned API version (the version in the request URL, equal to the
//         app configuration's webhooks api_version). A create stops the round on any reply
//         that is not a proven creation: userErrors and a reply that does not prove its outcome
//         (a lost reply, a 5xx, another status or GraphQL error, a malformed reply) are
//         reconciled by listing again before anything else; a refused token is unauthorized;
//         a reply that proves nothing ran (no time to send, THROTTLED twice, 429,
//         ACCESS_DENIED) is failed;
//      e. one vault transaction: the closed outcome for the version used (registered with
//         Shopify's two subscription ids; failed; unknown when a create's outcome could not
//         be proven and the reconciling list neither showed it nor proved its absence;
//         unauthorized). The next sync
//         lists before it creates, so an unknown outcome is always reconciled by a list
//         before any retry, and Shopify refuses a second subscription of the same topic and
//         address anyway. Every outcome but registered stays pending, retried after a
//         backoff (4 minutes per consecutive attempt, at most 6 hours); a record that fails
//         leaves the installation pending as it was.
// The install never depends on any of this: the connector calls it after the install's
// response, and its five-minute cron calls it again. Nothing here logs; the token, the
// envelope, the shop and Shopify's replies never cross the binding (counts only).
import {
  encodeShopifyWebhookSyncResult,
  shopifyAppKeyPattern,
  shopifyShopPattern,
  shopifyWebhookCallbackUrl,
  shopifyWebhookSyncLimits,
  type ShopifyWebhookRegistrationStatus,
  type ShopifyWebhookSyncResult,
} from "../../../packages/identity/src/broker-protocol.js";
import {
  BrokerHold,
  brokerCapabilities,
  invokeBrokerMethod,
  type BrokerVault,
} from "./capabilities.js";
import type { VaultTransaction } from "./shopify-install.js";
import { shopifyAdminWrite } from "./shopify-write.js";
import { shopifyAdminGraphql, type ShopifyFetch } from "./shopify.js";
import { runVaultTransaction } from "./vault-database.js";
import {
  VaultError,
  openVaultRecord,
  vaultHexBytes,
  vaultLimits,
  vaultStatements,
  type VaultQuery,
} from "./vault.js";

export interface ShopifyWebhookDependencies {
  readonly transaction: VaultTransaction;
  readonly fetch: ShopifyFetch;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}
/** The two shop-specific topics, Shopify's enum value of each, in the order they are made. */
export const shopifyShopWebhookEnums = Object.freeze([
  Object.freeze({ topic: "app/uninstalled", value: "APP_UNINSTALLED" }),
  Object.freeze({ topic: "app/scopes_update", value: "APP_SCOPES_UPDATE" }),
] as const);
export const shopifyWebhookListSize = 25;
/**
 * The fixed documents (Admin GraphQL, the pinned API version 2026-10). Nothing else is ever
 * sent. A subscription's destination is its `uri` (2026-10 deprecates `endpoint` and
 * `callbackUrl`, so neither is read or sent); the list takes no variables, and the create
 * takes only the topic's enum value and the URL the broker built.
 */
export const shopifyWebhookDocuments = Object.freeze({
  subscriptions: `query WebhookSubscriptions { webhookSubscriptions(first: ${shopifyWebhookListSize}, topics: [APP_UNINSTALLED, APP_SCOPES_UPDATE]) { nodes { id topic uri } pageInfo { hasNextPage } } }`,
  subscriptionCreate:
    "mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $uri: String!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri }) { webhookSubscription { id topic uri } userErrors { field message } } }",
} as const);
// Each vault transaction gets at most this much; the record keeps this much of the budget;
// an installation starts only with at least this much left.
const vaultBudgetMs = 3000;
const recordReserveMs = 2000;
const installationMinimumMs = 4000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const subscriptionGid = /^gid:\/\/shopify\/WebhookSubscription\/([1-9][0-9]{0,19})$/;
const targetColumns = [
  "outcome",
  "organization_id",
  "workspace_id",
  "app_key",
  "shop_domain",
  "credential_id",
  "credential_version",
  "kek_version",
  "wrapped_key",
  "sealed_value",
] as const;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const own = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
const subscriptionId = (value: unknown): string | null =>
  typeof value === "string" ? (subscriptionGid.exec(value)?.[1] ?? null) : null;
const subscriptionUri = (node: unknown): string | null => {
  const uri = own(node, "uri");
  return typeof uri === "string" ? uri : null;
};
function columns(rows: readonly Record<string, unknown>[], names: readonly string[]) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new VaultError("VAULT_RECORD_INVALID");
  const r = rows[0]!;
  if (Object.keys(r).sort().join(",") !== [...names].sort().join(","))
    throw new VaultError("VAULT_RECORD_INVALID");
  return r;
}

type Topic = (typeof shopifyShopWebhookEnums)[number]["topic"];
export type ShopifyWebhookListing =
  | Readonly<{ kind: "listed"; found: ReadonlyMap<Topic, string>; complete: boolean }>
  | Readonly<{ kind: "unauthorized" }>
  | Readonly<{ kind: "failed" }>;
/**
 * The two topics' subscriptions whose uri is exactly `callbackUrl` (the first of each topic),
 * from one reply to the fixed list. `complete` is false when Shopify has more nodes
 * than the page, so absence is not proven. Null when the reply is not the document's shape.
 */
export function shopifyWebhookListResult(
  data: unknown,
  callbackUrl: string,
): Readonly<{ found: ReadonlyMap<Topic, string>; complete: boolean }> | null {
  const connection = own(data, "webhookSubscriptions");
  const nodes = own(connection, "nodes");
  const next = own(own(connection, "pageInfo"), "hasNextPage");
  if (!Array.isArray(nodes) || nodes.length > shopifyWebhookListSize || typeof next !== "boolean")
    return null;
  const found = new Map<Topic, string>();
  for (const node of nodes) {
    const id = subscriptionId(own(node, "id"));
    const value = own(node, "topic");
    if (id === null || typeof value !== "string") return null;
    const topic = shopifyShopWebhookEnums.find((t) => t.value === value)?.topic;
    // Another topic or another address (another app path, Pub/Sub, EventBridge): never ours,
    // never touched.
    if (!topic || subscriptionUri(node) !== callbackUrl || found.has(topic)) continue;
    found.set(topic, id);
  }
  return Object.freeze({ found, complete: !next });
}
export type ShopifyWebhookCreate =
  | Readonly<{ kind: "created"; id: string }>
  | Readonly<{ kind: "rejected" | "not_created" | "unauthorized" | "uncertain" }>;
/**
 * The outcome of one create reply. created: no userErrors and the reply names a subscription
 * of this topic with exactly this URL. rejected: userErrors (Shopify created nothing; the
 * address may already be taken by a concurrent sync, so the caller lists again).
 * not_created: proven not to have run (no time to send, THROTTLED or 429, ACCESS_DENIED).
 * unauthorized: 401. uncertain: anything that does not prove the outcome.
 */
export function classifyWebhookCreate(
  reply: Awaited<ReturnType<typeof shopifyAdminWrite>>,
  value: string,
  callbackUrl: string,
): ShopifyWebhookCreate {
  switch (reply.kind) {
    case "not_sent":
    case "throttled":
    case "access_denied":
      return Object.freeze({ kind: "not_created" });
    case "unauthorized":
      return Object.freeze({ kind: "unauthorized" });
    case "data": {
      const payload = own(reply.data, "webhookSubscriptionCreate");
      const userErrors = own(payload, "userErrors");
      if (!Array.isArray(userErrors)) return Object.freeze({ kind: "uncertain" });
      if (userErrors.length > 0) return Object.freeze({ kind: "rejected" });
      const subscription = own(payload, "webhookSubscription");
      const id = subscriptionId(own(subscription, "id"));
      if (id === null || own(subscription, "topic") !== value)
        return Object.freeze({ kind: "uncertain" });
      if (subscriptionUri(subscription) !== callbackUrl)
        return Object.freeze({ kind: "uncertain" });
      return Object.freeze({ kind: "created", id });
    }
    default:
      return Object.freeze({ kind: "uncertain" });
  }
}

export type ShopifyWebhookRegistration =
  | Readonly<{ status: "registered"; uninstalledId: string; scopesUpdateId: string }>
  | Readonly<{ status: Exclude<ShopifyWebhookRegistrationStatus, "registered"> }>;
/**
 * One store's two subscriptions with its token, by steps c and d of the header: list, create
 * only what is missing, and list again whenever a create did not prove its outcome.
 */
export async function registerShopWebhooks(
  deps: Readonly<ShopifyWebhookDependencies>,
  shop: string,
  token: string,
  callbackUrl: string,
  deadlineMs: number,
): Promise<ShopifyWebhookRegistration> {
  const list = async (): Promise<ShopifyWebhookListing> => {
    const reply = await shopifyAdminGraphql(
      deps.fetch,
      shop,
      token,
      shopifyWebhookDocuments.subscriptions,
      {},
      deadlineMs,
      deps.now,
      deps.sleep,
    );
    if (reply.kind === "unauthorized") return Object.freeze({ kind: "unauthorized" });
    if (reply.kind !== "data") return Object.freeze({ kind: "failed" });
    const result = shopifyWebhookListResult(reply.data, callbackUrl);
    return result
      ? Object.freeze({ kind: "listed", ...result })
      : Object.freeze({ kind: "failed" });
  };
  const done = (found: ReadonlyMap<Topic, string>): ShopifyWebhookRegistration | null => {
    const uninstalledId = found.get("app/uninstalled");
    const scopesUpdateId = found.get("app/scopes_update");
    return uninstalledId && scopesUpdateId && uninstalledId !== scopesUpdateId
      ? Object.freeze({ status: "registered", uninstalledId, scopesUpdateId })
      : null;
  };
  const listed = await list();
  if (listed.kind !== "listed") return Object.freeze({ status: listed.kind });
  const found = new Map(listed.found);
  const registered = done(found);
  if (registered) return registered;
  // A partial page proves no absence: nothing is created.
  if (!listed.complete) return Object.freeze({ status: "failed" });
  // The create that did not prove its outcome, if any: it stops the round.
  let open: Readonly<{ topic: Topic; kind: "rejected" | "uncertain" }> | null = null;
  for (const { topic, value } of shopifyShopWebhookEnums) {
    if (found.has(topic)) continue;
    const created = classifyWebhookCreate(
      await shopifyAdminWrite(
        deps.fetch,
        shop,
        token,
        shopifyWebhookDocuments.subscriptionCreate,
        { topic: value, uri: callbackUrl },
        deadlineMs,
        deps.now,
        deps.sleep,
      ),
      value,
      callbackUrl,
    );
    if (created.kind === "created") {
      found.set(topic, created.id);
      continue;
    }
    if (created.kind === "unauthorized") return Object.freeze({ status: "unauthorized" });
    if (created.kind === "not_created") return Object.freeze({ status: "failed" });
    open = Object.freeze({ topic, kind: created.kind });
    break;
  }
  const complete = done(found);
  if (complete) return complete;
  if (open === null) return Object.freeze({ status: "failed" });
  // Reconciled before anything else: the same fixed list again. It settles the open create
  // when it shows that subscription, or proves its absence with a complete page; the rest
  // waits for the next round, which lists before it creates.
  const again = await list();
  if (again.kind === "unauthorized") return Object.freeze({ status: "unauthorized" });
  if (again.kind === "listed") {
    for (const [topic, id] of again.found) if (!found.has(topic)) found.set(topic, id);
    const settled = done(found);
    if (settled) return settled;
    if (again.complete || found.has(open.topic)) return Object.freeze({ status: "failed" });
  }
  return Object.freeze({ status: open.kind === "uncertain" ? "unknown" : "failed" });
}

type InstallationOutcome = ShopifyWebhookRegistrationStatus | "skipped";

export function createShopifyWebhookSync(deps: Readonly<ShopifyWebhookDependencies>) {
  // One sync per isolate (WEBHOOKS_BUSY): it holds at most one vault connection at a time.
  let running = false;

  async function pending(vault: Readonly<BrokerVault>, deadline: number) {
    return deps.transaction(
      vault,
      Math.max(1, Math.min(vaultBudgetMs, deadline - deps.now())),
      async (query: VaultQuery) => {
        const rows = await query(vaultStatements.shopifyWebhookRegistrationsPending, []);
        if (!Array.isArray(rows) || rows.length > shopifyWebhookSyncLimits.batch)
          throw new VaultError("VAULT_RECORD_INVALID");
        return rows.map((r) => {
          if (
            Object.keys(r).join(",") !== "installation_id" ||
            !exact(idPattern, r.installation_id)
          )
            throw new VaultError("VAULT_RECORD_INVALID");
          return r.installation_id;
        });
      },
    );
  }

  async function installation(
    vault: Readonly<BrokerVault>,
    origin: string,
    installationId: string,
    deadline: number,
  ): Promise<InstallationOutcome> {
    // a. The target and its token's envelope.
    let target: Record<string, unknown>;
    try {
      target = await deps.transaction(
        vault,
        Math.max(1, Math.min(vaultBudgetMs, deadline - deps.now())),
        async (query) =>
          columns(
            await query(vaultStatements.shopifyWebhookTarget, [installationId]),
            targetColumns,
          ),
      );
    } catch {
      return "skipped";
    }
    if (target.outcome !== "found") return "skipped";
    const { organization_id: org, workspace_id: ws, credential_id: credential } = target;
    const { app_key: appKey, shop_domain: shop, credential_version: version } = target;
    if (
      !exact(idPattern, org) ||
      !exact(idPattern, ws) ||
      !exact(idPattern, credential) ||
      !exact(shopifyAppKeyPattern, appKey) ||
      !exact(shopifyShopPattern, shop) ||
      !exact(/^[1-9][0-9]{0,15}$/, version) ||
      !exact(/^[1-9][0-9]{0,2}$/, target.kek_version)
    )
      return "skipped";
    // b. The callback URL: the connector's own origin and the app key, nothing else.
    const callbackUrl = shopifyWebhookCallbackUrl(origin, appKey);
    let token: string;
    try {
      const plaintext = await openVaultRecord(
        vault.keyring,
        {
          kind: "shopify_offline_token",
          organizationId: org,
          workspaceId: ws,
          credentialId: credential,
          subjectId: installationId,
          provider: "shopify",
          version: Number(version),
        },
        {
          kekVersion: Number(target.kek_version),
          wrappedKey: vaultHexBytes(
            target.wrapped_key,
            vaultLimits.wrappedKeyBytes,
            vaultLimits.wrappedKeyBytes,
          ),
          sealedValue: vaultHexBytes(
            target.sealed_value,
            vaultLimits.sealedMinBytes,
            vaultLimits.sealedMaxBytes,
          ),
        },
      );
      try {
        token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
      } finally {
        plaintext.fill(0);
      }
    } catch {
      return "skipped";
    }
    // c and d. Shopify, within the budget less the record's reserve.
    let registration: ShopifyWebhookRegistration;
    try {
      registration = await registerShopWebhooks(
        deps,
        shop,
        token,
        callbackUrl,
        deadline - recordReserveMs,
      );
    } finally {
      token = "";
    }
    // e. The record, for the version used.
    try {
      const recorded = await deps.transaction(
        vault,
        Math.max(1, Math.min(vaultBudgetMs, deadline - deps.now())),
        async (query) =>
          columns(
            await query(vaultStatements.shopifyWebhookRegistrationRecord, [
              installationId,
              version,
              registration.status,
              registration.status === "registered" ? registration.uninstalledId : "",
              registration.status === "registered" ? registration.scopesUpdateId : "",
            ]),
            ["outcome"],
          ).outcome,
      );
      return recorded === "recorded" ? registration.status : "skipped";
    } catch {
      return "skipped";
    }
  }

  async function sync(env: unknown, budgetMs: unknown): Promise<string> {
    if (
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < shopifyWebhookSyncLimits.budgetMinMs ||
      budgetMs > shopifyWebhookSyncLimits.budgetMaxMs
    )
      throw new BrokerHold("BUDGET_INVALID");
    const capabilities = await brokerCapabilities(env);
    const vault = capabilities.vault;
    const origin = capabilities.shopifyWebhookOrigin;
    if (!vault || origin === null) throw new BrokerHold("WEBHOOKS_UNAVAILABLE");
    if (running) throw new BrokerHold("WEBHOOKS_BUSY");
    running = true;
    try {
      const deadline = deps.now() + budgetMs;
      // 1. The pending installations, alone in their transaction.
      const ids = await pending(vault, deadline);
      const counts: { -readonly [K in keyof ShopifyWebhookSyncResult]: number } = {
        checked: 0,
        registered: 0,
        failed: 0,
        unknown: 0,
        unauthorized: 0,
        skipped: 0,
      };
      // 2. One installation at a time, while the budget allows a whole round.
      for (const id of ids) {
        if (deadline - deps.now() < installationMinimumMs) break;
        counts.checked++;
        counts[await installation(vault, origin, id, deadline)]++;
      }
      return encodeShopifyWebhookSyncResult(counts);
    } finally {
      running = false;
    }
  }
  return Object.freeze({ sync });
}

const live = createShopifyWebhookSync({
  transaction: runVaultTransaction,
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
});
export function brokerShopifyWebhookSubscriptionsSync(env: unknown, budgetMs: unknown) {
  return invokeBrokerMethod(
    "shopifyWebhookSubscriptionsSync",
    () => live.sync(env, budgetMs),
    "ConnectorBroker",
  );
}
