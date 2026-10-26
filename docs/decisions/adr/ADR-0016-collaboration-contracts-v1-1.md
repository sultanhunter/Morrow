# ADR-0016 Collaboration contracts v1.1: conversations, Asks, mentions, inbox, projects and EventEnvelope@2

- Status: Accepted
- Date: 2026-10-18
- Refines: ADR-0010 item 1 (reads of projects and Asks; access-request deciders) and extends ADR-0011 (reviewer rule for access requests)
- Affects: P01.T02c (PR-A contracts, PR-B library), P05.T04b (Ask-bound envelope), P05.T02a and the template-v2 issuance, P05.T01z (later template versions), P06.T02a, P07.T03, P11.T05, P14.T01-T03, `docs/contracts/{capabilities.json, collaboration.md, events.md, workspace-routes.json}`

## Context

Packet P01.T02c turns the P01.T02a §9 binding requirements C1-C5 into contract v1.1 additions: conversations and messages, mentions, the inbox projection, projects, access requests and EventEnvelope@2. Six choices in it are material under ADR-0002 (authority model and public contracts), and the packet asks them as Q1-Q6.

The packet recommended that an Ask (a private conversation a person opens with the Coordinator) be readable only by its owner, with no administrator override. The owner chose instead to let workspace admins read Asks. Role titles confer nothing in Morrow (Security invariant 4), so "workspace admin" has to be defined as a grant.

## Decision

The recommended answers to P01.T02c Q1-Q6 are adopted, except that workspace admins can read private Asks (item 5).

1. **Capabilities (Q1).** Eight new capability IDs, each with provider D01, the standalone surface, retention R02 and blocked activation:

   | ID | Effect | Executor |
   | --- | --- | --- |
   | `workspace.conversation.create` (Asks only) | internal_write | human_only |
   | `workspace.conversation.post` | internal_write | agent_direct_write |
   | `workspace.project.create` | internal_write | human_only |
   | `workspace.project.revise` | internal_write | agent_direct_write |
   | `workspace.project.pin` | internal_write | human_only |
   | `workspace.inbox.read` | read | human_only |
   | `workspace.inbox.mark` | internal_write | human_only |
   | `governance.access.request` | internal_write | human_only |

   None has effect `control` or reaches a grant type. `workspace.work.read`, `governance.access.read`, `governance.access.deny`, `governance.access.withdraw` and `governance.stop_proposal.dismiss` are not added.
2. **Read and decision rules (Q2).**
   - (a) A project, and a project conversation's subject, are read with goal view (`view` on `workspace.goal.create`), whose vocabulary gains the project fields. No agent could ever hold `view` on the `human_only` `workspace.project.create`.
   - (b) An Ask is read by its owner through ownership plus `view` on `workspace.conversation.post`, and by a workspace admin under item 5.
   - (c) Access-request deciders are the eligible reviewers of the would-be `governance.grants.revise` proposal (ADR-0011 Q5), not `administer` holders. The requester is conflicted and never decides. Withdrawal is the requester's own `execute` on `governance.access.request`.
   - (d) A stop proposal is dismissed with `execute` on its kill-switch capability covering every target.
3. **Agents in Asks (Q3).** P05.T04b adds an Ask-bound work envelope: requester and authorizer are the Ask owner, depth 0, no children, read capabilities and `workspace.conversation.post` only. Until it exists, the kernel denies every agent path into an Ask.
4. **Mentions (Q4).**
   - A mention is a scoped request under the author's own verbs and never authority.
   - `delegate` mentions are allowed only in task conversations, with the subject task as parent.
   - Duplicate targets are rejected.
   - A message carries at most 10 mention parts, and an author sends at most 60 mention notifications per workspace per 10 minutes.
   - Agent-authored mentions are denied before any target lookup.
   - A target who cannot see every source of a message receives nothing visible until they can.
5. **Privacy and accepted disclosures (Q5, as amended by the owner).**
   - **Asks are private to their owner, and workspace admins can read them.**
   - **Who is a workspace admin for this rule.** A human member who currently holds a grant of `administer` on `workspace.conversation.create` whose resource is the Ask's workspace W and whose fields cover `storeId` and `subject`. This follows the ADR-0010 item 1 ownership rule: one's own record uses the owner's verb, another member's record uses `administer` on the capability that creates it.
     - Nothing else counts: no role title or template name, no owner designation (ADR-0009 item 3: ownership confers no authority), no `administer` grant on any other capability, no governance capability such as `governance.grants.revise`, and no reviewer status.
     - The grant confers only this read. No command uses it to create, post into or change another member's Ask.
     - Agents never qualify. `workspace.conversation.create` is `human_only`, so agents hold no verb on it, and an agent acting for an admin cannot read another member's Ask. Agents reach an Ask only through its owner's Ask-bound envelope (item 3).
   - **Issuance.** No existing template carries this grant: owner template v1 is governance-only, and P05.T01z's `workspace-admin-v1` is frozen before the collaboration rows. Owner grant template v2 and the next admin template version (`workspace-admin-v2`) include it; `workspace-member-*` templates never do. Anyone else receives it only through a reviewed `governance.grants.revise` access change (ADR-0011: the beneficiary cannot approve it, except a solo owner with the typed phrase).
   - **What an admin read covers.** It is read-only and paged: the workspace's list of Asks, an Ask's conversation record and its message pages.
     - Message visibility stays all-of. The admin also needs `view` on `workspace.conversation.post` for the message fields and `view` on every restricted source of each message. A message citing a source the admin cannot view is omitted, exactly as for any other viewer.
     - Admins get no stream subscription, no Ask events, no inbox items and no post or mention in another member's Ask. Ask events and live streams stay owner-only.
     - A member who is neither the owner nor an admin gets the same `REFERENCE_NOT_FOUND` as for an unknown ID. An admin may learn that an Ask exists; that is the accepted disclosure of this rule.
   - **Audit.** Every admin read is audited, and an owner reading their own Ask, or listing only their own Asks, writes no record.
     - Each admin read (one page of the workspace's Ask list, one conversation fetch or one message page) appends one content-free `ask_admin_read` audit record. Every record holds the reader principal, the workspace, the read kind, the correlation ID and database time.
       - A conversation fetch or a message page also records that Ask's conversation ID, its owner principal and the number of messages returned.
       - A list page also records every other member's Ask that the page returned, as (conversation ID, owner principal) pairs in page order, at most 50. The reader's own Asks on the page are left out, because an owner's read of their own Ask is never audited.
       - A list page that returns no other member's Ask, an empty page included, still appends one record with no pairs, because it tells the admin that there are none.
     - The record is written in the same transaction as the read. Content leaves only after that transaction commits. If the insert or commit fails, or its outcome is unknown, no content is returned (fail closed); a retry is a new read with its own record.
     - Records are append-only and never contain message text. They follow the content-free audit metadata retention (365 days) and are exported through `governance.audit.export`.
   - **Disclosure to Ask owners.** The Ask screen tells its creator that workspace admins can read Asks and that each admin read is audited (P14).
   - **Not decided here.** Notifying the Ask owner of each admin read. A later ADR may add it.
   - **Other accepted disclosures (unchanged).** A viewer may learn that a streamed message started; a pinner may learn that the workspace holds 20 pins; the trust rank of P01.T02c §2 applies, and P01.T02b may refine it.
6. **EventEnvelope@2 (Q6).** It replaces the v1 envelope:
   - an additive event registry instead of a closed enum;
   - payloads that carry IDs and statuses only;
   - `payload` and `payloadRef` nulled together for a viewer who cannot see every payload field;
   - stream positions sealed per viewer.

   Inline versus by-reference delivery stays with P06.T02a within this shape.

## Consequences

- P01.T02c PR-A may start once its hard dependencies (P01.T02a PR-B, merged, and P06.T01a) merge. The packet's design, permission rows, P07.T03 binding, library API and acceptance case AC23 are updated for item 5.
- **P07.T03** enforces the admin path through a definer that writes the `ask_admin_read` record in the read's transaction, never through a plain RLS widening. Its conformance registration covers owner-only Ask RLS for every other path.
- **P05.T04b** adds the Ask-bound envelope (item 3). The plan's P05.T04b bullet records it.
- **Template v2 and `workspace-admin-v2`** carry the `administer` grant of item 5. P05.T02a's audited issuance can grant it to existing owners.
- **P14** shows the item 5 disclosure on Ask screens and offers admins no Ask stream or post controls.
- **Contract v1.1** stays a candidate until the Tier 3 P01 contract sign-off, which freezes it with these additions.

## Approval

Owner approval, 2026-10-18, in chat. Asked to accept the recommended answers to P01.T02c Q1-Q6, the owner selected **"Admins can see Asks"**:

> Same, but workspace admins can read private Asks.

"Same" refers to the recommended answers to Q1-Q6. The owner's answer replaces only Q5's "no administrator override".

The answer did not define "workspace admin" or say how admin reads are recorded. Item 5 defines the admin condition with the existing ADR-0010 ownership rule and the human-only capability of item 1 that creates Asks, so that no role title, ownership record or other grant confers the read, and it makes every admin read audited and fail-closed. Both narrow the owner's choice and add no authority beyond it.

## Amendments

### 2026-10-26: items 3 and 5, harness writes in an Ask and what viewers learn of requests (ADR-0041 and ADR-0040)

The owner's decision of 2026-10-26 (OD-2026-10-26-7, accepting ADR-0041 and ADR-0040 as recommended, owner question 33 included) changes these items as below (ADR-0041 item 33, ADR-0040 item 1); the text above is kept as approved.

- **Item 3** (ADR-0041 item 33). In a private Ask, the Ask-bound envelope allows named harness writes, each touching only the run's own state, with the Ask's owner as audience: `run.plan`, `run.complete`, `run.wait`, `agent.message` and `agent.cancel` on the run's own calls, `result.write` by teammates it calls, `memory.suggest`, `context.checkpoint` and the fork of ADR-0041 item 5. Teammate calls stay read-only, and `notebook.write`, `knowledge.propose`, `agent.propose` and `agent.route` stay refused in an Ask. `ask_admin_read` omits memory suggestions, checkpoints, compaction summaries, plans' notes and epochs, and `AskPrivacyNotice` says exactly what an admin read covers.
- **Item 5** (ADR-0040 item 1, owner question 33). The accepted disclosure becomes: a viewer of a shared conversation may learn that a request started there, and its state, teammates and times; a viewer never learns content, or a step, that they cannot see; a private Ask shows none of this to anyone but its owner, except through the audited admin read.
