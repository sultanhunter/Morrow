---
id: Q-adr-0039-carried-out-values
type: question
kind: decide
title: Confirm ADR-0039's four readings that the owner's credits-only answer did not decide
status: open
asked_of: owner
links:
  raised_by: [ADR-0039]
  about: [ADR-0039, ADR-0026, F-shopify-billing, F-agent-loop]
---

ADR-0039 makes credits the only spend limit (OD-2026-10-25-4). Writing it out took four readings
that neither the owner's answer nor the lead's reply decided. Each is put to the owner with its
alternative:

1. **Failed loop runs** (ADR-0039 item 2(g)). Proposed: a loop run's turns draw the credits they
   metered however the run ends. This replaces ADR-0026 item 4's owner-approved "Failed runs cost 0
   credits" for loop runs, so it is a price change. Alternative: failed loop runs stay free (their
   cost is recorded, bounded by the run's stop conditions and the Anthropic monthly limit).
   Listings' failed products stay free either way.
2. **The final-turn reserve** (ADR-0039 items 2(d) and 2(e)). Proposed: each loop run keeps one
   worst-case turn of credits for its whole life, so a run that runs out still ends with an
   answer. Alternative: no reserve; a run stops at the first turn the wallet cannot cover, with no
   final answer, and admission needs only that first turn.
3. **The platform ceiling on buying credits** (ADR-0039, Consequences, "Kept, and why"). Proposed:
   keep `UsageCap`'s ceiling of twice the plan price per billing cycle (ADR-0026 owner question 3,
   not yet in code), because it limits what Morrow may put on a merchant's Shopify bill, not the
   use of credits. Alternative: remove it too, as a hardcoded money ceiling.
4. **Per-agent credit limits** (ADR-0039 item 7). Proposed: the per-installation daily and monthly
   caps, which ADR-0026 item 4 let merchants lower and only the Owner raise, go with the other caps,
   and no per-agent credit limit exists. Alternative: an optional per-agent credit limit that the
   Owner sets, none by default.

Until the owner answers, these are readings, not decisions. Readings 1 and 2 serve only the test
credits on the owner's store (ADR-0039 item 3), and rate card v1 does not publish before the
answer, so no merchant is charged under them. The code PRs remove every hardcoded cap either way.
The runtime's US$10 monthly budget is not among these: its removal falls under the lead's "any
other hardcoded money ceiling".
