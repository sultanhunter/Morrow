---
id: F-artifacts-and-uploads
type: feature
title: Artifacts, and CSV and XLSX uploads opened only in a sandbox
status: planned
area: Work and collaboration
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P07.T01, P07.T02]
  needs: [F-computer-runtime]
  holds: [DC-uploads]
  governed_by: [ADR-0029, ADR-0031]
---

Uploads are at most 10 MB, never parsed by Morrow's web Workers, opened only inside a sandbox and
refused when their header names a customer field (ADR-0029 item 6, ADR-0031 item 5). They wait for
the computer (V1-PR13). Artifact contract: `docs/contracts/artifacts.md`.
