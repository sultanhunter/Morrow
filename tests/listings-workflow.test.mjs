// M3 PR-2: ListingsRunWorkflow's logic (packages/work/src/runs/workflow.ts) on fake ports,
// for the paths that need no authority decision: a refused lease interrupts the run, an
// ended run ends the Workflow, a failed transaction retries the durable step, a run past its
// time budget skips its products and still proposes and finishes, and every durable result
// is ids and codes. lab:listings-runs drives the whole Workflow, with the real kernel and the
// broker's gateway, over PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import {
  listingsRun,
  productMarginMs,
  RunStepRetry,
  runModelBudgetMs,
} from "../packages/work/src/runs/workflow.ts";
import { modelCallBudgetMs, modelGatewayLimits } from "../packages/identity/src/broker-protocol.ts";

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
  catalogueVersion: 1,
  model: "claude_sonnet_5_5",
  effort: "low",
  ...over,
});
const lowBudget = runModelBudgetMs(1, "claude_sonnet_5_5", "low");

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
    start: async () => startRow({ leaseExpiresAtMs: 1_000_000 + productMarginMs(lowBudget) - 1 }),
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

test("each run's model budget is its effort's whole call; the product margin follows it", async () => {
  // Low, medium and high at catalogue version 1: max_tokens 5,000, 12,000 and 16,000.
  for (const [effort, max] of [
    ["low", 5_000],
    ["medium", 12_000],
    ["high", 16_000],
  ]) {
    assert.equal(runModelBudgetMs(1, "claude_opus_5_5", effort), modelCallBudgetMs(max));
    assert.ok(productMarginMs(runModelBudgetMs(1, "claude_opus_5_5", effort)) < 30 * 60_000);
  }
  // An entry this build's catalogue lacks gets the longest budget; the broker holds it.
  assert.equal(runModelBudgetMs(1, "claude_unknown", "low"), modelGatewayLimits.budgetMaxMs);
  // The started step's durable result carries the run's budget (a number), and the product
  // margin follows it: lease time enough for a low-effort product is too little for a high one.
  const results = [];
  const finished = [];
  const run = {
    start: async () =>
      startRow({
        productCount: 1,
        model: "claude_opus_5_5",
        effort: "high",
        leaseExpiresAtMs: 1_000_000 + productMarginMs(lowBudget) + 1,
      }),
    draftsPending: async () => [],
    finish: async (reason) => {
      finished.push(reason);
      return { outcome: "ended", status: "failed", creditsSettled: null };
    },
  };
  const result = await listingsRun(
    ports(async (_r, body) => ({ entered: true, lease: {}, value: await body({ run }) })),
    {
      async do(name, body) {
        const value = JSON.parse(JSON.stringify(await body()));
        results.push([name, value]);
        return value;
      },
    },
    ref,
  );
  assert.deepEqual(result, { kind: "ended", status: "failed" });
  assert.equal(results[0][1].modelBudgetMs, modelCallBudgetMs(16_000));
  assert.deepEqual(results[1], [
    "product-0",
    { kind: "product", index: 0, status: "done", stop: "time_budget" },
  ]);
  assert.deepEqual(finished, ["time_budget"]);
});

test("the product step accepts every objective the task accepted: lengths are code points", async () => {
  const { createRunSteps } = await import("../packages/work/src/runtime/run-steps.ts");
  const begin = (objective) =>
    createRunSteps(async () => [
      {
        outcome: "begun",
        reason: null,
        product_id: "product:7",
        attempts: "0",
        snapshot_digest: null,
        fields: '["title"]',
        objective,
      },
    ]).productBegin(0);
  // 8,000 characters and 100 emoji: 8,100 code points (SQL char_length), 8,200 UTF-16 units.
  const astral = "r".repeat(8000) + "\u{1F600}".repeat(100);
  assert.equal((await begin(astral)).objective, astral);
  assert.equal((await begin("\u{1F600}".repeat(8192))).outcome, "begun");
  await assert.rejects(begin("\u{1F600}".repeat(8193)), /RUNTIME_RUN_HELD/);
  await assert.rejects(begin(""), /RUNTIME_RUN_HELD/);
});
