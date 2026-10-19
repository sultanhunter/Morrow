# ADR-0020 Non-superuser migration administrator: one recorded administrator, a closed membership set and a one-time rebaseline of migrations 0005–0015

- Status: Accepted 2026-10-19 (owner approval in chat; see Approval)
- Date: 2026-10-19
- Refines: plan invariant 18 (forward-only migrations), by one bounded exception that closes (item 7). The "no membership row" executor rule of migrations 0005–0015, P06.T01a S5, and P04.T01i D3 (the runner's SET row).
- Affects: P04.T01j, which implements this ADR. P04.T01i (D3 runner, Phase 0 M-N1, PR-B). P06.T01a (S5 and the conformance harness). P05.T01y (its in-flight 0016). P06.T01b (its forward migrations). P04.T04 (restore). The `packages/identity` role preflights.
- Classification: material under ADR-0002. It changes the authority model of the database roles, the tenancy roles, the applied-migration rule and a deployment boundary.

## Context

**Hosted PostgreSQL has no superuser.**
- Neon's default role, `neondb_owner`, is a non-superuser with CREATEROLE. It is a member of `neon_superuser`, which is NOLOGIN with CREATEDB, CREATEROLE, BYPASSRLS and REPLICATION, and is a member of `pg_read_all_data` and `pg_write_all_data`.
- Supabase and RDS also give no superuser (P04.T01i, M-N1).

**PostgreSQL 16 and later write a row the creator cannot remove.** When a non-superuser runs CREATE ROLE, PostgreSQL writes one `pg_auth_members` row:
- the role is the new role, the member is the creator, and the grantor is the bootstrap superuser (oid 10, `BOOTSTRAP_SUPERUSERID`; named `cloud_admin` on Neon);
- the options are admin true, inherit false, set false.

**Local reproduction, 2026-10-19.** It used the pinned PG17 image (17.11), network none, and a Neon-shaped `neondb_owner`. The record is in P04.T01j "Inputs".
- **The administrator cannot remove the row.** A plain `REVOKE` returns WARNING and exit 0 and changes nothing. `GRANTED BY` the bootstrap role fails with 42501 (`check_role_grantor`). Deleting from the catalog is denied. Setting `createrole_self_grant` only adds a second row (admin false, inherit true, set true).
- **`SET ROLE <executeAs>` needs another row.** The administrator needs a second, separate SET row, which it grants itself.
- **The chain stops at 0005.** Applied in runner shape, 0001–0004 pass and 0005 stops with `LINKING_ROLE_PREREQUISITES_INVALID`. With each blocking row removed (a superuser simulation, impossible on Neon), every apply-time check in 0005–0013 trips. 0015 then rejects the runner's own SET row.
- **Every hosted login would be denied.** At run time, `executor_role_safe` (0013) and the 0005–0011 and 0014 `session_user` guards deny every identity executor while its creation row exists.
- **The application side denies too.** This was found while drafting this ADR. Eight `packages/identity` adapters refuse a transaction when their `role_member` preflight sees any row, which raises `INVALID_INTERNAL_ROLE`.

**A forward migration cannot fix this.** On a fresh hosted database the chain stops at 0005, so no 0016 can ever run. The runtime guards defined in 0005–0013 would have to be replaced as well.

**No persistent database has applied 0005–0015.**
- The only persistent Morrow database ever created is Neon `cool-butterfly-64820147`. It holds 1–3, applied by the previous agent (P04.T01i "Today").
- No staging or production database exists; every staging identifier is null.
- CI and every lab use throwaway containers.

**The prototype works.** Candidate bytes for 0005–0015, applied end to end (M-J0, P04.T01j "Inputs"):
- The full chain applied as a non-superuser administrator (with and without BYPASSRLS) and as the local superuser.
- No SET row remained on any Morrow role after any migration.
- All nine identity executors passed their run-time guards, and `link_workspace_store` got past its guard.
- Each of thirteen other membership shapes, including a second administrator, a changed creation row, a different grantor and a leftover SET row, was denied.

## Decision

1. **The administrator.** Exactly one administrator applies the hosted chain: a non-superuser login with CREATEROLE (on Neon, `neondb_owner`). It is never a superuser and never a Morrow role. Local labs may keep the bootstrap superuser.

2. **The recorded administrator.**
   - **What is recorded.** The first rebaselined migration, 0005, records `session_user` (its oid and name) in `morrow_identity.migration_administrator`.
   - **The table.** It is one row (a `singleton` primary key), owned by `morrow_identity_owner`, with no PUBLIC access. It has ENABLE and FORCE row-level security with an owner-only SELECT policy. A statement-level trigger refuses INSERT, UPDATE, DELETE and TRUNCATE with `MIGRATION_ADMINISTRATOR_IMMUTABLE`.
   - **The function.** `morrow_identity.recorded_administrator()` returns the oid only if all of these hold, and otherwise NULL:
     - exactly one row exists;
     - the oid and name still match one live role;
     - that role is not named `morrow_*`;
     - no role is a member of it (nobody else can act as it).
   - **Checks at record time.** The recorded role must be able to log in and must hold CREATEROLE or be a superuser. 0005 fails with `MIGRATION_ADMINISTRATOR_INVALID` otherwise.
   - **Changing it** is material: it needs a new ADR and a forward migration.

3. **The closed membership set.** `morrow_identity.memberships_closed(role)` is true only if every `pg_auth_members` row that names the role is one of these:
   - **(A) The creation row.** The role is this role. The member is the recorded administrator, which is not a superuser. The grantor is oid 10. The options are admin true, inherit false and set false.
   - **(B) The two reviewed work memberships.** These are `morrow_work_api` to `morrow_api_worker` and `morrow_work_command` to `morrow_work_owner`. Each is granted by the recorded administrator, with admin false, inherit false and set true.
   - **(C) The runner's SET row.** The role is `morrow_identity_owner` or `morrow_work_owner`, and that role is `current_user`. The member and the grantor are the recorded administrator, which is `session_user`. The options are admin false, inherit false and set true. This is true only inside that administrator's migration transaction.

   Everything else is denied. That includes:
   - a second administrator;
   - a creation row with inherit or set;
   - any other grantor;
   - the extra row added by `createrole_self_grant`;
   - a SET row on an executor;
   - any membership an executor holds;
   - any row added later.

   A missing role, a missing or mismatched record, or a NULL evaluates to false.

4. **Where it is enforced.** The rule is evaluated live, never cached.
   - **Apply time.** Each "no membership row" conjunct in 0005–0013 is replaced by `memberships_closed(<role>)`. 0005, 0014 and 0015 also require `morrow_memberships_closed()`, which covers every role named `morrow_*`.
   - **Run time.** Every executor guard in 0005–0014 replaces its "no row" conjunct with `executor_memberships_closed(session_user)`. That function also requires the identity owner to be closed. (C) can never hold here, because `session_user` is the executor. Every other conjunct of each guard is unchanged.
   - **At rest.** S5 and the conformance suite assert the exact expected rows and no SET row. The runner verifies the catalog after every entry.
   - **The application preflight.** It checks only the shape: no row with the executor as member, at most one row naming it, and that row is (A) with a non-Morrow, non-superuser member. It cannot read the record, so the database guards stay the authority.

5. **The runner protocol** (amends P04.T01i D3 steps 3–4).
   - **Prerequisites.** They run with `SET createrole_self_grant=''`.
   - **One transaction per manifest entry.** The runner sends: `BEGIN; GRANT <executeAs> TO <administrator> WITH ADMIN FALSE, INHERIT FALSE, SET TRUE; SET LOCAL ROLE <executeAs>;`, then the file without its own `BEGIN;` and `COMMIT;`, then `RESET ROLE; REVOKE <executeAs> FROM <administrator> GRANTED BY <administrator>;`, then the ledger row, then `COMMIT;`.
   - **The SET row never commits.** A crash or lost acknowledgement leaves either both the migration and the revoke, or neither.
   - **Verification.** The runner checks the catalog afterwards. It never trusts the exit status of a REVOKE, which returns 0 on a no-op.

6. **New migrations call the helpers.** Every migration after 0015 uses the helpers. It contains no `pg_auth_members` text of its own and no copy of the old conjunct. A test enforces this.

7. **One-time exception to invariant 18.**
   - **Scope.** Exactly 0005–0015 as of `main` `f8314e8`, and only the changes P04.T01j D3 lists:
     - the 0005 preamble;
     - the 22 replaced conjuncts;
     - the 0014 check and grant;
     - the 0015 block;
     - the comment lines that cite the immutability rule.

     Nothing else may change, including no opportunistic refactor. A test proves the bound: undoing the D3 substitutions reproduces each file's superseded sha256 exactly.
   - **Conditions.**
     - 0001–0004 and all five prerequisite files stay byte-identical.
     - The superseded digests are recorded and may never reappear in the manifest.
     - The owner confirms, when approving, that no database they know of applied 0005 or later.
   - **Mechanics.** `tests/migration-history.test.mjs` holds one rebaseline record (`ADR-0020`, sequences 5–15, the superseded digests). It fails unless this ADR is "Accepted" in the index. Adding a second record needs a new owner-approved ADR.
   - **Closure.** The exception closes when any persistent database first applies any of 0005–0015. That is expected to be the first `staging:migrate` under the staging card. P04.T01i PR-D part 2 cites that live record as the rebaseline record's `closedBy`.
   - **After closure.** Invariant 18 applies to the whole chain without exception, and any fix is a forward migration. The runner's `MIGRATION_LEDGER_DRIFT` refuses any database whose ledger differs from the manifest.
   - **Before closure.** Corrections to the same files are allowed only within items 1–6, only for a defect that the Neon confirmation or a review finds, and each needs Tier 2 plus `/security-review`.

8. **Coordination.**
   - **P04.T01j merges before any other migration.** This adds the dependency edges P04.T01j → P05.T01y PR (0016) and P04.T01j → P06.T01b PR-1.
   - **The in-flight 0016 adopts the helpers.** That is `claude/p05-t01y-session-lifecycle` `6923e5f`, which has five old conjuncts at its lines 12, 118, 247, 282 and 302.
   - **If another migration merges first,** this exception extends to it by name in P04.T01j, under the same conditions, provided it has never been applied to a persistent database. Otherwise it needs its own ADR.

## Consequences

- **M1 is unblocked.** The chain applies under Neon's administrator, and hosted executor logins pass the same guards as in the labs.
- **The labs still prove the zero-row path.** Local superuser labs record `postgres`, (A) and (C) are disabled for a superuser administrator, and the executors have zero rows there.
- **Rules are tighter in four places:**
  - 0015's old tolerance accepted any non-Morrow (admin true, inherit false, set false) row, from any grantor. That admitted a second administrator; it is replaced by (A).
  - The reviewed work memberships must now come from the recorded administrator.
  - Run-time guards now also require the identity owner to be closed, so a leftover SET row denies logins instead of persisting silently.
  - Nobody may be a member of the administrator.
- **New fail-closed availability risks** (intended). Any of these denies every identity login until an ADR-gated forward migration re-records the administrator: renaming or dropping the administrator, granting it to another role, making it a superuser, or tampering with the record.
- **Restore.** A dump restored into a different cluster gets new role oids and fails closed. Same-cluster restore and Neon branch restore keep oids. P04.T04 must design the re-record step under its own approval.
- **Residual: the administrator is the trust root,** as before. It holds ADMIN on every Morrow role, can set their passwords, and on Neon reads and writes all data through `neon_superuser`. This ADR does not widen that.
- **Residual: Neon's own superuser** can rewrite catalog rows, which Morrow cannot control.
- **Residual: the work path does not read memberships at run time.** The work run-time path (`enter_context`) never has; drift there is caught at apply time, by S5 and by the runner.
- **Cost.** The run-time check costs two small catalog reads per guard call. `morrow_work_owner` gains EXECUTE on three read-only helpers, which it can use only inside the administrator's migration transaction.

## Alternatives considered

- **Steward roles** (P04.T01i OQ-1 A). Measured infeasible. A steward that granted the work memberships cannot be dropped. Dropping one that granted nothing leaves roles that no non-superuser can ever administer again: no SET ROLE for later migrations, no LOGIN, no password rotation.
- **Apply as a superuser.** Unavailable on Neon, Supabase and RDS.
- **Keep the checks** (OQ-1 C). Blocks M1: the chain stops at 0005 and every hosted login is denied.
- **A forward migration instead of a rebaseline.** Impossible, because the chain stops at 0005 on a fresh database before any later file can run.
- **Accept any non-Morrow creation row** (the current 0015 rule). Rejected: it admits a second administrator and any grantor.
- **Bind the record by name only.** Rejected: weaker against drop-and-recreate. Oid plus name fails closed instead.
- **Revoke the runner's SET row after each migration or after the run.** Rejected: it leaves a committed window and a failure mode in which the row persists. The in-transaction form leaves neither.
- **`createrole_self_grant`.** Adds rows only; it never removes the creation row.

## Approval

Owner approval, 2026-10-19, in chat. Asked "Approve ADR-0020: rebaseline migrations 0005–0015 so Neon's non-superuser admin can run them? ..." (abbreviated here), the owner answered "Approve ADR-0020 (Recommended)". This approves items 1–8. It answers P04.T01i OQ-1 with option (B) and P04.T01j OQ-1.

Item 7 confirmation, 2026-10-19, in chat. Asked "ADR-0020 also asks you to confirm one fact: do you know of ANY database (personal, Codex-era, or anywhere else) that ran Morrow's migrations 0005 or later? As far as I know, the old Neon project only ever got migrations 1–3.", the owner answered "None that I know of". The old Neon project `cool-butterfly-64820147` held migrations 1–3 only and is being deleted by the owner.