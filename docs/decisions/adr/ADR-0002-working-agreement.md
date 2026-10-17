# ADR-0002 Working agreement, evidence policy and review tiers

- Status: Accepted
- Date: 2026-10-17
- Supersedes: the AGENTS.md "Canonical NN" increment rules, the evidence-only commit pattern, "preserve all N historical records" constraints, exact inventory counts, plan-sequence and source hash-lock assertions, and the Source/Publisher/Desktop "guarded alignment" ritual

## Context

Between 6 and 17 October 2026 the plan was revised 67 times. About 22 sub-increments went into login transport hardening, and the last six were under 1% product code.

- Committed evidence and history reached about 70 MB, roughly 85% of the repository.
- Tests asserted plan sequence numbers and hashes of production modules, so legitimate fixes broke CI.
- Each increment ended with a separate evidence-only commit and CI run.
- Reviews by the same model were labelled "independent".

## Decision

**Change classification.**

- *Material* changes need an ADR, approved by the owner in chat, before any dependent code. Material means:
  - product scope;
  - the 18-package / task-ID structure;
  - the authority or permission model;
  - tenancy, data ownership or retention;
  - public contracts;
  - provider or model selection;
  - billing, pricing or credits;
  - qualification gates and dependency edges;
  - deployment boundaries;
  - spending money;
  - real merchant or customer data;
  - external messages;
  - creating provider resources.
- *Routine* changes are plain commits with tests. Routine means:
  - test, fixture and timing fixes;
  - harness and CI structure;
  - refactors, layout and dependency bumps within approved major versions;
  - lettered packet splits;
  - wording.

**Evidence.**

- The engineering evidence is green CI on the exact commit. Lab and verify outputs go to the git-ignored `.artifacts/` directory and are uploaded as GitHub Actions artifacts.
- Commit only:
  - live-provider effect records in `docs/evidence/live/YYYY-MM-DD-<provider>-<action>.md` (approval, exact action, resources, cap and observed cost, cleanup, unknown-outcome status);
  - human-gated results;
  - acceptance tables in `docs/acceptance/PNN.md` (case ID → test);
  - ADRs.
- `docs/evidence/**` and `docs/history/**` leave the tree. Annotated tag `codex-archive-f89ad75` preserves them, and `docs/history/INDEX.md` explains how to recover them.

**Tests.**

- Keep behavioural security tests, the migration manifest checksum, generated-contract drift checks, import-boundary checks and the secret scan.
- Remove plan-sequence assertions, plan/AGENTS/packet digests, production-module hash locks, exact inventory counts and "report already exists" guards.
- `npm run ci` must leave the tree clean.

**Review tiers.**

- *Tier 1 (every PR):* the implementer runs the targeted tests and the full local pipeline.
- *Tier 2:* a separate-context Claude reviewer examines only the diff, the packet, the contracts it consumes and the relevant ADRs. Security review is mandatory for changes to authority, RLS, migrations, credentials, provider adapters, approvals/budgets/billing and durable execution. Findings go in the PR. Label this tier "AI review (separate context, same model family)". Never call it independent, and never commit it as qualification evidence.
- *Tier 3 (owner):* material ADRs, provider/paid/live effects, launch gates, P01 contract sign-off and P02 participant qualification.

**Flow.**

- One short-lived branch and one PR per bounded packet. The PR targets the integration branch `codex/morrow-foundation` until the owner approves the first merge into `main`. Merge on green CI.
- No push to `main`, no force-push, and no tag or branch deletion without owner approval.
- Work happens directly in `/Users/sultanibneusman/Desktop/Morrow`. The guarded-alignment and receipt rituals are retired.

**Status.**

- `docs/progress/STATUS.md` (at most 80 lines, rewritten in place) replaces the append-only `checkpoint.md`. That file is frozen as history.
- `CLAUDE.md` (at most about 150 lines) holds the working rules. `AGENTS.md` becomes a pointer to it.

## Consequences

- Any legitimate fix no longer requires a plan revision.
- Provenance comes from git, CI and the archive tag instead of committed JSON.
- AI review is honestly labelled, so the human gates keep their meaning.

## Approval

Owner approval, 2026-10-17, in chat: **"Approve full overhaul (Recommended)"**. The approved scope covered:
- the repo plan as plan of record;
- CI results replacing committed evidence;
- archiving about 70 MB of evidence and history to a git tag and removing it from the tree;
- removing plan-number and hash-lock assertions;
- `CLAUDE.md` and `STATUS.md` replacing `AGENTS.md` and the checkpoint;
- AI review labelled honestly.
