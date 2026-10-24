---
id: DC-shop-identity
type: data_class
title: "Shop identity: installations, app registrations and linking candidates"
status: deletion-ready
retention: while the store is linked
deletion: its shop_redact handler in redaction.ts, on shop/redact (the 48-hour fallback after uninstall comes with v1 PR 5) (pseudonymise the domain, clear the install link)
customer: "no"
links:
  deleted_by: [PR-43]
  governed_by: [ADR-0022, ADR-0031]
---

Class `shop_identity` in the registry. The shop's domain is kept only as a digest where it can be,
and never in this public repository (ADR-0035 item 2).
