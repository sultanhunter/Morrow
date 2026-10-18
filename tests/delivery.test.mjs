import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  inspectSecrets,
  inspectMigrations,
  lockedBundleAncestor,
} from "../scripts/delivery-checks.mjs";
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
      executeAs: "morrow_identity_owner",
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
// P03.T04e §3.1: every row names its executeAs role; administrator prerequisites are
// pinned by path and SHA-256, one row per file.
const prerequisiteSql = "CREATE ROLE morrow_example NOLOGIN;";
const prerequisite = {
  file: "infra/example-role-prerequisites.sql",
  sha256: createHash("sha256").update(prerequisiteSql).digest("hex"),
};
const withRows = (...rows) => ({
  ...manifest,
  migrations: rows.map((row, index) => ({
    ...manifest.migrations[0],
    sequence: index + 1,
    file: `000${index + 1}.example.sql`,
    ...row,
  })),
});
const rowFiles = (count) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`000${i + 1}.example.sql`, sql]));
const prerequisiteBytes = { [prerequisite.file]: prerequisiteSql };
test("executeAs and pinned prerequisites are accepted as text or bytes", () => {
  assert.deepEqual(
    inspectMigrations(
      withRows({ prerequisites: [prerequisite] }, {}),
      rowFiles(2),
      prerequisiteBytes,
    ),
    [],
  );
  assert.deepEqual(
    inspectMigrations(withRows({ prerequisites: [prerequisite] }), rowFiles(1), {
      [prerequisite.file]: Buffer.from(prerequisiteSql),
    }),
    [],
  );
  const fixture = { ...prerequisite, file: "tests/fixtures/pg-harness/example-prerequisites.sql" };
  assert.deepEqual(
    inspectMigrations(
      withRows({ prerequisites: [fixture] }),
      rowFiles(1),
      { [fixture.file]: prerequisiteSql },
      { prerequisiteDirectory: "tests/fixtures/pg-harness" },
    ),
    [],
  );
});
test("a missing or malformed executeAs denies", () => {
  for (const executeAs of [
    undefined,
    null,
    "",
    "postgres",
    "morrow_",
    "morrow_Owner",
    "morrow_1owner",
    "morrow_identity-owner",
    "morrow_" + "a".repeat(49),
    ["morrow_identity_owner"],
  ])
    assert.deepEqual(
      inspectMigrations(withRows({ executeAs }), rowFiles(1)),
      ["INVALID_EXECUTE_AS"],
      String(executeAs),
    );
  assert.deepEqual(
    inspectMigrations(withRows({ executeAs: "morrow_" + "a".repeat(48) }), rowFiles(1)),
    [],
  );
});
test("a prerequisite outside its directory, malformed or without bytes denies", () => {
  for (const prerequisites of [
    [],
    {},
    "infra/example-role-prerequisites.sql",
    [prerequisite.file],
    [null],
    [{ file: prerequisite.file }],
    [{ ...prerequisite, file: "scripts/example-role-prerequisites.sql" }],
    [{ ...prerequisite, file: "infra/../infra/example-role-prerequisites.sql" }],
    [{ ...prerequisite, file: "infra/sub/example-role-prerequisites.sql" }],
    [{ ...prerequisite, file: "infra/example-role.sql" }],
    [{ ...prerequisite, file: "infra/Example-role-prerequisites.sql" }],
    [{ ...prerequisite, file: "infra/other-role-prerequisites.sql" }],
  ])
    assert.deepEqual(
      inspectMigrations(withRows({ prerequisites }), rowFiles(1), prerequisiteBytes),
      ["INVALID_PREREQUISITE"],
      JSON.stringify(prerequisites),
    );
  assert.deepEqual(
    inspectMigrations(withRows({ prerequisites: [prerequisite] }), rowFiles(1), {
      [prerequisite.file]: undefined,
    }),
    ["INVALID_PREREQUISITE"],
  );
  // The default directory is infra/; a fixture directory must be named explicitly.
  const fixture = { ...prerequisite, file: "tests/fixtures/pg-harness/example-prerequisites.sql" };
  assert.deepEqual(
    inspectMigrations(withRows({ prerequisites: [fixture] }), rowFiles(1), {
      [fixture.file]: prerequisiteSql,
    }),
    ["INVALID_PREREQUISITE"],
  );
});
test("changed prerequisite bytes deny", () =>
  assert.deepEqual(
    inspectMigrations(withRows({ prerequisites: [prerequisite] }), rowFiles(1), {
      [prerequisite.file]: prerequisiteSql + " ",
    }),
    ["PREREQUISITE_CHECKSUM"],
  ));
test("a prerequisite file on two rows, or twice on one row, denies", () => {
  assert.deepEqual(
    inspectMigrations(
      withRows({ prerequisites: [prerequisite] }, { prerequisites: [prerequisite] }),
      rowFiles(2),
      prerequisiteBytes,
    ),
    ["DUPLICATE_PREREQUISITE"],
  );
  assert.deepEqual(
    inspectMigrations(
      withRows({ prerequisites: [prerequisite, prerequisite] }),
      rowFiles(1),
      prerequisiteBytes,
    ),
    ["DUPLICATE_PREREQUISITE"],
  );
});
test("the repository manifest passes with its prerequisite files", () => {
  const repositoryManifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  const migrationSql = Object.fromEntries(
    readdirSync("migrations")
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync("migrations/" + name, "utf8")]),
  );
  const infra = Object.fromEntries(
    readdirSync("infra")
      .filter((name) => name.endsWith("-prerequisites.sql"))
      .map((name) => ["infra/" + name, readFileSync("infra/" + name)]),
  );
  assert.deepEqual(inspectMigrations(repositoryManifest, migrationSql, infra), []);
  assert.deepEqual(inspectMigrations(repositoryManifest, migrationSql), ["INVALID_PREREQUISITE"]);
});
test("bundle integrity requires an integrity-checked registry ancestor", () => {
  const path = "node_modules/example/node_modules/embedded";
  const bundled = { [path]: { inBundle: true } };
  assert.equal(lockedBundleAncestor(path, bundled), false);
  assert.equal(
    lockedBundleAncestor(path, {
      ...bundled,
      "node_modules/example": {
        integrity: "sha512-example",
        resolved: "https://registry.npmjs.org/example.tgz",
      },
    }),
    true,
  );
  assert.equal(
    lockedBundleAncestor(path, {
      ...bundled,
      "node_modules/example": {
        integrity: "sha512-example",
        resolved: "https://untrusted.invalid/example.tgz",
      },
    }),
    false,
  );
});
