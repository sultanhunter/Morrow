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

Browser session lifecycle records (P05.T01y, ADR-0004, migration 0016). No row holds content: identifiers, digests, instants and a fixed cause.

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `organization_session_signouts` | Content-free audit, 365 days. A row stays effective while any family committed before it can live (12 hours) or a legacy `sessions` row of the same pair is unexpired | P09.T05 replaces `preserve_session_signout_record()` to pseudonymize `principal_id` on principal erasure and to prune after 365 days |
| `browser_session_generations`, `browser_session_audits` (rotation and reuse rows) | Content-free audit, 365 days; digests and ids only | P09.T05 replaces `preserve_browser_session_record()` for pruning and pseudonymization. P05.T01y adds no pruning path |

Growth: at most one rotation per 5 minutes of activity, so at most 144 generation rows and 144 audit rows per person per 12-hour day, about 105,000 rows per person-year at 365 days. This is a P09.T05 sizing input; no real data exists before P09.T05.

Spine foundation records (M2 PR-1, ADR-0022 item 13, migrations 0019-0024). No row holds merchant content: identifiers, digests, instants, fixed codes and, in the vault, AES-256-GCM envelopes.

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `morrow_work.work_leases` | Content-free audit, 365 days. A lease confers nothing after it ends or expires; a membership removal revokes its member's leases (0023-0024) | None until P09.T05 adds pruning; no delete path exists (`append_only()`) |
| `morrow_work.lease_entries` | Content-free runtime state: one row per database backend (the last lease it entered, its transaction id and a random nonce), overwritten by that backend's next entry | None needed: bounded by the number of backend ids, no tenant keys |
| `morrow_work.stop_controls`, `morrow_work.stop_records` | Content-free audit, 365 days; platform rows have null tenant keys. The reason is operator or member text about the stop, never merchant data | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.operations`, `morrow_work.operation_transitions` | Content-free audit, 365 days: ids, digests, statuses and the provider request id | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_billing.workspace_billing_routes` | Workspace lifetime; the route never changes once fixed | Deleted with the workspace by P09.T05 |
| `morrow_vault.app_secrets` | Until rotated: a retired row keeps only metadata (its key material is erased in the rotating statement) | Rotation (`app_secret_put`) |
| `morrow_vault.credentials` | Until uninstall, disconnect or re-authorisation, which erase the key material at once and keep metadata (M2 PR-2/PR-3 writers) | The destroy path of M2 PR-2/PR-3 |

Billing records (M5 PR-1, ADR-0022 item 13, migration `billing-records`). Financial records are kept for a proposed seven years until the tax advisor confirms the period (the open question of `docs/briefs/M5-billing.md`); every row holds ids, amounts, statuses, times and digests only. No email, name, address, card data, Checkout URL or portal URL is stored. Test-mode rows carry `mode = test`.

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `morrow_billing.billing_terms` | Platform configuration; kept for the life of any grant or payment that names a revision | None: no personal data |
| `morrow_billing.stripe_customers` | Financial record, seven years after the workspace's last payment (proposed); the Stripe customer id and its creating operation | Pseudonymize the workspace association by P09.T05 after the period; the customer itself is erased at Stripe by the owner's request |
| `morrow_billing.stripe_operations`, `morrow_billing.checkout_intents` | Content-free audit, 365 days (an intent that funded a payment follows the payment's period): ids, digests, statuses, the price key and the session id | P09.T05 prunes; no delete path exists |
| `morrow_billing.stripe_event_receipts`, `morrow_billing.receipt_applications` | Financial evidence, seven years (proposed): the normalised object (ids, amounts, statuses, times) and its digest; unattributed receipts have null tenant keys | P09.T05 prunes after the period; an unattributed receipt names no workspace |
| `morrow_billing.receipt_entries` | Content-free runtime state: one row per database backend (the receipt it entered, its transaction id and a nonce), overwritten by that backend's next entry | None needed: bounded by the number of backend ids |
| `morrow_billing.billing_accounts`, `morrow_billing.entitlement_snapshots` | Financial record, seven years after the account's last payment (proposed) | Deleted with the workspace after the period by P09.T05 |
| `morrow_billing.verified_payment_events`, `morrow_billing.credit_grants` | Financial record, seven years (proposed); append-only | P09.T05 prunes after the period |
| `morrow_billing.credit_wallets` | Workspace lifetime; balances only | Deleted with the workspace by P09.T05 |

No real user may enroll until the P09.T05 deletion path covers principal, mapping and enrollment (ADR-0003 hard ordering (b)); self-service stays disabled except on development and staging profiles with an allowlisted WorkOS sign-up (ADR-0009 items 10 and 11).

Daily recovery snapshots/exports are separately retained thirty-five days in production/seven in staging; they do not provide thirty-five-day point-in-time recovery. Qualify changed storage, matching artifact revision manifests and erasure/revocation replay.

These durations are product defaults rather than claimed legal obligations. Any legitimately required financial retention requires a documented basis, exact data class, restricted access and expiry. Do not quietly retain all customer payloads under an accounting exception.

Shopify mandatory privacy topics apply to public apps regardless of granted data scope. Verify HMAC, durably acknowledge, authenticate subject/shop scope, process customer access/erasure and shop redaction, and track deadline/retry evidence. The documented completion deadline is thirty days; the uninstall-related shop redaction delivery has its own timing. Operational target: start promptly and finish routine erasure within 24 hours, while recording valid exceptions. [Shopify privacy requirements](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)

Object versions, derived search indexes, embeddings if later added, artifact previews, context snippets and external model/provider retained copies are included in the deletion plan. Erasure ledger must survive a restore of older business data; P04 decides its independent retention/durability and tests replay. A record in the restored database alone cannot prove post-backup deletions are remembered. Revocation/deletion replay precedes reads, dispatch and connector reactivation.

Model provider (ADR-0022 item 10): Anthropic does not train on commercial API inputs or outputs by default and deletes them within 30 days; content flagged by its trust and safety systems may be kept up to 2 years, and the classification scores of flagged content up to 7 years. Structured-output schemas are cached up to 24 hours after their last use and hold no merchant data. Zero data retention needs an agreement Morrow does not have, so disclosures say "up to 30 days; if flagged by Anthropic's safety systems, the content up to 2 years and its classification scores up to 7 years". Only the merchant's request text and product catalogue fields are sent; Morrow stores neither prompts nor raw outputs. Files, Batches, code execution, Managed Agents and other retained provider features cannot silently enter this route. Regional processing (`inference_geo`) and model or endpoint eligibility require separate account evidence. Redact or deny sensitive classes where an allowed provider route is absent. [Anthropic API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)

Migration: none yet. P07/P09/P10 implement classified bytes/projections/deletion; P04/P18 qualify recovery. Every policy change names retained content and dependent runs; increasing retention or changing processors requires the canonical plan to change first.
