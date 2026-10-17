# Morrow
A standalone Shopify business workspace for people and AI agents, connected through a thin Shopify integration app.

The plan of record is [docs/plan/build-plan.md](docs/plan/build-plan.md) (ADR-0001), and decisions are recorded in [docs/decisions/adr](docs/decisions/adr/README.md). Read [docs/progress/STATUS.md](docs/progress/STATUS.md) for the current state and next action before each task.

The foundation includes separate standalone, connector, API and no-dispatch worker shells, generated contracts, tenant-bound PostgreSQL identity and permission boundaries, controlled store linking, and local synthetic-provider login/session integration. Current-family logout has a separately qualified provider-free boundary. The private fixed WorkOS wire adapter passed local synthetic-provider integration. Its captured Cloudflare Workers Fetch binding is qualified through local interception. The active controlled-Neon packet continues at canonical89 after the isolated test exposed an unavailable Docker port publication. Its fixture will use an attested owned internal-container endpoint, with native WebSocket, independent protocol and actual PostgreSQL qualification still required. Native application access remains denied. P02's option1 interaction prototype still needs real participant qualification before feature UI is accepted. Hosted identity, real Shopify installation, orchestration and merchant execution remain separate build-plan gates.

## Local setup
Use Node24.13.0 (.nvmrc) and the pinned lock; no credentials needed.

```sh
npm ci --ignore-scripts
npm run ci
npm run smoke:scaffold
```

Local verification includes repository tests, scaffold denial checks, actual Workers execution, isolated PostgreSQL laboratories and local HTTPS transport tests. Reports are written to the git-ignored `.artifacts/` directory; CI runs and their uploaded artifacts are the evidence for each commit. Read docs/progress/STATUS.md for the last green commit and open gates. Synthetic fixtures, HTTP cookie jars and local tests do not establish actual browser-engine enforcement, hosted provider access or merchant activation. See docs/development/local-setup.md, repository-map.md and delivery.md for setup and limits.

npm run dev:workspace serves a bare standalone shell; dev:connector explicitly enables a local synthetic entry. Real connector/auth entries fail closed, production refuses fixtures. Full design prototype is docs/design/prototype.html, sample data only; it is not accepted production feature UI. Lab examples never call providers or complete real work. Billing review models never emit charges. No merchant price, provider grant or paid provisioning is activated.

Record a scope, architecture, authority, provider, billing or gate change in an owner-approved ADR and edit the plan in the same change before implementing it (ADR-0002). The plan preserves all18packages,80tasks,73acceptance cases and14domains.

The selected stack is Cloudflare Workers/Workflows/Queues/R2, Neon PostgreSQL and replaceable E2B Linux microVM execution. Active infrastructure scripts compile deterministic environment inventories without deployment. The undeployed AWS/CDK/Temporal candidate and the Daytona laboratory are retired (ADR-0007); their history is at the tag `codex-archive-f89ad75`. Read infra/README.md and docs/packets/P04.T01h.md for provider and hosted qualification boundaries.

The E2B operator laboratory uses a provider-neutral port, a dedicated fixed native API adapter and an offline-default command: `npm run lab:e2b-development`. Provider SDK types and wire references do not authorize live SDK networking. Its approved historical image/file-persistence trials and verified cleanup are recorded separately; all allocation allowances are consumed. It does not implement merchant execution or P12. Further effects require their own qualified account, image, cost and action scope.
