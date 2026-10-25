# ADR-0034 Morrow drafts plans: plan cards, a person-bound plan start, Morrow in Asks and @Morrow in projects

- Status: Accepted 2026-10-24 (the owner, OD-2026-10-24-1: every owner question as recommended)
- Date: 2026-10-23
- Supersedes: none.
- Amends: ADR-0023 decision 1's Coordinator line (item 1); ADR-0027 items 3 and 8 (`plan.draft`, item 2; `agent.route` in an Ask, item 7) and item 10's `report@1` (item 9); `collaboration.md` v1.1's message parts, author, origin and mention targets (items 8 and 9); ADR-0031 item 1's "Start documents" row (item 5).
- Refines: ADR-0016 item 3 (Morrow in an Ask, item 7) and item 4 (a new mention target, item 8).
- Implements: OD-2026-10-23-8 answers 1, 2 (this record's half) and 4.
- Relies on: ADR-0033 (measures, areas, Quick tasks, Finish and its `human_only` capabilities); P05.T04b's Ask-bound envelope (ADR-0016 item 3); ADR-0031 item 6.
- Does not change: ADR-0016 items 1 and 5; ADR-0011; ADR-0024; ADR-0026; ADR-0027 item 12 (answer 8: the installed agents keep Sonnet 5.5 at low); ADR-0028; ADR-0005.
- Terms: the Owner, as in ADR-0024. A **card** is a plan draft shown in a conversation. **Start** is a person's tap that turns a card into records: "Start project", "Send to Listings", "Turn on", "Apply changes" or "Finish project". Fields and routes are in the draft brief `docs/briefs/flow-contracts.md`.
- Unblocks: P13.T02, P13.T03, P07.T03, P14.T02; tracks T2, T4, T6, T7, T12 and T17; storyboard frames Flow-01 to Flow-09.

## Context

On 2026-10-23 the owner asked, in chat, for a flow that does not confuse shop owners:

> i like the projects idea as a single project can have multiple goals instead of vague individual goals options

The UX flow recommendation that answered it (a working paper outside the repository, checked by AI reviews, separate context, same model family) found that a request can end in six places and no record says what Morrow may do in an Ask. Shown its eight questions with their recommended answers, the owner answered (OD-2026-10-23-8):

> approve all as recommended

Answer 1: one "Start project" tap creates a project Morrow drafted, plus the Owner's own "Start check-up" when a specialist is involved. Answer 4: Morrow does not check in on projects by itself at launch.

## Decision

1. **Morrow drafts; a person's tap creates.** ADR-0023 decision 1's line becomes: "It creates only tasks, questions, messages, specialist drafts and plan drafts; a plan draft creates nothing until a person starts it." At launch the `morrow.coordinator` release leaves `task.create` out of its tool subset, a product choice; ADR-0027 item 8's grant set keeps it.
2. **`plan.draft`, a tool that grants nothing,** on `workspace.conversation.post`. It posts one card holding a closed, digested PlanDraft@1 (a project, task, repeating task or alert, or plan change) and creates no other record. The model writes the title, "Done when", 1 to 3 goals from ADR-0033's closed measures, 1 to 8 steps and the target; a specialist step has only a title and purpose, so `specialist.draft` stays the only spec drafter. Code writes, per viewer under their read tags, today's values, the credit range and balance and what each helper may do. No field takes a capability, scope, grant, cap, model, recipient, sender or store. It is refused (`report_in_context`) in a turn holding a report (ADR-0027 item 10).
3. **Taint survives edits and copies.** A card's `contextTaint` and `restrictedSources` are server-derived, and a tainted card says so above Start. A person's edit is a new revision in `plan_draft_revisions` (FORCE RLS), with the editor and a new digest, keeping the original's taint and sources as ADR-0024 item 8 does. A start document is issued only for a digest the server holds. Records made from a tainted card carry the taint wherever they are shown or read into a run.
4. **Sorting a request is behaviour, never authority.** The first fit wins: answerable now: a quick answer with its source; repeats or watches a number with no end: a repeating card in its area; a named outcome needing several steps and a date or number: a project card; otherwise a task card. A vague request gets at most two choice questions.
5. **The plan start.** On Start the server builds PlanStartDocument@1, binding the actor, the standalone-workspace session, the draft digest, the target and its revision, the records code computes, the estimate shown and a digest of the person's grant summary (never the authority). It lasts 5 minutes and is consumed once (`plan_start_documents`, FORCE RLS; ADR-0031 item 1's start-document clock). Only the asker gets one (owner question 2), or for a code-built card the person who opened it; anyone else, any agent and any embedded or email session gets `actor_ineligible`. One idempotent transaction, rolled back on any refusal:
   - (a) consumes the document, `stale` if the draft, target, an assignee or the grant summary changed;
   - (b) runs the human kernel for every piece under the person's live grants, stops and scopes at commit, refusing all with `PERMISSION_DENIED` or `stopped`;
   - (c) creates, as that person's commands, the goal record, the project and pin (`human_only`), tasks, recurring tasks and alerts, and an agent's repeating task as a routine configured disabled, turned on only through `workspace.routine.activate` and its review gate (owner question 4);
   - (d) posts the request as the person's message and the card as the Coordinator's, with its taint;
   - (e) writes one audit record.

   It never admits a run. A plan change applies through `workspace.goal.revise` against the project's current revision. An area, Quick tasks and Finish (ADR-0033 items 5 to 7) use the same start over a card code builds with no model.
6. **What the same tap starts, after commit.** Each run is admitted on its own (ADR-0026 item 4); a refusal leaves that step "Not started" with its own button.
   - (a) **A specialist step,** when the Owner taps: one Coordinator run with the Owner as requester, limited to `knowledge.search`, `work.read`, `message.post` and `specialist.draft` for the step's new task (ADR-0028 items 3 and 4). "Start check-up" stays the Owner's own tap. A teammate's tap offers "Ask [Owner]" or "Let [agent] do it instead".
   - (b) **Ready agent steps.** "Send to Listings" and "Apply changes" start a step with no unmet dependency as the person's own run (ADR-0024 item 7), as the approved flow does; "Start project" is owner question 1. A later step waits for a person's tap on its "Your tasks" item.
7. **Morrow in a private Ask.** All of Morrow's work in an Ask needs P05.T04b's Ask-bound envelope (ADR-0016 item 3); before it, no agent, Morrow included, runs in an Ask, and the switch stays off (item 10). Its tools there: `knowledge.search`, `work.read`, `message.post` (at most 2 choice questions, counted in code), `plan.draft`, and `agent.route` once per run for one active added agent's read-only answer under the same envelope, which widens `agent.route` from a task's store (ADR-0027 item 8) to an Ask. Never `task.create`, `specialist.draft`, `inbox.ask` or a mention. Each tapped answer starts a new run as the person's act. On Start only the request and the card are copied into the project, and the card says so first (ADR-0016 item 5).
8. **@Morrow in a project conversation:** a typed mention part with target `coordinator` and request `ask`. Its author, and anyone tapping "Plan next steps", needs `execute` on `workspace.conversation.create` (the `human_only` right to open an Ask), `execute` on `workspace.conversation.post` and goal view of the project. It starts one Coordinator run with that person as requester and the project in view, never report text. The run may answer, ask choice questions or draft a task or plan-change card; it creates no task and routes no agent. `collaboration.md`'s mention rules hold: human-authored only, `MENTION_NOT_ALLOWED` in an Ask, never authority. At launch only in project conversations (owner question 3).
9. **Five new message part kinds:** `plan_card` and `plan_change_card` (whether started is derived, so a message never changes), `choice_question` (Coordinator only), `project_update` and `checkup_done`. `Message.author` gains `system` for the last two, never with text or a model-written field; `MessageOrigin` gains `coordinator_turn`. `project_update` holds only ids and the week; each viewer's copy is rendered at read time from GoalProgress@1, leaving out goals that viewer may not see and every customer-tagged value (ADR-0033 item 4). `checkup_done` is built from `report@1`'s typed counts and closed next-step codes, which T2 adds to the report's form, never from report text. No Inbox kind is added.
10. **Contracts and the switch.** Only Goal and CriteriaList take `changes.json` entries; the rest are deliberate candidate edits with a `release-baseline.json` hash update. `docs/decisions/plan-drafts-staging.json` is committed `off` and gates Morrow's part: `plan.draft`, choice questions, the Ask route and the Coordinator mention are absent from manifests. It goes on by one reviewed commit after the agent-loop switch (ADR-0027 item 11) and P05.T04b; `edge:check` refuses it on while the loop switch is off. The start routes answer 503 before any document, lock or record until `lab:plan-start` passes; while the switch is off they accept only code-built cards, so ADR-0033's areas, Quick tasks and Finish never wait on the loop.

Morrow never checks in on its own schedule at launch (answer 4); it starts only on a person's act. Later, each by its own ADR: a finished step starting the next agent by itself (a new trigger kind, ADR-0024 item 6, or a deferred person's run, item 7); one tap that starts a project and its specialist (ADR-0028 items 3 and 4); scheduled check-ins (ADR-0027 item 8).

## Security invariants touched

None is weakened.
- **Tenancy; the intersection; default deny:** `lab:tenant-conformance` (both tables FORCE RLS); new `lab:plan-start` cases: a grant revoked before commit, a stop on an assignee, a Member without `workspace.project.create`, an expired, reused or unknown digest, an embedded or email session, an agent, a non-asker, an edited tainted card and the copied card keeping its writer and taint; `tool-catalogue.test.mjs` (`plan.draft`'s closed inputs, its report refusal, the launch subset).
- **`human_only` routine activation:** a started routine stays disabled until its gate passes (`lab:plan-start`, `policy.test.mjs`).
- **Agents reach an Ask only through its owner's envelope:** `lab:agent-authority-workers` rows deny every Morrow path into an Ask before P05.T04b and refuse `task.create`, `specialist.draft` and `inbox.ask` there after.
- **Mentions are never authority; Asks stay private:** `collaboration-contracts.test.mjs` (a Member lacking `workspace.conversation.create` is refused; refused in Asks); `lab:visibility` (copied cards keep their read tags; `project_update` leaves out goals the viewer may not see).
- **Digest-bound approvals; reports never reach Morrow:** `approval-records.test.mjs` (a start approves nothing); `lab:agent-runs` (`checkup_done` uses typed fields only).
- **Budgets in code; no effect before G10; immutable migrations:** `lab:run-credits`, `edge:check`, `migration-history.test.mjs`.

## Consequences

- Each request to Morrow costs about US$0.46 of model use at the default (ADR-0027 item 12); T17 measures it on staging.
- Residual risk: injected text could shape a card; it shows its taint and still needs a person's tap, which creates only internal records under that person's grants.
- If this record is not accepted by W1, "Use this plan" opens "New project" filled in from the card.

## Alternatives considered

- **Give Morrow `workspace.project.create`:** it is `human_only` (ADR-0016 item 1), and shared work would appear without a tap.
- **No tap at all:** Morrow would spend credits and hand out work by itself.
- **The specialist spec inside `plan.draft`:** a spec binds an existing task and its asker (ADR-0028 items 3 and 4).
- **Move the whole Ask into the project:** it would expose the private conversation (ADR-0016 item 5).

## Owner questions

1. **Should "Start project" also start ready agent steps on the same tap?** Each is the person's own run and spends that step's credits, shown on the card; "Send to Listings" and "Apply changes" already do so in the approved flow. *Recommendation: yes;* later steps still wait for their own tap.
2. **Who may start a card Morrow drafted for someone else?** (a) Only the asker; (b) anyone who could create every piece by hand. *Recommendation: (a) at launch.*
3. **Should @Morrow also work in task conversations at launch?** *Recommendation: no.*
4. **Turning on an agent's repeating task.** This changes the flow you approved: "Turn on" for an agent's repeating task (the weekly stock list, or an area's weekly check) is not one tap. `workspace.routine.activate` is `control` and `human_only`, which ADR-0011 Q9 puts in the access-change class: working alone, you type a phrase and wait 5 minutes, which you can cancel; in a team, another member approves. *Recommendation:* keep that gate at launch; a one-tap rule for a routine inside its agent's current mandate would need its own ADR after T17's test.

## Approval

The owner's statement in chat, verbatim, on 2026-10-24 (IST), after reading the decision sheet (`docs/decisions/decision-sheet-2026-10-26-flow.md`) and a plain-language summary of both records with their questions and recommendations (OD-2026-10-24-1):

> approve ADR-0033 and ADR-0034 as recommended

What it approves: this record as written and each owner question above with its recommended answer. It follows the owner's approval of the UX flow recommendation (OD-2026-10-23-8), which asked for this record.

## Amendments

### 2026-10-25: teammates in place of specialists (ADR-0037)

The owner's decision of 2026-10-25 (OD-2026-10-25-3, recorded in ADR-0037) changes these items; the text above is kept as approved.

- **Item 2.** A plan card's specialist step becomes a step that names an active teammate or "a new teammate", with only a title and purpose, so `agent.propose` is the only agent-card drafter. `report_in_context` no longer refuses a turn holding a TeammateResult@1; a card drafted in that turn carries the result's taint and sources.
- **Item 6(a).** Tapping a new-teammate step starts one Morrow run limited to `knowledge.search`, `work.read`, `message.post` and `agent.propose`; "Start check-up" becomes "Add to team", and the step is a ready agent step once its card is approved.
- **Item 7.** In a private Ask, `agent.route`'s read-only answer becomes the teammate call (`agent.ask`), read-only under the Ask-bound envelope, returning a typed result to Morrow; there is no hand-off from an Ask. The list of what Morrow never uses there keeps `task.create`, `inbox.ask` and mentions, with `agent.propose` in place of `specialist.draft`.
- **Item 9.** `checkup_done` is built from TeammateResult@1's typed counts and next-step codes.
