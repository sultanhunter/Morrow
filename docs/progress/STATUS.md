# Morrow status

Updated 2026-10-17. Rewrite this file in place (at most 80 lines). The pre-overhaul append-only checkpoint is preserved as `git show codex-archive-f89ad75:docs/progress/checkpoint.md`.

## Active packet

P03.T04c repository overhaul on branch `claude/p03-t04c-overhaul` (base `f89ad75`; tag `codex-archive-f89ad75` preserves the pre-overhaul tree). Owner-approved scope: ADR-0001 (plan of record in the repository) and ADR-0002 (working agreement and evidence policy).

1. Done: generated outputs go to `.artifacts/`; evidence-only CI machinery removed (ADR 0001 CI artifacts).
2. Done: remove plan-sequence, plan/AGENTS/packet digest and production-module byte-lock coupling. Native WorkOS operators 74/75/82 are retired by explicit unconditional denials, and E2B allocation/build/image/template work is denied by the committed gate `infra/labs/e2b-activation.json` (`active_profile_sequence: null`). Published migrations are pinned by `tests/migration-history.test.mjs`; labs accept later migrations after the original eleven.
3. This step: retire AWS CDK, Daytona and the frozen 71/74/75/80/82 regressions (ADR-0007, which cites the terminal provider evidence); remove `aws-cdk-lib`, `constructs`, `@daytona/sdk` and the `brace-expansion` pin and regenerate the lockfile (removals only); delete `docs/plan/source.json`. `npm run ci` no longer runs `deps:repair`.
4. Next: delete `docs/evidence` and `docs/history` from the tree and add `docs/history/INDEX.md`.
5. Then: parallel CI workflow with a `foundation` aggregator job.

## Last green commit

`f89ad75` (Record native workspace API verification), CI run 38979693185. Branch commits after `f89ad75` have not run in hosted CI yet.

## Next action

Implement overhaul step 4, then push the branch and confirm the full CI run, including the three Linux-only pg-wire labs.

## Blockers

None for local engineering. Hosted staging work (M1 and later) waits on the owner actions below.

## Pending owner actions

- Sign-ins and accounts:
  - register the domain and connect it to Cloudflare;
  - Neon CLI authentication and an operator password reset;
  - WorkOS callback configuration and key rotation, once the domain exists;
  - Shopify Partner account and a development store (never the live shop);
  - OpenAI staging project.
- Upgrade to GitHub Pro before the first deployment, so branch protection is enforced on the private repository.
- Rotate every credential the previous Codex working directory held. Agents must not read that directory.
- Install the drafted `CLAUDE.md` and the pointer `AGENTS.md`. They are agent instruction files, so the owner places them directly; the current `AGENTS.md` still describes the retired Page workflow.

## Open unknown-outcome provider operations

None. These are console clean-up items with known outcomes, not unknown operations:

- E2B template `pdht65h2trfuizuvmotc` with build `4324bde3` (ready and retained);
- E2B API key "Morrow-qualification-2026-10-14";
- WorkOS staging test user and the loopback callback `127.0.0.1:4110`.

## Active approval cards

None. Every earlier provider allowance (E2B 65/66/67, WorkOS 71/74/75/80/82) is consumed.
