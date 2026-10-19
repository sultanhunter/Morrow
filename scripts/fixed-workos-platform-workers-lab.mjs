import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import { writeArtifact } from "./artifacts.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
if (process.version !== "v24.13.0") throw Error("PINNED_NODE_REQUIRED");
const paths = [
  "packages/identity/src/fixed-workos-login-port.ts",
  "packages/identity/src/standalone-login.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/executor-role-preflight.ts",
  "packages/identity/src/login-preauth-control.ts",
  "packages/identity/src/login-flow-custody.ts",
  "scripts/fixtures/standalone-login-fixture.ts",
  "scripts/fixtures/fixed-workos-provider.mjs",
  "scripts/fixtures/fixed-workos-platform-provider.mjs",
  "scripts/fixtures/fixed-workos-platform-worker.ts",
  "scripts/fixed-workos-platform-workers-lab.mjs",
  "tests/fixed-workos-platform-provider.test.mjs",
  "package.json",
  "package-lock.json",
  ".github/workflows/ci.yml",
];
const sourceDigests = Object.fromEntries(
  paths.sort().map((path) => [path, hash(readFileSync(path))]),
);
const checks = [],
  observations = [],
  metrics = [];
const check = (name, passed) => {
  checks.push({ name, passed });
  if (!passed) throw Error("PLATFORM_LAB_HELD:" + name);
};
const bundled = await build({
  entryPoints: ["scripts/fixtures/fixed-workos-platform-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:crypto"],
  metafile: true,
});
check(
  "no_runtime_schema_compilation",
  !Object.keys(bundled.metafile.inputs).some((path) => /ajv\/dist\/(compile|core|2020)/.test(path)),
);
check(
  "only_existing_crypto_external",
  Object.values(bundled.metafile.outputs)
    .flatMap((output) => output.imports)
    .every((entry) => entry.path === "node:crypto"),
);
const verifier = Buffer.alloc(32, 27).toString("base64url");
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
const secrets = [verifier, "platform_management_marker_87_only", "platform_dropped_refresh_marker"];
let activeOracle,
  disposed = false,
  failure,
  interceptedTotal = 0;
const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.NONE),
  outboundService: async (request) => {
    interceptedTotal++;
    if (!activeOracle) throw Error("NO_ORACLE_BOUND");
    return activeOracle.handleRequest(request);
  },
});
const post = async (path, input) => {
  const response = await mf.dispatchFetch("http://localhost/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  check("dispatch_" + path + "_" + checks.length, response.status === 200);
  return response.json();
};
const cases = [
  { name: "inert_constructor", method: "construct", expected: "pass", requests: 0 },
  ...["extra_fetch", "extra_redirect", "extra_url"].map((fault) => ({
    name: fault,
    method: "construct",
    fault,
    expected: "held",
    requests: 0,
  })),
  ...["exchange", "keyset", "page"].map((method) => ({
    name: method + "_native_success",
    method,
    expected: "pass",
    requests: 1,
  })),
  { name: "actual84_owning76_77_M_chain", method: "chain", expected: "pass", requests: 3 },
  {
    name: "concurrent_independent84_callbacks_one_port",
    method: "concurrent",
    expected: "pass",
    requests: 6,
  },
];
for (const method of ["exchange", "keyset", "page"]) {
  for (const status of [301, 302, 303, 307, 308])
    for (const foreign of [false, true])
      cases.push({
        name: method + "_no_follow_" + status + (foreign ? "_foreign" : "_same_host"),
        method,
        expected: "held",
        requests: 1,
        responseFault: { status, foreign },
      });
  for (const status of [401, 429])
    cases.push({
      name: method + "_non200_" + status,
      method,
      expected: "held",
      requests: 1,
      responseFault: { status },
    });
  for (const fault of ["media", "duplicate", "utf8", "bom", "oversize", "gzip_oversize"])
    cases.push({
      name: method + "_" + fault,
      method,
      expected: "held",
      requests: 1,
      responseFault: { name: fault },
    });
  cases.push({
    name: method + "_actual_gzip_decoding",
    method,
    expected: "pass",
    requests: 1,
    responseFault: { name: "gzip" },
  });
  for (const fault of ["abort", "deadline", "clock"])
    cases.push({
      name: method + "_" + fault,
      method,
      fault,
      expected: "held",
      responseFault: { delayMs: 100 },
    });
  for (const fault of ["aborted_control", "expired_control"])
    cases.push({ name: method + "_" + fault, method, fault, expected: "held", requests: 0 });
}
for (const fault of ["private_jwk", "keys17", "declared_size"])
  cases.push({
    name: "keyset_" + fault,
    method: "keyset",
    expected: "held",
    requests: 1,
    responseFault: { name: fault },
  });
for (const fault of [
  "wrong_namespace",
  "expired_lease",
  "revoked_lease",
  "late_lease",
  "release_reject",
  "release_pending",
])
  cases.push({
    name: "page_" + fault,
    method: "page",
    fault,
    expected: "held",
    requests: ["release_reject", "release_pending"].includes(fault) ? 1 : 0,
  });
cases.push({
  name: "keyset_late_native_stream",
  method: "keyset",
  fault: "stream_late",
  expected: "held",
  requests: 1,
  responseFault: { name: "stream_late" },
});

try {
  // Characterize the actual captured platform route before an adapter success.
  // No Node Response attributes are used as a substitute for these observations.
  for (const phase of ["unsupported_error", "manual200", "manual302", "actual_gzip"]) {
    activeOracle = createPlatformWorkosProviderOracle({
      at: Date.now(),
      fault:
        phase === "manual302"
          ? { status: 302, foreign: true }
          : phase === "actual_gzip"
            ? { name: "gzip" }
            : {},
    });
    const observed = await post("characterize", {
      clientId: activeOracle.profile.clientId,
      unsupportedError: phase === "unsupported_error",
    });
    observations.push({
      name: phase,
      ...observed,
      interceptedRequests: activeOracle.metrics.interceptedRequests,
    });
    check(phase + "_oracle_valid", activeOracle.metrics.oracleFailures === 0);
    if (phase === "unsupported_error") {
      check(
        "unsupported_error_rejected_before_interception",
        observed.rejected === true && activeOracle.metrics.interceptedRequests === 0,
      );
    } else {
      check(
        phase + "_real_final_url",
        observed.rejected === false &&
          observed.expectedUrl === true &&
          observed.redirected === false,
      );
      check(phase + "_one_intercept", activeOracle.metrics.interceptedRequests === 1);
      check(
        phase + "_actual_status_and_json",
        observed.status === (phase === "manual302" ? 302 : 200) &&
          observed.jsonMedia &&
          observed.jsonBody,
      );
      if (phase === "actual_gzip") {
        check(
          "actual_gzip_decompressed_json_bytes",
          observed.gzip === true &&
            observed.decodedBytes ===
              Buffer.byteLength(JSON.stringify({ keys: [activeOracle.publicJwk] })),
        );
        check("actual_gzip_length_header_observed", typeof observed.lengthPresent === "boolean");
      }
    }
  }
  for (const c of cases) {
    activeOracle = createPlatformWorkosProviderOracle({ at: Date.now(), fault: c.responseFault });
    const issued = activeOracle.issueAuthorization({ challenge });
    if (c.method === "page") activeOracle.activate(issued);
    secrets.push(...activeOracle.secrets);
    const initialized = await post("initialize", {
      ...c,
      configurationJson: activeOracle.configurationJson,
      profile: activeOracle.profile,
      profileJson: activeOracle.profileJson,
      at: activeOracle.at,
      subjectId: issued.claims.sub,
      verifier,
    });
    check(
      c.name + ":inert_construction_no_intercept",
      activeOracle.metrics.interceptedRequests === 0 && initialized.borrows === 0,
    );
    const registered = initialized.authorizationUrls.map((url) => activeOracle.arm(url));
    secrets.push(...activeOracle.secrets);
    const result = await post("run", {
      code: issued.code,
      callbackUrls: registered.map((entry) => entry.callbackUrl),
    });
    metrics.push({
      name: c.name,
      expected: c.expected,
      held: result.held,
      transport: { ...activeOracle.metrics },
      credentialAndSyntheticSql: result.metrics,
      cleanupState: result.cleanupState,
      stages: activeOracle.calls,
      platformHeaderNames: [...activeOracle.platformHeaderNames].sort(),
      coverage:
        c.responseFault?.name === "declared_size"
          ? "native_transport_or_adapter_refusal_not_claimed_as_declared_length_parser"
          : "captured_platform_fetch_and_trusted_broker_clock_seams",
    });
    for (const item of result.checks) check(c.name + ":" + item.name, item.passed === true);
    check(c.name + ":expected_outcome", result.held === (c.expected === "held"));
    check(c.name + ":independent_HTTP_oracle_valid", activeOracle.metrics.oracleFailures === 0);
    if (c.requests !== undefined)
      check(
        c.name + ":exact_intercept_count",
        activeOracle.metrics.interceptedRequests === c.requests,
      );
    check(
      c.name + ":no_retry_or_follow",
      activeOracle.metrics.interceptedRequests <=
        (c.method === "concurrent"
          ? 6
          : c.method === "chain"
            ? 3
            : c.method === "construct"
              ? 0
              : 1),
    );
    check(
      c.name + ":management_marker_isolation",
      activeOracle.calls.every((call) => call.managementMarker === (call.kind === "sessionPage")),
    );
    check(
      c.name + ":no_native_provider_or_internet",
      activeOracle.metrics.actualInternetRequests === 0 &&
        activeOracle.metrics.actualProviderRequests === 0,
    );
    check(
      c.name + ":host_service_timers_finished",
      activeOracle.metrics.activeResponseTimers === 0,
    );
    if (c.method !== "page" && c.method !== "chain" && c.method !== "concurrent")
      check(c.name + ":public_no_credential_borrow", result.metrics.borrows === 0);
    if (c.method === "chain")
      check(
        c.name + ":POST_JWKS_session_order",
        activeOracle.calls.map((call) => call.kind).join(",") ===
          "exchange,publicKeyset,sessionPage" && result.metrics.admittedFamilies === 1,
      );
    if (c.method === "concurrent")
      check(
        c.name + ":two_independent_owning_chains",
        activeOracle.metrics.exchange === 2 &&
          activeOracle.metrics.publicKeyset === 2 &&
          activeOracle.metrics.sessionPage === 2 &&
          result.metrics.admittedFamilies === 2,
      );
    if (["release_reject", "release_pending"].includes(c.fault))
      check(
        c.name + ":unverified_release_never_retried",
        result.cleanupState === "unverified" &&
          result.metrics.releaseAttempts === 1 &&
          result.metrics.releaseCompletions === 0 &&
          result.metrics.activeLeases === 1,
      );
    else
      check(
        c.name + ":credential_handle_closed_or_not_acquired",
        result.metrics.activeLeases === 0 &&
          result.metrics.releaseAttempts === result.metrics.releaseCompletions,
      );
    if (c.fault === "late_lease")
      check(
        c.name + ":late_lease_cleanup_only",
        activeOracle.metrics.interceptedRequests === 0 &&
          result.metrics.releaseAttempts === 1 &&
          result.metrics.timelyReleaseCompletions === 1 &&
          !result.outputReturned,
      );
  }
  check("check_names_unique", new Set(checks.map((item) => item.name)).size === checks.length);
} catch (error) {
  failure = /^PLATFORM_LAB_HELD:[A-Za-z0-9_:./-]+$/.test(error.message)
    ? error.message
    : "PLATFORM_LAB_HELD:unclassified_fixture_or_transport";
} finally {
  try {
    await mf.dispose();
    disposed = true;
  } catch {
    failure ??= "PLATFORM_LAB_HELD:runtime_disposal_unverified";
  }
}
for (const [path, digest] of Object.entries(sourceDigests)) {
  const passed = hash(readFileSync(path)) === digest;
  checks.push({ name: "source_unchanged:" + path, passed });
  if (!passed) failure ??= "PLATFORM_LAB_HELD:source_changed";
}
const report = {
  task: "P05.T01s",
  status: failure ? "held" : "passed",
  failure,
  qualification:
    "local_pinned_captured_Workers_Fetch_fully_intercepted_independent_HTTP_PKCE_RSA_unchanged84_owning76_77_M_synthetic_SQL",
  observedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    miniflare: JSON.parse(readFileSync("node_modules/miniflare/package.json")).version,
    workerd: JSON.parse(readFileSync("node_modules/workerd/package.json")).version,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
  },
  cases: cases.length,
  completedCases: metrics.length,
  checks,
  nativeResponseObservations: observations,
  metrics,
  interceptedPlatformRequests: interceptedTotal,
  actualInternetRequests: 0,
  actualProviderRequests: 0,
  cleanup: {
    workerRuntimeDisposalAcknowledged: disposed,
    databaseResourcesCreated: false,
    credentialProvisioning: false,
    localReaderCancellationAcknowledgementsDirectlyInstrumented: false,
    remoteStreamCancellationIsSeparateObservation: true,
    unverifiedCredentialCases: metrics.filter((row) => row.cleanupState === "unverified").length,
  },
  source_digests: sourceDigests,
  source_inventory_digest: hash(JSON.stringify(Object.entries(sourceDigests))),
  retainedSyntheticOnlyCoverage: [
    "foreign_or_empty_Response_url",
    "forced_redirected_true",
    "non_Response_Fetch_result",
    "nonbyte_reader_chunk",
    "rejected_or_stalled_local_reader_cancel",
  ],
  limitations: [
    "The actual platform Fetch runs locally through Miniflare's fully intercepted HTTP service; WorkOS DNS/TLS/account access, hosted secrets and Internet HTTP remain unqualified.",
    "Response URL and redirected observations come from inside the Worker, never the Node callback Response. The Node callback Request.redirect/signal is not used to attest the original options/control.",
    "The bridge supplies the actual single gzip encoding pass and may remove Content-Length. Invalid declared-length refusal is not attributed to a parser unless directly observed.",
    "Native RSA and unchanged owning crypto/controller/session code execute, but the four SQL-role replies are synthetic and prove no Workers-to-Neon or backend cleanup.",
    "Remote fixture stream cancellation differs from the Worker's reader.cancel acknowledgement. No unobservable local acknowledgement, remote no-effect, secure erasure or late release completion is inferred.",
    "Two intentional rejected/stalled synthetic credential releases remain unverified. No merchant entry, deployed application, browser-engine cookie enforcement or consumed82 allowance is activated.",
  ],
};
const text = JSON.stringify(report, null, 2) + "\n";
for (const secret of secrets)
  if (secret && text.includes(secret)) throw Error("REPORT_SECRET_FENCE_HELD");
writeArtifact("labs/fixed-workos-platform-workers.json", text);
if (failure) {
  process.exitCode = 1;
  process.stdout.write(failure + "; report preserved; runtime disposal=" + disposed + "\n");
} else
  process.stdout.write(
    "PASS: " +
      cases.length +
      " captured platform cases; " +
      checks.length +
      " checks; " +
      interceptedTotal +
      " intercepted requests; actual Internet/provider0; runtime disposed.\n",
  );
