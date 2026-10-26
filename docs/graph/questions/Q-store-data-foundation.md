---
id: Q-store-data-foundation
type: question
kind: decide
title: "The decision sheet for the store-data foundation: ADR-0043, ADR-0044, the note on ADR-0031, operator paging and the database plan, 17 questions with the lead's recommendations"
status: answered
asked_of: owner
links:
  raised_by: [ADR-0043, ADR-0044]
  about: [ADR-0043, ADR-0044, ADR-0031, ADR-0024, ADR-0025, ADR-0039, ADR-0041, F-mandates, F-proactive-agents, F-rules-budgets-stops, F-order-and-money-writes, F-privacy-deletion, F-operations-labs, F-shopify-connection, GATE-deletion-paths, GATE-gateway-reservations-stops, V1-PR21, V1-PR22]
---

When you approved ADR 0042 you added that COD Confirmation will be an agent people install, that
the agent itself need not be built now, and that the foundation must be solid enough for agents
that use live store data, such as orders, and perform scheduled actions. A foundation audit of
four kinds of agent (COD Confirmation, order operations, customer retention, inventory and
purchasing) found the base design sound and the store-data side mostly unbuilt. Most of the fixes
are routine and are already ordered in `docs/plan/store-data-foundation-implementation.md`. These
17 need you:

- questions 1 to 10: ADR-0043, store events, schedules and standing action policies;
- questions 11 to 14: ADR-0044, letting installed agents ask questions and post;
- question 15: the new data classes and how long they are kept (a proposed note on ADR-0031);
- question 16: operator paging; question 17: the paid database plan, which is a purchase.

Each question has one recommendation. To accept them all, say "approve ADR-0043 and ADR-0044 as
recommended", or answer by number. Question 17 is a purchase you make yourself; "as recommended"
would mean you will buy the plan before order events are switched on. Nothing that depends on these
answers is built past the records until you answer. Not asked: the schedule contract and reading
your shop's time zone from Shopify (ADR-0043 items 7 to 9) are routine fixes that start now; say
so if you want them otherwise.

## ADR-0043: store events, schedules and standing action policies

1. **May store events start any installed agent's work?**
   - Options: (a) yes, by ADR-0043: an agent can ask to hear about new or changed orders, products
     or stock, and a match either starts the agent or runs an approved action in code; (b) only
     COD Confirmation's call path, as ADR 0042 wrote it.
   - Recommended: (a).
   - Why: your approval of ADR 0042 left "order events for every agent" for "later, by its own
     change"; ADR-0043 is that change. Without it each new agent would build its own event pipe.
     Morrow records each match as ids in its own row and never acts on the text Shopify sends.

2. **How should bursts be grouped?**
   - Recommended: events that start an agent are grouped over 5 minutes; an agent starts at most
     6 runs an hour from events, deadlines and monitors together; a row names up to 500 records;
     missed events are replayed for 24 hours. All are catalogue values, changed by a new version.
   - Why: a sale or a bulk import can bring hundreds of orders a minute. Grouping turns 300 orders
     into one job, not 300, so credits and Shopify's rate limits are not burnt, and nothing in the
     burst is lost: extra rows merge into the next allowed one.

3. **How should deadlines and monitors alert?**
   - Recommended: "unfulfilled for 48 hours" and "under 14 days of stock" are checked by code, which
     posts the alert itself (an Inbox item and a post in the agent's area), at most once per window.
     The AI runs only to explain the alert or draft a change, at most once per window.
   - Why: deciding whether to alert is arithmetic, which code does exactly and for free. A
     thousand stock updates then give one alert, not a thousand.

4. **Which Shopify events may agents use?**
   - Recommended: only those ADR-0025 already approved (products, inventory levels, and, with
     "read orders", orders and refunds). Others (fulfilments, returns, customers, shop changes)
     come one agent at a time, each by a dated amendment with its own data trimming.
   - Why: each new event brings new data, and some (returns) carry customers' free text.

5. **May one approval of an exact standing policy cover each small, reversible action inside it?**
   - Recommended: yes. You approve the exact action once, for example "tag late orders
     `morrow-late`, up to 200 orders a day", by typing a phrase; code then admits each action
     against the policy, the stops and the caps, and the gateway applies, reads back and records
     it. The first allowed actions: adding Morrow's own tags (or tags you pick) to orders,
     removing a tag the policy added, a note in Morrow's own field on an order (never your order
     note), and ADR 0042's call plans, which become the first standing policy. Anything new joins
     the list only by a dated amendment. Pause and revoke are one tap.
   - Why: a shop with 200 late orders a day would otherwise approve 200 tags a day, and copying
     ADR 0042's call plan for every agent would repeat its checks and its exceptions.
   - This changes CLAUDE.md's wording, in one change with ADR 0042's lines. Proposed text:
     - "Approvals are bound to a digest of the exact proposal, or of the exact standing policy
       whose actions it covers (ADR-0043). Any edit invalidates them. The gateway re-checks
       authority before every execution."
     - "Agents change it only through an approved exact proposal, or an action inside an
       approved exact standing policy, which code admits and the gateway applies, reads back and
       audits (ADR-0043)."
     - "Change the owner's store only through Morrow's own flow: the owner approves the exact
       change, or the exact standing policy it falls under, in the workspace, and the gateway
       applies, reads back and audits it. Never write to the store any other way."
   - **Corrected after your answer** (the records' review, 2026-10-26; OD-2026-10-26-11):
     - ADR 0042's call plans are not among the small, reversible actions, since a call cannot be
       taken back. They become a standing policy as its one named exception, under ADR 0042's own
       approval and checks; the allowlist itself holds only the three reversible order actions.
     - The CLAUDE.md text above started from CLAUDE.md as it stands today, so it would have
       overwritten three of ADR 0042's four CLAUDE.md lines (its question 6) and dropped their
       call-plan exceptions. You approved those four lines in substance when you approved ADR 0042
       (OD 2026-10-26-9, recorded on pull request 86), but their exact text was added to that
       sheet after your answer, so it still waits for your word-for-word confirmation, and ADR
       0042's CS2 commits it only then. The corrected text, under "Question 5: the corrected
       CLAUDE.md text" below, builds on those lines as CS2 will commit them. It comes back to you
       to confirm word for word; it lands as its own change after CS2's and changes nothing else
       in CLAUDE.md. You can confirm both sets of words in one message: ADR 0042's four lines and
       these three. ADR 0042's third line, the ask before sending anything to your customers, does
       not change.

6. **What always needs your approval each time?**
   - Recommended: cancelling and refunding orders, prices, discounts, stock quantities,
     fulfilment, changes to customers, supplier mail and anything that cannot be undone. Code or
     an agent may draft them; you approve each, alone or in a batch. No answer, deadline or
     monitor ever cancels an order by itself.
   - Why: these move money or stock, or cannot be taken back. An automatic version would need its
     own record after measured results.

7. **May one typed confirmation cover a plan with several kinds of change?**
   - Recommended: yes. A "plan bundle" covers 2 to 50 pending changes of up to 5 kinds on one
     store (for example a reorder's spreadsheet and a product note), with one phrase that lists
     each kind's count, one cool-down, and the strictest rule among them. One bad change refuses
     the whole bundle.
   - Why: today a solo Owner types the phrase and waits out the cool-down once per kind of change,
     so a mixed plan costs two or three waits for no extra safety.

8. **Should rules have Pause and Revoke buttons that act at once?**
   - Recommended: yes. Pause rule (the Owner, Admins and the agent's owner) and Revoke rule (the
     Owner and the agent's owner) need no second person, never wait on credits, and agents may
     only suggest them. Turning a rule back on is reviewed like approving it.
   - Why: it follows ADR-0005: stopping is always fast and human; starting again is checked.

9. **How should stops apply to everything that runs on its own?**
   - Recommended: one stop check in code for every automated path (event and schedule triggers,
     deadlines, monitors, rule actions, calls and the gateway). Anything that falls due while
     stopped is skipped, not saved up, so nothing bursts out on resume; resuming covers only what
     happens afterwards unless you choose to include the earlier ones. "Stop customer contact"
     covers every contact capability, not a list of three. The workspace stop lands before any
     send or order-write switch goes on.
   - Why: a stop that quietly queues work, or misses a new path, is not a stop.

10. **How should work that runs without AI use credits?**
    - Options: (a) counted but not charged until the rate card prices it, and never blocked by
      credits when it is time-critical (receiving events, keeping data fresh, approved actions,
      stops, deletion); AI runs hold credits as today; agents waiting on credits are combined into
      one run each when credits return; bulk work you start by choice, such as a future campaign,
      reserves all its credits when approved; (b) price every code step now.
    - Recommended: (a).
    - Why: the rate card is not published, and an empty balance must never silently drop a
      confirmation or a tag you approved. Combining waiting runs stops a flood when you add
      credits. Pricing comes with rate card v1, which you confirm.

## ADR-0044: installed agents asking questions and posting

11. **May installed agents ask you questions and post what they found?**
    - Recommended: yes, but only in their own Everyday work area (for example "Stock" or "Cash on
      delivery") and in the threads of tasks given to them. Never in your private conversation
      with Morrow, a project they hold no task in, or another agent's area. A teammate that Morrow
      calls still never talks to you; Morrow relays.
    - Why: today no installed agent may do either, so a weekly COD report, a late-orders digest or
      a low-stock explanation has nowhere to go. Keeping them to their own places stops a tainted
      run from posting across the workspace.

12. **How are these two abilities granted?**
    - Recommended: as two rows on the screen where you add the agent (or on its agent card), on by
      default when the agent declares them, and covered by the same approval. The agent's owner
      or the Owner can switch them off at once on the agent's page; switching them back on is a
      reviewed change.
    - Why: they are internal writes in the agent's own places, so a separate approval adds a step
      without adding safety; switching off stays one tap, like Stop AI work.

13. **Who answers an agent's questions?**
    - Options: (a) the person who added the agent, or the Owner, for work it does on its own; the
      person who handed it a task, for that task; and whoever answers counts as an author of any
      change the answer shapes; (b) any member the agent chooses.
    - Recommended: (a).
    - Why: an AI should not pick who it asks. Counting the answer as authorship is the rule you
      accepted for other people's words (ADR-0041 question 17): in a team, someone else then
      approves the resulting change, or the Owner with the typed phrase; a solo Owner keeps the
      phrase and cool-down as today.

14. **How chatty may agents be?**
    - Recommended: one open question per job and three per agent, each expiring after 7 days with
      reminders at 24 and 72 hours; at most 3 findings per job and 20 a day per agent; agents never
      @mention anyone, and Morrow's code sends the notifications. All are catalogue values.
    - Why: proactive agents run unattended; these bounds keep your Inbox useful.

## The note on ADR-0031: new data and how long it is kept

15. **How long should Morrow keep the new store data?**
    - Recommended, as the proposed note on ADR-0031 item 1 sets out:
      - the current state of each order: 90 days from the order's date, like today's order totals;
      - current stock levels: the latest values only, deleted when the store is removed;
      - trigger rows, deadline and monitor records, and the log of each approved action: 365 days,
        with no content, and order ids blanked when a customer's deletion request lists the order;
      - standing policies: 365 days after they end, like standing permissions today;
      - the daily usage counts: 365 days; bulk-read records: 30 days; positions and rate-limit
        state: only while the store is linked.
    - Why: none of these holds a customer's name, email, phone, address or note, and every row
      keyed by an order is deleted or blanked when Shopify asks Morrow to erase that customer's
      orders. Counsel's question on India's one-year log rule (from about May 2027) stays open.

## Operations

16. **Should Morrow buy a paging service for its own alerts now?**
    - Options: (a) not yet: operator alerts (silent webhooks, backlogs, missed deadlines) go to a
      named person through the paths Morrow already has (the Inbox, Web Push once it lands, the
      template email once the email vendor is live); decide again before the first outside
      merchant or when alert volume shows a need; (b) choose a paging service now.
    - Recommended: (a).
    - Why: until launch the only store is yours and you are the operator, so a pager adds a vendor,
      an account and a cost for no faster response. Choosing one later is a provider selection
      with its own short record.

17. **Should Morrow move to a paid database plan before store events run around the clock?**
    - Options: (a) yes: you buy Neon's paid plan yourself in Neon's console before the order-events
      switch goes on; (b) stay on the free plan and keep the order-events and contact switches off.
    - Recommended: (a), bought when those switches are ready, not before.
    - Why: the free plan has a hard monthly compute allowance, and a spent allowance is an outage;
      it keeps only about 6 hours of history for a restore. Webhooks, deadlines and approved
      actions must keep running at night. This is a purchase, so it is yours to make (ADR-0035):
      Claude never buys it and only records the line in the activity log once you say it is done.
      The price is the one Neon shows you when you buy.

## Question 5: the corrected CLAUDE.md text

Three lines change, each shown as ADR 0042's CS2 will commit it ("Now") and as proposed. The
"Now" text is ADR 0042's question 6 lines 1, 2 and 4, approved in substance by OD 2026-10-26-9 and
still waiting for your word-for-word confirmation; you can confirm those four lines and these three
in one message. The text is in plain blocks so that it can be confirmed exactly as it will be
committed.

1. Security invariants. Now, as CS2 will commit it:

```text
Approvals are bound to a digest of the exact proposal. Any edit invalidates them. The gateway re-checks authority before execution. One exception (ADR-0042): an approved customer-contact call plan is one exact proposal whose approval covers each contact and order tag it names; an edit to a plan makes a new revision that needs its own approval, and the approved revision keeps running until then unless the editor pauses it.
```

   Proposed:

```text
Approvals are bound to a digest of the exact proposal. Any edit invalidates them. The gateway re-checks authority before execution. One exception (ADR-0043): an approved exact standing policy, of which ADR-0042's customer-contact call plan is one, is one exact proposal whose approval covers each action it names, each admitted in code against its digest and the subject's current state; an edit to a policy makes a new revision that needs its own approval, and the approved revision keeps running until then unless the editor pauses it.
```

2. Security invariants. Now, as CS2 will commit it:

```text
The owner's own store is the only real store until the public launch, and Morrow is built and tested on it (ADR-0035). Agents change it only through an approved exact proposal, or by adding an order tag that an approved call plan names (ADR-0042). Local and CI tests use fakes; only the deployed environment reaches the store.
```

   Proposed:

```text
The owner's own store is the only real store until the public launch, and Morrow is built and tested on it (ADR-0035). Agents change it only through an approved exact proposal, or through an action that an approved exact standing policy names, such as an order tag that an approved call plan names (ADR-0042, ADR-0043). Local and CI tests use fakes; only the deployed environment reaches the store.
```

3. Provider and live effects. Now, as CS2 will commit it:

```text
Change the owner's store only through Morrow's own flow: the owner approves the exact change, or the call plan that names it (ADR-0042), in the workspace, and the gateway applies, reads back and audits it. Never write to the store any other way.
```

   Proposed:

```text
Change the owner's store only through Morrow's own flow: the owner approves the exact change, or the standing policy that names it, such as a call plan (ADR-0042, ADR-0043), in the workspace, and the gateway applies, reads back and audits it. Never write to the store any other way.
```

## Answered

Answered 2026-10-26 (OD-2026-10-26-11): "recommended, and yes to the paid Neon plan": all 17 as recommended, so ADR-0043 and ADR-0044 are Accepted as recommended and the note on ADR-0031 item 1 is decided. Question 17 is answered (a), and the owner bought Neon's paid plan in Neon's own console the same day. The CLAUDE.md words of question 5, as corrected above, wait for the owner's confirmation word for word, as do ADR 0042's four lines they build on, which OD 2026-10-26-9 approved in substance only (question 6 of ADR 0042's decision sheet); the owner can confirm both sets in one message.

Questions 6 to 10 above are as the owner answered them. An editing slip dropped them from this sheet when the answer was recorded; they were restored, unchanged, on 2026-10-27.

The records' review (an AI review, separate context, same model family) ran on this sheet before the answer, and its fixes were made after it; a second review of 2026-10-27 corrected them (below). Besides question 5's corrections above, each narrows or makes exact what was answered:

- Question 6: "anything that cannot be undone" includes customer contact outside an approved call plan; ADR 0042's call plans are the one exception, under their own approval.
- Question 9: lifting any stop turns no rule back on by itself, as ADR 0042 says of call plans; each rule needs its own reviewed resume. Including the earlier ones means code writes them again from the store data, within 24 hours, for orders that still qualify.
- Question 10: waiting runs are still combined into one run per agent, as answered; each waiting row is re-checked as it merges, and one whose trigger, mandate or stops fail ends instead of riding on another's run. A job's own follow-through for later resumes on its own, as a paused job does.
- Question 12: switching the two abilities off is its own stop control, `agents.installation.collaboration.disable`, with a reason, an audit record and a notice.
- Question 13: the agent's question tool has no field for who answers; code works it out from the kind of work.
- Question 15: in trigger rows, deadline and monitor records and the action log, order ids are blanked 90 days after the order's date instead of kept for 365 days; the rows without them stay 365 days.
- Not asked (the schedule items): a `once` schedule, the follow-through a job writes for later, is not routine after all. It starts at least 15 minutes ahead, counts toward the agent's 6 runs an hour, inherits what the job had read, and cannot write another, and it is recorded as an amendment of ADR-0041.

A second review (an AI review, separate context, same model family) of 2026-10-27 found that the first round's question 10 fix, which combined waiting runs per agent and trigger, widened the answer, since an agent with two waiting triggers would have resumed as two runs; the rule above replaced it. Its other fixes make exact what was answered and widen nothing:

- Question 9: "Stop customer contact" stops every contact capability that calls or messages someone and every action of a call plan, its order tags included, as ADR 0042 approved; it never blocks the contact controls or reading results, and a tag rule that is not a call plan keeps running. The one stop check works out the workspace and connections itself and treats an unknown or mismatched id as stopped.
- Question 5: removing a tag is its own rule, paired with the rule that adds the tag and approved with it on one card; it removes only a tag its pair added, with no removal since.
- Question 13: a person asking a question still names who answers, as today; only an agent's questions get their answerer from code.
- Not asked (the schedule items): a job's follow-through for later ends with the job when a stop, a revoke, a kill switch, an authority failure or the mandate's end ends it, and runs only under the mandate it was written under; one over the hourly rate waits for the next slot. How late an event may arrive and still start work is a catalogue value: 24 hours by default, from 5 minutes to 24 hours.
