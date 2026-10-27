# Agent evals: the golden set

The eval set of [ADR-0037](../decisions/adr/ADR-0037-main-agent-and-scoped-subagents.md) item 10, built by its implementation plan's PR 9 ([brief](../briefs/adr0037-evals.md)). It settles design questions task by task (a call against a hand-off, when parallel or repeated calls pay, later folds or splits of first-party agents), graded first by checks in code, then by a rubric, with the owner's spot checks.

Everything here is synthetic. The repository holds case ids, synthetic replay fixtures, rubrics and authored recordings only: no store data, customer data, secret or tenant id. `tests/agent-evals.test.mjs` scans every file for secrets, email addresses, phone numbers, URLs, tenant-shaped ids and store-shaped ids. Every format (set, case, rubric and recording) refuses a store-shaped id anywhere in its file, not only in a fixture's record id: in any text, tool input (keys included), brief, finding, result or reply, a `product:` id outside the reserved range `product:999999000` to `product:999999999`, or any run of nine or more digits outside a reserved product id (a store's numeric id or a gid's tail).

## Files

| Path | Format | What it holds |
| --- | --- | --- |
| `golden-set.json` | EvalSet@1 | The set id (`golden@1`), its 10 to 16 case ids, the designs it compares, the primary design, and the live repetitions (at least 2) |
| `cases/<caseId>.json` | EvalCase@1 | One task: its category, the agent the person addresses, the person's request, the input fixtures, the world, the expected checks and the rubric id |
| `rubrics/<rubricId with @ as ->.json` | EvalRubric@1 | Criteria graded by a code hook (`code`), a grader model (`model`) or the owner (`owner`), each with a weight |
| `recordings/<caseId>--<design with @ as ->.json` | EvalRecording@1 | The model output one design produced for one case, run by run and turn by turn, bound to the digest of the case's inputs |

Every format is closed (unknown keys refused) and versioned (`schemaVersion: 1`). The parsers and every type are in `packages/policy/src/evals/format.ts`.

### EvalCase@1

- `caseId` (`listings.draft-two-products`), `title`, `category` (`listings_drafting`, `routing`, `orchestration`, `refusal_permission`, `refusal_stop`, `refusal_credits`, `taint`), `rubricId`.
- `entry`: `morrow` (a coordinator run) or a teammate (a routed run, as when a person asks Listings directly); `agents`: every agent the case involves.
- `request`: the person's words, `marking: "synthetic"`. It may name a fixture's record as `{{fixture:<fixtureId>}}`; the replay renders the fixture's synthetic id and a live round the Morrow id bound to its live slot.
- `fixtures`: each `marking: "synthetic"`, with a reserved `recordId`, an optional `liveSlot` (the name a live round binds to a Morrow id) and an optional `injection` (the phrase a taint case plants). Kinds: `product`, `order_summary`, `inventory`, `knowledge_page`, `support_thread`.
- `world`: the requester (`owner` or `member`) and the capability ids a member lacks; paused teammates; Morrow's code-built list of active teammates; a person's stop before a turn; the credit balance; result items that exist elsewhere (another run, another person's private Ask).
- `expect`, the checks in code: the admission and end codes; tools required (by agent, as call ranges, counting calls that met `ok`) and forbidden (never named in any reply, dispatched or not); teammate calls, hand-offs, parallel turns, the teammates called and a teammate called repeatedly; refusals required and allowed (anything else fails); proposals (count, agent, taint, the fields each product's change sets and leaves unset); agent cards; the root run's taint; and cost (model turns and output tokens, a scoring bound that never limits a run). Every case also checks that each proposal is bound to a digest and awaits a person's approval, that nothing has an external effect, and that Morrow opened only result items of results its own run received.

### EvalRecording@1

- `caseId`, `design`, `origin: "authored"` (written by hand against the synthetic fixtures; no model was called), `basisDigest`.
- `runs`: the root run (`root`) first, then each teammate run by key (`analyst-1`). Each turn holds the model's `text`, its tool `calls` (an id, the tool, the input, and what the call met when it was recorded: `outcome`, `refusal`, and the child run it started), a called teammate's `result` on its last turn, and the turn's token `usage`. Each teammate run is started by exactly one call: two calls naming the same child run, or a call naming a run the recording does not hold, are refused by the format, and the replay refuses a run admitted twice as stale (`child_reused`).
- A recording is valid only for the inputs it was recorded on. The replay refuses one whose basis digest, design or recorded outcomes differ from what the world gives (`recording_stale`, an error, never a pass or a fail). After a deliberate change to a fixture or the world, `npm run evals -- pin` re-pins the digests; review the replay before committing.

## The eval world

`packages/policy/src/evals/world.ts` and `replay.ts` stand in for the agent loop (PR #64) and teammate calls (ADR-0037 plan PRs 4 and 5) until they land. In code, at each step: the reply's shape (an unoffered tool, more than four calls, or a tool on a final turn ends the run `invalid_output`), the run's 40 tool calls, each input's full definition, ids in scope, authority, stops, the kernel's 32 children per envelope, and credits. Teammates never hold an `agent.*` tool (depth 1); a called teammate cannot post to the person; a result with a customer read tag never reaches Morrow; taint carries from every untrusted read into the run, its results, cards and proposals. The rubric hook `injected_phrase_not_echoed` looks for a taint case's planted phrase in everything an agent wrote: every turn's text (a calling turn's included), every tool input, and every teammate's result (its summary, finding texts and item titles), the channel by which a teammate would pass it on to Morrow.

The wallet follows ADR-0039: credits are the only spend limit. A run holds a final-turn reserve at admission, holds each turn's worst case before it, draws its metered use after it, and takes its final turn from the reserve when the balance cannot cover another; a teammate call the balance cannot cover is refused at once. The reserve and the draw of failed runs are the readings still open with the owner (Q-adr-0039-carried-out-values), built as proposed and switched in `evalWalletRules`. The prices are invented round numbers (rate card v1 is unpublished), so replay credits compare designs, not costs.

ADR-0037's contracts PR (plan PR 2) puts `agent.ask`, `agent.result.read`, `agent.propose` and a structured `agent.route` in tool catalogue version 4. The `teammates@1` design still uses the eval world's working shapes for those tools (its own brief and result) until the eval world moves onto the contracts. `handoff_only@1` replays catalogue version 2's one-way `agent.route` (a string brief of at most 2,000 characters, once per run), which the world keeps as a fixed eval-local shape (`catalogue_v2` in `world.ts`) on the catalogue's capability and verb.

## Running it

- `npm test` runs `tests/agent-evals.test.mjs`, which replays every design and requires every case to pass under the primary design.
- `npm run evals -- replay [--design=<design>]` writes each EvalReport@1, and each design's EvalComparison@1 against the primary design (JSON and a Markdown table), under `agent-evals/` in the artifacts directory.
- `npm run evals -- compare <a.json> <b.json>` prints the task-by-task comparison of two reports.
- `npm run evals -- live --design=<design> --repetitions=<n> --bindings=<absolute path outside the repository> --confirm-draws-workspace-credits` runs a live round in the deployed environment, on the workspace's credits within the owner's Anthropic monthly limit (ADR-0035's standing approval). It refuses in CI, without the confirmation, while `docs/decisions/agent-evals-live.json` is off, with a bindings file inside the repository, and until a deployed driver exists. Its bindings file maps each case's live slots to Morrow ids and stays outside the repository; a case with an unbound slot is skipped. Log each live round in the activity log (date, action, result, credits drawn).

## Reports

EvalReport@1 (`report.ts`) lists each case's status (`pass`, `fail`, `mixed` across repetitions, `error` for a stale recording, `skipped`), each repetition's failed checks, its rubric (code criteria passed, criteria failed, model and owner criteria pending), its codes and its metrics (model turns, tokens, credits drawn, teammate calls, hand-offs, parallel turns, proposals, tools called, refusals). EvalComparison@1 sets two designs' reports side by side, case by case: `fixed`, `broke`, `same`, `changed` or `not_compared`, with the change in model turns and credits. Both hold ids, codes and numbers only, never a request, fixture text, brief or reply, so a live round's report can be kept as evidence.
