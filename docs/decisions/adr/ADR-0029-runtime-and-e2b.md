# ADR-0029 Runtime and E2B: one sandbox per run, with no internet, no credentials and no browser

- Status: Accepted 2026-10-23 (the owner, OD-2026-10-23-7: every owner question as recommended)
- Date: 2026-10-23
- Supersedes: nothing accepted (it replaces two uncommitted drafts of 2026-10-22).
- Amends, for development and staging: ADR-0007 item 4 and build-plan line 461 (the E2B key in the broker before P08.T02); ADR-0013's E2B bullet; ADR-0022 items 7, 9 and 11; build-plan P12.T01, P12.T02, P07.T02 and, for this profile, the P12b hard-deny line; `providers.json`. Through owner questions 2 and 3: ADR-0023 decision 6 (the G5 rule; Pro timing).
- Implements: ADR-0023 decision 6.
- Does not change: ADR-0005, ADR-0011, ADR-0015; ADR-0022 items 10, 14 and 15 (privacy completion is ADR-0031 item 3's).
- Terms: the Owner, as in ADR-0024.
- Unblocks: P12.T01 to P12.T04, P07.T01, P07.T02, P09.T05, P11.T04, P11.T05; tracks T1 (lab cleanup), T2, T6, T7, T10, T12, T13, T14, T15, T18; gates G5, G6, G9, G10, G12, G13, G16.

## Context

The owner chose a runtime and E2B ("lets make sure we do have agent runtime in our mvp", Q2; "okay go with e2b", Q3; "no sorry i selected the wrong version, i do want the e2b in our mvp", Q4) and approved decision 6 without the pull-forward ("yes to all recommended", Q12). `main` has no runtime port, only unused lab adapter code. E2B has a staging project in US-WEST-1 on Hobby with a US$20 usage limit and no key. Twenty questions went to E2B on 2026-10-22, unanswered so far.

## Decision

1. **The computer: profile `morrow.computer` v1.** One fresh sandbox per run that needs one, at most one, never reused, paused, resumed or connected to. Internet off at creation, outside the guest; timeout 900 s; metadata holds only the operation id. Killed at run end, before any durable wait and on any stop. A pinned template from a repository recipe: Python data libraries, no browser; model code runs as non-root `agent`, 120 s per exec; 2 vCPU and 1 GiB. Analyst and Inventory skills use it, with a TypeScript fallback.
2. **`RuntimeProviderPort`** (P12.T01), composed only in the broker, with no connect or resume. Closed outcomes are never flattened, and a lone 404 is never absence. Each sandbox is a `runtime_operations` row (FORCE RLS) whose send mark commits before the create: reconcile before any retry, never promote an unknown, and keep a STATUS row per open unknown. A sandbox not found is `absent_verified` only after its deadline plus 10 minutes on a qualified profile; otherwise `unknown_effect`, booked at worst case, never retried. An orphan sweep kills leftovers through one ids-only definer. The E2B adapter is hand-written `fetch`, with no SDK.
3. **Credentials.** `E2B_API_KEY` binds only to the broker, placed by the owner with `wrangler secret put` after qualification is approved. Each sandbox's envd token is a broker vault record destroyed at kill. Inside the sandbox only E2B's root-owned envd holds it; it must be unreadable by `agent` and unable to change network or timeout, or the profile is denied (owner question 4). Template builds are owner actions, never Claude or CI (owner question 1).
4. **Inputs: minimised extracts.** Closed extract kinds with fixed column allowlists (`products`, `stock`, Level 1 `order_aggregates`, `upload`), within the run's read authority. Never in the guest: customer fields or ids, order ids, the shop domain, or any R2, presigned or Morrow URL. Customer data with the computer is refused by both manifest validators and by the broker.
5. **Outputs: untrusted downloads.** Only PNG, CSV (formula cells escaped) and XLSX (no macros, links or objects), checked by content and size, stored with their inputs' read tags and served as attachments, never as HTML or SVG.
6. **Uploads** (P07.T02 subset). CSV and XLSX up to 10 MiB, with the uploader's read tags; Workers never parse them or serve them back. Opened only in a sandbox, by an installed agent's run the uploader's tags allow, never a specialist at launch, after ADR-0031 item 5's header screen. Their deletion path merges before the first real upload.
7. **Authority.** New capability `runtime.execution.use` (`billable_job`, not review-required, D17): `computer.*` requires it, an installation holds it only when its package declares a computer skill, the install screen shows it, and the intersection is re-checked at every step.
8. **Money and the runtime cap.** The run reserves the worst case at list rates (about US$0.03) before the create, in a new `sandbox_compute` reservation kind; ADR-0026 prices computer seconds. Before every create, code checks a monthly runtime budget below E2B's limit (staging US$10 of US$20), half the tier's concurrency and 3 sandboxes per workspace. At the cap the fallback runs; cleanup is never blocked.
9. **Holds and stops.** A quota, billing block or unreconciled `unknown_effect` sets a runtime hold that only a person lifts; it blocks creates, never cleanup. Cleanup runs under every stop; stops kill their scope's sandboxes. A store's privacy request completes only as ADR-0031 item 3 says, which includes every runtime operation being terminal.
10. **The switch.** `docs/decisions/runtime-staging.json` replaces `e2b-activation.json`, committed `off` (states `on`, `cleanup_only`, `off`), with `admission: synthetic_only | merchant`. It stays `synthetic_only` until G9, E2B's DPA (G16) and acceptable deletion answers; `merchant` needs the owner's per-action approval.
11. **E2B's answers and qualification.** The answers are recorded with date and sender in `docs/evidence/live/2026-10-22-e2b-support-questions.md`. Answers on guest networking, the token and timeouts gate adapter code (G5) until 2026-11-20; if they have not come by then, T10 starts the adapter with conservative defaults, every failure after the send mark unknown, and proves the testable answers in qualification (owner question 3). Others gate qualification or `merchant` admission. An adverse answer stops T10's adapter until the owner decides. Qualification before `on`, under staging card 2 within US$5, shows egress denied by a root canary, the token unreadable by `agent`, and timeouts that kill without pausing; any adapter, template or region change voids it.
12. **Tiers and fallback.** Hobby for staging; Pro in a separate production project, bought at production bring-up, W7 to W9 (owner question 2). If the computer is not qualified at launch, the owner chooses between the TypeScript fallbacks and holding launch. Lasting workspaces, web access and browsers each need their own ADR.

## Security invariants touched

- **Tenant isolation; the intersection; nothing external before the gateway:** `lab:tenant-conformance`, `lab:agent-authority-workers`.
- **Unknown outcomes reconciled first:** `runtime-port-conformance.test.mjs` (new).
- **Broker-only credentials:** `broker-runtime.test.mjs` (new), `verify:boundaries`, `edge:check`.
- **Default deny; no real data before its deletion path; immutable migrations:** `edge-config.test.mjs`, `lab:shopify-privacy`, `migration-history.test.mjs`.

**Interpretations the owner approved** (owner questions 1 and 4, 2026-10-23): if template builds need a build-only key, the owner holds it and Claude, Workers, CI and the VM never read it; the envd token is held by E2B, unreadable by Morrow's guest code, and the profile is denied if qualification cannot show that. With question 4's reading accepted, no invariant is weakened.

**Looser on purpose:** a compromised orchestrator learns which runtime operations are unsettled across tenants and can trigger their cleanup early, but no content. This widens ADR-0022 item 9's residual; the owner accepted it with this record (OD-2026-10-23-7).

## Consequences

Risk: E2B changes often, so wire fixtures and the canary set the hold on a break.

## Alternatives considered

- **boat.dev:** egress control only inside the guest.
- **The loop inside the sandbox:** the model key in the guest.

## Owner questions

1. **Template builds.** Your interactive E2B login if E2B allows it; otherwise one build-only key in a chmod-600 file under `~/.config/morrow/staging/`, used only by builds you run. *Recommendation: yes, in that order.*
2. **When to buy Pro.** At production bring-up (W7 to W9), since App Review runs on production. *Recommendation: yes.*
3. **Late answers.** If E2B has not answered by 2026-11-20, may T10 start the adapter with conservative defaults (every failure after the send mark unknown), proving the testable answers in qualification? *Recommendation: yes.*
4. **The envd token.** Does E2B's per-sandbox token, held by E2B's root agent and proven unreadable by Morrow's guest code, fall outside the invariant that no credential enters the VM? *Recommendation: yes.*

## Approval

The owner's statement in chat, verbatim, on 2026-10-23 (IST), after reading the decision sheet (`docs/decisions/decision-sheet-2026-10-26.md`) and a plain-language list of its questions numbered 1 to 31, with the other decisions numbered 32 to 38, each with its recommendation (OD-2026-10-23-7):

> approve all as recommended and user should be able to select model and thinking effor for each agent with the main agent set to opus 5.5 high by default and specialist at opus 5.5 medium for email the shop owner should be able to link there emails which will be used for any particual email job like suppose user linked multiple emails(our morrow email will be linked by defualt with user shop name, something like usershopname@morrow.com and selected by default unless user link there emails) and then whenever any email sending related prompt comes user should be able to select which email to choose for that, for now no need to develop the actual capability to link the email but architecture wise it should be like how i explained so we can just add the feature to link users email and it will show in the emails available to use list.

What it approves: this record as written and each owner question above with its recommended answer.

## Amendments

### 2026-10-25: uploads and workspace-created agents (ADR-0037)

The owner's decision of 2026-10-25 (OD-2026-10-25-3, recorded in ADR-0037) ends the specialist kind, so item 6's "never a specialist at launch" lapses; the text above is kept as approved. A workspace-created agent opens an upload only as any installed agent does: in a sandbox, by its run the uploader's tags allow, and only when its approved card holds the computer tools. The owner confirmed this as recommended (OD-2026-10-25-4).

### 2026-10-25: item 8's monthly runtime budget (ADR-0039)

The owner's decision of 2026-10-25 (OD-2026-10-25-4, recorded in ADR-0039) changes item 8; the text above is kept as approved. Morrow's monthly runtime budget below E2B's limit (staging US$10 of US$20) goes: E2B's usage limit in the owner's E2B account is the outside backstop, as the Anthropic monthly limit is for model calls, and E2B's refusal sets item 9's runtime hold, which only a person lifts. Each sandbox holds its worst case in credits from the workspace's wallet before the create, and its use is drawn after. The concurrency caps (half the tier's, and 3 per workspace), the session deadline and the cleanup rules stand.
