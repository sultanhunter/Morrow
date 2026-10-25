# Shopify: shop-specific uninstall and scope-change webhooks

- Status: built, 2026-10-25. Branch `claude/shopify-shop-specific-webhooks`. Change class: routine under ADR-0022 item 4. The same five topics go to the same signed path; only the way two of them are subscribed changes. The review uses the security lens: it touches a provider adapter, the broker's token custody, two migrations and a new vault login use.
- Found while releasing the live-store app (v1 PR 1, `docs/briefs/v1-connect-store.md`). Shopify CLI 4.9.4 refuses the generated configuration: "App-specific webhook subscriptions are not supported when use_legacy_install_flow is enabled." It also no longer supports `build.include_config_on_deploy`. The connector uses the legacy install flow: its own authorization-code OAuth with `/shopify/a/<app-key>/callback`. The released live configuration (v2) already carries only the compliance topics.

## Goal

Morrow must still learn when a store uninstalls the app or changes its scopes. The three compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`) stay app-specific in the TOML, which the CLI accepts. `app/uninstalled` and `app/scopes_update` become shop-specific subscriptions. The broker, the only holder of each store's offline token, creates them through the Admin API, idempotently, for every active installation. The owner's store is installed before this merges, so an installation that already exists must get them too.

## Design: the smallest safe one

- **The broker creates them.** The token never leaves the broker (security invariant), so no other Worker, script or operator can call Shopify for the store.
- **Two triggers, both existing paths.**
  - The connector's callback asks once after a successful install or re-authorisation. This runs in `waitUntil`, after the redirect, so the install never waits for it and never depends on it.
  - The connector's five-minute cron (M2 PR-3's re-drive, already deployed) asks again on every run. This is the catch-up for existing installations, the owner's included, and the retry for failed or unknown attempts.
  - Main has no reconnect-after-scope-change path: a scope change suspends the installation, a terminal state in this release. A re-authorisation adds a credential version, so its installation is pending again and the sync lists with the new token.
- **No operator command.** The broker has no public route. Its entrypoints are service bindings, so a local `npm run` command could not reach it without a new public surface. A command that held the token itself would break custody. The cron covers the catch-up within five minutes of the deploy and migration.
- **A small record, so failures can be retried with a backoff.** `morrow_identity.shopify_webhook_registrations` holds one row per installation. Each row has the closed outcome for the credential version used and, once registered, Shopify's two subscription ids. It holds ids, codes, counts and times only. Without it, a failing store would be retried on every run with no backoff and no closed status.
- **Rejected alternatives.**
  - Calling Shopify inside the install transaction: the install has a 9-second budget, and a Shopify fault would fail the install.
  - A cron with no record: no status, no backoff, and a Shopify list on every run for every store.
  - An operator command: see above.

## Scope

1. **Generator** (`scripts/shopify-app.mjs`): emits only the compliance subscription (one `[[webhooks.subscriptions]]` with `compliance_topics`) and no `include_config_on_deploy`. The scopes, URLs, `use_legacy_install_flow`, `api_version = "2026-10"` and `automatically_update_urls_on_dev = false` are unchanged. `tests/shopify-app-script.test.mjs` pins it.
2. **Broker** (`apps/broker/src/shopify-webhooks.ts`; `ConnectorBroker.shopifyWebhookSubscriptionsSync(budgetMs)`; held as `WEBHOOKS_UNAVAILABLE` without the vault or the connector's origin, and `WEBHOOKS_BUSY` while this isolate's one sync runs):
   1. One vault transaction, committed alone: the pending ids, at most 10. These are active installations of an active app whose current credential version has no registered row. A missing row or an older version comes first. A failed, unknown or unauthorized outcome waits 4 minutes per consecutive attempt, at most 6 hours.
   2. Per installation, while at least 4 s of the budget is left:
      - One vault transaction: the target (its tenant, app key and shop from the installation row) and the active envelope of its current version, opened with the KEK.
      - The callback URL, built only from the broker's reviewed `CONNECTOR_CONFIGURATION_JSON` origin and the app key: `<connector origin>/shopify/a/<appKey>/webhooks`. This is the connector's signed path, the same one the TOML's compliance subscription uses. `edge:check` holds the broker's copy byte-equal to the connector's.
      - One fixed list: `webhookSubscriptions(first: 25, topics: [APP_UNINSTALLED, APP_SCOPES_UPDATE]) { nodes { id topic uri } pageInfo { hasNextPage } }`. It takes no variables.
      - For each topic still missing, one fixed `webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri })`. Its only variables are the enum value and that URL. It runs in API version 2026-10 (the request URL), which equals the TOML's webhooks `api_version` (pinned by a test).
      - One vault transaction: the closed outcome for that version.
3. **Outcome mapping** (closed; the token, the shop and Shopify's text never leave):

   | Shopify's reply | Outcome |
   | --- | --- |
   | Both found with exactly our `uri` | `registered` with the two ids, no create |
   | List: 401 | `unauthorized`, no create |
   | List: 429, 5xx, timeout, other status, GraphQL error, malformed, oversize, or a partial page without ours | `failed`, no create (absence not proven) |
   | Create proven not run: 429, THROTTLED twice, ACCESS_DENIED, no time left | `failed`, no reconciling list needed |
   | Create: 401 | `unauthorized` |
   | Create: `userErrors` (for example the address already taken by a concurrent sync) | reconciled by the same list at once: `registered` when both now show, otherwise `failed` |
   | Create unproven: lost reply, timeout, 5xx, other status or GraphQL error, malformed, or a reply naming another topic or URL | reconciled by the same list before anything else: `registered` when both show; `failed` when it shows the create, or a complete page proves it absent; `unknown` when the list fails or is partial without it |

   - An unknown outcome is never promoted. Every later round lists before it creates, so an unknown create is always reconciled by a list before any retry. Shopify also refuses a second subscription of the same topic and address.
   - Nothing is ever updated or deleted. A subscription with another URI (another app path, Pub/Sub, EventBridge, a near-miss URL) is left as it is.
   - A target that is gone is skipped. A target whose token cannot be used (no active envelope for its version, a malformed row, an envelope that does not open) sends nothing and is recorded `failed`, so it waits for its backoff instead of heading every list.
   - A record that is stale (a newer token, or the installation ended) or whose commit is unknown counts as `skipped`, and the installation stays pending.
4. **Connector** (`apps/shopify-connector/worker/connector.ts`):
   - After an `installed` or `reauthorised` callback it calls `waitUntil(sync(15 s))`. Each cron run then calls `sync(20 s)` when the run still has that budget plus 2 s of slack.
   - Each sync logs one fixed-code `morrow_connector_webhooks` line with the counts, or `SUBSCRIPTIONS_UNAVAILABLE`. The re-drive's counts gain `subscriptionsChecked` and `subscriptionsRegistered`.
5. **Webhook receipt** (unchanged code, now pinned by a test): deliveries from both kinds of subscription arrive at `POST /shopify/a/:appKey/webhooks`.
   - The connector forwards the same five headers. Other delivery headers, such as triggered-at, event id or subscription id, are neither forwarded nor signed.
   - The broker verifies the app secret's base64 HMAC over the raw body before any parse, then the topic allowlist, then records the delivery. An app-specific and a shop-specific delivery of either topic produce the same record.
6. **Migrations** `0047.shopify-webhook-registrations-identity` (the identity owner) and `0048.shopify-webhook-registrations-vault` (the work owner), forward only:
   - The table: ENABLE and FORCE RLS with the identity owner's policy only. Its guard: born at revision 1, one revision per change, tenant and installation fixed, the version never moving back, no delete or truncate.
   - Three identity bridges for `morrow_work_command`, and three vault definers. The definers are owned by the work command, guarded first by `work_executor_safe('morrow_vault_broker')` and executable by the broker's login only.
   - None takes a tenant. The tenant always comes from the installation row.

## Interfaces touched

- Source: `apps/broker/src/{shopify-webhooks,capabilities,index,vault-statements-shopify}.ts`, `apps/broker/wrangler.jsonc` and `worker-configuration.d.ts` (the staging broker's `CONNECTOR_CONFIGURATION_JSON`), `apps/shopify-connector/worker/{connector,webhooks}.ts`, `packages/identity/src/broker-protocol.ts` (the RPC, the topic split, the origin parser, the callback URL, the closed sync result), `scripts/edge.mjs` (the broker var, byte-equal to the connector's), `scripts/shopify-app.mjs`.
- Migrations 0047 and 0048, `migrations/manifest.json`, `tests/tenant-conformance/registry.mjs`.
- Tests: `tests/broker-shopify-webhooks.test.mjs` (new), `tests/shopify-webhook-registrations-migrations.test.mjs` (new), `tests/{shopify-app-script,connector-worker,broker,broker-challenge,edge-config,projects-migrations,redaction-handlers}.test.mjs` (the pinned method list, init line, staging vars, last migration and identity-table count follow).
- Labs: `scripts/shopify-install-lab.mjs` (H1-H8), `scripts/shopify-connect-workers-lab.mjs` and `scripts/fixtures/shopify-connect-worker.ts` (H1-H2), `scripts/fixtures/shopify-oracle.mjs` (the two webhook documents).
- Docs: `docs/contracts/shopify-sync.md`, `docs/briefs/v1-connect-store.md` (item 3 and owner step 3), `docs/briefs/M2-shopify-connect.md` (the TOML rows amended).

## Security notes

- **Custody.** The token is opened only inside the broker, for the two fixed documents, and zeroed after use. The result crossing the binding is six counts. Nothing in the sync logs. Tests check that the token and the shop appear in no result, record or log.
- **No caller input reaches Shopify.** The RPC takes a budget only. The installations come from the vault login's own list. The URL comes from the broker's reviewed configuration and the registry's app key, never from a caller or a request. The GraphQL text is fixed, `redirect: "manual"`, and replies are bounded at 64 KiB for the list and 256 KiB for the create.
- **Tenancy.** The cross-tenant pending list returns ids only, to the broker's login only. The record's tenant comes from the installation row, and its composite foreign key ties the row to that installation. Other logins can read neither the table nor the definers (`lab:shopify-install` H1).
- **Retention.** A registration row holds ids, closed codes, counts and times, and lives as long as its installation row, with no delete, like `store_installations`. It holds no shop domain, URL, token or provider text, so `shop/redact` needs no new handler. The conformance registry classes the table `content: none`.
- **Store effect.** The only change on a store is the app's own two webhook subscriptions to Morrow's own path, which ADR-0022 item 4 already specifies. Nothing touches products, other apps' subscriptions or customer data. On the owner's store this runs under ADR-0035's standing approval (provider setup inside Morrow's own flow), not the exact-proposal approval for store content. Open question 1 asks the owner to confirm this reading.
- **Failure modes.**
  - Until the subscriptions exist, an uninstall or scope change is not delivered. `shop/redact` (app-specific, about 48 hours after an uninstall) still ends the installation first, and an `unauthorized` count in the cron line shows a revoked token.
  - A 401 is never treated as an uninstall, because the webhook is the state change.
  - The cron sync is bounded: at most 10 ids per run and 20 s, about four stores per run. New installs are covered at once by the callback.

## After the merge (Claude, standing approval; one activity-log line each)

1. `npm run staging:migrate` (ledger 48).
2. Deploy, with the broker's new `CONNECTOR_CONFIGURATION_JSON` var. The migration goes first: a sync before it answers `SUBSCRIPTIONS_UNAVAILABLE` and changes nothing.
3. Within five minutes, the connector's cron line `morrow_connector_webhooks` should show `SUBSCRIPTIONS_SYNCED` with `registered: 1` for the owner's store. A later run shows `checked: 0`. Record it in the activity log (counts only, no shop).
4. No owner action is needed. The owner never redeploys the TOML for this: v2 is already compliance-only.

## Test checklist

- [x] Generator: compliance topics only, no `include_config_on_deploy`, the webhooks `api_version` equal to the broker's pinned version (`tests/shopify-app-script.test.mjs`).
- [x] Broker, with recorded GraphQL shapes (`tests/broker-shopify-webhooks.test.mjs`):
  - the two fixed documents (`uri`, no `endpoint` or `callbackUrl`), and every request a POST to the store's Admin GraphQL 2026-10 with the token header and `redirect: "manual"`;
  - only missing topics created; other subscriptions untouched; idempotent;
  - the list's 401, 429, 5xx, 302, timeout, GraphQL error, non-JSON, oversize, malformed node and partial page; THROTTLED once;
  - the create's 429, THROTTLED twice, ACCESS_DENIED, no time and 401; `userErrors` from a concurrent create; lost replies (5xx after creating, timeouts, a lost connection, malformed, 404, another uri or topic) reconciled by listing; `unknown` only when that list fails or is partial;
  - the sync's transaction order (the pending ids alone, the target before any request, the record after);
  - each installation's own app path; a gone target skipped; an unusable token recorded failed;
  - stale and unknown records skipped;
  - the budget's closed range, `WEBHOOKS_UNAVAILABLE` (no or bad connector configuration, no vault) and `WEBHOOKS_BUSY`;
  - a malformed pending list held;
  - the per-installation time floor;
  - the protocol's origin parser equal to the connector's, and the callback URL and closed counts;
  - receipt of both topics, app-specific or shop-specific, on one path with one verification.
- [x] Migrations (`tests/shopify-webhook-registrations-migrations.test.mjs`): the runner contract, FORCE RLS and the guard, content-free columns, grants and guards, and the constants shared with TypeScript.
- [x] Connector (`tests/connector-worker.test.mjs`):
  - the sync after `installed` and `reauthorised` only, after the response; a hung, held or garbled sync never touches the redirect;
  - the cron's counts, its unavailable count, and no sync without its whole budget;
  - both budgets inside the broker's range and inside `waitUntil`'s 30 s.
- [x] Entrypoint and configuration: `ConnectorBroker` gains exactly the one method with its arity check (`tests/broker.test.mjs`). The staging broker's `CONNECTOR_CONFIGURATION_JSON` is required, staging only and byte-equal to the connector's, and the connector's hostname is admitted in that var only (`tests/edge-config.test.mjs`).
- [x] `lab:shopify-install` H1-H8 (PostgreSQL 17, createrole administrator):
  - only the broker lists, reads targets and records;
  - the target's tenant, app, shop and current envelope;
  - the real sync registers both stores against the oracle, leaving another path's subscription alone;
  - idempotent; the record's closed inputs and current version only;
  - a failure's backoff, then registered again without a create;
  - a re-authorisation's new version without a create;
  - an ended installation never pending.

  Local run 2026-10-25: 58 of 58 checks. Two earlier runs under a load average near 900 failed in the install and link phases, before H; the hosted pg-linking leg is the authority.
- [x] `lab:shopify-connect-workers` H1-H2 (workerd): the install's `waitUntil` registers both subscriptions and records version 1; the re-authorisation lists, creates nothing and records version 2; W3's re-drive counts include the sync. Local run 2026-10-25: 29 of 29 checks; the hosted pg-work leg is the authority.
- [x] `lab:tenant-conformance` with the new table, bridges and definers registered (`tests/tenant-conformance/registry.mjs`). Local run 2026-10-25: 17 of 17. Also run once, unchanged and green, because they share the oracle and the connector's re-drive: `lab:shopify-privacy` (39 checks) and `lab:disconnect-store` (28 checks).
- [ ] Owner gate: none for the code. The post-merge steps above run under the standing approval.

## Open questions

1. **Store effect class.** Creating the app's own two webhook subscriptions on the owner's store is treated as provider setup under ADR-0035's standing approval, not as a store change needing an exact proposal. Confirm, or ask for a one-time owner approval before the first deploy.
2. **ADR note.** ADR-0022 item 4 names the five topics, not how they are subscribed. Is a one-line amendment wanted to record the shop-specific mechanism, or does this brief suffice?
