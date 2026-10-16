# Morrow
A standalone Shopify business workspace for people and AI agents, connected through a thin Shopify integration app.

The [canonical build plan](https://chatgpt.com/space/page_b1ef27b80b788191b91e67cbb52f1037) controls implementation. Read AGENTS.md, docs/progress/checkpoint.md and the current Page before each task.

The foundation includes separate standalone, connector, API and no-dispatch worker shells, generated contracts, tenant-bound PostgreSQL identity and permission boundaries, controlled store linking, and local synthetic-provider login/session integration. Current-family logout has a separately qualified provider-free boundary. The private fixed WorkOS wire adapter passed local synthetic-provider integration. The active packet qualifies its captured Cloudflare Workers Fetch binding; native application access remains denied. P02's option1 interaction prototype still needs real participant qualification before feature UI is accepted. Hosted identity, real Shopify installation, orchestration and merchant execution remain separate build-plan gates.

## Local setup
Use Node24.13.0 (.nvmrc) and the pinned lock; no credentials needed.

```sh
npm ci --ignore-scripts
npm run ci
npm run smoke:scaffold
```

Local verification includes repository tests, scaffold denial checks, actual Workers execution, isolated PostgreSQL laboratories and local HTTPS transport tests. Read docs/progress/checkpoint.md and the source-bound reports under docs/evidence for current counts, outcomes, retained failures and exact-head hosted CI status. Synthetic fixtures, HTTP cookie jars and local tests do not establish actual browser-engine enforcement, hosted provider access or merchant activation. See docs/development/local-setup.md, repository-map.md and delivery.md for setup and limits.

npm run dev:workspace serves a bare standalone shell; dev:connector explicitly enables a local synthetic entry. Real connector/auth entries fail closed, production refuses fixtures. Full design prototype is docs/design/prototype.html, sample data only; it is not accepted production feature UI. Lab examples never call providers or complete real work. Billing review models never emit charges. No merchant price, provider grant or paid provisioning is activated.

Update scope/architecture in the canonical Page first, then refresh the snapshot, consumed records, packets and evidence. The plan preserves all18packages,80tasks,73acceptance cases and14domains.

The selected stack is Cloudflare Workers/Workflows/Queues/R2, Neon PostgreSQL and replaceable E2B Linux microVM execution. Active infrastructure scripts compile deterministic environment inventories without deployment. The undeployed AWS/CDK/Temporal candidate is historical. Read infra/README.md and docs/packets/P04.T01h.md for provider and hosted qualification boundaries.

The E2B operator laboratory uses a provider-neutral port, a dedicated fixed native API adapter and an offline-default command: `npm run lab:e2b-development`. Provider SDK types and wire references do not authorize live SDK networking. Its approved historical image/file-persistence trials and verified cleanup are recorded separately; all allocation allowances are consumed. It does not implement merchant execution or P12. Further effects require their own qualified account, image, cost and action scope. Legacy Daytona permits original-operation cleanup only.
