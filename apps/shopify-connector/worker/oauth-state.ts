// The OAuth state of one launch (M2 PR-2; ADR-0022 item 6). 32 random bytes as canonical
// base64url: the connector keeps it in a __Host- cookie on its own hostname (Secure,
// HttpOnly, SameSite=Lax so Shopify's top-level redirect carries it, Path=/, 10 minutes)
// and stores only its sha256 digest through its own login. The callback requires the
// cookie to equal the query's state (constant time) before any broker call, and always
// clears it. The Morrow session cookie never reaches this host.
import { shopifySecretPattern } from "../../../packages/identity/src/broker-protocol.js";

export const stateCookieName = "__Host-morrow_shopify_state";
export const stateCookieMaxAgeSeconds = 600;
export const stateCookieClear = `${stateCookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
const encoder = new TextEncoder();

export function newOAuthState(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  let text = "";
  for (const byte of raw) text += String.fromCharCode(byte);
  raw.fill(0);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export async function oauthStateDigest(state: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(state)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function stateCookie(state: string): string {
  if (!shopifySecretPattern.test(state)) throw Error("CONNECTOR_STATE_INVALID");
  return `${stateCookieName}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${stateCookieMaxAgeSeconds}`;
}
/** The one state cookie of a Cookie header, or null (absent, repeated or malformed). */
export function readStateCookie(header: string | null): string | null {
  if (header === null || header.length > 4096) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(stateCookieName + "="))
    .map((part) => part.slice(stateCookieName.length + 1));
  if (values.length !== 1) return null;
  const value = values[0]!;
  return shopifySecretPattern.test(value) ? value : null;
}
export function sameState(a: string, b: string): boolean {
  if (a.length !== 43 || b.length !== 43) return false;
  let different = 0;
  for (let i = 0; i < 43; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}
