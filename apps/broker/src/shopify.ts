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
//     non-expiring offline token requested; never retried (a code is single use).
//   * One fixed Admin GraphQL document (API version 2026-10): ShopIdentity.
// Replies are bounded, redirects are never followed, and every failure is a fixed code:
// no provider text, token, secret or value reaches a log, an error or a verdict.

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

/**
 * The checks of a Shopify-signed admin query that need no secret: hmac is 64 lowercase
 * hex, the timestamp is an integer within the tolerance, the shop is a *.myshopify.com
 * domain, and there is no signature parameter. The broker runs this before it opens any
 * vault transaction, so an unsigned or stale request costs no database work (an attacker
 * can still forge the shape; the edge limiter bounds that). Returns the parsed query, or
 * null.
 */
export function shopifyQueryShape(
  raw: unknown,
  nowSeconds: number,
  toleranceSeconds = 90,
): ShopifyQuery | null {
  const query = parseShopifyQuery(raw);
  if (!query) return null;
  const hmac = query.params.get("hmac");
  const timestamp = query.params.get("timestamp");
  const shop = query.params.get("shop");
  if (
    hmac === undefined ||
    !/^[a-f0-9]{64}$/.test(hmac) ||
    timestamp === undefined ||
    !/^[1-9][0-9]{0,11}$/.test(timestamp) ||
    Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds ||
    shop === undefined ||
    !shopPattern.test(shop) ||
    query.params.has("signature")
  )
    return null;
  return query;
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

export type ShopifyExchange =
  | Readonly<{ kind: "token"; token: string; scopes: string }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "uncertain" }>;
/**
 * The authorization-code exchange for a non-expiring offline token. Sent once and never
 * retried. A transport failure, a timeout or a 5xx after sending is `uncertain` (the code
 * may have been consumed); a 4xx or a malformed, online or expiring reply is `refused`.
 */
export async function exchangeShopifyCode(
  fetcher: ShopifyFetch,
  shop: string,
  clientId: string,
  secret: string,
  code: string,
  timeoutMs: number,
): Promise<ShopifyExchange> {
  if (
    !shopPattern.test(shop) ||
    !/^[a-f0-9]{32}$/.test(clientId) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(code)
  )
    return Object.freeze({ kind: "refused" });
  let response: Response;
  try {
    response = await fetcher(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, code, expiring: "0" }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch {
    return Object.freeze({ kind: "uncertain" });
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return Object.freeze({ kind: "uncertain" });
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return Object.freeze({ kind: "refused" });
  }
  const reply = await boundedJson(response, 8192);
  const token = own(reply, "access_token");
  const scope = own(reply, "scope");
  if (
    typeof token !== "string" ||
    !/^[\x21-\x7e]{16,512}$/.test(token) ||
    typeof scope !== "string" ||
    own(reply, "expires_in") !== undefined ||
    own(reply, "associated_user") !== undefined ||
    own(reply, "refresh_token") !== undefined
  )
    return Object.freeze({ kind: "refused" });
  return Object.freeze({ kind: "token", token, scopes: scope });
}

export type ShopifyIdentity =
  | Readonly<{ kind: "identity"; shopId: string; domain: string; development: boolean }>
  | Readonly<{ kind: "refused" }>;
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
  const refused = Object.freeze({ kind: "refused" as const });
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadlineMs - now();
    if (remaining <= 0) return refused;
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
        body: JSON.stringify({ query: shopifyShopIdentityDocument }),
        signal: AbortSignal.timeout(remaining),
      });
    } catch {
      return refused;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return refused;
    }
    const reply = await boundedJson(response, shopifyReplyMaxBytes);
    const errors = own(reply, "errors");
    if (errors !== undefined) {
      const throttled =
        Array.isArray(errors) &&
        errors.length > 0 &&
        errors.every((e) => own(own(e, "extensions"), "code") === "THROTTLED");
      if (!throttled || attempt > 0) return refused;
      const status = own(own(own(reply, "extensions"), "cost"), "throttleStatus");
      const available = own(status, "currentlyAvailable");
      const rate = own(status, "restoreRate");
      const wait =
        typeof available === "number" && typeof rate === "number" && rate > 0
          ? Math.ceil(((10 - Math.min(available, 10)) / rate) * 1000)
          : 1000;
      if (now() + wait >= deadlineMs) return refused;
      await sleep(wait);
      continue;
    }
    const s = own(own(reply, "data"), "shop");
    const id = own(s, "id");
    const domain = own(s, "myshopifyDomain");
    const development = own(own(s, "plan"), "partnerDevelopment");
    const match =
      typeof id === "string" ? /^gid:\/\/shopify\/Shop\/([1-9][0-9]{0,19})$/.exec(id) : null;
    if (!match || typeof domain !== "string" || domain !== shop || typeof development !== "boolean")
      return refused;
    return Object.freeze({ kind: "identity", shopId: match[1]!, domain, development });
  }
  return refused;
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

// The minimised body of a verified compliance or app webhook (spine §11): ids and a keyed
// digest of the customer id only; never an email, phone, name, address or order id.
const idText = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)
      ? value
      : null;
export async function minimiseShopifyWebhook(
  secret: string,
  topic: string,
  body: unknown,
): Promise<Readonly<Record<string, string | readonly string[] | null>> | null> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const customerDigest = async (customer: unknown) => {
    const id = idText(own(customer, "id"));
    return id === null ? null : shopifyHmacHex(secret, "morrow.shopify.customer.v1|" + id);
  };
  switch (topic) {
    case "app/uninstalled":
      return Object.freeze({ shopId: idText(own(body, "id")) });
    case "app/scopes_update": {
      const list = (value: unknown) =>
        Array.isArray(value) &&
        value.length <= 32 &&
        value.every((s) => typeof s === "string" && /^[a-z][a-z_]{0,63}$/.test(s))
          ? Object.freeze([...(value as string[])].sort())
          : null;
      return Object.freeze({
        previous: list(own(body, "previous")),
        current: list(own(body, "current")),
      });
    }
    case "customers/data_request":
      return Object.freeze({
        shopId: idText(own(body, "shop_id")),
        customerDigest: await customerDigest(own(body, "customer")),
        dataRequestId: idText(own(own(body, "data_request"), "id")),
      });
    case "customers/redact":
      return Object.freeze({
        shopId: idText(own(body, "shop_id")),
        customerDigest: await customerDigest(own(body, "customer")),
      });
    case "shop/redact":
      return Object.freeze({ shopId: idText(own(body, "shop_id")) });
    default:
      return null;
  }
}
