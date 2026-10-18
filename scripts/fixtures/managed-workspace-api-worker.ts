import { createWorkspaceApiWorker } from "../../apps/api/src/worker.js";
import { snapshotManagedLoginResponseMetrics } from "../../packages/identity/src/managed-login-request.js";
import { snapshotManagedWorkspaceResponseMetrics } from "../../packages/identity/src/managed-workspace-request.js";
import { createWorkersFixedWorkosLoginPort } from "../../packages/identity/src/fixed-workos-login-port.js";

declare const MANAGED_WORKSPACE_FIXTURE_JSON: string;
type Control = Readonly<{ deadlineMs: number; signal: AbortSignal }>;
type Setup = {
  configurationJson: string;
  workspaceConfigurationJson: string;
  logoutConfigurationJson: string;
  capsuleKeyringJson: string;
  bindingJson: string;
  passwordByRole: Record<string, string>;
  releaseMode: "normal" | "gate" | "reject" | "late_gate" | "session_reject";
  wrongPassword: boolean;
  gateNonce: string;
  clockOffsetMs: number;
  unbound?: boolean;
  clockExpiry?: "none" | "after_entry" | "during_setup";
};
type Context = { waitUntil(pending: Promise<unknown>): void };
const setup = JSON.parse(MANAGED_WORKSPACE_FIXTURE_JSON) as Setup;
const binding = JSON.parse(setup.bindingJson),
  configuration = JSON.parse(setup.configurationJson),
  profile = JSON.parse(configuration.verificationProfileJson);
let requestClockReads = 0,
  requestClockEpoch = 0;
const now = () => {
  if (!setup.clockExpiry || setup.clockExpiry === "none") return Date.now() + setup.clockOffsetMs;
  const expiryRead = setup.clockExpiry === "after_entry" ? 2 : 8;
  return requestClockEpoch + (++requestClockReads >= expiryRead ? 5001 : 0);
};
const incorrectPasswordMarker = ["synthetic", "incorrect", "pg", "marker"].join("_");
const held = () => Error("MANAGED_WORKSPACE_FIXTURE_HELD");
const expect = (value: unknown) => {
  if (!value) throw held();
};
expect(
  ["normal", "gate", "reject", "late_gate", "session_reject"].includes(setup.releaseMode) &&
    typeof setup.wrongPassword === "boolean" &&
    /^[a-f0-9]{32}$/.test(setup.gateNonce) &&
    Number.isSafeInteger(setup.clockOffsetMs) &&
    (setup.unbound === undefined || typeof setup.unbound === "boolean") &&
    (setup.clockExpiry === undefined ||
      ["none", "after_entry", "during_setup"].includes(setup.clockExpiry)),
);
const roles = [
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_sessions",
  "morrow_api",
  "morrow_identity_linking",
  "morrow_identity_logout",
  "morrow_identity_onboarding",
];
const workspaceRoles = [
  "morrow_api",
  "morrow_identity_linking",
  "morrow_identity_logout",
  "morrow_identity_onboarding",
];
const leases = { borrows: 0, releaseAttempts: 0, releaseAcknowledgements: 0, activeLeases: 0 };
const workos = { borrows: 0, releaseAttempts: 0, releaseAcknowledgements: 0, activeLeases: 0 };
const workosNamespace = JSON.stringify({
  schemaVersion: 1,
  providerId: "workos",
  environmentId: profile.environmentId,
  applicationId: profile.applicationId,
  clientId: profile.clientId,
  purpose: "list_active_sessions",
});
// This is module-startup CPU-only preparation. It issues no provider request,
// borrows no credential. Managed initialization starts only inside each entry attempt.
const providerPort = await createWorkersFixedWorkosLoginPort({
  configurationJson: setup.configurationJson,
  now,
  sessionCredentialBroker: {
    async borrow(namespaceJson: string, control: Control) {
      expect(
        namespaceJson === workosNamespace && !control.signal.aborted && now() < control.deadlineMs,
      );
      workos.borrows++;
      workos.activeLeases++;
      const revocation = new AbortController();
      let released = false;
      return {
        namespaceJson,
        credential: "platform_management_marker_87_only",
        expiresAtMs: now() + 60000,
        revocationSignal: revocation.signal,
        async release(c: Control) {
          workos.releaseAttempts++;
          expect(!released && !c.signal.aborted && now() < c.deadlineMs);
          released = true;
          workos.releaseAcknowledgements++;
          workos.activeLeases--;
        },
      };
    },
  },
});
const loginDependencies = {
  configurationJson: setup.configurationJson,
  capsuleKeyringJson: setup.capsuleKeyringJson,
  bindingJson: setup.bindingJson,
  now,
  providerPort,
  credentialBroker: {
    async borrow(namespaceJson: string, control: Control) {
      const n = JSON.parse(namespaceJson);
      expect(
        roles.includes(n.role) &&
          namespaceJson ===
            JSON.stringify({
              schemaVersion: 1,
              providerId: "neon",
              environment: binding.environment,
              projectId: binding.projectId,
              branchId: binding.branchId,
              hostname: binding.hostname,
              database: binding.database,
              role: n.role,
              purpose: workspaceRoles.includes(n.role)
                ? "workspace_primary_and_one_same_role_observer"
                : "primary_and_one_same_role_observer",
            }) &&
          !control.signal.aborted &&
          now() < control.deadlineMs,
      );
      const id = ++leases.borrows,
        revocation = new AbortController();
      leases.activeLeases++;
      let released = false;
      return {
        namespaceJson,
        password: setup.wrongPassword ? incorrectPasswordMarker : setup.passwordByRole[n.role],
        expiresAtMs: now() + 60000,
        revocationSignal: revocation.signal,
        async release(c: Control) {
          leases.releaseAttempts++;
          expect(!released && !c.signal.aborted && now() < c.deadlineMs);
          released = true;
          if (
            setup.releaseMode === "reject" ||
            (setup.releaseMode === "session_reject" && n.role === "morrow_identity_sessions")
          )
            throw held();
          if (setup.releaseMode === "gate" || setup.releaseMode === "late_gate") {
            const base = `https://morrow-managed-gate.test/${setup.gateNonce}`;
            const response = await fetch(base + "/lease/" + id, {
              redirect: "manual",
              // late_gate deliberately models an uncancellable credential
              // provider. Source C still expires and must withhold its ack.
              ...(setup.releaseMode === "late_gate" ? {} : { signal: c.signal }),
            });
            expect(response.status === 200 && (await response.text()) === "u-managed-release-open");
            const marker = await fetch(base + "/complete/" + id, {
              method: "POST",
              headers: { "content-type": "text/plain" },
              body: "u-managed-release-read",
              redirect: "manual",
              ...(setup.releaseMode === "late_gate" ? {} : { signal: c.signal }),
            });
            expect(marker.status === 200 && (await marker.text()) === "u-managed-marker-ack");
          }
          leases.releaseAcknowledgements++;
          leases.activeLeases--;
          console.debug(
            JSON.stringify({
              event: "morrow_fixture_lease_ack",
              lease: id,
              inOriginalCleanup: !c.signal.aborted && now() < c.deadlineMs,
              releaseAttempts: leases.releaseAttempts,
              releaseAcknowledgements: leases.releaseAcknowledgements,
              activeLeases: leases.activeLeases,
            }),
          );
        },
      };
    },
  },
};
const handler = createWorkspaceApiWorker(
  setup.unbound
    ? undefined
    : {
        login: loginDependencies,
        workspaceConfigurationJson: setup.workspaceConfigurationJson,
        logoutConfigurationJson: setup.logoutConfigurationJson,
      },
);
export default {
  fetch(request: Request, env: unknown, ctx: Context): Promise<Response> {
    // The real platform request and ctx reach the synchronous managed entry
    // immediately. No initialization, body read, gate admission or timer occurs
    // in this fixture before the handler creates its original attempt.
    requestClockReads = 0;
    requestClockEpoch = Date.now();
    return handler.fetch(request, env, ctx).then((response) => {
      const path = new URL(request.url).pathname;
      const kind =
        path === "/auth/logout" || path.startsWith("/workspace/") ? "workspace" : "login";
      let metrics = null;
      try {
        metrics =
          kind === "workspace"
            ? snapshotManagedWorkspaceResponseMetrics(response)
            : snapshotManagedLoginResponseMetrics(response);
      } catch {
        // An unbound/default denial has no owning handler observation.
      }
      const headers = new Headers(response.headers);
      headers.set(
        "x-morrow-fixture-metrics",
        JSON.stringify({
          kind,
          response: metrics,
          leases: { ...leases },
          workos: { ...workos },
          fixtureClock:
            setup.clockExpiry && setup.clockExpiry !== "none"
              ? { mode: setup.clockExpiry, reads: requestClockReads, epoch: requestClockEpoch }
              : null,
        }),
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  },
};
