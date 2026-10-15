import { createHash } from "node:crypto";
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
const archiveRelative = "docs/history/workos-session-status-75";
const evidenceRelative = "docs/evidence/P05.T01h/frozen75-regression.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const frozenWorkosSessionStatus75 = Object.freeze({
  manifestDigest: "234e660c688ee4694afa4bc0b3748fc381d4d425cca0e986bd0602780f524a63",
  sourceDigest: "c5213f08c9d79eee2022e9aa1e297c442e64eae4da9e7bfe28c0872d46cbf9f5",
  commit: "03fd5e63a254639093d810cb4f3934cccd5329e0",
  publishedFiles: 24,
  archiveFiles: 25,
  tests: 43,
});
const testFiles = Object.freeze([
  "tests/workos-session-status.test.mjs",
  "tests/workos-session-status-transport.test.mjs",
  "tests/workos-session-status-input.test.mjs",
]);
const failures = new WeakMap();
function fail(code) {
  const error = Error("WORKOS_STATUS_REGRESSION_" + code);
  failures.set(error, code);
  throw error;
}
export function workosSessionStatusRegressionFailure(error) {
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
  const path = resolve(root, name);
  if (realpathSync(path) !== path) fail("PATH_INVALID");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail("PATH_INVALID");
    const value = readFileSync(fd),
      after = fstatSync(fd);
    if (
      ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].some(
        (key) => before[key] !== after[key],
      )
    )
      fail("PATH_INVALID");
    return value;
  } finally {
    closeSync(fd);
  }
}
export function verifyFrozenWorkosSessionStatusArchive(root = join(repository, archiveRelative)) {
  try {
    exactRoot(root);
    const raw = bytes(root, "archive.json", 32768);
    if (sha(raw) !== frozenWorkosSessionStatus75.manifestDigest) fail("ARCHIVE_INVALID");
    const manifest = JSON.parse(raw);
    if (
      manifest.schema_version !== 1 ||
      manifest.plan_sequence !== 75 ||
      manifest.commit !== frozenWorkosSessionStatus75.commit ||
      manifest.operator_source_digest !== frozenWorkosSessionStatus75.sourceDigest ||
      manifest.published_files.length !== 24 ||
      manifest.post_commit_observations.length !== 1
    )
      fail("ARCHIVE_INVALID");
    const files = [...manifest.published_files, ...manifest.post_commit_observations],
      seen = new Set();
    for (const file of files) {
      if (
        seen.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        sha(bytes(root, file.path)) !== file.sha256
      )
        fail("ARCHIVE_INVALID");
      seen.add(file.path);
    }
    return { ...manifest, files };
  } catch {
    fail("ARCHIVE_INVALID");
  }
}
function currentPlan(root) {
  const p = JSON.parse(bytes(root, "docs/plan/source.json", 65536)).sources?.plan;
  if (
    p?.page_id !== "page_b1ef27b80b788191b91e67cbb52f1037" ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < 76 ||
    p.sha256 !== sha(bytes(root, "docs/plan/build-plan.md"))
  )
    fail("PLAN_INVALID");
  return Object.freeze({ sequence: p.sequence, digest: p.sha256 });
}
export function verifyFrozenWorkosSessionStatusWorkspace(root) {
  try {
    exactRoot(root);
    exactRoot(join(root, "node_modules"));
    exactRoot(join(root, "node_modules/@morrow"));
    const link = join(root, "node_modules/@morrow/identity");
    if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== join(root, "packages/identity"))
      fail("WORKSPACE_INVALID");
    const require = createRequire(pathToFileURL(join(root, testFiles[0])));
    if (
      realpathSync(require.resolve("@morrow/identity/workos-session-status")) !==
      join(root, "packages/identity/src/workos-session-status.ts")
    )
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
  if (names.length !== 43 || new Set(names.map((value) => value.name)).size !== 43)
    fail("TESTS_INVALID");
  return names;
}
// Overrides select public fixture roots for negative tests only. The executable
// entry point below accepts no override, private input, profile or runner.
export async function createFrozenWorkosSessionStatusFixture({
  source = repository,
  archive = join(source, archiveRelative),
} = {}) {
  let root;
  try {
    exactRoot(source);
    const current = currentPlan(source),
      manifest = verifyFrozenWorkosSessionStatusArchive(archive);
    const tooling = verifyFrozenWorkosOperatorToolchain(source);
    root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-frozen-status75-")));
    for (const file of manifest.files) {
      const destination = join(root, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes(archive, file.path), { flag: "wx", mode: 0o600 });
    }
    mkdirSync(join(root, "node_modules/@morrow"), { recursive: true });
    symlinkSync(
      join(root, "packages/identity"),
      join(root, "node_modules/@morrow/identity"),
      "dir",
    );
    const input = await import(
      pathToFileURL(join(root, "scripts/workos-session-status-input.mjs"))
    );
    const verify = () => {
      verifyFrozenWorkosSessionStatusArchive(archive);
      for (const file of manifest.files)
        if (sha(bytes(root, file.path)) !== file.sha256) fail("COPY_INVALID");
      verifyFrozenWorkosSessionStatusWorkspace(root);
      const scope = JSON.parse(input.loadWorkosSessionStatusScope());
      if (
        scope.planSequence !== 75 ||
        scope.sourceDigest !== frozenWorkosSessionStatus75.sourceDigest ||
        input.workosSessionStatusSourcePaths.length !== 10
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
// node:test streams structured events; arbitrary test stdout/stderr/errors are
// discarded. Only the exact known public test names and fixed counts return.
const childProgram = `import {run} from 'node:test';
import {relative,resolve} from 'node:path';
const results=[],summaries=[];
for await(const event of run({files:${JSON.stringify(testFiles)},concurrency:false,execArgv:process.execArgv})){
 if(event.type==='test:pass'||event.type==='test:fail')results.push({name:event.data.name,file:relative(process.cwd(),resolve(event.data.file??'')),passed:event.type==='test:pass',skipped:Boolean(event.data.skip),todo:Boolean(event.data.todo),nesting:event.data.nesting});
 if(event.type==='test:summary'&&event.data.file===undefined)summaries.push({success:event.data.success,counts:event.data.counts});
}
process.stdout.write(JSON.stringify({results,summaries}));`;
function environment(root) {
  const env = { TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: join(root, "tsconfig.base.json") };
  for (const key of ["PATH", "TMPDIR"])
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  return env;
}
function runTests(fixture) {
  const runner = join(fixture.root, ".morrow-status75-runner.mjs");
  writeFileSync(runner, childProgram, { flag: "wx", mode: 0o600 });
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", fixture.tooling.loader, runner], {
      cwd: fixture.root,
      env: environment(fixture.root),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    // node:test uses subprocesses. On failure terminate this isolated group,
    // rather than leaving an ephemeral HTTP test alive after its runner exits.
    const stop = () => {
      if (!Number.isInteger(child.pid)) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group may already be absent; never reflect OS error details.
      }
    };
    let output = "",
      overflow = false;
    const timer = setTimeout(() => {
      overflow = true;
      stop();
    }, 90000);
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(output) + chunk.length > 65536) {
        overflow = true;
        stop();
      } else output += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      stop();
      reject(Error("CHILD_FAILED"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      stop();
      if (code !== 0 || signal !== null || overflow) {
        return reject(Error("CHILD_FAILED"));
      }
      try {
        resolveResult(JSON.parse(output));
      } catch {
        reject(Error("CHILD_FAILED"));
      }
    });
  });
}
export function verifyFrozenWorkosSessionStatusResults(result, expected) {
  try {
    if (
      !result ||
      Object.keys(result).sort().join(",") !== "results,summaries" ||
      !Array.isArray(result.results) ||
      result.results.length !== 43 ||
      !Array.isArray(result.summaries) ||
      result.summaries.length !== 1 ||
      expected.length !== 43
    )
      fail("RESULT_INVALID");
    const remaining = new Set(expected.map((item) => JSON.stringify([item.file, item.name])));
    for (const row of result.results) {
      if (
        Object.keys(row).sort().join(",") !== "file,name,nesting,passed,skipped,todo" ||
        row.passed !== true ||
        row.skipped !== false ||
        row.todo !== false ||
        row.nesting !== 0 ||
        !remaining.delete(JSON.stringify([row.file, row.name]))
      )
        fail("RESULT_INVALID");
    }
    const summary = result.summaries[0],
      c = summary.counts;
    if (
      summary.success !== true ||
      !c ||
      c.tests !== 43 ||
      c.passed !== 43 ||
      c.failed !== 0 ||
      c.cancelled !== 0 ||
      c.skipped !== 0 ||
      c.todo !== 0 ||
      c.suites !== 0 ||
      c.topLevel !== 43 ||
      remaining.size !== 0
    )
      fail("RESULT_INVALID");
    return true;
  } catch {
    fail("RESULT_INVALID");
  }
}
export async function runWorkosSessionStatusRegression() {
  let fixture;
  try {
    fixture = await createFrozenWorkosSessionStatusFixture();
    const initial = fixture.current,
      archive = join(repository, archiveRelative);
    fixture.verify();
    const result = await runTests(fixture);
    verifyFrozenWorkosSessionStatusResults(result, fixture.expected);
    fixture.verify();
    verifyFrozenWorkosOperatorToolchain(repository);
    if (JSON.stringify(currentPlan(repository)) !== JSON.stringify(initial)) fail("PLAN_INVALID");
    const manifest = verifyFrozenWorkosSessionStatusArchive(archive);
    const tooling = fixture.tooling;
    fixture.dispose();
    if (existsSync(fixture.root)) fail("CLEANUP_FAILED");
    const report = {
      task: "P05.T01i",
      observed_at: new Date().toISOString(),
      current_plan_sequence: initial.sequence,
      current_plan_digest: initial.digest,
      preserved_plan_sequence: 75,
      source_commit: frozenWorkosSessionStatus75.commit,
      operator_source_digest: frozenWorkosSessionStatus75.sourceDigest,
      scope:
        "Checked-copy synthetic Node reader, native-transport and input tests only; no original private inputs, credential access, provider activation, SQL or Docker. The original actual75 negative observation is retained as separate historical evidence, not rerun.",
      archive_manifest_sha256: frozenWorkosSessionStatus75.manifestDigest,
      published_files: 24,
      post_commit_observations: 1,
      archive_files: Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256])),
      tooling: {
        node: process.version,
        platform_package: tooling.platformPackage,
        platform_binary_digest: tooling.binaryDigest,
        platform_package_integrity: tooling.packageIntegrity,
      },
      tests: result.results.map((item) => ({ name: item.name, file: item.file, passed: true })),
      counts: result.summaries[0].counts,
      archive_unchanged: true,
      copied_execution_sources_unchanged: true,
      temporary_copy_removed: true,
      regression_sources: Object.fromEntries(
        [
          "scripts/workos-session-status-regression.mjs",
          "tests/workos-session-status-regression.test.mjs",
          "tests/workos-session-status-input.test.mjs",
          "scripts/workos-operator-regression.mjs",
        ].map((path) => [path, sha(bytes(repository, path))]),
      ),
    };
    const path = join(repository, evidenceRelative),
      staged = path + ".tmp";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staged, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(staged, path);
    console.log(
      "Frozen75: 43 exact synthetic tests passed; archived files unchanged and temporary copy removed.",
    );
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
    await runWorkosSessionStatusRegression();
  } catch (error) {
    console.error(
      JSON.stringify({ outcome: "held", code: workosSessionStatusRegressionFailure(error) }),
    );
    process.exitCode = 1;
  }
}
