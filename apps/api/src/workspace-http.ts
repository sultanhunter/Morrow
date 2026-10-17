import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { contractVersion, type ScaffoldHealth } from "@morrow/contracts";

export interface WorkspaceFetchHandler {
  fetch(request: Request): Promise<Response>;
}
export interface WorkspaceHttpBinding {
  readonly origin: string;
  readonly bootstrap: WorkspaceFetchHandler;
  readonly linking?: WorkspaceFetchHandler;
}
const sensitiveHeaders = new Set([
  "host",
  "cookie",
  "origin",
  "authorization",
  "content-type",
  "content-length",
  "transfer-encoding",
  "idempotency-key",
  "x-morrow-request",
  "x-morrow-csrf",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
]);
function fixed(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

// Source-owned injection only. A caller's Host, forwarded headers or cookie
// cannot construct a binding. The ordinary scaffold supplies no binding.
export function createWorkspaceHttpListener(binding?: WorkspaceHttpBinding) {
  const configured = binding && Object.freeze({ ...binding });
  let origin: URL | undefined;
  if (configured) {
    origin = new URL(configured.origin);
    if (
      origin.origin !== configured.origin ||
      origin.username ||
      origin.password ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port !== "")
      )
    ) {
      throw Error("WORKSPACE_HTTP_CONFIGURATION_INVALID");
    }
  }
  return (request: IncomingMessage, response: ServerResponse): void => {
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    const responseClosed = () => {
      if (!response.writableEnded) disconnect();
    };
    request.once("aborted", disconnect);
    response.once("close", responseClosed);
    void (async () => {
      try {
        const raw = request.url ?? "";
        if (request.method === "GET" && raw === "/health") {
          const health: ScaffoldHealth = {
            service: "api",
            contracts: contractVersion,
            mode: "scaffold",
          };
          fixed(response, 200, health);
          return;
        }
        if (!configured || !origin) {
          fixed(response, raw.startsWith("/workspace") ? 401 : 404, {
            code: raw.startsWith("/workspace") ? "authentication_required" : "not_found",
          });
          request.resume();
          return;
        }
        const seen = new Set<string>();
        let bytes = 0;
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          const name = request.rawHeaders[i]!.toLowerCase(),
            value = request.rawHeaders[i + 1]!;
          bytes += name.length + value.length + 4;
          if (sensitiveHeaders.has(name) && seen.has(name)) {
            fixed(response, 400, { code: "invalid_request" });
            request.resume();
            return;
          }
          seen.add(name);
        }
        if (
          bytes > 8192 ||
          request.rawHeaders.length > 128 ||
          request.headers.host !== origin.host ||
          !raw.startsWith("/") ||
          raw.startsWith("//") ||
          /[\\\x00-\x20\x7f]/.test(raw)
        ) {
          fixed(response, 400, { code: "invalid_request" });
          request.resume();
          return;
        }
        const url = new URL(raw, origin);
        if (url.origin !== origin.origin || url.pathname + url.search + url.hash !== raw) {
          fixed(response, 400, { code: "invalid_request" });
          request.resume();
          return;
        }
        const handler = /\/bootstrap$/.test(url.pathname)
          ? configured.bootstrap
          : /\/store-links(?:\/(?:preview|status))?$/.test(url.pathname)
            ? configured.linking
            : undefined;
        if (!handler) {
          fixed(response, 404, { code: "not_found" });
          request.resume();
          return;
        }
        const headers = new Headers();
        for (let i = 0; i < request.rawHeaders.length; i += 2)
          headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
        const method = request.method ?? "GET";
        if (
          (method === "GET" || method === "HEAD") &&
          ((request.headers["content-length"] !== undefined &&
            request.headers["content-length"] !== "0") ||
            request.headers["transfer-encoding"] !== undefined)
        ) {
          fixed(response, 400, { code: "invalid_request" });
          request.resume();
          return;
        }
        const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal };
        if (method !== "GET" && method !== "HEAD") {
          init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
        const result = await handler.fetch(new Request(url, init));
        if (abort.signal.aborted || response.destroyed) return;
        const body = await result.arrayBuffer();
        if (abort.signal.aborted || response.destroyed) return;
        if (body.byteLength > 8192 || result.headers.has("set-cookie")) {
          fixed(response, 503, { code: "workspace_unavailable" });
          return;
        }
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(body));
      } catch {
        if (!abort.signal.aborted && !response.destroyed && !response.headersSent)
          fixed(response, 503, { code: "workspace_unavailable" });
        else if (!response.writableEnded) response.destroy();
      } finally {
        request.off("aborted", disconnect);
        response.off("close", responseClosed);
      }
    })();
  };
}
