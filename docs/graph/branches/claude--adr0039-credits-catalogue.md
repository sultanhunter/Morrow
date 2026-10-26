---
id: claude/adr0039-credits-catalogue
type: branch
title: "Credits only: the catalogue and the runtime without money caps; catalogue v4 is Opus 5.5 at medium and high only"
status: open
links:
  implements: [TRK-decisions]
---

Built from 66689751, merged with main at 410cabb3 (pull request 75, ADR-0039), at da8570ae, at
c41b79ee (pull request 66, connection health) and at 43cc5489 (pull request 80, the test credits
renewal): the credits-only record's implementation plan
PR 1 (the listings and the catalogue, credits only) with PR 4's removal of the runtime budget, on
OD-2026-10-25-4. Catalogue version 4 (version 3 without the US$7 run and US$25 daily caps, 25
products a run for every entry, and, on the owner's decisions of 2026-10-26 that every agent
runs on the best model and that low effort goes too, Claude Opus 5.5 at medium and high only),
version 3 retired, loop version 2 without money caps (still proposed; pull request 64 rewrites
it under the harness record of pull request 82), verify refusing any model but exactly Claude Opus 5.5 and low effort from
version 4 and in every published version but 1 and 3, ADR-0039's dated note amending item 4,
and migration 0056:
`run_reserve` without the daily cap, `runtime_caps()` and `runtime_operation_begin` without the
US$10 monthly budget. Built as 0052, renumbered 0053 when pull request 68's shop knowledge took
0052, 0055 when pull request 66 took 0053 and 0054, and 0056 when pull request 80 took 0055; if
another pull request lands first, the lead renumbers it again at merge time. The owner answered
question 1 of pull request 82 (the proposed harness record) on 2026-10-26 by accepting its
recommendation, so low effort leaves version 4; this branch merges after pull request 82.
