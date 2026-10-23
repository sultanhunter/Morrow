# ADR-0033 Work model v2: projects hold measured goals; Everyday work and Quick tasks

- Status: Accepted 2026-10-24 (the owner, OD-2026-10-24-1: every owner question as recommended)
- Date: 2026-10-23
- Supersedes: none.
- Amends: `collaboration.md` v1.1's "Projects" bullet (item 1); the v1 `Goal` and `CriteriaList`, and `work-api.md` (item 2); migration 0015's criteria CHECK, goal guards and task cap, by forward migrations, and `work-state.md`'s notes on them (items 2, 5 and 7); `capabilities.json` (items 4, 5, 8 and 11); ADR-0022 item 2's listing contracts and `creative.media.attach` (item 10); ADR-0031 item 1 (item 4).
- Implements: OD-2026-10-23-8 answers 2 (this record's half), 3, 5, 6 and 7; ADR-0023 decision 1's "goals (metrics computed in code)".
- Relies on: ADR-0034's start document; T5's metric catalogue; the P06 forward migrations for task cancel edges (ADR-0010 item 5) and task states (P06.T03).
- Does not change: ADR-0016 (projects made and pinned only by people, read with goal view, one per goal record); `tasks.goal_id NOT NULL`; ADR-0011; ADR-0022 item 15; ADR-0024; ADR-0025 items 6 and 8; ADR-0026 item 4; ADR-0027; ADR-0028; the routes; the Inbox kinds.
- Terms: the Owner, as in ADR-0024. On screen a **goal** is one measured success criterion; the **goal record** is the `Goal` behind a project. Field names and health details are in the draft brief `docs/briefs/flow-contracts.md`.
- Unblocks: lettered children of P06.T01, P12.T04 and P14.T02; tracks T2, T5, T6, T7, T12 and T17.

## Context

On 2026-10-23 the owner asked, in chat, for a flow that does not confuse shop owners:

> i like the projects idea as a single project can have multiple goals instead of vague individual goals options

A UX flow recommendation answered it (a working paper outside the repository, checked by AI reviews, separate context, same model family). Shown its eight questions with their recommended answers, the owner answered (OD-2026-10-23-8):

> approve all as recommended

Answer 2 asks for this record and ADR-0034 before code. Today a project's goals are free text with no measure, target or date, though `mvp.md` promises "goals with metrics computed in code".

## Decision

1. **A project is one goal record with 1 to 3 measured goals,** its success criteria, so no migration touches `tasks`. A **dated project** has an end date ("Ends"); an **Everyday work area** has none (item 6). `collaboration.md`'s "Projects" bullet says so.
2. **Contracts.** `Goal` gains `dueAt` and `areaTemplateId` (never both), and `CriteriaList` items gain `key` and `measure`, as declared supersets of v1 (like `ResourceRef`, ADR-0022 item 2), or as Goal@2 if T2's versioning check refuses that. `work-api.md` validates goals with the current definition and gains routes to revise a goal, record a check and read progress. Forward migrations replace the criteria CHECK and add `goal_measure_values`.
3. **Three measure kinds, from closed lists:** `metric` (a T5 catalogue entry, with its unit and direction, at least or at most); `checklist` (first the 12-fact "Product facts complete"); `manual` (at launch a hand check in one AI assistant, owner question 3, over product rows, with questions Morrow writes and a person may edit). A goal record holds targets and dates, never a measured number: a goal's start is a server-derived reference to its first value row.
4. **Values and health come from code; values keep their data's rules.**
   - Values are append-only rows in `goal_measure_values` (FORCE RLS), written by code, or for a hand check by a person through the new `workspace.goal.measure.record` (`internal_write`, `human_only`). A check in another assistant never counts. No model or tool writes a value.
   - Each value carries its sources' read tags and class (ADR-0031 item 6). An order-derived value is an `order_aggregates` row on its 90-day clock. A value from sources tagged `support.case.read`, such as the Customer emails goal "Replied within a day", is customer data (ADR-0031 item 2): it lives in a `content: customer` table with a `customer_redact` handler, expires no later than its cases, and never enters a goal record, a `project_update` or the Coordinator's context. Other values, goal records and projects stay, like tasks, until a person deletes them, the store is redacted or the workspace is erased (amends ADR-0031 item 1).
   - `GoalProgress@1` is computed per viewer from the values that viewer may see, otherwise "Not measured"; a project's word uses only those goals. A dated goal is On track on the target's side of the straight line from its oldest kept value to its target, by the measure's direction; on the other side it is Behind, but only after 25% of its time. An undated area goal is On track on the target's side of its template's threshold (such as 90% of products complete) and never Done. A project shows its worst goal, Needs you to a viewer someone waits on, and Done only after Finish. An overdue check or an ended project shows Needs you, never On track.
5. **Only people change a goal or finish a project.** The new `workspace.goal.revise` (`internal_write`, `human_only`) changes the objective, the date (Extend), targets, questions and assistant, within 3 goals. **Finish** is one transaction through ADR-0034's start document under the person's live grants: it cancels or moves each open task; with "Keep the monthly check in Product pages" ticked, it moves that repeating task and adds its product row or area goal through `workspace.goal.revise`, refusing at 3 goals; and it sets `achieved` when code finds every goal Done, otherwise `cancelled` (both "Finished"). A forward migration changes `cmd_goal_transition`'s guards: `achieved` needs Finish's code-computed results record, and `cancelled` needs every task ended. Finish waits on the P06 cancel edges. No tool writes a goal record, value, target or date.
6. **Everyday work areas, from fixed templates.** `EverydayAreaTemplate@1` is closed data per first-party agent release: a label, a goal with its measure and threshold, and repeating tasks that stay off until a person turns them on. Launch labels: Product pages (Listings), Stock (Inventory and Purchasing), Customer emails (Customer Support), Sales and numbers (Business Analyst), Promotions (Marketing and Promotions). After adding the agent, a person creates its area with one tap, at most one per template, on a card code builds with no model, so areas never wait on ADR-0034's plan-drafts switch. An area changes no agent package, install document or mandate; its goal is the agent's standing goal. Uninstalling the agent keeps the area and stops its routines.
7. **Quick tasks.** One built-in goal record per workspace, created at setup by the Owner's tap on a code-built card, always open and unmeasured, so no task is loose. For area and Quick tasks records, a forward migration makes `cmd_task_create`'s 200-task cap count only tasks that have not ended, so they need P06.T03's task states. A code rule, never Morrow, offers "Make a project?" when 3 open Quick tasks name one product or agent.
8. **Repeating tasks and alerts live in their project.** A routine or recurring task names its goal record, through T2's schedule contract and `workspace.routine.configure`'s input; an alert also names the goal's `key`. Moving one is a person's act.
9. **The Goals page goes.** A goal opens as a drawer in its project, and Home shows "Your projects". Routes do not change (ADR-0032 item 1).
10. **A source for every factual sentence.** Proposal@2 has no field for it. In every prose field Listings proposes at launch (descriptions, SEO descriptions and image alt text), each sentence names 1 to 4 of its run's wrapped inputs (ADR-0027 item 5) or `wordingOnly`, inside the parameters digest. Code flags a sentence with no valid source, or a `wordingOnly` one with a number or unit, as "No source: check before approving", and the Approve button names the count; the card says titles and tags are checked by eye. A report source keeps its taint; an edit names its editor (ADR-0024 item 8).
11. **Spend per project, no project limit; Stop steps.** Settled credits show by project and helper: a run counts toward its task's goal record, a Coordinator run in a project conversation (ADR-0034 item 8) toward that project, an Ask run toward "Ask Morrow". Display only (answer 5). "Stop this project's steps" is a person-only transaction under that person's grants: it turns off the project's repeating tasks (a routine by a `workspace.routine.configure` revision, which leaves an active routine disabled and never activates one) and cancels unstarted tasks (`workspace.task.cancel`, once the P06 cancel edges exist). A running task keeps its own Stop; turning a routine back on needs `workspace.routine.activate` (`human_only`). No stop scope or kill switch is added.
12. **Names tested before launch.** T17's moderated test with five merchants on the prototype passes when 4 of 5 find the weekly stock check under Stock, read a project's date as its end, restate its "Done when", pick the right project from the sidebar, answer "Does anything need you?" within 5 seconds, undo an approved change within 60 seconds, and state a project's cost and balance; and 5 of 5 find Stop within 10 seconds. Until then the names are working labels.

Later, each by its own ADR: several goal records per project (Project@2); a project credit limit that only lowers spend; a project-scope stop (ADR-0022 item 15); an agent that checks AI answers itself (ADR-0029 item 12). "Orders from AI assistants" is a routine T5 catalogue entry at launch if T8 finds the fields ADR-0025 items 6 and 8 keep suffice; otherwise its row stays hidden until an ADR amends those items.

## Security invariants touched

None is weakened.
- **FORCE RLS; no client-supplied values; completion needs evidence:** `lab:tenant-conformance`; `lab:work-postgresql`, including a client-sent start value, `achieved` without Finish's results record, and more than 200 tasks under an area.
- **Checks in code; agents never change goals:** `policy.test.mjs` (both capabilities `human_only`), `lab:agent-authority-workers`, `tool-catalogue.test.mjs`; health unit cases in both directions.
- **Per-viewer visibility:** `lab:visibility`, a Member without `orders.read` reading an order-measured goal and its project's word.
- **Customer data on 90-day clocks; deletion path first:** `lab:retention`, an order-derived first value and a customer-tagged value; S8 requires the `customer_redact` handler.
- **Digest-bound approvals:** `review-policy.test.mjs` and T12's evals (sources inside the digest).
- **`human_only` stops; budgets in code:** `stops.test.mjs` and the schedules contract test (a configure revision only disables); `lab:run-credits`.
- **Default deny; immutable migrations:** goal routes default-off until T7 uses them (`edge:check`); `migration-history.test.mjs`.

## Consequences

- If this record is not approved by W1, goals ship as sentences and health reads "Not measured". Without ADR-0034, people create projects, areas and Quick tasks through the ordinary forms.
- The Customer emails goal is seen only by members who may read customer data (the Owner by default, ADR-0031 owner question 4).

## Alternatives considered

- **Project@2 now:** a `tasks` migration on W1's critical path, for the same screens.
- **A Goals page beside Projects:** keeps three meanings of "goal".
- **Health from a model, or agents recording checks:** a model could report a goal On track that is not.
- **Start numbers on the goal record:** they would outlive their clocks and escape read tags.

## Owner questions

1. **Projects with no end date outside the templates?** *Recommendation: not at launch;* such work goes into an area or Quick tasks.
2. **Who sees a project's credits?** *Recommendation:* everyone who can view the project, as its card already shows the estimate.
3. **Assistants for the hand check?** *Recommendation:* ChatGPT (the default), Gemini, Copilot and Perplexity.
4. **"Wording only" sentences?** *Recommendation:* allowed without a source and shown as "Wording only", unless they hold a number or unit.

## Approval

The owner's statement in chat, verbatim, on 2026-10-24 (IST), after reading the decision sheet (`docs/decisions/decision-sheet-2026-10-26-flow.md`) and a plain-language summary of both records with their questions and recommendations (OD-2026-10-24-1):

> approve ADR-0033 and ADR-0034 as recommended

What it approves: this record as written and each owner question above with its recommended answer. It follows the owner's approval of the UX flow recommendation (OD-2026-10-23-8), which asked for this record.
