# Billing and entitlements

Version 1 draft, selected by canonical sequences 16–22. Owner: Morrow platform owner. P01 defines records and semantics; P11/P12 enforce dispatch; P18 qualifies real billing. Review: Codex semantic self-review, integration/production qualification separate.

## Ownership and trust

One Shopify installation/shop owns BillingAccount. Organization membership does not pool subscriptions or authorize another shop's charges. Multi-store tasks bind named payers, installation/store IDs, subscription evidence and revisions in an immutable CostAllocation. Proposal parameters/reference bind allocation digest and revision. Payer, split, rate, meter or currency changes require renewed exact review. Current authority, approval and entitlement are independent requirements.

EntitlementSnapshot is a server projection of verified provider evidence with bounded validity and current revision. Reconcile subscription changes before paid dispatch and deny when known cancelled, suspended, past due or uninstalled. A checkout return, URL plan handle, browser login, agent prompt or valid schema does not prove payment/authority. Credentials stay in the broker; records carry identifiers/digests.

Shopify App Pricing is the sole selected provider in this version. External billing/origin routing, connector classification and fee treatment remain unqualified. An external route needs reviewed eligibility and a versioned adapter before activation. Connection-only UI does not change billing ownership. See billing-ownership.md.

## One work-credit balance

CreditGrant distinguishes included/purchased credits, payment evidence, terms revision, effective time and optional expiry. CreditWallet projects available/reserved/consumed whole internal units. A displayed work credit may contain smaller published units. Credits price complete work; they are neither cash nor provider tokens. P18 applies each verified grant once; schemas do not mint credits.

Standard packages differ principally by paid credit quantity. Managed inference, tools and bounded execution use a versioned work rate card. Minimum revenue and costed enterprise terms cover persistent resources and service commitments. Extra credits require explicit purchase or an owner-authorized capped mandate; top-ups default off. Published rates, renewal, rollover, expiry, proration, refunds, discounts, rounding, platform-caused retries and overages require explicit pre-charge qualification. No provisional prices are activated.

## Accounting and lifecycle

Reserve all allocation shares atomically before paid work. CreditReservation holds maximum credits; payer monetary liabilities and VendorCostReservation hold separate cash ceilings. Children/tools/retries consume aggregate root/payer budgets. Admission checks current provider eligibility and qualified rate/cost margins, including the lowest effective purchased-credit price and bounded low-token work. The P01 examples supply synthetic qualification facts; no real schedule or dispatch exists.

UsageLiability distinguishes merchant credits, merchant cash liability and attributable actual vendor cost. Unknown vendor cost is null/uncertain, never invented zero. Verified settlement binds pinned rate evidence, releases only proven unused commitments, and preserves consumed usage and bills. Cancellation is not zero usage evidence.

MeterEvent binds reconciled usage, original subscription and meter independently from credit settlement. Its stable ID/payload digest survive status changes. Submitted/uncertain events cannot receive new IDs or blind retries. P18 supplies durable outbox, exact provider deduplication and historical reconciliation. Acceptance requires a provider receipt; a local digest alone is not proof.

Cancellation/suspension stops new paid dispatch. Uninstall also revokes shop API access immediately; other authorized shops remain connected. Unsent reservations can release; submitted liabilities reconcile without new commercial work. Credit exhaustion preserves ordinary granted reads, approvals, export/deletion/privacy handling. Billing/legal retention and merchant-content deletion follow separate reviewed classes.

## Validation and evidence

billing.schema.json adds 12 closed definitions alongside core.schema.json. Reject unknown fields, coercion, invalid revisions, float credit counts and unspecified currencies. Money is an exact decimal string; credits are exact integer strings. Never infer FX. Semantic checks require current server scope, subscription evidence/revision, rate, budget and exact allocation review. Service failures use core ErrorEnvelope; synthetic inspectors emit review reasons without sensitive payloads.

scripts/billing-checks.mjs is a deterministic contract simulator. It cannot prove concurrent transactions, account grants, rate economics, real inference usage, webhook ordering or invoice acceptance. P06/P11/P12/P18 implement durable enforcement and integration. No checkout, charge, purchase, refund or model request occurs in P01. Breaking meaning requires a version/migration; consumers pin reviewed schemas. Run npm run verify:billing and npm run test:billing.
