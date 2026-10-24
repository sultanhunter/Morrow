---
id: TRK-land-the-train
type: track
title: Land the train
label: T1
status: active
weeks: W0 to W2 (1)
docs: [docs/briefs/mvp-architecture.md, docs/briefs/api-session-rate-limit.md, docs/briefs/staging-test-entitlement.md]
links:
  includes: [P03, P04.T01, P04.T02]
  delivers: [F-trust-foundation]
  governed_by: [ADR-0023, ADR-0014, ADR-0019, ADR-0012]
---

Done: the merge train (#37 and #39 to #44) merged and the deployed environment migrated to 0038 on
2026-10-23 (G2). Left: the owner's first sign-in (Q-owner-first-sign-in) and the cleanup PR (dead
code and checks; the Stripe code stays, switched off). The repository, typed boundaries, synthetic
environment and delivery controls of P03 are the base the train landed on; CI changes since then
land here too.

Its beta-era briefs are listed as this track's docs: the M2 to M5 spine, the session-route rate
limit (#41) and the staging test entitlement (#40).
