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
import { limitAddress, type RateLimiter } from "../../../packages/identity/src/edge-limiter.js";
// The address key moved to packages/identity/src/edge-limiter.ts (M2 PR-2 review: the
// connector's Shopify ingress limits use the same key); re-exported unchanged.
export {
  ipv6LimiterPrefixBits,
  limiterKey,
  limiterSubject,
  type RateLimiter,
} from "../../../packages/identity/src/edge-limiter.js";

// P05.T01ab hosted sign-in abuse protection (ADR-0019 items 6-8; P04.T01i D5). It runs
// in the api Worker before the router, so before any SQL, and selects requests with
// the router's own matcher (`managedApiRoute`): login start, the callback and signup.
// Step 0 counts only a request its handler could accept on headers alone, so no
// third-party page can spend a visitor's (or their NAT's) budget with requests a
// browser sends cross-site without a CORS preflight. Step 1 is a per-address Workers
// rate limit; step 2, on login start and signup, is one Turnstile verification
// through the broker. A passed request loses only its X-Morrow-Challenge header; its
// body is never read. Rejections (429, 403) log nothing; only fail-closed causes log
// one fixed-code `morrow_edge_guard` line. The client address is hashed for the key
// and never stored, logged or used for authority.

export interface AbuseGuardLimiters {
  readonly loginStart: RateLimiter;
  readonly loginCallback: RateLimiter;
  readonly signup: RateLimiter;
  // The session routes' limiter, mapped with the sign-in limiters (environment.ts step 10)
  // and used only by session-limit.ts; this guard never counts against it.
  readonly session: RateLimiter;
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
  ["SESSION_LIMITER", "session"],
] as const);
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

const loginUnavailable = '{"schemaVersion":1,"outcome":"login_unavailable"}';
interface GuardedRoute {
  readonly key: "login" | "callback" | "signup";
  readonly limiter: keyof AbuseGuardLimiters;
  // The only method the route's handler accepts; the router answers any other 405.
  readonly method: "POST" | "GET";
  // The challenge action of a POST route; the callback has none.
  readonly action: ChallengeActionName | null;
  // The route's existing 503 body, and its 403 body for a missing X-Morrow-Request.
  readonly unavailable: string;
  readonly denied: string;
}
const guardedRoutes: Readonly<Partial<Record<ManagedApiRoute, GuardedRoute>>> = Object.freeze({
  login_start: {
    key: "login",
    limiter: "loginStart",
    method: "POST",
    action: "login",
    unavailable: loginUnavailable,
    denied: loginUnavailable,
  },
  login_callback: {
    key: "callback",
    limiter: "loginCallback",
    method: "GET",
    action: null,
    unavailable: loginUnavailable,
    denied: loginUnavailable,
  },
  signup: {
    key: "signup",
    limiter: "signup",
    method: "POST",
    action: "signup",
    unavailable: '{"code":"unavailable"}',
    denied: '{"code":"request_denied"}',
  },
});

const baseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;
export function edgeReply(
  status: number,
  body: string,
  head = false,
  extra: Record<string, string> = {},
) {
  return new Response(head ? null : body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...baseHeaders, ...extra },
  });
}
const reply = edgeReply;
// The callback handler's own failure: 303 to the result page, no body.
const failedCallback = () =>
  new Response(null, { status: 303, headers: { location: "/auth/result", ...baseHeaders } });
// The callback handler's Fetch Metadata rule: a top-level document navigation, or a
// client that sends no Fetch Metadata. An <img>, a no-cors or cors fetch, a frame or a
// prefetch is not one.
function topLevelNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  return (mode === null || mode === "navigate") && (dest === null || dest === "document");
}
const outcome = (value: string) => JSON.stringify({ schemaVersion: 1, outcome: value });
// The one over-the-limit reply of every per-address limit in this Worker (SignInGuardOutcome).
export const edgeRateLimited = () =>
  reply(429, outcome("rate_limited"), false, { "retry-after": "60" });
// The one fixed-code line of a fail-closed edge refusal; it never carries a value.
export const logEdgeGuard = (code: EdgeGuardCode) =>
  console.log(JSON.stringify({ event: "morrow_edge_guard", code }));
const logGuard = logEdgeGuard;
// The fail-closed code of a limit outcome other than "allowed" or "limited".
export const edgeLimitFailure = (limit: "address_missing" | "address_invalid" | "failed") =>
  limit === "address_missing"
    ? "ADDRESS_MISSING"
    : limit === "address_invalid"
      ? "ADDRESS_INVALID"
      : "LIMITER_FAILED";

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
    if (!route || (!limiters && !challenge)) return next(request);
    // Step 0, uncounted and before any broker call. Another method is the router's own
    // 405, as before (no SQL; the challenge never applied to it). A POST without
    // X-Morrow-Request, a custom header that a cross-site page can send only after a
    // preflight the router refuses, is the route's own 403. A callback GET that Fetch
    // Metadata marks as no top-level navigation is the handler's own failed-callback
    // redirect. The guard answers the last two itself, so they reach neither the
    // broker nor the router, whatever the handlers later accept.
    if (request.method !== route.method) return next(request);
    if (route.action !== null) {
      if (request.headers.get("x-morrow-request") !== "1") return reply(403, route.denied);
    } else if (!topLevelNavigation(request)) return failedCallback();
    // Step 1: the per-address limit.
    if (limiters) {
      const limit = await limitAddress(
        limiters[route.limiter],
        route.key,
        request.headers.get("cf-connecting-ip"),
      );
      if (limit === "limited") return edgeRateLimited();
      if (limit !== "allowed") {
        logGuard(edgeLimitFailure(limit));
        return reply(503, route.unavailable);
      }
    }
    // Step 2: one challenge verification, on login start and signup (POST, after step 0).
    if (challenge && route.action !== null) {
      const token = request.headers.get(challengeHeader);
      if (!challengeTokenValid(token)) return reply(403, outcome("challenge_required"));
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
      if (verdict === "failed") return reply(403, outcome("challenge_failed"));
      // Held, timed out or anything but a verdict: the route's existing 503.
      if (verdict !== "passed") {
        logGuard("CHALLENGE_HELD");
        return reply(503, route.unavailable);
      }
      return next(withoutChallenge(request));
    }
    return next(request);
  };
  return Object.freeze({ configurationResponse, handle });
}
export type AbuseGuard = ReturnType<typeof createAbuseGuard>;
