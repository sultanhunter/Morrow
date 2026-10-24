---
id: DC-product-content-proposed
type: data_class
title: Proposed product content in a proposal's parameters
status: deletion-ready
retention: the proposal's life
deletion: its shop_redact handler in redaction.ts, on shop/redact (the 48-hour fallback after uninstall comes with v1 PR 5) (empty the content, keep the digest)
customer: "no"
links:
  deleted_by: [PR-43]
  governed_by: [ADR-0022, ADR-0031]
---

Class `product_content_proposed`. An emptied proposal never applies.
