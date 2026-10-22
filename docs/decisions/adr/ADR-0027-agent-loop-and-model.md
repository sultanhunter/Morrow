# ADR-0027 Agent loop and model: one AgentRunWorkflow with tools, model profiles, the model-based Coordinator and specialist runs

- Status: Proposed
- Date: 2026-10-23
- Supersedes: none.
- Amends: ADR-0022 item 3's Coordinator bullet (item 8), item 10's "never sent: tools" for loop runs (item 4), item 11's per-run limits (item 6) and item 16's per-run choice (item 9); ADR-0011's "Taint is a field only" line (item 5); refines ADR-0023 decision 11a (item 10).
- Implements: ADR-0023 decision 7, decision 1's Coordinator and the owner's addition, and decision 11's spec and child runs.
- Does not change: ADR-0022 item 9, item 10's port, no-fallback rule and provider, item 15, item 16's catalogue; the authority kernel.
- Unblocks: P13.T01 to P13.T04; the durable-wait slice of P12.T03; the per-step hold slice of P11.T04; profile parts of P16.T01 and P16.T03; the pinned skill-load slice of P15.T04 (no search or skill tools, ADR-0023 11d), the rest after launch; tracks T2, T4, T7, T12, T18; gates G11, G18.

## Context

The owner approved decision 7 ("yes to all recommended", Q12), asked for "one main agent and then other sub agetns which can be started by user as required" (Q12), and approved specialists ("yes to both, go with option A and specialists", Q14). On `main`, `listings-run@1` makes one tool-free call per product and the Coordinator is code.

## Decision

1. **One Workflow.** `AgentRunWorkflow` (`agent-run@1`) runs installed agents, the Coordinator and specialists. Admission pins a manifest: release, system-text and tool-catalogue digests, model profile, caps and any spec digest and deadline. Steps carry only ids and codes and re-enter the run lease. At a resume after `inbox.ask` the lease comes from the answer command for a person's run (ADR-0022 item 9; it grants nothing), from `admit_mandate_run` for a mandate run (ADR-0024 item 6), or from ADR-0028 item 6's renewal for a specialist. At most 2 questions; 72 hours unanswered ends the run. Code, never model text, derives the outcome. The approved stale-run sweep (ADR-0023 "What stays") extends to `agent-run@1`, closing a run whose lease ended unrenewed (`lab:agent-runs` case).
2. **Each tool call is a durable step:** lease re-entry (for a specialist, an open child task and unpassed deadline too); replay of a recorded result; validation; ids in scope; the authority decision; a worst-case hold; dispatch. The decision depends on the run kind:
   - routed runs and specialists: `decideDelegation`;
   - mandate runs: `decideAutomation`;
   - the Coordinator: a stated check in code, the requester's live grants ∩ the Coordinator's fixed grant set (item 8) ∩ rules and stops.

   New `lab:agent-authority-workers` rows deny each kind when a term fails. After a crash, reads run again, internal writes return their first record, and `computer.*` answers `tool_outcome_unknown`.
3. **A closed tool catalogue.** `ToolCatalogue@1` is generated, digest-pinned data: `mvp.md`'s tools plus `agent.route` and `specialist.draft`, each with its capability, verb, replay class and an 8 KiB result bound. No tool takes SQL, a URL, a role, a store, a recipient, a credential or a model, and none has an external effect: `proposal.create` makes a digest-bound proposal for the gateway. A skill never adds a tool.
4. **`ModelCall@2` and `ModelResult@2`,** closed and provider-neutral; `@1` stays until `listings-run@1` drains. The broker reads the selection and tools from the run its lease names and refuses `prefix_mismatch` before any request, so the conversation is append-only. Tools go with `strict: true` and `tool_choice` `auto` (`none` on the final turn); T2's contract PR fixes the sent and never-sent fields. An invalid `tool_use` ends the run; an uncertain turn is booked at its worst case and resent at most once.
5. **Untrusted content and its rule** (amends ADR-0011's "Taint is a field only"; P11.T02 enforces it). Untrusted content (product text, email, sandbox outputs, uploads, tool results, reports) enters only as wrapped data naming its source. Model output never sets the tool list, capabilities, scope, recipients or caps. A proposal from a run that consumed `untrusted_external` content keeps that taint through edits; the gateway dispatches it only after a person approves its exact digest, never on an automatic or agent approval; and its card lists its untrusted sources.
6. **Caps for loop runs** (catalogue version 2, owner question 2). Per turn: 64,000 input tokens, counted first. Per run: 16 turns (6 for the Coordinator); 4 tool calls per turn and 40 per run; wall time 30 minutes for installed agents and 5 for the Coordinator, waits excluded, and for specialists the spec deadline, at most 8 hours with waits counted (ADR-0028 item 6). The turn limit is also bounded by ADR-0026 item 4's per-run USD backstop over the entry's worst-case turn. A turn starts only if the reservation and time cover a final turn. Before the rate card, loop runs earn no credits, run only on development stores under ADR-0026 item 7's `TestEntitlementSeed` (the G11 path), and count toward the unrecovered-cost cap.
7. **Run turns.** Content lives only in `run_turns` (FORCE RLS); `run_tool_calls` holds ids, codes and digests. Retention is ADR-0031 item 1's. No content reaches Workflow outputs, Queues or logs.
8. **The model-based Coordinator.** One built-in principal per workspace runs `morrow.coordinator`, a role prompt plus up to 15 eligible skills injected by code. Its fixed grant set covers `knowledge.search`, `work.read`, `message.post`, `inbox.ask`, `task.create`, `agent.route` and `specialist.draft`: no store reads, proposals, computer or support tools, and its context excludes customer-tagged items at launch (ADR-0031 item 6). Only a person's act starts it, with that person as requester; never text or a schedule. `agent.route` names one active installed agent on the task's store, once per run. Only the Coordinator delegates.
9. **Model profiles set at install.** Each installation, the Coordinator and specialists hold one `ModelSelection@1` profile. `governance.model_default.revise` stays `human_only`, held by the Owner, and by Admins for installation targets only. Admission pins the profile and refuses a missing one, substituting nothing.
10. **SpecialistSpec@1 and child runs.** A closed spec, digested with RFC 8785. The model writes the brief (`title`, `objective`, `inputRefs`, `doneCriteria`, `boundaries`) and, refining ADR-0023 11a, picks 1 to 3 skill ids from the eligible list and an `outputContractId` from a closed list. These choose only which skill bodies load and the report's form: code derives the tools and capability ids from the tools the eligible skills declare ∩ the Specialist ceiling (ADR-0028 item 2), never from the chosen ids, and writes every other field. `specialist.draft` grants nothing and never runs in a turn holding a report. A child run has a fresh context and no notebook and ends with a `report@1` artifact, which the Coordinator never reads at launch.
11. **Switches and delivery.** T2 merges the contracts with fakes. A forward migration admits `agent-run@N`. `docs/decisions/agent-loop-staging.json` is committed `off`; production refuses it until G10 and G12. Catalogue version 2 publishes only on the owner's recorded confirmation.

## Security invariants touched

- **The intersection; checks in code:** `agent-authority.test.mjs`, `lab:agent-authority-workers`, `tool-catalogue.test.mjs` (new), `run-credits.test.mjs`.
- **Digest-bound approvals; the untrusted-content rule:** `review-policy.test.mjs`, `approval-records.test.mjs`, T3's gateway lab, T12's injection evals.
- **Unknown outcomes never re-run:** `lab:agent-runs` (new), `broker-model.test.mjs`.
- **Broker-only credentials:** `verify:boundaries`; **FORCE RLS, G9:** `lab:tenant-conformance`.
- **Default deny; no effect before G10; `human_only` stops:** `edge:check`, `edge-config.test.mjs`, `stops.test.mjs`.
- **Immutable migrations:** `migration-history.test.mjs`.

## Consequences

If the loop misses W4, the G11 demo uses `listings-run@1`.

## Alternatives considered

- **A Workflow per agent:** many authority paths.
- **The loop in E2B or hosted elsewhere:** the key or the authority would leave Morrow.

## Owner questions

1. **Default profiles.** Sonnet 5.5 at low effort for the Coordinator, the five agents and specialists; packages may allow Haiku, Sonnet or Opus 5.5 at low or medium. *Recommendation: approve.*
2. **Version 2 values:** item 6's limits, `max_tokens` of 5,000 (low) and 12,000 (medium), and 8 KiB results; money is ADR-0026's. *Recommendation: approve, confirmed against staging measurements.*
3. **Prompt caching** of the fixed prefix for 5 minutes. *Recommendation: approve.*

## Approval

Pending. The owner's answers will be quoted here verbatim with their dates.
