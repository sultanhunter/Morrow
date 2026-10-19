# MVP architecture spine (M2–M5)

- Status: draft brief, 2026-10-19, revised after two AI critiques (separate context, same model family). It is routine except where it cites ADR-0022, which holds every material choice (ADR-0021 item 5) and is Proposed.
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
| 7 | Ask and admit | api | work API `POST /goals`, `POST /tasks` (P06.T01a) | `POST /workspace/:ws/work/tasks/:taskId/runs`; the code Coordinator | `runs`, child task, envelope, hop, Coordinator grant, reservations, lease, outbox |
| 8 | Draft | orchestrator `ListingsRunWorkflow`, broker | `decideDelegation`, `validateCurrentDefinition` | broker `shopifyRead`, `modelRespond`; HTML sanitiser | `product_snapshots`, `run_drafts`, `run_manifests` |
| 9 | Propose | orchestrator | `ProposalProducer`, `checkProposal` (P06.T01b) | the agent submit definer; the `catalog.content.publish` producer | `proposals`, `proposal_parameters`, `approvals` |
| 10 | Approve | api | `decideApproval`, P06.T01b PR-2 routes | `/w/:ws/review/:proposalId` | `approval_decisions` |
| 11 | Claim | api | `prepareApprovalClaim`, `approval_claim` | `POST /workspace/:ws/work/proposals/:proposalId/apply` | `approval_claims`, `operations` (`authorized`), lease |
| 12 | Write | orchestrator `OperationWorkflow`, broker | operation machine (`state-transitions.json`) | broker `shopifyProductUpdate` (fenced) | dispatching → submitted, failed or uncertain |
| 13 | Read back | orchestrator, broker | – | broker `shopifyRead(productContent)` keyed by operation | verified, failed or uncertain |
| 14 | Audit | all | `outbox_events` (0015), `KillSwitchRecord` | `operation_transitions`, `StopRecord@1` | append-only, content-free |
| 15 | Settle | orchestrator | `CreditReservation`, `VendorCostReservation` | settle and release statements | `credit_wallets`, `run_manifests` |

Staging pays through Stripe test mode, so steps 2–3 run there too; the MVP has no test entitlement seed (ADR-0022 item 5).

## 3 Workers

| Worker | Public | Owns | Database login | Broker entrypoint |
| --- | --- | --- | --- | --- |
| `morrow-<env>-api` | yes, workers.dev (ADR-0019) | sessions, work API, store links, Listings enablement, run admission, approvals, claims, billing routes, the Stripe webhook route | `morrow_api_worker` plus the P05 pools | `ApiBroker` |
| `morrow-<env>-connector` | yes, own hostname (ADR-0022 item 6) | Shopify launch, callback, webhooks, continuation, status; the webhook Queue consumer | `morrow_connector_ingress` (new) | `ConnectorBroker` (new) |
| `morrow-<env>-orchestrator` | no | `ListingsRunWorkflow`, `OperationWorkflow`, the dispatch Queue consumer (ids only), a cron that starts pending Workflows | `morrow_runtime_executor` (new) | `RuntimeBroker` (new) |
| `morrow-<env>-broker` | no | every provider credential and call; the vault | `morrow_vault_broker` (new, never leased) | – |

- `apps/workers/src/orchestrator.ts` replaces `MorrowWorkWorkflow` with the two Workflow classes, each enabled separately. `ListingsRunWorkflow` stays `dispatch_disabled` until M3 PR-1's stop, reservation and `resolve_call` tests pass. `OperationWorkflow` stays disabled until M4 PR-1's gateway tests pass (invariant 15; ADR-0022 item 10).
- Workflow steps and Queue messages carry ids and digests only. Content is written to tenant tables inside a step, or used in memory within one step (§11).
- `apps/shopify-connector/worker/placeholder.ts` is replaced by `worker/index.ts` on `@shopify/shopify-api` (ADR-0008).
- `apps/api/src/environment.ts` `mapApiEnvironment` keeps rejecting provider bindings; `STRIPE_` joins its `providerPrefix` list.

## 4 Broker trust model v1 and methods (ADR-0022 item 7)

The v0 rules stay for `health`, `neonLease`, `workosSessionPage` and `challengeVerify`. New methods follow v1:

- Each caller binds its own `WorkerEntrypoint` class, exposing only its methods; `neonLease` serves only that caller's roles (`neonLeaseNamespace`, `brokerNeonRoles`). Failures return a fixed code (`invokeBrokerMethod`, `BrokerHold`), never provider text.
- Writes and destroys take ids only. The broker loads the installation, operation, parameters, price and customer mapping from the database.
- Every Shopify read and model call is resolved by `morrow_vault.resolve_call(lease_id, generation, purpose, subject_id)`: installation, credential, store and stop state, or nothing. Purpose `reconcile` takes an operation id instead of a lease (§8).
- Admin GraphQL documents are fixed in broker source. Reads honour `THROTTLED` by waiting for the restore time within the budget.

| Entrypoint | Method | Returns | Milestone |
| --- | --- | --- | --- |
| Connector | `shopifyLaunchVerify(appKey, rawQuery)` | `{verdict, shop, installationActive}` | M2 |
| Connector | `shopifyInstallComplete(appKey, rawCallbackQuery, stateDigest, budgetMs)` | `{shopId, shopDomain, scopes (expanded), credentialRef, credentialVersion, developmentStore}`; never the token | M2 |
| Connector | `shopifyWebhookVerify(appKey, headersJson, rawBodyBase64)` | `{verdict, topic, shopDomain, webhookId, minimisedBody}` | M2 |
| Connector, Api | `shopifyCredentialDestroy(installationId, reason)`: only when the row records uninstall or disconnect | `"destroyed"` | M2 |
| Api, Runtime | `shopifyRead(leaseId, generation, queryName, variablesJson, budgetMs)` | minimised JSON for `shopIdentity`, `collectionsPage`, `productsPage`, `productContent` | M2 |
| Runtime | `modelRespond(leaseId, generation, callJson, budgetMs)` | `ModelResult@1` | M3 |
| Runtime | `shopifyProductUpdate(operationId, generation, budgetMs)` | `{outcome: submitted, rejected, not_sent or uncertain, codes}` | M4 |
| Runtime | `shopifyReconcileRead(operationId, budgetMs)` | readback verdict and field digests | M4 |
| Api | `stripeCustomerEnsure(operationId)`, `stripeCheckoutCreate(operationId)`, `stripePortalCreate(operationId)` | ids and the Stripe-hosted URL | M5 |
| Api | `stripeWebhookVerify(rawBody, signatureHeader, budgetMs)` | a receipt id for a verified, de-duplicated, read-back object | M5 |

Broker secrets (owner-placed with `morrow_put` and `staging:put-secret`): `MORROW_VAULT_KEK_V1`, `OPENAI_API_KEY`, `STRIPE_RESTRICTED_KEY`, `STRIPE_WEBHOOK_SECRET`, the `morrow_vault_broker` password. Shopify app client secrets are vault rows (`morrow_vault.app_secrets`), written by an owner-run script. Leased role passwords: `morrow_connector_ingress`, `morrow_runtime_executor`.

## 5 Tenancy for background work (ADR-0022 item 9)

- `morrow_work.work_leases`: tenant keys, `store_id`, `kind` (`read`, `run`, `operation`), `subject_id`, `generation`, `initiator_principal_id`, `initiator_membership_id`, `status`, `expires_at` (read 60 s, run 30 min, operation 15 min). Expiry is checked at every use, so no sweep is needed.
- Only api commands create leases, inside the session transaction that authorised the work.
- `current_tenant()` and every session definer stay unchanged and session-only. `morrow_work.enter_lease(lease_id, generation)` runs only when `session_user` is `morrow_runtime_executor`. It sets a lease context that only `morrow_work.current_lease()` reads, rechecking that the lease is active, unexpired and current and that the workspace and initiating membership are active. New runtime definers and new tables' policies use `current_lease()`. The conformance harness adds two probes: a forged lease setting yields zero rows, and a lease context calling a session definer is refused.
- Grant decisions stay in `packages/policy`. Agent steps rerun `decideDelegation`. At dispatch, the claimant is evaluated with a lease-backed human authority: "operation lease current and membership active" replaces `sessionCurrent`, which is never faked (`agent-authority.md`).
- Revocation: a stop, a disconnect, a membership removal or an uninstall sets matching leases `revoked` in the same transaction.
- Cross-tenant reads: one definer, `morrow_work.pending_starts()`, executable only by `morrow_runtime_executor`. It returns the ids of committed runs and claims whose Workflow has not started, and nothing else, and is registered as content-free in the conformance registry.

## 6 New tables

All follow ADR-0010 item 2 (tenant keys first, composite foreign keys, ENABLE and FORCE RLS, definers, registration in `tests/tenant-conformance/registry.mjs`). P marks a platform table.

| Table | Milestone | Purpose | Retention (ADR-0022 item 13) |
| --- | --- | --- | --- |
| `morrow_work.work_leases`, `stop_controls`, `stop_records` | M2 PR-1 | §5, §10; platform stop rows have null tenant keys, are visible to every tenant and are written only by the owner script | 365 d content-free |
| `morrow_work.operations`, `operation_transitions` | M2 PR-1 | `Operation@2`, kinds `catalog_write` and `stripe_write`; claim columns nullable (§8) | 365 d |
| `morrow_billing.workspace_billing_routes` | M2 PR-1 | ADR-0015 persistence item 1 | workspace lifetime |
| `morrow_vault.credentials`, `morrow_vault.app_secrets` (P) | M2 PR-1 | encrypted tokens and app client secrets; broker-only definers | destroyed at uninstall or disconnect; app secrets until rotated |
| `morrow_identity.shopify_apps` (P) | M2 | app key, client id, intended shop domain, invited workspace, status | platform |
| `morrow_identity.shopify_oauth_states` | M2 | single-use state digest, 10 min | 7 d |
| `morrow_identity.store_installations` | M2 | `StoreInstallation@1`: shop, app, generation, expanded scopes, credential ref and version, status | installation lifetime |
| `morrow_identity.install_continuations` | M2 | ADR-0015 persistence item 2; 5-min single-use token digest | 365 d |
| `morrow_identity.shopify_webhook_inbox` | M2 | unique `(app, shop, webhook id)`; minimised body (§11) | 7 d |
| `morrow_identity.privacy_requests` | M2 | topic, due time, completion evidence | 365 d content-free |
| `morrow_work.agent_releases` (P), `agent_installations`, `work_envelopes`, `delegation_hops` | M3 | P05.T04b minimum behind `agent-authority.ts` | installation lifetime |
| `morrow_work.runs`, `run_manifests` | M3 | `Run@1`, `RunManifest@1`; digests and usage | 365 d content-free |
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

## 9 Credits (ADR-0022 item 11)

- One credit per product drafted. Applying costs no credits but is paid work (`isPaidWork` for `execute` on an `external_write` capability).
- Run admission (api, one transaction): human kernel on the store resource; entitlement directly through `workspaceBillingState` and `entitlementFor`, because `createBillingConstraintsReader` skips non-paid requests; `selectPayers` gives the single `morrow_direct` payer; `CreditReservation` for the product count and `VendorCostReservation` for the worst case (US$0.28 per product); `available → reserved` in `credit_wallets` under a row lock. The daily cap counts settled cost plus open reservations.
- The agent fact reader sets `entitlementAllowed` from the same `entitlementFor` result and joins the `inspectEntitlementWriters` allowlist.
- The broker checks each `modelRespond` against the run's remaining vendor reservation before sending and books usage in the run manifest after. A call that times out books its worst case. `incomplete`, `refusal` and `spend_limit` are explicit `ModelResult` outcomes; `spend_limit` fails the run without retry.
- Run end: credits settle at the products drafted (never above the reservation); the rest is released; vendor cost settles from usage. `UsageLiability` is not used in the MVP.

## 10 Stops (P11.T05a; ADR-0022 item 15)

- `stop_controls`: scope `platform`, `installation` or `connection`, with reason and actor. Human kill switches write a `KillSwitchRecord` through the existing v1.1 bodies (`KillSwitchControl`, `checkKillSwitchTarget` in `packages/policy/src/kill-switch.ts`): `agents.installation.disable` ("Stop AI work") and `governance.connection.disconnect`. The uninstall webhook and the owner's platform script write `StopRecord@1` (actor `system` or `operator`). Agents may only propose stops.
- Checked at run admission, at every Workflow step, inside `resolve_call` before any model call or dispatch, at claim and at `authorized → dispatching`. Stops never reserve credits or read entitlement (ADR-0011 Q8), and never block readback.
- A stop revokes matching leases. Only a person lifts a stop.
- Delivered before any model call: the tables in M2 PR-1, the disconnect command in M2 PR-3, and "Stop AI work", the platform script and the `resolve_call` checks in M3 PR-1.

## 11 Data classes and deletion (P09.T05a; ADR-0022 items 10, 13, 14)

| Class | Where | Deleted by |
| --- | --- | --- |
| Shop identity and scopes | `store_installations`, `linking_candidates` | `shop/redact`: pseudonymise domain; keep ids |
| Offline token | `morrow_vault.credentials` | `app/uninstalled` and disconnect: destroyed at once |
| Product content read or drafted | `product_snapshots`, `run_drafts` | `shop/redact`: deleted; else 90 days |
| Product content proposed | `proposal_parameters` | `shop/redact`: emptied, digest kept (below) |
| Webhook bodies | `shopify_webhook_inbox` | 7 days; `customers/*` keep only topic, shop id, webhook id, request id and a keyed digest of the customer id: no email, phone or order ids |
| Workflow state, Queue messages | Cloudflare | ids and digests only, so nothing to delete |
| Model prompts and raw outputs | not stored; digests in `run_manifests` | OpenAI side: `store:false` |
| Customer data | none (`read_products`, `write_products` only) | `customers/*` answered "none held", with evidence |
| Billing records | `morrow_billing.*`, Stripe ids and amounts | financial period |

- Parameter redaction is one forward migration on the P06.T01b table: the digest check becomes `(redacted_at IS NULL AND digest = sha256(canonical)) OR (redacted_at IS NOT NULL AND canonical = '{}')`; the append-only trigger allows only `redacted_at` null → set, through one definer executable by `morrow_connector_ingress`; `approval_claim` and the broker refuse redacted parameters.
- Every store-content table registers a handler in one list in code (the P09.T05 cleanup contract); the conformance suite fails a store-scoped content table without one, and a test asserts Workflow step outputs carry no content fields. No real merchant store connects before M2's compliance path passes (invariant 16; mvp.md M6).

## 12 Minimal now, final interface

| Area | MVP | Interface kept for later |
| --- | --- | --- |
| Model | one provider and alias, one product per call, no fallback, streaming or tools | `ModelCall@1`/`ModelResult@1` through `modelRespond` |
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
5. Each provider effect (development store, OpenAI staging project, Stripe test mode, the connector hostname) needs per-action owner approval or a new staging card: `staging-card-1` covers only the four Workers with the api on workers.dev.
