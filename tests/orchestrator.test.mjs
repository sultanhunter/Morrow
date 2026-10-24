import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// P04.T02a AC21 (its meaning revised by M3 PR-2, the ID kept): dispatch stays disabled in the
// orchestrator Worker until the reviewed model-provider switch is on with every binding (M2
// PR-3's product read exists since the two were integrated, so the switch, committed off, is
// the only gate); ListingsRunWorkflow replaces MorrowWorkWorkflow. The connector
// (M2 PR-2's worker/index.ts) is fail-closed without its reviewed identifiers. `cloudflare:*` modules are stubbed.
const stubs = {
  "cloudflare:workers":
    "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  "cloudflare:workflows":
    "export class NonRetryableError extends Error { constructor(message, name) { super(message); this.name = name ?? 'NonRetryableError'; } }",
};
async function load(t, entry) {
  const directory = mkdtempSync(join(tmpdir(), "morrow-orchestrator-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    // M3 PR-2: the orchestrator bundles the policy kernels (node:crypto, as nodejs_compat
    // provides it in workerd) and the Neon driver.
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

test("AC21: queue() retries the whole batch once and never acks", async (t) => {
  const module = await load(t, "apps/workers/src/orchestrator.ts");
  const calls = { retryAll: 0, ackAll: 0, ack: 0, retry: 0 };
  const message = {
    id: "m1",
    body: { opaque: true },
    ack: () => calls.ack++,
    retry: () => calls.retry++,
  };
  const batch = {
    queue: "morrow-development-dispatch",
    messages: [message],
    retryAll: () => calls.retryAll++,
    ackAll: () => calls.ackAll++,
  };
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await module.default.queue(batch, {}, {});
  } finally {
    console.log = original;
  }
  assert.deepEqual(calls, { retryAll: 1, ackAll: 0, ack: 0, retry: 0 });
  assert.deepEqual(lines, ['{"event":"morrow_orchestrator_dispatch_disabled"}']);
  const response = await module.default.fetch(new Request("https://orchestrator.test/run"));
  assert.equal(response.status, 404);
});

test("AC21: run() throws NonRetryableError(dispatch_disabled) before any step unless the switch is on", async (t) => {
  const module = await load(t, "apps/workers/src/orchestrator.ts");
  let steps = 0;
  const step = new Proxy(
    {},
    {
      get() {
        steps++;
        return () => Promise.resolve();
      },
    },
  );
  assert.equal(module.MorrowWorkWorkflow, undefined);
  // workerd starts a module only when every named export is a function or an object (a
  // boolean export fails the Worker at startup: "Incorrect type for map entry"); the
  // orchestrator exports its entrypoints and nothing else (build order PR 11 adds
  // AgentRunWorkflow). The product read's reviewed constant stays the protocol's (true since
  // M2 PR-3 and M3 PR-2 were integrated).
  assert.deepEqual(Object.keys(module).sort(), [
    "AgentRunWorkflow",
    "ListingsRunWorkflow",
    "default",
  ]);
  assert.ok(
    Object.values(module).every(
      (value) => typeof value === "function" || (typeof value === "object" && value !== null),
    ),
  );
  const { runtimeProductReadAvailable } = await import(
    "../packages/identity/src/broker-protocol.ts"
  );
  assert.equal(runtimeProductReadAvailable, true);
  const binding = JSON.stringify({
    schemaVersion: 1,
    environment: "staging",
    projectId: "lab-project",
    branchId: "br-lab-branch",
    hostname: "ep-lab-endpoint.c-1.us-east-1.aws.neon.tech",
    database: "morrow",
  });
  const broker = { fetch() {}, neonLease() {}, modelRespond() {}, shopifyRead() {} };
  const workflowBinding = { create: () => Promise.resolve() };
  const full = {
    MORROW_ENVIRONMENT: "staging",
    MORROW_MODEL_PROVIDER: "anthropic",
    MORROW_DATABASE_BINDING_JSON: binding,
    BROKER: broker,
    LISTINGS_RUN: workflowBinding,
  };
  // The committed environment (MORROW_ENVIRONMENT only), every binding but the switch, the
  // switch on without its other bindings, and production: each is disabled before any step,
  // with a payload or without one.
  const { MORROW_MODEL_PROVIDER: _switch, ...switchOff } = full;
  for (const env of [
    { MORROW_ENVIRONMENT: "staging" },
    switchOff,
    { MORROW_ENVIRONMENT: "staging", MORROW_MODEL_PROVIDER: "anthropic" },
    { ...full, MORROW_ENVIRONMENT: "production" },
  ]) {
    const workflow = new module.ListingsRunWorkflow({}, env);
    for (const payload of [{}, { leaseId: "00000000-0000-4000-8000-000000000001", generation: 1 }])
      await assert.rejects(
        workflow.run({ payload, timestamp: new Date(), instanceId: "i" }, step),
        (error) =>
          error.constructor.name === "NonRetryableError" && error.message === "dispatch_disabled",
      );
  }
  assert.equal(steps, 0);
  // Build order PR 11: AgentRunWorkflow is disabled before any step unless the agent-loop
  // switch is on as well, with modelTurn and the AGENT_RUN binding: the model switch alone
  // (every binding, Node's process.env emptied as workerd's is), the loop var without the
  // model switch, and the loop var with a broken binding each refuse before any step.
  {
    const saved = process.env;
    process.env = {};
    try {
      const agentBroker = { ...broker, modelTurn() {} };
      const agentBinding = { create: () => Promise.resolve(), get: () => Promise.resolve({}) };
      const loop = { MORROW_AGENT_LOOP: "on", AGENT_RUN: agentBinding };
      const params = {
        schemaVersion: 1,
        workflow: "agent-run@1",
        organizationId: "org_o",
        workspaceId: "ws_w",
        runId: "00000000-0000-4000-8000-0000000000aa",
      };
      for (const env of [
        { MORROW_ENVIRONMENT: "staging" },
        { ...full },
        { ...full, BROKER: agentBroker, AGENT_RUN: agentBinding },
        { ...full, MORROW_AGENT_LOOP: "yes", BROKER: agentBroker, AGENT_RUN: agentBinding },
        { ...switchOff, ...loop, BROKER: agentBroker },
        { ...full, ...loop },
        { ...full, ...loop, BROKER: agentBroker, AGENT_RUN: { create() {} } },
        { ...full, ...loop, BROKER: agentBroker, MORROW_ENVIRONMENT: "production" },
      ]) {
        const workflow = new module.AgentRunWorkflow({}, env);
        await assert.rejects(
          workflow.run({ payload: params, timestamp: new Date(), instanceId: params.runId }, step),
          (error) =>
            error.constructor.name === "NonRetryableError" && error.message === "dispatch_disabled",
        );
      }
      assert.equal(steps, 0);
      // Both switches with every binding: enabled; a payload that is not AgentRunParams@1, or
      // whose run is not the instance id, is refused before any step.
      const enabled = new module.AgentRunWorkflow({}, { ...full, ...loop, BROKER: agentBroker });
      for (const [payload, instanceId] of [
        [{}, params.runId],
        [{ ...params, extra: 1 }, params.runId],
        [params, "00000000-0000-4000-8000-0000000000bb"],
      ])
        await assert.rejects(
          enabled.run({ payload, timestamp: new Date(), instanceId }, step),
          (error) =>
            error.constructor.name === "NonRetryableError" && error.message === "payload_invalid",
        );
      assert.equal(steps, 0);
    } finally {
      process.env = saved;
    }
  }
  // Every binding with the switch on: dispatch is enabled (the switch is the only gate), and
  // a payload that is not a lease reference is refused before any step. workerd never
  // populates process.env (nodejs_compat_do_not_populate_process_env); Node does.
  const saved = process.env;
  process.env = {};
  t.after(() => (process.env = saved));
  const enabled = new module.ListingsRunWorkflow({}, { ...full });
  await assert.rejects(
    enabled.run({ payload: {}, timestamp: new Date(), instanceId: "i" }, step),
    (error) =>
      error.constructor.name === "NonRetryableError" && error.message === "payload_invalid",
  );
  assert.equal(steps, 0);
});

test("AC21: the cron starts nothing while dispatch is disabled", async (t) => {
  const module = await load(t, "apps/workers/src/orchestrator.ts");
  let created = 0;
  let leased = 0;
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await module.default.scheduled(
      {},
      {
        MORROW_ENVIRONMENT: "staging",
        MORROW_MODEL_PROVIDER: "anthropic",
        BROKER: {
          fetch() {},
          neonLease: () => (leased++, Promise.reject(Error("x"))),
          modelRespond() {},
          shopifyRead() {},
        },
        LISTINGS_RUN: { create: () => (created++, Promise.resolve()) },
      },
      {},
    );
  } finally {
    console.log = original;
  }
  assert.equal(created, 0);
  assert.equal(leased, 0);
  assert.ok(lines.includes('{"event":"morrow_orchestrator_dispatch_disabled"}'));
});

test("the orchestrator's environment is deny-all: no credential, no production, the switch's exact value", async (t) => {
  const { mapOrchestratorEnvironment } = await import("../apps/workers/src/environment.ts");
  // workerd never populates process.env (nodejs_compat_do_not_populate_process_env); Node does.
  const saved = process.env;
  process.env = {};
  t.after(() => (process.env = saved));
  const binding = JSON.stringify({
    schemaVersion: 1,
    environment: "staging",
    projectId: "lab-project",
    branchId: "br-lab-branch",
    hostname: "ep-lab-endpoint.c-1.us-east-1.aws.neon.tech",
    database: "morrow",
  });
  const full = {
    MORROW_ENVIRONMENT: "staging",
    MORROW_MODEL_PROVIDER: "anthropic",
    MORROW_DATABASE_BINDING_JSON: binding,
    BROKER: { fetch() {}, neonLease() {}, modelRespond() {}, shopifyRead() {} },
    LISTINGS_RUN: { create() {} },
  };
  assert.equal(mapOrchestratorEnvironment(full).ok, true);
  process.env = { PATH: "x" };
  assert.equal(mapOrchestratorEnvironment(full).code, "ORCHESTRATOR_ENV_PROCESS_ENV_POPULATED");
  process.env = {};
  for (const [patch, code] of [
    [{ MORROW_MODEL_PROVIDER: undefined }, "ORCHESTRATOR_ENV_DISPATCH_DISABLED"],
    [{ MORROW_MODEL_PROVIDER: "on" }, "ORCHESTRATOR_ENV_DISPATCH_DISABLED"],
    [{ MORROW_ENVIRONMENT: "production" }, "ORCHESTRATOR_ENV_DISPATCH_DISABLED"],
    [{ ANTHROPIC_API_KEY: "sk-ant" }, "ORCHESTRATOR_ENV_FORBIDDEN_CREDENTIAL_BINDING"],
    [
      { MORROW_DB_PASSWORD_MORROW_RUNTIME_EXECUTOR: "x" },
      "ORCHESTRATOR_ENV_FORBIDDEN_CREDENTIAL_BINDING",
    ],
    [{ MORROW_DATABASE_BINDING_JSON: "{}" }, "ORCHESTRATOR_ENV_VALUE_INVALID"],
    [
      { MORROW_DATABASE_BINDING_JSON: binding.replace("staging", "development") },
      "ORCHESTRATOR_ENV_CROSS_BINDING_MISMATCH",
    ],
    [{ BROKER: {} }, "ORCHESTRATOR_ENV_BROKER_BINDING_INVALID"],
    // M2 PR-3's product read is part of the RuntimeBroker binding's reviewed shape.
    [
      { BROKER: { fetch() {}, neonLease() {}, modelRespond() {} } },
      "ORCHESTRATOR_ENV_BROKER_BINDING_INVALID",
    ],
    [{ LISTINGS_RUN: {} }, "ORCHESTRATOR_ENV_WORKFLOW_BINDING_INVALID"],
    // Build order PR 11: the agent-loop switch on needs modelTurn and the AGENT_RUN binding.
    [
      { MORROW_AGENT_LOOP: "on", AGENT_RUN: { create() {}, get() {} } },
      "ORCHESTRATOR_ENV_BROKER_BINDING_INVALID",
    ],
    [
      {
        MORROW_AGENT_LOOP: "on",
        BROKER: { ...full.BROKER, modelTurn() {} },
        AGENT_RUN: { create() {} },
      },
      "ORCHESTRATOR_ENV_WORKFLOW_BINDING_INVALID",
    ],
    [
      { MORROW_AGENT_LOOP: "on", BROKER: { ...full.BROKER, modelTurn() {} } },
      "ORCHESTRATOR_ENV_WORKFLOW_BINDING_INVALID",
    ],
  ]) {
    const env = { ...full, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete env[key];
    const mapped = mapOrchestratorEnvironment(env);
    assert.equal(mapped.ok, false, code);
    assert.equal(mapped.code, code);
  }
  // The agent loop's dispatch: null unless MORROW_AGENT_LOOP is exactly "on" (the committed
  // state has no var), a binding then.
  assert.equal(mapOrchestratorEnvironment(full).agentRuns, null);
  for (const value of ["yes", "ON", "true", 1])
    assert.equal(
      mapOrchestratorEnvironment({
        ...full,
        MORROW_AGENT_LOOP: value,
        AGENT_RUN: { create() {}, get() {} },
      }).agentRuns,
      null,
    );
  const agentRun = { create() {}, get() {} };
  const on = mapOrchestratorEnvironment({
    ...full,
    MORROW_AGENT_LOOP: "on",
    BROKER: { ...full.BROKER, modelTurn() {} },
    AGENT_RUN: agentRun,
  });
  assert.equal(on.ok, true);
  assert.equal(on.agentRuns, agentRun);
});

// Build order PR 11: AgentRunWorkflow's body (apps/workers/src/agent-run.ts) checks the
// payload, gives every step the reviewed options, retries only a lease transaction failure,
// and waits for the answer event by its type.
test("the agent Workflow's body: ids-only payload, the reviewed step options and the answer event", async (t) => {
  const module = await load(t, "apps/workers/src/agent-run.ts");
  const runId = "00000000-0000-4000-8000-0000000000aa";
  const params = {
    schemaVersion: 1,
    workflow: "agent-run@1",
    organizationId: "org_o",
    workspaceId: "ws_w",
    runId,
  };
  const configs = [];
  const step = {
    async do(name, config, body) {
      configs.push([name, config]);
      return body();
    },
  };
  const event = (p = params, instanceId = runId) => ({
    payload: p,
    instanceId,
    timestamp: new Date(),
  });
  // The run's lease is gone (resolveLease finds none): interrupted at the start step.
  const ports = (resolveLease) => ({
    lease: async () => {
      throw Error("not expected");
    },
    resolveLease,
    modelTurn: async () => {
      throw Error("not expected");
    },
    tools: { available: () => [], get: () => null },
    authority: { decide: async () => "authority_denied" },
    now: () => Date.now(),
    sleep: async () => {},
  });
  assert.equal(
    await module.runAgentWorkflow(
      ports(async () => null),
      event(),
      step,
    ),
    "interrupted",
  );
  assert.deepEqual(configs, [
    [
      "start",
      { retries: { limit: 4, delay: "15 seconds", backoff: "exponential" }, timeout: "30 minutes" },
    ],
  ]);
  assert.equal(module.agentAnswerEvent, "agent-run-answer");
  // A failed lookup transaction is AgentRunRetry (the Workflow retries the step); any other
  // fault is NonRetryableError(step_fault).
  await assert.rejects(
    module.runAgentWorkflow(
      ports(async () => "failed"),
      event(),
      step,
    ),
    (error) => error.name === "AgentRunRetry" && error.code === "resolve",
  );
  await assert.rejects(
    module.runAgentWorkflow(
      ports(async () => {
        throw Error("RUNTIME_SQL_UNAVAILABLE");
      }),
      event(),
      step,
    ),
    (error) => error.constructor.name === "NonRetryableError" && error.message === "step_fault",
  );
  // No ports, a payload that is not AgentRunParams@1, or another instance id: refused before
  // any step.
  const before = configs.length;
  await assert.rejects(
    module.runAgentWorkflow(null, event(), step),
    (error) => error.message === "dispatch_disabled",
  );
  for (const [p, id] of [
    [{}, runId],
    [{ ...params, workflow: "listings-run@1" }, runId],
    [params, "00000000-0000-4000-8000-0000000000bb"],
  ])
    await assert.rejects(
      module.runAgentWorkflow(
        ports(async () => null),
        event(p, id),
        step,
      ),
      (error) => error.message === "payload_invalid",
    );
  assert.equal(configs.length, before);
});

// M2 PR-2 replaced the placeholder with worker/index.ts. Its committed configuration (only
// MORROW_ENVIRONMENT and the broker binding) is still deny-all: 503 except GET /healthz,
// which reports not ready (tests/connector-worker.test.mjs covers the configured worker).
test("the unconfigured connector returns 503 except GET /healthz, which is not ready", async (t) => {
  const module = await load(t, "apps/shopify-connector/worker/index.ts");
  const env = { MORROW_ENVIRONMENT: "development" };
  const health = await module.default.fetch(new Request("https://connector.test/healthz"), env);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), '{"schemaVersion":1,"service":"connector","ready":false}');
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/auth/callback"],
    ["POST", "/webhooks"],
    ["GET", "/shopify/a/lab-app/launch?shop=a.myshopify.com"],
    ["POST", "/shopify/a/lab-app/webhooks"],
  ]) {
    const response = await module.default.fetch(
      new Request("https://connector.test" + path, { method }),
      env,
    );
    assert.equal(response.status, 503);
    assert.equal(await response.text(), '{"code":"connector_unavailable"}');
  }
  const post = await module.default.fetch(
    new Request("https://connector.test/healthz", { method: "POST" }),
    env,
  );
  assert.equal(post.status, 405);
});

// Review (AI review, separate context, same model family): ListingsRunWorkflow.run's body
// (listings-run.ts) on fake ports and a fake step: the run id it hands listingsRun is the
// Workflow's instance id (a run lease naming another subject interrupts at the start step),
// every step carries the reviewed options, a RunStepRetry stays retryable and any other
// error is a NonRetryableError(step_fault).
test("the Workflow's body passes its instance id as the run id, with the reviewed step options", async (t) => {
  const module = await load(t, "apps/workers/src/listings-run.ts");
  const runId = "00000000-0000-4000-8000-0000000000aa";
  const payload = { leaseId: "00000000-0000-4000-8000-000000000001", generation: 1 };
  const lease = { kind: "run", subjectId: runId };
  const started = [];
  const fakePorts = (leaseResult) => ({
    lease:
      leaseResult ??
      (async (_ref, body) => ({
        entered: true,
        lease,
        value: await body({
          lease,
          run: {
            start: async () => (
              started.push(1),
              {
                outcome: "ended",
                status: "succeeded",
              }
            ),
          },
        }),
      })),
    modelRespond: async () => {
      throw Error("not expected");
    },
    readProduct: async () => {
      throw Error("not expected");
    },
    environment: "staging",
    now: () => Date.now(),
    sleep: async () => {},
    ids: () => "id",
  });
  const configs = [];
  const step = {
    async do(name, config, body) {
      configs.push([name, config]);
      return body();
    },
  };
  const event = (instanceId, p = payload) => ({ payload: p, instanceId, timestamp: new Date() });
  assert.equal(await module.runListingsWorkflow(fakePorts(), event(runId), step), "ended");
  assert.equal(started.length, 1);
  assert.deepEqual(configs, [
    [
      "start",
      { retries: { limit: 4, delay: "15 seconds", backoff: "exponential" }, timeout: "30 minutes" },
    ],
  ]);
  // Another instance id than the lease's subject: interrupted before run_start.
  assert.equal(
    await module.runListingsWorkflow(
      fakePorts(),
      event("00000000-0000-4000-8000-0000000000bb"),
      step,
    ),
    "interrupted",
  );
  assert.equal(started.length, 1);
  // A failed lease transaction is a RunStepRetry, retried by the Workflow; any other error is
  // a fault that retrying would repeat.
  await assert.rejects(
    module.runListingsWorkflow(
      fakePorts(async () => "failed"),
      event(runId),
      step,
    ),
    (error) => error.name === "RunStepRetry" && error.code === "transaction",
  );
  await assert.rejects(
    module.runListingsWorkflow(
      fakePorts(async () => {
        throw Error("RUNTIME_SQL_UNAVAILABLE");
      }),
      event(runId),
      step,
    ),
    (error) => error.constructor.name === "NonRetryableError" && error.message === "step_fault",
  );
  // Without ports dispatch is disabled; a payload that is not a lease reference is refused,
  // each before any step.
  const before = configs.length;
  await assert.rejects(
    module.runListingsWorkflow(null, event(runId), step),
    (error) => error.message === "dispatch_disabled",
  );
  await assert.rejects(
    module.runListingsWorkflow(fakePorts(), event(runId, {}), step),
    (error) => error.message === "payload_invalid",
  );
  assert.equal(configs.length, before);
});
