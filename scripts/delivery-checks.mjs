import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { writeArtifact } from "./artifacts.mjs";
export function inspectSecrets(text) {
  const patterns = [
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
    ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
    ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    [
      "credential_literal",
      /\b(?:apiSecretKey|client_secret|access_token|password)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
    ],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}
export function inspectMigrations(manifest, files) {
  const errors = [];
  if (
    manifest.schema_version !== 1 ||
    manifest.engine !== "postgresql17" ||
    !Array.isArray(manifest.migrations)
  )
    return ["INVALID_MIGRATION_MANIFEST"];
  let previous = 0;
  const names = new Set();
  for (const entry of manifest.migrations) {
    if (
      !Number.isInteger(entry.sequence) ||
      entry.sequence <= previous ||
      !/^\d{4}\.[a-z0-9-]+\.sql$/.test(entry.file) ||
      names.has(entry.file) ||
      !entry.reviewRef
    )
      errors.push("INVALID_MIGRATION_RECORD");
    previous = entry.sequence;
    names.add(entry.file);
    const sql = files[entry.file];
    if (!sql) errors.push("MISSING_MIGRATION");
    else {
      if (createHash("sha256").update(sql).digest("hex") !== entry.sha256)
        errors.push("MIGRATION_CHECKSUM");
      if (!/^\s*BEGIN\s*;/i.test(sql) || !/COMMIT\s*;\s*$/i.test(sql))
        errors.push("MIGRATION_TRANSACTION_ENVELOPE");
    }
  }
  if (Object.keys(files).some((name) => !names.has(name))) errors.push("UNREVIEWED_MIGRATION_FILE");
  return [...new Set(errors)];
}
export function lockedBundleAncestor(path, packages) {
  if (!packages[path]?.inBundle) return false;
  let parent = path;
  while (parent.includes("/node_modules/")) {
    parent = parent.slice(0, parent.lastIndexOf("/node_modules/"));
    const record = packages[parent];
    if (record && !record.inBundle)
      return !!record.integrity && record.resolved?.startsWith("https://registry.npmjs.org/");
  }
  return false;
}
function verify() {
  const paths = [];
  const skip = new Set(["node_modules", ".git", "build", "dist", ".react-router", ".artifacts"]);
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = (dir === "." ? "" : dir + "/") + entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(p);
      } else if (
        /\.(?:ts|tsx|mjs|json|md|yml|yaml|toml|html|sql)$/.test(p) ||
        /\.env(?:\.|$)/.test(entry.name)
      )
        paths.push(p);
    }
  }
  walk(".");
  const errors = paths.flatMap((p) =>
    inspectSecrets(readFileSync(p, "utf8")).map((kind) => ({ path: p, kind })),
  ); // Never output matches or values.
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  const sql = Object.fromEntries(
    readdirSync("migrations")
      .filter((p) => p.endsWith(".sql"))
      .map((p) => [p, readFileSync("migrations/" + p, "utf8")]),
  );
  const migrationErrors = inspectMigrations(manifest, sql);
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  if (lock.lockfileVersion !== 3) migrationErrors.push("LOCK_VERSION");
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (
      path.includes("node_modules") &&
      !pkg.link &&
      (!pkg.integrity || !pkg.resolved?.startsWith("https://registry.npmjs.org/")) &&
      !lockedBundleAncestor(path, lock.packages)
    )
      migrationErrors.push("UNPINNED_REGISTRY_DEPENDENCY:" + path);
  }
  const negatives = [
    {
      name: "leaked_fixture_key",
      passed: inspectSecrets("sk-proj-" + "A".repeat(50)).includes("openai_key"),
    },
    {
      name: "private_key_header",
      passed: inspectSecrets("-----BEGIN " + "PRIVATE KEY-----").includes("private_key"),
    },
    {
      name: "broken_migration_checksum",
      passed: inspectMigrations(
        {
          schema_version: 1,
          engine: "postgresql17",
          migrations: [
            {
              sequence: 1,
              file: "0001.example.sql",
              sha256: "wrong",
              reviewRef: "synthetic-review",
            },
          ],
        },
        { "0001.example.sql": "BEGIN; SELECT 1; COMMIT;" },
      ).includes("MIGRATION_CHECKSUM"),
    },
  ];
  writeArtifact("verify/delivery.json", {
    generated_at: new Date().toISOString(),
    scope:
      "Known-pattern secret guard, dependency locking (bundles bound to integrity-checked parent tarballs), migration metadata/checksum/envelope only; not complete secret assurance or PostgreSQL execution. Hosted CI evidenced separately; release protection pending.",
    scanned_files: paths.length,
    dependency_records: Object.keys(lock.packages).length,
    migrations: manifest.migrations.length,
    negative_checks: negatives,
    secret_findings: errors,
    migration_errors: migrationErrors,
  });
  if (errors.length || migrationErrors.length || negatives.some((x) => !x.passed))
    throw Error("Delivery checks failed; inspect redacted evidence");
  console.log(
    `PASS: ${paths.length} text files, locked dependencies and ${negatives.length} deliberate failures detected. Remote review/engine qualification pending.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) verify();
