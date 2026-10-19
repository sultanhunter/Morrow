# Morrow status

Updated 2026-10-19. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014). Merged into it:
- PR #1 the foundation; PR #2 the P03.T04c/d overhaul; PR #3 ADR-0014.
- PR #4: P05.T01x Part A. Migration 0012 retires plan-number identifiers: `morrow-login-v1`, `morrow-self-logout-v1`, `morrow_id_`.
- PR #5: P04.T02a, the deployable composition root: api, broker, orchestrator and connector-placeholder Workers, `scripts/edge.mjs`, `lab:edge-workers` and `lab:edge-postgresql` (ADR-0007).
- PR #6: P01.T02a PR-A, executor classes and human-only kill switches (ADR-0005, §2 confirmed 2026-10-18).
- PR #7: ADR-0008 accepted (connector on Cloudflare Workers with `@shopify/shopify-api`; secret-dependent calls in the broker).
- PR #8: P01.T02a PR-B, review policy, Proposal@2, Approval@2 and `@morrow/policy/review` (ADR-0011).
- PR #9: the owner decisions of 2026-10-18: ADR-0015 to ADR-0018, the billing-ownership rewrite, Stripe in the provider register, the plan amendments, the resolved packets P01.T02c, P06.T01b, P14.T01a, P05.T01y and P05.T01z, and the redesigned P01.T04a packet (billing routes by origin, ADR-0015).
- PR #10: P05.T01x Part B (ADR-0009), squash-merged as `e51e5b7`: migration 0013 (account login, enrollment, first-owner signup, `GET /workspaces`, `POST /organizations`), the `morrow_identity_onboarding` executor, `lab:account-onboarding` (pg-linking) and `lab:account-workers` (workers).
- PR #12: P06.T01a (ADR-0010), merged as `06e4dfe`: migrations 0014 (identity bridge and organization interlock) and 0015 (`morrow_work`), `@morrow/work`, `/workspace/:ws/work/*`, `@morrow/contracts/work-permissions`, the `tests/tenant-conformance/` harness and three labs in the `pg-work` CI group. Verified waits for the P05 exit gate.
- PR #13: the ADR-0018 Proposal@2 edit (P01.T02a-AC27), merged as `08e5ebf`: nullable `taskId` only for human governance proposals, `TASK_REQUIRED`/`TASK_MISMATCH` and the `requestedBy` derivation in `checkProposal`. It unblocks P06.T01b PR-1.
- PR #14: P01.T04a PR-A, merged as `bba3cec`: entitlement gates only paid work (`isPaidWork`, `docs/contracts/paid-work.json`, 27 capabilities), `inspectEntitlementWriters`, the contract v1.1 billing layer and the OQ-2 test entitlement seed branch. It applied the "Part B and P06.T01a merge first" coordination (P01.T04a §8.1, §9).
- PR #15: P14.T01a PR-1, merged as `5ad6cc7` (provisional under ADR-0003): the option 1 shell, sign-in, workspace entry and sign-out over HTTP, the dev-only fixture mode, the a11y matrix and the CI `ui` job (`docs/acceptance/P14.md`). PR-2 (account and work wiring) follows.
- PR #11: P03.T04e PR-A, merged as `f8314e8`: `prettier --check .` under one reviewed `.prettierignore`, unit test files run concurrently through `scripts/run-tests.mjs` (empty serial list), required `executeAs` and pinned prerequisites on every `migrations/manifest.json` row, and `heavy-faults.yml` (manual plus weekly `unit-stress`). Still open: its AC22 `workflow_dispatch` run of `heavy-faults.yml` on `main` (about 18 billed minutes), and the AC04 hosted totals and hosted part of AC05, which P03.T04f moves from the removed `unit` shards to its first hosted `checks` job.

In progress:
- PR #11 (P03.T04e PR-A) merged as `f8314e8`. PR #16 (P03.T04f CI cost reduction) merged as `5806049` on 2026-10-19: light runs for Markdown-only PRs and for pushes whose tree equals the merged PR head; 9 jobs instead of 12; the pgwire concurrent-callback hold now records its stage and frames (hosted run 39260319338 held once at `actual_84_callback_delivery_3` with a 303 response, then passed on rerun).
- **P04.T01i PR-A and P04.T01j PR-A** (branch `claude/docs-staging-and-design-refs`, pushed, no PR yet; Markdown only, with the Mobbin design references): ADR-0019 and ADR-0020 Accepted, the approved card `staging-card-1`, the ADR-0014 item 5 amendment, the plan edits (P04.T01i origin, reachability and card; new P04.T01j and P05.T01ab bullets; P04.T03a minimal baseline; invariant 18's exception) and open acceptance sections. M1's journey (AC12) also waits for P14.T01a PR-2. The staging row of `deployment-policy.json` moves to P04.T01i PR-B.
- **P04.T01j PR-B** (branch `claude/p04-t01j-createrole-administrator`, pushed, no PR yet; on top of PR-A): migrations 0005–0015 rebaselined once under ADR-0020 (the recorded administrator and the closed membership set), the frozen rebaseline record in `migration-history` (`closedBy` null), the D5 preflight in eight identity adapters and both oracles, `lab:createrole-administrator` in `pg-core` (101 checks) and the conformance suite in createrole mode. Local `npm run ci`, `smoke:scaffold` and every pg group pass. Open: hosted CI, Tier 2 review plus `/security-review`, the owner's item 7 confirmation, the M-J1 finding in `lab:provider-subject-resolution` (a member of the identity owner now denies; packet notes), AC14 (with P04.T01i PR-B), AC15–AC16 (hosted).

## Decisions recorded 2026-10-18 and 2026-10-19

- **2026-10-19, P03.T04f OQ-1:** "Allow both (Recommended)", option (a): `foundation` passes with skipped lab jobs on a Markdown-only PR or a push whose merged tree equals the merged PR head (ADR-0014 item 4 amendment). **GitHub plan (P04.T01i OQ-2):** "GitHub Pro (Recommended)", with a capped Actions spending limit (about $10) and branch protection on `main` (requires `foundation`, no approving review) once Pro is active.
- **2026-10-19, ADR-0019 and `staging-card-1`:** "Approve both (Recommended)" (staging on workers.dev, continuous deploy from `main`, Turnstile and per-IP limits before hosted login, branch protection before production; ADR-0014 item 5 amended; the P05.T01x §11 sign-off is resolved). **ADR-0020:** "Approve ADR-0020 (Recommended)", P04.T01i OQ-1 (B): migrations 0005–0015 are rebaselined once by P04.T01j, which merges before any other migration (P05.T01y's 0016, P06.T01b PR-1). **P04.T01i OQ-2:** "GitHub Pro (Recommended)", with a capped Actions spending limit (about $10) and branch protection on `main` as soon as Pro is active.
- **ADR-0015 billing routes by origin** (supersedes ADR-0006). Website signups pay on Morrow checkout (Stripe Billing with Stripe Tax; Morrow is the seller) before linking a store. Every other paying workspace, including all Shopify-origin merchants, pays through Shopify App Pricing and never sees Morrow checkout. The route is fixed server-side at the first completed payment (plan Security invariant 24). Stripe is selected and blocked: no account, keys or provider calls until an approved packet.
- **ADR-0016 collaboration contracts v1.1** (P01.T02c Q1-Q6): as recommended, except workspace admins (holders of `administer` on `workspace.conversation.create`) can read private Asks through audited, read-only reads.
- **ADR-0017 membership authority** (P05.T01z Q1 and Q3): accepted as designed.
- **ADR-0018 proposals without a task** (P06.T01b Q1): `taskId` may be null only for human-made governance proposals, with `requestedBy` = the proposer; agents always need a task (landed in PR #13).
- **P01.T04a OQ-1 to OQ-3 (ADR-0015 follow-up decisions):** purchase permission is decided with the checkout (P18.T01a). M4 uses an owner-run test entitlement seed in development and staging. App Review gets an owner-approved review allowance. Future per-action owner approvals: the staging seed for M4, and the production review allowance before App Review submission.
- **P03.T04e OQ-1 (routine):** the heavy CI job runs on `workflow_dispatch` plus a weekly schedule, the packet default.

## Last green commit

`bba3cec` on `main`, the merge of PR #14: push run 39169685269 passed. Earlier: `08e5ebf` (PR #13) push run 39168226191; `06e4dfe` (PR #12) push run 39166650248; `e51e5b7` (PR #10) push run 39160961579, all 10 jobs. Not recorded here: the push run 39171677853 on `5ad6cc7` (PR #15) and the push run on `f8314e8` (PR #11); record their results. After P03.T04f merges, a push run that merges an unchanged PR head runs only `checks`; record such a commit with its push run and the PR run on the merged head.

## Next actions

MVP fast track (ADR-0021; `docs/plan/mvp.md`). M1, staging live:
1. Merge train: PR #16 (P03.T04f) first, then this docs PR (Markdown only, light run), then P14.T01a PR-2, P01.T02c PR-A, P01.T04a PR-B (with the walkthrough-count fix 86→90 from the rehearsal), P04.T01j PR-B, P05.T01y (0016 moved to the ADR-0020 helpers), P06.T01b PR-1, P05.T01ab, then the trimmed P04.T01i PR-B (deploy after green CI, migrations, roles, secrets). Each PR gets one AI review.
2. Staging bring-up under `staging-card-1` once the owner's D9 secrets exist; owner sign-in on staging.
3. Then M2 Shopify connect, M3 listings agent and M5 billing in parallel; M4 approve and apply; M6 beta readiness.

Open plan follow-ups (heavy soak and fault suites are deferred past launch, ADR-0021):
- Work routes in production: production cannot map today (ADR-0007 item 9), so the deployed api serves them 401 with no SQL. Whoever enables production mapping must also gate the work routes on P09.T05 (packet hard ordering b).
- Superseded banners on `docs/references/*`.
- A forward migration (0016 or later) that routes the 0006, 0007, 0009 and 0011 security-definer guards through `morrow_identity.executor_role_safe`, so every definer checks all ten executor roles (P05.T01x Part B security review, informational).
- Timing fixes (routine, ADR-0002) if hosted `unit-stress` confirms them: `tests/broker-client.test.mjs` AC30 and the `tests/standalone-login-http.test.mjs` 5,000 ms entry-timeout case each flaked once under loaded-host local stress.

## Blockers

None for local work. Hosted staging (M1) waits on the owner actions below, P04.T01j, P04.T01i PR-B and P05.T01ab. Billing activation waits on the billing owner actions.

## Pending owner actions

- **Sign-off:** Plan R1 (Tier 3). The P01 contract sign-off also freezes the v1.1 billing layer, including two PR-A review choices: Shopify-route money is USD-only, and `AllocationShare@2` is a declared superset of v1.
- **GitHub:** done 2026-10-19. Pro is active, the Actions budget is $10 with a hard stop, and branch protection on `main` requires `foundation` (enforce_admins, no review). See `docs/evidence/live/2026-10-19-github-*`. The ChatGPT Codex Connector app stays installed by owner choice (accepted risk; the Codex task is stopped).
- **M1 done by Claude (per-action approval, 2026-10-19; `docs/evidence/live/2026-10-19-*`):** GitHub `staging` environment and variables; Neon `morrow-staging` (`sweet-sound-23947873`); WorkOS sign-up off; Cloudflare Wrangler OAuth revoked and a $5 alert; `~/.config/morrow/staging`.
- **M1 owner-only:** delete Neon `cool-butterfly-64820147` and create the project key; change the Cloudflare Global API Key and create the two tokens (TTL 2026-11-18); a new WorkOS key, revoking old ones; `gh secret set CLOUDFLARE_API_TOKEN --env staging`; `tmutil addexclusion ~/.config/morrow`. OQ-3: the owner keeps the shared Cloudflare account, with the census at every deploy.
- **Credential rotation:** rotate the E2B personal key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- **Billing (ADR-0015):**
  - When payments work starts: create a Stripe account in test mode (before P18.T01a).
  - Per action, later: the hosted staging test entitlement seed for M4 (OQ-2), and the production App Review allowance before submission (OQ-3).
  - Before live billing: a legal business entity, a bank account, a tax advisor, and tax registrations where required; then Stripe live activation. For the Shopify route: the Partner payout and tax profile.
  - Before launch: a written answer from Shopify on whether its revenue share covers Morrow-direct revenue, and the App Review outcome for the split model.
- **Later:** a Shopify Partner account and a fresh development store, never the live shop; an OpenAI staging project with a budget cap. **Optional console clean-up:** E2B template `pdht65h2trfuizuvmotc`, the WorkOS loopback callback `127.0.0.1:4110`, and the WorkOS staging test user.

## Open unknown-outcome provider operations

None. `docs/history/INDEX.md` cites the terminal state of every earlier provider operation at the archive tag.

## Active approval cards

- `staging-card-1` (`docs/decisions/approvals/staging.md`): staging only; approved 2026-10-19, valid until 2026-11-18 or the first production resource. No effect used yet. Earlier provider allowances are consumed.
