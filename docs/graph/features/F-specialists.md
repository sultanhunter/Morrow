---
id: F-specialists
type: feature
title: On-demand specialists, one level under the Coordinator, started by the Owner
status: planned
area: Specialists
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P13.T02, P15.T04, P05.T04]
  holds: [DC-specialist-specs, DC-start-documents, DC-retired-run-principals]
  waits_on: [GATE-specialist-packet, GATE-deletion-paths, GATE-gateway-reservations-stops]
  governed_by: [ADR-0028, ADR-0023, ADR-0027]
  approved_by: [OD-2026-10-23-3]
---

When nothing installed covers a goal, the Coordinator drafts a temporary specialist from 1 to 3
eligible skills; code builds the spec and the Owner presses Start. 1 running per task and 2 per
workspace, one 24-hour authority clock, a run of 1 hour by default and 8 at most, no customer data,
reports that never reach the Coordinator. The switch stays off until G9 and G10 pass. V1-PR26.
