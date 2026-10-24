---
id: AG-specialist
type: agent
kind: task_specialist
title: Specialist (the morrow.specialist release, run-scoped)
status: planned
slip_rank: "1"
customer_data: none
computer: "yes"
links:
  composes: [SK-listing-content, SK-seo-metadata, SK-tags-and-collections, SK-image-alt-text, SK-discount-proposals]
  installs_as: [IK-task-specialist]
  never_holds: [workspace.task.delegate, workspace.task.create, workspace.task.assign, orders.read, support.case.read]
  governed_by: [ADR-0028, ADR-0027, ADR-0023]
---

One bounded piece of work on one task, composed from 1 to 3 eligible skills; reports back and
proposes. Only the Owner starts one at launch. Read, internal, propose and compute tools only (the
computer under the runtime switch); no order reads, customer data or support tools (ADR-0028 item
2). By default Opus 5.5 at medium. Cut with Marketing if G11 is missed; moved to the first fast
follow if G18 is missed.
