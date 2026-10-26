---
id: DC-add-to-team-documents
type: data_class
title: The "Add to team" documents
status: planned
retention: 24 hours after use or expiry
deletion: a deletion handler in the one registry, under the retention sweep, written in the PR that first writes the class
customer: "no"
links:
  deleted_by: [TRK-specialists, TRK-privacy]
  governed_by: [ADR-0037, ADR-0031]
---

Server-built, bound to the card's digest, the actor and a standalone-workspace session, valid 5
minutes and consumed once (ADR-0037 item 4). In place of DC-start-documents, on the same clock.
