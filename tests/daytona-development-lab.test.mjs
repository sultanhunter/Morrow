import test from "node:test";
import assert from "node:assert/strict";
import {
  developmentLabConfiguration,
  compileDevelopmentLabConfiguration,
  prepareDevelopmentLabOperation,
  runDevelopmentLab,
} from "../packages/infrastructure/src/daytona-development-lab.ts";

const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sandboxId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const config = developmentLabConfiguration();
const startedAtMs = 1_000;
function fixture(faults = {}) {
  const events = [],
    records = [];
  let current = null,
    marker = null,
    clock = startedAtMs;
  const port = {
    async create(spec) {
      events.push("create");
      assert.equal(records.at(-1).phase, "create_requested");
      assert.deepEqual(
        [spec.cpu, spec.memoryGiB, spec.diskGiB, spec.autoStopMinutes, spec.autoDeleteMinutes],
        [1, 1, 3, 5, 1],
      );
      assert.equal(spec.networkBlockAll, true);
      assert.equal(spec.publicPreview, false);
      if (faults.createBeforeEffect) throw Error(faults.createBeforeEffect);
      current = {
        id: sandboxId,
        name: spec.name,
        labels: { ...spec.labels },
        sandboxClass: "container",
        snapshot: "daytona-small",
        cpu: 1,
        memoryGiB: 1,
        diskGiB: 3,
        state: "started",
        ...faults.created,
      };
      if (faults.cancelDuringCreate) faults.cancelDuringCreate.abort();
      if (faults.createAfterEffect) throw Error(faults.createAfterEffect);
      return structuredClone(current);
    },
    async getByName() {
      events.push("getByName");
      if (faults.lookupError && events.filter((e) => e === "getByName").length > 1)
        throw Error("raw lookup error with private content");
      return current && structuredClone(current);
    },
    async inspect(id) {
      events.push("inspect");
      assert.equal(id, sandboxId);
      if (faults.inspectError) throw Error("private inspect content");
      if (current && faults.inspectForeign && events.includes("read"))
        return { ...structuredClone(current), id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
      return current && structuredClone(current);
    },
    async writeMarker(id, path, value) {
      events.push("write");
      assert.equal(id, sandboxId);
      assert.equal(path, `/tmp/morrow-dev-lab-${operationId}.txt`);
      assert.equal(value, `MORROW_SYNTHETIC_PERSISTENCE_V1:${operationId}\n`);
      if (faults.writeError) throw Error(faults.writeError);
      marker = value;
      if (faults.expireAfterWrite) clock += 600_000;
      if (faults.cancelAfterWrite) faults.cancelAfterWrite.abort();
    },
    async readMarker() {
      events.push("read");
      return faults.corruptAfterStart && events.includes("start") ? "corrupted" : marker;
    },
    async stop() {
      events.push("stop");
      current.state = faults.stopState ?? "stopped";
    },
    async start() {
      events.push("start");
      current.state = faults.startState ?? "started";
    },
    async delete() {
      events.push("delete");
      assert.equal(records.at(-1).phase, "cleanup_requested");
      if (faults.deleteError) throw Error("private delete error");
      if (faults.deleteNeverTerminates) return;
      if (faults.deleteDestroyed) current.state = "destroyed";
      else current = null;
    },
  };
  const options = {
    startedAtMs,
    now: () => clock,
    async persist(record) {
      records.push(structuredClone(record));
    },
  };
  return {
    port,
    options,
    records,
    events,
    setCurrent(value) {
      current = value;
    },
  };
}

test("development lab is a separate closed, non-activating configuration", () => {
  const compiled = compileDevelopmentLabConfiguration(config);
  assert.equal(compiled.providerCalls, false);
  assert.equal(compiled.merchantDispatch, false);
  assert.equal(compiled.productionQualification, false);
  assert.equal(compiled.profileSha256.length, 64);
  assert.equal(
    compileDevelopmentLabConfiguration(Object.fromEntries(Object.entries(config).reverse()))
      .profileSha256,
    compiled.profileSha256,
  );
  for (const changes of [
    { environment: "production" },
    { environment: "staging" },
    { sandboxClass: "linux_vm" },
    { snapshot: "unreviewed" },
    { cpu: 2 },
    { memoryGiB: 2 },
    { diskGiB: 4 },
    { maximumContainers: 2 },
    { maximumWallSeconds: 601 },
    { autoStopMinutes: 0 },
    { autoDeleteMinutes: 0 },
    { estimatedCreditCeilingUsd: "1" },
    { merchantRouting: true },
    { productionQualified: true },
    { fixture: "arbitrary_script" },
    { payload: "merchant content" },
    { artifactReference: "private-artifact" },
    { envVars: { TOKEN: "synthetic" } },
    { modelApiKey: "synthetic" },
    { publicPreview: true },
    { linkedSandbox: sandboxId },
    { organizationId: "foreign-account" },
    { region: "eu" },
    { planSequence: 52 },
    { estimatedCreditCeilingUsd: NaN },
  ])
    assert.throws(
      () => compileDevelopmentLabConfiguration({ ...config, ...changes }),
      /CONFIGURATION_DENIED/,
    );
  assert.throws(() => developmentLabConfiguration(52), /PLAN_DENIED/);
  assert.throws(() => developmentLabConfiguration(53), /PLAN_DENIED/);
  assert.throws(() => developmentLabConfiguration(55), /PLAN_DENIED/);
  const cyclic = { ...config };
  cyclic.extra = cyclic;
  assert.throws(() => compileDevelopmentLabConfiguration(cyclic), /CONFIGURATION_DENIED/);
});

test("operation binds UUID, profile, wall deadline and built-in fixture", () => {
  const operation = prepareDevelopmentLabOperation(config, operationId, startedAtMs);
  assert.equal(operation.deadlineMs, 601_000);
  assert.equal(operation.labels.morrowDeadline, "601000");
  assert.equal(operation.labels.morrowProfile, operation.profileSha256);
  for (const id of ["merchant", operationId + "; rm", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])
    assert.throws(
      () => prepareDevelopmentLabOperation(config, id, startedAtMs),
      /OPERATION_DENIED/,
    );
  for (const time of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(
      () => prepareDevelopmentLabOperation(config, operationId, time),
      /OPERATION_DENIED/,
    );
});

test("fixed synthetic marker survives stop/start, operation is journaled and deletion verified", async () => {
  const f = fixture();
  const result = await runDevelopmentLab(config, operationId, f.port, f.options);
  assert.equal(result.status, "passed");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.record.phase, "deleted");
  assert.equal(result.deletionObservation, "absent");
  assert.equal(result.productionQualified, false);
  assert.equal(result.memoryPersistenceClaimed, false);
  assert.equal(f.events.filter((e) => e === "create").length, 1);
  assert.ok(f.events.indexOf("stop") < f.events.indexOf("start"));
  assert.equal(f.events.filter((e) => e === "read").length, 2);
});

test("destroyed terminal observation is distinct from verified absence and both qualify deletion", async () => {
  const f = fixture({ deleteDestroyed: true });
  const result = await runDevelopmentLab(config, operationId, f.port, f.options);
  assert.equal(result.status, "passed");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.deletionObservation, "destroyed");
});

for (const [faults, code] of [
  [{ created: { sandboxClass: "linux_vm" } }, "DEVELOPMENT_LAB_PROFILE_DENIED"],
  [{ created: { cpu: 2 } }, "DEVELOPMENT_LAB_PROFILE_DENIED"],
  [{ created: { state: "starting" } }, "DEVELOPMENT_LAB_STATE_DENIED"],
  [{ stopState: "destroyed" }, "DEVELOPMENT_LAB_STATE_DENIED"],
  [{ startState: "stopped" }, "DEVELOPMENT_LAB_STATE_DENIED"],
  [{ corruptAfterStart: true }, "DEVELOPMENT_LAB_PERSISTENCE_DENIED"],
])
  test(`failed lifecycle/profile check ${code} never passes`, async () => {
    const f = fixture(faults);
    const result = await runDevelopmentLab(config, operationId, f.port, f.options);
    assert.equal(result.status, "failed");
    assert.equal(result.code, code);
    assert.equal(result.cleanup, "verified_deleted");
    if (faults.created) assert.ok(!f.events.includes("write"));
    if (faults.stopState) assert.ok(!f.events.includes("start"));
  });

test("uncertain create with visible owned resource reconciles then deletes without retry", async () => {
  const f = fixture({ createAfterEffect: "raw API timeout with secret" });
  const result = await runDevelopmentLab(config, operationId, f.port, f.options);
  assert.equal(result.status, "failed");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.code, "DEVELOPMENT_LAB_PROVIDER_FAILED");
  assert.equal(f.events.filter((e) => e === "create").length, 1);
  assert.equal(f.events.filter((e) => e === "delete").length, 1);
  assert.ok(!f.events.includes("write"));
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("uncertain create without observed resource remains unresolved and is never repeated on resume", async () => {
  const f = fixture({ createBeforeEffect: "raw unavailable" });
  const first = await runDevelopmentLab(config, operationId, f.port, f.options);
  assert.equal(first.status, "unresolved");
  assert.equal(first.cleanup, "unresolved");
  assert.equal(first.record.createAttempted, true);
  const second = await runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    resume: first.record,
  });
  assert.equal(second.status, "unresolved");
  assert.equal(f.events.filter((e) => e === "create").length, 1);
});

test("foreign returned resource or changed identity can never be adopted or deleted", async () => {
  for (const faults of [{ created: { labels: { foreign: "tenant" } } }, { inspectForeign: true }]) {
    const f = fixture(faults);
    const result = await runDevelopmentLab(config, operationId, f.port, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(result.cleanup, "foreign_resource_denied");
    assert.ok(!f.events.includes("delete"));
  }
});

test("failed or nonterminal deletion remains unresolved even when probes passed", async () => {
  for (const faults of [{ deleteError: true }, { deleteNeverTerminates: true }]) {
    const f = fixture(faults);
    const result = await runDevelopmentLab(config, operationId, f.port, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(result.cleanup, "unresolved");
    assert.equal(result.record.phase, "unresolved");
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});

test("cancellation before creation makes no provider calls; after creation it cleans owned resources", async () => {
  const pre = new AbortController();
  pre.abort();
  const f = fixture();
  const first = await runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    signal: pre.signal,
  });
  assert.equal(first.code, "DEVELOPMENT_LAB_CANCELLED");
  assert.equal(first.cleanup, "not_needed");
  assert.deepEqual(f.events, []);
  for (const field of ["cancelDuringCreate", "cancelAfterWrite"]) {
    const controller = new AbortController();
    const live = fixture({ [field]: controller });
    const result = await runDevelopmentLab(config, operationId, live.port, {
      ...live.options,
      signal: controller.signal,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "DEVELOPMENT_LAB_CANCELLED");
    assert.equal(result.cleanup, "verified_deleted");
    assert.equal(live.events.filter((e) => e === "create").length, 1);
  }
});

test("wall expiry after an effect enters cleanup; future and elapsed operations never create", async () => {
  const f = fixture({ expireAfterWrite: true });
  const result = await runDevelopmentLab(config, operationId, f.port, f.options);
  assert.equal(result.code, "DEVELOPMENT_LAB_DEADLINE");
  assert.equal(result.cleanup, "verified_deleted");
  assert.ok(!f.events.includes("stop"));
  for (const time of [0, 601_000]) {
    const fresh = fixture();
    const denied = await runDevelopmentLab(config, operationId, fresh.port, {
      ...fresh.options,
      now: () => time,
    });
    assert.equal(denied.code, "DEVELOPMENT_LAB_DEADLINE");
    assert.deepEqual(fresh.events, []);
  }
});

test("provider errors cannot masquerade as local safe codes to disclose arbitrary values", async () => {
  const f = fixture({ writeError: "DEVELOPMENT_LAB_PRIVATE_KEY_ABCDEF" });
  const result = await runDevelopmentLab(config, operationId, f.port, f.options);
  assert.equal(result.code, "DEVELOPMENT_LAB_PROVIDER_FAILED");
  assert.ok(!JSON.stringify(result).includes("ABCDEF"));
});

test("finished journals cannot allocate again; extra private fields and changed profile deny resume", async () => {
  const f = fixture();
  const finished = await runDevelopmentLab(config, operationId, f.port, f.options);
  const eventCount = f.events.length;
  const result = await runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    resume: finished.record,
  });
  assert.equal(result.code, "DEVELOPMENT_LAB_ALREADY_FINISHED");
  assert.equal(f.events.length, eventCount);
  for (const record of [
    { ...finished.record, apiKey: "synthetic" },
    { ...finished.record, operation: { ...finished.record.operation, deadlineMs: 900_000 } },
    { ...finished.record, sandboxId: "foreign" },
    { ...finished.record, createAttempted: false },
    { ...finished.record, sandboxId: null },
  ])
    await assert.rejects(
      () => runDevelopmentLab(config, operationId, f.port, { ...f.options, resume: record }),
      /RESUME_DENIED/,
    );
});

test("a foreign resource found before create is never adopted, reallocated or deleted", async () => {
  const f = fixture();
  const operation = prepareDevelopmentLabOperation(config, operationId, startedAtMs);
  f.setCurrent({
    id: sandboxId,
    name: operation.name,
    labels: { ...operation.labels, foreign: "owner" },
    sandboxClass: "container",
    snapshot: "daytona-small",
    cpu: 1,
    memoryGiB: 1,
    diskGiB: 3,
    state: "started",
  });
  const result = await runDevelopmentLab(config, operationId, f.port, f.options);
  assert.equal(result.status, "unresolved");
  assert.equal(result.cleanup, "foreign_resource_denied");
  assert.deepEqual(f.events, ["getByName"]);
});

test("in-flight create deadline bounds local wait and leaves uncertain allocation unresolved", async () => {
  const f = fixture();
  f.port.create = async () => {
    f.events.push("create");
    return new Promise(() => {});
  };
  const result = await runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    now: () => 600_990,
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "DEVELOPMENT_LAB_DEADLINE");
  assert.equal(result.cleanup, "unresolved");
  assert.equal(f.events.filter((e) => e === "create").length, 1);
});

test("exception message accessors and proxy traps cannot escape the redacted harness result", async () => {
  for (const failure of [
    Object.defineProperty(Error("synthetic"), "message", {
      get() {
        throw Error("SYNTHETIC_EXCEPTION_ESCAPED");
      },
    }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error("SYNTHETIC_EXCEPTION_ESCAPED");
        },
      },
    ),
  ]) {
    const f = fixture();
    f.port.getByName = async () => {
      throw failure;
    };
    const result = await runDevelopmentLab(config, operationId, f.port, f.options);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "DEVELOPMENT_LAB_PROVIDER_FAILED");
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_EXCEPTION_ESCAPED"));
  }
});

test("failed operation journaling precedes effects and failed final save cannot report success", async () => {
  const before = fixture();
  const first = await runDevelopmentLab(config, operationId, before.port, {
    ...before.options,
    persist: async () => {
      throw Error("private disk path");
    },
  });
  assert.equal(first.status, "unresolved");
  assert.equal(first.code, "DEVELOPMENT_LAB_JOURNAL_FAILED");
  assert.deepEqual(before.events, []);
  const after = fixture();
  const second = await runDevelopmentLab(config, operationId, after.port, {
    ...after.options,
    persist: async (record) => {
      if (record.phase === "deleted") throw Error("private disk path");
      await after.options.persist(record);
    },
  });
  assert.equal(second.status, "unresolved");
  assert.equal(second.code, "DEVELOPMENT_LAB_JOURNAL_FAILED");
  assert.equal(second.cleanup, "verified_deleted");
  assert.ok(!JSON.stringify(second).includes("private disk path"));
});

function cleanupRecord(sandbox = sandboxId, createAttempted = true) {
  return {
    operation: prepareDevelopmentLabOperation(config, operationId, startedAtMs),
    createAttempted,
    sandboxId: sandbox,
    phase: createAttempted ? "unresolved" : "prepared",
  };
}
function ownedObservation(operation) {
  return {
    id: sandboxId,
    name: operation.name,
    labels: { ...operation.labels },
    sandboxClass: "container",
    snapshot: "daytona-small",
    cpu: 1,
    memoryGiB: 1,
    diskGiB: 3,
    state: "started",
  };
}
const noProbeEffects = (events) =>
  assert.ok(!events.some((event) => ["create", "write", "read", "stop", "start"].includes(event)));

test("cleanup-only resume deletes the owned original resource after deadline and cancellation", async () => {
  const f = fixture();
  const resume = cleanupRecord();
  f.setCurrent(ownedObservation(resume.operation));
  const cancellation = new AbortController();
  cancellation.abort();
  const result = await runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    now: () => resume.operation.deadlineMs + 100_000,
    signal: cancellation.signal,
    resume,
    cleanupOnly: true,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "DEVELOPMENT_LAB_CLEANUP_ONLY");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.deletionObservation, "absent");
  assert.equal(result.record.phase, "deleted");
  assert.equal(f.events.filter((event) => event === "delete").length, 1);
  noProbeEffects(f.events);
});

test("cleanup-only uncertain creation reconciles only the original operation or remains unresolved", async () => {
  for (const found of [false, true]) {
    const f = fixture();
    const resume = cleanupRecord(null);
    if (found) f.setCurrent(ownedObservation(resume.operation));
    const result = await runDevelopmentLab(config, operationId, f.port, {
      ...f.options,
      resume,
      cleanupOnly: true,
    });
    assert.equal(result.status, found ? "failed" : "unresolved");
    assert.equal(result.cleanup, found ? "verified_deleted" : "unresolved");
    assert.equal(result.code, "DEVELOPMENT_LAB_CLEANUP_ONLY");
    assert.equal(result.record.createAttempted, true);
    noProbeEffects(f.events);
    assert.equal(f.events.filter((event) => event === "getByName").length, 1);
  }
});

test("cleanup-only empty prepared journal cannot allocate and needs no provider effects", async () => {
  const f = fixture();
  const resume = cleanupRecord(null, false);
  const result = await runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    resume,
    cleanupOnly: true,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "DEVELOPMENT_LAB_CLEANUP_ONLY");
  assert.equal(result.cleanup, "not_needed");
  assert.equal(result.record.createAttempted, false);
  assert.deepEqual(f.events, []);
});

test("cleanup-only requires the original valid journal and cannot delete foreign identities", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      runDevelopmentLab(config, operationId, f.port, {
        ...f.options,
        cleanupOnly: true,
      }),
    /RESUME_DENIED/,
  );
  const resume = cleanupRecord();
  await assert.rejects(
    () =>
      runDevelopmentLab(config, operationId, f.port, {
        ...f.options,
        resume: { ...resume, operation: { ...resume.operation, deadlineMs: 800_000 } },
        cleanupOnly: true,
      }),
    /RESUME_DENIED/,
  );
  for (const changes of [
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    { labels: { ...resume.operation.labels, morrowOperation: "foreign-operation" } },
  ]) {
    const foreign = fixture();
    foreign.setCurrent({ ...ownedObservation(resume.operation), ...changes });
    const result = await runDevelopmentLab(config, operationId, foreign.port, {
      ...foreign.options,
      resume,
      cleanupOnly: true,
    });
    assert.equal(result.status, "unresolved");
    assert.equal(result.cleanup, "foreign_resource_denied");
    assert.ok(!foreign.events.includes("delete"));
    noProbeEffects(foreign.events);
  }
});

test("cleanup-only failed deletion cannot qualify cleanup or persistence", async () => {
  const f = fixture({ deleteError: true });
  const resume = cleanupRecord();
  f.setCurrent(ownedObservation(resume.operation));
  const result = await runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    resume,
    cleanupOnly: true,
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.cleanup, "unresolved");
  assert.equal(result.code, "DEVELOPMENT_LAB_CLEANUP_ONLY");
  noProbeEffects(f.events);
});

test("cleanup-only reconciliation has a bounded timeout even after allocation lifetime expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.port.getByName = async () => {
    f.events.push("getByName");
    return new Promise(() => {});
  };
  const resume = cleanupRecord(null);
  const running = runDevelopmentLab(config, operationId, f.port, {
    ...f.options,
    now: () => resume.operation.deadlineMs + 100_000,
    resume,
    cleanupOnly: true,
  });
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  t.mock.timers.tick(30_000);
  const result = await running;
  assert.equal(result.status, "unresolved");
  assert.equal(result.cleanup, "unresolved");
  noProbeEffects(f.events);
});
