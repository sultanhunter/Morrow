---
id: Q-catalogue-v2-values
type: question
kind: decide
title: Confirm the catalogue version 2 values before the agent loop's switch goes on
status: open
asked_of: owner
links:
  raised_by: [OD-2026-10-23-7]
  about: [ADR-0027, V1-PR11, F-agent-loop]
---

The limits and prices per model of catalogue version 2, including the Coordinator's wall time of 30
minutes and `max_tokens` of 16,000 at high effort, which follow from per-agent model and effort. The
agent loop (V1-PR11) is built with its switch committed off until the owner says yes.
