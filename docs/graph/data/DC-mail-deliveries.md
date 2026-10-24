---
id: DC-mail-deliveries
type: data_class
title: Mail deliveries (content-free)
status: planned
retention: 90 days, never while uncertain
deletion: the daily sweep
customer: "no"
links:
  deleted_by: [TRK-email]
  governed_by: [ADR-0030, ADR-0031]
---

One row per send with its idempotency key and status (ADR-0030 item 8).
