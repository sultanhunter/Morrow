# MVP architecture spine (M2–M5)

- Status: draft brief, 2026-10-19. It is routine except where it cites ADR-0022, which holds every material choice (ADR-0021 item 5) and is Proposed.
- Plan: `docs/plan/mvp.md` (ADR-0021). Milestone briefs: [M2](M2-shopify-connect.md), [M3](M3-listings-agent.md), [M4](M4-approve-and-apply.md), [M5](M5-billing.md). Each brief points here instead of repeating it.
- Plan IDs this realises: P08.T01a, P08.T02a, P09.T01a, P09.T02a, P09.T05a (M2); P05.T04b, P11.T04a, P13.T01a–T03a (M3); P06.T01c, P08.T03a, P11.T01a–T03a, P11.T05a, P14.T03a (M4); P18.T01a (M5). Their acceptance rows stay open past launch where the MVP slice is narrower.

## 1 Rules for the spine

- **One path per concern, the long-term one.** One gateway (`approval_claim` plus the OperationLedger) for every Shopify write; one broker for every provider credential; one credit ledger (billing v1/v1.1 contracts); one tenant pattern (ADR-0010) for every new table; one approval record type (Proposal@2/Approval@2 from P06.T01b).
- **Reuse before adding.** The catalogue already has the capabilities (§7), the contracts already have `Operation`, `Run`, `RunManifest`, `Reservation`, `StoreInstallation`, `CreditWallet`, `CreditReservation`, `VendorCostReservation`, `UsageLiability` and the billing v1.1 layer. The only new contract definitions and capability are those in ADR-0022 item 2.
- **Server-derived everything.** No route takes an organization, workspace, store, installation, route, price, credit or actor value as authority. The connector learns the workspace from the app registry, the orchestrator from a lease, the broker from the database.
- **Migrations.** Forward only, numbered after the merge-train head (0018 once P06.T01b PR-1 merges, so the first MVP file is expected to be 0019; numbers are assigned in merge order). New migrations call the ADR-0020 helpers and contain no `pg_auth_members` text (ADR-0020 item 6). New roles are membership-free executor logins (ADR-0022 item 8), so the ADR-0020 closed set (B) is unchanged. New schemas (`morrow_billing`, `morrow_vault`) are created by `morrow_work_owner` migrations (`executeAs` in `migrations/manifest.json`), so ADR-0020 (C) is unchanged.

## 2 End-to-end sequence

| # | Step | Worker | Reused | New | Writes |
| --- | --- | --- | --- | --- | --- |
| 1 | Sign up on the website | api | `POST /organizations` (P05.T01x, ADR-0009) | route row in the creating transaction (`originForCreation`) | `morrow_billing.workspace_billing_routes` |
| 2 | Checkout | api, broker | `purchaseDecision`, `billingCallToAction` (`packages/policy/src/billing-state.ts`, P01.T04a PR-B) | `POST /workspace/:ws/billing/morrow/checkout`; broker `stripeCustomerEnsure`, `stripeCheckoutCreate` | `checkout_intents`, `operations` |
| 3 | Payment verified | api (public), broker | `classifyPayment`, `foldEntitlementEvidence`, `parseBillingTerms` | `POST /api/billing/stripe/webhook`; broker `stripeWebhookVerify` | `verified_payment_events`, route fixed `morrow_direct`, `credit_grants`, `credit_wallets`, `entitlement_snapshots` |
| 4 | Install (custom-distribution link) | connector, broker | `linking_candidates` (0005) | `/shopify/a/:appKey/{launch,callback}`; broker `shopifyLaunchVerify`, `shopifyInstallComplete` | `shopify_oauth_states`, `store_installations`, `install_continuations`, `morrow_vault.credentials` |
| 5 | Link store to workspace | api | `link_workspace_store` (0005), `createStandaloneStoreLinking` (P05.T03b routes) | the P09.T02a issuer inside `POST /workspace/:ws/store-links/preview` | `workspace_store_links`, `shopify_bound_at` |
| 6 | Ask | api | work API `POST /goals`, `POST /tasks` (P06.T01a) | `POST /workspace/:ws/work/tasks/:taskId/runs` | `runs`, `work_envelopes`, `delegation_hops`, `credit_reservations`, `vendor_cost_reservations`, `work_leases`, outbox |
| 7 | Coordinator routes | orchestrator `ListingsRunWorkflow` | `createAgentAuthorityService().decideDelegation` (builtin_coordinator dispatcher) | broker `modelRespond` with `CoordinatorRoute@1` | `run_manifests` |
| 8 | Specialist drafts | orchestrator | generated validators (`validateCurrentDefinition`) | broker `shopifyRead`, `modelRespond` with `ListingDraft@1`; HTML sanitiser | `product_snapshots` |
| 9 | Proposal | orchestrator | `submitProposal`, `ProposalProducer` (P06.T01b) | the `catalog.content.publish` producer in `productionProducers` | `proposals`, `proposal_parameters`, `approvals` |
| 10 | Approval | api | `decideApproval`, P06.T01b PR-2 routes, `checkProposal` | review screen `/w/:ws/review/:proposalId` | `approval_decisions` |
| 11 | Gateway admission | api | `prepareApprovalClaim` + `approval_claim`, `isPaidWork`, `createBillingConstraintsReader` | `POST /workspace/:ws/work/proposals/:proposalId/apply` | `approval_claims`, `operations` (authorized), `work_leases` |
| 12 | Shopify write | orchestrator `OperationWorkflow`, broker | operation machine (`state-transitions.json`) | broker `shopifyProductUpdate` | `operations` → dispatching → submitted or uncertain |
| 13 | Read-back | orchestrator, broker | – | broker `shopifyRead(productContent)` | verifying → verified, or uncertain |
| 14 | Audit | all | `outbox_events` (0015), `KillSwitchRecord` | `operation_transitions` | append-only, content-free |
| 15 | Credits settle | orchestrator | `CreditReservation`, `UsageLiability` | settle/release statements | `credit_wallets`, `usage_liabilities` |

Before M5 is live, steps 2–3 are replaced on development and staging by the owner-run `TestEntitlementSeed` (ADR-0015 OQ-2; `evaluateTestEntitlementSeed`).

## 3 Workers

| Worker | Public | Owns | Database login | Broker entrypoint |
| --- | --- | --- | --- | --- |
| `morrow-<env>-api` | yes, workers.dev (ADR-0019) | sessions, work API, store-link routes, run start, approvals, gateway admission, billing routes, the Stripe webhook route | `morrow_api_worker` (existing) plus the P05 pools | `ApiBroker` |
| `morrow-<env>-connector` | yes, its own hostname (ADR-0022 item 6) | Shopify launch, OAuth callback, webhooks, install continuation, connection status page; the webhook Queue consumer | `morrow_connector_ingress` (new) | `ConnectorBroker` (new) |
| `morrow-<env>-orchestrator` | no | `ListingsRunWorkflow`, `OperationWorkflow`, the dispatch Queue consumer, a cron for reconciliation, lease expiry, aging alerts and the spend breaker | `morrow_runtime_executor` (new) | `RuntimeBroker` (new) |
| `morrow-<env>-broker` | no | every provider credential and call; the vault | `morrow_vault_broker` (new, its own; never leased) | – |

- `apps/workers/src/orchestrator.ts` keeps `dispatch_disabled` until M4's stop controls, reservations and gateway pass their tests (invariant 15). M3's run workflow may draft and propose before that; it makes no external write.
- `apps/shopify-connector/worker/placeholder.ts` is replaced by `worker/index.ts` on `@shopify/shopify-api` (ADR-0008). The React Router app stays development scaffolding.
- `apps/api/src/environment.ts` `mapApiEnvironment` keeps rejecting provider bindings; `STRIPE_` joins its `providerPrefix` list. `reservedWorkerPaths` already covers `/api/*`.

## 4 Broker trust model v1 and methods (ADR-0022 item 7)

The v0 rules stay for the existing four methods (`health`, `neonLease`, `workosSessionPage`, `challengeVerify`). New methods follow v1:

- Only strings, booleans and integer budgets cross RPC; every failure is `BROKER_HELD` with a fixed log code (`invokeBrokerMethod`, `BrokerHold` in `apps/broker/src/capabilities.ts`).
- Each caller binds its own `WorkerEntrypoint` class, exposing only its methods. `neonLease` on each entrypoint serves only that caller's role namespace (`neonLeaseNamespace`, `brokerNeonRoles`).
- Every Shopify and model call names a live work lease (§5). The broker resolves it through the definer `morrow_vault.resolve_call(lease_id, generation, purpose, subject_id)`, which returns the installation, credential reference, store and stop state, or nothing.
- A Shopify write executes only an OperationLedger operation in `dispatching` under a current operation lease. Its input comes from the claimed proposal's stored parameters, never from the caller. Admin GraphQL documents are fixed in broker source; no caller-supplied query.

| Entrypoint | Method (strings, budgets in ms) | Returns | Milestone |
| --- | --- | --- | --- |
| Connector | `shopifyLaunchVerify(appKey, rawQuery)` | `{verdict, shop}` | M2 |
| Connector | `shopifyInstallComplete(appKey, rawCallbackQuery, stateDigest, budgetMs)` | `{shopId, shopDomain, scopes, credentialRef, credentialVersion, developmentStore}`; never the token | M2 |
| Connector | `shopifyWebhookVerify(appKey, headersJson, rawBodyBase64)` | `{verdict, topic, shopDomain, webhookId}` | M2 |
| Connector, Api | `shopifyCredentialDestroy(installationJson, reason)` | `"destroyed"` | M2 |
| Api, Runtime | `shopifyRead(leaseJson, queryName, variablesJson, budgetMs)` | minimised JSON for `shopIdentity`, `collectionsPage`, `productsPage`, `productContent` | M2 |
| Runtime | `modelRespond(leaseJson, callJson, budgetMs)` | `ModelResult@1` (output, usage, finish reason, provider request id) | M3 |
| Runtime | `shopifyProductUpdate(leaseJson, operationId, budgetMs)` | `{outcome: submitted, rejected or uncertain, userErrorCodes}` | M4 |
| Api | `stripeCustomerEnsure(operationJson, budgetMs)`, `stripeCheckoutCreate(operationJson, budgetMs)`, `stripePortalCreate(leaseJson, budgetMs)` | ids and the Stripe-hosted URL | M5 |
| Api | `stripeWebhookVerify(rawBody, signatureHeader, budgetMs)` | a receipt id for a verified, de-duplicated, read-back object | M5 |

Broker secrets added (owner-placed with `morrow_put` and `staging:put-secret`): `MORROW_VAULT_KEK_V1`, `SHOPIFY_APP_CREDENTIALS` (one JSON map of app key to client id and secret), `OPENAI_API_KEY`, `STRIPE_RESTRICTED_KEY`, `STRIPE_WEBHOOK_SECRET`, and the `morrow_vault_broker` password. Leased role passwords: `morrow_connector_ingress`, `morrow_runtime_executor` (added to `brokerNeonRoles` and `brokerRequiredSecrets`).

## 5 Tenancy for background work: work leases (ADR-0022 item 9)

- `morrow_work.work_leases`: `(organization_id, workspace_id, id)`, `store_id`, `kind` (`read`, `run`, `operation`), `subject_id` (run or operation), `generation`, `initiator_principal_id`, `initiator_membership_id`, `status` (`active`, `released`, `revoked`), `expires_at` (read 60 s, run 30 min, operation 15 min).
- Only api commands create leases, inside the tenant transaction that authorised the work (session context). `morrow_work.enter_lease(lease_id, generation)` (definer) sets a transaction-local lease context; `morrow_work.current_tenant()` is replaced in a forward migration to resolve either the session digest (unchanged) or that lease, rechecking that the lease is active, unexpired and current and that the workspace and initiating membership are active. A forged setting still yields zero rows.
- Grant decisions stay in `packages/policy`: every Workflow step reloads facts and reruns the kernel (`decideDelegation` for agent steps, the human kernel for the claimant at dispatch). The lease is the tenant selector and the P12 fencing generation, never authority.
- Revocation: a stop, a disconnect, a membership removal or uninstall sets matching leases `revoked` in the same transaction.

## 6 New tables

All follow ADR-0010 item 2 (tenant keys first, composite foreign keys, ENABLE and FORCE RLS, definers owned by `morrow_work_command` or the identity owner, conformance registration in `tests/tenant-conformance/registry.mjs`). Platform tables are marked P.

| Table | Milestone | Purpose | Retention (ADR-0022 item 13) |
| --- | --- | --- | --- |
| `morrow_work.work_leases`, `morrow_work.stop_controls` | M2 PR-1 | §5, §10 | 365 d content-free |
| `morrow_billing.workspace_billing_routes` | M2 PR-1 (first; M2's link writer sets `shopify_bound_at`) | ADR-0015 persistence item 1 | workspace lifetime |
| `morrow_vault.credentials` | M2 PR-1 | encrypted offline tokens; broker-only definers | destroyed at uninstall or disconnect |
| `morrow_identity.shopify_apps` (P) | M2 | app key, client id, intended shop domain, invited workspace, status | platform |
| `morrow_identity.shopify_oauth_states` | M2 | single-use OAuth state digest, 10 min | 7 d |
| `morrow_identity.store_installations` | M2 | `StoreInstallation@1` projection: shop id and domain, app, generation, scopes, credential ref and version, status, development flag | installation lifetime |
| `morrow_identity.install_continuations` | M2 | ADR-0015 persistence item 2; 5-min single-use token digest | retained after expiry, 365 d |
| `morrow_identity.shopify_webhook_inbox` | M2 | unique `(app, shop, webhook id)`; minimised body | 7 d |
| `morrow_identity.privacy_requests` | M2 | compliance topic, due time, completion evidence | 365 d content-free |
| `morrow_work.agent_releases` (P), `agent_installations`, `work_envelopes`, `delegation_hops` | M3 | P05.T04b minimum behind `agent-authority.ts` | installation lifetime |
| `morrow_work.runs`, `morrow_work.run_manifests` | M3 | `Run@1`, `RunManifest@1`; digests and usage only | 365 d content-free |
| `morrow_work.product_snapshots` | M3 | content-addressed product fields read for a proposal | 90 d; deleted at `shop/redact` |
| `morrow_billing.credit_wallets`, `credit_reservations`, `vendor_cost_reservations`, `usage_liabilities`, `test_entitlement_seeds` | M3 | P11.T04a minimum | financial period |
| `morrow_work.operations`, `morrow_work.operation_transitions` | M4 | §8 | 365 d |
| `morrow_billing.billing_accounts`, `stripe_customers`, `checkout_intents`, `stripe_event_receipts`, `verified_payment_events`, `held_payments`, `entitlement_snapshots`, `credit_grants`, `payment_reversals` | M5 | ADR-0015 persistence items 3–7, 10, 11 | financial period |

Forward changes to existing tables: `linking_candidates.proof_kind` and `linking_reviews.evidence_kind` admit `shopify_oauth` (M2); `proposals` gains store-bound agent proposals and `proposal_parameters` a redaction column (M3, §7 and §11).

## 7 Capability and proposal shape (ADR-0022 items 1–3)

- `mvp.md`'s `catalog.product.update` is the existing `catalog.content.publish` (external_write, `agent_after_approval`, review required, risk `external`). Drafting is `catalog.content.propose` (internal_write); reading is `catalog.products.read`. ADR-0022 item 1 adds `tags` to both content capabilities and fixes the FieldPaths: `title`, `descriptionHtml`, `seo.title`, `seo.description`, `tags`.
- Product `ResourceRef.id` is `product:<numeric GID tail>`, because a Shopify GID is not a core `Id`.
- Proposal@2 for one listing batch (unchanged contract):

```text
{schemaVersion: 2, capabilityId: "catalog.content.publish", storeId: S, taskId: T,
 scope: {organizationId: O, workspaceId: W, storeIds: [S], accountIds: [], resources: [product refs], fields: [sorted union]},
 targets: [{resource: {organizationId: O, workspaceId: W, storeId: S, connectionId: C, kind: "product", id: "product:<n>"},
            expectedSourceRevision: <snapshot digest>, fields: [...], maximumCredits: "0", maximumCost: null}],   // 1..25
 parametersRef: {..., kind: "artifact"}, parametersDigest, maximumCredits: "0", maximumCost: null,
 risk: "external", irreversible: false, partialApproval: "allowed", contextTaint: "none", derivedFrom: null,
 proposedBy: {kind: "agent", principalId: <Listings agent>, installationId: <Listings installation>, membershipId: null, mandateId: null, ...},
 requestedBy: <task initiator>, beneficiaryPrincipalIds: [], reviewPolicyRef, expiresAt, ...}
```

- Parameters are `CatalogContentChangeSet@1` (ADR-0022 item 2): `{schemaVersion: 1, storeId, items: [{targetIndex, productId, set: {title?, descriptionHtml?, seo?: {title?, description?}, tags?}, note}]}`. Each item's `set` keys equal its target's `fields`; `note` (at most 280 characters) is shown to reviewers and never applied. Bounded by the P06.T01b caps (32 KiB parameters, 128 KiB proposal); the producer packs at most 25 products per proposal, so a 50-product run yields two or more proposals on one task.
- `expectedSourceRevision` is the digest of the canonical snapshot of the five fields as read. Shopify has no conditional product write, so the gateway rereads and compares just before dispatch; the residual window between reread and write is documented, not hidden.
- `contextTaint` stays `none`: the run reads only the merchant's own catalogue, and every `catalog.content.publish` needs exact-digest human approval anyway, which satisfies the proposed untrusted-content rule if it is adopted later.

## 8 OperationLedger minimum (P06.T01c)

- One `morrow_work.operations` row per approved target: the core `Operation@1` fields plus `target_index`, `claim_family_root_id`, `lease_id`. Created `planned` and moved to `authorized` in the claim transaction (guard `exact_current_approval`); `maximumCredits` is `"0"`, so `authorized → dispatching` uses `non_billable_current_grants_and_lease`.
- Every transition is a row in `operation_transitions` using the state names of `state-transitions.json` unchanged. No second machine.
- Reconciliation query and postcondition, declared in the connector manifest (P08.T01a): read `productContent`; verified when every approved field equals the approved value; `verified_no_effect` when every field still equals the snapshot; anything else stays `uncertain` with `partial_result` and opens an exception at `/w/:ws/inbox/exceptions/:operationId`.
- No automatic resubmission in the MVP. `productUpdate` has no idempotency key, so an uncertain operation is resolved only by readback; a `failed` item is reported and the merchant asks again.
- Aging alert: the orchestrator cron logs `morrow_operation_aged` for any operation uncertain for more than 15 minutes (P04.T03a alert sink).

## 9 Credits (ADR-0022 item 11)

- Unit: one credit per product drafted. Applying costs no credits but is paid work (`isPaidWork` is true for `execute` on an `external_write` capability), so it needs an active entitlement.
- Run admission (api, one transaction): human kernel on the requester; entitlement through `createBillingConstraintsReader` (or an accepted `TestEntitlementSeed` in development and staging); `selectPayers` gives the single storeless `morrow_direct` payer; insert `CreditReservation` for the product count and `VendorCostReservation` for the run's worst-case vendor cost; move `available → reserved` in `credit_wallets` under a row lock.
- Every `modelRespond` is checked by the broker against the run's vendor reservation headroom before dispatch and books its usage after; a timed-out call books its worst case as an `uncertain` `UsageLiability`.
- Run end: credits settle at the products actually drafted (never above the reservation) and the rest is released; vendor cost settles from usage; a failed or cancelled run releases its credits.

## 10 Kill switches and stops (P11.T05a)

- `morrow_work.stop_controls`: scope `platform`, `workspace`, `installation`, `connection` or `capability`, with reason, actor and a `KillSwitchRecord` in the same transaction.
- Human kill switches use the existing v1.1 bodies (`KillSwitchControl`, `checkKillSwitchTarget` in `packages/policy/src/kill-switch.ts`): `agents.installation.disable` for the Listings installation ("Stop AI work"), `governance.connection.disconnect` for a store. Platform and capability stops are set by an owner-run, audited script. Agents may only propose them.
- Checked at run admission, at every Workflow step, at gateway admission, at `authorized → dispatching`, and inside `resolve_call`, so a stop holds even against a faulty orchestrator. Stops never reserve credits and never read entitlement (ADR-0011 Q8).
- A stop revokes matching leases. Submitted or uncertain operations keep reconciling; nothing claims a stop reverses a completed write.
- Spend breaker: the cron sets a platform stop on new runs when the last hour's vendor reservations exceed the owner-set ceiling. Reads, approvals and applies of already-drafted proposals continue.

## 11 Data classes and deletion (P09.T05a; ADR-0022 items 10, 13, 14)

| Class | Where | Deleted by |
| --- | --- | --- |
| Shop identity and scopes | `store_installations`, `linking_candidates` | `shop/redact`: pseudonymise domain; keep ids for audit |
| Offline token | `morrow_vault.credentials` | `app/uninstalled` and disconnect: destroyed at once |
| Product content read | `product_snapshots` | `shop/redact`: deleted; else 90 days |
| Product content drafted | `proposal_parameters` | `shop/redact`: bytes redacted, digest kept, so approval records stay valid |
| Webhook bodies | `shopify_webhook_inbox` (minimised) | 7 days |
| Model prompts and raw outputs | not stored; digests in `run_manifests` | – ; OpenAI side: `store:false` |
| Customer data | none requested (`read_products`, `write_products` only) | `customers/data_request` and `customers/redact` answered "none held", with evidence |
| Billing records | `morrow_billing.*`, Stripe ids and amounts only | retained for the financial period |

Every table that holds store content registers a redaction handler in one list in code (the P09.T05 cleanup contract), and the conformance suite fails a store-scoped content table with no handler. No real merchant store connects before M2's compliance path passes (invariant 16; mvp.md M6).

## 12 Minimal now, final interface

| Area | MVP | Interface kept for later |
| --- | --- | --- |
| Model | one provider, one alias, no fallback, no streaming, no tools | `ModelCall@1`/`ModelResult@1` through `modelRespond`; P13.T01 adds providers behind it |
| Coordinator | routes to Listings or declines; no planning loop | builtin_coordinator dispatcher, envelope and hop records (P05.T04b) |
| Specialist | one first-party release | `agent_releases` and `agent_installations` (P16 adds the store) |
| Catalogue data | live reads plus proposal snapshots | `shopifyRead` and snapshots; P09.T03 adds a synced projection |
| Ledger | one operation per target; readback reconciliation; no cancel flows | full status set and transition table |
| Credits | one payer, one plan, no top-ups | reservations, liabilities, `selectPayers` |
| Billing | Stripe route only, one monthly price | both ADR-0015 routes in `billing-state.ts` |
| Connector | custom distribution, one app per store, workspace-first only | `shopify_apps` registry keyed by app; public distribution adds a row |
| Orchestration | two Workflows, no durable human waits | Workflow ids equal run and operation ids (P06.T03a) |

## 13 Delivery order

1. M1 live (staging).
2. M2 PR-1, the spine foundation: leases, stops, route row, vault, the three executor logins, broker entrypoints and v1 plumbing. M3 and M5 branch from it.
3. M2, M3 and M5 in parallel. M4 joins M2 and M3. M3 runs on the test seed until M5 lands.
4. Each provider effect (Shopify development store, OpenAI staging project, Stripe test mode, the connector hostname) needs a per-action owner approval or a new staging card: `staging-card-1` covers only the four Workers with the api on workers.dev.
