import {
  managedApiRoute,
  type ManagedApiRoute,
} from "../../../packages/identity/src/managed-workspace-api.js";
import { limitAddress, type RateLimiter } from "../../../packages/identity/src/edge-limiter.js";
import { sessionCookieSecret } from "../../../packages/identity/src/request-primitives.js";
import { billingUnavailableResponse } from "../../../packages/work/src/billing/http.js";
import { workErrorResponse, workRateLimitedResponse } from "../../../packages/work/src/http.js";
import { edgeLimitFailure, edgeRateLimited, edgeReply, logEdgeGuard } from "./abuse-guard.js";
import { apiDispatch } from "./worker.js";

// The per-address limit of the session routes (ADR-0019 item 8 applied to them; the
// pre-publication sweep, 2026-10-22). Every route the router hands a session cookie to, and
// that can reach SQL, is limited per address: signup by the abuse guard's SIGNUP_LIMITER
// (abuse-guard.ts), and the rest here, by SESSION_LIMITER, 120 per 60 s: the workspace
// handler's paths (/workspaces and /workspace/*, which include the work, billing, agents and
// catalogue APIs) and logout and rotate. It runs in the api Worker before the router, so before any
// broker lease or SQL, and selects requests with the router's own matcher
// (`managedApiRoute`).
//
// Step 0 counts only a request carrying exactly one canonical `__Host-morrow_session`
// cookie (`sessionCookieSecret`, the function every session handler uses): each handler
// refuses every other request with its own 401 or 403 before any lease or SQL (logout's
// cookie rule is stricter still), so an uncounted request never reaches the database. A
// third-party page cannot make a visitor's browser attach the SameSite=Lax cookie to a
// subresource, fetch or cross-site POST, so it cannot spend the visitor's (or their NAT's)
// budget. Step 1 is one count per address under the route's own key: over the limit is 429
// rate_limited with Retry-After: 60, in the route family's own shape (the sign-in routes'
// SignInGuardOutcome, or the ErrorEnvelope on a work, billing, agents or catalog path); a
// missing or invalid address or a failed limiter is the route's existing 503 and one fixed-code
// `morrow_edge_guard` line. A 429 logs nothing. A passed request is forwarded unchanged, its
// body unread. The address is hashed for the key and never stored, logged or used for
// authority.
//
// The keys (the PR review, 2026-10-22): the workspace handler's paths count under
// `session`, logout under `session_logout` and rotate under `session_rotate`, each 120 per
// 60 s in the one SESSION_LIMITER namespace. Read and work traffic from an address (a busy
// NAT, or a flood of random canonical cookies) then cannot hold that address's sign-out or
// the session keeper's rotation. A peer on the same address that floods logout or rotate
// itself still can while it keeps sending; the SPA then shows sign-out as not done
// (unavailable), never as done. docs/contracts/identity-authority.md records the trade-off.

type SessionRoute = "workspace" | "logout" | "rotate";
export const sessionLimitKeys: Readonly<Record<SessionRoute, string>> = Object.freeze({
  workspace: "session",
  logout: "session_logout",
  rotate: "session_rotate",
});
export const sessionLimitedRoutes: readonly SessionRoute[] = Object.freeze([
  "workspace",
  "logout",
  "rotate",
]);
const sessionRoute = (route: ManagedApiRoute): route is SessionRoute =>
  (sessionLimitedRoutes as readonly ManagedApiRoute[]).includes(route);

const retryAfterSeconds = 60;
// The api's ErrorEnvelope families: the work, billing, agents and catalog rows of the api
// Worker's dispatch table (worker.ts), read through `apiDispatch` itself, so there is one
// matcher. The catalogue routes (M2 PR-3) answer the work API's envelope. The Stripe webhook
// row is outside /workspace and never a session route.
type EnvelopeFamily = "work" | "billing" | "agents" | "catalog";
const envelopeFamilies: readonly string[] = Object.freeze(["work", "billing", "agents", "catalog"]);
export function envelopeFamily(pathname: string): EnvelopeFamily | null {
  const key = apiDispatch(pathname);
  return envelopeFamilies.includes(key) ? (key as EnvelopeFamily) : null;
}
// Over the limit: the ErrorEnvelope rate_limited on a work, billing, agents or catalog path (the
// read class on GET), and elsewhere the sign-in routes' 429, which the SPA's identity and
// store-link decoders read as nothing done.
function limited(pathname: string, method: string): Response {
  if (envelopeFamily(pathname))
    return workRateLimitedResponse(method === "GET", crypto.randomUUID(), retryAfterSeconds);
  return edgeRateLimited();
}
// The route's existing 503: logout's and rotate's own outcome bodies, the work, agents and
// catalogue APIs' ErrorEnvelope and the billing API's own (their read class, safe_read_retry, on
// GET and recheck_before_retry otherwise, as each handler classifies a request before its guard
// runs), and the workspace handler's {"code":"unavailable"}. None sets a cookie.
function unavailable(route: SessionRoute, pathname: string, method: string): Response {
  if (route === "logout")
    return edgeReply(503, '{"schemaVersion":1,"outcome":"logout_unavailable"}');
  if (route === "rotate")
    return edgeReply(503, '{"schemaVersion":1,"outcome":"rotation_unavailable"}');
  const family = envelopeFamily(pathname);
  const read = method === "GET";
  if (family === "billing") return billingUnavailableResponse(read, crypto.randomUUID());
  if (family)
    return workErrorResponse(read ? "unavailable_read" : "unavailable", crypto.randomUUID());
  return edgeReply(503, '{"code":"unavailable"}');
}

/** `limiter` null (development without limiters) forwards every request untouched. */
export function createSessionLimit(limiter: RateLimiter | null) {
  const handle = async (
    request: Request,
    next: (request: Request) => Promise<Response>,
  ): Promise<Response> => {
    if (!limiter) return next(request);
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return next(request);
    }
    const route = managedApiRoute(pathname);
    if (!sessionRoute(route)) return next(request);
    // Step 0: no canonical session cookie, no count; the handler's own refusal follows.
    if (sessionCookieSecret(request.headers.get("cookie")) === null) return next(request);
    // Step 1: the per-address limit, under the route's own key.
    const limit = await limitAddress(
      limiter,
      sessionLimitKeys[route],
      request.headers.get("cf-connecting-ip"),
    );
    if (limit === "limited") return limited(pathname, request.method);
    if (limit !== "allowed") {
      logEdgeGuard(edgeLimitFailure(limit));
      return unavailable(route, pathname, request.method);
    }
    return next(request);
  };
  return Object.freeze({ handle });
}
export type SessionLimit = ReturnType<typeof createSessionLimit>;
