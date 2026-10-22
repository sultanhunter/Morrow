# 2026-10-23 Neon: staging migrations 0028–0029 applied (M5 billing)

- **Approval.** Staging card `staging-card-1`: effect E3 for `staging:migrate` on the `staging` branch after a green `foundation` on the `main` tip, effect E10 for `STAGING_SCHEMA_HEAD`, and effect E1 for the continuous deploy. The merge itself was under ADR-0014: PR #37, merged by Claude on its exact green head `5401325`.
- **Exact action.** `npm run staging:migrate` from the local `main` checkout at `7484df2` (#37's merge commit), right after `main`'s `foundation` push run 39840134758 succeeded (2026-10-22 UTC; 2026-10-23 IST).
- **Result.**
  - Applied: 28 and 29. Nothing needed reconciling, and there were no prerequisite files.
  - Ledger rows: 29.
  - Schema head: `9e61f222…53a2`.
  - Source commit: `7484df2…`.
  - Migrations: 0028 `billing-identity-bridge`, 0029 `billing-records`.
- **Immutability.** Migrations 0028–0029 are now applied to the persistent staging database and are immutable.
- **Deploy.** `Deploy staging` run 39841202706 deployed `7484df2` through gates 1–6. Stripe stays switched off, so no Stripe secret is required.
- **Cap and observed cost.** Neon Free: US$0.
- **Cleanup.** None.
- **Unknown outcomes.** None.
