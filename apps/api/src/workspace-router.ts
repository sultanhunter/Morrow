import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuthHttpListener, type AuthDispatchHandler } from "./auth-http.js";
import { createWorkspaceHttpListener, type WorkspaceHttpBinding } from "./workspace-http.js";

export interface WorkspaceApiHttpBinding extends WorkspaceHttpBinding {
  readonly auth: AuthDispatchHandler;
  readonly logout?: AuthDispatchHandler;
  readonly rotate?: AuthDispatchHandler;
}

// Runtime binding remains source-owned. The ordinary scaffold supplies none.
// The existing workspace adapter retains its separate Set-Cookie prohibition.
export function createWorkspaceApiHttpListener(binding?: WorkspaceApiHttpBinding) {
  const configured = binding && Object.freeze({ ...binding });
  const workspace = createWorkspaceHttpListener(configured);
  const auth = createAuthHttpListener(
    configured && {
      origin: configured.origin,
      auth: configured.auth,
      ...(configured.logout ? { logout: configured.logout } : {}),
      ...(configured.rotate ? { rotate: configured.rotate } : {}),
    },
  );
  return (request: IncomingMessage, response: ServerResponse): void => {
    const target = request.url ?? "";
    if (target === "/auth" || target.startsWith("/auth/") || target.startsWith("/auth?"))
      auth(request, response);
    else workspace(request, response);
  };
}
