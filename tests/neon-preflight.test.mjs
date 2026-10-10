import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseNeonPreflightInput,
  loadNeonPreflightInput,
  publicNeonPreflightBinding,
} from "../scripts/neon-preflight-input.mjs";

const input = {
  environment: "staging",
  projectId: "synthetic-project",
  branchId: "br-synthetic",
  hostname: "ep-synthetic.us-east-2.aws.neon.tech",
  database: "morrow_staging",
  ownerUser: "neondb_owner",
  ownerPassword: "synthetic-secret-for-tests",
};

test("operator selectors deny destination/protocol/environment override and foreign database", () => {
  assert.equal(
    parseNeonPreflightInput({ ...input, hostname: "ep-synthetic.c-14.us-east-1.aws.neon.tech" })
      .database,
    "morrow_staging",
  );
  for (const changes of [
    { environment: "production" },
    { hostname: "localhost" },
    { hostname: "ep-synthetic.c-other.us-east-1.aws.neon.tech" },
    { hostname: "ep-synthetic.c-14.extra.us-east-1.aws.neon.tech" },
    { hostname: "ep-synthetic.us-east-2.aws.neon.tech.attacker.test" },
    { hostname: "ep-synthetic.us-east-2.aws.neon.tech:443/v2" },
    { database: "shopifyflow" },
    { ownerUser: "morrow_api; DROP ROLE" },
    { ownerPassword: "bad" },
    { branchId: "unbound" },
    { wsProxy: "attacker.test" },
    { ownerPassword: undefined },
    { projectId: 17 },
  ])
    assert.throws(
      () => parseNeonPreflightInput({ ...input, ...changes }),
      /NEON_PREFLIGHT_INPUT_DENIED/,
    );
});

test("private credential files require owned0700 directory and600 regular input, and no symlinks or outside path", () => {
  const parent = mkdtempSync(join(tmpdir(), "morrow-neon-preflight-")),
    root = join(parent, "private");
  mkdirSync(root, { mode: 0o700 });
  const file = join(root, "input.json");
  writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  try {
    assert.deepEqual(loadNeonPreflightInput(file, root), input);
    chmodSync(file, 0o644);
    assert.throws(() => loadNeonPreflightInput(file, root));
    chmodSync(file, 0o600);
    chmodSync(root, 0o755);
    assert.throws(() => loadNeonPreflightInput(file, root));
    chmodSync(root, 0o700);
    const link = join(root, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadNeonPreflightInput(link, root));
    const outside = join(parent, "outside.json");
    writeFileSync(outside, JSON.stringify(input), { mode: 0o600 });
    assert.throws(() => loadNeonPreflightInput(outside, root));
    writeFileSync(file, "{");
    assert.throws(() => loadNeonPreflightInput(file, root), /NEON_PREFLIGHT_INPUT_DENIED/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("public evidence has no credentials or owner login", () => {
  assert.deepEqual(Object.keys(publicNeonPreflightBinding(input)).sort(), [
    "branchId",
    "database",
    "environment",
    "hostname",
    "projectId",
  ]);
  assert.ok(!JSON.stringify(publicNeonPreflightBinding(input)).includes(input.ownerPassword));
});

test("default CLI is preparation only; invalid private input logs no supplied secrets", () => {
  const preparation = spawnSync(process.execPath, ["scripts/neon-staging-preflight.mjs"], {
    encoding: "utf8",
  });
  assert.equal(preparation.status, 0);
  assert.match(preparation.stdout, /Preparation only/);
  const denied = spawnSync(
    process.execPath,
    ["scripts/neon-staging-preflight.mjs", "--run", "/tmp/not-a-morrow-secret"],
    { encoding: "utf8" },
  );
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /NEON_PREFLIGHT_FAILED/);
  assert.ok(!denied.stderr.includes(input.ownerPassword));
});
