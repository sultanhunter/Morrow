import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindSessionActivity,
  createSessionKeeper,
  SESSION_ROTATE_INTERVAL_MS,
  SESSION_ROTATE_WAIT_MS,
} from "../packages/workspace-ui/src/session-keeper.ts";
import {
  probeUiEntries,
  sessionKeeperGzipLimit,
  uiEntryNegativeChecks,
} from "../scripts/workspace-web-checks.mjs";

// P05.T01y-AC31: the client session keeper with fake timers, locks and fetch.
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function clock() {
  let now = 1000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
        await tick();
      }
      now = end;
      await tick();
    },
    pending: () => timers.size,
  };
}
// Web Locks semantics: FIFO; shared requests share; an exclusive one waits for all.
function fakeLocks() {
  const queue = [];
  let held = [];
  const grantable = (r) =>
    r.mode === "exclusive" ? held.length === 0 : held.every((h) => h.mode === "shared");
  const pump = () => {
    while (queue.length && grantable(queue[0])) {
      const r = queue.shift();
      held.push(r);
      r.start();
    }
  };
  const locks = {
    log: [],
    held: () => held.map((h) => h.mode),
    request(name, options, callback) {
      assert.equal(name, "morrow.session");
      locks.log.push(options.mode);
      return new Promise((resolve, reject) => {
        const r = {
          mode: options.mode,
          async start() {
            try {
              resolve(await callback({ name, mode: options.mode }));
            } catch (error) {
              reject(error);
            } finally {
              held = held.filter((h) => h !== r);
              pump();
            }
          },
        };
        queue.push(r);
        pump();
      });
    },
  };
  return locks;
}
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const rotated = (outcome = "rotated") =>
  json(200, { schemaVersion: 1, outcome, idleRemainingMs: 1800000, absoluteRemainingMs: 43000000 });
// A scripted fetch: rotate replies come from `rotate`, API replies from `api`.
function server({ rotate = () => rotated(), api = () => json(200, { ok: true }) } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push({ input, init });
    return input === "/auth/rotate" ? rotate(init, calls) : api(input, init, calls);
  };
  return { fetch, calls, rotates: () => calls.filter((c) => c.input === "/auth/rotate") };
}
function keeper(options = {}) {
  const c = options.clock ?? clock();
  const s = options.server ?? server();
  let signedOut = 0;
  const expiries = [];
  const k = createSessionKeeper({
    fetch: s.fetch,
    locks: options.locks === undefined ? fakeLocks() : options.locks,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onSignedOut: () => signedOut++,
    onExpiry: (e) => expiries.push(e),
  });
  return { k, c, s, signedOut: () => signedOut, expiries };
}

test("no rotation without user input; requests, streams and timers never count", async () => {
  const { k, c, s } = keeper();
  await c.advance(20 * 60 * 1000);
  await k.request("/api/goals");
  await k.openStream("/api/events");
  await c.advance(20 * 60 * 1000);
  assert.equal(s.rotates().length, 0);
  k.noteActivity();
  await tick();
  // The first activity after creation rotates at once.
  assert.equal(s.rotates().length, 1);
});

test("at most one rotation per 5 monotonic minutes from the last 200 rotate response", async () => {
  const { k, c, s, expiries } = keeper();
  k.noteActivity();
  await tick();
  assert.equal(s.rotates().length, 1);
  assert.deepEqual(expiries, [{ idleRemainingMs: 1800000, absoluteRemainingMs: 43000000 }]);
  await c.advance(60 * 1000);
  k.noteActivity();
  await c.advance(3 * 60 * 1000);
  k.noteActivity();
  assert.equal(s.rotates().length, 1);
  await c.advance(SESSION_ROTATE_INTERVAL_MS - 4 * 60 * 1000 - 1);
  assert.equal(s.rotates().length, 1);
  await c.advance(1);
  assert.equal(s.rotates().length, 2);
  // No input since that rotation: nothing more, however long the screen stays open.
  await c.advance(60 * 60 * 1000);
  assert.equal(s.rotates().length, 2);
});

test("the rotate request is keepalive, never aborted, and validated", async () => {
  const { k, s } = keeper();
  k.noteActivity();
  await tick();
  const [call] = s.rotates();
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.keepalive, true);
  assert.equal(call.init.signal, undefined);
  assert.equal(call.init.body, '{"schemaVersion":1}');
  assert.equal(call.init.headers["X-Morrow-Request"], "1");
  assert.equal(call.init.headers["Content-Type"], "application/json");
});

test("two tabs sharing one LockManager produce one rotated and one current", async () => {
  const locks = fakeLocks();
  const c = clock();
  let generationAt = -Infinity;
  const outcomes = [];
  const shared = server({
    rotate: () => {
      const outcome = c.now() - generationAt < 60000 ? "current" : "rotated";
      if (outcome === "rotated") generationAt = c.now();
      outcomes.push(outcome);
      return rotated(outcome);
    },
  });
  const a = keeper({ locks, clock: c, server: shared });
  const b = keeper({ locks, clock: c, server: shared });
  a.k.noteActivity();
  b.k.noteActivity();
  await tick(10);
  assert.deepEqual(outcomes, ["rotated", "current"]);
  assert.deepEqual(locks.log, ["exclusive", "exclusive"]);
});

test("request() waits for an in-flight rotation and releases its shared lock at headers", async () => {
  const locks = fakeLocks();
  const gate = deferred();
  const { k, s } = keeper({
    locks,
    server: server({ rotate: () => gate.promise }),
  });
  k.noteActivity();
  await tick();
  const pending = k.request("/api/goals");
  await tick();
  // The API request has not been sent while the rotation holds the exclusive lock.
  assert.equal(s.calls.filter((call) => call.input === "/api/goals").length, 0);
  gate.resolve(rotated());
  const response = await pending;
  assert.equal(response.status, 200);
  // Headers arrived: the shared lock is free although the body was never read.
  assert.deepEqual(locks.held(), []);
});

test("an open stream never delays a rotation and never takes the lock", async () => {
  const locks = fakeLocks();
  const never = deferred();
  const { k, s } = keeper({
    locks,
    server: server({ api: (input) => (input === "/api/events" ? never.promise : json(200, {})) }),
  });
  void k.openStream("/api/events");
  await tick();
  k.noteActivity();
  await tick();
  assert.equal(s.rotates().length, 1);
  assert.deepEqual(locks.log, ["exclusive"]);
});

test("a 401 sends one shared rotate; rotated or current → one retry; a second 401 is returned", async () => {
  for (const outcome of ["rotated", "current"]) {
    let unauthorized = 1;
    const { k, s, signedOut } = keeper({
      server: server({
        rotate: () => rotated(outcome),
        api: () =>
          unauthorized-- > 0 ? json(401, { code: "authentication_required" }) : json(200, {}),
      }),
    });
    const response = await k.request("/api/goals", { method: "POST", body: '{"x":1}' });
    assert.equal(response.status, 200);
    assert.equal(s.rotates().length, 1);
    assert.equal(s.calls.filter((c) => c.input === "/api/goals").length, 2);
    assert.equal(signedOut(), 0);
  }
  // Concurrent 401s share one rotate; a second 401 after the retry is returned as is.
  const gate = deferred();
  const { k, s, signedOut } = keeper({
    server: server({
      rotate: () => gate.promise,
      api: () => json(401, { code: "authentication_required" }),
    }),
  });
  const both = [k.request("/api/a"), k.request("/api/b")];
  await tick(10);
  gate.resolve(rotated());
  const responses = await Promise.all(both);
  assert.deepEqual(
    responses.map((r) => r.status),
    [401, 401],
  );
  assert.equal(s.rotates().length, 1);
  assert.equal(signedOut(), 0);
});

test("a 401 for a request sent after a recent 200 rotate still rotates (reuse check)", async () => {
  // Sign-in, then the first input: the server answers `current`. A thief who copied the
  // generation-1 cookie rotates 60 s after it was created. The victim's next request gets 401
  // within 60 s of the keeper's `current`: that `current` cannot explain the 401, so the
  // keeper rotates, presents the retired generation, and the rotate 401 signs out.
  let rotates = 0;
  const { k, c, s, signedOut } = keeper({
    server: server({
      rotate: () =>
        rotates++ === 0 ? rotated("current") : json(401, { code: "authentication_required" }),
      api: () => json(401, { code: "authentication_required" }),
    }),
  });
  k.noteActivity();
  await tick();
  assert.equal(s.rotates().length, 1);
  await c.advance(56 * 1000);
  const response = await k.request("/api/goals");
  assert.equal(response.status, 401);
  assert.equal(s.rotates().length, 2);
  assert.equal(s.calls.filter((call) => call.input === "/api/goals").length, 1);
  assert.equal(signedOut(), 1);
});

test("a 401 for a request sent before a 200 rotate settled reuses that rotate", async () => {
  // Without a LockManager two requests are in flight; the first 401 rotates, and the second
  // 401 arrives after that rotate settled, so it explains the 401: no second rotate.
  const late = deferred();
  const seen = new Map();
  const { k, s, signedOut } = keeper({
    locks: null,
    server: server({
      api: (input) => {
        const n = (seen.get(input) ?? 0) + 1;
        seen.set(input, n);
        if (n > 1) return json(200, {});
        return input === "/api/b" ? late.promise : json(401, { code: "authentication_required" });
      },
    }),
  });
  const a = k.request("/api/a");
  const b = k.request("/api/b");
  assert.equal((await a).status, 200);
  assert.equal(s.rotates().length, 1);
  late.resolve(json(401, { code: "authentication_required" }));
  assert.equal((await b).status, 200);
  assert.equal(s.rotates().length, 1);
  assert.equal(signedOut(), 0);
});

test("a rotate reply that never arrives releases the lock after the bounded wait", async () => {
  const locks = fakeLocks();
  const never = deferred();
  const { k, c, s, signedOut, expiries } = keeper({
    locks,
    server: server({
      rotate: () => never.promise,
      api: () => json(401, { code: "authentication_required" }),
    }),
  });
  let settled = null;
  void k.request("/api/goals").then((response) => (settled = response));
  await tick(10);
  assert.equal(s.rotates().length, 1);
  assert.deepEqual(locks.held(), ["exclusive"]);
  await c.advance(SESSION_ROTATE_WAIT_MS - 1);
  assert.equal(settled, null);
  await c.advance(1);
  // Unavailable: the original 401 is returned, the lock is free, nobody is signed out.
  assert.equal(settled?.status, 401);
  assert.deepEqual(locks.held(), []);
  assert.equal(signedOut(), 0);
  // The fetch was never aborted; a late reply changes nothing and reports no expiry.
  assert.equal(s.rotates()[0].init.signal, undefined);
  never.resolve(rotated());
  await tick();
  assert.deepEqual(expiries, []);
  // The stalled attempt counts as a failure: input retries only 60 s after it.
  await c.advance(1000);
  k.noteActivity();
  await tick();
  assert.equal(s.rotates().length, 1);
  await c.advance(59 * 1000);
  assert.equal(s.rotates().length, 2);
});

test("a non-replayable body is not retried after recovery", async () => {
  const { k, s } = keeper({
    server: server({ api: () => json(401, { code: "authentication_required" }) }),
  });
  const body = new ReadableStream({ start: (c) => c.close() });
  const response = await k.request("/api/upload", { method: "POST", body, duplex: "half" });
  assert.equal(response.status, 401);
  assert.equal(s.rotates().length, 1);
  assert.equal(s.calls.filter((c) => c.input === "/api/upload").length, 1);
});

test("a rotate 401 signs out once, including after the jar dropped the cookie", async () => {
  // The thief rotated first: the victim's request gets 401, its rotate presents the retired
  // generation, the server revokes the family and answers 401.
  const { k, s, signedOut } = keeper({
    server: server({
      rotate: () => json(401, { code: "authentication_required" }),
      api: () => json(401, { code: "authentication_required" }),
    }),
  });
  const first = await k.request("/api/goals");
  assert.equal(first.status, 401);
  await k.request("/api/tasks");
  await k.openStream("/api/events");
  k.noteActivity();
  await tick();
  assert.equal(signedOut(), 1);
  assert.equal(s.rotates().length, 1);
});

test("rotate 400, 403, 404, 405, 503 or an invalid 200: no sign-out, no retry before input and 60 s", async () => {
  for (const reply of [
    () => json(400, { schemaVersion: 1, outcome: "rotation_unavailable" }),
    () => json(403, { schemaVersion: 1, outcome: "rotation_unavailable" }),
    () => json(404, { schemaVersion: 1, outcome: "rotation_unavailable" }),
    () => json(405, { schemaVersion: 1, outcome: "rotation_unavailable" }),
    () => json(503, { schemaVersion: 1, outcome: "rotation_outcome_unknown" }),
    () =>
      json(200, {
        schemaVersion: 1,
        outcome: "rotated",
        idleRemainingMs: -1,
        absoluteRemainingMs: 0,
      }),
    () =>
      json(200, {
        schemaVersion: 1,
        outcome: "renewed",
        idleRemainingMs: 1,
        absoluteRemainingMs: 1,
      }),
    () => new Response("not json", { status: 200 }),
    () => {
      throw TypeError("network");
    },
  ]) {
    const { k, c, s, signedOut } = keeper({ server: server({ rotate: reply }) });
    k.noteActivity();
    await tick();
    assert.equal(s.rotates().length, 1);
    // No new input: nothing, even after a minute.
    await c.advance(61 * 1000);
    assert.equal(s.rotates().length, 1);
    // Input within 60 s of the failure waits for the 60 s mark.
    const { k: k2, c: c2, s: s2 } = keeper({ server: server({ rotate: reply }) });
    k2.noteActivity();
    await tick();
    await c2.advance(10 * 1000);
    k2.noteActivity();
    await tick();
    assert.equal(s2.rotates().length, 1);
    await c2.advance(50 * 1000);
    assert.equal(s2.rotates().length, 2);
    // Input after 60 s rotates.
    await c.advance(1000);
    k.noteActivity();
    await tick();
    assert.equal(s.rotates().length, 2);
    assert.equal(signedOut(), 0);
  }
});

test("without a LockManager the keeper is single flight within the tab", async () => {
  const gate = deferred();
  const { k, s } = keeper({ locks: null, server: server({ rotate: () => gate.promise }) });
  k.noteActivity();
  await tick();
  const pending = k.request("/api/goals");
  await tick();
  assert.equal(s.calls.filter((c) => c.input === "/api/goals").length, 0);
  gate.resolve(rotated());
  assert.equal((await pending).status, 200);
});

test("dispose stops timers and rotations; activity binding uses user input only", async () => {
  const { k, c, s } = keeper();
  k.noteActivity();
  await tick();
  await c.advance(60 * 1000);
  k.noteActivity();
  assert.equal(c.pending(), 1);
  k.dispose();
  assert.equal(c.pending(), 0);
  await c.advance(10 * 60 * 1000);
  k.noteActivity();
  assert.equal(s.rotates().length, 1);
  const added = [];
  const target = {
    addEventListener: (name) => added.push(name),
    removeEventListener: (name) => added.splice(added.indexOf(name), 1),
  };
  const document = { ...target, visibilityState: "visible" };
  const unbind = bindSessionActivity({ noteActivity() {} }, target, document);
  assert.deepEqual(added.sort(), ["focus", "keydown", "pointerdown", "visibilitychange"]);
  unbind();
  assert.deepEqual(added, []);
});

test("the keeper's browser bundle carries its one validator, never the validator table", async () => {
  const { entries, problems } = await probeUiEntries();
  assert.deepEqual(problems, []);
  const entry = entries.find((e) => e.entry === "@morrow/workspace-ui/session-keeper");
  assert.deepEqual(
    entry.modules.filter((id) => id.startsWith("packages/contracts/")),
    ["packages/contracts/src/generated/validators/SessionRotationResult.mjs"],
  );
  assert.ok(entry.gzip_bytes <= sessionKeeperGzipLimit, String(entry.gzip_bytes));
});
test("the UI entry probe catches a planted validator table, an oversized keeper and a missing keeper", async () => {
  const checks = await uiEntryNegativeChecks();
  assert.deepEqual(
    checks.map((c) => c.name),
    ["ui_entry_validator_table", "ui_entry_table_module", "ui_entry_too_large", "ui_entry_missing"],
  );
  for (const check of checks) assert.equal(check.passed, true, check.name);
});
