---
id: Q-adr-0036-member-ceiling
type: question
kind: decide
title: Confirm catalogue version 3's default member ceiling of 4 credits a product
status: answered
asked_of: owner
links:
  raised_by: [OD-2026-10-25-1, ADR-0036]
  about: [ADR-0036, F-model-and-effort]
---

The owner's answer of 2026-10-25 set Listings' default to Opus 5.5 at medium (4 credits a product)
and removed the unrecovered-cost cap; it did not set the default member ceiling. ADR-0036 item 2
writes 4, so a Member without `governance.model_default.revise` can run the new default; it replaces
the ceiling of 1 the owner confirmed on 2026-10-19 and lets such a Member pick any entry up to 4
credits a product (up to 48 credits and US$6.528 of worst-case model cost a run, from 25 credits
and US$3.30). The alternative is 1, under which that Member cannot run Listings at the default.
The ADR-0036 branch stayed unmerged until the owner answered.

Answered 2026-10-25: "Everyone, up to 4 (Recommended)" (OD-2026-10-25-2, Q1). The default member
ceiling of 4 is confirmed; ADR-0036's Approval and version 3's `owner_confirmation` quote the answer.
