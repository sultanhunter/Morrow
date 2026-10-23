# Decision sheet, week 0 (2026-10-26): the core flow, ADR-0033 and ADR-0034

The weekly decision sheet (ADR-0023 decision 10), second sheet for W0. On 2026-10-23 you approved the UX flow recommendation's eight answers ("approve all as recommended", OD-2026-10-23-8). Answer 2 asked for two records before code: [ADR-0033](adr/ADR-0033-work-model-v2.md) and [ADR-0034](adr/ADR-0034-morrow-drafts-plans.md). Both are proposed and material under ADR-0002: they change public contracts and the Coordinator's authority, and ADR-0033 also changes data retention. No code that depends on one merges before your approval. They are needed by T2's contract week, W1 (2026-11-02 to 2026-11-06). Neither weakens a security invariant: Morrow still creates nothing shared without a person's tap, and every store change, discount and customer email still needs a person's approval of the exact change. "The Owner" below is the workspace's designated owner.

Not at launch, as you approved: a finished step starting the next agent by itself (it needs its own ADR on how runs start) and "Orders from AI assistants" as a goal measure (it needs new order fields, unless T8 finds the existing ones suffice).

## ADR-0033 Work model v2

Decides:
- A project holds 1 to 3 goals. Each goal shows today's number, a target, a date and how it is measured: from the Shopify store, a checklist code counts, or a check you record by hand. Code computes every number and health word ("On track", "Behind", "Done", "Needs you"); no agent can move a target or record a value.
- Two kinds of project: one with an end date ("Ends Fri, Dec 4"), and Everyday work, one area per agent you add (Product pages, Stock, Customer emails, Sales and numbers, Promotions), plus one Quick tasks place, so no task is ever loose. The separate Goals page goes; the screen names are tested with five merchants before launch.
- The monthly AI-answer check is done by you, in one assistant, with 5 questions Morrow writes (answer 6). A skipped check shows "Needs you", never "On track".
- Every factual sentence in a suggested product change (descriptions, search descriptions and photo descriptions) names its source, inside what you approve; code flags any sentence without one, and the Approve button says how many. Titles and tags you check by eye, and the card says so.
- Spend per project shows at launch, with no project limit (answer 5). "Stop steps" on each project turns off its repeating tasks and cancels steps not yet started, from existing controls (answer 7). "Finish project" closes a project in one step under your own permissions.
- Data: goal records and their projects are kept until a person deletes them, the store is removed or the workspace is erased. Numbers from orders keep their 90-day clock and show only to people who may see orders. The Customer emails goal ("Replied within a day") counts as customer data: kept 90 days, shown only to people who may read customer data (you, by default), and never in the Monday update or in Morrow's view.

Questions:
1. Projects with no end date outside the agent areas? **Recommended: not at launch.**
2. Who sees a project's credits? **Recommended: everyone who can see the project.**
3. Which assistants for the hand check? **Recommended: ChatGPT (the default), Gemini, Copilot and Perplexity.**
4. May a "wording only" sentence go without a source? **Recommended: yes,** shown as "Wording only", unless it holds a number or unit.

## ADR-0034 Morrow drafts plans

Decides:
- Morrow drafts a card (a project, a task, a repeating task or alert, or a plan change) with a new tool that grants nothing; nothing is created until a person taps Start. Morrow itself creates no task at launch.
- One tap creates everything on the card under that person's own permissions, re-checked at that moment; if any piece is something the person could not create by hand, nothing is created. Only the person who asked can start the card.
- When a specialist is involved and you start it as Owner, the same tap has Morrow draft the check-up, and you then tap "Start check-up" (answer 1). A teammate's tap offers "Ask [Owner]" instead.
- In a private Ask, once the Ask safeguard (P05.T04b) exists, Morrow may search shop knowledge, read work, ask up to two tap-to-answer questions, draft cards and ask one added agent for a read-only answer. On Start only your request and the card are copied into the project; the rest of the Ask stays private.
- "@Morrow" in a project conversation, or "Plan next steps", asks Morrow to re-plan. Morrow never checks in on its own schedule at launch (answer 4).
- New message types for the plan card, the choice question, the plan change, the Monday update and the check-up done card. Each person sees in the Monday update only the goals they may see. Morrow's part ships behind a switch that stays off until the agent loop is on and P05.T04b exists; setting up areas and Quick tasks, and Finish, need no model and do not wait for it.

Questions:
1. Should "Start project" also start agent steps that are ready (this spends the step's credits, shown on the card)? **Recommended: yes;** "Send to Listings" and "Apply changes" already do this in the flow you approved, and later steps still wait for their own tap.
2. Who may start a card Morrow drafted for someone else? **Recommended: only the person who asked,** at launch.
3. Should @Morrow also work in task conversations? **Recommended: no.**
4. This changes the flow you approved. Turning on an agent's repeating task (the weekly stock list, or an area's weekly check) will not be one tap. If you work alone, you type a phrase and wait 5 minutes, which you can cancel. In a team, another member approves. Keep that rule at launch? **Recommended: yes;** a one-tap rule would need its own ADR after the merchant test.

Reply 'approve ADR-0033 and ADR-0034 as recommended' or name the items to change
