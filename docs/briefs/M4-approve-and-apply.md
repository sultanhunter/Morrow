# M4 Approve and apply

- Status: brief, 2026-10-19. Spine: [mvp-architecture.md](mvp-architecture.md) §2 steps 10–14, §8, §10. Material choices: ADR-0022 items 1–3 and 7 (Proposed). Full packet recommended (security-heavy: approvals, gateway, durable execution; CLAUDE.md "New work uses a one-page brief").
- Plan IDs: P06.T01c, P08.T03a, P11.T01a–T03a, P11.T05a, P14.T03a; the P06.T01b PR-2 routes. Branch `claude/m4-approve-and-apply`, after M2 and M3; two PRs.

## Goal

A merchant reviews a per-product diff, approves the exact proposal (or a subset of its products), and applies it. The gateway rechecks authority, entitlement and stops, records one OperationLedger operation per product, writes through the broker, reads each product back and leaves an audit trail. An unknown outcome is reconciled by readback, never by a blind retry.

## Scope

- **PR-1, ledger and gateway:** `operations` and `operation_transitions`; `POST /workspace/:ws/work/proposals/:proposalId/apply`; `OperationWorkflow`; broker `shopifyProductUpdate`; reconciliation and the aging alert; stop commands for `agents.installation.disable` and `governance.connection.disconnect`; the owner-run platform and capability stop script; the spend breaker; `dispatch_disabled` lifted in `apps/workers/src/orchestrator.ts` only when this PR's tests pass.
- **PR-2, review and history UI:** the P06.T01b PR-2 routes (`GET /approvals`, proposal read and preview, decide); `/w/:ws/review/:proposalId` with the per-product diff, item selection, approve, reject and apply; run and operation history on `/w/:ws/work/:taskId`; exceptions at `/w/:ws/inbox/exceptions/:operationId`; a "Stop AI work" control in settings.

## Non-goals

Automatic resubmission; cancel flows (`cancel_requested`); variant, price, media or collection writes; scheduled or agent-initiated applies; notification email; the untrusted-content rule.

## Interfaces and data touched

- **Reused:** `decideApproval`, `prepareApprovalClaim` and `morrow_work.approval_claim` (consumer name `catalog.content.publish`, claimant a human with `execute`); `projectApproval`; `dispatchCheck` and `effectiveRule` (`packages/policy/src/review.ts`); `isPaidWork` and `createBillingConstraintsReader`; `checkKillSwitchTarget`; the operation and run machines in `docs/contracts/state-transitions.json`; `Operation@1`; `outbox_events`.
- **Changed:** `prepareApprovalClaim` and `approval_claim` accept store-bound `catalog.*` proposals (today a non-null `storeId` returns `DIGEST_MISMATCH`), with per-target evaluation: the claimant's grant must cover every selected product's fields on that store.
- **Apply request:** `{proposalRef, approvalRef}` with an `Idempotency-Key`. Response: `{claimId, operations: [{operationId, targetIndex, status}]}`. A replay returns the same operations (the claim's `consumer_command_id`).
- **Operation read:** `GET /workspace/:ws/work/operations/:operationId` returns status, transitions and readback result (fields and verdict, not content).

## Flow

1. **Review:** the screen loads the proposal, its parameters and the snapshots named by each target's `expectedSourceRevision`, then shows before and after per field. A reviewer with `approve` on `governance.approval.decide` and on `catalog.content.publish` approves all products or a selection (a derived proposal and digest, P06.T01b). Risk `external` allows self-approval (ADR-0011 Q3).
2. **Admission (api, one transaction):** human kernel for `execute` on `catalog.content.publish` covering the targets; entitlement (paid work); no stop on platform, workspace, installation, connection or capability; the proposing installation is active; the store link and installation are current. Then `approval_claim`, one `operations` row per target (`planned → authorized`), an operation lease, and an outbox row.
3. **Dispatch (`OperationWorkflow`, `id = claimId`), per target:**
   1. Recheck stops, the claimant's grants and the entitlement.
   2. Reread `productContent`; if the digest differs from `expectedSourceRevision`, move to `conflict` with no write.
   3. Move to `dispatching`, then call `shopifyProductUpdate`. The broker verifies the operation and lease through `resolve_call`, loads the approved values from the claimed parameters, and sends only the approved fields (tags as the full approved list).
4. **Outcome:** a response is `submitted`; `userErrors` is `failed` (`verified_no_effect`); a timeout or transport loss after send is `uncertain` (`transport_after_dispatch`).
5. **Verify:** reread. Every approved field equal → `verified`. Every field equal to the snapshot → `failed`. Otherwise `uncertain` (`partial_result`) and an inbox exception.
6. **Close:** release the lease, write outbox events (`operation.verified`, `operation.failed`, `operation.uncertain`), and show the per-product result on the task screen.

## Security notes

- **Approval is bound to the exact digest (invariant 7):** an edit means a new proposal; the claim checks the approval ref digest, the proposal digest, the capability and every counted reviewer's current eligibility (`REVIEWER_AUTHORITY_LOST`), then consumes the family once.
- **Permission is not approval (invariant 6):** the claimant needs its own current `execute`; an approval confers nothing.
- **Reconcile before retry (invariant 10):** no state leaves `uncertain` except through readback (`uncertain → verifying` or `uncertain → failed` with `verified_no_effect`); the MVP never resubmits.
- **No agent effect before controls (invariant 15):** dispatch stays hard-disabled until the stop, reservation and gateway tests pass. The broker also refuses any write that is not a `dispatching` operation under a live lease with no stop.
- **Kill switches (invariant 14, ADR-0005):** human-only, a reason, a `KillSwitchRecord`, no second approver, never blocked by balance or entitlement.
- **Residual race:** Shopify has no conditional product update, so a merchant edit between the reread and the write can be overwritten. It is detected at readback (`partial_result`) and surfaced, and the brief and UI say so.

## Test checklist

- [ ] Stale approval, edited proposal, wrong reviewer, reviewer who lost a grant, expired approval, second claim of a family → no operation.
- [ ] Concurrent apply with the same and with different idempotency keys → one claim, one operation set.
- [ ] A stop set between admission and dispatch, and between reread and write → no write; leases revoked.
- [ ] Recorded Shopify fixtures: success, `userErrors`, a timeout after send, a 5xx response, a concurrent edit → the expected terminal or uncertain states; never two writes for one operation.
- [ ] Broker refusal: an operation not `dispatching`, a foreign lease, a revoked installation, parameters that differ from the claim → held, with no provider request.
- [ ] The aging alert fires for an operation uncertain for more than 15 minutes.
- [ ] UI: keyboard and screen-reader review; escaped HTML source; sandboxed preview; axe at 1440, 768, 390 and 320 px.
- [ ] End-to-end lab (workerd, PostgreSQL 17, recorded fixtures), then a development-store smoke under owner approval with a `docs/evidence/live/` record.

## Owner actions

1. Approve ADR-0022 items 1–3 and 7.
2. Approve each development-store write run (or a staging card that covers them) and each staging use of the test seed.

## Open questions

- Should "Approve" and "Apply" be one button for a solo owner? The recommendation is yes in the UI; it remains two server commands.
