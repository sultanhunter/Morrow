# Identity and authority

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P05.

## Shape and ownership

Schemas: ActorRef, Scope, Grant, PolicyDecision. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Trusted identity resolves organization/workspace membership. Installation tokens are provider authority, not human authority. Effective permission is the intersection of current human/automation owner, initiating task envelope, installation grants, resource/field grants, provider constraints and policy. Verbs view/propose/approve/execute/delegate/administer are distinct. No wildcard grants in this baseline. Declared ownership/responsibility never grants access. Revocation increments policy revision and invalidates cached allow decisions before later retrieval or dispatch.

## Failure invariant

Wrong-tenant identifiers return a redacted denied result. Reviewer cannot approve an action to which no eligible execution grant exists. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
