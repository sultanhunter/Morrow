import {
  createWorkersManagedWorkspaceApi,
  type ManagedWorkspaceApiDependencies,
} from "../../../packages/identity/src/managed-workspace-api.js";
import { createWorkApiHandler, type WorkApiDependencies } from "../../../packages/work/src/http.js";
import {
  agentsPathPattern,
  createAgentsApiHandler,
} from "../../../packages/work/src/agents/http.js";

type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
// P06.T01a: /workspace/<Id>/work(/|$) goes to the work API; every other path is
// the unchanged P05 handler. Both share the /workspace/* namespace that the api
// Worker serves ahead of Static Assets (run_worker_first).
const workPath = /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/work(?:\/|$)/;
// M3 PR-1: /workspace/<Id>/stores/<Id>/agents(/|$), /models and /settings/model-default go to
// the agents handler, on the same work dependencies (M5 PR-1 turns these tests into one
// ordered dispatch table; this is its agents row).

// The configured local fixture imports this exact entry constructor. The
// ordinary artifact intentionally has no account/secret/environment binding:
// without work dependencies every work route is 401 with no network or database.
export function createWorkspaceApiWorker(
  dependencies?: ManagedWorkspaceApiDependencies,
  work?: WorkApiDependencies,
) {
  const workspace = createWorkersManagedWorkspaceApi(dependencies);
  const workApi = createWorkApiHandler(work);
  const agentsApi = createAgentsApiHandler(work);
  return Object.freeze({
    fetch(request: Request, env: unknown, ctx: Context): Promise<Response> {
      let path = "";
      try {
        path = new URL(request.url).pathname;
      } catch {
        path = "";
      }
      // No await precedes the selected owner; its response is returned unchanged.
      if (workPath.test(path)) return workApi.fetch(request, env, ctx);
      if (agentsPathPattern.test(path)) return agentsApi.fetch(request, env, ctx);
      return workspace.fetch(request, env, ctx);
    },
  });
}

export default createWorkspaceApiWorker();
