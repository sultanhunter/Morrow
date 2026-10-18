import type { WorkPermissionKey } from "@morrow/contracts/work-permissions";
import { validateDefinition } from "@morrow/contracts/validation";
import { parseStrictJson, sessionCookieDigest } from "@morrow/identity/request-primitives";
import { containsNul, workBodyLimits } from "./http-bodies.js";

// The work request guard (P06.T01a §4.9, §4.14). It performs no I/O: every
// failure is decided from the request alone, before any SQL connection opens.
// CSRF protection is exact Origin, Fetch Metadata, a custom header and a JSON
// content type, with no CORS (as in P05.T01x §13.2).
export interface WorkRoute {
  readonly method: "GET" | "POST";
  /** Relative to /workspace/:ws/work. */
  readonly pattern: string;
  readonly idParams: readonly string[];
  readonly permission: WorkPermissionKey;
  /** Allowed query parameters (GET lists only). */
  readonly query: readonly string[];
}
export interface GuardedWorkRequest {
  readonly route: WorkRoute;
  readonly workspaceId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: ReadonlyMap<string, string>;
  readonly sessionDigest: string;
  readonly commandId: string | null;
  readonly body: unknown;
}
export class WorkGuardError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405,
    readonly allow?: string,
  ) {
    super("WORK_GUARD_DENIED");
    this.name = "WorkGuardError";
  }
}
const deny = (status: 400 | 401 | 403 | 404 | 405, allow?: string): never => {
  throw new WorkGuardError(status, allow);
};
export const workPathPattern = /^\/workspace\/([^/]*)\/work(\/.*)?$/;

export function workOrigin(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 512) throw Error();
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== "https:" || url.username || url.password)
      throw Error();
    return value;
  } catch {
    throw Error("WORK_ORIGIN_INVALID");
  }
}

function matchRoute(
  routes: readonly WorkRoute[],
  subpath: string,
): { candidates: WorkRoute[]; params: Record<string, string>; badId: boolean } {
  const segments = subpath.split("/").slice(1);
  const candidates: WorkRoute[] = [];
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

export async function guardWorkRequest(
  origin: string,
  routes: readonly WorkRoute[],
  request: Request,
  signal: AbortSignal,
): Promise<GuardedWorkRequest> {
  if (request.url.length > 2048) return deny(400);
  const url = new URL(request.url);
  if (url.origin !== origin || url.username || url.password) return deny(403);
  const path = workPathPattern.exec(url.pathname);
  if (!path) return deny(404);
  const workspaceId = path[1]!;
  if (!validateDefinition("core", "Id", workspaceId)) return deny(400);
  const { candidates, params, badId } = matchRoute(routes, path[2] ?? "");
  if (candidates.length === 0) return deny(404);
  const route = candidates.find((r) => r.method === request.method);
  if (!route) return deny(405, [...new Set(candidates.map((r) => r.method))].sort().join(", "));
  if (badId) return deny(400);
  // Exact origin and fetch metadata.
  const host = request.headers.get("Host");
  const suppliedOrigin = request.headers.get("Origin");
  if (host !== null && host !== url.host) return deny(403);
  if (suppliedOrigin !== null ? suppliedOrigin !== origin : route.method === "POST")
    return deny(403);
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (site !== null && site !== "same-origin") return deny(403);
  if (mode !== null && mode !== "cors" && mode !== "same-origin") return deny(403);
  if (dest !== null && dest !== "empty") return deny(403);
  if (request.headers.has("Authorization") || request.headers.has("Proxy-Authorization"))
    return deny(401);
  if (request.headers.has("Transfer-Encoding")) return deny(400);
  // Exactly one canonical __Host-morrow_session cookie.
  const sessionDigest = await sessionCookieDigest(request.headers.get("Cookie"));
  if (sessionDigest === null) return deny(401);
  // Query: only a GET list's own parameters, each at most once.
  const query = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!route.query.includes(key) || query.has(key) || value.length > 512) return deny(400);
    query.set(key, value);
  }
  if (route.method === "GET") {
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
