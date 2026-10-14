import { createHash } from "node:crypto";

const INDEX_MEDIA = "application/vnd.oci.image.index.v1+json";
const MANIFEST_MEDIA = "application/vnd.oci.image.manifest.v1+json";
const INDEX_DIGEST = "sha256:4a369f01a820fe5e65f53c2c5727a78899daf86f0541b721097f289559c8b73f";
const AMD64_DIGEST = "sha256:197ad15124a51884aea5a629b96045cd8300bdbbb6df648647004fad99fc59ec";
const AUTH_URL =
  "https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Ae2bdev%2Fbase%3Apull";
const REGISTRY_ORIGIN = "https://registry-1.docker.io";
const MAX_BYTES = 65536;
const MAX_WALL_MS = 45000;
const REQUEST_MS = 15000;
const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const failures = new WeakSet<object>();

export const E2B_OWNED_BASE_IMAGE = Object.freeze({
  repository: "e2bdev/base",
  image: `e2bdev/base@${INDEX_DIGEST}`,
  indexDigest: INDEX_DIGEST,
  amd64Digest: AMD64_DIGEST,
  authUrl: AUTH_URL,
  registryOrigin: REGISTRY_ORIGIN,
  maximumResponseBytes: MAX_BYTES,
  maximumWallMs: MAX_WALL_MS,
});

export type E2BOwnedImageRequest = Readonly<{
  schemaVersion: 1;
  task: "P04.T01h";
  planSequence: 65;
  sourceSha256: string;
}>;

export type E2BOwnedImageRuntime = {
  // Supplied by the trusted controller's current source calculation, not input.
  sourceSha256: string;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
};

export type E2BOwnedImageProof = Readonly<{
  schemaVersion: 1;
  task: "P04.T01h";
  planSequence: 65;
  sourceSha256: string;
  scope: "public_oci_manifest_provenance_only";
  verifiedAt: string;
  image: string;
  index: Readonly<{ digest: string; headerDigest: string; byteLength: number; mediaType: string }>;
  platform: Readonly<{
    os: "linux";
    architecture: "amd64";
    digest: string;
    headerDigest: string;
    byteLength: number;
    descriptorByteLength: number;
    mediaType: string;
    configDigest: string;
    configDeclaredBytes: number;
    layerCount: number;
    declaredCompressedLayerBytes: number;
  }>;
  ownedTemplateQualified: false;
  rootfsAttested: false;
  nativeResourcesQualified: false;
  productionQualified: false;
  providerCompute: false;
}>;

function failure(message = "E2B public image qualification denied"): Error {
  const error = new Error(message);
  failures.add(error);
  return error;
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (keys && !keys.includes(key))) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw failure();
    out[key] = descriptor.value;
  }
  return out;
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000 - MAX_WALL_MS)
    throw failure();
  return value;
}

/** Pure preparation. This cannot make a network request or qualify an image. */
export function compileE2BOwnedImageRequest(
  value: unknown,
  expectedSourceSha256: string,
): E2BOwnedImageRequest {
  try {
    const input = record(value, ["schemaVersion", "task", "planSequence", "sourceSha256"]);
    if (
      typeof expectedSourceSha256 !== "string" ||
      !SHA256.test(expectedSourceSha256) ||
      input.schemaVersion !== 1 ||
      input.task !== "P04.T01h" ||
      input.planSequence !== 65 ||
      input.sourceSha256 !== expectedSourceSha256
    )
      throw failure();
    return Object.freeze({
      schemaVersion: 1,
      task: "P04.T01h",
      planSequence: 65,
      sourceSha256: expectedSourceSha256,
    });
  } catch {
    throw failure();
  }
}

function denyImplicitNetworkSettings(environment: unknown): void {
  const values = record(environment);
  for (const [key, value] of Object.entries(values)) {
    if (
      /^(?:https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key) &&
      value !== undefined &&
      value !== ""
    )
      throw failure();
    if (key === "NODE_TLS_REJECT_UNAUTHORIZED" && value !== undefined && value !== "1")
      throw failure();
    if (
      key === "NODE_OPTIONS" &&
      typeof value === "string" &&
      /(?:proxy|--require|--import)/i.test(value)
    )
      throw failure();
  }
}

function nativeNetworkEnvironment(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = Object.create(null);
  for (const key of Object.keys(process.env)) {
    if (
      /^(?:https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_tls_reject_unauthorized|node_options)$/i.test(
        key,
      )
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(process.env, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw failure();
      out[key] = descriptor.value;
    }
  }
  return out;
}

function annotations(value: unknown): void {
  if (value === undefined) return;
  const data = record(value);
  if (Object.keys(data).length > 16) throw failure();
  for (const [key, text] of Object.entries(data))
    if (key.length > 256 || typeof text !== "string" || text.length > 1024) throw failure();
}

function descriptor(value: unknown, mediaType: string, maximumSize: number) {
  const data = record(value, ["mediaType", "digest", "size", "platform", "annotations"]);
  if (
    data.mediaType !== mediaType ||
    typeof data.digest !== "string" ||
    !OCI_DIGEST.test(data.digest) ||
    !Number.isSafeInteger(data.size) ||
    (data.size as number) <= 0 ||
    (data.size as number) > maximumSize
  )
    throw failure();
  annotations(data.annotations);
  return { digest: data.digest, size: data.size as number, platform: data.platform };
}

function parse(bytes: Uint8Array): Record<string, unknown> {
  return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

function indexManifest(bytes: Uint8Array): number {
  const index = record(parse(bytes), ["schemaVersion", "mediaType", "manifests", "annotations"]);
  if (
    index.schemaVersion !== 2 ||
    index.mediaType !== INDEX_MEDIA ||
    !Array.isArray(index.manifests) ||
    index.manifests.length === 0 ||
    index.manifests.length > 16
  )
    throw failure();
  annotations(index.annotations);
  let selectedSize: number | undefined;
  const digests = new Set<string>();
  for (const item of index.manifests) {
    const entry = descriptor(item, MANIFEST_MEDIA, MAX_BYTES);
    if (digests.has(entry.digest)) throw failure();
    digests.add(entry.digest);
    const platform = record(entry.platform, ["os", "architecture", "variant"]);
    if (
      typeof platform.os !== "string" ||
      !/^[a-z0-9]{1,32}$/.test(platform.os) ||
      typeof platform.architecture !== "string" ||
      !/^[a-z0-9]{1,32}$/.test(platform.architecture) ||
      (platform.variant !== undefined &&
        (typeof platform.variant !== "string" || !/^[a-z0-9]{1,32}$/.test(platform.variant)))
    )
      throw failure();
    if (platform.os === "linux" && platform.architecture === "amd64") {
      if (
        selectedSize !== undefined ||
        entry.digest !== AMD64_DIGEST ||
        platform.variant !== undefined
      )
        throw failure();
      selectedSize = entry.size;
    }
  }
  if (selectedSize === undefined) throw failure();
  return selectedSize;
}

function childManifest(bytes: Uint8Array) {
  const manifest = record(parse(bytes), [
    "schemaVersion",
    "mediaType",
    "config",
    "layers",
    "annotations",
  ]);
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== MANIFEST_MEDIA ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length === 0 ||
    manifest.layers.length > 128
  )
    throw failure();
  annotations(manifest.annotations);
  const config = descriptor(manifest.config, "application/vnd.oci.image.config.v1+json", MAX_BYTES);
  if (config.platform !== undefined) throw failure();
  let declaredCompressedLayerBytes = 0;
  for (const item of manifest.layers) {
    const layer = descriptor(item, "application/vnd.oci.image.layer.v1.tar+gzip", 1073741824);
    if (layer.platform !== undefined) throw failure();
    declaredCompressedLayerBytes += layer.size;
    if (
      !Number.isSafeInteger(declaredCompressedLayerBytes) ||
      declaredCompressedLayerBytes > 4294967296
    )
      throw failure();
  }
  return {
    configDigest: config.digest,
    configDeclaredBytes: config.size,
    layerCount: manifest.layers.length,
    declaredCompressedLayerBytes,
  };
}

/** Explicit anonymous metadata reads only. No layer/config download or E2B API. */
export async function qualifyE2BOwnedBaseImage(
  value: unknown,
  runtime: E2BOwnedImageRuntime,
): Promise<E2BOwnedImageProof> {
  let token: string | undefined;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const options = record(runtime, ["sourceSha256", "fetch", "now", "signal", "environment"]);
    const request = compileE2BOwnedImageRequest(value, options.sourceSha256 as string);
    if (options.fetch !== undefined && typeof options.fetch !== "function") throw failure();
    if (options.now !== undefined && typeof options.now !== "function") throw failure();
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw failure();
    denyImplicitNetworkSettings(options.environment ?? nativeNetworkEnvironment());
    const fetcher = (options.fetch ?? fetch) as typeof fetch;
    const now = (options.now ?? Date.now) as () => number;
    const startedAt = clock(now);
    const deadline = startedAt + MAX_WALL_MS;
    const wall = new AbortController();
    wallTimer = setTimeout(() => wall.abort(), MAX_WALL_MS);
    const signal = options.signal
      ? AbortSignal.any([wall.signal, options.signal as AbortSignal])
      : wall.signal;

    async function get(url: string, mediaType: string, digest?: string): Promise<Uint8Array> {
      if (
        signal.aborted ||
        clock(now) < startedAt ||
        clock(now) >= deadline ||
        (url !== AUTH_URL &&
          url !== `${REGISTRY_ORIGIN}/v2/e2bdev/base/manifests/${INDEX_DIGEST}` &&
          url !== `${REGISTRY_ORIGIN}/v2/e2bdev/base/manifests/${AMD64_DIGEST}`)
      )
        throw failure();
      const controller = new AbortController();
      const boundedSignal = AbortSignal.any([signal, controller.signal]);
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(REQUEST_MS, deadline - clock(now)),
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(failure("E2B public image request cancelled"));
        boundedSignal.addEventListener("abort", rejectAbort, { once: true });
        if (boundedSignal.aborted) rejectAbort();
      });
      try {
        return await Promise.race([
          aborted,
          (async () => {
            const response = await fetcher(url, {
              method: "GET",
              redirect: "error",
              credentials: "omit",
              cache: "no-store",
              referrerPolicy: "no-referrer",
              headers: token
                ? { Accept: mediaType, Authorization: `Bearer ${token}` }
                : { Accept: mediaType },
              signal: boundedSignal,
            });
            if (!(response instanceof Response)) throw failure();
            if (boundedSignal.aborted) {
              if (response.body) void response.body.cancel().catch(() => undefined);
              throw failure("E2B public image request cancelled");
            }
            if (
              response.url !== url ||
              response.redirected ||
              response.status !== 200 ||
              response.headers.has("location") ||
              response.headers.get("content-type")?.split(";")[0]?.trim() !== mediaType ||
              (response.headers.has("content-encoding") &&
                response.headers.get("content-encoding") !== "identity")
            )
              throw failure();
            const length = response.headers.get("content-length");
            if (length !== null && (!/^[0-9]{1,6}$/.test(length) || Number(length) > MAX_BYTES))
              throw failure();
            if (digest && response.headers.get("docker-content-digest") !== digest) throw failure();
            if (!response.body) throw failure();
            reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            for (;;) {
              const chunk = await reader.read();
              if (boundedSignal.aborted || clock(now) >= deadline || clock(now) < startedAt)
                throw failure();
              if (chunk.done) break;
              if (
                !(chunk.value instanceof Uint8Array) ||
                !chunk.value.byteLength ||
                chunks.length >= 1024
              )
                throw failure();
              total += chunk.value.byteLength;
              if (total > MAX_BYTES) throw failure();
              chunks.push(chunk.value);
            }
            if (!total || (length !== null && Number(length) !== total)) throw failure();
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            if (digest && `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest)
              throw failure();
            return bytes;
          })(),
        ]);
      } finally {
        clearTimeout(timer);
        if (rejectAbort) boundedSignal.removeEventListener("abort", rejectAbort);
        controller.abort();
        // Cancellation cannot wait on an untrusted streaming implementation.
        if (reader) void reader.cancel().catch(() => undefined);
      }
    }

    const auth = record(parse(await get(AUTH_URL, "application/json")), [
      "token",
      "access_token",
      "expires_in",
      "issued_at",
    ]);
    if (
      typeof auth.token !== "string" ||
      !/^[A-Za-z0-9._~-]{1,16384}$/.test(auth.token) ||
      (auth.access_token !== undefined && auth.access_token !== auth.token) ||
      !Number.isSafeInteger(auth.expires_in) ||
      (auth.expires_in as number) < 60 ||
      (auth.expires_in as number) > 3600 ||
      typeof auth.issued_at !== "string"
    )
      throw failure();
    const issuedAt = Date.parse(auth.issued_at);
    if (
      !Number.isFinite(issuedAt) ||
      issuedAt > clock(now) + 60000 ||
      issuedAt + (auth.expires_in as number) * 1000 <= deadline
    )
      throw failure();
    token = auth.token;
    const index = await get(
      `${REGISTRY_ORIGIN}/v2/e2bdev/base/manifests/${INDEX_DIGEST}`,
      INDEX_MEDIA,
      INDEX_DIGEST,
    );
    const descriptorByteLength = indexManifest(index);
    const child = await get(
      `${REGISTRY_ORIGIN}/v2/e2bdev/base/manifests/${AMD64_DIGEST}`,
      MANIFEST_MEDIA,
      AMD64_DIGEST,
    );
    if (child.byteLength !== descriptorByteLength) throw failure();
    const metadata = childManifest(child);
    if (signal.aborted || clock(now) >= deadline || clock(now) < startedAt) throw failure();
    return Object.freeze({
      ...request,
      scope: "public_oci_manifest_provenance_only",
      verifiedAt: new Date(clock(now)).toISOString(),
      image: E2B_OWNED_BASE_IMAGE.image,
      index: Object.freeze({
        digest: INDEX_DIGEST,
        headerDigest: INDEX_DIGEST,
        byteLength: index.byteLength,
        mediaType: INDEX_MEDIA,
      }),
      platform: Object.freeze({
        os: "linux",
        architecture: "amd64",
        digest: AMD64_DIGEST,
        headerDigest: AMD64_DIGEST,
        byteLength: child.byteLength,
        descriptorByteLength,
        mediaType: MANIFEST_MEDIA,
        ...metadata,
      }),
      ownedTemplateQualified: false,
      rootfsAttested: false,
      nativeResourcesQualified: false,
      productionQualified: false,
      providerCompute: false,
    });
  } catch (error) {
    // Identity lookup never invokes a thrown value's prototype/property traps.
    if (typeof error === "object" && error !== null && failures.has(error)) throw error;
    throw failure("E2B public image request failed");
  } finally {
    token = undefined;
    if (wallTimer) clearTimeout(wallTimer);
  }
}
