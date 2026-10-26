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
  governed_by: [ADR-0023, ADR-0027, ADR-0033, ADR-0034, ADR-0037]
---

Every track's first PR is its contract with a fake. The track's scope: the tool catalogue,
admission, job and event shape, mutation registry, AgentPackage@1 with skills, RuntimeProviderPort,
the knowledge and notebook API, Inbox kinds, schedules, the agent-loop and mandate contracts, and
the sender identity. With ADR-0037 (its follow-up PR 2): AgentProposal@1 and its "Add to team"
document, TeammateResult@1 and result items, AgentPackage@1 for workspace-authored packages, and a
tool catalogue version with `agent.ask`, `agent.result.read` and `agent.propose`, in place of
SpecialistSpec@1, the Start document and the Specialist ceiling, which retire.

Merged so far: the contracts slice in V1-PR10 (#52: the tool catalogue, AgentPackage@1, ModelCall@2,
mandates and triggers, SpecialistSpec@1, the Start document and the sender identity);
RuntimeProviderPort in V1-PR07 (#51, track T10); and, with ADR-0033 and ADR-0034, goal measure
fields, everyday-area templates, `plan.draft` and the plan start document behind default-off
switches (V1-PR18, #58). Still to come: new Inbox item kinds (PR 10b) and the knowledge and notebook
API (with V1-PR20).
