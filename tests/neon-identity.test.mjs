import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neonConfig } from "@neondatabase/serverless";
import { createNeonIdentityClient, withNeonIdentityRead } from "../packages/identity/src/neon.ts";
import { withDriverIdentityRead } from "../packages/identity/src/neon-request.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { inspectImports } from "../scripts/boundary-checks.mjs";

const binding = {
  environment: "staging",
  projectId: "fixture-project",
  branchId: "br-fixture",
  hostname: "ep-fixture.us-east-2.aws.neon.tech",
  database: "morrow",
};
const proof = "a".repeat(64);
// Synthetic in-memory value; no provider credential or issuer is present.
const secret = randomUUID();
function fixture({
  tenant = "a",
  fail = null,
  badRole = false,
  connectFails = false,
  endFails = false,
  rollbackFails = false,
  endWait = null,
} = {}) {
  const calls = [];
  let errorListener,
    ends = 0,
    connects = 0,
    observedBinding;
  const driver = {
    on(event, listener) {
      assert.equal(event, "error");
      errorListener = listener;
      return this;
    },
    async connect() {
      connects++;
      if (connectFails) throw Error(secret);
    },
    async query(text, values) {
      calls.push({ text, values });
      if (text === fail || (text === identitySql.rollback && rollbackFails)) throw Error(secret);
      if (text === identitySql.bind) observedBinding = [...values];
      if (text === identitySql.role)
        return {
          rows: [
            {
              role: badRole ? "postgres" : "morrow_api",
              login: "morrow_api",
              rolsuper: false,
              rolbypassrls: false,
              rolcreatedb: false,
              rolcreaterole: false,
              owner_member: false,
            },
          ],
        };
      if (text === identitySql.resolve)
        return {
          rows: [
            {
              principal_id: `human_${tenant}`,
              organization_id: `org_${tenant}`,
              workspace_id: `workspace_${tenant}`,
              membership_id: `membership_${tenant}`,
              policy_revision: "1",
            },
          ],
        };
      if (text === identitySql.workspace)
        return {
          rows: [
            {
              id: `workspace_${tenant}`,
              organization_id: `org_${tenant}`,
              display_name: `Fixture ${tenant}`,
            },
          ],
        };
      return { rows: [] };
    },
    async end() {
      ends++;
      if (endWait) await endWait;
      if (endFails) throw Error(secret);
    },
  };
  return {
    driver,
    calls,
    get connects() {
      return connects;
    },
    get ends() {
      return ends;
    },
    get binding() {
      return observedBinding;
    },
    fault() {
      errorListener();
    },
  };
}
const read = (
  db,
  callback = (scope) => scope.readWorkspace(),
  digest = proof,
  workspace = "workspace_a",
) => withDriverIdentityRead(() => db.driver, digest, workspace, callback);
const unavailable = (error) => {
  assert.equal(error.code, "IDENTITY_UNAVAILABLE");
  assert.equal(error.message, "IDENTITY_UNAVAILABLE");
  assert.equal(error.cause, undefined);
  assert.ok(!error.stack.includes(secret));
  return true;
};

test("installed SDK uses explicit role, endpoint and per-client secure transport settings without connecting", () => {
  const oldSecure = neonConfig.useSecureWebSocket,
    oldProxy = neonConfig.wsProxy;
  try {
    neonConfig.useSecureWebSocket = false;
    neonConfig.wsProxy = "unreviewed.invalid/v2";
    const client = createNeonIdentityClient(binding, secret);
    assert.equal(client.host, binding.hostname);
    assert.equal(client.user, "morrow_api");
    assert.equal(client.database, "morrow");
    assert.equal(client.neonConfig.useSecureWebSocket, true);
    assert.equal(client.neonConfig.forceDisablePgSSL, true);
    assert.equal(client.neonConfig.wsProxy, `${binding.hostname}/v2`);
    assert.equal(client.neonConfig.pipelineConnect, false);
    assert.equal(client.neonConfig.webSocketConstructor, WebSocket);
    assert.equal(neonConfig.wsProxy, "unreviewed.invalid/v2");
  } finally {
    neonConfig.useSecureWebSocket = oldSecure;
    neonConfig.wsProxy = oldProxy;
  }
});
for (const [name, delta] of [
  ["production before qualification", { environment: "production" }],
  ["private network endpoint", { hostname: "127.0.0.1" }],
  ["provider suffix impersonation", { hostname: binding.hostname + ".evil.invalid" }],
  ["URL proxy or options", { hostname: "https://" + binding.hostname + "/?sslmode=disable" }],
  ["uppercase ambiguous hostname", { hostname: binding.hostname.toUpperCase() }],
  ["database path injection", { database: "morrow/other" }],
  ["missing branch binding", { branchId: "" }],
  ["unreviewed role override", { user: "postgres" }],
])
  test("connection configuration rejects " + name, () => {
    assert.throws(() => createNeonIdentityClient({ ...binding, ...delta }, secret), unavailable);
  });
test("malformed credentials and selector types reject without disclosing the credential", () => {
  for (const field of ["projectId", "branchId", "hostname", "database"])
    for (const value of [123, undefined, { toString: () => binding[field] }])
      assert.throws(
        () => createNeonIdentityClient({ ...binding, [field]: value }, secret),
        unavailable,
      );
  for (const value of ["", null, "x".repeat(1025), secret + "\n"])
    assert.throws(() => createNeonIdentityClient(binding, value), unavailable);
});
test("invalid proof denies before SDK allocation or connection", async () => {
  let allocations = 0;
  await assert.rejects(
    withDriverIdentityRead(
      () => {
        allocations++;
        throw Error();
      },
      "invalid",
      "workspace_a",
      async () => true,
    ),
    (e) => e.code === "IDENTITY_DENIED",
  );
  assert.equal(allocations, 0);
  await assert.rejects(
    withNeonIdentityRead(binding, secret, "invalid", "workspace_a", async () => true),
    (e) => e.code === "IDENTITY_DENIED",
  );
});
test("successful read commits, binds proof as parameters, closes once and invalidates retained scope", async () => {
  const db = fixture();
  let retained;
  assert.equal(
    (
      await read(db, async (scope) => {
        retained = scope;
        return scope.readWorkspace();
      })
    ).organizationId,
    "org_a",
  );
  assert.deepEqual(db.binding, [proof, "workspace_a"]);
  assert.ok(db.calls.every((call) => !call.text.includes(proof)));
  assert.equal(db.calls.at(-1).text, identitySql.commit);
  assert.equal(db.connects, 1);
  assert.equal(db.ends, 1);
  const previous = db.calls.length;
  await assert.rejects(retained.readWorkspace(), (e) => e.code === "IDENTITY_DENIED");
  assert.equal(db.calls.length, previous);
});
test("return waits for driver shutdown even after a clean commit", async () => {
  let finish;
  const endWait = new Promise((resolve) => {
    finish = resolve;
  });
  const db = fixture({ endWait });
  let returned = false;
  const result = read(db).then((value) => {
    returned = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.ends, 1);
  assert.equal(returned, false);
  finish();
  await result;
  assert.equal(returned, true);
});
test("privileged login denial rolls back and closes", async () => {
  const db = fixture({ badRole: true });
  await assert.rejects(read(db), (e) => e.code === "IDENTITY_DENIED");
  assert.equal(db.calls.at(-1).text, identitySql.rollback);
  assert.equal(db.ends, 1);
});
for (const phase of [
  identitySql.begin,
  identitySql.resolve,
  identitySql.workspace,
  identitySql.commit,
])
  test(
    "SQL failure at " + phase.split(" ")[0] + " closes and redacts upstream details",
    async () => {
      const db = fixture({ fail: phase });
      await assert.rejects(read(db), unavailable);
      assert.equal(db.calls.at(-1).text, identitySql.rollback);
      assert.equal(db.ends, 1);
    },
  );
test("connection failure still closes its allocated driver", async () => {
  const db = fixture({ connectFails: true });
  await assert.rejects(read(db), unavailable);
  assert.equal(db.calls.length, 0);
  assert.equal(db.ends, 1);
});
test("rollback failure does not leak provider error or retain a reusable driver", async () => {
  const db = fixture({ fail: identitySql.workspace, rollbackFails: true });
  await assert.rejects(read(db), unavailable);
  assert.equal(db.ends, 1);
});
test("failed shutdown blocks a successful result", async () => {
  const db = fixture({ endFails: true });
  await assert.rejects(read(db), unavailable);
  assert.equal(db.calls.at(-1).text, identitySql.commit);
  assert.equal(db.ends, 1);
});
test("background connection error fails closed and cannot disclose raw provider error", async () => {
  const db = fixture();
  await assert.rejects(
    read(db, async (scope) => {
      db.fault();
      return scope.readWorkspace();
    }),
    unavailable,
  );
  assert.ok(!db.calls.some((call) => call.text === identitySql.commit));
  assert.equal(db.ends, 1);
});
test("concurrent tenant reads use distinct drivers and cannot return each other's context", async () => {
  const a = fixture(),
    b = fixture({ tenant: "b" });
  const result = await Promise.all([
    read(a),
    read(b, (scope) => scope.readWorkspace(), "b".repeat(64), "workspace_b"),
  ]);
  assert.deepEqual(
    result.map((value) => value.organizationId),
    ["org_a", "org_b"],
  );
  assert.deepEqual(a.binding, [proof, "workspace_a"]);
  assert.deepEqual(b.binding, ["b".repeat(64), "workspace_b"]);
  assert.equal(a.ends, 1);
  assert.equal(b.ends, 1);
  const mismatched = fixture({ tenant: "b" });
  await assert.rejects(read(mismatched), (e) => e.code === "IDENTITY_DENIED");
  assert.equal(mismatched.ends, 1);
});
test("workspace code cannot import the server Neon adapter", () => {
  assert.ok(
    inspectImports(
      "apps/workspace-web/src/escape.ts",
      'import {withNeonIdentityRead} from "@morrow/identity/neon"',
    ).includes("TRUST_BOUNDARY_IMPORT"),
  );
});
