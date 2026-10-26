---
id: TRK-specialists
type: track
title: Teammates Morrow creates (agent cards)
label: T18
status: proposed
weeks: W1 to W7 (1)
links:
  includes: [P13.T02, P15.T04, P05.T04, P16.T02a]
  delivers: [F-specialists, AG-workspace-created]
  depends_on: [TRK-land-the-train, TRK-interfaces, TRK-agent-platform]
  governed_by: [ADR-0037, ADR-0023]
---

In place of the specialists track since 2026-10-25 (ADR-0037; the id is kept). Owns ADR-0037's
follow-up PRs (`docs/plan/adr-0037-implementation.md`) and the agent-card authority packet (its PR
3, G18); its PRs land in T2 (contracts with fakes), T4 (teammate calls in the loop and Morrow's
tools), T7 (the Team page and the agent card), T14 (data lifecycle) and T12 (evals). If G11 is
missed or the packet is not merged by G18, agent cards, their data classes and the plan's
new-teammate step move to the first fast follow and nothing for them starts in W7 to W10; teammate
calls and hand-offs to first-party agents stay, and a plan's check-up step then names an installed
agent such as Listings. In the v1 order: V1-PR26.
