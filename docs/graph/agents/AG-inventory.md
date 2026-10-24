---
id: AG-inventory
type: agent
kind: installable
title: Inventory and Purchasing
status: planned
scopes_required: [read_inventory, read_locations]
scopes_optional: [read_orders]
customer_data: level1
computer: fallback
links:
  needs: [inventory.levels.read, inventory.risk.report, orders.read]
  holds: [DC-order-aggregates]
  bundles: [SK-stock-cover, SK-reorder-planning]
  installs_as: [IK-installed-agent]
  governed_by: [ADR-0023, ADR-0029]
---

Days of cover; low- and dead-stock alerts; reorder suggestions with a purchase-order file and a
draft supplier email the merchant sends. The agent is part of the floor; its computer forecast is
the second cut in the slip order, after Marketing, and falls back to TypeScript. V1-PR23.
