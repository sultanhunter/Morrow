import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createWorkosBrowserSessionAdmission,
  browserSessionAdmissionSql as sql,
} from "../packages/identity/src/workos-browser-session-admission.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "./fixtures/workos-authentication-evidence.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const selector = (changes = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    commandId: "234fde9e-33af-4894-80c1-d36d296eaf57",
    workspaceId: "workspace_A",
    profileId: "profile_A",
    profileRecordRevision: 2,
    mappingId: "mapping_A",
    mappingRevision: 3,
    bindingRevision: 4,
    membershipId: "membership_A",
    policyRevision: 5,
    ...changes,
  });
const role = (changes = {}) => ({
  role: "morrow_identity_sessions",
  login: "morrow_identity_sessions",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
  ...changes,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function setup(options = {}) {
  const f = buildWorkosAuthenticationEvidenceFixture(options.fixture);
  let now = f.at,
    profile = f.profileJson;
  const owner = createWorkosAuthenticationEvidence(f.profileJson, f.snapshotJson, {
    now: () => now,
    currentProfile: () => profile,
    readPage: async () => f.page(),
  });
  const proof = await owner.verify(f.token);
  assert.equal(proof.outcome, "verified_active_evidence");
  const cancel = new AbortController(),
    calls = [],
    releases = [],
    controls = [];
  let connects = 0,
    readCount = 0;
  const state = {
    f,
    owner,
    proof,
    cancel,
    calls,
    releases,
    controls,
    setNow: (v) => {
      now = v;
    },
    setProfile: (v) => {
      profile = v;
    },
    get now() {
      return now;
    },
    get connects() {
      return connects;
    },
  };
  const client = {
    async query(text, values, control) {
      const stage = Object.entries(sql).find(([, v]) => v === text)?.[0];
      assert.ok(stage);
      const call = { stage, text, values };
      calls.push(call);
      controls.push(control);
      await options.before?.(stage, state, call);
      let rows = [];
      if (stage === "role") rows = [role()];
      if (stage === "admit")
        rows = [
          {
            outcome: options.outcome ?? "newly_admitted",
            family_id: values[25],
            generation_id: values[26],
            provider_binding_id: "75bab6b6-b707-4f39-9283-a5675ca10977",
            expires_at_ms: String(now + 900000),
            audit_id: "918b5e2b-76e0-4344-be82-88b19e991714",
          },
        ];
      if (stage === "reconcile")
        rows = [
          {
            outcome: "replayed",
            family_id: "f3cf3613-51ea-44c6-b04a-e1d46959c7ec",
            generation_id: "c6fe8466-d468-412a-a06a-9fdcde45b239",
            provider_binding_id: "75bab6b6-b707-4f39-9283-a5675ca10977",
            expires_at_ms: String(now - 1),
            audit_id: "918b5e2b-76e0-4344-be82-88b19e991714",
          },
        ];
      const standard = { rows };
      return options.result ? options.result(stage, standard, state, call) : standard;
    },
    async release(discard) {
      releases.push(discard);
      await options.before?.("release", state);
      await options.release?.(state);
    },
  };
  const pool = {
    async connect(control) {
      connects++;
      controls.push(control);
      await options.before?.("connect", state);
      return options.connect ? options.connect(client, state) : client;
    },
  };
  const service = createWorkosBrowserSessionAdmission({
    pool,
    now: () => now,
    signal: cancel.signal,
    readEvidence: (handle) => {
      options.onEvidence?.(++readCount, state);
      return owner.readEvidence(handle);
    },
  });
  return { ...state, service, client, connects: () => connects, readCount: () => readCount };
}
const isHeld = (r) => {
  assert.equal(r.outcome, "held");
  assert.equal(r.credential, null);
  assert.ok(Object.isFrozen(r));
};

test("own76 evidence yields a private256bit secret only afterCOMMIT and awaiteddiscard; exact27parameter/digest oracle", async () => {
  const s = await setup();
  const r = await s.service.admit(s.proof.handle, selector());
  assert.equal(r.outcome, "newly_admitted");
  assert.equal(r.credential.secret.length, 43);
  assert.equal(Buffer.from(r.credential.secret, "base64url").length, 32);
  assert.ok(Object.isFrozen(r.credential));
  assert.deepEqual(
    s.calls.map((c) => c.stage),
    ["begin", "role", "timeout", "idleTimeout", "admit", "commit"],
  );
  assert.deepEqual(s.releases, [true]);
  const values = s.calls.find((c) => c.stage === "admit").values;
  assert.equal(values.length, 27);
  assert.ok(Object.isFrozen(values));
  assert.equal(values[17], hash(r.credential.secret));
  assert.equal(values[1], hash(JSON.stringify(values.filter((_v, i) => i !== 1))));
  assert.equal(r.correlation.requestDigest, values[1]);
  assert.deepEqual(values.slice(2, 17), [
    "workos",
    s.f.profile.environmentId,
    s.f.profile.applicationId,
    s.f.profile.clientId,
    s.f.profile.issuer,
    "1",
    hash(s.f.profileJson),
    s.f.claims.sub,
    s.f.claims.sid,
    "workspace_A",
    String(s.f.claims.iat * 1000),
    String(s.f.at),
    String(s.f.at + 5000),
    hash(s.f.snapshotJson),
    hash(s.f.observationProfileJson),
  ]);
  assert.deepEqual(values.slice(18, 25), [
    "profile_A",
    "2",
    "mapping_A",
    "3",
    "4",
    "membership_A",
    "5",
  ]);
  assert.equal(values[25], r.credential.familyId);
  assert.equal(values[26], r.credential.generationId);
  assert.notEqual(values[25], values[26]);
  assert.equal(r.credential.expiresAtMs, s.f.at + 900000);
  for (const c of s.controls) {
    assert.ok(Object.isFrozen(c));
    assert.equal(c.deadlineMs, s.f.at + 5000);
    assert.ok(c.signal instanceof AbortSignal);
  }
  assert.equal(JSON.stringify(s.calls).includes(r.credential.secret), false);
  assert.equal(JSON.stringify(r).includes(s.f.token), false);
});
test("samecommand consumes once perinstance; independentcommands generate independent families and secrets", async () => {
  const s = await setup();
  const first = s.service.admit(s.proof.handle, selector());
  const duplicate = await s.service.admit(s.proof.handle, selector());
  isHeld(duplicate);
  const a = await first;
  assert.equal(a.outcome, "newly_admitted");
  isHeld(await s.service.admit(s.proof.handle, selector()));
  assert.equal(s.connects(), 1);
  const b = await s.service.admit(s.proof.handle, selector({ commandId: randomUUID() }));
  assert.equal(b.outcome, "newly_admitted");
  assert.notEqual(a.credential.secret, b.credential.secret);
  assert.notEqual(a.credential.familyId, b.credential.familyId);
});
test("primitive selector denies objects/proxies/accessors, duplicates, extra fields and invalid revisions beforeSQL", async () => {
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
  for (const value of [
    hostile,
    {},
    "{}",
    selector({ schemaVersion: 2 }),
    selector({ policyRevision: 0 }),
    selector({ mappingRevision: 1.1 }),
    selector({ profileRecordRevision: Number.MAX_SAFE_INTEGER + 1 }),
    selector({ commandId: "not-uuid" }),
    selector({ workspaceId: "../foreign" }),
    selector({ credential: "forbidden" }),
    selector().replace('"workspaceId"', '"commandId"'),
    " ".repeat(2049),
  ]) {
    const s = await setup();
    isHeld(await s.service.admit(s.proof.handle, value));
    assert.equal(s.connects(), 0);
  }
  assert.equal(traps, 0);
});
test("forged foreign serialized and expired handles never acquireSQL", async () => {
  const s = await setup(),
    foreign = await setup();
  for (const handle of [
    {},
    JSON.stringify(s.owner.readEvidence(s.proof.handle)),
    foreign.proof.handle,
    null,
  ]) {
    isHeld(await s.service.admit(handle, selector({ commandId: randomUUID() })));
    assert.equal(s.connects(), 0);
  }
  s.setNow(s.f.at + 5000);
  isHeld(await s.service.admit(s.proof.handle, selector()));
  assert.equal(s.connects(), 0);
});
test("safe executor and both membership directions are mandatory", async () => {
  for (const change of [
    { role: "morrow_api" },
    { login: "morrow_identity_owner" },
    ...[
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
      "rolinherit",
      "owner_member",
      "role_member",
    ].map((k) => ({ [k]: true })),
    // ADR-0020 (P04.T01j D5): an unknown preflight fails closed.
    { role_member: null },
  ]) {
    const s = await setup({
      result: (stage, standard) => (stage === "role" ? { rows: [role(change)] } : standard),
    });
    isHeld(await s.service.admit(s.proof.handle, selector()));
    assert.equal(
      s.calls.some((c) => c.stage === "admit"),
      false,
    );
    assert.equal(s.calls.at(-1).stage, "rollback");
    assert.deepEqual(s.releases, [true]);
  }
});
test("P05.T01y-AC30: a generation expiring 30 minutes after admission is accepted, one ms more is not", async () => {
  for (const [offset, accepted] of [
    [900000, true],
    [1800000, true],
    [1800001, false],
  ]) {
    const s = await setup({
      result: (stage, standard, state) =>
        stage === "admit"
          ? { rows: [{ ...standard.rows[0], expires_at_ms: String(state.now + offset) }] }
          : standard,
    });
    const r = await s.service.admit(s.proof.handle, selector());
    if (accepted) {
      assert.equal(r.outcome, "newly_admitted");
      assert.equal(r.credential.expiresAtMs, s.f.at + offset);
    } else isHeld(r);
  }
});
test("closed sixTEXTrow, nullable matrix, echoed IDs and exact expiry reject malformed replies", async () => {
  const changes = [
    { outcome: "unknown" },
    { outcome: "denied" },
    { outcome: "conflict" },
    { family_id: null },
    { generation_id: "foreign" },
    { provider_binding_id: "not-uuid" },
    { audit_id: null },
    { expires_at_ms: "1e12" },
    { expires_at_ms: "8640000000000001" },
    // P05.T01y-AC30: more than 30 minutes after admission.
    { expires_at_ms: "1800001800001" },
    { extra: true },
  ];
  for (const change of changes) {
    const s = await setup({
      result: (stage, standard) =>
        stage === "admit" ? { rows: [{ ...standard.rows[0], ...change }] } : standard,
    });
    isHeld(await s.service.admit(s.proof.handle, selector()));
    assert.equal(
      s.calls.some((c) => c.stage === "commit"),
      false,
    );
    assert.equal(s.calls.at(-1).stage, "rollback");
  }
  for (const outcome of ["denied", "conflict"]) {
    const s = await setup({
      result: (stage, standard) =>
        stage === "admit"
          ? {
              rows: [
                {
                  outcome,
                  family_id: null,
                  generation_id: null,
                  provider_binding_id: null,
                  expires_at_ms: null,
                  audit_id: null,
                },
              ],
            }
          : standard,
    });
    isHeld(await s.service.admit(s.proof.handle, selector()));
    assert.equal(s.calls.at(-1).stage, "commit");
  }
});
test("row/accessor and array accessors are denied without invoking getters", async () => {
  for (const mode of ["row", "array", "outer"]) {
    let getters = 0;
    const s = await setup({
      result: (stage, standard) => {
        if (stage !== "admit") return standard;
        const getter = {
          enumerable: true,
          get() {
            getters++;
            throw Error();
          },
        };
        if (mode === "row") Object.defineProperty(standard.rows[0], "family_id", getter);
        if (mode === "array") Object.defineProperty(standard.rows, "0", getter);
        if (mode === "outer") Object.defineProperty(standard, "rows", getter);
        return standard;
      },
    });
    isHeld(await s.service.admit(s.proof.handle, selector()));
    assert.equal(getters, 0);
  }
});
test("own evidence drift/expiry/cancellation around everyawait prevents delivery", async () => {
  for (const stage of [
    "connect",
    "begin",
    "role",
    "timeout",
    "idleTimeout",
    "admit",
    "commit",
    "release",
  ]) {
    const s = await setup({
      before(actual, state) {
        if (actual === stage) state.setNow(state.f.at + 5000);
      },
    });
    isHeld(await s.service.admit(s.proof.handle, selector()));
    assert.ok(s.releases.length <= 1);
  }
  const s = await setup({
    before(stage, state) {
      if (stage === "admit") state.cancel.abort();
    },
  });
  isHeld(await s.service.admit(s.proof.handle, selector()));
  assert.equal(
    s.calls.some((c) => c.stage === "commit"),
    false,
  );
});
test("unknownquery/COMMIT/release never retry/rollback after uncertainty and never yield secret", async () => {
  for (const stage of ["begin", "role", "admit", "commit", "release"]) {
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw Error();
        },
      },
    );
    const s = await setup({
      before(actual) {
        if (actual === stage) throw hostile;
      },
    });
    const r = await s.service.admit(s.proof.handle, selector());
    isHeld(r);
    assert.equal(traps, 0);
    assert.equal(
      s.calls.some((c) => c.stage === "rollback"),
      false,
    );
    assert.equal(s.releases.length, 1);
    const before = s.calls.length;
    isHeld(await s.service.admit(s.proof.handle, selector()));
    assert.equal(s.calls.length, before);
    assert.equal(r.correlation !== null, true);
  }
});
test("replay never returns a regenerated bearer and reconciliation usesREADONLYwithnoowningproof", async () => {
  const s = await setup({ outcome: "replayed" });
  isHeld(await s.service.admit(s.proof.handle, selector()));
  const r = await s.service.reconcile(
    JSON.stringify({
      schemaVersion: 1,
      commandId: "234fde9e-33af-4894-80c1-d36d296eaf57",
      requestDigest: "a".repeat(64),
    }),
  );
  assert.equal(r.outcome, "replayed");
  assert.equal(r.attribution.expiresAtMs, s.f.at - 1);
  assert.equal(Object.hasOwn(r.attribution, "secret"), false);
  assert.equal(s.calls.findLast((c) => c.stage === "readOnlyBegin")?.values.length, 0);
  assert.deepEqual(s.calls.at(-2).values, ["234fde9e-33af-4894-80c1-d36d296eaf57", "a".repeat(64)]);
  assert.equal(s.calls.at(-1).stage, "commit");
  const bad = await setup({
    result: (stage, standard) =>
      stage === "reconcile"
        ? { rows: [{ ...standard.rows[0], outcome: "newly_admitted" }] }
        : standard,
  });
  assert.equal(
    (
      await bad.service.reconcile(
        JSON.stringify({
          schemaVersion: 1,
          commandId: randomUUID(),
          requestDigest: "b".repeat(64),
        }),
      )
    ).outcome,
    "held",
  );
  assert.equal(bad.calls.at(-1).stage, "rollback");
});
test("reconcile closed input and nullable outcomes never leak credentials", async () => {
  const s = await setup();
  for (const v of [
    {},
    "{}",
    JSON.stringify({ schemaVersion: 1, commandId: randomUUID(), requestDigest: "x" }),
    JSON.stringify({
      schemaVersion: 1,
      commandId: randomUUID(),
      requestDigest: "a".repeat(64),
      secret: "forbidden",
    }),
  ])
    assert.equal((await s.service.reconcile(v)).outcome, "held");
  assert.equal(s.connects(), 0);
  for (const outcome of ["denied", "conflict"]) {
    const q = await setup({
      result: (stage, standard) =>
        stage === "reconcile"
          ? {
              rows: [
                {
                  outcome,
                  family_id: null,
                  generation_id: null,
                  provider_binding_id: null,
                  expires_at_ms: null,
                  audit_id: null,
                },
              ],
            }
          : standard,
    });
    const r = await q.service.reconcile(
      JSON.stringify({ schemaVersion: 1, commandId: randomUUID(), requestDigest: "a".repeat(64) }),
    );
    assert.equal(r.outcome, outcome);
    assert.equal(r.attribution, null);
  }
});
test("a late connection is discarded without issuing anyquery afterdeadline", async () => {
  const late = deferred(),
    entered = deferred();
  const s = await setup({
    fixture: { snapshot: { expiresAtMs: 1800000000040 } },
    connect(client) {
      entered.resolve();
      return late.promise.then(() => client);
    },
  });
  const pending = s.service.admit(s.proof.handle, selector());
  await entered.promise;
  isHeld(await pending);
  late.resolve();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.releases, [true]);
});
test("nonsettling query and release are bounded held results; latecompletion cannot COMMIT or deliver", async () => {
  for (const stage of ["admit", "release"]) {
    const waiting = deferred(),
      entered = deferred();
    const s = await setup({
      fixture: { snapshot: { expiresAtMs: 1800000000100 } },
      before(actual) {
        if (actual === stage) {
          entered.resolve();
          return waiting.promise;
        }
      },
    });
    const pending = s.service.admit(s.proof.handle, selector());
    await entered.promise;
    isHeld(await pending);
    const calls = s.calls.length;
    waiting.resolve();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.calls.length, calls);
    assert.equal(s.releases.length, 1);
    if (stage === "admit")
      assert.equal(
        s.calls.some((c) => c.stage === "commit"),
        false,
      );
  }
});
test("clock regression permanently holds; a slow final own reader cannot return expiredmaterial", async () => {
  const s = await setup();
  s.setNow(s.f.at - 1);
  isHeld(await s.service.admit(s.proof.handle, selector()));
  s.setNow(s.f.at);
  isHeld(await s.service.admit(s.proof.handle, selector()));
  assert.equal(s.connects(), 0);
  const x = await setup({
    before(stage, state) {
      if (stage === "release") state.setNow(state.f.at + 4999);
    },
    onEvidence(_count, state) {
      if (state.releases.length) state.setNow(state.f.at + 5000);
    },
  });
  isHeld(await x.service.admit(x.proof.handle, selector()));
});
test("retained command ceiling fails closed without evicting a consumed command", async () => {
  const s = await setup({
    connect() {
      throw Error("synthetic unavailable");
    },
  });
  for (let i = 0; i < 1024; i++)
    isHeld(await s.service.admit(s.proof.handle, selector({ commandId: randomUUID() })));
  assert.equal(s.connects(), 1024);
  isHeld(await s.service.admit(s.proof.handle, selector()));
  assert.equal(s.connects(), 1024);
});
