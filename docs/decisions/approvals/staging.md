# Staging approval card `staging-card-1`

- **Status:** Approved 2026-10-19 by the owner in chat: asked "Approve ADR-0019 (staging rules) and the 30-day staging approval card `staging-card-1`?", the owner answered "Approve both (Recommended)". Valid until 2026-11-18 or the first production resource, whichever comes first. Listed in STATUS under Active approval cards.
- **Lands as:** `docs/decisions/approvals/staging.md`, in P04.T01i PR-A, alongside ADR-0019.
- **Scope:** staging only:
  - Cloudflare account `79ff672d013b8f0956437af6eea3c213` (Workers Paid; subdomain `sultanibneusman0.workers.dev`);
  - the new Neon project `morrow-staging` (Free), with its root branch and its `staging` branch;
  - WorkOS environment `environment_01M4HG7FV7X8EFXE1J9S6GG00R`;
  - the GitHub repository `sultanhunter/Morrow` (its staging token and variables).
- **Data class:** synthetic data, plus the owner's own WorkOS test identity. No merchant or customer data, no other people, no external messages.
- **Valid until:** 30 days after approval, or the creation of the first production resource, whichever comes first. Only the owner can renew it. The `morrow-staging` root branch that Neon names `production` by default is not a production resource (ADR-0019 item 10).
- **Who:** Claude may perform the effects under "Allowed effects". Effects under "Owner-run" are performed only by the owner. The owner may perform any effect.

## Allowed effects (Claude)

| # | Effect | Cap | How the cap is enforced |
| --- | --- | --- | --- |
| E1 | Deploy the four `morrow-staging-*` Workers, either by continuous deploy from `main` after a green `foundation` run, or by `npm run staging:deploy` from `origin/main` with a green `foundation` check on that sha. Only the api is on workers.dev. No routes, domains or other Workers. | **Not capped.** Workers Paid includes 10M requests, 30M CPU-ms and 20M log events a month; expected use is under 1%. Overage costs $0.30 per million requests, $0.02 per million CPU-ms and $0.60 per million log events. | Usage alerts to the owner at about 10% of each allowance, plus the kill switch. **D6 fallback** where an allowance has no alert: the $5 billable-usage budget alert (created 2026-10-19) plus the owner's weekly check of Billing → Usage. Worst cases are under "Costs". **Precondition for the first E1 deploy:** the usage alerts exist, or the owner's acceptance of the weekly-check fallback is recorded (see "Preconditions for the first deploy"). |
| E2 | Create or rotate staging Worker secrets with the packet's D4 commands. Values come only from owner files or are generated in-process, and are never typed, printed or put in chat. This includes deploying a keyring the owner generated (`--api-keyring`). | none (no cost) | `staging:secrets-status` and marker tests |
| E3 | Neon, project `morrow-staging` only, using the project-scoped API key: throwaway probe branches with an expiry; `staging:migrate` on the `staging` branch; role controls; `provision-roles`; `seed-platform` (platform configuration rows only); catalog reads. Never the root branch, never another project. | Neon Free limits; no card on file | Neon cannot bill without a card. When the Free allowance runs out, compute is suspended: an outage, not a bill. |
| E4 | Create the queues `morrow-staging-dispatch` and `morrow-staging-dispatch-dlq`. | Workers Paid includes 1M queue operations a month; expected 0 (no producer) | Dispatch stays disabled (invariant 15) |
| E5 | Create the Turnstile widget `morrow-staging` (invisible, one hostname) and rotate its secret, through the API. | Free | none needed |
| E6 | **In the WorkOS dashboard:** add exactly one redirect, `https://morrow-staging-api.sultanibneusman0.workers.dev/auth/workos/callback`, and remove the loopback `http://127.0.0.1:4110/…`. This is the **only** dashboard action Claude takes, in the attached browser, on the Redirects page only. | WorkOS free tier | A live record of the change |
| E7 | Enable self-service on the staging profile by writing one `self_service_revisions` row. Only after the owner confirms in chat that WorkOS email verification is **on** and public sign-up is **off** (ADR-0009 items 10 and 11). | No cost | The seed refuses without the recorded confirmation |
| E8 | Sign-in tests with the owner's own WorkOS test user. The owner is present and types the credentials; Claude never sees or stores them. | No cost | The assisted smoke stores no password and has tracing, video and HAR off |
| E9 | Read-only reads: secret and variable names, Worker versions, the account census, Workers Logs queries, database catalog. | No cost | none needed |
| E10 | Set the non-secret GitHub variables `STAGING_SCHEMA_HEAD`, `STAGING_LOGIN_CONFIGURATION_DIGEST` and `STAGING_DEPLOY_ENABLED`. | No cost | none needed |
| E11 | **Suspended (ADR-0021, trimmed P04.T01i PR-B)** until the rollback refusal exists. Then: roll back a staging Worker within the packet's limits, never across a password, Turnstile or keyring rotation. Until then staging rolls forward, through a new green `main` commit, with the kill switch as the stop. | No cost | The tool refuses such a rollback (not built yet, so the effect is suspended) |
| E12 | Run the kill switch at any time. `unkill` is allowed only while this card is active. | No cost | none needed |

## Preconditions for the first deploy (E1)

- The ChatGPT Codex Connector GitHub App is suspended, and the classic token "AppForge Github Actions" is deleted (owner-run; ADR-0019 item 5 exception, 2026-10-19). The remaining platform GitHub Apps (AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel) are an accepted exception for staging.
- The Cloudflare usage alerts exist, or the D6 fallback is recorded: the $5 billable-usage alert plus the owner's weekly check of Billing → Usage.
- The trimmed P04.T01i PR-B has merged with `staging:kill`/`unkill`, the flag re-reads, deploy gates 1–6 and the census (ADR-0021).
- **Met 2026-10-20:** the owner suspended the app, deleted the token and chose the D6 fallback ("app suspended,token deleted and use the fallback"; `docs/evidence/live/2026-10-20-owner-preconditions.md`); PR-B merged as #28.

## Owner-run under this card

| # | Effect | Notes |
| --- | --- | --- |
| R1 | Reset the staging database: `npx --no-install neonctl branches reset staging --project-id <id> --parent` | Keeps the branch id and host. Claude then reruns migrate, provision-roles and seed-platform (E2, E3). |
| R2 | Download Playwright 1.63.0's Chromium: `npx --no-install playwright install chromium` | From Playwright's CDN, about 150 MB, for the assisted smoke. |
| R3 | Create, copy and place every credential: Cloudflare tokens, the WorkOS API key, the Neon project key, the connection string, the GitHub secret, the login keyring. | Done in a browser profile Claude is not attached to, with commands that never print the secret (packet D9). |
| R4 | Every deletion: the old Neon project `cool-butterfly-64820147`, older tokens and keys, WorkOS users, and the cleanup at expiry. | Claude never runs a destructive step. |

## Rules

- **Dashboards.** Claude's only dashboard action is E6. Claude never opens a page that shows a secret: Cloudflare API tokens, WorkOS API keys, the Turnstile secret, or Neon connection details. Each dashboard action gets a live record.
- **Secrets.** A secret never goes into chat, the repository, logs, CI artifacts, process arguments or error messages. Claude never reads a credential file into its context.
- **`!` commands.** Only `neonctl auth` may be run as `! <command>`. Every other owner command runs in the owner's own terminal.
- **Unknown outcomes.** Any provider operation with an unknown outcome is reconciled against its live record before any retry. It is never treated as a success. STATUS lists it until it is reconciled.

## Costs

| Provider | Cap | Detail |
| --- | --- | --- |
| Cloudflare Workers Paid (existing $5 a month) | **No hard cap: alert plus kill** | Requests the Worker rejects with 429 or 403 are still billed. Static-asset requests are free. Rejections are not logged; logging each one would add about $144 to the 30-day worst case. Beyond the included 10M requests: 100 req/s for 30 days (259M requests) is about **$75**, plus about $5 of CPU. 1,000 req/s for a day (86M requests) is about **$23**. Alert delays are Cloudflare's, so the owner should act on an alert the same day. |
| Neon Free | **Hard cap** | No card is on file, so Neon cannot bill. Exhausting the monthly compute allowance suspends compute until the next month, which is an outage. Reaching the storage limit blocks writes. |
| WorkOS | Free tier | No paid feature. A paid feature needs per-action approval. |
| Cloudflare Turnstile | Free | One widget. |
| GitHub Actions | **GitHub Pro plus a $10 Actions budget with a hard stop** | Settled 2026-10-19 by the OQ-2 answer "GitHub Pro (Recommended)". The owner bought GitHub Pro (about $4 a month, 3,000 included minutes; read active at about 18:45 IST). Claude raised the existing Actions budget from $0 to $10, with "Stop usage when budget limit is reached" on, at the owner's instruction (`docs/evidence/live/2026-10-19-github-actions-budget.md`). Measured before P03.T04f: about 43 billed minutes per CI run, about 90 per merged PR, and about 8 per deploy. When the budget is spent, CI and CD stop and merges are blocked until the next month. |

**New spending beyond the existing Workers Paid subscription under this card: $0.** GitHub Pro (bought by the owner) and the $10 Actions budget (set by Claude on the owner's instruction) were per-action decisions on 2026-10-19, outside this card.

## Kill switch

- **Command.** `npm run staging:kill` can be run by anyone, at any time, with no approval. It:
  - sets `STAGING_DEPLOY_ENABLED=0`;
  - disables the deploy workflow;
  - cancels queued and in-progress deploy runs;
  - disables workers.dev on the api;
  - checks that the hostname has stopped, then checks again after 2 and after 10 minutes.

  Running deploys re-read the flag around the api deploy, so they cannot turn the hostname back on.
- **Owner fallback in the dashboards:**
  - Cloudflare → Workers & Pages → `morrow-staging-api` → Settings → Domains & Routes → workers.dev → Disable;
  - GitHub → Actions → deploy-staging → Disable workflow.

  The strongest stop is deleting the CI token in Cloudflare.
- **Undo.** `npm run staging:unkill` needs an active card.

## Expiry and how it is enforced

- **Tokens.** The Cloudflare CI and operator tokens are created with a TTL equal to the expiry. When they expire, continuous deploy and Claude's local tools stop on their own.
- **Neon.** At expiry, the owner resets the `neondb_owner` password (Neon console → Roles), deletes `~/.config/morrow/staging/neon-owner-url`, and revokes the Neon project key. Migrations then stop.
- **Staging keeps running.** Its runtime secrets stay in the broker. Any further effect needs a new card or a per-action approval.

## Cleanup duties

These apply at expiry or on request, and each one is recorded.

- Let the tokens expire, or revoke them. Revoke the Neon project key and reset the `neondb_owner` password.
- The owner deletes the local files under `~/.config/morrow/staging/`, including any `*.old-*` copies.
- If staging is retired:
  - run the kill switch;
  - Claude removes the WorkOS redirect and deletes the Turnstile widget;
  - the owner deletes the Workers, the queues and the Neon project.
- The first live record also documents the verified clean-up of the previous agent's access: Cloudflare tokens and the Global API Key; GitHub apps, tokens, deploy keys and collaborators; WorkOS users, webhooks and connections; and Neon keys.
  - **GitHub, under the ADR-0019 item 5 exception:** the ChatGPT Codex Connector app is suspended and the "AppForge Github Actions" token is deleted, both by the owner and both before the first deploy. The platform GitHub Apps AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel stay, as an accepted exception for staging, and the record lists them.

## Records

- **Live records.** Each effect gets `docs/evidence/live/YYYY-MM-DD-<provider>-<action>.md`, with:
  - the card id;
  - the exact action;
  - the resources;
  - the cap;
  - the observed cost;
  - cleanup;
  - unknown-outcome status.
- **Deploy reports.** Continuous-deploy reports are CI artifacts kept for 90 days (ADR-0012, ADR-0019 item 13).
- **STATUS.** It lists this card, its expiry, and any unreconciled unknown outcome.

## Outside this card

Each of these needs a per-action approval:

- anything in production; a domain or zone; Cloudflare Access;
- real merchant or customer data; any other user; any external message;
- purchases and plan upgrades: GitHub Pro, an Actions budget above $0, Neon Launch, WorkOS paid features;
- unlisted resources: R2, KV, Hyperdrive, further Workers, widgets, queues or Neon projects;
- account-setting changes beyond E6, and any dashboard action other than E6;
- the M4 entitlement seed;
- self-service beyond the owner's allowlist;
- adopting any WorkOS test-login bypass;
- every destructive deletion, which the owner runs.

## Approval

- **Owner approval:** 2026-10-19, in chat. Question: "Approve ADR-0019 (staging rules) and the 30-day staging approval card `staging-card-1`?" Answer: "Approve both (Recommended)".
- **Valid until:** 2026-11-18 (30 days after approval), or the creation of the first production resource, whichever comes first.
- **OQ-2 answer (GitHub plan and Actions budget):** "GitHub Pro (Recommended)": GitHub Pro (about $4 a month) as a per-action purchase, a capped Actions spending limit (about $10), and branch protection on `main` (requires `foundation`, no approving review) as soon as Pro is active. **Done 2026-10-19, outside this card:** the owner bought Pro; Claude set the $10 Actions budget at the owner's instruction ("pro is active you set the action budget"); and Claude enabled branch protection after the owner answered "Turn it on (Recommended)". See `docs/evidence/live/2026-10-19-github-*`.
- **Effects used under this card** (bookkeeping; each live record holds the details):
  - E1, 2026-10-20: the first deploy, `npm run staging:deploy -- --first` from `main` `3a48d11`, 21:58:21Z to 22:00:51Z. All four Workers deployed; the smoke failed on the database path (`SMOKE_DATABASE_PATH`, 503) (`docs/evidence/live/2026-10-20-cloudflare-first-deploy.md`).
  - E2, 2026-10-20: with that deploy, the broker's fourteen secrets and the api's keyring, from the owner's first-deploy files (same record).
  - E3, 2026-10-20: `staging:migrate` on the `staging` branch, 16:56:15Z to 16:59:30Z, migrations 1–24 (`docs/evidence/live/2026-10-20-neon-staging-migrate.md`); `provision-roles --first` (eleven logins, statistics wiped) and `seed-platform` (platform configuration rows only), 21:27:56Z to 21:28:45Z (`docs/evidence/live/2026-10-20-neon-provision-roles-and-seed.md`).
  - E10, 2026-10-20: `STAGING_SCHEMA_HEAD`, withdrawn and published again by `migrate`; `STAGING_LOGIN_CONFIGURATION_DIGEST`, published by the first deploy before its first upload (the two records above).
  - E9, 2026-10-21: read-only script settings reads with the operator token, for the database-path diagnosis (`docs/evidence/live/2026-10-20-cloudflare-first-deploy.md`).
  - E9, 2026-10-21: read-only M-N1+ catalog reads on the staging `morrow` database (`docs/evidence/live/2026-10-21-neon-mn1plus-catalog.md`), and the M-O1 Workers Logs query (`docs/evidence/live/2026-10-21-cloudflare-m-o1-log-probe.md`).
  - E3, 2026-10-20: one expiring probe branch, reconciled and expired (`docs/evidence/live/2026-10-20-neon-probe-branch.md`); then, at 16:53Z, a second expiring probe branch that measured M-N1, M-N3 and M-N4, with a diagnostic throwaway role at 16:54Z (`docs/evidence/live/2026-10-20-neon-probe-rerun.md`, which also records the owner's own 16:45Z probe run); then the probe branch `morrow-probe-1689b575` (`br-frosty-wave-b7g7o2cm`, expiring 20:10:17Z) that measured the role-password path, the statistics wipe and Neon's `reset_password` refusal (`docs/evidence/live/2026-10-20-neon-password-path-experiments.md`).
  - E4, 2026-10-20: the queues `morrow-staging-dispatch` and `morrow-staging-dispatch-dlq` (`docs/evidence/live/2026-10-20-cloudflare-census-and-queues.md`).
  - E5, 2026-10-20: the Turnstile widget `morrow-staging` (`docs/evidence/live/2026-10-20-cloudflare-turnstile-widget.md`).
  - E6, 2026-10-20: the WorkOS redirect, saved by the owner (`docs/evidence/live/2026-10-20-workos-staging-redirect.md`).
  - E9, 2026-10-20: the census and the operator token's permission reads (`docs/evidence/live/2026-10-20-cloudflare-census-and-queues.md`); read-only settings reads of the staging `morrow` database (`docs/evidence/live/2026-10-20-neon-password-path-experiments.md`).
  - The owner's D9 steps that Claude performed on per-action approval (2026-10-19) are recorded in `docs/evidence/live/2026-10-19-*`, and the owner's own Neon `morrow` database and `staging` branch in `docs/evidence/live/2026-10-20-neon-staging-branch.md`. The owner's preconditions for the first deploy, and the vault KEK file, are in `docs/evidence/live/2026-10-20-owner-preconditions.md`; the owner ran `staging:keyring` (D9 step 9) before the first deploy.

## Amendments

### 2026-10-21: E1, the connector's workers.dev hostname

E1's sentence "Only the api is on workers.dev." now reads: "Only the api is on workers.dev; after M2 PR-2 has merged, `morrow-staging-connector` may be on workers.dev too, with the census admitting it only through M2's entrypoint allow table (`connector → ConnectorBroker`) and its rate-limit bindings pinned by verify-config." The broker and the orchestrator stay off workers.dev. Before the connector's hostname is enabled, `staging:kill` and its dashboard fallback must also turn off the connector's workers.dev hostname (today they cover the api only). The amendment creates no Shopify app, store or install: each app deploy, vault secret, registration and the development-store install still needs its own owner step or per-action approval (M2 brief, owner actions).

Owner decision, 2026-10-21, in chat. The question was: "To test a Shopify install on staging, the connector Worker needs its own public workers.dev address. The staging approval card currently allows only the api to be public. Change the card?" The owner answered: "Approve card change (Recommended)". The option read: "Amend staging-card-1 E1 so `morrow-staging-connector` may also be on workers.dev, after M2 merges and only with M2's census rules. Nothing is installed until you create the Shopify app and development store."
