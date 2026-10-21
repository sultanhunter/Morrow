// The per-address Workers rate-limit key (P05.T01ab, ADR-0019 item 8), shared by the api's
// sign-in abuse guard (apps/api/src/abuse-guard.ts) and, since the M2 PR-2 review, the
// connector's Shopify ingress limits (apps/shopify-connector/worker/connector.ts). The
// client address comes from CF-Connecting-IP; it is hashed for the key and never stored,
// logged or used for authority. Only WebCrypto: the connector bundle may include this
// file (scripts/edge.mjs connectorPackageAllowlist).

export interface RateLimiter {
  limit(options: { key: string }): Promise<unknown>;
}
// The reviewed IPv6 aggregation (48, 56 or 64): one /56 is one customer site.
export const ipv6LimiterPrefixBits = 56;

const ipv4Pattern =
  /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;
function ipv6Bytes(text: string): Uint8Array | null {
  if (text.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  let head = text;
  if (text.includes(".")) {
    const split = text.lastIndexOf(":");
    const v4 = text.slice(split + 1);
    if (split < 0 || !ipv4Pattern.test(v4)) return null;
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    head =
      text.slice(0, split + 1) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    if (left.length + right.length > 7) return null;
    groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  } else groups = left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9A-Fa-f]{1,4}$/.test(group))) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = parseInt(group, 16);
    bytes[2 * i] = value >> 8;
    bytes[2 * i + 1] = value & 0xff;
  });
  return bytes;
}
const hex = (bytes: Uint8Array) => [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");

// The limiter subject: an IPv4 address, or an IPv6 address cut to its /56 prefix
// (an IPv4-mapped IPv6 address is its IPv4 address). null when it is not an address.
export function limiterSubject(value: string): string | null {
  if (ipv4Pattern.test(value)) return "ipv4:" + value;
  const bytes = ipv6Bytes(value);
  if (!bytes) return null;
  if (bytes.slice(0, 10).every((v) => v === 0) && bytes[10] === 0xff && bytes[11] === 0xff)
    return "ipv4:" + [...bytes.slice(12)].join(".");
  return `ipv6/${ipv6LimiterPrefixBits}:` + hex(bytes.slice(0, ipv6LimiterPrefixBits / 8));
}
// `<route>:` plus 32 hex characters of SHA-256 over the subject.
export async function limiterKey(route: string, subject: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return route + ":" + hex(new Uint8Array(digest)).slice(0, 32);
}

export type AddressLimit = "allowed" | "limited" | "address_missing" | "address_invalid" | "failed";
/**
 * One count against `limiter` for the request's CF-Connecting-IP under `route`. Every
 * outcome but "allowed" refuses the request: "limited" is the caller's 429, the others
 * fail closed (the caller's 503).
 */
export async function limitAddress(
  limiter: RateLimiter,
  route: string,
  address: string | null,
): Promise<AddressLimit> {
  if (address === null) return "address_missing";
  const subject = limiterSubject(address);
  if (subject === null) return "address_invalid";
  try {
    const result: unknown = await limiter.limit({ key: await limiterKey(route, subject) });
    const success =
      result !== null && typeof result === "object"
        ? (result as { success?: unknown }).success
        : undefined;
    if (typeof success !== "boolean") return "failed";
    return success ? "allowed" : "limited";
  } catch {
    return "failed";
  }
}
