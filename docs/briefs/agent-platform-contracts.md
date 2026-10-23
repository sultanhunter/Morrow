# Agent platform contracts (PR 10, track T2)

- Status: brief, 2026-10-23. Build order PR 10, "Contracts for the agent platform" (lane C; starts now; size M). Accepted decisions it carries out: ADR-0024 (mandates, the installation as requester, review rules), ADR-0026 (the rate card's shape, holds), ADR-0027 (the loop, model and tools), ADR-0028 (specialists), ADR-0030 item 10 (sending addresses), ADR-0031 (read tags), all OD-2026-10-23-7. Change class: public contracts already approved by those ADRs; no new material choice. The project-flow records (build order PR 17) are proposed, not approved: nothing here is theirs.
- Plan IDs: P13.T01 to P13.T03 (contracts slice), P05.T04 and P12.T04 (mandate and revoke shapes), P16.T01 (package), P17.T02 (sender identity). Branch `claude/t2-agent-platform-contracts`; one PR, or two if review prefers (schemas and capabilities first, policy modules and fakes second).

## Goal

The formats the agent loop (PR 11), proactive work (PR 21), specialists and the Sunrise screens build against, each with a fake, behind switches committed off. No live behaviour: no migration, no Worker reads any of it, no provider call.

## Scope

- **Contract v1.1 core, one appended block** (a deliberate candidate edit, as P05.T01ab and M3 did): read tags and data classes; `MandateActorRef`, `RunRequester`, `TriggerKind`, `QuietHours`, `MandateDocument@1`, `AgentTriggerSet@1`, `MandateTrigger@1`, `BatchConfirmationDocument@1`; `ToolName`, `ToolDefinition`, `ToolCatalogue@1` and one `ToolInput*` per tool; `ModelProfile@1`, `ModelProfileTarget`, `ModelProfileRevision@1`, `ModelProfileChange@1`; `AgentRunKind`, `AgentRunManifest@1`, `AgentRunParams@1` (`agent-run@1`, ids only), `AgentRunCaps`, `RunHold@1`, refusal and end codes; `ModelCallV2` (ModelCall@2) and `ModelResultV2` (ModelResult@2) with typed message blocks; `RunTurn@1` and `RunToolCall@1` (the rows of `run_turns` and `run_tool_calls`); `SpecialistBrief`, `SpecialistSpec@1`, `SpecialistStartDocument@1`, `ReportArtifact` (`report@1`); `SenderIdentity@1` with its enums, refusals and `SupportReplyParameters@1` (`senderIdentityId`); `AgentPackage@1` and `SkillManifest@1`. ModelCall@1, ModelResult@1 and every existing definition are unchanged.
- **Billing v1.1:** `RateCard@1` (shape only; no rate card is published).
- **Two capabilities:** `workspace.routine.revoke` (ADR-0024 item 4) and `governance.mail_identity.revise` (ADR-0030 item 10(c)), both `control`, `human_only`, not review-required, with closed bodies, bindings and rendered docs; "sender identity" joins the field scope of `support.reply.propose` and `support.reply.send`. `verify:billing` gains PW2b: revoke is never paid.
- **Tool catalogue** (`docs/contracts/tool-catalogue.json`, 15 tools): each with its capability, verb, replay class, 8 KiB bound, contexts and input definition. `scripts/generate-agent-platform.mjs` inspects it and writes `packages/policy/src/generated/tool-catalogue.ts` with each tool's strict model schema and the digest a manifest pins. The Specialist ceiling (`docs/contracts/specialist-ceiling.json`, 12 fixed ids) is generated beside it.
- **Catalogue version 2, proposed** in `docs/decisions/model-policy.json` (`run_shape: agent_loop`): nine entries, per-turn rates of four token kinds, ADR-0027 items 6 and 12's limits and defaults; the loop's sent and never-sent request fields (`loop_request`). It publishes only on the owner's confirmation; version 1 stays active for `listings-run@1`.
- **Switches committed off:** `docs/decisions/agent-loop-staging.json`, `docs/decisions/specialists-staging.json`.
- **Policy modules:** `tool-catalogue.ts` (offered tools per context, wire names, specialist capabilities), `loop-catalogue.ts` (worst-case turns, turn limits, holds, `cap_below_turn`, the final turn, the daily backstop, credit caps), `agent-package.ts` (package checks), `agent-platform-fakes.ts` (plain data, browser-safe) and `fake-model-gateway.ts` (scripted ModelCall@2 gateway, append-only).

Not here (follow-ups): migrations and the loop (PR 11); `edge:check` wiring of the two switches (PR 11, when a Worker reads them); widening Proposal@2's `requestedBy` to `RunRequester` and adding `editedFrom` (the review-rule packet, with `checkProposal`'s conflict set); new Inbox item kinds (PR 10b, after the Inbox work in flight); `readTags` fields on the shared items themselves (messages, artifacts, Inbox items; T6, as replacements); computer tools and `runtime.execution.use` (PRs 7 and 13); owner-template grants for the two new capabilities (with their definers); knowledge, notebook, collection and discount tools (new catalogue versions).

## Interfaces touched

`docs/contracts/schemas/v1.1/{core,capabilities,billing}.schema.json` and the release baseline; `docs/contracts/{capabilities.json,schema-types.json,tool-catalogue.json,specialist-ceiling.json}` and the rendered catalogue docs; `docs/decisions/{model-policy.json,provider-bindings.json,agent-loop-staging.json,specialists-staging.json}`; `scripts/{generate-agent-platform,generate-model-catalogue,provider-checks,billing-checks}.mjs`; `package.json` (`contracts:generate`, `verify:boundaries`); `packages/policy` (new modules and exports); generated files.

## Security notes

- **No tool takes SQL, a URL, a role, a store, a recipient, a sender, a credential or a model** (ADR-0027 item 3): the generator refuses a forbidden field name or a `format` anywhere in a tool's input, an `execute` on an external effect, any `approve` or `administer`, any `human_only` capability, a proposal tool on an unreviewed capability, customer mail outside Support's runs, look-for-work beyond reads and suggestions, and a Coordinator set other than ADR-0027 item 8's.
- **Model output never sets authority:** ModelCall@2 is closed (no model, effort, tools, limits or provider); tool inputs carry ids that code scope-checks; untrusted text enters only as a `data` block naming a closed source. Profiles are keys plus a catalogue version and never change tools, caps or grants.
- **Specialists:** the ceiling holds no order reads, `support.*`, delegation, task create or assign, publish execute or approve, or `human_only` capability; data classes exclude the customer tag; briefs name no upload.
- **Sending addresses:** one kind (`morrow_managed`, on `replies.`), reserved kinds and `personal` absent, the default always active, headers without CR or LF; replies bind `senderIdentityId`.
- **Checks in code, ahead-of-time validators:** every definition is compiled by `contracts:generate`; nothing compiles a schema at runtime. Fakes are validated by the tests, so they cannot drift.
- **Default off:** both switches are committed off and inspected by `verify:boundaries`; version 2 is proposed and `publishedLoopEntry` refuses it.

## Test checklist

- [x] `tests/agent-platform-contracts.test.mjs`: every fake validates; closed shapes and conditional rules per ADR item; the two capability bodies; the rate card's free list and caps; the fake gateway's prefix, invalid tool use and resend rules.
- [x] `tests/tool-catalogue.test.mjs`: generator reproduction; one refusal per forbidden field and per catalogue rule; contexts, wire names and strict schemas; the Specialist ceiling; the switches; the old formats unchanged.
- [x] `tests/loop-catalogue.test.mjs`: ADR-0027 item 12's table, turn limits, holds and expected runs; credit caps at US$149 and US$99; `cap_below_turn`; the final turn; the daily backstop; version 2's rule cases.
- [x] `tests/agent-package.test.mjs`: the package checks.
- [x] `tests/billing.test.mjs` PW2b; `tests/providers.test.mjs` scoped to the per-product shape.
- [x] `npm run -s typecheck`, `npm run -s verify`, `npm test` (4,133 tests), prettier on the changed files, `npm run build`, `smoke:scaffold`, `typecheck:edge`, `edge:check` and `edge:dry-run` (api 580,371 bytes gzipped, orchestrator 468,906, broker unchanged at 264,479 bytes) on the Mac, 2026-10-24.
- [x] Labs: no lab code changed. `lab:approval-records` reads the catalogue and the after-0018 list, so it ran once on the Mac: 294 of 295 checks, AC19's catalogue checks among them; AC15 failed on `HARNESS_SQL_UNAVAILABLE` at a load average near 700 and passed when rerun alone. CI's `pg-core` group is the authority.
- [ ] Hosted `foundation` on the PR head; AI review (separate context, same model family) with the security lens (authority, approvals, budgets).

## Questions for review

1. The tool list (15) and its capability mapping are the T2 reading of ADR-0027 items 3 and 8 and ADR-0028 item 2; `suggestion.create` maps to `workspace.comment.create` and `specialist.draft` to `agents.builder.describe`. Confirm or remap before PR 11 pins the digest.
2. Haiku 5.5's cache-read rate (US$0.01 per million, 0.1 of input) is not stated in ADR-0027; it enters with version 2's confirmation.
3. The validator bundle grows by about 840 KB (about 78 KB gzipped), mostly the typed tool-use blocks inlined into messages. The api's dry-run bundle is 580,371 bytes gzipped, under the 1 MiB warning and the 3 MiB limit.
