# ADR-0025 Shopify public app: distribution, the embedded home, session-token identity, expiring tokens, scopes and protected data

- Status: Proposed
- Date: 2026-10-23
- Supersedes: none.
- Amends: ADR-0022 summary item 4 and decision items 3 (the store-link template), 4, 5, 7 (credentials) and 14 (the topic list); ADR-0008 item 5; the Shopify row of `providers.json`. Adopts the plan's connection-steward rule.
- Implements: ADR-0023 decisions 2 (as billing option A amends it) and 4.
- Does not change: ADR-0005; ADR-0007 item 9 and residuals R1 and R2; ADR-0015's routes; ADR-0022 items 6 and 15; build-plan invariant 23; the CLAUDE.md embedded-home constraint.
- Terms: the Owner, as in ADR-0024.
- Unblocks: P08.T02 (P08.A02), P09.T01 to P09.T05, P14.T01; tracks T2, T7, T8 (both security packets), T12, T13, T14, T15, T17; gates G3, G8, G9, G11, G13, G15.

## Context

The owner approved decisions 2 and 4 ("yes to all recommended", Q12) and the minimal embedded home of option A ("yes to both, go with option A and specialists", Q14). ADR-0023 cites Shopify's rules; T8 re-reads them before code. `main` has one custom app per store (0026) with a non-expiring token, and a store-link template granting catalogue capabilities only.

## Decision

1. **Distribution.** One merchant-facing public app, `morrow`, submitted at G13 and unlisted at launch (owner question 3). One never-submitted development app, `morrow-staging`: the "development app" that staging card 2 (ADR-0023 decision 10) names. The duplicate-app rule concerns apps offered to merchants; `morrow-staging` is never offered and, unapproved, installs only on development stores. No custom app, the owner's store included; existing custom rows retire at uninstall with the `expiring: "0"` exchange. `store_not_development` lifts on `morrow` only after approval, under the live-store ADR (G15). The registry refuses `production` until production custody is approved.
2. **Install and link** (replaces ADR-0022 item 5's rule). Install starts on Shopify by managed installation, recording an `unlinked` installation with no token. "Set up Morrow" opens a single-use, 5-minute handoff on the standalone origin, where the person signs in with WorkOS and confirms a server-built link document; only the Owner links. The embedded page completes it with a fresh session token, and the link commits only with the first sealed token from the broker's exchange. The linker becomes the connection steward; if the steward leaves, the Owner gets an exception. The `morrow_direct`-only rule goes.
3. **The embedded home** (amends ADR-0008 item 5). Served with App Bridge at `/shopify/a/:appKey/home` on the connector hostname, which never receives `__Host-` cookies. It holds only the four parts that ADR-0023 decision 2 and CLAUDE.md name:
   - **setup:** link state, "Set up" or "Sign in", and optional-scope requests (item 6);
   - **connection status:** health and reconnect (item 5);
   - **plan:** the plan's name and status, the credit balance, and a link to Shopify's plan page only, never Stripe;
   - **pending approvals:** filtered by the member's grants and read tags; approve and reject only if owner question 1 is accepted.

   Without a member session it shows installation facts only. All else, stops included, stays in the workspace (owner question 4). The page is served only after the broker verifies the launch `id_token`, with `no-store`, `frame-ancestors` naming only the verified shop and `admin.shopify.com`, `default-src 'none'`, and scripts only from `'self'` and App Bridge's CDN; anything else gets `frame-ancestors 'none'`. The connector relays a closed list of calls to the api and decides nothing.
4. **Session-token identity** (security packet). The broker verifies every token (HS256, `aud`, `exp` and `nbf` with 5 s leeway, matching `iss` and `dest`, at most 2 KiB) and records each verification under its own role; embedded admission accepts only a recorded one, so a compromised api cannot mint an embedded context. The member comes only from an embedded member session opened by item 2's WorkOS handoff, never from a Shopify role or an email match; its length is owner question 2. Every call re-runs the kernel.
5. **Expiring offline tokens** (security packet; replaces ADR-0022 item 4's token). A vault kind `shopify_expiring_offline_token`, readable only by the broker, holds both tokens; none reaches logs, Workflows, Queues, other Workers, a model or the VM. Acquire, refresh and scope revoke run under a per-installation lease fenced by generation: refresh near expiry, once after a 401, and weekly from an ids-only sweep. Each is a broker-only ledger row, marked sent under a row lock and `succeeded` only when a validated pair is sealed with the new vault version. A refusal means `reconnect_needed`; an unknown outcome is reconciled once with the same refresh token, then `reconnect_needed`, never promoted. The steward or the Owner reconnects through a server-built document.
6. **Scopes and event topics** (replaces ADR-0022 item 4's scope line). Required: `write_products`, `read_inventory`, `read_locations`, `read_legal_policies`, `read_online_store_pages`. Optional, requested when an agent needing them is installed and revoked (ledgered) when none does: `write_files` (Listings); `read_orders` (Analyst, Inventory, Support); `read_customers`, `read_returns` (Support); `write_discounts` (Marketing). Nothing else at launch. Event topics: `products/create`, `products/update`, `products/delete`, `inventory_levels/update`, and, under `read_orders` only, `orders/create`, `orders/updated`, `refunds/create`. A fixed per-topic minimiser runs before storage: products keep ids and `updated_at`; inventory the item, location and quantity; orders the ids, dates, lines, totals, refunds and statuses, never a customer, address, email, phone or note. Other deliveries are dropped after the HMAC check. Receipts stay 7 days (ADR-0031 item 1).
7. **Store-link template v2** (amends ADR-0022 item 3). Each optional-scope grant issues the Owner, in the same transaction, the capabilities it enables with their template verbs and `delegate`: `orders.read`, the `support.*` capabilities, the discount or the file capabilities. Losing the scope revokes them. ADR-0024 item 2 and ADR-0028 item 4(c) rely on this. New `lab:group:pg-linking` cases: exactly the mapped set, revoked with the scope, nothing for a Member, no direct call.
8. **Protected customer data.** Level 1: the Analyst and Inventory read 60 days of orders through fixed broker documents that select no name, email, phone or address. Level 2, name and email only, for Support, in the first submission; only Support's runs receive these fields, never the Coordinator, a specialist, the VM or a viewer without the tag. If Shopify refuses Level 2, Support slips. Nothing is stored before its class's deletion path (G9).
9. **Compliance topics** (replaces ADR-0022 item 14's topic list). Both apps subscribe to `customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled` and `app/scopes_update`. `app/uninstalled` destroys the token at once. What handlers delete, when a request completes, and the export to the Owner are ADR-0031 item 3's.

## Security invariants touched

None is weakened.
- **Tenant isolation:** the shop comes from a verified token (`lab:tenant-conformance`, `lab:group:pg-linking`).
- **The intersection:** scopes bound it; a Shopify role adds nothing (`lab:agent-authority-workers`).
- **Digest-bound approvals:** same review documents (`lab:approval-records`).
- **Reconcile before retry:** token operations (`lab:shopify-token-custody`, new).
- **Broker-only credentials:** `verify:boundaries`, `broker-vault.test.mjs`, `broker-shopify.test.mjs`.
- **Default deny:** `connector-worker.test.mjs`.
- **No real data before deletion; never the owner's store:** `lab:shopify-privacy`, `lab:shopify-install`.
- **Immutable migrations:** `migration-history.test.mjs`.

## Consequences

- Owner steps (G3): the Partner account, `morrow-staging`, development stores, Level 1 and 2 access. G8 asks whether this home meets requirement 2.2.2.
- Accepted: App Bridge loads unpinned from Shopify's CDN, on an origin with no cookie.

## Alternatives considered

- **A token at install:** credentials for shops no workspace owns.
- **All scopes required:** fails requirement 3.2.

## Owner questions

1. **May a member approve or reject from the embedded home?** *Recommendation: yes,* through the same digest-bound documents and typed confirmation, under item 4's session.
2. **How long does an embedded member session last?** *Recommendation: ADR-0004's limits,* 30 minutes idle and 12 hours absolute.
3. **When does the app become listed?** *Recommendation: unlisted at launch;* listing is decided after 30 clean paid days.
4. **May the embedded home engage "Stop AI work"?** It is outside the four parts CLAUDE.md names. *Recommendation: no;* it links to the workspace's stop. "Yes" would amend that CLAUDE.md constraint.

## Approval

Pending. The owner's answers will be quoted here verbatim with their dates.
