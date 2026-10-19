import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFileInfo } from "prettier";
import { repositoryRoot } from "../scripts/artifacts.mjs";

// P03.T04e AC01: formatting covers the whole tree through one reviewed ignore file. The
// ignore file cannot hide code: every tracked code or configuration file outside docs/ is
// formatted, except the generated and byte-locked files named below, which their own
// checks pin byte for byte.

const scripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts;
// The Prettier 3 CLI default, so the test sees exactly what `prettier --check .` sees.
const ignorePath = [".gitignore", ".prettierignore"].map((name) => join(repositoryRoot, name));
const code = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|yml|yaml|css|html)$/;
// Generated or byte-locked tracked files that formatting must never rewrite:
// - packages/contracts/src/generated/: `npm run verify:boundaries` regenerates and compares them;
// - apps/*/worker-configuration.d.ts: `wrangler types`, compared by `npm run edge:check`;
// - tests/fixtures/e2b-*: per-file SHA-256 manifests and OCI digests.
const exempt = [
  /^packages\/contracts\/src\/generated\//,
  /^apps\/[a-z0-9-]+\/worker-configuration\.d\.ts$/,
  /^tests\/fixtures\/e2b-/,
];

test("format and format:check run Prettier over the whole tree", () => {
  assert.equal(scripts.format, "prettier --write .");
  assert.equal(scripts["format:check"], "prettier --check .");
});

test("the ignore files hide no tracked code or configuration outside docs/", async () => {
  // Tracked files, plus new files that git does not ignore, so a file is covered before
  // its first commit too.
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const checked = tracked.filter((path) => !path.startsWith("docs/") && code.test(path));
  for (const path of [
    "package.json",
    "tsconfig.base.json",
    ".prettierrc.json",
    "migrations/manifest.json",
    ".github/workflows/ci.yml",
  ])
    assert.ok(checked.includes(path), `${path} is a tracked file the guard checks`);
  const ignored = [];
  const unparsed = [];
  for (const path of checked) {
    const info = await getFileInfo(join(repositoryRoot, path), { ignorePath });
    if (info.ignored) ignored.push(path);
    else if (info.inferredParser === null) unparsed.push(path);
  }
  assert.deepEqual(
    ignored.filter((path) => !exempt.some((pattern) => pattern.test(path))),
    [],
    "only generated or byte-locked files may be ignored",
  );
  for (const pattern of exempt)
    assert.ok(
      checked.some((path) => pattern.test(path)) &&
        checked.filter((path) => pattern.test(path)).every((path) => ignored.includes(path)),
      `${pattern} names tracked files and all of them are ignored`,
    );
  assert.deepEqual(unparsed, [], "every checked file has a Prettier parser");
});

test("docs/ and Markdown stay out of formatting, as the ignore file states", async () => {
  for (const path of [
    "docs/plan/build-plan.md",
    "docs/development/ci.md",
    "CLAUDE.md",
    "README.md",
  ])
    assert.equal(
      (await getFileInfo(join(repositoryRoot, path), { ignorePath })).ignored,
      true,
      path,
    );
});
