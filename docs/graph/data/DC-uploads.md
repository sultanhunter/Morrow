---
id: DC-uploads
type: data_class
title: CSV and XLSX uploads
status: planned
retention: 90 days from upload
deletion: the daily sweep; on request
customer: "no"
links:
  deleted_by: [TRK-e2b-runtime]
  governed_by: [ADR-0029, ADR-0031]
---

Opened only in a sandbox; a header naming a customer field deletes the file unread (ADR-0031 item
5). Uploads keep ADR-0029 item 6's rule, since a spreadsheet can hold customer data.
