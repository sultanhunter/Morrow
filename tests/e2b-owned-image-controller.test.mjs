import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mainE2BOwnedImageQualification } from "../scripts/e2b-owned-image-qualification.mjs";
import { ownedBuildSourceBinding } from "../scripts/e2b-owned-build-input.mjs";
import {
  inspectOwnedBuildPrerequisites,
  ownedManifestProofValid,
} from "../scripts/e2b-owned-build-lab.mjs";

import {
  frozenE2B60Fixture,
  currentE2BFixture,
  e2bRepositoryRoot,
} from "./fixtures/frozen-e2b-60.mjs";

const index = readFileSync("tests/fixtures/e2b-base-index.json"),
  child = readFileSync("tests/fixtures/e2b-base-amd64.json");
const clock = 1792000000000;
const frozen = currentE2BFixture(),
  originalCwd = process.cwd();
process.chdir(frozen.root);
after(() => {
  process.chdir(originalCwd);
  frozen.dispose();
});
function response(body, url, type, digest) {
  const r = new Response(body, {
    headers: { "content-type": type, ...(digest ? { "docker-content-digest": digest } : {}) },
  });
  Object.defineProperty(r, "url", { value: url });
  return r;
}
const fetcher = async (url) =>
  String(url).startsWith("https://auth.docker.io/")
    ? response(
        JSON.stringify({
          token: "anonymous_fixture_token",
          expires_in: 300,
          issued_at: new Date(clock).toISOString(),
        }),
        url,
        "application/json",
      )
    : String(url).endsWith("4a369f01a820fe5e65f53c2c5727a78899daf86f0541b721097f289559c8b73f")
      ? response(
          index,
          url,
          "application/vnd.oci.image.index.v1+json",
          "sha256:4a369f01a820fe5e65f53c2c5727a78899daf86f0541b721097f289559c8b73f",
        )
      : response(
          child,
          url,
          "application/vnd.oci.image.manifest.v1+json",
          "sha256:197ad15124a51884aea5a629b96045cd8300bdbbb6df648647004fad99fc59ec",
        );
test("injected image transport needs an isolated evidence sink before any request", async () => {
  let calls = 0;
  await assert.rejects(
    mainE2BOwnedImageQualification(["--verify-public-image"], {
      fetch: async () => {
        calls++;
        throw Error("never");
      },
    }),
  );
  assert.equal(calls, 0);
});
test("mock image proof stays outside active evidence and has no provider-call claim", async () => {
  const active = resolve(
      e2bRepositoryRoot,
      "docs/evidence/P04.T01h/owned-image-qualification.json",
    ),
    before = existsSync(active) ? readFileSync(active) : null;
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "morrow-image-evidence-")));
  try {
    assert.equal(
      await mainE2BOwnedImageQualification(["--verify-public-image"], {
        fetch: fetcher,
        now: () => clock,
        evidenceDirectory: folder,
      }),
      0,
    );
    const report = JSON.parse(readFileSync(join(folder, "owned-image-qualification.json"), "utf8"));
    assert.equal(report.provider_calls, false);
    assert.equal(report.injected_transport, true);
    const profile = JSON.parse(readFileSync("infra/labs/e2b-owned-build.json", "utf8"));
    assert.ok(
      inspectOwnedBuildPrerequisites(profile, {}, report, ownedBuildSourceBinding(".")).includes(
        "E2B_OWNED_BUILD_MANIFEST_UNQUALIFIED",
      ),
    );
    assert.equal(
      ownedManifestProofValid(report.result, ownedBuildSourceBinding(".").sourceSha256),
      true,
    );
    for (const mutate of [
      (p) => (p.sourceSha256 = "f".repeat(64)),
      (p) => (p.scope = "owned_build"),
      (p) => (p.image = "base:latest"),
      (p) => (p.index.headerDigest = "wrong"),
      (p) => (p.platform.architecture = "arm64"),
      (p) => (p.providerCompute = true),
      (p) => (p.nativeResourcesQualified = true),
    ]) {
      const proof = structuredClone(report.result);
      mutate(proof);
      assert.equal(Boolean(ownedManifestProofValid(proof, report.source_sha256)), false);
    }
    assert.deepEqual(existsSync(active) ? readFileSync(active) : null, before);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
test("injected sink cannot overwrite repository evidence", async () => {
  let calls = 0;
  await assert.rejects(
    mainE2BOwnedImageQualification(["--verify-public-image"], {
      fetch: async () => {
        calls++;
        throw Error("never");
      },
      evidenceDirectory: realpathSync("docs/evidence/P04.T01h"),
    }),
  );
  assert.equal(calls, 0);
});

test("current67 image controller denies original60 plan before any request", async () => {
  const current = frozenE2B60Fixture(),
    previous = process.cwd();
  process.chdir(current.root);
  let calls = 0;
  try {
    await assert.rejects(
      mainE2BOwnedImageQualification(["--verify-public-image"], {
        fetch: async () => {
          calls++;
          throw Error("never");
        },
      }),
      /E2B_OWNED_IMAGE_CURRENT_PLAN_DENIED/,
    );
    assert.equal(calls, 0);
    assert.equal(
      existsSync(resolve(current.root, "docs/evidence/P04.T01h/owned-image-qualification.json")),
      false,
    );
  } finally {
    process.chdir(previous);
    current.dispose();
  }
});
