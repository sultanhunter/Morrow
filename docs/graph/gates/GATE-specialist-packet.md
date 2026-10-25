---
id: GATE-specialist-packet
type: gate
title: The agent-card authority packet is merged
label: G18
status: open
owner_kind: claude
due_week: W5
links:
  depends_on: [TRK-specialists]
  governed_by: [ADR-0037, ADR-0023]
---

By Friday 2026-12-04. Retitled on 2026-10-25 from the specialist authority packet (ADR-0037 item 9;
the id is kept): the packet is ADR-0037's follow-up PR 3, the forward migrations for the
installation origin, workspace packages, card revisions and documents, the "Add to team" request
as an access change, its transaction and a grant issuer for the workspace origin only
(`docs/plan/adr-0037-implementation.md`).

Slip rule (ADR-0037 item 9, in place of ADR-0023 decision 11's): if G11 is missed, or this packet
is not merged by this date, agent cards move to the first fast follow, 2 to 3 weeks after launch,
and nothing for them starts in W7 to W10: follow-up PRs 3, 6 (the card), 7's card classes and 8's
new-teammate step. Teammate calls and hand-offs to first-party agents (follow-up PRs 4 and 5)
stay, and the skill files ship either way.
