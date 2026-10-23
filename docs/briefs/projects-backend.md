# Projects behind the scenes (PR 18): measured goals, areas, Quick tasks and the plan start

- Status: brief, 2026-10-24. Decisions: [ADR-0033](../decisions/adr/ADR-0033-work-model-v2.md) and [ADR-0034](../decisions/adr/ADR-0034-morrow-drafts-plans.md), accepted 2026-10-24 (OD-2026-10-24-1); field detail in [flow-contracts.md](flow-contracts.md). Tracks T2, T5 and T6 (`docs/plan/mvp.md`). Branch `claude/t2-t6-projects-backend`, from `claude/flow-adrs` (PR #49). Migration `0039` (the next free number; integration renumbers).
- Plan IDs: lettered children of P06.T01 (goal measures and the forward migration), P07.T03 (projects), P12.T04 and P14.T02 (the plan start), P13.T02 (`plan.draft`).

## Goal

The records and rules behind the project flow, with no screen and every switch off: a project is one goal record with 1 to 3 measured goals; values and health come from code, per viewer; Everyday work areas and Quick tasks come from a person's tap on a code-built card; Morrow's plan cards create nothing until the person who asked taps Start, which creates every piece in one transaction under that person's live permissions.

## Scope

- **Contracts (core v1.1, one appended block):** the declared supersets `Goal` (`dueAt`, `areaTemplateId`, never both) and `CriteriaList` (`key`, `measure`); `GoalMeasure`, `GoalMeasureValue@1`, `GoalProgress@1`, `EverydayAreaTemplate@1`, `PlanDraft@1`, `PlanStartDocument@1`, `ChoiceQuestion`; the five message part kinds, the `system` author, the `coordinator_turn` origin and the `coordinator` mention target with request `ask`; the `plan_started` event. Capabilities `workspace.goal.revise` and `workspace.goal.measure.record` (`internal_write`, `human_only`), and `workspace.routine.configure`'s input naming its goal record (and an alert's goal `key`).
- **Code (`packages/policy/src/projects/`), closed data and pure rules:** the area templates and measure lists (metrics, the 12-fact checklist, the four assistants); `GoalProgress@1` per viewer under read tags, customer-tagged values left out of everything but a permitted viewer's own read; Finish's results record; "Stop this project's steps" as a plan over existing controls; spend by project and helper; `plan.draft` (grants nothing, closed inputs, `report_in_context`); the Coordinator's launch tool subset (no `task.create`); the Ask rule and the @Morrow verbs; the plan start document and its refusals.
- **Migration `0039.projects-goal-measures.sql`** (as `morrow_work_owner`, forward only): `goals.due_at` and `goals.area_template_id`; the criteria CHECK replaced; `projects` (one per goal record, pinned by people); `goal_measure_values` and `goal_customer_values` (FORCE RLS, append-only, read tags, class clocks, the latter `content: customer` with a `customer_redact` handler); `plan_draft_revisions` and `plan_start_documents` (FORCE RLS); new definers `cmd_goal_revise`, `cmd_goal_measure_record`, `cmd_plan_start_document` and `cmd_plan_start`; `cmd_goal_transition`'s guards for Finish and `cmd_task_create`'s cap for area and Quick tasks records.
- **Work API (default off):** `POST /goals/:goalId/revise`, `POST /goals/:goalId/checks`, `GET /goals/:goalId/progress`, `POST /plans/start-document`, `POST /plans/start`. `docs/decisions/plan-drafts-staging.json` is committed `off`; the start routes answer 503 before any document, lock or record until `lab:plan-start` passes, and while the switch is off accept only code-built cards.

Not in this PR: conversations and messages persistence (T6), so the start posts no messages yet; routine tables and activation (T5); run admission for the specialist draft and ready agent steps (T4: the start reports each step `not_started` with its reason while the loop switch is off); the P06 task cancel edges, so Finish and Stop steps refuse any record with a task that has not ended; every screen (T7).

## Interfaces touched

`docs/contracts/schemas/v1.1/{core,capabilities}.schema.json`, `changes.json`, `release-baseline.json`, `event-registry.json`, `capabilities.{json,md}`, `permission-matrix.md`, `traceability.md`, `surface-parity.md`, `schema-types.json`, `collaboration.md`, `work-api.md`, `schedules.md`, `contract-versions.md`; the generated contracts; `packages/policy/src/projects/*`; `packages/work/src/projects/*`; `migrations/0039*` and the manifest; the tenant-conformance registry; `docs/decisions/plan-drafts-staging.json`.

## Security notes

- **Server-derived only:** start values (`startRef`), read tags, data classes, clocks, taint, restricted sources, the actor and the workspace. No body names a tenant, workspace, actor, grant, role or start value; a stored criterion with a non-null `startRef` fails the CHECK.
- **People only:** `workspace.goal.revise` and `workspace.goal.measure.record` are `human_only`; no tool writes a goal record, value, target or date. `plan.draft` grants nothing and creates no record but the card.
- **The plan start:** issued only for a digest the server holds, to the asker (or the person who opened a code-built card), on a standalone-workspace session; 5 minutes, single use, its nonce stored as a digest. The start re-runs the human kernel for every piece under live grants and the definer rechecks authority under lock; any refusal rolls everything back. It never admits a run.
- **Customer data:** a value from sources tagged `support.case.read` lives only in `goal_customer_values`, expires with its cases, and never reaches a goal record, a `project_update` or the Coordinator's context.

## Test checklist

- [ ] `tests/contract-versioning.test.mjs`: Goal and CriteriaList declared supersets; `tests/collaboration-contracts.test.mjs`: the new parts, author, origin and mention.
- [ ] `tests/projects-progress.test.mjs`: health in both directions, the 25% rule, hand checks, per-viewer visibility, customer values.
- [ ] `tests/plan-draft.test.mjs`: closed inputs, grants nothing, `report_in_context`, launch subset, Ask rule, @Morrow verbs.
- [ ] `tests/plan-start.test.mjs`: eligibility (non-asker, agent, embedded and email sessions), expiry, reuse, unknown digest, stale grants, a revoked grant, a Member without `workspace.project.create`, a tainted edit keeping its taint.
- [ ] `tests/projects-migrations.test.mjs` and `lab:work-postgresql` cases: a client-sent start value, `achieved` without Finish's record, more than 200 ended tasks under an area, FORCE RLS on every new table.
- [ ] `policy.test.mjs` (both capabilities `human_only`), `migration-history.test.mjs`, `edge:check` (the switch off).
- [ ] AI review (separate context, same model family); hosted CI on the PR head.
