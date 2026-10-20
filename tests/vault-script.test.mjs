// M2 PR-1: the owner-run vault script (scripts/vault.mjs). Synthetic markers in throwaway
// directories only; it never touches ~/.config/morrow. The PostgreSQL apply through
// app_secret_put and the broker's read are lab:spine-foundation V1-V2.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  appSecretPutStatement,
  checkEnvelope,
  kekFingerprint,
  outsideRepository,
  parseEnvelope,
  parseVaultArguments,
  readKekFile,
  readSecret,
  sealAppSecret,
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
    checkEnvelope({ ...envelope, environment: "development" }, kek),
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
  // An empty, multi-line or oversized secret, or one with a control character (a typed
  // Backspace, a stray escape), is refused and writes nothing.
  for (const [input, out] of [
    ["\n", "empty.json"],
    ["a\nb\n", "lines.json"],
    ["x".repeat(4097), "big.json"],
    [secret.slice(0, 8) + "\x7f" + secret.slice(8) + "\n", "backspace.json"],
    [secret + "\x1b[D\n", "escape.json"],
    ["\x08" + secret + "\n", "bs.json"],
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

// M2 PR-1 review: production custody waits for its ADR (ADR-0007 item 9; ADR-0022 item 7).
test("production is refused: no production envelope is made or accepted", async (t) => {
  const dir = scratch(t);
  assert.equal(run(["kek", "--out", join(dir, "kek")]).status, 0);
  const out = run(
    [
      "seal-app-secret",
      "--environment",
      "production",
      "--app-key",
      "beta-store-1",
      "--version",
      "1",
      "--kek-file",
      join(dir, "kek"),
      "--out",
      join(dir, "p.json"),
    ],
    "shpss_" + randomBytes(16).toString("hex") + "\n",
  );
  assert.equal(out.status, 1);
  assert.equal(out.stderr.trim(), "VAULT_SCRIPT_PRODUCTION_HELD");
  assert.equal(existsSync(join(dir, "p.json")), false);
  const staging = await sealAppSecret(
    {
      environment: "staging",
      "app-key": "beta-store-1",
      version: "1",
      "kek-file": join(dir, "kek"),
    },
    "shpss_" + randomBytes(16).toString("hex"),
  );
  assert.throws(
    () => parseEnvelope(JSON.stringify({ ...staging, environment: "production" })),
    /ENVELOPE_INVALID/,
  );
});

// M2 PR-1 review: a name inside the checkout that starts with "..", and a symbolic link
// into the checkout, are inside; a sibling directory whose name starts with the
// repository's own name is outside.
test("paths: '..name' in the checkout and links into it are inside", (t) => {
  const dir = scratch(t);
  for (const path of ["..kek", "...", "..\\kek", "docs/../..kek", "./..kek"])
    assert.throws(() => outsideRepository(path), /PATH_INSIDE_REPOSITORY/, path);
  const refused = run(["kek", "--out", "..kek"]);
  try {
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr.trim(), "VAULT_SCRIPT_PATH_INSIDE_REPOSITORY");
    assert.equal(existsSync("..kek"), false);
  } finally {
    rmSync("..kek", { force: true });
  }
  // A link to a directory in the checkout, used as a parent or as the file itself.
  symlinkSync(resolve("docs"), join(dir, "into-docs"));
  assert.throws(() => outsideRepository(join(dir, "into-docs", "kek")), /PATH_INSIDE_REPOSITORY/);
  writeFileSync(join(dir, "real-kek"), randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  symlinkSync(resolve("package.json"), join(dir, "linked-file"));
  assert.throws(() => outsideRepository(join(dir, "linked-file")), /PATH_INSIDE_REPOSITORY/);
  // A link to a directory outside, and plain outside paths, are fine.
  mkdirSync(join(dir, "outside"));
  symlinkSync(join(dir, "outside"), join(dir, "to-outside"));
  assert.equal(
    outsideRepository(join(dir, "to-outside", "kek")),
    join(outsideRepository(join(dir, "outside")), "kek"),
  );
  assert.ok(outsideRepository(join(dir, "real-kek")).endsWith("real-kek"));
  // A missing parent directory is refused before any write.
  assert.throws(() => outsideRepository(join(dir, "missing", "kek")), /PATH_INVALID/);
});

// M2 PR-1 review: a terminal is read in raw mode, so Ctrl-C aborts and a Backspace is a byte.
test("the terminal prompt: Ctrl-C aborts and restores the terminal; a correction is refused", async () => {
  const terminal = (chunks) => {
    const modes = [];
    return {
      modes,
      isTTY: true,
      setRawMode: (mode) => modes.push(mode),
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield Buffer.from(chunk);
      },
    };
  };
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const aborted = terminal(["shpss_abc", "\x03"]);
    await assert.rejects(readSecret(aborted), /VAULT_SCRIPT_ABORTED/);
    assert.deepEqual(aborted.modes, [true, false]);
    const corrected = terminal(["shpss_ab", "\x7f", "c\r"]);
    const typed = await readSecret(corrected);
    assert.equal(typed, "shpss_ab\x7fc");
    assert.deepEqual(corrected.modes, [true, false]);
    await assert.rejects(
      sealAppSecret(
        { environment: "staging", "app-key": "beta-store-1", version: "1", "kek-file": "/x" },
        typed,
      ),
      /VAULT_SCRIPT_SECRET_INVALID/,
    );
    assert.equal(await readSecret(terminal(["shpss_abc\r"])), "shpss_abc");
  } finally {
    process.stderr.write = write;
  }
});
