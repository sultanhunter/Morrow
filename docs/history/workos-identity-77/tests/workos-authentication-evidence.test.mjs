import assert from "node:assert/strict";
import test from "node:test";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import {
  buildWorkosAuthenticationEvidenceFixture,
  workosAuthenticationEvidenceId as id,
  workosAuthenticationEvidenceSha256 as sha,
} from "./fixtures/workos-authentication-evidence.mjs";

const held = { outcome: "held", handle: null };
function setup(options = {}) {
  const f = options.fixture ?? buildWorkosAuthenticationEvidenceFixture();
  let now = f.at;
  let profile = f.profileJson;
  const signal = new AbortController();
  const calls = [];
  const service = createWorkosAuthenticationEvidence(
    options.profileJson ?? f.profileJson,
    options.snapshotJson ?? f.snapshotJson,
    {
      now: options.clock ?? (() => now),
      currentProfile: options.currentProfile ?? (() => profile),
      signal: signal.signal,
      readPage: async (selectorJson, control) => {
        calls.push({ selector: JSON.parse(selectorJson), control });
        return options.readPage
          ? options.readPage(selectorJson, control, calls.length)
          : (options.pages ?? [f.page()])[calls.length - 1];
      },
    },
  );
  return {
    f,
    service,
    calls,
    signal,
    setNow: (value) => {
      now = value;
    },
    setProfile: (value) => {
      profile = value;
    },
  };
}
function hostile() {
  let traps = 0;
  return {
    value: new Proxy(
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
    ),
    count: () => traps,
  };
}
test("native RSA plus complete active catalogue creates only private bound evidence", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture({
    claims: {
      org_id: id("org", 20),
      role: "owner",
      permissions: ["all"],
      email: "private@example.invalid",
    },
  });
  const s = setup({
    fixture: f,
    pages: [
      f.page([
        f.session({
          ip_address: "192.0.2.9",
          user_agent: "private synthetic agent",
          auth_method: "sso",
        }),
      ]),
    ],
  });
  const result = await s.service.verify(f.token);
  assert.equal(result.outcome, "verified_active_evidence");
  assert.deepEqual(Object.keys(result), ["outcome", "handle"]);
  assert.equal(JSON.stringify(result.handle), "{}");
  const fact = s.service.readEvidence(result.handle);
  assert.deepEqual(fact, {
    providerId: "workos",
    environmentId: f.profile.environmentId,
    applicationId: f.profile.applicationId,
    clientId: f.profile.clientId,
    issuer: f.profile.issuer,
    subjectId: f.claims.sub,
    providerSessionId: f.claims.sid,
    tokenProvenance: "signature_verified",
    sessionClientBinding: "expected_only",
    sessionLiveness: "not_guaranteed",
    issuedAtMs: f.claims.iat * 1000,
    observedAtMs: f.at,
    expiresAtMs: f.at + 5000,
    tokenProfileRevision: 1,
    tokenProfileDigest: sha(f.profileJson),
    keySetDigest: sha(f.snapshotJson),
    observationProfileDigest: sha(f.observationProfileJson),
  });
  assert.notEqual(fact.tokenProfileDigest, fact.observationProfileDigest);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.handle));
  assert.ok(Object.isFrozen(fact));
  const publicResult = JSON.stringify(result),
    privateFact = JSON.stringify(fact);
  for (const value of [
    f.token,
    "private@example",
    "private synthetic",
    "192.0.2.",
    id("org", 20),
    '"role"',
    '"permissions"',
    '"principal"',
    '"ActorRef"',
    '"membership"',
    '"cookie"',
  ]) {
    assert.equal(publicResult.includes(value), false);
    assert.equal(privateFact.includes(value), false);
  }
  assert.deepEqual(s.calls[0].selector, {
    schemaVersion: 1,
    subjectId: f.claims.sub,
    after: null,
    limit: 100,
    order: "asc",
  });
  assert.equal(s.calls[0].control.deadlineMs, f.at + 10000);
});
test("wrong signature, issuer, client and invalid human token produce zero page reads", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  const forged = f.token.slice(0, f.token.lastIndexOf(".") + 1) + "A".repeat(342);
  for (const token of [
    forged,
    "bad",
    f.sign({ iss: "https://foreign.invalid" }),
    f.sign({ client_id: id("client", 99) }),
    f.sign({ aud: "api" }),
    f.sign({ sid: undefined }),
    f.sign({ sub: undefined }),
    f.sign({ sid: "session_bad" }),
    f.sign({ sub: "user_bad" }),
    f.sign({ act: { sub: "admin" } }),
    f.sign({ gty: "client_credentials" }),
    f.sign({ exp: f.at / 1000 }),
    f.sign({}, { alg: "none" }),
  ]) {
    const s = setup({ fixture: f });
    assert.deepEqual(await s.service.verify(token), held);
    assert.equal(s.calls.length, 0);
  }
});
test("primitive data gates and WeakMap lookups never reflect hostile objects", async () => {
  const h = hostile(),
    s = setup();
  const accessor = {
    get token() {
      throw Error("private accessor");
    },
  };
  for (const value of [h.value, accessor, {}, [], new String(s.f.token), null, undefined, 1]) {
    assert.deepEqual(await s.service.verify(value), held);
    assert.equal(s.service.readEvidence(value), null);
  }
  for (const value of [h.value, {}, [], null, new String(s.f.profileJson)]) {
    assert.throws(
      () => createWorkosAuthenticationEvidence(value, s.f.snapshotJson, {}),
      /^Error: WORKOS_AUTHENTICATION_EVIDENCE_CONFIG_INVALID$/,
    );
    assert.throws(
      () => createWorkosAuthenticationEvidence(s.f.profileJson, value, {}),
      /^Error: WORKOS_AUTHENTICATION_EVIDENCE_CONFIG_INVALID$/,
    );
  }
  assert.equal(h.count(), 0);
  assert.equal(s.calls.length, 0);
});
test("wrong profile, keyset namespace and duplicate JSON reject at construction", () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  for (const profileJson of [
    JSON.stringify({ ...f.profile, applicationId: "bad" }),
    JSON.stringify({ ...f.profile, extra: true }),
    f.profileJson.replace('"revision":1', '"revision":1,"\\u0072evision":1'),
  ]) {
    assert.throws(() => setup({ fixture: f, profileJson }), /CONFIG_INVALID/);
  }
  for (const change of [
    { environmentId: id("environment", 99) },
    { applicationId: id("app", 99) },
    { clientId: id("client", 99) },
    { profileRevision: 2 },
    { expiresAtMs: f.at },
  ]) {
    assert.throws(
      () => setup({ fixture: f, snapshotJson: JSON.stringify({ ...f.snapshot, ...change }) }),
      /CONFIG_INVALID/,
    );
  }
});
test("only the signed user/session tuple selects a complete positive observation", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  for (const rows of [
    [],
    [f.session({ id: id("session", 90) })],
    [f.session({ user_id: id("user", 90) })],
    [f.session({ status: "revoked" })],
    [f.session({ client_id: f.profile.clientId })],
  ]) {
    const s = setup({ fixture: f, pages: [f.page(rows)] });
    assert.deepEqual(await s.service.verify(f.token), held);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].selector.subjectId, f.claims.sub);
  }
});
test("an early active match cannot bypass malformed, duplicate or incomplete later pages", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture(),
    cursor = id("session", 10);
  for (const pages of [
    [f.page([f.session()], cursor), "bad"],
    [f.page([f.session()], cursor), f.page([f.session()])],
    [f.page([f.session()], cursor), f.page([], id("session", 11))],
    [f.page([f.session()], cursor), f.page([f.session({ id: id("session", 11) })], cursor)],
    [
      f.page([f.session()], cursor),
      f.page([f.session({ id: id("session", 11) })], id("session", 12)),
      f.page([f.session({ id: id("session", 12) })], id("session", 13)),
      f.page([f.session({ id: id("session", 13) })], id("session", 14)),
    ],
  ]) {
    const s = setup({ fixture: f, pages });
    assert.deepEqual(await s.service.verify(f.token), held);
    assert.ok(s.calls.length >= 2 && s.calls.length <= 4);
    for (const call of s.calls) assert.equal(call.control.deadlineMs, f.at + 10000);
  }
});
test("exact four complete pages retain frozen reader bounds and original attempt deadline", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  const pages = [f.page([f.session()], id("session", 11))];
  for (let n = 11; n <= 13; n++)
    pages.push(
      f.page([f.session({ id: id("session", n) })], n === 13 ? null : id("session", n + 1)),
    );
  const s = setup({ fixture: f, pages });
  const result = await s.service.verify(f.token);
  assert.equal(result.outcome, "verified_active_evidence");
  assert.equal(s.calls.length, 4);
  assert.ok(s.service.readEvidence(result.handle));
  assert.ok(s.calls.every((call) => call.control.deadlineMs === f.at + 10000));
});
test("token and keyset expiry while cryptography is pending prevent every page read", async () => {
  for (const kind of ["token", "keyset"]) {
    const f = buildWorkosAuthenticationEvidenceFixture(
      kind === "token"
        ? { claims: { exp: 1800000001 } }
        : { snapshot: { expiresAtMs: 1800000000001 } },
    );
    const s = setup({ fixture: f });
    const pending = s.service.verify(f.token);
    queueMicrotask(() => s.setNow(f.at + (kind === "token" ? 1000 : 1)));
    assert.deepEqual(await pending, held);
    assert.equal(s.calls.length, 0);
  }
});
test("token, keyset and observation expiry during catalogue work cannot emit evidence", async () => {
  for (const kind of ["token", "keyset", "observation"]) {
    const f = buildWorkosAuthenticationEvidenceFixture(
      kind === "token"
        ? { claims: { exp: 1800000001 } }
        : kind === "keyset"
          ? { snapshot: { expiresAtMs: 1800000000001 } }
          : {},
    );
    let s;
    s = setup({
      fixture: f,
      readPage: async () => {
        s.setNow(f.at + (kind === "token" ? 1000 : kind === "keyset" ? 1 : 5000));
        return f.page();
      },
    });
    assert.deepEqual(await s.service.verify(f.token), held);
    assert.equal(s.calls.length, 1);
  }
});
test("retained evidence expires at the earliest token, keyset or session observation bound", async () => {
  for (const kind of ["token", "keyset", "session"]) {
    const f = buildWorkosAuthenticationEvidenceFixture(
      kind === "token"
        ? { claims: { exp: 1800000002 } }
        : kind === "keyset"
          ? { snapshot: { expiresAtMs: 1800000002000 } }
          : {},
    );
    const s = setup({
      fixture: f,
      pages: [
        f.page([
          f.session({
            expires_at: new Date(f.at + (kind === "session" ? 2000 : 60000)).toISOString(),
          }),
        ]),
      ],
    });
    const result = await s.service.verify(f.token);
    assert.equal(result.outcome, "verified_active_evidence");
    assert.equal(s.service.readEvidence(result.handle).expiresAtMs, f.at + 2000);
    s.setNow(f.at + 2000);
    assert.equal(s.service.readEvidence(result.handle), null);
  }
});
test("synchronous source checks consume lease time and restored profile never revives evidence", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  let now = f.at,
    expire = false;
  const s = setup({
    fixture: f,
    clock: () => now,
    currentProfile: () => {
      if (expire) now = f.at + 5000;
      return f.profileJson;
    },
  });
  const valid = await s.service.verify(f.token);
  assert.ok(s.service.readEvidence(valid.handle));
  expire = true;
  assert.equal(s.service.readEvidence(valid.handle), null);
  const g = setup({ fixture: f });
  const previous = await g.service.verify(f.token);
  g.setProfile(JSON.stringify({ ...f.profile, revision: 2 }));
  assert.equal(g.service.readEvidence(previous.handle), null);
  g.setProfile(f.profileJson);
  assert.equal(g.service.readEvidence(previous.handle), null);
  assert.deepEqual(await g.service.verify(f.token), held);
});
test("profile drift even on a rejected page latches without reading arbitrary error properties", async () => {
  const h = hostile();
  let drift = false,
    s;
  s = setup({
    readPage: async () => {
      if (drift) {
        s.setProfile("changed");
        throw h.value;
      }
      return s.f.page();
    },
  });
  const first = await s.service.verify(s.f.token);
  assert.ok(s.service.readEvidence(first.handle));
  drift = true;
  assert.deepEqual(await s.service.verify(s.f.token), held);
  s.setProfile(s.f.profileJson);
  assert.equal(s.service.readEvidence(first.handle), null);
  assert.equal(h.count(), 0);
});
test("bad or regressed clock and global cancellation invalidate all old handles permanently", async () => {
  for (const value of [-1, NaN, Infinity, 1.5, 8640000000000001]) {
    const s = setup(),
      valid = await s.service.verify(buildWorkosAuthenticationEvidenceFixture().token);
    assert.equal(valid.outcome, "verified_active_evidence");
    s.setNow(value);
    assert.equal(s.service.readEvidence(valid.handle), null);
    s.setNow(s.f.at);
    assert.deepEqual(await s.service.verify(s.f.token), held);
  }
  const s = setup(),
    result = await s.service.verify(s.f.token);
  s.setNow(s.f.at - 1);
  assert.equal(s.service.readEvidence(result.handle), null);
  s.setNow(s.f.at);
  assert.deepEqual(await s.service.verify(s.f.token), held);
  const g = setup(),
    previous = await g.service.verify(g.f.token);
  g.signal.abort();
  assert.equal(g.service.readEvidence(previous.handle), null);
  assert.deepEqual(await g.service.verify(g.f.token), held);
});
test("one overall10s timer caps crypto plus pages and timeout cannot poison another attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered,
    settle,
    stall = false;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const s = setup({
    readPage: async () => {
      if (!stall) return s.f.page();
      entered();
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  const previous = await s.service.verify(s.f.token);
  stall = true;
  const pending = s.service.verify(s.f.token);
  await started;
  t.mock.timers.tick(9999);
  assert.equal(s.calls.at(-1).control.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, held);
  assert.equal(s.calls.at(-1).control.signal.aborted, true);
  assert.ok(s.service.readEvidence(previous.handle));
  settle(s.f.page());
  await new Promise((resolve) => setImmediate(resolve));
  stall = false;
  const next = await s.service.verify(s.f.token);
  assert.equal(next.outcome, "verified_active_evidence");
  assert.ok(s.service.readEvidence(next.handle));
});
test("synchronous source verification consumes the original10s budget before a stalled page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = buildWorkosAuthenticationEvidenceFixture();
  let now = f.at,
    advance = false,
    entered,
    settle;
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  const s = setup({
    fixture: f,
    clock: () => now,
    currentProfile: () => {
      if (advance) now = f.at + 9999;
      return f.profileJson;
    },
    readPage: async () => {
      entered();
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  advance = true;
  const pending = s.service.verify(f.token);
  await start;
  assert.equal(s.calls[0].control.deadlineMs, f.at + 10000);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, held);
  assert.equal(s.calls[0].control.signal.aborted, true);
  settle(f.page());
});
test("time spent in cryptography caps page deadline without aborting successful handle lease", async () => {
  const s = setup();
  const pending = s.service.verify(s.f.token);
  queueMicrotask(() => s.setNow(s.f.at + 8000));
  const result = await pending;
  assert.equal(result.outcome, "verified_active_evidence");
  assert.equal(s.calls[0].control.deadlineMs, s.f.at + 10000);
  assert.equal(s.service.readEvidence(result.handle).observedAtMs, s.f.at + 8000);
  assert.equal(s.service.readEvidence(result.handle).expiresAtMs, s.f.at + 13000);
  s.setNow(s.f.at + 11000);
  assert.ok(s.service.readEvidence(result.handle));
  s.setNow(s.f.at + 13000);
  assert.equal(s.service.readEvidence(result.handle), null);
});
test("global cancellation interrupts a pending read and late settlement cannot continue", async () => {
  let entered, settle;
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  const s = setup({
    readPage: async () => {
      entered();
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  const pending = s.service.verify(s.f.token);
  await start;
  s.signal.abort();
  assert.deepEqual(await pending, held);
  settle(s.f.page([s.f.session()], id("session", 11)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
});
test("concurrent signed tuples keep their own readers, results and opaque handle namespaces", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  let entered, settle;
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  const secondUser = id("user", 40),
    secondSid = id("session", 50);
  const s = setup({
    fixture: f,
    readPage: async (selectorJson) => {
      const selector = JSON.parse(selectorJson);
      if (selector.subjectId === f.claims.sub) {
        entered();
        return new Promise((resolve) => {
          settle = resolve;
        });
      }
      return f.page([f.session({ id: secondSid, user_id: secondUser })]);
    },
  });
  const first = s.service.verify(f.token);
  await start;
  const second = await s.service.verify(f.sign({ sub: secondUser, sid: secondSid }));
  assert.equal(second.outcome, "verified_active_evidence");
  settle(f.page());
  const original = await first;
  assert.equal(original.outcome, "verified_active_evidence");
  assert.notEqual(original.handle, second.handle);
  assert.equal(s.service.readEvidence(original.handle).subjectId, f.claims.sub);
  assert.equal(s.service.readEvidence(second.handle).subjectId, secondUser);
  assert.equal(s.service.readEvidence(second.handle).providerSessionId, secondSid);
  const other = setup({ fixture: f });
  assert.equal(other.service.readEvidence(original.handle), null);
  for (const forged of [
    {},
    JSON.parse(JSON.stringify(original.handle)),
    s.service.readEvidence(original.handle),
    f.token,
    null,
  ])
    assert.equal(s.service.readEvidence(forged), null);
});
