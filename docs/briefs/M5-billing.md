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

- [x] The P01.T04a decision tables (`classify-payment`, `purchase-decision`) run against the persisted path. (lab:billing F: the 30 Stripe subscription-period rows M5 can persist and the 48 purchase rows of the two purchase routes; reversed payers, App Pricing, plan changes and top-ups are outside the M5 path. One stricter persisted outcome is asserted as such: subscribe in `morrow_direct` after a terminal subscription is refused until M6.)
- [ ] Recorded fixtures on the pinned version: a real `invoice.paid` (`subscription_create`) resolves its operation through `parent.subscription_details.metadata`; a cancellation via `cancel_at` folds correctly. (PR-1: done on synthetic fixtures hand-built from the 2025-03-31.basil reference: tests/billing-apply-plan.test.mjs, lab:billing D and G. Open: replace them with objects recorded in the owner-approved test-mode smoke.)
- [x] Webhook: bad signature, stale timestamp, wrong mode or account, duplicate event, `invoice.paid` before `checkout.session.completed` → correct and idempotent. (tests/billing-webhook-verify.test.mjs; lab:billing D2-D4 and G2-G3, including a held readback and a lost commit read back.)
- [x] A payment verified after a store link → `ROUTE_MISMATCH` recorded; never `morrow_direct`. (lab:billing D8 and F, a defence case reachable only through a fixture under ADR-0022 item 5.)
- [x] Concurrent checkouts → one open intent; an expired session (event, or the lazy close) → a new checkout works; double `invoice.paid` → one grant. (lab:billing B4, B5, D2 and G6.)
- [x] Unknown Stripe outcome: readback before replay; never a new idempotency key. (tests/billing-stripe-broker.test.mjs; lab:billing C and G5.)
- [ ] Billing and usage screens: call to action only from `billingCallToAction`; axe at the four widths. (PR-2.)
- [ ] An end-to-end lab with recorded Stripe fixtures, then a test-mode smoke under owner approval with a `docs/evidence/live/` record. (PR-1: lab:billing G runs the real broker code against the fake Stripe origin over PostgreSQL 17 with zero real provider calls, and lab:billing-workers (pg-work) runs the api and broker as two workerd Workers over the ApiBroker service binding, with M2 PR-2's vault transport on the broker's own login: checkout to the hosted URL and its key replay (C1-C4), a bad signature 400 with no row, a held broker 503 then the retry applied after the commit, a redelivery, a lost commit read back (W1-W5), the portal (P1), the dispatch rows (D1) and zero unexpected outbound requests (O1-O3). Open: recorded fixtures and the owner-gated smoke after merge.)

### PR-1 status (server)

- [x] `governance.billing.manage` and `governance.model_default.revise` in the catalogue (Governance, control, `human_only`, review not required, never paid work); owner template v2 issued at signup and backfilled for active founders; `!isPaidWork` for every v2 row. (tests/account-onboarding.test.mjs, tests/policy.test.mjs, lab:billing A including a real signup on the full chain.)
- [x] Route-row writer in the signup transaction: delivered by M2 PR-1 (0021-0023); it still fires after the `create_first_organization` replacement (lab:billing A; the body differs from 0013's only in the template function and literal, tests/account-onboarding.test.mjs).
- [x] Purchase guard: one prefix `/workspace/:ws/billing/morrow/`, a closed path → action table, denial or billing-reader failure before any handler or broker call. (tests/billing-commands.test.mjs; lab:billing B2.)
- [x] Credits only from confirmed payments: grants from `BillingTerms` and a read-back paid invoice, re-derived in SQL, never from the Checkout return or a client. (lab:billing D1, D9 forged plans, F.)
- [x] Tenant from the customer mapping, cross-checked with the operation in the subscription metadata. (lab:billing D7; tests/billing-apply-plan.test.mjs.)
- [x] `mapApiEnvironment` rejects `STRIPE_` bindings; Stripe credentials bind only to the broker in development and staging (16 names; production 12). (tests/api-environment, edge-config, broker-protocol, staging-secrets; `STRIPE_OUTSIDE_BROKER` boundary rule.)
- [x] Deep review fixes (AI review, separate context, same model family; 2026-10-21): the staging broker's `STRIPE_CONFIGURATION_JSON` admitted by `edge:check` only byte-equal to `docs/decisions/stripe-staging.json` and only in that var (tests/edge-config.test.mjs); a customer operation uncertain past 24 hours settled by the customer list (verified or absent) or held for the operator, with `setupHold` in the billing view, `customer_held` at checkout and `staging:billing-customer-resolve` (tests/billing-stripe-broker.test.mjs, tests/staging-runner.test.mjs, lab:billing H5-H7); a first send's refusal fails only a `dispatching` operation (lab:billing C); a failed customer operation fails every intent it serves (H1); a completed intent that never verifies closes a day after its expiry and checkout is card only (H2); `receipt_apply` checks the whole plan before writing (H3) and orders observations (H4); session definers cannot insert a mapping or ledger row (lab:billing E, S7 `commandRead`); an out-of-shape subscribed event is held, not dropped, and unapplied receipts are logged with fixed codes; one deadline per broker method; `/plans` offers only what checkout performs (D).
- [ ] Tier 2 AI review (separate context, same model family) with the security lens, stating whether the new api routes and broker methods widen ADR-0007 R1/R2.
- [ ] (Post-merge, owner) Stripe test account, restricted key and webhook secret placed, Product/Price created, portal configuration saved, staging terms committed, test-mode smoke with a `docs/evidence/live/` record.

Scope notes for PR-1: the signup route-row writer was already delivered by M2 PR-1; owner template v2 is v1 plus the two Governance controls (ADR-0022 item 3), and the Ask admin grant goes into a later owner template version; `credit_wallets` is created here (M3 PR-1 consumes it). The broker's vault-login transport (`apps/broker/src/vault-database.ts`) and the store-installation bridge (`morrow_identity.work_store_installations`) are M2 PR-2's: at the final rebase onto it the branch-local stubs were deleted, this PR's migrations were renumbered 0028-0029 after M2's 0025-0027, and the billing records read an association as an installation that is or was linked (one never linked blocks neither checkout nor the route fix; lab:billing D8b).

## Owner actions

1. A Stripe account in test mode; a restricted key with the ADR-0022 item 12 permissions (checked against the exact calls in the sandbox) and the webhook signing secret, placed with `morrow_put`.
2. Create the beta Product and Price in test mode with Claude's exact settings (including tax code and behaviour), or approve Claude creating them per action.
3. Save the customer portal configuration in test mode: invoice history and payment-method update on, subscription update off, cancel at period end. Repeat at live activation. Record its `bpc_` id and the date in `docs/decisions/stripe-staging.json` and the byte-equal `STRIPE_CONFIGURATION_JSON` in the broker's `env.staging.vars`, in one reviewed commit (`edge:check` admits nothing else).
4. Done: the beta plan is US$49 a month with 300 credits (owner, 2026-10-19; ADR-0022 item 11).
5. Before live mode (M6): business entity, bank account, tax advisor and registrations (or the Managed Payments choice), Stripe live activation, and written confirmation of Shopify's rules for charging custom-distribution installs.

## Open questions

- How long must payment records be kept (tax advisor; ADR-0022 item 13 proposes seven years)?
- Resolved (owner, 2026-10-20): unused monthly credits roll over in the beta. `CreditGrant.expiresAt` stays null and credits stay spendable while the subscription is active; revisit before live money at M6 (ADR-0022 item 11 amendment).
- Resolved (owner, 2026-10-20): the Stripe webhook applies only broker-recorded receipts through api-login ingress definers that refuse any session context and re-derive the payment key, mode and credit units in SQL; the vault login is not widened into billing writes (ADR-0022 item 9 amendment).
