# Model routing and data contracts

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P13.

## Shape and ownership

Schemas: RunManifest, PolicyDecision, RuntimeProfile. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Gate model/provider selection by permitted data classes regions retention modalities quality and cost. Normalize responses failures finish reasons and usage with explicit provider trace IDs. External inference runs as orchestrator activities, never deterministic workflow replay. Route high reasoning only where evaluated quality justifies cost. Required/optional capabilities are resolved before activation. Provider policy is selected in P01.T03; for the MVP, ADR-0022 selects Anthropic Claude behind a provider-neutral `ModelProvider` port, with a versioned catalogue of models and efforts in `docs/decisions/model-policy.json` that the server validates (callers never send provider model strings). The broker reads a run's selection and catalogue version from the run, keeps the provider request and model IDs in a broker-internal adapter result and records them in the run manifest as the provider trace IDs; `ModelResult@1` stays provider-neutral with an opaque `traceRef`.

## Failure invariant

Private customer data cannot be routed to an unapproved provider merely because a fallback model is available. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
