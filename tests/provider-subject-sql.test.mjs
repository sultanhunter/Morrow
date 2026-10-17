import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Published-migration immutability (including migrations 1-6) is pinned in
// tests/migration-history.test.mjs.
test("provider selection is migration7 and its manifest digest matches the file", () => {
  const current = manifest.migrations[6];
  assert.equal(current.sequence, 7);
  assert.equal(current.file, "0007.provider-subject-resolution.sql");
  assert.equal(current.sha256, hash(readFileSync("migrations/" + current.file)));
});
test("new SQL privilege footprint does not grant schema maintenance or table reads to resolver", () => {
  const source = readFileSync("migrations/0007.provider-subject-resolution.sql", "utf8");
  const grants = source.split("\n").filter((line) => /^GRANT /.test(line));
  assert.deepEqual(grants, [
    "GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_resolution;",
    "GRANT EXECUTE ON FUNCTION morrow_identity.resolve_provider_subject_selection(text,text,text,text,text,text,text,text,text) TO morrow_identity_resolution;",
  ]);
  assert.match(source, /^BEGIN;[\s\S]+COMMIT;\s*$/);
  assert.doesNotMatch(
    source,
    /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*morrow_identity\.(?:sessions|grants)\b/i,
  );
});
test("preparation creates only a non-login disposable-resolution role without membership grants", () => {
  const source = readFileSync("infra/identity-role-prerequisites.sql", "utf8");
  const declaration = source
    .split("\n")
    .filter((line) => /^CREATE ROLE morrow_identity_resolution /.test(line));
  assert.deepEqual(declaration, [
    "CREATE ROLE morrow_identity_resolution NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;",
  ]);
  assert.doesNotMatch(source, /^GRANT morrow_identity_(?:resolution|owner)\b/m);
});
