# 2026-10-20 Neon: staging migrations 0001–0024 applied

- **Approval.** Staging card `staging-card-1`: effect E3 for `staging:migrate` on the `staging` branch, and effect E10 for the `STAGING_SCHEMA_HEAD` GitHub variable. P04.T01j had merged (#21), as the packet's D9 step 8 requires.
- **Exact action.** `npm run staging:migrate` from the main checkout, clean at `origin/main` `3744c96`, 16:56:15Z to 16:59:30Z.
  - It ran with `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000`. Node's default 250 ms happy-eyeballs attempt timeout fails every connection to `us-east-1` from this machine (`2026-10-20-neon-probe-rerun.md`).
  - Target: database `morrow` on branch `br-dark-recipe-b78ytwj9`, through the pinned direct endpoint `ep-hidden-mouse-b7e6ff6l.c-13.us-east-1.aws.neon.tech`, as `neondb_owner` (createrole mode, ADR-0020).
  - The tool withdrew `STAGING_SCHEMA_HEAD` before the first statement and published it again after the whole chain.
- **Result.** Exit 0.
  - Applied: migrations 1–24. Nothing needed reconciling.
  - Prerequisites applied: `infra/identity-role-prerequisites.sql`, `identity-login-role-prerequisites.sql`, `identity-logout-role-prerequisites.sql`, `identity-onboarding-role-prerequisites.sql`, `work-role-prerequisites.sql` and `spine-executor-role-prerequisites.sql`.
  - Ledger rows: 24.
  - Schema head: `94391bf9616a0e6eb62b75a1c3fca1958637b52cb160e7a697bf96702bd3e3eb`.
  - Source commit: `3744c96928e8a88c1c8e090f3bc0ab930d8fc708`.
- **Immutability.** Migrations 0001–0024 are now applied to a persistent hosted database. They are immutable; any schema change is a new forward migration. This is the first persistent apply that P04.T01j-AC16 cites.
- **Not done yet.** `provision-roles --first` waits for the plaintext-password change (owner decision on M-N3, 2026-10-20). `seed-platform` follows it.
- **Cap and observed cost.** Neon Free, no card: $0.
- **Cleanup.** None. This is the persistent staging schema.
- **Unknown outcomes.** None. The run finished with exit 0, and the schema head was published.
