# Governed metrics

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P10.

## Shape and ownership

Schemas: Money, Period, MetricDefinition, MetricPoint. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Use decimal strings, explicit currency and source amounts; no floating-point money or implicit FX. Periods have start/end-exclusive instants timezone provider basis and daylight-saving-aware interpretation. Net revenue margin refunds returns fees and attribution follow versioned definitions. Missing data yields null with coverage or an explicit evidenced estimate. Overlapping provider attribution cannot be summed into unique revenue.

## Failure invariant

US dollars and euros remain separate without an evidenced conversion; an observed revenue increase alone is not causal uplift. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
