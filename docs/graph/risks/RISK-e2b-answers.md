---
id: RISK-e2b-answers
type: risk
title: E2B's answers come late or say no
status: open
links:
  raised_by: [ADR-0023]
  about: [GATE-e2b-answers, F-computer-runtime]
  mitigated_by: [ADR-0035, Q-e2b-written-answers]
---

Late answers no longer block: the adapter starts with conservative defaults (ADR-0035 item 6). A
negative answer stops the computer until the owner decides between the TypeScript fallbacks and
holding launch; never automatic.
