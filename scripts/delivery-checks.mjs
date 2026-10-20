import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { writeArtifact } from "./artifacts.mjs";
import { inspectMigrations, loadMigrationChain, MigrationChainError } from "./migration-chain.mjs";
export function inspectSecrets(text) {
  const patterns = [
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["anthropic_key", /\bsk-ant-[a-z0-9]{2,12}-[A-Za-z0-9_-]{32,}/],
    ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
    ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
    ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["workos_key", /\bsk_(?:test|live)_[A-Za-z0-9]{16,}/],
    ["neon_password", /\bnpg_[A-Za-z0-9]{12,}/],
    // Cloudflare API tokens carry no prefix (40 URL-safe characters), so they are matched
    // where they are used: the variable wrangler reads, or a bearer header (P04.T01i).
    [
      "cloudflare_token",
      /\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{37,}/,
    ],
    ["cloudflare_token", /\bBearer\s+[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/],
    // Turnstile secret keys: the broker's format (^0x…, P05.T01ab) where a secret is named,
    // or the widget-key prefix at a secret's length (site keys are shorter and committed).
    [
      "turnstile_secret",
      /\b(?:TURNSTILE_SECRET_KEY|turnstile[_-]?secret|secret)\b["']?\s*[:=]\s*["']?0x[0-9A-Za-z_-]{20,}/i,
    ],
    ["turnstile_secret", /\b0x4AAAAAAA[0-9A-Za-z_-]{20,}/],
    [
      "credential_literal",
      /\b(?:apiSecretKey|client_secret|access_token|password)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
    ],
  ];
  return [...new Set(patterns.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind))];
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The manifest checks live in the shared chain module (P04.T01i D3); this module keeps
// its historical export for existing callers.
export { inspectMigrations };
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
// Text files the repository secret scan reads, as root-relative paths. Wrangler's
// local state (.wrangler/) is skipped; its configs (.jsonc) and developer secret
// files (.env*, .dev.vars*) are scanned.
export function scannedPaths(root = ".") {
  const paths = [];
  const skip = new Set([
    "node_modules",
    ".git",
    "build",
    "dist",
    ".react-router",
    ".artifacts",
    ".wrangler",
  ]);
  function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = (dir === "." ? "" : dir + "/") + entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(p);
      } else if (
        /\.(?:ts|tsx|mjs|json|jsonc|md|yml|yaml|toml|html|sql)$/.test(p) ||
        /\.env(?:\.|$)/.test(entry.name) ||
        /^\.dev\.vars(?:\.|$)/.test(entry.name)
      )
        paths.push(p);
    }
  }
  walk(".");
  return paths;
}
// Findings carry the path and pattern kind only, never the match or its value.
export function scanSecrets(root = ".") {
  const paths = scannedPaths(root);
  const findings = paths.flatMap((p) =>
    inspectSecrets(readFileSync(join(root, p), "utf8")).map((kind) => ({ path: p, kind })),
  );
  return { paths, findings };
}
// Deliberate migration negatives: one synthetic reviewed row per override (0001.example.sql,
// 0002.example.sql, …) with its SQL, plus bytes for every prerequisite file the rows name and
// any extra files; each override replaces fields of its row. Without overrides or extra files
// the rows pass, so each negative must yield exactly its code.
const syntheticSql = "BEGIN; SELECT 1; COMMIT;";
const syntheticDigest = sha256(syntheticSql);
const examplePrerequisite = "infra/example-prerequisites.sql";
function syntheticMigrationErrors(overrides, extraPrerequisites = {}) {
  const rows = overrides.map((override, index) => ({
    sequence: index + 1,
    file: `000${index + 1}.example.sql`,
    sha256: syntheticDigest,
    reviewRef: "synthetic-review",
    executeAs: "morrow_identity_owner",
    ...override,
  }));
  const named = rows.flatMap((row) => (row.prerequisites ?? []).map(({ file }) => file));
  return inspectMigrations(
    { schema_version: 1, engine: "postgresql17", migrations: rows },
    Object.fromEntries(rows.map((row) => [row.file, syntheticSql])),
    { ...Object.fromEntries(named.map((file) => [file, syntheticSql])), ...extraPrerequisites },
  );
}
const onlyError = (errors, code) => errors.length === 1 && errors[0] === code;
// One synthetic reviewed row whose SQL is `text`, for the runner-contract negatives.
const syntheticSqlErrors = (text) =>
  inspectMigrations(
    {
      schema_version: 1,
      engine: "postgresql17",
      migrations: [
        {
          sequence: 1,
          file: "0001.example.sql",
          sha256: sha256(text),
          reviewRef: "synthetic-review",
          executeAs: "morrow_identity_owner",
        },
      ],
    },
    { "0001.example.sql": text },
  );
function verify() {
  const { paths, findings: errors } = scanSecrets("."); // Never output matches or values.
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  // The shared chain: manifest records, digests, pinned prerequisites and each body's
  // transaction envelope, exactly as the staging runner and the harness read them.
  const migrationErrors = [];
  try {
    loadMigrationChain({ root: "." });
  } catch (error) {
    if (!(error instanceof MigrationChainError)) throw error;
    migrationErrors.push(...error.codes);
  }
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
      name: "anthropic_key_marker",
      passed: inspectSecrets("sk-ant-" + "api03-" + "A".repeat(60)).includes("anthropic_key"),
    },
    {
      name: "workos_key_marker",
      passed: inspectSecrets("sk_" + "test_" + "A".repeat(24)).includes("workos_key"),
    },
    {
      name: "neon_password_marker",
      passed: inspectSecrets("npg_" + "A".repeat(16)).includes("neon_password"),
    },
    {
      name: "cloudflare_token_marker",
      passed:
        inspectSecrets("CLOUDFLARE_API_TOKEN=" + "A".repeat(40)).includes("cloudflare_token") &&
        inspectSecrets("Authorization: Bearer " + "B".repeat(40)).includes("cloudflare_token"),
    },
    {
      name: "turnstile_secret_marker",
      passed:
        inspectSecrets('{"TURNSTILE_SECRET_KEY":"0x' + "C".repeat(33) + '"}').includes(
          "turnstile_secret",
        ) && inspectSecrets("0x4" + "A".repeat(7) + "D".repeat(25)).includes("turnstile_secret"),
    },
    {
      name: "private_key_header",
      passed: inspectSecrets("-----BEGIN " + "PRIVATE KEY-----").includes("private_key"),
    },
    {
      name: "broken_migration_checksum",
      passed: onlyError(syntheticMigrationErrors([{ sha256: "wrong" }]), "MIGRATION_CHECKSUM"),
    },
    {
      name: "missing_execute_as",
      passed: onlyError(syntheticMigrationErrors([{ executeAs: undefined }]), "INVALID_EXECUTE_AS"),
    },
    {
      name: "invalid_prerequisite_path",
      passed: onlyError(
        syntheticMigrationErrors([
          {
            prerequisites: [{ file: "scripts/example-prerequisites.sql", sha256: syntheticDigest }],
          },
        ]),
        "INVALID_PREREQUISITE",
      ),
    },
    {
      name: "open_prerequisite_entry",
      passed: onlyError(
        syntheticMigrationErrors([
          {
            prerequisites: [
              {
                file: examplePrerequisite,
                sha256: syntheticDigest,
                runAs: "morrow_identity_owner",
              },
            ],
          },
        ]),
        "INVALID_PREREQUISITE",
      ),
    },
    {
      name: "broken_prerequisite_checksum",
      passed: onlyError(
        syntheticMigrationErrors([
          { prerequisites: [{ file: examplePrerequisite, sha256: "0".repeat(64) }] },
        ]),
        "PREREQUISITE_CHECKSUM",
      ),
    },
    {
      name: "duplicate_prerequisite",
      passed: onlyError(
        syntheticMigrationErrors([
          { prerequisites: [{ file: examplePrerequisite, sha256: syntheticDigest }] },
          { prerequisites: [{ file: examplePrerequisite, sha256: syntheticDigest }] },
        ]),
        "DUPLICATE_PREREQUISITE",
      ),
    },
    {
      name: "nested_transaction_control",
      passed: onlyError(
        syntheticSqlErrors("BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; COMMIT;"),
        "MIGRATION_TRANSACTION_CONTROL",
      ),
    },
    {
      name: "role_switch_in_migration",
      passed: onlyError(
        syntheticSqlErrors("BEGIN; RESET ROLE; SELECT 1; COMMIT;"),
        "MIGRATION_ROLE_SWITCH",
      ),
    },
    {
      name: "unreviewed_prerequisite_file",
      passed: onlyError(
        syntheticMigrationErrors([{}], { [examplePrerequisite]: syntheticSql }),
        "UNREVIEWED_PREREQUISITE_FILE",
      ),
    },
  ];
  writeArtifact("verify/delivery.json", {
    generated_at: new Date().toISOString(),
    scope:
      "Known-pattern secret guard, dependency locking (bundles bound to integrity-checked parent tarballs), migration metadata/checksum/envelope, the single-transaction runner contract (no inner transaction control, role or session switch or psql meta-command) and executeAs/pinned-prerequisite metadata (every infra/*-prerequisites.sql named by exactly one row) only; not complete secret assurance or PostgreSQL execution. Hosted CI evidenced separately; release protection pending.",
    scanned_files: paths.length,
    dependency_records: Object.keys(lock.packages).length,
    migrations: manifest.migrations.length,
    prerequisites: manifest.migrations.flatMap((row) => row.prerequisites ?? []).length,
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
