// A recorded-HTTP fake of E2B (build order PR 8): the platform API (https://api.e2b.app) and
// the sandbox daemon envd behind https://sandbox.e2b.app, answering as E2B's public
// documentation and OpenAPI say (docs.e2b.dev/api-reference, read 2026-10-24): the v2 create
// and list, the sandbox detail and delete, envd's file upload and download and its
// process.Process/Start Connect stream. No E2B endpoint is ever called; the adapter under test
// (apps/broker/src/runtime-e2b.ts) receives this `fetch`.
//
// It keeps the provider's truth (sandboxes alive until killed or past their timeout, never
// paused unless a fault says so), records every request (method, origin, path, query, headers
// with secret values replaced by markers, body), and what a sandbox could observe (`guest`:
// the create's template, timeout, internet flag, metadata and environment; the files written;
// the commands run with their user and environment). Its "interpreter" runs no code: a job
// script drives it with the runtime fake's `#!fake` directives (write, stdout, stderr, exit,
// hang, stall). Faults are queued per route and answer once, in order:
//   { route, kind: "status", status, body?, headers?, contentType? }  a documented error reply
//   { route, kind: "lost" }      the effect happens, then the reply is lost (the fetch rejects)
//   { route, kind: "drop" }      the fetch rejects and nothing happens
//   { route, kind: "hang" }      no reply until the request's signal aborts
//   { route, kind: "redirect" }  a 302 to another host (which must never be fetched)
//   { route, kind: "body", status, body, contentType?, headers? }  any reply, malformed or not
//   { route: "list", kind: "paused" }  the next list shows every live sandbox paused
//   { route: "exec", kind: "cut" }     the stream breaks after the start event
// Routes: create, list, detail, kill, write, read, exec.
import { randomBytes } from "node:crypto";

export const e2bWireOrigins = Object.freeze({
  api: "https://api.e2b.app",
  sandbox: "https://sandbox.e2b.app",
});
const encoder = new TextEncoder();
const json = (status, value, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const error = (status, message, extra = {}) => json(status, { code: status, message, ...extra });
const notFound = (id) =>
  error(404, `Sandbox "${id}" doesn't exist or you don't have access to it`);
function frame(message, flags = 0) {
  const body = encoder.encode(JSON.stringify(message));
  const out = new Uint8Array(5 + body.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, body.length, false);
  out.set(body, 5);
  return out;
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {{credential: string, now: () => number, templates?: string[], domain?: string|null}} options
 */
export function createE2bWire(options) {
  const templates = new Set(options.templates ?? ["morrow-computer-test-v1"]);
  const sandboxes = new Map();
  const faults = [];
  const requests = [];
  const violations = [];
  const guest = { creates: [], files: [], commands: [] };
  const secrets = () => [
    options.credential,
    ...[...sandboxes.values()].flatMap((s) => [s.token, s.traffic]),
  ];
  const take = (route) => {
    const i = faults.findIndex((f) => f.route === route);
    return i < 0 ? null : faults.splice(i, 1)[0];
  };
  const live = (id) => {
    const s = sandboxes.get(id);
    return s && !s.killed && options.now() < s.expiresAtMs ? s : null;
  };
  const listed = (s, paused = false) => ({
    templateID: s.template,
    alias: s.template,
    sandboxID: s.id,
    clientID: "6532622b",
    startedAt: iso(s.startedAtMs),
    endAt: iso(s.expiresAtMs),
    cpuCount: 2,
    memoryMB: 1024,
    diskSizeMB: 10240,
    metadata: { ...s.metadata },
    state: paused || s.paused ? "paused" : "running",
    envdVersion: "0.2.4",
  });
  const detailOf = (s) => ({
    ...listed(s),
    envdAccessToken: s.token,
    allowInternetAccess: s.internet,
    domain: null,
    network: { allowPublicTraffic: false },
    lifecycle: { autoResume: false, onTimeout: "kill" },
  });
  const hang = (signal) =>
    new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason ?? Error("aborted"));
      signal.addEventListener("abort", () => reject(signal.reason ?? Error("aborted")), {
        once: true,
      });
    });
  // A fault either answers instead of the route, or (lost) after its effect.
  async function faulted(route, signal, effect) {
    const f = take(route);
    if (!f) return { response: await effect() };
    if (f.kind === "lost") {
      await effect();
      throw new TypeError("network connection lost");
    }
    if (f.kind === "drop") throw new TypeError("network connection lost");
    if (f.kind === "hang") return { response: await hang(signal) };
    if (f.kind === "redirect")
      return {
        response: new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/" + route },
        }),
      };
    if (f.kind === "status")
      return {
        response:
          f.body === undefined
            ? error(f.status, "fault " + f.status, {})
            : new Response(typeof f.body === "string" ? f.body : JSON.stringify(f.body), {
                status: f.status,
                headers: { "content-type": f.contentType ?? "application/json", ...f.headers },
              }),
      };
    if (f.kind === "body")
      return {
        response: new Response(f.body, {
          status: f.status,
          headers: { "content-type": f.contentType ?? "application/json", ...f.headers },
        }),
      };
    return { fault: f, response: await effect(f) };
  }
  function record(request, url, body) {
    const headers = {};
    for (const [name, value] of request.headers) {
      let shown = value;
      for (const secret of secrets())
        if (secret && shown.includes(secret))
          shown = shown.replaceAll(
            secret,
            secret === options.credential ? "<api-key>" : "<sandbox-token>",
          );
      headers[name] = shown;
    }
    const entry = {
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      rawQuery: url.search,
      headers,
      redirect: request.redirect,
      body,
    };
    requests.push(entry);
    if (request.redirect !== "manual") violations.push("redirect_not_manual:" + url.pathname);
    if (!request.signal) violations.push("no_signal:" + url.pathname);
    return entry;
  }
  const apiKeyOk = (request) => request.headers.get("x-api-key") === options.credential;

  async function api(request, url, body) {
    if (!apiKeyOk(request)) return error(401, "Invalid API key, it must start with 'e2b_'");
    if (request.headers.get("x-access-token") !== null)
      violations.push("sandbox_token_sent_to_api");
    const path = url.pathname;
    if (request.method === "POST" && path === "/v2/sandboxes") {
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return error(400, "request body has an error: doesn't match schema");
      }
      return (
        await faulted("create", request.signal, () => {
          guest.creates.push({
            template: parsed.templateID,
            timeoutSeconds: parsed.timeout,
            internet: parsed.allow_internet_access !== false,
            metadata: { ...(parsed.metadata ?? {}) },
            environment: { ...(parsed.envVars ?? {}) },
            network: parsed.network ?? null,
            autoPause: parsed.autoPause ?? false,
          });
          if (!templates.has(parsed.templateID))
            return error(404, `template '${parsed.templateID}' not found`);
          const id = "i" + randomBytes(10).toString("hex");
          const s = {
            id,
            template: parsed.templateID,
            operation: parsed.metadata?.operation ?? null,
            metadata: { ...(parsed.metadata ?? {}) },
            token: "envd_" + randomBytes(24).toString("hex"),
            traffic: "traffic_" + randomBytes(24).toString("hex"),
            startedAtMs: options.now(),
            expiresAtMs: options.now() + (parsed.timeout ?? 300) * 1000,
            internet: parsed.allow_internet_access !== false,
            paused: false,
            killed: false,
            files: new Map(),
          };
          sandboxes.set(id, s);
          return json(201, {
            templateID: s.template,
            sandboxID: id,
            alias: s.template,
            clientID: "6532622b",
            envdVersion: "0.2.4",
            envdAccessToken: s.token,
            trafficAccessToken: s.traffic,
            domain: options.domain === undefined ? null : options.domain,
          });
        })
      ).response;
    }
    if (request.method === "GET" && path === "/v2/sandboxes") {
      return (
        await faulted("list", request.signal, (f) => {
          const filter = new URLSearchParams(url.searchParams.get("metadata") ?? "");
          const states = (url.searchParams.get("state") ?? "running").split(",");
          const items = [...sandboxes.values()]
            .filter((s) => live(s.id))
            .filter((s) => [...filter].every(([k, v]) => s.metadata[k] === v))
            .map((s) => listed(s, f?.kind === "paused"))
            .filter((item) => states.includes(item.state));
          return json(200, items, { "x-total-running": String(items.length) });
        })
      ).response;
    }
    const match = /^\/sandboxes\/([^/]+)$/.exec(path);
    if (match && request.method === "GET")
      return (
        await faulted("detail", request.signal, () => {
          const s = live(decodeURIComponent(match[1]));
          return s ? json(200, detailOf(s)) : notFound(decodeURIComponent(match[1]));
        })
      ).response;
    if (match && request.method === "DELETE")
      return (
        await faulted("kill", request.signal, () => {
          const s = live(decodeURIComponent(match[1]));
          if (!s) return notFound(decodeURIComponent(match[1]));
          s.killed = true;
          return new Response(null, { status: 204 });
        })
      ).response;
    violations.push("unexpected_api:" + request.method + " " + path);
    return error(404, "not found");
  }

  async function envd(request, url, body) {
    if (request.headers.get("x-api-key") !== null) violations.push("api_key_sent_to_sandbox");
    const id = request.headers.get("e2b-sandbox-id");
    if (request.headers.get("e2b-sandbox-port") !== "49983" || !id)
      return new Response("missing header", {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    const route =
      url.pathname === "/files"
        ? request.method === "POST"
          ? "write"
          : "read"
        : url.pathname === "/process.Process/Start"
          ? "exec"
          : null;
    if (route === null) {
      violations.push("unexpected_envd:" + request.method + " " + url.pathname);
      return error(404, "not found");
    }
    return (
      await faulted(route, request.signal, (f) => {
        const s = live(id);
        if (!s) return json(502, { sandboxId: id, message: "The sandbox was not found", code: 502 });
        if (request.headers.get("x-access-token") !== s.token)
          return error(401, "invalid access token");
        if (route === "write") {
          const path = url.searchParams.get("path");
          const user = url.searchParams.get("username");
          if (!path || request.headers.get("content-type") !== "application/octet-stream")
            return error(400, "path is required");
          s.files.set(path, new Uint8Array(body));
          guest.files.push({ sandboxRef: s.id, path, user, bytes: new Uint8Array(body) });
          return new Response(
            JSON.stringify([{ path, name: path.split("/").at(-1), type: "file" }]),
            { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
          );
        }
        if (route === "read") {
          const path = url.searchParams.get("path");
          const bytes = path ? s.files.get(path) : undefined;
          if (!bytes) return error(404, `path '${path}' does not exist`);
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(bytes.length),
            },
          });
        }
        return start(s, request, body, f);
      })
    ).response;
  }

  // envd's process.Process/Start: one Connect-framed request, a framed stream back.
  function start(s, request, body, f) {
    if (
      request.headers.get("content-type") !== "application/connect+json" ||
      request.headers.get("connect-protocol-version") !== "1"
    )
      return new Response("unsupported content type", {
        status: 415,
        headers: { "content-type": "text/plain" },
      });
    const length = new DataView(body.buffer, body.byteOffset).getUint32(1, false);
    const message = JSON.parse(new TextDecoder().decode(body.subarray(5, 5 + length)));
    const auth = request.headers.get("authorization") ?? "";
    const user = auth.startsWith("Basic ") ? atob(auth.slice(6)).replace(/:$/, "") : null;
    const argv = [message.process.cmd, ...(message.process.args ?? [])];
    guest.commands.push({
      sandboxRef: s.id,
      argv,
      cwd: message.process.cwd,
      user,
      environment: { ...(message.process.envs ?? {}) },
      stdin: message.stdin,
      timeoutMs: request.headers.get("connect-timeout-ms"),
    });
    const frames = [frame({ event: { start: { pid: 4242 } } })];
    const headers = { "content-type": "application/connect+json" };
    if (f?.kind === "cut") {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(frames[0]);
          controller.error(new TypeError("stream reset"));
        },
      });
      return new Response(stream, { status: 200, headers });
    }
    const script = s.files.get(argv.at(-1));
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    if (!script) {
      exitCode = 2;
      stderr = "python3: can't open file\n";
    } else
      for (const line of new TextDecoder().decode(script).split("\n")) {
        const d = /^#!fake (write|stdout|stderr|exit|hang|stall)(?: (.*))?$/.exec(line);
        if (!d) continue;
        const [, verb, rest = ""] = d;
        if (verb === "hang") {
          frames.push(
            frame(
              { error: { code: "deadline_exceeded", message: "context deadline exceeded" } },
              2,
            ),
          );
          return new Response(concat(frames), { status: 200, headers });
        }
        if (verb === "stall") {
          const signal = request.signal;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(frames[0]);
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          });
          return new Response(stream, { status: 200, headers });
        }
        if (verb === "exit") exitCode = Number(rest);
        if (verb === "stdout") stdout += rest + "\n";
        if (verb === "stderr") stderr += rest + "\n";
        if (verb === "write") {
          const [target = "", data = ""] = rest.split(" ");
          s.files.set(target, new Uint8Array(Buffer.from(data, "base64")));
        }
      }
    if (stdout)
      frames.push(frame({ event: { data: { stdout: Buffer.from(stdout).toString("base64") } } }));
    if (stderr)
      frames.push(frame({ event: { data: { stderr: Buffer.from(stderr).toString("base64") } } }));
    frames.push(frame({ event: { keepalive: {} } }));
    // proto3 JSON leaves a zero exit code out.
    const end = { exited: true, status: "exit status " + exitCode };
    if (exitCode !== 0) end.exitCode = exitCode;
    frames.push(frame({ event: { end } }));
    frames.push(frame({}, 2));
    return new Response(concat(frames), { status: 200, headers });
  }

  async function fetch(request) {
    if (!(request instanceof Request)) throw Error("E2B_WIRE_EXPECTS_A_REQUEST");
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    record(request, url, body);
    if (request.signal?.aborted) throw request.signal.reason ?? Error("aborted");
    if (url.origin === e2bWireOrigins.api) return api(request, url, body);
    if (url.origin === e2bWireOrigins.sandbox) return envd(request, url, body);
    violations.push("unexpected_origin:" + url.origin);
    throw new TypeError("unexpected host");
  }

  return Object.freeze({
    fetch,
    guest,
    requests,
    violations,
    sandboxes,
    fault(f) {
      faults.push(f);
    },
    pending: () => faults.length,
    alive: () =>
      [...sandboxes.values()]
        .filter((s) => live(s.id))
        .map((s) => ({ ref: s.id, operationId: s.operation })),
    created: () => sandboxes.size,
  });
}

/** The runtime fake's directive script, for a harness's `script(spec)`. */
export function wireScript(spec) {
  const lines = ["# synthetic job"];
  if (spec.hang) lines.push("#!fake hang");
  if (spec.stall) lines.push("#!fake stall");
  if (spec.stdout) lines.push("#!fake stdout " + spec.stdout);
  if (spec.stderr) lines.push("#!fake stderr " + spec.stderr);
  for (const [path, bytes] of Object.entries(spec.files ?? {}))
    lines.push("#!fake write " + path + " " + Buffer.from(bytes).toString("base64"));
  if (spec.exitCode !== undefined) lines.push("#!fake exit " + spec.exitCode);
  return new TextEncoder().encode(lines.join("\n") + "\n");
}
