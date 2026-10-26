---
id: TRK-agent-platform
type: track
title: Agent platform and loop
label: T4
status: active
weeks: W1 to W6 (2; 3 from W2 to W5)
links:
  includes: [P13.T01, P13.T02, P13.T03, P13.T04, P05.T04, P06.T03, P06.T04, P12.T03, P16.T03, P16.T04, P11.T04, P11.T05]
  delivers: [F-agent-loop, F-coordinator, F-model-and-effort, F-mandates, F-rules-budgets-stops, F-plan-drafts, AG-coordinator, IK-installed-agent]
  depends_on: [TRK-land-the-train, TRK-interfaces]
  governed_by: [ADR-0024, ADR-0027, ADR-0034, ADR-0037]
---

The critical path. `AgentRunWorkflow` with tools and durable waits, manifests, installations of
either origin, the catalogue backend, rules, the Coordinator on a model, model profiles; the
mandates packet; the agent-card authority packet (by W5, G18; ADR-0037's follow-up PR 3, owned by
TRK-specialists); teammate calls in the loop as durable steps, any number per Morrow run, in
sequence or in parallel, with structured results and result items, and Morrow's tools (ADR-0037's
follow-up PRs 4 and 5); the stale-run sweep and the removed-model alert. With ADR-0034: the plan
start transaction behind a default-off switch and Morrow sorting requests into the four card types.
A called teammate cannot ask the person; a handed-off one owns the child task's thread and may
(ADR-0037 item 3). Every run holds and draws credits as it works; no money cap (ADR-0037 item 6).

The agent loop is V1-PR11 (building now); Ask Morrow with per-agent model and effort is V1-PR12.
The run-scoped specialist kind, IK-task-specialist, was retired by ADR-0037.
