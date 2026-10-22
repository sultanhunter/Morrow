# Morrow MVP: the invite-only listings beta (ADR-0021)

This is the launch plan. `build-plan.md` stays the long-term roadmap and structure, but this file decides what is built before launch and in what order. Each milestone ships as feature-sized PRs, each with a one-page brief in `docs/briefs/`, or a packet for security-heavy work.

Briefs: the shared architecture spine [`docs/briefs/mvp-architecture.md`](../briefs/mvp-architecture.md), then [M2 Shopify connect](../briefs/M2-shopify-connect.md), [M3 Listings agent](../briefs/M3-listings-agent.md), [M4 Approve and apply](../briefs/M4-approve-and-apply.md) and [M5 Billing](../briefs/M5-billing.md).

## The launch slice

1. A merchant signs up on the Morrow website.
2. They choose a plan and pay a Stripe subscription. Morrow is the seller. Stripe runs in test mode until live billing is approved.
3. They connect one Shopify store through a private, custom-distribution install link that Morrow issues per beta merchant.
4. They ask Morrow to improve product listings, for example "rewrite descriptions for my summer collection".
5. The Coordinator scopes the request and hands it to the Listings specialist. In the beta the Coordinator is deterministic code (ADR-0022 item 3).
6. The specialist drafts exact changes for each product: title, description (HTML), SEO title, SEO description and tags.
7. The draft is a Proposal@2 with a digest. The merchant reviews a per-product diff and approves the exact proposal; any edit invalidates the approval.
8. The gateway re-checks authority and credits, then applies each product update through the broker with the Shopify Admin API. It reads each product back, writes an audit record and reconciles any unknown outcome before retrying.
9. Each AI run reserves credits from the workspace's balance, and the reservation settles on completion. The merchant picks the model and thinking effort for a run from a versioned catalogue (or keeps the workspace default); one credit drafts one product. The owner confirmed the catalogue's contents, the default and the multipliers for costlier choices on 2026-10-19 (ADR-0022; catalogue version 1 is active).

## Foundation rules for the MVP

- **No rewrites later.** Each smaller MVP part uses the long-term interface:
  - one model provider (Anthropic Claude, ADR-0022 item 10), behind the provider-neutral model gateway port, so another provider is one more adapter and catalogue entry;
  - one specialist and one capability family (`catalog.product.update` and its reads), in the capability catalogue;
  - one gateway, with the OperationLedger, for every Shopify write.
- **Security invariants unchanged.** The broker holds every provider and merchant credential, including Shopify offline tokens, the Anthropic API key and Stripe keys (ADR-0022, accepted 2026-10-19, supersedes ADR-0007 items 3–4 for development and staging). FORCE RLS isolates tenants. Approvals bind to the proposal digest. Permission and budget checks run in code. The kill switch is human-only.
- **Merchant data** arrives only after its deletion path works: Shopify's `customers/data_request`, `customers/redact` and `shop/redact` webhooks, plus `app/uninstalled`. The MVP stores product data and the store link, and no customer data.

## Milestones

| # | Milestone | Delivers | Waits on |
| --- | --- | --- | --- |
| M1 | **Staging live** | The merge train (all built branches); P04.T01j; P05.T01ab; a trimmed P04.T01i PR-B (deploy after green CI, migrations, roles, secrets). The trimmed PR-B keeps `staging:kill`/`unkill` with the flag re-read around the api deploy, the ADR-0019 item 4 deploy gates 1–6 and the census at every deploy. Card effect E11 (Claude's rollbacks) is suspended until the rollback refusal exists; staging rolls forward instead. Then staging bring-up and owner sign-in on staging. | Owner secrets (D9); the Codex app suspended and the AppForge token deleted (ADR-0019 item 5 exception); Cloudflare usage alerts, or the weekly-check fallback, recorded |
| M2 | **Shopify connect** | The connector Worker: OAuth install for a custom-distribution app, OAuth state and query HMAC checks, the offline token encrypted and held by the broker, the install handoff linking the store to the workspace (P05.T03a/P09.T02a), compliance webhooks, uninstall, and product reads through the Admin GraphQL API. Development store only. | Shopify Partner account, dev store and app (owner) |
| M3 | **Listings agent** | The model gateway: a provider-neutral `ModelProvider` port with Claude (Anthropic Messages API) as its first adapter, called only by the broker; a versioned model catalogue with the user's model and effort choice (version 1 confirmed by the owner and active, ADR-0022); token, step and cost caps, with bounds on failed products. The Coordinator's bounded route to the Listings specialist; a structured-output schema for listing changes; proposal creation with digest; credit reservation per run, weighted by the selection. | An Anthropic Console workspace for staging with a spend limit; its API key placed with `morrow_put` (owner) |
| M4 | **Approve and apply** | The review UI (per-product diff; one "Approve and apply" button for a solo owner, still two server commands); the gateway's `catalog.product.update` execution through the broker; read-back; the OperationLedger (P06.T01c minimum) with unknown-outcome reconciliation; the audit trail and run history in the UI; the ADR-0005 stop controls (M3/M4: "Stop AI work" and the owner-run platform stop, human-only), in place before the first store write (invariant 15). | M2, M3 |
| M5 | **Billing** | Stripe Checkout for the subscription (test mode); verified webhooks in the broker; entitlement and monthly credit grants (P01.T04a rules); the plan and usage page. Beta plan: US$49 a month with 300 credits. | Stripe account in test mode (owner) |
| M6 | **Beta readiness** | A clean production environment from the staging config; a custom domain; privacy policy and terms pages; support email; error alerts; invite flow and onboarding; the minimal deletion path (P09.T05 subset), working before any real store is connected (invariant 16), with the inbox purge skipping rows whose privacy request is still open; reconnecting a store after an uninstall or a scope change (in M2 that ends the store's app for good, and recovery is a new Shopify app per store, an owner-approved provider resource); before live money, refund, dispute and held-payment handling and Stripe Tax (or Stripe Managed Payments); then a smoke test on a real beta store with owner approval. | Domain, legal pages, live keys (owner); the production custody ADR (ADR-0007 item 9) |

M2, M3 and M5 can be built in parallel once M1 is live and M2 PR-1 (the shared foundation) has merged. Staging smokes that link a store or run AI need M5 PR-1, because staging pays in Stripe test mode. M4 joins M2 and M3.

## Owner actions, in the order needed

1. **Now:** the D9 secrets:
   - the Neon project key;
   - the two Cloudflare tokens;
   - a new WorkOS key;
   - the GitHub environment secret.

   Also before the first staging deploy: suspend the ChatGPT Codex Connector GitHub App and delete the "AppForge Github Actions" token (ADR-0019 item 5 exception), and create the Cloudflare usage alerts or confirm the weekly Billing → Usage check.
2. **Credential custody:** done. The owner accepted ADR-0022 on 2026-10-19; it supersedes ADR-0007 items 3–4 for development and staging, so M2, M3 and M5 may bind their credentials to the broker. Its model catalogue values (the models and efforts offered, the default, credit multipliers, token caps, margin, failed-product bounds and member ceiling) were confirmed by the owner the same day, so ADR-0022 is accepted as a whole and catalogue version 1 is active.
3. **For M2:** a Shopify Partner account; a fresh development store (never the live shop); a custom-distribution app per beta store, created in the Dev Dashboard of the Partner organisation. Claude prepares the app's settings, and the owner creates it and stores its client secret with the vault script.
4. **For M3:** an Anthropic Console workspace for staging with a monthly spend limit, its API key placed with `morrow_put`.
5. **For M5:** a Stripe account in test mode, its restricted key and webhook secret stored with `morrow_put`, and the customer portal configuration saved in test mode.
6. **Before taking money (M6):**
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
- Elaborate staging tooling: the rollback refusal (card effect E11 stays suspended until it exists), the hosted kill-race drill, the keyring, rotation and rollback drills, and the p95 report (P04.T01i-AC14's hosted part, AC15–AC17 and AC19). The kill switch, the deploy gates and the census are not deferred.
- The remaining packages' breadth.
