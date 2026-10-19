# ADR-0014 Merge authority and main as the trunk

- Status: Accepted
- Date: 2026-10-17
- Amends:
  - ADR-0002 "Flow", which had PRs target `codex/morrow-foundation` until the owner approved the first merge into `main`.
  - The plan's Package 3 rule that enforced repository protection must exist before merging release code.
- Amended: item 4, 2026-10-19 (P03.T04f OQ-1). See Amendments.
- Amended: item 5, 2026-10-19 (ADR-0019). See Amendments.

## Context

The overhaul (PR #2) passed hosted CI. Claude Code's permission check then blocked Claude from merging it as a "merge without review", because no record gave Claude merge authority. The owner then authorized merges explicitly.

## Decision

1. **Who merges.** Claude merges its own pull requests once both of these hold:
   - the hosted `foundation` check is green on the exact head;
   - the Tier 2 AI review (separate context, same model family) has passed, with its findings resolved or recorded.
2. **Trunk.** On 2026-10-17 the integration branch `codex/morrow-foundation` was merged into `main` through PR #1 (merge `f9ab367`).
   - Claude chose a merge commit, which keeps the reviewed history, over the squash merge that earlier drafts proposed. The owner's approval did not choose a merge strategy.
   - From now on `main` is the trunk. Each packet uses a short-lived `claude/<task-id>-<slug>` branch and a PR into `main`.
3. **Rules that still hold**, carried over from ADR-0002 "Flow":
   - Changes reach `main` only by merging a pull request. Nothing is pushed directly to `main`.
   - No force-push.
   - No tag deletion (this includes `codex-archive-f89ad75`) and no branch deletion without owner approval.
4. **Additional rules:**
   - No merge with a failing, cancelled or skipped required check. The `foundation` aggregator treats a skipped job as a failure (docs/development/ci.md).
   - No merge while a high-severity review finding is unresolved.
5. **Branch protection.** Enforced protection on `main` requires the `foundation` check and does not require an approving review, so a single GitHub account cannot deadlock. It must exist before privileged deployment (the first hosted deploy). It needs GitHub Pro or an organization on GitHub Team, which is a pending owner decision. Until then, the rules in items 3 and 4 are the protection.

## Consequences

- Routine merges do not wait on the owner. Material changes still need an owner-approved ADR before implementation (ADR-0002).
- GitHub records these merges under the owner's account, because Claude acts with the owner's token. Each PR Claude merges therefore states that Claude merged it under ADR-0014. Such a merge is not a Tier 3 owner approval.
- Deployment workflows can later run from `main`.

## Approval

Owner approval, 2026-10-17, in chat: "yes you are allowed to merge all the prs as you are the owner of the all the code being written".

## Amendments

### 2026-10-19: item 4, light CI runs (P03.T04f OQ-1)

The first bullet of item 4 now reads:

> No merge with a failing, cancelled or skipped required check. The `foundation` aggregator fails on any failed or cancelled job, and on any skipped job except the lab jobs that its `scope` job skips on a light run: a pull request whose changed files are all Markdown, or a push to `main` whose merged tree equals the merged pull request head (docs/development/ci.md).

The second bullet of item 4 is unchanged. The proposal and the alternatives are in `docs/packets/P03.T04f.md`, OQ-1.

Owner approval, 2026-10-19, in chat, answering P03.T04f OQ-1: "Allow both (Recommended)". That is option (a): both light paths, a Markdown-only pull request and a push to `main` whose merged tree equals the merged pull request head, with the amendment text above.

### 2026-10-19: item 5, branch protection before production (ADR-0019)

> Amendment 2026-10-19 (ADR-0019; owner decision, 2026-10-19, in chat). Item 5 now reads: "Enforced protection on `main` requires the `foundation` check and no approving review. It must exist before the first production deployment, production credential or production resource. It needs GitHub Pro or Team, a purchase the owner approves per action. Staging deploys do not wait for it." Until protection exists, items 3 and 4 are rules, not controls. An account that can push to `main` can change `deploy-staging.yml`, `ci.yml` or `scripts/staging.mjs` in the same push. It therefore controls the staging deploy token, which can deploy a broker that reads every staging broker secret. This is accepted for staging only, which holds synthetic data and the owner's test identity. Mitigations: only the owner's account can push, and every other app, token, deploy key and collaborator is removed before the first deploy. If GitHub Pro is bought, protection is enabled at once.

Owner approval, 2026-10-19, in chat. The staging plan, which made branch protection (Pro) a hard gate before production and not before staging, was approved with "yes this plan looks good" (ADR-0019, Approval). ADR-0019, which carries this amendment, was approved with "Approve both (Recommended)". On P04.T01i OQ-2 the owner chose "GitHub Pro (Recommended)", so protection is enabled as soon as the Pro purchase is active.
