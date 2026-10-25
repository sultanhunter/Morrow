---
id: F-agent-loop
type: feature
title: One durable agent loop with tools for every agent
status: active
area: Agents and catalogue
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P13.T03, P13.T04, P06.T03, P12.T03]
  holds: [DC-run-turns, DC-run-tool-calls, DC-product-content-drafted, DC-result-items]
  governed_by: [ADR-0027, ADR-0024, ADR-0037]
---

`AgentRunWorkflow` generalises `ListingsRunWorkflow`: each tool call is its own durable step with
the effective-authority check and a credit reservation; untrusted content enters only as marked
data. Contracts merged in V1-PR10; the loop is V1-PR11, building now, its switch committed off.
ADR-0037 adds teammate calls as durable steps: a child run on a child task under Morrow's envelope,
any number per Morrow run, in sequence or in parallel, each returning a TeammateResult@1 with large
outputs as result items, and Morrow's lease re-issued when the last open call ends (its follow-up
PR 4, after V1-PR11).
