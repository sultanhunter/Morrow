---
id: RISK-uninstall-ends-the-app
type: risk
title: Until connection health lands, an uninstall or a scope change ends the app for good
status: open
links:
  raised_by: [ADR-0035]
  about: [V1-PR05, F-shopify-connection]
  mitigated_by: [TRK-shopify-app]
---

Reconnecting would need a new app record. Don't uninstall the app or change its permissions until
V1-PR05 merges; it must land before any new Shopify permission (V1-PR22 to V1-PR25).
