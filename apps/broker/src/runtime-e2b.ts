import { e2bKeyPattern } from "../../../packages/identity/src/broker-protocol.js";
import { computerProfile } from "../../../packages/policy/src/runtime-computer.js";
import {
  sandboxRefPattern,
  type RuntimeCreateResult,
  type RuntimeExecResult,
  type RuntimeKillResult,
  type RuntimeProvider,
  type RuntimeReadResult,
  type RuntimeStatusResult,
  type RuntimeWriteResult,
  type SandboxCommand,
  type SandboxCreateRequest,
  type SandboxHandle,
} from "./runtime-provider.js";

// The E2B adapter (ADR-0029 items 1 to 3, as amended by ADR-0035 item 6; build order PR 8):
// the RuntimeProviderPort over E2B's public REST API and its in-sandbox daemon (envd), by
// hand-written fetch, with no E2B SDK. Composed only in the broker (index.ts), which alone
// holds E2B_API_KEY; the gateway (runtime-gateway.ts) passes the key per call and the
// sandbox's own envd token per call, read from its vault record.
//
// Learned from E2B's public documentation and OpenAPI (docs.e2b.dev/api-reference, read
// 2026-10-24), never by calling E2B; tests/fixtures/e2b-wire.mjs reproduces the documented
// replies and tests/runtime-e2b.test.mjs runs PR 7's conformance suite over it. Every call:
//   * goes to one of two fixed origins: the platform API https://api.e2b.app (X-API-Key) and
//     envd behind https://sandbox.e2b.app (E2b-Sandbox-Id, E2b-Sandbox-Port 49983 and
//     X-Access-Token, the sandbox's envd token). No host comes from a reply: a create whose
//     reply names another domain is not used.
//   * uses redirect "manual"; any redirect is a broken reply, never followed.
//   * reads at most a fixed number of bytes and is cut off at the caller's budget.
//   * answers one closed outcome and never throws.
// Conservative defaults (ADR-0029 owner question 3, ADR-0035 item 6; E2B's answers are still
// awaited): after a request may have left, every failure is unknown (`unknown_effect` for the
// create). Only a 429 (quota) and a 402 or 403 (billing or a blocked team) on the create are
// named, and those still leave the operation unknown with a runtime hold. A lone 404 never
// means absence: a lookup or kill answers not_found only when two independent reads (the
// sandbox by its id and the list by the operation's metadata) both say so, each with E2B's
// own error or list body. A reply that breaks the documented shape (a redirect, an unexpected
// status, an unreadable or malformed body, an envd token refused) is marked `broken`, which
// the gateway turns into a runtime hold only a person lifts.
//
// The create sends exactly: the pinned template, the profile's 900 s timeout, autoPause off,
// allow_internet_access false, network.allowPublicTraffic false (the sandbox's ports answer
// no one without a traffic token, which Morrow never keeps) and metadata {operation}, with an
// Idempotency-Key derived from the operation id, so even a retry by a layer below would replay
// the same create. Never sent: environment variables, MCP, IAM tokens, volumes, an egress
// proxy, auto-resume, connect, resume, pause, refresh or timeout changes. The trafficAccessToken
// in a reply is never read; the envdAccessToken goes to the gateway and from there only into
// the vault.

export const e2bApiOrigin = "https://api.e2b.app";
export const e2bSandboxOrigin = "https://sandbox.e2b.app";
export const e2bEnvdPort = 49983;
/** The one sandbox domain the adapter talks to (the create reply's `domain`, when present). */
export const e2bSandboxDomain = "e2b.app";
/**
 * The template the profile creates from (ADR-0029 item 1): the owner's build of
 * infra/e2b/morrow-computer (README there). Null until the owner has built it and build order
 * PR 9 has qualified it; while null every execute holds RUNTIME_UNAVAILABLE.
 * tests/runtime-e2b.test.mjs ties it to infra/e2b/morrow-computer/template.json.
 */
export const e2bPinnedTemplate: string | null = null;
export type Fetch = (request: Request) => Promise<Response>;

/** Reply bounds: E2B's JSON replies are small; a file read is bounded by the caller. */
export const e2bReplyLimits = Object.freeze({
  jsonMaxBytes: 65_536,
  listMaxBytes: 262_144,
  frameMaxBytes: 1_048_576,
  streamMaxBytes: 8_388_608,
  writeMaxBytes: 8_388_608,
  /** The adapter's own stop on a command, beyond its timeout, when envd sends no end. */
  commandGraceMs: 3_000,
});

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const templatePattern = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const tokenPattern = /^[\x21-\x7e]{16,1024}$/;
const versionPattern = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;
const pathPattern = /^\/home\/agent\/(work|input|output)\/[a-z][a-z0-9_]{0,31}\.(py|csv|png|xlsx)$/;
const encoder = new TextEncoder();

type Body = { kind: "bytes"; bytes: Uint8Array } | { kind: "too_large" } | { kind: "failed" };
/** Reads a body up to `limit` bytes: a declared or streamed size past it is too_large. */
async function readBody(response: Response, limit: number): Promise<Body> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]{1,12}$/.test(declared)) {
      await response.body?.cancel().catch(() => {});
      return { kind: "failed" };
    }
    if (Number(declared) > limit) {
      await response.body?.cancel().catch(() => {});
      return { kind: "too_large" };
    }
  }
  if (!response.body) return { kind: "bytes", bytes: new Uint8Array(0) };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      chunks.push(item.value);
    }
  } catch {
    return { kind: "failed" };
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { kind: "bytes", bytes };
}
/** Strict UTF-8 JSON, or undefined. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}
async function readJson(response: Response, limit: number): Promise<unknown> {
  const body = await readBody(response, limit);
  return body.kind === "bytes" ? parseJson(body.bytes) : undefined;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const own = (value: unknown, name: string): unknown => {
  const r = record(value);
  return r !== null && Object.hasOwn(r, name) ? r[name] : undefined;
};
const discard = async (response: Response) => {
  await response.body?.cancel().catch(() => {});
};
/** A redirect (followed or not) is never an answer: the caller treats it as a broken reply. */
const redirected = (response: Response) =>
  response.redirected ||
  String(response.type) === "opaqueredirect" ||
  response.status === 0 ||
  (response.status >= 300 && response.status < 400);
/**
 * E2B's own error body ({code, message}, an optional error_code) with the expected status: the
 * only 404 that counts as a reading at all.
 */
async function e2bError(response: Response, status: number): Promise<boolean> {
  const body = await readJson(response, e2bReplyLimits.jsonMaxBytes);
  const r = record(body);
  return (
    r !== null &&
    own(r, "code") === status &&
    typeof own(r, "message") === "string" &&
    (own(r, "error_code") === undefined || typeof own(r, "error_code") === "string")
  );
}
function fromBase64(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
const budget = (ms: number) => Math.max(1, Math.min(Number.isFinite(ms) ? ms : 1, 600_000));

/** The create's exact body (exported for the wire tests; nothing here comes from a caller). */
export function e2bCreateBody(request: SandboxCreateRequest): Record<string, unknown> {
  return {
    templateID: request.template,
    timeout: request.timeoutSeconds,
    autoPause: false,
    allow_internet_access: false,
    network: { allowPublicTraffic: false },
    metadata: { operation: request.operationId },
  };
}
/** The profile's create, checked before anything leaves (a wrong one is never sent). */
function createAdmissible(request: unknown, credential: unknown): request is SandboxCreateRequest {
  const r = record(request);
  if (r === null) return false;
  const metadata = record(r.metadata);
  return (
    typeof r.operationId === "string" &&
    uuid.test(r.operationId) &&
    typeof r.template === "string" &&
    templatePattern.test(r.template) &&
    r.internet === false &&
    metadata !== null &&
    Object.keys(metadata).join() === "operation" &&
    metadata.operation === r.operationId &&
    typeof r.timeoutSeconds === "number" &&
    Number.isSafeInteger(r.timeoutSeconds) &&
    r.timeoutSeconds >= 1 &&
    r.timeoutSeconds <= computerProfile.sandboxTimeoutSeconds &&
    typeof credential === "string" &&
    e2bKeyPattern.exec(credential)?.[0] === credential
  );
}
const keyValid = (credential: unknown): credential is string =>
  typeof credential === "string" && e2bKeyPattern.exec(credential)?.[0] === credential;
const handleValid = (sandbox: unknown): sandbox is SandboxHandle => {
  const s = record(sandbox);
  return (
    s !== null &&
    typeof s.sandboxRef === "string" &&
    sandboxRefPattern.test(s.sandboxRef) &&
    typeof s.accessToken === "string" &&
    tokenPattern.test(s.accessToken)
  );
};
/** The profile's one command only: its argv, directory and user; a timeout of 1 to 120 s. */
const commandValid = (command: unknown): command is SandboxCommand => {
  const c = record(command);
  return (
    c !== null &&
    Array.isArray(c.argv) &&
    c.argv.length === computerProfile.command.length &&
    c.argv.every((a, i) => a === computerProfile.command[i]) &&
    c.cwd === computerProfile.workDirectory &&
    c.user === computerProfile.user &&
    typeof c.timeoutSeconds === "number" &&
    Number.isSafeInteger(c.timeoutSeconds) &&
    c.timeoutSeconds >= 1 &&
    c.timeoutSeconds <= computerProfile.execTimeoutSeconds
  );
};
const operationKey = (operationId: string) => operationId.replaceAll("-", "");

// One listed or detailed sandbox, as the adapter reads it: its id, its state and its
// operation; anything malformed is null.
interface Seen {
  readonly sandboxRef: string;
  readonly state: "running" | "paused";
  readonly operation: string | null;
  /** The detail shows a setting the profile never makes (internet, pause on timeout, resume). */
  readonly violation: boolean;
}
function seen(value: unknown): Seen | null {
  const r = record(value);
  if (r === null) return null;
  const id = own(r, "sandboxID");
  const state = own(r, "state");
  const metadata = own(r, "metadata");
  const envd = own(r, "envdVersion");
  if (
    typeof id !== "string" ||
    !sandboxRefPattern.test(id) ||
    (state !== "running" && state !== "paused") ||
    typeof own(r, "templateID") !== "string" ||
    typeof envd !== "string" ||
    !versionPattern.test(envd) ||
    !(metadata === undefined || metadata === null || record(metadata) !== null)
  )
    return null;
  const operation = own(metadata, "operation");
  const lifecycle = own(r, "lifecycle");
  const violation =
    own(r, "allowInternetAccess") === true ||
    own(lifecycle, "onTimeout") === "pause" ||
    own(lifecycle, "autoResume") === true;
  return Object.freeze({
    sandboxRef: id,
    state,
    operation: typeof operation === "string" ? operation : null,
    violation,
  });
}

type Lookup =
  | { readonly kind: "found"; readonly sandbox: Seen }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

// Connect protocol framing (envd's process.Process/Start, server streaming): a flags byte, a
// 4-byte big-endian length, then the JSON message; flag 0x02 marks the end-of-stream message.
function envelope(message: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(message));
  const out = new Uint8Array(5 + json.length);
  new DataView(out.buffer).setUint32(1, json.length, false);
  out.set(json, 5);
  return out;
}

export function createE2bRuntime(fetch: Fetch): RuntimeProvider {
  async function send(
    url: string,
    init: {
      readonly method: "GET" | "POST" | "DELETE";
      readonly headers: Record<string, string>;
      readonly body?: Uint8Array | string;
    },
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<Response | null> {
    try {
      return await fetch(
        new Request(url, {
          method: init.method,
          headers: init.headers,
          body: init.body ?? null,
          redirect: "manual",
          signal: signal ?? AbortSignal.timeout(budget(budgetMs)),
        }),
      );
    } catch {
      return null;
    }
  }
  const api = (key: string, json = false) =>
    json
      ? { "x-api-key": key, accept: "application/json", "content-type": "application/json" }
      : { "x-api-key": key, accept: "application/json" };
  const envd = (sandbox: SandboxHandle, extra: Record<string, string> = {}) => ({
    "e2b-sandbox-id": sandbox.sandboxRef,
    "e2b-sandbox-port": String(e2bEnvdPort),
    "x-access-token": sandbox.accessToken as string,
    ...extra,
  });
  const fileUrl = (path: string) =>
    e2bSandboxOrigin +
    "/files?path=" +
    encodeURIComponent(path) +
    "&username=" +
    encodeURIComponent(computerProfile.user);

  // The sandbox by its id: found (with its state and operation), absent only on E2B's own
  // 404 body, unknown otherwise.
  async function detail(sandboxRef: string, key: string, budgetMs: number): Promise<Lookup> {
    const response = await send(
      e2bApiOrigin + "/sandboxes/" + encodeURIComponent(sandboxRef),
      { method: "GET", headers: api(key) },
      budgetMs,
    );
    if (response === null) return { kind: "unknown" };
    if (response.status === 404)
      return (await e2bError(response, 404)) ? { kind: "absent" } : { kind: "unknown" };
    if (response.status !== 200 || redirected(response)) {
      await discard(response);
      return { kind: "unknown" };
    }
    const sandbox = seen(await readJson(response, e2bReplyLimits.jsonMaxBytes));
    return sandbox === null || sandbox.sandboxRef !== sandboxRef
      ? { kind: "unknown" }
      : { kind: "found", sandbox };
  }
  // The running and paused sandboxes carrying this operation's metadata: E2B's filter, then
  // the adapter's own check of every item; a second page or a stranger item is unknown.
  async function listed(
    operationId: string,
    key: string,
    budgetMs: number,
  ): Promise<readonly Seen[] | null> {
    const query =
      "metadata=" +
      encodeURIComponent("operation=" + operationId) +
      "&state=" +
      encodeURIComponent("running,paused") +
      "&limit=100";
    const response = await send(
      e2bApiOrigin + "/v2/sandboxes?" + query,
      { method: "GET", headers: api(key) },
      budgetMs,
    );
    if (response === null) return null;
    if (response.status !== 200 || redirected(response)) {
      await discard(response);
      return null;
    }
    const next = response.headers.get("x-next-token");
    const body = await readJson(response, e2bReplyLimits.listMaxBytes);
    if (!Array.isArray(body) || (next !== null && next !== "")) return null;
    const out: Seen[] = [];
    for (const item of body) {
      const s = seen(item);
      if (s === null || s.operation !== operationId) return null;
      out.push(s);
    }
    return Object.freeze(out);
  }
  const statusOf = (s: Seen): RuntimeStatusResult =>
    s.state === "paused" || s.violation
      ? { outcome: "paused", sandboxRef: s.sandboxRef }
      : { outcome: "running", sandboxRef: s.sandboxRef };

  const adapter: RuntimeProvider = {
    provider: "e2b",

    async create(request, credential, budgetMs): Promise<RuntimeCreateResult> {
      if (!createAdmissible(request, credential)) return { outcome: "not_sent" };
      const response = await send(
        e2bApiOrigin + "/v2/sandboxes",
        {
          method: "POST",
          headers: {
            ...api(credential, true),
            "idempotency-key": operationKey(request.operationId),
          },
          body: JSON.stringify(e2bCreateBody(request)),
        },
        budgetMs,
      );
      // Anything after the send but a well-formed 201 leaves the outcome unknown.
      if (response === null) return { outcome: "unknown_effect" };
      if (response.status === 429) {
        await discard(response);
        return { outcome: "quota_exhausted" };
      }
      if (response.status === 402 || response.status === 403) {
        await discard(response);
        return { outcome: "billing_blocked" };
      }
      if (response.status !== 201 || redirected(response)) {
        const documented = [400, 401, 404, 409, 422, 500, 502, 503, 504].includes(response.status);
        await discard(response);
        return documented
          ? { outcome: "unknown_effect" }
          : { outcome: "unknown_effect", broken: true };
      }
      const body = await readJson(response, e2bReplyLimits.jsonMaxBytes);
      const id = own(body, "sandboxID");
      const template = own(body, "templateID");
      const alias = own(body, "alias");
      const token = own(body, "envdAccessToken");
      const version = own(body, "envdVersion");
      const domain = own(body, "domain");
      if (
        typeof id !== "string" ||
        !sandboxRefPattern.test(id) ||
        typeof template !== "string" ||
        (template !== request.template && alias !== request.template) ||
        typeof version !== "string" ||
        !versionPattern.test(version) ||
        // Secure access is the only access: no token, no sandbox Morrow talks to.
        typeof token !== "string" ||
        !tokenPattern.test(token) ||
        !(domain === undefined || domain === null || domain === e2bSandboxDomain)
      )
        return { outcome: "unknown_effect", broken: true };
      return { outcome: "created", sandboxRef: id, accessToken: token };
    },

    async status(operationId, sandboxRef, credential, budgetMs): Promise<RuntimeStatusResult> {
      if (
        typeof operationId !== "string" ||
        !uuid.test(operationId) ||
        !(
          sandboxRef === null ||
          (typeof sandboxRef === "string" && sandboxRefPattern.test(sandboxRef))
        ) ||
        !keyValid(credential)
      )
        return { outcome: "unknown" };
      const started = Date.now();
      const remaining = () => budgetMs - (Date.now() - started);
      const list = await listed(operationId, credential, remaining());
      if (list === null || list.length > 1) return { outcome: "unknown" };
      if (sandboxRef === null)
        return list.length === 0 ? { outcome: "not_found" } : statusOf(list[0]!);
      if (list.length === 1 && list[0]!.sandboxRef !== sandboxRef) return { outcome: "unknown" };
      // The id is known: a second, independent read. Both must agree.
      const one = await detail(sandboxRef, credential, remaining());
      if (one.kind === "unknown") return { outcome: "unknown" };
      if (one.kind === "absent")
        return list.length === 0 ? { outcome: "not_found" } : { outcome: "unknown" };
      if (one.sandbox.operation !== operationId || list.length === 0) return { outcome: "unknown" };
      return statusOf({
        ...one.sandbox,
        state: one.sandbox.state === "paused" || list[0]!.state === "paused" ? "paused" : "running",
      });
    },

    async writeFile(sandbox, path, bytes, budgetMs): Promise<RuntimeWriteResult> {
      if (
        !handleValid(sandbox) ||
        typeof path !== "string" ||
        !pathPattern.test(path) ||
        !(bytes instanceof Uint8Array) ||
        bytes.length > e2bReplyLimits.writeMaxBytes
      )
        return { outcome: "unknown" };
      const response = await send(
        fileUrl(path),
        {
          method: "POST",
          headers: envd(sandbox, {
            "content-type": "application/octet-stream",
            accept: "application/json",
          }),
          body: new Uint8Array(bytes),
        },
        budgetMs,
      );
      if (response === null) return { outcome: "unknown" };
      if (response.status !== 200 || redirected(response)) {
        const broken = !(
          response.status === 429 ||
          response.status === 502 ||
          response.status >= 500 ||
          response.status === 507
        );
        await discard(response);
        return broken ? { outcome: "unknown", broken: true } : { outcome: "unknown" };
      }
      // envd may label the JSON text/plain; it is parsed as JSON either way.
      const body = await readJson(response, e2bReplyLimits.jsonMaxBytes);
      const entry = Array.isArray(body) && body.length === 1 ? body[0] : undefined;
      if (own(entry, "path") !== path || own(entry, "type") !== "file")
        return { outcome: "unknown", broken: true };
      return { outcome: "written" };
    },

    async exec(sandbox, command, budgetMs): Promise<RuntimeExecResult> {
      if (!handleValid(sandbox) || !commandValid(command)) return { outcome: "unknown" };
      const timeoutMs = command.timeoutSeconds * 1000;
      const controller = new AbortController();
      let commandTimedOut = false;
      const commandTimer = setTimeout(() => {
        commandTimedOut = true;
        controller.abort();
      }, timeoutMs + e2bReplyLimits.commandGraceMs);
      const budgetTimer = setTimeout(() => controller.abort(), budget(budgetMs));
      try {
        const response = await send(
          e2bSandboxOrigin + "/process.Process/Start",
          {
            method: "POST",
            headers: envd(sandbox, {
              "content-type": "application/connect+json",
              "connect-protocol-version": "1",
              "connect-timeout-ms": String(timeoutMs),
              authorization: "Basic " + btoa(computerProfile.user + ":"),
            }),
            body: envelope({
              process: {
                cmd: command.argv[0],
                args: command.argv.slice(1),
                envs: {},
                cwd: command.cwd,
              },
              stdin: false,
            }),
          },
          budgetMs,
          controller.signal,
        );
        if (response === null)
          return commandTimedOut ? { outcome: "timed_out" } : { outcome: "unknown" };
        const type = response.headers.get("content-type") ?? "";
        if (
          response.status !== 200 ||
          redirected(response) ||
          !type.startsWith("application/connect+json")
        ) {
          const broken = !(
            response.status === 429 ||
            response.status === 502 ||
            response.status >= 500
          );
          await discard(response);
          return broken ? { outcome: "unknown", broken: true } : { outcome: "unknown" };
        }
        return await stream(response, () => commandTimedOut);
      } finally {
        clearTimeout(commandTimer);
        clearTimeout(budgetTimer);
      }
    },

    async readFile(sandbox, path, maxBytes, budgetMs): Promise<RuntimeReadResult> {
      if (
        !handleValid(sandbox) ||
        typeof path !== "string" ||
        !pathPattern.test(path) ||
        typeof maxBytes !== "number" ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0
      )
        return { outcome: "unknown" };
      const response = await send(
        fileUrl(path),
        { method: "GET", headers: envd(sandbox, { "accept-encoding": "identity" }) },
        budgetMs,
      );
      if (response === null) return { outcome: "unknown" };
      if (response.status === 404)
        return (await e2bError(response, 404))
          ? { outcome: "missing" }
          : { outcome: "unknown", broken: true };
      if (response.status !== 200 || redirected(response)) {
        const broken = !(
          response.status === 429 ||
          response.status === 502 ||
          response.status >= 500
        );
        await discard(response);
        return broken ? { outcome: "unknown", broken: true } : { outcome: "unknown" };
      }
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding !== "identity") {
        await discard(response);
        return { outcome: "unknown", broken: true };
      }
      const body = await readBody(response, maxBytes);
      if (body.kind === "too_large") return { outcome: "too_large" };
      if (body.kind === "failed") return { outcome: "unknown" };
      return { outcome: "read", bytes: body.bytes };
    },

    async kill(sandboxRef, credential, budgetMs): Promise<RuntimeKillResult> {
      if (
        typeof sandboxRef !== "string" ||
        !sandboxRefPattern.test(sandboxRef) ||
        !keyValid(credential)
      )
        return { outcome: "unknown" };
      const started = Date.now();
      const response = await send(
        e2bApiOrigin + "/sandboxes/" + encodeURIComponent(sandboxRef),
        { method: "DELETE", headers: api(credential) },
        budgetMs,
      );
      if (response === null) return { outcome: "unknown" };
      if (response.status === 204 && !redirected(response)) {
        await discard(response);
        return { outcome: "killed" };
      }
      if (response.status !== 404 || !(await e2bError(response, 404))) {
        await discard(response);
        return { outcome: "unknown" };
      }
      // A 404 to the kill is read back once: not_found only if the sandbox is absent there too.
      const again = await detail(sandboxRef, credential, budgetMs - (Date.now() - started));
      return again.kind === "absent" ? { outcome: "not_found" } : { outcome: "unknown" };
    },
  };

  // The Start stream: a start event, data events (stdout and stderr, base64, kept to the
  // profile's log size), keepalives, one end event, then the end-of-stream message. A
  // deadline_exceeded end (envd's Connect-Timeout-Ms) or the adapter's own stop past the
  // command's timeout is timed_out; any other error, a cut stream or a malformed frame is
  // unknown (a malformed one marked broken).
  async function stream(
    response: Response,
    commandTimedOut: () => boolean,
  ): Promise<RuntimeExecResult> {
    if (!response.body) return { outcome: "unknown", broken: true };
    const reader = response.body.getReader();
    const keep = 4096;
    const out = { stdout: new Uint8Array(keep), stderr: new Uint8Array(keep) };
    const used = { stdout: 0, stderr: 0 };
    let buffer = new Uint8Array(0);
    let total = 0;
    let started = false;
    let exit: number | null = null;
    let ended = false;
    const fail = async (result: RuntimeExecResult): Promise<RuntimeExecResult> => {
      await reader.cancel().catch(() => {});
      return result;
    };
    try {
      for (;;) {
        // Every whole frame in the buffer.
        while (buffer.length >= 5) {
          const flags = buffer[0]!;
          const length = new DataView(buffer.buffer, buffer.byteOffset, 5).getUint32(1, false);
          if (length > e2bReplyLimits.frameMaxBytes || (flags & ~0x02) !== 0)
            return await fail({ outcome: "unknown", broken: true });
          if (buffer.length < 5 + length) break;
          const message = parseJson(buffer.subarray(5, 5 + length));
          buffer = buffer.slice(5 + length);
          if (flags === 0x02) {
            // The end of the stream: {} after an end event, or the RPC's error.
            const error = own(message, "error");
            if (record(message) === null) return await fail({ outcome: "unknown", broken: true });
            if (error !== undefined) {
              const code = own(error, "code");
              if (code === "deadline_exceeded") return await fail({ outcome: "timed_out" });
              return await fail(
                typeof code === "string"
                  ? { outcome: "unknown" }
                  : { outcome: "unknown", broken: true },
              );
            }
            if (!ended || exit === null) return await fail({ outcome: "unknown", broken: true });
            await reader.cancel().catch(() => {});
            const decode = (name: "stdout" | "stderr") =>
              new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
                .decode(out[name].subarray(0, used[name]))
                .replace(/�+$/, "");
            return {
              outcome: "exited",
              exitCode: exit,
              stdout: decode("stdout"),
              stderr: decode("stderr"),
            };
          }
          const event = own(message, "event");
          const kinds = record(event) === null ? [] : Object.keys(event as object);
          const [kind] = kinds;
          if (kinds.length !== 1 || (ended && kind !== "keepalive"))
            return await fail({ outcome: "unknown", broken: true });
          const value = own(event, kind!);
          if (kind === "start") {
            const pid = own(value, "pid");
            if (
              started ||
              !(pid === undefined || (typeof pid === "number" && Number.isSafeInteger(pid)))
            )
              return await fail({ outcome: "unknown", broken: true });
            started = true;
          } else if (kind === "keepalive") {
            continue;
          } else if (kind === "data") {
            if (!started) return await fail({ outcome: "unknown", broken: true });
            const names = record(value) === null ? [] : Object.keys(value as object);
            if (names.length !== 1 || !["stdout", "stderr", "pty"].includes(names[0]!))
              return await fail({ outcome: "unknown", broken: true });
            const bytes = fromBase64(own(value, names[0]!));
            if (bytes === null) return await fail({ outcome: "unknown", broken: true });
            const name = names[0] === "stderr" ? "stderr" : names[0] === "stdout" ? "stdout" : null;
            if (name !== null) {
              const room = Math.min(bytes.length, keep - used[name]);
              out[name].set(bytes.subarray(0, room), used[name]);
              used[name] += room;
            }
          } else if (kind === "end") {
            if (!started) return await fail({ outcome: "unknown", broken: true });
            // proto3 JSON leaves a zero exit code out.
            const code = own(value, "exitCode");
            if (!(code === undefined || (typeof code === "number" && Number.isSafeInteger(code))))
              return await fail({ outcome: "unknown", broken: true });
            exit = code === undefined ? 0 : code;
            ended = true;
          } else return await fail({ outcome: "unknown", broken: true });
        }
        const item = await reader.read();
        if (item.done) return { outcome: "unknown" };
        total += item.value.byteLength;
        if (total > e2bReplyLimits.streamMaxBytes) return await fail({ outcome: "unknown" });
        const joined = new Uint8Array(buffer.length + item.value.byteLength);
        joined.set(buffer);
        joined.set(item.value, buffer.length);
        buffer = joined;
      }
    } catch {
      return commandTimedOut() ? { outcome: "timed_out" } : { outcome: "unknown" };
    }
  }
  return Object.freeze(adapter);
}
