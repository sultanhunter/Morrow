import {
  createWorkersManagedWorkspaceApi,
  type ManagedWorkspaceApiDependencies,
} from "../../../packages/identity/src/managed-workspace-api.js";
import {
  createBillingApiHandler,
  type BillingApiDependencies,
} from "../../../packages/work/src/billing/http.js";
import {
  createStripeWebhookHandler,
  stripeWebhookPath,
  type StripeWebhookDependencies,
} from "../../../packages/work/src/billing/webhook.js";
import { createWorkApiHandler, type WorkApiDependencies } from "../../../packages/work/src/http.js";
import {
  agentsPathPattern,
  createAgentsApiHandler,
} from "../../../packages/work/src/agents/http.js";
import {
  catalogPathPattern,
  createCatalogApiHandler,
  type CatalogApiDependencies,
} from "../../../packages/work/src/catalog/http.js";

type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
type Handler = Readonly<{
  fetch(request: Request, env: unknown, ctx: Context): Promise<Response>;
}>;
// The api Worker's ordered dispatch table (integration "Workspace request guard and api
// dispatch"; M5 PR-1). The first matching row owns the request and its response is returned
// unchanged; anything else goes to the unchanged P05 handler (/connections and /store-links
// among it). Every family shares the /workspace/* and /api/* namespaces that the api Worker
// serves ahead of Static Assets (run_worker_first). Later PRs add one row each:
//   /workspace/:ws/work(/|$)                     work API (P06.T01a)
//   /workspace/:ws/billing(/|$)                  billing API (M5 PR-1)
//   POST /api/billing/stripe/webhook (exact)     Stripe webhook (M5 PR-1)
//   /workspace/:ws/stores/:storeId/agents/, /workspace/:ws/models, /workspace/:ws/settings/model-default
//                                                agents (M3 PR-1)
//   /workspace/:ws/stores/:storeId/catalog/      catalogue reads (M2 PR-3)
const workspaceId = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
type RowKey = "work" | "billing" | "stripe_webhook" | "agents" | "catalog";
export const apiDispatchRows: readonly (readonly [RowKey, (path: string) => boolean])[] =
  Object.freeze([
    ["work", (path: string) => new RegExp(`^/workspace/${workspaceId}/work(?:/|$)`).test(path)],
    [
      "billing",
      (path: string) => new RegExp(`^/workspace/${workspaceId}/billing(?:/|$)`).test(path),
    ],
    ["stripe_webhook", (path: string) => path === stripeWebhookPath],
    // M3 PR-1: the agents routes, on the work dependencies (packages/work/src/agents/http.ts).
    ["agents", (path: string) => agentsPathPattern.test(path)],
    // M2 PR-3: the catalogue reads, on the work dependencies and the broker's shopifyRead.
    ["catalog", (path: string) => catalogPathPattern.test(path)],
  ] as const);
export function apiDispatch(path: string): RowKey | "workspace" {
  for (const [key, matches] of apiDispatchRows) if (matches(path)) return key;
  return "workspace";
}

// The configured local fixture imports this exact entry constructor. The ordinary artifact
// intentionally has no account/secret/environment binding: without dependencies every work,
// billing, agents and catalogue route is 401 and the webhook 404, with no network or
// database.
export function createWorkspaceApiWorker(
  dependencies?: ManagedWorkspaceApiDependencies,
  work?: WorkApiDependencies,
  billing?: BillingApiDependencies,
  webhook?: StripeWebhookDependencies,
  catalog?: CatalogApiDependencies,
) {
  const workspace = createWorkersManagedWorkspaceApi(dependencies);
  const handlers: Readonly<Record<RowKey, Handler>> = Object.freeze({
    work: createWorkApiHandler(work),
    billing: createBillingApiHandler(billing),
    stripe_webhook: createStripeWebhookHandler(webhook),
    agents: createAgentsApiHandler(work),
    catalog: createCatalogApiHandler(catalog),
  });
  return Object.freeze({
    fetch(request: Request, env: unknown, ctx: Context): Promise<Response> {
      let path = "";
      try {
        path = new URL(request.url).pathname;
      } catch {
        path = "";
      }
      // No await precedes the selected owner; its response is returned unchanged.
      const key = apiDispatch(path);
      if (key !== "workspace") return handlers[key].fetch(request, env, ctx);
      return workspace.fetch(request, env, ctx);
    },
  });
}

export default createWorkspaceApiWorker();
