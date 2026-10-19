import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual new passive runner monitor without importing the
// top-level Docker/Miniflare command. This proves parser/resource properties,
// never SQL effects, native bytes, authority, credentials or lifetime.
const source = readFileSync(
  new URL("../scripts/managed-workspace-api-postgresql-lab.mjs", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile("lab.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const node = ast.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name.text === "observeWorkspaceBackendBytes",
);
assert.ok(node);
const observe = vm.runInNewContext("(" + node.getText(ast) + ")", {
  Buffer,
  Uint8Array,
  Math,
  require(value) {
    if (!value) throw Error("HELD");
  },
});
const state = () => ({ buffer: Buffer.alloc(0), remaining: 0 });
function frame(type, payload) {
  const output = Buffer.alloc(payload.length + 5);
  output.write(type);
  output.writeInt32BE(payload.length + 4, 1);
  payload.copy(output, 5);
  return output;
}
const auth = (code) => {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(code);
  return frame("R", payload);
};

test("actual passive monitor distinguishes offered SCRAM from completed authentication across fragmented frames", () => {
  const s = state(),
    o = {},
    bytes = Buffer.concat([auth(10), auth(0)]);
  for (let i = 0; i < bytes.length; i++)
    assert.equal(observe(bytes.subarray(i, i + 1), o, s, false), false);
  assert.equal(o.authenticationSasl, true);
  assert.equal(o.authenticationCompleted, true);
  assert.equal(s.buffer.length, 0);
  assert.equal(s.remaining, 0);
});
test("a PostgreSQL DataRow larger than256KiB streams across small chunks without becoming an instrumentation denial", () => {
  const s = state(),
    o = {},
    bytes = frame("D", Buffer.alloc(750000, 42));
  let peak = 0;
  for (let at = 0; at < bytes.length; at += 32768) {
    observe(bytes.subarray(at, at + 32768), o, s, false);
    peak = Math.max(peak, s.buffer.length);
  }
  assert.equal(o.maximumDataRowBytes, bytes.length);
  assert.equal(o.maximumServerChunkBytes, 32768);
  assert.equal(o.toWorkerObservedBytes, bytes.length);
  assert.equal(s.remaining, 0);
  assert.equal(peak, 0);
  assert.equal(o.authenticationCompleted, undefined);
});
test("otherwise oversized row observation reports actual bytes and remaining payload without fabricating complete delivery", () => {
  const s = state(),
    o = {},
    bytes = frame("D", Buffer.alloc(2000000));
  for (let at = 0; at < 1100000; at += 65536) observe(bytes.subarray(at, at + 65536), o, s, false);
  assert.ok(o.maximumDataRowBytes > 1048576);
  assert.ok(o.toWorkerObservedBytes > 1048576);
  assert.equal(o.largeFrameRemaining, bytes.length - o.toWorkerObservedBytes);
  assert.ok(s.remaining > 0);
  assert.equal(s.buffer.length, 0);
});
test("DataRow completion preserves the following authentication and exact committed-response fault", () => {
  const s = state(),
    o = { applySeen: true, lastStatement: "COMMIT" };
  const bytes = Buffer.concat([
    frame("D", Buffer.alloc(300000)),
    auth(0),
    frame("C", Buffer.from("COMMIT\0")),
  ]);
  let interrupted = false;
  for (let at = 0; at < bytes.length; at += 65536)
    interrupted ||= observe(bytes.subarray(at, at + 65536), o, s, true);
  assert.equal(interrupted, true);
  assert.equal(o.authenticationCompleted, true);
  assert.equal(o.committedResponseInterrupted, true);
});
test("read-only COMMIT and unapplied connection cannot activate the apply commit-response fault", () => {
  for (const o of [
    { applySeen: false, lastStatement: "COMMIT" },
    { applySeen: true, lastStatement: "ROLLBACK" },
  ]) {
    assert.equal(observe(frame("C", Buffer.from("COMMIT\0")), o, state(), true), false);
    assert.equal(o.committedResponseInterrupted, undefined);
  }
});
test("monitor rejects malformed lengths and oversized individual incoming messages", () => {
  const bytes = Buffer.from([82, 0, 0, 0, 3]);
  assert.throws(() => observe(bytes, {}, state(), false), /HELD/);
  assert.throws(() => observe(Buffer.alloc(262145), {}, state(), false), /HELD/);
});
test("closed fixture executor stays local Unix owner-only, without reopening sealed engine authority", () => {
  const engine = readFileSync(
    new URL("../scripts/fixtures/controlled-neon-postgresql.mjs", import.meta.url),
    "utf8",
  );
  assert.match(engine, /require\(phase === "setup"/);
  const executor = source.slice(
    source.indexOf("function fixtureSql("),
    source.indexOf("async function seedForCookie("),
  );
  assert.match(executor, /SET LOCAL ROLE morrow_identity_owner/);
  assert.match(executor, /"exec",\s*"--interactive",\s*engine\.id,\s*"psql"/);
  assert.equal(/"(?:-h|--host|--port)"|engine\.sql\(/.test(executor), false);
  assert.equal(/(?:CREATE|ALTER|DROP|GRANT|REVOKE)\s/.test(executor), false);
  assert.match(source, /secondaryLinks\[0\]\.link/);
  assert.match(source, /secondaryLinks\[1\]\.link/);
});

test("actual authority fixture grant IDs stay globally disjoint for compact and oversized1000 and1001", () => {
  const node = ast.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name.text === "workspaceAuthorityGrantId",
  );
  const id = vm.runInNewContext("(" + node.getText(ast) + ")", {
    Number,
    require(value) {
      if (!value) throw Error("HELD");
    },
  });
  const ids = [];
  for (const [count, oversized] of [
    [1000, false],
    [1001, false],
    [1000, true],
  ])
    for (let i = 1; i < count; i++) ids.push(id(count, oversized, i));
  assert.equal(new Set(ids).size, 2998);
  assert.ok(ids.every((v) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)));
  assert.throws(() => id(1000, true, 1000), /HELD/);
  assert.throws(() => id(1002, false, 1), /HELD/);
});

test("fixed known-string POST dispatch binds exact UTF8 length without altering incoming application policy", () => {
  const node = ast.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name.text === "workspaceFixtureRequestOptions",
  );
  const options = vm.runInNewContext("(" + node.getText(ast) + ")", {
    Headers,
    Buffer,
    require(value) {
      if (!value) throw Error("HELD");
    },
  });
  const headers = { Origin: "https://workspace.example.test" },
    body = JSON.stringify({ value: "hello_é" });
  const captured = options({ method: "POST", body, headers });
  assert.equal(captured.body, body);
  assert.equal(captured.headers.get("Content-Length"), String(Buffer.byteLength(body)));
  assert.equal(captured.headers.has("Transfer-Encoding"), false);
  assert.equal(headers["Content-Length"], undefined);
  assert.equal(options({ headers }).headers.get("Content-Length"), null);
  assert.equal(
    options({ method: "POST", body, headers: { "Content-Length": "1" } }).headers.get(
      "Content-Length",
    ),
    "1",
  );
  assert.throws(() => options({ method: "POST", body: new Uint8Array(1) }), /HELD/);
});

// The hold-description helpers: hosted run 39294535825 held after its last case had passed,
// with no failed check, no error and a stale stage, because the fixture wrapper does not
// pass the callback's error on and a test-side pool closure rejected first.
function labFunctions(names, globals = {}) {
  const context = vm.createContext({ ...globals });
  for (const name of names) {
    const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name.text === name);
    assert.ok(node, name);
    context[name] = vm.runInContext("(" + node.getText(ast) + ")", context);
  }
  return context;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const fakePool = (close, released = 1) => ({
  close,
  metrics: {
    connections: 1,
    released,
    closed: 1,
    discarded: 0,
    cancelled: 0,
    backendCleanupVerified: released,
    unverifiedHostClosures: 0,
    unrelated: "not copied",
  },
});

test("every test-side closure is attempted and named, and one rejection does not hide the others", async () => {
  const { settleTestSideClosures } = labFunctions(["settleTestSideClosures", "poolMetrics"]);
  const order = [],
    records = [];
  const verified = await settleTestSideClosures(
    [
      {
        label: "authority_read_1001_compact",
        pool: fakePool(async () => {
          order.push("rejecting");
          throw Error("LOCAL_STANDALONE_SQL_UNAVAILABLE");
        }, 0),
      },
      {
        label: "pre_seal_admission_0",
        pool: fakePool(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("slow");
        }),
      },
      { label: "fixture_harness", close: async () => order.push("harness") },
    ],
    records,
  );
  assert.equal(verified, false);
  assert.deepEqual(order.sort(), ["harness", "rejecting", "slow"]);
  assert.deepEqual(
    records.map((r) => [r.label, r.outcome]),
    [
      ["authority_read_1001_compact", "rejected"],
      ["pre_seal_admission_0", "fulfilled"],
      ["fixture_harness", "fulfilled"],
    ],
  );
  assert.match(records[0].error.message, /LOCAL_STANDALONE_SQL_UNAVAILABLE/);
  assert.deepEqual(plain(records[0].metrics), {
    connections: 1,
    released: 0,
    closed: 1,
    discarded: 0,
    cancelled: 0,
    backendCleanupVerified: 0,
    unverifiedHostClosures: 0,
  });
  assert.equal(records[2].metrics, null);
  assert.ok(records.every((r) => Number.isSafeInteger(r.ms) && r.ms >= 0));
  assert.ok(records[1].ms >= 4);
  const clean = [];
  assert.equal(
    await settleTestSideClosures([{ label: "only", pool: fakePool(async () => {}) }], clean),
    true,
  );
  assert.equal(clean[0].error, undefined);
});

test("a held error is described by class, fixed code, redacted message and repository frames only", () => {
  const root = "/home/runner/work/Morrow/Morrow";
  const marker = "private-session-secret-000000000001";
  const lab = labFunctions(["describeLabError", "stackFrames", "redacted", "logSafeError"], {
    privateMarkers: [marker, "short"],
    repositoryRoot: root,
  });
  const error = Error("LOCAL_STANDALONE_SQL_UNAVAILABLE");
  error.stack = [
    "Error: LOCAL_STANDALONE_SQL_UNAVAILABLE",
    `    at failure (${root}/scripts/local-standalone-sql.mjs:28:25)`,
    `    at checkBackend (file://${root}/scripts/local-standalone-sql.mjs:284:28)`,
    `    at async ${root}/node_modules/tsx/dist/esm/index.mjs:1:1`,
    "    at async /opt/hostedtoolcache/node/lib/internal.js:9:9",
    `    at async Promise.all (index 3)`,
    `    at async settleTestSideClosures (${root}/scripts/managed-workspace-api-postgresql-lab.mjs:1196:9)`,
  ].join("\n");
  const described = lab.describeLabError(error);
  assert.deepEqual(plain(described), {
    name: "Error",
    code: null,
    message: "LOCAL_STANDALONE_SQL_UNAVAILABLE",
    frames: [
      "scripts/local-standalone-sql.mjs:28:25",
      "scripts/local-standalone-sql.mjs:284:28",
      "scripts/managed-workspace-api-postgresql-lab.mjs:1196:9",
    ],
  });
  assert.deepEqual(plain(lab.logSafeError(described)), plain(described));
  const identity = Object.assign(Error("identity read held"), { code: "IDENTITY_UNAVAILABLE" });
  identity.name = "IdentityAccessError";
  assert.equal(lab.describeLabError(identity).code, "IDENTITY_UNAVAILABLE");
  assert.equal(lab.describeLabError(identity).name, "IdentityAccessError");
  const leaky = lab.describeLabError(Error("cookie " + marker + " short\u0000tail"));
  assert.equal(leaky.message, "cookie [private] short?tail");
  // Free text never reaches the job log; fixed codes, class names and frames do.
  assert.equal(lab.logSafeError(leaky).message, null);
  assert.equal(lab.logSafeError(null), null);
  assert.deepEqual(plain(lab.describeLabError("not an error")), {
    name: null,
    code: null,
    message: "non-error string",
    frames: [],
  });
  assert.equal(lab.describeLabError({ code: "lowercase_code" }).code, null);
});

test("the authority reads and final closures are attributed, not left to an unlabelled final hold", () => {
  const facade = source.slice(
    source.indexOf("for (const item of authorityFixtures)"),
    source.indexOf('enter("unknown_lease")'),
  );
  // The release stays synchronous for withIdentityRead; its verification is joined before
  // the native request and checked under the read's own name.
  assert.match(facade, /releases\.push\(\s*owned\.release\(discard\)\.then\(/);
  assert.match(facade, /releases: await Promise\.all\(releases\)/);
  assert.match(facade, /"restricted_read_backend_cleanup_verified_" \+ suffix/);
  assert.match(facade, /restrictedOutcome === "IDENTITY_DENIED"/);
  assert.equal(/void pending\.catch/.test(facade), false);
  const final = source.slice(
    source.indexOf('enter("final_proof_and_native_closure")'),
    source.indexOf("const finalNamespace = await engine.observeFinalNamespace()"),
  );
  assert.match(final, /enter\("final_test_side_sql_closure"\)/);
  assert.match(final, /settleTestSideClosures\(/);
  assert.match(final, /enter\("final_namespace"\)/);
  assert.equal(/await harness\.close\(\)/.test(final), false);
  assert.equal(/^\s*stage = "/m.test(source), false);
  assert.match(source, /catch \(error\) \{\s*holdError\(error, "callback"\);\s*throw error;/);
});
