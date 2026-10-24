# Project knowledge graph

The project's knowledge and progress as one linked, checked graph, in place of Markdown files that do not link to each other. The owner asked for it on 2026-10-22 (OD-2026-10-22-1) and adopted it on 2026-10-23 as decision 10 of the redefined MVP (OD-2026-10-23-1). Phase 0 built the engine, the full schema, the graph built from what already has a home, and a small hand-written seed. Phase 1 adds the redefined MVP as nodes: its tracks, gates, features, agents, skills, installation kinds, data classes, decision questions with their answers, risks, the v1 build order and the train's branches (see "Phase 1" below).

## How it works

- **Docs stay where they are, and each one is a node.** A packet's body belongs to its task, a brief's to its milestone, an ADR file's to its ADR, a live record's to its evidence node. Nothing moves or is renamed. Phase 2 adds a small YAML header to ADRs, briefs, evidence, acceptance files and the approval card, in place.
- **What already has a home is built from it** by `scripts/graph.mjs`:
  - `docs/plan/build-plan.md`: packages, parent and lettered tasks, plan acceptance, and the golden-path milestones (`GP1` to `GP5`, labelled M1 to M5);
  - `docs/progress/tasks.json`: parent task statuses;
  - packets: their task, auxiliary files and acceptance ids;
  - briefs `M<n>-*.md`: the beta milestones and the tasks their "Plan IDs" line includes;
  - ADR header bullets: status, Supersedes, Amends and Refines;
  - live evidence: the card its Approval bullet names and its unknown-outcome bullet;
  - acceptance tables in `docs/acceptance/*.md`: a row whose status cell starts "Open" or "Not done" is `open`, one that starts "Deferred" is `deferred`, and either only `mentions` the live records it cites; any other row is `verified` by them (`verifies`);
  - `docs/decisions/approvals/*.json`, `dependencies.json`, `sources.json`, `capabilities.json`;
  - `apps/*` and `packages/*` (components);
  - git history: merged pull requests from `(#n)` subjects and from GitHub's merge commits ("Merge pull request #n from owner/branch", titled by the commit body's first line); the tasks and milestones the title's label names (`implements`: "P04.T01i PR-D:", "M2 PR-1:", "v1 PR 18:" for `V1-PR18`, and a stacked step's "v1 PR 3a:" for `V1-PR03`); the branch node it came from (`from_branch`), whose `implements` the PR inherits; and the components it changes (`touches`); and each local or remote-tracking branch's newest commit date, which tells an open branch node from an abandoned one.
- **Only what has no home is hand-written**, one small file per node under this folder, so parallel agents do not conflict: the vision, features, agents, skills, installation kinds, tracks, gates, data classes, the v1 build order's steps, owner decisions with verbatim quotes, questions, risks and the train's branches.
- **Each edge is stored once, on its "from" node.** Views show the inverse as backlinks. One edge has a stored inverse: a question written after the owner decision that answered it carries `answered_by`, because a decision's file is never edited (`answers` stays for a decision recorded with its question).
- **An id's shape tells you its type.** A dropped node keeps its id with a dropped or superseded status; ids are never reused. Tracks and gates have slug ids and short labels, so renumbering a label never breaks a link.
- **Body text links too.** Unambiguous ids in a body (ADR, task, acceptance, decision, question, risk and the other hand-written families) become `mentions`. The ambiguous ones (`S`, `D`, `M`, `PR-`, track and gate labels) count only in typed links or as `[[S149]]`.
- **The graph is documentation, never authority.** Nothing in `apps/` or `packages/` may import it (`GRAPH_IMPORTED_BY_CODE`). Every permission, budget and data-class rule stays in code. The graph describes kinds (skills, releases, installation kinds), never a merchant's records: those are tenant data under FORCE RLS, and this repository is public (`GRAPH_TENANT_RECORD`, `GRAPH_SECRET`, `GRAPH_EMAIL`).
- **An owner decision is recorded once, with the owner's verbatim words** as a blockquote, and is never edited: a later decision `supersedes`, `amends` or `refines` it. A decision whose whole quote appears in an ADR's Approval section is derived as that ADR's `approved_by`; in a live record's Approval bullet, as its `authorized_by`. The repository is public, and the owner approved keeping these verbatim quotes in it, with anything personal left out (OD-2026-10-23-7, item 34).

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
  milestones/V1-PR<nn>.md        (the v1 build order's PRs 1 to 26)
  milestones/MS-*.md             (a track's stage the plan names without a PR)
  decisions/OD-YYYY-MM-DD-n.md
  questions/Q-*.md
  risks/RISK-*.md
  components/C-*.md              (logical components only)
  branches/claude--<slug>.md     ("/" becomes "--" in the file name)
```

## Phase 1

- **Tracks and gates** are `docs/plan/mvp.md`'s T0 to T18 and G1 to G18, as ADR-0035 changed them (G6 and G15 dropped). T16 is the header of its brief, `docs/briefs/project-graph.md`. The launch is `GATE-launch`, labelled G19 because every gate needs a label; `query critical` walks back from it. A gate carries the plan's week as `due_week`; where the plan names an event instead (G9 "before real data", G10, G17), it carries `due_when` and no week, so it is never reported overdue and every `query gates --week` lists it.
- **T17's simulated week** is the milestone `MS-simulated-week` (`MS-<slug>`: a track's stage that the plan names without a PR). App Review submission (G13), the owner's sign-off (G17) and the launch depend on it, and T17 itself `waits_on` those gates, since the track ends with the launch. The critical chain is the plan's: T0, T2, T4, T12, the simulated week, submission, review, launch.
- **Coverage.** Each of the 80 plan tasks is included or deferred by name by a track, directly, through its package, or through every one of its lettered children, so `query uncovered` is empty; features also include the tasks they draw on (mvp.md's "Plan IDs"). Work left until after launch is a feature with `must: later` that `defers` its tasks, or a track's `defers`. A lettered child deferred by name is left out of a parent that another node includes (P05.T01aa, SSO and SCIM, out of P05.T01). Package 17 at launch is the Resend adapter (P17.T02g) and P17.T01's support-reply contract; P17.T02a to P17.T02f are deferred by name.
- **The v1 build order** (`docs/plan/v1-build-order.md`, ADR-0035) is 26 milestones, `V1-PR01` to `V1-PR26`: each is `part_of` its tracks (a new edge, milestone to track), `delivers` its features or agents, `depends_on` the steps it starts after, `waits_on` its gates and claims its briefs as `docs`. A merged PR whose title starts "v1 PR <n>:" implements it; #48, #49 and #53, whose titles name no step, implement theirs through their branch nodes. The schema has no build-step type, so milestone is the closest kind.
- **Branches** are the train's: the six building from `5541e430` and this phase's, status `open`, and the merged branches whose PRs name nothing (#46 to #49, #53, #59), status `merged` with their head. A merged PR from a branch node that is not marked merged is `GRAPH_WARN_BRANCH_MERGED`. An open or built branch counts as recent work for `GRAPH_WARN_STALE_ACTIVE` only while a local or remote branch of its name has a commit within the window (7 days, or `query stale --days N`); otherwise the branch node is `GRAPH_WARN_BRANCH_STALE`, so an abandoned or squash-merged branch cannot hide stale work. The build-order steps that deliver a feature count for it too.
- **Decision questions** are the MVP's decisions 1 to 11 and the billing option (answered by OD-2026-10-23-1 and OD-2026-10-23-3), each companion record's owner questions (OD-2026-10-23-7, OD-2026-10-24-1), the visual direction, the UX flow and ADR-0035; open ones are the owner's actions and provider answers that STATUS.md and ADR-0035 name.
- **Installation kinds** document ceilings by capability id, never by verb. `IK-task-specialist`'s `may_hold` is exactly the 12 ids of `docs/contracts/specialist-ceiling.json` plus `runtime.execution.use` (under the runtime switch), and a repository test compares them; the two publish ids are held with `propose` only. The code's allowlist stays the authority.
- **Skills** carry working ids until `skills/<id>/skill.json` exists (Q-skill-ids); only `listing-content` is named in the plan.
- **Data classes** are the five the deletion registry handles since #43 (`deletion-ready`) and ADR-0031's new classes (`planned`), each `deleted_by` the PR or track that owns its path.

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
| `show <ID> [--depth 2] [--json] [--all]` | Fields, edges out, backlinks in, the parts of a task with their status and what verifies or implements them, mentions |
| `query ready` | Work whose dependencies are done and which waits on no open question or gate |
| `query open` | Open questions and actions, open gates, unknown outcomes, cards expiring within 14 days, open risks, ADRs resting on a superseded decision |
| `query gates [--week W3]`, `query critical`, `query slip`, `query data` | Open gates by week and owner; the longest chain to the launch gate; agents and features in slip order; data classes and their deletion path |
| `query skills <agent id>`, `query ceiling <installation kind or agent id>` | An agent's bundled or composable skills; a kind's documented ceiling (the code's allowlist stays the authority) |
| `query uncovered` | Plan tasks that no feature or track includes (`includes`) or leaves until after launch (`defers`) by name, directly or through their package; a dropped feature or track covers nothing |
| `query blockers <ID>`, `impact <ID>`, `why <ID>`, `path <A> <B>` | What is in the way; what depends on it and who cites it; what governs it; how two nodes connect |
| `query stale [--days 7]`, `query todo` | Active nodes with no recent PR or evidence and no open or built branch with a recent commit; governed docs still without a header |
| `render [--check]` | Writes `graph.json` and a self-contained `graph.html` under the artifacts directory (`.artifacts/graph/`, git-ignored), and refreshes the generated blocks. `--check` fails if a block is stale |
| `view <ID> --mermaid [--depth 2]` | A Mermaid snippet of a neighbourhood, for PRs and briefs |
| `status [--write]` | The live status from the graph, with where STATUS.md disagrees with history. `--write` fills STATUS.md's marked block (phase 3 adds the markers) |
| `add decision --date D --title T --quote-file F` | Picks the next `OD-D-n` and writes the file; the quote file avoids shell quoting |
| `add <type> <ID> --title T [--status S] [--<field> V]` | Writes a hand-written node. Refuses a wrong id shape or an existing id |
| `link <FROM> <edge> <TO>`, `unlink …` | Edits FROM's header after checking the edge |
| `set <ID> <field>=<value>` | A parent task's status goes to `tasks.json`, a lettered task's to its packet header, anything else to its node file. It never changes `id`, `type`, `links` (use `link`) or `docs` |

`graph.html` has type and status filters, search, a two-hop focus view and a side panel with fields, backlinks and a link to the doc on GitHub. It loads the pinned Cytoscape.js script from cdnjs and falls back to a list when offline. It is never committed and never published from CI. On request Claude shares it as a private claude.ai page, not on GitHub Pages, which would publish it (OD-2026-10-23-7, item 33).

## The check

`graph:check` runs in `npm run verify`, so it runs in CI's `checks` job on every pull request, Markdown-only ones included. Each rule has a fixed code, and `tests/graph.test.mjs` plants one mistake per error code and expects exactly that code back. The `checks` job fetches full history (`fetch-depth: 0`) so merged PR nodes can be built; without history the check skips them with a warning, never an error, and a link to a PR (a live data class's `deleted_by` among them) is a warning until history can resolve it.

In phase 0 three rules are warnings, because the docs they need have no headers yet: `GRAPH_ORPHAN`, `GRAPH_UNCLAIMED_DOC` and `GRAPH_NEW_PACKET`. The rules that read hand-written fields (`GRAPH_ADR_APPROVAL`, `GRAPH_EVIDENCE_AUTH`, `GRAPH_TENANT_RECORD`, `GRAPH_DECISION_QUOTE`) apply to every node with a header; an unresolved id in a doc without a header is the warning `GRAPH_WARN_LEGACY_MENTION` and becomes `GRAPH_LINK_DANGLING` once the doc has one.

## Phases

| Phase | Content |
| --- | --- |
| 0. The engine | This folder's seed, the schema, the derived graph and the check (merged in PR #46) |
| 1. The MVP as nodes | Vision, features, agents, skills, installation kinds, tracks, gates and data classes of the redefined MVP; its decision questions and answers; the train branches; the v1 build order. Every plan task included or deferred by name, so `query uncovered` starts empty |
| 2. Headers in place; strict mode | Headers on ADRs, briefs, evidence, acceptance files and the card; the ADR index generated; build-plan's M1 to M5 become GP1 to GP5; `graph:check` takes over `plan:check`; the phase-0 warnings become errors; owner decisions of 2026-10-17 to 2026-10-22 backfilled |
| 3. Change the habit | STATUS.md's fact block generated; the CLAUDE.md session-start step (done 2026-10-23: the owner approved it, OD-2026-10-23-7, item 35) |
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
| gate | `GATE-<slug>` | hand-written (`docs/graph/gates/`) | open, passed, waived, dropped | **`label` (`^G[0-9]{1,2}$`)**; `owner_kind` (owner, shopify, provider, ci, claude); `due_week` (`^W[0-9]{1,2}$`); `due_when` |
| data_class | `DC-<slug>` | hand-written (`docs/graph/data/`) | planned, deletion-ready, live, retired | `retention`; `deletion`; `customer` (yes, no) |
| milestone | `M<n> (beta), GP<n> (golden path), V1-PR<nn> (v1 build order), MS-<slug> (a track's stage)` | brief frontmatter, a file when there is no brief (V1-PR<nn>, MS-<slug>), or the plan (GP) (`docs/graph/milestones/`) | proposed, active, done, folded, dropped | `label` (`^M[1-9]$`) |
| package | `P<nn>` | the plan; acceptance-file frontmatter | from its source | `kind` (security) |
| task | `P<nn>.T<nn>, P<nn>.T<nn><letters>` | the plan and `tasks.json`; packet frontmatter | Planned, Ready, In progress, In review, Self-reviewed, Verified, Blocked, Dropped | `kind` (security) |
| acceptance | `P<nn>.A<nn>, <task>-AC<nn>[a-z]` | the plan, packets and `docs/acceptance/` | open, passed, deferred | none |
| adr | `ADR-<nnnn>, ADR-draft-<slug>` | `docs/decisions/adr/` (header bullets; frontmatter from phase 2) | proposed, accepted, superseded, rejected | `date` (date); `readme_status` |
| decision | `OD-<yyyy-mm-dd>-<n>` | hand-written; the verbatim quote is a blockquote (`docs/graph/decisions/`) | recorded | `date` (date); **`by` (owner, claude)**; `channel` (chat, pr, call, email) |
| card | `<env>-card-<n>` | `docs/decisions/approvals/*.json` and their record | approved, expired, revoked | `approved_on` (date); `expires_on` (date) |
| evidence | `<yyyy-mm-dd>-<slug> (the file stem)` | `docs/evidence/live/` (bullets; frontmatter from phase 2) | recorded | `unknown_outcome` (none, open, closed) |
| pr | `PR-<n>` | merged pull requests from git history | open, merged, closed | `commit` (`^[0-9a-f]{7,40}$`); `date` (date) |
| branch | `claude/<slug>` | hand-written: the train's branches; a merged one keeps its node, status merged (`docs/graph/branches/`) | built, open, merged, abandoned | `head` (`^[0-9a-f]{7,40}$`) |
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
| `part_of` | task → package, task; acceptance → task, package; feature → vision; component → component; milestone → track |
| `includes` | feature, track, milestone → task, package |
| `defers` | feature, track → task, package |
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
| `answered_by` | question → decision |
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
| `GRAPH_GATE_FIELDS` | An open gate has owner_kind, and due_week or (when the plan sets no week) due_when | error |
| `GRAPH_DATA_CLASS` | A live data class has a deleted_by link to a merged PR (without history, a PR link is a warning) | error |
| `GRAPH_SKILL_ELIGIBLE` | A skill a task_specialist composes is specialist_eligible and holds no customer data class | error |
| `GRAPH_AGENT_KIND` | delegates_to starts at a builtin agent; a task_specialist delegates nothing and never_holds workspace.task.delegate; bundles starts at an installable agent | error |
| `GRAPH_INSTALLATION_KIND` | triggers need a mandate; routable needs triggers or a mandate; IK-task-specialist is not routable | error |
| `GRAPH_TENANT_RECORD` | No node id or field, and nothing in a hand-written graph file, looks like a tenant record id | error |
| `GRAPH_DECISION_QUOTE` | An owner decision has a date, a channel and a blockquote | error |
| `GRAPH_EVIDENCE_AUTH` | Evidence with a header has authorized_by and an unknown_outcome value | error |
| `GRAPH_ADR_APPROVAL` | An accepted ADR with a header has approved_by | error |
| `GRAPH_NEW_PACKET` | A new packet or acceptance file declares kind: security | warning |
| `GRAPH_SECRET` | No known secret pattern in the hand-written graph or any frontmatter | error |
| `GRAPH_EMAIL` | No email address in a governed doc or any frontmatter (reserved test domains such as .invalid are allowed) | error |
| `GRAPH_STALE_GENERATED` | Generated blocks (graph README schema, ADR index) are fresh | error |
| `GRAPH_STATUS_LINES` | STATUS.md is at most 80 lines | error |
| `GRAPH_IMPORTED_BY_CODE` | Nothing in apps/ or packages/ imports the graph | error |
| `GRAPH_WARN_SUPERSEDED_BASIS` | An accepted ADR whose approving decision was superseded | warning |
| `GRAPH_WARN_STALE_ACTIVE` | An active node with no recent PR or evidence and no open or built branch with a recent commit | warning |
| `GRAPH_WARN_CARD_EXPIRING` | An approval card expires within 14 days | warning |
| `GRAPH_WARN_GATE_OVERDUE` | An open gate past its due week | warning |
| `GRAPH_WARN_PLAN_UNCOVERED` | A plan task that no feature or track includes or defers by name | warning |
| `GRAPH_WARN_LABEL_COLLISION` | Two milestones share a label (M2 to M5: beta and golden path) | warning |
| `GRAPH_WARN_LEGACY_MENTION` | A doc without a header mentions an id that does not resolve (an error once it has one) | warning |
| `GRAPH_WARN_NO_HISTORY` | Git history is shallow or missing, so PR nodes are skipped and PR links are not checked | warning |
| `GRAPH_WARN_BRANCH_MERGED` | A merged PR came from a branch node that is not marked merged | warning |
| `GRAPH_WARN_BRANCH_STALE` | An open or built branch node with no local or remote ref, or no commit on it within 7 days | warning |
<!-- graph:schema:end -->
