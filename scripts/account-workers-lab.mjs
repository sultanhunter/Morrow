import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { buildWorkosAuthenticationEvidenceFixture } from "../tests/fixtures/workos-authentication-evidence.mjs";
import {
  acceptedNames,
  invalidNames,
  typescriptOnlyInvalidNames,
} from "../tests/fixtures/account-display-names.mjs";
import { writeArtifact } from "./artifacts.mjs";

// P05.T01x Part B in actual local workerd: account login start and callback (AC06),
// impersonation (AC15), the account route envelope (AC28/AC29), list and signup with a
// synthetic stateful SQL port and injected faults (AC17, AC19, AC22, AC23, AC25), display
// names under workerd ICU (AC30), session states (AC31) and the unconfigured default
// (AC38). Zero outbound requests; the PostgreSQL 17 laboratory owns the SQL semantics.
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixture = buildWorkosAuthenticationEvidenceFixture();
const impersonatedPage = fixture.page([
  fixture.session({ impersonator: { email: "support@example.test", reason: null } }),
]);
const paths = [
  "packages/identity/src/account-onboarding.ts",
  "packages/identity/src/fixed-sql-transaction.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/standalone-login.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/managed-workspace-api.ts",
  "packages/identity/src/managed-workspace-request.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "apps/api/src/worker.ts",
  "scripts/fixtures/account-worker.ts",
  "scripts/fixtures/standalone-login-fixture.ts",
  "scripts/account-workers-lab.mjs",
  "tests/fixtures/account-display-names.mjs",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "package-lock.json",
];
const sourceDigests = Object.fromEntries(
  paths.sort().map((path) => [path, hash(readFileSync(path))]),
);
const bundled = await build({
  entryPoints: ["scripts/fixtures/account-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*"],
  metafile: true,
});
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
  const response = await mf.dispatchFetch("http://localhost/synthetic-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      at: fixture.at,
      profile: fixture.profile,
      profileJson: fixture.profileJson,
      snapshotJson: fixture.snapshotJson,
      token: fixture.token,
      page: fixture.page(),
      impersonatedPage,
      invalidNames: [...invalidNames, ...typescriptOnlyInvalidNames],
      acceptedNames,
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(new Set(result.checks.map((c) => c.name)).size, result.checks.length);
  const failed = result.checks.filter((c) => c.passed !== true);
  if (failed.length) console.error("ACCOUNT_WORKERS_LAB_FAILED " + JSON.stringify(failed));
  assert.deepEqual(failed, []);
  assert.equal(outbound, 0);
  for (const [path, digest] of Object.entries(sourceDigests))
    assert.equal(hash(readFileSync(path)), digest, "Source changed: " + path);
  const report = {
    task: "P05.T01x",
    part: "B",
    qualification:
      "actual_local_workerd_account_login_guard_list_signup_with_synthetic_SQL_and_independent_native_RSA",
    acceptance: [6, 15, 17, 19, 22, 23, 25, 28, 29, 30, 31, 38].map(
      (n) => "P05.T01x-AC" + String(n).padStart(2, "0"),
    ),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    observedAt: new Date().toISOString(),
    checks: result.checks,
    store: result.store,
    loginStatements: result.loginStatements,
    outboundRequests: outbound,
    source_digests: sourceDigests,
    source_inventory_digest: hash(JSON.stringify(Object.entries(sourceDigests))),
    limitations: [
      "The account SQL port here is a synthetic state machine; PostgreSQL 17 semantics, locks and privileges are in lab:account-onboarding.",
      "The managed entry's broker-lease failure and routing are unit cases (tests/managed-workspace-api.test.mjs); the PG-wire journey runs in the Linux pgwire job.",
      "No native provider, hosted key, deployment or real user.",
    ],
  };
  const publicText = JSON.stringify(report, null, 2) + "\n";
  for (const secret of [fixture.token, fixture.claims.sub, fixture.claims.sid, "synthetic-code"])
    assert.ok(!publicText.includes(secret));
  writeArtifact("labs/account-workers.json", publicText);
  console.log(
    `PASS: account Workers laboratory; ${result.checks.length} checks; zero outbound requests.`,
  );
} finally {
  await mf.dispose();
}
