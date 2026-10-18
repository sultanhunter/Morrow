# Morrow status

Updated 2026-10-19. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014), at `400aa44`. Merged into it:
- PR #1 the foundation; PR #2 the P03.T04c/d overhaul; PR #3 ADR-0014.
- PR #4: P05.T01x Part A. Migration 0012 retires plan-number identifiers: `morrow-login-v1`, `morrow-self-logout-v1`, `morrow_id_`.
- PR #5: P04.T02a, the deployable composition root: api, broker, orchestrator and connector-placeholder Workers, `scripts/edge.mjs`, `lab:edge-workers` and `lab:edge-postgresql` (ADR-0007).
- PR #6: P01.T02a PR-A, executor classes and human-only kill switches (ADR-0005, §2 confirmed 2026-10-18).
- PR #7: ADR-0008 accepted (connector on Cloudflare Workers with `@shopify/shopify-api`; secret-dependent calls in the broker).
- PR #8: P01.T02a PR-B, review policy, Proposal@2, Approval@2 and `@morrow/policy/review` (ADR-0011).
- PR #9: the owner decisions of 2026-10-18. ADR-0015 to ADR-0018, the billing-ownership rewrite, Stripe in the provider register, the plan amendments, the resolved packets P01.T02c, P06.T01b, P14.T01a, P05.T01y and P05.T01z, and the redesigned P01.T04a packet with its OQ-1 to OQ-3 decisions.

In progress (pushed branches; PR numbers where known):
- **P05.T01x Part B**, signup and workspace list (`claude/p05-t01x-b-signup`, PR #10): migration 0013 and three contracts v1.1 definitions.
- **P06.T01a**, work commands (`claude/p06-t01a-work-commands`, PR #12): migrations 0014 and 0015.
- **P01.T04a PR-A**, paid-work gate, billing contracts v1.1 and the test entitlement seed (`claude/p01-t04a-a-paid-work-gate`); unblocked since PR #9 merged.
- **ADR-0018 Proposal@2 edit**, proposals without a task (`claude/p01-t02a-c-proposal-task-optional`).
- **P03.T04e PR-A**, formatting and unit-test concurrency (`claude/p03-t04e-a-format-concurrency`, based on `80b6897`).
- **P14.T01a PR-1** (`claude/p14-t01a-provisional-ui`): the option 1 shell, sign-in, workspace entry and sign-out over HTTP, the dev-only fixture mode, the 156-case a11y matrix and the CI `ui` job (`docs/acceptance/P14.md`). The Tier 2 review findings of 2026-10-19 are applied; the new and changed browser checks passed locally, and the full matrix waits on the hosted `ui` job. Merge order with Part B: whichever lands second sets `composed.loginBodyVersion` to match the server (a unit test fails until it does), and both carry the same `account` route entry.

## Decisions recorded 2026-10-18

- **ADR-0015 billing routes by origin** (supersedes ADR-0006). Website signups pay on Morrow checkout (Stripe Billing with Stripe Tax; Morrow is the seller) before linking a store. Every other paying workspace, including all Shopify-origin merchants, pays through Shopify App Pricing and never sees Morrow checkout. The route is fixed server-side at the first completed payment (plan Security invariant 24). Stripe is selected and blocked: no account, keys or provider calls until an approved packet.
- **ADR-0016 collaboration contracts v1.1** (P01.T02c Q1-Q6): as recommended, except workspace admins (holders of `administer` on `workspace.conversation.create`) can read private Asks through audited, read-only reads.
- **ADR-0017 membership authority** (P05.T01z Q1 and Q3): accepted as designed.
- **ADR-0018 proposals without a task** (P06.T01b Q1): `taskId` may be null only for human-made governance proposals, with `requestedBy` = the proposer; agents always need a task. A routine P01.T02a follow-up PR makes the Proposal@2 candidate edit before P06.T01b PR-1 merges.
- **P01.T04a OQ-1 to OQ-3 (ADR-0015 follow-up decisions):** purchase permission is decided with the checkout (P18.T01a). M4 uses an owner-run test entitlement seed in development and staging. App Review gets an owner-approved review allowance. Future per-action owner approvals: the staging seed for M4, and the production review allowance before App Review submission.
- **P03.T04e OQ-1 (routine):** the heavy CI job runs on `workflow_dispatch` plus a weekly schedule, the packet default.

## Last green commit

`d797b1a` on `main`, the merge of PR #5. Its push run 39070711182 passed, as did hosted run 39070332528 on its PR head `fedb4e6`, on all 10 jobs. PRs #7, #8 and #9 merged after it, and `main` is at `400aa44`. Their hosted runs are not confirmed in this file; record them here once confirmed.

## Next actions

1. Review and merge P05.T01x Part B (PR #10) and P06.T01a (PR #12). Then the ADR-0018 Proposal@2 edit, P06.T01b, P01.T02c (ADR-0016) and P01.T02b.
   - P14.T01a: merge PR-1 once its hosted `foundation` and `ui` jobs are green; PR-2 (account and work wiring) follows Part B and P06.T01a.
2. P01.T04a PR-A (paid-work gate and billing contracts), then PR-B (billing route library).
3. M1 hosted staging (P04.T01i), once the owner sign-ins below are done.

Open plan follow-ups:
- Superseded banners on `docs/references/*`; `docs/contracts/billing-entitlements.md` still names App Pricing as the only route (P01.T04a updates it).
- P03.T04e beyond PR-A: the shared PostgreSQL 17 template-database harness and the heavy-fault job.
- The P05.T01x Part B PR splits the plan's P05.T01x bullet into sub-bullets, to respect the 2,000-character line limit.

## Blockers

None for local work. Hosted staging (M1) waits on the owner actions below. Billing activation waits on the billing owner actions.

## Pending owner actions

- **Sign-offs:** plan R1 (Tier 3).
- **GitHub:** decide on GitHub Pro or an organization on GitHub Team, so `main` gets enforced branch protection requiring the `foundation` check before the first hosted deploy (ADR-0014).
- **Codex:** confirm the previous Codex Morrow task is stopped and no longer writes to the repository or its pull requests.
- **M1 prerequisites (P04.T01i):** register the domain; create a dedicated Cloudflare account and share its account ID (an identifier, not a secret); authenticate the Neon CLI and reset the operator password; once the domain exists, configure the WorkOS staging callback and rotate the API key; decide on spending (Workers Paid, the domain, Neon Launch for staging); approve each M1 effect individually or approve standing staging cards. No card may rely on the OperationLedger before P06.T01c lands.
- **Credential rotation:** rotate the E2B personal key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- **Billing (ADR-0015):**
  - When payments work starts: create a Stripe account in test mode.
  - Before live billing: a legal business entity, a bank account, a tax advisor, and tax registrations where required; then Stripe live activation.
  - For the Shopify route: the Shopify Partner payout and tax profile.
  - Before launch: a written answer from Shopify on whether its revenue share covers Morrow-direct revenue, and the App Review outcome for the split model.
- **Later:** a Shopify Partner account and a fresh development store, never the live shop; an OpenAI staging project with a budget cap.
- **Optional console clean-up:** E2B template `pdht65h2trfuizuvmotc`, the WorkOS loopback callback `127.0.0.1:4110`, and the WorkOS staging test user.

## Open unknown-outcome provider operations

None. `docs/history/INDEX.md` cites the terminal state of every earlier provider operation at the archive tag.

## Active approval cards

None. Every earlier provider allowance is consumed.
