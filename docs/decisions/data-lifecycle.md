# Data and retention policy

Selected design: canonical sequence45. Machine-readable defaults are deployment-policy.json. A US-hosted database is not a claim of universal US processing: identity, Shopify, external connectors and models have independent terms and controls. Do not send protected content until that provider/class has current eligibility and tenant authorization. Primary storage defaults to the US; approved global application/provider processing is permitted. Account region, subprocessors and backup configuration remain qualification evidence.

| Class | Default | Deletion and access |
| --- | --- | --- |
| Temporary working files | Seven days after run closure | Scope-bound; prune unneeded content sooner; revoke leases on cancellation |
| Minimized raw webhooks | Seven days | Sensitive body fields minimized before retained logging; subject erasure overrides |
| Normalized commerce cache | Ninety days where needed | Freshness and tenant/store/field scope apply; source tombstones and subject erasure override |
| Shared artifacts | Until merchant deletion | Immutable versions do not exempt content from erasure; authorized version history only |
| Content-free audit/usage metadata | 365 days | No transcripts, addresses or content in metadata; pseudonymize/redact subject associations |
| Redacted diagnostic logs | Fourteen days | No credentials, bodies or private model prompts; access restricted |
| Closed workflow execution state | Thirty production/seven staging days | Opaque references and safe state only; open histories bounded through continuation |
| Database PITR | Thirty production/seven staging days | Restore restricted/quarantined; erasure/revocation ledger reapplied before access |

Account identity records (P05.T01x Part B, ADR-0009 item 6). All four tables are append-only through the trigger function `account_preserve_record()`, the replaceable hook: P09.T05 replaces it in a later forward migration so a dedicated privacy-maintenance role can erase or pseudonymize rows (the 0010 `login_flow_events` idiom).

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `account_enrollments` | Identity association; principal lifetime | P09.T05 deletes it after principal erasure |
| `account_session_commands` | Content-free audit, 365 days; the tuple holds subject and provider-session ids | Pseudonymize the tuple after family expiry plus 30 days (production) or 7 days (staging); P09.T05 or P05.T01y |
| `organization_signups` | Audit and replay record; organization lifetime | Pseudonymize the principal association on erasure |
| `self_service_revisions` | Platform configuration audit; at least 365 days, latest row kept | None; `approval_ref` must not be personal data |

No real user may enroll until the P09.T05 deletion path covers principal, mapping and enrollment (ADR-0003 hard ordering (b)); self-service stays disabled except on development and staging profiles with an allowlisted WorkOS sign-up (ADR-0009 items 10 and 11).

Daily recovery snapshots/exports are separately retained thirty-five days in production/seven in staging; they do not provide thirty-five-day point-in-time recovery. Qualify changed storage, matching artifact revision manifests and erasure/revocation replay.

These durations are product defaults rather than claimed legal obligations. Any legitimately required financial retention requires a documented basis, exact data class, restricted access and expiry. Do not quietly retain all customer payloads under an accounting exception.

Shopify mandatory privacy topics apply to public apps regardless of granted data scope. Verify HMAC, durably acknowledge, authenticate subject/shop scope, process customer access/erasure and shop redaction, and track deadline/retry evidence. The documented completion deadline is thirty days; the uninstall-related shop redaction delivery has its own timing. Operational target: start promptly and finish routine erasure within 24 hours, while recording valid exceptions. [Shopify privacy requirements](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)

Object versions, derived search indexes, embeddings if later added, artifact previews, context snippets and external model/provider retained copies are included in the deletion plan. Erasure ledger must survive a restore of older business data; P04 decides its independent retention/durability and tests replay. A record in the restored database alone cannot prove post-backup deletions are remembered. Revocation/deletion replay precedes reads, dispatch and connector reactivation.

OpenAI store:false is required but does not establish zero retention. Regional project eligibility, model/endpoint availability and retention controls require separate account evidence. Hosted files, vector stores, background jobs and other retained tools cannot silently enter an approved low-retention route. Redact or deny sensitive classes where an allowed provider route is absent. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

Migration: none yet. P07/P09/P10 implement classified bytes/projections/deletion; P04/P18 qualify recovery. Every policy change names retained content and dependent runs; increasing retention or changing processors requires the canonical plan to change first.
