import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  E2B_OWNED_BASE_IMAGE,
  compileE2BOwnedImageRequest,
  qualifyE2BOwnedBaseImage,
} from "../packages/runtime-adapters/src/e2b/owned-image.ts";

// Official anonymous registry response bytes, not reserialized JSON. Neither
// fixture contains a token, account data, layers or a downloaded configuration.
const indexBytes = await readFile(new URL("./fixtures/e2b-base-index.json", import.meta.url));
const amd64Bytes = await readFile(new URL("./fixtures/e2b-base-amd64.json", import.meta.url));
const sourceSha256 = "b".repeat(64);
const current = Date.parse("2026-10-15T06:00:00Z");
const anonymousToken = "synthetic.public.pull.only";
const request = () => ({ schemaVersion: 1, task: "P04.T01h", planSequence: 60, sourceSha256 });
const urls = [
  E2B_OWNED_BASE_IMAGE.authUrl,
  `${E2B_OWNED_BASE_IMAGE.registryOrigin}/v2/e2bdev/base/manifests/${E2B_OWNED_BASE_IMAGE.indexDigest}`,
  `${E2B_OWNED_BASE_IMAGE.registryOrigin}/v2/e2bdev/base/manifests/${E2B_OWNED_BASE_IMAGE.amd64Digest}`,
];
const auth = (changes = {}) => ({
  token: anonymousToken,
  access_token: anonymousToken,
  expires_in: 300,
  issued_at: new Date(current).toISOString(),
  ...changes,
});

function response(url, body, headers = {}, status = 200) {
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, "url", { value: url });
  return result;
}
function jsonResponse(url, body, headers = {}) {
  return response(url, JSON.stringify(body), { "content-type": "application/json", ...headers });
}
function defaultResponse(url, ordinal) {
  if (ordinal === 1) return jsonResponse(url, auth());
  const bytes = ordinal === 2 ? indexBytes : amd64Bytes;
  return response(url, bytes, {
    "content-type":
      ordinal === 2
        ? "application/vnd.oci.image.index.v1+json"
        : "application/vnd.oci.image.manifest.v1+json",
    "docker-content-digest":
      ordinal === 2 ? E2B_OWNED_BASE_IMAGE.indexDigest : E2B_OWNED_BASE_IMAGE.amd64Digest,
    "content-length": String(bytes.length),
  });
}
function fixture(override) {
  const calls = [];
  return {
    calls,
    runtime: {
      sourceSha256,
      now: () => current,
      environment: {},
      async fetch(url, options) {
        calls.push({ url, options });
        const ordinal = calls.length;
        return override ? override(url, options, ordinal) : defaultResponse(url, ordinal);
      },
    },
  };
}
async function denied(fixtureValue, value = request(), message) {
  await assert.rejects(qualifyE2BOwnedBaseImage(value, fixtureValue.runtime), (error) => {
    assert.equal(error.cause, undefined);
    assert.match(
      error.message,
      /^E2B public image (qualification denied|request failed|request cancelled)$/,
    );
    assert.ok(!error.message.includes(anonymousToken));
    if (message) assert.equal(error.message, message);
    return true;
  });
}

test("raw public fixtures independently match the fixed immutable hashes", () => {
  assert.equal(
    `sha256:${createHash("sha256").update(indexBytes).digest("hex")}`,
    E2B_OWNED_BASE_IMAGE.indexDigest,
  );
  assert.equal(
    `sha256:${createHash("sha256").update(amd64Bytes).digest("hex")}`,
    E2B_OWNED_BASE_IMAGE.amd64Digest,
  );
  assert.equal(indexBytes.length, 1609);
  assert.equal(amd64Bytes.length, 2595);
});

test("pure preparation binds current source and does not qualify or perform work", () => {
  const compiled = compileE2BOwnedImageRequest(request(), sourceSha256);
  assert.deepEqual(compiled, request());
  assert.ok(Object.isFrozen(compiled));
  assert.equal(compiled.qualified, undefined);
  assert.ok(Object.isFrozen(E2B_OWNED_BASE_IMAGE));
});

test("success verifies raw and header digests, descriptor size and Linux amd64 provenance", async () => {
  const f = fixture();
  const proof = await qualifyE2BOwnedBaseImage(request(), f.runtime);
  assert.equal(proof.sourceSha256, sourceSha256);
  assert.equal(proof.scope, "public_oci_manifest_provenance_only");
  assert.equal(proof.image, `e2bdev/base@${E2B_OWNED_BASE_IMAGE.indexDigest}`);
  assert.deepEqual(proof.index, {
    digest: E2B_OWNED_BASE_IMAGE.indexDigest,
    headerDigest: E2B_OWNED_BASE_IMAGE.indexDigest,
    byteLength: 1609,
    mediaType: "application/vnd.oci.image.index.v1+json",
  });
  assert.deepEqual(proof.platform, {
    os: "linux",
    architecture: "amd64",
    digest: E2B_OWNED_BASE_IMAGE.amd64Digest,
    headerDigest: E2B_OWNED_BASE_IMAGE.amd64Digest,
    byteLength: 2595,
    descriptorByteLength: 2595,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    configDigest: "sha256:e894c485b153f72f944f7a5b7aa9d1e7fcf246fb1d90985049fc6b650870eb04",
    configDeclaredBytes: 10613,
    layerCount: 12,
    declaredCompressedLayerBytes: 468189713,
  });
  for (const key of [
    "ownedTemplateQualified",
    "rootfsAttested",
    "nativeResourcesQualified",
    "productionQualified",
    "providerCompute",
  ])
    assert.equal(proof[key], false);
  assert.ok(
    Object.isFrozen(proof) && Object.isFrozen(proof.index) && Object.isFrozen(proof.platform),
  );
  assert.ok(!JSON.stringify(proof).includes(anonymousToken));
  assert.deepEqual(
    f.calls.map((call) => call.url),
    urls,
  );
  for (const [i, call] of f.calls.entries()) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.referrerPolicy, "no-referrer");
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers["X-API-Key"], undefined);
    assert.equal(
      call.options.headers.Authorization,
      i === 0 ? undefined : `Bearer ${anonymousToken}`,
    );
  }
});

for (const [label, changes] of [
  ["old plan", { planSequence: 59 }],
  ["wrong source", { sourceSha256: "c".repeat(64) }],
  ["production", { environment: "production" }],
  ["authority", { approved: true }],
  ["foreign URL", { registryOrigin: "https://evil.invalid" }],
  ["digest override", { indexDigest: "sha256:" + "a".repeat(64) }],
  ["credential", { apiKey: "never-read" }],
  ["nonfinite plan", { planSequence: Infinity }],
  ["unknown schema", { schemaVersion: 2 }],
]) {
  test(`rejects ${label} before any request`, async () => {
    const f = fixture();
    await denied(f, { ...request(), ...changes });
    assert.equal(f.calls.length, 0);
  });
}

test("accessors, prototypes and symbols cannot introduce hidden request authority", async () => {
  let reads = 0;
  const values = [
    Object.defineProperty(request(), "sourceSha256", {
      get() {
        reads++;
        return sourceSha256;
      },
    }),
    Object.assign(Object.create({ approved: true }), request()),
    { ...request(), [Symbol("hidden")]: true },
  ];
  for (const value of values) {
    const f = fixture();
    await denied(f, value);
    assert.equal(f.calls.length, 0);
  }
  assert.equal(reads, 0);
});

test("trusted source and dependencies are validated before any request", async () => {
  for (const changes of [
    { sourceSha256: "invalid" },
    { sourceSha256: "a".repeat(64) },
    { fetch: "not-callable" },
    { now: () => NaN },
    { now: () => Infinity },
    { signal: {} },
    { apiKey: "never-read" },
  ]) {
    const f = fixture();
    Object.assign(f.runtime, changes);
    await denied(f);
    assert.equal(f.calls.length, 0);
  }
});

for (const name of [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_OPTIONS",
]) {
  test(`denies implicit ${name} network behavior`, async () => {
    const f = fixture();
    f.runtime.environment = {
      [name]:
        name === "NODE_OPTIONS"
          ? "--use-env-proxy"
          : name === "NODE_TLS_REJECT_UNAUTHORIZED"
            ? "0"
            : "configured",
    };
    await denied(f);
    assert.equal(f.calls.length, 0);
  });
}

test("unused E2B credentials in environment cannot be copied into requests or proof", async () => {
  const f = fixture();
  f.runtime.environment = {
    E2B_API_KEY: "unused-credential-synthetic",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
  };
  const proof = await qualifyE2BOwnedBaseImage(request(), f.runtime);
  assert.ok(!JSON.stringify({ proof, calls: f.calls }).includes("unused-credential-synthetic"));
});

for (const ordinal of [1, 2, 3]) {
  test(`redirect response at request ${ordinal} cannot trigger a follow-up`, async () => {
    const f = fixture((url, options, i) =>
      i === ordinal
        ? response(url, "redirect", { location: "https://evil.invalid/steal" }, 307)
        : defaultResponse(url, i),
    );
    await denied(f);
    assert.equal(f.calls.length, ordinal);
  });
  test(`foreign response URL at request ${ordinal} cannot qualify metadata`, async () => {
    const f = fixture((url, options, i) =>
      i === ordinal ? defaultResponse("https://evil.invalid/manifest", i) : defaultResponse(url, i),
    );
    await denied(f);
    assert.equal(f.calls.length, ordinal);
  });
}

for (const [label, changes] of [
  ["missing token", { token: undefined }],
  ["CRLF token", { token: "abc\r\nforeign" }],
  ["oversized token", { token: "a".repeat(16385) }],
  ["different access token", { access_token: "different" }],
  ["expired token", { issued_at: new Date(current - 600000).toISOString() }],
  ["future issue", { issued_at: new Date(current + 60001).toISOString() }],
  ["unbounded expiry", { expires_in: 999999 }],
  ["foreign authority", { url: "https://evil.invalid" }],
]) {
  test(`rejects ${label} in anonymous token response without registry access`, async () => {
    const f = fixture((url) => jsonResponse(url, auth(changes)));
    await denied(f);
    assert.equal(f.calls.length, 1);
  });
}

test("malformed token JSON and provider exceptions are redacted without retries", async () => {
  for (const reply of [
    (url) => response(url, "not-json", { "content-type": "application/json" }),
    () => {
      throw new Error(`unsafe ${anonymousToken} details`);
    },
    () => {
      throw new Error("E2B public image request cancelled");
    },
  ]) {
    const f = fixture(reply);
    await denied(f, request(), "E2B public image request failed");
    assert.equal(f.calls.length, 1);
  }
});

test("hostile thrown proxy cannot run prototype or property traps in redaction", async () => {
  let prototypeReads = 0;
  let propertyReads = 0;
  const hostile = new Proxy(new Error(anonymousToken), {
    getPrototypeOf() {
      prototypeReads++;
      throw new Error(`unsafe prototype ${anonymousToken}`);
    },
    get() {
      propertyReads++;
      throw new Error(`unsafe property ${anonymousToken}`);
    },
  });
  const f = fixture(() => {
    throw hostile;
  });
  await denied(f, request(), "E2B public image request failed");
  assert.equal(prototypeReads, 0);
  assert.equal(propertyReads, 0);
  assert.equal(f.calls.length, 1);
});

test("revoked thrown proxy is redacted without inspecting it or retrying", async () => {
  const { proxy, revoke } = Proxy.revocable(new Error(anonymousToken), {});
  revoke();
  const f = fixture(() => {
    throw proxy;
  });
  await denied(f, request(), "E2B public image request failed");
  assert.equal(f.calls.length, 1);
});

for (const ordinal of [2, 3]) {
  for (const label of [
    "header digest",
    "raw body",
    "media type",
    "body length",
    "compressed body",
    "empty URL",
    "unexpected location",
    "HTTP404",
  ]) {
    test(`${label} drift at manifest ${ordinal} rejects qualification`, async () => {
      const f = fixture((url, options, i) => {
        if (i !== ordinal) return defaultResponse(url, i);
        const bytes = i === 2 ? indexBytes : amd64Bytes;
        const headers = {
          "content-type":
            i === 2
              ? "application/vnd.oci.image.index.v1+json"
              : "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest":
            i === 2 ? E2B_OWNED_BASE_IMAGE.indexDigest : E2B_OWNED_BASE_IMAGE.amd64Digest,
          "content-length": String(bytes.length),
        };
        if (label === "header digest")
          headers["docker-content-digest"] = "sha256:" + "a".repeat(64);
        if (label === "media type") headers["content-type"] = "application/json";
        if (label === "body length") headers["content-length"] = String(bytes.length + 1);
        if (label === "compressed body") headers["content-encoding"] = "gzip";
        if (label === "unexpected location") headers.location = urls[2];
        const body =
          label === "raw body"
            ? Buffer.from(bytes.toString().replace("schemaVersion", "SCHEMAVersion"))
            : bytes;
        return response(
          label === "empty URL" ? "" : url,
          body,
          headers,
          label === "HTTP404" ? 404 : 200,
        );
      });
      await denied(f);
      assert.equal(f.calls.length, ordinal);
    });
  }
}

test("unbounded declared and actual bodies are rejected, even without content-length", async () => {
  for (const [body, headers] of [
    ["x", { "content-length": "65537" }],
    ["x", { "content-length": "99999999999999999999" }],
    [new Uint8Array(65537), {}],
  ]) {
    const f = fixture((url) =>
      response(url, body, { "content-type": "application/json", ...headers }),
    );
    await denied(f);
    assert.equal(f.calls.length, 1);
  }
});

test("zero-length chunks cannot cause an unbounded stream or receipt", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(0));
    },
    cancel() {
      cancelled = true;
    },
  });
  const f = fixture((url) => response(url, stream, { "content-type": "application/json" }));
  await denied(f);
  assert.equal(f.calls.length, 1);
  assert.equal(cancelled, true);
});

test("pre-cancelled qualification performs no request", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  f.runtime.signal = controller.signal;
  await denied(f);
  assert.equal(f.calls.length, 0);
});

test("cancellation bounds a fetch implementation that ignores its signal", async () => {
  const controller = new AbortController();
  const f = fixture(() => {
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  });
  f.runtime.signal = controller.signal;
  await denied(f, request(), "E2B public image request cancelled");
  assert.equal(f.calls.length, 1);
});

test("a late response after ignored cancellation is discarded and its body cancelled", async () => {
  const controller = new AbortController();
  let resolveLate;
  let cancelled = false;
  const f = fixture(() => {
    queueMicrotask(() => controller.abort());
    return new Promise((resolve) => {
      resolveLate = resolve;
    });
  });
  f.runtime.signal = controller.signal;
  await denied(f, request(), "E2B public image request cancelled");
  resolveLate(
    response(
      urls[0],
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { "content-type": "application/json" },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, 1);
});

test("cancellation during stalled manifest body cancels the reader and never fetches blobs", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const f = fixture((url, options, i) => {
    if (i !== 2) return defaultResponse(url, i);
    const stream = new ReadableStream({
      start(body) {
        body.enqueue(indexBytes.subarray(0, 100));
        queueMicrotask(() => controller.abort());
      },
      cancel() {
        cancelled = true;
      },
    });
    return response(url, stream, {
      "content-type": "application/vnd.oci.image.index.v1+json",
      "docker-content-digest": E2B_OWNED_BASE_IMAGE.indexDigest,
    });
  });
  f.runtime.signal = controller.signal;
  await denied(f);
  assert.equal(f.calls.length, 2);
  assert.equal(cancelled, true);
});

test("total deadline and clock reversal cannot yield a partial qualification", async () => {
  for (const jump of [45000, -1]) {
    let time = current;
    const f = fixture((url, options, i) => {
      if (i === 2) time = current + jump;
      return defaultResponse(url, i);
    });
    f.runtime.now = () => time;
    await denied(f);
    assert.equal(f.calls.length, 2);
  }
});

test("foreign platform/descriptor/layer URL changes cannot bypass immutable manifest pin", async () => {
  for (const change of [
    (index) => {
      index.manifests[0].platform.architecture = "arm64";
    },
    (index) => {
      index.manifests[0].size++;
    },
    (index) => {
      index.manifests[0].urls = ["https://evil.invalid/blob"];
    },
    (index) => {
      index.manifests.push(index.manifests[0]);
    },
  ]) {
    const data = JSON.parse(indexBytes);
    change(data);
    const altered = Buffer.from(JSON.stringify(data));
    const f = fixture((url, options, i) =>
      i === 2
        ? response(url, altered, {
            "content-type": "application/vnd.oci.image.index.v1+json",
            "docker-content-digest": E2B_OWNED_BASE_IMAGE.indexDigest,
          })
        : defaultResponse(url, i),
    );
    await denied(f);
    assert.equal(f.calls.length, 2);
  }
});
