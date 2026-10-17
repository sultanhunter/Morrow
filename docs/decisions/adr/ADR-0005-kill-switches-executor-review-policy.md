# ADR-0005 Kill switches, executor classes and review policy

- Status: Accepted
- Date: 2026-10-17
- Affects: P01.T02a (contract v1.1), P11.T02, P11.T03, P11.T05, `docs/contracts/capabilities.json`

## Context

Five emergency controls currently have `review_required: true` in `capabilities.json`. That means each one waits for a second reviewer:

- `ads.campaign.pause`
- `agents.installation.disable`
- `governance.membership.revoke`
- `governance.connection.disconnect`
- `agents.release.revoke`

The contracts also do not say who may approve a proposal, whether self-approval is allowed, or which actions an agent may ever execute.

## Decision

1. **Kill switches.**
   - The five capabilities above get executor class `human_only` and `review_required: false`.
   - Each one still requires all of the following:
     - a current eligible human grant;
     - a recorded reason;
     - an append-only audit record;
     - owner notification.
   - Agents may propose these actions but never execute them.
   - Reversal (unpause, re-enable, reconnect, re-grant) remains a reviewed action.
   - P11.T05 adds tenant-wide, installation-wide and platform-wide stop controls at the gateway.
2. **Executor classes.** Each capability declares one:
   - `human_only`: governance grant, membership, connection and delegation changes, plus the kill switches.
   - `agent_after_approval`: spend, communication and external writes. The approval digest binds the exact content, recipients and amounts.
3. **ReviewPolicy.**
   - Approvers must hold an eligible reviewer grant.
   - No self-approval for spend, communication, access change or irreversible-risk proposals.
   - Each risk class may set an optional quorum and a default expiry.
   - Approving part of a proposal produces a new derived digest.
   - A workspace with a single owner may self-approve, with typed confirmation and a cool-down.

## Consequences

- P01.T02a adds the `executor` field and the ReviewPolicy schema in an additive contract v1.1. It updates `capabilities.json` and regenerates the validators.
- Agent permission intersection is unchanged: titles and delegation never confer authority.

## Approval

Owner approval, 2026-10-17, in chat: **"Accept proposed defaults (Recommended)"**. The approved text was:

> Kill switches (pause ads, disable agent, revoke member, disconnect store, revoke release) are human-only and act without a second approver. No self-approval for spend/messages/access changes, except a solo owner with typed confirmation.
