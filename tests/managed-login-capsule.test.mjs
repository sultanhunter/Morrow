import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
import {
  parseManagedLoginKeyring,
  importManagedLoginKeyring,
  assertManagedLoginSealEligibility,
  selectManagedLoginSealKey,
  selectManagedLoginOpenKey,
} from "../packages/identity/src/managed-login-capsule.ts";

const at = 1800000000000;
const namespace = "a".repeat(64);
const otherNamespace = "b".repeat(64);
const held = (error) => error instanceof Error && error.message === "STANDALONE_LOGIN_HELD";
const material = () => randomBytes(32).toString("base64url");
const id = (prefix = "a") => prefix + randomUUID().slice(1);
function version(change = {}) {
  return {
    keyId: id(),
    material: material(),
    encryptFromMs: at - 1000,
    encryptUntilMs: at + 600000,
    decryptUntilMs: at + 900000,
    ...change,
  };
}
function ring(versions = [version()], currentKeyId = versions[0].keyId) {
  return {
    schemaVersion: 1,
    purpose: "morrow.login.capsule/1",
    configurationDigest: namespace,
    currentKeyId,
    versions,
  };
}
const parse = (value, expected = namespace) =>
  parseManagedLoginKeyring(JSON.stringify(value), expected);
function scope(t, start = at, duration = 25000) {
  let now = start;
  const abort = new AbortController();
  const attempt = createLoginAttempt(() => now, abort.signal, duration);
  t.after(() => attempt.end());
  return { attempt, abort, set: (value) => (now = value) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("opaque tokens select frozen real nonextractable AES256 keys", async (t) => {
  const first = version();
  const definition = parse(ring([first]));
  const s = scope(t);
  assert.ok(Object.isFrozen(definition));
  assert.deepEqual(Reflect.ownKeys(definition), []);
  assertManagedLoginSealEligibility(definition, s.attempt);
  const resolved = await importManagedLoginKeyring(definition, s.attempt);
  assert.ok(Object.isFrozen(resolved));
  assert.deepEqual(Reflect.ownKeys(resolved), []);
  assertManagedLoginSealEligibility(resolved, s.attempt);
  const selected = selectManagedLoginSealKey(resolved, s.attempt, at + 300000);
  assert.ok(Object.isFrozen(selected));
  assert.deepEqual(Object.keys(selected).sort(), ["key", "keyId"]);
  assert.equal(selected.keyId, first.keyId);
  assert.equal(selected.key.extractable, false);
  assert.equal(selected.key.type, "secret");
  assert.deepEqual(selected.key.algorithm, { name: "AES-GCM", length: 256 });
  assert.deepEqual([...selected.key.usages].sort(), ["decrypt", "encrypt"]);
  assert.equal(selectManagedLoginOpenKey(resolved, first.keyId, s.attempt, at + 300000), selected);
  await assert.rejects(crypto.subtle.exportKey("raw", selected.key), {
    name: "InvalidAccessException",
  });
});

const invalidRings = [
  ["unknown root field", (r) => ({ ...r, extra: true })],
  [
    "missing root field",
    (r) => {
      delete r.purpose;
      return r;
    },
  ],
  ["schema version", (r) => ({ ...r, schemaVersion: 2 })],
  ["wrong purpose", (r) => ({ ...r, purpose: "morrow.other/1" })],
  ["wrong namespace", (r) => ({ ...r, configurationDigest: otherNamespace })],
  ["uppercase namespace", (r) => ({ ...r, configurationDigest: "A".repeat(64) })],
  ["namespace trailing newline", (r) => ({ ...r, configurationDigest: namespace + "\n" })],
  ["no versions", (r) => ({ ...r, versions: [] })],
  ["three versions", (r) => ({ ...r, versions: [r.versions[0], version(), version()] })],
  ["versions object", (r) => ({ ...r, versions: {} })],
  ["null version", (r) => ({ ...r, versions: [null] })],
  [
    "unknown version field",
    (r) => {
      r.versions[0].extra = true;
      return r;
    },
  ],
  [
    "missing version field",
    (r) => {
      delete r.versions[0].decryptUntilMs;
      return r;
    },
  ],
  ["unselected current UUID", (r) => ({ ...r, currentKeyId: id("b") })],
  ["uppercase current UUID", (r) => ({ ...r, currentKeyId: r.currentKeyId.toUpperCase() })],
  [
    "UUID trailing newline",
    (r) => {
      r.versions[0].keyId += "\n";
      r.currentKeyId = r.versions[0].keyId;
      return r;
    },
  ],
  [
    "duplicate UUID",
    (r) => ({ ...r, versions: [r.versions[0], version({ keyId: r.currentKeyId })] }),
  ],
  [
    "duplicate material",
    (r) => ({
      ...r,
      versions: [r.versions[0], version({ keyId: id("b"), material: r.versions[0].material })],
    }),
  ],
  [
    "31 AES bytes",
    (r) => {
      r.versions[0].material = randomBytes(31).toString("base64url");
      return r;
    },
  ],
  [
    "33 AES bytes",
    (r) => {
      r.versions[0].material = randomBytes(33).toString("base64url");
      return r;
    },
  ],
  [
    "padded AES encoding",
    (r) => {
      r.versions[0].material += "=";
      return r;
    },
  ],
  [
    "noncanonical AES tail bits",
    (r) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const text = r.versions[0].material;
      r.versions[0].material = text.slice(0, -1) + alphabet[alphabet.indexOf(text.at(-1)) + 1];
      return r;
    },
  ],
  [
    "negative time",
    (r) => {
      r.versions[0].encryptFromMs = -1;
      return r;
    },
  ],
  [
    "fractional time",
    (r) => {
      r.versions[0].encryptFromMs = at + 0.5;
      return r;
    },
  ],
  [
    "string time",
    (r) => {
      r.versions[0].encryptFromMs = String(at);
      return r;
    },
  ],
  [
    "equal encryption bounds",
    (r) => {
      r.versions[0].encryptFromMs = r.versions[0].encryptUntilMs;
      return r;
    },
  ],
  [
    "decrypt cutoff before encryption cutoff",
    (r) => {
      r.versions[0].decryptUntilMs = r.versions[0].encryptUntilMs - 1;
      return r;
    },
  ],
  [
    "retirement beyond300s",
    (r) => {
      r.versions[0].decryptUntilMs++;
      return r;
    },
  ],
  [
    "checked retirement overflow",
    (r) => {
      r.versions[0].encryptUntilMs = 8640000000000000;
      r.versions[0].decryptUntilMs = 8640000000000000;
      return r;
    },
  ],
  [
    "malformed UTF16",
    (r) => {
      r.versions[0].material = "\ud800";
      return r;
    },
  ],
];
for (const [name, change] of invalidRings)
  test("closed keyring refuses " + name, () => {
    assert.throws(() => parse(change(ring())), held);
  });

test("strict JSON rejects duplicate decoded names and enforces4096 UTF8 bytes", () => {
  const text = JSON.stringify(ring());
  assert.throws(
    () =>
      parseManagedLoginKeyring(
        text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
        namespace,
      ),
    held,
  );
  assert.throws(
    () =>
      parseManagedLoginKeyring(
        text.replace('"schemaVersion":1', '"schemaVersion":1,"\\u0073chemaVersion":1'),
        namespace,
      ),
    held,
  );
  assert.throws(
    () =>
      parseManagedLoginKeyring(
        text.replace('"encryptFromMs":', '"encryptFromMs":0,"encryptFromMs":'),
        namespace,
      ),
    held,
  );
  const exact = text + " ".repeat(4096 - Buffer.byteLength(text));
  assert.ok(parseManagedLoginKeyring(exact, namespace));
  assert.throws(() => parseManagedLoginKeyring(exact + " ", namespace), held);
  assert.throws(() => parseManagedLoginKeyring(text + "\ud800", namespace), held);
  assert.throws(() => parseManagedLoginKeyring(text, namespace + "\n"), held);
  let getters = 0;
  const object = Object.defineProperty({}, "material", {
    get() {
      getters++;
      throw Error("PRIVATE");
    },
  });
  assert.throws(() => parseManagedLoginKeyring(object, namespace), held);
  assert.throws(() => parseManagedLoginKeyring(text, object), held);
  assert.equal(getters, 0);
});

test("copied, forged, wrong-kind and proxy tokens have no authority", async (t) => {
  const definition = parse(ring());
  const s = scope(t);
  const resolved = await importManagedLoginKeyring(definition, s.attempt);
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error("PRIVATE");
      },
    },
  );
  for (const forged of [
    {},
    Object.freeze({ ...definition }),
    Object.freeze({ ...resolved }),
    proxy,
    null,
    "token",
  ]) {
    await assert.rejects(importManagedLoginKeyring(forged, s.attempt), held);
    assert.throws(() => assertManagedLoginSealEligibility(forged, s.attempt), held);
    assert.throws(() => selectManagedLoginSealKey(forged, s.attempt, at + 1000), held);
    assert.throws(() => selectManagedLoginOpenKey(forged, id(), s.attempt, at + 1000), held);
  }
  await assert.rejects(importManagedLoginKeyring(resolved, s.attempt), held);
  assert.throws(() => selectManagedLoginSealKey(definition, s.attempt, at + 1000), held);
  assert.equal(traps, 0);
});

test("half-open seal/open cutoffs and covered fixed expiry are checked each use", async (t) => {
  const first = version({
    encryptFromMs: at,
    encryptUntilMs: at + 1000,
    decryptUntilMs: at + 301000,
  });
  const definition = parse(ring([first]));
  const s = scope(t);
  const resolved = await importManagedLoginKeyring(definition, s.attempt);
  assertManagedLoginSealEligibility(definition, s.attempt);
  const selected = selectManagedLoginSealKey(resolved, s.attempt, first.decryptUntilMs);
  assert.equal(selected.keyId, first.keyId);
  assert.throws(
    () => selectManagedLoginSealKey(resolved, s.attempt, first.decryptUntilMs + 1),
    held,
  );
  for (const expiry of [
    undefined,
    null,
    at,
    at - 1,
    NaN,
    Infinity,
    "1800000001000",
    8640000000000001,
  ])
    assert.throws(() => selectManagedLoginOpenKey(resolved, first.keyId, s.attempt, expiry), held);
  s.set(at + 999);
  assertManagedLoginSealEligibility(resolved, s.attempt);
  s.set(at + 1000);
  assert.doesNotThrow(() => s.attempt.check());
  assert.throws(() => assertManagedLoginSealEligibility(definition, s.attempt), held);
  assert.throws(() => selectManagedLoginSealKey(resolved, s.attempt, at + 300000), held);
  assert.equal(selectManagedLoginOpenKey(resolved, first.keyId, s.attempt, at + 300000), selected);
  const end = scope(t, first.decryptUntilMs);
  assert.throws(
    () => selectManagedLoginOpenKey(resolved, first.keyId, end.attempt, first.decryptUntilMs + 1),
    held,
  );
  const before = scope(t, at - 1);
  assert.throws(() => assertManagedLoginSealEligibility(resolved, before.attempt), held);
  assert.throws(
    () => selectManagedLoginOpenKey(resolved, first.keyId, before.attempt, at + 1000),
    held,
  );
});

for (const currentState of ["future", "expired"])
  test("previous callback works while current is " + currentState, async (t) => {
    const previous = version({
      keyId: id("b"),
      encryptFromMs: at - 20000,
      encryptUntilMs: at - 100,
      decryptUntilMs: at + 299900,
    });
    const next =
      currentState === "future"
        ? version({ encryptFromMs: at + 1000 })
        : version({ encryptFromMs: at - 10000, encryptUntilMs: at - 1000, decryptUntilMs: at - 1 });
    const definition = parse(ring([previous, next], next.keyId));
    const s = scope(t);
    assert.throws(() => assertManagedLoginSealEligibility(definition, s.attempt), held);
    const resolved = await importManagedLoginKeyring(definition, s.attempt);
    assert.throws(() => selectManagedLoginSealKey(resolved, s.attempt, at + 1000), held);
    const selected = selectManagedLoginOpenKey(resolved, previous.keyId, s.attempt, at + 100000);
    assert.equal(selected.keyId, previous.keyId);
    assert.deepEqual([...selected.key.usages], ["decrypt"]);
  });

test("expired previous record does not invalidate a current begin", async (t) => {
  const previous = version({
    keyId: id("b"),
    encryptFromMs: at - 10000,
    encryptUntilMs: at - 1000,
    decryptUntilMs: at - 1,
  });
  const next = version();
  const definition = parse(ring([previous, next], next.keyId));
  const s = scope(t);
  const resolved = await importManagedLoginKeyring(definition, s.attempt);
  assertManagedLoginSealEligibility(resolved, s.attempt);
  assert.equal(selectManagedLoginSealKey(resolved, s.attempt, at + 300000).keyId, next.keyId);
  assert.throws(
    () => selectManagedLoginOpenKey(resolved, previous.keyId, s.attempt, at + 1000),
    held,
  );
  assert.throws(() => selectManagedLoginOpenKey(resolved, id("b"), s.attempt, at + 1000), held);
  assert.throws(
    () => selectManagedLoginOpenKey(resolved, next.keyId + "\n", s.attempt, at + 1000),
    held,
  );
});

test("real AES rotation opens exact old UUID, denies old encryption and tampered namespace/tag", async (t) => {
  const first = version();
  const next = version({ keyId: id("b") });
  const a = scope(t),
    b = scope(t);
  const initial = await importManagedLoginKeyring(parse(ring([first])), a.attempt);
  const sealed = selectManagedLoginSealKey(initial, a.attempt, at + 300000);
  const nonce = randomBytes(12);
  const plaintext = new TextEncoder().encode("managed capsule continuity proof");
  const aad = new TextEncoder().encode(
    JSON.stringify(["morrow.login.capsule", "1", namespace, first.keyId]),
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    sealed.key,
    plaintext,
  );
  const rotated = await importManagedLoginKeyring(
    parse(ring([first, next], next.keyId)),
    b.attempt,
  );
  const old = selectManagedLoginOpenKey(rotated, first.keyId, b.attempt, at + 300000);
  assert.notEqual(old.key, sealed.key);
  assert.deepEqual([...old.key.usages], ["decrypt"]);
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    old.key,
    ciphertext,
  );
  assert.deepEqual(new Uint8Array(opened), plaintext);
  assert.equal(selectManagedLoginSealKey(rotated, b.attempt, at + 300000).keyId, next.keyId);
  await assert.rejects(crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, old.key, plaintext), {
    name: "InvalidAccessError",
  });
  const tampered = new Uint8Array(ciphertext.slice(0));
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      old.key,
      tampered,
    ),
    { name: "OperationError" },
  );
  const otherRing = { ...ring([first]), configurationDigest: otherNamespace };
  assert.throws(() => parse(otherRing), held);
  const other = await importManagedLoginKeyring(parse(otherRing, otherNamespace), b.attempt);
  const foreign = selectManagedLoginOpenKey(other, first.keyId, b.attempt, at + 300000);
  const wrongAad = new TextEncoder().encode(
    JSON.stringify(["morrow.login.capsule", "1", otherNamespace, first.keyId]),
  );
  await assert.rejects(
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: wrongAad, tagLength: 128 },
      foreign.key,
      ciphertext,
    ),
    { name: "OperationError" },
  );
  const changed = await importManagedLoginKeyring(
    parse(ring([{ ...first, material: material() }])),
    b.attempt,
  );
  const wrong = selectManagedLoginOpenKey(changed, first.keyId, b.attempt, at + 300000);
  assert.notEqual(wrong.key, old.key);
  await assert.rejects(
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      wrong.key,
      ciphertext,
    ),
    { name: "OperationError" },
  );
});

for (const fault of ["aborted", "expired", "ended", "regressed"])
  test("original attempt " + fault + " forbids actual import", async (t) => {
    const definition = parse(ring());
    const s = scope(t);
    const actualImport = crypto.subtle.importKey.bind(crypto.subtle);
    let calls = 0;
    t.mock.method(crypto.subtle, "importKey", (...args) => {
      calls++;
      return actualImport(...args);
    });
    if (fault === "aborted") s.abort.abort();
    if (fault === "expired") s.set(at + 25000);
    if (fault === "ended") s.attempt.end();
    if (fault === "regressed") s.set(at - 1);
    await assert.rejects(importManagedLoginKeyring(definition, s.attempt), held);
    assert.equal(calls, 0);
  });

test("expiry after first real import prevents second and no resolved result is cached", async (t) => {
  const definition = parse(ring([version(), version({ keyId: id("b") })]));
  const s = scope(t);
  const actualImport = crypto.subtle.importKey.bind(crypto.subtle);
  const buffers = [];
  let calls = 0;
  t.mock.method(crypto.subtle, "importKey", async (...args) => {
    calls++;
    buffers.push(args[1]);
    const key = await actualImport(...args);
    if (calls === 1) s.set(at + 25000);
    return key;
  });
  await assert.rejects(importManagedLoginKeyring(definition, s.attempt), held);
  assert.equal(calls, 1);
  assert.ok(buffers[0].every((byte) => byte === 0));
  const fresh = scope(t);
  const retried = await importManagedLoginKeyring(definition, fresh.attempt);
  assert.equal(calls, 3);
  assert.ok(selectManagedLoginSealKey(retried, fresh.attempt, at + 300000));
  assert.ok(buffers.every((bytes) => bytes.every((byte) => byte === 0)));
});

test("abort with gated real native key result cannot publish a late handle", async (t) => {
  const definition = parse(ring([version(), version({ keyId: id("b") })]));
  const s = scope(t),
    gate = deferred(),
    started = deferred();
  const actualImport = crypto.subtle.importKey.bind(crypto.subtle);
  let calls = 0,
    nativeKey,
    raw;
  t.mock.method(crypto.subtle, "importKey", async (...args) => {
    calls++;
    raw = args[1];
    nativeKey = await actualImport(...args);
    started.resolve();
    await gate.promise;
    return nativeKey;
  });
  const pending = importManagedLoginKeyring(definition, s.attempt);
  await started.promise;
  s.abort.abort();
  await assert.rejects(pending, held);
  assert.equal(calls, 1);
  assert.ok(raw.every((byte) => byte === 0));
  gate.resolve();
  await tick();
  assert.equal(calls, 1);
  assert.equal(nativeKey.extractable, false);
  t.mock.restoreAll();
  const fresh = scope(t);
  const resolved = await importManagedLoginKeyring(definition, fresh.attempt);
  assert.notEqual(selectManagedLoginSealKey(resolved, fresh.attempt, at + 300000).key, nativeKey);
});

test("real imports from concurrent requests own distinct handles and attempts", async (t) => {
  const definition = parse(ring());
  const a = scope(t),
    b = scope(t);
  const [left, right] = await Promise.all([
    importManagedLoginKeyring(definition, a.attempt),
    importManagedLoginKeyring(definition, b.attempt),
  ]);
  assert.notEqual(left, right);
  const leftKey = selectManagedLoginSealKey(left, a.attempt, at + 300000);
  const rightKey = selectManagedLoginSealKey(right, b.attempt, at + 300000);
  assert.notEqual(leftKey.key, rightKey.key);
  a.attempt.end();
  assert.throws(() => selectManagedLoginSealKey(left, a.attempt, at + 300000), held);
  assert.equal(selectManagedLoginSealKey(right, b.attempt, at + 300000), rightKey);
});

test("pre-wait abort sinks a later rejected native import without a late handle", async (t) => {
  const definition = parse(ring());
  const s = scope(t);
  const actualImport = crypto.subtle.importKey.bind(crypto.subtle);
  const nativeFinished = deferred();
  let calls = 0;
  t.mock.method(crypto.subtle, "importKey", (...args) => {
    calls++;
    // Delegate real native import, then inject only its failure delivery. Do
    // not catch this Promise in the test: the source must own its late sink.
    const pending = actualImport(...args).then(() => {
      nativeFinished.resolve();
      throw Error("SYNTHETIC_LATE_NATIVE_IMPORT_REJECTION");
    });
    s.abort.abort();
    return pending;
  });
  await assert.rejects(importManagedLoginKeyring(definition, s.attempt), held);
  await nativeFinished.promise;
  await tick();
  assert.equal(calls, 1);
});
