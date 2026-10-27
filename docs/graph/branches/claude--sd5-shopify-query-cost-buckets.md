---
id: claude/sd5-shopify-query-cost-buckets
type: branch
title: "SD5: per-shop buckets for Shopify's API query cost (a P09.T03 child)"
status: open
links:
  implements: [TRK-shopify-app, P09.T03]
---

Plan row SD5 of docs/plan/store-data-foundation-implementation.md, a P09.T03 child under
ADR-0043 and ADR-0044. Built from origin/main at 2c495867 and merged with 8581d329 (pull
request 91), as the reserved migration 0061, after 0057 (pull request 92), 0058 (pull request
64), 0059 and 0060 (SD3 and SD4); it needs only 0001 to 0056, and the lead renumbers it at merge
if the order differs. One SQL token bucket per store installation in Shopify's query-cost
points, charged before each fixed document and corrected from Shopify's throttleStatus, with
priority classes that keep headroom for writes and a parked read for H7b's run.wait. Shopify's
rate limit, never money or credits; behind a switch committed off. Brief
docs/briefs/sd5-shopify-query-cost.md.
