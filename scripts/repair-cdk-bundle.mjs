import { cpSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
export function treeDigest(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("UNREVIEWED_DEPENDENCY_SYMLINK");
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  walk(root);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(relative(root, file).replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(readFileSync(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}
export function inspectRepairTrees(manifest, originalDigest, fixedDigest) {
  const errors = [];
  if (![manifest.original_tree_sha256, manifest.fixed_tree_sha256].includes(originalDigest))
    errors.push("UNREVIEWED_BUNDLED_TREE");
  if (fixedDigest !== manifest.fixed_tree_sha256) errors.push("UNREVIEWED_FIXED_TREE");
  return errors;
}
function repair() {
  const manifest = JSON.parse(readFileSync("infra/dependency-repair.json", "utf8"));
  const require = createRequire(resolve("packages/infrastructure/package.json"));
  const cdk = dirname(require.resolve("aws-cdk-lib/package.json"));
  const sourceRequire = createRequire(resolve("package.json"));
  const fixed = dirname(sourceRequire.resolve("brace-expansion/package.json"));
  const bundled = resolve(cdk, "node_modules/brace-expansion");
  if (
    JSON.parse(readFileSync(resolve(cdk, "package.json"))).version !== manifest.cdk_version ||
    JSON.parse(readFileSync(resolve(fixed, "package.json"))).version !== manifest.fixed_version
  )
    throw Error("UNREVIEWED_REPAIR_PACKAGE_VERSION");
  const errors = inspectRepairTrees(manifest, treeDigest(bundled), treeDigest(fixed));
  if (errors.length) throw Error(errors.join(","));
  if (treeDigest(bundled) !== manifest.fixed_tree_sha256) {
    // Only this reviewed dependency folder under the resolved CDK install.
    rmSync(bundled, { recursive: true });
    cpSync(fixed, bundled, { recursive: true });
  }
  if (treeDigest(bundled) !== manifest.fixed_tree_sha256) throw Error("REPAIR_READBACK_MISMATCH");
  const expand = require(resolve(bundled, "dist/commonjs/index.js")).expand;
  if (JSON.stringify(expand("{a,b}-{1,2}")) !== '["a-1","a-2","b-1","b-2"]')
    throw Error("REPAIR_BEHAVIOR_CHECK_FAILED");
  // This nesting shape caused the published upstream stack-exhaustion issue.
  expand("{".repeat(4000) + "a,b" + "}".repeat(4000));
  mkdirSync("docs/evidence/P04.T01", { recursive: true });
  writeFileSync(
    "docs/evidence/P04.T01/dependency-repair.json",
    JSON.stringify(
      {
        scope:
          "Reproducible fixed upstream package replacement for a bundled CDK advisory; not an upstream release fix",
        cdk_version: manifest.cdk_version,
        fixed_version: manifest.fixed_version,
        fixed_tree_sha256: manifest.fixed_tree_sha256,
        behavior_check: "passed",
        deep_nesting_regression: "passed; 4000 nested groups",
        registry_audit:
          "npm audit still flags original bundled package in lock; keep upstream advisory pending, never report zero",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS: reviewed CDK bundle repair and checksum/behavior readback; upstream advisory remains recorded.",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) repair();
