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
