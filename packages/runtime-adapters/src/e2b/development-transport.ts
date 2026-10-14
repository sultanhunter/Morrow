import type { Sandbox as OfficialSandbox, SandboxInfo } from "e2b";
import {
  compileSyntheticLabProfile,
  prepareSyntheticLabOperation,
} from "../../../infrastructure/src/synthetic-runtime-lab.js";
import type {
  SyntheticLabContext,
  SyntheticLabOperation,
  SyntheticLabPort,
  SyntheticLabProfile,
  SyntheticLabResource,
} from "../../../infrastructure/src/synthetic-runtime-lab.js";

const API = "https://api.e2b.app";
const DOMAIN = "e2b.app";
const REQUEST_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeErrors = new WeakSet<Error>();
function fixedError(code: string) {
  const error = new Error(code);
  safeErrors.add(error);
  return error;
}
export const e2bDenied = () => fixedError("SYNTHETIC_LAB_E2B_TRANSPORT_DENIED");
export const e2bFailed = () => fixedError("SYNTHETIC_LAB_E2B_PROVIDER_FAILED");
type Mode = "allocate" | "cleanup";
type Sdk = typeof OfficialSandbox;
type Guest = Pick<OfficialSandbox, "sandboxId" | "sandboxDomain" | "trafficAccessToken" | "files">;
type NativeFetch = typeof fetch;
export type E2BDevelopmentInput = {
  apiKey: string;
  profile: SyntheticLabProfile;
  operation: SyntheticLabOperation;
  mode: Mode;
};
export interface E2BDevelopmentQualification {
  projectId: string;
  binding: "authenticated_project_metrics";
  verifiedAtMs: number;
  template: {
    templateId: string;
    templateBuildId: string;
    cpu: number;
    memoryMiB: number;
    diskMiB: number;
    envdVersion: string;
  } | null;
}

// Provider values and caller options are data, never executable getters.
export function e2bRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw e2bDenied();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw e2bDenied();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw e2bDenied();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw e2bDenied();
    output[key] = descriptor.value;
  }
  return output;
}
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  const output = e2bRecord(value);
  if (Object.keys(output).sort().join("\0") !== [...keys].sort().join("\0")) throw e2bDenied();
  return output;
}
export function exactE2BMetadata(
  value: unknown,
  expected: Record<string, string>,
): Record<string, string> {
  const metadata = closed(value, Object.keys(expected));
  for (const [key, entry] of Object.entries(expected))
    if (metadata[key] !== entry) throw e2bDenied();
  return Object.freeze({ ...expected });
}
export function e2bGuarded<T>(body: () => T): T {
  try {
    return body();
  } catch {
    throw e2bDenied();
  }
}
export function captureE2BDevelopmentInput(
  options: E2BDevelopmentInput,
): Readonly<E2BDevelopmentInput> {
  return e2bGuarded(() => {
    const input = closed(options, ["apiKey", "profile", "operation", "mode"]);
    const p = compileSyntheticLabProfile(input.profile).profile;
    if (p.providerId !== "e2b" || p.memoryMiB < 128) throw e2bDenied();
    const o = closed(input.operation, [
      "operationId",
      "profileSha256",
      "sourceSha256",
      "startedAtMs",
      "deadlineMs",
      "metadata",
      "markerPath",
      "markerValue",
    ]);
    if (
      typeof o.operationId !== "string" ||
      !UUID.test(o.operationId) ||
      typeof o.profileSha256 !== "string" ||
      !DIGEST.test(o.profileSha256) ||
      typeof o.sourceSha256 !== "string" ||
      !DIGEST.test(o.sourceSha256) ||
      !Number.isSafeInteger(o.startedAtMs) ||
      !Number.isSafeInteger(o.deadlineMs) ||
      Number(o.deadlineMs) - Number(o.startedAtMs) !== 600_000 ||
      o.markerPath !== `/tmp/morrow-synthetic-${o.operationId}.txt` ||
      o.markerValue !== `MORROW_SYNTHETIC_PERSISTENCE_V1:${o.operationId}\n`
    )
      throw e2bDenied();
    const expected = prepareSyntheticLabOperation(
      p,
      o.operationId,
      Number(o.startedAtMs),
      o.sourceSha256,
    );
    if (o.profileSha256 !== expected.profileSha256) throw e2bDenied();
    const metadata = exactE2BMetadata(o.metadata, {
      morrowLab: "P04.T01h",
      morrowOperation: o.operationId,
      morrowProfile: o.profileSha256,
      morrowSource: o.sourceSha256,
      morrowStarted: String(o.startedAtMs),
      morrowDeadline: String(o.deadlineMs),
    });
    if (input.mode === "allocate" && p.planSequence !== 59) throw e2bDenied();
    if (
      typeof input.apiKey !== "string" ||
      !/^e2b_[A-Za-z0-9_-]{16,508}$/.test(input.apiKey) ||
      (input.mode !== "allocate" && input.mode !== "cleanup")
    )
      throw e2bDenied();
    return Object.freeze({
      apiKey: input.apiKey,
      mode: input.mode,
      profile: Object.freeze({ ...p }) as unknown as SyntheticLabProfile,
      operation: Object.freeze({ ...o, metadata }) as unknown as SyntheticLabOperation,
    });
  });
}
export async function e2bBounded<T>(
  context: SyntheticLabContext,
  now: () => number,
  body: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
): Promise<T> {
  const remaining = Math.min(REQUEST_MS, context.deadlineMs - now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw fixedError("SYNTHETIC_LAB_DEADLINE");
  if (context.signal.aborted) throw fixedError("SYNTHETIC_LAB_CANCELLED");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      const rejectDeadline = () => {
        controller.abort();
        reject(fixedError("SYNTHETIC_LAB_DEADLINE"));
      };
      timer = setTimeout(rejectDeadline, remaining);
      cancel = () => {
        controller.abort();
        reject(fixedError("SYNTHETIC_LAB_CANCELLED"));
      };
      context.signal.addEventListener("abort", cancel, { once: true });
    });
    const work = Promise.resolve().then(() =>
      body(controller.signal, Math.max(1, Math.floor(remaining))),
    );
    return await Promise.race([work, timeout]);
  } catch (error) {
    // WeakSet identity avoids inspecting hostile provider error properties.
    if (typeof error === "object" && error !== null && safeErrors.has(error as Error)) throw error;
    throw e2bFailed();
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) context.signal.removeEventListener("abort", cancel);
  }
}
async function jsonGet(
  path: string,
  apiKey: string,
  context: SyntheticLabContext,
  now: () => number,
  request: NativeFetch,
  limit = 262_144,
): Promise<{ value: unknown; next: string | null; status: number }> {
  return e2bBounded(context, now, async (signal) => {
    const response = await request(`${API}${path}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    if (response.redirected || (response.url && response.url !== `${API}${path}`)) {
      await response.body?.cancel().catch(() => undefined);
      throw e2bDenied();
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { value: null, next: null, status: 404 };
    }
    if (
      response.status !== 200 ||
      !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw e2bDenied();
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body?.cancel().catch(() => undefined);
      throw e2bDenied();
    }
    if (!response.body) throw e2bDenied();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw e2bDenied();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    const next = response.headers.get("x-next-token");
    if (next !== null && !/^[A-Za-z0-9_.~=-]{1,2048}$/.test(next)) throw e2bDenied();
    return { value, next, status: 200 };
  });
}
// Read-only bootstrap is deliberately separate from the fully bound allocation
// profile. It discovers native values rather than guessing a template quote.
export async function discoverE2BDevelopmentOwnedTemplates(
  options: { apiKey: string; projectId: string },
  dependencies: { fetch?: NativeFetch; now?: () => number } = {},
) {
  const input = e2bGuarded(() => {
    const raw = closed(options, ["apiKey", "projectId"]);
    if (
      typeof raw.apiKey !== "string" ||
      !/^e2b_[A-Za-z0-9_-]{16,508}$/.test(raw.apiKey) ||
      typeof raw.projectId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        raw.projectId,
      )
    )
      throw e2bDenied();
    return Object.freeze({ apiKey: raw.apiKey, projectId: raw.projectId });
  });
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const context = { deadlineMs: now() + 120000, signal: new AbortController().signal };
  const second = Math.floor(now() / 1000);
  const metrics = await jsonGet(
    `/teams/${input.projectId}/metrics?start=${second - 60}&end=${second}`,
    input.apiKey,
    context,
    now,
    request,
    65536,
  );
  if (metrics.status !== 200 || !Array.isArray(metrics.value)) throw e2bDenied();
  const builds: Array<{
    templateId: string;
    templateBuildId: string;
    cpu: number;
    memoryMiB: number;
    diskMiB: number;
    envdVersion: string;
  }> = [];
  const templateIds = new Set<string>();
  const catalogueCursors = new Set<string>();
  let next: string | null = null;
  let catalogueComplete = false;
  const validBuildId = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  for (let page = 0; page < 8; page++) {
    const query = new URLSearchParams({
      teamID: input.projectId,
      limit: "100",
      ...(next ? { nextToken: next } : {}),
    });
    const response = await jsonGet(`/v2/templates?${query}`, input.apiKey, context, now, request);
    if (response.status !== 200 || !Array.isArray(response.value) || response.value.length > 100)
      throw e2bDenied();
    for (const entry of response.value) {
      const listed = e2bGuarded(() => e2bRecord(entry));
      if (
        typeof listed.templateID !== "string" ||
        !ID.test(listed.templateID) ||
        templateIds.has(listed.templateID)
      )
        throw e2bDenied();
      const templateId = listed.templateID;
      templateIds.add(templateId);
      if (listed.buildStatus !== "ready") continue;
      if (!validBuildId(listed.buildID)) throw e2bDenied();
      const buildCursors = new Set<string>();
      let buildNext: string | null = null;
      let matched = false;
      let buildsComplete = false;
      for (let buildPage = 0; buildPage < 8; buildPage++) {
        const buildQuery = new URLSearchParams({
          limit: "100",
          ...(buildNext ? { nextToken: buildNext } : {}),
        });
        const result = await jsonGet(
          `/templates/${templateId}?${buildQuery}`,
          input.apiKey,
          context,
          now,
          request,
        );
        const body = e2bGuarded(() => e2bRecord(result.value));
        if (
          result.status !== 200 ||
          body.templateID !== templateId ||
          !Array.isArray(body.builds) ||
          body.builds.length > 100
        )
          throw e2bDenied();
        for (const value of body.builds) {
          const build = e2bGuarded(() => e2bRecord(value));
          if (build.buildID !== listed.buildID) continue;
          if (
            matched ||
            build.status !== "ready" ||
            !Number.isSafeInteger(build.cpuCount) ||
            !Number.isSafeInteger(build.memoryMB) ||
            !Number.isSafeInteger(build.diskSizeMB) ||
            build.cpuCount !== listed.cpuCount ||
            build.memoryMB !== listed.memoryMB ||
            build.diskSizeMB !== listed.diskSizeMB ||
            build.envdVersion !== listed.envdVersion ||
            typeof build.envdVersion !== "string" ||
            !/^\d+\.\d+\.\d+$/.test(build.envdVersion)
          )
            throw e2bDenied();
          matched = true;
          const [major, minor] = build.envdVersion.split(".").map(Number);
          if (
            Number(build.cpuCount) < 1 ||
            Number(build.cpuCount) > 2 ||
            Number(build.memoryMB) < 128 ||
            Number(build.memoryMB) > 4096 ||
            Number(build.diskSizeMB) < 1 ||
            Number(build.diskSizeMB) > 10240 ||
            (Number(major) === 0 && Number(minor) < 2)
          )
            continue;
          builds.push(
            Object.freeze({
              templateId,
              templateBuildId: listed.buildID,
              cpu: Number(build.cpuCount),
              memoryMiB: Number(build.memoryMB),
              diskMiB: Number(build.diskSizeMB),
              envdVersion: build.envdVersion,
            }),
          );
        }
        buildNext = result.next;
        if (!buildNext) {
          buildsComplete = true;
          break;
        }
        if (buildCursors.has(buildNext)) throw e2bDenied();
        buildCursors.add(buildNext);
      }
      if (!buildsComplete || !matched) throw e2bDenied();
    }
    next = response.next;
    if (!next) {
      catalogueComplete = true;
      break;
    }
    if (catalogueCursors.has(next)) throw e2bDenied();
    catalogueCursors.add(next);
  }
  if (!catalogueComplete) throw e2bDenied();
  return Object.freeze({
    projectId: input.projectId,
    binding: "authenticated_project_metrics" as const,
    observedAtMs: now(),
    readOnly: true as const,
    completeTemplateCatalogue: true as const,
    runtimeProfileQualified: false as const,
    builds: Object.freeze(builds),
  });
}

export async function verifyE2BDevelopmentAccess(
  options: E2BDevelopmentInput,
  dependencies: { fetch?: NativeFetch; now?: () => number } = {},
): Promise<E2BDevelopmentQualification> {
  const input = captureE2BDevelopmentInput(options);
  const now = dependencies.now ?? Date.now;
  const request = dependencies.fetch ?? fetch;
  const context = { deadlineMs: now() + 120_000, signal: new AbortController().signal };
  const seconds = Math.floor(now() / 1000);
  const metrics = await jsonGet(
    `/teams/${input.profile.projectId}/metrics?start=${seconds - 60}&end=${seconds}`,
    input.apiKey,
    context,
    now,
    request,
    65_536,
  );
  if (metrics.status !== 200 || !Array.isArray(metrics.value)) throw e2bDenied();
  let template: E2BDevelopmentQualification["template"] = null;
  if (input.mode === "allocate") {
    const tokens = new Set<string>();
    let next: string | null = null;
    let found = false;
    for (let page = 0; page < 8; page++) {
      const query = new URLSearchParams({ limit: "100", ...(next ? { nextToken: next } : {}) });
      const result = await jsonGet(
        `/templates/${input.profile.templateId}?${query}`,
        input.apiKey,
        context,
        now,
        request,
      );
      const body = e2bGuarded(() => e2bRecord(result.value));
      if (
        result.status !== 200 ||
        body.templateID !== input.profile.templateId ||
        !Array.isArray(body.builds) ||
        body.builds.length > 100
      )
        throw e2bDenied();
      for (const raw of body.builds) {
        const build = e2bGuarded(() => e2bRecord(raw));
        if (build.buildID !== input.profile.templateBuildId) continue;
        if (
          found ||
          build.status !== "ready" ||
          build.cpuCount !== input.profile.cpu ||
          build.memoryMB !== input.profile.memoryMiB ||
          build.diskSizeMB !== input.profile.diskMiB ||
          typeof build.envdVersion !== "string" ||
          !/^\d+\.\d+\.\d+$/.test(build.envdVersion) ||
          (Number(build.envdVersion.split(".")[0]) === 0 &&
            Number(build.envdVersion.split(".")[1]) < 2)
        )
          throw e2bDenied();
        found = true;
        template = Object.freeze({
          templateId: input.profile.templateId,
          templateBuildId: input.profile.templateBuildId,
          cpu: input.profile.cpu,
          memoryMiB: input.profile.memoryMiB,
          diskMiB: input.profile.diskMiB,
          envdVersion: build.envdVersion,
        });
      }
      next = result.next;
      if (!next) break;
      if (tokens.has(next)) throw e2bDenied();
      tokens.add(next);
      if (page === 7) throw e2bDenied();
    }
    if (!template) throw e2bDenied();
  }
  return Object.freeze({
    projectId: input.profile.projectId,
    binding: "authenticated_project_metrics",
    verifiedAtMs: now(),
    template,
  });
}

// The supported SDK subclass factory uses `new this(...)` and `this.kill(...)`.
// Suppress its version-error compensation: only the neutral port may delete a
// resource after immutable ownership readback. This class is allocation-only.
export function createGuardedE2BAllocationSandbox(Sandbox: Sdk): Sdk {
  return class AllocationSandbox extends Sandbox {
    static override async kill(..._args: Parameters<Sdk["kill"]>): Promise<boolean> {
      throw e2bDenied();
    }
  };
}

export function createE2BDevelopmentTransport(
  options: E2BDevelopmentInput & {
    Sandbox: Sdk;
    AllocationSandbox?: Sdk;
    SandboxNotFoundError: new (...args: never[]) => Error;
    qualification: E2BDevelopmentQualification;
    inspectControllerAuth: (id: string, context: SyntheticLabContext) => Promise<boolean>;
    now?: () => number;
  },
): SyntheticLabPort & { qualification: E2BDevelopmentQualification } {
  const values = e2bGuarded(() => e2bRecord(options));
  const expectedKeys = [
    "apiKey",
    "profile",
    "operation",
    "mode",
    "Sandbox",
    "SandboxNotFoundError",
    ...(values.AllocationSandbox === undefined ? [] : ["AllocationSandbox"]),
    "qualification",
    "inspectControllerAuth",
    ...(values.now === undefined ? [] : ["now"]),
  ];
  e2bGuarded(() => closed(options, expectedKeys));
  const sdk = values.Sandbox as Sdk;
  const allocation = (values.AllocationSandbox ?? sdk) as Sdk;
  const SandboxNotFoundError = values.SandboxNotFoundError as new (...args: never[]) => Error;
  const inspectControllerAuth = values.inspectControllerAuth as (
    id: string,
    context: SyntheticLabContext,
  ) => Promise<boolean>;
  const now = (values.now ?? Date.now) as () => number;
  const raw = {
    apiKey: values.apiKey,
    profile: values.profile,
    operation: values.operation,
    mode: values.mode,
  } as E2BDevelopmentInput;
  const input = captureE2BDevelopmentInput(raw);
  const p = input.profile;
  const o = input.operation;
  const qualification = e2bGuarded(() => {
    const q = closed(values.qualification, ["projectId", "binding", "verifiedAtMs", "template"]);
    if (
      q.projectId !== p.projectId ||
      q.binding !== "authenticated_project_metrics" ||
      !Number.isSafeInteger(q.verifiedAtMs) ||
      Number(q.verifiedAtMs) > now() ||
      now() - Number(q.verifiedAtMs) > 1_800_000
    )
      throw e2bDenied();
    let template: E2BDevelopmentQualification["template"] = null;
    if (input.mode === "allocate") {
      const t = closed(q.template, [
        "templateId",
        "templateBuildId",
        "cpu",
        "memoryMiB",
        "diskMiB",
        "envdVersion",
      ]);
      if (
        t.templateId !== p.templateId ||
        t.templateBuildId !== p.templateBuildId ||
        t.cpu !== p.cpu ||
        t.memoryMiB !== p.memoryMiB ||
        t.diskMiB !== p.diskMiB ||
        typeof t.envdVersion !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(t.envdVersion)
      )
        throw e2bDenied();
      template = Object.freeze({ ...t }) as unknown as NonNullable<
        E2BDevelopmentQualification["template"]
      >;
    } else if (q.template !== null) throw e2bDenied();
    return Object.freeze({
      projectId: p.projectId,
      binding: "authenticated_project_metrics",
      verifiedAtMs: Number(q.verifiedAtMs),
      template,
    } as const);
  });
  const connection = Object.freeze({
    apiKey: input.apiKey,
    apiUrl: API,
    domain: DOMAIN,
    debug: false,
    retries: 0,
    httpVersion: "1.1" as const,
    apiHeaders: Object.freeze({}),
  });
  const guests = new Map<string, Guest>();
  let createAttempted = false;
  const api = <T>(
    ctx: SyntheticLabContext,
    invoke: (
      opts: typeof connection & { signal: AbortSignal; requestTimeoutMs: number },
    ) => Promise<T>,
  ) =>
    e2bBounded(ctx, now, (signal, requestTimeoutMs) =>
      invoke({ ...connection, signal, requestTimeoutMs }),
    );
  const absent = (error: unknown) => {
    try {
      return error instanceof SandboxNotFoundError;
    } catch {
      return false;
    }
  };
  function resource(info: SandboxInfo, auth: boolean, expectedId?: string): SyntheticLabResource {
    return e2bGuarded(() => {
      const data = e2bRecord(info);
      if (
        typeof data.sandboxId !== "string" ||
        !ID.test(data.sandboxId) ||
        (expectedId !== undefined && data.sandboxId !== expectedId) ||
        data.templateId !== p.templateId ||
        (data.state !== "running" && data.state !== "paused") ||
        !Number.isSafeInteger(data.cpuCount) ||
        Number(data.cpuCount) < 1 ||
        !Number.isSafeInteger(data.memoryMB) ||
        Number(data.memoryMB) < 1
      )
        throw e2bDenied();
      const metadata = exactE2BMetadata(data.metadata, o.metadata);
      const network = e2bRecord(data.network ?? {});
      const lifecycle = e2bRecord(data.lifecycle ?? {});
      const mountsSafe = Array.isArray(data.volumeMounts) && data.volumeMounts.length === 0;
      const noRules =
        network.rules === undefined ||
        network.rules === null ||
        Object.keys(e2bRecord(network.rules)).length === 0;
      const outbound =
        data.allowInternetAccess === false &&
        Array.isArray(network.allowOut) &&
        network.allowOut.length === 0 &&
        Array.isArray(network.denyOut) &&
        network.denyOut.length === 1 &&
        network.denyOut[0] === "0.0.0.0/0" &&
        noRules &&
        network.egressProxy === undefined &&
        mountsSafe;
      const privateIngress =
        network.allowPublicTraffic === false &&
        (data.sandboxDomain === undefined || data.sandboxDomain === DOMAIN);
      const started = data.startedAt instanceof Date ? data.startedAt.getTime() : Number.NaN;
      const end = data.endAt instanceof Date ? data.endAt.getTime() : Number.NaN;
      if (
        !Number.isSafeInteger(started) ||
        (data.state === "running" && !Number.isSafeInteger(end))
      )
        throw e2bDenied();
      const versionMatches =
        input.mode === "cleanup" || data.envdVersion === qualification.template?.envdVersion;
      return {
        id: data.sandboxId,
        metadata: { ...metadata },
        templateId: p.templateId,
        cpu: Number(data.cpuCount),
        memoryMiB: Number(data.memoryMB),
        state: data.state,
        network: {
          outbound: outbound ? "deny_all" : "unknown",
          controllerAuth: auth && privateIngress && versionMatches,
        },
        lifecycle: {
          onTimeout: lifecycle.onTimeout === "kill" ? "kill" : "unknown",
          autoResume: lifecycle.autoResume !== false,
          createdAtMs: started,
          endAtMs: data.state === "paused" ? null : end,
        },
      };
    });
  }
  async function inspect(
    id: string,
    ctx: SyntheticLabContext,
  ): Promise<SyntheticLabResource | null> {
    if (typeof id !== "string" || !ID.test(id)) throw e2bDenied();
    const info = await api(ctx, async (opts) => {
      try {
        return await sdk.getInfo(id, opts);
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    });
    if (info === null) {
      guests.delete(id);
      return null;
    }
    // Verify identity before the extra auth read, avoiding calls for foreign handles.
    resource(info, false, id);
    const auth = await e2bBounded(ctx, now, () => inspectControllerAuth(id, ctx));
    if (auth !== true && auth !== false) throw e2bDenied();
    return resource(info, auth, id);
  }
  async function permitted(id: string, ctx: SyntheticLabContext, state: "running" | "paused") {
    if (input.mode !== "allocate" || now() >= o.deadlineMs) throw e2bDenied();
    const current = await inspect(id, ctx);
    if (
      !current ||
      current.state !== state ||
      current.cpu !== p.cpu ||
      current.memoryMiB !== p.memoryMiB ||
      current.network.outbound !== "deny_all" ||
      !current.network.controllerAuth ||
      current.lifecycle.onTimeout !== "kill" ||
      current.lifecycle.autoResume ||
      (state === "running" &&
        (current.lifecycle.endAtMs === null || current.lifecycle.endAtMs > o.deadlineMs))
    )
      throw e2bDenied();
    return current;
  }
  function retainGuest(instance: Guest, expectedId?: string): string {
    return e2bGuarded(() => {
      const own = (key: string) => {
        const descriptor = Object.getOwnPropertyDescriptor(instance, key);
        if (!descriptor || !("value" in descriptor)) throw e2bDenied();
        return descriptor.value as unknown;
      };
      const id = own("sandboxId");
      const domain = own("sandboxDomain");
      const trafficToken = own("trafficAccessToken");
      if (
        typeof id !== "string" ||
        !ID.test(id) ||
        (expectedId !== undefined && id !== expectedId) ||
        domain !== DOMAIN ||
        typeof trafficToken !== "string" ||
        !trafficToken
      )
        throw e2bDenied();
      guests.set(id, instance);
      return id;
    });
  }
  function guest(id: string): Guest {
    return e2bGuarded(() => {
      const result = guests.get(id);
      if (
        !result ||
        result.sandboxId !== id ||
        result.sandboxDomain !== DOMAIN ||
        typeof result.trafficAccessToken !== "string" ||
        !result.trafficAccessToken
      )
        throw e2bDenied();
      return result;
    });
  }
  function remainingRuntimeMs() {
    const remaining = Math.floor((o.deadlineMs - now() - REQUEST_MS) / 1000) * 1000;
    if (remaining < 1000) throw e2bDenied();
    return remaining;
  }
  return {
    qualification,
    async create(spec, ctx) {
      e2bGuarded(() => {
        const candidate = closed(spec, ["profile", "operation"]);
        captureE2BDevelopmentInput({
          apiKey: input.apiKey,
          profile: candidate.profile as SyntheticLabProfile,
          operation: candidate.operation as SyntheticLabOperation,
          mode: input.mode,
        });
      });
      if (
        input.mode !== "allocate" ||
        createAttempted ||
        JSON.stringify(spec.profile) !== JSON.stringify(p) ||
        JSON.stringify(spec.operation) !== JSON.stringify(o) ||
        qualification.projectId !== p.projectId ||
        qualification.template?.templateBuildId !== p.templateBuildId
      )
        throw e2bDenied();
      if (now() >= o.deadlineMs) throw e2bDenied();
      createAttempted = true;
      const instance = await api(ctx, (opts) =>
        allocation.create(`${p.templateId}:${p.templateBuildId}`, {
          ...opts,
          timeoutMs: remainingRuntimeMs(),
          metadata: { ...o.metadata },
          envs: {},
          allowInternetAccess: false,
          lifecycle: { onTimeout: "kill", autoResume: false },
          network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
        }),
      );
      const id = retainGuest(instance);
      const observed = await inspect(id, ctx);
      if (!observed) throw e2bFailed();
      return observed;
    },
    async getByOperation(operation, ctx) {
      e2bGuarded(() => captureE2BDevelopmentInput({ ...input, operation }));
      if (JSON.stringify(operation) !== JSON.stringify(o)) throw e2bDenied();
      const paginator = e2bGuarded(() =>
        sdk.list({
          ...connection,
          query: { state: ["running", "paused"], metadata: { ...o.metadata } },
          limit: 100,
        }),
      );
      const results: SyntheticLabResource[] = [];
      const ids = new Set<string>();
      const tokens = new Set<string>();
      for (let page = 0; page < 16; page++) {
        const items = await api(ctx, (opts) => paginator.nextItems(opts));
        if (!Array.isArray(items) || items.length > 100) throw e2bDenied();
        for (const item of items) {
          const id = e2bGuarded(() => {
            const data = e2bRecord(item);
            exactE2BMetadata(data.metadata, o.metadata);
            if (
              typeof data.sandboxId !== "string" ||
              !ID.test(data.sandboxId) ||
              ids.has(data.sandboxId)
            )
              throw e2bDenied();
            return data.sandboxId;
          });
          ids.add(id);
          const observed = await inspect(id, ctx);
          if (!observed) throw e2bFailed();
          results.push(observed);
        }
        const more = e2bGuarded(() => paginator.hasNext);
        if (more === false) return { resources: results, complete: true };
        if (more !== true) throw e2bDenied();
        const token = e2bGuarded(() => paginator.nextToken);
        if (typeof token !== "string" || token.length > 2048 || !token || tokens.has(token))
          throw e2bDenied();
        tokens.add(token);
      }
      throw e2bDenied();
    },
    inspect,
    async writeMarker(id, path, value, ctx) {
      if (path !== o.markerPath || value !== o.markerValue) throw e2bDenied();
      await permitted(id, ctx, "running");
      await api(ctx, (opts) =>
        guest(id).files.write(path, value, {
          signal: opts.signal,
          requestTimeoutMs: opts.requestTimeoutMs,
        }),
      );
    },
    async readMarker(id, path, ctx) {
      if (path !== o.markerPath) throw e2bDenied();
      await permitted(id, ctx, "running");
      const value = await api(ctx, (opts) =>
        guest(id).files.read(path, {
          format: "text",
          signal: opts.signal,
          requestTimeoutMs: opts.requestTimeoutMs,
        }),
      );
      if (value !== o.markerValue) throw e2bDenied();
      return o.markerValue;
    },
    async pause(id, ctx) {
      await permitted(id, ctx, "running");
      await api(ctx, (opts) => sdk.pause(id, { ...opts, mode: "full" }));
      const observed = await inspect(id, ctx);
      if (!observed || observed.state !== "paused") throw e2bFailed();
      guests.delete(id);
    },
    async restore(id, ctx) {
      await permitted(id, ctx, "paused");
      const instance = await api(ctx, (opts) =>
        sdk.connect(id, { ...opts, timeoutMs: remainingRuntimeMs(), onResume: "restore" }),
      );
      retainGuest(instance, id);
      await permitted(id, ctx, "running");
    },
    async kill(id, ctx) {
      const current = await inspect(id, ctx);
      if (!current) return;
      await api(ctx, (opts) => sdk.kill(id, opts));
      if ((await inspect(id, ctx)) !== null) throw e2bFailed();
    },
  };
}

export async function verifyE2BDevelopmentControllerAccess(
  options: E2BDevelopmentInput,
  id: string,
  ctx: SyntheticLabContext,
  dependencies: { fetch?: NativeFetch; now?: () => number } = {},
): Promise<boolean> {
  const input = captureE2BDevelopmentInput(options);
  if (typeof id !== "string" || !ID.test(id)) throw e2bDenied();
  const result = await jsonGet(
    `/sandboxes/${id}`,
    input.apiKey,
    ctx,
    dependencies.now ?? Date.now,
    dependencies.fetch ?? fetch,
  );
  if (result.status !== 200) throw e2bDenied();
  return e2bGuarded(() => {
    const body = e2bRecord(result.value);
    if (body.sandboxID !== id || body.templateID !== input.profile.templateId) throw e2bDenied();
    exactE2BMetadata(body.metadata, input.operation.metadata);
    const network = e2bRecord(body.network ?? {});
    const lifecycle = e2bRecord(body.lifecycle ?? {});
    return (
      typeof body.envdAccessToken === "string" &&
      body.envdAccessToken.length > 0 &&
      body.allowInternetAccess === false &&
      body.cpuCount === input.profile.cpu &&
      body.memoryMB === input.profile.memoryMiB &&
      network.allowPublicTraffic === false &&
      Array.isArray(network.allowOut) &&
      network.allowOut.length === 0 &&
      Array.isArray(network.denyOut) &&
      network.denyOut.length === 1 &&
      network.denyOut[0] === "0.0.0.0/0" &&
      (network.rules === undefined ||
        network.rules === null ||
        Object.keys(e2bRecord(network.rules)).length === 0) &&
      (network.egressProxy === undefined || network.egressProxy === null) &&
      lifecycle.onTimeout === "kill" &&
      lifecycle.autoResume === false &&
      (body.domain === undefined || body.domain === null || body.domain === DOMAIN) &&
      (body.volumeMounts === undefined ||
        (Array.isArray(body.volumeMounts) && body.volumeMounts.length === 0))
    );
  });
}

export async function createOfficialE2BDevelopmentTransport(
  options: E2BDevelopmentInput,
): Promise<SyntheticLabPort & { qualification: E2BDevelopmentQualification }> {
  const input = captureE2BDevelopmentInput(options);
  if (Object.keys(process.env).some((name) => name.startsWith("E2B_"))) throw e2bDenied();
  // High-level SDK requests follow redirects; they are reference-only. Native
  // execution owns every credential-bearing request and enforces its origin.
  const native = await import("./development-native.js");
  return native.createE2BNativeDevelopmentTransport(input);
}
