# ADR-0022 MVP contracts: listings authority, Shopify, Claude and Stripe usage, broker custody, background tenancy and retention

- Status: Accepted 2026-10-19 (owner decision in chat; see Approval)
- Date: 2026-10-19 (revised after two AI critiques, same day; model provider, model choice and credit weighting revised on acceptance)
- Amends: ADR-0007 items 1 and 4 (connector hostname; Shopify, Anthropic and Stripe credentials in the broker under trust model v1, development and staging only); ADR-0019 item 2 (a second public Worker); ADR-0010 item 2 (a lease context for background work, beside the unchanged session context); contract v1.1 (`ResourceRef` gains kind `store`; `Operation@2` allows a taskless billing operation); the Shopify row of `docs/decisions/providers.json` (custom distribution for the beta); the model provider of the 2026-10-14 stack selection (the plan's "Hosting decision" and "Merchant model gateway", `docs/decisions/model-selection.md`, `model-policy.json`, `providers.json` and `provider-bindings.json`): Anthropic Claude replaces OpenAI for text models (item 10), and OpenAI keeps only the post-launch image capabilities.
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
- A request at an organization or workspace spend limit returns HTTP 400; a Console workspace can carry its own monthly spend limit and workspace-scoped API keys ([errors](https://platform.claude.com/docs/en/api/errors), [workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces); S157, S158). Token counting is free and returns an estimate ([token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting); S159).
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
9. Merchants choose the model (Claude Haiku 5.5, Sonnet 5.5 or Opus 5.5) and the thinking effort (low, medium or high) for each run, or keep the workspace default (Sonnet 5.5, low effort). The choice is a closed list checked on the server.
10. One credit drafts one product at the default. Other choices cost 1 to 6 credits per product, from a published, versioned table. No choice loses money on a drafted product, even in its worst case; products that fail are not charged, and their cost is bounded by the caps. A run reserves at most US$7 of AI cost, a workspace at most US$25 a day, whatever the choice.
11. Stripe: one plan (US$49 a month with 300 credits), Checkout and the customer portal, a pinned API version, and tax-ready settings switched on at live launch. Refund and dispute handling waits for M6, before live money.
12. Stops: the owner's "Stop AI work" and "Disconnect store" kill switches, plus a platform stop the owner sets by script. Automatic stops (uninstall) are system records, not kill switches. Only people lift stops.
13. Product data is deleted on Shopify's request, including drafts held in approval records. Customer data is never stored, and only the merchant's request and the product's catalogue fields are sent to Claude.
14. A solo owner sees one "Approve and apply" button; the server still records the approval and the apply as two commands, each checked on its own.

## Decision

1. **Listings capability.** The existing catalogue entries: `catalog.products.read` (read), `catalog.content.propose` (draft), `catalog.content.publish` (store write: `external_write`, `agent_after_approval`, review required, risk `external`). `mvp.md`'s `catalog.product.update` means `catalog.content.publish`. Both content capabilities add `tags`. FieldPaths: `title`, `descriptionHtml`, `seo.title`, `seo.description`, `tags`. A product's `ResourceRef.id` is `product:<numeric GID tail>`. Every listings proposal carries `contextTaint: untrusted_external`, because the run reads product text that third parties may have written.
2. **Contract additions** (v1.1 candidate edits, else v1.2):
   - `ResourceRef.kind` gains `store` (`id` equals `storeId`, with its `connectionId`);
   - `Operation@2`: `taskId` may be null only for a `governance.billing.manage` operation (the ADR-0018 pattern);
   - `CatalogContentChangeSet@1` (proposal parameters), `ListingDraft@1` (model output; a strict model schema `ListingDraft_v1` is generated from it), `CoordinatorRoute@1` (a run record), `ModelCall@1` and `ModelResult@1` (internal and provider-neutral: no provider, provider model ID, token limit or price; outcomes include `incomplete`, `refusal` and `spend_limit`), `ModelSelection@1` (`{model, effort}`, closed enums generated from the model catalogue, item 16), `StopRecord@1` (system and operator stops);
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
    - **Port.** The gateway is provider-neutral. The orchestrator sends a `ModelCall@1` through broker `modelRespond` and receives a `ModelResult@1`; neither names a provider, provider model ID, token limit or price. In the broker, the catalogue entry of the call's selection (item 16) picks a `ModelProvider` adapter, which maps the resolved call to the provider's request and the reply back to `ModelResult@1`: outcome, validated output, usage (input, output, thinking and cache tokens), provider request ID and provider model ID. Cost is computed by the gateway from catalogue rates, not by the adapter. Claude, through the Messages API with the official SDK, is the first and only adapter. Another provider is one adapter, one broker credential and one catalogue entry, with no change to callers; selecting it is material and needs an owner-approved ADR.
    - **No fallback.** The broker sends only to the provider and model that the catalogue entry names. It never retries on another model or provider, never sends Anthropic's `fallbacks` parameter, and treats a reply whose `model` differs from the requested ID as `provider_error`. SDK retries are off, so Morrow counts every attempt. An entry whose provider has no adapter or no bound credential is refused before any request.
    - **Claude request.** `POST /v1/messages` for the Listings specialist only (the Coordinator is code). One product per call. `output_config.format` carries the generated `ListingDraft_v1` schema; `thinking: {type: "adaptive"}` and `output_config.effort` come from the selection and are always sent, because the API defaults differ by model; `max_tokens` comes from the catalogue. Never sent: `budget_tokens`, disabled thinking, tools, assistant prefill, sampling parameters, Files, Batches, code execution, web search, `inference_geo`, fast mode or beta headers. The input is counted with the token-counting endpoint before sending.
    - **Outcomes.** `end_turn` → `completed`, then schema and contract validation. `max_tokens` → `incomplete`. `refusal` → `refusal`. HTTP 400 (which is also what a spend limit returns), 401, 402 or 403 → `spend_limit` or `provider_error`, and the run ends without retry. 429 and 529 mean nothing was generated; the step waits and resends within the run's time budget, without using an attempt. A timeout or transport loss after sending → `uncertain`, booked at the attempt's worst case.
    - **Data sent.** Only the merchant's request text and the selected product's catalogue fields (title, description HTML, SEO title and description, tags). Never customer data, staff emails, the shop domain, credentials or payment data. Morrow does not store prompts or raw outputs.
    - **Anthropic data use** (S153–S155). Anthropic does not use inputs or outputs from its commercial API to train models by default; Morrow does not opt in or send feedback. Anthropic's commercial policy deletes API inputs and outputs within 30 days, and its API documentation says conversation content is not retained by default except for Covered Models (Claude Fable and Mythos), which require 30-day retention and are not in the catalogue. Content flagged by Anthropic's trust and safety systems may be kept up to 2 years. Zero data retention needs an agreement with Anthropic's sales team; Morrow has none, so the privacy notice says "up to 30 days, longer if flagged". Structured-output schemas are cached up to 24 hours and contain no merchant data.
    - **Accounts.** Separate Anthropic Console workspaces for staging and production, each with a monthly spend limit and one workspace-scoped API key held only by the broker. Global routing at standard prices; US-only inference (1.1× price) only if a customer contract requires it, as a new catalogue version.
    - **Effects.** A model call is metered spend, not a store effect. It needs reservations and stops (M3 PR-1). Store writes need the M4 gateway (invariant 15).
    - **Images.** Claude does not generate images. The post-launch image capabilities (P17.T02e) keep the recorded OpenAI Images selection behind the same port; no OpenAI credential is bound for the MVP. The owner may choose another image provider by ADR before P17.T02e.
11. **Credits and spend limits** (numbers are owner-adjustable configuration; prices are Anthropic's list prices of 2026-10-19, S150):
    - One credit drafts one product at the default selection; other selections cost the published multiplier (item 16). A run reserves its product count times the multiplier and settles at the products drafted times the multiplier, never above the reservation. A product that fails earns no credit. Applying costs no credits but needs an active entitlement.
    - Run admission checks entitlement directly (`workspaceBillingState`, `entitlementFor`), because drafting is not paid work under `isPaidWork`; the agent fact reader uses the same result.
    - Caps per call: at most 8,000 input tokens (counted before sending; a product whose call would exceed it fails before any spend) and the effort's `max_tokens` (output includes thinking). At most two attempts per product and 25 products per run.
    - USD caps, whatever the selection: US$7 of AI cost per run, so a run's product limit is the lower of 25 and US$7 divided by the selection's worst case per product; US$25 per workspace per day (settled cost plus open reservations); and per environment the Anthropic Console workspace's monthly spend limit, plus the owner's platform stop. There is no other platform spend breaker in the beta.
    - Cost per product (expected: one attempt with about 3,000 input tokens and 1,200, 2,500 or 5,000 output tokens at low, medium or high effort, an estimate to be replaced by staging measurements; worst case: two attempts, each at 8,000 input tokens and the effort's `max_tokens`):

      | Model | Effort | Credits | Expected | Worst case | Products per run |
      | --- | --- | --- | --- | --- | --- |
      | Haiku 5.5 | low / medium / high | 1 / 1 / 1 | US$0.0009 / 0.0016 / 0.0028 | US$0.0076 / 0.0136 / 0.0176 | 25 |
      | Sonnet 5.5 | low (default) / medium / high | 1 / 2 / 3 | US$0.018 / 0.031 / 0.056 | US$0.152 / 0.272 / 0.352 | 25 / 25 / 19 |
      | Opus 5.5 | low / medium / high | 2 / 4 / 6 | US$0.036 / 0.062 / 0.112 | US$0.304 / 0.544 / 0.704 | 23 / 12 / 9 |

    - Margin on the beta plan (US$49 a month with 300 credits): after Stripe's standard 2.9% + US$0.30 card fee and 0.7% Billing fee, a credit brings about US$0.156. At the default, expected AI cost is about 12% of a credit's revenue and the worst case about 97%. Every selection keeps its worst case below its credits' revenue (Haiku at most 11%, the rest 75–97%); no selection loses money on a drafted product. `npm run verify` checks this for every catalogue entry. Stripe Tax, infrastructure and failed products are outside these figures.
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
16. **Model catalogue and selection.**
    - The catalogue is a versioned table in `docs/decisions/model-policy.json`, generated into the contracts and the broker. A published version never changes: a new model, effort or multiplier is a new version, and every run records the version it used, as `BillingTerms` does for prices (R10).
    - Version 1 (2026-10-19):

      | Model key | Provider model ID | Context | Max output | Input / output per million tokens | Credits at low / medium / high |
      | --- | --- | --- | --- | --- | --- |
      | `claude_haiku_5_5` | `claude-haiku-5-5` | 1M | 128K | US$0.10 / 0.50 (prompts up to 100,000 tokens) | 1 / 1 / 1 |
      | `claude_sonnet_5_5` | `claude-sonnet-5-5` | 1M | 128K | US$2 / 10 | 1 / 2 / 3 |
      | `claude_opus_5_5` | `claude-opus-5-5` | 1M | 128K | US$4 / 20 | 2 / 4 / 6 |

      | Effort key | Claude request | `max_tokens` |
      | --- | --- | --- |
      | `low` | `thinking: {type: "adaptive"}`, `output_config.effort: "low"` | 6,000 |
      | `medium` | `thinking: {type: "adaptive"}`, `output_config.effort: "medium"` | 12,000 |
      | `high` | `thinking: {type: "adaptive"}`, `output_config.effort: "high"` | 16,000 |

    - `xhigh` and `max` are not offered: Anthropic positions them for long-running agentic work and unconstrained token spend, which a one-product call does not need and the caps cannot bound.
    - Multipliers follow cost: Opus 5.5's prices are twice Sonnet 5.5's, so its credits are twice Sonnet's; within a model, credits follow the expected output at each effort; Haiku 5.5 costs one credit, the smallest unit.
    - The default is Sonnet 5.5 at low effort: Anthropic describes Sonnet 5.5 as the best combination of speed and intelligence, low effort suits a short, fully specified rewrite, and it is the cheapest Sonnet choice. Its worst case (US$0.152) still fits inside one credit's revenue, while Opus at the same price per credit would not.
    - The workspace default is changed by a member holding `governance.model_default.revise` (the owner by template). On the Ask screen a merchant may pick any entry of the active version for one run; the screen shows its credits per product and the run's product limit. The api accepts only `{model, effort}` keys of the active version; any other value, a provider model string or a retired entry is refused before any run is created. The Coordinator and agents never choose or change a run's selection, and model output never names one.

## Consequences

- M2–M5 may start on acceptance, in the order of spine §13. Every provider effect still needs per-action approval or a staging card.
- This change updates `providers.json` (an `anthropic` row; OpenAI narrowed to images), `provider-bindings.json`, `model-policy.json` (the catalogue), `model-selection.md`, `data-lifecycle.md`, the plan and the briefs. `npm run verify` checks the catalogue: known providers with adapters, closed keys, adaptive thinking only, output caps within each model's limit, and every selection's worst case within its credits' revenue. Retention rows for the new tables land in the PRs that create them.
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
- **Keeping OpenAI for text models.** The owner chose Claude on 2026-10-19; the gateway port keeps a later switch to one adapter.
- **A free-form model string from the client.** A client could select an unapproved, unpriced or retired model; the closed catalogue keys prevent it.
- **One fixed model and effort.** The owner asked that merchants choose models and thinking effort.
- **One credit for every selection.** Opus 5.5 at high effort would then cost up to 4.5 times a credit's revenue in its worst case.
- **Offering `xhigh` and `max` effort.** Unbounded thinking for a one-product rewrite; the per-run cap would allow only a few products.
- **Anthropic's server-side `fallbacks`.** A refusal would silently move the call to another model, at another price.

## Approval

Owner, 2026-10-19, in chat. Asked "Approve ADR-0022, the MVP design summarised above? It lets me bind Shopify, OpenAI and Stripe keys to the broker for development and staging, and start building.", the owner answered: "yes lets start buidling and we are going to use claude for the model and make sure our model module is modular so it can be switched with any LLM we already decided upon this in build plan when i was building with codex".

Asked "Which Claude model should Morrow use by default to write product listings? ...", the owner answered: "use should be able to select models and thinking efforts".

Asked about beta pricing (one plan at US$49 a month that includes 300 credits, where 1 credit = 1 product drafted by the AI), the owner answered: "$49 / 300 credits (Recommended)".

Asked whether each beta merchant gets its own private Shopify app, the owner answered: "OK for the beta (Recommended)".

Asked whether a solo owner gets one Approve-and-Apply button, still sent as two server commands, the owner answered: "One button (Recommended)".

These answers accept items 1–16. Items 10, 11 and 16 (Claude behind a provider-neutral port, the model catalogue with the user's model and effort choice, and credits weighted by selection) and the Approve-and-apply bullet in item 3 were written from these answers on acceptance; the default selection, effort mapping, token caps and multipliers are Claude's proposals within them and stay owner-adjustable configuration.
