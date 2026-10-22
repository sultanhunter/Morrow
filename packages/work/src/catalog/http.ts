import {
  decodeShopifyReadResult,
  parseShopifyReadVariables,
  shopifyReadLimits,
} from "../../../identity/src/broker-protocol.js";
import { listingFieldPaths, storeResource } from "@morrow/policy/store-resource";
import { decideOn } from "../agents/commands.js";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
  type WorkTx,
} from "../connection.js";
import { enterWorkContext, WorkContextUnavailable } from "../context.js";
import {
  WorkGuardError,
  guardWorkspaceRequest,
  workOrigin,
  type GuardedWorkspaceRequest,
  type WorkspaceRouteSpec,
} from "../http-guard.js";
import { workErrorResponse, type WorkApiDependencies } from "../http.js";

// The catalogue routes of the workspace API (M2 PR-3; the M2 brief's api routes; spine §4):
// the collections and products of a linked store, for the Ask screen's picker. An internal
// JSON contract between the api Worker and Morrow's own SPA (docs/contracts/work-api.md).
//   1. The workspace guard (a GET with its own query parameters only), then the query's
//      closed variables (parseShopifyReadVariables): anything else is 400 before any SQL.
//   2. One READ WRITE transaction: the session's authority (enter_context), the store's
//      current association (store_association), the human kernel allowing `view` on
//      catalog.products.read on the store resource with the listing fields, then
//      catalog_read_lease, which rechecks the connection and opens a 60-second read lease
//      for the session's tenant and actor (refused under a connection stop). The lease
//      selects the tenant of the one broker read; it grants nothing.
//   3. After COMMIT, one ApiBroker.shopifyRead under that lease (the broker resolves the
//      lease, its stops, the store connection and the credential itself), decoded by the
//      protocol's closed decoder, and answered with ids, titles and page cursors only.
// A denial persists nothing. A lost reply after the lease definer was sent is unavailable
// (the read lease simply expires). Shopify's reply, the token and any provider text never
// reach the response or a log.
export interface CatalogLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly subjectId: string;
}
/** The one broker read of a catalogue route (ApiBroker.shopifyRead), raced by the caller. */
export interface CatalogReader {
  read(
    lease: CatalogLease,
    queryName: "collectionsPage" | "productsPage",
    variablesJson: string,
    signal: AbortSignal,
    budgetMs: number,
  ): Promise<string>;
}
export interface CatalogApiDependencies extends WorkApiDependencies {
  /** Null when the broker binding does not serve reads: every route is then 503. */
  readonly reader: CatalogReader | null;
}
interface CatalogRoute extends WorkspaceRouteSpec {
  readonly method: "GET";
  readonly path: string;
  readonly queryName: "collectionsPage" | "productsPage";
}
const route = (
  pattern: string,
  query: readonly string[],
  queryName: CatalogRoute["queryName"],
): CatalogRoute =>
  Object.freeze({ method: "GET", pattern, path: "/stores" + pattern, query, queryName });
/** Every catalogue route, relative to /workspace/:ws/stores (the guard's route family). */
export const catalogRoutes: readonly CatalogRoute[] = Object.freeze([
  route("/:storeId/catalog/collections", ["after"], "collectionsPage"),
  route("/:storeId/catalog/products", ["after", "collectionId", "query"], "productsPage"),
]);
/** The paths the api Worker sends to this handler (one dispatch row). */
export const catalogPathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/stores\/[^/]+\/catalog(?:\/|$)/;
// The whole request, the transaction and the broker read share this deadline; the read
// keeps what the transaction leaves, at most the protocol's budget.
export const catalogDeadlineMs = 9000;

type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
function guardKind(error: WorkGuardError) {
  if (error.status === 401) return "unauthenticated" as const;
  if (error.status === 400) return "invalid" as const;
  if (error.status === 404) return "not_found" as const;
  if (error.status === 405) return "method_not_allowed" as const;
  return "guard_denied" as const;
}
function dependencies(value: CatalogApiDependencies): CatalogApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    (value.reader !== null && (!value.reader || typeof value.reader.read !== "function"))
  )
    throw Error("CATALOG_API_CONFIGURATION_INVALID");
  const { connector, now, reader } = value;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
    reader: reader === null ? null : Object.freeze({ read: reader.read.bind(reader) }),
  });
}
/** The closed variables of one request's query string, or null (400). */
export function catalogVariables(
  route: CatalogRoute,
  query: ReadonlyMap<string, string>,
): string | null {
  const value = (name: string) => query.get(name) ?? null;
  const variables =
    route.queryName === "collectionsPage"
      ? { after: value("after") }
      : { after: value("after"), collectionId: value("collectionId"), search: value("query") };
  const json = JSON.stringify(variables);
  return parseShopifyReadVariables(route.queryName, json) ? json : null;
}
const text = (row: Record<string, unknown>, key: string) => {
  const v = row[key];
  if (typeof v !== "string") throw new WorkContextUnavailable();
  return v;
};
/** Step 2: the kernel and the read lease, in one transaction. */
async function openReadLease(
  tx: WorkTx,
  g: GuardedWorkspaceRequest<CatalogRoute>,
): Promise<CatalogLease> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  const storeId = g.params.storeId!;
  const rows = await tx.run("storeAssociation", [storeId]);
  if (rows.length === 0) throw new WorkReject("not_found");
  if (rows.length !== 1 || text(rows[0]!, "store_id") !== storeId)
    throw new WorkContextUnavailable();
  const connectionId = text(rows[0]!, "connection_id");
  const store = storeResource(
    a.actor.organizationId,
    a.resource.workspaceId,
    storeId,
    connectionId,
  );
  const decided = await decideOn(a, store, "catalog.products.read", "view", listingFieldPaths);
  if (!decided.decision.allowed) throw new WorkReject("denied");
  tx.markSubmitted();
  const opened = await tx.run("catalogReadLease", [storeId, connectionId]);
  const row = opened.length === 1 ? opened[0]! : undefined;
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome !== "opened") {
    tx.rollbackOnly();
    throw new WorkReject(
      row.outcome === "not_found"
        ? "not_found"
        : row.outcome === "stopped"
          ? "state_conflict"
          : row.outcome === "ineligible"
            ? "unauthenticated"
            : "unavailable",
    );
  }
  const generation = Number(text(row, "generation"));
  if (!Number.isSafeInteger(generation) || generation < 1) throw new WorkContextUnavailable();
  return Object.freeze({
    leaseId: text(row, "lease_id"),
    generation,
    subjectId: text(row, "subject_id"),
  });
}

/** With no dependencies every route is 401 with no network or database access. */
export function createCatalogApiHandler(d?: CatalogApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("CATALOG_CLOCK_INVALID");
    const deadlineMs = start + catalogDeadlineMs;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), catalogDeadlineMs);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    try {
      let g: GuardedWorkspaceRequest<CatalogRoute>;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "stores",
          catalogRoutes,
          request,
          abort.signal,
        );
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.path;
      const variables = catalogVariables(g.route, g.query);
      if (variables === null) {
        log.outcome = "invalid";
        return { log, response: workErrorResponse("invalid", correlationId) };
      }
      if (!configured.reader) {
        log.outcome = "unavailable";
        return { log, response: workErrorResponse("unavailable_read", correlationId) };
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
        return { log, response: workErrorResponse("unavailable_read", correlationId) };
      }
      let lease: CatalogLease;
      try {
        lease = await withWorkTransaction(
          connection,
          { readOnly: false, deadlineMs, signal: abort.signal, now: configured.now },
          (tx) => openReadLease(tx, g),
        );
      } finally {
        await connection.close().catch(() => {});
      }
      // Step 3: the one broker read, after COMMIT.
      const budget = Math.min(shopifyReadLimits.budgetMaxMs, deadlineMs - configured.now() - 250);
      if (!(budget >= 1)) throw new WorkReject("unavailable");
      let result;
      try {
        result = decodeShopifyReadResult(
          g.route.queryName,
          await configured.reader.read(lease, g.route.queryName, variables, abort.signal, budget),
        );
      } catch {
        log.outcome = "read_unavailable";
        return { log, response: workErrorResponse("unavailable_read", correlationId) };
      }
      if (result.outcome === "not_found") {
        log.outcome = "not_found";
        return { log, response: workErrorResponse("not_found", correlationId) };
      }
      log.outcome = "read";
      return {
        log,
        response: new Response(
          JSON.stringify({ ...result, outcome: undefined, storeId: g.params.storeId }),
          { status: 200, headers: { ...headers } },
        ),
      };
    } catch (error) {
      if (error instanceof WorkReject) {
        log.outcome = error.reason;
        const kind = error.reason === "unavailable" ? "unavailable_read" : error.reason;
        return { log, response: workErrorResponse(kind, correlationId) };
      }
      if (error instanceof WorkOutcomeUnknown) {
        log.outcome = "lease_unknown";
        return { log, response: workErrorResponse("unavailable_read", correlationId) };
      }
      log.outcome = "unavailable";
      return { log, response: workErrorResponse("unavailable_read", correlationId) };
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
        return workErrorResponse("unavailable_read", correlationId);
      } finally {
        console.log(JSON.stringify({ event: "morrow_catalog", ...log, correlationId }));
      }
    },
  });
}
