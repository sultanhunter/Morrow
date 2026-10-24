---
id: F-shopify-connection
type: feature
title: "The store connection: install, link, reads, webhooks, approved writes, Disconnect and health"
status: active
area: Shopify
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P05.T03, P08.T01, P08.T02, P09.T01, P09.T02, P09.T03, P09.T04, P09.T05]
  holds: [DC-shop-identity, DC-offline-token, DC-product-content-read, DC-webhook-receipts]
  governed_by: [ADR-0008, ADR-0022, ADR-0025, ADR-0035]
---

Under ADR-0035 v1 connects the owner's own store through a custom-distribution app (V1-PR01, #50):
one live store admitted, the connector's address on, the kill switch covering it. "Disconnect store"
merged (V1-PR02, #53); permission changes, reinstall and the clean-up jobs are V1-PR05, building
now. Approved writes at launch: product content and SEO, tags, alt text, collections and capped
discounts. Connector contract: `docs/contracts/connector-sdk.md`.
