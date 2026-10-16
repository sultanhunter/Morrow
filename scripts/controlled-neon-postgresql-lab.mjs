import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import {
  controlledNeonPostgresqlLab,
  resolveControlledNeonPostgresqlEndpoint,
} from "./fixtures/controlled-neon-postgresql.mjs";
import { createControlledNeonTcpService } from "./fixtures/controlled-neon-tcp-bridge.mjs";
import { createPgFrontendParser } from "./fixtures/controlled-neon-pg-wire-oracle.mjs";
import { createSelfLogoutFixtureHarness } from "./fixtures/self-logout-fixture.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import { createBoundedLoginCookieJar } from "./fixtures/login-https.mjs";

const hash = (v) => createHash("sha256").update(v).digest("hex");
const paths = [
  "scripts/controlled-neon-postgresql-lab.mjs",
  "scripts/fixtures/controlled-neon-postgresql.mjs",
  "scripts/fixtures/controlled-neon-tcp-bridge.mjs",
  "scripts/fixtures/controlled-neon-postgresql-worker.ts",
  "scripts/fixtures/controlled-neon-pg-wire-oracle.mjs",
  "tests/controlled-neon-tcp-bridge.test.mjs",
  "packages/identity/src/controlled-neon-login-pool.ts",
  "packages/identity/src/controlled-neon-login-profiles.ts",
  "packages/identity/src/controlled-neon-transport.ts",
  "packages/identity/src/fixed-workos-login-port.ts",
  "packages/identity/src/standalone-login.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/login-preauth-control.ts",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-workspace-selection.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "scripts/fixtures/fixed-workos-platform-provider.mjs",
  "scripts/fixtures/fixed-workos-provider.mjs",
  "scripts/fixtures/self-logout-fixture.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/identity-logout-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "docs/packets/P05.T01t.md",
  "package.json",
  "package-lock.json",
  "node_modules/@neondatabase/serverless/package.json",
  "node_modules/@neondatabase/serverless/index.mjs",
];
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
if (manifest.migrations.length !== 11) throw Error("CONTROLLED_PG_ORIGINAL_MIGRATIONS_REQUIRED");
for (const [i, row] of manifest.migrations.entries()) {
  if (row.sequence !== i + 1 || hash(readFileSync("migrations/" + row.file)) !== row.sha256)
    throw Error("CONTROLLED_PG_MIGRATION_DRIFT");
  paths.push("migrations/" + row.file);
}
const sourceDigests = Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
const sourceMap = Object.fromEntries(
  Object.entries(sourceDigests).filter(([path]) => !path.startsWith("node_modules/")),
);
const runtimeDependencyDigests = Object.fromEntries(
  Object.entries(sourceDigests).filter(([path]) => path.startsWith("node_modules/")),
);
const neonVersion = JSON.parse(
  readFileSync("node_modules/@neondatabase/serverless/package.json", "utf8"),
).version;
if (neonVersion !== "1.2.0") throw Error("CONTROLLED_PG_PINNED_SDK_REQUIRED");
const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan;
if (
  plan.sequence !== 89 ||
  hash(readFileSync(plan.path)) !== plan.sha256 ||
  process.version !== "v24.13.0"
)
  throw Error("CONTROLLED_PG_CURRENT89_REQUIRED");
const checks = [];
let stage = "source",
  appliedMigrations = 0,
  failure,
  measured,
  firstBeginDiagnostic = null,
  cleanupFailure,
  workerDisposed = false,
  bridgesClosed = false,
  service,
  mf,
  workerDisposalPromise,
  bridgeDisposalPromise;
const cleanupFailures = [];
function disposeWorkerOnce() {
  if (workerDisposalPromise) return workerDisposalPromise;
  if (!mf) return Promise.resolve();
  const owned = mf;
  workerDisposalPromise = Promise.resolve()
    .then(() => owned.dispose())
    .then(() => {
      workerDisposed = true;
      mf = undefined;
    });
  return workerDisposalPromise;
}
function disposeBridgeOnce() {
  if (bridgeDisposalPromise) return bridgeDisposalPromise;
  if (!service) return Promise.resolve();
  const owned = service;
  bridgeDisposalPromise = Promise.resolve()
    .then(() => owned.close())
    .then(() => {
      bridgesClosed = true;
    });
  return bridgeDisposalPromise;
}
async function observeRequestCleanup() {
  const results = await Promise.allSettled([workerDisposalPromise, bridgeDisposalPromise]);
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const code = index === 0 ? "worker_disposal_held" : "bridge_closure_held";
    cleanupFailure ??= code;
    if (!cleanupFailures.includes(code)) cleanupFailures.push(code);
  }
}
function check(name, value) {
  if (!/^[a-z][a-z0-9_]{1,119}$/.test(name) || checks.some((c) => c.name === name))
    throw Error("CONTROLLED_PG_CHECK_NAME");
  checks.push({ name, passed: value === true });
  if (value !== true) throw Error("CONTROLLED_PG_CHECK_HELD");
}
const phase = (value) => {
  stage = value;
  console.error("CONTROLLED_PG_PHASE:" + value);
};
const poolNames = ["loginPool", "preauthPool", "selectionPool", "sessionPool"];
const roles = [
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_resolution",
  "morrow_identity_sessions",
];
const binding = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-controlled-lab",
  branchId: "br-controlled-lab",
  hostname: "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const privateMarkers = [];
try {
  measured = await controlledNeonPostgresqlLab(async (engine) => {
    try {
      phase("setup_and_migrations");
      const migrationStatements = new Map(
        manifest.migrations.map((row) => [
          "SET ROLE morrow_identity_owner;\n" + readFileSync("migrations/" + row.file, "utf8"),
          row.sequence,
        ]),
      );
      const setupSql = (text, database) => {
        const sequence = migrationStatements.get(text);
        if (sequence !== undefined && sequence !== appliedMigrations + 1)
          throw Error("CONTROLLED_PG_MIGRATION_ACCOUNTING_HELD");
        const result = engine.sql(text, database);
        if (sequence !== undefined) appliedMigrations = sequence;
        return result;
      };
      const harness = createSelfLogoutFixtureHarness({ id: engine.id, sql: setupSql }),
        origin = "https://127.0.0.1";
      const configurations = Array.from({ length: 2 }, () => harness.configured({ origin }));
      const oracles = configurations.map((c) =>
        createPlatformWorkosProviderOracle({
          configurationJson: c.configurationJson,
          subjectId: c.f.subject,
          providerSessionId: c.f.sid,
          now: Date.now,
        }),
      );
      let activeOracle = oracles[0],
        orphanRequests = 0;
      const auth = await engine.sealSetup();
      check(
        "actual_internal_network_owned_endpoint_topology",
        engine.topology.internalNetwork &&
          engine.topology.noPublishedPorts &&
          engine.topology.ownedContainerEndpointAttested &&
          engine.topology.sameHostReachability &&
          engine.topology.sourceMatchedGateway &&
          engine.topology.ipv4NoDefaultRouteMeasured &&
          engine.topology.singleOwnedNetworkEndpoint,
      );
      check(
        "actual_scram_four_roles_and_tcp_admin_denial",
        auth.scramOfferedRoles === 4 &&
          auth.tcpAdministratorRejected &&
          auth.tcpOwnerRejected &&
          auth.probeConnectionsClosed === 6,
      );
      check(
        "actual_owned_endpoint_capability_identity",
        resolveControlledNeonPostgresqlEndpoint(engine.endpoint) !== null &&
          resolveControlledNeonPostgresqlEndpoint(Object.freeze({ ...engine.endpoint })) === null,
      );
      privateMarkers.push(...Object.values(engine.passwordByRole));
      const frontend = new Map(),
        backend = new Map();
      service = createControlledNeonTcpService({
        endpoint: engine.endpoint,
        hostname: binding.hostname,
        onClientBytes(bytes, observation) {
          let parser = frontend.get(observation.index);
          if (!parser) {
            parser = createPgFrontendParser({
              onStartup(startup) {
                observation.startup = startup.parameters;
                if (
                  !roles.includes(startup.parameters.user) ||
                  startup.parameters.database !== "morrow" ||
                  !/^morrow_t88_[a-f0-9]{32}_[po]$/.test(startup.parameters.application_name)
                )
                  throw Error("CONTROLLED_PG_STARTUP_HELD");
              },
              onMessage(message) {
                observation.messages.push(message.type);
                if (message.type === "P") {
                  observation.statement = message.text;
                }
                if (message.type === "Q") {
                  (observation.executions ??= []).push({ text: message.text, values: [] });
                }
                if (message.type === "B") {
                  (observation.executions ??= []).push({
                    text: observation.statement,
                    values: [...message.parameters],
                  });
                }
              },
            });
            frontend.set(observation.index, parser);
          }
          try {
            parser.push(bytes);
          } catch {
            observation.parseFailure = true;
            throw Error("CONTROLLED_PG_FRONTEND_OBSERVATION_HELD");
          }
        },
        onServerBytes(bytes, observation) {
          let data = Buffer.concat([
            backend.get(observation.index) ?? Buffer.alloc(0),
            Buffer.from(bytes),
          ]);
          if (data.length > 262144) throw Error("CONTROLLED_PG_BACKEND_OBSERVATION_HELD");
          while (data.length >= 5) {
            const size = data.readInt32BE(1);
            if (size < 4 || size > 262144) throw Error("CONTROLLED_PG_BACKEND_FRAME_HELD");
            if (data.length < size + 1) break;
            if (data[0] === 82 && size >= 8 && data.readInt32BE(5) === 10)
              observation.authenticationSasl = true;
            if (data[0] === 69) {
              const fields = data
                .subarray(5, size + 1)
                .toString("utf8")
                .split("\0");
              if (fields.includes("C28P01")) observation.passwordRejected = true;
            }
            data = data.subarray(size + 1);
          }
          backend.set(observation.index, Buffer.from(data));
        },
      });
      phase("worker_bundle");
      const bundled = await build({
        entryPoints: ["scripts/fixtures/controlled-neon-postgresql-worker.ts"],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        external: [
          "node:crypto",
          "node:events",
          "node:buffer",
          "node:util",
          "node:stream",
          "node:net",
          "node:tls",
          "node:dns",
        ],
        metafile: true,
      });
      check(
        "no_dynamic_runtime_schema_compilation",
        !Object.keys(bundled.metafile.inputs).some((path) =>
          /ajv\/dist\/(compile|core|2020)/.test(path),
        ),
      );
      mf = new Miniflare({
        upstream: origin,
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        log: new Log(LogLevel.NONE),
        bindings: {
          SETUP_JSON: JSON.stringify({
            bindingJson: JSON.stringify(binding),
            expectedHostSource: engine.expectedHostSource,
            passwordByRole: engine.passwordByRole,
            cases: configurations.map((c) => ({
              configurationJson: c.configurationJson,
              workspaceId: c.f.workspace,
            })),
          }),
        },
        outboundService(request) {
          const url = new URL(request.url);
          if (url.hostname === binding.hostname) return service.outbound(request);
          if (url.origin === "https://api.workos.com" && activeOracle)
            return activeOracle.handleRequest(request);
          orphanRequests++;
          throw Error("CONTROLLED_PG_UNEXPECTED_OUTBOUND");
        },
      });
      const dispatch = (path, options = {}) =>
        mf.dispatchFetch(origin + path, { redirect: "manual", ...options });
      const json = async (path, input) => {
        const response = await dispatch(
          path,
          input === undefined
            ? {}
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
              },
        );
        check("fixture_dispatch_" + checks.length, response.status === 200);
        return response.json();
      };
      phase("four_role_connection_and_visibility");
      const probes = [],
        visibility = [],
        authority = [];
      for (const name of poolNames) {
        const probe = await json("/__fixture/probe/" + name);
        check(
          "actual_role_and_normal_disposal_" + name.toLowerCase(),
          probe.normalRelease &&
            probe.leases.activeLeases === 0 &&
            probe.leases.borrows === probe.leases.releaseCompletions,
        );
        const sourceAddress = await json("/__fixture/source-address/" + name);
        check(
          "actual_pg_client_source_matches_gateway_" + name.toLowerCase(),
          sourceAddress.serverSourceMatchedGateway === true &&
            sourceAddress.role === probe.role &&
            sourceAddress.clientEndAcknowledged === true,
        );
        probes.push({
          ...probe,
          serverSourceMatchedGateway: sourceAddress.serverSourceMatchedGateway,
          sourceClientEndAcknowledged: sourceAddress.clientEndAcknowledged,
        });
        const visible = await json("/__fixture/visibility/" + name);
        check(
          "same_role_self_row_live_primary_and_microseconds_" + name.toLowerCase(),
          visible.livePrimaryVisible && visible.selfRowValid && visible.truncatedRejected,
        );
        visibility.push(visible);
        const denied = await json("/__fixture/authority/" + name);
        check(
          "real_database_restricted_privileges_" + name.toLowerCase(),
          denied.denied.table && denied.denied.maintenance && denied.denied.ownerRole,
        );
        authority.push(denied);
      }
      const wrongPassword = await json("/__fixture/wrong-password");
      check(
        "actual_wrong_scram_password_denied",
        wrongPassword.denied === true && service.observations.some((o) => o.passwordRejected),
      );
      const allExecutions = () =>
        service.observations.flatMap((o) =>
          (o.executions ?? []).map((e) => ({ ...e, role: o.startup?.user })),
        );
      const mAdmissions = () =>
        allExecutions().filter((e) => e.text?.includes("morrow_identity.admit_browser_family("));
      const flowIntents = () =>
        allExecutions().filter((e) =>
          e.text?.includes("morrow_identity.create_login_flow_intent("),
        );
      const initialize = async (index, mode = "normal") => {
        activeOracle = oracles[index];
        await json("/__fixture/initialize", { index, mode });
      };
      let flowSerial = 0;
      async function start(index) {
        const jar = createBoundedLoginCookieJar();
        const response = await dispatch("/auth/login", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
          body: JSON.stringify({
            schemaVersion: 1,
            workspaceId: configurations[index].f.workspace,
          }),
        });
        const diagnostic =
          flowSerial === 0
            ? (firstBeginDiagnostic = {
                responseStatus: response.status,
                cookieCount: response.headers.getSetCookie().length,
                jarAccepted: null,
                jarRejected: null,
              })
            : null;
        const acceptCookie = () => {
          const result = jar.ingest(origin + "/auth/login", response.headers);
          if (diagnostic) {
            diagnostic.jarAccepted = result.accepted;
            diagnostic.jarRejected = result.rejected;
          }
          return result.accepted === 1;
        };
        check(
          "actual_84_begin_cookie_" + ++flowSerial,
          response.status === 200 && response.headers.getSetCookie().length === 1 && acceptCookie(),
        );
        const authorizationUrl = (await response.json()).authorizationUrl;
        const callback = activeOracle.arm(authorizationUrl);
        privateMarkers.push(callback.code, callback.token, authorizationUrl);
        return { jar, callback, serial: flowSerial };
      }
      async function finish(prepared, success = true) {
        const url = new URL(prepared.callback.callbackUrl);
        const headers = {
          Cookie: prepared.jar.header(prepared.callback.callbackUrl),
          "Sec-Fetch-Mode": "navigate",
          "MF-Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Site": "cross-site",
        };
        const response = await dispatch(url.pathname + url.search, { headers });
        const body = await response.text();
        check(
          "actual_84_callback_delivery_" + prepared.serial,
          response.status === 303 &&
            body === "" &&
            response.headers.get("location") === (success ? "/" : "/auth/result") &&
            response.headers.getSetCookie().length === (success ? 1 : 0),
        );
        if (success) {
          check(
            "actual_m_initial_session_cookie_" + prepared.serial,
            prepared.jar.ingest(prepared.callback.callbackUrl, response.headers).accepted === 1,
          );
          const secret = /(?:^|; )__Host-morrow_session=([^;]+)/.exec(
            prepared.jar.header(origin + "/"),
          )?.[1];
          check(
            "canonical_fresh_cookie_" + prepared.serial,
            typeof secret === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(secret),
          );
          privateMarkers.push(secret);
          return { path: url.pathname + url.search, headers, secret };
        }
        return { path: url.pathname + url.search, headers };
      }
      phase("full_unchanged_owning_chain");
      await initialize(0);
      const prepared = await start(0),
        completed = await finish(prepared);
      const beforeReplay = activeOracle.metrics.exchange;
      const replay = await dispatch(completed.path, { headers: completed.headers });
      check(
        "callback_replay_no_cookie_or_provider_exchange",
        replay.status === 303 &&
          replay.headers.get("location") === "/auth/result" &&
          replay.headers.getSetCookie().length === 0 &&
          activeOracle.metrics.exchange === beforeReplay,
      );
      await replay.body?.cancel();
      const normal = await json("/__fixture/metrics");
      check(
        "all_four_owning_pools_used_and_timely",
        poolNames.every(
          (name) =>
            normal.pool[name].normalReleases > 0 &&
            normal.pool[name].primaryAttributions === normal.pool[name].primaryAbsenceVerified &&
            normal.pool[name].activeLeases === 0,
        ),
      );
      phase("concurrent_independent_callbacks");
      const [left, right] = await Promise.all([start(0), start(0)]);
      const results = await Promise.all([finish(left), finish(right)]);
      check("concurrent_distinct_owning_cookies", results[0].secret !== results[1].secret);
      phase("unknown_release_and_real_reconciliation");
      await initialize(1, "session_release_reject");
      const uncertain = await start(1);
      await finish(uncertain, false);
      const unknownBeforeFinalAdmin = await json("/__fixture/metrics");
      check(
        "committed_issuer_release_unknown_before_admin",
        unknownBeforeFinalAdmin.pool.sessionPool.heldClients === 1 &&
          unknownBeforeFinalAdmin.pool.sessionPool.normalReleases === 0 &&
          unknownBeforeFinalAdmin.pool.sessionPool.primaryAbsenceVerified === 1 &&
          unknownBeforeFinalAdmin.pool.sessionPool.leaseReleaseAttempts === 1 &&
          unknownBeforeFinalAdmin.pool.sessionPool.leaseReleaseAcks === 0 &&
          unknownBeforeFinalAdmin.leases.activeLeases === 1,
      );
      const admission = mAdmissions().at(-1);
      check(
        "actual_issuer_wire_parameters_observed",
        Array.isArray(admission?.values) && admission.values.length === 27,
      );
      const reconciled = await json("/__fixture/reconcile", {
        commandId: admission.values[0],
        requestDigest: admission.values[1],
      });
      check(
        "real_m_reconciles_commit_without_secret",
        reconciled.outcome === "replayed" &&
          reconciled.attributed === true &&
          reconciled.secretReturned === false,
      );
      const intent = flowIntents().at(-1);
      check(
        "actual_flow_custody_wire_parameters_observed",
        Array.isArray(intent?.values) && intent.values.length === 6,
      );
      const flowReconciled = await json("/__fixture/flow-reconcile", {
        schemaVersion: 1,
        configurationDigest: intent.values[0],
        flowId: intent.values[1],
        beginCommandId: intent.values[2],
        admissionCommandId: intent.values[3],
        issuerCommandId: intent.values[4],
      });
      check(
        "real_flow_readonly_reconciles_issuer_effect",
        flowReconciled.outcome === "observed" &&
          flowReconciled.phase === "claimed" &&
          flowReconciled.issuerOutcome === "admitted" &&
          flowReconciled.hasFamily === true,
      );
      phase("request_proof_before_final_admin");
      for (const [index, o] of service.observations.entries()) {
        check(
          "wire_startup_exact_restricted_role_" + index,
          roles.includes(o.startup?.user) &&
            o.startup.database === "morrow" &&
            o.authenticationSasl === true &&
            !o.parseFailure,
        );
      }
      check(
        "real_database_each_restricted_role_observed",
        roles.every((role) => service.observations.some((o) => o.startup?.user === role)),
      );
      check(
        "actual_native_transport_without_provider_or_escape",
        service.counts().interceptedRequests > 0 &&
          service.counts().deniedRequests === 0 &&
          orphanRequests === 0 &&
          oracles.every(
            (o) =>
              o.metrics.actualInternetRequests === 0 &&
              o.metrics.actualProviderRequests === 0 &&
              o.metrics.oracleFailures === 0,
          ),
      );
      const beforeEndpointCleanup = service.bridges.map((b) => ({ ...b.metrics }));
      const transport = service.counts();
      const beforeRevokedBridges = service.bridges.length,
        beforeRevokedObservations = service.observations.length;
      engine.revokeEndpoint();
      const endpointCapabilityRevoked =
        resolveControlledNeonPostgresqlEndpoint(engine.endpoint) === null;
      check("owned_endpoint_allocation_capability_revoked", endpointCapabilityRevoked);
      const refused = service.outbound(
        new Request(
          "https://" +
            binding.hostname +
            "/v2?address=" +
            encodeURIComponent(binding.hostname + ":5432"),
          { headers: { Upgrade: "websocket" } },
        ),
      );
      const afterRevoked = service.counts();
      const revokedCapabilityDenial = {
        status: refused.status,
        deniedRequestsAdded: afterRevoked.deniedRequests - transport.deniedRequests,
        interceptedRequestsAdded: afterRevoked.interceptedRequests - transport.interceptedRequests,
        pairAllocationsAdded: afterRevoked.pairAllocations - transport.pairAllocations,
        tcpBridgesAdded: service.bridges.length - beforeRevokedBridges,
        observationRowsAdded: service.observations.length - beforeRevokedObservations,
      };
      check(
        "revoked_endpoint_denied_before_pair_or_tcp",
        revokedCapabilityDenial.status === 403 &&
          revokedCapabilityDenial.deniedRequestsAdded === 1 &&
          revokedCapabilityDenial.interceptedRequestsAdded === 0 &&
          revokedCapabilityDenial.pairAllocationsAdded === 0 &&
          revokedCapabilityDenial.tcpBridgesAdded === 0 &&
          revokedCapabilityDenial.observationRowsAdded === 0,
      );
      await disposeWorkerOnce();
      await disposeBridgeOnce();
      check(
        "all_worker_ws_and_tcp_endpoints_closed",
        service.bridges.every(
          (b) =>
            b.metrics.tcpClosed &&
            b.metrics.webSocketClosed &&
            !b.metrics.timerActive &&
            b.metrics.pendingBytes === 0,
        ),
      );
      for (const parser of frontend.values()) parser.finish();
      check(
        "all_frontend_frames_complete",
        service.observations.every((o) => !o.parseFailure),
      );
      check(
        "all_backend_frames_complete",
        [...backend.values()].every((b) => b.length === 0),
      );
      phase("independent_final_fixture_namespace");
      const finalNamespace = await engine.observeFinalNamespace();
      check(
        "final_admin_not_needed_to_repair_any_backend",
        finalNamespace.presentBeforeFinalCleanup === 0 &&
          finalNamespace.absentAfterFinalCleanup &&
          finalNamespace.forcedFinalCleanup === false,
      );
      await harness.close();
      const wire = service.observations.map((o) => ({
        role: o.startup.user,
        observer: o.startup.application_name.endsWith("_o"),
        authenticationSasl: o.authenticationSasl,
        passwordRejected: o.passwordRejected === true,
        frontendMessages: o.messages.length,
        statements: (o.executions ?? []).length,
        parseFailure: o.parseFailure,
      }));
      return {
        engine: { image: engine.image, version: engine.version, topology: engine.topology, auth },
        endpointCapabilityRevoked,
        revokedCapabilityDenial,
        probes,
        visibility,
        authority,
        wrongPassword,
        normal,
        unknownBeforeFinalAdmin,
        reconciled,
        flowReconciled,
        wire,
        transport,
        beforeEndpointCleanup,
        endpointCleanup: service.bridges.map((b) => ({ ...b.metrics })),
        provider: oracles.map((o) => ({ metrics: o.metrics, calls: o.calls })),
        finalNamespace,
      };
    } finally {
      // Publish each disposal promise before it can call back. Failure must
      // release request resources before this callback rejects to Docker cleanup.
      engine.revokeEndpoint();
      disposeWorkerOnce();
      disposeBridgeOnce();
      await observeRequestCleanup();
    }
  });
  check(
    "owned_container_and_internal_network_absent",
    measured.cleanup.container === "absent" && measured.cleanup.network === "absent",
  );
} catch (error) {
  failure = {
    stage,
    code: "CONTROLLED_NEON_POSTGRESQL_LAB_HELD",
    observation: error?.observation ?? null,
  };
} finally {
  // Join the already-published attempts; never retry an unknown disposal.
  await observeRequestCleanup();
}
for (const [path, digest] of Object.entries(sourceDigests))
  check(
    "source_unchanged_" +
      path
        .toLowerCase()
        .replaceAll(/[^a-z0-9]/g, "_")
        .slice(-100),
    hash(readFileSync(path)) === digest,
  );
const report = {
  schema_version: 1,
  task: "P05.T01t",
  current_plan_sequence: 89,
  status: failure || cleanupFailure ? "held" : "passed",
  scope:
    "actual_captured_Workers_WebSocket_to_attested_owned_internal_IPv4_and_real_PostgreSQL17_four_roles_unchanged84_owners",
  checkCount: checks.length,
  checks,
  source_digests: sourceMap,
  source_inventory_digest: hash(
    JSON.stringify(Object.entries(sourceMap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  ),
  runtimeDependencyDigests,
  runtime: {
    node: process.version,
    neon: neonVersion,
    miniflare: "4.20260730.0",
    workerd: "1.20260730.1",
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
  },
  appliedMigrations,
  actualInternetRequests: 0,
  actualProviderRequests: 0,
  merchantActivation: false,
  hostedNeonQualified: false,
  nativeNodeProductionWssQualified: false,
  failure: failure ?? null,
  cleanupFailure: cleanupFailure ?? null,
  cleanupFailures,
  cleanup: {
    workerRuntimeDisposalAcknowledged: workerDisposed,
    allBridgeEndpointsAcknowledged: bridgesClosed,
  },
  measured: measured ?? null,
  firstBeginDiagnostic,
  limitations: [
    "Native WSS destination is fully locally intercepted; no remote DNS/TLS/Neon account/proxy qualification.",
    "Only this new fixture uses an attested owned internal IPv4 endpoint with no published ports; host access remains possible and old network-none laboratories are unchanged.",
    "Intentional lease-release rejection stays unknown before and after independent final fixture cleanup.",
    "No browser-engine, hosted identity/roles/migrations, real WorkOS/Shopify, application deployment or merchant activation.",
  ],
};
const serialized = JSON.stringify(report, null, 2) + "\n";
if (
  privateMarkers.some(
    (marker) => typeof marker === "string" && marker.length > 30 && serialized.includes(marker),
  )
)
  throw Error("CONTROLLED_PG_PRIVATE_REPORT_HELD");
mkdirSync("docs/evidence/P05.T01t/canonical89", { recursive: true });
writeFileSync("docs/evidence/P05.T01t/canonical89/postgresql-workers-lab.json", serialized);
if (failure || cleanupFailure) throw Error("CONTROLLED_NEON_POSTGRESQL_LAB_HELD:" + stage);
console.log(
  "PASS: " +
    checks.length +
    " actual Workers/SDK/PostgreSQL four-role checks; original owner/SQL bodies preserved; actualInternet/provider0.",
);
