# Morrow status

Updated 2026-10-17. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014). The integration branch `codex/morrow-foundation` and the P03.T04c/d overhaul (PR #2) are merged into it. Three packets are in progress, each on its own branch from the overhaul head; their PRs will target `main`:
- **P04.T02a** deployable composition root (`claude/p04-t02a-composition-root`; ADR-0007, `docs/packets/P04.T02a.md`).
- **P05.T01x Part A** forward migration 0012 that removes plan-number identifiers (`claude/p05-t01x-a-protocol-names`; `docs/packets/P05.T01x.md`).
- **P01.T02a PR-A** executor classes and human-only kill switches (`claude/p01-t02a-a-executors`; ADR-0005, `docs/packets/P01.T02a.md`). Committed locally on top of `main` `70acdf7`, not pushed: contract v1.1, catalogue `schema_version` 2, the agent `human_only` guard, `kill_switch_record`, `checkKillSwitchTarget` (every target must fit one grant), AC01-AC10, and the two PostgreSQL labs updated to the v1.1 revoke obligations. Tier 2 AI review findings are addressed. Still to run: `npm run contracts:generate && npm run catalogue:render && npm run ci && npm run smoke:scaffold` (alone, fixed ports) with a clean tree, `lab:group:pg-core` and `lab:group:pg-linking`, `/security-review`, then the PR and hosted `foundation`. Open: the §2 sign-off below gates the merge; the disconnect target naming (packet Q11) must be settled before the v1.1 freeze.

Delivered in P03.T04c/d:
- Outputs go to `.artifacts/` and CI artifacts (ADR-0012).
- Plan, sequence and hash coupling are removed.
- AWS CDK, Daytona and the frozen regressions are retired (ADR-0013).
- `docs/evidence` and `docs/history` are removed from the tree (recover them from the archive tag via `docs/history/INDEX.md`).
- CI runs as parallel jobs (`docs/development/ci.md`).
- `CLAUDE.md`, the `AGENTS.md` pointer, ADR-0001 to ADR-0013, plan R1 with `npm run plan:check`, and the next packets. ADR-0014 (merge authority, `main` as trunk) lands in PR #3.

## Last green commit

`b9fb432` (merge of PR #2 into `codex/morrow-foundation`). PR #1's hosted run 39043798037 succeeded on it across all jobs: `static`, two unit shards, `workers-api`, `workers`, `pg-core`, `pg-linking`, `pg-http`, `pgwire` and `foundation`. `main` is at `f9ab367`, which has the same tree, and its push run 39044164847 also succeeded. PR #2's own runs 39039205040 and 39043168173 on `claude/p03-t04c-overhaul` also succeeded. Each run took about 4.5 minutes, against 21.5 minutes for the old serial job.

## Next actions

1. Finish, review and merge the three active packets (Tier 2 AI review, then green `foundation`).
2. P05.T01x Part B, signup and workspace list (ADR-0009). It needs P01.T02a PR-B (ADR-0011) first.
3. P06.T01a, work commands on the tenant data pattern (ADR-0010). P01.T02b and T02c contracts.
4. M1 hosted staging (P04.T01i), once the owner sign-ins below are done.

Open plan follow-ups:
- Superseded banners on `docs/references/*`.
- The rest of P03.T04e: a formatting ignore file, unit-test concurrency, a shared PostgreSQL 17 template-database harness and a heavy-fault job.
- The P05.T01x Part B PR splits the plan's P05.T01x bullet into sub-bullets, to respect the 2,000-character line limit.

## Blockers

None for local work. Hosted staging (M1) waits on the owner actions below.

## Pending owner actions

- **Sign-offs:**
  - Plan R1 (Tier 3).
  - The ADR-0005 §2 executor-class assignments (P01.T02a packet Q10). The quoted approval covers §1 (kill switches) and §3 (self-approval) only. P01.T02a PR-A is not merged before this; record the confirmation in ADR-0005.
  - Before the Tier 3 P01 contract sign-off freezes v1.1: how a disconnect KillSwitchRecord names its target (v1 `ResourceRef` has no connection kind; packet Q11, proposed by P05.T01z).
  - Approve or reject ADR-0008, the Shopify connector runtime (Proposed).
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
