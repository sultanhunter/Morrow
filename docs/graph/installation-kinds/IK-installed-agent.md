---
id: IK-installed-agent
type: installation_kind
title: An installed agent
status: planned
lifetime: until uninstalled; its mandate lasts 90 days and is renewed
mandate: "yes"
triggers: "yes"
started_by: owner-admin-install
routable: "yes"
authority_records: agent_installations (kind installed), its agent principal and grants, mandate records
links:
  governed_by: [ADR-0024, ADR-0028, ADR-0025]
---

An installation of a pinned agent release: install confirms one server-built document,
stage-and-activate stays (P16.T03), optional Shopify scopes are requested at install. It works on
its own only under a mandate, and the router, mentions, assignments and look-for-work read only
installed rows. Listings is installed this way since the beta. Contracts:
`docs/contracts/agent-installation.md` and `docs/contracts/agent-authority.md`.
