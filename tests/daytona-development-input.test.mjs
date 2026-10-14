import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  developmentLabSourceBinding,
  inspectDevelopmentLabAccount,
  loadDevelopmentLabInput,
  openDevelopmentLabJournal,
  parseDevelopmentLabInput,
} from "../scripts/daytona-development-input.mjs";
import { archivedDevelopmentLabBinding } from "../scripts/daytona-development-lab.mjs";
import {
  developmentLabConfiguration,
  prepareDevelopmentLabOperation,
} from "../packages/infrastructure/src/daytona-development-lab.ts";

const operationId = "a1234567-1234-4234-8234-123456789abc";
const organizationId = "8862ff17-6109-4eb1-ac70-2f7bafba64ae";
const now = Date.parse("2026-10-14T10:00:00Z");
const expected = {
  profileSha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  accountObservationSha256: "c".repeat(64),
};
const input = () => ({
  environment: "development",
  organizationId,
  operationId,
  apiKey: "synthetic-key-" + "x".repeat(32),
  ...expected,
});
const account = () => ({
  schema_version: 1,
  plan_sequence: 54,
  observed_at: new Date(now).toISOString(),
  organization_id: organizationId,
  region: "us",
  tier: 1,
  free_credit_usd: "200.00",
  paid_credit_usd: "0.00",
  automatic_top_up_disabled: true,
  trial_eligibility_confirmed: true,
  container_creation_enabled: true,
  snapshot_identity_qualified: true,
  operator_access_authorized: true,
});
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "morrow-daytona-input-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("only current owned free-credit observations qualify development inputs", () => {
  assert.deepEqual(inspectDevelopmentLabAccount(account(), now), []);
  for (const changed of [
    { organization_id: "foreign" },
    { region: "eu" },
    { tier: 2 },
    { free_credit_usd: "0.00" },
    { free_credit_usd: "NaN" },
    { paid_credit_usd: "1.00" },
    { automatic_top_up_disabled: null },
    { operator_access_authorized: false },
    { trial_eligibility_confirmed: false },
    { container_creation_enabled: false },
    { snapshot_identity_qualified: false },
    { observed_at: new Date(now - 1_800_001).toISOString() },
    { observed_at: new Date(now + 1).toISOString() },
  ])
    assert.ok(inspectDevelopmentLabAccount({ ...account(), ...changed }, now).length);
});
test("credit loss blocks allocation but cannot block owned authorized cleanup", () => {
  const depleted = {
    ...account(),
    free_credit_usd: "0.00",
    paid_credit_usd: "1.00",
    automatic_top_up_disabled: null,
    trial_eligibility_confirmed: false,
    container_creation_enabled: false,
    snapshot_identity_qualified: false,
  };
  assert.ok(inspectDevelopmentLabAccount(depleted, now, "allocate").length);
  assert.deepEqual(inspectDevelopmentLabAccount(depleted, now, "cleanup"), []);
  assert.ok(
    inspectDevelopmentLabAccount({ ...depleted, operator_access_authorized: false }, now, "cleanup")
      .length,
  );
  assert.ok(
    inspectDevelopmentLabAccount({ ...depleted, organization_id: "foreign" }, now, "cleanup")
      .length,
  );
});

test("private key input binds exact source/profile/account and denies authority expansion", () => {
  assert.equal(parseDevelopmentLabInput(input(), expected).operationId, operationId);
  for (const changed of [
    { environment: "production" },
    { organizationId: "foreign" },
    { operationId: "../escape" },
    { profileSha256: "d".repeat(64) },
    { sourceSha256: "d".repeat(64) },
    { accountObservationSha256: "d".repeat(64) },
    { apiUrl: "https://foreign.invalid" },
    { approved: true },
    { apiKey: "bad key" },
  ])
    assert.throws(
      () => parseDevelopmentLabInput({ ...input(), ...changed }, expected),
      /DEVELOPMENT_LAB_PRIVATE_INPUT_DENIED/,
    );
});
test("private input rejects unsafe filesystem modes, symlinks and outside paths", (t) => {
  const root = temporary(t),
    file = join(root, "input.json");
  writeFileSync(file, JSON.stringify(input()), { mode: 0o600 });
  assert.equal(loadDevelopmentLabInput(file, root, expected).organizationId, organizationId);
  chmodSync(file, 0o644);
  assert.throws(() => loadDevelopmentLabInput(file, root, expected));
  chmodSync(file, 0o600);
  symlinkSync(file, join(root, "link.json"));
  assert.throws(() => loadDevelopmentLabInput(join(root, "link.json"), root, expected));
  assert.throws(() => loadDevelopmentLabInput("input.json", root, expected));
  assert.throws(() => loadDevelopmentLabInput(file, join(root, "different"), expected));
});
test("controller mutex prevents two resumes and reads fresh journal after release", async (t) => {
  const root = temporary(t),
    first = openDevelopmentLabJournal(root, operationId);
  const record = {
    operation: prepareDevelopmentLabOperation(developmentLabConfiguration(), operationId, now),
    createAttempted: false,
    sandboxId: null,
    phase: "prepared",
  };
  await first.persist(record);
  assert.throws(
    () => openDevelopmentLabJournal(root, operationId, true),
    /CONTROLLER_ALREADY_ACTIVE/,
  );
  const committed = { ...record, createAttempted: true, phase: "create_requested" };
  await first.persist(committed);
  first.closeController();
  const resumed = openDevelopmentLabJournal(root, operationId, true);
  assert.equal(resumed.record.createAttempted, true);
  assert.throws(
    () => openDevelopmentLabJournal(root, "b1234567-1234-4234-8234-123456789abc", true),
    /CONTROLLER_ALREADY_ACTIVE/,
  );
  resumed.closeController();
});
test("unresolved journal blocks new operation and survives controller shutdown", async (t) => {
  const root = temporary(t),
    journal = openDevelopmentLabJournal(root, operationId);
  const record = {
    operation: prepareDevelopmentLabOperation(developmentLabConfiguration(), operationId, now),
    createAttempted: true,
    sandboxId: null,
    phase: "unresolved",
  };
  await journal.persist(record);
  journal.release({ cleanup: "unresolved", record });
  journal.closeController();
  assert.ok(existsSync(join(root, "daytona-development-active", "operation.json")));
  assert.throws(
    () => openDevelopmentLabJournal(root, "b1234567-1234-4234-8234-123456789abc"),
    /PENDING_OPERATION/,
  );
  assert.ok(!existsSync(join(root, "daytona-development-controller.lock")));
});
test("verified cleanup removes only the bound journal while holding the controller mutex", async (t) => {
  const root = temporary(t),
    journal = openDevelopmentLabJournal(root, operationId);
  const record = {
    operation: prepareDevelopmentLabOperation(developmentLabConfiguration(), operationId, now),
    createAttempted: true,
    sandboxId: "c1234567-1234-4234-8234-123456789abc",
    phase: "deleted",
  };
  await journal.persist(record);
  journal.release({ cleanup: "verified_deleted", record });
  assert.ok(!existsSync(join(root, "daytona-development-active")));
  assert.throws(() => openDevelopmentLabJournal(root, operationId), /CONTROLLER_ALREADY_ACTIVE/);
  journal.closeController();
});
test("default and malformed CLI invocations cannot read a key or instantiate provider SDK", () => {
  const script = resolve("scripts/daytona-development-lab.mjs");
  const originalPreparation = readFileSync("docs/evidence/P04.T01f/preparation.json", "utf8");
  const prepared = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const report = JSON.parse(readFileSync("docs/evidence/P04.T01f/archive.json"));
  assert.equal(report.provider_calls, false);
  assert.equal(report.private_input_read, false);
  assert.equal(report.live_ready, false);
  assert.equal(report.status, "archived_cleanup_only");
  assert.equal(report.current_plan_sequence, 64);
  assert.equal(report.plan_sequence, 54);
  assert.equal(
    readFileSync("docs/evidence/P04.T01f/preparation.json", "utf8"),
    originalPreparation,
  );
  const malformed = spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--run", "/never-read.json", "extra"],
    { encoding: "utf8" },
  );
  assert.equal(malformed.status, 2);
  assert.match(malformed.stdout, /USAGE_DENIED/);
  const blocked = spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--run", "/never-read.json"],
    { encoding: "utf8" },
  );
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /PROVIDER_ARCHIVED/);
  const cleanup = spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--resume", "/never-read.json"],
    { encoding: "utf8" },
  );
  assert.equal(cleanup.status, 2);
  assert.match(cleanup.stdout, /LIVE_PREREQUISITES_UNQUALIFIED/);
  const live = JSON.parse(readFileSync("docs/evidence/P04.T01f/cleanup.json"));
  assert.equal(live.provider_calls, false);
  assert.equal(live.status, "blocked");
});

test("archived Daytona allocation denial precedes every config/account/private read", (t) => {
  const root = temporary(t);
  const script = resolve("scripts/daytona-development-lab.mjs");
  const result = spawnSync(
    process.execPath,
    ["--import", resolve("node_modules/tsx/dist/loader.mjs"), script, "--run", "/never-read.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /^DEVELOPMENT_LAB_PROVIDER_ARCHIVED\n$/);
  assert.equal(existsSync(join(root, "docs")), false);
});

test("original54 cleanup source/profile remain explicit while current controllers and plans change", () => {
  const receipt = JSON.parse(readFileSync("docs/evidence/P04.T01f/archive-binding.json", "utf8"));
  const plan = { sources: { plan: { sequence: 55 } } };
  const binding = archivedDevelopmentLabBinding(developmentLabConfiguration(), plan, receipt);
  assert.equal(binding.originalPlanSequence, 54);
  assert.equal(binding.sourceSha256, receipt.original_source_sha256);
  assert.equal(binding.profileSha256, receipt.original_profile_sha256);
  assert.notEqual(developmentLabSourceBinding(".").sourceSha256, binding.sourceSha256);
  assert.equal(
    archivedDevelopmentLabBinding(
      developmentLabConfiguration(),
      { sources: { plan: { sequence: 56 } } },
      receipt,
    ).sourceSha256,
    binding.sourceSha256,
  );
  const cleanupExpected = {
    ...expected,
    profileSha256: binding.profileSha256,
    sourceSha256: binding.sourceSha256,
  };
  assert.equal(
    parseDevelopmentLabInput({ ...input(), ...cleanupExpected }, cleanupExpected).operationId,
    operationId,
  );
  assert.throws(
    () =>
      parseDevelopmentLabInput(
        {
          ...input(),
          ...cleanupExpected,
          sourceSha256: developmentLabSourceBinding(".").sourceSha256,
        },
        cleanupExpected,
      ),
    /PRIVATE_INPUT_DENIED/,
  );
  for (const changed of [
    { original_plan_sequence: 55 },
    { original_source_commit: "a".repeat(40) },
    { original_profile_sha256: "a".repeat(64) },
    { original_source_sha256: "a".repeat(64) },
    {
      original_source_digests: {
        ...receipt.original_source_digests,
        "package-lock.json": "a".repeat(64),
      },
    },
    { new_allocation_authorized: true },
    { production_qualified: true },
  ])
    assert.throws(
      () =>
        archivedDevelopmentLabBinding(developmentLabConfiguration(), plan, {
          ...receipt,
          ...changed,
        }),
      /ARCHIVE_BINDING_DENIED/,
    );
  assert.throws(
    () =>
      archivedDevelopmentLabBinding(
        developmentLabConfiguration(),
        { sources: { plan: { sequence: 54 } } },
        receipt,
      ),
    /ARCHIVE_BINDING_DENIED/,
  );
  assert.throws(
    () =>
      archivedDevelopmentLabBinding({ ...developmentLabConfiguration(), cpu: 2 }, plan, receipt),
    /ARCHIVE_BINDING_DENIED/,
  );
});
