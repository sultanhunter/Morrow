# 2026-10-20 Cloudflare: first staging deploy; four Workers deployed, smoke failed on the database path

- **Approval.** Staging card `staging-card-1`: effect E1 (the deploy), effect E2 (the broker's and the api's secrets, from the owner's files) and effect E10 (the `STAGING_LOGIN_CONFIGURATION_DIGEST` variable). The card's preconditions for the first deploy were met on 2026-10-20 (`2026-10-20-owner-preconditions.md`). D9 steps 8 and 9 came first: `migrate` (`2026-10-20-neon-staging-migrate.md`), `provision-roles --first` and `seed-platform` (`2026-10-20-neon-provision-roles-and-seed.md`), then the owner's `staging:keyring`.
- **Exact action.** `npm run staging:deploy -- --first` from the main checkout, clean at `3a48d1194c64d56cf34c5ec32fdd0cb794fea358` (`origin/main`, #34), 21:58:21Z to 22:00:51Z. `foundation` was green on that commit (push run 39498651638). The report below is the tool's own; it holds status codes, booleans, version ids and fixed codes only.
- **Gates.** All passed, in the tool's order:
  - `main` ok (a clean tree, HEAD equal to `origin/main`, a green `foundation` check on that sha);
  - `flag` `first` (`STAGING_DEPLOY_ENABLED` 0 and the deploy workflow active);
  - `dryRun` ok (gate 5: build, `edge:check`, `edge:dry-run`);
  - `schema` ok (`STAGING_SCHEMA_HEAD` equal to the committed chain's head);
  - `challenge` ok (gate 4: the P05.T01ab challenge configuration);
  - `configuration` `keyring_bound` (the owner's keyring bound to the committed login configuration's digest);
  - `brokerSecrets` `first` (the api did not exist yet; a first deploy brings the secrets in its files);
  - `census` ok (before any upload: no scripts, no Pages projects, dispatch namespaces `unavailable_10121`, one member, no findings);
  - `digest` published (E10, before the first upload);
  - the flag re-read before the broker, orchestrator, connector and api uploads, and after the api upload: `on` each time (in `--first` mode, `on` means the workflow is active).
- **Versions.** Every upload reported its version; none had a previous version.

  | Worker | Version | Outcome | Upload time |
  | --- | --- | --- | --- |
  | `morrow-staging-broker` | `2c9bafb6-e3ec-4a03-bb49-6fb51f61c2d0` | deployed | 9,248 ms |
  | `morrow-staging-orchestrator` | `46903488-0c54-4a3a-b60b-dc4e607e2d0c` | deployed | 15,778 ms |
  | `morrow-staging-connector` | `e4423af1-3b21-408d-8d7c-713500662dd3` | deployed | 10,387 ms |
  | `morrow-staging-api` | `af583bdc-db1f-44d7-9ea1-2fdafe3cced4` | deployed | 23,927 ms |

- **Secrets (E2).** The broker's fourteen secrets came from `tmp/broker-secrets.json` (written by `provision-roles --first`) and the api's keyring from `tmp/api-secrets.json` (the owner's `staging:keyring`), both through `wrangler deploy --secrets-file`. After the broker upload the tool read the broker's secret names and found exactly the fourteen. By the tool's design (`afterFirst`, which runs only once all four uploads are deployed, as here), both files are then unlinked and the rotations recorded. Claude did not open the credential directory.
- **Health.** `/healthz` ready after 2 polls, 5,251 ms.
- **Smoke** (unattended, origin `https://morrow-staging-api.sultanibneusman0.workers.dev`):
  - health: ready;
  - SPA: `/` 200 with the committed CSP;
  - routing (M-R1): `/w/x/inbox` 200 with `Sec-Fetch-Mode: navigate` and 200 without it; `/api/x` the Worker's 404 with a JSON body;
  - guard: `/auth/challenge` configured (Turnstile); a login start without a token 403 (`challenge_required`);
  - **database path: 503. FAILED, `SMOKE_DATABASE_PATH`.** `GET /workspaces` with a well-formed unknown session cookie must return 401;
  - the other Workers' workers.dev hostnames: broker, orchestrator and connector each 404 with a non-JSON body (Cloudflare's, not the Worker's).
- **Outcome.** `failed`, code `STAGING_SMOKE_FAILED`. There is no rollback (E11 suspended): staging rolls forward. The deploy left `STAGING_DEPLOY_ENABLED` at 0 (gate 2 in `--first` mode requires 0, and `deploy` never sets it), so D9 step 10's "then sets `STAGING_DEPLOY_ENABLED=1`" has not run.
- **Census after the deploy.** No findings:
  - scripts: `morrow-staging-api` (workers.dev on, previews off, binds the broker); `morrow-staging-broker`, `morrow-staging-connector` and `morrow-staging-orchestrator` (workers.dev off, previews off, no broker binding);
  - Pages projects: none; dispatch namespaces: `unavailable_10121`; members: 1.
- **Diagnosis of `SMOKE_DATABASE_PATH`** (2026-10-21, Claude, read-only):
  - Repeated `GET /workspaces` with a random, well-formed session took about 5.0 s each: one returned 503 `{"code":"unavailable"}`, one 401 `{"code":"authentication_required"}`.
  - The endpoints that touch no database (`/auth/challenge`, `/healthz`) answered in about 50 ms.
  - The replies were served from Cloudflare's DEL colo (the owner is in India).
  - Conclusion (confirmed only when a placed deploy passes the smoke): the api runs at the edge nearest the caller and makes many sequential round trips to Neon's endpoint in aws us-east-1 (about 250 ms each), so the database path runs into its budget of about 5 s.
  - Script settings (E9, read-only, operator token): the api's `BROKER` service binding is reported with `entrypoint` `ApiBroker` (M2's census allow table relies on that field); no Worker has placement set.
  - Remedy: P04.T01i PR-D part 2 places the staging api and broker in `aws:us-east-1` (packet D1 "Placement"). The next deploy's smoke measures it.
- **Cap and observed cost.** E1 is not capped; the stop is the alert plus the kill switch, with the D6 fallback the owner chose (the $5 billable-usage alert and a weekly usage check). Observed: within the Workers Paid included usage. Cost: $0.
- **Cleanup.** None. The four Workers stay as staging. Until a deploy passes the smoke, database routes are slow and may fail closed with 503; staging holds only synthetic data and the owner's test identity.
- **Unknown outcomes.** None. Every upload reported its version.
