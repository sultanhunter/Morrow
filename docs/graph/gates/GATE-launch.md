---
id: GATE-launch
type: gate
title: Public launch (unlisted link, paid)
label: G19
status: open
owner_kind: owner
due_week: W18
links:
  depends_on: [MS-simulated-week, TRK-launch-agents]
  waits_on: [GATE-deletion-paths, GATE-production, GATE-app-review-submission, GATE-shopify-review, GATE-legal, GATE-owner-signoff]
  governed_by: [ADR-0023]
---

The planning date, Monday 2027-03-01, in a range from mid-February (one clean review) to April 2027
(several rounds). The plan numbers 18 gates and does not number the launch; the graph labels it G19
because every gate needs a label, and `query critical` walks back from it.
