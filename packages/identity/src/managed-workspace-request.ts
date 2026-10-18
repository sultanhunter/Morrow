import {
  createManagedStandaloneRequestGuard,
  standaloneJson,
  StandaloneRequestError,
  type StandaloneAccountRoute,
  type StandaloneRequestRoute,
} from "./standalone-request-guard.js";
import { executeStandaloneWorkspaceBootstrap } from "./standalone-workspace-bootstrap.js";
import { executeAccountOverview, executeFirstOrganization } from "./account-onboarding.js";
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
type Route = StandaloneRequestRoute | StandaloneAccountRoute | "logout";
// The explicit route table: exact account and logout paths, then the workspace suffixes.
const exactRoutes: Readonly<Record<string, Route>> = Object.freeze({
  "/auth/logout": "logout",
  "/workspaces": "workspaces",
  "/organizations": "organizations",
});
const workspaceSuffixes: readonly (readonly [string, StandaloneRequestRoute])[] = Object.freeze([
  ["/bootstrap", "bootstrap"],
  ["/preview", "preview"],
  ["/status", "status"],
]);
function selectRoute(path: string): Route {
  if (Object.hasOwn(exactRoutes, path)) return exactRoutes[path]!;
  for (const [suffix, route] of workspaceSuffixes) if (path.endsWith(suffix)) return route;
  return "apply";
}

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
    let route: Route = "bootstrap";
    let invoked = false;
    let submitted: (() => boolean) | undefined;
    try {
      // This is the sole business attempt, using the guard's shared sticky
      // clock, before asynchronous configuration, crypto or pool construction.
      const entry = guard.begin(request);
      attempt = entry.attempt;
      initialDeadlineMs = attempt.control().deadlineMs;
      enteredAtMs = initialDeadlineMs - 5000;
      owner = createManagedLoginRequestOwner(actualCtx, attempt);
      route = selectRoute(new URL(request.url).pathname);
      submitted = entry.accountSubmitted;
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
      } else if (route === "workspaces" || route === "organizations") {
        const selected = route;
        // The configured login profile is the only profile a family may belong to.
        const profileId = resolved.login.profileId;
        const { identityPool, onboardingPool } = pools;
        response = await entry.handleAccount(selected, (context) => {
          invoked = true;
          return selected === "workspaces"
            ? executeAccountOverview(identityPool, profileId, context)
            : executeFirstOrganization(onboardingPool, profileId, context);
        });
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
      // Signup is unknown only once its create statement may have been sent; broker
      // lease, connect, role row or BEGIN failures before that stay plain unavailable.
      response =
        invoked &&
        (route === "apply" ||
          route === "logout" ||
          (route === "organizations" && submitted?.() === true))
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
