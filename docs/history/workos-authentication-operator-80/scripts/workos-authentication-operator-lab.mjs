// Actual local SQL69/4110 integration with independently signed synthetic wire
// responses. This program has no native provider transport or real key input.
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as socketConnect } from "node:net";
import {
  prepareSyntheticWorkosAuthenticationOperatorRun,
  readWorkosAuthenticationOperatorRun,
  releaseWorkosAuthenticationOperatorRun,
  inspectWorkosAuthenticationOperatorRun,
  workosAuthenticationOperatorSourcePaths,
  loadWorkosAuthenticationOperatorScope,
} from "./workos-authentication-operator-input.mjs";
import { createWorkosAuthenticationOperatorController } from "./workos-authentication-operator-controller.mjs";
import { createSyntheticWorkosAuthenticationOperatorTransport } from "./workos-authentication-operator-native.mjs";
import { createWorkosAuthenticationOperatorListener } from "./workos-authentication-operator-listener.mjs";
import { withWorkosAuthenticationOperatorDatabase } from "./workos-authentication-operator-database.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourcePaths = [
  ...workosAuthenticationOperatorSourcePaths,
  "tests/workos-authentication-operator-listener.test.mjs",
  "tests/workos-authentication-operator-input.test.mjs",
  "tests/workos-authentication-operator-controller.test.mjs",
  "tests/workos-authentication-operator-journal.test.mjs",
  "tests/workos-authentication-operator-native.test.mjs",
  "tests/workos-authentication-operator-cli.test.mjs",
];
const sourceDigests = Object.fromEntries(
  sourcePaths.map((file) => [file, hash(fs.readFileSync(file))]),
);
const scope = JSON.parse(loadWorkosAuthenticationOperatorScope());
const checks = [],
  outcomes = [],
  cleanupFaults = [],
  secrets = [],
  resources = [];
const totals = {
  syntheticJwksGets: 0,
  syntheticCodePosts: 0,
  syntheticSessionGets: 0,
  realProviderRequests: 0,
};
let failedCheck = null;
const check = (name, value) => {
  if (!/^[a-z][a-z0-9_]{1,119}$/.test(name) || checks.some((c) => c.name === name) || !value) {
    failedCheck ??= /^[a-z][a-z0-9_]{1,119}$/.test(name) ? name : "invalid_check";
    throw Error("AUTHENTICATION_OPERATOR_LAB_FAILED:" + failedCheck);
  }
  checks.push({ name, passed: true });
};
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
const jwk = {
  ...keyPair.publicKey.export({ format: "jwk" }),
  kid: "independent_operator_native_rsa",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
  // Encoding metadata only: the synthetic values do not assert PKI validity.
  x5c: [Buffer.from("synthetic bounded certificate metadata").toString("base64")],
  "x5t#S256": Buffer.alloc(32, 7).toString("base64url"),
};
const id = (prefix) => prefix + "_" + randomBytes(13).toString("hex").toUpperCase();
const response = (url, body, status = 200) => {
  const r = new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(r, "url", { value: url });
  return r;
};
function request(method, url, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 4110,
        path: url,
        method,
        headers: { connection: "close", ...headers },
        timeout: 5000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 131072) req.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
        res.on("error", () => reject(Error("AUTHENTICATION_OPERATOR_LAB_HTTP_FAILED")));
      },
    );
    req.on("error", () => reject(Error("AUTHENTICATION_OPERATOR_LAB_HTTP_FAILED")));
    req.on("timeout", () => req.destroy());
    req.end(body);
  });
}
const cookie = (reply, name) =>
  [reply.headers["set-cookie"]]
    .flat()
    .find((value) => value?.startsWith(name + "="))
    ?.split(";")[0];
const portClosed = () =>
  new Promise((resolve) => {
    const socket = socketConnect({ host: "127.0.0.1", port: 4110 });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED"));
  });
function runFixture(options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "morrow-authentication-lab-")),
  );
  fs.chmodSync(root, 0o700);
  let offset = 0,
    sourceValid = true;
  const clock = () => Date.now() + offset;
  const ownedRun = prepareSyntheticWorkosAuthenticationOperatorRun(root, {
    clock,
    currentScope: (text) => (sourceValid ? text : text + " "),
    fault: options.fault,
  });
  if (!ownedRun) throw Error("AUTHENTICATION_OPERATOR_LAB_FIXTURE_HELD");
  const context = readWorkosAuthenticationOperatorRun(ownedRun);
  const fixture = {
    root,
    ownedRun,
    context,
    clock,
    advance: (n) => {
      offset += n;
    },
    drift: () => {
      sourceValid = false;
    },
    released: false,
  };
  resources.push(fixture);
  return fixture;
}
function release(fixture) {
  if (fixture.released) return;
  fixture.released = true;
  fixture.release = releaseWorkosAuthenticationOperatorRun(fixture.ownedRun);
}
function signedFixture(fixture, options = {}) {
  const now = fixture.clock(),
    binding = fixture.context.binding;
  const claims = {
    iss: `https://api.workos.com/user_management/${binding.clientId}`,
    client_id: binding.clientId,
    sub: options.wrongSubject ? id("user") : binding.approvedSubjectId,
    sid: id("session"),
    iat: Math.floor(now / 1000) - 5,
    exp: Math.floor(now / 1000) + 180,
  };
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = part({ alg: "RS256", kid: jwk.kid, typ: "JWT" }) + "." + part(claims);
  const token =
    input + "." + sign("RSA-SHA256", Buffer.from(input), keyPair.privateKey).toString("base64url");
  secrets.push(token);
  const session = (patch = {}) => ({
    object: "session",
    id: claims.sid,
    user_id: claims.sub,
    status: "active",
    auth_method: "oauth",
    ended_at: null,
    created_at: new Date(now - 60000).toISOString(),
    updated_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 120000).toISOString(),
    ...patch,
  });
  const page = (data, after = null) => ({
    object: "list",
    data,
    list_metadata: { before: null, after },
  });
  return { claims, token, session, page };
}
async function caseRun(name, fixture, admission, diagnostics, options = {}) {
  const wire = signedFixture(fixture, options),
    code = "opaque_" + randomBytes(24).toString("hex");
  secrets.push(code, hash(code));
  const counts = { jwksGetCount: 0, codePostCount: 0, sessionGetCount: 0 };
  let nativeResult,
    material,
    controller,
    listener,
    completed = false,
    pageIntentSeen = false,
    keySeen = false;
  let releaseGate;
  const gate = options.gated
    ? new Promise((resolve) => {
        releaseGate = resolve;
      })
    : Promise.resolve();
  const transportFactory = (permit) => {
    const transport = createSyntheticWorkosAuthenticationOperatorTransport(permit, {
      clock: fixture.clock,
      fetch: async (url, init) => {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith("/sso/jwks/")) {
          counts.jwksGetCount++;
          totals.syntheticJwksGets++;
          check(
            name + "_jwks_exact_fixed_endpoint",
            url === `https://api.workos.com/sso/jwks/${fixture.context.binding.clientId}` &&
              init.method === "GET" &&
              init.redirect === "error" &&
              !new Headers(init.headers).has("authorization"),
          );
          if (options.sourceDrift) fixture.drift();
          if (options.bindingDrift) diagnostics.setBindingActive(false);
          await gate;
          return response(url, { keys: [jwk] });
        }
        if (parsed.pathname === "/user_management/authenticate") {
          counts.codePostCount++;
          totals.syntheticCodePosts++;
          const body = JSON.parse(init.body);
          secrets.push(body.code_verifier, hash(body.code_verifier));
          check(
            name + "_post_keyless_exact_tuple",
            init.method === "POST" &&
              init.redirect === "error" &&
              Object.keys(body).sort().join(",") === "client_id,code,code_verifier,grant_type" &&
              body.client_id === fixture.context.binding.clientId &&
              body.code === code &&
              body.grant_type === "authorization_code" &&
              !new Headers(init.headers).has("authorization"),
          );
          return response(url, {
            access_token: wire.token,
            refresh_token: ["synthetic", "refresh", "value"].join("_"),
            user: { id: wire.claims.sub },
          });
        }
        if (parsed.pathname === `/user_management/users/${wire.claims.sub}/sessions`) {
          counts.sessionGetCount++;
          totals.syntheticSessionGets++;
          const n = counts.sessionGetCount;
          check(
            name + "_session_" + n + "_owned_fixed_selector",
            init.method === "GET" &&
              init.redirect === "error" &&
              parsed.origin === "https://api.workos.com" &&
              parsed.searchParams.get("limit") === "100" &&
              parsed.searchParams.get("order") === "asc" &&
              (n === 1
                ? parsed.searchParams.get("after") === null
                : parsed.searchParams.get("after") === wire.claims.sid),
          );
          const authorization = new Headers(init.headers).get("authorization");
          keySeen = typeof authorization === "string" && authorization.startsWith("Bearer ");
          if (keySeen) secrets.push(authorization.slice(7));
          pageIntentSeen = fs.existsSync(
            path.join(fixture.root, "session_page_" + n + "_requested.json"),
          );
          check(
            name + "_session_" + n + "_follows_target_and_durable_intent",
            keySeen &&
              pageIntentSeen &&
              fs.existsSync(path.join(fixture.root, "verified_target.json")),
          );
          if (options.keyRemoval && n === 1)
            fs.unlinkSync(path.join(fixture.root, "credential.txt"));
          if (options.impersonation)
            return response(
              url,
              wire.page([wire.session({ auth_method: "impersonation", impersonator: null })]),
            );
          if (options.malformedLater && n === 2)
            return response(url, wire.page([{ object: "invalid" }]));
          if (options.twoPages || options.keyRemoval || options.malformedLater) {
            if (n === 1) return response(url, wire.page([wire.session()], wire.claims.sid));
            return response(
              url,
              wire.page([
                wire.session({
                  id: id("session"),
                  auth_method: "impersonation",
                  impersonator: { email: "synthetic@example.test", reason: null },
                }),
              ]),
            );
          }
          return response(url, wire.page([wire.session()]));
        }
        throw Error("AUTHENTICATION_OPERATOR_LAB_UNEXPECTED_ENDPOINT");
      },
    });
    return Object.freeze({
      ...transport,
      completeOnce(secret, control) {
        const controls = options.leaseExpiry
          ? {
              ...control,
              onEvidenceObservation: async (text) => {
                const value = await control.onEvidenceObservation(text);
                fixture.advance(5001);
                return value;
              },
            }
          : control;
        return transport.completeOnce(secret, controls).then((result) => {
          nativeResult = result;
          completed = true;
          return result;
        });
      },
    });
  };
  try {
    controller = createWorkosAuthenticationOperatorController({
      ownedRun: fixture.ownedRun,
      admission,
      transportFactory,
    });
    const served = Object.freeze({
      ...controller,
      async start() {
        material = await controller.start();
        secrets.push(
          material.state,
          material.browserProof,
          hash(material.state),
          hash(material.browserProof),
        );
        return material;
      },
    });
    listener = createWorkosAuthenticationOperatorListener(fixture.ownedRun, served);
    await listener.listen();
    const p = fixture.context.profile;
    const initial = await request("GET", p.startPath);
    check(
      name + "_clean_bootstrap_only",
      initial.status === 200 &&
        initial.headers["referrer-policy"] === "same-origin" &&
        counts.jwksGetCount === 0 &&
        counts.codePostCount === 0,
    );
    const csrf = initial.text.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)?.[1];
    const begun = await request(
      "POST",
      p.startPath,
      {
        Origin: p.loopbackOrigin,
        Cookie: cookie(initial, "morrow_operator_bootstrap"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      "csrf=" + csrf,
    );
    check(
      name + "_real_begin_then_private_static_link",
      begun.status === 200 &&
        begun.headers["referrer-policy"] === "no-referrer" &&
        begun.text.includes('rel="noreferrer"') &&
        fs.existsSync(path.join(fixture.root, "initiation_started.json")),
    );
    const browserCookie = cookie(begun, "morrow_operator_browser");
    const invalid = await request("GET", p.callbackPath + "?code=x&state=wrong", {
      Cookie: browserCookie,
    });
    check(
      name + "_invalid_callback_keeps_valid_flow",
      invalid.status === 400 && counts.jwksGetCount === 0,
    );
    const callbackPath =
      p.callbackPath + "?code=" + encodeURIComponent(code) + "&state=" + material.state;
    const callback = await request("GET", callbackPath, { Cookie: browserCookie });
    check(
      name + "_callback_clean_303",
      callback.status === 303 &&
        callback.text === "" &&
        callback.headers.location === p.loopbackOrigin + p.resultPath &&
        callback.headers["referrer-policy"] === "no-referrer",
    );
    if (options.gated) check(name + "_callback_303_while_completion_gated", !completed);
    const duplicate = await request("GET", callbackPath, { Cookie: browserCookie });
    check(name + "_duplicate_callback_cannot_reenter", duplicate.status === 400);
    releaseGate?.();
    const deadline = Date.now() + 35000;
    while (
      !["verified_active_evidence", "held", "authorization_not_completed"].includes(
        controller.status().state,
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const terminal = controller.status();
    check(
      name + "_bounded_terminal",
      ["verified_active_evidence", "held"].includes(terminal.state),
    );
    check(
      name + "_expected_qualification",
      terminal.state === (options.expected ?? "verified_active_evidence"),
    );
    check(
      name + "_one_use_effect_counts",
      counts.jwksGetCount < 2 && counts.codePostCount < 2 && counts.sessionGetCount <= 4,
    );
    if (options.expectedCounts)
      check(
        name + "_exact_counts",
        Object.keys(counts).every((k) => counts[k] === options.expectedCounts[k]),
      );
    if (options.expected === "held")
      check(name + "_held_never_confers_authority", terminal.providerSessionCleanup === "unknown");
    if (options.wrongSubject)
      check(
        name + "_wrong_subject_no_target_or_key",
        !fs.existsSync(path.join(fixture.root, "verified_target.json")) &&
          !keySeen &&
          counts.sessionGetCount === 0,
      );
    if (options.leaseExpiry)
      check(
        name + "_historical_observation_does_not_override_expired_handle",
        fs.existsSync(path.join(fixture.root, "observation.json")) &&
          nativeResult?.outcome === "held",
      );
    if (failedCheck) throw Error("AUTHENTICATION_OPERATOR_LAB_FAILED:" + failedCheck);
    outcomes.push({
      name,
      outcome: terminal.state,
      counts: { ...counts },
      providerSessionCleanup: "unknown",
    });
    return { counts, nativeResult };
  } finally {
    releaseGate?.();
    try {
      await controller?.close();
    } finally {
      await listener?.close();
    }
    check(name + "_listener_closed", await portClosed());
    release(fixture);
    check(
      name + "_temporary_credential_absent",
      fixture.release.credentialRemoved === true &&
        !fs.existsSync(path.join(fixture.root, "credential.txt")),
    );
  }
}

let primary,
  engine,
  cleanup,
  completed = false;
try {
  check("initial_fixed_listener_port_closed", await portClosed());
  primary = runFixture();
  check("claim_precedes_database_allocation", fs.existsSync(path.join(primary.root, "claim.json")));
  const measured = await withWorkosAuthenticationOperatorDatabase(
    primary.ownedRun,
    async ({ admission, diagnostics }) => {
      engine = diagnostics.engine;
      const before = diagnostics.counts();
      check(
        "database_has_only_authentication_binding",
        before.challenges === 0 &&
          before.admissions === 0 &&
          before.principals === 0 &&
          before.organizations === 0 &&
          before.memberships === 0 &&
          before.sessions === 0 &&
          before.grants === 0 &&
          before.mappingInstalled === false,
      );
      const execute = async (name, options = {}) => {
        const fixture = runFixture();
        check(
          name + "_exact_shared_synthetic_database_binding",
          fixture.context.admissionBindingJson === primary.context.admissionBindingJson,
        );
        const port = options.admissionFault
          ? diagnostics.admissionWithFault(options.admissionFault)
          : admission;
        try {
          return await caseRun(name, fixture, port, diagnostics, options);
        } finally {
          if (options.bindingDrift) diagnostics.setBindingActive(true);
        }
      };
      await execute("positive_complete_two_page", {
        twoPages: true,
        gated: true,
        expectedCounts: { jwksGetCount: 1, codePostCount: 1, sessionGetCount: 2 },
      });
      await execute("target_impersonation_held", {
        impersonation: true,
        expected: "held",
        expectedCounts: { jwksGetCount: 1, codePostCount: 1, sessionGetCount: 1 },
      });
      await execute("wrong_signed_subject", {
        wrongSubject: true,
        expected: "held",
        expectedCounts: { jwksGetCount: 1, codePostCount: 1, sessionGetCount: 0 },
      });
      await execute("post_jwks_admission_drift", {
        bindingDrift: true,
        expected: "held",
        expectedCounts: { jwksGetCount: 1, codePostCount: 0, sessionGetCount: 0 },
      });
      await execute("post_jwks_source_drift", {
        sourceDrift: true,
        expected: "held",
        expectedCounts: { jwksGetCount: 1, codePostCount: 0, sessionGetCount: 0 },
      });
      await execute("unknown_commit_no_effect", {
        admissionFault: "commit_ack_loss",
        expected: "held",
        expectedCounts: { jwksGetCount: 0, codePostCount: 0, sessionGetCount: 0 },
      });
      await execute("unknown_release_no_effect", {
        admissionFault: "release_ack_loss",
        expected: "held",
        expectedCounts: { jwksGetCount: 0, codePostCount: 0, sessionGetCount: 0 },
      });
      await execute("credential_removed_after_page", {
        keyRemoval: true,
        expected: "held",
        expectedCounts: { jwksGetCount: 1, codePostCount: 1, sessionGetCount: 1 },
      });
      await execute("malformed_later_page", {
        malformedLater: true,
        expected: "held",
        expectedCounts: { jwksGetCount: 1, codePostCount: 1, sessionGetCount: 2 },
      });
      await execute("lease_expires_after_journal", {
        leaseExpiry: true,
        expected: "held",
        expectedCounts: { jwksGetCount: 1, codePostCount: 1, sessionGetCount: 1 },
      });
      const after = diagnostics.counts();
      check(
        "all_cases_still_create_no_local_identity_or_mapping",
        after.principals === 0 &&
          after.organizations === 0 &&
          after.memberships === 0 &&
          after.sessions === 0 &&
          after.grants === 0 &&
          after.mappingInstalled === false,
      );
      check(
        "ten_real_sql_challenges_and_admissions",
        after.challenges === 10 && after.admissions === 10,
      );
      check(
        "sql_and_container_output_exclude_private_material",
        diagnostics.outputExcludes(secrets),
      );
      return { qualified: true };
    },
  );
  cleanup = measured.cleanup;
  check(
    "observed_host_child_closure_without_graceful_claim",
    cleanup.hostChildClosure === "observed",
  );
  check("fresh_preauth_backend_namespace_absent", cleanup.backendNamespace === "absent");
  check("independent_owned_container_fence_absent", cleanup.containerFence === "absent");
  let duplicateUse = 0;
  await withWorkosAuthenticationOperatorDatabase(primary.ownedRun, () => {
    duplicateUse++;
  }).then(
    () => check("database_reentry_rejected", false),
    () => check("database_reentry_rejected", duplicateUse === 0),
  );
  check(
    "retained_claim_after_database_loss_is_not_a_send_handle",
    inspectWorkosAuthenticationOperatorRun(primary.root).claimed === true &&
      inspectWorkosAuthenticationOperatorRun(primary.root).effectHandles === 0,
  );
  release(primary);
  check(
    "primary_temporary_key_removed_after_database_teardown",
    primary.release.credentialRemoved === true && primary.release.lockReleased === true,
  );
  for (const kind of ["host_child_signal", "backend_inspection_loss"]) {
    const fixture = runFixture();
    const faulted = await withWorkosAuthenticationOperatorDatabase(
      fixture.ownedRun,
      async ({ diagnostics }) => {
        await diagnostics.injectCleanupFault(kind);
        return true;
      },
    );
    check(
      kind + "_reported_unverified",
      kind === "host_child_signal"
        ? faulted.cleanup.hostChildClosure === "unverified"
        : faulted.cleanup.backendNamespace === "unverified",
    );
    check(kind + "_independent_container_fence", faulted.cleanup.containerFence === "absent");
    cleanupFaults.push({ kind, ...faulted.cleanup });
    release(fixture);
    check(kind + "_temporary_key_removed", fixture.release.credentialRemoved === true);
  }
  check("final_listener_port_closed", await portClosed());
  check(
    "source_closure_unchanged",
    Object.entries(sourceDigests).every(([file, digest]) => hash(fs.readFileSync(file)) === digest),
  );
  if (failedCheck) throw Error("AUTHENTICATION_OPERATOR_LAB_FAILED:" + failedCheck);
  const report = {
    task: "P05.T01l",
    canonicalSequence: 80,
    scope:
      "Synthetic native-RSA/full evidence composition with real SQL69 and loopback4110; no provider credential or actual provider request; no issuer/mapping/merchant authority.",
    observedAt: new Date().toISOString(),
    sourceDigest: scope.sourceDigest,
    sourceDigests,
    engine,
    counts: totals,
    cleanup,
    cleanupFaults,
    checks,
    outcomes,
    limitations: [
      "Synthetic controlled-user/key receipts are not actual owner approval.",
      "Provider-session cleanup is unknown; no provider session was created.",
      "Legacy adapter exposes host-child closure, not graceful/no-signal per-client proof.",
      "A persisted observation is historical and nonauthorizing.",
    ],
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  check(
    "public_report_excludes_private_material",
    secrets.every((value) => !text.includes(value)) &&
      resources.every(
        (f) =>
          !text.includes(f.context.binding.approvedSubjectId) &&
          !text.includes(f.context.binding.clientId),
      ),
  );
  // The privacy check is deliberately included only after it passed.
  report.checks = checks;
  fs.mkdirSync("docs/evidence/P05.T01l", { recursive: true });
  fs.writeFileSync(
    "docs/evidence/P05.T01l/postgresql-loopback-lab.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  completed = true;
  console.log(
    "PASS: " +
      checks.length +
      " synthetic authentication operator SQL/HTTP checks; zero real provider requests.",
  );
} finally {
  for (const fixture of resources) {
    try {
      release(fixture);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  if (!completed)
    console.error("AUTHENTICATION_OPERATOR_LAB_HELD:" + (failedCheck ?? "unclassified"));
}
