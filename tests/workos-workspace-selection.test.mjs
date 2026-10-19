import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkosWorkspaceSelection,
  workspaceSelectionSql as sql,
} from "../packages/identity/src/workos-workspace-selection.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "./fixtures/workos-authentication-evidence.mjs";

const held = { outcome: "held", selection: null };
const selector = (workspaceId = "workspace_A") => JSON.stringify({ schemaVersion: 1, workspaceId });
const role = () => ({
  role: "morrow_identity_resolution",
  login: "morrow_identity_resolution",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
});
const row = (changes = {}) => ({
  profile_id: "verification_profile_A",
  profile_record_revision: "2",
  mapping_id: "mapping_A",
  mapping_revision: "3",
  binding_revision: "4",
  principal_id: "human_A",
  organization_id: "organization_A",
  workspace_id: "workspace_A",
  membership_id: "membership_A",
  policy_revision: "5",
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
  const f = options.fixture ?? buildWorkosAuthenticationEvidenceFixture();
  let now = f.at,
    profile = f.profileJson;
  const owner = createWorkosAuthenticationEvidence(f.profileJson, f.snapshotJson, {
    now: () => now,
    currentProfile: () => profile,
    readPage: async () => f.page(),
  });
  const proof = await owner.verify(f.token);
  assert.equal(proof.outcome, "verified_active_evidence");
  const evidence = owner.readEvidence(proof.handle),
    cancel = new AbortController();
  const calls = [],
    releases = [],
    controls = [],
    clients = [];
  let connects = 0,
    readCount = 0;
  const state = {
    f,
    owner,
    proof,
    evidence,
    calls,
    releases,
    controls,
    clients,
    cancel,
    setNow: (v) => {
      now = v;
    },
    setProfile: (v) => {
      profile = v;
    },
  };
  const makeClient = () => {
    let lookups = 0;
    return {
      query: async (text, values, control) => {
        const key = Object.keys(sql).find((k) => sql[k] === text);
        assert.ok(key);
        const stage = key === "resolve" ? "resolve" + ++lookups : key;
        const call = { stage, text, values };
        calls.push(call);
        controls.push(control);
        await options.before?.(stage, state);
        const standard = { rows: key === "role" ? [role()] : key === "resolve" ? [row()] : [] };
        return options.result ? options.result(stage, standard, state, call) : standard;
      },
      release: async (discard) => {
        releases.push(discard);
        await options.before?.("release", state);
        await options.release?.(state);
      },
    };
  };
  const client = makeClient();
  const pool = {
    connect: async (control) => {
      connects++;
      const connection = connects === 1 ? client : makeClient();
      clients.push(connection);
      controls.push(control);
      await options.before?.("connect", state);
      return options.connect ? options.connect(connection, state) : connection;
    },
  };
  const service = createWorkosWorkspaceSelection({
    pool,
    now: () => now,
    signal: cancel.signal,
    readEvidence: (h) => {
      readCount++;
      options.onEvidence?.(readCount, state);
      return owner.readEvidence(h);
    },
  });
  return { ...state, service, connects: () => connects, client };
}
test("own native-RSA evidence yields only one frozen ten-field private selection snapshot", async () => {
  const s = await setup(),
    result = await s.service.resolve(s.proof.handle, selector());
  assert.deepEqual(result, {
    outcome: "selected",
    selection: {
      kind: "private_workspace_selection",
      profileId: "verification_profile_A",
      profileRecordRevision: 2,
      mappingId: "mapping_A",
      mappingRevision: 3,
      bindingRevision: 4,
      principalId: "human_A",
      organizationId: "organization_A",
      workspaceId: "workspace_A",
      membershipId: "membership_A",
      policyRevision: 5,
      observedAtMs: s.f.at,
      evidenceExpiresAtMs: s.f.at + 5000,
    },
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.selection));
  assert.equal(s.connects(), 1);
  assert.deepEqual(s.releases, [true]);
  assert.deepEqual(
    s.calls.map((c) => c.stage),
    ["begin", "role", "timeout", "idleTimeout", "resolve1", "resolve2", "commit"],
  );
  const expected = [
    "workos",
    s.f.profile.environmentId,
    s.f.profile.applicationId,
    s.f.profile.clientId,
    s.f.profile.issuer,
    "1",
    s.evidence.tokenProfileDigest,
    s.f.claims.sub,
    "workspace_A",
  ];
  for (const c of s.calls)
    assert.deepEqual(c.values, c.stage.startsWith("resolve") ? expected : []);
  for (const c of s.controls) {
    assert.equal(c.deadlineMs, s.f.at + 5000);
    assert.ok(c.signal instanceof AbortSignal);
    assert.ok(Object.isFrozen(c));
  }
  const output = JSON.stringify(result);
  for (const value of [
    s.f.token,
    s.f.claims.sub,
    s.f.claims.sid,
    "ActorRef",
    "sessionDigest",
    "grant",
    "HostContext",
  ])
    assert.equal(output.includes(value), false);
});
test("invalid selectors and forged, foreign, serialized or stale handles acquire zero connections", async () => {
  const s = await setup(),
    other = await setup();
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
      getPrototypeOf() {
        traps++;
        throw Error();
      },
    },
  );
  for (const handle of [
    {},
    hostile,
    JSON.parse(JSON.stringify(s.proof.handle)),
    other.proof.handle,
    null,
    s.f.token,
  ])
    assert.deepEqual(await s.service.resolve(handle, selector()), held);
  for (const value of [
    hostile,
    {},
    [],
    new String(selector()),
    "bad",
    '{"schemaVersion":1,"workspaceId":"w","workspaceId":"x"}',
    JSON.stringify({ schemaVersion: 1, workspaceId: "w", organizationId: "admin" }),
    JSON.stringify({ schemaVersion: 2, workspaceId: "w" }),
    selector("bad' OR TRUE"),
    " ".repeat(2049),
  ])
    assert.deepEqual(await s.service.resolve(s.proof.handle, value), held);
  assert.equal(traps, 0);
  assert.equal(s.connects(), 0);
  s.setNow(s.f.at + 5000);
  assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
  assert.equal(s.connects(), 0);
});
test("dedicated role requires exact login and all unsafe flags and role memberships false", async () => {
  for (const changes of [
    { role: "morrow_api" },
    { login: "morrow_identity_owner" },
    ...Object.keys(role())
      .filter((k) => !["role", "login"].includes(k))
      .map((k) => ({ [k]: true })),
    { extra: false },
    { role: null },
    // ADR-0020 (P04.T01j D5): an unknown preflight fails closed.
    { role_member: null },
  ]) {
    const s = await setup({
      result: (stage, standard) =>
        stage === "role" ? { rows: [{ ...role(), ...changes }] } : standard,
    });
    assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
    assert.equal(
      s.calls.some((c) => c.stage.startsWith("resolve")),
      false,
    );
    assert.deepEqual(s.releases, [true]);
  }
});
test("result and array descriptors reject getters and symbols before executing them", async () => {
  let getterReads = 0;
  const getter = (key, base) =>
    Object.defineProperty(base, key, {
      get() {
        getterReads++;
        throw Error("private");
      },
      enumerable: true,
    });
  const badRow = getter("profile_id", row()),
    badOuter = getter("rows", {}),
    badArray = getter("0", [row()]);
  const symbolic = row();
  symbolic[Symbol("private")] = "canary";
  for (const result of [
    badOuter,
    { rows: badArray },
    { rows: [badRow] },
    { rows: [symbolic] },
    { rows: Object.assign([row()], { extra: true }) },
    { rows: new Array(1) },
    { rows: [Object.assign(Object.create({ inherited: true }), row())] },
  ]) {
    const s = await setup({
      result: (stage, standard) => (stage === "resolve1" ? result : standard),
    });
    assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
    assert.deepEqual(s.releases, [true]);
  }
  assert.equal(getterReads, 0);
});
test("closed tenTEXT rows reject absent, duplicate, extra, malformed and unsafe values", async () => {
  const invalid = [{ rows: [] }, { rows: [row(), row()] }, { rows: [row()], extra: true }];
  for (const changes of [
    { profile_id: null },
    { workspace_id: "foreign_workspace" },
    { principal_id: "bad space" },
    { profile_record_revision: "0" },
    { mapping_revision: "01" },
    { binding_revision: "-1" },
    { policy_revision: "9007199254740992" },
    { policy_revision: 1 },
    { binding_revision: "1e2" },
    { extra: "private" },
  ])
    invalid.push({ rows: [row(changes)] });
  const missing = row();
  delete missing.mapping_id;
  invalid.push({ rows: [missing] });
  for (const result of invalid) {
    const s = await setup({
      result: (stage, standard) => (stage === "resolve1" ? result : standard),
    });
    assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
    assert.equal(
      s.calls.some((c) => c.stage === "commit"),
      false,
    );
  }
  const max = await setup({
    result: (stage, standard) =>
      stage.startsWith("resolve")
        ? { rows: [row({ policy_revision: "9007199254740991" })] }
        : standard,
  });
  assert.equal(
    (await max.service.resolve(max.proof.handle, selector())).selection.policyRevision,
    9007199254740991,
  );
});
test("every one of the ten returned fields must match a separate second lookup", async () => {
  for (const key of Object.keys(row())) {
    const changed = key.endsWith("revision")
      ? "9"
      : key === "workspace_id"
        ? "workspace_B"
        : "changed_record";
    const s = await setup({
      result: (stage, standard) =>
        stage === "resolve2" ? { rows: [row({ [key]: changed })] } : standard,
    });
    assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
    assert.equal(
      s.calls.some((c) => c.stage === "commit"),
      false,
    );
    assert.deepEqual(s.releases, [true]);
  }
});
test("expiry, profile drift, cancellation and clock regression at every asynchronous stage hold", async () => {
  for (const stage of [
    "connect",
    "begin",
    "role",
    "timeout",
    "idleTimeout",
    "resolve1",
    "resolve2",
    "commit",
    "release",
  ]) {
    for (const fault of ["expiry", "profile", "cancel", "clock"]) {
      let changed = false;
      const s = await setup({
        before: async (name, state) => {
          if (name !== stage || changed) return;
          changed = true;
          if (fault === "expiry") state.setNow(state.evidence.expiresAtMs);
          if (fault === "profile") state.setProfile("{}");
          if (fault === "cancel") state.cancel.abort();
          if (fault === "clock") state.setNow(state.f.at - 1);
        },
      });
      assert.deepEqual(
        await s.service.resolve(s.proof.handle, selector()),
        held,
        stage + ":" + fault,
      );
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(s.releases, [true], stage + ":" + fault);
    }
  }
});
test("time consumed synchronously reading owning evidence cannot extend the original lease", async () => {
  let advance = false;
  const s = await setup({
    onEvidence: (count, state) => {
      if (advance) state.setNow(state.evidence.expiresAtMs);
    },
  });
  advance = true;
  assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
  assert.equal(s.connects(), 0);
});
test("uncertain query failures never dispatch rollback or another statement and always destroy", async () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw Error("private");
      },
      getPrototypeOf() {
        throw Error("private");
      },
    },
  );
  for (const stage of [
    "connect",
    "begin",
    "role",
    "timeout",
    "idleTimeout",
    "resolve1",
    "resolve2",
    "commit",
    "release",
  ]) {
    const s = await setup({
      before: async (name) => {
        if (name === stage) throw hostile;
      },
    });
    assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
    assert.equal(
      s.calls.some((c) => c.stage === "rollback"),
      false,
    );
    assert.deepEqual(s.releases, stage === "connect" ? [] : [true]);
  }
  const s = await setup({
    before: async (stage) => {
      if (stage === "rollback") throw Error("private SQL");
    },
    result: (stage, standard) => (stage === "resolve1" ? { rows: [] } : standard),
  });
  assert.deepEqual(await s.service.resolve(s.proof.handle, selector()), held);
  assert.equal(s.calls.at(-1).stage, "rollback");
  assert.deepEqual(s.releases, [true]);
});
test("selected cannot escape before asynchronous destruction completes and evidence is rechecked", async () => {
  for (const expire of [false, true]) {
    const entered = deferred(),
      release = deferred();
    const s = await setup({
      release: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    let settled = false;
    const pending = s.service.resolve(s.proof.handle, selector()).then((r) => {
      settled = true;
      return r;
    });
    await entered.promise;
    assert.equal(settled, false);
    if (expire) s.setNow(s.evidence.expiresAtMs);
    release.resolve();
    const result = await pending;
    assert.equal(result.outcome, expire ? "held" : "selected");
    assert.deepEqual(s.releases, [true]);
  }
});
test("bounded connect timeout discards an eventual late connection without any SQL", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(),
    connecting = deferred();
  const s = await setup({
    connect: async () => {
      entered.resolve();
      return connecting.promise;
    },
  });
  const pending = s.service.resolve(s.proof.handle, selector());
  await entered.promise;
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, held);
  assert.deepEqual(s.releases, []);
  connecting.resolve(s.client);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.releases, [true]);
  assert.equal(s.calls.length, 0);
});
test("a timed-out in-flight query destroys its client and ignores late successful rows", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(),
    response = deferred();
  const s = await setup({
    result: async (stage, standard) => {
      if (stage === "resolve1") {
        entered.resolve();
        return response.promise;
      }
      return standard;
    },
  });
  const pending = s.service.resolve(s.proof.handle, selector());
  await entered.promise;
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, held);
  assert.deepEqual(s.releases, [true]);
  response.resolve({ rows: [row()] });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    s.calls.some((c) => ["resolve2", "commit", "rollback"].includes(c.stage)),
    false,
  );
});
test("stalled rollback or release returns only held and makes no cleanup claim", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stage of ["rollback", "release"]) {
    const entered = deferred(),
      stalled = deferred();
    const s = await setup({
      before: async (name) => {
        if (name === stage) {
          entered.resolve();
          await stalled.promise;
        }
      },
      result: (name, standard) =>
        stage === "rollback" && name === "resolve1" ? { rows: [] } : standard,
    });
    const pending = s.service.resolve(s.proof.handle, selector());
    await entered.promise;
    t.mock.timers.tick(5000);
    assert.deepEqual(await pending, held);
    assert.deepEqual(s.releases, [true]);
    stalled.resolve();
    await new Promise((r) => setImmediate(r));
  }
});
test("concurrent workspace selectors have independent clients and no shared active organization", async () => {
  const firstEntered = deferred(),
    finishFirst = deferred();
  const s = await setup({
    result: async (stage, standard, state, call) => {
      if (stage.startsWith("resolve") && call.values[8] === "workspace_B")
        return {
          rows: [
            row({
              workspace_id: "workspace_B",
              organization_id: "organization_B",
              membership_id: "membership_B",
            }),
          ],
        };
      if (stage === "resolve1") {
        firstEntered.resolve();
        await finishFirst.promise;
      }
      return standard;
    },
  });
  const first = s.service.resolve(s.proof.handle, selector());
  await firstEntered.promise;
  const second = await s.service.resolve(s.proof.handle, selector("workspace_B"));
  assert.equal(second.selection.organizationId, "organization_B");
  finishFirst.resolve();
  const original = await first;
  assert.equal(original.selection.organizationId, "organization_A");
  assert.equal(s.connects(), 2);
  assert.notEqual(s.clients[0], s.clients[1]);
  assert.deepEqual(s.releases, [true, true]);
});
