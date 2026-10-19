# M4 Approve and apply

- Status: brief, 2026-10-19 (revised after critique). Spine: [mvp-architecture.md](mvp-architecture.md) §2 steps 10–14, §5, §8, §10. Material choices: ADR-0022 items 1–3, 7 and 9 (accepted 2026-10-19). Full packet recommended (approvals, gateway and durable execution are security-heavy; ADR-0021 item 5).
- Plan IDs: P06.T01c, P08.T03a, P11.T01a–T03a, P14.T03a; the P06.T01b PR-2 routes. Branch `claude/m4-approve-and-apply`, after M2 and M3; two PRs.

## Goal

A merchant reviews a per-product diff, approves the exact proposal (or a subset of its products), and applies it. The gateway rechecks authority, entitlement and stops, records one operation per product, writes each product at most once through the broker, reads it back and leaves an audit trail. An unknown outcome is reconciled by readback, never by a resend.

## Scope

- **PR-1, gateway:** claim and dispatch behaviour on the M2 `operations` table; `POST /workspace/:ws/work/proposals/:proposalId/apply`; `OperationWorkflow`; broker `shopifyProductUpdate` (send fence) and `shopifyReconcileRead`; the lease-backed claimant authority in `packages/policy`; reconciliation and the aging log; `OperationWorkflow` enabled in `apps/workers/src/orchestrator.ts` only when this PR's tests pass.
- **PR-2, review and history UI:** the P06.T01b PR-2 routes (`GET /approvals`, proposal read and preview, decide); `/w/:ws/review/:proposalId` and a task's list of proposals; run and operation history on `/w/:ws/work/:taskId`; exceptions at `/w/:ws/inbox/exceptions/:operationId`.

## Non-goals

Automatic resubmission; cancel flows (`cancel_requested`); variant, price, media or collection writes; scheduled or agent-initiated applies; notification email.

## Interfaces and data touched

- **Reused:** `decideApproval`, `prepareApprovalClaim`, `morrow_work.approval_claim` (consumer `catalog.content.publish`, claimant a human with `execute`); `projectApproval`; `dispatchCheck`, `effectiveRule` (`packages/policy/src/review.ts`); `isPaidWork`, `createBillingConstraintsReader`; `checkKillSwitchTarget`; the operation machine in `docs/contracts/state-transitions.json`; `Operation@2`; `outbox_events`.
- **Changed:** `prepareApprovalClaim` and `approval_claim` accept store-bound `catalog.*` proposals (today a non-null `storeId` returns `DIGEST_MISMATCH`) and refuse redacted parameters. The kernel runs on the store resource with the union of the selected targets' fields, and code checks every target's store and connection.
- **New in `packages/policy`:** a lease-backed human authority for dispatch: membership, grants and policy revision are current, and the operation lease is current. It never sets `sessionCurrent`.
- **Apply request:** `{proposalRef, approvalRef}` with an `Idempotency-Key`; response `{claimId, operations: [{operationId, targetIndex, status}]}`; a replay returns the same operations (`consumer_command_id`).
- **Operation read:** `GET /workspace/:ws/work/operations/:operationId`: status, transitions, readback verdict (fields and digests, not content).

## Flow

1. **Review:** the screen loads the proposal, its parameters and the snapshots named by each `expectedSourceRevision`, and shows before and after per field. Tag changes are marked as functional; contact and URL flags from M3 are shown. A reviewer with `approve` on `governance.approval.decide` and `catalog.content.publish` approves all products or a selection (a derived proposal, P06.T01b). Risk `external` allows self-approval (ADR-0011 Q3). "Approve all" on a task records one digest-bound decision per proposal.
2. **Admission (api, one transaction):** human kernel for `execute` on `catalog.content.publish`; entitlement (paid work); no platform, installation or connection stop; the proposing installation active; link and installation current. Then `approval_claim`, one operation per target (`planned → awaiting_approval → authorized`), an operation lease, and a dispatch Queue message with the claim id.
3. **Dispatch (`OperationWorkflow`, `id = claimId`), one target at a time:**
   1. Recheck stops, the lease-backed claimant authority and the entitlement. An uninstalled store or a lost link → `authorized → conflict`.
   2. Reread `productContent`; a digest that differs from `expectedSourceRevision` → `conflict`, no write.
   3. Move to `dispatching`, then one step with retries disabled calls `shopifyProductUpdate`. The broker checks the operation and lease through `resolve_call`, fences the send (spine §8), loads the approved values from the claimed parameters and sends only the approved fields (tags as the full approved list; both SEO fields together).
4. **Outcome and readback:** as in spine §8. `submitted → verifying → verified`; `userErrors` or a proven non-send → `failed`; anything unknown → `uncertain`, then reconciliation by readback.
5. **Close:** release the lease, write outbox events (`operation.verified`, `operation.failed`, `operation.uncertain`), show the per-product result on the task screen.

## Security notes

- **Approval is bound to the exact digest (invariant 7):** an edit means a new proposal; the claim checks the approval ref digest, the proposal digest, the capability and every counted reviewer's current eligibility, then consumes the family once.
- **Permission is not approval (invariant 6):** the claimant needs its own current `execute`. Sign-out does not stop a claimed apply; membership removal, grant revocation or a stop does (ADR-0022 item 9).
- **Reconcile before retry (invariant 10):** the broker's send fence allows at most one send per operation, whatever the Workflow retries; any exception after the fence is `uncertain`; only readback leaves `uncertain`.
- **No agent effect before controls (invariant 15):** `OperationWorkflow` stays disabled until the gateway tests pass. The broker also refuses any write that is not a fenced `dispatching` operation under a live lease with no stop.
- **Kill switches (invariant 14, ADR-0005):** human-only, with a reason and a `KillSwitchRecord`, no second approver, never blocked by balance or entitlement.
- **Residual race:** Shopify has no conditional product update, so a merchant edit between the reread and the write can be overwritten. Readback detects it (`partial_result`), and the UI says so.

## Test checklist

- [ ] Stale approval, edited proposal, wrong reviewer, reviewer who lost a grant, expired approval, second claim, redacted parameters → no operation.
- [ ] Concurrent apply with the same and with different idempotency keys → one claim, one operation set.
- [ ] A stop between admission and dispatch, or between reread and write → no write; leases revoked. Sign-out mid-apply → the apply continues; membership removal → it stops.
- [ ] Fault injection: the broker sends, the RPC throws, the step reruns → exactly one Shopify write, operation `uncertain`, then readback.
- [ ] Recorded Shopify fixtures: success; `userErrors`; `THROTTLED` then success; 401; timeout after send; 5xx; concurrent edit; a write Shopify normalises (tag order and case, HTML whitespace) → the expected states, never two writes.
- [ ] Reconciliation: a lease expired before readback → readback still runs; uninstall during `uncertain` → stays `uncertain` with `verification_unavailable`; a stop never blocks readback.
- [ ] Broker refusal: an operation not `dispatching`, a send already started, a foreign lease, a revoked installation → held, no provider request.
- [ ] UI: keyboard and screen-reader review; escaped HTML source; sandboxed preview; axe at 1440, 768, 390 and 320 px.
- [ ] End-to-end lab (workerd, PostgreSQL 17, recorded fixtures), then a development-store smoke under owner approval with a `docs/evidence/live/` record.

## Owner actions

1. Approve each development-store write run (or a staging card that covers them).

## Open questions

- None. A solo owner gets one "Approve and apply" button that sends two server commands, the decision and then the claim ("One button", 2026-10-19; ADR-0022 item 3).
