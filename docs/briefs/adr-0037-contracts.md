# Teammate and agent-card contracts with fakes (ADR-0037 PR 2)

- Status: brief, 2026-10-25. Decision: [ADR-0037](../decisions/adr/ADR-0037-main-agent-and-scoped-subagents.md) items 1 to 9, with the owner's values (OD-2026-10-25-3, OD-2026-10-25-4); plan row 2 of [adr-0037-implementation.md](../plan/adr-0037-implementation.md). Credits stay the only spend limit (ADR-0039, PR #75, not yet merged): this PR adds no money field and changes none. Change class: public contracts already approved by ADR-0037; no new material choice (the readings it had to make are the open questions below).
- Branch `claude/adr0037-contracts` from `main` at `66689751`. No migration (the next free number on `main` is 0052; open PRs hold 0052 to 0054). No new lab. Every switch stays off.

## Goal

The formats teammate calls (PR 4), Morrow's tools (PR 5), the agent-card authority packet (PR 3), the Team page (PR 6) and the evals (PR 9) build against, each with a deterministic fake, before any table, Workflow or screen exists.

## Scope

- **ToolCatalogue@1 version 3** (`docs/contracts/tool-catalogue.json`, 19 tools): `agent.ask` (a teammate call on `workspace.task.delegate`), `agent.result.read` (one page of a result item, a read on `workspace.artifact.read`) and `agent.propose` (an agent card on `agents.builder.describe`) in place of `specialist.draft`; `agent.route` without "once per job"; the briefs of `agent.ask` and `agent.route` a structured `TeammateBrief` (objective, details, done criteria, boundaries, record ids) with no character cap; a new `call` context for a called teammate's run (no `inbox.ask`, no `message.post`, no `support.*`), which ends with `result.submit`; the `specialist` context retired. Every `agent.*` tool, and every tool on `workspace.task.delegate` or `agents.*`, is offered to the Coordinator only.
- **Contracts (core v1.1, edited in place while a candidate; details in `contract-versions.md`):** TeammateResult@1 (outcome, end reason, typed counts, created record ids, closed next-step codes, read tags, taint, summary and typed findings, with no character cap), result items (ResultItemRef, ResultItem@1, ResultItemPage@1), AgentProposal@1 and AddToTeamDocument@1, AgentPackage@1 generalised for `origin` (`first_party`, `workspace`) with a workspace agent's instructions and skill text, SkillManifest@1's `eligibleForWorkspaceAgents`; SpecialistSpec@1, SpecialistStartDocument@1 and the Specialist ceiling retired; the `specialist` run kind retired (the manifest's `specDigest` and `dataClasses` are always null).
- **Policy (pure, Web Crypto only):** `teammates.ts` (the switch records; `buildTeammateResult`, which stores what does not fit one 8 KiB tool result whole as items, largest part first, then every finding in one JSON item; paging by characters or rows; `coordinatorMayOpen` and `teammateMayOpen`; the customer tag refused), `agent-cards.ts` (the exclusions; grants, scopes, data classes, customer level and Owner-only kinds derived from tools; drafts, narrowing edits, the digest, the 5-minute document, the workspace package), `agent-package.ts` (two origins, depth 1, item 5's exclusions, the instructions' digest), `tool-catalogue.ts` (the call context), `plan-draft.ts` (the Coordinator's grant set; the launch subset gates the new tools behind their switches).
- **Fakes:** data fakes in `agent-platform-fakes.ts`; `teammate-fakes.ts` with a fake result-item store and a fake teammate runner (each call admitted alone: an active teammate, 32 children per envelope, the balance answered by the caller with no amount), both built on the rules above.
- **Switches committed off:** `docs/decisions/teammate-calls-staging.json` and `agent-cards-staging.json` replace `specialists-staging.json`; `edge:check` refuses either on before G9, G10, the agent-loop switch and an eval round (agent cards also after the authority packet).

Not here: tables, definers, the lease re-issue and lab rows (PRs 3 and 4); Morrow's Ask tools (PR 5: `askTools` still routes once, until P05.T04b); graph nodes (PR 1); the plan step's `specialist` assignee (PR 8); the loop catalogue's specialist hold and every money field (ADR-0039's contracts PR).

## Interfaces touched

`docs/contracts/schemas/v1.1/core.schema.json`, `release-baseline.json`, `contract-versions.md`, `tool-catalogue.json`; `docs/decisions/{teammate-calls,agent-cards}-staging.json`; `scripts/generate-agent-platform.mjs`, `scripts/edge.mjs`; `packages/policy` (new `teammates.ts`, `agent-cards.ts`, `teammate-fakes.ts`, their exports; `agent-package.ts`, `tool-catalogue.ts`, `agent-platform-fakes.ts`, `loop-catalogue.ts` types, `projects/plan-draft.ts`); generated contracts and catalogue; `docs/graph` prose for the retired ceiling.

## Security notes

- **Depth 1:** the generator refuses an `agent.*`, delegation or `agents.*` tool outside the Coordinator's context, and package checks refuse such a tool or capability on any other package; no card may pick one.
- **A called teammate cannot talk to the person:** the call context never offers a question or a post, and the generator refuses one there.
- **No model-written authority:** `agent.propose` is the one input that names tools, by `ToolName` only (a reviewed exception to the forbidden-field rule); code derives every capability, scope, data class and limit, the store and model come from server facts, and an edit only narrows. A card holds no code, URL, credential or money field.
- **Item 5 exclusions:** never `human_only` (any verb), `workspace.task.delegate`, `agents.*`, `support.*`, Level 2 or the inbound-mail trigger on a card or workspace package; the four Owner-only kinds are derived in code.
- **Results and items:** closed, wrapped as tainting data (`teammate_result`, `result_item` sources); nothing customer-tagged enters Morrow's context; an item opens for Morrow only from a result its own run received, and for a teammate only when also named in its brief; an unknown id reads as not received.
- **No character cap, no truncation:** the 8 KiB tool-result bound stays; what does not fit becomes an item, pages count JSON escapes, and nothing is cut. Morrow's output tokens per turn bound a brief.
- **Default off; no money cap:** both switches off with `edge:check` guards; the fake runner asks only whether the balance covers a call.

## Test checklist

- [x] `tests/tool-catalogue.test.mjs` (75): version 3, the call context, depth 1, the `tools` exception, briefs without a character cap, the three switches; specialist cases removed.
- [x] `tests/agent-platform-contracts.test.mjs` (20): every fake validates; TeammateResult@1's outcome rules, items, cards, documents, packages, the codes of version 3; the retired definitions are gone.
- [x] `tests/agent-package.test.mjs` (32): depth 1 for first-party and workspace packages, item 5's exclusions, the instructions' digest, the origin of an id.
- [x] `tests/agent-cards.test.mjs` (8) and `tests/teammates.test.mjs` (15): derivation, exclusions, edits and digests, the document; results that fit and do not, paging, determinism, code outcomes, open checks, the fakes' conformance (parallel and repeated calls, 32 children, the balance, the customer tag).
- [x] `tests/edge-config.test.mjs` (the two switches), `tests/plan-draft.test.mjs`, `tests/graph.test.mjs`.
- [ ] `npm run -s typecheck`, `typecheck:edge`, `edge:check`, `verify`, `format:check`, `graph -- check`, `npm test` (results in the PR).
- [ ] Hosted `foundation` on the PR head; AI review (separate context, same model family) with the security lens (authority, approvals, contracts).

## Open questions

1. `result.submit` (on `workspace.artifact.edit`) is this PR's reading of "it ends with TeammateResult@1": a teammate is callable only when its package declares it, and code adds it to every card. Confirm the name and capability before PR 4 pins the digest.
2. A called teammate opens a result item named in its brief by code at call admission (PR 4); no teammate tool pages an item, since teammates hold no `agent.*` tool. If long items must be paged by a teammate, `work.read` gains a `result_item` target in a later catalogue version.
3. A card's trigger kinds are the model's pick from the closed list less `inbound_mail` (ADR-0037 item 4 says code writes them); its text bounds (name 60, purpose 300, instructions and each skill text 16,000, four skill texts) are provisional until a skill size budget is decided.
4. PR #64 (the agent loop) seeds tool catalogue version 2 with `specialist` contexts and lists `route_used` and `specialist_spec` in its checks; at integration it takes version 3 or a forward migration does.
