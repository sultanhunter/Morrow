import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
  type WorkTx,
} from "../connection.js";
import { enterWorkContext, type WorkAuthority } from "../context.js";
import { decodeCursor } from "../contract-mapping.js";
import {
  WorkGuardError,
  guardWorkspaceRequest,
  workOrigin,
  type GuardedWorkspaceRequest,
  type WorkspaceRouteSpec,
} from "../http-guard.js";
import { workErrorResponse, type WorkApiDependencies } from "../http.js";
import { parseActivityLimit, readActivity } from "./activity.js";
import { readInbox } from "./read.js";

// The Inbox and Activity reads of the workspace API (v1 PR 15, track T7): an internal JSON
// contract between the api Worker and Morrow's own SPA (docs/contracts/work-api.md, "Inbox
// and activity"), under /workspace/:ws/work (the api's dispatch table sends exactly these
// two paths here, ahead of the work API):
//   GET /work/inbox                  what waits for this person (inbox/read.ts)
//   GET /work/activity[?after=&limit=]  the activity log, newest first (inbox/activity.ts)
// Reads only: one READ ONLY transaction each, on the work login, within 5 s. No switch: they
// read records that exist, and every item is filtered on the server by the rule of its own
// screen. Never Set-Cookie, never CORS; database error text is never logged or returned.
// With no dependencies every route is 401 with no network or database access.
export type InboxRead = "inbox.read" | "activity.list";
export interface InboxRoute extends WorkspaceRouteSpec {
  readonly op: InboxRead;
}
const route = (pattern: string, op: InboxRead, query: string[] = []) =>
  Object.freeze({ method: "GET", pattern, query, op }) as InboxRoute;
export const inboxRoutes: readonly InboxRoute[] = Object.freeze([
  route("/inbox", "inbox.read"),
  route("/activity", "activity.list", ["after", "limit"]),
]);
/** The paths the api Worker sends to this handler (its dispatch row, ahead of the work API). */
export const inboxPathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/work\/(?:inbox|activity)$/;

type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
const json = (body: unknown) =>
  new Response(JSON.stringify({ schemaVersion: 1, ...(body as object) }), {
    status: 200,
    headers: { ...headers },
  });
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
    throw Error("INBOX_API_CONFIGURATION_INVALID");
  const { connector, now } = value;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
  });
}
async function context(tx: WorkTx, g: GuardedWorkspaceRequest<InboxRoute>): Promise<WorkAuthority> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  return a;
}

export function createInboxApiHandler(d?: WorkApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log: { route: string; outcome: string; items?: number } = {
      route: "unmatched",
      outcome: "unbound",
    };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("INBOX_CLOCK_INVALID");
    const deadlineMs = start + 5000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    try {
      let g: GuardedWorkspaceRequest<InboxRoute>;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "work",
          inboxRoutes,
          request,
          abort.signal,
        );
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.pattern;
      // The query is checked before any connection opens.
      const limit = g.route.op === "activity.list" ? parseActivityLimit(g.query.get("limit")) : 0;
      if (limit === "invalid") throw new WorkReject("invalid");
      const after = g.query.get("after") ?? null;
      if (after !== null && decodeCursor(after) === null) throw new WorkReject("invalid");
      let connection: WorkSqlConnection;
      try {
        connection = await configured.connector.open({
          signal: abort.signal,
          deadlineMs,
          waitUntil: (p) => ctx.waitUntil(p),
        });
      } catch {
        log.outcome = "unavailable";
        return { log, response: workErrorResponse("unavailable_read", correlationId) };
      }
      try {
        const options = { readOnly: true, deadlineMs, signal: abort.signal, now: configured.now };
        const body = await withWorkTransaction(connection, options, async (tx) => {
          const a = await context(tx, g);
          if (g.route.op === "inbox.read") return readInbox(tx, a);
          const page = await readActivity(tx, a, { after, limit });
          if (page === "invalid") throw new WorkReject("invalid");
          return page;
        });
        log.outcome = "read";
        log.items = "items" in body ? body.items.length : body.entries.length;
        return { log, response: json(body) };
      } finally {
        await connection.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof WorkReject) {
        log.outcome = error.reason;
        const kind = error.reason === "unavailable" ? "unavailable_read" : error.reason;
        return { log, response: workErrorResponse(kind, correlationId) };
      }
      // A read sends nothing that could commit: an unknown outcome is still a failed read.
      log.outcome = error instanceof WorkOutcomeUnknown ? "uncertain" : "unavailable";
      return { log, response: workErrorResponse("unavailable_read", correlationId) };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", stop);
    }
  }
  return Object.freeze({
    async fetch(request: Request, _env: unknown, ctx: Context): Promise<Response> {
      const correlationId = crypto.randomUUID();
      let log: Record<string, unknown> = { route: "unmatched", outcome: "unavailable" };
      try {
        if (!(request instanceof Request)) {
          log.outcome = "invalid";
          return workErrorResponse("invalid", correlationId);
        }
        const handled = await handle(request, ctx, correlationId);
        log = handled.log;
        return handled.response;
      } catch {
        return workErrorResponse("unavailable_read", correlationId);
      } finally {
        console.log(JSON.stringify({ event: "morrow_inbox", ...log, correlationId }));
      }
    },
  });
}
