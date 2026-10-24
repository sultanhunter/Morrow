---
id: Q-adr-0029-owner-questions
type: question
kind: decide
title: "ADR-0029 owner questions 1 to 4: template builds, Pro, late answers, the envd token"
status: answered
asked_of: owner
links:
  answered_by: [OD-2026-10-23-7]
  raised_by: [ADR-0029]
  about: [ADR-0029, F-computer-runtime]
---

1: template builds with the owner's own E2B login, else a build-only key the owner holds. 2: buy Pro
at production bring-up. 3: if E2B has not answered by 2026-11-20, start the adapter with
conservative defaults (ADR-0035 item 6 starts it now). 4: the per-sandbox envd token falls outside
the no-credential-in-the-VM invariant.
