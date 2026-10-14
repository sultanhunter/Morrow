import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceAccessRevocations,
  workspaceAccessRevocationSql as sql,
  WorkspaceAccessRevocationError,
} from "../packages/identity/src/workspace-access-revocation.ts";

const input = {
  receiptId: "receipt_a",
  commandId: "command_a",
  requestDigest: "a".repeat(64),
  sessionDigest: "b".repeat(64),
  organizationId: "org_a",
  workspaceId: "workspace_a",
  targetMembershipId: "membership_target",
  expectedRevision: 1,
};
const role = {
  role: "morrow_identity_lifecycle",
  login: "morrow_identity_lifecycle",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  owner_member: false,
  role_member: false,
};
const applied = {
  outcome: "applied",
  revocation_id: "revocation_a",
  policy_revision: "2",
  audit_id: "audit_a",
};
function fixture(options = {}) {
  const queries = [],
    releases = [];
  let connections = 0;
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (options.failAt === text || (options.rollbackFails && text === sql.rollback))
        throw options.failure ?? Error(`raw SQL and private proof ${input.sessionDigest}`);
      if (text === sql.role) return { rows: options.roleRows ?? [{ ...role }] };
      if (text === sql.apply) return { rows: options.rows ?? [{ ...applied }] };
      return { rows: [] };
    },
    release(discard) {
      releases.push(discard);
      if (options.releaseThrows) throw Error(`private release details ${input.requestDigest}`);
      if (options.releaseRejects) return Promise.reject(Error("private async release"));
    },
  };
  const pool = {
    async connect() {
      connections++;
      if (options.connectFails) throw Error(`private connection ${input.sessionDigest}`);
      return client;
    },
  };
  return {
    pool,
    client,
    queries,
    releases,
    get connections() {
      return connections;
    },
  };
}
const rejectsCode = async (promise, code, commandId = input.commandId) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WorkspaceAccessRevocationError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.commandId, commandId);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.ok(!JSON.stringify(error).includes(input.sessionDigest));
    assert.ok(!JSON.stringify(error).includes(input.requestDigest));
    return true;
  });
};

test("validated receipt tuple executes fixed parameterized write transaction and commits the closed result", async () => {
  const f = fixture();
  const service = createWorkspaceAccessRevocations(f.pool);
  const result = await service.apply(input);
  assert.deepEqual(result, {
    outcome: "applied",
    revocationId: "revocation_a",
    policyRevision: 2,
    auditId: "audit_a",
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(service));
  assert.deepEqual(
    f.queries.map((query) => query.text),
    [sql.begin, sql.role, sql.timeout, sql.idleTimeout, sql.apply, sql.commit],
  );
  assert.deepEqual(f.queries.find((query) => query.text === sql.apply).values, [
    input.receiptId,
    input.commandId,
    input.requestDigest,
    input.sessionDigest,
    input.organizationId,
    input.workspaceId,
    input.targetMembershipId,
    "1",
  ]);
  assert.ok(Object.isFrozen(f.queries.find((query) => query.text === sql.apply).values));
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.connections, 1);
});

test("expected denial/conflict rows commit, including attributable denial audits", async () => {
  for (const row of [
    { outcome: "denied", revocation_id: null, policy_revision: null, audit_id: null },
    { outcome: "conflict", revocation_id: null, policy_revision: null, audit_id: null },
    { outcome: "denied", revocation_id: null, policy_revision: "3", audit_id: "audit_denial" },
  ]) {
    const f = fixture({ rows: [row] });
    const result = await createWorkspaceAccessRevocations(f.pool).apply(input);
    assert.equal(result.outcome, row.outcome);
    assert.equal(result.revocationId, null);
    assert.equal(result.auditId, row.audit_id);
    assert.equal(
      result.policyRevision,
      row.policy_revision === null ? null : Number(row.policy_revision),
    );
    assert.equal(f.queries.at(-1).text, sql.commit);
    assert.ok(!f.queries.some((query) => query.text === sql.rollback));
    assert.deepEqual(f.releases, [false]);
  }
});

test("input rejects unknown, missing, inherited, symbol and accessor authority before connecting", async () => {
  const accessor = { ...input };
  Object.defineProperty(accessor, "sessionDigest", {
    get() {
      throw Error("must not execute getter");
    },
    enumerable: true,
  });
  const symbol = { ...input, [Symbol("secret")]: "secret" };
  const missing = { ...input };
  delete missing.receiptId;
  const ownWithForeignPrototype = Object.assign(
    Object.create({ organizationId: "foreign" }),
    input,
  );
  for (const value of [
    null,
    [],
    missing,
    { ...input, approved: true },
    { ...input, grants: [] },
    accessor,
    symbol,
    ownWithForeignPrototype,
    Object.assign(Object.create(null), input),
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw Error("private prototype failure");
        },
      },
    ),
    new Proxy(
      { ...input },
      {
        ownKeys() {
          throw Error("private key failure");
        },
      },
    ),
  ]) {
    const f = fixture();
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply(value),
      "WORKSPACE_REVOCATION_INPUT_INVALID",
      null,
    );
    assert.equal(f.connections, 0);
  }
});

test("input validates canonical IDs/digests and non-coerced safe revisions before connecting", async () => {
  for (const change of [
    { receiptId: "" },
    { commandId: "command; DROP" },
    { organizationId: "../other" },
    { workspaceId: "workspace?" },
    { targetMembershipId: 3 },
    { requestDigest: "A".repeat(64) },
    { sessionDigest: "short" },
    { expectedRevision: "1" },
    { expectedRevision: 0 },
    { expectedRevision: 1.2 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedRevision: NaN },
    { expectedRevision: Infinity },
  ]) {
    const f = fixture();
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply({ ...input, ...change }),
      "WORKSPACE_REVOCATION_INPUT_INVALID",
      null,
    );
    assert.equal(f.connections, 0);
  }
});

test("all input selectors are copied before awaited pool access", async () => {
  const f = fixture();
  const mutable = { ...input };
  f.pool.connect = async () => {
    Object.assign(mutable, {
      receiptId: "foreign_receipt",
      commandId: "foreign_command",
      requestDigest: "c".repeat(64),
      sessionDigest: "d".repeat(64),
      organizationId: "foreign_org",
      workspaceId: "foreign_workspace",
      targetMembershipId: "foreign_member",
      expectedRevision: 900,
    });
    return f.client;
  };
  await createWorkspaceAccessRevocations(f.pool).apply(mutable);
  assert.deepEqual(f.queries.find((query) => query.text === sql.apply).values, [
    input.receiptId,
    input.commandId,
    input.requestDigest,
    input.sessionDigest,
    input.organizationId,
    input.workspaceId,
    input.targetMembershipId,
    "1",
  ]);
});

test("API, SET ROLE impersonation, owner/admin flags and inherited role membership deny command execution", async () => {
  for (const change of [
    { role: "morrow_api" },
    { login: "morrow_api" },
    { role: "morrow_identity_owner", login: "morrow_identity_owner" },
    { rolsuper: true },
    { rolbypassrls: true },
    { rolcreatedb: true },
    { rolcreaterole: true },
    { owner_member: true },
    { role_member: true },
    { rolsuper: "false" },
    { role_member: null },
  ]) {
    const f = fixture({ roleRows: [{ ...role, ...change }] });
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply(input),
      "WORKSPACE_REVOCATION_UNAVAILABLE",
    );
    assert.ok(!f.queries.some((query) => query.text === sql.apply));
    assert.equal(f.queries.at(-1).text, sql.rollback);
    assert.deepEqual(f.releases, [true]);
  }
});

test("ambiguous, malformed and accessor role rows cannot reach the mutator", async () => {
  let getterReads = 0;
  const getter = { ...role };
  Object.defineProperty(getter, "role_member", {
    get() {
      getterReads++;
      throw Error("private role getter");
    },
    enumerable: true,
  });
  for (const roleRows of [
    [],
    [{ ...role }, { ...role }],
    [{ ...role, secret: "extra" }],
    [getter],
    [{ ...role, [Symbol("private")]: "extra" }],
  ]) {
    const f = fixture({ roleRows });
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply(input),
      "WORKSPACE_REVOCATION_UNAVAILABLE",
    );
    assert.ok(!f.queries.some((query) => query.text === sql.apply));
    assert.deepEqual(f.releases, [true]);
  }
  assert.equal(getterReads, 0);
});

test("result decoder denies malformed outcomes, IDs, revision coercion and unexpected fields before commit", async () => {
  let getterReads = 0;
  const getter = { ...applied };
  Object.defineProperty(getter, "audit_id", {
    get() {
      getterReads++;
      throw Error("private result getter");
    },
    enumerable: true,
  });
  for (const rows of [
    [],
    [{ ...applied }, { ...applied }],
    [getter],
    [{ ...applied, secret: "extra" }],
    [{ ...applied, outcome: "success" }],
    [{ ...applied, revocation_id: null }],
    [{ ...applied, audit_id: null }],
    [{ ...applied, policy_revision: null }],
    [{ ...applied, revocation_id: "bad id" }],
    [{ ...applied, audit_id: 4 }],
    [{ ...applied, policy_revision: 2 }],
    [{ ...applied, policy_revision: "02" }],
    [{ ...applied, policy_revision: "0" }],
    [{ ...applied, policy_revision: "9007199254740992" }],
    [{ ...applied, policy_revision: "1" }],
    [{ ...applied, policy_revision: "3" }],
    [{ ...applied, outcome: "denied" }],
    [{ ...applied, outcome: "conflict" }],
    [{ outcome: "conflict", revocation_id: null, policy_revision: "2", audit_id: "audit_bad" }],
    [{ outcome: "denied", revocation_id: null, policy_revision: null, audit_id: "audit_bad" }],
    [{ outcome: "denied", revocation_id: null, policy_revision: "2", audit_id: null }],
    [{ ...applied, [Symbol("private")]: "extra" }],
    [{ outcome: "denied", revocation_id: null, policy_revision: undefined, audit_id: null }],
  ]) {
    const f = fixture({ rows });
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply(input),
      "WORKSPACE_REVOCATION_UNAVAILABLE",
    );
    assert.ok(!f.queries.some((query) => query.text === sql.commit));
    assert.equal(f.queries.at(-1).text, sql.rollback);
    assert.deepEqual(f.releases, [true]);
  }
  assert.equal(getterReads, 0);
});

test("connection failure is unavailable without SQL or release and leaks no proof", async () => {
  const f = fixture({ connectFails: true });
  await rejectsCode(
    createWorkspaceAccessRevocations(f.pool).apply(input),
    "WORKSPACE_REVOCATION_UNAVAILABLE",
  );
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.releases, []);
});

for (const phase of ["begin", "role", "timeout", "idleTimeout", "apply"])
  test(`unexpected ${phase} failure attempts rollback and discards the connection without retry`, async () => {
    const f = fixture({ failAt: sql[phase] });
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply(input),
      "WORKSPACE_REVOCATION_UNAVAILABLE",
    );
    assert.equal(f.queries.at(-1).text, sql.rollback);
    assert.equal(f.queries.filter((query) => query.text === sql[phase]).length, 1);
    assert.deepEqual(f.releases, [true]);
  });

test("rollback failure discards without claiming a completed transaction or retry", async () => {
  const f = fixture({ failAt: sql.apply, rollbackFails: true });
  await rejectsCode(
    createWorkspaceAccessRevocations(f.pool).apply(input),
    "WORKSPACE_REVOCATION_UNAVAILABLE",
  );
  assert.equal(f.queries.filter((query) => query.text === sql.rollback).length, 1);
  assert.ok(!f.queries.some((query) => query.text === sql.commit));
  assert.deepEqual(f.releases, [true]);
});

test("lost COMMIT acknowledgement is uncertain; it cannot be converted into a proven rollback", async () => {
  const f = fixture({ failAt: sql.commit });
  await rejectsCode(
    createWorkspaceAccessRevocations(f.pool).apply(input),
    "WORKSPACE_REVOCATION_UNCERTAIN",
  );
  assert.equal(f.queries.filter((query) => query.text === sql.apply).length, 1);
  assert.equal(f.queries.filter((query) => query.text === sql.commit).length, 1);
  assert.ok(!f.queries.some((query) => query.text === sql.rollback));
  assert.deepEqual(f.releases, [true]);
});

test("release failure after commit is uncertain, including asynchronous cleanup rejection", async () => {
  for (const options of [{ releaseThrows: true }, { releaseRejects: true }]) {
    const f = fixture(options);
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply(input),
      "WORKSPACE_REVOCATION_UNCERTAIN",
    );
    assert.equal(f.queries.at(-1).text, sql.commit);
    assert.deepEqual(f.releases, [false]);
  }
});

test("release failure before commit preserves unavailable classification and fixed error data", async () => {
  const f = fixture({ failAt: sql.role, releaseThrows: true });
  await rejectsCode(
    createWorkspaceAccessRevocations(f.pool).apply(input),
    "WORKSPACE_REVOCATION_UNAVAILABLE",
  );
  assert.equal(f.queries.at(-1).text, sql.rollback);
});

test("provider error proxy/accessor traps are ignored; SQL query text never embeds private proofs", async () => {
  const getter = Object.defineProperty(Error(), "message", {
    get() {
      throw Error("trap");
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error("trap");
      },
      getOwnPropertyDescriptor() {
        throw Error("trap");
      },
    },
  );
  for (const failure of [getter, proxy]) {
    const f = fixture({ failAt: sql.apply, failure });
    await rejectsCode(
      createWorkspaceAccessRevocations(f.pool).apply(input),
      "WORKSPACE_REVOCATION_UNAVAILABLE",
    );
    assert.ok(
      f.queries.every(
        (query) =>
          !query.text.includes(input.sessionDigest) && !query.text.includes(input.requestDigest),
      ),
    );
  }
});
