# Routine scheduling

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P12.

## Shape and ownership

Schemas: Schedule, AutomationMandate. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Schedules preserve IANA timezone and define daylight-saving behavior, overlap policy, missed-run policy, maximum parallelism and bounded catchup. Activation requires current mandate. Default disabled until configuration. An active routine can emit work only inside its explicit stores/account scope and cannot manufacture approval. Deactivation stops new dispatch and reconciles active jobs.

## Goal records (ADR-0033 item 8; PR 18)

A routine or recurring task names its goal record (`workspace.routine.configure`'s `goalId`), and an alert also the goal's `key` (`goalKey`), so repeating work lives in its project, area or Quick tasks. Moving one is a person's act. A configure revision of an active routine leaves it `disabled` and never activates it; only `workspace.routine.activate` (`human_only`, ADR-0011 Q9's access-change gate) turns one on. A plan start creates an agent's repeating task as a routine configured disabled (ADR-0034 item 5(c)).

## Failure invariant

A schedule burst does not create unbounded child tasks or duplicate a missed occurrence. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
