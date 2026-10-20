# 2026-10-20 Neon: `morrow` database and `staging` branch (owner-run)

- **Approval.** The owner ran their own P04.T01i D9 step 4 commands in their Terminal. `neonctl auth` did not work, so the commands used the project-scoped API key from the owner file through `NEON_API_KEY`, unset afterwards.
- **Exact actions (owner), finished by 12:51:19Z (the branch creation time).**
  - `neonctl databases create --project-id sweet-sound-23947873 --branch production --name morrow --owner-name neondb_owner`.
  - `neonctl branches create --project-id sweet-sound-23947873 --name staging --no-secrets`.
  - `neonctl connection-string staging … --database-name morrow --role-name neondb_owner` into `~/.config/morrow/staging/neon-owner-url`, under umask 077 with noclobber.
- **Read back, by Claude, read-only (Neon API, HTTP 200).**
  - Branch `staging` is `br-dark-recipe-b78ytwj9`, created 12:51:19Z, with parent root `br-noisy-wind-b7cxr2a1` and no expiry.
  - Its read-write endpoint is `ep-hidden-mouse-b7e6ff6l.c-13.us-east-1.aws.neon.tech`, in `aws-us-east-1`.
  - Database `morrow` is owned by `neondb_owner`, on both branches.
  - The owner URL file is mode 600 and non-empty. Claude never read its content.
- **Cap and observed cost.** Neon Free, no card: $0.
- **Cleanup.** None. This is the persistent staging branch (`staging.json` `neon.branch_id`). Reset only by the owner's recovery R1.
- **Unknown outcomes.** None.
