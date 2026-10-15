import assert from "node:assert/strict";
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
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  createFrozenWorkosOperatorFixture,
  frozenWorkosOperator71,
  verifyFrozenWorkosOperatorArchive,
  verifyFrozenWorkosOperatorToolchain,
  verifyFrozenWorkosOperatorWorkspace,
} from "../scripts/workos-operator-regression.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = join(source, "docs/history/workos-operator-71");
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-frozen-regression-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function copiedArchive(t) {
  const target = join(temporary(t), "archive");
  cpSync(archive, target, { recursive: true });
  return target;
}
function currentMetadata(t) {
  const target = temporary(t);
  for (const file of [
    ".nvmrc",
    "package-lock.json",
    "docs/plan/source.json",
    "docs/plan/build-plan.md",
  ]) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(source, file), join(target, file));
  }
  return target;
}
async function fixture(t) {
  const value = await createFrozenWorkosOperatorFixture();
  t.after(value.dispose);
  return value;
}

test("fixed archive anchors all42 bytes and the original source501", () => {
  const manifest = verifyFrozenWorkosOperatorArchive();
  assert.equal(manifest.files.length, 42);
  assert.equal(manifest.operator_source_digest, frozenWorkosOperator71.sourceDigest);
  assert.equal(manifest.plan_sequence, 71);
});
test("checked copy retains frozen scope while current canonical plan advances", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.root, archive);
  assert.equal(f.verify().sourceDigest, frozenWorkosOperator71.sourceDigest);
  assert.equal(f.verify().planSequence, 71);
  assert.ok(f.current.sequence >= 72);
  assert.equal(verifyFrozenWorkosOperatorWorkspace(f.root), true);
  assert.equal(existsSync(join(f.root, "activation.json")), false);
});
test("exact copied71 input can prepare only an unapproved fixture and holds native start", async (t) => {
  const f = await fixture(t);
  const input = await import(pathToFileURL(join(f.root, "scripts/workos-operator-input.mjs")));
  const cli = await import(pathToFileURL(join(f.root, "scripts/workos-operator.mjs")));
  const root = join(temporary(t), "operator");
  assert.equal(
    JSON.parse(input.loadPublicWorkosOperatorScope()).sourceDigest,
    frozenWorkosOperator71.sourceDigest,
  );
  assert.equal(input.prepareWorkosOperatorActivation(root).status, "prepared_unapproved");
  const activation = JSON.parse(input.readWorkosOperatorActivation(root));
  assert.equal(activation.ownerApproved, false);
  assert.equal(activation.callbackRegistered, false);
  assert.equal(activation.cleanupBaseline, false);
  assert.deepEqual(await cli.runWorkosOperatorCommand("start", root), {
    state: "held",
    reason: "owner_activation_required",
    providerSessionCleanup: "unknown",
  });
  assert.equal(existsSync(join(root, "claim.json")), false);
});
test("actual loader imports archived identity and validators without current workspace resolution", async (t) => {
  const f = await fixture(t);
  const output = spawnSync(
    process.execPath,
    [
      "--import",
      f.tooling.loader,
      "--input-type=module",
      "-e",
      `import {realpathSync} from 'node:fs';
       import {fileURLToPath} from 'node:url';
       import {createAuthenticationExchangeAdmission} from '@morrow/identity/authentication-exchange-admission';
       import {validateDefinition} from '@morrow/contracts/validation';
       console.log(JSON.stringify({identity:typeof createAuthenticationExchangeAdmission,
         validates:validateDefinition('core','ProofRef',{}),
         contracts:realpathSync(fileURLToPath(import.meta.resolve('@morrow/contracts/validation'))),
         admission:realpathSync(fileURLToPath(import.meta.resolve('@morrow/identity/authentication-exchange-admission')))}));`,
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
  assert.equal(output.status, 0, "copied runtime imports must succeed");
  const actual = JSON.parse(output.stdout);
  assert.equal(actual.identity, "function");
  assert.equal(actual.validates, false);
  assert.equal(actual.contracts, join(f.root, "packages/contracts/src/validation.ts"));
  assert.equal(
    actual.admission,
    join(f.root, "packages/identity/src/authentication-exchange-admission.ts"),
  );
});
test("copied archive file drift cannot be hidden by a new manifest checksum", (t) => {
  const root = copiedArchive(t);
  const file = join(root, "scripts/workos-operator-controller.mjs");
  writeFileSync(file, "throw Error('not frozen');");
  assert.throws(() => verifyFrozenWorkosOperatorArchive(root), /ARCHIVE_INVALID/);
  const manifest = JSON.parse(readFileSync(join(root, "archive.json")));
  manifest.files[0].sha256 = "0".repeat(64);
  writeFileSync(join(root, "archive.json"), JSON.stringify(manifest));
  assert.throws(() => verifyFrozenWorkosOperatorArchive(root), /ARCHIVE_INVALID/);
});
test("traversal and duplicate manifest paths fail the immutable manifest binding", (t) => {
  const root = copiedArchive(t);
  const file = join(root, "archive.json");
  const original = JSON.parse(readFileSync(file));
  for (const path of ["../outside", "/absolute", original.files[1].path]) {
    const changed = structuredClone(original);
    changed.files[0].path = path;
    writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => verifyFrozenWorkosOperatorArchive(root), /ARCHIVE_INVALID/);
  }
});
test("missing and symlinked archive entries fail without executing code", (t) => {
  const root = copiedArchive(t);
  const name = "scripts/workos-operator-lab.mjs";
  rmSync(join(root, name));
  assert.throws(() => verifyFrozenWorkosOperatorArchive(root), /ARCHIVE_INVALID/);
  symlinkSync(join(archive, name), join(root, name));
  assert.throws(() => verifyFrozenWorkosOperatorArchive(root), /ARCHIVE_INVALID/);
});
test("archive hardlinks and a symlinked archive root are rejected", (t) => {
  const root = copiedArchive(t);
  const file = join(root, ".nvmrc");
  linkSync(file, join(dirname(root), "alias"));
  assert.throws(() => verifyFrozenWorkosOperatorArchive(root), /ARCHIVE_INVALID/);
  const symlink = join(dirname(root), "linked-archive");
  symlinkSync(archive, symlink, "dir");
  assert.throws(() => verifyFrozenWorkosOperatorArchive(symlink), /ARCHIVE_INVALID/);
});
test("modified frozen plan or copied code is rejected on the final preflight", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "docs/plan/source.json");
  const original = readFileSync(file);
  const changed = JSON.parse(original);
  changed.sources.plan.sequence = 72;
  writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => f.verify(), /COPY_INVALID/);
  writeFileSync(file, original);
  writeFileSync(join(f.root, "scripts/workos-operator-lab.mjs"), "modified");
  assert.throws(() => f.verify(), /COPY_INVALID/);
});
test("current stale, foreign and digest-mismatched plan deny before tooling or Docker", async (t) => {
  const repository = currentMetadata(t);
  const file = join(repository, "docs/plan/source.json");
  const original = JSON.parse(readFileSync(file));
  for (const patch of [{ sequence: 71 }, { page_id: "foreign" }, { sha256: "0".repeat(64) }]) {
    const changed = structuredClone(original);
    Object.assign(changed.sources.plan, patch);
    writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(
      createFrozenWorkosOperatorFixture({ repository, archive }),
      /PREFLIGHT_FAILED/,
    );
  }
  assert.equal(existsSync(join(repository, "node_modules")), false);
});
test("pinned Node selection and lock drift deny before loading any tooling", (t) => {
  const repository = currentMetadata(t);
  writeFileSync(join(repository, ".nvmrc"), "24.14.0\n");
  assert.throws(() => verifyFrozenWorkosOperatorToolchain(repository), /TOOLCHAIN_INVALID/);
  copyFileSync(join(source, ".nvmrc"), join(repository, ".nvmrc"));
  writeFileSync(join(repository, "package-lock.json"), "{}\n");
  assert.throws(() => verifyFrozenWorkosOperatorToolchain(repository), /TOOLCHAIN_INVALID/);
});
test("portable installed loader bytes must match the independently pinned tooling digest", (t) => {
  const repository = currentMetadata(t);
  for (const name of [
    "tsx",
    "get-tsconfig",
    "resolve-pkg-maps",
    "esbuild",
    `@esbuild/${process.platform}-${process.arch}`,
  ]) {
    cpSync(join(source, "node_modules", name), join(repository, "node_modules", name), {
      recursive: true,
    });
  }
  assert.equal(
    verifyFrozenWorkosOperatorToolchain(repository).platformPackage,
    `@esbuild/${process.platform}-${process.arch}`,
  );
  writeFileSync(join(repository, "node_modules/tsx/dist/loader.mjs"), "export {};\n");
  assert.throws(() => verifyFrozenWorkosOperatorToolchain(repository), /TOOLCHAIN_INVALID/);
  copyFileSync(
    join(source, "node_modules/tsx/dist/loader.mjs"),
    join(repository, "node_modules/tsx/dist/loader.mjs"),
  );
  writeFileSync(
    join(repository, `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`),
    "changed native tooling",
  );
  assert.throws(() => verifyFrozenWorkosOperatorToolchain(repository), /TOOLCHAIN_INVALID/);
});
test("retargeting either workspace symlink to active code denies before running the laboratory", async (t) => {
  const f = await fixture(t);
  for (const name of ["contracts", "identity"]) {
    const link = join(f.root, "node_modules/@morrow", name);
    unlinkSync(link);
    symlinkSync(join(source, "packages", name), link, "dir");
    assert.throws(() => verifyFrozenWorkosOperatorWorkspace(f.root), /WORKSPACE_INVALID/);
    unlinkSync(link);
    symlinkSync(join(f.root, "packages", name), link, "dir");
  }
});
test("copied package export drift cannot redirect a bare workspace import", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "packages/contracts/package.json");
  const changed = JSON.parse(readFileSync(file));
  changed.exports["./validation"] = "./src/different.ts";
  writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => f.verify(), /COPY_INVALID/);
});
test("synthetic output is writable only in the copy and archive evidence stays byte-identical", async (t) => {
  const f = await fixture(t);
  const name = "docs/evidence/P05.T01e/postgresql-loopback-lab.json";
  const original = readFileSync(join(archive, name));
  writeFileSync(join(f.root, name), "synthetic replacement only");
  assert.throws(() => f.verify(), /COPY_INVALID/);
  assert.equal(f.verify(true).sourceDigest, frozenWorkosOperator71.sourceDigest);
  f.dispose();
  assert.deepEqual(readFileSync(join(archive, name)), original);
  assert.equal(verifyFrozenWorkosOperatorArchive().files.length, 42);
});
test("native CLI rejects an absent private root without effects or private output", () => {
  const result = spawnSync(
    process.execPath,
    [join(source, "scripts/workos-operator.mjs"), "start", "/nonexistent-morrow-private-root"],
    {
      cwd: source,
      env: { PATH: "" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "held",
    reason: "operator_unavailable",
    providerSessionCleanup: "unknown",
  });
  assert.equal(result.stderr, "");
});
test("regression CLI rejects caller arguments instead of accepting another fixture or activation", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(source, "scripts/workos-operator-regression.mjs"),
      "start",
      "/nonexistent-morrow-private-root",
    ],
    {
      cwd: source,
      env: { PATH: "" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "WORKOS_REGRESSION_FAILED");
});
