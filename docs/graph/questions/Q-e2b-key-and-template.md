---
id: Q-e2b-key-and-template
type: question
kind: do
title: Save the E2B key and run the template build
status: open
asked_of: owner
links:
  raised_by: [ADR-0035]
  about: [V1-PR08, TRK-e2b-runtime]
---

In project Morrow-staging the owner creates a key, saves it with `morrow_put` in the owner's own
Terminal, and builds the template with the owner's own E2B login; Claude places the key on the
broker without printing it and never builds the template (ADR-0035 item 6).
