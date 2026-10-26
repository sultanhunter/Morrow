# ADR-0044 Collaboration grants for installed agents: asking people and posting, in the agent's own area and task threads

- Status: Proposed 2026-10-26. Nothing in it is approved. Its owner questions are questions 11 to 14 of Q-store-data-foundation.
- Date: 2026-10-26
- Supersedes: none.
- Amends: each only once the owner approves; listed so that the dated notes can be written when the owner answers (plan row SD2).
  - **ADR-0024** item 2: the install document lists two collaboration grants, "Ask you questions" and "Post in its area and task threads", which the issuer confirms with the rest (item 5).
  - **ADR-0037** items 4 and 5: an agent card may carry the same two grants; they are internal, so they need no Owner beyond the card's own rule.
  - **ADR-0040** item 12: a mandate run's posts and questions in its area conversation are made under these grants, in the places item 2 names.
  - **ADR-0041** item 17: who may answer is fixed by code from a closed set (item 4), and the answerer joins the conflict set of proposals the answer shapes (item 8, under ADR-0041 item 32).
  - **Contracts:** `capabilities.json` gives `workspace.question.request` and `workspace.conversation.post` an installation scope rule (item 3); AgentPackage@2 and AgentProposal@1 gain a `collaboration` field; `CollaborationScope@1`; refusal codes `collab_out_of_scope`, `respondent_not_eligible` and `question_limit`.
- Implements: the separate authority record that ADR-0041 relies on and does not decide (its "Relies on" line: no installation can yet hold `workspace.question.request`), which the harness plan lists under "Not in these PRs" before the teammate-calls switch. It also serves ADR-0043, whose deadline, monitor and schedule episodes report to people.
- Does not change:
  - ADR-0041 item 21: a teammate run that Morrow calls never talks to a person; Morrow relays. These grants are not used in call contexts.
  - ADR-0041 item 17: one open question per run; a person's wait lasts 7 days with reminders at 24 and 72 hours; an agent never answers for a person.
  - ADR-0016 items 3 and 4: an installed agent never writes in a person's Ask, and agent-authored mentions are denied.
  - ADR-0040 item 6: model-written posts are replies, questions, results and milestone findings under its rules, each with its status part.
  - ADR-0041 item 31: every post and question passes the customer identifier screen before commit.
  - ADR-0031 item 6: read tags and audiences decide who sees each post.
  - Titles and delegation never confer authority. Every tool call still checks the intersection in code.
- Relies on: P07.T03 (conversations and messages); ADR-0033 item 6 (Everyday work areas); the agent loop and mandates (ADR-0041, V1-PR21); the customer identifier screen (harness plan row H9a); AgentPackage@2 (plan row SD10).
- Companion: ADR-0043. Both records' owner questions are on Q-store-data-foundation.
- Plan: `docs/plan/store-data-foundation-implementation.md`, row SD19.

## In plain words

An installed agent that works on its own, such as COD Confirmation's weekly report or an inventory agent's low-stock check, needs two simple abilities: to post what it found where you will see it, and to ask you a question when it is stuck. Today no installed agent may do either, so this record says when they may.

- **Only in its own places.** An agent posts and asks only in its own Everyday work area (for example "Stock" or "Cash on delivery") and in the threads of tasks given to it. Never in your private conversation with Morrow, never in a project it was not given work in, never in another agent's area.
- **Only the right person answers.** Its questions go to you as the person who added the agent, or to the Owner. When you handed it a task, they go to you. It cannot pick someone else.
- **You decide when you add it.** The two abilities are listed on the screen where you add the agent, and you can turn them off on the agent's page at any time.
- **Not chatty.** One open question per job, three per agent, each expiring after 7 days. It never @mentions anyone; Morrow's code sends the notifications.
- **Your answer counts as yours.** If your answer shapes a change the agent then suggests, you count as one of its authors when that change is approved, as Morrow already does for other people's words.

## Context

- **The capabilities exist; no installation holds them.** `workspace.question.request` and `workspace.conversation.post` are `agent_direct_write` capabilities whose authority line is "human or bounded installation with explicit capability grant" (`capabilities.md`). Members hold them through their templates (ADR-0017). No install document, card or template issues them to an installation, so the kernel denies every installed agent's question and post.
- **Records that assume them.** ADR-0040 item 12 has a mandate run post its card and results in its area conversation and send questions to the Inbox. ADR 0042's weekly COD report and plan revisions, an order-operations digest, an inventory alert's explanation and retention reports all need them. ADR-0041 names this record and leaves it open; the harness plan puts it before the teammate-calls switch and build order PR 21's mandate runs.
- **Why it is material.** It grants authority to installations and changes who may write where (authority under CLAUDE.md and ADR-0002), so it comes before the code that issues the grants.

## Decision

1. **Two grants, and only these.** An installation may hold `workspace.conversation.post` and `workspace.question.request`, each with the `execute` verb only. Not covered here, and still denied: `workspace.question.answer` (an agent never answers for a person), `workspace.comment.create` on other principals' items, `workspace.task.create` or `workspace.task.assign` for people, `workspace.conversation.create`, and any mention.

2. **Where: the installation's own places**, computed by code at every call by one ids-only definer, `collab_scope_allows(installation, conversation)`, never from the grant row or the model's input alone:
   - **its Everyday work area conversation**: the area made from its release's `EverydayAreaTemplate@1` (ADR-0033 item 6), at most one per template;
   - **the thread of a task currently assigned to it**: a hand-off's child task or a plan step's task, while the assignment is open;
   - nowhere else. Refused with `collab_out_of_scope`: a person's Morrow conversation (their Ask), Morrow's own threads, a project conversation in which the installation holds no open task, another agent's area, and a conversation whose viewers include nobody who can see the post's read tags.

   A routine's `report_to` conversation (ADR-0040 item 12) receives only the system `job_card` pointer that code writes, never an agent post.

3. **Which runs.** Mandate episodes (ADR-0024; triggers of ADR-0043 included) and hand-off task-thread runs of that installation. Not call contexts (ADR-0041 item 21), not review or upkeep runs, and not the look-for-work pass, whose suggestions code renders as cards (ADR-0040 item 12). `capabilities.json` records this as the installation scope rule of both capabilities; the tool catalogue offers the post and question tools to installed agents only in those run kinds.

4. **Who answers.** The question tool takes a closed respondent code, never a principal id, and code resolves it:
   - a mandate episode: `installation_owner` (the default), or `owner` (the Owner, when the installation owner has left, or cannot see every read tag of the question);
   - a hand-off task-thread run: `requester`, the person whose job it is (ADR-0041 item 17).

   The resolved person must hold `execute` on `workspace.question.answer`, `view` on `workspace.question.request` and `view` on every read tag of the question (`work-api.md`), or the question is refused `respondent_not_eligible` and the run ends `blocked` with its findings. Answers come only from that person, in session; an agent never answers.

5. **How they are granted.**
   - **On the install document** (amends ADR-0024 item 2) or **the agent card** (amends ADR-0037 item 4), as two listed rows, "Ask you questions" and "Post in its area and task threads", on by default when the package declares them in its `collaboration` field (AgentPackage@2) or the card's tools need them.
   - The issuer must hold both, with `delegate`, under live grants (`amplification_denied`), as for every other grant on the document. Both are `internal` class, so they add no Owner requirement beyond the document's or card's own (ADR-0037 item 5).
   - **Turning them off** is a toggle on the agent's page for the installation owner and the Owner: it revokes the grant rows at once (`human_only`, no second approver, like `agents.installation.disable`), cancels the agent's open questions with a code post, and leaves its other grants alone. **Turning them back on** is a new install-document revision under ADR-0024 item 2's review.

6. **Limits** (catalogue values, safety bounds and not money).
   - One open question per run (ADR-0041 item 17); at most 3 open questions per installation (`question_limit`); a question expires after 7 days, with Inbox reminders at 24 and 72 hours, and the run then closes `person_wait_expired` and keeps its context.
   - A question offers a choice from at most 6 options or a short free-text answer, and blocks only its own run.
   - Posts: an episode's card and result are written by code (ADR-0040 item 6); model-written posts are milestone findings under ADR-0040 item 6's rules, at most 3 per episode and 20 per installation per day.
   - A repeated identical question trips the repetition detector (ADR-0041 item 18).
   - Notifications are sent by code from the respondent's and viewers' settings: a question to the respondent's Inbox, a post by the area's notification rules. Agents never mention anyone (ADR-0016 item 4).

7. **What a post or question may carry.** Each passes ADR-0040's post command and the customer identifier screen before commit (ADR-0041 item 31), stores its author (the installation's principal), read tags computed from the run (ADR-0031 item 6), audience, taint and the run that wrote it, and is shown with the agent's character and the "Built by the Morrow team" or "Made by Morrow" provenance. No Level 2 customer data: Support's posts and questions, which may carry customer-tagged content after P09.T05, are visible only to viewers who hold `support.case.read` (ADR-0031 item 6).

8. **The answer in the run.** An answer enters the run as that person's words, labelled by code with its author and question, as user-role data (ADR-0041 item 13). The respondent becomes an influence principal on every proposal the run drafts after reading it (ADR-0041 item 32): in a team another eligible member approves, or the Owner with the solo phrase and cool-down when every other approver is conflicted, unless the Owner gave the answer; a solo Owner keeps the phrase and cool-down. An answer never confers authority, approves anything or clears taint.

9. **Stops.** Stop AI work on the installation, the workspace stop, the platform stop, a mandate's end or revoke, and the grants turned off each refuse new posts and questions at once and cancel the open questions with a code post ("Stopped before it got your answer"). They are checked at every call, beside the kernel.

10. **Data.** Questions, answers and posts are work records and messages on their existing clocks (ADR-0031 item 1, as ADR-0040 amended it); nothing new is stored beyond the scope definer's content-free audit.

## Security invariants touched

None is weakened. Installations gain two internal grants inside a scope code computes.

- **The intersection, in code:** the installation owner's grants, the installation's grants, the mandate, live policy, stops, and the scope of item 2, at every call (`lab:agent-authority-workers`, `lab:collaboration-grants`).
- **Tenant isolation:** conversations, tasks and respondents resolve only from server-held ids inside the run's tenant (`lab:tenant-conformance`).
- **Digest-bound approvals:** an answer is an influence, never an approval; the conflict set grows (`lab:approval-records`).
- **Default deny:** no grant row, no scope match or no eligible respondent means refusal; the switch `collaboration-grants` is committed off (`edge:check`).
- **Kill switches `human_only`:** turning the grants off needs no second approver; agents may only propose it (`stops.test.mjs`).
- **Customer data:** the customer identifier screen on every post and question (`lab:shopify-privacy`).
- **Accepted residual:** a tainted run may post text a person then reads. Its taint is shown, it can claim no approval or apply (ADR-0040 item 6), and its proposals still need a person's approval of their exact digest.

## Consequences

- Proactive agents can report and ask without Morrow relaying every message, and Morrow's conversation stays each person's own.
- An area becomes the agent's home: its digest, alerts, findings and questions in one place.
- Installers who answer their agent's questions in a team will often need another member, or the Owner, to approve the resulting changes. That is the rule the owner accepted for other people's words (OD-2026-10-26-7, question 17).

## Alternatives considered

- **Only Morrow talks to people, relaying every installed agent.** It works for calls inside a person's job (ADR-0041 item 21), but a proactive episode has no person's conversation to relay into, and posting into private Asks would break their privacy.
- **Grants usable anywhere in the workspace.** A tainted run could post into projects and threads it has no part in.
- **Any member as respondent, chosen by the agent.** Lets a model pick who gets asked, and spreads conflicts across the team.
- **A separate approval for these two grants.** They are internal writes inside the agent's own places; the install review already covers them.

## Owner questions

Each is one item on Q-store-data-foundation, with its options, recommendation and why.

11. Installed agents may ask questions and post, only in their own area and task threads. *Recommended: yes.* (items 1 to 3)
12. The grants are listed on the install document or agent card and on by default when declared; the installation owner or the Owner can turn them off at once. *Recommended: yes.* (item 5)
13. Who answers: (a) the installation owner or the Owner for proactive work, the requester for a task they handed over, and the answerer joins the conflict set; (b) any member the agent names. *Recommended: (a).* (items 4 and 8)
14. The limits: one open question per job, three per agent, 7 days; at most 3 findings per episode and 20 a day; no mentions. *Recommended: as written, as catalogue values.* (item 6)

## Approval

Not approved. This record is Proposed.

Approval is the owner's own statement in chat, quoted here verbatim with its OD number: for example "approve ADR-0043 and ADR-0044 as recommended", or answers by question number. Until then nothing that depends on this record merges. The records PR (plan row SD1) may merge with the record still marked Proposed.
