---
id: TRK-privacy
type: track
title: Privacy
label: T14
status: proposed
weeks: W2 to W9 (1 to 2)
links:
  includes: [P09.T05, P18.T02, P07.T05]
  delivers: [F-privacy-deletion, F-per-viewer-visibility]
  depends_on: [TRK-shopify-app, TRK-e2b-runtime, TRK-email]
  governed_by: [ADR-0031, ADR-0035, ADR-0037]
---

Deletion paths per data class (agent cards, "Add to team" documents, the instructions and skill
text of agents Morrow creates, removed agents' authority rows and result items included, ADR-0037
item 8, in place of specialist specs, Start documents and retired run-scoped principals), retention
sweeps, workspace erasure, export, and a privacy policy with regions. Under
ADR-0035 item 7 a class that holds no customer data may take the owner's store data before its path,
which is still written in the PR that first writes the class where it can be; customer classes keep
G9 exactly.
