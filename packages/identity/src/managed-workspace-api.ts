import { ownRecord } from "./controlled-neon-login-profiles.js";
import { captureManagedWorkspaceBinding } from "./managed-workspace-binding.js";
import { createWorkersManagedLoginHandler } from "./managed-login-request.js";
import { createWorkersManagedWorkspaceHandler } from "./managed-workspace-request.js";
import type { ManagedLoginDependencies, FixedWorkosLoginPort } from "./standalone-login.js";
import { standaloneJson } from "./standalone-request-guard.js";

export interface ManagedWorkspaceApiDependencies {
  readonly login: ManagedLoginDependencies;
  readonly workspaceConfigurationJson: string;
  readonly logoutConfigurationJson: string;
}
type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
const invalid = () => Error("MANAGED_WORKSPACE_API_CONFIGURATION_INVALID");

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
      ]);
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
        workspace: createWorkersManagedWorkspaceHandler({ binding, credentialBroker, now }),
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
    const auth = path === "/auth" || path.startsWith("/auth/");
    // The account routes (P05.T01x) are exact paths owned by the workspace handler.
    const workspace =
      path === "/workspace" ||
      path.startsWith("/workspace/") ||
      path === "/workspaces" ||
      path === "/organizations";
    if (!configured)
      return Promise.resolve(
        standaloneJson(workspace ? 401 : auth ? 503 : 404, {
          code: workspace ? "authentication_required" : auth ? "unavailable" : "not_found",
        }),
      );
    // No await or second budget precedes the selected source owner.
    // Logout and rotate (P05.T01y) share the workspace handler's attempt, pool and binding.
    if (path === "/auth/logout" || path === "/auth/rotate")
      return configured.workspace.fetch(request, env, actualCtx);
    if (auth) return configured.login.fetch(request, env, actualCtx);
    if (workspace) return configured.workspace.fetch(request, env, actualCtx);
    return Promise.resolve(standaloneJson(404, { code: "not_found" }));
  };
  return Object.freeze({ fetch });
}
