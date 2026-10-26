---
id: F-model-and-effort
type: feature
title: Model and thinking effort chosen per agent
status: planned
area: Agents and catalogue
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P13.T01]
  governed_by: [ADR-0027, ADR-0036, ADR-0037, ADR-0041]
  approved_by: [OD-2026-10-23-7, OD-2026-10-25-1, OD-2026-10-25-2, OD-2026-10-26-5, OD-2026-10-26-7]
---

Opus 5.5, with its thinking effort chosen by the Owner (an Admin for installed agents). Haiku and
Sonnet leave every catalogue, Listings' included, by a new catalogue version: the owner ruled out
cheaper models for paid users on 2026-10-26 (OD-2026-10-26-5). `low` effort goes too, and the
Owner may still raise a teammate to high, never lower or to another model (ADR-0041 item 2;
OD-2026-10-26-7, owner question 1). By default the Coordinator runs Opus 5.5 at high and every teammate of either origin (the
five installed agents, Listings included, and those Morrow creates) Opus 5.5 at medium (ADR-0036;
ADR-0037 item 4: a new teammate takes the workspace's default for new teammates, the former
specialist profile). A change applies from the agent's next job, that is, its next context: a run
that continues an existing context (a follow-up, a reply to a job, a Continue) keeps that context's
model and effort (ADR-0041 item 2). A change never changes what the agent may do (ADR-0027 item
12). V1-PR12.
