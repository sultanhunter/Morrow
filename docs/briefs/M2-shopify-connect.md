# M2 Shopify connect

- Status: brief, 2026-10-19. Spine: [mvp-architecture.md](mvp-architecture.md) §3–§6, §10–§11. Material choices: ADR-0022 items 4–9, 13 and 14 (Proposed).
- Plan IDs: P08.T01a, P08.T02a, P09.T01a, P09.T02a, P09.T05a, closing the P05.T03 linking path. Branch `claude/m2-shopify-connect`; three PRs.

## Goal

A paid beta workspace connects one Shopify development store through its private install link. Morrow holds the offline token in the broker vault, links the store to the workspace through the existing P05.T03 handoff, reads products, and handles uninstall and the compliance topics before any real store connects.

## Scope

- **PR-1, spine foundation** (spine §13): `work_leases`, `stop_controls`, `workspace_billing_routes`, `morrow_vault.credentials`; the `enter_lease` definer and the `current_tenant()` replacement; the executor logins `morrow_connector_ingress`, `morrow_runtime_executor`, `morrow_vault_broker`; `ConnectorBroker` and `RuntimeBroker` entrypoints; vault envelope encryption; the redaction-handler list.
- **PR-2, install and link:** the connector Worker (`apps/shopify-connector/worker/index.ts`) with `/shopify/a/:appKey/launch`, `/callback`, `/webhooks` and `/status`; `shopify_apps`, `shopify_oauth_states`, `store_installations`, `install_continuations`; the P09.T02a issuer in the store-link preview route; the connections screens.
- **PR-3, reads, uninstall and privacy:** `shopifyRead` (`shopIdentity`, `collectionsPage`, `productsPage`, `productContent`); the webhook inbox and its Queue consumer; `app/uninstalled`, `app/scopes_update`, `customers/data_request`, `customers/redact`, `shop/redact`; `privacy_requests`; human disconnect through `governance.connection.disconnect`.

## Non-goals

Install-first and Shopify-route workspaces (refused, ADR-0022 item 5); public distribution and App Pricing; an embedded app; product webhooks and a synced catalogue (P09.T03); multi-store; reconnect beyond reinstalling the same app.

## Interfaces and data touched

- **Reused:** `linking_candidates`, `linking_reviews`, `linking_handoffs`, `workspace_store_links` and `link_workspace_store` (migration 0005); `createWorkspaceStoreLinks`, `createStandaloneStoreLinking` and the routes `POST /workspace/:ws/store-links/preview`, `POST /workspace/:ws/store-links`, `POST /workspace/:ws/store-links/status` (P05.T03b); `governance.connection.connect` (`administer`) and `governance.connection.disconnect` (`KillSwitchControl`) from the catalogue; `StoreInstallation@1`, `ConnectorContext@1`; `ApiBrokerRpc` style in `packages/identity/src/broker-protocol.ts`.
- **Forward migration:** `linking_candidates.proof_kind` and `linking_reviews.evidence_kind` admit `shopify_oauth`; the identity tables of spine §6.
- **New api routes:** `GET /workspace/:ws/connections` (installation status from `store_installations`), `GET /workspace/:ws/stores/:storeId/catalog/collections`, `GET /workspace/:ws/stores/:storeId/catalog/products?collectionId=&query=&after=` (kernel: `view` on `catalog.products.read`; a `read` lease per call), `POST /workspace/:ws/connections/:connectionId/disconnect`.
- **Screens:** `/w/:ws/connections` and `/w/:ws/connections/:connectionId` (route ids `connections`, `connection`): install link when ready, status, scopes, disconnect. The continuation lands on `/w/:ws/connections#handoff=<token>`; the SPA strips the fragment at once and posts the token to preview.

## Flows

1. **App registration (owner-run).** Claude prepares a `shopify.app.<appKey>.toml` per beta store: non-embedded, scopes `read_products,write_products`, the per-app URLs, compliance topics. The owner deploys it with the Shopify CLI, generates the custom-distribution link for the store, adds the secret to `SHOPIFY_APP_CREDENTIALS`, and runs an audited script that inserts the `shopify_apps` row (app key, client id, shop domain, invited workspace). The link is shown only once the workspace's route is `morrow_direct` (production) or it holds a seed naming the store (staging).
2. **Launch.** Shopify opens `/shopify/a/:appKey/launch`. Broker `shopifyLaunchVerify` checks the query HMAC and the shop domain against `*.myshopify.com` and the registry. The connector stores a state digest (10 min, single use), sets a `__Host-` state cookie on its own host and redirects to Shopify's authorize URL.
3. **Callback.** `/callback` matches the cookie to the state row, then calls `shopifyInstallComplete`: HMAC, code exchange with `expiring=1`, vault write, `shopIdentity` read. The connector writes the candidate (`proof_kind: shopify_oauth`), the `store_installations` row and a continuation bound to the installation and the invited workspace, then redirects to the api origin with the token in the fragment.
4. **Link.** The signed-in owner's SPA posts `{handoffToken}` to preview. The issuer checks the continuation, the app's invited workspace equals `:ws`, a current `governance.connection.connect` `administer` grant, and the billing rule of ADR-0022 item 5. It then writes the review and handoff rows bound to this session. Apply is the unchanged `link_workspace_store`, which also sets `shopify_bound_at` under the route-row lock.
5. **Uninstall.** The `app/uninstalled` webhook marks the installation `uninstalled`, calls `shopifyCredentialDestroy`, sets a connection stop, revokes leases and cancels operations that were never submitted.
6. **Redaction.** `shop/redact` runs every registered redaction handler for the store; `customers/*` record "no customer data held". Each completes with evidence in `privacy_requests`.

## Security notes

- **Broker-only credentials (invariant 11):** the connector binds no Shopify secret (ADR-0008 item 2); tokens exist decrypted only inside the broker; nothing returns a token.
- **Connector context is not a session (invariant 23):** the connector has its own host, so `__Host-morrow_session` never reaches it; linking still needs the human session and grant on the api.
- **Server-resolved tenancy (invariant 1):** the workspace comes from the app registry and the session, never from `shop`, `host` or a query value. Email equality grants nothing.
- **Webhooks:** raw-body HMAC before any parse, 401 with no state change on failure, durable insert before 200, never assume ordering.
- **Deletion before data (invariant 16):** PR-3 and its labs pass before any non-development store is linked.
- **Default deny (invariant 3):** an unknown app key, an unregistered shop or a missing configuration returns the existing fail-closed response.
- **Database:** `npm run smoke:scaffold` keeps the "unconfigured connector fails closed" guard. Every new table is registered in the tenant-conformance registry; the forged lease-context probe is added to the harness.

## Test checklist

- [ ] Vault: AES-256-GCM round trip; wrong AAD, KEK version or environment fails; ciphertext never logged (redaction tests).
- [ ] Launch and callback: bad HMAC, foreign shop, replayed or expired state, missing cookie, unknown app key → no candidate, no token.
- [ ] Link: wrong workspace, missing grant, unpaid workspace in production, replayed continuation, two workspaces racing → one link at most (P05.T03a lab cases rerun with `shopify_oauth`).
- [ ] Lease context: forged GUC, expired or revoked lease, removed member → zero rows.
- [ ] Webhooks: duplicate id → one row; bad HMAC → 401 and no row; uninstall destroys the credential and revokes leases.
- [ ] `shop/redact` empties snapshots and redacts parameters for that store only (fixtures for M3 tables).
- [ ] One workerd plus PostgreSQL 17 end-to-end lab path with a recorded Shopify fixture; zero real provider calls in CI.
- [ ] Development-store smoke under owner approval, recorded in `docs/evidence/live/`.

## Owner actions

1. Shopify Partner account; a fresh development store (never the live shop).
2. Approve ADR-0022 items 4–9, 13 and 14.
3. Per-action approval or a new staging card for the connector's workers.dev hostname, the app deploy and the development-store install.
4. Generate the vault KEK with the provided script, keep the offline copy, and place it with `morrow_put`; place the app secret the same way.

## Open questions

- Is one custom-distribution app per beta store acceptable operationally (about 15 minutes of owner time per merchant; `SHOPIFY_APP_CREDENTIALS` fits about 30 apps)?
