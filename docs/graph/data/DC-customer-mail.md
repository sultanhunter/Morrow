---
id: DC-customer-mail
type: data_class
title: "Customer mail: mail, cases, Level 2 fields and drafts"
status: planned
retention: 90 days after the case's last message; content-free sent-reply records 365 days
deletion: the daily sweep; customers/redact by customer id, keyed email digest and orders; uninstalling Support
customer: "yes"
links:
  deleted_by: [TRK-privacy, TRK-email]
  governed_by: [ADR-0031, ADR-0030, ADR-0035]
---

Enters only with Customer Support (AG-support), after its deletion path is merged (ADR-0035 item 7,
G9). Never to the Coordinator, E2B, a specialist or a notification email (ADR-0031 item 2).
