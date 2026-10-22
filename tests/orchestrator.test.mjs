import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// P04.T02a AC21 (its meaning revised by M3 PR-2, the ID kept): dispatch stays disabled in the
// orchestrator Worker until the reviewed model-provider switch is on with every binding and
// M2 PR-3's product read exists; ListingsRunWorkflow then replaces MorrowWorkWorkflow. The
// connector
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

test("AC21: run() throws NonRetryableError(dispatch_disabled) before any step", async (t) => {
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
  assert.equal(module.productReadAvailable, false);
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
  // The committed environment (MORROW_ENVIRONMENT only), the switch on without its other
  // bindings, and every binding present: M2 PR-3's product read is still missing, so each
  // is disabled before any step, with a payload or without one.
  for (const env of [
    { MORROW_ENVIRONMENT: "staging" },
    { MORROW_ENVIRONMENT: "staging", MORROW_MODEL_PROVIDER: "anthropic" },
    {
      MORROW_ENVIRONMENT: "staging",
      MORROW_MODEL_PROVIDER: "anthropic",
      MORROW_DATABASE_BINDING_JSON: binding,
      BROKER: broker,
      LISTINGS_RUN: workflowBinding,
    },
    { MORROW_ENVIRONMENT: "production", MORROW_MODEL_PROVIDER: "anthropic" },
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
  ]) {
    const env = { ...full, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete env[key];
    const mapped = mapOrchestratorEnvironment(env);
    assert.equal(mapped.ok, false, code);
    assert.equal(mapped.code, code);
  }
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
