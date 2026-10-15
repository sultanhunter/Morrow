import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  createFrozenWorkosSessionStatusFixture,
  frozenWorkosSessionStatus75,
  verifyFrozenWorkosSessionStatusArchive,
  verifyFrozenWorkosSessionStatusResults,
  verifyFrozenWorkosSessionStatusWorkspace,
  workosSessionStatusRegressionFailure,
} from "../scripts/workos-session-status-regression.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = join(source, "docs/history/workos-session-status-75");
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-status75-regression-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t) {
  const f = await createFrozenWorkosSessionStatusFixture();
  t.after(f.dispose);
  return f;
}
function archiveCopy(t) {
  const path = join(temporary(t), "archive");
  cpSync(archive, path, { recursive: true });
  return path;
}
function currentMetadata(t) {
  const root = temporary(t);
  for (const path of [
    ".nvmrc",
    "package-lock.json",
    "docs/plan/source.json",
    "docs/plan/build-plan.md",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(source, path), join(root, path));
  }
  return root;
}
test("75 archive binds24 published files and separately attributes the later actual report", () => {
  const m = verifyFrozenWorkosSessionStatusArchive();
  assert.equal(m.files.length, 25);
  assert.equal(m.published_files.length, 24);
  assert.equal(m.post_commit_observations.length, 1);
  assert.equal(m.commit, frozenWorkosSessionStatus75.commit);
  assert.match(m.post_commit_observations[0].provenance, /did not exist in that commit/);
  assert.equal(
    m.published_files.some((file) => file.path === m.post_commit_observations[0].path),
    false,
  );
});
test("checked75 copy preserves sourcec521 and false preparation with all43 original names", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.root, archive);
  assert.ok(f.current.sequence >= 76);
  assert.equal(f.verify().sourceDigest, frozenWorkosSessionStatus75.sourceDigest);
  assert.equal(f.expected.length, 43);
  assert.equal(new Set(f.expected.map((item) => item.name)).size, 43);
  assert.deepEqual(
    ["status.test.mjs", "transport.test.mjs", "input.test.mjs"].map(
      (suffix) => f.expected.filter((item) => item.file.endsWith(suffix)).length,
    ),
    [18, 13, 12],
  );
  const input = await import(
    pathToFileURL(join(f.root, "scripts/workos-session-status-input.mjs"))
  );
  const root = join(temporary(t), "false-proposal");
  assert.equal(input.prepareWorkosSessionStatusActivation(root).status, "prepared_unapproved");
  const activation = JSON.parse(readFileSync(join(root, "activation.json")));
  assert.equal(activation.planSequence, 75);
  for (const key of ["ownerApproved", "environmentKeyApproved", "baselineApproved"])
    assert.equal(activation[key], false);
  assert.equal(input.claimWorkosSessionStatusRun(root), null);
  assert.equal(existsSync(join(root, "claim.json")), false);
});
test("75 refuses another archive, changed provenance, paths and execution bytes", async (t) => {
  await assert.rejects(
    createFrozenWorkosSessionStatusFixture({
      archive: join(source, "docs/history/workos-operator-74"),
    }),
    /PREFLIGHT_FAILED/,
  );
  const root = archiveCopy(t);
  const path = join(root, "archive.json");
  const m = JSON.parse(readFileSync(path));
  m.published_files.push(m.post_commit_observations.pop());
  writeFileSync(path, JSON.stringify(m));
  assert.throws(() => verifyFrozenWorkosSessionStatusArchive(root), /ARCHIVE_INVALID/);
  const changed = archiveCopy(t);
  writeFileSync(join(changed, "scripts/workos-session-status-operator.mjs"), "changed");
  await assert.rejects(
    createFrozenWorkosSessionStatusFixture({ archive: changed }),
    /PREFLIGHT_FAILED/,
  );
  const link = join(temporary(t), "alias");
  symlinkSync(archive, link, "dir");
  assert.throws(() => verifyFrozenWorkosSessionStatusArchive(link), /ARCHIVE_INVALID/);
});
test("75 rejects stale current plans and unqualified toolchains before execution", async (t) => {
  const root = currentMetadata(t),
    path = join(root, "docs/plan/source.json");
  const m = JSON.parse(readFileSync(path));
  m.sources.plan.sequence = 75;
  writeFileSync(path, JSON.stringify(m));
  await assert.rejects(
    createFrozenWorkosSessionStatusFixture({ source: root, archive }),
    /PREFLIGHT_FAILED/,
  );
  copyFileSync(join(source, "docs/plan/source.json"), path);
  writeFileSync(join(root, ".nvmrc"), "unqualified\n");
  await assert.rejects(
    createFrozenWorkosSessionStatusFixture({ source: root, archive }),
    /PREFLIGHT_FAILED/,
  );
});
test("75 rejects fallback to current identity and modified copied bytes", async (t) => {
  const f = await fixture(t),
    link = join(f.root, "node_modules/@morrow/identity");
  unlinkSync(link);
  symlinkSync(join(source, "packages/identity"), link, "dir");
  assert.throws(() => verifyFrozenWorkosSessionStatusWorkspace(f.root), /WORKSPACE_INVALID/);
  unlinkSync(link);
  symlinkSync(join(f.root, "packages/identity"), link, "dir");
  writeFileSync(join(f.root, "packages/identity/src/workos-session-status.ts"), "changed");
  assert.throws(() => f.verify(), /COPY_INVALID/);
});
test("qualified loader imports the copied75 reader and parser only", async (t) => {
  const f = await fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      f.tooling.loader,
      "--input-type=module",
      "-e",
      `
    import{realpathSync}from'node:fs';import{fileURLToPath}from'node:url';
    await import('@morrow/identity/workos-session-status');
    await import('./packages/identity/src/workos-session-status-json.ts');
    process.stdout.write(JSON.stringify([realpathSync(fileURLToPath(import.meta.resolve('@morrow/identity/workos-session-status'))),realpathSync(fileURLToPath(import.meta.resolve('./packages/identity/src/workos-session-status-json.ts')))]));
  `,
    ],
    {
      cwd: f.root,
      env: {
        PATH: process.env.PATH,
        TSX_DISABLE_CACHE: "1",
        TSX_TSCONFIG_PATH: join(f.root, "tsconfig.base.json"),
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(child.status, 0);
  assert.deepEqual(
    JSON.parse(child.stdout),
    [
      "packages/identity/src/workos-session-status.ts",
      "packages/identity/src/workos-session-status-json.ts",
    ].map((path) => join(f.root, path)),
  );
});
test("43 exact test names require successful outcomes without missing, duplicate, skipped or TODO cases", async (t) => {
  const f = await fixture(t);
  const valid = () => ({
    results: f.expected.map((item) => ({
      ...item,
      passed: true,
      skipped: false,
      todo: false,
      nesting: 0,
    })),
    summaries: [
      {
        success: true,
        counts: {
          tests: 43,
          passed: 43,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
          suites: 0,
          topLevel: 43,
        },
      },
    ],
  });
  assert.equal(verifyFrozenWorkosSessionStatusResults(valid(), f.expected), true);
  for (const mutate of [
    (r) => r.results.pop(),
    (r) => {
      r.results[0] = r.results[1];
    },
    (r) => {
      r.results[0].name = "unrecognized";
    },
    (r) => {
      r.results[0].file = "current/foreign.mjs";
    },
    (r) => {
      r.results[0].passed = false;
    },
    (r) => {
      r.results[0].skipped = true;
    },
    (r) => {
      r.results[0].todo = true;
    },
    (r) => {
      r.summaries[0].success = false;
    },
    (r) => {
      r.summaries[0].counts.cancelled = 1;
    },
    (r) => {
      r.summaries[0].counts.failed = 1;
    },
    (r) => {
      r.summaries.push(r.summaries[0]);
    },
  ]) {
    const r = valid();
    mutate(r);
    assert.throws(() => verifyFrozenWorkosSessionStatusResults(r, f.expected), /RESULT_INVALID/);
  }
});
test("diagnostics ignore arbitrary errors and CLI accepts no private or runner arguments", () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
    },
  );
  assert.equal(workosSessionStatusRegressionFailure(hostile), "FAILED");
  assert.equal(traps, 0);
  const child = spawnSync(
    process.execPath,
    [join(source, "scripts/workos-session-status-regression.mjs"), "private-input-canary"],
    { cwd: source, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 1);
  assert.deepEqual(JSON.parse(child.stderr), { outcome: "held", code: "INPUT_DENIED" });
  assert.equal(child.stdout, "");
});
