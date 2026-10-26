---
id: RISK-specialists-crowd-the-loop
type: risk
title: Agent-card authority work and teammate calls crowd the agent platform track
status: open
links:
  raised_by: [ADR-0023]
  about: [TRK-agent-platform, TRK-specialists]
  mitigated_by: [TRK-specialists, ADR-0037]
---

About 13 to 18 agent-days and one security packet on critical-path tracks; T4 gets a third builder
from W2 to W5, and the slip rules (G11, G18) hold the date. Since ADR-0037 (2026-10-25) the
security packet is the agent-card authority packet, and teammate calls in the loop add work to T4.
ADR-0037 item 9's slip rule moves agent cards, not the teammate calls, to the first fast follow if
G11 is missed or the packet slips past G18.
