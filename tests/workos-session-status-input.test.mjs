import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  claimWorkosSessionStatusRun,
  loadWorkosSessionStatusScope,
  prepareWorkosSessionStatusActivation,
} from "../scripts/workos-session-status-input.mjs";
import { runWorkosSessionStatusCommand } from "../scripts/workos-session-status-operator.mjs";

// All twelve original75 input/claim/privacy cases remain byte-exact in the
// archive and run in the fixed checked-copy43-test regression. Current source
// must not rebind the completed operator to a newer plan.
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-current-status-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("current plan invalidates completed75 scope before private input", () => {
  assert.ok(
    JSON.parse(readFileSync(join(source, "docs/plan/source.json"))).sources.plan.sequence >= 76,
  );
  assert.throws(
    () => loadWorkosSessionStatusScope(),
    /^Error: WORKOS_SESSION_STATUS_INPUT_UNAVAILABLE$/,
  );
});
test("current preparation cannot create a fresh private activation or root", async (t) => {
  const root = join(temporary(t), "uncreated");
  assert.throws(() => prepareWorkosSessionStatusActivation(root), /INPUT_UNAVAILABLE/);
  assert.equal(existsSync(root), false);
  await assert.rejects(runWorkosSessionStatusCommand("prepare", root), /INPUT_UNAVAILABLE/);
  assert.equal(existsSync(root), false);
});
test("current observation cannot claim, inspect a credential or request a provider", async (t) => {
  const root = join(temporary(t), "uncreated");
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    requests++;
    throw Error("UNEXPECTED_NETWORK");
  };
  try {
    assert.throws(() => claimWorkosSessionStatusRun(root), /INPUT_UNAVAILABLE/);
    await assert.rejects(runWorkosSessionStatusCommand("observe", root), /INPUT_UNAVAILABLE/);
    assert.equal(requests, 0);
    assert.equal(existsSync(root), false);
  } finally {
    globalThis.fetch = original;
  }
});
