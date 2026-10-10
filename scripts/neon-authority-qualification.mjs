import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { loadNeonPreflightInput, publicNeonPreflightBinding } from "./neon-preflight-input.mjs";
import { loadNeonAuthorityResume } from "./neon-authority-input.mjs";
import { neonPreflightEgressScript } from "./neon-preflight-egress.mjs";
const mode = process.argv[2];
if (
  !["--install-and-test", "--resume-roles-and-test", "--inspect"].includes(mode) ||
  process.argv.length !== 4
) {
  console.log(
    "Preparation only. Explicit approved invocation requires --install-and-test, inspected --resume-roles-and-test or read-only --inspect plus protected operator JSON.",
  );
  process.exit(process.argv.length === 2 ? 0 : 2);
}
let runtime,
  binding,
  phase = "input",
  seedAttempted = false,
  cleanup = false,
  failure;
const checks = [];
const files = [
  "scripts/neon-authority-qualification.mjs",
  "scripts/neon-authority-input.mjs",
  "scripts/fixtures/neon-authority.ts",
  "scripts/neon-preflight-egress.mjs",
  "packages/identity/src/neon.ts",
  "packages/identity/src/neon-request.ts",
  "packages/identity/src/index.ts",
  "packages/policy/src/index.ts",
  "package-lock.json",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = (status, extra = {}) => {
  if (!binding) return;
  mkdirSync("docs/evidence/P04.T01d", { recursive: true });
  writeFileSync(
    "docs/evidence/P04.T01d/qualification.json",
    JSON.stringify(
      {
        task: "P04.T01d",
        observed_at: new Date().toISOString(),
        status,
        phase,
        binding,
        checks,
        fixture_cleanup_verified: cleanup,
        ...extra,
        source_digests: Object.fromEntries(files.map((f) => [f, sha(readFileSync(f))])),
        scope:
          "Actual Neon restricted roles/migrations and synthetic application authority in local workerd. Not WorkOS authentication, Cloudflare deployment, rotation/recovery or launch acceptance.",
      },
      null,
      2,
    ) + "\n",
  );
};
try {
  const root = resolve("../../morrow-private-staging");
  const operator = loadNeonPreflightInput(process.argv[3], root);
  binding = publicNeonPreflightBinding(operator);
  if (
    binding.projectId !== "cool-butterfly-64820147" ||
    binding.branchId !== "br-flat-sea-b8pulqt6" ||
    binding.hostname !== "ep-proud-bread-b8wezfad.c-14.us-east-1.aws.neon.tech"
  )
    throw Error("BINDING_DENIED");
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  if (manifest.migrations.length !== 3) throw Error("MIGRATION_DENIED");
  const migrations = manifest.migrations.map((m) => {
    const text = readFileSync("migrations/" + m.file, "utf8");
    if (sha(text) !== m.sha256) throw Error("MIGRATION_DENIED");
    return text;
  });
  const privateFile = resolve(root, "neon-authority-input.json");
  if (mode === "--install-and-test" && existsSync(privateFile))
    throw Error("EXISTING_OPERATION_REQUIRES_INSPECTION");
  let input = {
    ...operator,
    runtimePassword: randomBytes(32).toString("hex"),
    runId: "qual_" + randomBytes(12).toString("hex"),
    proofs: [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")],
    migrations,
  };
  if (mode === "--resume-roles-and-test")
    input = loadNeonAuthorityResume(privateFile, root, operator, migrations);
  const bundle = await build({
    entryPoints: ["scripts/fixtures/neon-authority.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["node:crypto"],
    target: "es2022",
    write: false,
  });
  runtime = new Miniflare({
    log: new Log(LogLevel.NONE),
    workers: [
      {
        name: "authority",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { QUALIFICATION: JSON.stringify(input) },
        outboundService: "egress",
      },
      {
        name: "egress",
        modules: true,
        script: neonPreflightEgressScript,
        compatibilityDate: "2026-07-30",
        bindings: { HOST: input.hostname },
      },
    ],
  });
  const call = async (action) => {
    phase = action;
    if (mode !== "--inspect") report("running");
    const r = await runtime.dispatchFetch("http://qualification.local/" + action, {
      method: "POST",
    });
    const json = await r.json();
    if (r.status !== 200 || json.passed !== true) {
      failure = json;
      throw Error("NEON_AUTHORITY_FAILED");
    }
    if (json.checks) checks.push(...json.checks);
    return json;
  };
  const observed = await call("inspect");
  if (mode === "--inspect") {
    console.log(
      JSON.stringify({
        phase: "read_only_inspection",
        binding,
        state: observed.state,
        details: observed.details,
      }),
    );
  } else {
    if (
      observed.state.roles !== (mode === "--resume-roles-and-test" ? 2 : 0) ||
      observed.state.schemas !== 0
    )
      throw Error("EXISTING_OPERATION_REQUIRES_INSPECTION");
    if (mode === "--install-and-test")
      writeFileSync(privateFile, JSON.stringify(input), { mode: 0o600, flag: "wx" });
    report("running", { migration_digests: manifest.migrations });
    try {
      await call(mode === "--resume-roles-and-test" ? "resume-roles" : "install");
      seedAttempted = true;
      await call("seed");
      await call("test");
    } finally {
      if (seedAttempted) {
        await call("cleanup");
        cleanup = true;
      }
    }
    await runtime.dispose();
    runtime = undefined;
    report("passed", { migrations_applied: true, migration_digests: manifest.migrations });
    console.log(
      "PASS: actual restricted Neon authority, synthetic tenant tests and verified fixture cleanup; no app deployment.",
    );
  }
} catch {
  if (mode !== "--inspect")
    report("held", {
      code: "NEON_AUTHORITY_FAILED_OR_EXISTING_OPERATION",
      ...(failure ? { failure } : {}),
    });
  console.error(
    "NEON_AUTHORITY_FAILED_OR_EXISTING_OPERATION: inspect fixed phase/state before any retry; no raw provider error logged.",
  );
  process.exitCode = 1;
} finally {
  if (runtime) {
    try {
      await runtime.dispose();
    } catch {
      report("held", { code: "RUNTIME_CLEANUP_FAILED" });
      process.exitCode = 1;
    }
  }
}
