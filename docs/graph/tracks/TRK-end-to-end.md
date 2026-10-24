---
id: TRK-end-to-end
type: track
title: End to end and review
label: T17
status: proposed
weeks: W8 to W18
links:
  includes: [P02.T04, P14.T04, P18.T05]
  waits_on: [GATE-app-review-submission, GATE-shopify-review, GATE-owner-signoff, GATE-launch]
  governed_by: [ADR-0023, ADR-0033]
---

A simulated week (W8 to W9, MS-simulated-week), submission (W10, G13), review and fixes (W11 to W16,
G14), launch (GATE-launch). The gates follow the simulated week, and the track ends with the launch,
so it waits on them rather than the gates on it. A moderated test of the flow with five merchants on
the prototype (ADR-0033 item 12), which also carries the P02.A04 participant study: 4 of 5 find the
weekly stock check under Stock, read a project's date as when it ends, restate its "Done when", pick
the right project, answer "Does anything need you?" within 5 seconds, undo an approved change within
60 seconds and state a project's cost and balance left; 5 of 5 find Stop within 10 seconds. The cost
per Morrow request is measured.
