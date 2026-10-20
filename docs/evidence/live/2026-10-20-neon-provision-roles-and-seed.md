# 2026-10-20 Neon: staging logins provisioned and platform configuration seeded

- **Approval.** Staging card `staging-card-1`, effect E3 (`provision-roles`; `seed-platform`, platform configuration rows only). P04.T01i M-N3 as amended by the owner on 2026-10-20 ("Plaintext over TLS (Recommended)", then "Plaintext, then wipe stats (Recommended)"), implemented in #34 (`3a48d11`).
- **Exact actions.** Both ran from the main checkout, clean at `origin/main` `3a48d11`, with `foundation` green on that commit (push run 39498651638).
  - **21:14:03Z, first attempt.** `npm run staging:provision-roles -- --first` stopped at its precondition with `STAGING_FOUNDATION_MISSING` before any database or file effect: main's push run had not finished yet.
  - **21:27:56Z to 21:28:21Z.** `npm run staging:provision-roles -- --first`, exit 0. It covered the eleven logins:
    - `morrow_identity_login`, `morrow_identity_preauth`, `morrow_identity_sessions`;
    - `morrow_api`, `morrow_identity_linking`, `morrow_identity_logout`, `morrow_identity_onboarding`;
    - `morrow_api_worker`, `morrow_connector_ingress`, `morrow_runtime_executor`, `morrow_vault_broker`.

    Result: controls verified; `passwordStorage` SCRAM-SHA-256; `statementStats {recording: true, wiped: true, entriesRemaining: 0}`. The passwords were generated in memory, sent once each over TLS and written only to the owner file `~/.config/morrow/staging/tmp/broker-secrets.json` (mode 600) for the first deploy. Nothing was printed.
  - **21:28:32Z to 21:28:45Z.** `npm run staging:seed-platform` (without `--self-service`), exit 0: `configurationDigest` `229ebbfed0dcde05a64790b06c30f876410dbe41b7dd6daed6c5fdae5ca2b1ba`, profile `workos_staging_profile`, `selfService` unchanged, origin `https://morrow-staging-api.sultanibneusman0.workers.dev`.
- **Cap and observed cost.** Neon Free, no card: $0.
- **Cleanup.** The first deploy consumes `tmp/broker-secrets.json`, which then goes away.
- **Unknown outcomes.** None.
