import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const proof = "A".repeat(43),
  unavailable = "logout_unavailable",
  unknown = "logout_outcome_unknown";
const cases = [
  { name: "captured_family_retirement", status: 200, outcome: "session_ended", effects: 1 },
  {
    name: "held_physical_disposal",
    mode: "heldRelease",
    status: 200,
    outcome: "session_ended",
    effects: 1,
  },
  {
    name: "old_capture_new_login_replay",
    mode: "race",
    status: 200,
    outcome: "session_ended",
    effects: 2,
  },
  {
    name: "late_connection_abort_disposal",
    mode: "lateConnection",
    status: 503,
    outcome: unavailable,
    effects: 0,
  },
];
for (const [name, body] of Object.entries({
  extra: '{"schemaVersion":1,"familyId":"other"}',
  duplicate: '{"schemaVersion":1,"schemaVersion":1}',
  array: "[]",
  null: "null",
  malformed: "{",
  wrongVersion: '{"schemaVersion":2}',
  large: " ".repeat(257),
  badUTF8: [255],
}))
  cases.push({ name: "body_" + name, body, status: 400, outcome: unavailable, zeroSql: true });
for (const [name, headers] of Object.entries({
  origin: { Origin: "https://evil.test" },
  nullOrigin: { Origin: "null" },
  media: { "Content-Type": "application/json; charset=utf-8" },
  marker: { "X-Morrow-Request": "0" },
  authorization: { Authorization: "Bearer private-marker" },
  idempotency: { "Idempotency-Key": "private-marker" },
  site: { "Sec-Fetch-Site": "cross-site" },
  mode: { "Sec-Fetch-Mode": "navigate" },
  dest: { "Sec-Fetch-Dest": "document" },
}))
  cases.push({ name: "csrf_" + name, headers, status: 403, outcome: unavailable, zeroSql: true });
for (const [name, cookie] of Object.entries({
  missing: "",
  duplicate: `__Host-morrow_session=${proof}; __Host-morrow_session=${proof}`,
  case: `__host-morrow_session=${proof}`,
  loginCase: `__Host-morrow_session=${proof}; __host-morrow_login=${proof}`,
  loginDuplicate: `__Host-morrow_session=${proof}; __Host-morrow_login=${proof}; __Host-morrow_login=${proof}`,
  paddingBits: "__Host-morrow_session=" + "A".repeat(42) + "B",
  quoted: `__Host-morrow_session="${proof}"`,
  padded: `__Host-morrow_session=${proof}=`,
  encoded: `__Host-morrow_session=%41${proof}`,
  pairs:
    `__Host-morrow_session=${proof}; ` + Array.from({ length: 32 }, (_, i) => `k${i}=v`).join("; "),
  large: `__Host-morrow_session=${proof}; k=` + "x".repeat(4096),
}))
  cases.push({ name: "cookie_" + name, cookie, status: 403, outcome: unavailable, zeroSql: true });
for (const [name, options, status] of [
  ["route", { path: "/auth/other" }, 404],
  ["method", { method: "GET" }, 405],
  ["query", { path: "/auth/logout?x=1" }, 400],
  ["encoded", { path: "/auth/%6cogout" }, 404],
  ["host", { headers: { Host: "evil.test" } }, 400],
  ["length", { headers: { "Content-Length": "1" } }, 400],
  ["leadingZero", { headers: { "Content-Length": "019" } }, 400],
  [
    "ambiguousFraming",
    { headers: { "Content-Length": "19", "Transfer-Encoding": "chunked" } },
    400,
  ],
  ["headerBudget", { headers: { "X-Large": "x".repeat(8200) } }, 400],
  [
    "headerCount",
    { headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ["X-K" + i, "v"])) },
    400,
  ],
])
  cases.push({ name, ...options, status, outcome: unavailable, zeroSql: true });
cases.push(
  {
    name: "normal_login_cookie_coexists",
    cookie: `__Host-morrow_session=${proof}; __Host-morrow_login=${proof}`,
    status: 200,
    outcome: "session_ended",
    effects: 1,
  },
  {
    name: "foreign_immutable_namespace",
    mode: "foreign",
    status: 403,
    outcome: unavailable,
    effects: 0,
  },
  { name: "unsafe_role", mode: "unsafe", status: 503, outcome: unavailable, effects: 0 },
  { name: "malformed_result", mode: "malformedResult", status: 503, outcome: unknown, effects: 0 },
);
for (const stage of [
  "connect",
  "begin",
  "role",
  "timeout",
  "idleTimeout",
  "end",
  "commit",
  "release",
])
  cases.push({
    name: "lost_" + stage,
    stage,
    fault: "throw",
    status: 503,
    outcome: ["end", "commit", "release"].includes(stage) ? unknown : unavailable,
    effects: ["commit", "release"].includes(stage) ? 1 : 0,
  });
for (const fault of ["expiry", "clock", "abort"])
  cases.push({
    name: "posteffect_" + fault,
    stage: "commit",
    fault,
    status: 503,
    outcome: unknown,
    effects: 1,
  });
for (const mode of ["sinkThrow", "sinkReject", "sinkPending"])
  cases.push({ name: mode, mode, status: 503, outcome: unknown, effects: 1 });
const paths = [
  "packages/identity/src/standalone-logout.ts",
  "packages/identity/src/self-logout-control.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/index.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/domain.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "docs/contracts/schemas/v1/core.schema.json",
  "scripts/fixtures/standalone-logout-fixture.ts",
  "scripts/fixtures/standalone-logout-worker.ts",
  "scripts/standalone-logout-workers-lab.mjs",
  "tests/standalone-logout.test.mjs",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "docs/packets/P05.T01q.md",
  "docs/packets/P05.T01r.md",
  "package-lock.json",
  "package.json",
  ".github/workflows/ci.yml",
];
assert.equal(JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan.sequence, 86);
const sourceDigests = Object.fromEntries(
  paths.sort().map((path) => [path, hash(readFileSync(path))]),
);
const bundled = await build({
  entryPoints: ["scripts/fixtures/standalone-logout-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  metafile: true,
});
assert.deepEqual(
  Object.values(bundled.metafile.outputs).flatMap((output) => output.imports),
  [],
);
assert.ok(
  !Object.keys(bundled.metafile.inputs).some((path) => /ajv\/dist\/(compile|core|2020)/.test(path)),
);
let outbound = 0;
const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.NONE),
  outboundService: () => {
    outbound++;
    return new Response(null, { status: 502 });
  },
});
try {
  const response = await mf.dispatchFetch("http://localhost/synthetic-logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cases }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(new Set(result.checks.map((c) => c.name)).size, result.checks.length);
  assert.deepEqual(
    result.checks.filter((c) => c.passed !== true),
    [],
  );
  assert.equal(result.metrics.length, cases.length);
  assert.equal(outbound, 0);
  for (const [path, digest] of Object.entries(sourceDigests))
    assert.equal(hash(readFileSync(path)), digest, "Source changed: " + path);
  const report = {
    task: "P05.T01q",
    current_plan_sequence: 86,
    qualification_status: "passed",
    qualification:
      "actual_local_workerd_nodejs_compat_Fetch_WebCrypto_with_synthetic_fixed_SQL_oracle",
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    observedAt: new Date().toISOString(),
    cases: cases.length,
    checks: result.checks,
    metrics: result.metrics,
    outboundRequests: outbound,
    source_digests: sourceDigests,
    source_inventory_digest: hash(JSON.stringify(Object.entries(sourceDigests))),
    limitations: [
      "Synthetic SQL replies do not qualify PostgreSQL, role/locking semantics or physical backend cleanup.",
      "Worker Fetch response attributes do not qualify browser-engine cookie enforcement, native TLS or HTTP delivery.",
      "No provider, hosted key/custody, deployment or merchant activation.",
    ],
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  for (const value of [proof, "B".repeat(42) + "A", "private-marker", "SYNTHETIC_PRIVATE_FAULT"])
    assert.ok(!text.includes(value));
  mkdirSync("docs/evidence/P05.T01r/regressions", { recursive: true });
  writeFileSync("docs/evidence/P05.T01r/regressions/logout-workers-lab.json", text);
  console.log(
    `PASS: ${cases.length} standalone logout Workers cases; ${result.checks.length} checks; zero outbound requests.`,
  );
} finally {
  await mf.dispose();
}
