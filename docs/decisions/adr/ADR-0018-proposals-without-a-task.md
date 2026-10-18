# ADR-0018 Proposals without a task: human governance proposals only

- Status: Accepted
- Date: 2026-10-18
- Refines: ADR-0011 Q1 (the derivation of `requestedBy`) and the contract v1.1 candidate Proposal@2 (P01.T02a PR-B)
- Affects: P01.T02a (a follow-up candidate edit), P06.T01b (`proposals.task_id`), P05.T01z and P05.T02a (task-less access_change producers), P05.T04b and P11.T01 (agent proposers), `docs/contracts/{schemas/v1.1/core.schema.json, approvals.md}`, `packages/policy/src/review.ts`

## Context

Proposal@2, merged with P01.T02a PR-B, requires `taskId`, and ADR-0011 Q1 derives `requestedBy` as "the task initiator or mandate owner". The first real producers are governance changes: invitations, template changes and ownership transfers (P05.T01z) and grant issuance (P05.T02a). They have no work task, and an owner on grant template v1 does not hold `workspace.task.create` at all. Packet P06.T01b raised this as Q1. It recommended a nullable `taskId` for human proposers, over making every producer create a governance goal and task (which would need template v2 work grants and put governance items in work lists).

## Decision

1. **`taskId` may be null only for a human-made governance proposal.** That means both of these hold:
   - `proposedBy` is a human actor;
   - the proposal's capability is in the catalogue's Governance domain (the `governance.*` capabilities).
2. **Agents always need a task.** A proposal proposed by an agent, or by any other non-human actor, must carry a non-null `taskId`, including work under a mandate. The schema rejects a null `taskId` for a non-human proposer, and the review library rejects a null `taskId` outside item 1.
3. **`requestedBy` is the proposer when there is no task.** With a task, ADR-0011 Q1 is unchanged: `requestedBy` is the task initiator or mandate owner. Without one, `requestedBy` equals the human proposer, so the proposer stays in the conflict set in both roles.
4. **Derived proposals** inherit `taskId`, null included, as they inherit the conflict set.
5. **Delivery.** The edit to Proposal@2 is a deliberate candidate edit while v1.1 is a candidate: `taskId: Id | null` with the item 1-2 rule, the `checkProposal` derivation of item 3, fixtures and the baseline hash update. It lands as a routine follow-up PR implementing this ADR before P06.T01b PR-1 merges. If v1.1 has been frozen by then, the change opens v1.2 instead. P06.T01b drops `NOT NULL` on `proposals.task_id`, adds a CHECK that allows null only for a Governance-domain capability with requester equal to proposer, and skips the task-attach check when the task is null.

## Consequences

- P05.T01z PR-B and P05.T02a can submit access_change proposals without creating work items.
- P06.T01b Q1 is resolved; its `task_id` column follows item 5.
- Agent proposals, which arrive with P05.T04b and P11.T01, are unaffected: they always name a task.
- Governance proposals made by humans stay reviewable without a task: approvals, conflict-set and solo-owner rules (ADR-0011) apply unchanged.

## Alternatives considered

- **Keep `taskId` required.** Each producer would create a governance goal and task. That needs template v2 work grants for every reviewer and owner and puts governance items into work lists.
- **Null for any human proposer.** Broader than needed; the owner limited it to governance proposals.

## Approval

Owner approval, 2026-10-18, in chat. Asked about P06.T01b Q1 (proposals without a task), the owner selected **"Allow, human-only (Recommended)"**:

> taskId optional only for human-made governance proposals; agents always need a task.

Items 1 and 2 restate the answer. Item 3 is the packet's recommended `requestedBy` rule, which the recommended option carried. Items 4 and 5 follow from them and from the P01.T02a versioning rules.
