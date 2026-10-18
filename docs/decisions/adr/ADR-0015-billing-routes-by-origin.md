# ADR-0015 Billing routes by origin: Morrow checkout on Stripe Billing and Stripe Tax, Shopify App Pricing for Shopify-origin merchants

- Status: Accepted
- Date: 2026-10-18
- Supersedes: ADR-0006 (billing state before any Shopify store is installed)
- Affects: P01.T04a, P05.T01x (pre-payment wording), P09.T01 and the P09 billing webhook topics, P11.T04, P14.T01, P18.T01, P18.T05, Security invariant 11 and the new plan invariant 24 (server-held billing route), `docs/decisions/billing-ownership.md`, `docs/decisions/providers.json`, `docs/contracts/billing-entitlements.md` (through P01.T04a)

## Context

- **Settled constraints.** Morrow is paid, supplies managed model APIs and keeps one work-credit balance, with no free merchant tier. External billing and revenue treatment are qualified launch gates.
- **ADR-0006.** It made paid work depend on a linked shop installation with an active Shopify App Pricing subscription. It left any direct (non-Shopify) route as a pending owner decision and recorded that, until then, Morrow had no payments provider.
- **The owner's direction.** The owner asked for purchases and pricing to live on Morrow's own website, with the Shopify app only as the connection to the store (quoted under Approval).
- **Shopify App Store requirement 1.2** ([App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), read 2026-10-18; the page shows no last-updated date):

  > Apps that use off-platform billing cannot be distributed through the Shopify App store, unless you've been notified otherwise by Shopify. Your app must use Shopify App Pricing or the Shopify Billing API for all app charges and be free of billing related errors.

  - The rule binds listed and unlisted public apps alike. Custom distribution serves one merchant (or one Plus organization) and cannot use Shopify billing, so it does not fit a product sold to many brands ([distribution](https://shopify.dev/docs/apps/launch/distribution)).
  - Shopify staff wrote on 2026-04-02 that "limited visibility exemptions are no longer being granted", reaffirmed it on 2026-06-26 and 2026-07-16 ([thread 32021](https://community.shopify.dev/t/unlisted-public-app-is-shopify-billing-api-mandatory-or-can-we-use-stripe/32021)), and wrote on 2026-09-02 that "A multi-platform SaaS that owns its own billing isn't typically one of those cases" ([thread 37159](https://community.shopify.dev/t/paused-under-1-2-1-although-the-shopify-connector-is-already-on-app-pricing/37159)).
- **Staff guidance on a split by origin** (forum guidance, not a contract):
  - 2026-07-03: "you do not need to request permission in this case, however your app can fail review if it's possible for a shopify merchant to install your app in the app store and reach your stripe billing flow" ([thread 35728](https://community.shopify.dev/t/billing-requirement-1-2-separating-app-store-installs-shopify-pricing-from-preexisting-saas-customers-stripe/35728)).
  - 2026-04-22: a merchant who signs up and pays on the developer's website, then installs the public app, "would be an existing client and they can keep their billing with you" ([thread 32868](https://community.shopify.dev/t/clarification-on-billing-requirements-app-using-stripe-for-subscription-one-time-charges/32868)).
  - 2026-08-20: tie the carve-out "to an existing paid subscription/billing relationship, rather than simply an account that was created for free"; the path "should be fixed and fully separated"; "App Review would make the final decision". On 2026-09-07 staff added that no published test says whether a completed payment is required ([thread 36909](https://community.shopify.dev/t/does-a-split-billing-model-satisfy-1-2-1-shopify-origin-installs-billing-api-pre-existing-platform-customers-direct-billing/36909)).
  - 2026-05-08: keep the origin server-side and detect existing direct customers "to avoid double billing" ([thread 34000](https://community.shopify.dev/t/off-platform-billing-shown-to-shopify-merchants-during-onboarding/34000)).
- **App Pricing limits** ([Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)): no one-time purchases; at most five usage meters per plan, billed monthly; no usage caps; USD prices only; eight public plans and unlimited private plans. The Billing API is legacy since 2026-05-12.

## Decision

1. **Two billing routes, chosen by origin.**
   - **Morrow-direct.** A workspace created by signup on the Morrow website (ADR-0009) pays on Morrow's own checkout and then connects its stores. The payment provider is **Stripe Billing** (subscriptions, invoices, payments) with **Stripe Tax** (tax calculation and collection). Morrow is the seller.
   - **Shopify.** Merchants who arrive from Shopify get the same tiers through Shopify App Pricing and never see Morrow's checkout.
2. **The route is fixed at the first payment.**
   - Each workspace has exactly one billing route, held server-side. It is unset until the workspace's first completed payment and never changes afterwards. Clients, return URLs, query values and plan handles never set or prove it.
   - The route is **Morrow-direct** only when a workspace created on the website completes Morrow checkout **before any store is linked to it**. Completion means a payment Morrow has verified server-side from Stripe (a verified webhook plus a readback of the object), never a redirect.
   - The route is **Shopify** for every other paying workspace: a workspace created through an install, and a website workspace that links a store before it has paid. A free account is not an existing paid relationship (staff guidance, 2026-08-20).
   - Moving a paying workspace to the other route needs a new owner decision. Nothing moves it automatically.
3. **Separation.**
   - A workspace whose route is Shopify, or that has a linked store and no route, never reaches Morrow checkout, plan selection, upgrade, credit purchase or the billing portal. The API refuses to create those sessions for it, and the UI does not render them.
   - Morrow's checkout and pricing pages are not linked from the Shopify app, its listing or the connector screens.
   - A Morrow-direct workspace's stores are never charged through App Pricing for Morrow work, so no merchant pays twice. How such a store's installation passes Shopify's plan step without a charge is a P18 design item, checked against current App Store guidance before submission.
4. **The same tiers on both routes.** Both routes offer the same plans and credit packages. Prices and credit quantities remain open for P18, as under ADR-0006. On the Shopify route, plans and extra credits must fit App Pricing: extra credits use usage meters, because App Pricing has no one-time purchases, and Morrow enforces its own spending caps, because App Pricing enforces none. If a tier cannot be expressed in App Pricing, P18 records the difference for an owner decision.
5. **Pre-payment state (replaces ADR-0006).**
   - A workspace without a completed payment may sign up, set up the workspace, invite members, manage membership and grants, complete onboarding and connect non-Shopify identity such as SSO later.
   - It **cannot dispatch paid work**: model, connector-write or execution work that reserves work credits. Paid work needs both:
     1. an active entitlement on the workspace's fixed route: for Morrow-direct, the workspace's Stripe subscription is active as verified server-side; for Shopify, a linked installation has an active App Pricing subscription;
     2. a credit balance that covers the reservation.
   - Reads, approvals of already-reserved work, exports and kill switches continue regardless of balance or entitlement (ADR-0011 Q8).
   - On the website, a workspace without a route is offered checkout before "connect a store". If a store is linked to it first, from Shopify's side, its route becomes Shopify at its first payment and Morrow checkout is withdrawn.
6. **Payer and credits.**
   - Shopify route: unchanged. Each shop installation owns its App Pricing subscription; multi-store work declares explicit allocations and never silently charges another shop.
   - Morrow-direct route: the workspace's Morrow billing account (one Stripe customer and subscription per workspace) pays for work across its linked stores. Organization membership and other workspaces do not pool it.
   - Morrow's own credit ledger (the P01.T04 contracts, enforced in P11.T04) stays the authority for available, reserved and settled credits. Stripe's billing-credit feature is not used as that ledger: it applies only to metered prices at invoice finalisation, has no hold before dispatch and may not be offered as stored value. Purchased credits are granted only after Stripe confirms payment (`invoice.paid`), following Stripe's prepaid pattern.
7. **Credentials, idempotency and tax.**
   - Stripe API keys and webhook signing secrets are provider credentials: they bind only to the broker Worker (Security invariant 11). Under ADR-0007 item 4 they wait for the P08.T02 broker trust model and the package 8 credential-custody ADR.
   - The broker verifies webhook signatures over the raw body. Events are deduplicated by event ID. Stripe retries delivery for up to three days in no guaranteed order, so state is reconciled by reading the object back, never from event order.
   - Every Stripe write carries an idempotency key bound to its OperationLedger operation identity; Stripe keeps keys for at least 24 hours. An unknown outcome is reconciled before any retry.
   - Morrow is the seller of record. It registers for, collects, files and remits sales tax and VAT where required, with a tax advisor. Stripe Tax calculates and collects; its "Register for me" service does not file or remit. A seller outside the EU may owe EU VAT from its first sale there.
8. **No effects now.** This ADR creates no Stripe account, test-mode object, product, price, webhook endpoint, tax registration, payment or provider call. Each needs an approved packet and a per-action owner approval (CLAUDE.md, "Provider and live effects").

## Consequences

- **ADR-0006 is superseded.** P01.T04a is re-scoped to the pre-payment state and both routes. Its acceptance cases must cover at least:
  - paid dispatch denied before the first payment, while setup, invitations and onboarding work;
  - a website workspace becomes billable only after server-verified Morrow checkout;
  - a Shopify-origin workspace becomes billable when a linked installation's App Pricing subscription is active;
  - the route never changes after the first payment, and a client cannot set it;
  - a Shopify-route workspace, and a website workspace that linked a store before paying, cannot create a checkout, plan, upgrade, credit-purchase or portal session;
  - linking a store to a Morrow-direct workspace creates no App Pricing charge for Morrow work;
  - multi-store allocation on each route.

  P11.T04 enforces them and P18.T01 qualifies both routes.
- **Other references.** ADR-0009 item 7, ADR-0011 Q8 and the P05.T01x, P06.T01a, P01.T02a and P04.T02a packets refer to ADR-0006. Those references now read as this ADR's pre-payment state. Their checks are unchanged, because each asserts only that nothing paid happens before billing exists.
- **Provider register.** Stripe (Billing and Tax) is added to `docs/decisions/providers.json` as selected and blocked, under the billing decision D21.
- **Owner actions and launch gates.** None blocks local engineering.
  - A Stripe account in test mode when the payments packet starts.
  - Before live activation: a legal business entity, a bank account, a tax advisor, and tax registrations where required.
  - For the Shopify route: the Shopify Partner payout and tax profile.
  - The Shopify App Review outcome for this model (Risk 1).
  - The revenue-share clarification (Risk 2).
- **App Review evidence (P18.T05).**
  - The review notes explain the split at the top of the test instructions.
  - The reviewer's install path reaches only App Pricing.
  - The listing and in-app copy do not suggest that Shopify merchants are billed elsewhere.
  - The submission includes evidence that the server refuses checkout to Shopify-route workspaces.
- **Economics.**
  - Morrow-direct: Stripe Billing costs 0.7% of billing volume ([Stripe Billing pricing](https://stripe.com/us/billing/pricing)), and Stripe Tax US$0.50 per transaction where Morrow is registered ([Stripe Tax pricing](https://stripe.com/us/tax/pricing)), plus card processing fees. The research could not confirm the US card rate.
  - Shopify route: a 2.9% processing fee, and 15% of App Revenues above the first USD 1 million (the 0% tier has eligibility conditions).
  - The plan's conservative 17.9% billing-fee assumption stays for both routes until Risk 2 is resolved.
- **Documents.** `billing-ownership.md` describes both routes, and the plan's billing sections, P18 tasks, launch gates and Next work follow this ADR.

## Risks

1. **App Review may reject the model.** In [thread 37764](https://community.shopify.dev/t/app-review-rejected-for-using-stripe-for-off-platform-acquisitions/37764) (2026-09-17), a reviewer rejected an app with the note "While screening the application we notice that the app uses combination of Shopify App Pricing and off-platform billing".
   - The reviewer had created a new account on the developer's website without installing the app. The app was suspended until 30 September, and the case is unresolved.
   - That developer kept website sign-ups on Stripe even when they connected Shopify later. The thread does not say whether those sign-ups had paid before installing.
   - Mitigations: pay before connecting, a server-held route, separated surfaces, and test instructions that explain the split.
   - If Shopify still rejects the model, the fallback is to bill every workspace that connects a Shopify store through App Pricing and keep Morrow checkout only for workspaces that never connect one. That fallback needs a superseding owner decision.
2. **Revenue share is unresolved.** The Partner Program Agreement says: "An App Developer owes Shopify fifteen percent (15%) of the total revenues from the sale of, subscription to or charges relating to or passing through the App Developer's Public Applications" ([Partner agreement](https://www.shopify.com/partners/terms)).
   - Whether Morrow-direct revenue from merchants who connect the app counts is not settled. Staff called it "a separate topic from the billing requirement itself" ([thread 35773](https://community.shopify.dev/t/can-an-unlisted-public-app-bill-clients-off-platform-or-is-shopify-billing-required/35773)).
   - In 2016, developers allowed to keep external billing still had to remit a share.
   - Owner action: get a written answer from Shopify Partner support, and legal or tax advice, before launch. Until then the economics stay conservative.
3. **Guidance is not a contract.** Staff forum replies can change. Delisting can arrive without warning: "advance warning isn't guaranteed" (2026-10-13). P18 re-confirms the requirements during release preparation.
4. **The "existing paid" bar is unpublished.** This ADR takes the conservative reading: a completed payment before any store is linked.
5. **Seller-of-record duties.** Morrow carries tax registration, filing and remittance. The tax advisor is a launch gate.
6. **Embedded-experience review is separate.** Requirement 2.2.2 and the connector UI classification remain their own launch gate. The 2026-07-31 staff reply that a split "lines up with requirement 1.2.1" ([thread 36474](https://community.shopify.dev/t/split-billing-for-a-multi-channel-saas-does-a-shopify-billed-path-for-app-store-installs-satisfy-1-2-1/36474)) addressed billing only.

## Alternatives considered

- **App Pricing for everyone (ADR-0006 unchanged).** Compliant, but every customer pays through Shopify and Morrow cannot bill customers on its own.
- **Morrow checkout for everyone, with a free connector app** (the owner's first request). It contradicts requirement 1.2 for a public app. Exemptions are no longer granted, and on 2026-06-18 staff said that an external paid credit wallet behind a free connector would need an exemption they could not guarantee ([thread 35277](https://community.shopify.dev/t/billing-requirement-1-2-free-connector-app-for-a-standalone-non-shopify-exclusive-saas-with-external-subscription/35277)).
- **Custom distribution.** One merchant per app; not viable.
- **Other payment providers.**
  - Paddle as merchant of record: 5% plus 50¢, no client idempotency keys, and usage billing in beta.
  - Stripe Managed Payments as merchant of record: 3.5% on top of processing, an eligibility review that excludes professional services, and Checkout and Payment Links only.
  - Lemon Squeezy: being folded into Stripe Managed Payments.

  The owner chose Stripe with Stripe Tax.

## Approval

Owner approval, 2026-10-18, in chat.

1. **Billing direction.** The owner first said: "i want the purchase/pricing to be done on our sass instead of the shopify plugin, plugin is just medium to connect to the store". After the research on App Store requirement 1.2 (above), the owner selected **"Split by origin (Recommended)"**:

   > Website signups pay on Morrow (your checkout), then connect their store. Merchants who arrive from Shopify get the same tiers through Shopify App Pricing and never see Morrow's checkout. Fully compliant, with your own billing for most customers.

2. **Payment provider.** The owner selected **"Stripe + Stripe Tax (Recommended)"**:

   > About 0.7% for Stripe Billing plus card fees. Strong idempotency and a Workers-compatible SDK. Morrow is the seller, so you register for and file sales tax/VAT with a tax advisor. Needs a business entity and bank account.

Scope of the approval:

- **Decided by the answers:** items 1 and 4 (the two routes and the same tiers) and the seller and tax part of item 7 (Stripe Billing with Stripe Tax, Morrow registering and filing with a tax advisor). The credential and idempotency parts of item 7 apply Security invariants 10 and 11 and ADR-0007.
- **Following from them:** item 2 makes "pay on Morrow, then connect their store" exact, taking the conservative reading of the staff guidance (a completed payment before any store link). Item 3 implements "never see Morrow's checkout". Items 5 and 6 carry the ADR-0006 rules and the billing-ownership rules over to two routes. Item 8 restates the existing provider rules.
- **Not established by the answers:** "Fully compliant" in the option text is the recommendation's claim, not a Shopify determination; App Review decides (Risk 1).
- **Pending:** the Stripe account, test mode, live activation, tax registrations, business entity and bank account are owner actions and launch gates. Nothing is created now.
