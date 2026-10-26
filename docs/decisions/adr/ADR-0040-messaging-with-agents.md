# ADR-0040 Messaging with agents: write first, see it read at once, work in the background, get complete results

- Status: Proposed 2026-10-26, revised the same day to stand on ADR-0041 and the owner's production-grade direction. A draft for the owner; nothing in it is approved (see "Approval left for the owner").
- Date: 2026-10-26
- Supersedes: no accepted record. It takes the place of:
  - the harness guide's row 21 recommendation (one open Morrow run per conversation, posting paused while it is open, Stop on the composer), which no accepted record holds and the owner's message set aside;
  - the "Streaming", "Run strip above the composer" and "Send becomes a labelled Stop" patterns in `docs/design/mobbin-references.md`, which are design guidance, not a record;
  - this record's first draft of 2026-10-26, which kept launch shortcuts: a low-effort first reply, polling with no live channel, "Morrow never checks in", a next run admitted on a final turn, extra turns per follow-up, a "stops by itself at 11:33" line and a 6,000-token history window.
- Amends:
  - **Contracts:**
    - `docs/contracts/collaboration.md` v1.1 and `schemas/v1.1/core.schema.json`: `MessageStatus`'s `streaming`, `MessageDelta`, `StreamFrame`'s `message_delta`, the "Streaming" bullet and `SystemAuthor`'s parts, through a v1.2 with `changes.json` entries (item 1);
    - `state-transitions.json`'s `message` rows (items 1, 2 and 5); `events.md`: four additive rows (item 5);
    - `screen-contracts.md`: the two streaming rules, and the Ask conversation row, which becomes the Morrow conversation (items 1 and 11);
    - `workspace-routes.json` and `workspace-routes.md`: a `morrow` destination with its own badge kind replaces "Ask is the entry action, not a destination", and a `live` WebSocket route (items 11 and 15);
    - `capabilities.json`: `workspace.job.stop` and `workspace.standing_request.revoke`, both `human_only` (items 10 and 12).
  - **ADR-0016** item 5's accepted disclosure that a viewer may learn a streamed message started (item 1; owner question 33).
  - **ADR-0022** items 6 and 7: the api gains one service binding to an orchestrator entrypoint, `ApiRunStarter`, on item 7's one-entrypoint-per-caller pattern, and a WebSocket route to the live channel (items 3 and 15).
  - **ADR-0027** item 5: another member's post is untrusted content with its own taint kind, `other_member` (item 13). Item 8 and **ADR-0034** answer 4 ("Morrow never checks in on its own schedule"): Morrow may run a person's standing request, on ADR-0024's pattern (item 12).
  - **ADR-0034** item 9: `job_card` for the system author, and `job_plan` for Morrow (items 4 and 5).
  - **ADR-0038** item 1: a second Durable Object class, `LiveChannel` in the api Worker, with hibernatable WebSockets, an alarm and publisher bindings (item 15).
  - **ADR-0030** item 8 and **ADR-0007** item 2: Web Push as fixed, content-free notifications, with a VAPID key held by the broker (item 16).
  - **ADR-0031** items 1 and 7: new data classes, and the browsers' push services in `data-regions.json` (items 16 and 17).
  - **ADR-0032** item 1, for the Morrow conversation only and only if the owner answers question 34 yes: the person's own messages sit on the right (item 11).
  - **The M3 brief's owner decision 5 of 2026-10-22** ("a run starts within a minute of admission"), for loop runs (item 3).
- Does not change:
  - **ADR-0016 items 3 and 5**, apart from the disclosure above and the harness writes ADR-0041 item 33 names. Asks stay private; admin reads stay audited and paged; admins get no Ask events or live updates, and the admin grant gives no command over another member's Ask.
  - **ADR-0031 items 2 and 6.** Customer data never reaches Morrow, and a run's read tags are the union of what it consumed.
  - **ADR-0034 items 4, 7 and 8.** Each tapped answer still starts a new run; a finished step never starts the next step by itself.
  - **ADR-0024.** Mandate runs start only from trigger rows, behind G10.
  - **ADR-0037.** Depth 1, calls and hand-offs, 32 children per envelope.
  - **ADR-0039.** Credits are the only spend limit.
  - **ADR-0005.** Kill switches.
  - **ADR-0032**, apart from the conditional change above: no emoji, no coloured bubbles, Sunrise's badges and plain words.
  - Every security invariant.
- Implements: the owner's message of 2026-10-26 quoted under Context (OD-2026-10-26-4), under ADR-0041 and the owner's production-grade rule of the same day (OD-2026-10-26-6). Its owner questions, with ADR-0041's, are Q-adr-0040-0041-owner-questions.
- Relies on:
  - **ADR-0041:** the main thread and forks (item 5), leases and the job envelope (item 7), streaming in the broker (item 8), the plan and `run.complete` (item 16), waits and follow-through (item 17), check-ins (item 18), calls and guidance (item 21), memory (items 25 to 29), the role rule (item 13), the customer identifier screen (item 31), the Ask-bound writes (item 33) and `RunEvent@1` (item 36);
  - P05.T04b (no agent runs in an Ask before it); P06.T02a (sealed cursors); P07.T03 (conversations and messages); P11.T05 (the workspace stop); P09.T05 (the customer deletion path); G7 (the email domain).
- Unblocks: v1 build order PR 12 (in two parts), PR 15's changes, ADR-0037 follow-up PRs 4 and 5, P06.T02a's transport and P07.T03's message shape.
- Terms:
  - **Request:** the work that one person's post (or a quick burst of posts), one Start, one trigger or one standing request begins. In code it is a job (`job_id`). The screen never says "job".
  - **Post:** a message a person sends. **Conversation inbox:** the durable record of each post addressed to an agent.
  - **Steer:** deliver the requester's follow-up to a request's open run at its next safe step.
  - **Status line:** one line, written by code, under a person's own message. **Request card:** a request's status, kept by code (`job_card`).
  - **Main thread:** Morrow's continuing context in your Morrow conversation (ADR-0041 item 5). **Morrow:** the Coordinator, as in ADR-0037.

## In plain words

Today Morrow is drawn like a chat: you send a message, the answer types itself out, and Send turns into Stop until it finishes. The owner wants it to feel like messaging a team of agents who get things done.

For example:
1. In your Morrow conversation you write: "Which best sellers run out before Black Friday? And write descriptions for the 12 new autumn photos."
2. "Seen by Morrow" appears under your message within seconds, then "Morrow is working on it · 12 s".
3. Morrow replies: "Got it: which best sellers run short before Black Friday, and descriptions for the 12 autumn photos. I'm asking Inventory and Business Analyst about stock now. Descriptions change your store, so Listings will write them in a project once you tap Start." A plan card with Start sits under the reply, and a card shows "Working · Asking Inventory and Business Analyst · 2 min".
4. While that runs you ask, "What did we sell yesterday?" It becomes a second request beside the first, and Morrow answers it on its own.
5. The stock result arrives as one finished message: a table of six best sellers at risk. If you've left, your phone says "Morrow finished something you asked for".
6. You tap Start. Listings works in a new project. A card in your Morrow conversation follows it until it says "Done · 12 suggested changes · Open review".
7. You tell Morrow, "Every Monday, check which best sellers will run out in the next two weeks." After you confirm it, Morrow checks in each Monday with what it found.

You can write at any time:
- While a request is working, a reply to it goes into it, and "Replying to" above the box shows which one. Tap ✕ and your message starts a new request instead.
- Nothing types itself out, and the box you write in never locks. Stop sits on each request.
- Morrow remembers your conversation, so every request starts from what you've already talked about.

Who may do what does not change: every tool call is still checked in code, every store change still needs your approval of the exact change, and credits still limit what the agents spend.

## Context

The owner's message in chat on 2026-10-26, verbatim:

> okay lets use recommended but one think which i want is that our app instead of working like a ai chat system where user sends a message and then get the response streamed with a stop button like claude code local sessions, it should be like new grok bot/dots etc. system where its like when user sends a message the ai just recieves it and then send its response, the actual result or something like it understood the job, doing the job etc. this way it truly feels like a agentic system of agents available at users disposle to get shit done. i opened the openai dots in the attached browser you can use it to better understand if you want. also you can make any further architecture design changes if needed for this funcionality.

Later the same day the owner set the rule for the whole foundation: "we are building rock solid productin grade foundation ... no shortcuts or compromises" (quoted in full in ADR-0041; OD-2026-10-26-6). This revision removes the first draft's launch shortcuts accordingly.

**What the lead saw on the owner's own OpenAI dots page** (read only): one persistent conversation with the agent, in the sidebar with an unread count; complete messages that never type themselves out, with day separators and times; a "Read" mark on the person's messages, reactions and quoted replies; the agent posting by itself over several days (status on watched work, results with an attached CSV, source links); Scheduled, Plugins and a call button. OpenAI's public pages confirm an always-on agent that messages you with progress, questions and decisions; a conversation per task; scheduled runs whose updates appear in the conversation; read-only proactive research; action rules from acting without asking to handing off; a Pause control. They do not document the read marks, the reactions, or what happens to a message sent while a task runs.

**Other products** (research of 2026-10-26, paraphrased):
- **Grok Bot:** bots come back only when they need you; a new message can redirect work in progress; a stop ends the work without undoing finished actions; the sidebar shows needs attention, unread and working; approvals are cards; routines report to the conversation.
- **Linear's agent guidelines:** the first visible activity within 10 seconds; progress as activities that replace each other, not a transcript.
- **GitHub's coding agent:** reacts at once, applies a steering message after its current tool call, keeps finished work when stopped.
- **Claude Code projects:** quick questions answered in place, a card only for new work, Stop on each thread.
- **Slack's agent guidance:** set a status at once, post complete messages for long work.
- **Microsoft's agent approvals:** "suggest an alternative", which makes a new plan.

The common pattern: a cheap sign of receipt within seconds; complete messages; quick answers in place and a card only for background work; working state on a card code replaces; a small fixed set of states; follow-ups routed, never blocked; Stop on each task; approvals as cards; notifications for "needs you" and "done".

**Morrow today:**
- **The contracts assume token streaming.** An agent message is created `streaming` and ends `completed`, `failed` or `cancelled`, with text deltas in `MessageDelta` inside a `StreamFrame`. The Sunrise guidance appends text in place and turns Send into Stop.
- **Nothing delivers a message to a run yet.** No conversations or messages table exists; the HTTP build answers `not_in_build` for every conversation method; runs start from a one-minute cron; the screens have no live updates, only "Show new messages"; only the Inbox has a badge.
- **Some parts already fit:** the waiting strip, the docked question card also shown in the Inbox, read state per recipient, Flow-04's step card with its own Stop, "It keeps working meanwhile".
- **Constraints:** the system author writes no model text (ADR-0034 item 9); in an Ask, Morrow's teammate calls are read-only, with no hand-off and no agent card (ADR-0034 item 7, ADR-0037 item 3); notifications are fixed templates (ADR-0030 item 8); a new Durable Object needs its own record (ADR-0038 item 1); sessions end 30 to 35 minutes after the last input, and streams and polls never count as input; the api's session limiter puts every `/workspace/*` route under one key at 120 requests per 60 s per address.

This record is material under CLAUDE.md and ADR-0002: it changes a public contract, a lease source, capabilities and agent tools, data classes, the api's bindings, a deployment boundary (a Durable Object class), and credential custody (the VAPID key).

## Decision

1. **Complete messages; no token streaming to browsers.**
   - Every message is created whole and never changes afterwards: a person's message, an agent's message (a reply, a result, a question, a milestone finding, a card) and the system author's parts.
   - The provider's stream ends in the broker (ADR-0041 item 8). Nothing types itself out on screen.
   - Collaboration contract v1.2: `MessageStatus` keeps only `completed` for new messages; `MessageDelta` and `StreamFrame`'s `message_delta` retire; the `message` transitions give way to the delivery and request states of items 2 and 5.
   - Work in progress lives in the status line and on the request card, never in a message. Typing indicators ("Listings is writing…") and placeholder posts ("Looking at your shop knowledge…") go.
   - ADR-0016 item 5's accepted disclosure becomes: "a viewer of a shared conversation may learn that a request started there, and its state, teammates and times. A viewer never learns content, or a step, that they cannot see. A private Ask shows none of this to anyone but its owner, except through the audited admin read" (owner question 33).
   - `changes.json` records each change and `release-baseline.json` its hash.

2. **Write first, then deliver: the conversation inbox.**
   - **A post to an agent is one idempotent command**, keyed by the actor's `commandId`. A post is addressed to an agent when it is in your Morrow conversation, an @Morrow in a project conversation, a reply to a request (item 7), or a reply in a task thread a teammate owns.
   - **One transaction:** takes the request's row lock (item 8's order); runs the customer identifier screen (ADR-0041 item 31: a match is refused as `not_started: customer_data`, "Morrow can't keep customer details yet. Remove them and send again."); stores the message as `completed`; runs the reference, visibility and mention checks; writes one `conversation_inbox` row (ids and codes only) with the route code chooses (item 7); and, when the route starts or resumes a run, admits or wakes it (items 3 and 8).
   - **The api answers `202`** with the message id, its delivery state and its request id.
   - **Delivery states:** `delivered` (committed; an agent will read it); `read` (a run took it into a turn, recorded with the run and turn); `not_started` with a closed code: `no_credits`, `stopped`, `store_disconnected`, `agent_paused`, `customer_data`, `outside_scope`, `too_many_waiting`, `expired`, and the admission codes.
   - **The status line,** under the person's own message, rendered by code and changing in place:

     | When | Shows |
     | --- | --- |
     | still in the browser | "Sending…" |
     | offline, or the send failed | "Not sent · Retry" (same idempotency key) |
     | committed, not yet read | nothing |
     | waiting for a free slot (item 9) | "Starts when one of your requests finishes" |
     | read | "Seen by Morrow" (or the teammate's name in its own task thread) |
     | read, and no reply 10 s later | "Morrow is working on it · 12 s" |
     | still no reply when a measured p95 has passed, or unread after 60 s | "Taking longer than usual · Your message is safe" |
     | not started | "Not started", with the reason in plain words and Add credits or Send again |

     When a request gets a card (item 5), its line settles to "Seen by Morrow" and the card takes over.
   - **Nothing is dropped silently.** Every post addressed to an agent ends in exactly one of `read` or `not_started`. A row still unsettled after 7 days becomes `not_started: expired`.
   - **A plain message between people** has no inbox row and no status line.

3. **Runs start at once.**
   - **Admission.** When the route starts a run, the post command admits it in the same transaction (ADR-0041 item 7's first lease source).
   - **Starting it.** After the commit, the api calls `ApiRunStarter.start(runId)`: a `WorkerEntrypoint` on the orchestrator (ADR-0022 item 7's one-entrypoint-per-caller pattern) with two methods taking ids only, `start(runId)` and `hint(runId, waitSeq)`. Each re-reads SQL and checks that the run is admitted, leased and in the right state, then creates the Workflow instance (ADR-0041 item 6's id rule; "already exists" counts as success) or sends the `w-<waitSeq>` event.
   - **The api holds no Workflows binding,** so it cannot list, terminate, pause or restart a run. `edge:check` pins the api's service binding to `ApiRunStarter` and refuses a Workflows binding on every Worker but the orchestrator; `verify:boundaries` refuses any other use; the orchestrator stays unrouted (ADR-0022 item 6).
   - **Why it is safe.** Instance parameters carry ids only, and the start step re-enters the run's lease from SQL. An id that SQL never admitted ends at once. The one-minute cron stays as the safety net.
   - **Targets,** measured by T17 on staging and reported per release: "Seen by Morrow" within 6 s at p95, including the burst pause (item 7); a working request's screen updated within 1 s of a change while the live channel is up (item 15); Morrow's first reply (an answer, one question, or what it understood) at p50 and p95 set from measured `high`-effort latency, which the lead brings to the owner with the step-latency measurements of ADR-0041 item 35. The draft's 10-second target assumed a low-effort first turn, which ADR-0041 item 2 removes (the owner ruled out cheaper models, OD-2026-10-26-5; dropping `low` is ADR-0041 owner question 1).

4. **Morrow's first reply, then the work** (ADR-0041 item 5).
   - **(a) What code shows, free and at once:** the status line, and a request card once work goes to the background (item 5).
   - **(b) The main thread.** Your post is handled by a conversation run attached to Morrow's main thread, at `high` effort like every Morrow turn. Its first turn may use any read tool (`memory.search`, `memory.read`, `work.read`). It ends in one of three ways:
     - **an answer**, when the main thread can answer from knowledge, records and memory: the answer is the result, and there is no card;
     - **one choice question** (ADR-0034 item 7): the run ends there, and the tapped answer starts a new run;
     - **a background request**, through `run.plan` with `understood` and steps: code forks the main thread into the request's own job (ADR-0041 item 5), posts the plan, and the fork does the work. Teammate calls happen only in the fork (`fork_first` otherwise).
   - **(c) The plan's person-facing fields** (`run.plan`, Morrow only; ADR-0040's draft `job.plan` becomes these fields):
     - `understood`: 1 to 280 characters saying what Morrow understood, in its own words;
     - 1 to 6 steps, each a title of up to 80 characters and who does it: `morrow`, or a teammate id from the opening's code-built list (`unknown_teammate` otherwise).
     - No field takes a time, credits, a capability, a scope, a store or a recipient. The system text forbids times, credits and promises in `understood`; a T12 eval checks it.
     - **What it renders:** one message with the `understood` sentence plus a line written by code, "Asking Inventory and Business Analyst · about 4 to 8 credits" (the credit range by ADR-0034 item 2's method, shown to the person only; the model never sees credits). The steps sit behind the card's "Show steps". A later plan change reads "Morrow changed course: …". The screen never calls it a plan.
   - **(d) Credits.** The status line and the card are system writes and cost nothing. A quick answer costs one or two `high`-effort turns, mostly cache reads. A post the wallet cannot cover starts nothing ("Not started · Not enough credits", with Add credits); it never starts by itself when credits arrive, and Send again is a new act. A request already working parks when credits run out (ADR-0041 item 9, owner question 6).

5. **Progress is a request card that code keeps.**
   - **When a card appears:** when work goes to the background (`run.plan` in the main thread or a project, a teammate call or a hand-off), and for every proactive request and standing-request firing. A quick answer ends as the answer message plus "Seen by Morrow", with no card.
   - **`JobStatus@1`** is a per-viewer projection, rendered by code at read time, of the `jobs` row, the job's runs, `agent_calls`, `run_waits` and `RunEvent@1` (ADR-0041 items 4 and 36). It holds ids, codes, counts and times, never content. No model output sets it.
   - **What each viewer sees** is worked out from the steps and Inbox items that viewer can see: the reason words ("Waiting for Amina's approval"), the counts ("2 suggested changes") and the linked Inbox items. A viewer who can see no step gets the bare state word ("Working"), with no gap.
   - **The title** is the first line of the requester's opening post, up to 60 characters, rendered from that message under the viewer's visibility; otherwise a code label ("Request from Amina · 10:42"; "Daily pulse · 09:00"; "Every Monday: stock check"). The model never names a request.
   - **Activity:** one word at a time from a closed map of tool kinds ("Looking in shop knowledge", "Asking Listings", "Reading products", "Drafting changes", "Running analysis", "Writing the reply", "Checking the work"), each shown at least 4 s, with elapsed time and plan progress: "Working · Asking Listings · 3 of 5 steps · 12 min". Steps are collapsed by default ("Asking 2 teammates · 3 steps done ›"). There is no stop time: jobs run until done (ADR-0041 item 3). "Usually about N min" appears once T17 has measured it.
   - **States,** with Sunrise's badges; T7 adds Waiting, Paused, Not started, Stopped and Scheduled to the closed list, each with a glyph:

     | State | When | How it looks |
     | --- | --- | --- |
     | `not_started` | admission refused it | status line only |
     | `received`, `reading` | committed, or the main thread's first turn is in flight | status line only |
     | `queued` | waiting for one of the requester's 5 working slots | grey: "Starts when one of your requests finishes", with Stop |
     | `working` | a run of the request is running, or waiting on teammates | blue half fill: "Working · Asking Inventory · 3 of 5 steps · 12 min", with Stop |
     | `waiting` | blocked on someone or something else, including follow-through | grey with a glyph: "Waiting for Amina's approval · then: draft the announcement", "Waiting for the store to reconnect", "Scheduled · Monday 09:00" |
     | `paused` | parked by safety, credits or the provider (ADR-0041 items 9, 17 and 18) | yellow when it needs a person: "Needs you · Paused after 24 hours of work · Continue · Stop"; "Paused · out of credits · Add credits"; grey for "Paused · the AI provider is unavailable · retrying" |
     | `checking` | any operation of the request is submitted, uncertain or verifying | orange: "Checking · Shopify hasn't confirmed one change yet". It overrides done, stopped and failed while it lasts, and is never shown as done. |
     | `done` | the request completed and no outcome is unknown | green: "Done · 2 suggested changes to review", with "Open review" and "Used 6 credits" |
     | `stopped` | a person or a stop ended it | grey: "Stopped by you at 10:42", plus the end line |
     | `failed` | an error on Morrow's side or the provider's ended it | red: "Couldn't finish", the end line, "Try again" (a new act); failed requests are free |

   - **The end line** comes from the request's operation records, never fixed text: "Nothing in your store changed" only when no operation reached claimed; otherwise "1 change was made before it stopped"; plus "2 suggested changes still wait for review".
   - **Per viewer:** "Needs you" (yellow) while the viewer holds an open Inbox item or check-in the request raised; an unread dot until the viewer opens the request's newest message.
   - **No approve control** appears on a card or in a message: "Open review" only.
   - **Accessibility:** a polite live region announces only Needs you, Done, Couldn't finish and Stopped, and never moves focus; the half-fill badge stays still under reduced motion.
   - **Events.** Four additive EventEnvelope@2 rows, projections of `RunEvent@1` with ids and codes only: `job.created {conversationId, origin}`, `job.status_changed {from, to, reason}`, `job.step_changed {stepId, from, to}`, `message.delivery_changed {from, to}`. A request's events reach whoever can see its conversation, filtered per step as the card is; delivery events go to the post's author. The raw `seq` never leaves the server.
   - **Asks.** An Ask's request rows, steps, inbox rows and events are visible to its owner only, under RLS; an admin sees an Ask's cards only through the audited `ask_admin_read`, which counts them (ADR-0016 item 5).

6. **Results arrive as complete messages.**
   - **Which runs post.** A conversation run posts its reply in the main thread's conversation. A background request's run posts its result through `run.complete`'s reply (ADR-0041 item 16), in the conversation where the request was made. A hand-off run posts in its child task's thread. A teammate call run never posts: it ends with its TeammateResult and result items only.
   - **How.** Code posts in the run's terminal transaction, with the run's taint, read tags and audience. A reply longer than a text part's limit is stored as a document (a result item) and linked from a short message. When other messages came between the person's post and a result, code sets the result's `replyToMessageId` to the opening post ("Replying to: Which best sellers…").
   - **Every result message from a root or hand-off run carries a status part rendered by code at read time** from operation and proposal records ("1 change is still being checked"; "2 suggested changes wait for review"), so a model-written sentence can never stand alone against the records.
   - **What Morrow posts:** replies, questions, results, and milestone findings. It never posts step-by-step progress; the card does that.
     - **Milestone findings:** on a background request that has worked for at least 15 minutes, Morrow may post one short interim finding when code sees a plan phase complete ("6 at-risk products so far; checking supplier lead times now"): at most one per plan phase and one per 30 minutes per request (`milestone_too_soon` otherwise). The system text forbids claims that something was approved, applied or finished; a T12 eval fails any message asserting what SQL does not hold. Each carries the status part above.
     - When a post needs no reply ("ok", "great"), Morrow ends its turn with no message, and "Seen by Morrow" is the reply.
   - **The end-state pointer.** When a request reaches Needs you, Paused, Done, Couldn't finish, Checking or "Stopped by someone else" after its card has scrolled up, the system author posts a content-free `job_card` pointer at the bottom.
   - **Cards come as they do today:** plan and change cards (ADR-0034); agent cards (ADR-0037); suggested changes with "Open review"; choice questions, docked above the composer and in the Inbox; files as artifact parts with their sources.
   - **No message carries the customer tag before P09.T05** (item 17).

7. **Code routes follow-ups, never the model.** The composer never locks, and Send is always Send.

   | The post | Route |
   | --- | --- |
   | The requester posts in the same conversation before Morrow's first reply | **Joins** the burst (below); the main thread reads it at its next turn boundary |
   | A new message with no "Replying to" preview, in your Morrow conversation | To the **main thread**, which answers it or starts a new request beside your others |
   | A reply by the requester to a working request (the card's Reply, a quoted reply to one of its messages, or the preview), in that request's own conversation | **Steer** that request's open run (item 8) |
   | The same, when no run of the request is open | A **new run of the same request**, on its context, at once (item 8's race rule) |
   | @Morrow in a project | A **new request** with the poster as requester |
   | A reply by the requester of a teammate's open run, in the task thread that teammate owns | **Steer** that run under item 8's checks; while the run waits on its own question, the reply goes in with the answer |
   | A reply in a teammate's task thread when its run is not open | Treated exactly as a delegate mention: the author's live verbs with `delegate` on each capability, task conversations only, and ADR-0016 item 4's rate limits; a **new request** with the replying person as requester, never joining the original. Otherwise a plain post, with the hint "Ask Morrow to bring Listings back in" |
   | A post from anyone who is not the run's requester | Never delivered into that run, and never ends its wait. It enters a later run only as `other_member` data (item 13) |
   | A post in a different conversation from the request's own | Never delivered. A pointer's Reply opens the project conversation's composer |
   | A reply to a teammate's proactive message | A plain post, unless it mentions @Morrow |

   - **The "Replying to" preview** appears above the composer only while a request is working, and only when the person's last message in this conversation started it or replied to it: "Replying to: Which best sellers… · Stop · ✕". Sending with it on is a reply to that request; ✕ makes the next message go to the main thread. The server resolves the request id from the same conversation, the same requester and an open request, or returns `REFERENCE_NOT_FOUND`.
   - **Bursts.** The main thread's turn starts once the person has sent nothing new for 2 s, and at most 6 s after the first post; it takes in every undelivered post of the burst.
   - **What Morrow sees.** The main thread's state block, rendered by code and recited on change (ADR-0041 item 15), lists the requester's working and recently finished requests: the title (the requester's own words), the `understood` sentence as wrapped data with its taint, the state, the teammates and the times, with customer-tagged items left out. Morrow can therefore answer "how is the supplier research going?" from facts.

8. **Steering a running request, safely.**
   - **One lock order.** The post command, the turn step's delivery, stop and the finish transaction all take the request's row lock (`SELECT … FOR UPDATE`) first, then the inbox rows, then the runs. Whichever commits second sees the first.
   - **Delivery happens at the turn boundary.** Before each turn, inside its leased transaction, the run's turn step checks each pending follow-up:
     - its author is the run's requester, and it was posted in the request's own conversation (or in the child task's thread for a teammate run);
     - the author's membership is active, and they hold ADR-0034 item 8's grants (or the Ask-bound envelope, in an Ask) and live view of the subject;
     - the row is still `delivered`, and the message exists and is not redacted;
     - for Morrow, nothing in its quotes or attachments carries the customer tag (`customer_data`);
     - for a teammate run, the post's read tags fit the run's envelope (`outside_scope`: "Send as a new request").
     A follow-up that fails any check is marked `not_started` with its code and is never delivered.
   - **Then, for the follow-ups that pass,** the turn step marks them `read` with the run and turn; adds their read tags (quoted messages, attachments, referenced result items) to the run's before the turn is sent, since a run's read tags only grow; and appends them, after any tool results in the next user turn, as **user-role text blocks labelled by code** with the message id and author (ADR-0041 item 13). The requester's own words are not wrapped as untrusted data; a quoted message inside them is, with its taint. No system message carries a person's words. The turn is only appended to, and a replay reads the recorded turn input, so each follow-up is delivered once.
   - **A run never finishes over an undelivered steer.** The finish transaction checks for pending follow-ups under the request's lock; if there are any, it delivers them and the run takes one more turn.
   - **The race between a post and the finish.** The lock decides. If the post commits first, the finishing run delivers it. If the finish commits first, the post's own transaction admits a new run of the same request on its context, at once. There is no "next run" waiting to start.
   - **A follow-up wakes a waiting run.** A requester's follow-up ends a wait on calls, a timer, an idle turn or a detector trip, and resets the stall counters (ADR-0041 items 17 and 18). Morrow takes a turn: it may answer, change course (a `run.plan` update), forward the change to running teammates with `agent.message`, cancel calls the change makes pointless with `agent.cancel`, or make new calls; then it waits again for calls still open. A teammate's run waiting on its own question is not woken; the follow-up goes in with the answer. Other members' posts never wake a run.
   - **The lease source** (ADR-0041 item 7). The follow-up's post command, inside the person's session transaction, re-runs admission's checks and the next turn's credit hold, renews the request's envelope, re-issues the waiting run's lease, then calls `ApiRunStarter.hint`. The hint is only a hint; SQL is the truth. If any check fails, the post is `not_started` with its code and the run keeps waiting.
   - **Never across people or conversations.** A run's requester and envelope are fixed at admission; only its requester's posts in its own conversation reach it.
   - **Stop and steer.** If a stop and a steer race, either order leaves the steer unread, and the stop marks it `not_started: stopped` ("Send as a new request").

9. **Several requests at once.**
   - Requests run in parallel, each its own job with its own context (forks of the main thread, or project jobs). Within a request, Morrow uses teammates in any way at depth 1 (ADR-0037 item 3, ADR-0041 items 21 and 22).
   - **A waiting line, not a refusal.** At most 5 requests per person per workspace work at once. A sixth is admitted with its first credit hold where any request is: in the person's own post transaction (a project request), or in the step where Morrow forks the main thread for it, under the envelope the person's post admitted (ADR-0041 item 7's table). It shows "Starts when one of your requests finishes" with Stop, and starts when a slot frees through `agent_run_resume`, which re-runs admission's checks. A request still waiting after 24 hours becomes `not_started: expired` ("Send again"). As a safety bound, at most 20 requests per person wait in line; beyond that, `not_started: too_many_waiting`.
   - **Limits, checked in code, catalogue data changed only by a new version:**

     | Limit | Value |
     | --- | --- |
     | Requests working at once per person per workspace | 5, then a waiting line of up to 20 |
     | Waiting in line | up to 24 hours |
     | Burst pause | 2 s after the last post, at most 6 s after the first |
     | Teammate runs per request | 32 per envelope, then a check-in and Continue (ADR-0041 item 21) |
     | An unsettled inbox row | `not_started: expired` after 7 days |
     | Morrow runs per request | one running, by a partial unique index; one context per (request, agent) |

   - Credits bound everything else; each run holds and draws from the wallet (ADR-0039).

10. **Stopping and redirecting a request.**
    - **Where Stop sits:** on the request card, on each running step inside the expanded card, and in the "Replying to" preview. On phones each card has one Stop. There is no Stop in the composer.
    - **`workspace.job.stop`:** `internal_write`, `human_only`, not review-required, no second approver; never in an agent's grant set or on an agent card, and no tool proposes it. **Its check needs only** an active membership and being the request's requester (or, for a proactive request, the installation's owner; for a standing request, its signer). A stop only narrows work, so it does not depend on other grants: a requester whose posting grant was revoked can still stop their own request. In an Ask only its owner may stop a request. No template version issues it.
    - **One transaction** ends the request's open runs at their next step (running, parked, or waiting in line), stops their open children, marks undelivered posts `not_started: stopped`, and records who stopped it. A model call already in flight finishes and is metered, and its tool calls never begin.
    - **What a stop leaves alone:** a claimed gateway operation still finishes and reconciles; finished work and pending suggested changes stay; the end line says what happened. A request a person stops draws the credits it used (OD-2026-10-26-2).
    - **Stopping one step** returns `stopped_by_person` to Morrow for that call, and Morrow carries on with what it has.
    - **A workspace stop for the Owner and Admins** (P11.T05, or a lettered slice in PR 12a if it lands first): `human_only`, no second approver, a reason, an audit record and an owner notice (ADR-0005). In one transaction it ends every open run in the workspace, waiting lines included, and blocks admissions, follow-up wakes, resumes and standing-request firings. **Lifting it is a reviewed reversal under ADR-0005:** a solo owner uses the typed phrase and the cool-down; in a team a second member who did not set it approves; it is audited and the owner is notified. Each card it stops reads "Stopped by Amina", with her reason. `edge:check` refuses the switch until it exists. Owners and Admins do not stop other people's single requests: they have no live view of other people's Asks, and the workspace stop, "Stop AI work" and pausing an agent cover what matters.
    - **Morrow's own calls:** `agent.cancel` (ADR-0041 item 21) only narrows work and is not a kill switch. When a follow-up changes course, Morrow forwards the change to running teammates or cancels the calls it makes pointless; when a follow-up asks to stop, Morrow cancels its calls, replies in one line and completes, and the card keeps the person's Stop.
    - **Existing stops stay:** "Stop AI work" (ADR-0005), pausing an agent (ADR-0005), revoking a mandate (ADR-0024 item 4), revoking a standing request (item 12), "Stop this project's steps" (ADR-0033 item 11).

11. **Who you talk to.**
    - **Your Morrow conversation is your Ask.** Each person has one current, private conversation with Morrow in each workspace. ADR-0016 items 3 and 5 still apply, with ADR-0041 item 33's named harness writes; `AskPrivacyNotice` stays pinned and says exactly what an admin read covers (messages, not memory suggestions, checkpoints or plans).
    - **Morrow remembers it.** The conversation is backed by Morrow's main thread (ADR-0041 item 5): one continuing, compacted memory, private to you, rebuilt from records you may still see whenever your access narrows (owner question 12).
    - **First open:** Morrow's character, one sentence ("Tell Morrow what you want to get done. It answers, or gets your team on it.") and three starters drawn from the shop.
    - **Start fresh** opens a new conversation (and a new main thread) when nothing of yours is working in the current one. Earlier ones stay under "Earlier conversations".
    - **One sidebar entry.** "Ask Morrow" becomes "Morrow", first in the sidebar, bold when unread, with a neutral count chip and a status word. Team › Morrow opens the same place. `workspace-routes.json` gains the `morrow` destination.
    - **Recent.** A Recent list with "Working now" and "Done" filters lists your requests; opening one scrolls to it. There is no separate Jobs view; Home's Today keeps the schedules.
    - **Nothing runs in it before P05.T04b.**
    - **Morrow's tools there** follow ADR-0041 item 33: read-only teammate calls in forks, no hand-off and no agent card; `run.plan`, `run.wait`, `agent.message`, `agent.cancel` and `memory.suggest` are added.
    - **Work that changes the store, or that a teammate must own,** goes through Morrow's plan card and one tap on Start (ADR-0034 items 5 and 6) and runs in a project (owner question 32). The request's card posts in the project; the system author posts a `job_card` pointer in the person's Morrow conversation, rendered for that person only, which follows the request live, docks any question it raises for that person (answering in either place resolves both), and shows the result summary and "12 suggested changes · Open review". A post in the Morrow conversation never reaches a project run.
    - **Optional layout** (owner question 34): in the Morrow conversation only, your own messages sit on the right on a light warm-grey surface, with no coloured bubble and no emoji; agents stay on the left with their character. Projects keep left-aligned rows.
    - **Project conversations:** @Morrow and "Plan next steps" go through the inbox like any post, each starting a request with a fresh context compiled from what the poster may see (ADR-0041 item 26). Everyone who can see the project sees its request cards under item 5's per-viewer rules.
    - **Teammates.** Teammate threads are a hand-off's child task thread and the thread of each step task. The Team list shows each teammate's status word only. "Message Listings" opens the Morrow conversation with "For Listings:" filled in; Morrow calls Listings, and its reply carries a code-rendered "Asked Listings" line with Listings' character. Morrow writes that message, so Listings is never shown as its author. Teammates speak to people through Morrow or their own task threads; a free-standing direct conversation with a teammate would let a teammate own a person's conversation outside a task, which ADR-0037 rules out.

12. **Proactive messages: standing requests for Morrow, and teammates' own work** (amends ADR-0027 item 8 and ADR-0034 answer 4, on ADR-0024's pattern; owner question 30).
    - **A standing request** is a person's own request on a schedule: "Every Monday, check which best sellers will run out in the next two weeks."
      - **Created by the person.** Morrow drafts a standing-request card (`StandingRequest@1`: the person's own words, filled by code; a schedule from a closed cron subset with a time zone; an expiry). Confirming it opens a server-built document bound to the actor, a standalone-workspace session and the card's digest, valid 5 minutes, consumed once.
      - **Each firing** writes one server-held trigger row; only `admit_standing_request_run` (ids-only, executable only by `morrow_runtime_executor`) admits a run from it (ADR-0041 item 7). The orchestrator's timer never admits directly. One firing per schedule slot.
      - **The requester is the signer,** checked under live grants when it fires; if they lost them, the firing is skipped and they are told. It ends on membership end or grant loss, and expires after 90 days unless renewed (a new document).
      - **It posts only in the signer's own Morrow conversation,** as a background request forked from the main thread at its last completed exchange, so it starts with the conversation's memory. It never loads other members' Asks or their person memory.
      - **What it may do:** read-only, plus suggestions (a plan card with Start, a finding), until a later record. Every store change still needs a person's Start and approval of the exact change.
      - **Stops.** `workspace.standing_request.revoke` (`human_only`, not review-required, held by the signer and the Owner; agents may only propose it, as `workspace.routine.revoke`) and a Pause on its card. The workspace stop and "Stop AI work" block firing.
      - **Credits** are held at admission; a firing the wallet cannot cover stays pending until the balance covers it, never dropped (ADR-0024 item 6), and lapses at the next firing. A firing inside the signer's quiet hours runs, and its notification waits until they end.
      - At most 10 active standing requests per person, as a safety bound.
    - **Follow-through** (ADR-0041 item 17). A request whose plan waits on an approval, the gateway's read-back or a time shows "Waiting for your approval · then: draft the announcement", and continues by itself within its envelope when that resolves, posting in the conversation where it was asked.
    - **Teammates' proactive work** (ADR-0024, behind G10): a mandate run posts its card and results, as its agent, in that agent's Everyday work area conversation; a routine or watch set up from a conversation records that conversation as `report_to` (set by code from the plan start, never from text) and each run posts a system `job_card` pointer there; a finished proactive request that needs the installation's owner posts a content-free pointer in that person's Morrow conversation (a system post, not Morrow checking in); look-for-work suggestions appear in the area conversation and Home's Ideas, never in a private Ask; questions and approvals go to the Inbox.

13. **Conversation memory and whose words are whose** (ADR-0041 items 5, 13, 25 and 26).
    - **Your Morrow conversation** is remembered by its main thread; **shared threads** by a compiled view at each request (pinned knowledge and person memory within their budgets, indexes, verified summaries of older parts, the code-rendered ledger and a verbatim tail).
    - **Every post stores** its author, `read_tags`, `context_taint`, audience and the run that wrote it, computed in code.
    - **Whose words are whose** (amends ADR-0027 item 5):
      - only the requester's own posts are given as the requester's words, as user-role text;
      - every other member's post is wrapped as data that names its author and marks the run with the taint kind `other_member`. That taint flows into every card, brief, call, hand-off and proposal; the review card lists the post as a source; and its author joins the proposal's conflict set (ADR-0041 item 32);
      - an agent's post carries its stored taint; system parts are code text;
      - a non-requester's reply to a request's message never takes that request's `job_id`.
    - **Person memory** (ADR-0041 item 29): when you say "remember …", Morrow suggests a memory as a Save card that only you can see; nothing is saved without your tap. Settings › Memory lists, edits and deletes them. "Used 2 memories" under a reply is shown only to you.

14. **Reading, feedback, quotes, files and drafts.**
    - **Unread.** `conversation_reads` holds each member's last-read position per conversation. Counts are computed per viewer over the messages that viewer can see, so a hidden message never shows in a count. Two places carry counts: the Inbox's marigold pill for decisions (ADR-0032) and Morrow's neutral chip for unread messages. Teammate rows show a status word only. The tab title shows "2 need you" first, then unread. The app-icon badge comes with the web app manifest (item 16).
    - **Read marks.** An agent's read shows on the person's message as "Seen by Morrow". People's read positions are private to each person; there are no read marks between people.
    - **Feedback.** Two marks on agents' messages only, "Thanks" and "Not helpful", each an icon with a word. A mark never starts, steers, answers or approves anything, is never authority and never enters a run's context; marks reach evals as ids and codes only. "Not helpful" offers "Tell Morrow why", which is an ordinary post.
    - **Quoted replies** use `replyToMessageId`; code renders the quote at read time under the viewer's visibility (none if the original is hidden). In a run's context the quote is rendered under the requester's read tags with the original's taint, and its tags join the run's.
    - **Files** keep ADR-0029's and ADR-0031's rules; agents' files are result items or artifacts linked from the result message.
    - **Drafts and the outbox** of unsent posts are kept in browser storage per principal and workspace, as text only. They are purged on sign-out, on detected session expiry and when a different principal signs in, and a draft that the published identifier patterns flag is not kept.

15. **Live delivery to the browser: the live channel** (amends ADR-0038 item 1 and ADR-0022 items 6 and 7; owner question 27).
    - **The object.** `LiveChannel`, a SQLite-backed Durable Object class in the api Worker, one object per (workspace, principal), named on the server from the session's ids, never from the client. Hibernatable WebSockets. Its storage stays empty; hibernation attachments hold the session id and expiry only. One alarm, to close sockets when their session expires.
    - **The upgrade.** `GET /workspace/:ws/live` on the api, authenticated with the same-origin `__Host-` session cookie and an exact Origin check, never a token in the query string. The api passes only server-derived values (workspace, principal, membership, session, expiry) to the object, in headers it sets after removing any the client sent.
    - **Hints, not content.** In the same transaction as each change, SQL writes `live_outbox` rows naming each principal who can see it, by item 5's per-viewer rules (an Ask's activity names only its owner). After commit, the Worker that committed publishes them through an ids-only RPC on the object's namespace, bound by `script_name` in the orchestrator and the connector; the one-minute cron re-publishes anything unsent. A hint carries only a per-viewer nonce. The client never renders a hint: it pulls through the sealed changes read below.
    - **Closing.** Sockets close on sign-out, on any membership or grant change for that principal, and when the session idles out (30 to 35 minutes). A socket never counts as activity and never rotates the session. Connections and messages per principal are capped.
    - **The changes read stays the standard pull, and the fallback.** `GET /workspace/:ws/changes?after=<sealed position>` runs one short read-only transaction and returns, for the viewer only, the conversations whose unread count or attention changed, the requests whose state changed, the Inbox count and a new sealed position. It answers "unchanged" whenever the viewer's filtered set is empty; the response has the same shape and size whether or not hidden activity happened; no fast path depends on activity the viewer cannot see; the position is re-sealed with a fresh nonce every time; more than 200 visible changes returns `reset`. While the socket is healthy the client polls every 60 s as a liveness check; when it is down, every 2 s while a working request is on screen, every 30 s otherwise, never while the tab is hidden, at once on focus, reconnect and after its own command, with back-off on `429`.
    - **Limiter keys.** `session_changes` and `session_live` have their own budgets; request Stop, the workspace stop and the kill switches move to `session_stop`, which polling cannot use up. All fail closed.
    - **Tests:** `lab:visibility` (activity in A's Ask sends no frame and no change to B), `edge:check` (the class, its binding, the migration and the `script_name` publishers pinned; refused anywhere else), `lab:edge-workers` (an upgrade without the cookie or with another Origin refused).
    - CLAUDE.md's stack line gains "Durable Objects (ADR-0038, ADR-0040)" with the follow-up PR.

16. **Notifications** (amends ADR-0030 item 8, ADR-0007 item 2 and ADR-0031 items 1 and 7; owner question 28).
    - **The policy, in code.** "Needs you" (a question, an approval, a check-in, a paused request) notifies at once; "Done" (a request you asked for) notifies when you have not seen it within 2 minutes; findings you did not ask for (look-for-work ideas, teammates' routines) never notify and appear in counts and the daily summary. A member gets at most 6 pushes an hour, and nothing during their quiet hours (sent when they end).
    - **Web Push, at launch:**
      - the VAPID private key is a broker secret the owner places with `wrangler secret put`; signing and RFC 8291 encryption happen only in the broker, with a rotation runbook;
      - push endpoints must be `https` on an allowlist (`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`); any other endpoint is refused;
      - endpoints and their keys are capability secrets: stored in FORCE RLS rows readable only by the broker's role, never returned to a client or written to a log;
      - payloads are empty: the service worker fetches the counts with the session and shows a fixed template ("Morrow · 1 finished · 2 need you");
      - each subscription is bound to (workspace, principal, membership, device), and deleted on sign-out (the client also calls `unsubscribe()`), at membership end, at erasure and on a 404 or 410 from the push service;
      - the member's view is re-checked at send time; each send has one delivery key, and an uncertain send is never resent with a new key (ADR-0030 item 8);
      - the service worker never caches authenticated responses;
      - the push services go into `data-regions.json`; a web app manifest comes with it (an iPhone receives push only after "Add to Home Screen"), and with it the app-icon badge;
      - tests: a subscription from another principal refused, an endpoint off the allowlist refused, sign-out deletes the subscription, a push to a member who lost view not sent.
    - **Email, after G7,** as ADR-0030 item 8 templates (counts, kinds, dates, the workspace name and links, never model output): one batched email for what is still unseen after 15 minutes, at most one an hour, none during quiet hours; on by default and switchable off. Approvals keep ADR-0024 item 10's 4-hour email.
    - **Settings › Notifications** shows the rows "Needs you", "Finished requests" and "Ideas and routines", each with in-app, push and email, and quiet hours.
    - The Shopify admin's embedded home is unchanged.

17. **Data.**
    - **New tables and columns,** each a forward migration in or after P07.T03, FORCE RLS, listed in S7 and S8, each with its deletion handler and lab rows in the PR that first writes it (G9):

      | Table | Holds | Who reads it | Kept |
      | --- | --- | --- | --- |
      | `messages` (P07.T03), new columns | `job_id`, author, `read_tags`, `context_taint`, audience, `origin_run_id`, post kind; status `completed` only | the all-of message rule and audience | as threads are (ADR-0031 item 1) |
      | `conversation_inbox` | per post to an agent: message, author, target, request, route, delivery state, run and turn, codes, times; no text | the author and the runtime definers; an Ask's, its owner only | 365 days; unsettled after 7 days settles `not_started: expired` |
      | `jobs` | the request row: conversation, requester, origin, state, opening and result message ids; no text | viewers of the conversation's subject; an Ask's, its owner only, admins through `ask_admin_read` | 365 days after the request ends; then the card reads "Details no longer kept" |
      | `conversation_reads` | member, conversation, last-read position | that member only, no admin path | while both exist |
      | `message_feedback` | message, member, code | that member; evals as ids and codes | with the message; deleted on member erasure |
      | `notification_preferences` | member, kinds and channels on or off, quiet hours, last-sent times | that member | deleted with the member |
      | `push_subscriptions` | member, device, endpoint and keys | the broker's role only | until sign-out, membership end, erasure or a 404/410 |
      | `live_outbox` | change id, audience principal ids, sent state; no content | the publishers' definers | 7 days |
      | `standing_requests`, documents and trigger rows | the signer, the person's words (content), schedule, status, expiry; trigger rows ids only | the signer and the Owner; trigger rows the runtime definer | 90 days after it ends; documents 24 hours after use or expiry |

    - **Customer data in messages.** Until P09.T05's deletion path and a `customer_redact` handler for messages pass, no message carries the customer tag: ADR-0041 item 31's screen refuses such posts, and a Support run's customer-tagged output stays a result item under ADR-0037 item 8, linked from a content-free message. The PR that first writes a customer-tagged message registers `messages` as `content: customer` with `customers/redact` matching.
    - **Erasure.** `redaction.ts` gains handlers for inbox authors, request rows, feedback, read positions, notification preferences, push subscriptions and standing requests.
    - **Order.** P07.T03's conversations, messages and `conversation_inbox` come in a migration before PR #64's agent-runs migration, so `agent_runs.source_inbox_id` can reference the inbox row; otherwise that column lands without its foreign key and a forward migration adds it.
    - **Tenancy.** The tenant comes from the session or the lease, never from an id the client sends. Positions are sealed per viewer. Message text lives only in `messages`, run content only in ADR-0041's content tables; Workflow parameters, events, queues, entrypoint calls, hints and logs carry ids and codes only.

18. **What this replaces, the screens, the switches and the order.**
    - **Replaced:** harness row 21; the Sunrise "Streaming", "Run strip" and "Send becomes a labelled Stop" patterns, by the status line, the request card, an always-on Send and an open-requests strip above the composer ("2 working ›", which opens a sheet listing each with Stop; a docked question takes its place); the "Listings is writing…" and "Looking at your shop knowledge…" placeholders; "Show new messages", by the live channel and a "New messages ↓" pill; the contract's streaming parts.
    - **Screens.** While the switch is off, the Morrow composer is disabled with a truthful line. Not-started reasons reuse the EmptyStates board's words. A failed request reads, for example, "Couldn't finish · Nothing in your store changed · 2 suggested changes still wait for review". On phones Morrow is a bottom-bar tab with its count (Team moves under More), opens full screen, the open-requests strip collapses to one line, and per-step Stop appears only inside the expanded card.
    - **Switches,** each committed off and turned on by one reviewed commit: `async-conversations` (after the agent-loop switch, the plan-drafts switch for Morrow, ADR-0034 item 10, and the workspace stop; `edge:check` refuses it otherwise), `live-channel`, `web-push`, `standing-requests`. If the `ApiRunStarter` binding is missing, the cron starts runs.
    - **The order** is in `docs/plan/harness-foundations-implementation.md`: contracts with fakes; P07.T03's data; the loop's delivery, waits, stop and forks (PR #64 and ADR-0037 PR 4); Morrow's main thread (ADR-0037 PR 5 with PR 12a); `ApiRunStarter`, the inbox and the workspace stop slice; the live channel; the screens (PR 12b); notifications; standing requests (with PR 21).

## Security invariants touched

None is weakened. The one widened residual, renewable leases inside an absolute envelope, is ADR-0041 item 7's; every lease source this record uses is in its table.
- **Tenant isolation (FORCE RLS; no client-supplied ids):** every new table is FORCE RLS; the post, changes, live, stop and standing-request routes take the workspace from the session; the "Replying to" request id is resolved by the server; positions are sealed per viewer; the live object's name and every value it holds are derived on the server; `conversation_reads` has no admin path. Tests: `lab:tenant-conformance`, a new `lab:conversation-inbox`, `lab:visibility`.
- **The intersection, checked in code at every tool call:** unchanged. A steer changes no requester, envelope or grant; only the requester's posts in the request's own conversation reach a run, each re-checked at delivery; other members' posts are tainted data and never wake a run; a teammate-thread reply needs the author's own `delegate` verbs; a standing request runs under its signer's live grants; feedback marks and quotes are never authority; `agent.cancel` only narrows. New `lab:agent-authority-workers` rows: another member's reply never reaches or wakes a run; B's post taints A's next run and A's proposal lists it; a follow-up after removal or revocation is `not_started`; a post in an Ask never reaches a project request; a quote with a wider tag widens the run's tags; a call run's final text never creates a message; a standing request skipped after its signer lost grants.
- **Digest-bound approvals and the one gateway:** unchanged. No message, card, mark, hint, push or reply approves anything; a redirect never edits a proposal; an `other_member` source's author is conflicted (ADR-0041 item 32). Tests: `approval-records.test.mjs`, `lab:approval-records`, `collaboration-contracts.test.mjs`.
- **Permission and budget checks in code, outside prompts:** routing, the waiting line, the limits, milestone rate limits, the notification policy and every hold live in SQL and code; `run.plan` takes no time, credits, capability or recipient; the model never sees credits. Tests: `lab:run-credits`, `tool-catalogue.test.mjs`.
- **Unknown outcomes reconciled, never promoted:** a request with an uncertain operation is `checking`; the end line and the status part come from operation records; a stop never re-runs or abandons a claimed operation; posts are idempotent per actor; `ApiRunStarter.start` treats "already exists" as success; hints are hints; one delivery key per push. Tests: `lab:agent-runs`, `lab:conversation-inbox`.
- **Credentials only in the broker:** the VAPID key is a broker secret and push encryption happens in the broker; `ApiRunStarter` and the live channel carry ids only. Tests: `verify:boundaries`, `edge-config.test.mjs`.
- **Default deny:** every switch committed off; `edge:check` pins the `ApiRunStarter` binding, refuses a Workflows binding on the api, pins `LiveChannel` and its publishers, and refuses the async switch until the workspace stop exists; the changes read and the live upgrade fail closed; stops have their own limiter key.
- **Kill switches are `human_only`, with no second approver, and agents only propose them:** `workspace.job.stop`, the workspace stop and `workspace.standing_request.revoke` are `human_only`, never granted to an agent; lifting the workspace stop is a reviewed reversal. Tests: `stops.test.mjs`, `policy.test.mjs`.
- **No agent-initiated external effect before G10:** proactive work speaks only in messages and cards; mandate admission stays off until G10; standing requests are read-only plus suggestions.
- **Customer data only after its deletion path:** the identifier screen on every post and model-written text; Morrow's contexts and listings leave out customer-tagged items; request, inbox, live-outbox and push rows hold no customer data; pushes are content-free. Tests: `lab:retention`, `lab:visibility`, `lab:shopify-privacy`.
- **Immutable migrations:** PR #64's migration is unapplied; everything else is a forward migration. Test: `migration-history.test.mjs`.
- **Asks stay private:** an Ask's request rows, steps, inbox rows, events, hints and changes reach its owner only; admins see its cards only through the audited read, which omits memory suggestions, checkpoints and plans; only its owner may stop a request there; the activity log and daily summary leave out other members' Asks.

## Consequences

- **It feels like messaging a team.** "Seen by Morrow" within seconds; quick answers in place; background work on a card that updates within a second; results as finished messages; phones notified when something needs you or is done; Morrow checking in on what you asked it to watch. Not taken from dots: calls and text messages.
- **Code:** contracts v1.2, `JobStatus@1`, the event rows, `workspace.job.stop`, `workspace.standing_request.revoke`, the routes and switches, with fakes; P07.T03's data and the new tables; in PR #64 and ADR-0037 PRs 4 and 5, the delivery, waits, forks and stop cascade of ADR-0041; `ApiRunStarter`, the limiter keys and the workspace stop slice; the live channel; the polling fallback; Web Push and its service worker; standing requests; the screens. PR 12 grows from M to L and splits in two (12a backend, 12b screens).
- **Cost.** Morrow's first reply is a `high` turn, mostly cache reads in a warm conversation: about US$0.05 to 0.20 for a quick answer. System writes, hints and pushes cost no credits. The live channel costs almost nothing while idle (hibernation) and avoids a Neon read every 2 seconds per open tab; polling at 60 s remains as a liveness check.
- **Project runs will often be tainted.** Any other member's post in a run's compiled view marks it `other_member`, and its author cannot approve the resulting proposal. That is the honest account of whose words shaped a change.
- **Latency risk.** The first reply depends on a `high`-effort turn and on the orchestrator's distance to the database; ADR-0041 item 35's measurement and remedy cover both, and the lead brings the measured targets to the owner.
- **Residual risks.** Injected text in a shared thread reaches later runs only as wrapped, tainted, attributed data. Parallel requests spend a balance faster; credits, check-ins, Stop and the workspace stop bound it. Push services see only empty tickles and endpoints.
- **Schedule.** Until this record is accepted, nothing that depends on it merges. The G11 checkpoint (W4) does not depend on it: its demo can use `listings-run@1` (ADR-0027, Consequences).

## Alternatives considered

- **Keep streaming and a Stop composer (today's contract).** The owner asked to leave it.
- **Row 21: one open Morrow run per thread, posting paused.** It blocks the person while a request runs.
- **Every new message redirects the running request, as Grok does by default.** It mixes unrelated requests. Routing in code through Reply and the preview is visible and certain.
- **Every new message waits in line.** Quick questions would wait behind long requests.
- **Morrow routes follow-ups between requests.** It would cost a turn per message, and model output would choose where a person's words go.
- **A low-effort first reply, or a second small model to acknowledge.** The owner ruled out cheaper models (OD-2026-10-26-5), which ADR-0041 reads as ruling out lower effort too (its owner question 1); code gives the instant receipt instead.
- **A next run admitted while the current run is on its final turn** (the first draft). There is no final turn any more; the post-versus-finish race is settled by the request's lock.
- **Refusing a sixth working request** (the first draft). It stopped work for a reason other than safety or credits; a waiting line admitted in the person's own act does not.
- **Polling only, with the live channel later** (the first draft). Two-second polling keeps Neon awake, costs a query per tab, and still lags; the live channel is the production design and polling stays as its fallback.
- **One live object per workspace.** One per (workspace, principal) isolates viewers by construction.
- **Server-Sent Events or long polling from a Worker.** There is nothing to subscribe to (Neon's pooled endpoint has no LISTEN), so the database load equals polling, and long requests are cut on deploys.
- **Morrow never checks in** (the first draft). The products the owner pointed to do; a standing request, created by the person and run under their live grants, gives it safely.
- **Model-written progress posts.** Chatter that can contradict the records; milestone findings under code rules carry the substance.
- **Push payloads with content.** They would pass through Google, Apple and Mozilla and show on lock screens.
- **A Workflows binding or a Queue producer on the api for run starts.** The first exposes terminate, pause and restart to the internet-facing Worker; the second adds batching delay. `ApiRunStarter` exposes start and hint only.
- **Admins stopping other people's single requests.** Admins cannot see other people's Asks live, and ADR-0016 gives the admin grant no command over them.

## Review of this record

Two AI reviews (separate context, same model family) read the first draft (security, product and UX lenses), and three more read it with the four area designs (security, state of the art, feasibility). Their findings that touch this record are taken, as ADR-0041's "Challenges taken, adapted and rejected" maps, with these notes:
- **"Add to [request]" on your own message (UX) is not taken.** Morrow sees a message within seconds, so the control would rarely be usable; Reply on the right card steers.
- **Morrow's reply to "Message Listings" shown as Listings' (UX) is changed** to an "Asked Listings" line, because Morrow wrote it (ADR-0037 item 3(a)).
- **"Advance the sealed position only past visible changes" (security) is met another way:** every response is re-sealed with a fresh nonce and has the same shape and size.
- **The first draft's low-effort first reply, polling-only delivery, "Morrow never checks in", final-turn next run, turn-adding follow-ups and stop-time copy are removed** (state of the art and feasibility, high).
- **Follow-ups go in as user-role text labelled by code,** not as wrapped untrusted data and never as a system message (state of the art and feasibility, medium; security, high).
- **Only the requester steers, and other members' posts never end a wait** (security, high).
- **The live channel and Web Push are decided here with the security review's conditions** (security, high), with one object per (workspace, principal) rather than per workspace (feasibility, medium), because isolation then holds by construction.
- **Customer details typed into a post are refused before P09.T05** (security, high), except order numbers, which are not customer data (ADR-0041 item 31).

## Owner questions

Each is one item on the combined decision sheet, Q-adr-0040-0041-owner-questions in the project graph, which also holds ADR-0041's questions and gives each with its recommendation and why; the numbers are the sheet's.

- 12. One Morrow conversation per person that Morrow remembers, with Start fresh (items 11 and 13).
- 23. Customer details typed into messages are refused for now (item 2).
- 24. Should Morrow work like messaging a team of agents, as this record describes?
- 25. Where does a message go if you write while a request is working? (item 7)
- 26. Five working requests per person, a waiting line beyond, a 2-second burst pause (item 9).
- 27. Live updates through a live channel at launch, with polling as its fallback (item 15).
- 28. Reaching you when you're away: phone and desktop notifications at launch, email after G7, and the notification policy (item 16).
- 29. Read marks and feedback (item 14).
- 30. Messages agents send on their own: standing requests for Morrow, and teammates' routines (item 12).
- 31. Who may stop a request, and how the workspace stop is lifted (item 10).
- 32. Where store-changing work runs (item 11).
- 33. What other people can see in shared projects (item 1).
- 34. Your messages on the right (item 11).
- 35. Milestone findings on long requests (item 6).

## Approval left for the owner

This record is Proposed. The owner's message of 2026-10-26 (quoted under Context, OD-2026-10-26-4) asks for this behaviour and invites architecture changes; it does not approve this text.

What it approves: conversations that work like messaging a team of agents, where the agent receives a message at once and answers with what it understood, what it is doing, or the result, instead of a streamed reply with a Stop button. What it does not approve: this record's text, values and trade-offs, each put to the owner on the decision sheet.

**What approval would be.** The owner's statement in chat, recorded verbatim with its OD number. For example, "approve ADR-0040 as recommended" would approve this record as written and each of its owner questions with its recommendation.

**Until then, nothing that depends on items 1 to 18 merges:** contract v1.2, the new tables, capabilities and tools, `ApiRunStarter` and the api's bindings, the live channel, Web Push, standing requests and routing. Work that ADR-0041 already covers, such as run lineage in PR #64's migration, follows ADR-0041's approval.

**What else changes with this record:** CLAUDE.md's stack line (Durable Objects, item 15), with the follow-up PR after approval. No new model provider comes with it; the browsers' push services are recorded as processors in `data-regions.json`.
