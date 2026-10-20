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
import { executeWorkspaceConnections, type ConnectionKernel } from "./shopify-link-issuer.js";
import { dispatchStandaloneLogoutWithAttempt } from "./standalone-logout.js";
import { dispatchStandaloneRotationWithAttempt } from "./standalone-session-rotation.js";
import { SESSION_COOKIE_CLEAR } from "./request-primitives.js";
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
// Cookie confinement (P05.T01y §4): logout may carry only the exact clear, on 200, 403
// and 503; rotate only one session cookie (Max-Age 1..1800) on a 200 rotated answer; every
// workspace and account route none. Anything else is held.
const rotatedCookie =
  /^__Host-morrow_session=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=([1-9][0-9]{0,3})$/;
export function confinedCookies(
  route: "logout" | "rotate",
  status: number,
  bodyText: string,
  cookies: readonly string[],
): readonly string[] {
  if (!Array.isArray(cookies) || cookies.length > 1) throw held();
  if (cookies.length === 0) return cookies;
  const cookie = cookies[0];
  if (route === "logout") {
    if (cookie !== SESSION_COOKIE_CLEAR || ![200, 403, 503].includes(status)) throw held();
    return cookies;
  }
  const age = typeof cookie === "string" ? rotatedCookie.exec(cookie)?.[1] : undefined;
  const body =
    /^\{"schemaVersion":1,"outcome":"rotated","idleRemainingMs":(0|[1-9][0-9]{0,7}),"absoluteRemainingMs":(0|[1-9][0-9]{0,7})\}$/.exec(
      bodyText,
    );
  if (
    age === undefined ||
    Number(age) > 1800 ||
    status !== 200 ||
    !body ||
    Number(body[1]) > 43200000 ||
    Number(body[2]) > 43200000
  )
    throw held();
  return cookies;
}
// The managed delivery for logout and rotate: the dispatcher's one plan becomes one
// Response whose Set-Cookie fields are exactly the confined cookies (P05.T01y §4, AC29).
// delivered() holds unless exactly one plan arrived and the Response's Set-Cookie list
// equals the confined one.
export function createManagedCookieDelivery(route: "logout" | "rotate") {
  let response: Response | undefined, cookie: string | undefined;
  return Object.freeze({
    sink(output: {
      status: number;
      headers: readonly (readonly [string, string])[];
      cookies: readonly string[];
      bodyText: string;
    }): void {
      if (response) throw held();
      const cookies = confinedCookies(route, output.status, output.bodyText, output.cookies);
      const headers = new Headers(
        output.headers.map(([name, value]) => [name, value] as [string, string]),
      );
      for (const value of cookies) headers.append("Set-Cookie", value);
      cookie = cookies[0];
      response = new Response(output.bodyText, { status: output.status, headers });
    },
    delivered(): Response {
      if (!response || response.headers.getSetCookie().join("\n") !== (cookie ?? "")) throw held();
      return response;
    },
  });
}
// Only closed snapshots survive delivery. Request scopes, clients and pending
// cleanup remain owned by the original entry, never this observation map.
const observations = new WeakMap<Response, ResponseMetrics>();
const held = () => Error("MANAGED_WORKSPACE_REQUEST_HELD");
type Route = StandaloneRequestRoute | StandaloneAccountRoute | "logout" | "rotate";
// The explicit route table: exact account, logout and rotate paths, then the workspace suffixes.
const exactRoutes: Readonly<Record<string, Route>> = Object.freeze({
  "/auth/logout": "logout",
  "/auth/rotate": "rotate",
  "/workspaces": "workspaces",
  "/organizations": "organizations",
});
const workspaceSuffixes: readonly (readonly [string, StandaloneRequestRoute])[] = Object.freeze([
  ["/bootstrap", "bootstrap"],
  // M2 PR-2: GET /workspace/:ws/connections (the guard checks the exact path).
  ["/connections", "connections"],
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
    // M2 PR-2: the api's connection kernel (governance.connection.connect administer).
    connections?: ConnectionKernel;
  }>,
) {
  const { binding, credentialBroker, now, connections } = dependencies;
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
      if (route === "logout" || route === "rotate") {
        invoked = true;
        const delivery = createManagedCookieDelivery(route);
        if (route === "logout")
          await dispatchStandaloneLogoutWithAttempt(
            request,
            delivery.sink,
            attempt,
            resolved.logout,
            pools.logoutPool,
          );
        else
          await dispatchStandaloneRotationWithAttempt(
            request,
            delivery.sink,
            attempt,
            resolved.logout,
            pools.logoutPool,
          );
        response = delivery.delivered();
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
          ...(connections ? { connections } : {}),
        });
        const identityPool = pools.identityPool;
        const linkingPool = pools.linkingPool;
        const check = attempt.check;
        response = await entry.handle(selected, (context) => {
          invoked = true;
          return selected === "bootstrap"
            ? executeStandaloneWorkspaceBootstrap(identityPool, context)
            : selected === "connections"
              ? executeWorkspaceConnections(linkingPool, check, connections, context)
              : linking.execute(selected, context);
        });
      }
      if (!response) throw held();
      if (route !== "logout" && route !== "rotate" && response.headers.has("set-cookie"))
        throw held();
      if (request.signal.aborted) throw held();
    } catch (error) {
      // Never manufacture a replacement delivery after transport cancellation.
      if (request instanceof Request && request.signal.aborted) throw held();
      // Signup is unknown only once its create statement may have been sent; broker
      // lease, connect, role row or BEGIN failures before that stay plain unavailable.
      // These fallbacks never carry a cookie, for logout or rotate either.
      response =
        invoked &&
        (route === "apply" ||
          route === "logout" ||
          route === "rotate" ||
          (route === "organizations" && submitted?.() === true))
          ? standaloneJson(503, {
              schemaVersion: 1,
              outcome:
                route === "logout"
                  ? "logout_outcome_unknown"
                  : route === "rotate"
                    ? "rotation_outcome_unknown"
                    : "outcome_unknown",
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
