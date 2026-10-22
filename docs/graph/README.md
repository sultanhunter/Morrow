# Project knowledge graph

The project's knowledge and progress as one linked, checked graph, in place of Markdown files that do not link to each other. The owner asked for it on 2026-10-22 (OD-2026-10-22-1) and adopted it on 2026-10-23 as decision 10 of the redefined MVP (OD-2026-10-23-1). This is phase 0: the engine, the full schema, the graph built from what already has a home, and a small hand-written seed.

## How it works

- **Docs stay where they are, and each one is a node.** A packet's body belongs to its task, a brief's to its milestone, an ADR file's to its ADR, a live record's to its evidence node. Nothing moves or is renamed. Phase 2 adds a small YAML header to ADRs, briefs, evidence, acceptance files and the approval card, in place.
- **What already has a home is built from it** by `scripts/graph.mjs`:
  - `docs/plan/build-plan.md`: packages, parent and lettered tasks, plan acceptance, and the golden-path milestones (`GP1` to `GP5`, labelled M1 to M5);
  - `docs/progress/tasks.json`: parent task statuses;
  - packets: their task, auxiliary files and acceptance ids;
  - briefs `M<n>-*.md`: the beta milestones and the tasks their "Plan IDs" line includes;
  - ADR header bullets: status, Supersedes, Amends and Refines;
  - live evidence: the card its Approval bullet names, its unknown-outcome bullet, and the acceptance rows in `docs/acceptance/*.md` that cite it (`verifies`);
  - `docs/decisions/approvals/*.json`, `dependencies.json`, `sources.json`, `capabilities.json`;
  - `apps/*` and `packages/*` (components);
  - git history: merged pull requests from `(#n)` subjects, the tasks and milestones they name (`implements`) and the components they change (`touches`).
- **Only what has no home is hand-written**, one small file per node under this folder, so parallel agents do not conflict: the vision, features, agents, skills, installation kinds, tracks, gates, data classes, owner decisions with verbatim quotes, questions, risks and unmerged branches.
- **Each edge is stored once, on its "from" node.** Views show the inverse as backlinks.
- **An id's shape tells you its type.** A dropped node keeps its id with a dropped or superseded status; ids are never reused. Tracks and gates have slug ids and short labels, so renumbering a label never breaks a link.
- **Body text links too.** Unambiguous ids in a body (ADR, task, acceptance, decision, question, risk and the other hand-written families) become `mentions`. The ambiguous ones (`S`, `D`, `M`, `PR-`, track and gate labels) count only in typed links or as `[[S149]]`.
- **The graph is documentation, never authority.** Nothing in `apps/` or `packages/` may import it (`GRAPH_IMPORTED_BY_CODE`). Every permission, budget and data-class rule stays in code. The graph describes kinds (skills, releases, installation kinds), never a merchant's records: those are tenant data under FORCE RLS, and this repository is public (`GRAPH_TENANT_RECORD`, `GRAPH_SECRET`, `GRAPH_EMAIL`).
- **An owner decision is recorded once, with the owner's verbatim words** as a blockquote, and is never edited: a later decision `supersedes`, `amends` or `refines` it. A decision whose whole quote appears in an ADR's Approval section is derived as that ADR's `approved_by`; in a live record's Approval bullet, as its `authorized_by`.

## Layout

```
docs/graph/
  README.md                 this file; the schema block below is generated
  vision/V-*.md
  features/F-*.md
  agents/AG-*.md
  skills/SK-*.md                 (until skills/<id>/skill.json exists)
  installation-kinds/IK-*.md
  tracks/TRK-*.md
  gates/GATE-*.md
  data/DC-*.md
  milestones/M<n>.md             (beta milestones with no brief)
  decisions/OD-YYYY-MM-DD-n.md
  questions/Q-*.md
  risks/RISK-*.md
  components/C-*.md              (logical components only)
  branches/claude--<slug>.md     ("/" becomes "--" in the file name)
```

A node file is a header and an optional body:

```markdown
---
id: OD-2026-10-22-2
type: decision
title: Drop the invite-only listings beta; launch a lean, full-featured MVP
status: recorded
date: 2026-10-22
by: owner
channel: chat
links:
  supersedes: [OD-2026-10-19-1]
---

> the owner's words, verbatim

Effect: what it changes, in a few lines.
```

Headers use the YAML failsafe schema: strings, lists and maps only, no aliases and no duplicate keys. Quote a value that would read as something else in YAML (`"no"`, `"3"`). The commands below write headers in one canonical form.

## Commands

All offline. `npm run graph -- <command>`:

| Command | Does |
| --- | --- |
| `check [--strict] [--verbose]` | The CI check; `npm run graph:check` runs it inside `npm run verify`. `--strict` treats the phase-0 warnings as errors |
| `show <ID> [--depth 2] [--json] [--all]` | Fields, edges out, backlinks in, the parts of a task with what verifies them, mentions |
| `query ready` | Work whose dependencies are done and which waits on no open question or gate |
| `query open` | Open questions and actions, open gates, unknown outcomes, cards expiring within 14 days, open risks, ADRs resting on a superseded decision |
| `query gates [--week W3]`, `query critical`, `query slip`, `query data` | Open gates by week and owner; the longest chain to the launch gate; agents and features in slip order; data classes and their deletion path |
| `query skills <agent id>`, `query ceiling <installation kind or agent id>` | An agent's bundled or composable skills; a kind's documented ceiling (the code's allowlist stays the authority) |
| `query uncovered` | Plan tasks that no feature or track includes or defers by name |
| `query blockers <ID>`, `impact <ID>`, `why <ID>`, `path <A> <B>` | What is in the way; what depends on it and who cites it; what governs it; how two nodes connect |
| `query stale [--days 7]`, `query todo` | Active nodes with no recent PR or evidence; governed docs still without a header |
| `render [--check]` | Writes `graph.json` and a self-contained `graph.html` under the artifacts directory (`.artifacts/graph/`, git-ignored), and refreshes the generated blocks. `--check` fails if a block is stale |
| `view <ID> --mermaid [--depth 2]` | A Mermaid snippet of a neighbourhood, for PRs and briefs |
| `status [--write]` | The live status from the graph, with where STATUS.md disagrees with history. `--write` fills STATUS.md's marked block (phase 3 adds the markers) |
| `add decision --date D --title T --quote-file F` | Picks the next `OD-D-n` and writes the file; the quote file avoids shell quoting |
| `add <type> <ID> --title T [--status S] [--<field> V]` | Writes a hand-written node. Refuses a wrong id shape or an existing id |
| `link <FROM> <edge> <TO>`, `unlink …` | Edits FROM's header after checking the edge |
| `set <ID> <field>=<value>` | A parent task's status goes to `tasks.json`, a lettered task's to its packet header, anything else to its node file |

`graph.html` has type and status filters, search, a two-hop focus view and a side panel with fields, backlinks and a link to the doc on GitHub. It loads the pinned Cytoscape.js script from cdnjs and falls back to a list when offline. It is never committed and never published from CI: on request Claude can share it as a private page; GitHub Pages would be a public publication and needs the owner's approval.

## The check

`graph:check` runs in `npm run verify`, so it runs in CI's `checks` job on every pull request, Markdown-only ones included. Each rule has a fixed code, and `tests/graph.test.mjs` plants one mistake per error code and expects exactly that code back. The `checks` job fetches full history (`fetch-depth: 0`) so merged PR nodes can be built; without history the check skips them with a warning, never an error.

In phase 0 three rules are warnings, because the docs they need have no headers yet: `GRAPH_ORPHAN`, `GRAPH_UNCLAIMED_DOC` and `GRAPH_NEW_PACKET`. The rules that read hand-written fields (`GRAPH_ADR_APPROVAL`, `GRAPH_EVIDENCE_AUTH`, `GRAPH_TENANT_RECORD`, `GRAPH_DECISION_QUOTE`) apply to every node with a header; an unresolved id in a doc without a header is the warning `GRAPH_WARN_LEGACY_MENTION` and becomes `GRAPH_LINK_DANGLING` once the doc has one.

## Phases

| Phase | Content |
| --- | --- |
| 0. The engine | This folder's seed, the schema, the derived graph and the check (this PR) |
| 1. The MVP as nodes | Vision, features, agents, skills, installation kinds, tracks, gates and data classes of the redefined MVP; its decision questions and answers; the train branches. Every plan task included or deferred by name, so `query uncovered` starts empty |
| 2. Headers in place; strict mode | Headers on ADRs, briefs, evidence, acceptance files and the card; the ADR index generated; build-plan's M1 to M5 become GP1 to GP5; `graph:check` takes over `plan:check`; the phase-0 warnings become errors; owner decisions of 2026-10-17 to 2026-10-22 backfilled |
| 3. Change the habit | STATUS.md's fact block generated; the CLAUDE.md session-start step (the owner sees the diff first) |
| 4. Archive, after launch | Packets, acceptance files and references that nothing pins leave the tree for a new archive tag; the six paths pinned by applied migrations stay |

## Schema

<!-- graph:schema:start -->
<!-- Generated by `npm run graph -- render` from scripts/graph-schema.mjs. Do not edit by hand. -->

#### Node types

| Type | Id shape | Stored | Status values | Fields (required in bold) |
| --- | --- | --- | --- | --- |
| vision | `V-<slug>` | hand-written (`docs/graph/vision/`) | active | none |
| feature | `F-<slug>` | hand-written (`docs/graph/features/`) | proposed, planned, active, done, dropped | `area`; `must` (yes, later) |
| agent | `AG-<slug>` | hand-written; later `agents/<id>/agent.json` (`docs/graph/agents/`) | proposed, planned, built, released, dropped | **`kind` (builtin, installable, task_specialist)**; `slip_rank` (`^[0-9]$`); `scopes_required` (list of Shopify scopes); `scopes_optional` (list of Shopify scopes); `customer_data` (none, level1, level2); `computer` (yes, no, fallback); `depth` (0, 1) |
| skill | `SK-<slug>` | hand-written until `skills/<id>/skill.json` exists (`docs/graph/skills/`) | proposed, planned, built, released, revoked, dropped | **`specialist_eligible` (yes, no)**; `runtime` (none, computer, computer-optional, fallback); `output_contract`; `job_tags` (list) |
| installation_kind | `IK-<slug>` | hand-written (`docs/graph/installation-kinds/`) | proposed, planned, built, dropped | `lifetime`; **`mandate` (yes, no)**; **`triggers` (yes, no)**; `started_by` (owner-admin-install, owner-start, member-start); **`routable` (yes, no)**; `authority_records` |
| track | `TRK-<slug>` | hand-written or brief frontmatter (`docs/graph/tracks/`) | proposed, active, done, dropped | **`label` (`^T[0-9]{1,2}$`)**; `weeks`; `agents` (list) |
| gate | `GATE-<slug>` | hand-written (`docs/graph/gates/`) | open, passed, waived, dropped | **`label` (`^G[0-9]{1,2}$`)**; `owner_kind` (owner, shopify, provider, ci, claude); `due_week` (`^W[0-9]{1,2}$`) |
| data_class | `DC-<slug>` | hand-written (`docs/graph/data/`) | planned, deletion-ready, live, retired | `retention`; `deletion`; `customer` (yes, no) |
| milestone | `M<n> (beta), GP<n> (golden path)` | brief frontmatter, a file when there is no brief, or the plan (GP) (`docs/graph/milestones/`) | proposed, active, done, folded, dropped | `label` (`^M[1-9]$`) |
| package | `P<nn>` | the plan; acceptance-file frontmatter | from its source | `kind` (security) |
| task | `P<nn>.T<nn>, P<nn>.T<nn><letters>` | the plan and `tasks.json`; packet frontmatter | Planned, Ready, In progress, In review, Self-reviewed, Verified, Blocked, Dropped | `kind` (security) |
| acceptance | `P<nn>.A<nn>, <task>-AC<nn>[a-z]` | the plan, packets and `docs/acceptance/` | open, passed, deferred | none |
| adr | `ADR-<nnnn>, ADR-draft-<slug>` | `docs/decisions/adr/` (header bullets; frontmatter from phase 2) | proposed, accepted, superseded, rejected | `date` (date); `readme_status` |
| decision | `OD-<yyyy-mm-dd>-<n>` | hand-written; the verbatim quote is a blockquote (`docs/graph/decisions/`) | recorded | `date` (date); **`by` (owner, claude)**; `channel` (chat, pr, call, email) |
| card | `<env>-card-<n>` | `docs/decisions/approvals/*.json` and their record | approved, expired, revoked | `approved_on` (date); `expires_on` (date) |
| evidence | `<yyyy-mm-dd>-<slug> (the file stem)` | `docs/evidence/live/` (bullets; frontmatter from phase 2) | recorded | `unknown_outcome` (none, open, closed) |
| pr | `PR-<n>` | merged pull requests from git history | open, merged, closed | `commit` (`^[0-9a-f]{7,40}$`); `date` (date) |
| branch | `claude/<slug>` | hand-written (unmerged branches only) (`docs/graph/branches/`) | built, open, merged, abandoned | `head` (`^[0-9a-f]{7,40}$`) |
| component | `C-<slug>` | `apps/*` and `packages/*`; logical parts hand-written (`docs/graph/components/`) | local, staging, production | none |
| dependency | `D<nn>` | `docs/decisions/dependencies.json` | from its source | none |
| source | `S<nn>, S<nnn>` | `docs/research/sources.json` | from its source | none |
| capability | `dotted lowercase, e.g. catalog.content.publish` | `docs/contracts/capabilities.json` | from its source | none |
| question | `Q-<slug>` | hand-written (`docs/graph/questions/`) | open, answered, withdrawn | **`kind` (decide, do, provider)**; **`asked_of` (owner, claude, shopify, provider)** |
| risk | `RISK-<slug>` | hand-written (`docs/graph/risks/`) | open, mitigated, accepted, closed | none |
| reference | `its path: docs/**.md, CLAUDE.md, AGENTS.md, README.md` | every other doc, by its path | from its source | none |

#### Edge types

| Edge | From → to |
| --- | --- |
| `part_of` | task → package, task; acceptance → task, package; feature → vision; component → component |
| `includes` | feature, track, milestone → task, package |
| `delivers` | track, milestone → feature, agent, skill, installation_kind |
| `needs` | agent, skill, feature → capability, component, feature |
| `holds` | agent, skill, feature → data_class |
| `bundles` | agent → skill |
| `composes` | agent → skill |
| `delegates_to` | agent → agent |
| `installs_as` | agent → installation_kind |
| `may_hold` | installation_kind, agent → capability |
| `never_holds` | installation_kind, agent → capability |
| `deleted_by` | data_class → task, track, pr |
| `depends_on` | task, track, feature, agent, skill, milestone, gate → task, track, feature, agent, skill, milestone, gate, pr, question |
| `waits_on` | task, track, feature, agent, skill, milestone, gate → gate |
| `governed_by` | any → adr, decision |
| `approved_by` | adr, card, gate, feature → decision |
| `supersedes` | adr → adr; decision → decision |
| `amends` | adr → adr; decision → decision |
| `refines` | adr → adr; decision → decision |
| `answers` | decision → question |
| `implements` | pr, branch → task, track, milestone |
| `from_branch` | pr → branch |
| `stacked_on` | branch → branch |
| `verifies` | evidence, pr → acceptance, task, gate |
| `authorized_by` | evidence → card, decision |
| `touches` | pr, task → component |
| `uses` | component, capability → dependency |
| `cites` | adr, decision, reference, dependency → source |
| `raised_by` | question, risk → decision, evidence, adr |
| `about` | question, risk → any |
| `mitigated_by` | risk → task, track, adr, question |
| `mentions` | any → any |

#### Check codes

| Code | Rule | Phase 0 |
| --- | --- | --- |
| `GRAPH_PARSE` | Frontmatter parses with the failsafe schema: strings, lists and maps only | error |
| `GRAPH_FIELD` | Fields are closed per type, required fields are present, closed values come from their lists | error |
| `GRAPH_ID_SHAPE` | An id matches its type's pattern | error |
| `GRAPH_ID_DUPLICATE` | An id is unique across files, the plan, tasks.json and the registries | error |
| `GRAPH_LABEL_DUPLICATE` | Track and gate labels are unique among active nodes | error |
| `GRAPH_LINK_DANGLING` | Every typed link and unambiguous mention resolves | error |
| `GRAPH_EDGE_TYPE` | Each edge connects the types its table allows | error |
| `GRAPH_UNCLAIMED_DOC` | Every governed .md belongs to one node, and every node's doc path exists | warning |
| `GRAPH_ORPHAN` | Every node except V-morrow has a typed edge; reference docs need one link in | warning |
| `GRAPH_CYCLE` | No cycles in part_of, supersedes, depends_on or waits_on | error |
| `GRAPH_STATUS` | Status values come from the type's list | error |
| `GRAPH_TASK_STATUS_DRIFT` | Parent task statuses equal tasks.json, and both list the same tasks | error |
| `GRAPH_GATE_FIELDS` | An open gate has owner_kind and due_week | error |
| `GRAPH_DATA_CLASS` | A live data class has a deleted_by link to a merged PR | error |
| `GRAPH_SKILL_ELIGIBLE` | A skill a task_specialist composes is specialist_eligible and holds no customer data class | error |
| `GRAPH_AGENT_KIND` | delegates_to starts at a builtin agent; a task_specialist delegates nothing and never_holds workspace.task.delegate; bundles starts at an installable agent | error |
| `GRAPH_INSTALLATION_KIND` | triggers need a mandate; routable needs triggers or a mandate; IK-task-specialist is not routable | error |
| `GRAPH_TENANT_RECORD` | No node id or field looks like a tenant record id | error |
| `GRAPH_DECISION_QUOTE` | An owner decision has a date, a channel and a blockquote | error |
| `GRAPH_EVIDENCE_AUTH` | Evidence with a header has authorized_by and an unknown_outcome value | error |
| `GRAPH_ADR_APPROVAL` | An accepted ADR with a header has approved_by | error |
| `GRAPH_NEW_PACKET` | A new packet or acceptance file declares kind: security | warning |
| `GRAPH_SECRET` | No known secret pattern in the hand-written graph or any frontmatter | error |
| `GRAPH_EMAIL` | No email address in the hand-written graph or any frontmatter | error |
| `GRAPH_STALE_GENERATED` | Generated blocks (graph README schema, ADR index) are fresh | error |
| `GRAPH_STATUS_LINES` | STATUS.md is at most 80 lines | error |
| `GRAPH_IMPORTED_BY_CODE` | Nothing in apps/ or packages/ imports the graph | error |
| `GRAPH_WARN_SUPERSEDED_BASIS` | An accepted ADR whose approving decision was superseded | warning |
| `GRAPH_WARN_STALE_ACTIVE` | An active node with no recent PR or evidence | warning |
| `GRAPH_WARN_CARD_EXPIRING` | An approval card expires within 14 days | warning |
| `GRAPH_WARN_GATE_OVERDUE` | An open gate past its due week | warning |
| `GRAPH_WARN_PLAN_UNCOVERED` | A plan task that no feature or track includes or defers by name | warning |
| `GRAPH_WARN_LABEL_COLLISION` | Two milestones share a label (M2 to M5: beta and golden path) | warning |
| `GRAPH_WARN_LEGACY_MENTION` | A doc without a header mentions an id that does not resolve (an error once it has one) | warning |
| `GRAPH_WARN_NO_HISTORY` | Git history is shallow or missing, so PR nodes are skipped | warning |
<!-- graph:schema:end -->
