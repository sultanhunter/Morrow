# ADR-0004 Browser session lifecycle defaults

- Status: Accepted
- Date: 2026-10-17
- Affects: P05.T01y, P05.T01z, migrations (new forward migration only)

## Context

Delivered browser sessions (migration 0008, P05.T01m to P05.T01q) have a hard 15-minute absolute lifetime. Generation is fixed by `CHECK (current_generation = 1)`. Logout retires the current family without sending `Set-Cookie`. People cannot work a normal day under those limits.

## Decision

1. **Rotation.** Generations rotate. Presenting a retired generation (reuse detection) revokes the whole family.
2. **Lifetime.** Each session has a 30-minute idle limit and a 12-hour absolute limit. Rotation may advance a live family's generation within the idle limit, but never past its absolute limit.
3. **Logout.** Logout ends only the captured session family. It responds with `Set-Cookie` set to `Max-Age=0` for the session cookie.
4. **Revocation scope.**
   - Removing a person's **organization** membership (P05.T01z) signs that person out of every session family in that organization.
   - Removing a **workspace** membership revokes that workspace's grants, advances its policy revision and stops that workspace from resolving in every session. Other independently eligible workspaces are unaffected, which preserves the delivered P05.T01c/T01m rule.
5. **Irreversibility.** Revoking a family, a generation or a provider-session binding is irreversible and audited. Nothing revives a revoked or expired family. Fresh provider evidence may create a new family only for an unrevoked binding.
6. **Migrations.** These changes ship as a **new forward migration**. Applied migrations, including 0008, are immutable.

## Consequences

- P05.T01y replaces the 15-minute absolute limit and the fixed generation.
- Tests cover reuse detection, the idle limit, the absolute limit, logout cookie clearing, both revocation scopes, and irreversibility.

## Approval

Owner approval, 2026-10-17, in chat: **"Accept proposed defaults (Recommended)"**. The text approved was: "Sessions: rotating, 30-min idle / 12-h absolute, logout clears cookie."

Points 4 and 5 are not new choices. They keep the existing delivered revocation rules and make them explicit for rotation. If the owner wants workspace removal to sign a person out of the whole organization, a superseding ADR records that.
