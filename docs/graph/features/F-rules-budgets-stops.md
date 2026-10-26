---
id: F-rules-budgets-stops
type: feature
title: Allow, Ask and Never rules, credit holds, and the stops
status: active
area: Safety and governance
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P11.T04, P11.T05, P05.T04]
  governed_by: [ADR-0005, ADR-0024, ADR-0026, ADR-0037, OD-2026-10-25-4]
---

Rules merchants can only tighten, per agent and workspace-wide; every run's credit hold and the
balance check before each step, in code. Credits are the only spend limit (OD-2026-10-25-4, written
out in the credits-only money record of pull request 75; ADR-0037 item 6 for teammates): no money
cap per run, per day, per agent or per call, with the owner's Anthropic monthly limit and E2B's
usage limit as the outside backstops. The fixed caps still in code (US$7 per run, US$25 a day, the
runtime's monthly budget) go with that record's code PRs; no new one is added. The non-money stop conditions stay (turn and tool-call limits,
wall time), and "Stop AI work", "Disconnect store", the platform stop and the kill switch stay
`human_only`. "Disconnect store" merged in V1-PR02 (#53).
