---
id: TRK-interfaces
type: track
title: Interfaces
label: T2
status: active
weeks: W1 (3 to 4)
links:
  includes: [P01.T01, P01.T02, P13.T01, P05.T04, P12.T04, P16.T01, P17.T02g, P06.T01, P07.T03]
  depends_on: [TRK-decisions]
  governed_by: [ADR-0023, ADR-0027, ADR-0033, ADR-0034]
---

Every track's first PR is its contract with a fake. The track's scope: the tool catalogue,
admission, job and event shape, mutation registry, AgentPackage@1 with skills, RuntimeProviderPort,
the knowledge and notebook API, Inbox kinds, schedules, the agent-loop and mandate contracts,
SpecialistSpec@1 and the Start document, and the sender identity.

Merged so far: the contracts slice in V1-PR10 (#52: the tool catalogue, AgentPackage@1, ModelCall@2,
mandates and triggers, SpecialistSpec@1, the Start document and the sender identity);
RuntimeProviderPort in V1-PR07 (#51, track T10); and, with ADR-0033 and ADR-0034, goal measure
fields, everyday-area templates, `plan.draft` and the plan start document behind default-off
switches (V1-PR18, #58). Still to come: new Inbox item kinds (PR 10b) and the knowledge and notebook
API (with V1-PR20).
