# Continuous integration

`.github/workflows/ci.yml` (workflow "Morrow foundation") runs on every pull request, on every push to `main` and by hand (`workflow_dispatch`, on any branch). It is a set of parallel jobs behind one aggregator, `foundation`, the single required check. How much of it runs depends on the event (P03.T04f):

| Event | Jobs that run | Why |
| --- | --- | --- |
| Pull request that changes anything other than Markdown | all of them (a *full* run) | the merge gate (ADR-0014) |
| Pull request that changes only Markdown (`*.md`, anywhere) | `scope`, `checks`, `foundation` (a *light* run) | `checks` holds every check that reads Markdown: `plan:check` and the rest of `verify`, and the unit tests. No lab reads Markdown (guarded, see Changing CI) |
| Push to `main` of a merge commit whose tree is exactly its second parent's | `scope`, `checks`, `foundation` (light) | the second parent is the merged pull request head, and ADR-0014 item 1 required a green `foundation` on that exact head, so the merged tree is the tree that run checked; `scope` verifies the tree equality |
| Any other push to `main` (a squash merge, a head that lacked the latest `main`, a direct push) | all of them (full) | the merged tree was never checked as a whole |
| `workflow_dispatch` | all of them (full) | a manual full run, on `main` or any branch |

Changing what the required gate accepts is Material under ADR-0002. The owner approved both light paths on 2026-10-19 (P03.T04f OQ-1, option (a)), and ADR-0014 records the amended item 4.

There are no workflow-level `paths` filters: a workflow skipped by a path filter never reports its checks, so `foundation` would stay pending (see Required check). `scope` narrows the run inside the workflow instead.

## Jobs

| Job | What it runs | Local command | Timeout |
| --- | --- | --- | --- |
| `scope` | Every event. Checks out the head (or the pushed commit) with full history. It sets `full=false` only for a pull request whose changed files (`git diff --name-only --no-renames base...head`, the whole pull request) are all Markdown, or for a push whose commit has a second parent with exactly the same tree (`git diff --quiet <sha>^2 <sha>`); otherwise `full=true`. An unreadable pull request diff fails the job, and `foundation` with it; an unreadable push runs everything | none | 5 min |
| `checks` | Every event. The unit tests (`npm test`: every top-level `tests/*.test.mjs`, parallel-safe files concurrently, then `tests/serial-tests.json`; see Unit tests), then `npm run ci:static`: format check, typecheck, `verify` (plan check, task inventory, contract and validator drift, import boundaries, migration checksums, repository secret scan), build, the Workers runtime typecheck and wrangler configuration/Env-type checks (`typecheck:edge`, `edge:check`), scaffold denial guards, the lab example and the infrastructure synth/permissions/readiness checks | `npm test && npm run ci:static` | 15 min |
| `workers` | Full runs. The SPA build, then `edge:dry-run` and `smoke:edge-dev` inside a `--network none` container (read-only checkout, the runner's Node mounted into the digest-pinned engine image), then `lab:workspace-api-workers` (the longest single Workers lab, formerly the `workers-api` job) and the other 19 Miniflare/workerd labs in `lab:group:workers`, including `lab:edge-workers` and `lab:account-workers` | `npm run edge:dry-run && npm run smoke:edge-dev && npm run lab:workspace-api-workers && npm run lab:group:workers` | 15 min |
| `postgres` (`core-http`, `linking`, `work`) | Full runs. The network-none PostgreSQL, HTTP and HTTPS labs. `core-http` records the pinned engine build, then runs `lab:group:pg-core` and `lab:group:pg-http` on one runner. `linking` runs `lab:group:pg-linking`. `work` runs `lab:group:pg-work`, the P06 work labs: tenant conformance, the work PostgreSQL acceptance lab and the workerd work lab (Miniflare over a SQL service binding) | `npm run lab:group:pg-core && npm run lab:group:pg-http` (and `pg-linking`, `pg-work`) | 14 min |
| `pgwire` | Full runs. The four PG-wire labs: controlled Neon, managed login, workspace API and the deployable api/broker journey (`lab:edge-postgresql`) | `npm run lab:group:pgwire` (Linux CI only) | 12 min |
| `ui` | Full runs. The P14.T01a provisional UI: pulls the pinned PostgreSQL image and installs the pinned Playwright Chromium, builds, then `ui:check` (160 fixture state cases at 1440/768/390/320 and 21 keyboard walks at 1440 and 390 (42 runs), under the exact `_headers` CSP), `ui:edge` (12 cases on the production dist under the unbound dev pair) and `lab:group:ui` (the real-browser journeys against the P04.T02a harness and PostgreSQL 17 with migrations 0001-0015 and the work login: PR-1 sign-in and sign-out, and PR-2 account, signup and work for three people; Linux only) | `npm run build && npm run ui:check && npm run ui:edge` | 20 min |
| `foundation` | Aggregator, every event: succeeds only when `scope` and `checks` succeeded and every lab job ended as the `scope` decision requires (see Required check) | none | 5 min |

The `postgres` matrix uses `fail-fast: false`, so one failing leg does not hide the others' results. Within a job, the first failing step ends the job; `core-http` therefore skips `pg-http` when `pg-core` fails.

## Steps every job shares

Every job except `scope` and `foundation`, which write no report, runs these steps, in this order:

1. Check out the pull request head (or the pushed commit) with `persist-credentials: false`.
2. Set up Node from `.nvmrc` (exactly 24.13.0) with the npm download cache keyed on `package-lock.json`.
3. Set `MORROW_ARTIFACTS_DIR=$RUNNER_TEMP/morrow-artifacts` through `$GITHUB_ENV`. Reports go there, outside the checkout.
4. Run `npm ci --ignore-scripts --no-audit --no-fund`.
5. Run the job's own commands. The PostgreSQL jobs first pull the image pinned in `infra/local-engine.json`.
6. Always secret-scan the artifact directory with `scripts/scan-artifacts.mjs`.
7. Upload the artifact directory, but only if the scan passed.
8. Always require an unchanged checkout: `git status --porcelain --untracked-files=all` must print nothing.

Actions are pinned by full commit SHA: checkout `3d3c42e5…` (v7), setup-node `24997072…` (v6) and upload-artifact `b7c566a7…` (v6.0.0). Reuse these pins. Do not add an action without pinning it the same way.

## Artifacts

Each report-writing job, and each matrix leg, uploads one artifact named `morrow-<job>[-<leg>]-<run id>-<attempt>`, for example `morrow-postgres-core-http-<run id>-1`. Artifacts are kept for 90 days. [ADR-0012 (CI artifacts are the evidence)](../decisions/adr/ADR-0012-ci-artifacts-are-evidence.md) still holds; the only difference is that its single `morrow-ci-<run id>-<attempt>` artifact is now one artifact per job. Every upload step fails if no reports were written; `checks` always writes the static reports.

## Required check

`foundation` is the one status check to require in branch protection. It keeps the name of the old single job, so a rule that already names it keeps working. It runs with `if: always()` on every event, so it always reports, and it fails unless:

- there are exactly four lab job results (`workers`, `postgres`, `pgwire`, `ui`; it counts them, because blank results still leave the separating spaces);
- `scope` and `checks` succeeded; and
- on a full run (`full=true`: a pull request that changes more than Markdown, a push that is not a merge of an unchanged head, or a manual run), every lab job succeeded; or
- on a light run (`full=false`, on a pull request or a push only), every lab job was skipped.

Anything else fails it: a failed, cancelled or skipped `checks` or `scope`; a missing or unknown `scope` decision; `full=false` on any other event; a lab job that failed, was cancelled or was skipped on a full run, or ran on a light run; a missing lab result. `tests/ci-workflow.test.mjs` runs the aggregator script with bash over these combinations, and runs the `scope` script against a temporary git repository.

This changes ADR-0014 item 4, whose original text said the aggregator treats a skipped job as a failure. The owner approved the amendment on 2026-10-19 (P03.T04f OQ-1, option (a)); its text is in ADR-0014, section Amendments.

**When the workflow does not run at all.** GitHub reports nothing for a workflow it did not start (for example one skipped by a `paths` or `paths-ignore` filter). With branch protection that requires `foundation`, the check then stays "Expected — waiting for status to be reported" and the pull request cannot merge; it is not treated as skipped or passed. Without branch protection (today, ADR-0014 item 5), nothing blocks the merge button, but ADR-0014 item 1 still needs a green `foundation` on the exact head, so such a pull request could not be merged under the rules. That is why this workflow has no path filters and a Markdown-only pull request runs the light path instead: it costs about 6–7 billed minutes rather than nothing, and `foundation` reports green or red on every pull request.

**Push runs on `main`.** No written rule requires a pull request head to contain the latest `main` before it merges, and pull request runs check out the head, not GitHub's merge ref. So `scope` checks it on every push instead of assuming it: a merge commit whose tree equals its second parent's runs light, because that tree is exactly the head ADR-0014 item 1 required to be green; any other push (a squash merge, a head that lacked the latest `main`, a direct push) runs the full matrix. A manual full run stays available: Actions, "Morrow foundation", "Run workflow". STATUS.md records the last green commit with the run that verified it: the push run, and for a light push also the pull request run on the merged head.

## Changing CI

- Unit test files run concurrently (see Unit tests below). A file that cannot share the machine goes in `tests/serial-tests.json` with its reason; do not lower the concurrency for every file.
- Run labs one at a time within a job. The PostgreSQL labs use real lock waits and expiry windows, so a busy host can fail them. If one fails locally on a loaded machine, rerun it on an idle one before suspecting the code.
- `tests/ci-workflow.test.mjs` (part of `npm test`) checks the workflows: actions pinned by commit SHA, checkouts without persisted credentials of the one ref each workflow file may use (`ci.yml` the pull request head, `heavy-faults.yml` `${{ github.sha }}`, `frozen-regressions.yml` the archive tag; any other workflow file fails), no `continue-on-error`, every upload gated on a passing secret scan, the shared step order and clean-tree gate in every report-writing job, `foundation` needing every `ci.yml` job and naming every lab job in its `LABS` list, and the triggers (no path filters). It runs the `foundation` script over every combination of event and job results (including blank, missing and extra lab results), and the `scope` script against a temporary git repository (Markdown only, code, JSON under `docs/`, mixed, renames both ways, deletions, an empty diff, a manual run, an unreadable diff; and for pushes, a merge of an up-to-date head, a merge of a head that lacked `main`'s latest commit, a single-parent commit and an unknown commit). It also requires CI to run every `lab:*` script exactly once, all of them in jobs gated on a full run, except `lab:engine`, the `lab:e2b-*` operator commands and the local-only `lab:edge-postgresql-local` and `lab:workspace-ui-journey-local`; a light run to reach `format:check`, `typecheck`, `verify`, `plan:check`, the build and `npm test` but no `lab:*` or `ui:*` script; each `lab:*` group to be a plain `&&` chain; `npm test` to run once, in `checks`, over every top-level test file; and every `heavy:*` script to run exactly once from `heavy-faults.yml` and never from `ci.yml`.
- A new lab gets its own `lab:*` npm script and joins the matching group script in `package.json` (the test above fails until it does):
  - Workers labs join `lab:group:workers`;
  - network-none PostgreSQL labs join one of the `pg-*` groups;
  - PG-wire labs join `lab:group:pgwire`;
  - browser labs join `lab:group:ui` (the `ui` job, which alone installs Chromium).
- A light run skips the labs because no lab reads Markdown. `tests/ci-workflow.test.mjs` fails if any repository source file a gated job can load names a `.md` file: it starts from the files the gated npm scripts name, every Worker `main` in `apps/*/wrangler.jsonc` and the workspace SPA entries, and follows relative and `@morrow/*` imports and string literals that name repository source files (paths built at run time are not followed). A lab that must read one makes `scope` treat that file as code instead; the checks that read Markdown today (`plan:check`, `verify:foundation`, `verify:billing`, `verify:design` and several unit tests) all run in `checks`.
- Merge jobs only when the combined job stays under about 8 minutes, and keep a flaky or long group on its own runner: a rerun repeats the whole job. Each job pays about 20 s of setup (30 s with the image pull) and GitHub rounds each job up to a whole minute.
- The `pgwire` labs need Linux, `GITHUB_ACTIONS=true`, a rootful Docker daemon at `/var/run/docker.sock` and a bridge gateway in 172.16.0.0/12. That is why the job pins `ubuntu-24.04`. Elsewhere, including Docker Desktop on macOS, they refuse to run; they never pass by accident. Do not try to make them run on macOS. The one exception is deliberate and separate: `npm run lab:edge-postgresql-local` runs the `lab:edge-postgresql` journeys on a developer machine (pinned image already pulled, port published on 127.0.0.1 only, the synthetic loopback bridge). It refuses to run in GitHub Actions, never runs in CI, and is supporting evidence only; the `pgwire` job stays the authority.
- `npm run ci` stays as the full serial local pipeline (static checks and all tests, without the scaffold smoke and the Docker/Workers labs). It also runs `typecheck:edge`, `edge:check` and `edge:dry-run` after `build`; CI runs the dry-run in the `workers` job's network-none container instead, and `tests/ci-workflow.test.mjs` follows the npm scripts that container step runs through `sh -c`.
- Wrangler always runs through `scripts/edge.mjs`, with a scrubbed environment, a throwaway `HOME`, `--env-file=<an empty file>` (so no `.env` or `.dev.vars` is loaded), metrics, `cf.json` and the npm update check off, and never with an account or token. It refuses to run with a `.env*` or `.dev.vars*` at the repository root, under `apps/` or in its working directory.
- Timing to watch on the first hosted runs of P03.T04f: `postgres (core-http)` (estimated 7.5 to 8.2 minutes from the pg-core and pg-http job times below; cap 14), `workers` (about 5.8 minutes; cap 15) and `checks` (about 3.5 to 4 minutes; cap 15). If `core-http` stays above about 8 minutes, pair `pg-core` with `pgwire` instead (about 7 minutes by the same measurements) or split the leg again; do not raise the cap. Running `npm test && npm run ci:static` covers the same ground as CI's `checks` job.

## Cost

GitHub Free gives this private repository 2,000 Linux Actions minutes a month. GitHub bills each job's run time rounded up to a whole minute, so every extra job costs its setup (checkout, setup-node, `npm ci`, about 20 s, plus about 10 s for the image pull) and on average another half minute of rounding. October 2026 to the 19th: about 1,842 billed minutes over 111 runs and 506 jobs (an estimate from the job times, each rounded up).

Measured before P03.T04f (run 39171176579, the pull request run on the P14.T01a PR-1 head, 12 jobs): `static` 1:48, `unit` 1:25 and 1:30, `workers-api` 2:58, `workers` 3:07, `pg-core` 4:16, `pg-linking` 5:18, `pg-http` 4:24, `pg-work` 4:50, `pgwire` 3:11, `ui` 3:25, `foundation` 0:02. That is 36 minutes of run time and 43 billed minutes, and the push run after each merge repeated it. The unit shards then ran one file at a time; P03.T04e runs them concurrently, which can only shorten `checks`.

| Run | Jobs before → after | Billed minutes before | Billed minutes after (estimate) |
| --- | --- | --- | --- |
| Full pull request run | 12 → 9 (`scope`, `checks`, `workers`, `postgres` ×3, `pgwire`, `ui`, `foundation`) | about 43 | about 39–42: `scope` 1, `checks` 4–5, `workers` 6, `core-http` 8–9, `linking` 6–7, `work` 5, `pgwire` 4, `ui` 4, `foundation` 1 |
| Push to `main` merging an up-to-date head | 12 → 3 | about 43 | about 6–7 |
| Push to `main` of a squash merge or a stale head | 12 → 9 | about 43 | about 39–42 |
| Markdown-only pull request run | 12 → 3 | about 43 | about 6–7 |
| Manual full run | (new) | none | about 39–42 |

For a pull request with two full runs and its merge of an up-to-date head: about 129 billed minutes before and about 85–91 after. With one full run: about 86 before, about 45–49 after. Confirm the figures on the first hosted runs (job durations from `gh api repos/<owner>/<repo>/actions/runs/<id>/jobs`) and correct this table.

## Formatting

`npm run format:check` is `prettier --check .` and `npm run format` is `prettier --write .`. Prettier reads `.gitignore` and `.prettierignore`. The ignore file states what is out of scope: untracked and generated outputs, the generated contracts (`packages/contracts/src/generated/`) and `apps/*/worker-configuration.d.ts` (their generators compare them byte for byte), `docs/` and Markdown, and the byte-locked `tests/fixtures/e2b-*` fixtures. A new code file is formatted by default. `tests/format-scope.test.mjs` fails if the ignore files hide any other tracked or new code or configuration file outside `docs/`, so widening `.prettierignore` cannot hide code. Commits that only reformat are listed in `.git-blame-ignore-revs` (`git config blame.ignoreRevsFile .git-blame-ignore-revs`).

## Unit tests

`npm test` runs `node scripts/run-tests.mjs`. It lists the top-level `tests/*.test.mjs` files and runs the parallel-safe ones with `--test-concurrency=k`, where k is `min(4, available CPUs)` (2 on the hosted runners). Then it runs the files named in `tests/serial-tests.json` one at a time. It exits 1 if either run failed. Each run prints its own `ℹ tests` total, so the job's total is the sum of its runs. CI's `checks` job runs plain `npm test`, unsharded (P03.T04f).

- `--shard=i/n` gives file j of each set, sorted, to shard (j mod n) + 1; CI no longer passes it, and the `test:shard` npm script was removed in P03.T04f. `--concurrency=k` (1–16), `--repeat=r` (1–10, a fresh child per repetition) and `--junit=<dir>` (one JUnit report per run under the artifacts directory) serve the heavy job. `--list` prints the plan as JSON and runs nothing.
- Every spawn passes an explicit file list. An empty set or shard is never spawned, because `node --test` without files falls back to default discovery.
- A file goes in `tests/serial-tests.json` (`{"file", "reason"}`, with a reason of 20–300 characters that names its wall-clock dependency) only when it fails under parallel files and passes 5 of 5 runs alone. The runner rejects an entry that is missing, duplicated or not a top-level test file.
- Test servers listen with `.listen(0, "127.0.0.1"` only, and temporary roots come from `mkdtemp` or a random UUID. `tests/run-tests.test.mjs` enforces the listen form, which also stops a test from starting the fixed-port 4110 operator listeners.

## Heavy faults

`.github/workflows/heavy-faults.yml` (workflow "Morrow heavy faults") holds the heavy fault matrices. It runs by hand (`workflow_dispatch`) and weekly (Mondays 03:23 UTC), never on pull requests or pushes. It is not a required check: `foundation` does not need it.

- The `gate` job checks out `${{ github.sha }}` and sets `run=true` for a manual run, or when the head commit is under 8 days old. A scheduled run on an unchanged repository therefore skips the heavy job. `gate` writes no report, so it has no scan, upload or clean-tree steps.
- The `heavy` job (40 min, `fail-fast: false`) runs `npm run "heavy:$HEAVY_SUITE"` for each `matrix.suite`, with the same hardened steps as `ci.yml`. Today its only leg is `unit-stress`: `heavy:unit-stress` runs the unit set 5 times at concurrency 8 and uploads the JUnit reports, which name any file that flakes under load.
- Later packets add legs and `heavy:<slug>` scripts: the PostgreSQL harness stress (P03.T04e PR-B), and the P06.T01a soak and race matrices. Each `heavy:*` script must be reached exactly once from this workflow.
- A failing scheduled run is not a required check, so the next session records it under Blockers in `docs/progress/STATUS.md` until it is fixed.
- One run costs about 18 billed minutes of the private repository's included Actions quota (P03.T04e OQ-1). Moving to a nightly cadence is a one-line cron change, made only after the owner confirms the GitHub plan and quota.

## Running it locally

With Node 24.13.0 and Docker Desktop running, every job except `pgwire` runs on macOS:

```sh
npm ci --ignore-scripts
npm test && npm run ci:static                                            # the checks job
npm run lab:workspace-api-workers && npm run lab:group:workers           # the workers job, without the container step
npm run lab:group:pg-core && npm run lab:group:pg-http                   # postgres core-http
npm run lab:group:pg-linking && npm run lab:group:pg-work                # postgres linking and work
npx playwright install chromium && npm run ui:check && npm run ui:edge   # the ui job, without the journey
npm run lab:workspace-ui-journey-local                                   # supporting evidence only
git status --porcelain --untracked-files=all   # should print nothing
```

Reports go to the git-ignored `.artifacts/` directory unless `MORROW_ARTIFACTS_DIR` is set.

## Frozen regression replay

`.github/workflows/frozen-regressions.yml` is optional and can only be started by hand (`workflow_dispatch`). It is not a required check. It checks out the archive tag `codex-archive-f89ad75`, never the current tree. There it replays the frozen 71/74/75/80/82 WorkOS operator regressions retired by ADR-0013, together with their unit tests. The uploaded `frozen*.json` paths are tracked at the tag, so a report that a failed replay never rewrote would still be there. The upload therefore runs only when every replay and unit test succeeded and the archived tree's own secret scan (`verify:delivery`) passed. The replays rewrite tracked reports inside that archived tree, so this job has no clean-tree gate.
