# H6: harness contracts with fakes (first PR: ADR-0041's contracts)

- Status: first PR built, 2026-10-26, on branch `claude/h6-harness-contracts` from `main` at `2107859d` (pull request 83 merged: catalogue version 4, migration 0056). Plan row H6 of `docs/plan/harness-foundations-implementation.md` (size L, two PRs). Decision: ADR-0041 (harness foundations) and ADR-0040 item 5 (`JobStatus@1`), both Accepted 2026-10-26 (OD-2026-10-26-7). Change class: routine under ADR-0002 (contracts an accepted ADR names, in the unfrozen v1.1 set, with fakes); no table, route, capability, grant, switch, provider resource or secret.
- **Migrations:** none.
- **Switches:** none added or turned on. Nothing in production reads these contracts yet: the runner (H7b), the broker (H7c) and the context engine (H7d) adopt them behind the agent-loop switch, which stays committed off.

## Goal

Give every later harness PR (H7a to H7e, H9, H10 to H12, H14 and H15) one set of contracts and deterministic fakes to build against, so the runner, the broker, the context engine, memory and the screens agree on shapes before any table or Worker exists. The contracts carry ADR-0041's rules where JSON Schema can state them (ids only to the broker, no turn or time limit, every derived row with an audience and taint, a review verdict that can only block); code carries the orderings and id rules it cannot (`packages/policy/src/harness.ts`, `context-policy.ts`).

## Scope (this PR)

- **Edited in core v1.1** (deliberate candidate edits; none reuses a v1 name, so `changes.json` is unchanged; `release-baseline.json` pins the new hash): `ModelCall@2` (ids and digests only: run, lease generation, context, epoch, through-sequence, expected prefix digest, purpose, turn, attempt; no message, final turn or limit), `ModelResult@2` (`compacted`, `cleared`, `sectionTokens`; outcomes `compacted` and `lease_refused`), `RunTurn@1` (keyed by context and sequence; epoch, purpose, notices, section tokens, audience, taint; a reply only with `end_turn` or `tool_use`; `final` gone; an epoch's first row may carry no input because the opening carries the request), `RunToolCall@1` (context, code label, result item), `AgentRunManifest@1` (purpose, job, context, conversation, inbox row, lineage, envelope, `safety`, `pins`; a binding per kind, `call`, `review` and `upkeep` added), `AgentRunParams` (segment and incarnation), `AgentRunEndReason` and refusal codes (ADR-0041 item 34: six end reasons and eight tool refusals added, the retired ones kept for old records), `UserModelMessage` (post and state blocks), `ModelToolResultBlock` (labelled, 256 KiB). `AgentRunCaps` is removed; `AgentRunSafety@1` replaces it.
- **Added in core v1.1:** `AgentRunSafety@1`, `ContextPolicy@1`, `ContextEpoch@1`, `ContextCheckpoint@1`, `ContextLedger@1`, `RunPlan@1`, `RunCompletion@1`, `ReviewVerdict@1`, `RunWait@1`, `RunEvent@1`, `JobStatus@1`, `ConversationSummary@1`, `PersonMemory@1`, `PersonMemorySuggestion@1`, `NotebookEntry@2`, `MemorySearchHit@1` and their parts (76 definitions; `docs/contracts/contract-versions.md` lists them).
- **Context policy data:** `docs/decisions/context-policy.json` holds version 1, proposed, with ADR-0041 item 12's seeds for Opus 5.5 at `high` and `medium`; `scripts/generate-context-policy.mjs` validates each row, inspects the invariants a new epoch needs to converge (budgets fit the target, the progress guard, the hard guard holds a compaction request, a stored message holds a turn of previews, one-hour TTLs where a person waits) and generates `packages/policy/src/generated/context-policy.ts` with each row's digest; it runs in `contracts:generate` and `verify:boundaries`. No version is active, so `activeContextPolicyRow` answers null until a reviewed commit activates one with its eval record.
- **Code (pure, no I/O):** `packages/policy/src/harness.ts` (writable, retired, free and lapsed end reasons; `checkRunSafety`'s orderings; segment instance ids `<runId>-s<seg>-i<inc>`; wake events `w-<waitSeq>`); `context-policy.ts` (rows, thresholds, the reduction ladder's step, cache TTLs); `tool-catalogue.ts` refuses a tool context for `call`, `review` and `upkeep` until tool catalogue version 4 (H5).
- **Fakes:** `harness-fakes.ts` (one story: Morrow's fork calls Listings, proposes titles, has them reviewed and waits for them to go live) and `agent-platform-fakes.ts` (a manifest of every kind, the safety profile, pins). `fake-model-gateway.ts` is the fake broker: it builds each request from an in-memory context store, refuses a stale lease or a context its run is not attached to (`lease_refused`), refuses any other prefix (`prefix_mismatch`), applies the hard guard (`input_over_cap`), returns compaction blocks as `compacted`, and reports tokens per layout section.

## Not in this PR (H6's second PR)

ADR-0040's contract work: collaboration contract v1.2 (`MessageStatus` keeps only `completed`, `MessageDelta` and `StreamFrame`'s `message_delta` retire, with `schemas/v1.2/changes.json` entries); `StandingRequest@1`; the capabilities `workspace.job.stop` and `workspace.standing_request.revoke` (`human_only`); the `morrow` destination and the `live` WebSocket route in `workspace-routes.json`; the four request event rows (`job.created`, `job.status_changed`, `job.step_changed`, `message.delivery_changed`); their fakes and `collaboration-contracts.test.mjs`.

## Interfaces touched

`docs/contracts/schemas/v1.1/core.schema.json`, `docs/contracts/release-baseline.json`, `docs/contracts/contract-versions.md`; `docs/decisions/context-policy.json`; `packages/contracts/src/generated/*`; `packages/policy/src/{harness,context-policy,harness-fakes,fake-model-gateway,agent-platform-fakes,tool-catalogue}.ts`, `generated/context-policy.ts`, `package.json` exports; `scripts/generate-context-policy.mjs`; root `package.json` (`contracts:generate`, `verify:boundaries`); tests `harness-contracts`, `agent-platform-contracts`, `shop-knowledge`, `tool-catalogue`.

## Security notes

- **The broker reads only what the lease names.** ModelCall@2 carries no conversation, so a compromised orchestrator cannot hand the broker a made-up history; the fake refuses a call whose run is not the one attached to the named context (one writer per context), so a valid lease cannot borrow another person's context. H7c's broker must keep both rules against SQL.
- **Permission and budget checks stay in code.** AgentRunSafety@1 lives in the manifest the model never sees; no contract the model reads names credits, a balance or a countdown; no notice code asks the model to wrap up.
- **No model-written authority.** Checkpoints, summaries and plans have no field that can claim an approval, consent, apply or payment; the ledger shows every in-flight operation as unknown; a review verdict can only block or raise no objection.
- **Audience and taint on every derived row** (turns, checkpoints, plans, verdicts, summaries, notebook entries); `TaintKinds` never shrinks; person memory has one principal and no admin path in its shape.
- Retired codes stay in the enums so old records still validate; `writableEndReason` stops new code writing them.

## Test checklist

- [x] `tests/harness-contracts.test.mjs`: every fake validates; codes; safety ranges and orderings; instance ids; context policy data, digests, thresholds, ladder, hard guard and generator inspections; epochs, checkpoints, ledger; plan, completion gate, verdict; waits; events and the request card; memory; message blocks and compaction; the fake broker's one-writer, lease, compaction, epoch and hard-guard conformance.
- [x] `tests/agent-platform-contracts.test.mjs`: manifest bindings per kind, ModelCall@2 ids only, ModelResult@2, run_tool_calls and run_turns, the fake gateway's append-only prefix chain and protocol breaks.
- [x] `tests/shop-knowledge.test.mjs` and `tests/tool-catalogue.test.mjs` follow the edits.
- [x] `npm run contracts:generate` leaves the tree clean; `npm run verify:boundaries` passes with the new baseline.
- [ ] Hosted `foundation` check on the PR head.
- [ ] Tier 2 AI review (separate context, same model family) with the security lens (authority, durable execution, budgets).

## Open questions and follow-ups

- **Merge order with H5 (pull request 79).** Both edit core v1.1 and `tool-catalogue.ts`; the second to merge recomputes the baseline hash and the generated files.
- **Pull request 64 (the agent loop)** builds against the old ModelCall@2 and AgentRunCaps; H7a to H7c move it onto these contracts.
- **The loop catalogue** (`generated/loop-catalogue.ts`, `RunHold`) still computes caps-era holds; ADR-0041 item 38 rewrites its proposed version 2 with AgentRunSafety@1 values and a ContextPolicy reference, with the credit holds of H8.
- **Bundle size.** The validator bundle grows by about 1.1 MB (112 KB gzipped). H7c should measure the broker and orchestrator Workers against Cloudflare's size limit before the agent-loop switch goes on.
