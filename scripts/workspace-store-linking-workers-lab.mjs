import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

const paths = [
  "packages/identity/src/workspace-store-linking.ts",
  "packages/policy/src/index.ts",
  "scripts/fixtures/workspace-store-linking-worker.ts",
  "scripts/workspace-store-linking-workers-lab.mjs",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "package-lock.json",
];
const bundle = await build({
  entryPoints: ["scripts/fixtures/workspace-store-linking-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:crypto"],
  write: false,
  metafile: true,
});
assert.ok(
  !Object.keys(bundle.metafile.inputs).some((path) => /ajv\/dist\/(compile|core|2020)/.test(path)),
);
assert.ok(
  !Object.values(bundle.metafile.outputs).some((output) =>
    output.imports.some((item) => item.path === "node:util"),
  ),
);
let outbound = 0;
const runtime = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.ERROR),
  outboundService: () => {
    outbound++;
    return new Response(null, { status: 502 });
  },
});
try {
  const response = await runtime.dispatchFetch("http://morrow.local/workspace-store-linking", {
    method: "POST",
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.checks.length, 19);
  for (const check of result.checks) assert.equal(check.passed, true, check.name);
  assert.equal(outbound, 0);
  result.checks.push({ name: "zero_provider_requests", passed: true });
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  mkdirSync("docs/evidence/P05.T03", { recursive: true });
  writeFileSync(
    "docs/evidence/P05.T03/workers-lab.json",
    JSON.stringify(
      {
        task: "P05.T03a",
        canonical_sequence: JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan
          .sequence,
        observed_at: new Date().toISOString(),
        scope:
          "Actual pinned local workerd with synthetic SQL replies and current permission facts; not PostgreSQL, Shopify/WorkOS authentication, review issuance, hosted deployment or linking qualification",
        runtime: "miniflare4.20260730.0",
        compatibility_date: "2026-07-30",
        provider_calls: outbound,
        bundle_sha256: sha(bundle.outputFiles[0].text),
        input_digests: Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))])),
        checks: result.checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: ${result.checks.length} actual local Workers workspace-store linking checks; zero provider requests.`,
  );
} finally {
  await runtime.dispose();
}
