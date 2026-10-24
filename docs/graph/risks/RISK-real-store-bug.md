---
id: RISK-real-store-bug
type: risk
title: A bug writes a wrong value to the owner's real store
status: accepted
links:
  raised_by: [ADR-0035]
  about: [V1-PR03, F-gateway-review-apply]
  mitigated_by: [ADR-0035, TRK-gateway]
---

Accepted by ADR-0035. Bounded by writing only approved fields, reading every write back, starting
with one product (a draft product is safest), and Undo (V1-PR04).
