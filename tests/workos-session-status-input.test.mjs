import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claimWorkosSessionStatusRun,
  loadWorkosSessionStatusScope,
  prepareWorkosSessionStatusActivation,
} from "../scripts/workos-session-status-input.mjs";
import { runWorkosSessionStatusCommand } from "../scripts/workos-session-status-operator.mjs";

// The completed native75 operator is retired: current source must never load its
// scope, prepare a private activation, claim a run or request the provider.
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-current-status-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("retired native75 scope is denied before private input", () => {
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
