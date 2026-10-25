---
id: IK-installed-agent
type: installation_kind
title: An installed agent, a teammate of either origin
status: planned
lifetime: until uninstalled or removed; its mandate lasts 90 days and is renewed
mandate: "yes"
triggers: "yes"
started_by: [owner-admin-install, card-approval]
routable: "yes"
authority_records: agent_installations (kind installed, with its origin), its agent principal and grants, mandate records; for the workspace origin also the workspace package and its agent card revisions
origins: [first-party, workspace]
links:
  never_holds: [workspace.task.delegate]
  governed_by: [ADR-0037, ADR-0024, ADR-0028, ADR-0025]
---

One agent kind with two origins (ADR-0037 item 4). Every teammate is an installation of this kind
(`kind = 'installed'`) with its own principal, grants, Shopify scopes, model profile, notebook and
visible name, and runs its own `AgentRunWorkflow` loop with a fresh context per run. It never holds
`workspace.task.delegate`, an `agent.*` tool or an `agents.*` capability, so no teammate calls,
hands off to or creates an agent (depth 1, ADR-0037 item 2). Morrow's calls, hand-offs, mentions,
assignments, the router and look-for-work read only installed rows, and it works on its own only
under a mandate.

- **First-party:** an installation of a pinned AgentPackage@1 release. Install confirms one
  server-built document, stage-and-activate stays (P16.T03), and optional Shopify scopes are
  requested at install. Each release keeps its reviewed grant set and its own issuer (the Listings
  issuer of migration 0031 is unchanged). Listings is installed this way since the beta.
- **Workspace:** created when a person approves the exact agent card ("Add to team") under
  ADR-0011's access-change review; for this origin the exact card replaces P16.T03's provisional
  revision and sample, and the review gate stays. A grant issuer for this origin only applies the
  card exclusions (ADR-0037 item 5). It stays until a person removes it.

Contracts: `docs/contracts/agent-installation.md` and `docs/contracts/agent-authority.md`. The
origin column, workspace packages and card records come with ADR-0037's agent-card authority
packet (`docs/plan/adr-0037-implementation.md`, PR 3).
