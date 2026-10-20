// M2 PR-1 runtime lease helpers (mvp-architecture §5; ADR-0022 item 9) with a fake pool.
// The same helpers run against PostgreSQL 17 as morrow_runtime_executor in
// lab:spine-foundation (T1-T3).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createRuntimeAttempt,
  decodeEnteredLease,
  leaseTermsMs,
  listPendingStarts,
  parseLeaseRef,
  runLeaseStep,
  runtimeExecutorProfile,
  runtimeExecutorSql,
} from "../packages/work/src/runtime/leases.ts";
import { executorRoleMemberSql } from "../packages/identity/src/executor-role-preflight.ts";

const roleRow = (change = {}) => ({
  role: "morrow_runtime_executor",
  login: "morrow_runtime_executor",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  role_member: false,
  ...change,
});
const entered = (change = {}) => ({
  outcome: "entered",
  organization_id: "org_1",
  workspace_id: "ws_1",
  kind: "run",
  subject_id: "run_1",
  store_id: "store_1",
  connection_id: "connection_1",
  installation_id: "installation_1",
  initiator_principal_id: "person_1",
  initiator_membership_id: "membership_1",
  expires_at_ms: "1790000000000",
  ...change,
});
const refusedRow = (outcome) => ({
  outcome,
  organization_id: null,
  workspace_id: null,
  kind: null,
  subject_id: null,
  store_id: null,
  connection_id: null,
  installation_id: null,
  initiator_principal_id: null,
  initiator_membership_id: null,
  expires_at_ms: null,
});
// A fake pool: one client per connect, every statement recorded, replies by text.
function fakePool(reply) {
  const sent = [];
  let connects = 0,
    releases = 0;
  return {
    sent,
    get connects() {
      return connects;
    },
    get releases() {
      return releases;
    },
    pool: {
      async connect() {
        connects++;
        return {
          async query(text, values) {
            sent.push([text, values]);
            if (text === runtimeExecutorSql.role) return { rows: [roleRow()] };
            const rows = reply(text, values);
            if (rows instanceof Error) throw rows;
            return { rows: rows ?? [] };
          },
          async release() {
            releases++;
          },
        };
      },
    },
  };
}
const attempt = () => createRuntimeAttempt(5000, new AbortController().signal);
const ref = () => ({ leaseId: randomUUID(), generation: 1 });

test("statements: fixed text, no role change, the ADR-0020 D5 preflight and the definers only", () => {
  assert.equal(runtimeExecutorSql.begin, "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
  assert.ok(runtimeExecutorSql.role.includes(executorRoleMemberSql));
  for (const [name, text] of Object.entries(runtimeExecutorSql)) {
    assert.doesNotMatch(
      text,
      /SET (LOCAL )?ROLE|set_config|\bINSERT\b|\bUPDATE\b|\bDELETE\b/,
      name,
    );
    if (/^(enterLease|pendingStarts|markStarted|release)$/.test(name))
      assert.match(
        text,
        /^SELECT .*\bmorrow_work\.(enter_lease|pending_starts|lease_mark_started|lease_release)\(/,
        name,
      );
  }
  assert.equal(
    runtimeExecutorSql.enterLease,
    "SELECT outcome,organization_id,workspace_id,kind,subject_id,store_id,connection_id,installation_id,initiator_principal_id,initiator_membership_id,expires_at_ms FROM morrow_work.enter_lease($1,$2)",
  );
  assert.deepEqual(runtimeExecutorProfile.settings, [
    "SET LOCAL statement_timeout='2s'",
    "SET LOCAL lock_timeout='1s'",
    "SET LOCAL idle_in_transaction_session_timeout='5s'",
    "SET LOCAL transaction_timeout='5s'",
  ]);
  // The 0020 terms: read 60 s, run 30 min, operation 15 min.
  assert.deepEqual(leaseTermsMs, { read: 60000, run: 1800000, operation: 900000 });
  const migration = readFileSync("migrations/0020.spine-foundation.sql", "utf8");
  for (const definer of [
    "enter_lease(",
    "pending_starts(",
    "lease_mark_started(",
    "lease_release(",
  ])
    assert.ok(migration.includes("CREATE FUNCTION morrow_work." + definer), definer);
});

test("the role preflight refuses anything but the membership-free runtime login", () => {
  runtimeExecutorProfile.requireRole([roleRow()]);
  for (const change of [
    { role: "morrow_work_command" },
    { login: "morrow_api_worker" },
    { role: "morrow_vault_broker", login: "morrow_vault_broker" },
    { rolsuper: true },
    { rolbypassrls: true },
    { rolinherit: true },
    { role_member: true },
    { role_member: null },
    { extra: false },
  ])
    assert.throws(
      () => runtimeExecutorProfile.requireRole([roleRow(change)]),
      /RUNTIME_LEASE_HELD/,
    );
  assert.throws(() => runtimeExecutorProfile.requireRole([]), /RUNTIME_LEASE_HELD/);
  assert.throws(
    () => runtimeExecutorProfile.requireRole([roleRow(), roleRow()]),
    /RUNTIME_LEASE_HELD/,
  );
});

test("a lease step: enter first, then the body; mark started and release are fixed calls", async () => {
  const lease = ref();
  const fake = fakePool((text) =>
    text === runtimeExecutorSql.enterLease
      ? [entered()]
      : text === runtimeExecutorSql.markStarted
        ? [{ outcome: "started" }]
        : text === runtimeExecutorSql.release
          ? [{ outcome: "released" }]
          : [],
  );
  const result = await runLeaseStep(fake.pool, attempt(), lease, async (step) => {
    assert.equal(step.lease.leaseId, lease.leaseId);
    assert.equal(await step.markStarted(), "started");
    assert.equal(await step.release(), "released");
    assert.deepEqual(Object.keys(step).sort(), ["lease", "markStarted", "release"]);
    return "done";
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.entered, true);
  assert.equal(result.value.value, "done");
  assert.deepEqual(result.value.lease, {
    leaseId: lease.leaseId,
    generation: 1,
    organizationId: "org_1",
    workspaceId: "ws_1",
    kind: "run",
    subjectId: "run_1",
    storeId: "store_1",
    connectionId: "connection_1",
    installationId: "installation_1",
    initiatorPrincipalId: "person_1",
    initiatorMembershipId: "membership_1",
    expiresAtMs: 1790000000000,
  });
  assert.deepEqual(
    fake.sent.map(([text]) => text),
    [
      runtimeExecutorSql.begin,
      runtimeExecutorSql.role,
      ...runtimeExecutorProfile.settings,
      runtimeExecutorSql.enterLease,
      runtimeExecutorSql.markStarted,
      runtimeExecutorSql.release,
      runtimeExecutorSql.commit,
    ],
  );
  assert.deepEqual(fake.sent[6][1], [lease.leaseId, "1"]);
  assert.deepEqual([fake.connects, fake.releases], [1, 1]);
});

test("every refusal runs no body; a malformed lease reference never connects", async () => {
  for (const outcome of ["denied", "not_found", "ended", "expired", "member_inactive", "stopped"]) {
    const fake = fakePool((text) =>
      text === runtimeExecutorSql.enterLease ? [refusedRow(outcome)] : [],
    );
    let ran = false;
    const result = await runLeaseStep(fake.pool, attempt(), ref(), async () => (ran = true));
    assert.deepEqual(result, { ok: true, value: { entered: false, refusal: outcome } });
    assert.equal(ran, false);
    assert.equal(fake.sent.at(-1)[0], runtimeExecutorSql.commit);
  }
  for (const bad of [
    null,
    { leaseId: "ABC", generation: 1 },
    { leaseId: randomUUID().toUpperCase(), generation: 1 },
    { leaseId: randomUUID(), generation: 0 },
    { leaseId: randomUUID(), generation: "1" },
    { leaseId: randomUUID(), generation: 1, organizationId: "org_2" },
  ]) {
    const fake = fakePool(() => []);
    const result = await runLeaseStep(fake.pool, attempt(), bad, async () => "never");
    assert.deepEqual(result, { ok: true, value: { entered: false, refusal: "denied" } });
    assert.equal(fake.connects, 0);
  }
  assert.equal(
    parseLeaseRef({ leaseId: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12), generation: 2 })
      .generation,
    2,
  );
});

test("malformed rows, a denied mark or release, and a failing body roll back", async () => {
  const lease = ref();
  for (const reply of [
    [entered({ kind: "write" })],
    [entered({ installation_id: null })],
    [entered({ kind: "read" })],
    [entered({ expires_at_ms: "x" })],
    [entered({ extra: "1" })],
    [{ ...refusedRow("denied"), organization_id: "org_1" }],
    [refusedRow("unknown")],
    [entered(), entered()],
    [],
  ]) {
    const fake = fakePool((text) => (text === runtimeExecutorSql.enterLease ? reply : []));
    const result = await runLeaseStep(fake.pool, attempt(), lease, async () => "never");
    assert.deepEqual(result, { ok: false });
    assert.equal(fake.sent.at(-1)[0], runtimeExecutorSql.rollback);
  }
  // A read lease names no installation.
  assert.equal(
    decodeEnteredLease([entered({ kind: "read", installation_id: null })], lease).installationId,
    null,
  );
  for (const [text, outcome] of [
    [runtimeExecutorSql.markStarted, "denied"],
    [runtimeExecutorSql.release, "denied"],
  ]) {
    const fake = fakePool((sent) =>
      sent === runtimeExecutorSql.enterLease ? [entered()] : sent === text ? [{ outcome }] : [],
    );
    const result = await runLeaseStep(fake.pool, attempt(), lease, async (step) =>
      text === runtimeExecutorSql.markStarted ? step.markStarted() : step.release(),
    );
    assert.deepEqual(result, { ok: false });
  }
  const fake = fakePool((text) => (text === runtimeExecutorSql.enterLease ? [entered()] : []));
  const result = await runLeaseStep(fake.pool, attempt(), lease, async () => {
    throw Error("body failed");
  });
  assert.deepEqual(result, { ok: false });
  assert.equal(fake.sent.at(-1)[0], runtimeExecutorSql.rollback);
});

test("pending starts: ids only, at most 100, closed rows", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    kind: i % 2 ? "operation" : "run",
    subject_id: "subject_" + i,
    lease_id: randomUUID(),
    generation: "1",
  }));
  const fake = fakePool((text) => (text === runtimeExecutorSql.pendingStarts ? rows : []));
  const result = await listPendingStarts(fake.pool, attempt());
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value,
    rows.map((r) => ({
      kind: r.kind,
      subjectId: r.subject_id,
      leaseId: r.lease_id,
      generation: 1,
    })),
  );
  for (const bad of [
    [{ ...rows[0], kind: "read" }],
    [{ ...rows[0], organization_id: "org_1" }],
    [{ ...rows[0], lease_id: "x" }],
    [{ ...rows[0], generation: "0" }],
    [rows[0], rows[0]],
    Array.from({ length: 101 }, () => ({ ...rows[0], lease_id: randomUUID() })),
  ]) {
    const broken = fakePool((text) => (text === runtimeExecutorSql.pendingStarts ? bad : []));
    assert.deepEqual(await listPendingStarts(broken.pool, attempt()), { ok: false });
  }
});

test("the attempt: deadline and abort end the transaction; a lost reply discards the client", async () => {
  assert.throws(() => createRuntimeAttempt(0, new AbortController().signal), /RUNTIME_LEASE_HELD/);
  assert.throws(
    () => createRuntimeAttempt(30001, new AbortController().signal),
    /RUNTIME_LEASE_HELD/,
  );
  const abort = new AbortController();
  const fake = fakePool((text) => {
    if (text === runtimeExecutorSql.enterLease) {
      abort.abort();
      return [entered()];
    }
    return [];
  });
  const result = await runLeaseStep(
    fake.pool,
    createRuntimeAttempt(5000, abort.signal),
    ref(),
    async () => "never",
  );
  assert.deepEqual(result, { ok: false });
  assert.equal(fake.releases, 1);
  let clock = 1000;
  const late = createRuntimeAttempt(10, new AbortController().signal, () => clock);
  clock = 1011;
  assert.throws(() => late.check(), /RUNTIME_LEASE_HELD/);
  late.end();
  const lost = fakePool((text) =>
    text === runtimeExecutorSql.enterLease ? Error("socket closed") : [],
  );
  assert.deepEqual(await runLeaseStep(lost.pool, attempt(), ref(), async () => 1), { ok: false });
  assert.notEqual(lost.sent.at(-1)[0], runtimeExecutorSql.commit);
});
