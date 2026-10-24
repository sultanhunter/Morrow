---
id: TRK-email
type: track
title: Email
label: T11
status: proposed
weeks: W2 to W5 (1)
links:
  includes: [P17.T01, P17.T02g]
  delivers: [F-support-email]
  waits_on: [GATE-email-vendor]
  governed_by: [ADR-0030, ADR-0031]
---

The inbound Email Worker, forwarding, sending addresses (the list, the Morrow address and its
allocator, the per-kind adapter map), the Resend adapter with idempotency and status, BCC, domain
verification and the mail data class. In the v1 order it arrives with Customer Support (V1-PR25).
Of package 17 it takes the Resend adapter (P17.T02g) and P17.T01's support-reply operation
contract (ADR-0030 unblocks both); the other adapters and contracts wait (TRK-launch-agents).
