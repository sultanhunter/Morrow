# ADR-0005 Billing state of a workspace before any Shopify store is installed

- Status: Accepted
- Date: 2026-10-17
- Affects: P01.T04a, P11.T04, P18 billing tasks, `docs/decisions/billing-ownership.md`

## Context

Morrow supports workspace-first signup, has no free merchant tier, and bills through Shopify App Pricing on the shop installation. Taken together, these left one state undefined: a workspace created on Morrow's website before any shop is installed has no billing principal.

## Decision

A workspace with no linked shop installation may do the following:
- sign up and set up the workspace;
- invite members and manage membership and grants;
- complete onboarding;
- connect non-Shopify identity, such as SSO later.

That workspace **cannot dispatch paid work**. Paid work means any model, connector-write or execution work that reserves work credits. Paid work becomes available only when both of the following hold:
1. a linked shop installation has an active Shopify App Pricing subscription;
2. its credit balance covers the reservation.

Reads, approvals of already-reserved work, and exports continue regardless of balance, as before.

Acceptance cases to add under P01.T04a / P11.T04:
- paid dispatch is denied before install;
- the workspace becomes billable at link time;
- credit allocation across multiple stores in one workspace.

Whether to pursue any direct (non-Shopify) billing exception is **pending an owner decision**. Until decided, there is no payments provider. Package prices and credit quantities remain open for P18.

## Approval

Owner approval, 2026-10-17, in chat: **"Accept proposed defaults (Recommended)"**. The default reads: "Pre-install workspaces can onboard and invite but can't run paid work until a linked shop has a Shopify App Pricing subscription."
