import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearMorrowStorage, createPending } from "../apps/workspace-web/src/pending.ts";
import { storeIntended, takeIntended } from "../apps/workspace-web/src/intended-route.ts";
import { MemoryStorage, ThrowingStorage } from "./fixtures/workspace-web.mjs";

// P14.T01a §4.5, §4.9 and the §8 storage checklist: sessionStorage holds only the
// intended path and text-free markers; sign-out clears every morrow.* key.
test("only the two morrow.* keys are ever written, and neither holds record text or keys", async () => {
  const storage = new MemoryStorage();
  storeIntended("/w/ws-1/work/task-1", storage);
  const pending = createPending({ storage });
  const command = {
    key: "11111111-2222-4333-8444-555555555555",
    body: { text: "PLANTED_ANSWER_MARKER" },
  };
  await pending.run(command, { workspaceId: "ws-1", kind: "answer" }, async () => ({
    kind: "uncertain",
  }));
  assert.deepEqual(Object.keys(storage.dump()).sort(), [
    "morrow.intended.v1",
    "morrow.unconfirmed.v1",
  ]);
  const text = JSON.stringify(storage.dump());
  for (const marker of ["PLANTED_ANSWER_MARKER", command.key, "task-1/answer"])
    assert.ok(!text.includes(marker), marker);
});
test("sign-out clears every morrow.* key and leaves other keys", () => {
  const storage = new MemoryStorage();
  storage.setItem("morrow.intended.v1", "/w/ws-1");
  storage.setItem("morrow.unconfirmed.v1", "[]");
  storage.setItem("morrow.future.v9", "x");
  storage.setItem("other-app", "keep");
  clearMorrowStorage(storage);
  assert.deepEqual(storage.dump(), { "other-app": "keep" });
  clearMorrowStorage(new ThrowingStorage());
  clearMorrowStorage(null);
});
test("blocked storage degrades to memory-only behaviour without throwing", async () => {
  const pending = createPending({ storage: new ThrowingStorage() });
  const command = { key: "11111111-2222-4333-8444-666666666666", body: {} };
  assert.equal(
    (
      await pending.run(command, { workspaceId: "ws-1", kind: "goal" }, async () => ({
        kind: "uncertain",
      }))
    ).kind,
    "uncertain",
  );
  assert.deepEqual(pending.markers(), []);
  assert.equal(takeIntended(new ThrowingStorage()), null);
});
test("UI source names no other browser storage", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
    }
  };
  walk("apps/workspace-web/src");
  walk("packages/workspace-ui/src");
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /\b(localStorage|indexedDB|document\.cookie|caches\.open)\b/, path);
    if (!/(intended-route|pending)\.ts$/.test(path))
      assert.doesNotMatch(text, /\bsessionStorage\b/, path);
  }
});
