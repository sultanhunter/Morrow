# Core contract decisions

Owner: Morrow platform owner. Core baseline originated at canonical sequence 13; reconciled through sequence 22. Review: signed Codex semantic self-review, same implementer. Integrated enforcement and independent review remain separate.

JSON Schema 2020-12 seals objects with explicit nullability. IDs are opaque; revisions are positive safe integers. References bind organization/workspace/store/kind/ID/revision/digest. Facts retain observation/source authority. Capability schemas point to closed core definitions; actual provider nested payloads require adapter qualification.

PostgreSQL owns business state/revisions and Cloudflare Workflows execution progress. Outbox/inbox plus stable command/operation identities prevent assumed atomic database-plus-queue delivery. Provider uncertainty remains explicit; readback proves effects. Proposal hashes bind exact review; navigation never retargets an effect.

Merchant and operator namespaces remain separate. Grants intersect initiating/owning principal, installation, resource/field, provider and current policy. An approval cannot create an execution grant. HostContext is a standalone authenticated bootstrap; ConnectorContext cannot supply workspace membership. Historical CrossHostResume supports one-way verified return to Morrow. No deployed consumer needs migration.

P01.T03 records deployment, identity, retention, isolation and provider targets; P01.T04 records installation billing, work-credit/cash ownership and readiness. There is no deployed infrastructure or enforcement engine. Consumer code must qualify the actual controls.
