# M3 Listings agent

- Status: brief, 2026-10-19. Spine: [mvp-architecture.md](mvp-architecture.md) §2 steps 6–9, §4, §5, §7, §9. Material choices: ADR-0022 items 1–3, 10 and 11 (Proposed).
- Plan IDs: P13.T01a–T03a (model gateway, routing, bounded loop), P05.T04b (agent authority persistence, minimum), P11.T04a (credit reservations, minimum). Branch `claude/m3-listings-agent`, from M2 PR-1; two PRs.

## Goal

A merchant asks for better listings on selected products. The Coordinator turns the request into a bounded brief, the Listings specialist drafts exact changes, and Morrow stores them as Proposal@2 records with digests. Each run reserves credits first and settles them at the end. No store write happens in M3.

## Scope

- **PR-1, authority and credits:** `agent_releases` (one seeded first-party release `morrow.listings`, version 1), `agent_installations`, `work_envelopes`, `delegation_hops`; SQL readers behind `AgentAuthorityReader.readDelegationCurrent`; agent principals in `morrow_identity.principals` (kind `agent`) and their grants in `morrow_identity.grants`; one Listings installation per workspace, created on the first run and owned by the workspace owner; `credit_wallets`, `credit_reservations`, `vendor_cost_reservations`, `usage_liabilities`, `test_entitlement_seeds` with the seed writer (ADR-0015 OQ-2).
- **PR-2, runs and drafting:** `runs`, `run_manifests`, `product_snapshots`; `POST /workspace/:ws/work/tasks/:taskId/runs` and `GET /workspace/:ws/work/runs/:runId`; `ListingsRunWorkflow` in the orchestrator; broker `modelRespond`; the `catalog.content.publish` producer; the forward migration for store-bound agent proposals; the Ask and task screens.

## Non-goals

Store writes (M4); escalation models, images, tools, streaming and fallback; durable questions back to the merchant; agent creation or the Agent Store; Asks as conversations (P01.T02c surfaces); prompt or quality evaluation beyond a fixed fixture set.

## Interfaces and data touched

- **Contracts (ADR-0022 item 2):** `CoordinatorRoute@1` `{route: "listings" or "decline", fields: FieldPath[], brief (at most 2,000 characters), declineReason}`; `ListingDraft@1` `{items: [{productId, title?, descriptionHtml?, seo?, tags?, note}]}`; `ModelCall@1` and `ModelResult@1` (internal); `CatalogContentChangeSet@1` (the parameters). All are added through `scripts/contract-sources.mjs` and `npm run contracts:generate`, with no runtime schema compilation.
- **Reused:** `createAgentAuthorityService().decideDelegation` with the `builtin_coordinator` dispatcher and an `installed_agent` executor (`packages/policy/src/agent-authority.ts`); `submitProposal`, `ProposalProducer`, `productionProducers` (`packages/work/src/approvals`, P06.T01b); `checkProposal`, `riskClassFor`, `proposalDigest` (`packages/policy/src/review.ts`); `createBillingConstraintsReader`, `selectPayers`, `spendingScope`, `evaluateTestEntitlementSeed` (`billing-state.ts`); work API `POST /goals` and `POST /tasks`, additively allowing `storeIds: [S]` and `allowedResources: [S]` for a linked store (ADR-0010 item 3: additive is routine).
- **Forward migration on P06.T01b tables:** `proposals` gains `store_id`, `proposer_kind` and `proposer_installation_id`. A second document check covers `catalog.*` proposals (store-bound, product targets on the linked store and its connection, an agent proposer that is the workspace's active Listings installation, a non-null task). The P06.T01b check stays for every other capability. `proposal_parameters` gains `redacted_at`; its digest check holds unless redacted.
- **Screens:** `/w/:ws/ask` (collection or product picker over M2's catalogue routes, at most 50 products, plus free text); `/w/:ws/work/:taskId` (run status, credits reserved and used, proposals).

## Flow

1. **Ask:** the api creates the goal and task, then starts a run. In one transaction it runs the human kernel (`execute` on `catalog.content.propose`, `view` on `catalog.products.read`), checks entitlement, stops and the store link, creates the envelope (requester and authorizer are the merchant; capabilities `catalog.products.read`, `catalog.content.propose` and `catalog.content.publish`; verbs `view`, `execute`, `propose`; this store; 24 h; depth 1, one child) and the hop to the Listings installation, reserves credits and vendor cost, and writes the run, its lease and an outbox row.
2. **Start:** the orchestrator starts `ListingsRunWorkflow` with `id = runId`. A cron re-creates queued runs older than 30 seconds; an existing id means the run already started.
3. **Coordinate:** one `modelRespond` with the merchant's text, the store name and the field list, returning `CoordinatorRoute@1`. `decline` ends the run with no charge and a fixed message ("Morrow can improve product listings for now").
4. **Read:** `shopifyRead(productContent)` in pages, then content-addressed `product_snapshots`.
5. **Draft:** batches of at most 5 products through `modelRespond`, returning `ListingDraft@1`. The output is validated, restricted to the brief's fields, length-capped (title 255, `descriptionHtml` 16 KiB, SEO title 70, SEO description 320, at most 250 tags of 255 characters), stripped of no-op changes, and its HTML sanitised to an allowlist (`p`, `br`, `strong`, `em`, `ul`, `ol`, `li`, `h2`–`h4`; no attributes, links or images). A batch that fails validation is retried once, then marked failed.
6. **Propose:** before each submit the workflow calls `decideDelegation` with operation `propose` on `catalog.content.publish`. The producer packs at most 25 products per proposal within 32 KiB and submits with `proposedBy` the agent and `requestedBy` the task initiator.
7. **Settle:** credits for the products drafted, release the rest, vendor cost from usage, run `succeeded` or `failed`, lease released.

## Security notes

- **Checks outside prompts (invariant 13):** the model has no tools and returns JSON only. Authority, field allowlists, sizes, budgets and stops are code checks; model text never names a capability, store or price.
- **Agent authority is an intersection (invariant 5):** `decideDelegation` rereads facts at every step; the installation cannot exceed the requester, and a disabled installation stops the run at its next step.
- **Approval binding (invariant 7):** M3 only creates pending approvals; the digest covers targets, fields, expected source revisions and the parameters digest.
- **Paid work:** no inference without a reservation; the broker refuses a call that exceeds the run's remaining vendor reservation.
- **Model data (ADR-0022 item 10):** request text and catalogue fields only; `store:false`; no customer data, emails, tokens or ids beyond product ids. Prompts and raw outputs are not persisted.
- **Injection:** product descriptions may carry instructions. The schema-bound output, field allowlist, sanitiser and mandatory human approval of the exact digest bound the effect to proposed copy on the same store.
- **Rendering:** the review screen shows escaped HTML source; any preview renders in a sandboxed `iframe` with `srcdoc`, no scripts and a `default-src 'none'` CSP, never in the session origin's DOM.

## Test checklist

- [ ] Agent kernel on SQL readers: envelope expired, installation disabled, requester lost the grant, a refund capability requested through the hop → denied (P05.A02 and P05.A03 cases for this path).
- [ ] Reservation races: two runs against a balance for one → one admitted; a failed run releases; settlement never exceeds the reservation.
- [ ] Model outputs: malformed JSON, extra fields, oversized HTML, scripts or links in HTML, an unknown product id, and a prompt-injection fixture set → rejected or sanitised.
- [ ] Proposal SQL: store-bound agent proposal accepted; foreign store, foreign connection, human-only capability, null task with an agent, wrong installation → refused; the P06.T01b cases are unchanged.
- [ ] Broker `modelRespond`: model not in policy, `store` not false, a tool present, token cap exceeded, no reservation headroom → held, with no provider request.
- [ ] One end-to-end workerd plus PostgreSQL 17 lab with a recorded OpenAI fixture; zero real provider calls in CI.
- [ ] A staging smoke on the development store under owner approval, with cost recorded in `docs/evidence/live/`.

## Owner actions

1. An OpenAI API project for staging with a hard monthly budget; the key placed with `morrow_put`.
2. Approve ADR-0022 items 1–3, 10 and 11.
3. Approve each staging use of the test entitlement seed (ADR-0015 OQ-2).

## Open questions

- Is "1 credit per product drafted" the merchant-facing unit the owner wants (ADR-0022 item 11)?
