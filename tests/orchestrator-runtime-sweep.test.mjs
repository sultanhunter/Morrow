// Build order PR 8 (ADR-0029 items 2 and 9): the orchestrator's cron sweeps the runtime every
// fifth minute through RuntimeBroker.runtimeSweep, whatever dispatch, a stop or a runtime hold
// says. The broker's switch decides (off holds); nothing here creates, reads a credential or
// logs an id.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  keepRuntimeSweep,
  runtimeSweepSchedule,
  sweepRuntimeOnSchedule,
} from "../apps/workers/src/runtime-sweep.ts";

// The orchestrator bundled as tests/orchestrator.test.mjs does, with `cloudflare:*` stubbed.
const stubs = {
  "cloudflare:workers":
    "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "cloudflare:workflows":
    "export class NonRetryableError extends Error { constructor(message, name) { super(message); this.name = name ?? 'NonRetryableError'; } }",
};
async function loadOrchestrator(t) {
  const directory = mkdtempSync(join(tmpdir(), "morrow-orchestrator-sweep-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundled = await build({
    entryPoints: ["apps/workers/src/orchestrator.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["node:*"],
    mainFields: ["module", "main"],
    plugins: [
      {
        name: "cloudflare-stubs",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:/ }, (args) => ({
            path: args.path,
            namespace: "stub",
          }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path] }));
        },
      },
    ],
  });
  const file = join(directory, "worker.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const minute = 60_000;
const due = Date.parse("2026-10-24T10:05:00.000Z");
function capture() {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  return {
    lines,
    restore: () => (console.log = original),
  };
}
const counts = {
  schemaVersion: 1,
  examined: 2,
  killed: 1,
  absentVerified: 0,
  unknown: 1,
  skipped: 3,
};

test("every fifth minute: one runtimeSweep with the fixed budget, counts logged and no ids", async () => {
  assert.deepEqual(runtimeSweepSchedule, { everyMinutes: 5, budgetMs: 120_000 });
  const calls = [];
  const env = {
    MORROW_ENVIRONMENT: "staging",
    BROKER: {
      runtimeSweep: async (budgetMs) => (calls.push(budgetMs), JSON.stringify(counts)),
    },
  };
  const log = capture();
  try {
    for (const offset of [1, 2, 3, 4])
      assert.equal(
        await sweepRuntimeOnSchedule({ scheduledTime: due + offset * minute }, env),
        "not_due",
      );
    assert.equal(calls.length, 0);
    assert.equal(await sweepRuntimeOnSchedule({ scheduledTime: due }, env), "swept");
  } finally {
    log.restore();
  }
  assert.deepEqual(calls, [120_000]);
  assert.deepEqual(
    log.lines.map((l) => JSON.parse(l)),
    [
      {
        event: "morrow_orchestrator_runtime_sweep",
        outcome: "swept",
        examined: 2,
        killed: 1,
        absentVerified: 0,
        unknown: 1,
        skipped: 3,
      },
    ],
  );
});

test("a held broker (the switch off) is logged as held; nothing throws", async () => {
  const log = capture();
  try {
    const env = {
      MORROW_ENVIRONMENT: "staging",
      BROKER: { runtimeSweep: () => Promise.reject(Error("BROKER_HELD")) },
    };
    assert.equal(await sweepRuntimeOnSchedule({ scheduledTime: due }, env), "held");
    const odd = { MORROW_ENVIRONMENT: "staging", BROKER: { runtimeSweep: async () => "not json" } };
    assert.equal(await sweepRuntimeOnSchedule({ scheduledTime: due }, odd), "held");
  } finally {
    log.restore();
  }
  assert.deepEqual(
    log.lines.map((l) => JSON.parse(l).outcome),
    ["held", "held"],
  );
});

test("no broker binding, no sweep method, production or a getter: unbound, and nothing is called", async () => {
  let touched = 0;
  const getter = { MORROW_ENVIRONMENT: "staging" };
  Object.defineProperty(getter, "BROKER", {
    get() {
      touched++;
      return { runtimeSweep: async () => "{}" };
    },
    enumerable: true,
  });
  const log = capture();
  try {
    for (const env of [
      null,
      {},
      { MORROW_ENVIRONMENT: "staging" },
      { MORROW_ENVIRONMENT: "staging", BROKER: { fetch() {} } },
      { MORROW_ENVIRONMENT: "production", BROKER: { runtimeSweep: async () => (touched++, "{}") } },
      getter,
    ])
      assert.equal(await sweepRuntimeOnSchedule({ scheduledTime: due }, env), "unbound");
    for (const controller of [null, {}, { scheduledTime: "soon" }, { scheduledTime: 1.5 }])
      assert.equal(await sweepRuntimeOnSchedule(controller, {}), "not_due");
  } finally {
    log.restore();
  }
  assert.equal(touched, 0);
});

test("the cron hook keeps the sweep alive with waitUntil, and the orchestrator runs it with dispatch off", async (t) => {
  const kept = [];
  const calls = [];
  const env = {
    MORROW_ENVIRONMENT: "staging",
    BROKER: { runtimeSweep: async (b) => (calls.push(b), JSON.stringify(counts)) },
  };
  const log = capture();
  try {
    keepRuntimeSweep({ scheduledTime: due }, env, { waitUntil: (p) => kept.push(p) });
    assert.equal(kept.length, 1);
    assert.equal(await kept[0], "swept");
    // Through the orchestrator's own cron: the model-provider switch is off (dispatch disabled),
    // and the sweep still runs.
    const saved = process.env;
    process.env = {};
    t.after(() => (process.env = saved));
    const module = await loadOrchestrator(t);
    const ctx = { waitUntil: (p) => kept.push(p) };
    await module.default.scheduled({ scheduledTime: due }, env, ctx);
    assert.equal(kept.length, 2);
    assert.equal(await kept[1], "swept");
  } finally {
    log.restore();
  }
  assert.deepEqual(calls, [120_000, 120_000]);
  assert.ok(log.lines.includes('{"event":"morrow_orchestrator_dispatch_disabled"}'));
});
