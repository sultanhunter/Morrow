// M3 PR-2: ListingsRunWorkflow's logic (packages/work/src/runs/workflow.ts) on fake ports,
// for the paths that need no authority decision: a refused lease interrupts the run, an
// ended run ends the Workflow, a failed transaction retries the durable step, a run past its
// time budget skips its products and still proposes and finishes, and every durable result
// is ids and codes. lab:listings-runs drives the whole Workflow, with the real kernel and the
// broker's gateway, over PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import {
  breakerProducts,
  createProductReader,
  listingsRun,
  productMarginMs,
  productReadOf,
  readProductWithRetries,
  RunStepRetry,
  runModelBudgetMs,
  runTimings,
  snapshotOfRead,
} from "../packages/work/src/runs/workflow.ts";
import { snapshotCanonical } from "../packages/work/src/runs/drafting.ts";
import {
  modelCallBudgetMs,
  modelGatewayLimits,
  shopifyReadLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { generatedModelCatalogue } from "../packages/policy/src/generated/model-catalogue.ts";

const ref = { leaseId: "00000000-0000-4000-8000-000000000001", generation: 1 };
const runId = "00000000-0000-4000-8000-0000000000aa";
// The entered run lease (its subject is the run id, the Workflow's instance id).
const runLease = { kind: "run", subjectId: runId };
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
      runId,
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
        lease: runLease,
        run: { start: async () => startRow({ outcome: "ended", status: "succeeded" }) },
      }),
    })),
    s.steps,
    ref,
    runId,
  );
  assert.deepEqual(ended, { kind: "ended", status: "succeeded" });
  const denied = await listingsRun(
    ports(async (_r, body) => ({
      entered: true,
      lease: {},
      value: await body({ lease: runLease, run: { start: async () => "denied" } }),
    })),
    steps().steps,
    ref,
    runId,
  );
  assert.deepEqual(denied, { kind: "interrupted", refusal: "denied" });
});

test("a failed transaction is a RunStepRetry, so the durable step retries it", async () => {
  await assert.rejects(
    listingsRun(
      ports(async () => "failed"),
      steps().steps,
      ref,
      runId,
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
    ports(async (_r, body) => ({
      entered: true,
      lease: {},
      value: await body({ lease: runLease, run }),
    })),
    s.steps,
    ref,
    runId,
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
    ports(async (_r, body) => ({
      entered: true,
      lease: {},
      value: await body({ lease: runLease, run }),
    })),
    steps().steps,
    ref,
    runId,
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
    ports(async (_r, body) => ({
      entered: true,
      lease: {},
      value: await body({ lease: runLease, run }),
    })),
    {
      async do(name, body) {
        const value = JSON.parse(JSON.stringify(await body()));
        results.push([name, value]);
        return value;
      },
    },
    ref,
    runId,
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

// M2 PR-3 integration: the run id is the Workflow's instance id and the run lease's subject;
// the product read names it, so a payload naming another run's lease interrupts the run.
test("the start step interrupts a run whose lease names another subject", async () => {
  for (const lease of [
    { kind: "run", subjectId: "00000000-0000-4000-8000-0000000000bb" },
    { kind: "read", subjectId: runId },
  ]) {
    let started = 0;
    const s = steps();
    const result = await listingsRun(
      ports(async (_r, body) => ({
        entered: true,
        lease,
        value: await body({ lease, run: { start: async () => (started++, startRow()) } }),
      })),
      s.steps,
      ref,
      runId,
    );
    assert.deepEqual(result, { kind: "interrupted", refusal: "subject_mismatch" });
    assert.equal(started, 0);
    assert.deepEqual(s.names, ["start"]);
  }
});

const product = (over = {}) => ({
  productId: "product:7",
  title: "Linen shirt",
  descriptionHtml: "<p>Soft linen.</p>",
  seo: { title: null, description: null },
  tags: ["summer"],
  ...over,
});
test("the product read is decoded by the protocol's closed decoder", () => {
  const read = { schemaVersion: 1, outcome: "read", product: product() };
  assert.deepEqual(productReadOf(JSON.stringify(read)), { outcome: "read", product: product() });
  assert.deepEqual(productReadOf('{"schemaVersion":1,"outcome":"not_found"}'), {
    outcome: "not_found",
  });
  // Anything outside the closed result is invalid: an extra key, another query's result,
  // a malformed product id, not JSON, not a string.
  for (const text of [
    JSON.stringify({ ...read, extra: 1 }),
    JSON.stringify({ schemaVersion: 1, outcome: "read", products: [], nextCursor: null }),
    JSON.stringify({ ...read, product: product({ productId: "7" }) }),
    "{",
    null,
  ])
    assert.deepEqual(productReadOf(text), { outcome: "invalid" });
});

test("a read still unavailable, not_found and invalid fail the product read_failed", () => {
  // The product step's last read: an unavailable one was already tried again within the step
  // (readProductWithRetries), so it fails the product instead of retrying the durable step.
  for (const outcome of ["unavailable", "not_found", "invalid"])
    assert.deepEqual(snapshotOfRead({ outcome }, "product:7"), {
      kind: "failed",
      code: "read_failed",
    });
  assert.deepEqual(snapshotOfRead({ outcome: "read", product: product() }, "product:8"), {
    kind: "failed",
    code: "product_mismatch",
  });
  const ok = snapshotOfRead({ outcome: "read", product: product() }, "product:7");
  assert.equal(ok.kind, "snapshot");
  assert.equal(ok.canonical, snapshotCanonical(product()));
});

test("an oversize product fails too_large before any schema check; duplicate tags are dropped", () => {
  // M2 PR-3's read admits a 196,608-byte description and 4,096-byte titles; ListingSnapshot@1
  // caps strings at 65,536 characters, so the size decides first.
  for (const over of [
    { descriptionHtml: "d".repeat(196_608) },
    { descriptionHtml: "d".repeat(65_536) },
    { tags: Array.from({ length: 250 }, (_, i) => "t".repeat(1_000) + i) },
  ])
    assert.deepEqual(snapshotOfRead({ outcome: "read", product: product(over) }, "product:7"), {
      kind: "failed",
      code: "too_large",
    });
  // Just under the bound is a snapshot.
  const base = snapshotCanonical(product({ descriptionHtml: "" }));
  const fits = product({ descriptionHtml: "d".repeat(65_536 - Buffer.byteLength(base)) });
  const at = snapshotOfRead({ outcome: "read", product: fits }, "product:7");
  assert.equal(at.kind, "snapshot");
  assert.equal(Buffer.byteLength(at.canonical), 65_536);
  // The read does not require unique tags; ListingSnapshot@1 does. Exact duplicates are
  // dropped (the first kept) instead of failing the product.
  const tagged = snapshotOfRead(
    { outcome: "read", product: product({ tags: ["summer", "linen", "summer"] }) },
    "product:7",
  );
  assert.equal(tagged.kind, "snapshot");
  assert.deepEqual(tagged.snapshot.tags, ["summer", "linen"]);
});

// Review (AI review, separate context, same model family): the orchestrator's product read
// is M2 PR-3's six-argument shopifyRead, named by the run id; nothing else ran it.
test("the product reader calls shopifyRead with the lease, the run id and productContent", async () => {
  const calls = [];
  const reply = JSON.stringify({ schemaVersion: 1, outcome: "read", product: product() });
  const reader = createProductReader({
    shopifyRead: async (...args) => {
      calls.push(args);
      return reply;
    },
  });
  assert.deepEqual(await reader(ref, runId, "product:7"), { outcome: "read", product: product() });
  assert.deepEqual(calls, [
    [
      ref.leaseId,
      ref.generation,
      runId,
      "productContent",
      '{"productId":"product:7"}',
      shopifyReadLimits.budgetMaxMs,
    ],
  ]);
  // A thrown read (BROKER_HELD) is unavailable; a reply outside the protocol is invalid.
  const held = createProductReader({ shopifyRead: () => Promise.reject(Error("BROKER_HELD")) });
  assert.deepEqual(await held(ref, runId, "product:7"), { outcome: "unavailable" });
  const odd = createProductReader({ shopifyRead: async () => '{"schemaVersion":1}' });
  assert.deepEqual(await odd(ref, runId, "product:7"), { outcome: "invalid" });
});

// Review: a read that stays unavailable must not spend the durable step's retries (the
// Workflow would error with no propose and no finish). The step tries it again a bounded
// number of times, entering the lease before each retry.
function readPorts(reads, leases = []) {
  const log = { reads: 0, sleeps: [], leases: 0 };
  return {
    log,
    ports: ports(
      async (_ref, body) => {
        log.leases++;
        const next = leases.shift() ?? "entered";
        if (next === "failed") return "failed";
        if (next !== "entered") return { entered: false, refusal: next };
        return { entered: true, lease: {}, value: await body({ lease: runLease }) };
      },
      {
        readProduct: async (r, subject, productId) => {
          assert.deepEqual([r, subject, productId], [ref, runId, "product:7"]);
          log.reads++;
          return reads.shift() ?? { outcome: "unavailable" };
        },
        sleep: async (ms) => {
          log.sleeps.push(ms);
        },
      },
    ),
  };
}
test("an unavailable read is tried again within the step, the lease entered before each retry", async () => {
  const read = { outcome: "read", product: product() };
  // Unavailable once, then read: one wait, one lease entry, the product as read.
  const once = readPorts([{ outcome: "unavailable" }, read]);
  assert.deepEqual(await readProductWithRetries(once.ports, ref, runId, "product:7"), read);
  assert.deepEqual(once.log, { reads: 2, sleeps: [2_000], leases: 1 });
  // Always unavailable: every try and wait, then the last read, unavailable (never a throw).
  const never = readPorts([]);
  assert.deepEqual(await readProductWithRetries(never.ports, ref, runId, "product:7"), {
    outcome: "unavailable",
  });
  assert.deepEqual(runTimings.readWaitsMs, [2_000, 5_000]);
  assert.deepEqual(never.log, { reads: 3, sleeps: [2_000, 5_000], leases: 2 });
  // A read that answers (not_found, invalid) is never tried again.
  for (const outcome of ["not_found", "invalid"]) {
    const answered = readPorts([{ outcome }]);
    assert.deepEqual(await readProductWithRetries(answered.ports, ref, runId, "product:7"), {
      outcome,
    });
    assert.deepEqual(answered.log, { reads: 1, sleeps: [], leases: 0 });
  }
  // A stop or an ended lease between reads interrupts the run; no further read.
  for (const refusal of ["stopped", "ended"]) {
    const stopped = readPorts([], [refusal]);
    assert.deepEqual(await readProductWithRetries(stopped.ports, ref, runId, "product:7"), {
      outcome: "interrupted",
      refusal,
    });
    assert.deepEqual(stopped.log, { reads: 1, sleeps: [2_000], leases: 1 });
  }
  // Only the lease's own transaction failing retries the durable step.
  await assert.rejects(
    readProductWithRetries(readPorts([], ["failed"]).ports, ref, runId, "product:7"),
    (error) => error instanceof RunStepRetry && error.code === "transaction",
  );
});

test("the product margin holds every read try and wait; the breaker is the catalogue's", () => {
  const reads = 3 * shopifyReadLimits.budgetMaxMs + 2_000 + 5_000;
  assert.equal(productMarginMs(lowBudget), reads + 2 * lowBudget + runTimings.throttleAllowanceMs);
  assert.ok(productMarginMs(modelGatewayLimits.budgetMaxMs) < 30 * 60_000);
  for (const v of generatedModelCatalogue.versions)
    assert.equal(v.limits.maxConsecutiveFailedProducts, breakerProducts, String(v.version));
});

// The run on durable product results (as a replay returns them): products whose read stayed
// unavailable count toward the breaker like any failed product; a breaker they alone
// tripped ends the run read_unavailable, still proposing and finishing.
async function runOn(results, productCount = 5) {
  const names = [];
  const finished = [];
  const run = {
    start: async () => startRow({ productCount }),
    finish: async (reason) => {
      finished.push(reason);
      return { outcome: "ended", status: "failed", creditsSettled: "1" };
    },
  };
  const result = await listingsRun(
    ports(async (_r, body) => ({
      entered: true,
      lease: {},
      value: await body({ lease: runLease, run }),
    })),
    {
      async do(name, body) {
        names.push(name);
        const index = /^product-([0-9]+)$/.exec(name)?.[1];
        if (index !== undefined) return results[Number(index)];
        if (name === "propose") return { kind: "proposed", proposals: 1, stop: null };
        return JSON.parse(JSON.stringify(await body()));
      },
    },
    ref,
    runId,
  );
  return { result, names, finished };
}
const productResult = (index, status, stop = null, unreadable = false) => ({
  kind: "product",
  index,
  status,
  stop,
  ...(unreadable ? { unreadable: true } : {}),
});
test("a breaker tripped by unreadable products alone ends the run read_unavailable", async () => {
  // One drafted product, then three whose read stayed unavailable: the run stops at the
  // breaker (the fifth product never runs), proposes and finishes read_unavailable.
  const unreadable = await runOn([
    productResult(0, "drafted"),
    productResult(1, "failed", null, true),
    productResult(2, "failed", null, true),
    productResult(3, "failed", "breaker", true),
  ]);
  assert.deepEqual(unreadable.result, { kind: "ended", status: "failed" });
  assert.deepEqual(unreadable.names, [
    "start",
    "product-0",
    "product-1",
    "product-2",
    "product-3",
    "propose",
    "finish",
  ]);
  assert.deepEqual(unreadable.finished, ["read_unavailable"]);
  // A breaker tripped with another failure among the three is the breaker.
  const mixed = await runOn([
    productResult(0, "failed"),
    productResult(1, "failed", null, true),
    productResult(2, "failed", "breaker", true),
  ]);
  assert.deepEqual(mixed.finished, ["breaker"]);
  // A drafted product resets the count, as the SQL breaker does.
  const reset = await runOn([
    productResult(0, "failed", null, true),
    productResult(1, "failed", null, true),
    productResult(2, "drafted"),
    productResult(3, "failed", null, true),
    productResult(4, "failed", null, true),
  ]);
  assert.deepEqual(reset.finished, [null]);
});
