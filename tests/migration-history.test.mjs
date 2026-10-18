import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Applied migrations are immutable. This frozen list pins every published migration
// independently of migrations/manifest.json, so a coordinated edit of a migration file
// and its manifest row still fails. Append a row here when a new migration is published.
const published = [
  [
    1,
    "0001.identity-foundation.sql",
    "09e047173c39bff3d4ce1d0e16efeff3f423848f40e2c2e012ae6aa620d52491",
  ],
  [
    2,
    "0002.identity-grants.sql",
    "0d7561075037d354980a33ddd005688f5e73597011c5423f54c9ca9164f871a7",
  ],
  [
    3,
    "0003.authentication-challenges.sql",
    "72acd69951b379bf1af2ac7731a6d00b3b8b674c00aa7ded49e49a3f1571c83f",
  ],
  [
    4,
    "0004.workspace-access-revocation.sql",
    "19f0d6e09079540020992c054719fe7e5c461c6e4e4b07d431e29d8274e8e038",
  ],
  [
    5,
    "0005.workspace-store-linking.sql",
    "e42e91b7cbb2de9c59591346212fb250aed0c8cdba6edb6bd787dcceda78de92",
  ],
  [
    6,
    "0006.authentication-exchange-admission.sql",
    "1f67f961c778ec6c67b9050b7c6290fe8a3c0072f1bc8126e974ee243fae6d87",
  ],
  [
    7,
    "0007.provider-subject-resolution.sql",
    "f176659d8b9eac84df4f4f427949f3edd2b878091c94e8b1918e6d5f41e4e103",
  ],
  [
    8,
    "0008.browser-session-admission.sql",
    "a4325cb7bf8b90fc0084f95de2e1317c344e3b6187ccd91f3a431cacb1243fa0",
  ],
  [
    9,
    "0009.workspace-linking-read-boundaries.sql",
    "9ab7fbaba7629c88034b1002b880601c322b405396e8fa824a585b6a2e9f37a2",
  ],
  [
    10,
    "0010.login-flow-custody.sql",
    "51c6d7ca9e31a897352c4a8b2e85824eb4a7b58506629246bce63c9d92070475",
  ],
  [
    11,
    "0011.self-browser-family-logout.sql",
    "089ff5487030df8f085045f37f523522540759752b7fde25abf91629396f28c4",
  ],
  [
    12,
    "0012.login-protocol-v1.sql",
    "52e9f699956ec8932056b22b2dc5294e540225562730666e0a87d00dfe857579",
  ],
].map(([sequence, file, sha256]) => ({ sequence, file, sha256 }));
// From now on administrator prerequisites are frozen like migrations (P03.T04e §3.1): each
// published row keeps exactly these pinned files, and a later role goes in a new file on its
// new row. The pins are the bytes as they stand, not each row's original setup: before this
// rule, the roles of migrations 0004-0008 (lifecycle, linking, preauth, resolution, sessions)
// were appended to row 1's file next to their migrations. Row 1's file is therefore
// cumulative and valid only on a fresh database, applied before row 1; applying
// prerequisites row by row to a database already past row 1 is unsupported (input to P04.T01i).
const publishedPrerequisites = new Map([
  [
    1,
    [
      {
        file: "infra/identity-role-prerequisites.sql",
        sha256: "25bc4de4b968ef51b696a0f9e85c8f482bfa6f4ad1b77114a865d210969ee581",
      },
    ],
  ],
  [
    10,
    [
      {
        file: "infra/identity-login-role-prerequisites.sql",
        sha256: "17c25b456d85d6b0a70fe312be885f4543339da9ebaf04122b585ccc2d4c541b",
      },
    ],
  ],
  [
    11,
    [
      {
        file: "infra/identity-logout-role-prerequisites.sql",
        sha256: "1eb98c94b51d4d2b1c2580fc402234110536ae6a84c185116676766460a0193d",
      },
    ],
  ],
]);
// Every published migration was applied under this role.
const publishedExecuteAs = "morrow_identity_owner";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));

test("the manifest keeps every published migration as an unchanged prefix", () => {
  assert.ok(manifest.migrations.length >= published.length);
  for (const [index, row] of published.entries()) {
    const { sequence, file, sha256 } = manifest.migrations[index];
    assert.deepEqual({ sequence, file, sha256 }, row);
  }
});

test("every published migration file still hashes to its pinned digest", () => {
  for (const row of published)
    assert.equal(sha(readFileSync("migrations/" + row.file)), row.sha256, row.file);
});

test("published rows keep their executeAs role and pinned prerequisites", () => {
  for (const [index, row] of published.entries()) {
    const { executeAs, prerequisites } = manifest.migrations[index];
    assert.equal(executeAs, publishedExecuteAs, row.file);
    assert.deepEqual(prerequisites, publishedPrerequisites.get(row.sequence), row.file);
  }
});

test("every published prerequisite file still hashes to its pinned digest", () => {
  const pinned = [...publishedPrerequisites.values()].flat();
  assert.equal(pinned.length, 3);
  for (const { file, sha256 } of pinned) assert.equal(sha(readFileSync(file)), sha256, file);
});

test("migrations after the published prefix continue the sequence", () => {
  for (const [index, row] of manifest.migrations.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.file.startsWith(String(index + 1).padStart(4, "0") + "."), true);
  }
});
