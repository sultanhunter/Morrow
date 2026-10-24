---
id: TRK-collaboration
type: track
title: Collaboration backend
label: T6
status: active
weeks: W1 to W4 (1 to 2)
links:
  includes: [P05.T01, P05.T02, P07.T01, P07.T02, P07.T03, P14.T02, P06.T02]
  defers: [P05.T01aa]
  delivers: [F-team-and-roles, F-task-board-and-threads, F-inbox-and-notifications, F-artifacts-and-uploads, F-activity-log, F-projects-and-goals]
  depends_on: [TRK-interfaces, TRK-email]
  governed_by: [ADR-0016, ADR-0017, ADR-0033, ADR-0034]
---

Invitations and roles, threads and mentions, Inbox kinds, notifications, artifacts and uploads, read
tags. For the flow: the Monday project update, the morning summary email (counts only), the
notification levels, "Make this a task?" and step-ready assignment items. Projects behind the scenes
(V1-PR18, #58) are its first merged part. Invitations and roles come after v1 ("Later, when you need
it", docs/plan/v1-build-order.md). Enterprise teams, SSO and SCIM (P05.T01aa) wait until after
launch (F-enterprise-identity).
