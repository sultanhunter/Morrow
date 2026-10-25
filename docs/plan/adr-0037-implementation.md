# ADR-0037 implementation: follow-up PRs

- Record: the follow-up PRs of [ADR-0037](../decisions/adr/ADR-0037-main-agent-and-scoped-subagents.md) (Morrow as the main agent with scoped subagents; one agent kind with two origins), accepted 2026-10-25 (OD-2026-10-25-3). They replace v1 build order PR 26 ("Specialists").
- Written 2026-10-25 from `main` at `13e04367`. No code lands with the ADR.
- Rules: each PR is small, behind a switch committed off, on a short-lived `claude/` branch, with its tests and one AI review (separate context, same model family) with the security lens; stacks at most two deep. Sizes: S (a day or less), M (two to three days), L (a week, usually two PRs).

## Order

| # | PR | Size | Starts after | What it does |
| --- | --- | --- | --- | --- |
| 1 | Plan and graph | S | ADR-0037 merged | `mvp.md` and `v1-build-order.md` (PR 26 becomes these PRs); graph nodes: `AG-specialist` and `IK-task-specialist` dropped, `F-specialists` and `TRK-specialists` retitled for workspace-created agents, `F-agent-builder` gives up the launch slice of P16.T02 (a new lettered child of it, which `F-specialists` includes), `IK-installed-agent` covers both origins; `scripts/graph-schema.mjs`'s agent kinds and the `GRAPH_AGENT_KIND`, `GRAPH_SKILL_ELIGIBLE` and `GRAPH_INSTALLATION_KIND` rules follow, with their `tests/graph.test.mjs` cases |
| 2 | Contracts with fakes | M, perhaps two PRs | 1 | AgentProposal@1 and its "Add to team" document; TeammateResult@1 (closed, at most 8 KiB, one summary of at most 2,000 characters); AgentPackage@1 generalised for workspace-authored packages (`origin`, instruction and skill text) or a successor version; a new tool catalogue version with `agent.ask` and `agent.propose` in place of `specialist.draft`, and `agent.*` refused for every non-Coordinator package; SpecialistSpec@1, SpecialistStartDocument@1, `specialist-ceiling.json` and `specialists-staging.json` retired in favour of default-off switches for agent cards and teammate calls; fakes for each; ADR-0037's listed values confirmed by the owner |
| 3 | Agent-card authority packet | L, two PRs | 2 | Forward migrations: `agent_installations.origin`, workspace packages, card revisions and documents (FORCE RLS); the "Add to team" transaction (document consumed once, rebuilt from live facts, approver holds each grant with `delegate`, the four Owner-only kinds, the exclusion list, the limit of 10); a general grant issuer replacing the Listings-only path for both origins; the mandate when a card names triggers; a new `lab:agent-cards` and `lab:tenant-conformance` rows |
| 4 | Teammate call in the loop | M to L | 2; PR #64 merged | `agent.ask` as a durable step: a child run on a child task under the envelope, no `inbox.ask` or posts to the person, the typed result validated and wrapped, taint and read tags carried into Morrow's run, customer-tagged results refused; one call or hand-off per Morrow run; holds per run; `lab:agent-runs` and `lab:agent-authority-workers` rows |
| 5 | Morrow's tools | M | 4; v1 build order PR 12 | The fixed set with `agent.ask` and `agent.propose`; a code-built list of active teammates in the opening context; the hand-off only when a teammate must own the conversation; the read-only call in an Ask after P05.T04b; cards drafted after a result carry its taint |
| 6 | Team page and the agent card | M | 2 (fakes); 3 and 5 to switch on | One teammate list under Morrow with provenance ("Built by the Morrow team", "Made by Morrow"); the card with its instructions, tools, grants, scopes, caps, model and taint mark; "Add to team", change cards, pause and remove; the idle suggestion; the "Let Morrow suggest new teammates" setting |
| 7 | Data lifecycle | S to M | 3 | Deletion handlers in the one registry for cards, documents, workspace packages and removed agents' authority rows (ADR-0037 item 8), and their lab rows (G9) |
| 8 | Plan steps | S to M | 3, 6 | A plan step names a teammate or a new one; a forward migration maps migration 0046's `specialist` assignee kind; "Start check-up" becomes "Add to team" |
| 9 | Evals | M | 2; 4 for loop cases | The case format, CI replay against fakes with recorded outputs, the first golden set of 10 to 16 tasks (case ids and rubrics only in the repository), and the first live round under the caps; reports compare designs task by task |
| 10 | Switches on | S each | 3 to 9, G9, G10, the agent-loop switch, a passing eval round | One reviewed commit per switch: teammate calls, then agent cards |

PRs 2 and 9 can start in parallel; 6 builds against the fakes while 3 to 5 land. The agent-card authority packet (3) is the security-heavy one and gets the full packet treatment; the rest use a one-page brief.

## Not in these PRs

Each needs its own owner decision first (ADR-0037, Consequences): Level 2 customer data or `support.*` for workspace-created agents; more than one teammate call per Morrow run; a fold or split of first-party agents; Morrow reading store data; per-person memory; the notebook read-back path; caching the conversation; compaction; an on-demand `skill.read`.
