import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const priorDigests = [
  "09e047173c39bff3d4ce1d0e16efeff3f423848f40e2c2e012ae6aa620d52491",
  "0d7561075037d354980a33ddd005688f5e73597011c5423f54c9ca9164f871a7",
  "72acd69951b379bf1af2ac7731a6d00b3b8b674c00aa7ded49e49a3f1571c83f",
  "19f0d6e09079540020992c054719fe7e5c461c6e4e4b07d431e29d8274e8e038",
  "e42e91b7cbb2de9c59591346212fb250aed0c8cdba6edb6bd787dcceda78de92",
  "1f67f961c778ec6c67b9050b7c6290fe8a3c0072f1bc8126e974ee243fae6d87",
];
test("provider selection appends migration7 without changing historical migration bytes", () => {
  assert.equal(manifest.migrations.slice(0, 7).length, 7);
  for (let n = 0; n < 6; n++) {
    const m = manifest.migrations[n];
    assert.equal(m.sequence, n + 1);
    assert.equal(m.sha256, priorDigests[n]);
    assert.equal(hash(readFileSync("migrations/" + m.file)), priorDigests[n]);
  }
  const current = manifest.migrations[6];
  assert.equal(current.sequence, 7);
  assert.equal(current.file, "0007.provider-subject-resolution.sql");
  assert.equal(current.reviewRef, "docs/evidence/P05.T01j/review.json");
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
test("frozen token, status and composition implementations remain exact", () => {
  for (const [path, digest] of [
    [
      "packages/identity/src/workos-session-token.ts",
      "198228864379483a4bdcd7fbba5982c429a20def7f189f66b2f1c8efb9ce7966",
    ],
    [
      "docs/history/workos-session-status-75/packages/identity/src/workos-session-status.ts",
      "1c6d48b633354e2c7059439dd920591787aadd8b3afae8b88610bf803b9dd579",
    ],
    [
      "packages/identity/src/workos-session-status-json.ts",
      "9b18639cca3a0ff7d2743171f1afbc605801b0b272622dccb934f4775ead48cb",
    ],
    [
      "packages/identity/src/workos-authentication-evidence.ts",
      "5c83d68b63474f85e6121bbbb55540280e742c66022fa9c481e37305a0568b90",
    ],
  ])
    assert.equal(hash(readFileSync(path)), digest, path);
});
