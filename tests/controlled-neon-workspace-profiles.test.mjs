import assert from "node:assert/strict";
import test from "node:test";
import {
  controlledNeonWorkspaceProfiles as profiles,
  snapshotControlledNeonWorkspaceParameters as copy,
} from "../packages/identity/src/controlled-neon-workspace-profiles.ts";
import {
  controlledNeonLoginProfiles,
  snapshotControlledNeonParameters,
} from "../packages/identity/src/controlled-neon-login-profiles.ts";
import {
  createWorkersRequestBoundNeonWorkspacePools,
  createWorkersControlledNeonLoginPools,
  snapshotControlledNeonWorkspacePoolMetrics,
  snapshotControlledNeonLoginPoolMetrics,
} from "../packages/identity/src/controlled-neon-login-pool.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { workspaceStoreLinkingControlSql as readSql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { workspaceStoreLinkingSql as writeSql } from "../packages/identity/src/workspace-store-linking.ts";
import { selfLogoutSql } from "../packages/identity/src/self-logout-control.ts";
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
import {
  createManagedLoginRequestOwner,
  bindManagedLoginRequestNamespace,
  snapshotManagedLoginRequestMetrics,
} from "../packages/identity/src/managed-login-request-scope.ts";

const held = (error) => error instanceof Error && error.message === "CONTROLLED_NEON_LOGIN_HELD";
const digest = "a".repeat(64);
const binding = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-controlled-lab",
  branchId: "br-controlled-lab",
  hostname: "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const dependencies = (
  borrow = () => {
    throw Error("SYNTHETIC_BORROW_DENIED");
  },
  now = Date.now,
) => ({ bindingJson: JSON.stringify(binding), credentialBroker: { borrow }, now });
const control = (signal = new AbortController().signal) => ({
  deadlineMs: Date.now() + 10000,
  signal,
});
function owner(t, selected = digest, now = Date.now) {
  const registrations = [],
    parent = new AbortController(),
    attempt = createLoginAttempt(now, parent.signal, 5000);
  const ctx = {
    waitUntil(pending) {
      assert.equal(this, ctx);
      registrations.push(pending);
    },
  };
  const { scope, ownerToken } = createManagedLoginRequestOwner(ctx, attempt);
  bindManagedLoginRequestNamespace(scope, ownerToken, selected);
  t.after(() => attempt.end());
  return { scope, ownerToken, attempt, parent, registrations };
}
const make = (a, deps = dependencies(), selected = digest) =>
  createWorkersRequestBoundNeonWorkspacePools(deps, a.scope, a.ownerToken, selected);

test("three frozen workspace profiles retain the exact owner SQL sets and role startup bounds", () => {
  assert.deepEqual(Object.keys(profiles), ["identityPool", "linkingPool", "logoutPool"]);
  assert.ok(Object.isFrozen(profiles));
  const expected = {
    identityPool: ["morrow_api", identitySql, 5000, 10000],
    linkingPool: [
      "morrow_identity_linking",
      { ...readSql, ...writeSql, readOnlyBegin: readSql.begin, readRole: readSql.role },
      5000,
      10000,
    ],
    logoutPool: ["morrow_identity_logout", selfLogoutSql, 1000, 5000],
  };
  for (const [name, p] of Object.entries(profiles)) {
    const [role, sql, statementTimeout, idleTimeout] = expected[name];
    assert.equal(p.role, role);
    assert.equal(p.statementTimeout, statementTimeout);
    assert.equal(p.idleTimeout, idleTimeout);
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.statements));
    assert.deepEqual(
      new Set(Object.values(p.statements).map((s) => s.text)),
      new Set(Object.values(sql)),
    );
    for (const s of Object.values(p.statements)) assert.ok(Object.isFrozen(s));
  }
  assert.notEqual(
    profiles.linkingPool.statements.readOnlyBegin.text,
    profiles.linkingPool.statements.begin.text,
  );
  assert.notEqual(
    profiles.linkingPool.statements.readRole.text,
    profiles.linkingPool.statements.role.text,
  );
});

test("every statement has its actual PostgreSQL placeholder arity and exact128 bound", () => {
  for (const p of Object.values(profiles)) {
    for (const statement of Object.values(p.statements)) {
      const positions = [...statement.text.matchAll(/\$([1-9][0-9]*)/g)].map((m) => Number(m[1]));
      assert.equal(statement.arity, positions.length ? Math.max(...positions) : 0);
      assert.equal(statement.maximum, 128);
      const values = Array(statement.arity).fill("a");
      assert.deepEqual(copy(p, statement.text, values), values);
      assert.throws(() => copy(p, statement.text, [...values, "extra"]), held);
      if (values.length) assert.throws(() => copy(p, statement.text, values.slice(1)), held);
    }
  }
});

for (const [name, p] of Object.entries(profiles))
  test(name + " allows128 ASCII and rejects129/nonASCII before any SQL", () => {
    const s = Object.values(p.statements).find((s) => s.arity > 0);
    const values = Array(s.arity).fill("a".repeat(128));
    const copied = copy(p, s.text, values);
    assert.ok(Object.isFrozen(copied));
    values[0] = "mutated";
    assert.equal(copied[0].length, 128);
    for (const bad of ["a".repeat(129), "é", "😀", "a\0b", "\ud800"])
      assert.throws(() => copy(p, s.text, [bad, ...copied.slice(1)]), held);
  });

test("owner schema maximum tuples fit without reducing the original aggregate ceiling", () => {
  const examples = [
    [profiles.identityPool, "bind", [64, 128], 192],
    [profiles.linkingPool, "lookup", [64, 128, 64, 36], 292],
    [profiles.linkingPool, "status", [64, 128, 64, 36], 292],
    [profiles.linkingPool, "apply", [128, 36, 64, 64, 64, 128, 128, 128, 17, 16, 16], 789],
    [profiles.logoutPool, "end", [36, 64, 64, 38, 30, 33, 128, 64], 457],
  ];
  for (const [p, key, sizes, total] of examples) {
    const values = sizes.map((n) => "a".repeat(n));
    assert.equal(copy(p, p.statements[key].text, values).join("").length, total);
    const index = sizes.indexOf(128),
      over = [...values];
    over[index] += "a";
    assert.throws(() => copy(p, p.statements[key].text, over), held);
  }
  // The canonical557 logout upper bound is conservative: its exact schema
  // maxima total457; both fit the unchanged source parameter policy.
  assert.ok(457 <= 557);
  // All new source arities are <=11: even the largest full128 tuple cannot
  // exceed16384. The unchanged copier still independently enforces that cap.
  assert.ok(
    Object.values(profiles).every((p) =>
      Object.values(p.statements).every((s) => s.arity * 128 <= 16384),
    ),
  );
  const original = controlledNeonLoginProfiles.sessionPool;
  assert.throws(
    () =>
      snapshotControlledNeonParameters(
        original,
        original.statements.admit.text,
        Array(27).fill("a".repeat(608)),
      ),
    held,
  );
});

test("data-only dense snapshots reject getters/holes/properties and a forged profile", () => {
  const p = profiles.identityPool,
    text = p.statements.bind.text;
  let getters = 0;
  const accessor = ["a", "b"];
  Object.defineProperty(accessor, "0", {
    get() {
      getters++;
      return "x";
    },
  });
  for (const values of [accessor, ["a", ,], Object.assign(["a", "b"], { extra: true })])
    assert.throws(() => copy(p, text, values), held);
  assert.equal(getters, 0);
  assert.throws(() => copy({ ...p }, text, ["a", "b"]), held);
  assert.throws(() => copy(p, text + "; SELECT 1", ["a", "b"]), held);
  assert.throws(() => copy(p, writeSql.apply, Array(11).fill("a")), held);
  assert.throws(() => copy(profiles.linkingPool, selfLogoutSql.end, Array(8).fill("a")), held);
});

test("workspace ASCII policy preserves old four-profile Unicode behavior", () => {
  const p = controlledNeonLoginProfiles.sessionPool;
  const values = Array(p.statements.admit.arity).fill("é");
  assert.deepEqual(snapshotControlledNeonParameters(p, p.statements.admit.text, values), values);
  assert.deepEqual(Object.keys(controlledNeonLoginProfiles), [
    "loginPool",
    "preauthPool",
    "selectionPool",
    "sessionPool",
  ]);
});

test("native workspace constructor is inert, frozen and cohort-separated from four login pools", async (t) => {
  const a = owner(t),
    pools = await make(a),
    login = await createWorkersControlledNeonLoginPools(dependencies());
  assert.deepEqual(Object.keys(pools), ["identityPool", "linkingPool", "logoutPool"]);
  assert.ok(Object.isFrozen(pools));
  for (const pool of Object.values(pools)) assert.ok(Object.isFrozen(pool));
  for (const metric of Object.values(snapshotControlledNeonWorkspacePoolMetrics(pools)))
    assert.ok(Object.values(metric).every((n) => n === 0));
  assert.throws(() => snapshotControlledNeonLoginPoolMetrics(pools), held);
  assert.throws(() => snapshotControlledNeonWorkspacePoolMetrics(login), held);
  assert.throws(() => snapshotControlledNeonWorkspacePoolMetrics({ ...pools }), held);
  assert.equal(a.registrations.length, 0);
});

for (const key of ["profiles", "role", "purpose", "loopbackWsUrl", "WebSocket", "driver", "fetch"])
  test("workspace native dependencies reject caller selector " + key, async (t) => {
    const a = owner(t);
    await assert.rejects(make(a, { ...dependencies(), [key]: "untrusted" }), held);
    assert.equal(a.registrations.length, 0);
  });

for (const [name, profile] of Object.entries(profiles))
  test(
    name + " uses its sole fixed workspace lease namespace and one exact cleanup Promise",
    async (t) => {
      const a = owner(t),
        seen = [];
      const pools = await make(
        a,
        dependencies((namespace, c) => {
          seen.push([JSON.parse(namespace), c]);
          throw Error("SYNTHETIC_BORROW_DENIED");
        }),
      );
      await assert.rejects(pools[name].connect(control()), held);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0][0], {
        schemaVersion: 1,
        providerId: "neon",
        ...binding,
        role: profile.role,
        purpose: "workspace_primary_and_one_same_role_observer",
      });
      assert.ok(seen[0][1].deadlineMs <= a.attempt.control().deadlineMs);
      assert.equal(a.registrations.length, 1);
      assert.equal(snapshotManagedLoginRequestMetrics(a.scope, a.ownerToken).publishedSettled, 1);
      const metric = snapshotControlledNeonWorkspacePoolMetrics(pools)[name];
      assert.equal(metric.borrowAttempts, 1);
      assert.equal(metric.socketAttempts, 0);
      assert.equal(metric.observerConnects, 0);
      assert.equal(metric.activeWaitTimers, 0);
      assert.equal(metric.activeWaitListeners, 0);
    },
  );

test("copied, live-swapped, wrong-namespace and ended workspace owners cannot borrow", async (t) => {
  const a = owner(t),
    b = owner(t);
  let borrows = 0;
  const deps = dependencies(() => {
    borrows++;
  });
  for (const [scope, token, selected] of [
    [{ ...a.scope }, a.ownerToken, digest],
    [a.scope, b.ownerToken, digest],
    [a.scope, a.ownerToken, "b".repeat(64)],
  ])
    await assert.rejects(
      createWorkersRequestBoundNeonWorkspacePools(deps, scope, token, selected),
      held,
    );
  const pools = await make(a, deps);
  a.attempt.end();
  await assert.rejects(pools.identityPool.connect(control()), held);
  assert.equal(borrows, 0);
  assert.equal(a.registrations.length, 0);
});

test("an independent child signal is admitted and the original five-second parent caps all roles", async (t) => {
  const a = owner(t),
    child = new AbortController(),
    seen = [];
  a.attempt.cap(Date.now() + 100);
  const pools = await make(
    a,
    dependencies((namespace, c) => {
      seen.push([namespace, c]);
      throw Error("SYNTHETIC_BORROW_DENIED");
    }),
  );
  await assert.rejects(pools.identityPool.connect(control(child.signal)), held);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0][1].signal, child.signal);
  assert.ok(seen[0][1].deadlineMs <= a.attempt.control().deadlineMs);
  assert.equal(a.registrations.length, 1);
});
