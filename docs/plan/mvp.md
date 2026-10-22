# Morrow MVP: the launch plan (ADR-0023)

This is the launch plan. [ADR-0023](../decisions/adr/ADR-0023-mvp-redefinition.md) (its decisions approved by the owner on 2026-10-23) records the owner's decisions behind it and supersedes ADR-0021's invite-only listings beta. `build-plan.md` stays the long-term roadmap and structure; where it differs on launch scope or order, this file and ADR-0023 win until launch. When the project graph lands (ADR-0023 decision 10), its feature, agent, track and gate nodes carry this plan and this file becomes generated from them.

Planning date: **public launch on Monday 2027-03-01**, in a range from mid-February (one clean App Review) to April 2027 (several rounds). Week 0 (W0) starts on Monday 2026-10-26.

## What Morrow is

Morrow is a shop's AI team, working alongside its people. A merchant installs Morrow from Shopify and picks agents from Morrow's catalogue. Each agent has a standing goal, such as "every active product has complete SEO" or "no top seller drops under 14 days of stock", and works toward it on its own: on schedules and routines, when the store changes, when a watched number moves, and in a daily look for useful work. It keeps a notebook of what it learned and plans next.

People and agents share one workspace: goals, a task board, a thread on every task, one Inbox, a shop knowledge base and an activity log. The Coordinator ("Morrow") takes requests. It answers, routes the work to the installed agent whose job it is, or, when nothing installed covers the goal, proposes a temporary specialist built from Morrow's own skills, which the Owner starts.

Agents read, analyse and draft freely. They never change the store, spend money or message a customer without a person approving the exact change. A short-lived cloud computer with no internet crunches numbers and opens spreadsheets. Morrow is a standalone web workspace with a small home inside the Shopify admin, paid as one monthly plan on the Shopify bill, with one credit balance and caps the merchant sets.

## MVP scope

Must = in the MVP (ADR-0023 decision 1). Plan IDs are the `build-plan.md` tasks each area draws on.

| Area | At launch | Plan IDs |
| --- | --- | --- |
| Workspace and people | Sign-up and sign-in (built); invitations; Owner, Admin and Member roles whose approval and customer-read rights follow explicit grants; agents as members; Home with the pulse, goal progress and "needs you"; per-viewer visibility; a hand-over step when a member leaves | P05.T01z, P05.T02, P14.T01, P14.T02 |
| Work and collaboration | Goals with metrics computed in code; the task board; recurring tasks; threads, Ask Morrow and @mentions; one Inbox; artifacts; CSV and XLSX uploads opened only in a sandbox; notifications as fixed templates and a daily digest | P06.T01, P07.T01–T03, P14.T02 |
| Agents and catalogue | AgentPackage@1 built from first-party skill files and a role prompt; install (with optional Shopify scopes), pause, update to a pinned release, uninstall; an agent page with its notebook; recorded evals in CI and a live-eval digest to publish | P16.T01, P16.T03, P16.T04, P15.T03 |
| Specialists | Person-started, one level under the Coordinator (decision 11; below) | P13.T02, P15.T04 |
| Proactivity | Schedules in the shop's timezone; Shopify event triggers gathered into batch runs; metric monitors in code; mentions and assignments; inbound support email; a daily read-only look-for-work pass; notebooks; admission control in code | P06.T03, P12.T04, P13.T03 |
| Safety and governance | Allow, Ask and Never rules that merchants can only tighten, per agent and workspace-wide; mandates (90 days, renew, revoke, notices, hand-over); budgets and caps; stops (`human_only`); the activity log | P05.T04, P11.T04, P11.T05 |
| Approvals and the gateway | Exact before-and-after review; edit makes a new proposal; batch approval as N digests; one gateway for every write (claim, re-check, execute, read back, audit); revert from a fresh read; `discount.deactivate` | P06.T01c, P11.T01–T03, P14.T03 |
| Knowledge | Typed pages (brand voice, policy, product fact, supplier, decision, lesson) with links, versions and sources; supplier records; full-text retrieval; agents propose and people accept | P10.T02–T04 |
| Shopify | One public app (unlisted, then listed); expiring offline tokens; minimal required and per-agent optional scopes; reads, bulk operations and webhooks; approved writes (product content and SEO, tags, alt text, collections, capped discounts); compliance webhooks with `data_request` export; the embedded home | P08.T02, P09.T01–T05 |
| Runtime | One fresh E2B sandbox per run that needs it: no internet, no credentials, no browser; minimised inputs; PNG, CSV or XLSX outputs only; TypeScript fallbacks | P12.T01, P12.T02 |
| Email | Inbound by forwarding (Cloudflare Email Routing); approved outbound support replies through Resend with idempotency and status; no supplier email | — |
| Billing | Shopify App Pricing: a plan with a monthly credit grant plus usage charges with caps Morrow enforces; credits only after a confirmed usage record; a rate card. Stripe code stays switched off | P01.T04a, P18.T01 |
| Privacy and operations | A deletion path for every new data class before its real data; 90-day retention; data regions in the privacy policy; production; legal pages; alerts; the listing | P09.T05, P18.T02, P18.T05 |

## Launch agents and specialists

All agents share one tool catalogue, one loop (`AgentRunWorkflow`) and one gateway. They differ only in data: manifest, skills, role prompt, tool subset, triggers, rules and evals.

| Agent | Jobs | Optional scopes | Customer data | Computer |
| --- | --- | --- | --- | --- |
| Coordinator (built in) | Answers from knowledge; routes Asks and @mentions to one installed agent; proposes a specialist when nothing installed covers the goal; asks clarifying questions; ranks suggestions. Creates only tasks, questions, messages and specialist drafts | None | Only what the asking person may see | No |
| Specialist (built-in release, run-scoped) | One bounded piece of work on one task, from 1 to 3 eligible skills; reports back; proposes | None beyond those granted ("plan only" otherwise) | None | Only under the runtime switch |
| Listings | Titles, descriptions, SEO, tags, alt text, collections; weekly quality sweep; batch proposals and revert | `write_files` | None | No |
| Business Analyst | Daily pulse and weekly review; monitors on sales, AOV, refunds, unfulfilled orders, stock cover and margin; investigations; read-only | `read_orders` | Level 1 only | Yes |
| Inventory and Purchasing | Days of cover; low- and dead-stock alerts; reorder suggestions with a purchase-order file and a draft supplier email the merchant sends | `read_orders` | Level 1 only | Yes, with a TypeScript fallback |
| Customer Support | Drafted replies to forwarded email (where is my order, returns, product questions); every send approved; refunds and cancellations escalated to a person | `read_orders`, `read_customers`, `read_returns` | Level 2: name and email | No |
| Marketing and Promotions | Weekly promotion plan; campaign and social copy; capped discount proposals and ending them | `write_discounts` | None (aggregates) | No |

**Specialists** (ADR-0023 decision 11): only the Owner starts one at launch, from a card whose top lines code writes; 1 running per task and 2 per workspace; one 24-hour authority clock from Start, with the run itself 1 hour by default and 8 at most; read, internal, propose and compute tools only; no customer data and no support tools; reports are data and never reach the Coordinator. A run-scoped installation of the `morrow.specialist` release carries its authority. The switch stays off until the deletion paths and the gateway, reservations and stops exist. **Skills:** 12 first-party job skills (`skills/<id>/SKILL.md` plus `skill.json`), pinned by release digest; no skill registry at launch.

## Tracks and dependencies

Interfaces first: each track's first PR is its contract with a fake, merged in W1. Small PRs on `main` behind default-off switches; stacks at most two deep.

| Track | Scope | Depends on | Weeks (agents) |
| --- | --- | --- | --- |
| T0 Decisions | The companion ADRs (ADR-0023, "Companion records"); the weekly decision sheet | Owner | W0 onward (1) |
| T1 Land the train | Done: #37 and #39 to #44 merged, staging migrated to 0038. Left: the owner's first staging sign-in; the cleanup PR (dead code and checks; the Stripe code stays, switched off) | Hosted CI, AI review | W0 to W2 (1) |
| T2 Interfaces | Tool catalogue, admission, job and event shape, mutation registry, AgentPackage@1 with `skills`, `skill.json`, RuntimeProviderPort, knowledge and notebook API, inbox kinds, schedules, agent-loop and mandates contracts, SpecialistSpec@1 and the Start document, adapter size budgets; all with fakes | T0 | W1 (3 to 4) |
| T3 Gateway | Review API, batch approval, revert, `discount.deactivate`, exceptions Inbox. Security packet | T1, T2 | W1 to W4 (1 to 2) |
| T4 Agent platform and loop | `AgentRunWorkflow` with tools, durable waits, manifests, installations, catalogue backend, rules, Coordinator v2, model profiles; the mandates packet; the specialist authority packet (merged by W5); the stale-run sweep and the removed-model alert. **Critical path** | T1, T2; the loop, authority and specialist companions | W1 to W6 (2; 3 from W2 to W5) |
| T5 Proactivity | Schedules, recurring tasks, the router on the cron, monitors and the metric catalogue, look-for-work | T2; T8 | W2 to W5 (1 to 2) |
| T6 Collaboration backend | Invitations and roles, threads and mentions, inbox kinds, notifications, artifacts and uploads, read tags | T2; T11 | W1 to W4 (1 to 2) |
| T7 Workspace UI | Home, Inbox and diffs, board, threads, catalogue and install, agent page, knowledge, activity, settings, onboarding; the embedded home (setup, connection status, plan, pending approvals); the specialist Start card and report card | T2 fakes | W1 to W8 (2 to 3) |
| T8 Shopify public app | App record; expiring-token custody packet; session-token identity packet; scopes; reads, bulk operations, webhooks; "Disconnect store"; the maintenance sweep; the 48-hour fallback; `data_request` export; the protected-data request | G3 | W1 to W6 (2) |
| T9 Shop knowledge | Typed nodes, supplier records, notebooks, full-text retrieval, deletion path | T2; T4 | W2 to W4 (1) |
| T10 E2B runtime | Port, fake and conformance (W1 to W2); adapter after E2B's answers and the runtime ADR (W3 to W6); staging qualification on synthetic data (W6 to W7); uploads | G5, the runtime companion, staging card 2 | W1 to W7 (1 to 2) |
| T11 Email | Inbound Email Worker, forwarding, the Resend adapter with idempotency and status, BCC, domain verification, the mail data class | The email companion, G7 | W2 to W5 (1) |
| T12 Launch agents and evals | Six packages from 12 skill files, with golden and injection evals recorded in CI and run live on staging; the `morrow.specialist` release with routing and composition evals | T4, T5, T8, T10, T11 | W4 to W9 (3 to 5) |
| T13 Shopify billing | App Pricing plan and capped usage, credits after confirmed usage records, plan change, reinstall | The billing companion; T8 | W4 to W7 (1) |
| T14 Privacy | Deletion paths per class (specialist specs, Start documents and retired run-scoped principals included), retention sweeps, workspace erasure, export, privacy policy with regions | T8, T10, T11 | W2 to W9 (1 to 2) |
| T15 Production | Production custody ADR (W3 to W5), bring-up under per-action approval (W7 to W9), submission inputs | Owner approvals | W3 to W9 (1) |
| T16 Project graph | Phases 0 to 3 (phase 0 on `claude/graph-engine`) | T0 | W0 to W3 (1) |
| T17 End to end and review | A simulated week on development stores (W8 to W9), submission (W10), review and fixes (W11 to W16), the owner's store after approval, launch | All | W8 to W18 |
| T18 Specialists | Owns the brief and the specialist authority packet; its PRs land in T2, T4, T7 and T12 | T1, T2, T4 | W1 to W7 (1) |

The critical path: T0, then T1 and T2, then T4, then T12, then T17's simulated week, then submission and App Review. T8, T13 and T15 must be ready for submission. The merge lane, not coding, sets the pace: about four to six merges a day.

The beta's former milestones, still cited in its briefs and code comments (`git show cbccb3a:docs/plan/mvp.md`), map to the tracks: M1 (staging live) to G2 and T1; M2 (Shopify connect) to T8; M3 (Listings agent) to T4 and T12; M4 (approve and apply) to T3 and T7; M5 (billing) to T13; M6 (beta readiness: the deletion path, production, legal pages, reconnect) to T14, T15, T8 and G9.

## Serial gates

1. **G1, W0:** the owner's decisions. Done 2026-10-23 for decisions 1 to 11 and billing option A; companion records follow on the weekly sheet.
2. **G2, W0 to W2:** the merge train lands, with `staging:migrate` after each merge that carries migrations. Done 2026-10-23 (ledger 38, deployed); the owner's first staging sign-in remains.
3. **G3, W0:** the owner creates the Shopify Partner account, the public app record and two or three development stores with generated orders, customers and stock. Every Shopify test waits on it.
4. **G4, W0:** an Anthropic staging key with a monthly spend limit; live evals need it by W3.
5. **G5, W0 to W3:** E2B's written answers to the questions sent just after midnight IST on 2026-10-23 (`docs/evidence/live/2026-10-22-e2b-support-questions.md`). They block adapter code only.
6. **G6, W1:** standing staging card 2, before `staging-card-1` ends on 2026-11-18.
7. **G7, W1:** the email vendor and the sending domain's DNS.
8. **G8, W1 to W2:** written questions to Shopify Partner support: the embedded home for a standalone workspace, and usage charges for credits.
9. **G9, before real data:** each data class's deletion path is merged.
10. **G10, before proactive triggers touch a real store:** the gateway, reservations and stops are merged. The specialist switch stays off until G9 and G10 pass.
11. **G11, W4, by Wednesday 2026-11-25 (the checkpoint):** one agent, one proposal and one gateway apply on a development store, shown in a demo.
12. **G12, W3 to W9:** the production custody ADR approved by W5, then production up by W9. Every production effect needs its own approval.
13. **G13, W10:** App Review submission: scopes and the protected-data request (Level 1; Level 2 name and email for Support), privacy policy, support and emergency contacts, a screencast, test instructions with a development store, production URLs, working compliance webhooks and billing.
14. **G14, W11 to W16:** Shopify's review (no published timeframe; 5 to 10 business days for a clean pass, 3 to 6 weeks in forum reports).
15. **G15, after approval:** the owner's store becomes the first real install, under the live-store ADR, with approval per action. Never for development.
16. **G16, W2 to W9:** the owner's legal steps: entity, Partner payout and tax, privacy policy, terms, DPAs (E2B, Anthropic, the email vendor).
17. **G17, before launch:** the owner's Tier 3 sign-off after the weekly demos.
18. **G18, W5, by Friday 2026-12-04:** the specialist authority packet is merged.

## Dates

| Milestone | Week | Dates |
| --- | --- | --- |
| Decisions 1 to 11 and billing option A approved | before W0 | 2026-10-23 (done) |
| Train landed; staging at migration 0038 | before W0 | 2026-10-23 (done) |
| Partner account; contracts merged | W0 to W1 | 2026-10-26 to 2026-11-06 |
| Checkpoint demo (G11) | W4 | by 2026-11-25 |
| Production custody ADR; specialist authority packet (G18) | W5 | by 2026-12-04 |
| Specialists on staging behind the switch | W6 to W7 | by 2026-12-18 |
| Working end to end on development stores | W8 to W9 | 2026-12-21 to 2027-01-01 |
| Production up | W9 | by 2027-01-01 |
| App Review submission | W10 | 2027-01-04 to 2027-01-08 |
| Shopify review and fixes | W11 to W16 | 2027-01-11 to 2027-02-19 |
| The owner's store, first real install | after approval | about W14 to W16 |
| **Public launch (unlisted link, paid), planning date** | **W18** | **Monday 2027-03-01** |

## Cut rules

- **G11 missed (W4):** cut Marketing, Inventory's computer forecast and specialists at once; they become fast follows.
- **G18 missed (W5):** specialists move to the first fast follow, 2 to 3 weeks after launch. Nothing specialist-related starts in W7 to W10. The skill files ship either way.
- **Slip order otherwise:** Marketing first, then the computer forecast (TypeScript fallback). Support stays unless Shopify refuses Level 2. The floor is the Coordinator, Listings, Analyst, Inventory and Support.
- **E2B not qualified at launch:** the owner chooses between the TypeScript fallbacks and holding launch. Never automatic.
- **Holiday weeks (W8 to W10):** production approvals assume the owner is available; if not, submission moves to W11 or W12 and launch to mid-March.
- **App Review objects:** under 1.2.1, remove the cause (no Stripe path from a Shopify install, matching prices, no outside-billing copy) and resubmit; under 2.2.2, grow the embedded home toward full embedding, which is a new owner decision.

## Not at launch

Automatic apply; lasting or paused agent computers, browsers and VM network access; the Chief of Staff and CMO; the agent builder and third-party or merchant-written agents and skills; "Keep this specialist", Member-started, auto-started or scheduled specialists; refunds, cancellations, order edits, fulfilment writes, prices, inventory quantity writes, theme writes and ad spend; Klaviyo, Meta, Google, Gorgias, Gmail, Slack and Drive; other upload types, rich editors, SSO and SCIM, multi-store, embeddings and a graph database; `read_all_orders`; soak and fault labs; the elaborate staging tooling: rollback guards, the hosted kill-race, keyring, rotation and rollback drills and the p95 report (P04.T01i AC05's rollback half, AC14's hosted part, AC15 to AC17 and AC19; card effect E11 stays suspended). Each stays in `build-plan.md` as the post-launch roadmap.
