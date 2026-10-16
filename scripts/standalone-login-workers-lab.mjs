import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { buildWorkosAuthenticationEvidenceFixture } from "../tests/fixtures/workos-authentication-evidence.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixture = buildWorkosAuthenticationEvidenceFixture();
const cases = [
  {
    name: "owning_chain_cookie",
    mode: "success",
    expectedStatus: 303,
    expectedLocation: "/",
    expectedPorts: ["exchange", "keyset", "page"],
  },
  {
    name: "callback_replay_no_cookie",
    mode: "replay",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts: ["exchange", "keyset", "page"],
  },
  {
    name: "key_loss_no_reconstruction",
    mode: "key_loss",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts: [],
  },
  {
    name: "sink_failure_no_resend",
    mode: "sink_throw",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts: ["exchange", "keyset", "page"],
  },
  {
    name: "generic_static_result",
    mode: "static",
    expectedStatus: 200,
    zeroSql: true,
    expectedPorts: [],
  },
];
for (const [name, body] of Object.entries({
  extra: '{"schemaVersion":1,"workspaceId":"workspace_a","role":"admin"}',
  duplicate: '{"schemaVersion":1,"workspaceId":"workspace_a","workspaceId":"workspace_b"}',
  bad_id: '{"schemaVersion":1,"workspaceId":"../admin"}',
  malformed: "{",
  large: " ".repeat(513),
  bad_UTF8: [255],
}))
  cases.push({
    name: "start_" + name,
    mode: "start",
    body,
    expectedStatus: 400,
    zeroSql: true,
    expectedPorts: [],
  });
for (const [name, headers] of Object.entries({
  foreign_origin: { Origin: "https://evil.example.test" },
  null_origin: { Origin: "null" },
  site: { "Sec-Fetch-Site": "cross-site" },
  mode: { "Sec-Fetch-Mode": "navigate" },
  destination: { "Sec-Fetch-Dest": "document" },
  missing_marker: { "X-Morrow-Request": "0" },
  bearer: { Authorization: "Bearer private-marker" },
}))
  cases.push({
    name: "start_" + name,
    mode: "start",
    headers,
    expectedStatus: 403,
    zeroSql: true,
    expectedPorts: [],
  });
for (const [name, path] of Object.entries({
  provider_denial: "/auth/workos/callback?error=access_denied",
  missing: "/auth/workos/callback",
  extra: "/auth/workos/callback?code=x&state=x&extra=y",
  encoded_key: "/auth/workos/callback?%63ode=x&state=x",
  duplicate: "/auth/workos/callback?code=x&code=y",
  bad_UTF8: "/auth/workos/callback?code=%FF&state=x",
}))
  cases.push({
    name: "callback_" + name,
    mode: "malformed",
    path,
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    zeroSql: true,
    expectedPorts: [],
  });
for (const [name, cookie] of Object.entries({
  missing: "",
  duplicate: "__Host-morrow_login=PROOF;__Host-morrow_login=PROOF",
  quoted: '__Host-morrow_login="PROOF"',
  case: "__host-morrow_login=PROOF",
  padded: "__Host-morrow_login=PROOF=",
  encoded: "__Host-morrow_login=%41PROOF",
}))
  cases.push({
    name: "cookie_" + name,
    cookie,
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    zeroSql: true,
    expectedPorts: [],
  });
for (const [stage, expectedPorts] of [
  ["preauth:admit", []],
  ["provider:exchange", ["exchange"]],
  ["provider:keyset", ["exchange", "keyset"]],
])
  cases.push({
    name: "profile_revocation_" + stage.replace(":", "_"),
    stage,
    fault: "revoke",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts,
  });
for (const stage of [
  "login:claimCallback",
  "preauth:admit",
  "login:observeEligibility",
  "provider:exchange",
  "provider:keyset",
  "provider:page",
  "selection:resolve",
  "sessions:admit",
  "sessions:commit",
  "sessions:release",
])
  cases.push({
    name: "unknown_" + stage.replace(":", "_"),
    stage,
    fault: "throw",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
  });
for (const stage of [
  "preauth:admit",
  "provider:exchange",
  "provider:keyset",
  "provider:page",
  "selection:resolve",
  "sessions:release",
])
  cases.push({
    name: "expiry_" + stage.replace(":", "_"),
    stage,
    fault: "expiry",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
  });
cases.push(
  {
    name: "clock_regression_before_exchange",
    stage: "preauth:admit",
    fault: "clock",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts: [],
  },
  {
    name: "abort_after_M_before_sink",
    mode: "aborted",
    stage: "sessions:release",
    fault: "abort",
    expectedStatus: 503,
  },
);
for (const [field, value] of Object.entries({
  ciphertext: "A".repeat(202),
  encryption_nonce: "A".repeat(16),
  aad_digest: "a".repeat(64),
  key_id: "10000000-0000-0000-0000-000000000000",
  workspace_id: "workspace_b",
  expires_at_ms: String(fixture.at + 299000),
}))
  cases.push({
    name: "AAD_tamper_" + field,
    mode: "tamper",
    field,
    value,
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts: [],
  });
cases.push({
  name: "UTF8_header_byte_budget",
  mode: "start",
  headers: { "X-Synthetic-Latin1": "é".repeat(4100) },
  expectedStatus: 400,
  zeroSql: true,
  expectedPorts: [],
});
cases.push(
  {
    name: "composition8s_SQL3s_original_lease",
    mode: "success",
    fault: "slow_lease",
    expectedStatus: 303,
    expectedLocation: "/",
    expectedPorts: ["exchange", "keyset", "page"],
  },
  {
    name: "rejected_sink_Promise_no_resend",
    mode: "sink_reject",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts: ["exchange", "keyset", "page"],
  },
  {
    name: "pending_sink_Promise_no_wait",
    mode: "sink_pending",
    expectedStatus: 303,
    expectedLocation: "/auth/result",
    expectedPorts: ["exchange", "keyset", "page"],
  },
);
const paths = [
  "packages/identity/src/standalone-login.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/login-preauth-control.ts",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-workspace-selection.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/index.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/domain.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "docs/contracts/schemas/v1/core.schema.json",
  "scripts/fixtures/standalone-login-fixture.ts",
  "scripts/fixtures/standalone-login-worker.ts",
  "scripts/standalone-login-workers-lab.mjs",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "tests/standalone-login.test.mjs",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "docs/packets/P05.T01p.md",
  "docs/packets/P05.T01q.md",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
  "docs/packets/P05.T01t.md",
  "docs/packets/P05.T01u.md",
  "docs/packets/P05.T01v.md",
  "package-lock.json",
  "package.json",
  ".github/workflows/ci.yml",
];
assert.equal(JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan.sequence, 94);
const sourceDigests = Object.fromEntries(
  paths.sort().map((path) => [path, hash(readFileSync(path))]),
);
const bundled = await build({
  entryPoints: ["scripts/fixtures/standalone-login-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:crypto"],
  metafile: true,
});
const imports = Object.values(bundled.metafile.outputs).flatMap((output) =>
  output.imports.map((item) => item.path),
);
assert.deepEqual(imports, ["node:crypto"]);
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
  const response = await mf.dispatchFetch("http://localhost/synthetic-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      at: fixture.at,
      profile: fixture.profile,
      profileJson: fixture.profileJson,
      snapshotJson: fixture.snapshotJson,
      token: fixture.token,
      page: fixture.page(),
      cases,
    }),
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
    task: "P05.T01p",
    current_plan_sequence: 94,
    qualification:
      "actual_local_workerd_nodejs_compat_Fetch_WebCrypto_AESGCM_unchanged69_owning76_77_M_with_synthetic_SQL_and_independent_native_RSA",
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
      "Synthetic SQL replies do not qualify PostgreSQL or cleanup of real backends.",
      "Worker response attributes do not qualify browser-engine cookie enforcement or HTTP delivery.",
      "No native provider, hosted key/custody, deployment or merchant activation.",
    ],
  };
  const publicText = JSON.stringify(report, null, 2) + "\n";
  for (const secret of [fixture.token, fixture.claims.sub, fixture.claims.sid, "synthetic-code"])
    assert.ok(!publicText.includes(secret));
  mkdirSync("docs/evidence/P05.T01v/regressions", { recursive: true });
  writeFileSync("docs/evidence/P05.T01v/regressions/login-workers-lab.json", publicText);
  console.log(
    `PASS: ${cases.length} standalone login Workers cases; ${result.checks.length} checks; zero outbound requests.`,
  );
} finally {
  await mf.dispose();
}
