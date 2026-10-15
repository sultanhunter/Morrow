import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
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
  createFrozenWorkosAuthenticationFixture,
  frozenWorkosAuthenticationOperator80,
  verifyFrozenWorkosAuthenticationArchive,
  verifyFrozenWorkosAuthenticationWorkspace,
  verifyFrozenWorkosAuthenticationTests,
  verifyFrozenWorkosAuthenticationReport,
  workosAuthenticationRegressionFailure,
} from "../scripts/workos-authentication-operator-regression.mjs";
import {
  loadWorkosAuthenticationOperatorScope,
  claimWorkosAuthenticationOperatorRun,
  prepareWorkosAuthenticationOperatorActivation,
} from "../scripts/workos-authentication-operator-input.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = join(source, "docs/history/workos-authentication-operator-80");
const reportPath = "docs/evidence/P05.T01l/postgresql-loopback-lab.json";
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-auth80-regression-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t) {
  const f = await createFrozenWorkosAuthenticationFixture();
  t.after(f.dispose);
  return f;
}
function archiveCopy(t) {
  const root = join(temporary(t), "archive");
  cpSync(archive, root, { recursive: true });
  return root;
}
test("80 archive preserves37 runtime files, six test files, independent RSA fixture and181 baseline", () => {
  const m = verifyFrozenWorkosAuthenticationArchive();
  assert.equal(m.files.length, 45);
  for (const [role, count] of [
    ["runtime_closure", 37],
    ["operator_test", 6],
    ["test_fixture", 1],
    ["baseline_lab_report", 1],
  ])
    assert.equal(m.files.filter((x) => x.role === role).length, count);
  assert.equal(m.commit, frozenWorkosAuthenticationOperator80.commit);
  assert.equal(
    m.files.some((x) => x.path.includes("actual-staging-trial")),
    false,
  );
});
test("checked80 copy retains exact source and72 original test names without running the archive", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.root, archive);
  assert.ok(f.current.sequence >= 81);
  assert.equal(f.verify().sourceDigest, frozenWorkosAuthenticationOperator80.sourceDigest);
  assert.equal(f.expected.length, 72);
  assert.equal(new Set(f.expected.map((x) => x.name)).size, 72);
  assert.equal(verifyFrozenWorkosAuthenticationWorkspace(f.root, f.tooling.loader), true);
  assert.equal(verifyFrozenWorkosAuthenticationReport(f.root).checks.length, 181);
});
test("80 rejects modified archive provenance, executable bytes, symlink root and hardlinked inputs", async (t) => {
  for (const part of [
    "archive.json",
    "scripts/workos-authentication-operator-native.mjs",
    "tests/fixtures/workos-authentication-evidence.mjs",
  ]) {
    const root = archiveCopy(t);
    writeFileSync(join(root, part), "changed");
    assert.throws(() => verifyFrozenWorkosAuthenticationArchive(root), /ARCHIVE_INVALID/);
  }
  const link = join(temporary(t), "alias");
  symlinkSync(archive, link, "dir");
  assert.throws(() => verifyFrozenWorkosAuthenticationArchive(link), /ARCHIVE_INVALID/);
  const linked = archiveCopy(t);
  linkSync(join(linked, ".nvmrc"), join(linked, "duplicate-node-version"));
  assert.throws(() => verifyFrozenWorkosAuthenticationArchive(linked), /ARCHIVE_INVALID/);
  await assert.rejects(
    createFrozenWorkosAuthenticationFixture({
      archive: join(source, "docs/history/workos-operator-74"),
    }),
    /PREFLIGHT_FAILED/,
  );
});
test("current plan and pinned toolchain must qualify before any copied execution", async (t) => {
  const root = temporary(t);
  for (const p of [
    ".nvmrc",
    "package-lock.json",
    "docs/plan/source.json",
    "docs/plan/build-plan.md",
  ]) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    copyFileSync(join(source, p), join(root, p));
  }
  const p = join(root, "docs/plan/source.json"),
    m = JSON.parse(readFileSync(p));
  m.sources.plan.sequence = 80;
  writeFileSync(p, JSON.stringify(m));
  await assert.rejects(
    createFrozenWorkosAuthenticationFixture({ source: root, archive }),
    /PREFLIGHT_FAILED/,
  );
  copyFileSync(join(source, "docs/plan/source.json"), p);
  writeFileSync(join(root, ".nvmrc"), "unqualified\n");
  await assert.rejects(
    createFrozenWorkosAuthenticationFixture({ source: root, archive }),
    /PREFLIGHT_FAILED/,
  );
});
test("copied workspace and CLI loader cannot resolve current domain code or altered copies", async (t) => {
  const f = await fixture(t),
    link = join(f.root, "node_modules/@morrow/identity");
  unlinkSync(link);
  symlinkSync(join(source, "packages/identity"), link, "dir");
  assert.throws(
    () => verifyFrozenWorkosAuthenticationWorkspace(f.root, f.tooling.loader),
    /WORKSPACE_INVALID/,
  );
  unlinkSync(link);
  symlinkSync(join(f.root, "packages/identity"), link, "dir");
  writeFileSync(join(f.root, "packages/identity/src/workos-session-status.ts"), "changed");
  assert.throws(() => f.verify(), /COPY_INVALID/);
});
test("qualified loader imports copied composition and validators without current workspace fallback", async (t) => {
  const f = await fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      f.tooling.loader,
      "--input-type=module",
      "-e",
      `
    import {realpathSync} from 'node:fs';import{fileURLToPath}from'node:url';
    await import('@morrow/identity/workos-authentication-evidence');await import('@morrow/contracts/validation');
    process.stdout.write(JSON.stringify(['@morrow/identity/workos-authentication-evidence','@morrow/contracts/validation'].map(x=>realpathSync(fileURLToPath(import.meta.resolve(x))))));`,
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
  assert.equal(result.status, 0);
  assert.deepEqual(
    JSON.parse(result.stdout),
    [
      "packages/identity/src/workos-authentication-evidence.ts",
      "packages/contracts/src/validation.ts",
    ].map((x) => join(f.root, x)),
  );
});
test("72 exact original test names require pass outcomes with no skips, duplicate or substituted cases", async (t) => {
  const f = await fixture(t);
  const valid = () => ({
    results: f.expected.map((x) => ({
      ...x,
      passed: true,
      skipped: false,
      todo: false,
      nesting: 0,
    })),
    summaries: [
      {
        success: true,
        counts: {
          tests: 72,
          passed: 72,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
          suites: 0,
          topLevel: 72,
        },
      },
    ],
  });
  assert.equal(verifyFrozenWorkosAuthenticationTests(valid(), f.expected), true);
  for (const change of [
    (r) => r.results.pop(),
    (r) => {
      r.results[0] = r.results[1];
    },
    (r) => {
      r.results[0].file = "current/foreign.mjs";
    },
    (r) => {
      r.results[0].name = "unknown";
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
      r.summaries[0].counts.cancelled = 1;
    },
    (r) => {
      r.summaries.push(r.summaries[0]);
    },
  ]) {
    const r = valid();
    change(r);
    assert.throws(
      () => verifyFrozenWorkosAuthenticationTests(r, f.expected),
      /TEST_RESULT_INVALID/,
    );
  }
});
test("181 laboratory report rejects missing checks, weakened cleanup, engine drift and altered effect counts", async (t) => {
  const f = await fixture(t),
    p = join(f.root, reportPath),
    original = readFileSync(p, "utf8");
  for (const change of [
    (r) => r.checks.pop(),
    (r) => {
      r.checks[0] = r.checks[1];
    },
    (r) => {
      r.checks[0].passed = false;
    },
    (r) => {
      r.counts.realProviderRequests = 1;
    },
    (r) => {
      r.counts.syntheticCodePosts = 7;
    },
    (r) => {
      r.cleanup.containerFence = "unverified";
    },
    (r) => {
      r.cleanupFaults[0].hostChildClosure = "observed";
    },
    (r) => {
      r.engine.version = "changed";
    },
    (r) => {
      r.outcomes[0].outcome = "held";
    },
    (r) => {
      delete r.sourceDigests[Object.keys(r.sourceDigests)[0]];
    },
  ]) {
    const r = JSON.parse(original);
    change(r);
    writeFileSync(p, JSON.stringify(r));
    assert.throws(() => verifyFrozenWorkosAuthenticationReport(f.root), /LAB_RESULT_INVALID/);
  }
  writeFileSync(p, original);
  assert.equal(verifyFrozenWorkosAuthenticationReport(f.root).checks.length, 181);
});
test("current82 native scope and preparation deny plan83 before private effects", () => {
  assert.throws(() => loadWorkosAuthenticationOperatorScope());
  const root = join(tmpdir(), "morrow-auth82-current-plan-denied-" + Date.now());
  assert.deepEqual(
    prepareWorkosAuthenticationOperatorActivation(root, join(root, "missing-binding.json")),
    { outcome: "held", reason: "preparation_denied", credentialReads: 0, providerRequests: 0 },
  );
  assert.equal(existsSync(root), false);
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
    },
  );
  assert.equal(claimWorkosAuthenticationOperatorRun(hostile), null);
  assert.equal(traps, 0);
});
test("fixed regression entry rejects private arguments before Docker or source execution", () => {
  const secret = "synthetic_private_path_not_reflected";
  const r = spawnSync(
    process.execPath,
    ["scripts/workos-authentication-operator-regression.mjs", secret],
    { cwd: source, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.includes(secret), false);
  assert.deepEqual(JSON.parse(r.stderr), { outcome: "held", code: "INPUT_DENIED" });
});
test("failure diagnostics never reflect arbitrary error objects or invoke getters", () => {
  let traps = 0;
  const e = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  assert.equal(workosAuthenticationRegressionFailure(e), "FAILED");
  assert.equal(traps, 0);
});
