# SD5: per-shop buckets for Shopify's API query cost

- Status: brief, 2026-10-27. Branch `claude/sd5-shopify-query-cost-buckets`, from `main` at `2c495867` (pull request 90). Row SD5 of `docs/plan/store-data-foundation-implementation.md`, a P09.T03 child. Change class: routine under ADR-0002 (the plan says SD5 needs no owner decision and can start today). It is Shopify's rate limit, counted in Shopify's GraphQL query-cost points: never money, and it draws no credits (ADR-0039, ADR-0043's "Does not change", OD-2026-10-26-12). Behind a switch committed off. No external effect: nothing reaches Shopify that did not before.
- Migration `0057.shopify-query-cost.sql`, the next free number on `main` (0001 to 0056 applied). Pull request 92 also holds 0057, so whichever merges second is renumbered by the lead (file name, manifest row and digest, its header and every reference; the tests find it by slug).

## Goal

One SQL token bucket per store installation, which is one (shop, app) pair while it is live, in Shopify's query-cost points. Every isolate of the broker shares it. Before a fixed document is sent, its known cost is taken from the bucket. Shopify's reply settles it: the reported `throttleStatus` corrects the bucket. A read the bucket cannot yet cover waits instead of failing. A background read never takes the headroom an approved write needs. CS7's per-connection buckets reuse the same table and helpers.

## Scope

- **Migration 0057** (work owner): `morrow_work.rate_buckets` (FORCE RLS; tenant-keyed; content-free: ids, points, rates, times and three counts), its guard, and `rate_bucket_policy()`. The policy lists the classes in priority order with the share of the bucket each leaves untouched for the classes above it: `write` 0, `person_read` 0.10, `agent_read` 0.30, `reconciliation` 0.50, `bulk` 0.70. It also holds Shopify's smallest published bucket as the default before the first report (1,000 points, restored at 50 a second) and the dearest single document (1,000 points). `rate_bucket_take` and `rate_bucket_settle` are INVOKER owner helpers that work under the row lock. `morrow_vault.shopify_query_cost_take` and `shopify_query_cost_settle` are the broker's two definers.
  - **Take.** It refills by the database clock, then charges the document's known cost. A write is always admitted and never waits on the bucket: Shopify's own THROTTLED reply, which proves nothing ran, stays its only limit, and the gateway's one wait and resend are unchanged. Every other class is admitted only while the points left stay at or above its share. Otherwise the take answers `wait` with the milliseconds until they would (1 ms to one hour). A document dearer than its class could ever be given is `too_costly`. The first take creates the bucket.
  - **Settle.** It refunds what the reply proves was unused: all of it for THROTTLED, and the requested cost less `actualQueryCost` otherwise. It adopts Shopify's capacity and restore rate. It never keeps more points than Shopify reported available, so the model only ever errs low. Shopify's values outside the table's safety ranges are dropped, never clamped.
- **Broker** (`apps/broker/src/shopify-query-cost.ts`, `vault-statements-query-cost.ts`): the classes and policy (drift-tested against the SQL), the take and settle statements with closed rows, and `bucketedShopifyCall`. That function takes, waits in the broker or parks, sends once, settles, and takes again after a THROTTLED reply, at most four takes per call. `shopify.ts` gains `shopifyAdminGraphqlOnce` (one attempt with Shopify's cost report) and `shopifyCostReport`. `shopifyAdminGraphql` is now a loop over it, with M2 PR-3's behaviour unchanged.
- **The read path** (`shopify-read.ts`), with the switch on:
  - Step 2's transaction takes the known cost after a resolved resolution only. A person read (ApiBroker) uses `person_read`, and an agent read (RuntimeBroker) uses `agent_read`.
  - A person read waits in the broker while the wait leaves 2 s of its budget for the call. An agent read waits there only up to 1 s; otherwise it parks.
  - A parked read is not sent and answers the protocol's new closed result `{schemaVersion: 1, outcome: "parked", retryAfterMs}`, which H7b's `run.wait` will consume.
  - The token is opened only when the document is first sent. The settle runs in its own transaction within the same read slots.
- **Callers**: the catalogue routes answer a parked read 429 `rate_limited` (the read class) with `Retry-After`. The Listings product read treats it as unavailable and tries again after its waits.
- **The switch** (`docs/decisions/shopify-query-cost-staging.json`, `MORROW_SHOPIFY_QUERY_COST` on the staging broker only): committed off. While it is off, reads keep M2 PR-3's one THROTTLED wait and no bucket statement is sent. `edge:check` refuses a mixed state.
- **Not here** (each row brings its own wiring):
  - SD13a's mutation registry, whose gateway writes take from the `write` class (the take is ready). Until then, a write is reflected in the bucket at the next read's settle, through Shopify's reported points.
  - CS9's contact dispatch, also in the `write` class.
  - SD6 and SD7's subscription sync and reconciler (`reconciliation`).
  - SD8's bulk reads (`bulk`).
  - The scopes read-back and webhook registration of v1 PR 5. These two cost a few points once a day; they move to `reconciliation` with SD6.
  - SD22's metrics, which read the three counts.
  - H7b's `run.wait`.

## Interfaces touched

`migrations/0057.shopify-query-cost.sql`, `migrations/manifest.json`; `apps/broker/src/{shopify-query-cost,vault-statements-query-cost,shopify,shopify-read,vault,capabilities}.ts`; `packages/identity/src/broker-protocol.ts` (the parked result, `parkedMaxMs`, the switch's names); `packages/work/src/catalog/http.ts`, `packages/work/src/runs/workflow.ts`; `docs/decisions/shopify-query-cost-staging.json`, `docs/decisions/data-lifecycle.md`; `scripts/edge.mjs`; `scripts/fixtures/shopify-oracle.mjs` (an opt-in leaky bucket and ProductUpdate); `tests/tenant-conformance/{registry,static.test}.mjs`; `package.json` (`lab:shopify-query-cost`, in `lab:group:pg-http` before `lab:shop-knowledge`); `docs/development/ci.md`.

## Security notes

- **Who runs it.** The two definers run only on the broker's own login (`morrow_vault_broker`), are guarded by `work_executor_safe` and are granted to nobody else. The helpers are the command role's alone, and the table is reached only through them. Each definer is one round trip.
- **Tenancy.** The tenant comes only from the installation row (`work_shopify_check_target`: a live installation of an active app), never from the caller. Inputs are an installation id, a closed class and whole numbers. The definer writes the RLS setting `morrow.vault_rate_bucket` (org|ws|provider|subject) from that row and clears it before returning. The broker's login holds no table privilege, so a setting it forges reaches nothing. The session template is read-only. FORCE RLS, no runtime DELETE or TRUNCATE, and a guard that keeps identity, revisions, clocks and counts.
- **Writes keep priority.** A write never waits on the bucket, and every read class leaves its share. The model never exceeds what Shopify reported, so Shopify's real bucket always keeps at least the agents' share for writes while only background reads run.
- **Not money.** No credit, wallet or US$ column; nothing is held, drawn or checked on an amount.
- **Content-free.** The bucket holds no shop domain or store data. Nothing is logged, and no Shopify value leaves the broker except the wait in a parked result.
- **Default off.** While the switch is off, nothing changes. Turning it on needs the migration applied and one reviewed commit.

## Test checklist

- [ ] `tests/broker-shopify-query-cost.test.mjs`: the take and settle statements and rows, the settle's parameters, the inline and park rules, `bucketedShopifyCall` (take, wait, park, refusal, THROTTLED retake, the take cap, a dropped settle), one attempt and its cost report (M2 PR-3's wrapper unchanged), the reader with the switch on (first take after a resolved resolution, parked reads unsent, a person waits where an agent parks, THROTTLED) and off, the protocol's parked result, the switch record and `edge:check`'s mixed states, the migration's shape and grants, and the drift between the SQL policy, the broker and the lab's synthetic Shopify.
- [ ] `tests/catalog-http.test.mjs`: a parked read is 429 with `Retry-After`; a parked value outside the protocol is 503.
- [ ] `lab:shopify-query-cost` (PostgreSQL 17, the createrole administrator): see the lab's header for its cases.
- [ ] `lab:tenant-conformance` S1 to S8 with the new table, policy and functions.
- [ ] `typecheck`, `typecheck:edge`, `edge:check`, `verify`, `format:check`, `npm run -s graph -- check`, `npm test`.
- [ ] Hosted CI on the PR head; one AI review (separate context, same model family) with the security lens (RLS, migration, definers, provider adapter).
