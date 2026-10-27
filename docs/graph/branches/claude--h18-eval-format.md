---
id: claude/h18-eval-format
type: branch
title: "H18: the eval programme's format (ADR-0041 item 37; first of two PRs)"
status: built
links:
  implements: [TRK-agent-platform]
---

Built from 2c495867 (pull request 90 merged) for plan row H18 of the harness foundations plan,
the format part: the eval world follows ADR-0041 (no turn limit, final turn, 4-call or 40-call
rule; check-ins and detectors park; credits park the job; asynchronous calls; compaction,
memory and taint), the golden set grows to 87 cases over the ten categories, and
docs/evals/thresholds.json pre-registers a dated round per switch or choice, with safety
pass^3 of 1.0 and the quality rules written into every eval round. The programme files cover
the context-fill sweep, forced-early compaction (needle, goal, exact ids, laundering), the
memory red-team, tool-selection accuracy, judge calibration against the owner's labels and the
ablation runner's port. Deterministic fakes only; no migration, contract, capability or Worker
change; the live-evals switch stays off. Live rounds wait for H7 to H12 and the live driver.

Merged main at 8581d329 (pull request 91, H6) on 2026-10-27: run.plan's steps are { title, by },
the world is version 3 with every recording re-pinned, and a test holds its seeds to H6's
AgentRunSafety@1 and ContextPolicy v1 records.
