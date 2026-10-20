import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// P04.T02a AC21: dispatch is hard-disabled in the orchestrator Worker, and the connector
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
  const workflow = new module.MorrowWorkWorkflow({}, {});
  await assert.rejects(
    workflow.run({ payload: {}, timestamp: new Date(), instanceId: "i" }, step),
    (error) =>
      error.constructor.name === "NonRetryableError" && error.message === "dispatch_disabled",
  );
  assert.equal(steps, 0);
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
