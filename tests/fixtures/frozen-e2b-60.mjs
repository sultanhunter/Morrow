import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2bLabSourceBinding, e2bLabSources } from "../../scripts/e2b-development-input.mjs";
import {
  ownedBuildSourceBinding,
  ownedBuildSources,
} from "../../scripts/e2b-owned-build-input.mjs";

export const e2bRepositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Frozen operator recipes keep their original source bytes and plan revision.
// Only public code/configuration is copied; no private credential or live report.
export function frozenE2B60Fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morrow-e2b-frozen-60-")));
  for (const path of new Set([
    ...e2bLabSources,
    ...ownedBuildSources,
    "infra/labs/e2b-development-account.json",
  ])) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(e2bRepositoryRoot, path), target);
  }
  mkdirSync(resolve(root, "docs/plan"), { recursive: true });
  copyFileSync(
    new URL("./e2b-plan-60.json", import.meta.url),
    resolve(root, "docs/plan/source.json"),
  );
  mkdirSync(resolve(root, "docs/evidence/P04.T01h"), { recursive: true });
  if (
    e2bLabSourceBinding(root).sourceSha256 !==
      "1a3995f691cdb4447653c21d3f091953791fb544c1c36992eb86a37d6b423891" ||
    ownedBuildSourceBinding(root).sourceSha256 !==
      "ec7ddde2e284ed289dfae670e00b4bf5cfecc089d54dcf0cf87e557f8fda3ce8"
  ) {
    rmSync(root, { recursive: true, force: true });
    throw Error("FROZEN_E2B_60_SOURCE_CHANGED");
  }
  return {
    root,
    read: (path) => readFileSync(resolve(root, path)),
    script: (path) => resolve(e2bRepositoryRoot, path),
    loader: resolve(e2bRepositoryRoot, "node_modules/tsx/dist/loader.mjs"),
    useCurrentPlan: () =>
      copyFileSync(
        resolve(e2bRepositoryRoot, "docs/plan/source.json"),
        resolve(root, "docs/plan/source.json"),
      ),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
