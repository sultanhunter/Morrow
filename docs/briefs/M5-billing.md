# M5 Billing

- Status: brief, 2026-10-19. Spine: [mvp-architecture.md](mvp-architecture.md) §2 steps 1–3, §4, §9. Material choices: ADR-0022 items 2, 3, 11, 12 and 13 (Proposed). Rules: ADR-0015 and its OQ-1 to OQ-3 follow-ups; `docs/contracts/billing-entitlements.md` (P01.T04a).
- Plan IDs: P18.T01a (Morrow-direct Stripe route, test mode), with the persistence items 1 and 3–8, 10 and 11 of `billing-entitlements.md`. Branch `claude/m5-billing`, from M2 PR-1; two PRs.

## Goal

A website workspace picks the beta plan, pays through Stripe Checkout in test mode, and becomes billable only when Morrow has verified the payment server-side. Morrow then fixes its route to `morrow_direct`, grants the plan's credits to its wallet, and shows plan, credits and usage. Live mode waits for M6 and the owner's activation.

## Scope

- **PR-1, server:** `governance.billing.manage` (ADR-0022 item 2); the `morrow_billing` tables of spine §6; the route-row writer in the signup transaction; the purchase guard and routes; the Stripe webhook route; broker `stripeCustomerEnsure`, `stripeCheckoutCreate`, `stripePortalCreate` and `stripeWebhookVerify`; the payment classification and entitlement fold; credit grants; reversal recording.
- **PR-2, screens:** `/w/:ws/settings/billing` (plan, status, "Choose plan", "Manage billing") and `/w/:ws/settings/usage` (credits available, reserved and used; runs and their charges). Every purchase link or wording comes from `billingCallToAction`.

## Non-goals

Shopify App Pricing and the P18.T01b projection; top-ups, coupons, trials, proration and plan changes; Stripe Tax in test mode; dunning email; automated conflict remediation (P18.T01c, owner-approved per action); invoices as PDFs inside Morrow (the portal shows them).

## Interfaces and data touched

- **Reused (`packages/policy/src/billing-state.ts`, P01.T04a PR-B):** `originForCreation`, `workspaceBillingState`, `purchaseDecision`, `billingCallToAction`, `stripePaymentKind`, `mapProviderStatus`, `classifyPayment`, `foldEntitlementEvidence`, `entitlementFor`, `parseBillingTerms`, `createBillingConstraintsReader`, `BILLING_DENIAL_ENVELOPES`. Contracts: `WorkspaceBillingRoute`, `BillingAccount@2`, `EntitlementSnapshot@2`, `CreditGrant@2`, `VerifiedPaymentEvent`, `PaymentReversal`, `BillingTerms`, `StripePaymentKey`, `StripeSubscriptionKey`, `StripePriceKey` (billing v1.1); `CreditWallet` (v1).
- **Routes (all under `/workspace/:ws/billing/morrow/`, as P18.T01a requires):** `GET /workspace/:ws/billing` (state and call to action; `view` on `governance.billing.manage` or `governance.usage.read`), `POST .../checkout` `{priceKey}` with an `Idempotency-Key` (returns the Stripe-hosted URL), `POST .../portal`. Public: `POST /api/billing/stripe/webhook` (raw body, no session; already under `reservedWorkerPaths`).
- **Terms:** one `BillingTerms` revision holding the beta price key, kind `subscription_period`, currency USD and the credit quantity (ADR-0022 items 11 and 12).

## Flow

1. **Signup:** the creating transaction writes the route row with origin `website` (persistence item 1). Workspaces created before this lands are backfilled `website`.
2. **Checkout:** `purchaseDecision` must allow `morrow` in phase `open` with no `shopify_bound_at`; `execute` on `governance.billing.manage`. Under the route-row lock, record a checkout intent (one open per workspace) and an OperationLedger operation. The broker ensures the mapped customer (idempotency key bound to its operation), then creates a subscription-mode Checkout Session with `customer` (never `customer_email`), the price and the operation id in metadata. The success return proves nothing.
3. **Webhook:** the api passes the raw body and `Stripe-Signature` unparsed to `stripeWebhookVerify`. The broker verifies over the raw bytes (5-minute tolerance), checks `livemode` against the environment's mode and the account, de-duplicates by event id, reads the object back, and records a `stripe_event_receipts` row with the object digest.
4. **Apply:** the api applies only a receipt the broker recorded with a matching digest. `classifyPayment` decides: on the first completed `invoice.paid` of a `subscription_period` in phase `open`, fix the route to `morrow_direct`, create the account, write the `VerifiedPaymentEvent`, grant credits once per `(route, mode, paymentKey)` and credit the wallet in the same commit. Otherwise apply the held, unattributed or mismatch outcomes. Subscription updates fold through `foldEntitlementEvidence`. The handler returns 200 after commit; an unknown commit is read back before any acknowledgement.
5. **Reversals:** `charge.refunded` and `charge.dispute.*` are read back and recorded as `PaymentReversal`. While one is open the payer is not billable (R11).
6. **Portal:** a session on the mapped customer for payment method, invoices and cancellation at period end. Cancellation folds to `active` until the period ends, then `cancelled`.

## Security notes

- **Broker-only credentials (invariant 11):** the restricted key and the webhook secret bind only to the broker; the api sees neither (`mapApiEnvironment` rejects `STRIPE_` bindings).
- **Server-held route (invariant 24):** clients, return URLs, metadata and price keys never set the route; a workspace with `shopify_bound_at` and no route, or a Shopify route, never reaches checkout.
- **Reconcile before retry (invariant 10):** every Stripe write carries an idempotency key bound to its operation; on an unknown outcome the broker reads back first and replays with the same key only after proving absence, within 23 hours (persistence item 6).
- **Credits only from confirmed payment:** grants come from `BillingTerms` and a read-back `invoice.paid`, never from Checkout success or a client.
- **Tenant from mapping:** the event's workspace comes only from the customer mapping, cross-checked with the operation in metadata.
- **No checkout wording leaks:** denials use `BILLING_DENIAL_ENVELOPES`; the connector shows no billing.

## Test checklist

- [ ] The P01.T04a decision tables (`classify-payment`, `purchase-decision`) run against the persisted path, not only the library.
- [ ] Webhook: bad signature, stale timestamp, wrong mode or account, duplicate event, out-of-order `invoice.paid` before `checkout.session.completed` → correct and idempotent.
- [ ] A payment verified after a store link → `ROUTE_MISMATCH` held; never `morrow_direct`.
- [ ] Concurrent checkouts → one open intent; double `invoice.paid` → one grant.
- [ ] Refund or dispute → payer not billable; reservations follow the retained-work rule.
- [ ] Unknown Stripe outcome: readback before replay; never a new idempotency key.
- [ ] Billing and usage screens: call to action only from `billingCallToAction`; axe at the four widths.
- [ ] An end-to-end lab with recorded Stripe fixtures, then a test-mode smoke under owner approval with a `docs/evidence/live/` record.

## Owner actions

1. A Stripe account in test mode; a restricted key with the permissions in ADR-0022 item 12 and the webhook signing secret, placed with `morrow_put`.
2. Create the beta Product and Price in test mode (Claude supplies exact settings), or approve Claude creating them per action.
3. Choose the beta price and included credits (ADR-0022 item 11).
4. Before live mode (M6): business entity, bank account, tax advisor and registrations, Stripe live activation, and written confirmation of Shopify's rules for charging custom-distribution installs.

## Open questions

- How long must payment records be kept (tax advisor; ADR-0022 item 13 proposes seven years as the default)?
