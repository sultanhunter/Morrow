# Morrow status

Updated 2026-10-17. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packet

P03.T04c repository overhaul and P03.T04d governance documents, on branch `claude/p03-t04c-overhaul` (base `f89ad75`). Both are complete locally and await the pull request into `codex/morrow-foundation` and the first run of the parallel CI workflow. Record: `docs/packets/P03.T04c.md` and plan Package 03.

- P03.T04c: outputs go to `.artifacts/` and CI artifacts (ADR-0012); plan, sequence and hash coupling removed; AWS CDK, Daytona and the frozen regressions retired (ADR-0013); `docs/evidence` and `docs/history` pruned to the archive tag (`docs/history/INDEX.md`); parallel CI jobs, the job split planned as P03.T04e (`docs/development/ci.md`).
- P03.T04d: `CLAUDE.md`, the `AGENTS.md` pointer, ADR-0001 to ADR-0013, plan R1 with contract v1.1 split into P01.T02a-T02c and the first package 6 slices (P06.T01a-T01c, P06.T02a), `npm run plan:check` inside `npm run verify`, and the packets P01.T02a, P03.T04c, P04.T02a, P05.T01w (deferral stub), P05.T01x and P06.T01a. P05.T01v is closed.
- Task status: P01.T01-T04, P02.T01 and P03.T01-T04 were recorded Verified on self-review alone and are now `Self-reviewed` in `docs/progress/tasks.json`. `verify:foundation` rejects unknown status values and checks that the plan's defined task and acceptance IDs equal `tasks.json` in order.

## Last green commit

`f89ad75` (Record native workspace API verification), hosted CI run 38979693185. The branch commits after it have not run in hosted CI yet. At the P03.T04d commit, `npm run ci`, `npm run smoke:scaffold` and `npm run plan:check` pass locally.

## Next actions

1. Push `claude/p03-t04c-overhaul` and open its pull request into `codex/morrow-foundation`.
2. Confirm the first parallel CI run: every job, both unit shards, the `pg-core`, `pg-linking` and `pg-http` groups, the Linux-only `pgwire` job and the `foundation` aggregator. Check that there is one artifact per job or shard, and record the wall time.
3. Then P04.T02a (deployable composition root; `docs/packets/P04.T02a.md`, ADR-0007) and P05.T01x (Part A migration 0012, then Part B signup under ADR-0009; `docs/packets/P05.T01x.md`), per their packets. P06.T01a (ADR-0010) may run in parallel.
4. P01.T02a PR-A, executors and kill switches (ADR-0005); PR-B, review policy and exact proposals (ADR-0011), follows.

Open plan follow-ups: superseded banners on `docs/references/*`, which still link to the frozen Page; the rest of the P03.T04e scope (formatting ignore file, unit-test concurrency, shared PostgreSQL 17 template-database harness, heavy-fault job).

## Blockers

None for local work. Hosted staging (M1, P04.T01i) waits on the owner actions below.

## Pending owner actions

- Sign-ins for M1:
  - register the domain and create a dedicated Cloudflare account, then share its account ID (an identifier, not a secret);
  - Neon CLI authentication and an operator password reset;
  - WorkOS staging callback configuration and API key rotation, once the domain exists.
- Upgrade to GitHub Pro before the first deployment, so branch protection is enforced on the private repository.
- Rotate the E2B personal key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- Approve or reject ADR-0008 (Shopify connector runtime, Proposed).
- Later: a Shopify Partner account and a development store (never the live shop); an OpenAI staging project.
- Optional console clean-up: E2B template `pdht65h2trfuizuvmotc` (build `4324bde3`, ready and retained), the WorkOS loopback callback `127.0.0.1:4110` and the WorkOS staging test user.

## Open unknown-outcome provider operations

None. `docs/history/INDEX.md` cites the terminal state of every earlier provider operation (Daytona; E2B 65, 66 and 67; WorkOS 71, 74, 75, 80 and 82) at the archive tag. The console clean-up items above have known outcomes.

## Active approval cards

None. Every earlier provider allowance (E2B 65/66/67, WorkOS 71/74/75/80/82) is consumed, and no standing staging approval card exists.
