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
- PR #15: P14.T01a PR-1, merged as `5ad6cc7` (provisional under ADR-0003): the option 1 shell, sign-in, workspace entry and sign-out over HTTP, the dev-only fixture mode, the a11y matrix and the CI `ui` job (`docs/acceptance/P14.md`).
- PR #11: P03.T04e PR-A, merged as `f8314e8`: `prettier --check .` under one `.prettierignore`, concurrent unit tests through `scripts/run-tests.mjs`, required `executeAs` and pinned prerequisites on every manifest row, and `heavy-faults.yml`. Still open: one `workflow_dispatch` run of `heavy-faults.yml` on `main` (AC22).

In progress:
- **P14.T01a PR-2** (branch `claude/p14-t01a-pr2-account-and-work`, from `f8314e8`; pushed, **no pull request yet** while GitHub Actions minutes are short): `composed.ts` turns on `account.*` and `work.*` (keep-alive and people stay off); AccountOverview, signup, Goal, Task, Question and answer decoders with validator parity; the signed-out entry at `/`, account rows and Sign out, the signup 429 hold, task-list refresh and inline answers, following `docs/design/mobbin-references.md` (committed here); 36 more `ui:check` state cases and 4 walks; the journey lab's PR-2 journeys (`scripts/workspace-ui-journey-work.mjs`, AC22-AC32) on the edge harness, which now applies 0014-0015 and logs in `morrow_api_worker` (`work` hook). Tier 2 review findings applied ("Address review findings for p14-t01a-2"): the AC30 hold was the synthetic WorkOS oracle listing expired sessions as active (fixed; the lab now passes locally, 12 of 12 cases); persons in records are checked against the tenant; Sign out on a failed account read; answers load on request; a late task reply after Cancel is kept; AC31 revokes on W only; 12 more state cases and 1 walk. Packet §12 and `docs/acceptance/P14.md` record what ran locally; the hosted `ui` job is the authority.

## Decisions recorded 2026-10-18

- **ADR-0015 billing routes by origin** (supersedes ADR-0006). Website signups pay on Morrow checkout (Stripe Billing with Stripe Tax; Morrow is the seller) before linking a store. Every other paying workspace, including all Shopify-origin merchants, pays through Shopify App Pricing and never sees Morrow checkout. The route is fixed server-side at the first completed payment (plan Security invariant 24). Stripe is selected and blocked: no account, keys or provider calls until an approved packet.
- **ADR-0016 collaboration contracts v1.1** (P01.T02c Q1-Q6): as recommended, except workspace admins (holders of `administer` on `workspace.conversation.create`) can read private Asks through audited, read-only reads.
- **ADR-0017 membership authority** (P05.T01z Q1 and Q3): accepted as designed.
- **ADR-0018 proposals without a task** (P06.T01b Q1): `taskId` may be null only for human-made governance proposals, with `requestedBy` = the proposer; agents always need a task (landed in PR #13).
- **P01.T04a OQ-1 to OQ-3 (ADR-0015 follow-up decisions):** purchase permission is decided with the checkout (P18.T01a). M4 uses an owner-run test entitlement seed in development and staging. App Review gets an owner-approved review allowance. Future per-action owner approvals: the staging seed for M4, and the production review allowance before App Review submission.
- **P03.T04e OQ-1 (routine):** the heavy CI job runs on `workflow_dispatch` plus a weekly schedule, the packet default.

## Last green commit

`bba3cec` on `main`, the merge of PR #14: push run 39169685269 passed. Earlier: `08e5ebf` (PR #13) push run 39168226191; `06e4dfe` (PR #12) push run 39166650248; `e51e5b7` (PR #10) push run 39160961579, all 10 jobs. The push runs on `5ad6cc7` (PR #15, run 39171677853) and `f8314e8` (PR #11) were not checked in the PR-2 session (no GitHub calls); record their results.

## Next actions

1. P14.T01a PR-2: open the pull request when Actions minutes allow; hosted `foundation` and `ui` green on its head (the first hosted run of the PR-2 journeys), the Tier 2 AI review plus `/security-review` (request client, decoders, fixture isolation, lab artifacts), then merge. Dispatch `heavy-faults.yml` on `main` (P03.T04e AC22).
2. P01.T04a PR-B (billing route library).
3. P06.T01b, P06.T02a (event transport), P06.T01c (OperationLedger), P01.T02c (ADR-0016) and P01.T02b.
4. M1 hosted staging (P04.T01i), once the owner sign-ins below are done. Self-service stays disabled until an owner-approved revision on a staging profile with allowlisted WorkOS sign-up (ADR-0009 items 10 and 11). Input from P03.T04e §3.1: row 1's prerequisite file is cumulative (roles for rows 1-8) and valid only on a fresh database.

Open plan follow-ups:
- P06.T01a AC08 soak: a `heavy:*` script that runs `lab:work-postgresql` with `MORROW_WORK_SOAK=1` in `heavy-faults.yml` (`workflow_dispatch` plus weekly); AC08 stays not evidenced until a soak artifact exists.
- Work routes in production: production cannot map today (ADR-0007 item 9), so the deployed api serves them 401 with no SQL. Whoever enables production mapping must also gate the work routes on P09.T05 (packet hard ordering b).
- Superseded banners on `docs/references/*`.
- Check against the WorkOS docs whether a user's session list can hold expired or ended sessions: `packages/identity/src/workos-session-status.ts` refuses the whole page on any such row (found while diagnosing the P14.T01a AC30 lab hold, where the synthetic oracle did this).
- A forward migration (0016 or later) that routes the 0006, 0007, 0009 and 0011 security-definer guards through `morrow_identity.executor_role_safe`, so every definer checks all ten executor roles (P05.T01x Part B security review, informational).
- The rest of P03.T04e: PR-B, the shared PostgreSQL 17 template-database harness and its `pg-suites` and `pg-stress` legs.
- Timing fixes (routine, ADR-0002) if hosted `unit-stress` confirms them: `tests/broker-client.test.mjs` AC30 and the `tests/standalone-login-http.test.mjs` 5,000 ms entry-timeout case each flaked once under loaded-host local stress.

## Blockers

None for local work. Hosted staging (M1) waits on the owner actions below. Billing activation waits on the billing owner actions.

## Pending owner actions

- **Sign-offs:**
  - Plan R1 (Tier 3). The P01 contract sign-off also freezes the v1.1 billing layer, including two PR-A review choices: Shopify-route money is USD-only, and `AllocationShare@2` is a declared superset of v1.
  - P05.T01x Part B, before hosted login (M1): account login start is anonymous, so its per-profile windows (10 per 10 s, 100 open) let anyone block every sign-in on a profile (packet §11). Decide whether Turnstile or the edge per-IP limiter gates hosted login activation in every environment, not only sign-up beyond the allowlist (ADR-0009 item 8).
- **GitHub:** decide on GitHub Pro or an organization on GitHub Team, so `main` gets enforced branch protection requiring the `foundation` check before the first hosted deploy (ADR-0014).
- **Codex:** confirm the previous Codex Morrow task is stopped and no longer writes to the repository or its pull requests.
- **M1 prerequisites (P04.T01i):** register the domain; create a dedicated Cloudflare account and share its account ID (an identifier, not a secret); authenticate the Neon CLI and reset the operator password; once the domain exists, configure the WorkOS staging callback and rotate the API key; decide on spending (Workers Paid, the domain, Neon Launch for staging); approve each M1 effect individually or approve standing staging cards. No card may rely on the OperationLedger before P06.T01c lands. For the work API (P06.T01a): create the `morrow_api_worker` login and place its password as the broker secret `MORROW_DB_PASSWORD_MORROW_API_WORKER`; broker health stays false until it is set.
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

None. Every earlier provider allowance is consumed.
