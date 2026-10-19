# ADR-0022 MVP contracts: listings capability, Shopify, OpenAI and Stripe usage, broker custody, background tenancy and retention

- Status: Proposed
- Date: 2026-10-19
- Amends, if accepted: ADR-0007 items 1 and 4 (connector hostname; Shopify, OpenAI and Stripe credentials in the broker under trust model v1, development and staging only); ADR-0019 item 2 (a second public Worker); ADR-0010 item 2 (a lease context alongside the session context); the Shopify row of `docs/decisions/providers.json` (custom distribution instead of a public app for the beta).
- Does not change: ADR-0007 item 9 (production custody stays undecided and needs its own ADR before M6); ADR-0020 (no new membership pair, no new owner role); ADR-0015 (both routes stay; the MVP uses only Morrow-direct).
- Affects: `docs/briefs/mvp-architecture.md` and the M2–M5 briefs; `docs/contracts/capabilities.json`; contract v1.1 (or v1.2 if frozen first); `migrations/`; `apps/broker`, `apps/shopify-connector`, `apps/workers`, `apps/api`; `docs/decisions/{providers.json, model-policy.json, data-lifecycle.md}`.

## Context

ADR-0021 launches an invite-only listings beta on the production-grade foundation. The design is in `docs/briefs/mvp-architecture.md` (the spine). Under ADR-0021 item 5, only choices about authority, tenancy, security, money, provider usage, public contracts or data retention need an ADR. This record collects every such choice in the spine, so that one owner answer unblocks M2–M5. Everything else in the briefs is routine.

Facts it relies on, read 2026-10-19:
- Custom distribution serves one store, or several stores of one Plus organisation, and "can't charge merchants through Shopify's app billing system". The distribution method cannot be changed after it is chosen ([distribution](https://shopify.dev/docs/apps/launch/distribution), [select a method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)).
- Expiring offline tokens last one hour, with a 90-day refresh token. They are required for public apps and optional for custom apps ([offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens)).
- ADR-0007 item 4 bars Shopify, OpenAI and Stripe credentials from the v0 broker until a broker trust model and credential-custody ADR exist. This record is that ADR for development and staging.

## Decision

1. **Listings capability (catalogue).** The slice uses the existing catalogue entries:
   - `catalog.products.read` for reads;
   - `catalog.content.propose` for drafting;
   - `catalog.content.publish` for the store write (`external_write`, `agent_after_approval`, review required, risk `external`).

   `mvp.md`'s name `catalog.product.update` refers to `catalog.content.publish`; no new capability is added. Both content capabilities add `tags` to `field_scope`. The FieldPaths are `title`, `descriptionHtml`, `seo.title`, `seo.description` and `tags`. A product's `ResourceRef.id` is `product:<numeric GID tail>`.
2. **Contract additions** (additive v1.1 definitions while v1.1 is a candidate, else v1.2):
   - `CatalogContentChangeSet@1`, the proposal parameters, bound by `parametersDigest`;
   - `CoordinatorRoute@1` and `ListingDraft@1`, the model structured outputs;
   - `ModelCall@1` and `ModelResult@1`, internal, between the orchestrator and the broker.

   Also:
   - the capability `governance.billing.manage` (`control`, `human_only`, review not required, not paid work), as P01.T04a §4.3 specified under OQ-1 (b);
   - the public endpoints `/shopify/a/:appKey/{launch,callback,webhooks}` on the connector host and `POST /api/billing/stripe/webhook` on the api;
   - the additive work, store-link, run, apply, catalogue-read and billing routes listed in the briefs.
3. **Grants.** The next owner grant template (template v2) adds:
   - `catalog.products.read` {view};
   - `catalog.content.propose` {execute};
   - `catalog.content.publish` {propose, approve, execute};
   - `governance.billing.manage` {view, execute}.

   The first-party Listings installation holds only:
   - `catalog.products.read` {view};
   - `catalog.content.propose` {execute};
   - `catalog.content.publish` {propose}.

   No agent ever holds `approve` or `execute` on `catalog.content.publish`. The claimant of every apply is a human.
4. **Shopify access.**
   - One custom-distribution app per beta store, non-embedded, using the authorization code grant.
   - Expiring offline tokens (`expiring=1`), so a later public app needs no rewrite.
   - Admin GraphQL `2026-10`, with scopes `read_products` and `write_products` only.
   - Webhooks `app/uninstalled`, `app/scopes_update`, `customers/data_request`, `customers/redact` and `shop/redact`; no product topics.
   - Per-app URL paths keyed by a Morrow app key. All app secrets in one broker secret, `SHOPIFY_APP_CREDENTIALS`, which holds about 30 apps.
   - Development stores only until M6.
5. **Linking rule for the beta.**
   - Workspace-first only. Morrow shows a store's install link only after the workspace's route is fixed to `morrow_direct`. The link transaction refuses any other production workspace.
   - An install that matches no registered app and invited workspace creates nothing.
   - Shopify-route workspaces therefore cannot arise in the beta. That matters because a custom app cannot be billed through Shopify, so such a workspace could never pay.
   - In development and staging, a workspace with an accepted `TestEntitlementSeed` naming the store may link.
6. **Connector hostname.** The connector Worker gets its own public hostname: a workers.dev name on staging and a custom subdomain in production. `__Host-` session cookies never reach it. The broker and orchestrator stay unrouted. This amends ADR-0007 item 1 and ADR-0019 item 2, and needs a staging card change.
7. **Broker trust model v1 and credential custody** (development and staging; production needs the ADR-0007 item 9 decision):
   - **Entrypoints.** One `WorkerEntrypoint` per caller (`ApiBroker`, `ConnectorBroker`, `RuntimeBroker`), each exposing only its methods.
   - **Lease check.** Every Shopify and model call names a live work lease, which the broker verifies in the database.
   - **Writes.** A Shopify write runs only for an OperationLedger operation in `dispatching`. Its input is loaded from the claimed proposal's parameters, never from the caller. Admin GraphQL documents are fixed in broker source.
   - **Vault.** Offline and refresh tokens use AES-256-GCM, with a per-record data key wrapped by a versioned KEK held only in broker secrets. The AAD is (environment, organization, installation, provider, credential version). The owner keeps an offline KEK backup.
   - **Refresh and destruction.** Refresh is single-flight per credential version. A retired version is destroyed once its successor works. Every version is destroyed at uninstall or disconnect.
   - **Credentials admitted.** The broker admits the Shopify app secrets and offline tokens, `OPENAI_API_KEY`, `STRIPE_RESTRICTED_KEY` and `STRIPE_WEBHOOK_SECRET`.
8. **Database roles.** Three membership-free executor logins, on the P05 pattern:
   - `morrow_connector_ingress` and `morrow_runtime_executor`, leased by `neonLease` to the connector and orchestrator;
   - `morrow_vault_broker`, the broker's own login, never leased.

   Each gets EXECUTE on its own definers only, and its guards call `executor_memberships_closed(session_user)`. The ADR-0020 closed set and owner roles are unchanged; new schemas are owned by `morrow_work_owner`.
9. **Tenancy for background work.**
   - `morrow_work.current_tenant()` resolves either the session digest (unchanged) or a work lease entered through `morrow_work.enter_lease(lease_id, generation)`.
   - Only api commands create leases, inside the session transaction that authorised the work. Their lifetimes are: read 60 s, run 30 min, operation 15 min.
   - A lease is a tenant selector and fencing generation, never authority; the policy kernel reruns at every step.
   - **Accepted residual risk:** a compromised orchestrator could act within the live leases of any tenant until they expire. This is the background analogue of the ADR-0010 item 2 residual.
10. **OpenAI usage.**
    - **Endpoint and model.** The Responses API with `default_model` from `model-policy.json` only, for both the Coordinator and the Listings specialist.
    - **Disabled features.** No escalation model, images, tools, Files, vector stores or background mode, and no fallback.
    - **Storage and region.** `store:false`, with default (non-regional) processing. There is no zero-data-retention agreement for the beta, so OpenAI's abuse-monitoring retention of up to 30 days applies. It is disclosed in the privacy policy and the sub-processor list.
    - **Data sent.** The merchant's request text, the store name and the selected products' catalogue fields. Never customer data, staff emails, credentials or payment data.
    - **Projects.** Separate staging and production projects, each with a hard monthly budget set by the owner.

    This decides the plan's pending "model data allowance" for public catalogue and merchant business data.
11. **Credits and spend limits.**
    - **Credits.** One credit per product drafted. A run reserves its product count and settles at the products actually drafted. Applying costs no credits but needs an active entitlement.
    - **Run limits.** At most 50 products per run and 25 per proposal.
    - **Vendor-cost caps** (owner-adjustable configuration): 30,000 input and 8,000 output tokens per call; US$2 per run; US$10 per workspace per day; a platform breaker at US$25 per hour, which stops new runs.
    - **Beta plan (recommended):** US$49 a month with 300 credits. The owner may change both numbers without changing the design.
12. **Stripe objects.**
    - **Mode.** Test mode now. Live mode only after M6 activation, under per-action approval.
    - **Catalogue.** One Product and one monthly USD Price for the beta plan.
    - **Customers.** One Customer per workspace, created by the broker with an idempotency key before checkout.
    - **Checkout.** Subscription-mode Checkout Sessions on that customer.
    - **Billing Portal.** Payment method, invoices and cancellation at period end; no plan switching.
    - **Webhook events:** `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed`.
    - **Restricted key:** write on Customers, Checkout Sessions and Billing Portal sessions; read on Subscriptions, Invoices, Prices, Products, Charges and Disputes.
    - **Tax.** Stripe Tax is switched on at live activation, with registrations.
    - **Not used:** Payment Links, Pricing Tables, coupons, trials and top-ups.
13. **Retention of new data.**

    | Data | Retention |
    | --- | --- |
    | Product snapshots | 90 days; deleted at `shop/redact` |
    | Drafted values in proposal parameters | Until `shop/redact`, which redacts the bytes and keeps the digest |
    | Minimised webhook bodies | 7 days |
    | OAuth states | 7 days |
    | Privacy-request evidence, run manifests, usage, leases and operation transitions | 365 days, content-free |
    | Vault credentials | Destroyed at uninstall or disconnect |
    | Model prompts and raw outputs | Not stored |
    | Stripe payment records | Ids and amounts only, kept for the financial-records period; the default is 7 years until the tax advisor confirms |
14. **Compliance topics on custom apps.**
    - The three compliance topics are subscribed and completed even though Shopify requires them only of public apps.
    - `customers/data_request` and `customers/redact` record "no customer data held", with evidence.
    - `shop/redact` targets completion within 24 hours, with a 30-day maximum.
    - `app/uninstalled` takes effect at once.
    - No non-development store links before this path passes its tests.

## Consequences

- M2–M5 may start engineering on acceptance, in the order of spine §13. Every provider effect still needs per-action approval or a staging card. That covers the Shopify app deploy and development-store install, the connector hostname, OpenAI calls, and Stripe test-mode objects.
- `providers.json` (Shopify test-account plan and distribution), `model-policy.json` (`private_content_dispatch` for catalogue data) and `data-lifecycle.md` gain the rows above in the PRs that implement them.
- Before M6: an ADR for production credential custody (ADR-0007 item 9), Shopify's written answer on charging custom-distribution installs and on revenue share (ADR-0015 Risk 2), and the tax advisor's retention period.
- Moving to public distribution later means a new app, which merchants install and Morrow links as a new installation generation. The registry, vault and linking records already allow it.

## Alternatives considered

- **A new `catalog.product.update` capability.** It would duplicate `catalog.content.publish`.
- **An unlisted public app.** It needs App Review and Shopify billing (requirement 1.2), which conflicts with the Stripe beta the owner chose.
- **Routing Shopify traffic through the api origin.** It keeps one public Worker, but the session cookie would travel with connector requests.
- **Letting the broker trust its callers for merchant writes (v0 style).** A faulty or compromised orchestrator could then write arbitrary product content.
- **New per-Worker logins with SET memberships (ADR-0010 style).** These would need a change to the ADR-0020 closed set. Membership-free executors avoid it.
- **Non-expiring offline tokens.** Simpler now, but a rewrite for public distribution.

## Approval

Pending. The owner may approve all items as recommended in one answer, or name items to change.
