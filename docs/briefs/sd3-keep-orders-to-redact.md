# SD3: Keep the listed order ids (P09.T05b)

- Status: brief, 2026-10-27. Branch `claude/sd3-sd4-customer-data-deletion-base` (one pull request with SD4, `docs/packets/P09.T05c.md`). Plan row SD3 of `docs/plan/store-data-foundation-implementation.md` (size S; "now, and before any table keyed by order exists"). Change class: routine under ADR-0002, carrying out what is already approved: ADR-0031 item 3 ("`customers/redact` matches ... the listed orders") and its 2026-10-26 note on item 1, and ADR-0043 item 24 (OD-2026-10-26-11). No new decision.
- Migrations: `0058.customer-deletion-identity.sql` (identity owner) and `0059.customer-deletion-work.sql` (work owner). Pull request 92 holds 0057; the lead renumbers this pair at merge if it lands first.

## Goal

Every table that will hold a row keyed by an order (V1-PR22's order data, CS8's order events, SD9b's projections, ADR-0043's trigger and occurrence rows, ADR 0042's contact classes) must lose that order's rows when Shopify's `customers/redact` lists it. Today the broker's minimiser drops `orders_to_redact`, so nothing could find them. This row keeps the listed ids, numeric and nothing else, on the inbox row's 7-day clock, gives the deletion registry the matcher those classes register with, and makes S8 fail an order-keyed table that has not registered.

## Scope

- **The minimiser** (`apps/broker/src/shopify.ts`): `customers/redact` keeps `ordersToRedact`, `customers/data_request` keeps `ordersRequested`: present, an array of numeric ids (numbers or digit strings), at most 20,000, kept distinct in ascending numeric order as text. A missing or malformed list refuses the whole delivery (Shopify retries it); a list is never recorded as empty when Morrow could not read it. Each body still refuses the other request's list.
- **The inbox** (0058): `shopify_webhook_body_valid` admits the two lists (`shopify_order_list_valid`), and keeps 0036's shapes valid for rows recorded before; `work_shopify_webhook_record` takes a minimised body up to 512 KiB (was 4 KiB). The inbox gets its own guard, `shopify_inbox_guard`, with 0053's two inbox rules unchanged and one deletion: a settled row past `expires_at` whose privacy request is not open. `work_shopify_inbox_purge()` deletes such rows (500 a call, oldest first) and counts the expired rows it must keep.
- **The registry** (`packages/work/src/redaction.ts`): `customerContentHandlers`, `customerKeyMatchers` (`order_id` needs `listed_orders`), and the shape every handler takes. None is registered: no table is keyed by an order at this head.
- **S8** (`tests/tenant-conformance/content.mjs`, `static.test.mjs`): a table's optional `customerKeys`; a keyed table without exactly one customer handler applying each key's matcher fails (`CUSTOMER_KEYED_WITHOUT_HANDLER`, `CUSTOMER_KEY_UNMATCHED`); a fourth content class, `customer`, which needs a key and a shop/redact handler too; and, against the live catalog, any column named `order_id`, `*_order_id` or `order_ids` must belong to a table that declares the key. S8 also compares `morrow_identity.customer_handler_tables()` with the registry.
- **The run** (0059): `customer_match_of` reads the match from the inbox row the broker recorded; `customer_content_redact(org, ws, store, match)` is the registration surface (a revisable owner helper, run only in the connector's customer redaction context for that store, `morrow.connector_customer`); `connector_inbox_apply_v2` (dropped and created again with its grant and owner) runs it for `customers/redact` under the store's stop key held exclusively, and completes the request only when every handler reports zero remaining. `customers/data_request` still completes "none held" in this commit (SD4 adds the export).
- **The clock**: `connector_privacy_purge()` and the cron step behind the existing clean-up switch, committed off (`docs/decisions/connection-cleanup-staging.json`, scope text updated; `edge:check` already refuses a mixed state). With it off, nothing is deleted, as before.

## Interfaces touched

`apps/broker/src/shopify.ts`; `apps/shopify-connector/worker/{database,connector}.ts`; `migrations/0058`, `0059`, `manifest.json`; `packages/work/src/redaction.ts`; `tests/tenant-conformance/{content,registry}.mjs`, `static.test.mjs`; `docs/decisions/connection-cleanup-staging.json`; `scripts/shopify-privacy-lab.mjs` (phase L, K4); `docs/plan/build-plan.md` (P09.T05b); tests below.

## Security notes

- Customer data: none enters. Order ids are not customer data (CLAUDE.md); tied to a customer's request they are pseudonymous personal data, so they stay only in the 7-day inbox row and never reach `privacy_requests` (365 days, content-free). The lab searches every stored body for the planted email, phone and customer id.
- Tenancy: the match and the tenant come only from the broker-recorded inbox row; the redaction runs under that tenant and store alone (the context names org, ws and store, and the helper refuses any other). The purge is the identity owner's own policy, never BYPASSRLS.
- Fail closed: a request whose handler still holds a matching row stays open and its delivery received; its inbox row is never purged; the guard re-checks the purge's rule for every row. The connector's login cannot run the helper or the identity purge, and a context it writes reaches nothing (`K4`).
- Immutable migrations: forward only; every replaced function is pinned by md5 in each file's preflight.

## Test checklist

- [x] `tests/shopify-hmac.test.mjs`: the lists kept (distinct, numeric order, digit strings), refused when missing, malformed, over 20,000, past `MAX_SAFE_INTEGER` or carrying the other request's list; the largest list kept whole.
- [x] `tests/broker-shopify.test.mjs`: the recorded bodies carry the lists, never the email or phone.
- [x] `tests/redaction-handlers.test.mjs`: every S8 rule above fails a deliberately broken copy; the catalog rule's column shapes.
- [x] `tests/connector-worker.test.mjs`, `tests/connector-cron.test.mjs`: the purge runs last, only with the clean-up switch on, its counts and the `INBOX_EXPIRED_HELD` line.
- [x] `lab:tenant-conformance` S1 to S8 and P1 to P10 (S8 with the catalog rule and the handler list).
- [x] `lab:shopify-privacy` phase L: L1 a redact keeps its ids and completes "none held" with no class keyed; L2 a registered class's listed rows deleted in that store only (another store and another tenant keep theirs), with the evidence; L3 after 7 days the purge deletes the completed requests' rows and keeps the open one; L4 the request completes only when every handler reports zero, then is purged; L5 the guard deletes nothing inside 7 days or still received; L6 the registry is empty again. K4.
- [x] `migration-history.test.mjs`: every published row unchanged. Its sequence test fails on this branch alone until pull request 92's 0057 merges (or the lead renumbers this pair to 0057 and 0058).
