# ADR-0001 Plan authority moves into the repository

- Status: Accepted
- Date: 2026-10-17
- Supersedes: AGENTS.md "Canonical build plan" steps 1–4 (ChatGPT Page as the sole authority)

## Context

From 6 to 17 October 2026, the only plan authority was a ChatGPT Pages document (`page_b1ef27b80b788191b91e67cbb52f1037`). The coding agent mirrored it into `docs/plan/build-plan.md` after every revision.

- The Page reached sequence 95. The repository snapshot stopped at sequence 94.
- Sequence 95 only added the "P05.T01w Genuine Firefox transport prerequisite" packet, which ADR-0003 defers.
- Claude Code, which now builds Morrow, cannot read or write that Page.
- Under the previous rules, an unreachable Page meant inspection only, so no implementation could proceed.

## Decision

1. `docs/plan/build-plan.md` in git is the plan of record from revision R1 (2026-10-17). Git history records each revision; there is no sequence counter.
2. Material decisions are recorded under `docs/decisions/adr/ADR-NNNN-*.md` **before** dependent implementation. Each record quotes the owner's approval and its date. ADR-0002 defines "material".
3. The ChatGPT Page is frozen at sequence 95 and kept as history. It is not edited further and confers no authority.
4. `docs/references/*` (HLD, skills/Agent Store, visual foundation) remain supporting detail. Where they conflict with the plan, the plan wins.
5. `scripts/sync-plan.mjs` and `npm run plan:sync` are removed. `npm run verify:foundation`, which runs in `npm run verify` and in CI, checks the plan instead: the parent task IDs (80) and acceptance IDs (73) found in `build-plan.md` must equal, in order, those in `docs/progress/tasks.json`, across 18 packages. There is no separate `plan:check` script and no line-length or governance lint (correction, 2026-10-17: an earlier wording of this item promised both).

## Consequences

- Plan edits are ordinary reviewed commits. Tests and lab reports must not digest plan bytes or assert a plan sequence; P03.T04c removes that coupling.
- Pre-R1 history (the Page sequences, evidence, archived plan copies) remains recoverable from the annotated tag `codex-archive-f89ad75`.
- The owner reviews plan changes in pull requests instead of in the Page.

## Approval

Owner approval, 2026-10-17, in chat:
- The owner pointed Claude to the repository plan ("it has buildplan.md check it").
- The owner selected **"Approve full overhaul (Recommended)"**, which made the repo plan the plan of record.
