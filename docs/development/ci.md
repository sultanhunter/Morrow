# Continuous integration

`.github/workflows/ci.yml` (workflow "Morrow foundation") runs on every pull request and on every push to `main`. It used to be one serial job of about 21.5 minutes. It is now a set of parallel jobs and one aggregator, which should take about 5 minutes of wall clock. That figure is an estimate; confirm it on the first runs. Each job pays its own setup, so billed minutes rise from about 22 to about 28–30 per run.

## Jobs

| Job | What it runs | Local command | Timeout |
| --- | --- | --- | --- |
| `static` | Format check, typecheck, `verify` (plan check, task inventory, contract and validator drift, import boundaries, migration checksums, repository secret scan), build, the Workers runtime typecheck and wrangler configuration/Env-type checks (`typecheck:edge`, `edge:check`), scaffold denial guards, the lab example and the infrastructure synth/permissions/readiness checks | `npm run ci:static` | 15 min |
| `unit` (shards 1 and 2) | The top-level `tests/*.test.mjs` files through `scripts/run-tests.mjs`, split by file. Each shard runs its parallel-safe files concurrently, then its files from `tests/serial-tests.json` one at a time (see Unit tests below). | `TEST_SHARD=1/2 npm run test:shard` | 15 min |
| `workers-api` | `lab:workspace-api-workers`, the longest single lab | `npm run lab:workspace-api-workers` | 10 min |
| `workers` | The SPA build, then `edge:dry-run` and `smoke:edge-dev` inside a `--network none` container (read-only checkout, the runner's Node mounted into the digest-pinned engine image), then the other 19 Miniflare/workerd labs including `lab:edge-workers` and `lab:account-workers` | `npm run edge:dry-run && npm run smoke:edge-dev && npm run lab:group:workers` | 15 min |
| `postgres` (`pg-core`, `pg-linking`, `pg-http`, `pg-work`) | The network-none PostgreSQL, HTTP and HTTPS labs. `pg-core` also records the pinned engine build first and ends with the P06.T01b approval-records lab. `pg-work` runs the P06 work labs: tenant conformance, the work PostgreSQL acceptance lab and the workerd work lab (Miniflare over a SQL service binding) | `npm run lab:group:pg-core` (and `pg-linking`, `pg-http`, `pg-work`) | 12 min |
| `pgwire` | The four PG-wire labs: controlled Neon, managed login, workspace API and the deployable api/broker journey (`lab:edge-postgresql`) | `npm run lab:group:pgwire` (Linux CI only) | 12 min |
| `ui` | The P14.T01a provisional UI: pulls the pinned PostgreSQL image and installs the pinned Playwright Chromium, builds, then `ui:check` (112 fixture state cases at 1440/768/390/320 and 32 keyboard walks, under the exact `_headers` CSP), `ui:edge` (12 cases on the production dist under the unbound dev pair) and `lab:group:ui` (the real-browser sign-in journey against the P04.T02a harness and PostgreSQL 17; Linux only) | `npm run build && npm run ui:check && npm run ui:edge` | 20 min |
| `foundation` | Aggregator: succeeds only when every job above succeeded | none | 5 min |

The matrix jobs use `fail-fast: false`, so one failing shard or group does not hide the others' results.

## Steps every job shares

Every job except `foundation` runs these steps, in this order:

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

Each job, and each matrix leg, uploads one artifact named `morrow-<job>[-<shard or group>]-<run id>-<attempt>`, for example `morrow-postgres-pg-http-<run id>-1`. Artifacts are kept for 90 days. [ADR-0012 (CI artifacts are the evidence)](../decisions/adr/ADR-0012-ci-artifacts-are-evidence.md) still holds; the only difference is that its single `morrow-ci-<run id>-<attempt>` artifact is now one artifact per job. The `unit` job may produce no reports, so its upload ignores an empty directory. Every other job fails its upload step if no reports were written.

## Required check

`foundation` is the one status check to require in branch protection. It keeps the name of the old single job, so a rule that already names it keeps working. The aggregator runs with `if: always()`. It fails if any job it needs ended as `failure`, `cancelled` or `skipped`.

## Changing CI

- Unit test files run concurrently (see Unit tests below). A file that cannot share the machine goes in `tests/serial-tests.json` with its reason; do not lower the concurrency for every file. The `# tests` totals of all shards must add up to the total of a plain `npm test`.
- Run labs one at a time within a job. The PostgreSQL labs use real lock waits and expiry windows, so a busy host can fail them. If one fails locally on a loaded machine, rerun it on an idle one before suspecting the code.
- `tests/ci-workflow.test.mjs` (part of `npm test`) checks the workflows: actions pinned by commit SHA, checkouts without persisted credentials of the one ref each workflow file may use (`ci.yml` the pull request head, `heavy-faults.yml` `${{ github.sha }}`, `frozen-regressions.yml` the archive tag; any other workflow file fails), no `continue-on-error`, every upload gated on a passing secret scan, the shared step order and clean-tree gate in every report-writing job, and `foundation` needing every `ci.yml` job. It also requires CI to run every `lab:*` script exactly once, except `lab:engine`, the `lab:e2b-*` operator commands and the local-only `lab:edge-postgresql-local` and `lab:workspace-ui-journey-local`; each `lab:group:*` script to be a plain `&&` chain; every top-level test file to run in exactly one unit shard; and every `heavy:*` script to run exactly once from `heavy-faults.yml` and never from `ci.yml`.
- A new lab gets its own `lab:*` npm script and joins the matching group script in `package.json` (the test above fails until it does):
  - Workers labs join `lab:group:workers`;
  - network-none PostgreSQL labs join one of the `pg-*` groups;
  - PG-wire labs join `lab:group:pgwire`;
  - browser labs join `lab:group:ui` (the `ui` job, which alone installs Chromium).
- The `pgwire` labs need Linux, `GITHUB_ACTIONS=true`, a rootful Docker daemon at `/var/run/docker.sock` and a bridge gateway in 172.16.0.0/12. That is why the job pins `ubuntu-24.04`. Elsewhere, including Docker Desktop on macOS, they refuse to run; they never pass by accident. Do not try to make them run on macOS. The one exception is deliberate and separate: `npm run lab:edge-postgresql-local` runs the `lab:edge-postgresql` journeys on a developer machine (pinned image already pulled, port published on 127.0.0.1 only, the synthetic loopback bridge). It refuses to run in GitHub Actions, never runs in CI, and is supporting evidence only; the `pgwire` job stays the authority.
- `npm run ci` stays as the full serial local pipeline (static checks and all tests, without the scaffold smoke and the Docker/Workers labs). It also runs `typecheck:edge`, `edge:check` and `edge:dry-run` after `build`; CI runs the dry-run in the `workers` job's network-none container instead, and `tests/ci-workflow.test.mjs` follows the npm scripts that container step runs through `sh -c`.
- Wrangler always runs through `scripts/edge.mjs`, with a scrubbed environment, a throwaway `HOME`, `--env-file=<an empty file>` (so no `.env` or `.dev.vars` is loaded), metrics, `cf.json` and the npm update check off, and never with an account or token. It refuses to run with a `.env*` or `.dev.vars*` at the repository root, under `apps/` or in its working directory.
- Timing to watch on the first hosted run of P04.T02a: the `workers` job (15 min, the cap `tests/ci-workflow.test.mjs` allows) gained the SPA build, the image pull, the network-none container step (12 dry-runs and the http and https dev smoke) and `lab:edge-workers`; locally on macOS these took about 13 s, 5 s and 21 s. The `pgwire` job took 1 min 51 s before P04.T02a; `lab:edge-postgresql` adds about 3 to 4 minutes (the local runner took 175 to 223 s on a loaded Mac, including the 11 s held exchange, the seven-role wrong-secret matrix and pacing under the 0010 login-flow rate limit). Record both jobs' step durations; if `workers` nears its cap, move the container step into its own job rather than raising the cap. Running `npm run ci:static` and both test shards covers the same ground as CI's `static` and `unit` jobs.

## Formatting

`npm run format:check` is `prettier --check .` and `npm run format` is `prettier --write .`. Prettier reads `.gitignore` and `.prettierignore`. The ignore file states what is out of scope: untracked and generated outputs, the generated contracts (`packages/contracts/src/generated/`) and `apps/*/worker-configuration.d.ts` (their generators compare them byte for byte), `docs/` and Markdown, and the byte-locked `tests/fixtures/e2b-*` fixtures. A new code file is formatted by default. `tests/format-scope.test.mjs` fails if the ignore files hide any other tracked or new code or configuration file outside `docs/`, so widening `.prettierignore` cannot hide code. Commits that only reformat are listed in `.git-blame-ignore-revs` (`git config blame.ignoreRevsFile .git-blame-ignore-revs`).

## Unit tests

`npm test` runs `node scripts/run-tests.mjs`. It lists the top-level `tests/*.test.mjs` files and runs the parallel-safe ones with `--test-concurrency=k`, where k is `min(4, available CPUs)` (2 on the hosted runners). Then it runs the files named in `tests/serial-tests.json` one at a time. It exits 1 if either run failed. Each run prints its own `ℹ tests` total, so a shard's total is the sum of its runs.

- `--shard=i/n` (CI's `test:shard`) gives file j of each set, sorted, to shard (j mod n) + 1. `--concurrency=k` (1–16), `--repeat=r` (1–10, a fresh child per repetition) and `--junit=<dir>` (one JUnit report per run under the artifacts directory) serve the heavy job. `--list` prints the plan as JSON and runs nothing.
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
npm run ci:static
TEST_SHARD=1/2 npm run test:shard && TEST_SHARD=2/2 npm run test:shard
npm run lab:workspace-api-workers && npm run lab:group:workers
npm run lab:group:pg-core && npm run lab:group:pg-linking && npm run lab:group:pg-http && npm run lab:group:pg-work
npx playwright install chromium && npm run ui:check && npm run ui:edge   # the ui job, without the journey
npm run lab:workspace-ui-journey-local                                   # supporting evidence only
git status --porcelain --untracked-files=all   # should print nothing
```

Reports go to the git-ignored `.artifacts/` directory unless `MORROW_ARTIFACTS_DIR` is set.

## Frozen regression replay

`.github/workflows/frozen-regressions.yml` is optional and can only be started by hand (`workflow_dispatch`). It is not a required check. It checks out the archive tag `codex-archive-f89ad75`, never the current tree. There it replays the frozen 71/74/75/80/82 WorkOS operator regressions retired by ADR-0013, together with their unit tests. The uploaded `frozen*.json` paths are tracked at the tag, so a report that a failed replay never rewrote would still be there. The upload therefore runs only when every replay and unit test succeeded and the archived tree's own secret scan (`verify:delivery`) passed. The replays rewrite tracked reports inside that archived tree, so this job has no clean-tree gate.
