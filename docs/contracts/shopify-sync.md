# Shopify projection and reconciliation

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P09.

## Shape and ownership

Schemas: StoreInstallation, SnapshotRef, Evidence. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Pin the Admin GraphQL version after P01.T03 qualification. Authenticate Shopify entry using supported server flows. Minimum/optional scopes are feature-specific. Bulk bootstrap tracks checkpoints while webhooks persist into a deduplicated inbox; verify raw-body signature first. No webhook delivery/order assumption: reconcile authoritative reads and maintain tombstones. Order-age and protected-data gaps remain coverage rather than invented facts. Refresh races serialize per credential version.

## Failure invariant

Late update cannot resurrect a deleted product; scope changes block affected reads/writes immediately. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.

## MVP connector protocol (M2 PR-2; ADR-0022 items 4-6; ADR-0008 as amended 2026-10-20)

One custom-distribution app per beta development store, registered in `morrow_identity.shopify_apps` (app key, public client id, the SHA-256 digest of the intended `*.myshopify.com` domain, the invited workspace, the install link). The connector Worker (`apps/shopify-connector/worker/`) runs on its own hostname, binds only `MORROW_ENVIRONMENT`, the reviewed identifiers and the broker's `ConnectorBroker` entrypoint, and holds no secret or Shopify library. Without its identifiers it is 503 on every path.

- **Launch** `GET /shopify/a/:appKey/launch`: `ConnectorBroker.shopifyLaunchVerify` checks the query HMAC (sorted, form-encoded parameters without `hmac` and `signature`, constant-time compare, timestamp window) with the app secret from the vault and the shop against the registry digest. A linked installation shows a status page and starts no OAuth. Otherwise the connector opens one OAuth state as `morrow_connector_ingress` (`connector_oauth_state_open`: the digest only, 10 minutes, single use, at most 10 open per app), sets `__Host-morrow_shopify_state` (Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age=600) and redirects to `https://<verified shop>/admin/oauth/authorize` with the client id, the fixed scopes `read_products,write_products`, the exact callback `redirect_uri` and the state, and no per-user option (an offline token).
- **Callback** `GET /shopify/a/:appKey/callback`: the cookie must equal the query's state before any broker call; the cookie is always cleared. `ConnectorBroker.shopifyInstallComplete` then, in order: claims the state (committed alone, so a replay or an expired state never reaches Shopify); checks the HMAC and that the shop is the claimed one; exchanges the code once (`POST https://<shop>/admin/oauth/access_token`; a lost reply is `exchange_uncertain`, never retried); requires the expanded granted scopes to equal the requested ones exactly (`write_products` implies `read_products`; an extra scope is refused); reads the one fixed `ShopIdentity` document (Admin API 2026-10) and refuses a store that is not a Partner development store; then, in one transaction on the vault login, seals the token (AES-256-GCM; the additional data binds environment, tenant, credential, subject = installation, version and KEK version), stores the credential version (a re-authorisation destroys the previous one) and, through identity bridges, the installation, the `shopify_oauth` linking candidate (first install only) and a 5-minute install continuation whose digest only is stored. A lost COMMIT acknowledgement is `outcome_unknown`; the merchant relaunches. The merchant lands on `https://<api>/w/<invited workspace>/connections#handoff=<continuation>`; the fragment never reaches a server.
- **Status** `GET /shopify/a/:appKey/status`: a Shopify-signed GET; a status page with no workspace data.
- **Webhooks** `POST /shopify/a/:appKey/webhooks`: the raw body (at most 256 KiB) and the selected `X-Shopify-*` headers go to `ConnectorBroker.shopifyWebhookVerify`, which checks the base64 HMAC over the raw bytes before any parse and the topic allowlist. A bad signature is 401 with no state change; a verified delivery is 503 until M2 PR-3 adds the durable inbox (the generated app TOML subscribes no topic before then).

All provider calls in CI go to the synthetic oracle (`scripts/fixtures/shopify-oracle.mjs`); `lab:shopify-install` and `lab:shopify-connect-workers` cover the protocol against PostgreSQL 17.

