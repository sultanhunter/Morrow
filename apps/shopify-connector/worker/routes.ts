// The connector's one route table (M2 PR-2; ADR-0022 items 2 and 6): exact paths only,
// matched on the undecoded WHATWG pathname, so an encoded or trailing-slash variant is
// another (unknown) path. Everything else is the fail-closed 404.
import { shopifyLimits } from "../../../packages/identity/src/broker-protocol.js";

export type ConnectorRoute = "launch" | "callback" | "webhooks" | "status";
export interface ConnectorRequestRoute {
  readonly route: ConnectorRoute;
  readonly appKey: string;
  /** The query string without "?" (empty for webhooks). */
  readonly rawQuery: string;
}
export type ConnectorRouteRefusal = Readonly<{ refused: 400 | 404 | 405 }>;

const path = /^\/shopify\/a\/([a-z0-9][a-z0-9-]{2,62})\/(launch|callback|webhooks|status)$/;
export const connectorMethods: Readonly<Record<ConnectorRoute, "GET" | "POST">> = Object.freeze({
  launch: "GET",
  callback: "GET",
  status: "GET",
  webhooks: "POST",
});
const encoder = new TextEncoder();

export function selectConnectorRoute(
  request: Request,
): ConnectorRequestRoute | ConnectorRouteRefusal {
  let url: URL;
  try {
    if (request.url.length > 4096) return Object.freeze({ refused: 400 });
    url = new URL(request.url);
  } catch {
    return Object.freeze({ refused: 400 });
  }
  const match = path.exec(url.pathname);
  if (!match || url.username || url.password || url.hash) return Object.freeze({ refused: 404 });
  const route = match[2] as ConnectorRoute;
  if (request.method !== connectorMethods[route]) return Object.freeze({ refused: 405 });
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (route === "webhooks") {
    if (rawQuery !== "") return Object.freeze({ refused: 400 });
  } else {
    // A signed GET: a bounded, non-empty query and no body.
    if (
      rawQuery === "" ||
      encoder.encode(rawQuery).length > shopifyLimits.queryMaxBytes ||
      request.body !== null ||
      request.headers.has("content-type")
    )
      return Object.freeze({ refused: 400 });
  }
  return Object.freeze({ route, appKey: match[1]!, rawQuery });
}
