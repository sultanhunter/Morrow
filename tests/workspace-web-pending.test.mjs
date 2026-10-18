import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createPending, markerStorageKey, maxMarkers } from "../apps/workspace-web/src/pending.ts";
import { createLeaveGuard } from "../apps/workspace-web/src/leave-guard.ts";
import { MemoryStorage, fakeWindow } from "./fixtures/workspace-web.mjs";

// P14.T01a AC10 (unknown stays unknown), AC11 (single flight), AC12 (markers, guard).
const key = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";
const body = { objective: "SECRET_OBJECTIVE_MARKER", criteria: ["SECRET_CRITERION_MARKER"] };
const command = { key, body };
const marker = { workspaceId: "ws-1", kind: "goal" };
const scripted = (...outcomes) => {
  const calls = [];
  return {
    calls,
    send: () => {
      calls.push(Date.now());
      return Promise.resolve(outcomes[Math.min(calls.length - 1, outcomes.length - 1)]);
    },
  };
};

test("AC11: a double activation and a double Check again each send one request", async () => {
  const pending = createPending({ storage: new MemoryStorage() });
  let release;
  let sent = 0;
  const send = () => {
    sent++;
    return new Promise((resolve) => (release = resolve));
  };
  const first = pending.run(command, marker, send);
  const second = pending.run(command, marker, send);
  assert.equal(first, second);
  assert.equal(sent, 1);
  assert.equal(pending.blocking(), true);
  release({ kind: "uncertain" });
  await first;
  const checkA = pending.run(command, marker, send);
  const checkB = pending.run(command, marker, send);
  assert.equal(sent, 2);
  release({ kind: "ok", value: { goalId: "g" }, replayed: true });
  assert.deepEqual(await checkA, await checkB);
});
test("AC10: once uncertain, 503, 429 and lost replies stay uncertain with the same key; only a decoded terminal reply ends it", async () => {
  const storage = new MemoryStorage();
  const pending = createPending({ storage });
  const flow = scripted(
    { kind: "uncertain" },
    { kind: "unavailable", offline: false },
    { kind: "rate_limited", retryAfterSeconds: 600 },
    { kind: "uncertain" },
    { kind: "ok", value: { goalId: "g-1" }, replayed: true },
  );
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await pending.run(command, marker, flow.send)).kind);
  assert.deepEqual(results, ["uncertain", "uncertain", "uncertain", "uncertain", "ok"]);
  assert.equal(pending.markers().length, 0, "the terminal reply removed the marker");
  assert.equal(pending.blocking(), false);
  for (const terminal of [
    { kind: "conflict", recheck: true, message: "" },
    { kind: "denied", message: "", reference: null },
    { kind: "not_found" },
    { kind: "invalid", field: null },
  ]) {
    const other = { key: key.replace("6f", "7a"), body };
    const p = createPending({ storage: new MemoryStorage() });
    await p.run(other, marker, scripted({ kind: "uncertain" }).send);
    assert.equal(p.markers().length, 1);
    assert.equal((await p.run(other, marker, scripted(terminal).send)).kind, terminal.kind);
    assert.equal(p.markers().length, 0, terminal.kind);
  }
});
test("AC10: before anything was uncertain a 503 is 'nothing was changed'; no automatic retry within 60 s", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    const pending = createPending({ storage: new MemoryStorage() });
    const flow = scripted({ kind: "unavailable", offline: false });
    assert.equal((await pending.run(command, marker, flow.send)).kind, "unavailable");
    assert.equal(pending.markers().length, 0);
    const lost = scripted({ kind: "uncertain" });
    await pending.run({ key: key.replace("6f", "8b"), body }, marker, lost.send);
    mock.timers.tick(60000);
    await Promise.resolve();
    assert.equal(lost.calls.length, 1, "no resend without Check again");
  } finally {
    mock.timers.reset();
  }
});
test("AC12: markers are text-free, capped at 20, kept on 401, cleared by dismiss and sign-out", async () => {
  const storage = new MemoryStorage();
  const pending = createPending({ storage });
  await pending.run(command, marker, scripted({ kind: "uncertain" }).send);
  const stored = storage.getItem(markerStorageKey);
  assert.ok(!stored.includes(key) && !stored.includes("SECRET_"), "no key or text in storage");
  const [entry] = JSON.parse(stored);
  assert.deepEqual(Object.keys(entry).sort(), ["at", "kind", "workspaceId"]);
  assert.deepEqual(
    pending.liveMarkers().map((m) => m.kind),
    ["goal"],
  );
  assert.equal(
    (await pending.run(command, marker, scripted({ kind: "unauthenticated" }).send)).kind,
    "unauthenticated",
  );
  assert.equal(pending.markers().length, 1, "a 401 keeps the marker");
  pending.release(key);
  assert.equal(pending.liveMarkers().length, 0);
  assert.equal(pending.markers().length, 1, "release keeps the stored marker for re-entry");
  pending.dismiss(pending.markers()[0]);
  assert.equal(pending.markers().length, 0);
  for (let i = 0; i < maxMarkers + 5; i++) pending.addMarker("ws-1", "answer");
  assert.equal(pending.markers().length, maxMarkers);
  pending.clear();
  assert.equal(storage.getItem(markerStorageKey), null);
  storage.setItem(
    markerStorageKey,
    JSON.stringify([
      { workspaceId: "ws-1", kind: "goal", at: 1, text: "x" },
      { workspaceId: "bad id", kind: "goal", at: 1 },
      "x",
    ]),
  );
  assert.equal(pending.markers().length, 0, "unexpected entries are ignored");
});
test("AC12: beforeunload is registered only while dirty or pending; a 401 bypasses the guard", async () => {
  const win = fakeWindow("/w/ws-1");
  const pending = createPending({ storage: new MemoryStorage() });
  const guard = createLeaveGuard(win, () => pending.blocking());
  pending.subscribe(() => guard.sync());
  assert.equal(win.listenerCount("beforeunload"), 0);
  const form = {};
  guard.setDirty(form, true);
  assert.equal(win.listenerCount("beforeunload"), 1);
  assert.equal(guard.blocking(), true);
  guard.setDirty(form, false);
  assert.equal(win.listenerCount("beforeunload"), 0);
  let release;
  const flight = pending.run(command, marker, () => new Promise((resolve) => (release = resolve)));
  assert.equal(win.listenerCount("beforeunload"), 1, "a pending command registers it");
  release({ kind: "ok", value: {}, replayed: false });
  await flight;
  assert.equal(win.listenerCount("beforeunload"), 0);
  guard.setDirty(form, true);
  guard.bypass();
  assert.equal(guard.blocking(), false);
  assert.equal(win.listenerCount("beforeunload"), 0);
});
