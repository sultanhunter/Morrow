# v1 PR 3: Review, approve and apply to Shopify

- Status: brief, 2026-10-23. The v1 build order's PR 3 (milestone 1) under ADR-0035 ("build v1 live"). It is the first slice of the T3 gateway, for the Listings agent's product content only. Material choices already decided: ADR-0011 (digest-bound approval of the exact change), ADR-0022 items 3, 7, 9 and 15 (store-bound review, broker custody and the not-sent list, the lease-backed apply, the human stops), ADR-0024 items 8 to 11, ADR-0027 item 5 (product text is data), ADR-0032 item 3 and ADR-0035 item 5 (the gateway re-checks, applies, reads back and audits).
- Plan IDs: P06.T01c, P08.T03a, P11.T02a and P11.T03a (minimum), P14.T03a; the P06.T01b PR-2 routes. Supersedes the delivery plan of [M4-approve-and-apply.md](M4-approve-and-apply.md) for this slice (deviations below). Branch `claude/v1-gateway-apply`. Migrations `0039.catalog-review` and `0040.catalog-apply` (other v1 PRs also use 0039/0040; integration renumbers).

## Goal

The owner opens a proposal Listings drafted, sees each product's fields before and after, approves all of it, part of it, or rejects it, and applies the approved change to Shopify. Morrow re-checks permission, stops, plan and the product, writes each product once, reads it back and shows the result. A product changed in Shopify since the draft is not written. Nothing reaches the store while the apply switch is off.

## Scope

- **Review (0039, api reads):** `catalog_review_sources` returns, per target, the snapshot the draft was made from (or `expired`, `redacted`); `catalog_claim_of` names a family's claim (ids only). The Worker requires the proposal's read rule and `view` on `catalog.products.read` on the store resource first.
- **Routes** (`packages/work/src/review/http.ts`, a dispatch row ahead of the work API): `GET /work/approvals`, `GET /work/proposals/:id/review[?selected=]`, `POST …/decision`, `POST …/apply`, `GET /work/tasks/:taskId/operations`, `GET /work/operations/:id`, `POST /work/operations/:id/reconcile`.
- **Store-bound approvals:** the approvals library decides, reads and claims a `catalog.*` proposal on its store resource `{kind: store, id: S, storeId: S, connectionId: C}` (ADR-0022 item 3); the store must still be linked through the targets' connection (`link_changed`); Approval@2 and ApprovalRef carry the proposal's store.
- **Apply (0040, api):** `cmd_catalog_apply` consumes the exact approval once (`approval_claim`, consumer `catalog.apply`), rechecks link, installation, `write_products` and stops, opens one 15-minute operation lease and records one authorized operation per product, each bound to the digest of its exact approved item. `cmd_catalog_dispatch` rechecks lease, stops, link, installation, scope and expiry under the row lock before each product, after the Worker re-ran the claimant's kernel (with entitlement) and the claimed approval's projection.
- **Broker** (`apps/broker/src/shopify-write.ts`, `ApiBroker.shopifyProductApply` and `shopifyProductReconcile`, ids and a budget only): resolve; the item's text must hash to the operation's request digest; a pre-send read whose digest must equal the draft's `expectedSourceRevision`; the send fence committed before any request (one open write per product); one `productUpdate` of only the approved keys; the close; the read-back with per-field verdict codes, decided in SQL.
- **Switch:** `docs/decisions/shopify-write-staging.json`, committed **off**; its runtime image `MORROW_SHOPIFY_WRITE=on` on the staging api and broker only; `edge:check` refuses a mixed state.
- **Screens:** the review screen (`/w/:ws/review/:proposalId`), the Inbox's "Changes to approve", the run's "Review the changes" link and the task's "Changes applied" tab.

Non-goals: Undo and "approve several at once" (PR 4); a product picker; the Sunrise look (PR 15); editing values in place (an edit is a new Listings run, so a new proposal); any field beyond title, description, SEO and tags.

## Interfaces touched

`migrations/0039*`, `0040*` and the manifest; `packages/work/src/{review/*,approvals/*,runs/listing-*.ts,sql.ts}`; `packages/policy/src/review.ts`; `packages/identity/src/broker-protocol.ts`; `apps/broker/src/{shopify-write,capabilities,index,vault,vault-statements-catalog}.ts`; `apps/api/src/*`; `packages/workspace-ui/*`, `apps/workspace-web/*`; `scripts/{edge,boundary-checks}.mjs`; `docs/decisions/{shopify-write-staging.json,data-lifecycle.md}`; the tenant-conformance registry.

## Security notes

- **Exact approval.** The claim checks the ApprovalRef and proposal digests, revision, expiry, policy and every counted reviewer; the claimed parameters' items must equal the Worker's items (jsonb) with matching digests; the broker recomputes each item's digest before the send and refuses `request_mismatch`. Approve some is a derived proposal with its own digest; an edit is a new proposal. One claim per family.
- **Authority in code.** The claimant's own `execute` on `catalog.content.publish` (paid work) on the store resource, with entitlement from the workspace's billing facts (`claimantMayApply`, on the entitlement-writer allowlist), at the claim and before each product. The kernel's obligations must be exactly `recheck_at_dispatch`, `exact_approval` and `provider_effect_verification`; any other denies.
- **Stops.** `lease_open` refuses under any stop; a stop revokes the lease; dispatch and the fence recheck stops under the stop interlock; a stop or a disconnect between the claim and the send closes the operation `failed` with nothing sent. Read-backs are never blocked by a stop or the switch.
- **Unknown outcomes.** Only replies that prove nothing ran are `failed` (no request, THROTTLED or 429, 401, ACCESS_DENIED, userErrors: ADR-0022 item 7). THROTTLED and ACCESS_DENIED count only when every error carries that code and the reply has no mutation result (`data` absent, null or all-null fields); a partial result or mixed codes is `uncertain`. A lost reply, a 5xx, another status or GraphQL error, or a malformed reply is `uncertain` and is settled only by reading the product back: verified when every sent field equals the approved value (Shopify's known tag and HTML reformatting admitted), `partial_result` when it differs, and "no effect" only when Shopify never acknowledged the send and two read-backs 60 s apart show the drafted values with `updatedAt` unchanged. Nothing is ever sent twice; a fence a dead broker left open becomes `uncertain` after 90 s.
- **Size.** `cmd_catalog_apply` takes at most 64 KiB of items (each product's exact approved text and digest). A claim over it (for example 25 products with long descriptions) is refused in the Worker as `limit_reached` before anything is recorded; the person can approve a selection (one claim per family) and ask Listings again for the rest. Raising the bound is a one-line change to 0040 while it is unapplied (open question below).
- **Custody and records.** The store token is opened only in the broker. Operations, transitions, `operation_writes` and `operation_readbacks` hold ids, field names, codes and Shopify's `updatedAt` only (FORCE RLS; the broker's definers reach exactly the operation their own setting names). Responses and logs carry codes, never product text.

## Deviations from the M4 plan (reviewed with this PR)

1. No `OperationWorkflow`: the apply runs in the person's own requests (a 55-second budget, product by product; the same request again continues), so the lease is marked started at the claim and the cron never picks it up. An uncertain product is read back at once and again on "Check again".
2. No outbox `operation.*` event: the transitions are the audit; `approval.claimed` is recorded.
3. 403, 404 and other statuses are `uncertain`, not `failed` (ADR-0022 item 7 names only THROTTLED, 429, 401 and ACCESS_DENIED).
4. The fixtures are written from Shopify's documentation; the live shapes are checked by the owner's first applies.

## Test checklist

- [x] Digest binding, edits void approvals, a derived approval applies only its selection (`lab:catalog-apply` D1–D6; `catalog-apply.test.mjs`).
- [x] A product changed since the draft is not written (C1); the source digest equals the draft's (unit).
- [x] Stop AI work before the apply, a stop and a disconnect between the claim and the write (S1–S3).
- [x] Shopify's answers: userErrors, THROTTLED then success, 401, a 5xx and a lost reply after applying, an edit at the same moment, reformatting, a lost reply that never applied (O1–O9, N1; unit classification table).
- [x] A replay, a second tab and another claimant write nothing more; lost execute writes nothing (A5–A7).
- [x] Tenant isolation of review records and operations (V3, A5, O9; the tenant-conformance registry, S1–S8, P1).
- [x] The broker's fence, late closes, forged settings and other logins (F1–F4); the switch off writes nothing (A1, F4; unit).
- [x] The SPA's requests and decoders against the server's real replies (W1; `workspace-web-review.test.mjs`).
- [x] The review screen (pending, and approved then applied) and the task's "Changes applied" tab in `ui:check` at their widths, with the keyboard walks (local run in Edge, 2026-10-24: Playwright's pinned Chromium is not installed on this Mac; CI's `ui` job is the authority).
- [x] A claim over the items bound is `limit_reached` before anything is recorded; a selection fits (unit).
- [ ] Hosted `foundation`, the AI review (security lens) and the owner's first apply on a draft product.

## Owner actions

1. After merge and deploy, say yes in chat to switching the apply on; Claude then commits `switch: "on"` with the two vars (one reviewed commit).
2. Approve and apply your first change on a product you don't mind (a draft product is safest) and check it in the Shopify admin.

## Open question

- The 64 KiB items bound in `cmd_catalog_apply` can refuse a 25-product proposal whose descriptions average over about 2,500 characters. Recommended: raise it to 8 MiB in 0040 before it is first applied (the integration renumbering recomputes its checksum anyway); until then such a proposal is applied as a selection, and the rest needs a new Listings run.
