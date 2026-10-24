---
id: Q-p08-t04-launch-scope
type: question
kind: decide
title: "P08.T04 at launch: the conformance suite only, or the generator and synthetic provider too?"
status: open
asked_of: owner
links:
  about: [P08.T04, TRK-shopify-app, TRK-email]
---

P08.T04 builds a connector generator, a synthetic provider, fixtures and release checks. The build
plan qualifies Shopify and the other real adapters against its conformance suite (P08.A04, package
17's dependencies), and `docs/plan/mvp.md` does not leave any of it until after launch. The
recommendation: keep the conformance suite, fixtures and release checks for the Shopify and Resend
adapters at launch, and move the generator and synthetic provider after launch as a lettered split.
Until the owner answers, TRK-shopify-app includes the whole task.
