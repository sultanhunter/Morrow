---
id: claude/sd3-sd4-customer-data-deletion-base
type: branch
title: "SD3 and SD4: keep the listed order ids, and the customer-data deletion base (P09.T05 children)"
status: open
links:
  implements: [TRK-privacy, P09.T05b, P09.T05c]
---

Plan rows SD3 and SD4 of docs/plan/store-data-foundation-implementation.md, both P09.T05
children, on ADR-0031 items 2 to 4 and its 2026-10-26 note on item 1, ADR-0042 items 5, 15 and
24, ADR-0043 item 24 and OD-2026-10-26-10. Built from origin/main at 2c495867 as migrations
0058 (identity) and 0059 (work), after pull request 92's 0057; the lead renumbers them at merge
if they land first. Brief docs/briefs/sd3-keep-orders-to-redact.md; packet
docs/packets/P09.T05c.md. Nothing in it lets customer data in: it builds the path that must
exist first.
