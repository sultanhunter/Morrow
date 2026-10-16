import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkersControlledNeonLoginPools,
  createSyntheticNodeControlledNeonLoginPools,
  snapshotControlledNeonLoginPoolMetrics,
} from "../packages/identity/src/controlled-neon-login-pool.ts";
import {
  controlledNeonLoginProfiles as profiles,
  controlledNeonMetadataSql,
  controlledNeonTuple,
  snapshotControlledNeonParameters,
} from "../packages/identity/src/controlled-neon-login-profiles.ts";
import { createControlledNeonSocketClass } from "../packages/identity/src/controlled-neon-transport.ts";
import { loginFlowCustodySql } from "../packages/identity/src/login-flow-custody.ts";
const held = (error) => error instanceof Error && error.message === "CONTROLLED_NEON_LOGIN_HELD";
const syntheticPasswordMarker = ["synthetic", "password", "marker", "88"].join("_");
const b = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-controlled-lab",
  branchId: "br-controlled-lab",
  hostname: "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const dependencies = (
  borrow = () => {
    throw Error("MUST_NOT_BORROW");
  },
  now = () => Date.now(),
) => ({ bindingJson: JSON.stringify(b), credentialBroker: { borrow }, now });
const c = (deadline = Date.now() + 1000, signal = new AbortController().signal) =>
  Object.freeze({ deadlineMs: deadline, signal });
const tick = () => new Promise((r) => setTimeout(r, 0));
test("private constructors are inert, frozen and expose four fixed pools only", async () => {
  const pools = await createWorkersControlledNeonLoginPools(dependencies());
  assert.deepEqual(Object.keys(pools).sort(), [
    "loginPool",
    "preauthPool",
    "selectionPool",
    "sessionPool",
  ]);
  assert.ok(Object.isFrozen(pools));
  for (const pool of Object.values(pools)) assert.ok(Object.isFrozen(pool));
  for (const m of Object.values(snapshotControlledNeonLoginPoolMetrics(pools)))
    assert.ok(Object.values(m).every((n) => n === 0));
});
for (const key of [
  "fetch",
  "WebSocket",
  "driver",
  "role",
  "proxy",
  "observer",
  "runtime",
  "loopbackWsUrl",
])
  test("native constructor denies extra dependency " + key, async () => {
    await assert.rejects(
      createWorkersControlledNeonLoginPools({ ...dependencies(), [key]: () => {} }),
      held,
    );
  });
for (const changes of [
  { hostname: "ep-controlled-fixture-pooler.us-east-1.aws.neon.tech" },
  { hostname: "localhost" },
  { hostname: "ep-a.us-east-1.aws.neon.tech:443" },
  { database: "morrow;DROP" },
  { environment: "production" },
  { schemaVersion: 2 },
  { extra: true },
])
  test("binding refuses " + JSON.stringify(changes), async () => {
    await assert.rejects(
      createWorkersControlledNeonLoginPools({
        ...dependencies(),
        bindingJson: JSON.stringify({ ...b, ...changes }),
      }),
      held,
    );
  });
test("closed inputs refuse accessors without calling them", async () => {
  let reads = 0;
  const d = dependencies();
  Object.defineProperty(d, "now", {
    get() {
      reads++;
      throw Error("GETTER");
    },
  });
  await assert.rejects(createWorkersControlledNeonLoginPools(d), held);
  assert.equal(reads, 0);
  await assert.rejects(
    createWorkersControlledNeonLoginPools({
      ...dependencies(),
      bindingJson: JSON.stringify(b).replace(
        '"schemaVersion":1',
        '"schemaVersion":1,"schemaVersion":1',
      ),
    }),
    held,
  );
});
test("synthetic Node remapping is a separately closed loopback path", async () => {
  const pools = await createSyntheticNodeControlledNeonLoginPools({
    ...dependencies(),
    loopbackWsUrl: "ws://127.0.0.1:12345/morrow-neon-t88",
  });
  assert.ok(Object.isFrozen(pools));
  for (const url of [
    "wss://foreign.invalid/morrow-neon-t88",
    "ws://localhost:1234/morrow-neon-t88",
    "ws://127.0.0.1:1234/other",
    "ws://127.0.0.1:1234/morrow-neon-t88?x=1",
    "ws://127.0.0.1:99999/morrow-neon-t88",
  ])
    await assert.rejects(
      createSyntheticNodeControlledNeonLoginPools({ ...dependencies(), loopbackWsUrl: url }),
      held,
    );
});
for (const fault of ["expired", "aborted", "accessor", "extra"])
  test("invalid control holds before any broker or socket " + fault, async () => {
    let borrows = 0;
    const pools = await createWorkersControlledNeonLoginPools(
      dependencies(() => {
        borrows++;
      }),
    );
    const abort = new AbortController();
    abort.abort();
    let control =
      fault === "expired"
        ? c(0)
        : fault === "aborted"
          ? c(Date.now() + 1000, abort.signal)
          : fault === "extra"
            ? { ...c(), extra: true }
            : Object.defineProperty({ signal: abort.signal }, "deadlineMs", {
                get() {
                  throw Error("GETTER");
                },
                enumerable: true,
              });
    await assert.rejects(pools.loginPool.connect(control), held);
    await tick();
    assert.equal(borrows, 0);
    assert.equal(snapshotControlledNeonLoginPoolMetrics(pools).loginPool.socketAttempts, 0);
  });
for (const fault of ["namespace", "expiry", "revoked", "password", "extra"])
  test("unusable attributable credential is released once without dialing " + fault, async () => {
    let releases = 0;
    const abort = new AbortController();
    if (fault === "revoked") abort.abort();
    const pools = await createWorkersControlledNeonLoginPools(
      dependencies(async (namespace) => ({
        namespaceJson: fault === "namespace" ? namespace + " " : namespace,
        password: fault === "password" ? "bad\npassword" : syntheticPasswordMarker,
        expiresAtMs: fault === "expiry" ? 0 : Date.now() + 10000,
        revocationSignal: abort.signal,
        release: async () => {
          releases++;
        },
        ...(fault === "extra" ? { extra: true } : {}),
      })),
    );
    await assert.rejects(pools.loginPool.connect(c()), held);
    await tick();
    assert.equal(releases, 1);
    const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
    assert.equal(m.socketAttempts, 0);
    assert.equal(m.observerConnects, 0);
    assert.equal(m.activeLeases, 0);
  });
test("late borrow enters the once-only disposal sink with no late client or observer", async () => {
  let deliver,
    releases = 0;
  const abort = new AbortController();
  const pools = await createWorkersControlledNeonLoginPools(
    dependencies(
      (namespace) =>
        new Promise((r) => {
          deliver = () =>
            r({
              namespaceJson: namespace,
              password: syntheticPasswordMarker,
              expiresAtMs: Date.now() + 10000,
              revocationSignal: new AbortController().signal,
              release: async () => {
                releases++;
              },
            });
        }),
    ),
  );
  const pending = pools.loginPool.connect(c(Date.now() + 1000, abort.signal));
  await tick();
  abort.abort();
  await assert.rejects(pending, held);
  deliver();
  await tick();
  await tick();
  assert.equal(releases, 1);
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.socketAttempts, 0);
  assert.equal(m.observerConnects, 0);
  assert.equal(m.activeLeases, 0);
  assert.equal(m.cleanupLeaseReleaseAcks, 1);
  assert.equal(m.leaseReleaseLateAcks, 0);
  assert.equal(m.activeWaitTimers, 0);
  assert.equal(m.activeWaitListeners, 0);
});
test("regressing clock cannot borrow or replace the business clock", async () => {
  let at = 100,
    borrows = 0;
  const pools = await createWorkersControlledNeonLoginPools(
    dependencies(
      () => {
        borrows++;
      },
      () => at,
    ),
  );
  at = 99;
  await assert.rejects(pools.loginPool.connect(c(1000)), held);
  assert.equal(borrows, 0);
});
test("exact profile arities exclude maintenance and cross-role business SQL", () => {
  assert.deepEqual(
    Object.values(profiles).map((p) => p.role),
    [
      "morrow_identity_login",
      "morrow_identity_preauth",
      "morrow_identity_resolution",
      "morrow_identity_sessions",
    ],
  );
  for (const p of Object.values(profiles))
    for (const statement of Object.values(p.statements)) {
      const values = Array.from({ length: statement.arity }, () => "value");
      const copied = snapshotControlledNeonParameters(p, statement.text, values);
      assert.ok(Object.isFrozen(copied));
      assert.notEqual(copied, values);
      values[0] = "changed";
      if (copied.length) assert.equal(copied[0], "value");
    }
  assert.throws(
    () =>
      snapshotControlledNeonParameters(profiles.loginPool, loginFlowCustodySql.maintain, ["value"]),
    held,
  );
  assert.throws(
    () =>
      snapshotControlledNeonParameters(
        profiles.loginPool,
        profiles.sessionPool.statements.admit.text,
        Array(27).fill("value"),
      ),
    held,
  );
  assert.throws(
    () =>
      snapshotControlledNeonParameters(
        profiles.selectionPool,
        controlledNeonMetadataSql.observer,
        Array(5).fill("value"),
      ),
    held,
  );
});
test("parameters deny wrong arity, sparse/extra/accessor/mutable nonstrings and malformed text", () => {
  const p = profiles.selectionPool,
    text = p.statements.resolve.text;
  for (const values of [
    [],
    Array(9),
    Array(9).fill(1),
    Array(9).fill("\ud800"),
    Array(9).fill("a\0b"),
    Array(9).fill("x".repeat(2049)),
    Object.assign(Array(9).fill("v"), { extra: 1 }),
  ])
    assert.throws(() => snapshotControlledNeonParameters(p, text, values), held);
  let reads = 0;
  const values = Array(9).fill("v");
  Object.defineProperty(values, "2", {
    get() {
      reads++;
      return "v";
    },
  });
  assert.throws(() => snapshotControlledNeonParameters(p, text, values), held);
  assert.equal(reads, 0);
});
const expected = {
  role: "morrow_identity_login",
  database: "morrow",
  applicationName: "morrow_t88_0123456789abcdef0123456789abcdef_p",
};
const row = () => ({
  backend_pid: "1234",
  current_role: expected.role,
  session_role: expected.role,
  database_name: expected.database,
  self_pid: "1234",
  self_database: expected.database,
  self_role: expected.role,
  application_name: expected.applicationName,
  backend_start: "2026-10-16T12:34:56.123456Z",
});
test("attribution retains all PostgreSQL microseconds without Date normalization", () => {
  const tuple = controlledNeonTuple([row()], expected);
  assert.equal(tuple.start, "2026-10-16T12:34:56.123456Z");
  assert.ok(Object.isFrozen(tuple));
  assert.equal(tuple.pid, "1234");
});
for (const changes of [
  { self_pid: "1235" },
  { backend_pid: "0", self_pid: "0" },
  { self_role: "postgres" },
  { database_name: "other" },
  { application_name: "other" },
  { backend_start: "2026-10-16T12:34:56.123Z" },
  { backend_start: null },
  { backend_start: "2026-02-30T12:34:56.123456Z" },
  { backend_start: "2026-10-16T12:34:56.123456+00:00" },
])
  test("invalid self metadata cannot establish absence " + JSON.stringify(changes), () => {
    assert.throws(
      () => controlledNeonTuple([{ ...row(), ...changes, primary_present: false }], expected, true),
      held,
    );
  });
test("observer requires exactly one fully visible own row and explicit false presence", () => {
  assert.ok(controlledNeonTuple([{ ...row(), primary_present: false }], expected, true));
  for (const rows of [
    [],
    [null],
    [row()],
    [{ ...row(), primary_present: true }],
    [{ ...row(), primary_present: "false" }],
    [
      { ...row(), primary_present: false },
      { ...row(), primary_present: false },
    ],
  ])
    assert.throws(() => controlledNeonTuple(rows, expected, true), held);
});
function guardFixture(fault) {
  const events = [],
    sockets = [];
  let live = true,
    failures = 0,
    owned;
  class Native {
    listeners = new Map();
    readyState = 0;
    constructor(url) {
      events.push(["native", url]);
      if (fault === "constructor") throw Error("PRIVATE_NATIVE_ERROR");
      sockets.push(this);
    }
    set binaryType(value) {
      if (fault === "binaryType") throw Error("PRIVATE_BINARY_ERROR");
    }
    addEventListener(type, callback) {
      if (fault === "listener") throw Error("PRIVATE_LISTENER_ERROR");
      this.listeners.set(type, callback);
    }
    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
    send(data) {
      events.push(["send", data.byteLength]);
      if (fault === "send") throw Error("PRIVATE_SEND_ERROR");
    }
    close() {
      events.push(["close"]);
      if (fault === "close") throw Error("PRIVATE_CLOSE_ERROR");
      queueMicrotask(() => this.emit("close"));
    }
  }
  const Guard = createControlledNeonSocketClass({
    native: Native,
    expectedUrl: "wss://fixed.invalid/v2",
    targetUrl: "wss://fixed.invalid/v2",
    live: () => live,
    fault: () => {
      live = false;
      failures++;
    },
    own: (s) => {
      owned = s;
    },
    observe: (k) => events.push([k]),
  });
  const socket = new Guard("wss://fixed.invalid/v2");
  return {
    events,
    sockets,
    socket,
    get owned() {
      return owned;
    },
    get failures() {
      return failures;
    },
    stop: () => {
      live = false;
    },
  };
}
for (const fault of ["constructor", "binaryType", "listener"])
  test(
    "guard contains SDK synchronous setup failure without a thrown fallback path " + fault,
    async () => {
      let f;
      assert.doesNotThrow(() => {
        f = guardFixture(fault);
      });
      let errors = 0;
      f.socket.addEventListener("error", (e) => {
        assert.equal(e.message, "CONTROLLED_NEON_LOGIN_HELD");
        errors++;
      });
      await tick();
      assert.equal(errors, 1);
      assert.ok(f.failures >= 1);
      assert.equal(
        f.events.some((x) => x[0] === "send"),
        false,
      );
      if (fault === "constructor") {
        assert.equal(f.owned.acquired(), false);
        assert.equal(f.owned.isClosed(), false);
      }
    },
  );
test("guard no bytes before open; late open cannot restore a poisoned socket", async () => {
  const f = guardFixture();
  f.socket.send(new Uint8Array([1]));
  await tick();
  f.sockets[0].emit("open");
  await tick();
  assert.equal(
    f.events.some((x) => x[0] === "send"),
    false,
  );
  assert.equal(f.events.filter((x) => x[0] === "close").length, 1);
});
test("guard sends real binary only while open and observes actual close exactly once", async () => {
  const f = guardFixture();
  f.sockets[0].emit("open");
  f.socket.send(new Uint8Array([1, 2]));
  assert.equal(f.events.filter((x) => x[0] === "send").length, 1);
  f.socket.close();
  f.socket.close();
  await f.owned.closed;
  assert.equal(f.owned.isClosed(), true);
  assert.equal(f.events.filter((x) => x[0] === "close").length, 1);
  assert.equal(f.events.filter((x) => x[0] === "closeAck").length, 1);
});
test("guard revoked live authority closes instead of forwarding open/message", async () => {
  const f = guardFixture();
  let opens = 0,
    messages = 0;
  f.socket.addEventListener("open", () => opens++);
  f.socket.addEventListener("message", () => messages++);
  f.stop();
  f.sockets[0].emit("open");
  f.sockets[0].emit("message", { data: new Uint8Array([1]) });
  await tick();
  assert.equal(opens + messages, 0);
  assert.equal(
    f.events.some((x) => x[0] === "send"),
    false,
  );
});
test("guard rejects nonbinary/oversize messages without leaking native errors", async () => {
  for (const data of ["private_payload", new Uint8Array(262145)]) {
    const f = guardFixture();
    let messages = 0;
    f.socket.addEventListener("message", () => messages++);
    f.sockets[0].emit("open");
    f.sockets[0].emit("message", { data });
    await tick();
    assert.equal(messages, 0);
    assert.ok(f.failures > 0);
  }
});
test("guard failed native close is an attempt, never fabricated closure acknowledgement", async () => {
  const f = guardFixture("close");
  f.sockets[0].emit("open");
  assert.doesNotThrow(() => f.socket.close());
  await tick();
  assert.equal(f.owned.isClosed(), false);
  assert.equal(f.events.filter((x) => x[0] === "closeAck").length, 0);
  assert.equal(f.events.filter((x) => x[0] === "closeAttempt").length, 1);
});
