import {
  challengeTokenValid,
  parseChallengeActions,
  turnstileKeyPattern,
  type ChallengeActionName,
  type ChallengeActions,
  type ChallengeVerdict,
} from "../../../packages/identity/src/broker-protocol.js";
import {
  managedApiRoute,
  type ManagedApiRoute,
} from "../../../packages/identity/src/managed-workspace-api.js";
import { loginJson } from "../../../packages/identity/src/standalone-login-protocol.js";

// P05.T01ab hosted sign-in abuse protection (ADR-0019 items 6-8; P04.T01i D5). It runs
// in the api Worker before the router, so before any SQL, and selects requests with
// the router's own matcher (`managedApiRoute`): login start, the callback and signup,
// for every method the router dispatches to them. Step 1 is a per-address Workers rate
// limit; step 2, on POST to login start and signup only, is one Turnstile verification
// through the broker. A passed request loses only its X-Morrow-Challenge header; its
// body is never read. Rejections (429, 403) log nothing; only fail-closed causes log
// one fixed-code `morrow_edge_guard` line. The client address is hashed for the key
// and never stored, logged or used for authority.

export interface RateLimiter {
  limit(options: { key: string }): Promise<unknown>;
}
export interface AbuseGuardLimiters {
  readonly loginStart: RateLimiter;
  readonly loginCallback: RateLimiter;
  readonly signup: RateLimiter;
}
export interface LoginChallengeConfiguration {
  readonly schemaVersion: 1;
  readonly provider: "turnstile";
  readonly siteKey: string;
  readonly actions: ChallengeActions;
}
export interface AbuseGuardConfiguration {
  readonly challenge: Readonly<LoginChallengeConfiguration> | null;
  readonly limiters: Readonly<AbuseGuardLimiters> | null;
}
export type ChallengeVerifier = (
  action: string,
  token: string,
  budgetMs: number,
  signal: AbortSignal,
) => Promise<ChallengeVerdict>;
export type EdgeGuardCode =
  | "ADDRESS_MISSING"
  | "ADDRESS_INVALID"
  | "LIMITER_FAILED"
  | "CHALLENGE_HELD";

export const abuseGuardLimiterBindings = Object.freeze([
  ["LOGIN_START_LIMITER", "loginStart"],
  ["LOGIN_CALLBACK_LIMITER", "loginCallback"],
  ["SIGNUP_LIMITER", "signup"],
] as const);
// The reviewed IPv6 aggregation (48, 56 or 64): one /56 is one customer site.
export const ipv6LimiterPrefixBits = 56;
// The budget of the one challengeVerify call (1 to challengeLimits.budgetMaxMs).
export const challengeBudgetMs = 3000;
export const challengeHeader = "x-morrow-challenge";

// LOGIN_CHALLENGE_JSON: {"schemaVersion":1,"provider":"turnstile","siteKey":"0x…",
// "actions":{"login":"…","signup":"…"}}, closed and at most 2048 bytes.
export function parseLoginChallengeConfiguration(
  value: unknown,
): Readonly<LoginChallengeConfiguration> {
  const parsed = loginJson(value, 2048, ["schemaVersion", "provider", "siteKey", "actions"]);
  const siteKey = parsed.siteKey;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.provider !== "turnstile" ||
    typeof siteKey !== "string" ||
    turnstileKeyPattern.exec(siteKey)?.[0] !== siteKey
  )
    throw Error("API_CHALLENGE_CONFIGURATION_INVALID");
  return Object.freeze({
    schemaVersion: 1,
    provider: "turnstile",
    siteKey,
    actions: parseChallengeActions(parsed.actions),
  });
}

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

const loginUnavailable = '{"schemaVersion":1,"outcome":"login_unavailable"}';
const signupUnavailable = '{"code":"unavailable"}';
interface GuardedRoute {
  readonly key: "login" | "callback" | "signup";
  readonly limiter: keyof AbuseGuardLimiters;
  readonly action: ChallengeActionName | null;
  // The route's existing 503 body.
  readonly unavailable: string;
}
const guardedRoutes: Readonly<Partial<Record<ManagedApiRoute, GuardedRoute>>> = Object.freeze({
  login_start: {
    key: "login",
    limiter: "loginStart",
    action: "login",
    unavailable: loginUnavailable,
  },
  login_callback: {
    key: "callback",
    limiter: "loginCallback",
    action: null,
    unavailable: loginUnavailable,
  },
  signup: { key: "signup", limiter: "signup", action: "signup", unavailable: signupUnavailable },
});

function reply(status: number, body: string, head: boolean, extra: Record<string, string> = {}) {
  return new Response(head ? null : body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...extra,
    },
  });
}
const outcome = (value: string) => JSON.stringify({ schemaVersion: 1, outcome: value });
const logGuard = (code: EdgeGuardCode) =>
  console.log(JSON.stringify({ event: "morrow_edge_guard", code }));

// Deletes only X-Morrow-Challenge; method, URL, the other headers, the unread body
// stream and the signal stay the request's own.
function withoutChallenge(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(challengeHeader);
  return new Request(request, { headers });
}

export function createAbuseGuard(
  configuration: Readonly<AbuseGuardConfiguration>,
  verify: ChallengeVerifier,
) {
  const { challenge, limiters } = configuration;
  // GET /auth/challenge: the public widget configuration, or provider none.
  const configurationResponse = (request: Request): Response => {
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head)
      return reply(405, '{"code":"method_not_allowed"}', false, { allow: "GET, HEAD" });
    const body = challenge
      ? JSON.stringify({
          schemaVersion: 1,
          provider: "turnstile",
          siteKey: challenge.siteKey,
          actions: { login: challenge.actions.login, signup: challenge.actions.signup },
        })
      : '{"provider":"none"}';
    return reply(200, body, head);
  };
  const handle = async (
    request: Request,
    next: (request: Request) => Promise<Response>,
  ): Promise<Response> => {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return next(request);
    }
    const route = guardedRoutes[managedApiRoute(pathname)];
    if (!route) return next(request);
    const head = request.method === "HEAD";
    // Step 1: the per-address limit, on every method of the route.
    if (limiters) {
      const address = request.headers.get("cf-connecting-ip");
      if (address === null) {
        logGuard("ADDRESS_MISSING");
        return reply(503, route.unavailable, head);
      }
      const subject = limiterSubject(address);
      if (subject === null) {
        logGuard("ADDRESS_INVALID");
        return reply(503, route.unavailable, head);
      }
      let allowed: boolean;
      try {
        const result: unknown = await limiters[route.limiter].limit({
          key: await limiterKey(route.key, subject),
        });
        const success =
          result !== null && typeof result === "object"
            ? (result as { success?: unknown }).success
            : undefined;
        if (typeof success !== "boolean") throw Error("LIMITER_REPLY_INVALID");
        allowed = success;
      } catch {
        logGuard("LIMITER_FAILED");
        return reply(503, route.unavailable, head);
      }
      if (!allowed) return reply(429, outcome("rate_limited"), head, { "retry-after": "60" });
    }
    // Step 2: one challenge verification, on POST to login start and signup only.
    if (challenge && route.action && request.method === "POST") {
      const token = request.headers.get(challengeHeader);
      if (!challengeTokenValid(token)) return reply(403, outcome("challenge_required"), false);
      let verdict: unknown;
      try {
        verdict = await verify(
          challenge.actions[route.action],
          token,
          challengeBudgetMs,
          request.signal,
        );
      } catch {
        verdict = undefined;
      }
      if (verdict === "failed") return reply(403, outcome("challenge_failed"), false);
      // Held, timed out or anything but a verdict: the route's existing 503.
      if (verdict !== "passed") {
        logGuard("CHALLENGE_HELD");
        return reply(503, route.unavailable, false);
      }
      return next(withoutChallenge(request));
    }
    return next(request);
  };
  return Object.freeze({ configurationResponse, handle });
}
export type AbuseGuard = ReturnType<typeof createAbuseGuard>;
