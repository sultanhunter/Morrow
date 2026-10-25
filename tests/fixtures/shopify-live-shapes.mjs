// fix-shopify-install-live: the shapes Shopify sends and answers in 2026, as its
// documentation describes them, with synthetic values only (no live store, token or secret
// was read to write this file). The broker's tests and labs sign and serve them through
// the same fakes as before; what is fixed here is the set of keys and the value classes.
//   * The app-open launch: Shopify admin opens the app's application_url with a signed
//     query. A non-embedded app gets hmac, host, shop and timestamp; an embedded one also
//     embedded=1, id_token (a session-token JWT, ~700 bytes), locale and session. Shopify
//     may add more lowercase keys; each is signed and is data
//     (https://shopify.dev/docs/apps/build/authentication-authorization/app-installation).
//   * The OAuth callback: code, hmac, host, shop, state and timestamp
//     (https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant).
//   * The code exchange's replies: a non-expiring offline token is {access_token, scope}; an
//     expiring one adds expires_in (3600: one hour), refresh_token and
//     refresh_token_expires_in (7776000: 90 days); an online one adds expires_in,
//     associated_user_scope and associated_user
//     (https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/offline-access-tokens).
//     Public apps created on or after 2026-04-01 cannot use non-expiring offline tokens for
//     Admin GraphQL requests; custom apps and merchant-created apps are exempt
//     (https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-public-apps-april-1-2026).
//     Shopify does not document the rejection's body, so `publicAppNonExpiring403` is a
//     403 with a synthetic error text: only its status is relied on.
import { createHmac, randomBytes } from "node:crypto";

const b64url = (value) => Buffer.from(value).toString("base64url");
/** The admin's `host`: base64url of the admin path, without padding. */
export const shopifyHost = (shop) => b64url(`admin.shopify.com/store/${shop.split(".")[0]}`);
/** A session-token-shaped JWT (HS256 over synthetic claims); the broker never reads it. */
export function shopifyIdToken(shop, clientId, nowSeconds) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: clientId,
      sub: "74880049153",
      exp: nowSeconds + 60,
      nbf: nowSeconds - 5,
      iat: nowSeconds - 5,
      jti: randomBytes(16).toString("hex"),
      sid: randomBytes(32).toString("hex"),
      sig: randomBytes(32).toString("hex"),
    }),
  );
  const signature = createHmac("sha256", "synthetic").update(`${header}.${payload}`);
  return `${header}.${payload}.${signature.digest("base64url")}`;
}
/** The app-open launch's parameters, unsigned (the caller signs with the app secret). */
export function shopifyAppOpenParams({ shop, clientId, nowSeconds, embedded }) {
  const base = { host: shopifyHost(shop), shop, timestamp: String(nowSeconds) };
  if (!embedded) return base;
  return {
    ...base,
    embedded: "1",
    id_token: shopifyIdToken(shop, clientId, nowSeconds),
    locale: "en-GB",
    session: randomBytes(32).toString("hex"),
  };
}
/** The callback's parameters, unsigned. */
export const shopifyCallbackParams = ({ shop, state, code, nowSeconds }) => ({
  code,
  host: shopifyHost(shop),
  shop,
  state,
  timestamp: String(nowSeconds),
});

/** Synthetic tokens of Shopify's prefixes: shpat_ (access) and shprt_ (refresh). */
export const shopifyAccessToken = () => "shpat_" + randomBytes(16).toString("hex");
export const shopifyRefreshToken = () => "shprt_" + randomBytes(16).toString("hex");
export const shopifyExchangeReplies = Object.freeze({
  nonExpiring: (token, scope = "write_products") => ({ access_token: token, scope }),
  expiring: (token, refresh, scope = "write_products") => ({
    access_token: token,
    expires_in: 3600,
    refresh_token: refresh,
    refresh_token_expires_in: 7776000,
    scope,
  }),
  online: (token, scope = "write_products") => ({
    access_token: token,
    scope,
    expires_in: 86399,
    associated_user_scope: scope,
    associated_user: {
      id: 902541635,
      first_name: "Synthetic",
      last_name: "Person",
      email: "synthetic@example.test",
      email_verified: true,
      account_owner: true,
      locale: "en",
      collaborator: false,
    },
  }),
});
export const publicAppNonExpiring403 = Object.freeze({
  status: 403,
  body: { errors: "[API] Non-expiring access tokens are no longer accepted (synthetic)." },
});
