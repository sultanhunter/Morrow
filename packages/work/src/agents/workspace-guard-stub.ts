import { validateDefinition } from "@morrow/contracts/validation";
import { parseStrictJson, sessionCookieDigest } from "@morrow/identity/request-primitives";
import { containsNul, workBodyLimits } from "../http-bodies.js";
import { WorkGuardError } from "../http-guard.js";

// BRANCH-LOCAL STUB, never merged as such (integration interface "Workspace request guard
// and api dispatch"): M5 PR-1 owns the generalised guard in packages/work/src/http-guard.ts
// (route specs {method: GET | POST | PUT, pattern relative to /workspace/:ws/}; PUT follows
// the POST CSRF rules). Until M5 PR-1 merges, the agents routes use this copy of the P06.T01a
// guard with exactly that interface; at rebase this file is deleted and the agents handler
// imports M5's guard. It performs no I/O: every failure is decided from the request alone,
// before any SQL connection opens. CSRF protection is exact Origin, Fetch Metadata, a custom
// header and a JSON content type, with no CORS.
export interface WorkspaceRouteSpec {
  readonly method: "GET" | "POST" | "PUT";
  /** Relative to /workspace/:ws, for example "/stores/:storeId/agents/listings". */
  readonly pattern: string;
  /** Allowed query parameters (GET only). */
  readonly query: readonly string[];
}
export interface GuardedWorkspaceRequest<R extends WorkspaceRouteSpec = WorkspaceRouteSpec> {
  readonly route: R;
  readonly workspaceId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: ReadonlyMap<string, string>;
  readonly sessionDigest: string;
  readonly commandId: string | null;
  readonly body: unknown;
}
const deny = (status: 400 | 401 | 403 | 404 | 405, allow?: string): never => {
  throw new WorkGuardError(status, allow);
};
const workspacePath = /^\/workspace\/([^/]*)(\/.*)$/;

function matchRoute<R extends WorkspaceRouteSpec>(routes: readonly R[], subpath: string) {
  const segments = subpath.split("/").slice(1);
  const candidates: R[] = [];
  let params: Record<string, string> = {};
  let badId = false;
  for (const route of routes) {
    const parts = route.pattern.split("/").slice(1);
    if (parts.length !== segments.length) continue;
    const found: Record<string, string> = {};
    let ok = true,
      invalid = false;
    for (const [i, part] of parts.entries()) {
      const segment = segments[i]!;
      if (part.startsWith(":")) {
        if (!validateDefinition("core", "Id", segment)) invalid = true;
        found[part.slice(1)] = segment;
      } else if (part !== segment) ok = false;
    }
    if (!ok) continue;
    candidates.push(route);
    params = found;
    badId ||= invalid;
  }
  return { candidates, params, badId };
}

async function readBody(request: Request, signal: AbortSignal): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^(0|[1-9][0-9]{0,5})$/.test(declared) || Number(declared) > workBodyLimits.bytes)
  )
    return deny(400);
  if (!request.body || request.bodyUsed) return deny(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    complete = false;
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(new WorkGuardError(400));
    signal.addEventListener("abort", cancel, { once: true });
  });
  void stopped.catch(() => {});
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), stopped]);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) return deny(400);
      bytes += item.value.byteLength;
      if (bytes > workBodyLimits.bytes) return deny(400);
      chunks.push(item.value);
    }
    complete = true;
    if (declared !== null && Number(declared) !== bytes) return deny(400);
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(output);
    } catch {
      return deny(400);
    }
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The generalised workspace guard (M5 PR-1's interface), for routes under /workspace/:ws. */
export async function guardWorkspaceRequest<R extends WorkspaceRouteSpec>(
  origin: string,
  routes: readonly R[],
  request: Request,
  signal: AbortSignal,
): Promise<GuardedWorkspaceRequest<R>> {
  if (request.url.length > 2048) return deny(400);
  const url = new URL(request.url);
  if (url.origin !== origin || url.username || url.password) return deny(403);
  const path = workspacePath.exec(url.pathname);
  if (!path) return deny(404);
  const workspaceId = path[1]!;
  if (!validateDefinition("core", "Id", workspaceId)) return deny(400);
  const { candidates, params, badId } = matchRoute(routes, path[2] ?? "");
  if (candidates.length === 0) return deny(404);
  const route = candidates.find((r) => r.method === request.method);
  if (!route) return deny(405, [...new Set(candidates.map((r) => r.method))].sort().join(", "));
  if (badId) return deny(400);
  const write = route.method !== "GET";
  const host = request.headers.get("Host");
  const suppliedOrigin = request.headers.get("Origin");
  if (host !== null && host !== url.host) return deny(403);
  if (suppliedOrigin !== null ? suppliedOrigin !== origin : write) return deny(403);
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (site !== null && site !== "same-origin") return deny(403);
  if (mode !== null && mode !== "cors" && mode !== "same-origin") return deny(403);
  if (dest !== null && dest !== "empty") return deny(403);
  if (request.headers.has("Authorization") || request.headers.has("Proxy-Authorization"))
    return deny(401);
  if (request.headers.has("Transfer-Encoding")) return deny(400);
  const sessionDigest = await sessionCookieDigest(request.headers.get("Cookie"));
  if (sessionDigest === null) return deny(401);
  const query = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!route.query.includes(key) || query.has(key) || value.length > 512) return deny(400);
    query.set(key, value);
  }
  if (!write) {
    const length = request.headers.get("Content-Length");
    if (
      request.body !== null ||
      (length !== null && length !== "0") ||
      request.headers.has("Content-Type") ||
      request.headers.has("Idempotency-Key")
    )
      return deny(400);
    return Object.freeze({
      route,
      workspaceId,
      params: Object.freeze(params),
      query,
      sessionDigest,
      commandId: null,
      body: null,
    });
  }
  if (request.headers.get("Content-Type") !== "application/json") return deny(403);
  if (request.headers.get("X-Morrow-Request") !== "1") return deny(403);
  const commandId = request.headers.get("Idempotency-Key");
  if (!commandId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(commandId))
    return deny(400);
  let body: unknown;
  try {
    body = parseStrictJson(await readBody(request, signal), workBodyLimits.bytes);
  } catch (error) {
    if (error instanceof WorkGuardError) throw error;
    return deny(400);
  }
  if (containsNul(body)) return deny(400);
  return Object.freeze({
    route,
    workspaceId,
    params: Object.freeze(params),
    query,
    sessionDigest,
    commandId,
    body,
  });
}
