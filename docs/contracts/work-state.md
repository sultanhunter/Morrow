# Work and execution state

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P06.

## Shape and ownership

Schemas: Goal, Task, Run, Question, Operation. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

PostgreSQL owns intent, records and revisions; orchestration owns execution progress. Every mutation names commandId request digest expected revision and actor. Same commandId plus same digest returns the original result; another digest conflicts. Validated write and outbox event commit in one transaction. Takeover increments lease generation and invalidates older executors. Completion requires accepted artifacts and evidence, never model self-report alone. Early question answers are stored before workflow wait attachment and resume idempotently. Cancellation stops new dispatch, reconciles submitted jobs and liabilities, then reaches a terminal state.

## Failure invariant

Two concurrent writes at the same expected revision produce one winner and one conflict. Cancellation cannot hide a submitted refund or generation job. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.

## Binding notes (P06.T01a, ADR-0010)

- **Idempotency keys are per actor.** A command is identified by (organization, workspace, actor principal, command ID). The same key value from two actors is two commands; neither can replay or disclose the other's. A replay needs only the actor's current session plus `view` on the aggregate's read capability (field `status`), never ownership.
- **Request digest.** `sha256(canonicalJson(["morrow.work.command", 1, type, workspaceId, pathIds, body]))`, with object keys sorted at every depth: a reordered or re-spaced body replays, any other change conflicts.
- **Unknown outcomes.** A lost reply after the command function or COMMIT was sent is `uncertain`; the same-key retry is the reconciliation. The `commands` row commits atomically with the effect.
- **Derived `taskIds`.** `Goal.taskIds` is derived from the goal's tasks, so creating a task does not bump the goal's revision; clients refetch the goal on `task.created`.
- **v1 reach.** Tasks reach only `draft` and `ready`; `blocksTask` is always false and `expiresAt` always null until P06.T03. The v1.1 task cancel rows (`draft→cancelled`, `ready→cancelled`) are persisted by a later P06 migration together with their route; until then a goal with tasks cannot be cancelled. `active→achieved` fails `guard_failed` until P07/P11.
- **Published caps.** 10,000 goals per workspace, 200 tasks per goal and 50 open questions per task (`limit_reached`). The HTTP contract is `docs/contracts/work-api.md`.
