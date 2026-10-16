import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = Buffer.alloc(32, 27).toString("base64url"),
  token = Buffer.alloc(32, 31).toString("base64url"),
  command = "e519ea9d-c5eb-4613-906c-26a870c0e9e8";
const csrfFor = (workspace = "workspace_a", cmd = command, nonce = token, key = secret) =>
  createHmac("sha256", Buffer.from(key, "base64url"))
    .update(JSON.stringify(["morrow.store-links.csrf", 1, workspace, cmd, nonce]))
    .digest("base64url");
const csrf = csrfFor(),
  cases = [
    {
      name: "preview_apply_readonly_status",
      workflow: true,
      expectedStatus: 200,
      expectedOutcome: "applied",
    },
  ];
const add = (name, options) => cases.push({ name, ...options });
for (const route of ["preview", "apply", "status"])
  add("valid_" + route, {
    route,
    expectedStatus: 200,
    ...(route === "preview" ? {} : { expectedOutcome: "applied" }),
  });
for (const [name, headers, expectedStatus] of [
  ["no_cookie", { Cookie: "other=x" }, 401],
  [
    "duplicate_cookie",
    { Cookie: `__Host-morrow_session=${secret};__Host-morrow_session=${secret}` },
    401,
  ],
  ["bad_cookie_bits", { Cookie: `__Host-morrow_session=${secret.slice(0, -1)}B` }, 401],
  ["foreign_origin", { Origin: "https://other.example.test" }, 403],
  ["null_origin", { Origin: "null" }, 403],
  ["cross_site", { "Sec-Fetch-Site": "cross-site" }, 403],
  ["same_site", { "Sec-Fetch-Site": "same-site" }, 403],
  ["foreign_host", { Host: "other.example.test" }, 403],
  ["bearer", { Authorization: "Bearer " + secret }, 401],
  ["missing_marker", { "X-Morrow-Request": "" }, 403],
  ["wrong_type", { "Content-Type": "text/plain" }, 403],
  ["missing_command", { "Idempotency-Key": "" }, 400],
  ["merged_command", { "Idempotency-Key": command + "," + command }, 400],
  ["missing_csrf", { "X-Morrow-CSRF": "" }, 403],
  ["malformed_csrf", { "X-Morrow-CSRF": "not-canonical" }, 403],
  ["HMAC_other_workspace", { "X-Morrow-CSRF": csrfFor("workspace_b") }, 403],
  [
    "HMAC_other_command",
    { "X-Morrow-CSRF": csrfFor("workspace_a", "1519ea9d-c5eb-4613-906c-26a870c0e9e8") },
    403,
  ],
  ["HMAC_other_handoff", { "X-Morrow-CSRF": csrfFor("workspace_a", command, secret) }, 403],
  ["HMAC_other_session", { "X-Morrow-CSRF": csrfFor("workspace_a", command, token, token) }, 403],
])
  add(name, { headers, expectedStatus, zeroSql: true, zeroApply: true });
for (const [name, body] of [
  ["extra_authority", JSON.stringify({ handoffToken: token, approved: true })],
  ["duplicate_member", `{"handoffToken":"${token}","handoffToken":"${token}"}`],
  ["bad_handoff_bits", JSON.stringify({ handoffToken: token.slice(0, -1) + "B" })],
  ["invalid_UTF8", [255]],
  ["oversized", " ".repeat(257)],
])
  add(name, { body, expectedStatus: 400, zeroSql: true, zeroApply: true });
add("query_token", {
  path: "/workspace/workspace_a/store-links?token=" + token,
  expectedStatus: 403,
  zeroSql: true,
  zeroApply: true,
});
add("unsupported_method", { method: "PUT", expectedStatus: 405, zeroSql: true, zeroApply: true });
for (const roleFlag of [
  "rolsuper",
  "rolbypassrls",
  "rolcreatedb",
  "rolcreaterole",
  "rolinherit",
  "owner_member",
  "role_member",
  "rolreplication",
])
  add("unsafe_role_" + roleFlag, {
    roleFlag,
    expectedStatus: 503,
    expectedOutcome: "outcome_unknown",
    zeroApply: true,
  });
for (const lookup of [
  "absent",
  "foreign_workspace",
  "foreign_session",
  "foreign_nonce",
  "foreign_command",
  "unsafe_revision",
])
  add("lookup_" + lookup, {
    lookup,
    expectedStatus: lookup === "absent" ? 404 : 503,
    ...(lookup === "absent" ? {} : { expectedOutcome: "outcome_unknown" }),
    zeroApply: true,
  });
for (const [result, expectedStatus, expectedOutcome] of [
  ["denied", 403, "denied"],
  ["conflict", 409, "conflict"],
  ["malformed", 503, "outcome_unknown"],
])
  add("final_writer_" + result, { result, expectedStatus, expectedOutcome });
for (const stage of ["begin", "role", "lookup", "commit", "release"])
  add("lost_read_" + stage, {
    phase: "read",
    stage,
    fault: "throw",
    expectedStatus: 503,
    expectedOutcome: "outcome_unknown",
    zeroApply: true,
  });
for (const stage of ["begin", "role", "apply", "commit", "release"])
  add("lost_apply_" + stage, {
    phase: "apply",
    stage,
    fault: "throw",
    expectedStatus: 503,
    expectedOutcome: "outcome_unknown",
  });
for (const stage of ["apply", "commit", "release"])
  for (const fault of ["expiry", "abort"])
    add(fault + "_apply_" + stage, {
      phase: "apply",
      stage,
      fault,
      expectedStatus: 503,
      expectedOutcome: "outcome_unknown",
    });
add("clock_during_apply", {
  phase: "apply",
  stage: "apply",
  fault: "clock",
  expectedStatus: 503,
  expectedOutcome: "outcome_unknown",
});
add("late_read_acquisition", {
  phase: "read",
  stage: "connect",
  fault: "late",
  expectedStatus: 503,
  expectedOutcome: "outcome_unknown",
  zeroApply: true,
});
add("stalled_apply_cancelled", {
  phase: "apply",
  stage: "apply",
  fault: "stall",
  expectedStatus: 503,
  expectedOutcome: "outcome_unknown",
});
add("missing_terminal_status", {
  route: "status",
  result: "absent",
  expectedStatus: 404,
  zeroApply: true,
});
add("malformed_terminal_status", {
  route: "status",
  result: "malformed",
  expectedStatus: 503,
  zeroApply: true,
});
add("lost_status_ack", {
  route: "status",
  phase: "read",
  stage: "status",
  fault: "throw",
  expectedStatus: 503,
  zeroApply: true,
});

const paths = [
  "packages/identity/src/standalone-store-linking.ts",
  "packages/identity/src/workspace-store-linking-control.ts",
  "packages/identity/src/workspace-store-linking.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/index.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "packages/contracts/src/generated/domain.ts",
  "docs/contracts/schemas/v1/core.schema.json",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "docs/packets/P05.T01q.md",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
  "docs/packets/P05.T01t.md",
  "docs/packets/P05.T01u.md",
  "docs/packets/P05.T01v.md",
  "docs/packets/P05.T01o.md",
  "docs/packets/P05.T03b.md",
  "migrations/0009.workspace-linking-read-boundaries.sql",
  "scripts/standalone-store-linking-workers-lab.mjs",
  "scripts/fixtures/standalone-store-linking-worker.ts",
  "tests/workspace-store-linking-control.test.mjs",
  ".nvmrc",
  "package-lock.json",
];
// The SQL file is provenance only: this laboratory never installs or executes it.
const sourceDigests = Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
assert.equal(JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan.sequence, 94);
const bundle = await build({
  entryPoints: ["scripts/fixtures/standalone-store-linking-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  metafile: true,
});
assert.ok(
  !Object.keys(bundle.metafile.inputs).some((path) => /ajv\/dist\/(compile|core|2020)/.test(path)),
);
assert.ok(
  !Object.values(bundle.metafile.outputs).some((output) =>
    output.imports.some((item) => item.path.startsWith("node:")),
  ),
);
let outbound = 0;
const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  log: new Log(LogLevel.NONE),
  outboundService: () => {
    outbound++;
    return new Response(null, { status: 502 });
  },
});
try {
  const response = await mf.dispatchFetch("http://localhost/synthetic-standalone-store-linking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, token, command, csrf, cases }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(new Set(result.checks.map((item) => item.name)).size, result.checks.length);
  assert.deepEqual(
    result.checks.filter((item) => item.passed !== true),
    [],
  );
  assert.equal(result.metrics.length, cases.length);
  assert.equal(outbound, 0);
  for (const [path, digest] of Object.entries(sourceDigests))
    assert.equal(hash(readFileSync(path)), digest, "Source changed during qualification: " + path);
  const report = {
    task: "P05.T03b",
    canonicalSequence: 94,
    qualification:
      "actual_local_workerd_HTTP_guard_controlled_linking_composition_WebCrypto_and_synthetic_SQL",
    compatibilityDate: "2026-07-30",
    observedAt: new Date().toISOString(),
    cases: cases.length,
    checks: result.checks,
    outboundRequests: outbound,
    metrics: result.metrics,
    sourceDigests,
    selectedSourceDigest: hash(JSON.stringify(Object.entries(sourceDigests))),
    limitations: [
      "SQL replies are synthetic; PostgreSQL locking, grant/review/proof validation, persistence and idempotency qualify separately.",
      "Release attempts/completions are synthetic adapter observations, not physical database/backend cleanup.",
      "No live provider credential, Shopify verification, cookie issuance, hosted migration, deployment or merchant activation.",
    ],
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  for (const privateValue of [secret, token, hash(secret), hash(token), csrf])
    assert.ok(!text.includes(privateValue));
  mkdirSync("docs/evidence/P05.T01v/regressions", { recursive: true });
  writeFileSync("docs/evidence/P05.T01v/regressions/standalone-store-linking-workers.json", text);
  console.log(
    `PASS: ${cases.length} standalone store-linking Workers cases; ${result.checks.length} checks; zero outbound requests.`,
  );
} finally {
  await mf.dispose();
}
