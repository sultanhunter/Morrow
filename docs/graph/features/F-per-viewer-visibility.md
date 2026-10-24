---
id: F-per-viewer-visibility
type: feature
title: "Per-viewer visibility: every shared item filtered by its read tags"
status: planned
area: Workspace and people
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P07.T05]
  governed_by: [ADR-0031]
---

Every shared item carries the read tags it was built from, computed in code, and the api returns it
only to a viewer who holds view on every tag under live grants (ADR-0031 item 6).
