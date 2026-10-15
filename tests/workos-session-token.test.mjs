import test from "node:test";
import assert from "node:assert/strict";
import { verify as rsaVerify } from "node:crypto";
import { createWorkosSessionTokenVerifier } from "../packages/identity/src/workos-session-token.ts";
import {
  buildWorkosSessionTokenFixture,
  createWorkosSessionTokenSigningKey,
  workosSessionTokenSha256,
} from "./fixtures/workos-session-token.mjs";
const fixture = buildWorkosSessionTokenFixture();
const make = (f = fixture, clock = f.clock) =>
  createWorkosSessionTokenVerifier(f.profileJson, f.snapshotJson, clock);
const deny = async (verifier, token) =>
  assert.deepEqual(await verifier.verify(token), { outcome: "denied", handle: null });
function hostile() {
  let traps = 0;
  const value = new Proxy(
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
      getPrototypeOf() {
        traps++;
        throw Error();
      },
    },
  );
  return {
    value,
    get traps() {
      return traps;
    },
  };
}
test("independent node RSA signature produces only a private provenance-bound candidate", async () => {
  const token = fixture.sign({
    org_id: "org_" + "F".repeat(26),
    email: "private@example.test",
    role: "admin",
    roles: ["admin"],
    permissions: ["all"],
  });
  const [header, payload, signature] = token.split(".");
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(header + "." + payload),
      fixture.publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  const verifier = make(),
    result = await verifier.verify(token);
  assert.equal(result.outcome, "verified");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.handle));
  assert.equal(JSON.stringify(result.handle), "{}");
  const candidate = verifier.readCandidate(result.handle);
  assert.deepEqual(
    Object.keys(candidate).sort(),
    [
      "providerId",
      "environmentId",
      "applicationId",
      "clientId",
      "issuer",
      "subjectId",
      "providerSessionId",
      "providerOrganizationId",
      "issuedAt",
      "expiresAt",
      "profileRevision",
      "profileDigest",
      "keySetDigest",
    ].sort(),
  );
  assert.equal(candidate.subjectId, fixture.claims.sub);
  assert.equal(candidate.providerOrganizationId, "org_" + "F".repeat(26));
  assert.equal(candidate.profileDigest, workosSessionTokenSha256(fixture.profileJson));
  assert.equal(candidate.keySetDigest, workosSessionTokenSha256(fixture.snapshotJson));
  assert.ok(Object.isFrozen(candidate));
  assert.ok(!JSON.stringify(candidate).includes("private@example"));
  assert.ok(!JSON.stringify(candidate).includes("permissions"));
  assert.equal(make().readCandidate(result.handle), null);
  assert.equal(verifier.readCandidate(JSON.parse(JSON.stringify(result.handle))), null);
  assert.equal(verifier.readCandidate({ ...candidate }), null);
});
test("primitive gates reject proxy/object/config inputs without invoking traps", async () => {
  const h = hostile(),
    verifier = make();
  for (const value of [h.value, {}, [], new String(fixture.sign()), null, undefined, 3])
    await deny(verifier, value);
  assert.equal(verifier.readCandidate(h.value), null);
  assert.equal(h.traps, 0);
  for (const value of [h.value, {}, [], null]) {
    assert.throws(
      () => createWorkosSessionTokenVerifier(value, fixture.snapshotJson, fixture.clock),
      /^Error: WORKOS_SESSION_TOKEN_CONFIG_INVALID$/,
    );
    assert.throws(
      () => createWorkosSessionTokenVerifier(fixture.profileJson, value, fixture.clock),
      /^Error: WORKOS_SESSION_TOKEN_CONFIG_INVALID$/,
    );
  }
  assert.equal(h.traps, 0);
});
test("closed profile binds exact client-scoped issuer and immutable owner selectors", () => {
  const changes = [
    { issuer: "https://api.workos.com" },
    { issuer: fixture.profile.issuer + "/" },
    { clientId: "client_wrong" },
    { providerId: "other" },
    { environmentId: "bad" },
    { applicationId: "bad" },
    { revision: 0 },
    { revision: 1.1 },
    { audiencePolicy: "any" },
    { extra: true },
  ];
  for (const change of changes)
    assert.throws(
      () =>
        createWorkosSessionTokenVerifier(
          JSON.stringify({ ...fixture.profile, ...change }),
          fixture.snapshotJson,
          fixture.clock,
        ),
      /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
    );
  for (const json of [
    "null",
    "[]",
    "{}",
    fixture.profileJson.replace('"revision":1', '"revision":1,"revision":1'),
    " ".repeat(8193),
    fixture.profileJson + "x",
  ])
    assert.throws(
      () => createWorkosSessionTokenVerifier(json, fixture.snapshotJson, fixture.clock),
      /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
    );
});
test("snapshot bounds reject invalid lease, shape, future observation and key counts", () => {
  const now = fixture.now;
  for (const change of [
    { schemaVersion: 2 },
    { profileRevision: 2 },
    { observedAtMs: now + 1 },
    { expiresAtMs: now },
    { expiresAtMs: now + 300001 },
    { observedAtMs: 1.2 },
    { expiresAtMs: NaN },
    { jwks: { keys: [] } },
    {
      jwks: {
        keys: Array.from({ length: 17 }, (_, i) => ({ ...fixture.publicJwk, kid: "key" + i })),
      },
    },
    { extra: 1 },
  ])
    assert.throws(
      () =>
        createWorkosSessionTokenVerifier(
          fixture.profileJson,
          JSON.stringify({ ...fixture.snapshot, ...change }),
          fixture.clock,
        ),
      /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
    );
  assert.throws(
    () => createWorkosSessionTokenVerifier(fixture.profileJson, " ".repeat(65537), fixture.clock),
    /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
  );
});
test("same-revision snapshots cannot be grafted across environment, application or client", () => {
  for (const [field, prefix] of [
    ["environmentId", "environment_"],
    ["applicationId", "app_"],
    ["clientId", "client_"],
  ]) {
    const snapshot = { ...fixture.snapshot, [field]: prefix + "X".repeat(26) };
    assert.throws(
      () =>
        createWorkosSessionTokenVerifier(
          fixture.profileJson,
          JSON.stringify(snapshot),
          fixture.clock,
        ),
      /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
    );
  }
});
test("only unambiguous bounded public RSA keys with exponent65537 are admitted", () => {
  for (const change of [
    { kty: "oct" },
    { alg: "HS256" },
    { use: "enc" },
    { key_ops: ["sign"] },
    { e: "Aw" },
    { n: "AA" },
    { n: Buffer.alloc(128, 255).toString("base64url") },
    { n: Buffer.from([127, ...Buffer.alloc(255, 255)]).toString("base64url") },
    { n: Buffer.from([0, ...Buffer.alloc(256, 255)]).toString("base64url") },
    { n: "_".repeat(684) },
    { n: fixture.publicJwk.n + "=" },
    { kid: "" },
    { kid: "bad\nkey" },
    { d: "private" },
    { p: "private" },
    { x5u: "https://foreign.example/key" },
    { extra: true },
  ]) {
    const snapshot = { ...fixture.snapshot, jwks: { keys: [{ ...fixture.publicJwk, ...change }] } };
    assert.throws(
      () =>
        createWorkosSessionTokenVerifier(
          fixture.profileJson,
          JSON.stringify(snapshot),
          fixture.clock,
        ),
      /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
    );
  }
  const duplicate = { ...fixture.snapshot, jwks: { keys: [fixture.publicJwk, fixture.publicJwk] } };
  assert.throws(
    () =>
      createWorkosSessionTokenVerifier(
        fixture.profileJson,
        JSON.stringify(duplicate),
        fixture.clock,
      ),
    /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
  );
  const duplicateMember = fixture.snapshotJson.replace('"kty":"RSA"', '"kty":"RSA","kty":"RSA"');
  assert.throws(
    () => createWorkosSessionTokenVerifier(fixture.profileJson, duplicateMember, fixture.clock),
    /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
  );
});
test("an even RSA modulus invalidates the snapshot even when another key would be selected", () => {
  const modulus = Buffer.from(fixture.publicJwk.n, "base64url");
  modulus[modulus.length - 1] &= 254;
  const even = { ...fixture.publicJwk, n: modulus.toString("base64url") };
  for (const keys of [[even], [fixture.publicJwk, { ...even, kid: "unselected-even-key" }]]) {
    assert.throws(
      () =>
        createWorkosSessionTokenVerifier(
          fixture.profileJson,
          JSON.stringify({ ...fixture.snapshot, jwks: { keys } }),
          fixture.clock,
        ),
      /WORKOS_SESSION_TOKEN_CONFIG_INVALID/,
    );
  }
});
test("signed wrong issuer/client/subject/session/audience and nonhuman identities deny", async () => {
  const verifier = make();
  for (const change of [
    { iss: "https://api.workos.com" },
    { iss: fixture.profile.issuer + "/" },
    { client_id: "client_" + "X".repeat(26) },
    { sub: "agent_instance_" + "D".repeat(26) },
    { sub: "user_bad" },
    { sid: "consent_" + "E".repeat(26) },
    { sid: null },
    { aud: null },
    { aud: fixture.profile.clientId },
    { aud: [] },
    { act: null },
    { act: { sub: "admin" } },
    { sub_profile: "ai_agent" },
    { sub_profile: null },
    { grant_type: "client_credentials" },
    { gty: "client_credentials" },
    { gty: null },
    { org_id: null },
    { org_id: "wrong" },
  ])
    await deny(verifier, fixture.sign(change));
  const noOrg = await verifier.verify(fixture.sign({ sub_profile: "user" }));
  assert.equal(noOrg.outcome, "verified");
  assert.equal(verifier.readCandidate(noOrg.handle).providerOrganizationId, null);
});
test("header algorithm/keyURL/critical/b64 ambiguity and signature corruption deny", async () => {
  const verifier = make();
  for (const change of [
    { alg: "none" },
    { alg: "HS256" },
    { alg: "PS256" },
    { kid: "unknown" },
    { kid: null },
    { typ: "other" },
    { jku: "https://foreign.example/key" },
    { x5u: "http://127.0.0.1/key" },
    { jwk: fixture.publicJwk },
    { crit: [] },
    { b64: true },
  ])
    await deny(verifier, fixture.sign({}, change));
  const token = fixture.sign(),
    pieces = token.split(".");
  const bytes = Buffer.from(pieces[2], "base64url");
  bytes[0] ^= 1;
  await deny(verifier, pieces.slice(0, 2).join(".") + "." + bytes.toString("base64url"));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonical = pieces[2].slice(0, -1) + alphabet[alphabet.indexOf(pieces[2].at(-1)) + 1];
  assert.deepEqual(Buffer.from(noncanonical, "base64url"), Buffer.from(pieces[2], "base64url"));
  await deny(verifier, pieces.slice(0, 2).join(".") + "." + noncanonical);
  await deny(
    verifier,
    fixture.signRaw(
      JSON.stringify(fixture.claims),
      '{"alg":"RS256","kid":"synthetic-key-one","alg":"RS256"}',
    ),
  );
});
test("strict compact/base64url/UTF8/duplicate JSON input rejects malformed tokens", async () => {
  const verifier = make(),
    token = fixture.sign(),
    [header, payload, signature] = token.split(".");
  for (const value of [
    "",
    "x".repeat(16385),
    token + ".",
    " " + token,
    token + "=",
    header + "=." + payload + "." + signature,
    "A." + payload + "." + signature,
    Buffer.from([255]).toString("base64url") + "." + payload + "." + signature,
    header +
      "." +
      Buffer.from([0xef, 0xbb, 0xbf, 123, 125]).toString("base64url") +
      "." +
      signature,
  ])
    await deny(verifier, value);
  for (const text of [
    JSON.stringify(fixture.claims).replace('"client_id":', '"iss":"wrong","client_id":'),
    JSON.stringify(fixture.claims).replace('"sub":', '"\\u0073ub":"wrong","sub":'),
    JSON.stringify({ ...fixture.claims, metadata: { x: 1 } }).replace('"x":1', '"x":1,"x":2'),
    JSON.stringify(fixture.claims).replace('"sid":', '"bad":"\\ud800","sid":'),
    JSON.stringify(fixture.claims) + "true",
    "[]",
    "null",
  ])
    await deny(verifier, fixture.signRaw(text));
  await deny(verifier, fixture.sign({ padding: "x".repeat(12300) }));
  await deny(verifier, fixture.sign({}, { padding: "x".repeat(2100) }));
});
test("strict expiry, optional not-before and future-iat skew have exact boundaries", async () => {
  const f = buildWorkosSessionTokenFixture({
      key: {
        privateKey: fixture.privateKey,
        publicKey: fixture.publicKey,
        publicJwk: fixture.publicJwk,
        signRaw: fixture.signRaw,
      },
    }),
    verifier = make(f),
    seconds = f.now / 1000;
  for (const change of [
    { iat: seconds + 31 },
    { iat: "1" },
    { iat: -1 },
    { iat: 1.5 },
    { exp: seconds },
    { exp: seconds - 1 },
    { exp: seconds - 6 },
    { exp: seconds + 3596 },
    { iat: Number.MAX_SAFE_INTEGER },
    { nbf: seconds + 31 },
    { nbf: seconds + 120 },
    { nbf: "1" },
    { nbf: null },
  ])
    await deny(verifier, f.sign(change));
  for (const change of [
    { iat: seconds + 30, exp: seconds + 120 },
    { nbf: seconds + 30 },
    { iat: seconds - 3480, exp: seconds + 120 },
  ])
    assert.equal((await verifier.verify(f.sign(change))).outcome, "verified");
  const result = await verifier.verify(f.sign({ exp: seconds + 1 }));
  assert.equal(result.outcome, "verified");
  f.setNow(f.now + 1000);
  assert.equal(verifier.readCandidate(result.handle), null);
  await deny(verifier, f.sign({ exp: seconds + 1 }));
});
test("clock regression, invalid clocks and stale snapshots cannot revive a candidate", async () => {
  const f = buildWorkosSessionTokenFixture(),
    verifier = make(f),
    result = await verifier.verify(f.sign());
  f.setNow(f.now - 1);
  assert.equal(verifier.readCandidate(result.handle), null);
  f.setNow(f.now + 1);
  await deny(verifier, f.sign());
  for (const clock of [
    () => NaN,
    () => Infinity,
    () => -1,
    () => 1.5,
    () => {
      throw new Proxy(
        {},
        {
          get() {
            throw Error();
          },
        },
      );
    },
  ])
    assert.throws(() => make(f, clock), /WORKOS_SESSION_TOKEN_CONFIG_INVALID/);
  const g = buildWorkosSessionTokenFixture(),
    fresh = make(g),
    handle = (await fresh.verify(g.sign())).handle;
  g.setNow(g.snapshot.expiresAtMs);
  assert.equal(fresh.readCandidate(handle), null);
  await deny(fresh, g.sign());
});
test("expiry and snapshot lease are checked again after asynchronous crypto", async () => {
  for (const drift of ["token", "snapshot", "regression"]) {
    const f = buildWorkosSessionTokenFixture(),
      start = f.now;
    let calls = 0;
    const verifier = make(f, () => {
      calls++;
      return calls < 6
        ? start
        : drift === "token"
          ? start + 120000
          : drift === "snapshot"
            ? f.snapshot.expiresAtMs
            : start - 1;
    });
    await deny(verifier, f.sign());
    assert.equal(calls, 6);
  }
});
test("a microtask expiry after valid synchronous admission denies the pending crypto result", async () => {
  for (const kind of ["token", "snapshot"]) {
    const f = buildWorkosSessionTokenFixture(),
      verifier = make(f);
    const token = f.sign(kind === "snapshot" ? { exp: Math.floor(f.now / 1000) + 1800 } : {});
    const pending = verifier.verify(token);
    queueMicrotask(() => f.setNow(kind === "token" ? f.now + 120000 : f.snapshot.expiresAtMs));
    await deny({ verify: () => pending }, token);
  }
});
test("rotation handles only current snapshot keys and concurrent handles remain isolated", async () => {
  const nextKey = createWorkosSessionTokenSigningKey("synthetic-key-two"),
    f = buildWorkosSessionTokenFixture({ key: nextKey });
  const rotated = createWorkosSessionTokenVerifier(
    fixture.profileJson,
    JSON.stringify({ ...fixture.snapshot, jwks: { keys: [fixture.publicJwk, nextKey.publicJwk] } }),
    fixture.clock,
  );
  const [one, two] = await Promise.all([rotated.verify(fixture.sign()), rotated.verify(f.sign())]);
  assert.equal(one.outcome, "verified");
  assert.equal(two.outcome, "verified");
  assert.notEqual(one.handle, two.handle);
  assert.equal(rotated.readCandidate(one.handle).subjectId, fixture.claims.sub);
  const removed = createWorkosSessionTokenVerifier(fixture.profileJson, f.snapshotJson, f.clock);
  await deny(removed, fixture.sign());
  assert.equal((await removed.verify(f.sign())).outcome, "verified");
  assert.equal(removed.readCandidate(one.handle), null);
});
