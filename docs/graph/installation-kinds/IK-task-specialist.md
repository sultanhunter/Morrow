---
id: IK-task-specialist
type: installation_kind
title: A run-scoped specialist installation, retired by ADR-0037
status: dropped
lifetime: 24 hours from Start; the run 1 hour by default and 8 at most
mandate: "no"
triggers: "no"
started_by: [owner-start]
routable: "no"
authority_records: agent_installations (kind task_specialist), a fresh principal, grants from work_specialist_grants_issue, the envelope and hop
links:
  may_hold: [catalog.products.read, inventory.levels.read, workspace.knowledge.read, workspace.artifact.read, workspace.conversation.post, workspace.question.request, workspace.comment.create, workspace.artifact.edit, catalog.content.propose, catalog.content.publish, catalog.collection.propose, catalog.collection.publish, runtime.execution.use]
  never_holds: [workspace.task.delegate, workspace.task.create, workspace.task.assign, orders.read, support.case.read, support.reply.propose]
  governed_by: [ADR-0037, ADR-0028, ADR-0029, ADR-0031]
---

Dropped on 2026-10-25. ADR-0037 retires the `task_specialist` kind, the `morrow.specialist`
release, the Specialist ceiling and `work_specialist_grants_issue` (item 7); an agent Morrow creates
is an IK-installed-agent of the workspace origin. The id is kept and never reused. No migration
created this kind.

What it was: always release `morrow.specialist`, owned by the starter, scoped to the parent task's
store; no mandate, trigger, schedule or routine; it ended `uninstalled` and was never re-activated
(ADR-0028 item 1). The Start transaction replaced stage-and-activate for this kind only.

`may_hold` still lists the 12 ids of the Specialist ceiling (ADR-0028 item 2), exactly as
`docs/contracts/specialist-ceiling.json` holds them, plus `runtime.execution.use`, and
`tests/graph.test.mjs` still checks this node against that file until ADR-0037's contracts PR
retires it (`docs/plan/adr-0037-implementation.md`, PR 2). The graph records ids, not verbs: the
ceiling granted `catalog.content.publish` and `catalog.collection.publish` with the `propose` verb
only.
