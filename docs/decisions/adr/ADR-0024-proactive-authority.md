# ADR-0024 Proactive authority: mandates, the installation as requester, and review rules for proactive work

- Status: Proposed
- Date: 2026-10-23
- Supersedes: none.
- Amends: ADR-0011 Q1 as refined by ADR-0018 item 3 (item 7); ADR-0011 Q3 (item 9); ADR-0011 Q8, extended to revoke (item 4); ADR-0022 item 9 (item 6). Only if owner question 1 is accepted: ADR-0005 §3, ADR-0011 Q1 for access_change, ADR-0023 decision 11b's last sentence and the ADR-0005 entry of ADR-0023's "Does not change" list.
- Implements: ADR-0023 decisions 3 and 1 (mandates).
- Does not change: `agent-authority.ts`; AutomationMandate@1; the kill switches; ADR-0011 Q2, Q4 to Q7.
- Terms: **the Owner** is ADR-0011 Q2's designated owner, at launch ADR-0022 item 3's founding principal. ADR-0025 to ADR-0031 use the term this way.
- Unblocks: P05.T04, P05.T04b, P05.T01z, P01.T02a, P11.T01, P11.T02 (with ADR-0027 item 5), P12.T04, P13.T03, P07.T03, P14.T03, P16.T03, P16.T04; tracks T2 to T7, T12, T14, T17; gate G10 (it defines what G10 holds back).

## Context

The owner asked for agents "that work proactively with the specified goal(like grok bot, dots etc.)" (Q10) and approved decision 3: "yes to all recommended" (Q12). On `main`, `decideAutomation` already enforces mandates, but there is no mandate table, a run needs a human requester (0038), and ADR-0011 Q1 makes the mandate owner `requestedBy`, so a team installer can never approve their agent's work.

## Decision

1. **Mandates.** Forward migrations add `automation_mandates` (append-only revisions), `mandate_documents`, `agent_trigger_sets` and `agent_installations.mandate_ref`; a run has a human requester or a `mandate_id`, never both. Each installed agent has one current mandate; the Coordinator and specialists never do. Code builds it: the installation owner, the installation's grants minus `human_only` ones, its scope and caps, the enabled trigger kinds and quiet hours, depth 0, and expiry 90 days after start (CHECK). A mandate removes no approval; routines and monitors never add a trigger kind, capability or scope.
2. **Issue and renew.** Install confirms one server-built document with `agents.installation.activate`, bound to the actor and a standalone-workspace session, 5 minutes, single use. The issuer must own the installation and hold everything the mandate names (`amplification_denied`); the Owner gets optional-scope capabilities from ADR-0025 item 7. Renewal is a new 90-day revision, never automatic. A solo Owner confirms alone; a team follows owner question 1.
3. **Expiry.** Notices go out 14 and 3 days before and at expiry. Then admission refuses mandate runs, and a running one ends at its next tool call.
4. **Revoke.** New `workspace.routine.revoke`: control, `human_only`, not review-required, held by the installation owner and the Owner; agents may only propose it. ADR-0011 Q8 extends to it: no reservation, never blocked by entitlement (ADR-0026 item 5). One audited transaction sets `revokedAt`, voids unclaimed approvals of the mandate's proposals and ends its running run; a claimed operation still finishes and reconciles.
5. **Hand-over.** When the installation owner leaves (P05.T01z) or loses a named grant, their mandates end and the Owner gets a "Take over" item: one item-2 transaction that moves ownership, re-issues grants and issues a new mandate.
6. **Admission and leases** (adds to ADR-0022 item 9). Only `admit_mandate_run`, executable only by `morrow_runtime_executor`, admits a mandate run, from the id of one server-held trigger row (a schedule, a verified webhook, an inbound mail, a monitor result or look-for-work) that names tenant, store and installation. In one transaction it checks the installation (`kind='installed'`), the mandate and trigger kind, stops, quiet hours, caps (taking the reservation) and one run per trigger key, then creates the run and a 30-minute lease. It is the only lease source for mandate runs, at admission and each resume, re-running every check. An unadmitted row stays pending and is retried at the next tick, never dropped, until its recorded expiry. Tool calls use `decideAutomation`.
   - **Look-for-work** is read-only: one pass per installation per day under ADR-0026 item 4's look-for-work cap, with read tools and suggestions only, never `proposal.create` or `computer.*` (new `lab:mandates` cases for each and for a second pass).
7. **The requester** (amends ADR-0011 Q1). A proposal's `requestedBy` is its run's requester, fixed at admission: the person who started it, or, for a mandate run, the installation as a new `MandateActorRef`. While the workspace has one active human member, the mandate owner is also conflicted on mandate-run proposals (checked at decision and dispatch), so a solo owner keeps the phrase and cool-down; in a team, an installer who holds the approve grants and did not edit may approve. The kernel still treats the mandate owner as requester.
8. **The editor is the author.** An edit is a new proposal by the editor, keeping `requestedBy` and `contextTaint`, with `editedFrom` in its digest and no later expiry. It voids the original's approvals and is refused once any family member is approved or claimed. It only changes present fields or drops targets.
9. **One typed confirmation per solo batch** (amends ADR-0011 Q3). A batch is 2 to 50 pending proposals of one capability and store, in a server-built document over their digests, bound to actor and session, 5 minutes, single use. Standalone sessions qualify, embedded member sessions only if ADR-0025 owner question 1 is accepted. The phrase sums N, C and A; it yields N approvals with one `effectiveAt`, one bad member refuses all, and teams batch without it.
10. **"Approval waiting" email.** A proposal with a pending life of 72 hours or less, still pending after 4 hours, sends each eligible viewer a fixed template (counts, earliest expiry, a token-free link), at most hourly. Each send is an ADR-0030 item 8 delivery, reconciled by ADR-0030 item 5(a) and (b) with the same key, never sent with a new key. In-app only until G7.
11. **Expired drafts are drafted again, never revived.** An expired mandate-run proposal gets one re-draft from fresh reads (owner question 3); "Draft again" starts a person's run. Mandate-run proposals expire no later than the mandate.
12. **Delivery.** T2's contracts come first. Items 1 to 6 are T4's mandates packet; 7 to 9 and 11 the review-rule packet; 10 lands in T6. Admission ships default-off and waits for G10 and its classes' G9. ADR-0031 sets retention.

## Security invariants touched

- **Tenant isolation:** admission takes only server-held row ids (`lab:tenant-conformance`, `lab:mandates`).
- **The intersection:** kernel unchanged; the owner's current grants bind every call (`agent-authority.test.mjs`, `lab:agent-authority-workers`).
- **Digest-bound approvals:** an edit is a new proposal; a batch is N digests (`review-policy.test.mjs`, `lab:approval-records`).
- **Checks in code:** requester, conflicts and admission (`lab:mandates`).
- **Unknown outcomes:** one key per notification (`lab:mail-send`).
- **Default deny; `human_only` stops:** no mandate, no run; revoke is `human_only` (`kill-switch.test.mjs`, `stops.test.mjs`).
- **No effect before the gateway:** admission off until G10 (`edge:check`, T3's gateway lab).
- **Immutable migrations:** forward only (`migration-history.test.mjs`).

**Looser on purpose,** accepted only by approving this record:
- In a team, an installer may approve their own agent's proactive work (decision 3).
- A compromised orchestrator could admit runs under any current mandate with a due trigger, within caps and producing only internal work and proposals. This widens ADR-0022 item 9's residual.
- Owner question 1, if accepted.

## Consequences

Merchants confirm agents every 90 days.

## Alternatives considered

- **Mandate owner as requester:** installers could never approve.
- **No one-member rule:** a solo owner would approve customer messages with one click.

## Owner questions

1. **In a team, may the Owner install an agent and issue or renew its mandate with no second reviewer?** A material authority change beyond ADR-0023's approval (see Amends). (a) Always; (b) only while no other member holds the mandate's store grants; (c) never. *Recommendation: (b):* at launch no second reviewer can exist, and it lapses once one can.
2. **Should internal proposals also send the 4-hour email?** *Recommendation: no;* the daily digest covers them.
3. **Automatic re-drafts per expired proposal?** *Recommendation: one.*

## Approval

Pending. The owner's answer will be quoted here verbatim with its date.
