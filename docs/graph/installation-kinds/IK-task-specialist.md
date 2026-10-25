---
id: IK-task-specialist
type: installation_kind
title: A run-scoped specialist installation
status: planned
lifetime: 24 hours from Start; the run 1 hour by default and 8 at most
mandate: "no"
triggers: "no"
started_by: owner-start
routable: "no"
authority_records: agent_installations (kind task_specialist), a fresh principal, grants from work_specialist_grants_issue, the envelope and hop
links:
  may_hold: [catalog.products.read, inventory.levels.read, workspace.knowledge.read, workspace.artifact.read, workspace.conversation.post, workspace.question.request, workspace.comment.create, workspace.artifact.edit, catalog.content.propose, catalog.content.publish, catalog.collection.propose, catalog.collection.publish, runtime.execution.use]
  never_holds: [workspace.task.delegate, workspace.task.create, workspace.task.assign, orders.read, support.case.read, support.reply.propose]
  governed_by: [ADR-0028, ADR-0029, ADR-0031]
---

Always release `morrow.specialist`, owned by the starter, scoped to the parent task's store; no
mandate, trigger, schedule or routine; it ends `uninstalled` and is never re-activated (ADR-0028
item 1). The Start transaction replaces stage-and-activate for this kind only.

`may_hold` lists the 12 ids of the Specialist ceiling (ADR-0028 item 2) plus
`runtime.execution.use`, which joined only under the runtime switch (ADR-0029 item 7). The graph
records ids, not verbs: the ceiling granted `catalog.content.publish` and
`catalog.collection.publish` with the `propose` verb only. ADR-0037 retired the specialist kind:
its contracts PR removed `docs/contracts/specialist-ceiling.json` and the specialist switch, and its
implementation plan's PR 1 drops this node. Until then `tests/graph.test.mjs` keeps it from holding
delegation, order reads or `support.*`.
