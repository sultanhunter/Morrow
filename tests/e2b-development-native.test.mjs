import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  createE2BNativeDevelopmentTransport,
  snapshotE2BDevelopmentDiagnostics,
  markE2BDevelopmentCleanup,
} from "../packages/runtime-adapters/src/e2b/development-native.ts";
import { discoverE2BDevelopmentOwnedTemplates } from "../packages/runtime-adapters/src/e2b/development-transport.ts";
import {
  prepareSyntheticLabOperation,
  runSyntheticLab,
} from "../packages/infrastructure/src/synthetic-runtime-lab.ts";
const API = "https://api.e2b.app";
const ENVD = "https://sandbox.e2b.app";
const current = Date.parse("2026-10-14T16:00:00Z");
const p = {
  schemaVersion: 1,
  task: "P04.T01h",
  planSequence: 67,
  scope: "builtin_synthetic_operator",
  environment: "development",
  providerId: "e2b",
  projectId: "11111111-1111-4111-8111-111111111111",
  templateId: "native_base_1",
  templateBuildId: "22222222-2222-4222-8222-222222222222",
  cpu: 2,
  memoryMiB: 512,
  diskMiB: 10240,
  maximumWallMs: 600000,
  expectedCreditCeilingUsd: "0.25",
  outbound: "deny_all",
  merchantRouting: false,
};
const op = prepareSyntheticLabOperation(
  p,
  "33333333-3333-4333-8333-333333333333",
  current,
  "b".repeat(64),
);
const key = "e2b_synthetic_native_test_key_only";
const token = "synthetic_native_envd_token_only";
const id = "native_VM_1";
const args = (mode = "allocate") => ({
  apiKey: key,
  profile: structuredClone(p),
  operation: structuredClone(op),
  mode,
});
const ctx = (deadlineMs = current + 10000) => ({
  deadlineMs,
  signal: new AbortController().signal,
});
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function fixture() {
  const calls = [];
  let state = null;
  let marker;
  let clock = current;
  const hooks = {};
  const build = {
    buildID: p.templateBuildId,
    status: "ready",
    cpuCount: 2,
    memoryMB: 512,
    diskSizeMB: 10240,
    envdVersion: "0.6.2",
  };
  const connection = () => ({
    sandboxID: id,
    templateID: p.templateId,
    envdVersion: state.envdVersion,
    domain: "e2b.app",
    envdAccessToken: token,
    trafficAccessToken: "synthetic_native_traffic_token",
  });
  const seed = (changed = {}) => {
    state = {
      sandboxID: id,
      templateID: p.templateId,
      metadata: { ...op.metadata },
      envdVersion: "0.6.2",
      startedAt: new Date(clock).toISOString(),
      endAt: new Date(clock + 585000).toISOString(),
      state: "running",
      cpuCount: 2,
      memoryMB: 512,
      diskSizeMB: 10240,
      allowInternetAccess: false,
      domain: "e2b.app",
      envdAccessToken: token,
      network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
      lifecycle: { onTimeout: "kill", autoResume: false },
      volumeMounts: [],
      ...changed,
    };
  };
  const request = async (url, opts) => {
    const parsed = new URL(url);
    calls.push({ url, opts });
    assert.equal(opts.redirect, "error");
    assert.ok(opts.signal instanceof AbortSignal);
    assert.ok([API, ENVD].includes(parsed.origin));
    if (hooks.request) {
      const reply = await hooks.request(url, opts, state);
      if (reply !== undefined) return reply;
    }
    if (parsed.origin === API) {
      assert.equal(opts.headers["X-API-Key"], key);
      assert.equal(opts.headers["X-Access-Token"], undefined);
      if (parsed.pathname.endsWith("/metrics")) return json([]);
      if (parsed.pathname === "/v2/templates")
        return json([
          {
            templateID: p.templateId,
            buildID: p.templateBuildId,
            buildStatus: "ready",
            cpuCount: 2,
            memoryMB: 512,
            diskSizeMB: 10240,
            envdVersion: "0.6.2",
          },
        ]);
      if (parsed.pathname.startsWith("/templates/"))
        return json({ templateID: p.templateId, public: true, builds: [build] });
      if (parsed.pathname === "/v2/sandboxes" && opts.method === "GET")
        return json(state ? [state] : []);
      if (parsed.pathname === "/v2/sandboxes" && opts.method === "POST") {
        const body = JSON.parse(opts.body);
        assert.deepEqual(body, {
          templateID: `${p.templateId}:${p.templateBuildId}`,
          timeout: 585,
          autoPause: false,
          autoResume: { enabled: false },
          allow_internet_access: false,
          network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: false },
          metadata: op.metadata,
          envVars: {},
        });
        seed();
        return json(connection(), 201);
      }
      if (parsed.pathname === `/sandboxes/${id}` && opts.method === "GET")
        return state ? json(state) : json({ code: 404 }, 404);
      if (parsed.pathname === `/sandboxes/${id}` && opts.method === "DELETE") {
        state = null;
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname === `/sandboxes/${id}/pause`) {
        state.state = "paused";
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname === `/v2/sandboxes/${id}/connect`) {
        const body = JSON.parse(opts.body);
        assert.equal(body.memory, true);
        assert.ok(body.timeout <= 585);
        clock += 100;
        state.state = "running";
        state.startedAt = new Date(clock).toISOString();
        state.endAt = new Date(clock + body.timeout * 1000).toISOString();
        return json(connection(), 201);
      }
    } else {
      assert.equal(opts.headers["X-API-Key"], undefined);
      assert.equal(opts.headers["X-Access-Token"], token);
      assert.equal(opts.headers["E2b-Sandbox-Id"], id);
      assert.equal(opts.headers["E2b-Sandbox-Port"], "49983");
      assert.equal(opts.headers["Accept-Encoding"], "identity");
      assert.equal(parsed.pathname, "/files");
      assert.equal(parsed.searchParams.get("path"), op.markerPath);
      assert.equal(opts.headers["Content-Type"], undefined);
      if (opts.method === "POST") {
        assert.ok(opts.body instanceof FormData);
        assert.deepEqual([...opts.body.keys()], ["file"]);
        const file = opts.body.get("file");
        assert.equal(file.name, op.markerPath);
        marker = await file.text();
        assert.equal(marker, op.markerValue);
        return new Response(JSON.stringify([{ path: op.markerPath, type: "file" }]), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(marker, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    throw Error("SYNTHETIC_FIXTURE_ROUTE_DENIED");
  };
  return {
    calls,
    hooks,
    seed,
    fetch: request,
    now: () => clock,
    get state() {
      return state;
    },
    change(changes) {
      Object.assign(state, changes);
    },
    tick(ms) {
      clock += ms;
    },
  };
}

test("native port completes the neutral journal lifecycle and fixed-file persistence", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  const saved = [];
  const report = await runSyntheticLab(p, op.operationId, port, {
    startedAtMs: current,
    sourceSha256: op.sourceSha256,
    now: f.now,
    signal: new AbortController().signal,
    persist: async (entry) => saved.push(structuredClone(entry)),
  });
  assert.equal(report.status, "passed");
  assert.equal(report.cleanup, "verified_deleted");
  assert.equal(f.state, null);
  assert.equal(
    f.calls.filter(
      ({ url, opts }) => new URL(url).pathname === "/v2/sandboxes" && opts.method === "POST",
    ).length,
    1,
  );
  assert.ok(saved.some((entry) => entry.phase === "paused"));
  assert.ok(!JSON.stringify(report).includes(key));
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.ok(!JSON.stringify(saved).includes(token));
});

test("original60 native recipes cannot allocate but original cleanup remains available", async () => {
  const original = { ...p, planSequence: 60 };
  const operation = prepareSyntheticLabOperation(
    original,
    op.operationId,
    current,
    op.sourceSha256,
  );
  const f = fixture();
  const input = { apiKey: key, profile: original, operation, mode: "allocate" };
  await assert.rejects(createE2BNativeDevelopmentTransport(input, f), /DENIED/);
  assert.deepEqual(f.calls, []);
  f.seed({ metadata: operation.metadata, state: "paused", endAt: null });
  const cleanup = await createE2BNativeDevelopmentTransport({ ...input, mode: "cleanup" }, f);
  await cleanup.kill(id, ctx());
  assert.equal(f.state, null);
  assert.equal(f.calls.filter(({ opts }) => opts.method === "DELETE").length, 1);
  assert.equal(
    f.calls.some(({ opts }) => opts.method === "POST"),
    false,
  );
});

test("read-only owned discovery obtains actual resources and immutable IDs without an allocation profile", async () => {
  const f = fixture();
  const result = await discoverE2BDevelopmentOwnedTemplates(
    { apiKey: key, projectId: p.projectId },
    f,
  );
  assert.equal(result.projectId, p.projectId);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.builds, [
    {
      templateId: p.templateId,
      templateBuildId: p.templateBuildId,
      cpu: 2,
      memoryMiB: 512,
      diskMiB: 10240,
      envdVersion: "0.6.2",
    },
  ]);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].url, `${API}/v2/templates?teamID=${p.projectId}&limit=100`);
  assert.equal(result.completeTemplateCatalogue, true);
  assert.equal(result.runtimeProfileQualified, false);
  assert.ok(f.calls.every(({ opts }) => opts.method === "GET"));
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("empty owned catalogue retains project proof without template or runtime qualification", async () => {
  const f = fixture();
  f.hooks.request = (url) => (new URL(url).pathname === "/v2/templates" ? json([]) : undefined);
  const result = await discoverE2BDevelopmentOwnedTemplates(
    { apiKey: key, projectId: p.projectId },
    f,
  );
  assert.equal(result.binding, "authenticated_project_metrics");
  assert.equal(result.readOnly, true);
  assert.equal(result.runtimeProfileQualified, false);
  assert.equal(result.completeTemplateCatalogue, true);
  assert.deepEqual(result.builds, []);
  assert.equal(f.calls.length, 2);
  assert.ok(
    f.calls.every(
      ({ url, opts }) =>
        opts.method === "GET" && !url.includes("/aliases/") && !url.includes("/sandboxes"),
    ),
  );
});

test("owned discovery denies wrong-project, forbidden catalogue and build ownership without fallback", async () => {
  for (const target of ["metrics", "catalogue", "build"]) {
    const f = fixture();
    f.hooks.request = (url) => {
      const path = new URL(url).pathname;
      if (
        (target === "metrics" && path.endsWith("/metrics")) ||
        (target === "catalogue" && path === "/v2/templates") ||
        (target === "build" && path === `/templates/${p.templateId}`)
      )
        return json({ code: 403 }, 403);
    };
    await assert.rejects(
      discoverE2BDevelopmentOwnedTemplates({ apiKey: key, projectId: p.projectId }, f),
      /DENIED/,
    );
    assert.equal(f.calls.length, target === "metrics" ? 1 : target === "catalogue" ? 2 : 3);
    assert.ok(
      f.calls.every(
        ({ url, opts }) =>
          opts.method === "GET" && !url.includes("/aliases/") && !url.includes("/sandboxes"),
      ),
    );
  }
});

test("owned catalogue and build pagination must finish without repeated cursors, IDs or incomplete pages", async () => {
  const paged = fixture();
  paged.hooks.request = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v2/templates" && !parsed.searchParams.has("nextToken"))
      return json([], 200, { "x-next-token": "catalogue_2" });
    if (parsed.pathname === `/templates/${p.templateId}` && !parsed.searchParams.has("nextToken"))
      return json({ templateID: p.templateId, builds: [] }, 200, { "x-next-token": "build_2" });
  };
  const resolved = await discoverE2BDevelopmentOwnedTemplates(
    { apiKey: key, projectId: p.projectId },
    paged,
  );
  assert.equal(resolved.builds.length, 1);
  assert.equal(resolved.completeTemplateCatalogue, true);
  assert.equal(paged.calls.length, 5);
  for (const fault of [
    "catalogue_cycle",
    "catalogue_bound",
    "duplicate_template",
    "build_cycle",
    "duplicate_build",
  ]) {
    const f = fixture();
    let number = 0;
    f.hooks.request = (url) => {
      const path = new URL(url).pathname;
      if (path === "/v2/templates" && fault.startsWith("catalogue_"))
        return json([], 200, {
          "x-next-token": fault === "catalogue_cycle" ? "repeat" : `page_${number++}`,
        });
      if (path === "/v2/templates" && fault === "duplicate_template")
        return json([
          { templateID: p.templateId, buildStatus: "building" },
          { templateID: p.templateId, buildStatus: "building" },
        ]);
      if (path === `/templates/${p.templateId}` && fault === "build_cycle")
        return json({ templateID: p.templateId, builds: [] }, 200, { "x-next-token": "repeat" });
      if (path === `/templates/${p.templateId}` && fault === "duplicate_build") {
        const build = {
          buildID: p.templateBuildId,
          status: "ready",
          cpuCount: 2,
          memoryMB: 512,
          diskSizeMB: 10240,
          envdVersion: "0.6.2",
        };
        return json({ templateID: p.templateId, builds: [build, build] });
      }
    };
    await assert.rejects(
      discoverE2BDevelopmentOwnedTemplates({ apiKey: key, projectId: p.projectId }, f),
      /DENIED/,
    );
    assert.ok(f.calls.length <= 9, fault);
  }
});

test("native owned build identity, readiness and listed resource tuple must agree before selection", async () => {
  for (const drift of [
    { templateID: "foreign_template" },
    { builds: [] },
    { status: "building" },
    { cpuCount: 1 },
    { memoryMB: 1024 },
    { diskSizeMB: 5120 },
    { envdVersion: "0.6.3" },
  ]) {
    const f = fixture();
    f.hooks.request = (url) => {
      if (new URL(url).pathname !== `/templates/${p.templateId}`) return;
      return json({
        templateID: p.templateId,
        builds: [
          {
            buildID: p.templateBuildId,
            status: "ready",
            cpuCount: 2,
            memoryMB: 512,
            diskSizeMB: 10240,
            envdVersion: "0.6.2",
            ...drift,
          },
        ],
        ...("templateID" in drift || "builds" in drift ? drift : {}),
      });
    };
    await assert.rejects(
      discoverE2BDevelopmentOwnedTemplates({ apiKey: key, projectId: p.projectId }, f),
      /DENIED/,
    );
  }
});

test("owned discovery snapshots selectors and never treats building or unsafe resources as eligible", async () => {
  const f = fixture();
  const options = { apiKey: key, projectId: p.projectId };
  f.hooks.request = (url) => {
    if (new URL(url).pathname.endsWith("/metrics")) {
      options.apiKey = "e2b_changed_after_start_only";
      options.projectId = "44444444-4444-4444-8444-444444444444";
    }
    if (new URL(url).pathname === "/v2/templates")
      return json([{ templateID: p.templateId, buildStatus: "building" }]);
  };
  const result = await discoverE2BDevelopmentOwnedTemplates(options, f);
  assert.equal(result.projectId, p.projectId);
  assert.deepEqual(result.builds, []);
  assert.equal(f.calls.length, 2);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.builds));
  assert.equal(result.runtimeProfileQualified, false);
  const unsafe = fixture();
  unsafe.hooks.request = (url) => {
    const path = new URL(url).pathname;
    if (path === "/v2/templates")
      return json([
        {
          templateID: p.templateId,
          buildID: p.templateBuildId,
          buildStatus: "ready",
          cpuCount: 8,
          memoryMB: 512,
          diskSizeMB: 10240,
          envdVersion: "0.6.2",
        },
      ]);
    if (path === `/templates/${p.templateId}`)
      return json({
        templateID: p.templateId,
        builds: [
          {
            buildID: p.templateBuildId,
            status: "ready",
            cpuCount: 8,
            memoryMB: 512,
            diskSizeMB: 10240,
            envdVersion: "0.6.2",
          },
        ],
      });
  };
  const unsafeReport = await discoverE2BDevelopmentOwnedTemplates(
    { apiKey: key, projectId: p.projectId },
    unsafe,
  );
  assert.deepEqual(unsafeReport.builds, []);
  assert.equal(unsafeReport.runtimeProfileQualified, false);
});

test("native malformed allocation reply never compensates by deleting its foreign ID", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  f.hooks.request = (url, opts) =>
    new URL(url).pathname === "/v2/sandboxes" && opts.method === "POST"
      ? json(
          {
            sandboxID: "foreign_VM_2",
            templateID: p.templateId,
            envdVersion: "0.0.0",
            domain: "foreign.test",
          },
          201,
        )
      : undefined;
  await assert.rejects(port.create({ profile: p, operation: op }, ctx()), /DENIED/);
  assert.equal(
    f.calls.some(({ opts }) => opts.method === "DELETE"),
    false,
  );
  assert.equal(
    f.calls.some(({ url }) => url.includes("foreign")),
    false,
  );
  await assert.rejects(port.create({ profile: p, operation: op }, ctx()), /DENIED/);
  assert.equal(f.calls.filter(({ opts }) => opts.method === "POST").length, 1);
});

test("uncertain native creation is not replayed and reconciles its original owned metadata", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  f.hooks.request = (url, opts) => {
    if (new URL(url).pathname === "/v2/sandboxes" && opts.method === "POST") {
      f.seed();
      throw Error(key);
    }
  };
  await assert.rejects(port.create({ profile: p, operation: op }, ctx()), (error) => {
    assert.equal(error.message, "SYNTHETIC_LAB_E2B_PROVIDER_FAILED");
    return true;
  });
  await assert.rejects(port.create({ profile: p, operation: op }, ctx()), /DENIED/);
  const list = await port.getByOperation(op, ctx());
  assert.equal(list.complete, true);
  assert.equal(list.resources[0].id, id);
  const params = new URL(f.calls.find(({ url }) => url.includes("/v2/sandboxes?")).url)
    .searchParams;
  assert.equal(params.get("state"), "running,paused");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(params.get("metadata"))), op.metadata);
  await port.kill(id, ctx());
  assert.equal(f.state, null);
});

test("foreign metadata never authorizes guest access or deletion", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  f.seed({ metadata: { ...op.metadata, morrowSource: "a".repeat(64) } });
  await assert.rejects(port.inspect(id, ctx()), /DENIED/);
  await assert.rejects(port.kill(id, ctx()), /DENIED/);
  assert.equal(
    f.calls.some(({ url, opts }) => url.startsWith(ENVD) || opts.method === "DELETE"),
    false,
  );
});

test("owned positive resource-capacity drift blocks execution but remains cleanable", async () => {
  for (const changes of [
    { cpuCount: 8 },
    { memoryMB: 8192 },
    { diskSizeMB: 20480 },
    { envdVersion: "0.7.0" },
    { network: { denyOut: [], allowOut: ["*"], allowPublicTraffic: true } },
    { lifecycle: { onTimeout: "pause", autoResume: true } },
  ]) {
    const f = fixture();
    const port = await createE2BNativeDevelopmentTransport(args(), f);
    f.seed(changes);
    assert.equal((await port.inspect(id, ctx())).id, id);
    await assert.rejects(port.writeMarker(id, op.markerPath, op.markerValue, ctx()), /DENIED/);
    await port.kill(id, ctx());
    assert.equal(f.state, null);
    assert.equal(
      f.calls.some(({ url }) => url.startsWith(ENVD)),
      false,
    );
  }
});

test("cleanup after the original deadline never creates, reads guest files, pauses or restores", async () => {
  const f = fixture();
  f.seed({ state: "paused" });
  f.tick(700000);
  const port = await createE2BNativeDevelopmentTransport(args("cleanup"), f);
  await assert.rejects(port.restore(id, ctx(current + 900000)), /DENIED/);
  await port.kill(id, ctx(current + 900000));
  assert.equal(f.state, null);
  assert.ok(
    f.calls.every(
      ({ url, opts }) => !url.startsWith(ENVD) && ["GET", "DELETE"].includes(opts.method),
    ),
  );
  assert.equal(
    f.calls.some(({ url }) => url.includes("/templates/")),
    false,
  );
});

test("only exact fixed marker payloads and current native expiry can execute", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  await port.create({ profile: p, operation: op }, ctx());
  await assert.rejects(port.writeMarker(id, "/tmp/arbitrary", op.markerValue, ctx()), /DENIED/);
  await assert.rejects(port.writeMarker(id, op.markerPath, "arbitrary", ctx()), /DENIED/);
  f.change({ endAt: new Date(op.deadlineMs + 1).toISOString() });
  await assert.rejects(port.writeMarker(id, op.markerPath, op.markerValue, ctx()), /DENIED/);
  assert.equal(
    f.calls.some(({ url }) => url.startsWith(ENVD)),
    false,
  );
});

test("upload/download responses cannot propagate unknown data or exceed the marker bound", async () => {
  for (const response of [new Response("x".repeat(1000)), new Response("corrupted")]) {
    const f = fixture();
    const port = await createE2BNativeDevelopmentTransport(args(), f);
    f.seed();
    f.hooks.request = (url) => (url.startsWith(ENVD) ? response : undefined);
    await assert.rejects(port.readMarker(id, op.markerPath, ctx()), /DENIED/);
  }
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  f.seed();
  f.hooks.request = (url) =>
    url.startsWith(ENVD) ? json([{ path: "/tmp/foreign", type: "file" }]) : undefined;
  await assert.rejects(port.writeMarker(id, op.markerPath, op.markerValue, ctx()), /DENIED/);
});

test("foreign response URLs and fabricated foreign404 never qualify absence", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  f.hooks.request = (url) => {
    if (url.includes(`/sandboxes/${id}`)) {
      const response = json({ code: 404 }, 404);
      Object.defineProperty(response, "url", { value: "https://foreign.test/capture" });
      return response;
    }
  };
  await assert.rejects(port.inspect(id, ctx()), /DENIED/);
});

test("wrong content-type is canceled and hostile native errors are redacted", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  f.seed();
  let cancelled = 0;
  for (const headers of [
    { "content-type": "text/plain" },
    { "content-type": "application/json", "content-length": "9999999" },
  ]) {
    f.hooks.request = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { headers },
      );
    await assert.rejects(port.inspect(id, ctx()), /DENIED/);
  }
  assert.equal(cancelled, 2);
  f.hooks.request = () => {
    throw new Proxy(Error(key), {
      getOwnPropertyDescriptor() {
        throw Error(key);
      },
      getPrototypeOf() {
        throw Error(key);
      },
    });
  };
  await assert.rejects(port.inspect(id, ctx()), (error) => {
    assert.equal(error.message, "SYNTHETIC_LAB_E2B_PROVIDER_FAILED");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("unfinished native deletion retains failure until static owned absence is verified", async () => {
  const f = fixture();
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  f.seed();
  f.hooks.request = (_url, opts) =>
    opts.method === "DELETE" ? new Response(null, { status: 204 }) : undefined;
  await assert.rejects(port.kill(id, ctx()), /PROVIDER_FAILED/);
  assert.notEqual(f.state, null);
});

test("real redirect handling never forwards API keys or guest tokens to a foreign second hop", async () => {
  const require = createRequire(import.meta.resolve("e2b"));
  const { MockAgent, fetch: realFetch } = require("undici");
  for (const target of ["inspect", "create", "guestRead", "guestWrite"]) {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const origin = target.startsWith("guest") ? ENVD : API;
    const pathname = target.startsWith("guest")
      ? `/files?${new URLSearchParams({ path: op.markerPath })}`
      : target === "create"
        ? "/v2/sandboxes"
        : `/sandboxes/${id}`;
    const method = target === "create" || target === "guestWrite" ? "POST" : "GET";
    let foreignCalls = 0;
    let foreignCredential = false;
    agent
      .get(origin)
      .intercept({ path: pathname, method })
      .reply(307, null, { headers: { location: "https://foreign.test/capture" } });
    for (const foreignMethod of ["GET", "POST"])
      agent
        .get("https://foreign.test")
        .intercept({ path: "/capture", method: foreignMethod })
        .reply(
          404,
          (options) => {
            foreignCalls++;
            const headers = JSON.stringify(options.headers).toLowerCase();
            foreignCredential ||= headers.includes(key) || headers.includes(token);
            return { code: 404 };
          },
          { headers: { "content-type": "application/json" } },
        );
    const f = fixture();
    const port = await createE2BNativeDevelopmentTransport(args(), f);
    f.seed();
    f.hooks.request = (url, opts) =>
      new URL(url).origin === origin &&
      new URL(url).pathname + new URL(url).search === pathname &&
      opts.method === method
        ? realFetch(url, { ...opts, dispatcher: agent })
        : undefined;
    const action =
      target === "inspect"
        ? () => port.inspect(id, ctx())
        : target === "create"
          ? () => port.create({ profile: p, operation: op }, ctx())
          : target === "guestRead"
            ? () => port.readMarker(id, op.markerPath, ctx())
            : () => port.writeMarker(id, op.markerPath, op.markerValue, ctx());
    await assert.rejects(action(), /FAILED|DENIED/);
    assert.equal(foreignCalls, 0, target);
    assert.equal(foreignCredential, false, target);
    assert.equal(
      f.calls.filter(({ url, opts }) => url === `${origin}${pathname}` && opts.method === method)
        .length,
      1,
      target,
    );
    await agent.close();
  }
});

test("native TLS verification is required before qualification and every later credential request", async () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    for (const value of ["0", "false", ""]) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = value;
      const f = fixture();
      await assert.rejects(createE2BNativeDevelopmentTransport(args(), f), /DENIED/);
      assert.equal(f.calls.length, 0);
      await assert.rejects(
        discoverE2BDevelopmentOwnedTemplates({ apiKey: key, projectId: p.projectId }, f),
        /DENIED/,
      );
      assert.equal(f.calls.length, 0);
    }
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    const f = fixture(),
      port = await createE2BNativeDevelopmentTransport(args(), f);
    const before = f.calls.length;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    await assert.rejects(port.inspect(id, ctx()), /DENIED/);
    assert.equal(f.calls.length, before);
    await assert.rejects(port.kill(id, ctx()), /DENIED/);
    assert.equal(f.calls.length, before);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

test("native diagnostics distinguish write HTTP, decode, schema, redirect and hostile transport failures without reflection", async () => {
  for (const [fault, outcome, status] of [
    ["503", "http_rejected", 503],
    ["json", "decode_denied", 200],
    ["shape", "shape_denied", 200],
    ["redirect", "redirect_denied", 307],
    ["hostile", "transport_rejected", null],
  ]) {
    const f = fixture(),
      port = await createE2BNativeDevelopmentTransport(args(), f);
    f.seed();
    let traps = 0;
    f.hooks.request = (url) => {
      if (new URL(url).origin !== ENVD) return;
      if (fault === "hostile")
        throw new Proxy(Error(key + token), {
          get() {
            traps++;
            throw Error("never");
          },
          getOwnPropertyDescriptor() {
            traps++;
            throw Error("never");
          },
          ownKeys() {
            traps++;
            throw Error("never");
          },
        });
      if (fault === "503") return new Response(key + token, { status: 503 });
      if (fault === "json") return new Response("{broken" + key, { status: 200 });
      if (fault === "shape")
        return new Response(
          JSON.stringify([{ leaked: key, path: op.markerPath, type: "directory" }]),
          { status: 200 },
        );
      return new Response(null, {
        status: 307,
        headers: { location: "https://foreign.test/" + key },
      });
    };
    await assert.rejects(port.writeMarker(id, op.markerPath, op.markerValue, ctx()));
    const snapshot = snapshotE2BDevelopmentDiagnostics(port);
    assert.deepEqual(snapshot.firstExecutionFailure, {
      stage: "marker_write",
      endpoint: "guest_files",
      outcome,
      status,
      elapsedMs: 0,
    });
    assert.equal(snapshot.firstCleanupFailure, null);
    assert.equal(traps, 0);
    assert.equal(JSON.stringify(snapshot).includes(key), false);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(snapshot.requestCounts.total > 0 && snapshot.requestCounts.total <= 4096);
  }
});

test("initial marker read and cleanup failure remain separate and never overwrite the execution cause", async () => {
  const f = fixture(),
    port = await createE2BNativeDevelopmentTransport(args(), f);
  f.seed();
  await port.writeMarker(id, op.markerPath, op.markerValue, ctx());
  f.hooks.request = (url, options) =>
    new URL(url).origin === ENVD || options.method === "DELETE"
      ? new Response("private provider text", { status: 503 })
      : undefined;
  await assert.rejects(port.readMarker(id, op.markerPath, ctx()));
  const before = snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure;
  assert.equal(before.stage, "marker_initial_read");
  await assert.rejects(port.kill(id, ctx()));
  const after = snapshotE2BDevelopmentDiagnostics(port);
  assert.deepEqual(after.firstExecutionFailure, before);
  assert.deepEqual(after.firstCleanupFailure, {
    stage: "cleanup_delete",
    endpoint: "control_api",
    outcome: "http_rejected",
    status: 503,
    elapsedMs: 0,
  });
});

test("native diagnostic snapshot never accesses caller objects and records bounded request timeout", async () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error("never");
      },
      ownKeys() {
        traps++;
        throw Error("never");
      },
    },
  );
  assert.equal(snapshotE2BDevelopmentDiagnostics(hostile), null);
  assert.equal(traps, 0);
  const f = fixture(),
    port = await createE2BNativeDevelopmentTransport(args(), f);
  f.seed();
  f.hooks.request = (url) => (new URL(url).origin === ENVD ? new Promise(() => {}) : undefined);
  await assert.rejects(port.writeMarker(id, op.markerPath, op.markerValue, ctx(current + 5)));
  const failure = snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure;
  assert.equal(failure.stage, "marker_write");
  assert.equal(failure.outcome, "timeout");
  assert.equal(failure.status, null);
  assert.ok(failure.elapsedMs >= 0 && failure.elapsedMs <= 600000);
});

test("a diagnostic-only clock failure cannot prevent original owned deletion", async () => {
  const f = fixture();
  let failClock = false;
  const port = await createE2BNativeDevelopmentTransport(args(), {
    fetch: f.fetch,
    now: () => {
      if (failClock) {
        failClock = false;
        throw Error("instrumentation only");
      }
      return f.now();
    },
  });
  f.seed();
  failClock = true;
  await port.kill(id, ctx());
  assert.equal(f.state, null);
  assert.equal(snapshotE2BDevelopmentDiagnostics(port).firstCleanupFailure, null);
});

test("core-side cancellation marks the first failing cleanup GET without inventing an execution failure", async () => {
  const f = fixture(),
    port = await createE2BNativeDevelopmentTransport(args(), f),
    controller = new AbortController();
  let cleanup = false;
  f.hooks.request = (url, options) =>
    cleanup && new URL(url).pathname === `/sandboxes/${id}` && options.method === "GET"
      ? new Response("private cleanup response", { status: 503 })
      : undefined;
  const result = await runSyntheticLab(p, op.operationId, port, {
    startedAtMs: current,
    sourceSha256: op.sourceSha256,
    now: f.now,
    signal: controller.signal,
    onCleanup: () => {
      cleanup = true;
      markE2BDevelopmentCleanup(port);
    },
    persist: async (record) => {
      if (record.phase === "created") controller.abort();
    },
  });
  assert.equal(result.status, "unresolved");
  const snapshot = snapshotE2BDevelopmentDiagnostics(port);
  assert.equal(snapshot.firstExecutionFailure, null);
  assert.equal(snapshot.firstCleanupFailure.stage, "cleanup_absence");
  assert.equal(snapshot.firstCleanupFailure.outcome, "http_rejected");
  assert.equal(snapshot.firstCleanupFailure.status, 503);
});

test("the restored marker read has its own stage and a failing diagnostic callback never blocks cleanup", async () => {
  const f = fixture(),
    port = await createE2BNativeDevelopmentTransport(args(), f);
  let reads = 0;
  f.hooks.request = (url, options) =>
    new URL(url).origin === ENVD && options.method === "GET" && ++reads === 2
      ? new Response("private", { status: 503 })
      : undefined;
  const result = await runSyntheticLab(p, op.operationId, port, {
    startedAtMs: current,
    sourceSha256: op.sourceSha256,
    now: f.now,
    onCleanup: () => {
      throw Error("diagnostic sink failed");
    },
    persist: async () => {},
  });
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.state, null);
  assert.equal(
    snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure.stage,
    "marker_restored_read",
  );
});

test("rejected and nonsettling diagnostic observers are never awaited and cannot obstruct deletion", async () => {
  for (const observer of [
    () => Promise.reject(Error("diagnostic rejection")),
    () => new Promise(() => {}),
  ]) {
    const f = fixture(),
      port = await createE2BNativeDevelopmentTransport(args(), f);
    const result = await runSyntheticLab(p, op.operationId, port, {
      startedAtMs: current,
      sourceSha256: op.sourceSha256,
      now: f.now,
      onCleanup: observer,
      persist: async () => {},
    });
    assert.equal(result.cleanup, "verified_deleted");
    assert.equal(f.state, null);
  }
});

function restoreFixture(acknowledgment = {}, staticChanges = {}, response = null) {
  const f = fixture();
  f.hooks.request = (url, options) => {
    if (new URL(url).pathname !== `/v2/sandboxes/${id}/connect`) return;
    const body = JSON.parse(options.body);
    assert.equal(body.memory, true);
    f.tick(100);
    f.change({
      state: "running",
      startedAt: new Date(f.now()).toISOString(),
      endAt: new Date(f.now() + body.timeout * 1000).toISOString(),
      ...staticChanges,
    });
    if (response) return response();
    return json(
      {
        sandboxID: id,
        templateID: p.templateId,
        envdVersion: "0.6.2",
        domain: "e2b.app",
        ...acknowledgment,
      },
      201,
    );
  };
  return f;
}
const runRestoreFixture = async (f) => {
  const port = await createE2BNativeDevelopmentTransport(args(), f);
  const report = await runSyntheticLab(p, op.operationId, port, {
    startedAtMs: current,
    sourceSha256: op.sourceSha256,
    now: f.now,
    onCleanup: () => markE2BDevelopmentCleanup(port),
    persist: async () => {},
  });
  return { port, report };
};

test("restore accepts omitted or nullable POST credentials and uses only fresh static authentication", async () => {
  for (const acknowledgment of [
    {},
    { trafficAccessToken: null },
    {
      envdAccessToken: "unused_post_envd_token",
      trafficAccessToken: "unused_post_traffic_token",
      domain: null,
    },
  ]) {
    const f = restoreFixture(acknowledgment),
      { port, report } = await runRestoreFixture(f);
    assert.equal(report.status, "passed");
    assert.equal(report.cleanup, "verified_deleted");
    assert.equal(snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure, null);
    assert.equal(f.calls.filter(({ url }) => new URL(url).origin === ENVD).length, 3);
    assert.equal(
      f.calls.filter(
        ({ url, opts }) => new URL(url).pathname.endsWith("/connect") && opts.method === "POST",
      ).length,
      1,
    );
    const connectIndex = f.calls.findIndex(({ url }) => new URL(url).pathname.endsWith("/connect"));
    assert.equal(new URL(f.calls[connectIndex + 1].url).pathname, `/sandboxes/${id}`);
    assert.equal(f.calls[connectIndex + 1].opts.method, "GET");
  }
});

test("foreign or partial acknowledgment data cannot replace the original static identity or credentials", async () => {
  for (const acknowledgment of [
    { sandboxID: "foreign_VM" },
    { templateID: "foreign_template" },
    { domain: "foreign.test" },
    { envdVersion: "0.6.3" },
    { envdVersion: "0.1.0" },
    { envdVersion: undefined },
  ]) {
    const f = restoreFixture(acknowledgment),
      { port, report } = await runRestoreFixture(f);
    assert.equal(report.status, "passed");
    assert.equal(report.cleanup, "verified_deleted");
    assert.equal(snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure, null);
    assert.equal(f.calls.filter(({ url }) => new URL(url).origin === ENVD).length, 3);
    assert.equal(
      f.calls.filter(
        ({ url, opts }) => new URL(url).pathname.endsWith("/connect") && opts.method === "POST",
      ).length,
      1,
    );
  }
});

test("valid restore acknowledgment cannot bypass missing credentials or drift in the authoritative static GET", async () => {
  for (const drift of [
    { envdAccessToken: undefined },
    { envdAccessToken: "" },
    { domain: "foreign.test" },
    { envdVersion: "0.6.3" },
    { cpuCount: 4 },
    { memoryMB: 1024 },
    { diskSizeMB: 10241 },
    { metadata: { ...op.metadata, morrowSource: "f".repeat(64) } },
    { network: { allowOut: [], denyOut: ["0.0.0.0/0"], allowPublicTraffic: true } },
    { lifecycle: { onTimeout: "kill", autoResume: true } },
    { endAt: new Date(op.deadlineMs + 1000).toISOString() },
  ]) {
    const f = restoreFixture({}, drift),
      { report, port } = await runRestoreFixture(f);
    assert.notEqual(report.status, "passed");
    const failure = snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure;
    if (failure.stage === "restore") assert.equal(failure.status, null);
    assert.equal(f.calls.filter(({ url }) => new URL(url).origin === ENVD).length, 2);
    assert.equal(
      f.calls.filter(
        ({ url, opts }) => new URL(url).pathname.endsWith("/connect") && opts.method === "POST",
      ).length,
      1,
    );
    if (drift.metadata)
      assert.equal(f.calls.filter(({ opts }) => opts.method === "DELETE").length, 0);
  }
});

test("blank and non-JSON connect acknowledgments are discarded before the mandatory original static GET", async () => {
  for (const response of [
    () => new Response(null, { status: 201 }),
    () => new Response("not JSON private transient body", { status: 201 }),
    () =>
      new Response(
        JSON.stringify({
          sandboxID: "foreign",
          envdAccessToken: "untrusted_body_token",
          domain: "foreign.test",
        }),
        { status: 200 },
      ),
  ]) {
    const f = restoreFixture({}, {}, response),
      { report, port } = await runRestoreFixture(f);
    assert.equal(report.status, "passed");
    assert.equal(report.cleanup, "verified_deleted");
    assert.equal(snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure, null);
    assert.equal(f.calls.filter(({ url }) => new URL(url).origin === ENVD).length, 3);
    const connect = f.calls.findIndex(({ url }) => new URL(url).pathname.endsWith("/connect"));
    assert.equal(new URL(f.calls[connect + 1].url).pathname, `/sandboxes/${id}`);
  }
});

test("rejected or redirected connect acknowledgments cannot authorize guest access or another connect", async () => {
  for (const status of [307, 400, 401, 403, 404, 500, 503]) {
    const f = restoreFixture(
        {},
        {},
        () =>
          new Response("private response", {
            status,
            headers: status === 307 ? { location: "https://foreign.test" } : {},
          }),
      ),
      { report } = await runRestoreFixture(f);
    assert.notEqual(report.status, "passed");
    assert.equal(report.cleanup, "verified_deleted");
    assert.equal(f.calls.filter(({ url }) => new URL(url).origin === ENVD).length, 2);
    assert.equal(
      f.calls.filter(
        ({ url, opts }) => new URL(url).pathname.endsWith("/connect") && opts.method === "POST",
      ).length,
      1,
    );
  }
});

test("fresh original restore admission reports fixed predicate groups without stale POST status", async () => {
  for (const [drift, outcome] of [
    [{ state: "paused" }, "state_denied"],
    [{ cpuCount: 4 }, "resource_denied"],
    [{ envdAccessToken: "" }, "controller_denied"],
    [{ allowInternetAccess: true }, "network_denied"],
    [{ lifecycle: { onTimeout: "pause", autoResume: false } }, "lifecycle_denied"],
    [{ endAt: new Date(op.deadlineMs + 1000).toISOString() }, "expiry_denied"],
  ]) {
    const f = restoreFixture({}, drift),
      { report, port } = await runRestoreFixture(f);
    assert.notEqual(report.status, "passed");
    const failure = snapshotE2BDevelopmentDiagnostics(port).firstExecutionFailure;
    assert.equal(failure.stage, "restore");
    assert.equal(failure.endpoint, "control_api");
    assert.equal(failure.outcome, outcome);
    assert.equal(failure.status, null);
    assert.equal(f.calls.filter(({ url }) => new URL(url).origin === ENVD).length, 2);
  }
});
