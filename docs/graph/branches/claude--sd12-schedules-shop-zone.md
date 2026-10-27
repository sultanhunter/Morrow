---
id: claude/sd12-schedules-shop-zone
type: branch
title: "SD12: Schedule@1 and the shop's zone (the routine part)"
status: open
links:
  implements: [P12.T04, TRK-proactivity]
---

Built from 2c495867 (pull request 90 merged) for the part of plan row SD12 of the store-data
foundation plan that the row marks "now": ADR-0043 items 7 and 8, and item 9 for recurring
schedules. Schedule@1 in the unfrozen v1.1 core, the closed IANA zone list with the Owner's
override in place of the four Canadian zones, the slot arithmetic in SQL with its TypeScript
twin (daylight saving and catch-up after downtime), the shop's zone read from Shopify's
ianaTimezone at the install, a reconnect and the daily health read, a zone change that raises
one Inbox item and moves nothing until a person's tap, and fire_due_schedules from the
orchestrator's cron behind the committed-off schedules-v2 switch. Migration
0062.schedules-shop-zone (the number reserved for SD12; the lead renumbers at merge if the
order differs). lab:mandates M1 to M8.

Merged main at 8581d329 (pull requests 90 and 91, H2 and H6): only generated files and the v1.1
baseline hash conflicted; the contracts were regenerated and the hash pinned again.

Not here, by the row's order: the standing-request switch to Schedule@1 (after SD2's dated
note on ADR-0040 item 12) and code-written once schedules (after SD2's note on ADR-0041 items 7
and 20). The zone item's Inbox kind and the tap's route come with the routine screens (V1-PR21,
SD15), the first writers of schedules.
