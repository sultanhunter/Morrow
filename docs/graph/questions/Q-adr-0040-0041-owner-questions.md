---
id: Q-adr-0040-0041-owner-questions
type: question
kind: decide
title: "The combined decision sheet for ADR-0040 and ADR-0041: 35 questions, each with the lead's recommendation"
status: open
asked_of: owner
links:
  raised_by: [ADR-0040, ADR-0041]
  about: [ADR-0040, ADR-0041, ADR-0039, F-agent-loop, F-coordinator, F-model-and-effort, F-inbox-and-notifications]
---

ADR-0041 (harness foundations) and ADR-0040 (messaging with agents), both Proposed on 2026-10-26,
carry out the owner's four messages of that day (OD-2026-10-26-3 to OD-2026-10-26-6). Those
messages set the direction; they do not approve the records' text, values, security trade-offs,
money rules or retention clocks. Each of those is put to the owner below with the lead's
recommendation. Questions 1 to 23 are ADR-0041's (12 and 23 are shared with ADR-0040), and 24 to 35
are ADR-0040's.

Approval would be the owner's statement in chat, recorded verbatim with its OD number. For example,
"approve ADR-0040 and ADR-0041 as recommended" would approve both records as written and every
question below with its recommendation. Until then nothing that depends on them merges
(`docs/plan/harness-foundations-implementation.md`).

1. Every agent runs Claude Opus 5.5: Morrow at high effort, every teammate at medium. Haiku and
   Sonnet leave every catalogue, Listings' included (your message about Haiku, OD-2026-10-26-5).
   Should low effort go too, and should the Owner still be able to raise a single teammate to high
   effort (and later extra-high), but never pick a lower effort or another model?
   - Recommended: Yes to both. Drop low effort everywhere, and keep the per-agent picker with Opus
     5.5 at medium or high only; extra-high and max come later, once tests show they help.
   - Why: It follows your rule of no cheaper models for paid users, which this reads as covering
     lower effort too, and still lets you give a hard-working teammate more thinking. A change
     applies from the agent's next job, so a running job never switches model mid-way. (ADR-0041
     item 2; amends ADR-0027 item 12 and ADR-0036 item 1.)
2. Jobs that run for hours need their permission slip renewed as they go. Should each running job
   renew its 30-minute lease at every step, after re-checking the requester's permissions, the
   agent, the rules and any stop, inside an outer limit of 24 hours of active work or 7 days, after
   which only the person who asked can let it continue?
   - Recommended: Approve. Waiting jobs hold no lease, and a job resumes from a timer, a teammate
     finishing, an approval or added credits only after the same checks run again.
   - Why: A fixed 30-minute lease cannot carry a long job. The trade-off is a security one: if part
     of Morrow were compromised, it could keep an already-started job working within the requester's
     current permissions until the outer limit, but it still could not start a job, widen a
     permission, or outlast a stop. That widens an accepted risk in ADR-0022 item 9, so it needs
     your word. (ADR-0041 item 7.)
3. In place of the old limits (16 turns, 6 for Morrow, 40 tool calls, 30 minutes), should safety
   checks pause a job and ask a person instead of ending it? A job checks in after 1,000 turns,
   10,000 tool calls, 24 hours of work, 7 days since you last touched it, or 32 teammate runs, and
   whenever code sees it looping, repeating errors or making no progress.
   - Recommended: Approve these values as catalogue data, tuned by tests and staging. Only the
     person who asked can press Continue (for a scheduled agent, its owner or the Owner); anyone who
     holds a stop can stop it. A teammate never asks you directly: it hands its partial work back to
     Morrow.
   - Why: Healthy work never reaches these numbers, and none of them ends a job: they decide when a
     person's attention is needed and who may let an agent keep spending credits. (ADR-0041 item 18;
     amends ADR-0027 item 6 and ADR-0039 item 5.)
4. Should a job also check in with you when it has used 5 times the usual credits for that kind of
   job (and, until staging has measured what is usual, the credits worth about US$25 of model use)?
   - Recommended: Approve.
   - Why: Failed jobs are free to merchants and every workspace shares your US$100 monthly Anthropic
     limit, so a job that keeps spending without finishing would cost you. This pauses and asks; it
     never ends the job and is not a spend cap. (ADR-0041 item 18.)
5. To stop one shop using up your shared Anthropic limit, should each workspace have at most 12
   model calls in flight at once, and should new jobs pause when Morrow's own measured spend this
   month reaches 80% of your Anthropic monthly limit, with each workspace getting a fair share?
   - Recommended: Approve. Running jobs carry on; new ones wait; nothing is lost.
   - Why: One workspace could otherwise exhaust the limit and stop every workspace for the rest of
     the month. Both are safety settings, not spend caps, and they change how work is scheduled,
     which is your call. (ADR-0041 item 9.)
6. When a workspace runs out of credits in the middle of a job, should the job pause and carry on by
   itself once credits are added, instead of using a reserved last step to finish with whatever
   answer it has (which you confirmed on 2026-10-26, before asking for no shortcuts)?
   - Recommended: Pause and resume. The job posts 'Paused: out of credits' with Add credits and
     Stop, holds nothing while paused, and resumes where it was, oldest job first. After 7 days
     paused it closes but keeps its place, so Continue can pick it up. The optional per-agent credit
     limit pauses only that agent.
   - Why: The reserve exists only to force a wrap-up answer near a limit, which your later message
     rules out. Pausing keeps all the work done so far. This reverses OD-2026-10-26-1 item 2, a
     money rule, so it needs your word. (ADR-0041 item 9; amends ADR-0039 items 2(d) and 2(e).)
7. Should the extra model calls that make jobs reliable be charged like any other step? They are:
   summarising a long job's memory, the independent check before work is presented, tidying agents'
   notebooks and conversation summaries, and re-sending after an unclear provider failure.
   - Recommended: Yes, as ordinary paid steps that set aside their worst case first and pay only
     what they used. Jobs that fail because of an error on Morrow's or Anthropic's side stay free
     (refunded when the job settles). Background tidying counts toward the member whose activity
     caused it.
   - Why: These calls are part of doing the job well. Whether they show on a merchant's credit bill
     is a pricing question, and ADR-0039 only named a job's model turns as paid. (ADR-0041 item 9.)
8. Before each step a job sets aside the most it could cost. Should that set-aside count the part
   already in Anthropic's cache at the cheap cache-read rate, and, if the cache unexpectedly misses,
   should the difference be charged when the balance covers it and otherwise be absorbed by Morrow,
   never ending the job?
   - Recommended: Approve.
   - Why: Without it, a large conversation would lock up 2 to 3 dollars of credits per step even
     though a typical step costs 10 to 20 cents, and small wallets would pause for credits they
     would never spend. (ADR-0041 item 9.)
9. Should Morrow cache the whole growing conversation, not only its fixed start, using Anthropic's
   1-hour cache for conversations, background requests and anything waiting on a person (and 1 hour
   on the fixed part plus 5 minutes after it for short teammate calls)?
   - Recommended: Approve.
   - Why: Without it, every turn pays again for everything before it, so cost grows with the square
     of the conversation's length. A 1-hour cache write costs twice the input price instead of 1.25
     times, but one cache miss after a 10-minute wait costs a full rewrite. This changes ADR-0027
     owner question 3, which you approved. (ADR-0041 item 10.)
10. May Morrow use three Anthropic features it does not use today: streaming the model's reply into
    Morrow's broker (never to your browser), Anthropic's beta on-demand compaction and context
    editing for keeping long jobs within their working memory, and Anthropic's cache diagnostics
    when a cache alarm fires or during tests?
    - Recommended: Approve all three. Morrow's own summarising method is built first and stays
      available, and a switch moves every job back to it at once. The beta features switch on only
      after they pass the same tests at least as well, and after Anthropic's retention terms for
      summaries are recorded.
    - Why: Streaming allows long, deep-thinking replies without timeouts. Anthropic's docs say to
      use on-demand compaction wherever it is available, and on Opus 5.5 it keeps the model's
      reasoning, which Morrow's own method must throw away. Betas can change, so no job depends on
      them. Which provider features Morrow sends is your decision (ADR-0022 item 10). (ADR-0041
      items 8 and 11.)
11. How long should Morrow keep the new kinds of job content: plans, summaries of long jobs, checks'
    verdicts, teammates' results and stored result items?
    - Recommended: As job content, with the access labels of the job that produced it, kept 90 days
      after each window of work closes; a long conversation starts a new window at least every 30
      days. The model's private reasoning is deleted as soon as it is no longer sent. Deleting a
      message, page or person removes every copy at once. Records with no content (events, waits,
      call lists) are kept 365 days.
    - Why: ADR-0031 has no class for this data. Without a rule, a conversation that never closes
      would keep its oldest content forever. Retention is yours to set. (ADR-0041 item 14; amends
      ADR-0031 item 1.)
12. Should each person have one current Morrow conversation that Morrow remembers as one continuing,
    private memory (kept compact automatically, rebuilt from what you may still see if your access
    narrows), with background requests branching off it, a Recent list filtered by 'Working now' and
    'Done', and a 'Start fresh' button that keeps earlier conversations?
    - Recommended: Approve.
    - Why: This is how the best agents keep continuity between messages instead of starting cold
      each time, and it matches dots. Holding one person's conversation across messages is a privacy
      choice, and keeping reasoning past the end of a single job changes ADR-0031's rule, so both
      are yours. It stays a private Ask with its privacy notice. (ADR-0041 item 5; ADR-0040 item
      11.)
13. Personal memory: who may see it, and where is it used?
    - Recommended: Only the person can see, edit or delete their memories; no Owner, Admin or other
      member has any way to read them. Morrow suggests a memory and nothing is saved until the
      person taps Save. By default a memory is used only in the person's private Morrow
      conversation; the person can switch an entry to 'everywhere I ask', which means replies others
      see may reflect it. Scheduled agents never use it. Customer details, contact details, card or
      ID numbers and passwords are refused, and agents never suggest sensitive topics such as
      health, religion or politics.
    - Why: It is a new class of personal data. Unlike Asks, which admins can read under audit, this
      should be the person's alone. (ADR-0041 item 29.)
14. Personal memory: how long is it kept?
    - Recommended: Until the person deletes it. Settings asks 'Still true?' after 180 days unused.
      All of a person's memories are erased within 24 hours of their membership ending, at workspace
      erasure, and when a store is removed for entries about that store. A memory survives deleting
      the conversation it came from, but the delete dialog offers to delete those too. Deleting a
      memory erases every version at once.
    - Why: Every data class needs a clock and a deletion path before it is written (ADR-0031).
      Retention is yours to set. (ADR-0041 item 29.)
15. Should Morrow get three new abilities: its own notebook of lessons (written only in shared work,
    never in private conversations), suggesting personal memories, and proposing shop knowledge
    pages? And may a small tidy-up run keep Morrow's notebook in order, posting nothing?
    - Recommended: Yes to all. None of them grants anything: knowledge changes only when a person
      accepts the exact page, and a memory only when the person taps Save.
    - Why: Morrow's fixed set of tools and the rule that only a person's act starts Morrow are
      authority rules (ADR-0027 item 8), so changing them needs your word. Without these, Morrow
      cannot learn how to orchestrate better or remember what you asked it to. (ADR-0041 items 24
      and 27.)
16. May a teammate read a lesson it wrote while working for one person when it later works for
    another?
    - Recommended: Yes, only when the new requester may see everything the lesson came from, and
      never for anything from a private conversation (lessons are never written there). The agent
      page shows 'learned while working for <name>', and a lesson from untrusted text marks whatever
      reads it.
    - Why: It moves information between people's work, which is a privacy choice, although no
      permission moves. (ADR-0041 item 27.)
17. If a colleague's message, or a lesson an agent learned while working for that colleague, shaped
    a proposed store change, should that colleague be blocked from approving it? And if everyone
    else in a team is blocked, may the Owner approve with the solo owner's typed phrase and wait?
    - Recommended: Approve. The review card names who influenced the proposal.
    - Why: Otherwise someone could steer an agent with their words and then approve the result
      themselves, defeating the no-self-approval rule. Who may approve is an authority rule
      (ADR-0011, ADR-0024). (ADR-0041 item 32.)
18. Should a separate reviewer check important work before Morrow presents it: suggested store
    changes, figures you will act on, files, new agent cards, and anything built on untrusted text?
    It is a fresh, read-only run that checks the work against the criteria fixed at the start, at
    the same effort as the work it checks, and can only block.
    - Recommended: On by default, with a workspace setting to turn it off. Not used on everyday
      chat.
    - Why: Agents grade their own work too leniently, and independent checks catch real errors. It
      adds roughly one more teammate run each time, so the default is your money choice. (ADR-0041
      item 19.)
19. The permission engine allows 32 teammate runs per job envelope. Should that stay, with a job
    that reaches it asking the person who started it, whose Continue opens a fresh envelope for 32
    more?
    - Recommended: Approve. Each teammate run is still checked on its own against every permission,
      one level deep.
    - Why: A long orchestration or a batch over many products would otherwise stop partway. Keeping
      the limit and adding a person's Continue changes the authority engine as little as possible,
      which is why it is your decision. (ADR-0041 item 21; amends ADR-0037 item 3.)
20. Search for memories and knowledge: should Morrow start with word-based search plus the agent's
    own judgement, build a test now from your shop's data of how well it finds things said in other
    words, and draft a record choosing an embedding provider in parallel, to be decided by that test
    before the memory features switch on?
    - Recommended: Approve. If the test finds fewer than 95% of the right items in the top 5, the
      embedding record comes to you first.
    - Why: Embeddings would add a new data processor, which is a provider choice, and a copy of the
      text that every deletion must reach. A test decides it instead of a guess either way.
      (ADR-0041 item 30.)
21. Morrow's database is far from where Cloudflare runs long jobs. If staging shows job steps are
    too slow even after each step's database work is cut to one round trip, may Morrow run that
    database work through a small Cloudflare object placed next to the database?
    - Recommended: Approve now, used only if the measurement needs it. It holds no data and has no
      web address.
    - Why: Any new Durable Object use needs a recorded decision (ADR-0038). Deciding now avoids a
      wait later if the measurement fails. (ADR-0041 item 35.)
22. The tests that judge agents' answers with a model need checking against your own judgement. Will
    you label a set of about 60 example results (an hour or two), once a quarter?
    - Recommended: Yes.
    - Why: Model judges are only trustworthy when they agree with the people they stand in for. Your
      labels also set the reviewer's catch rate and false-alarm targets. (ADR-0041 item 37.)
23. Until Morrow's customer-data deletion path exists, should messages to agents that contain
    customer details (emails, phone numbers, street addresses, customer ids) be refused with 'Morrow
    can't keep customer details yet. Remove them and send again.'? Order numbers stay allowed.
    - Recommended: Approve.
    - Why: Customer data may not be stored before its deletion path exists (CLAUDE.md). Without this
      check, a pasted email would flow into Morrow's memory and summaries, which have no deletion
      path yet. (ADR-0041 item 31; ADR-0040 item 2.)
24. Should Morrow work like messaging a team of agents? You see 'Seen by Morrow' within seconds;
    quick questions are answered in place; longer work goes on in the background on a card that
    updates live; results arrive as finished messages; nothing types itself out; the box you write
    in never locks; and Stop sits on each request.
    - Recommended: Approve ADR-0040 as written.
    - Why: It is what you asked for. Only the message contract and screens change: the model's reply
      already ends in the broker, no messages table exists yet, and the agent-loop migration is not
      applied. (ADR-0040.)
25. If you write while a request is working, where does your message go? (a) A reply to that request
    (shown as 'Replying to: [request] ✕' above the box) goes into it at its next step; tap ✕ and it
    goes to Morrow as a new message, which may start a new request beside the first. Quick bursts of
    messages count as one. (b) Every message goes into the running request. (c) Every message waits
    until the running request ends.
    - Recommended: (a).
    - Why: Unrelated asks stay apart, quick questions never wait, and code (not the model) decides
      the route, which you can see before you send. Only the person who started a request can steer
      it. (ADR-0040 items 7 and 8.)
26. Should each person have at most 5 requests working at once, with any more waiting in line
    ('Starts when one of your requests finishes', up to 20 waiting and up to 24 hours), and a
    2-second pause that gathers a quick burst of messages into one?
    - Recommended: Approve. They are catalogue values a new version can change.
    - Why: It keeps many parallel requests from surprising you, without refusing work for a reason
      other than safety or credits. (ADR-0040 item 9.)
27. Should your screen get live updates through a small live channel per signed-in person (a
    Cloudflare Durable Object that only says 'something changed', never what), from launch, with the
    browser falling back to checking every 2 seconds when the channel is down?
    - Recommended: Approve.
    - Why: Updates arrive within about a second, cost almost nothing while idle, and avoid a
      database query every 2 seconds for every open tab. Because the channel carries no content and
      is per person, nobody can learn about activity they cannot see. A new Durable Object needs a
      recorded decision (ADR-0038). (ADR-0040 item 15.)
28. How should Morrow reach you when you're away? Phone and desktop notifications from launch:
    'Needs you' at once and 'Done' if you haven't seen it within 2 minutes, at most 6 an hour, none
    in your quiet hours, with nothing private in the notification itself. Plus one batched email for
    anything still unseen after 15 minutes, once the email domain is set up.
    - Recommended: Approve. The notification key is held only by Morrow's broker (you place it with
      wrangler secret put), only the main push services are allowed, and a device's subscription is
      deleted on sign-out.
    - Why: Agents messaging you when the work is done is the heart of the dots feel. Push adds a key
      the broker must hold and outside push services as processors, which are security and privacy
      decisions. (ADR-0040 item 16.)
29. Should your messages show 'Seen by Morrow' (or the teammate's name in its own thread), with no
    read marks between people, and should agents' messages get two marks, 'Thanks' and 'Not
    helpful', used only as feedback?
    - Recommended: Approve.
    - Why: Seeing that an agent picked up your message builds trust, while colleagues' read marks
      would show when people are active. A mark never starts, steers or approves anything. (ADR-0040
      item 14.)
30. Messages agents send on their own: should you be able to give Morrow a standing request ('every
    Monday, check which best sellers will run out'), which you confirm once and which then runs with
    your permissions at the time, posts only in your own Morrow conversation, can read and suggest
    but not change anything, expires after 90 days unless renewed, and can be paused or revoked by
    you or the Owner? And should teammates' own routines keep reporting where they were set up, with
    a pointer in your conversation when something needs you?
    - Recommended: Yes on these terms. At most 10 standing requests per person; skipped and you're
      told if you've lost the permissions; nothing changes in your store without your Start and
      approval.
    - Why: The products you pointed to check in on what they watch. Today only a person's act may
      start Morrow (ADR-0027 item 8, ADR-0034), so a standing request needs your decision and a
      defined requester for each run. (ADR-0040 item 12.)
31. Who may stop a request? The person who started it (or the agent's owner for a scheduled agent,
    the signer for a standing request), needing no other permission. The Owner and Admins also get a
    workspace stop that ends all AI work at once, and lifting that stop is a reviewed step: a solo
    owner types a phrase and waits; in a team, a second member approves.
    - Recommended: Approve. Stopping keeps finished work and pending suggested changes, and the
      request pays for what it used.
    - Why: Your own Stop must always work, even if other permissions changed. Admins can't see other
      people's private conversations, so the workspace stop covers emergencies, and re-enabling AI
      work after an emergency deserves a second look (ADR-0005). (ADR-0040 item 10.)
32. Where does store-changing work run? (a) In your Morrow conversation, Morrow answers and asks
    teammates read-only questions; work that changes your store, or that a teammate should own,
    starts with one tap on Start and runs in a project, and you follow it and get its result in your
    Morrow conversation. (b) Morrow starts teammates' store work straight from your conversation,
    with no project.
    - Recommended: (a).
    - Why: Each store change keeps a project with its own record, and the tap stays your own act.
      Option (b) would widen what a private conversation can create and needs its own record
      changing ADR-0034 and ADR-0037. (ADR-0040 item 11.)
33. People who can see a project conversation would see that a request started there, its state,
    which teammates are on it and its times, even when a step's details are hidden from them. Your
    private Morrow conversation shows none of this to anyone else. Approve?
    - Recommended: Approve.
    - Why: Shared request cards need it, and no content or hidden step leaks: what each person sees
      comes only from what they may see. It replaces ADR-0016's narrower 'a viewer may learn a
      message started' rule. (ADR-0040 item 1.)
34. In your Morrow conversation only, should your own messages sit on the right on a light warm-grey
    surface (no coloured bubble, no emoji), with agents on the left? Project conversations keep
    left-aligned rows.
    - Recommended: Approve, after seeing the conversation drawn both ways.
    - Why: Every messaging app shows 'me' and 'the agent' apart at a glance; without it, a
      conversation full of cards reads like an activity log. It changes ADR-0032 for that one
      screen. (ADR-0040 item 11.)
35. On a long request, should Morrow post short interim findings ('6 at-risk products so far;
    checking supplier lead times now'): only after 15 minutes of work, at most one per stage and one
    per 30 minutes, never claiming that something was approved, changed or finished, and always
    shown with a status line that code builds from the records?
    - Recommended: Approve.
    - Why: Dots-style agents share substance during long work, which code-written progress words
      can't carry. The limits and the code-built status line keep it from becoming chatter or
      contradicting what actually happened. (ADR-0040 item 6.)
