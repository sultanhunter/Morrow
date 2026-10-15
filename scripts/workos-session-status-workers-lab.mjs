import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const now = Date.UTC(2026, 9, 15, 12, 0, 0);
const profile = {
  schemaVersion: 1,
  providerId: "workos",
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  revision: 1,
};
const subjectId = "user_" + "D".repeat(26);
const targetId = "session_" + "E".repeat(26);
const otherId = "session_" + "F".repeat(26);
const query = { schemaVersion: 1, subjectId, providerSessionId: targetId };
const session = (change = {}) => ({
  object: "session",
  id: targetId,
  user_id: subjectId,
  status: "active",
  auth_method: "oauth",
  expires_at: new Date(now + 120000).toISOString(),
  ended_at: null,
  created_at: new Date(now - 60000).toISOString(),
  updated_at: new Date(now - 1000).toISOString(),
  ...change,
});
const page = (data = [], after = null) =>
  JSON.stringify({ object: "list", data, list_metadata: { before: null, after } });
const cases = [];
const add = (name, pages, expected = "held", options = {}) =>
  cases.push({
    name,
    profileJson: JSON.stringify(profile),
    queryJson: JSON.stringify(query),
    now,
    pages,
    expected,
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
  add("human_method_" + method, [page([session({ auth_method: method })])], "observed_active");
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
  "observed_active",
);
add(
  "normal_target_then_valid_impersonated_row",
  [
    page([session()], targetId),
    page([
      session({
        id: otherId,
        auth_method: "impersonation",
        impersonator: { email: "synthetic@example.test", reason: null },
      }),
    ]),
  ],
  "observed_active",
  { expectedReads: 2 },
);
add(
  "unrelated_unknown_method_then_normal_target",
  [page([session({ id: otherId, auth_method: "unknown" })], otherId), page([session()])],
  "observed_active",
  { expectedReads: 2 },
);
add(
  "later_malformed_impersonator_holds_early_match",
  [
    page([session()], targetId),
    page([
      session({
        id: otherId,
        auth_method: "impersonation",
        impersonator: { email: "synthetic@example.test", reason: 7 },
      }),
    ]),
  ],
  "held",
  { expectedReads: 2 },
);
add(
  "complete_only_unrelated_impersonated_is_not_revoked",
  [
    page([
      session({
        id: otherId,
        auth_method: "impersonation",
        impersonator: { email: "synthetic@example.test", reason: null },
      }),
    ]),
  ],
  "not_observed_active",
);
add("complete_active", [page([session()])], "observed_active", { later: now + 5000 });
add("complete_empty_is_not_observed_active", [page()], "not_observed_active", {
  later: now + 5000,
});
add(
  "complete_unrelated_active_is_not_revoked",
  [page([session({ id: otherId })])],
  "not_observed_active",
);
add(
  "matching_first_page_requires_complete_second",
  [page([session()], targetId), page([session({ id: otherId })])],
  "observed_active",
  { expectedReads: 2 },
);
add(
  "matching_second_page",
  [page([session({ id: otherId })], otherId), page([session()])],
  "observed_active",
  { expectedReads: 2 },
);
add("later_page_error_holds_early_match", [page([session()], targetId), "{}"], "held", {
  expectedReads: 2,
});
add(
  "target_expiry_caps_lease",
  [page([session({ expires_at: new Date(now + 1000).toISOString() })])],
  "observed_active",
  { later: now + 1000 },
);
for (const [name, change] of Object.entries({
  wrong_user: { user_id: "user_" + "Z".repeat(26) },
  revoked_status: { status: "revoked" },
  ended: { ended_at: new Date(now - 100).toISOString() },
  expired: { expires_at: new Date(now).toISOString() },
  future_update: { updated_at: new Date(now + 1).toISOString() },
  malformed_date: { expires_at: "2026-02-30T00:00:00.000Z" },
  client_assertion: { client_id: profile.clientId },
  impersonated_target: { impersonator: { email: "synthetic@example.test", reason: "synthetic" } },
}))
  add(name, [page([session(change)])]);
add("duplicate_same_page", [page([session(), session()])]);
add("duplicate_cross_page", [page([session()], targetId), page([session()])], "held", {
  expectedReads: 2,
});
add("empty_page_with_cursor", [page([], targetId)]);
add(
  "repeating_cursor",
  [page([session()], targetId), page([session({ id: otherId })], targetId)],
  "held",
  { expectedReads: 2 },
);
add(
  "fifth_page_denied",
  ["G", "H", "I", "J"].map((x) =>
    page([session({ id: "session_" + x.repeat(26) })], "session_" + x.repeat(26)),
  ),
  "held",
  { expectedReads: 4 },
);
add("page_over_100_items", [page(Array.from({ length: 101 }, () => session()))]);
add("oversized_raw_page", [" ".repeat(131073)]);
add("duplicate_decoded_json_member", [
  '{"object":"list","data":[],"list_metadata":{"before":null,"after":null,"a\\u0066ter":null}}',
]);
add("escaped_unpaired_utf16", [
  '{"object":"list","data":[],"list_metadata":{"before":null,"after":null},"extra":"\\ud800"}',
]);
add("untrusted_object_page", [
  { object: "list", data: [], list_metadata: { before: null, after: null } },
]);
add("unexpected_catalogue_shape", [
  '{"object":"list","data":[],"list_metadata":{"before":null,"after":null},"url":"https://foreign.invalid"}',
]);
add("untrusted_object_query", [], "held", { queryJson: query, expectedReads: 0 });
add("untrusted_object_profile", [], "held", {
  profileJson: profile,
  expectedReads: 0,
  expectedConfigDenial: true,
});
add("extra_query_authority", [], "held", {
  queryJson: JSON.stringify({ ...query, role: "admin" }),
  expectedReads: 0,
});
for (const mode of [
  "throw",
  "profile_drift",
  "clock_backward",
  "deadline",
  "lease_elapsed",
  "cancel",
  "stall_abort",
])
  add(mode, [page([session()])], "held", { mode });

const bundle = await build({
  entryPoints: ["scripts/fixtures/workos-session-status-worker.ts"],
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
  const response = await runtime.dispatchFetch("http://morrow.local/synthetic-session-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cases }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(Array.isArray(result.checks));
  assert.equal(new Set(result.checks.map((check) => check.name)).size, result.checks.length);
  for (const c of cases) {
    assert.equal(
      result.checks.filter((check) => check.name === c.name).length,
      1,
      c.name + " terminal anchor",
    );
    assert.equal(
      result.checks.filter((check) => check.name === c.name + "_read_budget").length,
      1,
      c.name + " read budget anchor",
    );
    if (!c.expectedConfigDenial) {
      assert.equal(
        result.checks.filter((check) => check.name === c.name + "_closed_result").length,
        1,
        c.name + " result shape anchor",
      );
      if (c.expected === "held")
        assert.equal(
          result.checks.filter((check) => check.name === c.name + "_no_handle").length,
          1,
          c.name + " held shape anchor",
        );
    }
  }
  for (const check of result.checks) assert.equal(check.passed, true, check.name);
  assert.equal(outbound, 0);
  result.checks.push({ name: "zero_outbound_requests", passed: true });
  const paths = [
    "packages/identity/src/workos-session-status.ts",
    "packages/identity/src/workos-session-status-json.ts",
    "packages/identity/package.json",
    "scripts/fixtures/workos-session-status-worker.ts",
    "scripts/workos-session-status-workers-lab.mjs",
    "package-lock.json",
  ];
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  mkdirSync("docs/evidence/P05.T01k", { recursive: true });
  writeFileSync(
    "docs/evidence/P05.T01k/reader-workers-lab.json",
    JSON.stringify(
      {
        task: "P05.T01k",
        boundary: "reader",
        selected_policy_sequence: 78,
        canonical_sequence: JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan
          .sequence,
        observed_at: new Date().toISOString(),
        scope:
          "Actual pinned local workerd qualifying canonical78 selected human-session policy with fake paginated session pages only; no credential, provider network, local identity/session/grant or merchant access",
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
    `WorkOS session observations: ${cases.length} cases/${result.checks.length} actual Workers checks passed; zero outbound requests.`,
  );
} finally {
  await runtime.dispose();
}
