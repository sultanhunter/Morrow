import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  compileSyntheticLabProfile,
  prepareSyntheticLabOperation,
} from "../packages/infrastructure/src/synthetic-runtime-lab.ts";
import {
  validateE2BOwnedBuildReadyProof,
  prepareE2BOwnedBuildOperation,
  createE2BOwnedBuildNativePort,
  runE2BOwnedBuild,
} from "../packages/runtime-adapters/src/e2b/owned-build.ts";
import { discoverE2BDevelopmentOwnedTemplates } from "../packages/runtime-adapters/src/e2b/development-transport.ts";
import { createE2BNativeDevelopmentTransport } from "../packages/runtime-adapters/src/e2b/development-native.ts";

const history = JSON.parse(readFileSync("tests/fixtures/e2b-observed-build-65.json", "utf8"));
const record = history.result.record,
  observed = history.result.observation;
const clock = observed.finishedAtMs + 1000;
const source = "b20517ffdaac601c56edea1c2d75d81c636b914b7b546be7661aaf3236c8b4ce";
const key = "e2b_synthetic_observed_build_test_only";
const profile = () => ({
  schemaVersion: 1,
  task: "P04.T01h",
  planSequence: 67,
  scope: "builtin_synthetic_operator",
  environment: "development",
  providerId: "e2b",
  projectId: record.recipe.projectId,
  templateId: record.templateId,
  templateBuildId: record.buildId,
  cpu: 2,
  memoryMiB: 512,
  diskMiB: 12422,
  maximumWallMs: 600000,
  expectedCreditCeilingUsd: "0.25",
  outbound: "deny_all",
  merchantRouting: false,
});
const json = (value) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function wire(changes = {}) {
  const value = { ...observed, ...changes },
    calls = [];
  const build = {
    buildID: value.buildId,
    status: "ready",
    cpuCount: value.cpu,
    memoryMB: value.memoryMiB,
    diskSizeMB: value.diskMiB,
    envdVersion: value.envdVersion,
    createdAt: new Date(value.createdAtMs).toISOString(),
    finishedAt: new Date(value.finishedAtMs).toISOString(),
  };
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["X-API-Key"], key);
    assert.equal(options.method, "GET");
    const path = new URL(url).pathname;
    if (path.endsWith("/metrics")) return json([]);
    if (path === "/v2/templates")
      return json([
        {
          templateID: value.templateId,
          buildID: value.buildId,
          buildStatus: "ready",
          cpuCount: value.cpu,
          memoryMB: value.memoryMiB,
          diskSizeMB: value.diskMiB,
          envdVersion: value.envdVersion,
        },
      ]);
    assert.equal(path, `/templates/${value.templateId}`);
    return json({
      templateID: value.templateId,
      public: true === changes.public,
      aliases: [record.operation.name],
      names: [`sultan/${record.operation.name}`],
      createdAt: new Date(record.operation.startedAtMs).toISOString(),
      builds: [build],
    });
  };
  return { calls, fetch, now: () => clock };
}

test("observed build65 record binds the exact actual operation source", () => {
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(history.source_sha256, source);
  assert.equal(sha(JSON.stringify(history.source_digests)), source);
});

test("only the exact observed12422 tuple qualifies the bounded66 runtime profile", () => {
  assert.equal(compileSyntheticLabProfile(profile()).profile.diskMiB, 12422);
  for (const drift of [
    { diskMiB: 12421 },
    { diskMiB: 12423 },
    { diskMiB: 10241 },
    { planSequence: 65 },
    { providerId: "foreign" },
    { projectId: "11111111-1111-4111-8111-111111111111" },
    { templateId: "foreign" },
    { templateBuildId: "11111111-1111-4111-8111-111111111111" },
    { cpu: 1 },
    { memoryMiB: 1024 },
  ])
    assert.throws(() => compileSyntheticLabProfile({ ...profile(), ...drift }), /PROFILE_DENIED/);
});

test("original65 ready proof accepts actual total disk while neighboring sizes and identities deny", () => {
  assert.equal(validateE2BOwnedBuildReadyProof(observed, record).diskMiB, 12422);
  for (const drift of [
    { diskMiB: 12421 },
    { diskMiB: 12423 },
    { diskMiB: 10241 },
    { envdVersion: "0.10.1" },
    { private: false },
    { templateId: "foreign" },
  ])
    assert.throws(() => validateE2BOwnedBuildReadyProof({ ...observed, ...drift }, record));
  assert.throws(() =>
    validateE2BOwnedBuildReadyProof(observed, {
      ...record,
      operation: { ...record.operation, sourceSha256: "f".repeat(64) },
    }),
  );
});

test("the observed ready record cannot be relabeled as a current66 owned operation", () => {
  const relabeled = prepareE2BOwnedBuildOperation(
    { ...record.recipe, planSequence: 66 },
    record.operation.operationId,
    record.operation.startedAtMs,
    source,
    record.operation.accountObservationSha256,
    record.operation.manifestProofSha256,
  );
  assert.throws(() =>
    validateE2BOwnedBuildReadyProof(observed, {
      ...relabeled,
      registrationAttempted: true,
      startAttempted: true,
      registrationVerified: true,
      templateId: record.templateId,
      buildId: record.buildId,
      phase: "held",
    }),
  );
});

test("original65 native reconciliation performs only GET and retains original source and IDs", async () => {
  const f = wire(),
    port = createE2BOwnedBuildNativePort(
      { apiKey: key, record, authorization: null, mode: "reconcile" },
      f,
    );
  const result = await runE2BOwnedBuild(record, port, {
    mode: "reconcile",
    authorization: null,
    now: f.now,
    signal: new AbortController().signal,
    persist: async () => {},
    maximumPolls: 1,
  });
  assert.equal(result.status, "ready_retained");
  assert.equal(result.record.recipe.planSequence, 65);
  assert.equal(result.record.operation.sourceSha256, source);
  assert.equal(result.record.templateId, record.templateId);
  assert.equal(result.record.buildId, record.buildId);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["GET", "GET"],
  );
  assert.throws(() =>
    createE2BOwnedBuildNativePort({ apiKey: key, record, authorization: null, mode: "build" }, f),
  );
});

test("owned discovery and native66 qualification accept only the exact observed build above10240", async () => {
  const f = wire();
  const discovered = await discoverE2BDevelopmentOwnedTemplates(
    { apiKey: key, projectId: record.recipe.projectId },
    f,
  );
  assert.equal(discovered.builds.length, 1);
  assert.equal(discovered.builds[0].diskMiB, 12422);
  assert.equal(discovered.runtimeProfileQualified, false);
  const p = profile(),
    operation = prepareSyntheticLabOperation(
      p,
      "33333333-3333-4333-8333-333333333333",
      clock,
      "f".repeat(64),
    );
  const native = await createE2BNativeDevelopmentTransport(
    { apiKey: key, profile: p, operation, mode: "allocate" },
    wire(),
  );
  assert.equal(native.qualification.template.diskMiB, 12422);
  for (const drift of [
    { diskMiB: 12421 },
    { diskMiB: 12423 },
    { diskMiB: 10241 },
    { envdVersion: "0.10.1" },
    { cpu: 1 },
    { memoryMiB: 1024 },
  ]) {
    const wrong = await discoverE2BDevelopmentOwnedTemplates(
      { apiKey: key, projectId: record.recipe.projectId },
      wire(drift),
    );
    assert.equal(wrong.builds.length, 0);
  }
});
