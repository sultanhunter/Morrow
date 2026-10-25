---
id: F-coordinator
type: feature
title: "Morrow, the Coordinator: answers, orchestrates teammates, asks and proposes plans and new teammates"
status: planned
area: Agents and catalogue
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P13.T02]
  governed_by: [ADR-0037, ADR-0027, ADR-0034]
---

The built-in, model-based main agent keeps the conversation (ADR-0037 item 1). It answers from
knowledge, asks clarifying questions, ranks suggestions, drafts plan cards and agent cards, and
orchestrates teammates in any way the work needs at depth 1 (ADR-0037 item 3): teammate calls with
structured results and hand-offs, any number per run, in sequence or in parallel. Its own rights
are fixed (AG-coordinator). V1-PR12; the teammate calls and Morrow's new tools come with ADR-0037's
follow-up PRs 4 and 5.
