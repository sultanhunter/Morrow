# Architecture and owner decision records

Material decisions (ADR-0002) are recorded here before dependent implementation. Each record states its context, decision and consequences, and quotes the owner's approval with its date. A decision changes only through a new ADR that supersedes it.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](ADR-0001-plan-authority.md) | Plan authority moves into the repository | Accepted 2026-10-17 |
| [0002](ADR-0002-working-agreement.md) | Working agreement, evidence policy and review tiers | Accepted 2026-10-17; Flow amended by ADR-0014 |
| [0003](ADR-0003-sequencing-and-gates.md) | Two-track sequencing, P02 gate split, golden path, P05.T01w deferral | Accepted 2026-10-17 |
| [0004](ADR-0004-session-lifecycle.md) | Browser session lifecycle defaults | Accepted 2026-10-17 |
| [0005](ADR-0005-kill-switches-executor-review-policy.md) | Kill switches, executor classes and review policy | Accepted 2026-10-17 |
| [0006](ADR-0006-pre-install-billing-state.md) | Billing state before any Shopify store is installed | Superseded by ADR-0015 (2026-10-18); accepted 2026-10-17 |
| [0007](ADR-0007-broker-credential-custody-v0.md) | Broker credential custody v0 for development and staging | Accepted 2026-10-17 for development and staging only; production custody pending |
| [0008](ADR-0008-shopify-connector-runtime.md) | Shopify connector runtime: Cloudflare Workers with the `@shopify/shopify-api` web adapter | Accepted 2026-10-18 |
| [0009](ADR-0009-self-serve-signup.md) | Self-serve enrollment and first-owner signup | Accepted 2026-10-17; note added for ADR-0015 |
| [0010](ADR-0010-tenant-data-pattern-and-work-api-v1.md) | Tenant data pattern for P06+ and work API v1 | Accepted 2026-10-17; item 1 refined by ADR-0016 |
| [0011](ADR-0011-review-policy-and-contract-v1-1.md) | Contract v1.1: review policy and exact proposals | Accepted 2026-10-17; Q1 `requestedBy` refined by ADR-0018 |
| [0012](ADR-0012-ci-artifacts-are-evidence.md) | CI runs and their uploaded artifacts are the evidence | Accepted 2026-10-17 |
| [0013](ADR-0013-retire-aws-cdk-daytona-frozen-regressions.md) | Retire the AWS CDK foundation, the Daytona laboratory and the frozen WorkOS operator regressions | Accepted 2026-10-17 |
| [0014](ADR-0014-merge-authority-and-trunk.md) | Merge authority and main as the trunk | Accepted 2026-10-17 |
| [0015](ADR-0015-billing-routes-by-origin.md) | Billing routes by origin: Morrow checkout on Stripe Billing and Stripe Tax, Shopify App Pricing for Shopify-origin merchants | Accepted 2026-10-18; supersedes ADR-0006; follow-up decisions on P01.T04a OQ-1 to OQ-3 |
| [0016](ADR-0016-collaboration-contracts-v1-1.md) | Collaboration contracts v1.1: conversations, Asks, mentions, inbox, projects and EventEnvelope@2 | Accepted 2026-10-18 |
| [0017](ADR-0017-membership-authority.md) | Membership authority and the membership contract additions | Accepted 2026-10-18 |
| [0018](ADR-0018-proposals-without-a-task.md) | Proposals without a task: human governance proposals only | Accepted 2026-10-18 |

ADR-0012 and ADR-0013 record how the P03.T04c overhaul implemented ADR-0002; earlier drafts of them used the numbers 0001, 0007 and 0008.

Decisions made before 2026-10-17 are in `docs/decisions/*.md` and `*.json` and in the plan. They remain in force unless an ADR here supersedes them.
