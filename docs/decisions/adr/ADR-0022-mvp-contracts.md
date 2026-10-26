# ADR-0022 MVP contracts: listings authority, Shopify, Claude and Stripe usage, broker custody, background tenancy and retention

- Status: Accepted 2026-10-19 (owner decisions in chat; see Approval), including the model catalogue values, which the owner confirmed the same day ("Owner confirmation of the catalogue values (2026-10-19)")
- Date: 2026-10-19 (revised after two AI critiques, same day; model provider, model choice and credit weighting revised on acceptance; gateway, outcome, catalogue and failed-product rules revised after a third AI critique, same day; catalogue values confirmed by the owner, same day)
- Amends: ADR-0007 items 1 and 4 (connector hostname; Shopify, Anthropic and Stripe credentials in the broker under trust model v1, development and staging only); ADR-0019 item 2 (a second public Worker); ADR-0010 item 2 (a lease context for background work, beside the unchanged session context); contract v1.1 (`ResourceRef` gains kind `store`; `Operation@2` allows a taskless billing operation); the Shopify row of `docs/decisions/providers.json` (custom distribution for the beta); the model provider of the 2026-10-14 stack selection (the plan's "Hosting decision" and "Merchant model gateway", `docs/decisions/model-selection.md`, `model-policy.json`, `providers.json` and `provider-bindings.json`): Anthropic Claude replaces OpenAI for text models (item 10), and OpenAI keeps only the post-launch image capabilities.
- Amended: items 3, 9 and 11, 2026-10-20 (enabling the Listings agent; Stripe webhook ingress; credit rollover in the beta); items 3 and 12, 2026-10-21 (the linking owner is the founding principal; closing an unknown Stripe customer-create outcome by operator attestation); item 5, 2026-10-21 (the staging test entitlement); items 2, 3 and 9, 2026-10-22 ("Disconnect store"; the maintenance sweep), recorded from M2 PR-3's owner decisions 8 and 11; items 10 and 9, 2026-10-22 (the Claude adapter by hand-written fetch; closing stale runs), recorded from M3 PR-2's owner decisions 3 and 4. The owner confirmed the answer quoted for the 2026-10-22 entries in the main session the same day. See Amendments.
- Does not change: ADR-0007 item 9 (production custody needs its own ADR before M6); ADR-0020 (no new membership pair or owner role); ADR-0015 (both routes stay; the MVP uses only Morrow-direct); ADR-0005 (kill switches stay human-only).
- Affects: `docs/briefs/mvp-architecture.md` (the spine) and the M2–M5 briefs; `docs/plan/mvp.md` and `docs/plan/build-plan.md`; `docs/contracts/capabilities.json`; contract v1.1 (or v1.2 if frozen first); `migrations/`; `apps/broker`, `apps/shopify-connector`, `apps/workers`, `apps/api`; `docs/decisions/{providers.json, provider-bindings.json, model-policy.json, model-selection.md, data-lifecycle.md}`; `docs/research/sources.json`.

## Context

ADR-0021 launches an invite-only listings beta on the production-grade foundation. Under its item 5, only choices about authority, tenancy, security, money, provider usage, public contracts or data retention need an ADR. This record collects every such choice in the spine, so one owner answer unblocks M2–M5. Two separate-context AI critiques (same model family) checked the first draft against the code and the provider documentation; this revision folds in their findings and removes parts the beta does not need.

Facts it relies on, read 2026-10-19:

- Custom distribution serves one store (or one Plus organisation), cannot use Shopify app billing, and cannot change distribution later ([distribution](https://shopify.dev/docs/apps/launch/distribution)). Expiring offline tokens are required for public apps and optional for custom apps ([offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens)).
- The policy kernels allow a request only when a grant's scope lists that exact resource (`packages/policy/src/index.ts`, `agent-authority.ts` `scopeCovers`). No resource kind means "this store".
- Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`) have 1M-token context windows and 128K-token output limits, and cost US$0.10/0.50, US$2/10 and US$4/20 per million input/output tokens; Haiku 5.5 costs US$0.50/2.50 for prompts over 100,000 tokens. Every Claude model ID is a pinned snapshot ([models](https://platform.claude.com/docs/en/about-claude/models/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing); sources S149, S150).
- Thinking on these models is adaptive and steered by `output_config.effort` (`low`, `medium`, `high`, `xhigh`, `max`); the API default is `medium` on Opus 5.5 and Haiku 5.5 and `high` on Sonnet 5.5. `budget_tokens` is not accepted, and `thinking: {type: "disabled"}` is refused on Opus 5.5 and Sonnet 5.5. Thinking tokens are billed as output and count toward `max_tokens`, the hard cap on a request's output ([effort](https://platform.claude.com/docs/en/build-with-claude/effort), [thinking cost](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost); S151, S152).
- Structured outputs (`output_config.format`) accept a JSON Schema subset: objects need `additionalProperties: false`, and string-length and numeric bounds are not supported. A `refusal` or `max_tokens` stop may return output that does not match the schema ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs); S156).
- A request at an organization or workspace spend limit returns HTTP 400; a 429 is a rate limit or the usage tier's spend cap; a Console workspace can carry its own monthly spend limit and workspace-scoped API keys ([errors](https://platform.claude.com/docs/en/api/errors), [workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces); S157, S158). Token counting is free and returns an estimate ([token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting); S159).
- Stripe does not copy Checkout Session metadata to the Subscription or Invoice; only `subscription_data.metadata` reaches the invoice.

## Summary for the owner

Accepting this ADR means:

1. Listings uses the existing catalogue permissions. Merchants and the Listings agent get permissions for the whole connected store, not product by product.
2. The Listings agent is switched on by the owner with an explicit "Enable Listings agent" action. It can read and draft, and propose changes. Only a person approves and applies.
3. The Coordinator routes in code for the beta (no extra AI call). A model router can replace it later without changing the records.
4. Each beta store gets its own private Shopify app. Its token never expires (simpler for the beta); app secrets and tokens sit encrypted in the broker's vault.
5. Staging and production both pay through Stripe (test mode for now). There is no free test shortcut. (Amended 2026-10-21: while the Stripe switch is off, an operator may put one named staging workspace on the beta plan, approved and recorded per use; production still needs a real Stripe payment. See Amendments.)
6. A store write is sent at most once. If Morrow does not know whether it worked, it reads the product back and never resends.
7. Background work runs under short leases that select the tenant but grant nothing. The policy check runs again at every step. Signing out does not stop an apply already started; losing membership or permissions, or a stop, does.
8. Claude (Anthropic) drafts one product per call with a strict output schema, through a model gateway that does not depend on any one provider: another LLM is one more adapter and catalogue entry. There is no silent fallback to another model or provider. Each environment's Anthropic Console workspace has a monthly spend limit.
9. Merchants choose the model and the thinking effort for each run, or keep the workspace default. The choice is checked on the server against a versioned catalogue: Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 at low, medium or high effort, with Sonnet 5.5 at low effort as the default, and a ceiling that limits members without the owner's model permission to one credit per product unless the owner raises it.
10. One credit drafts one product. A run reserves at most US$7 of AI cost and a workspace at most US$25 a day, whatever the choice. Other choices cost 1 to 6 credits per product, from a published, versioned table, and every choice's worst case stays within 90% of its credits' revenue after all fees; products that fail are not charged, a run stops after three failed products in a row, and each workspace's unpaid AI cost of failed products is capped at US$4.50 per billing period.
11. Stripe: one plan (US$49 a month with 300 credits), Checkout and the customer portal, a pinned API version, and tax-ready settings switched on at live launch. Refund and dispute handling waits for M6, before live money.
12. Stops: the owner's "Stop AI work" and "Disconnect store" kill switches, plus a platform stop the owner sets by script. Automatic stops (uninstall) are system records, not kill switches. Only people lift stops.
13. Product data is deleted on Shopify's request, including drafts held in approval records. Customer data is never stored, and only the merchant's request and the product's catalogue fields are sent to Claude.
14. A solo owner sees one "Approve and apply" button; the server still records the approval and the apply as two commands, each checked on its own.

## Decision

1. **Listings capability.** The existing catalogue entries: `catalog.products.read` (read), `catalog.content.propose` (draft), `catalog.content.publish` (store write: `external_write`, `agent_after_approval`, review required, risk `external`). `mvp.md`'s `catalog.product.update` means `catalog.content.publish`. Both content capabilities add `tags`. FieldPaths: `title`, `descriptionHtml`, `seo.title`, `seo.description`, `tags`. A product's `ResourceRef.id` is `product:<numeric GID tail>`. Every listings proposal carries `contextTaint: untrusted_external`, because the run reads product text that third parties may have written.
2. **Contract additions** (v1.1 candidate edits, else v1.2):
   - `ResourceRef.kind` gains `store` (`id` equals `storeId`, with its `connectionId`);
   - `Operation@2`: `taskId` may be null only for a `governance.billing.manage` operation (the ADR-0018 pattern);
   - `CatalogContentChangeSet@1` (proposal parameters), `ListingDraft@1` (model output; a strict model schema `ListingDraft_v1` is generated from it), `CoordinatorRoute@1` (a run record), `ModelCall@1` and `ModelResult@1` (internal and provider-neutral: neither names a provider, provider model ID, token limit or price; `ModelCall@1` is closed and carries no model selection or catalogue version, which the broker reads from the run (item 10); `ModelResult@1` outcomes include `incomplete`, `refusal`, `spend_limit`, `provider_error` and `uncertain`, and it carries an opaque `traceRef` to the run manifest's call entry instead of provider IDs), `ModelSelection@1` (`{model, effort}` as opaque keys matching `^[a-z][a-z0-9_]{0,39}$`, not enums: the server checks them against a catalogue version (item 16), so adding a model, an effort or a catalogue version changes no contract, the registry approach of ADR-0016 item 6), `StopRecord@1` (system and operator stops);
   - the capability `governance.billing.manage` (`control`, `human_only`, review not required, not paid work), as P01.T04a §4.3 specified, and `governance.model_default.revise` (same classification) for the workspace's default model selection;
   - the public endpoints `/shopify/a/:appKey/{launch,callback,webhooks}` on the connector host and `POST /api/billing/stripe/webhook` on the api, plus the additive routes in the briefs.
3. **Authority.**
   - **Store resource.** Catalogue permissions are evaluated on the store resource `{kind: "store", id: S, storeId: S, connectionId: C}`. That is the resource for run admission, catalogue reads, every agent step, the claim and dispatch. Code then checks that every product target has the same store and connection.
   - **Signup template v2** adds `governance.billing.manage` {view, execute} and `governance.model_default.revise` {execute}. A forward migration backfills existing owner memberships.
   - **Store-link template**, applied in the link transaction to the linking owner, on the store resource: `catalog.products.read` {view, delegate}; `catalog.content.propose` {execute, delegate}; `catalog.content.publish` {propose, approve, execute, delegate}; `agents.installation.activate` {execute}.
   - **Listings installation.** Created and activated only by the owner's "Enable Listings agent" command for a linked store. In the same transaction the owner issues the installation's grants (`catalog.products.read` {view}, `catalog.content.propose` {execute}, `catalog.content.publish` {propose}) and receives `agents.installation.disable` {execute} on it. No agent ever holds `approve` or `execute` on `catalog.content.publish`.
   - **Coordinator.** One built-in agent principal per workspace, deterministic code in the beta. Run admission creates the envelope on the merchant's task, a child task for the installation, one hop, and a `workspace.task.delegate` {delegate} grant for the Coordinator on the parent task that expires with the envelope, issued by the requester.
   - **Approve and apply.** For a solo owner the review screen shows one "Approve and apply" button. It sends the digest-bound approval decision and then the apply claim as two server commands; each runs its own kernel, digest and stop checks, and a failed claim leaves the approval recorded.
   - **Agent records.** `morrow_identity.grants` admits agent principals (`membership_id` null only for kind `agent`). `proposals` admits an agent proposer (`proposer_membership_id` null only with an installation). Agents submit through their own definer, never the human submit path.
4. **Shopify access.**
   - One custom-distribution app per beta store: non-embedded, authorization code grant, Admin GraphQL `2026-10`, scopes `read_products` and `write_products`. Granted scopes are compared as expanded sets (a write scope implies its read).
   - Non-expiring offline tokens for the beta. Refresh arrives with public distribution, as a new credential kind in the same vault.
   - Webhooks `app/uninstalled`, `app/scopes_update`, `customers/data_request`, `customers/redact` and `shop/redact`; no product topics.
   - Per-app URL paths keyed by a Morrow app key. Each app's client secret is stored encrypted in the vault, one row per app, written by an owner-run script; there is no shared secret list.
   - Development stores only until M6.
5. **Linking rule.** Workspace-first only, in every environment. A store's install link is shown, and the link transaction succeeds, only for a workspace whose route is fixed to `morrow_direct`. Staging pays in Stripe test mode; the MVP does not use `TestEntitlementSeed`. An install that matches no registered app and invited workspace creates nothing.
6. **Connector hostname.** The connector Worker has its own public hostname (workers.dev on staging, a custom subdomain in production), so `__Host-` session cookies never reach it. The broker and orchestrator stay unrouted. A staging card change is needed.
7. **Broker trust model v1 and credential custody** (development and staging; production needs ADR-0007 item 9):
   - One `WorkerEntrypoint` per caller (`ApiBroker`, `ConnectorBroker`, `RuntimeBroker`), each exposing only its methods. RPC carries ids, strings and budgets; the broker loads installations, operations, prices and customer mappings from the database itself.
   - Every Shopify and model call names a live lease, or an operation under reconciliation, checked in the database with the stop state.
   - A Shopify write runs only for an operation in `dispatching`, with input from the claimed proposal's stored parameters. Under a row lock the broker marks the send as started before calling Shopify, and refuses a second send for that operation. Any failure after the mark is `uncertain` and is resolved by readback only. A reply that proves nothing ran (`THROTTLED`, 429, 401, `ACCESS_DENIED`) is "not sent".
   - Vault: AES-256-GCM with a per-record data key wrapped by a versioned KEK held only in broker secrets; AAD (environment, organization or platform, record id, provider, version). The owner keeps an offline KEK backup. Tokens are destroyed at uninstall or disconnect.
   - Credentials admitted: Shopify app secrets and offline tokens, `ANTHROPIC_API_KEY` (a key scoped to the environment's Anthropic Console workspace), `STRIPE_RESTRICTED_KEY`, `STRIPE_WEBHOOK_SECRET`.
8. **Database roles.** Three membership-free executor logins on the P05 pattern: `morrow_connector_ingress` and `morrow_runtime_executor` (leased by `neonLease`) and `morrow_vault_broker` (the broker's own, never leased). Each executes only its own definers, guarded by `executor_memberships_closed(session_user)`. The ADR-0020 closed set and owner roles are unchanged.
9. **Tenancy for background work.**
   - `morrow_work.current_tenant()` and every session definer stay session-only and unchanged.
   - Api commands create leases inside the session transaction that authorised the work: read 60 s, run 30 min, operation 15 min. `morrow_work.enter_lease` runs only when `session_user` is `morrow_runtime_executor`. Only new runtime definers and new tables' policies read the lease context.
   - A lease selects the tenant and fences generations; it grants nothing. The kernel reruns at every step. At dispatch, the claimant's authority is evaluated with "operation lease current and membership active" in place of a browser session. Sign-out does not stop a claimed apply; membership removal, grant revocation and stops do.
   - Readback of an operation already `submitted`, `uncertain` or `verifying` is keyed by the operation, needs no live lease and is never blocked by a stop.
   - One cross-tenant sweep definer, executable only by `morrow_runtime_executor`, returns the ids of committed runs and claims whose Workflow has not started. It returns no content.
   - **Accepted residual risk:** a compromised orchestrator could act within any tenant's live leases until they expire, and can list pending ids. This is the background analogue of the ADR-0010 item 2 residual.
10. **Model gateway and provider: Anthropic Claude.**
    - **Port.** The gateway is provider-neutral. The orchestrator sends a `ModelCall@1` through broker `modelRespond(leaseId, generation, callJson, budgetMs)` and receives a `ModelResult@1`; neither names a provider, provider model ID, token limit or price.
    - **Selection source.** The broker reads the selection (model and effort) and the catalogue version from the run row bound to the lease, never from the caller. `ModelCall@1` is closed and has no selection field, so a call that names one fails validation and is refused before any request. Cost is booked at the rates of the run's catalogue version, not the version active at call time. Before sending, the broker refuses a call whose worst case (the input cap and the effort's `max_tokens` at those rates) exceeds the run's remaining vendor reservation.
    - **Adapter result.** The entry of that selection (item 16) picks a `ModelProvider` adapter. It maps the resolved call to the provider's request and returns a broker-internal `AdapterResult`: outcome, raw stop reason, output, usage (input, output, thinking and cache tokens), provider request ID and provider model ID. The broker checks it, books its cost from catalogue rates (the adapter computes no cost), records the provider IDs, stop reason and usage in the run manifest, and returns `ModelResult@1`: outcome, validated output, token usage and an opaque `traceRef` to that manifest entry. Provider IDs stay in the broker and the manifest; they satisfy the provider trace IDs of `docs/contracts/model-gateway.md`.
    - **Adapters.** Claude, through the Messages API with the official SDK, is the first and only adapter (amended 2026-10-22: by a hand-written fetch in the broker, not the SDK; see Amendments). Another provider is one adapter, one broker credential and one catalogue entry, with no change to callers or contracts; selecting it is material and needs an owner-approved ADR.
    - **No fallback.** The broker sends only to the provider and model that the catalogue entry names. It never retries on another model or provider, never sends Anthropic's `fallbacks` parameter, and treats a reply whose `model` differs from the requested ID as `provider_error`. SDK retries are off, so Morrow counts every attempt. An entry whose provider has no adapter or no bound credential is refused before any request.
    - **Claude request.** `POST /v1/messages` for the Listings specialist only (the Coordinator is code). One product per call. `output_config.format` carries the generated `ListingDraft_v1` schema; `thinking: {type: "adaptive"}` and `output_config.effort` come from the selection and are always sent, because the API defaults differ by model; `max_tokens` comes from the catalogue. Never sent: `budget_tokens`, disabled thinking, tools, assistant prefill, sampling parameters, Files, Batches, code execution, web search, `inference_geo`, fast mode or beta headers. The input is counted with the token-counting endpoint before sending.
    - **Outcomes.** Every reply and failure maps to exactly one outcome; anything unlisted is `provider_error`.

      | Reply | Outcome | Attempt and cost | Run |
      | --- | --- | --- | --- |
      | Stop reason `end_turn` | `completed`, then schema and contract validation | counted; usage booked | continues |
      | Stop reason `max_tokens` | `incomplete` | counted; usage booked | continues (the product may retry) |
      | Stop reason `refusal` | `refusal` | counted; usage booked | continues (the product may retry) |
      | Any other stop reason, or a reply naming another model | `provider_error` | counted; usage booked | ends |
      | HTTP 400 whose error names a spend limit; 429 without `retry-after`, or whose error names a spend or usage limit (the usage tier's spend cap, S157) | `spend_limit` | not counted; nothing generated | ends, without retry |
      | Any other 400; 401, 402, 403, 413; 404 (an unknown or retired model, which also raises a catalogue alarm) | `provider_error` | not counted; nothing generated | ends, without retry |
      | 429 with `retry-after`; 529 | none: nothing was generated | not counted | the step waits and resends within the run's time budget |
      | 500 (`api_error`), 504 (`timeout_error`), a client timeout or a transport loss after the request was sent | `uncertain` | counted; booked at the attempt's worst case | continues; the attempt is never treated as free |
      | A connection that fails before the request is sent | none: not sent | not counted | the step may resend within the time budget |

      An attempt's cost is booked before any retry of that product, so the reservation stays the bound and no unknown outcome is treated as free (build-plan invariant 10).
    - **Data sent.** Only the merchant's request text and the selected product's catalogue fields (title, description HTML, SEO title and description, tags). Never customer data, staff emails, the shop domain, credentials or payment data. Morrow does not store prompts or raw outputs.
    - **Anthropic data use** (S153–S155). Anthropic does not use inputs or outputs from its commercial API to train models by default; Morrow does not opt in or send feedback. Anthropic's commercial policy deletes API inputs and outputs within 30 days, and its API documentation says conversation content is not retained by default except for Covered Models (Claude Fable and Mythos), which require 30-day retention and are not in the catalogue. Content flagged by Anthropic's trust and safety systems may be kept up to 2 years, and the classification scores of flagged content up to 7 years (S154). Zero data retention needs an agreement with Anthropic's sales team; Morrow has none, so the privacy notice says "up to 30 days; if flagged by Anthropic's safety systems, the content up to 2 years and its classification scores up to 7 years". Structured-output schemas are cached up to 24 hours after their last use and contain no merchant data.
    - **Accounts.** Separate Anthropic Console workspaces for staging and production, each with a monthly spend limit and one workspace-scoped API key held only by the broker. Global routing at standard prices; US-only inference (1.1× price) only if a customer contract requires it, as a new catalogue version.
    - **Effects.** A model call is metered spend, not a store effect. It needs reservations and stops (M3 PR-1). Store writes need the M4 gateway (invariant 15).
    - **Images.** Claude does not generate images. The post-launch image capabilities (P17.T02e) keep the recorded OpenAI Images selection behind the same port; no OpenAI credential is bound for the MVP. The owner may choose another image provider by ADR before P17.T02e.
11. **Credits and spend limits** (numbers are owner-adjustable configuration; prices are Anthropic's list prices of 2026-10-19, S150). The owner approved one credit per product drafted, 25 products and US$7 of AI cost per run, US$25 per workspace per day and the beta plan, and confirmed the credit weighting, the token caps, the margin and the failed-product bounds below on 2026-10-19 ("Owner confirmation of the catalogue values (2026-10-19)").
    - One credit drafts one product at the default selection; other selections cost the published multiplier (item 16). A run reserves its product count times the multiplier and settles at the products drafted times the multiplier, never above the reservation. A product that fails earns no credit. Applying costs no credits but needs an active entitlement.
    - Run admission checks entitlement directly (`workspaceBillingState`, `entitlementFor`), because drafting is not paid work under `isPaidWork`; the agent fact reader uses the same result.
    - Caps per call: at most 8,000 input tokens (counted before sending; a product whose call would exceed it fails before any spend) and the effort's `max_tokens` (output includes thinking). At most two attempts per product and 25 products per run.
    - USD caps, whatever the selection: US$7 of AI cost per run, so a run's product limit is the lower of 25 and US$7 divided by the selection's worst case per product; US$25 per workspace per day (settled cost plus open reservations); and per environment the Anthropic Console workspace's monthly spend limit, plus the owner's platform stop.
    - **Failed products.** A failed product's AI cost is real but earns no credit, and the product text the merchant controls can make failure deliberate (another `productId`, oversized HTML, a refusal). Two code checks bound it:
      - a run stops after three consecutive failed products and releases the rest of its reservation;
      - each workspace has an unrecovered-cost cap of US$4.50 per billing period: the AI cost booked for products that earned no credit, `uncertain` bookings included. Before each product the step checks that the period's unrecovered cost plus that product's worst case stays within the cap; otherwise the run stops, and run admission refuses new runs (`unrecovered_cost_cap`) until the next billing period.

      The cap is at most the share of the plan's net revenue that the margin leaves (10% of about US$45.96), so a workspace that spends every credit at the worst case and also reaches the cap still costs less than its net plan revenue. `npm run verify` checks this.
    - Cost per product (expected: one attempt with about 3,000 input tokens and 1,200, 2,500 or 5,000 output tokens at low, medium or high effort, an estimate to be replaced by staging measurements; worst case: two attempts, each at 8,000 input tokens and the effort's `max_tokens`):

      | Model | Effort | Credits | Expected | Worst case | Products per run |
      | --- | --- | --- | --- | --- | --- |
      | Haiku 5.5 | low / medium / high | 1 / 1 / 1 | US$0.0009 / 0.0016 / 0.0028 | US$0.0066 / 0.0136 / 0.0176 | 25 |
      | Sonnet 5.5 | low (default) / medium / high | 1 / 2 / 3 | US$0.018 / 0.031 / 0.056 | US$0.132 / 0.272 / 0.352 | 25 / 25 / 19 |
      | Opus 5.5 | low / medium / high | 2 / 4 / 6 | US$0.036 / 0.062 / 0.112 | US$0.264 / 0.544 / 0.704 | 25 / 12 / 9 |

    - Margin on the beta plan (US$49 a month with 300 credits): after Stripe's 2.9% + US$0.30 card fee, the 0.7% Billing fee, 0.5% for Stripe Tax and 1.5% for an international card (the costliest live payment), a credit brings about US$0.153. Every selection's worst case must stay within 90% of its credits' net revenue. At the default, expected AI cost is about 12% of a credit's revenue and the worst case about 86%; Haiku is at most 12%, the rest 77–89%. `npm run verify` checks this for every catalogue version and reports each selection's worst case and run limit. Infrastructure is outside these figures.
    - Model usage settles against the run's `VendorCostReservation` and is recorded in its run manifest with the catalogue version, model, effort and multiplier. `UsageLiability` is not used in the MVP.
    - Beta plan (owner, 2026-10-19): US$49 a month with 300 credits.
12. **Stripe.**
    - Test mode now; live mode only after M6 activation, under per-action approval. One pinned API version in the broker and on the webhook endpoint, recorded in `providers.json`.
    - One Product and one monthly USD Price, with a tax code and tax behaviour set. One Customer per workspace, created with an idempotency key bound to its operation.
    - Subscription-mode Checkout on that customer, expiring after one hour. The operation and workspace ids go in the session metadata and in `subscription_data.metadata`. Billing address collection and `automatic_tax` are behind configuration, so live tax needs no code change.
    - Customer portal through a saved configuration: payment method, invoices, cancellation at period end; no plan switching.
    - Webhook events: `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.
    - Before live money (M6): refunds, disputes and held-payment handling; Stripe Tax registrations, or Stripe Managed Payments instead.
    - Not used: Payment Links, Pricing Tables, coupons, trials and top-ups.
13. **Retention of new data.**

    | Data | Retention |
    | --- | --- |
    | Product snapshots and run drafts | 90 days; deleted at `shop/redact` |
    | Drafted values in proposal parameters | Until `shop/redact`, which empties them and keeps the digest. This is one narrow exception to the append-only rule; a redacted proposal can never be approved, claimed or applied |
    | Webhook inbox rows | 7 days; `customers/*` rows keep only ids and a keyed digest of the customer id |
    | Workflow state and Queue messages | Ids and digests only, never content |
    | OAuth states | 7 days |
    | Privacy evidence, run manifests, leases, stop records and operation transitions | 365 days, content-free |
    | Vault tokens | Destroyed at uninstall or disconnect |
    | Model prompts and raw outputs | Not stored by Morrow; on Anthropic's side as in item 10 |
    | Stripe payment records | Ids and amounts only, for the financial-records period (7 years until the tax advisor confirms) |

14. **Compliance topics on custom apps.** The three compliance topics are subscribed and completed although Shopify requires them only of public apps. `customers/*` record "no customer data held", with evidence. `shop/redact` completes within 24 hours (30-day maximum). `app/uninstalled` takes effect at once. No non-development store links before this path passes its tests.
15. **Stops.**
    - Human kill switches (ADR-0005, `KillSwitchRecord`): `agents.installation.disable` ("Stop AI work") and `governance.connection.disconnect`.
    - System and operator stops (`StopRecord@1`): a connection stop set by `app/uninstalled`, and a platform stop set by an owner-run, audited script. They are gateway controls, not kill switches.
    - Scopes: platform, installation and connection. Stops block run admission, model calls, claims and dispatch, never readback. Only a person lifts a stop.
16. **Model catalogue and selection.** That merchants choose the model and effort is the owner's decision; the owner confirmed the catalogue's contents, default, ceiling and multipliers below on 2026-10-19 ("Owner confirmation of the catalogue values (2026-10-19)").
    - The catalogue is versioned data in `docs/decisions/model-policy.json` (`catalogue.versions`), generated into the broker and the api's checks, never into contract enums (item 2). A version is `proposed`, `active` (at most one) or `retired`. A version is published (made `active`) only with the owner's recorded confirmation, and its digest is then pinned in `catalogue.published_digests`. A published version never changes: `npm run verify` recomputes every pinned digest, so a new model, effort, multiplier, cap or price is a new version. Every run records the version it used and is booked at that version's rates, as `BillingTerms` does for prices (R10).
    - Version 1 (proposed 2026-10-19, confirmed by the owner and published the same day: `active` in `model-policy.json`, effective 2026-10-19, with its digest pinned in `catalogue.published_digests`):

      | Model key | Provider model ID | Context | Max output | Input / output per million tokens | Credits at low / medium / high |
      | --- | --- | --- | --- | --- | --- |
      | `claude_haiku_5_5` | `claude-haiku-5-5` | 1M | 128K | US$0.10 / 0.50 (prompts up to 100,000 tokens; the input cap keeps every call in this tier, checked by `npm run verify`) | 1 / 1 / 1 |
      | `claude_sonnet_5_5` | `claude-sonnet-5-5` | 1M | 128K | US$2 / 10 | 1 / 2 / 3 |
      | `claude_opus_5_5` | `claude-opus-5-5` | 1M | 128K | US$4 / 20 | 2 / 4 / 6 |

      | Effort key | Claude request | `max_tokens` |
      | --- | --- | --- |
      | `low` | `thinking: {type: "adaptive"}`, `output_config.effort: "low"` | 5,000 |
      | `medium` | `thinking: {type: "adaptive"}`, `output_config.effort: "medium"` | 12,000 |
      | `high` | `thinking: {type: "adaptive"}`, `output_config.effort: "high"` | 16,000 |

    - `xhigh` and `max` are not offered: Anthropic positions them for long-running agentic work and unconstrained token spend, which a one-product call does not need and the caps cannot bound.
    - Multipliers follow cost: Opus 5.5's prices are twice Sonnet 5.5's, so its credits are twice Sonnet's; within a model, credits follow the expected output at each effort; Haiku 5.5 costs one credit, the smallest unit. Low effort's `max_tokens` is 5,000 so that Sonnet and Opus at low effort keep the 10% margin of item 11.
    - The default is Sonnet 5.5 at low effort: Anthropic describes Sonnet 5.5 as the best combination of speed and intelligence, low effort suits a short, fully specified rewrite, and it is the cheapest Sonnet choice. Its worst case (US$0.132) stays within 90% of one credit's net revenue, while Opus at the same price per credit would not.
    - The workspace default is changed by a member holding `governance.model_default.revise` (the owner by template). On the Ask screen a merchant picks an entry of the active version for one run; the screen shows its credits per product and the run's product limit.
    - **Member ceiling.** A member without `governance.model_default.revise` may pick only entries whose credits per product are at most the workspace's ceiling (`workspace_model_defaults.max_credits_per_product`; default 1, which admits the default selection). Only `governance.model_default.revise` changes the ceiling, and its holders may pick any entry, since they could raise it. Run admission enforces the ceiling in code.
    - The api accepts only `{model, effort}` keys of the active version within the requester's ceiling; any other value, a provider model string, a retired entry or an entry above the ceiling is refused before any run is created. The Coordinator and agents never choose or change a run's selection, model output never names one, and the broker reads it from the run (item 10).

## Consequences

- M2–M5 may start on acceptance, in the order of spine §13. Every provider effect still needs per-action approval or a staging card.
- M3 PR-1 may build the authority records, the stops and one-credit-per-product reservations, and its catalogue part (the generated catalogue, `ModelSelection@1` admission, multipliers, the member ceiling, `GET /workspace/:ws/models` and the model-default route) no longer waits: the owner confirmed the list under "Owner confirmation of the catalogue values (2026-10-19)", and catalogue version 1 is published with its pinned digest.
- This change updates `providers.json` (an `anthropic` row; OpenAI narrowed to images), `provider-bindings.json`, `model-policy.json` (the catalogue), `model-selection.md`, `data-lifecycle.md`, the plan and the briefs. `npm run verify` checks the catalogue: known providers with adapters, opaque keys, adaptive thinking only, output caps within each model's limit, input caps within each tiered model's price tier, the per-call, per-run, daily and unrecovered-cost caps and each selection's run limit, every selection's worst case within 90% of its credits' net revenue after all fees, the unrecovered-cost cap within the remaining 10%, a default member ceiling that admits the default, and published versions unchanged against their pinned digests. Retention rows for the new tables land in the PRs that create them.
- Before M6: the production custody ADR (ADR-0007 item 9), Shopify's written answer on charging custom-distribution installs (ADR-0015 Risk 2), the tax advisor's retention period, the before-live-money items in item 12, the production Anthropic Console workspace and its spend limit, and the staging measurements that replace the expected-token estimates in item 11.
- Public distribution later is a new app and installation generation, with expiring tokens added as a new vault credential kind. The registry, vault and linking records already allow it.

## Alternatives considered

- **Product-by-product grants.** A scope holds at most 1,000 exact resources and never covers new products.
- **A wildcard rule in `scopeCovers`.** It changes both kernels' semantics; naming the store as the resource does not.
- **Replacing `current_tenant()` to accept leases.** Every existing session definer would then treat a lease as the signed-in human.
- **A model-based Coordinator now.** An extra call, cost and input for a route the Ask screen already fixes.
- **Expiring tokens now.** A refresh path, refresh races and 90-day expiry, for a beta that will need a new app for public distribution anyway.
- **A test entitlement seed for staging.** Its own payer path and approvals, where Stripe test mode is free.
- **An unlisted public app.** It needs App Review and Shopify billing, which conflicts with the Stripe beta.
- **Letting the broker trust its callers for writes (v0 style).** A faulty orchestrator could write arbitrary content.
- **Letting the orchestrator name the model selection in `ModelCall@1`.** A faulty orchestrator could run Opus at high effort on a run reserved and charged at Haiku low, and the manifest would misstate what ran; the broker reads the run instead.
- **Keeping OpenAI for text models.** The owner chose Claude on 2026-10-19; the gateway port keeps a later switch to one adapter.
- **A free-form model string from the client.** A client could select an unapproved, unpriced or retired model; the server's check against the catalogue version prevents it.
- **Closed enums for `ModelSelection@1`.** Every catalogue version would replace a public contract after the v1.1 freeze; ADR-0016 item 6 rejected closed enums for `EventEnvelope@2` for the same reason.
- **One fixed model and effort.** The owner asked that merchants choose models and thinking effort.
- **One credit for every selection.** Opus 5.5 at high effort would then cost up to about 4.6 times a credit's net revenue in its worst case.
- **Charging failed products a share of credits.** It departs from the approved "one credit per product drafted"; the run breaker and the unrecovered-cost cap bound the cost instead.
- **Offering `xhigh` and `max` effort.** Unbounded thinking for a one-product rewrite; the per-run cap would allow only a few products.
- **Anthropic's server-side `fallbacks`.** A refusal would silently move the call to another model, at another price.

## Owner confirmation of the catalogue values (2026-10-19)

These values were Claude's proposals within the owner's answers under Approval, and the weighting departs from the approved premise "1 credit = 1 product drafted by the AI" for every selection that costs more than one credit. On 2026-10-19, in chat, the owner was asked "Confirm these model, credit and safety values for the beta?", with the values below, and answered "Confirm all (Recommended)" (recorded under Approval):

1. The catalogue's contents: Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 at low, medium or high effort, without `xhigh` and `max` (item 16).
2. The default selection: Sonnet 5.5 at low effort (item 16).
3. Credit weighting: Haiku 1/1/1, Sonnet 1/2/3 and Opus 2/4/6 credits per product at low/medium/high effort (items 11 and 16).
4. Token caps: 8,000 input tokens per call; `max_tokens` 5,000, 12,000 and 16,000 at low, medium and high effort (items 11 and 16).
5. The margin: every selection's worst case within 90% of its credits' net revenue, counting Stripe Tax and international-card fees (item 11).
6. Failed products: no credit charged; a run stops after three consecutive failed products; an unrecovered-cost cap of US$4.50 per workspace per billing period (item 11).
7. The member ceiling: members without `governance.model_default.revise` limited to one credit per product until the owner raises it (item 16).

Catalogue version 1 is published: `active` in `model-policy.json`, effective 2026-10-19, with its digest pinned in `catalogue.published_digests`, so the M3 PR-1 catalogue part no longer waits (Consequences). This section was titled "Pending owner confirmation" before the owner's answer; the `change_policy` of `model-policy.json` still cites it by that title.

## Approval

Owner, 2026-10-19, in chat. Asked "Approve ADR-0022, the MVP design summarised above? It lets me bind Shopify, OpenAI and Stripe keys to the broker for development and staging, and start building.", the owner answered: "yes lets start buidling and we are going to use claude for the model and make sure our model module is modular so it can be switched with any LLM we already decided upon this in build plan when i was building with codex".

Asked "Which Claude model should Morrow use by default to write product listings? ...", the owner answered: "use should be able to select models and thinking efforts".

Asked about beta pricing (one plan at US$49 a month that includes 300 credits, where 1 credit = 1 product drafted by the AI), the owner answered: "$49 / 300 credits (Recommended)".

Asked whether each beta merchant gets its own private Shopify app, the owner answered: "OK for the beta (Recommended)".

Asked whether a solo owner gets one Approve-and-Apply button, still sent as two server commands, the owner answered: "One button (Recommended)".

The summary the owner approved already held one credit per product drafted, 25 products and US$7 of AI cost per run, and US$25 per workspace per day. These answers accept items 1–15, Claude as the model provider behind a provider-neutral port (item 10), and the merchant's choice of model and effort (item 16). Items 10, 11 and 16 and the Approve-and-apply bullet in item 3 were written from these answers on acceptance. The values listed under "Owner confirmation of the catalogue values (2026-10-19)" were Claude's proposals within them, put to the owner as a separate question.

Asked "Confirm these model, credit and safety values for the beta?", with the values listed under "Owner confirmation of the catalogue values (2026-10-19)", the owner answered: "Confirm all (Recommended)". This confirms every value in that list, so the whole ADR is Accepted, and catalogue version 1 was published on this answer.

## Amendments

### 2026-10-20: item 3, enabling the Listings agent (M3 PR-1)

`agents.installation.activate` is `review_required` in the capability catalogue, so the kernel attaches `exact_approval` to its execute. For a solo owner, the "Enable Listings agent" command meets that obligation the way P05.T03a meets it for the `review_required` `governance.connection.connect`, through a review bound to a server-built document:
- The server builds an installation document: the release digest, the store resource and the exact grant set. The document is bound to the actor and the session and expires after five minutes.
- The confirm command carries the document's digest and a single-use nonce. At commit it re-runs the kernel against current authority and the stop checks, and compares the digest. Any change to the release, the store or the grants invalidates the confirmation.
- The confirmation is audited.
- After the owner's own "Stop AI work" on that installation, it resumes the same way, with a fresh document and digest. Platform and connection stops are lifted only through their own paths (item 15).

Owner decision, 2026-10-20, in chat. The question was: "How should turning on the Listings agent be approved? Its permission is marked 'needs review', and ADR-0022 doesn't say how a solo owner meets that." The owner answered: "Confirm screen (Recommended)". The option read: "Enable shows exactly what the agent will get: the store, the permissions and the agent version. Your click confirms that exact document; any change invalidates it. A stopped agent resumes the same way. This follows the store-link precedent. Recorded as an ADR-0022 amendment."

### 2026-10-20: item 9, Stripe webhook ingress (M5 PR-1)

A verified Stripe payment has no browser session. It is applied in two steps.

1. **The broker records a receipt.** The broker verifies Stripe's signature, then records the event as a receipt through definers on its own login, `morrow_vault_broker`. The vault login has two billing writes: it records receipts with their object digests, and it settles the broker's own Stripe operations. Settling the customer operation records the Stripe customer mapping for the workspace whose session-authorised checkout requested it. The receipt's tenant comes only from that mapping. The vault login never applies a payment, fixes a route or grants credits.
2. **The api Worker applies the receipt.** The api Worker's login, `morrow_api_worker`, applies the receipt through `receipt_begin`, `receipt_apply` and `receipt_status`:
   - They refuse any work session context.
   - They accept only a recorded receipt with a matching digest, and take the tenant from that receipt.
   - They re-derive the payment key, mode and credit units in SQL from `billing_terms`.

   `morrow_api_worker` cannot insert or modify receipts or customer mappings.

Every session definer stays session-only. Like the connector's compliance definers (`shop/redact` and uninstall; spine §11), these definers write only the tenant that a verified provider event names.

Owner decision, 2026-10-20, in chat. The question was: "How should a verified Stripe payment be written into a workspace? Stripe webhooks arrive with no signed-in user." The owner answered: "Receipt-only path (Recommended)". The option read: "The broker verifies Stripe's signature and records a receipt. The database applies it only from that receipt: it finds the workspace from the Stripe customer and recomputes the plan and credits itself. No browser session is involved. Recorded as a short ADR-0022 amendment." The other option, not chosen, read: "The broker's vault database login also writes the billing records directly. Simpler, but it widens what that login can do."

### 2026-10-20: item 11, credit rollover in the beta (M5 PR-1)

Unused monthly credits roll over. Each paid period grants 300 credits with no expiry (`CreditGrant.expiresAt` null), and credits are spendable only while the subscription is active. This is revisited before live money (M6).

Owner decision, 2026-10-20, in chat. The question was: "During the beta, do unused monthly credits roll over?" The owner answered: "Roll over in beta (Recommended)". The option read: "Unused credits stay available while the subscription is active (300 are added each month). We revisit this before taking real money (M6). The billing rules library already works this way."

### 2026-10-21: item 3, the linking owner (M2 PR-2)

"The linking owner" in item 3's store-link template means the organization's founding principal (`organization_signups.principal_id`). Only that principal can be issued a Shopify (`shopify_oauth`) link handoff, apply the link, and receive the store-link grants on the store resource. A member who holds `governance.connection.connect` or `administer` but is not the founding principal is refused with `actor_ineligible`.

Owner decision, 2026-10-21, in chat. The question was: "ADR-0022 says the store permissions go to the 'linking owner'. M2 implements that as: only the person who created the organization can link a Shopify store and receive its permissions. Admins can't. Is that right?" The owner answered: "Founder only (Recommended)". The option read: "Only the organization's founder can link a store and gets the store permissions (read products, propose and publish listings, enable the agent). This matches a solo-owner beta and keeps authority simple. Recorded as an ADR-0022 item 3 clarification." The other option, not chosen, read: "Anyone holding the connect permission can link a store and receives the store permissions. More flexible for teams, but it widens who can publish."

### 2026-10-21: item 12, closing an unknown Stripe customer-create outcome (M5 PR-1)

A customer-create operation whose outcome stays unknown, where Stripe's records prove neither outcome, blocks that workspace's checkout. It may be closed only this way:
- an operator inspects the Stripe test account, under a per-action approval and with a live evidence record;
- the operator attests that no customer was created;
- the operation is then settled as failed (`verified_no_effect`, reason `operator_verified_no_effect`).

It is never settled as succeeded. This keeps the invariant: an unknown outcome is reconciled before any retry and is never promoted to success.

Owner decision, 2026-10-21, in chat. The question was: "Sometimes Stripe's 'create customer' call has an unknown outcome, and Stripe's records can't prove it either way. That workspace's checkout then stays blocked. M5 adds an operator path: after an inspection of the Stripe test account (approved per action), an operator attests 'no customer was created' and the operation is closed as failed. It's never treated as success. Allow it?" The owner answered: "Allow operator abandon (Recommended)". The option read: "Unblocks checkout after a recorded, approved inspection. The unknown is closed as 'failed', never 'succeeded', with a live evidence record each time." The other option, not chosen, read: "The workspace stays blocked until Stripe itself proves the outcome. Safer in theory, but a workspace could be stuck indefinitely."

### 2026-10-21: item 5, the staging test entitlement (owner decision (b))

Item 5 says staging pays in Stripe test mode. With the Stripe switch off (M5, owner decision (c) of the same day), no staging workspace can become paid, and the linking rule admits a store only into a workspace whose route is fixed to `morrow_direct`. Item 5 now also allows, on staging only, an operator test entitlement. It is not the `TestEntitlementSeed` (which fixes no route and is still unused):

- **What it is.** An operator command, `npm run staging:test-entitlement` (staging-card-1 E13), puts one named staging workspace on the beta plan without Stripe: the beta plan's 300 test credits, under the rollover rules of the item 11 amendment (no expiry; spendable while the entitlement is active).
- **The route.** It fixes the workspace's billing route to `morrow_direct` in test mode exactly as a verified payment fixes it, with the same columns and guards that a receipt's application uses, so the linking rule of item 5 then admits a store link. In place of a payment key the route records `morrow:operator_entitlement:<id>`, the key of the operator grant.
- **An operator grant, not a payment.** In one transaction it writes the Morrow-direct billing account, the operator grant record (the approval reference, the operator, the live-evidence record's path, the credits and terms revision, the period), the credit wallet funded from that grant, and the entitlement snapshot, active for 30 days. It writes no Stripe receipt, no verified payment event and no payment credit grant, and the wallet is funded by the operator grant alone.
- **Credits from the terms.** The 300 credits come from staging's terms revision 1, whose one entry is the operator entitlement's (no provider price, no offer), so the terms stay the only source of credit units (P01.T04a R10). Contract v1.1 billing gains `OperatorEntitlementKey`, a test-mode Morrow-direct variant of `WorkspaceBillingRoute` and of `EntitlementSnapshot`, and the terms' operator entry (`BillingTerms`); `CreditWallet` and `CreditGrant` are unchanged.
- **Approval per use.** Each use needs the owner's own approval in chat for that workspace, and a `docs/evidence/live/` record committed to `main` before the run. The record names the approval reference and the workspace on two labelled lines (`Approval reference:` and `Workspace:`), and the command requires each value to equal its input exactly. The command reads the record from the `origin/main` commit it has just verified (clean tree, `HEAD` at that commit, `foundation` green), as that commit's blob, never from the working tree. The record is completed with the outcome afterwards.
- **Phase open only.** Like checkout and a verified payment's fix (P01.T04a R2, R3), the grant refuses any workspace that already has a route, a store association (an installation that is or was linked), an account, a Stripe customer, a Stripe operation, a checkout or a receipt.
- **Staging only, never production.** The database refuses unless its platform configuration is marked `staging`, and it refuses every runtime login, session, lease and receipt context. The mark is enforced by the tooling, not by the database: nothing in a database proves which environment it is, so the database keeps whichever mark is written first (once, then immutable), and only `staging:seed-platform` writes one, `staging`, and only through the reviewed staging binding (the staging Neon project and branch of `staging.json`). No production tool writes a mark. Production still needs a real Stripe payment: production terms carry no operator entry (`verify:billing`), `terms_guard` refuses an operator entry unless the mark is `development` or `staging`, and a production reader refuses a test-mode route (P01.T04a R9).
- **Linked stores: a Shopify development store only.** Once the route is fixed, the linking rule admits a store link into the entitled workspace. Until the owner's M6 ADR about testing on the live store exists, a store linked to an entitled staging workspace must be a Shopify development store, never the owner's live store. This follows owner decision (a) of 2026-10-21 (`docs/briefs/M5-billing.md`): the question was "Which Shopify store do you mean by 'our own store' for testing?"; the owner answered "Our live store", whose option text read: "Your real store, with real products and customer data. Our rules forbid this until the deletion and privacy path (M6) exists, and it needs an owner-approved ADR. Testing on it would have to wait for M6." The entitlement does not change that: the settled constraints (never the owner's live shop for development; no real merchant data before its P09.T05 deletion and privacy path) stand until that ADR is approved.
  - *Enforced in code* (M2 PR-2, migration 0026 and the broker; Shopify apps exist only in development and staging, because 0026's app registry admits no other environment): the broker's install reads Shopify's `shop.plan.partnerDevelopment` with the install's own token and stores nothing for a store that is not a Partner development store (`store_not_development`, item 4), at the first install and at every re-authorisation; and `link_workspace_store` (with the handoff issuer `issue_shopify_link_handoff`) refuses a Shopify candidate whose installation is not flagged a development store (`installation_ineligible`; the issuer answers `denied`). The owner's live store is not a development store, so it can be neither installed nor linked. The flag is checked at install, re-authorisation and link time only: nothing re-reads it while a store stays linked, and the check has no end date (lifting it after the M6 ADR is its own reviewed change). A `controlled_fixture` candidate (0005's lab kind, which no staging tool or runtime path creates) is not checked.
  - *Procedure, not code:* which development store is used (a fresh Partner development store holding test products only; the flag cannot tell a development store that holds data copied from the live store); each app registration and install, under its own owner step or per-action approval; and watching a linked store that leaves development (a transfer to a paid plan keeps its link; its next re-authorisation is refused).
- **Limits.** One per workspace and one per approval; the same approval for the same workspace replays without writing. It is not renewable: after its 30-day period the workspace is no longer billable, and a later test uses a new workspace or a new owner decision. Checkout, the receipt ingress and the broker are unchanged.
- **Implementation notes (migrations `staging-entitlement-identity-bridge` and `staging-test-entitlement`).** Two implementation choices, kept deliberately after the AI review (separate context, same model family):
  - The operator function `morrow_billing.operator_test_entitlement_grant` is INVOKER, owned by the work owner and granted to nobody (the 0020 operator idiom), not a SECURITY DEFINER: only the owner's audited script reaches it, as `morrow_work_owner` inside the administrator's own transaction, and its `current_user` check stays meaningful. Its phase-open precondition (no store association) reads M2 PR-2's `morrow_identity.work_store_installations` as the work owner, so migration `staging-entitlement-identity-bridge` (by the identity owner) grants the work owner EXECUTE on that one read (ids and states only). The work owner inherits nothing from the command role, and a definer owned by the command role cannot be granted to the work owner (the ownership transfer turns that grant into the new owner's own); no runtime login, role or definer gains anything.
  - The operator grant is recorded in its own table, `morrow_billing.operator_test_entitlements`, and writes no `credit_grants` row: `CreditGrant@2` stays a record of verified payments only, and `wallet_guard` admits the wallet's first funding from the operator record of the same tenant, for its revision 2 and its exact units.

Owner decision, 2026-10-21, in chat (also recorded in `docs/briefs/M5-billing.md`). The question was: "Without Stripe, staging has no way to make a workspace 'paid', and only a paid workspace can link a Shopify store. How should a staging workspace get its beta plan?" The owner answered: "Staging test entitlement (Recommended)". The option read: "An operator command, approved and recorded per use, marks a named staging workspace as on the beta plan (300 test credits) without Stripe. Staging only: production still needs a real Stripe payment. Amends ADR-0022 item 5. Small new PR."

### 2026-10-22: items 2 and 3, "Disconnect store" (M2 PR-3; owner decision 8)

A person can end a store's connection inside Morrow, not only by uninstalling the app from Shopify. "Disconnect store" (`POST /workspace/:ws/connections/:connectionId/disconnect`, the human kill switch `governance.connection.disconnect` of item 15) needs two additions:
- **Item 3, store-link template v2.** The link transaction also issues `governance.connection.disconnect` to the linking owner. Version 1 of the template does not hold it.
- **Item 2, contract v1.1.** A `KillSwitchRecord` can name a connection as its target.

The SQL already accepts the `disconnected` end reason, its stop and its credential reason. The command, the connections screen's disconnect and "reinstall needed" states, and the `ApiBroker` half of `shopifyCredentialDestroy` are still to be built, in their own PR, not M2 PR-3. Spine §10 lists the disconnect command before any model call. Owner decision 14 of the same answer keeps that order: the disconnect lands before M3 PR-2's first model call, and M3 PR-2's model switch, committed off, stays off until then.

Owner decision, 2026-10-22, in chat, as recorded in `docs/briefs/M2-shopify-connect.md` (Open questions): the owner answered the morning report's decisions with "yes to all recommended", which approves both amendments, with "Disconnect store" built inside Morrow. The question, M2 PR-3 question (1) as the brief records it, read: "the human disconnect needs `governance.connection.disconnect` in the store-link grants (store-link template v2, an ADR-0022 item 3 amendment) and a KillSwitchRecord that can name a connection (a v1.1 contract change, an ADR-0022 item 2 amendment): approve both, or keep disconnect out of the beta (uninstalling the app from Shopify then remains the only way to end a connection)?" **Confirmed:** the owner gave this answer in the main session on 2026-10-22, verbatim: "yes to all recommended, for CI lets use our mac". What depends on it is still to be built, in its own PR.

### 2026-10-22: item 9, the maintenance sweep (M2 PR-3; owner decision 11)

Item 9 allows one cross-tenant sweep definer, which returns the ids of committed runs and claims whose Workflow has not started. A second, maintenance sweep is also allowed: it erases leftover tokens and re-drives webhook deliveries that ran out of retries. Its logins, definers and outputs are reviewed with its own PR (security lens); it is still to be built and is not part of M2 PR-3.

Owner decision, 2026-10-22, in chat, as recorded in `docs/briefs/M2-shopify-connect.md` (Open questions): the owner answered the morning report's decisions with "yes to all recommended", which approves the sweep. The decision, as the brief records it, read: "A maintenance sweep that erases leftover tokens and retries webhooks that ran out of retries (an ADR-0022 item 9 amendment)". **Confirmed**, as for decision 8 above.

### 2026-10-22: item 10, the Claude adapter by hand-written fetch (M3 PR-2; owner decision 3)

The Claude adapter calls the Messages API by a plain HTTPS fetch in the broker (`apps/broker/src/claude-adapter.ts`), not through the official SDK. The request fields, the never-sent list and the outcome table are item 10's, with these recorded deviations:
- every fetch exception is `uncertain`, because fetch cannot tell a refused connection from a lost reply;
- on the send, every status of 500 or above but 529 (not only 500 and 504), and any non-200 status below 400, is `uncertain`: a gateway or edge failure after the request was sent (502, 503, Cloudflare's 520–524) does not prove that nothing was generated (item 10's "transport loss after the request was sent" row, never a free `provider_error`);
- the free count runs on the identical body without `max_tokens`, and a count failure is `not_sent`.

The reasons are the broker's hand-written precedent (ADR-0008 item 1's Shopify checks; the Stripe calls) and headroom under the broker's bundle cap (P04.T02a-AC02). Measured for M3 PR-2, the broker was 457,561 bytes with the full SDK and 315,143 with only its Messages resource, against 249,874 with the fetch adapter, so the SDK did not fit the 256 KiB cap then in force. Under PR-0's 384 KiB cap (393,216 bytes) the integrated broker would be about 330 KB with the SDK, against 264,479 bytes with the adapter: the SDK would now fit, with about half the headroom.

Owner decision, 2026-10-22, in chat, as recorded in `docs/briefs/M3-listings-agent.md` (Owner decisions (M3 PR-2), item 1): the owner answered the morning report's decisions with "yes to all recommended", which approves this amendment. The decision, as the brief records it, read: "ADR-0022 item 10 says 'with the official SDK'. Approved as an ADR-0022 item 10 amendment: the Claude adapter is a plain HTTPS fetch in the broker, not the SDK". **Confirmed:** the owner gave this answer in the main session on 2026-10-22, verbatim: "yes to all recommended, for CI lets use our mac". `apps/broker/src/claude-adapter.ts` depends on it; the model-provider switch stays off until Disconnect store lands (decision 14).

### 2026-10-22: item 9, closing stale runs (M3 PR-2; owner decision 4)

A run left open by a stop or a lease end, which leaves no lease context, may be closed by an ids-only sweep and a close-run step, beside item 9's sweep of runs and claims whose Workflow has not started. This is still to be built and is not part of M3 PR-2. Until it lands, stale runs are closed in the workspace's own session: every stale run before each admission, and the actor's own by `POST /work/runs-reconcile`; there is no cross-tenant definer.

Owner decision, 2026-10-22, in chat, as recorded in `docs/briefs/M3-listings-agent.md` (Owner decisions (M3 PR-2)): the owner answered the morning report's decisions with "yes to all recommended". The decision, as the brief records it, read: "close runs left open by a stop or a lease end through an ids-only sweep and a close-run step, an ADR-0022 item 9 amendment". **Confirmed**, as for decision 3 above.

### 2026-10-25: items 11 and 16, the Listings default and the unrecovered-cost cap (ADR-0036)

The owner's decision of 2026-10-25 (OD-2026-10-25-1, recorded in ADR-0036) changes these lines; the text above is kept as approved. Item 16's default selection becomes Opus 5.5 at medium (4 credits a product) through catalogue version 3, which publishes on that decision while version 1 retires; the default member ceiling becomes 4, the default's credits, as 1 was Sonnet 5.5 low's (the owner confirmed it, OD-2026-10-25-2). Item 11's unrecovered-cost cap of US$4.50 per workspace per billing period is removed, with its `npm run verify` rule for every version but 1, and the owner-confirmed values 2, 6 and 7 change accordingly. The failed products' ledger, the three-failure breaker, the US$7 and US$25 caps and every other value stand.

### 2026-10-25: item 9, a lease source for a run waiting on teammate calls (ADR-0037)

The owner's decisions of 2026-10-25 (OD-2026-10-25-3, and OD-2026-10-25-4 for the values, recorded in ADR-0037 item 3(a)) change item 9; the text above is kept as approved. A Morrow run that waits on teammate calls gets one more lease source. In the same transaction as the terminal commit of the last open child run that its recorded wait names, by any path, and under a lock on the parent run, an ids-only definer, executable only by `morrow_runtime_executor`, re-issues the parent run's 30-minute run lease after re-running admission's checks: the requester's live grants, the Coordinator's fixed set, rules, stops and switches. If any check fails, the parent run ends instead. The definer returns no content and starts no run or call. The stale-run sweep skips a run whose recorded wait names an open child run.

Item 9's accepted residual widens by one case, as ADR-0024 item 6 widened it: a compromised orchestrator could resume a Morrow run that waits on a call once that call's run has ended, within the requester's live grants and Morrow's fixed set. It cannot start a run or a call. The `lab:agent-runs` cases of ADR-0037 item 3(a) cover the definer.

### 2026-10-25: items 10 and 11, credits are the only spend limit (ADR-0039)

The owner's decision of 2026-10-25 (OD-2026-10-25-4, recorded in ADR-0039) changes these lines; the text above is kept as approved. Item 10's "A run reserves at most US$7 of AI cost and a workspace at most US$25 a day" and item 11's USD caps go. A Listings run has no run or daily cap in US$, and its product limit is the version's 25 products for every selection, no longer the lower of 25 and US$7 over the selection's worst case; catalogue version 4 publishes on that decision with neither cap, and version 3 retires. Item 11's `npm run verify` sentence no longer checks per-run or daily caps. A run still holds its products times their credits before its first product, so the workspace's credits bound it; the Anthropic Console monthly spend limit and the owner's platform stop stay outside it. Failed products stay free, the three-failure breaker stays, and every selection's worst case stays within 90% of its credits' net revenue.

### 2026-10-26: item 16's models (the owner, OD-2026-10-26-5 and OD-2026-10-26-7); items 6, 7, 9 and 10 (ADR-0040 and ADR-0041)

The owner's messages of 2026-10-26 change these items, and the text above is kept as approved: item 16's models by OD-2026-10-26-5, and its effort and items 6, 7, 9 and 10 by OD-2026-10-26-7, which accepts ADR-0040 and ADR-0041 as recommended.

- **Item 16.** No Haiku, and no model cheaper than Opus 5.5, for paid users: Listings' per-product catalogue drops its Haiku 5.5 and Sonnet 5.5 entries (OD-2026-10-26-5), and `low` effort with them (ADR-0041 item 2, owner question 1), so it offers Opus 5.5 at `medium` and `high`. A published version never changes, so a new version carries it (ADR-0041 item 38; `docs/plan/harness-foundations-implementation.md` H3), and runs recorded at an earlier version stay booked at it.
- **Items 6 and 7** (ADR-0040 items 3 and 15, owner question 27). The api gains one service binding to an orchestrator entrypoint, `ApiRunStarter`, with two ids-only methods (`start` and `hint`), on item 7's one-entrypoint-per-caller pattern, and never a Workflows binding; and a WebSocket route to a live channel, one Durable Object per (workspace, principal) in the api Worker. The orchestrator stays unrouted.
- **Item 9** (ADR-0041 item 7, owner question 2). The fixed 30-minute run lease is renewed at each step after admission's checks run again, inside an absolute job envelope of 24 hours of active time or 7 days that only the requester's own act renews; waits hold no lease and resume only through a definer that re-runs admission's checks. This widens item 9's accepted residual, as the owner accepted: a compromised orchestrator could keep an admitted job acting, within the requester's live grants, until its envelope expires, but could not start a job, widen a grant or outlast a stop.
- **Item 10** (ADR-0041 items 8 and 11, owner question 10). The provider's response streams into the broker and ends there; the broker assembles each request from SQL; on-demand compaction and server-side context editing are sent behind a switch committed off, never on the same request, only after their evals pass and Anthropic's retention terms for compaction are recorded; a reply cut at `max_tokens` is resent with a notice, and `spend_limit` parks the job instead of ending it.
