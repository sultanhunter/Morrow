# ADR-0004 Session lifetime, kill switches, review policy and executor classes

- Status: Accepted
- Date: 2026-10-17
- Affects: P05.T01y, P11.T02/T03/T05, P01.T02a (contract v1.1), `docs/contracts/capabilities.json`

## Context

Several gaps in the authority model needed owner decisions before they could be built:

- **Sessions.** Browser sessions have a hard 15-minute absolute lifetime and a fixed generation: migration 0008 contains `CHECK (current_generation = 1)`. Logout returns no `Set-Cookie`.
- **Kill switches.** All five capabilities have `review_required: true`, so an emergency stop has to wait for a second reviewer. The five are `ads.campaign.pause`, `agents.installation.disable`, `governance.membership.revoke`, `governance.connection.disconnect` and `agents.release.revoke`.
- **Approval rules.** Nothing defines who may approve what, or whether self-approval is allowed.

## Decision

**1. Session lifecycle (P05.T01y).**
- Generations rotate. Reuse of a retired generation revokes the whole family.
- Idle limit: 30 minutes. Absolute limit: 12 hours.
- Logout sends `Set-Cookie` with `Max-Age=0`.
- Membership revocation triggers organization-wide sign-out.
- This is implemented by a **new forward migration**. Applied migrations, including 0008, are never edited.

**2. Kill switches.**
- The five capabilities above become executor class `human_only` with `review_required: false`.
- Each still requires:
  - a current eligible human grant;
  - a recorded reason;
  - an append-only audit record;
  - owner notification.
- Agents may *propose* them but can never execute them.
- Reversal (unpause, re-enable, reconnect, re-grant) stays a reviewed action.
- P11.T05 adds tenant-wide, installation-wide and platform-wide stop controls at the gateway.

**3. ReviewPolicy.**
- Approvers must hold an eligible reviewer grant.
- No self-approval for spend, communication, access change or irreversible-risk proposals.
- Each risk class may set an optional quorum and a default expiry.
- Partially approving selected items produces a new derived digest.
- A solo-owner workspace may self-approve. It needs a typed confirmation and a cool-down.

**4. Executor classes.**
- `human_only`: governance grant, membership, connection and delegation changes, plus the kill switches.
- `agent_after_approval`: spend, communication and external writes. The exact content, recipients and amounts are bound in the approval digest.

## Consequences

- P01.T02a adds the `executor` field and the ReviewPolicy schema in an additive contract v1.1.
- `capabilities.json` is updated with regenerated validators.
- Agent permission intersection is unchanged: titles and delegation still never confer authority.

## Approval

Owner approval, 2026-10-17, in chat: **"Accept proposed defaults (Recommended)"**. The approved defaults were:
- sessions rotate, with a 30-minute idle and 12-hour absolute limit, and logout clears the cookie;
- kill switches (pause ads, disable agent, revoke member, disconnect store, revoke release) are human-only and act without a second approver;
- no self-approval for spend, messages or access changes, except a solo owner with typed confirmation.
