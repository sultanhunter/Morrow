import { createControlledWorkspaceStoreLinking } from "./workspace-store-linking-control.js";
import { runShopifyLinkIssuer, type ConnectionKernel } from "./shopify-link-issuer.js";
import {
  createStandaloneRequestGuard,
  standaloneJson,
  type GuardedStandaloneRequest,
} from "./standalone-request-guard.js";
import type { StandaloneWorkspaceBootstrapDependencies } from "./standalone-workspace-bootstrap.js";

export type StandaloneStoreLinkingRoute = "preview" | "apply" | "status";

// Captured once for each owning construction. Legacy callers retain their
// original shared service; managed callers supply their request-bound pool. M2 PR-2: with
// a connection kernel, the preview first runs the Shopify continuation issuer
// (shopify-link-issuer.ts); without one, no Shopify handoff can be issued.
export function createStandaloneStoreLinkingExecution(
  dependencies: StandaloneWorkspaceBootstrapDependencies & {
    readonly connections?: ConnectionKernel;
  },
) {
  const service = createControlledWorkspaceStoreLinking({
    pool: dependencies.pool,
    now: dependencies.now,
  });
  const kernel = dependencies.connections;
  return Object.freeze({
    async execute(
      route: StandaloneStoreLinkingRoute,
      context: Readonly<GuardedStandaloneRequest>,
    ): Promise<Response> {
      const selector = JSON.stringify({
        sessionDigest: context.sessionDigest,
        workspaceId: context.workspaceId,
        nonceDigest: context.nonceDigest,
        commandId: context.commandId,
      });
      try {
        if (route === "status") {
          const result = await context.wait(service.status(selector, context.control));
          context.check();
          return result
            ? standaloneJson(200, { schemaVersion: 1, ...result })
            : standaloneJson(404, { code: "linking_not_found" });
        }
        if (route === "preview" && kernel) {
          const issued = await runShopifyLinkIssuer(
            dependencies.pool,
            dependencies.now,
            kernel,
            context,
          );
          context.check();
          if (issued !== "proceed") return issued;
        }
        const input = await context.wait(service.lookup(selector, context.control));
        context.check();
        if (!input) return standaloneJson(404, { code: "linking_not_found" });
        if (route === "preview") {
          return standaloneJson(200, {
            schemaVersion: 1,
            link: {
              installationId: input.installationId,
              purpose: input.purpose,
              expectedPolicyRevision: input.expectedPolicyRevision,
              expectedOwnershipRevision: input.expectedOwnershipRevision,
            },
            csrfToken: context.csrfToken,
          });
        }
        const result = await context.wait(service.apply(JSON.stringify(input), context.control));
        context.check();
        if (result.outcome === "applied")
          return standaloneJson(200, { schemaVersion: 1, ...result });
        return standaloneJson(result.outcome === "conflict" ? 409 : 403, {
          schemaVersion: 1,
          outcome: result.outcome,
        });
      } catch {
        return route === "apply"
          ? standaloneJson(503, { schemaVersion: 1, outcome: "outcome_unknown" })
          : standaloneJson(503, { code: "unavailable" });
      }
    },
  });
}

// HTTP supplies only an opaque nonce and immutable command key. All authority,
// target, proof and review fields are obtained from the private SQL boundary.
export function createStandaloneStoreLinking(
  dependencies: StandaloneWorkspaceBootstrapDependencies,
) {
  const guard = createStandaloneRequestGuard(dependencies.configurationJson, dependencies.now);
  const execution = createStandaloneStoreLinkingExecution(dependencies);
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      let route: StandaloneStoreLinkingRoute;
      try {
        const path = new URL(request.url).pathname;
        route = path.endsWith("/preview")
          ? "preview"
          : path.endsWith("/status")
            ? "status"
            : "apply";
      } catch {
        return standaloneJson(400, { code: "invalid_request" });
      }
      return guard.handle(request, route, (context) => execution.execute(route, context));
    },
  });
}
