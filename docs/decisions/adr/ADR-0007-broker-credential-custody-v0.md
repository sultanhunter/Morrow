# ADR-0007 Broker credential custody v0 for development and staging

- Status: Accepted for development and staging only. Production custody is a pending owner decision and needs a superseding ADR.
- Date: 2026-10-17
- Affects: P04.T02a (D1–D3, D5–D7, D9), P04.T01i, P04.T03a, P05.T01x (broker role map), P06.T01a (work login lease), P08.T02, Security invariant 11, `infra/rotation-runbook.md`

## Context

Security invariant 11 (plan R1) sets one rule per credential class. Provider, merchant and model API credentials bind only to the broker Worker, which makes the call. Database role passwords reach each Worker's source-fixed SQL profiles through short-lived broker leases. Morrow-owned application keys bind only to the Worker that uses them. The delivered P05.T01r login port is a recorded deviation: it borrows the WorkOS API key into the api Worker for the session-catalogue read.

Packet P04.T02a builds the first deployable composition: four Workers (api, broker, orchestrator, connector) with no Cloudflare account. Its custody design (D2) leases the seven Neon runtime-role passwords to the api. Two other plan statements could be read against that: P04.T02's "PostgreSQL runtime, issuer, migration and recovery roles remain separate" and the Secrets row's "Platform root credentials are unavailable to ordinary Workers" (packet OQ2).

The design leaves two residual risks, set out in P04.T02a §D2:

- **R1, session-issuer forgery.** A lease carries the role's static password; `expiresAtMs` bounds only its use within one request. `resolve_provider_subject_selection` (0007) returns everything `admit_browser_family` (0008) needs, and admission checks nothing with WorkOS. Anyone holding those two passwords, a `user_` id and a workspace id can mint a valid `__Host-morrow_session` in any tenant of that environment. A one-time leak from api memory gives persistent cross-tenant forgery until the issuer passwords rotate.
- **R2, session-metadata read.** Through `workosSessionPage`, a compromised api can read WorkOS session metadata (IP address, user agent, timestamps) for any `user_` id in that WorkOS environment.

A password also allows what a fixed-statement proxy would not: catalog reads, TEMP objects, overriding USERSET settings, exhausting CPU or connections, and connecting from anywhere, because Neon endpoints are public. A proxy (OQ2 option C) would rewrite pool code frozen by ADR-0003. Only synthetic data exists before P09.T05.

## Decision

These rules apply to the development and staging environments. Production cannot be bound under them (item 9).

1. **Topology** (P04.T02a §D1, §D5, §D8).
   - The api is the only public Worker. It serves the SPA through Static Assets on the same origin as `/auth/*`, `/workspace/*`, `/api/*` and `/healthz`.
   - The broker has no public route. Its default `fetch` returns 404, and it is reachable only through the `ApiBroker` service-binding entrypoint, with exactly three RPC methods: `health`, `neonLease` and `workosSessionPage`.
   - The orchestrator keeps dispatch disabled. The connector is a 503 placeholder (see ADR-0008).
   - Every Worker sets `workers_dev:false` and `preview_urls:false` and has no `routes`. P04.T01i adds a domain to the api only.
   - The service-binding boundary is the Cloudflare account plus its deploy permissions.
2. **Custody table** (P04.T02a §D2).

   | Credential | Bound to | Reaches the api? |
   | --- | --- | --- |
   | WorkOS API key | broker secret `WORKOS_API_KEY` | Never. The broker makes the one keyed call (session-catalogue GET). |
   | Neon runtime-role passwords (`brokerNeonRoles`) | broker secrets `MORROW_DB_PASSWORD_<ROLE>` | Yes, per pool connect, through `neonLease`. No credential lifetime is claimed. |
   | Login capsule keyring | api secret `LOGIN_CAPSULE_KEYRING` | It is the api's own application key. |
   | Owner, migration, lifecycle and maintenance passwords; Neon API key; Cloudflare tokens | no Worker | Never |

   - The PKCE `/user_management/authenticate` exchange and the JWKS read send no secret and stay in the api.
   - The api's environment mapper rejects any credential-like binding other than its keyring (P04.T02a §D6, AC07).
   - A further runtime role may be leased only when an accepted ADR names it, or names the pattern that creates it, and it is source-fixed and least-privilege. Two are covered today: ADR-0009 item 4 (`morrow_identity_onboarding` replaces `morrow_identity_resolution` in login) and ADR-0010 item 2 (one per-Worker login role, first `morrow_api_worker`). With that cover, the `brokerNeonRoles` edit itself is routine. Owner, migration and administrative roles are never leasable.
3. **Broker trust model v0** (P04.T02a §D3).
   - The broker trusts every caller that holds the binding. It performs none of P04.T02's fresh policy, scope, operation and budget checks.
   - That is acceptable only for pre-authentication identity calls and role leases.
   - Only strings, booleans and integer budgets cross RPC. Every failure is the single error `BROKER_HELD`, logged with a fixed code and no values. Nothing retries.
4. **Barred credentials.** Shopify, OpenAI, E2B and every other merchant, model or provider credential must not be bound to the broker under v0. They wait for the P08.T02 broker trust model and the owner-approved P08 credential-custody ADR that plan R1 requires before P08.T02 implementation. The same applies to the Shopify broker operations proposed in ADR-0008.
5. **Residual risks accepted** (packet OQ2, option A). R1 and R2 are accepted for development and staging.
   - **Plan reading.** The issuer roles remain separate PostgreSQL roles, as P04.T02 requires, and are leased like the other runtime roles. The "platform root credentials" of the Secrets row are among the credentials that no Worker holds (item 2, last row).
   - **Compensating controls.** P04.T01i applies these as hosted operations (not migrations), under its own owner approvals, and sizes them:
     - a `CONNECTION LIMIT` on each leased runtime role;
     - role defaults for `statement_timeout` and `idle_in_transaction_session_timeout`, which bound accidents, not an attacker;
     - `REVOKE TEMP ON DATABASE morrow FROM PUBLIC`;
     - rotation of every leased password every 90 days, and immediately on suspected exposure (P04.T02a AC20 is the local precursor to P04.A02);
     - connection monitoring by role and `application_name`, with P04.T03a alerting on unknown names.
   - **Data.** There is no network allowlist. Only synthetic data and the owner's allowlisted test accounts (ADR-0009) are used until P09.T05.
6. **Login keyring K1** (packet OQ1; P04.T02a §D7).
   - **Versions.** Keyrings hold a single version. The window is `encryptFromMs = t0 − 300 s`, `encryptUntilMs = t0 + 90 d` and `decryptUntilMs = encryptUntilMs + 300 s`.
   - **Rotation.** Rotate every 60 days, on any login-configuration change and on suspected exposure.
   - **Accepted cost.** A rotation may drop logins in progress, at most 300 s of them plus isolates still on the old version. Those logins see the existing "Sign-in could not be completed" page and restart.
   - **Deploy.** The keyring and the vars ship as one version with `wrangler deploy --secrets-file`, never a bare `secret put`.
   - **Outside the window.** Login start returns 503 `login_unavailable` and `/healthz` is not ready.
   - **Tool.** `scripts/login-keyring.mjs` writes only a 0600 file outside the checkout and prints metadata only. The owner runs it for hosted environments.
   - **K2 is not adopted.** K2 keeps the previous version in an owner-held file.
7. **Committed non-secret staging identifiers** (packet OQ3).
   - The WorkOS client and environment ids and the Neon project, branch and host for staging are committed as reviewed `env.staging.vars` by P04.T01i.
   - P04.T02a itself commits none.
   - Production identifiers and every secret, password and keyring are never committed.
8. **Public readiness** (packet OQ4). `GET /healthz` on the api returns `{"schemaVersion":1,"service":"api","ready":<bool>}`: one boolean, no-store. The broker health it depends on is cached for 30 s per isolate, with one in-flight call.
9. **Production stays unbindable.** The api mapper fails every production binding (P04.T02a §D6 step 7), and development and staging brokers reject `sk_live_` keys.
   - Before any production binding or deploy, a superseding ADR must decide production credential custody: (A) lease permanently, (B) a dedicated issuer Worker (P04.T02b), or (C) an RpcTarget query proxy, which needs an ADR-0003 pool-freeze exception.
   - Emergency fleet-wide keyring revocation remains a production gate (P04.T01i).

## Consequences

- P04.T02a Phase 1 (D2, D4–D9) may proceed. The invariant 11 deviation for the WorkOS session-catalogue read closes when P04.T02a merges.
- R1 and R2 remain open until the production ADR. The packet had proposed revisiting before production or before the first non-identity api route, whichever came first. The owner approved only "revisit before production", so the route trigger is **not** a gate. Instead, the Tier 2 security review of any packet that adds api routes or broker roles must state whether it widens R1 or R2. P05.T01x and P06.T01a are the first such packets.
- P04.T02a AC24 ("no staging or production identifier in any `wrangler.jsonc`") holds for P04.T02a. P04.T01i narrows it to allow only the reviewed staging identifiers in `env.staging.vars`.
- `infra/rotation-runbook.md` gains the Workers-secrets and keyring section (P04.T02a outputs). Credentials never pass through chat or the repository.

## Approval

Owner approval, 2026-10-17, in chat (second batch). The owner selected **"Accept recommended (Recommended)"** for this question:

> Deploying the app (P04.T02a): a separate 'broker' Worker holds all secrets. Provider API keys (WorkOS now; Shopify/OpenAI/E2B later) never leave it. The main API Worker receives short-lived database credentials from the broker for each request. Small trade-offs: rotating the login encryption key may drop logins in progress (up to 5 min); non-secret staging IDs (WorkOS client, Neon project) go in committed config; a public /healthz returns a single true/false. Accept for dev/staging, and revisit before production?

The approval covers development and staging only. Three clarifications against that wording:

- "Holds all secrets" means every provider credential and database role password. The login capsule keyring is the api's own application key and stays on the api (item 2), as Security invariant 11 requires.
- "Shopify/OpenAI/E2B later" means after the P08.T02 trust model, not under v0 (item 4).
- The "short-lived database credentials" are leases of static role passwords (Context, R1).

The question did not describe residual risks R1 and R2 or the item 5 controls. They belong to the recommended OQ2 option (A) that the owner accepted, and they apply only to development and staging, with synthetic data and the owner's allowlisted accounts.

The production credential custody decision is still pending.
