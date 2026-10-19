# M2 Shopify connect

- Status: brief, 2026-10-19 (revised after critique). Spine: [mvp-architecture.md](mvp-architecture.md) §3–§6, §10–§11. Material choices: ADR-0022 items 2–9, 13–15 (Proposed).
- Plan IDs: P08.T01a, P08.T02a, P09.T01a, P09.T02a, P09.T05a, closing the P05.T03 linking path. Branch `claude/m2-shopify-connect`; three PRs.

## Goal

A paid beta workspace connects one Shopify development store through its private install link. Morrow holds the offline token in the broker vault, links the store through the existing P05.T03 handoff, grants the owner store-level catalogue permissions, reads products, and handles uninstall and the compliance topics before any real store connects.

## Scope

- **PR-1, spine foundation** (spine §13): `work_leases`, `stop_controls`, `stop_records`, `operations` and `operation_transitions` (general, claim columns nullable), `workspace_billing_routes`, `morrow_vault.credentials` and `app_secrets`; `enter_lease`, `current_lease()` and `pending_starts()`; the three executor logins; `ConnectorBroker` and `RuntimeBroker`; vault envelope encryption and the app-secret script; the redaction-handler list.
- **PR-2, install and link:** the connector Worker (`apps/shopify-connector/worker/index.ts`) with `/shopify/a/:appKey/launch`, `/callback`, `/webhooks` and `/status`; `shopify_apps`, `shopify_oauth_states`, `store_installations`, `install_continuations`; the P09.T02a issuer in the store-link preview route; the store-link grant template in the link transaction; the connections screens.
- **PR-3, reads, uninstall and privacy:** `shopifyRead` (`shopIdentity`, `collectionsPage`, `productsPage`, `productContent`); the webhook inbox and its Queue consumer; `app/uninstalled`, `app/scopes_update`, `customers/data_request`, `customers/redact`, `shop/redact`; `privacy_requests`; human disconnect through `governance.connection.disconnect`.

## Non-goals

Install-first and Shopify-route workspaces (refused, ADR-0022 item 5); public distribution, App Pricing and expiring tokens; an embedded app; product webhooks and a synced catalogue (P09.T03); multi-store.

## Interfaces and data touched

- **Reused:** `linking_candidates`, `linking_reviews`, `linking_handoffs`, `workspace_store_links`, `link_workspace_store` (0005); `createWorkspaceStoreLinks`, `createStandaloneStoreLinking` and `POST /workspace/:ws/store-links/{preview,status}`, `POST /workspace/:ws/store-links` (P05.T03b); `governance.connection.connect` (`administer`) and `governance.connection.disconnect` (`KillSwitchControl`); `StoreInstallation@1`, `ConnectorContext@1`; the `ApiBrokerRpc` style in `packages/identity/src/broker-protocol.ts`.
- **Forward migrations:** `proof_kind` and `evidence_kind` admit `shopify_oauth`; `link_workspace_store` also applies the store-link template on the store resource (`catalog.products.read` {view, delegate}, `catalog.content.propose` {execute, delegate}, `catalog.content.publish` {propose, approve, execute, delegate}, `agents.installation.activate` {execute}); signup template v2 adds `governance.billing.manage` with a backfill; the tables of spine §6.
- **New api routes:** `GET /workspace/:ws/connections`; `GET /workspace/:ws/stores/:storeId/catalog/collections`; `GET /workspace/:ws/stores/:storeId/catalog/products?collectionId=&query=&after=` (kernel: `view` on `catalog.products.read`, store resource; a `read` lease per call); `POST /workspace/:ws/connections/:connectionId/disconnect`.
- **Screens:** `/w/:ws/connections` and `/w/:ws/connections/:connectionId`: install link when ready, status (including "reinstall needed"), scopes, disconnect. The continuation lands on `/w/:ws/connections#handoff=<token>`; the SPA strips the fragment at once and posts the token to preview.

## Flows

1. **App registration (owner-run).** Claude prepares `shopify.app.<appKey>.toml` per beta store: `embedded = false`; `[access_scopes] scopes = "read_products,write_products"` with an explicit install-flow setting; `[auth] redirect_urls = ["https://<connector>/shopify/a/<appKey>/callback"]`; `application_url` the launch path; `[[webhooks.subscriptions]]` for the five topics, with `compliance_topics`. The owner deploys it with the Shopify CLI, picks custom distribution and generates the link in the Dev Dashboard, stores the client secret with the vault script, and runs an audited script that inserts the `shopify_apps` row. The first install from the custom link is proven on the development store before PR-2 closes.
2. **Launch.** Shopify opens `/shopify/a/:appKey/launch`. `shopifyLaunchVerify` checks the query HMAC and the shop against `*.myshopify.com` and the registry. With an active installation, the connector shows status and links to Morrow; there is no new OAuth. Otherwise it stores a state digest (10 min, single use), sets a `__Host-` state cookie on its own host and redirects to Shopify's authorize URL.
3. **Callback.** The cookie must match the state row. `shopifyInstallComplete` checks the HMAC, exchanges the code (non-expiring offline token), compares expanded scopes, writes the vault and reads `shopIdentity`. A first install writes the candidate (`proof_kind: shopify_oauth`), the `store_installations` row and a continuation for the invited workspace, then redirects to the api origin with the token in the fragment. A callback for an existing installation re-authorises that row (a new credential version, the old one destroyed) and creates no candidate.
4. **Link.** The signed-in owner's SPA posts `{handoffToken}` to preview. The issuer checks the continuation, that the app's invited workspace equals `:ws`, a current `governance.connection.connect` `administer` grant, and that the route is `morrow_direct`. Apply is `link_workspace_store`, which sets `shopify_bound_at` under the route-row lock and issues the store-link grants.
5. **Uninstall.** The `app/uninstalled` webhook marks the installation `uninstalled`, calls `shopifyCredentialDestroy`, writes a connection stop (`StopRecord@1`, actor `system`) and revokes leases. Unsent operations become `conflict` at their dispatch check.
6. **Redaction.** `shop/redact` runs every registered handler for the store. `customers/*` record "no customer data held". Each completes with evidence in `privacy_requests`.

## Security notes

- **Broker-only credentials (invariant 11):** the connector binds no Shopify secret (ADR-0008 item 2). App secrets and tokens are decrypted only inside the broker, one vault row each, so one rotation touches one row.
- **Connector context is not a session:** the connector has its own host, so `__Host-morrow_session` never reaches it; linking still needs the human session and grant on the api.
- **Server-resolved tenancy (invariant 1):** the workspace comes from the app registry and the session, never from `shop`, `host` or a query value.
- **Webhooks:** raw-body HMAC before any parse; 401 with no state change on failure; `customers/*` bodies minimised before the insert; durable insert before the 200, within a 3-second budget (otherwise a 5xx, and Shopify's retry is de-duplicated by webhook id); never assume ordering.
- **Deletion before data (invariant 16):** PR-3 and its labs pass before any non-development store links.
- **Default deny (invariant 3):** an unknown app key, an unregistered shop or a missing configuration returns the existing fail-closed response; `npm run smoke:scaffold` keeps the "unconfigured connector fails closed" guard.
- **Database:** every new table is in the tenant-conformance registry, with the two lease probes of spine §5.

## Test checklist

- [ ] Vault: AES-256-GCM round trip; wrong AAD, KEK version or environment fails; ciphertext never logged; rotating one app secret leaves the others working.
- [ ] Launch and callback: bad HMAC, foreign shop, replayed or expired state, missing cookie, unknown app key → no candidate, no token; launch with an active installation → no OAuth; re-authorisation → one installation, new credential version.
- [ ] Scopes: `write_products` alone satisfies `read_products`.
- [ ] Link: wrong workspace, missing grant, unpaid workspace, replayed continuation, two workspaces racing → one link at most (P05.T03a cases rerun with `shopify_oauth`); a link issues exactly the store-link grants.
- [ ] Lease context: forged setting, expired or revoked lease, removed member → zero rows; a lease context calling a session definer → refused.
- [ ] Webhooks: duplicate id → one row; bad HMAC → 401 and no row; `customers/*` fixtures store no email, phone or order id; a slow insert past the budget → 5xx; uninstall destroys the credential and revokes leases.
- [ ] `shop/redact` empties snapshots, drafts and parameters for that store only.
- [ ] One workerd plus PostgreSQL 17 end-to-end lab with recorded Shopify fixtures; zero real provider calls in CI.
- [ ] Development-store smoke under owner approval, recorded in `docs/evidence/live/`.

## Owner actions

1. A Shopify Partner organisation and a fresh development store (never the live shop).
2. Approve ADR-0022.
3. Per-action approval, or a new staging card, for the connector's workers.dev hostname, each app deploy and the development-store install.
4. Generate the vault KEK with the provided script, keep the offline copy, and place it with `morrow_put`; store each app's client secret with the vault script.
5. For the smoke: pay for the staging workspace in Stripe test mode (after M5 PR-1).

## Open questions

- Is one custom-distribution app per beta store acceptable operationally (about 15 minutes of owner time per merchant)?
