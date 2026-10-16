import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse, WebSocketPair } from "miniflare";
import {
  createControlledNeonPgOracle,
  controlledNeonExpectedScript,
  controlledNeonWireBinding,
} from "./fixtures/controlled-neon-pg-wire-oracle.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import {
  createManagedLoginCleanupGate,
  createManagedLoginReleaseGate,
} from "./fixtures/managed-login-cleanup-gate.mjs";

if (process.version !== "v24.13.0") throw Error("U01_PINNED_NODE_REQUIRED");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageVersion = (name) =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
if (packageVersion("miniflare") !== "4.20260730.0" || packageVersion("workerd") !== "1.20260730.1")
  throw Error("U01_PINNED_RUNTIME_REQUIRED");
if (JSON.parse(readFileSync("docs/plan/source.json")).sources.plan.sequence !== 93)
  throw Error("U01_CURRENT93_REQUIRED");
const attempt = process.argv.slice(2);
if (attempt.length > 1 || (attempt.length && !/^--attempt=[a-z][a-z0-9-]{0,31}$/.test(attempt[0])))
  throw Error("U01_CLOSED_ATTEMPT_NAME_REQUIRED");
const reportPath =
  "docs/evidence/P05.T01v/regressions/managed-login-lifetime" +
  (attempt.length ? "-" + attempt[0].slice(10) : "") +
  ".json";
if (existsSync(reportPath)) throw Error("U01_IMMUTABLE_REPORT_EXISTS");
const paths = [
  "scripts/fixtures/managed-login-lifetime-worker.ts",
  "scripts/fixtures/managed-login-cleanup-gate.mjs",
  "scripts/managed-login-lifetime-workers-lab.mjs",
  "tests/managed-login-cleanup-gate.test.mjs",
  "docs/packets/P05.T01u.md",
  "docs/packets/P05.T01v.md",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "package-lock.json",
  "package.json",
  "scripts/fixtures/managed-login-request-worker.ts",
  "scripts/fixtures/controlled-neon-pg-wire-oracle.mjs",
  "scripts/fixtures/fixed-workos-platform-provider.mjs",
  "scripts/fixtures/fixed-workos-provider.mjs",
  ...[
    "managed-login-request",
    "managed-login-request-scope",
    "managed-login-capsule",
    "standalone-login",
    "standalone-login-protocol",
    "controlled-neon-login-pool",
    "controlled-neon-login-profiles",
    "controlled-neon-transport",
    "fixed-workos-login-port",
    "login-flow-custody",
    "login-preauth-control",
    "authentication-exchange-admission",
    "workos-authentication-evidence",
    "workos-session-token",
    "workos-session-status",
    "workos-workspace-selection",
    "workos-browser-session-admission",
  ].map((name) => "packages/identity/src/" + name + ".ts"),
];
const sourceDigests = Object.fromEntries(paths.sort().map((p) => [p, hash(readFileSync(p))]));
const dependencyPaths = [
  "node_modules/miniflare/package.json",
  "node_modules/miniflare/dist/src/index.js",
  "node_modules/workerd/package.json",
  "node_modules/@neondatabase/serverless/package.json",
  "node_modules/@neondatabase/serverless/index.mjs",
];
const runtimeDependencyDigests = Object.fromEntries(
  dependencyPaths.map((p) => [p, hash(readFileSync(p))]),
);
const checks = [],
  cases = [],
  timers = new Set();
const check = (name, passed) => {
  checks.push({ name, passed });
  return passed;
};
function bounded(pending, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timers.delete(timer);
      reject(Error("U01_WATCHDOG"));
    }, ms);
    timers.add(timer);
  });
  void pending.catch(() => {});
  return Promise.race([pending, limit]).finally(() => {
    clearTimeout(timer);
    timers.delete(timer);
  });
}
const bundled = await build({
  entryPoints: ["scripts/fixtures/managed-login-lifetime-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  metafile: true,
});
if (
  !check(
    "generic_worker_has_only_its_own_source",
    Object.keys(bundled.metafile.inputs).length === 1 &&
      Object.keys(bundled.metafile.inputs)[0] ===
        "scripts/fixtures/managed-login-lifetime-worker.ts",
  )
)
  throw Error("U01_PRODUCTION_IMPORT_DENIED");
const routerScript = `export default { fetch(request, env) {
 const u = new URL(request.url);
 if (u.origin === "https://${controlledNeonWireBinding.hostname}") return env.PG.fetch(request);
 if (["https://morrow-managed-gate.test", "https://morrow-cleanup-gate.test"].includes(u.origin)) return env.GATE.fetch(request);
 return new Response("refused", {status:503});
}};`;
for (const control of [
  { name: "negative", route: "negative", routed: false },
  { name: "positive", route: "positive", routed: false },
  { name: "routed_negative", route: "negative", routed: true },
  { name: "routed_positive", route: "positive", routed: true },
]) {
  const { name, route, routed } = control;
  let mf,
    disposed = false,
    stopped = false,
    stage = "construct",
    failure = null,
    natural;
  const nonce = randomBytes(16).toString("hex");
  const ownedGate = createManagedLoginCleanupGate({ nonce });
  const started = performance.now();
  try {
    await bounded(
      (async () => {
        const ownerOptions = {
          modules: true,
          script: bundled.outputFiles[0].text,
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          upstream: "https://morrow-cleanup-owner.test",
          bindings: { NONCE: nonce },
        };
        mf = new Miniflare(
          routed
            ? {
                workers: [
                  { name: "owner", ...ownerOptions, outboundService: "outbound" },
                  {
                    name: "outbound",
                    modules: true,
                    script: routerScript,
                    compatibilityDate: "2026-07-30",
                    serviceBindings: {
                      GATE: { node: ownedGate.node },
                      PG: async () => new MiniflareResponse(null, { status: 503 }),
                    },
                  },
                ],
                log: new Log(LogLevel.NONE),
              }
            : {
                ...ownerOptions,
                log: new Log(LogLevel.NONE),
                outboundService: { node: ownedGate.node },
              },
        );
        stage = "owner_request";
        const response = await mf.dispatchFetch(`https://morrow-cleanup-owner.test/${route}`);
        const body = await response.text();
        if (stopped) throw Error("U01_STOPPED");
        if (
          !check(
            name + ":same_finite_owner_body",
            response.status === 200 &&
              body === "u01-finite-owner" &&
              response.headers.get("content-type") === "text/plain",
          )
        )
          throw Error("U01_OWNER_BODY");
        ownedGate.ownerBodyCompleted();
        let observed = ownedGate.snapshot();
        if (
          !check(
            name + ":gate_and_ack_admitted_before_body",
            observed.requests.gate === 1 &&
              observed.requests.accepted === 1 &&
              !observed.gateOpened &&
              observed.requests.unexpected === 0,
          )
        )
          throw Error("U01_ADMISSION");
        stage = route === "negative" ? "natural_premature_close" : "post_response_completion";
        if (route === "negative") await ownedGate.cancellation;
        else {
          if (
            !check(
              name + ":gate_still_pending_after_body",
              !observed.naturalPrematureUnfinishedResponseClose &&
                observed.activeResponses >= 1 &&
                observed.requests.complete === 0,
            )
          )
            throw Error("U01_EARLY_CLOSE");
          ownedGate.open();
          await ownedGate.completionMarker;
          // Observe natural raw response closure before fixture disposal starts.
          await ownedGate.responsesClosed();
        }
        if (stopped) throw Error("U01_STOPPED");
        observed = ownedGate.snapshot();
        if (
          !check(
            name + ":native_distinction",
            observed.requests.unexpected === 0 &&
              observed.unobservedOverflowResponseClosures === 0 &&
              (route === "negative"
                ? observed.naturalPrematureUnfinishedResponseClose &&
                  !observed.gateOpened &&
                  observed.requests.complete === 0
                : observed.gateReadMarker &&
                  observed.requests.complete === 1 &&
                  !observed.naturalPrematureUnfinishedResponseClose &&
                  observed.responseCloseAcknowledgements === 3 &&
                  observed.finishedByRoute.complete === 1),
          )
        )
          throw Error("U01_NOT_DISTINGUISHED");
      })(),
      8000,
    );
  } catch {
    failure = stage;
    check(name + ":actual_operation_held", false);
  } finally {
    stopped = true;
    natural = ownedGate.snapshot();
    ownedGate.beginForcedCleanup();
    ownedGate.destroyOpenResponses();
    try {
      await bounded(
        (async () => {
          if (mf) {
            await mf.dispose();
            disposed = true;
          }
          await ownedGate.responsesClosed();
        })(),
        5000,
      );
    } catch {
      failure ??= "cleanup_unknown";
    }
    ownedGate.detachListeners();
  }
  const cleanup = ownedGate.snapshot();
  check(name + ":runtime_disposal_acknowledged", disposed);
  check(
    name + ":owned_handles_and_listeners_closed",
    cleanup.activeResponses === 0 &&
      cleanup.activeListeners === 0 &&
      cleanup.unobservedOverflowResponseClosures === 0,
  );
  cases.push({
    name,
    failure,
    elapsedMs: performance.now() - started,
    routed,
    sourceExpectedWaitUntilCalls: route === "positive" ? 1 : 0,
    natural,
    cleanup,
    runtimeDisposalAcknowledged: disposed,
  });
}
const managedCases = [];
const passwordMarker = ["MorrowSynthetic", "U90", "PG", "marker", "only"].join("-");
const privateMarkers = [passwordMarker];
const sdkVersion = packageVersion("@neondatabase/serverless");
check("actual_sdk_version_1_2_0", sdkVersion === "1.2.0");
const origin = "https://workspace.example.test";
const provider = createPlatformWorkosProviderOracle({ origin, now: Date.now });
const configurationJson = provider.configurationJson;
const rawConfiguration = JSON.parse(configurationJson),
  binding = JSON.parse(rawConfiguration.authenticationBindingJson);
const configurationDigest = hash(
  JSON.stringify([
    "morrow.login.configuration",
    "1",
    rawConfiguration.controllerProtocol,
    rawConfiguration.origin,
    rawConfiguration.retentionTier,
    binding.bindingId,
    String(binding.bindingRevision),
    binding.environmentId,
    binding.applicationId,
    binding.clientId,
    binding.redirectUri,
    binding.returnPath,
    rawConfiguration.profileId,
    String(rawConfiguration.profileRecordRevision),
    hash(rawConfiguration.verificationProfileJson),
  ]),
);
const keyId = "10500000-0000-4000-8000-000000000001";
const keyMaterial = randomBytes(32).toString("base64url");
privateMarkers.push(keyMaterial);
const keyEpoch = Date.now();
const capsuleKeyringJson = JSON.stringify({
  schemaVersion: 1,
  purpose: "morrow.login.capsule/1",
  configurationDigest,
  currentKeyId: keyId,
  versions: [
    {
      keyId,
      material: keyMaterial,
      encryptFromMs: keyEpoch - 60000,
      encryptUntilMs: keyEpoch + 600000,
      decryptUntilMs: keyEpoch + 900000,
    },
  ],
});
const nativeDefinitions = [
  { name: "managed_pending_query_post_response_ack", kind: "pending", releaseMode: "gate" },
  {
    name: "managed_pending_query_rejected_ack",
    kind: "pending",
    releaseMode: "gate",
    rejectGate: true,
  },
  {
    name: "managed_pending_query_stalled_ack",
    kind: "pending",
    releaseMode: "gate",
    stallGate: true,
  },
  {
    name: "managed_pending_query_after_C_open_outcome",
    kind: "pending",
    releaseMode: "late_gate",
    lateGate: true,
  },
  { name: "managed_concurrent_scopes", kind: "pending", releaseMode: "gate", concurrent: 2 },
  { name: "managed_non101_failed_connect", kind: "non101", releaseMode: "normal" },
  { name: "managed_wrong_password_failed_connect", kind: "wrong_password", releaseMode: "normal" },
  { name: "managed_rejected_credential_disposal", kind: "non101", releaseMode: "reject" },
  { name: "managed_late_101_handle", kind: "late101", releaseMode: "normal" },
];
for (const definition of nativeDefinitions) {
  const expected = definition.concurrent ?? 1,
    nonce = randomBytes(16).toString("hex");
  const gate = createManagedLoginReleaseGate({ nonce, expected });
  const brokerEvents = [],
    settlement = [],
    settleWaiters = [],
    brokerWaiters = [],
    callbackWaiters = [],
    endpoints = [],
    delayed = new Map(),
    withheld = [];
  let mf,
    disposed = false,
    failure = null,
    stage = "bundle",
    socketCalls = 0,
    unexpected = 0,
    forcedCloses = 0;
  let bodyCompletedAt = null,
    natural = null,
    naturalSettlement = [],
    naturalBrokerEvents = [],
    responses = [],
    pairListeners = 0,
    activeUpgradeCallbacks = 0;
  const brokerAckObserved = () =>
    brokerEvents.length >= expected
      ? Promise.resolve()
      : new Promise((resolve) => brokerWaiters.push(resolve));
  const callbacksClosed = () =>
    activeUpgradeCallbacks === 0
      ? Promise.resolve()
      : new Promise((resolve) => callbackWaiters.push(resolve));
  const signalSettlement = () => {
    if (settlement.length < expected) return;
    for (const resolve of settleWaiters.splice(0)) resolve();
  };
  const settled = () =>
    settlement.length >= expected
      ? Promise.resolve()
      : new Promise((resolve) => settleWaiters.push(resolve));
  class CaptureLog extends Log {
    constructor() {
      super(LogLevel.DEBUG);
    }
    logWithLevel(_level, message) {
      if (typeof message !== "string" || !message.startsWith("{")) return;
      try {
        const row = JSON.parse(message);
        if (row.event === "morrow_fixture_lease_ack") {
          const expectedKeys = [
            "event",
            "lease",
            "inOriginalCleanup",
            "releaseAttempts",
            "releaseAcknowledgements",
            "activeLeases",
          ];
          if (
            Object.keys(row).sort().join() === expectedKeys.sort().join() &&
            typeof row.inOriginalCleanup === "boolean" &&
            ["lease", "releaseAttempts", "releaseAcknowledgements", "activeLeases"].every(
              (k) => Number.isSafeInteger(row[k]) && row[k] >= 0,
            )
          ) {
            brokerEvents.push({ ...row, observedAt: performance.now() });
            if (brokerEvents.length >= expected)
              for (const resolve of brokerWaiters.splice(0)) resolve();
          }
          return;
        }
        const keys = [
          "event",
          "outcome",
          "publicationAttempts",
          "publicationAccepted",
          "publicationFailures",
          "duplicatePublicationAttempts",
          "publishedPending",
          "publishedSettled",
          "ownerMismatches",
          "namespaceMismatches",
          "businessDenials",
        ];
        if (
          Object.keys(row).sort().join() !== keys.sort().join() ||
          row.event !== "morrow_managed_login_cleanup_settled" ||
          !["fulfilled", "rejected"].includes(row.outcome) ||
          keys
            .filter((k) => !["event", "outcome"].includes(k))
            .some((k) => !Number.isSafeInteger(row[k]) || row[k] < 0)
        )
          return;
        settlement.push({ ...row, observedAt: performance.now() });
        signalSettlement();
      } catch {}
    }
  }
  const captureLog = new CaptureLog();
  const poolNames = Array.from({ length: expected }, () => "loginPool");
  const oracle = createControlledNeonPgOracle({
    password: passwordMarker,
    poolNames,
    scripts: {
      loginPool: controlledNeonExpectedScript("loginPool", ["unused", "unused"]).slice(0, 1),
    },
    fault: definition.kind === "pending" ? "slow_query" : "none",
    schedule(callback) {
      withheld.push(callback);
    },
  });
  try {
    await bounded(
      (async () => {
        const managed = await build({
          entryPoints: ["scripts/fixtures/managed-login-request-worker.ts"],
          bundle: true,
          write: false,
          format: "esm",
          platform: "browser",
          target: "es2022",
          external: ["node:*"],
          metafile: true,
          define: {
            MANAGED_LOGIN_FIXTURE_JSON: JSON.stringify(
              JSON.stringify({
                configurationJson,
                capsuleKeyringJson,
                bindingJson: JSON.stringify(controlledNeonWireBinding),
                passwordByRole: Object.fromEntries(
                  ["login", "preauth", "resolution", "sessions"].map((r) => [
                    "morrow_identity_" + r,
                    passwordMarker,
                  ]),
                ),
                releaseMode: definition.releaseMode,
                wrongPassword: definition.kind === "wrong_password",
                gateNonce: nonce,
                clockOffsetMs: 0,
              }),
            ),
          },
        });
        check(
          definition.name + ":no_runtime_schema_compiler",
          !Object.keys(managed.metafile.inputs).some((p) =>
            /ajv\/dist\/(compile|core|2020)/.test(p),
          ),
        );
        stage = "native_owner";
        mf = new Miniflare({
          upstream: origin,
          workers: [
            {
              name: "owner",
              modules: true,
              script: managed.outputFiles[0].text,
              compatibilityDate: "2026-07-30",
              compatibilityFlags: ["nodejs_compat"],
              outboundService: "outbound",
            },
            {
              name: "outbound",
              modules: true,
              script: routerScript,
              compatibilityDate: "2026-07-30",
              serviceBindings: {
                GATE: { node: gate.node },
                PG: async (request) => {
                  socketCalls++;
                  activeUpgradeCallbacks++;
                  try {
                    const u = new URL(request.url);
                    if (
                      u.origin !== "https://" + controlledNeonWireBinding.hostname ||
                      u.pathname !== "/v2" ||
                      u.username ||
                      u.password ||
                      u.hash ||
                      [...u.searchParams.keys()].join() !== "address" ||
                      u.searchParams.get("address") !==
                        controlledNeonWireBinding.hostname + ":5432" ||
                      request.method !== "GET" ||
                      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
                    ) {
                      unexpected++;
                      return new MiniflareResponse(null, { status: 503 });
                    }
                    if (definition.kind === "non101")
                      return new MiniflareResponse(null, { status: 200 });
                    if (definition.kind === "late101") {
                      const admitted = await new Promise((resolve) => {
                        const timer = setTimeout(() => {
                          delayed.delete(timer);
                          resolve(true);
                        }, 5500);
                        delayed.set(timer, () => resolve(false));
                      });
                      if (!admitted) return new MiniflareResponse(null, { status: 503 });
                    }
                    const pair = new WebSocketPair(),
                      client = pair[0],
                      server = pair[1];
                    let closeResolve;
                    const item = {
                      client,
                      server,
                      createdAt: performance.now(),
                      serverClosed: false,
                      clientClosed: false,
                      removes: [],
                      closed: new Promise((resolve) => {
                        closeResolve = resolve;
                      }),
                      resolveClosed: () => {
                        if (item.serverClosed && item.clientClosed) closeResolve();
                      },
                    };
                    endpoints.push(item);
                    server.accept();
                    const protocol = oracle.accept({
                      send: (bytes) => server.send(bytes),
                      close: () => server.close(1000, "owned protocol terminate"),
                    });
                    const on = (target, name, fn) => {
                      target.addEventListener(name, fn);
                      pairListeners++;
                      item.removes.push(() => {
                        target.removeEventListener(name, fn);
                        pairListeners--;
                      });
                    };
                    on(server, "message", (event) => {
                      try {
                        if (!(event.data instanceof ArrayBuffer) && !ArrayBuffer.isView(event.data))
                          throw Error("binary");
                        protocol.receive(
                          new Uint8Array(
                            event.data instanceof ArrayBuffer ? event.data : event.data.buffer,
                            event.data.byteOffset ?? 0,
                            event.data.byteLength,
                          ),
                        );
                      } catch {
                        if (definition.kind !== "wrong_password") unexpected++;
                        try {
                          server.close(1000, "owned protocol refusal");
                        } catch {}
                      }
                    });
                    on(server, "close", () => {
                      if (!item.serverClosed) {
                        item.serverClosed = true;
                        protocol.transportClosed();
                      }
                      item.resolveClosed();
                      try {
                        server.close(1000, "owned peer ack");
                      } catch {}
                    });
                    on(client, "close", () => {
                      item.clientClosed = true;
                      item.resolveClosed();
                    });
                    return new MiniflareResponse(null, { status: 101, webSocket: client });
                  } finally {
                    activeUpgradeCallbacks--;
                    if (activeUpgradeCallbacks === 0)
                      for (const resolve of callbackWaiters.splice(0)) resolve();
                  }
                },
              },
            },
          ],
          log: new Log(LogLevel.DEBUG),
          handleStructuredLogs({ message }) {
            captureLog.logWithLevel(LogLevel.DEBUG, message);
          },
        });
        const requests = Array.from({ length: expected }, () =>
          mf
            .dispatchFetch(origin + "/auth/login", {
              method: "POST",
              headers: {
                Origin: origin,
                "Content-Type": "application/json",
                "X-Morrow-Request": "1",
              },
              body: JSON.stringify({ schemaVersion: 1, workspaceId: "workspace_a" }),
            })
            .then(async (response) => ({
              status: response.status,
              body: await response.text(),
              cookies: response.headers.getSetCookie().length,
              metrics: JSON.parse(response.headers.get("x-morrow-fixture-metrics") ?? "null"),
            })),
        );
        responses = await Promise.all(requests);
        bodyCompletedAt = performance.now();
        const responseChecksStart = checks.length;
        for (const response of responses) {
          const m = response.metrics?.response;
          check(
            definition.name +
              ":same_original_attempt_and_registered_cleanup_" +
              responses.indexOf(response),
            m?.attemptEnded === true &&
              m.initialDeadlineMs === m.enteredAtMs + 25000 &&
              m.finalDeadlineMs === m.enteredAtMs + 5000 &&
              m.scope?.publicationAttempts === 1 &&
              m.scope.publicationAccepted === 1 &&
              m.scope.publicationFailures === 0 &&
              m.scope.ownerMismatches === 0 &&
              m.scope.namespaceMismatches === 0 &&
              Object.values(m.pools ?? {}).length === 4 &&
              Object.values(m.pools).every((p) => p.normalReleases === 0),
          );
          if (definition.kind === "pending")
            check(
              definition.name + ":source_P_pending_at_handoff_" + responses.indexOf(response),
              m.scope.publishedPending === 1 && m.scope.publishedSettled === 0,
            );
          gate.ownerBodyCompleted();
          check(
            definition.name + ":finite_held_no_cookie_" + responses.indexOf(response),
            response.status === 503 &&
              response.body ===
                JSON.stringify({ schemaVersion: 1, outcome: "login_unavailable" }) &&
              response.cookies === 0,
          );
        }
        if (checks.slice(responseChecksStart).some((row) => !row.passed))
          throw Error("U_MANAGED_RESPONSE_PRECONDITION");
        stage = "source_settlement";
        if (definition.kind === "pending") {
          await gate.admitted;
          check(
            definition.name + ":held_while_source_cleanup_pending",
            settlement.length === 0 && gate.snapshot().acknowledgements === 0,
          );
          if (definition.lateGate) {
            await settled();
            // P already settled under its original C. A late provider acknowledgement
            // cannot be promoted to normal cleanup or supply source retention.
            const before = gate.snapshot();
            if (before.activeResponses > 0) {
              try {
                gate.open();
              } catch {}
            }
          } else if (!definition.stallGate) {
            gate.open(definition.rejectGate ? 503 : 200);
            if (!definition.rejectGate) await gate.completed;
          }
        }
        await settled();
        check(
          definition.name + ":exact_source_P_settled_once",
          settlement.length === expected &&
            settlement.every(
              (row) =>
                row.publicationAttempts === 1 &&
                row.publicationAccepted === 1 &&
                row.publicationFailures === 0 &&
                row.publishedPending === 0 &&
                row.publishedSettled === 1 &&
                row.ownerMismatches === 0 &&
                row.namespaceMismatches === 0,
            ),
        );
        if (
          definition.kind === "pending" &&
          !definition.stallGate &&
          !definition.lateGate &&
          !definition.rejectGate
        ) {
          await gate.responsesClosed();
          await brokerAckObserved();
          check(
            definition.name + ":post_response_read_ack_then_P_settlement",
            gate.snapshot().acknowledgements === expected &&
              brokerEvents.length === expected &&
              brokerEvents.every(
                (row) => row.inOriginalCleanup && row.observedAt > bodyCompletedAt,
              ) &&
              settlement.every((row) => row.observedAt > bodyCompletedAt) &&
              gate
                .snapshot()
                .events.filter((e) => e.name === "complete:read_validated")
                .every((e) => e.at > bodyCompletedAt),
          );
        }
        for (const callback of withheld.splice(0)) {
          try {
            callback();
          } catch {}
        }
        check(
          definition.name + ":no_post_hold_observer_or_retry",
          socketCalls === expected && oracle.snapshot().observerMetadata === 0,
        );
        if (definition.kind === "late101") await callbacksClosed();
        const wireAtOutcome = oracle.snapshot();
        check(
          definition.name + ":independent_protocol_fault_classification",
          definition.kind === "wrong_password"
            ? wireAtOutcome.authenticated === 0 && wireAtOutcome.protocolRejections === expected
            : wireAtOutcome.protocolRejections === 0,
        );
        if (definition.kind === "late101")
          check(
            definition.name + ":late_native_handle_after_finite_body_without_application_bytes",
            endpoints.length === 1 &&
              endpoints[0].createdAt > bodyCompletedAt &&
              wireAtOutcome.startups === 0,
          );
        if (definition.kind === "pending")
          check(
            definition.name + ":independently_accepted_business_query",
            wireAtOutcome.primaryMetadata === expected && wireAtOutcome.statements === expected,
          );
        check(
          definition.name + ":no_unexpected_egress",
          unexpected === 0 && gate.snapshot().unexpected === 0,
        );
      })(),
      12000,
    );
  } catch {
    failure = stage;
    check(definition.name + ":actual_case_held", false);
  } finally {
    natural = gate.snapshot();
    naturalSettlement = settlement.map((row) => ({ ...row }));
    naturalBrokerEvents = brokerEvents.map((row) => ({ ...row }));
    gate.beginForcedCleanup();
    gate.destroyOpenResponses();
    for (const [timer, cancel] of delayed) {
      clearTimeout(timer);
      cancel();
    }
    delayed.clear();
    for (const item of endpoints)
      if (!item.serverClosed || !item.clientClosed) {
        forcedCloses++;
        try {
          item.server.close(1000, "fixture disposal");
        } catch {}
        try {
          item.client.accept();
        } catch {}
        try {
          item.client.close(1000, "fixture orphan disposal");
        } catch {}
      }
    try {
      await bounded(
        (async () => {
          if (mf) {
            await mf.dispose();
            disposed = true;
          }
          await gate.responsesClosed();
          await Promise.all(endpoints.map((item) => item.closed));
        })(),
        5000,
      );
    } catch {
      failure ??= "cleanup_unknown";
    }
    for (const item of endpoints) for (const remove of item.removes.splice(0)) remove();
    gate.detachListeners();
  }
  const cleanup = gate.snapshot(),
    wire = oracle.snapshot();
  check(definition.name + ":runtime_disposal_acknowledged", disposed);
  check(
    definition.name + ":all_owned_gate_handles_and_pair_listeners_closed",
    cleanup.activeResponses === 0 &&
      cleanup.activeListeners === 0 &&
      pairListeners === 0 &&
      delayed.size === 0 &&
      activeUpgradeCallbacks === 0 &&
      endpoints.every((item) => item.serverClosed && item.clientClosed),
  );
  managedCases.push({
    name: definition.name,
    expected: "held",
    failure,
    responses,
    settlement: naturalSettlement,
    brokerEvents: naturalBrokerEvents,
    cleanupSettlement: settlement.map((row) => ({ ...row })),
    cleanupBrokerEvents: brokerEvents.map((row) => ({ ...row })),
    lateGateObservation: definition.lateGate
      ? naturalBrokerEvents.some((row) => !row.inOriginalCleanup)
        ? "late_ack_observed_not_source_success"
        : natural.naturalPrematureCloses > 0
          ? "native_cancellation_no_late_ack"
          : "late_open_attempt_ack_unknown"
      : null,
    bodyCompletedAt,
    natural,
    cleanup,
    wire,
    transport: {
      interceptedUpgrades: socketCalls,
      pairs: endpoints.length,
      serverClosed: endpoints.filter((p) => p.serverClosed).length,
      clientClosed: endpoints.filter((p) => p.clientClosed).length,
      forcedFixtureCloses: forcedCloses,
      activeListeners: pairListeners,
      activeUpgradeCallbacks,
      createdAfterOwnerBody: endpoints.filter((item) => item.createdAt > bodyCompletedAt).length,
    },
    runtimeDisposalAcknowledged: disposed,
  });
}
check("no_pending_host_watchdogs", timers.size === 0);
check(
  "all_source_bytes_unchanged",
  paths.every((p) => sourceDigests[p] === hash(readFileSync(p))),
);
const status =
  checks.every((c) => c.passed) &&
  cases.every((c) => c.failure === null) &&
  managedCases.every((c) => c.failure === null)
    ? "passed"
    : "held";
const report = {
  schema_version: 1,
  task: "P05.T01u",
  current_plan_sequence: 93,
  phase: "U01_unchanged_generic_and_U05_managed_native_request_lifetime",
  status,
  source_digests: sourceDigests,
  source_inventory_digest: hash(JSON.stringify(Object.entries(sourceDigests))),
  runtimeDependencyDigests,
  runtime: {
    node: process.version,
    miniflare: packageVersion("miniflare"),
    workerd: packageVersion("workerd"),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
  },
  checks,
  checkCount: checks.length,
  cases,
  caseCount: cases.length + managedCases.length,
  managedCases,
  sdkVersion,
  syntheticOnlyCoverage: [
    "explicit_duplicate_release_callers",
    "fake_ctx_registration_rejection",
    "forged_copied_or_swapped_scope_owners",
  ],
  nativeOutboundRequests:
    cases.reduce((n, c) => n + c.cleanup.interceptedRequests, 0) +
    managedCases.reduce((n, c) => n + c.transport.interceptedUpgrades + c.cleanup.callbacks, 0),
  unexpectedRequests:
    cases.reduce((n, c) => n + c.cleanup.requests.unexpected, 0) +
    managedCases.reduce((n, c) => n + c.cleanup.unexpected, 0),
  actualInternetRequests: 0,
  actualProviderRequests: 0,
  pendingHostTimers: timers.size,
  watchdogs: {
    genericCaseTotalMs: 8000,
    managedCaseTotalMs: 12000,
    cleanupOnlyMs: 5000,
    renewsApplicationAuthority: false,
  },
  limitations: [
    "Generic controls retain their exact production-import-free source. Managed rows use actual source handler, captured native SDK and independent PG-wire bytes, not a real SQL engine.",
    "Actual ctx provenance is trusted native module wiring. Expected waitUntil call count and exact completion-Promise identity are source-bound, not a host promise-inspection API.",
    "Raw premature ServerResponse close establishes observed subrequest cancellation; IncomingMessage close, physical TCP closure and runtime disposal are separate facts.",
    "Worker gate-read marker follows response delivery and gate body read. Host response finish is not direct observation of final marker-ack consumption or Promise settlement.",
    "Pool counters in response headers are snapshots before handoff. Later source settlement events contain scope counts only; post-settlement pool unverified behavior remains source-bound unless an actual pool snapshot captured it.",
    "Managed registration is observed before finite handoff; the fixed source console reaction observes original P settlement without another request or retained telemetry task. Settlement alone does not prove credential acknowledgement or late resource absence.",
    "The after-C row records a late-open attempt, actual read/ack only if observed, and native cancellation or unknown otherwise; it does not label an unobserved late acknowledgement as measured. Rejected, stalled and after-C credential acknowledgements remain conservative unknowns; forced fixture/runtime disposal cannot upgrade source cleanup. Cross-isolate SQL continuity, real browser, hosted and merchant qualification are separate.",
  ],
};
mkdirSync("docs/evidence/P05.T01v/regressions", { recursive: true });
const reportText = JSON.stringify(report, null, 2) + "\n";
if (privateMarkers.some((marker) => marker && reportText.includes(marker)))
  throw Error("U_MANAGED_SECRET_FENCE");
writeFileSync(reportPath, reportText, { flag: "wx" });
process.stdout.write(
  JSON.stringify({ report: reportPath, status, cases: cases.length, checks: checks.length }) + "\n",
);
if (status !== "passed") process.exitCode = 1;
