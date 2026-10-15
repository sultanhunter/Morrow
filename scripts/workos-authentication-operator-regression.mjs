import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyFrozenWorkosOperatorToolchain } from "./workos-operator-regression.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archiveRelative = "docs/history/workos-authentication-operator-80";
const labReport = "docs/evidence/P05.T01l/postgresql-loopback-lab.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const frozenWorkosAuthenticationOperator80 = Object.freeze({
  manifestDigest: "a9ad2225a4ca8472906c196f7a7979ba00d6a1648f7742679098ab7f8c0374a5",
  sourceDigest: "974598e9c3e407f18f375ac0b0d53e87db4373e4ea59b8cd65e64409c0a8c4f8",
  commit: "7c58249c8feae7cccfc53f412ff68d200e9bf6b4",
  archiveFiles: 45,
  sourceFiles: 37,
  tests: 72,
  checks: 181,
});
const testFiles = Object.freeze(
  ["input", "journal", "controller", "native", "listener", "cli"].map(
    (part) => `tests/workos-authentication-operator-${part}.test.mjs`,
  ),
);
const regressionFiles = Object.freeze([
  "scripts/workos-authentication-operator-regression.mjs",
  "tests/workos-authentication-operator-regression.test.mjs",
  "scripts/workos-operator-regression.mjs",
]);
const failures = new WeakMap();
function fail(code) {
  const error = Error("WORKOS_AUTHENTICATION_REGRESSION_" + code);
  failures.set(error, code);
  throw error;
}
export function workosAuthenticationRegressionFailure(error) {
  return failures.get(error) ?? "FAILED";
}
function exactRoot(root) {
  if (
    typeof root !== "string" ||
    resolve(root) !== root ||
    realpathSync(root) !== root ||
    !lstatSync(root).isDirectory()
  )
    fail("PATH_INVALID");
  return root;
}
function bytes(root, name, limit = 16 * 1024 * 1024) {
  if (
    typeof name !== "string" ||
    !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(name) ||
    name.split("/").some((part) => part === "." || part === "..")
  )
    fail("PATH_INVALID");
  const target = resolve(root, name);
  if (realpathSync(target) !== target) fail("PATH_INVALID");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail("PATH_INVALID");
    const data = readFileSync(fd),
      after = fstatSync(fd);
    if (
      ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].some(
        (key) => before[key] !== after[key],
      )
    )
      fail("PATH_INVALID");
    return data;
  } finally {
    closeSync(fd);
  }
}
export function verifyFrozenWorkosAuthenticationArchive(root = join(repository, archiveRelative)) {
  try {
    exactRoot(root);
    const raw = bytes(root, "archive.json", 32768);
    if (sha(raw) !== frozenWorkosAuthenticationOperator80.manifestDigest) fail("ARCHIVE_INVALID");
    const manifest = JSON.parse(raw);
    if (
      manifest.schema_version !== 1 ||
      manifest.plan_sequence !== 80 ||
      manifest.commit !== frozenWorkosAuthenticationOperator80.commit ||
      manifest.operator_source_digest !== frozenWorkosAuthenticationOperator80.sourceDigest ||
      manifest.files.length !== 45 ||
      manifest.runtime_files !== 37 ||
      manifest.test_files !== 6 ||
      manifest.support_files !== 2
    )
      fail("ARCHIVE_INVALID");
    const seen = new Set();
    for (const file of manifest.files) {
      if (
        seen.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        sha(bytes(root, file.path)) !== file.sha256
      )
        fail("ARCHIVE_INVALID");
      seen.add(file.path);
    }
    return manifest;
  } catch {
    fail("ARCHIVE_INVALID");
  }
}
function currentPlan(root) {
  const p = JSON.parse(bytes(root, "docs/plan/source.json", 65536)).sources?.plan;
  if (
    p?.page_id !== "page_b1ef27b80b788191b91e67cbb52f1037" ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < 81 ||
    p.sha256 !== sha(bytes(root, "docs/plan/build-plan.md"))
  )
    fail("PLAN_INVALID");
  return Object.freeze({ sequence: p.sequence, digest: p.sha256 });
}
export function verifyFrozenWorkosAuthenticationWorkspace(root, loader) {
  try {
    exactRoot(root);
    exactRoot(join(root, "node_modules"));
    exactRoot(join(root, "node_modules/@morrow"));
    for (const name of ["identity", "contracts"]) {
      const link = join(root, "node_modules/@morrow", name);
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== join(root, "packages", name))
        fail("WORKSPACE_INVALID");
    }
    const require = createRequire(pathToFileURL(join(root, testFiles[0])));
    const expected = {
      "@morrow/contracts/validation": "packages/contracts/src/validation.ts",
      "@morrow/identity/authentication-exchange-admission":
        "packages/identity/src/authentication-exchange-admission.ts",
      "@morrow/identity/workos-authentication-evidence":
        "packages/identity/src/workos-authentication-evidence.ts",
      "@morrow/identity/workos-session-status": "packages/identity/src/workos-session-status.ts",
      "@morrow/identity/workos-session-token": "packages/identity/src/workos-session-token.ts",
    };
    for (const [specifier, file] of Object.entries(expected))
      if (realpathSync(require.resolve(specifier)) !== join(root, file)) fail("WORKSPACE_INVALID");
    if (typeof loader !== "string" || realpathSync(require.resolve("tsx")) !== loader)
      fail("WORKSPACE_INVALID");
    return true;
  } catch {
    fail("WORKSPACE_INVALID");
  }
}
function expectedNames(root) {
  const names = testFiles.flatMap((file) =>
    [
      ...bytes(root, file)
        .toString("utf8")
        .matchAll(/^test\(\s*("(?:[^"\\]|\\.)*")/gm),
    ].map((match) => ({ file, name: JSON.parse(match[1]) })),
  );
  if (names.length !== 72 || new Set(names.map((value) => value.name)).size !== 72)
    fail("TESTS_INVALID");
  return names;
}
// Overrides are public roots for negative fixture tests only. The runnable
// entrypoint has no caller-selected source, test, lab, private input or mode.
export async function createFrozenWorkosAuthenticationFixture({
  source = repository,
  archive = join(source, archiveRelative),
} = {}) {
  let root;
  try {
    exactRoot(source);
    const current = currentPlan(source),
      manifest = verifyFrozenWorkosAuthenticationArchive(archive);
    const tooling = verifyFrozenWorkosOperatorToolchain(source);
    root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-frozen-authentication80-")));
    for (const file of manifest.files) {
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes(archive, file.path), { flag: "wx", mode: 0o600 });
    }
    mkdirSync(join(root, "node_modules/@morrow"), { recursive: true });
    for (const name of ["identity", "contracts"])
      symlinkSync(join(root, "packages", name), join(root, "node_modules/@morrow", name), "dir");
    // Original CLI unit subprocesses resolve the same qualified pinned loader.
    symlinkSync(dirname(dirname(tooling.loader)), join(root, "node_modules/tsx"), "dir");
    const input = await import(
      pathToFileURL(join(root, "scripts/workos-authentication-operator-input.mjs"))
    );
    const verify = (afterLab = false) => {
      verifyFrozenWorkosAuthenticationArchive(archive);
      for (const file of manifest.files) {
        if (afterLab && file.path === labReport) continue;
        if (sha(bytes(root, file.path)) !== file.sha256) fail("COPY_INVALID");
      }
      verifyFrozenWorkosAuthenticationWorkspace(root, tooling.loader);
      const scope = JSON.parse(input.loadWorkosAuthenticationOperatorScope());
      if (
        scope.planSequence !== 80 ||
        scope.sourceDigest !== frozenWorkosAuthenticationOperator80.sourceDigest ||
        input.workosAuthenticationOperatorSourcePaths.length !== 37
      )
        fail("COPY_INVALID");
      return scope;
    };
    verify();
    return Object.freeze({
      root,
      tooling,
      current,
      verify,
      expected: expectedNames(root),
      dispose: () => rmSync(root, { recursive: true, force: true }),
    });
  } catch {
    if (root) rmSync(root, { recursive: true, force: true });
    fail("PREFLIGHT_FAILED");
  }
}
const childProgram = `import {run} from 'node:test';
import {relative,resolve} from 'node:path';
const results=[],summaries=[];
for await(const event of run({files:${JSON.stringify(testFiles)},concurrency:false,execArgv:process.execArgv})){
 if(event.type==='test:pass'||event.type==='test:fail')results.push({name:event.data.name,file:relative(process.cwd(),resolve(event.data.file??'')),passed:event.type==='test:pass',skipped:Boolean(event.data.skip),todo:Boolean(event.data.todo),nesting:event.data.nesting});
 if(event.type==='test:summary'&&event.data.file===undefined)summaries.push({success:event.data.success,counts:event.data.counts});
}
process.stdout.write(JSON.stringify({results,summaries}));`;
function environment(root, docker) {
  const env = { TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: join(root, "tsconfig.base.json") };
  for (const key of docker
    ? ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
    : ["PATH", "TMPDIR"])
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  return env;
}
function runChild(fixture, file, docker) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", fixture.tooling.loader, join(fixture.root, file)],
      {
        cwd: fixture.root,
        env: environment(fixture.root, docker),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    const stop = () => {
      if (Number.isInteger(child.pid))
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    let output = "",
      overflow = false;
    const timer = setTimeout(
      () => {
        overflow = true;
        stop();
      },
      docker ? 600000 : 120000,
    );
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(output) + chunk.length > 131072) {
        overflow = true;
        stop();
      } else output += chunk.toString("utf8");
    });
    // Raw child diagnostics never leave this boundary. A killed/failed child
    // cannot claim container cleanup; the successful lab report must prove it.
    child.stderr.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      stop();
      reject(Error("CHILD_FAILED"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      stop();
      if (code !== 0 || signal !== null || overflow) return reject(Error("CHILD_FAILED"));
      resolveResult(output);
    });
  });
}
export function verifyFrozenWorkosAuthenticationTests(result, expected) {
  try {
    if (
      !result ||
      Object.keys(result).sort().join(",") !== "results,summaries" ||
      !Array.isArray(result.results) ||
      result.results.length !== 72 ||
      !Array.isArray(result.summaries) ||
      result.summaries.length !== 1 ||
      expected.length !== 72
    )
      fail("TEST_RESULT_INVALID");
    const remaining = new Set(expected.map((item) => JSON.stringify([item.file, item.name])));
    for (const row of result.results)
      if (
        Object.keys(row).sort().join(",") !== "file,name,nesting,passed,skipped,todo" ||
        row.passed !== true ||
        row.skipped !== false ||
        row.todo !== false ||
        row.nesting !== 0 ||
        !remaining.delete(JSON.stringify([row.file, row.name]))
      )
        fail("TEST_RESULT_INVALID");
    const s = result.summaries[0],
      c = s.counts;
    if (
      s.success !== true ||
      !c ||
      c.tests !== 72 ||
      c.passed !== 72 ||
      c.failed !== 0 ||
      c.cancelled !== 0 ||
      c.skipped !== 0 ||
      c.todo !== 0 ||
      c.suites !== 0 ||
      c.topLevel !== 72 ||
      remaining.size
    )
      fail("TEST_RESULT_INVALID");
    return true;
  } catch {
    fail("TEST_RESULT_INVALID");
  }
}
export function verifyFrozenWorkosAuthenticationReport(
  root,
  archive = join(repository, archiveRelative),
) {
  try {
    verifyFrozenWorkosAuthenticationArchive(archive);
    const report = JSON.parse(bytes(root, labReport)),
      original = JSON.parse(bytes(archive, labReport));
    if (
      Object.keys(report).sort().join(",") !== Object.keys(original).sort().join(",") ||
      typeof report.observedAt !== "string" ||
      !Number.isFinite(Date.parse(report.observedAt)) ||
      report.checks.length !== 181 ||
      new Set(report.checks.map((x) => x.name)).size !== 181 ||
      report.checks.some(
        (x, i) =>
          x.passed !== true ||
          x.name !== original.checks[i].name ||
          Object.keys(x).sort().join(",") !== "name,passed",
      )
    )
      fail("LAB_RESULT_INVALID");
    for (const field of Object.keys(original).filter((x) => x !== "observedAt"))
      if (JSON.stringify(report[field]) !== JSON.stringify(original[field]))
        fail("LAB_RESULT_INVALID");
    for (const [file, digest] of Object.entries(report.sourceDigests))
      if (sha(bytes(root, file)) !== digest) fail("LAB_RESULT_INVALID");
    return report;
  } catch {
    fail("LAB_RESULT_INVALID");
  }
}
export async function runWorkosAuthenticationOperatorRegression() {
  let fixture;
  try {
    const initialSources = Object.fromEntries(
      regressionFiles.map((file) => [file, sha(bytes(repository, file))]),
    );
    fixture = await createFrozenWorkosAuthenticationFixture();
    const runner = ".morrow-authentication80-unit-runner.mjs";
    writeFileSync(join(fixture.root, runner), childProgram, { flag: "wx", mode: 0o600 });
    const units = JSON.parse(await runChild(fixture, runner, false));
    verifyFrozenWorkosAuthenticationTests(units, fixture.expected);
    fixture.verify();
    const output = await runChild(fixture, "scripts/workos-authentication-operator-lab.mjs", true);
    if (
      output !==
      "PASS: 181 synthetic authentication operator SQL/HTTP checks; zero real provider requests.\n"
    )
      fail("LAB_RESULT_INVALID");
    fixture.verify(true);
    const lab = verifyFrozenWorkosAuthenticationReport(fixture.root);
    verifyFrozenWorkosOperatorToolchain(repository);
    if (JSON.stringify(currentPlan(repository)) !== JSON.stringify(fixture.current))
      fail("PLAN_INVALID");
    if (
      Object.entries(initialSources).some(
        ([file, digest]) => sha(bytes(repository, file)) !== digest,
      )
    )
      fail("SOURCE_CHANGED");
    const manifest = verifyFrozenWorkosAuthenticationArchive();
    fixture.dispose();
    if (existsSync(fixture.root)) fail("CLEANUP_FAILED");
    const report = {
      task: "P05.T01m",
      observed_at: new Date().toISOString(),
      status: "frozen80_synthetic_regression_passed_not_provider_qualification",
      current_plan_sequence: fixture.current.sequence,
      current_plan_digest: fixture.current.digest,
      preserved_plan_sequence: 80,
      source_commit: frozenWorkosAuthenticationOperator80.commit,
      operator_source_digest: frozenWorkosAuthenticationOperator80.sourceDigest,
      archive_manifest_sha256: frozenWorkosAuthenticationOperator80.manifestDigest,
      archive_files: Object.fromEntries(manifest.files.map((x) => [x.path, x.sha256])),
      tooling: {
        node: process.version,
        platform_package: fixture.tooling.platformPackage,
        platform_binary_digest: fixture.tooling.binaryDigest,
        platform_package_integrity: fixture.tooling.packageIntegrity,
      },
      tests: units.results.map((x) => ({ name: x.name, file: x.file, passed: true })),
      unit_counts: units.summaries[0].counts,
      checks: lab.checks,
      counts: lab.counts,
      engine: lab.engine,
      cleanup: lab.cleanup,
      cleanup_faults: lab.cleanupFaults,
      source_digests: lab.sourceDigests,
      regression_sources: initialSources,
      archive_unchanged: true,
      copied_execution_sources_unchanged: true,
      temporary_copy_removed: true,
      workspace_resolution: "copied_archived_packages_only",
      scope:
        "Original72 synthetic operator units and181 real isolated SQL/loopback checks in a verified copy. No native activation, actual provider request, private input or new provider qualification. Original actual held trial is not rerun.",
    };
    const target = join(repository, "docs/evidence/P05.T01l/frozen80-regression.json"),
      staged = target + "." + randomUUID();
    mkdirSync(dirname(target), { recursive: true });
    try {
      writeFileSync(staged, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(staged, target);
    } finally {
      rmSync(staged, { force: true });
    }
    return report;
  } catch (error) {
    if (failures.has(error)) throw error;
    fail("FAILED");
  } finally {
    fixture?.dispose();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail("INPUT_DENIED");
    const r = await runWorkosAuthenticationOperatorRegression();
    console.log(
      JSON.stringify({
        status: r.status,
        tests: r.tests.length,
        checks: r.checks.length,
        realProviderRequests: 0,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ outcome: "held", code: workosAuthenticationRegressionFailure(error) }),
    );
    process.exitCode = 1;
  }
}
