# Shopify install fix: connector placement, cold-start budgets and the stage line

- Status: built, 2026-10-25. Branch `claude/fix-shopify-install-live`. Change class: a routine fix with tests (ADR-0002). There is no change to authority, tenancy, a contract, a migration, a secret, a binding, a route or a provider resource. The review uses the security lens because the change touches the vault transport and the Shopify install path.

## Goal

The owner installed the Morrow app on their own store from the Dev Dashboard. Opening it from Shopify admin (Apps, then Morrow) showed "Unavailable: Morrow can't connect this store right now". The OAuth callback before that showed "Not confirmed".

- Workers Logs had only `{"event":"morrow_broker","method":"shopifyLaunchVerify"|"shopifyInstallComplete","code":"CAPABILITY_UNAVAILABLE"}`.
- Of four launches, two passed. The callback failed, and the state it should have claimed was never claimed.

This change does three things:

1. Makes the launch and the callback work on the deployed environment.
2. Gives them room for a cold start.
3. Makes the next failure name its own step.

## Diagnosis

- The connector Worker had no placement. It ran at the Cloudflare location nearest the merchant.
- The broker's `ConnectorBroker` is a named-entrypoint RPC. It ran beside its caller: Cloudflare's placement applies to fetch handlers, not to RPC methods or named entrypoints. The broker's own us-east-1 placement therefore never applied to these calls.
- Each vault transaction opens a fresh Neon WebSocket connection, which costs about 5 round trips. It then runs 8 statements one after another: `BEGIN`, the role preflight, three `SET LOCAL`s, the app secret, the registry or claim statement, and `COMMIT`.
  - That is about 13 sequential round trips at roughly 220–250 ms each from a distant edge to Neon's us-east-1, about 2.9–3.3 s in total.
  - The budget was 3000 ms.
  - When the timer won, the transport raised `VAULT_DATABASE_UNAVAILABLE`. `invokeBrokerMethod` logs every non-hold error as `CAPABILITY_UNAVAILABLE`, and the connector showed "Unavailable" (launch) or "Not confirmed" (callback).
- The evidence fits:
  - The first failure was logged exactly 3 s after its request.
  - The failures were intermittent: a margin of about 13 round trips against 3000 ms.
  - The callback's state has `claimed_at` NULL. The timer fired before `COMMIT`, so the claim rolled back.
  - The api had the same symptom before its own placement (about 5 s and an intermittent 503; `docs/evidence/live/2026-10-20-*` and `2026-10-21-*`), and placement fixed it.
- These were ruled out:
  - Extra launch or callback parameters (`host`, `embedded`, `id_token`, `locale`, `session`): a shape or HMAC failure answers "Link not valid" and logs nothing, so it cannot produce `CAPABILITY_UNAVAILABLE`.
  - The token reply's decoder, and the claim ordering: the exchange was never reached.
  - An installed but unlinked store: it reads as `none`, a valid state.
  - The live-store admission and the seal: both come after the claim.
  - `INGRESS_BUSY`: it has its own code.
- Not fully excluded from the logs: a missing vault on the fresh isolate at 22:45:58. The new stage line separates this case (`stage: "capability"`, `reason: "vault_absent"`) from a deadline.

## Scope

1. **Placement (the fix).**
   - `apps/shopify-connector/wrangler.jsonc` `env.staging` gets `"placement": {"mode": "targeted", "region": "aws:us-east-1"}`, the same as the api and the broker.
   - `scripts/edge.mjs` `edgePlacementWorkers` becomes `["api", "broker", "connector"]`, so `edge:check` requires the connector's placement and ties its region to `staging.json`'s `neon.region_id`.
   - This fixes the problem under either reading of Cloudflare's placement page:
     - the connector's fetch handler runs in us-east-1;
     - the broker RPC it makes runs beside it;
     - so do its own state transactions.
   - No binding, route, secret or trust boundary changes. The ingress limiters still key on `CF-Connecting-IP`.
2. **Budgets that tolerate a cold start** (`shopifyBrokerBudgets`, `connectorBudgets`).

   | Budget | Was | Now | Why |
   | --- | --- | --- | --- |
   | Broker launch registry read | 3000 | 5000 | A fresh connection while the Neon compute wakes (about 0.5–3 s), or a request that still runs unplaced (13 × 250 ms = 3.25 s) |
   | Broker callback claim | 3000 | 5000 (at most the install's remaining time) | Same |
   | Broker webhook record and token destruction | 3000 | 3000 | Shopify stops waiting for a webhook after 5 s |
   | Broker store reserve | 2500 | 3500 | Fits one unplaced store transaction (about 14 round trips) |
   | Connector launch RPC timer | 4000 | 6500 | The broker's 5000 plus 1500 for a cold broker isolate and the RPC's hops |
   | Connector state transaction | 3000 | 5000 | Its own fresh connection |
   | Connector install budget | 9000 | 10000 | The protocol maximum (`shopifyLimits.budgetMaxMs`, unchanged), so a 5 s claim still leaves the 3.5 s reserve and time for the exchange |

   `tests/connector-worker.test.mjs` ties the connector's timers to the broker's numbers.

   The worst case a merchant can wait is 11.5 s before "Unavailable" (launch) or "Not confirmed" (callback). With placement, a launch takes well under a second.
3. **The stage line** (`apps/broker/src/shopify-stage.ts`).
   - A launch or install that does not succeed logs exactly one more line, `{"event":"morrow_broker_shopify_stage",…}`. Its keys, in order: `method`, `stage`, `result`, `reason`, `vault`, `vaultPhase`, `vaultCause`, `statements`, `connectMs`, `txMs`, `txBudgetMs`, `totalMs`, `secretCache`, `installation`, `coldIsolate`.
   - A successful launch or install logs nothing new.
   - `stage` is the last step entered.
     - Launch steps: `input`, `shape`, `capability`, `preverify`, `ingress`, `launch_context`, `verify`, `done`.
     - Install steps: `input`, `budget`, `shape`, `capability`, `preverify`, `ingress`, `claim_tx`, `claim`, `shop_digest`, `reserve`, `exchange`, `scopes`, `identity`, `store_tx`, `done`.
   - `reason` is one closed code of that step (`shopifyStageReasons`), or `unexpected`. Examples: `timestamp_skew`, `secret_not_found`, `claim_replayed`, `reply_expiring`, `http_403`, `admission_refused`, `seal_failed`, `vault_error`.
   - The vault fields describe the last vault transaction:
     - `vault`: the `VaultError` code;
     - `vaultPhase`: `connect`, `begin`, `role`, `settings`, `body`, `commit` or `done`;
     - `vaultCause`: `deadline`, `driver`, `role_check`, `rows_shape` or `body`;
     - `statements`: the statements acknowledged.
   - Durations are floored to 50 ms and capped at 20 s.
   - `shopifyStageLine` checks every field against its closed set and turns anything else into `"unknown"` or null. It never throws, and a throwing `console.log` changes no outcome.
   - The transport's observation is a new optional `observe` argument of `runVaultTransactionWithDriver` and `runVaultTransaction`.
     - It is called once, after the close, with a frozen object of closed values, and its throw is swallowed.
     - The transaction's order, deadline, rollback and `VAULT_OUTCOME_UNKNOWN` rule are unchanged.
   - The refusals of `exchangeShopifyCode`, `shopifyAdminGraphql` and `readShopifyIdentity` carry a closed `reason`, as does the new `shopifyQueryShapeReason`. `kind` alone still decides every outcome.
4. **Shopify's documented shapes in tests and labs.**
   - `tests/fixtures/shopify-live-shapes.mjs` holds:
     - the app-open launch, non-embedded (`hmac`, `host`, `shop`, `timestamp`) and embedded (`embedded`, `id_token` as a session-token-shaped JWT, `locale`, `session`);
     - the callback (`code`, `hmac`, `host`, `shop`, `state`, `timestamp`);
     - the non-expiring, expiring and online token replies;
     - a public app's 403 for a non-expiring token.
   - The values are synthetic and the shapes come from Shopify's documentation. Nothing was read from the live store. Shopify does not document the 403's body, so only its status is relied on.
   - The lab oracle learns `tokenKind: "expiring"` and `publicApp: true`.
5. **Narrower token acceptance.** A reply carrying `refresh_token_expires_in` is now refused too. An online reply (`associated_user`, which also carries `expires_in`) is named `reply_online` before the expiring check.

## Not changed, and why

- **Expiring offline tokens.** Not implemented here; the exchange still asks for a non-expiring token (`expiring: "0"`).
  1. This incident never reached the exchange: `claimed_at` is NULL.
  2. ADR-0022 (accepted) chose non-expiring offline tokens with custom distribution for this phase, and refresh "arrives with public distribution, as a new credential kind in the same vault". Storing a refresh token and its expiry and adding a single-flight refresh path changes credential custody and retention. Under ADR-0002 that is material, so it needs an owner-approved ADR first. `docs/briefs/v1-connect-store.md` lists it as v1 PR 5.
  3. Shopify's rule (changelog of 2026-04-01) covers public apps created on or after 2026-04-01. Custom apps and apps a merchant created in the Dev Dashboard or the admin are exempt.
     - The Morrow TOML is generated for custom distribution (`npm run shopify-app -- toml`).
     - If the app's Distribution in the Dev Dashboard is custom or merchant-owned, nothing changes.
     - If it is public, the install will now stop with a named line, nothing stored. Two lines are possible:
       - `stage: "exchange"`, `reason: "reply_expiring"`;
       - `stage: "identity"`, `reason: "http_403"`.
   - Every public app needs the refresh path by 2027-01-01 in any case.
- **The vault transport's round trips.** Using `pipelineConnect: "password"`, or sending BEGIN plus the SET LOCALs as one statement, would cut round trips. It would change the reviewed transport, and with placement it is not needed.
- **Neon plan or autosuspend.** That is money, so it is the owner's decision. The budgets cover a wake.
- **The orchestrator.** Its RuntimeBroker calls come from queue, workflow and cron handlers, which cannot be placed. That is a separate follow-up.
- **The connector's cron.** It is not placed: a scheduled handler is not a fetch handler. Its three ids-only transactions keep `pendingMs` 3000. A miss is counted as `unavailable` and retried five minutes later.

## Interfaces touched

- Source:
  - `apps/broker/src/{shopify-install,shopify-stage,shopify,vault-database,capabilities}.ts`. `brokerCapabilitiesWarm` is new.
  - `apps/shopify-connector/worker/connector.ts`
  - `apps/shopify-connector/wrangler.jsonc`
  - `scripts/edge.mjs`
- Tests:
  - `tests/{broker-shopify,connector-worker,edge-config}.test.mjs`
  - `tests/fixtures/shopify-live-shapes.mjs`
- Labs:
  - `scripts/shopify-install-lab.mjs` (I10–I12)
  - `scripts/shopify-connect-workers-lab.mjs` (R2, O4)
  - `scripts/fixtures/{shopify-oracle.mjs,shopify-connect-worker.ts}`
- Unchanged:
  - migrations, contracts, `broker-protocol.ts` (`shopifyLimits` included), the connector's pages and routes;
  - every HMAC, state-cookie, single-use-state, live-store and scope check.

## Security notes

- **No check is weakened, and no authority is added.**
  - The query HMAC, the timestamp window, the state cookie, the single-use claim committed before the exchange, the exact scopes, ShopIdentity and the live-store admission run as before, in the same order.
  - Shopify's extra launch keys were already signed data. The tests now pin that for the embedded shapes, inside the 2048-byte limit.
- **The token stays in the broker.** The stage line has no field that can carry a value. The sentinel test feeds sentinel values and checks that none appears in a line:
  - inputs: shop, host, session, id_token, locale, code, state, its digest and the hmac;
  - the exchange's replies: `shpat_` and `shprt_` tokens.
  - It also checks that no `myshopify`, `shpat_`, `shprt_`, 32-hex run or 40-character base64url run appears.
- **The request URL.**
  - The line is emitted by the broker inside the `ConnectorBroker` RPC, and never by the connector. A JS RPC invocation is traced with its method name, not with a request URL.
  - Success emits nothing.
  - The connector, whose Workers Logs events carry the callback URL (`docs/briefs/fix-signin-clock-and-stage-log.md`), logs nothing new.
  - After the deploy, the owner can confirm that the broker's `morrow_broker` and stage lines carry no `$metadata.url`.
- **Placement** is the P04.T01i D1 setting already reviewed for the api and the broker. The rate limiters count per location, so `INSTALL_LIMITER` and `WEBHOOK_LIMITER` now count in effect in one place. That is fine for one store. Recheck before the public launch.

## Owner steps after the merge

1. Claude deploys under the standing approval (one activity-log line). Check the deploy:
   - a launch answer carries `cf-placement`;
   - Workers Logs has no `morrow_connector_guard ADDRESS_MISSING` line.
2. **Owner:** open Morrow from Shopify admin (Apps, then Morrow). The installation still reads `none`, so a fresh OAuth starts. Shopify should send the callback without a consent screen, and the browser should land on the workspace's connections screen.
3. If it still fails, read the `morrow_broker_shopify_stage` line in Workers Logs:
   - `stage: "launch_context"` or `"claim_tx"`, `vaultCause: "deadline"`, `connectMs` ≥ 900: still running far from Neon (check `cf-placement`).
   - `connectMs` ≤ 150 and `txMs` near `txBudgetMs`: a Neon wake or a hang near the database.
   - `stage: "capability"`, `reason: "vault_absent"`: the broker's vault secrets.
   - `stage: "exchange"`, `reason: "reply_expiring"`, or `stage: "identity"`, `reason: "http_403"`: the app is treated as public (see "Expiring offline tokens" above). Check the Distribution in the Dev Dashboard.
   - No stage line, an "Unavailable" page and no new state row: the connector's own state transaction failed.
4. **Owner, read-only:** in the Dev Dashboard, check the Morrow app's Distribution. Also check its webhooks: the live config lists only the compliance topics, while `npm run shopify-app -- toml` also generates `app/uninstalled` and `app/scopes_update`.

## Test checklist

- [x] `tests/broker-shopify.test.mjs`:
  - Shopify's documented app-open launches (embedded and not) and callback verify and install with no stage line.
  - One closed line per failed launch: 14 table cases plus ingress, input, the vault code, `coldIsolate` and `secretCache`.
  - One closed line per failed install: 20 table cases (among them `reply_expiring`, `reply_online`, `http_403`, `admission_refused`, both lost-COMMIT cases and `budget_exhausted`), plus input, budget and `seal_failed`.
  - The budgets over the real transport on a virtual clock:
    - placed with a 3.5 s wake, and unplaced at 13 × 250 ms, both verify;
    - unplaced with a 2.6 s wake is held, and its line reads `launch_context`, `vaultPhase: "body"`, `vaultCause: "deadline"`, `connectMs: 3850`, `txMs: 5100`;
    - a slow claim is held before its statement, and the state stays open.
  - Sentinels.
  - The builder under hostile input.
  - A throwing console changes nothing.
  - The transport's observation for success, `role_check`, `driver`, `body`, a body `VaultError`, a lost COMMIT, `rows_shape` and a deadline; a throwing observer changes nothing.
  - Checked against the old values: with the launch and claim budgets back at 3000, the budget test fails.
- [x] `tests/connector-worker.test.mjs`:
  - The timers cover the broker's budgets.
  - With mock timers, a broker answering after its whole launch budget plus 1 s still redirects to authorize. With the old 4000 ms timer the test fails.
  - An answer past the timer is 503.
  - An install answered at the budget plus 1 s is confirmed.
- [x] `tests/edge-config.test.mjs`:
  - the connector's staging placement is required, targeted and in `staging.json`'s region;
  - it is absent at the top level and in production;
  - it moves with the region.
- [x] `tests/shopify-hmac.test.mjs` and `tests/broker-shopify-read.test.mjs` are unchanged and pass.
- [ ] `lab:shopify-install` (I10–I12) and `lab:shopify-connect-workers` (R2, O4): results under "Local results" below.
- [ ] Hosted CI on the PR head; one AI review (separate context, same model family) with the security lens.
- [ ] After the deploy: the owner opens Morrow from Shopify admin once (owner step 2).

## Local results

To be filled in from the local run of this branch.
