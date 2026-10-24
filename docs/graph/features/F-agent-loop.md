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
  holds: [DC-run-turns, DC-run-tool-calls, DC-product-content-drafted]
  governed_by: [ADR-0027, ADR-0024]
---

`AgentRunWorkflow` generalises `ListingsRunWorkflow`: each tool call is its own durable step with
the effective-authority check and a credit reservation; untrusted content enters only as marked
data. Contracts merged in V1-PR10; the loop is V1-PR11, building now, its switch committed off.
