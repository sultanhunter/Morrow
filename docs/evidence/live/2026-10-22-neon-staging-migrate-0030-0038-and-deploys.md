# 2026-10-22 Neon and Cloudflare: staging migrations 0030–0038 and deploys (merge train 2–7)

- **Approval.**
  - Staging card `staging-card-1`: effect E3 for `staging:migrate` on the `staging` branch after a green `foundation` on the `main` tip; effect E10 for `STAGING_SCHEMA_HEAD`, which `migrate` publishes; and effect E1 for the continuous deploys from `main` (flag on) and their reruns.
  - Merges under ADR-0014: each PR merged by Claude on its exact green head.
- **Exact actions.** Each migrate ran from the local `main` checkout at the merge commit, right after that commit's `foundation` push run succeeded (2026-10-22 UTC; 2026-10-23 IST).

  | Merge | Migrate output | Deploy |
  | --- | --- | --- |
  | #39 (`87541dc`) | applied 30, 31, 32, 33; ledger 33 | run 39842471693 stopped at gate 3 (`STAGING_SCHEMA_HEAD_MISMATCH`, a race with migrate); rerun deployed; health ready |
  | #40 (`3154139`) | applied 34, 35; ledger 35 | run 39843702129: the same gate-3 race; rerun deployed; health ready |
  | #41 (`94c1dbb`) | no migrations; its `foundation` run was cancelled by the next push | superseded by later deploys |
  | #42 (`0bbdc44`) | no migrations; its `foundation` run was cancelled by the next push | superseded by later deploys |
  | #43 (`f5361f4`) | applied 36, 37; ledger 37 | run 39845109393: gate-3 race; rerun deployed; health ready |
  | #44 (`cbccb3a`) | applied 38; ledger 38; schema head `07f37ce0…b205` | run 39853317390: gate-3 race; rerun deployed; health ready |

- **Stops.** Each gate-3 stop was the documented safe stop: its `next` field says `run_staging_migrate_then_gh_run_rerun`, and the stopped run deployed nothing.
- **Model switch.** The model-provider switch stays committed off (the owner's decision 14 of 2026-10-22). No Anthropic key and no `MORROW_MODEL_PROVIDER` is set.
- **Immutability.** Migrations 0030–0038 are now applied to the persistent staging database and are immutable.
- **Cap and observed cost.** Neon Free, Cloudflare within the Workers Paid plan, GitHub-hosted runners free on a public repository. No bill.
- **Cleanup.** None.
- **Unknown outcomes.** None.
- **Follow-up (routine).** The deploy workflow races `staging:migrate` on every merge that carries migrations. A small fix: gate 3 polls the schema head for a bounded time, about 3 minutes, before it stops.
