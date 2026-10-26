---
id: AG-support
type: agent
kind: installable
title: Customer Support
status: planned
origin: first-party
scopes_optional: [read_orders, read_customers, read_returns]
customer_data: level2
computer: "no"
links:
  needs: [support.case.read, support.reply.propose, support.case.escalate, orders.read]
  holds: [DC-customer-mail]
  bundles: [SK-support-replies]
  installs_as: [IK-installed-agent]
  never_holds: [runtime.execution.use]
  depends_on: [F-support-email]
  waits_on: [GATE-deletion-paths]
  governed_by: [ADR-0030, ADR-0031, ADR-0035]
---

Drafted replies to forwarded email (where is my order, returns, product questions); every send
approved; refunds and cancellations escalated to a person. Level 2 (name and email). A manifest that
declares both customer reads and computer tools is refused. Customer data enters only with this
agent, after its deletion path (ADR-0035 item 7). It stays unless Shopify refuses Level 2
(RISK-level2-refused). V1-PR25.
