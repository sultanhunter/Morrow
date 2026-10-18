# ADR-0011 Contract v1.1: review policy and exact proposals

- Status: Accepted
- Date: 2026-10-17
- Refines: ADR-0005 §3 (ReviewPolicy). ADR-0005 §1–§2 already authorize P01.T02a PR-A.
- Affects:
  - P01.T02a PR-B (§1, §3, §5–§8);
  - P11.T01, P11.T02, P11.T04, P11.T05;
  - P05.T01z, P05.T02a, P05.T01x (template v1), P14.T03, P01.T02b, P01.T02c;
  - `docs/contracts/{capabilities.json, state-transitions.json, review-policy-defaults.json, approvals.md, budgets.md}`;
  - Security invariants 7, 8 and 14.

## Context

ADR-0005 set the review principles:
- eligible reviewer grants;
- no self-approval for spend, communication, access change or irreversible risk;
- optional quorum and expiry per risk class;
- derived digests for partial approval;
- a solo-owner exception with typed confirmation and a cool-down.

Packet P01.T02a turns these into contracts and a pure review library. Several of its choices are material under ADR-0002:
- the contract versioning model;
- who counts as conflicted;
- what "solo owner" means;
- default timings;
- two new capability IDs;
- credit ceilings;
- billing treatment of kill switches.

Without them, P11.T01 and P05.T01z would each have to invent rules.

## Decision

The recommended answers to P01.T02a Q0–Q9 are adopted.

- **Q0 Versioning** (§1–§2).
  - `morrow.contracts.v1.1` consists of the three v1 schema files, byte-identical, plus `schemas/v1.1/{core,capabilities}.schema.json`.
  - **Explicit replacements.** Proposal@2, Approval@2, the five kill-switch input bodies and the `governance.approval.decide` body are declared in `changes.json`. They are incompatible in both directions.
  - **Selectors.** Product code uses only the effective (current) selectors; v1 selectors remain for the frozen baseline and history.
  - **Validators** are generated ahead of time only.
  - **Freezing.** Tier 3 P01 contract sign-off freezes v1.1. Later additions open v1.2.
- **Q1 Conflict set** (§7 item 5).
  - A reviewer is conflicted if they are `proposedBy`, `requestedBy` (the task initiator or mandate owner), or one of `beneficiaryPrincipalIds`.
  - For access_change, the beneficiaries are the principals receiving the grant, membership or ownership, plus the requester of any originating access request.
  - Derived proposals inherit the set.
  - A conflicted reviewer passes only under `allowed`, or under `solo_owner_typed_confirmation` with solo status and the exact phrase.
  - The proposer, the requester and every beneficiary of an access change therefore cannot approve it. The only exception is a solo owner (Q2) with the exact phrase, because access_change never uses `allowed`.
- **Q2 Solo owner** (§5, §7 items 6 and 10). A reviewer has solo status only if all of these hold:
  - they are the designated owner principal (the ADR-0009 owner record, through `WorkspaceOwnershipFacts`);
  - they are the only active human member;
  - no membership change (any revocation or ownership change) happened within the quiet period of 24 h by default.

  Status is rechecked at `effectiveAt` and at dispatch; losing it gives `SOLO_OWNER_STATUS_LOST`. The owner membership cannot be revoked through the kill switch (`OWNER_MEMBERSHIP_PROTECTED`): ownership must first be transferred by a reviewed access_change (P05.T01z).
- **Q3 Defaults** (§7, `review-policy-defaults.json`).

  | Class | Self-approval | Quorum | Pending expiry | Approved validity |
  | --- | --- | --- | --- | --- |
  | internal | allowed | 1 | 7 d | 24 h |
  | external | allowed | 1 | 72 h | 24 h |
  | communication, financial, access_change, irreversible | solo_owner_typed_confirmation | 1 | 24 h | 1 h |

  - The solo-owner cool-down is 300 s and the quiet period 86,400 s.
  - The confirmation phrase is NFC, exact and case-sensitive: `approve N change(s) for C credits`, plus ` and A CUR` when there is a cost.
  - A solo approval can be cancelled before `effectiveAt`.
  - There is one ReviewPolicy per workspace (`storeId` null). P11.T01 seeds revision 1 from these defaults.
- **Q4 Irreversible capabilities** (§3).
  - The list: `lifecycle.campaign.send`, `support.reply.send`, `orders.refund.create`, `orders.cancel`, `orders.fulfillment.create`, `governance.privacy.erase` and `agents.installation.uninstall`.
  - For an irreversible proposal, the irreversible rule is merged in, field by field, taking the stricter value.
- **Q5 New capabilities** (§6).
  - `governance.review_policy.revise`: control, `human_only`, reviewed as access_change. Agents may only propose it. A new revision makes approvals bound to the old one stale.
  - `governance.approval.preview`: read, `human_only`, unreviewed. It returns the deterministic derived proposal before a decision.
  - **Reviewer verbs.** A reviewer needs `approve` on `governance.approval.decide`, plus `approve` on the proposal's capability covering every decided target. Preview also needs `view` on `governance.approval.preview`. P05.T01x template v1 grants both (ADR-0009 item 7).
- **Q6 Ceilings** (§6, §7 item 2).
  - **Fields.** Proposal@2 carries `maximumCredits` (CreditUnits, an integer string summed with BigInt) and `maximumCost` (non-negative money or null), on every target and in total, inside the proposal digest.
  - **Derivation** never raises a ceiling or extends expiry.
  - **Vendor-cost ceilings** stay in `VendorCostReservation`.
- **Q7 Delegation reading** (§3).
  - "Delegation changes" (ADR-0005) means two things: grants carrying `delegate` (`governance.grants.revise`) and mandate activation (`workspace.routine.activate`). Both are `human_only`.
  - `workspace.task.delegate` and `workspace.routine.configure` stay `agent_direct_write`.
  - ADR-0005 §2 names the two restricted executor classes. P01.T02a's other two, `agent_direct_write` (internal_write, billable_job) and `agent_direct_read` (read), keep today's agent behaviour (`agent-authority.md`) and confer nothing new.
- **Q8 Stops and billing** (§4).
  - Kill switches never reserve credits and are never blocked by credit balance or entitlement. In the evaluator they skip `entitlementAllowed`. Because they reserve no credits, they are never paid work under ADR-0006.
  - Provider limits still apply (`provider_denied`).
- **Q9 Risk class** (§3). Risk comes from the fixed effect→risk table in `review-policy-defaults.json`:

  | Effect | Risk class |
  | --- | --- |
  | read, internal_write, billable_job | internal |
  | external_write | external |
  | spend | financial |
  | communication | communication |
  | control | access_change |

  There are no per-capability overrides unless an ADR adds one.

**Also adopted with these answers** (§7 items 1, 7–9 and 13):
- **Server-derived fields.** The server derives `risk`, `irreversible`, `requestedBy`, beneficiaries, `contextTaint`, `reviewPolicyRef` and `proposedBy`, each with its own mismatch code.
- **Taint is a field only.** Deriving `contextTaint` does not decide the plan's proposed untrusted-content rule. That rule still needs its own owner-approved ADR before P11.T02 enforces it.
- **Decision fold.** The fold is idempotent per `(commandId, requestDigest)`, and decisions are bound to the decided digest.
- **Families.** At most one member of a family is approved.
- **Error mapping.** Errors map to existence-free codes.
- **Read-back.** An unknown commit is read back by `commandId` and never resubmitted.

## Consequences

- P01.T02a PR-B may start. v1.1 stays `candidate_owner_signoff` until the Tier 3 P01 contract sign-off.
- P11.T01 imports the review library rather than re-implementing it. P11.T02 denies dispatch for any obligation it does not implement.
- P05.T01z enforces owner protection in SQL, maintains `lastMembershipChangeAt` and records `KillSwitchRecord` atomically with each revocation.
- P05.T01x template v1 changes its `governance.approval.decide` verb from `execute` to `approve` and adds `view` on `governance.approval.preview`.
- The P01.T02c and P01.T02b binding requirements (P01.T02a §9) remain with those packets.

## Approval

Owner approval, 2026-10-17, in chat (second batch). The owner selected **"Accept recommended (Recommended)"** for this question:

> Approval rules (P01.T02a): the proposer, requester and anyone who benefits from an access change can't approve it. A 'solo owner' is the only active human member, with no membership changes in the last 24h. The owner can't be removed via kill switch (ownership must be transferred first). Defaults: 5-minute cool-down for solo self-approval, one approver needed, approvals expire per risk class. Kill switches are never blocked by credit balance. Proposals carry credit and cash ceilings. Accept?

This accepts the recommended answers to P01.T02a Q0–Q9. The question's summary leaves out several parts of those answers:
- Q2 also requires the reviewer to be the designated owner principal.
- Q3 keeps self-approval `allowed` for internal and external proposals. This is consistent with ADR-0005, which restricts self-approval only for spend, communication, access change and irreversible risk. The summary's first sentence therefore applies to the restricted classes.
- Q8 also exempts kill switches from entitlement checks, not only from credit balance.
- Q0 (versioning), Q4 (the irreversible list), Q5 (the two new capabilities and reviewer verbs), Q7 (the delegation reading) and Q9 (the risk table) are not mentioned.

## Notes

- 2026-10-18: ADR-0015 supersedes ADR-0006. Q8's "never paid work under ADR-0006" now reads as ADR-0015's pre-payment state; the rule is unchanged.
- 2026-10-18: ADR-0018 refines Q1. A human-made governance proposal may have no task, and its `requestedBy` is then the proposer. Agents always need a task.
