---
id: RISK-launch-target-drift
type: risk
title: Docs keep naming the dropped invite-only beta as the launch target
status: mitigated
links:
  raised_by: [OD-2026-10-22-2]
  about: [ADR-0021, CLAUDE.md, docs/plan/mvp.md, docs/progress/STATUS.md]
  mitigated_by: [Q-mvp-scope-adr, ADR-0023]
---

After the owner dropped the invite-only listings beta on 2026-10-22 (OD-2026-10-22-2), CLAUDE.md,
`docs/plan/mvp.md`, `docs/progress/STATUS.md` and Claude's private memory still name it as the
launch target (ADR-0021). Nothing linked them to that decision, so an agent that reads them first
plans the old launch.

Mitigation: the MVP ADR (Q-mvp-scope-adr) supersedes ADR-0021 items 1, 4 and 6; phase 1 turns
`docs/plan/mvp.md` into a pointer to it; phase 3 changes the CLAUDE.md session-start step after
the owner sees the diff. Until then `graph:check` warns `GRAPH_WARN_SUPERSEDED_BASIS` for ADR-0021
and lists the docs that still cite it.

Progress 2026-10-23: ADR-0023 merged (PR #45) and the owner accepted it as written
(OD-2026-10-23-4). CLAUDE.md, `docs/plan/mvp.md` and STATUS name it as the launch plan, and
CLAUDE.md's session-start step runs the graph's status command (OD-2026-10-23-7, item 35).
Claude's private working notes now name ADR-0023 too, so the risk is mitigated.
