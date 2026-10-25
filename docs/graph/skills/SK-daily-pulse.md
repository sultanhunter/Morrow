---
id: SK-daily-pulse
type: skill
title: The daily pulse
status: proposed
card_eligible: "yes"
runtime: computer-optional
job_tags: [analytics, pulse]
links:
  holds: [DC-order-aggregates]
  governed_by: [ADR-0023, ADR-0037]
---

Yesterday's sales, order value, refunds and unfulfilled orders against their monitors, from Level 1
aggregates. Card-eligible: Morrow may pick it on an agent card, and a card that reads orders needs
the Owner as its requester or approver (ADR-0037 item 5).
