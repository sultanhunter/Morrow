import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { listUnitFiles, runTests } from "../scripts/run-tests.mjs";
import { ciRunner, variableValue } from "../scripts/ci-runner.mjs";

// Structural checks of the GitHub workflows and the npm scripts they reach. They replace
// the workflow assertions of the retired CI evidence collector: hardening settings,
// the aggregator's dependencies, the secret-scan gate on uploads and complete lab coverage.
// The `scope` and `foundation` shell steps of ci.yml are also executed here, with bash,
// against simulated job results and a temporary git repository (P03.T04f).

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const scripts = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).scripts;
const headRef = "${{ github.event.pull_request.head.sha || github.sha }}";
// Every workflow file and the only ref its checkouts may use. A workflow file that is not
// listed here fails the tests below.
const checkoutRefs = {
  "ci.yml": headRef,
  "deploy-staging.yml": "${{ github.event.workflow_run.head_sha }}",
  "heavy-faults.yml": "${{ github.sha }}",
  "frozen-regressions.yml": "codex-archive-f89ad75",
};
const pinnedAction = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
// Never run by CI: lab:engine is the standalone engine probe (pg-core records the engine
// build inline), lab:e2b-* are offline-by-default provider operator commands, and
// lab:edge-postgresql-local is the developer-machine runner of the lab:edge-postgresql
// journeys (supporting evidence; the pgwire job runs lab:edge-postgresql itself), and
// lab:workspace-ui-journey-local is the same for the P14.T01a browser journey.
const labsOutsideCi = (name) =>
  name === "lab:engine" ||
  name === "lab:edge-postgresql-local" ||
  name === "lab:workspace-ui-journey-local" ||
  name.startsWith("lab:e2b-");
// The P14.T01a `ui` job installs Chromium and runs 214 browser checks (172 state cases and
// 21 keyboard walks at two widths) plus the journey lab.
// The ui job and the postgres lab legs may run up to 20 minutes; every other job 15.
const timeoutLimit = (id) => (id === "ui" || id === "postgres" ? 20 : 15);
// Every ci.yml job runs on GitHub-hosted ubuntu-24.04 unless the repository variable
// MORROW_CI_RUNS_ON holds the Mac runner's label list (ADR-0014, amendment of 2026-10-22).
const ciRunsOn = "${{ fromJSON(vars.MORROW_CI_RUNS_ON || '\"ubuntu-24.04\"') }}";

// Parses the YAML subset these workflows use: block maps and sequences, plain, quoted and
// flow-sequence scalars, `|`/`>-` block scalars and comments.
function parseWorkflow(text) {
  const lines = text.split("\n").map((raw) => ({ raw, indent: raw.search(/\S/) }));
  let index = 0;
  const structural = (line) => line.indent >= 0 && !line.raw.trimStart().startsWith("#");
  const skip = () => {
    while (index < lines.length && !structural(lines[index])) index++;
  };
  const isItem = (line) => /^- |^-$/.test(line.raw.slice(line.indent));
  const scalar = (source) => {
    const text = source.trim();
    if (/^".*"$/.test(text)) return JSON.parse(text);
    if (/^'.*'$/.test(text)) return text.slice(1, -1).replaceAll("''", "'");
    const plain = text.replace(/\s+#.*$/, "");
    if (/^\[.*\]$/.test(plain))
      return plain
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map(scalar);
    if (plain === "true" || plain === "false") return plain === "true";
    if (/^-?\d+$/.test(plain)) return Number(plain);
    return plain;
  };
  const blockScalar = (style, parentIndent) => {
    const body = [];
    while (index < lines.length && (lines[index].indent < 0 || lines[index].indent > parentIndent))
      body.push(lines[index++].raw);
    while (body.length && body.at(-1).trim() === "") body.pop();
    const margin = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    const trimmed = body.map((l) => l.slice(margin));
    return style.startsWith("|") ? trimmed.join("\n") + "\n" : trimmed.join(" ");
  };
  const value = (rest, keyIndent) => {
    if (rest === undefined || rest === "") {
      skip();
      if (index < lines.length && lines[index].indent > keyIndent) return node();
      if (index < lines.length && lines[index].indent === keyIndent && isItem(lines[index]))
        return node();
      return null;
    }
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(rest, keyIndent);
    return scalar(rest);
  };
  const map = (indent) => {
    const out = {};
    for (skip(); index < lines.length && lines[index].indent === indent; skip()) {
      if (isItem(lines[index])) break;
      const entry = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(lines[index].raw.slice(indent));
      if (!entry) throw Error("WORKFLOW_YAML_UNSUPPORTED: " + lines[index].raw);
      if (Object.hasOwn(out, entry[1])) throw Error("WORKFLOW_YAML_DUPLICATE_KEY: " + entry[1]);
      index++;
      out[entry[1]] = value(entry[2], indent);
    }
    return out;
  };
  const sequence = (indent) => {
    const out = [];
    for (skip(); index < lines.length && lines[index].indent === indent; skip()) {
      if (!isItem(lines[index])) break;
      const content = lines[index].raw.slice(indent + 2);
      if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(content)) {
        lines[index] = { raw: " ".repeat(indent + 2) + content, indent: indent + 2 };
        out.push(map(indent + 2));
      } else if (/^[|>][-+]?$/.test(content)) {
        index++;
        out.push(blockScalar(content, indent));
      } else {
        index++;
        out.push(scalar(content));
      }
    }
    return out;
  };
  const node = () => {
    skip();
    const line = lines[index];
    return isItem(line) ? sequence(line.indent) : map(line.indent);
  };
  const document = node();
  skip();
  if (index !== lines.length) throw Error("WORKFLOW_YAML_TRAILING: " + lines[index].raw);
  return document;
}

const workflowFiles = readdirSync(workflowsDirectory).filter((f) => /\.ya?ml$/.test(f));
const workflowText = (file) => readFileSync(new URL(file, workflowsDirectory), "utf8");
const workflows = Object.fromEntries(
  workflowFiles.map((file) => [file, parseWorkflow(workflowText(file))]),
);
const ci = workflows["ci.yml"];
const heavyFaults = workflows["heavy-faults.yml"];
const steps = (job) => job.steps ?? [];
const uses = (step, action) => typeof step.uses === "string" && step.uses.startsWith(action + "@");
// ci.yml (P03.T04f): `scope` decides, `checks` runs on every event, the lab jobs run only
// on a full run, and `foundation` aggregates.
const fullGate = "needs.scope.outputs.full == 'true'";
const labJobIds = Object.keys(ci.jobs).filter(
  (id) => !["scope", "checks", "foundation"].includes(id),
);

test("the YAML subset parser reads nested maps, sequences, flow lists and block scalars", () => {
  assert.deepEqual(
    parseWorkflow(
      [
        "# comment",
        "on:",
        "  push:",
        "    branches: [main, 'release']",
        "jobs:",
        "  a:",
        "    needs: [b]",
        "    steps:",
        "      - uses: owner/action@0123 # v1",
        "        with:",
        "          flag: false",
        "      - run: |",
        "          echo one",
        "          # kept inside the script",
        "        if: always()",
        '      - run: "quoted # not a comment"',
        "",
      ].join("\n"),
    ),
    {
      on: { push: { branches: ["main", "release"] } },
      jobs: {
        a: {
          needs: ["b"],
          steps: [
            { uses: "owner/action@0123", with: { flag: false } },
            { run: "echo one\n# kept inside the script\n", if: "always()" },
            { run: "quoted # not a comment" },
          ],
        },
      },
    },
  );
  assert.throws(() => parseWorkflow("a: 1\na: 2\n"), /WORKFLOW_YAML_DUPLICATE_KEY/);
  // A block scalar as a sequence item (the runner stack's shell scripts).
  assert.deepEqual(
    parseWorkflow(
      ["command:", "  - /bin/bash", "  - |", "    echo one", "    # kept", "  - last", ""].join(
        "\n",
      ),
    ),
    { command: ["/bin/bash", "echo one\n# kept\n", "last"] },
  );
});

test("every workflow pins actions by commit, never persists credentials and never continues on error", () => {
  assert.deepEqual([...workflowFiles].sort(), Object.keys(checkoutRefs).sort());
  for (const file of workflowFiles) {
    const text = workflowText(file);
    const workflow = workflows[file];
    assert.ok(!text.includes("continue-on-error"), file);
    assert.ok(!text.includes("pull_request_target"), file);
    // Only the staging deploy names a secret (its Cloudflare token, in one step) and reads
    // its own workflow's state (the kill's live signal; P04.T01i D2).
    if (file === "deploy-staging.yml") {
      assert.deepEqual(text.match(/\bsecrets\.[A-Za-z_]+/g), ["secrets.CLOUDFLARE_API_TOKEN"]);
      assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" }, file);
    } else {
      assert.ok(!/\bsecrets\./.test(text), file);
      assert.deepEqual(workflow.permissions, { contents: "read" }, file);
    }
    for (const [id, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.permissions, undefined, `${file} ${id} must not widen permissions`);
      for (const step of steps(job)) {
        if (step.uses !== undefined) assert.match(step.uses, pinnedAction, `${file} ${id}`);
        if (uses(step, "actions/checkout")) {
          assert.equal(step.with?.["persist-credentials"], false, `${file} ${id}`);
          assert.equal(step.with?.ref, checkoutRefs[file], `${file} ${id}`);
        }
      }
    }
  }
});

test("every upload is gated on a passing secret scan of what it uploads", () => {
  let uploads = 0;
  for (const file of workflowFiles)
    for (const [id, job] of Object.entries(workflows[file].jobs)) {
      const jobSteps = steps(job);
      for (const [position, step] of jobSteps.entries()) {
        if (!uses(step, "actions/upload-artifact")) continue;
        uploads++;
        const gate = /steps\.([a-z_]+)\.outcome == 'success'/.exec(step.if ?? "");
        assert.ok(gate, `${file} ${id} upload must require a scan outcome`);
        const scan = jobSteps.findIndex((s) => s.id === gate[1]);
        assert.ok(scan >= 0 && scan < position, `${file} ${id} scan must precede upload`);
        assert.equal(jobSteps[scan].if, "always()", `${file} ${id} scan must always run`);
        assert.equal(step.with?.overwrite, false);
        assert.equal(step.with?.["include-hidden-files"], false);
        assert.equal(step.with?.["retention-days"], 90);
        // Archive replays upload tracked report paths, so they upload only after every
        // replay succeeded; otherwise an unregenerated archived report could be uploaded.
        if (file === "frozen-regressions.yml")
          assert.ok(!step.if.includes("always()"), `${file} ${id}`);
      }
    }
  assert.ok(uploads >= labJobIds.length + 1);
  for (const [id, job] of Object.entries(ci.jobs)) {
    const count = steps(job).filter((s) => uses(s, "actions/upload-artifact")).length;
    assert.equal(count, id === "scope" || id === "foundation" ? 0 : 1, id);
  }
});

// The hardened step sequence every report-writing job shares: checkout, setup-node from
// .nvmrc, the artifacts directory outside the checkout, a locked install, the job body, an
// always-run secret scan, an upload gated on that scan and the clean-tree gate.
function assertHardenedSteps(id, job, runsOn = "ubuntu-24.04") {
  const jobSteps = steps(job);
  const at = (predicate) => jobSteps.findIndex(predicate);
  assert.equal(job["runs-on"], runsOn, id);
  if (job.strategy?.matrix) assert.equal(job.strategy["fail-fast"], false, id);
  assert.ok(uses(jobSteps[0], "actions/checkout"), id);
  const setup = at((s) => uses(s, "actions/setup-node"));
  assert.equal(jobSteps[setup]?.with?.["node-version-file"], ".nvmrc", id);
  const route = at(
    (s) => s.run === 'echo "MORROW_ARTIFACTS_DIR=$RUNNER_TEMP/morrow-artifacts" >> "$GITHUB_ENV"',
  );
  const install = at((s) => s.run === "npm ci --ignore-scripts --no-audit --no-fund");
  const scan = at((s) => s.id === "artifact_scan");
  const upload = at((s) => uses(s, "actions/upload-artifact"));
  assert.ok(0 < setup && setup < route && route < install, id);
  assert.ok(install + 1 < scan && scan + 1 === upload, `${id} runs its body before the scan`);
  assert.equal(jobSteps[scan].if, "always()", id);
  assert.equal(jobSteps[scan].run, 'node scripts/scan-artifacts.mjs "$MORROW_ARTIFACTS_DIR"');
  assert.equal(jobSteps[upload].if, "always() && steps.artifact_scan.outcome == 'success'");
  assert.equal(jobSteps[upload].with.path, "${{ runner.temp }}/morrow-artifacts");
  assert.equal(jobSteps[upload].with["if-no-files-found"], "error", id);
  assert.equal(upload, jobSteps.length - 2, id);
  const clean = jobSteps.at(-1);
  assert.equal(clean.if, "always()", id);
  assert.match(clean.run, /test -z "\$\(git status --porcelain --untracked-files=all\)"/, id);
  // Body steps run unconditionally, except a step restricted to one matrix leg.
  for (const step of jobSteps.slice(install + 1, scan))
    assert.ok(step.if === undefined || /^matrix\.[a-z]+ == '[a-z0-9-]+'$/.test(step.if), id);
}

test("every ci.yml job shares the hardened step sequence and foundation needs every job", () => {
  const { foundation, scope, ...jobs } = ci.jobs;
  assert.ok(foundation, "foundation keeps the required status check name");
  assert.ok(scope && jobs.checks, "scope and checks exist");
  assert.deepEqual(
    [...foundation.needs].sort(),
    Object.keys(ci.jobs)
      .filter((id) => id !== "foundation")
      .sort(),
  );
  assert.equal(foundation.if, "always()");
  assert.equal(foundation["runs-on"], ciRunsOn);
  assert.equal(foundation["timeout-minutes"], 5);
  assert.equal(steps(foundation).length, 1);
  // LABS names every lab job's result, so a new job cannot pass `foundation` unseen.
  const aggregate = foundation.steps.at(-1);
  assert.deepEqual(aggregate.env, {
    EVENT_NAME: "${{ github.event_name }}",
    RESULTS: "${{ join(needs.*.result, ' ') }}",
    SCOPE: "${{ needs.scope.result }}",
    FULL: "${{ needs.scope.outputs.full }}",
    CHECKS: "${{ needs.checks.result }}",
    LABS: labJobIds.map((id) => "${{ needs." + id + ".result }}").join(" "),
  });
  for (const [id, job] of Object.entries(jobs)) {
    assert.ok(
      Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] <= timeoutLimit(id),
      id,
    );
    assertHardenedSteps(id, job, ciRunsOn);
  }
  // `checks` runs on every event; every other report-writing job runs only on a full run.
  assert.equal(jobs.checks.needs, undefined);
  assert.equal(jobs.checks.if, undefined);
  assert.ok(labJobIds.length >= 4, labJobIds.join(","));
  for (const id of labJobIds) {
    assert.equal(ci.jobs[id].needs, "scope", id);
    assert.equal(ci.jobs[id].if, fullGate, id);
  }
});

// P03.T04f: no workflow-level path filter. A workflow skipped by `paths` never reports its
// checks, and GitHub then shows a required `foundation` as pending, which blocks the merge
// under branch protection and leaves nothing green for ADR-0014. `scope` narrows the run
// inside the workflow instead, so `foundation` reports on every pull request.
test("ci.yml runs on every pull request, on push to main and by hand, without path filters", () => {
  assert.deepEqual(ci.on, {
    pull_request: null,
    push: { branches: ["main"] },
    workflow_dispatch: null,
  });
  assert.ok(!/\bpaths(-ignore)?:/.test(workflowText("ci.yml")));
  assert.deepEqual(ci.concurrency, {
    group: "foundation-${{ github.event_name }}-${{ github.ref }}",
    "cancel-in-progress": true,
  });
  // scope writes no report, so it is exempt from the scan, upload and clean-tree steps. It
  // runs on every event, so every `foundation` decision rests on a recorded scope result.
  const { scope } = ci.jobs;
  assert.equal(scope.if, undefined);
  assert.equal(scope["runs-on"], ciRunsOn);
  assert.equal(scope["timeout-minutes"], 5);
  assert.equal(scope.needs, undefined);
  assert.deepEqual(scope.outputs, { full: "${{ steps.decide.outputs.full }}" });
  assert.equal(steps(scope).length, 2);
  assert.ok(uses(steps(scope)[0], "actions/checkout"));
  assert.equal(steps(scope)[0].with["fetch-depth"], 0, "the diffs need the base and parents");
  const decide = steps(scope)[1];
  assert.equal(decide.id, "decide");
  assert.deepEqual(decide.env, {
    EVENT_NAME: "${{ github.event_name }}",
    BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    PUSHED_SHA: "${{ github.sha }}",
  });
  assert.equal(rootScriptsRun(decide.run).length, 0);
});

// Runs a ci.yml shell step the way GitHub runs an unspecified shell on Linux (bash -e).
function runStep(script, env, cwd) {
  return spawnSync("bash", ["-e", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

test("foundation passes only when every job the event runs succeeded", () => {
  const run = ci.jobs.foundation.steps.at(-1).run;
  // The step counts the lab results instead of testing LABS for emptiness: the expression
  // always yields the separating spaces, even when every result is blank.
  assert.ok(run.includes(`[ "$#" -eq ${labJobIds.length} ]`), "foundation counts every lab result");
  const all = (result) => labJobIds.map(() => result);
  const outcome = ({ event, scope = "success", full = "", checks = "success", labs }) => {
    const env = {
      EVENT_NAME: event,
      RESULTS: [scope, checks, ...labs].join(" "),
      SCOPE: scope,
      FULL: full,
      CHECKS: checks,
      LABS: labs.join(" "),
    };
    const result = runStep(run, env);
    return result.status === 0 ? "pass" : "fail";
  };
  const one = (result) => [result, ...all("success").slice(1)];
  const oneSkipped = (result) => [result, ...all("skipped").slice(1)];
  const cases = [];
  for (const event of ["pull_request", "push"])
    cases.push(
      // Full: a pull request that changes more than Markdown, or a push that is not a merge
      // of an unchanged, already-checked head. Every job must succeed.
      [{ event, full: "true", labs: all("success") }, "pass"],
      [{ event, full: "true", labs: one("failure") }, "fail"],
      [{ event, full: "true", labs: one("cancelled") }, "fail"],
      [{ event, full: "true", labs: one("skipped") }, "fail"],
      [{ event, full: "true", checks: "failure", labs: all("success") }, "fail"],
      [{ event, full: "true", checks: "skipped", labs: all("success") }, "fail"],
      // Light: a Markdown-only pull request, or a push whose tree is its merged head's.
      [{ event, full: "false", labs: all("skipped") }, "pass"],
      [{ event, full: "false", labs: oneSkipped("success") }, "fail"],
      [{ event, full: "false", checks: "failure", labs: all("skipped") }, "fail"],
      [{ event, full: "false", checks: "cancelled", labs: all("skipped") }, "fail"],
      // scope must have decided, on every event.
      [{ event, scope: "failure", labs: all("skipped") }, "fail"],
      [{ event, scope: "cancelled", labs: all("skipped") }, "fail"],
      [{ event, scope: "skipped", labs: all("skipped") }, "fail"],
      [{ event, scope: "skipped", full: "false", labs: all("skipped") }, "fail"],
      [{ event, full: "", labs: all("skipped") }, "fail"],
      [{ event, full: "yes", labs: all("success") }, "fail"],
    );
  cases.push(
    // A manual run is always full.
    [{ event: "workflow_dispatch", full: "true", labs: all("success") }, "pass"],
    [{ event: "workflow_dispatch", full: "false", labs: all("skipped") }, "fail"],
    [{ event: "workflow_dispatch", scope: "skipped", labs: all("skipped") }, "fail"],
    // Only pull requests and pushes may run light.
    [{ event: "schedule", full: "false", labs: all("skipped") }, "fail"],
    // A missing result fails: blank results (the real expression still yields the
    // separating spaces), one result too few, one too many, or none at all.
    [{ event: "pull_request", full: "true", labs: all("") }, "fail"],
    [{ event: "push", full: "false", labs: all("") }, "fail"],
    [{ event: "pull_request", full: "true", labs: all("success").slice(1) }, "fail"],
    [{ event: "pull_request", full: "true", labs: [...all("success"), "success"] }, "fail"],
    [{ event: "pull_request", full: "true", labs: [] }, "fail"],
  );
  // Every position in LABS counts: one unexpected result anywhere fails the run.
  for (const index of labJobIds.keys()) {
    const at = (base, result) => base.map((r, i) => (i === index ? result : r));
    cases.push(
      [{ event: "pull_request", full: "true", labs: at(all("success"), "failure") }, "fail"],
      [{ event: "push", full: "false", labs: at(all("skipped"), "success") }, "fail"],
      [{ event: "pull_request", full: "true", labs: at(all("success"), "") }, "fail"],
    );
  }
  for (const [input, expected] of cases)
    assert.equal(outcome(input), expected, JSON.stringify(input));
});

test("scope runs everything unless a pull request changes only Markdown or a push merges its head unchanged", (t) => {
  const run = steps(ci.jobs.scope)[1].run;
  const root = mkdtempSync(join(tmpdir(), "morrow-ci-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const gitEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "ci-scope-test",
    GIT_AUTHOR_EMAIL: "ci-scope-test@example.invalid",
    GIT_COMMITTER_NAME: "ci-scope-test",
    GIT_COMMITTER_EMAIL: "ci-scope-test@example.invalid",
  };
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...gitEnv },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  spawnSync("git", ["init", "-q", repo], { env: { ...process.env, ...gitEnv } });
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  write("README.md", "readme\n");
  write("docs/plan/build-plan.md", "plan\n");
  write("docs/contracts/routes.json", "{}\n");
  write("scripts/a.mjs", "export {};\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const branch = (name, change) => {
    git("checkout", "-q", "-b", name, base);
    change();
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", name);
    return git("rev-parse", "HEAD");
  };
  const decide = (env) => {
    const output = join(root, "output-" + Math.random().toString(36).slice(2));
    writeFileSync(output, "");
    const result = runStep(run, { ...gitEnv, GITHUB_OUTPUT: output, ...env }, repo);
    return { status: result.status, output: readFileSync(output, "utf8") };
  };
  const pr = (head, from = base) =>
    decide({ EVENT_NAME: "pull_request", BASE_SHA: from, HEAD_SHA: head });
  const markdown = branch("markdown", () => {
    write("README.md", "changed\n");
    write("docs/plan/build-plan.md", "plan changed\n");
    write("docs/packets/P99.T01a.md", "new\n");
  });
  // main moved on after the branch point; the three-dot diff ignores main's own changes.
  const mainAhead = branch("main-ahead", () => write("scripts/a.mjs", "export const a = 1;\n"));
  assert.deepEqual(pr(markdown), { status: 0, output: "full=false\n" });
  assert.deepEqual(pr(markdown, mainAhead), { status: 0, output: "full=false\n" });
  const removed = branch("removed", () => rmSync(join(repo, "README.md")));
  assert.deepEqual(pr(removed), { status: 0, output: "full=false\n" });
  for (const [name, change] of [
    ["code", () => write("scripts/a.mjs", "export const b = 1;\n")],
    ["contract-json-under-docs", () => write("docs/contracts/routes.json", "[]\n")],
    [
      "mixed",
      () => {
        write("README.md", "x\n");
        write("scripts/b.mjs", "export {};\n");
      },
    ],
    ["renamed-out-of-markdown", () => git("mv", "README.md", "README.txt")],
    // Without --no-renames, git would list only the new .md name of a moved code file.
    ["code-renamed-to-markdown", () => git("mv", "scripts/a.mjs", "scripts/a.md")],
    ["markdown-lookalike", () => write("docs/notes.md.json", "{}\n")],
    ["empty", () => {}],
  ])
    assert.deepEqual(pr(branch(name, change)), { status: 0, output: "full=true\n" }, name);
  // A manual run is always full, without reading the diff.
  assert.deepEqual(decide({ EVENT_NAME: "workflow_dispatch", BASE_SHA: "", HEAD_SHA: "" }), {
    status: 0,
    output: "full=true\n",
  });
  // A push runs light only when it is a merge whose tree is exactly its second parent's
  // (the merged pull request head, which needed a green `foundation`, ADR-0014 item 1).
  const push = (sha) => decide({ EVENT_NAME: "push", BASE_SHA: "", HEAD_SHA: "", PUSHED_SHA: sha });
  const merge = (into, head, name) => {
    git("checkout", "-q", "-B", "trunk-" + name, into);
    git("merge", "-q", "--no-ff", "--no-edit", "-m", "merge " + name, head);
    return git("rev-parse", "HEAD");
  };
  const upToDate = branch("up-to-date", () => write("scripts/a.mjs", "export const c = 1;\n"));
  assert.deepEqual(push(merge(base, upToDate, "up-to-date")), {
    status: 0,
    output: "full=false\n",
  });
  // The head lacked main's latest commit, so the merged tree was never checked as a whole.
  const stale = branch("stale", () => write("scripts/c.mjs", "export {};\n"));
  assert.deepEqual(push(merge(mainAhead, stale, "stale")), { status: 0, output: "full=true\n" });
  // A Markdown-only head merged into a main that moved on: the same.
  assert.deepEqual(push(merge(mainAhead, markdown, "stale-markdown")), {
    status: 0,
    output: "full=true\n",
  });
  // A head that already contained main, merged unchanged: light.
  git("checkout", "-q", "-b", "contains-main", mainAhead);
  write("scripts/d.mjs", "export {};\n");
  git("add", "-A");
  git("commit", "-q", "-m", "contains-main");
  const containsMain = git("rev-parse", "HEAD");
  assert.deepEqual(push(merge(mainAhead, containsMain, "contains-main")), {
    status: 0,
    output: "full=false\n",
  });
  // A single-parent commit (a squash merge or a direct push) runs everything.
  assert.deepEqual(push(upToDate), { status: 0, output: "full=true\n" });
  assert.deepEqual(push(base), { status: 0, output: "full=true\n" });
  // An unknown pushed commit runs everything rather than failing open.
  assert.deepEqual(push("0".repeat(40)), { status: 0, output: "full=true\n" });
  // An unreadable diff fails the job, so `foundation` fails; nothing is decided.
  const broken = pr(markdown, "0".repeat(40));
  assert.notEqual(broken.status, 0);
  assert.equal(broken.output, "");
});

// Expands each workflow run step over its job's matrix and step env, then collects
// every npm script it reaches through `npm run` chains in package.json.
// `npm run x --workspaces` and `npm run x -w pkg` run workspace package scripts, not
// root scripts, so they are not followed.
// A container step (P04.T02a) runs its npm scripts through `sh -c '…'`; unwrap it.
const rootScriptsRun = (command) =>
  command
    .replace(/ -c '([^']*)'/g, (_, inner) => " && " + inner)
    .split("&&")
    .map((segment) => /^npm run "?([A-Za-z0-9:._-]+)"?(.*)$/.exec(segment.trim()))
    .filter((m) => m && !/(^|\s)(--workspaces?|-w)(\s|=|$)/.test(m[2]))
    .map((m) => m[1]);
function scriptsReachedBy(workflow, jobIds = Object.keys(workflow.jobs)) {
  const reached = new Map();
  const visit = (name, via, stack = []) => {
    assert.ok(Object.hasOwn(scripts, name), `${via} runs missing npm script ${name}`);
    assert.ok(!stack.includes(name), `npm script cycle through ${name}`);
    reached.set(name, (reached.get(name) ?? 0) + 1);
    for (const child of rootScriptsRun(scripts[name])) visit(child, name, [...stack, name]);
  };
  for (const id of jobIds) {
    const job = workflow.jobs[id];
    const axes = Object.entries(job.strategy?.matrix ?? {});
    let variants = [{}];
    for (const [axis, values] of axes)
      variants = variants.flatMap((variant) => values.map((v) => ({ ...variant, [axis]: v })));
    for (const variant of variants)
      for (const step of steps(job)) {
        if (typeof step.run !== "string") continue;
        if (step.if?.startsWith("matrix.")) {
          const condition = /^matrix\.([a-z]+) == '([a-z0-9-]+)'$/.exec(step.if);
          assert.ok(condition, `${id} step condition ${step.if}`);
          if (String(variant[condition[1]]) !== condition[2]) continue;
        }
        const env = Object.fromEntries(
          Object.entries(step.env ?? {}).map(([k, v]) => [
            k,
            String(v).replace(/\$\{\{ matrix\.([a-z]+) \}\}/g, (_, axis) => variant[axis]),
          ]),
        );
        const command = step.run.replace(/\$\{?([A-Z_]+)\}?/g, (whole, name) => env[name] ?? whole);
        for (const name of rootScriptsRun(command)) visit(name, `${id} ${JSON.stringify(variant)}`);
      }
  }
  return reached;
}
// A full run (a pull request that changes more than Markdown, or a manual run) runs every
// job; a push to main or a Markdown-only pull request runs only the ungated jobs.
const scriptsReachedByCi = () => scriptsReachedBy(ci);
const scriptsReachedByLightRun = () =>
  scriptsReachedBy(
    ci,
    Object.keys(ci.jobs).filter((id) => ci.jobs[id].if !== fullGate),
  );

test("CI runs every lab script exactly once and covers the local npm run ci pipeline", async () => {
  const reached = scriptsReachedByCi();
  for (const [name, text] of Object.entries(scripts)) {
    if (name.startsWith("lab:group:"))
      assert.match(text, /^npm run lab:[a-z0-9-]+( && npm run lab:[a-z0-9-]+)*$/, name);
    if (!name.startsWith("lab:") || labsOutsideCi(name)) continue;
    assert.equal(reached.get(name), 1, `${name} must run exactly once in CI`);
  }
  for (const name of reached.keys()) assert.ok(!labsOutsideCi(name), `${name} must not run in CI`);
  // `checks` runs `npm test` itself: the runner lists every top-level tests/*.test.mjs
  // file exactly once, parallel-safe or serial (P03.T04e §2), and CI passes no shard.
  assert.equal(scripts.test, "node scripts/run-tests.mjs");
  assert.equal(scripts["test:shard"], undefined, "CI no longer shards the unit tests");
  const testSteps = Object.values(ci.jobs).flatMap((job) =>
    steps(job).filter((s) => typeof s.run === "string" && /\bnpm (run )?test\b/.test(s.run)),
  );
  assert.deepEqual(
    testSteps.map((s) => [s.run, s.env]),
    [["npm test", undefined]],
  );
  assert.ok(steps(ci.jobs.checks).includes(testSteps[0]));
  let listed = "";
  assert.equal(await runTests(["--list"], { write: (text) => (listed += text) }), 0);
  const plan = JSON.parse(listed);
  const files = listUnitFiles();
  assert.ok(files.length > 50);
  assert.deepEqual([...plan.parallel, ...plan.serial].sort(), files);
  for (const name of rootScriptsRun(scripts.ci))
    if (name !== "test") assert.ok(reached.has(name), `CI must run ${name}`);
  assert.ok(reached.has("smoke:scaffold"));
});

// P03.T04f: a push to main or a Markdown-only pull request still runs the static checks
// (plan:check and every other check that reads Markdown) and the unit tests, but no lab.
test("a light run keeps the static checks and unit tests and runs no lab or UI check", () => {
  const light = scriptsReachedByLightRun();
  for (const name of [
    "format:check",
    "typecheck",
    "verify",
    "plan:check",
    "graph:check",
    "verify:delivery",
    "build",
    "smoke:scaffold",
    "lab",
  ])
    assert.ok(light.has(name), name);
  assert.ok(steps(ci.jobs.checks).some((s) => s.run === "npm test"));
  for (const name of light.keys())
    assert.ok(
      !/^(lab|ui|edge):/.test(name) || name === "edge:check",
      `${name} runs only in a full run`,
    );
  // Every lab, UI and edge script that CI runs is in a gated job.
  const full = scriptsReachedByCi();
  const gated = scriptsReachedBy(ci, labJobIds);
  for (const name of full.keys())
    if (/^(lab|ui):/.test(name) || name === "edge:dry-run")
      assert.equal(gated.get(name), full.get(name), name);
});

// Every repository source file a gated CI job can load: the files its npm scripts name,
// then, transitively, every relative or `@morrow/*` import and every string literal that
// names an existing repository source file (esbuild entry points, spawned scripts). Paths
// built at run time are not followed.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceExtension = /\.(?:mjs|cjs|js|ts|tsx|mts|cts)$/;
const isRepoFile = (path) => {
  try {
    return statSync(join(repoRoot, path)).isFile();
  } catch {
    return false;
  }
};
// "@morrow/<name>[/<subpath>]" to the workspace source file its package exports.
const workspaceSources = new Map();
for (const group of ["packages", "apps"])
  for (const directory of readdirSync(join(repoRoot, group))) {
    const manifestPath = join(repoRoot, group, directory, "package.json");
    if (!isRepoFile(posix.join(group, directory, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const exported =
      typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
    for (const [subpath, target] of Object.entries(exported)) {
      const file = typeof target === "string" ? target : (target?.import ?? target?.default);
      if (typeof file === "string" && sourceExtension.test(file))
        workspaceSources.set(manifest.name + subpath.slice(1), posix.join(group, directory, file));
    }
  }
function resolveSource(from, specifier) {
  if (workspaceSources.has(specifier)) return workspaceSources.get(specifier);
  let base;
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    base = posix.join(posix.dirname(from), specifier);
  else if (/^(?:scripts|tests|packages|apps|infra)\//.test(specifier))
    base = posix.normalize(specifier);
  else return null;
  if (base.startsWith("../") || base.split("/").includes("node_modules")) return null;
  const candidates = [base, base.replace(/\.(m?)js$/, ".$1ts"), base.replace(/\.js$/, ".tsx")];
  candidates.push(base + ".ts", base + ".tsx", base + ".mjs", base + ".js", base + "/index.ts");
  return candidates.find((c) => sourceExtension.test(c) && isRepoFile(c)) ?? null;
}
function sourcesReachedFrom(entries) {
  const reached = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const [, specifier] of readFileSync(join(repoRoot, file), "utf8").matchAll(
      /["'`]([^"'`\s]+)["'`]/g,
    )) {
      const target = resolveSource(file, specifier);
      if (target && !reached.has(target)) queue.push(target);
    }
  }
  return reached;
}

// A light run skips the labs on the assumption that no lab reads Markdown; the static
// checks and unit tests that do read it run on every event. A source file that a gated job
// can load and that names a Markdown file fails here; such a lab must instead make `scope`
// treat that file as code.
test("no source file a gated CI job can load names a Markdown file", () => {
  const entries = new Set();
  for (const name of scriptsReachedBy(ci, labJobIds).keys())
    for (const path of scripts[name].match(
      /\b(?:scripts|tests|packages|apps|infra)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx)\b/g,
    ) ?? [])
      entries.add(path);
  assert.ok(entries.size >= 40, String(entries.size));
  // The Workers that edge:dry-run, smoke:edge-dev and the Workers labs bundle, and the
  // workspace SPA entries that the workers and ui jobs build.
  for (const app of readdirSync(join(repoRoot, "apps"))) {
    const config = posix.join("apps", app, "wrangler.jsonc");
    if (!isRepoFile(config)) continue;
    const main = /"main"\s*:\s*"([^"]+)"/.exec(readFileSync(join(repoRoot, config), "utf8"))?.[1];
    assert.ok(main, config);
    entries.add(posix.join("apps", app, main));
  }
  for (const file of readdirSync(join(repoRoot, "apps/workspace-web/src")))
    if (/main\.tsx$/.test(file)) entries.add("apps/workspace-web/src/" + file);
  for (const path of entries) assert.ok(isRepoFile(path), path);
  const reached = sourcesReachedFrom(entries);
  // The walk follows relative imports, workspace packages and named source files.
  for (const path of [
    "scripts/local-postgres-lab.mjs",
    "scripts/fixtures/controlled-neon-postgresql-worker.ts",
    "packages/identity/src/index.ts",
    "packages/contracts/src/index.ts",
    "apps/broker/src/index.ts",
    "apps/workspace-web/src/app.tsx",
  ])
    assert.ok(reached.has(path), path);
  assert.ok(reached.size > 2 * entries.size, `${reached.size} files from ${entries.size}`);
  for (const path of reached)
    assert.doesNotMatch(readFileSync(join(repoRoot, path), "utf8"), /\.md["'`]/, path);
  // The walker itself: a relative `.js` import of a TypeScript file, a workspace subpath
  // export, and a path outside the repository or under node_modules.
  assert.equal(
    resolveSource("packages/identity/src/index.ts", "@morrow/contracts/routes"),
    "packages/contracts/src/routes.ts",
  );
  assert.equal(resolveSource("scripts/x.mjs", "../../outside.mjs"), null);
  assert.equal(resolveSource("scripts/x.mjs", "../node_modules/miniflare/index.js"), null);
});

test("npm run verify runs the plan check, then the graph check, and CI reaches both", () => {
  const verify = rootScriptsRun(scripts.verify);
  assert.ok(verify.includes("plan:check"), "verify must run plan:check");
  assert.equal(
    verify[verify.indexOf("plan:check") + 1],
    "graph:check",
    "graph:check follows plan:check",
  );
  assert.equal(scripts["graph:check"], "node scripts/graph.mjs check");
  assert.ok(rootScriptsRun(scripts.ci).includes("verify"), "npm run ci must run verify");
  for (const name of ["plan:check", "graph:check"])
    assert.ok(scriptsReachedByCi().has(name), `CI must run ${name}`);
});

// The graph builds merged pull request nodes from history, so `checks` (which runs verify)
// fetches all of it, as `scope` does for its diffs. The other jobs keep the default depth.
test("checks fetches full history for the graph check; the lab jobs keep the default depth", () => {
  assert.equal(steps(ci.jobs.checks)[0].with["fetch-depth"], 0);
  for (const id of labJobIds)
    assert.equal(steps(ci.jobs[id])[0].with["fetch-depth"], undefined, id);
});

test("the edge dry-run and dev smoke run once, inside a network-none container with a read-only checkout", () => {
  const steps = Object.values(ci.jobs).flatMap((job) => job.steps ?? []);
  const container = steps.filter(
    (step) => typeof step.run === "string" && step.run.includes("docker run"),
  );
  const edge = container.filter((step) => rootScriptsRun(step.run).includes("edge:dry-run"));
  assert.equal(edge.length, 1);
  const run = edge[0].run;
  assert.deepEqual(rootScriptsRun(run), ["edge:dry-run", "smoke:edge-dev"]);
  for (const flag of ["--network none", "--read-only", '--volume "$PWD:/repo:ro"', "--rm"])
    assert.ok(run.includes(flag), flag);
  assert.match(run, /require\("\.\/infra\/local-engine\.json"\)\.image/);
  assert.match(run, /--volume "\$MORROW_ARTIFACTS_DIR:\/artifacts"/);
  assert.ok(!/\bsecrets\.|CLOUDFLARE_|WORKOS_/.test(run));
  assert.ok(
    scripts.ci.includes("npm run edge:dry-run") && scripts.ci.includes("npm run typecheck:edge"),
  );
  assert.ok(scripts["ci:static"].includes("npm run edge:check"));
});

// P04.T01i AC03 (OQ-2 answer A; ADR-0019 items 4 and 14; trimmed by ADR-0021): the staging
// deploy runs after a green "Morrow foundation" push run on main, in the `staging`
// environment, never cancels a running deploy, and holds the Cloudflare token in exactly
// one step, after the tokenless card, gate 1, gate 2 and gate 5 steps.
test("deploy-staging.yml runs after a green main push, with the token in one step after the tokenless gates", () => {
  const file = "deploy-staging.yml";
  const deploy = workflows[file];
  const text = workflowText(file);
  assert.equal(ci.name, "Morrow foundation");
  assert.deepEqual(deploy.on, {
    workflow_run: { workflows: ["Morrow foundation"], types: ["completed"], branches: ["main"] },
  });
  assert.deepEqual(deploy.concurrency, { group: "deploy-staging", "cancel-in-progress": false });
  assert.deepEqual(Object.keys(deploy.jobs), ["deploy"]);
  const job = deploy.jobs.deploy;
  assert.equal(
    job.if,
    "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository",
  );
  assert.equal(job.environment, "staging");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.ok(job["timeout-minutes"] <= 15);
  const jobSteps = steps(job);
  assert.ok(uses(jobSteps[0], "actions/checkout"));
  // No dependency cache: a cache written by any branch could reach the token's step.
  const setup = jobSteps.find((s) => uses(s, "actions/setup-node"));
  assert.deepEqual(setup.with, { "node-version-file": ".nvmrc" });
  assert.ok(!/\bcache\b/.test(text.replace(/^#.*$/gm, "")));
  const at = (predicate) => jobSteps.findIndex(predicate);
  const install = at((s) => s.run === "npm ci --ignore-scripts --no-audit --no-fund");
  const gates = at((s) => s.id === "gates");
  const gate5 = at((s) => typeof s.run === "string" && s.run.includes("edge:dry-run"));
  const deployStep = at((s) => s.run === "node scripts/staging.mjs deploy --ci");
  const scan = at((s) => s.id === "artifact_scan");
  assert.ok(install < gates && gates < gate5 && gate5 < deployStep && deployStep < scan);
  assert.equal(jobSteps[gates].run, "node scripts/staging.mjs ci-gates");
  assert.equal(jobSteps[gates].if, undefined);
  assert.deepEqual(jobSteps[gates].env, {
    GH_TOKEN: "${{ github.token }}",
    MORROW_DEPLOY_SHA: "${{ github.event.workflow_run.head_sha }}",
    STAGING_DEPLOY_ENABLED: "${{ vars.STAGING_DEPLOY_ENABLED }}",
  });
  assert.deepEqual(rootScriptsRun(jobSteps[gate5].run), ["build", "edge:check", "edge:dry-run"]);
  assert.equal(jobSteps[gate5].env, undefined);
  for (const index of [gate5, deployStep])
    assert.equal(jobSteps[index].if, "steps.gates.outputs.proceed == 'true'");
  // The token sits in the deploy step's env alone; no other step sees a Cloudflare value.
  assert.deepEqual(jobSteps[deployStep].env, {
    CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    GH_TOKEN: "${{ github.token }}",
    MORROW_DEPLOY_SHA: "${{ github.event.workflow_run.head_sha }}",
    STAGING_CLOUDFLARE_ACCOUNT_ID: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    STAGING_DEPLOY_ENABLED: "${{ vars.STAGING_DEPLOY_ENABLED }}",
    STAGING_SCHEMA_HEAD: "${{ vars.STAGING_SCHEMA_HEAD }}",
    STAGING_LOGIN_CONFIGURATION_DIGEST: "${{ vars.STAGING_LOGIN_CONFIGURATION_DIGEST }}",
  });
  for (const [index, step] of jobSteps.entries())
    if (index !== deployStep) assert.ok(!/CLOUDFLARE_|secrets\./.test(JSON.stringify(step)), index);
  // The report is scanned before upload, and the checkout is left clean.
  assert.equal(jobSteps[scan].if, "always()");
  assert.equal(jobSteps[scan].run, 'node scripts/scan-artifacts.mjs "$MORROW_ARTIFACTS_DIR"');
  assert.ok(uses(jobSteps[scan + 1], "actions/upload-artifact"));
  assert.equal(jobSteps[scan + 1].if, "always() && steps.artifact_scan.outcome == 'success'");
  const clean = jobSteps.at(-1);
  assert.equal(clean.if, "always()");
  assert.match(clean.run, /test -z "\$\(git status --porcelain --untracked-files=all\)"/);
  // The subcommands it runs exist.
  for (const name of ["staging:ci-gates", "staging:deploy", "staging:kill", "staging:unkill"])
    assert.ok(scripts[name], name);
});

// P03.T04e §4: the heavy fault matrices run by hand or weekly, behind a change gate, never
// on pull requests or pushes and never as part of the required foundation check.
test("heavy-faults.yml runs by hand or weekly behind the change gate and is never required", () => {
  assert.deepEqual(heavyFaults.on, { workflow_dispatch: null, schedule: [{ cron: "23 3 * * 1" }] });
  assert.deepEqual(heavyFaults.concurrency, {
    group: "heavy-faults",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(heavyFaults.jobs).sort(), ["gate", "heavy"]);
  const { gate, heavy } = heavyFaults.jobs;

  // gate writes no report, so it is exempt from the scan, upload and clean-tree steps.
  assert.equal(gate["runs-on"], "ubuntu-24.04");
  assert.equal(gate["timeout-minutes"], 5);
  assert.deepEqual(gate.outputs, { run: "${{ steps.decide.outputs.run }}" });
  assert.equal(steps(gate).length, 2);
  assert.ok(uses(steps(gate)[0], "actions/checkout"));
  const decide = steps(gate)[1];
  assert.equal(decide.id, "decide");
  assert.deepEqual(decide.env, { EVENT_NAME: "${{ github.event_name }}" });
  assert.match(decide.run, /git log -1 --format=%ct/);
  assert.match(
    decide.run,
    /\[ "\$EVENT_NAME" = workflow_dispatch \] \|\| \[ "\$age" -lt 691200 \]/,
  );
  assert.match(decide.run, /echo "run=\$run" >> "\$GITHUB_OUTPUT"/);
  assert.equal(rootScriptsRun(decide.run).length, 0);

  // heavy runs only when the gate says so, with the hardened sequence of ci.yml.
  assert.equal(heavy.needs, "gate");
  assert.equal(heavy.if, "needs.gate.outputs.run == 'true'");
  assert.equal(heavy["timeout-minutes"], 40);
  assert.deepEqual(Object.keys(heavy.strategy.matrix), ["suite"]);
  assertHardenedSteps("heavy", heavy);
  const body = steps(heavy).find((s) => s.run === 'npm run "heavy:$HEAVY_SUITE"');
  assert.deepEqual(body?.env, { HEAVY_SUITE: "${{ matrix.suite }}" });

  // Every heavy:* script runs exactly once there and never in ci.yml; heavy-faults.yml
  // reaches nothing else, so every lab:* still runs exactly once, in ci.yml.
  const reachedHeavy = scriptsReachedBy(heavyFaults);
  const reachedCi = scriptsReachedByCi();
  const heavyScripts = Object.keys(scripts).filter((name) => name.startsWith("heavy:"));
  assert.ok(heavyScripts.includes("heavy:unit-stress"));
  assert.deepEqual([...reachedHeavy.keys()].sort(), heavyScripts.sort());
  for (const name of heavyScripts) {
    assert.equal(reachedHeavy.get(name), 1, name);
    assert.ok(!reachedCi.has(name), `${name} must not run in ci.yml`);
  }
  assert.equal(
    scripts["heavy:unit-stress"],
    "node scripts/run-tests.mjs --repeat=5 --concurrency=8 --junit=heavy/unit",
  );

  // The required check does not wait for it. (foundation needing exactly the ci.yml jobs is
  // checked above, and `needs` cannot reach another workflow; this names the intent.)
  for (const job of Object.keys(heavyFaults.jobs))
    assert.ok(!ci.jobs.foundation.needs.includes(job), `foundation must not need ${job}`);
});

test("the ui job builds, runs both UI matrices and the browser journey, after installing Chromium", () => {
  const ui = ci.jobs.ui;
  assert.ok(ui, "P14.T01a adds the ui job");
  const commands = steps(ui)
    .map((s) => s.run)
    .filter((run) => typeof run === "string");
  const order = [
    "docker pull",
    "npx playwright install --with-deps chromium",
    "npm run build",
    "npm run ui:check",
    "npm run ui:edge",
    "npm run lab:group:ui",
  ].map((command) => commands.findIndex((run) => run.startsWith(command)));
  assert.ok(
    order.every((index) => index >= 0),
    JSON.stringify(order),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.ok(ci.jobs.foundation.needs.includes("ui"));
  assert.equal(scripts["lab:group:ui"], "npm run lab:workspace-ui-journey");
  assert.match(scripts.ci, /npm run build && npm run verify:workspace-web/);
  assert.match(scripts["ci:static"], /npm run build && npm run verify:workspace-web/);
});

// P04.T01j (ADR-0020): the non-superuser administrator lab runs in the pg-core group only,
// so CI reaches it exactly once; it needs no job of its own.
test("the createrole administrator lab is in pg-core and runs once in CI", () => {
  const holding = Object.entries(scripts)
    .filter(([name]) => name.startsWith("lab:group:"))
    .filter(([, text]) => rootScriptsRun(text).includes("lab:createrole-administrator"))
    .map(([name]) => name);
  assert.deepEqual(holding, ["lab:group:pg-core"]);
  assert.equal(
    scripts["lab:createrole-administrator"],
    "node --import tsx scripts/createrole-administrator-lab.mjs",
  );
  assert.equal(scriptsReachedByCi().get("lab:createrole-administrator"), 1);
});

// P04.T01i D3 (AC06, and P04.T01j-AC14 now that P04.T01j has merged): the staging runner
// lab runs in the pg-http group only, which the `http` leg of the postgres matrix runs
// once. `core` is the leg closest to its 14-minute cap, so the lab is not there.
test("the staging runner lab is in pg-http and runs once in CI, on the http leg", () => {
  const holding = Object.entries(scripts)
    .filter(([name]) => name.startsWith("lab:group:"))
    .filter(([, text]) => rootScriptsRun(text).includes("lab:staging-runner"))
    .map(([name]) => name);
  assert.deepEqual(holding, ["lab:group:pg-http"]);
  assert.equal(scripts["lab:staging-runner"], "node --import tsx scripts/staging-runner-lab.mjs");
  assert.equal(scriptsReachedByCi().get("lab:staging-runner"), 1);
  const postgres = ci.jobs.postgres;
  assert.deepEqual(postgres.strategy.matrix.leg, ["core", "http", "linking", "work"]);
  const runs = steps(postgres).filter((s) => s.run === "npm run lab:group:pg-http");
  assert.deepEqual(
    runs.map((s) => s.if),
    ["matrix.leg == 'http'"],
  );
  assert.ok(ci.jobs.foundation.needs.includes("postgres"));
});

// PR 20: the shop-knowledge lab runs in the pg-http group only, last, on the `http` leg once.
test("the shop-knowledge lab is last in pg-http and runs once in CI, on the http leg", () => {
  const holding = Object.entries(scripts)
    .filter(([name]) => name.startsWith("lab:group:"))
    .filter(([, text]) => rootScriptsRun(text).includes("lab:shop-knowledge"))
    .map(([name]) => name);
  assert.deepEqual(holding, ["lab:group:pg-http"]);
  assert.equal(rootScriptsRun(scripts["lab:group:pg-http"]).at(-1), "lab:shop-knowledge");
  assert.equal(scriptsReachedByCi().get("lab:shop-knowledge"), 1);
});

// ADR-0014, amendment of 2026-10-22: ci.yml alone may run on the owner's Mac runner, chosen
// by the repository variable MORROW_CI_RUNS_ON (unset: GitHub-hosted ubuntu-24.04). It names
// no secret and no environment, so GitHub sends that runner no secret; the staging deploy, the
// heavy faults and the frozen replay stay on GitHub-hosted runners. This pins main's files
// only: GitHub cannot keep a branch's own workflow off an online runner (risk (a)).
test("only ci.yml can run on the Mac runner, chosen by MORROW_CI_RUNS_ON, and it names no secret", () => {
  for (const file of workflowFiles)
    for (const [id, job] of Object.entries(workflows[file].jobs))
      assert.equal(job["runs-on"], file === "ci.yml" ? ciRunsOn : "ubuntu-24.04", `${file} ${id}`);
  for (const file of workflowFiles)
    assert.equal(workflowText(file).includes(ciRunner.variable), file === "ci.yml", file);
  const text = workflowText("ci.yml");
  assert.deepEqual([...new Set(text.match(/\bvars\.[A-Za-z_]+/g))], ["vars.MORROW_CI_RUNS_ON"]);
  assert.ok(!/\bsecrets\.|\bgithub\.token\b|GITHUB_TOKEN|ACTIONS_RUNNER_INPUT_/.test(text));
  assert.deepEqual(ci.permissions, { contents: "read" });
  for (const [id, job] of Object.entries(ci.jobs)) {
    assert.equal(job.environment, undefined, id);
    assert.equal(job.container, undefined, id);
    assert.equal(job.services, undefined, id);
  }
  // Unset, the expression falls back to exactly today's runner.
  const fallback = /^\$\{\{ fromJSON\(vars\.MORROW_CI_RUNS_ON \|\| '(.*)'\) \}\}$/.exec(ciRunsOn);
  assert.equal(JSON.parse(fallback[1]), "ubuntu-24.04");
  // Set, it selects only a self-hosted runner carrying every one of these labels.
  assert.equal(variableValue, '["self-hosted","linux","arm64","morrow-mac"]');
  assert.deepEqual(JSON.parse(variableValue), [...ciRunner.labels]);
});

// infra/ci-runner/compose.yaml: the Docker-in-Docker daemon CI jobs reach, and the runner
// in its network namespace. No host bind mount, host socket, published port or secret.
test("the Mac runner stack shares only named volumes, pins its images and keeps the token off argv", () => {
  const text = readFileSync(new URL("../" + ciRunner.composeFile, import.meta.url), "utf8");
  const stack = parseWorkflow(text);
  assert.equal(stack.name, ciRunner.instances[1].project);
  assert.deepEqual(Object.keys(stack.services).sort(), ["dind", "register", "runner"]);
  assert.deepEqual(stack.volumes, { docker: null, work: null, socket: null, registration: null });
  const { dind, runner, register } = stack.services;
  const mounts = (service) =>
    Object.fromEntries(
      service.volumes.map((entry) => {
        const [source, target, ...rest] = entry.split(":");
        assert.deepEqual(rest, [], entry);
        assert.ok(Object.hasOwn(stack.volumes, source), `${entry} must mount a named volume`);
        return [target, source];
      }),
    );
  assert.deepEqual(mounts(dind), {
    "/var/lib/docker": "docker",
    "/home/runner/_work": "work",
    "/run/morrow-docker": "socket",
  });
  assert.deepEqual(mounts(runner), {
    "/home/runner/_work": "work",
    "/run/morrow-docker": "socket",
    "/morrow/registration": "registration",
  });
  assert.deepEqual(mounts(register), { "/morrow/registration": "registration" });
  // Every key each service may set (and `logging`); anything else fails.
  const shared = ["image", "restart", "volumes", "logging"];
  const allowed = {
    dind: [...shared, "privileged", "command", "environment", "healthcheck"],
    runner: [
      ...shared,
      "init",
      "network_mode",
      "depends_on",
      "shm_size",
      "stop_grace_period",
      "environment",
      "entrypoint",
      "command",
    ],
    register: [...shared, "profiles", "entrypoint", "command"],
  };
  for (const [id, service] of Object.entries(stack.services)) {
    assert.deepEqual(
      Object.keys(service).filter((key) => !allowed[id].includes(key)),
      [],
      `${id}: no ports, env_file, secrets, extra_hosts, devices, capabilities or host modes`,
    );
    assert.match(
      service.image,
      /^(?:docker:\d+\.\d+\.\d+-dind|ghcr\.io\/actions\/actions-runner:\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/,
      id,
    );
  }
  // dind: privileged, a unix socket only (no TCP listener), owned by the runner's docker group.
  assert.equal(dind.privileged, true);
  assert.deepEqual(dind.command, [
    "dockerd",
    "--host=unix:///run/morrow-docker/docker.sock",
    "--group=123",
  ]);
  assert.deepEqual(dind.environment, { DOCKER_TLS_CERTDIR: "" });
  assert.ok(!/tcp:\/\/|:2375|:2376|docker\.sock:/.test(text));
  assert.equal(dind.restart, "unless-stopped");
  // runner: dind's network namespace, after a healthy daemon; the socket at the one path
  // the pgwire and ui labs accept; registration copied in, then the runner itself.
  assert.equal(runner.privileged, undefined);
  assert.equal(runner.network_mode, "service:dind");
  assert.deepEqual(runner.depends_on, { dind: { condition: "service_healthy" } });
  assert.equal(runner.restart, "unless-stopped");
  assert.equal(runner.image, register.image);
  assert.deepEqual(runner.entrypoint, ["/bin/bash", "-euc"]);
  // Each job starts with an empty inner daemon (a cancelled job's containers are gone).
  const hook = "/home/runner/morrow-job-started.sh";
  assert.deepEqual(runner.environment, { ACTIONS_RUNNER_HOOK_JOB_STARTED: hook });
  const [start] = runner.command;
  assert.ok(start.includes("sudo -n ln -sfn /run/morrow-docker/docker.sock /var/run/docker.sock"));
  assert.ok(start.includes("for file in .runner .credentials .credentials_rsaparams; do"));
  assert.ok(start.trimEnd().endsWith("exec ./run.sh"));
  assert.ok(start.includes(`cat > ${hook} <<'HOOK'\n#!/bin/bash\nset -eu\n`));
  // Compose reads `$$` as a literal `$`, so the hook gets its own shell variables.
  assert.ok(start.includes("docker rm --force --volumes $$containers > /dev/null"));
  assert.ok(start.indexOf(`chmod 0755 ${hook}`) < start.indexOf("exec ./run.sh"));
  // register: a one-off behind a profile. The token arrives only on stdin, which the script
  // exports for config.sh: never argv (no --token), never the stored container environment.
  assert.deepEqual(register.profiles, ["register"]);
  assert.equal(register.restart, "no");
  assert.equal(register.environment, undefined);
  const [script] = register.command;
  assert.ok(script.includes("IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN || true\n"));
  assert.ok(script.indexOf("export ACTIONS_RUNNER_INPUT_TOKEN") < script.indexOf("./config.sh"));
  assert.ok(!/--token|--pat\b/.test(text));
  assert.ok(script.includes(`--url https://github.com/${ciRunner.repository} \\`));
  const custom = ciRunner.labels.filter(
    (label) => !["self-hosted", "linux", "arm64"].includes(label),
  );
  assert.ok(script.includes(`--labels ${custom.join(",")} --work _work`));
  const names = Object.values(ciRunner.instances).map((instance) => instance.name);
  assert.ok(script.includes(`  ${names.join(" | ")}) ;;`));
  // The runner updates itself: GitHub stops sending jobs to an outdated runner.
  assert.ok(!text.includes("disableupdate"));
});
