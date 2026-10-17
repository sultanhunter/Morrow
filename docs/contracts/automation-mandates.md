# Automation mandates

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P05/P12.

## Shape and ownership

Schemas: AutomationMandate, Grant, Budget. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Every routine and agent run binds its owner, permitted capabilities/resources/fields, budget, review policy, start, expiry and revocation. Delegation intersects the parent envelope, maximum depth and child count. Dispatch after waits rechecks the current owner and installation; offline provider credentials alone cannot permit action. Expired or revoked mandates suspend dispatch and questions explain how eligible owners can repair them.

## Failure invariant

A revoked owner cannot keep a scheduled agent active through a stored token or delegated child. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
