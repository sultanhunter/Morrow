---
id: GATE-gateway-reservations-stops
type: gate
title: The gateway, reservations and stops, before proactive triggers touch a real store
label: G10
status: open
owner_kind: claude
due_when: before proactive triggers touch a real store
links:
  depends_on: [TRK-gateway, TRK-agent-platform]
  governed_by: [ADR-0023, ADR-0024]
---

No agent-initiated external effect before the gateway, budget reservations and stop controls exist.
The apply path merged as #54 (V1-PR03) with its switch off; the stops and run reservations exist
since the beta. The specialist switch stays off until G9 and G10 pass. The plan gives no week; the
gate is due before proactive triggers touch a real store, and the steps that do so wait on it.
