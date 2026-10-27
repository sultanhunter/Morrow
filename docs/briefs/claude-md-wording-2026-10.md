# CLAUDE.md wording, October 2026: drafts for the owner to confirm

- Status: draft, 2026-10-26, for the owner's own confirmation of the text, as CLAUDE.md's standing rules require (OD-2026-10-23-10). Written on branch `claude/h2-plan-docs` from `main` at `4b7063b1` and brought up to `main` at `2107859d`, then at `966fed03` (pull request 86, ADR-0042 Accepted; pull request 79), as harness plan row H2 (`docs/plan/harness-foundations-implementation.md`). CLAUDE.md itself is not edited here: once the owner confirms a change, the lead applies its "After" text in its own commit, word for word.
- Sources: ADR-0040 item 15 (the stack line) and ADR-0041's Consequences and Approval (the "MVP" line, the model line), both Accepted 2026-10-26 (OD-2026-10-26-7); the owner's rule that the foundation is production grade, never an MVP build (OD-2026-10-26-6); the owner's messages on models (OD-2026-10-26-5; OD-2026-10-26-7, question 1); and ADR-0042 (connected services and customer contact), Accepted 2026-10-26 (OD-2026-10-26-9, pull request 86), whose decision sheet Q-adr-0042-owner-questions shows its four CLAUDE.md edits word for word in question 6.
- How to read it: each change shows the line as it is in CLAUDE.md today ("Before") and the proposed line ("After"), verbatim. A new line is shown as an insertion after the line that stays above it. `tests/claude-md-wording.test.mjs` checks that every "Before" is still in CLAUDE.md until its "After" replaces it, so this page cannot drift from the file it changes.

## A. The "MVP" line names the launch scope only

Why: ADR-0041 (Consequences) says CLAUDE.md's "MVP" line should name the launch scope, not the harness; the owner's rule (OD-2026-10-26-6) is that the foundation is production grade and state of the art, never an MVP build. The draft keeps the line's "The architecture stays production-grade so it scales without rewrites" word for word: that is ADR-0021 item 2, which ADR-0023 keeps (the Worker boundaries; Neon with FORCE RLS and restricted roles; versioned contracts and generated validators; one gateway; digest-bound approvals; the credit ledger; reconcile-before-retry), and ADR-0041 extends the rule to the harness and the multi-agent design without narrowing it. The same line still says "on-demand specialists", which ADR-0037 retired in favour of teammates under the Coordinator, so the draft fixes that too.

**Before** (Settled product constraints):

```claude-md-before
- MVP (ADR-0023): launch the lean, full-featured MVP in `docs/plan/mvp.md` first: a workspace where a shop's people and AI agents run the business together, with proactive installable Morrow agents, on-demand specialists under the Coordinator, and one public Shopify app (unlisted first, then listed). The architecture stays production-grade so it scales without rewrites; the full plan is the post-launch roadmap.
```

**After:**

```claude-md-after
- MVP (ADR-0023): "MVP" names the launch scope only. Launch the lean, full-featured MVP in `docs/plan/mvp.md` first: a workspace where a shop's people and AI agents run the business together, with proactive installable Morrow agents, teammates under the Coordinator (ADR-0037), and one public Shopify app (unlisted first, then listed). The architecture stays production-grade so it scales without rewrites, and "MVP" never names the foundation: the agent harness and the multi-agent design are built production grade and state of the art, with no shortcuts (ADR-0041). The full plan is the post-launch roadmap.
```

## B. The stack line gains Durable Objects

Why: ADR-0038 added the connector's cron Durable Object, and ADR-0040 item 15 adds the `LiveChannel` class in the api Worker; ADR-0040 item 15 names this exact addition, "Durable Objects (ADR-0038, ADR-0040)". ADR-0041 item 35's conditional runtime SQL object, if staging needs it, is covered by the same words.

**Before** (Settled product constraints):

```claude-md-before
- Stack: TypeScript/React; Cloudflare Workers, Workflows, Queues and R2; Neon PostgreSQL; E2B isolated execution; WorkOS identity. Morrow owns all authorization.
```

**After:**

```claude-md-after
- Stack: TypeScript/React; Cloudflare Workers, Workflows, Durable Objects (ADR-0038, ADR-0040), Queues and R2; Neon PostgreSQL; E2B isolated execution; WorkOS identity. Morrow owns all authorization.
```

## C. The model line: Opus 5.5 only

Why: CLAUDE.md has no model line today. ADR-0041 items 1 and 2 set Morrow's own harness on Anthropic's Messages API with no agent SDK in the product, and Opus 5.5 for every agent at `medium` or `high` (OD-2026-10-26-5: no Haiku and no cheaper models for paid users; OD-2026-10-26-7, question 1: no `low` effort, and the Owner may still raise a single teammate to `high`). The new line goes directly under the paid-models line, which stays as it is.

**Before** (Settled product constraints; the line that stays above the new one):

```claude-md-before
- Paid managed model APIs and one work-credit balance. No free merchant tier.
```

**After:**

```claude-md-after
- Paid managed model APIs and one work-credit balance. No free merchant tier.
- Models (ADR-0041 items 1 and 2): Claude Opus 5.5 only, on Morrow's own harness over Anthropic's Messages API, with no agent SDK in the product. Morrow runs at `high` effort and every other agent at `medium`; the Owner may raise a teammate to `high`, never lower and never to another model. No Haiku, no Sonnet and no `low` effort in any catalogue; `xhigh` and `max` come only with a new catalogue version after their evals.
```

## D. Lines ADR-0042 changes (approved in substance; their words wait for the owner)

Why: ADR-0042's owner question 6 (standing call plans) changes the granularity of exact approvals for customer contact. The record, Accepted 2026-10-26 (OD-2026-10-26-9), lists four CLAUDE.md lines in its Amends list (its items 10, 19 and 26), and question 6 on its decision sheet shows each line's current and proposed text word for word. The owner's "yes" approved the change in substance only, because question 6 showed the words after the answer (OD-2026-10-26-9; ADR-0042, Amends and Approval): CLAUDE.md's standing rules change only with the owner's own confirmation of the words (OD-2026-10-23-10), so ADR-0042's CS2 commits that text unchanged, and only after the owner confirms it word for word. So this page does not draft its own wording for these four lines. Each "After" below is question 6's proposed text, copied verbatim, so that the owner reads one text, not two, and each "Before" is question 6's "Now", which is CLAUDE.md's line today; `tests/claude-md-wording.test.mjs` checks both against the sheet as merged.

What changed from this page's earlier drafts, written against the record at `5ed2e8ac`: D1 said that any edit to a plan needs a new approval, where the record now keeps the approved revision running until the edited one is approved, unless the editor pauses it; D2 to D4 say the same as before in the record's own words; and D4, which the record did not name then, is now its fourth edit.

**Settled by OD-2026-10-26-9** (this page's earlier open point for the lead): the owner's approval of 2026-10-26 covers the change in substance, not this exact text, which question 6 first showed in pull request 86's review fixes (`be0ca8bf`), after the answer. D1 to D4 therefore wait for the owner's word-for-word confirmation, recorded as its own owner decision, and CS2 commits them only then. They match the record as merged. The COD Confirmation agent is installable and not built now (OD-2026-10-26-9), and in ADR-0042 only that agent holds contact capabilities (its owner question 7, answer (a)). The lines take effect only when a call plan's switches go on, and those switches wait for the owner's request for the agent and for CS2's commit (ADR-0042 item 27), so these lines change nothing in practice until then.

**No overlap with A, B, C or E.** None of the other drafts touches the four lines D1 to D4 change, so the owner can confirm either set without the other: A changes the "MVP" line, B the stack line, C adds a line under the paid-models line, and E changes the opening paragraph, each a different line of CLAUDE.md from D's four, and no After outside D carries any of D's lines. Read together they agree: E's After keeps "people approve exact proposals", which D1's exception qualifies only for an approved call plan; C's new line says what ADR-0042 keeps (its "Does not change" list: Morrow's own harness, and Opus 5.5 for every agent); and the customer-data line, which none of the drafts changes, stays as it is under ADR-0042 too (item 15). `tests/claude-md-wording.test.mjs` checks that no draft outside D shares a line with D.

### D1. Exact approvals (Security invariants)

Question 6's first edit.

**Before:**

```claude-md-before
- Approvals are bound to a digest of the exact proposal. Any edit invalidates them. The gateway re-checks authority before execution.
```

**After:**

```claude-md-after
- Approvals are bound to a digest of the exact proposal. Any edit invalidates them. The gateway re-checks authority before execution. One exception (ADR-0042): an approved customer-contact call plan is one exact proposal whose approval covers each contact and order tag it names; an edit to a plan makes a new revision that needs its own approval, and the approved revision keeps running until then unless the editor pauses it.
```

### D2. The owner's store (Security invariants)

Question 6's second edit.

**Before:**

```claude-md-before
- The owner's own store is the only real store until the public launch, and Morrow is built and tested on it (ADR-0035). Agents change it only through an approved exact proposal. Local and CI tests use fakes; only the deployed environment reaches the store.
```

**After:**

```claude-md-after
- The owner's own store is the only real store until the public launch, and Morrow is built and tested on it (ADR-0035). Agents change it only through an approved exact proposal, or by adding an order tag that an approved call plan names (ADR-0042). Local and CI tests use fakes; only the deployed environment reaches the store.
```

### D3. Asking the owner first (Provider and live effects)

Question 6's third edit.

**Before:**

```claude-md-before
- Ask the owner first, every time: purchases, plan upgrades and ad spend; raising a cap; deleting data; sending anything to the owner's customers; the App Store submission; any store other than the owner's. Accepting a provider's terms and anything that needs the owner's own login stay the owner's.
```

**After:**

```claude-md-after
- Ask the owner first, every time: purchases, plan upgrades and ad spend; raising a cap; deleting data; sending anything to the owner's customers, except that under an approved call plan the owner's OK in chat is asked once, before the first live day, and the plan's approval then covers each contact (ADR-0042); the App Store submission; any store other than the owner's. Accepting a provider's terms and anything that needs the owner's own login stay the owner's.
```

### D4. Changing the store through Morrow's flow (Provider and live effects)

Question 6's fourth edit. The record did not name this line at `5ed2e8ac`, when this page drafted it on its own; it does now.

**Before:**

```claude-md-before
- Change the owner's store only through Morrow's own flow: the owner approves the exact change in the workspace, and the gateway applies, reads back and audits it. Never write to the store any other way.
```

**After:**

```claude-md-after
- Change the owner's store only through Morrow's own flow: the owner approves the exact change, or the call plan that names it (ADR-0042), in the workspace, and the gateway applies, reads back and audits it. Never write to the store any other way.
```

## E. Optional: the opening paragraph's "specialist agents"

Not one of H2's requested changes, offered because it is the same stale word the "MVP" line loses: ADR-0037 retired the run-scoped specialist, and every agent but Morrow is now a teammate. The owner may confirm it or leave it.

**Before:**

```claude-md-before
Morrow is a paid AI workspace where a Shopify brand's people and AI agents run the business together. It has one standalone web workspace, a minimal embedded home in the Shopify admin, and a thin Shopify connector. The Coordinator scopes work, specialist agents draft, people approve exact proposals, and one gateway executes, reads back and audits.
```

**After:**

```claude-md-after
Morrow is a paid AI workspace where a Shopify brand's people and AI agents run the business together. It has one standalone web workspace, a minimal embedded home in the Shopify admin, and a thin Shopify connector. The Coordinator, Morrow, scopes work and orchestrates its teammates (ADR-0037), agents draft, people approve exact proposals, and one gateway executes, reads back and audits.
```

## Lines that stay, and why

- **Customer data** ("Customer data (names, emails, addresses, phones, customer mail) and uploads never enter before their P09.T05 deletion and privacy path exists."): unchanged. ADR-0042 lets the Phone field in for COD Confirmation only after its P09.T05 path (G9), which this line already requires, and the owner chose on 2026-10-26 to build that path first (OD-2026-10-26-10). ADR-0042's Amends list changes ADR-0035 item 7's "with Support", not this line, which it keeps (item 15).
- **Credentials** ("Raw provider, merchant and model credentials are readable only by the broker Worker."): unchanged. ADR-0042's merchant service credentials are merchant credentials, sealed to the broker; ADR-0040's VAPID key is a provider credential held by the broker.
- **Kill switches** ("Kill switches are `human_only` and need no second approver. Agents may only propose them (ADR-0005)."): unchanged. ADR-0040's Stop on a request and the workspace stop, and ADR-0042's three stop controls, follow it as written.
- **"Permission and budget checks happen in code, outside model prompts."**: unchanged. ADR-0041 keeps every hold, park, detector and check-in in code, and the model never sees a budget.
- **The standing approval's "within the owner's spend caps (the Anthropic monthly limit, E2B's US$20, the caps in code)"**: not drafted here. ADR-0039 removes the money caps in code, ADR-0041 adds no new one, and OD-2026-10-26-12 removes the spend limits ADR-0041 had (the cost check-in and the 80% pause); whether "the caps in code" should go is ADR-0039's wording question, outside H2.

## What the owner is asked

Confirm A, B and C as written (or say what to change); confirm D1 to D4 word for word, which are ADR-0042 question 6's own text and which OD-2026-10-26-9 approved in substance only; and say whether to take E. The owner's words are recorded verbatim with a new OD number. The lead applies the confirmed A, B, C (and E, if taken) to CLAUDE.md in one commit; D1 to D4 land with ADR-0042's CS2, once confirmed, as that record says. After each, `tests/claude-md-wording.test.mjs` sees the "After" in place.
