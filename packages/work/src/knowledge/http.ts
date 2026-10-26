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
  KnowledgeReject,
  prepareKnowledgeCommand,
  runKnowledgeCommand,
  runKnowledgeRead,
  type KnowledgeCommandType,
  type KnowledgeRead,
  type KnowledgeRefusal,
} from "./commands.js";

// The shop knowledge and notebook routes of the workspace API (PR 20; docs/contracts/
// work-api.md "Shop knowledge and notebooks"): an internal JSON contract between the api
// Worker and Morrow's own SPA, under /workspace/:ws/work (the generalised guard's "work"
// family; the api's dispatch table sends exactly these paths here, ahead of the work API):
//   GET  /work/knowledge/pages                          the viewer's pages
//   POST /work/knowledge/pages                          a new page (workspace.knowledge.approve)
//   GET  /work/knowledge/pages/:pageId                  one page, its current version and history
//   GET  /work/knowledge/pages/:pageId/versions/:version  one version
//   POST /work/knowledge/pages/:pageId/versions         the next version
//   POST /work/knowledge/pages/:pageId/delete           the deletion path (administer)
//   GET  /work/knowledge/proposals                      pending proposals the viewer may see
//   POST /work/knowledge/proposals/:proposalId/accept   a person accepts the exact digest
//   POST /work/knowledge/proposals/:proposalId/reject   a person rejects it
//   GET  /work/knowledge/search?text=                   full-text search, per viewer
//   GET  /work/agents/:installationId/notebook          an agent's notebook, per viewer
//   POST /work/agents/:installationId/notebook/clear    clear it (workspace.notebook.write administer)
// The switch (docs/decisions/shop-knowledge-staging.json) is committed off: every route
// answers 503 before any connection opens.
export interface KnowledgeApiDependencies extends WorkApiDependencies {
  /** The shop-knowledge switch's `switch` (committed off). */
  readonly knowledge: "on" | "off";
}
export interface KnowledgeRoute extends WorkspaceRouteSpec {
  readonly op: KnowledgeCommandType | KnowledgeRead;
}
const route = (
  method: KnowledgeRoute["method"],
  pattern: string,
  op: KnowledgeRoute["op"],
  query: readonly string[] = [],
) => Object.freeze({ method, pattern, query, op }) as KnowledgeRoute;
export const knowledgeRoutes: readonly KnowledgeRoute[] = Object.freeze([
  route("GET", "/knowledge/pages", "knowledge.pages"),
  route("POST", "/knowledge/pages", "knowledge.create"),
  route("GET", "/knowledge/pages/:pageId", "knowledge.page"),
  route("GET", "/knowledge/pages/:pageId/versions/:version", "knowledge.version_read"),
  route("POST", "/knowledge/pages/:pageId/versions", "knowledge.version"),
  route("POST", "/knowledge/pages/:pageId/delete", "knowledge.delete"),
  route("GET", "/knowledge/proposals", "knowledge.proposals"),
  route("POST", "/knowledge/proposals/:proposalId/accept", "knowledge.accept"),
  route("POST", "/knowledge/proposals/:proposalId/reject", "knowledge.reject"),
  route("GET", "/knowledge/search", "knowledge.search", ["text"]),
  route("GET", "/agents/:installationId/notebook", "notebook.read"),
  route("POST", "/agents/:installationId/notebook/clear", "notebook.clear"),
]);
const reads: readonly string[] = [
  "knowledge.pages",
  "knowledge.page",
  "knowledge.version_read",
  "knowledge.proposals",
  "knowledge.search",
  "notebook.read",
];
/** The paths the api Worker sends to this handler (its dispatch row, ahead of the work API). */
export const knowledgePathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/work\/(?:knowledge\/(?:pages(?:\/[^/]+(?:\/(?:versions(?:\/[^/]+)?|delete))?)?|proposals(?:\/[^/]+\/(?:accept|reject))?|search)|agents\/[^/]+\/notebook(?:\/clear)?)$/;

type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers } });
type Refusal = KnowledgeRefusal | "knowledge_unavailable";
const refusals: Readonly<Record<Refusal, readonly [number, string, string, string]>> =
  Object.freeze({
    knowledge_unavailable: [
      503,
      "unavailable",
      "recheck_before_retry",
      "Shop knowledge is not available yet.",
    ],
    stale: [
      409,
      "conflict",
      "recheck_before_retry",
      "This changed since you opened it. Open it again.",
    ],
    hidden_entries: [
      403,
      "denied",
      "never",
      "Some of this notebook is not visible to you, so you can't clear it.",
    ],
  });
function refusalResponse(reason: Refusal, correlationId: string): Response {
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
function dependencies(value: KnowledgeApiDependencies): KnowledgeApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    (value.knowledge !== "on" && value.knowledge !== "off")
  )
    throw Error("KNOWLEDGE_API_CONFIGURATION_INVALID");
  const connector = value.connector;
  const now = value.now;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
    knowledge: value.knowledge,
  });
}

export function createKnowledgeApiHandler(d?: KnowledgeApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("KNOWLEDGE_CLOCK_INVALID");
    const deadlineMs = start + 5000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    try {
      let g: GuardedWorkspaceRequest<KnowledgeRoute>;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "work",
          knowledgeRoutes,
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
      // The committed switch: 503 before any body work or connection.
      if (configured.knowledge !== "on") {
        log.outcome = "knowledge_unavailable";
        return { log, response: refusalResponse("knowledge_unavailable", correlationId) };
      }
      const prepared = read
        ? undefined
        : await prepareKnowledgeCommand(g.route.op as KnowledgeCommandType, g);
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
              ? await runKnowledgeCommand(tx, g, prepared, correlationId)
              : await runKnowledgeRead(tx, g, g.route.op as KnowledgeRead);
          } catch (error) {
            if (!(error instanceof KnowledgeReject)) throw error;
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
      if (error instanceof KnowledgeReject) {
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
        console.log(JSON.stringify({ event: "morrow_knowledge", ...log, correlationId }));
      }
    },
  });
}
