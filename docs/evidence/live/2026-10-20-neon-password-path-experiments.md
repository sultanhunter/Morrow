# 2026-10-20 Neon: the role-password path measured (statement statistics, server logging, the wipe, the API)

- **Approval.** Staging card `staging-card-1`: E3 (throwaway probe branches with an expiry, catalog reads; project `morrow-staging` only, never the root or the `staging` branch) and E9 (read-only database catalog reads). The card was approved 2026-10-19 and is valid until 2026-11-18.
- **Why.** Owner decision (1) on M-N3, "Plaintext over TLS (Recommended)", made `provision-roles` refuse whenever `pg_stat_statements` could record a password statement. Before any role was touched, the staging settings and the alternatives were measured.
- **Read-only reads of the staging `morrow` database** (as `neondb_owner`):
  - The server is PostgreSQL 17.11. `password_encryption` is `scram-sha-256`.
  - `shared_preload_libraries` includes `pg_stat_statements`, with `pg_stat_statements.track = top` and `pg_stat_statements.track_utility = on`. The extension is not created in `morrow`. So the module records utility statements, literals included, and decision (1)'s rule would refuse.
  - Server statement logging is off: `log_statement = none`, `log_min_duration_statement = -1`, `log_min_duration_sample = -1`, `log_statement_sample_rate = 1`, `log_min_error_statement = panic`, `log_duration = off`. Each has context `superuser` and source `default`.
  - `neondb_owner` cannot change them: a transaction-local `SET LOCAL log_statement` was refused with SQLSTATE 42501. Nothing changed.
- **Throwaway probe branch** `morrow-probe-1689b575` (`br-frosty-wave-b7g7o2cm`), a child of the root with `expires_at` 20:10:17Z:
  1. `neondb_owner` can `CREATE EXTENSION pg_stat_statements` in the scratch database `neondb` and can call `pg_stat_statements_reset()`, both full and targeted.
  2. A plaintext `ALTER ROLE r PASSWORD '<p>'` run in the branch's `morrow` database **is** recorded: the plaintext is visible in `pg_stat_statements` as read from `neondb`.
  3. A reset run from `neondb` left 0 entries containing the password. The `morrow` database never gained the extension.
  4. The role then logged in with that plaintext.
  5. Neon refuses a pre-hashed verifier: "Neon only supports being given plaintext passwords", SQLSTATE `XX000` (as in `docs/evidence/live/2026-10-20-neon-probe-rerun.md`).
  6. Neon's API `reset_password` for a role created through SQL, both NOLOGIN and LOGIN, answered HTTP 422 `ROLE_PASSWORD_NOT_AVAILABLE`. The API therefore cannot set passwords for the migration-created roles. Each 422 was a refusal with no effect.
- **Not measured.** What Neon's control plane keeps of a plaintext set through SQL. Only `pg_authid`'s stored form (SCRAM-SHA-256) is measured, here and in the rerun record.
- **No secret recorded.** Every password used was generated for the probe, used on the throwaway branch only, and is in no file, log, chat or record. The probe's roles were created on the branch; they go with it when it expires.
- **Decision that followed.** The owner chose "Plaintext, then wipe stats (Recommended)" (P04.T01i M-N3, owner decision (2), which amends decision (1)). The tool, the probe and `lab:staging-runner` implement it on branch `claude/p04-t01i-neon-plaintext-passwords`.
- **Cap and observed cost.** Neon Free, no card on file: $0.
- **Cleanup.** The branch carries its expiry, so Neon deletes it automatically at 20:10:17Z, with its roles and the extension created in its `neondb`. Nothing touched the root or the `staging` branch, and the staging reads changed nothing. A read-only branch list after 20:10:17Z will confirm the deletion; it had not run when this record was written.
- **Open unknown outcomes.** None. The branch was created with the expiry above, and every API call returned a definite answer.
