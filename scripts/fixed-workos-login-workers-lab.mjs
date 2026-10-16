import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { createFixedWorkosProviderOracle } from "./fixtures/fixed-workos-provider.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.version, "v24.13.0");
assert.equal(JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan.sequence, 88);
const oracle = createFixedWorkosProviderOracle();
const verifier = Buffer.alloc(32, 13).toString("base64url");
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
const issued = oracle.issueCode({ challenge });
const at = oracle.at;
const page = JSON.stringify({
  object: "list",
  data: [
    {
      object: "session",
      id: issued.claims.sid,
      user_id: issued.claims.sub,
      status: "active",
      auth_method: "oauth",
      ended_at: null,
      created_at: new Date(at - 60000).toISOString(),
      updated_at: new Date(at - 1000).toISOString(),
      expires_at: new Date(at + 60000).toISOString(),
    },
  ],
  list_metadata: { before: null, after: null },
});
const cases = [
  { name: "independent_HTTP_PKCE_RSA_owning_chain", method: "chain", expected: "pass" },
  {
    name: "two_independent_callbacks_one_port",
    method: "concurrent",
    expected: "pass",
    zeroBorrow: true,
  },
];
for (const method of ["exchange", "keyset", "page"]) {
  cases.push({
    name: method + "_success",
    method,
    expected: "pass",
    zeroBorrow: method !== "page",
  });
  cases.push({
    name: method + "_compressed_length_not_decoded_length",
    method,
    fault: "compressed",
    expected: "pass",
    zeroBorrow: method !== "page",
  });
  for (const fault of [
    "status",
    "redirect",
    "redirected",
    "foreign_url",
    "media",
    "declared_size",
    "noncanonical_size",
    "oversize",
    "bom",
    "utf8",
    "duplicate",
    "bad_chunk",
    "clock",
    "expiry",
    "abort",
    "late_response",
    "cancel_reject",
    "cancel_pending",
  ])
    cases.push({
      name: method + "_" + fault,
      method,
      fault,
      expected: "held",
      zeroBorrow: method !== "page",
    });
  for (const fault of ["expired_control", "aborted_control", "config_extra"])
    cases.push({
      name: method + "_" + fault,
      method,
      fault,
      expected: "held",
      zeroFetch: true,
      zeroBorrow: true,
    });
}
for (const fault of [
  "foreign_client",
  "foreign_callback",
  "invalid_verifier",
  "invalid_admission",
  "duplicate_input",
])
  cases.push({
    name: "exchange_" + fault,
    method: "exchange",
    fault,
    expected: "held",
    zeroFetch: true,
    zeroBorrow: true,
  });
for (const fault of ["private_jwk", "certificate", "keys17"])
  cases.push({
    name: "keyset_" + fault,
    method: "keyset",
    fault,
    expected: "held",
    zeroBorrow: true,
  });
cases.push({
  name: "keyset_checked_discarded_certificate",
  method: "keyset",
  fault: "certificate_valid",
  expected: "pass",
  zeroBorrow: true,
});
for (const fault of ["invalid_subject", "invalid_cursor"])
  cases.push({
    name: "page_" + fault,
    method: "page",
    fault,
    expected: "held",
    zeroFetch: true,
    zeroBorrow: true,
  });
for (const fault of [
  "wrong_namespace",
  "bad_credential",
  "expired_lease",
  "revoked_lease",
  "late_lease",
  "release_reject",
  "release_pending",
  "revoke",
])
  cases.push({
    name: "page_" + fault,
    method: "page",
    fault,
    expected: "held",
    zeroFetch: [
      "wrong_namespace",
      "bad_credential",
      "expired_lease",
      "revoked_lease",
      "late_lease",
    ].includes(fault),
  });
const paths = [
  "packages/identity/src/fixed-workos-login-port.ts",
  "packages/identity/src/standalone-login.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-workspace-selection.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/login-preauth-control.ts",
  "packages/identity/src/login-flow-custody.ts",
  "scripts/fixtures/standalone-login-fixture.ts",
  "scripts/fixtures/fixed-workos-login-worker.ts",
  "scripts/fixtures/fixed-workos-provider.mjs",
  "scripts/fixed-workos-login-workers-lab.mjs",
  "tests/fixed-workos-provider.test.mjs",
  "tests/fixed-workos-login-port.test.mjs",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
  "docs/packets/P05.T01t.md",
  "package.json",
  "package-lock.json",
  ".github/workflows/ci.yml",
];
const sourceDigests = Object.fromEntries(
  paths.sort().map((path) => [path, hash(readFileSync(path))]),
);
const bundled = await build({
  entryPoints: ["scripts/fixtures/fixed-workos-login-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:crypto"],
  metafile: true,
});
const imports = Object.values(bundled.metafile.outputs).flatMap((output) =>
  output.imports.map((entry) => entry.path),
);
assert.ok(imports.every((entry) => entry === "node:crypto"));
assert.ok(
  !Object.keys(bundled.metafile.inputs).some((path) => /ajv\/dist\/(compile|core|2020)/.test(path)),
);
let outbound = 0,
  disposed = false;
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
let result;
try {
  const response = await mf.dispatchFetch("http://localhost/synthetic-fixed-provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      at,
      configurationJson: oracle.configurationJson,
      profile: oracle.profile,
      profileJson: oracle.profileJson,
      token: issued.token,
      publicJwk: oracle.publicJwk,
      claims: issued.claims,
      page,
      verifier,
      challenge,
      cases,
    }),
  });
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(
    new Set(result.checks.map((check) => check.name)).size,
    result.checks.length,
    "check names are unique",
  );
  assert.deepEqual(
    result.checks.filter((check) => check.passed !== true),
    [],
  );
  assert.equal(result.metrics.length, cases.length);
  assert.equal(outbound, 0);
} finally {
  await mf.dispose();
  disposed = true;
}
assert.equal(disposed, true);
for (const [path, digest] of Object.entries(sourceDigests))
  assert.equal(hash(readFileSync(path)), digest, "source changed: " + path);
const report = {
  task: "P05.T01r",
  current_plan_sequence: 88,
  qualification:
    "actual_local_pinned_workerd_fixed_WorkOS_wire_with_independent_HTTP_PKCE_native_RSA_and_unchanged84_owning76_77_M_synthetic_SQL",
  observedAt: new Date().toISOString(),
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  cases: cases.length,
  checks: result.checks,
  metrics: result.metrics,
  outboundRequests: outbound,
  cleanup: {
    workerRuntimeDisposalAcknowledged: disposed,
    nativeProviderRequests: 0,
    credentialProvisioning: false,
    databaseResourcesCreated: false,
  },
  source_digests: sourceDigests,
  source_inventory_digest: hash(JSON.stringify(Object.entries(sourceDigests))),
  limitations: [
    "Synthetic fixed Response.url attestation and in-process Fetch do not qualify WorkOS DNS, TLS, account or credential ownership.",
    "Compressed-length cases model a Fetch stream after decoding; they do not qualify a network decompressor or compressed HTTP transport.",
    "Native independently generated RSA signatures pass through unchanged owning76 cryptography, but SQL replies are synthetic and qualify no PostgreSQL backend cleanup.",
    "Cancellation attempts and acknowledgements are counted separately. Unacknowledged release/cancel remains unverified; no retry or provider no-effect assertion.",
    "The Workers runtime is local and zero-egress; hosted secret custody, deployment, browser-engine cookie enforcement and merchant activation remain unqualified.",
  ],
};
const text = JSON.stringify(report, null, 2) + "\n";
for (const secret of [
  issued.token,
  issued.code,
  verifier,
  issued.claims.sub,
  issued.claims.sid,
  ...oracle.secrets,
  "worker_management_marker_86_only",
])
  assert.ok(!text.includes(secret), "private fixture material is not reported");
mkdirSync("docs/evidence/P05.T01t/regressions", { recursive: true });
writeFileSync("docs/evidence/P05.T01t/regressions/fixed-provider-workers.json", text);
console.log(
  `PASS: ${cases.length} fixed WorkOS provider Workers cases; ${result.checks.length} checks; zero outbound requests; runtime disposed.`,
);
