# History index

Before the P03.T04c overhaul, the repository committed every lab, verifier and CI report under `docs/evidence/`, and kept frozen source closures, plan snapshots and superseded records under `docs/history/`. Together they were about 70 MB (1,123 evidence files and 498 history files). ADR-0002 takes both directories out of the working tree. Nothing under `scripts/`, `tests/`, `packages/`, `apps/`, `infra/` or `.github/` reads them.

They are preserved, byte for byte, at an annotated tag:

| Tag | Commit |
| --- | --- |
| `codex-archive-f89ad75` | `f89ad7584eb1e12a061f8ef92330b0f3484fc043` (Record native workspace API verification) |

## How to read the archive

Read one file:

```sh
git show codex-archive-f89ad75:docs/evidence/P05.T01v/workspace-api-workers.json
git show codex-archive-f89ad75:docs/history/workos-operator-74/archive.json
```

List a directory:

```sh
git ls-tree -r --name-only codex-archive-f89ad75 docs/evidence/P04.T01h
```

Check out the whole archived tree in its own worktree, never in this checkout:

```sh
git worktree add "$TMPDIR/morrow-archive" codex-archive-f89ad75
```

Remove it afterwards with `git worktree remove "$TMPDIR/morrow-archive"`. The archived tree's scripts and lockfile are the originals. Their native provider paths were already denied at that commit; ADR-0007 describes the optional replay.

Older documents still link to `docs/evidence/...` and `docs/history/...`, in particular `docs/packets/*.md`, `docs/plan/build-plan.md`, `docs/progress/checkpoint.md` (now at the tag only) and ADR-0007. Read any of those links as `codex-archive-f89ad75:<path>`. Migration review records in `migrations/manifest.json` and the provider-lab evidence fields in `docs/decisions/morrow-provider-lab.json` are already written in that form.

## Evidence from here on

- The engineering evidence for a commit is its green CI run and the artifact that run uploads (ADR 0001 CI artifacts, ADR-0002). Labs and verifiers write to the git-ignored `.artifacts/` directory, or to `MORROW_ARTIFACTS_DIR`. CI secret-scans that directory before upload and keeps the artifact for 90 days.
- Reports are not committed. To see a past report, download that run's artifact within the retention window or rerun the commit.
- Commit only what ADR-0002 lists: live-provider effect records in `docs/evidence/live/YYYY-MM-DD-<provider>-<action>.md`, human-gated results, acceptance tables in `docs/acceptance/PNN.md`, and ADRs.

Inputs that code reads were moved out of `docs/evidence/` first, with the same bytes:

| Former path | Current path |
| --- | --- |
| `docs/evidence/P01.T02/review.md` | `docs/decisions/reviews/P01.T02-review.md` |
| `docs/evidence/P01.T03/review.md` | `docs/decisions/reviews/P01.T03-review.md` |
| `docs/evidence/P01.T04/review.md` | `docs/decisions/reviews/P01.T04-review.md` |
| `docs/evidence/P02.T03/browser-checks.json` | `docs/design/browser-checks.json` |
| `docs/evidence/P04.T01h/history/build-65/owned-build-qualification.json` | `tests/fixtures/e2b-observed-build-65.json` |

`infra/labs/e2b-development-account.json` still names the 65 builder price record (`docs/evidence/P04.T01h/e2b-support-pricing-65.json`). That file is no longer in the tree, so `ownedBuildPriceSourceValid` cannot read it and the owned-build quote check fails closed. A new build would need a new quote and an ADR in any case.

## Terminal provider state

ADR-0007 cites these records to show that no provider operation is still open. Every path is at the tag.

| Provider | Outcome | Record |
| --- | --- | --- |
| Daytona | No API key, sandbox or provider call | `docs/evidence/P04.T01f/{preparation,live,archive,cleanup}.json` (`provider_calls: false`); `docs/decisions/morrow-provider-lab.json` (`api_key_created: false`, `sandbox_created: false`) |
| E2B 65 | Owned build reconciled read-only to `ready_retained` (operation `c423fb7d-6935-4917-8862-0b4bbf5a2961`, template `pdht65h2trfuizuvmotc`, build `4324bde3-d3a9-4d18-91c1-b2b1b3e80b80`) | `docs/evidence/P04.T01h/owned-build-reconciliation.json` |
| E2B 66 | Sandbox `verified_deleted`, terminal receipt saved | `docs/evidence/P04.T01h/runtime-terminal-66.json` |
| E2B 67 | Runs 1, 2 and 3 each `verified_deleted`, `held_slot: false` | `docs/evidence/P04.T01h/diagnostic-run-67-{1,2,3}.json` |
| WorkOS 71 | Exact new staging session revoked; no active test-user sessions on read-back | `docs/evidence/P05.T01e/actual-workos-71.json` |
| WorkOS 74 | New session revoked; no controlled sessions active | `docs/evidence/P05.T01g/actual-workos-74.json` |
| WorkOS 75 | One read-only GET returned `not_observed_active`; allowance consumed | `docs/evidence/P05.T01h/actual-workos-75.json` |
| WorkOS 80 | Trial held; no native catalogue request; zero active sessions on read-back | `docs/evidence/P05.T01l/actual-staging-trial.json` |
| WorkOS 82 | Exact verified session revoked; zero active sessions on read-back | `docs/evidence/P05.T01n/actual-staging-trial.json` |

Every allowance is consumed. The console clean-up items with known outcomes (the retained E2B template and build, the E2B qualification key, the WorkOS staging test user and the loopback callback) are listed in `docs/progress/STATUS.md`.

## Archived `docs/history` directories (24)

| Directory | Contents |
| --- | --- |
| `authentication-admission-69` | P05.T01d PKCE and code-exchange admission (migration 0006) reports and review |
| `authentication-challenge-lab-77` | Original published 77 authentication-challenge lab script and report |
| `aws-baseline` | Superseded, undeployed AWS/CDK/Aurora/Fargate/Temporal definitions and cost records |
| `controlled-neon-88` | P05.T01t plan, Page snapshot and packet as of canonical 88 |
| `e2b-operator-65` | Exact E2B operator source closure for the owned build 65 |
| `e2b-operator-66` | Exact E2B operator source closure for the single runtime test 66 |
| `e2b-operator-67` | Exact E2B 67 diagnostic controller closure |
| `e2b-operator-67-command` | Exact E2B 67 command-repair controller closure |
| `e2b-operator-67-restore` | Exact E2B 67 restore-repair controller closure |
| `managed-login-authority-90` | P05.T01u plan, Page snapshot and packet authority as of canonical 90 |
| `managed-login-first-proof-90` | P05.T01u original first native proof, execution receipt and independent review |
| `managed-login-qualified-91` | P05.T01u plan, Page snapshot and packet as qualified at 91 |
| `workos-authentication-operator-80` | P05.T01l maintained WorkOS operator closure (80) |
| `workos-authentication-operator-82` | P05.T01n requalified WorkOS operator closure (82) |
| `workos-identity-77` | Published 77 identity closure, preserved before the 78 selected-reader correction |
| `workos-operator-70` | P05.T01e WorkOS operator closure published at 70, before the browser form repair |
| `workos-operator-71` | P05.T01e WorkOS operator closure after the 71 repair |
| `workos-operator-74` | P05.T01g WorkOS operator closure (74) and the post-commit actual trial |
| `workos-regression-diagnostics-72` | Diagnostic-only follow-up to the published 72 regressions |
| `workos-session-status-75` | P05.T01h provider-session status reader closure (75) |
| `workos-session-token-72` | P05.T01f offline RS256 token verifier closure (72) |
| `workspace-api-authority-92` | P05.T01v plan, Page snapshot and packet as of canonical 92 |
| `workspace-api-authority-93` | P05.T01v plan, Page snapshot and packet as of canonical 93 |
| `workspace-store-linking-68` | P05.T03a controlled workspace/store linking closure (68) |

## Archived `docs/evidence` packet directories (47)

Each directory held the reports, reviews and receipts for one packet. The tag also holds `docs/evidence/index.json`, the former hash index of all of them.

- P01: `P01.T01`, `P01.T02`, `P01.T03`, `P01.T04`
- P02: `P02.T01`, `P02.T02`, `P02.T03`
- P03: `P03.T01`, `P03.T02`, `P03.T03`, `P03.T04`
- P04: `P04.T01`, `P04.T01a`, `P04.T01b`, `P04.T01c`, `P04.T01d`, `P04.T01e`, `P04.T01f`, `P04.T01g`, `P04.T01h`, `P04.T02`, `P04.T03`, `P04.T04`
- P05: `P05.T01`, `P05.T01d`, `P05.T01e`, `P05.T01f`, `P05.T01g`, `P05.T01h`, `P05.T01i`, `P05.T01j`, `P05.T01k`, `P05.T01l`, `P05.T01m`, `P05.T01n`, `P05.T01o`, `P05.T01p`, `P05.T01q`, `P05.T01r`, `P05.T01s`, `P05.T01t`, `P05.T01u`, `P05.T01v`, `P05.T02`, `P05.T03`, `P05.T03b`, `P05.T04`

The pre-overhaul append-only checkpoint is at `codex-archive-f89ad75:docs/progress/checkpoint.md`, and the retired Page snapshot manifest is at `codex-archive-f89ad75:docs/plan/source.json`.
