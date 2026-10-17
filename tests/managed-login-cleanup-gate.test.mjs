import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createManagedLoginCleanupGate,
  createManagedLoginReleaseGate,
} from "../scripts/fixtures/managed-login-cleanup-gate.mjs";

// Synthetic Node objects test observer classification, never native retention.
const nonce = "a".repeat(32);
class RequestFixture extends EventEmitter {
  constructor(route, method = "GET", host = "morrow-cleanup-gate.test") {
    super();
    this.url = `/${nonce}/${route}`;
    this.method = method;
    this.headers = { host };
  }
}
class ResponseFixture extends EventEmitter {
  writableFinished = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }
  end(body) {
    this.body = body;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}
function setup(t) {
  let tick = 0;
  const gate = createManagedLoginCleanupGate({ nonce, now: () => ++tick });
  t.after(async () => {
    gate.beginForcedCleanup();
    gate.destroyOpenResponses();
    await gate.responsesClosed();
    gate.detachListeners();
    assert.equal(gate.snapshot().activeListeners, 0);
    assert.equal(gate.snapshot().activeResponses, 0);
  });
  const request = (route, method, host) => {
    const req = new RequestFixture(route, method, host),
      res = new ResponseFixture();
    const result = gate.node(req, res);
    assert.equal(result, undefined, "raw-node route returns promptly without a Promise");
    return { req, res };
  };
  return { gate, request };
}
test("admission arriving first waits for an actual gate handle", (t) => {
  const { gate, request } = setup(t);
  const admitted = request("accepted");
  assert.equal(admitted.res.status, undefined);
  request("gate");
  assert.equal(admitted.res.status, 200);
  assert.equal(admitted.res.body, "u01-admitted");
  assert.equal(gate.snapshot().gateOpened, false);
});
test("gate arriving first produces one immediate later admission", (t) => {
  const { gate, request } = setup(t);
  request("gate");
  const admitted = request("accepted");
  assert.equal(admitted.res.status, 200);
  assert.equal(
    gate.snapshot().events.filter((e) => e.name === "accepted:acknowledgement_sent").length,
    1,
  );
});
test("request-body completion close is never response cancellation", (t) => {
  const { gate, request } = setup(t);
  const { req } = request("gate");
  req.emit("close");
  assert.equal(gate.snapshot().ignoredIncomingCloses, 1);
  assert.equal(gate.snapshot().naturalPrematureUnfinishedResponseClose, false);
});
test("unknown response error alone remains ambiguous", (t) => {
  const { gate, request } = setup(t);
  const { res } = request("gate");
  res.emit("error", Error("synthetic private error"));
  assert.equal(gate.snapshot().ambiguousErrors, 1);
  assert.equal(gate.snapshot().naturalPrematureUnfinishedResponseClose, false);
  assert.equal(JSON.stringify(gate.snapshot()).includes("synthetic private error"), false);
});
test("natural unopened unfinished response close resolves cancellation once", async (t) => {
  const { gate, request } = setup(t);
  const { res } = request("gate");
  res.destroy();
  res.emit("close");
  await gate.cancellation;
  assert.equal(gate.snapshot().naturalPrematureUnfinishedResponseClose, true);
  assert.equal(gate.snapshot().responseCloseAcknowledgements, 1);
});
test("a finished response close cannot qualify cancellation even without a finish event", (t) => {
  const { gate, request } = setup(t);
  const { res } = request("gate");
  res.writableFinished = true;
  res.emit("close");
  assert.equal(gate.snapshot().naturalPrematureUnfinishedResponseClose, false);
});
test("fallback destruction never promotes the natural outcome", (t) => {
  const { gate, request } = setup(t);
  request("gate");
  gate.beginForcedCleanup();
  gate.destroyOpenResponses();
  assert.equal(gate.snapshot().naturalPrematureUnfinishedResponseClose, false);
  assert.equal(gate.snapshot().responseCloseAcknowledgements, 1);
});
test("positive gate cannot be opened before the finite owner body", (t) => {
  const { gate, request } = setup(t);
  request("gate");
  assert.throws(() => gate.open(), /U01_GATE_OPEN_REFUSED/);
});
test("normal positive gate finish and close remain distinct from Worker read marker", (t) => {
  const { gate, request } = setup(t);
  const pending = request("gate");
  gate.ownerBodyCompleted();
  gate.open();
  assert.equal(pending.res.body, "u01-opened-gate");
  assert.equal(gate.snapshot().responseFinishAcknowledgements, 1);
  assert.equal(gate.snapshot().naturalPrematureUnfinishedResponseClose, false);
  assert.equal(gate.snapshot().gateReadMarker, false);
});
test("one bounded exact post-response Worker read marker is independently observed", async (t) => {
  const { gate, request } = setup(t);
  request("gate");
  gate.ownerBodyCompleted();
  gate.open();
  const { req, res } = request("complete", "POST");
  req.emit("data", Buffer.from("u01-"));
  req.emit("data", Buffer.from("gate-read"));
  req.emit("end");
  await gate.completionMarker;
  assert.equal(res.body, "u01-marker-ack");
  assert.equal(gate.snapshot().gateReadMarker, true);
});
test("marker before gate opening is denied", (t) => {
  const { gate, request } = setup(t);
  request("gate");
  const { req, res } = request("complete", "POST");
  req.emit("data", Buffer.from("u01-gate-read"));
  req.emit("end");
  assert.equal(res.status, 403);
  assert.equal(gate.snapshot().gateReadMarker, false);
});
test("oversized or incorrect marker body is denied", (t) => {
  for (const body of ["x".repeat(33), "wrong-marker"]) {
    const { gate, request } = setup(t);
    request("gate");
    gate.ownerBodyCompleted();
    gate.open();
    const { req, res } = request("complete", "POST");
    req.emit("data", Buffer.from(body));
    req.emit("end");
    assert.equal(res.status, 403);
    assert.equal(gate.snapshot().gateReadMarker, false);
  }
});
test("wrong method, authority and target are refused without a gate", (t) => {
  for (const [route, method, host] of [
    ["gate", "POST"],
    ["gate", "GET", "foreign.test"],
    ["other", "GET"],
  ]) {
    const { gate, request } = setup(t);
    const { res } = request(route, method, host);
    assert.equal(res.status, 403);
    assert.equal(gate.snapshot().requests.gate, 0);
  }
});
test("foreign nonce and duplicate gate cannot replace the original handle", (t) => {
  const { gate, request } = setup(t);
  request("gate");
  assert.equal(request("gate").res.status, 403);
  const req = new RequestFixture("accepted"),
    res = new ResponseFixture();
  req.url = req.url.replace(nonce, "b".repeat(32));
  gate.node(req, res);
  assert.equal(res.status, 403);
  assert.equal(gate.snapshot().requests.gate, 1);
});
test("closed gate refuses later host open and future requests", (t) => {
  const { gate, request } = setup(t);
  const { res } = request("gate");
  res.destroy();
  gate.ownerBodyCompleted();
  assert.throws(() => gate.open(), /U01_GATE_OPEN_REFUSED/);
  gate.beginForcedCleanup();
  assert.equal(request("accepted").res.status, 403);
});
test("snapshot mutations cannot alter subsequent observations", (t) => {
  const { gate, request } = setup(t);
  request("gate");
  const snapshot = gate.snapshot();
  snapshot.requests.gate = 99;
  snapshot.events[0].name = "invented";
  assert.equal(gate.snapshot().requests.gate, 1);
  assert.notEqual(gate.snapshot().events[0].name, "invented");
});
test("cleanup requires an explicit phase and leaves no observer listeners", (t) => {
  const { gate, request } = setup(t);
  const { req, res } = request("gate");
  assert.throws(() => gate.destroyOpenResponses(), /U01_CLEANUP_PHASE_REQUIRED/);
  gate.beginForcedCleanup();
  gate.destroyOpenResponses();
  gate.detachListeners();
  assert.equal(req.eventNames().length, 0);
  assert.equal(res.eventNames().length, 0);
});
test("invalid construction nonce is rejected", () => {
  assert.throws(() => createManagedLoginCleanupGate({ nonce: "../bad" }), /U01_GATE_NONCE_INVALID/);
});
test("invalid marker classification does not double-count raw native calls", (t) => {
  const { gate, request } = setup(t);
  request("gate");
  gate.ownerBodyCompleted();
  gate.open();
  const { req } = request("complete", "POST");
  req.emit("data", Buffer.from("wrong"));
  req.emit("end");
  const observed = gate.snapshot();
  assert.equal(observed.interceptedRequests, 2);
  assert.equal(observed.requests.complete, 1);
  assert.equal(observed.requests.unexpected, 1);
});
test("natural marker finish and closure are observed before forced cleanup", async (t) => {
  const { gate, request } = setup(t);
  request("gate");
  request("accepted");
  gate.ownerBodyCompleted();
  gate.open();
  const { req } = request("complete", "POST");
  req.emit("data", Buffer.from("u01-gate-read"));
  req.emit("end");
  await gate.responsesClosed();
  assert.equal(gate.snapshot().forcedCleanupStarted, false);
  assert.equal(gate.snapshot().responseCloseAcknowledgements, 3);
  assert.equal(gate.snapshot().finishedByRoute.complete, 1);
});
test("bounded overflow is explicitly unobserved and cannot look fully owned", (t) => {
  const { gate, request } = setup(t);
  for (let i = 0; i < 7; i++) request("other");
  assert.equal(gate.snapshot().responseHandles, 6);
  assert.equal(gate.snapshot().interceptedRequests, 7);
  assert.equal(gate.snapshot().unobservedOverflowResponseClosures, 1);
});

function managedSetup(t, expected = 1) {
  const gate = createManagedLoginReleaseGate({ nonce, expected });
  t.after(async () => {
    gate.beginForcedCleanup();
    gate.destroyOpenResponses();
    await gate.responsesClosed();
    gate.detachListeners();
    assert.equal(gate.snapshot().activeResponses, 0);
    assert.equal(gate.snapshot().activeListeners, 0);
  });
  const request = (route, method = "GET", host = "morrow-managed-gate.test") => {
    const req = new RequestFixture(route, method, host),
      res = new ResponseFixture();
    assert.equal(gate.node(req, res), undefined);
    return { req, res };
  };
  return { gate, request };
}
test("managed release gate opens only after a finite owner response", async (t) => {
  const { gate, request } = managedSetup(t);
  const lease = request("lease/1");
  await gate.admitted;
  assert.throws(() => gate.open(), /U_MANAGED_GATE_OPEN/);
  gate.ownerBodyCompleted();
  gate.open();
  assert.equal(lease.res.body, "u-managed-release-open");
  assert.equal(gate.snapshot().acknowledgements, 0);
  const marker = request("complete/1", "POST");
  marker.req.emit("data", Buffer.from("u-managed-release-read"));
  marker.req.emit("end");
  await gate.completed;
  await gate.responsesClosed();
  assert.equal(gate.snapshot().acknowledgements, 1);
  assert.equal(gate.snapshot().responseCloseAcknowledgements, 2);
  assert.equal(gate.snapshot().forcedCleanupStarted, false);
});
test("managed concurrent admissions remain independent and once-only", async (t) => {
  const { gate, request } = managedSetup(t, 2);
  request("lease/1");
  request("lease/2");
  await gate.admitted;
  assert.equal(request("lease/1").res.status, 403);
  gate.ownerBodyCompleted();
  gate.ownerBodyCompleted();
  gate.open();
  for (const id of [2, 1]) {
    const { req } = request("complete/" + id, "POST");
    req.emit("data", Buffer.from("u-managed-release-read"));
    req.emit("end");
  }
  await gate.completed;
  assert.equal(gate.snapshot().acknowledgements, 2);
  assert.equal(gate.snapshot().admittedLeases, 2);
});
test("managed malformed markers cannot manufacture acknowledgement", (t) => {
  for (const value of ["wrong", "x".repeat(33)]) {
    const { gate, request } = managedSetup(t);
    request("lease/1");
    gate.ownerBodyCompleted();
    gate.open();
    const { req, res } = request("complete/1", "POST");
    req.emit("data", Buffer.from(value));
    req.emit("end");
    assert.equal(res.status, 403);
    assert.equal(gate.snapshot().acknowledgements, 0);
    assert.equal(gate.snapshot().callbacks, 2);
  }
});
test("managed premature response closure is natural only before fixture cleanup", async (t) => {
  const { gate, request } = managedSetup(t);
  request("lease/1").res.destroy();
  await gate.canceled;
  assert.equal(gate.snapshot().naturalPrematureCloses, 1);
  const forced = managedSetup(t);
  forced.request("lease/1");
  forced.gate.beginForcedCleanup();
  forced.gate.destroyOpenResponses();
  assert.equal(forced.gate.snapshot().naturalPrematureCloses, 0);
});
test("managed unknown errors and IncomingMessage close never prove cancellation", (t) => {
  const { gate, request } = managedSetup(t);
  const { req, res } = request("lease/1");
  req.emit("close");
  res.emit("error", Error("private synthetic error"));
  assert.equal(gate.snapshot().naturalPrematureCloses, 0);
  assert.equal(gate.snapshot().ambiguousErrors, 1);
  assert.equal(JSON.stringify(gate.snapshot()).includes("private synthetic error"), false);
});
test("managed gate rejects foreign authority, nonce, methods and excess ids", (t) => {
  const { gate, request } = managedSetup(t);
  for (const [route, method, host] of [
    ["lease/1", "POST"],
    ["lease/5", "GET"],
    ["lease/1", "GET", "foreign.test"],
  ])
    assert.equal(request(route, method, host).res.status, 403);
  assert.equal(gate.snapshot().admittedLeases, 0);
  assert.equal(gate.snapshot().unexpected, 3);
});
