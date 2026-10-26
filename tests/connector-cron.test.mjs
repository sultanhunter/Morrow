// fix-connector-cron-latency (docs/briefs/fix-connector-cron-latency.md): the connector's
// cron runs its re-drives in the ConnectorCron Durable Object, created with the Neon
// region's location hint, instead of wherever Cloudflare runs scheduled(). Placement moves
// only fetch handlers, and a ConnectorBroker RPC runs beside its caller, so the cron's
// transactions and the broker's paid the cron machine's distance to us-east-1.
//
// The latency test runs the real deployed entry (bundled, tests/fixtures/connector-entry.mjs)
// on a virtual clock, over a fake Neon whose round trips cost what the opening machine's
// distance costs, and a fake broker that runs beside its caller. The same run where the cron
// runs reproduces the 2026-10-25 12:41 UTC lines (all four steps unavailable, each at its
// 3000 ms deadline); scheduled() at that same far edge, through the object, answers every
// step. Then the forwarding's fail-closed cases, the object's shape and busy guard, and
// where a connector transaction ended (connectorSqlObservation). No network and no database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import {
  encodeNeonLeaseGrant,
  encodeShopifyWebhookSyncResult,
} from "../packages/identity/src/broker-protocol.ts";
import { connectorBudgets } from "../apps/shopify-connector/worker/connector.ts";
import {
  connectorCron,
  connectorCronNamespace,
  forwardConnectorCron,
} from "../apps/shopify-connector/worker/cron.ts";
import {
  connectorLogin,
  connectorSql,
  connectorSqlObservation,
  connectorTransactionCauses,
  connectorTransactionPhases,
  createConnectorDatabase,
} from "../apps/shopify-connector/worker/database.ts";
import { edgeDurableObjectLocationHint } from "../scripts/edge.mjs";
import { loadConnectorEntry } from "./fixtures/connector-entry.mjs";

const entry = await loadConnectorEntry();
const origin = "https://connector.morrow.test";
const apiOrigin = "https://api.morrow.test";
const binding = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-connector-unit",
  branchId: "br-connector-unit",
  hostname: "ep-connector-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const leasePassword = "lease-" + "p".repeat(26);
// The broker's per-transaction vault budget in the sync (shopify-webhooks.ts vaultBudgetMs).
const vaultBudgetMs = 3000;
// Round trips to Neon's us-east-1: from a far edge (where the 12:41 cron ran: at least
// about 230 ms puts 13 round trips past 3000 ms), and from the object created with the
// hint "enam" (Eastern North America).
const roundTripMs = { far: 260, enam: 25 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Runs `run` on the mocked clock, ticking in 5 ms steps until it settles (every duration
// here is a multiple of 5 ms; each macrotask turn drains the continuations a tick wakes).
async function virtually(run, { stepMs = 5, maxMs = 300000 } = {}) {
  let settled = false;
  const pending = Promise.resolve().then(run);
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let waited = 0; !settled; waited += stepMs) {
    if (waited > maxMs) throw Error("VIRTUAL_CLOCK_RAN_OUT");
    for (let i = 0; i < 2 && !settled; i++) await new Promise(setImmediate);
    if (!settled) mock.timers.tick(stepMs);
  }
  return pending;
}
// Captures console.log lines (each one JSON) and empties process.env (the connector refuses
// a populated one, nodejs_compat_do_not_populate_process_env) for one test body.
async function captured(run) {
  const lines = [];
  const savedLog = console.log;
  const savedEnv = process.env;
  console.log = (line) => lines.push(JSON.parse(line));
  process.env = {};
  try {
    await run(lines);
  } finally {
    console.log = savedLog;
    process.env = savedEnv;
  }
  return lines;
}

const roleRow = {
  role: connectorLogin,
  login: connectorLogin,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  role_member: false,
};
const plain = new Set([
  connectorSql.begin,
  connectorSql.statementTimeout,
  connectorSql.lockTimeout,
  connectorSql.idleTimeout,
  connectorSql.commit,
  connectorSql.rollback,
]);
// The database's answers to the cron's id reads: nothing pending, nothing overdue, and (v1
// PR 5, after the subscription sync) no open Reconnect item. The clean-up switch is off
// here, so its read-backs, deletions and stuck deliveries are never read.
function answer(text) {
  if (plain.has(text)) return [];
  if (text === connectorSql.role) return [roleRow];
  if (
    text === connectorSql.inboxPending ||
    text === connectorSql.credentialsPending ||
    text === connectorSql.noticesDue
  )
    return [];
  if (text === connectorSql.privacyOverdue) return [{ target_missed: 0, due_missed: 0 }];
  throw Error("UNEXPECTED_STATEMENT");
}
// Where the code runs now, and what it did there.
const createWorld = (at) => ({ at, opened: [], brokerCalls: [] });
// A connection belongs to the machine that opened it: its connect is 6 round trips (the
// WebSocket's TCP, TLS and upgrade; Postgres startup and SCRAM) and each statement one.
const fakeNeon = (world) => ({
  open(config) {
    const at = world.at;
    const rtt = roundTripMs[at];
    world.opened.push([at, config.user]);
    return {
      connect: () => sleep(6 * rtt),
      async query(text) {
        await sleep(rtt);
        return { rows: answer(text) };
      },
      end: async () => {},
    };
  },
});
// The ConnectorBroker binding. Its RPCs run beside the caller: the lease is a lookup with no
// database; each of the sync's vault transactions is the same 13 round trips from there,
// against the broker's 3000 ms (a miss is BROKER_HELD at the deadline), then Shopify's list
// and creates; one store to register.
const fakeBroker = (world) => ({
  fetch() {},
  health: async () => true,
  async neonLease() {
    world.brokerCalls.push(["neonLease", world.at]);
    return encodeNeonLeaseGrant(leasePassword);
  },
  async shopifyWebhookSubscriptionsSync(budgetMs) {
    const at = world.at;
    world.brokerCalls.push(["subscriptions", at, budgetMs]);
    const transactionMs = 13 * roundTripMs[at];
    for (const step of ["pending", "target", "record"]) {
      if (transactionMs > vaultBudgetMs) {
        await sleep(vaultBudgetMs);
        throw Error("BROKER_HELD");
      }
      await sleep(transactionMs);
      if (step === "target") await sleep(450);
    }
    return encodeShopifyWebhookSyncResult({
      checked: 1,
      registered: 1,
      failed: 0,
      unknown: 0,
      unauthorized: 0,
      skipped: 0,
    });
  },
  async shopifyCredentialDestroy() {
    throw Error("UNEXPECTED_DESTROY");
  },
});
const limiter = { limit: async () => ({ success: true }) };
// A Durable Object namespace: get() creates the named object once, where its location
// hint says, and every call on its stub runs there; the caller's place is restored after.
function fakeNamespace(world, env) {
  const objects = new Map();
  const calls = [];
  return {
    calls,
    idFromName(name) {
      calls.push(["idFromName", name]);
      return Object.freeze({ name });
    },
    get(id, options) {
      calls.push(["get", id.name, options?.locationHint ?? null]);
      if (!objects.has(id.name))
        objects.set(id.name, {
          at: Object.hasOwn(roundTripMs, options?.locationHint) ? options.locationHint : world.at,
          instance: new entry.ConnectorCron({ id }, env),
        });
      const object = objects.get(id.name);
      return {
        async redrive() {
          const caller = world.at;
          world.at = object.at;
          try {
            return await object.instance.redrive();
          } finally {
            world.at = caller;
          }
        },
      };
    },
  };
}
function cronEnv(world, { namespace = true } = {}) {
  const env = {
    MORROW_ENVIRONMENT: "staging",
    CONNECTOR_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, origin, apiOrigin }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
    BROKER: fakeBroker(world),
    INSTALL_LIMITER: limiter,
    WEBHOOK_LIMITER: limiter,
  };
  if (namespace) env.CONNECTOR_CRON = fakeNamespace(world, env);
  return env;
}
// One cron run on the virtual clock, from a far edge: `scheduled` through the deployed
// entry, or `here`, the same re-drives run where the cron runs (what scheduled() did
// before: handler.redrive() in waitUntil, beside the cron).
async function farCron(how) {
  const world = createWorld("far");
  const env = cronEnv(world);
  const waited = [];
  const saved = globalThis.__morrowConnectorNeon;
  globalThis.__morrowConnectorNeon = fakeNeon(world);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_761_396_060_000 });
  try {
    const lines = await captured(async () => {
      const result = await virtually(() =>
        how === "scheduled"
          ? entry.default.scheduled({}, env, { waitUntil: (p) => waited.push(p) })
          : new entry.ConnectorCron({}, env).redrive(),
      );
      if (how === "scheduled") assert.equal(result, undefined);
      else assert.equal(result, "ran");
    });
    return { world, env, lines, waited };
  } finally {
    mock.timers.reset();
    globalThis.__morrowConnectorNeon = saved;
  }
}
const events = (lines, name) => lines.filter((line) => line.event === name);
const idRead = (code) => ({
  event: "morrow_connector_cron",
  code,
  phase: "body",
  cause: "deadline",
  statements: 5,
  connectMs: 1550,
  txMs: 3000,
});

test("latency: where the cron runs, every step misses its 3 s (the 12:41 lines); through the object, all answer", async () => {
  // Before: the re-drives beside the cron, at a far edge. Each connector transaction is
  // connected at 1560 ms and its statement would answer at 3120 ms, past its 3000 ms; the
  // broker's first vault transaction misses its own 3000 ms the same way.
  const before = await farCron("here");
  // v1 PR 5: the open Reconnect items' list, read after the sync, misses the same way.
  assert.deepEqual(events(before.lines, "morrow_connector_cron"), [
    idRead("INBOX_PENDING_UNAVAILABLE"),
    idRead("CREDENTIALS_PENDING_UNAVAILABLE"),
    idRead("NOTICES_DUE_UNAVAILABLE"),
  ]);
  assert.deepEqual(events(before.lines, "morrow_connector_privacy"), [
    { ...idRead("PRIVACY_CHECK_UNAVAILABLE"), event: "morrow_connector_privacy" },
  ]);
  assert.deepEqual(events(before.lines, "morrow_connector_webhooks"), [
    {
      event: "morrow_connector_webhooks",
      code: "SUBSCRIPTIONS_UNAVAILABLE",
      reason: "refused",
      elapsedMs: 3000,
    },
  ]);
  assert.deepEqual(events(before.lines, "morrow_connector_redrive"), [
    {
      event: "morrow_connector_redrive",
      inbox: 0,
      applied: 0,
      credentials: 0,
      destroyed: 0,
      targetMissed: 0,
      dueMissed: 0,
      subscriptionsChecked: 0,
      subscriptionsRegistered: 0,
      unavailable: 5,
      notices: 0,
      reconciled: 0,
      checks: 0,
      observed: 0,
      refused: 0,
      deletions: 0,
      deleted: 0,
      stuckClosed: 0,
      stuck: 0,
      elapsedMs: 15000,
    },
  ]);
  assert.ok(before.world.opened.every(([at]) => at === "far"));
  assert.deepEqual(
    before.world.brokerCalls.find(([call]) => call === "subscriptions"),
    ["subscriptions", "far", connectorBudgets.subscriptionsCronMs],
  );

  // After: scheduled() at the same far edge hands the run to the object, created with the
  // hint "enam"; every connection, the leases and the sync run there, and every step
  // answers well inside its budget. scheduled() waits for the run (nothing in waitUntil).
  const after = await farCron("scheduled");
  assert.deepEqual(after.env.CONNECTOR_CRON.calls, [
    ["idFromName", "redrive"],
    ["get", "redrive", "enam"],
  ]);
  assert.equal(after.waited.length, 0);
  assert.deepEqual(after.world.opened, [
    ["enam", connectorLogin],
    ["enam", connectorLogin],
    ["enam", connectorLogin],
    ["enam", connectorLogin],
  ]);
  assert.deepEqual(after.world.brokerCalls, [
    ["neonLease", "enam"],
    ["neonLease", "enam"],
    ["neonLease", "enam"],
    ["subscriptions", "enam", connectorBudgets.subscriptionsCronMs],
    ["neonLease", "enam"],
  ]);
  assert.deepEqual(events(after.lines, "morrow_connector_cron"), []);
  assert.deepEqual(events(after.lines, "morrow_connector_privacy"), []);
  assert.deepEqual(events(after.lines, "morrow_connector_webhooks"), [
    {
      event: "morrow_connector_webhooks",
      code: "SUBSCRIPTIONS_SYNCED",
      checked: 1,
      registered: 1,
      failed: 0,
      unknown: 0,
      unauthorized: 0,
      skipped: 0,
    },
  ]);
  assert.deepEqual(events(after.lines, "morrow_connector_redrive"), [
    {
      event: "morrow_connector_redrive",
      inbox: 0,
      applied: 0,
      credentials: 0,
      destroyed: 0,
      targetMissed: 0,
      dueMissed: 0,
      subscriptionsChecked: 1,
      subscriptionsRegistered: 1,
      unavailable: 0,
      notices: 0,
      reconciled: 0,
      checks: 0,
      observed: 0,
      refused: 0,
      deletions: 0,
      deleted: 0,
      stuckClosed: 0,
      stuck: 0,
      // Three transactions of 13 x 25 ms, then the sync's three and Shopify's 450 ms, then
      // v1 PR 5's Reconnect list, one more transaction of 13 x 25 ms (2725 ms, logged in
      // 50 ms steps).
      elapsedMs: 2700,
    },
  ]);
  // Every line is closed codes and counts: no host, lease, binding or origin.
  for (const line of [...before.lines, ...after.lines]) {
    const text = JSON.stringify(line);
    for (const marker of [leasePassword, binding.hostname, binding.projectId, origin, apiOrigin])
      assert.ok(!text.includes(marker), text);
  }
});

test("the object's hint is the Neon region's, and scheduled() waits past the run's own deadline", () => {
  const staging = JSON.parse(readFileSync("infra/environments/staging.json", "utf8"));
  assert.equal(connectorCron.locationHint, edgeDurableObjectLocationHint(staging.neon.region_id));
  assert.equal(connectorCron.locationHint, "enam");
  assert.deepEqual(
    { binding: connectorCron.binding, className: connectorCron.className },
    { binding: "CONNECTOR_CRON", className: "ConnectorCron" },
  );
  assert.equal(connectorCron.objectName, "redrive");
  // The run starts its last step before redriveMs; the wait covers that step's own budget.
  assert.ok(connectorCron.waitMs >= connectorBudgets.redriveMs + 30000);
  assert.ok(connectorCron.waitMs < 15 * 60 * 1000, "inside a cron invocation's wall time");
});

test("scheduled(): an unbound connector touches nothing; a missing or malformed binding runs nothing", async () => {
  const lines = await captured(async () => {
    // Unconfigured: the namespace is never asked for an object.
    const world = createWorld("far");
    const unconfigured = { MORROW_ENVIRONMENT: "staging" };
    unconfigured.CONNECTOR_CRON = fakeNamespace(world, unconfigured);
    await entry.default.scheduled({}, unconfigured, {});
    assert.deepEqual(unconfigured.CONNECTOR_CRON.calls, []);
    // Configured without the binding, or with a malformed one: one CRON_UNBOUND line each,
    // and no lease, connection or sync.
    for (const value of [undefined, null, {}, { idFromName() {}, get: 1 }, "CONNECTOR_CRON"]) {
      const env = cronEnv(world, { namespace: false });
      if (value !== undefined) env.CONNECTOR_CRON = value;
      await entry.default.scheduled({}, env, {});
    }
    const accessor = cronEnv(world, { namespace: false });
    Object.defineProperty(accessor, "CONNECTOR_CRON", {
      enumerable: true,
      get: () => fakeNamespace(world, accessor),
    });
    await entry.default.scheduled({}, accessor, {});
    assert.deepEqual(world.brokerCalls, []);
    assert.deepEqual(world.opened, []);
  });
  assert.deepEqual(
    events(lines, "morrow_connector_cron").map((line) => line.code),
    Array(6).fill("CRON_UNBOUND"),
  );
  assert.deepEqual(events(lines, "morrow_connector_redrive"), []);
});

test("forwarding: a failing, busy, unbound, odd or late object is one fixed line; never a throw", async () => {
  const stub = (redrive) => {
    const calls = [];
    return {
      calls,
      env: {
        CONNECTOR_CRON: {
          idFromName: (name) => (calls.push(["idFromName", name]), { name }),
          get: (id, options) => (calls.push(["get", id.name, options]), { redrive }),
        },
      },
    };
  };
  const lines = await captured(async () => {
    const ran = stub(async () => "ran");
    assert.equal(await forwardConnectorCron(ran.env), "ran");
    assert.deepEqual(ran.calls, [
      ["idFromName", "redrive"],
      ["get", "redrive", { locationHint: "enam" }],
    ]);
    assert.equal(await forwardConnectorCron(stub(async () => "busy").env), "busy");
    assert.equal(await forwardConnectorCron(stub(async () => "unbound").env), "object_unbound");
    for (const odd of [undefined, null, "RAN", { inbox: 0 }, 1])
      assert.equal(await forwardConnectorCron(stub(async () => odd).env), "unavailable");
    assert.equal(
      await forwardConnectorCron(
        stub(async () => {
          throw Error("Durable Object reset because its code was updated.");
        }).env,
      ),
      "unavailable",
    );
    const throwing = {
      CONNECTOR_CRON: {
        idFromName() {
          throw Error("x");
        },
        get() {},
      },
    };
    assert.equal(await forwardConnectorCron(throwing), "unavailable");
    // An object that never answers: given up after waitMs (mock clock), then nothing more.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const late = forwardConnectorCron(stub(() => new Promise(() => {})).env);
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      mock.timers.tick(connectorCron.waitMs - 1);
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      let settled = false;
      void late.then(() => (settled = true));
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      assert.equal(settled, false);
      mock.timers.tick(1);
      assert.equal(await late, "unavailable");
    } finally {
      mock.timers.reset();
    }
  });
  assert.deepEqual(
    lines.map((line) => line.code),
    [
      "CRON_BUSY",
      "CRON_OBJECT_UNBOUND",
      ...Array(5).fill("CRON_OBJECT_UNAVAILABLE"),
      "CRON_OBJECT_UNAVAILABLE",
      "CRON_OBJECT_UNAVAILABLE",
      "CRON_OBJECT_UNAVAILABLE",
    ],
  );
  assert.ok(lines.every((line) => Object.keys(line).join(",") === "event,code"));
  assert.equal(connectorCronNamespace({}), null);
  assert.equal(connectorCronNamespace(null), null);
});

test("ConnectorCron: one RPC method, nothing run when unbound, a second run while one runs is busy", async () => {
  assert.deepEqual(Object.getOwnPropertyNames(entry.ConnectorCron.prototype).sort(), [
    "constructor",
    "redrive",
  ]);
  const lines = await captured(async () => {
    const world = createWorld("enam");
    const unbound = new entry.ConnectorCron({}, { MORROW_ENVIRONMENT: "staging" });
    assert.equal(await unbound.redrive(), "unbound");
    const env = cronEnv(world, { namespace: false });
    const saved = globalThis.__morrowConnectorNeon;
    globalThis.__morrowConnectorNeon = fakeNeon(world);
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_761_396_060_000 });
    try {
      const object = new entry.ConnectorCron({}, env);
      const [first, second] = await virtually(() =>
        Promise.all([object.redrive(), object.redrive()]),
      );
      assert.deepEqual([first, second], ["ran", "busy"]);
      assert.equal(await virtually(() => object.redrive()), "ran");
    } finally {
      mock.timers.reset();
      globalThis.__morrowConnectorNeon = saved;
    }
  });
  // Two runs completed, each with its one line.
  assert.equal(events(lines, "morrow_connector_redrive").length, 2);
  assert.ok(events(lines, "morrow_connector_redrive").every((line) => line.unavailable === 0));
});

// Where a connector transaction ended, carried on its error and read with
// connectorSqlObservation: one case per phase and cause, on a fake driver and the mocked
// clock. The order, the deadline and the outcome are the transport's own.
test("database: a failed transaction's error names its phase, cause, statements and durations", async () => {
  const lease = (behaviour = "grant") => ({
    neonLease: async () => {
      if (behaviour === "refuse") throw Error("BROKER_HELD");
      if (behaviour === "hang") return new Promise(() => {});
      if (behaviour === "garbled") return "{}";
      return encodeNeonLeaseGrant(leasePassword);
    },
  });
  // A driver whose statements each take 10 ms; `fault` changes one step.
  const driver =
    (fault = {}) =>
    () => ({
      on() {},
      async connect() {
        if (fault.connect === "throw") throw Error("socket");
        if (fault.connect === "hang") return new Promise(() => {});
        await sleep(30);
      },
      async query(text) {
        await sleep(10);
        if (fault.text === text && fault.as === "throw") throw Error("driver");
        if (fault.text === text && fault.as === "no_rows") return {};
        if (fault.text === text && fault.as === "rows") return { rows: fault.rows };
        if (fault.text === text && fault.as === "hang") return new Promise(() => {});
        return { rows: answer(text) };
      },
      end: async () => {},
    });
  const run = async (broker, factory, budgetMs = 500) => {
    const database = createConnectorDatabase(binding, broker, factory, Date.now);
    try {
      return { value: await database.privacyOverdue(budgetMs) };
    } catch (error) {
      assert.equal(error.message, "CONNECTOR_SQL_UNAVAILABLE");
      assert.ok(!JSON.stringify(error).includes(leasePassword));
      return { seen: connectorSqlObservation(error) };
    }
  };
  const cases = [
    ["grant", {}, { value: { targetMissed: 0, dueMissed: 0 } }],
    ["refuse", {}, ["lease", "lease", 0, null, 0]],
    ["garbled", {}, ["lease", "lease", 0, null, 0]],
    ["hang", {}, ["lease", "deadline", 0, null, 500]],
    ["grant", { connect: "throw" }, ["connect", "driver", 0, null, 0]],
    ["grant", { connect: "hang" }, ["connect", "deadline", 0, null, 500]],
    ["grant", { text: connectorSql.begin, as: "no_rows" }, ["begin", "rows_shape", 0, 30, 40]],
    ["grant", { text: connectorSql.role, as: "rows", rows: [] }, ["role", "role_check", 2, 30, 50]],
    [
      "grant",
      { text: connectorSql.role, as: "rows", rows: [{ ...roleRow, rolbypassrls: true }] },
      ["role", "role_check", 2, 30, 50],
    ],
    ["grant", { text: connectorSql.lockTimeout, as: "throw" }, ["settings", "driver", 3, 30, 70]],
    [
      "grant",
      {
        text: connectorSql.privacyOverdue,
        as: "rows",
        rows: [{ target_missed: -1, due_missed: 0 }],
      },
      ["body", "body", 6, 30, 90],
    ],
    ["grant", { text: connectorSql.privacyOverdue, as: "hang" }, ["body", "deadline", 5, 30, 500]],
    ["grant", { text: connectorSql.commit, as: "throw" }, ["commit", "driver", 6, 30, 100]],
  ];
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_761_396_060_000 });
  try {
    for (const [index, [leasing, fault, expected]] of cases.entries()) {
      const outcome = await virtually(() => run(lease(leasing), driver(fault)));
      if (!Array.isArray(expected)) {
        assert.deepEqual(outcome, expected, String(index));
        continue;
      }
      const [phase, cause, statements, connectMs, txMs] = expected;
      assert.deepEqual(outcome.seen, { phase, cause, statements, connectMs, txMs }, String(index));
      assert.ok(Object.isFrozen(outcome.seen));
      assert.ok(connectorTransactionPhases.includes(outcome.seen.phase));
      assert.ok(connectorTransactionCauses.includes(outcome.seen.cause));
    }
  } finally {
    mock.timers.reset();
  }
  // Any other error carries no observation.
  assert.equal(connectorSqlObservation(Error("CONNECTOR_SQL_UNAVAILABLE")), null);
  assert.equal(connectorSqlObservation(undefined), null);
});
