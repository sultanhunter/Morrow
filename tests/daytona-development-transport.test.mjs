import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { DaytonaNotFoundError } from "@daytona/sdk";
import {
  createDaytonaDevelopmentTransport,
  createOfficialDaytonaDevelopmentTransport,
  verifyDaytonaDevelopmentKey,
} from "../scripts/daytona-development-transport.mjs";
import {
  developmentLabConfiguration,
  prepareDevelopmentLabOperation,
  runDevelopmentLab,
} from "../packages/infrastructure/src/daytona-development-lab.ts";

const operationId = "33333333-3333-4333-8333-333333333333";
const id = "44444444-4444-4444-8444-444444444444";
const current = 1_790_000_000_000;
const syntheticKey = "synthetic-test-only-management-key-never-a-real-provider-credential";
const operation = prepareDevelopmentLabOperation(
  developmentLabConfiguration(),
  operationId,
  current,
);
const context = () => ({ deadlineMs: current + 30_000, signal: new AbortController().signal });
const spec = () => ({
  name: operation.name,
  labels: operation.labels,
  organizationId: "8862ff17-6109-4eb1-ac70-2f7bafba64ae",
  region: "us",
  sandboxClass: "container",
  snapshot: "daytona-small",
  cpu: 1,
  memoryGiB: 1,
  diskGiB: 3,
  autoStopMinutes: 5,
  autoDeleteMinutes: 1,
  networkBlockAll: true,
  publicPreview: false,
});
function fixture(mode = "allocate") {
  const calls = [];
  let contents;
  const sandbox = {
    id,
    name: operation.name,
    labels: { ...operation.labels, "code-toolbox-language": "typescript" },
    organizationId: spec().organizationId,
    target: "us",
    sandboxClass: "container",
    snapshot: "daytona-small",
    cpu: 1,
    memory: 1,
    disk: 3,
    state: "started",
    public: false,
    autoStopInterval: 5,
    autoPauseInterval: 0,
    autoDeleteInterval: 1,
    createdAt: new Date(current).toISOString(),
    autoDestroyAt: new Date(current + 600_000).toISOString(),
    networkBlockAll: true,
    env: {},
    volumes: [],
    toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
    fs: {
      async uploadFile(buffer, path, timeout) {
        calls.push(["uploadFile", buffer, path, timeout]);
        contents = Buffer.from(buffer);
      },
      async downloadFile(path, timeout) {
        calls.push(["downloadFile", path, timeout]);
        return contents;
      },
    },
    async stop(timeout) {
      calls.push(["stop", timeout]);
      sandbox.state = "stopped";
    },
    async start(timeout) {
      calls.push(["start", timeout]);
      sandbox.state = "started";
    },
    async delete(timeout, wait) {
      calls.push(["delete", timeout, wait]);
      sandbox.state = "destroyed";
    },
  };
  const client = {
    async create(params, options) {
      calls.push(["create", params, options]);
      return sandbox;
    },
    async get(key) {
      calls.push(["get", key]);
      return sandbox;
    },
    async [Symbol.asyncDispose]() {
      calls.push(["dispose"]);
    },
  };
  const port = createDaytonaDevelopmentTransport({
    client,
    NotFoundError: DaytonaNotFoundError,
    now: () => current,
    mode,
  });
  return {
    port,
    client,
    sandbox,
    calls,
    corrupt: () => {
      contents = Buffer.from("unexpected-content");
    },
  };
}

test("actual harness and SDK adapter integrate through persistence and verified terminal cleanup", async () => {
  const f = fixture(),
    records = [];
  let created = false;
  const create = f.client.create;
  f.client.create = async (...args) => {
    created = true;
    return create(...args);
  };
  f.client.get = async () => {
    if (!created)
      throw new DaytonaNotFoundError("opaque", 404, undefined, "NOT_FOUND", "DAYTONA_API");
    return f.sandbox;
  };
  const result = await runDevelopmentLab(developmentLabConfiguration(), operationId, f.port, {
    startedAtMs: current,
    now: () => current,
    persist: async (record) => records.push(structuredClone(record)),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.deletionObservation, "destroyed");
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "uploadFile").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "downloadFile").length, 2);
  assert.equal(records[0].phase, "prepared");
  assert.equal(records.at(-1).phase, "deleted");
  assert.equal(result.productionQualified, false);
});

test("construction is offline and official factory rejects unbound options before SDK construction", async () => {
  const { calls, port } = fixture();
  assert.deepEqual(calls, []);
  assert.equal(Object.isFrozen(port), true);
  for (const options of [
    {},
    { ...spec(), apiKey: "synthetic" },
    { apiKey: "synthetic", organizationId: "foreign", region: "us" },
    { apiKey: "synthetic", organizationId: spec().organizationId, region: "eu" },
    { apiKey: "", organizationId: spec().organizationId, region: "us" },
    {
      apiKey: "synthetic",
      organizationId: spec().organizationId,
      region: "us",
      apiUrl: "https://foreign.test",
    },
  ])
    await assert.rejects(createOfficialDaytonaDevelopmentTransport(options), /TRANSPORT_DENIED/);
  assert.deepEqual(calls, []);
});

const keyOptions = () => ({
  apiKey: syntheticKey,
  organizationId: spec().organizationId,
  region: "us",
  mode: "allocate",
});
const keyDetails = () => ({
  organizationId: spec().organizationId,
  permissions: ["write:sandboxes", "delete:sandboxes"],
  expiresAt: new Date(current + 900_000).toISOString(),
  name: "synthetic-key-name",
  value: "synthetic-masked-value",
  userId: "synthetic-user-id",
});
const keyResponse = (value, options = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

test("read-only preflight binds actual key org/scopes before creation and returns no key metadata", async () => {
  const calls = [];
  const result = await verifyDaytonaDevelopmentKey(keyOptions(), {
    now: () => current,
    fetch: async (url, options) => {
      calls.push([url, options]);
      return keyResponse(keyDetails());
    },
  });
  assert.deepEqual(result, {
    organizationId: spec().organizationId,
    permissions: ["delete:sandboxes", "write:sandboxes"],
    mode: "allocate",
    expiresAfterRequiredWindow: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, "https://app.daytona.io/api/api-keys/current");
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.Authorization, `Bearer ${syntheticKey}`);
  assert.equal(Object.hasOwn(options, "body"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-"), false);
  assert.equal(options.signal.aborted, true);
  assert.deepEqual(
    await verifyDaytonaDevelopmentKey(keyOptions(), {
      now: () => current,
      fetch: async () => keyResponse({ ...keyDetails(), expiresAt: null }),
    }),
    result,
  );
});

test("preflight denies missing/foreign org, broad/missing scopes and inadequate expiry", async () => {
  for (const details of [
    { ...keyDetails(), organizationId: undefined },
    { ...keyDetails(), organizationId: "foreign" },
    { ...keyDetails(), permissions: ["write:sandboxes"] },
    { ...keyDetails(), permissions: ["write:sandboxes", "delete:sandboxes", "manage:billing"] },
    { ...keyDetails(), permissions: ["write:sandboxes", "write:sandboxes"] },
    { ...keyDetails(), expiresAt: undefined },
    { ...keyDetails(), expiresAt: "invalid-expiry" },
    { ...keyDetails(), expiresAt: new Date(current + 899_999).toISOString() },
  ]) {
    await assert.rejects(
      verifyDaytonaDevelopmentKey(keyOptions(), {
        now: () => current,
        fetch: async () => keyResponse(details),
      }),
      (error) => {
        assert.equal(error.message, "DEVELOPMENT_LAB_KEY_UNQUALIFIED");
        assert.equal(error.cause, undefined);
        assert.equal(JSON.stringify(error).includes(syntheticKey), false);
        return true;
      },
    );
  }
});

test("key expiry may cover cleanup only without qualifying a new allocation", async () => {
  const cleanupOptions = { ...keyOptions(), mode: "cleanup" };
  const inject = {
    now: () => current,
    fetch: async () =>
      keyResponse({
        ...keyDetails(),
        expiresAt: new Date(current + 240_000).toISOString(),
      }),
  };
  assert.deepEqual(await verifyDaytonaDevelopmentKey(cleanupOptions, inject), {
    organizationId: spec().organizationId,
    permissions: ["delete:sandboxes", "write:sandboxes"],
    mode: "cleanup",
    expiresAfterRequiredWindow: true,
  });
  await assert.rejects(verifyDaytonaDevelopmentKey(keyOptions(), inject), /KEY_UNQUALIFIED/);
  for (const change of [
    { organizationId: undefined },
    { organizationId: "foreign" },
    { permissions: ["delete:sandboxes"] },
    { permissions: ["write:sandboxes", "delete:sandboxes", "manage:billing"] },
    { expiresAt: new Date(current + 239_999).toISOString() },
  ])
    await assert.rejects(
      verifyDaytonaDevelopmentKey(cleanupOptions, {
        now: () => current,
        fetch: async () => keyResponse({ ...keyDetails(), ...change }),
      }),
      /KEY_UNQUALIFIED/,
    );
});

test("missing and unknown factory/key modes are denied before a provider request", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return keyResponse(keyDetails());
  };
  for (const mode of [undefined, "production", "resume", false]) {
    const options = { ...keyOptions(), mode };
    if (mode === undefined) delete options.mode;
    await assert.rejects(
      verifyDaytonaDevelopmentKey(options, { fetch, now: () => current }),
      /TRANSPORT_DENIED/,
    );
    await assert.rejects(createOfficialDaytonaDevelopmentTransport(options), /TRANSPORT_DENIED/);
  }
  assert.equal(calls, 0);
});

test("verified mode and credential binding cannot change while key preflight is pending", async () => {
  const options = { ...keyOptions(), mode: "cleanup" };
  const proof = await verifyDaytonaDevelopmentKey(options, {
    now: () => current,
    fetch: async (_url, request) => {
      options.mode = "allocate";
      options.apiKey = "changed-after-validation";
      options.organizationId = "foreign";
      assert.equal(request.headers.Authorization, `Bearer ${syntheticKey}`);
      return keyResponse({
        ...keyDetails(),
        expiresAt: new Date(current + 240_000).toISOString(),
      });
    },
  });
  assert.equal(proof.mode, "cleanup");
  assert.equal(proof.organizationId, spec().organizationId);
});

test("cleanup transport permits only bound inspection/deletion, never allocation or probes", async () => {
  const { port, calls } = fixture("cleanup");
  await assert.rejects(port.create(spec(), context()), /TRANSPORT_DENIED/);
  assert.deepEqual(calls, []);
  await port.getByName(operation.name, context());
  await port.inspect(id, context());
  for (const probe of [
    () => port.writeMarker(id, operation.markerPath, operation.markerValue, context()),
    () => port.readMarker(id, operation.markerPath, context()),
    () => port.start(id, context()),
    () => port.stop(id, context()),
  ])
    await assert.rejects(probe(), /TRANSPORT_DENIED/);
  assert.equal(
    calls.some(([method]) =>
      ["create", "uploadFile", "downloadFile", "start", "stop"].includes(method),
    ),
    false,
  );
  await port.delete(id, context());
  assert.equal((await port.inspect(id, context())).state, "destroyed");
});

test("preflight denies HTTP/redirect/oversized/invalid body and never exposes provider errors", async () => {
  for (const fetch of [
    async () => keyResponse(keyDetails(), { status: 403 }),
    async () => keyResponse(keyDetails(), { status: 302 }),
    async () => keyResponse(keyDetails(), { headers: { "Content-Type": "text/plain" } }),
    async () =>
      keyResponse(keyDetails(), {
        headers: { "Content-Type": "application/json", "Content-Length": "32769" },
      }),
    async () => keyResponse({ ...keyDetails(), unexpected: "x".repeat(32769) }),
    async () => new Response("invalid-json", { headers: { "Content-Type": "application/json" } }),
    async () => {
      throw Error(syntheticKey);
    },
  ])
    await assert.rejects(
      verifyDaytonaDevelopmentKey(keyOptions(), { fetch, now: () => current }),
      /KEY_UNQUALIFIED/,
    );
});

test("official factory cannot proceed past a foreign-key principal", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.equal(url, "https://app.daytona.io/api/api-keys/current");
    return keyResponse({ ...keyDetails(), organizationId: "foreign" });
  };
  try {
    await assert.rejects(
      createOfficialDaytonaDevelopmentTransport(keyOptions()),
      /KEY_UNQUALIFIED/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("create maps only the fixed small snapshot, lifecycle and synthetic labels", async () => {
  const { calls, port } = fixture();
  const observed = await port.create(spec(), context());
  assert.deepEqual(observed, {
    id,
    name: operation.name,
    labels: { ...operation.labels },
    sandboxClass: "container",
    snapshot: "daytona-small",
    cpu: 1,
    memoryGiB: 1,
    diskGiB: 3,
    state: "started",
  });
  assert.deepEqual(calls, [
    [
      "create",
      {
        name: operation.name,
        labels: { ...operation.labels },
        snapshot: "daytona-small",
        language: "typescript",
        target: "us",
        public: false,
        envVars: {},
        autoStopInterval: 5,
        autoPauseInterval: 0,
        autoArchiveInterval: 60,
        autoDeleteInterval: 1,
        ttlMinutes: 10,
        queueTimeout: 1,
        networkBlockAll: true,
      },
      { timeout: 30 },
    ],
  ]);
});

test("extra payload, production class and altered caps are rejected before creation", async () => {
  for (const changed of [
    { arbitraryCode: "unsafe" },
    { envVars: { KEY: "synthetic-secret" } },
    { volumes: [] },
    { sandboxClass: "linux-vm" },
    { diskGiB: 10 },
    { autoDeleteMinutes: 0 },
    { autoStopMinutes: 0 },
    { snapshot: "daytona-large" },
    { publicPreview: true },
    { organizationId: "foreign" },
    { region: "eu" },
    { labels: { ...operation.labels, injected: "payload" } },
  ]) {
    const { calls, port } = fixture();
    await assert.rejects(port.create({ ...spec(), ...changed }, context()), /TRANSPORT_DENIED/);
    assert.deepEqual(calls, []);
  }
});

test("absence requires the SDK class, API source and actual HTTP404", async () => {
  const { client, port } = fixture();
  client.get = async () => {
    throw new DaytonaNotFoundError("opaque", 404, undefined, "NOT_FOUND", "DAYTONA_API");
  };
  assert.equal(await port.getByName(operation.name, context()), null);
  assert.equal(await port.inspect(id, context()), null);
  for (const error of [
    Error("404 not found"),
    { statusCode: 404, source: "DAYTONA_API" },
    new DaytonaNotFoundError("synthetic-key", 404),
    new DaytonaNotFoundError("synthetic-key", 404, undefined, "NOT_FOUND", "DAYTONA_PROXY"),
    new DaytonaNotFoundError("synthetic-key", 503, undefined, "NOT_FOUND", "DAYTONA_API"),
  ]) {
    client.get = async () => {
      throw error;
    };
    await assert.rejects(port.getByName(operation.name, context()), (failure) => {
      assert.equal(failure.message, "DEVELOPMENT_LAB_PROVIDER_FAILED");
      assert.equal(failure.cause, undefined);
      assert.equal(failure.message.includes("synthetic-key"), false);
      return true;
    });
  }
});

test("returned organization, ID, exact labels and primitive shape are checked", async () => {
  for (const changed of [
    { organizationId: "foreign" },
    { target: "eu" },
    { id: "not-an-id" },
    { name: "foreign-name" },
    { labels: { ...operation.labels } },
    { labels: { ...operation.labels, "code-toolbox-language": "typescript", unexpected: "value" } },
    { state: "secret-in-provider-output" },
    { memory: Number.NaN },
  ]) {
    const { port, sandbox } = fixture();
    Object.assign(sandbox, changed);
    await assert.rejects(port.getByName(operation.name, context()), /TRANSPORT_DENIED/);
  }
  const { port, sandbox } = fixture();
  sandbox.id = "55555555-5555-4555-8555-555555555555";
  await assert.rejects(port.inspect(id, context()), /TRANSPORT_DENIED/);
});

test("wrong-size owned resource can be observed and deleted without executing in it", async () => {
  const { port, sandbox, calls } = fixture();
  sandbox.memory = 4;
  assert.equal((await port.getByName(operation.name, context())).memoryGiB, 4);
  await assert.rejects(
    port.writeMarker(id, operation.markerPath, operation.markerValue, context()),
    /TRANSPORT_DENIED/,
  );
  await port.delete(id, context());
  assert.equal(
    calls.some(([method]) => method === "uploadFile"),
    false,
  );
  assert.deepEqual(
    calls.find(([method]) => method === "delete"),
    ["delete", 30, true],
  );
});

test("only the run-owned constant marker is transferred and survives stop/start", async () => {
  const { port, calls } = fixture();
  await port.getByName(operation.name, context());
  await port.writeMarker(id, operation.markerPath, operation.markerValue, context());
  assert.equal(await port.readMarker(id, operation.markerPath, context()), operation.markerValue);
  await port.stop(id, context());
  assert.equal((await port.inspect(id, context())).state, "stopped");
  await port.start(id, context());
  assert.equal((await port.inspect(id, context())).state, "started");
  assert.equal(await port.readMarker(id, operation.markerPath, context()), operation.markerValue);
  assert.ok(
    calls
      .filter(([method]) => ["uploadFile", "downloadFile", "start", "stop"].includes(method))
      .every((call) => call.at(-1) === 30),
  );
  await assert.rejects(
    port.writeMarker(id, "/tmp/arbitrary", operation.markerValue, context()),
    /TRANSPORT_DENIED/,
  );
  await assert.rejects(
    port.writeMarker(id, operation.markerPath, "arbitrary", context()),
    /TRANSPORT_DENIED/,
  );
  await assert.rejects(port.readMarker(id, "/tmp/arbitrary", context()), /TRANSPORT_DENIED/);
});

test("foreign toolbox destinations, mounts, credentials and lifecycle drift prevent execution", async () => {
  for (const changed of [
    { toolboxProxyUrl: "https://foreign.test/toolbox" },
    { toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox?key=synthetic" },
    { toolboxProxyUrl: "http://proxy.app.daytona.io/toolbox" },
    { public: true },
    { env: { API_KEY: "synthetic-key" } },
    { volumes: [{ volumeId: "foreign" }] },
    { linkedSandboxId: id },
    { kvm: true },
    { gpu: 1 },
    { autoStopInterval: 0 },
    { autoDeleteInterval: 0 },
    { autoPauseInterval: 1 },
    { autoDestroyAt: undefined },
    { createdAt: undefined },
    { autoDestroyAt: new Date(current + 600_001).toISOString() },
    { networkBlockAll: false },
    { outboundProxyUrl: "https://foreign.test" },
  ]) {
    const { port, sandbox, calls } = fixture();
    await port.getByName(operation.name, context());
    Object.assign(sandbox, changed);
    await assert.rejects(
      port.writeMarker(id, operation.markerPath, operation.markerValue, context()),
      /TRANSPORT_DENIED/,
    );
    assert.equal(
      calls.some(([method]) => method === "uploadFile"),
      false,
    );
  }
});

test("corrupted file bytes never propagate arbitrary provider content", async () => {
  const { port, corrupt } = fixture();
  await port.create(spec(), context());
  await port.writeMarker(id, operation.markerPath, operation.markerValue, context());
  corrupt();
  await assert.rejects(port.readMarker(id, operation.markerPath, context()), /TRANSPORT_DENIED/);
});

test("effects require a previously bound resource and reject later identity mutation", async () => {
  const { port, sandbox, calls } = fixture();
  await assert.rejects(port.delete(id, context()), /TRANSPORT_DENIED/);
  assert.deepEqual(calls, []);
  const observed = await port.create(spec(), context());
  observed.labels.morrowProfile = "a".repeat(64);
  sandbox.labels.morrowProfile = "a".repeat(64);
  await assert.rejects(port.delete(id, context()), /TRANSPORT_DENIED/);
  assert.equal(
    calls.some(([method]) => method === "delete"),
    false,
  );
});

test("a stop resolved on destroyed cannot be restarted", async () => {
  const { port, sandbox, calls } = fixture();
  await port.create(spec(), context());
  sandbox.stop = async () => {
    sandbox.state = "destroyed";
  };
  await port.stop(id, context());
  assert.equal((await port.inspect(id, context())).state, "destroyed");
  await assert.rejects(port.start(id, context()), /TRANSPORT_DENIED/);
  assert.equal(
    calls.some(([method]) => method === "start"),
    false,
  );
});

test("deletion waits and verifies the immutable ID instead of a reused name", async () => {
  const { port, calls } = fixture();
  await port.create(spec(), context());
  await port.delete(id, context());
  const deletion = calls.findIndex(([method]) => method === "delete");
  assert.deepEqual(calls[deletion], ["delete", 30, true]);
  assert.deepEqual(calls[deletion + 1], ["get", id]);
  assert.equal((await port.inspect(id, context())).state, "destroyed");
});

test("accepted but unfinished deletion and opaque failures remain failures", async () => {
  const { port, sandbox } = fixture();
  await port.create(spec(), context());
  sandbox.delete = async () => {
    sandbox.state = "destroying";
  };
  await assert.rejects(port.delete(id, context()), /PROVIDER_FAILED/);
});

test("cancellation before an effect makes no calls and a deadline bounds a hanging create", async () => {
  const { port, client, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    port.create(spec(), { deadlineMs: current + 10_000, signal: controller.signal }),
    /CANCELLED/,
  );
  await assert.rejects(
    port.create(spec(), { deadlineMs: current, signal: new AbortController().signal }),
    /DEADLINE/,
  );
  assert.deepEqual(calls, []);
  let creates = 0;
  client.create = () => {
    creates++;
    return new Promise(() => {});
  };
  await assert.rejects(
    port.create(spec(), { deadlineMs: current + 5, signal: new AbortController().signal }),
    /DEADLINE/,
  );
  assert.equal(creates, 1);
});

test("SDK raw errors are replaced and client disposal is awaited exactly once", async () => {
  const { port, client, calls } = fixture();
  client.create = async () => {
    throw Object.assign(Error("synthetic-key"), { headers: { Authorization: "synthetic-key" } });
  };
  await assert.rejects(port.create(spec(), context()), (error) => {
    assert.equal(error.message, "DEVELOPMENT_LAB_PROVIDER_FAILED");
    assert.deepEqual(Object.keys(error), []);
    return true;
  });
  await port.dispose();
  await port.dispose();
  assert.deepEqual(calls, [["dispose"]]);
  await assert.rejects(port.inspect(id, context()), /TRANSPORT_DENIED/);
});

test("Error accessors and proxy traps cannot escape redaction or become absence", async () => {
  const getter = Error("unused");
  Object.defineProperty(getter, "message", {
    get() {
      throw Error(syntheticKey);
    },
  });
  const metadataGetter = new DaytonaNotFoundError(
    "unused",
    404,
    undefined,
    "NOT_FOUND",
    "DAYTONA_API",
  );
  Object.defineProperty(metadataGetter, "source", {
    get() {
      throw Error(syntheticKey);
    },
  });
  const proxy = new Proxy(Error("unused"), {
    getPrototypeOf() {
      throw Error(syntheticKey);
    },
    getOwnPropertyDescriptor() {
      throw Error(syntheticKey);
    },
  });
  for (const failure of [getter, metadataGetter, proxy]) {
    const { port, client } = fixture();
    client.create = async () => {
      throw failure;
    };
    client.get = async () => {
      throw failure;
    };
    await assert.rejects(port.create(spec(), context()), (error) => {
      assert.equal(error.message, "DEVELOPMENT_LAB_PROVIDER_FAILED");
      return true;
    });
    await assert.rejects(port.getByName(operation.name, context()), (error) => {
      assert.equal(error.message, "DEVELOPMENT_LAB_PROVIDER_FAILED");
      return true;
    });
  }
});

test("pinned SDK transport never replays uncertain POST timeout, reset or HTTP error", async () => {
  const sdkEntry = new URL(import.meta.resolve("@daytona/sdk"));
  const { withConnectionRetry } = await import(new URL("./utils/RetryAdapter.js", sdkEntry));
  const require = createRequire(sdkEntry);
  const { AxiosError } = await import(
    new URL("./index.js", pathToFileURL(require.resolve("axios/package.json")))
  );
  for (const code of ["ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT", "HTTP503", "HTTP504"]) {
    let calls = 0;
    const failure = new AxiosError("synthetic-private-error", code);
    if (code.startsWith("HTTP")) failure.response = { status: Number(code.slice(4)), data: {} };
    const transport = withConnectionRetry(
      async () => {
        calls++;
        throw failure;
      },
      { sleep: async () => {} },
    );
    await assert.rejects(transport({ method: "post", data: "{}" }), (error) => error === failure);
    assert.equal(calls, 1, code);
  }
  // Positive control: the test uses the same AxiosError identity as the SDK,
  // and only a documented pre-write DNS failure consumes its retry budget.
  let preWriteCalls = 0;
  const preWrite = new AxiosError("synthetic-dns-failure", "ENOTFOUND");
  const transport = withConnectionRetry(
    async () => {
      preWriteCalls++;
      throw preWrite;
    },
    { sleep: async () => {} },
  );
  await assert.rejects(transport({ method: "post", data: "{}" }), (error) => error === preWrite);
  assert.equal(preWriteCalls, 3);
});

test("pinned SDK fixed Buffer transfers never load the vulnerable glob dependency", async () => {
  const { spawnSync } = await import("node:child_process");
  // An isolated process installs the tripwire BEFORE the real SDK import. No
  // inherited credentials, .env SDK client, provider HTTP or network is needed.
  const probe = async function () {
    const assert = (await import("node:assert/strict")).default;
    const Module = (await import("node:module")).default;
    const { Readable } = await import("node:stream");
    const http = (await import("node:http")).default;
    const https = (await import("node:https")).default;
    let providerCalls = 0;
    const denyNetwork = () => {
      providerCalls++;
      throw Error("PROBE_PROVIDER_CALL_DENIED");
    };
    http.request = http.get = https.request = https.get = denyNetwork;
    globalThis.fetch = denyNetwork;
    const originalLoad = Module._load;
    let globAttempts = 0;
    Module._load = function (name, ...args) {
      if (["fast-glob", "micromatch", "braces"].includes(name)) {
        globAttempts++;
        throw Error("PROBE_GLOB_LOAD_DENIED");
      }
      return originalLoad.call(this, name, ...args);
    };
    try {
      const { FileSystem, Image } = await import("@daytona/sdk");
      const path = "/tmp/morrow-dev-lab-33333333-3333-4333-8333-333333333333.txt";
      const marker = Buffer.from(
        "MORROW_SYNTHETIC_PERSISTENCE_V1:33333333-3333-4333-8333-333333333333\n",
      );
      let uploads = 0;
      let downloads = 0;
      const filesystem = new FileSystem(
        {},
        {
          async uploadFiles(options) {
            uploads++;
            assert.equal(options.maxRedirects, 0);
            assert.equal(options.timeout, 1000);
            assert.equal(typeof options.data.append, "function");
            return { data: null };
          },
          async downloadFiles(body, options) {
            downloads++;
            assert.deepEqual(body.paths, [path]);
            assert.equal(options.timeout, 1000);
            const prefix = Buffer.from(
              '--morrowprobe\r\nContent-Disposition: form-data; name="file"; filename="' +
                path +
                '"\r\nContent-Type: application/octet-stream\r\nContent-Length: ' +
                marker.length +
                "\r\n\r\n",
            );
            return {
              headers: { "content-type": "multipart/form-data; boundary=morrowprobe" },
              data: Readable.from([prefix, marker, Buffer.from("\r\n--morrowprobe--\r\n")]),
            };
          },
        },
      );
      await filesystem.uploadFile(marker, path, 1);
      assert.deepEqual(await filesystem.downloadFile(path, 1), marker);
      assert.equal(globAttempts, 0);
      // A harmless COPY positive control proves this instrumentation detects
      // the actual Image -> fast-glob sink; it never evaluates a hostile glob.
      assert.throws(
        () => Image.extractCopySources("COPY synthetic-safe.txt /tmp"),
        /PROBE_GLOB_LOAD_DENIED/,
      );
      assert.equal(globAttempts, 1);
      assert.equal(providerCalls, 0);
      console.log(
        JSON.stringify({
          uploads,
          downloads,
          permittedFlowGlobLoads: 0,
          imageCopyPositiveControlBlocked: globAttempts,
          providerCalls,
        }),
      );
    } finally {
      Module._load = originalLoad;
    }
  };
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `(${probe.toString()})().catch(() => { process.exitCode = 1; });`,
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: {},
      // Full CI starts several real workerd processes concurrently; allow SDK
      // module loading time while retaining a bounded, network-denied probe.
      timeout: 30_000,
      maxBuffer: 32_768,
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    uploads: 1,
    downloads: 1,
    permittedFlowGlobLoads: 0,
    imageCopyPositiveControlBlocked: 1,
    providerCalls: 0,
  });
});
