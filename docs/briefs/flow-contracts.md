# Flow contracts (track T2): goal measures, plan drafts and the plan start

- Status: draft brief, 2026-10-23. It waits on the owner's approval of [ADR-0033](../decisions/adr/ADR-0033-work-model-v2.md) and [ADR-0034](../decisions/adr/ADR-0034-morrow-drafts-plans.md) (both proposed, on the W0 flow sheet `docs/decisions/decision-sheet-2026-10-26-flow.md`); nothing that depends on them merges before. The decisions are material and live in the two ADRs. This brief holds only the field-level detail they leave to T2, which T2's contract PRs may refine within the ADRs by routine commits.
- Plan: `docs/plan/mvp.md` tracks T2 (W1, 2026-11-02 to 2026-11-06), then T4, T5, T6, T7 and T12. Contracts are generated closed, with fakes and no runtime eval or schema compilation.

## Goal

The contracts behind the core flow: projects with measured goals, Everyday work and Quick tasks, Morrow's plan cards and the person-bound plan start, landed with fakes before the tracks that consume them.

## Scope

**Goals and measures (ADR-0033 items 1 to 8).**
- `Goal`: `dueAt` (UtcTime or null) and `areaTemplateId` (a template id or null), never both; project commands refuse a record with neither. Quick tasks uses `quick_tasks`.
- `CriteriaList` items: `key` (`^[a-z][a-z0-9_]{0,31}$`, unique in the record) and `measure` (`GoalMeasure` or null). At most 3 measured criteria; every project criterion has a measure except Quick tasks' hidden one. The work API keeps its cap of 20 criteria.
- `GoalMeasure`: `kind`, `target`, `dueAt` (null, or no later than the record's) and `startRef`, which the server sets to the goal's first `goal_measure_values` row and no request body carries. `metric`: `metricId` from T5's catalogue (`MetricDefinition`, `metrics.md`). `checklist`: `checklistId` and `productIds` (0 to 20; none means every active product). `manual`: `assistant` (closed list), `cadenceWeeks` (1 to 13) and `rows` (1 to 20), each a `productId` with `checkItems` (1 to 10 questions).
- `GoalMeasureValue@1`: goal record, `key`, `productId`, value, `observedAt`, recorder, `assistant`, `counted`, `readTags`, data class and `expiresAt` where the class has a clock. A hand check takes one answer per question from a closed set: named this product, named other shops only, named no shop.
- `GoalProgress@1`, per viewer: today's value with its source and time, a health word and a reason code; the reason sentence comes from a fixed template.
- `EverydayAreaTemplate@1`, per first-party release: label, goal with its measure, direction and On-track threshold, and default repeating tasks (off).
- Health rules for T5, beyond ADR-0033 item 4: a hand-checked goal is judged only on check dates ("Not checked yet", then "Starting point", then words); an overdue check shows "Check overdue since [day]"; a launch milestone shows "Not started" before its date; a step unmoved for 3 days shows "No progress since [day]"; Home's counts add To review, Questions and Your tasks.
- Forward migrations: the criteria CHECK; `goals.due_at` and `goals.area_template_id`; `goal_measure_values` (FORCE RLS, `read_tags`, class clocks); a `content: customer` table for customer-tagged values with its `customer_redact` handler; `cmd_goal_transition`'s guards for Finish; `cmd_task_create`'s cap for area and Quick tasks records.
- `work-api.md`: goals validated with the current definition (not v1, which would answer 503 for a measured goal); candidate routes `POST /goals/:goalId/revise`, `POST /goals/:goalId/checks` and `GET /goals/:goalId/progress`, named finally by T2.
- Schedules: the schedule contract and `workspace.routine.configure`'s input gain the goal record id, and monitors also the goal's `key`; a configure revision of an active routine leaves it `disabled` and never activates.
- Sources (ADR-0033 item 10): `sources`, per prose field and per sentence, 1 to 4 wrapped-input ids or `wordingOnly`, in ListingDraft@2, CatalogContentChangeSet@2 and `creative.media.attach`'s alt-text input.

**Plan drafts and the plan start (ADR-0034).**
- ToolCatalogue@1: `plan.draft` (capability `workspace.conversation.post`, verb `execute`, internal-write replay class, 8 KiB result bound); `message.post` accepting `choice_question` from the Coordinator only; `agent.route` accepting an Ask target; the launch Coordinator subset without `task.create`; the refusal `report_in_context`.
- PlanDraft@1: kind (`project`, `task`, `repeating`, `plan_change`). Model fields: title (2 to 6 words), why line, "Done when", 1 to 3 goals (measures from ADR-0033's lists; for a hand check 1 to 10 questions and an assistant), 1 to 8 steps (title, assignee kind: person, active added agent, specialist step or code; dependencies; optional repeat rule) and the target (new or existing project, area or Quick tasks; a plan change names the project's revision). Code fields, per viewer: today's values, credit range and balance, helper permissions, related work, who will see it.
- Choice questions: 2 to 8 options plus "Something else…" and "Skip, you decide"; code fills product and date pickers; Morrow sees only the tapped answer.
- `plan_draft_revisions` (FORCE RLS): message id, revision, digest, editor, `contextTaint` and `restrictedSources` kept from the original.
- PlanStartDocument@1 in `plan_start_documents` (FORCE RLS). Routes, in the pattern of the Listings document routes: `POST /plans/start-document` `{messageId, draftDigest}` returns `{documentId, documentDigest, expiresAt, document, nonce}`; `POST /plans/start` `{documentDigest, nonce}` returns the created ids and each run admitted or refused. No body carries a tenant, workspace, actor, grant or role.
- `collaboration.md` v1.1: parts `plan_card`, `plan_change_card`, `choice_question`, `project_update` (ids and the week only) and `checkup_done`; `Message.author` `system`; `MessageOrigin` `coordinator_turn`; `MentionPart` target `coordinator` with request `ask`; an additive `plan_started` event with ids only.
- `report@1`: typed counts and closed next-step codes (such as `add_photo` and `ask_reviews`), whose text code writes from templates.
- `workspace-routes.json`, components only: `PlanCard` and `ChoiceQuestion` on `ask` and `ask_conversation`; `PlanCard`, `PlanChangeCard`, `ProjectUpdate` and `CheckupDoneCard` on `project`.
- Versioning (`contract-versions.md`): `Goal` and `CriteriaList` are declared supersets with `changes.json` entries (`adr` ADR-0033). Everything else is an addition or an edit of a v1.1-only definition: a deliberate candidate edit with a `release-baseline.json` hash update, or v1.2 if v1.1 is frozen first.
- The switch `docs/decisions/plan-drafts-staging.json`, committed `"off"`.

## Interfaces touched

`docs/contracts/schemas/v1.1/{core,capabilities}.schema.json`, `changes.json`, `release-baseline.json`, `collaboration.md`, `work-api.md`, `capabilities.json` and `capabilities.md`, `schedules.md`, `workspace-routes.json`, the tool catalogue, `redaction.ts` and forward migrations.

## Security notes

- Server-derived only: start values, read tags, data classes, clocks, taint, restricted sources, actor and workspace. No route body names a tenant, workspace, actor, grant, role or start value.
- `workspace.goal.revise` and `workspace.goal.measure.record` are `human_only`; no tool writes a goal record or value. `plan.draft` grants nothing.
- Customer-tagged values never reach a goal record, a `project_update` or the Coordinator's context.
- Morrow's Ask behaviour needs P05.T04b; the switch stays off until then and until the agent-loop switch is on.

## Test checklist

- [ ] `tests/contract-versioning.test.mjs`: the two supersets, structurally and on the P01.A02 cases.
- [ ] `tool-catalogue.test.mjs`, `policy.test.mjs`, `collaboration-contracts.test.mjs` (the Coordinator mention's verbs).
- [ ] `lab:work-postgresql`, `lab:tenant-conformance`, `lab:visibility`, `lab:retention`, `lab:plan-start` and `lab:agent-authority-workers` rows named in both ADRs.
- [ ] Health unit cases in both directions; the schedules contract test for a disabling configure revision.
- [ ] AI review (separate context, same model family); hosted CI on the PR head.
