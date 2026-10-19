# Morrow status

Updated 2026-10-20. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014), with branch protection since 2026-10-19 (requires `foundation`, enforce_admins, no review). Merged: PRs #1–#23. The latest:
- PR #10 P05.T01x Part B (`e51e5b7`); PR #12 P06.T01a (`06e4dfe`; Verified waits for the P05 exit gate); PR #13 the ADR-0018 Proposal@2 edit (`08e5ebf`); PR #14 P01.T04a PR-A (`bba3cec`).
- PR #15 P14.T01a PR-1 (`5ad6cc7`, provisional under ADR-0003).
- PR #11 P03.T04e PR-A (`f8314e8`). Still open: its AC22 `workflow_dispatch` run of `heavy-faults.yml` (about 18 billed minutes), and the AC04 hosted totals and hosted part of AC05, which P03.T04f moves to its first hosted `checks` job.
- PR #16 P03.T04f CI cost reduction (`5806049`): light runs for Markdown-only PRs and for pushes whose tree equals the merged PR head; 9 jobs instead of 12; the pgwire hold now records its stage and frames (run 39260319338 held once at `actual_84_callback_delivery_3`, then passed on rerun).
- PR #17 docs, merged as `8b451e8`: ADR-0019, ADR-0020 and ADR-0021 Accepted; `staging-card-1`; P04.T01i and P04.T01j PR-A packets; the ADR-0014 item 4 and 5 amendments; `docs/plan/mvp.md`; the 2026-10-19 live evidence; the Mobbin design references.
- PR #18 P14.T01a PR-2 (`30a6331`): account and work wiring in the provisional UI.
- PR #19 P01.T02c PR-A (`e0adf5d`): collaboration contracts v1.1 (ADR-0016).
- PR #20 P01.T04a PR-B (`8183e16`): the billing route library `@morrow/policy/billing-state` and its decision tables.
- PR #21 P04.T01j PR-B (`05aa479`): 0005–0015 rebaselined once under ADR-0020 (the frozen rebaseline record, `closedBy` null), the D5 preflight in eight adapters and both oracles, the single-transaction runner rule, `lab:createrole-administrator` in `pg-core` and createrole tenant conformance; M-J1 acknowledged. Still open: AC14 (with P04.T01i PR-B), AC15–AC16 (hosted).

- PR #22 P05.T01y (`d9c60b7`): browser session lifecycle; 0016 on the ADR-0020 helpers.
- PR #23 (`262604d`): pgwire lab fixes (the concurrent-callback serial race; the workspace-api final hold now named).
In progress:
- **P06.T01b PR-1** (`claude/p06-t01b-approval-records`, merge train; merged with `main` at `262604d`): migrations 0017 (approval identity bridge) and 0018 (approval records), `@morrow/work/approvals`, `lab:approval-records` in `pg-core` before `lab:createrole-administrator`; two Tier 2 AI reviews addressed. On 2026-10-20 it merged P05.T01y at `70a5a8a` (with `main` `05aa479`); 0017 and 0018 are unchanged (pins `f069cf9c…`, `6ca433ed…`; unapplied anywhere) and `lab:createrole-administrator` applies 0001–0018. Local checks after the merge (2026-10-20): `format:check`, `typecheck`, `verify`, 3,374 unit tests, `lab:approval-records` 296, `lab:createrole-administrator` 118 and `lab:group:pg-work` (11, 122, 83) pass; AC19 now compares 0018 with the catalogue less P01.T02c's eight v1.1 capabilities, none reviewable (packet note 11). Open: PR after P05.T01y merges, one AI review (separate context, same model family) with the security lens, hosted CI, then PR-2 (routes); the AC17 race rounds as a heavy leg are deferred with the other heavy suites (ADR-0021).
- **P05.T01ab = P04.T01i PR-C** (`claude/p05-t01ab-abuse-guard`, merge train after P06.T01b PR-1; merged with `main` at `890099a`): the api sign-in abuse guard before any SQL (per-address limits 10/20/5 per 60 s; Turnstile through the fourth broker method `challengeVerify`; `GET /auth/challenge`; mapper step 10 fails staging and production closed without it), contract v1.1 additions (506 validators, bundle 2,886,931 bytes), the widget on the sign-in screen and now on PR-2's create-organization form (fresh token per POST; `challenge_*` and 429 keep the form's existing errors), and the labs; the route table gains P05.T01y's `rotate`, unguarded. The owner kept the `failed` log line (ADR-0019 item 9 amended). Local checks 2026-10-20 on the merged head: `format:check`, `typecheck`, `verify`, 3,422 unit tests, `build`, `lab:edge-workers`, `lab:group:workers`, `ui:check` (165/166 with installed Chrome; the one is Chrome's own favicon 404) and the local journey lab (13 cases, 88 checks, zero aborts) pass. Open: PR, one AI review with the security lens, hosted CI including `ui` and `pgwire` (`docs/acceptance/P05.md`). It reconciles with PR-B (verify-config, `_headers`, the broker's ten secret names); PR-D adds its two JSON vars.
- Built branches waiting for the merge train (next actions): P05.T01ab (above), then P04.T01i PR-B. `claude/mvp-briefs` holds the M2–M5 briefs and the proposed ADR-0022.

## Decisions recorded 2026-10-18 and 2026-10-19 (owner, in chat)

- **ADR-0021 MVP fast track:** "yes fast track but our foundation architecture should be solid so we can scale the product later without any issues."; first job "Product listings"; first merchants "Invite-only beta (Recommended)"; the record "Approve as written (Recommended)".
- **ADR-0019 and `staging-card-1`:** "Approve both (Recommended)": staging on workers.dev, continuous deploy from `main`, Turnstile and per-IP limits before hosted login (resolves the P05.T01x §11 sign-off). Branch protection timing: "Required before production (Recommended)" (ADR-0014 item 5 amendment).
- **ADR-0020:** "Approve ADR-0020 (Recommended)" (P04.T01i OQ-1 B: P04.T01j rebaselines 0005–0015 once and merges before any other migration). Item 7: "None that I know of".
- **GitHub:** OQ-2 "GitHub Pro (Recommended)"; the owner bought Pro ("I'll finish it myself"); "pro is active you set the action budget" ($10 Actions budget, hard stop); "Turn it on (Recommended)" (branch protection on `main`).
- **Third-party GitHub access:** first "i am not working with codex so it won't push anything so leave it"; then, asked again with the risk stated, "Suspend Codex + revoke old token (Recommended)". The platform GitHub Apps stay for staging as a recorded exception (ADR-0019 item 5, ADR-0014 item 5 amendment).
- **Cloudflare:** P04.T01i OQ-3 "Use this account" (option C, census at every deploy); Wrangler OAuth "Revoke it (Recommended)".
- **P03.T04f OQ-1:** "Allow both (Recommended)" (ADR-0014 item 4 amendment: light runs pass `foundation`).
- **P05.T01ab log line:** "Keep it (Recommended)": ADR-0019 item 9 amended to allow one fixed-code `morrow_challenge {code:"failed"}` line per failed or held verification (capped by the per-IP limiter; about $0.60 per 1M lines).
- **2026-10-18:** ADR-0015 billing routes by origin (supersedes ADR-0006; Stripe selected, no account or calls until an approved packet); ADR-0016 collaboration contracts v1.1 (admins read private Asks through audited reads); ADR-0017 membership authority; ADR-0018 proposals without a task; P01.T04a OQ-1 to OQ-3 (purchase permission with P18.T01a; a test entitlement seed for M4; an App Review allowance); P03.T04e OQ-1 (routine): heavy CI on dispatch plus weekly.

## Last green commit

`5806049` on `main` (PR #16): push run 39264458156 passed. Earlier: `f8314e8` (PR #11) push run 39173050501; `5ad6cc7` (PR #15) push run 39171677853; `bba3cec` (PR #14) push run 39169685269; `08e5ebf` (PR #13) push run 39168226191. A push that merges an unchanged PR head now runs only `checks`; record it with its push run and the PR run on the merged head.

**Failed:** the scheduled heavy-faults run 39227357944 on `f8314e8` (2026-10-19). ADR-0021 defers those suites, so the proposal is to disable the weekly schedule and keep `workflow_dispatch`. That is a `ci` change for its own PR, not PR #17.

## Next actions

MVP fast track (ADR-0021; `docs/plan/mvp.md`). M1, staging live:
1. Merge train: #18 to #23 merged; next P06.T01b PR-1 (this branch; 0017–0018), P05.T01ab, then the trimmed P04.T01i PR-B. Each PR gets one AI review (separate context, same model family), with the security lens where it applies.
2. **The trimmed P04.T01i PR-B:** deploy after green CI, migrations, roles and secrets. It keeps `staging:kill`/`unkill` with the flag re-read around the api deploy, the ADR-0019 item 4 deploy gates 1–6, and the census at every deploy. Card effect E11 (Claude's rollbacks) is suspended until the rollback refusal exists; staging rolls forward instead. AC14's hosted drill, AC15–AC17 and AC19 move past launch (`docs/acceptance/P04.md`).
3. Staging bring-up under `staging-card-1` once its preconditions hold (below); owner sign-in on staging.
4. Then M2, M3 and M5 in parallel, each behind the credential-custody gate; M4 (with the ADR-0005 stop controls, M3/M4); M6 (the deletion path before the real-store smoke).
5. A separate `ci` PR: disable the weekly `heavy-faults.yml` schedule.

Open plan follow-ups: work routes in production must be gated on P09.T05 when production mapping is enabled (ADR-0007 item 9; packet hard ordering b); superseded banners on `docs/references/*`; check against the WorkOS docs whether a user's session list can hold expired or ended sessions (`packages/identity/src/workos-session-status.ts` refuses the whole page on such a row; found in the P14.T01a AC30 hold); a forward migration routing the 0006, 0007, 0009 and 0011 definer guards through `executor_role_safe` (informational; 0017–0018 are P06.T01b); a forward migration adding P01.T02c's eight v1.1 capabilities to `morrow_work.review_capabilities` once a consumer needs them (0018 predates them; none is reviewable); P05.T01y: rebind linking handoffs, reviews and status to the family (P09.T01a/T02a) and the revocation receipt (P05.T01z), and the production custody decision (ADR-0007 item 9) revisits the two R1 widenings accepted for staging; timing fixes if hosted `unit-stress` confirms them (`tests/broker-client.test.mjs` AC30, the 5,000 ms entry-timeout case in `tests/standalone-login-http.test.mjs`).

## Blockers

None for local work. The first staging deploy waits on the trimmed P04.T01i PR-B, P05.T01ab and the preconditions below. **Credential-custody gate:** no Shopify, OpenAI or Stripe credential is bound to the broker until an owner-approved ADR supersedes ADR-0007 items 3–4 (ADR-0022, proposed).

## Pending owner actions

- **Before the first staging deploy (`staging-card-1`, "Preconditions for the first deploy"):**
  - GitHub: suspend the ChatGPT Codex Connector app (GitHub's sudo re-authentication stopped Claude's attempt) and delete the classic token "AppForge Github Actions". The platform apps AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel stay (ADR-0019 item 5 exception).
  - Cloudflare usage alerts at about 10% of each allowance (D9 5(c)), or confirm the D6 fallback: the $5 billable-usage alert (exists) plus your weekly check of Billing → Usage.
  - D9: delete Neon `cool-butterfly-64820147` and create the project key; change the Cloudflare Global API Key and create the two tokens (TTL 2026-11-18); a new WorkOS key, revoking old ones; `gh secret set CLOUDFLARE_API_TOKEN --env staging`; `tmutil addexclusion ~/.config/morrow`.
- **ADR-0022** (proposed on `claude/mvp-briefs`): approve it, or another ADR superseding ADR-0007 items 3–4, before M2, M3 or M5 binds a credential.
- **Sign-off:** Plan R1 (Tier 3), which also freezes the P01 contract v1.1 billing layer (Shopify-route money is USD-only; `AllocationShare@2` is a declared superset of v1).
- **Credential rotation:** the E2B key "Morrow-qualification-2026-10-14" and the Neon and WorkOS credentials the previous agent held. Agents never read the old Codex working directory.
- **Billing (ADR-0015):** a Stripe test-mode account for M5; later, per action, the hosted staging test entitlement seed (OQ-2) and the production App Review allowance (OQ-3); before live billing, the business entity, bank, tax advisor and registrations, then Stripe live activation; before launch, Shopify's written answer on charging custom-distribution installs and on its revenue share.
- **Later:** a Shopify Partner account and a fresh development store (never the live shop); an OpenAI staging project with a budget cap. Optional clean-up: E2B template `pdht65h2trfuizuvmotc`, the WorkOS loopback callback `127.0.0.1:4110`, the WorkOS staging test user.
- **Done 2026-10-19** (per-action approval; `docs/evidence/live/2026-10-19-*`): Pro (owner), the $10 Actions budget, branch protection, the GitHub `staging` environment and variables; Neon `morrow-staging` (`sweet-sound-23947873`); WorkOS sign-up off; Wrangler OAuth revoked and the $5 Cloudflare alert; `~/.config/morrow/staging`.

## Open unknown-outcome provider operations

None. `docs/history/INDEX.md` cites the terminal state of every earlier provider operation at the archive tag.

## Active approval cards

- `staging-card-1` (`docs/decisions/approvals/staging.md`): staging only; approved 2026-10-19, valid until 2026-11-18 or the first production resource. No effect used yet. E11 is suspended (ADR-0021). Earlier provider allowances are consumed.
