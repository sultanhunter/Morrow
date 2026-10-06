# Morrow
A standalone Shopify business workspace for people and AI agents, connected through a thin Shopify integration app.

The [canonical build plan](https://chatgpt.com/space/page_b1ef27b80b788191b91e67cbb52f1037) controls implementation. Read AGENTS.md, docs/progress/checkpoint.md and the current Page before each task.

P01 documentary foundation is self-reviewed. P02 option1 navigation/tokens/responsive interaction prototype is ready for real participant qualification. P03 provides separate standalone, connector, API and no-dispatch worker shells; generated contracts/clients, deterministic fixtures and local delivery checks. Feature UI waits P02, while actual installation/session database/authority/orchestration/providers are later packages. No production workspace or paid agent service is claimed.

## Local setup
Use Node24.13.0 (.nvmrc) and the pinned lock; no credentials needed.

```sh
npm ci --ignore-scripts
npm run ci
npm run smoke:scaffold
```

515 deterministic repository tests; 54 recorded prototype browser cases and nine scaffold guards. Local type/build/format checks cover 334 generated schema definitions, 103 capability pairs, import/compatibility/known-secret/migration integrity. Native screen-reader/merchant success, remote CI/protected review and real database/provider qualification remain separate. See docs/development/local-setup.md, repository-map.md and delivery.md for exact limits.

npm run dev:workspace serves a bare standalone shell; dev:connector explicitly enables a local synthetic entry. Real connector/auth entries fail closed, production refuses fixtures. Full design prototype is docs/design/prototype.html, sample data only; it is not accepted production feature UI. Lab examples never call providers or complete real work. Billing review models never emit charges. No merchant price, provider grant or paid provisioning is activated.

Update scope/architecture in the canonical Page first, then refresh the snapshot, consumed records, packets and evidence. The plan preserves all18packages,80tasks,73acceptance cases and14domains.
