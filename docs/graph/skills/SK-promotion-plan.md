---
id: SK-promotion-plan
type: skill
title: The weekly promotion plan, with campaign and social copy
status: proposed
specialist_eligible: "no"
runtime: none
job_tags: [marketing]
links:
  governed_by: [ADR-0023, ADR-0025]
---

Plans the week's promotions from product data and sales aggregates, never from order reads; copy in
the shop's brand voice. Marketing holds no `read_orders` scope (ADR-0025 item 6) and its customer
data is "None (aggregates)" in `docs/plan/mvp.md`, so the skill holds no order data class. Which
already-computed figures it may read is settled with V1-PR24.
