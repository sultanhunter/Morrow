# MVP architecture spine (M2–M5)

- Status: draft brief, 2026-10-19, revised after two AI critiques (separate context, same model family). It is routine except where it cites ADR-0022, which holds every material choice (ADR-0021 item 5) and was accepted on 2026-10-19, including its model catalogue values (items 11 and 16), which the owner confirmed the same day.
- Plan: `docs/plan/mvp.md` (ADR-0021). Milestone briefs: [M2](M2-shopify-connect.md), [M3](M3-listings-agent.md), [M4](M4-approve-and-apply.md), [M5](M5-billing.md). Each brief points here instead of repeating it.
- Plan IDs this realises: P08.T01a, P08.T02a, P09.T01a, P09.T02a, P09.T05a (M2); P05.T04b, P11.T04a, P11.T05a, P13.T01a–T03a (M3); P06.T01c, P08.T03a, P11.T01a–T03a, P14.T03a (M4); P18.T01a (M5). Their acceptance rows stay open past launch where the MVP slice is narrower.

## 1 Rules for the spine

- **One path per concern, the long-term one.** One gateway (`approval_claim` plus the OperationLedger) for every Shopify write; one broker for every provider credential; one OperationLedger for every provider write, Shopify and Stripe; one credit ledger; one tenant pattern (ADR-0010); one approval record type (Proposal@2/Approval@2 from P06.T01b).
- **Reuse before adding.** The catalogue already has the capabilities (§7). The contracts already have `Operation`, `Run`, `RunManifest`, `StoreInstallation`, `CreditWallet`, `CreditReservation`, `VendorCostReservation`, `KillSwitchRecord` and the billing v1.1 layer. New definitions are only those in ADR-0022 item 2.
- **Server-derived everything.** No route takes an organization, workspace, store, installation, route, price, credit or actor value as authority. The connector learns the workspace from the app registry, the orchestrator from a lease or operation, the broker from the database.
- **Migrations.** Forward only, numbered after the merge-train head (expected first file 0019, assigned in merge order). They call the ADR-0020 helpers and contain no `pg_auth_members` text. New roles are membership-free executor logins (ADR-0022 item 8). New schemas (`morrow_billing`, `morrow_vault`) are created by `morrow_work_owner` migrations (`executeAs` in `migrations/manifest.json`).

## 2 End-to-end sequence

| # | Step | Worker | Reused | New | Writes |
| --- | --- | --- | --- | --- | --- |
| 1 | Sign up | api | `POST /organizations` (P05.T01x, ADR-0009) | route row in the creating transaction (`originForCreation`) | `workspace_billing_routes` |
| 2 | Checkout | api, broker | `purchaseDecision`, `billingCallToAction` (`packages/policy/src/billing-state.ts`) | `POST /workspace/:ws/billing/morrow/checkout`; broker `stripeCustomerEnsure`, `stripeCheckoutCreate` | `checkout_intents`, `operations` |
| 3 | Payment verified | api (public), broker | `classifyPayment`, `foldEntitlementEvidence`, `parseBillingTerms` | `POST /api/billing/stripe/webhook`; broker `stripeWebhookVerify` | receipts, route fixed `morrow_direct`, grants, wallet, snapshot |
| 4 | Install (custom link) | connector, broker | `linking_candidates` (0005) | `/shopify/a/:appKey/{launch,callback}`; broker `shopifyLaunchVerify`, `shopifyInstallComplete` | OAuth state, `store_installations`, continuation, vault |
| 5 | Link | api | `link_workspace_store` (0005), `createStandaloneStoreLinking` (P05.T03b) | the P09.T02a issuer in the preview route; the store-link grant template | `workspace_store_links`, `shopify_bound_at`, owner store grants |
| 6 | Enable Listings | api | `agents.installation.activate` | `POST /workspace/:ws/stores/:storeId/agents/listings` | installation, its grants, Coordinator principal |
| 7 | Ask and admit | api | work API `POST /goals`, `POST /tasks` (P06.T01a) | `POST /workspace/:ws/work/tasks/:taskId/runs` with the model selection checked against the catalogue (§9); the code Coordinator | `runs`, child task, envelope, hop, Coordinator grant, reservations, lease, outbox |
| 8 | Draft | orchestrator `ListingsRunWorkflow`, broker | `decideDelegation`, `validateCurrentDefinition` | broker `shopifyRead`, `modelRespond`; HTML sanitiser | `product_snapshots`, `run_drafts`, `run_manifests` |
| 9 | Propose | orchestrator | `ProposalProducer`, `checkProposal` (P06.T01b) | the agent submit definer; the `catalog.content.publish` producer | `proposals`, `proposal_parameters`, `approvals` |
| 10 | Approve | api | `decideApproval`, P06.T01b PR-2 routes | `/w/:ws/review/:proposalId` | `approval_decisions` |
| 11 | Claim | api | `prepareApprovalClaim`, `approval_claim` | `POST /workspace/:ws/work/proposals/:proposalId/apply` | `approval_claims`, `operations` (`authorized`), lease |
| 12 | Write | orchestrator `OperationWorkflow`, broker | operation machine (`state-transitions.json`) | broker `shopifyProductUpdate` (fenced) | dispatching → submitted, failed or uncertain |
| 13 | Read back | orchestrator, broker | – | broker `shopifyRead(productContent)` keyed by operation | verified, failed or uncertain |
| 14 | Audit | all | `outbox_events` (0015), `KillSwitchRecord` | `operation_transitions`, `StopRecord@1` | append-only, content-free |
| 15 | Settle | orchestrator | `CreditReservation`, `VendorCostReservation` | settle and release statements | `credit_wallets`, `run_manifests` |

Staging pays through Stripe test mode, so steps 2–3 run there too; the MVP has no test entitlement seed (ADR-0022 item 5). While the Stripe switch is off, staging uses the operator test entitlement instead (item 5 amendment, 2026-10-21; [staging-test-entitlement.md](staging-test-entitlement.md)).

## 3 Workers

| Worker | Public | Owns | Database login | Broker entrypoint |
| --- | --- | --- | --- | --- |
| `morrow-<env>-api` | yes, workers.dev (ADR-0019) | sessions, work API, store links, Listings enablement, run admission, approvals, claims, billing routes, the Stripe webhook route | `morrow_api_worker` plus the P05 pools | `ApiBroker` |
| `morrow-<env>-connector` | yes, own hostname (ADR-0022 item 6) | Shopify launch, callback, webhooks, continuation, status; the webhook inbox's apply and its cron re-drive (as built in M2 PR-3, see the note in §4) | `morrow_connector_ingress` (new) | `ConnectorBroker` (new) |
| `morrow-<env>-orchestrator` | no | `ListingsRunWorkflow`, `OperationWorkflow`, the dispatch Queue consumer (ids only), a cron that starts pending Workflows | `morrow_runtime_executor` (new) | `RuntimeBroker` (new) |
| `morrow-<env>-broker` | no | every provider credential and call; the vault | `morrow_vault_broker` (new, never leased) | – |

- `apps/workers/src/orchestrator.ts` replaces `MorrowWorkWorkflow` with the two Workflow classes, each enabled separately. `ListingsRunWorkflow` stays `dispatch_disabled` until M3 PR-1's stop, reservation and `resolve_call` tests pass. `OperationWorkflow` stays disabled until M4 PR-1's gateway tests pass (invariant 15; ADR-0022 item 10).
- Workflow steps and Queue messages carry ids and digests only. Content is written to tenant tables inside a step, or used in memory within one step (§11).
- `apps/shopify-connector/worker/placeholder.ts` is replaced by `worker/index.ts` on `@shopify/shopify-api` (ADR-0008).
- `apps/api/src/environment.ts` `mapApiEnvironment` keeps rejecting provider bindings; `ANTHROPIC_` is in its `providerPrefix` list, and `STRIPE_` joins it in M5.

## 4 Broker trust model v1 and methods (ADR-0022 item 7)

The v0 rules stay for `health`, `neonLease`, `workosSessionPage` and `challengeVerify`. New methods follow v1:

- Each caller binds its own `WorkerEntrypoint` class, exposing only its methods; `neonLease` serves only that caller's roles (`neonLeaseNamespace`, `brokerNeonRoles`). Failures return a fixed code (`invokeBrokerMethod`, `BrokerHold`), never provider text.
- Writes and destroys take ids only. The broker loads the installation, operation, parameters, price and customer mapping from the database.
- Every Shopify read and model call is resolved by `morrow_vault.resolve_call(lease_id, generation, purpose, subject_id)`: installation, credential, store and stop state, or nothing. Purpose `reconcile` takes an operation id instead of a lease (§8).
- Admin GraphQL documents are fixed in broker source. Reads honour `THROTTLED` by waiting for the restore time within the budget.

| Entrypoint | Method | Returns | Milestone |
| --- | --- | --- | --- |
| Connector | `shopifyLaunchVerify(appKey, rawQuery)` | `{verdict, shop, installation (none, unlinked, linked, suspended or uninstalled), workspaceId}` (as built in M2 PR-2) | M2 |
| Connector | `shopifyInstallComplete(appKey, rawCallbackQuery, stateDigest, budgetMs)` | `{outcome, workspaceId, continuationToken}`; never the token (as built in M2 PR-2, see the note below) | M2 |
| Connector | `shopifyWebhookVerify(appKey, headersJson, rawBodyBase64)` | `{verdict: recorded, duplicate, refused or invalid, inboxId, settled}`: the broker records the minimised delivery itself (as built in M2 PR-3) | M2 |
| Connector (Api with the disconnect command) | `shopifyCredentialDestroy(installationId, reason)`: only with the end reason the row records (`uninstalled`, `scopes_changed`; `disconnected` with the disconnect command) | `destroyed`, `already_destroyed`, `ineligible` or `not_found` (as built in M2 PR-3) | M2 |
| Api, Runtime | `shopifyRead(leaseId, generation, subjectId, queryName, variablesJson, budgetMs)` | minimised JSON for `shopIdentity`, `collectionsPage`, `productsPage` (Api) and `productContent` (Runtime) (as built in M2 PR-3) | M2 |
| Runtime | `modelRespond(leaseId, generation, callJson, budgetMs)`: the broker reads the selection and catalogue version from the lease's run, never from `callJson`; the entry picks the `ModelProvider` adapter (§9) | `ModelResult@1` (provider-neutral, with an opaque `traceRef`) | M3 |
| Runtime | `shopifyProductUpdate(operationId, generation, budgetMs)` | `{outcome: submitted, rejected, not_sent or uncertain, codes}` | M4 |
| Runtime | `shopifyReconcileRead(operationId, budgetMs)` | readback verdict and field digests | M4 |
| Api | `stripeCustomerEnsure(operationId)`, `stripeCheckoutCreate(operationId)`, `stripePortalCreate(operationId)` | ids and the Stripe-hosted URL | M5 |
| Api | `stripeWebhookVerify(rawBody, signatureHeader, budgetMs)` | a receipt id for a verified, de-duplicated, read-back object | M5 |

Note (M2 PR-2, a deviation from the first table row for `shopifyInstallComplete`): the broker records the install itself, so the connector never writes an installation from ids it was handed. In one transaction on its own `morrow_vault_broker` login it seals the token, stores the credential version and, through identity bridges (`work_shopify_install_prepare`, `work_shopify_install_record`), writes the installation, the `shopify_oauth` candidate and the install continuation. The vault row and the install record therefore commit together (no orphaned live token), and the method returns only `{outcome, workspaceId, continuationToken}`. This widens the vault login's definers beyond pure vault functions; `resolve_call` (M3 PR-1) and the send fence (M4) widen them anyway.

Note (M2 PR-3, deviations from the rows above and from §3's connector row):
- `shopifyWebhookVerify` records the delivery. In the transaction that read the app secret and verified the raw-body HMAC, the broker minimises the body and calls `morrow_vault.shopify_webhook_record`, which writes the inbox row (and a compliance topic's `privacy_requests` row) under the tenant the app registry names for the verified shop. The connector answers 200 only after that row exists, so it never handles body content; a lost COMMIT is `OUTCOME_UNKNOWN` and the connector answers 503 (Shopify's retry finds the row by its webhook id).
- The inbox row is the queue: the connector applies a recorded row after the response (`waitUntil`, `morrow_work.connector_inbox_apply` on its own login) and a five-minute cron re-applies rows still `received` after two minutes and re-destroys tokens whose destruction is not yet recorded. No Queue resource exists (review finding B8): five low-volume topics need no fan-out, and creating one is a provider resource. Accepted for the beta by the owner on 2026-10-22 (the M2 brief's PR-3 decision 9).
- `shopifyRead` takes the lease's `subjectId` (the read's request id or the run id), which `resolve_call` checks, so a lease cannot be used under another subject. `productContent` is the Runtime's only and reads only a product of the lease's run; until M3 PR-2's runs exist, `morrow_work.run_product_readable` refuses every product (fail closed). The read resolution runs alone in its own vault transaction, never held across the Shopify call, and at most two run at once per broker isolate (a third is held, `READ_BUSY`), so signed-in catalogue reads cannot take the vault connections that ingress, install stores and Stripe receipts need (M2 PR-3 review). A `THROTTLED` read waits once until the bucket holds the query's requested cost again.
- `shopifyCredentialDestroy` is on `ConnectorBroker` only; the `ApiBroker` half arrives with the disconnect command, which the owner approved on 2026-10-22 and which is still to be built (the M2 brief's PR-3 decision 8).

Broker secrets (owner-placed with `morrow_put` and `staging:put-secret`): `MORROW_VAULT_KEK_V1`, `ANTHROPIC_API_KEY` (scoped to the environment's Anthropic Console workspace), `STRIPE_RESTRICTED_KEY`, `STRIPE_WEBHOOK_SECRET`, the `morrow_vault_broker` password. Shopify app client secrets are vault rows (`morrow_vault.app_secrets`), written by an owner-run script. Leased role passwords: `morrow_connector_ingress`, `morrow_runtime_executor`.

## 5 Tenancy for background work (ADR-0022 item 9)

- `morrow_work.work_leases`: tenant keys, `store_id`, `kind` (`read`, `run`, `operation`), `subject_id`, `generation`, `initiator_principal_id`, `initiator_membership_id`, `status`, `expires_at` (read 60 s, run 30 min, operation 15 min). Expiry is checked at every use, so no sweep is needed.
- Only api commands create leases, inside the session transaction that authorised the work.
- `current_tenant()` and every session definer stay unchanged and session-only. `morrow_work.enter_lease(lease_id, generation)` runs only when `session_user` is `morrow_runtime_executor`. It sets a lease context that only `morrow_work.current_lease()` reads, rechecking that the lease is active, unexpired and current and that the workspace and initiating membership are active. The context resolves only with the entry proof `enter_lease` writes (`morrow_work.lease_entries`: backend, transaction, lease, generation and a random nonce), so not even the runtime login can forge it past `enter_lease`'s stop check. New runtime definers and new tables' policies use `current_lease()`. The conformance harness adds two probes: a forged lease setting yields zero rows, and a lease context calling a session definer is refused.
- Grant decisions stay in `packages/policy`. Agent steps rerun `decideDelegation`. At dispatch, the claimant is evaluated with a lease-backed human authority: "operation lease current and membership active" replaces `sessionCurrent`, which is never faked (`agent-authority.md`).
- Revocation: a stop, a disconnect, a membership removal or an uninstall sets matching leases `revoked` in the same transaction. Membership removal does it through the identity triggers on `workspace_memberships` and `memberships` (migration 0024) and `morrow_work.revoke_member_leases` (0023); a revoked lease stays revoked when the membership returns.
- Cross-tenant reads: one definer, `morrow_work.pending_starts()`, executable only by `morrow_runtime_executor`. It returns the ids of committed runs and claims whose Workflow has not started, and nothing else, and is registered as content-free in the conformance registry.

## 6 New tables

All follow ADR-0010 item 2 (tenant keys first, composite foreign keys, ENABLE and FORCE RLS, definers, registration in `tests/tenant-conformance/registry.mjs`). P marks a platform table.

| Table | Milestone | Purpose | Retention (ADR-0022 item 13) |
| --- | --- | --- | --- |
| `morrow_work.work_leases`, `stop_controls`, `stop_records` | M2 PR-1 | §5, §10; platform stop rows have null tenant keys, are visible to every tenant and are written only by the owner script | 365 d content-free |
| `morrow_work.operations`, `operation_transitions` | M2 PR-1 | `Operation@2`, kinds `catalog_write` and `stripe_write`; claim columns nullable (§8) | 365 d |
| `morrow_billing.workspace_billing_routes` | M2 PR-1 | ADR-0015 persistence item 1 | workspace lifetime |
| `morrow_vault.credentials`, `morrow_vault.app_secrets` (P) | M2 PR-1 | encrypted tokens and app client secrets; broker-only definers | destroyed at uninstall or disconnect; app secrets until rotated |
| `morrow_identity.shopify_apps` (P) | M2 | app key, client id, intended shop domain (as a digest, M2 PR-2), invited workspace, install link, status | platform; the install link names the shop, so retirement and `shop/redact` clear it (M2 PR-2 review); `shop/redact` clears only the redacted installation's own app, never a later app for the same shop (M2 PR-3 review) |
| `morrow_identity.shopify_oauth_states` | M2 | single-use state digest, 10 min | 7 d |
| `morrow_identity.store_installations` | M2 | `StoreInstallation@1`: shop, app, generation, expanded scopes, credential ref and version, status | installation lifetime |
| `morrow_identity.install_continuations` | M2 | ADR-0015 persistence item 2; 5-min single-use token digest | 365 d |
| `morrow_identity.shopify_webhook_inbox` | M2 | unique `(app, shop, webhook id)`; minimised body (§11) | 7 d |
| `morrow_identity.privacy_requests` | M2 | topic, due time, completion evidence | 365 d content-free |
| `morrow_work.agent_releases` (P), `agent_installations`, `work_envelopes`, `delegation_hops` | M3 | P05.T04b minimum behind `agent-authority.ts` | installation lifetime |
| `morrow_work.runs`, `run_manifests` | M3 | `Run@1`, `RunManifest@1`; digests, usage and the selection (catalogue version, model, effort, credits per product) | 365 d content-free |
| `morrow_work.workspace_model_defaults` | M3 | the workspace's default selection, its catalogue version and the member ceiling (credits per product) | workspace lifetime |
| `morrow_work.product_snapshots`, `run_drafts` | M3 | product fields read, and validated drafts awaiting packing | 90 d; deleted at `shop/redact` |
| `morrow_billing.credit_wallets`, `credit_reservations`, `vendor_cost_reservations` | M3 | P11.T04a minimum | financial period |
| `morrow_billing.billing_accounts`, `stripe_customers`, `checkout_intents`, `stripe_event_receipts`, `verified_payment_events`, `entitlement_snapshots`, `credit_grants` | M5 | ADR-0015 persistence items 3–7 | financial period |

Forward changes to existing tables: `linking_candidates.proof_kind` and `linking_reviews.evidence_kind` admit `shopify_oauth` (M2); `link_workspace_store` also applies the store-link grant template (M2); `morrow_identity.grants` admits agent principals and `proposals` an agent proposer (M3, ADR-0022 item 3); `proposal_parameters` gains redaction (M3, §11).

## 7 Capability and proposal shape (ADR-0022 items 1–3)

- Read `catalog.products.read`, draft `catalog.content.propose`, write `catalog.content.publish`. FieldPaths `title`, `descriptionHtml`, `seo.title`, `seo.description`, `tags`. The kernel resource is the store, `{kind: "store", id: S, storeId: S, connectionId: C}`. Every product target must carry the same store and connection.
- Proposal@2 for one listing batch:

```text
{schemaVersion: 2, capabilityId: "catalog.content.publish", storeId: S, taskId: T,
 scope: {organizationId: O, workspaceId: W, storeIds: [S], accountIds: [], resources: [product refs], fields: [sorted union]},
 targets: [{resource: {organizationId: O, workspaceId: W, storeId: S, connectionId: C, kind: "product", id: "product:<n>"},
            expectedSourceRevision: <snapshot digest>, fields: [...], maximumCredits: "0", maximumCost: null}],
 parametersRef: {..., kind: "artifact"}, parametersDigest, maximumCredits: "0", maximumCost: null,
 risk: "external", irreversible: false, partialApproval: "allowed", contextTaint: "untrusted_external", derivedFrom: null,
 proposedBy: {kind: "agent", principalId: <Listings agent>, installationId: <installation>, membershipId: null, mandateId: null, ...},
 requestedBy: <task initiator>, beneficiaryPrincipalIds: [], reviewPolicyRef, expiresAt, ...}
```

- Parameters are `CatalogContentChangeSet@1`: `{schemaVersion: 1, storeId, items: [{targetIndex, productId, set: {title?, descriptionHtml?, seo?: {title, description}, tags?}}]}`. Each item's `set` keys equal its target's `fields`; both SEO fields are sent when either changes. There is no free-text note.
- Size: an item's canonical JSON is at most 16 KiB (`descriptionHtml` at most 10,000 bytes; at most 50 tags of 64 characters), so any two items fit the 32 KiB parameter cap. The producer packs a run's drafts into proposals by bytes; a 25-product run usually yields several proposals on one task.
- `expectedSourceRevision` is the digest of the canonical snapshot (§8) of the five fields as read. Shopify has no conditional product write, so the claim step rereads and compares just before dispatch; the remaining window is documented.

## 8 OperationLedger (P06.T01c minimum)

- One `operations` row per approved target (kind `catalog_write`) with `target_index`, `claim_family_root_id`, `lease_id`, and `send_started_at`. The claim transaction records `planned → awaiting_approval → authorized` (guard `exact_current_approval`). `maximumCredits` is `"0"`, so `authorized → dispatching` uses `non_billable_current_grants_and_lease`. Every transition is a row in `operation_transitions`, using `state-transitions.json` unchanged.
- **Send fence.** Under the operation's row lock, the broker sets `send_started_at` and increments `attempt` before it calls Shopify, and refuses any call for an operation whose send already started (`unknown_submission`). The Workflow's write step has retries disabled (`NonRetryableError`). Any exception after the fence is `uncertain`.
- **Outcomes.** A response with no `userErrors` → `submitted`. `userErrors` → `dispatching → failed` (`verified_no_effect`). `THROTTLED`, 429, 401 or `ACCESS_DENIED` prove nothing ran: inside the same broker call a throttle is resent once after the restore time, otherwise `failed` with the reason (and 401 marks the connection "reinstall needed"). Timeout or transport loss after send → `uncertain` (`transport_after_dispatch`). Targets dispatch one at a time.
- **Readback.** `submitted → verifying`; every approved field equal under the canonical comparison → `verified`; otherwise `verifying → uncertain` (`partial_result`), and if every field equals the snapshot, then `uncertain → failed` (`verified_no_effect`). Canonical comparison: tags as a case-folded, sorted, de-duplicated set; strings trimmed; HTML after the same sanitiser and serialiser. Recorded development-store fixtures pin it, including a write Shopify normalises.
- **Reconciliation** is keyed by the operation, not a lease. It is allowed while the operation is `submitted`, `uncertain` or `verifying`, reads only that product's fields, and is never blocked by a stop. The Workflow retries it with sleeps. With no credential left (uninstall or disconnect), the operation stays `uncertain` with `verification_unavailable` and is shown to the owner. It is never promoted.
- No automatic resubmission. An `uncertain` operation opens an exception at `/w/:ws/inbox/exceptions/:operationId`. The Workflow logs `morrow_operation_aged` (P04.T03a alert sink) once its reconciliation attempts are exhausted.
- Store-uninstalled `authorized` operations move `authorized → conflict` (`precondition_changed_before_dispatch`) at their dispatch check.

## 9 Model gateway, selection and credits (ADR-0022 items 10, 11 and 16; ADR-0036; ADR-0039)

The owner confirmed the catalogue's contents, default, multipliers, token caps, margin, failed-product bounds and member ceiling on 2026-10-19 (ADR-0022, "Owner confirmation of the catalogue values (2026-10-19)"). Catalogue version 1 was published that day; on 2026-10-25 the owner made Opus 5.5 at medium the default and removed the unrecovered-cost cap (ADR-0036, OD-2026-10-25-1), which published version 3, and the same day made credits the only spend limit (ADR-0039, OD-2026-10-25-4), which published version 4: version 3 without the US$7 run and US$25 daily caps. Version 4 is `active` (effective 2026-10-25, its digest pinned in `model-policy.json`); versions 1 and 3 are retired.

- **Port.** Callers see only `ModelCall@1` and `ModelResult@1`. `ModelCall@1` is closed and carries no selection or catalogue version: `modelRespond` reads both from the run bound to the lease, so a call that names a selection is refused. The run's catalogue entry names a `ModelProvider` adapter: `respond(resolvedCall, credential, budgetMs) → AdapterResult` and `countInput(resolvedCall)`. `AdapterResult` is broker-internal (outcome, raw stop reason, output, usage, provider request ID, provider model ID). The broker checks it, books its cost at the run's catalogue version's rates, records the provider IDs and usage in the run manifest, and returns `ModelResult@1` (outcome, validated output, token usage and an opaque `traceRef`), which names no provider or provider model. The Claude adapter is the only one. Another provider is one adapter, one broker credential and one catalogue entry, chosen by ADR; callers and contracts do not change. No fallback to another model or provider.
- **Catalogue v4** (`docs/decisions/model-policy.json` `catalogue.versions`, generated into the broker and the api's checks, never into contract enums; active since 2026-10-25, version 1's entries with no run or daily cap): `claude_haiku_5_5`, `claude_sonnet_5_5`, `claude_opus_5_5` × efforts `low`, `medium`, `high`, mapped to `thinking: {type: "adaptive"}`, `output_config.effort` and `max_tokens` 5,000, 12,000 or 16,000. Default: Opus 5.5, medium (version 1's was Sonnet 5.5, low). A published version never changes; its digest is pinned and checked by `npm run verify`. `GET /workspace/:ws/models` lists the active entries with their credits per product and run product limit; `PUT /workspace/:ws/settings/model-default` takes `{model, effort}` and the member ceiling (`governance.model_default.revise`).
- **Selection.** `ModelSelection@1` keys are opaque strings matching `^[a-z][a-z0-9_]{0,39}$`, not enums. Run admission accepts `{model, effort}` only as keys of the active catalogue version, else the workspace default, and only within the requester's member ceiling (by default the default's credits: 4 since version 3 and in version 4, owner-confirmed (OD-2026-10-25-2), and 1 in version 1; holders of `governance.model_default.revise` may pick any entry). It records the catalogue version, model, effort and multiplier on the run. A provider model string, an unknown key, a retired entry or an entry above the ceiling is refused with no run.
- **Credits.** Each selection costs 1–6 credits per product (Haiku 1/1/1, Sonnet 1/2/3, Opus 2/4/6 at low/medium/high); the default, Opus 5.5 at medium, costs 4, and every entry drafts at most 25 products a run (ADR-0039 item 4; 12 at the default before version 4). Applying costs no credits but is paid work (`isPaidWork` for `execute` on an `external_write` capability).
- **Run admission** (api, one transaction): human kernel on the store resource; entitlement directly through `workspaceBillingState` and `entitlementFor`, because `createBillingConstraintsReader` skips non-paid requests; `selectPayers` gives the single `morrow_direct` payer; `CreditReservation` for products × multiplier and `VendorCostReservation` for products × the selection's worst case; `available → reserved` in `credit_wallets` under a row lock. The product count is at most 25 (since version 4 no US$7 run cap lowers it). Credits are the only spend limit (ADR-0039): there is no daily cap (migration 0053 removed `daily_cap`) and no unrecovered-cost cap (ADR-0036; migration 0051 removed `unrecovered_cost_cap`).
- The agent fact reader sets `entitlementAllowed` from the same `entitlementFor` result and joins the `inspectEntitlementWriters` allowlist.
- **Per call:** the broker counts the input (at most 8,000 tokens), refuses a call whose worst case exceeds the run's remaining vendor reservation, sends, and books usage at the run's catalogue rates in the run manifest. Outcomes follow ADR-0022 item 10's table: `end_turn`, `max_tokens` and `refusal` map to `completed`, `incomplete` and `refusal`, and any other stop reason to `provider_error`; a spend-limit 400 and a 429 without `retry-after` (or naming a spend cap) are `spend_limit`; other 4xx are `provider_error`; both end the run without retry; a 429 with `retry-after` or a 529 waits and resends without using an attempt; 500, 504, a timeout or a transport loss after send are `uncertain`, counted as an attempt and booked at its worst case.
- **Failed products:** a run stops after three consecutive failed products. Their AI cost (`uncertain` bookings included) is recorded per billing period and capped by nothing else since ADR-0036: the 25-product run limit, the breaker and the Anthropic Console monthly limit bound it (ADR-0039 removed the per-run and per-day caps).
- **Run end:** credits settle at products drafted × multiplier (never above the reservation); failed products are not charged and their cost is added to the workspace's unrecovered cost; the rest is released; vendor cost settles from usage. `UsageLiability` is not used in the MVP.

## 10 Stops (P11.T05a; ADR-0022 item 15)

- `stop_controls`: scope `platform`, `installation` or `connection`, with reason and actor. Human kill switches write a `KillSwitchRecord` through the existing v1.1 bodies (`KillSwitchControl`, `checkKillSwitchTarget` in `packages/policy/src/kill-switch.ts`): `agents.installation.disable` ("Stop AI work") and `governance.connection.disconnect`. The uninstall webhook and the owner's platform script write `StopRecord@1` (actor `system` or `operator`). Agents may only propose stops.
- Checked at run admission, at every Workflow step, inside `resolve_call` before any model call or dispatch, at claim and at `authorized → dispatching`. Stops never reserve credits or read entitlement (ADR-0011 Q8), and never block readback.
- A stop revokes matching leases. Only a person lifts a stop.
- Delivered before any model call: the tables in M2 PR-1, the disconnect command (planned for M2 PR-3, see the note below), and "Stop AI work", the platform script and the `resolve_call` checks in M3 PR-1. M2 PR-1 also carries, ahead of this plan and without a caller, the platform-stop operator functions the script will run and the pure "Stop AI work" plan and record helpers; "Stop AI work" counts as delivered only when its command and definer exist.

Note (M2 PR-3, deviations from the bullets above and from ADR-0022 items 13 and 15):
- The disconnect command is not in M2 PR-3. The owner approved it on 2026-10-22 (the M2 brief's PR-3 decision 8: the disconnect grant in store-link template v2, an ADR-0022 item 3 amendment, and a `KillSwitchRecord` that can name a connection, an ADR-0022 item 2 amendment); it is still to be built. Until it lands, this section's "before any model call" precondition is not met, and the owner's decision 14 (2026-10-22) keeps it: the disconnect command lands before M3 PR-2's first model call, and M3 PR-2's model switch, committed off, stays off until then.
- A second system stop: when `app/scopes_update` reports expanded scopes that are not exactly `read_products,write_products`, the connector's applier suspends the installation (`scopes_changed`), sets a system connection stop (`StopRecord@1`, reason `shopify_scopes_changed`) and the broker destroys the token (reason `scopes_changed`). ADR-0022 item 15 names only the uninstall stop, and item 13 and §11 destroy tokens only at uninstall or disconnect. The effect is irreversible in this release: no reinstall path exists for that app and shop (0026's `UNIQUE (app_key, shop_id)`), so reconnecting needs a new Shopify app. Owner question 3 in the M2 brief was answered on 2026-10-23 (OD-2026-10-23-7, decision 36) with a different rule, ADR-0025 item 10: a scope change stops only the agents that lost a scope they need and raises a "Reconnect" Inbox item, and the installation, its connection and its token stay. T8 builds it; until then this stop stays, on development stores and staging only.

## 11 Data classes and deletion (P09.T05a; ADR-0022 items 10, 13, 14)

| Class | Where | Deleted by |
| --- | --- | --- |
| Shop identity and scopes | `store_installations`, `linking_candidates` | `shop/redact`: pseudonymise domain; keep ids |
| Offline token | `morrow_vault.credentials` | `app/uninstalled` and disconnect: destroyed at once (M2 PR-3 deviation, §10's note: also `app/scopes_update` with changed scopes) |
| Product content read or drafted | `product_snapshots`, `run_drafts` | `shop/redact`: deleted; else 90 days |
| Product content proposed | `proposal_parameters` | `shop/redact`: emptied, digest kept (below) |
| Webhook bodies | `shopify_webhook_inbox` | 7 days, but never a row whose privacy request is still open (the applier needs it; M6's purge skips it); `customers/*` keep only topic, shop id, webhook id, request id and a keyed digest of the customer id: no email, phone or order ids |
| Workflow state, Queue messages | Cloudflare | ids and digests only, so nothing to delete |
| Model prompts and raw outputs | not stored; digests in `run_manifests` | Anthropic side: not used for training; deleted within 30 days; if flagged, the content up to 2 years and its classification scores up to 7 years (ADR-0022 item 10) |
| Customer data | none (`read_products`, `write_products` only) | `customers/*` answered "none held", with evidence |
| Billing records | `morrow_billing.*`, Stripe ids and amounts | financial period |

- Parameter redaction is one forward migration on the P06.T01b table: the digest check becomes `(redacted_at IS NULL AND digest = sha256(canonical)) OR (redacted_at IS NOT NULL AND canonical = '{}')`; the append-only trigger allows only `redacted_at` null → set, through one definer executable by `morrow_connector_ingress`; `approval_claim` and the broker refuse redacted parameters.
- Privacy deadlines (ADR-0022 item 14; M2 PR-3 review): the connector's five-minute cron counts open privacy requests past their target (`shop/redact` 24 hours; `customers/*` at once, with ten minutes' grace) and past their 30-day due time (`morrow_work.connector_privacy_overdue`, counts only) and logs `PRIVACY_TARGET_MISSED` and `PRIVACY_DUE_MISSED` lines an alert can match (M6's error alerts).
- Every store-content table registers a handler in one list in code (the P09.T05 cleanup contract); the conformance suite fails a store-scoped content table without one, and a test asserts Workflow step outputs carry no content fields. No real merchant store connects before M2's compliance path passes (invariant 16; mvp.md M6).

## 12 Minimal now, final interface

| Area | MVP | Interface kept for later |
| --- | --- | --- |
| Model | one provider (Claude), a nine-entry catalogue, one product per call; no fallback, streaming or tools | the `ModelProvider` port, `ModelCall@1`/`ModelResult@1` through `modelRespond`, versioned catalogue |
| Coordinator | deterministic code that writes `CoordinatorRoute@1` | built-in dispatcher, envelope and hop records; a model router drops in later |
| Specialist | one first-party release | `agent_releases`, `agent_installations` |
| Shopify tokens | non-expiring, custom distribution | vault credential versions; expiring tokens add a credential kind |
| Ledger | one operation per target; readback reconciliation; no cancel flows | full status set and transition table |
| Credits | one payer, one plan, no top-ups | reservations, `selectPayers` |
| Billing | Stripe route, one price; refunds and disputes at M6 | both ADR-0015 routes in `billing-state.ts` |
| Stops | platform, installation, connection | `stop_controls` scopes |
| Orchestration | two Workflows, no durable human waits | Workflow ids equal run and claim ids (P06.T03a) |

## 13 Delivery order

1. M1 live (staging).
2. M2 PR-1, the spine foundation: leases, stop tables, operations, the route row, the vault, the three executor logins, broker entrypoints and v1 plumbing.
3. In parallel from M2 PR-1: M2 PR-2 and PR-3, M3 PR-1 and PR-2, M5 PR-1 and PR-2. Staging smokes that link a store or run AI wait for M5 PR-1, because staging pays in Stripe test mode.
4. M4 after M2 and M3.
5. Each provider effect (development store, Anthropic staging workspace, Stripe test mode, the connector hostname) needs per-action owner approval or a new staging card: `staging-card-1` covers only the four Workers with the api on workers.dev.
