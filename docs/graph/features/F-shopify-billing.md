---
id: F-shopify-billing
type: feature
title: "Shopify App Pricing: a plan with a credit grant, capped usage and a rate card"
status: planned
area: Billing
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P01.T04, P18.T01]
  governed_by: [ADR-0026, ADR-0015, ADR-0035]
  approved_by: [OD-2026-10-23-3]
---

Credits are granted only after Shopify confirms a usage record; caps are Morrow's, in code. The
Stripe code stays switched off. No billing in v1 (ADR-0035 item 3): the owner's workspace runs on
test credits (V1-PR06).
