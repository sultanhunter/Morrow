// Node-only output helper. Every generated report, lab result or verification
// summary is written under one untracked root: `.artifacts/` at the repository
// root by default, or MORROW_ARTIFACTS_DIR when set (CI points it outside the
// checkout and uploads it). Never import this module from scripts/fixtures/*.ts
// (bundled into Workers) or from the E2B operator scripts (copied into fixed
// fixture roots).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not process.cwd(): some tests spawn scripts with a
// temporary working directory.
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const segment = /^[a-z0-9][a-z0-9._-]*$/;

export const artifactsRoot = () =>
  process.env.MORROW_ARTIFACTS_DIR
    ? resolve(process.env.MORROW_ARTIFACTS_DIR)
    : join(repositoryRoot, ".artifacts");

export function artifactPath(name) {
  if (typeof name !== "string" || !name.split("/").every((p) => segment.test(p)))
    throw Error("ARTIFACT_NAME_INVALID");
  return join(artifactsRoot(), ...name.split("/"));
}

// Overwrites any earlier output with the same name. Strings are written as-is;
// other values are written as indented JSON with a trailing newline.
export function writeArtifact(name, value) {
  const path = artifactPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  return path;
}
