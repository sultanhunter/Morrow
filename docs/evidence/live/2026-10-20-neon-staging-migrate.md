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
- **Deviation (added 2026-10-21).** P04.T01j requires M-N1+ items 2–5 to be recorded on Neon before `migrate` (packet "Phase 0 measurements"; P04.T01j-AC15). They were not: only item 1 had been measured (`2026-10-20-neon-probe-rerun.md`), and this run went ahead. What the run itself checked, on the real roles rather than a throwaway pair:
  - Item 3. 0005 refuses to apply unless no role is a member of `neondb_owner` (`recorded_administrator()`, `MIGRATION_ADMINISTRATOR_INVALID`). The guards of 0005, 0014, 0015, 0019, 0020 and 0022–0024 each raise unless `morrow_memberships_closed()` holds: every membership row naming a Morrow role is the CREATE ROLE self-grant (rule (A): grantor oid 10, admin true, inherit false, set false) or one of the two reviewed work memberships. So the self-grant rows on the Morrow roles have grantor oid 10, which item 1 left unrecorded.
  - Item 4. Every entry ran the D4 transaction in createrole mode, and the runner's catalog check found zero Morrow SET rows before the run and after each of the 24 entries (`MIGRATION_SET_ROW_PERSISTED` otherwise).
  - Item 2. Not read. The runner sets `createrole_self_grant = ''` in every session it opens, so the server's value did not shape the roles it created, and the closed-set check above refuses any self-grant row with inherit or set.
  - Item 5, in part. The runner requires `neondb_owner` to be a LOGIN, CREATEROLE non-superuser (`STAGING_ADMINISTRATOR_SHAPE`). Its other attributes (BYPASSRLS, CREATEDB, REPLICATION) and the roles it is a member of were neither checked nor recorded.

  Items 2 and 5 still need read-only catalog reads (E3, E9). The owner is asked to acknowledge the skipped precondition (STATUS, Pending owner questions).
- **Not done yet.** `provision-roles --first` waits for the plaintext-password change (owner decision on M-N3, 2026-10-20). `seed-platform` follows it.
- **Cap and observed cost.** Neon Free, no card: $0.
- **Cleanup.** None. This is the persistent staging schema.
- **Unknown outcomes.** None. The run finished with exit 0, and the schema head was published.
