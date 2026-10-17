# Architecture and owner decision records

Material decisions (ADR-0002) are recorded here before dependent implementation. Each record states its context, decision and consequences, and quotes the owner's approval with its date. A decision changes only through a new ADR that supersedes it.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](ADR-0001-plan-authority.md) | Plan authority moves into the repository | Accepted 2026-10-17 |
| [0002](ADR-0002-working-agreement.md) | Working agreement, evidence policy and review tiers | Accepted 2026-10-17 |
| [0003](ADR-0003-sequencing-and-gates.md) | Two-track sequencing, P02 gate split, golden path, P05.T01w deferral | Accepted 2026-10-17 |
| [0004](ADR-0004-authority-session-defaults.md) | Session lifetime, kill switches, review policy, executor classes | Accepted 2026-10-17 |
| [0005](ADR-0005-pre-install-billing-state.md) | Billing state before any Shopify store is installed | Accepted 2026-10-17 |
| [0007](ADR-0007-retire-aws-cdk-daytona-frozen-regressions.md) | Retire the AWS CDK foundation, the Daytona laboratory and the frozen WorkOS operator regressions | Accepted 2026-10-17 |
| [0008](ADR-0008-ci-artifacts-are-evidence.md) | CI runs and their uploaded artifacts are the evidence | Accepted 2026-10-17 |

Number 0006 is reserved for the R1 governance revision of this set.

Decisions made before 2026-10-17 are in `docs/decisions/*.md` and `*.json` and in the plan. They remain in force unless an ADR here supersedes them.
