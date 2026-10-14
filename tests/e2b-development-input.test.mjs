import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspectE2BLabAccount,
  loadE2BLabInput,
  loadE2BReadOnlyAccess,
  openE2BLabJournal,
  parseE2BLabInput,
} from "../scripts/e2b-development-input.mjs";
import {
  compileSyntheticLabProfile,
  prepareSyntheticLabOperation,
} from "../packages/infrastructure/src/synthetic-runtime-lab.ts";
import { mainE2BLab } from "../scripts/e2b-development-lab.mjs";
import { frozenE2B60Fixture, currentE2BFixture } from "./fixtures/frozen-e2b-60.mjs";

const projectId = "a1234567-1234-4234-8234-123456789abc";
const operationId = "b1234567-1234-4234-8234-123456789abc";
const otherOperation = "c1234567-1234-4234-8234-123456789abc";
const now = Date.parse("2026-10-14T10:00:00Z");
const profile = {
  schemaVersion: 1,
  task: "P04.T01h",
  planSequence: 67,
  scope: "builtin_synthetic_operator",
  environment: "development",
  providerId: "e2b",
  projectId,
  templateId: "synthetic_template",
  templateBuildId: "d1234567-1234-4234-8234-123456789abc",
  cpu: 2,
  memoryMiB: 512,
  diskMiB: 10240,
  maximumWallMs: 600000,
  expectedCreditCeilingUsd: "0.25",
  outbound: "deny_all",
  merchantRouting: false,
};
const { profileSha256 } = compileSyntheticLabProfile(profile);
const expected = {
  projectId,
  profileSha256,
  sourceSha256: "b".repeat(64),
  accountObservationSha256: "c".repeat(64),
};
const input = () => ({
  environment: "development",
  operationId,
  apiKey: "synthetic-key-" + "x".repeat(32),
  ...expected,
});
const account = () => ({
  schema_version: 1,
  plan_sequence: 67,
  observed_at: new Date(now).toISOString(),
  project_id: projectId,
  workspace: "Personal Workspace",
  project_name: "Sultanibne's Project",
  plan: "Hobby",
  region: "US-WEST-1",
  free_credit_usd: "100.00",
  paid_credit_usd: "0.00",
  payment_method_on_file: false,
  automatic_charge_enabled: false,
  trial_eligibility_confirmed: true,
  operator_access_authorized: true,
  allocation_authorized: true,
  private_access_receipt: "owner_explicit",
  profile_sha256: profileSha256,
  quote: {
    cpu_usd_per_second: "0.000014",
    ram_gib_usd_per_second: "0.0000045",
    additional_expected_usd: "0.000000",
    all_applicable_meters_qualified: true,
    profile_sha256: profileSha256,
    maximum_wall_ms: 600000,
    credit_ceiling_usd: "0.25",
  },
});
const envelope = () => ({
  schemaVersion: 1,
  profile,
  accountObservationSha256: expected.accountObservationSha256,
  sourceDigests: {},
  record: {
    operation: prepareSyntheticLabOperation(profile, operationId, now, expected.sourceSha256),
    createAttempted: false,
    sandboxId: null,
    phase: "prepared",
  },
});
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-e2b-input-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("unbound default prepares offline without loading private input or SDK", (t) => {
  const frozen = frozenE2B60Fixture();
  t.after(frozen.dispose);
  const out = spawnSync(
    process.execPath,
    ["--import", frozen.loader, frozen.script("scripts/e2b-development-lab.mjs")],
    {
      encoding: "utf8",
      cwd: frozen.root,
      env: { ...process.env, E2B_API_KEY: "untrusted-ambient" },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(frozen.read("docs/evidence/P04.T01h/preparation.json"));
  assert.equal(report.provider_calls, false);
  assert.equal(report.private_input_read, false);
  assert.equal(report.live_ready, false);
  assert.ok(report.blockers.includes("E2B_LAB_PROFILE_UNBOUND"));
  assert.equal(report.production_qualified, false);
});
test("unqualified run denies before credentials, journal or provider calls", (t) => {
  const frozen = frozenE2B60Fixture();
  t.after(frozen.dispose);
  const out = spawnSync(
    process.execPath,
    [
      "--import",
      frozen.loader,
      frozen.script("scripts/e2b-development-lab.mjs"),
      "--run",
      "/does-not-exist/private-key.json",
    ],
    { encoding: "utf8", cwd: frozen.root },
  );
  assert.equal(out.status, 2);
  assert.match(out.stdout, /PREREQUISITES_UNQUALIFIED/);
  const report = JSON.parse(frozen.read("docs/evidence/P04.T01h/live.json"));
  assert.equal(report.private_input_read, false);
  assert.equal(report.provider_calls, false);
});
test("readonly discovery preparation cannot read credentials or overwrite live qualification", (t) => {
  const frozen = frozenE2B60Fixture();
  t.after(frozen.dispose);
  const destination = "docs/evidence/P04.T01h/template-qualification.json";
  const previous = existsSync(destination) ? readFileSync(destination, "utf8") : null;
  const out = spawnSync(
    process.execPath,
    ["--import", frozen.loader, frozen.script("scripts/e2b-template-qualification.mjs")],
    { encoding: "utf8", cwd: frozen.root },
  );
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(frozen.read("docs/evidence/P04.T01h/template-preparation.json"));
  assert.equal(report.provider_calls, false);
  assert.equal(report.private_input_read, false);
  assert.equal(report.sandbox_allocated, false);
  assert.equal(existsSync(destination) ? readFileSync(destination, "utf8") : null, previous);
});
test("current plan denies a frozen60 allocation before private input", (t) => {
  const frozen = frozenE2B60Fixture();
  t.after(frozen.dispose);
  frozen.useCurrentPlan();
  const out = spawnSync(
    process.execPath,
    [
      "--import",
      frozen.loader,
      frozen.script("scripts/e2b-development-lab.mjs"),
      "--run",
      "/does-not-exist/private-key.json",
    ],
    { encoding: "utf8", cwd: frozen.root },
  );
  assert.equal(out.status, 2, out.stderr);
  assert.match(out.stdout, /PREREQUISITES_UNQUALIFIED/);
  const report = JSON.parse(frozen.read("docs/evidence/P04.T01h/live.json"));
  assert.equal(report.plan_sequence, 67);
  assert.ok(report.blockers.includes("E2B_LAB_SELECTED_PLAN_DENIED"));
  assert.equal(report.private_input_read, false);
  assert.equal(report.provider_calls, false);
});
test("approved readonly access file denies foreign project or expanded allocation authority", (t) => {
  const root = temporary(t),
    file = join(root, "key.json");
  const bound = {
    projectId,
    consoleProjectId: "prj_synthetic_readonly",
    workspaceId: otherOperation,
  };
  const access = {
    schemaVersion: 1,
    ...bound,
    keyLabel: "Morrow-qualification-2026-10-14",
    apiKey: "e2b_synthetic_readonly_key_only",
    accessAuthorized: true,
    allocationAuthorized: false,
  };
  writeFileSync(file, JSON.stringify(access), { mode: 0o600 });
  assert.equal(loadE2BReadOnlyAccess(file, root, bound).projectId, projectId);
  for (const changed of [
    { projectId: otherOperation },
    { consoleProjectId: "foreign" },
    { workspaceId: projectId },
    { allocationAuthorized: true },
    { accessAuthorized: false },
    { keyLabel: "foreign" },
    { arbitraryUrl: "https://foreign.test" },
  ]) {
    writeFileSync(file, JSON.stringify({ ...access, ...changed }));
    assert.throws(() => loadE2BReadOnlyAccess(file, root, bound), /PRIVATE_INPUT_DENIED/);
  }
});
test("only current owned free-credit access and complete bounded quote qualify", () => {
  assert.deepEqual(inspectE2BLabAccount(account(), profile, now), []);
  for (const change of [
    { plan_sequence: 59 },
    { project_id: otherOperation },
    { workspace: "Personal" },
    { project_name: "Other" },
    { plan: "Pro" },
    { region: "unknown" },
    { free_credit_usd: "0.00" },
    { paid_credit_usd: "1.00" },
    { payment_method_on_file: true },
    { automatic_charge_enabled: true },
    { trial_eligibility_confirmed: false },
    { operator_access_authorized: false },
    { allocation_authorized: false },
    { private_access_receipt: null },
    { observed_at: new Date(now + 1).toISOString() },
    { observed_at: new Date(now - 1_800_001).toISOString() },
  ])
    assert.ok(
      inspectE2BLabAccount({ ...account(), ...change }, profile, now).length,
      JSON.stringify(change),
    );
  for (const change of [
    { cpu_usd_per_second: "0.000001" },
    { ram_gib_usd_per_second: "0" },
    { additional_expected_usd: "0.250000" },
    { all_applicable_meters_qualified: false },
    { profile_sha256: "d".repeat(64) },
    { maximum_wall_ms: 600001 },
    { credit_ceiling_usd: "1.00" },
  ])
    assert.ok(
      inspectE2BLabAccount({ ...account(), quote: { ...account().quote, ...change } }, profile, now)
        .length,
    );
});
test("private input binds original project/profile/source/account without scope expansion", () => {
  assert.equal(parseE2BLabInput(input(), expected).operationId, operationId);
  for (const change of [
    { projectId: otherOperation },
    { environment: "production" },
    { sourceSha256: "d".repeat(64) },
    { profileSha256: "d".repeat(64) },
    { accountObservationSha256: "d".repeat(64) },
    { operationId: "../escape" },
    { apiKey: "short" },
    { apiKey: "x".repeat(32) + "\n" },
    { connect: true },
  ])
    assert.throws(
      () => parseE2BLabInput({ ...input(), ...change }, expected),
      /PRIVATE_INPUT_DENIED/,
    );
});
test("private credential file rejects symlinks, hardlinks, outside paths and permissive modes", (t) => {
  const root = temporary(t),
    file = join(root, "input.json");
  writeFileSync(file, JSON.stringify(input()), { mode: 0o600 });
  assert.equal(loadE2BLabInput(file, root, expected).projectId, projectId);
  chmodSync(file, 0o644);
  assert.throws(() => loadE2BLabInput(file, root, expected), /DENIED/);
  chmodSync(file, 0o600);
  const sym = join(root, "symbolic.json");
  symlinkSync(file, sym);
  assert.throws(() => loadE2BLabInput(sym, root, expected), /DENIED/);
  const hard = join(root, "hard.json");
  linkSync(file, hard);
  assert.throws(() => loadE2BLabInput(file, root, expected), /DENIED/);
  rmSync(hard);
  assert.throws(() => loadE2BLabInput(file, root + "-foreign", expected), /DENIED/);
  assert.throws(() => loadE2BLabInput("relative.json", root, expected), /DENIED/);
  chmodSync(root, 0o755);
  assert.throws(() => loadE2BLabInput(file, root, expected), /DENIED/);
});
test("journal mutex precedes recovery read and a new operation cannot bypass pending effects", async (t) => {
  const root = temporary(t),
    first = openE2BLabJournal(root, operationId);
  await first.persist(envelope());
  assert.throws(() => openE2BLabJournal(root, otherOperation), /CONTROLLER_ALREADY_ACTIVE/);
  first.closeController();
  assert.throws(() => openE2BLabJournal(root, otherOperation), /PENDING_OPERATION/);
  assert.throws(() => openE2BLabJournal(root, otherOperation, true), /PRIVATE_INPUT_DENIED/);
  const recovery = openE2BLabJournal(root, operationId, true);
  assert.equal(recovery.envelope.record.operation.deadlineMs, now + 600000);
  recovery.closeController();
});
test("cleanup uses original profile/source even when selected files change", async (t) => {
  const root = temporary(t),
    first = openE2BLabJournal(root, operationId);
  await first.persist(envelope());
  first.closeController();
  const recovery = openE2BLabJournal(root, operationId, true),
    original = recovery.envelope;
  const file = join(root, "key.json");
  writeFileSync(file, JSON.stringify(input()), { mode: 0o600 });
  const fromOriginal = {
    projectId: original.profile.projectId,
    profileSha256: original.record.operation.profileSha256,
    sourceSha256: original.record.operation.sourceSha256,
    accountObservationSha256: original.accountObservationSha256,
  };
  assert.equal(loadE2BLabInput(file, root, fromOriginal).sourceSha256, expected.sourceSha256);
  assert.throws(
    () => loadE2BLabInput(file, root, { ...fromOriginal, sourceSha256: "e".repeat(64) }),
    /DENIED/,
  );
  recovery.closeController();
});
test("uncertain create/no-match and unverifiable deletion keep original journal", async (t) => {
  const root = temporary(t),
    journal = openE2BLabJournal(root, operationId),
    saved = envelope();
  saved.record.createAttempted = true;
  saved.record.phase = "unresolved";
  await journal.persist(saved);
  for (const result of [
    { status: "unresolved", cleanup: "unresolved", deletionObservation: "not_observed" },
    { status: "failed", cleanup: "verified_deleted", deletionObservation: "not_observed" },
    { status: "failed", cleanup: "not_needed", deletionObservation: "not_observed" },
  ])
    assert.equal(journal.release({ ...result, record: saved.record }), false);
  assert.throws(
    () =>
      journal.release({
        status: "failed",
        cleanup: "not_needed",
        record: { ...saved.record, createAttempted: false },
      }),
    /PRIVATE_INPUT_DENIED/,
  );
  assert.ok(existsSync(join(root, "e2b-development-active/operation.json")));
  journal.closeController();
});
test("verified terminal deletion durably archives original operation before slot release", async (t) => {
  const root = temporary(t),
    journal = openE2BLabJournal(root, operationId),
    saved = envelope();
  saved.record.createAttempted = true;
  saved.record.sandboxId = "opaque-native";
  saved.record.phase = "deleted";
  await journal.persist(saved);
  assert.equal(
    journal.release({
      status: "failed",
      cleanup: "verified_deleted",
      deletionObservation: "absent",
      record: saved.record,
    }),
    true,
  );
  const receipt = JSON.parse(
    readFileSync(join(root, `e2b-development-${operationId}-terminal.json`)),
  );
  assert.equal(receipt.envelope.profile.projectId, projectId);
  assert.equal(receipt.result.record.operation.sourceSha256, expected.sourceSha256);
  assert.equal(existsSync(join(root, "e2b-development-active")), false);
  journal.closeController();
  assert.throws(() => openE2BLabJournal(root, operationId), /OPERATION_ALREADY_TERMINAL/);
});
test("foreign release, replaced mutex and symlinked journal are denied", async (t) => {
  const root = temporary(t),
    journal = openE2BLabJournal(root, operationId);
  await journal.persist(envelope());
  assert.throws(
    () => journal.release({ record: { operation: { operationId: otherOperation } } }),
    /DENIED/,
  );
  journal.closeController();
  const file = join(root, "e2b-development-active/operation.json"),
    target = join(root, "replacement.json");
  writeFileSync(target, JSON.stringify(envelope()), { mode: 0o600 });
  rmSync(file);
  symlinkSync(target, file);
  assert.throws(() => openE2BLabJournal(root, operationId, true), /PRIVATE_INPUT_DENIED/);
  assert.equal(existsSync(join(root, "e2b-development-controller.lock")), false);
});
test("original60 controller cleanup survives malformed allocation files and different current source", async (t) => {
  const root = temporary(t),
    first = openE2BLabJournal(root, operationId),
    saved = envelope();
  saved.profile = { ...saved.profile, planSequence: 60 };
  saved.record.operation = prepareSyntheticLabOperation(
    saved.profile,
    operationId,
    now,
    expected.sourceSha256,
  );
  saved.record.createAttempted = true;
  saved.record.sandboxId = "owned-original";
  saved.record.phase = "paused";
  await first.persist(saved);
  first.closeController();
  const file = join(root, "key.json");
  writeFileSync(
    file,
    JSON.stringify({ ...input(), profileSha256: saved.record.operation.profileSha256 }),
    { mode: 0o600 },
  );
  const calls = [],
    port = {
      qualification: null,
      inspect: async (id) => {
        calls.push(["inspect", id]);
        return null;
      },
      create: async () => {
        throw Error("allocation must never occur");
      },
      restore: async () => {
        throw Error("restore must never occur");
      },
      kill: async () => {
        throw Error("absent resource must not be killed");
      },
    };
  const result = await mainE2BLab(["--cleanup", operationId, file], {
    privateRoot: root,
    evidenceDirectory: join(root, "evidence"),
    readFile: () => {
      throw Error("current draft/account/plan missing or malformed");
    },
    sourceBinding: () => {
      throw Error("current source manifest removed");
    },
    transportFactory: async ({ profile: original, operation, mode }) => {
      assert.equal(original.projectId, projectId);
      assert.equal(original.planSequence, 60);
      assert.equal(operation.sourceSha256, expected.sourceSha256);
      assert.equal(mode, "cleanup");
      return port;
    },
  });
  assert.equal(result, 0);
  const report = JSON.parse(readFileSync(join(root, "evidence/live.json")));
  assert.equal(report.plan_sequence, 60);
  assert.equal(report.controller_plan_sequence, null);
  assert.equal(report.terminal_receipt_saved, true);
  assert.equal(report.held_slot, false);
  assert.equal(report.source_sha256, expected.sourceSha256);
  assert.deepEqual(calls, [["inspect", "owned-original"]]);
  assert.equal(existsSync(join(root, "e2b-development-active")), false);
});
test("controller receipt persistence failure cannot return success or clear pending journal", async (t) => {
  const root = temporary(t),
    first = openE2BLabJournal(root, operationId),
    saved = envelope();
  saved.record.createAttempted = true;
  saved.record.sandboxId = "owned-original";
  saved.record.phase = "paused";
  await first.persist(saved);
  first.closeController();
  const file = join(root, "key.json");
  writeFileSync(file, JSON.stringify(input()), { mode: 0o600 });
  writeFileSync(
    join(root, `e2b-development-${operationId}-terminal.json`),
    "existing-immutable-receipt",
    { mode: 0o600 },
  );
  const result = await mainE2BLab(["--cleanup", operationId, file], {
    privateRoot: root,
    evidenceDirectory: join(root, "evidence"),
    readFile: () => {
      throw Error("allocation documents unavailable");
    },
    sourceBinding: () => {
      throw Error("source unavailable");
    },
    transportFactory: async () => ({ inspect: async () => null }),
  });
  assert.equal(result, 1);
  const failedReport = JSON.parse(readFileSync(join(root, "evidence/live.json")));
  assert.equal(failedReport.terminal_receipt_saved, false);
  assert.equal(failedReport.held_slot, null);
  assert.equal(failedReport.deletion_observation, "absent");
  assert.ok(existsSync(join(root, "e2b-development-active/operation.json")));
  assert.equal(
    readFileSync(join(root, `e2b-development-${operationId}-terminal.json`), "utf8"),
    "existing-immutable-receipt",
  );
});

test("current67 runtime still needs fresh allocation authority before private input", (t) => {
  const current = currentE2BFixture();
  t.after(current.dispose);
  const accountPath = join(current.root, "infra/labs/e2b-development-account.json");
  const readonlyAccount = JSON.parse(readFileSync(accountPath, "utf8"));
  readonlyAccount.allocation_authorized = false;
  writeFileSync(accountPath, JSON.stringify(readonlyAccount));
  const out = spawnSync(
    process.execPath,
    [
      "--import",
      current.loader,
      current.script("scripts/e2b-development-lab.mjs"),
      "--run",
      "/never/read-private-input",
    ],
    { encoding: "utf8", cwd: current.root },
  );
  assert.equal(out.status, 2, out.stderr);
  const report = JSON.parse(current.read("docs/evidence/P04.T01h/live.json"));
  assert.equal(report.plan_sequence, 67);
  assert.equal(report.provider_calls, false);
  assert.equal(report.private_input_read, false);
  assert.ok(report.blockers.includes("E2B_LAB_ACCESS_UNQUALIFIED"));
});

test("runtime CLI refuses disabled TLS before an original cleanup key is loaded", async (t) => {
  const root = temporary(t),
    before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  let calls = 0;
  try {
    await assert.rejects(
      mainE2BLab(["--cleanup", operationId, "/never/read-key"], {
        privateRoot: root,
        evidenceDirectory: join(root, "evidence"),
        readFile: () => {
          throw Error("no current allocation data");
        },
        sourceBinding: () => {
          throw Error("no current source");
        },
        transportFactory: async () => {
          calls++;
          throw Error("never");
        },
      }),
      /IMPLICIT_CONFIGURATION_DENIED/,
    );
    assert.equal(calls, 0);
    assert.equal(existsSync(join(root, "e2b-development-controller.lock")), false);
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  }
});
