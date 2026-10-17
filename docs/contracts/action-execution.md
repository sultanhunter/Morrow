# External action execution

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P11.

## Shape and ownership

Schemas: Proposal, Approval, Operation, Reservation. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

An immutable proposal selects exact account/resources fields parameters expected provider versions and maximum cost. The action service rechecks identity policy field/source authority preconditions budget and applicable review before dispatch. Operation ID remains stable; provider request and attempt IDs are separate. Parameter references carry immutable digests. Coordinate overlapping resource writes using versioned leases and provider preconditions. Unknown outcomes reconcile before replay. Verification checks the declared readback; partial outcomes remain separate child operations.

## Failure invariant

Changing store selection cannot retarget an existing proposal or operation. Provider success without matching postconditions cannot be marked verified. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
