import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { writeArtifact } from "./artifacts.mjs";
const now = 1800000000000,
  hash = (value) => createHash("sha256").update(value).digest("hex");
const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
const key = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "independent-browser-session-admission",
  alg: "RS256",
  use: "sig",
};
const id = (prefix, n) => `${prefix}_${String(n).padStart(26, "0")}`;
const profile = {
  schemaVersion: 1,
  providerId: "workos",
  environmentId: id("environment", 1),
  applicationId: id("app", 2),
  clientId: id("client", 3),
  issuer: `https://api.workos.com/user_management/${id("client", 3)}`,
  revision: 1,
  audiencePolicy: "absent",
};
const claims = {
  iss: profile.issuer,
  client_id: profile.clientId,
  sub: id("user", 4),
  sid: id("session", 5),
  iat: now / 1000 - 5,
  exp: now / 1000 + 120,
  org_id: id("org", 9),
  roles: ["owner"],
};
const segment = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
const content = segment({ alg: "RS256", kid: key.kid, typ: "JWT" }) + "." + segment(claims);
const signature = sign("RSA-SHA256", Buffer.from(content), pair.privateKey);
assert.equal(verify("RSA-SHA256", Buffer.from(content), pair.publicKey, signature), true);
const token = content + "." + signature.toString("base64url");
const selector = {
  schemaVersion: 1,
  commandId: "234fde9e-33af-4894-80c1-d36d296eaf57",
  workspaceId: "workspace_A",
  profileId: "profile_A",
  profileRecordRevision: 2,
  mappingId: "mapping_A",
  mappingRevision: 3,
  bindingRevision: 4,
  membershipId: "membership_A",
  policyRevision: 5,
};
const page = JSON.stringify({
  object: "list",
  data: [
    {
      object: "session",
      id: claims.sid,
      user_id: claims.sub,
      status: "active",
      auth_method: "oauth",
      ended_at: null,
      created_at: new Date(now - 60000).toISOString(),
      updated_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 60000).toISOString(),
    },
  ],
  list_metadata: { before: null, after: null },
});
const make = (name, options = {}) => ({
  name,
  profileJson: JSON.stringify(profile),
  snapshotJson: JSON.stringify({
    schemaVersion: 1,
    profileRevision: 1,
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    observedAtMs: now - 1000,
    expiresAtMs: now + (options.shortLease ? 80 : 299000),
    jwks: { keys: [key] },
  }),
  token,
  page,
  now,
  selector: JSON.stringify(selector),
  expected: "newly_admitted",
  ...options,
});
const cases = [
  make("private_admission"),
  make("readonly_terminal_attribution", { mode: "reconcile" }),
];
for (const mode of ["foreign", "forged", "serialized", "expired", "selector_proxy", "handle_proxy"])
  cases.push(make(mode + "_evidence_denied", { mode, expected: "held" }));
for (const [name, change] of Object.entries({
  extra: { secret: "forbidden" },
  zero: { policyRevision: 0 },
  wrong_version: { schemaVersion: 2 },
  bad_command: { commandId: "foreign" },
}))
  cases.push(
    make("invalid_selector_" + name, {
      mode: "invalid_selector",
      selector: JSON.stringify({ ...selector, ...change }),
      expected: "held",
    }),
  );
for (const key of [
  "rolsuper",
  "rolbypassrls",
  "rolcreatedb",
  "rolcreaterole",
  "rolreplication",
  "rolinherit",
  "owner_member",
  "role_member",
])
  cases.push(make("unsafe_role_" + key, { role: { [key]: true }, expected: "held" }));
for (const stage of [
  "connect",
  "begin",
  "role",
  "timeout",
  "idleTimeout",
  "admit",
  "commit",
  "release",
])
  cases.push(make("expiry_after_" + stage, { stage, kind: "expiry", expected: "held" }));
for (const stage of ["begin", "admit", "commit", "release"])
  cases.push(make("unknown_" + stage, { stage, kind: "throw", expected: "held" }));
for (const kind of ["profile", "clock", "cancel"])
  cases.push(make("changed_" + kind, { stage: "admit", kind, expected: "held" }));
for (const row of [
  { outcome: "replayed" },
  { family_id: null },
  { generation_id: "foreign" },
  { expires_at_ms: String(now + 900001) },
  { outcome: "denied" },
])
  cases.push(make("malformed_reply_" + cases.length, { row, expected: "held" }));
cases.push(
  make("row_accessor_zero_getters", { mode: "row_accessor", expected: "held" }),
  make("late_connection_disposal", {
    stage: "connect",
    kind: "late",
    shortLease: true,
    expected: "held",
  }),
  make("never_settled_release", {
    stage: "release",
    kind: "stall",
    shortLease: true,
    expected: "held",
  }),
);
const paths = [
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "scripts/fixtures/workos-browser-session-admission-worker.ts",
  "scripts/workos-browser-session-admission-workers-lab.mjs",
  "tests/workos-browser-session-admission.test.mjs",
  ".nvmrc",
  "package-lock.json",
];
const sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(readFileSync(p))]));
const bundled = await build({
  entryPoints: ["scripts/fixtures/workos-browser-session-admission-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
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
  const response = await mf.dispatchFetch("http://localhost/synthetic-browser-session-admission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cases }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(new Set(result.checks.map((c) => c.name)).size, result.checks.length);
  assert.deepEqual(
    result.checks.filter((c) => c.passed !== true),
    [],
  );
  assert.equal(outbound, 0);
  assert.equal(result.metrics.length, cases.length);
  for (const [p, d] of Object.entries(sourceDigests)) assert.equal(hash(readFileSync(p)), d);
  writeArtifact(
    "labs/browser-session-admission-workers.json",
    JSON.stringify(
      {
        task: "P05.T01m",
        canonicalSequence: 81,
        qualification: "actual_local_workerd_with_independent_native_RSA_and_synthetic_SQL",
        observedAt: new Date().toISOString(),
        cases: cases.length,
        checks: result.checks,
        outboundRequests: outbound,
        metrics: result.metrics,
        sourceDigests,
        limitations: [
          "Synthetic SQL replies are not PostgreSQL qualification.",
          "No provider credential, cookie, public route, hosted migration or merchant activation.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: ${cases.length} browser-session admission Workers cases; ${result.checks.length} checks; zero outbound requests.`,
  );
} finally {
  await mf.dispose();
}
