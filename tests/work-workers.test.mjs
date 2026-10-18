// P06.T01a Worker-entry tests in Node: the AC21 guard matrix opens no SQL
// connection, and the unbound default artifact (AC23) answers every work route
// with 401 without network or database access while P05 routes are unchanged.
// lab:work-workers repeats both inside workerd.
import test from "node:test";
import assert from "node:assert/strict";
import defaultWorker, { createWorkspaceApiWorker } from "../apps/api/src/worker.ts";
import { createWorkApiHandler } from "../packages/work/src/http.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { workGuardCases, workGuardOrigin, workGuardRequest } from "./fixtures/work-guard-cases.mjs";

const ctx = { waitUntil() {} };
function countingConnector() {
  const counter = { opens: 0 };
  return {
    counter,
    connector: {
      async open() {
        counter.opens++;
        throw Error("NO_DATABASE_IN_THIS_TEST");
      },
    },
  };
}
const quiet = async (t, body) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const result = await body();
  return { result, lines };
};

test("AC21: every guard case is decided before any SQL connection opens", async (t) => {
  const { counter, connector } = countingConnector();
  const handler = createWorkApiHandler({ origin: workGuardOrigin, connector, now: Date.now });
  const { lines } = await quiet(t, async () => {
    for (const [name, c] of workGuardCases) {
      let request;
      try {
        request = workGuardRequest(c);
      } catch {
        // A runtime that cannot even construct the request (e.g. a forbidden
        // header) rejects it before the Worker; only optional cases may do this.
        assert.ok(c.optional, name);
        continue;
      }
      const response = await handler.fetch(request, undefined, ctx);
      assert.equal(response.status, c.status, name);
      const body = await response.json();
      assert.ok(validateDefinition("core", "ErrorEnvelope", body), name);
      if (c.allow) assert.equal(response.headers.get("allow"), c.allow, name);
      assert.equal(response.headers.has("set-cookie"), false, name);
      assert.equal(response.headers.has("access-control-allow-origin"), false, name);
    }
  });
  assert.equal(counter.opens, 0);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record), ["event", "route", "outcome", "correlationId"]);
  }
});

test("AC21: a request that passes the guard reaches the connector exactly once", async (t) => {
  const { counter, connector } = countingConnector();
  const handler = createWorkApiHandler({ origin: workGuardOrigin, connector, now: Date.now });
  const [, valid] = workGuardCases[0];
  const ok = { ...valid, headers: { ...valid.headers, Origin: workGuardOrigin } };
  const { result } = await quiet(t, () => handler.fetch(workGuardRequest(ok), undefined, ctx));
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, "unavailable");
  assert.equal(counter.opens, 1);
});

test("AC23: the unbound default artifact answers every work route with 401 and no I/O", async (t) => {
  const fetches = t.mock.method(globalThis, "fetch", () => {
    throw Error("NO_NETWORK");
  });
  const { lines } = await quiet(t, async () => {
    for (const [method, path] of [
      ["GET", "/workspace/ws_w/work/goals"],
      ["POST", "/workspace/ws_w/work/goals"],
      ["GET", "/workspace/ws_w/work/tasks/t1"],
      ["POST", "/workspace/ws_w/work/questions/q1/answer"],
      ["DELETE", "/workspace/ws_w/work"],
      ["GET", "/workspace/ws_w/work/anything/at/all"],
    ]) {
      const response = await defaultWorker.fetch(
        new Request(workGuardOrigin + path, { method }),
        undefined,
        ctx,
      );
      assert.equal(response.status, 401, method + " " + path);
      const body = await response.json();
      assert.ok(validateDefinition("core", "ErrorEnvelope", body));
      assert.equal(response.headers.has("set-cookie"), false);
    }
  });
  assert.equal(fetches.mock.callCount(), 0);
  assert.ok(lines.every((l) => JSON.parse(l).outcome === "unbound"));
  // P05 routes keep their unchanged unbound answers.
  const bootstrap = await defaultWorker.fetch(
    new Request(workGuardOrigin + "/workspace/ws_w/bootstrap"),
    undefined,
    ctx,
  );
  assert.equal(bootstrap.status, 401);
  assert.deepEqual(await bootstrap.json(), { code: "authentication_required" });
  const worker = createWorkspaceApiWorker();
  assert.ok(Object.isFrozen(worker));
  assert.deepEqual(Object.keys(worker), ["fetch"]);
});

test("routing: only /workspace/<Id>/work(/|$) reaches the work handler", async (t) => {
  const { result } = await quiet(t, async () => {
    const statuses = {};
    for (const path of [
      "/workspace/ws_w/work",
      "/workspace/ws_w/workers",
      "/workspace/ws_w/bootstrap/work",
      "/workspace/bad%20id/work/goals",
    ])
      statuses[path] = await (
        await defaultWorker.fetch(new Request(workGuardOrigin + path), undefined, ctx)
      ).json();
    return statuses;
  });
  assert.equal(result["/workspace/ws_w/work"].schemaVersion, 1);
  assert.deepEqual(result["/workspace/ws_w/workers"], { code: "authentication_required" });
  assert.deepEqual(result["/workspace/ws_w/bootstrap/work"], { code: "authentication_required" });
  assert.deepEqual(result["/workspace/bad%20id/work/goals"], { code: "authentication_required" });
});

test("configuration: the handler accepts only an exact HTTPS origin and a connector", () => {
  const { connector } = countingConnector();
  for (const origin of [
    "http://work.morrow.test",
    "https://work.morrow.test/",
    "https://u:p@work.morrow.test",
    "",
  ])
    assert.throws(
      () => createWorkApiHandler({ origin, connector, now: Date.now }),
      /WORK_ORIGIN_INVALID/,
    );
  assert.throws(
    () => createWorkApiHandler({ origin: workGuardOrigin, connector: {}, now: Date.now }),
    /CONFIGURATION_INVALID/,
  );
});
