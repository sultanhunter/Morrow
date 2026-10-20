# ADR-0022 MVP contracts: listings authority, Shopify, Claude and Stripe usage, broker custody, background tenancy and retention

- Status: Accepted 2026-10-19 (owner decisions in chat; see Approval), including the model catalogue values, which the owner confirmed the same day ("Owner confirmation of the catalogue values (2026-10-19)")
- Date: 2026-10-19 (revised after two AI critiques, same day; model provider, model choice and credit weighting revised on acceptance; gateway, outcome, catalogue and failed-product rules revised after a third AI critique, same day; catalogue values confirmed by the owner, same day)
- Amends: ADR-0007 items 1 and 4 (connector hostname; Shopify, Anthropic and Stripe credentials in the broker under trust model v1, development and staging only); ADR-0019 item 2 (a second public Worker); ADR-0010 item 2 (a lease context for background work, beside the unchanged session context); contract v1.1 (`ResourceRef` gains kind `store`; `Operation@2` allows a taskless billing operation); the Shopify row of `docs/decisions/providers.json` (custom distribution for the beta); the model provider of the 2026-10-14 stack selection (the plan's "Hosting decision" and "Merchant model gateway", `docs/decisions/model-selection.md`, `model-policy.json`, `providers.json` and `provider-bindings.json`): Anthropic Claude replaces OpenAI for text models (item 10), and OpenAI keeps only the post-launch image capabilities.
- Amended: items 3, 9 and 11, 2026-10-20 (enabling the Listings agent; Stripe webhook ingress; credit rollover in the beta). See Amendments.
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
5. Staging and production both pay through Stripe (test mode for now). There is no free test shortcut.
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
    - **Adapters.** Claude, through the Messages API with the official SDK, is the first and only adapter. Another provider is one adapter, one broker credential and one catalogue entry, with no change to callers or contracts; selecting it is material and needs an owner-approved ADR.
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

1. **The broker records a receipt.** The broker verifies Stripe's signature, then records the event as a receipt through definers on its own login, `morrow_vault_broker`. Recording is that login's only billing write. It stores the receipt and its object digest. The tenant comes only from the Stripe customer mapping recorded when the workspace's own session-authorised checkout created the customer. The vault login never applies a payment, fixes a route or grants credits.
2. **The api Worker applies the receipt.** The api Worker's login, `morrow_api_worker`, applies the receipt through `receipt_begin`, `receipt_apply` and `receipt_status`:
   - They refuse any work session context.
   - They accept only a recorded receipt with a matching digest, and take the tenant from that receipt.
   - They re-derive the payment key, mode and credit units in SQL from `billing_terms`.

   `morrow_api_worker` cannot insert or modify receipts or customer mappings.

Every session definer stays session-only. Like the connector's compliance definers (`shop/redact` and uninstall; spine §11), these definers write only the tenant that a verified provider event names.

Owner decision, 2026-10-20, in chat. The question was: "How should a verified Stripe payment be written into a workspace? Stripe webhooks arrive with no signed-in user." The owner answered: "Receipt-only path (Recommended)". The option read: "The broker verifies Stripe's signature and records a receipt. The database applies it only from that receipt: it finds the workspace from the Stripe customer and recomputes the plan and credits itself. No browser session is involved. Recorded as a short ADR-0022 amendment." The alternative not chosen was that the broker's vault login also writes the billing records directly.

### 2026-10-20: item 11, credit rollover in the beta (M5 PR-1)

Unused monthly credits roll over. Each paid period grants 300 credits with no expiry (`CreditGrant.expiresAt` null), and credits are spendable only while the subscription is active. This is revisited before live money (M6).

Owner decision, 2026-10-20, in chat. The question was: "During the beta, do unused monthly credits roll over?" The owner answered: "Roll over in beta (Recommended)". The option read: "Unused credits stay available while the subscription is active (300 are added each month). We revisit this before taking real money (M6). The billing rules library already works this way."
