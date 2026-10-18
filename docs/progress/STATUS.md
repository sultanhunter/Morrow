# Morrow status

Updated 2026-10-18. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014). Merged into it:
- PR #1 the foundation; PR #2 the P03.T04c/d overhaul; PR #3 ADR-0014.
- PR #4: P05.T01x Part A. Migration 0012 retires plan-number identifiers: `morrow-login-v1`, `morrow-self-logout-v1`, `morrow_id_`.
- PR #5: P04.T02a, the deployable composition root: api, broker, orchestrator and connector-placeholder Workers, `scripts/edge.mjs`, `lab:edge-workers` and `lab:edge-postgresql` (ADR-0007).
- PR #6: P01.T02a PR-A, executor classes and human-only kill switches (ADR-0005, §2 confirmed 2026-10-18).
- PR #7: ADR-0008 accepted (connector on Cloudflare Workers with `@shopify/shopify-api`; secret-dependent calls in the broker).
- PR #8: P01.T02a PR-B, review policy, Proposal@2, Approval@2 and `@morrow/policy/review` (ADR-0011).

In progress:
- **Owner decisions of 2026-10-18** (branch `claude/decisions-billing-collab`): ADR-0015 to ADR-0018, the billing-ownership rewrite, Stripe in the provider register, the plan amendments, the resolved packets P01.T02c, P06.T01b, P14.T01a, P05.T01y and P05.T01z, and the redesigned P01.T04a packet (billing routes by origin, ADR-0015).
- **P01.T04a** has landed on that branch. Its owner questions OQ-1 to OQ-3 were resolved on 2026-10-18 (ADR-0015 follow-up decisions). Its PR-A and PR-B are the next billing step.
- **P03.T04e** (shared PostgreSQL harness) ships in its own PR.
- **P06.T01a** (`claude/p06-t01a-work-commands`): work commands and reads on the ADR-0010 tenant data pattern. Migrations 0014 (identity bridge) and 0015 (`morrow_work`), `@morrow/work`, `/workspace/:ws/work/*`, `@morrow/contracts/work-permissions`, the `tests/tenant-conformance/` harness and three labs in the new `pg-work` CI group. Local labs passed before the 2026-10-18 review round; its fixes (a fair organization interlock that the revocation, store linking and browser admission take exclusively, the locked assignee/respondent recheck, the answer tenant check, stricter lab assertions) passed typecheck and the static and unit tests, and hosted CI on the PR head is their first lab run. Awaiting PR CI, the Tier 2 security review and merge.
  - **Merge with P05.T01x Part B (PR #10).** Sequence 13 is reserved for Part B; the manifest stays append-only (`tests/migration-history.test.mjs`). If Part B merges first: keep the manifest in order 1..15, delete the 13 reservation, union the broker role tables (8 roles: Part B drops `morrow_identity_resolution` and adds `morrow_identity_onboarding`; this branch adds `morrow_api_worker`), regenerate `apps/broker/worker-configuration.d.ts` with `npm run edge:types`, update the role counts and lists in the tests, `scripts/edge-workers-lab.mjs`, `package.json` and `docs/development/ci.md`, then run `npm run ci`, `lab:group:pg-work` and the Part B labs on the merged head. If this PR merges first, Part B renumbers 0013 to 0016 and its `slice(0, 13)` labs follow. The conformance harness already maps Part B's role prerequisite by migration name.

## Decisions recorded 2026-10-18

- **ADR-0015 billing routes by origin** (supersedes ADR-0006). Website signups pay on Morrow checkout (Stripe Billing with Stripe Tax; Morrow is the seller) before linking a store. Every other paying workspace, including all Shopify-origin merchants, pays through Shopify App Pricing and never sees Morrow checkout. The route is fixed server-side at the first completed payment (plan Security invariant 24). Stripe is selected and blocked: no account, keys or provider calls until an approved packet.
- **ADR-0016 collaboration contracts v1.1** (P01.T02c Q1-Q6): as recommended, except workspace admins (holders of `administer` on `workspace.conversation.create`) can read private Asks through audited, read-only reads.
- **ADR-0017 membership authority** (P05.T01z Q1 and Q3): accepted as designed.
- **ADR-0018 proposals without a task** (P06.T01b Q1): `taskId` may be null only for human-made governance proposals, with `requestedBy` = the proposer; agents always need a task. A routine P01.T02a follow-up PR makes the Proposal@2 candidate edit before P06.T01b PR-1 merges.
- **P01.T04a OQ-1 to OQ-3 (ADR-0015 follow-up decisions):** purchase permission is decided with the checkout (P18.T01a). M4 uses an owner-run test entitlement seed in development and staging. App Review gets an owner-approved review allowance. Future per-action owner approvals: the staging seed for M4, and the production review allowance before App Review submission.
- **P03.T04e OQ-1 (routine):** the heavy CI job runs on `workflow_dispatch` plus a weekly schedule, the packet default.

## Last green commit

`d797b1a` on `main`, the merge of PR #5. Its push run 39070711182 passed, as did hosted run 39070332528 on its PR head `fedb4e6`, on all 10 jobs. PRs #7 and #8 merged after it (`main` is at `80b6897`); record their runs here once confirmed.

## Next actions

1. Review and merge the decisions branch (documents only; Tier 2 AI review).
2. P05.T01x Part B, signup and workspace list (ADR-0009); P01.T02a PR-B is merged.
3. P06.T01a: Tier 2 security review, PR CI and merge. Then the ADR-0018 Proposal@2 edit, P06.T01b, P06.T02a (event transport), P06.T01c (OperationLedger), P01.T02c (ADR-0016) and P01.T02b.
4. P01.T04a PR-A (paid-work gate and billing contracts), then PR-B (billing route library), after the decisions branch merges.
5. M1 hosted staging (P04.T01i), once the owner sign-ins below are done.

Open plan follow-ups:
- P06.T01a AC08 soak: set `MORROW_WORK_SOAK=1` for `lab:work-postgresql` in the P03.T04e heavy job (`workflow_dispatch` plus weekly); AC08 stays not evidenced until a soak artifact exists.
- Work routes in production: production cannot map today (ADR-0007 item 9), so the deployed api serves them 401 with no SQL. Whoever enables production mapping must also gate the work routes on P09.T05 (packet hard ordering b).
- Superseded banners on `docs/references/*`; `docs/contracts/billing-entitlements.md` still names App Pricing as the only route (P01.T04a updates it).
- The rest of P03.T04e: formatting ignore file, unit-test concurrency, shared PostgreSQL 17 template-database harness, heavy-fault job.
- The P05.T01x Part B PR splits the plan's P05.T01x bullet into sub-bullets, to respect the 2,000-character line limit.

## Blockers

None for local work. Hosted staging (M1) waits on the owner actions below. Billing activation waits on the billing owner actions.

## Pending owner actions

- **Sign-offs:** plan R1 (Tier 3).
- **GitHub:** decide on GitHub Pro or an organization on GitHub Team, so `main` gets enforced branch protection requiring the `foundation` check before the first hosted deploy (ADR-0014).
- **Codex:** confirm the previous Codex Morrow task is stopped and no longer writes to the repository or its pull requests.
- **M1 prerequisites (P04.T01i):** register the domain; create a dedicated Cloudflare account and share its account ID (an identifier, not a secret); authenticate the Neon CLI and reset the operator password; once the domain exists, configure the WorkOS staging callback and rotate the API key; decide on spending (Workers Paid, the domain, Neon Launch for staging); approve each M1 effect individually or approve standing staging cards. No card may rely on the OperationLedger before P06.T01c lands. For the work API (P06.T01a): create the `morrow_api_worker` login and place its password as the broker secret `MORROW_DB_PASSWORD_MORROW_API_WORKER`; the broker requires it, so broker health stays false until it is set.
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
