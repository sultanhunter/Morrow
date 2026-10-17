# Morrow status

Updated 2026-10-17. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packet

P03.T04c repository overhaul and P03.T04d governance documents, on branch `claude/p03-t04c-overhaul` (base `f89ad75`). Pull request #2 into `codex/morrow-foundation` is open (base confirmed). Its first hosted run of the parallel workflow passed at `5825b09`, the P03.T04c commits. `4d7f9ae` (P03.T04d) and the governance review-fix commit after it are local and have not run in hosted CI. Record: `docs/packets/P03.T04c.md` and plan Package 03.

- P03.T04c: outputs go to `.artifacts/` and CI artifacts (ADR-0012); plan, sequence and hash coupling removed; AWS CDK, Daytona and the frozen regressions retired (ADR-0013); `docs/evidence` and `docs/history` pruned to the archive tag (`docs/history/INDEX.md`); parallel CI jobs, the job split planned as P03.T04e (`docs/development/ci.md`).
- P03.T04d: `CLAUDE.md`, the `AGENTS.md` pointer, ADR-0001 to ADR-0013, plan R1 with contract v1.1 split into P01.T02a-T02c and the first package 6 slices (P06.T01a-T01c, P06.T02a), `npm run plan:check` inside `npm run verify`, and the packets P01.T02a, P03.T04c, P04.T02a, P05.T01w (deferral stub), P05.T01x and P06.T01a. P05.T01v is closed.
- Governance review fixes: the dependency table's qualification inputs and boundaries are restored to the final pre-R1 plan (ADR-0003 item 7); the OperationLedger stays at M4 (P06.T01c), and until it lands staging provider effects use per-action approvals or cards whose caps do not rely on it, with manual reconciliation from live-provider records; `plan:check` defines lettered IDs only by the bold text that opens a list entry, keeps a range's end ID and lints `CLAUDE.md` read-only.
- Task status: P01.T01-T04, P02.T01 and P03.T01-T04 were recorded Verified on self-review alone and are now `Self-reviewed` in `docs/progress/tasks.json`; their packets carry a plan R1 status banner. `verify:foundation` rejects unknown status values and checks that the plan's defined task and acceptance IDs equal `tasks.json` in order.

## Last green commit

`5825b09` (Remove committed evidence and history; install governance docs and final ADRs), hosted CI run 39039205040 on PR #2 (`pull_request` event): `static`, both unit shards, `workers-api`, `workers`, `pg-core`, `pg-linking`, `pg-http`, `pgwire` and `foundation` all succeeded; seven artifacts (the unit shards wrote no reports, as designed); 4 min 23 s wall time. Pending hosted CI: `4d7f9ae` and the review-fix commit, which pass `npm run ci`, `npm test`, `npm run plan:check` and `npm run smoke:scaffold` locally.

## Next actions

1. Push `4d7f9ae` and the review-fix commit to PR #2 (`claude/p03-t04c-overhaul`) and confirm their hosted run; then owner review and merge into `codex/morrow-foundation`.
2. Then P04.T02a (deployable composition root; `docs/packets/P04.T02a.md`, ADR-0007) and P05.T01x (Part A migration 0012, then Part B signup under ADR-0009; `docs/packets/P05.T01x.md`), per their packets. P06.T01a (ADR-0010) may run in parallel.
3. P01.T02a PR-A, executors and kill switches (ADR-0005); PR-B, review policy and exact proposals (ADR-0011), follows.

Open plan follow-ups: superseded banners on `docs/references/*`, which still link to the frozen Page; the rest of the P03.T04e scope (formatting ignore file, unit-test concurrency, shared PostgreSQL 17 template-database harness, heavy-fault job); the P05.T01x Part B PR splits the plan's P05.T01x bullet into sub-bullets (2,000-character line limit).

## Blockers

None for local work. Hosted staging (M1, P04.T01i) waits on the owner actions below.

## Pending owner actions

- Sign off plan R1 on PR #2 (Tier 3). It covers the P01.T02a-T02c and P06 splits, the OperationLedger at M4 (P06.T01c) with staging effects before it handled as above, and the dependency table (new engineering-start column; qualification inputs as in the final pre-R1 plan).
- Confirm the ADR-0005 §2 executor-class assignments: governance grant, membership, connection and delegation changes `human_only`; spend, communication and external writes `agent_after_approval`. The quoted approval covers §1 (kill switches) and §3 (self-approval), not §2.
- Approve or reject ADR-0008 (Shopify connector runtime, Proposed).
- Confirm the previous Codex Morrow task is stopped and no longer writes to the repository or the pull request.
- Decide the first squash merge of `codex/morrow-foundation` into `main`, and the review identity (a machine user for Claude or a ruleset bypass) so required review does not deadlock with one GitHub account.
- Decide: GitHub Pro or an organization, for enforced branch protection before release merges or privileged deployment.
- M1 prerequisites (P04.T01i):
  - sign-ins: register the domain and create a dedicated Cloudflare account, then share its account ID (an identifier, not a secret); Neon CLI authentication and an operator password reset; WorkOS staging callback configuration and API key rotation, once the domain exists;
  - spending decisions: Cloudflare Workers Paid, the domain and Neon Launch;
  - staging approval cards (pending decision; no card may name the Morrow ledger before P06.T01c) or per-action approvals for each M1 effect: deploys, hosted migrations and sign-in tests.
- Rotate the E2B personal key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- Later: a Shopify Partner account and a development store (never the live shop); an OpenAI staging project.
- Optional console clean-up: E2B template `pdht65h2trfuizuvmotc` (build `4324bde3`, ready and retained), the WorkOS loopback callback `127.0.0.1:4110` and the WorkOS staging test user.

## Open unknown-outcome provider operations

None. `docs/history/INDEX.md` cites the terminal state of every earlier provider operation (Daytona; E2B 65, 66 and 67; WorkOS 71, 74, 75, 80 and 82) at the archive tag. The console clean-up items above have known outcomes.

## Active approval cards

None. Every earlier provider allowance (E2B 65/66/67, WorkOS 71/74/75/80/82) is consumed, and no standing staging approval card exists.
