import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Structural checks of the GitHub workflows and the npm scripts they reach. They replace
// the workflow assertions of the retired CI evidence collector: hardening settings,
// the aggregator's dependencies, the secret-scan gate on uploads and complete lab coverage.

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const scripts = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).scripts;
const headRef = "${{ github.event.pull_request.head.sha || github.sha }}";
const pinnedAction = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
// Never run by CI: lab:engine is the standalone engine probe (pg-core records the engine
// build inline), and lab:e2b-* are offline-by-default provider operator commands.
const labsOutsideCi = (name) => name === "lab:engine" || name.startsWith("lab:e2b-");

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
const steps = (job) => job.steps ?? [];
const uses = (step, action) => typeof step.uses === "string" && step.uses.startsWith(action + "@");

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
});

test("every workflow pins actions by commit, never persists credentials and never continues on error", () => {
  assert.ok(workflowFiles.includes("ci.yml"));
  for (const file of workflowFiles) {
    const text = workflowText(file);
    const workflow = workflows[file];
    assert.ok(!text.includes("continue-on-error"), file);
    assert.ok(!text.includes("pull_request_target"), file);
    assert.ok(!/\bsecrets\./.test(text), file);
    assert.deepEqual(workflow.permissions, { contents: "read" }, file);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.permissions, undefined, `${file} ${id} must not widen permissions`);
      for (const step of steps(job)) {
        if (step.uses !== undefined) assert.match(step.uses, pinnedAction, `${file} ${id}`);
        if (uses(step, "actions/checkout")) {
          assert.equal(step.with?.["persist-credentials"], false, `${file} ${id}`);
          assert.equal(
            step.with?.ref,
            file === "ci.yml" ? headRef : "codex-archive-f89ad75",
            `${file} ${id}`,
          );
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
        if (file !== "ci.yml") assert.ok(!step.if.includes("always()"), `${file} ${id}`);
      }
    }
  assert.ok(uploads >= Object.keys(ci.jobs).length - 1);
});

test("every ci.yml job shares the hardened step sequence and foundation needs every job", () => {
  const { foundation, ...jobs } = ci.jobs;
  assert.ok(foundation, "foundation keeps the required status check name");
  assert.deepEqual([...foundation.needs].sort(), Object.keys(jobs).sort());
  assert.equal(foundation.if, "always()");
  assert.equal(foundation["runs-on"], "ubuntu-24.04");
  const aggregate = foundation.steps.at(-1);
  assert.equal(aggregate.env?.RESULTS, "${{ join(needs.*.result, ' ') }}");
  assert.match(aggregate.run, /test -n "\$RESULTS"/);
  assert.match(aggregate.run, /\[ "\$r" = success \] \|\| \{ [^}]*exit 1; \}/);
  for (const [id, job] of Object.entries(jobs)) {
    const jobSteps = steps(job);
    const at = (predicate) => jobSteps.findIndex(predicate);
    assert.equal(job["runs-on"], "ubuntu-24.04", id);
    assert.ok(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] <= 15, id);
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
    assert.equal(jobSteps[scan].run, 'node scripts/scan-artifacts.mjs "$MORROW_ARTIFACTS_DIR"');
    assert.equal(jobSteps[upload].if, "always() && steps.artifact_scan.outcome == 'success'");
    assert.equal(jobSteps[upload].with.path, "${{ runner.temp }}/morrow-artifacts");
    assert.equal(jobSteps[upload].with["if-no-files-found"], id === "unit" ? "ignore" : "error");
    assert.equal(upload, jobSteps.length - 2, id);
    const clean = jobSteps.at(-1);
    assert.equal(clean.if, "always()", id);
    assert.match(clean.run, /test -z "\$\(git status --porcelain --untracked-files=all\)"/, id);
    // Body steps run unconditionally, except a step restricted to one matrix leg.
    for (const step of jobSteps.slice(install + 1, scan))
      assert.ok(step.if === undefined || /^matrix\.[a-z]+ == '[a-z0-9-]+'$/.test(step.if), id);
  }
});

// Expands each ci.yml run step over its job's matrix and step env, then collects
// every npm script it reaches through `npm run` chains in package.json.
// `npm run x --workspaces` and `npm run x -w pkg` run workspace package scripts, not
// root scripts, so they are not followed.
const rootScriptsRun = (command) =>
  command
    .split("&&")
    .map((segment) => /^npm run "?([A-Za-z0-9:._-]+)"?(.*)$/.exec(segment.trim()))
    .filter((m) => m && !/(^|\s)(--workspaces?|-w)(\s|=|$)/.test(m[2]))
    .map((m) => m[1]);
function scriptsReachedByCi() {
  const reached = new Map();
  const visit = (name, via, stack = []) => {
    assert.ok(Object.hasOwn(scripts, name), `${via} runs missing npm script ${name}`);
    assert.ok(!stack.includes(name), `npm script cycle through ${name}`);
    reached.set(name, (reached.get(name) ?? 0) + 1);
    for (const child of rootScriptsRun(scripts[name])) visit(child, name, [...stack, name]);
  };
  for (const [id, job] of Object.entries(ci.jobs)) {
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

test("CI runs every lab script exactly once and covers the local npm run ci pipeline", () => {
  const reached = scriptsReachedByCi();
  for (const [name, text] of Object.entries(scripts)) {
    if (name.startsWith("lab:group:"))
      assert.match(text, /^npm run lab:[a-z0-9-]+( && npm run lab:[a-z0-9-]+)*$/, name);
    if (!name.startsWith("lab:") || labsOutsideCi(name)) continue;
    assert.equal(reached.get(name), 1, `${name} must run exactly once in CI`);
  }
  for (const name of reached.keys()) assert.ok(!labsOutsideCi(name), `${name} must not run in CI`);
  // The unit shards run the same command as `npm test`, split by file.
  assert.equal(
    scripts["test:shard"],
    scripts.test.replace(" tests/", " --test-shard=$TEST_SHARD tests/"),
  );
  const unit = ci.jobs.unit;
  const shards = unit.strategy.matrix.shard;
  assert.deepEqual(
    shards,
    shards.map((_, i) => i + 1),
  );
  assert.equal(
    steps(unit).find((s) => s.run === "npm run test:shard")?.env?.TEST_SHARD,
    "${{ matrix.shard }}/" + shards.length,
  );
  for (const name of rootScriptsRun(scripts.ci))
    assert.ok(reached.has(name === "test" ? "test:shard" : name), `CI must run ${name}`);
  assert.ok(reached.has("smoke:scaffold"));
});
