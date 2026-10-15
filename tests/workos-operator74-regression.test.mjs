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
  createFrozenWorkosOperator74Fixture,
  frozenWorkosOperator74,
  verifyFrozenWorkosOperator74Archive,
  verifyFrozenWorkosOperator74Workspace,
  verifyFrozenWorkosOperator74Report,
  classifyFrozenWorkosOperator74ChildCode,
  workosRegressionFailureDiagnostic,
} from "../scripts/workos-operator-regression.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = join(source, "docs/history/workos-operator-74");
const reportPath = "docs/evidence/P05.T01g/postgresql-loopback-lab.json";
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-frozen74-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t) {
  const f = await createFrozenWorkosOperator74Fixture();
  t.after(f.dispose);
  return f;
}
function copiedArchive(t) {
  const root = join(temporary(t), "archive");
  cpSync(archive, root, { recursive: true });
  return root;
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

test("74 archive separately binds44 published files and one later actual observation", () => {
  const a = verifyFrozenWorkosOperator74Archive();
  assert.equal(a.files.length, 45);
  assert.equal(a.published_files.length, 44);
  assert.equal(a.post_commit_observations.length, 1);
  assert.equal(a.post_commit_observations[0].path, "docs/evidence/P05.T01g/actual-workos-74.json");
  assert.match(
    a.post_commit_observations[0].provenance,
    /did not exist in the published source commit/,
  );
  assert.equal(a.commit, "5c141c1a838f566e824723d740604b853f31974c");
  assert.equal(a.operator_source_digest, frozenWorkosOperator74.sourceDigest);
  assert.equal(a.plan_sequence, 74);
});

test("checked74 copy loads original source32 and permits only false preparation", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.root, archive);
  assert.ok(f.current.sequence >= 75);
  assert.equal(f.verify().planSequence, 74);
  assert.equal(f.verify().sourceDigest, frozenWorkosOperator74.sourceDigest);
  assert.equal(verifyFrozenWorkosOperator74Workspace(f.root), true);
  const input = await import(pathToFileURL(join(f.root, "scripts/workos-operator-input.mjs")));
  const cli = await import(pathToFileURL(join(f.root, "scripts/workos-operator.mjs")));
  const root = join(temporary(t), "operator");
  assert.equal(input.prepareWorkosOperatorActivation(root).status, "prepared_unapproved");
  const activation = JSON.parse(input.readWorkosOperatorActivation(root));
  assert.equal(activation.planSequence, 74);
  assert.equal(activation.maxJwksReads, 1);
  for (const field of ["ownerApproved", "callbackRegistered", "cleanupBaseline"])
    assert.equal(activation[field], false);
  assert.deepEqual(await cli.runWorkosOperatorCommand("start", root), {
    state: "held",
    reason: "owner_activation_required",
    providerSessionCleanup: "unknown",
  });
  assert.equal(existsSync(join(root, "claim.json")), false);
});

test("74 cannot be substituted with the71 archive or a changed provenance manifest", async (t) => {
  await assert.rejects(
    createFrozenWorkosOperator74Fixture({
      archive: join(source, "docs/history/workos-operator-71"),
    }),
    /WORKOS_REGRESSION_PREFLIGHT_FAILED/,
  );
  const root = copiedArchive(t);
  const file = join(root, "archive.json");
  const a = JSON.parse(readFileSync(file));
  a.published_files.push(a.post_commit_observations.pop());
  writeFileSync(file, JSON.stringify(a));
  assert.throws(
    () => verifyFrozenWorkosOperator74Archive(root),
    /WORKOS_REGRESSION_ARCHIVE_INVALID/,
  );
});

test("74 rejects changed archived files and symlinked archive paths before execution", async (t) => {
  const root = copiedArchive(t);
  writeFileSync(join(root, "scripts/workos-operator-lab.mjs"), "changed");
  await assert.rejects(
    createFrozenWorkosOperator74Fixture({ archive: root }),
    /WORKOS_REGRESSION_PREFLIGHT_FAILED/,
  );
  const link = join(temporary(t), "archive-link");
  symlinkSync(archive, link, "dir");
  assert.throws(
    () => verifyFrozenWorkosOperator74Archive(link),
    /WORKOS_REGRESSION_ARCHIVE_INVALID/,
  );
});

test("74 preflight rejects stale current plans and changed pinned toolchain before Docker", async (t) => {
  const repository = currentMetadata(t);
  const path = join(repository, "docs/plan/source.json");
  const current = JSON.parse(readFileSync(path));
  current.sources.plan.sequence = 74;
  writeFileSync(path, JSON.stringify(current));
  await assert.rejects(
    createFrozenWorkosOperator74Fixture({ repository, archive }),
    /WORKOS_REGRESSION_PREFLIGHT_FAILED/,
  );
  copyFileSync(join(source, "docs/plan/source.json"), path);
  writeFileSync(join(repository, ".nvmrc"), "different-toolchain\n");
  await assert.rejects(
    createFrozenWorkosOperator74Fixture({ repository, archive }),
    /WORKOS_REGRESSION_PREFLIGHT_FAILED/,
  );
});

test("74 workspace resolution rejects a current-package symlink and changed verifier", async (t) => {
  const f = await fixture(t);
  const link = join(f.root, "node_modules/@morrow/identity");
  unlinkSync(link);
  symlinkSync(join(source, "packages/identity"), link, "dir");
  assert.throws(
    () => verifyFrozenWorkosOperator74Workspace(f.root),
    /WORKOS_REGRESSION_WORKSPACE_INVALID/,
  );
  unlinkSync(link);
  symlinkSync(join(f.root, "packages/identity"), link, "dir");
  writeFileSync(
    join(f.root, "packages/identity/src/workos-session-token.ts"),
    "changed current verifier",
  );
  assert.throws(() => f.verify(), /WORKOS_REGRESSION_COPY_INVALID/);
});

test("actual qualified loader resolves74 verifier and validators from the copied workspace", async (t) => {
  const f = await fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      f.tooling.loader,
      "--input-type=module",
      "-e",
      `
    import {realpathSync} from 'node:fs'; import {fileURLToPath} from 'node:url';
    const paths=['@morrow/contracts/validation','@morrow/identity/authentication-exchange-admission','@morrow/identity/workos-session-token'];
    const results=[]; for(const p of paths){await import(p);results.push(realpathSync(fileURLToPath(import.meta.resolve(p))));}
    process.stdout.write(JSON.stringify(results));
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
      "packages/contracts/src/validation.ts",
      "packages/identity/src/authentication-exchange-admission.ts",
      "packages/identity/src/workos-session-token.ts",
    ].map((p) => join(f.root, p)),
  );
});

test("74 report requires all99 named checks, original31 sources, GET9 POST2 and no real requests", async (t) => {
  const f = await fixture(t);
  const original = JSON.parse(readFileSync(join(f.root, reportPath)));
  assert.equal(verifyFrozenWorkosOperator74Report(f.root).checks.length, 99);
  const mutations = [
    (r) => {
      r.packet = "P05.T01e";
    },
    (r) => {
      r.plan_sequence = 75;
    },
    (r) => {
      r.real_provider_requests = 1;
    },
    (r) => {
      r.synthetic_provider_requests = 3;
    },
    (r) => {
      r.synthetic_jwks_reads = 10;
    },
    (r) => {
      delete r.synthetic_jwks_reads;
    },
    (r) => {
      r.checks.pop();
    },
    (r) => {
      r.checks[0].name = "forged";
    },
    (r) => {
      r.checks[0].passed = false;
    },
    (r) => {
      r.sources[Object.keys(r.sources)[0]] = "0".repeat(64);
    },
    (r) => {
      r.actual_postgresql = false;
    },
    (r) => {
      r.actual_loopback_origin = "http://foreign.invalid";
    },
  ];
  for (const mutate of mutations) {
    const r = structuredClone(original);
    mutate(r);
    writeFileSync(join(f.root, reportPath), JSON.stringify(r));
    assert.throws(
      () => verifyFrozenWorkosOperator74Report(f.root),
      /WORKOS_REGRESSION_RESULT_INVALID/,
    );
  }
  const drift = structuredClone(original);
  drift.engine.version = "unqualified-engine";
  writeFileSync(join(f.root, reportPath), JSON.stringify(drift));
  assert.throws(
    () => verifyFrozenWorkosOperator74Report(f.root),
    (error) =>
      workosRegressionFailureDiagnostic(error).code === "WORKOS_REGRESSION_REPORT_ENGINE_INVALID",
  );
});

test("only the copied synthetic report may change, never archived actual evidence", async (t) => {
  const f = await fixture(t);
  const actualPath = "docs/evidence/P05.T01g/actual-workos-74.json";
  const before = readFileSync(join(archive, actualPath));
  writeFileSync(join(f.root, reportPath), "new synthetic output");
  assert.equal(f.verify(true).sourceDigest, frozenWorkosOperator74.sourceDigest);
  writeFileSync(join(f.root, actualPath), "changed actual observation");
  assert.throws(() => f.verify(true), /WORKOS_REGRESSION_COPY_INVALID/);
  assert.deepEqual(readFileSync(join(archive, actualPath)), before);
  assert.equal(verifyFrozenWorkosOperator74Archive().files.length, 45);
});

test("74 child diagnostics expose only original check names and fixed failures", () => {
  const r = JSON.parse(readFileSync(join(archive, reportPath)));
  const known = "WORKOS_OPERATOR_LAB_FAILED:" + r.checks[0].name;
  assert.equal(classifyFrozenWorkosOperator74ChildCode(known), known);
  for (const value of [known + ":private", "secret body", "x".repeat(65537), {}, null])
    assert.equal(classifyFrozenWorkosOperator74ChildCode(value), "unrecognized");
});

test("dedicated74 CLI denies caller arguments without accepting private input or another runner", () => {
  const child = spawnSync(
    process.execPath,
    [join(source, "scripts/workos-operator74-regression.mjs"), "synthetic-private-root"],
    { cwd: source, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "WORKOS_REGRESSION_INPUT_DENIED\n");
});
