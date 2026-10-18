# Billing ownership decision

Owner: Morrow platform owner. P01.T04 recorded the original design on 6 October 2026 with Shopify App Pricing as the only route. ADR-0015 (Owner approval, 2026-10-18) replaces that single route with two routes chosen by origin and supersedes ADR-0006. This record restates the rules for both routes. No merchant price, payment, provider account or charge is activated.

## Two billing routes (ADR-0015)

| | Morrow-direct | Shopify |
| --- | --- | --- |
| Who | A workspace created by signup on the Morrow website that pays before it links any store | Every other paying workspace: one created through a Shopify install, or a website workspace that links a store before it has paid |
| Where the merchant pays | Morrow's own checkout | Shopify App Pricing, on the shop installation |
| Provider | Stripe Billing with Stripe Tax; Morrow is the seller | Shopify; the Partner Program Agreement applies |
| Payer | The workspace's Morrow billing account: one Stripe customer and subscription per workspace, covering work across its linked stores | Each shop installation's own App Pricing subscription |
| Never | Charged through App Pricing for Morrow work | Shown or able to reach Morrow checkout, plan selection, upgrade, credit purchase or the billing portal |

- **The route is fixed at the first completed payment and never changes.** It is held server-side and is unset until then. Clients, return URLs, query values and plan handles never set or prove it. A Morrow-direct first payment counts only after Morrow verifies it from Stripe (a verified webhook plus a readback of the object). Moving a paying workspace to the other route needs a new owner decision.
- **Pay first, then connect.** On the website, a workspace without a route is offered checkout before "connect a store". A website workspace that links a store before paying gets the Shopify route at its first payment, and Morrow checkout is withdrawn. A free account is not an existing paid relationship.
- **Separation is enforced by the server.** The API refuses to create checkout, plan, upgrade, credit-purchase and portal sessions for a workspace whose route is Shopify, or that has no route and has ever had a store linked (`shopifyBoundAt` set; disconnecting the store does not clear it). Morrow's checkout and pricing pages are not linked from the Shopify app, its listing or the connector screens.
- **Same tiers.** Both routes offer the same plans and credit packages. On the Shopify route they must fit App Pricing: extra credits use usage meters (App Pricing has no one-time purchases), and Morrow enforces its own spending caps (App Pricing enforces none). Prices and credit quantities are open for P18.

## Payer and ownership rules (both routes)

Morrow is paid, supplies managed model APIs and uses one work-credit balance per payer. There is no free merchant tier. Shared organizations expose only authorized accounts. Organization or workspace membership never creates pooled subscriptions, and shared entitlements never confer data authority. Multi-store work declares exact payer shares: on the Shopify route each share names an installation, and there is no silent pooling or charge to an unrelated shop; on the Morrow-direct route the workspace's billing account is the one payer. Connector identity cannot execute workspace domain work.

Paid dispatch needs current actor and store authority, a qualified provider and data policy, an active entitlement on the workspace's route, a qualified published rate and cost schedule, an exact reviewed allocation and atomic credit, merchant-money and vendor-money reservations. Rates price complete work. Enterprise commitments require costed terms; persistent service costs do not disappear when credits expire. Economics qualification includes measured workloads, discounts and bounded low-token runtime costs.

**Pre-payment state (ADR-0015 item 5).** A workspace without a completed payment may sign up, set up, invite members, manage membership and grants, onboard and connect non-Shopify identity. It cannot dispatch paid work (model, connector-write or execution work that reserves credits). Reads, approvals of already-reserved work, exports and kill switches continue regardless of balance or entitlement.

## Entitlement, usage and settlement

Server-side subscription evidence controls entitlement: an active Stripe subscription for a Morrow-direct workspace, or an active App Pricing subscription on the installation for the Shopify route. Usage and invoices are separate. Reserve before dispatch; retain unknown outcomes; settle once. Morrow's credit ledger is the authority for available, reserved and settled credits on both routes.

- **Morrow-direct.** Stripe's billing-credit feature is not the work-credit ledger: it applies only to metered prices at invoice finalisation, has no hold before dispatch and may not be stored value. Purchased credits are granted after Stripe confirms payment (`invoice.paid`). Every Stripe write carries an idempotency key bound to its OperationLedger operation; webhooks are signature-verified in the broker over the raw body, deduplicated by event ID and reconciled by readback, because Stripe retries for up to three days in no order. Stripe keys and webhook secrets bind only to the broker (Security invariant 11) and wait for the P08.T02 trust model (ADR-0007 item 4).
- **Shopify.** Meter events bind the original subscription rather than rewriting historical usage on upgrades. With App Pricing, do not use legacy subscription-creation helpers. P18 pins the exact Partner and AppEvents API, meters and rates, and the no-charge development tests. [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- **Tax.** On the Morrow-direct route Morrow is the seller of record. It registers for, collects, files and remits sales tax and VAT where required, with a tax advisor; Stripe Tax calculates and collects, and its "Register for me" service does not file. On the Shopify route the charge appears on the merchant's Shopify invoice, and Morrow needs its Shopify Partner payout and tax profile; the tax treatment of Shopify payouts is part of the tax advisor's brief.

## Cancellation, removal and liabilities

Cancellation stops new paid work. On the Shopify route, uninstall also revokes that shop's connection, and other authorized shops continue. On the Morrow-direct route, disconnecting a store is not a subscription cancellation, and cancelling the subscription does not disconnect stores. Unsent reservations release; uncertain and incurred liabilities reconcile. Export, deletion and privacy remain separate. Refund, expiry, rollover, renewal, proration and rounding are explicit pre-charge gates.

## Unresolved activation and launch gates

| Gate | Owner | Prerequisite/evidence | Blocks |
| --- | --- | --- | --- |
| Connector distribution/UI classification | Morrow platform owner | Runnable connector, onboarding/handoff/status and applicable review result | P09 public activation/P18 launch |
| Shopify App Review of the split model | Morrow platform owner | Server-enforced separation, test instructions that explain the split, reviewer install path reaching only App Pricing (P18.T05) | Shopify App Store listing; P18 launch |
| Shopify route billing account/API access | Morrow platform owner | Registered app/client, pinned API/meter, no-charge development tests/current permissions; Shopify Partner payout and tax profile | Shopify-route billing activation |
| Stripe account and live activation | Morrow platform owner | Stripe account (test mode when the payments packet starts); legal business entity and bank account before live mode; approved packet and per-action approvals | Morrow-direct billing activation |
| Sales tax and VAT | Morrow platform owner | Tax advisor; registrations where required; Stripe Tax configuration; filing plan | Morrow-direct live charging |
| Revenue scope/fees/reporting | Morrow platform owner | Written answer on whether Morrow-direct revenue from merchants who connect the app is App Revenue under the Partner Program Agreement; explicit treatment | Morrow-direct commercial launch |
| Work rates/terms/economics | Morrow platform owner | Measured workloads, fixed-service coverage, discount/enterprise/margin review and renewal/refund terms | Published prices/real charging |
| Durable ledger/reconciliation | Morrow platform owner | P06/P11/P12 transaction/fault evidence; P18 account/subscription/event tests on both routes | Real paid work/invoices |

Staff guidance on genuine existing paid customers of an independent SaaS is an input to App Review, not a Morrow grant. Free signup alone does not qualify, and Shopify has published no test of whether a completed payment is required; ADR-0015 takes the conservative reading (a completed payment before any store link). A 2026-09-17 rejection of an app that combined App Pricing with off-platform billing is recorded in ADR-0015 as Risk 1. [Shopify support clarification](https://community.shopify.dev/t/does-a-split-billing-model-satisfy-1-2-1-shopify-origin-installs-billing-api-pre-existing-platform-customers-direct-billing/36909), [Separate billing paths](https://community.shopify.dev/t/billing-requirement-1-2-separating-app-store-installs-shopify-pricing-from-preexisting-saas-customers-stripe/35728)

Agreement scope, fee and reporting obligations are separate from UI and provider choice. Placing checkout in Morrow does not establish zero app-related fees; until the revenue question is answered, economics assume the Shopify share on both routes. [Shopify Partner agreement](https://www.shopify.com/partners/terms), [App Store requirement 1.2](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
