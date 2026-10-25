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
   - **Runs** reserve their rate-card maximum and settle at metered use; for a loop run, the maximum is its turn limit times its catalogue entry's worst-case turn (ADR-0027 item 12).
   - **Rate card v1 configuration,** lowerable by merchants, raised only by the Owner: per-installation daily and monthly caps; a per-workspace daily cap; the look-for-work cap (ADR-0024 item 6), at most 1% of the monthly grant per pass; specialists (ADR-0028), at most 5% of the grant per run and 20% per workspace per day. Under the margin rule, 5% of the grant buys at most about US$3.06 of vendor cost at US$149 (US$2.03 at US$99). At the specialist default, Opus 5.5 at medium (US$0.56 a worst-case turn), that is at most 5 worst-case turns at US$149 and 3 at US$99, the last a final turn, and about four expected runs (US$0.73 each) at US$149, under three at US$99. At Opus 5.5 high a tool turn and a final turn need US$1.28, which fits at either price. The look-for-work cap, 1% of the grant, buys at most about US$0.61 at US$149 and US$0.41 at US$99. At US$149 the installed agents' default, Sonnet 5.5 at low, holds a tool turn and a final turn at the worst case (US$0.42) but not a third turn; Haiku 5.5 and Sonnet 5.5 at medium (US$0.56) also fit, and Sonnet 5.5 at high (US$0.64) and every Opus 5.5 entry (US$0.84 to US$1.28) do not. At US$99 only Haiku 5.5 fits, so no pass at the default is admitted. A run whose caps cannot hold one worst-case turn of its entry, or two for a run that must call a tool (a specialist, or a mandate run, look-for-work included), is not admitted (`cap_below_turn`, ADR-0027 item 12). With the price (owner question 1, by W8), the owner confirms the look-for-work cap's value, or a floor of two worst-case turns of the agent's entry.
   - **USD backstops** stand beside the rate card: US$7 of vendor cost per run and US$25 per workspace per day (owner question 6). ADR-0027 derives its turn limit from the per-run value; the dearest offered turn, Opus 5.5 at high, is at most US$0.64 (ADR-0027 item 12). A run holds the lowest of US$7, its rate-card maximum and its credit cap (a specialist's 5%, a look-for-work pass's 1%). A run whose remaining hold cannot cover another turn and a final turn ends with a final turn (`cost_budget`), settles at metered use and releases the rest. The daily backstop counts settled cost plus open holds and is checked at admission: a person's run that does not fit is refused with "Today's AI spending limit is reached", a specialist Start rolls back, and a proactive trigger stays pending for the next admission tick (ADR-0024 item 6), never dropped. Admitted runs keep their holds.
   - **Failed runs** cost 0 credits and count toward the unrecovered-cost cap.
5. **A rate card replaces one credit per product.** `docs/decisions/rate-card.json` is versioned, digest-pinned data; a version publishes only with the owner's recorded confirmation. It meters model tokens per catalogue entry, a model and an effort (ADR-0027 item 12; the Coordinator included), computer seconds and email sends, converted to whole credits once per run. Each entry has a rate per million tokens of each kind (input, cache write, cache read, and output with thinking) and its worst-case turn in credits; an entry without a rate is refused at admission. **Free:** reads, monitors, approvals, the gateway's apply (still entitlement-gated), exports, deletion, stops, `workspace.routine.revoke`, sync and notifications; `verify:billing` adds a sibling of check PW2: revoke is never paid or entitlement-gated. **Margin:** each rate's vendor cost is at most 50% of the lowest net revenue per credit at a 17.9% fee (owner question 4). Rates follow the model's token prices, so the margin holds whatever model and effort a shop chooses; the effort changes only the worst case, the holds and the estimate the picker shows. **Grant rule:** the launch agents' default load, measured on staging, uses at most 50% of the grant; if not, billing proposes lower default schedules and profiles for the owner's confirmation (ADR-0027 item 12, whose defaults the owner set) before the price moves.
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
- **Rules added after the owner's answer.** On 2026-10-23, after the owner's answer (OD-2026-10-23-7), items 4 and 5 were extended to carry out ADR-0027 item 12: a loop run's rate-card maximum is its turn limit times its entry's worst-case turn; a run holds the lowest of US$7, that maximum and its credit cap; a run that cannot cover another turn and a final turn ends with a final turn (`cost_budget`); the daily backstop counts settled cost plus open holds at admission, refusing a person's run, rolling back a specialist Start and leaving a proactive trigger pending; admission needs one worst-case turn, or two for a run that must call a tool (`cap_below_turn`); each catalogue entry has a rate per token kind and a worst-case turn, and an entry without a rate is refused; and the cap arithmetic at US$99 and US$149. No approved number changed: US$7, US$25, 1%, 5%, 20%, the extra-credit cap of 0 and the 50% margin at a 17.9% fee stand. These rules await the owner's confirmation with rate card v1's publication (item 5), and the look-for-work cap's value with the price (item 4).

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

## Amendments

### 2026-10-25: item 4's failed runs and the installed agents' default (ADR-0036)

The owner's decision of 2026-10-25 (OD-2026-10-25-1, recorded in ADR-0036) changes these lines; the text above is kept as approved. Failed runs still cost 0 credits; their cost is recorded and counts toward no cap, since the unrecovered-cost cap is removed. The installed agents' default becomes Opus 5.5 at medium, so at either price no look-for-work pass at the default fits the 1% cap (two worst-case turns cost US$1.12); the owner set that cap's new value the same day (the next note). The US$7 and US$25 backstops stand.

### 2026-10-25: item 4's look-for-work cap becomes US$1.12 per agent per day (ADR-0036 item 7)

The owner's answers of 2026-10-25 (OD-2026-10-25-2, recorded in ADR-0036) change these lines; the text above is kept as approved. The look-for-work cap is no longer 1% of the monthly grant per pass: it is US$1.12 of worst-case vendor cost per agent per day, two worst-case turns at the installed default, Opus 5.5 at medium, whatever the plan price. A pass at the default holds US$1.12; a profile whose two worst-case turns exceed it (Opus 5.5 at high, US$1.28) is `cap_below_turn`, and a second pass the same day is refused (one pass per agent a day, ADR-0024 item 6). Item 4's arithmetic for the 1% cap (US$0.61 at US$149, US$0.41 at US$99, and which entries fit it) no longer applies to look-for-work, and its open question on that cap's value or floor is answered. The rate card's look-for-work cap is a USD amount (RateCard@1's `caps.lookForWorkDailyUsd`), still lowerable by merchants and raised only by the Owner. The owner also kept the US$7 per-run and US$25 per-workspace daily backstops unchanged (owner question 6). The specialist caps, 5% of the grant per run and 20% per workspace per day, stand.

### 2026-10-25: the specialist caps retire with the specialist kind (ADR-0037)

The owner's decisions of 2026-10-25 (OD-2026-10-25-3 and OD-2026-10-25-4, recorded in ADR-0037 item 6) end the specialist kind, and item 4's specialist caps (5% of the monthly grant per run, 20% per workspace per day) retire with it; the text above is kept as approved. They do not carry over to workspace-created agents, whose runs, like every run, reserve and draw credits from the workspace's balance. "A specialist Start rolls back" no longer applies: a teammate call that the balance cannot cover at once, or that would wait for credits (item 3 (e)), is refused at once and Morrow receives the refusal code (ADR-0037 item 3(a)). OD-2026-10-25-4 also makes credits the only spend limit for every run; ADR-0039 records what that removes from item 4.
