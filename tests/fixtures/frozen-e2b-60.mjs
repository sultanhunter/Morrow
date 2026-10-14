import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const e2bRepositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const archiveRoot = fileURLToPath(new URL("./e2b-source-60/", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(archiveRoot, "manifest.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(frozen) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `morrow-e2b-${frozen ? "frozen-60" : "current-67"}-`)),
  );
  try {
    // Only module-format scaffolding; original controller/dependency bytes stay exact.
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    for (const [path, expected] of Object.entries(manifest.files)) {
      const bytes = readFileSync(resolve(frozen ? archiveRoot : e2bRepositoryRoot, path));
      if (frozen && sha(bytes) !== expected) throw Error("FROZEN_E2B_60_SOURCE_CHANGED");
      const target = resolve(root, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(frozen ? archiveRoot : e2bRepositoryRoot, path), target);
    }
    mkdirSync(resolve(root, "docs/plan"), { recursive: true });
    copyFileSync(
      frozen
        ? new URL("./e2b-plan-60.json", import.meta.url)
        : resolve(e2bRepositoryRoot, "docs/plan/source.json"),
      resolve(root, "docs/plan/source.json"),
    );
    mkdirSync(resolve(root, "docs/evidence/P04.T01h"), { recursive: true });
    if (frozen) {
      const binding = (paths) =>
        sha(
          JSON.stringify(
            Object.fromEntries(paths.map((p) => [p, sha(readFileSync(resolve(root, p)))])),
          ),
        );
      if (
        binding(manifest.runtimeSources) !==
          "1a3995f691cdb4447653c21d3f091953791fb544c1c36992eb86a37d6b423891" ||
        binding(manifest.ownedBuildSources) !==
          "ec7ddde2e284ed289dfae670e00b4bf5cfecc089d54dcf0cf87e557f8fda3ce8"
      )
        throw Error("FROZEN_E2B_60_SOURCE_CHANGED");
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    read: (path) => readFileSync(resolve(root, path)),
    // Run the copied controller and its copied dependencies, never the active source.
    script: (path) => resolve(root, path),
    loader: resolve(e2bRepositoryRoot, "node_modules/tsx/dist/loader.mjs"),
    useCurrentPlan: () =>
      copyFileSync(
        resolve(e2bRepositoryRoot, "docs/plan/source.json"),
        resolve(root, "docs/plan/source.json"),
      ),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Exact public60 code/configuration only; no private credential or live report.
export const frozenE2B60Fixture = () => fixture(true);
export const currentE2BFixture = () => fixture(false);
