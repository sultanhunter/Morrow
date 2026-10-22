# Morrow status

Updated 2026-10-23. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`; the merge-train detail of 2026-10-22 is `git show cbccb3a:docs/progress/STATUS.md`.

## Active work

The launch plan is now ADR-0023 (its decisions approved 2026-10-23; the record as written awaits the owner's acceptance): a lean, full-featured MVP where a shop's people and AI agents run the business together, replacing ADR-0021's listings beta. `docs/plan/mvp.md` holds the scope, agents and specialists, tracks T0–T18, gates G1–G18, dates and cut rules. Week 0 starts Monday 2026-10-26; public launch is planned for Monday 2027-03-01 (range mid-February to April 2027).
- **ADR-0023 docs PR** (`claude/mvp-redefinition-adr`): the ADR, `mvp.md`, the CLAUDE.md constraint lines (MVP, standalone plus a minimal embedded home, billing), build-plan launch-order notes, this file and five live records. PR #45; Tier 2 AI review done; accepted as written by the owner on 2026-10-23 with the three CLAUDE.md lines ("approve ADR-0023 and the CLAUDE.md lines"); open: hosted `foundation`, merge.
- **Project graph, phase 0** (`claude/graph-engine`, routine, built separately): the engine, derived nodes and `graph:check`. Then phase 1 (the MVP as nodes) and later the CLAUDE.md session-step-1 change.
- **MVP tracks starting W0–W1:** T0 companion ADRs on the first weekly decision sheet; T1's remainder; T2 interfaces (contracts with fakes, merged in W1); T3 gateway; T4 agent platform (critical path); T6 collaboration backend; T7 workspace UI; T10 runtime port, fake and conformance; T16 graph; T18 specialists brief. T8 Shopify waits on G3.

Merged on `main` (trunk, ADR-0014; branch protection requires `foundation`): PRs #1–#44; `main` is at `cbccb3a`. #38 (`ea69518`, merged earlier on 2026-10-22) landed the CI-runner tooling (CI back on GitHub-hosted runners). The merge train of 2026-10-22/23 then landed with a merge commit each: #37 M5 PR-1 billing with Stripe switched off (0028–0029); #39 M3 PR-1 Listings authority and credits (0030–0033); #40 the staging test entitlement (0034–0035); #41 the api session rate limit; #42 PR-0, the 384 KiB broker cap; #43 M2 PR-3 Shopify reads, uninstall, compliance webhooks and privacy requests (0036–0037); #44 M3 PR-2 Claude drafting with the model switch committed off (0038).

## Staging (live, `staging-card-1`)

- `migrate` applied 0028–0038 after each merge (ledger 38, schema head `07f37ce0…b205`); every deploy then deployed `main`, the last one `cbccb3a`, health ready. Records (dated UTC, like earlier records): `docs/evidence/live/2026-10-22-neon-staging-migrate-0028-0029.md` and `…-0030-0038-and-deploys.md`.
- The deploy flag is on, so each green push to `main` deploys. A merge that carries migrations stops its deploy at gate 3 until `staging:migrate` (E3) runs; then rerun it. Routine fix queued: gate 3 polls the schema head for about 3 minutes.
- Switches: the model provider is committed off (no Anthropic key); Stripe is committed off (the broker requires its 14 secret names). E13, the test entitlement, is not yet used.
- E2B: project `Morrow-staging` has a payment method, a US$20 usage limit and a US$5 alert; no key, sandbox or template (`2026-10-22-e2b-usage-limit.md`).

## Decisions recorded 2026-10-22 and 2026-10-23 (owner, in chat; quoted in ADR-0023, Approval)

- **2026-10-23:** "yes to all recommended" (Q12): ADR-0023 decisions 1–10 with their recommended options, plus the owner's addition of specialists under the Coordinator; the E2B questions were sent at about 18:41Z on 2026-10-22 UTC (`2026-10-22-e2b-support-questions.md`). Q13 asked why billing moves to Shopify. "yes to both, go with option A and specialists" (Q14): decision 11 (specialists) and billing option A (Shopify App Pricing at launch; Stripe code kept off; ADR-0015's split kept).
- **2026-10-22:** drop the beta and launch a lean, full-featured MVP (Q11), after the re-analysis and graph request (Q10); an agent runtime with E2B in the MVP (Q2–Q4); keep the release date with parallel work (Q5); the morning decisions 2–14 and Mac CI (Q1); runner risk (a) accepted and the old E2B key deleted (Q6); the repository made public (Q7–Q9; `2026-10-22-github-public-and-ci-runner.md`).
- Earlier decisions are in ADR-0015 to ADR-0022, the briefs and the earlier STATUS above.

## Last green commit

`cbccb3a` on `main` (#44): `foundation` push run 39852891944 green; `Deploy staging` run 39853317390 deployed it on rerun after the gate-3 race. Earlier on 2026-10-22 UTC: `f5361f4` (#43) run 39844445633; `3154139` (#40) run 39843048040; `87541dc` (#39) run 39841848604; `7484df2` (#37) run 39840134758 (the first `main` run on GitHub-hosted runners after the repository went public). The `foundation` runs of #41 and #42 were cancelled by the next push.

## Next actions

1. Merge #45 (ADR-0023) on a green `foundation`.
2. Finish and merge graph phase 0, then phase 1 (the MVP as nodes).
3. W0–W1: draft the G8 questions to Shopify Partner support (the embedded home for a standalone workspace, usage charges for credits) for the owner's approval to send; draft the companion ADRs (Proactive authority, Shopify public app, Billing and price, Agent loop and model, Specialist authority, Runtime and E2B, Email, Data) for the first decision sheet; T2 contracts with fakes; the T18 specialists brief; the T10 port, fake and conformance.
4. T1: the AC11 acceptance run and the owner's assisted staging sign-in (AC12a); the cleanup PR (dead code and checks, the heavy-faults schedule to manual dispatch only, the runner tooling; the Stripe code stays, switched off; the `mvp.md M6` comment in `packages/work/src/redaction.ts`); the gate-3 polling fix. Re-frame `docs/briefs/mvp-architecture.md` and the M2–M5 briefs for ADR-0023 (their `mvp.md` M-milestone citations map to tracks as `mvp.md` lists).
5. Propose standing staging card 2 (G6) before `staging-card-1` ends on 2026-11-18.
6. Carried follow-ups: a KEK fingerprint check in `staging:put-secret`; the #30 advisories; the open plan follow-ups listed in the 2026-10-22 STATUS.

## Blockers

None for local work. **E2B's written answers** (G5) block the E2B adapter code (T10, from W3); the port, fake and TypeScript fallbacks do not wait. **Shopify:** every Shopify test waits on the Partner account, public app record and development stores (G3); written answers from Partner support (G8); App Review comes later (G13 submission in W10, G14 review in W11–W16, no published timeframe). Live evals need an Anthropic staging key by W3 (G4). Production needs its custody ADR first (ADR-0007 item 9). **Unverified premise:** M-N3 decision (1)'s "Neon stores only the hash" is measured for `pg_authid` only (optional E3 check: one read of Neon's reveal-password endpoint for a SQL-set probe role).

## Pending owner actions

- **G8:** approval to send the questions to Shopify Partner support, once drafted.
- **Open questions:** (1) M2 PR-3 question (3), the scope-change stop (`docs/briefs/M2-shopify-connect.md`, Open questions): approve it as an ADR-0022 items 13 and 15 amendment, or record the change and leave the installation in place; (2) M3 question 6 (`docs/briefs/M3-listings-agent.md`): the call budgets assume a floor of 128,000 output tokens an hour; measure it with one medium and one high run per model in the approved staging smoke before the model switch is turned on?
- **Old credential rotations:** the Cloudflare Global API Key; a new WorkOS key that revokes the old ones; delete the old Neon project `cool-butterfly-64820147`; delete the local `cloudflare-ci-token` and `cloudflare-operator-token.old-*` files; `tmutil addexclusion ~/.config/morrow`. The old E2B key is deleted (Q6). Optional: a metadata-only check that no transient secrets file is left under `~/.config/morrow/staging/tmp`.
- **GitGuardian:** the alert on `apps/shopify-connector/worker/database.ts` line 22 is a false positive (a SQL role-check string, not a secret); mark it so in GitGuardian.
- **ChatGPT link:** `docs/references/architecture.md` line 30 links a public shared conversation; now that the repository is public, keep it or have it removed.
- **For the tracks:** G3 (Partner account, public app record, two or three development stores); G4 (an Anthropic staging workspace with a monthly spend limit, its key placed by the owner); G7 (the sending domain); G16 (entity, Partner payout and tax, privacy policy, terms, DPAs); forward E2B's answers when they arrive; keep or delete the retained E2B template.
- **Sign-off:** Plan R1 (Tier 3); the acknowledgement of P04.T01j's M-N1+ items 2–5 (`2026-10-21-neon-mn1plus-catalog.md`).

## Open unknown-outcome provider operations

None. Every migrate, deploy and rerun of 2026-10-22/23 reported its result. The three Neon probe branches of 2026-10-20 carried expiries; their deletion is still not read back.

## Active approval cards

- `staging-card-1` (`docs/decisions/approvals/staging.md`): staging only; approved 2026-10-19; valid until 2026-11-18 or the first production resource. E1 amended 2026-10-21 (the connector hostname); E13 added 2026-10-21 (per use; not yet used). Effects used through 2026-10-23: E1 (deploys and reruns), E2, E3 (probes, `migrate` 0001–0038, `provision-roles --first`, `seed-platform`), E4, E5, E6, E9, E10 (`STAGING_SCHEMA_HEAD`, `STAGING_DEPLOY_ENABLED=1`), E12 (`unkill`). E11 stays suspended (ADR-0021, the trimmed P04.T01i PR-B). Staging card 2 is to be proposed (ADR-0023 decision 10).
