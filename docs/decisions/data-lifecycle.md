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
| `morrow_vault.credentials` | Until uninstall, disconnect or re-authorisation, which erase the key material at once and keep metadata. First writer: M2 PR-2's `shopify_install_store` (0027), which stores each offline-token envelope and, on re-authorisation, destroys the previous version (reason `reauthorised`) in the same transaction; uninstall and disconnect are M2 PR-3 | Re-authorisation (M2 PR-2); the uninstall and disconnect destroy paths (M2 PR-3) |

Shopify install and link records (M2 PR-2, ADR-0022 items 4-6, migrations 0025-0027). Only development stores of beta workspaces; no product, customer or order data. The shop domain is held on the installation row and the linking candidate, as a digest in the registry and OAuth states, and inside the registry's install link (a `*.myshopify.com` host, or the shop in a custom-distribution link's signed parameter).

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `morrow_identity.shopify_apps` | Platform registry: one row per beta store's custom-distribution app, kept until retired (`shopify_app_retire`). The intended shop is a SHA-256 digest; the install link names the shop, so the row is store content | Retirement clears the install link; `shop/redact` clears it for the redacted installation's own app (redaction handler `shopify_apps`, `clear_install_link`, executable in M2 PR-3), never for an app registered later for the same shop, which may invite another workspace; retired rows keep only metadata |
| `morrow_identity.shopify_oauth_states` | Content-free, 7 days: the app key, digests of the shop and the state, instants; single use, 10-minute window | P09.T05 prunes after 7 days; no delete path exists |
| `morrow_identity.store_installations` | Installation lifetime: ids, the shop id and domain (shop identity), granted scopes, the credential version, status and instants | `shop/redact` pseudonymises the shop identity (redaction handler `store_installations`, executable in M2 PR-3); deleted with the workspace by P09.T05 |
| `morrow_identity.install_continuations` | Content-free, 365 days after expiry: a token digest, its installation and consumption ids; 5-minute window, single use | P09.T05 prunes after 365 days; no delete path exists |

Billing records (M5 PR-1, ADR-0022 item 13, migration `billing-records`). Financial records are kept for a proposed seven years until the tax advisor confirms the period (the open question of `docs/briefs/M5-billing.md`); every row holds ids, amounts, statuses, times and digests only. No email, name, address, card data, Checkout URL or portal URL is stored. Test-mode rows carry `mode = test`.

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `morrow_billing.billing_terms` | Platform configuration; kept for the life of any grant or payment that names a revision | None: no personal data |
| `morrow_billing.stripe_customers` | Financial record, seven years after the workspace's last payment (proposed); the Stripe customer id and its creating operation | Pseudonymize the workspace association by P09.T05 after the period; the customer itself is erased at Stripe by the owner's request |
| `morrow_billing.stripe_operations`, `morrow_billing.checkout_intents` | Content-free audit, 365 days (an intent that funded a payment follows the payment's period): ids, digests, statuses, the price key, the session id and a customer operation's hold time | P09.T05 prunes; no delete path exists |
| `morrow_billing.stripe_operation_resolutions` | Content-free operator audit, 365 days: the operator id, the resolution and evidence codes (fixed sets) and the path of the docs/evidence/live record; no free text | P09.T05 prunes with its operation; no delete path exists |
| `morrow_billing.stripe_event_receipts`, `morrow_billing.receipt_applications` | Financial evidence, seven years (proposed): the normalised object (ids, amounts, statuses, times) and its digest; unattributed receipts have null tenant keys | P09.T05 prunes after the period; an unattributed receipt names no workspace |
| `morrow_billing.receipt_entries` | Content-free runtime state: one row per database backend (the receipt it entered, its transaction id and a nonce), overwritten by that backend's next entry | None needed: bounded by the number of backend ids |
| `morrow_billing.billing_accounts`, `morrow_billing.entitlement_snapshots` | Financial record, seven years after the account's last payment (proposed) | Deleted with the workspace after the period by P09.T05 |
| `morrow_billing.verified_payment_events`, `morrow_billing.credit_grants` | Financial record, seven years (proposed); append-only | P09.T05 prunes after the period |
| `morrow_billing.credit_wallets` | Workspace lifetime; balances only | Deleted with the workspace by P09.T05 |
| `morrow_billing.platform_environment` | Platform configuration (migration `staging-test-entitlement`): one row naming the database's environment, written once by `staging:seed-platform` | None: no personal data |
| `morrow_billing.operator_test_entitlements` | Content-free operator audit (the staging test entitlement, ADR-0022 item 5 amendment), staging only: ids, the approval reference, the operator id, the path of the docs/evidence/live record, credit units, the terms revision, the period and a digest; no free text. Kept with its billing account | Deleted with the workspace by P09.T05; never present in production |

Listings authority, stops and credits (M3 PR-1; ADR-0022 items 3, 11, 13, 15 and 16; migrations listings-identity-bridge, listings-authority, agent-proposals and run-credits). Apart from a person's stop reason and the parameters of a proposal, no row holds merchant or user content.

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `morrow_identity.agent_principals` | Content-free: the workspace's Coordinator and one principal per installation. Installation lifetime (the Coordinator: workspace lifetime) | Deleted with the workspace by P09.T05 |
| `morrow_identity.grants` (agent rows) | Installation lifetime; revoked, never deleted, while the installation exists (agent grants carry no membership) | Deleted with the workspace by P09.T05 |
| `morrow_work.agent_releases`, `model_catalogue_versions`, `model_catalogue_entries` | Platform records: release manifests and catalogue values, no tenant data. Kept for the life of the platform (a run names its catalogue version) | None needed |
| `morrow_work.agent_installations` | Content-free: ids, digests, scope and grant references. Installation lifetime | Deleted with the workspace by P09.T05 |
| `morrow_work.agent_enable_documents` | Content-free audit of each confirm screen (the installation document, its digest, the actor, the session digest and the nonce digest; never the nonce), 365 days | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.work_envelopes`, `morrow_work.delegation_hops` | Content-free audit of each run's mandate and dispatch, 365 days | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.kill_switch_records` | Workspace content (the person's reason for "Stop AI work"), with the record's digest and ids; 365 days | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.workspace_model_defaults` | Content-free: one row per workspace | Deleted with the workspace by P09.T05 |
| `morrow_work.proposal_parameters` (`redacted_at`) | Parameters keep their digest; a store's shop/redact empties the text in place (`parameters_redact_for_store`), after which the proposal can never be decided or claimed. The helper runs only under the tenant's own session context and otherwise refuses (`context_unavailable`); M2 PR-3 lands the shop/redact caller with the policy its context needs, so the handler is executable from M2 PR-3 | `parameters_redact_for_store` |
| `morrow_billing.credit_reservations`, `vendor_cost_reservations`, `run_cost_bookings`, `unrecovered_costs`, `unrecovered_cost_entries` | Financial records: credits and US$ amounts, ids and catalogue keys, no content. Kept for the financial period; their retention basis is settled with M5 PR-1's billing records before live money (M6) | None in the MVP; no delete path exists |

Listings runs (M3 PR-2; ADR-0022 items 2, 10, 11 and 13; migration 0038 listings-runs, after M2 PR-3's 0036-0037). Store content is held only in `product_snapshots` and `run_drafts` (and, once proposed, in `proposal_parameters` above); the Workflow's durable state holds ids and codes only, and Morrow stores no prompt or raw model output.

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `morrow_work.runs`, `run_products`, `run_manifests` | Content-free: ids, the selection and catalogue version, digests (route, prompt, schema), statuses, counters and token totals, and each product's draft and the proposal that packed it (a run settles from these, so shop/redact deleting its drafts never changes what it settles); 365 days | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.run_model_calls` | Content-free audit of each model call's fence: the outcome, the provider request and model ids, the raw stop reason (a bounded token), token counts and the booked cost; 365 days. Never readable by the api role column by column | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.product_snapshots` | Store content: one product's listing fields as read, content-addressed; 90 days (`expires_at`) | shop/redact deletes the store's rows (`delete_rows` through `store_content_redact`, revised in 0038 in the same change that makes the product read available, so no store content reaches the table first). The command role holds DELETE on this table only for shop/redact's connector context (a restrictive policy keeps every session and run lease from deleting; owner decision 13, approved on 2026-10-22). The evidence's `rows` is what that pass deleted, so a re-run after a pending pass reports 0; `remaining` is what still holds content. P09.T05 prunes at `expires_at` |
| `morrow_work.run_drafts` | Store content: the validated change set of one product and its reviewer flags (counts); 90 days (`expires_at`) | shop/redact deletes the store's rows (`delete_rows`, as for snapshots: the connector context only, per-pass counts). A run step that writes a snapshot, a draft or an agent proposal's parameters waits on the store's stop key, so it either commits before the shop/redact pass (which then deletes or empties it) or is refused. P09.T05 prunes at `expires_at` |
| `morrow_work.model_catalogue_rates` | Platform record: per-token rates, the provider model id and the input cap of each catalogue entry; kept for the life of the platform | None needed |

Review and apply (v1 PR 3, the gateway's first slice; ADR-0022 items 3, 7 and 9; migrations 0044 catalog-review and 0045 catalog-apply). The review screen reads the "before" values from `product_snapshots` and the "after" values from `proposal_parameters`; nothing new holds store content. An apply sends only the approved fields of the claimed parameters, and records ids, codes and Shopify's own `updatedAt` text, never a product value.

| Table | Class and retention | Erasure hook |
| --- | --- | --- |
| `morrow_work.operations` (`catalog_write`), `morrow_work.operation_transitions` | Content-free audit of each product's apply: the claim, the approval and its digest, the request digest of the exact approved item, the product id, statuses, reasons and the provider request id; 365 days | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.operation_writes` | Content-free record of the send fence: the credential id and version the send used, the listing field names sent and Shopify's `updatedAt` read just before the send (compared only for equality); 365 days | P09.T05 prunes after 365 days; no delete path exists |
| `morrow_work.operation_readbacks` | Content-free read-backs: per-field verdict codes (`approved`, `source`, `other`), the overall verdict and Shopify's `updatedAt`; no value and no digest of one; 365 days | P09.T05 prunes after 365 days; no delete path exists |

No real user may enroll until the P09.T05 deletion path covers principal, mapping and enrollment (ADR-0003 hard ordering (b)); self-service stays disabled except on development and staging profiles with an allowlisted WorkOS sign-up (ADR-0009 items 10 and 11).

Daily recovery snapshots/exports are separately retained thirty-five days in production/seven in staging; they do not provide thirty-five-day point-in-time recovery. Qualify changed storage, matching artifact revision manifests and erasure/revocation replay.

These durations are product defaults rather than claimed legal obligations. Any legitimately required financial retention requires a documented basis, exact data class, restricted access and expiry. Do not quietly retain all customer payloads under an accounting exception.

Shopify mandatory privacy topics apply to public apps regardless of granted data scope. Verify HMAC, durably acknowledge, authenticate subject/shop scope, process customer access/erasure and shop redaction, and track deadline/retry evidence. The documented completion deadline is thirty days; the uninstall-related shop redaction delivery has its own timing. Operational target: start promptly and finish routine erasure within 24 hours, while recording valid exceptions. [Shopify privacy requirements](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)

Object versions, derived search indexes, embeddings if later added, artifact previews, context snippets and external model/provider retained copies are included in the deletion plan. Erasure ledger must survive a restore of older business data; P04 decides its independent retention/durability and tests replay. A record in the restored database alone cannot prove post-backup deletions are remembered. Revocation/deletion replay precedes reads, dispatch and connector reactivation.

Model provider (ADR-0022 item 10): Anthropic does not train on commercial API inputs or outputs by default and deletes them within 30 days; content flagged by its trust and safety systems may be kept up to 2 years, and the classification scores of flagged content up to 7 years. Structured-output schemas are cached up to 24 hours after their last use and hold no merchant data. Zero data retention needs an agreement Morrow does not have, so disclosures say "up to 30 days; if flagged by Anthropic's safety systems, the content up to 2 years and its classification scores up to 7 years". Only the merchant's request text and product catalogue fields are sent; Morrow stores neither prompts nor raw outputs. Files, Batches, code execution, Managed Agents and other retained provider features cannot silently enter this route. Regional processing (`inference_geo`) and model or endpoint eligibility require separate account evidence. Redact or deny sensitive classes where an allowed provider route is absent. [Anthropic API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)

Migration: none yet. P07/P09/P10 implement classified bytes/projections/deletion; P04/P18 qualify recovery. Every policy change names retained content and dependent runs; increasing retention or changing processors requires the canonical plan to change first.
