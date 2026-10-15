import { validateDefinition } from "@morrow/contracts/validation";
import { parseWorkosSessionStatusJson } from "./workos-session-status-json.js";

// Private server composition only. This module is deliberately not a package
// entrypoint. Derived digests belong only to the immediately executing handler.
export interface StandaloneWorkspaceSqlControl {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export type StandaloneRequestRoute = "bootstrap" | "preview" | "apply" | "status";
export interface GuardedStandaloneRequest {
  readonly workspaceId: string;
  readonly sessionDigest: string;
  readonly commandId: string | null;
  readonly nonceDigest: string | null;
  readonly csrfToken: string | null;
  readonly control: Readonly<StandaloneWorkspaceSqlControl>;
  check(): number;
  wait<T>(pending: Promise<T>): Promise<T>;
}
export class StandaloneRequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 405 | 503) {
    super("STANDALONE_REQUEST_DENIED");
    this.name = "StandaloneRequestError";
  }
}
export function standaloneJson(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
const canonicalSecret = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const failure = (status: 400 | 401 | 403 | 404 | 405 | 503): never => {
  throw new StandaloneRequestError(status);
};
const validTime = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8640000000000000;
const encoder = new TextEncoder();
function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(secret.replaceAll("-", "+").replaceAll("_", "/") + "=");
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}
function configuration(value: unknown): string {
  try {
    const parsed = parseWorkosSessionStatusJson(value, 2048);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "mode,origin,schemaVersion"
    )
      throw Error();
    const row = parsed as Record<string, unknown>;
    if (row.schemaVersion !== 1 || typeof row.origin !== "string" || row.origin.length > 512)
      throw Error();
    const url = new URL(row.origin);
    if (url.origin !== row.origin || url.username || url.password) throw Error();
    if (row.mode === "https") {
      if (url.protocol !== "https:") throw Error();
    } else if (row.mode === "loopback_qualification") {
      const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(row.origin)?.[1];
      if (!port || Number(port) > 65535) throw Error();
    } else throw Error();
    return row.origin;
  } catch {
    throw Error("STANDALONE_REQUEST_CONFIG_INVALID");
  }
}
function cookieSecret(header: string | null): string {
  if (!header || header.length > 4096 || /[^\x20-\x7e]/.test(header)) return failure(401);
  const pairs = header.split(";");
  if (pairs.length > 32) return failure(401);
  let secret: string | undefined;
  for (const pair of pairs) {
    const match =
      /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/.exec(
        pair.trim(),
      );
    if (!match) return failure(401);
    if (match[1] === "__Host-morrow_session") {
      if (secret !== undefined || !canonicalSecret(match[2])) return failure(401);
      secret = match[2];
    }
  }
  return secret ?? failure(401);
}
function routePath(route: StandaloneRequestRoute): string {
  if (route === "bootstrap") return "/bootstrap";
  if (route === "preview") return "/store-links/preview";
  if (route === "apply") return "/store-links";
  if (route === "status") return "/store-links/status";
  return failure(404);
}
async function bodyText(
  request: Request,
  wait: <T>(pending: Promise<T>) => Promise<T>,
): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^(0|[1-9][0-9]{0,2})$/.test(declared) || Number(declared) > 256))
    return failure(400);
  if (!request.body || request.bodyUsed) return failure(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    complete = false;
  try {
    for (;;) {
      const item = await wait(reader.read());
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || (bytes += item.value.byteLength) > 256)
        return failure(400);
      chunks.push(item.value);
    }
    complete = true;
    if (declared !== null && Number(declared) !== bytes) return failure(400);
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(output);
    } catch {
      return failure(400);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createStandaloneRequestGuard(configurationJson: unknown, now: () => number) {
  const origin = configuration(configurationJson);
  if (typeof now !== "function") throw Error("STANDALONE_REQUEST_CONFIG_INVALID");
  let lastTime = -1,
    clockBroken = false;
  const clock = () => {
    try {
      const at = now();
      if (clockBroken || !validTime(at) || at < lastTime) throw Error();
      lastTime = at;
      return at;
    } catch {
      clockBroken = true;
      return failure(503);
    }
  };
  return Object.freeze({
    async handle(
      request: Request,
      route: StandaloneRequestRoute,
      execute: (context: Readonly<GuardedStandaloneRequest>) => Promise<Response>,
    ): Promise<Response> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let requestSignal: AbortSignal | undefined;
      let executionStarted = false;
      const abort = new AbortController();
      let interrupt!: () => void;
      const interrupted = new Promise<{ stopped: true }>((resolve) => {
        interrupt = () => resolve({ stopped: true });
      });
      const stop = () => {
        abort.abort();
        interrupt();
      };
      try {
        const started = clock(),
          deadlineMs = started + 5000;
        if (!validTime(deadlineMs) || !(request instanceof Request)) return failure(400);
        requestSignal = request.signal;
        const control = Object.freeze({ deadlineMs, signal: abort.signal });
        const check = () => {
          const at = clock();
          if (abort.signal.aborted || requestSignal?.aborted || at >= deadlineMs) {
            stop();
            return failure(503);
          }
          return at;
        };
        const wait = async <T>(pending: Promise<T>): Promise<T> => {
          check();
          const watched = Promise.resolve(pending).then((value) => ({ value }));
          const answer = await Promise.race([watched, interrupted]);
          check();
          if ("stopped" in answer) return failure(503);
          return answer.value;
        };
        requestSignal.addEventListener("abort", stop, { once: true });
        timer = setTimeout(stop, 5000);
        check();
        if (request.url.length > 2048) return failure(400);
        const url = new URL(request.url),
          match = /^\/workspace\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(\/.*)$/.exec(url.pathname),
          method = route === "bootstrap" ? "GET" : "POST";
        if (
          url.origin !== origin ||
          url.href !== `${origin}${url.pathname}` ||
          url.username ||
          url.password
        )
          return failure(403);
        if (!match || match[2] !== routePath(route) || !validateDefinition("core", "Id", match[1]))
          return failure(404);
        if (request.method !== method) return failure(405);
        const host = request.headers.get("Host"),
          suppliedOrigin = request.headers.get("Origin"),
          fetchSite = request.headers.get("Sec-Fetch-Site");
        if (host !== null && host !== url.host) return failure(403);
        if (suppliedOrigin !== null && suppliedOrigin !== origin) return failure(403);
        if (
          fetchSite !== null &&
          fetchSite !== "same-origin" &&
          !(route === "bootstrap" && fetchSite === "none")
        )
          return failure(403);
        if (request.headers.has("Authorization") || request.headers.has("Proxy-Authorization"))
          return failure(401);
        if (request.headers.has("Transfer-Encoding")) return failure(400);
        let secret = cookieSecret(request.headers.get("Cookie"));
        let commandId: string | null = null,
          nonceDigest: string | null = null,
          csrfToken: string | null = null;
        const sessionDigest = hex(
          await wait(crypto.subtle.digest("SHA-256", encoder.encode(secret))),
        );
        if (route === "bootstrap") {
          const length = request.headers.get("Content-Length");
          if (
            request.body !== null ||
            (length !== null && length !== "0") ||
            request.headers.has("Content-Type") ||
            request.headers.has("Idempotency-Key") ||
            request.headers.has("X-Morrow-CSRF")
          )
            return failure(400);
        } else {
          if (
            suppliedOrigin !== origin ||
            request.headers.get("Content-Type") !== "application/json"
          )
            return failure(403);
          if (request.headers.get("X-Morrow-Request") !== "1") return failure(403);
          commandId = request.headers.get("Idempotency-Key");
          if (!commandId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(commandId))
            return failure(400);
          let handoffToken: string;
          try {
            const parsed = parseWorkosSessionStatusJson(await bodyText(request, wait), 256);
            if (
              !parsed ||
              typeof parsed !== "object" ||
              Array.isArray(parsed) ||
              Object.keys(parsed).join(",") !== "handoffToken" ||
              !canonicalSecret((parsed as Record<string, unknown>).handoffToken)
            )
              throw Error();
            handoffToken = (parsed as { handoffToken: string }).handoffToken;
          } catch (error) {
            if (error instanceof StandaloneRequestError) throw error;
            return failure(400);
          }
          nonceDigest = hex(
            await wait(crypto.subtle.digest("SHA-256", encoder.encode(handoffToken))),
          );
          const key = await wait(
            crypto.subtle.importKey(
              "raw",
              secretBytes(secret),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            ),
          );
          // JSON array encoding is unambiguous and versioned; no delimiters can
          // alias another workspace, command or nonce transcript.
          const transcript = JSON.stringify([
            "morrow.store-links.csrf",
            1,
            match[1],
            commandId,
            handoffToken,
          ]);
          csrfToken = base64url(
            new Uint8Array(await wait(crypto.subtle.sign("HMAC", key, encoder.encode(transcript)))),
          );
          if (route === "apply") {
            const received = request.headers.get("X-Morrow-CSRF");
            if (!canonicalSecret(received)) return failure(403);
            let different = 0;
            for (let i = 0; i < 43; i++)
              different |= received.charCodeAt(i) ^ csrfToken.charCodeAt(i);
            if (different !== 0) return failure(403);
          } else if (request.headers.has("X-Morrow-CSRF")) return failure(400);
          handoffToken = "";
        }
        secret = "";
        check();
        const context = Object.freeze({
          workspaceId: match[1]!,
          sessionDigest,
          commandId,
          nonceDigest,
          csrfToken,
          control,
          check,
          wait,
        });
        executionStarted = true;
        const response = await wait(Promise.resolve(execute(context)));
        check();
        if (!(response instanceof Response)) return failure(503);
        return response;
      } catch (error) {
        // Once the mutation callback has begun, an interrupted response cannot
        // prove whether its durable operation committed. Never turn that loss
        // into a retryable denial or disclose a late successful reply.
        if (route === "apply" && executionStarted)
          return standaloneJson(503, { schemaVersion: 1, outcome: "outcome_unknown" });
        const status = error instanceof StandaloneRequestError ? error.status : 503;
        const code =
          status === 401
            ? "authentication_required"
            : status === 503
              ? "unavailable"
              : "request_denied";
        const response = standaloneJson(status, { code });
        if (status === 405) response.headers.set("Allow", route === "bootstrap" ? "GET" : "POST");
        return response;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        requestSignal?.removeEventListener("abort", stop);
        stop();
      }
    },
  });
}
