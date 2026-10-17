import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseManagedLoginKeyring } from "../packages/identity/src/managed-login-capsule.ts";
import { parseLoginConfiguration } from "../packages/identity/src/standalone-login-protocol.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";

// P04.T02a AC25: synthetic configuration only, scratch directories outside the checkout.
const script = resolve("scripts/login-keyring.mjs");
const provider = createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" });
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "morrow-keyring-")));
const artifacts = join(scratch, "artifacts");
mkdirSync(artifacts);
const config = join(scratch, "login-config.json");
writeFileSync(config, provider.configurationJson);
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, MORROW_ARTIFACTS_DIR: artifacts },
  });

test("AC25: one 0600 secrets file outside the checkout; stdout carries metadata only", async () => {
  const out = join(scratch, "keyring.secrets.json");
  const started = Date.now();
  const result = run("--config", config, "--out", out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(file), ["LOGIN_CAPSULE_KEYRING"]);
  const keyring = JSON.parse(file.LOGIN_CAPSULE_KEYRING);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(printed).sort(), [
    "configurationDigest",
    "decryptUntilMs",
    "encryptFromMs",
    "encryptUntilMs",
    "keyId",
  ]);
  const [version] = keyring.versions;
  assert.equal(keyring.versions.length, 1);
  assert.equal(result.stdout.includes(version.material), false);
  const digest = (await parseLoginConfiguration(provider.configurationJson)).configurationDigest;
  assert.equal(printed.configurationDigest, digest);
  assert.equal(keyring.currentKeyId, printed.keyId);
  assert.doesNotThrow(() => parseManagedLoginKeyring(file.LOGIN_CAPSULE_KEYRING, digest));
  assert.throws(() => parseManagedLoginKeyring(file.LOGIN_CAPSULE_KEYRING, "b".repeat(64)));
  const t0 = version.encryptFromMs + 300000;
  assert.ok(t0 >= started && t0 <= Date.now());
  assert.equal(version.encryptUntilMs, t0 + 90 * 86400000);
  assert.equal(version.decryptUntilMs, version.encryptUntilMs + 300000);
  assert.deepEqual(
    [printed.encryptFromMs, printed.encryptUntilMs, printed.decryptUntilMs],
    [version.encryptFromMs, version.encryptUntilMs, version.decryptUntilMs],
  );
});

test("AC25: refuses the checkout, the artifacts directory, existing paths and symlinked parents", () => {
  const existing = join(scratch, "existing.json");
  writeFileSync(existing, "{}");
  const linked = join(scratch, "linked");
  symlinkSync(scratch, linked);
  for (const [args, code] of [
    [["--config", config, "--out", resolve("keyring.json")], "LOGIN_KEYRING_OUT_INSIDE_CHECKOUT"],
    [
      ["--config", config, "--out", resolve(".artifacts/keyring.json")],
      "LOGIN_KEYRING_OUT_INSIDE_CHECKOUT",
    ],
    [
      ["--config", config, "--out", join(artifacts, "keyring.json")],
      "LOGIN_KEYRING_OUT_INSIDE_CHECKOUT",
    ],
    [["--config", config, "--out", existing], "LOGIN_KEYRING_OUT_EXISTS"],
    [
      ["--config", config, "--out", join(linked, "keyring.json")],
      "LOGIN_KEYRING_OUT_PARENT_SYMLINK",
    ],
    [["--config", config, "--out", "relative.json"], "LOGIN_KEYRING_OUT_NOT_ABSOLUTE"],
    [["--config", config], "LOGIN_KEYRING_OUT_REQUIRED"],
    [
      ["--config", join(scratch, "missing.json"), "--out", join(scratch, "new.json")],
      "LOGIN_KEYRING_CONFIGURATION_INVALID",
    ],
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, code);
    assert.equal(result.stdout, "", code);
    assert.equal(result.stderr.trim(), code);
  }
  assert.equal(readFileSync(existing, "utf8"), "{}");
});
