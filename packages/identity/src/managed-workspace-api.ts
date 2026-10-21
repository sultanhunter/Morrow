import { ownRecord } from "./controlled-neon-login-profiles.js";
import { captureManagedWorkspaceBinding } from "./managed-workspace-binding.js";
import { createWorkersManagedLoginHandler } from "./managed-login-request.js";
import { createWorkersManagedWorkspaceHandler } from "./managed-workspace-request.js";
import type { ManagedLoginDependencies, FixedWorkosLoginPort } from "./standalone-login.js";
import { standaloneJson } from "./standalone-request-guard.js";
import type { ConnectionKernel } from "./shopify-link-issuer.js";

export interface ManagedWorkspaceApiDependencies {
  readonly login: ManagedLoginDependencies;
  readonly workspaceConfigurationJson: string;
  readonly logoutConfigurationJson: string;
  // M2 PR-2: the connection kernel (governance.connection.connect administer), composed by
  // the api from @morrow/policy. Without it no Shopify handoff is issued and no install
  // link is offered.
  readonly connections?: ConnectionKernel;
}
type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
const invalid = () => Error("MANAGED_WORKSPACE_API_CONFIGURATION_INVALID");

// The one route table of the composed api, by exact WHATWG pathname (never decoded,
// so `/auth/%6Cogin` is not `/auth/login`, and a trailing slash is another path).
// The router below dispatches by it and the P05.T01ab abuse guard selects by it, so
// the two cannot disagree. Login start, the callback and signup are the classes the
// login dispatcher and the workspace handler then match by the same exact paths.
export type ManagedApiRoute =
  | "login_start"
  | "login_callback"
  | "challenge"
  | "logout"
  | "rotate"
  | "auth"
  | "signup"
  | "workspace"
  | "not_found";
export function managedApiRoute(pathname: string): ManagedApiRoute {
  if (pathname === "/auth/login") return "login_start";
  if (pathname === "/auth/workos/callback") return "login_callback";
  if (pathname === "/auth/challenge") return "challenge";
  if (pathname === "/auth/logout") return "logout";
  if (pathname === "/auth/rotate") return "rotate";
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return "auth";
  // The account routes (P05.T01x) are exact paths owned by the workspace handler.
  if (pathname === "/organizations") return "signup";
  if (pathname === "/workspace" || pathname.startsWith("/workspace/") || pathname === "/workspaces")
    return "workspace";
  return "not_found";
}

// A source-owned local constructor. Configuration and methods are captured
// once; there is no environment-selected provider or per-request initializer.
export function createWorkersManagedWorkspaceApi(dependencies?: ManagedWorkspaceApiDependencies) {
  let configured:
    | Readonly<{
        login: ReturnType<typeof createWorkersManagedLoginHandler>;
        workspace: ReturnType<typeof createWorkersManagedWorkspaceHandler>;
      }>
    | undefined;
  if (dependencies !== undefined) {
    try {
      const d = ownRecord(dependencies, [
        "login",
        "workspaceConfigurationJson",
        "logoutConfigurationJson",
        ...(Object.hasOwn(dependencies, "connections") ? ["connections"] : []),
      ]);
      if (d.connections !== undefined && typeof d.connections !== "function") throw invalid();
      const trustedConnections = d.connections as ConnectionKernel | undefined;
      const connections = trustedConnections
        ? (facts: Parameters<ConnectionKernel>[0]) =>
            Reflect.apply(trustedConnections, undefined, [facts]) as ReturnType<ConnectionKernel>
        : undefined;
      const l = ownRecord(d.login, [
        "configurationJson",
        "capsuleKeyringJson",
        "bindingJson",
        "credentialBroker",
        "providerPort",
        "now",
      ]);
      const broker = ownRecord(l.credentialBroker, ["borrow"]);
      const port = ownRecord(l.providerPort, ["exchange", "readPublicKeyset", "readSessionPage"]);
      if (
        typeof l.now !== "function" ||
        typeof broker.borrow !== "function" ||
        Object.values(port).some((method) => typeof method !== "function")
      )
        throw invalid();
      const trustedNow = l.now as () => number;
      const now = () => Reflect.apply(trustedNow, undefined, []);
      const credentialBroker = Object.freeze({
        borrow: (broker.borrow as Function).bind(l.credentialBroker),
      });
      const providerPort = Object.freeze({
        exchange: (port.exchange as FixedWorkosLoginPort["exchange"]).bind(l.providerPort),
        readPublicKeyset: (port.readPublicKeyset as FixedWorkosLoginPort["readPublicKeyset"]).bind(
          l.providerPort,
        ),
        readSessionPage: (port.readSessionPage as FixedWorkosLoginPort["readSessionPage"]).bind(
          l.providerPort,
        ),
      });
      const login: ManagedLoginDependencies = Object.freeze({
        configurationJson: l.configurationJson as string,
        capsuleKeyringJson: l.capsuleKeyringJson as string,
        bindingJson: l.bindingJson as string,
        credentialBroker,
        providerPort,
        now,
      });
      const binding = captureManagedWorkspaceBinding({
        loginConfigurationJson: login.configurationJson,
        workspaceConfigurationJson: d.workspaceConfigurationJson,
        logoutConfigurationJson: d.logoutConfigurationJson,
        bindingJson: login.bindingJson,
      });
      configured = Object.freeze({
        login: createWorkersManagedLoginHandler(login),
        workspace: createWorkersManagedWorkspaceHandler({
          binding,
          credentialBroker,
          now,
          ...(connections ? { connections } : {}),
        }),
      });
    } catch {
      throw invalid();
    }
  }
  const fetch = (request: Request, env: unknown, actualCtx: Context): Promise<Response> => {
    if (!(request instanceof Request))
      return Promise.resolve(standaloneJson(400, { code: "request_denied" }));
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return Promise.resolve(standaloneJson(400, { code: "request_denied" }));
    }
    const route = managedApiRoute(path);
    const workspace = route === "signup" || route === "workspace";
    const auth = !workspace && route !== "not_found";
    if (!configured)
      return Promise.resolve(
        standaloneJson(workspace ? 401 : auth ? 503 : 404, {
          code: workspace ? "authentication_required" : auth ? "unavailable" : "not_found",
        }),
      );
    // No await or second budget precedes the selected source owner.
    // Logout and rotate (P05.T01y) share the workspace handler's attempt, pool and binding.
    if (route === "logout" || route === "rotate")
      return configured.workspace.fetch(request, env, actualCtx);
    if (auth) return configured.login.fetch(request, env, actualCtx);
    if (workspace) return configured.workspace.fetch(request, env, actualCtx);
    return Promise.resolve(standaloneJson(404, { code: "not_found" }));
  };
  return Object.freeze({ fetch });
}
