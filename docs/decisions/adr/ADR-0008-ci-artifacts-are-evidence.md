# ADR-0008 CI runs and their uploaded artifacts are the evidence

- Status: Accepted
- Date: 2026-10-17
- Implements: the ADR-0002 evidence policy ("The engineering evidence is green CI on the exact commit")
- Renumbered: first committed as `docs/decisions/adr/0001-ci-artifacts-are-evidence.md`, which clashed with ADR-0001 and the `ADR-NNNN-*.md` naming. The decision is unchanged.

## Context

Verifiers, labs, the scaffold smoke test and the infrastructure compilers used to write their reports into tracked files under `docs/evidence`. A CI step quarantined those files before the run, and a collector compared, copied and restored them afterwards. Every local `npm run ci` rewrote tracked files, several with fresh timestamps, so a clean run still left a dirty tree. Labs that refused to overwrite an existing report could not run twice locally. The collector also pinned the exact workflow layout and report inventory, so adding or renaming a check meant editing the collector, its test and the workflow together.

## Decision

1. Generated outputs are not committed. Scripts write them through `scripts/artifacts.mjs` to `.artifacts/` at the repository root, or to `MORROW_ARTIFACTS_DIR` when that variable is set. `.artifacts/` is ignored by git and prettier and skipped by the repository secret scan.
2. A CI run and the artifacts it uploads are the evidence for that commit. CI sets `MORROW_ARTIFACTS_DIR` to a directory under the runner's temporary directory, outside the checkout. It was first uploaded as one artifact, `morrow-ci-<run id>-<attempt>`; since the parallel CI layout (docs/development/ci.md) each job or matrix leg uploads `morrow-<job>[-<shard or group>]-<run id>-<attempt>`. Artifacts are kept for 90 days.
3. Before upload, CI runs `scripts/scan-artifacts.mjs` over the artifact directory. The scan reports only paths and finding kinds, treats symbolic links as findings, and the upload runs only when the scan passes.
4. Every CI job ends with a clean-tree gate: `git status --porcelain --untracked-files=all` must print nothing after the job's commands. This replaces the collector's "source unchanged during CI" check. A local `npm run ci` does not enforce it, so work in progress can still be checked.
5. Step exit codes remain the pass/fail gate. Reports describe what ran; they do not decide the outcome.
6. Report writes overwrite earlier outputs. Exclusive-create (`wx`) and "report already exists" guards are removed from report writes only; private credential files keep exclusive creation.

## Consequences

- Inputs that had been stored next to reports move to input locations: the P01 review records to `docs/decisions/reviews/`, the recorded browser receipt to `docs/design/browser-checks.json`, and the observed E2B build 65 record to `tests/fixtures/e2b-observed-build-65.json`.
- `scripts/ci-validation-evidence.mjs`, its test, `scripts/index-evidence.mjs` and `docs/evidence/index.json` are removed. The frozen 71/74/75/80/82 regression steps leave CI because their only output was tracked reports; their scripts are retired separately.
- The previously committed reports remain readable in git history and under the tag `codex-archive-f89ad75`.
- Anyone who needs a report for a past run downloads that run's artifact within the retention window, or reruns the commit.
- The collector's workflow-shape assertions are replaced by `tests/ci-workflow.test.mjs`. It checks pinned actions, uncredentialed checkouts of the exact head, no `continue-on-error`, the scan gate on every upload, the clean-tree gate in every job, that `foundation` needs every other job, and that CI runs every `lab:*` script exactly once (except `lab:engine` and the `lab:e2b-*` operator commands). Per-report presence is not checked; exit codes decide (decision 5).

## Approval

Part of the P03.T04c overhaul the owner approved on 2026-10-17 by selecting **"Approve full overhaul (Recommended)"** (recorded in ADR-0001 and ADR-0002), whose scope includes "CI results replacing committed evidence".
