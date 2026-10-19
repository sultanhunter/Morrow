# Morrow MVP: the invite-only listings beta (ADR-0021)

This is the launch plan. `build-plan.md` stays the long-term roadmap and structure, but this file decides what is built before launch and in what order. Each milestone ships as feature-sized PRs, each with a one-page brief in `docs/briefs/`.

## The launch slice

1. A merchant signs up on the Morrow website.
2. They choose a plan and pay a Stripe subscription. Morrow is the seller. Stripe runs in test mode until live billing is approved.
3. They connect one Shopify store through a private, custom-distribution install link that Morrow issues per beta merchant.
4. They ask Morrow to improve product listings, for example "rewrite descriptions for my summer collection".
5. The Coordinator scopes the request and hands it to the Listings specialist.
6. The specialist drafts exact changes for each product: title, description (HTML), SEO title, SEO description and tags.
7. The draft is a Proposal@2 with a digest. The merchant reviews a per-product diff and approves the exact proposal; any edit invalidates the approval.
8. The gateway re-checks authority and credits, then applies each product update through the broker with the Shopify Admin API. It reads each product back, writes an audit record and reconciles any unknown outcome before retrying.
9. Each AI run reserves credits from the workspace's balance, and the reservation settles on completion.

## Foundation rules for the MVP

- **No rewrites later.** Each smaller MVP part uses the long-term interface:
  - one model provider (OpenAI, as selected), behind the model gateway interface;
  - one specialist and one capability family (`catalog.product.update` and its reads), in the capability catalogue;
  - one gateway, with the OperationLedger, for every Shopify write.
- **Security invariants unchanged.** The broker holds every provider and merchant credential, including Shopify offline tokens, OpenAI and Stripe keys. FORCE RLS isolates tenants. Approvals bind to the proposal digest. Permission and budget checks run in code. The kill switch is human-only.
- **Merchant data** arrives only after its deletion path works: Shopify's `customers/data_request`, `customers/redact` and `shop/redact` webhooks, plus `app/uninstalled`. The MVP stores product data and the store link, and no customer data.

## Milestones

| # | Milestone | Delivers | Waits on |
| --- | --- | --- | --- |
| M1 | **Staging live** | The merge train (all built branches); P04.T01j; P05.T01ab; a trimmed P04.T01i PR-B (deploy after green CI, migrations, roles, secrets); staging bring-up; owner sign-in on staging. | Owner secrets (D9) |
| M2 | **Shopify connect** | The connector Worker: OAuth install for a custom-distribution app, HMAC and session-token checks, the offline token encrypted and held by the broker, the install handoff linking the store to the workspace (P05.T03a/P09.T02a), compliance webhooks, uninstall, and product reads through the Admin GraphQL API. Development store only. | Shopify Partner account, dev store and app (owner) |
| M3 | **Listings agent** | A minimal model gateway (OpenAI through the broker, `store:false`, token, step and cost caps); the Coordinator's bounded route to the Listings specialist; a structured-output schema for listing changes; proposal creation with digest; credit reservation per run. | OpenAI API key with a budget cap (owner) |
| M4 | **Approve and apply** | The review UI (per-product diff, approve or reject); the gateway's `catalog.product.update` execution through the broker; read-back; the OperationLedger (P06.T01c minimum) with unknown-outcome reconciliation; the audit trail and run history in the UI. | M2, M3 |
| M5 | **Billing** | Stripe Checkout for the subscription (test mode); verified webhooks in the broker; entitlement and monthly credit grants (P01.T04a rules); the plan and usage page. | Stripe account in test mode (owner) |
| M6 | **Beta readiness** | A clean production environment from the staging config; a custom domain; privacy policy and terms pages; the minimal deletion path (P09.T05 subset); support email; error alerts; invite flow and onboarding; a smoke test on a real beta store with owner approval. | Domain, legal pages, live keys (owner) |

M2, M3 and M5 can be built in parallel once M1 is live. M4 joins M2 and M3.

## Owner actions, in the order needed

1. **Now:** the D9 secrets:
   - the Neon project key;
   - the two Cloudflare tokens;
   - a new WorkOS key;
   - the GitHub environment secret.
2. **For M2:** a Shopify Partner account; a fresh development store (never the live shop); a custom-distribution app in the Partner dashboard. Claude prepares the app's settings, and the owner creates it and stores its secret with `morrow_put`.
3. **For M3:** an OpenAI API project for staging with a hard budget cap, its key stored with `morrow_put`.
4. **For M5:** a Stripe account in test mode, its restricted key and webhook secret stored with `morrow_put`.
5. **Before taking money (M6):**
   - Stripe live activation and the business entity;
   - tax registrations, where needed;
   - written confirmation of Shopify's rules for charging custom-distribution installs;
   - a domain;
   - legal pages.

## Deferred until after launch (ADR-0021 item 4)

- The Shopify App Pricing route and the App Store listing.
- Multi-store work and allocation.
- The Chief of Staff and CMO installations.
- E2B execution.
- Collaboration surfaces beyond the slice: conversations, inbox and projects UI.
- Capabilities other than product listings.
- Heavy fault and soak suites.
- Elaborate staging tooling (rollback guards, kill-race drills).
- The remaining packages' breadth.
