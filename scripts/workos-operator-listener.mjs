// Scripts-only loopback fixture. This is never an application login route.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { parseWorkosOperatorProfile } from "./workos-operator-transport.mjs";

const prefix = "/operator/workos";
const bootstrapName = "morrow_operator_bootstrap",
  proofName = "morrow_operator_browser";
const fail = () => Error("WORKOS_OPERATOR_LISTENER_DENIED");
const canonical = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, "base64url").toString("base64url") === value;
const same = (left, right) =>
  canonical(left) && canonical(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
function oneHeader(request, name) {
  const values = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i].toLowerCase() === name) values.push(request.rawHeaders[i + 1]);
  if (values.length > 1) throw fail();
  return values[0];
}
function cookies(request) {
  const raw = oneHeader(request, "cookie") ?? "";
  if (Buffer.byteLength(raw) > 4096) throw fail();
  const values = {};
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim(),
      value = part.slice(at + 1).trim();
    if ([bootstrapName, proofName].includes(name)) {
      if (Object.hasOwn(values, name) || !canonical(value)) throw fail();
      values[name] = value;
    }
  }
  return values;
}
function query(raw) {
  const values = {};
  for (const part of raw.split("&")) {
    const at = part.indexOf("=");
    if (at <= 0) throw fail();
    const key = part.slice(0, at);
    if (
      !["code", "state", "error", "error_description"].includes(key) ||
      Object.hasOwn(values, key)
    )
      throw fail();
    const value = decodeURIComponent(part.slice(at + 1).replace(/\+/g, " "));
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw fail();
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw fail();
    }
    values[key] = value;
  }
  const keys = Object.keys(values).sort().join(",");
  if (
    !["code,state", "error,state", "error,error_description,state"].includes(keys) ||
    !canonical(values.state)
  )
    throw fail();
  if (values.code !== undefined && (!values.code.length || values.code.length > 4096)) throw fail();
  if (
    values.error !== undefined &&
    (!values.error.length ||
      values.error.length > 128 ||
      (values.error_description?.length ?? 0) > 2048)
  )
    throw fail();
  return Object.freeze(values);
}
function body(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0,
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener("data", data);
      request.removeListener("end", end);
      request.removeListener("error", errorEvent);
      request.removeListener("aborted", errorEvent);
      if (error) {
        request.resume();
        reject(fail());
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const data = (chunk) => {
      const b = Buffer.from(chunk);
      bytes += b.length;
      if (bytes > limit) finish(true);
      else chunks.push(b);
    };
    const end = () => finish(false),
      errorEvent = () => finish(true);
    const timer = setTimeout(() => finish(true), 2000);
    request.on("data", data);
    request.once("end", end);
    request.once("error", errorEvent);
    request.once("aborted", errorEvent);
  });
}
function cookie(name, value, age = 300) {
  return `${name}=${value}; Path=${prefix}; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}
function secureHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("Content-Type", "text/html; charset=utf-8");
}
const render = (response, status, html) => {
  response.statusCode = status;
  response.end(html);
};
export function createWorkosOperatorHandler(profileJson, controller, options = {}) {
  const profile = parseWorkosOperatorProfile(profileJson),
    clock = options.clock ?? Date.now;
  const csrf = randomBytes(32).toString("base64url"),
    bootstrap = randomBytes(32).toString("base64url");
  const opened = clock();
  if (!Number.isFinite(opened)) throw fail();
  let started = false,
    callbackLatched = false,
    material = null,
    requests = 0,
    invalid = 0;
  const invalidResponse = (response, status = 400) => {
    invalid++;
    response.setHeader("Connection", "close");
    render(
      response,
      invalid > profile.max_invalid_requests ? 429 : status,
      "Operator request denied.",
    );
  };
  return async (request, response) => {
    secureHeaders(response);
    try {
      if (++requests > 64 || invalid > profile.max_invalid_requests)
        return render(response, 429, "Operator request limit reached.");
      const at = clock();
      if (!Number.isFinite(at) || at < opened || at >= opened + profile.max_flow_seconds * 1000)
        return invalidResponse(response, 410);
      if (
        request.rawHeaders.reduce((size, text) => size + Buffer.byteLength(text) + 2, 0) >
          profile.max_header_bytes ||
        oneHeader(request, "host") !== "127.0.0.1:4110" ||
        typeof request.url !== "string" ||
        Buffer.byteLength(request.url) > profile.max_uri_bytes ||
        !request.url.startsWith("/") ||
        request.url.startsWith("//") ||
        request.url.includes("#")
      )
        return invalidResponse(response);
      const origin = oneHeader(request, "origin"),
        c = cookies(request);
      if (request.method === "GET" && request.url === profile.start_path) {
        if (started) return invalidResponse(response, 409);
        // Only the clean, pre-authentication form preserves its same-origin POST
        // Origin. Callback, continuation, result and denial responses stay private.
        response.setHeader("Referrer-Policy", "same-origin");
        response.setHeader("Set-Cookie", cookie(bootstrapName, bootstrap));
        return render(
          response,
          200,
          `<!doctype html><meta charset="utf-8"><title>Morrow operator test</title><form method="post" action="${profile.start_path}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Prepare operator sign-in</button></form>`,
        );
      }
      if (request.method === "POST" && request.url === profile.start_path) {
        if (
          started ||
          origin !== profile.origin ||
          !same(c[bootstrapName], bootstrap) ||
          oneHeader(request, "content-type") !== "application/x-www-form-urlencoded"
        )
          return invalidResponse(response);
        const declared = oneHeader(request, "content-length");
        if (
          declared !== undefined &&
          (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > profile.max_body_bytes)
        )
          return invalidResponse(response, 413);
        const payload = await body(request, profile.max_body_bytes);
        if (
          started ||
          payload !== `csrf=${csrf}` ||
          clock() >= opened + profile.max_flow_seconds * 1000
        )
          return invalidResponse(response);
        started = true; // One valid CSRF start wins before SQL/controller awaits.
        let timer;
        const initial = await Promise.race([
          controller.start(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail()), 15000);
          }),
        ]).finally(() => clearTimeout(timer));
        const deadline = Date.parse(initial?.expiresAt);
        if (
          !initial ||
          !canonical(initial.state) ||
          !canonical(initial.browserProof) ||
          initial.state === initial.browserProof ||
          !Number.isFinite(deadline) ||
          deadline <= clock() ||
          deadline > opened + profile.max_flow_seconds * 1000 ||
          new Date(deadline).toISOString() !== initial.expiresAt ||
          typeof initial.authorizationUrl !== "string"
        )
          throw fail();
        const authorization = new URL(initial.authorizationUrl);
        const params = authorization.searchParams;
        if (
          authorization.origin + authorization.pathname !== profile.authorize_endpoint ||
          authorization.hash ||
          authorization.username ||
          authorization.password ||
          [...params.keys()].sort().join(",") !==
            "client_id,code_challenge,code_challenge_method,provider,redirect_uri,response_type,state" ||
          params.get("client_id") !== profile.client_id ||
          params.get("redirect_uri") !== profile.origin + profile.callback_path ||
          params.get("provider") !== "authkit" ||
          params.get("response_type") !== "code" ||
          params.get("state") !== initial.state ||
          params.get("code_challenge_method") !== "S256" ||
          !canonical(params.get("code_challenge"))
        )
          throw fail();
        material = Object.freeze({
          state: initial.state,
          browserProof: initial.browserProof,
          expiresAt: deadline,
        });
        response.setHeader("Set-Cookie", [
          cookie(
            proofName,
            material.browserProof,
            Math.max(1, Math.floor((deadline - clock()) / 1000)),
          ),
          cookie(bootstrapName, "", 0),
        ]);
        // A static anchor avoids form-action blocking an external POST redirect.
        const href = authorization.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        return render(
          response,
          200,
          `<!doctype html><meta charset="utf-8"><title>Morrow operator continuation</title><a href="${href}" rel="noreferrer">Continue to WorkOS operator test</a>`,
        );
      }
      if (request.method === "GET" && request.url.startsWith(profile.callback_path + "?")) {
        if (
          !material ||
          callbackLatched ||
          at >= material.expiresAt ||
          (origin !== undefined && origin !== profile.origin)
        )
          return invalidResponse(response);
        const fields = query(request.url.slice(profile.callback_path.length + 1));
        if (!same(fields.state, material.state) || !same(c[proofName], material.browserProof))
          return invalidResponse(response);
        // The controller validates and latches synchronously. No await can let a
        // second callback win, and controller rejection consumes no local latch.
        const pending =
          fields.code === undefined
            ? controller.authorizationNotCompleted(
                JSON.stringify({ state: fields.state, browserProof: c[proofName] }),
              )
            : controller.complete(
                JSON.stringify({
                  state: fields.state,
                  browserProof: c[proofName],
                  code: fields.code,
                }),
              );
        callbackLatched = true;
        material = null;
        response.setHeader("Set-Cookie", [cookie(proofName, "", 0), cookie(bootstrapName, "", 0)]);
        response.setHeader("Location", profile.origin + profile.result_path);
        response.statusCode = 303;
        response.end();
        void Promise.resolve(pending).catch(() => {});
        return;
      }
      if (request.method === "GET" && request.url === profile.result_path) {
        const status = controller.status();
        if (
          !status ||
          ![
            "ready",
            "starting",
            "awaiting_callback",
            "processing",
            "response_shape_received",
            "authorization_not_completed",
            "held",
          ].includes(status.state) ||
          status.providerSessionCleanup !== "unknown"
        )
          throw fail();
        return render(
          response,
          200,
          `<!doctype html><meta charset="utf-8"><title>Morrow operator result</title><p>Operator state: ${status.state}</p><p>Provider session cleanup: unknown.</p>`,
        );
      }
      return invalidResponse(response, 404);
    } catch {
      if (!response.writableEnded) return invalidResponse(response);
    }
  };
}
export function createWorkosOperatorListener(profileJson, controller, options = {}) {
  const profile = parseWorkosOperatorProfile(profileJson),
    handler = createWorkosOperatorHandler(profileJson, controller, options);
  const server = createServer(
    {
      maxHeaderSize: profile.max_header_bytes,
      requestTimeout: 5000,
      headersTimeout: 5000,
      keepAliveTimeout: 1000,
    },
    (request, response) => {
      void handler(request, response);
    },
  );
  server.maxRequestsPerSocket = 32;
  server.on("clientError", (_error, socket) => {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nContent-Length: 0\r\n\r\n",
    );
  });
  let used = false;
  return Object.freeze({
    origin: profile.origin,
    async listen() {
      if (used) throw fail();
      used = true;
      await new Promise((resolve, reject) => {
        const error = () => {
          server.removeListener("listening", ready);
          reject(fail());
        };
        const ready = () => {
          server.removeListener("error", error);
          resolve();
        };
        server.once("error", error);
        server.once("listening", ready);
        server.listen(4110, "127.0.0.1");
      });
    },
    async close() {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  });
}
