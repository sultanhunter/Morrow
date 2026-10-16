import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { createManagedLoginCleanupGate } from "./fixtures/managed-login-cleanup-gate.mjs";

if (process.version !== "v24.13.0") throw Error("U01_PINNED_NODE_REQUIRED");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageVersion = (name) =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
if (packageVersion("miniflare") !== "4.20260730.0" || packageVersion("workerd") !== "1.20260730.1")
  throw Error("U01_PINNED_RUNTIME_REQUIRED");
if (JSON.parse(readFileSync("docs/plan/source.json")).sources.plan.sequence !== 90)
  throw Error("U01_CURRENT90_REQUIRED");
const attempt = process.argv.slice(2);
if (attempt.length > 1 || (attempt.length && !/^--attempt=[a-z][a-z0-9-]{0,31}$/.test(attempt[0])))
  throw Error("U01_CLOSED_ATTEMPT_NAME_REQUIRED");
const reportPath =
  "docs/evidence/P05.T01u/native-first-proof" +
  (attempt.length ? "-" + attempt[0].slice(10) : "") +
  ".json";
if (existsSync(reportPath)) throw Error("U01_IMMUTABLE_REPORT_EXISTS");
const paths = [
  "scripts/fixtures/managed-login-lifetime-worker.ts",
  "scripts/fixtures/managed-login-cleanup-gate.mjs",
  "scripts/managed-login-lifetime-workers-lab.mjs",
  "tests/managed-login-cleanup-gate.test.mjs",
  "docs/packets/P05.T01u.md",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "package-lock.json",
];
const sourceDigests = Object.fromEntries(paths.sort().map((p) => [p, hash(readFileSync(p))]));
const dependencyPaths = [
  "node_modules/miniflare/package.json",
  "node_modules/miniflare/dist/src/index.js",
  "node_modules/workerd/package.json",
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
for (const name of ["negative", "positive"]) {
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
        mf = new Miniflare({
          modules: true,
          script: bundled.outputFiles[0].text,
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          upstream: "https://morrow-cleanup-owner.test",
          log: new Log(LogLevel.NONE),
          bindings: { NONCE: nonce },
          outboundService: { node: ownedGate.node },
        });
        stage = "owner_request";
        const response = await mf.dispatchFetch(`https://morrow-cleanup-owner.test/${name}`);
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
        stage = name === "negative" ? "natural_premature_close" : "post_response_completion";
        if (name === "negative") await ownedGate.cancellation;
        else {
          if (
            !check(
              "positive:gate_still_pending_after_body",
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
              (name === "negative"
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
    sourceExpectedWaitUntilCalls: name === "positive" ? 1 : 0,
    natural,
    cleanup,
    runtimeDisposalAcknowledged: disposed,
  });
}
check("no_pending_host_watchdogs", timers.size === 0);
check(
  "all_source_bytes_unchanged",
  paths.every((p) => sourceDigests[p] === hash(readFileSync(p))),
);
const status =
  checks.every((c) => c.passed) && cases.every((c) => c.failure === null) ? "passed" : "held";
const report = {
  schema_version: 1,
  task: "P05.T01u",
  current_plan_sequence: 90,
  phase: "U01_generic_native_request_lifetime_only",
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
  caseCount: cases.length,
  nativeOutboundRequests: cases.reduce((n, c) => n + c.cleanup.interceptedRequests, 0),
  unexpectedRequests: cases.reduce((n, c) => n + c.cleanup.requests.unexpected, 0),
  actualInternetRequests: 0,
  actualProviderRequests: 0,
  pendingHostTimers: timers.size,
  watchdogs: { caseTotalMs: 8000, cleanupOnlyMs: 5000, renewsApplicationAuthority: false },
  limitations: [
    "Generic platform fixture only, with no production imports, SQL, crypto, SDK, provider or managed request handler.",
    "Actual ctx provenance is trusted native module wiring. Expected waitUntil call count and exact completion-Promise identity are source-bound, not a host promise-inspection API.",
    "Raw premature ServerResponse close establishes observed subrequest cancellation; IncomingMessage close, physical TCP closure and runtime disposal are separate facts.",
    "Worker gate-read marker follows response delivery and gate body read. Host response finish is not direct observation of final marker-ack consumption or Promise settlement.",
    "No application cleanup, original D/C, managed key continuity, browser, hosted or merchant qualification follows from this generic proof.",
  ],
};
mkdirSync("docs/evidence/P05.T01u", { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify({ report: reportPath, status, cases: cases.length, checks: checks.length }) + "\n",
);
if (status !== "passed") process.exitCode = 1;
