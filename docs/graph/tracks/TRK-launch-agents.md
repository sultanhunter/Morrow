---
id: TRK-launch-agents
type: track
title: Launch agents and evals
label: T12
status: proposed
weeks: W4 to W9 (3 to 5)
links:
  includes: [P15.T03, P16.T01, P17.T03, P17.T04]
  defers: [P15.T01, P15.T02, P15.T05, P16.T02, P17.T01, P17.T05]
  delivers: [AG-listings, AG-business-analyst, AG-inventory, AG-support, AG-marketing, F-evals-and-releases, SK-listing-content, SK-seo-metadata, SK-tags-and-collections, SK-image-alt-text, SK-daily-pulse, SK-weekly-review, SK-sales-investigation, SK-stock-cover, SK-reorder-planning, SK-support-replies, SK-promotion-plan, SK-discount-proposals]
  depends_on: [TRK-agent-platform, TRK-proactivity, TRK-shopify-app, TRK-e2b-runtime, TRK-email]
  governed_by: [ADR-0023, ADR-0027]
---

Six packages from 12 skill files, with golden and injection evals recorded in CI and run live; the
`morrow.specialist` release with routing and composition evals; for the flow, AI-answer readiness
checks in `listing-content`, a source for each factual sentence in Listings' suggestions, Business
Analyst's weekly project note, and evals for request sorting, plan drafts and unsourced sentences.
In the v1 order: V1-PR22 to V1-PR25. Listings itself was built in the beta (#39, #44).

Left until after launch: the skill registry, the research workbench and maintained expertise, the
agent builder, the full provider operation contracts and the cross-functional scenario
(F-agent-builder, F-more-integrations).
