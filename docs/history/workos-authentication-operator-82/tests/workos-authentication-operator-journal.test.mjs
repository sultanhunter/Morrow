import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  prepareSyntheticWorkosAuthenticationOperatorRun as fixture,
  adoptWorkosAuthenticationOperatorRun as adopt,
  consumeWorkosAuthenticationOperatorNativePermit as consume,
  readWorkosAuthenticationOperatorRun as read,
  releaseWorkosAuthenticationOperatorRun as release,
} from "../scripts/workos-authentication-operator-input.mjs";
const now = 1000000;
function setup(fn, fault = () => {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "morrow-l-journal-")),
    root = path.join(dir, "run");
  let run;
  try {
    run = fixture(root, { clock: () => now, fault });
    const a = adopt(run);
    return fn({ root, run, ...a });
  } finally {
    if (run) release(run);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const intent = () => JSON.stringify({ commandId: randomUUID(), admissionId: randomUUID() });
function posted(a) {
  a.journal.initiation(
    JSON.stringify({ beginCommandId: a.activation.beginCommandId, challengeId: randomUUID() }),
  );
  a.journal.jwks(intent());
  a.journal.exchange(intent());
}
function target(a, changes = {}) {
  const c = a.context;
  return JSON.stringify({
    schemaVersion: 1,
    operationId: a.activation.operationId,
    activationId: a.activation.activationId,
    sourceDigest: c.sourceDigest,
    environmentId: c.binding.environmentId,
    applicationId: c.binding.applicationId,
    clientId: c.binding.clientId,
    issuer: c.profile.issuerTemplate.replace("{clientId}", c.binding.clientId),
    subjectId: c.binding.approvedSubjectId,
    providerSessionId: "session_" + "E".repeat(26),
    tokenProfileDigest: "a".repeat(64),
    keySetDigest: "b".repeat(64),
    verifiedAtMs: now,
    tokenExpiresAtMs: now + 120000,
    ...changes,
  });
}
function page(a, number = 1, after = null) {
  return a.journal.page(
    JSON.stringify({
      schemaVersion: 1,
      subjectId: a.context.binding.approvedSubjectId,
      after,
      limit: 100,
      order: "asc",
    }),
    number,
  );
}
const observation = (changes = {}) =>
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
    ...changes,
  });

test("fixed durable order gates credential reads and historical observation is not a new send handle", () =>
  setup((a) => {
    const native = consume(a.nativeSubpermit);
    assert.throws(() => native.credential());
    assert.throws(() => a.journal.jwks(intent()));
    posted(a);
    assert.throws(() => native.credential());
    a.journal.target(target(a));
    assert.throws(() => native.credential());
    page(a);
    assert.match(native.credential(), /^synthetic_/);
    a.journal.observation(observation());
    assert.throws(() => native.credential());
    assert.equal(a.context.current(), true);
    assert.throws(() => a.journal.observation(observation()));
    assert.throws(() => page(a, 2, "session_" + "F".repeat(26)));
    assert.equal(a.journal.counts().observation, "evidence_observed");
  }));

test("wrong owned target bindings and prior/foreign identities cannot unlock the key", () => {
  for (const change of [
    { subjectId: "user_" + "Z".repeat(26) },
    { sourceDigest: "f".repeat(64) },
    { operationId: randomUUID() },
    { activationId: randomUUID() },
    { clientId: "client_" + "Z".repeat(26) },
    { issuer: "https://foreign.invalid" },
    { tokenExpiresAtMs: now },
  ])
    setup((a) => {
      posted(a);
      assert.throws(() => a.journal.target(target(a, change)));
      assert.equal(fs.existsSync(path.join(a.root, "verified_target.json")), false);
      assert.throws(() => consume(a.nativeSubpermit).credential());
    });
});

test("page intents require exact sequential numbering, owner subject and fresh nonrepeated continuation", () =>
  setup((a) => {
    posted(a);
    a.journal.target(target(a));
    assert.throws(() => page(a, 2));
    assert.throws(() => page(a, 1, "session_" + "F".repeat(26)));
    page(a);
    assert.throws(() => page(a, 2));
    page(a, 2, "session_" + "F".repeat(26));
    assert.throws(() => page(a, 3, "session_" + "F".repeat(26)));
    page(a, 3, "session_" + "G".repeat(26));
    page(a, 4, "session_" + "H".repeat(26));
    assert.throws(() => page(a, 5, "session_" + "I".repeat(26)));
  }));

test("unknown append/fsync acknowledgment permanently holds and retains the attempted record", () => {
  for (const point of ["after_open", "after_write", "after_fsync", "after_directory_fsync"]) {
    let armed = false;
    setup(
      (a) => {
        armed = true;
        a.journal.initiation(
          JSON.stringify({
            beginCommandId: a.activation.beginCommandId,
            challengeId: randomUUID(),
          }),
        );
        assert.throws(() => a.journal.jwks(intent()));
        assert.equal(fs.existsSync(path.join(a.root, "jwks_requested.json")), true);
        assert.throws(() => a.journal.jwks(intent()));
        assert.throws(() => a.context.current());
      },
      (phase) => {
        if (armed && phase === point + ":jwks_requested.json")
          throw Error("synthetic private filesystem detail");
      },
    );
  }
});

test("claimed roots and tampered records cannot recreate a controller or effect handle", () =>
  setup((a) => {
    const raw = fs.readFileSync(path.join(a.root, "claim.json"));
    fs.writeFileSync(path.join(a.root, "claim.json"), Buffer.concat([raw, Buffer.from(" ")]));
    assert.throws(() => a.journal.checkpoint());
    fs.writeFileSync(path.join(a.root, "claim.json"), raw);
    assert.throws(() => read(a.run));
    assert.throws(() => adopt(a.run));
  }));

test("all stage payloads use closed primitive JSON boundaries without getters or proxy traps", () =>
  setup((a) => {
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
    assert.throws(() => a.journal.initiation(hostile));
    assert.equal(traps, 0);
    assert.throws(() =>
      a.journal.initiation('{"beginCommandId":"x","beginCommandId":"y","challengeId":"z"}'),
    );
    assert.equal(fs.existsSync(path.join(a.root, "initiation_started.json")), false);
  }));

test("historical observation rejects impossible counts and malformed authority fields", () => {
  for (const changes of [
    { sessionGetCount: 2 },
    { codePostCount: 2 },
    { tokenProfileDigest: null },
    { expiresAtMs: now },
    { extraAuthority: true },
    { statusClass: "200" },
  ])
    setup((a) => {
      posted(a);
      a.journal.target(target(a));
      page(a);
      assert.throws(() => a.journal.observation(observation(changes)));
      assert.equal(fs.existsSync(path.join(a.root, "observation.json")), false);
    });
});
