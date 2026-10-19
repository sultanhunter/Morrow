# ADR-0019 Staging environment: workers.dev origin, continuous deploy and sign-in abuse protection

- Status: Accepted 2026-10-19 (owner approval in chat; see Approval). Items 1, 2, 4, 5 and 6, and the per-IP limit in item 8, restate the owner's decisions of 2026-10-19 (chat). The owner's approval of this record also confirms the items marked *Recommended*.
- Date: 2026-10-19
- Amended: item 5, 2026-10-19 (owner answer on third-party GitHub access: an exception for the platform GitHub Apps); item 9, 2026-10-19 (owner answer on the failed-verification log line). See Amendments.
- Amends:
  - ADR-0014 item 5 (when branch protection must exist);
  - ADR-0007 items 1, 3 and 4 (a public workers.dev route on the api, a fourth broker method, and one more provider credential in the broker);
  - ADR-0009 item 8 (when Turnstile and the per-IP limiter are required);
  - the staging row of `docs/decisions/deployment-policy.json`, until P04.T04;
  - plan R1, Security § line 113, with one recorded exception (item 14).
- Affects: P04.T01i, P04.T03a, P05.T01ab, P14.T01a PR-2, and P04.T01j/ADR-0020.

## Context

- **M1 needs a hosted staging origin.** M1 is "A synthetic person signs in on the hosted staging origin and reaches a workspace; a real-browser Playwright login smoke passes". On 2026-10-19 the owner decided to stand up one live environment now instead of first buying a domain or a GitHub plan.
- **Accounts.**
  - The Cloudflare account `79ff672d013b8f0956437af6eea3c213` has Workers Paid active, no zones, and the free subdomain `sultanibneusman0.workers.dev`.
  - `sultanhunter/Morrow` is a private repository, then on GitHub Free. The branch-protection API answered 403 "Upgrade to GitHub Pro". Environments were also believed unavailable to private repositories on Free, but the `staging` environment and its `main`-only branch policy were created on Free at 11:41 UTC on 2026-10-19 (`docs/evidence/live/2026-10-19-github-staging-environment.md`). The owner bought GitHub Pro later that day, and branch protection on `main` followed.
  - The Neon organisation is on the Free plan.
  - The WorkOS staging environment is `environment_01M4HG7FV7X8EFXE1J9S6GG00R`.
- **Login lock-out.** Account login start is anonymous. Its per-profile windows (10 per 10 s, 100 open) let anyone lock every sign-in out of a profile (P05.T01x §11). ADR-0009 item 8 required Turnstile and an edge per-IP limiter only before sign-up opens beyond the allowlist.
- **Branch protection.** ADR-0014 item 5 required enforced protection on `main` before the first hosted deploy.
- **The migration chain.** It cannot be applied by a non-superuser administrator such as Neon's `neondb_owner` (P04.T01i, M-N1). That is decided separately (P04.T01i OQ-1, ADR-0020) and is not part of this record.

## Decision

1. **One live environment, `staging` (owner).**
   - It is production-in-waiting: no users, only synthetic data plus the owner's own WorkOS test identity, and the owner may reset it freely.
   - Before the first real merchant, a clean production environment is created from the same configuration. That needs:
     - a fresh database;
     - new credentials;
     - the superseding custody ADR required by ADR-0007 item 9;
     - branch protection (item 5).
2. **Origin (owner: the free workers.dev subdomain).**
   - The origin is `https://morrow-staging-api.sultanibneusman0.workers.dev`, and only the api is reachable there.
   - **ADR-0007 item 1** changes from "P04.T01i adds a domain to the api only" to "P04.T01i adds the workers.dev hostname, and later a custom domain, to the api only". The broker, orchestrator and connector keep `workers_dev:false` and `preview_urls:false`, with no routes.
   - **Later custom domain.** It is a configuration change: the route, the WorkOS redirect, the Turnstile hostname, the login configuration and a keyring rotation. Buying the domain is a per-action decision.
   - *Recommended:* the Worker name `morrow-staging-api`. Also a census at every deploy, which fails if any script, Pages project or dispatch namespace in the account exposes workers.dev or binds `morrow-staging-broker`. `workers.dev` is on the Public Suffix List, so every Worker under the subdomain is same-site with the api; `__Host-` cookies and invariant 22 remain the protections.
3. **Public reachability (*Recommended*; accepted with this record, as written).**
   - Staging is publicly reachable with no access gate. This answers the plan's question of how staging is kept off the public internet. The controls are:
     - WorkOS public sign-up off and email verification on;
     - self-service only on the staging profile, allowlisted to the owner's test user (ADR-0009 items 10 and 11);
     - Turnstile and per-IP limits (items 6 and 8);
     - synthetic data only (invariant 16).
   - **The alternative is Cloudflare Access on the workers.dev hostname** (Zero Trust Free). It is stronger, but the unattended smoke and CI would then need an Access service token, a further secret. The WorkOS callback would also pass through Access.
   - The owner approved this record as written, so staging is public with no access gate. Switching to the alternative later costs one configuration change and one secret, and needs a short amendment.
4. **Continuous deploy from `main` (owner).**
   - A push to `main` whose "Morrow foundation" run succeeds deploys the four staging Workers through `.github/workflows/deploy-staging.yml`. A local `staging:deploy` is possible only from `origin/main` with a green `foundation` check on that exact sha.
   - *Recommended gates:*
     - the commit is still the `main` tip;
     - a deploy flag that the kill switch clears, re-read just before and just after the api deploy;
     - the schema head matches;
     - the login configuration digest matches;
     - the broker's secret names match;
     - an offline build and dry-run pass.
   - Workers never deploy ahead of their schema.
   - **A Worker rollback is never a database rollback.** Migrations are forward-only. The staging database recovers only by an owner-run reset.
5. **Branch protection before production, not before staging (owner).** ADR-0014 item 5 is amended to read:
   > "Enforced protection on `main` requires the `foundation` check and no approving review. It must exist before the first production deployment, production credential or production resource. It needs GitHub Pro or Team, a purchase the owner approves per action. Staging deploys do not wait for it."
   - **Residual risk, accepted for staging only.** Until protection exists, ADR-0014 items 3 and 4 are rules, not controls. An account that can push to `main` can change the deploy workflow, `ci.yml` or `scripts/staging.mjs` in the same push. That account therefore controls the staging deploy token, which can deploy a broker that reads every staging broker secret.
   - **Mitigations.**
     - Only the owner's account (which Claude uses) can push.
     - Every other GitHub App, OAuth app, token, deploy key and collaborator is removed before the first deploy, except the platform GitHub Apps named in the 2026-10-19 exception (see Amendments).
     - If GitHub Pro is bought, protection is turned on at once, at no extra cost.
6. **Turnstile before staging login (owner); verification in the broker (*Recommended*).**
   - An invisible Turnstile widget guards account login start (`POST /auth/login`) and organization signup (`POST /organizations`).
   - The Turnstile secret is a provider credential, so under invariant 11 it lives only in the broker. The broker verifies tokens through a fourth `ApiBroker` method, `challengeVerify(action, token, budgetMs)`, which returns `"passed"` or `"failed"` or is held.
   - This amends ADR-0007:
     - **Item 1:** the broker has four RPC methods.
     - **Item 3:** challenge verification is a pre-authentication call within the v0 trust model.
     - **Item 4:** the Turnstile secret is the one provider credential admitted beyond WorkOS. It can verify tokens but not mint them, and it carries no merchant or model data. No other provider credential is admitted under v0.
   - **ADR-0009 item 8 is amended.** Turnstile and the per-IP limiter are required before hosted login is activated in any hosted environment, not only before sign-up opens beyond the allowlist.
7. **Public contract additions (*Recommended*; additive).**
   - `GET /auth/challenge` returns `{"schemaVersion":1,"provider":"turnstile","siteKey","actions"}`, or `{"provider":"none"}`.
   - The request header `X-Morrow-Challenge` is required on the two guarded POST routes in staging and production.
   - New outcomes:
     - `challenge_required` (403);
     - `challenge_failed` (403);
     - `rate_limited` (429, with `Retry-After: 60`).
   - P05.T01ab updates `docs/contracts/identity-authority.md` and the generated contracts (`npm run contracts:generate`). The additions go into contract v1.1, or into v1.2 if v1.1 is frozen at merge, by the same rule as ADR-0009 item 5.
8. **Per-IP limits (owner: a per-IP Worker limit; values *Recommended*).**
   - The Workers Rate Limiting binding allows:
     - login start: 10 per 60 s;
     - the callback: 20 per 60 s;
     - signup: 5 per 60 s.
   - The key is a SHA-256 of the client address from `CF-Connecting-IP`, with IPv6 truncated to /56 (a reviewed constant: 48, 56 or 64). No address is stored, logged or used for authority.
   - A missing address, or a limiter error, fails closed with the route's existing 503.
   - The limits are eventually consistent per Cloudflare location. They are a speed bump, not a quota, and the per-profile windows of ADR-0009 item 8 still apply.
9. **Observability for M1 (*Recommended*).**
   - Workers Logs are on in staging, with invocation logs, traces, logpush and source maps off.
   - Only fixed-code events are logged. Rejected requests are not logged, except one fixed-code `morrow_challenge {code:"failed"}` line per failed or held verification (amended 2026-10-19; see Amendments). The per-IP limiter (item 8) caps that line, and it costs about $0.60 per 1M lines.
   - Cloudflare billing usage alerts go to the owner at about 10% of each included allowance.
   - **M1 is reached with only part of P04.T03a.** P04.T03a's acceptance, "a deliberately failed staging request produces one correlated, redacted event and an alert to a named recipient", stays open, and the P04 Done gate is not claimed. Until P06.T01c, GitHub's failed-run email to the owner is the interim route for an uncertain deploy, rollback or migration.
10. **Staging database (*Recommended*).**
    - **Project.** A new Neon Free project `morrow-staging` (PG17, AWS us-east-1, no card on file).
    - **Branches.** The root branch is never migrated. Neon names it `production` by default (`br-noisy-wind-b7cxr2a1`); that is only Neon's label, and it is not a production resource for the staging card's expiry. It holds Neon's default empty database `neondb` and the empty database `morrow` that P04.T01i D9 step 4(d) creates. One child branch, `staging`, is migrated and bound.
    - **Reset.** `neonctl branches reset staging --parent`, which keeps the branch id and host. Only the owner runs it.
    - **Recovery window.** Neon Free's history window (about 6 hours, as observed) replaces `deployment-policy.json`'s staging `Launch` plan and `pitr_staging` 7 until P04.T04 decides Neon Launch. Staging holds only synthetic data, so a reset stands in for a restore. The seven-day staging recovery requirement stays open in P04.T04.
11. **More committed identifiers (*Recommended*).** These are committed as reviewed, non-secret values in addition to ADR-0007 item 7's list:
    - the Cloudflare account id;
    - the workers.dev subdomain;
    - the WorkOS app id;
    - the Turnstile site key;
    - the Neon root branch id and region.
    
    No secret, password, token or keyring is ever committed.
12. **Migration ledger (*Recommended*).** The hosted runner records each applied migration in `morrow_migrations.applied(sequence int PRIMARY KEY, file, sha256, execute_as, prerequisites jsonb, source_commit, applied_at timestamptz, applied_by)`.
    - **Nature.** It is tooling metadata, not a manifest migration and not tenant data.
    - **Access.** It is owned by the migration administrator, with `REVOKE ALL` from PUBLIC and from every Morrow role.
    - **Writes.** It is written in the same transaction as each migration, so a lost acknowledgement is resolved by reading it, never by promotion.
    - **Lifetime.** It is kept for the life of the database. The tenant-conformance registry lists it as an excluded non-tenant schema.
13. **Evidence (*Recommended*).**
    - Continuous-deploy reports are CI artifacts kept for 90 days (ADR-0012), not files in `docs/evidence/live`. They hold the sha, version ids, durations and gates, are scanned before upload, and contain no values.
    - The first bring-up, every manual effect and every dashboard action keep a `docs/evidence/live/` record.
14. **Credential-transport exception (*Recommended*).** Plan R1 line 113 lets credentials reach tools only through stdin or owner-only files. wrangler accepts an API token only from the `CLOUDFLARE_API_TOKEN` environment variable, so the Cloudflare deploy token is the one exception, under these conditions:
    - It may be placed in the environment of wrangler child processes only, and in CI in the environment of one workflow step.
    - `scripts/staging-token.mjs` removes it from `process.env` before any other module loads.
    - It is never put in argv, a checkout file, a log or an artifact, and wrangler output is never relayed.
    - No other credential receives this exception.
15. **Cost posture (*Recommended*).**
    - **Cloudflare Workers usage** is not capped. The control is the usage alert plus the kill switch. Requests the Worker rejects are still billed; static-asset requests are free.
    - **Neon Free** is hard-capped: it cannot bill without a card, and running out of compute suspends it (an outage, not a bill).
    - **WorkOS** stays on its free tier, and **Turnstile** is free.
    - **GitHub Actions** follows the owner's answer to P04.T01i OQ-2.
    - **New spending** beyond the existing Workers Paid subscription is $0 unless the owner approves it per action.

## Consequences

- **Readiness.** Staging can go live once the staging card is approved, OQ-1 is settled (ADR-0020 and P04.T01j if B), and P04.T01i PR-B and P05.T01ab have merged. M1 itself, meaning sign-up and the workspace list, also waits for P14.T01a PR-2, which hosts the sign-up widget. Before the first deploy, the Codex app is suspended and the AppForge token deleted (Amendments, item 5 exception).
- **Push access until protection.** Until branch protection exists, push access to `main` is equivalent to custody of the staging broker secrets. Production cannot be created until protection exists (item 5).
- **Production unchanged.** Production stays unbindable (ADR-0007 item 9).
- **Two decisions still need recording.** A custom domain, or Cloudflare Access instead of public reachability, is a later configuration change, each recorded by a short amendment to this ADR.
- **P05.T01x §11 sign-off.** The STATUS pending sign-off on §11 (is Turnstile or the limiter required before hosted login?) is resolved: both are required before hosted login, in every hosted environment.
- **Plan and policy changes.** The plan bullets for P04.T01i (origin, reachability, card), P04.T03a (minimal baseline via P04.T01i, acceptance open), the new P05.T01ab and P04.T01j, and ADR-0009 item 8's timing are edited in the same PR. So is the staging row of `deployment-policy.json`.

## Approval

Owner decisions, 2026-10-19 (IST), in chat, verbatim from the session transcript:
- The owner asked why staging was needed instead of production from the start, and then, on the staging plan (one live `staging` environment deployed continuously from `main` after `foundation` passes, production-in-waiting, with a clean production created from the same config before the first real merchant), replied: "yes this plan looks good, i logged in the cloudflare account sultanibneusman0@gmail.com in the attached browser, also logged in the work os account and the neon account also".
- Asked "There's no domain on your Cloudflare account yet. Where should the first live Morrow environment run?", the owner answered "Free workers.dev URL now (Recommended)" (item 2, the origin: `sultanibneusman0.workers.dev` on account `79ff672d013b8f0956437af6eea3c213`, with a custom domain later).
- Asked "Earlier we agreed (ADR-0014) to turn on GitHub branch protection (GitHub Pro, about $4/month) before the first hosted deploy. With no users and only test data, should that wait until real production?", the owner answered "Required before production (Recommended)" (item 5).
- Asked "Login start is anonymous, so a bot could use up the sign-in quota and lock everyone out. Protect it before the live site's login is switched on?", the owner answered "Turnstile + rate limit now (Recommended)" (items 6 and 8).

The items marked *Recommended* (the Worker name and the census in 2; 3; the deploy gates in 4; the broker placement in 6; 7; the values in 8; 9–15) are confirmed only by the owner's approval of this record, quoted below.

Owner approval of this record, 2026-10-19, in chat. Asked "Approve ADR-0019 (staging rules) and the 30-day staging approval card `staging-card-1`?", the owner answered "Approve both (Recommended)". This accepts every item above, including the *Recommended* ones: item 3 as written (public reachability with no access gate, not the Cloudflare Access alternative) and the ADR-0014 item 5 amendment in item 5. The same answer approves the staging approval card `staging-card-1` (`docs/decisions/approvals/staging.md`). On P04.T01i OQ-2 (item 15, GitHub Actions) the owner answered "GitHub Pro (Recommended)": GitHub Pro, a capped Actions spending limit and branch protection on `main` as soon as Pro is active.

## Amendments

### 2026-10-19: item 5 exception, third-party GitHub access

Item 5's mitigation "Every other GitHub App, OAuth app, token, deploy key and collaborator is removed before the first deploy" now carries one exception, accepted for staging only:
- **Kept (accepted MVP risk).** The third-party platform GitHub Apps AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel keep their access to the repository.
- **Removed before the first staging deploy (a hard precondition).**
  - The ChatGPT Codex Connector GitHub App (read and write access to all repositories) is suspended. Suspension is reversible.
  - The classic personal access token "AppForge Github Actions" (`repo` and `workflow` scopes, no expiry; GitHub showed "Last used within the last 10 months") is deleted.
- **Why it matters even with branch protection on.** Protection on `main` (enabled 2026-10-19) requires the `foundation` check and no approving review. A principal with write access can open a pull request that changes CI, get a green `foundation`, merge it, and so control `deploy-staging` and the staging broker secrets. Staging shares the Cloudflare account with the owner's other products (P04.T01i OQ-3), so the same path could reach their R2 buckets.
- **Who acts.** Claude's attempt to suspend the Codex app in the attached browser stopped at GitHub's sudo re-authentication prompt, and nothing changed. The owner performs both the suspension and the token deletion.
- **Scope.** The exception covers staging only. Production needs its own decision on these apps before the first production deployment, credential or resource (item 5).

The same exception applies to the ADR-0014 item 5 amendment.

Owner decision, 2026-10-19, in chat. Asked "Security gap: the staging rules you approved (ADR-0019) assume no outside app can push to the Morrow repo. Today several can: the Codex app (read/write to all repos), plus Vercel, Netlify and others, and an old no-expiry token 'AppForge Github Actions' (repo + workflow access). Anything that can push to Morrow could change CI and deploy code that reads the staging keys. And because staging shares your Cloudflare account, that code could also reach your other products' R2 buckets. What should we do?", the owner answered "Suspend Codex + revoke old token (Recommended)". The option read: "I suspend the Codex app (reversible; you said you don't use it) and you delete the 10-month-unused 'AppForge' token. The reputable platform apps (Vercel, Netlify, etc.) stay, recorded as an accepted MVP risk." This supersedes the owner's earlier answer on the Codex app the same day, "i am not working with codex so it won't push anything so leave it".

### 2026-10-19: item 9, the failed-verification log line (P05.T01ab)

The second bullet of item 9 now reads:

> Only fixed-code events are logged. Rejected requests are not logged, except one fixed-code `morrow_challenge {code:"failed"}` line per failed or held verification. The per-IP limiter (item 8) caps that line at 15 a minute per IPv4 address or IPv6 /56 (10 at login start plus 5 at signup). It costs about $0.60 per 1M lines (Workers Logs beyond the included allowance).

- **Why.** A failed verification is a 403, so the original wording forbade the line that P04.T01i D6 specifies and that M-O1, the staging log probe, needs as its one event a probe can cause on purpose. The line carries a fixed code and no value: no address, token, secret or reply.
- **What P05.T01ab emits.** The broker logs the line once for each `failed` verdict (403 `challenge_failed`). A held verification answers 503 and logs only its fixed-code fail-closed lines (`morrow_broker {method:"challengeVerify", code}` and `morrow_edge_guard {code:"CHALLENGE_HELD"}`), which item 9 already allowed. Other rejections (403 `challenge_required`, the request guard's 403 and every 429) still log nothing.
- **Residual cost.** A client that rotates addresses is not capped by the limiter. Each well-formed junk token it sends costs one siteverify call and one log line; the bound there is the Cloudflare usage alert and the kill switch (item 15).

Owner decision, 2026-10-19, in chat. Asked "Sign-in protection detail: when someone sends a fake bot-check token, we log one line, which costs a fraction of a cent. The per-IP rate limit already caps volume. The staging rules said rejected requests are never logged. Keep this one log line?", the owner answered "Keep it (Recommended)".
