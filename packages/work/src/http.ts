import type { Core_ErrorEnvelope } from "@morrow/contracts";
import { validateDefinition } from "@morrow/contracts/validation";
import { prepareWorkCommand, runWorkCommand } from "./commands.js";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkRejection,
  type WorkSqlConnection,
  type WorkSqlConnector,
} from "./connection.js";
import type { WorkCommandType } from "./digest.js";
import {
  guardWorkRequest,
  WorkGuardError,
  workOrigin,
  type GuardedWorkRequest,
  type WorkRoute,
} from "./http-guard.js";
import { prepareWorkRead, runWorkRead, type WorkReadKind } from "./queries.js";

// The work HTTP API v1 (ADR-0010 item 3; docs/contracts/work-api.md). An internal
// JSON contract between the api Worker and Morrow's own SPA, Workers only. One
// connection per request; a 5 s deadline; never Set-Cookie, never CORS. Database
// error text is never logged or returned: the Worker logs one fixed line.
export type { WorkRoute } from "./http-guard.js";
export interface WorkApiDependencies {
  readonly origin: string;
  readonly connector: WorkSqlConnector;
  readonly now: () => number;
}
type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;

const route = (
  method: "GET" | "POST",
  pattern: string,
  permission: WorkRoute["permission"],
  query: readonly string[] = [],
): WorkRoute =>
  Object.freeze({
    method,
    pattern,
    idParams: Object.freeze(
      pattern
        .split("/")
        .filter((p) => p.startsWith(":"))
        .map((p) => p.slice(1)),
    ),
    permission,
    query: Object.freeze([...query]),
  });
/** Every route under /workspace/:ws/work, shared with the conformance harness. */
export const workRoutes: readonly WorkRoute[] = Object.freeze([
  route("GET", "/goals", "goal.read", ["after", "limit"]),
  route("POST", "/goals", "goal.create"),
  route("GET", "/goals/:goalId", "goal.read"),
  route("POST", "/goals/:goalId/status", "goal.transition"),
  route("GET", "/tasks", "task.read", ["goalId", "status", "after", "limit"]),
  route("POST", "/tasks", "task.create"),
  route("GET", "/tasks/:taskId", "task.read"),
  route("POST", "/tasks/:taskId/status", "task.ready"),
  route("POST", "/tasks/:taskId/assignment", "task.assign"),
  route("GET", "/tasks/:taskId/questions", "question.read", ["after", "limit"]),
  route("POST", "/tasks/:taskId/questions", "question.request"),
  route("GET", "/questions", "question.read", ["respondent", "status", "after", "limit"]),
  route("GET", "/questions/:questionId", "question.read"),
  route("POST", "/questions/:questionId/answer", "question.answer"),
  route("GET", "/questions/:questionId/answer", "answer.read"),
  route("POST", "/questions/:questionId/status", "question.cancel"),
]);
const readKinds: Readonly<Record<string, WorkReadKind>> = Object.freeze({
  "/goals": "goal.list",
  "/goals/:goalId": "goal.get",
  "/tasks": "task.list",
  "/tasks/:taskId": "task.get",
  "/tasks/:taskId/questions": "question.list_of_task",
  "/questions": "question.list",
  "/questions/:questionId": "question.get",
  "/questions/:questionId/answer": "answer.get",
});
const commandTypes: Readonly<Record<string, WorkCommandType>> = Object.freeze({
  "/goals": "goal.create",
  "/goals/:goalId/status": "goal.transition",
  "/tasks": "task.create",
  "/tasks/:taskId/status": "task.ready",
  "/tasks/:taskId/assignment": "task.assign",
  "/tasks/:taskId/questions": "question.request",
  "/questions/:questionId/answer": "question.answer",
  "/questions/:questionId/status": "question.cancel",
});

type ErrorKind =
  | WorkRejection
  | "guard_denied"
  | "method_not_allowed"
  | "uncertain"
  | "unavailable_read";
const errors: Readonly<
  Record<
    ErrorKind,
    readonly [number, Core_ErrorEnvelope["code"], Core_ErrorEnvelope["retryClass"], string]
  >
> = Object.freeze({
  unauthenticated: [401, "denied", "never", "Sign in to continue."],
  invalid: [400, "missing_input", "never", "The request is not valid."],
  guard_denied: [403, "denied", "never", "This request is not permitted."],
  denied: [403, "denied", "never", "This operation is not permitted."],
  field_denied: [403, "denied", "never", "The requested fields are not permitted."],
  store_denied: [403, "denied", "never", "This resource scope is not permitted."],
  grant_overflow: [403, "denied", "never", "Current authority cannot be evaluated."],
  not_found: [404, "denied", "never", "The record was not found."],
  not_respondent: [403, "denied", "never", "This operation is not permitted."],
  method_not_allowed: [405, "denied", "never", "This method is not allowed."],
  revision_conflict: [
    409,
    "conflict",
    "recheck_before_retry",
    "The record changed. Reread it before retrying.",
  ],
  state_conflict: [
    409,
    "conflict",
    "recheck_before_retry",
    "This change is not allowed from the current state.",
  ],
  guard_failed: [
    409,
    "conflict",
    "recheck_before_retry",
    "A precondition for this change is not met.",
  ],
  stale_authority: [
    409,
    "conflict",
    "recheck_before_retry",
    "Current authority changed. Retry the request.",
  ],
  command_conflict: [
    409,
    "conflict",
    "never",
    "This idempotency key was already used for a different request.",
  ],
  target_ineligible: [409, "conflict", "never", "That person is not eligible for this work."],
  limit_reached: [409, "conflict", "never", "A published limit has been reached."],
  unavailable: [503, "unavailable", "recheck_before_retry", "Work is temporarily unavailable."],
  unavailable_read: [503, "unavailable", "safe_read_retry", "Work is temporarily unavailable."],
  uncertain: [
    503,
    "uncertain",
    "reconcile_before_retry",
    "The outcome is unknown. Retry with the same idempotency key.",
  ],
});
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
}
export function workErrorResponse(kind: ErrorKind, correlationId: string, allow?: string) {
  const [status, code, retryClass, safeMessage] = errors[kind];
  const envelope: Core_ErrorEnvelope = {
    schemaVersion: 1,
    code,
    retryClass,
    safeMessage,
    correlationId,
    operationId: null,
    retryAfterSeconds: null,
    inputRequestIds: [],
  };
  if (!validateDefinition("core", "ErrorEnvelope", envelope)) throw Error("WORK_ERROR_INVALID");
  return json(status, envelope, allow ? { Allow: allow } : {});
}
// The api Worker's per-address session limit (apps/api/src/session-limit.ts) answers a work
// path over its limit before this handler runs, in this API's own error shape: code
// rate_limited, the read class on GET (as the handler classifies a request before its
// guard runs), and the same seconds in retryAfterSeconds and Retry-After.
export function workRateLimitedResponse(
  read: boolean,
  correlationId: string,
  retryAfterSeconds: number,
) {
  const envelope: Core_ErrorEnvelope = {
    schemaVersion: 1,
    code: "rate_limited",
    retryClass: read ? "safe_read_retry" : "recheck_before_retry",
    safeMessage: "Too many requests. Try again shortly.",
    correlationId,
    operationId: null,
    retryAfterSeconds,
    inputRequestIds: [],
  };
  if (!validateDefinition("core", "ErrorEnvelope", envelope)) throw Error("WORK_ERROR_INVALID");
  return json(429, envelope, { "Retry-After": String(retryAfterSeconds) });
}
function guardKind(error: WorkGuardError): ErrorKind {
  if (error.status === 401) return "unauthenticated";
  if (error.status === 400) return "invalid";
  if (error.status === 404) return "not_found";
  if (error.status === 405) return "method_not_allowed";
  return "guard_denied";
}

function dependencies(value: WorkApiDependencies): WorkApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function"
  )
    throw Error("WORK_API_CONFIGURATION_INVALID");
  const connector = value.connector;
  const now = value.now;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
  });
}

// No dependencies: every request is 401 with no network or database access.
export function createWorkApiHandler(d?: WorkApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("WORK_CLOCK_INVALID");
    const deadlineMs = start + 5000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    try {
      let g: GuardedWorkRequest;
      try {
        g = await guardWorkRequest(configured.origin, workRoutes, request, abort.signal);
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.pattern;
      read = g.route.method === "GET";
      const kind = read ? readKinds[g.route.pattern] : undefined;
      const type = read ? undefined : commandTypes[g.route.pattern];
      // Step 1 completes before any connection opens.
      const prepared = type ? await prepareWorkCommand(type, g) : undefined;
      if (kind) prepareWorkRead(kind, g);
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
        if (kind) {
          const result = await withWorkTransaction(connection, options, (tx) =>
            runWorkRead(tx, g, kind),
          );
          log.outcome = "read";
          return { log, response: json(200, { schemaVersion: 1, ...result.body }) };
        }
        if (!type || !prepared) throw Error("WORK_ROUTE_UNMAPPED");
        const result = await withWorkTransaction(connection, options, (tx) =>
          runWorkCommand(tx, g, prepared, correlationId),
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
        console.log(JSON.stringify({ event: "morrow_work", ...log, correlationId }));
      }
    },
  });
}
