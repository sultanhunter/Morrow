---
id: F-gateway-review-apply
type: feature
title: Exact review, approve and apply through one gateway, with read-back and Undo
status: active
area: Approvals and the gateway
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P06.T01, P08.T03, P11.T01, P11.T02, P11.T03, P14.T03]
  holds: [DC-product-content-proposed]
  governed_by: [ADR-0011, ADR-0024, ADR-0035]
---

Exact before-and-after review; an edit makes a new proposal; batch approval is N digests; one
gateway claims, re-checks, executes, reads back and audits every write; Undo builds a new exact
change from the values read before the apply; `discount.deactivate`. Merged: V1-PR03 (#54, apply
switch off). Building: V1-PR04.
