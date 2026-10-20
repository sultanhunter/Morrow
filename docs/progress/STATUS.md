# Morrow status

Updated 2026-10-20. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014), with branch protection since 2026-10-19 (requires `foundation`, enforce_admins, no review). Merged: PRs #1–#32. The latest:
- PR #10 P05.T01x Part B (`e51e5b7`); PR #12 P06.T01a (`06e4dfe`; Verified waits for the P05 exit gate); PR #13 the ADR-0018 Proposal@2 edit (`08e5ebf`); PR #14 P01.T04a PR-A (`bba3cec`); PR #15 P14.T01a PR-1 (`5ad6cc7`, provisional under ADR-0003); PR #11 P03.T04e PR-A (`f8314e8`). Still open for #11: its AC22 `workflow_dispatch` run of `heavy-faults.yml` (about 18 billed minutes), and the AC04 hosted totals and hosted part of AC05, which P03.T04f moves to its first hosted `checks` job.
- PR #16 P03.T04f CI cost reduction (`5806049`): light runs for Markdown-only PRs and for pushes whose tree equals the merged PR head; 9 jobs instead of 12; the pgwire hold now records its stage and frames (run 39260319338 held once at `actual_84_callback_delivery_3`, then passed on rerun).
- PR #17 docs, merged as `8b451e8`: ADR-0019, ADR-0020 and ADR-0021 Accepted; `staging-card-1`; P04.T01i and P04.T01j PR-A packets; the ADR-0014 item 4 and 5 amendments; `docs/plan/mvp.md`; the 2026-10-19 live evidence; the Mobbin design references.
- PR #18 P14.T01a PR-2 (`30a6331`): account and work wiring in the provisional UI. PR #19 P01.T02c PR-A (`e0adf5d`): collaboration contracts v1.1 (ADR-0016). PR #20 P01.T04a PR-B (`8183e16`): the billing route library `@morrow/policy/billing-state` and its decision tables.
- PR #21 P04.T01j PR-B (`05aa479`): 0005–0015 rebaselined once under ADR-0020 (the frozen rebaseline record, `closedBy` null), the D5 preflight in eight adapters and both oracles, the single-transaction runner rule, `lab:createrole-administrator` in `pg-core` and createrole tenant conformance; M-J1 acknowledged. AC14 is implemented (hosted run 39351095356 with #28). Still open: AC15–AC16 (hosted).
- PR #22 P05.T01y (`d9c60b7`): browser session lifecycle; 0016 on the ADR-0020 helpers. PR #23 (`262604d`): pgwire lab fixes (the concurrent-callback serial race; the workspace-api final hold now named).
- PR #24 P06.T01b PR-1 (`890099a`): approval records, migrations 0017–0018.
- PR #25 MVP design (`e8db88f`): ADR-0022 Accepted; Claude behind a provider-neutral model gateway; model catalogue v1 active; briefs M2–M5.
- PR #27 P05.T01ab = P04.T01i PR-C (`7585782`): the sign-in abuse guard (limits 10/20/5 per 60 s, Turnstile through broker `challengeVerify`, `GET /auth/challenge`, mapper step 10), the broker's ten secret names, the widgets. PR #26 (`38b4347`): the postgres legs are now `[core, http, linking, work]`.
- PR #28 P04.T01i PR-B, trimmed (`bb882ad`): staging tooling, config and `lab:staging-runner`, no provider effect; deploy after green CI, gates 1–6, census, `kill`/`unkill`, no rollback (E11 suspended). PR #29 (`1a2e189`): the Neon connect and its cleanup are bounded, so an unreachable endpoint fails closed (`STAGING_DATABASE_UNAVAILABLE`).
- PR #30 M2 PR-1 (`6d744ae`; PR run on head `39542d8` green): migrations 0019–0024 (three spine executor logins, leases, stops, operations, the vault, the billing route, member-lease revocation); `ConnectorBroker`/`RuntimeBroker` (trust model v1) with vault envelopes; 14 broker secret names with `MORROW_VAULT_KEK_V1` (production 12). Two AI reviews (security lens) passed; four advisories are follow-ups below.
- PR #31 docs (`d12379e`): the four 2026-10-20 owner decisions as the ADR-0008 item 1 and ADR-0022 items 3, 9 and 11 amendments.
- PR #32 P04.T01i PR-D part 1 (`0e056e5`): every reviewed staging identifier in `staging.json` and the four `env.staging` blocks (only the api on workers.dev), the Neon endpoint and Turnstile site key pinned in verify-config, gate 4 and the staging tools; verify-config var allowlists (AC01, AC02); the census reads Cloudflare code 10121 alone as no Workers for Platforms (deviation 17); the 2026-10-20 live records (E4, E5, E6, the owner-run Neon branch).

In progress:
- **MVP build wave** (PR #33 is M2-PR2a; the other three are local worktrees, resumed after a usage-limit stop; merge order PR2a, M2-PR2, M5-PR1, M3-PR1; migrations numbered at each final rebase). **M2-PR2a** (`claude/m2-pr2a-store-resource`, merged with `main` `d12379e`; brief `docs/briefs/M2-shopify-connect.md` PR-2a): v1.1 `ResourceRef` kind `store` with `Scope` and `Grant` as declared supersets of v1, kernels and readers on current definitions, `storeResource` and `listingFieldPaths`, `tags` in the `catalog.content` field scope, and the S7 per-table ACL spec (optional `lease: true`; the column check covers system columns). One AI review (separate context, same model family, security lens) found minor issues and nits, all applied. Still open: push and PR, hosted CI (`foundation`) on the exact head, and `lab:tenant-conformance` S7 on hosted PostgreSQL. M3-PR1 owns the v1.1 `AgentInstallation` replacement; until then agent steps on the store resource fail closed. M2-PR2 (`claude/m2-shopify-connect`), M5-PR1 (`claude/m5-billing`) and M3-PR1 (`claude/m3-listings-agent`) follow in parallel.

## Decisions recorded 2026-10-18 to 2026-10-20 (owner, in chat)

- **2026-10-20:** "Allow actions: read (Recommended)" (P04.T01i AC03 amended); "Allow *.neon.tech (Recommended)" (this session's sandbox network allowlist, `.claude/settings.local.json`, git-ignored).
- **2026-10-20, MVP build questions:** "Confirm screen (Recommended)" (ADR-0022 item 3 amendment: Enable binds a server-built installation document); "Receipt-only path (Recommended)" (item 9: Stripe webhook ingress definers, no session, tenant from the verified receipt); "Roll over in beta (Recommended)" (item 11: unused credits roll over while subscribed; revisit at M6); "Hand-written checks (Recommended)" (ADR-0008 item 1 amendment: no Shopify library in deployed code).
- **ADR-0022 MVP contracts:** "yes lets start buidling and we are going to use claude for the model and make sure our model module is modular so it can be switched with any LLM ..."; model choice "use should be able to select models and thinking efforts"; "$49 / 300 credits (Recommended)"; one private Shopify app per beta merchant "OK for the beta (Recommended)"; "One button (Recommended)" for Approve and apply; asked "Confirm these model, credit and safety values for the beta?" (ADR-0022 "Owner confirmation of the catalogue values (2026-10-19)"), "Confirm all (Recommended)", so catalogue v1 is published. Open for the owner: the image provider for P17.T02e (OpenAI Images kept for now).
- **ADR-0021 MVP fast track:** "yes fast track but our foundation architecture should be solid so we can scale the product later without any issues."; first job "Product listings"; first merchants "Invite-only beta (Recommended)"; the record "Approve as written (Recommended)".
- **ADR-0019 and `staging-card-1`:** "Approve both (Recommended)": staging on workers.dev, continuous deploy from `main`, Turnstile and per-IP limits before hosted login (resolves the P05.T01x §11 sign-off). Branch protection timing: "Required before production (Recommended)" (ADR-0014 item 5 amendment).
- **ADR-0020:** "Approve ADR-0020 (Recommended)" (P04.T01i OQ-1 B: P04.T01j rebaselines 0005–0015 once and merges before any other migration). Item 7: "None that I know of".
- **GitHub:** OQ-2 "GitHub Pro (Recommended)"; the owner bought Pro ("I'll finish it myself"); "pro is active you set the action budget" ($10 Actions budget, hard stop); "Turn it on (Recommended)" (branch protection on `main`).
- **Third-party GitHub access:** first "i am not working with codex so it won't push anything so leave it"; then, asked again with the risk stated, "Suspend Codex + revoke old token (Recommended)". The platform GitHub Apps stay for staging as a recorded exception (ADR-0019 item 5, ADR-0014 item 5 amendment).
- **Cloudflare:** P04.T01i OQ-3 "Use this account" (option C, census at every deploy); Wrangler OAuth "Revoke it (Recommended)".
- **P03.T04f OQ-1:** "Allow both (Recommended)" (ADR-0014 item 4 amendment: light runs pass `foundation`).
- **P05.T01ab log line:** "Keep it (Recommended)": ADR-0019 item 9 amended to allow one fixed-code `morrow_challenge {code:"failed"}` line per failed verification (capped by the per-IP limiter; about $0.60 per 1M lines).
- **2026-10-18:** ADR-0015 billing routes by origin (supersedes ADR-0006; Stripe selected, no account or calls until an approved packet); ADR-0016 collaboration contracts v1.1 (admins read private Asks through audited reads); ADR-0017 membership authority; ADR-0018 proposals without a task; P01.T04a OQ-1 to OQ-3 (purchase permission with P18.T01a; a test entitlement seed for M4; an App Review allowance); P03.T04e OQ-1 (routine): heavy CI on dispatch plus weekly.

## Last green commit

`0e056e5` on `main` (PR #32): PR run 39451664824 on the merged head `1120701` green; push run 39453624750 in progress at this writing. `d12379e` (PR #31): push run 39424322640, PR run 39423386071 on `731d61f`. `6d744ae` (PR #30): push run 39415246591, PR run 39412768305 on `39542d8`. `1a2e189` (PR #29): push run 39364192383, PR run 39360110276. `bb882ad` (PR #28): push run 39358246728, PR run 39351095356. A push that merges an unchanged PR head runs only `checks`; record it with its push run and the PR run on the merged head.

**Failed:** the scheduled heavy-faults run 39227357944 on `f8314e8` (2026-10-19). ADR-0021 defers those suites, so the proposal is to disable the weekly schedule and keep `workflow_dispatch`. That is a `ci` change for its own PR, not PR #17.

## Next actions

MVP fast track (ADR-0021; `docs/plan/mvp.md`). M1, staging live:
1. Bring-up under `staging-card-1` (census, queues, Turnstile widget and WorkOS redirect done 2026-10-20; PR-D part 1 merged as #32): the Neon probe rerun (E3; this session's sandbox blocks Neon endpoint hosts, so the owner runs it or the session restarts); `migrate`, `provision-roles --first`, `seed-platform`; the owner's `staging:keyring`; `deploy --first` and the smoke; the owner's assisted sign-in.
2. Then M2 PR-2/PR-3, M5 (Stripe test mode), M3 (the listings agent), M4 (approve and apply), M6 (the deletion path before the real-store smoke).
3. Follow-ups: a KEK fingerprint check in `staging:put-secret`; the #30 advisories (a production broker must hold non-api callers; re-add the 18 → 0019 replay case once staging exists; `identityConstants` via `brokerRequiredSecretsFor("staging")`; the spine T1 preflight asserts its refusal); a `ci` PR disabling the weekly `heavy-faults.yml` schedule.

Open plan follow-ups: work routes in production must be gated on P09.T05 when production mapping is enabled (ADR-0007 item 9; packet hard ordering b); superseded banners on `docs/references/*`; check against the WorkOS docs whether a user's session list can hold expired or ended sessions (`packages/identity/src/workos-session-status.ts` refuses the whole page on such a row; found in the P14.T01a AC30 hold); a forward migration routing the 0006, 0007, 0009 and 0011 definer guards through `executor_role_safe` (informational; 0017–0018 are P06.T01b); a forward migration adding P01.T02c's eight v1.1 capabilities to `morrow_work.review_capabilities` once a consumer needs them (0018 predates them; none is reviewable); P05.T01y: rebind linking handoffs, reviews and status to the family (P09.T01a/T02a) and the revocation receipt (P05.T01z), and the production custody decision (ADR-0007 item 9) revisits the two R1 widenings accepted for staging; timing fixes if hosted `unit-stress` confirms them (`tests/broker-client.test.mjs` AC30, the 5,000 ms entry-timeout case in `tests/standalone-login-http.test.mjs`).

## Blockers

None for local work. Staging bring-up waits on the owner steps below. This session's sandbox still blocks Neon endpoint hosts (`*.aws.neon.tech`) until it reloads its settings; the fallback is per-command approval to run outside the sandbox. Production custody still needs its own ADR before M6.

## Pending owner actions

- **Bring-up now:** the vault KEK (below; #30 is merged); delete the local `cloudflare-ci-token` and `cloudflare-operator-token.old-*` files. Done 2026-10-20: Pages Read and Turnstile Edit on the operator token, the Neon `morrow` database and `staging` branch, the WorkOS redirect save.
- **Acknowledge** two 2026-10-20 actions beyond the card's literal scope: in WorkOS E6, Claude opened the Applications list and the application's Details tab, because redirects now live per application (Details shows only a masked key suffix); the E9 permission probe listed R2 buckets (refused, 403).
- **Before the first staging deploy (`staging-card-1`, "Preconditions for the first deploy"):**
  - GitHub: suspend the ChatGPT Codex Connector app (GitHub's sudo re-authentication stopped Claude's attempt) and delete the classic token "AppForge Github Actions". The platform apps AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel stay (ADR-0019 item 5 exception).
  - Cloudflare usage alerts at about 10% of each allowance (D9 5(c)), or confirm the D6 fallback: the $5 billable-usage alert (exists) plus your weekly check of Billing → Usage.
  - D9: delete Neon `cool-butterfly-64820147` and create the project key; change the Cloudflare Global API Key and create the two tokens (TTL 2026-11-18); a new WorkOS key, revoking old ones; `gh secret set CLOUDFLARE_API_TOKEN --env staging`; `tmutil addexclusion ~/.config/morrow`.
- **For M2 and M3:** the vault KEK, before the first deploy that carries M2 PR-1: `npm run vault -- kek --out ~/.config/morrow/staging/vault-kek-v1` (a new 0600 file; it prints only a fingerprint; keep an offline copy), or `morrow_put … vault-kek-v1` for a KEK made elsewhere; then an Anthropic Console workspace for staging with a monthly spend limit, its workspace-scoped API key placed with `morrow_put`.
- **Sign-off:** Plan R1 (Tier 3), which also freezes the P01 contract v1.1 billing layer (Shopify-route money is USD-only; `AllocationShare@2` is a declared superset of v1).
- **Credential rotation:** the E2B key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- **Billing (ADR-0015):** a Stripe test-mode account for M5; later, per action, the hosted staging test entitlement seed (OQ-2) and the production App Review allowance (OQ-3); before live billing, the business entity, bank, tax advisor and registrations, then Stripe live activation; before launch, Shopify's written answer on charging custom-distribution installs and on its revenue share.
- **Later:** a Shopify Partner account and a fresh development store (never the live shop). Optional clean-up: E2B template `pdht65h2trfuizuvmotc`, the WorkOS loopback callback `127.0.0.1:4110`, the WorkOS staging test user.
- **Done 2026-10-19** (per-action approval; `docs/evidence/live/2026-10-19-*`): Pro (owner), the $10 Actions budget, branch protection, the GitHub `staging` environment and variables; Neon `morrow-staging` (`sweet-sound-23947873`); WorkOS sign-up off; Wrangler OAuth revoked and the $5 Cloudflare alert; `~/.config/morrow/staging`.

## Open unknown-outcome provider operations

None. The 2026-10-20 Neon probe branch (`br-spring-boat-b71bm6dq`, exit 13 before a result) was reconciled and expired; cleanup verified at 11:21Z (`docs/evidence/live/2026-10-20-neon-probe-branch.md`).

## Active approval cards

- `staging-card-1` (`docs/decisions/approvals/staging.md`): staging only; approved 2026-10-19, valid until 2026-11-18 or the first production resource. Effects used: E3 once (the probe branch above); E4 (two queues), E5 (the widget), E6 (the redirect) and E9 (census and permission reads), all 2026-10-20 (`docs/evidence/live/2026-10-20-*`). E11 is suspended (ADR-0021).
