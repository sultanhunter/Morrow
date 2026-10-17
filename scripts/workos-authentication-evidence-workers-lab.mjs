import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { writeArtifact } from "./artifacts.mjs";

const now = Date.UTC(2026, 9, 15, 14, 0, 0);
const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
const key = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "synthetic-composition",
  alg: "RS256",
  use: "sig",
};
const profile = {
  schemaVersion: 1,
  providerId: "workos",
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  issuer: "https://api.workos.com/user_management/client_" + "C".repeat(26),
  revision: 1,
  audiencePolicy: "absent",
};
const snapshot = {
  schemaVersion: 1,
  profileRevision: 1,
  environmentId: profile.environmentId,
  applicationId: profile.applicationId,
  clientId: profile.clientId,
  observedAtMs: now - 1000,
  expiresAtMs: now + 299000,
  jwks: { keys: [key] },
};
const subject = "user_" + "D".repeat(26),
  target = "session_" + "E".repeat(26),
  secondSubject = "user_" + "F".repeat(26),
  secondSession = "session_" + "G".repeat(26);
const claims = {
  iss: profile.issuer,
  client_id: profile.clientId,
  sub: subject,
  sid: target,
  iat: now / 1000 - 10,
  exp: now / 1000 + 120,
};
function token(changes = {}, privateKey = pair.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url");
  const input = header + "." + payload,
    signature = sign("RSA-SHA256", Buffer.from(input), privateKey);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(input),
      privateKey === pair.privateKey ? pair.publicKey : other.publicKey,
      signature,
    ),
    true,
  );
  return input + "." + signature.toString("base64url");
}
const session = (change = {}) => ({
  object: "session",
  id: target,
  user_id: subject,
  status: "active",
  auth_method: "oauth",
  ended_at: null,
  expires_at: new Date(now + 120000).toISOString(),
  created_at: new Date(now - 60000).toISOString(),
  updated_at: new Date(now - 1000).toISOString(),
  ...change,
});
const page = (data = [], after = null) =>
  JSON.stringify({ object: "list", data, list_metadata: { before: null, after } });
const validToken = token();
const cases = [];
const add = (name, pages, expected = "held", options = {}) =>
  cases.push({
    name,
    profileJson: JSON.stringify(profile),
    snapshotJson: JSON.stringify(snapshot),
    token: validToken,
    pages,
    now,
    expected,
    expectedSubjectId: subject,
    expectedSessionId: target,
    expectedReads: 1,
    ...options,
  });
// Independent canonical78 policy cases. The complete catalogue can contain
// other valid impersonated/unknown-method sessions; only the signed target
// must satisfy the conservative recognized-human-method predicate.
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
  add(
    "human_method_" + method,
    [page([session({ auth_method: method })])],
    "verified_active_evidence",
  );
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
  impersonation_with_impersonator_null_reason: {
    auth_method: "impersonation",
    impersonator: { email: "synthetic@example.test", reason: null },
  },
}))
  add("target_policy_" + name, [page([session(change)])]);
add(
  "normal_method_null_impersonator",
  [page([session({ impersonator: null })])],
  "verified_active_evidence",
);
add(
  "normal_target_then_valid_impersonated_row",
  [
    page([session()], target),
    page([
      session({
        id: secondSession,
        auth_method: "impersonation",
        impersonator: { email: "synthetic@example.test", reason: null },
      }),
    ]),
  ],
  "verified_active_evidence",
  { expectedReads: 2 },
);
add(
  "unrelated_unknown_method_then_normal_target",
  [
    page([session({ id: secondSession, auth_method: "unknown" })], secondSession),
    page([session()]),
  ],
  "verified_active_evidence",
  { expectedReads: 2 },
);
add(
  "later_malformed_impersonator_holds_early_match",
  [
    page([session()], target),
    page([
      session({
        id: secondSession,
        auth_method: "impersonation",
        impersonator: { email: "synthetic@example.test", reason: 7 },
      }),
    ]),
  ],
  "held",
  { expectedReads: 2 },
);
add("exact_signed_active_evidence", [page([session()])], "verified_active_evidence", {
  later: now + 5000,
});
add("signed_org_roles_are_not_local_authority", [page([session()])], "verified_active_evidence", {
  token: token({
    org_id: "org_" + "H".repeat(26),
    roles: ["admin"],
    email: "synthetic@example.test",
    permissions: ["all"],
  }),
});
add("complete_miss_held", [page()]);
add("different_session_held", [page([session({ id: secondSession })])]);
add("wrong_user_held", [page([session({ user_id: secondSubject })])], "held", {
  mode: "wrong_user",
});
add(
  "first_match_needs_complete_second_page",
  [page([session()], target), page([session({ id: secondSession })])],
  "verified_active_evidence",
  { expectedReads: 2 },
);
add("late_invalid_page_holds_early_match", [page([session()], target), "{}"], "held", {
  expectedReads: 2,
});
add("duplicate_cross_page_holds", [page([session()], target), page([session()])], "held", {
  expectedReads: 2,
});
add("ended_target_holds", [page([session({ ended_at: new Date(now - 1).toISOString() })])]);
add("impersonated_target_holds", [
  page([session({ impersonator: { email: "synthetic@example.test", reason: "synthetic" } })]),
]);
add("token_expiry_caps_evidence", [page([session()])], "verified_active_evidence", {
  token: token({ exp: now / 1000 + 1 }),
  later: now + 1000,
});
add("keyset_expiry_caps_evidence", [page([session()])], "verified_active_evidence", {
  snapshotJson: JSON.stringify({ ...snapshot, expiresAtMs: now + 1000 }),
  later: now + 1000,
});
add(
  "provider_session_expiry_caps_evidence",
  [page([session({ expires_at: new Date(now + 1000).toISOString() })])],
  "verified_active_evidence",
  { later: now + 1000 },
);
for (const [name, value] of Object.entries({
  wrong_signature: token({}, other.privateKey),
  wrong_client: token({ client_id: "client_" + "Z".repeat(26) }),
  wrong_issuer: token({ iss: "https://foreign.example.test" }),
  expired_token: token({ exp: now / 1000 }),
  nonhuman_subject: token({ sub: "client_" + "Z".repeat(26) }),
  object_token: { verified: true, sub: subject, sid: target },
}))
  add(name, [], "held", { token: value, expectedReads: 0 });
add("object_profile_config_denial", [], "held", {
  profileJson: profile,
  expectedConfigDenial: true,
  expectedReads: 0,
});
add("object_snapshot_config_denial", [], "held", {
  snapshotJson: snapshot,
  expectedConfigDenial: true,
  expectedReads: 0,
});
add("wrong_keyset_environment", [], "held", {
  snapshotJson: JSON.stringify({ ...snapshot, environmentId: "environment_" + "Z".repeat(26) }),
  expectedConfigDenial: true,
  expectedReads: 0,
});
for (const mode of ["profile_drift", "clock_backward", "cancel_page", "stall_abort", "throw_page"])
  add(mode, [page([session()])], "held", { mode });
add("token_expires_during_page", [page([session()])], "held", {
  token: token({ exp: now / 1000 + 1 }),
  mode: "advance_page",
  advanceTo: now + 1000,
});
add("keyset_expires_during_page", [page([session()])], "held", {
  snapshotJson: JSON.stringify({ ...snapshot, expiresAtMs: now + 1000 }),
  mode: "advance_page",
  advanceTo: now + 1000,
});
add("observation_lease_during_page", [page([session()])], "held", {
  mode: "advance_page",
  advanceTo: now + 5000,
});
add("overall_deadline_during_page", [page([session()])], "held", {
  mode: "advance_page",
  advanceTo: now + 10000,
});
for (const mode of ["profile_drift_on_read", "clock_backward_on_read", "cancel_on_read"])
  add(mode, [page([session()])], "verified_active_evidence", { mode });
add("expiry_during_profile_read", [page([session()])], "verified_active_evidence", {
  mode: "expiry_during_profile_read",
  advanceTo: now + 5000,
});
add("token_expires_during_crypto", [], "held", {
  token: token({ exp: now / 1000 + 1 }),
  mode: "advance_crypto",
  advanceTo: now + 1000,
  expectedReads: 0,
});
add("keyset_expires_during_crypto", [], "held", {
  snapshotJson: JSON.stringify({ ...snapshot, expiresAtMs: now + 1000 }),
  mode: "advance_crypto",
  advanceTo: now + 1000,
  expectedReads: 0,
});
add("profile_drift_during_crypto", [], "held", { mode: "profile_drift_crypto", expectedReads: 0 });
add("global_cancel_during_crypto", [], "held", { mode: "cancel_crypto", expectedReads: 0 });
add(
  "completed_operation_can_retain_its_observation_lease",
  [page([session()])],
  "verified_active_evidence",
  { mode: "advance_crypto", advanceTo: now + 8000, readAt: now + 11000, later: now + 13000 },
);
for (const c of cases) {
  const hash = (v) => (typeof v === "string" ? createHash("sha256").update(v).digest("hex") : "");
  const observationProfile = typeof c.profileJson === "string" ? JSON.parse(c.profileJson) : null;
  const signed =
    typeof c.token === "string"
      ? JSON.parse(Buffer.from(c.token.split(".")[1], "base64url").toString("utf8"))
      : null;
  const observedAt = c.mode === "advance_crypto" ? c.advanceTo : c.now;
  const targetExpiry =
    c.expected === "verified_active_evidence"
      ? Math.min(
          ...c.pages.flatMap((p) =>
            JSON.parse(p)
              .data.filter((row) => row.id === c.expectedSessionId)
              .map((row) => Date.parse(row.expires_at)),
          ),
        )
      : Number.MAX_SAFE_INTEGER;
  Object.assign(c, {
    expectedIssuedAtMs: signed?.iat * 1000,
    expectedObservedAtMs: observedAt,
    expectedExpiresAtMs:
      typeof c.snapshotJson === "string"
        ? Math.min(
            signed?.exp * 1000,
            JSON.parse(c.snapshotJson).expiresAtMs,
            observedAt + 5000,
            targetExpiry,
          )
        : 0,
    expectedTokenProfileDigest: hash(c.profileJson),
    expectedKeySetDigest: hash(c.snapshotJson),
    expectedObservationProfileDigest: observationProfile
      ? hash(
          JSON.stringify({
            schemaVersion: 1,
            providerId: "workos",
            environmentId: observationProfile.environmentId,
            applicationId: observationProfile.applicationId,
            clientId: observationProfile.clientId,
            revision: observationProfile.revision,
          }),
        )
      : "",
  });
}
const concurrency = {
  profileJson: JSON.stringify(profile),
  snapshotJson: JSON.stringify(snapshot),
  now,
  firstToken: validToken,
  secondToken: token({ sub: secondSubject, sid: secondSession }),
  firstSubject: subject,
  secondSubject,
  firstPage: page([session()]),
  secondPage: page([session({ id: secondSession, user_id: secondSubject })]),
};
const bundle = await build({
  entryPoints: ["scripts/fixtures/workos-authentication-evidence-worker.ts"],
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
    "http://morrow.local/synthetic-authentication-evidence",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cases, concurrency }),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(Array.isArray(result.checks));
  assert.equal(new Set(result.checks.map((check) => check.name)).size, result.checks.length);
  for (const c of cases) {
    for (const name of [c.name, c.name + "_read_budget"])
      assert.equal(
        result.checks.filter((check) => check.name === name).length,
        1,
        name + " anchor",
      );
    if (!c.expectedConfigDenial) {
      assert.equal(
        result.checks.filter((check) => check.name === c.name + "_closed_result").length,
        1,
        c.name + " result shape",
      );
      if (c.expected === "verified_active_evidence") {
        for (const suffix of [
          "private_frozen_evidence",
          "minimal_evidence_shape",
          "provenance_stays_separate",
          "exact_signed_identity",
          "independent_digest_oracles",
          "exact_time_metadata",
          "successful_handle_survives_cleanup",
          "opaque_handle",
          "serialized_handle",
          "foreign_handle",
        ]) {
          assert.equal(
            result.checks.filter((check) => check.name === c.name + "_" + suffix).length,
            1,
            c.name + "_" + suffix,
          );
        }
      }
      if (c.expected === "held")
        assert.equal(
          result.checks.filter((check) => check.name === c.name + "_no_handle").length,
          1,
          c.name + " held shape",
        );
    }
  }
  for (const name of [
    "concurrency_first_reaches_owned_page",
    "concurrency_second_token_verified",
    "concurrency_first_attempt_deadline_held",
    "concurrency_timeout_does_not_poison_second",
    "concurrency_exact_two_derived_subject_reads",
    "hostile_token_held_without_page",
    "hostile_handle_no_reflection",
    "hostile_profile_denied",
    "hostile_snapshot_denied",
    "zero_hostile_object_traps",
  ])
    assert.equal(result.checks.filter((check) => check.name === name).length, 1, name);
  for (const check of result.checks) assert.equal(check.passed, true, check.name);
  assert.equal(outbound, 0);
  result.checks.push({ name: "zero_outbound_requests", passed: true });
  const paths = [
    "packages/identity/src/workos-authentication-evidence.ts",
    "packages/identity/src/workos-session-token.ts",
    "packages/identity/src/workos-session-status.ts",
    "packages/identity/src/workos-session-status-json.ts",
    "packages/identity/package.json",
    "scripts/fixtures/workos-authentication-evidence-worker.ts",
    "scripts/workos-authentication-evidence-workers-lab.mjs",
    "package-lock.json",
  ];
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  writeArtifact(
    "labs/workos-authentication-evidence-workers.json",
    JSON.stringify(
      {
        task: "P05.T01k",
        boundary: "composition",
        selected_policy_sequence: 78,
        canonical_sequence: JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan
          .sequence,
        observed_at: new Date().toISOString(),
        scope:
          "Actual pinned local workerd qualifying canonical78 selected human-session policy with independently native-RSA-signed fake tokens and synthetic session pages. No provider key, network, local identity/session/grant or merchant access.",
        runtime: "miniflare4.20260730.0",
        compatibility_date: "2026-07-30",
        cases: cases.length,
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
    "WorkOS authentication evidence: " +
      cases.length +
      " cases/" +
      result.checks.length +
      " actual Workers checks passed; zero outbound requests.",
  );
} finally {
  await runtime.dispose();
}
