# Morrow status

Updated 2026-10-19. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packets

`main` is the trunk (ADR-0014), with branch protection since 2026-10-19 (requires `foundation`, enforce_admins, no review). Merged: PRs #1–#17. The latest:
- PR #10 P05.T01x Part B (`e51e5b7`); PR #12 P06.T01a (`06e4dfe`; Verified waits for the P05 exit gate); PR #13 the ADR-0018 Proposal@2 edit (`08e5ebf`); PR #14 P01.T04a PR-A (`bba3cec`).
- PR #15 P14.T01a PR-1 (`5ad6cc7`, provisional under ADR-0003). PR-2 (account and work wiring) follows.
- PR #11 P03.T04e PR-A (`f8314e8`). Still open: its AC22 `workflow_dispatch` run of `heavy-faults.yml` (about 18 billed minutes), and the AC04 hosted totals and hosted part of AC05, which P03.T04f moves to its first hosted `checks` job.
- PR #16 P03.T04f CI cost reduction (`5806049`): light runs for Markdown-only PRs and for pushes whose tree equals the merged PR head; 9 jobs instead of 12; the pgwire hold now records its stage and frames (run 39260319338 held once at `actual_84_callback_delivery_3`, then passed on rerun).

- PR #17 (`8b451e8`, Markdown only): P04.T01i and P04.T01j PR-A; ADR-0019, ADR-0020 and ADR-0021 Accepted; `staging-card-1`; the ADR-0014 item 4 and 5 amendments; `docs/plan/mvp.md`; the 2026-10-19 live evidence; the Mobbin design references. The staging row of `deployment-policy.json` moves to P04.T01i PR-B.

In progress:
- **P04.T01j PR-B** (`claude/p04-t01j-createrole-administrator`, pushed, no PR): 0005–0015 rebaselined once under ADR-0020, the D5 preflight, `lab:createrole-administrator` in `pg-core`, createrole tenant conformance. Open: PR and hosted CI, the owner's M-J1 acknowledgement, AC14–AC16.
- **P05.T01y** (`claude/p05-t01y-session-lifecycle`, pushed, no PR): PR-1 (0016, `lab:session-lifecycle-sql`) and PR-2 (`POST /auth/rotate`, logout clear, keeper, `lab:standalone-rotate-https`). On 2026-10-19 it merged the P04.T01j branch and `main` `8b451e8`, and 0016 now reads memberships only through the ADR-0020 helpers (new pin `db8111c7…`; unapplied anywhere); `lab:createrole-administrator` covers 0016 and the rotation entry point. Local checks and the pg-core, pg-work and login/logout/rotate HTTPS labs pass (`docs/packets/P05.T01y.md`, Implementation notes). Open: PR and hosted CI after P04.T01j merges, PR-3 (AC33 workerd rotate transcript, AC34 pgwire on the full chain), AC21's seeded linking-flow case.
- Built branches waiting for the merge train (next actions): P14.T01a PR-2, P01.T02c PR-A, P01.T04a PR-B, P04.T01j PR-B, P05.T01y, P06.T01b PR-1, P05.T01ab, P04.T01i PR-B. `claude/mvp-briefs` holds the M2–M5 briefs and the proposed ADR-0022.

## Decisions recorded 2026-10-18 and 2026-10-19 (owner, in chat)

- **ADR-0021 MVP fast track:** "yes fast track but our foundation architecture should be solid so we can scale the product later without any issues."; first job "Product listings"; first merchants "Invite-only beta (Recommended)"; the record "Approve as written (Recommended)".
- **ADR-0019 and `staging-card-1`:** "Approve both (Recommended)": staging on workers.dev, continuous deploy from `main`, Turnstile and per-IP limits before hosted login (resolves the P05.T01x §11 sign-off). Branch protection timing: "Required before production (Recommended)" (ADR-0014 item 5 amendment).
- **ADR-0020:** "Approve ADR-0020 (Recommended)" (P04.T01i OQ-1 B: P04.T01j rebaselines 0005–0015 once and merges before any other migration). Item 7: "None that I know of".
- **GitHub:** OQ-2 "GitHub Pro (Recommended)"; the owner bought Pro ("I'll finish it myself"); "pro is active you set the action budget" ($10 Actions budget, hard stop); "Turn it on (Recommended)" (branch protection on `main`).
- **Third-party GitHub access:** first "i am not working with codex so it won't push anything so leave it"; then, asked again with the risk stated, "Suspend Codex + revoke old token (Recommended)". The platform GitHub Apps stay for staging as a recorded exception (ADR-0019 item 5, ADR-0014 item 5 amendment).
- **Cloudflare:** P04.T01i OQ-3 "Use this account" (option C, census at every deploy); Wrangler OAuth "Revoke it (Recommended)".
- **P03.T04f OQ-1:** "Allow both (Recommended)" (ADR-0014 item 4 amendment: light runs pass `foundation`).
- **2026-10-18:** ADR-0015 billing routes by origin (supersedes ADR-0006; Stripe selected, no account or calls until an approved packet); ADR-0016 collaboration contracts v1.1 (admins read private Asks through audited reads); ADR-0017 membership authority; ADR-0018 proposals without a task; P01.T04a OQ-1 to OQ-3 (purchase permission with P18.T01a; a test entitlement seed for M4; an App Review allowance); P03.T04e OQ-1 (routine): heavy CI on dispatch plus weekly.

## Last green commit

`5806049` on `main` (PR #16): push run 39264458156 passed. Earlier: `f8314e8` (PR #11) push run 39173050501; `5ad6cc7` (PR #15) push run 39171677853; `bba3cec` (PR #14) push run 39169685269; `08e5ebf` (PR #13) push run 39168226191. A push that merges an unchanged PR head now runs only `checks`; record it with its push run and the PR run on the merged head.

**Failed:** the scheduled heavy-faults run 39227357944 on `f8314e8` (2026-10-19). ADR-0021 defers those suites, so the proposal is to disable the weekly schedule and keep `workflow_dispatch`. That is a `ci` change for its own PR, not PR #17.

## Next actions

MVP fast track (ADR-0021; `docs/plan/mvp.md`). M1, staging live:
1. Merge train: P14.T01a PR-2, P01.T02c PR-A, P01.T04a PR-B (with the walkthrough-count fix 86→90), P04.T01j PR-B, P05.T01y (0016 on the ADR-0020 helpers since 2026-10-19), P06.T01b PR-1, P05.T01ab, then the trimmed P04.T01i PR-B. Each PR gets one AI review (separate context, same model family), with the security lens where it applies.
2. **The trimmed P04.T01i PR-B:** deploy after green CI, migrations, roles and secrets. It keeps `staging:kill`/`unkill` with the flag re-read around the api deploy, the ADR-0019 item 4 deploy gates 1–6, and the census at every deploy. Card effect E11 (Claude's rollbacks) is suspended until the rollback refusal exists; staging rolls forward instead. AC14's hosted drill, AC15–AC17 and AC19 move past launch (`docs/acceptance/P04.md`).
3. Staging bring-up under `staging-card-1` once its preconditions hold (below); owner sign-in on staging.
4. Then M2, M3 and M5 in parallel, each behind the credential-custody gate; M4 (with the ADR-0005 stop controls, M3/M4); M6 (the deletion path before the real-store smoke).
5. A separate `ci` PR: disable the weekly `heavy-faults.yml` schedule.

Open plan follow-ups: work routes in production must be gated on P09.T05 when production mapping is enabled (ADR-0007 item 9; packet hard ordering b); superseded banners on `docs/references/*`; a forward migration routing the 0006, 0007, 0009 and 0011 definer guards through `executor_role_safe` (informational; 0017–0018 are P06.T01b); P05.T01y: rebind linking handoffs, reviews and status to the family (P09.T01a/T02a) and the revocation receipt (P05.T01z), and the production custody decision (ADR-0007 item 9) revisits the two R1 widenings accepted for staging; timing fixes if hosted `unit-stress` confirms them (`tests/broker-client.test.mjs` AC30, the 5,000 ms entry-timeout case in `tests/standalone-login-http.test.mjs`).

## Blockers

None for local work. The first staging deploy waits on the trimmed P04.T01i PR-B, P04.T01j, P05.T01ab and the preconditions below. **Credential-custody gate:** no Shopify, OpenAI or Stripe credential is bound to the broker until an owner-approved ADR supersedes ADR-0007 items 3–4 (ADR-0022, proposed).

## Pending owner actions

- **Before the first staging deploy (`staging-card-1`, "Preconditions for the first deploy"):**
  - GitHub: suspend the ChatGPT Codex Connector app (GitHub's sudo re-authentication stopped Claude's attempt) and delete the classic token "AppForge Github Actions". The platform apps AWS Connector, Codemagic, DigitalOcean, Expo, Netlify, Render and Vercel stay (ADR-0019 item 5 exception).
  - Cloudflare usage alerts at about 10% of each allowance (D9 5(c)), or confirm the D6 fallback: the $5 billable-usage alert (exists) plus your weekly check of Billing → Usage.
  - D9: delete Neon `cool-butterfly-64820147` and create the project key; change the Cloudflare Global API Key and create the two tokens (TTL 2026-11-18); a new WorkOS key, revoking old ones; `gh secret set CLOUDFLARE_API_TOKEN --env staging`; `tmutil addexclusion ~/.config/morrow`.
- **P04.T01j M-J1:** acknowledge that a non-Morrow member of `morrow_identity_owner` now denies every identity login (ADR-0020 items 3–4), or ask for an ADR-0020 amendment if a maintenance member must stay possible.
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
