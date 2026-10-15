import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  loadPublicWorkosOperatorScope,
  isWorkosOperatorSourceDirectory,
  prepareWorkosOperatorActivation,
  readWorkosOperatorActivation,
  requirePrivateWorkosOperatorRoot,
  workosOperatorSourcePaths,
} from "../scripts/workos-operator-input.mjs";
import { runWorkosOperatorCommand } from "../scripts/workos-operator.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-workos-input-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of workosOperatorSourcePaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "fixture:" + path);
  }
  const profilePath = "docs/decisions/workos-operator-qualification.json";
  writeFileSync(
    join(root, profilePath),
    readFileSync(new URL("../" + profilePath, import.meta.url)),
  );
  mkdirSync(join(root, "docs/plan"), { recursive: true });
  const plan = "Controlled operator fixture; no provider effect.\n";
  writeFileSync(join(root, "docs/plan/build-plan.md"), plan);
  writeFileSync(
    join(root, "docs/plan/source.json"),
    JSON.stringify({
      captured_at: "2026-10-15T00:00:00.000Z",
      sources: {
        plan: {
          page_id: "page_b1ef27b80b788191b91e67cbb52f1037",
          sequence: 71,
          sha256: createHash("sha256").update(plan).digest("hex"),
        },
      },
    }),
  );
  return root;
}
function privateParent(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-workos-private-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("scope pins exact owned profile, code closure and validated canonical plan", (t) => {
  const root = fixture(t),
    first = loadPublicWorkosOperatorScope(root);
  const parsed = JSON.parse(first);
  assert.equal(parsed.planSequence, 71);
  assert.equal(
    JSON.parse(parsed.bindingJson).redirectUri,
    "http://127.0.0.1:4110/operator/workos/callback",
  );
  writeFileSync(join(root, "scripts/workos-operator.mjs"), "changed controlled source");
  const changed = JSON.parse(loadPublicWorkosOperatorScope(root));
  assert.notEqual(changed.sourceDigest, parsed.sourceDigest);
  assert.equal(changed.planDigest, parsed.planDigest);
});
test("same canonical read capture time cannot silently rebind source authority", (t) => {
  const root = fixture(t),
    before = loadPublicWorkosOperatorScope(root);
  const path = join(root, "docs/plan/source.json"),
    manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.captured_at = "2026-10-15T01:00:00.000Z";
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(loadPublicWorkosOperatorScope(root), before);
  manifest.sources.plan.sequence = 70;
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => loadPublicWorkosOperatorScope(root), /WORKOS_OPERATOR_INPUT_UNAVAILABLE/);
});
test("workspace exports metadata is part of the executable source closure", (t) => {
  const root = fixture(t),
    before = JSON.parse(loadPublicWorkosOperatorScope(root));
  for (const path of ["packages/contracts/package.json", "packages/identity/package.json"]) {
    const original = readFileSync(join(root, path));
    writeFileSync(
      join(root, path),
      JSON.stringify({ type: "module", exports: { "./validation": "./alternate.mjs" } }),
    );
    assert.notEqual(
      JSON.parse(loadPublicWorkosOperatorScope(root)).sourceDigest,
      before.sourceDigest,
    );
    writeFileSync(join(root, path), original);
    assert.equal(JSON.parse(loadPublicWorkosOperatorScope(root)).sourceDigest, before.sourceDigest);
  }
});
test("plan, profile and aliased source drift are unavailable without reflecting raw errors", (t) => {
  for (const kind of ["plan", "profile", "alias", "extra"]) {
    const root = fixture(t);
    if (kind === "plan") writeFileSync(join(root, "docs/plan/build-plan.md"), "unrecorded plan");
    if (kind === "profile" || kind === "extra") {
      const path = join(root, "docs/decisions/workos-operator-qualification.json"),
        p = JSON.parse(readFileSync(path, "utf8"));
      if (kind === "profile") p.token_endpoint = "https://foreign.example/token";
      else p.api_key = "unused-private-fixture";
      writeFileSync(path, JSON.stringify(p));
    }
    if (kind === "alias")
      linkSync(join(root, "scripts/workos-operator.mjs"), join(root, "alias.mjs"));
    assert.throws(
      () => loadPublicWorkosOperatorScope(root),
      (error) => error.message === "WORKOS_OPERATOR_INPUT_UNAVAILABLE" && error.cause === undefined,
    );
  }
});
test("prepare writes only unapproved private proposal and never overwrites it", (t) => {
  const publicRoot = fixture(t),
    root = join(privateParent(t), "operator");
  const result = prepareWorkosOperatorActivation(root, loadPublicWorkosOperatorScope(publicRoot));
  assert.equal(result.status, "prepared_unapproved");
  assert.equal(result.providerRequests, 0);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "activation.json")).mode & 0o777, 0o600);
  const raw = readWorkosOperatorActivation(root),
    activation = JSON.parse(raw);
  for (const key of ["ownerApproved", "callbackRegistered", "cleanupBaseline"])
    assert.equal(activation[key], false);
  assert.equal(
    new Set([
      activation.operationId,
      activation.activationId,
      activation.beginCommandId,
      activation.callbackCommandId,
    ]).size,
    4,
  );
  assert.deepEqual(readdirSync(root), ["activation.json"]);
  assert.throws(() =>
    prepareWorkosOperatorActivation(root, loadPublicWorkosOperatorScope(publicRoot)),
  );
  assert.equal(readWorkosOperatorActivation(root), raw);
});
test("unsafe private permissions, symlink and hardlink credentials are unavailable", (t) => {
  const scope = loadPublicWorkosOperatorScope(fixture(t));
  for (const kind of ["mode", "symlink", "hardlink", "directory"]) {
    const root = join(privateParent(t), "operator");
    prepareWorkosOperatorActivation(root, scope);
    const file = join(root, "activation.json");
    if (kind === "mode") chmodSync(file, 0o644);
    if (kind === "directory") chmodSync(root, 0o755);
    if (kind === "hardlink") linkSync(file, join(root, "copy.json"));
    if (kind === "symlink") {
      const text = readFileSync(file);
      rmSync(file);
      writeFileSync(join(root, "original.json"), text, { mode: 0o600 });
      symlinkSync(join(root, "original.json"), file);
    }
    assert.throws(() => readWorkosOperatorActivation(root), /WORKOS_OPERATOR_INPUT_UNAVAILABLE/);
  }
  assert.throws(() => requirePrivateWorkosOperatorRoot(process.cwd()));
});
test("caller proxy scope is rejected before coercion or private file creation", (t) => {
  let traps = 0;
  const hostile = new Proxy(
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
    },
  );
  const root = join(privateParent(t), "operator");
  assert.throws(
    () => prepareWorkosOperatorActivation(root, hostile),
    /WORKOS_OPERATOR_INPUT_UNAVAILABLE/,
  );
  assert.equal(traps, 0);
});
test("current canonical72 denies the completed native71 scope and fresh preparation", async (t) => {
  const root = join(privateParent(t), "operator");
  assert.throws(() => loadPublicWorkosOperatorScope(), /WORKOS_OPERATOR_INPUT_UNAVAILABLE/);
  assert.throws(() => prepareWorkosOperatorActivation(root), /WORKOS_OPERATOR_INPUT_UNAVAILABLE/);
  assert.equal(existsSync(root), false);
  await assert.rejects(
    runWorkosOperatorCommand("prepare", root),
    /WORKOS_OPERATOR_INPUT_UNAVAILABLE/,
  );
  assert.equal(existsSync(root), false);
});
test("execution source-directory predicate rejects an unrelated cwd", (t) => {
  const original = process.cwd(),
    other = privateParent(t);
  assert.equal(isWorkosOperatorSourceDirectory(), true);
  try {
    process.chdir(other);
    assert.equal(isWorkosOperatorSourceDirectory(), false);
  } finally {
    process.chdir(original);
  }
});
