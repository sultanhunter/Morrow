import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
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

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pageId = "page_b1ef27b80b788191b91e67cbb52f1037";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const failureDiagnostics = new WeakMap();
const failure = (kind, stage = "preflight", childCode = null) => {
  const error = Error("WORKOS_REGRESSION_" + kind);
  failureDiagnostics.set(
    error,
    Object.freeze({ stage, code: "WORKOS_REGRESSION_" + kind, childCode }),
  );
  return error;
};
const fail = (kind, stage, childCode) => {
  throw failure(kind, stage, childCode);
};
// Only errors created by this module carry diagnostics. No error property,
// getter, prototype, message, stack or arbitrary child output is inspected.
export function workosRegressionFailureDiagnostic(error) {
  return (
    failureDiagnostics.get(error) ??
    Object.freeze({ stage: "unknown", code: "WORKOS_REGRESSION_FAILED", childCode: null })
  );
}
export const frozenWorkosOperator71 = Object.freeze({
  manifestDigest: "a86e13e0c081696949ee54b787cc5e8fffa25d7bb0cd2c36ff5d3a85c08702ae",
  sourceDigest: "501cd90033d6c85e0c959026f0b2499e7c194c18d70d94dd78fccf248373b250",
  lockDigest: "e7607deb0640f6ff649503dcf453b78a99e27c886fa8582a603dc0ed1396fba7",
  toolingDigest: "a82a4da19cc5bc86ef8eb3385843c17bc5874a2d84a6fdf2e0f9d5a61d85ea0a",
  nodeVersion: "v24.13.0",
  archiveFiles: 42,
  sourceFiles: 29,
  checks: 59,
});
export const frozenWorkosOperator74 = Object.freeze({
  ...frozenWorkosOperator71,
  manifestDigest: "67bd6361a6a3cf4ca03af737f8d5e4e201f8d21b390369368965e2c04923c055",
  sourceDigest: "32bfc0f328e1cc43cfaaa12a9a90ad1fa91f48642a3da8eef3558f05f2972554",
  archiveFiles: 45,
  sourceFiles: 31,
  checks: 99,
});
// These module-owned descriptors are the only execution choices. Public APIs
// below select one explicitly; no caller supplies a descriptor or runner.
const fixed71 = Object.freeze({
  frozen: frozenWorkosOperator71,
  sequence: 71,
  minimumPlan: 72,
  packet: "P05.T01e",
  archiveRelative: "docs/history/workos-operator-71",
  reportRelative: "docs/evidence/P05.T01e/postgresql-loopback-lab.json",
  evidenceDirectory: "docs/evidence/P05.T01e",
  reportName: "frozen-regression.json",
  regressionSources: Object.freeze([
    "scripts/workos-operator-regression.mjs",
    "tests/workos-operator-regression.test.mjs",
    "tests/workos-operator-input.test.mjs",
  ]),
});
const fixed74 = Object.freeze({
  frozen: frozenWorkosOperator74,
  sequence: 74,
  minimumPlan: 75,
  packet: "P05.T01g",
  archiveRelative: "docs/history/workos-operator-74",
  reportRelative: "docs/evidence/P05.T01g/postgresql-loopback-lab.json",
  evidenceDirectory: "docs/evidence/P05.T01g",
  reportName: "frozen74-regression.json",
  regressionSources: Object.freeze([
    "scripts/workos-operator-regression.mjs",
    "scripts/workos-operator74-regression.mjs",
    "tests/workos-operator74-regression.test.mjs",
    "tests/workos-operator-input.test.mjs",
  ]),
});
// Qualified once against the exact official registry tarballs after full SHA512
// SRI validation from the archived lock. Runtime preflight is entirely offline.
const nativePackages = Object.freeze({
  "@esbuild/darwin-arm64": {
    digest: "3e030ee2aa86ad3c33e5e95ae0e53bb03de40e0da35c9b1180a67de4a497cae5",
    integrity:
      "sha512-N3zl+lxHCifgIlcMUP5016ESkeQjLj/959RxxNYIthIg+CQHInujFuXeWbWMgnTo4cp5XVHqFPmpyu9J65C1Yg==",
    url: "https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.25.12.tgz",
  },
  "@esbuild/linux-x64": {
    digest: "bab29b2ca7a9e89b67cf720b77b2d743f9f31f5cf0d5bd74ee8c8de30ced7014",
    integrity:
      "sha512-uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==",
    url: "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.25.12.tgz",
  },
});

// Public fixtures only. The runtime never accepts private roots or provider inputs.
function bytes(root, name, limit = 16 * 1024 * 1024) {
  const target = resolve(root, name);
  if (realpathSync(target) !== target) fail("PATH");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail("PATH");
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.nlink !== 1
    )
      fail("PATH");
    return data;
  } finally {
    closeSync(fd);
  }
}
function exactRoot(root) {
  if (typeof root !== "string" || resolve(root) !== root || realpathSync(root) !== root)
    fail("PATH");
  if (!lstatSync(root).isDirectory()) fail("PATH");
  return root;
}
function pathAllowed(path) {
  return (
    typeof path === "string" &&
    path.length < 256 &&
    /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) &&
    path.split("/").every((part) => part !== "." && part !== "..")
  );
}
function verifyArchive(root, fixed) {
  try {
    exactRoot(root);
    const raw = bytes(root, "archive.json", 32768);
    if (sha(raw) !== fixed.frozen.manifestDigest) fail("ARCHIVE");
    const manifest = JSON.parse(raw);
    const files =
      fixed.sequence === 74
        ? [...manifest.published_files, ...manifest.post_commit_observations]
        : manifest.files;
    if (
      manifest.plan_sequence !== fixed.sequence ||
      manifest.operator_source_digest !== fixed.frozen.sourceDigest ||
      files.length !== fixed.frozen.archiveFiles ||
      (fixed.sequence === 74 &&
        (manifest.published_files.length !== 44 || manifest.post_commit_observations.length !== 1))
    )
      fail("ARCHIVE");
    const seen = new Set();
    for (const file of files) {
      if (!pathAllowed(file.path) || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256))
        fail("ARCHIVE");
      seen.add(file.path);
      if (sha(bytes(root, file.path)) !== file.sha256) fail("ARCHIVE");
    }
    return fixed.sequence === 74 ? { ...manifest, files } : manifest;
  } catch {
    fail("ARCHIVE_INVALID");
  }
}
export function verifyFrozenWorkosOperatorArchive(
  root = join(sourceRoot, fixed71.archiveRelative),
) {
  return verifyArchive(root, fixed71);
}
export function verifyFrozenWorkosOperator74Archive(
  root = join(sourceRoot, fixed74.archiveRelative),
) {
  return verifyArchive(root, fixed74);
}
function plan(root, minimum) {
  const snapshot = JSON.parse(bytes(root, "docs/plan/source.json", 65536));
  const p = snapshot.sources?.plan;
  if (
    p?.page_id !== pageId ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < minimum ||
    p.sha256 !== sha(bytes(root, "docs/plan/build-plan.md"))
  )
    fail("PLAN_INVALID");
  return { sequence: p.sequence, digest: p.sha256 };
}
function tree(root, directory, files) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const name = directory + "/" + entry.name;
    if (entry.isDirectory()) {
      exactRoot(join(root, name));
      tree(root, name, files);
    } else {
      files.push([name, sha(bytes(root, name))]);
    }
    if (files.length > 100) fail("TOOLCHAIN_INVALID");
  }
}
export function verifyFrozenWorkosOperatorToolchain(root = sourceRoot) {
  try {
    exactRoot(root);
    if (
      process.version !== frozenWorkosOperator71.nodeVersion ||
      bytes(root, ".nvmrc", 64).toString().trim() !== "24.13.0" ||
      sha(bytes(root, "package-lock.json")) !== frozenWorkosOperator71.lockDigest
    )
      fail("TOOLCHAIN_INVALID");
    const lock = JSON.parse(bytes(root, "package-lock.json"));
    const modules = exactRoot(join(root, "node_modules"));
    const files = [];
    for (const name of ["tsx", "get-tsconfig", "resolve-pkg-maps"]) tree(modules, name, files);
    tree(modules, "esbuild/lib", files);
    files.push(["esbuild/package.json", sha(bytes(modules, "esbuild/package.json"))]);
    files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (files.length !== 67 || sha(JSON.stringify(files)) !== frozenWorkosOperator71.toolingDigest)
      fail("TOOLCHAIN_INVALID");
    // Pin both portable loader bytes and the selected native binary. No package
    // download, cache parser or installation is performed during this regression.
    const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
    const qualified = nativePackages[platformPackage];
    if (!qualified) fail("TOOLCHAIN_INVALID");
    const native = JSON.parse(bytes(modules, platformPackage + "/package.json"));
    const selected = lock.packages["node_modules/" + platformPackage];
    if (
      native.name !== platformPackage ||
      native.version !== "0.25.12" ||
      selected?.version !== native.version ||
      selected.integrity !== qualified.integrity ||
      selected.resolved !== qualified.url
    )
      fail("TOOLCHAIN_INVALID");
    const binaryDigest = sha(bytes(modules, platformPackage + "/bin/esbuild"));
    if (binaryDigest !== qualified.digest) fail("TOOLCHAIN_INVALID");
    const esbuildRequire = createRequire(pathToFileURL(join(modules, "esbuild/lib/main.js")));
    if (
      realpathSync(esbuildRequire.resolve(platformPackage + "/bin/esbuild")) !==
      join(modules, platformPackage, "bin/esbuild")
    )
      fail("TOOLCHAIN_INVALID");
    const loader = join(modules, "tsx/dist/loader.mjs");
    const require = createRequire(pathToFileURL(loader));
    for (const name of ["esbuild", "get-tsconfig"]) {
      const resolved = realpathSync(require.resolve(name));
      if (!resolved.startsWith(join(modules, name) + "/")) fail("TOOLCHAIN_INVALID");
    }
    return Object.freeze({
      loader,
      platformPackage,
      binaryDigest,
      packageIntegrity: qualified.integrity,
      packageUrl: qualified.url,
    });
  } catch {
    fail("TOOLCHAIN_INVALID");
  }
}
function verifyWorkspace(root, fixed) {
  try {
    exactRoot(root);
    exactRoot(join(root, "node_modules"));
    exactRoot(join(root, "node_modules/@morrow"));
    for (const name of ["contracts", "identity"]) {
      const link = join(root, "node_modules/@morrow", name);
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== join(root, "packages", name))
        fail("WORKSPACE_INVALID");
    }
    const require = createRequire(
      pathToFileURL(join(root, "packages/identity/src/authentication-exchange-admission.ts")),
    );
    const expected = {
      "@morrow/contracts/validation": "packages/contracts/src/validation.ts",
      "@morrow/identity/authentication-exchange-admission":
        "packages/identity/src/authentication-exchange-admission.ts",
    };
    if (fixed.sequence === 74)
      expected["@morrow/identity/workos-session-token"] =
        "packages/identity/src/workos-session-token.ts";
    for (const [specifier, file] of Object.entries(expected)) {
      if (realpathSync(require.resolve(specifier)) !== join(root, file)) fail("WORKSPACE_INVALID");
    }
    return true;
  } catch {
    fail("WORKSPACE_INVALID");
  }
}
export function verifyFrozenWorkosOperatorWorkspace(root) {
  return verifyWorkspace(root, fixed71);
}
export function verifyFrozenWorkosOperator74Workspace(root) {
  return verifyWorkspace(root, fixed74);
}

// The only overrides are public filesystem roots for negative/preparation tests.
// Execution below always uses the real repository, without an injected runner.
async function createFixture(
  fixed,
  { repository = sourceRoot, archive = join(repository, fixed.archiveRelative) } = {},
) {
  let root;
  try {
    exactRoot(repository);
    const current = plan(repository, fixed.minimumPlan);
    const manifest = verifyArchive(archive, fixed);
    const tooling = verifyFrozenWorkosOperatorToolchain(repository);
    root = realpathSync(mkdtempSync(join(tmpdir(), `morrow-workos-frozen-${fixed.sequence}-`)));
    for (const file of manifest.files) {
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes(archive, file.path), { flag: "wx", mode: 0o600 });
    }
    mkdirSync(join(root, "node_modules/@morrow"), { recursive: true });
    for (const name of ["contracts", "identity"])
      symlinkSync(join(root, "packages", name), join(root, "node_modules/@morrow", name), "dir");
    const input = await import(pathToFileURL(join(root, "scripts/workos-operator-input.mjs")));
    const verify = (afterRun = false) => {
      verifyArchive(archive, fixed);
      for (const file of manifest.files) {
        if (afterRun && file.path === fixed.reportRelative) continue;
        if (sha(bytes(root, file.path)) !== file.sha256) fail("COPY_INVALID");
      }
      verifyWorkspace(root, fixed);
      const scope = JSON.parse(input.loadPublicWorkosOperatorScope());
      if (scope.planSequence !== fixed.sequence || scope.sourceDigest !== fixed.frozen.sourceDigest)
        fail("COPY_INVALID");
      return scope;
    };
    verify();
    return Object.freeze({
      root,
      tooling,
      current,
      verify,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    });
  } catch {
    if (root) rmSync(root, { recursive: true, force: true });
    fail("PREFLIGHT_FAILED");
  }
}
export function createFrozenWorkosOperatorFixture(options) {
  return createFixture(fixed71, options);
}
export function createFrozenWorkosOperator74Fixture(options) {
  return createFixture(fixed74, options);
}

function childEnvironment(root) {
  // No inherited loader, tsconfig, esbuild override, proxy or provider credential.
  const env = { TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: join(root, "tsconfig.base.json") };
  for (const key of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"])
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  return env;
}
function classifyChildCode(stderr, fixed) {
  if (typeof stderr !== "string" || Buffer.byteLength(stderr) > 65536) return "unrecognized";
  try {
    const archive = join(sourceRoot, fixed.archiveRelative);
    verifyArchive(archive, fixed);
    const original = JSON.parse(bytes(archive, fixed.reportRelative));
    const allowed = new Set([
      ...original.checks.map((check) => "WORKOS_OPERATOR_LAB_FAILED:" + check.name),
      "WORKOS_OPERATOR_LAB_FAILED",
      "WORKOS_OPERATOR_SOURCE_DIRECTORY_REQUIRED",
      "WORKOS_OPERATOR_MIGRATION_INVALID",
      "WORKOS_OPERATOR_LOOPBACK_FAILED",
      "WORKOS_OPERATOR_LAB_WAIT_FAILED",
      "WORKOS_OPERATOR_INPUT_INVALID",
      "WORKOS_OPERATOR_INPUT_UNAVAILABLE",
      "WORKOS_OPERATOR_JOURNAL_HELD",
      "WORKOS_OPERATOR_LISTENER_DENIED",
      "WORKOS_OPERATOR_TRANSPORT_DENIED",
      "WORKOS_OPERATOR_ACTIVATION_CHANGED",
      "WORKOS_OPERATOR_RUNTIME_UNQUALIFIED",
      "CALLBACK_DID_NOT_REDIRECT_PROMPTLY",
      "LOCAL_ENGINE_IMAGE_UNAVAILABLE",
      "LOCAL_ENGINE_ISOLATION_FAILED",
      "LOCAL_ENGINE_STARTUP_FAILED",
      ...["run", "exec", "inspect", "rm"].map((command) => "LOCAL_LAB_COMMAND_FAILED:" + command),
    ]);
    const recognized = new Set(stderr.split(/\r?\n/).filter((line) => allowed.has(line)));
    return recognized.size === 1 ? [...recognized][0] : "unrecognized";
  } catch {
    return "unrecognized";
  }
}
export function classifyFrozenWorkosOperatorChildCode(stderr) {
  return classifyChildCode(stderr, fixed71);
}
export function classifyFrozenWorkosOperator74ChildCode(stderr) {
  return classifyChildCode(stderr, fixed74);
}
function runCopiedLab(fixture, fixed) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", fixture.tooling.loader, join(fixture.root, "scripts/workos-operator-lab.mjs")],
      { cwd: fixture.root, env: childEnvironment(fixture.root), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let stderr = "";
    let outputBytes = 0;
    let errorBytes = 0;
    // Raw streams never leave this boundary. Only one exact archived/fixed
    // child code may be reported; the report remains authoritative on success.
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= 65536) output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes <= 65536) stderr += chunk.toString();
    });
    child.once("error", () => reject(failure("CHILD_FAILED", "child_execution")));
    child.once("close", (code) => {
      if (code !== 0)
        return reject(
          failure(
            "CHILD_FAILED",
            "child_execution",
            errorBytes <= 65536 ? classifyChildCode(stderr, fixed) : "unrecognized",
          ),
        );
      try {
        if (outputBytes > 65536) fail("RESULT_INVALID", "child_result");
        const result = JSON.parse(output);
        if (
          result.packet !== fixed.packet ||
          result.checks !== fixed.frozen.checks ||
          result.realProviderRequests !== 0 ||
          result.syntheticProviderRequests !== 2 ||
          (fixed.sequence === 74 && result.syntheticJwksReads !== 9) ||
          result.status !== "synthetic_local_qualified_not_provider_qualified"
        )
          fail("RESULT_INVALID", "child_result");
        resolvePromise();
      } catch {
        reject(failure("RESULT_INVALID", "child_result"));
      }
    });
  });
}
function verifyReport(root, archive, fixed) {
  const result = JSON.parse(bytes(root, fixed.reportRelative));
  const original = JSON.parse(bytes(archive, fixed.reportRelative));
  const names = original.checks.map((c) => c.name);
  if (
    result.packet !== fixed.packet ||
    result.plan_sequence !== fixed.sequence ||
    result.status !== "synthetic_local_qualified_not_provider_qualified" ||
    result.real_provider_requests !== 0 ||
    result.synthetic_provider_requests !== 2 ||
    (fixed.sequence === 74 && result.synthetic_jwks_reads !== 9) ||
    result.actual_postgresql !== true ||
    result.actual_loopback_origin !== "http://127.0.0.1:4110" ||
    result.provider_session_cleanup !== "unknown" ||
    result.checks?.length !== fixed.frozen.checks ||
    !result.checks.every((c, i) => c.passed === true && c.name === names[i]) ||
    JSON.stringify(result.sources) !== JSON.stringify(original.sources) ||
    Object.keys(result.sources).length !== fixed.frozen.sourceFiles
  )
    fail("RESULT_INVALID", "report_validation");
  if (JSON.stringify(result.engine) !== JSON.stringify(original.engine))
    fail("REPORT_ENGINE_INVALID", "report_validation");
  return result;
}
export function verifyFrozenWorkosOperatorReport(
  root,
  archive = join(sourceRoot, fixed71.archiveRelative),
) {
  return verifyReport(root, archive, fixed71);
}
export function verifyFrozenWorkosOperator74Report(
  root,
  archive = join(sourceRoot, fixed74.archiveRelative),
) {
  return verifyReport(root, archive, fixed74);
}
async function runRegression(fixed) {
  const archive = join(sourceRoot, fixed.archiveRelative);
  const fixture = await createFixture(fixed);
  let stage = "preflight";
  try {
    // Revalidate immediately before the sole fixed synthetic child entrypoint.
    fixture.verify();
    verifyFrozenWorkosOperatorToolchain();
    if (JSON.stringify(plan(sourceRoot, fixed.minimumPlan)) !== JSON.stringify(fixture.current))
      fail("PLAN_INVALID");
    stage = "child_execution";
    await runCopiedLab(fixture, fixed);
    stage = "copy_validation";
    fixture.verify(true);
    stage = "report_validation";
    const result = verifyReport(fixture.root, archive, fixed);
    const report = {
      schema_version: 1,
      packet: fixed.packet,
      status: `frozen${fixed.sequence}_synthetic_regression_passed_not_new_provider_qualification`,
      generated_at: new Date().toISOString(),
      current_plan_sequence: fixture.current.sequence,
      current_plan_digest: fixture.current.digest,
      archived_plan_sequence: fixed.sequence,
      operator_source_digest: fixed.frozen.sourceDigest,
      archive_manifest_digest: fixed.frozen.manifestDigest,
      archive_files_verified: fixed.frozen.archiveFiles,
      archive_unchanged: true,
      workspace_resolution: "copied_archived_packages_only",
      tooling: {
        node: process.version,
        lock_digest: fixed.frozen.lockDigest,
        portable_tooling_digest: fixed.frozen.toolingDigest,
        platform_package: fixture.tooling.platformPackage,
        platform_binary_digest: fixture.tooling.binaryDigest,
        platform_package_integrity: fixture.tooling.packageIntegrity,
        platform_package_url: fixture.tooling.packageUrl,
        native_binary_provenance: "official_tarball_full_SRI_verified_before_pinning",
      },
      actual_postgresql: true,
      actual_loopback_origin: result.actual_loopback_origin,
      engine: result.engine,
      real_provider_requests: 0,
      synthetic_provider_requests: 2,
      ...(fixed.sequence === 74 ? { synthetic_jwks_reads: 9 } : {}),
      checks: result.checks,
      sources: result.sources,
      regression_sources: Object.fromEntries(
        fixed.regressionSources.map((name) => [name, sha(bytes(sourceRoot, name))]),
      ),
    };
    stage = "report_publication";
    const directory = exactRoot(join(sourceRoot, fixed.evidenceDirectory));
    const temporary = join(directory, `.frozen-regression-${randomUUID()}.json`);
    try {
      writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, join(directory, fixed.reportName));
    } finally {
      rmSync(temporary, { force: true });
    }
    return report;
  } catch (error) {
    const diagnostic = failureDiagnostics.get(error);
    if (diagnostic) {
      if (diagnostic.stage === "preflight" && stage !== "preflight")
        throw failure(
          diagnostic.code.slice("WORKOS_REGRESSION_".length),
          stage,
          diagnostic.childCode,
        );
      throw error;
    }
    throw failure("FAILED", stage);
  } finally {
    try {
      fixture.dispose();
      verifyArchive(archive, fixed);
    } catch {
      fail("CLEANUP_FAILED", "cleanup");
    }
  }
}
export function runWorkosOperatorRegression() {
  return runRegression(fixed71);
}
export function runWorkosOperator74Regression() {
  return runRegression(fixed74);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail("INPUT_DENIED");
    const report = await runWorkosOperatorRegression();
    console.log(
      JSON.stringify({
        packet: report.packet,
        checks: report.checks.length,
        realProviderRequests: 0,
        syntheticProviderRequests: 2,
        archiveUnchanged: true,
        status: report.status,
      }),
    );
  } catch (error) {
    console.error(
      "WORKOS_REGRESSION_FAILED " + JSON.stringify(workosRegressionFailureDiagnostic(error)),
    );
    process.exitCode = 1;
  }
}
