# Morrow selected infrastructure

Canonical sequence45 selects Cloudflare Workers/Workflows/Queues/R2, Neon PostgreSQL and Daytona Linux VM execution. WorkOS remains identity. The AWS/CDK/Temporal baseline is superseded and undeployed; its copied definitions/cost records are under docs/history/aws-baseline. Remaining CDK source/tests are historical regression material, not active hosting selection. No AWS account or Temporal namespace is needed.

## Active local tooling

`npm run infra:synth`, `infra:permissions` and `infra:readiness` compile the selected environment inventories into docs/evidence/P04.T01a. They make no provider calls and cannot deploy, grant permissions or authorize expenditure. Owned provider selectors, image digests, compute limits and receipts remain unbound. Unreviewed JSON changes are rejected; a JSON approval cannot activate resources. This exact-design checker is not production configuration or provider authorization.

`npm run cost:estimate` calculates a published-rate,100-merchant illustrative workload at approximately $859.23/month, excluding models/tools,35-day daily recovery bytes, added environments, observability/email, enterprise identity/contracts and other stated terms. It charges gross Daytona disk without trial/disk credits. Real workload measurements and a complete provider/environment-bound quote precede paid activation. Installed agents and concurrency alone do not determine runtime cost.

## Responsibility and authority

Separate API, connector, orchestrator and credential-broker Workers use environment-scoped bindings. Only the broker can access raw merchant/model credentials; it performs approved calls after current tenant, scope, operation and budget checks. Worker bindings do not establish tenant authorization. Secrets Store is beta and not automatically production-qualified. Session/private responses must not be cached.

Neon PostgreSQL owns business truth; Cloudflare Workflows owns resumable execution checkpoints; Queues carries opaque notifications from durable outbox/inbox records. Actual workflow versions, waits/events, duplicate delivery and uncertain effects must be qualified. No Temporal replay assumptions or retained-workflow behavior is claimed by local manifests.

Neon runtime, issuer, migration and recovery roles remain separate. Every interactive transaction sets tenant context using SET LOCAL and validates current identity. Qualify the actual Workers-compatible driver, pool lifecycle and reused-connection cross-tenant denial before hosted login. Local pinned PostgreSQL17 laboratories remain engineering evidence, not Neon provider acceptance.

Private R2 artifacts use unique revision keys, checksum/manifests and conditional creation. Do not substitute S3 version identifiers or assume bucket locks solve authorization/deletion. Current policy must gate reads, previews and transfers, and erasure applies to derived copies and recovery replay.

Daytona explicitly uses Linux VM class; its default container class is not equivalent. Working files are tenant/agent-owned with one writer generation and isolated scratch for overlapping runs. No database, platform/model/Shopify keys or unrestricted direct internet enters a sandbox. Enforce broker/proxy leases and test actual effective network behavior, including redirects, rebinding, private/metadata addresses, alternative protocols and quota-tier exceptions. Keep execution disabled until P12 qualifies this profile. Pause releases CPU/RAM but reserved disk remains billed. Merchant artifacts and durable agent memory belong in governed Neon/R2 records, not only working disks.

## Regions and recovery

US is the default primary-storage preference; approved global processing is permitted. Do not impose an end-to-end US-only promise or enterprise localization add-on by default. Actual storage/provider identifiers remain a preflight input.

Production Neon Scale PITR is30days and staging7days. Separate daily recovery snapshots/exports retain35production/7staging days, with separately measured bytes, recovery granularity and cost. This is an explicit change from35-day Aurora PITR, not equivalent point-in-time coverage. Closed workflow state retains30production/7staging days. Other established retention/deletion rules remain in deployment-policy.json.

Restore into quarantine; verify R2 revision manifests and relational integrity, replay independent later erasure/revocation markers, invalidate old generations and reconcile newer workflow/provider effects. Only authenticated current authority can reopen access or dispatch. Preserve unmeasured99.9% availability/five-minute RPO/sixty-minute RTO targets until actual drills qualify them.

## Next bounded implementation

Read docs/packets/P04.T01a.md and the live build plan. Qualify owned staging provider bindings and implement selected adapters with pinned official SDK/tool versions, preserving all existing SQL migrations and P05 identity/policy work. Local CI and scaffold guards precede controlled hosted tests; actual service identity, rotation, recovery and activation remain open. No paid provisioning, credential copying or deployment is performed by this reconciliation.
