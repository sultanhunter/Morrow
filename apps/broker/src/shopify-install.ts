// The ConnectorBroker's Shopify methods (M2 PR-2; ADR-0022 items 4, 7 and 13; ADR-0008
// items 1-2; mvp-architecture §2 steps 4-5 and §4). Trust model v1: the connector passes
// only the raw request text it received; the broker reads the app secret and the registry
// from its own vault login, checks every signature, and decides. Verdicts are closed JSON
// strings (broker-protocol.ts); a held capability or database is the error BROKER_HELD.
//
// Ingress (M2 PR-2 review). Launch, status, webhooks and the callback's claim are the
// anonymous ("ingress") uses of the vault login (CONNECTION LIMIT 10), which the install
// store, the PR-3 inbox and offline-token reads and the M5 Stripe receipts also need. The
// layers, outermost first:
//   1. the connector counts every broker-bound request per client address (Workers rate
//      limits; apps/shopify-connector/worker/connector.ts) before any broker call;
//   2. here, before any vault transaction: the request must be shaped like Shopify's (a
//      signed query's hmac, a fresh timestamp and no signature parameter; a webhook's
//      headers and base64 HMAC). When this isolate already holds the app's secret (read
//      from the vault within shopifySecretCacheMs), Shopify's HMAC is verified first, so
//      only a Shopify-signed request of a known app reaches the registry statement. An
//      older ("stale") secret, up to shopifySecretStaleMs, still lets a request it verifies
//      count as verified for layer 3; one it does not verify takes the unverified path,
//      so a rotated secret is read again;
//   3. per isolate, at most shopifyIngressLimits.unverified transactions for requests
//      whose signature could not be checked first (an app whose secret this isolate does
//      not hold, or an unknown app key) and shopifyIngressLimits.total ingress
//      transactions in all run at once; one more is held (INGRESS_BUSY: the connector
//      answers 503 and Shopify retries webhooks). The install store, which follows a
//      successful code exchange, is not ingress and is never counted.
// The bound is per isolate, not global: many addresses reaching many broker isolates at
// once can still hold the login (docs/briefs/M2-shopify-connect.md, security notes).
//
// shopifyInstallComplete runs, in order, and stops at the first refusal:
//   1. the state in the query must be the cookie's (its digest equals stateDigest), and
//      the query must have a signed query's shape (and, with the app's secret cached,
//      Shopify's HMAC and timestamp);
//   2. one transaction, committed alone: the app secret, then Shopify's HMAC and
//      timestamp over the query, and only then the state's claim. A query that fails
//      verification sends no claim, so it consumes no state; a replayed or expired state
//      never reaches Shopify;
//   3. the shop equal to the claimed state's shop;
//   4. the code exchange, sent once (a transport loss is exchange_uncertain, never
//      retried);
//   5. the expanded granted scopes equal to the requested ones exactly;
//   6. the ShopIdentity read; a store that is not a Partner development store is admitted
//      only for the app that carries the live-store mark and only for its own intended
//      shop (ADR-0035 item 2: the owner's store), which step 7 asks the registry first, in
//      the same transaction and before any prepare or seal; every other app refuses it
//      (store_not_development), and the database refuses such an installation row again
//      (migration shopify-live-store-identity). Development and staging are the only
//      environments with a vault;
//   7. one transaction: the live-store admission when step 6 needs it, then prepare (the
//      ids the envelope binds), seal the token
//      (AES-256-GCM; the additional data binds environment, tenant, credential, subject =
//      installation, version and KEK version), then store the vault row and the identity
//      install record together. A lost COMMIT acknowledgement is outcome_unknown; the
//      merchant relaunches and the database reconciles.
// The offline token never leaves the broker. A launch or install that does not succeed
// logs one stage line of closed values (shopify-stage.ts: the step it stopped at, a closed
// reason, where its last vault transaction ended and how long it took); nothing else here
// logs, and a success logs nothing.
//
// Budgets (fix-shopify-install-live, shopifyBrokerBudgets): the launch's registry read and
// the callback's claim each get 5 s, enough for a fresh vault connection while the Neon
// compute wakes from suspend or while a request runs away from the database's region; a
// webhook's record keeps 3 s, inside Shopify's 5 s delivery timeout.
//
// M2 PR-3: shopifyWebhookVerify also records the delivery. In one ingress transaction it
// reads the app secret, verifies the signature over the raw body, minimises the body (a body
// of another topic, or naming another shop, is invalid) and records it through
// morrow_vault.shopify_webhook_record (the app active or retired, only for its own shop; the
// tenant is the registry's), so the inbox row exists before the connector answers 200 and
// the connector login never writes one. A lost COMMIT acknowledgement is OUTCOME_UNKNOWN: the
// connector answers 5xx and Shopify's retry is de-duplicated by its webhook id.
// shopifyCredentialDestroy erases an ended installation's token and records the
// destruction on it in one vault transaction; it is idempotent, so any failure is retried
// (the connector's cron re-drives every installation whose destruction is not recorded).
import {
  brokerUtf8Bytes,
  encodeShopifyCredentialResult,
  encodeShopifyInstallResult,
  encodeShopifyLaunchVerdict,
  encodeShopifyWebhookVerdict,
  shopifyCredentialOutcomes,
  shopifyCredentialReasons,
  shopifyInstallationIdPattern,
  shopifyAppKeyPattern,
  shopifyDigestPattern,
  shopifyLimits,
  shopifySecretPattern,
  shopifyShopPattern,
  shopifyWebhookHeaderNames,
  shopifyWebhookTopics,
  type ShopifyCredentialOutcome,
  type ShopifyInstallOutcome,
  type ShopifyInstallationState,
  type ShopifyWebhookVerdict,
} from "../../../packages/identity/src/broker-protocol.js";
import { loginJson } from "../../../packages/identity/src/standalone-login-protocol.js";
import {
  BrokerHold,
  brokerCapabilities,
  brokerCapabilitiesWarm,
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
  shopifyQueryShapeReason,
  shopifyScopesExact,
  shopifyWebhookHmacPattern,
  verifyShopifyQuery,
  verifyShopifyWebhookHmac,
  type ShopifyFetch,
} from "./shopify.js";
import {
  emitShopifyStage,
  newShopifyStageTrace,
  recordVaultObservation,
  type ShopifyStage,
  type ShopifyStageTrace,
} from "./shopify-stage.js";
import {
  runVaultTransaction,
  type VaultTransactionObservation,
  type VaultTransactionObserver,
} from "./vault-database.js";
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
  observe?: VaultTransactionObserver,
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
// The Shopify vault transactions' budgets (fix-shopify-install-live). The first live
// launch and callback failed at exactly the old 3 s: the connector, and so this broker
// behind its RPC, ran at the edge nearest the merchant, where each of a transaction's
// about 13 sequential round trips (a fresh WebSocket connection, BEGIN, the role preflight,
// three SET LOCALs, the app secret, the registry or claim statement and COMMIT) crossed to
// Neon's region. The connector is now placed in that region (its wrangler.jsonc), where the
// same transaction takes tens of milliseconds; these budgets add headroom for a compute
// waking from suspend or a request that still runs unplaced. The connector's RPC timers
// cover each with slack for a cold isolate (connector.ts connectorBudgets; a test ties them).
export const shopifyBrokerBudgets = Object.freeze({
  /** The launch's registry read (secret and installation state). */
  launchMs: 5000,
  /** The callback's claim, at most what is left of the install's budget. */
  claimMs: 5000,
  /** A webhook's record and a token's destruction: inside Shopify's 5 s webhook timeout. */
  ingressMs: 3000,
  /** The install keeps this much of its budget for its last transaction. */
  storeReserveMs: 3500,
});
// Ingress vault transactions at once per broker isolate (layer 3 of the header):
// `unverified` for requests whose signature could not be checked first, `total` for all.
export const shopifyIngressLimits = Object.freeze({ unverified: 1, total: 3 });
// How long an isolate trusts an app secret it read from the vault to refuse a request
// without a vault read (layer 2), how long it keeps it at all, and for how many apps. A
// rotated secret is honoured within shopifySecretCacheMs: until then the old secret
// refuses Shopify's new signatures without a vault read (a launch is refused, a webhook is
// retried by Shopify).
export const shopifySecretCacheMs = 60_000;
export const shopifySecretStaleMs = 3_600_000;
const secretCacheApps = 64;

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
// The closed reason of a claim the definer did not grant (0026 work_shopify_state_claim:
// claimed, expired, replayed, not_found, invalid; 0027 adds denied).
const claimReason = (outcome: unknown) =>
  outcome === "expired"
    ? "claim_expired"
    : outcome === "replayed"
      ? "claim_replayed"
      : outcome === "not_found"
        ? "claim_not_found"
        : "claim_invalid";
// A held call's reason when its step recorded none: the hold's own, a vault error, or
// "unexpected".
function heldReason(error: unknown): string {
  if (error instanceof BrokerHold)
    return error.code === "INPUT_INVALID"
      ? "input_invalid"
      : error.code === "BUDGET_INVALID"
        ? "budget_invalid"
        : error.code === "INGRESS_BUSY"
          ? "ingress_busy"
          : error.code === "CAPABILITY_UNAVAILABLE"
            ? "vault_absent"
            : "unexpected";
  return error instanceof VaultError ? "vault_error" : "unexpected";
}

export function createShopifyBroker(deps: Readonly<ShopifyBrokerDependencies>) {
  const nowSeconds = () => Math.trunc(deps.now() / 1000);
  // One vault transaction whose observation (or, from a transport that gives none, its
  // elapsed time) and error code go into the call's trace.
  async function traced<T>(
    trace: ShopifyStageTrace,
    vault: Readonly<BrokerVault>,
    budgetMs: number,
    body: (query: VaultQuery) => Promise<T>,
  ): Promise<T> {
    const seen: { observation: Readonly<VaultTransactionObservation> | null } = {
      observation: null,
    };
    const started = deps.now();
    try {
      return await deps.transaction(vault, budgetMs, body, (observation) => {
        seen.observation = observation;
      });
    } catch (error) {
      if (error instanceof VaultError) trace.vault = error.code;
      throw error;
    } finally {
      recordVaultObservation(trace, budgetMs, seen.observation, deps.now() - started);
    }
  }
  // The app secret and the registry state of one app and shop, in one read transaction.
  // `context` is null when either is absent (an unknown app, a foreign shop, a retired app),
  // and `why` says which; `secret` is the app's secret whenever the vault holds one, for
  // the isolate's cache.
  async function launchContext(
    trace: ShopifyStageTrace,
    vault: Readonly<BrokerVault>,
    appKey: string,
    shop: string,
  ): Promise<{
    secret: string | null;
    context: LaunchContext | null;
    why: "secret_not_found" | "registry_not_found" | null;
  }> {
    return traced(trace, vault, shopifyBrokerBudgets.launchMs, async (query) => {
      const secret = await readAppSecret(vault.keyring, query, appKey);
      const c = row(await query(vaultStatements.shopifyLaunchContext, [appKey, shop]), [
        "outcome",
        "client_id",
        "workspace_id",
        "installation",
      ]);
      const found = secret.outcome === "found" ? secret.secret : null;
      if (found === null) return { secret: found, context: null, why: "secret_not_found" as const };
      if (c.outcome !== "found")
        return { secret: found, context: null, why: "registry_not_found" as const };
      if (
        !exact(/^[a-f0-9]{32}$/, c.client_id) ||
        !exact(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, c.workspace_id) ||
        typeof c.installation !== "string" ||
        !installationStates.includes(c.installation)
      ) {
        trace.reason = "registry_invalid";
        throw new VaultError("VAULT_RECORD_INVALID");
      }
      return {
        secret: found,
        context: Object.freeze({
          secret: found,
          clientId: c.client_id,
          workspaceId: c.workspace_id,
          installation: c.installation as ShopifyInstallationState,
        }),
        why: null as null,
      };
    });
  }
  // Layer 3: one pair of counters per broker instance, which is one per isolate for the
  // live broker.
  let ingressAll = 0,
    ingressUnverified = 0;
  async function ingress<T>(verified: boolean, run: () => Promise<T>): Promise<T> {
    if (
      ingressAll >= shopifyIngressLimits.total ||
      (!verified && ingressUnverified >= shopifyIngressLimits.unverified)
    )
      throw new BrokerHold("INGRESS_BUSY");
    ingressAll++;
    if (!verified) ingressUnverified++;
    try {
      return await run();
    } finally {
      ingressAll--;
      if (!verified) ingressUnverified--;
    }
  }
  // Layer 2: the app secrets this isolate read from the vault, per vault capability (so a
  // keyring or database never sees another's), with the time of the read that returned
  // them. Only a vault read sets or clears an entry; an unknown app key never touches one.
  const secrets = new WeakMap<object, Map<string, { secret: string; readAt: number }>>();
  function remember(vault: Readonly<BrokerVault>, appKey: string, secret: string | null) {
    let apps = secrets.get(vault);
    if (!apps) secrets.set(vault, (apps = new Map()));
    apps.delete(appKey);
    if (secret === null) return;
    if (apps.size >= secretCacheApps) apps.delete(apps.keys().next().value!);
    apps.set(appKey, { secret, readAt: deps.now() });
  }
  // One request's signature against the held secret, before any database: "refused" (a
  // fresh secret refuses it), "verified" (a fresh or stale secret verifies it) or
  // "unverified" (no secret held, or a stale one does not verify it).
  async function preverify(
    vault: Readonly<BrokerVault>,
    appKey: string,
    check: (secret: string) => Promise<boolean>,
    trace?: ShopifyStageTrace,
  ): Promise<"refused" | "verified" | "unverified"> {
    const apps = secrets.get(vault);
    const entry = apps?.get(appKey);
    if (trace) trace.secretCache = "none";
    if (!entry) return "unverified";
    const age = deps.now() - entry.readAt;
    if (!(age >= 0 && age < shopifySecretStaleMs)) {
      apps!.delete(appKey);
      return "unverified";
    }
    if (trace) trace.secretCache = age < shopifySecretCacheMs ? "fresh" : "stale";
    if (await check(entry.secret)) return "verified";
    return age < shopifySecretCacheMs ? "refused" : "unverified";
  }
  const queryCheck = (rawQuery: string, shop: string) => async (secret: string) =>
    (
      await verifyShopifyQuery(
        secret,
        rawQuery,
        nowSeconds(),
        shopifyLimits.timestampToleranceSeconds,
      )
    )?.get("shop") === shop;

  // One call's trace, its outcome and its stage line: a call that throws is "held" (its
  // step's reason, or the hold's own); every result but `success` emits the line.
  async function staged(
    method: ShopifyStageTrace["method"],
    success: readonly string[],
    run: (trace: ShopifyStageTrace) => Promise<string>,
  ): Promise<string> {
    const trace = newShopifyStageTrace(method);
    const started = deps.now();
    try {
      return await run(trace);
    } catch (error) {
      trace.result = "held";
      if (trace.reason === null) trace.reason = heldReason(error);
      if (error instanceof VaultError && trace.vault === null) trace.vault = error.code;
      throw error;
    } finally {
      trace.totalMs = deps.now() - started;
      if (trace.result === null || !success.includes(trace.result)) emitShopifyStage(trace);
    }
  }
  // Marks a step's end in the trace.
  const mark = (
    trace: ShopifyStageTrace,
    stage: ShopifyStage,
    result: string,
    reason: string | null,
  ) => {
    trace.stage = stage;
    trace.result = result;
    trace.reason = reason;
  };

  function launchVerify(env: unknown, appKey: unknown, rawQuery: unknown): Promise<string> {
    return staged("shopifyLaunchVerify", ["verified"], (trace) =>
      launchSteps(trace, env, appKey, rawQuery),
    );
  }
  async function launchSteps(
    trace: ShopifyStageTrace,
    env: unknown,
    appKey: unknown,
    rawQuery: unknown,
  ): Promise<string> {
    if (typeof appKey !== "string" || typeof rawQuery !== "string")
      throw new BrokerHold("INPUT_INVALID");
    const refused = (stage: ShopifyStage, reason: string) => {
      mark(trace, stage, "refused", reason);
      return encodeShopifyLaunchVerdict({ verdict: "refused" });
    };
    trace.stage = "shape";
    if (!exact(shopifyAppKeyPattern, appKey)) return refused("shape", "app_key_shape");
    if (brokerUtf8Bytes(rawQuery) > shopifyLimits.queryMaxBytes)
      return refused("shape", "query_bytes");
    const parsed = parseShopifyQuery(rawQuery);
    const shop = parsed?.params.get("shop");
    if (!exact(shopifyShopPattern, shop))
      return refused("shape", parsed ? "shop_param" : "query_parse");
    // A signed query's shape (hmac, a fresh timestamp, no signature) before any database.
    const shape = shopifyQueryShapeReason(
      rawQuery,
      nowSeconds(),
      shopifyLimits.timestampToleranceSeconds,
    );
    if (shape !== null) return refused("shape", shape);
    trace.stage = "capability";
    trace.coldIsolate = !brokerCapabilitiesWarm(env);
    const vault = await vaultOf(env);
    // With the app's secret held, Shopify's signature before any database.
    trace.stage = "preverify";
    const preverified = await preverify(vault, appKey, queryCheck(rawQuery, shop), trace);
    if (preverified === "refused") return refused("preverify", "secret_refused");
    trace.stage = "ingress";
    const read = await ingress(preverified === "verified", () => {
      trace.stage = "launch_context";
      return launchContext(trace, vault, appKey, shop);
    });
    remember(vault, appKey, read.secret);
    const context = read.context;
    if (!context) return refused("launch_context", read.why ?? "registry_not_found");
    trace.installation = context.installation;
    trace.stage = "verify";
    const verified = await verifyShopifyQuery(
      context.secret,
      rawQuery,
      nowSeconds(),
      shopifyLimits.timestampToleranceSeconds,
    );
    if (!verified) return refused("verify", "hmac_mismatch");
    if (verified.get("shop") !== shop) return refused("verify", "shop_mismatch");
    const verdict = encodeShopifyLaunchVerdict({
      verdict: "verified",
      shop,
      installation: context.installation,
      workspaceId: context.workspaceId,
    });
    mark(trace, "done", "verified", null);
    return verdict;
  }

  function installComplete(
    env: unknown,
    appKey: unknown,
    rawQuery: unknown,
    stateDigest: unknown,
    budgetMs: unknown,
  ): Promise<string> {
    return staged("shopifyInstallComplete", ["installed", "reauthorised"], (trace) =>
      installSteps(trace, env, appKey, rawQuery, stateDigest, budgetMs),
    );
  }
  async function installSteps(
    trace: ShopifyStageTrace,
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
    trace.stage = "budget";
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > shopifyLimits.budgetMaxMs)
      throw new BrokerHold("BUDGET_INVALID");
    const deadline = deps.now() + budgetMs;
    // The step's end in the trace, and the closed result.
    const answer = (
      stage: ShopifyStage,
      outcome: ShopifyInstallOutcome,
      reason: string | null,
      workspaceId: string | null = null,
      continuationToken: string | null = null,
    ) => {
      mark(trace, stage, outcome, reason);
      return encodeShopifyInstallResult({ outcome, workspaceId, continuationToken });
    };
    const remaining = (reserve = 0) => deadline - deps.now() - reserve;
    trace.stage = "shape";
    if (!exact(shopifyAppKeyPattern, appKey)) return answer("shape", "refused", "app_key_shape");
    if (!exact(shopifyDigestPattern, stateDigest))
      return answer("shape", "refused", "digest_shape");
    if (brokerUtf8Bytes(rawQuery) > shopifyLimits.queryMaxBytes)
      return answer("shape", "refused", "query_bytes");
    const params = parseShopifyQuery(rawQuery)?.params;
    const state = params?.get("state");
    const shop = params?.get("shop");
    const code = params?.get("code");
    // 1. The query's state is the cookie's, and the query is shaped like a signed one.
    if (!exact(shopifySecretPattern, state))
      return answer("shape", "state_invalid", params ? "state_shape" : "query_parse");
    if ((await sha256Hex(state)) !== stateDigest)
      return answer("shape", "state_invalid", "state_mismatch");
    if (!exact(shopifyShopPattern, shop)) return answer("shape", "refused", "shop_param");
    if (typeof code !== "string") return answer("shape", "refused", "code_missing");
    const shape = shopifyQueryShapeReason(
      rawQuery,
      nowSeconds(),
      shopifyLimits.timestampToleranceSeconds,
    );
    if (shape !== null) return answer("shape", "refused", shape);
    trace.stage = "capability";
    trace.coldIsolate = !brokerCapabilitiesWarm(env);
    const vault = await vaultOf(env);
    trace.stage = "preverify";
    const preverified = await preverify(vault, appKey, queryCheck(rawQuery, shop), trace);
    if (preverified === "refused") return answer("preverify", "refused", "secret_refused");
    // 2. The secret, Shopify's signature and timestamp, then the claim, committed alone
    // before any provider call. An unverified query sends no claim statement.
    let read: {
      secret: string | null;
      claimed: { clientId: string; shopDigest: string } | "refused" | null;
    };
    const seen: { refusal: "hmac_mismatch" | "shop_mismatch" | null; claim: unknown } = {
      refusal: null,
      claim: null,
    };
    trace.stage = "ingress";
    try {
      read = await ingress(preverified === "verified", () => {
        trace.stage = "claim_tx";
        return traced(
          trace,
          vault,
          Math.min(shopifyBrokerBudgets.claimMs, Math.max(1, remaining())),
          async (query) => {
            const secret = await readAppSecret(vault.keyring, query, appKey);
            if (secret.outcome !== "found") return { secret: null, claimed: null };
            const verified = await verifyShopifyQuery(
              secret.secret,
              rawQuery,
              nowSeconds(),
              shopifyLimits.timestampToleranceSeconds,
            );
            if (!verified || verified.get("shop") !== shop) {
              seen.refusal = verified ? "shop_mismatch" : "hmac_mismatch";
              return { secret: secret.secret, claimed: "refused" as const };
            }
            const c = row(
              await query(vaultStatements.shopifyCallbackClaim, [appKey, stateDigest]),
              ["outcome", "shop_digest", "client_id"],
            );
            seen.claim = c.outcome;
            if (c.outcome !== "claimed") return { secret: secret.secret, claimed: null };
            if (!exact(/^[a-f0-9]{64}$/, c.shop_digest) || !exact(/^[a-f0-9]{32}$/, c.client_id))
              throw new VaultError("VAULT_RECORD_INVALID");
            return {
              secret: secret.secret,
              claimed: { clientId: c.client_id, shopDigest: c.shop_digest },
            };
          },
        );
      });
    } catch (error) {
      // An unknown claim may have consumed the state: it can only be relaunched.
      if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
        return answer("claim_tx", "state_invalid", "vault_error");
      throw error;
    }
    remember(vault, appKey, read.secret);
    if (read.claimed === "refused")
      return answer("claim_tx", "refused", seen.refusal ?? "hmac_mismatch");
    if (read.secret === null) return answer("claim_tx", "state_invalid", "secret_not_found");
    if (!read.claimed) return answer("claim", "state_invalid", claimReason(seen.claim));
    const claimed = { secret: read.secret, ...read.claimed };
    // 3. The claimed state's shop.
    if ((await sha256Hex(shop)) !== claimed.shopDigest)
      return answer("shop_digest", "refused", "shop_digest_mismatch");
    if (remaining(shopifyBrokerBudgets.storeReserveMs) <= 0)
      return answer("reserve", "refused", "budget_exhausted");
    // 4. The code exchange, once.
    trace.stage = "exchange";
    const exchanged = await exchangeShopifyCode(
      deps.fetch,
      shop,
      claimed.clientId,
      claimed.secret,
      code,
      remaining(shopifyBrokerBudgets.storeReserveMs),
    );
    if (exchanged.kind === "uncertain")
      return answer("exchange", "exchange_uncertain", exchanged.reason);
    if (exchanged.kind === "refused") return answer("exchange", "refused", exchanged.reason);
    // 5. Least privilege: exactly the requested scopes, expanded.
    const scopes = shopifyScopesExact(exchanged.scopes);
    if (!scopes) return answer("scopes", "scopes_mismatch", "scopes_mismatch");
    // 6. The shop's identity: a development store (ADR-0022 item 4), or the live-store
    // app's own shop, which step 7 asks the registry first (ADR-0035 item 2).
    trace.stage = "identity";
    const identity = await readShopifyIdentity(
      deps.fetch,
      shop,
      exchanged.token,
      deadline - shopifyBrokerBudgets.storeReserveMs,
      deps.now,
    );
    if (identity.kind !== "identity") return answer("identity", "refused", identity.reason);
    // 7. The live-store admission when needed, then prepare, seal and store in one
    // transaction.
    trace.stage = "store_tx";
    const continuationToken = base64urlRandom(32);
    const continuationDigest = await sha256Hex(continuationToken);
    const budget = Math.min(shopifyLimits.budgetMaxMs, Math.max(1, remaining()));
    let stored: {
      outcome: ShopifyInstallOutcome;
      workspaceId: string | null;
      continuation: boolean;
      why: string | null;
    };
    const sealing = { failed: false };
    try {
      stored = await traced(trace, vault, budget, async (query) => {
        // A store that is not a development store: only the marked app's own shop, asked
        // before anything is prepared or sealed. Any other answer stores nothing.
        if (!identity.development) {
          const a = row(await query(vaultStatements.shopifyLiveStoreAdmission, [appKey, shop]), [
            "outcome",
          ]);
          if (a.outcome !== "admitted")
            return {
              outcome: "store_not_development" as const,
              workspaceId: null,
              continuation: false,
              why: "admission_refused",
            };
        }
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
          return {
            outcome: "state_invalid" as const,
            workspaceId: null,
            continuation: false,
            why: "prepare_state_invalid",
          };
        if (p.outcome !== "install" && p.outcome !== "reauthorise")
          return {
            outcome: "refused" as const,
            workspaceId: null,
            continuation: false,
            why: "prepare_refused",
          };
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
          sealing.failed = true;
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
          sealing.failed = false;
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
            why: null,
          };
        }
        if (s.outcome === "state_invalid")
          return {
            outcome: "state_invalid" as const,
            workspaceId: null,
            continuation: false,
            why: "store_state_invalid",
          };
        return {
          outcome: "refused" as const,
          workspaceId: null,
          continuation: false,
          why: "store_refused",
        };
      });
    } catch (error) {
      if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
        return answer("store_tx", "outcome_unknown", "vault_error");
      if (sealing.failed) trace.reason = "seal_failed";
      throw error;
    }
    if (stored.outcome === "installed" || stored.outcome === "reauthorised")
      return answer(
        "done",
        stored.outcome,
        null,
        stored.workspaceId,
        stored.continuation ? continuationToken : null,
      );
    return answer("store_tx", stored.outcome, stored.why);
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
    const verdict = (v: ShopifyWebhookVerdict) => encodeShopifyWebhookVerdict(v);
    const refused = verdict({ verdict: "refused", inboxId: null, settled: null });
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
    const apiVersion = headers["x-shopify-api-version"];
    const body = bytesFromBase64(rawBodyBase64, shopifyLimits.webhookBodyMaxBytes);
    if (
      !body ||
      body.length === 0 ||
      !(shopifyWebhookTopics as readonly unknown[]).includes(topic) ||
      !exact(shopifyShopPattern, shop) ||
      !exact(/^[A-Za-z0-9-]{1,128}$/, webhookId) ||
      !exact(/^[0-9]{4}-[0-9]{2}$|^unstable$/, apiVersion) ||
      !exact(shopifyWebhookHmacPattern, headers["x-shopify-hmac-sha256"])
    )
      return refused;
    const vault = await vaultOf(env);
    // The raw-body signature, before any parse: first against the held secret, so a
    // forged delivery of a known app reaches no database.
    const hmac = headers["x-shopify-hmac-sha256"];
    const preverified = await preverify(vault, appKey, (secret) =>
      verifyShopifyWebhookHmac(secret, body, hmac),
    );
    if (preverified === "refused") return refused;
    let read: { secret: string | null; verdict: ShopifyWebhookVerdict };
    try {
      read = await ingress(preverified === "verified", () =>
        deps.transaction(vault, shopifyBrokerBudgets.ingressMs, async (query) => {
          const secret = await readAppSecret(vault.keyring, query, appKey);
          if (secret.outcome !== "found")
            return { secret: null, verdict: { verdict: "refused", inboxId: null, settled: null } };
          const deny = (kind: "refused" | "invalid") => ({
            secret: secret.secret,
            verdict: { verdict: kind, inboxId: null, settled: null } as ShopifyWebhookVerdict,
          });
          if (!(await verifyShopifyWebhookHmac(secret.secret, body, hmac))) return deny("refused");
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
            );
          } catch {
            return deny("invalid");
          }
          const minimised = await minimiseShopifyWebhook(
            secret.secret,
            topic as string,
            parsed,
            shop,
          );
          if (!minimised) return deny("invalid");
          const r = row(
            await query(vaultStatements.shopifyWebhookRecord, [
              appKey,
              shop,
              topic as string,
              webhookId,
              apiVersion,
              JSON.stringify(minimised),
            ]),
            ["outcome", "inbox_id", "settled"],
          );
          if (r.outcome === "not_found") return deny("refused");
          if (r.outcome === "invalid") return deny("invalid");
          if (
            (r.outcome !== "recorded" && r.outcome !== "duplicate") ||
            typeof r.inbox_id !== "string" ||
            (r.settled !== "true" && r.settled !== "false")
          )
            throw new VaultError("VAULT_RECORD_INVALID");
          return {
            secret: secret.secret,
            verdict:
              r.outcome === "recorded"
                ? ({ verdict: "recorded", inboxId: r.inbox_id, settled: false } as const)
                : ({
                    verdict: "duplicate",
                    inboxId: r.inbox_id,
                    settled: r.settled === "true",
                  } as const),
          };
        }),
      );
    } catch (error) {
      // A lost COMMIT acknowledgement: the row may exist. The connector answers 5xx and
      // Shopify's retry finds it by its webhook id.
      if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
        throw new BrokerHold("OUTCOME_UNKNOWN");
      throw error;
    }
    remember(vault, appKey, read.secret);
    return verdict(read.verdict);
  }

  // The token of an ended installation (ADR-0022 item 13): only with the end reason its row
  // records; the destruction is recorded on the installation in the same transaction.
  async function credentialDestroy(
    env: unknown,
    installationId: unknown,
    reason: unknown,
  ): Promise<string> {
    if (
      !exact(shopifyInstallationIdPattern, installationId) ||
      !(shopifyCredentialReasons as readonly unknown[]).includes(reason)
    )
      throw new BrokerHold("INPUT_INVALID");
    const vault = await vaultOf(env);
    let outcome: ShopifyCredentialOutcome;
    try {
      outcome = await ingress(true, () =>
        deps.transaction(vault, shopifyBrokerBudgets.ingressMs, async (query) => {
          const r = row(
            await query(vaultStatements.shopifyCredentialDestroy, [
              installationId,
              reason as string,
            ]),
            ["outcome"],
          );
          if (!(shopifyCredentialOutcomes as readonly unknown[]).includes(r.outcome))
            throw new VaultError("VAULT_RECORD_INVALID");
          return r.outcome as ShopifyCredentialOutcome;
        }),
      );
    } catch (error) {
      if (error instanceof VaultError && error.code === "VAULT_OUTCOME_UNKNOWN")
        throw new BrokerHold("OUTCOME_UNKNOWN");
      throw error;
    }
    return encodeShopifyCredentialResult(outcome);
  }

  return Object.freeze({ launchVerify, installComplete, webhookVerify, credentialDestroy });
}

const live = createShopifyBroker({
  transaction: runVaultTransaction,
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
});
const connector = <T>(method: BrokerMethod, run: () => Promise<T>) =>
  invokeBrokerMethod(method, run, "ConnectorBroker");
const api = <T>(method: BrokerMethod, run: () => Promise<T>) =>
  invokeBrokerMethod(method, run, "ApiBroker");

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
export function brokerShopifyCredentialDestroy(
  env: unknown,
  installationId: unknown,
  reason: unknown,
) {
  return connector("shopifyCredentialDestroy", () =>
    live.credentialDestroy(env, installationId, reason),
  );
}
// "Disconnect store": the api's half of the same destruction, with the reason fixed to a
// person's disconnect (the vault refuses an installation that records any other end).
export function brokerShopifyDisconnectDestroy(env: unknown, installationId: unknown) {
  return api("shopifyCredentialDestroy", () =>
    live.credentialDestroy(env, installationId, "disconnected"),
  );
}
