import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  prepareSyntheticWorkosAuthenticationOperatorRun as fixture,
  consumeWorkosAuthenticationOperatorNativePermit as consume,
  readWorkosAuthenticationOperatorRun as read,
  releaseWorkosAuthenticationOperatorRun as release,
} from "../scripts/workos-authentication-operator-input.mjs";
import { createWorkosAuthenticationOperatorController as create } from "../scripts/workos-authentication-operator-controller.mjs";
const proof = () => randomBytes(32).toString("base64url");
const material = () => {
  const verifier = proof();
  return Object.freeze({
    challengeId: randomUUID(),
    state: proof(),
    browserProof: proof(),
    verifier,
    codeChallenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
    codeChallengeMethod: "S256",
  });
};
function setup(fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "morrow-l-controller-")),
    root = path.join(dir, "run");
  let run,
    controller,
    now = 1000000,
    drift = false;
  const stats = {
    begins: 0,
    admits: 0,
    reconciles: 0,
    transports: 0,
    jwks: 0,
    posts: 0,
    pages: 0,
    keyReads: 0,
    closes: 0,
  };
  const m = material(),
    admissionId = randomUUID();
  try {
    run = fixture(root, {
      clock: () => now,
      currentScope: (expected) => (drift ? "{}" : expected),
      fault: options.fault,
    });
    const context = read(run);
    const admission = {
      async begin() {
        stats.begins++;
        if (options.begin) return options.begin(m);
        return m;
      },
      async admit(text) {
        stats.admits++;
        const v = JSON.parse(text);
        return {
          outcome: options.admitOutcome ?? "newly_reserved",
          commandId: v.commandId,
          admissionId,
        };
      },
      async reconcile(text) {
        stats.reconciles++;
        if (options.reconcile)
          await options.reconcile({
            stats,
            setNow: (v) => (now = v),
            setDrift: () => (drift = true),
          });
        const v = JSON.parse(text);
        return { outcome: options.reconcileOutcome ?? "held", commandId: v.commandId, admissionId };
      },
    };
    const transportFactory = (permit) => {
      stats.transports++;
      const native = consume(permit);
      return {
        mode: "synthetic",
        close() {
          stats.closes++;
          native.close();
        },
        async completeOnce(secret, control) {
          assert.deepEqual(Object.keys(JSON.parse(secret)).sort(), ["code", "verifier"]);
          assert.equal(control.deadlineMs, Math.min(context.expiresAtMs, now + 25000));
          if (options.transport)
            return options.transport({ native, control, stats, now, context, root });
          await control.beforeJwks();
          stats.jwks++;
          await control.beforePost();
          stats.posts++;
          await control.onVerifiedTarget(
            JSON.stringify({
              schemaVersion: 1,
              operationId: native.operationId,
              activationId: native.activationId,
              sourceDigest: native.sourceDigest,
              environmentId: native.binding.environmentId,
              applicationId: native.binding.applicationId,
              clientId: native.binding.clientId,
              issuer: native.profile.issuerTemplate.replace("{clientId}", native.binding.clientId),
              subjectId: native.approvedSubjectId,
              providerSessionId: "session_" + "E".repeat(26),
              tokenProfileDigest: "a".repeat(64),
              keySetDigest: "b".repeat(64),
              verifiedAtMs: now,
              tokenExpiresAtMs: now + 120000,
            }),
          );
          await control.beforePage(
            JSON.stringify({
              schemaVersion: 1,
              subjectId: native.approvedSubjectId,
              after: null,
              limit: 100,
              order: "asc",
            }),
            { signal: control.signal, deadlineMs: control.deadlineMs, pageNumber: 1 },
          );
          stats.pages++;
          assert.match(native.credential(), /^synthetic_/);
          stats.keyReads++;
          await control.onEvidenceObservation(
            JSON.stringify({
              schemaVersion: 1,
              kind: "historical_evidence_observation",
              outcome: "evidence_observed",
              category: "evidence_observed",
              statusClass: "2xx",
              jwksGetCount: 1,
              codePostCount: 1,
              sessionGetCount: 1,
              observedAtMs: now,
              expiresAtMs: now + 5000,
              tokenProfileDigest: "a".repeat(64),
              keySetDigest: "b".repeat(64),
              observationProfileDigest: "c".repeat(64),
            }),
          );
          return {
            outcome: "verified_active_evidence",
            category: "evidence_observed",
            statusClass: "2xx",
            jwksGetCount: 1,
            codePostCount: 1,
            sessionGetCount: 1,
            tokenProvenance: "signature_verified",
            sessionClientBinding: "expected_only",
            sessionLiveness: "not_guaranteed",
            providerSessionCleanup: "unknown",
          };
        },
      };
    };
    controller = create({ ownedRun: run, admission, transportFactory });
    return Promise.resolve(
      fn({
        run,
        root,
        context,
        admission,
        transportFactory,
        controller,
        stats,
        m,
        setNow: (v) => (now = v),
        setDrift: () => (drift = true),
      }),
    ).finally(() => {
      controller?.close();
      release(run);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  } catch (e) {
    controller?.close();
    if (run) release(run);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
const callback = (m, changes = {}) =>
  JSON.stringify({
    state: m.state,
    browserProof: m.browserProof,
    code: "opaque synthetic code",
    ...changes,
  });

test("full controller protocol persists each intent before exposing a manual link or fake effect", () =>
  setup(async ({ controller, stats, root, m }) => {
    assert.equal(controller.status().state, "ready");
    assert.equal(stats.transports, 1);
    const started = await controller.start();
    assert.equal(started.state, m.state);
    assert.equal(fs.existsSync(path.join(root, "initiation_started.json")), true);
    assert.equal(
      new URL(started.authorizationUrl).searchParams.get("code_challenge"),
      m.codeChallenge,
    );
    const result = await controller.complete(callback(m));
    assert.equal(result.state, "verified_active_evidence");
    assert.equal(stats.jwks, 1);
    assert.equal(stats.posts, 1);
    assert.equal(stats.pages, 1);
    assert.equal(stats.keyReads, 1);
    assert.equal(fs.existsSync(path.join(root, "observation.json")), true);
  }));

test("start and valid callback latch synchronously before any await", () =>
  setup(async ({ controller, stats, m }) => {
    const first = controller.start();
    await assert.rejects(controller.start());
    await first;
    const completed = controller.complete(callback(m));
    assert.throws(() => controller.complete(callback(m)));
    await completed;
    assert.equal(stats.begins, 1);
    assert.equal(stats.admits, 1);
    assert.equal(stats.posts, 1);
  }));

test("malformed and mismatched callbacks do not consume the valid callback", () =>
  setup(async ({ controller, m, stats }) => {
    await controller.start();
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw Error();
        },
        ownKeys() {
          traps++;
          throw Error();
        },
      },
    );
    assert.throws(() => controller.complete(hostile));
    assert.equal(traps, 0);
    for (const change of [
      { state: proof() },
      { browserProof: proof() },
      { code: "" },
      { code: "\ud800" },
      { unexpected: true },
    ])
      assert.throws(() => controller.complete(callback(m, change)));
    assert.equal(controller.status().state, "awaiting_callback");
    assert.equal((await controller.complete(callback(m))).state, "verified_active_evidence");
    assert.equal(stats.admits, 1);
  }));

test("replay or uncertain admission never reaches JWKS, POST or key", async () => {
  for (const admitOutcome of ["held", "denied", "conflict"])
    await setup(
      async ({ controller, stats, m }) => {
        await controller.start();
        assert.equal((await controller.complete(callback(m))).state, "held");
        assert.equal(stats.jwks, 0);
        assert.equal(stats.posts, 0);
        assert.equal(stats.keyReads, 0);
      },
      { admitOutcome },
    );
});

test("source drift after delayed JWKS prevents the sole POST intent", () =>
  setup(
    async ({ controller, stats, m, root }) => {
      await controller.start();
      assert.equal((await controller.complete(callback(m))).state, "held");
      assert.equal(stats.jwks, 1);
      assert.equal(stats.posts, 0);
      assert.equal(fs.existsSync(path.join(root, "exchange_requested.json")), false);
    },
    {
      reconcile({ stats, setDrift }) {
        if (stats.reconciles === 2) setDrift();
      },
    },
  ));

test("read-only reconciliation denial after admission cannot grant a send", () =>
  setup(
    async ({ controller, stats, m }) => {
      await controller.start();
      assert.equal((await controller.complete(callback(m))).state, "held");
      assert.equal(stats.jwks, 0);
      assert.equal(stats.keyReads, 0);
    },
    { reconcileOutcome: "denied" },
  ));

test("closing during pending admission aborts immediately before any initiation", async () => {
  let resolve;
  const gate = new Promise((r) => (resolve = r));
  await setup(
    async ({ controller, stats, root }) => {
      const pending = controller.start();
      controller.close();
      resolve();
      await assert.rejects(pending);
      assert.equal(stats.jwks, 0);
      assert.equal(fs.existsSync(path.join(root, "initiation_started.json")), false);
    },
    {
      async begin(m) {
        await gate;
        return m;
      },
    },
  );
});

test("manual flow expiry is held without waiting for activation expiry", () =>
  setup(async ({ controller, setNow, stats }) => {
    await controller.start();
    setNow(1300000);
    assert.equal(controller.status().state, "held");
    assert.equal(stats.posts, 0);
  }));

test("authorization error consumes only the valid local callback and creates no exchange effect", () =>
  setup(async ({ controller, m, stats }) => {
    await controller.start();
    const pending = controller.authorizationNotCompleted(
      JSON.stringify({ state: m.state, browserProof: m.browserProof }),
    );
    assert.throws(() => controller.complete(callback(m)));
    assert.equal((await pending).state, "authorization_not_completed");
    assert.equal(stats.admits, 0);
    assert.equal(stats.posts, 0);
  }));

test("claim adoption cannot be reused by a second controller or foreign native factory", () =>
  setup(({ run, admission, transportFactory, stats }) => {
    assert.throws(() => create({ ownedRun: run, admission, transportFactory }));
    assert.equal(stats.transports, 1);
  }));

test("unknown fsync after a JWKS intent holds permanently without provider send", () => {
  return setup(
    async ({ controller, m, stats, root }) => {
      await controller.start();
      assert.equal((await controller.complete(callback(m))).state, "held");
      assert.equal(stats.jwks, 0);
      assert.equal(stats.posts, 0);
      assert.equal(fs.existsSync(path.join(root, "jwks_requested.json")), true);
    },
    {
      fault(point) {
        if (point === "after_write:jwks_requested.json") throw Error("synthetic private fs detail");
      },
    },
  );
});

test("transport cannot assert a positive result without a durable observation", () =>
  setup(
    async ({ controller, m }) => {
      await controller.start();
      assert.equal((await controller.complete(callback(m))).state, "held");
    },
    {
      transport() {
        return {
          outcome: "verified_active_evidence",
          category: "evidence_observed",
          statusClass: "2xx",
          jwksGetCount: 1,
          codePostCount: 1,
          sessionGetCount: 1,
          tokenProvenance: "signature_verified",
          sessionClientBinding: "expected_only",
          sessionLiveness: "not_guaranteed",
          providerSessionCleanup: "unknown",
        };
      },
    },
  ));

test("close is synchronous and idempotent while a delayed post-admission check resolves", async () => {
  let resume, ready;
  const gate = new Promise((r) => (resume = r)),
    waiting = new Promise((r) => (ready = r));
  await setup(
    async ({ controller, m, stats, root }) => {
      await controller.start();
      const pending = controller.complete(callback(m));
      await waiting;
      assert.equal(controller.close().state, "closed");
      assert.equal(stats.closes, 1);
      controller.close();
      assert.equal(stats.closes, 1);
      resume();
      assert.equal((await pending).state, "held");
      assert.equal(stats.closes, 1);
      assert.equal(stats.jwks, 1);
      assert.equal(stats.posts, 0);
      assert.equal(fs.existsSync(path.join(root, "exchange_requested.json")), false);
    },
    {
      async reconcile({ stats }) {
        if (stats.reconciles === 2) {
          ready();
          await gate;
        }
      },
    },
  );
});
