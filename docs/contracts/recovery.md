# Restore and deletion recovery

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P04/P18.

## Shape and ownership

Schemas: EventEnvelope, Operation, RetentionPolicy. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Backups restore authoritative records and object metadata consistently; orchestration and external effects require reconciliation. After restore replay membership/connection/release revocations subject deletion and tombstones before dispatch. Provider receipts remain idempotency/reconciliation evidence. Unknown outcomes cannot be retried as fresh work. P01.T03/P01.T04 settle RPO RTO retention and launch targets; P04/P18 measure them.

## Failure invariant

An old backup must not reactivate revoked permission or resurrect a deleted customer record. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
