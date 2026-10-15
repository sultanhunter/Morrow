import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWorkosAuthenticationOperatorCommand } from "../scripts/workos-authentication-operator.mjs";

test("CLI rejects malformed and unexpected arguments before private effects", async () => {
  const root = join(tmpdir(), `morrow-authentication-cli-${randomUUID()}`);
  for (const args of [
    [],
    ["unknown", root],
    ["prepare", root],
    ["start", root, "unexpected"],
    ["inspect", root, "unexpected"],
    ["start", {}],
    [{}, root],
  ]) {
    assert.deepEqual(await runWorkosAuthenticationOperatorCommand(...args), {
      state: "held",
      reason: "input_denied",
      providerSessionCleanup: "unknown",
      evidenceUse: "historical_observation_only",
    });
    assert.equal(existsSync(root), false);
  }
});

test("native start outside its qualified directory cannot allocate or claim a run", () => {
  const root = join(tmpdir(), `morrow-authentication-cli-${randomUUID()}`);
  const command = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../scripts/workos-authentication-operator.mjs", import.meta.url)),
      "start",
      root,
    ],
    { cwd: tmpdir(), encoding: "utf8", timeout: 15000 },
  );
  assert.equal(command.status, 1);
  assert.equal(command.stderr, "");
  const result = JSON.parse(command.stdout);
  assert.equal(result.state, "held");
  assert.equal(result.reason, "source_directory_required");
  assert.equal(existsSync(root), false);
});

test("command-line failures emit fixed JSON without reflecting supplied paths or values", () => {
  const secret = "synthetic-only-private-path-" + randomUUID();
  for (const args of [
    ["start", secret, "unexpected"],
    ["prepare", secret],
    ["unknown", secret],
    ["inspect", secret, "extra", "extra"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/workos-authentication-operator.mjs", ...args],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const value = JSON.parse(result.stdout);
    assert.equal(value.state, "held");
    assert.equal(value.providerSessionCleanup, "unknown");
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stdout.includes("Error"), false);
  }
});
