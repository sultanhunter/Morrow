# ADR-0017 Membership authority and the membership contract additions

- Status: Accepted
- Date: 2026-10-18
- Applies: ADR-0004 item 4, ADR-0005, ADR-0009 items 3, 7, 10 and 11, ADR-0011 Q1-Q2 (none is changed)
- Affects: P05.T01z (PR-A and PR-B), P05.T02a (grant-row helpers and the `governance.grants.revise` producer), P06.T01b (approval records consumed), P01.T02a Q11, P14 (members settings), `@morrow/contracts/membership-templates`, `docs/contracts/{schemas/v1.1/core.schema.json, work-api.md, identity-authority.md, approvals.md}`

## Context

Packet P05.T01z adds invitations and audited membership commands. Today memberships and grants come only from owner SQL or the signup template, and there is no invitation, role change or ownership transfer. Workspace-scope removal, owner designations, owner protection and the KillSwitchRecord apply ADR-0004, ADR-0005, ADR-0009 and ADR-0011 and are routine. Two questions are material under ADR-0002:

- **Q1, the membership authority model** (authority);
- **Q3, the v1.1 contract edits** (public contract).

The email match at acceptance comes from plan R1. ADR-0009 item 11 left open whether acceptance also checks a verified email; P05.T01z implements the plan's rule as a necessary condition that never confers authority on its own.

## Decision

The recommended answers to P05.T01z Q1 and Q3 are adopted.

1. **Templates (Q1).**
   - Authority is grants only. A "role" is a named, frozen grant template, recorded for display and used only to restrict; the kernel never reads it.
   - Two invitation templates, `workspace-member-v1` and `workspace-admin-v1`, exactly as P05.T01z §2.3 lists them. `workspace-member-v1` holds the five P06.T01a work capabilities (`view` and `execute`, or `execute` alone for assignment and answers) and no governance row. `workspace-admin-v1` adds `administer` on goals, tasks, assignment and question requests, plus the eight `owner-bootstrap-v1` governance rows.
   - A contract check pins both lists. Once template v2 exists, a second check asserts that v2 covers every capability, verb and field of `workspace-admin-v1`, so that a v2 owner can issue both.
2. **No amplification (Q1).** Proposing or applying an invitation or a template change requires that the actor currently holds every verb and field of every grant in the template, by kernel decision in the workspace. Otherwise the result is 403 `amplification_denied`. A signup owner who holds only template v1 therefore cannot invite with either template until it holds template v2.
3. **Expiry (Q1).**
   - Template grants never expire (`expiresAt: null`).
   - A later loss of the issuer's authority does not shorten grants already issued. It cancels the issuer's open invitations instead: when the issuer is removed, when its template changes, and when P05.T02a revokes an issuer grant in that workspace.
4. **Organization-scope removal (Q1).**
   - Removing a person from the whole organization needs a kernel allow for `execute` on `governance.membership.revoke` in **every** active workspace of the organization, each against that workspace's own grants and never unioned. Otherwise the result is 403 `organization_scope_denied`.
   - The removal signs the person out organization-wide through the P05.T01y watermark (ADR-0004 item 4).
5. **Template change and ownership transfer (Q1).**
   - Both are reviewed access_change proposals, as variants of `governance.grants.revise` (`membership.template_change` and `owner.transfer`). No new capability is added.
   - The owner's membership must keep a governance-bearing template (`owner-bootstrap-v1` or `workspace-admin-v1`), and an incoming owner must currently hold one in the workspace. Otherwise the result is 403 `owner_template_required`.
6. **Admin reads (Q1).** Member and invitation lists reuse the command grants: `execute` on `governance.membership.revoke` for members, and `execute` on `governance.membership.invite` for invitations.
7. **Contract additions (Q3).** These are deliberate edits while v1.1 is a candidate. If v1.1 is frozen when a PR merges, they open v1.2 (ADR-0009 item 5).
   - **Settling P01.T02a Q11 (PR-A).** Add a closed `ConnectionRef = {organizationId, workspaceId, storeId: Id|null, connectionId: Id, kind:"connection", id: Id}`, with the library rule `id === connectionId`. Add `KillSwitchTargetRef = anyOf[v1 ResourceRef, ConnectionRef]`. `KillSwitchRecord.targets` becomes `KillSwitchTargetRef[1..100]`. Both are new names, so `changes.json` is unchanged and only `release-baseline.json` hashes are updated.
   - **Account contract (PR-B).** Add `InvitationAcceptRequest` and `InvitationAcceptResult`. Work-route bodies go in `docs/contracts/work-api.md`, which is routine under ADR-0010 item 3.
   - **Not edited.** The `governance.membership.{invite,revoke}` and `governance.grants.revise` bodies. Changing them would orphan owner template v1's fields, whose rows are never rewritten.

## Consequences

- P05.T01z PR-A and PR-B may proceed under their stated dependencies. PR-B still needs P06.T01b with its `taskId` question decided (ADR-0018) and P05.T01y.
- The hosted invitation delivery channel is not decided here. A follow-up lettered child owns it, with its own owner question.
- Invitee emails are personal data. Proposals for addresses off the recipient allowlist are refused before anything is stored, until P09.T05 covers invitations (ADR-0003 hard ordering (b)).
- **Asks (ADR-0016).** `workspace-admin-v1` predates the collaboration capabilities, so it does not carry the `administer` grant on `workspace.conversation.create` that ADR-0016 item 5 requires to read other members' Asks. `workspace-admin-v2` adds it; v1 templates stay frozen.
- **Alternative not taken.** A dedicated `governance.ownership.transfer` capability would be a v1.1 catalogue addition that existing owners would then need through P05.T02a issuance.
- **Alternative not taken.** A v1.1 replacement of `ResourceRef` adding kind `connection` was rejected because it would re-type every Scope and reference.

## Approval

Owner approval, 2026-10-18, in chat. Asked about P05.T01z Q1 (membership authority model) and Q3 (v1.1 contract edits), the owner selected **"Accept recommended (Recommended)"**:

> Adopt the membership model and the contract additions as designed.

This accepts the recommended answers to Q1 and Q3 as written in `docs/packets/P05.T01z.md` (revision of 2026-10-18), which items 1-7 restate. The answer did not restate each part; the items above are the packet's recommended answers without change.
