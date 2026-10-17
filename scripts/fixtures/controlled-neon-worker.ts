import {
  createWorkersControlledNeonLoginPools,
  snapshotControlledNeonLoginPoolMetrics,
} from "../../packages/identity/src/controlled-neon-login-pool.js";
import { loginFlowCustodySql } from "../../packages/identity/src/login-flow-custody.js";
import { authenticationExchangeAdmissionSql } from "../../packages/identity/src/authentication-exchange-admission.js";
import { workspaceSelectionSql } from "../../packages/identity/src/workos-workspace-selection.js";
import { browserSessionAdmissionSql } from "../../packages/identity/src/workos-browser-session-admission.js";
const binding = {
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-controlled-lab",
  branchId: "br-controlled-lab",
  hostname: "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const password = ["MorrowSynthetic", "T88", "PG", "password", "only"].join("-");
const profileDefinitions = {
  loginPool: {
    role: "morrow_identity_login",
    sql: loginFlowCustodySql,
    domain: loginFlowCustodySql.observeEligibility,
    arity: 2,
  },
  preauthPool: {
    role: "morrow_identity_preauth",
    sql: authenticationExchangeAdmissionSql,
    domain: authenticationExchangeAdmissionSql.admit,
    arity: 13,
  },
  selectionPool: {
    role: "morrow_identity_resolution",
    sql: workspaceSelectionSql,
    domain: workspaceSelectionSql.resolve,
    arity: 9,
  },
  sessionPool: {
    role: "morrow_identity_sessions",
    sql: browserSessionAdmissionSql,
    domain: browserSessionAdmissionSql.admit,
    arity: 27,
  },
};
type PoolName = keyof typeof profileDefinitions;
type FixtureEnvironment = { CONTROL: { fetch(input: string): Promise<Response> } };
async function runSdk(input: { mode: string; poolNames?: PoolName[] }, env: FixtureEnvironment) {
  const mode = input.mode,
    names = input.poolNames ?? ["loginPool"];
  const parent = new AbortController();
  let offset = 0;
  const now = () => Date.now() + offset;
  const deadlineMs =
    now() + (["commit_unknown", "idle_deadline", "lease_during_idle"].includes(mode) ? 300 : 3000);
  const control = { deadlineMs, signal: parent.signal };
  const broker = {
    borrows: 0,
    acquired: 0,
    releaseAttempts: 0,
    releaseAcks: 0,
    active: 0,
    namespaceVerified: 0,
    releaseControlsValid: true,
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const credentialBroker = {
    async borrow(namespaceJson: string, c: typeof control) {
      broker.borrows++;
      const value = JSON.parse(namespaceJson);
      const role = names.map((n) => profileDefinitions[n].role).find((role) => role === value.role);
      if (
        !role ||
        namespaceJson !==
          JSON.stringify({
            schemaVersion: 1,
            providerId: "neon",
            ...Object.fromEntries(
              Object.entries(binding).filter(([key]) => key !== "schemaVersion"),
            ),
            role,
            purpose: "primary_and_one_same_role_observer",
          }) ||
        c.signal !== parent.signal ||
        c.deadlineMs > deadlineMs ||
        c.signal.aborted
      )
        throw Error("SYNTHETIC_BROKER_HELD");
      broker.namespaceVerified++;
      if (mode === "borrow_reject") throw Error("SYNTHETIC_BROKER_HELD");
      if (mode === "borrow_late") await new Promise<void>((resolve) => later(resolve, 100));
      const revoked = new AbortController();
      if (mode === "lease_revoked") revoked.abort();
      broker.acquired++;
      broker.active++;
      return {
        namespaceJson: mode === "wrong_namespace" ? namespaceJson + " " : namespaceJson,
        password: mode === "invalid_password" ? "short" : password,
        expiresAtMs:
          mode === "lease_expired"
            ? now() - 1
            : mode === "lease_during_idle"
              ? now() + 150
              : deadlineMs,
        revocationSignal: revoked.signal,
        async release(cleanupControl: typeof control) {
          broker.releaseAttempts++;
          broker.releaseControlsValid &&=
            typeof cleanupControl.deadlineMs === "number" &&
            cleanupControl.signal instanceof AbortSignal;
          if (mode === "release_reject") throw Error("SYNTHETIC_RELEASE_REJECTED");
          if (mode === "release_pending") return new Promise<void>(() => {});
          broker.releaseAcks++;
          broker.active--;
        },
      };
    },
  };
  const out = {
    factoryAccepted: false,
    connected: 0,
    queryResults: 0,
    domainMarker: 0,
    released: 0,
    held: 0,
    postReleaseHeld: false,
    releasePromiseJoined: false,
    acceptedGatePassed: false,
    handshakeGatePassed: false,
    pendingQueryHeld: false,
    pendingReleaseHeld: false,
    concurrentQueryHeld: false,
    postFaultHeld: false,
    lateQueryOutput: false,
    parameterMutation: false,
    broker,
    disposalObservation: {
      nextLocalTask: true,
      fixedHorizonMs: 1050,
      usedHorizon: false,
      elapsedMs: 0,
    },
    metricsAfterNextTask: {} as unknown,
    metricsAtOutcome: {} as unknown,
    metrics: {} as unknown,
  };
  let pools: Awaited<ReturnType<typeof createWorkersControlledNeonLoginPools>> | undefined;
  try {
    const value =
      mode === "binding_pooler"
        ? {
            ...binding,
            hostname: binding.hostname.replace(
              "ep-controlled-fixture.",
              "ep-controlled-fixture-pooler.",
            ),
          }
        : binding;
    pools = await createWorkersControlledNeonLoginPools({
      bindingJson: JSON.stringify(value),
      credentialBroker,
      now,
    });
    out.factoryAccepted = true;
    if (mode === "abort_before_connect") parent.abort();
    if (mode === "borrow_late") later(() => parent.abort(), 10);
    if (mode === "socket_abort")
      void env.CONTROL.fetch("http://fixture-control/handshake").then((response) => {
        if (response.status === 204) {
          out.handshakeGatePassed = true;
          parent.abort();
        }
      });
    const runOne = async (name: PoolName) => {
      const def = profileDefinitions[name];
      let client:
        | Awaited<
            ReturnType<
              Awaited<
                ReturnType<typeof createWorkersControlledNeonLoginPools>
              >["loginPool"]["connect"]
            >
          >
        | undefined;
      try {
        client = await pools![name].connect(control);
        out.connected++;
        if (mode === "clock_rollback") offset = -1000;
        if (mode === "abort_after_connect") parent.abort();
        const sql = def.sql as Readonly<Record<string, string>>;
        const domainValues = Array.from({ length: def.arity }, (_, i) =>
          i === 0 ? "﻿wire-value-0-😀" : "wire-value-" + i,
        );
        if (mode === "invalid_query") await client.query("SELECT current_user", [], control);
        else if (mode === "invalid_parameters")
          await client.query(def.domain, ["too-few"], control);
        else if (
          [
            "pending_release",
            "pending_query_abort",
            "pending_parent_abort",
            "pending_query_deadline",
            "pending_concurrent_query",
          ].includes(mode)
        ) {
          const queryController = new AbortController();
          const queryControl = {
            deadlineMs: mode === "pending_query_deadline" ? now() + 250 : deadlineMs,
            signal: queryController.signal,
          };
          const pending = client.query(sql.begin!, [], queryControl).then(
            () => {
              out.lateQueryOutput = true;
            },
            () => {
              out.pendingQueryHeld = true;
            },
          );
          const gate = await env.CONTROL.fetch("http://fixture-control/accepted");
          if (gate.status !== 204) throw Error("SYNTHETIC_GATE_HELD");
          out.acceptedGatePassed = true;
          if (mode === "pending_query_abort") queryController.abort();
          if (mode === "pending_parent_abort") parent.abort();
          if (mode === "pending_concurrent_query") {
            try {
              await client.query(sql.commit!, [], control);
            } catch {
              out.concurrentQueryHeld = true;
            }
          }
          if (mode === "pending_release") {
            try {
              await client.release(true);
            } catch {
              out.pendingReleaseHeld = true;
            }
          }
          await pending;
          try {
            await client.query(sql.commit!, [], control);
          } catch {
            out.postFaultHeld = true;
          }
          throw Error("EXPECTED_SYNTHETIC_HELD_QUERY");
        } else if (["idle_deadline", "lease_during_idle"].includes(mode)) {
          await new Promise<void>((resolve) => later(resolve, 400));
          await client.query(sql.commit!, [], control);
        } else if (mode === "connect_only") {
          /* Metadata only. */
        } else {
          for (const text of [sql.begin!, sql.role!, sql.timeout!, sql.idleTimeout!]) {
            await client.query(text, [], control);
            out.queryResults++;
          }
          const pendingDomain = client.query(def.domain, domainValues, control);
          if (mode === "parameters_snapshot") {
            domainValues.fill("mutated-after-snapshot");
            out.parameterMutation = true;
          }
          const result = await pendingDomain;
          out.queryResults++;
          if (result.rows[0]?.wire_marker === "independent_wire_result") out.domainMarker++;
          await client.query(sql.commit!, [], control);
          out.queryResults++;
        }
        const first = client.release(true),
          second = client.release(true);
        out.releasePromiseJoined = first === second;
        await first;
        out.released++;
        if (mode === "post_release_query") {
          try {
            await client.query(sql.commit!, [], control);
          } catch {
            out.postReleaseHeld = true;
          }
        }
      } catch {
        out.held++;
        if (client)
          try {
            const first = client.release(true),
              second = client.release(true);
            out.releasePromiseJoined = first === second;
            await first;
          } catch {
            /* Honest held cleanup. */
          }
      }
    };
    await Promise.all(names.map(runOne));
    if (mode === "borrow_late") await new Promise<void>((resolve) => later(resolve, 150));
    out.metricsAtOutcome = snapshotControlledNeonLoginPoolMetrics(pools);
    // A rejected connect exposes no client handle. Its owned fail-closed sink
    // may still be finishing promise continuations when the outcome arrives.
    // Observe one next local task, never renew its absolute authority window.
    await new Promise<void>((resolve) => later(resolve, 0));
    out.metricsAfterNextTask = snapshotControlledNeonLoginPoolMetrics(pools);
    if (
      out.held > 0 &&
      Object.values(out.metricsAfterNextTask as Record<string, Record<string, number>>).some(
        (row) => row.activeWaitTimers > 0 || row.activeWaitListeners > 0,
      )
    ) {
      // Observation only: allow the already-latched cleanup C to settle. This
      // does not give the poisoned client another deadline or any authority.
      const began = performance.now();
      out.disposalObservation.usedHorizon = true;
      await new Promise<void>((resolve) => later(resolve, 1050));
      out.disposalObservation.elapsedMs = Math.ceil(performance.now() - began);
    }
    out.metrics = snapshotControlledNeonLoginPoolMetrics(pools);
  } catch {
    out.held++;
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
  return out;
}
const hostname = "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech";
const fixedWsUrl = "wss://" + hostname + "/v2?address=" + hostname + ":5432";
const probeBytes = new Uint8Array([21, 3, 8, 88]);

export default {
  async fetch(request: Request, env: FixtureEnvironment) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/sdk")
      return Response.json(
        await runSdk((await request.json()) as { mode: string; poolNames?: PoolName[] }, env),
      );
    if (request.method !== "POST" || pathname !== "/native101")
      return new Response(null, { status: 404 });
    const input = (await request.json()) as { mode: string };
    const CapturedWebSocket = globalThis.WebSocket;
    const observed = {
      constructed: false,
      constructorRejected: false,
      opened: false,
      errorEvents: 0,
      closeEvents: 0,
      binaryMessages: 0,
      correctBinaryRoundtrip: false,
      abortLatched: false,
      handshakeGatePassed: false,
      handshakeGateFailed: false,
      applicationBytesSent: 0,
      bytesSentAfterAbort: 0,
      closeAttempts: 0,
      closeThrows: 0,
      timedOut: false,
      listenersRemoved: false,
    };
    let socket: WebSocket;
    try {
      // A separate invalid-scheme control never changes the fixed native route.
      socket = new CapturedWebSocket(
        input.mode === "constructor_reject" ? "https://invalid.example.test" : fixedWsUrl,
      );
      observed.constructed = true;
    } catch {
      observed.constructorRejected = true;
      return Response.json(observed);
    }
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        if (abortTimer) clearTimeout(abortTimer);
        socket.removeEventListener("open", open);
        socket.removeEventListener("error", error);
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", close);
        observed.listenersRemoved = true;
        resolve();
      };
      const stop = () => {
        observed.closeAttempts++;
        try {
          socket.close(1000, "fixture disposal");
        } catch {
          observed.closeThrows++;
        }
      };
      const open = () => {
        observed.opened = true;
        if (observed.abortLatched) {
          stop();
          return;
        }
        if (input.mode !== "server_close") {
          socket.send(probeBytes);
          observed.applicationBytesSent += probeBytes.length;
          if (observed.abortLatched) observed.bytesSentAfterAbort += probeBytes.length;
        }
      };
      const error = () => {
        observed.errorEvents++;
      };
      const message = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          observed.binaryMessages++;
          const value = new Uint8Array(event.data);
          observed.correctBinaryRoundtrip =
            value.length === probeBytes.length && value.every((b, i) => b === probeBytes[i]);
        }
        stop();
      };
      const close = () => {
        observed.closeEvents++;
        finish();
      };
      socket.addEventListener("open", open);
      socket.addEventListener("error", error);
      socket.addEventListener("message", message);
      socket.addEventListener("close", close);
      const abortTimer = undefined;
      if (input.mode === "late_abort")
        void env.CONTROL.fetch("http://fixture-control/handshake").then((response) => {
          if (response.status === 204) {
            observed.handshakeGatePassed = true;
            observed.abortLatched = true;
          } else observed.handshakeGateFailed = true;
          stop();
        });
      const timeout = setTimeout(() => {
        observed.timedOut = true;
        stop();
        finish();
      }, 750);
    });
    return Response.json(observed);
  },
};
