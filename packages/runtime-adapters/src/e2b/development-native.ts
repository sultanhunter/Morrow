// Documented E2B REST calls only. SDK high-level execution follows redirects and
// is deliberately excluded from this active, scripts-only laboratory adapter.
import type { components } from "e2b";
import type {
  SyntheticLabContext,
  SyntheticLabPort,
  SyntheticLabResource,
} from "../../../infrastructure/src/synthetic-runtime-lab.js";
import {
  captureE2BDevelopmentInput,
  exactE2BMetadata,
  e2bBounded,
  e2bDenied,
  e2bFailed,
  e2bGuarded,
  e2bRecord,
  verifyE2BDevelopmentAccess,
} from "./development-transport.js";
import type { E2BDevelopmentInput, E2BDevelopmentQualification } from "./development-transport.js";

const API = "https://api.e2b.app";
const ENVD = "https://sandbox.e2b.app";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[^\r\n\0]{1,16384}$/;
const REQUEST_MS = 15000;
type NativeCreate = components["schemas"]["NewSandboxV2"];
type NativeConnect = components["schemas"]["ConnectSandboxV2"];
const safeId = (value: unknown): string => {
  if (typeof value !== "string" || !ID.test(value)) throw e2bDenied();
  return value;
};
const secureVersion = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const [major, minor] = value.split(".").map(Number);
  return Number(major) > 0 || Number(minor) >= 2;
};
const optionalEmptyArray = (value: unknown) =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0);
async function bytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => undefined);
    throw e2bDenied();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw e2bDenied();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function createE2BNativeDevelopmentTransport(
  options: E2BDevelopmentInput,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<SyntheticLabPort & { qualification: E2BDevelopmentQualification }> {
  const input = captureE2BDevelopmentInput(options);
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const environment = () => {
    if (Object.keys(process.env).some((key) => key.startsWith("E2B_"))) throw e2bDenied();
  };
  environment();
  const qualification = await verifyE2BDevelopmentAccess(input, { fetch: request, now });
  const p = input.profile;
  const o = input.operation;
  let createAttempted = false;
  // Never export, journal, print or mount these per-sandbox credentials.
  const credentials = new Map<string, { token: string; diskMiB: number; envdVersion: string }>();
  async function http(
    origin: typeof API | typeof ENVD,
    path: string,
    method: "GET" | "POST" | "DELETE",
    ctx: SyntheticLabContext,
    accepted: number[],
    body?: string | FormData,
    guestId?: string,
    resultKind: "json" | "bytes" | "none" = "json",
    limit = 262144,
  ): Promise<{ status: number; data: unknown; next: string | null }> {
    environment();
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\0#]/.test(path)) throw e2bDenied();
    const url = `${origin}${path}`;
    if (new URL(url).origin !== origin) throw e2bDenied();
    return e2bBounded(ctx, now, async (signal) => {
      let headers: Record<string, string>;
      if (origin === API) {
        if (guestId !== undefined) throw e2bDenied();
        headers = { "X-API-Key": input.apiKey, Accept: "application/json" };
        if (typeof body === "string") headers["Content-Type"] = "application/json";
      } else {
        const id = safeId(guestId);
        const credential = credentials.get(id);
        if (!credential) throw e2bDenied();
        headers = {
          "E2b-Sandbox-Id": id,
          "E2b-Sandbox-Port": "49983",
          "X-Access-Token": credential.token,
          "Accept-Encoding": "identity",
        };
      }
      const response = await request(url, {
        method,
        headers,
        signal,
        redirect: "error",
        ...(body === undefined ? {} : { body }),
      });
      // A redirected or foreign reply must never become ownership or absence.
      if (
        response.redirected ||
        (response.url && response.url !== url) ||
        !accepted.includes(response.status)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw e2bDenied();
      }
      if (response.status === 404 || resultKind === "none") {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, data: null, next: null };
      }
      if (
        resultKind === "json" &&
        origin === API &&
        !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw e2bDenied();
      }
      const value = await bytes(response, limit);
      const data: unknown =
        resultKind === "bytes"
          ? value
          : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
      const next = response.headers.get("x-next-token");
      if (next !== null && !/^[A-Za-z0-9_.~=-]{1,2048}$/.test(next)) throw e2bDenied();
      return { status: response.status, data, next };
    });
  }
  function normalize(value: unknown, expectedId: string): SyntheticLabResource {
    return e2bGuarded(() => {
      const raw = e2bRecord(value);
      const id = safeId(raw.sandboxID);
      if (
        id !== expectedId ||
        raw.templateID !== p.templateId ||
        (raw.state !== "running" && raw.state !== "paused") ||
        !Number.isSafeInteger(raw.cpuCount) ||
        Number(raw.cpuCount) < 1 ||
        !Number.isSafeInteger(raw.memoryMB) ||
        Number(raw.memoryMB) < 1 ||
        !Number.isSafeInteger(raw.diskSizeMB) ||
        Number(raw.diskSizeMB) < 0
      )
        throw e2bDenied();
      const metadata = exactE2BMetadata(raw.metadata, o.metadata);
      const net = e2bRecord(raw.network ?? {});
      const life = e2bRecord(raw.lifecycle ?? {});
      const version = typeof raw.envdVersion === "string" ? raw.envdVersion : "";
      const officialDomain =
        raw.domain === undefined || raw.domain === null || raw.domain === "e2b.app";
      const token =
        typeof raw.envdAccessToken === "string" && TOKEN.test(raw.envdAccessToken)
          ? raw.envdAccessToken
          : "";
      const noRules =
        net.rules === undefined ||
        net.rules === null ||
        Object.keys(e2bRecord(net.rules)).length === 0;
      const outbound =
        raw.allowInternetAccess === false &&
        optionalEmptyArray(net.allowOut) &&
        Array.isArray(net.denyOut) &&
        net.denyOut.length === 1 &&
        net.denyOut[0] === "0.0.0.0/0" &&
        noRules &&
        (net.egressProxy === undefined || net.egressProxy === null) &&
        optionalEmptyArray(raw.volumeMounts);
      const started = typeof raw.startedAt === "string" ? Date.parse(raw.startedAt) : Number.NaN;
      const end = typeof raw.endAt === "string" ? Date.parse(raw.endAt) : Number.NaN;
      if (!Number.isSafeInteger(started) || (raw.state === "running" && !Number.isSafeInteger(end)))
        throw e2bDenied();
      const authenticated =
        officialDomain && net.allowPublicTraffic === false && secureVersion(version) && !!token;
      if (authenticated)
        credentials.set(id, { token, diskMiB: Number(raw.diskSizeMB), envdVersion: version });
      else credentials.delete(id);
      return {
        id,
        metadata: { ...metadata },
        templateId: p.templateId,
        cpu: Number(raw.cpuCount),
        memoryMiB: Number(raw.memoryMB),
        state: raw.state,
        network: { outbound: outbound ? "deny_all" : "unknown", controllerAuth: authenticated },
        lifecycle: {
          onTimeout: life.onTimeout === "kill" ? "kill" : "unknown",
          autoResume: life.autoResume !== false,
          createdAtMs: started,
          endAtMs: raw.state === "paused" ? null : end,
        },
      };
    });
  }
  async function inspect(
    id: string,
    ctx: SyntheticLabContext,
  ): Promise<SyntheticLabResource | null> {
    safeId(id);
    const response = await http(API, `/sandboxes/${id}`, "GET", ctx, [200, 404]);
    if (response.status === 404) {
      credentials.delete(id);
      return null;
    }
    return normalize(response.data, id);
  }
  async function permitted(id: string, state: "running" | "paused", ctx: SyntheticLabContext) {
    if (input.mode !== "allocate" || now() >= o.deadlineMs) throw e2bDenied();
    const current = await inspect(id, ctx);
    const credential = credentials.get(id);
    if (
      !current ||
      current.state !== state ||
      current.cpu !== p.cpu ||
      current.memoryMiB !== p.memoryMiB ||
      current.network.outbound !== "deny_all" ||
      !current.network.controllerAuth ||
      current.lifecycle.onTimeout !== "kill" ||
      current.lifecycle.autoResume ||
      current.lifecycle.createdAtMs < o.startedAtMs ||
      current.lifecycle.createdAtMs > now() ||
      !credential ||
      credential.diskMiB !== p.diskMiB ||
      credential.envdVersion !== qualification.template?.envdVersion ||
      (state === "running" &&
        (current.lifecycle.endAtMs === null ||
          current.lifecycle.endAtMs <= now() ||
          current.lifecycle.endAtMs > o.deadlineMs))
    )
      throw e2bDenied();
    return current;
  }
  function runtimeSeconds() {
    const seconds = Math.floor((o.deadlineMs - now() - REQUEST_MS) / 1000);
    if (seconds < 1) throw e2bDenied();
    return seconds;
  }
  function connectionReply(value: unknown, expectedId?: string): string {
    return e2bGuarded(() => {
      const body = e2bRecord(value);
      const id = safeId(body.sandboxID);
      if (
        (expectedId !== undefined && id !== expectedId) ||
        body.templateID !== p.templateId ||
        (body.domain !== undefined && body.domain !== null && body.domain !== "e2b.app") ||
        !secureVersion(body.envdVersion) ||
        body.envdVersion !== qualification.template?.envdVersion ||
        typeof body.envdAccessToken !== "string" ||
        !TOKEN.test(body.envdAccessToken) ||
        typeof body.trafficAccessToken !== "string" ||
        !TOKEN.test(body.trafficAccessToken)
      )
        throw e2bDenied();
      // Returned credentials are discarded; only a later static owned GET may cache one.
      return id;
    });
  }
  return {
    qualification,
    inspect,
    async create(spec, ctx) {
      e2bGuarded(() => {
        const raw = e2bRecord(spec);
        if (Object.keys(raw).sort().join(",") !== "operation,profile") throw e2bDenied();
        captureE2BDevelopmentInput({
          ...input,
          profile: raw.profile as E2BDevelopmentInput["profile"],
          operation: raw.operation as E2BDevelopmentInput["operation"],
        });
        if (
          JSON.stringify(raw.profile) !== JSON.stringify(p) ||
          JSON.stringify(raw.operation) !== JSON.stringify(o)
        )
          throw e2bDenied();
      });
      if (
        input.mode !== "allocate" ||
        p.planSequence !== 60 ||
        createAttempted ||
        now() >= o.deadlineMs
      )
        throw e2bDenied();
      createAttempted = true;
      const body: NativeCreate = {
        templateID: `${p.templateId}:${p.templateBuildId}`,
        timeout: runtimeSeconds(),
        autoPause: false,
        autoResume: { enabled: false },
        allow_internet_access: false,
        network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
        metadata: { ...o.metadata },
        envVars: {},
      };
      const reply = await http(API, "/v2/sandboxes", "POST", ctx, [201], JSON.stringify(body));
      const id = connectionReply(reply.data);
      const observed = await inspect(id, ctx);
      if (!observed) throw e2bFailed();
      return observed;
    },
    async getByOperation(operation, ctx) {
      e2bGuarded(() => {
        captureE2BDevelopmentInput({ ...input, operation });
        if (JSON.stringify(operation) !== JSON.stringify(o)) throw e2bDenied();
      });
      const resources: SyntheticLabResource[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let next: string | null = null;
      for (let page = 0; page < 16; page++) {
        const metadata = new URLSearchParams(o.metadata).toString();
        const query = new URLSearchParams({
          metadata,
          state: "running,paused",
          limit: "100",
          ...(next ? { nextToken: next } : {}),
        });
        const reply = await http(API, `/v2/sandboxes?${query}`, "GET", ctx, [200]);
        if (!Array.isArray(reply.data) || reply.data.length > 100) throw e2bDenied();
        for (const entry of reply.data) {
          const id = e2bGuarded(() => {
            const raw = e2bRecord(entry);
            exactE2BMetadata(raw.metadata, o.metadata);
            return safeId(raw.sandboxID);
          });
          if (ids.has(id)) throw e2bDenied();
          ids.add(id);
          const owned = await inspect(id, ctx);
          if (!owned) throw e2bFailed();
          resources.push(owned);
        }
        next = reply.next;
        if (!next) return { resources, complete: true };
        if (cursors.has(next)) throw e2bDenied();
        cursors.add(next);
      }
      throw e2bDenied();
    },
    async writeMarker(id, path, value, ctx) {
      if (path !== o.markerPath || value !== o.markerValue) throw e2bDenied();
      await permitted(id, "running", ctx);
      const form = new FormData();
      form.append(
        "file",
        new Blob([o.markerValue], { type: "application/octet-stream" }),
        o.markerPath,
      );
      const query = new URLSearchParams({ path: o.markerPath });
      const reply = await http(ENVD, `/files?${query}`, "POST", ctx, [200], form, id, "json", 8192);
      if (!Array.isArray(reply.data) || reply.data.length !== 1) throw e2bDenied();
      e2bGuarded(() => {
        const entry = e2bRecord((reply.data as unknown[])[0]);
        if (entry.path !== o.markerPath || entry.type !== "file") throw e2bDenied();
      });
    },
    async readMarker(id, path, ctx) {
      if (path !== o.markerPath) throw e2bDenied();
      await permitted(id, "running", ctx);
      const query = new URLSearchParams({ path: o.markerPath });
      const expected = new TextEncoder().encode(o.markerValue);
      const reply = await http(
        ENVD,
        `/files?${query}`,
        "GET",
        ctx,
        [200],
        undefined,
        id,
        "bytes",
        expected.byteLength,
      );
      const actual = reply.data;
      if (
        !(actual instanceof Uint8Array) ||
        actual.byteLength !== expected.byteLength ||
        actual.some((byte, index) => byte !== expected[index])
      )
        throw e2bDenied();
      return o.markerValue;
    },
    async pause(id, ctx) {
      await permitted(id, "running", ctx);
      await http(
        API,
        `/sandboxes/${id}/pause`,
        "POST",
        ctx,
        [204, 409],
        JSON.stringify({ memory: true }),
        undefined,
        "none",
      );
      const observed = await inspect(id, ctx);
      if (!observed || observed.state !== "paused") throw e2bFailed();
      credentials.delete(id);
    },
    async restore(id, ctx) {
      await permitted(id, "paused", ctx);
      const body: NativeConnect = { timeout: runtimeSeconds(), memory: true };
      const reply = await http(
        API,
        `/v2/sandboxes/${id}/connect`,
        "POST",
        ctx,
        [200, 201],
        JSON.stringify(body),
      );
      connectionReply(reply.data, id);
      await permitted(id, "running", ctx);
    },
    async kill(id, ctx) {
      const owned = await inspect(id, ctx);
      if (!owned) return;
      await http(API, `/sandboxes/${id}`, "DELETE", ctx, [204, 404], undefined, undefined, "none");
      if ((await inspect(id, ctx)) !== null) throw e2bFailed();
    },
  };
}
