# Morrow's agent harness, A to Z

- What this is: a plain-words reference for the owner and the team on how Morrow's agents work: how they think, remember, keep going, work together and stay safe. It explains ADR-0041 (harness foundations) and ADR-0040 (messaging with agents), both accepted on 2026-10-26: the owner answered every question on their decision sheet as recommended (OD-2026-10-26-7), after setting their direction (OD-2026-10-26-3 to OD-2026-10-26-6).
- Where it lives: `docs/references/harness-foundations.md`. Where it and an ADR disagree, the ADR wins (CLAUDE.md).
- Written: 2026-10-26, from five research reports, four area designs and three reviews of the same day. Sources are listed under each topic and in full at the end.

## The short version

- **Morrow keeps its own harness.** The loop that runs every agent is Morrow's code on Cloudflare Workflows, talking to Anthropic's plain Messages API. No Claude Agent SDK and no Claude Managed Agents run inside the product, so who may do what, credits, approvals and data retention stay in Morrow's code.
- **Every agent is Claude Opus 5.5.** Morrow thinks at high effort; every teammate at medium. No Haiku, no Sonnet. Whether low effort also goes is your call (question 1).
- **Nothing ends early because of a limit.** There are no turn limits, no 30-minute clock and no reading cap. When a safety check fires, the job pauses, keeps everything it has done and asks a person.
- **Agents never run out of room.** When an agent's working memory fills up, older parts are summarised and the agent carries on. The facts that matter (your words, approvals, changes, ids) are rewritten from Morrow's records by code, never from the summary.
- **It feels like messaging a team.** You see "Seen by Morrow" at once; quick questions are answered in place; longer work runs in the background on a card; results arrive as finished messages; you get a notification when something needs you or is done.
- **Safety is unchanged.** Every tool call is checked in code, every store change needs your approval of the exact change, and credits are the only spend limit.

## At a glance: the values

All of these are data that a new catalogue or policy version can change, with its evidence.

| What | Value |
| --- | --- |
| Models | Opus 5.5 only: Morrow at high, teammates at medium |
| Longest single reply | 32,000 tokens at medium, 64,000 at high |
| Working window | about 200,000 tokens to start; evals decide, at most 300,000 |
| Old tool results cleared from / summary made at | half the window / 80% of the window |
| Cache lifetime | 1 hour for conversations and anything waiting on a person |
| Tool calls run per turn | 16 |
| Run lease / job envelope | 30 minutes, renewed every step / 24 hours of work or 7 days |
| A person's answer is awaited | 7 days, with reminders at 24 and 72 hours |
| Check-ins | 1,000 turns, 10,000 tool calls, 24 hours of work, 7 days, 32 teammate runs, or 5 times the usual credits |
| Working requests per person | 5 at once, then a waiting line |
| Teammates per job envelope | 32, then a person's Continue |
| Model calls in flight per workspace | 12 |

## A. Approvals, and who may approve

**What it is.** Every change to your store is a proposal bound to a fingerprint (a digest) of the exact change. A person approves that fingerprint; any edit makes a new proposal. Only then does Morrow's one gateway apply the change, read the store back to check it, and record it.

**What Morrow does.**
- Agents propose; people approve. No message, card, notification or reviewer's verdict approves anything.
- The person whose request led to a change cannot approve it in a team; a solo owner confirms with a typed phrase.
- New (ADR-0041 item 32): **whoever's words or notes shaped a proposal cannot approve it either.** If a colleague's message in a project, or a lesson an agent learned while working for that colleague, influenced a proposal, the review card names them and they are blocked from approving it. This stops someone steering an agent with their words and then approving the result themselves. If everyone else in a team is blocked, the Owner may approve with the solo owner's phrase and cool-down.

**Why.** Approvals bound to exact digests are Morrow's core safety rule (CLAUDE.md). Claude Code's agent-teams guidance also treats messages between agents as never counting as a person's consent.

**Sources:** CLAUDE.md security invariants; ADR-0011; ADR-0024 item 7; https://code.claude.com/docs/en/agent-teams.

## B. Background requests and Morrow's main thread

**What it is.** How Morrow handles your messages so that it remembers the conversation and can run several jobs at once.

**What Morrow does.**
- Your Morrow conversation has one continuing memory, the **main thread**. It is private to you.
- A new message goes to the main thread. Morrow answers it there if it can, asks you one question, or starts a **background request**.
- Starting a background request **forks** the main thread: the request gets its own copy of everything Morrow knew at that moment and works on its own. That is why each request starts from your whole conversation, and why five requests can run side by side without getting in each other's way.
- Teammates are always asked from a background request, never from the main thread, so the main thread is always free for your next message.
- When a request finishes, its result appears in the conversation and the main thread is told, by code, that it finished.
- In shared project conversations there is no private main thread: each @Morrow request starts fresh, from a view of the thread built for the person who asked.

**Why.** The best agents keep their working memory between messages instead of starting cold: Claude Code keeps a session, Managed Agents keeps a session log, and Claude Code's "forks" inherit the parent conversation so they start from a cached copy. Starting from scratch for every message throws away the agent's own reasoning and the cache.

**Sources:** https://www.anthropic.com/engineering/managed-agents ; https://code.claude.com/docs/en/sub-agents ; https://code.claude.com/docs/en/how-claude-code-works.

## C1. Caching

**What it is.** Anthropic can remember the start of a request it has seen recently, so sending it again costs a fraction of the price (reads cost 5% of the input price on Opus 5.5).

**What Morrow does.**
- Requests are built in a fixed order: tools, then the system text, then the conversation, which only ever grows at the end. Nothing in the early part changes during a context: not the tools, the system text, the model, the effort or the thinking setting.
- Up to four cache markers per request: after the system text, after the opening, at the end of the request, and where the previous end was.
- Conversations, background requests and anything waiting on a person use the 1-hour cache, so a reply after a coffee break is still cheap; a teammate's short call uses 1 hour on its system text and 5 minutes after.
- A random value per workspace sits after the shared system text, so one shop's cached text can never match another's.
- The cache hit rate is measured on every job, with alarms. When it drops, Morrow asks Anthropic why (the cache diagnostics feature) and fixes the cause.

**Why.** Manus calls the cache hit rate the single most important number for a production agent. Without caching the whole conversation, each turn pays again for everything before it, so cost grows with the square of the conversation's length.

**Sources:** https://platform.claude.com/docs/en/build-with-claude/prompt-caching ; https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus ; https://platform.claude.com/docs/en/about-claude/pricing.

## C2. Check-ins and safety detectors

**What it is.** How Morrow stops a job that has gone wrong without stopping a job that is just long.

**What Morrow does.**
- Code watches every turn for behaviour that means trouble: the same call repeated with the same result, the same error again and again, flipping between two actions, turns that do nothing, long stretches with no progress, credits spent with no progress, and summaries that keep failing to free up room.
- First it nudges the agent with a short note ("repeating will not work; change approach"). If the problem continues, the job **pauses and checks in**: it saves its place and posts a message with Continue, Continue with guidance, and Stop.
- Backstops that only check in, never end: 1,000 turns, 10,000 tool calls, 24 hours of work, 7 days since you last touched the job, 32 teammate runs, or 5 times the usual credits for that kind of job.
- Only the person who asked can Continue; for a scheduled agent, its owner or the Owner. Anyone with a stop can Stop.
- A teammate never asks you directly: if it gets stuck, it hands its partial work back to Morrow, which decides.

**Why.** No leading system ends healthy work at a small turn count. OpenHands detects repeated actions and errors, Magentic-One counts stalls and replans instead of quitting, and Claude Code restarts stalled work. Hard ceilings exist only as runaway backstops.

**Sources:** https://github.com/OpenHands/software-agent-sdk (stuck detector) ; https://github.com/microsoft/autogen (Magentic-One orchestrator) ; https://code.claude.com/docs/en/goal ; https://code.claude.com/docs/en/workflows.

## C3. Compaction: how agents never run out of room

**What it is.** An agent can only pay close attention to so much at once. When its working memory fills up, older parts are condensed so it can carry on.

**What Morrow does, in order, cheapest and most reversible first.**
1. **Big results are stored, not pasted.** A result larger than about 24,000 tokens becomes a stored item with a short preview; the agent opens it page by page when it needs it.
2. **Old results are cleared.** From half the window, Anthropic's server clears old tool results that can be fetched again, keeping the latest ones and every error.
3. **Older work is summarised.** At 80% of the window, Anthropic's on-demand compaction writes a summary of everything except the most recent turns, which are kept word for word. Morrow gives it its own instructions: keep decisions and why, what was tried, exact ids and values, and what is promised next.
4. **Code rewrites the facts.** After every summary, code adds a block from Morrow's records: your exact words, every question and answer, every proposal and its state, every change and whether it is confirmed, every record created. "Where the summary disagrees with these records, the records are right."
- The agent can reopen anything summarised away, exactly, with `memory.read`.
- If Anthropic's compaction is unavailable, Morrow's own version runs instead: the agent writes a structured summary, and the job starts a fresh window from it and the records. This fallback is built first, and a switch can return to it at any time.
- The working window starts at about 200,000 tokens and is set by tests that measure answer quality at different sizes, separately for high and medium effort.

**Why.**
- Context rot: models get worse as their input grows, even on simple tasks, and similar-looking distractors (like a shop's catalogue) hurt most.
- On Opus 5.5 the history must only grow at the end: editing earlier turns on Morrow's side throws away the model's reasoning, and new accounts get an error for it. Anthropic's server-side compaction and clearing don't count as edits, and Anthropic's docs say to use on-demand compaction wherever it is available.
- Every leading system reduces context in this order: offload, clear, then summarise (Manus, Anthropic, deepagents, Cursor). Codex and Letta keep exact ids and the user's words verbatim.

**Sources:** https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand ; https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns ; https://platform.claude.com/docs/en/build-with-claude/context-editing ; https://platform.claude.com/docs/en/build-with-claude/preserved-thinking ; https://www.trychroma.com/research/context-rot ; https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ; https://www.langchain.com/blog/context-management-for-deepagents.

## C4. Credits

**What it is.** Credits are the only limit on what agents spend (ADR-0039).

**What Morrow does.**
- Before each step, a job sets aside the most that step could cost; after it, it pays what it actually used. All of this happens in the database under a lock, so parallel jobs never spend past the balance.
- The set-aside follows the cache: the part already cached is held at the cheap cache-read rate.
- Summaries, reviews, memory tidying and retries after an unclear provider failure are ordinary paid steps. Jobs that fail because of an error on Morrow's or Anthropic's side are free: the charge is refunded when the job settles.
- **When the balance runs out, the job pauses** ("Paused: out of credits", with Add credits and Stop) and carries on by itself once credits are added. Nothing is lost. (The earlier rule was to finish with whatever answer it had; you replaced it with this pause, OD-2026-10-26-7.)
- Agents never see a balance, a budget or a countdown, because a countdown makes models wrap up early. You see spend on each request's card.
- To protect every shop from one runaway, each workspace may have 12 model calls in flight at once, and new jobs pause if Morrow's monthly provider spend reaches 80% of your Anthropic limit.

**Sources:** ADR-0039; https://platform.claude.com/docs/en/build-with-claude/task-budgets (budgets that are too small cause early stops).

## C5. Customer details

**What it is.** Names, emails, addresses and phone numbers of your customers may not be stored until Morrow's customer-deletion path exists (P09.T05).

**What Morrow does.** One check in code looks for emails, phone numbers, street addresses, Shopify customer ids and known customer email fingerprints. It runs on every message you send to an agent ("Morrow can't keep customer details yet. Remove them and send again.") and on every text a model writes that Morrow stores: summaries, plans, results and messages. Order numbers are fine. Morrow itself never sees customer-tagged data.

**Sources:** CLAUDE.md; ADR-0031 items 2 and 6.

## D. Durable execution

**What it is.** How a job survives crashes, deploys and waits of days.

**What Morrow does.**
- Every job runs as a Cloudflare Workflow: each step's result is saved, so after a crash the job replays to where it was without doing anything twice.
- The truth lives in Morrow's database, not in the Workflow. Any Workflow instance can be replaced by a fresh one that reads everything back.
- A long job moves to a fresh Workflow instance every 1,000 steps, at every summary, and before any long wait, so replays stay quick and new code never trips over old steps.
- Each step's database work is one round trip, because the database is far from where Workflows run. If staging shows that is still too slow, the database work moves into a small object placed next to the database.
- Every version of the code an open job depends on stays available, and tests check that a recorded job renders byte for byte the same.

**Why.** Every production agent engine records step results and replays them (Claude Code workflows, Cloudflare Workflows, LangGraph, Temporal). Managed Agents splits the "brain" from its log so a crashed harness can be replaced with `wake(sessionId)`.

**Sources:** https://developers.cloudflare.com/workflows/reference/limits/ ; https://developers.cloudflare.com/workflows/build/rules-of-workflows/ ; https://www.anthropic.com/engineering/managed-agents.

## E1. Effort and models

**What it is.** Which model each agent uses, and how hard it thinks.

**What Morrow does.**
- Opus 5.5 for every agent. Morrow at high effort, every teammate at medium. Summaries and checks use the same model and the effort of the agent whose work they concern; a check of Morrow's work runs at high.
- Haiku and Sonnet are removed from every catalogue, Listings' included. They go because you ruled out cheaper models (OD-2026-10-26-5); low effort goes too, and the Owner may still raise a teammate to high (OD-2026-10-26-7). Extra-high and max effort come later, once tests show they help.
- The model and effort never change in the middle of a context, because that would throw away the cache and the model's reasoning.
- Morrow's first reply runs at high effort too. "Seen by Morrow" and the status line make it feel immediate; the real reply comes as fast as a high-effort turn allows, measured on staging.

**Sources:** owner messages of 2026-10-26 (ADR-0041 Approval); https://platform.claude.com/docs/en/about-claude/pricing ; https://platform.claude.com/docs/en/build-with-claude/prompt-caching (what breaks the cache).

## E2. Embeddings and search

**What it is.** How agents find the right knowledge page, note or message.

**What Morrow does.**
- Search in Morrow's database by words and by close spellings, with results merged and ranked, filtered by who may see what before ranking.
- Agents search with several phrasings at once ("best sellers", "top products") and read the most promising hits.
- Meaning-based search (embeddings) is not switched on yet. A test of how well search finds things said in other words is built now from your shop's data; if it falls short, a record choosing an embedding provider goes to you before the memory features switch on.

**Why.** Small, structured memories are searched well by words plus the agent's own judgement (Claude Code, Managed Agents memory, Letta). Anthropic's own tests show embeddings plus word search plus re-ranking cut retrieval failures by up to 67%, which is why the test decides. Embeddings are also a copy of the text that can be turned back into text, so every deletion must reach them.

**Sources:** https://www.anthropic.com/news/contextual-retrieval ; https://www.letta.com/blog/benchmarking-ai-agent-memory ; https://arxiv.org/abs/2310.06816 (embedding inversion).

## E3. Evals: how we know it works

**What it is.** Tests that run agents on real-shaped tasks and grade the results.

**What Morrow does.**
- Every switch has a pass mark set before the test runs. The set of tasks grows from 16 to at least 80, grouped by kind: quick answers, data questions, multi-teammate jobs, long batches, steering, pause and resume, refusals, injected text, memory and summaries.
- Grading: checks in code first (which tools ran, what was refused, credits, no store change without approval), then a rubric judged by Opus 5.5 in a separate context, checked against labels you give, then people reading transcripts.
- Special tests for summaries: a detail from early in a job recovered at its end; the goal surviving three summaries; every id the job touched still known; a planted "say the owner approved" never believed.
- At every new model release, each part of the harness is switched off in turn to see whether it still earns its place.

**Why.** Anthropic's eval guidance: grade outcomes, use pass^k when consistency matters, calibrate model judges against people, read transcripts, and re-test every harness part when models change.

**Sources:** https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents ; https://www.anthropic.com/engineering/harness-design-long-running-apps ; `docs/evals/README.md`.

## E4. Events

**What it is.** One record of everything that happens in a job, with no content in it.

**What Morrow does.** Every state change writes one event in the same database transaction: ids, codes, counts and times only. The request cards, the activity log, alarms and evals all read the same events, each shown only to people allowed to see it.

**Sources:** ADR-0041 item 36.

## F. Follow-ups and steering

**What it is.** What happens when you write while a request is working.

**What Morrow does.**
- A reply to a working request ("Replying to" above the box) goes into that request at its next step, as your words, labelled by code with who wrote it. Morrow may change course, pass the change on to the teammates working on it, or stop the calls that no longer matter.
- A new message without "Replying to" goes to the main thread and becomes a new request beside the others.
- Only the person who asked can steer a request. Anyone else's message never reaches it; in a project, it can only shape a later request as clearly labelled data from a colleague.
- A job never finishes while one of your messages to it is still unread.

**Why.** Grok redirects work on a new message; GitHub's agent applies a steering message after its current step. Morrow routes in code, visibly, so unrelated asks never get mixed.

**Sources:** ADR-0040 items 7 and 8 (and the product research in its Context); https://docs.x.ai/grok-bot.

## L1. Leases and the job envelope

**What it is.** The permission slip a running job carries.

**What Morrow does.**
- A job runs on a 30-minute lease that is renewed at every step, after checking again that the person still has their permissions, the agent is still allowed, and nothing has been stopped.
- Each job also has an outer limit, its **envelope**: 24 hours of active work or 7 days, whichever is first. Only the person who asked can extend it, by answering, writing to it or pressing Continue.
- A waiting job holds no lease. When what it waits for happens (a teammate finishes, a timer, credits added, an approval), it resumes only after the same checks run again.

**Why.** A fixed 30-minute lease cannot carry a job that runs for hours. The envelope keeps a person in the loop: even if part of Morrow were compromised, it could not keep a job going forever or past a stop.

**Sources:** ADR-0022 item 9; ADR-0041 item 7.

## L2. Live updates and notifications

**What it is.** How your screen and phone learn that something changed.

**What Morrow does.**
- **On screen:** each signed-in person has a small live channel (a Cloudflare Durable Object) that tells the browser "something changed" within about a second. It never carries content: the browser then asks the server what changed, and the server shows only what that person may see. If the channel drops, the browser checks every 2 seconds while a request is working.
- **On your phone or desktop:** push notifications for "Needs you" at once and "Done" if you haven't seen it within 2 minutes; never more than 6 an hour; nothing during quiet hours. The notification itself is empty; your device fetches the counts with your session, so nothing private passes through Apple, Google or Mozilla.
- **By email** (after the email domain is set up): one batched email for what you haven't seen after 15 minutes, at most hourly.

**Why.** Messaging products push updates rather than poll; Cloudflare's hibernating WebSockets cost almost nothing while idle. Content-free hints and pushes keep private conversations private.

**Sources:** https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ; https://datatracker.ietf.org/doc/html/rfc8291 (Web Push encryption) ; ADR-0040 items 15 and 16.

## M. Memory, layer by layer

**What it is.** What Morrow's agents remember, who can see it, and how it is kept safe.

| Layer | What it holds | Who writes it | Who reads it |
| --- | --- | --- | --- |
| A job's plan and notes | the plan, findings, dead ends, decisions | the job itself | the job, and you on its card |
| Your Morrow conversation | the main thread and its summaries | Morrow and code | only Morrow, for you |
| Shared thread summaries | checked summaries of older parts of a project thread | a tidy-up run | requests in that thread, per person |
| Each agent's notebook | lessons, corrections, procedures | that agent | that agent, when the reader may see the sources |
| Shop knowledge | approved pages | people; agents only propose | every agent, filtered by access |
| Your personal memory | your preferences and instructions | only you (you tap Save) | only runs you ask for |

**What Morrow does.**
- **Memory is information, never permission.** Nothing a memory says can add a tool, a permission, a recipient or an approval. Memory is always shown to agents as labelled data with its source.
- **Everything remembered keeps its audience.** Something learned in your private conversation is readable only by work done for you. A lesson learned in a project is readable only by work whose requester can see that project.
- **Untrusted sources stay marked.** If a memory came from product text, a supplier email or a colleague's message, everything that reads it is marked too, and any change built on it needs your approval of the exact change.
- **Your personal memory** is yours alone: no Owner or Admin can read it; by default it is used only in your private Morrow conversation; you can switch an entry to "everywhere I ask". Morrow suggests ("Remember that you prefer British spelling?") and saves nothing until you tap Save. Customer details, contact details and card or ID numbers are refused. You can edit or delete any memory, and deleting erases every version at once.
- **Notebooks are tidied safely.** A tidy-up run proposes a set of changes, shown as a diff you can roll back; it never edits the originals in place, and a run that read something suspicious can only flag a trustworthy note, never delete it.
- **Deletion follows the source.** When a message, page or person's data is deleted, everything derived from it (summaries, notes, suggestions) is erased in the same transaction.

**Why.** Memory poisoning is a real attack (SpAIware on ChatGPT, delayed tool invocation in Gemini, summary poisoning in Bedrock, MINJA in research). The defences that hold are architectural: memory as untrusted data, writes committed by code or a person, taint that follows lineage, and deletion by provenance. Anthropic's Dreams write a new memory store and never change the input; Letta merges memory through reviewed commits.

**Sources:** https://platform.claude.com/docs/en/managed-agents/memory ; https://platform.claude.com/docs/en/managed-agents/dreams ; https://code.claude.com/docs/en/memory ; https://www.letta.com/blog/context-repositories/ ; https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/ ; https://arxiv.org/abs/2503.03704 (MINJA) ; https://www.getzep.com/blog/defending-agent-memory-poisoning/.

## N. Notices and recitation

**What it is.** Short system notes the harness gives an agent, and reminders of where a job stands.

**What Morrow does.**
- System notes are fixed templates with codes and numbers only ("your reply was cut off; split the work"). No text a person, a tool or a model wrote ever goes into a system note.
- A reminder of the plan and the job's state is added only after a summary, after a pause, or when something important changes, as a short "this replaces the earlier state" block. Never every turn.

**Why.** Repeating the goal fights drift (Manus recites its todo list), but many near-identical stale copies are exactly the distractors that hurt most; Codex appends only the change. Keeping person and tool text out of system notes stops injected text from posing as instructions.

**Sources:** https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus ; https://github.com/openai/codex ; https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages.

## O. Orchestration: Morrow and its teammates

**What it is.** How Morrow gets teammates to do the work.

**What Morrow does.**
- Morrow asks a teammate and keeps working; it does not sit and wait. It can ask several at once, then collect the answers as they arrive.
- It can ask the same teammate a **follow-up** that remembers everything that teammate already read, or start a fresh one for unrelated work.
- It can send a running teammate **guidance** mid-job ("focus on the winter range") and cancel calls that no longer matter.
- For the same work over many products, `agent.map` splits it into batches, runs them in parallel and merges the results into one table, so Morrow's own memory holds only the final answer.
- Teammates share work through stored result items that Morrow passes on by id. Teammates never call other agents (depth 1).
- Up to 32 teammate runs per job; past that, the job asks you, and your Continue lets it go on.
- Morrow scales effort to the task: it answers itself when it can, uses one teammate for one area, two to four for comparisons, and fan-out for batches.

**Why.** Anthropic's research system: a lead with parallel workers beat a single agent by 90%, with clear briefs (objective, output format, boundaries). Anthropic's guidance for Fable 5.1: let the lead keep working while subagents run. Managed Agents and Codex keep delegation one level deep and let subagents take follow-ups. Google's scaling study: a central orchestrator amplifies errors far less (4.4 times) than independent agents (17.2 times).

**Sources:** https://www.anthropic.com/engineering/multi-agent-research-system ; https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1 ; https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration ; https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ ; https://cognition.com/blog/multi-agents-working.

## P1. Plans and finishing

**What it is.** How a background job knows what it is doing and when it is done.

**What Morrow does.**
- Every background job writes a plan first: its objective, the criteria for done, and the steps. You see what Morrow understood and its steps as the first message.
- The criteria for done are fixed when the plan is set; changing one needs your message or a logged reason the reviewer sees.
- A job finishes only through `run.complete`, and code checks: every step finished, no teammate still running, nothing unconfirmed in your store, and each criterion met against the records.
- A quick answer needs no plan. In a conversation, a reply simply means "your turn".

**Why.** Anthropic's long-running harnesses keep the plan outside the context and agree on "done" before work starts; METR found that telling a model not to cheat barely helps, so the check must be in code.

**Sources:** https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents ; https://www.anthropic.com/engineering/harness-design-long-running-apps ; https://metr.org/blog/2025-06-05-recent-reward-hacking/.

## P2. Proactive work and standing requests

**What it is.** Agents getting in touch without being asked each time.

**What Morrow does.**
- **Standing requests:** you can ask Morrow to do something on a schedule ("every Monday, check which best sellers will run out"). You confirm it once. Each time it runs with your permissions at that moment, posts only in your own Morrow conversation, can read and suggest but not change anything, and expires after 90 days unless you renew it. You or the Owner can stop it at any time.
- **Follow-through:** a job can wait for your approval or for a change to be confirmed, then carry on by itself ("Waiting for your approval · then: draft the announcement").
- **Teammates' own routines** report in their area and point to you when something needs you.
- **Long jobs** may post one short interim finding per phase ("6 at-risk products so far"), never step-by-step chatter, and never a claim that something was approved or done unless the records say so.

**Why.** Dots and Grok Bot message you about work they're watching. Morrow does it with a person's standing request as the source of authority, like its scheduled agents.

**Sources:** ADR-0024; ADR-0040 items 6 and 12.

## R1. Results and result items

**What it is.** How large outputs travel without being cut.

**What Morrow does.** Anything too big for one message (a 200-row table, a long report, a file) is stored as a result item: tenant-isolated, labelled with who may see it and where it came from. Messages and results point to it by id; agents read it page by page. Nothing is ever truncated silently.

**Sources:** ADR-0037 item 3(a); https://code.claude.com/docs/en/tools-reference (large outputs saved to files).

## R2. Retention

**What it is.** How long Morrow keeps what agents worked with.

**What Morrow does.**
- Job content (turns, summaries, plans, results) is kept 90 days after each window of work closes; a long conversation starts a new window at least every 30 days, so nothing old lingers.
- The model's private reasoning is deleted as soon as it stops being sent.
- Deleting a message, page or person removes every copy and everything derived from it at once, not on a timer.
- Records with no content (events, waits, call registries) are kept 365 days for audit.

**Sources:** ADR-0031; ADR-0041 item 14.

## R3. Review before presenting

**What it is.** A second agent checks important work before Morrow shows it to you.

**What Morrow does.**
- Code checks first: records exist, counts add up, every claim points to evidence the job really produced.
- Then a fresh reviewer, with no access to the original agent's reasoning and only read permissions, checks the work against the fixed criteria, at the same effort as the work it checks. It can only block; it never approves anything.
- It runs on suggested store changes, figures you will act on, files, new agent cards, and anything built on untrusted text. Not on everyday chat.
- Its catch rate and false alarms are measured against your labels.

**Why.** Agents grade their own work too leniently; a separate skeptical reviewer is more reliable, and self-correction without outside feedback can make results worse. Adding a verification step improved multi-agent success by 15.6% in one study; fresh-context reviewers find real bugs.

**Sources:** https://www.anthropic.com/engineering/harness-design-long-running-apps ; https://arxiv.org/abs/2310.01798 ; https://arxiv.org/html/2503.13657 ; https://cognition.com/blog/multi-agents-working.

## S. Streaming

**What it is.** Receiving the model's reply piece by piece as it is written.

**What Morrow does.** The broker (the only part of Morrow that holds the Anthropic key) receives the reply as a stream, which allows long replies and deep thinking without timeouts. The stream stops at the broker: you always see complete messages. If a stream breaks partway, the turn is treated as uncertain, charged at its worst case unless the job fails, and sent again only after a new hold.

**Sources:** https://platform.claude.com/docs/en/build-with-claude/streaming ; ADR-0041 item 8.

## T1. Taint, read tags and whose words are whose

**What it is.** How Morrow tracks where information came from.

**What Morrow does.**
- **Read tags** record which kinds of shop data a job has read; everything the job writes carries them, so people who can't see that data can't see the output.
- **Taint** marks a job that read text from outside (product descriptions, emails, uploads, a teammate who read those) or a colleague's message. A tainted job's proposals always need a person's approval of the exact change, and its cards list the sources.
- **Your words are yours.** Only your own messages reach an agent as your instructions. A colleague's message reaches it as labelled data from that colleague.

**Sources:** ADR-0027 item 5; ADR-0031 item 6; https://arxiv.org/abs/2503.18813 (CaMeL).

## T2. Tools

**What it is.** The actions an agent can take.

**What Morrow does.**
- A closed list, fixed for the life of a context. No tool takes SQL, a web address, a permission, a store, a recipient, a credential or a model.
- The harness adds a small set that grant nothing and touch only the job's own records: plan, complete, wait, write a result, and the checkpoint used by the fallback summary. Morrow adds ask, map, message, cancel, hand off and propose an agent. Memory has one search and one read tool.
- Every tool call is checked in code against the full set of permissions: yours, the agent's, its owner's, the store connection's, the workspace rules and any stop.

**Why.** Fewer, consolidated tools are chosen more accurately (Anthropic's tool guidance; Manus keeps under 20; Claude Code turned its to-do tools off on newer models because they cost attention).

**Sources:** https://www.anthropic.com/engineering/writing-tools-for-agents ; https://code.claude.com/docs/en/tools-reference.

## W1. Waits and parking

**What it is.** How a job waits for minutes or days without holding anything.

**What Morrow does.** A job can wait for teammates, a person's answer, an approval and its confirmation, a time, credits, the AI provider, or a free slot. A waiting job holds no lease and no credits and costs nothing. When the thing happens, the job resumes after its permissions are checked again. A person's answer is awaited for 7 days, with reminders; after that the job closes but keeps its place, so Continue can pick it up.

**Sources:** https://developers.cloudflare.com/workflows/build/events-and-parameters/ ; ADR-0041 item 17.

## W2. The working window

**What it is.** How much an agent reads at once. Opus 5.5 can take a million tokens, priced the same at any size, but quality drops long before that.

**What Morrow does.** Each agent works within a window of about 200,000 tokens to start; tests at different sizes, at high and at medium effort, set the real value (at most 300,000). The million-token limit stays as headroom: a hard guard at half of it can never be reached in normal work.

**Why.** Chroma's context-rot tests, "lost in the middle", and Anthropic's own defaults (summaries at 150,000, clearing at 100,000) all favour a mid-sized window when the durable state lives outside it.

**Sources:** https://www.trychroma.com/research/context-rot ; https://arxiv.org/abs/2307.03172 ; https://platform.claude.com/docs/en/build-with-claude/context-windows ; https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges.

## What you decided

The combined decision sheet (Q-adr-0040-0041-owner-questions in the project graph, 35 questions) put each value, money rule, security trade-off and retention clock to the owner with a recommendation, and the owner accepted every recommendation on 2026-10-26 (OD-2026-10-26-7). The largest ones: renewable leases within the job envelope; pausing instead of finishing when credits run out; safety check-ins in place of turn and time limits; caching the whole conversation; using Anthropic's beta compaction behind a switch; personal memory's privacy; the live channel and phone notifications at launch; and standing requests for Morrow.

## Words used here

- **Agent / teammate:** an AI worker with its own permissions. Morrow is the main agent; every other agent is a teammate.
- **Context:** everything an agent is reading in one go. **Epoch:** one window of a context, between summaries.
- **Job / request:** the work one message, one Start or one schedule begins.
- **Main thread / fork:** Morrow's ongoing memory of your conversation, and a background request's own copy of it.
- **Lease / envelope:** a job's short-term and long-term permission slips.
- **Park / check-in:** a pause caused by safety, credits or the provider; a check-in is a pause that asks you.
- **Taint:** a mark that untrusted text reached a job. **Read tags:** which kinds of shop data a job read.

## All sources

Anthropic engineering and docs:
- https://www.anthropic.com/engineering/managed-agents
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://www.anthropic.com/engineering/harness-design-long-running-apps
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- https://www.anthropic.com/engineering/long-running-claude
- https://www.anthropic.com/news/contextual-retrieval
- https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand
- https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns
- https://platform.claude.com/docs/en/build-with-claude/compaction-background
- https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- https://platform.claude.com/docs/en/build-with-claude/context-windows
- https://platform.claude.com/docs/en/build-with-claude/token-counting
- https://platform.claude.com/docs/en/build-with-claude/task-budgets
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/managed-agents/memory
- https://platform.claude.com/docs/en/managed-agents/dreams
- https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://code.claude.com/docs/en/sub-agents ; /context-window ; /memory ; /workflows ; /goal ; /agent-teams ; /tools-reference ; /how-claude-code-works

Other systems and research:
- Manus: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- OpenAI Codex source: https://github.com/openai/codex (compaction, world-state diffs, agent depth)
- OpenHands stuck detector: https://github.com/OpenHands/software-agent-sdk
- Magentic-One: https://github.com/microsoft/autogen
- Google ADK: https://github.com/google/adk-python ; https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/
- Google scaling study: https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/
- Cognition: https://cognition.com/blog/multi-agents-working ; https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges
- Cursor: https://cursor.com/blog/scaling-agents ; https://cursor.com/blog/dynamic-context-discovery
- LangChain deepagents: https://www.langchain.com/blog/context-management-for-deepagents
- Letta: https://www.letta.com/blog/context-repositories/ ; https://www.letta.com/blog/benchmarking-ai-agent-memory ; https://www.letta.com/blog/evaluating-memory-in-production-agents/
- Zep on memory poisoning: https://www.getzep.com/blog/defending-agent-memory-poisoning/
- Chroma context rot: https://www.trychroma.com/research/context-rot
- Lost in the middle: https://arxiv.org/abs/2307.03172
- Self-correction (Huang et al.): https://arxiv.org/abs/2310.01798
- MAST failure taxonomy: https://arxiv.org/html/2503.13657
- METR reward hacking: https://metr.org/blog/2025-06-05-recent-reward-hacking/
- MINJA: https://arxiv.org/abs/2503.03704 ; CaMeL: https://arxiv.org/abs/2503.18813 ; Vec2Text: https://arxiv.org/abs/2310.06816
- Unit 42 memory poisoning: https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/
- Cloudflare: https://developers.cloudflare.com/workflows/reference/limits/ ; https://developers.cloudflare.com/workflows/build/rules-of-workflows/ ; https://developers.cloudflare.com/workflows/build/events-and-parameters/ ; https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Web Push encryption: https://datatracker.ietf.org/doc/html/rfc8291
- Messaging products (ADR-0040 Context): https://docs.x.ai/grok-bot ; https://linear.app/developers/aig.md ; https://docs.slack.dev/ai/developing-ai-apps ; https://code.claude.com/docs/en/claude-projects.md
