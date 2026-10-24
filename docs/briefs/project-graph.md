---
id: TRK-project-graph
type: track
title: Project graph
label: T16
status: active
weeks: W0 to W3 (1)
links:
  depends_on: [TRK-decisions]
  governed_by: [OD-2026-10-23-1, ADR-0023]
---

# Project graph (track T16)

- Status: brief, 2026-10-23. Owner decision 10 of the redefined MVP ("yes to all recommended", 2026-10-23; OD-2026-10-23-1, ADR-0023), answering the owner's request of 2026-10-22 for a graph in place of unlinked Markdown files (OD-2026-10-22-1). Change class: routine under ADR-0002 (harness, CI and docs): no authority, tenancy, money, provider or retention change.
- Branch `claude/graph-engine`; one PR for phase 0. This file's header is the track's node.

## Goal

One linked, checked graph of the project's knowledge and progress. Docs stay where they are and each becomes a node; what already has a home is derived from it, and only what has no home is hand-written under `docs/graph/`. CI fails when the graph is inconsistent, so a stale or unlinked fact is caught on the pull request that makes it.

## Scope (phase 0 only)

- `scripts/graph-schema.mjs`: the closed tables (node types with id shapes, fields and statuses, edge types, error and warning codes).
- `scripts/graph.mjs`: `check`, `show`, `query`, `render`, `view --mermaid`, `status`, `add`, `link`, `unlink` and `set`, all offline. It derives nodes from the plan, `tasks.json`, packets, briefs, ADR header bullets and Approval quotes, live evidence, acceptance tables (an Open or Deferred row only cites its records), the approval card, the registries, `apps/*`, `packages/*` and git history.
- `docs/graph/`: the README (its schema block generated), the vision, the owner decisions of 2026-10-19 to 2026-10-23 with verbatim quotes, one question and one risk.
- Later phases (the MVP as nodes, headers in place and strict mode, the generated STATUS block and the CLAUDE.md session step, archiving) are in `docs/graph/README.md`. CLAUDE.md does not change in phase 0; phase 3 shows the owner the diff first.

## Interfaces touched

- `package.json`: `graph` and `graph:check`; `verify` runs `graph:check` right after `plan:check`. `yaml` 2.9.1 is pinned as a dev dependency (it was already in the lockfile through vite and neonctl); the lockfile changes only for it.
- `.github/workflows/ci.yml`: `fetch-depth: 0` on the `checks` job, so merged pull request nodes can be built; the lab jobs keep the default depth (`tests/ci-workflow.test.mjs` pins both). Without history the check warns and never fails.
- `docs/development/ci.md`: the `checks` row and the light-run list.
- Three docs from #17 (two live records and ADR-0019) lose the owner's personal email address; `GRAPH_EMAIL` now scans governed doc bodies.

## Security notes

- The repository is public. `GRAPH_SECRET`, `GRAPH_EMAIL` and `GRAPH_TENANT_RECORD` scan the hand-written graph in full, `GRAPH_EMAIL` every governed doc, and every frontmatter header. The graph describes kinds (agents, skills, installation kinds), never a merchant's records.
- The graph is documentation, never authority: nothing in `apps/` or `packages/` may name its script or files (`GRAPH_IMPORTED_BY_CODE`). Permission, budget and data-class rules stay in code.
- Owner quotes are verbatim and were already public in ADR-0023 and ADR-0021; a decision is never edited after it merges (a later one supersedes, amends or refines it).
- Inputs are closed: an unknown command, flag, value, field or date exits 2 with a fixed code. Headers use the YAML failsafe schema with unique keys and no aliases. `docs:` entries are repository-relative paths. Nothing reaches the network; `graph.html` goes to the git-ignored artifacts directory and is never published from CI (GitHub Pages would need the owner's approval).

## Test checklist

- [x] `tests/graph.test.mjs`: one planted mistake per error code on a fixture that is clean in strict mode; each warning at its boundary (stale work at 7 and 8 days, a card at 15 and 14 days, a gate due W0 on 2026-11-01 and 2026-11-02, an uncovered task).
- [x] Derivations: titles with a dash or an id-only span, hyphen and en-dash ranges, Open and Deferred acceptance rows, shallow history with a live data class, `docs:` paths, README files, the code-import pattern, impossible dates.
- [x] The commands on a temporary git checkout, including `set` refusing `id`, `type`, `links` and `docs`, and a parent task missing from `tasks.json`.
- [x] This repository: no errors, the 18, 80 and 73 counts, every ADR on disk, the ADR index rows, ADR-0023 `approved_by` OD-2026-10-23-3.
- [x] `npm run graph:check` and the full `npm run ci`, tree clean.
- [x] AI review (separate context, same model family); its confirmed findings are fixed.
- [ ] Hosted CI on the PR head.
