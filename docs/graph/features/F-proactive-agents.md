---
id: F-proactive-agents
type: feature
title: "Proactive agents: schedules, Shopify events, monitors, look-for-work and notebooks"
status: planned
area: Proactivity
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P06.T03, P12.T04, P13.T03, P10.T01]
  needs: [F-mandates, F-agent-loop]
  holds: [DC-trigger-sets]
  waits_on: [GATE-gateway-reservations-stops]
  governed_by: [ADR-0024]
---

Schedules in the shop's timezone, Shopify events gathered into batch runs, metric monitors in code,
mentions and assignments, inbound support email, a daily read-only look for useful work, quiet hours
and admission control in code. Jobs start only from Morrow's own trigger records. V1-PR21.
