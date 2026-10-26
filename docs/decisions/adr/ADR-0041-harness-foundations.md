# ADR-0041 Harness foundations: Morrow's own agent harness on Opus 5.5, with full context management, long-horizon jobs, layered memory and depth-1 orchestration

- Status: Proposed 2026-10-26. A draft for the owner; nothing in it is approved (see Approval).
- Date: 2026-10-26
- Supersedes: no accepted record. It takes the place of three working papers outside the repository, where they conflict with it:
  - the harness guide of 2026-10-25 (`harness-guide.md`): §4.1 gap 1 (the graceful final turn), §4.2 B, E, F and G (the last-turn notice, posting paused while Morrow works, Morrow's turn limit, the "7 of 30 minutes" signal), §4.6 (the 64k budgets, "Compaction: not at launch", a fresh run per message with a 6k window), §4.7 tier 3 (per-person memory later) and §5 rows 7, 20, 21, 30, 31 and 33;
  - the owner's choices page of 2026-10-26 ("A graceful final turn", "Raise Morrow's turn limit to 16"), set aside by the owner's later message the same day;
  - the four area designs of 2026-10-26 (memory, orchestration, context, long-horizon execution), which this record merges into one design with one data model.
- Amends:
  - **ADR-0022** item 9 (the fixed 30-minute run lease becomes renewable inside an absolute job envelope; new lease sources, item 7); item 10 (provider streaming that ends in the broker; on-demand compaction and context editing behind a switch; request assembly in the broker; the outcomes for `max_tokens`, a broken stream and `spend_limit`; items 8 and 11).
  - **ADR-0027** item 1 (lease sources; 2 questions and 72 hours unanswered; the stale-run sweep), item 3 (the 8 KiB result bound becomes an inline bound plus a per-turn budget; a `harness` tool family), item 4 (`tool_choice: none` on a final turn; an invalid `tool_use` ending the run; an uncertain turn resent once then ending), item 5 (which role carries which text, item 13), item 6 (16 turns, 6 for Morrow; 4 tool calls a turn and 40 a run; 30 minutes of wall time; the 64,000-token input cap; "a turn starts only if the reservation and time cover a final turn"), item 7 (content also lives in the context tables of item 4), item 8 (Morrow's fixed set gains the harness and memory tools of item 24; upkeep runs of Morrow's notebook, item 27), item 12 (the offer, `max_tokens` by effort, no `xhigh` or `max` "at launch", the worst-case turn) and owner question 3 (caching only the fixed prefix for 5 minutes).
  - **ADR-0036** item 1 (the offer becomes Opus 5.5 only, at `medium` and `high`; Haiku 5.5, Sonnet 5.5 and `low` leave every catalogue, Listings' included) and item 6 (catalogue version 2's values, item 38).
  - **ADR-0037** item 2 ("each call a fresh run": a follow-up may reopen the same teammate's context, item 21), item 3 (a call is asynchronous and no longer bounded by the teammate's 30-minute wall time; at the kernel's 32 children Morrow's job checks in and a person's Continue issues a successor envelope, item 7), item 3(a) (the lease re-issue generalised into item 7's table) and Consequences' open items (compaction, caching the conversation, per-person memory, the notebook read-back path, a graceful final turn: all decided here).
  - **ADR-0039** items 2(c) to 2(f) (the final-turn reserve and `credits_exhausted` give way to parking, pending owner question 6 because the owner confirmed the reserve in OD-2026-10-26-1), item 2(g)'s list of endings (the limit endings it names no longer exist), item 5 (stop conditions become safety check-ins, item 18) and item 9 (codes, item 34).
  - **ADR-0031** item 1 (new run-content classes on a per-window clock; thinking deleted when it stops being sent), item 6 (an audience beside read tags on every derived row, item 25) and item 7 (Anthropic's compaction recorded in `data-regions.json`).
  - **ADR-0016** item 3 (the Ask-bound envelope allows the named harness writes of item 33, each bound to the Ask owner's audience).
  - **ADR-0011** Q1 and **ADR-0024** item 7 (a proposal's conflict set gains every principal whose words or notes reached the drafting run, item 32).
  - **ADR-0007** item 2 (a dedicated least-privilege broker database role for request assembly, item 8).
  - **ADR-0038** item 1, conditionally (a location-hinted runtime SQL object, only if staging misses the step-latency budget, item 35).
- Does not change: the authority kernel (`decideDelegation`, `decideAutomation`, 32 children per envelope, depth 1); ADR-0005 (stops are `human_only`, need no second approver, and agents only propose them); digest-bound approvals and the one gateway that applies, reads back and audits; unknown outcomes reconciled before any retry and never promoted; credentials readable only by the broker; FORCE RLS and server-derived tenancy; default deny; ADR-0039's rule that credits are the only spend limit, the Owner's settings, OD-2026-10-26-2's free failed endings and three-failure breaker; ADR-0031 items 2 and 6 (customer data only after P09.T05; Morrow never sees customer-tagged items); ADR-0023's product scope; ADR-0035's single environment; ADR-0027 and ADR-0029's rule that no agent SDK runs in the product.
- Implements: the owner's four messages of 2026-10-26, quoted under Approval and recorded as OD-2026-10-26-3 to OD-2026-10-26-6. Its owner questions, with ADR-0040's, are Q-adr-0040-0041-owner-questions.
- Companion: ADR-0040 (messaging with agents), revised the same day to stand on this record.
- Relies on: P07.T03 (conversations and messages), P05.T04b (no agent runs in an Ask before it), P09.T05 (the customer deletion path), P11.T05 (the workspace stop), PR #64 (the agent loop) and PR #79 (the teammate contracts), both unmerged; and a separate authority record for in-workspace collaboration grants (harness guide row 14: no installation can yet hold `workspace.question.request`), which this record does not decide.
- Terms:
  - **Context:** one agent's append-only log of what it was sent and what it answered. One run writes to it at a time.
  - **Epoch:** one window over a context. A new epoch starts when the context is compacted or rebuilt.
  - **Run:** one leased execution attached to one context. A context can see several runs over time.
  - **Job** (a "request" on screen): the work one person's message, one Start, one trigger or one standing request begins. In code, `job_id`.
  - **Main thread:** Morrow's continuing context in one person's Morrow conversation (ADR-0040).
  - **Fork:** a background job's own context, started from the main thread's prefix.
  - **Envelope:** the delegation envelope a job runs under; this record gives it an absolute expiry.
  - **Park:** a durable wait that safety, credits or the provider caused. **Check-in:** a park that asks a person.
  - **Upkeep run:** a run that tidies memory (summaries, consolidation) and posts nothing.
  - **Influence principal:** a person whose words or notes reached a run.

## In plain words

The owner asked for a foundation that works like the best multi-agent systems, with no launch shortcuts. This record says how Morrow's agents think, remember, keep going and work together.

- **One harness, one model.** Morrow keeps its own agent loop on Anthropic's plain Messages API. Every agent runs Claude Opus 5.5: Morrow at high effort, every teammate at medium. No Haiku, no Sonnet, no low effort.
- **Work is never cut short by a limit.** Jobs no longer stop after 16 turns, 30 minutes or 64,000 tokens of reading. When a safety check fires, the job pauses, saves where it is and asks a person. Running out of credits pauses the job until credits are added (owner question 6).
- **Agents never run out of room.** When an agent's working memory fills up, the system summarises older parts and keeps going. Exact facts that matter (your words, approvals, changes made, ids) are rewritten by code from the records, never from the model's summary, so a summary can't lose or invent them.
- **Morrow remembers your conversation.** Your Morrow conversation is one continuing memory for Morrow. Each background job branches off it, so Morrow starts every job knowing what you've talked about.
- **Memory in layers.** Each job keeps a plan. Each agent keeps a notebook of lessons. The shop keeps knowledge pages that people approve. Each person can keep private memories that only they can see and edit, saved only when they tap Save.
- **Real teamwork.** Morrow can ask many teammates at once, keep working while they run, send them guidance mid-job, ask the same one a follow-up that remembers everything it read, and fan the same work out over hundreds of products.
- **Checked before done.** Big deliverables (suggested store changes, figures you'll act on, files) are checked by a separate reviewer before Morrow presents them.
- **Safety stays where it was.** Every tool call is still checked in code, every store change still needs your approval of the exact change, and credits still bound spend.

## Context

**The owner's direction.** On 2026-10-26 the owner kept Morrow's own harness, asked about the Claude Agent SDK, accepted the lead's recommendation (keep the harness on the plain Messages API; no Agent SDK or Claude Managed Agents in the product), asked for messaging-style conversations (ADR-0040), asked why Haiku appears anywhere, and then set the rule this record carries out: no MVP shortcuts in the agent foundation, the methods of the best multi-agent systems for context, and no finishing a job near a limit with an answer. ADR-0023 already says "the architecture stays production-grade"; the owner's message makes that the rule for the harness.

**What the research found** (five reports of 2026-10-26; the reference `docs/references/harness-foundations.md` gives each source):
- The leading systems do not end healthy work at a small turn count. They keep state outside the context window, renew the window by compaction or a reset with a hand-off, detect loops by behaviour, and keep hard ceilings only as runaway backstops (Anthropic's long-running harness posts, Managed Agents, Codex, OpenHands, Magentic-One, Claude Code).
- The durable log is the truth and the prompt is a view of it (Managed Agents' session log, Google ADK's "compiled view"). Context is reduced in order of reversibility: offload, clear, then summarise.
- On Opus 5.5, preserved thinking makes an append-only history mandatory: a client-side edit to earlier turns invalidates the model's reasoning, and accounts created on or after 2026-08-31 get a 400 for it. Anthropic's server-side compaction and context editing do not count as edits, and the docs say to use on-demand compaction wherever it is available. Both are beta.
- A separate, skeptical reviewer beats self-grading. Fresh-context reviewers find real errors. Generators grade themselves too leniently.
- Memory poisoning is an established attack class. The defences that hold are architectural: memory is untrusted data, writes are typed and committed by code or a person, taint follows lineage, and deletion follows provenance.
- Opus 5.5 bills its whole 1M window at one rate, so the reason to keep a working window small is attention quality, not price.

**What the designs and reviews found.** Four area designs (memory, orchestration, context, long-horizon) each removed the rejected shortcuts, but they defined four plan stores, four event logs, duplicate wait and checkpoint tables and conflicting values. Three reviews of 2026-10-26 (security, state of the art, feasibility) found 34, 24 and 34 problems. This record merges the designs into one data model, takes every sound high and medium finding, and lists what it adapts or rejects, with reasons (Challenges taken, adapted and rejected).

**What is cheap to change now.** PR #64's agent-runs migration is applied nowhere (it is numbered 0053 on its branch and must be renumbered again at merge); every loop and teammate contract is in the unfrozen v1.1 set (`candidate_owner_signoff`); loop catalogue version 2 is proposed; tool catalogue versions 3 and 4 are unpublished; no AgentRunWorkflow instance has ever run. Migrations up to 0052 on `main` change only by forward migrations; 0052's notebook tables need a forward migration before any entry exists.

This record is material under CLAUDE.md and ADR-0002 (authority, security, money, provider features, public contracts, retention, deployment boundaries), so it comes before any code that depends on it.

## Decision

### A. Ground rules

1. **Morrow's own harness on the Messages API.** The agent loop stays Morrow's `AgentRunWorkflow` on Cloudflare Workflows, with Neon as the durable log and the broker as the only holder of the Anthropic key. The broker calls `POST /v1/messages` through its hand-written adapter. No Claude Agent SDK, no Claude Managed Agents and no third-party agent framework runs in the product: authority, tenancy, approvals, credits and retention stay Morrow's, in code.

2. **Opus 5.5 for every agent.**
   - Morrow runs Opus 5.5 at `high`. Every other agent (installed agents, Listings, agents Morrow creates, called and handed-off teammates, mandate runs) runs Opus 5.5 at `medium`.
   - Every model call a context makes uses that context's model and effort: compaction, checkpoints and summaries included. A review run takes the effort of the work it checks (`high` for Morrow's deliverables, item 19). Upkeep runs take the effort of the agent whose memory they tend.
   - The offer in every catalogue (the loop catalogue and Listings' per-product catalogue) is Opus 5.5 at `medium` and `high`. Haiku 5.5 and Sonnet 5.5 are removed, as the owner decided (OD-2026-10-26-5: no cheaper models for paid users). `low` is removed too: the lead's reading of the same message, put to the owner as owner question 1. `xhigh` and `max` come by a new catalogue version once streaming (item 8) and their evals pass. Whether the Owner may still raise a teammate's effort is also owner question 1; nobody can pick a lower effort or another model.
   - Effort, model, tools and system text never change inside a context: a change applies from the next context, so the cache and preserved thinking stay valid. Morrow's first reply is a `high` turn like any other (ADR-0040 item 4).

3. **Safety never ends work early.**
   - **A run ends in only four ways:** (a) it finishes: a reply in a conversation, or `run.complete` through the gate of item 16 in a job; (b) a person stops it, or declines to continue it at a check-in; (c) its authority ends: a lease check fails, a grant is revoked, a stop or switch, the mandate ends, the task closes, or the envelope expires with no Continue; (d) an unrecoverable error on Morrow's or the provider's side, which is free (OD-2026-10-26-2).
   - **Everything else parks.** A tripped detector, a backstop, an empty wallet, a provider outage or a needed answer moves the run into a durable wait. Code writes the plan state and a status the person can see. There is no final turn, no `tool_choice: none`, and no "wrap up now" notice.
   - **The model is never shown a countdown:** no remaining tokens, credits, turns or time, and no balance. It may be shown elapsed time. Spend is shown to people only, by code (ADR-0040 item 5).
   - The preamble tells every agent that its context is managed, that its plan and notes survive renewal, and that it must never stop early because of how much it has read.

### B. Runtime

4. **One data model.** One set of tables replaces the four designs' parallel ones. All are FORCE RLS with composite tenant keys and restricted roles; content tables carry read tags, an audience (item 25) and taint. Workflow parameters, step results, events, Queue messages, entrypoint calls and logs carry ids, codes and digests only (ADR-0027 item 7, ADR-0022 item 13).

   | Table | Holds |
   | --- | --- |
   | `agent_runs` (PR #64, extended) | kind (`coordinator`, `routed`, `mandate`, `call`, `review`, `upkeep`), purpose for Morrow (`conversation`, `job`); lineage (`job_id`, `root_run_id`, `parent_run_id`, `parent_tool_use_id`, `call_id`, depth 0 or 1, `forked_from_run_id` and `forked_at_seq`, `continues_run_id`); `context_id`, `conversation_id`, `source_inbox_id`; `segment`, `incarnation`, `workflow_instance_id`, `heartbeat_at`; `envelope_id`, `envelope_expires_at`, `active_ms`; `wait_id`; `RunTaint` and read tags; `person_memory_loaded`; credits held and drawn; pinned versions (harness, runner, renderer, tool catalogue, loop catalogue, context policy, rate card, safety profile); counters as `bigint`; a closed `ended_reason` |
   | `agent_contexts` | scope (`conversation`, `job`, `call`, `upkeep`); one attached run at a time (partial unique index); requester, agent and audience; pinned tools, system digest, model, effort and renderer; current epoch; last sequence; read tags and taint, which never shrink |
   | `context_epochs` | kind (`initial`, `clear`, `compaction`, `reset`, `view_rebase`, `model_rebase`, `renderer_rebase`); the opening as a manifest of references and digests, never a copy (item 14); cut and tail positions; prefix digest; section token counts; the epoch's own clock |
   | `context_checkpoints` | the model-written hand-off (a provider compaction block and its readable summary, or a `ContextCheckpoint@1`), its validation result, read tags, audience, taint |
   | `run_turns` | keyed `(org, ws, context_id, seq)`, with `run_id`, `turn` (1 to 100,000) and `attempt` as columns and `UNIQUE (run_id, turn, attempt)`; `epoch`, `purpose` (`turn`, `compaction`, `checkpoint`, `review`, `summary`), `notices`; `final` dropped |
   | `run_tool_calls`, `agent_model_calls` | ids, codes, digests; a stable label per tool result (`c17`); model-call purpose, epoch, cache TTL, section tokens; one open model call per run and purpose |
   | `run_waits` | one open wait per run (partial unique index): `question`, `checkin`, `detector`, `credits`, `agent_credit_limit`, `children`, `approval`, `timer`, `provider`, `slot`, `idle_followup`; the wake condition, the wait sequence, the resolution and its lease source |
   | `run_plans`, `run_plan_revisions` | one plan per job (item 16), append-only revisions |
   | `run_events` | one content-free event stream per root run, numbered by `seq` (item 36) |
   | `jobs` | one row per job: conversation, requester, origin, state, opening and result message ids (ADR-0040 item 5) |
   | `agent_calls` | the call registry; ADR-0040's step rows are a view over it |
   | `teammate_results`, `result_items`, `result_item_pages` | results per call and follow-up sequence; items written by `result.write`, with `open`, sections, audience and source subjects |
   | `run_detector_state`, `run_segments`, `run_taint_sources`, `run_memory_reads`, `upkeep_triggers` | content-free state for detectors, segments, taint sources past the inline cap, memory influence, and upkeep admission |
   | memory tables (items 26 to 29) | notebooks re-keyed by agent principal, `notebook_changesets`, knowledge pins and descriptions, `person_memories` and versions and suggestions, `conversation_summaries`, `memory_derivations`, `memory_repairs`, `memory_settings` |
   | `context_policy_versions` | ContextPolicy rows (item 12) |

   ADR-0040 adds the conversation tables (`conversation_inbox`, `conversation_reads`, `message_feedback`, `notification_preferences`, `push_subscriptions`, `live_outbox`, `standing_requests`).

5. **Contexts, runs and jobs.**
   - **A context has one writer.** A partial unique index allows one attached open run per context. A job has at most one active Morrow run and one active context per (job, agent).
   - **Scopes.**
     - `conversation`: Morrow's main thread in one person's Morrow conversation (their Ask, ADR-0040 item 11). Private to that person, never shared, compacted like any context.
     - `job`: a background job's fork, an @Morrow request in a project, a hand-off's task thread, a mandate run's episode.
     - `call`: one teammate call; a follow-up may reopen it (item 21).
     - `upkeep`: one memory upkeep run.
   - **The main thread and its forks.** A person's message in their Morrow conversation is handled by a conversation run attached to the main thread. If a run is already attached, the message is delivered at its next turn boundary. The conversation run answers from knowledge, records and memory, asks one choice question, or starts a background job with `run.plan` (item 16). Starting a job forks the main thread: the fork's context begins with the main thread's exact prefix, up to and including the `run.plan` call, so its first request is a cache read; the main thread's copy of that call's result says the job is now running, the fork's copy tells it to carry out the plan. Teammate calls happen in forks and project jobs, never in the main thread (code refuses `agent.*` there with `fork_first`). This keeps the main thread free for the person's next message, gives every parallel job its own writer, and starts each job from everything Morrow already knows.
   - **What the main thread learns.** When a fork finishes, the result is a message in the conversation, and the main thread's next turn carries a code-rendered state block with that job's ids, state and counts. Morrow reads the result itself with `memory.read` when it needs it, which joins that result's taint and read tags to the main thread only then.
   - **Shared threads use compiled views.** Each @Morrow request in a project, each hand-off thread and each mandate episode opens a fresh `job` context from a code-compiled view (item 26). A compiled view also rebuilds a context after a person's access narrows (item 14).
   - **Continuing a job.** A reply to a job after its run ended attaches a new run to the same job context (ADR-0040 item 8). A successor started by Continue after a check-in or a close attaches to the same context; it opens a new context from the last checkpoint only if the old one has passed its retention clock.

6. **Durable execution on Workflows.**
   - **Segments.** A run moves to a new Workflow instance after 1,000 steps in a segment, at every epoch boundary, and before any wait expected to last more than 5 minutes. One SQL transaction records the next segment and its instance id, and the same step creates the instance ("already exists" counts as success). A parked instance therefore holds few steps and replays quickly, even after a deploy.
   - **Ids.** Instance ids are `<runId>-s<segment>-i<incarnation>`, from server uuids, matching Cloudflare's 100-character pattern, never reused; every creator (the api starter, the sweep, segment rolls, wakes) uses this rule. Wake event types are `w-<waitSeq>`, read from SQL, so a stale event never satisfies a later wait.
   - **Steps.** `start` or `wake`; `turn-<n>-<a>`; `tool-<n>-<k>` (dispatches included); `compact-<e>-<a>`; `review-<v>`; `wait-<w>` then `waitForEvent('w-<waitSeq>')` then `resume-<w>`; `roll-<s>`; `finish`. Retries: 5, exponential from 10 s. A turn step's timeout is its call budget plus 2 minutes, at most 30 minutes; other steps 10 minutes. A turn's parallel tool steps run as `Promise.all`, at most 6 in flight, results returned in call order. No `Promise.race` outside one step.
   - **Limits.** The orchestrator sets `limits.cpu_ms` to 300,000 and its subrequest limit to at least 100,000. There is no heartbeat wake: `waitForEvent` may wait up to 365 days, and the one-minute sweep re-sends lost wakes.
   - **Fencing.** Exactly one instance drives a run: every step's lease entry refuses a superseded incarnation (`superseded`, no write). Each step's SQL is one ids-only definer call, sent in one round trip (item 35).
   - **Deploys.** The manifest pins the harness, runner and renderer versions and the tool catalogue. The orchestrator and broker keep every version an open run pins; new step logic applies from the next segment, new rendering only from a new epoch. CI re-renders recorded runs and fails on any byte change.
   - **Fan-out.** `agent.map` creates its batch instances with `createBatch` in the dispatch step and treats a 429 on create as retryable; the sweep re-creates committed children with no instance. Children started together are staggered: the first starts, and the rest start once its first token arrives, so they read a warm cache.

7. **Leases and the job envelope** (amends ADR-0022 item 9, ADR-0027 item 1, ADR-0037 item 3(a)).
   - **A lease still grants nothing.** It selects the tenant and fences generations; the kernel reruns at every tool call.
   - **Renewal.** At each step entry, if less than 20 minutes remain, `agent_run_lease_renew` (ids-only, executable only by `morrow_runtime_executor`) extends the 30-minute lease after re-running admission's checks: the requester's membership and live grants over the envelope (or the mandate), Morrow's fixed set for Morrow, rules, stops, switches, the release unrevoked, the run open. If any fails, the run ends with that reason.
   - **An absolute envelope.** Every job's envelope expires after 24 hours of active time or 7 days, whichever comes first. Only the requester's own act in their session renews it: an answer, a follow-up, or Continue (for a mandate episode, the installation owner's or the Owner's Continue, or the next trigger's new episode). When it expires, the run checks in (item 18). Renewal is refused after expiry.
   - **Waits hold no lease.** A timer, a teammate finishing, a wallet top-up, an approval or gateway outcome, a provider back-off or a free working slot only marks a wait as resolvable in SQL. The run resumes only when `agent_run_resume` (ids-only, `morrow_runtime_executor` only) re-runs admission's checks and re-issues the lease, within the envelope.
   - **Every lease source**, each with its `lab:agent-runs` case:

     | Source | Where it runs | Re-checks | New? |
     | --- | --- | --- | --- |
     | Admission by a person's act (post, answer, Start, Continue) | the person's session transaction | admission's checks; renews the envelope | existing (ADR-0022 item 9); Continue new |
     | `admit_mandate_run` from one trigger row | runtime definer | the mandate and admission's checks | existing (ADR-0024 item 6) |
     | Child, fork and review admission inside a leased run's step | runtime definer, under the parent's envelope | `decideDelegation`, the credit hold, stops | existing for calls (ADR-0037); forks and reviews new |
     | Per-step renewal (`agent_run_lease_renew`) | runtime definer | admission's checks; refused after envelope expiry | new |
     | Wait resolution (`agent_run_resume`) | runtime definer | admission's checks; refused after envelope expiry | new; generalises ADR-0037's re-issue |
     | Upkeep admission (`admit_upkeep_run`) from one `upkeep_triggers` row written in a person's act or in a write made under a lease that a person's act admitted | runtime definer | the upkeep requester's live view and the upkeep tool set | new |
     | Standing-request firing (`admit_standing_request_run`) from one trigger row | runtime definer | the signer's live grants and the standing request (ADR-0040 item 12) | new |
     | The sweep | runtime definer | wakes a running run only while its lease is unexpired; otherwise closes it (`lease_lapsed`), keeping its context, and Continue is the person's act; never issues a lease | changed |

   - **Accepted residual** (owner question 2). It widens ADR-0022 item 9's residual, as ADR-0024 item 6 and ADR-0037 item 3(a) did: a compromised orchestrator could keep an already admitted job acting, and resume its resolvable waits, within the requester's live grants until its envelope expires. It still cannot start a job, widen a grant, outlive a stop, a revocation or a switch, or pass the envelope's expiry.

8. **Model calls: streaming in the broker, assembly from SQL** (amends ADR-0022 item 10 and ADR-0027 items 4 and 12).
   - **Streaming.** The broker streams the provider's response. The stream ends in the broker and never reaches a browser; messages appear whole (ADR-0040 item 1). `max_tokens` comes from the catalogue entry: 32,000 at `medium`, 64,000 at `high`; the CHECK ranges allow up to 128,000 and `budget_ms` up to 1,800,000. The call budget comes from the output rate staging measures; if `high`'s 64,000 tokens do not fit 28 minutes at the measured rate, a new catalogue version lowers it.
   - **Outcomes.** A reply cut at `max_tokens` is recorded and booked, never sent back as history (prefill returns 400 on 5.5 models); the turn is resent with an `output_cut` notice asking the model to split the work across turns or result items; three cuts trip a detector. A stream that breaks after `message_start` is uncertain: booked at its worst case and resent once in the step with a new hold; a second uncertain attempt parks with back-off (item 17). An invalid or unoffered `tool_use` gets an error result and the model corrects it; only a protocol break (an unparseable reply, a different model id) ends the run, free. `spend_limit` parks the job until a person continues, and the owner is told.
   - **Assembly in the broker.** `ModelCall@2` (edited while v1.1 is unfrozen) carries ids and digests only: run id, lease generation, context id, epoch, through-sequence, expected prefix digest and purpose. The broker builds the request from SQL with the context's pinned renderer, as a stream from SQL pages rather than one string, so a large context never sits in a Worker isolate's memory at once. This removes the 33-message bound and means a compromised orchestrator cannot hand the broker a made-up conversation.
   - **The broker's database role** (amends ADR-0007 item 2). A dedicated least-privilege role: read-only on the content tables, FORCE RLS, no `BYPASSRLS`. The tenant comes only from `enter_lease` on the run id and lease generation the call names; a stale lease is refused. Provider keys live in a module the renderer cannot import, enforced by `verify:boundaries`. The production custody record (ADR-0007 item 9) carries this over or decides it again.
   - **Counting.** Input is estimated from the previous response's usage plus the appended blocks; the free `count_tokens` call is made only within about 10% of a threshold. A hard guard refuses a send whose input plus `max_tokens` passes half the model's window (500,000 for Opus 5.5); the refusal is not terminal and forces compaction.

9. **Credits in the harness** (ADR-0039, with owner questions 6 to 8).
   - **Every model send holds and draws under the wallet's row lock**, whatever the run's end. "Free" for a failed ending (OD-2026-10-26-2) is a refund recorded at settlement, never a skipped hold. Compaction, checkpoints, reviews, summaries, consolidation and resends are ordinary paid steps (owner question 7).
   - **Holds follow the cache** (owner question 8). A turn holds the prefix that the previous call read within its cache lifetime at the cache-read rate, new tokens at the write rate, and `max_tokens` at the output rate. If the cache misses anyway, the difference is drawn when the wallet covers it and is otherwise recorded as Morrow's own cost; it never ends the run (`cost_budget` stays only for a booking above any possible worst case).
   - **Out of credits** (owner question 6). When a step's hold cannot be covered, the whole job parks (`credits`): every run in it stops at its next step boundary, nothing is drawn while parked, and code posts "Paused: out of credits" with Add credits and Stop. A wallet change that covers the next hold resumes jobs oldest first, through `agent_run_resume`. A job parked for 7 days closes and keeps its context, so Continue can pick it up. This replaces the final-turn reserve and `credits_exhausted` (ADR-0039 items 2(d) and 2(e)), which the owner confirmed on 2026-10-26 before setting the no-shortcuts rule, so it waits for the owner's answer. The optional per-agent credit limit (OD-2026-10-26-1) parks only that agent's run (`agent_credit_limit`), and Morrow is told.
   - **Who pays.** The member credit ceiling (ADR-0036 item 2) sums holds and draws over every run whose root requester is that member, children, reviews and upkeep attributed to them included.
   - **Fair use of the shared provider limit** (owner question 5). Code enforces a per-workspace share of model calls in flight (12 to start, tuned from 429 rates): an admitted run waits for a send slot, which never ends work. A platform breaker parks new admissions when Morrow's own metered provider spend this month reaches 80% of the owner's Anthropic monthly limit (a configured copy of the value the owner sets in Anthropic's console), with a fair share per workspace; running jobs continue. The three-failure breaker also counts Morrow's runs and orchestration roots.

### C. Context management

10. **Layout and caching** (amends ADR-0027 owner question 3, pending owner question 9).
    - **Sections, in order.**
      - S1, tools: the pinned list, tenant-free.
      - S2, system: the harness preamble, the run-kind section, first-party role text and pinned skills; tenant-free; breakpoint BP1 at its end. CI renders it for two synthetic tenants and requires identical bytes.
      - S3, a second system block right after BP1: first a per-workspace salt (random, kept in the tenant row, not a credential), so tenant prefixes can never match across workspaces in the shared provider cache; then the approved instructions of an agent Morrow created, only when its card was not tainted. A tainted card's instructions go in a wrapped data block in the opening, and its runs start tainted. System blocks never change inside a context, so the salt survives compaction.
      - S4, the first epoch's opening (a user message rendered by code): opening facts, indexes, then the request or brief last; breakpoint BP2. A later epoch begins with the compaction block (provider strategy) or a new opening holding the checkpoint (fallback), as item 11 sets out.
      - S5, the conversation, append-only. Each tool result opens with a code label (`[c17 · products.read]`). BP3 on the last block of every request; BP4 where the previous request's BP3 was.
    - **One TTL policy per context kind, for the context's life.** One hour on all four breakpoints for the main thread, job contexts and anything that waits on a person; for call contexts, one hour on BP1 and five minutes after it. One-hour entries always come before five-minute ones.
    - **Never inside a context:** a change of tools, system text, model, effort, thinking setting, `tool_choice` (always `auto`) or output format; timestamps in the prefix; non-deterministic serialization (RFC 8785 key order).
    - **The cache hit rate is a tracked target.** Cache read and write shares are recorded per context and per job in content-free events, with alarms. When an alarm fires, the broker sends the GA cache-diagnostics object to find the cause; evals send it too. T17 checks a target hit rate on staging.

11. **The reduction ladder, and the provider strategy** (amends ADR-0022 item 10, pending owner question 10).
    1. **Offload at write.** A tool result above the inline bound (24,000 tokens) is stored as a result item and shown as a head-and-tail preview (about 1,000 tokens) with its id. Results in one user turn share a per-turn budget of 0.15W (W is item 12's working window): results past it become pointers with previews, in call order. Read tools page with `PageInfo`. Nothing is cut silently.
    2. **Clear.** Server-side `clear_tool_uses` (context editing) clears old results that can be fetched again: from 0.50W, clearing at least 0.10W, keeping the last 4 tool uses. Never cleared: harness tool results, `inbox.ask` answers, proposal, task and post creation results, recall results, and errors or refusals among the kept turns. Every refusal and error code also stays in the ledger.
    3. **Compact.** At 0.80W of estimated input, before the next send, on-demand compaction (`compact-2026-09-04`) summarises everything before a kept tail (at most 0.125W, never splitting a tool call from its result; it may be empty when the last turn alone exceeds the budget). Morrow's own instructions (within the API's 16,384 characters) apply item 13's rules. Compaction runs only at a turn boundary with no model or tool call open. The next request is the compaction block, then the kept tail unchanged, then the next user turn: its tool results, followed by one code-rendered block with refreshed opening facts, the ledger and the plan. The kept turns directly follow the summarised range, so their thinking stays valid. If latency measurements need it, compaction may start in the background from 0.70W while work continues (the request then drops exactly the messages it summarised); it is off by default.
    4. **Rebase by code.** If compaction fails twice, or for a view, model or renderer change, code builds a new epoch from SQL alone: the ledger, the plan, pointers to older turns, and the last valid checkpoint.
    - **The fallback strategy, always available.** `client_epochs`: a checkpoint fork (one turn on the cached conversation that calls the strict `context.checkpoint` tool), then a reset whose opening code renders from SQL (item 13), with no earlier thinking carried over. A kill switch moves every context to it, and it runs alone until the provider strategy passes its evals.
    - **Adoption of the provider strategy** needs: the compaction evals passed (item 37); Anthropic's retention terms for compaction blocks recorded in `data-regions.json` before any store data can appear in a summary (Morrow has no zero-retention agreement, so the standard terms apply); and the switch turned on by one reviewed commit. Compaction and context editing are never sent on the same request (the API refuses it). No task budgets are sent: a model-visible countdown invites early stops.
    - **Convergence.** Every section of a new epoch has a budget with a pointer fallback, and the tail can shrink to nothing, so a new epoch always reaches its target; a property test proves it with the per-turn bounds of item 12. No end reason relates to context: `input_over_cap` becomes a non-terminal refusal that forces compaction.

12. **ContextPolicy@1: values from evidence.** One policy row per model and effort, versioned, with its eval record. Version 1 is proposed with these seeds; the context-fill sweep (item 37) sets the real values, run separately on Opus 5.5 at `high` and at `medium`.

    | Value | Seed |
    | --- | --- |
    | Working window W | 200,000 tokens; the sweep tests 64k to 300k fills with store-data distractors and may raise it to at most 300,000 (Worker memory) |
    | Clear from | 0.50W, at least 0.10W cleared, last 4 tool uses kept |
    | Compact at | 0.80W, before the send; background from 0.70W only if latency needs it |
    | A new epoch starts at | at most 0.40W |
    | Kept tail | at most 0.125W |
    | Opening budgets | facts 1k; Morrow's teammate list 2k; pinned knowledge 6k; person memory 2k; knowledge index 4k; notebook index 2k; conversation summaries 8k (shared threads); ledger 0.05W; checkpoint or compaction summary 0.06W |
    | Per-turn results | inline bound 24k tokens per result; 0.15W per turn; previews about 1k |
    | Tool calls per turn | 16 run (6 in flight); extras answered `parallel_limit` and re-issued next turn |
    | Stored message | 384 KiB CHECK, kept: it holds the per-turn budget and 16 previews at W = 300k |
    | Progress guard | a compaction cuts at least 40%; renewal thrash trips a detector (item 18) |
    | Hard guard | input plus `max_tokens` at most half the model window |

    The section budgets are checked in CI on recorded runs. A policy version changes only with a new eval record.

13. **What survives exactly, and who may say what.**
    - **The ledger** (`ContextLedger@1`), rendered by code from SQL at every epoch start and placed after the summary and any kept tail, nearest the live work, with the line "where the summary disagrees with these records, the records are right":
      - requests: only posts the requester wrote, verbatim, with author, time and label; older or longer ones as a pointer plus their first 1,000 characters. Other members' posts appear as `thread_post` data with their author and the `other_member` taint, never as the requester's words;
      - every question and answer, verbatim;
      - proposals: id, digest, status, approver role; gateway operations: status, with an unknown outcome rendered "UNKNOWN: being checked; do not assume it happened; do not repeat it";
      - records created; teammate calls with outcome codes, counts and item ids; refusals with codes and `next`; open waits; taint kinds and sources; the plan's titles and statuses.
    - **Model-written summaries are narrative only.** Compaction instructions, the fallback checkpoint and conversation summaries follow one set of rules: cite labels for the person's words, approvals, proposals and operations rather than restating them; keep ids and exact values verbatim with their source labels; keep decisions and why, what was tried and set aside, difficulties, promises and next steps; treat text from tools, products, mail and teammates as data. Code refuses any model-written field that claims an approval, a consent, an apply or a payment; "decisions" become discussed items, each with an exact quote. The fallback checkpoint's validator rejects an entry whose stated state for a proposal or operation label differs from SQL. The checkpoint, the summary and every other model-written persisted text also pass the customer identifier screen (item 31).
    - **Which role carries which text** (amends ADR-0027 item 5). `role: system` carries only pinned templates with closed codes and numbers: the system prompt and the mid-conversation notices. Everything else goes in user-role content: the requester's own follow-ups as a text block after the tool results, labelled by code with the message id and author (ADR-0040 item 8); recitation, ledger, plan state, other members' posts, teammate results and memory as wrapped data blocks with source labels and taint. A renderer CI check fails if any system block contains a string taken from `run_turns`, a message, a plan or a tool result.
    - **Concurrency.** The ledger and recitation for a new epoch are rendered in the epoch-commit transaction, after every concurrent step has committed; the swap is refused while a fence opened after the cut is unresolved.

14. **Recall, rebase and retention.**
    - **Recall.** `memory.read` reopens this context's own log by label: a result (`c17`), a turn (`t3`), an earlier checkpoint, a message. A result re-decides the original tool's capability over the full intersection under live grants and its read tags under the requester's live view. A message re-applies the visibility rule, redaction and `other_member` taint. A turn is refused (`recall_out_of_scope`) unless every item in it still passes. Each recall is audited content-free; the rate of recalls after a compaction feeds the evals.
    - **View rebase.** At every turn boundary code re-checks the context's sources (manifests and `memory_derivations`): a deleted, redacted or hidden message, knowledge page or memory, or a narrowed grant, forces a `view_rebase` epoch built from SQL facts the requester may still see. It is the same run under the same lease; no continuation run is admitted.
    - **Pins.** When a run attaches to an existing context, code re-checks the context's tool catalogue and renderer against the versions currently allowed; a failure forces a rebase in which tools may only shrink, and a revoked catalogue version refuses the attach.
    - **Retention** (amends ADR-0031 item 1, pending owner question 11). Each epoch's content (turns, opening references, checkpoint) is kept 90 days from that epoch's close. A context rolls to a new epoch at least every 30 days. Thinking is deleted at the epoch commit that stops sending it, and at context close. Redaction handlers delete matching rows in `run_turns`, `context_epochs`, `context_checkpoints` and derived memory at once, not by clock. Content-free records (`run_events`, `run_waits`, `agent_calls`, segments, detector state, `run_memory_reads`) are kept 365 days.

15. **Notices and recitation.**
    - **Notices** are closed codes with numbers, sent as mid-conversation `role: system` messages (GA on Opus 5.5): `checkpoint_request`, `output_cut`, `parallel_limit`, `continue_or_complete`, `repeat_detected`, `error_streak`, `replan`, `resumed`, `verification_failed`, `fork_started`. Because turn-scoped notices (`clear_at`) are beta, notices stay short.
    - **Recitation** happens only after a compaction, after a resume, or when code sees a material change (a child finished, a plan item changed state, a person wrote). It is a user-role wrapped data block, sent as a diff marked "replaces all earlier state blocks", about 1,000 tokens of titles and statuses; the full state is read with `run.plan`. There is no recitation every round and no "post an update" nudge.

### D. Long-horizon jobs

16. **The plan, and completion.**
    - **One plan record** (`RunPlan@1` in `run_plans` with append-only revisions): an objective; done criteria, each with a check kind (`record_exists`, `proposal_state`, `readback_matches`, `artifact_schema`, `child_outcome`, `person_confirmed`, `judgment`); phases and items, each with a status (`open`, `in_progress`, `needs_review`, `done`, `blocked`, `dropped`, `awaiting_person`), its criteria, evidence references and `depends_on`; typed notes (`decision`, `dead_end`, `finding`, `assumption`, `handoff`); and follow-through items (item 17). Items are never deleted; dropping one needs a reason. No field names a tool, capability, scope, store, model, recipient or limit.
    - **For Morrow's jobs**, the plan also holds the person-facing `understood` sentence and up to 6 steps; code renders them as the job's first message and the card's steps (ADR-0040 item 4). ADR-0040's draft tool `job.plan` becomes this field of `run.plan`.
    - **When a plan is needed.** Every background job sets one in its first turn. A quick answer in a conversation needs none. Code advances items from events (a dispatched call sets its item `in_progress`; a returned result sets `needs_review`); the model sets `done`, `blocked` and `dropped`.
    - **Done criteria are frozen** when the plan is first set (the sprint-contract pattern). Changing one needs the requester's message or a logged reason, and the reviewer sees the change.
    - **What a text-only reply means.** In a conversation (the main thread, or a project request that has not become a job), a reply with no tool call means "reply and wait for the person": the run ends, with no reviewer. In a job, completion happens only through `run.complete`; a text-only turn while children are open is an implicit wait for any child, and otherwise an idle turn (item 18).
    - **The gate.** `run.complete` (outcome `done`, `partial`, `blocked`, `cannot_do`, or `waiting` with follow-through items; evidence per criterion; the reply to post) succeeds only when: every plan item is terminal or a follow-through item with a typed condition; no child call and no question is open; no unknown outcome is unreconciled (with one, only `partial`, naming it); every typed check passes against SQL; and the review of item 19 has passed where it applies. A failure returns `verification_failed` naming the criterion, and the job continues.

17. **Waits and follow-through.**
    - **One wait tool,** `run.wait`, covers children (any or all, optionally by call id), proposals (decided, then the gateway's apply and read-back), and a time (`until`, at most the envelope's expiry). It holds no lease and no credits.
    - **Approval and gateway waits** carry the operation's status from SQL. Only `applied` with a matching read-back satisfies a dependent item; `submitted`, `uncertain` and `verifying` keep the wait open, the ledger shows them as UNKNOWN, and items that `depends_on` them stay blocked (ADR-0040's `checking` state).
    - **Promises become waits.** "I'll tell you when the price change is live" is a follow-through item with a typed condition. `run.complete` with outcome `waiting` posts the reply and opens the wait; when it resolves, the job continues within its envelope and completes later.
    - **Asking a person.** One open question at a time (the limit of 2 goes). Waits on a person last 7 days with Inbox reminders at 24 and 72 hours; then the run closes `person_wait_expired` and keeps its context. A repeated identical question trips the repetition detector.
    - **Who may answer:** the requester for a person's job; the installation owner or the Owner for a mandate episode. An agent never answers for a person.
    - **The requester's new message** reaches a running job only as ADR-0040 item 8 delivers it: the run's requester, in the run's own conversation, after the delivery checks. It resets the stall counters and may end an idle or detector wait. Other members' posts never end a wait; they enter a later run only as `other_member` data.
    - **Provider trouble.** 429 and 529 are resent in the step. An uncertain attempt is resent once with a new hold; a second parks with back-off at 1, 5, 15, 30 and 60 minutes, then hourly, each resend a new held attempt; after 24 hours parked the job checks in. Definite 4xx errors end the run, free.

18. **Detectors and check-ins: safety, never endings** (amends ADR-0027 item 6 and ADR-0039 item 5, pending owner questions 3 and 4).
    - **Detectors** run in code after every turn and tool step, on content-free SQL signals (a ring of the last 32 call signatures in `run_detector_state`), so a replay reaches the same verdict:

      | Signal | Nudge | Trip |
      | --- | --- | --- |
      | Repetition: the same tool, input digest and result digest since the last progress event (a repeated `agent.ask` with the same brief counts) | 3rd | 4th |
      | Error streak: the same refusal or error code in a row | 3 | 5 |
      | Alternation (A-B-A-B) | over 6 steps | over 8 |
      | Idle turns in a job: text with no tool call, plan change or completion | each | 3 in a row |
      | Stall: no progress and no new result digest; progress lowers the count | replan notice at 12 | after 2 replans without progress |
      | Cost without progress: credits since the last progress event above 4 times this run's median per progress interval, or 25 expected turns | – | above the line |
      | Renewal thrash: a compaction keeps over 70% twice, or 3 compactions in 20 turns | – | either |
      | Output cut at `max_tokens` | – | 3 |

    - **Check-ins** (backstops, catalogue values): 1,000 model turns, 10,000 tool calls, 24 hours of active time, or 7 days since the requester's last act (the envelope, item 7); the kernel's 32 children (item 21); and a cost check-in when a job's drawn credits pass 5 times the p95 for its kind of job, or, until staging has measured that, the credits worth US$25 of model use.
    - **A trip or check-in** commits, in the step's transaction: a `checkin` or `detector` wait with its code, the plan state, and a code-built post naming the reason, the current plan item and the credits used so far, with Continue, Continue with guidance and Stop. Continue (the requester, in session) issues a successor envelope and grants another allotment. A teammate's run never asks a person: it ends `blocked` or `partial` with its findings, and Morrow decides.

19. **Verification before presenting.**
    - **Code checks first,** on every result: `created` comes from `run_tool_calls`, never from model text; counts are recomputed; evidence references must resolve to records or items the run produced or was given, otherwise the criterion becomes `unverified`; every proposal is digest-bound and pending a person; nothing reads as applied until the gateway applies and reads back.
    - **Then one kind of reviewer:** a review run, admitted by code at depth 1 under the root's envelope (or under a mandate episode's own mandate), with a fresh context, the reviewed installation's tools intersected with `view` verbs, a pinned skeptical reviewer text, the frozen criteria and the deliverables fetched under the run's read tags. It never sees the producer's reasoning. It runs at the effort of the work it checks: `high` for Morrow's deliverables, `medium` for a teammate's. It returns `ReviewVerdict@1` (per criterion: pass, fail or unknown, with evidence). A verdict can only block; it never approves, never clears taint, and never overrides a failed code check.
    - **When it runs:** by deliverable type, on by default (owner question 18): a store-change proposal set, a figure the person will act on, an artifact or file, an agent card, and anything built on tainted input. Not on ordinary conversation replies. Morrow may also ask for one with `agent.ask {mode: review}`.
    - **Repeated fails** trip the stall detector and reach a person, who may choose Accept as is (`accepted_by_person`).
    - **The reviewer is calibrated** against an owner-labelled set; its catch rate and false-block rate are tracked per release, and evals decide, per deliverable type, whether it stays on.
    - **The outside oracle stays the gateway:** for store effects, the read-back after a person's approval is the final check.

20. **Successors and proactive episodes.**
    - A run ended by a stop, a revocation, a kill switch or an authority failure never seeds a successor automatically; only a person's Continue in session may.
    - Every successor inherits the predecessor's taint and read tags (through the shared context) and its unreconciled operations, shown as UNKNOWN with `retry_blocked` on their subjects. A successor is not admitted while the predecessor's fences are open.
    - A mandate run is one episode per trigger (ADR-0024). Long-lived goals live in routines, triggers, the agent's notebook and the last episode's context, not in a run held open for weeks. An expired or revoked mandate ends the episode at its next step (`mandate_ended`); a later trigger under a new mandate does not continue it automatically.

### E. Orchestration (depth 1)

21. **Calls, waits, follow-ups and guidance.**
    - **Asynchronous calls.** `agent.ask` admits the child in one transaction (authority, the child run and call row keyed by the parent run and `tool_use` id, the delegation hop, the child's first hold) and returns at once with `{callId, state, code}`. Morrow keeps working, calls `run.wait`, or ends its turn, which is an implicit wait for any child.
    - **Results.** A finished child's TeammateResult reaches Morrow as wrapped data with source `teammate_result`: code renders a compact form (outcome, criteria statuses, counts, `next`, item ids, the summary) within the per-turn result budget, then "N more results ready"; the full result opens with `memory.read`.
    - **Follow-ups.** `agent.ask {followUpOf: callId}` reopens the same child's context: the new brief is appended, the child keeps everything it read and its cache, and it is compacted like any context. The reopen is admitted by the parent's definer, re-running the full intersection and taking a fresh hold. A child between follow-ups is `idle`, holding no lease and no credits; idle children close as `released` when the job ends. A plain `agent.ask` starts a fresh child for independent work. A fresh child opened from a checkpoint is used only after a view rebase removed what the old context held.
    - **Guidance.** `agent.message {callId, text}` delivers Morrow's guidance to a running child at its next turn boundary, as wrapped data labelled "from Morrow, your lead" with Morrow's taint; never a system message, never consent. When the requester redirects a job (ADR-0040 item 8), Morrow forwards the relevant change to running children with `agent.message`, or cancels the calls the change makes pointless.
    - **Cancel.** `agent.cancel {callId}` cancels Morrow's own running child or releases an idle one. Only steps that never began may be answered as not run; a step that began returns its recorded result or `tool_outcome_unknown`, and `retry_blocked` applies to its subjects. It is not a kill switch.
    - **Children never talk to the person**; Morrow relays.
    - **The kernel bound stays per envelope** (owner question 19): 32 children. At 32 the job checks in; the requester's Continue issues a successor envelope under their live grants with `delegate`, inside a new absolute expiry. There is no queue of admissions beyond it. ADR-0040's waiting line for a person's sixth request (ADR-0040 item 9) is admitted, with its first hold, in the person's post transaction or in the fork step of a run that post admitted, and started by `agent_run_resume` after re-running admission's checks.
    - **Briefs** (`TeammateBrief`): objective, details, done criteria (at least one), boundaries, records, `outputFormat`, `approach` (guidance only), and `request`, filled by code, never the model: the requester's own words with their read tags, as wrapped data. A brief names no tool, capability, scope, store, model or limit.
    - **Effort scaling** is a prompt rule based on the task, never on money: answer directly when possible; one teammate for one domain; two to four in parallel for comparisons; `agent.map` for the same work over many records; delegate only for context protection, parallel fresh contexts or specialised grants.

22. **Fan-out, shared artifacts and aggregation.**
    - `agent.map {installationId, briefTemplate, source, batchSize 1..50}` splits record ids or an item table's rows into batches, each one child admitted and checked on its own with its own credits. When all finish, a SQL definer merges the structured parts into one result item (counts summed, created records unioned with their call ids, findings concatenated with `from`, tables unioned, failed and partial batches listed); Morrow receives one aggregated result.
    - **Result items are the shared artifact plane.** Teammates write them incrementally with `result.write` across turns; `run.complete` cites them, so a large result is never cut. Pages are at most 256 KiB, so any read fits one step. Sharing between siblings goes through Morrow passing item ids in a later brief, under ADR-0037's check; there is no sibling channel. A later job in the same thread may open items attached to posts its requester can see, after the server checks the attachment, every read tag and the audience.
    - **Conflicts.** Two typed metric findings with the same key and different values are flagged `conflict`; Morrow reconciles them with a follow-up or a review.

23. **Failed, partial and blocked work.**
    - `partial` and `blocked` are allowed with every end reason. A run that ends without `run.complete` becomes `partial` when it created records or items, otherwise `no_result`; code builds the result from SQL and keeps every finding.
    - Every TeammateResult carries a code-computed `next` (`none`, `follow_up`, `rebrief`, `reroute`, `retry_later`, `ask_person`, `do_not_retry`), `needs` (a decision, information, a grant or credits, with an optional question) and `unresolved` (subjects with unknown outcomes). Code refuses a retry dispatch over unresolved subjects with `retry_blocked` until the reconciler settles them.
    - An identical re-dispatch after a failure counts toward the repetition detector.

24. **Tool catalogue version 4** (PR #79, unpublished). The harness adds one consolidated set beside the domain tools; each is in the `harness` family, grants nothing, writes only its run's own rows (with the run's audience, read tags and taint), and is checked by the lease and its closed input:
    - `run.plan` (set, update, read; the plan and, for Morrow, `understood` and steps);
    - `run.complete` (jobs and teammate calls; `result.submit` becomes its child form);
    - `run.wait` (children, proposals, time);
    - `result.write` (teammates);
    - `context.checkpoint` (accepted only inside a fallback checkpoint fork).

    Morrow's orchestration tools: `agent.ask {mode: ask | review, followUpOf}`, `agent.map`, `agent.message`, `agent.cancel` (one cancel tool; `agent.stop` and `agent.release` are not added), `agent.route`, `agent.propose`.

    Memory tools: `memory.search` and `memory.read` (one pair: `memory.read` also opens result items, teammate results, message ranges and this context's labels, replacing `agent.result.read`, `context.recall` and `conversation.read`; `knowledge.search` stays as an alias for one version); `memory.suggest` (Morrow and handed-off runs); `notebook.write {op: add | replace | retire}`; `knowledge.propose` (Morrow, if owner question 15 is approved).

    Tool-selection accuracy is measured, and an eval arm without `run.plan` checks that the plan earns its place.

### F. Memory

25. **Principles.** Memory is data, never authority: nothing a memory says adds a tool, capability, scope, recipient, approval or limit; it never goes in `system`; it reaches the model wrapped, naming its source and trust class (approved knowledge, person-confirmed, work record, agent lesson, model summary), with control tags escaped. Values that matter (prices to apply, recipients) come from the system of record at execution time. **Every derived row** (notebook entries, summaries, result items, plan revisions, checkpoints, ledger items) **carries an audience** (the workspace, a subject, or one principal) **and its source subjects.** A read passes only if the read tags allow it, the reader has live view of every source subject, and the audience matches. Content from a private Ask (audience: its owner) is readable only by runs whose output audience is that same owner, so `memory.search` and `memory.read` never return private-Ask content to project, mandate or other people's runs. Taint is sticky and follows lineage.

26. **Run memory and conversation memory.**
    - **Run memory** is the plan and its notes (item 16) plus the ledger. There is no separate notes table. The model posts no progress notes; ADR-0040 item 6 allows only milestone findings.
    - **Your own Morrow conversation** is remembered by its main thread (item 5): one compacted context, private to you, with checkpoints as its memory of older parts.
    - **Shared threads** (projects, task threads) use a compiled view at each request: pinned knowledge and person memory in full within their budgets; indexes for knowledge and the agent's notebook; verified summaries of older parts; the code-rendered ledger; a verbatim tail (at most 0.125W, at least the last 12 messages, a person's message always whole, a long agent post as its start plus a pointer); unresolved conflicts and missing inputs; the current message last. Opening it is one definer round trip; on replay the recorded manifest is reused, never recompiled.
    - **Summaries for shared threads** (`ConversationSummary@1`): written once per segment over the messages every current viewer can see, by an upkeep run at the reading agent's effort, in the background (never on the critical path; a gap marker with `memory.read` covers a range not yet summarised). Messages outside that common set are shown per viewer, verbatim or as gap markers; a per-viewer summary is built only when that viewer's run needs the range. Code validates every summary: cited messages exist in the range and the viewer set; every quote is an exact substring; no model field claims an approval, consent, apply or payment; no record id appears that SQL does not hold. Each cited message's author is stored, and at compile time code applies `other_member` taint for every cited author who is not the reading run's requester. The upkeep run's requester is the person whose post triggered it; summaries are erased with any covered message. Upkeep spend per workspace per day is a catalogue value.

27. **Notebooks** (teammates', and Morrow's if owner question 15 is approved).
    - A forward migration, guarded on empty notebook tables, re-keys notebooks by agent principal and adds title, kind (`lesson`, `correction`, `procedure`, `shop_fact`, `open_question`), taint and sources, `derived_from`, audience, source subjects, the requester it was written for, renewal and use counts.
    - **Writes** only by runs of the owning agent, through `notebook.write`; never in a private Ask, never by a run that read customer data or loaded person memory; credential and identifier patterns refused; control tags escaped.
    - **Read-back** (owner question 16) only by runs of the owning agent, under item 25's audience rule; the agent page shows "learned while working for <name>". A tainted entry taints its reader; reads by tainted runs do not raise use counts.
    - **Consolidation** is an upkeep run (owning agent's effort, notebook tools only) admitted from an `upkeep_triggers` row written in the transaction of the write that crossed the threshold (25 new entries, 200 live, or 7 days with a new entry). It produces a versioned changeset applied in one step, shown on the agent page as a diff with one-step rollback; the input entries are never edited in place. Every entry it writes takes the union of taint, read tags, audience and `derived_from` over every entry the pass read. A tainted pass cannot retire an untainted entry; it can only flag it. For Morrow's notebook this amends ADR-0027 item 8: an upkeep run of the Coordinator principal posts nothing and holds only its own notebook's tools; it is not Morrow checking in. Its requester is the person whose run's write crossed the threshold, checked live.
    - **Clock:** 90 days after the last write or re-affirmation; consolidation re-affirms entries used in the last 30 days.

28. **Shop knowledge.** As migration 0052, extended: a person may pin a page ("Always know this", `human_only`), and pinned pages load in full within their budget, the rest as an index of titles and a one-line versioned description. Agents propose changes with `knowledge.propose`; a person accepts the exact digest. "Share with the team" on a person memory or a notebook lesson creates such a proposal. A page whose current version came from a tainted proposal taints its readers. Pages are flagged stale, never expired.

29. **Per-person memory**, in scope now (owner questions 13 and 14).
    - **Only the person writes it:** typed in Settings, or by tapping Save on a suggestion Morrow or a handed-off teammate made with `memory.suggest`. A suggestion is a message part whose audience is the requester, digested, expiring after 30 days; the person's confirmation of the exact text is the gate. Never written silently, never by an agent alone, never from a run that read customer data; contact details, customer, card and government identifiers and credentials are refused; agents never suggest special categories.
    - **Only that person's runs read it**, and only where each entry's scope allows: "only in my private chats" by default, or "everywhere I ask", which is the person's choice to let replies others can see reflect that entry. Proactive runs never load it; a called teammate gets only the ids Morrow passes, checked against the requester and the scope. No Owner, Admin or other member has a read path.
    - **A run that loaded person memory** cannot write a notebook or propose knowledge; "Used N memories" renders only for that person.
    - **Kept until the person deletes it**; "Still true?" after 180 days unused; erased within 24 hours of membership ending, at workspace erasure and at `shop/redact` for entries tagged with that store; deleting a memory erases every version's text at once.

30. **Retrieval** (owner question 20).
    - **Now:** hybrid lexical search in Neon (a `simple` tsvector and trigram text on each content row, fused by reciprocal rank with small trust, recency and use priors), filtered by layer, audience and read tags before ranking, plus agentic search: `memory.search` takes up to five queries in one call, and Opus 5.5 reads the top snippets and chooses what to open. Erasing content erases its index in the same UPDATE.
    - **Embeddings are decided by measurement, not deferred.** The paraphrase-recall eval is built now from the owner's store data. An embedding-provider record is drafted in parallel: vectors in a `pgvector` column on the same FORCE RLS rows, computed in the broker, erased in the same UPDATE, exact nearest-neighbour search per workspace until about 100,000 vectors, never Cloudflare Vectorize, a dedicated rerank stage with it. If the eval misses 0.95 recall at 5, that record goes to the owner before the memory switch goes on.

### G. Safety and data

31. **The customer identifier screen** (until P09.T05). One code screen covers email addresses, phone numbers, street-address patterns, Shopify customer GIDs and the keyed email-digest list that `customers/redact` already uses. It runs in ADR-0040's post command (refused as `not_started: customer_data`, "Morrow can't keep customer details yet. Remove them and send again.") and before commit on every persisted text a model writes: summaries, checkpoints, compaction summaries (a flagged block is refused and the fallback reset runs on code facts), plans and their notes, `understood`, ledger titles, result items, findings and messages. Order numbers and order GIDs are not customer data under CLAUDE.md and pass. The PR that lifts the screen registers messages, summaries, checkpoints and contexts as `content: customer`, with `customers/redact` matching. A `lab:shopify-privacy` case shows an email typed into a post never reaches `run_turns`, a summary or a checkpoint.

32. **Influence conflicts on approvals** (amends ADR-0011 Q1 and ADR-0024 item 7, pending owner question 17). A proposal's conflict set, checked when it is decided and again at dispatch, gains every principal whose words or memory reached the drafting run: the authors of its `other_member` sources, the requester of each notebook entry it read (from `run_memory_reads`), and the authors cited by summaries or checkpoints it loaded. The review card names them. When every other eligible approver is conflicted in a team, the Owner may approve with the solo-owner confirmation phrase and cool-down, unless the Owner is an influence principal. The solo-owner rule is otherwise unchanged. `lab:approval-records` cases: B's post, or a notebook lesson written for B, shapes A's discount proposal, and B's approval is refused.

33. **The Ask-bound envelope** (amends ADR-0016 item 3). In a private Ask (the Morrow conversation), these harness writes are allowed, each touching only the run's own state with audience = the Ask's owner: `run.plan`, `run.complete`, `run.wait`, `agent.message` and `agent.cancel` on the run's own calls, `result.write` by teammates it calls, `memory.suggest` (a suggestion only that person sees), `context.checkpoint`, and the fork of item 5. Calls stay read-only. Refused in an Ask: `notebook.write`, `knowledge.propose`, `agent.propose`, `agent.route`. `ask_admin_read` omits memory suggestions, checkpoints, compaction summaries, plans' notes and epochs; `AskPrivacyNotice` and Settings say exactly what an admin read covers. `lab:agent-authority-workers` and `lab:visibility` rows.

34. **Data classes, taint and codes.**
    - **New run-content classes** (ADR-0031 item 1): plans and revisions, checkpoints and compaction summaries, epoch openings (references only), review verdicts, teammate results and result items, conversation summaries; on item 14's per-epoch clock; deletion handlers in the PR that first writes each class (G9). Person memory, notebooks and suggestions on item 27's and 29's clocks.
    - **Taint never truncates.** `RunTaint` keeps every taint kind; up to 256 sources inline and the rest in `run_taint_sources` with a count; contracts carry the kinds, the count and the first sources. `ModelUntrustedSource` gains `notebook_entry`, `conversation_summary`, `person_memory`, `context_checkpoint`, `thread_post`, `teammate_result` and `result_item`, beside ADR-0040's `other_member`.
    - **Codes.** End reasons drop `turn_limit`, `tool_call_limit`, `wall_time`, `deadline` and, pending owner question 6, `credits_exhausted` (kept in the enums for old records); they add `person_wait_expired`, `checkin_unanswered`, `envelope_expired`, `lease_lapsed`, `internal_error` and `released`. `cost_budget` stays only for a booking above any possible worst case. Refusals add `parallel_limit`, `fork_first`, `retry_blocked`, `recall_out_of_scope`, `call_not_found`, `call_not_idle`, `milestone_too_soon` and `checkpoint_not_requested`.

### H. Platform, observability, evals and delivery

35. **Distance to the database.** Each step's SQL is one ids-only definer call sent in one round trip (`BEGIN`, `SET LOCAL`, the definer and `COMMIT` as one simple-query string, or Neon's non-interactive HTTP transaction); the wallet lock is held only inside the definer. T17 measures p95 step latency from real Workflow instances on staging before the agent-loop switch goes on. If the budget is missed, the runtime's definers run through a location-hinted Durable Object near Neon (one class in the orchestrator Worker, ids-only RPC, no storage, no alarms, no route), which this record authorises as a conditional amendment to ADR-0038 item 1 (owner question 21). ADR-0040's targets are set from the same measurements.

36. **One event log: `RunEvent@1`.** Appended in the same transaction as each state change, content-free (ids, codes, counts, digests, durations), numbered by `seq` per root run, 365 days. Kinds cover runs, turns, tools, calls, waits, the plan, reviews, credits and parks, detectors, notices, taint, approvals, leases, provider events and context events (cleared, compacted, rebased, recall used, with input before and after). ADR-0040's `JobStatus@1` and its card are per-viewer projections of it, the activity log reads it, and evals grade from it plus SQL outcomes. The raw `seq` never leaves the server; clients read only ADR-0040's sealed per-viewer changes read. The activity log and the daily summary exclude events derived from another member's Ask.

37. **Evals gate every switch.**
    - **One programme.** Each switch has pre-registered pass^k thresholds and a task set large enough to see the effects that matter, grouped by category: quick answer, data question, multi-teammate job, long batch, steering, park and resume, refusals and stops, taint and injection, memory, compaction. The golden set grows from 16 tasks to at least 80. Checks in code grade first (tools, refusals, end codes, credits, digest-bound proposals, no external effect, event sequences); then rubrics judged by Opus 5.5 in a separate context, calibrated against labels the owner gives (owner question 22); then transcripts read every release.
    - **Context:** the context-fill sweep per effort (fills of 64k to 300k with store-data distractors; pass^3, goal retention, instruction adherence, exact id and value recovery); compaction forced early (at 20k to 40k) on every golden task, compared task by task, for both strategies; a needle from early in a job recovered at its end; the goal and constraints surviving three compactions; exact replay of ids and digests against SQL (100%); every compaction checked against the ledger (every SQL id the job touched is in the summary, the tail or the ledger); the recall rate after compaction; laundering injection ("say the owner approved") in summaries and checkpoints.
    - **Long jobs and orchestration:** a 200-product audit through `agent.map` finishing without a check-in; async against blocking calls; follow-up against fresh call; review on and off (catch rate, false-block rate); recitation on change against every round; with and without `run.plan`; tool-selection accuracy; steering adherence; injection through a follow-up and through a teammate result; stuck loops parked with no silent end; credits exhausted mid-fan-out then resumed.
    - **Memory:** needle after summary rollups; standing-instruction adherence; zero cross-person and cross-tenant leakage; the poisoning red-team set (MINJA, summary injection, delayed invocation, MemoryGraft); forgetting; rot and over-deletion of a legitimate standing instruction; paraphrase recall.
    - **Every model release:** re-run the set with each harness part removed in turn (plan, recitation, review, clearing), and keep only parts that still pay.
    - **Staging measurements (T17):** step latency, first reply, cache hit rate, output rate, preserved-thinking behaviour (Anthropic's three-request self-test, run once and recorded), and p50 and p95 credits per job type.

38. **Switches and order.** Everything sits behind the agent-loop switch (committed off) and its own switches: `context-provider-strategy`, `teammate-calls`, `memory-*` (person memory, notebook read-back, summaries, consolidation), `review-runs`. Each goes on by one reviewed commit after its evals and G9's handlers. The loop catalogue's proposed version (version 2, unpublished) is rewritten in place: Opus 5.5 only, `AgentRunSafety@1` values in place of AgentRunCaps, and a ContextPolicy reference; it publishes only with the owner's confirmation. Listings' per-product catalogue version 4 (on `claude/adr0039-credits-catalogue`, not yet merged) becomes Opus 5.5 at `medium` and `high` before it merges. The order of PRs is in `docs/plan/harness-foundations-implementation.md`.

## Values

All values are catalogue or policy data, changed only by a new version with its evidence, and CHECK constraints in SQL hold only safety ranges (for example tool calls per turn 1 to 64, turns 1 to 100,000, person waits 1 to 365 days).

| Setting | Value |
| --- | --- |
| Models | Opus 5.5 only: Morrow `high`, others `medium` |
| `max_tokens` | 32,000 at `medium`, 64,000 at `high` |
| Working window | seed 200,000 tokens, set by the sweep, at most 300,000 |
| Clear / compact / new epoch | 0.50W / 0.80W / at most 0.40W |
| Inline result / per-turn results | 24k tokens / 0.15W |
| Tool calls per turn | 16 (6 in flight) |
| Cache TTL | 1 hour for conversations, jobs and waits on a person; calls 1 hour on the system block, 5 minutes after |
| Run lease / envelope | 30 minutes, renewed per step / 24 hours active or 7 days |
| Segment roll | 1,000 steps, every epoch, before waits over 5 minutes |
| Person waits | 7 days, reminders at 24 and 72 hours |
| Check-ins | 1,000 turns, 10,000 tool calls, 24 hours active, 7 days, 32 children, cost at 5 times the p95 (US$25 of model use before p95 exists) |
| Provider back-off | 1, 5, 15, 30, 60 minutes, then hourly; check-in after 24 hours |
| Children per envelope | 32 (kernel) |
| Model calls in flight per workspace | 12 |
| Platform breaker | 80% of the provider's monthly limit |
| Working requests per person | 5, with a waiting line (ADR-0040 item 9) |

## Security invariants touched

None is weakened. Two accepted residuals widen, with the owner's approval asked: leases renew within an absolute envelope (item 7), and, only if staging needs it, the runtime's SQL runs through a location-hinted object (item 35).
- **Tenant isolation:** every new table is FORCE RLS with composite tenant keys; contexts, calls, waits, epochs and labels are server-generated and resolved only inside their run or context; the broker's assembly role takes the tenant from `enter_lease` on the lease the call names; S2 holds no tenant data and a per-workspace salt follows BP1 (`lab:tenant-conformance`, a CI render test).
- **The intersection, in code at every tool call:** unchanged kernel; harness tools grant nothing and touch only the run's own rows; forks, follow-ups, map batches and review runs are each admitted alone under the envelope; review runs only narrow to `view` verbs; tools never grow inside a context (`lab:agent-authority-workers`, `tool-catalogue.test.mjs`).
- **Digest-bound approvals:** the ledger renders approvals from SQL; no model-written field may claim one; the conflict set gains influence principals; review verdicts confer nothing (`lab:approval-records`, `approval-records.test.mjs`).
- **Permission and budget checks outside prompts:** holds, parks, detectors, check-ins, the envelope, the send share and the breaker are in SQL and code; the model never sees a budget (`lab:run-credits`, `loop-catalogue.test.mjs`).
- **Unknown outcomes:** fences are reconciled in `wake` before any resend; broken streams are uncertain and booked at worst case; only never-begun steps may be answered as not run; unknowns survive compaction verbatim in the ledger and force `partial` (`lab:agent-runs`).
- **Credentials only in the broker:** unchanged; the renderer cannot import the key module (`verify:boundaries`).
- **Default deny:** every switch committed off; an unknown policy, renderer or catalogue version refuses admission or attach; the provider strategy is refused until its switch is on (`edge:check`).
- **Kill switches `human_only`:** a stop ends running and parked runs at their next step and cascades to children; it is never blocked by credits or a wait; Continue and Accept as is are not kill-switch actions (`stops.test.mjs`).
- **No agent-initiated external effect before P11:** unchanged; compaction, memory and review have none.
- **The owner's store only; fakes in CI:** labs use fake models; live evals run under ADR-0035's standing approval.
- **Customer data:** item 31's screen; Morrow's contexts, checkpoints and memory exclude customer-tagged items; Support's derived content is `content: customer` on its sources' clocks when Support's record allows it (`lab:shopify-privacy`, `lab:retention`).
- **Immutable migrations:** PR #64's migration is edited only while unapplied; 0052's notebook change is a forward migration guarded on empty tables (`migration-history.test.mjs`).

## Consequences

- **Code.** PR #64 becomes the foundation's main stack (schema, runner, broker, context engine); PR #79 takes the merged contract edits and tool catalogue version 4; ADR-0039's catalogue branch goes Opus-only; ADR-0037 PRs 4, 5 and 9 and build order PRs 12 and 15 change as `docs/plan/harness-foundations-implementation.md` sets out. The plan docs (`mvp.md`, `v1-build-order.md`, `adr-0037-implementation.md`, `adr-0039-implementation.md`) and CLAUDE.md's wording ("MVP" names the launch scope, not the harness) follow once the owner approves.
- **Cost, before staging measures it** (Opus 5.5: US$4 in, US$20 out, cache reads US$0.20, 1-hour writes US$8 per million tokens). A quick answer in a warm conversation costs about US$0.05 to 0.20; a typical background request with two teammates and one review about US$4; a 200-product audit through `agent.map` about US$34; one compaction US$0.5 to 1.0. Spend splits roughly into output 52%, cache writes 38% and reads 10%. These replace ADR-0027's per-run figures as the T17 and T12 baseline. The levers, in order: `max_tokens` per purpose, fewer cache rewrites, a smaller opening, review only where it pays.
- **Speed.** Morrow's first reply runs at `high`, so it is slower than ADR-0040's draft promised; responsiveness comes from code ("Seen by Morrow" within seconds, a live status line) and the target is set from staging measurements.
- **Taint will be common.** Project jobs often carry `other_member` taint, and many jobs carry teammates' `untrusted_external` taint. Cards and proposals say so honestly. The main thread stays clean until Morrow reads a tainted result.
- **Risks.**
  - The provider strategy depends on beta features. Mitigation: the fallback strategy is built first, runs alone until the provider strategy passes its evals, and a kill switch returns to it.
  - The residual of item 7 widens. Mitigation: the envelope's absolute expiry and checks at every renewal.
  - Long jobs and fan-outs spend more per request. Mitigation: credits, check-ins, the cost check-in, Stop, and the evals that decide whether each harness part pays.

## Alternatives considered

- **The Claude Agent SDK or Claude Managed Agents inside the product.** Authority, tenancy, approvals, credits and retention would leave Morrow's code, or the key would leave the broker. The owner kept the harness.
- **Client-side epochs only, no beta features.** Each clearing or compaction epoch would strip Opus 5.5's reasoning from every carried turn; Anthropic says to use on-demand compaction where available. Kept as the fallback.
- **A fresh run per message with a 6,000-token window.** Throws away the agent's own reasoning, tool results and cache at every message.
- **One persistent context per thread for every person, and one orchestration per thread.** A single writer cannot serve parallel requests; per-person contexts of shared threads hold one person's view of other people's words. Forks and compiled views do both jobs.
- **A low-effort first reply,** in the same context or a separate short context. The owner ruled out cheaper models (OD-2026-10-26-5), which this record reads as ruling out lower effort too (owner question 1); effort changes break the cache.
- **Sliding leases with no absolute bound.** Nothing would bound how long a compromised orchestrator keeps an admitted job acting.
- **32 children open at once with a queue of admissions.** A change to the authority kernel; the per-envelope bound with a person's Continue gives the same reach with a person in the loop.
- **Model-written progress posts, or a nudge to post.** Chatter that can contradict the records; milestone findings under code rules carry the substance.
- **Embeddings now, or never.** Decided by the paraphrase-recall eval instead.
- **A cheaper summariser model.** Breaks the cache and the owner's rule; every summary runs on its context's own model.

## Challenges taken, adapted and rejected

Three reviews of 2026-10-26 (security, state of the art, feasibility; AI reviews, separate context, same model family) found 92 problems. Every high and medium problem is taken, as mapped below, except these adaptations and one rejection.

**Adapted:**
- **Security, customer data in posts (high):** taken, except order numbers and order GIDs, which pass the screen: they are not customer data under CLAUDE.md, and refusing them would block Analyst's core order work (item 31).
- **Security, model-written progress posts (medium):** taken for chatter and status claims; milestone findings stay allowed (the state-of-the-art review's low finding), each with a code-rendered status part, rate limits and a T12 eval that fails any claim SQL does not hold (ADR-0040 item 6).
- **Security, person memory in shared outputs (medium):** taken (default "only in my private chats", no notebook or knowledge writes after loading, "Used N memories" for the person only), except that an entry the person sets to "everywhere I ask" is itself the person's confirmation of sharing, so outputs in shared threads keep the thread's audience (item 29).
- **Security, broker as renderer (medium):** taken, decided here rather than waiting for the production custody record, because ADR-0035 makes the one environment v1 production; that record must carry it over (item 8).
- **Feasibility, continuity between requests (high):** the job is the unit, as asked; for a person's own Morrow conversation, continuity comes from the main thread and forks (the state-of-the-art review's high finding), and compiled views serve shared threads and rebases (item 5).
- **Feasibility, `max_tokens` at most 0.1W (high, in the context-growth finding):** the per-turn result budget and the property test are taken; `max_tokens` stays 64,000 at `high` (the state-of-the-art review), because the check before every send keeps sent input under 0.80W whatever one turn adds, and the hard guard bounds the compaction request (items 8 and 11).
- **Feasibility, one live-channel object per workspace (medium):** one object per (workspace, principal), the security review's form, so isolation holds by construction (ADR-0040 item 15).
- **State of the art and feasibility, retrieval and embeddings (medium and low):** neither "embeddings now" nor "no embeddings": the eval is built now, the provider record drafted in parallel, and the measurement decides before the memory switch goes on; the dedicated rerank stage comes with that record, because a rerank model is a provider choice (item 30).

**Rejected:**
- **Feasibility, the first reply as its own short context at `low` effort (medium).** The owner ruled out cheaper models (OD-2026-10-26-5), which this record reads as ruling out lower effort too (owner question 1), and the state-of-the-art review's high finding asks for `high` on every Morrow turn. The fork model of item 5 gives the clean separation it wanted without a cheaper turn.

**Where each taken finding lands.** Security: customer screen 31; role placement 13; tainted approvals 32; audience 25; runs outside a session 7 and 26 to 27 (queue kind dropped, view rebase 14, upkeep runs, sweep rule); absolute envelope 7; steering by non-requesters 17; live channel and Web Push ADR-0040 items 15 and 16; interrupt 21; gateway waits 17; summaries and taint by reader 13 and 26; ledger and recall 13 and 14; retention 14; broker role 8; check-ins ADR-0040 item 12; successors 20; consolidation poisoning 27; person memory 29; admin reads 33; Ask-bound writes 33; kernel bound 21; credits 9; event exposure 36; stops ADR-0040 item 10; low findings 10, 11, 13, 34 and ADR-0040 items 7 and 14. State of the art: one design 4 to 38 and the decision sheet; provider strategy 11 and 12; first reply 2 and ADR-0040 item 4; rejected limits 3 and ADR-0040 items 5 to 10; continuity 5; live channel ADR-0040 item 15; check-ins and follow-through 17 and ADR-0040 item 12; streaming 8; notices 15; credits hidden 3; verification 19; tools 24; latency 35; preload 26; retrieval 30; evals 37; steering 13; teammates 21; result bounds 11; caching 10; text-only replies 16; sixth request ADR-0040 item 9; consolidation 27; milestones ADR-0040 item 6. Feasibility: data model 4; parallel requests 5; run_turns keys 4 and 14; segments 6; distance 35; growth 11 and 12; cost backstops 9 and 18; ADR-0040 rewrite; streaming 8; TTL 10; window and memory 8 and 12; preload 12 and 26; references not copies 14; revocation 14; summaries per viewer set 26; event types 6; live updates ADR-0040 item 15; follow-up role 13; credits hidden 3; holds 9; tool names 24; shared types 34; migration order and limits 38 and the implementation plan; cost baseline Consequences; low findings 6, 11, 15, 22, 26, 30 and 37.

## Owner questions

Each is one item on the combined decision sheet, Q-adr-0040-0041-owner-questions in the project graph, which also holds ADR-0040's and gives each question with its recommendation and why.

1. Opus 5.5 only: should `low` effort go with Haiku and Sonnet, and may the Owner still raise a teammate's effort? (item 2)
2. Renewable leases inside an absolute envelope, and the wider residual. (item 7)
3. Safety check-ins in place of turn and time limits, and who may continue. (item 18)
4. A cost check-in. (item 18)
5. Fair use of the shared Anthropic limit: send share and platform breaker. (item 9)
6. Out of credits: pause and resume, in place of the final-turn reserve. (item 9)
7. Reliability and upkeep steps are paid like other steps. (item 9)
8. Holds that follow the cache. (item 9)
9. Caching the whole conversation with the one-hour TTL. (item 10)
10. Streaming, on-demand compaction and context editing, cache diagnostics. (items 8 and 11)
11. Retention of the new run content. (item 14)
12. One continuing Morrow memory of your conversation (with ADR-0040's one conversation per person). (item 5)
13. Per-person memory: privacy and scope. (item 29)
14. Per-person memory: retention. (item 29)
15. Morrow's notebook, memory suggestions and knowledge proposals. (items 24 and 27)
16. Teammate notebook read-back across people. (item 27)
17. Influence conflicts on approvals. (item 32)
18. Independent review by default. (item 19)
19. 32 teammates per envelope, then Continue. (item 21)
20. Embeddings decided by measurement. (item 30)
21. The conditional runtime SQL object near the database. (item 35)
22. Your labels for calibrating the judges. (item 37)
23. Customer details typed into messages. (item 31)

## Approval

This record is Proposed. The owner's four messages of 2026-10-26 set its direction; none approves this text.

1. The owner's message in chat, verbatim (OD-2026-10-26-3):

   > okay keep our own harness, continue the work, now what about using antrhopic agent sdk in our harness.

   What it approves: Morrow keeps its own harness (item 1). It asks about the Claude Agent SDK.

2. The owner's message in chat, verbatim (OD-2026-10-26-4), after the lead's recommendation to keep the harness on the plain Messages API and not run the Agent SDK in the product:

   > okay lets use recommended but one think which i want is that our app instead of working like a ai chat system where user sends a message and then get the response streamed with a stop button like claude code local sessions, it should be like new grok bot/dots etc. system where its like when user sends a message the ai just recieves it and then send its response, the actual result or something like it understood the job, doing the job etc. this way it truly feels like a agentic system of agents available at users disposle to get shit done. i opened the openai dots in the attached browser you can use it to better understand if you want. also you can make any further architecture design changes if needed for this funcionality.

   What it approves: the recommendation (no Agent SDK and no Managed Agents in the product, item 1) and messaging-style conversations (ADR-0040). It invites the lead to propose design changes; it does not approve them.

3. The owner's message in chat, verbatim (OD-2026-10-26-5):

   > one more thing i am seeing we are using haiku for some parts? why is that? we don't want to cheap out on models as we want the best results for users as all the users are going to be paid users

   What it approves: no Haiku, and no cheaper models for paid users, so Haiku 5.5 and Sonnet 5.5 leave every catalogue (item 2). Opus 5.5 for every agent, Morrow at `high` and every other agent at `medium`, stands from OD-2026-10-25-1. Not decided by it: the lead's reading that `low` effort goes too, and whether the Owner keeps a per-agent effort choice (owner question 1).

4. The owner's message in chat, verbatim (OD-2026-10-26-6):

   > okay let me make it clear now and rememeber it we are not building mvp for the foundation and architecture of our ai workspace for multi agent system to run shopify businesses we are building rock solid productin grade foundation so other things can be build on top of it later. so don't assume its an mvp build, we have to build the state of the art system, so we have to use the method like used by the best multi agentic system on how they handle context, no shortcuts or compromises like finishing the job near limit with an answer etc. similarly don't cut short on any other method/feature in the harness and multi agentic system design.

   What it approves: a production-grade, state-of-the-art foundation for the harness and the multi-agent design, not an MVP build; context handled as the best multi-agent systems handle it; no shortcuts or compromises such as finishing a job near a limit with an answer; nothing else in the harness cut short. Read with it, compaction, full context management and per-person memory belong in scope now rather than later; how each is done (items 3 and 10 to 30) is this record's proposal. It does not name the final-turn reserve the owner confirmed earlier that day (OD-2026-10-26-1 item 2), so replacing the reserve is owner question 6.

**Not approved by these messages:** the text of this record and every value, security trade-off, money rule and retention clock it writes to carry them out, each put to the owner on the decision sheet (owner questions 1 to 23, Q-adr-0040-0041-owner-questions). Approval would be the owner's statement in chat, recorded verbatim with its OD number; for example, "approve ADR-0041 as recommended" would approve this record as written and each owner question with its recommendation.

**Until then, nothing that depends on this record merges:** PR #64's schema and runner changes, PR #79's tool catalogue version 4 and contract edits, the removal of `low` effort from the catalogues, the memory migrations, and the switches. Work the owner already decided (Haiku and Sonnet leaving the catalogues, OD-2026-10-26-5) or that changes no decided value (renumbering PR #64's migration, the fakes) can go ahead.
