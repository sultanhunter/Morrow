---
id: F-specialists
type: feature
title: "Teammates Morrow creates: agent cards a person approves (workspace-created agents)"
status: planned
area: Agents and catalogue
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P13.T02, P15.T04, P05.T04, P16.T02a]
  holds: [DC-agent-cards, DC-add-to-team-documents, DC-workspace-agent-text, DC-removed-agent-authority]
  waits_on: [GATE-specialist-packet, GATE-deletion-paths, GATE-gateway-reservations-stops]
  governed_by: [ADR-0037, ADR-0023, ADR-0024, ADR-0011, ADR-0027]
  approved_by: [OD-2026-10-23-3, OD-2026-10-25-3, OD-2026-10-25-4]
---

In place of on-demand specialists since 2026-10-25 (ADR-0037; the id is kept). When no teammate
covers the work, Morrow drafts a new one as an agent card (AgentProposal@1) from first-party skills
and the fixed tool catalogue; code derives its grants, scopes, data classes, triggers, run limits
and model. A person approves the exact card with "Add to team" under the access-change review (a
solo Owner's phrase and cool-down, or a second member), and the agent joins the Team page as a
teammate like a first-party one, until a person removes it (AG-workspace-created). This is the
launch slice of the agent builder, P16.T02a; the full builder stays after launch (F-agent-builder).

Guardrails (ADR-0037 item 5): only people approve; nobody grants beyond their own grants with
`delegate`; the Owner for store writes, order reads, spend and customer messages; never an
`agent.*` tool, `workspace.task.delegate`, `agents.*`, a `human_only` capability, Level 2 customer
data or `support.*`; taint shown and kept; at most 10 per workspace. No money cap: credits are the
only spend limit (ADR-0037 item 6, OD-2026-10-25-4).

Switches committed off; none goes on before G9, G10, the agent-loop switch and a passing eval round.
If G11 is missed or the agent-card authority packet is not merged by G18 (2026-12-04), agent cards
move to the first fast follow (ADR-0037 item 9). Teammate calls and hand-offs to first-party agents
belong to F-coordinator and F-agent-loop and stay either way. V1-PR26, by ADR-0037's follow-up PRs
(`docs/plan/adr-0037-implementation.md`).
