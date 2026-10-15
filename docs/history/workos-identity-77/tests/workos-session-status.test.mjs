import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWorkosSessionStatusReader } from "../packages/identity/src/workos-session-status.ts";
import { parseWorkosSessionStatusJson } from "../packages/identity/src/workos-session-status-json.ts";
import {
  buildWorkosSessionStatusFixture,
  workosSessionStatusId,
} from "./fixtures/workos-session-status.mjs";

const f = buildWorkosSessionStatusFixture();
const held = { outcome: "held", handle: null };
function setup(pages = [f.page()], options = {}) {
  let now = f.at;
  let currentProfile = f.profileJson;
  const calls = [];
  const abort = new AbortController();
  const reader = createWorkosSessionStatusReader(options.profile ?? f.profileJson, {
    now: options.clock ?? (() => now),
    currentProfile: options.currentProfile ?? (() => currentProfile),
    signal: abort.signal,
    readPage: async (selectorJson, control) => {
      const selector = JSON.parse(selectorJson);
      calls.push({ selector, control });
      return options.readPage
        ? options.readPage(selectorJson, control, calls.length)
        : pages[calls.length - 1];
    },
  });
  return {
    reader,
    calls,
    abort,
    setNow: (value) => (now = value),
    setProfile: (value) => (currentProfile = value),
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
    traps: () => traps,
  };
}
async function denies(pages, query = f.queryJson, options = {}) {
  const s = setup(pages, options);
  assert.deepEqual(await s.reader.observe(query), held);
  return s;
}

test("complete active catalogue produces only a private expected-client observation", async () => {
  const s = setup([
    f.page([
      f.session({
        ip_address: "192.0.2.1",
        user_agent: "private synthetic browser",
        auth_method: "sso",
        organization_id: workosSessionStatusId("org", 8),
      }),
    ]),
  ]);
  const result = await s.reader.observe(f.queryJson);
  assert.equal(result.outcome, "observed_active");
  const observation = s.reader.readObservation(result.handle);
  assert.deepEqual(observation, {
    providerId: "workos",
    environmentId: f.profile.environmentId,
    expectedApplicationId: f.profile.applicationId,
    expectedClientId: f.profile.clientId,
    clientBinding: "expected_only",
    subjectId: f.query.subjectId,
    providerSessionId: f.query.providerSessionId,
    outcome: "observed_active",
    observedAtMs: f.at,
    expiresAtMs: f.at + 5000,
    profileRevision: 1,
    profileDigest: createHash("sha256").update(f.profileJson).digest("hex"),
    pageCount: 1,
    itemCount: 1,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.handle));
  assert.ok(Object.isFrozen(observation));
  assert.equal(JSON.stringify(result.handle), "{}");
  assert.ok(!JSON.stringify(observation).includes("private synthetic"));
  assert.ok(!JSON.stringify(observation).includes("organization_id"));
  assert.ok(!JSON.stringify(observation).includes("actor"));
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].selector, {
    schemaVersion: 1,
    subjectId: f.query.subjectId,
    after: null,
    limit: 100,
    order: "asc",
  });
  assert.equal(s.calls[0].control.deadlineMs, f.at + 10000);
  assert.equal(s.calls[0].control.signal.aborted, true);
});
test("complete absence is not_observed_active, never a specific revoked or expired claim", async () => {
  for (const pages of [
    [f.page()],
    [f.page([f.session({ id: workosSessionStatusId("session", 9) })])],
  ]) {
    const s = setup(pages);
    const result = await s.reader.observe(f.queryJson);
    assert.equal(result.outcome, "not_observed_active");
    assert.equal(s.reader.readObservation(result.handle).outcome, "not_observed_active");
  }
});
test("full pagination remains mandatory after an early match and supports exactly four complete pages", async () => {
  const ids = [10, 11, 12, 13].map((n) => workosSessionStatusId("session", n));
  const pages = [f.page([f.session()], ids[0])];
  for (let i = 1; i < 4; i++)
    pages.push(f.page([f.session({ id: ids[i] })], i === 3 ? null : ids[i]));
  const s = setup(pages);
  const result = await s.reader.observe(f.queryJson);
  assert.equal(result.outcome, "observed_active");
  assert.equal(s.calls.length, 4);
  assert.equal(s.reader.readObservation(result.handle).pageCount, 4);
  assert.equal(s.reader.readObservation(result.handle).itemCount, 4);
  assert.deepEqual(
    s.calls.map((c) => c.selector.after),
    [null, ids[0], ids[1], ids[2]],
  );
  const incomplete = [...pages];
  incomplete[3] = f.page([f.session({ id: ids[3] })], workosSessionStatusId("session", 14));
  const denied = await denies(incomplete);
  assert.equal(denied.calls.length, 4);
  await denies([pages[0], "malformed"]);
});
test("objects, proxies, boxed strings and errors cross no reflective data boundary", async () => {
  const h = hostile();
  const s = setup();
  for (const value of [h.value, {}, [], new String(f.queryJson), null, undefined, 7])
    assert.deepEqual(await s.reader.observe(value), held);
  assert.equal(s.calls.length, 0);
  for (const value of [h.value, {}, [], null]) {
    assert.throws(
      () => createWorkosSessionStatusReader(value, {}),
      /WORKOS_SESSION_STATUS_CONFIG_INVALID/,
    );
  }
  let accessorReads = 0;
  const accessor = {
    get data() {
      accessorReads++;
      throw Error();
    },
  };
  for (const value of [accessor, {}, [], null, new String(f.page())]) await denies([value]);
  assert.equal(accessorReads, 0);
  // A rejected reason is never reflected. Resolving a Promise to a Proxy would
  // itself invoke its `then` trap inside the fixture, before the reader boundary.
  await denies([], f.queryJson, {
    readPage: async () => {
      throw h.value;
    },
  });
  assert.equal(s.reader.readObservation(h.value), null);
  assert.equal(h.traps(), 0);
});
test("closed owner profile and closed query bind exact scalar identifiers and revision", async () => {
  for (const change of [
    { schemaVersion: 2 },
    { providerId: "other" },
    { revision: 0 },
    { revision: 1.5 },
    { environmentId: "bad" },
    { applicationId: "bad" },
    { clientId: "bad" },
    { issuer: "https://foreign.example" },
  ])
    assert.throws(
      () => setup([], { profile: JSON.stringify({ ...f.profile, ...change }) }),
      /CONFIG_INVALID/,
    );
  for (const change of [
    { schemaVersion: 2 },
    { subjectId: "bad" },
    { providerSessionId: "bad" },
    { clientId: f.profile.clientId },
    { sessionId: f.query.providerSessionId },
    { subjectId: f.query.subjectId + "/sessions?after=foreign" },
  ]) {
    const s = await denies([], JSON.stringify({ ...f.query, ...change }));
    assert.equal(s.calls.length, 0);
  }
  const missing = { ...f.profile };
  delete missing.clientId;
  assert.throws(() => setup([], { profile: JSON.stringify(missing) }), /CONFIG_INVALID/);
});
test("strict JSON rejects duplicate escaped keys, malformed UTF16, grammar and nesting", async () => {
  for (const raw of [
    '{"a":1,"\\u0061":2}',
    '{"a":{"b":1,"b":2}}',
    '{"a":"\\ud800"}',
    '"\ud800"',
    '{"a":NaN}',
    '{"a":Infinity}',
    '{"a":1,}',
    "[1,]",
    "true false",
    "\ufeff{}",
    "[".repeat(34) + "0" + "]".repeat(34),
  ])
    assert.throws(() => parseWorkosSessionStatusJson(raw, 131072), /JSON_INVALID/);
  for (const [raw, limit] of [
    ['"é"', 3],
    [" ".repeat(4097), 4096],
  ])
    assert.throws(() => parseWorkosSessionStatusJson(raw, limit), /JSON_INVALID/);
  const page = f.page([f.session()]);
  await denies([page.replace('"status":"active"', '"status":"active","\\u0073tatus":"active"')]);
  await denies([], f.queryJson.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
});
test("page and row shapes reject omissions, foreign fields, non-active state and termination", async () => {
  const changes = [
    { object: "other" },
    { id: "bad" },
    { user_id: workosSessionStatusId("user", 999) },
    { status: "revoked" },
    { status: "expired" },
    { ended_at: new Date(f.at - 1).toISOString() },
    { client_id: f.profile.clientId },
    { expires_at: null },
    { user_agent: {} },
    { organization_id: "bad" },
    { impersonator: { email: "x", reason: "synthetic" } },
    { impersonator: {} },
    { ip_address: "x".repeat(129) },
  ];
  for (const change of changes) await denies([f.page([f.session(change)])]);
  for (const field of [
    "id",
    "status",
    "user_id",
    "expires_at",
    "ended_at",
    "created_at",
    "updated_at",
  ]) {
    const row = f.session();
    delete row[field];
    await denies([f.page([row])]);
  }
  for (const page of [
    { object: "list", data: [], list_metadata: { after: null } },
    { object: "list", data: {}, list_metadata: { before: null, after: null } },
    { object: "list", data: [], list_metadata: { before: null, after: null }, unknown: true },
    { object: "list", data: [], list_metadata: { before: "bad", after: null } },
  ])
    await denies([JSON.stringify(page)]);
});
test("contradictory or invalid timestamps hold and the target expiry caps the lease", async () => {
  for (const change of [
    { expires_at: new Date(f.at).toISOString() },
    { expires_at: new Date(f.at - 1).toISOString() },
    { created_at: new Date(f.at + 1).toISOString() },
    { updated_at: new Date(f.at + 1).toISOString() },
    { updated_at: new Date(f.at - 61000).toISOString() },
    { expires_at: "2026-02-31T00:00:00.000Z" },
    { expires_at: "2027-01-01T00:00:00+00:00" },
    { created_at: 1 },
  ])
    await denies([f.page([f.session(change)])]);
  const s = setup([f.page([f.session({ expires_at: new Date(f.at + 1000).toISOString() })])]);
  const result = await s.reader.observe(f.queryJson);
  assert.equal(result.outcome, "observed_active");
  assert.equal(s.reader.readObservation(result.handle).expiresAtMs, f.at + 1000);
  s.setNow(f.at + 1000);
  assert.equal(s.reader.readObservation(result.handle), null);
});
test("pagination denies duplicate sessions, cycles, empty continuation and invalid cursors", async () => {
  const a = workosSessionStatusId("session", 50),
    b = workosSessionStatusId("session", 51);
  for (const pages of [
    [f.page([f.session(), f.session()])],
    [f.page([f.session()], a), f.page([f.session()])],
    [f.page([f.session()], a), f.page([f.session({ id: b })], a)],
    [f.page([], a)],
    [f.page([f.session()], "foreign")],
    [f.page([f.session()], a), f.page([], b)],
  ])
    await denies(pages);
});
test("item and UTF8-byte caps hold before an oversized catalogue can produce a handle", async () => {
  const rows = Array.from({ length: 101 }, (_, i) =>
    f.session({ id: workosSessionStatusId("session", i + 100) }),
  );
  await denies([f.page(rows)]);
  const valid = f.page([f.session()]);
  await denies([valid + " ".repeat(131073 - valid.length)]);
  const s = setup([f.page(rows.slice(0, 100))]);
  assert.equal((await s.reader.observe(f.queryJson)).outcome, "not_observed_active");
  // ASCII character count alone cannot satisfy the UTF8 cap.
  await denies([f.page([f.session({ user_agent: "é".repeat(4096) })]) + " ".repeat(123500)]);
});
test("profile drift after an awaited page holds without another page or exported data", async () => {
  let s;
  s = setup([], {
    readPage: async () => {
      s.setProfile(f.profileJson + " ");
      return f.page([f.session()]);
    },
  });
  assert.deepEqual(await s.reader.observe(f.queryJson), held);
  assert.equal(s.calls.length, 1);
  const h = hostile();
  const bad = setup([], { currentProfile: () => h.value });
  assert.deepEqual(await bad.reader.observe(f.queryJson), held);
  assert.equal(bad.calls.length, 0);
  assert.equal(h.traps(), 0);
});
test("clock bounds, regression and post-await expiry hold and never reset a failed clock", async () => {
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, {}]) {
    const s = setup([], { clock: () => value });
    assert.deepEqual(await s.reader.observe(f.queryJson), held);
    assert.equal(s.calls.length, 0);
  }
  for (const elapsed of [5000, 10000]) {
    let s;
    s = setup([], {
      readPage: async () => {
        s.setNow(f.at + elapsed);
        return f.page([f.session()]);
      },
    });
    assert.deepEqual(await s.reader.observe(f.queryJson), held);
  }
  const s = setup();
  const result = await s.reader.observe(f.queryJson);
  s.setNow(f.at - 1);
  assert.equal(s.reader.readObservation(result.handle), null);
  s.setNow(f.at);
  assert.deepEqual(await s.reader.observe(f.queryJson), held);
});
test("expired, changed-profile, forged and foreign handles expose no observation", async () => {
  const s = setup();
  const result = await s.reader.observe(f.queryJson);
  for (const value of [null, undefined, {}, [], JSON.parse(JSON.stringify(result.handle)), 1, "{}"])
    assert.equal(s.reader.readObservation(value), null);
  assert.equal(setup().reader.readObservation(result.handle), null);
  s.setProfile(f.profileJson + " ");
  assert.equal(s.reader.readObservation(result.handle), null);
  s.setProfile(f.profileJson);
  assert.equal(s.reader.readObservation(result.handle), null);
  assert.deepEqual(await s.reader.observe(f.queryJson), held);
  const expiring = setup();
  const result2 = await expiring.reader.observe(f.queryJson);
  expiring.setNow(f.at + 5000);
  assert.equal(expiring.reader.readObservation(result2.handle), null);
});
test("synchronous profile checks cannot extend a handle lease or lookup timer", async (t) => {
  let now = f.at;
  let expire = false;
  const s = setup([f.page([f.session()])], {
    clock: () => now,
    currentProfile: () => {
      if (expire) now = f.at + 5000;
      return f.profileJson;
    },
  });
  const result = await s.reader.observe(f.queryJson);
  assert.equal(result.outcome, "observed_active");
  expire = true;
  assert.equal(s.reader.readObservation(result.handle), null);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  now = f.at;
  let entered;
  let settle;
  const start = new Promise((resolve) => (entered = resolve));
  const nearDeadline = setup([], {
    clock: () => now,
    currentProfile: () => {
      now = f.at + 9999;
      return f.profileJson;
    },
    readPage: () => {
      entered();
      return new Promise((resolve) => (settle = resolve));
    },
  });
  const pending = nearDeadline.reader.observe(f.queryJson);
  await start;
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, held);
  assert.equal(nearDeadline.calls.length, 1);
  assert.equal(nearDeadline.calls[0].control.deadlineMs, f.at + 10000);
  settle(f.page());
});
test("cancellation interrupts a stalled reader and late settlement cannot request another page", async () => {
  let settle;
  let entered;
  const start = new Promise((resolve) => (entered = resolve));
  const s = setup([], {
    readPage: () => {
      entered();
      return new Promise((resolve) => (settle = resolve));
    },
  });
  const pending = s.reader.observe(f.queryJson);
  await start;
  s.abort.abort();
  assert.deepEqual(await pending, held);
  settle(f.page([f.session()], workosSessionStatusId("session", 1000)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
  const cancelled = setup();
  cancelled.abort.abort();
  assert.deepEqual(await cancelled.reader.observe(f.queryJson), held);
  assert.equal(cancelled.calls.length, 0);
});
test("one actual overall timer bounds a stalled reader without resetting its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  let settle;
  const start = new Promise((resolve) => (entered = resolve));
  const s = setup([], {
    readPage: () => {
      entered();
      return new Promise((resolve) => (settle = resolve));
    },
  });
  const pending = s.reader.observe(f.queryJson);
  await start;
  t.mock.timers.tick(10000);
  assert.deepEqual(await pending, held);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].control.signal.aborted, true);
  assert.equal(s.calls[0].control.deadlineMs, f.at + 10000);
  settle(f.page([f.session()], workosSessionStatusId("session", 1001)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
});
test("cancellation and query mutation after call cannot substitute another subject or retain a handle", async () => {
  let s;
  s = setup([], {
    readPage: async () => {
      s.abort.abort();
      return f.page([f.session()]);
    },
  });
  assert.deepEqual(await s.reader.observe(f.queryJson), held);
  let query = f.queryJson;
  const independent = setup([f.page([f.session()])]);
  const pending = independent.reader.observe(query);
  query = JSON.stringify({ ...f.query, subjectId: workosSessionStatusId("user", 700) });
  const result = await pending;
  assert.equal(independent.reader.readObservation(result.handle).subjectId, f.query.subjectId);
  independent.abort.abort();
  assert.equal(independent.reader.readObservation(result.handle), null);
});
test("concurrent observations retain distinct handles and exact query subject bindings", async () => {
  const other = { ...f.query, subjectId: workosSessionStatusId("user", 900) };
  const s = setup([], {
    readPage: async (selector) => {
      const query = JSON.parse(selector);
      return f.page([f.session({ user_id: query.subjectId })]);
    },
  });
  const [a, b] = await Promise.all([
    s.reader.observe(f.queryJson),
    s.reader.observe(JSON.stringify(other)),
  ]);
  assert.equal(a.outcome, "observed_active");
  assert.equal(b.outcome, "observed_active");
  assert.notEqual(a.handle, b.handle);
  assert.equal(s.reader.readObservation(a.handle).subjectId, f.query.subjectId);
  assert.equal(s.reader.readObservation(b.handle).subjectId, other.subjectId);
});
