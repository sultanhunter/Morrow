---
id: Q-skill-ids
type: question
kind: do
title: Fix the 12 launch skills' ids in skills/<id>/skill.json
status: open
asked_of: claude
links:
  raised_by: [ADR-0023]
  about: [TRK-launch-agents, AG-specialist]
---

ADR-0023 decision 11d sets 12 first-party job skills; only `listing-content` is named in the
repository (`docs/plan/mvp.md`, T12). The SK nodes name the other eleven from the agents' jobs as
working names. When `skills/<id>/skill.json` exists, each SK node takes its id or is dropped.
