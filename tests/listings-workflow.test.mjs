// M3 PR-2: ListingsRunWorkflow's logic (packages/work/src/runs/workflow.ts) on fake ports,
// for the paths that need no authority decision: a refused lease interrupts the run, an
// ended run ends the Workflow, a failed transaction retries the durable step, a run past its
// time budget skips its products and still proposes and finishes, and every durable result
// is ids and codes. lab:listings-runs drives the whole Workflow, with the real kernel and the
// broker's gateway, over PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { listingsRun, RunStepRetry, runTimings } from "../packages/work/src/runs/workflow.ts";

const ref = { leaseId: "00000000-0000-4000-8000-000000000001", generation: 1 };
function steps() {
  const names = [];
  return {
    names,
    steps: {
      async do(name, body) {
        names.push(name);
        return JSON.parse(JSON.stringify(await body()));
      },
    },
  };
}
function ports(lease, extra = {}) {
  return {
    lease,
    modelRespond: async () => {
      throw Error("not expected");
    },
    readProduct: async () => {
      throw Error("not expected");
    },
    environment: "development",
    now: () => 1_000_000,
    sleep: async () => {},
    ids: () => "id",
    ...extra,
  };
}
const startRow = (over = {}) => ({
  outcome: "started",
  runId: "00000000-0000-4000-8000-0000000000aa",
  taskId: "task_root",
  childTaskId: "child",
  envelopeId: "envelope",
  installationId: "installation",
  agentPrincipalId: "agent",
  storeId: "store",
  connectionId: "connection",
  productCount: 2,
  fields: ["descriptionHtml", "title"],
  leaseExpiresAtMs: 1_000_000 + 30 * 60_000,
  status: "running",
  ...over,
});

test("a refused lease interrupts the run at its first step; an ended run ends", async () => {
  for (const refusal of ["stopped", "ended", "member_inactive"]) {
    const s = steps();
    const result = await listingsRun(
      ports(async () => ({ entered: false, refusal })),
      s.steps,
      ref,
    );
    assert.deepEqual(result, { kind: "interrupted", refusal });
    assert.deepEqual(s.names, ["start"]);
  }
  const s = steps();
  const ended = await listingsRun(
    ports(async (_r, body) => ({
      entered: true,
      lease: {},
      value: await body({
        run: { start: async () => startRow({ outcome: "ended", status: "succeeded" }) },
      }),
    })),
    s.steps,
    ref,
  );
  assert.deepEqual(ended, { kind: "ended", status: "succeeded" });
  const denied = await listingsRun(
    ports(async (_r, body) => ({
      entered: true,
      lease: {},
      value: await body({ run: { start: async () => "denied" } }),
    })),
    steps().steps,
    ref,
  );
  assert.deepEqual(denied, { kind: "interrupted", refusal: "denied" });
});

test("a failed transaction is a RunStepRetry, so the durable step retries it", async () => {
  await assert.rejects(
    listingsRun(
      ports(async () => "failed"),
      steps().steps,
      ref,
    ),
    (error) => error instanceof RunStepRetry && error.code === "transaction",
  );
});

test("past its time budget a run skips its products, still proposes, and finishes", async () => {
  const s = steps();
  const finished = [];
  const run = {
    start: async () => startRow({ leaseExpiresAtMs: 1_000_000 + runTimings.productMarginMs - 1 }),
    draftsPending: async () => [],
    finish: async (reason) => {
      finished.push(reason);
      return { outcome: "ended", status: "failed", creditsSettled: null };
    },
  };
  const result = await listingsRun(
    ports(async (_r, body) => ({ entered: true, lease: {}, value: await body({ run }) })),
    s.steps,
    ref,
  );
  assert.deepEqual(result, { kind: "ended", status: "failed" });
  assert.deepEqual(s.names, ["start", "product-0", "propose", "finish"]);
  assert.deepEqual(finished, ["time_budget"]);
});

test("a finish that finds an open call waits and asks again", async () => {
  let calls = 0;
  const run = {
    start: async () => startRow({ productCount: 1, leaseExpiresAtMs: 0 }),
    draftsPending: async () => [],
    finish: async () =>
      ++calls < 3
        ? { outcome: "call_open" }
        : { outcome: "ended", status: "failed", creditsSettled: null },
  };
  const result = await listingsRun(
    ports(async (_r, body) => ({ entered: true, lease: {}, value: await body({ run }) })),
    steps().steps,
    ref,
  );
  assert.deepEqual(result, { kind: "ended", status: "failed" });
  assert.equal(calls, 3);
});
