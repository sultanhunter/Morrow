import assert from "node:assert/strict";
import test from "node:test";
import {
  createE2BDevelopmentTransport,
  verifyE2BDevelopmentAccess,
  verifyE2BDevelopmentControllerAccess,
} from "../packages/runtime-adapters/src/e2b/development-transport.ts";
import { prepareSyntheticLabOperation } from "../packages/infrastructure/src/synthetic-runtime-lab.ts";

const current = Date.parse("2026-10-14T16:00:00Z");
const profile = {
  schemaVersion: 1,
  task: "P04.T01h",
  planSequence: 59,
  scope: "builtin_synthetic_operator",
  environment: "development",
  providerId: "e2b",
  projectId: "11111111-1111-4111-8111-111111111111",
  templateId: "morrow_lab_base",
  templateBuildId: "22222222-2222-4222-8222-222222222222",
  cpu: 2,
  memoryMiB: 512,
  diskMiB: 10240,
  maximumWallMs: 600000,
  expectedCreditCeilingUsd: "0.25",
  outbound: "deny_all",
  merchantRouting: false,
};
const operation = prepareSyntheticLabOperation(
  profile,
  "33333333-3333-4333-8333-333333333333",
  current,
  "b".repeat(64),
);
const key = "e2b_synthetic_private_key_only_never_a_real_credential";
const input = () => ({
  apiKey: key,
  profile: structuredClone(profile),
  operation: structuredClone(operation),
  mode: "allocate",
});
const context = (deadlineMs = current + 10000) => ({
  deadlineMs,
  signal: new AbortController().signal,
});
const id = "opaque_VM_4";
const qualification = () => ({
  projectId: profile.projectId,
  binding: "authenticated_project_metrics",
  verifiedAtMs: current,
  template: {
    templateId: profile.templateId,
    templateBuildId: profile.templateBuildId,
    cpu: 2,
    memoryMiB: 512,
    diskMiB: 10240,
    envdVersion: "0.6.2",
  },
});
const build = () => ({
  buildID: profile.templateBuildId,
  status: "ready",
  cpuCount: 2,
  memoryMB: 512,
  diskSizeMB: 10240,
  envdVersion: "0.6.2",
});
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function fetchFixture(override) {
  const calls = [];
  const request = async (url, opts) => {
    calls.push({ url, opts });
    if (override) return override(url, opts, calls.length);
    if (url.includes("/metrics?")) return json([]);
    return json({ templateID: profile.templateId, builds: [build()] });
  };
  return { fetch: request, now: () => current, calls };
}
class SandboxNotFoundError extends Error {}
function fixture(changes = {}) {
  const calls = [];
  let info = {
    sandboxId: id,
    templateId: profile.templateId,
    metadata: { ...operation.metadata },
    startedAt: new Date(current),
    endAt: new Date(current + 585000),
    state: "running",
    cpuCount: 2,
    memoryMB: 512,
    envdVersion: "0.6.2",
    allowInternetAccess: false,
    sandboxDomain: "e2b.app",
    volumeMounts: [],
    network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
    lifecycle: { onTimeout: "kill", autoResume: false },
    ...changes,
  };
  let marker;
  const handle = {
    sandboxId: id,
    sandboxDomain: "e2b.app",
    trafficAccessToken: "synthetic_traffic_token",
    files: {
      async write(path, value, opts) {
        calls.push(["write", path, value, opts]);
        marker = value;
      },
      async read(path, opts) {
        calls.push(["read", path, opts]);
        return marker;
      },
    },
  };
  const sdk = {
    async create(template, opts) {
      calls.push(["create", template, opts]);
      return handle;
    },
    async getInfo(resourceId, opts) {
      calls.push(["getInfo", resourceId, opts]);
      if (!info) throw new SandboxNotFoundError();
      return structuredClone(info);
    },
    list(opts) {
      calls.push(["list", opts]);
      return {
        hasNext: true,
        nextToken: undefined,
        async nextItems(pageOpts) {
          calls.push(["nextItems", pageOpts]);
          this.hasNext = false;
          return info ? [structuredClone(info)] : [];
        },
      };
    },
    async pause(resourceId, opts) {
      calls.push(["pause", resourceId, opts]);
      info.state = "paused";
      return true;
    },
    async connect(resourceId, opts) {
      calls.push(["connect", resourceId, opts]);
      info.state = "running";
      info.startedAt = new Date(current + 1);
      return handle;
    },
    async kill(resourceId, opts) {
      calls.push(["kill", resourceId, opts]);
      info = null;
      return true;
    },
  };
  const auth = { value: true };
  const opts = {
    ...input(),
    Sandbox: sdk,
    SandboxNotFoundError,
    qualification: qualification(),
    inspectControllerAuth: async (resourceId) => {
      calls.push(["auth", resourceId]);
      return auth.value;
    },
    now: () => current,
  };
  const port = createE2BDevelopmentTransport(opts);
  return {
    calls,
    sdk,
    handle,
    auth,
    opts,
    port,
    change(value) {
      Object.assign(info, value);
    },
    corrupt() {
      marker = "private-provider-output";
    },
  };
}

test("native qualification binds the actual project before reading the pinned build", async () => {
  const f = fetchFixture();
  const result = await verifyE2BDevelopmentAccess(input(), f);
  assert.deepEqual(result, qualification());
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls[0].url,
    `https://api.e2b.app/teams/${profile.projectId}/metrics?start=${current / 1000 - 60}&end=${current / 1000}`,
  );
  assert.equal(f.calls[1].url, `https://api.e2b.app/templates/${profile.templateId}?limit=100`);
  for (const { opts } of f.calls) {
    assert.equal(opts.method, "GET");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.headers["X-API-Key"], key);
    assert.ok(opts.signal instanceof AbortSignal);
  }
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.template));
});

test("mismatched project, authorization failure and malformed metrics stop before template or allocation", async () => {
  for (const response of [
    json({ message: key }, 403),
    json({ message: key }, 401),
    json({}, 200),
    json([], 404),
  ]) {
    const f = fetchFixture(() => response);
    await assert.rejects(verifyE2BDevelopmentAccess(input(), f), (error) => {
      assert.match(error.message, /^SYNTHETIC_LAB_/);
      assert.equal(error.message.includes(key), false);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test("immutable build identity, readiness, actual sizing and secure envd are checked before allocation", async () => {
  for (const drift of [
    { buildID: "44444444-4444-4444-8444-444444444444" },
    { status: "building" },
    { cpuCount: 8 },
    { memoryMB: 8192 },
    { diskSizeMB: 20480 },
    { diskSizeMB: undefined },
    { envdVersion: "0.1.9" },
    { envdVersion: key },
  ]) {
    const f = fetchFixture((url) =>
      url.includes("/metrics?")
        ? json([])
        : json({ templateID: profile.templateId, builds: [{ ...build(), ...drift }] }),
    );
    await assert.rejects(verifyE2BDevelopmentAccess(input(), f), /TRANSPORT_DENIED/);
    assert.equal(f.calls.length, 2);
  }
});

test("build pagination rejects duplicate pins, repeated cursors and incomplete bounded scans", async () => {
  const next = fetchFixture((url, _opts, n) =>
    url.includes("/metrics?")
      ? json([])
      : json(
          { templateID: profile.templateId, builds: n === 2 ? [] : [build()] },
          200,
          n === 2 ? { "x-next-token": "second" } : {},
        ),
  );
  assert.deepEqual(
    (await verifyE2BDevelopmentAccess(input(), next)).template,
    qualification().template,
  );
  const duplicate = fetchFixture((url) =>
    url.includes("/metrics?")
      ? json([])
      : json({ templateID: profile.templateId, builds: [build(), build()] }),
  );
  await assert.rejects(verifyE2BDevelopmentAccess(input(), duplicate), /DENIED/);
  const repeat = fetchFixture((url) =>
    url.includes("/metrics?")
      ? json([])
      : json({ templateID: profile.templateId, builds: [] }, 200, { "x-next-token": "repeat" }),
  );
  await assert.rejects(verifyE2BDevelopmentAccess(input(), repeat), /DENIED/);
  assert.equal(repeat.calls.length, 3);
});

test("native response bodies are bounded and redirects/non-JSON/raw fetch errors fail closed", async () => {
  for (const fault of ["foreign_url", "excessive_length"]) {
    let cancelled = 0;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          ...(fault === "excessive_length" ? { "content-length": "9999999" } : {}),
        },
      },
    );
    if (fault === "foreign_url")
      Object.defineProperty(response, "url", { value: "https://foreign.test/capture" });
    await assert.rejects(
      verifyE2BDevelopmentAccess(
        input(),
        fetchFixture(() => response),
      ),
      /DENIED/,
    );
    assert.equal(cancelled, 1, fault);
  }
  for (const reply of [
    new Response("{}", { status: 302, headers: { Location: "https://foreign.test" } }),
    new Response("[]", { status: 200, headers: { "content-type": "text/plain" } }),
    new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "9999999" },
    }),
    json(["x".repeat(70000)]),
  ]) {
    await assert.rejects(
      verifyE2BDevelopmentAccess(
        input(),
        fetchFixture(() => reply),
      ),
      /DENIED|FAILED/,
    );
  }
  const hostile = new Proxy(Error(key), {
    getPrototypeOf() {
      throw Error(key);
    },
    getOwnPropertyDescriptor() {
      throw Error(key);
    },
  });
  await assert.rejects(
    verifyE2BDevelopmentAccess(
      input(),
      fetchFixture(() => {
        throw hostile;
      }),
    ),
    (error) => {
      assert.equal(error.message, "SYNTHETIC_LAB_E2B_PROVIDER_FAILED");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("preflight snapshots key, mode, project and build before its first await", async () => {
  const options = input();
  let unblock;
  const wait = new Promise((resolve) => {
    unblock = resolve;
  });
  const f = fetchFixture(async (url) => {
    if (url.includes("/metrics?")) {
      await wait;
      return json([]);
    }
    return json({ templateID: profile.templateId, builds: [build()] });
  });
  const pending = verifyE2BDevelopmentAccess(options, f);
  options.apiKey = "e2b_changed_private_key_after_await";
  options.mode = "cleanup";
  options.profile.projectId = "44444444-4444-4444-8444-444444444444";
  options.profile.templateBuildId = "55555555-5555-4555-8555-555555555555";
  unblock();
  assert.deepEqual(await pending, qualification());
  assert.ok(f.calls.every(({ opts }) => opts.headers["X-API-Key"] === key));
});

test("cleanup qualification retains actual project proof while skipping new-allocation build checks", async () => {
  const f = fetchFixture();
  assert.deepEqual(await verifyE2BDevelopmentAccess({ ...input(), mode: "cleanup" }, f), {
    ...qualification(),
    template: null,
  });
  assert.equal(f.calls.length, 1);
});

function nativeInfo(change = {}) {
  return {
    sandboxID: id,
    templateID: profile.templateId,
    metadata: { ...operation.metadata },
    envdAccessToken: "synthetic_private_controller_token",
    allowInternetAccess: false,
    cpuCount: 2,
    memoryMB: 512,
    domain: "e2b.app",
    volumeMounts: [],
    network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
    lifecycle: { onTimeout: "kill", autoResume: false },
    ...change,
  };
}
test("native inspect keeps only authenticated-controller boolean and checks current controls", async () => {
  const f = fetchFixture(() => json(nativeInfo()));
  assert.equal(await verifyE2BDevelopmentControllerAccess(input(), id, context(), f), true);
  assert.equal(f.calls[0].url, `https://api.e2b.app/sandboxes/${id}`);
  assert.equal(
    await verifyE2BDevelopmentControllerAccess(
      input(),
      id,
      context(),
      fetchFixture(() => json(nativeInfo({ domain: null, volumeMounts: undefined }))),
    ),
    true,
  );
  for (const drift of [
    { envdAccessToken: undefined },
    { allowInternetAccess: true },
    { domain: "foreign.test" },
    { network: { allowOut: ["*"], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } },
    { lifecycle: { onTimeout: "pause", autoResume: true } },
    { volumeMounts: [{ name: "foreign", path: "/mnt" }] },
  ]) {
    assert.equal(
      await verifyE2BDevelopmentControllerAccess(
        input(),
        id,
        context(),
        fetchFixture(() => json(nativeInfo(drift))),
      ),
      false,
    );
  }
  for (const drift of [
    { sandboxID: "foreign" },
    { metadata: { ...operation.metadata, morrowSource: "a".repeat(64) } },
  ])
    await assert.rejects(
      verifyE2BDevelopmentControllerAccess(
        input(),
        id,
        context(),
        fetchFixture(() => json(nativeInfo(drift))),
      ),
      /DENIED/,
    );
});

test("create sends the immutable template with fixed no-retry/private lifecycle and no guest keys", async () => {
  const f = fixture();
  const observed = await f.port.create({ profile, operation }, context());
  assert.equal(observed.id, id);
  assert.equal(observed.network.controllerAuth, true);
  const call = f.calls.find(([method]) => method === "create");
  assert.equal(call[1], `${profile.templateId}:${profile.templateBuildId}`);
  assert.equal(call[2].apiUrl, "https://api.e2b.app");
  assert.equal(call[2].domain, "e2b.app");
  assert.equal(call[2].retries, 0);
  assert.equal(call[2].debug, false);
  assert.equal(call[2].httpVersion, "1.1");
  assert.equal(call[2].timeoutMs, 585000);
  assert.equal(call[2].requestTimeoutMs, 10000);
  assert.deepEqual(call[2].envs, {});
  assert.deepEqual(call[2].metadata, operation.metadata);
  assert.deepEqual(call[2].lifecycle, { onTimeout: "kill", autoResume: false });
  assert.deepEqual(call[2].network, {
    allowOut: [],
    denyOut: ["0.0.0.0/0"],
    allowPublicTraffic: false,
  });
  assert.equal(JSON.stringify(call[2].envs).includes(key), false);
  await assert.rejects(f.port.create({ profile, operation }, context()), /DENIED/);
  assert.equal(f.calls.filter(([method]) => method === "create").length, 1);
});

test("uncertain create never repeats; readonly reconciliation includes paused sandboxes", async () => {
  const f = fixture({ state: "paused" });
  f.sdk.create = async () => {
    f.calls.push(["uncertain-create"]);
    throw Error(key);
  };
  await assert.rejects(f.port.create({ profile, operation }, context()), /PROVIDER_FAILED/);
  await assert.rejects(f.port.create({ profile, operation }, context()), /DENIED/);
  const result = await f.port.getByOperation(operation, context());
  assert.equal(result.complete, true);
  assert.equal(result.resources[0].state, "paused");
  assert.deepEqual(f.calls.find(([method]) => method === "list")[1].query.state, [
    "running",
    "paused",
  ]);
  assert.equal(
    f.calls.some(([method]) => method === "connect"),
    false,
  );
});

test("owned safety drift remains observable for deletion but prevents every probe", async () => {
  for (const drift of [
    { cpuCount: 8 },
    { memoryMB: 8192 },
    { allowInternetAccess: true },
    { network: { allowOut: [], denyOut: [], allowPublicTraffic: true } },
    { lifecycle: { onTimeout: "pause", autoResume: false } },
    { endAt: new Date(operation.deadlineMs + 1) },
  ]) {
    const f = fixture(drift);
    const result = await f.port.getByOperation(operation, context());
    assert.equal(result.resources[0].id, id);
    await assert.rejects(
      f.port.writeMarker(id, operation.markerPath, operation.markerValue, context()),
      /DENIED/,
    );
    await f.port.kill(id, context());
    assert.equal(await f.port.inspect(id, context()), null);
    assert.equal(
      f.calls.some(([method]) => method === "write"),
      false,
    );
  }
});

test("SDK omitted default domain is normalized only to the fixed official origin", async () => {
  const f = fixture({ sandboxDomain: undefined });
  const observed = await f.port.create({ profile, operation }, context());
  assert.equal(observed.network.controllerAuth, true);
  await f.port.writeMarker(id, operation.markerPath, operation.markerValue, context());
});

test("foreign identity and exact metadata denial precedes auth/probes/deletion", async () => {
  for (const drift of [
    { sandboxId: "foreign" },
    { templateId: "foreign" },
    {
      metadata: { ...operation.metadata, morrowOperation: "44444444-4444-4444-8444-444444444444" },
    },
    { metadata: { ...operation.metadata, extra: "private-provider-output" } },
  ]) {
    const f = fixture(drift);
    await assert.rejects(f.port.inspect(id, context()), /DENIED/);
    await assert.rejects(f.port.kill(id, context()), /DENIED/);
    assert.equal(
      f.calls.some(([method]) => ["auth", "write", "kill", "connect"].includes(method)),
      false,
    );
  }
});

test("fixed marker files survive full pause/explicit restore without claiming memory proof", async () => {
  const f = fixture();
  await f.port.create({ profile, operation }, context());
  await f.port.writeMarker(id, operation.markerPath, operation.markerValue, context());
  assert.equal(await f.port.readMarker(id, operation.markerPath, context()), operation.markerValue);
  await f.port.pause(id, context());
  assert.equal((await f.port.inspect(id, context())).state, "paused");
  assert.equal((await f.port.inspect(id, context())).lifecycle.endAtMs, null);
  await f.port.restore(id, context());
  assert.equal(await f.port.readMarker(id, operation.markerPath, context()), operation.markerValue);
  assert.equal(f.calls.find(([method]) => method === "pause")[2].mode, "full");
  assert.equal(f.calls.find(([method]) => method === "connect")[2].onResume, "restore");
  assert.equal(f.calls.find(([method]) => method === "connect")[2].timeoutMs, 585000);
  for (const [path, value] of [
    ["/tmp/foreign", operation.markerValue],
    [operation.markerPath, "arbitrary"],
  ])
    await assert.rejects(f.port.writeMarker(id, path, value, context()), /DENIED/);
  f.corrupt();
  await assert.rejects(f.port.readMarker(id, operation.markerPath, context()), /DENIED/);
});

test("cleanup mode can delete original paused resource without create, files, pause or resume", async () => {
  const f = fixture({ state: "paused" });
  const port = createE2BDevelopmentTransport({
    ...f.opts,
    mode: "cleanup",
    qualification: { ...qualification(), template: null },
  });
  await assert.rejects(port.create({ profile, operation }, context()), /DENIED/);
  await assert.rejects(
    port.writeMarker(id, operation.markerPath, operation.markerValue, context()),
    /DENIED/,
  );
  await assert.rejects(port.pause(id, context()), /DENIED/);
  await assert.rejects(port.restore(id, context()), /DENIED/);
  await port.kill(id, context());
  assert.equal(await port.inspect(id, context()), null);
  assert.equal(
    f.calls.some(([method]) => ["create", "write", "read", "pause", "connect"].includes(method)),
    false,
  );
});

test("delete requires readonly verified absence and does not treat an opaque404 as absence", async () => {
  const f = fixture();
  f.sdk.kill = async () => {
    f.calls.push(["unfinished-kill"]);
    return true;
  };
  await assert.rejects(f.port.kill(id, context()), /PROVIDER_FAILED/);
  for (const failure of [
    Error("404"),
    { statusCode: 404 },
    new Proxy(Error(key), {
      getPrototypeOf() {
        throw Error(key);
      },
    }),
  ]) {
    f.sdk.getInfo = async () => {
      throw failure;
    };
    await assert.rejects(f.port.inspect(id, context()), (error) => {
      assert.equal(error.message, "SYNTHETIC_LAB_E2B_PROVIDER_FAILED");
      return true;
    });
  }
  f.sdk.getInfo = async () => {
    throw new SandboxNotFoundError();
  };
  assert.equal(await f.port.inspect(id, context()), null);
});

test("malformed caller options and hostile accessors never reach provider calls", async () => {
  const f = fixture();
  const changed = { ...f.opts, profile: { ...profile, merchantRouting: true } };
  assert.throws(() => createE2BDevelopmentTransport(changed), /DENIED/);
  const hostile = { ...f.opts };
  Object.defineProperty(hostile, "apiKey", {
    enumerable: true,
    get() {
      throw Error(key);
    },
  });
  assert.throws(() => createE2BDevelopmentTransport(hostile), /DENIED/);
  const extra = { profile, operation, arbitraryCode: "unsafe" };
  await assert.rejects(f.port.create(extra, context()), /DENIED/);
  assert.equal(f.calls.length, 0);
});

test("foreign creation/restore domains and IDs are rejected before any guest method", async () => {
  for (const drift of [
    { sandboxDomain: "foreign.test" },
    { sandboxId: "../foreign" },
    { trafficAccessToken: undefined },
  ]) {
    const f = fixture();
    Object.assign(f.handle, drift);
    await assert.rejects(f.port.create({ profile, operation }, context()), /DENIED/);
    assert.deepEqual(
      f.calls.map(([method]) => method),
      ["create"],
    );
  }
  const f = fixture();
  await f.port.create({ profile, operation }, context());
  await f.port.pause(id, context());
  const before = f.calls.length;
  f.handle.sandboxDomain = "foreign.test";
  await assert.rejects(f.port.restore(id, context()), /DENIED/);
  assert.equal(
    f.calls.slice(before).some(([method]) => ["write", "read"].includes(method)),
    false,
  );
});

test("deadlines/cancellation bound hanging effects and preclude calls before authorization", async () => {
  const f = fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    f.port.create({ profile, operation }, { deadlineMs: current + 1000, signal: cancelled.signal }),
    /CANCELLED/,
  );
  assert.equal(f.calls.length, 0);
  // A new adapter models a separate controller process; the first was marked attempted and cannot retry.
  const next = fixture();
  let creates = 0;
  next.sdk.create = () => {
    creates++;
    return new Promise(() => {});
  };
  await assert.rejects(next.port.create({ profile, operation }, context(current + 5)), /DEADLINE/);
  assert.equal(creates, 1);
});

test("adapter qualification and input bindings are immutable across later caller mutation", async () => {
  const f = fixture();
  f.opts.mode = "cleanup";
  f.opts.apiKey = "e2b_changed_private_key_after_factory";
  f.opts.profile.cpu = 8;
  f.opts.operation.metadata.morrowSource = "a".repeat(64);
  f.opts.qualification.template.cpu = 8;
  await f.port.create({ profile, operation }, context());
  assert.equal(f.calls.find(([method]) => method === "create")[2].apiKey, key);
  assert.equal(f.port.qualification.template.cpu, 2);
});

test("pinned real SDK serializes v2 creation/pause/restore without uncertain mutation retries", async () => {
  const { spawnSync } = await import("node:child_process");
  const probe = async function () {
    const assert = (await import("node:assert/strict")).default;
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.resolve("e2b"));
    const undici = require("undici");
    const http = (await import("node:http")).default;
    const https = (await import("node:https")).default;
    const net = (await import("node:net")).default;
    let externalCalls = 0;
    const deny = () => {
      externalCalls++;
      throw Error("PROBE_EXTERNAL_NETWORK_DENIED");
    };
    http.request = http.get = https.request = https.get = net.connect = deny;
    globalThis.fetch = deny;
    let mutationAttempts = 0;
    let failure;
    const calls = [];
    undici.fetch = async (request, init) => {
      const req = new Request(request, init);
      if (new URL(req.url).origin !== "https://api.e2b.app") throw Error("PROBE_ORIGIN_DENIED");
      const body = req.method === "POST" ? await req.json() : null;
      calls.push({ path: new URL(req.url).pathname, method: req.method, body });
      if (req.method === "POST" && req.url.endsWith("/v2/sandboxes")) {
        mutationAttempts++;
        if (failure === "network") throw TypeError("synthetic connection reset");
        if (failure === "503")
          return new Response(JSON.stringify({ code: 503, message: "synthetic" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        return new Response(
          JSON.stringify({
            sandboxID: failure === "malformed-envd" ? "foreign_VM_9" : "probe_VM_1",
            templateID: "probe_template",
            envdVersion: failure === "malformed-envd" ? "0.0.0" : "0.6.2",
            envdAccessToken: "synthetic_controller",
            trafficAccessToken: "synthetic_traffic",
            domain: failure === "foreign-domain" ? "foreign.test" : "e2b.app",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (req.url.endsWith("/pause")) return new Response(null, { status: 204 });
      if (req.url.endsWith("/connect"))
        return new Response(
          JSON.stringify({
            sandboxID: "probe_VM_1",
            templateID: "probe_template",
            envdVersion: "0.6.2",
            envdAccessToken: "synthetic_controller",
            trafficAccessToken: "synthetic_traffic",
            domain: "e2b.app",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      if (req.method === "GET")
        return new Response(JSON.stringify({ code: 404, message: "synthetic missing" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      throw Error("PROBE_ROUTE_DENIED");
    };
    const { Sandbox, SandboxNotFoundError } = await import("e2b");
    const { createGuardedE2BAllocationSandbox } = await import(
      "./packages/runtime-adapters/src/e2b/development-transport.ts"
    );
    const AllocationSandbox = createGuardedE2BAllocationSandbox(Sandbox);
    const options = {
      apiKey: "e2b_synthetic_pinned_sdk_test_key",
      apiUrl: "https://api.e2b.app",
      domain: "e2b.app",
      debug: false,
      retries: 0,
      httpVersion: "1.1",
      requestTimeoutMs: 1000,
    };
    const create = () =>
      AllocationSandbox.create("probe_template:22222222-2222-4222-8222-222222222222", {
        ...options,
        timeoutMs: 585000,
        envs: {},
        metadata: { morrowLab: "P04.T01h" },
        allowInternetAccess: false,
        lifecycle: { onTimeout: "kill", autoResume: false },
        network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
      });
    await create();
    assert.deepEqual(calls[0].body, {
      templateID: "probe_template:22222222-2222-4222-8222-222222222222",
      metadata: { morrowLab: "P04.T01h" },
      envVars: {},
      timeout: 585,
      allow_internet_access: false,
      network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
      autoPause: false,
      autoResume: { enabled: false },
    });
    const beforeSpoof = calls.length;
    failure = "foreign-domain";
    const spoofed = await create();
    assert.equal(spoofed.sandboxDomain, "foreign.test");
    assert.equal(calls.length - beforeSpoof, 1); // Constructor performs no envd request.
    failure = undefined;
    const beforeCompensation = calls.length;
    failure = "malformed-envd";
    await assert.rejects(create(), /SYNTHETIC_LAB_E2B_TRANSPORT_DENIED/);
    assert.deepEqual(
      calls.slice(beforeCompensation).map(({ method }) => method),
      ["POST"],
    );
    assert.equal(
      calls.some(({ method }) => method === "DELETE"),
      false,
    );
    failure = undefined;
    await Sandbox.pause("probe_VM_1", { ...options, mode: "full" });
    assert.deepEqual(calls[3], {
      path: "/sandboxes/probe_VM_1/pause",
      method: "POST",
      body: { memory: true },
    });
    await Sandbox.connect("probe_VM_1", { ...options, timeoutMs: 120000, onResume: "restore" });
    assert.deepEqual(calls[4], {
      path: "/v2/sandboxes/probe_VM_1/connect",
      method: "POST",
      body: { timeout: 120 },
    });
    await assert.rejects(Sandbox.getInfo("probe_VM_1", options), SandboxNotFoundError);
    for (const type of ["network", "503"]) {
      const before = mutationAttempts;
      failure = type;
      await assert.rejects(create());
      assert.equal(mutationAttempts - before, 1);
    }
    assert.equal(externalCalls, 0);
    console.log(
      JSON.stringify({ actualSdkLifecycleCalls: 6, uncertainCreateAttempts: 2, externalCalls: 0 }),
    );
  };
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `(${probe.toString()})().catch(() => { process.exitCode = 1; });`,
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: {},
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32768,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    actualSdkLifecycleCalls: 6,
    uncertainCreateAttempts: 2,
    externalCalls: 0,
  });
});
