---
id: AG-marketing
type: agent
kind: installable
title: Marketing and Promotions
status: planned
slip_rank: "1"
scopes_optional: [write_discounts]
customer_data: none
computer: "no"
links:
  needs: [catalog.products.read, lifecycle.campaign.propose]
  bundles: [SK-promotion-plan, SK-discount-proposals]
  installs_as: [IK-installed-agent]
  governed_by: [ADR-0023]
---

A weekly promotion plan; campaign and social copy; capped discount proposals and ending them, with a
typed confirmation. Aggregates only. The first cut in the slip order. V1-PR24.
