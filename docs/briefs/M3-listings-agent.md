# M3 Listings agent

- Status: brief, 2026-10-19 (revised after critique). Spine: [mvp-architecture.md](mvp-architecture.md) §2 steps 6–9, §4, §5, §7, §9, §10. Material choices: ADR-0022 items 1–3, 10, 11, 15 and 16 (accepted 2026-10-19).
- Plan IDs: P13.T01a–T03a, P05.T04b (minimum), P11.T04a (minimum), P11.T05a (stops). Branch `claude/m3-listings-agent`, from M2 PR-1; two PRs.

## Goal

The owner enables the Listings agent for a linked store. A merchant asks for better listings on selected products and picks the Claude model and thinking effort, or keeps the workspace default. The Coordinator (code) scopes the request, the Listings specialist drafts exact changes one product at a time through the model gateway, and Morrow stores them as Proposal@2 records. Each run reserves credits and vendor cost first and settles at the end. Stops exist before the first model call. No store write happens in M3.

## Scope

- **PR-1, authority, stops and credits:**
  - forward migrations: `morrow_identity.grants` admits agent principals (`membership_id` null only for kind `agent`, with a kind-dependent check and foreign keys only for humans); `proposals.proposer_membership_id` null only for an agent proposer with an installation;
  - `agent_releases` (one seeded release `morrow.listings` v1), `agent_installations`, `work_envelopes`, `delegation_hops`, and SQL readers behind `AgentAuthorityReader.readDelegationCurrent`;
  - `POST /workspace/:ws/stores/:storeId/agents/listings` ("Enable Listings agent"; owner, `agents.installation.activate`): creates the installation and the workspace's Coordinator principal on first use, issues the installation's grants with the owner as issuer, and gives the owner `agents.installation.disable`;
  - stops: "Stop AI work" (`agents.installation.disable`), the owner-run platform stop script, and the stop checks in `resolve_call`;
  - `credit_wallets`, `credit_reservations`, `vendor_cost_reservations`;
  - the model catalogue generated from `docs/decisions/model-policy.json` (`ModelSelection@1` enums, rates, caps, multipliers), `workspace_model_defaults`, `GET /workspace/:ws/models` and `PUT /workspace/:ws/settings/model-default` (`governance.model_default.revise`, signup template v2).
- **PR-2, runs and drafting:** `runs`, `run_manifests`, `product_snapshots`, `run_drafts`; `POST /workspace/:ws/work/tasks/:taskId/runs`, `GET /workspace/:ws/work/runs/:runId`; `ListingsRunWorkflow`; broker `modelRespond` with the `ModelProvider` port and its Claude adapter (official SDK, retries off); the agent submit definer (`morrow_work.submit_agent_proposal`, executable by `morrow_runtime_executor` under a run lease) and the `catalog.content.publish` producer; the Ask and task screens.

## Non-goals

Store writes (M4); a model-based Coordinator; other model providers, `xhigh` and `max` effort, escalation, images, tools, streaming, prompt caching and fallback; questions back to the merchant; agent creation or the Agent Store; prompt-quality evaluation beyond a fixed fixture set.

## Interfaces and data touched

- **Contracts (ADR-0022 item 2):** `CoordinatorRoute@1` (a record written by code); `ListingDraft@1` `{productId, title?, descriptionHtml?, seo?, tags?}` for one product, sent to Claude as the structured-output schema `ListingDraft_v1` (`output_config.format`; every field required and nullable, `additionalProperties: false`, no length keywords), with the full contract validator as the post-check; `ModelCall@1`, `ModelResult@1` (provider-neutral); `ModelSelection@1`; `CatalogContentChangeSet@1`. All through `scripts/contract-sources.mjs` and `npm run contracts:generate`; a test checks the schema stays inside Anthropic's supported subset and its limits (16 union-typed and 24 optional parameters).
- **Reused:** `createAgentAuthorityService().decideDelegation` (`builtin_coordinator` dispatcher, `installed_agent` executor); `ProposalProducer`, `productionProducers`, `checkProposal`, `riskClassFor`, `proposalDigest` (P06.T01b); `workspaceBillingState`, `entitlementFor`, `selectPayers`, `spendingScope` (`billing-state.ts`); work API `POST /goals` and `POST /tasks`, additively allowing `storeIds: [S]` for a linked store.
- **Forward migration on P06.T01b tables:** `proposals` gains `store_id`, `proposer_kind`, `proposer_installation_id`. A second document check covers `catalog.*` proposals: store-bound; product targets on the linked store and connection; an agent proposer that is the store's active Listings installation; a non-null task; `contextTaint` `untrusted_external`. The P06.T01b check stays for every other capability. Parameter redaction as in spine §11.
- **Screens:** `/w/:ws/ask` (collection or product picker over M2's routes, at most 25 products, plus free text; a model and effort picker showing credits per product and the run's product limit, defaulting to the workspace default); `/w/:ws/work/:taskId` (run status, credits reserved and used, proposals); "Enable Listings agent" and "Stop AI work" on the connection screen.

## Flow

1. **Admit (api, one transaction):** human kernel on the store resource (`execute` on `catalog.content.propose`, `view` on `catalog.products.read`, plus `delegate` on both and `propose` + `delegate` on `catalog.content.publish`); entitlement through `entitlementFor`; stops, link and installation current; the selection's keys in the active catalogue version, and the product count within the selection's run limit. The code Coordinator writes `CoordinatorRoute@1` from the picked products and fields. Then: the envelope on task T (requester and authorizer the merchant; the three capabilities; verbs `view`, `execute`, `propose`; the store resource; 24 h; depth 1, one child); child task T′ for the installation; the Coordinator's `workspace.task.delegate` {delegate} grant on T, expiring with the envelope; the hop T → T′; credit and vendor reservations; the run (with catalogue version, model, effort and multiplier), its lease and an outbox row.
2. **Start:** after commit the api sends the run id on the dispatch Queue; the orchestrator starts `ListingsRunWorkflow` with `id = runId` (an existing id means it already started), and its cron starts any run that `pending_starts()` still lists.
3. **Per product (one step each):** `decideDelegation`; `shopifyRead(productContent)`; a content-addressed `product_snapshots` row; one `modelRespond` with the brief, the fields and that product only, at the run's selection; validate. The draft's `productId` must equal the requested product. Fields are restricted to the brief's, length-capped (title 255 characters, `descriptionHtml` 10,000 bytes, SEO title 70, SEO description 320, at most 50 tags of 64 characters), stripped of no-op changes, and the HTML sanitised to an allowlist (`p`, `br`, `strong`, `em`, `ul`, `ol`, `li`, `h2`–`h4`; no attributes, links or images). URLs, email addresses and phone numbers absent from the source are flagged for the reviewer. One retry on a validation failure, `incomplete` or `refusal`; then the product is marked failed. The step writes `run_drafts` and returns ids only.
4. **Propose:** `decideDelegation` with `propose` on `catalog.content.publish`; the producer packs drafts into proposals by bytes (spine §7) and submits through the agent definer, with `proposedBy` the agent and `requestedBy` the task initiator.
5. **Settle:** credits for the products drafted times the multiplier, the rest released, vendor cost from usage, run `succeeded` or `failed`, lease released.

## Security notes

- **Stops before spend (invariants 14–15):** "Stop AI work", the platform stop and the `resolve_call` checks land in PR-1, and `ListingsRunWorkflow` stays disabled until they pass. A model call is metered spend, not a store effect (ADR-0022 item 10).
- **Checks outside prompts (invariant 13):** the model has no tools and returns one product's JSON. Authority, fields, sizes, budgets, stops and the model selection are code checks; the client sends only catalogue keys, never a provider model string, and model output never selects a model.
- **Agent authority is an intersection (invariant 5):** `decideDelegation` rereads facts at every step; the installation cannot exceed the requester or its owner; a disabled installation stops the run at its next step. Only the owner's explicit command creates an installation.
- **Approval binding (invariant 7):** M3 only creates pending approvals; the digest covers targets, fields, expected source revisions and the parameters digest.
- **Paid work:** no inference without a reservation; the broker refuses a call beyond the run's remaining vendor reservation; a spend-limit refusal ends the run.
- **Injection:** product text may carry instructions. One product per call stops cross-product steering. Model text cannot name a capability, store or price. Every proposal is `untrusted_external`, and its exact digest needs human approval. The review screen shows tag changes as functional (tags drive collections and automations) and shows contact and URL flags. There is no model-written note.
- **Model data (ADR-0022 item 10):** the request text and the product's catalogue fields only; Anthropic does not train on API data by default and deletes it within 30 days (longer only if flagged); Morrow does not persist prompts or raw outputs, and Workflow state holds ids only. The Anthropic key is in the broker only.
- **Rendering:** the review screen shows escaped HTML source; any preview renders in a sandboxed `iframe` with `srcdoc`, no scripts and `default-src 'none'`.

## Test checklist

- [ ] Agent kernel on SQL readers: envelope expired, installation disabled, requester lost a grant or `delegate`, Coordinator grant expired, a refund capability through the hop → denied (P05.A02, P05.A03 cases); a correctly admitted run → allowed.
- [ ] Agent grants and proposals: an agent grant with a membership id, a human grant without one, an agent proposal without an installation → refused.
- [ ] Reservation races: two runs against a balance for one → one admitted; a failed run releases; settlement never exceeds the reservation; an Opus high run reserves 6 credits per product and is limited to 9 products.
- [ ] Selection: unknown key, provider model string (`claude-opus-5-5`), retired catalogue version, `xhigh`, missing selection (→ workspace default), default changed without `governance.model_default.revise` → the expected refusal or default.
- [ ] Model outputs: malformed JSON, extra fields, oversized HTML, scripts or links, a different `productId`, `max_tokens`, `refusal`, a spend-limit 400, a 529, and the prompt-injection fixtures (including new URLs, contacts and tags) → rejected, flagged, retried or ended as specified.
- [ ] Proposal SQL: store-bound agent proposal accepted; foreign store or connection, human-only capability, null task, wrong installation, `contextTaint: none` → refused; P06.T01b cases unchanged.
- [ ] Broker `modelRespond`: selection not in the catalogue, a provider without an adapter or credential, disabled thinking or `budget_tokens` in the built request, a tool present, input over 8,000 tokens, no headroom, a stop → held with no provider request; a reply naming another model → `provider_error`.
- [ ] Adapter conformance: the Claude adapter maps every recorded fixture to the expected `ModelResult@1`; a stub second adapter passes the same suite without caller changes.
- [ ] Workflow step outputs contain no content fields.
- [ ] One end-to-end workerd plus PostgreSQL 17 lab with recorded Claude fixtures; zero real provider calls in CI.
- [ ] A staging smoke on the development store, after M5 PR-1, under owner approval, across the three models at low effort, with tokens and cost recorded in `docs/evidence/live/` to replace the expected-token estimates (ADR-0022 item 11).

## Owner actions

1. An Anthropic Console workspace for staging with a monthly spend limit (recorded in the evidence file); a workspace-scoped API key placed with `morrow_put`.
2. Approve the staging smoke runs.

## Open questions

- Failed products earn no credit, so their AI cost is unrecovered (bounded by the run and daily caps). Should a monthly per-workspace AI cost cap be added before real stores connect?
