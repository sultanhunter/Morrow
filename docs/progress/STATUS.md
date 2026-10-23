# Morrow status

Updated 2026-10-24. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`; the merge-train detail of 2026-10-22 is `git show cbccb3a:docs/progress/STATUS.md`. Then run `npm run graph -- status`.

## Active work

**v1 is built live (ADR-0035, OD-2026-10-23-9 and -10):** the deployed environment is v1 production, built and tested on the owner's own store through the custom-distribution app, under one standing approval with a one-line log (`docs/evidence/activity-log.md`). Staging card 2, gate G6 and the G8 questions are dropped for v1. Milestone 1, "Listings suggests changes to my real products and applies the one I approve": PR 1 connect the live store, PR 2 Claude on with "Disconnect store", PR 3 review, approve and apply. The tools' card file must be repointed before 2026-11-18.

The launch plan is ADR-0023 (#45): a lean, full-featured MVP where a shop's people and AI agents run the business together. `docs/plan/mvp.md` holds the scope, tracks T0–T18, gates G1–G18, dates and cut rules. Week 0 starts Monday 2026-10-26; public launch is planned for Monday 2027-03-01 (range mid-February to April 2027).
- **Companion ADRs accepted** (track T0; `claude/companion-adrs`, PR #47): the owner approved ADR-0024 to ADR-0031 and decisions 32–38 as recommended on 2026-10-23 ("approve all as recommended", OD-2026-10-23-7), with two changes:
  - model and thinking effort per agent: the Coordinator Opus 5.5 at high, specialists Opus 5.5 at medium, the five installed agents Sonnet 5.5 at low (ADR-0027 item 12);
  - a list of sending addresses per workspace, the shop's Morrow address selected by default, the sender picked per email job, linking the merchant's own mailboxes designed for but not built (ADR-0030 item 10).
  ADR-0032 records Sunrise as the visual direction (OD-2026-10-23-6) and replaces CLAUDE.md's "Visual option 1". The same PR records answers 33–38 and the owner decisions OD-2026-10-23-4 to -7. Open: hosted `foundation`, the AI review, merge.
- **PR 18, projects behind the scenes** (`claude/t2-t6-projects-backend`, brief `docs/briefs/projects-backend.md`; ADR-0033 and ADR-0034, accepted 2026-10-24): the flow contracts, the project rules in `packages/policy/src/projects/`, migration 0039 (integration renumbers), the goal and plan-start routes, all default off (`plan-drafts-staging.json` off, start routes held; `edge:check` refuses it on before the agent loop). New `lab:plan-start` in the `work` leg; it and `lab:tenant-conformance` passed locally. Open: hosted `foundation`, the AI review (security lens), merge; then one reviewed commit to set the start routes `ready`. Waiting on other tracks: messages (T6), routines (T5), run admission (T4), task cancel edges (P06), Support's deletion path (customer-tagged goal values).
- **Project graph:** phase 0 merged (#46, `cefa3fd`). CLAUDE.md step 1 now runs `npm run graph -- status` (decision 35). Next: phase 1 (the MVP as nodes).
- **Design:** the Sunrise canvas (12 MVP screens, including model and thinking choices, the "Send from" picker and the Email addresses page) is published as a private claude.ai page. T7 replaces `docs/design/` tokens and the prototype.
- **Drafted for the owner (not in the repository):** standing staging card 2 (G6) and the questions to Shopify Partner support (G8).
- **W0–W1 tracks:** T1's remainder; T2 contracts with fakes (the new codes of ADR-0026, ADR-0027 item 12 and ADR-0030 item 10 among them); T3 gateway; T4 agent platform (critical path); T6 collaboration backend; T7 workspace UI; T10 runtime port, fake and conformance; T16 graph phase 1; T18 specialists brief. T8 Shopify waits on G3.

Merged on `main` (trunk, ADR-0014; branch protection requires `foundation`): PRs #1–#46; `main` is at `cefa3fd`. The merge train of 2026-10-22/23 landed #37 (M5 billing, Stripe off, 0028–0029), #39 (M3 PR-1, 0030–0033), #40 (test entitlement, 0034–0035), #41, #42, #43 (M2 PR-3, 0036–0037) and #44 (M3 PR-2, model switch off, 0038); then #45 (ADR-0023) and #46 (graph phase 0).

## Staging (live, `staging-card-1`)

- Ledger 38, schema head `07f37ce0…b205`; every deploy since has deployed `main`, health ready; the last, `cefa3fd`, by `Deploy staging` run 39913466966. Records: `docs/evidence/live/2026-10-22-neon-staging-migrate-0028-0029.md` and `…-0030-0038-and-deploys.md`.
- The deploy flag is on, so each green push to `main` deploys. A merge that carries migrations stops its deploy at gate 3 until `staging:migrate` (E3) runs; then rerun it. Routine fix queued: gate 3 polls the schema head for about 3 minutes.
- Switches: the model provider is committed off (no Anthropic key); Stripe is committed off. E13, the test entitlement, is not yet used.
- E2B: project `Morrow-staging` has a payment method, a US$20 usage limit and a US$5 alert; no key, sandbox or template.

## Decisions recorded 2026-10-23 (owner, in chat; graph nodes OD-2026-10-23-1 to -7)

- "yes to all recommended" (Q12) and "yes to both, go with option A and specialists" (Q14): ADR-0023's decisions 1–11 and billing option A; "approve ADR-0023 and the CLAUDE.md lines" (OD-2026-10-23-4).
- The visual direction: user-friendly and Shopify-familiar for non-technical people (OD-2026-10-23-5); Sunrise, "F2 with F3s agent avatar" (OD-2026-10-23-6).
- "approve all as recommended" with the two changes above (OD-2026-10-23-7). It also answered M2 PR-3 question 3 (a scope change stops only the agents missing a scope and raises "Reconnect"; ADR-0025 item 10, built in T8), M3 question 6 (the staging smoke measures each model at medium and high, Opus 5.5 high included) and the M-N1+ acknowledgement (P04.T01j-AC15; the late items came after the 2026-10-20 migrate of 0001–0024, not 0025–0027 as the question said).

## Last green commit

`cefa3fd` on `main` (#46): `foundation` push run 39912972984; `Deploy staging` run 39913466966. `d21f166` (#45): run 39863247879, deploy 39863843360. `cbccb3a` (#44): run 39852891944; deploy 39853317390 on rerun after the gate-3 race.

## Next actions

1. PR #47: hosted `foundation`, AI review (security lens), merge.
2. Send the owner the drafts of staging card 2 and the G8 questions; on approval, send the questions and land card 2 with its tooling change before `staging-card-1` ends on 2026-11-18.
3. W0–W1: T2 contracts with fakes; the T18 specialists brief; the T10 port, fake and conformance; graph phase 1.
4. T1: the AC11 acceptance run and the owner's assisted staging sign-in (AC12a); the cleanup PR; the gate-3 polling fix; re-frame `docs/briefs/mvp-architecture.md` and the M2–M5 briefs for ADR-0023.
5. Carried follow-ups: a KEK fingerprint check in `staging:put-secret`; the #30 advisories; `docs/decisions/providers.json`'s Shopify and E2B rows (T8, T10).

## Blockers

None for local work. **E2B's written answers** (G5) gate the E2B adapter code until 2026-11-20, after which T10 starts with conservative defaults (ADR-0029). **Shopify:** tests wait on G3; Partner support's answers (G8) gate the embedded sign-in and credit blocks. Research for G8 found that Shopify staff say enabling App Pricing on an app cannot be undone and that prepaid credit bundles may need the Billing API: do not enable App Pricing on the `morrow` app until G8 is answered. Live evals need an Anthropic staging key (G4). Production needs its custody ADR (ADR-0007 item 9).

## Pending owner actions

- **v1 setup (owner):** the private Shopify app for the owner's store and its secret sealed by the owner; the Anthropic workspace spend limit and key placed by the owner; the E2B key placed by the owner; new Cloudflare tokens before 2026-11-18. ADR-0033 and ADR-0034 (the project flow) were accepted on 2026-10-24 (OD-2026-10-24-1).
- **Confirm with catalogue version 2 and rate card v1 (by W8):** the Coordinator's 30-minute wall time and `max_tokens` 16,000 at high (ADR-0027 question 2); ADR-0026's run-hold rules written after the answer; the look-for-work 1% cap against the price (at US$99 no default pass fits); the Morrow address shape `<shop-name>@replies.<domain>`; whether a deleted shop's address may be reissued.
- **For the tracks:** G3 (Partner account, `morrow` and `morrow-staging` app records, two or three development stores; App Pricing left off); G4 (Anthropic staging workspace with a monthly spend limit, key placed by the owner); G7 (the sending domain); G16 (entity, payout and tax, privacy policy, terms, DPAs); forward E2B's answers.
- **Old credential rotations:** the Cloudflare Global API Key; a new WorkOS key that revokes the old ones; delete Neon project `cool-butterfly-64820147`; delete the local `cloudflare-ci-token` and `cloudflare-operator-token.old-*` files; `tmutil addexclusion ~/.config/morrow`.
- **Housekeeping:** mark the GitGuardian alert on `apps/shopify-connector/worker/database.ts` line 22 a false positive; keep or remove the public ChatGPT link in `docs/references/architecture.md` line 30; the owner's old email stays in git history (accepted as is).
- **Sign-off:** Plan R1 (Tier 3).

## Open unknown-outcome provider operations

None. The three Neon probe branches of 2026-10-20 carried expiries; their deletion is still not read back.

## Active approval cards

- `staging-card-1` (`docs/decisions/approvals/staging.md`): staging only; valid until 2026-11-18 or the first production resource. E1 amended 2026-10-21; E13 added 2026-10-21 (per use; not yet used). E11 stays suspended. Staging card 2 is drafted for the owner (G6).
