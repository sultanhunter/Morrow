# ADR-0035 Build v1 live: the owner's own store, one environment, a standing approval

- Status: Accepted 2026-10-23 (the owner, OD-2026-10-23-9 and OD-2026-10-23-10)
- Date: 2026-10-23
- Supersedes:
  - ADR-0023 decision 2's bullets "All building and testing happen on development stores" and "The owner's store becomes the first real install after App Review approval, under its own live-store ADR with approval per action. Never for development", and the words "and none for the owner's store" in its first bullet (items 2 and 3);
  - ADR-0023 decision 10's "Staging" bullet (standing staging card 2) and gates G6 and G15 (items 1 and 2);
  - ADR-0022 item 4's "Development stores only until M6" and the "Linked stores: a Shopify development store only" bullet of its 2026-10-21 amendment to item 5, for the owner's store only (item 2);
  - the CLAUDE.md lines "Never use the owner's live shop for development" and "Approval is per action, until a standing staging approval card is approved and recorded in `docs/decisions/approvals/`" (items 2 and 4).
- Amends:
  - ADR-0021 item 5's last bullet: provider effects and live data fall under item 4's standing approval, not per action or a card;
  - ADR-0019 items 1 and 3: the deployed environment is v1 production as it is, holding the owner's store data; the clean production environment and gate G12 come before the first outside merchant, not before the owner's store (item 1);
  - ADR-0019 item 2 and ADR-0022 item 6: the connector's `workers.dev` address goes on under item 4, and the kill switch takes it down with the api's (item 2);
  - ADR-0023 decision 10's "Evals" bullet (live evals run under item 4) and its "Other approved items" (operational records move to a private repository before the first outside merchant); gates G3, G4, G11 and G16 (Consequences);
  - ADR-0025 item 1: a custom app serves the owner's store now, and `store_not_development` lifts now for that one store; the public app `morrow` follows for other merchants (item 3);
  - ADR-0026: no billing in v1; App Pricing (T13) waits for the first outside merchant; item 7's test seed runs for the owner's workspace under item 4, not per use or under staging card 2 (item 3);
  - ADR-0029 item 3 (the owner places `E2B_API_KEY` now, not after qualification), item 10 (`synthetic_only` lifts for the owner's store after qualification) and item 11 (qualification runs under item 4, not staging card 2; the adapter starts now with owner question 3's conservative defaults instead of waiting until 2026-11-20) (item 6);
  - ADR-0031 item 4 (G9), for data classes not yet used, on the owner's store only (item 7);
  - CLAUDE.md: the section "Provider and live effects" and the security invariant on real merchant data.
- Does not change: ADR-0005 (stops stay `human_only`); ADR-0007 item 9 (in code this environment stays `staging`, so production bindings stay refused); ADR-0010 and ADR-0020 (tenancy); ADR-0011 (digest-bound approval of the exact change); ADR-0014 (merge authority and CI); ADR-0022 items 7 and 11 (broker custody; US$7 per run and US$25 per workspace per day, checked in code); M3 owner decision 14 of 2026-10-22 (the model switch stays off until "Disconnect store" lands); ADR-0023 decision 10's rule that no model key goes into GitHub Actions; ADR-0029 items 1, 2, 4 to 9 and 12; every other security invariant (item 5).
- Affects: CLAUDE.md; `docs/plan/mvp.md` (a note at the top); `docs/progress/STATUS.md`; `docs/decisions/approvals/` (`staging-card-1`); `apps/broker`, `apps/shopify-connector`, `scripts/shopify-app.mjs`, the kill switch and `lab:shopify-install` (item 2); `docs/decisions/model-provider-staging.json` and the runtime switch (items 6 and 8).

## In plain words

- The copy of Morrow already running is v1. No second environment.
- Morrow is built and tested on the owner's own store, through a private Shopify app for that store only.
- One standing yes from the owner covers building and running it, within the spend limits the owner sets. Each action gets one line in a log.
- Still asked every time: purchases, raising a limit, deleting data, messages to customers, App Store submission, any other store.
- Unchanged: Morrow changes the store only after the owner approves the exact change; keys stay in the broker; each shop's data stays separate; the stop buttons work; unclear results are checked before any retry.
- Customer data waits for the Support agent and its delete-on-request path.

## Context

On 2026-10-23 the owner wrote, in chat (OD-2026-10-23-9):

> let cut all of this bullshit, we are building our product live as we don't have any customers right now. what we need is a live shopify store(we already have one), a shopify plugin to connect our ai workspace to our shopify store, anthropic key for the model( i already have it), cloudflare and neon we already did setup, for agent vm we have e2b so setup it also. so lets skip all this technical jargon and staging environment and directly build and test in production so we get our production version 1 as fast as possible

Where things stand. The four `morrow-staging-*` Workers and the Neon project `morrow-staging` (branch `staging`, migrations at ledger 38) are deployed and healthy. Store install and link, Shopify's compliance webhooks and the Listings agent's drafting are merged, but only for Shopify development stores (ADR-0022, `store_not_development`). The model, Stripe and E2B are switched off. There are no customers.

ADR-0023 built everything on development stores, put the owner's store last (after App Review, G15), and added a second standing card (G6) and per-action approval for every production effect. The owner wants the reverse: build v1 directly on the owner's own store, in the one environment that exists, without the approval paperwork.

## Decision

1. **One environment, and it is v1 production.** The four `morrow-staging-*` Workers and the Neon project `morrow-staging` (branch `staging`) are Morrow's v1 production, as they are. No second environment is built for v1.
   - Names, the database's `staging` mark and the `staging` profile in code stay until a cosmetic rename. Nothing in code changes because of the word: what admits only development and staging (the app registry, the test entitlement, the broker's refusal of production bindings) keeps working.
   - Staging card 2 and gate G6 are dropped. On acceptance, item 4 replaces `staging-card-1`.
   - A clean production environment, production custody (ADR-0007 item 9, G12) and the move of operational records to a private repository come before the first outside merchant.
2. **The owner's own store is the development and test store.** It is the only real store until the public launch; no other merchant's store links before then.
   - The broker's development-store check (`store_not_development`) admits Partner development stores and exactly one other store: the owner's. The app registry already binds each app to one store, kept only as a digest of its domain. The owner's app is registered with a live-store mark; the database lets at most one app per environment carry it, and every other app still admits development stores only. The shop's domain never enters this public repository.
   - A small PR does this, with new `lab:shopify-install` cases: the marked app's store is admitted; another non-development store using that app's install link stores nothing; a second marked app is refused; unmarked apps still refuse live stores.
   - The same PR turns on the connector's `workers.dev` address, so Shopify can reach Morrow, and makes the kill switch take it down together with the api's.
3. **The fast connection is the custom app already built; billing comes later.**
   - v1 connects through ADR-0022 item 4's custom-distribution app: one app for one store, the owner's. It starts with `read_products` and `write_products`; further scopes from ADR-0025 item 6's list are added as each agent arrives, and customer scopes only with Support (item 7).
   - The owner creates the app in Shopify's developer dashboard and stores its client secret with the existing owner-run script.
   - The public app `morrow` (ADR-0025: expiring tokens, the embedded home, App Review) comes later, for other merchants; the owner's store then moves to it.
   - No billing in v1. ADR-0026's App Pricing waits for the first outside merchant. The owner's workspace gets its credits from the existing test entitlement (staging-card-1 E13, 300 credits for 30 days), then from ADR-0026 item 7's test seed, both under item 4 and only for the owner's workspace. Credits stay the spend control in code; no money changes hands. More than 300 credits in 30 days is raising a cap (item 4).
4. **A standing approval to build and run, with a one-line log.** The owner approves, once, every build-and-operate action in this one environment: deploys, migrations, provider setup (Cloudflare, Neon, the Shopify app's configuration, Anthropic, E2B), sign-in and test runs, live evals, and reads of the owner's store through Morrow. They stay within the spend caps the owner sets:
   - Anthropic: the monthly spend limit on the key's workspace, set by the owner before placing the key, and the caps in code (ADR-0022 item 11);
   - E2B: the project's US$20 usage limit, with the code's runtime budget below it (ADR-0029 item 8);
   - Cloudflare Workers Paid (alert plus the stop), Neon Free (hard cap) and the US$10 GitHub Actions budget, as today.

   Each action gets one line in `docs/evidence/activity-log.md`: the date, what was done, the result, any cost, and an unknown outcome until it is checked. No per-action approval and no separate live record. The log never names the shop's domain, a customer, a product or a secret.

   The owner still approves each of these, one at a time: purchases, plan upgrades (E2B Pro among them) and ad spend; raising a cap; deleting data; sending anything to the owner's customers; the App Store submission; any store other than the owner's. Accepting a provider's terms, and anything that needs the owner's own login, stay the owner's.
5. **What does not change.** These protect the owner's real store and customers and cost nothing in speed:
   - Agents change the store or message a customer only after the owner approves the exact change. Any edit needs a new approval. The gateway re-checks, applies, reads back and audits. Claude never writes to the store any other way; a test change the owner does not keep is reverted through the same approval and apply step.
   - Secrets live only in the broker. The owner places them, through a hidden prompt or a chmod-600 file; never in chat, the repository, logs or a command line. Claude never reads credential files, never opens a provider page that shows a secret, and never suggests `!` for a command that asks for one.
   - Claude never copies customer data into chat, and no store data or shop domain into this public repository.
   - Tenant isolation (FORCE RLS, restricted roles) and the intersection of authority.
   - The stop buttons (`human_only`, ADR-0005), usable at any time: "Stop AI work", "Disconnect store", the platform stop and the kill switch. The model switch stays off until "Disconnect store" lands (M3 owner decision 14).
   - Unknown outcomes are checked before any retry and never counted as success.
   - Permission and budget checks in code; default deny; immutable migrations; no agent-initiated store change before the gateway, reservations and stops exist.
6. **E2B now, on the owner's data.** E2B is set up in the existing Hobby project with its US$20 limit.
   - The owner saves the E2B key in a chmod-600 file now; it is placed on the broker as `E2B_API_KEY` by the same command as the other broker secrets. The owner runs the template build with the owner's own E2B login (ADR-0029 item 3 and owner question 1). Claude writes the recipe and the adapter.
   - The adapter starts now with ADR-0029 owner question 3's conservative defaults (every failure after the send mark is unknown), without waiting until 2026-11-20 for E2B's answers. An adverse answer still stops it until the owner decides.
   - Qualification (ADR-0029 item 11, within US$5) runs under item 4 and still comes before `on`.
   - After qualification, the runtime switch may go `on` with `admission: merchant` for the owner's store, under item 4. E2B's DPA (G16) and its deletion answers are needed before the first outside merchant.
   - The sandbox still receives only minimised extracts with no customer fields (ADR-0029 item 4).
7. **Customer data comes last, with Support.**
   - Customer data (names, emails, addresses, phones: Level 2) and customer mail enter only when the Support agent is built, after their deletion path is merged. That is later in the order anyway. Customer classes keep G9 exactly.
   - ADR-0031 item 4 (G9), for classes not yet used: on the owner's store, a class that holds no customer data (order totals, run turns, notebooks, knowledge pages, sandbox files) may take the owner's data before its deletion path. The path is still written in the PR that first writes the class when it can be, and is due before the first outside merchant. Uploads keep ADR-0029 item 6's rule, since a spreadsheet can hold customer data.
8. **The order of v1 work.** The first milestone is the shortest path to a real result: the Listings agent drafts changes to the owner's real products and the owner applies one approved change.
   1. Connect the owner's store: the custom app, the one-store admission and the connector's address (item 2), install, link, read products.
   2. Turn on the model with the owner's Anthropic key, together with "Disconnect store": the owner sets the monthly limit and saves the key; it is placed on the broker; the model switch goes on. The Listings agent (built) drafts on real products. Drafts stay inside Morrow.
   3. The gateway applies approved changes (T3): the owner approves the exact change; the gateway applies it, reads it back and audits it. Nothing is written to the store before this. "Undo" (a new exact approval, from the values read before the apply) follows next.

   Side by side, starting now: E2B (item 6); the agent loop (T4) and the agents that need no customer data; the workspace screens (T7, Sunrise, ADR-0032); the project flow (the work model and plan records, ADR-0033 and ADR-0034, proposed).

   After v1: Support with customer data (item 7), then the public app, billing, App Review and the first outside merchant, each with what this record moved there.

## Security invariants touched

Two lines change, for the owner's store only:
- **"Never use the owner's live shop for development"** becomes: the owner's store is the development and test store, and no other real store links before the public launch (item 2). `lab:shopify-install` (new cases), `lab:workspace-store-linking`.
- **"No real merchant data of a given class before its deletion path"** becomes: customer data never comes before its path; other classes may hold the owner's store data first, and every class has its path before the first outside merchant (item 7). `lab:shopify-privacy`, `redaction-handlers.test.mjs`.

None of the others is weakened (item 5):
- **Exact approvals and the gateway:** `approval-records.test.mjs`, `review-policy.test.mjs`, `lab:approval-records`.
- **Tenant isolation and the intersection:** `lab:tenant-conformance`, `lab:agent-authority-workers`.
- **Broker-only credentials:** `verify:boundaries`, `broker-vault.test.mjs`, `broker-shopify.test.mjs`.
- **Stops:** `kill-switch.test.mjs`, `stops.test.mjs`, `platform-stop.test.mjs`.
- **Unknown outcomes; immutable migrations:** ADR-0029's runtime conformance tests; `migration-history.test.mjs`.

## Consequences

- **Owner steps, in order:** create the custom app for the owner's store and store its secret (G3 shrinks to this); set the Anthropic monthly limit and save the key (G4); save the E2B key and run the template build; before 2026-11-18, extend or replace the two Cloudflare tokens (`morrow-staging-ci` and `morrow-staging-operator`), which were made to expire with `staging-card-1`, or continuous deploy stops. The Neon key and connection string do not expire, and the card's end-of-life clean-up (revoking them) no longer applies.
- **Tooling** that reads `staging-card.json` (the deploy gates, `put-secret`, the test entitlement) keeps reading it until a routine PR points it at this record. That PR must merge before 2026-11-18: after that date every `staging:*` command that checks the card refuses (the kill switch does not check it). The card's record stays as history.
- **Gates:** G3 becomes the custom app; G4 the owner's key; G6 and G15 are dropped; G11's demo runs on the owner's store; G12 and G16 move to before the first outside merchant; G9 applies as item 7 says. G13, G14 and G17 are unchanged and follow v1.
- **Plan:** `docs/plan/mvp.md` gains a note at the top; its tracks and dates become the plan from v1 to the public launch. STATUS and the graph record this.
- **Risks, accepted:** a bug can touch the owner's real store; the approval of every exact change, the read-back and "Undo" bound it. The owner's store data sits in this environment with no clean rebuild before v1. The repository is public, so no record names the shop's domain or its data.
- **Reversible:** the owner can stop AI work, disconnect the store ("Disconnect store", which lands with the model switch) or uninstall the app at any time. Until the scope-change and reinstall work (ADR-0025 item 10) lands, an uninstall or a scope change ends that app for good, and reconnecting needs a new app record.

## Alternatives considered

- **ADR-0023's path:** development stores, a second card, the owner's store after App Review. Safer for a store whose customers need protecting, but months before the owner sees Morrow on the real store. The owner rejected it.
- **A separate production environment first:** a fresh database and credentials before the owner's store. Days of work that buy nothing while the owner is the only merchant; it waits for the first outside merchant.
- **The public app first:** an unapproved public app cannot install on a live store (ADR-0023's Context), so it cannot be v1's connection.
- **Dropping the safety rules too:** rejected. The exact-change approval, broker-only secrets, the stop and the unknown-outcome check protect the owner's real store and customers and slow nothing.

## Approval

The owner's statement in chat, verbatim, on 2026-10-23 (IST), after the list of owner actions that included staging card 2 and its explanation (OD-2026-10-23-9):

> let cut all of this bullshit, we are building our product live as we don't have any customers right now. what we need is a live shopify store(we already have one), a shopify plugin to connect our ai workspace to our shopify store, anthropic key for the model( i already have it), cloudflare and neon we already did setup, for agent vm we have e2b so setup it also. so lets skip all this technical jargon and staging environment and directly build and test in production so we get our production version 1 as fast as possible

- **The text (OD-2026-10-23-10),** after reading the record's summary and the CLAUDE.md change: "approve ADR-0035 and the CLAUDE.md change".

What they approve: this record as written and its CLAUDE.md lines; this record's direction, the one environment, the owner's own store as the place v1 is built and tested, and the standing approval of item 4. The rules this record keeps (item 5) are the ones the owner's words do not touch.
