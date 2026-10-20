import { WorkGuardError, workOrigin } from "../http-guard.js";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
} from "../connection.js";
import { workErrorResponse, type WorkApiDependencies } from "../http.js";
import {
  prepareAgentCommand,
  runAgentCommand,
  runAgentRead,
  type AgentCommandType,
  type AgentRead,
} from "./commands.js";
import {
  guardWorkspaceRequest,
  type GuardedWorkspaceRequest,
  type WorkspaceRouteSpec,
} from "./workspace-guard-stub.js";

// The agents routes of the workspace API (M3 PR-1): an internal JSON contract between the
// api Worker and Morrow's own SPA, beside the work API (docs/contracts/work-api.md). One
// connection per request, a 5 s deadline, never Set-Cookie, never CORS; database error
// text is never logged or returned. With no dependencies every route is 401 with no
// network or database access.
export interface AgentRoute extends WorkspaceRouteSpec {
  readonly op: AgentCommandType | AgentRead;
}
const route = (method: AgentRoute["method"], pattern: string, op: AgentRoute["op"]): AgentRoute =>
  Object.freeze({ method, pattern, query: Object.freeze([]), op });
/** Every agents route, relative to /workspace/:ws (the api Worker dispatches these here). */
export const agentRoutes: readonly AgentRoute[] = Object.freeze([
  route("GET", "/stores/:storeId/agents/listings", "listings.status"),
  route("POST", "/stores/:storeId/agents/listings/document", "installation.document"),
  route("POST", "/stores/:storeId/agents/listings", "installation.enable"),
  route("POST", "/stores/:storeId/agents/listings/stop", "installation.stop"),
  route("GET", "/models", "models.list"),
  route("PUT", "/settings/model-default", "model_default.revise"),
]);
/** The paths the api Worker sends to this handler (one dispatch row, M5's table). */
export const agentsPathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/(?:stores\/[^/]+\/agents(?:\/|$)|models$|settings\/model-default$)/;

type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers } });
function guardKind(error: WorkGuardError) {
  if (error.status === 401) return "unauthenticated" as const;
  if (error.status === 400) return "invalid" as const;
  if (error.status === 404) return "not_found" as const;
  if (error.status === 405) return "method_not_allowed" as const;
  return "guard_denied" as const;
}
function dependencies(value: WorkApiDependencies): WorkApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function"
  )
    throw Error("AGENTS_API_CONFIGURATION_INVALID");
  const connector = value.connector;
  const now = value.now;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
  });
}
const reads: readonly string[] = ["listings.status", "models.list"];

export function createAgentsApiHandler(d?: WorkApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("AGENTS_CLOCK_INVALID");
    const deadlineMs = start + 5000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    try {
      let g: GuardedWorkspaceRequest<AgentRoute>;
      try {
        g = await guardWorkspaceRequest(configured.origin, agentRoutes, request, abort.signal);
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.pattern;
      read = reads.includes(g.route.op);
      // Step 1 completes before any connection opens.
      const prepared = read
        ? undefined
        : await prepareAgentCommand(g.route.op as AgentCommandType, g);
      let connection: WorkSqlConnection;
      try {
        connection = await configured.connector.open({
          signal: abort.signal,
          deadlineMs,
          waitUntil: (p) => ctx.waitUntil(p),
        });
      } catch {
        log.outcome = "unavailable";
        return {
          log,
          response: workErrorResponse(read ? "unavailable_read" : "unavailable", correlationId),
        };
      }
      try {
        const options = { readOnly: read, deadlineMs, signal: abort.signal, now: configured.now };
        const result = await withWorkTransaction(connection, options, (tx) =>
          prepared
            ? runAgentCommand(tx, g, prepared, correlationId)
            : runAgentRead(tx, g, g.route.op as AgentRead),
        );
        log.outcome = result.outcome;
        return { log, response: json(result.status, { schemaVersion: 1, ...result.body }) };
      } finally {
        await connection.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof WorkReject) {
        log.outcome = error.reason;
        const kind = error.reason === "unavailable" && read ? "unavailable_read" : error.reason;
        return { log, response: workErrorResponse(kind, correlationId) };
      }
      if (error instanceof WorkOutcomeUnknown) {
        log.outcome = "uncertain";
        return { log, response: workErrorResponse("uncertain", correlationId) };
      }
      log.outcome = "unavailable";
      return {
        log,
        response: workErrorResponse(read ? "unavailable_read" : "unavailable", correlationId),
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", stop);
    }
  }
  return Object.freeze({
    async fetch(request: Request, _env: unknown, ctx: Context): Promise<Response> {
      const correlationId = crypto.randomUUID();
      let log = { route: "unmatched", outcome: "unavailable" };
      try {
        if (!(request instanceof Request)) {
          log.outcome = "invalid";
          return workErrorResponse("invalid", correlationId);
        }
        const handled = await handle(request, ctx, correlationId);
        log = handled.log;
        return handled.response;
      } catch {
        return workErrorResponse("unavailable", correlationId);
      } finally {
        console.log(JSON.stringify({ event: "morrow_agents", ...log, correlationId }));
      }
    },
  });
}
