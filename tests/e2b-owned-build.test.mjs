import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  E2B_OWNED_BUILD_IMAGE,
  compileE2BOwnedBuildRecipe,
  prepareE2BOwnedBuildOperation,
  validateE2BOwnedBuildRecord,
  validateE2BOwnedBuildReadyProof,
  validateE2BOwnedBuildAuthorization,
  runE2BOwnedBuild,
  createE2BOwnedBuildNativePort,
  e2bOwnedBuildRequestDigests,
} from "../packages/runtime-adapters/src/e2b/owned-build.ts";
const now = Date.parse("2026-10-15T00:30:00Z");
const recipe = {
  schemaVersion: 1,
  task: "P04.T01h",
  planSequence: 60,
  workspaceId: "477b25a3-cd53-441c-b9ce-01c3bb48e378",
  projectId: "22220c06-b76d-47b2-98d7-a1069d611e8f",
  imageRef: E2B_OWNED_BUILD_IMAGE,
  cpu: 2,
  memoryMiB: 512,
  minFreeDiskMiB: 0,
  maximumObservationMs: 600000,
};
const original = () =>
  prepareE2BOwnedBuildOperation(
    recipe,
    "33333333-3333-4333-8333-333333333333",
    now,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  );
const auth = (record = original()) => ({
  schemaVersion: 1,
  operationId: record.operation.operationId,
  workspaceId: recipe.workspaceId,
  projectId: recipe.projectId,
  recipeSha256: record.operation.recipeSha256,
  sourceSha256: record.operation.sourceSha256,
  accountObservationSha256: record.operation.accountObservationSha256,
  manifestProofSha256: record.operation.manifestProofSha256,
  quoteSha256: "d".repeat(64),
  quoteVerified: true,
  allMetersQualified: true,
  recoveryQualified: true,
  creditCeilingUsd: "0.25",
  registrationReceipt: "owner_explicit",
  startReceipt: "owner_explicit",
  verifiedAtMs: now,
  expiresAtMs: now + 1800000,
});
const templateId = "owned_template_1",
  buildId = "44444444-4444-4444-8444-444444444444",
  key = "e2b_synthetic_owned_build_test_key_only";
const observation = (status = "waiting", changes = {}) => ({
  projectId: recipe.projectId,
  name: original().operation.name,
  templateId,
  buildId,
  private: true,
  status,
  cpu: 2,
  memoryMiB: 512,
  diskMiB: status === "ready" ? 5120 : null,
  envdVersion: status === "ready" ? "0.6.2" : null,
  createdAtMs: now,
  finishedAtMs: status === "ready" ? now : null,
  ...changes,
});
const context = () => ({ deadlineMs: now + 10000, signal: new AbortController().signal });
const opts = (changes = {}) => ({
  mode: "build",
  authorization: auth(),
  now: () => now,
  signal: new AbortController().signal,
  persist: async () => {},
  pollWait: async () => {},
  maximumPolls: 2,
  ...changes,
});
function pureFixture() {
  const calls = [],
    saved = [];
  let current = null;
  const port = {
    async proveProject() {
      calls.push("project");
    },
    async findOriginal() {
      calls.push("find");
      return { candidates: current ? [current] : [], complete: true };
    },
    async register() {
      calls.push("register");
      current = observation();
      return current;
    },
    async inspect() {
      calls.push("inspect");
      return current;
    },
    async start() {
      calls.push("start");
      current = observation("ready");
    },
  };
  return {
    port,
    calls,
    saved,
    persist: async (record) => {
      saved.push(structuredClone(record));
    },
    set(value) {
      current = value;
    },
  };
}

test("fixed recipe and source-bound record reject guessed resources, images and executable getters", () => {
  assert.ok(Object.isFrozen(compileE2BOwnedBuildRecipe(recipe).recipe));
  for (const change of [
    { cpu: 1 },
    { memoryMiB: 1024 },
    { minFreeDiskMiB: 1 },
    { imageRef: "e2bdev/base:latest" },
    { planSequence: 59 },
    { projectId: "foreign" },
    { extra: true },
  ])
    assert.throws(() => compileE2BOwnedBuildRecipe({ ...recipe, ...change }), /DENIED/);
  const hostile = { ...recipe };
  Object.defineProperty(hostile, "imageRef", {
    get() {
      throw Error(key);
    },
  });
  assert.throws(
    () => compileE2BOwnedBuildRecipe(hostile),
    (error) => !error.message.includes(key),
  );
  const record = original();
  assert.equal(record.operation.name, `morrow-owned-${record.operation.operationId}`);
  assert.equal(
    validateE2BOwnedBuildRecord(record).operation.recipeSha256,
    record.operation.recipeSha256,
  );
  assert.throws(() => validateE2BOwnedBuildRecord({ ...record, startAttempted: true }), /DENIED/);
  assert.throws(
    () =>
      validateE2BOwnedBuildRecord({
        ...record,
        operation: { ...record.operation, sourceSha256: "foreign" },
      }),
    /DENIED/,
  );
});
test("read-only access, stale quotes and mismatched source/account/owner receipts cannot authorize writes", () => {
  for (const change of [
    { quoteVerified: false },
    { allMetersQualified: false },
    { recoveryQualified: false },
    { quoteSha256: null },
    { registrationReceipt: "readonly" },
    { startReceipt: "readonly" },
    { projectId: "foreign" },
    { workspaceId: "foreign" },
    { sourceSha256: "e".repeat(64) },
    { accountObservationSha256: "e".repeat(64) },
    { manifestProofSha256: "e".repeat(64) },
    { expiresAtMs: now },
    { verifiedAtMs: now + 1 },
    { creditCeilingUsd: "1.00" },
  ])
    assert.throws(
      () => validateE2BOwnedBuildAuthorization({ ...auth(), ...change }, original(), now),
      /DENIED/,
    );
  assert.throws(
    () =>
      createE2BOwnedBuildNativePort({
        apiKey: key,
        record: original(),
        mode: "build",
        authorization: null,
      }),
    /DENIED/,
  );
});

test("ready proof is shared with retention and requires original verified private identity, native sizing and secure completion", () => {
  const record = {
    ...original(),
    registrationAttempted: true,
    registrationVerified: true,
    startAttempted: true,
    templateId,
    buildId,
    phase: "observing",
  };
  assert.equal(validateE2BOwnedBuildReadyProof(observation("ready"), record).buildId, buildId);
  for (const change of [
    { status: "error" },
    { private: false },
    { projectId: "foreign" },
    { name: "foreign" },
    { templateId: "foreign" },
    { buildId: "55555555-5555-4555-8555-555555555555" },
    { cpu: 1 },
    { memoryMiB: 1024 },
    { diskMiB: null },
    { diskMiB: 10241 },
    { envdVersion: "0.1.0" },
    { finishedAtMs: null },
    { finishedAtMs: now - 1 },
    { createdAtMs: now - 1 },
  ])
    assert.throws(
      () => validateE2BOwnedBuildReadyProof(observation("ready", change), record),
      /DENIED/,
    );
  assert.throws(
    () =>
      validateE2BOwnedBuildReadyProof(observation("ready"), { ...record, startAttempted: false }),
    /DENIED/,
  );
});
test("single registration and start attempts become durable before each effect; ready image is retained separately", async () => {
  const f = pureFixture();
  f.port.register = async () => {
    assert.equal(f.saved.at(-1).registrationAttempted, true);
    assert.equal(f.saved.at(-1).startAttempted, false);
    f.calls.push("register");
    f.set(observation());
    return observation();
  };
  f.port.start = async () => {
    assert.equal(f.saved.at(-1).startAttempted, true);
    assert.equal(f.saved.at(-1).registrationVerified, true);
    f.calls.push("start");
    f.set(observation("ready"));
  };
  const report = await runE2BOwnedBuild(original(), f.port, opts({ persist: f.persist }));
  assert.equal(report.status, "ready_retained");
  assert.equal(report.templateRetained, true);
  assert.equal(report.catalogueDeleted, false);
  assert.equal(report.remoteCancellationVerified, false);
  assert.equal(report.runtimeProfileQualified, false);
  assert.equal(f.calls.filter((x) => x === "register").length, 1);
  assert.equal(f.calls.filter((x) => x === "start").length, 1);
  assert.equal(report.record.phase, "ready_retained");
  assert.deepEqual(report.requestBodyDigests, e2bOwnedBuildRequestDigests(original()));
  assert.ok(!JSON.stringify(report).includes(key));
});
test("persist failure before either write prevents that write and retains conservative attempt state", async () => {
  for (const phase of ["registering", "starting"]) {
    const f = pureFixture();
    const report = await runE2BOwnedBuild(
      original(),
      f.port,
      opts({
        persist: async (record) => {
          if (record.phase === phase) throw Error(key);
        },
      }),
    );
    assert.equal(report.status, "held");
    assert.equal(f.calls.includes(phase === "registering" ? "register" : "start"), false);
    assert.equal(
      report.record[phase === "registering" ? "registrationAttempted" : "startAttempted"],
      true,
    );
    assert.ok(!JSON.stringify(report).includes(key));
  }
});
test("unknown registration is never replayed, reconciled catalogue candidates do not establish recipe provenance", async () => {
  const f = pureFixture();
  f.port.register = async () => {
    f.calls.push("register");
    f.set(observation());
    throw Error(key);
  };
  const first = await runE2BOwnedBuild(original(), f.port, opts({ persist: f.persist }));
  assert.equal(first.status, "held");
  assert.equal(first.record.registrationAttempted, true);
  assert.equal(first.record.templateId, null);
  const report = await runE2BOwnedBuild(
    first.record,
    f.port,
    opts({ mode: "reconcile", authorization: null, persist: f.persist }),
  );
  assert.equal(report.status, "held");
  assert.equal(report.candidateCount, 1);
  assert.equal(report.record.templateId, null);
  assert.equal(f.calls.filter((x) => x === "register").length, 1);
  assert.equal(f.calls.includes("start"), false);
  const replay = await runE2BOwnedBuild(first.record, f.port, opts());
  assert.equal(replay.status, "held");
  assert.equal(f.calls.filter((x) => x === "register").length, 1);
});
test("unknown original start is inspected without restarting; exact ready readback may complete the retained image", async () => {
  const f = pureFixture();
  f.port.start = async () => {
    f.calls.push("start");
    f.set(observation("building"));
    throw Error(key);
  };
  const first = await runE2BOwnedBuild(original(), f.port, opts());
  assert.equal(first.record.startAttempted, true);
  assert.equal(first.record.buildId, buildId);
  f.set(observation("ready"));
  const report = await runE2BOwnedBuild(
    first.record,
    f.port,
    opts({ mode: "reconcile", authorization: null }),
  );
  assert.equal(report.status, "ready_retained");
  assert.equal(f.calls.filter((x) => x === "start").length, 1);
});
test("foreign/private/capacity/provenance drift prevents start and terminal image qualification", async () => {
  for (const change of [
    { private: false },
    { name: "foreign" },
    { projectId: "foreign" },
    { cpu: 1 },
    { memoryMiB: 1024 },
    { createdAtMs: now - 1 },
  ]) {
    const f = pureFixture();
    f.port.register = async () => observation("waiting", change);
    const result = await runE2BOwnedBuild(original(), f.port, opts());
    assert.equal(result.status, "held");
    assert.equal(f.calls.includes("start"), false);
  }
  for (const change of [
    { diskMiB: null },
    { diskMiB: 10241 },
    { envdVersion: "0.1.0" },
    { finishedAtMs: null },
    { buildId: "55555555-5555-4555-8555-555555555555" },
  ]) {
    const f = pureFixture();
    f.port.start = async () => f.set(observation("ready", change));
    assert.equal((await runE2BOwnedBuild(original(), f.port, opts())).status, "held");
  }
});
test("error, no-match, cancellation and exhausted observation stay held without cancellation or deletion claims", async () => {
  for (const status of ["error", "building"]) {
    const f = pureFixture();
    f.port.start = async () => f.set(observation(status));
    const result = await runE2BOwnedBuild(original(), f.port, opts());
    assert.equal(result.status, "held");
    assert.equal(result.remoteCancellationVerified, false);
    assert.equal(result.catalogueDeleted, false);
  }
  const f = pureFixture(),
    control = new AbortController();
  control.abort();
  const result = await runE2BOwnedBuild(original(), f.port, opts({ signal: control.signal }));
  assert.equal(result.status, "held");
  assert.deepEqual(f.calls, []);
  const unknown = { ...original(), registrationAttempted: true, phase: "held" };
  const found = await runE2BOwnedBuild(
    unknown,
    f.port,
    opts({ mode: "reconcile", authorization: null }),
  );
  assert.equal(found.status, "held");
  assert.equal(found.candidateCount, 0);
  const cancelled = pureFixture(),
    controller = new AbortController();
  cancelled.port.findOriginal = async () => {
    controller.abort();
    return { candidates: [], complete: true };
  };
  const late = await runE2BOwnedBuild(
    original(),
    cancelled.port,
    opts({ signal: controller.signal }),
  );
  assert.equal(late.status, "held");
  assert.equal(cancelled.calls.includes("register"), false);
});

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function wireFixture() {
  const record = original(),
    calls = [],
    hooks = {};
  let current = null;
  const nativeBuild = () => ({
    buildID: buildId,
    status: current ?? "waiting",
    cpuCount: 2,
    memoryMB: 512,
    createdAt: new Date(now).toISOString(),
    ...(current === "ready"
      ? { diskSizeMB: 5120, envdVersion: "0.6.2", finishedAt: new Date(now).toISOString() }
      : {}),
  });
  const nativeTemplate = () => ({
    templateID: templateId,
    public: false,
    createdAt: new Date(now).toISOString(),
    aliases: [record.operation.name],
    names: [`sultan/${record.operation.name}`],
    builds: [nativeBuild()],
  });
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, "https://api.e2b.app");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["X-API-Key"], key);
    assert.ok(options.signal instanceof AbortSignal);
    if (hooks.fetch) {
      const reply = await hooks.fetch(url, options);
      if (reply !== undefined) return reply;
    }
    const path = new URL(url).pathname;
    if (path.endsWith("/metrics")) return json([]);
    if (path === "/v2/templates")
      return json(
        current
          ? [{ templateID: templateId, buildID: buildId, aliases: [record.operation.name] }]
          : [],
      );
    if (path === "/v3/templates") {
      assert.deepEqual(JSON.parse(options.body), {
        name: record.operation.name,
        cpuCount: 2,
        memoryMB: 512,
        minFreeDiskMb: 0,
      });
      current = "waiting";
      return json(
        {
          templateID: templateId,
          buildID: buildId,
          public: false,
          aliases: [record.operation.name],
          names: [`sultan/${record.operation.name}`],
        },
        202,
      );
    }
    if (path === `/templates/${templateId}`)
      return current ? json(nativeTemplate()) : json({ code: 404 }, 404);
    if (path === `/v2/templates/${templateId}/builds/${buildId}`) {
      assert.deepEqual(JSON.parse(options.body), {
        fromImage: E2B_OWNED_BUILD_IMAGE,
        steps: [],
        force: false,
      });
      current = "ready";
      return new Response(null, { status: 202 });
    }
    throw Error("SYNTHETIC_ROUTE_DENIED");
  };
  return {
    record,
    calls,
    hooks,
    fetch,
    now: () => now,
    set(value) {
      current = value;
    },
    nativeTemplate,
  };
}
const nativePort = (f, mode = "build", record = f.record) =>
  createE2BOwnedBuildNativePort(
    { apiKey: key, record, authorization: mode === "build" ? auth(record) : null, mode },
    f,
  );
test("native documented wire binds the project and original private IDs before two exact single writes", async () => {
  const f = wireFixture(),
    result = await runE2BOwnedBuild(f.record, nativePort(f), opts());
  assert.equal(result.status, "ready_retained");
  assert.equal(f.calls.filter((x) => x.options.method === "POST").length, 2);
  assert.ok(f.calls.every((x) => ["GET", "POST"].includes(x.options.method)));
  assert.ok(f.calls.every((x) => !x.url.includes("/files") && !x.url.includes("/sandbox")));
});
test("native project mismatch and forbidden/foreign registration stop without compensating effects", async () => {
  for (const fault of ["project", "foreign_id", "public"]) {
    const f = wireFixture();
    f.hooks.fetch = (url) => {
      if (fault === "project" && url.includes("/metrics?")) return json({ code: 403 }, 403);
      if (url.endsWith("/v3/templates"))
        return json(
          {
            templateID: fault === "foreign_id" ? "foreign_template" : templateId,
            buildID,
            public: fault === "public",
            aliases: [f.record.operation.name],
          },
          202,
        );
    };
    const result = await runE2BOwnedBuild(f.record, nativePort(f), opts());
    assert.equal(result.status, "held");
    assert.equal(
      f.calls.filter((x) => x.options.method === "POST").length,
      fault === "project" ? 0 : 1,
    );
    assert.equal(
      f.calls.some((x) => x.options.method === "DELETE"),
      false,
    );
  }
});

test("existing operation names with empty builds or malformed catalogue aliases never authorize registration", async () => {
  for (const fault of ["empty_builds", "bad_aliases", "old_template"]) {
    const f = wireFixture();
    f.set("waiting");
    f.hooks.fetch = (url) => {
      const path = new URL(url).pathname;
      if (path === "/v2/templates" && fault === "bad_aliases")
        return json([{ templateID: templateId, aliases: null }]);
      if (path === `/templates/${templateId}`)
        return json({
          ...f.nativeTemplate(),
          ...(fault === "empty_builds"
            ? { builds: [] }
            : fault === "old_template"
              ? { createdAt: new Date(now - 1).toISOString() }
              : {}),
        });
    };
    const report = await runE2BOwnedBuild(f.record, nativePort(f), opts());
    assert.equal(report.status, "held");
    assert.equal(report.record.registrationAttempted, false);
    assert.equal(
      f.calls.some((x) => x.options.method === "POST"),
      false,
    );
  }
});
test("native uncertain writes never retry and start accepts only the verified original registration IDs", async () => {
  const f = wireFixture(),
    port = nativePort(f);
  await port.proveProject(context());
  await port.register(context());
  await assert.rejects(port.register(context()), /DENIED/);
  await assert.rejects(port.start("foreign_template", buildId, context()), /DENIED/);
  f.hooks.fetch = (url) => {
    if (url.includes(`/builds/${buildId}`)) throw Error(key);
  };
  await assert.rejects(port.start(templateId, buildId, context()), /FAILED/);
  await assert.rejects(port.start(templateId, buildId, context()), /DENIED/);
  assert.equal(f.calls.filter((x) => x.options.method === "POST").length, 2);
});

test("native deadlines bound hanging unknown registration without replay or false remote cancellation", async () => {
  const f = wireFixture(),
    port = nativePort(f);
  await port.proveProject(context());
  f.hooks.fetch = (url) => (url.endsWith("/v3/templates") ? new Promise(() => {}) : undefined);
  await assert.rejects(
    port.register({ deadlineMs: now + 1, signal: new AbortController().signal }),
    /DEADLINE/,
  );
  await assert.rejects(port.register(context()), /DENIED/);
  assert.equal(f.calls.filter((x) => x.options.method === "POST").length, 1);
});

test("native start revalidates the exact quote and receipt after the ownership GET crosses expiry", async () => {
  const f = wireFixture();
  let clock = now;
  f.now = () => clock;
  const port = nativePort(f);
  await port.proveProject(context());
  await port.register(context());
  f.hooks.fetch = (url) => {
    if (new URL(url).pathname === `/templates/${templateId}`) {
      clock = auth().expiresAtMs;
      return json(f.nativeTemplate());
    }
  };
  await assert.rejects(
    port.start(templateId, buildId, {
      deadlineMs: now + 3600000,
      signal: new AbortController().signal,
    }),
    /DENIED|FAILED/,
  );
  assert.equal(
    f.calls.filter(
      (x) => new URL(x.url).pathname.includes("/builds/") && x.options.method === "POST",
    ).length,
    0,
  );
});

test("native credential HTTP rejects an unqualified TLS disable before any provider request", () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    for (const value of ["0", "false", ""]) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = value;
      const f = wireFixture();
      assert.throws(() => nativePort(f), /DENIED/);
      assert.deepEqual(f.calls, []);
    }
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  }
});
test("native readonly reconciliation has no write capability and cannot map foreign404 to absence", async () => {
  const f = wireFixture();
  f.set("waiting");
  const port = nativePort(f, "reconcile");
  await port.proveProject(context());
  await assert.rejects(port.register(context()), /DENIED/);
  await assert.rejects(port.start(templateId, buildId, context()), /DENIED/);
  const found = await port.findOriginal(context());
  assert.equal(found.complete, true);
  assert.equal(found.candidates.length, 1);
  f.hooks.fetch = (url) =>
    new URL(url).pathname === "/v2/templates"
      ? json([{ templateID: templateId, buildID: "", aliases: [f.record.operation.name] }])
      : undefined;
  assert.equal((await port.findOriginal(context())).candidates[0].buildId, buildId);
  f.hooks.fetch = () => {
    const reply = json({ code: 404 }, 404);
    Object.defineProperty(reply, "url", { value: "https://foreign.test/capture" });
    return reply;
  };
  await assert.rejects(port.inspect(templateId, buildId, context()), /DENIED|FAILED/);
  assert.ok(f.calls.every((x) => x.options.method === "GET"));
});
test("native malformed, oversized, paginated and hostile provider data fail closed with redacted errors", async () => {
  for (const fault of ["oversized", "private", "duplicate", "cursor", "hostile"]) {
    const f = wireFixture(),
      port = nativePort(f);
    await port.proveProject(context());
    f.set("waiting");
    f.hooks.fetch = (url) => {
      if (!url.includes(`/templates/${templateId}`)) return;
      if (fault === "hostile")
        throw new Proxy(Error(key), {
          getOwnPropertyDescriptor() {
            throw Error(key);
          },
        });
      if (fault === "oversized") return json({}, 200, { "content-length": "999999" });
      if (fault === "private") return json({ ...f.nativeTemplate(), public: true });
      if (fault === "duplicate") {
        const t = f.nativeTemplate();
        return json({ ...t, builds: [...t.builds, ...t.builds] });
      }
      return json({ ...f.nativeTemplate(), builds: [] }, 200, { "x-next-token": "repeat" });
    };
    await assert.rejects(
      port.inspect(templateId, buildId, context()),
      (error) => !error.message.includes(key),
    );
  }
});
test("real native registration redirect stops before forwarding a synthetic key or POST body to another origin", async () => {
  const require = createRequire(import.meta.resolve("e2b")),
    { MockAgent, fetch: realFetch } = require("undici"),
    agent = new MockAgent();
  agent.disableNetConnect();
  let foreign = 0;
  agent
    .get("https://api.e2b.app")
    .intercept({ path: "/v3/templates", method: "POST" })
    .reply(307, null, { headers: { location: "https://foreign.test/capture" } });
  agent
    .get("https://foreign.test")
    .intercept({ path: "/capture", method: "POST" })
    .reply(202, () => {
      foreign++;
      return {};
    });
  const f = wireFixture();
  f.hooks.fetch = (url, options) =>
    url.endsWith("/v3/templates") ? realFetch(url, { ...options, dispatcher: agent }) : undefined;
  const result = await runE2BOwnedBuild(f.record, nativePort(f), opts());
  assert.equal(result.status, "held");
  assert.equal(foreign, 0);
  assert.equal(f.calls.filter((x) => x.options.method === "POST").length, 1);
  await agent.close();
});
