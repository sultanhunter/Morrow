# ADR-0022 MVP contracts: listings authority, Shopify, OpenAI and Stripe usage, broker custody, background tenancy and retention

- Status: Proposed
- Date: 2026-10-19 (revised after two AI critiques, same day)
- Amends, if accepted: ADR-0007 items 1 and 4 (connector hostname; Shopify, OpenAI and Stripe credentials in the broker under trust model v1, development and staging only); ADR-0019 item 2 (a second public Worker); ADR-0010 item 2 (a lease context for background work, beside the unchanged session context); contract v1.1 (`ResourceRef` gains kind `store`; `Operation@2` allows a taskless billing operation); the Shopify row of `docs/decisions/providers.json` (custom distribution for the beta).
- Does not change: ADR-0007 item 9 (production custody needs its own ADR before M6); ADR-0020 (no new membership pair or owner role); ADR-0015 (both routes stay; the MVP uses only Morrow-direct); ADR-0005 (kill switches stay human-only).
- Affects: `docs/briefs/mvp-architecture.md` (the spine) and the M2–M5 briefs; `docs/contracts/capabilities.json`; contract v1.1 (or v1.2 if frozen first); `migrations/`; `apps/broker`, `apps/shopify-connector`, `apps/workers`, `apps/api`; `docs/decisions/{providers.json, model-policy.json, data-lifecycle.md}`.

## Context

ADR-0021 launches an invite-only listings beta on the production-grade foundation. Under its item 5, only choices about authority, tenancy, security, money, provider usage, public contracts or data retention need an ADR. This record collects every such choice in the spine, so one owner answer unblocks M2–M5. Two separate-context AI critiques (same model family) checked the first draft against the code and the provider documentation; this revision folds in their findings and removes parts the beta does not need.

Facts it relies on, read 2026-10-19:

- Custom distribution serves one store (or one Plus organisation), cannot use Shopify app billing, and cannot change distribution later ([distribution](https://shopify.dev/docs/apps/launch/distribution)). Expiring offline tokens are required for public apps and optional for custom apps ([offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens)).
- The policy kernels allow a request only when a grant's scope lists that exact resource (`packages/policy/src/index.ts`, `agent-authority.ts` `scopeCovers`). No resource kind means "this store".
- OpenAI `max_output_tokens` includes reasoning tokens. Strict Structured Outputs accept only a subset of JSON Schema.
- Stripe does not copy Checkout Session metadata to the Subscription or Invoice; only `subscription_data.metadata` reaches the invoice.

## Summary for the owner

Approving this ADR means:

1. Listings uses the existing catalogue permissions. Merchants and the Listings agent get permissions for the whole connected store, not product by product.
2. The Listings agent is switched on by the owner with an explicit "Enable Listings agent" action. It can read and draft, and propose changes. Only a person approves and applies.
3. The Coordinator routes in code for the beta (no extra AI call). A model router can replace it later without changing the records.
4. Each beta store gets its own private Shopify app. Its token never expires (simpler for the beta); app secrets and tokens sit encrypted in the broker's vault.
5. Staging and production both pay through Stripe (test mode for now). There is no free test shortcut.
6. A store write is sent at most once. If Morrow does not know whether it worked, it reads the product back and never resends.
7. Background work runs under short leases that select the tenant but grant nothing. The policy check runs again at every step. Signing out does not stop an apply already started; losing membership or permissions, or a stop, does.
8. OpenAI drafts one product per call, with low reasoning effort, `store:false`, a strict output schema, and an enforced hard monthly limit on the OpenAI project.
9. One credit per product drafted. A run holds at most 25 products and reserves at most US$7 of AI cost. A workspace spends at most US$25 a day.
10. Stripe: one plan, Checkout and the customer portal, a pinned API version, and tax-ready settings switched on at live launch. Refund and dispute handling waits for M6, before live money.
11. Stops: the owner's "Stop AI work" and "Disconnect store" kill switches, plus a platform stop the owner sets by script. Automatic stops (uninstall) are system records, not kill switches. Only people lift stops.
12. Product data is deleted on Shopify's request, including drafts held in approval records. Customer data is never stored.

## Decision

1. **Listings capability.** The existing catalogue entries: `catalog.products.read` (read), `catalog.content.propose` (draft), `catalog.content.publish` (store write: `external_write`, `agent_after_approval`, review required, risk `external`). `mvp.md`'s `catalog.product.update` means `catalog.content.publish`. Both content capabilities add `tags`. FieldPaths: `title`, `descriptionHtml`, `seo.title`, `seo.description`, `tags`. A product's `ResourceRef.id` is `product:<numeric GID tail>`. Every listings proposal carries `contextTaint: untrusted_external`, because the run reads product text that third parties may have written.
2. **Contract additions** (v1.1 candidate edits, else v1.2):
   - `ResourceRef.kind` gains `store` (`id` equals `storeId`, with its `connectionId`);
   - `Operation@2`: `taskId` may be null only for a `governance.billing.manage` operation (the ADR-0018 pattern);
   - `CatalogContentChangeSet@1` (proposal parameters), `ListingDraft@1` (model output; a strict model schema `ListingDraft_v1` is generated from it), `CoordinatorRoute@1` (a run record), `ModelCall@1` and `ModelResult@1` (internal; outcomes include `incomplete`, `refusal` and `spend_limit`), `StopRecord@1` (system and operator stops);
   - the capability `governance.billing.manage` (`control`, `human_only`, review not required, not paid work), as P01.T04a §4.3 specified;
   - the public endpoints `/shopify/a/:appKey/{launch,callback,webhooks}` on the connector host and `POST /api/billing/stripe/webhook` on the api, plus the additive routes in the briefs.
3. **Authority.**
   - **Store resource.** Catalogue permissions are evaluated on the store resource `{kind: "store", id: S, storeId: S, connectionId: C}`. That is the resource for run admission, catalogue reads, every agent step, the claim and dispatch. Code then checks that every product target has the same store and connection.
   - **Signup template v2** adds `governance.billing.manage` {view, execute}. A forward migration backfills existing owner memberships.
   - **Store-link template**, applied in the link transaction to the linking owner, on the store resource: `catalog.products.read` {view, delegate}; `catalog.content.propose` {execute, delegate}; `catalog.content.publish` {propose, approve, execute, delegate}; `agents.installation.activate` {execute}.
   - **Listings installation.** Created and activated only by the owner's "Enable Listings agent" command for a linked store. In the same transaction the owner issues the installation's grants (`catalog.products.read` {view}, `catalog.content.propose` {execute}, `catalog.content.publish` {propose}) and receives `agents.installation.disable` {execute} on it. No agent ever holds `approve` or `execute` on `catalog.content.publish`.
   - **Coordinator.** One built-in agent principal per workspace, deterministic code in the beta. Run admission creates the envelope on the merchant's task, a child task for the installation, one hop, and a `workspace.task.delegate` {delegate} grant for the Coordinator on the parent task that expires with the envelope, issued by the requester.
   - **Agent records.** `morrow_identity.grants` admits agent principals (`membership_id` null only for kind `agent`). `proposals` admits an agent proposer (`proposer_membership_id` null only with an installation). Agents submit through their own definer, never the human submit path.
4. **Shopify access.**
   - One custom-distribution app per beta store: non-embedded, authorization code grant, Admin GraphQL `2026-10`, scopes `read_products` and `write_products`. Granted scopes are compared as expanded sets (a write scope implies its read).
   - Non-expiring offline tokens for the beta. Refresh arrives with public distribution, as a new credential kind in the same vault.
   - Webhooks `app/uninstalled`, `app/scopes_update`, `customers/data_request`, `customers/redact` and `shop/redact`; no product topics.
   - Per-app URL paths keyed by a Morrow app key. Each app's client secret is stored encrypted in the vault, one row per app, written by an owner-run script; there is no shared secret list.
   - Development stores only until M6.
5. **Linking rule.** Workspace-first only, in every environment. A store's install link is shown, and the link transaction succeeds, only for a workspace whose route is fixed to `morrow_direct`. Staging pays in Stripe test mode; the MVP does not use `TestEntitlementSeed`. An install that matches no registered app and invited workspace creates nothing.
6. **Connector hostname.** The connector Worker has its own public hostname (workers.dev on staging, a custom subdomain in production), so `__Host-` session cookies never reach it. The broker and orchestrator stay unrouted. A staging card change is needed.
7. **Broker trust model v1 and credential custody** (development and staging; production needs ADR-0007 item 9):
   - One `WorkerEntrypoint` per caller (`ApiBroker`, `ConnectorBroker`, `RuntimeBroker`), each exposing only its methods. RPC carries ids, strings and budgets; the broker loads installations, operations, prices and customer mappings from the database itself.
   - Every Shopify and model call names a live lease, or an operation under reconciliation, checked in the database with the stop state.
   - A Shopify write runs only for an operation in `dispatching`, with input from the claimed proposal's stored parameters. Under a row lock the broker marks the send as started before calling Shopify, and refuses a second send for that operation. Any failure after the mark is `uncertain` and is resolved by readback only. A reply that proves nothing ran (`THROTTLED`, 429, 401, `ACCESS_DENIED`) is "not sent".
   - Vault: AES-256-GCM with a per-record data key wrapped by a versioned KEK held only in broker secrets; AAD (environment, organization or platform, record id, provider, version). The owner keeps an offline KEK backup. Tokens are destroyed at uninstall or disconnect.
   - Credentials admitted: Shopify app secrets and offline tokens, `OPENAI_API_KEY`, `STRIPE_RESTRICTED_KEY`, `STRIPE_WEBHOOK_SECRET`.
8. **Database roles.** Three membership-free executor logins on the P05 pattern: `morrow_connector_ingress` and `morrow_runtime_executor` (leased by `neonLease`) and `morrow_vault_broker` (the broker's own, never leased). Each executes only its own definers, guarded by `executor_memberships_closed(session_user)`. The ADR-0020 closed set and owner roles are unchanged.
9. **Tenancy for background work.**
   - `morrow_work.current_tenant()` and every session definer stay session-only and unchanged.
   - Api commands create leases inside the session transaction that authorised the work: read 60 s, run 30 min, operation 15 min. `morrow_work.enter_lease` runs only when `session_user` is `morrow_runtime_executor`. Only new runtime definers and new tables' policies read the lease context.
   - A lease selects the tenant and fences generations; it grants nothing. The kernel reruns at every step. At dispatch, the claimant's authority is evaluated with "operation lease current and membership active" in place of a browser session. Sign-out does not stop a claimed apply; membership removal, grant revocation and stops do.
   - Readback of an operation already `submitted`, `uncertain` or `verifying` is keyed by the operation, needs no live lease and is never blocked by a stop.
   - One cross-tenant sweep definer, executable only by `morrow_runtime_executor`, returns the ids of committed runs and claims whose Workflow has not started. It returns no content.
   - **Accepted residual risk:** a compromised orchestrator could act within any tenant's live leases until they expire, and can list pending ids. This is the background analogue of the ADR-0010 item 2 residual.
10. **OpenAI usage.**
    - The Responses API with `default_model` from `model-policy.json`, for the Listings specialist only (the Coordinator is code). One product per call; reasoning effort pinned per role (Listings: `low`); strict Structured Outputs; no escalation model, images, tools, Files, vector stores, background mode or fallback.
    - `store:false` and default processing. Without a zero-data-retention agreement, OpenAI's abuse-monitoring retention of up to 30 days applies and is disclosed.
    - Data sent: the merchant's request text, the store name and the selected product's catalogue fields. Never customer data, staff emails, credentials or payment data.
    - Separate staging and production projects, each with an enforced hard monthly limit. A spend-limit refusal ends the run without retry.
    - A model call is metered spend, not a store effect. It needs reservations and stops (M3 PR-1). Store writes need the M4 gateway (invariant 15).
11. **Credits and spend limits** (numbers are owner-adjustable configuration):
    - One credit per product drafted; a run reserves its product count and settles at the products drafted. Applying costs no credits but needs an active entitlement.
    - Run admission checks entitlement directly (`workspaceBillingState`, `entitlementFor`), because drafting is not paid work under `isPaidWork`; the agent fact reader uses the same result.
    - Caps: at most 10,000 input and 12,000 output tokens per call (output includes reasoning); at most two attempts per product; at most 25 products per run. At US$2 and US$10 per million tokens, that is US$0.28 per product worst case (about US$0.04 expected), US$7 per run and US$25 per workspace per day.
    - No platform spend breaker in the beta: the enforced OpenAI project limit and the owner's platform stop are the outer bounds.
    - Model usage settles against the run's `VendorCostReservation` and is recorded in its run manifest. `UsageLiability` is not used in the MVP.
    - Beta plan (recommended): US$49 a month with 300 credits, revisited after the first real runs.
12. **Stripe.**
    - Test mode now; live mode only after M6 activation, under per-action approval. One pinned API version in the broker and on the webhook endpoint, recorded in `providers.json`.
    - One Product and one monthly USD Price, with a tax code and tax behaviour set. One Customer per workspace, created with an idempotency key bound to its operation.
    - Subscription-mode Checkout on that customer, expiring after one hour. The operation and workspace ids go in the session metadata and in `subscription_data.metadata`. Billing address collection and `automatic_tax` are behind configuration, so live tax needs no code change.
    - Customer portal through a saved configuration: payment method, invoices, cancellation at period end; no plan switching.
    - Webhook events: `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.
    - Before live money (M6): refunds, disputes and held-payment handling; Stripe Tax registrations, or Stripe Managed Payments instead.
    - Not used: Payment Links, Pricing Tables, coupons, trials and top-ups.
13. **Retention of new data.**

    | Data | Retention |
    | --- | --- |
    | Product snapshots and run drafts | 90 days; deleted at `shop/redact` |
    | Drafted values in proposal parameters | Until `shop/redact`, which empties them and keeps the digest. This is one narrow exception to the append-only rule; a redacted proposal can never be approved, claimed or applied |
    | Webhook inbox rows | 7 days; `customers/*` rows keep only ids and a keyed digest of the customer id |
    | Workflow state and Queue messages | Ids and digests only, never content |
    | OAuth states | 7 days |
    | Privacy evidence, run manifests, leases, stop records and operation transitions | 365 days, content-free |
    | Vault tokens | Destroyed at uninstall or disconnect |
    | Model prompts and raw outputs | Not stored |
    | Stripe payment records | Ids and amounts only, for the financial-records period (7 years until the tax advisor confirms) |

14. **Compliance topics on custom apps.** The three compliance topics are subscribed and completed although Shopify requires them only of public apps. `customers/*` record "no customer data held", with evidence. `shop/redact` completes within 24 hours (30-day maximum). `app/uninstalled` takes effect at once. No non-development store links before this path passes its tests.
15. **Stops.**
    - Human kill switches (ADR-0005, `KillSwitchRecord`): `agents.installation.disable` ("Stop AI work") and `governance.connection.disconnect`.
    - System and operator stops (`StopRecord@1`): a connection stop set by `app/uninstalled`, and a platform stop set by an owner-run, audited script. They are gateway controls, not kill switches.
    - Scopes: platform, installation and connection. Stops block run admission, model calls, claims and dispatch, never readback. Only a person lifts a stop.

## Consequences

- M2–M5 may start on acceptance, in the order of spine §13. Every provider effect still needs per-action approval or a staging card.
- `providers.json`, `model-policy.json` (`private_content_dispatch` for catalogue data, the pinned reasoning effort, and reasoning tokens and retries counted as output cost) and `data-lifecycle.md` gain the rows above in the PRs that implement them.
- Before M6: the production custody ADR (ADR-0007 item 9), Shopify's written answer on charging custom-distribution installs (ADR-0015 Risk 2), the tax advisor's retention period, and the before-live-money items in item 12.
- Public distribution later is a new app and installation generation, with expiring tokens added as a new vault credential kind. The registry, vault and linking records already allow it.

## Alternatives considered

- **Product-by-product grants.** A scope holds at most 1,000 exact resources and never covers new products.
- **A wildcard rule in `scopeCovers`.** It changes both kernels' semantics; naming the store as the resource does not.
- **Replacing `current_tenant()` to accept leases.** Every existing session definer would then treat a lease as the signed-in human.
- **A model-based Coordinator now.** An extra call, cost and input for a route the Ask screen already fixes.
- **Expiring tokens now.** A refresh path, refresh races and 90-day expiry, for a beta that will need a new app for public distribution anyway.
- **A test entitlement seed for staging.** Its own payer path and approvals, where Stripe test mode is free.
- **An unlisted public app.** It needs App Review and Shopify billing, which conflicts with the Stripe beta.
- **Letting the broker trust its callers for writes (v0 style).** A faulty orchestrator could write arbitrary content.

## Approval

Pending. The owner may approve all items as recommended in one answer, or name items to change.
