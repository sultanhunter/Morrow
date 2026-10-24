---
id: GATE-app-review-submission
type: gate
title: App Review submission
label: G13
status: open
owner_kind: owner
due_week: W10
links:
  depends_on: [MS-simulated-week, F-public-app, F-embedded-home, TRK-shopify-billing, TRK-privacy]
  waits_on: [GATE-production, GATE-legal, GATE-shopify-partner-questions]
  governed_by: [ADR-0025, ADR-0035]
---

Scopes and the protected-data request (Level 1; Level 2 name and email for Support), the privacy
policy, support and emergency contacts, a screencast, test instructions, production URLs, working
compliance webhooks and billing. Each submission needs the owner's yes (ADR-0035 item 4). It follows
T17's simulated week (MS-simulated-week), not the whole of T17: the track's review, fixes and launch
come after it.
