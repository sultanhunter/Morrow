import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceStoreLinks,
  workspaceStoreLinkingSql as sql,
  WorkspaceStoreLinkingError,
} from "../packages/identity/src/workspace-store-linking.ts";

const input = {
  handoffId: "handoff_a",
  commandId: "command_a",
  requestDigest: "a".repeat(64),
  sessionDigest: "b".repeat(64),
  nonceDigest: "c".repeat(64),
  organizationId: "org_a",
  workspaceId: "workspace_a",
  installationId: "installation_a",
  purpose: "workspace_first",
  expectedPolicyRevision: 7,
  expectedOwnershipRevision: 3,
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
};
const applied = {
  outcome: "applied",
  link_id: "link_a",
  ownership_revision: "4",
  policy_revision: "8",
  audit_id: "audit_a",
};
const encode = (patch = {}) => JSON.stringify({ ...input, ...patch });
function fixture(options = {}) {
  const queries = [],
    releases = [];
  let connections = 0;
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (options.failAt === text || (options.rollbackFails && text === sql.rollback))
        throw options.failure ?? Error(`private details ${input.sessionDigest}`);
      if (text === sql.role) return { rows: options.roleRows ?? [{ ...role }] };
      if (text === sql.apply) return { rows: options.rows ?? [{ ...applied }] };
      return { rows: [] };
    },
    release(discard) {
      releases.push(discard);
      if (options.releaseThrows) throw Error(`private cleanup ${input.nonceDigest}`);
      if (options.releaseRejects)
        return Promise.reject(Error(`private async cleanup ${input.requestDigest}`));
    },
  };
  return {
    queries,
    releases,
    client,
    get connections() {
      return connections;
    },
    pool: {
      async connect() {
        connections++;
        if (options.connectFails)
          throw options.failure ?? Error(`private connection ${input.sessionDigest}`);
        if (options.beforeConnect) await options.beforeConnect();
        return client;
      },
    },
  };
}
async function rejectsCode(promise, code, commandId = input.commandId) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WorkspaceStoreLinkingError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.commandId, commandId);
    assert.equal(Object.hasOwn(error, "cause"), false);
    for (const secret of [input.requestDigest, input.sessionDigest, input.nonceDigest])
      assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
}
test("closed JSON tuple calls the dedicated fixed parameterized transaction exactly once", async () => {
  const f = fixture(),
    service = createWorkspaceStoreLinks(f.pool);
  const result = await service.apply(encode());
  assert.deepEqual(result, {
    outcome: "applied",
    linkId: "link_a",
    ownershipRevision: 4,
    policyRevision: 8,
    auditId: "audit_a",
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(service));
  assert.deepEqual(
    f.queries.map((x) => x.text),
    [sql.begin, sql.role, sql.timeout, sql.idleTimeout, sql.apply, sql.commit],
  );
  const parameters = f.queries.find((x) => x.text === sql.apply).values;
  assert.deepEqual(parameters, [...Object.values(input).slice(0, 9), "7", "3"]);
  assert.ok(Object.isFrozen(parameters));
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.connections, 1);
});
test("raw objects, proxies and accessors are rejected without any reflection or traps", async () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error("trap");
      },
      getPrototypeOf() {
        traps++;
        throw Error("trap");
      },
      ownKeys() {
        traps++;
        throw Error("trap");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw Error("trap");
      },
    },
  );
  const accessor = {
    get handoffId() {
      traps++;
      throw Error("getter");
    },
  };
  for (const value of [
    input,
    hostile,
    accessor,
    Object(input),
    new String(encode()),
    null,
    undefined,
    3,
    false,
    [],
  ]) {
    const f = fixture();
    await rejectsCode(
      createWorkspaceStoreLinks(f.pool).apply(value),
      "WORKSPACE_LINKING_INPUT_INVALID",
      null,
    );
    assert.equal(f.connections, 0);
  }
  assert.equal(traps, 0);
});
test("malformed, oversized, unknown, missing and nonscalar JSON deny before database connection", async () => {
  const missing = { ...input };
  delete missing.nonceDigest;
  const invalid = [
    "",
    "{bad",
    "null",
    "[]",
    "true",
    '"fixture"',
    " ".repeat(8193),
    JSON.stringify(missing),
    encode({ extra: true }),
    encode({ handoffId: {} }),
    encode({ purpose: ["workspace_first"] }),
    encode({ requestDigest: "A".repeat(64) }),
    encode({ sessionDigest: "b".repeat(63) }),
    encode({ nonceDigest: null }),
    encode({ commandId: "" }),
    encode({ installationId: "x".repeat(129) }),
    encode({ organizationId: "org/a" }),
    encode({ expectedPolicyRevision: "7" }),
    encode({ expectedOwnershipRevision: 0 }),
    encode({ expectedOwnershipRevision: 1.5 }),
    encode({ expectedPolicyRevision: 9007199254740992 }),
    encode({ purpose: "transfer" }),
    encode({ __proto_field: true }),
    encode({ constructor: true }),
    '{"__proto__":{}}',
  ];
  for (const value of invalid) {
    const f = fixture();
    await rejectsCode(
      createWorkspaceStoreLinks(f.pool).apply(value),
      "WORKSPACE_LINKING_INPUT_INVALID",
      null,
    );
    assert.equal(f.connections, 0);
  }
});
test("8192-character primitive JSON is accepted but 8193 is not", async () => {
  const data = encode(),
    padded = data + " ".repeat(8192 - data.length);
  await createWorkspaceStoreLinks(fixture().pool).apply(padded);
  const f = fixture();
  await rejectsCode(
    createWorkspaceStoreLinks(f.pool).apply(padded + " "),
    "WORKSPACE_LINKING_INPUT_INVALID",
    null,
  );
  assert.equal(f.connections, 0);
});
test("all frozen purposes pass to SQL where cross_host_resume first claim is denied", async () => {
  for (const purpose of [
    "install_first",
    "workspace_first",
    "existing_account",
    "additional_store",
    "cross_host_resume",
  ]) {
    const f = fixture({
      rows: [
        {
          outcome: "denied",
          link_id: null,
          ownership_revision: null,
          policy_revision: null,
          audit_id: null,
        },
      ],
    });
    await createWorkspaceStoreLinks(f.pool).apply(encode({ purpose }));
    assert.equal(f.queries.find((x) => x.text === sql.apply).values[8], purpose);
  }
});
test("input scalars are captured before awaiting a connection", async () => {
  let mutable = { ...input },
    encoded = JSON.stringify(mutable);
  const f = fixture({
    beforeConnect: async () => {
      mutable.installationId = "foreign";
      mutable.commandId = "foreign";
      encoded = encode({ installationId: "foreign" });
    },
  });
  await createWorkspaceStoreLinks(f.pool).apply(encoded);
  assert.equal(f.queries.find((x) => x.text === sql.apply).values[7], input.installationId);
  assert.equal(f.queries.find((x) => x.text === sql.apply).values[1], input.commandId);
});
test("denied and conflict nullable result combinations commit without retry", async () => {
  for (const row of [
    {
      outcome: "denied",
      link_id: null,
      ownership_revision: null,
      policy_revision: null,
      audit_id: null,
    },
    {
      outcome: "conflict",
      link_id: null,
      ownership_revision: null,
      policy_revision: null,
      audit_id: null,
    },
    {
      outcome: "denied",
      link_id: null,
      ownership_revision: null,
      policy_revision: "9",
      audit_id: "audit_denial",
    },
  ]) {
    const f = fixture({ rows: [row] }),
      result = await createWorkspaceStoreLinks(f.pool).apply(encode());
    assert.equal(result.outcome, row.outcome);
    assert.equal(result.linkId, null);
    assert.equal(result.ownershipRevision, null);
    assert.equal(
      result.policyRevision,
      row.policy_revision === null ? null : Number(row.policy_revision),
    );
    assert.equal(result.auditId, row.audit_id);
    assert.equal(f.queries.at(-1).text, sql.commit);
    assert.equal(f.queries.filter((x) => x.text === sql.apply).length, 1);
  }
});
test("forbidden roles, memberships, aliases and malformed role rows rollback before apply", async () => {
  const patches = [
    { role: "morrow_api" },
    { role: "morrow_identity_lifecycle" },
    { role: "morrow_identity_owner" },
    { login: "morrow_api" },
    ...[
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "rolinherit",
      "owner_member",
      "role_member",
    ].map((key) => ({ [key]: true })),
    { owner_member: "false" },
    { extra: false },
  ];
  for (const rows of [[], [{ ...role }, { ...role }], ...patches.map((p) => [{ ...role, ...p }])]) {
    const f = fixture({ roleRows: rows });
    await rejectsCode(
      createWorkspaceStoreLinks(f.pool).apply(encode()),
      "WORKSPACE_LINKING_UNAVAILABLE",
    );
    assert.ok(!f.queries.some((x) => x.text === sql.apply));
    assert.equal(f.queries.at(-1).text, sql.rollback);
    assert.deepEqual(f.releases, [true]);
  }
});
test("strict reply matrix rejects wrong revisions, unauthorized facts and malformed shapes", async () => {
  const rows = [
    [],
    [applied, applied],
    [{ ...applied, extra: true }],
    [{ ...applied, outcome: "unknown" }],
    ...["link_id", "audit_id", "ownership_revision", "policy_revision"].map((key) => [
      { ...applied, [key]: null },
    ]),
    ...["0", "04", "4.0", 4, "9007199254740992", "NaN"].map((value) => [
      { ...applied, ownership_revision: value },
    ]),
    [{ ...applied, ownership_revision: "3" }],
    [{ ...applied, ownership_revision: "5" }],
    [{ ...applied, policy_revision: "7" }],
    [{ ...applied, policy_revision: "9" }],
    [{ ...applied, link_id: "bad/id" }],
    [{ ...applied, audit_id: {} }],
    [
      {
        outcome: "denied",
        link_id: "leak",
        ownership_revision: null,
        policy_revision: null,
        audit_id: null,
      },
    ],
    [
      {
        outcome: "denied",
        link_id: null,
        ownership_revision: "4",
        policy_revision: "8",
        audit_id: "audit_a",
      },
    ],
    [
      {
        outcome: "denied",
        link_id: null,
        ownership_revision: null,
        policy_revision: "8",
        audit_id: null,
      },
    ],
    [
      {
        outcome: "denied",
        link_id: null,
        ownership_revision: null,
        policy_revision: null,
        audit_id: "audit_a",
      },
    ],
    [
      {
        outcome: "conflict",
        link_id: null,
        ownership_revision: null,
        policy_revision: "8",
        audit_id: "audit_a",
      },
    ],
  ];
  for (const reply of rows) {
    const f = fixture({ rows: reply });
    await rejectsCode(
      createWorkspaceStoreLinks(f.pool).apply(encode()),
      "WORKSPACE_LINKING_UNAVAILABLE",
    );
    assert.equal(f.queries.at(-1).text, sql.rollback);
    assert.ok(!f.queries.some((x) => x.text === sql.commit));
    assert.equal(f.queries.filter((x) => x.text === sql.apply).length, 1);
  }
});
test("precommit query failures rollback and discard without retrying or exposing errors", async () => {
  for (const failAt of [sql.begin, sql.role, sql.timeout, sql.idleTimeout, sql.apply]) {
    const f = fixture({ failAt, rollbackFails: true });
    await rejectsCode(
      createWorkspaceStoreLinks(f.pool).apply(encode()),
      "WORKSPACE_LINKING_UNAVAILABLE",
    );
    assert.equal(f.queries.at(-1).text, sql.rollback);
    assert.deepEqual(f.releases, [true]);
    assert.ok(f.queries.filter((x) => x.text === sql.apply).length <= 1);
  }
});
test("COMMIT acknowledgement loss stays uncertain and never sends rollback or a second write", async () => {
  const f = fixture({ failAt: sql.commit });
  await rejectsCode(
    createWorkspaceStoreLinks(f.pool).apply(encode()),
    "WORKSPACE_LINKING_UNCERTAIN",
  );
  assert.equal(f.queries.at(-1).text, sql.commit);
  assert.equal(f.queries.filter((x) => x.text === sql.apply).length, 1);
  assert.ok(!f.queries.some((x) => x.text === sql.rollback));
  assert.deepEqual(f.releases, [true]);
});
test("synchronous and asynchronous release failure after COMMIT remain uncertain", async () => {
  for (const option of ["releaseThrows", "releaseRejects"]) {
    const f = fixture({ [option]: true });
    await rejectsCode(
      createWorkspaceStoreLinks(f.pool).apply(encode()),
      "WORKSPACE_LINKING_UNCERTAIN",
    );
    assert.equal(f.queries.at(-1).text, sql.commit);
    assert.equal(f.queries.filter((x) => x.text === sql.apply).length, 1);
  }
});
test("connection and precommit release failures remain unavailable without inspecting hostile errors", async () => {
  let traps = 0;
  const failure = new Proxy(
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
  const f = fixture({ connectFails: true, failure });
  await rejectsCode(
    createWorkspaceStoreLinks(f.pool).apply(encode()),
    "WORKSPACE_LINKING_UNAVAILABLE",
  );
  assert.equal(f.queries.length, 0);
  assert.equal(f.releases.length, 0);
  const g = fixture({ failAt: sql.apply, failure, releaseRejects: true });
  await rejectsCode(
    createWorkspaceStoreLinks(g.pool).apply(encode()),
    "WORKSPACE_LINKING_UNAVAILABLE",
  );
  assert.equal(traps, 0);
});
