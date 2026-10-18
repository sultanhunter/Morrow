# Morrow status

Updated 2026-10-18. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014). These are merged into it:
- PR #1: the foundation.
- PR #2: the P03.T04c/d overhaul.
- PR #3: ADR-0014.
- PR #4: P05.T01x Part A. Migration 0012 retires plan-number identifiers: `morrow-login-v1`, `morrow-self-logout-v1`, `morrow_id_`.
- PR #5: P04.T02a, the deployable composition root. It adds the api, broker, orchestrator and connector-placeholder Workers, `scripts/edge.mjs`, and the `lab:edge-workers` and `lab:edge-postgresql` labs (ADR-0007).
- PR #6: P01.T02a PR-A, executor classes and human-only kill switches (ADR-0005, §2 confirmed 2026-10-18).
- PR #7: ADR-0008, the Shopify connector as a Cloudflare Worker.
- PR #8: P01.T02a PR-B, review policy, Proposal@2 and Approval@2 (ADR-0011).

In progress:
- **P05.T01x Part B** (`claude/p05-t01x-b-signup`, ADR-0009): migration 0013 (account login, enrollment at the first verified sign-in, first-owner signup, `GET /workspaces`, `POST /organizations`), the `morrow_identity_onboarding` executor, contract v1.1 additions and route `account`, `lab:account-onboarding` (pg-linking) and `lab:account-workers` (workers). Awaiting its PR, hosted CI (the PG-wire labs run only there) and Tier 2 review including `/security-review`. Deviations needing confirmation are in the packet's "Implementation notes (Part B)".
- **Packet designs:** P01.T04a, P01.T02c, P06.T01b, P03.T04e (shared PostgreSQL harness), P14.T01a (provisional UI), P05.T01y and P05.T01z.

Delivered in P03.T04c/d:
- Outputs go to `.artifacts/` and CI artifacts (ADR-0012).
- Plan, sequence and hash coupling are removed.
- AWS CDK, Daytona and the frozen regressions are retired (ADR-0013).
- `docs/evidence` and `docs/history` are removed from the tree (recover them from the archive tag via `docs/history/INDEX.md`).
- CI runs as parallel jobs (`docs/development/ci.md`).
- `CLAUDE.md`, the `AGENTS.md` pointer, ADR-0001 to ADR-0013, plan R1 with `npm run plan:check`, and the next packets. ADR-0014 (merge authority, `main` as trunk) landed in PR #3.

## Last green commit

`d797b1a` on `main`, the merge of PR #5. Its push run 39070711182 passed, as did hosted run 39070332528 on its PR head `fedb4e6`, on all 10 jobs. Runs take about 4.5 minutes, against 21.5 minutes for the old serial job.

## Next actions

1. Open the P05.T01x Part B PR; run Tier 2 review (`/code-review`, `/security-review`); merge once the hosted `foundation` check is green.
2. P06.T01a, work commands on the tenant data pattern (ADR-0010), with migrations numbered after 0013. P01.T02b and T02c contracts.
3. M1 hosted staging (P04.T01i), once the owner sign-ins below are done. Self-service stays disabled until an owner-approved revision on a staging profile with allowlisted WorkOS sign-up (ADR-0009 items 10 and 11).

Open plan follow-ups:
- Superseded banners on `docs/references/*`.
- The rest of P03.T04e: a formatting ignore file, unit-test concurrency, a shared PostgreSQL 17 template-database harness and a heavy-fault job.
- The plan's P05.T01x bullet still carries the ADR-0006 Shopify App Pricing sentence; update it when ADR-0006 is superseded by Morrow-website billing.

## Blockers

None for local work. Hosted staging (M1) waits on the owner actions below.

## Pending owner actions

- **Sign-offs:**
  - Plan R1 (Tier 3).
  - P05.T01x Part B deviations: `GET /workspaces` accepts an absent `Origin` (browsers omit it on same-origin GET); the kernel now evaluates `approve` on `governance.connection.connect` (ADR-0009 item 7, ADR-0011 Q5).
  - ADR to supersede ADR-0006 with Morrow-website billing (signup itself creates no billing coupling).
- **GitHub:** decide on GitHub Pro or an organization on GitHub Team, so `main` gets enforced branch protection requiring the `foundation` check (not an approving review) before the first hosted deploy (ADR-0014).
- **Codex:** confirm the previous Codex Morrow task is stopped and no longer writes to the repository or its pull requests.
- **M1 prerequisites (P04.T01i):**
  - Register the domain.
  - Create a dedicated Cloudflare account and share its account ID (an identifier, not a secret).
  - Authenticate the Neon CLI and reset the operator password.
  - Once the domain exists: configure the WorkOS staging callback and rotate the API key.
  - Decide on spending: Cloudflare Workers Paid, the domain, and Neon Launch for staging.
  - Approve each M1 effect individually (deploys, hosted migrations, sign-in tests) or approve standing staging cards. No card may rely on the Morrow OperationLedger before P06.T01c lands.
- **Credential rotation:** rotate the E2B personal key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- **Later:**
  - A Shopify Partner account and a fresh development store, never the live shop.
  - An OpenAI staging project with a budget cap.
- **Optional console clean-up:** E2B template `pdht65h2trfuizuvmotc`, the WorkOS loopback callback `127.0.0.1:4110`, and the WorkOS staging test user.

## Open unknown-outcome provider operations

None. `docs/history/INDEX.md` cites the terminal state of every earlier provider operation at the archive tag.

## Active approval cards

None. Every earlier provider allowance is consumed.
