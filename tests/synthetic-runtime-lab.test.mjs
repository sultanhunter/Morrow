import test from "node:test";
import assert from "node:assert/strict";
import {
  compileSyntheticLabProfile,
  prepareSyntheticLabOperation,
  runSyntheticLab,
} from "../packages/infrastructure/src/synthetic-runtime-lab.ts";

const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceSha256 = "a".repeat(64);
const startedAtMs = 1000;
const profile = {
  schemaVersion: 1,
  task: "P04.T01h",
  planSequence: 60,
  scope: "builtin_synthetic_operator",
  environment: "development",
  providerId: "e2b",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  templateId: "native-template-01",
  templateBuildId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  cpu: 1,
  memoryMiB: 1024,
  diskMiB: 512,
  maximumWallMs: 600000,
  expectedCreditCeilingUsd: "0.25",
  outbound: "deny_all",
  merchantRouting: false,
};
const operation = prepareSyntheticLabOperation(profile, operationId, startedAtMs, sourceSha256);

function fixture(faults = {}) {
  const events = [],
    records = [],
    contexts = [];
  let current = null,
    marker = null,
    clock = startedAtMs;
  const copy = (value) => (value === null ? null : structuredClone(value));
  const observe = (name, context) => {
    events.push(name);
    contexts.push({ name, context });
    assert.ok(context.signal instanceof AbortSignal);
    assert.ok(context.deadlineMs > clock);
    assert.ok(context.deadlineMs <= clock + 30000);
  };
  const resource = (id = "opaqueSandbox_x9-Z") => ({
    id,
    metadata: { ...operation.metadata },
    templateId: profile.templateId,
    cpu: profile.cpu,
    memoryMiB: profile.memoryMiB,
    state: "running",
    network: { outbound: "deny_all", controllerAuth: true },
    lifecycle: {
      onTimeout: "kill",
      autoResume: false,
      createdAtMs: startedAtMs,
      endAtMs: operation.deadlineMs,
    },
  });
  const port = {
    async create(spec, context) {
      observe("create", context);
      assert.equal(records.at(-1).phase, "create_requested");
      assert.equal(records.at(-1).createAttempted, true);
      assert.deepEqual({ ...spec.profile }, profile);
      assert.deepEqual({ ...spec.operation.metadata }, { ...operation.metadata });
      assert.ok(Object.isFrozen(spec.profile));
      assert.ok(Object.isFrozen(spec.operation));
      if (faults.createBeforeEffect) throw faults.createBeforeEffect;
      current = { ...resource(), ...faults.created };
      if (faults.createAfterEffect) throw faults.createAfterEffect;
      if (faults.cancelDuringCreate) {
        faults.cancelDuringCreate.abort();
        return new Promise(() => {});
      }
      return faults.foreignCreateResponse
        ? { ...copy(current), id: "foreign-sandbox" }
        : copy(current);
    },
    async getByOperation(seen, context) {
      observe("lookup", context);
      assert.deepEqual({ ...seen.metadata }, { ...operation.metadata });
      if (faults.lookupError) throw Error("PRIVATE_LOOKUP_CONTENT");
      if (events.includes("create")) {
        if (faults.lookupClaimedForeignId)
          return {
            resources: [{ ...copy(current), id: "foreign-unconfirmed-id" }],
            complete: true,
          };
        if (faults.lookupNoMatch) return { resources: [], complete: true };
        if (faults.lookupIncomplete)
          return { resources: current ? [copy(current)] : [], complete: false };
        if (faults.lookupAmbiguous)
          return {
            resources: [copy(current), { ...copy(current), id: "second-matching-resource" }],
            complete: true,
          };
        if (faults.lookupForeign)
          return {
            resources: [
              { ...copy(current), metadata: { ...operation.metadata, morrowOperation: "foreign" } },
            ],
            complete: true,
          };
      }
      if (faults.initialLookup) return faults.initialLookup;
      return { resources: current ? [copy(current)] : [], complete: true };
    },
    async inspect(id, context) {
      observe("inspect", context);
      if (faults.inspectError) throw faults.inspectError;
      if (current && id !== current.id) return null;
      if (faults.foreignDuringCleanup && events.includes("write"))
        return { ...copy(current), metadata: { ...operation.metadata, extraAuthority: "denied" } };
      return copy(current);
    },
    async writeMarker(id, path, value, context) {
      observe("write", context);
      assert.equal(records.at(-1).phase, "marker_requested");
      assert.equal(id, current.id);
      assert.equal(path, operation.markerPath);
      assert.equal(value, operation.markerValue);
      marker = value;
      if (faults.writeError) throw faults.writeError;
      if (faults.expireAfterWrite) clock = operation.deadlineMs;
      if (faults.cancelAfterWrite) faults.cancelAfterWrite.abort();
      if (faults.hangingWrite) return new Promise(() => {});
    },
    async readMarker(id, path, context) {
      observe("read", context);
      assert.equal(id, current.id);
      assert.equal(path, operation.markerPath);
      if (faults.markerCorrupt) return "corrupt";
      return faults.persistenceCorrupt && events.includes("restore") ? "lost file" : marker;
    },
    async pause(id, context) {
      observe("pause", context);
      assert.equal(records.at(-1).phase, "pause_requested");
      assert.equal(id, current.id);
      current.state = faults.pauseState ?? "paused";
      current.lifecycle.endAtMs = current.state === "paused" ? null : operation.deadlineMs;
      if (faults.expireAfterPause) clock = operation.deadlineMs;
      if (faults.pauseAfterEffect) throw Error("PRIVATE_PAUSE_CONTENT");
    },
    async restore(id, context) {
      observe("restore", context);
      assert.equal(records.at(-1).phase, "restore_requested");
      assert.equal(id, current.id);
      current.state = faults.restoreState ?? "running";
      current.lifecycle.endAtMs = faults.extendedDeadline
        ? operation.deadlineMs + 1
        : operation.deadlineMs;
      if (faults.restoreAfterEffect) throw Error("PRIVATE_RESTORE_CONTENT");
    },
    async kill(id, context) {
      observe("kill", context);
      assert.equal(records.at(-1).phase, "cleanup_requested");
      assert.equal(id, current.id);
      if (faults.killBeforeEffect) throw Error("PRIVATE_KILL_CONTENT");
      if (!faults.killNoEffect) current = null;
      if (faults.killAfterEffect) throw Error("PRIVATE_KILL_CONTENT");
    },
  };
  const options = {
    startedAtMs,
    sourceSha256,
    now: () => clock,
    async persist(record) {
      assert.ok(Object.isFrozen(record));
      assert.ok(Object.isFrozen(record.operation));
      records.push(copy(record));
      if (faults.persistPhase === record.phase) throw Error("PRIVATE_JOURNAL_CONTENT");
      if (faults.cancelAfterPersist === record.phase) faults.cancelController.abort();
    },
  };
  return {
    port,
    options,
    events,
    records,
    contexts,
    resource,
    setCurrent: (value) => {
      current = copy(value);
    },
    setClock: (value) => {
      clock = value;
    },
    run: (extra = {}) => runSyntheticLab(profile, operationId, port, { ...options, ...extra }),
  };
}

test("synthetic compilation is closed and carries no dispatch or production authority", () => {
  const compiled = compileSyntheticLabProfile(profile);
  assert.equal(compiled.providerCalls, false);
  assert.equal(compiled.merchantDispatch, false);
  assert.equal(compiled.productionQualification, false);
  assert.ok(Object.isFrozen(compiled.profile));
  assert.match(compiled.profileSha256, /^[a-f0-9]{64}$/);
  const reordered = Object.fromEntries(Object.entries(profile).reverse());
  assert.equal(compileSyntheticLabProfile(reordered).profileSha256, compiled.profileSha256);
});

test("historical profiles decode only for cleanup and cannot start a new core run", async () => {
  for (const planSequence of [55, 56, 57, 58, 59]) {
    const original = { ...profile, planSequence };
    assert.equal(compileSyntheticLabProfile(original).profile.planSequence, planSequence);
    let providerAccesses = 0;
    let journalWrites = 0;
    const port = new Proxy(
      {},
      {
        get() {
          providerAccesses++;
          return async () => undefined;
        },
      },
    );
    await assert.rejects(
      runSyntheticLab(original, operationId, port, {
        startedAtMs,
        sourceSha256,
        now: () => startedAtMs,
        persist: async () => {
          journalWrites++;
        },
      }),
      /SYNTHETIC_LAB_PROFILE_DENIED/,
    );
    assert.equal(providerAccesses, 0);
    assert.equal(journalWrites, 0);
  }
});

test("historical55-59 original operations retain static cleanup after current60 selection", async () => {
  for (const planSequence of [55, 56, 57, 58, 59]) {
    const original = { ...profile, planSequence };
    const originalOperation = prepareSyntheticLabOperation(
      original,
      operationId,
      startedAtMs,
      sourceSha256,
    );
    const events = [];
    let present = true;
    const id = "original_historical_vm";
    const port = {
      inspect: async (seenId) => {
        events.push("inspect");
        assert.equal(seenId, id);
        return present
          ? {
              id,
              metadata: originalOperation.metadata,
              templateId: original.templateId,
              cpu: original.cpu,
              memoryMiB: original.memoryMiB,
              state: "paused",
              network: { outbound: "deny_all", controllerAuth: true },
              lifecycle: {
                onTimeout: "kill",
                autoResume: false,
                createdAtMs: startedAtMs,
                endAtMs: null,
              },
            }
          : null;
      },
      kill: async (seenId) => {
        events.push("kill");
        assert.equal(seenId, id);
        present = false;
      },
    };
    const result = await runSyntheticLab(original, operationId, port, {
      startedAtMs,
      sourceSha256,
      now: () => originalOperation.deadlineMs + 1,
      cleanupOnly: true,
      resume: {
        operation: originalOperation,
        createAttempted: true,
        sandboxId: id,
        phase: "paused",
      },
      persist: async () => undefined,
    });
    assert.equal(result.cleanup, "verified_deleted");
    assert.equal(result.deletionObservation, "absent");
    assert.equal(result.status, "failed");
    assert.equal(result.record.operation.profileSha256, originalOperation.profileSha256);
    assert.deepEqual(events, ["inspect", "kill", "inspect"]);
  }
});

test("profile rejects authority widening, extra fields, malformed bindings and nonfinite caps", () => {
  const denied = [
    { merchantRouting: true },
    { environment: "production" },
    { scope: "merchant" },
    { productionQualified: true },
    { planSequence: 54 },
    { maximumWallMs: 600001 },
    { cpu: 3 },
    { cpu: NaN },
    { memoryMiB: Infinity },
    { memoryMiB: 4097 },
    { diskMiB: 10241 },
    { outbound: "allow_all" },
    { expectedCreditCeilingUsd: "1" },
    { projectId: "native opaque" },
    { templateBuildId: "latest" },
    { templateId: "https://secret.example/template" },
    { providerId: "../unsafe" },
    { credentials: "PRIVATE" },
    { cpu: 1.5 },
  ];
  for (const change of denied)
    assert.throws(
      () => compileSyntheticLabProfile({ ...profile, ...change }),
      /^Error: SYNTHETIC_LAB_PROFILE_DENIED$/,
    );
});

test("profiles deny getters, hidden/symbol keys, prototypes, cycles and hostile proxy traps", () => {
  const getter = { ...profile };
  Object.defineProperty(getter, "cpu", {
    enumerable: true,
    get() {
      throw Error("PRIVATE");
    },
  });
  const hidden = { ...profile };
  Object.defineProperty(hidden, "credential", { value: "PRIVATE" });
  const symbolic = { ...profile, [Symbol("authority")]: true };
  const cyclic = { ...profile };
  cyclic.credential = cyclic;
  const proxy = new Proxy(profile, {
    ownKeys() {
      throw Error("PRIVATE");
    },
  });
  for (const value of [getter, hidden, symbolic, cyclic, proxy, Object.create(profile)])
    assert.throws(() => compileSyntheticLabProfile(value), /^Error: SYNTHETIC_LAB_PROFILE_DENIED$/);
});

test("core accepts another safe provider slug without vendor SDK or UUID resource assumptions", async () => {
  const alternative = { ...profile, providerId: "alternate-provider" };
  assert.equal(compileSyntheticLabProfile(alternative).profile.providerId, "alternate-provider");
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, "passed");
  assert.equal(result.record.sandboxId, "opaqueSandbox_x9-Z");
});

test("prepared operation pins source/profile/start/deadline and only a builtin synthetic file", () => {
  assert.equal(operation.deadlineMs, startedAtMs + 600000);
  assert.equal(operation.metadata.morrowSource, sourceSha256);
  assert.equal(operation.metadata.morrowProfile, compileSyntheticLabProfile(profile).profileSha256);
  assert.equal(operation.metadata.morrowDeadline, String(operation.deadlineMs));
  assert.equal(operation.markerPath, `/tmp/morrow-synthetic-${operationId}.txt`);
  assert.equal(operation.markerValue, `MORROW_SYNTHETIC_PERSISTENCE_V1:${operationId}\n`);
  for (const [id, start, source] of [
    ["bad", startedAtMs, sourceSha256],
    [operationId, -1, sourceSha256],
    [operationId, Number.MAX_SAFE_INTEGER, sourceSha256],
    [operationId, NaN, sourceSha256],
    [operationId, startedAtMs, "unbound"],
    [{ toString: () => operationId }, startedAtMs, sourceSha256],
    [operationId, startedAtMs, { toString: () => sourceSha256 }],
  ])
    assert.throws(
      () => prepareSyntheticLabOperation(profile, id, start, source),
      /SYNTHETIC_LAB_OPERATION_DENIED/,
    );
});

test("successful lifecycle journals before each effect, validates file restore and proves absence", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, "passed");
  assert.equal(result.code, "SYNTHETIC_LAB_CHECKS_PASSED");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.deletionObservation, "absent");
  assert.equal(result.record.phase, "deleted");
  assert.equal(result.productionQualified, false);
  assert.equal(result.memoryPersistenceClaimed, false);
  assert.deepEqual(f.events, [
    "lookup",
    "create",
    "inspect",
    "inspect",
    "write",
    "read",
    "pause",
    "inspect",
    "restore",
    "inspect",
    "read",
    "inspect",
    "kill",
    "inspect",
  ]);
  assert.deepEqual(
    f.records.map((r) => r.phase),
    [
      "prepared",
      "create_requested",
      "created",
      "marker_requested",
      "pause_requested",
      "paused",
      "restore_requested",
      "checking",
      "cleanup_requested",
      "deleted",
    ],
  );
});

test("unknown create after its effect reconciles original metadata and cleans without duplicate allocation", async () => {
  const f = fixture({ createAfterEffect: Error("PRIVATE_CREATE_CONTENT") });
  const result = await f.run();
  assert.equal(result.status, "failed");
  assert.equal(result.code, "SYNTHETIC_LAB_PROVIDER_FAILED");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.events.filter((x) => x === "create").length, 1);
  assert.equal(f.events.includes("write"), false);
});

test("an uncertain create with complete zero matches remains unresolved, never proof of absence", async () => {
  const f = fixture({ createBeforeEffect: Error("PRIVATE_CREATE_CONTENT") });
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "SYNTHETIC_LAB_CREATE_UNRESOLVED");
  assert.equal(result.cleanup, "unresolved");
  assert.equal(result.record.phase, "unresolved");
  assert.equal(result.record.createAttempted, true);
  assert.equal(result.record.sandboxId, null);
  assert.equal(f.events.filter((x) => x === "create").length, 1);
  assert.equal(f.events.includes("kill"), false);
});

for (const [name, change] of [
  ["metadata listing visibility lag", { lookupNoMatch: true }],
  ["incomplete pagination", { lookupIncomplete: true }],
  ["ambiguous matches", { lookupAmbiguous: true }],
]) {
  test(`unknown create cannot adopt or allocate across ${name}`, async () => {
    const f = fixture({ ...change, createAfterEffect: Error("PRIVATE_CREATE_CONTENT") });
    const result = await f.run();
    assert.equal(result.status, "unresolved");
    assert.equal(result.cleanup, "unresolved");
    assert.equal(result.record.sandboxId, null);
    assert.equal(f.events.filter((x) => x === "create").length, 1);
    assert.equal(f.events.includes("kill"), false);
  });
}

test("a foreign resource returned during reconciliation cannot be adopted or killed", async () => {
  const f = fixture({ lookupForeign: true, createAfterEffect: Error("PRIVATE") });
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.cleanup, "foreign_resource_denied");
  assert.equal(f.events.includes("kill"), false);
});

test("a foreign create response is ignored; only the owned reconciled resource is cleaned", async () => {
  const f = fixture({ foreignCreateResponse: true });
  const result = await f.run();
  assert.equal(result.code, "SYNTHETIC_LAB_IDENTITY_DENIED");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.record.sandboxId, "opaqueSandbox_x9-Z");
  assert.equal(f.events.includes("write"), false);
});

test("absence of an unconfirmed reconciliation ID cannot hide an unknown original allocation", async () => {
  const f = fixture({ lookupClaimedForeignId: true, createAfterEffect: Error("PRIVATE") });
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "SYNTHETIC_LAB_CREATE_UNRESOLVED");
  assert.equal(result.cleanup, "unresolved");
  assert.equal(result.record.sandboxId, null);
  assert.equal(result.deletionObservation, "not_observed");
  assert.equal(f.events.includes("kill"), false);
});

for (const [name, created] of [
  ["foreign template", { templateId: "different-image" }],
  ["larger CPU", { cpu: 4 }],
  ["wrong RAM", { memoryMiB: 2048 }],
  ["unknown egress", { network: { outbound: "unknown", controllerAuth: true } }],
  ["unauthenticated ingress", { network: { outbound: "deny_all", controllerAuth: false } }],
  [
    "automatic resume",
    {
      lifecycle: {
        onTimeout: "kill",
        autoResume: true,
        createdAtMs: startedAtMs,
        endAtMs: operation.deadlineMs,
      },
    },
  ],
  [
    "unknown timeout policy",
    {
      lifecycle: {
        onTimeout: "unknown",
        autoResume: false,
        createdAtMs: startedAtMs,
        endAtMs: operation.deadlineMs,
      },
    },
  ],
  [
    "extended native deadline",
    {
      lifecycle: {
        onTimeout: "kill",
        autoResume: false,
        createdAtMs: startedAtMs,
        endAtMs: operation.deadlineMs + 1,
      },
    },
  ],
]) {
  test(`${name} denies probes while preserving cleanup of the owned resource`, async () => {
    const f = fixture({ created });
    const result = await f.run();
    assert.equal(result.status, "failed");
    assert.equal(result.code, "SYNTHETIC_LAB_PROFILE_DENIED");
    assert.equal(result.cleanup, "verified_deleted");
    assert.equal(f.events.includes("write"), false);
    assert.equal(f.events.filter((x) => x === "kill").length, 1);
  });
}

test("ownership changed before cleanup is denied even with an originally recorded resource ID", async () => {
  const f = fixture({ foreignDuringCleanup: true, writeError: Error("PRIVATE") });
  const result = await f.run();
  assert.equal(result.cleanup, "foreign_resource_denied");
  assert.equal(result.status, "unresolved");
  assert.equal(f.events.includes("kill"), false);
});

test("marker verification failure cleans and cannot qualify file persistence", async () => {
  const f = fixture({ markerCorrupt: true });
  const result = await f.run();
  assert.equal(result.code, "SYNTHETIC_LAB_MARKER_DENIED");
  assert.equal(result.status, "failed");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.events.includes("pause"), false);
});

test("file lost across restore fails rather than claiming memory or file persistence", async () => {
  const f = fixture({ persistenceCorrupt: true });
  const result = await f.run();
  assert.equal(result.code, "SYNTHETIC_LAB_PERSISTENCE_DENIED");
  assert.equal(result.status, "failed");
  assert.equal(result.memoryPersistenceClaimed, false);
  assert.equal(result.cleanup, "verified_deleted");
});

for (const [name, faults] of [
  ["pause without a paused observation", { pauseState: "running" }],
  ["restore without running", { restoreState: "paused" }],
  ["restore extending original expiry", { extendedDeadline: true }],
]) {
  test(name, async () => {
    const f = fixture(faults);
    const result = await f.run();
    assert.equal(result.code, "SYNTHETIC_LAB_PROFILE_DENIED");
    assert.equal(result.status, "failed");
    assert.equal(result.cleanup, "verified_deleted");
  });
}

for (const [name, faults] of [
  ["pause", { pauseAfterEffect: true }],
  ["restore", { restoreAfterEffect: true }],
]) {
  test(`uncertain ${name} cleans with static inspection, never retries the transition`, async () => {
    const f = fixture(faults);
    const result = await f.run();
    assert.equal(result.status, "failed");
    assert.equal(result.cleanup, "verified_deleted");
    assert.equal(f.events.filter((x) => x === name).length, 1);
    assert.equal(f.events.at(-1), "inspect");
  });
}

test("native running deadlines never excuse an indefinite paused instance after wall expiry", async () => {
  const f = fixture({ expireAfterPause: true });
  const result = await f.run();
  assert.equal(result.code, "SYNTHETIC_LAB_DEADLINE");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.events.includes("restore"), false);
  assert.equal(f.events.filter((x) => x === "kill").length, 1);
});

test("cancellation during create aborts the call scope and reconciles the original side effect", async () => {
  const controller = new AbortController();
  const f = fixture({ cancelDuringCreate: controller });
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.code, "SYNTHETIC_LAB_CANCELLED");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.contexts.find((entry) => entry.name === "create").context.signal.aborted, true);
  assert.equal(f.contexts.find((entry) => entry.name === "kill").context.signal.aborted, false);
});

test("cancellation after file write denies further probes and still kills", async () => {
  const controller = new AbortController();
  const f = fixture({ cancelAfterWrite: controller });
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.code, "SYNTHETIC_LAB_CANCELLED");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.events.includes("read"), false);
});

test("deadline after write blocks subsequent probes but grants only finite cleanup scope", async () => {
  const f = fixture({ expireAfterWrite: true });
  const result = await f.run();
  assert.equal(result.code, "SYNTHETIC_LAB_DEADLINE");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.events.includes("read"), false);
});

test("a nonresponsive marker operation times out and cleanup is independently bounded", async () => {
  const f = fixture({ hangingWrite: true });
  f.setClock(operation.deadlineMs - 10);
  const result = await f.run();
  assert.equal(result.code, "SYNTHETIC_LAB_DEADLINE");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.contexts.find((entry) => entry.name === "write").context.signal.aborted, true);
});

test("an already-cancelled run performs no provider calls", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.code, "SYNTHETIC_LAB_CANCELLED");
  assert.equal(result.cleanup, "not_needed");
  assert.deepEqual(f.events, []);
});

for (const [name, faults] of [
  ["kill rejects before its effect", { killBeforeEffect: true }],
  ["kill returns without terminating", { killNoEffect: true }],
]) {
  test(name, async () => {
    const f = fixture(faults);
    const result = await f.run();
    assert.equal(result.status, "unresolved");
    assert.equal(result.cleanup, "unresolved");
    assert.equal(result.record.phase, "unresolved");
    assert.equal(result.deletionObservation, "not_observed");
  });
}

test("a kill that throws after deletion can pass only after static GET proves absence", async () => {
  const f = fixture({ killAfterEffect: true });
  const result = await f.run();
  assert.equal(result.status, "passed");
  assert.equal(result.cleanup, "verified_deleted");
  assert.deepEqual(f.events.slice(-2), ["kill", "inspect"]);
});

test("readonly inspection failure does not authorize blind deletion or implicit restore", async () => {
  const f = fixture({ inspectError: Error("PRIVATE_INSPECT_CONTENT") });
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.cleanup, "unresolved");
  assert.equal(f.events.includes("kill"), false);
  assert.equal(f.events.includes("restore"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

for (const phase of ["prepared", "create_requested"]) {
  test(`journal failure at ${phase} denies allocation`, async () => {
    const f = fixture({ persistPhase: phase });
    const result = await f.run();
    assert.equal(result.status, "unresolved");
    assert.equal(result.code, "SYNTHETIC_LAB_JOURNAL_FAILED");
    assert.equal(f.events.includes("create"), false);
    assert.equal(f.events.includes("kill"), false);
  });
}

test("journal failure after create still cleans but remains an unresolved durable result", async () => {
  const f = fixture({ persistPhase: "created" });
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "SYNTHETIC_LAB_JOURNAL_FAILED");
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(f.events.includes("write"), false);
});

test("failed cleanup journaling holds the resource rather than executing an unrecorded kill", async () => {
  const f = fixture({ persistPhase: "cleanup_requested" });
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "SYNTHETIC_LAB_JOURNAL_FAILED");
  assert.equal(result.cleanup, "unresolved");
  assert.equal(f.events.includes("kill"), false);
});

test("terminal journal failure never reports a qualified successful lifecycle", async () => {
  const f = fixture({ persistPhase: "deleted" });
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "SYNTHETIC_LAB_JOURNAL_FAILED");
  assert.equal(result.cleanup, "verified_deleted");
});

test("cleanup-only expiry/funding recovery statically kills a paused original without probes", async () => {
  const f = fixture();
  const paused = f.resource();
  paused.state = "paused";
  paused.lifecycle.endAtMs = null;
  f.setCurrent(paused);
  f.setClock(operation.deadlineMs + 999999);
  const resume = { operation, createAttempted: true, sandboxId: paused.id, phase: "paused" };
  const controller = new AbortController();
  controller.abort();
  const result = await f.run({ cleanupOnly: true, resume, signal: controller.signal });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "SYNTHETIC_LAB_CLEANUP_ONLY");
  assert.equal(result.cleanup, "verified_deleted");
  assert.deepEqual(f.events, ["inspect", "kill", "inspect"]);
});

test("cleanup-only known terminal absence needs no delete or provider resume", async () => {
  const f = fixture();
  const resume = {
    operation,
    createAttempted: true,
    sandboxId: "opaqueSandbox_x9-Z",
    phase: "deleted",
  };
  const result = await f.run({ cleanupOnly: true, resume });
  assert.equal(result.cleanup, "verified_deleted");
  assert.equal(result.status, "failed");
  assert.deepEqual(f.events, ["inspect"]);
});

test("cleanup-only uncertain original creation with zero matches cannot clear the journal", async () => {
  const f = fixture();
  const resume = { operation, createAttempted: true, sandboxId: null, phase: "create_requested" };
  const result = await f.run({ cleanupOnly: true, resume });
  assert.equal(result.status, "unresolved");
  assert.equal(result.cleanup, "unresolved");
  assert.equal(result.record.phase, "unresolved");
  assert.deepEqual(f.events, ["lookup"]);
});

test("cleanup-only prepared operation with no attempted create has no provider authority", async () => {
  const f = fixture();
  const resume = { operation, createAttempted: false, sandboxId: null, phase: "prepared" };
  const result = await f.run({ cleanupOnly: true, resume });
  assert.equal(result.cleanup, "not_needed");
  assert.equal(result.code, "SYNTHETIC_LAB_CLEANUP_ONLY");
  assert.deepEqual(f.events, []);
});

test("cleanup-only requires the original record and denies source/profile/identity/deadline drift", async () => {
  const f = fixture();
  const valid = {
    operation,
    createAttempted: true,
    sandboxId: "opaqueSandbox_x9-Z",
    phase: "paused",
  };
  for (const resume of [
    undefined,
    { ...valid, extraAuthority: true },
    { ...valid, sandboxId: "bad/id" },
    { ...valid, createAttempted: false },
    { ...valid, phase: "unknown" },
    { ...valid, operation: { ...operation, sourceSha256: "b".repeat(64) } },
    { ...valid, operation: { ...operation, profileSha256: "b".repeat(64) } },
    { ...valid, operation: { ...operation, deadlineMs: operation.deadlineMs + 1 } },
  ])
    await assert.rejects(f.run({ cleanupOnly: true, resume }), /SYNTHETIC_LAB_RESUME_DENIED/);
  await assert.rejects(f.run({ resume: valid }), /SYNTHETIC_LAB_RESUME_DENIED/);
  await assert.rejects(f.run({ cleanupOnly: "yes", resume: valid }), /SYNTHETIC_LAB_RESUME_DENIED/);
  assert.deepEqual(f.events, []);
});

test("provider exceptions with hostile getters/proxies become fixed redacted codes", async () => {
  const getter = {};
  Object.defineProperty(getter, "message", {
    get() {
      throw Error("PRIVATE_GETTER");
    },
  });
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error("PRIVATE_PROXY");
      },
    },
  );
  for (const error of [getter, proxy, Error("PRIVATE_TOKEN raw provider content")]) {
    const f = fixture({ writeError: error });
    const result = await f.run();
    assert.equal(result.code, "SYNTHETIC_LAB_PROVIDER_FAILED");
    assert.equal(result.cleanup, "verified_deleted");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
});
