// Build order PR 7 (ADR-0029 items 2 to 5, 8 and 9): the broker's runtime gateway, the one
// door for every computer job, over the deterministic fake adapter and an in-memory ledger
// with the SQL ledger's contract (migration 0039 is proved by lab:runtime-operations).
//   * The switch first: off (the committed state), a missing key, vault, adapter or pinned
//     template, and production all hold RUNTIME_UNAVAILABLE before any input, ledger or
//     provider access; cleanup-only admits the sweep and never a create. The deployed broker
//     composes no adapter (PR 8 adds E2B) and never the fake.
//   * Closed inputs; minimised inputs refuse before the ledger.
//   * The send mark commits before any create; a refused or replayed begin never creates.
//   * One create, never retried: anything but `created` after the send is unknown_effect
//     with a runtime hold; the sweep finds a lost sandbox by its metadata and kills it.
//   * Every created sandbox is killed; `not_found` or `unknown` on the kill is never counted
//     as deleted; absence is verified only on a qualified profile past the grace.
//   * Results carry checked outputs only and no sandbox id, token, key or provider id; nothing
//     the sandbox saw carries a credential.
//   * The vault ledger sends only registered statements and reads rows strictly.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  brokerNeonRoleNames,
  brokerOptionalSecretsFor,
  brokerPasswordSecret,
  brokerRequiredSecretsFor,
  brokerRuntimeSecrets,
  e2bKeyPattern,
  runtimeGatewayLimits,
  runtimeSwitchVar,
} from "../packages/identity/src/broker-protocol.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { createFakeRuntime } from "../apps/broker/src/runtime-fake.ts";
import { createRuntimeGateway } from "../apps/broker/src/runtime-gateway.ts";
import { createVaultRuntimeLedger } from "../apps/broker/src/runtime-ledger.ts";
import { vaultStatements } from "../apps/broker/src/vault.ts";
import { runtimeVaultStatements } from "../apps/broker/src/vault-statements-runtime.ts";
import { computerProfile } from "../packages/policy/src/runtime-computer.ts";
import { createPlatformWorkosProviderOracle } from "../scripts/fixtures/fixed-workos-platform-provider.mjs";
import { makePng, makeXlsx } from "./fixtures/runtime-files.mjs";

const e2bKey = () => "e2b_" + randomBytes(20).toString("hex");
const login = JSON.parse(
  createPlatformWorkosProviderOracle({ origin: "https://workspace.example.test" }).configurationJson,
);
function brokerEnv(environment = "development", extra = {}) {
  return {
    MORROW_ENVIRONMENT: environment,
    LOGIN_CONFIGURATION_JSON: JSON.stringify({ ...login, retentionTier: environment }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify({
      schemaVersion: 1,
      environment,
      projectId: "morrow-broker-unit",
      branchId: "br-broker-unit",
      hostname: "ep-broker-unit.c-14.us-east-1.aws.neon.tech",
      database: "morrow",
    }),
    WORKOS_API_KEY: "sk_test_" + randomBytes(16).toString("hex"),
    ...Object.fromEntries(
      [...brokerNeonRoleNames, "morrow_vault_broker"].map((role) => [
        brokerPasswordSecret(role),
        "role-" + randomBytes(16).toString("hex"),
      ]),
    ),
    MORROW_VAULT_KEK_V1: randomBytes(32).toString("hex"),
    ...extra,
  };
}
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));
const heldCodes = (method) =>
  logs
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    })
    .filter((r) => r.event === "morrow_broker" && r.method === method)
    .map((r) => r.code);
async function held(pending, method = "runtimeExecute") {
  try {
    await pending;
  } catch (error) {
    assert.equal(error.message, "BROKER_HELD");
    assert.deepEqual(Object.keys(error), []);
    return heldCodes(method).at(-1);
  }
  assert.fail("expected BROKER_HELD");
}

// An in-memory ledger with the SQL ledger's contract: the send mark, one operation per run
// and call key, settlement edges, holds raised by unknown outcomes, the sweep's list.
function memoryLedger(events, { refuse = null, leaseRefused = false, now = () => Date.now() } = {}) {
  const ops = new Map();
  const keys = new Map();
  const holds = [];
  const terminal = ["killed", "absent_verified", "not_created"];
  const ledger = {
    ops,
    holds,
    async begin(request) {
      events.push(["ledger.begin", request.callKey]);
      if (leaseRefused) return { outcome: "lease_refused" };
      if (refuse) return { outcome: "refused", code: refuse };
      if (keys.has(request.callKey)) return { outcome: "replay", operationId: keys.get(request.callKey) };
      if (holds.some((h) => !h.lifted)) return { outcome: "refused", code: "runtime_held" };
      const operationId = randomUUID();
      ops.set(operationId, {
        status: "sending",
        sandboxRef: null,
        reason: null,
        provider: request.provider,
        jobDigest: request.jobDigest,
        deadlineAtMs: now() + 960_000,
        stale: false,
        pastGrace: false,
      });
      keys.set(request.callKey, operationId);
      return { outcome: "begun", operationId, deadlineAtMs: now() + 960_000 };
    },
    async created(operationId, sandboxRef) {
      events.push(["ledger.created", sandboxRef]);
      const o = ops.get(operationId);
      if (!o || o.status !== "sending") return false;
      o.status = "created";
      o.sandboxRef = sandboxRef;
      return true;
    },
    async settle(operationId, status) {
      events.push(["ledger.settle", status]);
      const o = ops.get(operationId);
      if (!o || terminal.includes(o.status)) return false;
      if (status === "not_created" && o.status !== "sending") return false;
      if (status === "absent_verified" && !o.pastGrace) return false;
      o.status = status;
      return true;
    },
    async unknown(operationId, reason) {
      events.push(["ledger.unknown", reason]);
      const o = ops.get(operationId);
      if (!o || terminal.includes(o.status)) return false;
      o.status = "unknown_effect";
      o.reason = reason;
      if (!holds.some((h) => h.operationId === operationId)) holds.push({ operationId, reason, lifted: false });
      return true;
    },
    async open(limit) {
      events.push(["ledger.open", limit]);
      return [...ops.entries()]
        .filter(([, o]) => !terminal.includes(o.status))
        .slice(0, limit)
        .map(([operationId, o]) => ({
          operationId,
          provider: o.provider,
          sandboxRef: o.sandboxRef,
          status: o.status,
          deadlineAtMs: o.deadlineAtMs,
          stale: o.stale,
          pastGrace: o.pastGrace,
        }));
    },
  };
  return ledger;
}
// The fake adapter, with every port call recorded into the shared event list.
function recorded(adapter, events) {
  const wrap = (name) => async (...args) => {
    events.push(["adapter." + name, name === "create" ? args[0].operationId : null]);
    return adapter[name](...args);
  };
  return {
    provider: adapter.provider,
    create: wrap("create"),
    status: wrap("status"),
    writeFile: wrap("writeFile"),
    exec: wrap("exec"),
    readFile: wrap("readFile"),
    kill: wrap("kill"),
  };
}
function world(options = {}) {
  let now = Date.parse("2026-10-23T10:00:00.000Z");
  const events = [];
  const key = e2bKey();
  const fake = createFakeRuntime({ credential: key, now: () => now });
  const ledger = memoryLedger(events, { ...options.ledger, now: () => now });
  const adapter = options.adapter ? options.adapter(fake, events) : recorded(fake, events);
  const gateway = createRuntimeGateway({
    ledger: () => ledger,
    providers: Object.freeze(options.providers ?? { e2b: adapter }),
    now: () => now,
    template: options.template === undefined ? "morrow-computer-fake-v1" : options.template,
    qualified: options.qualified ?? false,
  });
  const env = brokerEnv(options.environment ?? "development", {
    [runtimeSwitchVar]: options.mode ?? "on",
    E2B_API_KEY: key,
    ...options.env,
  });
  return {
    fake,
    ledger,
    events,
    key,
    env,
    gateway,
    advance: (ms) => (now += ms),
    execute: (job, over = {}) =>
      gateway.runtimeExecute(
        over.env ?? env,
        over.leaseId ?? "00000000-0000-4000-8000-0000000000aa",
        over.generation ?? 1,
        typeof job === "string" ? job : JSON.stringify(job),
        over.budgetMs ?? 300_000,
      ),
    sweep: (budgetMs = 120_000) => gateway.runtimeSweep(env, budgetMs),
  };
}
const directive = (path, bytes) => "#!fake write " + path + " " + Buffer.from(bytes).toString("base64");
const job = (over = {}) => ({
  schemaVersion: 1,
  kind: "python_analysis",
  callKey: over.callKey ?? "step-1",
  script:
    over.script ??
    [
      "#!fake stdout analysed 1 product",
      directive("/home/agent/output/chart.png", makePng()),
      directive("/home/agent/output/table.csv", Buffer.from("sku,note\nA1,=1+2\n")),
      directive("/home/agent/output/book.xlsx", makeXlsx()),
    ].join("\n") + "\n",
  inputs: over.inputs ?? [
    {
      name: "products",
      kind: "products",
      rows: [["7001", over.title ?? "Linen shirt", null, null, "active", null, 1, "10.00", "10.00", 4, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"]],
    },
  ],
  outputs: over.outputs ?? [
    { name: "chart", type: "png" },
    { name: "table", type: "csv" },
    { name: "book", type: "xlsx" },
  ],
});
const names = (events) => events.map(([name]) => name);

test("the switch: off, a missing key, vault, adapter or template, and production hold before anything", async () => {
  const cases = [
    ["off (no MORROW_RUNTIME_SWITCH)", { env: { [runtimeSwitchVar]: undefined } }],
    ["another value", { env: { [runtimeSwitchVar]: "true" } }],
    ["cleanup only", { mode: "cleanup_only" }],
    ["no key", { env: { E2B_API_KEY: undefined } }],
    ["a malformed key", { env: { E2B_API_KEY: "sk-not-e2b" } }],
    ["no vault", { env: { MORROW_VAULT_KEK_V1: undefined } }],
    ["no adapter", { providers: {} }],
    ["no pinned template", { template: null }],
    ["production", { environment: "production" }],
  ];
  for (const [name, options] of cases) {
    const w = world(options);
    for (const [k, v] of Object.entries(options.env ?? {})) if (v === undefined) delete w.env[k];
    // Even invalid input is never read first.
    assert.equal(await held(w.execute("not json", { leaseId: "x" })), "RUNTIME_UNAVAILABLE", name);
    assert.equal(await held(w.execute(job())), "RUNTIME_UNAVAILABLE", name);
    assert.deepEqual(w.events, [], name);
    assert.equal(w.fake.calls.length, 0, name);
  }
  // Off, the broker does not even read the key (it may be bound ahead of the switch).
  const off = brokerEnv("staging", { E2B_API_KEY: e2bKey() });
  const capabilities = await brokerCapabilities(off);
  assert.equal(capabilities.computerMode, "off");
  assert.equal(capabilities.computer, null);
  const on = await brokerCapabilities(brokerEnv("staging", { [runtimeSwitchVar]: "on", E2B_API_KEY: e2bKey() }));
  assert.equal(on.computerMode, "on");
  assert.deepEqual(Object.keys(on.computer).sort(), ["apiKey", "provider"]);
  assert.equal(on.computer.provider, "e2b");
  const cleanup = await brokerCapabilities(brokerEnv("staging", { [runtimeSwitchVar]: "cleanup_only", E2B_API_KEY: e2bKey() }));
  assert.equal(cleanup.computerMode, "cleanup_only");
  const production = await brokerCapabilities(brokerEnv("production", { [runtimeSwitchVar]: "on", E2B_API_KEY: e2bKey() }));
  assert.equal(production.computerMode, "off");
  assert.equal(production.computer, null);
});

test("the deployed broker composes no runtime adapter, no template and no qualification, never the fake", () => {
  const index = readFileSync("apps/broker/src/index.ts", "utf8");
  assert.doesNotMatch(index, /runtime-fake/);
  assert.match(
    index,
    /createRuntimeGateway\(\{\n  ledger: \(vault\) => createVaultRuntimeLedger\(vault, runVaultTransaction\),\n  providers: Object\.freeze\(\{\}\),\n  now: \(\) => Date\.now\(\),\n  template: null,\n  qualified: false,\n\}\);/,
  );
  for (const file of ["runtime-gateway.ts", "runtime-ledger.ts", "runtime-provider.ts", "capabilities.ts", "index.ts"])
    assert.doesNotMatch(readFileSync("apps/broker/src/" + file, "utf8"), /from ["']e2b|@e2b\//, file);
  // The switch's names and the key's shape.
  assert.equal(runtimeSwitchVar, "MORROW_RUNTIME_SWITCH");
  assert.deepEqual([...brokerRuntimeSecrets], ["E2B_API_KEY"]);
  assert.ok(e2bKeyPattern.test(e2bKey()));
  assert.ok(!e2bKeyPattern.test("e2b_short"));
  assert.ok(!e2bKeyPattern.test("sk-ant-api03-" + "a".repeat(90)));
});

test("broker secrets: E2B_API_KEY is required only while the switch is not off, and optional only in staging while off", () => {
  const base = brokerRequiredSecretsFor("staging");
  assert.ok(!base.includes("E2B_API_KEY"));
  for (const mode of ["on", "cleanup_only"]) {
    const required = brokerRequiredSecretsFor("staging", "off", "off", mode);
    assert.deepEqual([...required].sort(), [...base, "E2B_API_KEY"].sort());
    assert.deepEqual(brokerOptionalSecretsFor("staging", mode), []);
  }
  assert.equal(brokerRequiredSecretsFor("development", "on", "on", "on").length, base.length + 2 + 1 + 1);
  assert.deepEqual([...brokerOptionalSecretsFor("staging", "off")], ["E2B_API_KEY"]);
  assert.deepEqual(brokerOptionalSecretsFor("development", "off"), []);
  assert.deepEqual(brokerOptionalSecretsFor("production", "off"), []);
  assert.throws(() => brokerRequiredSecretsFor("production", "off", "off", "on"), /BROKER_RUNTIME_SWITCH_INVALID/);
  assert.throws(() => brokerRequiredSecretsFor("production", "off", "off", "cleanup_only"), /BROKER_RUNTIME_SWITCH_INVALID/);
  assert.throws(() => brokerRequiredSecretsFor("staging", "off", "off", "yes"), /BROKER_RUNTIME_SWITCH_INVALID/);
  assert.throws(() => brokerOptionalSecretsFor("staging", "maybe"), /BROKER_RUNTIME_SWITCH_INVALID/);
});

test("closed inputs: lease, generation, budget and RuntimeJob@1 refuse before the ledger", async () => {
  const w = world();
  const bad = [
    [job(), { leaseId: "not-a-uuid" }],
    [job(), { generation: 0 }],
    [job(), { generation: 1.5 }],
    [job(), { budgetMs: runtimeGatewayLimits.executeBudgetMinMs - 1 }],
    [job(), { budgetMs: runtimeGatewayLimits.executeBudgetMaxMs + 1 }],
    ["{", {}],
    [{ ...job(), command: ["sh", "-c", "curl"] }, {}],
    [{ ...job(), template: "other" }, {}],
    [{ ...job(), internet: true }, {}],
    [job({ outputs: [{ name: "page", type: "html" }] }), {}],
    [job({ inputs: [{ name: "c", kind: "customers", rows: [] }] }), {}],
  ];
  for (const [value, over] of bad) assert.equal(await held(w.execute(value, over)), "INPUT_INVALID", JSON.stringify(over));
  assert.deepEqual(w.events, []);
});

test("minimised inputs: a URL, shop domain or email refuses the job before the ledger", async () => {
  const w = world();
  for (const title of ["https://morrow.example/x", "brand.myshopify.com", "mail owner@shop.example"]) {
    const result = JSON.parse(await w.execute(job({ title })));
    assert.deepEqual(result, {
      schemaVersion: 1,
      outcome: "refused",
      code: "input_content_forbidden",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputs: [],
      rejected: [],
      traceRef: null,
    });
  }
  assert.deepEqual(w.events, []);
});

test("a job: the send mark first, one create, the files, the command, the outputs checked, always killed", async () => {
  const w = world();
  const result = JSON.parse(await w.execute(job()));
  assert.deepEqual(names(w.events), [
    "ledger.begin",
    "adapter.create",
    "ledger.created",
    "adapter.writeFile",
    "adapter.writeFile",
    "adapter.exec",
    "adapter.readFile",
    "adapter.readFile",
    "adapter.readFile",
    "adapter.kill",
    "ledger.settle",
  ]);
  assert.deepEqual(w.events.at(-1), ["ledger.settle", "killed"]);
  assert.equal(result.outcome, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "analysed 1 product\n");
  assert.deepEqual(Object.keys(result).sort(), [
    "code",
    "exitCode",
    "outputs",
    "rejected",
    "schemaVersion",
    "stderr",
    "stdout",
    "traceRef",
  ]);
  const [op] = [...w.ledger.ops.keys()];
  assert.deepEqual(result.traceRef, { kind: "runtime_operation", id: op });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(
    result.outputs.map((o) => [o.name, o.type]),
    [
      ["chart", "png"],
      ["table", "csv"],
      ["book", "xlsx"],
    ],
  );
  for (const o of result.outputs) assert.deepEqual(Object.keys(o).sort(), ["base64", "name", "sha256", "size", "type"]);
  // The CSV is served with its formula cell escaped.
  assert.equal(Buffer.from(result.outputs[1].base64, "base64").toString("utf8"), "sku,note\r\nA1,'=1+2\r\n");
  // Nothing alive afterwards; the sandbox saw the fixed command, no environment and no secret.
  assert.deepEqual(w.fake.alive(), []);
  const text = await w.execute(job({ callKey: "step-2" }));
  const view = JSON.stringify({ ...w.fake.guest, files: w.fake.guest.files.map((f) => [f.path, Buffer.from(f.bytes).toString("utf8")]) });
  assert.ok(!view.includes(w.key));
  assert.doesNotMatch(view, /fake-envd-token|https?:\/\/|myshopify/);
  assert.deepEqual(w.fake.guest.creates[0], {
    template: "morrow-computer-fake-v1",
    timeoutSeconds: computerProfile.sandboxTimeoutSeconds,
    internet: false,
    metadata: { operation: op },
  });
  assert.deepEqual(w.fake.guest.commands[0].argv, [...computerProfile.command]);
  assert.equal(w.fake.guest.commands[0].user, "agent");
  assert.deepEqual(w.fake.guest.commands[0].environment, {});
  assert.deepEqual(
    w.fake.guest.files.filter((f) => f.sandboxRef === w.fake.guest.files[0].sandboxRef).map((f) => f.path),
    ["/home/agent/input/products.csv", "/home/agent/work/job.py"],
  );
  // No sandbox id, envd token, key or provider name crosses back.
  for (const reply of [JSON.stringify(result), text]) {
    assert.ok(!reply.includes(w.key));
    assert.doesNotMatch(reply, /fake0000|fake-envd|"provider"|sandbox/i);
  }
});

test("the send mark refuses: caps, holds and a missing capability never create; a lease refusal holds", async () => {
  for (const code of ["runtime_held", "monthly_budget", "concurrency_limit", "workspace_limit", "reservation_exhausted", "capability_missing"]) {
    const w = world({ ledger: { refuse: code } });
    assert.deepEqual(JSON.parse(await w.execute(job())), {
      schemaVersion: 1,
      outcome: "refused",
      code,
      exitCode: null,
      stdout: "",
      stderr: "",
      outputs: [],
      rejected: [],
      traceRef: null,
    });
    assert.deepEqual(names(w.events), ["ledger.begin"], code);
  }
  const w = world({ ledger: { leaseRefused: true } });
  assert.equal(await held(w.execute(job())), "STATE_INVALID");
  assert.deepEqual(names(w.events), ["ledger.begin"]);
});

test("a retried step (same run and call key) never creates again: it answers unknown", async () => {
  const w = world();
  await w.execute(job());
  const again = JSON.parse(await w.execute(job()));
  assert.equal(again.outcome, "unknown");
  assert.equal(again.code, "replayed");
  assert.equal(w.fake.created(), 1);
  assert.equal(names(w.events).filter((n) => n === "adapter.create").length, 1);
});

test("a lost create is unknown_effect with a hold, never retried; the sweep finds and kills it", async () => {
  const w = world();
  w.fake.fault({ op: "create", outcome: "unknown_effect", created: true });
  const result = JSON.parse(await w.execute(job()));
  assert.equal(result.outcome, "unknown");
  assert.equal(result.code, "create_unknown");
  assert.deepEqual(names(w.events), ["ledger.begin", "adapter.create", "ledger.unknown"]);
  assert.equal(w.fake.created(), 1);
  assert.equal(w.fake.alive().length, 1, "the lost sandbox is still running");
  assert.equal(w.ledger.holds.length, 1);
  // The hold refuses every create until a person lifts it.
  const next = JSON.parse(await w.execute(job({ callKey: "step-2" })));
  assert.deepEqual([next.outcome, next.code], ["refused", "runtime_held"]);
  assert.equal(w.fake.created(), 1);
  // The sweep: only stale operations; the lost one is found by its metadata and killed.
  const [op] = [...w.ledger.ops.keys()];
  assert.deepEqual(JSON.parse(await w.sweep()), { schemaVersion: 1, examined: 0, killed: 0, absentVerified: 0, unknown: 0, skipped: 1 });
  w.ledger.ops.get(op).stale = true;
  assert.deepEqual(JSON.parse(await w.sweep()), { schemaVersion: 1, examined: 1, killed: 1, absentVerified: 0, unknown: 0, skipped: 0 });
  assert.equal(w.ledger.ops.get(op).status, "killed");
  assert.deepEqual(w.fake.alive(), []);
  assert.equal(w.ledger.holds[0].lifted, false, "the sweep never lifts a hold");
});

test("quota and billing blocks are unknown with their own hold; not_sent alone settles not_created", async () => {
  for (const [outcome, code] of [
    ["quota_exhausted", "quota_exhausted"],
    ["billing_blocked", "billing_blocked"],
  ]) {
    const w = world();
    w.fake.fault({ op: "create", outcome });
    const result = JSON.parse(await w.execute(job()));
    assert.deepEqual([result.outcome, result.code], ["unknown", code]);
    assert.deepEqual(w.ledger.holds.map((h) => h.reason), [code]);
  }
  const w = world({ adapter: (fake, events) => ({ ...recorded(fake, events), create: async () => ({ outcome: "not_sent" }) }) });
  const result = JSON.parse(await w.execute(job()));
  assert.deepEqual([result.outcome, result.code], ["refused", "create_not_sent"]);
  assert.deepEqual(w.events.at(-1), ["ledger.settle", "not_created"]);
  assert.equal(w.ledger.holds.length, 0);
  // A throwing adapter is unknown_effect, never an error that escapes or a retry.
  const thrown = world({ adapter: (fake, events) => ({ ...recorded(fake, events), create: async () => { throw Error("socket"); } }) });
  const t = JSON.parse(await thrown.execute(job()));
  assert.deepEqual([t.outcome, t.code], ["unknown", "create_unknown"]);
  // A created reply with a malformed id is unknown too (the sandbox exists).
  const malformed = world({ adapter: (fake, events) => ({ ...recorded(fake, events), create: async () => ({ outcome: "created", sandboxRef: "../x", accessToken: null }) }) });
  const m = JSON.parse(await malformed.execute(job()));
  assert.deepEqual([m.outcome, m.code], ["unknown", "reply_invalid"]);
});

test("the job's own outcomes: non-zero exit, timeout, lost write or exec; the sandbox is killed every time", async () => {
  const failed = world();
  const f = JSON.parse(await failed.execute(job({ script: "#!fake stderr boom\n#!fake exit 3\n" })));
  assert.deepEqual([f.outcome, f.code, f.exitCode, f.stderr, f.outputs], ["failed", "exit_nonzero", 3, "boom\n", []]);
  const hung = world();
  assert.equal(JSON.parse(await hung.execute(job({ script: "#!fake hang\n" }))).outcome, "timed_out");
  for (const op of ["write", "exec"]) {
    const w = world();
    w.fake.fault({ op, outcome: "unknown" });
    const r = JSON.parse(await w.execute(job()));
    assert.deepEqual([r.outcome, r.code], ["unknown", op + "_unknown"]);
    assert.deepEqual(w.events.slice(-2), [["adapter.kill", null], ["ledger.settle", "killed"]]);
  }
  for (const w of [failed, hung]) {
    assert.deepEqual(w.fake.alive(), []);
    assert.deepEqual(w.events.at(-1), ["ledger.settle", "killed"]);
  }
});

test("outputs: missing, too large, invalid or lost are rejected by name; only checked bytes are served", async () => {
  const w = world();
  w.fake.fault({ op: "read", outcome: "unknown" });
  const result = JSON.parse(
    await w.execute(
      job({
        script: [directive("/home/agent/output/bad.png", Buffer.from("<svg onload=x>")), directive("/home/agent/output/ok.csv", Buffer.from("a\n1\n"))].join("\n"),
        outputs: [
          { name: "lost", type: "csv" },
          { name: "bad", type: "png" },
          { name: "none", type: "xlsx" },
          { name: "ok", type: "csv" },
        ],
      }),
    ),
  );
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.rejected, [
    { name: "lost", code: "read_unknown" },
    { name: "bad", code: "png_invalid" },
    { name: "none", code: "output_missing" },
  ]);
  assert.deepEqual(result.outputs.map((o) => o.name), ["ok"]);
});

test("a kill that answers not_found or unknown is never counted as deleted", async () => {
  for (const [answer, reason] of [
    [{ outcome: "not_found" }, "kill_not_found"],
    [{ outcome: "unknown" }, "kill_unknown"],
  ]) {
    const w = world({ adapter: (fake, events) => ({ ...recorded(fake, events), kill: async () => answer }) });
    const result = JSON.parse(await w.execute(job()));
    assert.equal(result.outcome, "completed");
    assert.deepEqual(w.events.at(-1), ["ledger.unknown", reason]);
    const [op] = [...w.ledger.ops.values()];
    assert.equal(op.status, "unknown_effect");
    assert.equal(w.ledger.holds.length, 1);
  }
});

test("the sweep: absence is verified only on a qualified profile past the grace; never a create", async () => {
  const lost = async (options) => {
    const w = world(options);
    w.fake.fault({ op: "create", outcome: "unknown_effect" });
    await w.execute(job());
    const [op] = [...w.ledger.ops.keys()];
    w.ledger.ops.get(op).stale = true;
    return { w, op };
  };
  // Unqualified (the deployed state): not_found stays unknown, however late.
  const a = await lost({ qualified: false });
  a.w.ledger.ops.get(a.op).pastGrace = true;
  assert.equal(JSON.parse(await a.w.sweep()).unknown, 1);
  assert.equal(a.w.ledger.ops.get(a.op).status, "unknown_effect");
  assert.equal(a.w.ledger.ops.get(a.op).reason, "not_found_unverified");
  // Qualified, not yet past the grace: still unknown.
  const b = await lost({ qualified: true });
  assert.equal(JSON.parse(await b.w.sweep()).unknown, 1);
  // Qualified and past the grace: absent_verified.
  const c = await lost({ qualified: true });
  c.w.ledger.ops.get(c.op).pastGrace = true;
  assert.equal(JSON.parse(await c.w.sweep()).absentVerified, 1);
  assert.equal(c.w.ledger.ops.get(c.op).status, "absent_verified");
  for (const { w } of [a, b, c]) assert.ok(!names(w.events).slice(3).includes("adapter.create"));
  // A paused sandbox is a profile violation: a hold, then the kill.
  const d = world();
  d.fake.fault({ op: "create", outcome: "unknown_effect", created: true });
  await d.execute(job());
  const [op] = [...d.ledger.ops.keys()];
  d.ledger.ops.get(op).stale = true;
  d.fake.fault({ op: "status", outcome: "paused" });
  assert.equal(JSON.parse(await d.sweep()).killed, 1);
  assert.ok(d.ledger.holds.length >= 1);
  assert.deepEqual(d.fake.alive(), []);
  // A lookup that is unknown leaves it unknown.
  const e = await lost({ qualified: true });
  e.w.fake.fault({ op: "status", outcome: "unknown" });
  e.w.ledger.ops.get(e.op).pastGrace = true;
  assert.equal(JSON.parse(await e.w.sweep()).unknown, 1);
  assert.equal(e.w.ledger.ops.get(e.op).reason, "status_unknown");
});

test("cleanup-only runs the sweep and nothing else; the sweep's budget is closed", async () => {
  const w = world({ mode: "cleanup_only" });
  assert.equal(await held(w.execute(job())), "RUNTIME_UNAVAILABLE");
  assert.deepEqual(JSON.parse(await w.sweep()), { schemaVersion: 1, examined: 0, killed: 0, absentVerified: 0, unknown: 0, skipped: 0 });
  assert.equal(await held(w.sweep(1), "runtimeSweep"), "INPUT_INVALID");
  assert.equal(await held(w.sweep(runtimeGatewayLimits.sweepBudgetMaxMs + 1), "runtimeSweep"), "INPUT_INVALID");
  const off = world({ env: { [runtimeSwitchVar]: "off" } });
  assert.equal(await held(off.sweep(), "runtimeSweep"), "RUNTIME_UNAVAILABLE");
});

test("the vault ledger: registered statements only, rows read strictly, failures never success", async () => {
  assert.deepEqual(
    Object.keys(runtimeVaultStatements).map((k) => vaultStatements[k] === runtimeVaultStatements[k]),
    [true, true, true, true],
  );
  const sent = [];
  let reply = [];
  const transaction = async (_vault, budgetMs, body) => {
    assert.ok(budgetMs <= 10_000);
    return body(async (text, values) => {
      sent.push([text, values]);
      return typeof reply === "function" ? reply(text) : reply;
    });
  };
  const vault = Object.freeze({});
  const ledger = createVaultRuntimeLedger(vault, transaction);
  const op = randomUUID();
  reply = [{ outcome: "begun", operation_id: op, deadline_at: "2026-10-23T10:16:00.000Z" }];
  const lease = randomUUID();
  assert.deepEqual(await ledger.begin({ leaseId: lease, generation: 2, callKey: "k", jobDigest: "a".repeat(64), provider: "e2b" }), {
    outcome: "begun",
    operationId: op,
    deadlineAtMs: Date.parse("2026-10-23T10:16:00.000Z"),
  });
  assert.deepEqual(sent.at(-1), [runtimeVaultStatements.runtimeOperationBegin, [lease, "2", "k", "a".repeat(64), "e2b"]]);
  for (const code of ["runtime_held", "monthly_budget", "concurrency_limit", "workspace_limit", "reservation_exhausted", "capability_missing"]) {
    reply = [{ outcome: code, operation_id: null, deadline_at: null }];
    assert.deepEqual(await ledger.begin({ leaseId: lease, generation: 1, callKey: "k", jobDigest: "a".repeat(64), provider: "e2b" }), { outcome: "refused", code });
  }
  for (const r of [
    [{ outcome: "stopped", operation_id: null, deadline_at: null }],
    [{ outcome: "begun", operation_id: "x", deadline_at: "2026-10-23T10:16:00.000Z" }],
    [{ outcome: "begun", operation_id: op, deadline_at: "soon" }],
    [{ outcome: "begun", operation_id: op, deadline_at: "2026-10-23T10:16:00.000Z", extra: 1 }],
    [],
  ]) {
    reply = r;
    assert.deepEqual(await ledger.begin({ leaseId: lease, generation: 1, callKey: "k", jobDigest: "a".repeat(64), provider: "e2b" }), { outcome: "lease_refused" });
  }
  reply = [{ outcome: "replay", operation_id: op, deadline_at: null }];
  assert.deepEqual(await ledger.begin({ leaseId: lease, generation: 1, callKey: "k", jobDigest: "a".repeat(64), provider: "e2b" }), { outcome: "replay", operationId: op });
  // A begin whose transaction fails throws (the gateway holds); the writes answer false.
  const broken = createVaultRuntimeLedger(vault, async () => {
    throw Error("VAULT_OUTCOME_UNKNOWN");
  });
  await assert.rejects(broken.begin({ leaseId: lease, generation: 1, callKey: "k", jobDigest: "a".repeat(64), provider: "e2b" }));
  assert.equal(await broken.created(op, "sbx1"), false);
  assert.equal(await broken.settle(op, "killed"), false);
  assert.equal(await broken.unknown(op, "kill_unknown"), false);
  assert.deepEqual(await broken.open(25), []);
  reply = [{ outcome: "recorded", status: "created" }];
  assert.equal(await ledger.created(op, "sbx1"), true);
  assert.deepEqual(sent.at(-1), [runtimeVaultStatements.runtimeOperationCreated, [op, "sbx1"]]);
  assert.equal(await ledger.created(op, "../bad"), false);
  reply = [{ outcome: "settled", status: "killed" }];
  assert.equal(await ledger.settle(op, "killed"), true);
  assert.deepEqual(sent.at(-1), [runtimeVaultStatements.runtimeOperationSettle, [op, "killed", ""]]);
  reply = [{ outcome: "too_early", status: "unknown_effect" }];
  assert.equal(await ledger.settle(op, "absent_verified"), false);
  reply = [{ outcome: "already_unknown", status: "unknown_effect" }];
  assert.equal(await ledger.unknown(op, "status_unknown"), true);
  assert.deepEqual(sent.at(-1), [runtimeVaultStatements.runtimeOperationSettle, [op, "unknown_effect", "status_unknown"]]);
  reply = [
    { operation_id: op, provider: "e2b", sandbox_ref: null, status: "sending", deadline_at: "2026-10-23T10:16:00.000Z", stale: "true", past_grace: "false" },
    { operation_id: "bad", provider: "e2b", sandbox_ref: null, status: "sending", deadline_at: "2026-10-23T10:16:00.000Z", stale: "true", past_grace: "false" },
    { operation_id: op, provider: "e2b", sandbox_ref: null, status: "killed", deadline_at: "2026-10-23T10:16:00.000Z", stale: "true", past_grace: "false" },
  ];
  assert.deepEqual(await ledger.open(25), [
    { operationId: op, provider: "e2b", sandboxRef: null, status: "sending", deadlineAtMs: Date.parse("2026-10-23T10:16:00.000Z"), stale: true, pastGrace: false },
  ]);
  assert.deepEqual(sent.at(-1), [runtimeVaultStatements.runtimeOperationsOpen, ["25"]]);
});
