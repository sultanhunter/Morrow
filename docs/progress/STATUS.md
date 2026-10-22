# Morrow status

Updated 2026-10-22. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014), with branch protection since 2026-10-19 (requires `foundation`, enforce_admins, no review). Merged: PRs #1–#36; `main` is at `0083b4b`. The latest:
- #10–#24: P05.T01x Part B, P06.T01a, the ADR-0018 edit, P01.T04a PR-A/PR-B, P14.T01a PR-1/PR-2 (provisional), P03.T04e PR-A (its AC22 dispatch run and AC04/AC05 hosted totals still open), P03.T04f CI cost reduction, PR #17 docs (ADR-0019–0021, `staging-card-1`, `docs/plan/mvp.md`), P01.T02c PR-A, P04.T01j PR-B (#21; AC14 implemented, AC15 recorded (owner acknowledgement pending), AC16 closed by PR-D part 2), P05.T01y, P06.T01b PR-1; #25 MVP design (ADR-0022, model catalogue v1, briefs M2–M5).
- #26 postgres legs `[core, http, linking, work]`; #27 P05.T01ab = P04.T01i PR-C (sign-in abuse guard); #28 P04.T01i PR-B, trimmed (`bb882ad`; staging tooling, gates 1–6, census, kill/unkill, E11 suspended) and #29 the bounded Neon connect (`1a2e189`).
- #30 M2 PR-1 (`6d744ae`): migrations 0019–0024 (spine executor logins, leases, stops, operations, the vault, the billing route); `ConnectorBroker`/`RuntimeBroker` (trust model v1); 14 broker secret names with `MORROW_VAULT_KEK_V1` (production 12).
- #31 docs (`d12379e`): ADR-0008 item 1 and ADR-0022 items 3, 9, 11 amendments. #32 P04.T01i PR-D part 1 (`0e056e5`): the reviewed staging identifiers and verify-config var allowlists. #33 M2-PR2a (`3744c96`): v1.1 `ResourceRef` kind `store`, `storeResource`, `listingFieldPaths`, the S7 per-table ACL spec.
- #34 P04.T01i M-N3 (`3a48d11`): role passwords as plaintext over TLS, each once in its own `ALTER ROLE`, then a verified wipe of `pg_stat_statements` from `neondb` (only SHA-256 digests sent); the staging CLI's 3000 ms happy-eyeballs connect timeout.
- #36 M2 PR-2 (`2f72ce3`): Shopify install and link: migrations 0025–0027, `ConnectorBroker` Shopify checks (hand-written, ADR-0008 item 1), the vault transport, the connector Worker with per-address rate limits, the census entrypoint allow table, the connections screens.
- #35 P04.T01i PR-D part 2 (`0083b4b`): the staging api and broker placed in `aws:us-east-1` (verify-config holds it exactly), the bring-up records, M-N1+, the ADR-0022 item 3 and 12 amendments and the card's E1 amendment.

In progress:
- **M5 PR-1** (PR #37, `claude/m5-billing`; migrations 0028–0029), merging with Stripe off (owner decision (c)). The reviewed switch in `docs/decisions/stripe-staging.json` is committed `"off"`: the broker keeps its 14 secret names, so gate 6 passes; checkout, the portal and the webhook answer `unavailable`; the billing view reads plan, credits and period and offers no Morrow plans call to action; credits, the wallet, entitlements and the receipt definers work as built. The Stripe-off verify pass found three low issues (that call to action, the turning-off procedure, a wrapped comment), all fixed. Open: hosted `foundation` on the exact head, the Tier 2 AI review (separate context, same model family, security lens), merge.
- **M3 PR-1 next** (`claude/m3-listings-agent`; migrations 0030–0033): re-merge M5 once #37 lands, then a verify pass, PR, CI and merge.
- **Staging test entitlement after M3** (`claude/staging-test-entitlement`; owner decision (b)): an operator grant of the beta plan without Stripe, with the ADR-0022 item 5 and card E13 amendments; its migration renumbers after M3's.

## Staging (live, `staging-card-1`)

- Done 2026-10-20 (`docs/evidence/live/2026-10-20-*`, `2026-10-21-*`): census, queues, Turnstile widget `morrow-staging`, the WorkOS redirect; the Neon `staging` branch; `migrate` 0001–0024; `provision-roles --first` (eleven logins, statistics wiped) and `seed-platform` (digest `229ebbfe…`); the owner's keyring. The first deploy (from `3a48d11`) deployed all four Workers and failed only `SMOKE_DATABASE_PATH` (about 5.0 s, the api at the edge far from Neon); no unknown outcome.
- 2026-10-21: `migrate` 0025–0027 from `2f72ce3` (12:36Z; ledger 27; schema head `c41acf8e…`); M-O1 passed; M-N1+ recorded.
- **2026-10-21, the placement deploy:** `staging:unkill` at 15:30Z (the owner's "set the flag": `STAGING_DEPLOY_ENABLED=1`), then a local `staging:deploy` of `0083b4b`. Every gate ok; broker `86301bfc-…`, orchestrator `17cdb089-…`, connector `f3fe1bf8-…`, api `e60e8761-…`, all deployed; health ready after 1 poll; census clean before and after. **The smoke passed every check**, the database path included. Measured after: `GET /workspaces` 2.25 s cold, then about 0.85 s (0.85 s, 0.88 s; about 5.0 s before placement). No unknown outcome.
- The flag is on, so every green push to `main` deploys through CI. A merge that adds migrations (#37's 0028–0029, M3's 0030–0033) stops its deploy at gate 3, uploading nothing, until `staging:migrate` (E3) applies them; then rerun it. With Stripe off, gate 6 keeps expecting the broker's 14 names.
- Live records committed with this PR: `2026-10-21-neon-staging-migrate-0025-0027.md` and `2026-10-21-cloudflare-deploy-placement.md`.

## Decisions recorded 2026-10-18 to 2026-10-21 (owner, in chat)

- **2026-10-21, Stripe and testing** (exact text in the M5 brief): "set the flag, and lets skip the strip production integration for now …"; then (a) "Our live store": testing on the owner's live store needs an owner-approved ADR and M6's deletion and privacy path first, and until then the development-store rule stands; (b) "Staging test entitlement (Recommended)": an operator command, approved and recorded per use, puts a named staging workspace on the beta plan without Stripe (a separate PR amending ADR-0022 item 5); (c) "Merge with Stripe off (Recommended)": M5 merges with the Stripe switch committed off.
- **2026-10-21, earlier:** "Accept for staging (Recommended)" (the per-isolate ingress bound, M2 brief); "Founder only (Recommended)" and "Allow operator abandon (Recommended)" (ADR-0022 items 3 and 12 amendments); "Approve card change (Recommended)" (card E1).
- **2026-10-20:** the first-deploy preconditions, "app suspended,token deleted and use the fallback" (`2026-10-20-owner-preconditions.md`); Neon passwords "Plaintext over TLS (Recommended)", then "Plaintext, then wipe stats (Recommended)" (P04.T01i M-N3); "Allow actions: read (Recommended)" (AC03); "Allow *.neon.tech (Recommended)" (sandbox allowlist, git-ignored).
- **2026-10-20, MVP build:** "Confirm screen (Recommended)", "Receipt-only path (Recommended)", "Roll over in beta (Recommended)", "Hand-written checks (Recommended)" (ADR-0022 items 3, 9, 11; ADR-0008 item 1).
- **ADR-0022 MVP contracts:** Claude behind a modular model gateway, user-selectable models and effort; "$49 / 300 credits (Recommended)"; one private Shopify app per beta merchant; "One button (Recommended)"; catalogue values "Confirm all (Recommended)". Open: the image provider for P17.T02e (OpenAI Images kept for now).
- **ADR-0021 fast track** (first job "Product listings", "Invite-only beta (Recommended)"); **ADR-0019 and `staging-card-1`** "Approve both (Recommended)"; branch protection "Required before production (Recommended)"; **ADR-0020** "Approve ADR-0020 (Recommended)".
- **GitHub:** "GitHub Pro (Recommended)", the $10 Actions budget, branch protection on; "Suspend Codex + revoke old token (Recommended)". **Cloudflare:** OQ-3 "Use this account"; Wrangler OAuth "Revoke it (Recommended)". **P03.T04f:** "Allow both (Recommended)". **P05.T01ab:** "Keep it (Recommended)". **2026-10-18:** ADR-0015 to ADR-0018; P01.T04a OQ-1 to OQ-3; P03.T04e OQ-1.

## Last green commit

`0083b4b` on `main` (PR #35): push run 39600968875 green (it gated the placement deploy). Earlier: `2f72ce3` (#36) push run 39598265854 (it gated `migrate` 0025–0027); `3a48d11` (#34) push run 39498651638 (it gated `provision-roles` and the first deploy); `d12379e` (#31) push run 39424322640; `6d744ae` (#30) push run 39415246591. A push that merges an unchanged PR head runs only `checks`. **Failed:** the scheduled heavy-faults run 39227357944 on `f8314e8` (2026-10-19); ADR-0021 defers those suites, so a `ci` PR should disable the weekly schedule and keep `workflow_dispatch`.

## Next actions

1. Merge M5 PR-1 (#37) with Stripe off: hosted `foundation` green on the exact head and the Tier 2 AI review passed. Then `staging:migrate` (E3) for 0028–0029 and rerun the stopped deploy, reading its smoke.
2. M3 PR-1: re-merge M5, verify pass, PR, CI, merge; `staging:migrate` for 0030–0033; rerun the deploy.
3. The staging test entitlement PR (decision (b)), then its first use on a named staging workspace under per-action approval with a live record.
4. With the smoke green: the AC11 acceptance run (bogus token, the 429), then the owner's assisted sign-in (D9 step 11; AC12a).
5. Then M4 (approve and apply) and M6 (the deletion and privacy path, and the live-store ADR of decision (a)).
6. Follow-ups: a KEK fingerprint check in `staging:put-secret`; the #30 advisories (a production broker must hold non-api callers; the 18 → 0019 replay case; `identityConstants` via `brokerRequiredSecretsFor("staging")`; the spine T1 preflight refusal); the `ci` PR above.

Open plan follow-ups: work routes in production must be gated on P09.T05 when production mapping is enabled (ADR-0007 item 9; packet hard ordering b); superseded banners on `docs/references/*`; check against the WorkOS docs whether a user's session list can hold expired or ended sessions (`packages/identity/src/workos-session-status.ts` refuses the whole page on such a row; found in the P14.T01a AC30 hold); a forward migration routing the 0006, 0007, 0009 and 0011 definer guards through `executor_role_safe` (informational; 0017–0018 are P06.T01b); a forward migration adding P01.T02c's eight v1.1 capabilities to `morrow_work.review_capabilities` once a consumer needs them; P05.T01y: rebind linking handoffs, reviews and status to the family (P09.T01a/T02a) and the revocation receipt (P05.T01z), and the production custody decision (ADR-0007 item 9) revisits the two R1 widenings accepted for staging; timing fixes if hosted `unit-stress` confirms them (`tests/broker-client.test.mjs` AC30, the 5,000 ms entry-timeout case in `tests/standalone-login-http.test.mjs`).

## Blockers

None for local work. Testing on the owner's live store (decision (a)) needs M6's deletion and privacy path and an owner-approved ADR first. **Unverified premise:** M-N3 decision (1)'s "Neon stores only the hash" is measured for `pg_authid` only. Production custody needs its own ADR before M6.

## Pending owner questions

Answered 2026-10-21: the four above, "set the flag" (which also settles setting the flag ahead of a passing smoke) and (a) to (c). Still open:
1. Acknowledge that items 2–5 of P04.T01j's M-N1+ were recorded after `migrate` (`2026-10-21-neon-mn1plus-catalog.md`; all five match ADR-0020).

## Pending owner actions

- **CI on the Mac (2026-10-22, "for CI lets use our mac"):** done. The owner narrowed Docker Desktop's File sharing; a probe mount was refused. Claude ran `up` with the owner's go-ahead: `morrow-mac-1` is registered and `MORROW_CI_RUNS_ON` is set. On 1 November, run `down`, not `pause`. The owner keeps the third-party GitHub Apps' write access (risk (a) accepted). After any later removal, run `down` then `up` to revoke the runner key (ADR-0014, amendment of 2026-10-22).
- **Now, metadata only:** run `ls ~/.config/morrow/staging/tmp` in your own terminal and tell Claude whether `broker-secrets.json` or `api-secrets.json` is listed (or Claude runs `staging:secrets-status`, E9, which reports a leftover as `transient_present` without printing it). `deploy --first` unlinks both but ignores a failed unlink, and the broker file holds all fourteen broker secrets. D9 step 11(d) removes any leftover.
- **Before the first CI deploy (the merge of #37):** confirm the GitHub `staging` environment secret `CLOUDFLARE_API_TOKEN` is set (D9 step 7(b); the placement deploy ran locally); Claude can read the secret's name (E9).
- Delete the local `cloudflare-ci-token` and `cloudflare-operator-token.old-*` files. The remaining D9 items as listed on 2026-10-20 (the Neon `cool-butterfly-64820147` deletion, the Global API Key change, a new WorkOS key revoking old ones, `tmutil addexclusion ~/.config/morrow`). Optional under E3: one read of Neon's reveal-password endpoint for a SQL-set probe role.
- **For M3:** an Anthropic Console workspace for staging with a monthly spend limit, its workspace-scoped key placed with `morrow_put`. **To turn Stripe on later** (deferred by decision (c); the M5 brief): a Stripe test-mode account, the restricted key, webhook secret and portal configuration.
- **Sign-off:** Plan R1 (Tier 3), which also freezes the P01 contract v1.1 billing layer.
- **Credential rotation:** the E2B key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- **Billing (ADR-0015), later:** each use of the staging test entitlement and the App Review allowance (per action); before live billing, the entity, bank, tax advisor and registrations, then Stripe live; Shopify's written answer on charging custom-distribution installs. A Shopify Partner account and a fresh development store (never the live shop).

## Open unknown-outcome provider operations

None. Both deploys reported every version. The probe branches `br-frosty-mud-b74y427p`, `br-cold-waterfall-b7atcg0z` and `br-frosty-wave-b7g7o2cm` carried expiries (18:45:04Z, 18:53:04Z, 20:10:17Z on 2026-10-20); their deletion is not yet read back.

## Active approval cards

- `staging-card-1` (`docs/decisions/approvals/staging.md`): staging only; approved 2026-10-19, valid until 2026-11-18 or the first production resource; E1 amended 2026-10-21 (the connector hostname). Effects used: E1 (both deploys) and E2, E3 (probes, `migrate` 0001–0027, `provision-roles --first`, `seed-platform`), E4, E5, E6, E9 (census, permission and settings reads), E10 (schema head, digest, `STAGING_DEPLOY_ENABLED=1`), E12 (`unkill`), 2026-10-20 and 2026-10-21. E11 is suspended (ADR-0021). E13 (the test entitlement) is proposed in its own PR.
