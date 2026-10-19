import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migrationSqlViolations, scanSqlScript } from "../scripts/migration-sql.mjs";
import { d4Transaction, migrationBody } from "../scripts/fixtures/createrole-administrator.mjs";

// ADR-0020 item 5 (P04.T01j D4): the runner wraps each manifest entry in one transaction
// that grants and revokes its own SET row. A file that ends, restarts or leaves that
// transaction early, or switches role, breaks the contract before anything is applied.
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const entry = (text) => ({ executeAs: "morrow_identity_owner", text });

test("every manifest migration is one transaction with no role switch", () => {
  for (const row of manifest.migrations) {
    const text = readFileSync("migrations/" + row.file, "utf8");
    assert.deepEqual(migrationSqlViolations(text), [], row.file);
    const { statements } = scanSqlScript(text);
    assert.equal(statements[0], "BEGIN", row.file);
    assert.equal(statements.at(-1), "COMMIT", row.file);
    assert.ok(migrationBody({ ...row, text }).length > 0, row.file);
  }
});

test("routine bodies, BEGIN ATOMIC, comments and strings do not split statements", () => {
  const text =
    "BEGIN;\n-- COMMIT; SET ROLE x; \\c\n/* ROLLBACK; /* nested */ RESET ROLE */\n" +
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $f$\nBEGIN\n BEGIN\n  PERFORM 1;\n END;\n -- SET ROLE in a comment\nEND $f$;\n" +
    "CREATE OR REPLACE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END; SELECT 3; END;\n" +
    "SELECT 'a\\_b;', E'it\\'s;', \"semi;colon\", (1);\nCOMMIT;\n";
  assert.deepEqual(migrationSqlViolations(text), []);
  assert.equal(scanSqlScript(text).statements.length, 5);
});

for (const [name, text, code] of [
  [
    "an inner COMMIT",
    "BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;\n",
    "MIGRATION_TRANSACTION_CONTROL",
  ],
  ["a ROLLBACK", "BEGIN;\nSELECT 1;\n  rollback ;\nCOMMIT;\n", "MIGRATION_TRANSACTION_CONTROL"],
  ["a SAVEPOINT", "BEGIN;\nSAVEPOINT a;\nCOMMIT;\n", "MIGRATION_TRANSACTION_CONTROL"],
  ["an END", "BEGIN;\nEND;\nCOMMIT;\n", "MIGRATION_TRANSACTION_CONTROL"],
  ["a START TRANSACTION", "BEGIN;\nSTART TRANSACTION;\nCOMMIT;\n", "MIGRATION_TRANSACTION_CONTROL"],
  ["a RESET ROLE", "BEGIN;\nRESET ROLE;\nSELECT 1;\nCOMMIT;\n", "MIGRATION_ROLE_SWITCH"],
  ["a SET LOCAL ROLE", "BEGIN;\nset local role neondb_owner;\nCOMMIT;\n", "MIGRATION_ROLE_SWITCH"],
  ["a SET role =", "BEGIN;\nSET role = neondb_owner;\nCOMMIT;\n", "MIGRATION_ROLE_SWITCH"],
  [
    "a SESSION AUTHORIZATION",
    "BEGIN;\nSET SESSION AUTHORIZATION postgres;\nCOMMIT;\n",
    "MIGRATION_ROLE_SWITCH",
  ],
  [
    "a role switch in a DO body",
    "BEGIN;\nDO $$ BEGIN SET LOCAL ROLE neondb_owner; END $$;\nCOMMIT;\n",
    "MIGRATION_ROLE_SWITCH",
  ],
  [
    "set_config('role')",
    "BEGIN;\nSELECT set_config( 'role','neondb_owner',true);\nCOMMIT;\n",
    "MIGRATION_ROLE_SWITCH",
  ],
  [
    "an EXECUTEd RESET ROLE",
    "BEGIN;\nDO $$ BEGIN EXECUTE 'RESET ROLE'; END $$;\nCOMMIT;\n",
    "MIGRATION_ROLE_SWITCH",
  ],
  [
    "a psql reconnect",
    "BEGIN;\n\\c - neondb_owner\nSELECT 1;\nCOMMIT;\n",
    "MIGRATION_PSQL_META_COMMAND",
  ],
  ["no BEGIN", "SELECT 1;\nCOMMIT;\n", "MIGRATION_TRANSACTION_ENVELOPE"],
  ["an unterminated string", "BEGIN;\nSELECT 'a;\nCOMMIT;\n", "MIGRATION_SQL_UNTERMINATED"],
  [
    "an unterminated body",
    "BEGIN;\nDO $$ BEGIN NULL; END;\nCOMMIT;\n",
    "MIGRATION_SQL_UNTERMINATED",
  ],
])
  test(`the runner contract refuses ${name}`, () => {
    assert.ok(
      migrationSqlViolations(text).includes(code),
      JSON.stringify(migrationSqlViolations(text)),
    );
    assert.throws(() => migrationBody(entry(text)), /CREATEROLE_FIXTURE_FRAMING/);
    assert.throws(() => d4Transaction(entry(text)), /CREATEROLE_FIXTURE_FRAMING/);
  });

test("the D4 transaction keeps the body between its own grant and revoke", () => {
  const text = "BEGIN;\nSELECT 1;\nCOMMIT;\n";
  assert.equal(
    d4Transaction(entry(text)),
    "BEGIN;\nGRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\nSET LOCAL ROLE morrow_identity_owner;\nSELECT 1;\nRESET ROLE;\nREVOKE morrow_identity_owner FROM neondb_owner GRANTED BY neondb_owner;\nCOMMIT;\n",
  );
});
