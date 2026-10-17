import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactPath,
  artifactsRoot,
  repositoryRoot,
  writeArtifact,
} from "../scripts/artifacts.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scanner = join(repository, "scripts/scan-artifacts.mjs");

function withArtifactsDir(value, run) {
  const saved = process.env.MORROW_ARTIFACTS_DIR;
  if (value === undefined) delete process.env.MORROW_ARTIFACTS_DIR;
  else process.env.MORROW_ARTIFACTS_DIR = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.MORROW_ARTIFACTS_DIR;
    else process.env.MORROW_ARTIFACTS_DIR = saved;
  }
}

test("default artifacts root is the repository .artifacts directory", () =>
  withArtifactsDir(undefined, () => {
    assert.equal(repositoryRoot, repository);
    assert.equal(artifactsRoot(), join(repository, ".artifacts"));
    assert.equal(
      artifactPath("verify/delivery.json"),
      join(repository, ".artifacts/verify/delivery.json"),
    );
  }));

test("MORROW_ARTIFACTS_DIR overrides the artifacts root", () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-artifacts-"));
  try {
    withArtifactsDir(directory, () => {
      assert.equal(artifactsRoot(), resolve(directory));
      assert.equal(
        artifactPath("labs/example.json"),
        join(resolve(directory), "labs/example.json"),
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact names that could leave the root or collide are rejected", () => {
  for (const name of ["../x", "/abs", "A.json", "a//b", "", "a/../b", "./a", "a/", ".hidden", 7])
    assert.throws(() => artifactPath(name), /ARTIFACT_NAME_INVALID/, String(name));
});

test("a second write replaces the first", () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-artifacts-"));
  try {
    withArtifactsDir(directory, () => {
      const path = writeArtifact("labs/repeat.json", { attempt: 1 });
      assert.equal(path, join(resolve(directory), "labs/repeat.json"));
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { attempt: 1 });
      assert.equal(writeArtifact("labs/repeat.json", "second\n"), path);
      assert.equal(readFileSync(path, "utf8"), "second\n");
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scan(directory) {
  return spawnSync(process.execPath, [scanner, directory], { encoding: "utf8" });
}

test("artifact scan fails on a secret without printing its value", () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-artifacts-"));
  try {
    const secret = "sk-proj-" + "A".repeat(50);
    mkdirSync(join(directory, "labs"));
    writeFileSync(join(directory, "labs/clean.json"), '{"passed":true}\n');
    writeFileSync(join(directory, "labs/leak.json"), JSON.stringify({ value: secret }));
    const result = scan(directory);
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
    assert.deepEqual(JSON.parse(result.stdout), {
      scanned: 2,
      findings: [{ path: "labs/leak.json", kind: "openai_key" }],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact scan reports symbolic links and passes clean or absent directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-artifacts-"));
  try {
    writeFileSync(join(directory, "clean.json"), "{}\n");
    let result = scan(directory);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { scanned: 1, findings: [] });
    symlinkSync(join(directory, "clean.json"), join(directory, "link.json"));
    result = scan(directory);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).findings, [{ path: "link.json", kind: "symlink" }]);
    result = scan(join(directory, "absent"));
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { scanned: 0, findings: [] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
