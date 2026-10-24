import {
  WorkGuardError,
  guardWorkspaceRequest,
  workOrigin,
  type GuardedWorkspaceRequest,
  type WorkspaceRouteSpec,
} from "../http-guard.js";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
} from "../connection.js";
import { workErrorResponse, type WorkApiDependencies } from "../http.js";
import type { RunCommandType, RunRead, RunRefusal } from "./commands.js";
import { prepareRunCommand, RunReject, runRunCommand, runRunRead } from "./commands.js";

// The runs routes of the workspace API (M3 PR-2): an internal JSON contract between the api
// Worker and Morrow's own SPA, beside the work API, under /workspace/:ws/work (the generalised
// guard's "work" family; the api's dispatch table sends exactly these paths here):
//   POST /work/tasks/:taskId/runs   run admission (201 the run, or a refusal)
//   GET  /work/tasks/:taskId/runs   the task's runs
//   GET  /work/runs/:runId          one run: status, products, credits, usage, proposals
//   POST /work/runs-reconcile       close the workspace's interrupted runs (credits back)
// One connection per request, a 5 s deadline, never Set-Cookie, never CORS. While the
// model-provider switch is off (`admission` false) admission answers 503 runs_unavailable
// before any database access: no run, lease or reservation exists without the gateway.
export interface RunsApiDependencies extends WorkApiDependencies {
  readonly environment: "development" | "staging" | "production";
  /** The reviewed model-provider switch is on (MORROW_MODEL_PROVIDER "anthropic"). */
  readonly admission: boolean;
}
export interface RunRoute extends WorkspaceRouteSpec {
  readonly op: RunCommandType | RunRead;
}
const route = (method: RunRoute["method"], pattern: string, op: RunRoute["op"]): RunRoute =>
  Object.freeze({ method, pattern, query: [], op });
export const runRoutes: readonly RunRoute[] = Object.freeze([
  route("POST", "/tasks/:taskId/runs", "run.admit"),
  route("GET", "/tasks/:taskId/runs", "run.list_of_task"),
  route("GET", "/runs/:runId", "run.get"),
  route("POST", "/runs-reconcile", "run.reconcile"),
]);
/** The paths the api Worker sends to this handler (its dispatch row, ahead of the work API). */
export const runsPathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/work\/(?:tasks\/[^/]+\/runs|runs\/[^/]+|runs-reconcile)$/;

type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers } });
// The run refusals as ErrorEnvelopes (closed codes; the safe message is what the Ask screen
// shows). Credits and caps are budget_exhausted; entitlement and authority are denied.
const refusals: Readonly<Record<RunRefusal, readonly [number, string, string, string]>> =
  Object.freeze({
    runs_unavailable: [
      503,
      "unavailable",
      "recheck_before_retry",
      "AI drafting is not available yet.",
    ],
    entitlement: [403, "denied", "never", "An active Morrow plan is required to draft listings."],
    insufficient_credits: [409, "budget_exhausted", "never", "Not enough credits for this run."],
    daily_cap: [
      409,
      "budget_exhausted",
      "never",
      "Today's AI spending limit for this workspace is reached.",
    ],
    // Never returned since migration 0047 (ADR-0036 removed the unrecovered-cost cap).
    unrecovered_cost_cap: [
      409,
      "budget_exhausted",
      "never",
      "Too many products failed this billing period. Drafting resumes next period.",
    ],
    run_product_limit: [
      409,
      "budget_exhausted",
      "never",
      "Too many products for this model and effort.",
    ],
    selection_invalid: [400, "missing_input", "never", "That model or effort is not available."],
    selection_above_ceiling: [
      403,
      "denied",
      "never",
      "That model or effort is above your workspace's limit.",
    ],
    stopped: [409, "conflict", "never", "AI work is stopped for this store."],
    installation_inactive: [
      409,
      "conflict",
      "never",
      "The Listings agent is not enabled for this store.",
    ],
    approvals_limit: [
      409,
      "conflict",
      "never",
      "Too many changes are waiting for review. Approve or reject some, then try again.",
    ],
  });
function refusalResponse(reason: RunRefusal, correlationId: string): Response {
  const [status, code, retryClass, safeMessage] = refusals[reason];
  return json(status, {
    schemaVersion: 1,
    code,
    retryClass,
    safeMessage,
    correlationId,
    operationId: null,
    retryAfterSeconds: null,
    inputRequestIds: [],
  });
}
function guardKind(error: WorkGuardError) {
  if (error.status === 401) return "unauthenticated" as const;
  if (error.status === 400) return "invalid" as const;
  if (error.status === 404) return "not_found" as const;
  if (error.status === 405) return "method_not_allowed" as const;
  return "guard_denied" as const;
}
function dependencies(value: RunsApiDependencies): RunsApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    !["development", "staging", "production"].includes(value.environment) ||
    typeof value.admission !== "boolean"
  )
    throw Error("RUNS_API_CONFIGURATION_INVALID");
  const connector = value.connector;
  const now = value.now;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
    environment: value.environment,
    admission: value.admission,
  });
}
const reads: readonly string[] = ["run.get", "run.list_of_task"];

export function createRunsApiHandler(d?: RunsApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("RUNS_CLOCK_INVALID");
    const deadlineMs = start + 5000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    try {
      let g: GuardedWorkspaceRequest<RunRoute>;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "work",
          runRoutes,
          request,
          abort.signal,
        );
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.pattern;
      read = reads.includes(g.route.op);
      if (g.route.op === "run.admit" && !configured.admission) {
        log.outcome = "runs_unavailable";
        return { log, response: refusalResponse("runs_unavailable", correlationId) };
      }
      const prepared = read ? undefined : await prepareRunCommand(g.route.op as RunCommandType, g);
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
        // A run refusal is a value of the transaction, which then ends in ROLLBACK (persisting
        // nothing); withWorkTransaction passes only its own typed rejections through.
        const result = await withWorkTransaction(connection, options, async (tx) => {
          try {
            return prepared
              ? await runRunCommand(tx, g, prepared, correlationId, configured.environment)
              : await runRunRead(tx, g, g.route.op as RunRead);
          } catch (error) {
            if (!(error instanceof RunReject)) throw error;
            tx.rollbackOnly();
            return { refusal: error.reason } as const;
          }
        });
        if ("refusal" in result) {
          log.outcome = result.refusal;
          return { log, response: refusalResponse(result.refusal, correlationId) };
        }
        log.outcome = result.outcome;
        return { log, response: json(result.status, { schemaVersion: 1, ...result.body }) };
      } finally {
        await connection.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof RunReject) {
        log.outcome = error.reason;
        return { log, response: refusalResponse(error.reason, correlationId) };
      }
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
        console.log(JSON.stringify({ event: "morrow_runs", ...log, correlationId }));
      }
    },
  });
}
