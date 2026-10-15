import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const hash = (v) => createHash("sha256").update(v).digest("hex");
test("linking read migration appends to the exact published eight-migration manifest", () => {
  const current = JSON.parse(read("migrations/manifest.json"));
  const previous = JSON.parse(
    read("docs/history/workos-authentication-operator-82/migrations/manifest.json"),
  );
  assert.equal(current.migrations.length, 9);
  assert.deepEqual(current.migrations.slice(0, 8), previous.migrations);
  for (const m of current.migrations) assert.equal(hash(read("migrations/" + m.file)), m.sha256);
  assert.equal(current.migrations[8].sequence, 9);
  assert.equal(current.migrations[8].reviewRef, "docs/evidence/P05.T03b/review.json");
});
test("new lookup and status add no table or mutation and keep private helper ungranted", () => {
  const sql = read("migrations/0009.workspace-linking-read-boundaries.sql");
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE TABLE)\b/);
  assert.match(sql, /REVOKE ALL ON FUNCTION morrow_identity\.bound_workspace_linking_handoff/);
  assert.match(sql, /TO morrow_identity_linking;/);
  assert.doesNotMatch(sql, /GRANT[^;]*TO (?:PUBLIC|morrow_api)\b/);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
});
