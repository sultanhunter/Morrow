import type { ShopifyCredentialOutcome } from "../../../identity/src/broker-protocol.js";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
} from "../connection.js";
import {
  WorkGuardError,
  guardWorkspaceRequest,
  workOrigin,
  type GuardedWorkspaceRequest,
  type WorkspaceRouteSpec,
} from "../http-guard.js";
import { workErrorResponse, type WorkApiDependencies } from "../http.js";
import {
  prepareConnectionCommand,
  runConnectionCommand,
  runConnectionRead,
  type ConnectionResult,
} from "./commands.js";
import type { ConnectionCommandType, ConnectionRead } from "./types.js";

// The connection routes of the workspace API ("Disconnect store"; the M2 brief's api
// routes): an internal JSON contract between the api Worker and Morrow's own SPA
// (docs/contracts/work-api.md), on the work login and the workspace guard of M5 PR-1, under
// the fixed prefix /workspace/:ws/connections. Every other /connections path stays the
// managed workspace handler's (the WorkspaceConnections@1 read).
//   GET  /connections/:connectionId/disconnect  whether this person may disconnect, now
//   POST /connections/:connectionId/disconnect  {control: {reason, sourceProposalRef: null}}
// The POST's transaction commits the KillSwitchRecord, the connection stop and the
// installation's end (connections/commands.ts). Then, after COMMIT, one
// ApiBroker.shopifyCredentialDestroy erases the disconnected installation's offline token
// (the broker fixes the reason; the vault records the destruction on the installation). A
// failed or unknown destruction does not undo the disconnect: the stop already holds every
// read and write, the reply says the token is pending, and the connector's cron re-drives
// the destruction (connector_credentials_pending). A replay (the same Idempotency-Key)
// returns the recorded result and asks the broker again, which is idempotent.
// One connection per request, a 5 s deadline for the transaction, never Set-Cookie, never
// CORS; database and broker error text is never logged or returned. With no dependencies
// every route is 401 with no network or database access.
export interface CredentialDestroyer {
  /** ApiBroker.shopifyCredentialDestroy for one disconnected installation, raced by the caller. */
  destroy(installationId: string, signal: AbortSignal): Promise<ShopifyCredentialOutcome>;
}
export interface ConnectionsApiDependencies extends WorkApiDependencies {
  /** Null when the broker binding cannot destroy tokens: the token is then always pending. */
  readonly credentials: CredentialDestroyer | null;
}
export interface ConnectionRoute extends WorkspaceRouteSpec {
  readonly method: "GET" | "POST";
  /** Relative to /workspace/:ws (the prefix and the pattern). */
  readonly path: string;
  readonly op: ConnectionCommandType | ConnectionRead;
}
const route = (method: ConnectionRoute["method"], op: ConnectionRoute["op"]): ConnectionRoute =>
  Object.freeze({
    method,
    pattern: "/:connectionId/disconnect",
    path: "/connections/:connectionId/disconnect",
    query: [],
    op,
  });
/** Every connection route (the api Worker dispatches these here). */
export const connectionRoutes: readonly ConnectionRoute[] = Object.freeze([
  route("GET", "connection.disconnect_status"),
  route("POST", "connection.disconnect"),
]);
/** The paths the api Worker sends to this handler (one dispatch row, M5's table). */
export const connectionsPathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/connections\/[^/]+\/disconnect$/;
// The transaction's deadline, and the broker's whole budget after it.
export const connectionsDeadlineMs = 5000;
export const connectionsCredentialBudgetMs = 4000;

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
function dependencies(value: ConnectionsApiDependencies): ConnectionsApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    (value.credentials !== null &&
      (!value.credentials || typeof value.credentials.destroy !== "function"))
  )
    throw Error("CONNECTIONS_API_CONFIGURATION_INVALID");
  const { connector, now, credentials } = value;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
    credentials:
      credentials === null ? null : Object.freeze({ destroy: credentials.destroy.bind(credentials) }),
  });
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * After COMMIT: the disconnected installation's token, once. "destroyed" only when the
 * broker confirmed it (destroyed now or before); anything else, a throw or a late reply is
 * "pending" (the connector's cron finishes it). An installation that ended another way
 * (an uninstall or a scope change before this disconnect) is that end's to destroy.
 */
async function destroyToken(
  credentials: CredentialDestroyer | null,
  result: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<"destroyed" | "pending"> {
  const installationId = result.installationId;
  if (
    credentials === null ||
    result.endReason !== "disconnected" ||
    typeof installationId !== "string" ||
    !idPattern.test(installationId)
  )
    return "pending";
  try {
    const outcome = await credentials.destroy(installationId, signal);
    return outcome === "destroyed" || outcome === "already_destroyed" ? "destroyed" : "pending";
  } catch {
    return "pending";
  }
}

/** With no dependencies every route is 401 with no network or database access. */
export function createConnectionsApiHandler(d?: ConnectionsApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log = { route: "unmatched", outcome: "unbound" };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("CONNECTIONS_CLOCK_INVALID");
    const deadlineMs = start + connectionsDeadlineMs;
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(),
      connectionsDeadlineMs + connectionsCredentialBudgetMs,
    );
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    try {
      let g: GuardedWorkspaceRequest<ConnectionRoute>;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "connections",
          connectionRoutes,
          request,
          abort.signal,
        );
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.path;
      read = g.route.op === "connection.disconnect_status";
      // Step 1 completes before any connection opens.
      const prepared = read
        ? undefined
        : await prepareConnectionCommand(g.route.op as ConnectionCommandType, g);
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
      let result: ConnectionResult;
      try {
        const options = { readOnly: read, deadlineMs, signal: abort.signal, now: configured.now };
        result = await withWorkTransaction(connection, options, (tx) =>
          prepared
            ? runConnectionCommand(tx, g, prepared, correlationId)
            : runConnectionRead(tx, g, g.route.op as ConnectionRead),
        );
      } finally {
        await connection.close().catch(() => {});
      }
      log.outcome = result.outcome;
      if (read) return { log, response: json(200, { schemaVersion: 1, ...result.body }) };
      // Step 3, after COMMIT: the token. The disconnect stands whatever happens here.
      const credential = await destroyToken(configured.credentials, result.body, abort.signal);
      log.outcome += "_credential_" + credential;
      return {
        log,
        response: json(200, { schemaVersion: 1, ...result.body, credential }),
      };
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
        console.log(JSON.stringify({ event: "morrow_connections", ...log, correlationId }));
      }
    },
  });
}
