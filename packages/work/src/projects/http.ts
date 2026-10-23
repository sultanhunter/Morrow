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
import {
  goalProgressRead,
  prepareProjectCommand,
  ProjectReject,
  runProjectCommand,
  startGate,
  type ProjectCommandType,
  type ProjectRead,
  type ProjectRefusal,
} from "./commands.js";

// The goal and plan-start routes of the workspace API (PR 18; docs/contracts/work-api.md
// "Goal and plan routes"): an internal JSON contract between the api Worker and Morrow's
// own SPA, under /workspace/:ws/work (the generalised guard's "work" family; the api's
// dispatch table sends exactly these paths here, ahead of the work API):
//   POST /work/goals/:goalId/revise     workspace.goal.revise (human_only)
//   POST /work/goals/:goalId/checks     workspace.goal.measure.record (human_only)
//   GET  /work/goals/:goalId/progress   GoalProgress@1 for this viewer
//   POST /work/plans/start-document     the plan start document (ADR-0034 item 5)
//   POST /work/plans/start              the plan start's one transaction
// Both switches default off and answer before any connection opens: the goal routes until
// T7 uses them (`goals` false: 503), the start routes while docs/decisions/plan-drafts-
// staging.json holds them (503), and a Morrow card while plan drafts are off (503).
export interface ProjectsApiDependencies extends WorkApiDependencies {
  /** The goal routes are open (default off until T7 uses them). */
  readonly goals: boolean;
  /**
   * docs/decisions/plan-drafts-staging.json as the api composes it (planDraftsRecord): the
   * start routes are `held` until lab:plan-start passes, and Morrow's cards need `on`.
   */
  readonly planDrafts: { readonly switch: "on" | "off"; readonly start_routes: "held" | "ready" };
}
export interface ProjectRoute extends WorkspaceRouteSpec {
  readonly op: ProjectCommandType | ProjectRead;
}
const route = (method: ProjectRoute["method"], pattern: string, op: ProjectRoute["op"]) =>
  Object.freeze({ method, pattern, query: [], op }) as ProjectRoute;
export const projectRoutes: readonly ProjectRoute[] = Object.freeze([
  route("POST", "/goals/:goalId/revise", "goal.revise"),
  route("POST", "/goals/:goalId/checks", "goal.check"),
  route("GET", "/goals/:goalId/progress", "goal.progress"),
  route("POST", "/plans/start-document", "plan.start_document"),
  route("POST", "/plans/start", "plan.start"),
]);
/** The paths the api Worker sends to this handler (its dispatch row, ahead of the work API). */
export const projectsPathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/work\/(?:goals\/[^/]+\/(?:revise|checks|progress)|plans\/(?:start-document|start))$/;

type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers } });
const refusals: Readonly<Record<ProjectRefusal, readonly [number, string, string, string]>> =
  Object.freeze({
    goals_unavailable: [503, "unavailable", "recheck_before_retry", "Goals are not available yet."],
    start_unavailable: [
      503,
      "unavailable",
      "recheck_before_retry",
      "Starting plans is not available yet.",
    ],
    plan_drafts_off: [
      503,
      "unavailable",
      "recheck_before_retry",
      "Morrow's plan cards are not available yet.",
    ],
    actor_ineligible: [403, "denied", "never", "Only the person who asked can start this card."],
    stale: [
      409,
      "conflict",
      "recheck_before_retry",
      "This card changed or expired. Open it again to start it.",
    ],
    repeating_unavailable: [
      409,
      "conflict",
      "never",
      "Repeating tasks can't be started from a card yet.",
    ],
    stopped: [409, "conflict", "never", "A helper on this card is stopped."],
    agent_not_added: [409, "conflict", "never", "Add this area's agent first."],
  });
function refusalResponse(reason: ProjectRefusal, correlationId: string): Response {
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
function dependencies(value: ProjectsApiDependencies): ProjectsApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    typeof value.goals !== "boolean" ||
    !value.planDrafts ||
    !["on", "off"].includes(value.planDrafts.switch) ||
    !["held", "ready"].includes(value.planDrafts.start_routes)
  )
    throw Error("PROJECTS_API_CONFIGURATION_INVALID");
  const connector = value.connector;
  const now = value.now;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
    goals: value.goals,
    planDrafts: Object.freeze({
      switch: value.planDrafts.switch,
      start_routes: value.planDrafts.start_routes,
    }),
  });
}

export function createProjectsApiHandler(d?: ProjectsApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("PROJECTS_CLOCK_INVALID");
    const deadlineMs = start + 5000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    try {
      let g: GuardedWorkspaceRequest<ProjectRoute>;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "work",
          projectRoutes,
          request,
          abort.signal,
        );
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.pattern;
      read = g.route.op === "goal.progress";
      const goalRoute = g.route.op.startsWith("goal.");
      if (goalRoute && !configured.goals) {
        log.outcome = "goals_unavailable";
        return { log, response: refusalResponse("goals_unavailable", correlationId) };
      }
      const prepared = read
        ? undefined
        : await prepareProjectCommand(g.route.op as ProjectCommandType, g);
      if (prepared) {
        const gate = startGate(prepared.type, prepared.parsed, configured.planDrafts);
        if (gate !== "ok") {
          log.outcome = gate;
          return { log, response: refusalResponse(gate, correlationId) };
        }
      }
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
        // A refusal is a value of the transaction, which then ends in ROLLBACK (persisting
        // nothing); withWorkTransaction passes only its own typed rejections through.
        const result = await withWorkTransaction(connection, options, async (tx) => {
          try {
            return prepared
              ? await runProjectCommand(tx, g, prepared, correlationId, configured.planDrafts)
              : await goalProgressRead(tx, g);
          } catch (error) {
            if (!(error instanceof ProjectReject)) throw error;
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
      if (error instanceof ProjectReject) {
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
        console.log(JSON.stringify({ event: "morrow_projects", ...log, correlationId }));
      }
    },
  });
}
