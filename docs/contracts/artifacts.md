# Artifact ownership and revision contracts

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P07.

## Shape and ownership

Schemas: ArtifactRevision, ArtifactRef, Evidence, RetentionPolicy. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Content is stored separately from authoritative metadata. Uploading/processing assets cannot be treated as ready. Each immutable revision binds digest parent source records restrictions schema and author. Working drafts and shared revisions retain distinct visibility. Derived artifacts inherit underlying resource restrictions. Concurrent patch uses expectedRevision and an explicit diff; a conflict preserves both drafts for eligible resolution. Deleted/quarantined sources invalidate affected retrieval and release paths.

## Failure invariant

A finance report cannot expose costs to an SEO user through a shared summary; source restrictions survive export. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
