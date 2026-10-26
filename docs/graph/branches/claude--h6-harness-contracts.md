---
id: claude/h6-harness-contracts
type: branch
title: "H6: harness contracts with fakes (ADR-0041's contracts; first of two PRs)"
status: open
links:
  implements: [TRK-agent-platform]
---

Built from 2107859d (pull request 83 merged) for plan row H6 of the harness foundations plan:
ModelCall@2 as ids and digests only, ModelResult@2 with compaction, run_turns and the run
manifest edited, AgentRunSafety@1 in place of AgentRunCaps, ADR-0041 item 34's codes, and
ContextPolicy@1, ContextEpoch@1, ContextCheckpoint@1, ContextLedger@1, RunPlan@1,
RunCompletion@1, ReviewVerdict@1, RunWait@1, RunEvent@1, JobStatus@1, ConversationSummary@1,
PersonMemory@1, PersonMemorySuggestion@1, NotebookEntry@2 and MemorySearchHit@1 in the unfrozen
v1.1 set, with deterministic fakes, the context policy's version 1 (proposed) and its generator,
and conformance tests. No migration, route, capability or switch. ADR-0040's contracts (v1.2,
StandingRequest@1, the stop and revoke capabilities, the morrow and live routes) follow in the
second PR.
