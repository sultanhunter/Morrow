---
id: DC-run-turns
type: data_class
title: Run turns (content)
status: planned
retention: 90 days from run end; thinking blocks deleted at run close
deletion: the daily sweep; agent uninstall
customer: "no"
links:
  deleted_by: [TRK-agent-platform, TRK-privacy]
  governed_by: [ADR-0031, ADR-0027]
---

Conversation text lives only in a tenant-isolated table; job records and logs hold ids only.
