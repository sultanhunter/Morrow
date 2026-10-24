---
id: F-support-email
type: feature
title: "Support email: inbound forwarding, approved replies through Resend, sending addresses"
status: planned
area: Email
must: "yes"
links:
  part_of: [V-morrow]
  includes: [P17.T02]
  holds: [DC-customer-mail, DC-mail-deliveries, DC-sender-identities]
  waits_on: [GATE-email-vendor, GATE-deletion-paths]
  governed_by: [ADR-0030, ADR-0031]
  approved_by: [OD-2026-10-23-7]
---

Inbound by forwarding (Cloudflare Email Routing); outbound support replies only after approval, with
an idempotency key and status; a BCC to the merchant; the sender picked from the workspace's list of
sending addresses, the shop's Morrow address by default (ADR-0030 item 10). No supplier email.
V1-PR25.
