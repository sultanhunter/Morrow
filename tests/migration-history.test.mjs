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
  [
    13,
    "0013.account-onboarding.sql",
    "df215e288e6dda31fb62cb70b86354507d054a6e9f1df481891a4a5552e5d763",
  ],
  [
    14,
    "0014.work-identity-bridge.sql",
    "efd6112f419df1b5270b5a7a308f00816cfc14900a7c28b6e25ae56aa38b5201",
  ],
  [15, "0015.work-state.sql", "06b0457b93a211866d981ade631f29618f34ff58f6bba309008886e1cfbdcfd9"],
  [
    16,
    "0016.browser-session-lifecycle.sql",
    "ac947dd48f0bd5d802ebd85bf5e610cafa50809458988e8c25aa7157b12d64c8",
  ],
].map(([sequence, file, sha256]) => ({ sequence, file, sha256 }));
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

// The manifest is append-only: published rows are an unchanged, index-aligned
// prefix (above) and every row continues the sequence with no gap, so a new
// migration can never be inserted ahead of a published one.
test("migrations after the published prefix continue the sequence", () => {
  for (const [index, row] of manifest.migrations.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.file.startsWith(String(index + 1).padStart(4, "0") + "."), true);
  }
});
