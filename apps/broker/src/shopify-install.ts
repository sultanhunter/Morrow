// The ConnectorBroker's Shopify methods (M2 PR-2; ADR-0022 items 4, 7 and 13; ADR-0008
// items 1-2; mvp-architecture §2 steps 4-5 and §4). Trust model v1: the connector passes
// only the raw request text it received; the broker reads the app secret and the registry
// from its own vault login, checks every signature, and decides. Verdicts are closed JSON
// strings (broker-protocol.ts); a held capability or database is the error BROKER_HELD.
//
// shopifyInstallComplete runs, in order, and stops at the first refusal:
//   1. the state in the query must be the cookie's (its digest equals stateDigest);
//   2. one transaction, committed alone: the app secret and the state's claim, so a
//      replayed or expired state never reaches Shopify;
//   3. the query HMAC and timestamp, and the shop equal to the claimed state's shop;
//   4. the code exchange, sent once (a transport loss is exchange_uncertain, never
//      retried);
//   5. the expanded granted scopes equal to the requested ones exactly;
//   6. the ShopIdentity read; a store that is not a Partner development store is refused
//      (development and staging are the only environments with a vault);
//   7. one transaction: prepare (the ids the envelope binds), seal the token
//      (AES-256-GCM; the additional data binds environment, tenant, credential, subject =
//      installation, version and KEK version), then store the vault row and the identity
//      install record together. A lost COMMIT acknowledgement is outcome_unknown; the
//      merchant relaunches and the database reconciles.
// The offline token never leaves the broker, and nothing here logs.
import {
  brokerUtf8Bytes,
  encodeShopifyInstallResult,
  encodeShopifyLaunchVerdict,
  encodeShopifyWebhookVerdict,
  shopifyAppKeyPattern,
  shopifyDigestPattern,
  shopifyLimits,
  shopifySecretPattern,
  shopifyShopPattern,
  shopifyWebhookHeaderNames,
  shopifyWebhookTopics,
  type ShopifyInstallOutcome,
  type ShopifyInstallationState,
} from "../../../packages/identity/src/broker-protocol.js";
import { loginJson } from "../../../packages/identity/src/standalone-login-protocol.js";
import {
  BrokerHold,
  brokerCapabilities,
  invokeBrokerMethod,
  type BrokerMethod,
  type BrokerVault,
} from "./capabilities.js";
import {
  exchangeShopifyCode,
  minimiseShopifyWebhook,
  parseShopifyQuery,
  readShopifyIdentity,
  sha256Hex,
  shopifyScopesExact,
  verifyShopifyQuery,
  verifyShopifyWebhookHmac,
  type ShopifyFetch,
} from "./shopify.js";
import { runVaultTransaction } from "./vault-database.js";
import {
  VaultError,
  readAppSecret,
  sealVaultRecord,
  vaultBytesHex,
  vaultStatements,
  type VaultQuery,
} from "./vault.js";

export type VaultTransaction = <T>(
  vault: Readonly<BrokerVault>,
  budgetMs: number,
  body: (query: VaultQuery) => Promise<T>,
) => Promise<T>;
export interface ShopifyBrokerDependencies {
  readonly transaction: VaultTransaction;
  readonly fetch: ShopifyFetch;
  readonly now: () => number;
}

const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const installationStates: readonly string[] = [
  "none",
  "unlinked",
  "linked",
  "suspended",
  "uninstalled",
];
// The one database step of a launch or webhook gets at most this much.
const readBudgetMs = 3000;
// The install keeps this much of its budget for its last transaction.
const storeReserveMs = 2500;

function row(rows: readonly Record<string, unknown>[], names: readonly string[]) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new VaultError("VAULT_RECORD_INVALID");
  const r = rows[0]!;
  if (Object.keys(r).sort().join(",") !== [...names].sort().join(","))
    throw new VaultError("VAULT_RECORD_INVALID");
  return r;
}
async function vaultOf(env: unknown): Promise<Readonly<BrokerVault>> {
  const capabilities = await brokerCapabilities(env);
  if (!capabilities.vault) throw new BrokerHold("CAPABILITY_UNAVAILABLE");
  return capabilities.vault;
}
function base64urlRandom(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let text = "";
  for (const byte of raw) text += String.fromCharCode(byte);
  raw.fill(0);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function bytesFromBase64(text: unknown, maximum: number): Uint8Array | null {
  if (
    typeof text !== "string" ||
    text.length > Math.ceil(maximum / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text) ||
    text.length % 4 !== 0
  )
    return null;
  try {
    const raw = atob(text);
    if (raw.length > maximum) return null;
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

interface LaunchContext {
  readonly secret: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly installation: ShopifyInstallationState;
}
// The app secret and the registry state of one app and shop, in one read transaction.
// Null when either is absent (an unknown app, a foreign shop, a retired app).
async function launchContext(
  deps: ShopifyBrokerDependencies,
  vault: Readonly<BrokerVault>,
  appKey: string,
  shop: string,
  budgetMs: number,
): Promise<LaunchContext | null> {
  return deps.transaction(vault, budgetMs, async (query) => {
    const secret = await readAppSecret(vault.keyring, query, appKey);
    const c = row(await query(vaultStatements.shopifyLaunchContext, [appKey, shop]), [
      "outcome",
      "client_id",
      "workspace_id",
      "installation",
    ]);
    if (secret.outcome !== "found" || c.outcome !== "found") return null;
    if (
      !exact(/^[a-f0-9]{32}$/, c.client_id) ||
      !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, c.workspace_id) ||
      typeof c.installation !== "string" ||
      !installationStates.includes(c.installation)
    )
      throw new VaultError("VAULT_RECORD_INVALID");
    return Object.freeze({
      secret: secret.secret,
      clientId: c.client_id,
      workspaceId: c.workspace_id,
      installation: c.installation as ShopifyInstallationState,
    });
  });
}

export function createShopifyBroker(deps: Readonly<ShopifyBrokerDependencies>) {
  const nowSeconds = () => Math.trunc(deps.now() / 1000);

  async function launchVerify(env: unknown, appKey: unknown, rawQuery: unknown): Promise<string> {
    if (typeof appKey !== "string" || typeof rawQuery !== "string")
      throw new BrokerHold("INPUT_INVALID");
    const refused = encodeShopifyLaunchVerdict({ verdict: "refused" });
    if (
      !exact(shopifyAppKeyPattern, appKey) ||
      brokerUtf8Bytes(rawQuery) > shopifyLimits.queryMaxBytes
    )
      return refused;
    const shop = parseShopifyQuery(rawQuery)?.params.get("shop");
    if (!exact(shopifyShopPattern, shop)) return refused;
    const vault = await vaultOf(env);
    const context = await launchContext(deps, vault, appKey, shop, readBudgetMs);
    if (!context) return refused;
    const verified = await verifyShopifyQuery(
      context.secret,
      rawQuery,
      nowSeconds(),
      shopifyLimits.timestampToleranceSeconds,
    );
    if (!verified || verified.get("shop") !== shop) return refused;
    return encodeShopifyLaunchVerdict({
      verdict: "verified",
      shop,
      installation: context.installation,
      workspaceId: context.workspaceId,
    });
  }

  async function installComplete(
    env: unknown,
    appKey: unknown,
    rawQuery: unknown,
    stateDigest: unknown,
    budgetMs: unknown,
  ): Promise<string> {
    if (
      typeof appKey !== "string" ||
      typeof rawQuery !== "string" ||
      typeof stateDigest !== "string" ||
      typeof budgetMs !== "number"
    )
      throw new BrokerHold("INPUT_INVALID");
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > shopifyLimits.budgetMaxMs)
      throw new BrokerHold("BUDGET_INVALID");
    const deadline = deps.now() + budgetMs;
    const answer = (
      outcome: ShopifyInstallOutcome,
      workspaceId: string | null = null,
      continuationToken: string | null = null,
    ) => encodeShopifyInstallResult({ outcome, workspaceId, continuationToken });
    const remaining = (reserve = 0) => deadline - deps.now() - reserve;
    if (
      !exact(shopifyAppKeyPattern, appKey) ||
      !exact(shopifyDigestPattern, stateDigest) ||
      brokerUtf8Bytes(rawQuery) > shopifyLimits.queryMaxBytes
    )
      return answer("refused");
    const params = parseShopifyQuery(rawQuery)?.params;
    const state = params?.get("state");
    const shop = params?.get("shop");
    const code = params?.get("code");
    // 1. The query's state is the cookie's.
    if (!exact(shopifySecretPattern, state) || (await sha256Hex(state)) !== stateDigest)
      return answer("state_invalid");
    if (!exact(shopifyShopPattern, shop) || typeof code !== "string") return answer("refused");
    const vault = await vaultOf(env);
    // 2. The secret and the claim, committed alone before any provider call.
    let claimed: { secret: string; clientId: string; shopDigest: string } | null;
    try {
      claimed = await deps.transaction(
        vault,
        Math.min(readBudgetMs, Math.max(1, remaining())),
        async (query) => {
          const secret = await readAppSecret(vault.keyring, query, appKey);
          const c = row(await query(vaultStatements.shopifyCallbackClaim, [appKey, stateDigest]), [
            "outcome",
            "shop_digest",
            "client_id",
          ]);
          if (secret.outcome !== "found" || c.outcome !== "claimed") return null;
          if (!exact(/^[a-f0-9]{64}$/, c.shop_digest) || !exact(/^[a-f0-9]{32}$/, c.client_id))
            throw new VaultError("VAULT_RECORD_INVALID");
          return { secret: secret.secret, clientId: c.client_id, shopDigest: c.shop_digest };
        },
      );
    } catch (error) {
      // An unknown claim may have consumed the state: it can only be relaunched.
      if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
        return answer("state_invalid");
      throw error;
    }
    if (!claimed) return answer("state_invalid");
    // 3. Shopify's signature, the timestamp and the claimed shop.
    const verified = await verifyShopifyQuery(
      claimed.secret,
      rawQuery,
      nowSeconds(),
      shopifyLimits.timestampToleranceSeconds,
    );
    if (!verified || (await sha256Hex(shop)) !== claimed.shopDigest) return answer("refused");
    if (remaining(storeReserveMs) <= 0) return answer("refused");
    // 4. The code exchange, once.
    const exchanged = await exchangeShopifyCode(
      deps.fetch,
      shop,
      claimed.clientId,
      claimed.secret,
      code,
      remaining(storeReserveMs),
    );
    if (exchanged.kind === "uncertain") return answer("exchange_uncertain");
    if (exchanged.kind === "refused") return answer("refused");
    // 5. Least privilege: exactly the requested scopes, expanded.
    const scopes = shopifyScopesExact(exchanged.scopes);
    if (!scopes) return answer("scopes_mismatch");
    // 6. The shop's identity; development stores only (ADR-0022 item 4).
    const identity = await readShopifyIdentity(
      deps.fetch,
      shop,
      exchanged.token,
      deadline - storeReserveMs,
      deps.now,
    );
    if (identity.kind !== "identity") return answer("refused");
    if (!identity.development) return answer("store_not_development");
    // 7. Prepare, seal and store in one transaction.
    const continuationToken = base64urlRandom(32);
    const continuationDigest = await sha256Hex(continuationToken);
    const budget = Math.min(shopifyLimits.budgetMaxMs, Math.max(1, remaining()));
    let stored: {
      outcome: ShopifyInstallOutcome;
      workspaceId: string | null;
      continuation: boolean;
    };
    try {
      stored = await deps.transaction(vault, budget, async (query) => {
        const p = row(
          await query(vaultStatements.shopifyInstallPrepare, [
            appKey,
            stateDigest,
            identity.shopId,
            shop,
          ]),
          [
            "outcome",
            "organization_id",
            "workspace_id",
            "installation_id",
            "store_id",
            "connection_id",
            "credential_id",
            "credential_version",
          ],
        );
        if (p.outcome === "state_invalid")
          return { outcome: "state_invalid" as const, workspaceId: null, continuation: false };
        if (p.outcome !== "install" && p.outcome !== "reauthorise")
          return { outcome: "refused" as const, workspaceId: null, continuation: false };
        const ids = [
          p.organization_id,
          p.workspace_id,
          p.installation_id,
          p.store_id,
          p.connection_id,
          p.credential_id,
        ];
        if (
          !ids.every((id) => exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, id)) ||
          !exact(/^[1-9][0-9]{0,15}$/, p.credential_version)
        )
          throw new VaultError("VAULT_RECORD_INVALID");
        const plaintext = new TextEncoder().encode(exchanged.token);
        let envelope;
        try {
          envelope = await sealVaultRecord(
            vault.keyring,
            {
              kind: "shopify_offline_token",
              organizationId: p.organization_id as string,
              workspaceId: p.workspace_id as string,
              credentialId: p.credential_id as string,
              subjectId: p.installation_id as string,
              provider: "shopify",
              version: Number(p.credential_version),
            },
            plaintext,
          );
        } finally {
          plaintext.fill(0);
        }
        const s = row(
          await query(vaultStatements.shopifyInstallStore, [
            appKey,
            stateDigest,
            identity.shopId,
            shop,
            scopes.join(","),
            identity.development ? "true" : "false",
            p.installation_id as string,
            p.store_id as string,
            p.connection_id as string,
            p.credential_id as string,
            p.credential_version as string,
            String(envelope.kekVersion),
            vaultBytesHex(envelope.wrappedKey),
            vaultBytesHex(envelope.sealedValue),
            continuationDigest,
          ]),
          ["outcome", "workspace_id", "continuation"],
        );
        if (s.outcome === "installed" || s.outcome === "reauthorised") {
          if (
            s.workspace_id !== p.workspace_id ||
            (s.continuation !== "created" && s.continuation !== "none")
          )
            throw new VaultError("VAULT_RECORD_INVALID");
          return {
            outcome: s.outcome as ShopifyInstallOutcome,
            workspaceId: s.workspace_id as string,
            continuation: s.continuation === "created",
          };
        }
        if (s.outcome === "state_invalid")
          return { outcome: "state_invalid" as const, workspaceId: null, continuation: false };
        return { outcome: "refused" as const, workspaceId: null, continuation: false };
      });
    } catch (error) {
      if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
        return answer("outcome_unknown");
      throw error;
    }
    if (stored.outcome === "installed" || stored.outcome === "reauthorised")
      return answer(
        stored.outcome,
        stored.workspaceId,
        stored.continuation ? continuationToken : null,
      );
    return answer(stored.outcome);
  }

  async function webhookVerify(
    env: unknown,
    appKey: unknown,
    headersJson: unknown,
    rawBodyBase64: unknown,
  ): Promise<string> {
    if (
      typeof appKey !== "string" ||
      typeof headersJson !== "string" ||
      typeof rawBodyBase64 !== "string"
    )
      throw new BrokerHold("INPUT_INVALID");
    const refused = encodeShopifyWebhookVerdict({ verdict: "refused" });
    if (!exact(shopifyAppKeyPattern, appKey)) return refused;
    let headers: Readonly<Record<string, unknown>>;
    try {
      headers = loginJson(
        headersJson,
        shopifyLimits.webhookHeadersMaxBytes,
        shopifyWebhookHeaderNames,
      );
    } catch {
      return refused;
    }
    const topic = headers["x-shopify-topic"];
    const shop = headers["x-shopify-shop-domain"];
    const webhookId = headers["x-shopify-webhook-id"];
    const body = bytesFromBase64(rawBodyBase64, shopifyLimits.webhookBodyMaxBytes);
    if (
      !body ||
      body.length === 0 ||
      !(shopifyWebhookTopics as readonly unknown[]).includes(topic) ||
      !exact(shopifyShopPattern, shop) ||
      !exact(/^[A-Za-z0-9-]{1,128}$/, webhookId) ||
      !exact(/^[0-9]{4}-[0-9]{2}$|^unstable$/, headers["x-shopify-api-version"])
    )
      return refused;
    const vault = await vaultOf(env);
    const context = await launchContext(deps, vault, appKey, shop, readBudgetMs);
    if (!context) return refused;
    // The raw-body signature, before any parse.
    if (!(await verifyShopifyWebhookHmac(context.secret, body, headers["x-shopify-hmac-sha256"])))
      return refused;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    } catch {
      return refused;
    }
    const minimised = await minimiseShopifyWebhook(context.secret, topic as string, parsed);
    if (!minimised) return refused;
    return encodeShopifyWebhookVerdict({
      verdict: "verified",
      topic: topic as (typeof shopifyWebhookTopics)[number],
      shopDomain: shop,
      webhookId,
      minimisedBody: minimised,
    });
  }

  return Object.freeze({ launchVerify, installComplete, webhookVerify });
}

const live = createShopifyBroker({
  transaction: runVaultTransaction,
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
});
const connector = <T>(method: BrokerMethod, run: () => Promise<T>) =>
  invokeBrokerMethod(method, run, "ConnectorBroker");

export function brokerShopifyLaunchVerify(env: unknown, appKey: unknown, rawQuery: unknown) {
  return connector("shopifyLaunchVerify", () => live.launchVerify(env, appKey, rawQuery));
}
export function brokerShopifyInstallComplete(
  env: unknown,
  appKey: unknown,
  rawCallbackQuery: unknown,
  stateDigest: unknown,
  budgetMs: unknown,
) {
  return connector("shopifyInstallComplete", () =>
    live.installComplete(env, appKey, rawCallbackQuery, stateDigest, budgetMs),
  );
}
export function brokerShopifyWebhookVerify(
  env: unknown,
  appKey: unknown,
  headersJson: unknown,
  rawBodyBase64: unknown,
) {
  return connector("shopifyWebhookVerify", () =>
    live.webhookVerify(env, appKey, headersJson, rawBodyBase64),
  );
}
