// Hand-written Shopify checks and calls, inside the broker only (ADR-0008 item 1 as
// amended 2026-10-20 and item 2; ADR-0022 item 4). No Shopify library is deployed: every
// operation that needs the app client secret is here, behind the ConnectorBroker
// entrypoint, using WebCrypto and fetch only.
//   * Query HMAC (launch, status and the OAuth callback): the parameters minus hmac and
//     signature, sorted by name, form-encoded as `key=value` pairs joined by `&` (spaces as
//     %20), signed with HMAC-SHA256 and compared in constant time as lowercase hex; the
//     timestamp must be within 90 seconds of the broker's clock. A repeated parameter is
//     refused rather than joined.
//   * Webhook HMAC: base64 HMAC-SHA256 over the raw body bytes, before any parse.
//   * The authorization-code exchange: POST https://{shop}/admin/oauth/access_token with a
//     non-expiring offline token requested (`expiring: "0"`; ADR-0022 item 4: custom
//     distribution, which Shopify exempts from expiring offline tokens; refresh arrives with
//     public distribution as a new vault credential kind); never retried (a code is single
//     use). An expiring reply (expires_in, refresh_token or refresh_token_expires_in) or an
//     online one (associated_user) is refused with its own closed reason, never stored.
//   * Fixed Admin GraphQL documents (API version 2026-10): ShopIdentity at the install, and
//     M2 PR-3's reads (shopifyReadDocuments: the shop identity, a collections page, a
//     products page, one collection's products page and one product's listing fields).
// Replies are bounded, redirects are never followed, and every failure is a fixed code:
// no provider text, token, secret or value reaches a log, an error or a verdict. Refusals
// carry a closed `reason` (fix-shopify-install-live) that the broker's stage line names;
// `kind` alone decides every outcome.

export const shopifyApiVersion = "2026-10";
export const shopifyRequestedScopes = Object.freeze(["read_products", "write_products"] as const);
export const shopifyShopIdentityDocument =
  "query ShopIdentity { shop { id myshopifyDomain plan { partnerDevelopment } } }";
export const shopifyReplyMaxBytes = 65536;

const encoder = new TextEncoder();
const shopPattern = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const keyPattern = /^[a-z][a-z0-9_]{0,31}(\[\])?$/;

/** Constant-time equality of two strings of equal length (false for different lengths). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = encoder.encode(a),
    y = encoder.encode(b);
  let different = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) different |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return different === 0;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function base64(bytes: ArrayBuffer): string {
  let raw = "";
  for (const byte of new Uint8Array(bytes)) raw += String.fromCharCode(byte);
  return btoa(raw);
}
export async function shopifyHmacHex(secret: string, message: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)));
}
export async function shopifyHmacBase64(secret: string, body: Uint8Array): Promise<string> {
  const copy = new Uint8Array(body.length);
  copy.set(body);
  return base64(await crypto.subtle.sign("HMAC", await hmacKey(secret), copy));
}
export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export interface ShopifyQuery {
  /** Every parameter, decoded, in the received order (each name once). */
  readonly params: ReadonlyMap<string, string>;
  /** The signed message: every parameter but hmac and signature, canonicalised. */
  readonly message: string;
}
/**
 * Parses a raw query string (no leading "?", at most `maxBytes`). Refuses a repeated or
 * malformed name, a value with a control character, and anything that is not
 * well-formed percent-encoding. Returns null on any refusal.
 */
export function parseShopifyQuery(raw: unknown, maxBytes = 2048): ShopifyQuery | null {
  if (typeof raw !== "string" || raw.length === 0 || encoder.encode(raw).length > maxBytes)
    return null;
  if (!/^[A-Za-z0-9._~%&=+:/,\[\]-]*$/.test(raw)) return null;
  const params = new Map<string, string>();
  for (const pair of raw.split("&")) {
    const at = pair.indexOf("=");
    if (at <= 0) return null;
    let key: string, value: string;
    try {
      key = decodeURIComponent(pair.slice(0, at).replaceAll("+", " "));
      value = decodeURIComponent(pair.slice(at + 1).replaceAll("+", " "));
    } catch {
      return null;
    }
    if (!keyPattern.test(key) || params.has(key) || /[\x00-\x1f\x7f]/.test(value)) return null;
    params.set(key, value);
  }
  const signed = [...params.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = new URLSearchParams(signed).toString().replace(/\+/g, "%20");
  return Object.freeze({ params, message });
}

/** Why a query is not shaped like a Shopify-signed one, in the order the checks run. */
export const shopifyQueryShapeReasons = Object.freeze([
  "query_parse",
  "hmac_shape",
  "timestamp_shape",
  "timestamp_skew",
  "shop_param",
  "signature_param",
] as const);
export type ShopifyQueryShapeReason = (typeof shopifyQueryShapeReasons)[number];
function queryShape(
  raw: unknown,
  nowSeconds: number,
  toleranceSeconds: number,
): { query: ShopifyQuery; reason: null } | { query: null; reason: ShopifyQueryShapeReason } {
  const query = parseShopifyQuery(raw);
  if (!query) return { query: null, reason: "query_parse" };
  const hmac = query.params.get("hmac");
  const timestamp = query.params.get("timestamp");
  const shop = query.params.get("shop");
  if (hmac === undefined || !/^[a-f0-9]{64}$/.test(hmac))
    return { query: null, reason: "hmac_shape" };
  if (timestamp === undefined || !/^[1-9][0-9]{0,11}$/.test(timestamp))
    return { query: null, reason: "timestamp_shape" };
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds)
    return { query: null, reason: "timestamp_skew" };
  if (shop === undefined || !shopPattern.test(shop)) return { query: null, reason: "shop_param" };
  if (query.params.has("signature")) return { query: null, reason: "signature_param" };
  return { query, reason: null };
}
/**
 * The checks of a Shopify-signed admin query that need no secret: hmac is 64 lowercase
 * hex, the timestamp is an integer within the tolerance, the shop is a *.myshopify.com
 * domain, and there is no signature parameter. The broker runs this before it opens any
 * vault transaction, so an unsigned or stale request costs no database work (an attacker
 * can still forge the shape; the edge limiter bounds that). Every other lowercase key
 * Shopify adds (host, embedded, locale, session, id_token, ...) is data: it is signed with
 * the rest and grants nothing. Returns the parsed query, or null.
 */
export function shopifyQueryShape(
  raw: unknown,
  nowSeconds: number,
  toleranceSeconds = 90,
): ShopifyQuery | null {
  return queryShape(raw, nowSeconds, toleranceSeconds).query;
}
/** The first check `shopifyQueryShape` fails; null exactly when it returns the query. */
export function shopifyQueryShapeReason(
  raw: unknown,
  nowSeconds: number,
  toleranceSeconds = 90,
): ShopifyQueryShapeReason | null {
  return queryShape(raw, nowSeconds, toleranceSeconds).reason;
}

/**
 * Verifies a Shopify-signed admin query (launch, status, callback): the shape above, and
 * the HMAC of the canonical message under the app secret matches in constant time.
 * Returns the parameters, or null.
 */
export async function verifyShopifyQuery(
  secret: string,
  raw: unknown,
  nowSeconds: number,
  toleranceSeconds = 90,
): Promise<ReadonlyMap<string, string> | null> {
  const query = shopifyQueryShape(raw, nowSeconds, toleranceSeconds);
  if (!query || typeof secret !== "string" || secret.length === 0) return null;
  const expected = await shopifyHmacHex(secret, query.message);
  return constantTimeEqual(expected, query.params.get("hmac")!) ? query.params : null;
}
/** The shape of the X-Shopify-Hmac-Sha256 header: base64 of 32 bytes. */
export const shopifyWebhookHmacPattern = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Expands a scope list the way Shopify grants it: write_X implies read_X (and
 * unauthenticated_write_X implies unauthenticated_read_X). Sorted, unique. Null for a
 * malformed list.
 */
export function expandShopifyScopes(scopes: unknown): readonly string[] | null {
  if (typeof scopes !== "string" || scopes.length > 1024) return null;
  const list = scopes
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (!list.every((s) => /^[a-z][a-z_]{0,63}$/.test(s))) return null;
  const set = new Set(list);
  for (const scope of list) {
    const match = /^(unauthenticated_)?write_(.*)$/.exec(scope);
    if (match) set.add(`${match[1] ?? ""}read_${match[2]}`);
  }
  return Object.freeze([...set].sort());
}
/** The expanded granted set must equal the expanded requested set exactly (least privilege). */
export function shopifyScopesExact(granted: unknown): readonly string[] | null {
  const expanded = expandShopifyScopes(granted);
  const requested = expandShopifyScopes(shopifyRequestedScopes.join(","));
  if (!expanded || !requested || expanded.join(",") !== requested.join(",")) return null;
  return expanded;
}

export type ShopifyFetch = (url: string, init: RequestInit) => Promise<Response>;
// The closed reasons of a refused or uncertain call (fix-shopify-install-live): the input,
// an HTTP status class, the transport, the reply's shape. Never a provider text or value.
export const shopifyHttpReasons = Object.freeze([
  "input_shape",
  "http_401",
  "http_403",
  "http_429",
  "http_4xx",
  "http_5xx",
  "http_other",
  "transport",
  "timeout",
  "reply_json",
] as const);
export type ShopifyHttpReason = (typeof shopifyHttpReasons)[number];
const statusReason = (status: number): ShopifyHttpReason =>
  status === 401
    ? "http_401"
    : status === 403
      ? "http_403"
      : status === 429
        ? "http_429"
        : status >= 500
          ? "http_5xx"
          : status >= 400
            ? "http_4xx"
            : "http_other";
// An AbortSignal.timeout() abort rejects with a TimeoutError; any other throw of fetch is
// the transport's.
const thrownReason = (error: unknown): ShopifyHttpReason =>
  (error as { name?: unknown } | null)?.name === "TimeoutError" ? "timeout" : "transport";
// The body, at most `limit` bytes, or null.
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,9}$/.test(declared) || Number(declared) > limit))
    return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(item.value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}
const own = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

export const shopifyExchangeReasons = Object.freeze([
  ...shopifyHttpReasons,
  "reply_token_shape",
  "reply_scope_type",
  "reply_expiring",
  "reply_online",
] as const);
export type ShopifyExchangeReason = (typeof shopifyExchangeReasons)[number];
export type ShopifyExchange =
  | Readonly<{ kind: "token"; token: string; scopes: string }>
  | Readonly<{ kind: "refused"; reason: ShopifyExchangeReason }>
  | Readonly<{ kind: "uncertain"; reason: ShopifyExchangeReason }>;
/**
 * The authorization-code exchange for a non-expiring offline token. Sent once and never
 * retried. A transport failure, a timeout or a 5xx after sending is `uncertain` (the code
 * may have been consumed); a 4xx or a malformed, online or expiring reply is `refused`.
 * Reply keys other than the ones read here are ignored. An expiring reply (Shopify's
 * `expires_in`, `refresh_token`, `refresh_token_expires_in`) is `reply_expiring`: its
 * one-hour token cannot be refreshed by this broker, so it is never stored (ADR-0022 item
 * 4); an online one (`associated_user`) is `reply_online`.
 */
export async function exchangeShopifyCode(
  fetcher: ShopifyFetch,
  shop: string,
  clientId: string,
  secret: string,
  code: string,
  timeoutMs: number,
): Promise<ShopifyExchange> {
  const refused = (reason: ShopifyExchangeReason) =>
    Object.freeze({ kind: "refused" as const, reason });
  const uncertain = (reason: ShopifyExchangeReason) =>
    Object.freeze({ kind: "uncertain" as const, reason });
  if (
    !shopPattern.test(shop) ||
    !/^[a-f0-9]{32}$/.test(clientId) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(code)
  )
    return refused("input_shape");
  let response: Response;
  try {
    response = await fetcher(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, code, expiring: "0" }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch (error) {
    return uncertain(thrownReason(error));
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return uncertain("http_5xx");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return refused(statusReason(response.status));
  }
  const reply = await boundedJson(response, 8192);
  if (reply === null || typeof reply !== "object" || Array.isArray(reply))
    return refused("reply_json");
  // An online reply carries expires_in too; associated_user names it first.
  if (own(reply, "associated_user") !== undefined) return refused("reply_online");
  if (
    own(reply, "expires_in") !== undefined ||
    own(reply, "refresh_token") !== undefined ||
    own(reply, "refresh_token_expires_in") !== undefined
  )
    return refused("reply_expiring");
  const token = own(reply, "access_token");
  const scope = own(reply, "scope");
  if (typeof token !== "string" || !/^[\x21-\x7e]{16,512}$/.test(token))
    return refused("reply_token_shape");
  if (typeof scope !== "string") return refused("reply_scope_type");
  return Object.freeze({ kind: "token", token, scopes: scope });
}

export const shopifyAdminReasons = Object.freeze([
  ...shopifyHttpReasons,
  "deadline",
  "graphql_errors",
  "throttled",
  "reply_shape",
] as const);
export type ShopifyAdminReason = (typeof shopifyAdminReasons)[number];
export type ShopifyAdminReply =
  | Readonly<{ kind: "data"; data: unknown }>
  | Readonly<{ kind: "refused"; reason: ShopifyAdminReason }>
  | Readonly<{ kind: "unauthorized"; reason: "http_401" }>;
/**
 * One fixed Admin GraphQL document with its variables. A THROTTLED reply waits once, within
 * the deadline, until the bucket holds the query's cost again: Shopify's
 * extensions.cost.requestedQueryCost (or the document's known cost, shopifyReadCosts, when
 * the reply omits it) less currentlyAvailable, at restoreRate points a second (M2 PR-3
 * review: a page read costs about 27 points, so waiting for 10 left it throttled again).
 * A wait that would pass the deadline is refused at once. Any other error, status or shape
 * is refused (401 is unauthorized: the token was revoked; the uninstall webhook is the
 * state change, so a read changes nothing). The reply is bounded by `limit` bytes.
 */
export async function shopifyAdminGraphql(
  fetcher: ShopifyFetch,
  shop: string,
  token: string,
  document: string,
  variables: Readonly<Record<string, unknown>>,
  deadlineMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  limit: number = shopifyReplyMaxBytes,
): Promise<ShopifyAdminReply> {
  const refused = (reason: ShopifyAdminReason) =>
    Object.freeze({ kind: "refused" as const, reason });
  if (!shopPattern.test(shop)) return refused("input_shape");
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadlineMs - now();
    if (remaining <= 0) return refused("deadline");
    let response: Response;
    try {
      response = await fetcher(`https://${shop}/admin/api/${shopifyApiVersion}/graphql.json`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-shopify-access-token": token,
        },
        // The install's ShopIdentity takes no variables and sends none (M2 PR-2's body).
        body: JSON.stringify(
          Object.keys(variables).length === 0
            ? { query: document }
            : { query: document, variables },
        ),
        signal: AbortSignal.timeout(remaining),
      });
    } catch (error) {
      return refused(thrownReason(error));
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return response.status === 401
        ? Object.freeze({ kind: "unauthorized" as const, reason: "http_401" as const })
        : refused(statusReason(response.status));
    }
    const reply = await boundedJson(response, limit);
    if (reply === null) return refused("reply_json");
    const errors = own(reply, "errors");
    if (errors !== undefined) {
      const throttled =
        Array.isArray(errors) &&
        errors.length > 0 &&
        errors.every((e) => own(own(e, "extensions"), "code") === "THROTTLED");
      if (!throttled) return refused("graphql_errors");
      if (attempt > 0) return refused("throttled");
      const cost = own(own(reply, "extensions"), "cost");
      const status = own(cost, "throttleStatus");
      const available = own(status, "currentlyAvailable");
      const rate = own(status, "restoreRate");
      const reported = own(cost, "requestedQueryCost");
      const requested =
        typeof reported === "number" && Number.isFinite(reported) && reported > 0
          ? reported
          : shopifyDocumentCost(document);
      const wait =
        typeof available === "number" &&
        Number.isFinite(available) &&
        typeof rate === "number" &&
        Number.isFinite(rate) &&
        rate > 0
          ? Math.ceil((Math.max(0, requested - Math.max(0, available)) / rate) * 1000)
          : 1000;
      if (now() + wait >= deadlineMs) return refused("throttled");
      await sleep(wait);
      continue;
    }
    const data = own(reply, "data");
    if (data === undefined || data === null || typeof data !== "object")
      return refused("reply_shape");
    return Object.freeze({ kind: "data", data });
  }
  return refused("throttled");
}

export type ShopifyIdentity =
  | Readonly<{ kind: "identity"; shopId: string; domain: string; development: boolean }>
  | Readonly<{ kind: "refused"; reason: ShopifyAdminReason }>;
const shopGid = /^gid:\/\/shopify\/Shop\/([1-9][0-9]{0,19})$/;
/**
 * The one fixed Admin GraphQL read of the install (ShopIdentity): the shop's numeric id,
 * its myshopify domain and whether it is a Partner development store. THROTTLED waits for
 * the restore time once, within the budget.
 */
export async function readShopifyIdentity(
  fetcher: ShopifyFetch,
  shop: string,
  token: string,
  deadlineMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ShopifyIdentity> {
  const reply = await shopifyAdminGraphql(
    fetcher,
    shop,
    token,
    shopifyShopIdentityDocument,
    {},
    deadlineMs,
    now,
    sleep,
  );
  if (reply.kind !== "data") return Object.freeze({ kind: "refused", reason: reply.reason });
  const s = own(reply.data, "shop");
  const id = own(s, "id");
  const domain = own(s, "myshopifyDomain");
  const development = own(own(s, "plan"), "partnerDevelopment");
  const match = typeof id === "string" ? shopGid.exec(id) : null;
  if (!match || typeof domain !== "string" || domain !== shop || typeof development !== "boolean")
    return Object.freeze({ kind: "refused", reason: "reply_shape" });
  return Object.freeze({ kind: "identity", shopId: match[1]!, domain, development });
}

// v1 PR 5 (ADR-0025 item 10): the installation's granted scopes, read back with its own token
// (deliveries of app/scopes_update can arrive out of order). One fixed Admin GraphQL document
// with no variables; the reply keeps only the scope handles.
export const shopifyAccessScopesDocument =
  "query AccessScopes { currentAppInstallation { accessScopes { handle } } }";
export const shopifyAccessScopesMaxBytes = 16384;
export type ShopifyAccessScopes =
  | Readonly<{ kind: "scopes"; scopes: readonly string[] }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;
/**
 * The scopes Shopify holds for the app's installation: sorted, unique handles. `refused` is
 * Shopify refusing the token (401: uninstalled or revoked); anything else that is not a
 * well-formed answer (a transport failure, another status, a GraphQL error, a malformed or
 * oversize reply, more than 64 handles) is `unavailable`, which records nothing.
 */
export async function readShopifyAccessScopes(
  fetcher: ShopifyFetch,
  shop: string,
  token: string,
  deadlineMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ShopifyAccessScopes> {
  const unavailable = Object.freeze({ kind: "unavailable" as const });
  const reply = await shopifyAdminGraphql(
    fetcher,
    shop,
    token,
    shopifyAccessScopesDocument,
    {},
    deadlineMs,
    now,
    sleep,
    shopifyAccessScopesMaxBytes,
  );
  if (reply.kind === "unauthorized") return Object.freeze({ kind: "refused" });
  if (reply.kind !== "data") return unavailable;
  const list = own(own(reply.data, "currentAppInstallation"), "accessScopes");
  if (!Array.isArray(list) || list.length > 64) return unavailable;
  const handles = list.map((entry) => own(entry, "handle"));
  if (!handles.every((h): h is string => typeof h === "string" && /^[a-z][a-z_]{0,63}$/.test(h)))
    return unavailable;
  return Object.freeze({ kind: "scopes", scopes: Object.freeze([...new Set(handles)].sort()) });
}

/** The webhook signature: base64 HMAC-SHA256 of the raw body, compared in constant time. */
export async function verifyShopifyWebhookHmac(
  secret: string,
  body: Uint8Array,
  received: unknown,
): Promise<boolean> {
  if (typeof received !== "string" || !shopifyWebhookHmacPattern.test(received)) return false;
  return constantTimeEqual(await shopifyHmacBase64(secret, body), received);
}

// The minimised body of a verified compliance or app webhook (spine §11): ids, scope names
// and a keyed digest of the customer id only; never an email, phone, name or address. M2
// PR-3: the body must be its topic's (the topic header is not signed, so a body of another
// topic is refused rather than reread), and a body that names its shop must name the
// header's shop. Null when the body is not one of its topic.
//
// SD3 (P09.T05b; ADR-0031's 2026-10-26 note on item 1; ADR-0043 item 24): a customers/*
// request also keeps the order ids it lists, `orders_to_redact` as `ordersToRedact` and
// `orders_requested` as `ordersRequested`. Order ids are not customer data (CLAUDE.md), but an
// order id tied to a customer's request is pseudonymous personal data, so they live only in
// the inbox row, on its 7-day clock, until every handler has reported zero remaining; the
// deletion registry's "orders listed" matcher reads them (packages/work/src/redaction.ts).
const idText = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
      ? value
      : null;
/** The most order ids one compliance request may list (SD3; morrow_identity's validator). */
export const shopifyComplianceOrdersMax = 20000;
// A request's order list: present, an array of numeric ids (numbers or digit strings), at
// most shopifyComplianceOrdersMax; kept distinct and in ascending numeric order, as text.
// Null when absent or malformed, so the whole request is refused and Shopify retries it:
// a list Morrow could not read is never recorded as an empty one.
const orderIdList = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value) || value.length > shopifyComplianceOrdersMax) return null;
  const ids = new Set<string>();
  for (const entry of value) {
    const id = idText(entry);
    if (id === null) return null;
    ids.add(id);
  }
  return Object.freeze(
    [...ids].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)),
  );
};
const scopeList = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= 32 &&
  value.every((s) => typeof s === "string" && /^[a-z][a-z_]{0,63}$/.test(s))
    ? Object.freeze([...new Set(value as string[])].sort())
    : null;
const has = (body: object, key: string) => Object.hasOwn(body, key);
export async function minimiseShopifyWebhook(
  secret: string,
  topic: string,
  body: unknown,
  shop: string,
): Promise<Readonly<Record<string, string | readonly string[] | null>> | null> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const customerDigest = async (customer: unknown) => {
    const id = idText(own(customer, "id"));
    return id === null ? null : shopifyHmacHex(secret, "morrow.shopify.customer.v1|" + id);
  };
  // A compliance body names its shop by id and domain; the domain must be the header's.
  const compliance = () => {
    const shopId = idText(own(body, "shop_id"));
    return shopId !== null && own(body, "shop_domain") === shop ? shopId : null;
  };
  switch (topic) {
    case "app/uninstalled": {
      // The Shop resource: its id (and, when present, its myshopify domain, the header's).
      const shopId = idText(own(body, "id"));
      const domain = own(body, "myshopify_domain");
      if (
        shopId === null ||
        (domain !== undefined && domain !== shop) ||
        ["shop_id", "customer", "orders_to_redact", "data_request"].some((k) => has(body, k))
      )
        return null;
      return Object.freeze({ shopId });
    }
    case "app/scopes_update": {
      const previous = scopeList(own(body, "previous"));
      const current = scopeList(own(body, "current"));
      if (!previous || !current || ["shop_id", "customer"].some((k) => has(body, k))) return null;
      return Object.freeze({ previous, current });
    }
    case "customers/data_request": {
      const shopId = compliance();
      const dataRequestId = idText(own(own(body, "data_request"), "id"));
      const ordersRequested = orderIdList(own(body, "orders_requested"));
      if (
        shopId === null ||
        dataRequestId === null ||
        ordersRequested === null ||
        !has(body, "customer") ||
        has(body, "orders_to_redact")
      )
        return null;
      return Object.freeze({
        shopId,
        customerDigest: await customerDigest(own(body, "customer")),
        dataRequestId,
        ordersRequested,
      });
    }
    case "customers/redact": {
      const shopId = compliance();
      const ordersToRedact = orderIdList(own(body, "orders_to_redact"));
      if (
        shopId === null ||
        ordersToRedact === null ||
        !has(body, "customer") ||
        has(body, "data_request") ||
        has(body, "orders_requested")
      )
        return null;
      return Object.freeze({
        shopId,
        customerDigest: await customerDigest(own(body, "customer")),
        ordersToRedact,
      });
    }
    case "shop/redact": {
      const shopId = compliance();
      if (
        shopId === null ||
        ["customer", "orders_to_redact", "data_request", "orders_requested"].some((k) =>
          has(body, k),
        )
      )
        return null;
      return Object.freeze({ shopId });
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// M2 PR-3: the fixed read documents (spine §4), one per query, and the minimised result of
// each. Only ids, titles, a product's status and its listing fields leave Shopify's reply.
// The products page searches titles with Shopify's search syntax, built here from the
// closed variables (letters and digits only), never from caller text.
export const shopifyReadPageSize = 25;
export const shopifyReadDocuments = Object.freeze({
  shopIdentity: shopifyShopIdentityDocument,
  collectionsPage:
    "query CollectionsPage($first: Int!, $after: String) { collections(first: $first, after: $after, sortKey: TITLE) { nodes { id title } pageInfo { hasNextPage endCursor } } }",
  productsPage:
    "query ProductsPage($first: Int!, $after: String, $query: String) { products(first: $first, after: $after, query: $query, sortKey: TITLE) { nodes { id title status } pageInfo { hasNextPage endCursor } } }",
  collectionProductsPage:
    "query CollectionProductsPage($id: ID!, $first: Int!, $after: String) { collection(id: $id) { products(first: $first, after: $after) { nodes { id title status } pageInfo { hasNextPage endCursor } } } }",
  productContent:
    "query ProductContent($id: ID!) { product(id: $id) { id title descriptionHtml tags seo { title description } } }",
} as const);
// The requested cost of each fixed document as Shopify's calculator prices it (a connection
// is 2 plus its page size, each object 1, scalars 0). The THROTTLED wait uses it when the
// reply omits extensions.cost.requestedQueryCost.
export const shopifyReadCosts = Object.freeze({
  shopIdentity: 2,
  collectionsPage: 2 + shopifyReadPageSize,
  productsPage: 2 + shopifyReadPageSize,
  collectionProductsPage: 3 + shopifyReadPageSize,
  productContent: 2,
} as const satisfies Record<keyof typeof shopifyReadDocuments, number>);
/** A fixed document's known cost; an unknown one is priced as the dearest page. */
export function shopifyDocumentCost(document: string): number {
  for (const [name, text] of Object.entries(shopifyReadDocuments))
    if (text === document) return shopifyReadCosts[name as keyof typeof shopifyReadCosts];
  return Math.max(...Object.values(shopifyReadCosts));
}
const gidTail = (value: unknown, kind: "Product" | "Collection") => {
  const match =
    typeof value === "string"
      ? new RegExp(`^gid://shopify/${kind}/([1-9][0-9]{0,19})$`).exec(value)
      : null;
  return match ? match[1]! : null;
};
const text = (value: unknown): value is string => typeof value === "string";
/** One page of nodes and its next cursor, or null. */
function pageOf(connection: unknown, node: (n: unknown) => unknown | null) {
  const nodes = own(connection, "nodes");
  const info = own(connection, "pageInfo");
  const next = own(info, "hasNextPage");
  const cursor = own(info, "endCursor");
  if (!Array.isArray(nodes) || nodes.length > shopifyReadPageSize || typeof next !== "boolean")
    return null;
  const mapped = nodes.map(node);
  if (mapped.some((n) => n === null)) return null;
  if (next && (!text(cursor) || !/^[A-Za-z0-9+/=_-]{1,1536}$/.test(cursor))) return null;
  return { items: mapped, nextCursor: next ? (cursor as string) : null };
}
const productNode = (n: unknown) => {
  const id = gidTail(own(n, "id"), "Product");
  const title = own(n, "title");
  const status = own(n, "status");
  return id && text(title) && text(status) && /^[A-Z][A-Z_]{0,31}$/.test(status)
    ? { id: "product:" + id, title, status: status.toLowerCase() }
    : null;
};
/**
 * The minimised result of one read reply, as the protocol's closed JSON value, or null
 * when the reply is not the document's shape. `products` with a collection id reads that
 * collection's products; a missing collection or product is not_found.
 */
export function shopifyReadResult(
  query:
    | "shopIdentity"
    | "collectionsPage"
    | "productsPage"
    | "collectionProductsPage"
    | "productContent",
  data: unknown,
  shop: string,
): Record<string, unknown> | null {
  switch (query) {
    case "shopIdentity": {
      const s = own(data, "shop");
      const id = own(s, "id");
      const development = own(own(s, "plan"), "partnerDevelopment");
      const match = text(id) ? shopGid.exec(id) : null;
      if (!match || own(s, "myshopifyDomain") !== shop || typeof development !== "boolean")
        return null;
      return { schemaVersion: 1, outcome: "read", shop: { shopId: match[1], development } };
    }
    case "collectionsPage": {
      const page = pageOf(own(data, "collections"), (n) => {
        const id = gidTail(own(n, "id"), "Collection");
        const title = own(n, "title");
        return id && text(title) ? { id: "collection:" + id, title } : null;
      });
      return page
        ? {
            schemaVersion: 1,
            outcome: "read",
            collections: page.items,
            nextCursor: page.nextCursor,
          }
        : null;
    }
    case "productsPage":
    case "collectionProductsPage": {
      let connection = own(data, "products");
      if (query === "collectionProductsPage") {
        const collection = own(data, "collection");
        if (collection === null) return { schemaVersion: 1, outcome: "not_found" };
        connection = own(collection, "products");
      }
      const page = pageOf(connection, productNode);
      return page
        ? { schemaVersion: 1, outcome: "read", products: page.items, nextCursor: page.nextCursor }
        : null;
    }
    case "productContent": {
      const p = own(data, "product");
      if (p === null) return { schemaVersion: 1, outcome: "not_found" };
      const id = gidTail(own(p, "id"), "Product");
      const title = own(p, "title");
      const descriptionHtml = own(p, "descriptionHtml");
      const tags = own(p, "tags");
      const seo = own(p, "seo");
      const seoTitle = own(seo, "title");
      const seoDescription = own(seo, "description");
      if (
        !id ||
        !text(title) ||
        !text(descriptionHtml) ||
        !Array.isArray(tags) ||
        !tags.every(text) ||
        !(seoTitle === null || text(seoTitle)) ||
        !(seoDescription === null || text(seoDescription))
      )
        return null;
      return {
        schemaVersion: 1,
        outcome: "read",
        product: {
          productId: "product:" + id,
          title,
          descriptionHtml,
          seo: { title: seoTitle, description: seoDescription },
          tags: [...tags],
        },
      };
    }
  }
}
