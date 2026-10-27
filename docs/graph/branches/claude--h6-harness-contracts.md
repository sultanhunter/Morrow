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

Merged main at 14644dec (pull request 89, OD-2026-10-26-12): AgentRunSafety@1 has no cost
check-in and CheckInCode no cost; the slot wait is a send slot, with no per-person cap.

Review R1 to R5 of c72b4688 (2026-10-27): H6's records accept what H5's tool inputs accept
(ContextLabel, MemoryLayer, CheckpointLine and PersonMemoryKind are H5's byte for byte; the
checkpoint body is context.checkpoint's input; nothing_found; H5's arrays, kinds and text), with
a per-definition merge step in the brief; a healthy reply past a stored bound is incomplete, not
a protocol break; JobStatus@1 is never done, stopped or failed with an operation unconfirmed;
plans, verdicts and the ledger carry source subjects (the ledger also read tags and audience);
the context policy generator refuses an inline bound a result block cannot hold.
