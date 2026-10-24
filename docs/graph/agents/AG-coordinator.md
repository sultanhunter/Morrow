---
id: AG-coordinator
type: agent
kind: builtin
title: Morrow, the Coordinator
status: planned
customer_data: none
computer: "no"
depth: "1"
links:
  needs: [workspace.task.delegate, workspace.question.request, workspace.conversation.post]
  delegates_to: [AG-specialist, AG-listings, AG-business-analyst, AG-inventory, AG-support, AG-marketing]
  never_holds: [catalog.products.read, catalog.content.propose, runtime.execution.use, orders.read, support.case.read]
  governed_by: [ADR-0027, ADR-0034, ADR-0023]
---

Built in and model-based. It answers from knowledge, routes Asks and @mentions to one installed
agent, asks clarifying questions, ranks suggestions, and drafts specialist and plan cards; it
creates only tasks, questions, messages and drafts, and no task of its own at launch. Its own rights
are fixed: no store reads, no change proposals, no computer and no customer data (v1 build order, PR
12). By default it runs Opus 5.5 at high effort. Separate from the optional Chief of Staff and CMO
(F-chief-of-staff-and-cmo).
