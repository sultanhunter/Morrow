---
id: F-evals-and-releases
type: feature
title: Recorded evals in CI and a passing live-eval digest before a release publishes
status: planned
area: Agents and catalogue
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P15.T03, P13.T04]
  governed_by: [ADR-0023]
---

CI uses recorded model outputs only; no model key in GitHub Actions on a public repository. Live
evals run through the broker under the standing approval (ADR-0035 item 4). Release contract:
`docs/contracts/skill-release.md`.
