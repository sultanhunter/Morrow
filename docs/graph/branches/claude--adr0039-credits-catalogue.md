---
id: claude/adr0039-credits-catalogue
type: branch
title: "Credits only: the catalogue and the runtime without money caps"
status: open
links:
  implements: [TRK-decisions]
---

Building from 66689751: the credits-only record's implementation plan PR 1 (the listings and the
catalogue, credits only) with PR 4's removal of the runtime budget, on OD-2026-10-25-4.
Catalogue version 4 (version 3 without the US$7 run and US$25 daily caps, 25 products a run for
every entry), version 3 retired, and migration 0052: `run_reserve` without the daily cap,
`runtime_caps()` and `runtime_operation_begin` without the US$10 monthly budget. The record
itself is on pull request 75; `tests/credits-only.test.mjs` reads its Approval and passes once
that pull request is on main.
