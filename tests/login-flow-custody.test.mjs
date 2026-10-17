import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createLoginFlowCustody,
  createLoginFlowMaintenance,
  loginFlowCustodySql as sql,
} from "../packages/identity/src/login-flow-custody.ts";
const ids = Array.from({ length: 5 }, () => randomUUID());
const input = {
  schemaVersion: 1,
  configurationDigest: "a".repeat(64),
  flowId: ids[0],
  beginCommandId: ids[1],
  admissionCommandId: ids[2],
  issuerCommandId: ids[3],
  workspaceId: "workspace_a",
};
const control = (deadlineMs = 5000, signal = new AbortController().signal) => ({
  deadlineMs,
  signal,
});
const role = (name = "morrow_identity_login") => ({
  role: name,
  login: name,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
});
const created = () => ({
  outcome: "newly_created",
  flow_id: input.flowId,
  flow_revision: "1",
  expires_at_ms: "301000",
  audit_id: ids[4],
});
function fixture(options = {}) {
  let at = 1000,
    released = 0,
    connections = 0;
  const calls = [];
  const client = {
    async query(text, values, c) {
      calls.push({ text, values, c });
      if (options.query) return options.query(text, values, c);
      return {
        rows:
          text === sql.role
            ? [role(options.maintenance ? "morrow_identity_login_maintenance" : undefined)]
            : text === sql.createIntent
              ? [created()]
              : text === sql.observeEligibility
                ? [{ matches: true, database_now_ms: "1000" }]
                : text === sql.maintain
                  ? [
                      {
                        outcome: "completed",
                        erased_capsules: "0",
                        pruned_closed_states: "0",
                        pseudonymized_audits: "0",
                        pruned_audits: "0",
                        retained_unresolved: "0",
                      },
                    ]
                  : [],
      };
    },
    async release(discard) {
      released++;
      assert.equal(discard, true);
      if (options.release) await options.release();
    },
  };
  const pool = {
    async connect(c) {
      connections++;
      return options.connect ? options.connect(c, client) : client;
    },
  };
  return {
    service: createLoginFlowCustody({ pool, now: () => at }),
    maintenance: createLoginFlowMaintenance({ pool, now: () => at }),
    calls,
    get released() {
      return released;
    },
    get connections() {
      return connections;
    },
    set at(n) {
      at = n;
    },
  };
}
const denied = (promise) =>
  assert.rejects(promise, (e) => e.message === "LOGIN_FLOW_OUTCOME_UNKNOWN");
test("fresh transition snapshots six scalar values, commits and awaits physical discard", async () => {
  let finish;
  const f = fixture({ release: () => new Promise((r) => (finish = r)) });
  let complete = false;
  const p = f.service.createIntent(JSON.stringify(input), control()).then((r) => {
    complete = true;
    return r;
  });
  while (!finish) await new Promise((r) => setImmediate(r));
  assert.equal(complete, false);
  assert.equal(f.calls.at(-1).text, sql.commit);
  finish();
  assert.deepEqual(await p, created());
  assert.deepEqual(
    f.calls.find((c) => c.text === sql.createIntent).values,
    Object.values(input).slice(1),
  );
  assert.equal(f.released, 1);
});
test("primitive boundary rejects proxies/getters before any reflection or connect", async () => {
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
  const f = fixture();
  for (const v of [hostile, {}, null, 42, () => {}])
    await assert.rejects(f.service.createIntent(v, control()), /LOGIN_FLOW_INVALID/);
  assert.equal(traps, 0);
  assert.equal(f.connections, 0);
});
test("closed duplicate-free bounded JSON rejects malformed inputs before SQL", async () => {
  const f = fixture();
  for (const text of [
    JSON.stringify({ ...input, extra: true }),
    JSON.stringify({ ...input, flowId: ids[1] }),
    JSON.stringify({ ...input, schemaVersion: "1" }),
    JSON.stringify({ ...input, configurationDigest: "A".repeat(64) }),
    ' {"schemaVersion":1,"schemaVersion":1}',
    " ".repeat(8193),
    JSON.stringify({ ...input, workspaceId: "bad space" }),
  ])
    await assert.rejects(f.service.createIntent(text, control()), /LOGIN_FLOW_INVALID/);
  assert.equal(f.connections, 0);
});
test("all scalar values are immutable before connect await", async () => {
  let release;
  const f = fixture({
    connect: async (c, client) => {
      await new Promise((r) => (release = r));
      return client;
    },
  });
  const text = JSON.stringify(input);
  const p = f.service.createIntent(text, control());
  release();
  await p;
  assert.ok(Object.isFrozen(f.calls.find((c) => c.text === sql.createIntent).values));
});
test("safe exact dedicated login and role attributes required", async () => {
  for (const patch of [
    { role: "morrow_api" },
    { login: "postgres" },
    { role_member: true },
    { owner_member: true },
    { rolreplication: true },
    { rolinherit: true },
    { rolsuper: true },
    { rolbypassrls: true },
    { rolcreatedb: true },
    { rolcreaterole: true },
  ]) {
    const f = fixture({
      query: async (t) => ({ rows: t === sql.role ? [{ ...role(), ...patch }] : [] }),
    });
    await denied(f.service.createIntent(JSON.stringify(input), control()));
    assert.equal(
      f.calls.some((c) => c.text === sql.createIntent),
      false,
    );
    assert.equal(f.released, 1);
  }
});
test("unknown query never causes follow-up SQL or automatic rollback/retry", async () => {
  for (const fail of [
    sql.begin,
    sql.role,
    sql.timeout,
    sql.idleTimeout,
    sql.createIntent,
    sql.commit,
  ]) {
    const f = fixture({
      query: async (t) => {
        if (t === fail) throw Error("PRIVATE_SQL_CAUSE");
        return { rows: t === sql.role ? [role()] : t === sql.createIntent ? [created()] : [] };
      },
    });
    await denied(f.service.createIntent(JSON.stringify(input), control()));
    assert.equal(f.calls.at(-1).text, fail);
    assert.equal(
      f.calls.some((c) => c.text === sql.rollback),
      false,
    );
    assert.equal(f.released, 1);
  }
});
test("malformed rows, extra fields, accessor cells and wrong return identity hold", async () => {
  for (const reply of [
    { rows: [] },
    { rows: [created(), created()] },
    { rows: [{ ...created(), extra: "x" }] },
    { rows: [{ ...created(), flow_id: randomUUID() }] },
    { rows: [{ ...created(), flow_revision: "01" }] },
    { rows: [{ ...created(), expires_at_ms: "999" }] },
    {
      rows: [
        Object.defineProperty({ ...created() }, "audit_id", {
          get() {
            throw Error("PRIVATE");
          },
        }),
      ],
    },
  ]) {
    const f = fixture({
      query: async (t) =>
        t === sql.createIntent ? reply : { rows: t === sql.role ? [role()] : [] },
    });
    await denied(f.service.createIntent(JSON.stringify(input), control()));
    assert.equal(
      f.calls.some((c) => c.text === sql.commit),
      false,
    );
  }
});
test("nonfresh rows contain no capsule or correlation fields", async () => {
  for (const outcome of ["held", "denied", "conflict", "rate_limited", "quota_limited"]) {
    const response = {
      outcome,
      flow_id: null,
      flow_revision: null,
      expires_at_ms: null,
      audit_id: null,
    };
    const f = fixture({
      query: async (t) => ({
        rows: t === sql.role ? [role()] : t === sql.createIntent ? [response] : [],
      }),
    });
    assert.deepEqual(await f.service.createIntent(JSON.stringify(input), control()), response);
  }
});
test("release acknowledgment loss suppresses fresh output", async () => {
  const f = fixture({
    release: async () => {
      throw Error("PRIVATE_RELEASE");
    },
  });
  await denied(f.service.createIntent(JSON.stringify(input), control()));
  assert.equal(f.calls.at(-1).text, sql.commit);
  assert.equal(f.released, 1);
});
test("expired/aborted attempts deny before acquisition and monotonic clock regression latches", async () => {
  const f = fixture();
  await denied(f.service.createIntent(JSON.stringify(input), control(1000)));
  const a = new AbortController();
  a.abort();
  await denied(f.service.createIntent(JSON.stringify(input), control(5000, a.signal)));
  assert.equal(f.connections, 0);
  await f.service.createIntent(JSON.stringify(input), control());
  f.at = 999;
  await denied(f.service.createIntent(JSON.stringify(input), control()));
  f.at = 1001;
  await denied(f.service.createIntent(JSON.stringify(input), control()));
  assert.equal(f.connections, 1);
});
test("late acquisition is disposed once without a query after timeout", async () => {
  let deliver;
  const f = fixture({ connect: (c, client) => new Promise((r) => (deliver = () => r(client))) });
  await denied(f.service.createIntent(JSON.stringify(input), control(1020)));
  deliver();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 0);
  assert.equal(f.released, 1);
});
test("nonsettling physical release returns unknown at the unchanged deadline", async () => {
  const f = fixture({ release: () => new Promise(() => {}) });
  await denied(f.service.createIntent(JSON.stringify(input), control(1020)));
  assert.equal(f.released, 1);
});
test("eligibility uses read-only transaction and exact boolean/time row", async () => {
  const f = fixture();
  const r = await f.service.observeEligibility(
    JSON.stringify({
      schemaVersion: 1,
      flowId: input.flowId,
      configurationDigest: input.configurationDigest,
    }),
    control(),
  );
  assert.deepEqual(r, { matches: true, database_now_ms: "1000" });
  assert.equal(f.calls[0].text, sql.readOnlyBegin);
  assert.equal(f.calls.at(-1).text, sql.commit);
  assert.equal(f.released, 1);
});
test("maintenance is a separate exact role and capped count decoder", async () => {
  const f = fixture({ maintenance: true });
  const r = await f.maintenance.maintain(
    JSON.stringify({ schemaVersion: 1, configurationDigest: input.configurationDigest }),
    control(),
  );
  assert.equal(r.outcome, "completed");
  assert.equal(f.service.maintain, undefined);
  const g = fixture();
  await denied(
    g.maintenance.maintain(
      JSON.stringify({ schemaVersion: 1, configurationDigest: input.configurationDigest }),
      control(),
    ),
  );
  assert.equal(
    g.calls.some((c) => c.text === sql.maintain),
    false,
  );
});
test("fresh claim returns exact original capsule only after COMMIT/release", async () => {
  const selected = {
      schemaVersion: 1,
      configurationDigest: input.configurationDigest,
      cookieDigest: "b".repeat(64),
      stateDigest: "c".repeat(64),
      codeDigest: "d".repeat(64),
    },
    answer = {
      ...created(),
      outcome: "newly_claimed",
      flow_revision: "3",
      challenge_id: randomUUID(),
      begin_command_id: ids[1],
      admission_command_id: ids[2],
      issuer_command_id: ids[3],
      workspace_id: "workspace_a",
      state_digest: selected.stateDigest,
      cookie_digest: selected.cookieDigest,
      browser_proof_digest: "e".repeat(64),
      verifier_digest: "f".repeat(64),
      ciphertext: Buffer.alloc(32, 1).toString("base64url"),
      encryption_nonce: Buffer.alloc(12, 1).toString("base64url"),
      key_id: randomUUID(),
      aad_digest: "1".repeat(64),
      code_digest: selected.codeDigest,
    };
  const f = fixture({
    query: async (t) => ({
      rows: t === sql.role ? [role()] : t === sql.claimCallback ? [answer] : [],
    }),
  });
  assert.deepEqual(await f.service.claimCallback(JSON.stringify(selected), control()), answer);
  assert.equal(f.calls.at(-1).text, sql.commit);
  assert.equal(f.released, 1);
});
test("read-only historical reconciliation never creates credentials or writes", async () => {
  const answer = {
    outcome: "observed",
    phase: "claimed",
    flow_revision: "3",
    expires_at_ms: "100",
    admission_id: null,
    issuer_request_digest: null,
    issuer_outcome: null,
    family_id: null,
    generation_id: null,
    provider_binding_id: null,
    family_expires_at_ms: null,
    issuer_audit_id: null,
  };
  const f = fixture({
    query: async (t) => ({ rows: t === sql.role ? [role()] : t === sql.reconcile ? [answer] : [] }),
  });
  const { workspaceId, ...selected } = input;
  assert.deepEqual(await f.service.reconcile(JSON.stringify(selected), control()), answer);
  assert.equal(f.calls[0].text, sql.readOnlyBegin);
  assert.equal(
    f.calls.some((c) => [sql.createIntent, sql.claimCallback, sql.bindBegin].includes(c.text)),
    false,
  );
});

test("ciphertext canonical trailing bits reject before connection", async () => {
  const f = fixture();
  const v = {
    schemaVersion: 1,
    configurationDigest: input.configurationDigest,
    flowId: input.flowId,
    expectedRevision: "1",
    challengeId: randomUUID(),
    stateDigest: "a".repeat(64),
    cookieDigest: "b".repeat(64),
    browserProofDigest: "c".repeat(64),
    verifierDigest: "d".repeat(64),
    ciphertext: "A".repeat(21) + "B",
    encryptionNonce: "A".repeat(16),
    keyId: randomUUID(),
    aadDigest: "e".repeat(64),
  };
  await assert.rejects(f.service.bindBegin(JSON.stringify(v), control()), /LOGIN_FLOW_INVALID/);
  assert.equal(f.connections, 0);
});
