---
id: Q-adr-0030-owner-questions
type: question
kind: decide
title: "ADR-0030 owner questions 1 to 5: sending identity, domain, read key, sender check, caps"
status: answered
asked_of: owner
links:
  answered_by: [OD-2026-10-23-7]
  raised_by: [ADR-0030]
  about: [ADR-0030, F-support-email]
---

1, changed by the owner: a list of sending addresses per workspace, the shop's Morrow address
selected by default, a person picking the sender for each email job; the merchant's own mailboxes
are designed for, not built. 2: one Morrow domain on Cloudflare DNS, separate Resend accounts,
Resend's US region, the DPA before real mail. 3: the full-access read key as a separate broker
secret limited to fixed GET paths. 4: Email Routing at launch, DKIM checks later. 5: item 9's caps
as configuration.
