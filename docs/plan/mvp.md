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
9. Each AI run reserves credits from the workspace's balance, and the reservation settles on completion.

## Foundation rules for the MVP

- **No rewrites later.** Each smaller MVP part uses the long-term interface:
  - one model provider (OpenAI, as selected), behind the model gateway interface;
  - one specialist and one capability family (`catalog.product.update` and its reads), in the capability catalogue;
  - one gateway, with the OperationLedger, for every Shopify write.
- **Security invariants unchanged.** The broker holds every provider and merchant credential, including Shopify offline tokens, OpenAI and Stripe keys, once an owner-approved ADR supersedes ADR-0007 items 3–4 (the credential-custody gate below). FORCE RLS isolates tenants. Approvals bind to the proposal digest. Permission and budget checks run in code. The kill switch is human-only.
- **Merchant data** arrives only after its deletion path works: Shopify's `customers/data_request`, `customers/redact` and `shop/redact` webhooks, plus `app/uninstalled`. The MVP stores product data and the store link, and no customer data.

## Milestones

| # | Milestone | Delivers | Waits on |
| --- | --- | --- | --- |
| M1 | **Staging live** | The merge train (all built branches); P04.T01j; P05.T01ab; a trimmed P04.T01i PR-B (deploy after green CI, migrations, roles, secrets). The trimmed PR-B keeps `staging:kill`/`unkill` with the flag re-read around the api deploy, the ADR-0019 item 4 deploy gates 1–6 and the census at every deploy. Card effect E11 (Claude's rollbacks) is suspended until the rollback refusal exists; staging rolls forward instead. Then staging bring-up and owner sign-in on staging. | Owner secrets (D9); the Codex app suspended and the AppForge token deleted (ADR-0019 item 5 exception); Cloudflare usage alerts, or the weekly-check fallback, recorded |
| M2 | **Shopify connect** | The connector Worker: OAuth install for a custom-distribution app, OAuth state and query HMAC checks, the offline token encrypted and held by the broker, the install handoff linking the store to the workspace (P05.T03a/P09.T02a), compliance webhooks, uninstall, and product reads through the Admin GraphQL API. Development store only. | Shopify Partner account, dev store and app (owner); the credential-custody gate: no Shopify credential is bound to the broker until an owner-approved ADR supersedes ADR-0007 items 3–4 (ADR-0022, proposed) |
| M3 | **Listings agent** | A minimal model gateway (OpenAI through the broker, `store:false`, token, step and cost caps); the Coordinator's bounded route to the Listings specialist; a structured-output schema for listing changes; proposal creation with digest; credit reservation per run. | OpenAI API key with an enforced hard limit (owner); the credential-custody gate (ADR-0022, proposed) before the OpenAI key is bound to the broker |
| M4 | **Approve and apply** | The review UI (per-product diff, approve or reject); the gateway's `catalog.product.update` execution through the broker; read-back; the OperationLedger (P06.T01c minimum) with unknown-outcome reconciliation; the audit trail and run history in the UI; the ADR-0005 stop controls (M3/M4: "Stop AI work" and the owner-run platform stop, human-only), in place before the first store write (invariant 15). | M2, M3 |
| M5 | **Billing** | Stripe Checkout for the subscription (test mode); verified webhooks in the broker; entitlement and monthly credit grants (P01.T04a rules); the plan and usage page. | Stripe account in test mode (owner); the credential-custody gate (ADR-0022, proposed) before any Stripe key is bound to the broker |
| M6 | **Beta readiness** | A clean production environment from the staging config; a custom domain; privacy policy and terms pages; support email; error alerts; invite flow and onboarding; the minimal deletion path (P09.T05 subset), working before any real store is connected (invariant 16); before live money, refund, dispute and held-payment handling and Stripe Tax (or Stripe Managed Payments); then a smoke test on a real beta store with owner approval. | Domain, legal pages, live keys (owner) |

M2, M3 and M5 can be built in parallel once M1 is live and M2 PR-1 (the shared foundation) has merged. Staging smokes that link a store or run AI need M5 PR-1, because staging pays in Stripe test mode. M4 joins M2 and M3.

## Owner actions, in the order needed

1. **Now:** the D9 secrets:
   - the Neon project key;
   - the two Cloudflare tokens;
   - a new WorkOS key;
   - the GitHub environment secret.

   Also before the first staging deploy: suspend the ChatGPT Codex Connector GitHub App and delete the "AppForge Github Actions" token (ADR-0019 item 5 exception), and create the Cloudflare usage alerts or confirm the weekly Billing → Usage check.
2. **Before M2, M3 and M5 bind credentials:** approve ADR-0022 (proposed on `claude/mvp-briefs`), or another ADR that supersedes ADR-0007 items 3–4.
3. **For M2:** a Shopify Partner account; a fresh development store (never the live shop); a custom-distribution app per beta store, created in the Dev Dashboard of the Partner organisation. Claude prepares the app's settings, and the owner creates it and stores its client secret with the vault script.
4. **For M3:** an OpenAI API project for staging with "Enforce a hard limit" switched on, its key stored with `morrow_put`.
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
