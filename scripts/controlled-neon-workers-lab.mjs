import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import {
  createControlledNeonPgOracle,
  controlledNeonExpectedScript,
  controlledNeonWireSql,
} from "./fixtures/controlled-neon-pg-wire-oracle.mjs";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse, WebSocketPair } from "miniflare";
import { writeArtifact } from "./artifacts.mjs";

if (process.version !== "v24.13.0") throw Error("PINNED_NODE_REQUIRED");
const sdkPackage = JSON.parse(readFileSync("node_modules/@neondatabase/serverless/package.json"));
if (sdkPackage.version !== "1.2.0") throw Error("PINNED_NEON_SDK_REQUIRED");
if (JSON.parse(readFileSync("docs/plan/source.json")).sources.plan.sequence !== 94)
  throw Error("CURRENT94_REQUIRED");
const hostname = "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech";
const syntheticPasswordMarker = ["MorrowSynthetic", "T88", "PG", "password", "only"].join("-");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const paths = [
  "scripts/fixtures/controlled-neon-worker.ts",
  "scripts/fixtures/controlled-neon-pg-wire-oracle.mjs",
  "scripts/controlled-neon-workers-lab.mjs",
  "tests/controlled-neon-pg-wire-oracle.test.mjs",
  "docs/packets/P05.T01t.md",
  "docs/packets/P05.T01u.md",
  "docs/packets/P05.T01v.md",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  "package-lock.json",
  "packages/identity/src/controlled-neon-login-pool.ts",
  "packages/identity/src/controlled-neon-login-profiles.ts",
  "packages/identity/src/controlled-neon-transport.ts",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/workos-workspace-selection.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
];
const sourceDigests = Object.fromEntries(
  paths.sort().map((path) => [path, hash(readFileSync(path))]),
);
const checks = [],
  cases = [],
  servers = [],
  pendingTimers = new Set();
const check = (name, passed) => {
  checks.push({ name, passed });
  if (!passed) throw Error("CONTROLLED_NEON_LAB_HELD:" + name);
};
const wait = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      resolve();
    }, ms);
    pendingTimers.add(timer);
  });
let current,
  intercepts = 0,
  unexpectedRequests = 0,
  disposed = false,
  failure;
const bundled = await build({
  entryPoints: ["scripts/fixtures/controlled-neon-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*"],
  metafile: true,
});
const mf = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.NONE),
  serviceBindings: {
    CONTROL: async (request) => {
      const owner = current,
        url = new URL(request.url);
      const handshake = url.pathname === "/handshake";
      if (
        !owner ||
        request.method !== "GET" ||
        url.origin !== "http://fixture-control" ||
        url.search ||
        (handshake
          ? !(owner.mode === "late_abort" || owner.delay101)
          : url.pathname !== "/accepted" || !owner.sdk || !owner.gate)
      ) {
        unexpectedRequests++;
        return new Response(null, { status: 503 });
      }
      owner.coordinationCalls++;
      const accepted = handshake ? "handshakeAccepted" : "gateAccepted",
        waiters = handshake ? owner.handshakeWaiters : owner.gateWaiters;
      if (owner[accepted]) return new Response(null, { status: 204 });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          owner.gateTimeouts++;
          waiters.delete(ack);
          resolve(new Response(null, { status: 503 }));
        }, 750);
        pendingTimers.add(timer);
        const ack = () => {
          clearTimeout(timer);
          pendingTimers.delete(timer);
          waiters.delete(ack);
          resolve(new Response(null, { status: 204 }));
        };
        waiters.add(ack);
      });
    },
  },
  outboundService: async (request) => {
    intercepts++;
    const owner = current;
    if (!owner) {
      unexpectedRequests++;
      throw Error("UNEXPECTED_NATIVE_WS_REQUEST");
    }
    owner.intercepts++;
    const url = new URL(request.url);
    if (
      url.origin !== "https://" + hostname ||
      url.pathname !== "/v2" ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].join(",") !== "address" ||
      url.searchParams.get("address") !== hostname + ":5432" ||
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      unexpectedRequests++;
      throw Error("UNEXPECTED_NATIVE_WS_REQUEST");
    }
    owner.handshakeAccepted = true;
    for (const ack of [...owner.handshakeWaiters]) ack();
    if (owner.status !== 101)
      return new MiniflareResponse(null, {
        status: owner.status,
        headers:
          owner.status >= 300
            ? {
                Location: owner.foreign
                  ? "https://foreign.invalid/never-follow"
                  : "https://" + hostname + "/never-follow",
              }
            : {},
      });
    if (owner.mode === "late_abort" || owner.delay101) await wait(100);
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    const protocol = owner.sdk
      ? owner.oracle.accept({
          send: (data) => server.send(data),
          close: () => server.close(1000, "postgres terminate"),
        })
      : undefined;
    const item = { server, client, owner, serverClosed: false, pairClientClosed: false };
    servers.push(item);
    owner.pairs++;
    owner.serverAccepted++;
    // The returned end remains unaccepted. Miniflare's real Upgrade bridge owns it.
    server.accept();
    owner.listeners += 3;
    const onMessage = (event) => {
      const value =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
            : undefined;
      if (!value) {
        owner.invalidFrames++;
        server.close(1003, "binary required");
        return;
      }
      owner.frames++;
      owner.bytes += value.byteLength;
      if (protocol) {
        try {
          protocol.receive(Uint8Array.from(value));
        } catch {
          owner.protocolRejections++;
          try {
            server.close(1000, "owned protocol refusal");
          } catch {}
        }
      } else server.send(Uint8Array.from(value));
    };
    const onServerClose = () => {
      if (!item.serverClosed) {
        item.serverClosed = true;
        owner.serverClosed++;
        protocol?.transportClosed();
      }
      server.removeEventListener("message", onMessage);
      server.removeEventListener("close", onServerClose);
      owner.listeners -= 2;
      try {
        if (owner.fault !== "withheld_close") server.close(1000, "fixture peer closure");
      } catch {
        /* Observed close is not another acknowledgement. */
      }
    };
    const onClientClose = () => {
      if (!item.pairClientClosed) {
        item.pairClientClosed = true;
        owner.pairClientClosed++;
      }
      client.removeEventListener("close", onClientClose);
      owner.listeners--;
    };
    server.addEventListener("message", onMessage);
    server.addEventListener("close", onServerClose);
    client.addEventListener("close", onClientClose);
    if (owner.mode === "server_close") {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        server.close(1000, "server initiated");
      }, 20);
      pendingTimers.add(timer);
    }
    return new MiniflareResponse(null, { status: 101, webSocket: client });
  },
});

const nativeCases = [
  { name: "native_binary_roundtrip", mode: "echo", status: 101 },
  { name: "native_non101_200", mode: "status", status: 200 },
];
for (const status of [301, 302, 303, 307, 308])
  for (const foreign of [false, true])
    nativeCases.push({
      name: "native_non101_" + status + (foreign ? "_foreign" : "_same_host"),
      mode: "status",
      status,
      foreign,
    });
nativeCases.push(
  { name: "native_late101_after_abort", mode: "late_abort", status: 101 },
  { name: "native_constructor_reject_no_request", mode: "constructor_reject", status: 101 },
  { name: "native_server_initiated_close", mode: "server_close", status: 101 },
);

try {
  for (const c of nativeCases) {
    current = {
      ...c,
      intercepts: 0,
      pairs: 0,
      serverAccepted: 0,
      serverClosed: 0,
      pairClientClosed: 0,
      frames: 0,
      bytes: 0,
      invalidFrames: 0,
      forcedFixtureCloses: 0,
      forcedClientAcceptAttempts: 0,
      forcedClientAcceptSuccesses: 0,
      forcedClientAcceptRejections: 0,
      forcedClientCloseAttempts: 0,
      forcedClientCloseRejections: 0,
      listeners: 0,
      coordinationCalls: 0,
      gateTimeouts: 0,
      handshakeAccepted: false,
      handshakeWaiters: new Set(),
      gateWaiters: new Set(),
    };
    const response = await mf.dispatchFetch("http://localhost/native101", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: c.mode }),
    });
    check(c.name + ":fixture_response", response.status === 200);
    const observed = await response.json();
    await wait(150);
    // Dispose an attributable accepted late endpoint if native abort did not.
    // This is fixture cleanup, never proof that the native open was cancelled.
    for (const item of servers.filter((item) => item.owner === current && !item.serverClosed)) {
      current.forcedFixtureCloses++;
      try {
        item.server.close(1000, "owned late endpoint cleanup");
      } catch {}
      // Only after the observed native close and completed service outcome:
      // an orphan returned end can remain unaccepted and queue its peer close.
      // This is explicit local pair disposal, never native abort acknowledgement.
      current.forcedClientAcceptAttempts++;
      try {
        item.client.accept();
        current.forcedClientAcceptSuccesses++;
      } catch {
        current.forcedClientAcceptRejections++;
      }
      current.forcedClientCloseAttempts++;
      try {
        item.client.close(1000, "owned orphan pair disposal");
      } catch {
        current.forcedClientCloseRejections++;
      }
    }
    await wait(30);
    const service = { ...current };
    delete service.handshakeWaiters;
    delete service.gateWaiters;
    cases.push({ name: c.name, native: observed, service });
    check(
      c.name + ":bounded_handshake_coordination",
      current.coordinationCalls === (c.mode === "late_abort" ? 1 : 0) &&
        current.gateTimeouts === 0 &&
        current.handshakeWaiters.size === 0,
    );
    check(
      c.name + ":one_or_zero_fixed_intercept",
      current.intercepts === (c.mode === "constructor_reject" ? 0 : 1),
    );
    check(c.name + ":no_unexpected_target_or_fallback", unexpectedRequests === 0);
    if (c.mode === "constructor_reject")
      check(
        c.name + ":constructor_denied_before_transport",
        observed.constructorRejected && !observed.constructed && current.pairs === 0,
      );
    else {
      check(c.name + ":native_listener_cleanup", observed.listenersRemoved && !observed.timedOut);
      check(c.name + ":native_closed", observed.closeEvents === 1);
      if (c.status !== 101)
        check(
          c.name + ":no_redirect_follow_or_pg_bytes",
          !observed.opened &&
            observed.errorEvents >= 1 &&
            observed.applicationBytesSent === 0 &&
            current.pairs === 0,
        );
      else if (c.mode === "echo")
        check(
          c.name + ":real_binary_roundtrip",
          observed.opened &&
            observed.correctBinaryRoundtrip &&
            observed.binaryMessages === 1 &&
            current.frames === 1 &&
            current.bytes === 4 &&
            current.forcedFixtureCloses === 0,
        );
      else if (c.mode === "late_abort")
        check(
          c.name + ":no_application_send_after_abort",
          observed.handshakeGatePassed &&
            observed.abortLatched &&
            observed.applicationBytesSent === 0 &&
            observed.bytesSentAfterAbort === 0 &&
            current.frames === 0,
        );
      else
        check(
          c.name + ":server_close_no_application_data",
          observed.opened && current.frames === 0,
        );
    }
    check(
      c.name + ":all_attributable_pair_endpoints_closed",
      current.serverClosed === current.pairs &&
        current.pairClientClosed === current.pairs &&
        current.listeners === 0,
    );
  }

  const poolNames = ["loginPool", "preauthPool", "selectionPool", "sessionPool"];
  const sdkCases = poolNames.map((poolName) => ({
    name: "sdk_" + poolName + "_positive",
    mode: "good",
    poolNames: [poolName],
    positive: true,
  }));
  sdkCases.push(
    ...poolNames.map((poolName) => ({
      name: "sdk_" + poolName + "_fragmented_backend",
      mode: "good",
      poolNames: [poolName],
      positive: true,
      fragmentBytes: 7,
    })),
  );
  sdkCases.push({ name: "sdk_all_four_roles_concurrent", mode: "good", poolNames, positive: true });
  for (const mode of ["post_release_query", "parameters_snapshot", "connect_only"])
    sdkCases.push({ name: "sdk_" + mode, mode, positive: true });
  for (const mode of [
    "binding_pooler",
    "abort_before_connect",
    "borrow_reject",
    "wrong_namespace",
    "invalid_password",
    "lease_expired",
    "lease_revoked",
    "borrow_late",
    "invalid_query",
    "invalid_parameters",
    "clock_rollback",
    "abort_after_connect",
    "idle_deadline",
    "lease_during_idle",
    "release_reject",
    "release_pending",
  ])
    sdkCases.push({ name: "sdk_" + mode, mode });
  for (const fault of [
    "wrong_role",
    "wrong_database",
    "wrong_pid",
    "wrong_app",
    "bad_timestamp",
    "missing_field",
    "extra_row",
    "malformed_backend",
    "text_backend",
    "oversize_backend",
    "observer_primary_present",
    "observer_empty",
    "observer_hidden_self",
    "observer_null_field",
    "observer_millisecond_timestamp",
    "observer_wrong_role",
    "observer_wrong_database",
    "observer_wrong_pid",
    "observer_wrong_app",
    "withheld_close",
    "commit_unknown",
  ])
    sdkCases.push({
      name: "sdk_" + fault,
      mode: fault === "commit_unknown" ? fault : "good",
      fault,
    });
  for (const mode of [
    "pending_release",
    "pending_query_abort",
    "pending_parent_abort",
    "pending_query_deadline",
    "pending_concurrent_query",
  ])
    sdkCases.push({ name: "sdk_" + mode, mode, fault: "slow_query", gate: true });
  sdkCases.push({ name: "sdk_late101_after_abort", mode: "socket_abort", delay101: true });
  for (const status of [200, 301, 302, 303, 307, 308])
    for (const foreign of status === 200 ? [false] : [false, true])
      sdkCases.push({
        name: "sdk_non101_" + status + (foreign ? "_foreign" : "_same_host"),
        mode: "good",
        status,
        foreign,
      });
  for (const c of sdkCases) {
    const names = c.poolNames ?? ["loginPool"];
    const scripts = Object.fromEntries(
      names.map((poolName) => {
        const parameters = Array.from({ length: controlledNeonWireSql[poolName].arity }, (_, i) =>
          i === 0 ? "﻿wire-value-0-😀" : "wire-value-" + i,
        );
        return [
          poolName,
          c.mode === "connect_only" ? [] : controlledNeonExpectedScript(poolName, parameters),
        ];
      }),
    );
    current = {
      ...c,
      status: c.status ?? 101,
      sdk: true,
      poolNames: names,
      intercepts: 0,
      pairs: 0,
      serverAccepted: 0,
      serverClosed: 0,
      pairClientClosed: 0,
      frames: 0,
      bytes: 0,
      invalidFrames: 0,
      protocolRejections: 0,
      forcedFixtureCloses: 0,
      forcedClientAcceptAttempts: 0,
      forcedClientAcceptSuccesses: 0,
      forcedClientAcceptRejections: 0,
      forcedClientCloseAttempts: 0,
      forcedClientCloseRejections: 0,
      listeners: 0,
      coordinationCalls: 0,
      gateAccepted: false,
      gateTimeouts: 0,
      gateWaiters: new Set(),
      handshakeAccepted: false,
      handshakeWaiters: new Set(),
    };
    const owner = current;
    const oracle = createControlledNeonPgOracle({
      password: syntheticPasswordMarker,
      poolNames: names,
      scripts,
      fault: c.fault,
      fragmentBytes: c.fragmentBytes ?? 0,
      schedule: (callback, ms) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          callback();
        }, ms);
        pendingTimers.add(timer);
      },
      onEvent: (kind, data) => {
        if (kind === "statement" && data.index === 0) {
          owner.gateAccepted = true;
          for (const ack of [...owner.gateWaiters]) ack();
        }
      },
    });
    current.oracle = oracle;
    const response = await mf.dispatchFetch("http://localhost/sdk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: c.mode, poolNames: names }),
    });
    check(c.name + ":fixture_response", response.status === 200);
    const observed = await response.json();
    await wait(c.gate ? 600 : 150);
    for (const item of servers.filter(
      (item) => item.owner === current && (!item.serverClosed || !item.pairClientClosed),
    )) {
      current.forcedFixtureCloses++;
      try {
        item.server.close(1000, "owned late endpoint cleanup");
      } catch {}
      current.forcedClientAcceptAttempts++;
      try {
        item.client.accept();
        current.forcedClientAcceptSuccesses++;
      } catch {
        current.forcedClientAcceptRejections++;
      }
      current.forcedClientCloseAttempts++;
      try {
        item.client.close(1000, "owned orphan pair disposal");
      } catch {
        current.forcedClientCloseRejections++;
      }
    }
    await wait(30);
    const service = { ...current };
    delete service.oracle;
    delete service.gateWaiters;
    delete service.handshakeWaiters;
    const wire = oracle.snapshot();
    cases.push({
      name: c.name,
      expected: c.positive ? "positive" : "held",
      sdk: observed,
      wire,
      service,
    });
    const m = observed.metrics?.[names[0]];
    check(c.name + ":no_unexpected_target", unexpectedRequests === 0);
    check(
      c.name + ":bounded_gate_and_no_pending_control",
      current.gateTimeouts === 0 &&
        current.gateWaiters.size === 0 &&
        current.coordinationCalls === (c.gate || c.delay101 ? 1 : 0) &&
        current.handshakeWaiters.size === 0,
    );
    check(
      c.name + ":oracle_did_not_accept_wrong_protocol",
      wire.protocolRejections === 0 &&
        current.protocolRejections === 0 &&
        current.invalidFrames === 0,
    );
    check(
      c.name + ":all_owned_pair_endpoints_disposed",
      current.serverClosed === current.pairs &&
        current.pairClientClosed === current.pairs &&
        current.listeners === 0 &&
        wire.activeTransports === 0 &&
        wire.activePrimaryTuples === 0,
    );
    check(
      c.name + ":credential_release_once_or_not_acquired",
      observed.broker.releaseAttempts === observed.broker.acquired &&
        observed.broker.releaseAttempts <= names.length &&
        observed.broker.releaseControlsValid,
    );
    check(
      c.name + ":no_live_adapter_waits",
      Object.values(observed.metrics ?? {}).every(
        (row) => row.activeWaitTimers === 0 && row.activeWaitListeners === 0,
      ),
    );
    if (c.positive) {
      const n = names.length,
        q = c.mode === "connect_only" ? 0 : 6;
      check(
        c.name + ":connect_query_release",
        observed.factoryAccepted &&
          observed.connected === n &&
          observed.queryResults === n * q &&
          observed.domainMarker === (q ? n : 0) &&
          observed.released === n &&
          observed.held === 0,
      );
      check(c.name + ":joined_release_promise", observed.releasePromiseJoined);
      check(
        c.name + ":one_primary_one_observer_per_role_no_fallback",
        current.intercepts === 2 * n && current.pairs === 2 * n,
      );
      check(
        c.name + ":independent_startup_authentication_queries",
        wire.startups === 2 * n &&
          wire.authenticated === 2 * n &&
          wire.primaryMetadata === n &&
          wire.observerMetadata === n &&
          wire.statements === n * q &&
          wire.parameterQueries === (q ? n : 0),
      );
      check(
        c.name + ":independent_normal_release_acks",
        wire.terminates === 2 * n &&
          observed.broker.borrows === n &&
          observed.broker.namespaceVerified === n &&
          observed.broker.releaseAcks === n &&
          observed.broker.active === 0 &&
          Object.values(observed.metrics).reduce((sum, row) => sum + row.normalReleases, 0) === n,
      );
      if (c.mode === "post_release_query")
        check(c.name + ":post_release_query_stays_held", observed.postReleaseHeld);
      if (c.mode === "parameters_snapshot")
        check(c.name + ":parameters_copied_before_mutation", observed.parameterMutation);
    } else {
      check(c.name + ":no_success_after_fault", observed.held === 1 && observed.released === 0);
      check(c.name + ":no_normal_release_after_fault", !m || m.normalReleases === 0);
      const unknown = ["release_reject", "release_pending"].includes(c.mode);
      check(
        c.name + ":lease_acknowledgement_honest",
        unknown
          ? observed.broker.active === 1 && observed.broker.releaseAcks === 0
          : observed.broker.active === 0 &&
              observed.broker.releaseAcks === observed.broker.acquired,
      );
      const preTransport = [
        "binding_pooler",
        "abort_before_connect",
        "borrow_reject",
        "wrong_namespace",
        "invalid_password",
        "lease_expired",
        "lease_revoked",
        "borrow_late",
      ].includes(c.mode);
      const observer =
        ["release_reject", "release_pending"].includes(c.mode) || c.fault?.startsWith("observer_");
      check(
        c.name + ":no_retry_or_fallback",
        current.intercepts === (preTransport ? 0 : observer ? 2 : 1),
      );
      if (c.fault?.startsWith("observer_"))
        check(
          c.name + ":observer_self_guard_holds_without_absence_claim",
          wire.observerMetadata === 1 &&
            m.observerConnects === 1 &&
            m.observerReads === 1 &&
            m.primaryAbsenceVerified === 0 &&
            m.unverifiedReleases === 1,
        );
      if (!observer)
        check(
          c.name + ":no_observer_authority_after_hold",
          wire.observerMetadata === 0 && (!m || m.observerConnects === 0),
        );
      if (c.gate) {
        check(
          c.name + ":accepted_query_then_sticky_poison",
          observed.acceptedGatePassed &&
            observed.pendingQueryHeld &&
            !observed.lateQueryOutput &&
            observed.postFaultHeld &&
            wire.statements === 1 &&
            wire.lateOutputDiscards >= 1,
        );
        if (c.mode === "pending_release")
          check(c.name + ":pending_release_held", observed.pendingReleaseHeld);
        if (c.mode === "pending_concurrent_query")
          check(c.name + ":concurrent_query_held", observed.concurrentQueryHeld);
      }
      if (c.fault === "commit_unknown")
        check(
          c.name + ":commit_response_unknown_never_replayed",
          wire.committedResponsesWithheld === 1 &&
            wire.statements === 6 &&
            wire.observerMetadata === 0,
        );
      if (c.status && c.status !== 101) {
        check(
          c.name + ":source_release_remains_unverified",
          m.unverifiedReleases === 1 && m.normalReleases === 0,
        );
        check(c.name + ":non101_no_pg_startup", wire.startups === 0 && current.frames === 0);
      }
      if (c.delay101)
        check(
          c.name + ":late101_no_pg_startup",
          observed.handshakeGatePassed &&
            wire.startups === 0 &&
            current.frames === 0 &&
            current.forcedClientAcceptAttempts === 1,
        );
    }
  }
} catch (error) {
  failure = /^CONTROLLED_NEON_LAB_HELD:[A-Za-z0-9_:.-]+$/.test(error.message)
    ? error.message
    : "CONTROLLED_NEON_LAB_HELD:unclassified_native101_failure";
} finally {
  for (const item of servers)
    if (!item.serverClosed)
      try {
        item.server.close(1000, "final owned cleanup");
      } catch {}
  try {
    await mf.dispose();
    disposed = true;
  } catch {
    failure ??= "CONTROLLED_NEON_LAB_HELD:runtime_disposal_unverified";
  }
}
for (const [name, passed] of [
  ["runtime_disposal_acknowledged", disposed],
  ["all_local_timer_handles_settled", pendingTimers.size === 0],
  [
    "all_owned_pair_endpoint_events_acknowledged",
    servers.every(
      (item) => item.serverClosed && item.pairClientClosed && item.owner.listeners === 0,
    ),
  ],
  [
    "actual_sdk_bundle_input",
    Object.keys(bundled.metafile.inputs).some((path) =>
      path.endsWith("@neondatabase/serverless/index.mjs"),
    ),
  ],
]) {
  checks.push({ name, passed });
  if (!passed) failure ??= "CONTROLLED_NEON_LAB_HELD:" + name;
}
for (const [path, expected] of Object.entries(sourceDigests)) {
  const passed = hash(readFileSync(path)) === expected;
  checks.push({ name: "source_unchanged:" + path, passed });
  if (!passed) failure ??= "CONTROLLED_NEON_LAB_HELD:source_drift";
}
const report = {
  task: "P05.T01t",
  current_plan_sequence: 94,
  phase: "native101_and_actual_sdk_independent_wire_local_engineering_only",
  status: failure ? "held" : "passed",
  failure,
  cases,
  checks,
  nativeWebSocketIntercepts: intercepts,
  unexpectedRequests,
  actualInternetRequests: 0,
  actualProviderRequests: 0,
  localCoordinationCalls: cases.reduce((sum, row) => sum + (row.service.coordinationCalls ?? 0), 0),
  deliberatelyUnacknowledgedCredentialLeases: cases
    .filter((row) => row.sdk?.broker.active === 1)
    .map((row) => ({
      case: row.name,
      attempts: row.sdk.broker.releaseAttempts,
      acknowledgements: row.sdk.broker.releaseAcks,
      active: row.sdk.broker.active,
    })),
  runtimeDependencyDigests: Object.fromEntries(
    [
      "node_modules/@neondatabase/serverless/package.json",
      "node_modules/@neondatabase/serverless/index.mjs",
      "node_modules/miniflare/package.json",
      "node_modules/workerd/package.json",
    ].map((path) => [path, hash(readFileSync(path))]),
  ),
  runtime: {
    node: process.version,
    neonServerless: sdkPackage.version,
    neonInstalledModuleSha256: hash(
      readFileSync("node_modules/@neondatabase/serverless/index.mjs"),
    ),
    esbuild: JSON.parse(readFileSync("node_modules/esbuild/package.json")).version,
    miniflare: JSON.parse(readFileSync("node_modules/miniflare/package.json")).version,
    workerd: JSON.parse(readFileSync("node_modules/workerd/package.json")).version,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
  },
  cleanup: {
    workerRuntimeDisposalAcknowledged: disposed,
    pendingTimers: pendingTimers.size,
    serverEndpoints: servers.length,
    serverClosed: servers.filter((row) => row.serverClosed).length,
    pairClientClosed: servers.filter((row) => row.pairClientClosed).length,
    forcedFixtureCloses: cases.reduce((n, row) => n + row.service.forcedFixtureCloses, 0),
    forcedClientAcceptAttempts: cases.reduce(
      (n, row) => n + row.service.forcedClientAcceptAttempts,
      0,
    ),
    forcedClientAcceptSuccesses: cases.reduce(
      (n, row) => n + row.service.forcedClientAcceptSuccesses,
      0,
    ),
    forcedClientAcceptRejections: cases.reduce(
      (n, row) => n + row.service.forcedClientAcceptRejections,
      0,
    ),
    forcedClientCloseAttempts: cases.reduce(
      (n, row) => n + row.service.forcedClientCloseAttempts,
      0,
    ),
    forcedClientCloseRejections: cases.reduce(
      (n, row) => n + row.service.forcedClientCloseRejections,
      0,
    ),
  },
  source_digests: sourceDigests,
  source_inventory_digest: hash(JSON.stringify(Object.entries(sourceDigests))),
  limitations: [
    "Actual native constructor and installed SDK through independently simulated PG-wire; this is not real SQL, RLS, shared-backend absence or owning84 flow qualification. The separate realPG bridge/lab owns those claims.",
    "Constructor-created sockets expose no caller HTTP Response URL/status. Service-side handshake observations are separately counted.",
    "Late native open and explicit fixture endpoint cleanup are distinct; no cancellation/no-effect claim follows.",
    "Connect failure can return before detached cleanup settles. This fixture holds its request alive through disposal-only C observation; application waitUntil/request-lifetime wiring remains unqualified.",
    "An unresolved Client.end promise, physical socket closure and credential acknowledgement are separate. Held rows remain unverified releases; fixture disposal-only observation never renews core authority.",
    "Synthetic PG-wire uses an explicit password challenge; SCRAM authentication, real SQL, role privileges and shared backend disappearance are qualified only by the separate realPG lab.",
    "Native production constructor/setup throw paths cannot all be induced without replacement; the core author's focused source units cover injected-only transport faults separately.",
    "All requests are locally intercepted; no Neon DNS/TLS/account, hosted secret, Node native productionWSS, browser-engine or merchant qualification.",
  ],
};
const serializedReport = JSON.stringify(report, null, 2) + "\n";
if (
  [syntheticPasswordMarker, "wire-value-", "independent_wire_result"].some((value) =>
    serializedReport.includes(value),
  )
)
  throw Error("CONTROLLED_NEON_REPORT_SECRET_FENCE");
writeArtifact("labs/controlled-neon-workers.json", serializedReport);
if (failure) {
  process.exitCode = 1;
  process.stdout.write(
    failure + "; source-bound report retained; runtimeDisposed=" + disposed + "\n",
  );
} else
  process.stdout.write(
    "PASS native101 and actualSDK wire: " +
      cases.length +
      " cases; " +
      checks.length +
      " checks; " +
      intercepts +
      " intercepted; Internet/provider0; runtime disposed. RealPG/owning-flow acceptance is separate.\n",
  );
