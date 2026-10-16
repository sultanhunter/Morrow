import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const secret = Buffer.alloc(32, 27).toString("base64url"),
  token = Buffer.alloc(32, 31).toString("base64url");
const command = "e519ea9d-c5eb-4613-906c-26a870c0e9e8";
const csrf = createHmac("sha256", Buffer.from(secret, "base64url"))
  .update(JSON.stringify(["morrow.store-links.csrf", 1, "workspace_a", command, token]))
  .digest("base64url");
const cases = [
  { name: "cookie_workspace_latest_policy", expectedStatus: 200 },
  { name: "two_workspace_requests_independent", mode: "two_workspaces", expectedStatus: 200 },
];
const add = (name, options) => cases.push({ name, ...options });
for (const [name, cookie] of Object.entries({
  missing: "",
  unrelated: "other=ok",
  duplicate: `__Host-morrow_session=${secret};__Host-morrow_session=${secret}`,
  quoted: `__Host-morrow_session="${secret}"`,
  comma: `__Host-morrow_session=${secret},x=y`,
  padding: `__Host-morrow_session=${secret}=`,
  bits: `__Host-morrow_session=${secret.slice(0, -1)}B`,
  encoded: `__Host-morrow_session=%41${secret.slice(1)}`,
  case: `__host-morrow_session=${secret}`,
  pairs:
    `__Host-morrow_session=${secret};` + Array.from({ length: 32 }, (_, i) => `a${i}=b`).join(";"),
  oversized: `__Host-morrow_session=${secret};other=` + "x".repeat(4096),
}))
  add("invalid_cookie_" + name, {
    headers: { Cookie: cookie },
    expectedStatus: 401,
    zeroSql: true,
  });
for (const [name, headers, expectedStatus] of [
  ["foreign_origin", { Origin: "https://other.example.test" }, 403],
  ["null_origin", { Origin: "null" }, 403],
  ["same_site", { "Sec-Fetch-Site": "same-site" }, 403],
  ["cross_site", { "Sec-Fetch-Site": "cross-site" }, 403],
  ["foreign_host", { Host: "other.example.test" }, 403],
  ["bearer", { Authorization: "Bearer " + secret }, 401],
  ["GET_body_declaration", { "Content-Length": "1" }, 400],
])
  add(name, { headers, expectedStatus, zeroSql: true });
for (const [name, path, expectedStatus] of [
  ["query_token", "/workspace/workspace_a/bootstrap?token=" + secret, 403],
  ["encoded_workspace", "/workspace/%77orkspace_a/bootstrap", 404],
  ["extra_segment", "/workspace/workspace_a/bootstrap/extra", 404],
])
  add(name, { path, expectedStatus, zeroSql: true });
add("unsupported_method", { method: "POST", body: "{}", expectedStatus: 405, zeroSql: true });
for (const kind of [
  "missing",
  "foreign",
  "workspace_revoked",
  "authority_revoked",
  "principal_changed",
])
  add("current_SQL_" + kind, { kind, expectedStatus: 401 });
for (const roleFlag of ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole", "owner_member"])
  add("unsafe_role_" + roleFlag, { roleFlag, expectedStatus: 401 });
for (const stage of [
  "connect",
  "begin",
  "resolve",
  "workspace",
  "workspaceAuthority",
  "commit",
  "release",
])
  add("deadline_" + stage, { stage, kind: "expiry", expectedStatus: 503 });
for (const stage of ["begin", "resolve", "workspace", "workspaceAuthority", "commit", "release"])
  add("unknown_" + stage, { stage, kind: "throw", expectedStatus: 503 });
add("clock_regression", { stage: "resolve", kind: "clock", expectedStatus: 503 });
add("query_abort", { stage: "workspace", kind: "abort", expectedStatus: 503 });
add("late_connection_disposed", { stage: "connect", kind: "late", expectedStatus: 503 });
add("stalled_query_cancelled", { stage: "workspace", kind: "stall", expectedStatus: 503 });
for (const mode of ["preview", "status", "apply"])
  add("guard_" + mode + "_native_crypto", {
    mode,
    expectedStatus: 200,
    expectedCsrf: csrf,
    ...(mode === "apply" ? { headers: { "X-Morrow-CSRF": csrf } } : {}),
  });
for (const kind of ["expiry", "abort", "throw"])
  add("guard_apply_unknown_" + kind, {
    mode: "apply",
    stage: "callback",
    kind,
    headers: { "X-Morrow-CSRF": csrf },
    expectedCsrf: csrf,
    expectedStatus: 503,
  });
for (const [name, change, expectedStatus] of [
  ["missing_csrf", {}, 403],
  ["bad_csrf", { headers: { "X-Morrow-CSRF": secret } }, 403],
  ["wrong_origin", { headers: { Origin: "null", "X-Morrow-CSRF": csrf } }, 403],
  ["extra_authority", { body: JSON.stringify({ handoffToken: token, approved: true }) }, 400],
  ["duplicate_key", { body: `{"handoffToken":"${token}","handoffToken":"${token}"}` }, 400],
  ["invalid_UTF8", { body: [255] }, 400],
  ["large_body", { body: " ".repeat(257) }, 400],
])
  add("guard_apply_denied_" + name, { mode: "apply", ...change, expectedStatus, zeroSql: true });

const paths = [
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/index.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/domain.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "docs/contracts/schemas/v1/core.schema.json",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "docs/packets/P05.T01p.md",
  "docs/packets/P05.T01o.md",
  "docs/packets/P05.T03b.md",
  "scripts/standalone-workspace-workers-lab.mjs",
  "scripts/fixtures/standalone-workspace-worker.ts",
  "tests/standalone-workspace-bootstrap.test.mjs",
  ".nvmrc",
  "package-lock.json",
];
const sourceDigests = Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
assert.equal(JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan.sequence, 84);
const bundled = await build({
  entryPoints: ["scripts/fixtures/standalone-workspace-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  metafile: true,
});
assert.ok(
  !Object.keys(bundled.metafile.inputs).some((path) => /ajv\/dist\/(compile|core|2020)/.test(path)),
);
assert.ok(
  !Object.values(bundled.metafile.outputs).some((output) =>
    output.imports.some((item) => item.path.startsWith("node:")),
  ),
);
let outbound = 0;
const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  log: new Log(LogLevel.NONE),
  outboundService: () => {
    outbound++;
    return new Response(null, { status: 502 });
  },
});
try {
  const response = await mf.dispatchFetch("http://localhost/synthetic-standalone-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, token, command, cases }),
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
    task: "P05.T01o",
    canonicalSequence: 84,
    qualification:
      "actual_local_workerd_Fetch_WebCrypto_with_synthetic_SQL_and_independent_native_HMAC_oracle",
    compatibilityDate: "2026-07-30",
    observedAt: new Date().toISOString(),
    cases: cases.length,
    checks: result.checks,
    outboundRequests: outbound,
    metrics: result.metrics,
    sourceDigests,
    selectedSourceDigest: hash(JSON.stringify(Object.entries(sourceDigests))),
    limitations: [
      "SQL replies and browser credentials are synthetic; actual PostgreSQL/session admission is qualified separately.",
      "Mutation checks exercise the shared request guard only, not the controlled linking SQL or HTTP service.",
      "No cookie issuance, real provider request, hosted identity, deployment or merchant activation.",
    ],
  };
  const publicText = JSON.stringify(report, null, 2) + "\n";
  for (const privateValue of [secret, token, hash(secret), hash(token), csrf])
    assert.ok(!publicText.includes(privateValue));
  mkdirSync("docs/evidence/P05.T01p/regressions", { recursive: true });
  writeFileSync("docs/evidence/P05.T01p/regressions/standalone-workspace-workers.json", publicText);
  console.log(
    `PASS: ${cases.length} standalone workspace Workers cases; ${result.checks.length} checks; zero outbound requests.`,
  );
} finally {
  await mf.dispose();
}
