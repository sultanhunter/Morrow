import test from "node:test";
import assert from "node:assert/strict";
import {
  withIdentityRead,
  IdentityAccessError,
  identitySql,
} from "../packages/identity/src/index.ts";
import { inspectImports } from "../scripts/boundary-checks.mjs";
const proof = "a".repeat(64); // In-memory synthetic proof only, no issuer.
const context = {
  principal_id: "human_a",
  organization_id: "org_a",
  workspace_id: "workspace_a",
  membership_id: "membership_a",
  policy_revision: "1",
};
function database({
  row = context,
  role = "morrow_api",
  login = "morrow_api",
  ownerMember = false,
  revoked = false,
  fail = null,
  rollbackFails = false,
} = {}) {
  const calls = [];
  const releases = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text === fail || (text === identitySql.rollback && rollbackFails))
        throw Error("arbitrary upstream details");
      if (text === identitySql.role)
        return {
          rows: [
            {
              role,
              login,
              rolsuper: false,
              rolbypassrls: false,
              rolcreatedb: false,
              rolcreaterole: false,
              owner_member: ownerMember,
            },
          ],
        };
      if (text === identitySql.resolve) return { rows: row ? [row] : [] };
      if (text === identitySql.workspace)
        return {
          rows: revoked
            ? []
            : [{ id: "workspace_a", organization_id: "org_a", display_name: "Synthetic A" }],
        };
      return { rows: [] };
    },
    release(discard) {
      releases.push(discard);
    },
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    calls,
    releases,
  };
}
test("resolved server identity carries no installation/mandate grant, queries are parameterized", async () => {
  const db = database();
  const value = await withIdentityRead(db.pool, proof, "workspace_a", async (scope) => ({
    identity: scope.identity,
    workspace: await scope.readWorkspace(),
  }));
  assert.equal(value.identity.actor.organizationId, "org_a");
  assert.equal(value.identity.actor.installationId, null);
  assert.equal(value.identity.policyRevision, 1);
  assert.deepEqual(db.calls.find((c) => c.text === identitySql.bind).values, [
    proof,
    "workspace_a",
  ]);
  assert.ok(db.calls.every((c) => !c.text.includes(proof)));
  assert.equal(db.calls.at(-1).text, identitySql.commit);
  assert.deepEqual(db.releases, [false]);
});
for (const [name, row] of [
  ["missing", null],
  ["wrong workspace", { ...context, workspace_id: "workspace_b" }],
  ["extra field", { ...context, role: "admin" }],
  ["unsafe revision", { ...context, policy_revision: "9007199254740992" }],
  ["coerced revision", { ...context, policy_revision: 1 }],
  ["malformed principal", { ...context, principal_id: "x/escape" }],
])
  test("denies " + name + " resolution", async () => {
    const db = database({ row });
    await assert.rejects(
      withIdentityRead(db.pool, proof, "workspace_a", async () => true),
      (e) => e.code === "IDENTITY_DENIED",
    );
    assert.equal(db.calls.at(-1).text, identitySql.rollback);
    assert.deepEqual(db.releases, [false]);
  });
test("invalid proof/workspace is denied before acquiring database", async () => {
  let connects = 0;
  const pool = {
    async connect() {
      connects++;
      throw Error();
    },
  };
  for (const [digest, workspace] of [
    ["not-a-proof", "workspace_a"],
    [proof, "../workspace"],
  ])
    await assert.rejects(
      withIdentityRead(pool, digest, workspace, async () => {}),
      IdentityAccessError,
    );
  assert.equal(connects, 0);
});
test("a privileged/unexpected SQL login cannot qualify tenant reads", async () => {
  const db = database({ role: "postgres" });
  await assert.rejects(
    withIdentityRead(db.pool, proof, "workspace_a", async () => true),
    (e) => e.code === "IDENTITY_DENIED",
  );
  assert.ok(!db.calls.some((c) => c.text === identitySql.bind));
});
test("revocation denies a later read despite already resolved context", async () => {
  const db = database({ revoked: true });
  await assert.rejects(
    withIdentityRead(db.pool, proof, "workspace_a", (scope) => scope.readWorkspace()),
    (e) => e.code === "IDENTITY_DENIED",
  );
});
test("a retained scope cannot use a released connection", async () => {
  const db = database();
  let retained;
  await withIdentityRead(db.pool, proof, "workspace_a", async (scope) => {
    retained = scope;
  });
  const n = db.calls.length;
  await assert.rejects(retained.readWorkspace(), (e) => e.code === "IDENTITY_DENIED");
  assert.equal(db.calls.length, n);
});
for (const fail of [identitySql.begin, identitySql.bind, identitySql.resolve, identitySql.commit])
  test("transaction failure is redacted and rolled back: " + fail.split(" ")[0], async () => {
    const db = database({ fail });
    await assert.rejects(
      withIdentityRead(db.pool, proof, "workspace_a", async () => true),
      (e) => e.message === "IDENTITY_UNAVAILABLE" && e.cause === undefined,
    );
    assert.equal(db.calls.at(-1).text, identitySql.rollback);
    assert.deepEqual(db.releases, [false]);
  });
test("an uncertain rollback discards rather than reuses the connection", async () => {
  const db = database({ fail: identitySql.bind, rollbackFails: true });
  await assert.rejects(withIdentityRead(db.pool, proof, "workspace_a", async () => {}));
  assert.deepEqual(db.releases, [true]);
});
test("callback failure rolls back and never exposes arbitrary details", async () => {
  const db = database();
  await assert.rejects(
    withIdentityRead(db.pool, proof, "workspace_a", async () => {
      throw Error("merchant/provider payload");
    }),
    (e) => e.message === "IDENTITY_UNAVAILABLE",
  );
  assert.equal(db.calls.at(-1).text, identitySql.rollback);
});
for (const path of ["apps/workspace-web/src/view.tsx", "packages/contracts/src/index.ts"])
  test("identity persistence cannot be imported across " + path, () => {
    assert.ok(
      inspectImports(path, "import {withIdentityRead} from '@morrow/identity'").includes(
        "TRUST_BOUNDARY_IMPORT",
      ),
    );
  });

test("a privileged connection disguised with SET ROLE cannot qualify", async () => {
  const db = database({ login: "postgres" });
  await assert.rejects(
    withIdentityRead(db.pool, proof, "workspace_a", async () => true),
    (e) => e.code === "IDENTITY_DENIED",
  );
  assert.ok(!db.calls.some((c) => c.text === identitySql.bind));
});

test("runtime owner membership added after migration fails closed", async () => {
  const db = database({ ownerMember: true });
  await assert.rejects(
    withIdentityRead(db.pool, proof, "workspace_a", async () => true),
    (e) => e.code === "IDENTITY_DENIED",
  );
  assert.ok(!db.calls.some((c) => c.text === identitySql.bind));
});
