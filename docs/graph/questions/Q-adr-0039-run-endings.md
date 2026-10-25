---
id: Q-adr-0039-run-endings
type: question
kind: decide
title: Which loop-run endings count as failed (free), and a breaker for runs that keep failing
status: open
asked_of: owner
links:
  raised_by: [ADR-0039]
  about: [ADR-0039, ADR-0026, F-agent-loop]
---

The owner decided that a loop run that fails draws no credits (OD-2026-10-26-1). Two things follow that the
owner has not decided; each is put with the lead's proposal, to be answered before rate card v1
publishes and before the first outside merchant:

1. **Which endings count as failed.** Proposed: a run that Morrow, the model or the provider ends
   is failed and free (a provider or internal error, a refusal or invalid output, Anthropic's
   spend limit, Morrow's time limits, a switch turned off). A run that ends with an answer, or
   that a person or the workspace ends, draws what it used: finished, ran out of credits, reached
   its step limit (it still answers, from a final turn without tools), stopped by a person, task
   closed, its standing permission ended, a question nobody answered. The full list of end
   reasons is in ADR-0039 item 2(g).
2. **A breaker for runs that keep failing.** Free failed runs cost Morrow vendor spend, and the
   owner's Anthropic monthly limit is shared by every workspace. Proposed: after three failed
   loop runs in a row, an agent's runs and triggers in that workspace pause until a person resumes
   them, as Listings' breaker does for products. It is a stop condition, not a money cap.
