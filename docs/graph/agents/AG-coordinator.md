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
  needs: [workspace.task.delegate, workspace.question.request, workspace.conversation.post, agents.builder.describe]
  delegates_to: [AG-listings, AG-business-analyst, AG-inventory, AG-support, AG-marketing, AG-workspace-created]
  never_holds: [catalog.products.read, catalog.content.propose, runtime.execution.use, orders.read, support.case.read]
  governed_by: [ADR-0037, ADR-0027, ADR-0034, ADR-0023]
---

Built in and model-based: the main agent, which keeps the conversation (ADR-0037 item 1). It
answers from knowledge and work records, asks clarifying questions, ranks suggestions, and drafts
plan cards and agent cards. It orchestrates teammates of either origin in any way the work needs,
at depth 1 (ADR-0037 item 3): it calls them as tools for structured results (`agent.ask`, a
TeammateResult@1 with no character cap, large outputs as result items it opens page by page) and,
outside an Ask, hands work off when a teammate must own the conversation (`agent.route`), any
number of times in one run, in sequence or in parallel, the same teammate more than once. Each
call or hand-off is one child under its envelope, admitted and checked in code on its own; a run's
calls are bounded only by its stop conditions, the workspace's credits, a person's stop and the
kernel's 32 children per envelope.

It creates only tasks, questions, messages and drafts, and no task of its own at launch. Its own
rights are fixed: no store reads, no change proposals, no computer and no customer data; `agent.ask`
rests on `workspace.task.delegate` and `agent.propose` on `agents.builder.describe`, which grants
nothing (v1 build order, PR 12; ADR-0037 item 1). By default it runs Opus 5.5 at high effort.
Separate from the optional Chief of Staff and CMO (F-chief-of-staff-and-cmo).
