# Collaboration and human takeover

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P07/P14.

## Shape and ownership

Schemas: ArtifactAnchor, ArtifactRevision, Task. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Comments name artifact ID and exact revision. Text ranges, stable row/column IDs and normalized image regions are validated per anchor kind. Presence is transient and does not confer access. Human takeover atomically changes owner/lease generation before dispatch. Notifications are derived from authoritative events and permission-filtered at read time. Offline drafts retain their base revision and cannot silently overwrite current content.

## Failure invariant

An agent with an older generation cannot continue edits after takeover; invalid anchors become repairable conflicts. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
