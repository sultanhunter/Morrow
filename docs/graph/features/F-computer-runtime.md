---
id: F-computer-runtime
type: feature
title: "A fresh E2B sandbox per run: no internet, no credentials, no browser"
status: active
area: Runtime
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P12.T01, P12.T02]
  defers: [P12.T05]
  holds: [DC-sandbox-files]
  governed_by: [ADR-0029, ADR-0035]
---

Minimised inputs with no customer fields; PNG, CSV or XLSX outputs only, checked and served as
downloads; TypeScript fallbacks when the computer is off. Merged: the foundation (V1-PR07, #51).
Building: Connect E2B (V1-PR08). Then the check and switch (V1-PR09) and computer tools (V1-PR13).
The earlier synthetic qualification is `docs/decisions/e2b-runtime-lab.md`.
