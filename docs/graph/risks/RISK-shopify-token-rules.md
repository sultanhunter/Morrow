---
id: RISK-shopify-token-rules
type: risk
title: Shopify requires expiring tokens for the custom app
status: open
links:
  raised_by: [ADR-0035]
  about: [V1-PR01, F-public-app, ADR-0025]
---

V1-PR01 assumes a long-lived token for a custom app. If Shopify requires expiring tokens for new
apps, the token-refresh work of ADR-0025 item 5 comes forward, about one more M.
