// M2 PR-1 vault (ADR-0022 item 7; M2 brief test checklist "Vault"): the broker's
// AES-256-GCM envelopes with fakes only. The PostgreSQL round trip through
// app_secret_put and app_secret_get (as morrow_vault_broker) is lab:spine-foundation V.
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import {
  VaultError,
  createVaultKeyring,
  openVaultRecord,
  readAppSecret,
  sealVaultRecord,
  vaultAdditionalData,
  vaultBytesHex,
  vaultLimits,
  vaultStatements,
} from "../apps/broker/src/vault.ts";

const kek = () => randomBytes(32).toString("hex");
const app = (appKey = "beta-store-1", version = 1) => ({
  kind: "app_secret",
  appKey,
  provider: "shopify",
  version,
});
const token = (change = {}) => ({
  kind: "shopify_offline_token",
  organizationId: "org_1",
  workspaceId: "ws_1",
  credentialId: "credential_1",
  subjectId: "installation_1",
  provider: "shopify",
  version: 1,
  ...change,
});
const text = (value) => new TextEncoder().encode(value);
const read = (value) => new TextDecoder().decode(value);
async function code(pending) {
  try {
    await pending;
  } catch (error) {
    assert.ok(error instanceof VaultError);
    assert.equal(error.message, error.code);
    return error.code;
  }
  assert.fail("expected a VaultError");
}
// Every console method is captured while the vault runs: it must log nothing at all.
const logged = [];
const originals = {};
for (const name of ["log", "info", "warn", "error", "debug"]) {
  originals[name] = console[name];
  console[name] = (...args) => logged.push(args.map(String).join(" "));
}
test.after(() => Object.assign(console, originals));

test("round trip: an app secret and an offline token open only as sealed", async () => {
  const keyring = await createVaultKeyring("staging", new Map([[1, kek()]]));
  assert.deepEqual([keyring.environment, keyring.sealingKekVersion], ["staging", 1]);
  assert.deepEqual(Object.keys(keyring).sort(), [
    "environment",
    "kekVersions",
    "sealingKekVersion",
  ]);
  for (const ref of [app(), token()]) {
    const secret = "shpss_" + randomBytes(16).toString("hex");
    const envelope = await sealVaultRecord(keyring, ref, text(secret));
    assert.equal(envelope.kekVersion, 1);
    assert.equal(envelope.wrappedKey.length, 60);
    assert.equal(envelope.sealedValue.length, 12 + secret.length + 16);
    assert.ok(!Buffer.from(envelope.sealedValue).includes(Buffer.from(secret)));
    assert.equal(read(await openVaultRecord(keyring, ref, envelope)), secret);
    // Two seals of one value differ (fresh data key and IVs every time).
    const again = await sealVaultRecord(keyring, ref, text(secret));
    assert.notEqual(vaultBytesHex(again.sealedValue), vaultBytesHex(envelope.sealedValue));
    assert.notEqual(vaultBytesHex(again.wrappedKey), vaultBytesHex(envelope.wrappedKey));
  }
});

test("the stored format is IV, ciphertext and tag under the documented additional data", async () => {
  const secret = kek();
  const keyring = await createVaultKeyring("development", new Map([[1, secret]]));
  const envelope = await sealVaultRecord(keyring, app(), text("client-secret"));
  const open = (key, sealed, aad) => {
    const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
  };
  const aad = (purpose) =>
    Buffer.from(
      JSON.stringify([
        "morrow.vault.v1",
        purpose,
        "development",
        "app_secret",
        null,
        null,
        "beta-store-1",
        null,
        "shopify",
        1,
        1,
      ]),
    );
  assert.deepEqual(Buffer.from(vaultAdditionalData("development", app(), 1, "wrap")), aad("wrap"));
  const dataKey = open(Buffer.from(secret, "hex"), Buffer.from(envelope.wrappedKey), aad("wrap"));
  assert.equal(dataKey.length, 32);
  assert.equal(
    open(dataKey, Buffer.from(envelope.sealedValue), aad("seal")).toString(),
    "client-secret",
  );
  // A tenant record names its tenant, credential and subject.
  assert.equal(
    new TextDecoder().decode(vaultAdditionalData("staging", token(), 2, "seal")),
    JSON.stringify([
      "morrow.vault.v1",
      "seal",
      "staging",
      "shopify_offline_token",
      "org_1",
      "ws_1",
      "credential_1",
      "installation_1",
      "shopify",
      1,
      2,
    ]),
  );
});

test("wrong additional data, KEK, KEK version or environment fails with one fixed code", async () => {
  const secret = kek();
  const keyring = await createVaultKeyring("staging", new Map([[1, secret]]));
  const ref = token();
  const envelope = await sealVaultRecord(keyring, ref, text("offline-token"));
  const fails = async (k, r, e = envelope) => code(openVaultRecord(k, r, e));
  // Every field of the additional data is bound.
  for (const change of [
    { organizationId: "org_2" },
    { workspaceId: "ws_2" },
    { credentialId: "credential_2" },
    { subjectId: "installation_2" },
    { version: 2 },
  ])
    assert.equal(await fails(keyring, token(change)), "VAULT_OPEN_FAILED");
  assert.equal(await fails(keyring, app("credential-1")), "VAULT_OPEN_FAILED");
  // The same KEK in another environment, and another KEK in this one.
  for (const environment of ["development", "production"])
    assert.equal(
      await fails(await createVaultKeyring(environment, new Map([[1, secret]])), ref),
      "VAULT_OPEN_FAILED",
    );
  assert.equal(
    await fails(await createVaultKeyring("staging", new Map([[1, kek()]])), ref),
    "VAULT_OPEN_FAILED",
  );
  // A row claiming another KEK version: unknown to this keyring, or held but wrong.
  assert.equal(await fails(keyring, ref, { ...envelope, kekVersion: 2 }), "VAULT_KEK_UNAVAILABLE");
  const both = await createVaultKeyring(
    "staging",
    new Map([
      [1, secret],
      [2, secret],
    ]),
  );
  assert.equal(await fails(both, ref, { ...envelope, kekVersion: 2 }), "VAULT_OPEN_FAILED");
  // Any changed byte, and swapping the wrapped key or the sealed value between records.
  for (const field of ["wrappedKey", "sealedValue"])
    for (const at of [0, 12, envelope[field].length - 1]) {
      const changed = Uint8Array.from(envelope[field]);
      changed[at] ^= 1;
      assert.equal(
        await fails(keyring, ref, { ...envelope, [field]: changed }),
        "VAULT_OPEN_FAILED",
      );
    }
  const other = await sealVaultRecord(keyring, ref, text("offline-token"));
  assert.equal(
    await fails(keyring, ref, { ...envelope, wrappedKey: other.wrappedKey }),
    "VAULT_OPEN_FAILED",
  );
  // The wrap and seal purposes are distinct: a sealed value never opens as a key.
  const swapped = await sealVaultRecord(keyring, ref, randomBytes(32));
  assert.equal(
    await fails(keyring, ref, { ...swapped, wrappedKey: swapped.sealedValue }),
    "VAULT_OPEN_FAILED",
  );
  // A hand-built keyring holds no key.
  assert.equal(
    await fails({ environment: "staging", sealingKekVersion: 1, kekVersions: [1] }, ref),
    "VAULT_KEK_UNAVAILABLE",
  );
});

test("KEK rotation: new seals use the newest KEK; older rows still open while it is held", async () => {
  const first = kek(),
    second = kek();
  const before = await createVaultKeyring("staging", new Map([[1, first]]));
  const old = await sealVaultRecord(before, app(), text("v1-secret"));
  const during = await createVaultKeyring(
    "staging",
    new Map([
      [2, second],
      [1, first],
    ]),
  );
  assert.deepEqual([during.sealingKekVersion, during.kekVersions], [2, [1, 2]]);
  assert.equal(read(await openVaultRecord(during, app(), old)), "v1-secret");
  const fresh = await sealVaultRecord(during, app("beta-store-1", 2), text("v2-secret"));
  assert.equal(fresh.kekVersion, 2);
  const after = await createVaultKeyring("staging", new Map([[2, second]]));
  assert.equal(read(await openVaultRecord(after, app("beta-store-1", 2), fresh)), "v2-secret");
  assert.equal(await code(openVaultRecord(after, app(), old)), "VAULT_KEK_UNAVAILABLE");
});

test("size and shape limits follow the 0020 constraints", async () => {
  const keyring = await createVaultKeyring("development", new Map([[1, kek()]]));
  const smallest = await sealVaultRecord(keyring, app(), new Uint8Array(1));
  const largest = await sealVaultRecord(keyring, app(), new Uint8Array(4096));
  assert.deepEqual(
    [smallest.sealedValue.length, largest.sealedValue.length],
    [vaultLimits.sealedMinBytes, vaultLimits.sealedMaxBytes],
  );
  for (const plaintext of [new Uint8Array(0), new Uint8Array(4097), "text", null])
    assert.equal(await code(sealVaultRecord(keyring, app(), plaintext)), "VAULT_INPUT_INVALID");
  for (const ref of [
    app("AB"),
    app("x"),
    app("beta-store-1", 0),
    app("beta-store-1", 1.5),
    { ...app(), provider: "stripe" },
    { ...app(), extra: 1 },
    token({ organizationId: "" }),
    token({ subjectId: "a b" }),
    token({ kind: "app_secret" }),
    null,
  ])
    assert.equal(await code(sealVaultRecord(keyring, ref, text("x"))), "VAULT_INPUT_INVALID");
  const envelope = await sealVaultRecord(keyring, app(), text("x"));
  for (const broken of [
    { ...envelope, wrappedKey: envelope.wrappedKey.subarray(1) },
    { ...envelope, sealedValue: envelope.sealedValue.subarray(0, 28) },
    { ...envelope, sealedValue: new Uint8Array(4125) },
    { ...envelope, kekVersion: 0 },
    { ...envelope, kekVersion: 1000 },
    null,
  ])
    assert.equal(await code(openVaultRecord(keyring, app(), broken)), "VAULT_RECORD_INVALID");
  // Keyrings: a known environment, 1-8 versions of exactly 64 lowercase hex characters.
  for (const [environment, keks] of [
    ["test", new Map([[1, kek()]])],
    ["staging", new Map()],
    ["staging", new Map([[0, kek()]])],
    ["staging", new Map([[1000, kek()]])],
    ["staging", new Map([[1, kek().toUpperCase()]])],
    ["staging", new Map([[1, kek() + "00"]])],
    ["staging", new Map([[1, 42]])],
    ["staging", { size: 1 }],
  ])
    assert.equal(await code(createVaultKeyring(environment, keks)), "VAULT_KEK_UNAVAILABLE");
});

test("readAppSecret: the one fixed statement, closed rows, and rotating one app leaves others", async () => {
  const keyring = await createVaultKeyring("staging", new Map([[1, kek()]]));
  // A fake morrow_vault.app_secret_get: the active envelope per app key, as hex.
  const table = new Map();
  const put = async (appKey, secret) => {
    const version = (table.get(appKey)?.version ?? 0) + 1;
    const e = await sealVaultRecord(keyring, app(appKey, version), text(secret));
    table.set(appKey, {
      version,
      kek_version: String(e.kekVersion),
      wrapped_key: vaultBytesHex(e.wrappedKey),
      sealed_value: vaultBytesHex(e.sealedValue),
    });
  };
  const sent = [];
  const query = async (statement, values) => {
    sent.push([statement, values]);
    const row = table.get(values[0]);
    return row
      ? [{ outcome: "found", ...row, version: String(row.version) }]
      : [
          {
            outcome: "not_found",
            version: null,
            kek_version: null,
            wrapped_key: null,
            sealed_value: null,
          },
        ];
  };
  await put("beta-store-1", "secret-a1");
  await put("beta-store-2", "secret-b1");
  await put("beta-store-1", "secret-a2");
  assert.deepEqual(await readAppSecret(keyring, query, "beta-store-1"), {
    outcome: "found",
    version: 2,
    secret: "secret-a2",
  });
  assert.deepEqual(await readAppSecret(keyring, query, "beta-store-2"), {
    outcome: "found",
    version: 1,
    secret: "secret-b1",
  });
  assert.deepEqual(await readAppSecret(keyring, query, "absent-app"), { outcome: "not_found" });
  assert.ok(sent.every(([statement]) => statement === vaultStatements.appSecretGet));
  assert.equal(
    vaultStatements.appSecretGet,
    "SELECT outcome,version,kek_version,wrapped_key,sealed_value FROM morrow_vault.app_secret_get($1)",
  );
  // A row that claims another version than the one sealed does not open.
  const stale = { ...table.get("beta-store-2"), version: 2 };
  table.set("beta-store-2", stale);
  assert.equal(await code(readAppSecret(keyring, query, "beta-store-2")), "VAULT_OPEN_FAILED");
  // Denied, invalid, extra or missing columns, two rows and bad hex are never answers.
  const rows = (value) => async () => value;
  const found = { outcome: "found", ...table.get("beta-store-1"), version: "2" };
  for (const reply of [
    [{ ...found, outcome: "denied" }],
    [{ ...found, outcome: "invalid" }],
    [{ ...found, extra: "x" }],
    [{ outcome: "found", version: "2" }],
    [found, found],
    [],
    [{ ...found, wrapped_key: found.wrapped_key.toUpperCase() }],
    [{ ...found, sealed_value: "zz" }],
    [{ ...found, version: "02" }],
    [{ ...found, kek_version: "1000" }],
  ])
    assert.equal(
      await code(readAppSecret(keyring, rows(reply), "beta-store-1")),
      "VAULT_RECORD_INVALID",
    );
  for (const key of ["", "A", "a", "beta_store", null])
    assert.equal(await code(readAppSecret(keyring, query, key)), "VAULT_INPUT_INVALID");
});

test("the vault logs nothing and its errors carry no value", async () => {
  assert.deepEqual(logged, []);
  const error = new VaultError("VAULT_OPEN_FAILED");
  assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
  assert.deepEqual([error.code, error.name], ["VAULT_OPEN_FAILED", "VaultError"]);
  assert.equal(error.message, "VAULT_OPEN_FAILED");
});
