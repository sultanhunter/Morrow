---
id: claude/adr-0036-model-defaults-cost-cap
type: branch
title: "ADR-0036: model defaults and the AI cost cap"
status: built
links:
  implements: [TRK-decisions]
---

Built from 500e87dc and merged with main at 85cac200 and 3c08dc35: ADR-0036 (OD-2026-10-25-1),
catalogue version 3 and migration 0051 (no unrecovered-cost cap; built as 0047, renumbered to 0048
when main's build order PR 8 took 0047 for runtime-e2b, then to 0051 when #71 took 0048 and 0049
for the webhook registrations and #67 took 0050 for catalog-undo). The agent loop's 0047 is
renumbered at its own integration. The owner's answers of 2026-10-25 (OD-2026-10-25-2) confirmed version 3's default
member ceiling of 4 (Q-adr-0036-member-ceiling answered), set the look-for-work cap to US$1.12 per
agent per day (ADR-0036 item 7) and kept the US$7 and US$25 backstops.
