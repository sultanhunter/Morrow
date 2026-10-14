import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareE2BOwnedBuildOperation } from "../packages/runtime-adapters/src/e2b/owned-build.ts";
import {
  loadOwnedBuildAuthorization,
  openOwnedBuildJournal,
  ownedBuildSha,
  ownedBuildSources,
} from "../scripts/e2b-owned-build-input.mjs";
import {
  inspectOwnedBuildPrerequisites,
  ownedBuildRecipe,
  ownedManifestProofValid,
  ownedBuildPriceSourceValid,
} from "../scripts/e2b-owned-build-lab.mjs";

import { frozenE2B60Fixture, currentE2BFixture } from "./fixtures/frozen-e2b-60.mjs";

const profile = JSON.parse(readFileSync("infra/labs/e2b-owned-build.json", "utf8"));
const operationId = "00000000-0000-4000-8000-000000000015",
  otherId = "00000000-0000-4000-8000-000000000016";
const buildId = "00000000-0000-4000-8000-000000000017";
const sourceDigests = Object.fromEntries(ownedBuildSources.map((p) => [p, "f".repeat(64)]));
const sourceSha256 = ownedBuildSha(JSON.stringify(sourceDigests));
const initial = () =>
  prepareE2BOwnedBuildOperation(
    ownedBuildRecipe(profile).recipe,
    operationId,
    1792000000000,
    sourceSha256,
    "a".repeat(64),
    "b".repeat(64),
  );
const envelope = (record) => ({ schemaVersion: 1, sourceDigests, record });
const ready = (record) => ({
  ...record,
  registrationAttempted: true,
  startAttempted: true,
  registrationVerified: true,
  templateId: "owned-template",
  buildId,
  phase: "ready_retained",
});
const result = (record) => ({
  status: "ready_retained",
  record,
  observation: {
    status: "ready",
    projectId: profile.projectId,
    name: record.operation.name,
    private: true,
    cpu: 2,
    memoryMiB: 512,
    diskMiB: 1024,
    envdVersion: "0.2.0",
    createdAtMs: record.operation.startedAtMs,
    finishedAtMs: record.operation.startedAtMs + 1,
    templateId: record.templateId,
    buildId: record.buildId,
  },
});
function fixture(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-owned-build-")));
  chmodSync(root, 0o700);
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("owned build default prepares offline and never reads private input", (t) => {
  const frozen = frozenE2B60Fixture();
  t.after(frozen.dispose);
  const child = spawnSync(
    process.execPath,
    ["--import", frozen.loader, frozen.script("scripts/e2b-owned-build-lab.mjs")],
    { encoding: "utf8", cwd: frozen.root },
  );
  assert.equal(child.status, 0);
  assert.match(child.stdout, /E2B_OWNED_BUILD_PREPARED/);
  const report = JSON.parse(frozen.read("docs/evidence/P04.T01h/owned-build-preparation.json"));
  assert.equal(report.provider_calls, false);
  assert.equal(report.private_input_read, false);
  assert.equal(report.build_registered, false);
});
test("unqualified builder quote denies --build before an invalid private path is read", (t) => {
  const frozen = frozenE2B60Fixture();
  t.after(frozen.dispose);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      frozen.loader,
      frozen.script("scripts/e2b-owned-build-lab.mjs"),
      "--build",
      "/private/does-not-exist",
    ],
    { encoding: "utf8", cwd: frozen.root },
  );
  assert.equal(child.status, 2);
  assert.match(child.stdout, /E2B_OWNED_BUILD_PREREQUISITES_DENIED/);
  const report = JSON.parse(frozen.read("docs/evidence/P04.T01h/owned-build-blocked.json"));
  assert.equal(report.private_input_read, false);
  assert.equal(report.provider_calls, false);
});
test("current plan denies frozen60 build effects before private input", (t) => {
  const frozen = frozenE2B60Fixture();
  t.after(frozen.dispose);
  frozen.useCurrentPlan();
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      frozen.loader,
      frozen.script("scripts/e2b-owned-build-lab.mjs"),
      "--build",
      "/private/does-not-exist",
    ],
    { encoding: "utf8", cwd: frozen.root },
  );
  assert.equal(child.status, 2);
  assert.match(child.stdout, /E2B_OWNED_BUILD_CONTROLLER_DENIED/);
  assert.equal(
    existsSync(join(frozen.root, "docs/evidence/P04.T01h/owned-build-qualification.json")),
    false,
  );
});
test("recipe does not infer a provider default or permit arbitrary image/resources", () => {
  assert.equal(ownedBuildRecipe(profile).recipe.memoryMiB, 512);
  for (const changed of [
    { image: "base:latest" },
    { cpu: 8 },
    { memoryMiB: 1024 },
    { minFreeDiskMiB: 1 },
    { merchantRouting: true },
    { planSequence: 59 },
  ])
    assert.throws(() => ownedBuildRecipe({ ...profile, ...changed }));
});
test("read-only account/key observations cannot qualify builder write access or quote", () => {
  const blockers = inspectOwnedBuildPrerequisites(
    { ...profile, buildQuote: null, buildAuthorization: null },
    {},
    null,
    { sourceSha256 },
  );
  assert.ok(blockers.includes("E2B_OWNED_BUILD_WRITE_RECEIPT_UNQUALIFIED"));
  assert.ok(blockers.includes("E2B_OWNED_BUILD_QUOTE_UNQUALIFIED"));
  assert.ok(blockers.includes("E2B_OWNED_BUILD_MANIFEST_UNQUALIFIED"));
});
test("protected build authorization refuses directory, symlink, hardlink and loose file", () =>
  fixture((root) => {
    const file = join(root, "approval.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    assert.deepEqual(loadOwnedBuildAuthorization(file, root), {});
    assert.throws(() => loadOwnedBuildAuthorization(root, root));
    symlinkSync(file, join(root, "link.json"));
    assert.throws(() => loadOwnedBuildAuthorization(join(root, "link.json"), root));
    linkSync(file, join(root, "hard.json"));
    assert.throws(() => loadOwnedBuildAuthorization(file, root));
    rmSync(join(root, "hard.json"));
    chmodSync(file, 0o644);
    assert.throws(() => loadOwnedBuildAuthorization(file, root));
  }));
test("protected build authorization denies outside-root and nonprivate parent", () =>
  fixture((root) => {
    const sub = join(root, "sub");
    mkdirSync(sub, { mode: 0o700 });
    const file = join(sub, "approval.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    assert.throws(() => loadOwnedBuildAuthorization(file, root));
    chmodSync(root, 0o755);
    assert.throws(() => loadOwnedBuildAuthorization(file, root));
  }));
test("build mutex serializes controllers before journal access", () =>
  fixture((root) => {
    const j = openOwnedBuildJournal(root, operationId);
    assert.throws(() => openOwnedBuildJournal(root, otherId), /CONTROLLER_ALREADY_ACTIVE/);
    j.closeController();
    assert.equal(existsSync(join(root, "e2b-owned-build-controller.lock")), false);
  }));
test("an unresolved registration occupies the slot and cannot be replaced by another UUID", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    await j.persist(envelope({ ...initial(), registrationAttempted: true, phase: "registering" }));
    j.closeController();
    assert.throws(() => openOwnedBuildJournal(root, otherId), /PENDING_OPERATION/);
    const resumed = openOwnedBuildJournal(root, operationId, true);
    assert.equal(resumed.envelope.record.registrationAttempted, true);
    resumed.closeController();
  }));
test("reconciliation refuses wrong original UUID and absent operation", () =>
  fixture(async (root) => {
    assert.throws(() => openOwnedBuildJournal(root, operationId, true), /NO_PENDING_OPERATION/);
    const j = openOwnedBuildJournal(root, operationId);
    await j.persist(envelope(initial()));
    j.closeController();
    assert.throws(() => openOwnedBuildJournal(root, otherId, true));
  }));
test("durable attempted flags cannot regress or rebind original source/recipe", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    await j.persist(envelope({ ...initial(), registrationAttempted: true, phase: "registering" }));
    await assert.rejects(j.persist(envelope(initial())));
    await assert.rejects(
      j.persist(
        envelope({
          ...initial(),
          operation: { ...initial().operation, sourceSha256: "c".repeat(64) },
        }),
      ),
    );
    await assert.rejects(j.persist({ ...envelope(initial()), apiKey: "must-not-be-journalled" }));
    j.closeController();
  }));
test("unknown start/error/catalogue absence cannot release builder slot", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const record = { ...ready(initial()), phase: "held" };
    await j.persist(envelope(record));
    for (const status of ["error", "absent", "building"])
      assert.equal(
        j.retainTerminal({
          status: "held",
          record,
          observation: { status },
          catalogueDeleted: true,
        }),
        false,
      );
    assert.equal(existsSync(join(root, "e2b-owned-build-active", "operation.json")), true);
    j.closeController();
  }));
test("ready receipt is synchronized before slot release and UUID cannot build again", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const record = ready(initial());
    await j.persist(envelope(record));
    assert.equal(j.retainTerminal(result(record)), true);
    const receipt = JSON.parse(
      readFileSync(join(root, `e2b-owned-build-${operationId}-terminal.json`), "utf8"),
    );
    assert.equal(receipt.outcome, "ready_retained");
    assert.equal(receipt.catalogueDeleted, false);
    j.closeController();
    assert.throws(() => openOwnedBuildJournal(root, operationId), /ALREADY_TERMINAL/);
  }));
test("foreign or incomplete ready proof cannot release slot", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const record = ready(initial());
    await j.persist(envelope(record));
    const wrong = result(record);
    wrong.observation.buildId = otherId;
    assert.equal(j.retainTerminal(wrong), false);
    const missing = result(record);
    missing.observation.finishedAtMs = null;
    assert.equal(j.retainTerminal(missing), false);
    j.closeController();
  }));
test("receipt collision preserves original slot and reports failure", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const record = ready(initial());
    await j.persist(envelope(record));
    writeFileSync(join(root, `e2b-owned-build-${operationId}-terminal.json`), "existing", {
      mode: 0o600,
    });
    assert.throws(() => j.retainTerminal(result(record)));
    assert.equal(existsSync(join(root, "e2b-owned-build-active", "operation.json")), true);
    j.closeController();
  }));
test("replaced controller lock is never removed by the old process", () =>
  fixture((root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const path = join(root, "e2b-owned-build-controller.lock");
    rmSync(path);
    writeFileSync(path, "foreign", { mode: 0o600 });
    assert.throws(() => j.closeController());
    assert.equal(readFileSync(path, "utf8"), "foreign");
  }));

test("a durable zero-attempt operation can release with a no-effect receipt", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const record = { ...initial(), phase: "held" };
    await j.persist(envelope(record));
    assert.equal(j.releaseNoEffect(record), true);
    const receipt = JSON.parse(
      readFileSync(join(root, `e2b-owned-build-${operationId}-terminal.json`), "utf8"),
    );
    assert.equal(receipt.outcome, "no_effect");
    assert.equal(existsSync(join(root, "e2b-owned-build-active")), false);
    j.closeController();
  }));
test("an attempted registration cannot release as no effect", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const record = { ...initial(), phase: "held", registrationAttempted: true };
    await j.persist(envelope(record));
    assert.equal(j.releaseNoEffect(record), false);
    assert.equal(existsSync(join(root, "e2b-owned-build-active", "operation.json")), true);
    j.closeController();
  }));
test("same-ID ready proof still denies disk/version/time drift", () =>
  fixture(async (root) => {
    const j = openOwnedBuildJournal(root, operationId);
    const record = ready(initial());
    await j.persist(envelope(record));
    for (const change of [
      { diskMiB: 20000 },
      { envdVersion: "0.1.0" },
      { createdAtMs: record.operation.startedAtMs - 1 },
    ]) {
      const r = result(record);
      Object.assign(r.observation, change);
      assert.equal(j.retainTerminal(r), false);
    }
    j.closeController();
  }));
test("manifest flags alone do not qualify a public proof", () => {
  assert.equal(Boolean(ownedManifestProofValid({}, sourceSha256)), false);
  assert.equal(
    Boolean(ownedManifestProofValid({ sourceSha256, providerCompute: false }, sourceSha256)),
    false,
  );
});

test("current67 builder retains unqualified write permission before private input", (t) => {
  const current = currentE2BFixture();
  t.after(current.dispose);
  const profilePath = join(current.root, "infra/labs/e2b-owned-build.json");
  const readonlyProfile = JSON.parse(readFileSync(profilePath, "utf8"));
  readonlyProfile.buildAuthorization = null;
  writeFileSync(profilePath, JSON.stringify(readonlyProfile));
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      current.loader,
      current.script("scripts/e2b-owned-build-lab.mjs"),
      "--build",
      "/never/read-private-receipt",
    ],
    { encoding: "utf8", cwd: current.root },
  );
  assert.equal(child.status, 2, child.stderr);
  const report = JSON.parse(current.read("docs/evidence/P04.T01h/owned-build-blocked.json"));
  assert.equal(report.plan_sequence, 67);
  assert.equal(report.provider_calls, false);
  assert.equal(report.private_input_read, false);
  assert.ok(report.blockers.includes("E2B_OWNED_BUILD_WRITE_RECEIPT_UNQUALIFIED"));
});

test("dated builder pricing proof rejects modified bytes, stale/future and overlong windows", () => {
  const now = 1792000000000,
    bytes = Buffer.from('{"scope":"operator"}');
  const quote = {
    priceSourceRef: "docs/evidence/P04.T01h/e2b-support-pricing-65.json",
    priceSourceSha256: ownedBuildSha(bytes),
    verifiedAtMs: now,
    expiresAtMs: now + 86400000,
  };
  let reads = 0;
  const read = () => {
    reads++;
    return bytes;
  };
  assert.equal(ownedBuildPriceSourceValid(quote, now, read), true);
  assert.equal(reads, 1);
  for (const drift of [
    { verifiedAtMs: now + 1 },
    { expiresAtMs: now },
    { verifiedAtMs: now - 86400001 },
    { expiresAtMs: now + 86400001 },
    { priceSourceSha256: "f".repeat(64) },
    { priceSourceRef: "/private/never-read" },
  ])
    assert.equal(ownedBuildPriceSourceValid({ ...quote, ...drift }, now, read), false);
  assert.equal(
    ownedBuildPriceSourceValid(quote, now, () => Buffer.from("changed")),
    false,
  );
  assert.equal(
    ownedBuildPriceSourceValid(quote, now, () => {
      throw Error("missing");
    }),
    false,
  );
});
