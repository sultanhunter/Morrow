import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { loadNeonPreflightInput, publicNeonPreflightBinding } from "./neon-preflight-input.mjs";
import { neonPreflightEgressScript } from "./neon-preflight-egress.mjs";
import { writeArtifact } from "./artifacts.mjs";

// No implicit credential lookup, provider calls or CI invocation.
if (process.argv[2] !== "--run" || process.argv.length !== 4) {
  console.log(
    "Preparation only. Explicit controlled invocation: node scripts/neon-staging-preflight.mjs --run /absolute/private/neon-preflight.json",
  );
  process.exit(process.argv.length === 2 ? 0 : 2);
}
let runtime, binding;
const files = [
  "scripts/neon-staging-preflight.mjs",
  "scripts/neon-preflight-input.mjs",
  "scripts/neon-preflight-egress.mjs",
  "scripts/fixtures/neon-staging-preflight.ts",
  "package-lock.json",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeReport = (status, result = {}) => {
  if (!binding) return;
  writeArtifact("neon/preflight.json", {
    task: "P04.T01c",
    observed_at: new Date().toISOString(),
    status,
    binding,
    ...result,
    scope:
      "Actual Neon operator WSS/PostgreSQL transactions in local workerd; not morrow_api/RLS, WorkOS, live Cloudflare deployment, failover or recovery qualification",
    runtime: "miniflare4.20260730.0",
    migrations_applied: false,
    cloud_resources_created: false,
    source_digests: Object.fromEntries(files.map((file) => [file, sha(readFileSync(file))])),
  });
};
try {
  const input = loadNeonPreflightInput(process.argv[3], resolve("../../morrow-private-staging"));
  binding = publicNeonPreflightBinding(input);
  writeReport("running");
  const bundle = await build({
    entryPoints: ["scripts/fixtures/neon-staging-preflight.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  // WSS requests may go only to the exact owner-selected Neon host and /v2.
  // Other outbound destinations and protocols are rejected by the egress Worker.
  runtime = new Miniflare({
    log: new Log(LogLevel.NONE),
    workers: [
      {
        name: "qualification",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { QUALIFICATION: JSON.stringify(input) },
        outboundService: "neon-egress",
      },
      {
        name: "neon-egress",
        modules: true,
        compatibilityDate: "2026-07-30",
        bindings: { HOST: input.hostname },
        script: neonPreflightEgressScript,
      },
    ],
  });
  const response = await runtime.dispatchFetch("http://qualification.local/preflight", {
    method: "POST",
  });
  const result = await response.json();
  if (response.status !== 200 || result.passed !== true) throw Error("NEON_PREFLIGHT_FAILED");
  await runtime.dispose();
  runtime = undefined;
  writeReport("passed", result);
  console.log(
    "PASS: live Neon read-only operator transport/transaction preflight; no merchant data or deployment.",
  );
} catch {
  writeReport("failed", { code: "NEON_PREFLIGHT_FAILED" });
  console.error(
    "NEON_PREFLIGHT_FAILED: inspect owned selectors and private credentials; no raw provider error is logged.",
  );
  process.exitCode = 1;
} finally {
  if (runtime) {
    try {
      await runtime.dispose();
    } catch {
      writeReport("failed", { code: "NEON_PREFLIGHT_CLEANUP_FAILED" });
      console.error("NEON_PREFLIGHT_CLEANUP_FAILED");
      process.exitCode = 1;
    }
  }
}
