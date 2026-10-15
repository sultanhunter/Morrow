import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const now = Date.UTC(2026, 9, 15, 15, 0, 0);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
const key = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "synthetic-selection",
  alg: "RS256",
  use: "sig",
};
const subject = "user_" + "D".repeat(26),
  session = "session_" + "E".repeat(26);
const profile = {
  schemaVersion: 1,
  providerId: "workos",
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  issuer: "https://api.workos.com/user_management/client_" + "C".repeat(26),
  revision: 3,
  audiencePolicy: "absent",
};
const role = {
  role: "morrow_identity_resolution",
  login: "morrow_identity_resolution",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
};
const row = {
  profile_id: "verification-profile-A",
  profile_record_revision: "19",
  mapping_id: "provider-mapping-A",
  mapping_revision: "7",
  binding_revision: "11",
  principal_id: "human-principal-A",
  organization_id: "organization-A",
  workspace_id: "workspace-A",
  membership_id: "membership-A",
  policy_revision: "23",
};
const rowB = {
  ...row,
  organization_id: "organization-B",
  workspace_id: "workspace-B",
  membership_id: "membership-B",
  policy_revision: "29",
};
const sequence = ["begin", "role", "timeout", "idleTimeout", "resolve", "resolve", "commit"];
const snapshotValue = (p, lease = 299000) => ({
  schemaVersion: 1,
  profileRevision: p.revision,
  environmentId: p.environmentId,
  applicationId: p.applicationId,
  clientId: p.clientId,
  observedAtMs: now - 1000,
  expiresAtMs: now + lease,
  jwks: { keys: [key] },
});
function signedToken(p) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: p.issuer,
      client_id: p.clientId,
      sub: subject,
      sid: session,
      iat: now / 1000 - 10,
      exp: now / 1000 + 120,
      org_id: "org_" + "Z".repeat(26),
      roles: ["owner"],
      permissions: ["all"],
    }),
  ).toString("base64url");
  const content = head + "." + payload;
  const signature = sign("RSA-SHA256", Buffer.from(content), pair.privateKey);
  assert.equal(verify("RSA-SHA256", Buffer.from(content), pair.publicKey, signature), true);
  return content + "." + signature.toString("base64url");
}
const page = JSON.stringify({
  object: "list",
  data: [
    {
      object: "session",
      id: session,
      user_id: subject,
      status: "active",
      auth_method: "oauth",
      ended_at: null,
      expires_at: new Date(now + 120000).toISOString(),
      created_at: new Date(now - 60000).toISOString(),
      updated_at: new Date(now - 1000).toISOString(),
    },
  ],
  list_metadata: { before: null, after: null },
});
function expectedSelection(r, expires = now + 5000) {
  return {
    kind: "private_workspace_selection",
    profileId: r.profile_id,
    profileRecordRevision: Number(r.profile_record_revision),
    mappingId: r.mapping_id,
    mappingRevision: Number(r.mapping_revision),
    bindingRevision: Number(r.binding_revision),
    principalId: r.principal_id,
    organizationId: r.organization_id,
    workspaceId: r.workspace_id,
    membershipId: r.membership_id,
    policyRevision: Number(r.policy_revision),
    observedAtMs: now,
    evidenceExpiresAtMs: expires,
  };
}
const cases = [];
function make(name, options = {}) {
  const p = options.profile ?? profile,
    r = options.row ?? row;
  const lease = options.shortLease ? 40 : 299000;
  const profileJson = JSON.stringify(p),
    snapshotJson = JSON.stringify(snapshotValue(p, lease));
  const observationJson = JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: p.environmentId,
    applicationId: p.applicationId,
    clientId: p.clientId,
    revision: p.revision,
  });
  const expires = now + Math.min(5000, lease);
  const expected = options.expected ?? "selected";
  return {
    name,
    profileJson,
    snapshotJson,
    token: signedToken(p),
    page,
    pages: [page],
    expectedPageReads: 1,
    expectedEvidence: "verified_active_evidence",
    now,
    evidenceExpiresAtMs: expires,
    profileDigest: sha(profileJson),
    keySetDigest: sha(snapshotJson),
    observationDigest: sha(observationJson),
    args: [
      "workos",
      p.environmentId,
      p.applicationId,
      p.clientId,
      p.issuer,
      String(p.revision),
      sha(profileJson),
      subject,
      r.workspace_id,
    ],
    selector: JSON.stringify({ schemaVersion: 1, workspaceId: r.workspace_id }),
    rows: [[r], [r]],
    roleRows: [role],
    expected,
    expectedSelection: expected === "selected" ? expectedSelection(r, expires) : null,
    expectedConnects: 1,
    expectedLookups: 2,
    expectedReleases: 1,
    expectedQueryPrefix: sequence,
    ...options,
  };
}
const add = (name, options = {}) => cases.push(make(name, options));
// Drive the maintained reader through the unchanged composition and selector.
// Negative evidence must terminate before even acquiring a SQL connection.
const policyPage = (change = {}, after = null) => {
  const value = JSON.parse(page);
  Object.assign(value.data[0], change);
  value.list_metadata.after = after;
  return JSON.stringify(value);
};
const unrelatedSession = "session_" + "Y".repeat(26);
for (const method of [
  "cross_app_auth",
  "external_auth",
  "magic_code",
  "migrated_session",
  "oauth",
  "passkey",
  "password",
  "sso",
])
  add("human_method_selects_" + method, { pages: [policyPage({ auth_method: method })] });
const noEvidence = {
  expected: "held",
  expectedEvidence: "held",
  expectedConnects: 0,
  expectedLookups: 0,
  expectedReleases: 0,
  expectedQueryPrefix: [],
};
for (const [name, change] of Object.entries({
  missing: { auth_method: undefined },
  null: { auth_method: null },
  unknown: { auth_method: "unknown" },
  new_method: { auth_method: "future_method" },
  wrong_case: { auth_method: "OAuth" },
  leading_space: { auth_method: " oauth" },
  trailing_space: { auth_method: "oauth " },
  impersonation_absent_metadata: { auth_method: "impersonation" },
  impersonation_null_metadata: { auth_method: "impersonation", impersonator: null },
  normal_with_impersonator_null_reason: {
    impersonator: { email: "synthetic@example.test", reason: null },
  },
  normal_with_impersonator_string_reason: {
    impersonator: { email: "synthetic@example.test", reason: "synthetic" },
  },
  impersonation_with_impersonator_null_reason: {
    auth_method: "impersonation",
    impersonator: { email: "synthetic@example.test", reason: null },
  },
}))
  add("policy_held_zero_sql_" + name, { ...noEvidence, pages: [policyPage(change)] });
add("normal_null_impersonator_selects", { pages: [policyPage({ impersonator: null })] });
add("normal_target_then_valid_impersonated_row_selects", {
  pages: [
    policyPage({}, session),
    policyPage({
      id: unrelatedSession,
      auth_method: "impersonation",
      impersonator: { email: "synthetic@example.test", reason: null },
    }),
  ],
  expectedPageReads: 2,
});
add("unrelated_unknown_then_normal_target_selects", {
  pages: [policyPage({ id: unrelatedSession, auth_method: "unknown" }, unrelatedSession), page],
  expectedPageReads: 2,
});
add("later_malformed_row_holds_evidence_zero_sql", {
  ...noEvidence,
  expectedPageReads: 2,
  pages: [
    policyPage({}, session),
    policyPage({
      id: unrelatedSession,
      auth_method: "impersonation",
      impersonator: { email: "synthetic@example.test", reason: 7 },
    }),
  ],
});
add("complete_target_miss_holds_evidence_zero_sql", {
  ...noEvidence,
  pages: [
    policyPage({
      id: unrelatedSession,
      auth_method: "impersonation",
      impersonator: { email: "synthetic@example.test", reason: null },
    }),
  ],
});
add("exact_private_snapshot", { advanceAfter: true });
add("selected_second_organization", { row: rowB });
add("safe_integer_revision_limit", {
  row: {
    ...row,
    profile_record_revision: String(Number.MAX_SAFE_INTEGER),
    mapping_revision: String(Number.MAX_SAFE_INTEGER),
    binding_revision: String(Number.MAX_SAFE_INTEGER),
    policy_revision: String(Number.MAX_SAFE_INTEGER),
  },
});
const clientTwo = {
  ...profile,
  applicationId: "app_" + "F".repeat(26),
  clientId: "client_" + "G".repeat(26),
  issuer: "https://api.workos.com/user_management/client_" + "G".repeat(26),
};
add("second_explicit_profile_same_principal", {
  profile: clientTwo,
  row: { ...row, profile_id: "verification-profile-B", profile_record_revision: "31" },
});
add("unbound_profile_has_no_selection", {
  profile: {
    ...clientTwo,
    clientId: "client_" + "H".repeat(26),
    issuer: "https://api.workos.com/user_management/client_" + "H".repeat(26),
  },
  expected: "held",
  rows: [[]],
  expectedLookups: 1,
  expectedQueryPrefix: sequence.slice(0, 5),
});
add("foreign_workspace_has_no_selection", {
  row: { ...row, workspace_id: "foreign-workspace" },
  expected: "held",
  rows: [[]],
  expectedLookups: 1,
  expectedQueryPrefix: sequence.slice(0, 5),
});
add("second_environment_is_exact_parameter", {
  profile: { ...profile, environmentId: "environment_" + "J".repeat(26) },
  row: {
    ...row,
    profile_id: "verification-profile-env-B",
    mapping_id: "provider-mapping-env-B",
    principal_id: "human-principal-B",
  },
});
for (const handleMode of ["forged", "foreign", "serialized", "proxy"])
  add("invalid_handle_" + handleMode, {
    handleMode,
    expected: "held",
    expectedConnects: 0,
    expectedLookups: 0,
    expectedReleases: 0,
    expectedQueryPrefix: [],
  });
for (const [name, selector] of Object.entries({
  object: { schemaVersion: 1, workspaceId: "workspace-A" },
  extra_organization: JSON.stringify({
    schemaVersion: 1,
    workspaceId: "workspace-A",
    organizationId: "organization-B",
  }),
  extra_provider: JSON.stringify({
    schemaVersion: 1,
    workspaceId: "workspace-A",
    clientId: profile.clientId,
  }),
  wrong_schema: '{"schemaVersion":2,"workspaceId":"workspace-A"}',
  duplicate_key: '{"schemaVersion":1,"workspaceId":"workspace-A","workspaceId":"workspace-B"}',
  invalid_id: '{"schemaVersion":1,"workspaceId":"workspace-A;SELECT"}',
  oversized: " ".repeat(2049),
  malformed: "{",
}))
  add("invalid_selector_" + name, {
    selector,
    expected: "held",
    expectedConnects: 0,
    expectedLookups: 0,
    expectedReleases: 0,
    expectedQueryPrefix: [],
  });
add("hostile_selector_zero_reflection", {
  selectorMode: "proxy",
  expected: "held",
  expectedConnects: 0,
  expectedLookups: 0,
  expectedReleases: 0,
  expectedQueryPrefix: [],
});
for (const key of Object.keys(role)) {
  add("unsafe_role_" + key, {
    roleRows: [{ ...role, [key]: typeof role[key] === "string" ? "morrow_identity_api" : true }],
    expected: "held",
    expectedLookups: 0,
    expectedQueryPrefix: sequence.slice(0, 2),
  });
}
for (const [name, roleRows] of Object.entries({
  missing: [],
  duplicate: [role, role],
  extra: [{ ...role, extra: false }],
}))
  add("invalid_role_rows_" + name, {
    roleRows,
    expected: "held",
    expectedLookups: 0,
    expectedQueryPrefix: sequence.slice(0, 2),
  });
const missing = { ...row };
delete missing.membership_id;
for (const [name, badRows] of Object.entries({
  missing: [],
  duplicate: [row, row],
  extra: [{ ...row, email: "synthetic@example.test" }],
  missing_field: [missing],
  nontext_revision: [{ ...row, policy_revision: 23 }],
  zero_revision: [{ ...row, policy_revision: "0" }],
  leading_zero: [{ ...row, mapping_revision: "07" }],
  unsafe_integer: [{ ...row, binding_revision: "9007199254740992" }],
  negative: [{ ...row, profile_record_revision: "-1" }],
  invalid_id: [{ ...row, principal_id: "invalid principal" }],
  wrong_selected_workspace: [{ ...row, workspace_id: "workspace-B" }],
}))
  add("invalid_selection_rows_" + name, {
    rows: [badRows],
    expected: "held",
    expectedLookups: 1,
    expectedQueryPrefix: sequence.slice(0, 5),
  });
for (const field of Object.keys(row)) {
  const second = {
    ...row,
    [field]: field.endsWith("revision") ? String(Number(row[field]) + 1) : row[field] + "-changed",
  };
  add("second_lookup_drift_" + field, {
    rows: [[row], [second]],
    expected: "held",
    expectedQueryPrefix: sequence.slice(0, 6),
  });
}
const stages = [
  "before",
  "connect",
  "begin",
  "role",
  "timeout",
  "idleTimeout",
  "resolve1",
  "resolve2",
  "commit",
  "release",
];
for (const stage of stages) {
  const queryCount = Math.max(0, stages.indexOf(stage) - 1);
  for (const kind of ["expiry", "profile", "cancel"])
    add(kind + "_during_" + stage, {
      fault: { stage, kind },
      expected: "held",
      expectedConnects: stage === "before" ? 0 : 1,
      expectedReleases: stage === "before" ? 0 : 1,
      expectedLookups: Math.min(2, Math.max(0, queryCount - 4)),
      expectedQueryPrefix: sequence.slice(0, queryCount),
    });
}
add("clock_backward_after_query", {
  fault: { stage: "resolve1", kind: "backward" },
  expected: "held",
  expectedLookups: 1,
  expectedQueryPrefix: sequence.slice(0, 5),
});
add("connection_error_is_held", {
  fault: { stage: "connect", kind: "throw" },
  expected: "held",
  expectedLookups: 0,
  expectedReleases: 0,
  expectedQueryPrefix: [],
});
add("query_error_has_no_followup_sql", {
  fault: { stage: "resolve1", kind: "throw" },
  expected: "held",
  expectedLookups: 1,
  expectedQueryPrefix: sequence.slice(0, 5),
});
add("completed_denial_then_rollback_error_is_held", {
  rows: [[]],
  fault: { stage: "rollback", kind: "throw" },
  expected: "held",
  expectedLookups: 1,
  expectedQueryPrefix: sequence.slice(0, 5),
  expectedRollbacks: 1,
});
for (const rowMode of ["accessor", "array_accessor", "symbol", "sparse", "outer_accessor"])
  add("closed_sql_row_" + rowMode, {
    rowMode,
    expected: "held",
    expectedLookups: 1,
    expectedQueryPrefix: sequence.slice(0, 5),
  });
add("release_error_cannot_return_snapshot", {
  fault: { stage: "release", kind: "throw" },
  expected: "held",
});
add("commit_ack_loss_cannot_return_snapshot", {
  fault: { stage: "commit", kind: "throw" },
  expected: "held",
});
add("deadline_late_connection_destroyed", {
  shortLease: true,
  fault: { stage: "connect", kind: "late" },
  expected: "held",
  expectedLookups: 0,
  expectedQueryPrefix: [],
});
add("deadline_query_aborted_and_destroyed", {
  shortLease: true,
  fault: { stage: "resolve1", kind: "stall" },
  expected: "held",
  expectedLookups: 1,
  expectedQueryPrefix: sequence.slice(0, 5),
});
add("release_must_finish_before_success", { fault: { stage: "release", kind: "delay" } });
add("deadline_release_cannot_return_snapshot", {
  shortLease: true,
  fault: { stage: "release", kind: "delay" },
  expected: "held",
});
for (const c of cases)
  c.expectedRollbacks ??=
    c.expected === "held" && !c.fault && c.expectedQueryPrefix.length > 0 ? 1 : 0;
const isolation = [make("isolation_A"), make("isolation_B", { row: rowB })];
const required = [
  "page_selector",
  "owned_evidence",
  "independent_provenance",
  "outcome",
  "closed_result",
  "exact_selection",
  "connection_budget",
  "fixed_query_order",
  "exact_parameters",
  "bounded_controls",
  "discarded_cleanup",
  "fault_exercised",
  "hostile_objects_unobserved",
  "late_results_closed",
];
const expectedNames = cases.flatMap((c) => [
  ...required.map((suffix) => c.name + "_" + suffix),
  ...(c.advanceAfter ? [c.name + "_snapshot_is_historical"] : []),
  ...(c.expectedEvidence === "held" ? [c.name + "_held_evidence_zero_sql"] : []),
]);
expectedNames.push(
  "two_organizations_same_owned_evidence",
  "two_organizations_exact_independent_results",
);
assert.equal(new Set(expectedNames).size, expectedNames.length);
const bundle = await build({
  entryPoints: ["scripts/fixtures/workos-workspace-selection-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  metafile: true,
});
assert.equal(
  Object.values(bundle.metafile.outputs).some((output) => output.imports.length),
  false,
);
let outbound = 0;
const runtime = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  log: new Log(LogLevel.ERROR),
  outboundService: () => {
    outbound++;
    return new Response(null, { status: 502 });
  },
});
try {
  const response = await runtime.dispatchFetch(
    "http://morrow.local/synthetic-workspace-selection",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cases, isolation }),
    },
  );
  assert.equal(response.status, 200);
  const raw = await response.text();
  const result = JSON.parse(raw);
  assert.deepEqual(Object.keys(result), ["checks"]);
  assert.ok(Array.isArray(result.checks));
  assert.deepEqual(result.checks.map((check) => check.name).sort(), [...expectedNames].sort());
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check).sort(), ["name", "passed"]);
    assert.equal(check.passed, true, check.name);
  }
  // Public evidence contains only fixed check names/booleans, never material
  // from the signed token, provider page, SQL selector or private snapshot.
  for (const secret of [
    subject,
    session,
    profile.clientId,
    ...Object.values(row).filter((v) => !/^\d+$/.test(v)),
    cases[0].token,
    cases[0].profileDigest,
  ])
    assert.equal(raw.includes(secret), false);
  assert.equal(outbound, 0);
  result.checks.push({ name: "zero_outbound_requests", passed: true });
  const paths = [
    "packages/identity/src/workos-workspace-selection.ts",
    "packages/identity/src/workos-authentication-evidence.ts",
    "packages/identity/src/workos-session-token.ts",
    "packages/identity/src/workos-session-status.ts",
    "packages/identity/src/workos-session-status-json.ts",
    "packages/identity/package.json",
    "scripts/fixtures/workos-workspace-selection-worker.ts",
    "scripts/workos-workspace-selection-workers-lab.mjs",
    "package-lock.json",
  ];
  mkdirSync("docs/evidence/P05.T01m", { recursive: true });
  writeFileSync(
    "docs/evidence/P05.T01m/legacy-selection-workers-lab.json",
    JSON.stringify(
      {
        task: "P05.T01k",
        boundary: "selection",
        selected_policy_sequence: 78,
        canonical_sequence: JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan
          .sequence,
        observed_at: new Date().toISOString(),
        scope:
          "Actual pinned local workerd qualifying canonical78 selected human-session policy with native-RSA-signed synthetic tokens, owning T01i evidence and fixed injected SQL clients. SQL eligibility/constraints are qualified separately in PostgreSQL. Private selection snapshots are nonauthorizing historical observations; no provider, production adapter, session or merchant access.",
        runtime: "miniflare4.20260730.0",
        compatibility_date: "2026-07-30",
        cases: cases.length + 1,
        outbound_requests: outbound,
        bundle_sha256: sha(bundle.outputFiles[0].text),
        input_digests: Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))])),
        checks: result.checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "WorkOS workspace selection: " +
      (cases.length + 1) +
      " cases/" +
      result.checks.length +
      " actual Workers checks passed; zero outbound requests.",
  );
} finally {
  await runtime.dispose();
}
