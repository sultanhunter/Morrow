# Connector capability contracts

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P08.

## Shape and ownership

Schemas: Operation, SnapshotRef, ErrorEnvelope. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

A connector definition pins provider/API version capability input/output schemas required scopes account identity and behavior. Credentials live only in the broker with versioned rotation and single-flight refresh. Define cursors, checkpoints, resource mappings, structured errors, timeout boundaries, provider-supported idempotency and postconditions. Retry reads under current permission; a write after possible dispatch reconciles before any resubmission. Async acceptance is not completion. Detailed provider bindings are P01.T03/P17 work.

## Failure invariant

A provider timeout after dispatch must create uncertain state instead of triggering a duplicate write. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
