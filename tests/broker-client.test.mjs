import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  createBrokerHealth,
  createBrokerNeonCredentialBroker,
  createBrokerSessionPageReader,
} from "../apps/api/src/broker-client.ts";
import {
  encodeNeonLeaseGrant,
  neonLeaseNamespace,
  parseBrokerDatabaseBinding,
} from "../packages/identity/src/broker-protocol.ts";
import {
  createSyntheticNodeControlledNeonLoginPools,
  snapshotControlledNeonLoginPoolMetrics,
} from "../packages/identity/src/controlled-neon-login-pool.ts";
import {
  controlledNeonWireBinding,
  createControlledNeonPgOracle,
} from "../scripts/fixtures/controlled-neon-pg-wire-oracle.mjs";

// P04.T02a AC12, AC16 and AC30 with a fake ApiBroker and injected clocks.
const password = ["synthetic", "broker", "client", "marker"].join("_");
const wire = parseBrokerDatabaseBinding(JSON.stringify(controlledNeonWireBinding));
const loginNamespace = neonLeaseNamespace(wire, "morrow_identity_login");
const held = (error) => error instanceof Error && /HELD|INVALID/.test(error.message);
const control = (deadlineMs = Date.now() + 5000, signal = new AbortController().signal) =>
  Object.freeze({ deadlineMs, signal });
function fakeBroker(overrides = {}) {
  const calls = { health: 0, neonLease: 0, workosSessionPage: 0, arguments: [] };
  const broker = {
    fetch() {
      throw Error("FETCH_MUST_NOT_BE_CALLED");
    },
    health() {
      calls.health++;
      return overrides.health ? overrides.health() : Promise.resolve(true);
    },
    neonLease(...args) {
      calls.neonLease++;
      calls.arguments.push(args);
      return overrides.neonLease
        ? overrides.neonLease(...args)
        : Promise.resolve(encodeNeonLeaseGrant(password));
    },
    workosSessionPage(...args) {
      calls.workosSessionPage++;
      calls.arguments.push(args);
      return overrides.workosSessionPage
        ? overrides.workosSessionPage(...args)
        : Promise.resolve('{"object":"list","data":[]}');
    },
  };
  return { broker, calls };
}
const never = () => new Promise(() => {});

test("AC12: the lease carries the static password and the caller's own deadline", async () => {
  const { broker, calls } = fakeBroker();
  const credentialBroker = createBrokerNeonCredentialBroker(broker, Date.now);
  assert.ok(Object.isFrozen(credentialBroker));
  assert.deepEqual(Object.keys(credentialBroker), ["borrow"]);
  const supplied = control();
  const lease = await credentialBroker.borrow(loginNamespace, supplied);
  assert.ok(Object.isFrozen(lease));
  assert.deepEqual(Object.keys(lease).sort(), [
    "expiresAtMs",
    "namespaceJson",
    "password",
    "release",
    "revocationSignal",
  ]);
  assert.equal(lease.namespaceJson, loginNamespace);
  assert.equal(lease.password, password);
  assert.equal(lease.expiresAtMs, supplied.deadlineMs);
  assert.deepEqual(calls.arguments, [[loginNamespace]]);
  const release = lease.release(control());
  assert.ok(release instanceof Promise);
  await release;
  await lease.release(control());
  assert.equal(lease.revocationSignal.aborted, false);
  assert.equal(calls.neonLease, 1);
  await assert.rejects(lease.release({ deadlineMs: Date.now() }), held);
});

test("AC12: extra keys, non-JSON or a password that breaks the rules is held", async () => {
  for (const grant of [
    JSON.stringify({ schemaVersion: 1, password, extra: true }),
    "not json",
    JSON.stringify({ schemaVersion: 1, password: "short" }),
    JSON.stringify({ schemaVersion: 1, password: "with space " + password }),
    { schemaVersion: 1, password },
    true,
  ]) {
    const { broker } = fakeBroker({ neonLease: () => Promise.resolve(grant) });
    await assert.rejects(
      createBrokerNeonCredentialBroker(broker, Date.now).borrow(loginNamespace, control()),
      held,
    );
  }
});

test("AC12: a bad grant holds the pool before any socket", async () => {
  const { broker } = fakeBroker({ neonLease: () => Promise.resolve("{}") });
  const pools = await createSyntheticNodeControlledNeonLoginPools({
    bindingJson: JSON.stringify(controlledNeonWireBinding),
    credentialBroker: createBrokerNeonCredentialBroker(broker, Date.now),
    now: Date.now,
    loopbackWsUrl: "ws://127.0.0.1:9/morrow-neon-loopback",
  });
  await assert.rejects(pools.loginPool.connect(control()));
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.socketAttempts, 0);
  assert.equal(m.normalReleases, 0);
});

test("AC12: over a PG-wire oracle the pool releases normally once and never unverified", async (t) => {
  const oracle = createControlledNeonPgOracle({ password, poolNames: ["loginPool"] });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/morrow-neon-loopback" });
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  server.on("connection", (socket) => {
    const protocol = oracle.accept({
      send: (bytes) => socket.send(bytes),
      close: () => socket.close(1000),
    });
    socket.on("message", (data) => {
      try {
        protocol.receive(new Uint8Array(data));
      } catch {
        socket.close(1000);
      }
    });
    socket.on("close", () => protocol.transportClosed());
  });
  const { broker, calls } = fakeBroker();
  const pools = await createSyntheticNodeControlledNeonLoginPools({
    bindingJson: JSON.stringify(controlledNeonWireBinding),
    credentialBroker: createBrokerNeonCredentialBroker(broker, Date.now),
    now: Date.now,
    loopbackWsUrl: `ws://127.0.0.1:${server.address().port}/morrow-neon-loopback`,
  });
  const client = await pools.loginPool.connect(control(Date.now() + 10000));
  await client.release(false);
  const m = snapshotControlledNeonLoginPoolMetrics(pools).loginPool;
  assert.equal(m.normalReleases, 1);
  assert.equal(m.unverifiedReleases, 0);
  assert.equal(m.primaryAbsenceVerified, 1);
  assert.equal(m.leaseReleaseAcks, 1);
  assert.equal(calls.neonLease, 1);
  assert.equal(oracle.snapshot().authenticated, 2);
});

test("AC16: an aborted or expired control makes no RPC", async () => {
  const { broker, calls } = fakeBroker();
  const at = 1_800_000_000_000;
  const credentialBroker = createBrokerNeonCredentialBroker(broker, () => at);
  const reader = createBrokerSessionPageReader(broker, "{}", () => at);
  const aborted = new AbortController();
  aborted.abort();
  for (const supplied of [control(at + 1000, aborted.signal), control(at), control(at - 1)]) {
    await assert.rejects(credentialBroker.borrow(loginNamespace, supplied), held);
    await assert.rejects(reader("{}", supplied), held);
  }
  for (const supplied of [{}, { deadlineMs: at + 1000 }, { ...control(at + 1000), extra: 1 }, null])
    await assert.rejects(credentialBroker.borrow(loginNamespace, supplied), held);
  assert.equal(calls.neonLease + calls.workosSessionPage, 0);
});

test("AC16: an abort mid-RPC rejects within 50 ms and the late result is discarded", async () => {
  let resolveLate;
  const { broker, calls } = fakeBroker({
    neonLease: () => new Promise((done) => (resolveLate = done)),
  });
  const abort = new AbortController();
  const pending = createBrokerNeonCredentialBroker(broker, Date.now).borrow(
    loginNamespace,
    control(Date.now() + 5000, abort.signal),
  );
  await new Promise((done) => setTimeout(done, 20));
  const started = performance.now();
  abort.abort();
  await assert.rejects(pending, held);
  assert.ok(performance.now() - started < 50);
  resolveLate(encodeNeonLeaseGrant(password));
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(calls.neonLease, 1);
});

test("AC16: the deadline bounds each RPC and nothing is retried", async () => {
  const { broker, calls } = fakeBroker({ neonLease: never, workosSessionPage: never });
  const started = Date.now();
  await assert.rejects(
    createBrokerNeonCredentialBroker(broker, Date.now).borrow(
      loginNamespace,
      control(Date.now() + 80),
    ),
    held,
  );
  await assert.rejects(
    createBrokerSessionPageReader(broker, "{}", Date.now)("{}", control(Date.now() + 80)),
    held,
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.neonLease, 1);
  assert.equal(calls.workosSessionPage, 1);
});

test("AC16: the session reader sends one integer budget and holds non-string pages", async () => {
  let at = 1_800_000_000_000;
  const { broker, calls } = fakeBroker();
  const reader = createBrokerSessionPageReader(broker, "NS", () => at);
  assert.equal(await reader("SELECTOR", control(at + 4321)), '{"object":"list","data":[]}');
  assert.deepEqual(calls.arguments.at(-1), ["NS", "SELECTOR", 4321]);
  await reader("SELECTOR", control(at + 60000));
  assert.deepEqual(calls.arguments.at(-1), ["NS", "SELECTOR", 10000]);
  for (const page of [{ object: "list" }, 1, null, "x".repeat(131073)]) {
    const fake = fakeBroker({ workosSessionPage: () => Promise.resolve(page) });
    await assert.rejects(
      createBrokerSessionPageReader(fake.broker, "NS", () => at)("S", control(at + 1000)),
      held,
    );
    assert.equal(fake.calls.workosSessionPage, 1);
  }
});

test("AC30: at most one health RPC per 30 s, shared while in flight", async () => {
  let at = 1_800_000_000_000;
  let finish;
  const { broker, calls } = fakeBroker({ health: () => new Promise((done) => (finish = done)) });
  const health = createBrokerHealth(broker, () => at);
  const first = Array.from({ length: 100 }, () => health());
  assert.equal(calls.health, 1);
  finish(true);
  assert.deepEqual(new Set(await Promise.all(first)), new Set([true]));
  for (let i = 0; i < 100; i++) {
    at += 200;
    assert.equal(await health(), true);
  }
  assert.equal(calls.health, 1);
  at += 30000;
  const again = health();
  finish(false);
  assert.equal(await again, false);
  assert.equal(calls.health, 2);
});

test("AC30: a broker that never answers is not ready within 1,100 ms, and that is cached", async () => {
  const { broker, calls } = fakeBroker({ health: never });
  const health = createBrokerHealth(broker, Date.now);
  const started = performance.now();
  assert.equal(await health(), false);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 990 && elapsed < 1100, String(elapsed));
  assert.equal(await health(), false);
  assert.equal(calls.health, 1);
  const odd = fakeBroker({ health: () => Promise.resolve("true") });
  assert.equal(await createBrokerHealth(odd.broker, Date.now)(), false);
});

test("AC29 (api): the lazy keyless port initialises once and reports keyring windows", async () => {
  const { createLazyWorkosLoginPort } = await import("../apps/api/src/workos-port.ts");
  const { createPlatformWorkosProviderOracle } = await import(
    "../scripts/fixtures/fixed-workos-platform-provider.mjs"
  );
  const { parseLoginConfiguration } = await import(
    "../packages/identity/src/standalone-login-protocol.ts"
  );
  const provider = createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" });
  const digest = (await parseLoginConfiguration(provider.configurationJson)).configurationDigest;
  const day = 86400000;
  const ring = (from, until) =>
    JSON.stringify({
      schemaVersion: 1,
      purpose: "morrow.login.capsule/1",
      configurationDigest: digest,
      currentKeyId: "00000000-0000-4000-8000-000000000001",
      versions: [
        {
          keyId: "00000000-0000-4000-8000-000000000001",
          material: Buffer.alloc(32, 7).toString("base64url"),
          encryptFromMs: from,
          encryptUntilMs: until,
          decryptUntilMs: until + 300000,
        },
      ],
    });
  const at = Date.now();
  const original = crypto.subtle.digest;
  let digests = 0;
  crypto.subtle.digest = function (...args) {
    digests++;
    return Reflect.apply(original, this, args);
  };
  try {
    const port = createLazyWorkosLoginPort(provider.configurationJson, () => at);
    const keyring = ring(at - 300000, at + 90 * day);
    const results = await Promise.all(Array.from({ length: 20 }, () => port.readiness(keyring)));
    assert.deepEqual(new Set(results), new Set(["KEYRING_READY"]));
    assert.equal(digests, 4);
    assert.equal(await port.readiness(ring(at - 80 * day, at + 10 * day)), "KEYRING_EXPIRING");
    assert.equal(await port.readiness(ring(at + day, at + 90 * day)), "KEYRING_NOT_YET_VALID");
    assert.equal(await port.readiness(ring(at - 90 * day, at - 1)), "KEYRING_EXPIRED");
    assert.equal(
      await port.readiness(ring(at - 300000, at + 90 * day).replace(digest, "b".repeat(64))),
      "KEYRING_INVALID",
    );
    const broken = createLazyWorkosLoginPort("{}", () => at);
    assert.equal(await broken.readiness(keyring), "PORT_UNAVAILABLE");
    await assert.rejects(broken.readPublicKeyset(control(Date.now() + 1000)));
  } finally {
    crypto.subtle.digest = original;
  }
});
