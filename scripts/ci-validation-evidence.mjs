import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const evidence = (path) => "docs/evidence/" + path;
const command = (id, run, reports = []) =>
  Object.freeze({ id, run, reports: Object.freeze(reports.map(evidence)) });
// These are existing commands, not an executable command selector. GitHub runs
// them unchanged; its final job/step API remains the command-status authority.
export const ciValidationCommands = Object.freeze([
  command("install_dependencies", "npm ci --ignore-scripts --no-audit --no-fund"),
  command("baseline_ci", "npm run ci", [
    "P01.T01/verification.json",
    "P01.T02/verification.json",
    "P01.T03/verification.json",
    "P01.T04/verification.json",
    "P02.T02/verification.json",
    "P03.T02/boundaries.json",
    "P03.T04/delivery.json",
    "P04.T01a/synth.json",
    "P04.T01a/permissions.json",
    "P04.T01a/readiness.json",
    "P04.T01f/archive.json",
    "P04.T01f/cleanup.json",
  ]),
  command("baseline_smoke", "npm run smoke:scaffold", ["P03.T01/smoke.json"]),
  command("workers_identity", "npm run lab:workers", ["P04.T01b/workers.json"]),
  command("workers_agent", "npm run lab:agent-authority-workers", ["P05.T04/workers-lab.json"]),
  command("workers_linking", "npm run lab:workspace-store-linking-workers", [
    "P05.T03/workers-lab.json",
  ]),
  command("workers_pkce", "npm run lab:authentication-exchange-workers", [
    "P05.T01d/workers-lab.json",
  ]),
  command("workers_token", "npm run lab:workos-session-token-workers", [
    "P05.T01f/workers-lab.json",
  ]),
  command("workers_status", "npm run lab:workos-session-status-workers", [
    "P05.T01m/legacy-reader-workers-lab.json",
  ]),
  command("workers_evidence", "npm run lab:workos-authentication-evidence-workers", [
    "P05.T01m/legacy-composition-workers-lab.json",
  ]),
  command("workers_selection", "npm run lab:workos-workspace-selection-workers", [
    "P05.T01m/legacy-selection-workers-lab.json",
  ]),
  command("workers_admission", "npm run lab:browser-session-admission-workers", [
    "P05.T01m/workers-lab.json",
  ]),
  command("workers_workspace", "npm run lab:standalone-workspace-workers", [
    "P05.T01r/regressions/standalone-workspace-workers.json",
  ]),
  command("workers_store", "npm run lab:standalone-store-linking-workers", [
    "P05.T01r/regressions/standalone-store-linking-workers.json",
  ]),
  command("workers_login", "npm run lab:standalone-login-workers", [
    "P05.T01r/regressions/login-workers-lab.json",
  ]),
  command("workers_logout", "npm run lab:standalone-logout-workers", [
    "P05.T01r/regressions/logout-workers-lab.json",
  ]),
  command("workers_fixed_provider", "npm run lab:fixed-workos-login-workers", [
    "P05.T01r/workers-lab.json",
  ]),
  command("frozen75", "npm run lab:workos-session-status-frozen75", [
    "P05.T01h/frozen75-regression.json",
  ]),
  command("sql_engine", "pinned isolated PostgreSQL engine diagnostic"),
  command("sql_operations", "npm run lab:operations", ["P04.T03/operations-lab.json"]),
  command("sql_restore", "npm run lab:restore", ["P04.T04/restore-lab.json"]),
  command("sql_identity", "npm run lab:identity", ["P05.T01/identity-lab.json"]),
  command("sql_permissions", "npm run lab:permissions", ["P05.T02/database-lab.json"]),
  command("sql_challenge", "npm run lab:authentication", [
    "P05.T01k/authentication-challenge-lab.json",
  ]),
  command("sql_revocation", "npm run lab:workspace-revocation", [
    "P05.T01/workspace-revocation-lab.json",
  ]),
  command("sql_linking", "npm run lab:workspace-store-linking", [
    "P05.T03/workspace-store-linking-lab.json",
  ]),
  command("sql_pkce", "npm run lab:authentication-exchange", ["P05.T01d/postgresql-lab.json"]),
  command("sql_selection", "npm run lab:provider-subject-resolution", [
    "P05.T01m/legacy-provider-subject-resolution-lab.json",
  ]),
  command("sql_admission", "npm run lab:browser-session-admission", [
    "P05.T01m/postgresql-lab.json",
  ]),
  command("frozen71", "npm run lab:workos-operator", ["P05.T01e/frozen-regression.json"]),
  command("frozen74", "npm run lab:workos-operator-frozen74", [
    "P05.T01g/frozen74-regression.json",
  ]),
  command("frozen80", "npm run lab:workos-authentication-operator", [
    "P05.T01o/frozen80-regression.json",
  ]),
  command("frozen82", "npm run lab:workos-authentication-operator-current", [
    "P05.T01o/frozen82-regression.json",
  ]),
  command("http_workspace", "npm run lab:standalone-workspace-http", [
    "P05.T01r/regressions/standalone-workspace-http.json",
  ]),
  command("sql_link_read", "npm run lab:workspace-linking-read", [
    "P05.T01r/regressions/workspace-linking-read.json",
  ]),
  command("http_linking", "npm run lab:standalone-store-linking-http", [
    "P05.T01r/regressions/standalone-store-linking-http.json",
  ]),
  command("sql_custody", "npm run lab:login-flow-custody", [
    "P05.T01r/regressions/login-flow-custody.json",
  ]),
  command("https_login", "npm run lab:standalone-login-https", [
    "P05.T01r/regressions/login-https-postgresql-lab.json",
  ]),
  command("sql_logout", "npm run lab:self-logout-sql", [
    "P05.T01r/regressions/self-logout-postgresql-lab.json",
  ]),
  command("https_logout", "npm run lab:standalone-logout-https", [
    "P05.T01r/regressions/logout-https-postgresql-lab.json",
  ]),
  command("https_fixed_provider", "npm run lab:fixed-workos-login-https", [
    "P05.T01r/https-postgresql-lab.json",
  ]),
]);
export const ciValidationReportPaths = Object.freeze(
  ciValidationCommands.flatMap((c) => c.reports),
);
const auxiliaryPaths = Object.freeze([evidence("index.json"), evidence("P03.T03/example.json")]);
const mutablePaths = new Set([...ciValidationReportPaths, ...auxiliaryPaths]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const fail = () => {
  throw Error("CI_VALIDATION_EVIDENCE_INVALID");
};
const require = (condition) => {
  if (!condition) fail();
};
const pathName = (value) => {
  require(
    typeof value === "string" &&
      value.length <= 512 &&
      !isAbsolute(value) &&
      !/[\\\0\r\n]/.test(value),
  );
  require(value.split("/").every((p) => p && p !== "." && p !== ".."));
  return value;
};
const present = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
function safePath(root, name) {
  const parts = pathName(name).split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = present(current);
    if (!stat) return join(root, ...parts);
    require(stat.isDirectory() && !stat.isSymbolicLink());
  }
  return join(root, ...parts);
}
function readRegular(root, name) {
  const path = safePath(root, name),
    stat = present(path);
  if (!stat) return null;
  require(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024,
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd),
      bytes = readFileSync(fd),
      after = fstatSync(fd);
    require(
      before.dev === stat.dev &&
        before.ino === stat.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        bytes.length === after.size,
    );
    return { bytes, sha256: hash(bytes), mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}
function directories(root, name) {
  let path = root;
  for (const part of pathName(name).split("/")) {
    path = join(path, part);
    const stat = present(path);
    if (!stat) {
      mkdirSync(path, { mode: 0o700 });
      syncDirectory(dirname(path));
    }
    require(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
  }
  return path;
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function exclusive(root, name, bytes, mode = 0o600) {
  const parent = dirname(name);
  if (parent !== ".") directories(root, parent);
  const fd = openSync(
    safePath(root, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(safePath(root, name)));
}
function writeState(root, value) {
  const bytes = JSON.stringify(value, null, 2) + "\n",
    path = join(root, "preparation.json");
  const prior = readRegular(root, "preparation.json");
  if (!prior) return exclusive(root, "preparation.json", bytes);
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    require(stat.dev === prior.dev && stat.ino === prior.ino);
    // Controlled CI workspace only; no hostile concurrent filesystem guarantee.
    ftruncateSync(fd, 0);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const decodeJson = (bytes) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    value = JSON.parse(text);
  require(value && typeof value === "object" && !Array.isArray(value));
  return value;
};
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function snapshot(root, expectedHead, allowMutable = false) {
  const head = git(root, ["rev-parse", "HEAD"]).toString("ascii").trim();
  require(head === expectedHead);
  const records = git(root, ["ls-tree", "-rz", "--full-tree", "HEAD"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  require(records.length > 0 && records.length <= 10000);
  const files = {},
    untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  require(untracked.every((p) => allowMutable && mutablePaths.has(p)));
  require(git(root, ["diff", "--cached", "--name-only", "-z"]).length === 0);
  let total = 0;
  for (const record of records) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(record);
    require(match);
    const path = pathName(match[3]),
      file = readRegular(root, path);
    if (allowMutable && mutablePaths.has(path)) {
      if (file) files[path] = { mode: match[1], sha256: file.sha256 };
      continue;
    }
    require(file);
    require((file.mode & 0o111) === (match[1] === "100755" ? 0o111 : 0));
    total += file.bytes.length;
    require(total <= 256 * 1024 * 1024);
    const blob = createHash("sha1")
      .update("blob " + file.bytes.length + "\0")
      .update(file.bytes)
      .digest("hex");
    require(allowMutable || blob === match[2]);
    files[path] = { mode: match[1], sha256: file.sha256 };
  }
  return { head, files, inventoryDigest: digest(Object.entries(files).sort()) };
}
const immutable = (files) =>
  Object.entries(files)
    .filter(([p]) => !mutablePaths.has(p))
    .sort();
const statuses = new Set(["success", "failure", "cancelled", "skipped"]);
const stepObservation = (steps, id) => {
  const row = steps && typeof steps === "object" ? steps[id] : null;
  return {
    outcome: statuses.has(row?.outcome) ? row.outcome : "unknown",
    conclusion: statuses.has(row?.conclusion) ? row.conclusion : "unknown",
    actualExitCode: null,
  };
};

// Trusted filesystem seam for synthetic tests. It neither executes producers
// nor grants qualification. The CLI separately requires the GitHub environment.
export function createCiValidationEvidence({
  sourceRoot,
  runnerTemp,
  expectedHead,
  runId,
  runAttempt,
  repository,
}) {
  require(
    /^[a-f0-9]{40}$/.test(expectedHead) &&
      /^[1-9][0-9]{0,19}$/.test(runId) &&
      /^[1-9][0-9]{0,5}$/.test(runAttempt),
  );
  require(repository === "sultanhunter/Morrow");
  const root = realpathSync(sourceRoot),
    temp = realpathSync(runnerTemp);
  require(
    root === resolve(sourceRoot) &&
      temp === resolve(runnerTemp) &&
      temp !== root &&
      !relative(root, temp)
        .split(sep)
        .every((p) => p !== ".."),
  );
  const runName = "morrow-validation-evidence-" + runId + "-" + runAttempt,
    runRoot = join(temp, runName);
  const metadata = {
    repository,
    runId,
    runAttempt,
    expectedHead,
    nodeVersion: process.version,
    canonicalSequence: 86,
  };
  const stateValue = () => {
    const file = readRegular(runRoot, "preparation.json");
    require(file);
    const state = decodeJson(file.bytes);
    require(
      state.schemaVersion === 1 &&
        state.runId === runId &&
        state.runAttempt === runAttempt &&
        state.expectedHead === expectedHead,
    );
    return state;
  };
  const prepare = () => {
    require(process.version === "v24.13.0" && !present(runRoot));
    mkdirSync(runRoot, { mode: 0o700 });
    syncDirectory(temp);
    directories(runRoot, "quarantine");
    const state = { schemaVersion: 1, ...metadata, status: "preparing", originals: {} };
    writeState(runRoot, state);
    try {
      const before = snapshot(root, expectedHead);
      const bytes = Buffer.from(JSON.stringify(before, null, 2) + "\n");
      exclusive(runRoot, "source.before.json", bytes);
      state.snapshotSha256 = hash(bytes);
      for (const [index, path] of [...ciValidationReportPaths, ...auxiliaryPaths].entries()) {
        const file = readRegular(root, path),
          quarantinePath = "quarantine/" + index + ".bin";
        state.originals[path] = file
          ? { present: true, sha256: file.sha256, mode: file.mode }
          : { present: false };
        if (file) exclusive(runRoot, quarantinePath, file.bytes);
        writeState(runRoot, state);
        if (file && !auxiliaryPaths.includes(path)) {
          const current = readRegular(root, path);
          require(
            current?.sha256 === file.sha256 && current.dev === file.dev && current.ino === file.ino,
          );
          unlinkSync(safePath(root, path));
          syncDirectory(dirname(safePath(root, path)));
        }
      }
      require(ciValidationReportPaths.every((path) => readRegular(root, path) === null));
      const after = snapshot(root, expectedHead, true);
      require(digest(immutable(before.files)) === digest(immutable(after.files)));
      state.status = "prepared";
      writeState(runRoot, state);
      return Object.freeze({ status: "prepared", reportCount: ciValidationReportPaths.length });
    } catch {
      state.status = "failed";
      writeState(runRoot, state);
      throw Error("CI_VALIDATION_EVIDENCE_PREPARE_FAILED");
    }
  };
  const collect = (steps = {}) => {
    if (!present(runRoot)) {
      mkdirSync(runRoot, { mode: 0o700 });
      syncDirectory(temp);
    }
    require(lstatSync(runRoot).isDirectory() && !lstatSync(runRoot).isSymbolicLink());
    exclusive(runRoot, "collection.started", "one collection only\n");
    const artifact = directories(runRoot, "artifact"),
      issues = [],
      reports = [],
      captured = new Map();
    let state,
      before,
      after,
      restored = false,
      sourceStable = false;
    try {
      state = stateValue();
      const file = readRegular(runRoot, "source.before.json");
      require(file && file.sha256 === state.snapshotSha256);
      before = decodeJson(file.bytes);
      require(state.status === "prepared" && before.head === expectedHead);
      after = snapshot(root, expectedHead, true);
      sourceStable = digest(immutable(before.files)) === digest(immutable(after.files));
      require(sourceStable);
      exclusive(artifact, "source.before.json", file.bytes);
      exclusive(artifact, "source.after-tests.json", JSON.stringify(after, null, 2) + "\n");
      for (const owner of ciValidationCommands) {
        const observed = stepObservation(steps, owner.id);
        if (observed.outcome !== "success" || observed.conclusion !== "success")
          issues.push("producer_not_success:" + owner.id);
        for (const path of owner.reports) {
          const entry = {
            path,
            producerStep: owner.id,
            producer: observed,
            status: "missing_pending",
            sha256: null,
          };
          try {
            const file = readRegular(root, path);
            if (file) {
              decodeJson(file.bytes);
              exclusive(artifact, "reports/" + path, file.bytes);
              captured.set(path, file);
              entry.sha256 = file.sha256;
              entry.status =
                observed.outcome === "success" && observed.conclusion === "success"
                  ? "fresh_pending_external_validation"
                  : "fresh_partial_pending";
            } else issues.push("report_missing:" + path);
          } catch {
            entry.status = "invalid_pending";
            issues.push("report_invalid:" + path);
          }
          reports.push(entry);
        }
      }
    } catch {
      issues.push(
        state?.status === "failed"
          ? "preparation_failed"
          : state?.status !== "prepared"
            ? "preparation_missing_or_invalid"
            : "source_changed_or_invalid",
      );
    }
    // Restore only the designated outputs, with byte/identity checks. Keep any
    // changed source or unsafe filesystem entry for inspection; never follow it.
    if (state?.originals && typeof state.originals === "object") {
      restored =
        state.status === "prepared" && Object.keys(state.originals).length === mutablePaths.size;
      for (const [index, path] of [...ciValidationReportPaths, ...auxiliaryPaths].entries()) {
        try {
          const original = state.originals[path];
          if (!original) continue;
          const current = readRegular(root, path);
          if (original.present) {
            const saved = readRegular(runRoot, "quarantine/" + index + ".bin");
            require(saved?.sha256 === original.sha256 && Number.isInteger(original.mode));
            if (current?.sha256 === original.sha256) continue;
            if (current) {
              const prior = captured.get(path);
              require(
                auxiliaryPaths.includes(path) ||
                  (prior?.sha256 === current.sha256 &&
                    prior.dev === current.dev &&
                    prior.ino === current.ino),
              );
              unlinkSync(safePath(root, path));
            }
            exclusive(root, path, saved.bytes, original.mode);
          } else if (current) {
            const prior = captured.get(path);
            require(
              auxiliaryPaths.includes(path) ||
                (prior?.sha256 === current.sha256 &&
                  prior.dev === current.dev &&
                  prior.ino === current.ino),
            );
            unlinkSync(safePath(root, path));
          }
        } catch {
          restored = false;
          issues.push("output_restoration_held:" + path);
        }
      }
    } else issues.push("output_restoration_unavailable");
    let restoredSnapshot = null;
    if (restored && sourceStable) {
      try {
        restoredSnapshot = snapshot(root, expectedHead);
        require(restoredSnapshot.inventoryDigest === before.inventoryDigest);
        exclusive(
          artifact,
          "source.after-restore.json",
          JSON.stringify(restoredSnapshot, null, 2) + "\n",
        );
      } catch {
        restored = false;
        restoredSnapshot = null;
        issues.push("source_restoration_unverified");
      }
    }
    const manifest = {
      schemaVersion: 1,
      kind: "morrow_ci_pending_validation_evidence",
      ...metadata,
      testedHead: after?.head ?? before?.head ?? null,
      collectionStatus: issues.length
        ? "incomplete_pending"
        : "complete_pending_external_validation",
      qualificationStatus: "pending",
      requiresFinalGitHubJobAndStepApi: true,
      sourceStable,
      designatedOutputsRestored: restored,
      sourceInventoryDigest: before?.inventoryDigest ?? null,
      snapshotBeforeSha256: sourceStable ? state.snapshotSha256 : null,
      snapshotAfterTestsSha256: sourceStable ? hash(JSON.stringify(after, null, 2) + "\n") : null,
      snapshotAfterRestoreSha256: restoredSnapshot
        ? hash(JSON.stringify(restoredSnapshot, null, 2) + "\n")
        : null,
      commands: ciValidationCommands.map((c) => ({
        stepId: c.id,
        command: c.run,
        ...stepObservation(steps, c.id),
      })),
      reports,
      auxiliaryOutputs: auxiliaryPaths.map((path) => ({
        path,
        originalSha256: state?.originals?.[path]?.sha256 ?? null,
        afterTestsSha256: after?.files?.[path]?.sha256 ?? null,
      })),
      issues,
      limitations: [
        "No qualification or numeric process exit is inferred by this collector; verify the final GitHub run/job/step API.",
        "Fresh report bytes do not replace their domain checks, current source bindings, physical cleanup or independent review.",
        "Controlled CI filesystem only, not hostile concurrent filesystem isolation. No provider credentials or account actions.",
      ],
    };
    exclusive(artifact, "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    return Object.freeze({ manifest, artifact, complete: issues.length === 0 });
  };
  return Object.freeze({ prepare, collect, runRoot });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    require(process.argv.length === 3 && ["prepare", "collect"].includes(process.argv[2]));
    require(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "Linux");
    const service = createCiValidationEvidence({
      sourceRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      runnerTemp: process.env.RUNNER_TEMP,
      expectedHead: process.env.CI_EXPECTED_HEAD,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      repository: process.env.GITHUB_REPOSITORY,
    });
    if (process.argv[2] === "prepare") {
      service.prepare();
      console.log("CI_VALIDATION_EVIDENCE_PREPARED:50");
    } else {
      require((process.env.CI_STEP_RESULTS ?? "{}").length <= 131072);
      const result = service.collect(JSON.parse(process.env.CI_STEP_RESULTS ?? "{}"));
      console.log("CI_VALIDATION_EVIDENCE_COLLECTED:" + result.manifest.collectionStatus);
      if (!result.complete) process.exitCode = 1;
    }
  } catch {
    console.error("CI_VALIDATION_EVIDENCE_HELD");
    process.exitCode = 1;
  }
}
