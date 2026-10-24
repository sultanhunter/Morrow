---
id: TRK-gateway
type: track
title: Gateway
label: T3
status: active
weeks: W1 to W4 (1 to 2)
links:
  includes: [P06.T01, P08.T03, P11.T01, P11.T02, P11.T03, P14.T03]
  delivers: [F-gateway-review-apply]
  depends_on: [TRK-land-the-train, TRK-interfaces]
  governed_by: [ADR-0011, ADR-0024, ADR-0035]
---

The review API, batch approval, revert, `discount.deactivate` and the exceptions Inbox; a security
packet. The first slice, review, approve and apply for Listings' product content, merged as #54
(V1-PR03) with the apply switch off. Undo, apply history, approve several at once and the product
picker are V1-PR04, building now.
