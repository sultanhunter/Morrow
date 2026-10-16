import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ciValidationCommands,
  ciValidationReportPaths,
  createCiValidationEvidence,
} from "../scripts/ci-validation-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const auxiliary = ["docs/evidence/index.json", "docs/evidence/P03.T03/example.json"];
const success = () =>
  Object.fromEntries(
    ciValidationCommands.map((c) => [c.id, { outcome: "success", conclusion: "success" }]),
  );
function fixture(t, absent = []) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "morrow-ci-evidence-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sourceRoot = join(base, "source"),
    runnerTemp = join(base, "runner"),
    templates = join(base, "templates");
  for (const p of [sourceRoot, runnerTemp, templates]) mkdirSync(p);
  const originals = new Map();
  const write = (path, bytes) => {
    mkdirSync(dirname(join(sourceRoot, path)), { recursive: true });
    writeFileSync(join(sourceRoot, path), bytes);
  };
  for (const [index, path] of [...ciValidationReportPaths, ...auxiliary].entries()) {
    if (absent.includes(path)) continue;
    const bytes = JSON.stringify({ original: index }) + "\n";
    write(path, bytes);
    originals.set(path, bytes);
  }
  write("program.mjs", "export const value = 1;\n");
  const git = (...args) =>
    execFileSync("git", ["-C", sourceRoot, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "--quiet", "--template=" + templates);
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    "fixture",
  );
  const head = git("rev-parse", "HEAD").toString().trim();
  const options = {
    sourceRoot,
    runnerTemp,
    expectedHead: head,
    runId: "12345",
    runAttempt: "2",
    repository: "sultanhunter/Morrow",
  };
  const service = createCiValidationEvidence(options);
  const fresh = (paths = ciValidationReportPaths) => {
    for (const path of paths) write(path, JSON.stringify({ fresh: true, path }) + "\n");
  };
  return { base, sourceRoot, runnerTemp, options, service, head, originals, write, fresh };
}

test("fixed report inventory is preserved37 plus fourteen T regressions and two new T reports", () => {
  const provenance = JSON.parse(
    readFileSync(
      new URL("../docs/evidence/P05.T01p/current-regressions/provenance.json", import.meta.url),
    ),
  );
  const prior = provenance.measurements.map((m) => m.original_path);
  const current = [
    "workers-lab.json",
    "postgresql-workers-lab.json",
    ...[
      "platform-workers-lab.json",
      "fixed-provider-workers.json",
      "fixed-provider-https.json",
      "logout-workers-lab.json",
      "self-logout-postgresql-lab.json",
      "logout-https-postgresql-lab.json",
      "standalone-workspace-workers.json",
      "standalone-store-linking-workers.json",
      "login-workers-lab.json",
      "standalone-workspace-http.json",
      "workspace-linking-read.json",
      "standalone-store-linking-http.json",
      "login-flow-custody.json",
      "login-https-postgresql-lab.json",
    ].map((p) => "regressions/" + p),
  ].map((p) => "docs/evidence/P05.T01t/canonical89/" + p);
  assert.equal(prior.length, 37);
  assert.deepEqual([...ciValidationReportPaths].sort(), [...prior, ...current].sort());
  assert.equal(new Set(ciValidationReportPaths).size, 53);
  assert.ok(
    ciValidationReportPaths.every(
      (p) => !/(?:history|actual-|local-validation|qualification|provenance)/.test(p),
    ),
  );
});

test("new PostgreSQL producer follows the engine without changing the 42 older producer order", () => {
  // Published87's exact producer ids, recorded independently of the current
  // collector. The two new T producers may not reorder the older suites.
  const olderProducerIds = [
    "install_dependencies",
    "baseline_ci",
    "baseline_smoke",
    "workers_identity",
    "workers_agent",
    "workers_linking",
    "workers_pkce",
    "workers_token",
    "workers_status",
    "workers_evidence",
    "workers_selection",
    "workers_admission",
    "workers_workspace",
    "workers_store",
    "workers_login",
    "workers_logout",
    "workers_fixed_provider",
    "workers_platform_provider",
    "frozen75",
    "sql_engine",
    "sql_operations",
    "sql_restore",
    "sql_identity",
    "sql_permissions",
    "sql_challenge",
    "sql_revocation",
    "sql_linking",
    "sql_pkce",
    "sql_selection",
    "sql_admission",
    "frozen71",
    "frozen74",
    "frozen80",
    "frozen82",
    "http_workspace",
    "sql_link_read",
    "http_linking",
    "sql_custody",
    "https_login",
    "sql_logout",
    "https_logout",
    "https_fixed_provider",
  ];
  const ids = ciValidationCommands.map((c) => c.id);
  assert.equal(ids.length, 44);
  assert.equal(new Set(ids).size, 44);
  assert.deepEqual(
    ids.filter((id) => !["workers_controlled_neon", "postgresql_controlled_neon"].includes(id)),
    olderProducerIds,
  );
  const engine = ids.indexOf("sql_engine");
  assert.deepEqual(ids.slice(engine, engine + 3), [
    "sql_engine",
    "postgresql_controlled_neon",
    "sql_operations",
  ]);
  assert.ok(ids.indexOf("workers_controlled_neon") < engine);
});

test("workflow gives each original command a unique serial step and binds exact PR head/artifact action", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const npmCommands = [...workflow.matchAll(/^        run: (npm [^\n]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(
    npmCommands,
    ciValidationCommands.filter((c) => c.id !== "sql_engine").map((c) => c.run),
  );
  const producerIds = new Set(ciValidationCommands.map((c) => c.id));
  const workflowProducerIds = [...workflow.matchAll(/^        id: ([a-z][a-z0-9_]*)$/gm)]
    .map((m) => m[1])
    .filter((id) => producerIds.has(id));
  assert.deepEqual(
    workflowProducerIds,
    ciValidationCommands.map((c) => c.id),
  );
  for (const c of ciValidationCommands)
    assert.equal(workflow.split("        id: " + c.id + "\n").length - 1, 1);
  assert.ok(workflow.includes("ref: ${{ github.event.pull_request.head.sha || github.sha }}"));
  assert.ok(workflow.includes("persist-credentials: false"));
  assert.ok(workflow.includes("actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f"));
  assert.ok(
    workflow.indexOf("ci-validation-evidence.mjs prepare") < workflow.indexOf("run: npm ci"),
  );
  assert.ok(
    workflow.includes("overwrite: false") &&
      workflow.includes("include-hidden-files: false") &&
      workflow.includes("retention-days: 3"),
  );
  assert.ok(!workflow.includes("continue-on-error"));
  assert.equal((workflow.match(/if: always\(\)/g) ?? []).length, 2);
  assert.ok(
    workflow.includes(
      'node --input-type=module --eval \'import {localPostgresLab} from "./scripts/local-postgres-lab.mjs"; await localPostgresLab("P04.engine-diagnostic", async ({image,version}) => console.log(JSON.stringify({image,version})));\'',
    ),
  );
});

test("prepare removes every stale output before tests, leaves auxiliary inputs, then restores exact originals", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.service.prepare(), { status: "prepared", reportCount: 53 });
  const stateText = readFileSync(join(f.service.runRoot, "preparation.json"), "utf8");
  const state = JSON.parse(stateText);
  assert.equal(state.status, "prepared");
  assert.equal(stateText, JSON.stringify(state, null, 2) + "\n");
  assert.ok(ciValidationReportPaths.every((p) => !existsSync(join(f.sourceRoot, p))));
  for (const path of auxiliary)
    assert.equal(readFileSync(join(f.sourceRoot, path), "utf8"), f.originals.get(path));
  const result = f.service.collect({});
  assert.equal(result.complete, false);
  assert.equal(result.manifest.qualificationStatus, "pending");
  assert.ok(
    result.manifest.reports.every((r) => r.status === "missing_pending" && r.sha256 === null),
  );
  assert.equal(existsSync(join(result.artifact, "reports")), false);
  for (const [path, bytes] of f.originals)
    assert.equal(readFileSync(join(f.sourceRoot, path), "utf8"), bytes);
  assert.equal(result.manifest.designatedOutputsRestored, true);
});

test("fresh full evidence captures exact JSON/snapshots and still awaits final external API validation", (t) => {
  const absent = ciValidationReportPaths.at(-1),
    f = fixture(t, [absent]);
  f.service.prepare();
  f.fresh();
  const historical = ciValidationReportPaths.find((p) => p.endsWith("frozen75-regression.json"));
  const bytes =
    JSON.stringify({
      historical: { sourceDigests: { "old/source.ts": "a".repeat(64) } },
      regression_sources: {},
    }) + "\n";
  f.write(historical, bytes);
  const result = f.service.collect(success());
  assert.equal(result.complete, true);
  assert.equal(result.manifest.collectionStatus, "complete_pending_external_validation");
  assert.equal(result.manifest.qualificationStatus, "pending");
  assert.equal(result.manifest.requiresFinalGitHubJobAndStepApi, true);
  assert.equal(result.manifest.testedHead, f.head);
  assert.equal(result.manifest.sourceStable, true);
  assert.equal(result.manifest.designatedOutputsRestored, true);
  assert.equal(result.manifest.reports.length, 53);
  assert.ok(result.manifest.commands.every((c) => c.actualExitCode === null));
  assert.ok(result.manifest.reports.every((r) => r.status === "fresh_pending_external_validation"));
  for (const r of result.manifest.reports)
    assert.equal(hash(readFileSync(join(result.artifact, "reports", r.path))), r.sha256);
  assert.equal(
    hash(readFileSync(join(result.artifact, "source.before.json"))),
    result.manifest.snapshotBeforeSha256,
  );
  assert.equal(
    hash(readFileSync(join(result.artifact, "source.after-tests.json"))),
    result.manifest.snapshotAfterTestsSha256,
  );
  assert.equal(
    hash(readFileSync(join(result.artifact, "source.after-restore.json"))),
    result.manifest.snapshotAfterRestoreSha256,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(result.artifact, "source.after-restore.json"))),
    JSON.parse(readFileSync(join(result.artifact, "source.before.json"))),
  );
  assert.equal(readFileSync(join(result.artifact, "reports", historical), "utf8"), bytes);
  assert.equal(existsSync(join(f.sourceRoot, absent)), false);
  for (const [path, original] of f.originals)
    assert.equal(readFileSync(join(f.sourceRoot, path), "utf8"), original);
});

test("a failed or softened producer only yields partial pending evidence, never a manufactured numeric exit", (t) => {
  const f = fixture(t);
  f.service.prepare();
  const owner = ciValidationCommands.find((c) => c.id === "baseline_ci");
  f.fresh(owner.reports);
  const steps = success();
  steps.baseline_ci = { outcome: "failure", conclusion: "success" };
  const result = f.service.collect(steps);
  assert.equal(result.complete, false);
  assert.ok(result.manifest.issues.includes("producer_not_success:baseline_ci"));
  assert.ok(
    result.manifest.reports
      .filter((r) => r.producerStep === "baseline_ci")
      .every((r) => r.status === "fresh_partial_pending"),
  );
  assert.ok(result.manifest.commands.every((c) => c.actualExitCode === null));
  assert.equal(result.manifest.qualificationStatus, "pending");
});

test("successful step claims cannot hide a missing required report", (t) => {
  const f = fixture(t);
  f.service.prepare();
  f.fresh(ciValidationReportPaths.slice(1));
  const result = f.service.collect(success());
  assert.equal(result.complete, false);
  assert.ok(result.manifest.issues.includes("report_missing:" + ciValidationReportPaths[0]));
  assert.equal(result.manifest.reports[0].status, "missing_pending");
});

test("prepare failure does not upload committed stale reports or invent a prepared parent", (t) => {
  const f = fixture(t);
  const wrong = createCiValidationEvidence({ ...f.options, expectedHead: "f".repeat(40) });
  assert.throws(() => wrong.prepare(), /CI_VALIDATION_EVIDENCE_PREPARE_FAILED/);
  const result = wrong.collect(success());
  assert.equal(result.complete, false);
  assert.equal(result.manifest.reports.length, 0);
  assert.ok(result.manifest.issues.includes("preparation_failed"));
  assert.equal(existsSync(join(result.artifact, "reports")), false);
  for (const [path, bytes] of f.originals)
    assert.equal(readFileSync(join(f.sourceRoot, path), "utf8"), bytes);
});

test("collect without prepare emits pending metadata only", (t) => {
  const f = fixture(t),
    result = f.service.collect(success());
  assert.equal(result.complete, false);
  assert.equal(result.manifest.reports.length, 0);
  assert.equal(result.manifest.sourceStable, false);
  assert.equal(existsSync(join(result.artifact, "reports")), false);
  assert.ok(result.manifest.issues.includes("preparation_missing_or_invalid"));
});

test("source drift after preparation holds all payload and preserves the changed source for inspection", (t) => {
  const f = fixture(t);
  f.service.prepare();
  f.write("program.mjs", "export const value = 2;\n");
  const result = f.service.collect(success());
  assert.equal(result.complete, false);
  assert.equal(result.manifest.sourceStable, false);
  assert.equal(result.manifest.reports.length, 0);
  assert.ok(result.manifest.issues.includes("source_changed_or_invalid"));
  assert.equal(
    readFileSync(join(f.sourceRoot, "program.mjs"), "utf8"),
    "export const value = 2;\n",
  );
  for (const [path, bytes] of f.originals)
    assert.equal(readFileSync(join(f.sourceRoot, path), "utf8"), bytes);
});

test("escaping report symlinks are never followed, uploaded, or used to overwrite their target", (t) => {
  const f = fixture(t);
  f.service.prepare();
  const outside = join(f.base, "outside.json");
  writeFileSync(outside, '{"outside":true}\n');
  symlinkSync(outside, join(f.sourceRoot, ciValidationReportPaths[0]));
  const result = f.service.collect(success());
  assert.equal(result.complete, false);
  assert.equal(result.manifest.reports.length, 0);
  assert.equal(result.manifest.designatedOutputsRestored, false);
  assert.equal(readFileSync(outside, "utf8"), '{"outside":true}\n');
  assert.equal(existsSync(join(result.artifact, "reports")), false);
});

test("invalid UTF8/JSON is not copied as a report and cannot qualify a successful producer", (t) => {
  const f = fixture(t);
  f.service.prepare();
  f.fresh();
  f.write(ciValidationReportPaths[0], Buffer.from([0xc0, 0xaf]));
  const result = f.service.collect(success());
  assert.equal(result.complete, false);
  assert.equal(result.manifest.reports[0].status, "invalid_pending");
  assert.equal(existsSync(join(result.artifact, "reports", ciValidationReportPaths[0])), false);
});

test("run-attempt preparation and collection are one-use and never reset an earlier artifact", (t) => {
  const f = fixture(t);
  f.service.prepare();
  assert.throws(() => f.service.prepare(), /CI_VALIDATION_EVIDENCE_INVALID/);
  f.fresh();
  const result = f.service.collect(success());
  const manifest = readFileSync(join(result.artifact, "manifest.json"));
  assert.throws(() => f.service.collect(success()));
  assert.deepEqual(readFileSync(join(result.artifact, "manifest.json")), manifest);
});

test("untrusted status fields are dropped and unknown/skipped/cancelled outcomes remain pending", (t) => {
  const f = fixture(t);
  f.service.prepare();
  f.fresh();
  const marker = "synthetic_private_status_output",
    steps = success();
  steps.baseline_ci = { outcome: marker, conclusion: "success", outputs: { marker } };
  steps.baseline_smoke = { outcome: "skipped", conclusion: "skipped" };
  steps.sql_logout = { outcome: "cancelled", conclusion: "cancelled" };
  steps.foreign = { error: marker };
  const result = f.service.collect(steps);
  assert.equal(result.complete, false);
  assert.equal(JSON.stringify(result.manifest).includes(marker), false);
  assert.equal(result.manifest.commands.find((c) => c.stepId === "baseline_ci").outcome, "unknown");
  assert.equal(result.manifest.qualificationStatus, "pending");
});

test("an artifact root inside source or an escaping run identifier is rejected before mutation", (t) => {
  const f = fixture(t);
  assert.throws(() => createCiValidationEvidence({ ...f.options, runnerTemp: f.sourceRoot }));
  assert.throws(() => createCiValidationEvidence({ ...f.options, runId: "../outside" }));
  assert.equal(existsSync(f.service.runRoot), false);
});
