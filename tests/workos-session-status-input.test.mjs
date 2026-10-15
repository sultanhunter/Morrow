import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  claimWorkosSessionStatusRun,
  consumeWorkosSessionStatusPermit,
  inspectWorkosSessionStatusRun,
  loadWorkosSessionStatusScope,
  prepareWorkosSessionStatusActivation,
  workosSessionStatusSourcePaths,
} from "../scripts/workos-session-status-input.mjs";
import { runWorkosSessionStatusCommand } from "../scripts/workos-session-status-operator.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const subjectId = "user_" + "A".repeat(26),
  providerSessionId = "session_" + "B".repeat(26);
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-session-status-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(path, value) {
  writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
function fixture(t, { credential = true } = {}) {
  const root = join(temporary(t), "observation");
  const prepared = prepareWorkosSessionStatusActivation(root),
    scope = JSON.parse(loadWorkosSessionStatusScope());
  const a = JSON.parse(readFileSync(join(root, "activation.json")));
  Object.assign(a, {
    ownerApproved: true,
    environmentKeyApproved: true,
    baselineApproved: true,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  put(join(root, "activation.json"), a);
  const p = JSON.parse(scope.profileJson),
    key = "synthetic-test-credential-canary\n";
  const b = {
    schemaVersion: 1,
    sourceDigest: scope.sourceDigest,
    environmentId: p.environment_id,
    applicationId: p.application_id,
    clientId: p.client_id,
    subjectId,
    providerSessionId,
    observedAt: new Date(Date.now() - 1000).toISOString(),
    controlledOwned: true,
    sessionStatus: "Revoked",
  };
  put(join(root, "baseline.json"), b);
  const r = {
    schemaVersion: 1,
    approvalQuestionId: "synthetic_question",
    approvedAt: new Date(Date.now() - 500).toISOString(),
    operationId: a.operationId,
    activationId: a.activationId,
    sourceDigest: scope.sourceDigest,
    planDigest: scope.planDigest,
    profileDigest: scope.profileDigest,
    activationSha256: sha(readFileSync(join(root, "activation.json"))),
    baselineSha256: sha(readFileSync(join(root, "baseline.json"))),
    credentialSha256: sha(key),
    subjectId,
    providerSessionId,
    environmentId: p.environment_id,
    applicationId: p.application_id,
    clientId: p.client_id,
    maxObservations: 1,
    maxGets: 4,
    credentialCapability: "broad_environment",
    existingEnvironmentKeyApproved: true,
    readOnlyGetApproved: true,
    baselineOwned: true,
  };
  put(join(root, "receipt.json"), r);
  if (credential) writeFileSync(join(root, "credential.txt"), key, { mode: 0o600 });
  return { root, a, b, r, key, scope, prepared };
}
test("public scope pins exact75 profile and all execution sources without a credential", () => {
  const s = JSON.parse(loadWorkosSessionStatusScope());
  assert.equal(s.planSequence, 75);
  assert.match(s.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(s.profileDigest, sha(s.profileJson));
  assert.equal(JSON.parse(s.profileJson).credential_capability, "broad_environment");
  assert.equal(JSON.parse(s.observerProfileJson).clientId, JSON.parse(s.profileJson).client_id);
});
test("prepare is false and observe holds before any missing receipt/baseline/key or claim", async (t) => {
  const root = join(temporary(t), "fresh");
  const result = prepareWorkosSessionStatusActivation(root);
  assert.equal(result.status, "prepared_unapproved");
  assert.equal(result.credentialReads, 0);
  assert.equal(result.providerRequests, 0);
  assert.match(result.sourceDigest, /^[a-f0-9]{64}$/);
  const a = JSON.parse(readFileSync(join(root, "activation.json")));
  for (const k of ["ownerApproved", "environmentKeyApproved", "baselineApproved"])
    assert.equal(a[k], false);
  assert.equal(claimWorkosSessionStatusRun(root), null);
  assert.equal(
    (await runWorkosSessionStatusCommand("observe", root)).reason,
    "owner_key_approval_required",
  );
  assert.equal(existsSync(join(root, "claim.json")), false);
  assert.throws(() => prepareWorkosSessionStatusActivation(root), /UNAVAILABLE/);
});
test("one durable claim precedes the first credential read and cannot replay", (t) => {
  const f = fixture(t, { credential: false });
  const permit = claimWorkosSessionStatusRun(f.root);
  assert.ok(permit);
  assert.equal(Object.keys(permit).length, 0);
  assert.equal(existsSync(join(f.root, "claim.json")), true);
  assert.throws(() => claimWorkosSessionStatusRun(f.root), /UNAVAILABLE/);
  const context = consumeWorkosSessionStatusPermit(permit);
  assert.equal(context.current(), true);
  assert.throws(() => context.credential(), /^Error: WORKOS_SESSION_STATUS_INPUT_UNAVAILABLE$/);
  assert.throws(() => consumeWorkosSessionStatusPermit(permit), /UNAVAILABLE/);
  context.close();
});
test("bound fake credential stays private and terminal record is coarse", (t) => {
  const f = fixture(t);
  const c = consumeWorkosSessionStatusPermit(claimWorkosSessionStatusRun(f.root));
  assert.equal(c.credential(), f.key.slice(0, -1));
  c.observe("not_observed_active");
  const raw = readFileSync(join(f.root, "observation.json"), "utf8");
  for (const value of [f.key.trim(), subjectId, providerSessionId])
    assert.equal(raw.includes(value), false);
  assert.equal(JSON.parse(raw).clientBinding, "expected_only");
  c.close();
  assert.throws(() => c.credential(), /UNAVAILABLE/);
  assert.equal(inspectWorkosSessionStatusRun(f.root).retriesAllowed, false);
});
test("every approval/identity/hash/budget mismatch denies before claim or credential", (t) => {
  for (const patch of [
    { readOnlyGetApproved: false },
    { existingEnvironmentKeyApproved: false },
    { baselineOwned: false },
    { maxGets: 5 },
    { maxObservations: 2 },
    { credentialCapability: "read_only_claim" },
    { subjectId: "user_" + "C".repeat(26) },
    { providerSessionId: "session_" + "C".repeat(26) },
    { activationSha256: "0".repeat(64) },
    { baselineSha256: "0".repeat(64) },
    { sourceDigest: "0".repeat(64) },
  ]) {
    const f = fixture(t, { credential: false });
    put(join(f.root, "receipt.json"), { ...f.r, ...patch });
    assert.throws(() => claimWorkosSessionStatusRun(f.root), /UNAVAILABLE/);
    assert.equal(existsSync(join(f.root, "claim.json")), false);
  }
});
test("expired activation or non-owned/nonrevoked baseline cannot claim", (t) => {
  const f = fixture(t, { credential: false });
  put(join(f.root, "activation.json"), {
    ...f.a,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.throws(() => claimWorkosSessionStatusRun(f.root), /UNAVAILABLE/);
  const g = fixture(t, { credential: false });
  put(join(g.root, "baseline.json"), { ...g.b, controlledOwned: false });
  assert.throws(() => claimWorkosSessionStatusRun(g.root), /UNAVAILABLE/);
});
test("postclaim activation/receipt/baseline/claim drift permanently prevents credential use", (t) => {
  for (const name of ["activation.json", "receipt.json", "baseline.json", "claim.json"]) {
    const f = fixture(t);
    const c = consumeWorkosSessionStatusPermit(claimWorkosSessionStatusRun(f.root));
    const file = join(f.root, name);
    writeFileSync(file, readFileSync(file, "utf8") + " ");
    assert.throws(() => c.credential(), /UNAVAILABLE/);
    c.close();
  }
});
test("credential hash, permissions, symlink and hardlink failures hold after claim", (t) => {
  for (const mode of ["content", "permissions", "symlink", "hardlink"]) {
    const f = fixture(t),
      c = consumeWorkosSessionStatusPermit(claimWorkosSessionStatusRun(f.root)),
      file = join(f.root, "credential.txt");
    if (mode === "content") writeFileSync(file, "synthetic-wrong-value");
    if (mode === "permissions") chmodSync(file, 0o644);
    if (mode === "hardlink") linkSync(file, join(f.root, "alias"));
    if (mode === "symlink") {
      rmSync(file);
      symlinkSync(join(f.root, "receipt.json"), file);
    }
    assert.throws(() => c.credential(), /UNAVAILABLE/);
    c.close();
  }
});
test("root permissions and symlink replacement cannot be used by a claimed permit", (t) => {
  const f = fixture(t),
    c = consumeWorkosSessionStatusPermit(claimWorkosSessionStatusRun(f.root));
  chmodSync(f.root, 0o755);
  assert.throws(() => c.current(), /UNAVAILABLE/);
  c.close();
  const parent = temporary(t),
    link = join(parent, "alias");
  symlinkSync(f.root, link, "dir");
  assert.throws(() => prepareWorkosSessionStatusActivation(link), /UNAVAILABLE/);
});
test("prepare rejects a symlinked or shared parent before creating any foreign directory", (t) => {
  const parent = temporary(t),
    target = join(parent, "target");
  mkdirSync(target, { mode: 0o700 });
  const alias = join(parent, "alias");
  symlinkSync(target, alias, "dir");
  assert.throws(() => prepareWorkosSessionStatusActivation(join(alias, "foreign")), /UNAVAILABLE/);
  assert.equal(existsSync(join(target, "foreign")), false);
  chmodSync(target, 0o755);
  assert.throws(() => prepareWorkosSessionStatusActivation(join(target, "shared")), /UNAVAILABLE/);
  assert.equal(existsSync(join(target, "shared")), false);
});
test("public scope rejects plan/source/profile drift and aliased execution bytes", (t) => {
  const root = temporary(t);
  for (const name of [
    ...workosSessionStatusSourcePaths,
    "docs/plan/source.json",
    "docs/plan/build-plan.md",
  ]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    copyFileSync(join(source, name), join(root, name));
  }
  assert.equal(JSON.parse(loadWorkosSessionStatusScope(root)).planSequence, 75);
  const m = JSON.parse(readFileSync(join(root, "docs/plan/source.json")));
  m.sources.plan.sequence = 74;
  put(join(root, "docs/plan/source.json"), m);
  assert.throws(() => loadWorkosSessionStatusScope(root), /UNAVAILABLE/);
  copyFileSync(join(source, "docs/plan/source.json"), join(root, "docs/plan/source.json"));
  const file = join(root, "scripts/workos-session-status-operator.mjs");
  rmSync(file);
  symlinkSync(join(source, "scripts/workos-session-status-operator.mjs"), file);
  assert.throws(() => loadWorkosSessionStatusScope(root), /UNAVAILABLE/);
});
test("primitive gates reject hostile objects before coercion or private creation", (t) => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  assert.throws(() => prepareWorkosSessionStatusActivation(proxy), /UNAVAILABLE/);
  assert.throws(
    () => prepareWorkosSessionStatusActivation(join(temporary(t), "unused"), proxy),
    /UNAVAILABLE/,
  );
  assert.throws(() => consumeWorkosSessionStatusPermit(proxy), /UNAVAILABLE/);
  assert.equal(traps, 0);
});
