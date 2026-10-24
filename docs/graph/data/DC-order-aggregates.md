---
id: DC-order-aggregates
type: data_class
title: Order aggregates, with no customer fields
status: planned
retention: 90 days from the order's or day's date
deletion: the daily sweep; shop/redact; customers/redact by listed orders
customer: "no"
links:
  deleted_by: [TRK-privacy, TRK-launch-agents]
  governed_by: [ADR-0031, ADR-0035]
---

Level 1 order reads for the Business Analyst and Inventory, the agents that hold `read_orders`
(Support holds it too, for its own replies; ADR-0025 item 6). Marketing holds no `read_orders` and
reads no orders. ADR-0035 item 7 lets the owner's store fill it before its path; the path lands with
the Business Analyst (V1-PR22).
