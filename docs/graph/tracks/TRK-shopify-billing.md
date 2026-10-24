---
id: TRK-shopify-billing
type: track
title: Shopify billing
label: T13
status: proposed
weeks: W4 to W7 (1)
links:
  includes: [P01.T04, P18.T01]
  delivers: [F-shopify-billing]
  depends_on: [TRK-shopify-app]
  governed_by: [ADR-0026, ADR-0015, ADR-0035]
---

App Pricing with a plan and capped usage, credits after confirmed usage records, plan change and
reinstall. ADR-0035 item 3 moves it to before the first outside merchant; until then the owner's
workspace gets test credits (V1-PR06).
