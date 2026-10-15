import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = "docs/history/workos-identity-77";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("curated77 identity archive preserves exact published blobs and historical evidence scope", () => {
  const manifestBytes = readFileSync(join(root, "archive.json"));
  assert.equal(
    sha(manifestBytes),
    "d928322a727fe30bbabc5d09f27c48b304189ae86b0a238659e415f7e34e86f7",
  );
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.sourceCommit, "3937e194e65f225380d226e99edeb0ea0b2e345a");
  assert.equal(manifest.canonicalSequence, 77);
  assert.equal(manifest.successfulCi.runId, "38760128490");
  assert.equal(manifest.successfulCi.conclusion, "success");
  assert.equal(manifest.fileCount, 60);
  assert.equal(manifest.files.length, 60);
  const paths = manifest.files.map((entry) => entry.path);
  assert.equal(new Set(paths).size, 60);
  assert.deepEqual(paths, [...paths].sort());
  const present = [];
  const walk = (relative = "") => {
    for (const name of readdirSync(join(root, relative))) {
      const path = relative ? relative + "/" + name : name;
      const stat = lstatSync(join(root, path));
      assert.equal(stat.isSymbolicLink(), false, path);
      if (stat.isDirectory()) walk(path);
      else {
        assert.equal(stat.isFile(), true, path);
        present.push(path);
      }
    }
  };
  walk();
  assert.deepEqual(present.sort(), [...paths, "archive.json"].sort());
  for (const entry of manifest.files) {
    assert.match(entry.path, /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/);
    assert.equal(
      entry.path.split("/").some((part) => part === "." || part === ".."),
      false,
    );
    const bytes = readFileSync(join(root, entry.path));
    assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(sha(bytes), entry.sha256, entry.path);
    assert.equal(
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      entry.gitBlob,
      entry.path,
    );
  }
  const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const plan = json("docs/plan/source.json").sources.plan;
  assert.equal(plan.sequence, 77);
  assert.equal(plan.sha256, sha(readFileSync(join(root, "docs/plan/build-plan.md"))));
  assert.deepEqual(
    readFileSync(join(root, "packages/identity/src/workos-session-status.ts")),
    readFileSync(
      "docs/history/workos-session-status-75/packages/identity/src/workos-session-status.ts",
    ),
  );
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const provenance of manifest.evidence) {
    assert.equal(provenance.classification, "historical_source_bound_not_current_recertification");
    const report = json(provenance.path);
    const inputs = report.input_digests ?? report.sourceDigests ?? {};
    const actualDifferences = Object.entries(inputs)
      .filter(([path, digest]) => entries.has(path) && entries.get(path) !== digest)
      .map(([path, evidenceSha256]) => ({
        path,
        evidenceSha256,
        publishedSha256: entries.get(path),
      }));
    assert.deepEqual(provenance.recordedInputsDifferingFromPublishedClosure, actualDifferences);
  }
  const compositionEvidence = manifest.evidence.find(
    (entry) => entry.path === "docs/evidence/P05.T01i/workers-lab.json",
  );
  assert.deepEqual(
    compositionEvidence.recordedInputsDifferingFromPublishedClosure.map((entry) => entry.path),
    ["packages/identity/package.json"],
  );
});
