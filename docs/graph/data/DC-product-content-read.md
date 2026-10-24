---
id: DC-product-content-read
type: data_class
title: Product content read from the store
status: deletion-ready
retention: until the run's drafts expire
deletion: its shop_redact handler in redaction.ts, on shop/redact (the 48-hour fallback after uninstall comes with v1 PR 5) (delete rows)
customer: "no"
links:
  deleted_by: [PR-43]
  governed_by: [ADR-0022, ADR-0031]
---

Class `product_content_read` (product snapshots). Product data comes first in v1 (ADR-0035).
