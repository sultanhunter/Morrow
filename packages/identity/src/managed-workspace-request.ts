import {
  createManagedStandaloneRequestGuard,
  standaloneJson,
  StandaloneRequestError,
  type StandaloneRequestRoute,
} from "./standalone-request-guard.js";
import { executeStandaloneWorkspaceBootstrap } from "./standalone-workspace-bootstrap.js";
import { createStandaloneStoreLinkingExecution } from "./standalone-store-linking.js";
import { dispatchStandaloneLogoutWithAttempt } from "./standalone-logout.js";
import {
  resolveManagedWorkspaceBinding,
  type CapturedManagedWorkspaceBinding,
} from "./managed-workspace-binding.js";
import {
  createManagedLoginRequestOwner,
  bindManagedLoginRequestNamespace,
  snapshotManagedLoginRequestMetrics,
} from "./managed-login-request-scope.js";
import {
  createWorkersRequestBoundNeonWorkspacePools,
  snapshotControlledNeonWorkspacePoolMetrics,
  type ControlledNeonWorkspacePools,
} from "./controlled-neon-login-pool.js";
import type { LoginAttempt } from "./standalone-login-protocol.js";

type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
type Owner = ReturnType<typeof createManagedLoginRequestOwner>;
type ResponseMetrics = Readonly<{
  enteredAtMs: number;
  initialDeadlineMs: number;
  finalDeadlineMs: number;
  attemptEnded: boolean;
  configurationDigest: string | null;
  ownership: ReturnType<typeof snapshotManagedLoginRequestMetrics> | null;
  pools: ReturnType<typeof snapshotControlledNeonWorkspacePoolMetrics> | null;
}>;
// Only closed snapshots survive delivery. Request scopes, clients and pending
// cleanup remain owned by the original entry, never this observation map.
const observations = new WeakMap<Response, ResponseMetrics>();
const held = () => Error("MANAGED_WORKSPACE_REQUEST_HELD");

export function createWorkersManagedWorkspaceHandler(
  dependencies: Readonly<{
    binding: Readonly<CapturedManagedWorkspaceBinding>;
    credentialBroker: unknown;
    now: () => number;
  }>,
) {
  const { binding, credentialBroker, now } = dependencies;
  const guard = createManagedStandaloneRequestGuard(binding.workspaceConfigurationJson, now);
  const fetch = async (request: Request, _env: unknown, actualCtx: Context): Promise<Response> => {
    let attempt: LoginAttempt | undefined, owner: Owner | undefined;
    let pools: ControlledNeonWorkspacePools | undefined, response: Response | undefined;
    let enteredAtMs = 0,
      initialDeadlineMs = 0,
      configurationDigest: string | null = null;
    let route: StandaloneRequestRoute | "logout" = "bootstrap";
    let invoked = false;
    try {
      // This is the sole business attempt, using the guard's shared sticky
      // clock, before asynchronous configuration, crypto or pool construction.
      const entry = guard.begin(request);
      attempt = entry.attempt;
      initialDeadlineMs = attempt.control().deadlineMs;
      enteredAtMs = initialDeadlineMs - 5000;
      owner = createManagedLoginRequestOwner(actualCtx, attempt);
      const path = new URL(request.url).pathname;
      route =
        path === "/auth/logout"
          ? "logout"
          : path.endsWith("/bootstrap")
            ? "bootstrap"
            : path.endsWith("/preview")
              ? "preview"
              : path.endsWith("/status")
                ? "status"
                : "apply";
      attempt.check();
      const resolved = await resolveManagedWorkspaceBinding(binding, attempt);
      attempt.check();
      configurationDigest = resolved.configurationDigest;
      bindManagedLoginRequestNamespace(owner.scope, owner.ownerToken, configurationDigest);
      attempt.check();
      const preparing = createWorkersRequestBoundNeonWorkspacePools(
        { bindingJson: binding.bindingJson, credentialBroker, now },
        owner.scope,
        owner.ownerToken,
        configurationDigest,
      );
      pools = await attempt.wait(preparing);
      attempt.check();
      if (route === "logout") {
        invoked = true;
        await dispatchStandaloneLogoutWithAttempt(
          request,
          (output) => {
            if (response || output.cookies.length !== 0) throw held();
            response = new Response(output.bodyText, {
              status: output.status,
              headers: output.headers.map(([name, value]) => [name, value] as [string, string]),
            });
          },
          attempt,
          resolved.logout,
          pools.logoutPool,
        );
      } else {
        const selected = route;
        const linking = createStandaloneStoreLinkingExecution({
          configurationJson: binding.workspaceConfigurationJson,
          pool: pools.linkingPool,
          now: attempt.check,
        });
        const identityPool = pools.identityPool;
        response = await entry.handle(selected, (context) => {
          invoked = true;
          return selected === "bootstrap"
            ? executeStandaloneWorkspaceBootstrap(identityPool, context)
            : linking.execute(selected, context);
        });
      }
      if (!response || response.headers.has("set-cookie")) throw held();
      if (request.signal.aborted) throw held();
    } catch (error) {
      // Never manufacture a replacement delivery after transport cancellation.
      if (request instanceof Request && request.signal.aborted) throw held();
      response =
        invoked && (route === "apply" || route === "logout")
          ? standaloneJson(503, {
              schemaVersion: 1,
              outcome: route === "logout" ? "logout_outcome_unknown" : "outcome_unknown",
            })
          : standaloneJson(error instanceof StandaloneRequestError ? error.status : 503, {
              code: "unavailable",
            });
    } finally {
      attempt?.end();
    }
    if (!response) throw held();
    observations.set(
      response,
      Object.freeze({
        enteredAtMs,
        initialDeadlineMs,
        finalDeadlineMs: attempt?.control().deadlineMs ?? 0,
        attemptEnded: attempt !== undefined,
        configurationDigest,
        ownership: owner ? snapshotManagedLoginRequestMetrics(owner.scope, owner.ownerToken) : null,
        pools: pools ? snapshotControlledNeonWorkspacePoolMetrics(pools) : null,
      }),
    );
    return response;
  };
  return Object.freeze({ fetch });
}

export function snapshotManagedWorkspaceResponseMetrics(response: Response): ResponseMetrics {
  const value = observations.get(response);
  if (!value) throw held();
  return value;
}
