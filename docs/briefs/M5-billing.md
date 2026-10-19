# M5 Billing

- Status: brief, 2026-10-19 (revised after critique). Spine: [mvp-architecture.md](mvp-architecture.md) §2 steps 1–3, §4, §9. Material choices: ADR-0022 items 2, 3, 5, 11, 12 and 13 (accepted 2026-10-19). Rules: ADR-0015 and its follow-ups; `docs/contracts/billing-entitlements.md` (P01.T04a).
- Plan IDs: P18.T01a (Morrow-direct Stripe route, test mode), with persistence items 1 and 3–8 of `billing-entitlements.md` (items 10 and 11, held payments and reversals, at M6). Branch `claude/m5-billing`, from M2 PR-1; two PRs.

## Goal

A website workspace picks the beta plan, pays through Stripe Checkout in test mode, and becomes billable only when Morrow has verified the payment server-side. Morrow then fixes its route to `morrow_direct`, grants the plan's credits to its wallet, and shows plan, credits and usage. Staging uses this path too (there is no test seed). Live mode waits for M6.

## Scope

- **PR-1, server:** `governance.billing.manage` and the signup template v2 backfill; the M5 `morrow_billing` tables (spine §6); the route-row writer in the signup transaction; the purchase guard and routes; Stripe operations (kind `stripe_write`, `taskId` null) on the M2 `operations` table; the webhook route; broker `stripeCustomerEnsure`, `stripeCheckoutCreate`, `stripePortalCreate`, `stripeWebhookVerify` on one pinned API version; payment classification, entitlement fold and credit grants.
- **PR-2, screens:** `/w/:ws/settings/billing` (plan, status, "Choose plan", "Manage billing") and `/w/:ws/settings/usage` (credits available, reserved and used; runs and their charges). Every purchase link and wording comes from `billingCallToAction`.

## Non-goals

Shopify App Pricing; top-ups, coupons, trials, proration and plan changes; dunning email; automated conflict remediation (P18.T01c); invoices inside Morrow (the portal shows them). Moved to M6, before live money: refunds, disputes, held-payment handling and `payment_reversals`, and Stripe Tax registrations (or Managed Payments).

## Interfaces and data touched

- **Reused (`packages/policy/src/billing-state.ts`):** `originForCreation`, `workspaceBillingState`, `purchaseDecision`, `billingCallToAction`, `stripePaymentKind`, `mapProviderStatus`, `classifyPayment`, `foldEntitlementEvidence`, `entitlementFor`, `parseBillingTerms`, `BILLING_DENIAL_ENVELOPES`. Contracts: `WorkspaceBillingRoute`, `BillingAccount@2`, `EntitlementSnapshot@2`, `CreditGrant@2`, `VerifiedPaymentEvent`, `BillingTerms`, `StripePaymentKey`, `StripeSubscriptionKey`, `StripePriceKey` (billing v1.1); `CreditWallet` (v1); `Operation@2`.
- **Routes (under `/workspace/:ws/billing/morrow/`, as P18.T01a requires):** `GET /workspace/:ws/billing` (`view` on `governance.billing.manage` or `governance.usage.read`); `POST .../checkout` `{priceKey}` with an `Idempotency-Key` (returns the Stripe-hosted URL); `POST .../portal`. Public: `POST /api/billing/stripe/webhook` (raw body, no session; under `reservedWorkerPaths`).
- **Terms:** one `BillingTerms` revision with the beta price key, kind `subscription_period`, USD 49 and 300 credits.
- **Field mapping on the pinned version:** the invoice's subscription and metadata from `invoice.parent.subscription_details`; the price from line-item `pricing.price_details.price`; the period end from the subscription item; cancellation from `cancel_at` as well as `cancel_at_period_end`. `mapProviderStatus` is fed accordingly.

## Flow

1. **Signup:** the creating transaction writes the route row with origin `website` (persistence item 1). Existing workspaces are backfilled `website`.
2. **Checkout:** `purchaseDecision` must allow `morrow` in phase `open` with no `shopify_bound_at`; `execute` on `governance.billing.manage`. Under the route-row lock, close any open intent past its `expires_at`, then record a checkout intent (one open per workspace) and its operation. The broker loads the operation, ensures the mapped customer (idempotency key bound to its operation), and creates a subscription-mode session with `customer` (never `customer_email`), the price from `BillingTerms`, `expires_at` one hour ahead, and the operation and workspace ids in both `metadata` and `subscription_data.metadata`. Billing address collection and `automatic_tax` follow configuration (off in test mode). The success return proves nothing.
3. **Webhook:** the api passes the raw body and `Stripe-Signature` unparsed to `stripeWebhookVerify`. The broker verifies over the raw bytes (5-minute tolerance), checks `livemode` and the account, de-duplicates by event id, reads the object back, and records a `stripe_event_receipts` row with the object digest.
4. **Apply:** the api applies only a receipt the broker recorded with a matching digest. `classifyPayment` decides, with the operation id read from the invoice's subscription metadata. On the first paid invoice (`billing_reason` `subscription_create`) of a `subscription_period` in phase `open`, Morrow fixes the route to `morrow_direct`, creates the account, writes the `VerifiedPaymentEvent`, and grants credits once per `(route, mode, paymentKey)` to the wallet in the same commit. A held, unattributed or mismatch outcome is recorded on the receipt and logged for the owner. Subscription updates fold through `foldEntitlementEvidence`. `checkout.session.expired` closes its intent. The handler returns 200 after commit; an unknown commit is read back before any acknowledgement.
5. **Portal:** a session on the mapped customer, through the saved portal configuration (its id in configuration). Cancellation folds to `active` until the period ends, then `cancelled`.

## Security notes

- **Broker-only credentials (invariant 11):** the restricted key and webhook secret bind only to the broker; `mapApiEnvironment` rejects `STRIPE_` bindings on the api.
- **Ids only across RPC:** every Stripe method takes an operation id; the broker loads the customer mapping, price and metadata from the database.
- **Server-held route:** clients, return URLs, metadata and price keys never set the route; a workspace with `shopify_bound_at` never reaches checkout.
- **Reconcile before retry (invariant 10):** every Stripe write carries an idempotency key bound to its operation; on an unknown outcome the broker reads back first and replays with the same key only after proving absence, within 23 hours (persistence item 6).
- **Credits only from confirmed payment:** grants come from `BillingTerms` and a read-back paid invoice, never from Checkout success or a client.
- **Tenant from mapping:** the event's workspace comes only from the customer mapping, cross-checked with the operation in the subscription metadata.

## Test checklist

- [ ] The P01.T04a decision tables (`classify-payment`, `purchase-decision`) run against the persisted path.
- [ ] Recorded fixtures on the pinned version: a real `invoice.paid` (`subscription_create`) resolves its operation through `parent.subscription_details.metadata`; a cancellation via `cancel_at` folds correctly.
- [ ] Webhook: bad signature, stale timestamp, wrong mode or account, duplicate event, `invoice.paid` before `checkout.session.completed` → correct and idempotent.
- [ ] A payment verified after a store link → `ROUTE_MISMATCH` recorded; never `morrow_direct`.
- [ ] Concurrent checkouts → one open intent; an expired session (event, or the lazy close) → a new checkout works; double `invoice.paid` → one grant.
- [ ] Unknown Stripe outcome: readback before replay; never a new idempotency key.
- [ ] Billing and usage screens: call to action only from `billingCallToAction`; axe at the four widths.
- [ ] An end-to-end lab with recorded Stripe fixtures, then a test-mode smoke under owner approval with a `docs/evidence/live/` record.

## Owner actions

1. A Stripe account in test mode; a restricted key with the ADR-0022 item 12 permissions (checked against the exact calls in the sandbox) and the webhook signing secret, placed with `morrow_put`.
2. Create the beta Product and Price in test mode with Claude's exact settings (including tax code and behaviour), or approve Claude creating them per action.
3. Save the customer portal configuration in test mode: invoice history and payment-method update on, subscription update off, cancel at period end. Repeat at live activation.
4. Done: the beta plan is US$49 a month with 300 credits (owner, 2026-10-19; ADR-0022 item 11).
5. Before live mode (M6): business entity, bank account, tax advisor and registrations (or the Managed Payments choice), Stripe live activation, and written confirmation of Shopify's rules for charging custom-distribution installs.

## Open questions

- How long must payment records be kept (tax advisor; ADR-0022 item 13 proposes seven years)?
