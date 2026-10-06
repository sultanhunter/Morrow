# Billing ownership decision

Owner: Morrow platform owner. P01.T04 recorded design, canonical sequence 22, 6 October 2026. Reviewer: Codex, same implementer, separate semantic review pass. No merchant prices or payment/provider activation.

Morrow is paid, supplies managed model APIs, and uses one work-credit balance. Shopify App Pricing remains the default for applicable installation charges. Each shop owns its account/subscription. Shared organizations expose only authorized accounts. Multi-store work declares exact payer shares; there is no silent pooling or unrelated-store charge. Connector identity cannot execute workspace domain work.

Paid dispatch needs current actor/store authority, qualified provider/data policy, active entitlement, qualified published rate/cost schedule, exact reviewed allocation and atomic credit/merchant-money/vendor-money reservations. Rates price complete work. Enterprise commitments require costed terms; persistent service costs do not disappear when credits expire. Economics qualification includes measured workloads, discounts and bounded low-token runtime costs.

Server-side subscription evidence controls entitlement. Usage and invoices are separate. Reserve before dispatch; retain unknown outcomes; settle once. Meter events bind the original subscription rather than rewrite historical usage on upgrades. With the selected App Pricing route, do not use legacy subscription-creation helpers. P18 pins the exact Partner/AppEvents API, meter/rates and no-charge development tests. [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)

Cancellation stops new paid work; uninstall also revokes that shop's connection. Other authorized shops continue. Unsent reservations release; uncertain/incurred liabilities reconcile. Export/deletion/privacy remain separate. Refund, expiry, rollover, renewal, proration and rounding are explicit pre-charge gates.

## Unresolved activation and launch gates

| Gate | Owner | Prerequisite/evidence | Blocks |
| --- | --- | --- | --- |
| Connector distribution/UI classification | Morrow platform owner | Runnable connector, onboarding/handoff/status and applicable review result | P09 public activation/P18 launch |
| Default billing account/API access | Morrow platform owner | Registered app/client, pinned API/meter, no-charge development tests/current permissions | P18 billing activation |
| External billing eligibility/origin | Morrow platform owner | Reviewed Morrow-specific acquisition/paid-customer facts and separated checkout/upgrade/credit paths | Any external billing route |
| Revenue scope/fees/reporting | Morrow platform owner | Applicable agreement and explicit treatment; external billing is not a fee waiver | External commercial activation |
| Work rates/terms/economics | Morrow platform owner | Measured workloads, fixed-service coverage, discount/enterprise/margin review and renewal/refund terms | Published prices/real charging |
| Durable ledger/reconciliation | Morrow platform owner | P06/P11/P12 transaction/fault evidence; P18 account/subscription/event tests | Real paid work/invoices |

Official support guidance for genuine existing paid independent-SaaS customers is an eligibility input, not a Morrow grant. Free signup alone does not qualify; usage-only relationships are case-specific. Persist evidenced origin/paid relationship and eligible principal before enabling any future external route. [Shopify support clarification](https://community.shopify.dev/t/does-a-split-billing-model-satisfy-1-2-1-shopify-origin-installs-billing-api-pre-existing-platform-customers-direct-billing/36909)

Agreement scope, fee and reporting obligations are separate from UI/provider choice. Placing checkout in Morrow does not establish zero app-related fees. [Shopify Partner agreement](https://www.shopify.com/partners/terms)
