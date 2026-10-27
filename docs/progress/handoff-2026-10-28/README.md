# Handoff, 2026-10-28: moving the lead session to the cloud

This branch (`claude/wip-handoff-2026-10-28`, no PR) carries what the Mac-side lead session knew and a cloud session would not: the open review findings, the reserved migration numbers, the merge order, the activity-log lines still owed and the working rules kept in the lead's local notes. It is a transfer vehicle, not a record: once the closing documents PR has put this into `docs/progress/STATUS.md` and `docs/evidence/activity-log.md`, delete nothing yourself; ask the owner whether to delete this branch.

## Live state (2026-10-28, about 00:30 IST)

- `main` at `4986a8c6`: #89, #86, #79 (H5), #88, #90 (H2), #91 (H6) and #94 (OD-2026-10-27-1 and OD-2026-10-27-2) merged. The deploy of `4986a8c6` was being followed when this was written; check run "Deploy staging" for that commit (it reruns once on `STAGING_SCHEMA_HEAD_MISMATCH`). Ledger 56, no migration since 0056.
- Open PRs: #92 (H12a, head `eee9ada8`), #93 (H9a, head `8c6046ce`), #64 (agent loop, head `647d42a2`, old).
- Paused work, pushed without PRs (nothing runs CI until a PR is opened):

| Branch | Head | State |
| --- | --- | --- |
| `claude/wip-h9a-five-lows` | `736069dd` | #93's branch plus a merge of main at `8581d329` (H5, H6) and a WIP commit: the five-lows fix round in progress, not yet checked. Finish, check, then push to `claude/h9a-customer-identifier-screen` (fast-forward) so #93 gets it. |
| `claude/wip-h7a-data-model` | `d3e488ee` | #64's branch plus H7a (ADR-0041 item 4's single data model, migration 0058, H6's lows L1-L3 and N3 fixed in `86f4ee29`); the build was mid-way or near done when stopped. Finish, review (security lens), skeptic-verify, fix, then push to `claude/t4-agent-loop` and retitle #64 "H7a: the agent loop's data model (ADR-0041 item 4), runner switch off". |
| `claude/sd3-sd4-customer-data-deletion-base` | `cdb92411` | SD3 done; SD4 (security packet) in progress, last commit WIP. |
| `claude/sd5-shopify-query-cost-buckets` | `25aa0376` | Built; needs its migration renamed to the reserved number, review, PR. |
| `claude/sd12-schedules-shop-zone` | `1432b35f` | Built (routine part only); same as SD5. |
| `claude/h18-eval-format` | `3db0a745` | Eval format, 87 cases in ten categories; needs review, PR. |

Each wave-6a piece then follows the usual chain: finish, AI review (separate context, same model family; security lens, or the eval-integrity lens for H18), skeptic verify, fix, push, PR, post-push review, fix round, recheck.

## Reserved migration numbers

Migrations 0001-0056 are applied and immutable. Reserved for the open branches: #92 H12a 0057; #64 H7a 0058; SD3 and SD4 0059 and 0060; SD5 0061; SD12 0062. SD5 was built as 0057 and SD12 and SD3/SD4 as 0058/0059: rename to the reserved numbers before their PRs. The lead renumbers at merge if the merge order differs.

## Merge order

- Code group: #93 (H9a), then #92 (H12a: merge main and fix its L1, memory writes must call H9a's customer screen), then #64 (H7a). Each merges main after the previous one, because they share generated contracts.
- Wave 6a in reserved-number order once each is reviewed and green.
- Then the closing documents PR (below).
- A PR merges only when `foundation` is green on its exact head and its Tier 2 AI review passed: `gh pr merge <n> --merge --match-head-commit <sha>`.

## Open review findings (details in `train-lows.json`)

- `pr90_lows`: #90's L1-L3 (plan wording: the member credit ceiling in v1-build-order PR 11; ADR-0039 item 9 vs ADR-0041 item 34 in adr-0039-implementation row 2; H9b, H9c and H19 tracks in mvp.md). Fix in the closing documents PR.
- `pr93_lows`: in progress on `claude/wip-h9a-five-lows`.
- `pr92_lows`: #92's L1 (memory writes do not call H9a's screen). Fix when #92 merges main after #93.
- `pr91_lows_657bf91c`: fixed on the H7a branch (`86f4ee29`).
- `pr94_*`: done (#94 merged).

## Owed: the closing documents PR

- Rewrite `docs/progress/STATUS.md` (at most 80 lines): active work, last green commit and its CI run, next actions, blockers, pending owner actions, open unknown-outcome operations (none), active approval cards.
- Append the lines in `activity-log-pending.md` to `docs/evidence/activity-log.md` (plus the `4986a8c6` deploy once it is read back).
- #90's L1-L3.

## Rules the lead kept in local notes (the owner's decisions; CLAUDE.md still governs)

- Merge authority: the owner lets Claude merge its own PRs, including into main, after green `foundation` and a passed Tier 2 AI review. Never enable auto-merge.
- The owner's direction (2026-10-26, 2026-10-27): the harness and multi-agent foundation is production grade and state of the art, never an MVP; no cost-driven or limit-based shortcuts; ask fewer questions, only where a rule makes the choice the owner's. Morrow is built and used first on the owner's own store; "just build the best harness" (OD-2026-10-27-2). Nothing dropshipping-specific is built unless the owner asks.
- Waiting on the owner: word-for-word confirmation of the CLAUDE.md lines (ADR-0042's four, ADR-0043's three, H2's drafts in `docs/briefs/claude-md-wording-2026-10.md`); ask in one message when convenient.
- Workflows: never `resumeFromRunId` on a parallel workflow (it reran finished ship steps live once); write a continuation script that finishes work in place. Never pass placeholder args. A session limit kills workflow agents; read each run's `journal.jsonl` and continue from the worktrees' state.
- Staging migrations need credentials that exist only on the owner's Mac (`~/.config/morrow/`, never read into context, never moved). `train-after-merge.sh` here shows the Mac-side follow-up: main CI, `npm run staging:migrate`, deploy follow. A cloud session cannot run the migrate step: after a PR with a migration merges (H12a, H7a, SD3/SD4, SD5, SD12), ask the owner to run the migrate on the Mac, or propose an ADR (credential custody and deployment boundary are material) to move the migrate into the deploy workflow with a secret the owner places with `gh secret set`.
- CI already runs on GitHub-hosted runners (`ubuntu-24.04`); the repository variable `MORROW_CI_RUNS_ON` is unset.
