# ADR 0001: CI runs and their uploaded artifacts are the evidence

Status: accepted, October 2026.

## Context

Verifiers, labs, the scaffold smoke test and the infrastructure compilers used to write their reports into tracked files under `docs/evidence`. A CI step quarantined those files before the run, and a collector compared, copied and restored them afterwards. Every local `npm run ci` rewrote tracked files, several with fresh timestamps, so a clean run still left a dirty tree. Labs that refused to overwrite an existing report could not run twice locally. The collector also pinned the exact workflow layout and report inventory, so adding or renaming a check meant editing the collector, its test and the workflow together.

## Decision

1. Generated outputs are not committed. Scripts write them through `scripts/artifacts.mjs` to `.artifacts/` at the repository root, or to `MORROW_ARTIFACTS_DIR` when that variable is set. `.artifacts/` is ignored by git and prettier and skipped by the repository secret scan.
2. A CI run and the artifact it uploads are the evidence for that commit. CI sets `MORROW_ARTIFACTS_DIR` to a directory under the runner's temporary directory, outside the checkout, and uploads it as `morrow-ci-<run id>-<attempt>`. Artifacts are kept for 90 days.
3. Before upload, CI runs `scripts/scan-artifacts.mjs` over the artifact directory. The scan reports only paths and finding kinds, treats symbolic links as findings, and the upload runs only when the scan passes.
4. CI ends with a clean-tree gate: `git status --porcelain --untracked-files=all` must print nothing after the full run. This replaces the collector's "source unchanged during CI" check. A local `npm run ci` does not enforce it, so work in progress can still be checked.
5. Step exit codes remain the pass/fail gate. Reports describe what ran; they do not decide the outcome.
6. Report writes overwrite earlier outputs. Exclusive-create (`wx`) and "report already exists" guards are removed from report writes only; private credential files keep exclusive creation.

## Consequences

- Inputs that had been stored next to reports move to input locations: the P01 review records to `docs/decisions/reviews/`, the recorded browser receipt to `docs/design/browser-checks.json`, and the observed E2B build 65 record to `tests/fixtures/e2b-observed-build-65.json`.
- `scripts/ci-validation-evidence.mjs`, its test, `scripts/index-evidence.mjs` and `docs/evidence/index.json` are removed. The frozen 71/74/75/80/82 regression steps leave CI because their only output was tracked reports; their scripts are retired separately.
- The previously committed reports remain readable in git history and under the tag `codex-archive-f89ad75`.
- Anyone who needs a report for a past run downloads that run's artifact within the retention window, or reruns the commit.
