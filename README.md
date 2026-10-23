# Morrow

Morrow is a paid AI workspace where a Shopify brand's people and AI agents run the business together. It has one standalone web workspace and a thin Shopify connector for install, link, status, reconnect, disconnect and return. The Coordinator scopes work, specialist agents draft, people approve exact proposals, and one gateway executes, reads back and audits. Morrow owns all authorization; titles and delegation never confer authority.

## Where decisions live

- **Plan of record:** [docs/plan/build-plan.md](docs/plan/build-plan.md) (ADR-0001), with 18 packages, 80 parent tasks and 73 acceptance cases. `npm run plan:check` lints it.
- **Decisions:** [docs/decisions/adr](docs/decisions/adr/README.md), ADR-0001 to ADR-0013.
- **Current state:** [docs/progress/STATUS.md](docs/progress/STATUS.md) has the active packet, last green commit, next action and pending owner actions.
- **Working rules for coding agents:** [CLAUDE.md](CLAUDE.md).
- **Packets and acceptance tables:** `docs/packets/` and `docs/acceptance/`.
- **History:** evidence and records from before 2026-10-17 are at the tag `codex-archive-f89ad75` ([docs/history/INDEX.md](docs/history/INDEX.md)).

## What exists

- Contracts v1: 103 capabilities in 14 domains, generated types and ahead-of-time validators, and import-boundary checks.
- A local identity engine (P05.T01a to P05.T01v), tested on workerd and real PostgreSQL 17. It has 11 forward migrations with FORCE RLS and restricted roles, WorkOS PKCE login and token verification, workspace selection, `__Host-` browser sessions, workspace bootstrap, controlled store linking and logout. One Workers API composes them, and its default export denies.
- A human permission kernel and an agent-authority intersection kernel over synthetic readers.
- Shells: a bare standalone workspace, a connector entry that fails closed, an API and no-dispatch workers. Environment inventories for the selected stack (Cloudflare Workers, Workflows, Queues and R2; Neon PostgreSQL; E2B; WorkOS), with no deployment.
- Option 1 design candidates in `docs/design/`, sample data only. They are not accepted feature UI. ADR-0032 (2026-10-23) replaced option 1 with Sunrise; the workspace UI track replaces these candidates.

## Not built yet

Signup, a real workspace UI, Shopify installation and sync, work state, model or agent execution, billing and any hosted deployment. The plan's "Next work" section orders them: the deployable composition root (P04.T02a), signup and the workspace list (P05.T01x), work commands (P06.T01a) and contract v1.1 (P01.T02a-T02c), then hosted staging (M1) and milestones M2 to M5.

## Local setup

Use Node 24.13.0 (`.nvmrc`; Homebrew `node@24` works) and the pinned lockfile. No credentials are needed.

```sh
npm ci --ignore-scripts
npm run ci
npm run smoke:scaffold
```

The labs run real workerd and PostgreSQL 17 in the groups CI uses: `npm run lab:workspace-api-workers`, `lab:group:workers`, `lab:group:pg-core`, `lab:group:pg-linking` and `lab:group:pg-http`. The PostgreSQL groups need Docker running. `lab:group:pgwire` runs only on Linux CI. Reports go to the git-ignored `.artifacts/` directory. `npm run dev:workspace`, `dev:connector` and `dev:api` serve the local shells.

## CI

`.github/workflows/ci.yml` runs parallel jobs behind the `foundation` aggregator, the check to require once branch protection exists. Each job secret-scans its reports and uploads them as an artifact; the green run and its artifacts are the evidence for a commit (ADR-0012). [docs/development/ci.md](docs/development/ci.md) describes the jobs and how to run each one locally.
