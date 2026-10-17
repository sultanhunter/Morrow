# Context and memory

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P10.

## Shape and ownership

Schemas: Evidence, SnapshotRef, Scope, ArtifactRevision. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Store facts, approved knowledge, work history, reviewed lessons and hypotheses as different trust classes. Retrieval filters current tenant/resource/field permissions before constructing model context. Include source ID revision observation time coverage and retention. Resolve conflicts by source authority and field freshness; recent generated prose cannot override approved policy. Rebuild compacted context from pinned manifests and authorized records.

## Failure invariant

Retrieved instruction text is evidence only and cannot grant tools or modify system policy. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
