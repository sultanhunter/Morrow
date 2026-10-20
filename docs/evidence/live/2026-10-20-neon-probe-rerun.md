# 2026-10-20 Neon: the probe rerun (M-N1, M-N3, M-N4 measured) and the connect-timeout cause

- **Approval.** Staging card `staging-card-1`, effect E3: throwaway probe branches with an expiry, in project `morrow-staging` only, never the root or the `staging` branch. The card was approved 2026-10-19 and is valid until 2026-11-18.
- **Run 1, the owner's, 16:45Z.** The owner's probe run created branch `morrow-probe-9e0061e2` (`br-frosty-mud-b74y427p`), expiring 18:45:04Z, and then failed to connect: `STAGING_DATABASE_UNAVAILABLE`. It measured nothing.
- **Cause, found the same afternoon.** Node's happy-eyeballs connect (`autoSelectFamily`) gives each address attempt 250 ms by default (`autoSelectFamilyAttemptTimeout`). From the operator's network in India, every connection to Neon's us-east-1 endpoints failed with `ETIMEDOUT` in about 250–800 ms: plain TLS, Node's native WebSocket (which the Neon driver uses), the `ws` package and `https`. With `node --network-family-autoselection-attempt-timeout=3000` (equivalently `net.setDefaultAutoSelectFamilyAttemptTimeout(3000)`), TLS connected in about 575 ms.
  - The same cause explains run 1 and the earlier 02:22Z probe that exited with code 13 (`docs/evidence/live/2026-10-20-neon-probe-branch.md`).
  - **Correction.** That record and `docs/progress/STATUS.md` said this Claude session's network sandbox blocked `*.aws.neon.tech`. It did not. The sandbox was not the cause.
- **Run 2, Claude's, 16:53Z, with the 3000 ms attempt timeout.** `staging:neon-probe` under E3 created branch `morrow-probe-f4a71501` (`br-cold-waterfall-b7atcg0z`), a child of the root with `expires_at` 18:53:04Z, and printed:

  ```json
  {"branch":{"name":"morrow-probe-f4a71501","id":"br-cold-waterfall-b7atcg0z","expiresAt":"2026-10-20T18:53:04Z"},"mN1":{"selfGrantRow":{"admin":true,"inherit":false,"set":false},"grantor":"cloud_admin","grantorSuperuser":true,"revokeRefused":true,"revokeSqlstate":null},"mN3":{"verifierAccepted":false,"sqlstate":"XX000"},"mN4":{"branchIdKept":true,"hostKept":true,"rolesDropped":true,"expirySupported":true},"cleanup":"branch_expires_at"}
  ```

  - **M-N1.** A role that `neondb_owner` creates through SQL has the PG16+ CREATEROLE self-grant row: admin true, inherit false, set false. Its grantor is `cloud_admin`, a superuser. `neondb_owner` cannot revoke it (the row is still there after the `REVOKE`).
  - **M-N3.** Neon refused the SCRAM verifier with SQLSTATE `XX000`.
  - **M-N4.** `neonctl branches reset <child> --parent` kept the branch id and the endpoint host and dropped the child's roles. The pinned neonctl 8.8.0 created the branch with an expiry.
- **Diagnostic, 16:54Z, on the same probe branch.** Claude created a throwaway role and confirmed:
  1. `ALTER ROLE r LOGIN PASSWORD 'SCRAM-SHA-256$4096:…'` fails with SQLSTATE `XX000`. Neon routes role password changes through its control plane, which answered HTTP 400 with the error "Neon only supports being given plaintext passwords".
  2. A random plaintext (32 random bytes, base64url) is accepted: `ALTER ROLE r LOGIN PASSWORD '<plaintext>'` succeeds, and `pg_authid` stores it as SCRAM-SHA-256. `password_encryption` is `scram-sha-256`. The server is PostgreSQL 17.11.
  3. The `pg_stat_statements` extension is not installed in the probe branch's `neondb`. The staging `morrow` database is checked at run time by `provision-roles`; nothing is assumed from this.

  The role was then dropped.
- **Decision that followed.** The owner chose "Plaintext over TLS (Recommended)" (P04.T01i M-N3, as amended 2026-10-20).
- **Cap and observed cost.** Neon Free, no card on file: $0.
- **Cleanup.** Both probe branches carry an expiry, so Neon deletes them automatically: `br-frosty-mud-b74y427p` at 18:45:04Z and `br-cold-waterfall-b7atcg0z` at 18:53:04Z. Nothing touched the root or the `staging` branch. A read-only branch list after 18:53:04Z will confirm the cleanup; it had not run when this record was written (17:14Z).
- **Open unknown outcomes.** None. Both branches were created with the expiry recorded above, and the diagnostic's role was dropped.
