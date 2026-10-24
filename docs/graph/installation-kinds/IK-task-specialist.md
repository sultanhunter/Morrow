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
  may_hold: [catalog.products.read, inventory.levels.read, workspace.knowledge.read, workspace.conversation.post, workspace.question.request, catalog.content.propose, catalog.collection.propose, runtime.execution.use]
  never_holds: [workspace.task.delegate, workspace.task.create, workspace.task.assign, orders.read, support.case.read, support.reply.propose, catalog.content.publish, catalog.collection.publish]
  governed_by: [ADR-0028, ADR-0031]
---

Always release `morrow.specialist`, owned by the starter, scoped to the parent task's store; no
mandate, trigger, schedule or routine; it ends `uninstalled` and is never re-activated (ADR-0028
item 1). The Start transaction replaces stage-and-activate for this kind only. This list documents
the Specialist ceiling of ADR-0028 item 2; the SQL issuer's fixed allowlist stays the authority.
