# ADR-0021 MVP fast track: launch one listings slice on a production-grade foundation

- Status: Accepted 2026-10-19 (owner decision in chat; see Approval)
- Date: 2026-10-19
- Supersedes: the settled constraint "Broad production foundation for small and large Shopify brands. No MVP scope reduction of the launch destination." (CLAUDE.md, plan R1).
- Refines: ADR-0001 (`docs/plan/mvp.md` is the launch plan; `build-plan.md` stays the plan of record and long-term structure), ADR-0002 (process: packets, ADR triggers, review tiers), ADR-0003 (two-track and the hardening budget), ADR-0015 (billing route at launch).
- Affects: the launch gate, the plan's ordering, CLAUDE.md, and every packet not on the MVP path.

## Context

After about three days of work, `main` has sign-in, workspaces, goals, tasks and questions, approval records, billing rules and a UI shell. None of what makes Morrow useful exists yet: the Shopify connection, the AI agents, and the gateway that applies an approved change to a store. Most of the elapsed time went into process and breadth rather than the product:
- long packets and an ADR for each decision;
- two AI reviews per change;
- timing-sensitive lab suites;
- an 80-task plan worked on in parallel.

The owner asked to launch sooner and iterate, with good-enough security and a foundation that scales.

## Decision

1. **Launch target: an invite-only beta of one slice.** A merchant:
   1. signs up on the Morrow website;
   2. pays a Stripe subscription (Morrow is the seller; test mode first);
   3. connects one Shopify store through a private (custom-distribution) install link;
   4. asks Morrow to improve product listings.

   The Coordinator routes the request to a Listings specialist. It drafts exact changes as a Proposal@2: title, description, SEO title and description, and tags. A human approves that exact proposal. The single gateway applies it through the broker with the Shopify Admin API, reads it back and audits it. Each AI run reserves credits from the work-credit balance. The detailed slice is in `docs/plan/mvp.md`.
2. **The architecture stays production-grade.** The owner requires a foundation that scales without rewrites. The MVP narrows features, not foundations. These stay as designed:
   - the Worker boundaries (api, broker, connector, orchestrator);
   - Neon with FORCE RLS and restricted roles;
   - the versioned contracts and generated validators;
   - one gateway for every external effect;
   - digest-bound approvals;
   - the credit ledger;
   - reconcile-before-retry.

   No shortcut may require rewriting these later. Where the MVP builds a smaller version (one model, one specialist, one capability family), it uses the long-term interface.
3. **Security invariants are unchanged.** Every invariant in CLAUDE.md still holds, with its owning tests. Before real merchant data arrives, the MVP also delivers Shopify's mandatory compliance webhooks and the deletion path for the data classes it stores.
4. **Deferred to the post-launch roadmap:**
   - the Shopify App Pricing route and the App Store listing;
   - multi-store allocation;
   - the optional Chief of Staff and CMO installations;
   - E2B execution;
   - the collaboration surfaces beyond what the slice needs;
   - heavy fault and soak suites;
   - the elaborate staging tooling (rollback guards, the kill-race drills);
   - every capability outside product listings.

   The 18 packages, 80 parent task IDs and 73 acceptance IDs remain the long-term structure. They are no longer the launch gate.
5. **Process (refines ADR-0002 and ADR-0003):**
   - New work uses a one-page brief in `docs/briefs/`: goal, scope, interfaces touched, security notes and a test checklist. Full packets are reserved for security-heavy work.
   - An ADR is needed only for authority, tenancy, security, money (billing, pricing, spend), provider selection, public contracts or data retention. Other choices are routine and recorded in the brief.
   - Each PR gets one AI review (separate context, same model family). The security lens is included when the PR touches authority, RLS, migrations, credentials, provider adapters, approvals, budgets, billing or durable execution. Earlier references to "Tier 2 plus `/security-review`" (or `/code-review` plus `/security-review`) in packets, acceptance files and ADRs now mean this one review with the security lens.
   - PRs are feature-sized. CI stays the merge gate, under ADR-0014 with branch protection on `main`.
   - No new heavy-fault or soak labs before launch. Each feature carries ordinary tests and one end-to-end lab path.
   - Provider effects and live data keep their per-action owner approval or the staging card.
6. **Billing at launch** is the ADR-0015 website route only: Stripe Billing, with Stripe Tax when live. Before Morrow takes money from a merchant installed through a private link, Shopify's rules for charging custom-distribution installs are confirmed and recorded.

## Consequences

- The fastest path to a launchable product runs:
  1. M1: staging live;
  2. M2: Shopify connect;
  3. M3: the listings agent;
  4. M4: approve and apply;
  5. M5: billing;
  6. M6: beta readiness.
- Branches already built (sessions, UI, collaboration contracts, the billing library, approval records, the ADR-0020 fix and sign-in protection) merge as they are.
- **The trimmed P04.T01i PR-B.** It is cut to deploy-after-CI plus migrations, roles and secrets, and it keeps every control the approved card `staging-card-1` relies on:
  - `staging:kill` and `staging:unkill`, with the deploy flag re-read just before and just after the api deploy;
  - the ADR-0019 item 4 deploy gates 1–6 (main tip, deploy flag, schema head, login configuration digest, broker secret names, offline build and dry-run);
  - the account census at every deploy;
  - for rollback: card effect E11 (Claude's rollbacks) is suspended until the rollback refusal exists. Staging rolls forward instead, through a new green `main` commit, with the kill switch as the stop.

  The hosted kill-race drill (P04.T01i-AC14's hosted part), the keyring, rotation and rollback drills (AC15–AC17) and the p95 report (AC19) move past launch (`docs/acceptance/P04.md`).
- **Credential-custody gate.** No Shopify, OpenAI or Stripe credential is bound to the broker until an owner-approved ADR supersedes ADR-0007 items 3–4 (trust model v0 and the barred credentials). ADR-0022, proposed on branch `claude/mvp-briefs`, is that ADR. M2, M3 and M5 wait on its approval (`docs/plan/mvp.md`).
- **Stop controls before effects.** The ADR-0005 stop controls exist before the first agent-initiated store write (invariant 15). They are built in M3/M4.
- Some of the plan's acceptance rows stay open past launch. STATUS and `docs/plan/mvp.md` say so plainly.

## Alternatives considered

- **Keep the full production foundation before launch.** It is the safest in the long run, but the owner judged it too slow.
- **Cut the architecture to ship faster** (one Worker, no broker, no RLS). Rejected by the owner ("foundation architecture should be solid") and by the security invariants.

## Approval

Owner, 2026-10-19, in chat: "we are doing too much premature optimizations why not build our mvp as fast as possible with good enough security so we can launch it and then iterate it".

Asked "Switch Morrow to an MVP fast track: launch one end-to-end slice (sign up → pay → connect store → AI drafts a change → you approve → Morrow applies it and logs it), keep the core security, and cut process and breadth?", the owner answered: "yes fast track but our foundation architecture should be solid so we can scale the product later without any issues."

Asked for the first job Morrow's AI should do on a merchant's store, the owner answered "Product listings". Asked how the first merchants get Morrow and pay, the owner answered "Invite-only beta (Recommended)": a private Shopify install link per merchant, with a Stripe subscription on Morrow and the App Store listing later.

Owner approval of this record, 2026-10-19, in chat. Asked "ADR-0021 (the fast-track decision) also includes details I filled in from your direction: one-page briefs, one AI review per PR, ADRs only for security/money/tenancy/providers/contracts/data retention, no heavy fault tests before launch, and the old 80-task plan no longer gating launch. Approve ADR-0021 as written?", the owner answered "Approve as written (Recommended)". This accepts items 1–6.

The Consequences bullets on the trimmed P04.T01i PR-B, the credential-custody gate and the stop controls, and the review-reference sentence in item 5, were added after the AI review of PR #17 (separate context, same model family). They apply items 3–5, ADR-0005, ADR-0007 and ADR-0019 and the card as already approved; they narrow Claude's card effects (E11) and do not change the decision.

