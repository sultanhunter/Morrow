import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";

export interface AuthDeliveryPlan {
  readonly status: 200 | 303 | 400 | 401 | 403 | 404 | 405 | 503;
  readonly headers: readonly (readonly [string, string])[];
  readonly cookies: readonly string[];
  readonly bodyText: string;
}
export interface AuthDispatchHandler {
  dispatch(request: Request, sink: (plan: AuthDeliveryPlan) => void): Promise<void>;
}
export interface AuthHttpBinding {
  readonly origin: string;
  readonly auth: AuthDispatchHandler;
  readonly logout?: AuthDispatchHandler;
  // POST /auth/rotate (P05.T01y): optional, like logout; absent → 404.
  readonly rotate?: AuthDispatchHandler;
}
const sensitive = new Set([
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
const fixedBody = '{"schemaVersion":1,"outcome":"login_unavailable"}';
// P05.T01y session cookie constants, checked byte for byte at delivery.
const sessionClear = "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
const rotationBodies = Object.freeze({
  unavailable: '{"schemaVersion":1,"outcome":"rotation_unavailable"}',
  unknown: '{"schemaVersion":1,"outcome":"rotation_outcome_unknown"}',
  authentication: '{"code":"authentication_required"}',
});
const rotationResult =
  /^\{"schemaVersion":1,"outcome":"(rotated|current)","idleRemainingMs":(0|[1-9][0-9]{0,7}),"absoluteRemainingMs":(0|[1-9][0-9]{0,7})\}$/;
type Fallback = "login" | "logoutUnknown" | "rotation" | "rotationUnknown";
function unavailable(response: ServerResponse, status: number, fallback: Fallback = "login") {
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  // Fallbacks never carry a cookie.
  response.end(
    fallback === "logoutUnknown"
      ? '{"schemaVersion":1,"outcome":"logout_outcome_unknown"}'
      : fallback === "rotation"
        ? rotationBodies.unavailable
        : fallback === "rotationUnknown"
          ? rotationBodies.unknown
          : fixedBody,
  );
}
function ownedBody(request: IncomingMessage, response: ServerResponse, maximum = 513) {
  // Cancelling Readable.toWeb(IncomingMessage) destroys the duplex socket,
  // which can erase a bounded400 before it is delivered. Own this tiny input
  // stream instead; an incomplete/rejected body closes only after response
  // flush. Never drain an unbounded body or queue more than513 bytes.
  let total = 0,
    complete = false,
    detached = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const detach = () => {
    if (detached) return;
    detached = true;
    request.off("data", data);
    request.off("end", end);
    request.off("aborted", error);
    request.pause();
  };
  const data = (value: Buffer) => {
    const remaining = maximum - total;
    const chunk = new Uint8Array(value.subarray(0, remaining));
    total += chunk.byteLength;
    controller.enqueue(chunk);
    request.pause();
    if (total === maximum) {
      response.shouldKeepAlive = false;
      detach();
      controller.close();
    }
  };
  const end = () => {
    complete = true;
    detach();
    controller.close();
  };
  const error = () => {
    if (detached) return;
    detach();
    controller.error(Error("AUTH_HTTP_BODY_UNAVAILABLE"));
  };
  const finish = () => {
    detach();
    if (!complete) response.shouldKeepAlive = false;
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(owned) {
        controller = owned;
        request.on("data", data);
        request.once("end", end);
        request.once("error", error);
        request.once("close", () => request.off("error", error));
        request.once("aborted", error);
        request.pause();
      },
      pull() {
        if (!detached) request.resume();
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
  return Object.freeze({ stream, finish });
}
function snapshot(plan: AuthDeliveryPlan, path: string, method: string) {
  const fields = Object.getOwnPropertyDescriptors(plan);
  if (
    Reflect.ownKeys(fields).sort().join(",") !== "bodyText,cookies,headers,status" ||
    Object.values(fields).some((field) => !Object.hasOwn(field, "value"))
  )
    throw Error("AUTH_HTTP_DELIVERY_INVALID");
  if (
    !Object.isFrozen(plan) ||
    ![200, 303, 400, 401, 403, 404, 405, 503].includes(plan.status) ||
    typeof plan.bodyText !== "string" ||
    Buffer.byteLength(plan.bodyText) > 8192 ||
    !Array.isArray(plan.headers) ||
    !Object.isFrozen(plan.headers) ||
    !Array.isArray(plan.cookies) ||
    !Object.isFrozen(plan.cookies) ||
    plan.cookies.length > 1
  )
    throw Error("AUTH_HTTP_DELIVERY_INVALID");
  const headers: Record<string, string | string[]> = {};
  const allowed = new Set([
    "content-type",
    "cache-control",
    "x-content-type-options",
    "referrer-policy",
    "content-security-policy",
    "location",
  ]);
  for (const pair of plan.headers) {
    if (!Array.isArray(pair) || !Object.isFrozen(pair) || pair.length !== 2)
      throw Error("AUTH_HTTP_DELIVERY_INVALID");
    const [name, value] = pair;
    if (
      typeof name !== "string" ||
      !allowed.has(name) ||
      name in headers ||
      typeof value !== "string" ||
      !/^[\x20-\x7e]{1,512}$/.test(value)
    )
      throw Error("AUTH_HTTP_DELIVERY_INVALID");
    headers[name] = value;
  }
  if (
    headers["cache-control"] !== "no-store" ||
    headers["x-content-type-options"] !== "nosniff" ||
    headers["referrer-policy"] !== "no-referrer"
  )
    throw Error("AUTH_HTTP_DELIVERY_INVALID");
  if (
    headers["content-type"] !== undefined &&
    headers["content-type"] !== "application/json; charset=utf-8" &&
    headers["content-type"] !== "text/html; charset=utf-8"
  )
    throw Error("AUTH_HTTP_DELIVERY_INVALID");
  if (
    headers["content-security-policy"] !== undefined &&
    headers["content-security-policy"] !==
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  )
    throw Error("AUTH_HTTP_DELIVERY_INVALID");
  const jsonHeaders =
    Object.keys(headers).sort().join(",") ===
      "cache-control,content-type,referrer-policy,x-content-type-options" &&
    headers["content-type"] === "application/json; charset=utf-8";
  if (path === "/auth/logout") {
    const expected =
      plan.status === 200
        ? '{"schemaVersion":1,"outcome":"session_ended"}'
        : '{"schemaVersion":1,"outcome":"logout_unavailable"}';
    if (
      plan.status === 303 ||
      plan.status === 401 ||
      (plan.status === 200 && method !== "POST") ||
      !jsonHeaders ||
      (plan.bodyText !== expected &&
        !(
          plan.status === 503 &&
          plan.bodyText === '{"schemaVersion":1,"outcome":"logout_outcome_unknown"}'
        ))
    )
      throw Error("AUTH_HTTP_DELIVERY_INVALID");
    // P05.T01y: only the exact clear, only on 200, 403 and 503. This snapshot cannot tell
    // a SQL 403 from a request-proof 403; the dispatcher tests own "clear only after SQL".
    if (
      plan.cookies.length !== 0 &&
      (plan.cookies[0] !== sessionClear || ![200, 403, 503].includes(plan.status))
    )
      throw Error("AUTH_HTTP_DELIVERY_INVALID");
    if (plan.cookies.length) headers["set-cookie"] = [sessionClear];
    return { status: plan.status, headers, bodyText: plan.bodyText };
  }
  if (path === "/auth/rotate") {
    const result = rotationResult.exec(plan.bodyText);
    const bodyOk =
      plan.status === 200
        ? result !== null &&
          method === "POST" &&
          Number(result[2]) <= 43200000 &&
          Number(result[3]) <= 43200000
        : plan.status === 401
          ? plan.bodyText === rotationBodies.authentication
          : plan.status === 503
            ? plan.bodyText === rotationBodies.unavailable ||
              plan.bodyText === rotationBodies.unknown
            : [400, 403, 404, 405].includes(plan.status) &&
              plan.bodyText === rotationBodies.unavailable;
    if (!jsonHeaders || !bodyOk) throw Error("AUTH_HTTP_DELIVERY_INVALID");
    const rotated = result?.[1] === "rotated";
    if (rotated !== (plan.cookies.length === 1)) throw Error("AUTH_HTTP_DELIVERY_INVALID");
    if (rotated) {
      const age =
        /^__Host-morrow_session=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=([1-9][0-9]{0,3})$/.exec(
          plan.cookies[0]!,
        )?.[1];
      if (age === undefined || Number(age) > 1800) throw Error("AUTH_HTTP_DELIVERY_INVALID");
      headers["set-cookie"] = [plan.cookies[0]!];
    }
    return { status: plan.status, headers, bodyText: plan.bodyText };
  }
  if (plan.status === 401) throw Error("AUTH_HTTP_DELIVERY_INVALID");
  if (plan.status === 303) {
    if (
      path !== "/auth/workos/callback" ||
      method !== "GET" ||
      plan.bodyText !== "" ||
      (headers.location !== "/" && headers.location !== "/auth/result")
    )
      throw Error("AUTH_HTTP_DELIVERY_INVALID");
  } else if (headers.location !== undefined) throw Error("AUTH_HTTP_DELIVERY_INVALID");
  const cookie = plan.cookies[0];
  if (cookie !== undefined) {
    const match =
      /^(__Host-morrow_login|__Host-morrow_session)=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=([1-9][0-9]{0,3})$/.exec(
        cookie,
      );
    if (!match) throw Error("AUTH_HTTP_DELIVERY_INVALID");
    const login = match[1] === "__Host-morrow_login";
    if (
      Number(match[3]) > (login ? 300 : 1800) ||
      (login
        ? !(method === "POST" && path === "/auth/login" && plan.status === 200)
        : !(
            method === "GET" &&
            path === "/auth/workos/callback" &&
            plan.status === 303 &&
            headers.location === "/"
          ))
    )
      throw Error("AUTH_HTTP_DELIVERY_INVALID");
    headers["set-cookie"] = [cookie];
  }
  if (
    (plan.status === 200 && path === "/auth/login") ||
    (plan.status === 303 && headers.location === "/")
  ) {
    if (cookie === undefined) throw Error("AUTH_HTTP_DELIVERY_INVALID");
  }
  return { status: plan.status, headers, bodyText: plan.bodyText };
}

// This source-owned transport consumes dispatch directly. It never awaits a
// Response body between the controller's final freshness check and header write.
export function createAuthHttpListener(binding?: AuthHttpBinding) {
  const configured = binding && Object.freeze({ ...binding });
  let origin: URL | undefined;
  if (configured) {
    origin = new URL(configured.origin);
    if (
      origin.origin !== configured.origin ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password
    )
      throw Error("AUTH_HTTP_CONFIGURATION_INVALID");
  }
  return (request: IncomingMessage, response: ServerResponse): void => {
    const abort = new AbortController();
    let body: ReturnType<typeof ownedBody> | undefined;
    const disconnect = () => abort.abort();
    const rawTarget = request.url ?? "";
    const logoutAtEntry = rawTarget === "/auth/logout" || rawTarget.startsWith("/auth/logout?");
    const rotateAtEntry = rawTarget === "/auth/rotate" || rawTarget.startsWith("/auth/rotate?");
    let logoutDispatched = false,
      rotateDispatched = false;
    // After dispatch a lost delivery is an unknown outcome (logout, rotate); before it,
    // a plain unavailable. Neither carries a cookie.
    const fallback = (): Fallback =>
      logoutAtEntry && logoutDispatched
        ? "logoutUnknown"
        : rotateAtEntry
          ? rotateDispatched
            ? "rotationUnknown"
            : "rotation"
          : "login";
    const callbackAtEntry =
      request.method === "GET" &&
      (rawTarget === "/auth/workos/callback" || rawTarget.startsWith("/auth/workos/callback?"));
    // Covers raw envelope handling as well as dispatch; no later stage can
    // restart the HTTP entry budget. A timeout never hands off a credential.
    const timer = setTimeout(
      () => {
        disconnect();
        body?.finish();
        if (!response.destroyed && !response.headersSent) {
          if (callbackAtEntry) {
            response.writeHead(303, {
              Location: "/auth/result",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            });
            response.end();
          } else unavailable(response, 503, fallback());
        } else if (!response.writableEnded) response.destroy();
      },
      callbackAtEntry ? 25000 : 5000,
    );
    const closed = () => {
      if (!response.writableEnded) disconnect();
    };
    request.once("aborted", disconnect);
    response.once("close", closed);
    void (async () => {
      let handed = false;
      try {
        if (!configured || !origin) {
          unavailable(response, 404);
          request.pause();
          return;
        }
        if ((request.socket as TLSSocket).encrypted !== true) {
          unavailable(response, 400);
          request.pause();
          return;
        }
        const raw = request.url ?? "";
        const seen = new Set<string>();
        let bytes = 0;
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          const name = request.rawHeaders[i]!.toLowerCase(),
            value = request.rawHeaders[i + 1]!;
          bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
          if ((sensitive.has(name) || name.startsWith("sec-fetch-")) && seen.has(name)) {
            unavailable(response, 400);
            request.pause();
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
          /[\\\x00-\x20\x7f#]/.test(raw) ||
          Buffer.byteLength(raw) > 8192 ||
          seen.has("authorization")
        ) {
          unavailable(response, 400);
          request.pause();
          return;
        }
        const url = new URL(raw, origin);
        if (url.origin !== origin.origin || url.pathname + url.search !== raw) {
          unavailable(response, 400);
          request.pause();
          return;
        }
        if (
          ![
            "/auth/login",
            "/auth/workos/callback",
            "/auth/result",
            "/auth/logout",
            "/auth/rotate",
          ].includes(url.pathname) ||
          (url.pathname === "/auth/logout" && !configured.logout) ||
          (url.pathname === "/auth/rotate" && !configured.rotate)
        ) {
          unavailable(response, 404);
          request.pause();
          return;
        }
        const method = request.method ?? "GET";
        if (
          (method === "GET" || method === "HEAD") &&
          ((request.headers["content-length"] !== undefined &&
            request.headers["content-length"] !== "0") ||
            request.headers["transfer-encoding"] !== undefined)
        ) {
          unavailable(response, 400);
          request.pause();
          return;
        }
        const headers = new Headers();
        for (let i = 0; i < request.rawHeaders.length; i += 2)
          headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
        const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal };
        if (method !== "GET" && method !== "HEAD") {
          body = ownedBody(
            request,
            response,
            url.pathname === "/auth/logout" || url.pathname === "/auth/rotate" ? 257 : 513,
          );
          init.body = body.stream;
          init.duplex = "half";
        }
        const input = new Request(url, init);
        const handler =
          url.pathname === "/auth/logout"
            ? configured.logout!
            : url.pathname === "/auth/rotate"
              ? configured.rotate!
              : configured.auth;
        logoutDispatched = url.pathname === "/auth/logout";
        rotateDispatched = url.pathname === "/auth/rotate";
        await handler.dispatch(input, (plan) => {
          if (handed || abort.signal.aborted || response.destroyed || response.headersSent)
            throw Error("AUTH_HTTP_DELIVERY_HELD");
          handed = true;
          const output = snapshot(plan, url.pathname, method);
          body?.finish();
          response.writeHead(output.status, output.headers);
          response.end(output.bodyText);
        });
        if (!handed && !abort.signal.aborted && !response.destroyed && !response.headersSent)
          unavailable(response, 503, fallback());
      } catch {
        body?.finish();
        if (!abort.signal.aborted && !response.destroyed && !response.headersSent)
          unavailable(response, 503, fallback());
        else if (!response.writableEnded) response.destroy();
      } finally {
        body?.finish();
        clearTimeout(timer);
        request.off("aborted", disconnect);
        response.off("close", closed);
      }
    })();
  };
}
