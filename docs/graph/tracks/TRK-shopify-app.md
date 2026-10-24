---
id: TRK-shopify-app
type: track
title: Shopify app
label: T8
status: active
weeks: W1 to W6 (2)
links:
  includes: [P05.T03, P08.T01, P08.T02, P08.T04, P09]
  delivers: [F-shopify-connection, F-public-app, F-embedded-home]
  waits_on: [GATE-shopify-app]
  governed_by: [ADR-0022, ADR-0025, ADR-0035]
---

The app record, the expiring-token custody packet, the session-token identity packet; scopes, with a
scope change stopping only the agents that lost one and raising a "Reconnect" Inbox item (ADR-0025
item 10); reads, bulk operations and webhooks; "Disconnect store"; the maintenance sweep; the
48-hour fallback; `data_request` export; the protected-data request.

Under ADR-0035 v1 connects the owner's store through the custom app first (V1-PR01, #50), Disconnect
store merged as #53 (V1-PR02), and connection health is V1-PR05, building now. The public app
`morrow` follows for other merchants. P08.T04's conformance suite and release checks (spoofed
events, repeated pages, schema changes, token expiry, throttling, asynchronous failures) are what
the Shopify adapter qualifies against, and the Resend adapter after it (build-plan package 17's
dependencies). Whether its connector generator and synthetic provider can wait until after launch is
an open question (Q-p08-t04-launch-scope); until it is answered the whole task stays in.
