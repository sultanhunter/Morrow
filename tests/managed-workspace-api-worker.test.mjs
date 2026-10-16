import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const workerText = readFileSync("scripts/fixtures/managed-workspace-api-worker.ts", "utf8");
const runnerText = readFileSync("scripts/managed-workspace-api-workers-lab.mjs", "utf8");
const oldRunner = readFileSync("scripts/managed-login-lifetime-workers-lab.mjs", "utf8");
const source = ts.createSourceFile(
  "fixture.ts",
  workerText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const all = [];
const visit = (node) => {
  all.push(node);
  ts.forEachChild(node, visit);
};
visit(source);
const print = (node) => ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, source);
const literal = (start, end, text = runnerText) => {
  const a = text.indexOf(start),
    b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return text.slice(a, b);
};

test("new native runner preserves the four entire genuine generic controls", () => {
  const start = "for (const control of [",
    end = "const managedCases = [];";
  assert.equal(literal(start, end), literal(start, end, oldRunner));
  assert.equal(
    readFileSync("scripts/fixtures/managed-login-lifetime-worker.ts", "utf8").includes(
      "ctx.waitUntil(completion)",
    ),
    true,
  );
});

test("configured fixture imports exact application factory and delegates real request/env/context without a route copy", () => {
  const imports = all.filter(ts.isImportDeclaration).map((n) => n.moduleSpecifier.text);
  assert.ok(imports.includes("../../apps/api/src/worker.js"));
  assert.equal(
    imports.some((n) => /standalone-(store|workspace)|controlled-neon-login-pool/.test(n)),
    false,
  );
  const call = all
    .filter(ts.isCallExpression)
    .find((n) => n.expression.getText(source) === "handler.fetch");
  assert.deepEqual(
    call.arguments.map((n) => n.getText(source)),
    ["request", "env", "ctx"],
  );
  const handlers = all
    .filter(ts.isPropertyAssignment)
    .filter((n) => n.name.getText(source) === "fetch");
  assert.equal(handlers.length, 0); // Only the module method, never a replacement ctx/handler registry.
  assert.equal(workerText.includes("waitUntil("), true); // Type declaration only.
  assert.equal(
    all.filter(ts.isCallExpression).some((n) => /waitUntil$/.test(n.expression.getText(source))),
    false,
  );
});

test("closed native matrix covers each fixed role and independent lifetime/failure boundary", () => {
  const block = literal("const routes = {", "const cookieSecret = ");
  const actual = vm.runInNewContext(block + ";({routes,nativeDefinitions});");
  assert.equal(actual.nativeDefinitions.length, 37);
  assert.equal(new Set(actual.nativeDefinitions.map((n) => n.name)).size, 37);
  for (const [poolName, path] of Object.entries({
    identityPool: "/workspace/workspace_a/bootstrap",
    linkingPool: "/workspace/workspace_a/store-links/preview",
    logoutPool: "/auth/logout",
  })) {
    assert.equal(actual.routes[poolName].path, path);
    const cases = actual.nativeDefinitions.filter((n) => n.poolName === poolName && !n.unbound);
    assert.equal(cases.length, 12);
    assert.equal(cases.filter((n) => n.kind === "pending").length, 5);
    assert.ok(cases.some((n) => n.concurrent === 2));
    assert.ok(cases.some((n) => n.kind === "non101" && n.releaseMode === "reject"));
    assert.ok(cases.some((n) => n.kind === "wrong_password"));
    assert.ok(cases.some((n) => n.kind === "late101"));
  }
});

test("concurrent source settlement wait does not resolve at the first of two events", () => {
  const signal = literal("  const signalSettlement = () => {", "  const settled = () =>");
  const context = vm.createContext({ expected: 2, settlement: [], settleWaiters: [], resolved: 0 });
  vm.runInContext(
    signal + ";globalThis.signal=signalSettlement;settleWaiters.push(()=>resolved++);",
    context,
  );
  context.settlement.push({});
  context.signal();
  assert.equal(context.resolved, 0);
  context.settlement.push({});
  context.signal();
  assert.equal(context.resolved, 1);
  context.signal();
  assert.equal(context.resolved, 1);
});

test("actual broker source rejects role, purpose and namespace confusion before acquiring a lease", async () => {
  const login = all.find(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === "loginDependencies",
  );
  const broker = login.initializer.properties.find(
    (n) => n.name.getText(source) === "credentialBroker",
  ).initializer;
  const context = vm.createContext({
    setup: {
      wrongPassword: false,
      passwordByRole: { morrow_api: "synthetic-only", morrow_identity_login: "synthetic-login" },
    },
    roles: ["morrow_api", "morrow_identity_login"],
    workspaceRoles: ["morrow_api"],
    binding: {
      environment: "staging",
      projectId: "project",
      branchId: "branch",
      hostname: "fixed.neon.tech",
      database: "morrow",
    },
    leases: { borrows: 0, activeLeases: 0, releaseAttempts: 0, releaseAcknowledgements: 0 },
    now: () => 100,
    expect(value) {
      assert.ok(value);
    },
    AbortController,
  });
  vm.runInContext(
    ts.transpileModule("globalThis.broker=" + print(broker), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context,
  );
  const n = {
    schemaVersion: 1,
    providerId: "neon",
    environment: "staging",
    projectId: "project",
    branchId: "branch",
    hostname: "fixed.neon.tech",
    database: "morrow",
    role: "morrow_api",
    purpose: "workspace_primary_and_one_same_role_observer",
  };
  const control = { deadlineMs: 200, signal: new AbortController().signal };
  for (const changed of [
    { role: "postgres" },
    { purpose: "primary_and_one_same_role_observer" },
    { hostname: "foreign.neon.tech" },
    { providerId: "workos" },
  ])
    await assert.rejects(context.broker.borrow(JSON.stringify({ ...n, ...changed }), control));
  assert.equal(context.leases.borrows, 0);
  const lease = await context.broker.borrow(JSON.stringify(n), control);
  assert.equal(lease.password, "synthetic-only");
  assert.equal(context.leases.borrows, 1);
  await lease.release(control);
  await assert.rejects(lease.release(control));
  assert.equal(context.leases.releaseAcknowledgements, 1);
});

test("withheld first logout BEGIN precedes the effect latch and expects unavailable, not an invented effect", () => {
  const service = readFileSync("packages/identity/src/self-logout-control.ts", "utf8");
  const begin = service.indexOf("await query(selfLogoutSql.begin)"),
    latch = service.indexOf("invoked = true;", begin),
    effect = service.indexOf("query(selfLogoutSql.end, values)", latch);
  assert.ok(begin >= 0 && latch > begin && effect > latch);
  assert.ok(service.includes('result(invoked ? "unknown" : "unavailable")'));
  assert.ok(runnerText.includes('? { schemaVersion: 1, outcome: "logout_unavailable" }'));
  assert.equal(
    runnerText.includes('? { schemaVersion: 1, outcome: "logout_outcome_unknown" }'),
    false,
  );
});

test("denial rows bind exact inherited status for each role and source boundary", () => {
  const block = literal("function deniedStatus(definition)", "const cookieSecret = ");
  const select = vm.runInNewContext(block + ";deniedStatus;");
  assert.equal(select({ unbound: true, poolName: "identityPool" }), 401);
  for (const poolName of ["identityPool", "linkingPool", "logoutPool"]) {
    assert.equal(select({ poolName, invalidCookie: true }), poolName === "logoutPool" ? 403 : 401);
    assert.equal(select({ poolName, clockExpiry: "after_entry" }), 503);
    assert.equal(select({ poolName, clockExpiry: "during_setup" }), 503);
  }
  assert.ok(runnerText.includes("r.status === deniedStatus(definition)"));
  assert.equal(runnerText.includes("[400, 401, 503].includes(r.status)"), false);
});

test("held settlement verdict refuses fulfilled, missing, duplicated or unsettled source observations", () => {
  const block = literal(
    "function heldSourceSettlements(rows, expected)",
    "function aggregateAcknowledgementOrder(",
  );
  const validate = vm.runInNewContext(block + ";heldSourceSettlements;");
  const row = {
    outcome: "rejected",
    publicationAttempts: 1,
    publicationAccepted: 1,
    publicationFailures: 0,
    publishedPending: 0,
    publishedSettled: 1,
    ownerMismatches: 0,
    namespaceMismatches: 0,
  };
  assert.equal(validate([row], 1), true);
  for (const change of [
    { outcome: "fulfilled" },
    { publishedPending: 1 },
    { publishedSettled: 0 },
    { publicationAccepted: 2 },
    { namespaceMismatches: 1 },
  ])
    assert.equal(validate([{ ...row, ...change }], 1), false);
  assert.equal(validate([], 1), false);
  assert.equal(validate([row, row], 1), false);
});
test("aggregate ACK count order permits legal concurrent interleaving and rejects late, missing or nonfinite ACKs", () => {
  const block = literal(
    "function aggregateAcknowledgementOrder(",
    "function deniedStatus(definition)",
  );
  const validate = vm.runInNewContext(block + ";aggregateAcknowledgementOrder;");
  const rows = (values) => values.map((observedAt) => ({ observedAt }));
  assert.equal(validate(rows([2, 4]), rows([3, 5]), 2), true); // ACK1,P1,ACK2,P2.
  assert.equal(validate(rows([4, 2]), rows([5, 3]), 2), true); // Observation arrays need not be sorted.
  assert.equal(validate(rows([4, 6]), rows([3, 5]), 2), false);
  assert.equal(validate(rows([2]), rows([3, 5]), 2), false);
  assert.equal(validate(rows([2, Infinity]), rows([3, 5]), 2), false);
  assert.ok(
    runnerText.includes("aggregateAcknowledgementOrder(brokerEvents, settlement, expected)"),
  );
  assert.ok(
    runnerText.includes("brokerEvents.length === 0 && gate.snapshot().acknowledgements === 0"),
  );
});

test("a build completing after the case stopped cannot construct an unowned runtime", async () => {
  const region = literal(
    "        const managed = await build({",
    "        const route = routes[definition.poolName];",
  );
  const endBuild = region.indexOf("        assertRunning();");
  assert.ok(endBuild >= 0);
  const guardToConstructor = region
    .slice(endBuild, region.indexOf("new Miniflare({") + "new Miniflare({".length)
    .replace(/new Miniflare\(\{$/, "new Miniflare({});");
  let resolve,
    constructors = 0;
  const waiting = new Promise((r) => {
    resolve = r;
  });
  const context = vm.createContext({
    stopped: false,
    build: () => waiting,
    Miniflare: class {
      constructor() {
        constructors++;
      }
    },
    assertRunning() {
      if (context.stopped) throw Error("stopped");
    },
    check: () => {},
    definition: { name: "case" },
    stage: "bundle",
    mf: undefined,
  });
  // Execute the actual source guard/constructor prefix, after an independently gated fake build.
  const call = vm.runInContext(
    "(async()=>{const managed=await build();" + guardToConstructor + "})()",
    context,
  );
  context.stopped = true;
  resolve({ metafile: { inputs: {} } });
  await assert.rejects(call, /stopped/);
  assert.equal(constructors, 0);
  assert.ok(
    runnerText.includes(
      "if (!admitted || stopped) return new MiniflareResponse(null, { status: 503 })",
    ),
  );
  assert.ok(runnerText.includes("stopped = true;\n    natural = gate.snapshot()"));
});

test("native test transport sends the exact registered POST bytes with known UTF8 length and keeps GET bodyless", async () => {
  const routeBlock = literal("const routes = {", "const nativeDefinitions = [];");
  const routes = vm.runInNewContext(routeBlock + ";routes;");
  const start = runnerText.indexOf("        const route = routes[definition.poolName];"),
    end = runnerText.indexOf("        assertRunning();", start),
    actual = runnerText.slice(start, end);
  assert.ok(start >= 0 && end > start);
  for (const poolName of ["identityPool", "linkingPool", "logoutPool"]) {
    const sent = [];
    const context = vm.createContext({
      definition: { poolName },
      routes,
      expected: 2,
      Buffer,
      origin: "https://workspace.example.test",
      cookieSecret: "static_synthetic_only",
      handoffToken: "static_é_utf8_marker",
      commandId: "f5000000-0000-4000-8000-000000000001",
      responses: [],
      mf: {
        async dispatchFetch(url, input) {
          sent.push({ url, ...input });
          return {
            status: 503,
            async text() {
              return "finite";
            },
            headers: {
              getSetCookie() {
                return [];
              },
              get() {
                return "null";
              },
            },
          };
        },
      },
    });
    await vm.runInContext("(async()=>{" + actual + "})()", context);
    assert.equal(sent.length, 2);
    for (const row of sent) {
      assert.equal(Object.hasOwn(row.headers, "Transfer-Encoding"), false);
      if (poolName === "identityPool") {
        assert.equal(Object.hasOwn(row, "body"), false);
        assert.equal(Object.hasOwn(row.headers, "Content-Length"), false);
      } else {
        assert.equal(row.headers["Content-Length"], String(Buffer.byteLength(row.body, "utf8")));
        assert.deepEqual(
          JSON.parse(row.body),
          poolName === "logoutPool"
            ? { schemaVersion: 1 }
            : { handoffToken: "static_é_utf8_marker" },
        );
      }
    }
  }
});
