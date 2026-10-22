# Billing API (M5 PR-1)

The Morrow-direct billing server: the workspace billing routes on the api Worker's origin and the public Stripe webhook. Plan: P18.T01a, test mode only (`docs/briefs/M5-billing.md`). Rules: `billing-entitlements.md` (P01.T04a) and ADR-0022 items 2, 3, 5, 9, 11, 12 and 13, with the 2026-10-20 amendments to items 9 (receipt-only webhook ingress) and 11 (credits roll over in the beta). Code: `packages/work/src/billing/`, `apps/broker/src/stripe.ts`, migration `billing-records` (located by slug).

## The Stripe switch

Owner decision (c), 2026-10-21 ("Merge with Stripe off"): `switch` in `docs/decisions/stripe-staging.json` is committed `"off"`, and its runtime image is the api's and the broker's var `MORROW_STRIPE_MODE` (exactly `"test"` while on, absent while off; `docs/briefs/M5-billing.md` has the rules and how to turn it on). While it is off:

- `POST /workspace/:ws/billing/morrow/checkout` and `POST /workspace/:ws/billing/morrow/portal` answer `503 unavailable` (`recheck_before_retry`, "Billing is temporarily unavailable.", no operation id) after the request guard and the closed body, and before any database access or broker call. No intent or operation is written.
- `GET /workspace/:ws/billing/morrow/plans` lists no offer and allows neither `subscribe` nor `billingPortal`.
- `POST /api/billing/stripe/webhook` answers `503 {"code":"unavailable"}` to every request before reading its body: no broker call and no receipt.
- Each ApiBroker Stripe method is `BROKER_HELD` with the fixed code `STRIPE_UNAVAILABLE` before its inputs are read; the broker reads no Stripe secret or configuration.
- `GET /workspace/:ws/billing` still reads the plan, credits and billing period, but its call to action is `{kind: "none"}` wherever it would be `morrow_plans` ("Choose a plan" or "Manage plan"), since those plans would offer nothing (`billingViewCallToAction`). A Shopify phase's `shopify_plan_page` is App Pricing, not Stripe, and is unchanged.
- The wallet, entitlements and the receipt definers are unchanged.

## Routes

All workspace routes live under `/workspace/:ws/billing` and use the generalised workspace request guard (`packages/work/src/http-guard.ts`): exact origin, Fetch Metadata, exactly one `__Host-morrow_session` cookie, no query, and for writes the exact `Origin`, `Content-Type: application/json`, `X-Morrow-Request: 1` and an `Idempotency-Key` UUID. Bodies are at most 1 KiB of strict JSON. Every malformed request is refused before any database connection or broker call. No route sets a cookie or answers CORS; every response is `no-store`.

| Method and path | Authority | Body | Success |
| --- | --- | --- | --- |
| `GET /workspace/:ws/billing` | `view` on `governance.billing.manage` or `governance.usage.read` | none | `200` the billing view |
| `GET /workspace/:ws/billing/morrow/plans` | `view` on `governance.billing.manage`; purchase guard (subscribe or billing_portal) | none | `200` the current offers and the allowed actions |
| `POST /workspace/:ws/billing/morrow/checkout` | `execute` on `governance.billing.manage` with `{action: "subscribe", priceKey}`; purchase guard (subscribe) | `{"priceKey": "stripe:price:price_…"}` | `201` (or `200` replayed or reused) `{operationId, checkoutUrl, expiresAt}` |
| `POST /workspace/:ws/billing/morrow/portal` | `execute` on `governance.billing.manage` with `{action: "billing_portal", priceKey: null}`; purchase guard (billing_portal) | `{}` | `201` (or `200` replayed) `{operationId, portalUrl}` |
| `POST /api/billing/stripe/webhook` | none (sessionless): the broker's signature check and readback | Stripe's raw event bytes | `200 {"received": true}` after commit |

The billing view carries the phase and state, the plan's status and validity, the credits (available, reserved, consumed), the billing period (the line period of the latest granted subscription invoice), any checkout in progress, `setupHold` (`{operationId, heldAt}` when the workspace's Stripe customer setup is held for Morrow support, else `null`; the operation id is the support reference), and one call to action, taken only from `billingCallToAction` (`{kind: "none"}` for a viewer without `view` on `governance.billing.manage`, and in place of `morrow_plans` while the Stripe switch is off). It carries no provider id, price id or URL.

### The purchase guard

One prefix, `/workspace/:ws/billing/morrow/`, and a closed table (`morrowPurchaseRoutes`):

| Route | Actions |
| --- | --- |
| `GET /morrow/plans` | `subscribe`, `billing_portal` (whichever is allowed) |
| `POST /morrow/checkout` | `subscribe` |
| `POST /morrow/portal` | `billing_portal` |

The action never comes from the request; an unmapped path is `404`. `purchaseDecision` decides on the billing state read in the same transaction, before any command, definer or broker call. A Shopify-bound workspace (a current store association) is refused `PURCHASE_ROUTE_MISMATCH`. The SQL command then rechecks under the route row's lock: the route still unfixed, origin `website`, never bound, no association (an M2 PR-2 store installation that is or was linked; one never linked is not an association), and the terms revision current. That recheck is stricter than the library in one case: in `morrow_direct` after a terminal subscription, `purchaseDecision` allows `subscribe`, but checkout is refused (`403`) until M6 adds held-payment re-classification. lab:billing F asserts it. `GET /morrow/plans` therefore reports `subscribe` (and lists offers) only when the command's own precondition also holds, and never while the customer setup is held; lab:billing D asserts `subscribe: false` after a terminal subscription.

### Errors

Every error is an `ErrorEnvelope` with a fixed safe message, the correlation id and, after the commit, the operation id. Purchase-guard denials use `BILLING_DENIAL_ENVELOPES` (`denied` 403, `conflict` 409, `missing_input` 409, `unavailable` 503).

| Status | Code | Retry | When |
| --- | --- | --- | --- |
| 400 | `missing_input` | never | malformed request, body, Id or key |
| 401 | `denied` | never | no or invalid session; unconfigured api |
| 403 | `denied` | never | no grant, a guard or route refusal (these routes take a browser session only, which no agent principal holds) |
| 404, 405 | `denied` | never | unmapped path, wrong method (`Allow` set) |
| 409 | `conflict` | recheck or never | stale authority, an idempotency key reused for another body, terms changed or no terms revision, a checkout in progress, no customer, a provider refusal, a closed checkout |
| 409 | `conflict` | never | `customer_held`: the workspace's Stripe customer setup is held for Morrow support ("Billing setup for this workspace needs attention from Morrow support."); see `setupHold` |
| 429 | `rate_limited` | recheck (GET: safe_read_retry) | over the api's per-address session limit, answered before this API runs (`Retry-After: 60`, `retryAfterSeconds` 60; `apps/api/src/session-limit.ts`) |
| 503 | `unavailable` | recheck | database or broker unavailable, no Stripe adapters (the Stripe switch off) |
| 503 | `uncertain` | reconcile_before_retry | the Stripe outcome is unknown: retry with the same `Idempotency-Key`, which reconciles the same operation |

## Operations and the broker

Checkout and portal commands commit their `stripe_write` operations (task null, capability `governance.billing.manage`, ADR-0022 item 2) before any broker call, and the api then calls the ApiBroker by operation id only:

- `stripeCustomerEnsure(operationId, budgetMs)`, `stripeCheckoutCreate(operationId, budgetMs)`, `stripePortalCreate(operationId, budgetMs)`: the broker loads every parameter (customer, price, expiry, metadata, return URLs) from the database through its own login, recomputes the request digest, sets the send fence, calls Stripe on the pinned version `2025-03-31.basil` with `Idempotency-Key: morrow-<environment>-<operationId>`, reads the result back and settles the operation. `budgetMs` is one deadline for the whole method: each transaction and HTTP call gets only what remains, the HTTP calls stop a second early so the settle fits, and too little time to send is a possible send (`uncertain`), never "no effect". A 4xx or a repeated 429 on a first send fails it, only while it is still `dispatching` (a concurrent reconciliation may be replaying it); a 5xx, a timeout or a lost reply leaves it `uncertain`. Reconciliation reads back first (customer search; the customer's sessions created since the operation) and replays with the same key only within 23 hours; a replay's refusal never fails the operation. No new key is ever used. Checkout is card only (`payment_method_types[0]=card`), so a completed session's first invoice is decided within minutes.
- A customer operation still `uncertain` 24 hours after its creation (and an hour after its send) is reconciled by `GET /v1/customers` (strongly consistent, unlike search) over every time it could have been created, at most five pages of 100, filtered on `metadata.morrow_operation_id`: one customer is read back and settles it verified; none settles it `absent` (failed, with every open intent it serves, so the next checkout starts a new customer operation); several, or more than five pages, settle it `held` and `stripeCustomerEnsure` answers `held` (the api's `customer_held`). A failed list proves nothing and is retried. The database re-checks the window on its own clock.
- The operator path for a held operation: `npm run staging:billing-customer-resolve -- --operation <id> --resolution retry|abandon --evidence-code <code> --evidence docs/evidence/live/<record>.md --operator <id>` (active staging card, the committed evidence record, main at a green `foundation`; per-action approval). It runs `morrow_billing.operator_customer_operation_resolve` as `morrow_work_owner` under D4: `retry` (`stripe_corrected`, after correcting Stripe, for example removing a duplicate customer) clears the hold so the next checkout runs the proof again; `abandon` (`customers_deleted` or `none_found`, after deleting every customer of the operation in Stripe or finding none) fails it (`verified_no_effect`, reason `operator_verified_no_effect`) with its open intents. Nothing else is accepted; each resolution is recorded in `stripe_operation_resolutions`.
- The staging test entitlement (ADR-0022 item 5 amendment, 2026-10-21; no Stripe call): `npm run staging:test-entitlement -- --workspace <id> --approval <staging-card-1.e13.YYYY-MM-DD.n> --record docs/evidence/live/<record>.md --operator <id>` (active staging card carrying E13, the owner's per-use approval in chat named in the committed record with the workspace, main at a green `foundation`). It runs `morrow_billing.operator_test_entitlement_grant` as `morrow_work_owner` under D4 and prints the closed result. The billing view then reads the beta plan, 300 credits and the 30-day period; `/plans` offers nothing while the Stripe switch is off, and the portal has no customer to open.
- `stripeWebhookVerify(rawBodyBase64, signatureHeader, budgetMs)`: HMAC-SHA256 over the raw bytes (constant time, 300 s tolerance both ways), test `livemode` only in development and staging, a readback of the object with the broker's key (another account's object is a 404), the closed normalised object and its digest, and `stripe_receipt_record` (tenant only from the customer mapping; duplicate event ids return the existing receipt).

Results are closed JSON with fixed codes; hosted URLs are accepted only on `checkout.stripe.com` and `billing.stripe.com` and are never stored.

## Webhook

`POST /api/billing/stripe/webhook` is the only `/api` path the api Worker serves (`apps/api/src/worker.ts` dispatch table). The handler reads at most 256 KiB (`413` above), passes the bytes base64-encoded and the `Stripe-Signature` header unparsed to the broker, and then:

- `rejected` (bad signature, stale timestamp, wrong mode, object not found): `400`, no row;
- `ignored` (an event type outside the six): `200`;
- broker held: `503` (Stripe retries), including a subscribed event whose read-back object is outside the closed shape (the broker's one log line names `object_invalid` and the event type; never acknowledged and dropped);
- `recorded` or `duplicate`: the receipt-only ingress in one transaction: `receipt_begin` (the recorded receipt with a matching digest, its tenant from the receipt, the route row locked), the pure planner (`classifyPayment`, `foldEntitlementEvidence`), and `receipt_apply`, which re-derives the payment key, mode, amount, price, period, operation and credit units in SQL from the receipt and `billing_terms`, orders entitlement observations as `foldEntitlementEvidence` does (a stale read never folds), and checks the whole plan before its first write (a refusal writes nothing, whatever the caller does with the transaction). `200` only after the commit; a lost commit is read back with `receipt_status` before any answer. A receipt `receipt_apply` refuses, or one the planner cannot plan, is `503` (Stripe retries) with one fixed log line naming the internal receipt id and `APPLY_INVALID`, `APPLY_DENIED`, `APPLY_CONFLICT` or `PLAN_ERROR`.

The ingress definers refuse unless the session user is `morrow_api_worker` with no work session or lease context. The six subscribed events (ADR-0022 item 12): `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.

## Terms

`docs/decisions/billing-terms.json` publishes each environment's `BillingTerms@1` revisions with display offers (unit amount in minor units, monthly) and the digest of `{terms, offers}`; `npm run verify:billing` checks it and `staging:seed-platform` seeds the staging revisions into `morrow_billing.billing_terms` (idempotent, refused on drift). The beta entry is USD 49 a month with 300 credits (ADR-0022 item 11); grants carry no expiry and unused credits roll over while the subscription is active (ADR-0022 item 11 amendment, 2026-10-20; revisit before live money at M6). Staging has no revision until the owner creates the test-mode Product and Price, so staging checkout fails closed.
