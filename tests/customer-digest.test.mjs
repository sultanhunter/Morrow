// SD4 (P09.T05c; docs/packets/P09.T05c.md): the keyed customer digests that customers/* requests
// are matched by, and the workspace's digest keys in the broker vault. Fakes only; the
// PostgreSQL round trip through the broker's two vault definers is lab:shopify-privacy phase X.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  customerDigestKeyVersionsMax,
  customerDigests,
  customerEmailDigestInput,
  customerIdDigestInput,
  customerPhoneDigestInput,
  importCustomerDigestKey,
  workspaceCustomerDigestKeys,
} from "../apps/broker/src/customer-digest.ts";
import { minimiseShopifyWebhook } from "../apps/broker/src/shopify.ts";
import {
  VaultError,
  createVaultKeyring,
  openVaultRecord,
  sealVaultRecord,
  vaultAdditionalData,
  vaultBytesHex,
  vaultStatements,
} from "../apps/broker/src/vault.ts";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const hmac = (key, input) => createHmac("sha256", key).update(input).digest("hex");

test("the digest inputs: domain-separated, versioned and normalised; null for anything else", () => {
  assert.equal(customerIdDigestInput(191167), "morrow.customer-id.v1|191167");
  assert.equal(customerIdDigestInput("191167"), "morrow.customer-id.v1|191167");
  for (const bad of [0, -1, 1.5, "01", "abc", null, undefined, Number.MAX_SAFE_INTEGER + 2, {}])
    assert.equal(customerIdDigestInput(bad), null, String(bad));
  // The email: NFKC, trimmed, lower case, a +tag dropped, the domain's trailing dot dropped,
  // exactly as H9a's customer identifier screen computes its keyed list's input.
  assert.equal(
    customerEmailDigestInput("  John.Doe+orders@Example.COM. "),
    "morrow.customer-email.v1|john.doe@example.com",
  );
  assert.equal(
    customerEmailDigestInput("ｊｏｈｎ@example.com"),
    "morrow.customer-email.v1|john@example.com",
  );
  for (const bad of ["john", "@example.com", "john@localhost", "jo hn@example.com", "", 5, null])
    assert.equal(customerEmailDigestInput(bad), null, String(bad));
  assert.equal(customerEmailDigestInput("a".repeat(310) + "@example.com"), null);
  // The phone: E.164 only (the contact path dials E.164 numbers); separators removed, a 00
  // prefix read as +.
  assert.equal(
    customerPhoneDigestInput("+1 (613) 555-0100"),
    "morrow.customer-phone.v1|+16135550100",
  );
  assert.equal(
    customerPhoneDigestInput("0091 98765.43210"),
    "morrow.customer-phone.v1|+919876543210",
  );
  for (const bad of [
    "555-625-1199",
    "+0123456789",
    "+12",
    "+1234567890123456",
    "phone",
    null,
    15550000000,
  ])
    assert.equal(customerPhoneDigestInput(bad), null, String(bad));
});

test("customerDigests: HMAC-SHA-256 of each input under every key version, ascending", async () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const keys = [
    await importCustomerDigestKey(2, new Uint8Array(k2)),
    await importCustomerDigestKey(1, new Uint8Array(k1)),
  ];
  const sets = await customerDigests(keys, {
    id: 191167,
    email: "John@Example.com",
    phone: "+1 613 555 0100",
    first_name: "John",
  });
  assert.deepEqual(sets, [
    {
      version: 1,
      id: hmac(k1, "morrow.customer-id.v1|191167"),
      email: hmac(k1, "morrow.customer-email.v1|john@example.com"),
      phone: hmac(k1, "morrow.customer-phone.v1|+16135550100"),
    },
    {
      version: 2,
      id: hmac(k2, "morrow.customer-id.v1|191167"),
      email: hmac(k2, "morrow.customer-email.v1|john@example.com"),
      phone: hmac(k2, "morrow.customer-phone.v1|+16135550100"),
    },
  ]);
  assert.ok(Object.isFrozen(sets) && sets.every(Object.isFrozen));
  // Absent or unusable fields are null; nothing else of the object is read.
  assert.deepEqual(await customerDigests(keys.slice(0, 1), { email: "nope", phone: "555-0100" }), [
    { version: 2, id: null, email: null, phone: null },
  ]);
  assert.deepEqual(await customerDigests(keys.slice(1), null), [
    { version: 1, id: null, email: null, phone: null },
  ]);
  // The key is non-extractable and its bytes are zeroed on import.
  const bytes = new Uint8Array(randomBytes(32));
  const imported = await importCustomerDigestKey(3, bytes);
  assert.equal(imported.key.extractable, false);
  assert.ok(bytes.every((b) => b === 0));
  for (const [version, length] of [
    [0, 32],
    [customerDigestKeyVersionsMax + 1, 32],
    [1, 31],
  ])
    await assert.rejects(
      importCustomerDigestKey(version, new Uint8Array(length)),
      (e) => e instanceof VaultError && e.code === "VAULT_RECORD_INVALID",
    );
});

test("the minimiser keeps a customer request as order ids and keyed digests only", async () => {
  const k1 = randomBytes(32);
  const keys = [await importCustomerDigestKey(1, new Uint8Array(k1))];
  const shop = "x.myshopify.com";
  const customer = { id: 191167, email: "john@example.com", phone: "+16135550100" };
  const redact = await minimiseShopifyWebhook(
    "app-secret",
    "customers/redact",
    { shop_id: 954889, shop_domain: shop, customer, orders_to_redact: [299938, 280263] },
    shop,
    keys,
  );
  assert.deepEqual(redact, {
    shopId: "954889",
    customerDigests: [
      {
        version: 1,
        id: hmac(k1, "morrow.customer-id.v1|191167"),
        email: hmac(k1, "morrow.customer-email.v1|john@example.com"),
        phone: hmac(k1, "morrow.customer-phone.v1|+16135550100"),
      },
    ],
    ordersToRedact: ["280263", "299938"],
  });
  assert.doesNotMatch(JSON.stringify(redact), /john|6135550100|191167/);
  const request = await minimiseShopifyWebhook(
    "app-secret",
    "customers/data_request",
    {
      shop_id: 954889,
      shop_domain: shop,
      customer,
      orders_requested: [299938],
      data_request: { id: 9999 },
    },
    shop,
    keys,
  );
  assert.deepEqual(Object.keys(request).sort(), [
    "customerDigests",
    "dataRequestId",
    "ordersRequested",
    "shopId",
  ]);
  assert.deepEqual(request.customerDigests, redact.customerDigests);
  // Without the workspace's keys a customer request is refused (Shopify retries); a customer
  // that is not an object is refused; the other topics need no key.
  for (const [topic, body, k] of [
    ["customers/redact", { shop_id: 1, shop_domain: shop, customer, orders_to_redact: [] }, []],
    [
      "customers/redact",
      { shop_id: 1, shop_domain: shop, customer: "x", orders_to_redact: [] },
      keys,
    ],
  ])
    assert.equal(await minimiseShopifyWebhook("s", topic, body, shop, k), null, topic);
  assert.deepEqual(
    await minimiseShopifyWebhook("s", "shop/redact", { shop_id: 1, shop_domain: shop }, shop),
    { shopId: "1" },
  );
});

// A fake vault transaction: the two fixed statements over an in-memory key table, as the
// definers answer them.
function fakeVault({ tenant = { org: "org_1", ws: "ws_1" }, rows = [], race = false } = {}) {
  const calls = [];
  const query = async (text, values) => {
    calls.push([text, values]);
    if (text === vaultStatements.customerDigestKeysGet) {
      if (tenant === null)
        return [
          {
            outcome: "not_found",
            organization_id: null,
            workspace_id: null,
            version: null,
            kek_version: null,
            wrapped_key: null,
            sealed_value: null,
          },
        ];
      if (rows.length === 0)
        return [
          {
            outcome: "none",
            organization_id: tenant.org,
            workspace_id: tenant.ws,
            version: null,
            kek_version: null,
            wrapped_key: null,
            sealed_value: null,
          },
        ];
      return rows.map((r) => ({
        outcome: "found",
        organization_id: tenant.org,
        workspace_id: tenant.ws,
        ...r,
      }));
    }
    if (text === vaultStatements.customerDigestKeyCreate) {
      if (race) return [{ outcome: "exists" }];
      rows.push({
        version: "1",
        kek_version: values[2],
        wrapped_key: values[3],
        sealed_value: values[4],
      });
      return [{ outcome: "created" }];
    }
    throw Error("unexpected statement");
  };
  return { query, calls, rows };
}

test("workspaceCustomerDigestKeys: version 1 created once, sealed to the tenant, then every version opened", async () => {
  const keyring = await createVaultKeyring(
    "development",
    new Map([[1, randomBytes(32).toString("hex")]]),
  );
  const vault = fakeVault();
  const first = await workspaceCustomerDigestKeys(
    keyring,
    vault.query,
    "lab-app",
    "x.myshopify.com",
  );
  assert.equal(first.length, 1);
  assert.equal(first[0].version, 1);
  assert.deepEqual(
    vault.calls.map(([text]) => text),
    [
      vaultStatements.customerDigestKeysGet,
      vaultStatements.customerDigestKeyCreate,
      vaultStatements.customerDigestKeysGet,
    ],
  );
  assert.deepEqual(vault.calls[0][1], ["lab-app", "x.myshopify.com"]);
  // The stored row opens only as the tenant's version 1 customer digest key.
  const row = vault.rows[0];
  const envelope = {
    kekVersion: Number(row.kek_version),
    wrappedKey: Buffer.from(row.wrapped_key, "hex"),
    sealedValue: Buffer.from(row.sealed_value, "hex"),
  };
  const ref = (change = {}) => ({
    kind: "customer_digest_key",
    organizationId: "org_1",
    workspaceId: "ws_1",
    provider: "morrow",
    version: 1,
    ...change,
  });
  const material = await openVaultRecord(keyring, ref(), envelope);
  assert.equal(material.length, 32);
  for (const change of [{ organizationId: "org_2" }, { workspaceId: "ws_2" }, { version: 2 }])
    await assert.rejects(
      openVaultRecord(keyring, ref(change), envelope),
      (e) => e instanceof VaultError && e.code === "VAULT_OPEN_FAILED",
    );
  // The same key digests the same way on the next request: no new key is made.
  const again = await workspaceCustomerDigestKeys(
    keyring,
    vault.query,
    "lab-app",
    "x.myshopify.com",
  );
  assert.equal(vault.calls.length, 4);
  const [a] = await customerDigests(first, { id: 7 });
  const [b] = await customerDigests(again, { id: 7 });
  assert.equal(a.id, b.id);
  assert.equal(a.id, hmac(Buffer.from(material), "morrow.customer-id.v1|7"));
  // A racing creation keeps the other request's key ("exists") and reads it back; a key the
  // read-back still cannot see fails closed (nothing is recorded, and Shopify retries).
  const raced = fakeVault({ race: true });
  await assert.rejects(
    workspaceCustomerDigestKeys(keyring, raced.query, "lab-app", "x.myshopify.com"),
    (e) => e instanceof VaultError,
  );
  assert.equal(raced.calls.length, 3);
  // No app for the shop: null, nothing created.
  const none = fakeVault({ tenant: null });
  assert.equal(
    await workspaceCustomerDigestKeys(keyring, none.query, "lab-app", "x.myshopify.com"),
    null,
  );
  assert.equal(none.calls.length, 1);
});

test("workspaceCustomerDigestKeys: two kept versions open in order; a malformed or foreign row fails closed", async () => {
  const keyring = await createVaultKeyring(
    "development",
    new Map([[1, randomBytes(32).toString("hex")]]),
  );
  const seal = async (version, tenant = { org: "org_1", ws: "ws_1" }) => {
    const sealed = await sealVaultRecord(
      keyring,
      {
        kind: "customer_digest_key",
        organizationId: tenant.org,
        workspaceId: tenant.ws,
        provider: "morrow",
        version,
      },
      new Uint8Array(randomBytes(32)),
    );
    return {
      version: String(version),
      kek_version: String(sealed.kekVersion),
      wrapped_key: vaultBytesHex(sealed.wrappedKey),
      sealed_value: vaultBytesHex(sealed.sealedValue),
    };
  };
  const two = fakeVault({ rows: [await seal(1), await seal(2)] });
  const keys = await workspaceCustomerDigestKeys(keyring, two.query, "lab-app", "x.myshopify.com");
  assert.deepEqual(
    keys.map((k) => k.version),
    [1, 2],
  );
  for (const rows of [
    // Out of order, repeated, past the maximum version, or sealed to another tenant.
    [await seal(2), await seal(1)],
    [await seal(1), await seal(1)],
    [{ ...(await seal(1)), version: "9" }],
    [await seal(1, { org: "org_2", ws: "ws_1" })],
  ])
    await assert.rejects(
      workspaceCustomerDigestKeys(keyring, fakeVault({ rows }).query, "lab-app", "x.myshopify.com"),
      (e) => e instanceof VaultError,
    );
  // The additional data binds the kind, the tenant and the version, with no record ids.
  assert.deepEqual(
    JSON.parse(
      new TextDecoder().decode(
        vaultAdditionalData(
          "development",
          {
            kind: "customer_digest_key",
            organizationId: "org_1",
            workspaceId: "ws_1",
            provider: "morrow",
            version: 2,
          },
          1,
          "seal",
        ),
      ),
    ),
    [
      "morrow.vault.v1",
      "seal",
      "development",
      "customer_digest_key",
      "org_1",
      "ws_1",
      null,
      null,
      "morrow",
      2,
      1,
    ],
  );
  for (const bad of [
    { version: 9 },
    { provider: "shopify" },
    { organizationId: "" },
    { subjectId: "x" },
  ])
    assert.throws(
      () =>
        vaultAdditionalData(
          "development",
          {
            kind: "customer_digest_key",
            organizationId: "org_1",
            workspaceId: "ws_1",
            provider: "morrow",
            version: 1,
            ...bad,
          },
          1,
          "seal",
        ),
      (e) => e instanceof VaultError && e.code === "VAULT_INPUT_INVALID",
    );
});

test("the module is edge-safe and logs nothing; the statements are the registry's", () => {
  const source = readFileSync("apps/broker/src/customer-digest.ts", "utf8");
  assert.doesNotMatch(source, /from "node:|console\./);
  assert.equal(
    vaultStatements.customerDigestKeysGet,
    "SELECT outcome,organization_id,workspace_id,version,kek_version,wrapped_key,sealed_value FROM morrow_vault.customer_digest_keys_get($1,$2)",
  );
  assert.equal(
    vaultStatements.customerDigestKeyCreate,
    "SELECT morrow_vault.customer_digest_key_create($1,$2,$3,$4,$5) AS outcome",
  );
  assert.ok(hex(new Uint8Array([1])) === "01");
});
