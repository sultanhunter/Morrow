import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkersControlledNeonLoginPools,
  createSyntheticNodeControlledNeonLoginPools,
  createWorkersRequestBoundNeonLoginPools,
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
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
import {
  createManagedLoginRequestOwner,
  bindManagedLoginRequestNamespace,
  assertManagedLoginRequestOwner,
  publishManagedLoginCleanup,
  snapshotManagedLoginRequestMetrics,
} from "../packages/identity/src/managed-login-request-scope.ts";
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

// CPU contexts below qualify only closed identity/registration semantics. Actual
// platform waitUntil and SDK/SQL evidence belongs to the native laboratories.
const scopeHeld = (e) => e instanceof Error && e.message === "MANAGED_LOGIN_REQUEST_SCOPE_HELD";
const configurationDigest = "a".repeat(64);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
function requestOwner(t, options = {}) {
  const calls = [],
    parent = new AbortController(),
    now = options.now ?? Date.now,
    attempt = createLoginAttempt(now, parent.signal, 25000);
  const context = {
    waitUntil(pending) {
      assert.equal(this, context);
      calls.push(pending);
      if (options.registrationThrows) throw Error("PRIVATE_CONTEXT_ERROR");
    },
  };
  const { scope, ownerToken } = createManagedLoginRequestOwner(context, attempt);
  t.after(() => attempt.end());
  if (options.bind !== false)
    bindManagedLoginRequestNamespace(scope, ownerToken, configurationDigest);
  return {
    scope,
    ownerToken,
    parent,
    attempt,
    calls,
    context,
    snapshot: () => snapshotManagedLoginRequestMetrics(scope, ownerToken),
    pools: (borrow) =>
      createWorkersRequestBoundNeonLoginPools(
        dependencies(borrow, now),
        scope,
        ownerToken,
        configurationDigest,
      ),
  };
}
test("request scope and token are opaque frozen identities, never copyable authority", (t) => {
  const a = requestOwner(t),
    b = requestOwner(t);
  assert.ok(Object.isFrozen(a.scope) && Object.isFrozen(a.ownerToken));
  assert.deepEqual(Object.keys(a.scope), []);
  for (const [scope, token] of [
    [{ ...a.scope }, a.ownerToken],
    [a.scope, { ...a.ownerToken }],
    [a.scope, b.ownerToken],
    [b.scope, a.ownerToken],
  ])
    assert.throws(
      () => assertManagedLoginRequestOwner(scope, token, configurationDigest),
      scopeHeld,
    );
  assert.ok(
    Object.isFrozen(assertManagedLoginRequestOwner(a.scope, a.ownerToken, configurationDigest)),
  );
});
test("namespace binds once and malformed/unbound/wrong namespaces cannot borrow", async (t) => {
  const a = requestOwner(t, { bind: false });
  assert.throws(
    () => assertManagedLoginRequestOwner(a.scope, a.ownerToken, configurationDigest),
    scopeHeld,
  );
  assert.throws(
    () => bindManagedLoginRequestNamespace(a.scope, a.ownerToken, configurationDigest + "\n"),
    scopeHeld,
  );
  bindManagedLoginRequestNamespace(a.scope, a.ownerToken, configurationDigest);
  assert.throws(
    () => bindManagedLoginRequestNamespace(a.scope, a.ownerToken, configurationDigest),
    scopeHeld,
  );
  await assert.rejects(
    createWorkersRequestBoundNeonLoginPools(dependencies(), a.scope, a.ownerToken, "b".repeat(64)),
    held,
  );
  assert.equal(a.snapshot().publicationAttempts, 0);
});
test("parent control snapshots are fresh and later caps cannot renew the request", (t) => {
  const start = Date.now(),
    a = requestOwner(t, { now: () => start });
  const first = assertManagedLoginRequestOwner(a.scope, a.ownerToken, configurationDigest);
  a.attempt.cap(start + 500);
  const second = assertManagedLoginRequestOwner(a.scope, a.ownerToken, configurationDigest);
  assert.notEqual(first, second);
  assert.equal(second.deadlineMs, start + 500);
  assert.equal(first.deadlineMs, start + 25000);
  a.attempt.cap(start + 2000);
  assert.equal(
    assertManagedLoginRequestOwner(a.scope, a.ownerToken, configurationDigest).deadlineMs,
    start + 500,
  );
});
test("parent end denies business work but not its already-owned exact cleanup Promise", async (t) => {
  const a = requestOwner(t),
    cleanup = deferred();
  a.attempt.end();
  assert.throws(
    () => assertManagedLoginRequestOwner(a.scope, a.ownerToken, configurationDigest),
    scopeHeld,
  );
  publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise);
  assert.equal(a.calls[0], cleanup.promise);
  assert.equal(a.snapshot().publishedPending, 1);
  cleanup.resolve();
  await cleanup.promise;
  assert.equal(a.snapshot().publishedSettled, 1);
});
test("cleanup publication captures receiver/method and registers exact same Promise once", async (t) => {
  const a = requestOwner(t),
    cleanup = deferred();
  a.context.waitUntil = () => {
    throw Error("REPLACED_CONTEXT_METHOD");
  };
  publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise);
  publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0], cleanup.promise);
  assert.equal(a.snapshot().publicationAccepted, 1);
  assert.equal(a.snapshot().duplicatePublicationAttempts, 1);
  cleanup.resolve();
  await cleanup.promise;
  assert.equal(a.snapshot().publishedPending, 0);
  assert.ok(Object.isFrozen(a.snapshot()));
});
test("a cleanup Promise cannot be transplanted to another live scope", async (t) => {
  const a = requestOwner(t),
    b = requestOwner(t),
    cleanup = deferred();
  publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise);
  assert.throws(
    () => publishManagedLoginCleanup(b.scope, b.ownerToken, cleanup.promise),
    scopeHeld,
  );
  assert.equal(b.calls.length, 0);
  cleanup.resolve();
  await cleanup.promise;
});
test("registration rejection stays fixed, once-only, and distinct from cleanup settlement", async (t) => {
  const a = requestOwner(t, { registrationThrows: true }),
    cleanup = deferred();
  assert.throws(
    () => publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise),
    scopeHeld,
  );
  assert.throws(
    () => publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise),
    scopeHeld,
  );
  assert.equal(a.calls.length, 1);
  assert.equal(a.snapshot().publicationAccepted, 0);
  assert.equal(a.snapshot().publicationFailures, 1);
  cleanup.reject(Error("PRIVATE_CLEANUP_FAILURE"));
  await assert.rejects(cleanup.promise, /PRIVATE_CLEANUP_FAILURE/);
  assert.equal(a.snapshot().publishedSettled, 1);
  assert.equal(JSON.stringify(a.snapshot()).includes("PRIVATE_"), false);
});
test("bound constructor rejects copied/live-swapped owners before any broker", async (t) => {
  const a = requestOwner(t),
    b = requestOwner(t);
  let borrows = 0;
  for (const [scope, token] of [
    [{ ...a.scope }, a.ownerToken],
    [a.scope, b.ownerToken],
  ])
    await assert.rejects(
      createWorkersRequestBoundNeonLoginPools(
        dependencies(() => {
          borrows++;
        }),
        scope,
        token,
        configurationDigest,
      ),
      held,
    );
  assert.equal(borrows, 0);
});
test("an existing bound pool cannot start a connect after the parent ends", async (t) => {
  const a = requestOwner(t);
  let borrows = 0;
  const pools = await a.pools(() => {
    borrows++;
  });
  a.attempt.end();
  await assert.rejects(pools.loginPool.connect(c()), held);
  assert.equal(borrows, 0);
  assert.equal(a.calls.length, 0);
});
test("independent child signal is legitimate and parent abort propagates to the broker", async (t) => {
  const a = requestOwner(t),
    child = new AbortController(),
    borrowed = deferred(),
    result = deferred();
  let brokerControl;
  const pools = await a.pools((_namespace, control) => {
    brokerControl = control;
    borrowed.resolve();
    return result.promise;
  });
  const pending = pools.loginPool.connect(c(Date.now() + 10000, child.signal));
  const failure = assert.rejects(pending, held);
  await borrowed.promise;
  assert.equal(brokerControl.signal.aborted, false);
  assert.notEqual(brokerControl.signal, child.signal);
  a.parent.abort();
  assert.equal(brokerControl.signal.aborted, true);
  assert.equal(a.calls.length, 1, "cleanup is synchronously published on parent abort");
  child.abort();
  await failure;
  result.reject(Error("LATE_BORROW_FAILED"));
  await tick();
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(a.calls.length, 1);
  assert.equal(m.socketAttempts, 0);
  assert.equal(m.observerConnects, 0);
  assert.equal(m.activeWaitListeners, 0);
});
test("parent cap bounds broker deadline even with a longer independent child control", async (t) => {
  const start = Date.now(),
    a = requestOwner(t, { now: () => start });
  let brokerDeadline;
  a.attempt.cap(start + 400);
  const pools = await a.pools((_namespace, control) => {
    brokerDeadline = control.deadlineMs;
    throw Error("SYNTHETIC_BORROW_DENIED");
  });
  await assert.rejects(pools.loginPool.connect(c(start + 20000)), held);
  assert.equal(brokerDeadline, start + 400);
  assert.equal(a.snapshot().publishedSettled, 1);
});
test("a cap narrowed during pending borrow prevents late authority and driver construction", async (t) => {
  let at = Date.now();
  const a = requestOwner(t, { now: () => at }),
    child = new AbortController();
  const entered = deferred(),
    result = deferred();
  let namespace,
    brokerControl,
    releases = 0;
  const pools = await a.pools((n, control) => {
    namespace = n;
    brokerControl = control;
    entered.resolve();
    return result.promise;
  });
  const pending = pools.loginPool.connect(c(at + 20000, child.signal));
  const failed = assert.rejects(pending, held);
  await entered.promise;
  a.attempt.cap(at + 200);
  at += 201;
  result.resolve({
    namespaceJson: namespace,
    password: syntheticPasswordMarker,
    expiresAtMs: at + 10000,
    revocationSignal: new AbortController().signal,
    release: async () => {
      releases++;
    },
  });
  await failed;
  assert.equal(brokerControl.signal.aborted, true);
  assert.equal(releases, 1);
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.socketAttempts, 0);
  assert.equal(m.observerConnects, 0);
  assert.equal(m.activeLeases, 0);
  assert.equal(m.normalReleases, 0);
});
function invalidLease(namespace, release) {
  return {
    namespaceJson: namespace + " ",
    password: syntheticPasswordMarker,
    expiresAtMs: Date.now() + 10000,
    revocationSignal: new AbortController().signal,
    release,
  };
}
test("failed connect joins its one published disposal before returning its primary failure", async (t) => {
  const a = requestOwner(t),
    entered = deferred(),
    ack = deferred();
  let releases = 0,
    rejected = false;
  const pools = await a.pools((namespace) =>
    invalidLease(namespace, () => {
      releases++;
      entered.resolve();
      return ack.promise;
    }),
  );
  const pending = pools.loginPool.connect(c());
  const outcome = assert.rejects(pending, held).then(() => {
    rejected = true;
  });
  await entered.promise;
  assert.equal(rejected, false);
  assert.equal(a.calls.length, 1);
  assert.notEqual(a.calls[0], pending, "register release itself, never the connect wrapper");
  assert.equal(a.snapshot().publishedPending, 1);
  a.parent.abort();
  ack.resolve();
  await outcome;
  assert.equal(releases, 1);
  assert.equal(a.calls.length, 1);
  assert.equal(a.snapshot().publishedSettled, 1);
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.normalReleases, 0);
  assert.equal(m.observerConnects, 0);
  assert.equal(m.activeLeases, 0);
  assert.equal(m.activeWaitListeners, 0);
});
test("registration throw still disposes once and cannot restore a normal release", async (t) => {
  const a = requestOwner(t, { registrationThrows: true });
  let releases = 0;
  const pools = await a.pools((namespace) =>
    invalidLease(namespace, async () => {
      releases++;
    }),
  );
  await assert.rejects(pools.loginPool.connect(c()), held);
  assert.equal(releases, 1);
  assert.equal(a.snapshot().publicationFailures, 1);
  assert.equal(a.snapshot().publicationAccepted, 0);
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.normalReleases, 0);
  assert.equal(m.observerConnects, 0);
  assert.equal(m.activeLeases, 0);
});
test("bounded disposal settles without inventing an ack and a late ack stays late", async (t) => {
  const a = requestOwner(t),
    ack = deferred();
  let releaseObservedAt;
  const pools = await a.pools((namespace) =>
    invalidLease(namespace, () => {
      releaseObservedAt = performance.now();
      return ack.promise;
    }),
  );
  await assert.rejects(pools.loginPool.connect(c(Date.now() + 5000)), held);
  let m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.leaseReleaseAttempts, 1);
  assert.equal(m.leaseReleaseAcks, 0);
  assert.equal(m.activeLeases, 1);
  assert.equal(a.snapshot().publishedSettled, 1);
  // C was latched before this real release callback. Cross a monotonic
  // upper bound on that same C; a fractional timer timeout alone is not proof.
  assert.ok(Number.isFinite(releaseObservedAt));
  const strictlyAfter = releaseObservedAt + 1000,
    observationStopAt = performance.now() + 3000;
  while (performance.now() <= strictlyAfter) {
    assert.ok(performance.now() < observationStopAt, "bounded test-only observation");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.ceil(strictlyAfter - performance.now()))),
    );
  }
  assert.ok(performance.now() <= observationStopAt, "test observation failsafe");
  assert.ok(performance.now() > strictlyAfter, "actual original-C upper bound crossed");
  ack.resolve();
  await tick();
  m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.leaseReleaseAcks, 1);
  assert.equal(m.leaseReleaseLateAcks, 1);
  assert.equal(m.normalReleases, 0);
  assert.equal(m.observerConnects, 0);
});

test("settlement telemetry occurs once after the exact real Promise settles, with closed values only", async (t) => {
  const a = requestOwner(t),
    cleanup = deferred(),
    lines = [];
  const original = console.debug;
  console.debug = (line) => lines.push(line);
  try {
    publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise);
    publishManagedLoginCleanup(a.scope, a.ownerToken, cleanup.promise);
    assert.equal(a.calls[0], cleanup.promise);
    await tick();
    assert.equal(lines.length, 0);
    cleanup.resolve({ secret: "SYNTHETIC_PRIVATE_SETTLEMENT_VALUE" });
    await cleanup.promise;
    assert.equal(lines.length, 1);
    const message = JSON.parse(lines[0]);
    assert.deepEqual(
      Object.keys(message).sort(),
      ["event", "outcome", ...Object.keys(a.snapshot())].sort(),
    );
    assert.equal(message.event, "morrow_managed_login_cleanup_settled");
    assert.equal(message.outcome, "fulfilled");
    assert.equal(message.publishedPending, 0);
    assert.equal(message.publishedSettled, 1);
    assert.equal(message.duplicatePublicationAttempts, 1);
    for (const key of Object.keys(a.snapshot())) {
      assert.equal(message[key], a.snapshot()[key]);
      assert.ok(Number.isSafeInteger(message[key]) && message[key] >= 0);
    }
    assert.equal(lines[0].includes("SYNTHETIC_PRIVATE"), false);
    assert.equal(a.calls.length, 1);
  } finally {
    console.debug = original;
  }
});
test("rejected settlement has only a fixed enum and logging failure cannot alter Promise outcome", async (t) => {
  const a = requestOwner(t),
    rejected = deferred(),
    lines = [];
  const original = console.debug;
  console.debug = (line) => lines.push(line);
  try {
    publishManagedLoginCleanup(a.scope, a.ownerToken, rejected.promise);
    const primary = Error("SYNTHETIC_PRIVATE_RELEASE_REASON");
    rejected.reject(primary);
    await assert.rejects(rejected.promise, (error) => error === primary);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).outcome, "rejected");
    assert.equal(lines[0].includes(primary.message), false);
    const fulfilled = deferred();
    let attempts = 0;
    console.debug = () => {
      attempts++;
      throw Error("SYNTHETIC_PRIVATE_LOG_FAILURE");
    };
    publishManagedLoginCleanup(a.scope, a.ownerToken, fulfilled.promise);
    fulfilled.resolve();
    await fulfilled.promise;
    assert.equal(attempts, 1);
    assert.equal(a.snapshot().publishedSettled, 2);
    assert.equal(a.snapshot().publicationFailures, 0);
    assert.equal(a.calls[1], fulfilled.promise);
    assert.equal(a.calls.length, 2);
  } finally {
    console.debug = original;
  }
});
test("pre-wait parent abort sinks the queued borrow rejection without running the broker", async (t) => {
  let pools,
    a,
    borrows = 0,
    armed = true;
  const now = () => {
    if (
      armed &&
      pools &&
      snapshotControlledNeonLoginPoolMetrics(pools).loginPool.borrowAttempts === 1
    ) {
      armed = false;
      a.parent.abort();
    }
    return Date.now();
  };
  a = requestOwner(t, { now });
  pools = await a.pools(() => {
    borrows++;
    throw Error("MUST_NOT_BORROW");
  });
  await assert.rejects(pools.loginPool.connect(c(Date.now() + 5000)), held);
  // The source owns the queued Promise sink. Do not catch that raw Promise or
  // install an unhandledRejection handler in this test to conceal a regression.
  await tick();
  await tick();
  assert.equal(a.parent.signal.aborted, true);
  assert.equal(borrows, 0);
  assert.equal(a.calls.length, 1);
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.socketAttempts, 0);
  assert.equal(m.observerConnects, 0);
  assert.equal(m.activeWaitTimers, 0);
  assert.equal(m.activeWaitListeners, 0);
});

for (const stop of ["parent_ended", "business_deadline_expired", "clock_regression"])
  test(
    "cleanup uses current trusted clock after acquired lease loses parent: " + stop,
    async (t) => {
      const epoch = 1800000000000;
      let at = epoch,
        pools,
        stopped = false,
        releaseCalls = 0,
        releaseControl;
      const a = requestOwner(t, {
        now() {
          if (
            pools &&
            !stopped &&
            snapshotControlledNeonLoginPoolMetrics(pools).loginPool.leasesAcquired === 1
          ) {
            stopped = true;
            at =
              stop === "clock_regression"
                ? epoch - 1
                : epoch + (stop === "parent_ended" ? 5000 : 30000);
            // This actual original-attempt check ends after the lease is owned,
            // before the pool can refresh its last successful normal timestamp.
            a.attempt.end();
          }
          return at;
        },
      });
      pools = await a.pools(async (namespaceJson) => ({
        namespaceJson,
        password: syntheticPasswordMarker,
        expiresAtMs: epoch + 60000,
        revocationSignal: new AbortController().signal,
        async release(control) {
          releaseCalls++;
          releaseControl = control;
          if (control.signal.aborted || control.deadlineMs <= at)
            throw Error("FIXED_CLEANUP_CONTROL_NOT_LIVE");
        },
      }));
      await assert.rejects(pools.loginPool.connect(c(epoch + 25000)), held);
      await Promise.allSettled(a.calls);
      await tick();
      const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
      assert.equal(stopped, true);
      assert.equal(releaseCalls, 1, "the one already-owned credential is disposed once");
      assert.equal(a.calls.length, 1, "the original release Promise is published once");
      assert.equal(
        a.attempt.control().deadlineMs,
        epoch + 25000,
        "business authority is never renewed",
      );
      assert.equal(m.socketAttempts, 0);
      assert.equal(m.observerConnects, 0);
      assert.equal(m.querySubmissions, 0);
      assert.equal(m.normalReleases, 0);
      assert.equal(m.unverifiedReleases, 1);
      if (stop === "clock_regression") {
        assert.equal(releaseControl.signal.aborted, true);
        assert.equal(m.leaseReleaseAcks, 0);
        assert.equal(m.activeLeases, 1, "invalid clock leaves custody unverified");
      } else {
        assert.equal(releaseControl.signal.aborted, false);
        assert.ok(releaseControl.deadlineMs > at);
        assert.ok(
          releaseControl.deadlineMs <= at + 1000,
          "only the remaining original C is mapped",
        );
        assert.equal(m.cleanupLeaseReleaseAcks, 1);
        assert.equal(m.activeLeases, 0);
      }
      assert.equal(m.activeWaitTimers, 0);
      assert.equal(m.activeWaitListeners, 0);
    },
  );
