# Shopify projection and reconciliation

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P09.

## Shape and ownership

Schemas: StoreInstallation, SnapshotRef, Evidence. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Pin the Admin GraphQL version after P01.T03 qualification. Authenticate Shopify entry using supported server flows. Minimum/optional scopes are feature-specific. Bulk bootstrap tracks checkpoints while webhooks persist into a deduplicated inbox; verify raw-body signature first. No webhook delivery/order assumption: reconcile authoritative reads and maintain tombstones. Order-age and protected-data gaps remain coverage rather than invented facts. Refresh races serialize per credential version.

## Failure invariant

Late update cannot resurrect a deleted product; scope changes block affected reads/writes immediately. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
