# T7 PR 19: the project screens in Sunrise

- Status: brief, 2026-10-24. Track T7 (`docs/plan/mvp.md`). Routine (ADR-0002): screens behind default-off switches over decisions already accepted; no authority, tenancy, money, provider, contract or retention change. Decisions of record: ADR-0033 (Work model v2) and ADR-0034 (Morrow drafts plans), both accepted on 2026-10-24 (OD-2026-10-24-1); ADR-0032 (Sunrise). Branch `claude/t7-sunrise-projects-screens`, built on `claude/flow-adrs` (PR #49).
- Field-level detail comes from the draft brief `docs/briefs/flow-contracts.md` (track T2). Its contracts and routes are not built yet; T2 and T6 (`claude/t2-t6-projects-backend`) build them in parallel.

## Goal

People see and run their work as projects: dated projects by end date, one Everyday work area per added agent, and Quick tasks. A project page answers "How is this going, and what's next?", and Ask Morrow turns a request into a plan card that a person starts with one tap.

## Scope

1. **Projects page** (route `work`, shown as Projects): New project (opens "Tell Morrow what you want to achieve", with "Set it up yourself"); tabs Projects (credits this month, Projects with an end date by end date, Everyday work, Finished), Tasks (board or list, Mine, New task) and Repeating (waiting to turn on, repeating tasks, alerts).
2. **Project page** (route `project`): title, health word, scope line and the stopped notice; Plan next steps, Stop steps, and at the end date Finish or Extend; tabs Overview (Since you were last here, Goals with their measures and health words, Plan, Latest update, Credits), Tasks, Brief, Files and Activity; a goal drawer; the conversation, where a person may ask @Morrow, with plan-change cards and the Monday update.
3. **Everyday work area page** (the same route; a project whose goal record has an area template): the five areas' links, the area goal, alerts on it, repeating tasks, tasks, who works here, spend this month and the conversation.
4. **The plan card in Ask Morrow** (route `ask_conversation`): the person's request, Morrow's choice questions (tap to answer, "Something else…", "Skip, you decide"), the project card (goals, who works on it, what needs you, credits, the full plan, what Morrow can't do, who will see it, the taint notice), Edit (a new revision), Not now and **Start project**.
5. **The backend that exists.** A project is one goal record (ADR-0033 item 1), so its Tasks tab lists that record's tasks through the work API (`work.listTasks`), New task files a task with `work.createTask`, and every task opens on its existing task page. Everything else waits for T2 and T6's routes.

## Interfaces touched

- `packages/workspace-ui/src/projects/*` (new: view models, copy, health and date helpers, components and screens, each in its own file so they move onto the Sunrise shell cleanly) and `styles/projects.css` (Sunrise token names with option 1 fallbacks, no colour literal).
- `port.ts`: two namespaces, `projects` (overview, tasks, repeating, get, messages, post, planNextSteps, stopSteps, extend, finishDocument, create) and `plans` (ask, conversation, answer, revise, startDocument, start). `index.ts` exports; `styles/index.css` imports one stylesheet.
- Re-entry markers gain the kinds `project` and `plan` (`services.tsx`, `pending.ts`, `copy.ts`).
- `apps/workspace-web`: `app.tsx` routes `work`, `project` and `ask_conversation` to the new screens only while their methods are composed, and guards the new methods for 401s; `http/api.ts` answers every new method `not_in_build`; `http/composed.ts` leaves them uncomposed; `fixtures/projects.ts` and `fixtures/projects-data.ts` (new) and the `projects_preview`, `projects_teammate`, `projects_start_stale` and `projects_start_uncertain` scenarios.
- `scripts/ui-checks.mjs`: 17 state cases for the new screens and one keyboard walk (`start_project`); `tests/workspace-web-account-work.test.mjs` lists the new uncomposed methods. Controls and non-inline links are at least 44 px (48 px below 760 px), Sunrise's floors. Not touched: Home, the sidebar, tokens (PR 14), the Inbox and review (gateway apply), Team and Settings (PR 16), any contract, route, migration or Worker.

## Security notes

- **Switches default off.** Over HTTP every new method is uncomposed: it answers `not_in_build` and sends nothing, and `work`, `project` and `ask_conversation` render exactly what they render today. The fixture composes them only in its preview scenarios. T2 and T6 compose each method in the PR that lands its route, with its decoder and tests.
- **Only a person's tap creates.** A plan card creates nothing. Start and Apply changes are two commands: the server builds a start document for the draft digest it holds (`{messageId, draftDigest}`), and the person's same tap consumes it once (`{documentDigest, nonce}`). The screen consumes a document only when it binds the target, draft digest and project shown and has not expired; otherwise, and on a stale, expired, reused or unknown document, it starts nothing and re-reads the card. An ineligible person (`actor_ineligible`) is told so, and only the asker sees Start at all. Finish uses the same start over a code-built document, bound to the project and the goal record's revision.
- **No body names authority.** Bodies carry ids, digests, revisions, one person's text and closed edits; never a tenant, workspace, actor, grant, role, capability, model, recipient, store or measured value.
- **The server decides.** Each button appears only where the server's `actions` say this person may act now, and the server checks again. Health words, values, estimates and taint come from the server as read; the screens compute none of them.
- **Agents and pictures confer nothing.** @Morrow is a request, never authority; a plan card shows "Written by Morrow" and, when tainted, says so above Start.
- **Unknown outcomes stay unknown.** Every command uses the existing single-flight command with its kept key, "Check again" and re-entry markers; nothing reads as done before a confirmed reply.
- **No sample data in production.** Sample projects live only in `apps/workspace-web/src/fixtures`, which the production entry cannot import (`verify:workspace-web`).

## Test checklist

- [ ] `tests/workspace-ui-projects.test.mjs`: the switch (HTTP sends nothing; only preview scenarios compose), closed bodies, date and health helpers, end-date order, the start flow's digest check, stale and ineligible starts, and the screens rendered from the fixture.
- [ ] `npm run -s typecheck`, `npm run -s verify`, `npm test`, `npm run format:check`.
- [ ] `npm run ui:check` with the new `projects/*` cases (local Chromium is not installed on this Mac; CI is the authority).
- [ ] AI review (separate context, same model family); hosted `foundation` on the PR head.

## Follow-ups

Re-home onto the Sunrise shell (PR 14): swap the local badge and agent pill for its `Tag` and `AgentName`, and let its Ask Morrow button focus the project conversation. Compose each method when T2 and T6 land its route. Turning on a repeating task (`workspace.routine.activate` and its review gate), Restart steps, areas' one-tap setup, the AI-answer hand check and the Files and Activity pages are later PRs.
