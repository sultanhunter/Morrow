import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNeonAuthorityResume } from "../scripts/neon-authority-input.mjs";
test("resume binds the existing private credential, run and immutable migrations and rejects unsafe files", () => {
  const root = mkdtempSync(join(tmpdir(), "morrow-resume-"));
  chmodSync(root, 0o700);
  const file = join(root, "operation.json"),
    link = join(root, "link.json");
  const operator = {
    environment: "staging",
    projectId: "fixture-project",
    branchId: "br-fixture",
    hostname: "ep-fixture.us-east-1.aws.neon.tech",
    database: "morrow_staging",
    ownerUser: "fixture_owner",
    ownerPassword: "synthetic-password",
  };
  const migrations = ["one", "two", "three"];
  const input = {
    ...operator,
    runtimePassword: "a".repeat(64),
    runId: "qual_" + "b".repeat(24),
    proofs: ["c".repeat(64), "d".repeat(64)],
    migrations,
  };
  const write = (i) => writeFileSync(file, JSON.stringify(i), { mode: 0o600 });
  try {
    write(input);
    const before = readFileSync(file, "utf8");
    assert.deepEqual(loadNeonAuthorityResume(file, root, operator, migrations), input);
    assert.equal(readFileSync(file, "utf8"), before);
    for (const changes of [
      { database: "other" },
      { ownerPassword: "changed" },
      { runtimePassword: "invalid" },
      { runId: "unsafe" },
      { proofs: ["e".repeat(64)] },
      { migrations: ["changed", "two", "three"] },
      { extra: "denied" },
    ]) {
      write({ ...input, ...changes });
      assert.throws(
        () => loadNeonAuthorityResume(file, root, operator, migrations),
        /^Error: NEON_AUTHORITY_PRIVATE_OPERATION_DENIED$/,
      );
    }
    write(input);
    chmodSync(file, 0o644);
    assert.throws(() => loadNeonAuthorityResume(file, root, operator, migrations));
    chmodSync(file, 0o600);
    symlinkSync(file, link);
    assert.throws(() => loadNeonAuthorityResume(link, root, operator, migrations));
    assert.throws(() => loadNeonAuthorityResume(file, join(root, "other"), operator, migrations));
    chmodSync(root, 0o755);
    assert.throws(() => loadNeonAuthorityResume(file, root, operator, migrations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("authority runner defaults to preparation and rejects invalid private input without provider data", () => {
  const r = spawnSync(process.execPath, ["scripts/neon-authority-qualification.mjs"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Preparation only/);
  const invalid = spawnSync(
    process.execPath,
    ["scripts/neon-authority-qualification.mjs", "--install-and-test", "/tmp/not-authorized"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /NEON_AUTHORITY_FAILED_OR_EXISTING_OPERATION/);
});
test("actual workerd authority inspection failure denies before SQL installation and discloses no credentials", async () => {
  const b = await build({
    entryPoints: ["scripts/fixtures/neon-authority.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["node:crypto"],
    write: false,
  });
  let calls = 0;
  const secret = "synthetic-only-secret";
  const mf = new Miniflare({
    log: new Log(LogLevel.NONE),
    modules: true,
    script: b.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      QUALIFICATION: JSON.stringify({
        hostname: "ep-fixture.us-east-1.aws.neon.tech",
        database: "morrow_staging",
        ownerUser: "fixture_owner",
        ownerPassword: secret,
      }),
    },
    outboundService: () => {
      calls++;
      return new Response(null, { status: 502 });
    },
  });
  try {
    assert.equal(
      (await mf.dispatchFetch("http://fixture/unknown", { method: "POST" })).status,
      404,
    );
    assert.equal(calls, 0);
    const r = await mf.dispatchFetch("http://fixture/inspect", { method: "POST" });
    assert.equal(r.status, 503);
    const value = await r.text();
    assert.deepEqual(JSON.parse(value), {
      passed: false,
      code: "NEON_AUTHORITY_FAILED",
      phase: "inspect",
    });
    assert.ok(!value.includes(secret));
    assert.equal(calls, 1);
  } finally {
    await mf.dispose();
  }
});
