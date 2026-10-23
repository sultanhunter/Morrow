# ADR-0026 Billing and price: Shopify App Pricing, confirmed credit blocks, caps in code and a rate card

- Status: Accepted 2026-10-23 (the owner, OD-2026-10-23-7: every owner question as recommended)
- Date: 2026-10-23
- Supersedes: ADR-0022 item 11's one credit per product, its weighting and the US$49 plan (summary items 10 and 11); the 2026-10-20 rollover amendment.
- Amends: ADR-0022 item 11 (USD caps become standing backstops), item 12 and summary item 5 (Stripe stays off), item 5 and its 2026-10-21 amendment (item 7), item 7 (broker credentials, item 9); ADR-0011 Q8 (extended to revoke, with ADR-0024); ADR-0015 items 1, 4 and 6 (only the Shopify route live); rule R10 of `billing-entitlements.md` (blocks).
- Implements: ADR-0023 decision 5, as billing option A amends it.
- Does not change: ADR-0015 items 2, 3, 5 and 7; rules R1 to R9 and R11; ADR-0005.
- Terms: the Owner, as in ADR-0024.
- Unblocks: P01.T04a, P11.T04, P14.T01, P18.T01, P18.T05; tracks T13 and the credit parts of T4, T7, T10 to T12, T17 and T18; gates G8, G11 (item 7), G13, G16.

## Context

The owner approved "yes to both, go with option A and specialists" (Q14). [App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing) has no one-time purchases, usage caps or subscription webhooks; the Partner API's `activeSubscription` shows the contract and usage. The [App Events API](https://shopify.dev/docs/api/app-events) takes a permanent idempotency key, validates after its `202` and cannot read an event back. `main` has the wallet, reservations, caps, `UsageCap`, `MeterEvent`, Stripe off, and 0035's operator test entitlement, which refuses store-linked workspaces.

## Decision

1. **One live route: App Pricing.** One monthly USD plan, no trial, and one usage meter, `extra_credits`. Plans change only on Shopify's hosted plan page, the only billing page Morrow links to. The Billing API only with Shopify's written agreement.
2. **Plan grant.** Credits come only from `BillingTerms` (R10), once per Shopify period, when a broker `activeSubscription` read shows the cycle started above $0. A redirect is never a source.
3. **Extra credits come in blocks, granted only after a confirmed usage record.**
   - (a) A block is a fixed number of credits at a fixed price, sent only when credits run low, the cycle's `UsageCap` covers it, the entitlement is active, no stop applies and the block switch is on.
   - (b) Each block is one OperationLedger operation, kind `shopify_usage`, sent only by the broker with a key derived from the operation id, resent only unchanged; one unconfirmed block per installation at most. It binds the cap's revision and digest, so a cap change voids an unsent block. Only billing code creates blocks.
   - (c) A `202` grants nothing. When a read shows the meter at the confirmed total plus this block, one transaction verifies the operation and writes one `usage_block` grant.
   - (d) A lost reply, `409`, `429` or `5xx` makes the block `uncertain`: `rejected` only on Shopify's failure status or a later read proving absence; otherwise no new blocks and an Inbox exception for the Owner, resolved under P18.T01c with per-action approval, never promoted.
   - (e) Runs that need an unconfirmed block wait: a person's run shows "waiting for credits", and a proactive trigger row stays pending and is retried at the next admission tick, never dropped (ADR-0024 item 6).
4. **Caps in code,** checked before dispatch under the wallet's row lock.
   - **Extra-credit cap.** `UsageCap` defaults to 0. Only `governance.billing.manage` (`human_only`, the Owner) raises it, up to the platform ceiling; agents and specialists may only propose.
   - **Runs** reserve their rate-card maximum and settle at metered use.
   - **Rate card v1 configuration,** lowerable by merchants, raised only by the Owner: per-installation daily and monthly caps; a per-workspace daily cap; the look-for-work cap (ADR-0024 item 6), at most 1% of the monthly grant per pass; specialists (ADR-0028), at most 5% of the grant per run and 20% per workspace per day.
   - **USD backstops** stand beside the rate card: US$7 of vendor cost per run and US$25 per workspace per day (owner question 6). ADR-0027 derives its turn limit from the per-run value.
   - **Failed runs** cost 0 credits and count toward the unrecovered-cost cap.
5. **A rate card replaces one credit per product.** `docs/decisions/rate-card.json` is versioned, digest-pinned data; a version publishes only with the owner's recorded confirmation. It meters model tokens per profile (Coordinator included), computer seconds and email sends, converted to whole credits once per run. **Free:** reads, monitors, approvals, the gateway's apply (still entitlement-gated), exports, deletion, stops, `workspace.routine.revoke`, sync and notifications; `verify:billing` adds a sibling of check PW2: revoke is never paid or entitlement-gated. **Margin:** each rate's vendor cost is at most 50% of the lowest net revenue per credit at a 17.9% fee (owner question 4). **Grant rule:** the launch agents' default load, measured on staging, uses at most 50% of the grant; if not, billing proposes lower default schedules and profiles for the owner's confirmation (ADR-0027 owner question 1) before the price moves.
6. **Price and parity.** The owner sets the price within US$99 to US$149 (owner question 1). One `BillingTerms` revision feeds the Partner Dashboard, the listing, the embedded home and any website price. Rollover follows owner question 2.
7. **Development and staging** (amends ADR-0022 item 5's "the MVP does not use `TestEntitlementSeed`"). A $0 development-store subscription grants nothing. Paid work there runs only under a `TestEntitlementSeed`: owner-run, capped, expiring, approved per use or under staging card 2. Its writer is T13's first PR, by W3; it is the G11 path and admits ADR-0027's loop runs before the rate card. 0035's operator test entitlement is retired: no new use once the seed writer merges, its command leaves in the T1 cleanup PR, and migration 0035 stays unchanged.
8. **Stripe stays off; ADR-0015's split is kept.** A website workspace is sent to install from Shopify. Switching Stripe on needs a new owner decision.
9. **Credentials and effects** (amends ADR-0022 item 7). The client secret, the App Events token and the Partner API credential are readable only by the broker. The block switch stays off until G10. The owner creates the plan, meter and API client under per-action approval.

## Security invariants touched

- **Checks in code:** items 3 and 4 (`lab:run-credits`, `test:billing`).
- **Unknown outcomes reconciled, never promoted:** item 3(d) (`lab:billing`).
- **Broker-only credentials:** item 9 (`verify:boundaries`, `lab:billing-workers`).
- **Default deny:** no terms, rate card or seed means no paid work (`verify:billing`, `edge:check`).
- **Client ids never authority:** the tenant comes from ADR-0025 item 2's linked installation (`lab:tenant-conformance`).
- **Cap binding:** a block binds the cap's revision and digest (`lab:billing`).
- **Money needs per-action approval:** usage records are authorised per cycle by the Owner's `human_only` `UsageCap`; the first production plan, meter and record are approved per action; the block switch stays off until G10 (`lab:billing`, `edge:check`).
- **Stops and revoke never billed:** ADR-0011 Q8 (`verify:billing` PW2 and its sibling).
- **Immutable migrations:** `migration-history.test.mjs`.

## Consequences

- Contracts gain `usage_block` grants, `ShopifyUsageKey` and `RateCard@1`; G8 asks Shopify whether blocks are acceptable usage charges.
- Risk: Shopify enforces no cap; single-flight sends and the row-locked cap bound overcharge.

## Alternatives considered

- **Usage in arrears:** credits spent before Shopify confirms anything.
- **One credit per product:** cannot price loops or computer time.

## Owner questions

1. **Price.** *Recommendation:* US$149 a month, provisional, confirmed by W8 from staging measurements.
2. **Rollover.** *Recommendation:* plan credits carry over one cycle; block credits last while subscribed.
3. **Blocks.** *Recommendation:* a block is 20% of the grant at the plan's price per credit; default cap 0; ceiling twice the plan price per cycle.
4. **Margin.** *Recommendation:* vendor cost at most 50% of net revenue per credit.
5. **If Shopify rejects blocks (G8).** *Recommendation:* ask for the Billing API and keep building.
6. **USD backstops.** *Recommendation:* keep US$7 per run and US$25 per workspace per day until staging measurements justify new values.

## Approval

The owner's statement in chat, verbatim, on 2026-10-23 (IST), after reading the decision sheet (`docs/decisions/decision-sheet-2026-10-26.md`) and a plain-language list of its questions numbered 1 to 31, with the other decisions numbered 32 to 38, each with its recommendation (OD-2026-10-23-7):

> approve all as recommended and user should be able to select model and thinking effor for each agent with the main agent set to opus 5.5 high by default and specialist at opus 5.5 medium for email the shop owner should be able to link there emails which will be used for any particual email job like suppose user linked multiple emails(our morrow email will be linked by defualt with user shop name, something like usershopname@morrow.com and selected by default unless user link there emails) and then whenever any email sending related prompt comes user should be able to select which email to choose for that, for now no need to develop the actual capability to link the email but architecture wise it should be like how i explained so we can just add the feature to link users email and it will show in the emails available to use list.

What it approves: this record as written and each owner question above with its recommended answer.
