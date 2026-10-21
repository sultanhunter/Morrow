# 2026-10-21 Neon: M-N1+ items recorded from the staging catalog (read-only)

- **Approval.** Staging card `staging-card-1`, effect E9 (catalog reads). Read on 2026-10-21, during the morning session (UTC); the exact time was not captured. Read-only: catalog queries only, as `neondb_owner` on the `staging` branch's `morrow` database through the pinned direct endpoint. No data was read and no password was printed.
- **Deviation.** P04.T01j's M-N1+ says these five items are recorded on a throwaway child branch *before* `migrate`. `migrate` ran on 2026-10-20 at 16:56Z with items 2–5 unrecorded (item 1 was measured by the 16:53Z probe). They are recorded here afterwards, from the persistent staging branch that `migrate` produced. Item 4 is shown by the migrations' own D4 transactions rather than by a separate throwaway pair. Owner acknowledgement requested on 2026-10-21.
- **Results (2026-10-21, using the labs' `morrowMembershipCensusSql` and `morrowSetRowsSql` from `scripts/fixtures/createrole-administrator.mjs`).**
  1. Every role `neondb_owner` created through SQL has exactly one row: 18 rows with admin true, inherit false and set false. Their grantor is `cloud_admin`, which is oid 10 (the bootstrap superuser) on Neon. The 16:53Z probe measured the same shape on a fresh role.
  2. `createrole_self_grant` is empty (the default).
  3. No row has `roleid = neondb_owner` (0 rows), and no role other than `neondb_owner` and Morrow roles is a member of any Morrow role. The only Morrow-to-Morrow rows are the two designed pairs, `morrow_api_worker → morrow_work_api` and `morrow_work_owner → morrow_work_command` (set true, granted by `neondb_owner`). The SET-row census excludes them. In the other direction, no Morrow role is a member of any role other than a Morrow role. The census covers both directions and returned exactly 20 rows: the 18 self-grants and these 2 pairs.
  4. Zero Morrow SET rows remain after `migrate`'s D4 transactions and `provision-roles --first`.
  5. `neondb_owner` (oid 16391):
     - Attributes: not superuser; inherit, createrole, createdb, login, replication and bypassrls set (Neon's defaults for the project owner); connection limit −1.
     - Memberships: `neon_superuser` (inherit and set, granted by `cloud_admin`), plus the 18 admin-only self-grant rows of item 1.
- **Assessment.** Every item matches ADR-0020's expectations, so OQ-2 is not raised. Note that `neondb_owner` has BYPASSRLS. It is the administrator used only by the staging tools; no runtime login is or inherits from it.
- **Cap and observed cost.** Neon Free: $0.
- **Cleanup.** None (read-only).
- **Unknown outcomes.** None.
