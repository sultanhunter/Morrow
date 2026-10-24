---
id: GATE-production
type: gate
title: The production custody ADR, then production up
label: G12
status: open
owner_kind: owner
due_week: W9
links:
  depends_on: [TRK-production]
  governed_by: [ADR-0007, ADR-0035]
---

The custody record (ADR-0007 item 9) approved, then a clean production environment up. ADR-0035 item
1 moves both to before the first outside merchant; the deployed environment is v1 production until
then.
