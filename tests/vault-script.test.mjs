// M2 PR-1: the owner-run vault script (scripts/vault.mjs). Synthetic markers in throwaway
// directories only; it never touches ~/.config/morrow. The PostgreSQL apply through
// app_secret_put and the broker's read are lab:spine-foundation V1-V2.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appSecretPutStatement,
  checkEnvelope,
  kekFingerprint,
  outsideRepository,
  parseEnvelope,
  parseVaultArguments,
  readKekFile,
} from "../scripts/vault.mjs";

const run = (args, input = "") =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/vault.mjs", ...args], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? "/tmp" },
  });
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "morrow-vault-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("kek: a new 0600 file outside the repository; only a fingerprint is printed", (t) => {
  const dir = scratch(t);
  const out = run(["kek", "--out", join(dir, "kek")]);
  assert.equal(out.status, 0, out.stderr);
  const kek = readFileSync(join(dir, "kek"), "utf8").trim();
  assert.match(kek, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(dir, "kek")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(out.stdout), { written: "kek", fingerprint: kekFingerprint(kek) });
  assert.ok(!out.stdout.includes(kek) && !out.stderr.includes(kek));
  // Never overwrites, never writes inside the checkout.
  const again = run(["kek", "--out", join(dir, "kek")]);
  assert.equal(again.status, 1);
  assert.equal(readFileSync(join(dir, "kek"), "utf8").trim(), kek);
  const inside = run(["kek", "--out", "docs/vault-kek"]);
  assert.equal(inside.status, 1);
  assert.equal(inside.stderr.trim(), "VAULT_SCRIPT_PATH_INSIDE_REPOSITORY");
  assert.throws(() => outsideRepository("."), /PATH_INSIDE_REPOSITORY/);
});

test("seal-app-secret: stdin to a 0600 envelope that opens only as sealed; nothing echoed", async (t) => {
  const dir = scratch(t);
  assert.equal(run(["kek", "--out", join(dir, "kek")]).status, 0);
  const secret = "shpss_" + randomBytes(16).toString("hex");
  const args = (environment, out, version = "1") => [
    "seal-app-secret",
    "--environment",
    environment,
    "--app-key",
    "beta-store-1",
    "--version",
    version,
    "--kek-file",
    join(dir, "kek"),
    "--out",
    join(dir, out),
  ];
  const sealed = run(args("staging", "envelope.json"), secret + "\n");
  assert.equal(sealed.status, 0, sealed.stderr);
  for (const text of [sealed.stdout, sealed.stderr]) assert.ok(!text.includes(secret));
  assert.equal(statSync(join(dir, "envelope.json")).mode & 0o777, 0o600);
  const raw = readFileSync(join(dir, "envelope.json"), "utf8");
  assert.ok(!raw.includes(secret));
  const envelope = parseEnvelope(raw);
  assert.deepEqual(
    [envelope.environment, envelope.appKey, envelope.version, envelope.kekVersion],
    ["staging", "beta-store-1", 1, 1],
  );
  const kek = readKekFile(join(dir, "kek"));
  assert.equal(await checkEnvelope(envelope, kek), true);
  const check = run([
    "check-envelope",
    "--kek-file",
    join(dir, "kek"),
    "--envelope",
    join(dir, "envelope.json"),
  ]);
  assert.equal(check.stdout.trim(), "envelope opens");
  // Bound to its environment, version and KEK.
  await assert.rejects(
    checkEnvelope({ ...envelope, environment: "production" }, kek),
    /VAULT_OPEN_FAILED/,
  );
  await assert.rejects(checkEnvelope({ ...envelope, version: 2 }, kek), /VAULT_OPEN_FAILED/);
  await assert.rejects(
    checkEnvelope(envelope, randomBytes(32).toString("hex")),
    /VAULT_OPEN_FAILED/,
  );
  // The runner's statement: fixed text, bind values only, and the version it must store.
  assert.deepEqual(appSecretPutStatement(envelope), {
    text: "SELECT outcome,version FROM morrow_vault.app_secret_put($1,$2,$3,$4)",
    values: ["beta-store-1", "1", envelope.wrappedKeyHex, envelope.sealedValueHex],
    expectedVersion: "1",
  });
  // An empty, multi-line or oversized secret is refused and writes nothing.
  for (const [input, out] of [
    ["\n", "empty.json"],
    ["a\nb\n", "lines.json"],
    ["x".repeat(4097), "big.json"],
  ]) {
    const refused = run(args("staging", out), input);
    assert.equal(refused.status, 1);
    assert.throws(() => statSync(join(dir, out)));
  }
});

test("a KEK file readable by others, or malformed, is refused before any use", (t) => {
  const dir = scratch(t);
  const path = join(dir, "kek");
  writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o640 });
  chmodSync(path, 0o640);
  assert.throws(() => readKekFile(path), /KEK_FILE_UNSAFE/);
  chmodSync(path, 0o600);
  assert.match(readKekFile(path), /^[0-9a-f]{64}$/);
  writeFileSync(path, "not-a-kek\n");
  assert.throws(() => readKekFile(path), /KEK_INVALID/);
  const out = run(
    [
      "seal-app-secret",
      "--environment",
      "staging",
      "--app-key",
      "beta-store-1",
      "--version",
      "1",
      "--kek-file",
      path,
      "--out",
      join(dir, "e.json"),
    ],
    "secret\n",
  );
  assert.equal(out.status, 1);
  assert.equal(out.stderr.trim(), "VAULT_SCRIPT_KEK_INVALID");
});

test("arguments are closed per command", () => {
  assert.deepEqual(parseVaultArguments(["kek", "--out", "/x"]), {
    command: "kek",
    options: { out: "/x" },
  });
  for (const argv of [
    [],
    ["seal"],
    ["kek"],
    ["kek", "--out"],
    ["kek", "--out", "/x", "--out", "/y"],
    ["kek", "--out", "/x", "--environment", "staging"],
    ["check-envelope", "--kek-file", "/k"],
  ])
    assert.throws(() => parseVaultArguments(argv), /VAULT_SCRIPT_USAGE/);
  for (const bad of ["{}", "[]", JSON.stringify({ schemaVersion: 1 })])
    assert.throws(() => parseEnvelope(bad), /ENVELOPE_INVALID/);
});
