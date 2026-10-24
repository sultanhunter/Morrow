---
id: AG-business-analyst
type: agent
kind: installable
title: Business Analyst
status: planned
scopes_optional: [read_orders]
customer_data: level1
computer: "yes"
links:
  needs: [orders.read, analytics.report.create, analytics.anomaly.investigate]
  holds: [DC-order-aggregates]
  bundles: [SK-daily-pulse, SK-weekly-review, SK-sales-investigation]
  installs_as: [IK-installed-agent]
  governed_by: [ADR-0023, ADR-0025, ADR-0031]
---

The daily pulse and weekly review; monitors on sales, order value, refunds, unfulfilled orders,
stock cover and margin; investigations on the computer; read-only. Level 1 order reads and webhook
totals, 60 days, no ShopifyQL at launch. Part of the floor. V1-PR22.
