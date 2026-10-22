# Morrow status

Updated 2026-10-21. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014), with branch protection since 2026-10-19 (requires `foundation`, enforce_admins, no review). Merged: PRs #1–#34 and #36; `main` is at `2f72ce3`. The latest:
- #10–#24: P05.T01x Part B, P06.T01a, the ADR-0018 edit, P01.T04a PR-A/PR-B, P14.T01a PR-1/PR-2 (provisional), P03.T04e PR-A (its AC22 dispatch run and AC04/AC05 hosted totals still open), P03.T04f CI cost reduction, PR #17 docs (ADR-0019–0021, `staging-card-1`, `docs/plan/mvp.md`), P01.T02c PR-A, P04.T01j PR-B (#21; AC14 implemented, AC15 recorded (owner acknowledgement pending), AC16 closed by PR-D part 2), P05.T01y, P06.T01b PR-1; #25 MVP design (ADR-0022, model catalogue v1, briefs M2–M5).
- #26 postgres legs `[core, http, linking, work]`; #27 P05.T01ab = P04.T01i PR-C (sign-in abuse guard); #28 P04.T01i PR-B, trimmed (`bb882ad`; staging tooling, gates 1–6, census, kill/unkill, E11 suspended) and #29 the bounded Neon connect (`1a2e189`).
- #30 M2 PR-1 (`6d744ae`): migrations 0019–0024 (spine executor logins, leases, stops, operations, the vault, the billing route); `ConnectorBroker`/`RuntimeBroker` (trust model v1); 14 broker secret names with `MORROW_VAULT_KEK_V1` (production 12).
- #31 docs (`d12379e`): ADR-0008 item 1 and ADR-0022 items 3, 9, 11 amendments. #32 P04.T01i PR-D part 1 (`0e056e5`): the reviewed staging identifiers and verify-config var allowlists. #33 M2-PR2a (`3744c96`): v1.1 `ResourceRef` kind `store`, `storeResource`, `listingFieldPaths`, the S7 per-table ACL spec.
- #34 P04.T01i M-N3 (`3a48d11`): role passwords as plaintext over TLS, each once in its own `ALTER ROLE`, then a verified wipe of `pg_stat_statements` from `neondb` (only SHA-256 digests sent); the staging CLI's 3000 ms happy-eyeballs connect timeout.
- #36 M2 PR-2 (`2f72ce3`): Shopify install and link: migrations 0025–0027, `ConnectorBroker` Shopify checks (hand-written, ADR-0008 item 1), the vault transport, the connector Worker with per-address rate limits, the census entrypoint allow table, the connections screens.

In progress:
- **P04.T01i PR-D part 2** (PR #35, `claude/p04-t01i-d2-placement-evidence`, from `3a48d11`; hosted CI green). The staging api and broker get `placement` `{mode: "targeted", region: "aws:us-east-1"}`, the Cloudflare form of `staging.json`'s `neon.region_id`; verify-config holds it exactly (`EDGE_PLACEMENT_STAGING`, `_REGION`, `_ENVIRONMENT`, `_WORKER`). The live records (migrate, provision-roles and seed, owner preconditions, the first deploy), the card's effects used, the rebaseline `closedBy` (P04.T01j-AC16), the P04 and P05 rows, and this file. The AI review (separate context, same model family; 2026-10-21) found six issues, all applied (packet notes). Open: merge.
- **MVP build wave:** M2-PR2 merged as #36 (`2f72ce3`); M5-PR1 (`claude/m5-billing`, rebasing onto it: stubs out, migrations 0028–0029) and M3-PR1 (`claude/m3-listings-agent`, then 0030–0033) follow, each with a verify pass, PR, CI and merge. Before the next staging deploy after #36: `staging:migrate` applies 0025–0027 (E3), or gate 3 stops the deploy.

## Staging (live, `staging-card-1`)

- Done 2026-10-20 (`docs/evidence/live/2026-10-20-*`, `2026-10-21-*`): census, queues, Turnstile widget `morrow-staging`, the WorkOS redirect; the Neon `staging` branch; `migrate` 0001–0024 from `3744c96` (schema head `94391bf9…`); `provision-roles --first` (eleven logins, statistics wiped) and `seed-platform` (digest `229ebbfe…`) from `3a48d11`; the owner's keyring.
- **First deploy**, 21:58:21Z–22:00:51Z from `3a48d11`: every gate passed; broker `2c9bafb6-…`, orchestrator `46903488-…`, connector `e4423af1-…`, api `af583bdc-…`, all deployed; health ready after 2 polls; the census clean before and after (only the api on workers.dev and binding the broker). The smoke passed health, the SPA and CSP, routing (M-R1 recorded), the guard (configured, start 403) and the other hostnames, and **failed `SMOKE_DATABASE_PATH`** (503). Outcome `failed`, `STAGING_SMOKE_FAILED`; no unknown outcome.
- **Diagnosis (2026-10-21, read-only):** `GET /workspaces` took about 5.0 s (one 503, one 401) against about 50 ms for `/healthz`, served from DEL. Attributed, unconfirmed until a placed deploy passes the smoke: the api runs at the edge nearest the owner and its sequential round trips to Neon in us-east-1 (about 250 ms each) run into the 5 s budget. The api's `BROKER` binding reports `entrypoint` `ApiBroker`; no Worker had placement. Remedy: PR-D part 2.
- `STAGING_DEPLOY_ENABLED` is still 0 (`--first` requires and keeps 0), so continuous deploy is off; the digest variable is published.

## Decisions recorded 2026-10-18 to 2026-10-20 (owner, in chat)

- **2026-10-20:** the first-deploy preconditions, "app suspended,token deleted and use the fallback" (`2026-10-20-owner-preconditions.md`); Neon passwords "Plaintext over TLS (Recommended)", then "Plaintext, then wipe stats (Recommended)" (P04.T01i M-N3); "Allow actions: read (Recommended)" (AC03); "Allow *.neon.tech (Recommended)" (sandbox allowlist, git-ignored).
- **2026-10-20, MVP build:** "Confirm screen (Recommended)", "Receipt-only path (Recommended)", "Roll over in beta (Recommended)", "Hand-written checks (Recommended)" (ADR-0022 items 3, 9, 11; ADR-0008 item 1).
- **ADR-0022 MVP contracts:** Claude behind a modular model gateway, user-selectable models and effort; "$49 / 300 credits (Recommended)"; one private Shopify app per beta merchant; "One button (Recommended)"; catalogue values "Confirm all (Recommended)". Open: the image provider for P17.T02e (OpenAI Images kept for now).
- **ADR-0021 fast track** (first job "Product listings", "Invite-only beta (Recommended)"); **ADR-0019 and `staging-card-1`** "Approve both (Recommended)"; branch protection "Required before production (Recommended)"; **ADR-0020** "Approve ADR-0020 (Recommended)".
- **GitHub:** "GitHub Pro (Recommended)", the $10 Actions budget, branch protection on; "Suspend Codex + revoke old token (Recommended)". **Cloudflare:** OQ-3 "Use this account"; Wrangler OAuth "Revoke it (Recommended)". **P03.T04f:** "Allow both (Recommended)". **P05.T01ab:** "Keep it (Recommended)" (the `morrow_challenge` failed line).
- **2026-10-18:** ADR-0015 to ADR-0018; P01.T04a OQ-1 to OQ-3; P03.T04e OQ-1.

## Last green commit

`3a48d11` on `main` (PR #34): push run 39498651638 green (it gated `provision-roles` and the first deploy). Earlier: `0e056e5` (#32) PR run 39451664824 on `1120701`; `d12379e` (#31) push run 39424322640; `6d744ae` (#30) push run 39415246591; `bb882ad` (#28) push run 39358246728. A push that merges an unchanged PR head runs only `checks`. **Failed:** the scheduled heavy-faults run 39227357944 on `f8314e8` (2026-10-19); ADR-0021 defers those suites, so a `ci` PR should disable the weekly schedule and keep `workflow_dispatch`.

## Next actions

1. Merge PR-D part 2 (hosted CI). M-O1 (AC13) passed on 2026-10-21 (`2026-10-21-cloudflare-m-o1-log-probe.md`).
2. Then, with the CI token secret confirmed and the owner's acknowledgement (question 2), set `STAGING_DEPLOY_ENABLED=1` (E10) so the next green `main` push deploys the placement through CI, and read the smoke. If `SMOKE_DATABASE_PATH` persists, query Workers Logs (E9) for the api's and broker's events. With the smoke green: the AC11 acceptance run (bogus token, the 429), then the owner's assisted sign-in (D9 step 11; AC12a).
3. The merge train M2-PR2 → M5-PR1 → M3-PR1, each with a verify pass, a PR, CI and a merge (M2's census allow table relies on the `entrypoint` field, now confirmed). Then M4 (approve and apply) and M6 (the deletion path before the real-store smoke).
4. Follow-ups: a KEK fingerprint check in `staging:put-secret`; the #30 advisories (a production broker must hold non-api callers; the 18 → 0019 replay case; `identityConstants` via `brokerRequiredSecretsFor("staging")`; the spine T1 preflight refusal); the `ci` PR above.

Open plan follow-ups: work routes in production must be gated on P09.T05 when production mapping is enabled (ADR-0007 item 9; packet hard ordering b); superseded banners on `docs/references/*`; check against the WorkOS docs whether a user's session list can hold expired or ended sessions (`packages/identity/src/workos-session-status.ts` refuses the whole page on such a row; found in the P14.T01a AC30 hold); a forward migration routing the 0006, 0007, 0009 and 0011 definer guards through `executor_role_safe` (informational; 0017–0018 are P06.T01b); a forward migration adding P01.T02c's eight v1.1 capabilities to `morrow_work.review_capabilities` once a consumer needs them (0018 predates them; none is reviewable); P05.T01y: rebind linking handoffs, reviews and status to the family (P09.T01a/T02a) and the revocation receipt (P05.T01z), and the production custody decision (ADR-0007 item 9) revisits the two R1 widenings accepted for staging; timing fixes if hosted `unit-stress` confirms them (`tests/broker-client.test.mjs` AC30, the 5,000 ms entry-timeout case in `tests/standalone-login-http.test.mjs`).

## Blockers

None for local work. Sign-in on staging waits for a passing database-path smoke. **Unverified premise:** M-N3 decision (1)'s "Neon stores only the hash" is measured for `pg_authid` only. Production custody needs its own ADR before M6.

## Pending owner questions

Answered 2026-10-21: (1) "Accept for staging (Recommended)": the per-isolate ingress bound, recorded in the M2 brief; (2) "Founder only (Recommended)" and (3) "Allow operator abandon (Recommended)": the ADR-0022 item 3 and 12 amendments; (4) "Approve card change (Recommended)": the card's E1 amendment. Still open:
1. Acknowledge that items 2–5 of P04.T01j's M-N1+ were recorded after `migrate` (`2026-10-21-neon-mn1plus-catalog.md`; all five match ADR-0020).
2. Acknowledge setting `STAGING_DEPLOY_ENABLED=1` before a passing smoke (D9 step 10 order). E10 allows the write; M-O1 runs first; the kill switch is the stop.

## Pending owner actions

- **CI (2026-10-22):** the owner made the repository public ("i am going to make the repo public now"), so `ci.yml` runs free on GitHub-hosted runners. The Mac runner was taken `down` first (registration deleted, stack and volumes removed), and `up` now refuses a public repository. Owner, optional: Settings → Actions → General → require approval for all outside collaborators (today: first-time contributors only).
- **Now, metadata only:** run `ls ~/.config/morrow/staging/tmp` in your own terminal and tell Claude whether `broker-secrets.json` or `api-secrets.json` is listed (or Claude runs `staging:secrets-status`, E9, which reports a leftover as `transient_present` without printing it). `deploy --first` unlinks both but ignores a failed unlink, and the broker file holds all fourteen broker secrets. D9 step 11(d) removes any leftover.
- **Before the CI deploy:** confirm the GitHub `staging` environment secret `CLOUDFLARE_API_TOKEN` is set (D9 step 7(b); no record yet, `2026-10-19-github-staging-environment.md` has it not set); Claude can read the secret's name (E9).
- Delete the local `cloudflare-ci-token` and `cloudflare-operator-token.old-*` files. The remaining D9 items as listed on 2026-10-20 (the Neon `cool-butterfly-64820147` deletion, the Global API Key change, a new WorkOS key revoking old ones, `tmutil addexclusion ~/.config/morrow`). Optional under E3: one read of Neon's reveal-password endpoint for a SQL-set probe role.
- **For M3:** an Anthropic Console workspace for staging with a monthly spend limit, its workspace-scoped key placed with `morrow_put`. **For M5:** a Stripe test-mode account.
- **Sign-off:** Plan R1 (Tier 3), which also freezes the P01 contract v1.1 billing layer.
- **Credential rotation:** the E2B key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- **Billing (ADR-0015), later:** the staging test entitlement seed and the App Review allowance (per action); before live billing, the entity, bank, tax advisor and registrations, then Stripe live; Shopify's written answer on charging custom-distribution installs. A Shopify Partner account and a fresh development store (never the live shop).
- Done 2026-10-20: the Codex app suspended, the token deleted, the D6 fallback chosen, the vault KEK file, the keyring. The owner replied "done" to the message that also listed the two beyond-scope 2026-10-20 actions, with no separate wording (`2026-10-20-owner-preconditions.md`).

## Open unknown-outcome provider operations

None. The first deploy reported every version. The probe branches `br-frosty-mud-b74y427p`, `br-cold-waterfall-b7atcg0z` and `br-frosty-wave-b7g7o2cm` carried expiries (18:45:04Z, 18:53:04Z, 20:10:17Z on 2026-10-20); their deletion is not yet read back.

## Active approval cards

- `staging-card-1` (`docs/decisions/approvals/staging.md`): staging only; approved 2026-10-19, valid until 2026-11-18 or the first production resource. Effects used: E1 and E2 (the first deploy), E3 (probes, `migrate`, `provision-roles --first`, `seed-platform`), E4, E5, E6, E9 (census, permission and settings reads), E10 (schema head, digest), all 2026-10-20 and 2026-10-21 (`docs/evidence/live/2026-10-20-*`, `2026-10-21-*`). E11 is suspended (ADR-0021).
