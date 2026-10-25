---
id: AG-specialist
type: agent
kind: task_specialist
title: Specialist (the morrow.specialist release, run-scoped), retired by ADR-0037
status: dropped
customer_data: none
computer: "yes"
links:
  installs_as: [IK-task-specialist]
  never_holds: [workspace.task.delegate, workspace.task.create, workspace.task.assign, orders.read, support.case.read]
  governed_by: [ADR-0037, ADR-0028, ADR-0027, ADR-0023]
---

Dropped on 2026-10-25. ADR-0037 (OD-2026-10-25-3) retires the run-scoped specialist kind and the
`morrow.specialist` release (item 7): there is one agent kind with two origins, and an agent Morrow
creates is a teammate like a first-party one (AG-workspace-created). The id is kept and never
reused.

What it was: one bounded piece of work on one task, composed from 1 to 3 eligible skills, started
by the Owner under a 24-hour clock, with the Specialist ceiling's read, internal, propose and
compute tools and no customer data (ADR-0028). Its skills and slip rank moved to
AG-workspace-created.
