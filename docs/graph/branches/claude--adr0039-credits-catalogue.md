---
id: claude/adr0039-credits-catalogue
type: branch
title: "Credits only: the catalogue and the runtime without money caps; catalogue v4 is Opus 5.5 only"
status: open
links:
  implements: [TRK-decisions]
---

Built from 66689751, merged with main at 410cabb3 (pull request 75, ADR-0039) and at da8570ae: the
credits-only record's implementation plan PR 1 (the listings and the catalogue, credits only)
with PR 4's removal of the runtime budget, on OD-2026-10-25-4. Catalogue version 4 (version 3
without the US$7 run and US$25 daily caps, 25 products a run for every entry, and, on the
owner's decision of 2026-10-26 that every agent runs on the best model, Claude Opus 5.5 at low,
medium and high only), version 3 retired, loop version 2 without money caps (still proposed),
verify refusing any model but Claude Opus from version 4, and migration 0053: `run_reserve`
without the daily cap, `runtime_caps()` and `runtime_operation_begin` without the US$10
monthly budget. Built as 0052, renumbered 0053 when pull request 68's shop knowledge took 0052
on main; open pull requests #64 and #80 also hold 0053, and the lead renumbers at merge time.
