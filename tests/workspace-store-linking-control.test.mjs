import test from "node:test";
import assert from "node:assert/strict";
import {
  createControlledWorkspaceStoreLinking,
  workspaceStoreLinkingControlSql as sql,
} from "../packages/identity/src/workspace-store-linking-control.ts";
import { workspaceStoreLinkingSql as legacy } from "../packages/identity/src/workspace-store-linking.ts";
const command = "1b88ef32-516b-473f-87bd-50adf2356a88";
const selected = {
  sessionDigest: "a".repeat(64),
  workspaceId: "workspace_a",
  nonceDigest: "b".repeat(64),
  commandId: command,
};
const input = {
  handoffId: "handoff_a",
  commandId: command,
  requestDigest: "c".repeat(64),
  sessionDigest: selected.sessionDigest,
  nonceDigest: selected.nonceDigest,
  organizationId: "org_a",
  workspaceId: selected.workspaceId,
  installationId: "installation_a",
  purpose: "workspace_first",
  expectedPolicyRevision: 7,
  expectedOwnershipRevision: 3,
};
const lookupRow = {
  handoff_id: input.handoffId,
  command_id: command,
  request_digest: input.requestDigest,
  session_digest: selected.sessionDigest,
  nonce_digest: selected.nonceDigest,
  organization_id: input.organizationId,
  workspace_id: input.workspaceId,
  installation_id: input.installationId,
  purpose: input.purpose,
  expected_policy_revision: "7",
  expected_ownership_revision: "3",
};
const applied = {
  outcome: "applied",
  link_id: "link_a",
  ownership_revision: "4",
  policy_revision: "8",
  audit_id: "audit_a",
};
const role = {
  role: "morrow_identity_linking",
  login: "morrow_identity_linking",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
  rolreplication: false,
};
const control = (deadlineMs = 5000, signal = new AbortController().signal) => ({
  deadlineMs,
  signal,
});
function fixture(options = {}) {
  const calls = [],
    clients = [];
  let releases = 0,
    connections = 0,
    at = 1000;
  const pool = {
    async connect(c) {
      connections++;
      const client = {
        async query(text, values, c) {
          calls.push({ text, values, c });
          if (options.query) return options.query(text, values, c);
          return {
            rows:
              text === sql.role
                ? [{ ...role }]
                : text === sql.lookup
                  ? [{ ...lookupRow }]
                  : text === sql.status || text === legacy.apply
                    ? [{ ...applied }]
                    : [],
          };
        },
        async release(discard) {
          releases++;
          assert.equal(discard, true);
          if (options.release) await options.release();
        },
      };
      clients.push(client);
      if (options.connect) return options.connect(c, client);
      return client;
    },
  };
  return {
    service: createControlledWorkspaceStoreLinking({ pool, now: () => at }),
    calls,
    clients,
    pool,
    get connections() {
      return connections;
    },
    get releases() {
      return releases;
    },
    set at(value) {
      at = value;
    },
  };
}
const unknown = (p) =>
  assert.rejects(p, (e) => e.code === "WORKSPACE_LINKING_OUTCOME_UNKNOWN" && e.message === e.code);

test("private lookup is exact READ ONLY, bound to four selectors and released before return", async () => {
  const f = fixture();
  const result = await f.service.lookup(JSON.stringify(selected), control());
  assert.deepEqual(result, input);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(f.releases, 1);
  assert.deepEqual(
    f.calls.map((c) => c.text),
    [sql.begin, sql.role, sql.timeout, sql.idleTimeout, sql.lookup, sql.commit],
  );
  assert.deepEqual(f.calls[4].values, [
    selected.sessionDigest,
    selected.workspaceId,
    selected.nonceDigest,
    command,
  ]);
  assert.equal(Object.isFrozen(f.calls[4].values), true);
  assert.equal(Object.isFrozen(f.calls[4].c), true);
  assert.equal(f.calls[4].c.deadlineMs, 5000);
  assert.equal(f.calls[4].c.signal instanceof AbortSignal, true);
});
test("lookup absence is null and status uses only SELECT-only terminal path", async () => {
  const f = fixture();
  const result = await f.service.status(JSON.stringify(selected), control());
  assert.deepEqual(result, {
    outcome: "applied",
    linkId: "link_a",
    ownershipRevision: 4,
    policyRevision: 8,
    auditId: "audit_a",
  });
  assert.equal(
    f.calls.some((c) => c.text === legacy.apply),
    false,
  );
  assert.equal(f.calls[0].text, sql.begin);
  const empty = fixture({ query: async (text) => ({ rows: text === sql.role ? [role] : [] }) });
  assert.equal(await empty.service.lookup(JSON.stringify(selected), control()), null);
  assert.equal(await empty.service.status(JSON.stringify(selected), control()), null);
});
test("unmodified apply body gets controlled role projection, exact11 scalars and once-only release", async () => {
  const f = fixture();
  const result = await f.service.apply(JSON.stringify(input), control());
  assert.equal(result.outcome, "applied");
  assert.equal(result.ownershipRevision, 4);
  assert.equal(result.policyRevision, 8);
  assert.equal(f.releases, 1);
  assert.deepEqual(
    f.calls.map((c) => c.text),
    [legacy.begin, sql.role, legacy.timeout, legacy.idleTimeout, legacy.apply, legacy.commit],
  );
  assert.deepEqual(f.calls[4].values, [
    input.handoffId,
    command,
    input.requestDigest,
    input.sessionDigest,
    input.nonceDigest,
    input.organizationId,
    input.workspaceId,
    input.installationId,
    input.purpose,
    "7",
    "3",
  ]);
});
test("primitive closed selector and input boundaries reject hostile callers before acquisition", async () => {
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
  for (const value of [
    hostile,
    selected,
    JSON.stringify({ ...selected, actor: "admin" }),
    JSON.stringify({ ...selected, sessionDigest: "0" }),
    JSON.stringify({ ...selected, commandId: "arbitrary" }),
    '{"sessionDigest":"a","sessionDigest":"b"}',
    "x".repeat(4097),
  ]) {
    const f = fixture();
    await assert.rejects(
      f.service.lookup(value, control()),
      (e) => e.code === "WORKSPACE_LINKING_CONTROL_INVALID",
    );
    assert.equal(f.connections, 0);
  }
  const f = fixture();
  await assert.rejects(
    f.service.apply({ ...input }, control()),
    (e) => e.code === "WORKSPACE_LINKING_CONTROL_INVALID",
  );
  assert.equal(f.connections, 0);
  assert.equal(traps, 0);
});
test("selector scalars are copied before first await and row cannot replace bound namespace", async () => {
  const f = fixture();
  const promise = f.service.lookup(JSON.stringify(selected), control());
  selected.workspaceId = "mutated";
  assert.equal((await promise).workspaceId, "workspace_a");
  selected.workspaceId = "workspace_a";
  for (const key of ["session_digest", "workspace_id", "nonce_digest", "command_id"]) {
    const g = fixture({
      query: async (text) => ({
        rows:
          text === sql.role
            ? [role]
            : text === sql.lookup
              ? [{ ...lookupRow, [key]: "foreign" }]
              : [],
      }),
    });
    await unknown(g.service.lookup(JSON.stringify(selected), control()));
    assert.equal(g.releases, 1);
  }
});
test("every unsafe role flag including replication and memberships denies read and apply", async () => {
  for (const key of Object.keys(role).slice(2))
    for (const method of ["lookup", "apply"]) {
      const f = fixture({
        query: async (text) => ({ rows: text === sql.role ? [{ ...role, [key]: true }] : [] }),
      });
      await unknown(
        f.service[method](JSON.stringify(method === "lookup" ? selected : input), control()),
      );
      assert.equal(
        f.calls.some((c) => c.text === sql.lookup || c.text === legacy.apply),
        false,
      );
      assert.equal(f.releases, 1);
    }
});
test("unknown query never permits legacy rollback, COMMIT, retry or raw error reflection", async () => {
  for (const stage of [
    legacy.begin,
    sql.role,
    legacy.timeout,
    legacy.idleTimeout,
    legacy.apply,
    legacy.commit,
  ]) {
    let touches = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          touches++;
          throw Error();
        },
      },
    );
    const f = fixture({
      query: async (text) => {
        if (text === stage) throw hostile;
        return { rows: text === sql.role ? [role] : text === legacy.apply ? [applied] : [] };
      },
    });
    await unknown(f.service.apply(JSON.stringify(input), control()));
    assert.equal(f.calls.at(-1).text, stage);
    assert.equal(
      f.calls.some((c) => c.text === legacy.rollback),
      false,
    );
    assert.equal(f.releases, 1);
    assert.equal(touches, 0);
  }
});
test("malformed completed apply result may rollback but cannot return success", async () => {
  const f = fixture({
    query: async (text) => ({
      rows:
        text === sql.role
          ? [role]
          : text === legacy.apply
            ? [{ ...applied, ownership_revision: "9" }]
            : [],
    }),
  });
  await unknown(f.service.apply(JSON.stringify(input), control()));
  assert.equal(f.calls.at(-1).text, legacy.rollback);
  assert.equal(f.releases, 1);
});
test("lookup/status row shape, null matrix, getters and arrays fail closed", async () => {
  let getters = 0;
  const hostile = { ...lookupRow };
  Object.defineProperty(hostile, "handoff_id", {
    enumerable: true,
    get() {
      getters++;
      return "x";
    },
  });
  for (const value of [
    { rows: [hostile] },
    { rows: [lookupRow, lookupRow] },
    { rows: [{ ...lookupRow, extra: true }] },
    { rows: [{ ...lookupRow, expected_policy_revision: "9007199254740992" }] },
  ]) {
    const f = fixture({
      query: async (text) =>
        text === sql.lookup ? value : { rows: text === sql.role ? [role] : [] },
    });
    await unknown(f.service.lookup(JSON.stringify(selected), control()));
  }
  assert.equal(getters, 0);
  for (const row of [
    { ...applied, outcome: "conflict" },
    { ...applied, link_id: null },
    {
      outcome: "denied",
      link_id: null,
      ownership_revision: null,
      policy_revision: null,
      audit_id: null,
    },
  ]) {
    const f = fixture({
      query: async (text) => ({
        rows: text === sql.role ? [role] : text === sql.status ? [row] : [],
      }),
    });
    await unknown(f.service.status(JSON.stringify(selected), control()));
  }
});
test("attributable terminal denial remains redacted and read only", async () => {
  const f = fixture({
    query: async (text) => ({
      rows:
        text === sql.role
          ? [role]
          : text === sql.status
            ? [
                {
                  outcome: "denied",
                  link_id: null,
                  ownership_revision: null,
                  policy_revision: "8",
                  audit_id: "denial_audit",
                },
              ]
            : [],
    }),
  });
  assert.deepEqual(await f.service.status(JSON.stringify(selected), control()), {
    outcome: "denied",
    linkId: null,
    ownershipRevision: null,
    policyRevision: 8,
    auditId: "denial_audit",
  });
  assert.equal(
    f.calls.some((c) => c.text === legacy.apply),
    false,
  );
});
test("abort after underlying apply response suppresses commit and rollback", async () => {
  const abort = new AbortController();
  const f = fixture({
    query: async (text) => {
      if (text === legacy.apply) abort.abort();
      return { rows: text === sql.role ? [role] : text === legacy.apply ? [applied] : [] };
    },
  });
  await unknown(f.service.apply(JSON.stringify(input), control(5000, abort.signal)));
  assert.equal(f.calls.at(-1).text, legacy.apply);
  assert.equal(f.releases, 1);
});
test("shared deadline discards late acquisition before any SQL", async () => {
  let deliver;
  const gate = new Promise((resolve) => {
    deliver = resolve;
  });
  const f = fixture({
    connect: async (_c, client) => {
      await gate;
      return client;
    },
  });
  await unknown(f.service.lookup(JSON.stringify(selected), control(1020)));
  assert.equal(f.calls.length, 0);
  assert.equal(f.releases, 0);
  deliver();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.releases, 1);
  assert.equal(f.calls.length, 0);
});
test("stalled release is bounded and a late release cannot revive success", async () => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture({ release: () => gate });
  await unknown(f.service.lookup(JSON.stringify(selected), control(1020)));
  assert.equal(f.releases, 1);
  finish();
  await Promise.resolve();
  assert.equal(f.releases, 1);
});
test("release failure after real completed commit is unknown, never retried", async () => {
  const f = fixture({
    release: async () => {
      throw Error("discarded");
    },
  });
  await unknown(f.service.apply(JSON.stringify(input), control()));
  assert.equal(f.calls.at(-1).text, legacy.commit);
  assert.equal(f.releases, 1);
});
test("clock regression latches factory and external control mutations cannot bypass captured abort", async () => {
  const f = fixture();
  await f.service.lookup(JSON.stringify(selected), control());
  f.at = 999;
  await unknown(f.service.lookup(JSON.stringify(selected), control()));
  f.at = 1001;
  await unknown(f.service.lookup(JSON.stringify(selected), control()));
  assert.equal(f.connections, 1);
  const abort = new AbortController(),
    external = control(5000, abort.signal);
  const g = fixture({
    query: async (text) => {
      if (text === sql.role) {
        external.signal = new AbortController().signal;
        abort.abort();
      }
      return { rows: text === sql.role ? [role] : [] };
    },
  });
  await unknown(g.service.lookup(JSON.stringify(selected), external));
  assert.equal(g.calls.at(-1).text, sql.role);
  assert.equal(g.releases, 1);
});
