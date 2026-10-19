import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Exercise the lab's actual check, start, finish and callback-delivery functions without
// importing the top-level Docker/Miniflare command. The dispatch, cookie jar and provider
// oracle are stand-ins; this proves the lab's own bookkeeping, never login behaviour.
const source = readFileSync(
  new URL("../scripts/controlled-neon-postgresql-lab.mjs", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile("lab.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functionText(name) {
  const found = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(found.length, 1, name);
  return found[0].getText(ast);
}
const origin = "https://127.0.0.1";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function jar(n) {
  const secret = ("s" + n).padEnd(42, "x") + "A";
  return {
    secret,
    ingest: () => ({ accepted: 1, rejected: 0 }),
    header: (url) =>
      url === origin + "/" ? "__Host-morrow_session=" + secret : "__Host-morrow_login=flow" + n,
  };
}
const beginResponse = (json) => ({
  status: 200,
  headers: new Headers([["set-cookie", "__Host-morrow_login=v; Path=/; Secure; HttpOnly"]]),
  json,
  text: async () => "",
});
const callbackResponse = ({ location = "/", cookies = 1, body = "" } = {}) => {
  const headers = new Headers({ location });
  for (let i = 0; i < cookies; i++)
    headers.append("set-cookie", "__Host-morrow_session=v" + i + "; Path=/; Secure; HttpOnly");
  return { status: 303, headers, text: async () => body };
};
// The earlier full chain in the lab has already used flow serial 1.
function harness(dispatch) {
  let jars = 0,
    arms = 0;
  const context = vm.createContext({
    URL,
    checks: [],
    stage: "concurrent_independent_callbacks",
    checkNameHeld: null,
    callbackDeliveryHolds: [],
    dispatchFailures: [],
    privateMarkers: [],
    flowSerial: 1,
    firstBeginDiagnostic: null,
    origin,
    dispatch,
    recordDispatchFailure(label, status) {
      context.dispatchFailures.push({ label, status });
    },
    inFlow: (error) => error,
    createBoundedLoginCookieJar: () => jar(++jars),
    activeOracle: {
      arm() {
        const n = ++arms;
        return {
          callbackUrl: origin + "/auth/workos/callback?code=code" + n + "&state=state" + n,
          code: "code" + n,
          token: "token" + n,
        };
      },
    },
  });
  for (const name of ["redacted", "check", "callbackDelivery", "start", "finish"])
    context[name] = vm.runInContext("(" + functionText(name) + ")", context);
  return context;
}

test("concurrent starts keep distinct flow serials when the first begin body resolves last", async () => {
  const gates = [deferred(), deferred()];
  let begins = 0;
  const lab = harness(async (path) => {
    if (path === "/auth/login") {
      const i = begins++;
      return beginResponse(async () => {
        await gates[i].promise;
        return { authorizationUrl: "https://api.workos.com/authorize?flow=" + i };
      });
    }
    return callbackResponse();
  });
  const starting = Promise.all([lab.start(0), lab.start(0)]);
  // Both begins are past their dispatch and waiting on the body: the hosted interleaving.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lab.flowSerial, 3);
  gates[1].resolve();
  gates[0].resolve();
  const [left, right] = await starting;
  assert.deepEqual([left.serial, right.serial], [2, 3]);
  const results = await Promise.all([lab.finish(left), lab.finish(right)]);
  assert.notEqual(results[0].secret, results[1].secret);
  assert.equal(lab.checkNameHeld, null);
  assert.deepEqual(lab.checks.map((c) => c.name).sort(), [
    "actual_84_begin_cookie_2",
    "actual_84_begin_cookie_3",
    "actual_84_callback_delivery_2",
    "actual_84_callback_delivery_3",
    "actual_m_initial_session_cookie_2",
    "actual_m_initial_session_cookie_3",
    "canonical_fresh_cookie_2",
    "canonical_fresh_cookie_3",
  ]);
  assert.ok(lab.checks.every((c) => c.passed));
  assert.equal(lab.callbackDeliveryHolds.length, 0);
});

test("a callback that answers 303 differently records its location, Set-Cookie count and body length", async () => {
  for (const [answer, expected] of [
    [
      { location: "/auth/result", cookies: 0 },
      { location: "/auth/result", setCookieCount: 0, bodyLength: 0 },
    ],
    [
      { location: "/", cookies: 2 },
      { location: "/", setCookieCount: 2, bodyLength: 0 },
    ],
    [
      { location: "/", cookies: 1, body: "held" },
      { location: "/", setCookieCount: 1, bodyLength: 4 },
    ],
  ]) {
    const lab = harness(async (path) =>
      path === "/auth/login"
        ? beginResponse(async () => ({ authorizationUrl: "https://api.workos.com/authorize" }))
        : callbackResponse(answer),
    );
    const prepared = await lab.start(0);
    await assert.rejects(lab.finish(prepared), /CONTROLLED_PG_CHECK_HELD/);
    assert.deepEqual(JSON.parse(JSON.stringify(lab.checks.at(-1))), {
      name: "actual_84_callback_delivery_2",
      passed: false,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(lab.callbackDeliveryHolds)), [
      {
        stage: "concurrent_independent_callbacks",
        serial: 2,
        status: 303,
        expectedLocation: "/",
        expectedSetCookieCount: 1,
        ...expected,
      },
    ]);
    // A 303 is not a dispatch failure; only the delivery record describes it.
    assert.equal(lab.dispatchFailures.length, 0);
  }
});

test("a recorded callback location is redacted of private markers", () => {
  const lab = harness(async () => callbackResponse());
  lab.privateMarkers.push("private-provider-code-0001");
  const response = callbackResponse({ location: "/auth/result?code=private-provider-code-0001" });
  assert.equal(lab.callbackDelivery(4, response, "", true), false);
  assert.equal(lab.callbackDeliveryHolds[0].location, "/auth/result?code=[private]");
});

test("a reused or malformed check name is refused and named, never recorded as a check", () => {
  const lab = harness(async () => callbackResponse());
  lab.check("actual_84_callback_delivery_3", true);
  assert.throws(() => lab.check("actual_84_callback_delivery_3", true), /CONTROLLED_PG_CHECK_NAME/);
  assert.deepEqual(JSON.parse(JSON.stringify(lab.checkNameHeld)), {
    stage: "concurrent_independent_callbacks",
    reason: "duplicate",
    name: "actual_84_callback_delivery_3",
  });
  assert.equal(lab.checks.length, 1);
  const fresh = harness(async () => callbackResponse());
  assert.throws(() => fresh.check("Bad Name", true), /CONTROLLED_PG_CHECK_NAME/);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.checkNameHeld)), {
    stage: "concurrent_independent_callbacks",
    reason: "malformed",
    name: null,
  });
  // Only the first refusal is kept.
  assert.throws(() => fresh.check("also bad", true), /CONTROLLED_PG_CHECK_NAME/);
  assert.equal(fresh.checkNameHeld.name, null);
  assert.equal(fresh.checkNameHeld.reason, "malformed");
});
