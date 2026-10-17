# Budget and liability accounting

Version 1 draft. Owner: Morrow platform owner. Canonical sequence 22; consumers P11/P12/P18. Core Budget/Reservation/Money are complemented by CreditWallet, CostAllocation, CreditReservation, VendorCostReservation and UsageLiability. Approval and entitlement do not replace spending authority.

Reserve maximum attributable liability before every paid submission. Credits, merchant cash liabilities and vendor cash costs have independent root/payer ceilings and explicit currencies. The review model uses BigInt arithmetic for integer credits and decimal money, with no floating-point approximation or implicit FX. Vendor ceilings are separate from purchased credits. Published work rates and vendor cost schedules are separately pinned. Cash estimates include paid tools/media and occupied runtime resources.

Check every payer's share, available credits and aggregate money commitments before changing any balance. Children and retries share the root ceiling. Reused reservation IDs return existing records only for identical allocation/vendor payloads; replay does not dispatch again. Recheck current authority, provider/data eligibility, entitlement, rate/terms and installation before dispatch. Held funds cannot override revocation.

Unsent work can release. Dispatched/uncertain work retains credit/cash commitments. Verified usage settles once and releases unused shares. Identical settlement is a no-op; changed history denies. Cancellation/uninstall cannot discard incurred costs. A timeout cannot invent zero usage. Existing submitted liabilities can reconcile after cancellation without starting new work.

Production transactions must lock payers in stable order, compare current revisions, update all shares/root ceilings atomically and persist reservation plus command/outbox. Serializable contention/retries, operation uniqueness, crash recovery and provider readback need P06/P11/P12/P18 evidence. P01's sequential model is not real concurrency proof.

Credit exhaustion pauses paid work while preserving ordinary granted reads, reviews, export/privacy handling. Operational quotas remain service safeguards rather than a separate merchant infrastructure bill. Budget reductions do not erase commitments; period resets preserve outstanding reservations and identities. Terms qualification must resolve grant order/expiry, rollover, renewal, refunds, proration, overages, rounding and lowest effective credit price. Real rates and charging remain blocked.

## Contract v1.1: kill switches (P01.T02a PR-A)

Kill switches (ADR-0005) are `external_write` or `control` capabilities, never `spend` or `billable_job` (catalogue rule R7), so the policy evaluators never attach `budget_reservation` to them, and a stop reserves no credits. In PR-A the existing entitlement and provider checks still apply to a stop, as before. PR-B (ADR-0011 Q8) exempts kill switches from entitlement and credit balance checks while keeping provider limits (`provider_denied`).
