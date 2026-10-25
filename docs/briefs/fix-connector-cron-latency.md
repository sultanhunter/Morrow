# Connector cron fix: run the re-drives beside the database

- Status: built, 2026-10-25. Branch `claude/fix-connector-cron-latency`. Not pushed, not deployed.
- Change class: **the owner decides before merge.** The fix adds a Durable Object namespace to the existing connector Worker. Durable Objects are a Cloudflare product that is not in the settled stack line ("Workers, Workflows, Queues and R2"), and the M2 brief already recorded a Durable Object as "a provider selection". So the safe reading of ADR-0002 (ADR-0021 item 5: provider selection; creating provider resources) is material until the owner says otherwise. The question for the owner is below. If the owner prefers no new provider resource, the routine stopgap below is the alternative.
- The review uses the security lens: the change touches the connector's database transport, its broker RPC path and its deployment configuration.

## Goal

The connector's five-minute cron must finish its four steps on the deployed environment:

1. re-apply webhook inbox rows;
2. destroy the tokens of ended installations;
3. count overdue privacy requests;
4. register the shop-specific webhooks (PR #71) for every store that lacks them.

The first cron after the #71 deploy (2026-10-25, 12:41 UTC) failed all four. The owner's store therefore still has no `app/uninstalled` or `app/scopes_update` subscription.

## Diagnosis

The cause is distance, not a database or grant fault.

- Cloudflare's placement page: placement "only affects the execution of fetch event handlers". PR #69 placed the connector in `aws:us-east-1`, which moved its fetch handler only.
- A cron runs `scheduled()` on whatever machine Cloudflare picks ("underutilized machines").
- A service-binding RPC runs on the caller's server. So the broker's `ConnectorBroker` methods that the cron calls (`neonLease`, `shopifyCredentialDestroy`, `shopifyWebhookSubscriptionsSync`) ran on that same machine, and so did their vault transactions.
- Each transaction is about 13 sequential round trips to Neon in us-east-1: 6 to connect (WebSocket and Postgres start-up), then `BEGIN`, the role check, three `SET LOCAL`s, the statement and `COMMIT`. Each has a 3000 ms budget. From a machine with a round trip above roughly 230 ms, every transaction misses it.
- The 12:41 lines match this exactly:
  - the three connector reads failed (one shows as `PRIVACY_CHECK_UNAVAILABLE` at 12:41:21);
  - the broker's sync failed 3 s later (`CAPABILITY_UNAVAILABLE` at 12:41:24), its first vault transaction's budget;
  - the run's line counted `unavailable` 4.
- Before #69 and #71 the run logged `unavailable` 0 or 2 now and then: the cron's machine changes from run to run.
- Ruled out:
  - the 0048–0049 grants and the statement registry: they cannot explain the three older reads failing in the same run;
  - the sync's own 20 s budget: it failed in its first 3 s;
  - `neonLease`: no failure line;
  - a Neon outage: unlikely; check the Neon usage page if the fix does not work.

## Scope

1. **The cron runs in one Durable Object** (`apps/shopify-connector/worker/cron.ts`, `worker/index.ts`).
   - `ConnectorCron` is a SQLite-backed class in the connector Worker with one RPC method, `redrive()`. It takes no argument, runs the existing re-drives with the Worker's own bindings, and answers a closed outcome: `ran`, `unbound` or `busy` (a second run while one is in progress).
   - `scheduled()` now awaits `env.CONNECTOR_CRON.get(idFromName("redrive"), { locationHint: "enam" }).redrive()`. The object is created in Eastern North America, near Neon's us-east-1, so the run and every call it makes start beside the database: its connections, its leases and the broker's RPCs with their vault transactions. The existing 3 s budgets then hold with a wide margin. No budget or broker contract changes.
   - Default deny: an unbound connector touches nothing. A missing or malformed binding runs nothing and logs `CRON_UNBOUND`. An object that throws, answers something else or does not answer within 120 s logs `CRON_OBJECT_UNAVAILABLE`. `busy` logs `CRON_BUSY`.
   - The run is awaited, no longer handed to `waitUntil`, whose 30 s limit after the handler returns could cut a 60 s run.
2. **Configuration** (`apps/shopify-connector/wrangler.jsonc`): the `CONNECTOR_CRON` binding in every environment (it is not inherited), and one migration, `{tag: "v1", new_sqlite_classes: ["ConnectorCron"]}`. `worker-configuration.d.ts` is regenerated.
3. **edge:check** (`scripts/edge.mjs`):
   - the connector may carry `durable_objects` and `migrations`, exactly `edgeConnectorDurableObjects` and `edgeConnectorMigrations` (`EDGE_CONNECTOR_DURABLE_OBJECTS`, `EDGE_CONNECTOR_MIGRATIONS`);
   - every other Worker still refuses both (`EDGE_UNEXPECTED_BINDING_*`);
   - the hint in `cron.ts` must be the hint of `infra/environments/staging.json`'s `neon.region_id` (`edgeDurableObjectLocationHint`; `EDGE_CONNECTOR_CRON_LOCATION`), so a database move moves the hint by a reviewed change, like the placement region.
4. **The stage on every cron failure line** (`worker/database.ts`, `worker/connector.ts`). Closed values and durations only.
   - A failed connector transaction's error now carries where it ended (`connectorSqlObservation`). This is the vault transport's observation, for the connector's own login:
     - `phase`: `lease`, `connect`, `begin`, `role`, `settings`, `body` or `commit`;
     - `cause`: `deadline`, `lease`, `driver`, `role_check`, `rows_shape` or `body`;
     - `statements`: the statements acknowledged;
     - `connectMs` and `txMs`.
   - New lines `morrow_connector_cron` `INBOX_PENDING_UNAVAILABLE` and `CREDENTIALS_PENDING_UNAVAILABLE` carry these fields. Before, these failures were only counted. `PRIVACY_CHECK_UNAVAILABLE` and `APPLY_UNAVAILABLE` carry them too.
   - `SUBSCRIPTIONS_UNAVAILABLE` and `DESTROY_UNAVAILABLE` carry `reason` (`timeout`: the connector's timer; `refused`: the broker refused, and its own `morrow_broker` line names the method; `invalid`: the reply did not decode) and `elapsedMs`.
   - The run's `morrow_connector_redrive` line adds `elapsedMs`. The counts it returns are unchanged.
   - Durations are floored to 50 ms and capped at 20 s (the run's at 120 s).
   - The transaction's order, deadline, rollback and outcome are unchanged.

## Not changed, and why

- **Budgets.** Beside the database a transaction takes tens of milliseconds, and the budgets were set for that.
- **The broker.** No broker change, so only the connector needs deploying.
- **The routine stopgap**, if the owner declines the Durable Object:
  - give the cron path its own distance-tolerant budgets: about 8–10 s for the connector's id reads and applies, and the sync's per-transaction vault budget scaled up (for example 8000 ms, with a 6000 ms record reserve and a 12000 ms installation minimum, inside `budgetMaxMs` 25000);
  - give the broker's token destruction a cron budget, which needs an RPC parameter;
  - await the run.

  This works from anywhere (about 4 s per transaction at a 300 ms round trip). But the cron stays exposed to wherever Cloudflare runs it, and more surfaces change.
- **The orchestrator** (`apps/workers`): it has the same latent problem. Its per-minute cron (`pending_starts` through the RuntimeBroker lease, `runtimeSweep`), its Queue consumer and its Workflow steps are not fetch handlers either. They are harmless while the dispatch and runtime switches are off. The same pattern, or explicit budgets, belongs in the brief that turns them on.

## Interfaces touched

- Source:
  - `apps/shopify-connector/worker/{cron.ts (new), index.ts, connector.ts, database.ts}`
  - `apps/shopify-connector/wrangler.jsonc`
  - `apps/shopify-connector/worker-configuration.d.ts` (generated)
  - `scripts/edge.mjs`
- Tests:
  - `tests/connector-cron.test.mjs` (new)
  - `tests/fixtures/connector-entry.mjs` (new): the deployed entry bundled with `cloudflare:workers` stubbed, and with a fake Neon client
  - `tests/connector-worker.test.mjs`
  - `tests/edge-config.test.mjs`
  - `tests/orchestrator.test.mjs`: its `cloudflare:workers` stub gains `DurableObject`
- Lab: `scripts/edge-workers-lab.mjs` (the CRON checks).
- Unchanged:
  - migrations, contracts, `broker-protocol.ts` and the broker;
  - the connector's routes, pages, ingress limits and placement;
  - every HMAC, cookie and state check.

## Security notes

- **No new public surface.**
  - A Durable Object is reachable only through a namespace binding. Only the connector binds `ConnectorCron`, and edge:check refuses a Durable Object binding on any other Worker.
  - The class has no `fetch` and one argument-free method.
  - No route, hostname, `workers_dev` or preview change.
- **No credential moves.**
  - The connector still binds no secret; `CONNECTOR_CRON` passes its credential-name rule.
  - The run uses the same connector login (leased per transaction from the broker) and the same `ConnectorBroker` entrypoint.
  - Raw credentials stay in the broker.
- **Closed inputs.** The object's name and hint are constants, never caller-supplied. The RPC carries nothing in and one closed string out. The counts stay in the object's own line.
- **Unknown outcomes.** Unchanged:
  - the inbox applier and the token destruction are idempotent and re-driven by id;
  - the sync lists before it creates.

  A deploy resets a running object, which cuts a run as an evicted cron would. The next run re-drives.
- **Logs.** The new fields are closed codes and floored durations. The tests check that no hostname, lease password, project id or origin appears in any cron line.
- **Data and retention.** The object stores nothing; its SQLite storage stays empty.
- **Kill switch.** `staging:kill` behaves as before. It takes `workers.dev` down. As before, the cron keeps running and reaches only the database and the broker.
- **The hint is best-effort.** Cloudflare creates the object in a data centre it picks inside the hinted region, on the first `get()`, and keeps it there. Data centres in Eastern North America are typically within about 30 ms of us-east-1, so a run's 13-round-trip transactions take well under a second.

## Cost

- About 288 object requests a day per deployed environment (one per cron run), against the free allowance of 100,000 a day.
- A few seconds of duration per run, and no storage.
- Within the existing caps.

## Owner decision (before merge)

> The connector's cron runs far from the database, so the shop webhooks never get registered. The fix moves the cron's work into a Cloudflare Durable Object, a small built-in Cloudflare feature, placed near the database inside the same connector Worker. It costs nothing at this size, stores nothing and adds no public address. Durable Objects are not in Morrow's agreed stack, so this may count as choosing a new provider feature. What should we do?
>
> - **Allow it (Recommended).** Record it in this brief as a routine use of Cloudflare Workers, or in a short ADR if you prefer.
> - **No new Cloudflare feature.** Use the stopgap: longer time limits on the cron path only.

## Deploy and check

Deploy only after the owner's answer and a green hosted CI on the PR head. Claude deploys under the standing approval (ADR-0035), the connector only, with one activity-log line.

1. The connector's deploy applies migration `v1`, which creates the class. Staging rolls forward (E11 is suspended), and Cloudflare does not allow a version rollback across a Durable Object migration anyway. The way back is a forward deploy: `scheduled()` running locally again, with the class left unused or removed by a `deleted_classes` migration `v2`.
2. Read the next cron in Workers Logs, within five minutes:
   - `morrow_connector_webhooks` `SUBSCRIPTIONS_SYNCED` with `checked` 1 and `registered` 1: the owner's store, pending since #71. Later runs show `checked` 0 until the 24-hour re-check.
   - `morrow_connector_redrive` with `unavailable` 0, and `elapsedMs` around a second or two (not 12 s).
   - No `PRIVACY_CHECK_UNAVAILABLE`, no `morrow_connector_cron` line, and no `morrow_broker` `shopifyWebhookSubscriptionsSync` `CAPABILITY_UNAVAILABLE`.
   - Then about a dozen consecutive runs with `unavailable` 0.
3. If a step still fails, read its stage:
   - `phase` `connect` or `body`, `cause` `deadline`, and `connectMs` in the thousands: still far from the database. The hint was not honoured; check the object's location.
   - `connectMs` under about 150 and `txMs` near 3000: a Neon wake or a hang near the database.
   - `cause` `lease`: the broker's lease, whose `morrow_broker` `neonLease` line names its code.
   - `CRON_UNBOUND`: the binding is missing from the deployed version.
   - `CRON_OBJECT_UNAVAILABLE`: the object failed or was reset by a deploy (once).
   - `SUBSCRIPTIONS_UNAVAILABLE` `reason` `refused` with `elapsedMs` about 3000: the broker's first vault transaction.

`registered` counts a store only when Shopify's replies proved both subscriptions, with their ids recorded in the store's registration row (#71). Shop-specific subscriptions made through the Admin API do not appear in the app's TOML configuration, so the Dev Dashboard is not the place to check them.

## Test checklist

- [x] `tests/connector-cron.test.mjs` runs the bundled deployed entry on a virtual clock, with a fake Neon whose round trips cost what the opening machine's distance costs (260 ms far, 25 ms in the hinted region) and a broker that runs beside its caller:
  - **Before:** the same re-drives where the cron runs reproduce the 12:41 lines:
    - each id read ends in `body` at its 3000 ms deadline, connected at 1550 ms, after 5 statements;
    - the sync is `refused` after 3000 ms;
    - `unavailable` 4, and the run takes 12 s.
  - **After:** `scheduled()` at the same far edge asks for `redrive` with the hint `enam`, and every connection, lease and sync runs there:
    - `SUBSCRIPTIONS_SYNCED` with `registered` 1, `unavailable` 0, no privacy or cron failure line;
    - the run takes 2.4 s, and nothing is left in `waitUntil`.
  - **Negative control:** with the old `scheduled()` (the run in `waitUntil` beside the cron), the test fails.
  - Also in this file:
    - the hint is `staging.json`'s region's, and the wait covers the run;
    - an unbound connector touches nothing;
    - six missing or malformed bindings each log `CRON_UNBOUND` and run nothing;
    - a busy, unbound, odd, throwing or silent object is one fixed line and never a throw;
    - `ConnectorCron` has one RPC method, returns `unbound` without its bindings and `busy` for a second concurrent run;
    - all seven phases and six causes of a failed transaction, on a fake driver, with no password in the error.
- [x] `tests/connector-worker.test.mjs`:
  - the sync's unavailable lines carry `timeout` (after its 17 s), `refused` and `invalid`;
  - the privacy line carries the stage fields;
  - the deployed entry is the bundled one.
- [x] `tests/edge-config.test.mjs`:
  - the binding and the migration are exact in all three environments;
  - ten mutations fail with the right code: a missing environment, another name, another script's class, a second binding, a KV class, a second migration, no migration, and a binding or migration on another Worker;
  - the hint table, and another hint fails;
  - the placement-region cases now also move the hint.
- [x] `tests/orchestrator.test.mjs`: the unconfigured connector entry still bundles and is deny-all.
- [x] `lab:edge-workers` (workerd), using wrangler's own Miniflare options:
  - `CONNECTOR_CRON` is the SQLite class;
  - `scheduled()` runs the re-drives in the object, which logs four refused steps, each with a closed stage, and the sync's reason;
  - without the binding, only `CRON_UNBOUND`, and nothing reaches the network.
- [ ] Hosted CI on the PR head; one AI review (separate context, same model family) with the security lens.
- [ ] The owner's decision above.
- [ ] After the deploy: the checks in "Deploy and check", step 2.

## Local results

To be filled from the local run (see below).
