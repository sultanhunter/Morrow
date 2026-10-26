---
id: claude/h12a-memory-foundation
type: branch
title: "H12a: the memory foundation (notebooks re-keyed by agent principal, memory.search and memory.read)"
status: open
links:
  implements: [TRK-agent-platform, TRK-shop-knowledge]
---

Plan row H12a of docs/plan/harness-foundations-implementation.md, on ADR-0041 items 25 to 30
(Accepted 2026-10-26, OD-2026-10-26-7). Built from origin/main at 2107859d (pull request 83,
migration 0056) as migration 0057: pg_trgm in its own schema, notebooks re-keyed by agent
principal (guarded on empty tables), memory_derivations, memory_repairs and memory_settings, the
v2 notebook write and clear, and the memory.search and memory.read definers with every layer's
predicates before ranking. Brief: docs/briefs/memory-foundation.md. If another migration lands
first, the lead renumbers it at merge.
