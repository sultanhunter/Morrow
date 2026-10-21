# 2026-10-21 Neon: staging migrations 0025–0027 applied (M2 PR-2)

- **Approval.** Staging card `staging-card-1`: effect E3 for `staging:migrate` on the `staging` branch, and effect E10 for `STAGING_SCHEMA_HEAD`.
- **Exact action.** `npm run staging:migrate` from the main checkout, clean at `origin/main` `2f72ce3` (#36), 12:35:43Z to 12:36:21Z. `foundation` was green on that commit (push run 39598265854). The staging CLI sets its own 3000 ms connect-attempt timeout (#34).
- **Result.** Exit 0.
  - Applied: 25, 26 and 27. Nothing needed reconciling, and there were no prerequisite files.
  - Ledger rows: 27.
  - Schema head: `c41acf8e88747ed18de43ba036a7984b410c5a74e68b499283979300c41ab469`.
  - Source commit: `2f72ce3de4e1e6bdb4f79d41571400cec403d3e5`.
- **Immutability.** Migrations 0025–0027 are now applied to the persistent staging database and are immutable.
- **Cap and observed cost.** Neon Free: $0.
- **Cleanup.** None.
- **Unknown outcomes.** None.
