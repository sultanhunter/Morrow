import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectSecrets, inspectMigrations } from "../scripts/delivery-checks.mjs";
for (const [name, text] of [
  ["openai", "sk-proj-" + "A".repeat(50)],
  ["github", "ghp_" + "B".repeat(40)],
  ["aws", "AKIA" + "C".repeat(16)],
  ["private", "-----BEGIN " + "PRIVATE KEY-----"],
  ["literal", 'client_secret = "' + "D".repeat(24) + '"'],
])
  test("fixture secret denies: " + name, () => assert.ok(inspectSecrets(text).length));
test("reference/digest does not masquerade as credential", () =>
  assert.deepEqual(inspectSecrets("credentialRef: account-main; digest: " + "a".repeat(64)), []));
const file = "0001.example.sql",
  sql = "BEGIN; SELECT 1; COMMIT;";
const manifest = {
  schema_version: 1,
  engine: "postgresql17",
  migrations: [
    {
      sequence: 1,
      file,
      sha256: createHash("sha256").update(sql).digest("hex"),
      reviewRef: "synthetic-review",
    },
  ],
};
test("reviewed unchanged migration envelope allowed by metadata gate", () =>
  assert.deepEqual(inspectMigrations(manifest, { [file]: sql }), []));
test("broken checksum denies changed SQL", () =>
  assert.ok(inspectMigrations(manifest, { [file]: sql + " " }).includes("MIGRATION_CHECKSUM")));
test("unlisted migration denies", () =>
  assert.ok(
    inspectMigrations({ ...manifest, migrations: [] }, { [file]: sql }).includes(
      "UNREVIEWED_MIGRATION_FILE",
    ),
  ));
test("non-transactional migration needs separate reviewed path", () =>
  assert.ok(
    inspectMigrations(manifest, { [file]: "SELECT 1;" }).includes("MIGRATION_TRANSACTION_ENVELOPE"),
  ));
test("reordered migrations deny", () =>
  assert.ok(
    inspectMigrations(
      { ...manifest, migrations: [...manifest.migrations, ...manifest.migrations] },
      { [file]: sql },
    ).includes("INVALID_MIGRATION_RECORD"),
  ));
