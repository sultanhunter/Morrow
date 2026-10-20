// M2 PR-1 OperationLedger helpers (mvp-architecture §8; P06.T01c minimum) over the
// unchanged operation machine of docs/contracts/state-transitions.json and the rows 0020
// seeds into morrow_work.transition_rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OperationLedgerError,
  decodeOperationTransition,
  noEffectEdge,
  operationEdge,
  operationEdges,
  operationStatuses,
  operationTransitionArguments,
  preconditionConflictEdge,
  readbackEdge,
  terminalOperationStatuses,
  uncertaintyReasons,
  writeOutcomeEdge,
} from "../packages/work/src/operations/ledger.ts";

const machine = JSON.parse(readFileSync("docs/contracts/state-transitions.json", "utf8"))
  .transitions.operation;
const migration = readFileSync("migrations/0020.spine-foundation.sql", "utf8");
const request = (change = {}) => ({
  organizationId: "org_1",
  workspaceId: "ws_1",
  operationId: "operation_1",
  expectedRevision: 3,
  from: "authorized",
  to: "dispatching",
  reason: null,
  uncertaintyReason: null,
  leaseId: "4f1f0c1e-7d7a-4b1e-9a55-0b9c8a1d2e3f",
  ...change,
});
const invalid = (fn) =>
  assert.throws(
    fn,
    (e) => e instanceof OperationLedgerError && e.code === "OPERATION_TRANSITION_INVALID",
  );

test("the edges are the operation rows of state-transitions.json and of 0020, unchanged", () => {
  assert.deepEqual(
    operationEdges.map((e) => ({ ...e })),
    machine,
  );
  const seeded = [
    ...migration.matchAll(/\('operation','([a-z_]+)','([a-z_]+)','([a-z_]+)','([a-z_]+)'\)/g),
  ].map(([, from, to, actor, guard]) => ({ from, to, actor, guard }));
  assert.equal(seeded.length, 25);
  assert.deepEqual(seeded, machine);
  // The 0020 status CHECK and the contract's status set are the same fourteen.
  const check = /status IN \('planned','awaiting_approval'[^)]*\)/.exec(
    migration.replace(/\n\s*/g, ""),
  )[0];
  for (const status of operationStatuses) assert.ok(check.includes(`'${status}'`), status);
  assert.equal(operationStatuses.length, 14);
  assert.deepEqual(
    new Set(terminalOperationStatuses),
    new Set(["verified", "rejected", "conflict", "failed", "cancelled"]),
  );
});

test("no edge promotes an unknown outcome: uncertain leaves only by readback, no-effect or cancel", () => {
  const out = operationEdges.filter((e) => e.from === "uncertain").map((e) => e.to);
  assert.deepEqual(out.sort(), ["cancel_requested", "failed", "verifying"]);
  for (const to of ["verified", "submitted", "dispatching", "authorized"])
    assert.equal(operationEdge("uncertain", to), null);
  // Nothing re-enters dispatching after a send could have happened.
  for (const from of ["submitted", "verifying", "uncertain", "failed", "cancel_requested"])
    assert.equal(operationEdge(from, "dispatching"), null);
});

test("operationTransitionArguments: the ten bind values of operation_transition, or a refusal", () => {
  assert.deepEqual(operationTransitionArguments(request()), [
    "org_1",
    "ws_1",
    "operation_1",
    "3",
    "dispatching",
    "action_service",
    "non_billable_current_grants_and_lease",
    null,
    null,
    "4f1f0c1e-7d7a-4b1e-9a55-0b9c8a1d2e3f",
  ]);
  const uncertain = operationTransitionArguments(
    request({
      from: "dispatching",
      to: "uncertain",
      uncertaintyReason: "transport_after_dispatch",
    }),
  );
  assert.deepEqual(uncertain.slice(4, 9), [
    "uncertain",
    "connector",
    "unknown_external_outcome",
    null,
    "transport_after_dispatch",
  ]);
  // A session command passes no lease.
  assert.equal(
    operationTransitionArguments(
      request({ from: "planned", to: "awaiting_approval", leaseId: null }),
    )[9],
    null,
  );
  for (const change of [
    { from: "planned", to: "verified" },
    { from: "uncertain", to: "verified" },
    { from: "authorized", to: "dispatching", guard: "current_grants_and_preconditions" },
    { to: "unknown" },
    { from: "dispatching", to: "uncertain" },
    { uncertaintyReason: "transport_after_dispatch" },
    { from: "dispatching", to: "uncertain", uncertaintyReason: "lost" },
    { reason: "Bad Reason" },
    { reason: "ab" },
    { organizationId: "" },
    { operationId: "a b" },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { leaseId: "lease id" },
  ])
    invalid(() => operationTransitionArguments(request(change)));
  for (const reason of uncertaintyReasons)
    assert.equal(
      operationTransitionArguments(
        request({ from: "submitted", to: "uncertain", uncertaintyReason: reason }),
      )[8],
      reason,
    );
});

test("decodeOperationTransition: the five outcomes of 0020, closed", () => {
  assert.deepEqual(decodeOperationTransition([{ outcome: "applied", revision: "4" }]), {
    outcome: "applied",
    revision: 4,
  });
  for (const outcome of ["revision_conflict", "state_conflict"])
    assert.deepEqual(decodeOperationTransition([{ outcome, revision: "7" }]), {
      outcome,
      revision: 7,
    });
  for (const outcome of ["invalid", "not_found"])
    assert.deepEqual(decodeOperationTransition([{ outcome, revision: null }]), { outcome });
  for (const rows of [
    [],
    [{ outcome: "applied", revision: null }],
    [{ outcome: "not_found", revision: "1" }],
    [{ outcome: "applied", revision: "0" }],
    [{ outcome: "done", revision: "1" }],
    [{ outcome: "applied", revision: "1", extra: 1 }],
    [
      { outcome: "applied", revision: "1" },
      { outcome: "applied", revision: "2" },
    ],
  ])
    assert.throws(
      () => decodeOperationTransition(rows),
      (e) => e instanceof OperationLedgerError && e.code === "OPERATION_RESULT_INVALID",
    );
});

test("spine §8 outcomes map to existing edges; a send that may have happened is uncertain", () => {
  assert.deepEqual(writeOutcomeEdge("submitted"), {
    to: "submitted",
    guard: "provider_submission_receipt",
    reason: null,
    uncertaintyReason: null,
  });
  assert.deepEqual(writeOutcomeEdge("rejected"), {
    to: "failed",
    guard: "verified_no_effect",
    reason: "provider_rejected",
    uncertaintyReason: null,
  });
  assert.equal(writeOutcomeEdge("not_sent").reason, "provider_not_sent");
  assert.equal(writeOutcomeEdge("not_sent", "reinstall_needed").reason, "reinstall_needed");
  assert.deepEqual(writeOutcomeEdge("uncertain"), {
    to: "uncertain",
    guard: "unknown_external_outcome",
    reason: null,
    uncertaintyReason: "transport_after_dispatch",
  });
  assert.equal(readbackEdge("all_applied").to, "verified");
  assert.deepEqual(readbackEdge("partial"), {
    to: "uncertain",
    guard: "verification_unavailable",
    reason: null,
    uncertaintyReason: "partial_result",
  });
  assert.equal(readbackEdge("unavailable").uncertaintyReason, "verification_unavailable");
  assert.deepEqual(noEffectEdge(), {
    to: "failed",
    guard: "verified_no_effect",
    reason: "verified_no_effect",
    uncertaintyReason: null,
  });
  assert.equal(preconditionConflictEdge("store_uninstalled").to, "conflict");
  invalid(() => writeOutcomeEdge("timeout"));
  invalid(() => writeOutcomeEdge("not_sent", "Bad"));
  invalid(() => readbackEdge("maybe"));
  invalid(() => preconditionConflictEdge("x"));
  // Each planned edge feeds operationTransitionArguments unchanged.
  const from = { submitted: "dispatching", failed: "dispatching", uncertain: "dispatching" };
  for (const outcome of ["submitted", "rejected", "not_sent", "uncertain"]) {
    const edge = writeOutcomeEdge(outcome);
    assert.ok(
      operationTransitionArguments(request({ from: from[edge.to], ...edge, leaseId: null })),
    );
  }
});
