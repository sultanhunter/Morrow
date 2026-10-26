---
id: DC-result-items
type: data_class
title: Result items of teammate calls (run content)
status: planned
retention: 90 days from the producing run's end, on its run turns' clock
deletion: deleted with the producing run's turns, by the daily sweep and agent uninstall
customer: "no"
links:
  deleted_by: [TRK-agent-platform, TRK-privacy]
  governed_by: [ADR-0037, ADR-0031]
---

A summary, finding or table too large for one 8 KiB tool result, and every file, that a teammate's
TeammateResult@1 references by id, kind, size and title (ADR-0037 item 3(a)). A FORCE RLS record
naming the run that produced it, with that run's read tags and taint; code opens it for Morrow only
when it belongs to a result Morrow's own run received, and an item with a customer read tag never
enters Morrow's context. Run content, like DC-run-turns (ADR-0037 item 8). ADR-0037's follow-up PR
4 first writes it.
