---
id: GATE-anthropic-key
type: gate
title: The owner's Anthropic key with a monthly spend limit
label: G4
status: open
owner_kind: owner
due_week: W0
links:
  governed_by: [ADR-0035, ADR-0027]
---

The owner sets a monthly limit on the key's workspace and saves the key with `morrow_put`; Claude
places it on the broker with a command that never prints it, and the model switch goes on in a
reviewed commit (V1-PR02). Live evals need it.
