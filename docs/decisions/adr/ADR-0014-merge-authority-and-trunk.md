# ADR-0014 Merge authority and main as the trunk

- Status: Accepted
- Date: 2026-10-17
- Amends: ADR-0002 "Flow", which said PRs target `codex/morrow-foundation` until the owner approves the first merge into `main` and that the owner merges.

## Context

The overhaul (PR #2) passed hosted CI twice. Claude Code's permission check then blocked Claude from merging it as a "merge without review", because ADR-0002 did not give Claude merge authority. The owner then authorized merges explicitly.

## Decision

1. Claude merges its own pull requests after two conditions hold:
   - the hosted `foundation` check is green on the exact head;
   - the Tier 2 AI review (separate context, same model family) has passed, with its findings resolved or recorded.
2. The integration branch `codex/morrow-foundation` is merged into `main` once, with a merge commit that keeps the history. From then on `main` is the trunk: each packet uses a short-lived `claude/<task-id>-<slug>` branch and a PR into `main`.
3. These rules from ADR-0002 still apply:
   - no force-push;
   - no deletion of tags (including `codex-archive-f89ad75`);
   - no merging with a failing or skipped required check;
   - no bypassing review findings marked high severity.
4. Before the first hosted deploy, `main` gets enforced branch protection that requires `foundation`. This needs GitHub Pro or an organization, which is a pending owner decision. Until then, the rules above are the protection.

## Consequences

- Delivery does not wait on the owner for routine merges. Material changes still need an owner-approved ADR before implementation (ADR-0002).
- Because `main` carries the reviewed history, deployment workflows can later trigger from it.

## Approval

Owner approval, 2026-10-17, in chat: "yes you are allowed to merge all the prs as you are the owner of the all the code being written".
