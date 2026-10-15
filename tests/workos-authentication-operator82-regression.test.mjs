import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
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
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createFrozenWorkosAuthentication82Fixture,
  createFrozenWorkosAuthenticationFixture,
  frozenWorkosAuthenticationOperator82,
  verifyFrozenWorkosAuthentication82Archive,
  verifyFrozenWorkosAuthentication82Report,
  verifyFrozenWorkosAuthenticationTests,
  verifyFrozenWorkosAuthenticationWorkspace,
  workosAuthenticationRegressionFailure,
} from "../scripts/workos-authentication-operator-regression.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = join(source, "docs/history/workos-authentication-operator-82");
const labReport = "docs/evidence/P05.T01n/postgresql-loopback-lab.json";
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-auth82-regression-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t) {
  const value = await createFrozenWorkosAuthentication82Fixture();
  t.after(value.dispose);
  return value;
}

test("fixed82 archive binds45 published586 payloads and the exact37 source closure", () => {
  const manifest = verifyFrozenWorkosAuthentication82Archive();
  assert.equal(manifest.plan_sequence, 82);
  assert.equal(manifest.commit, "586136d44110a7c5eddc086f2ee50e13fd4fa5f2");
  assert.equal(manifest.reviewed_runtime_commit, "2d4218f345c6e2dbafed0cb1267034236212accc");
  assert.equal(manifest.operator_source_digest, frozenWorkosAuthenticationOperator82.sourceDigest);
  assert.equal(manifest.files.length, 45);
  for (const [role, count] of [
    ["runtime_closure", 37],
    ["operator_test", 6],
    ["test_fixture", 1],
    ["baseline_lab_report", 1],
  ])
    assert.equal(manifest.files.filter((x) => x.role === role).length, count);
  assert.equal(
    manifest.files.some((x) => x.path.includes("actual-staging-trial")),
    false,
  );
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(archive, "archive.json")))
      .digest("hex"),
    "881e0c374ba01cba2afd0c677f5a7f4a4beca250cc38a4b1cd232d05c5905d64",
  );
});

test("fixed82 copy retains its own scope, original72 names and181 report under current83", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.root, archive);
  assert.ok(f.current.sequence >= 83);
  assert.equal(f.verify().planSequence, 82);
  assert.equal(f.verify().sourceDigest, frozenWorkosAuthenticationOperator82.sourceDigest);
  assert.equal(f.expected.length, 72);
  assert.equal(new Set(f.expected.map((x) => x.name)).size, 72);
  assert.equal(verifyFrozenWorkosAuthenticationWorkspace(f.root, f.tooling.loader), true);
  assert.equal(verifyFrozenWorkosAuthentication82Report(f.root).checks.length, 181);
});

test("fixed descriptors reject80/82 substitution and require a newer complete current plan", async (t) => {
  await assert.rejects(
    createFrozenWorkosAuthentication82Fixture({
      archive: join(source, "docs/history/workos-authentication-operator-80"),
    }),
    /PREFLIGHT_FAILED/,
  );
  await assert.rejects(createFrozenWorkosAuthenticationFixture({ archive }), /PREFLIGHT_FAILED/);
  const root = temporary(t);
  for (const file of [
    ".nvmrc",
    "package-lock.json",
    "docs/plan/source.json",
    "docs/plan/build-plan.md",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(source, file), join(root, file));
  }
  const planFile = join(root, "docs/plan/source.json"),
    plan = JSON.parse(readFileSync(planFile));
  plan.sources.plan.sequence = 82;
  writeFileSync(planFile, JSON.stringify(plan));
  await assert.rejects(
    createFrozenWorkosAuthentication82Fixture({ source: root, archive }),
    /PREFLIGHT_FAILED/,
  );
});

test("fixed82 rejects changed provenance, source bytes, symlink roots and hardlinks", async (t) => {
  for (const file of ["archive.json", "scripts/workos-authentication-operator-input.mjs"]) {
    const root = join(temporary(t), "archive");
    cpSync(archive, root, { recursive: true });
    writeFileSync(join(root, file), "changed");
    assert.throws(() => verifyFrozenWorkosAuthentication82Archive(root), /ARCHIVE_INVALID/);
  }
  const alias = join(temporary(t), "alias");
  symlinkSync(archive, alias, "dir");
  assert.throws(() => verifyFrozenWorkosAuthentication82Archive(alias), /ARCHIVE_INVALID/);
  const linked = join(temporary(t), "archive");
  cpSync(archive, linked, { recursive: true });
  linkSync(join(linked, ".nvmrc"), join(linked, "duplicate-node"));
  assert.throws(() => verifyFrozenWorkosAuthentication82Archive(linked), /ARCHIVE_INVALID/);
  const f = await fixture(t);
  writeFileSync(join(f.root, "scripts/workos-authentication-operator-native.mjs"), "changed");
  assert.throws(f.verify, /COPY_INVALID/);
});

test("fixed82 original181 report rejects missing checks, changed policy, cleanup and source hashes", async (t) => {
  const f = await fixture(t),
    reportPath = join(f.root, labReport),
    original = readFileSync(reportPath, "utf8");
  for (const change of [
    (r) => r.checks.pop(),
    (r) => {
      r.checks[0] = r.checks[1];
    },
    (r) => {
      r.canonicalSequence = 83;
    },
    (r) => {
      r.counts.realProviderRequests = 1;
    },
    (r) => {
      r.cleanup.backendNamespace = "unverified";
    },
    (r) => {
      r.cleanupFaults[0].hostChildClosure = "observed";
    },
    (r) => {
      r.outcomes[0].outcome = "held";
    },
    (r) => {
      delete r.sourceDigests[Object.keys(r.sourceDigests)[0]];
    },
  ]) {
    const value = JSON.parse(original);
    change(value);
    writeFileSync(reportPath, JSON.stringify(value));
    assert.throws(() => verifyFrozenWorkosAuthentication82Report(f.root), /LAB_RESULT_INVALID/);
  }
  writeFileSync(reportPath, original);
  assert.equal(verifyFrozenWorkosAuthentication82Report(f.root).checks.length, 181);
});

test("fixed82 expected unit names cannot be substituted, skipped or treated as an empty suite", async (t) => {
  const f = await fixture(t);
  const valid = () => ({
    results: f.expected.map((item) => ({
      ...item,
      passed: true,
      skipped: false,
      todo: false,
      nesting: 0,
    })),
    summaries: [
      {
        success: true,
        counts: {
          tests: 72,
          passed: 72,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
          suites: 0,
          topLevel: 72,
        },
      },
    ],
  });
  assert.equal(verifyFrozenWorkosAuthenticationTests(valid(), f.expected), true);
  for (const change of [
    (r) => {
      r.results[0].name = "different policy";
    },
    (r) => {
      r.results[0].skipped = true;
    },
    (r) => {
      r.summaries[0].counts.tests = 0;
    },
  ]) {
    const result = valid();
    change(result);
    assert.throws(
      () => verifyFrozenWorkosAuthenticationTests(result, f.expected),
      /TEST_RESULT_INVALID/,
    );
  }
});

test("copied82 false native proposal remains inert and rejects stale80/81/future83 scopes", async (t) => {
  const f = await fixture(t),
    manifest = verifyFrozenWorkosAuthentication82Archive();
  async function copy() {
    const root = join(temporary(t), "synthetic-source");
    for (const { path, role } of manifest.files) {
      if (role !== "runtime_closure") continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(f.root, path), join(root, path));
    }
    return {
      root,
      input: await import(
        pathToFileURL(join(root, "scripts/workos-authentication-operator-input.mjs")).href
      ),
    };
  }
  {
    const c = await copy(),
      parent = temporary(t),
      root = join(parent, "proposal"),
      bindingPath = join(parent, "binding.json"),
      bindingJson =
        JSON.stringify({
          schemaVersion: 1,
          providerId: "workos",
          environmentId: "environment_" + "A".repeat(26),
          applicationId: "app_" + "B".repeat(26),
          clientId: "client_" + "C".repeat(26),
          approvedSubjectId: "user_" + "D".repeat(26),
        }) + "\n";
    writeFileSync(bindingPath, bindingJson, { mode: 0o600 });
    const file = join(c.root, "docs/decisions/workos-authentication-operator-qualification.json"),
      profile = JSON.parse(readFileSync(file));
    profile.protectedBindingDigest = createHash("sha256").update(bindingJson).digest("hex");
    writeFileSync(file, JSON.stringify(profile));
    assert.equal(JSON.parse(c.input.loadWorkosAuthenticationOperatorScope()).planSequence, 82);
    const result = c.input.prepareWorkosAuthenticationOperatorActivation(root, bindingPath);
    assert.equal(result.outcome, "prepared");
    assert.equal(result.providerRequests, 0);
    assert.equal(result.credentialReads, 0);
    const activation = JSON.parse(readFileSync(join(root, "activation.json")));
    assert.equal(activation.planSequence, 82);
    for (const flag of ["ownerApproved", "callbackRegistered", "baselineApproved", "keyApproved"])
      assert.equal(activation[flag], false);
    assert.equal(c.input.claimWorkosAuthenticationOperatorRun(root), null);
    for (const file of [
      "controller_lock.json",
      "claim.json",
      "credential.txt",
      "initiation_started.json",
    ])
      assert.equal(existsSync(join(root, file)), false);
  }
  for (const sequence of [80, 81, 83]) {
    const c = await copy(),
      file = join(c.root, "docs/plan/source.json"),
      plan = JSON.parse(readFileSync(file)),
      root = join(temporary(t), "uncreated-proposal");
    plan.sources.plan.sequence = sequence;
    writeFileSync(file, JSON.stringify(plan));
    assert.throws(() => c.input.loadWorkosAuthenticationOperatorScope());
    assert.deepEqual(
      c.input.prepareWorkosAuthenticationOperatorActivation(
        root,
        join(root, "missing-binding.json"),
      ),
      { outcome: "held", reason: "preparation_denied", credentialReads: 0, providerRequests: 0 },
    );
    assert.equal(existsSync(root), false);
  }
  // Qualification still uses the untouched, separately verified source copy.
  assert.equal(f.verify().sourceDigest, frozenWorkosAuthenticationOperator82.sourceDigest);
});

test("fixed82 entry rejects caller modes and private arguments without raw diagnostics", () => {
  const marker = "synthetic-private-not-reflected";
  const result = spawnSync(
    process.execPath,
    ["scripts/workos-authentication-operator82-regression.mjs", marker],
    { cwd: source, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { outcome: "held", code: "INPUT_DENIED" });
  assert.equal(result.stderr.includes(marker), false);
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  assert.equal(workosAuthenticationRegressionFailure(hostile), "FAILED");
  assert.equal(traps, 0);
});
