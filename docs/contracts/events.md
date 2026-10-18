# Event and stream contracts

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P06.

## Shape and ownership

Schemas: EventEnvelope, CommandEnvelope, ErrorEnvelope. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Event IDs deduplicate delivery. Aggregate revisions order mutations; opaque stream positions support authorized resumption and are never compared as timestamps. An outbox and receiving inbox persist before acknowledgement. Event payloads are permissioned references, not raw private records in workflow history. Consumers detect revision gaps and reconcile from authoritative records. Reconnecting clients request from their last server-issued position under current membership.

## Failure invariant

Duplicate delivery cannot repeat an operation; missing intermediate revisions trigger reconciliation. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.

## Binding notes (P06.T01a, write side only)

- **Ordering scope.** Outbox positions are gap-free and commit-ordered **per workspace**: each command appends under its workspace's stream lock, which it holds until COMMIT. Aggregate revisions order each aggregate; every aggregate revision has exactly one event. No order across workspaces is promised.
- **Payload allowlist.** Payloads carry IDs and statuses only, enforced by a database CHECK: `goal.created` `{status}`; `goal.status_changed` and `task.status_changed` `{from,to}`; `task.created` `{goalId,status}`; `task.assigned` `{assignmentId,ownerPrincipalId}`; `question.requested` `{respondentPrincipalId}`; `question.answered` `{answerId}`; `question.cancelled` `{}`. Objectives, criteria, prompts and answers never enter the outbox.
- **Deferred.** The EventEnvelope mapping, `payloadRef`, readers, cursors and delivery belong to P06.T02a; `causation_id` is null for human commands.
