import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ownedBuildSourceBinding } from "./e2b-owned-build-input.mjs";
import { qualifyE2BOwnedBaseImage } from "../packages/runtime-adapters/src/e2b/owned-image.ts";

export async function mainE2BOwnedImageQualification(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  if (argv.length && !(argv.length === 1 && argv[0] === "--verify-public-image")) return 2;
  const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
  if (plan.sources.plan.sequence !== 65) throw Error("E2B_OWNED_IMAGE_CURRENT_PLAN_DENIED");
  const source = ownedBuildSourceBinding(".");
  const live = argv.length === 1;
  const { evidenceDirectory, ...runtimeOverrides } = dependencies;
  const injected = Object.keys(runtimeOverrides).length > 0;
  if (injected) {
    const outside =
      typeof evidenceDirectory === "string" &&
      isAbsolute(evidenceDirectory) &&
      realpathSync(evidenceDirectory) === resolve(evidenceDirectory) &&
      [
        resolve("."),
        resolve("../../morrow-private-staging"),
        resolve("../../morrow-publish"),
        resolve(homedir(), "Desktop/Morrow"),
      ].every((root) => relative(root, resolve(evidenceDirectory)).startsWith("../"));
    if (!outside) throw Error("E2B_OWNED_IMAGE_TEST_EVIDENCE_SINK_DENIED");
  }
  if (!injected && evidenceDirectory !== undefined)
    throw Error("E2B_OWNED_IMAGE_TEST_EVIDENCE_SINK_DENIED");
  const destination = resolve(
    evidenceDirectory ?? "docs/evidence/P04.T01h",
    `${live ? "owned-image-qualification" : "owned-image-preparation"}.json`,
  );
  mkdirSync(resolve(destination, ".."), { recursive: true });
  const report = (value) =>
    writeFileSync(
      destination,
      JSON.stringify(
        {
          task: "P04.T01h",
          plan_sequence: 65,
          source_sha256: source.sourceSha256,
          source_digests: source.digests,
          read_only: true,
          private_input_read: false,
          build_registered: false,
          build_started: false,
          sandbox_allocated: false,
          production_qualified: false,
          ...value,
        },
        null,
        2,
      ) + "\n",
    );
  if (!live) {
    report({ status: "prepared", provider_calls: false });
    console.log("E2B_OWNED_IMAGE_PREPARED");
    return 0;
  }
  if (
    existsSync(".env") ||
    existsSync(".env.local") ||
    Object.keys(process.env).some(
      (name) =>
        name.startsWith("E2B_") || /^(HTTPS?_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)$/i.test(name),
    )
  )
    throw Error("E2B_OWNED_IMAGE_ENVIRONMENT_DENIED");
  try {
    const result = await qualifyE2BOwnedBaseImage(
      { schemaVersion: 1, task: "P04.T01h", planSequence: 65, sourceSha256: source.sourceSha256 },
      { ...runtimeOverrides, sourceSha256: source.sourceSha256 },
    );
    report({
      status: "partial",
      provider_calls: !injected,
      injected_transport: injected,
      public_manifest_verified: true,
      owned_runtime_image_qualified: false,
      result,
    });
    console.log("E2B_PUBLIC_MANIFEST_VERIFIED_OWNED_BUILD_PENDING");
    return 0;
  } catch {
    report({
      status: "unqualified",
      provider_calls_attempted: !injected,
      injected_transport: injected,
      code: "E2B_PUBLIC_MANIFEST_QUALIFICATION_FAILED",
    });
    console.log("E2B_PUBLIC_MANIFEST_QUALIFICATION_FAILED");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await mainE2BOwnedImageQualification();
  } catch {
    console.log("E2B_OWNED_IMAGE_CONTROLLER_DENIED");
    process.exitCode = 2;
  }
}
