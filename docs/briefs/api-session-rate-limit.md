# api session-route rate limit

- Status: brief, 2026-10-22. Branch `claude/api-session-rate-limit`. Source: the pre-publication sweep. Change class: routine hardening under ADR-0019 item 8 (a per-IP Worker limit before hosted login), applied to the session routes as the M2 PR-2 review applied it to the connector; no authority, tenancy or data change.

## Goal

The staging api's authenticated session routes (everything behind `__Host-morrow_session`: `GET /workspaces`, `/workspace/:ws/...` including the work API, logout and rotate) had no per-address limit and reached the database for any well-formed unknown session secret. Bound that per address at the edge, before any broker lease or SQL, and confirm that a malformed cookie is already refused before the database.

## Scope

- `SESSION_LIMITER`, a Workers Rate Limiting binding on the api: 120 per 60 s per address, namespaces 7006 (development), 7106 (staging), 7206 (production), after the connector's 7004–7005 block. `verify-config` pins it (`edgeRateLimits`, `EDGE_API_RATELIMITS`); `smoke:edge-dev` expects it; the mapper requires it outside development (all four limiters or none in development).
- `apps/api/src/session-limit.ts`: selects with the router's `managedApiRoute` (`workspace`, `logout`, `rotate`; signup keeps `SIGNUP_LIMITER`). Step 0: no exactly-one canonical session cookie (`sessionCookieSecret`), no count. Step 1: one count per address; 429 with `Retry-After: 60` (the identity routes' `SignInGuardOutcome`, or the work API's `ErrorEnvelope` `rate_limited` on a work path); a missing or invalid address or a failed limiter is the route's existing 503 and one fixed-code `morrow_edge_guard` line.
- The deployed Worker runs the sign-in guard, then the session limit, then the router.
- The SPA reads a logout 429 `rate_limited` as unavailable (nothing ran), not uncertain.
- Malformed cookies: verified already refused before any lease or SQL by every session handler (the workspace and account guards, the work guard, rotate through `sessionCookieSecret`; logout through its stricter parser). No new rejection was needed; tests now pin it on the deployed composition.

## Interfaces touched

`apps/api/wrangler.jsonc` (and generated `worker-configuration.d.ts`), `apps/api/src/{session-limit,abuse-guard,deployed-worker,environment,worker}.ts`, `packages/work/src/http.ts` (`workRateLimitedResponse`), `apps/workspace-web/src/http/identity-decoders.ts`, `scripts/edge.mjs`, `docs/contracts/identity-authority.md`, `docs/contracts/work-api.md`. No migration, secret, contract schema or PR-D identifier or placement change.

## Security notes

- Uncounted requests never reach SQL: every session handler requires a non-null `sessionCookieSecret` before any lease (logout's rule is stricter), and the limit uses the same function on the same header.
- A third-party page cannot attach the SameSite=Lax cookie to a subresource, a fetch or a cross-site POST, so it cannot spend a visitor's budget; a NAT shares one budget, as on the sign-in routes.
- The address is hashed for the key (`session:` plus 32 hex) and never stored, logged or used for authority; 429s log nothing.
- Workers rate limits are eventually consistent per Cloudflare location: a speed bump, not a quota.

## Test checklist

- [x] Route selection agrees with the router; trailing-slash and encoded paths, signup and sign-in routes are not counted (`tests/session-limit.test.mjs`).
- [x] No, short, non-canonical, duplicate or malformed cookies are never counted, even with an empty bucket or no address; a canonical cookie beside others is counted.
- [x] Key shape, IPv6 /56 aggregation, unread body, the same Request forwarded.
- [x] 429 on every session route in its family's shape; 503 with the route's body and one line for each fail-closed cause; development without limiters is a pass-through.
- [x] Deployed composition: without a canonical cookie no route counts or leases; a counted request is limited before the broker lease; 429 and a failed limiter lease nothing.
- [x] Mapper: `SESSION_LIMITER` required in staging and production, all four or none in development (`tests/api-environment.test.mjs`); exact bindings and negatives (`tests/edge-config.test.mjs`); logout 429 decoding (`tests/workspace-web-decoders.test.mjs`).
- [x] `lab:edge-workers` case `SESSION_limiter` over the real development bundle: 10 uncounted, 120 counted, the 121st 429 on every session route, no database reach, another address unaffected, an admitted request does reach the database path, an invalid address is 503 with one `ADDRESS_INVALID` line.
- [ ] Hosted CI on the PR head; one AI review (separate context, same model family) with the security lens.
- [ ] After the next staging deploy: one manual 429 check on `/workspaces` from one address (the AC11 run can include it).
