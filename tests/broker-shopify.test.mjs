// M2 PR-2: the ConnectorBroker's Shopify methods over a faked vault database and a faked
// Shopify (no network, no database), and the vault login's transport over a faked driver.
// The order of the install is checked by the events it causes: the claim commits before
// any provider call and only after Shopify's signature verified (an unsigned or stale
// callback consumes no state), a refusal stops everything after it, a non-development
// store or a scope mismatch stores nothing, an exchange lost after sending is never
// retried, a lost COMMIT acknowledgement is outcome_unknown, and the token is never in a
// verdict or a log. Ingress (the PR-2 review's layers 2 and 3): unsigned-shaped requests
// open no vault transaction; with the app's secret held by the isolate, a forged launch,
// callback or webhook opens none either; and at most shopifyIngressLimits transactions
// (unverified, total) run at once, the install store never counted. M2 PR-3: a verified
// webhook is recorded in the inbox in the transaction that verified it (only its id is in
// the verdict); a body of another topic, or naming another shop, is invalid; and the
// token's destruction names an installation and the end reason its row records.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  decodeShopifyCredentialResult,
  decodeShopifyInstallResult,
  decodeShopifyLaunchVerdict,
  decodeShopifyWebhookVerdict,
} from "../packages/identity/src/broker-protocol.ts";
import {
  createShopifyBroker,
  shopifyIngressLimits,
  shopifySecretCacheMs,
  shopifySecretStaleMs,
} from "../apps/broker/src/shopify-install.ts";
import {
  VaultError,
  createVaultKeyring,
  openVaultRecord,
  sealVaultRecord,
  vaultBytesHex,
  vaultHexBytes,
  vaultStatements,
} from "../apps/broker/src/vault.ts";
import {
  runVaultTransactionWithDriver,
  vaultTransactionSql,
} from "../apps/broker/src/vault-database.ts";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const appKey = "dev-store-1";
const clientId = "c".repeat(32);
const secret = "shpss_" + randomBytes(16).toString("hex");
const shop = "dev-store-1.myshopify.com";
const workspaceId = "ws_invited";
const organizationId = "org_invited";
const kek = randomBytes(32).toString("hex");
const token = "shpat_" + randomBytes(16).toString("hex");
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-broker-unit",
  branchId: "br-broker-unit",
  hostname: "ep-broker-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const env = () => ({
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
});
const logs = [];
const originalLog = console.log;
console.log = (line) => logs.push(String(line));
test.after(() => (console.log = originalLog));

const nowSeconds = 1760950000;
const signed = (values) => {
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1));
  const message = new URLSearchParams(entries).toString().replace(/\+/g, "%20");
  const hmac = createHmac("sha256", secret).update(message).digest("hex");
  return new URLSearchParams([...entries, ["hmac", hmac]]).toString();
};
const newState = () => randomBytes(32).toString("base64url");

// The fake vault database: the 0026/0027 definers' answers over in-memory rows.
async function fakeVault(options = {}) {
  const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
  const envelope = await sealVaultRecord(
    keyring,
    { kind: "app_secret", appKey, provider: "shopify", version: 1 },
    new TextEncoder().encode(secret),
  );
  const db = {
    events: [],
    states: new Map(),
    installations: new Map(),
    credentials: [],
    continuations: [],
    registered: options.registered ?? true,
    transactions: 0,
    // M2 PR-3: the inbox (by webhook id) and every record statement's values.
    inbox: new Map(),
    recorded: [],
    destroyOutcome: "destroyed",
  };
  const handlers = {
    [vaultStatements.appSecretGet]: ([key]) =>
      key === appKey && db.registered
        ? [
            {
              outcome: "found",
              version: "1",
              kek_version: "1",
              wrapped_key: vaultBytesHex(envelope.wrappedKey),
              sealed_value: vaultBytesHex(envelope.sealedValue),
            },
          ]
        : [
            {
              outcome: "not_found",
              version: null,
              kek_version: null,
              wrapped_key: null,
              sealed_value: null,
            },
          ],
    [vaultStatements.shopifyLaunchContext]: async ([key, domain]) => {
      // Holds the launch's transaction open (its ingress slot taken) when gated.
      if (options.launchGate) await options.launchGate();
      const found = key === appKey && domain === shop && db.registered;
      const installation = [...db.installations.values()].find((i) => i.domain === domain);
      return [
        found
          ? {
              outcome: "found",
              client_id: clientId,
              workspace_id: workspaceId,
              installation: installation?.status ?? "none",
            }
          : { outcome: "not_found", client_id: null, workspace_id: null, installation: null },
      ];
    },
    [vaultStatements.shopifyWebhookRecord]: ([key, domain, topic, webhookId, apiVersion, body]) => {
      db.events.push("record");
      db.recorded.push({ key, domain, topic, webhookId, apiVersion, body: JSON.parse(body) });
      if (key !== appKey || domain !== shop || !db.registered)
        return [{ outcome: "not_found", inbox_id: null, settled: null }];
      if (options.recordInvalid) return [{ outcome: "invalid", inbox_id: null, settled: null }];
      const existing = db.inbox.get(webhookId);
      if (existing)
        return [{ outcome: "duplicate", inbox_id: existing.id, settled: String(existing.settled) }];
      const id = randomUUID();
      db.inbox.set(webhookId, { id, settled: false });
      return [{ outcome: "recorded", inbox_id: id, settled: "false" }];
    },
    [vaultStatements.shopifyCredentialDestroy]: ([installation, reason]) => {
      db.events.push("destroy:" + installation + ":" + reason);
      return [{ outcome: db.destroyOutcome }];
    },
    [vaultStatements.shopifyCallbackClaim]: ([key, digest]) => {
      db.events.push("claim");
      const state = db.states.get(digest);
      if (!state || key !== appKey)
        return [{ outcome: "not_found", shop_digest: null, client_id: null }];
      if (state.claimed) return [{ outcome: "replayed", shop_digest: null, client_id: null }];
      if (state.expired) return [{ outcome: "expired", shop_digest: null, client_id: null }];
      state.claimed = true;
      return [{ outcome: "claimed", shop_digest: state.shopDigest, client_id: clientId }];
    },
    // v1 PR 1 (ADR-0035 item 2): the live-store admission, admitted only for the marked
    // app's own shop (options.liveStore names the marked app key).
    [vaultStatements.shopifyLiveStoreAdmission]: ([key, domain]) => {
      db.events.push("admission");
      return [
        {
          outcome:
            options.liveStore !== undefined && key === options.liveStore && domain === shop
              ? "admitted"
              : "refused",
        },
      ];
    },
    [vaultStatements.shopifyInstallPrepare]: ([key, digest, shopId, domain]) => {
      db.events.push("prepare");
      const state = db.states.get(digest);
      if (!state?.claimed || state.recorded || sha(domain) !== state.shopDigest)
        return [
          {
            outcome: "state_invalid",
            organization_id: null,
            workspace_id: null,
            installation_id: null,
            store_id: null,
            connection_id: null,
            credential_id: null,
            credential_version: null,
          },
        ];
      const existing = db.installations.get(key + ":" + shopId);
      return [
        existing
          ? {
              outcome: "reauthorise",
              organization_id: organizationId,
              workspace_id: workspaceId,
              installation_id: existing.id,
              store_id: existing.store,
              connection_id: existing.connection,
              credential_id: existing.credential,
              credential_version: String(existing.version + 1),
            }
          : {
              outcome: "install",
              organization_id: organizationId,
              workspace_id: workspaceId,
              installation_id: "11111111-1111-4111-8111-111111111111",
              store_id: "22222222-2222-4222-8222-222222222222",
              connection_id: "33333333-3333-4333-8333-333333333333",
              credential_id: "44444444-4444-4444-8444-444444444444",
              credential_version: "1",
            },
      ];
    },
    [vaultStatements.shopifyInstallStore]: (v) => {
      db.events.push("store");
      const [
        key,
        digest,
        shopId,
        domain,
        scopes,
        development,
        installation,
        store,
        connection,
        credential,
        version,
        kekVersion,
        wrapped,
        sealed,
        continuation,
      ] = v;
      const state = db.states.get(digest);
      state.recorded = true;
      const id = key + ":" + shopId;
      const existing = db.installations.get(id);
      const status = existing?.status ?? "unlinked";
      db.installations.set(id, {
        id: installation,
        store,
        connection,
        credential,
        version: Number(version),
        domain,
        status,
        scopes,
        development,
      });
      db.credentials.push({
        credential,
        version: Number(version),
        subject: installation,
        kekVersion: Number(kekVersion),
        wrapped,
        sealed,
      });
      if (status === "unlinked") db.continuations.push(continuation);
      return [
        {
          outcome: existing ? "reauthorised" : "installed",
          workspace_id: workspaceId,
          continuation: status === "unlinked" ? "created" : "none",
        },
      ];
    },
  };
  let transactions = 0;
  const transaction = async (vault, budgetMs, body) => {
    const index = transactions++;
    db.transactions++;
    assert.ok(vault.keyring && vault.databasePassword && vault.binding, "the vault capability");
    assert.ok(Number.isSafeInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 10000);
    const value = await body(async (text, values) => {
      const handler = handlers[text];
      assert.ok(handler, "registered statement");
      assert.ok(values.every((x) => typeof x === "string"));
      return handler(values);
    });
    if (options.loseCommit === index) throw new VaultError("VAULT_OUTCOME_UNKNOWN");
    return value;
  };
  return { db, keyring, transaction };
}
function shopifyFake(db, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/admin/oauth/access_token")) {
      db.events.push("exchange");
      if (options.onExchange) await options.onExchange();
      if (options.exchangeLost) throw new Error("socket closed after send");
      return Response.json({ access_token: token, scope: options.scope ?? "write_products" });
    }
    db.events.push("identity");
    return Response.json({
      data: {
        shop: {
          id: "gid://shopify/Shop/987",
          myshopifyDomain: shop,
          plan: { partnerDevelopment: options.development ?? true },
        },
      },
    });
  };
  return { fetcher, calls };
}
async function harness(options = {}) {
  const vault = await fakeVault(options);
  const shopify = shopifyFake(vault.db, options);
  const clock = options.clock ?? { ms: nowSeconds * 1000 };
  const broker = createShopifyBroker({
    transaction: vault.transaction,
    fetch: shopify.fetcher,
    now: () => clock.ms,
  });
  return { ...vault, shopify, broker, env: env() };
}
function openState(db, state, overrides = {}) {
  db.states.set(sha(state), {
    shopDigest: sha(shop),
    claimed: false,
    recorded: false,
    ...overrides,
  });
}
const callback = (state, values = {}) =>
  signed({
    code: "authcode123",
    host: "aG9zdA",
    shop,
    state,
    timestamp: String(nowSeconds),
    ...values,
  });

test("launch: a verified query of the registered shop returns the installation state and workspace", async () => {
  const h = await harness();
  const verdict = decodeShopifyLaunchVerdict(
    await h.broker.launchVerify(
      h.env,
      appKey,
      signed({ host: "aG9zdA", shop, timestamp: String(nowSeconds) }),
    ),
  );
  assert.deepEqual(verdict, { verdict: "verified", shop, installation: "none", workspaceId });
  for (const [key, query] of [
    [appKey, signed({ shop, timestamp: String(nowSeconds - 91) })],
    [
      appKey,
      signed({ shop, timestamp: String(nowSeconds) }).replace(
        /hmac=[a-f0-9]+/,
        "hmac=" + "0".repeat(64),
      ),
    ],
    [appKey, signed({ shop: "other-shop.myshopify.com", timestamp: String(nowSeconds) })],
    ["unknown-app", signed({ shop, timestamp: String(nowSeconds) })],
    [appKey, "shop=" + shop],
  ])
    assert.equal(
      decodeShopifyLaunchVerdict(await h.broker.launchVerify(h.env, key, query)).verdict,
      "refused",
    );
  assert.equal(h.shopify.calls.length, 0);
  // Not shaped like a signed query: refused before any vault transaction (no hmac, a
  // malformed or uppercase hmac, a stale or missing timestamp, a signature parameter).
  const valid = signed({ shop, timestamp: String(nowSeconds) });
  h.db.transactions = 0;
  for (const query of [
    "shop=" + shop + "&timestamp=" + nowSeconds,
    valid.replace(/hmac=[a-f0-9]+/, "hmac=" + "0".repeat(63)),
    valid.replace(/hmac=([a-f0-9]+)/, (_, x) => "hmac=" + x.toUpperCase()),
    signed({ shop, timestamp: String(nowSeconds - 91) }),
    signed({ shop }),
    signed({ shop, signature: "x", timestamp: String(nowSeconds) }),
  ])
    assert.equal(
      decodeShopifyLaunchVerdict(await h.broker.launchVerify(h.env, appKey, query)).verdict,
      "refused",
      query,
    );
  assert.equal(h.db.transactions, 0);
});

// A gate that holds every gated transaction until opened, then can be closed again.
function gate() {
  let open,
    waiting = 0,
    opened = new Promise((resolve) => (open = resolve));
  return {
    wait: async () => {
      waiting++;
      try {
        await opened;
      } finally {
        waiting--;
      }
    },
    held: () => waiting,
    open: () => open(),
    close: () => (opened = new Promise((resolve) => (open = resolve))),
  };
}
// Waits (up to 5 s on a loaded machine) until exactly `count` transactions wait at the gate.
async function holding(g, count) {
  for (const started = Date.now(); Date.now() - started < 5000; )
    if (g.held() === count) break;
    else await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(g.held(), count);
}
const busy = (error) => error.code === "INGRESS_BUSY";
const forgedWebhook = (body = '{"shop_id":987}') =>
  JSON.stringify({
    "x-shopify-api-version": "2026-10",
    "x-shopify-hmac-sha256": createHmac("sha256", "x").update(body).digest("base64"),
    "x-shopify-shop-domain": shop,
    "x-shopify-topic": "shop/redact",
    "x-shopify-webhook-id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
  });

test("ingress layer 2: with the app's secret held, forged launches, callbacks and webhooks open no transaction", async () => {
  const clock = { ms: nowSeconds * 1000 };
  const h = await harness({ clock });
  // Queries are signed at the moving clock, so only the cache's age changes below.
  const at = () => String(Math.trunc(clock.ms / 1000));
  const launch = (key = appKey, query = signed({ shop, timestamp: at() })) =>
    h.broker.launchVerify(h.env, key, query).then((v) => decodeShopifyLaunchVerdict(v).verdict);
  const forgedQuery = () =>
    signed({ shop, timestamp: at() }).replace(/hmac=[a-f0-9]+/, "hmac=" + "0".repeat(64));
  // Cold: the first request reads the vault, whatever its signature.
  assert.equal(await launch(appKey, forgedQuery()), "refused");
  assert.equal(h.db.transactions, 1);
  // Held: forged requests of the known app are refused in memory.
  assert.equal(await launch(appKey, forgedQuery()), "refused");
  assert.equal(
    decodeShopifyWebhookVerdict(
      await h.broker.webhookVerify(
        h.env,
        appKey,
        forgedWebhook(),
        Buffer.from('{"shop_id":987}').toString("base64"),
      ),
    ).verdict,
    "refused",
  );
  const state = newState();
  openState(h.db, state);
  const forgedCallback = callback(state).replace(/hmac=[a-f0-9]+/, "hmac=" + "f".repeat(64));
  assert.equal(
    decodeShopifyInstallResult(
      await h.broker.installComplete(h.env, appKey, forgedCallback, sha(state), 9000),
    ).outcome,
    "refused",
  );
  assert.equal(h.db.transactions, 1);
  assert.equal(h.db.states.get(sha(state)).claimed, false);
  assert.deepEqual(h.db.events, []);
  // A signed request still reads the registry; an unknown app key is never held.
  assert.equal(await launch(), "verified");
  assert.equal(await launch("unknown-app"), "refused");
  assert.equal(await launch("unknown-app"), "refused");
  assert.equal(h.db.transactions, 4);
  // Another isolate (another broker) holds nothing yet.
  const other = createShopifyBroker({
    transaction: h.transaction,
    fetch: h.shopify.fetcher,
    now: () => clock.ms,
  });
  assert.equal(
    decodeShopifyLaunchVerdict(await other.launchVerify(h.env, appKey, forgedQuery())).verdict,
    "refused",
  );
  assert.equal(h.db.transactions, 5);
  // A held secret refuses on its own for shopifySecretCacheMs from the read that returned
  // it; after that a request it does not verify reads the vault again.
  clock.ms += shopifySecretCacheMs + 1;
  assert.equal(await launch(appKey, forgedQuery()), "refused");
  assert.equal(h.db.transactions, 6);
  assert.equal(await launch(appKey, forgedQuery()), "refused");
  assert.equal(h.db.transactions, 6);
  // A vault read that finds no secret clears the entry (a removed app): the next forged
  // request reads the vault again.
  clock.ms += shopifySecretCacheMs + 1;
  h.db.registered = false;
  assert.equal(await launch(), "refused");
  assert.equal(await launch(appKey, forgedQuery()), "refused");
  assert.equal(h.db.transactions, 8);
});

test("ingress layer 3: one unverified and three ingress transactions at once per isolate; the install store is not counted", async () => {
  const g = gate();
  const h = await harness({ launchGate: g.wait });
  const query = signed({ host: "aG9zdA", shop, timestamp: String(nowSeconds) });
  const launch = (key = appKey) => h.broker.launchVerify(h.env, key, query);
  const webhookBody = Buffer.from('{"shop_id":987}').toString("base64");
  // Cold: one unverified transaction; a second unverified request is held without one.
  const first = launch();
  await holding(g, 1);
  await assert.rejects(() => launch(), busy);
  await assert.rejects(
    () => h.broker.webhookVerify(h.env, appKey, forgedWebhook(), webhookBody),
    busy,
  );
  assert.equal(h.db.transactions, 1);
  g.open();
  assert.equal(decodeShopifyLaunchVerdict(await first).verdict, "verified");
  // Warm: verified requests take the remaining slots, up to shopifyIngressLimits.total.
  g.close();
  assert.equal(shopifyIngressLimits.unverified, 1);
  assert.equal(shopifyIngressLimits.total, 3);
  const held = [launch(), launch(), launch()];
  await holding(g, 3);
  await assert.rejects(() => launch(), busy);
  await assert.rejects(() => launch("unknown-app"), busy);
  const state = newState();
  openState(h.db, state);
  await assert.rejects(
    () => h.broker.installComplete(h.env, appKey, callback(state), sha(state), 9000),
    busy,
  );
  // A forged request is refused before it asks for a slot.
  assert.equal(
    decodeShopifyLaunchVerdict(
      await h.broker.launchVerify(
        h.env,
        appKey,
        query.replace(/hmac=[a-f0-9]+/, "hmac=" + "0".repeat(64)),
      ),
    ).verdict,
    "refused",
  );
  assert.equal(h.db.transactions, 4);
  assert.equal(h.db.states.get(sha(state)).claimed, false);
  g.open();
  for (const verdict of await Promise.all(held))
    assert.equal(decodeShopifyLaunchVerdict(verdict).verdict, "verified");
  // An unverified request (an unknown app) takes the one unverified slot; verified ones
  // still have two.
  g.close();
  const unknownApp = launch("unknown-app");
  await holding(g, 1);
  await assert.rejects(() => launch("other-app"), busy);
  const two = [launch(), launch()];
  await holding(g, 3);
  await assert.rejects(() => launch(), busy);
  g.open();
  assert.equal(decodeShopifyLaunchVerdict(await unknownApp).verdict, "refused");
  await Promise.all(two);
  // The install's store follows the exchange and is not ingress: it runs while every
  // ingress slot is held.
  g.close();
  const during = [];
  const install = await harness({
    launchGate: g.wait,
    onExchange: async () => {
      for (let i = 0; i < shopifyIngressLimits.total; i++)
        during.push(install.broker.launchVerify(install.env, appKey, query));
      await holding(g, shopifyIngressLimits.total);
    },
  });
  // Warm the secret first, so the held launches are verified ones.
  g.open();
  await install.broker.launchVerify(install.env, appKey, query);
  g.close();
  const second = newState();
  openState(install.db, second);
  const result = decodeShopifyInstallResult(
    await install.broker.installComplete(install.env, appKey, callback(second), sha(second), 9000),
  );
  assert.equal(result.outcome, "installed");
  assert.deepEqual(install.db.events, ["claim", "exchange", "identity", "prepare", "store"]);
  g.open();
  await Promise.all(during);
});

test("ingress layer 3: a request a stale held secret verifies keeps a verified slot", async () => {
  const clock = { ms: nowSeconds * 1000 };
  const g = gate();
  const h = await harness({ clock, launchGate: g.wait });
  const at = () => String(Math.trunc(clock.ms / 1000));
  const launch = (key = appKey) =>
    h.broker.launchVerify(h.env, key, signed({ shop, timestamp: at() }));
  g.open();
  assert.equal(decodeShopifyLaunchVerdict(await launch()).verdict, "verified");
  // Stale: older than shopifySecretCacheMs, younger than shopifySecretStaleMs.
  clock.ms += shopifySecretCacheMs + 1;
  assert.ok(shopifySecretCacheMs + 1 < shopifySecretStaleMs);
  g.close();
  const unknownApp = launch("unknown-app");
  await holding(g, 1);
  // The unverified slot is held, yet the signed launch of the known app runs.
  const signedLaunch = launch();
  await holding(g, 2);
  g.open();
  assert.equal(decodeShopifyLaunchVerdict(await signedLaunch).verdict, "verified");
  assert.equal(decodeShopifyLaunchVerdict(await unknownApp).verdict, "refused");
  // Past shopifySecretStaleMs the secret is dropped: the next request is unverified.
  clock.ms += shopifySecretStaleMs;
  g.close();
  const first = launch();
  await holding(g, 1);
  await assert.rejects(() => launch(), busy);
  g.open();
  assert.equal(decodeShopifyLaunchVerdict(await first).verdict, "verified");
});

test("install: claim, verify, exchange once, exact scopes, identity, then one sealed store", async () => {
  const h = await harness();
  const state = newState();
  openState(h.db, state);
  const text = await h.broker.installComplete(h.env, appKey, callback(state), sha(state), 9000);
  const result = decodeShopifyInstallResult(text);
  assert.equal(result.outcome, "installed");
  assert.equal(result.workspaceId, workspaceId);
  assert.match(result.continuationToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(h.db.events, ["claim", "exchange", "identity", "prepare", "store"]);
  assert.deepEqual(h.db.continuations, [sha(result.continuationToken)]);
  // The stored envelope opens to the token only with the AAD of the prepared ids.
  const [stored] = h.db.credentials;
  const ref = {
    kind: "shopify_offline_token",
    organizationId,
    workspaceId,
    credentialId: stored.credential,
    subjectId: stored.subject,
    provider: "shopify",
    version: 1,
  };
  const envelope = {
    kekVersion: stored.kekVersion,
    wrappedKey: vaultHexBytes(stored.wrapped, 60, 60),
    sealedValue: vaultHexBytes(stored.sealed, 29, 4124),
  };
  assert.equal(new TextDecoder().decode(await openVaultRecord(h.keyring, ref, envelope)), token);
  await assert.rejects(() => openVaultRecord(h.keyring, { ...ref, subjectId: "other" }, envelope));
  assert.equal(h.db.installations.get(appKey + ":987").scopes, "read_products,write_products");
  // The token never leaves the broker: not in the verdict, not in a log.
  assert.ok(!text.includes(token) && !logs.join("\n").includes(token));
  // A second callback with the same state is replayed: claim only, no exchange.
  h.db.events.length = 0;
  const replay = decodeShopifyInstallResult(
    await h.broker.installComplete(h.env, appKey, callback(state), sha(state), 9000),
  );
  assert.equal(replay.outcome, "state_invalid");
  assert.deepEqual(h.db.events, ["claim"]);
});

// v1 PR 1 (ADR-0035 item 2): the owner's live store installs through the app that carries
// the live-store mark, asked before anything is prepared; a development store never asks.
test("install: the marked app's own live store is admitted before prepare and stored as not development", async () => {
  const h = await harness({ development: false, liveStore: appKey });
  const state = newState();
  openState(h.db, state);
  const text = await h.broker.installComplete(h.env, appKey, callback(state), sha(state), 9000);
  const result = decodeShopifyInstallResult(text);
  assert.equal(result.outcome, "installed");
  assert.equal(result.workspaceId, workspaceId);
  assert.deepEqual(h.db.events, ["claim", "exchange", "identity", "admission", "prepare", "store"]);
  assert.equal(h.db.installations.get(appKey + ":987").development, "false");
  assert.ok(!text.includes(token) && !logs.join("\n").includes(token));
  // A development store never asks the registry for the mark.
  const dev = await harness({ liveStore: appKey });
  const devState = newState();
  openState(dev.db, devState);
  decodeShopifyInstallResult(
    await dev.broker.installComplete(dev.env, appKey, callback(devState), sha(devState), 9000),
  );
  assert.deepEqual(dev.db.events, ["claim", "exchange", "identity", "prepare", "store"]);
  assert.equal(dev.db.installations.get(appKey + ":987").development, "true");
});

test("install: a relaunch re-authorises the same installation with the next credential version", async () => {
  const h = await harness();
  for (const _ of [1, 2]) {
    const state = newState();
    openState(h.db, state);
    const result = decodeShopifyInstallResult(
      await h.broker.installComplete(h.env, appKey, callback(state), sha(state), 9000),
    );
    assert.equal(result.outcome, _ === 1 ? "installed" : "reauthorised");
    assert.ok(result.continuationToken, "unlinked: a fresh continuation");
  }
  assert.deepEqual(
    h.db.credentials.map((c) => [c.credential, c.version, c.subject]),
    [
      ["44444444-4444-4444-8444-444444444444", 1, "11111111-1111-4111-8111-111111111111"],
      ["44444444-4444-4444-8444-444444444444", 2, "11111111-1111-4111-8111-111111111111"],
    ],
  );
  assert.equal(h.db.installations.size, 1);
  // Linked: re-authorised without a continuation.
  h.db.installations.get(appKey + ":987").status = "linked";
  const state = newState();
  openState(h.db, state);
  const linked = decodeShopifyInstallResult(
    await h.broker.installComplete(h.env, appKey, callback(state), sha(state), 9000),
  );
  assert.deepEqual(linked, { outcome: "reauthorised", workspaceId, continuationToken: null });
});

test("install refusals stop before the exchange, or store nothing after it", async () => {
  const cases = [
    // The query's state is not the cookie's: nothing at all.
    { name: "cookie", query: (s) => callback(newState()), events: [], outcome: "state_invalid" },
    { name: "expired", open: { expired: true }, events: ["claim"], outcome: "state_invalid" },
    { name: "unknown state", open: null, events: ["claim"], outcome: "state_invalid" },
    // Unverified: no claim statement at all, so the state stays open.
    {
      name: "bad hmac",
      query: (s) => callback(s).replace(/hmac=[a-f0-9]+/, "hmac=" + "f".repeat(64)),
      events: [],
      outcome: "refused",
    },
    {
      name: "unsigned",
      query: (s) => `code=c&shop=${shop}&state=${s}&timestamp=${nowSeconds}`,
      events: [],
      outcome: "refused",
    },
    {
      name: "foreign shop",
      open: { shopDigest: sha("other.myshopify.com") },
      events: ["claim"],
      outcome: "refused",
    },
    {
      name: "stale",
      query: (s) => callback(s, { timestamp: String(nowSeconds - 120) }),
      events: [],
      outcome: "refused",
    },
    {
      name: "scopes",
      options: { scope: "write_products,read_orders" },
      events: ["claim", "exchange"],
      outcome: "scopes_mismatch",
    },
    {
      name: "missing write",
      options: { scope: "read_products" },
      events: ["claim", "exchange"],
      outcome: "scopes_mismatch",
    },
    // ADR-0035 item 2: a store that is not a development store asks the registry first,
    // and an app without the live-store mark (or another app's mark) stores nothing.
    {
      name: "not development",
      options: { development: false },
      events: ["claim", "exchange", "identity", "admission"],
      outcome: "store_not_development",
    },
    {
      name: "not development, another app marked",
      options: { development: false, liveStore: "other-app-1" },
      events: ["claim", "exchange", "identity", "admission"],
      outcome: "store_not_development",
    },
    {
      name: "exchange lost",
      options: { exchangeLost: true },
      events: ["claim", "exchange"],
      outcome: "exchange_uncertain",
    },
    {
      name: "unregistered",
      options: { registered: false },
      events: [],
      outcome: "state_invalid",
    },
  ];
  for (const c of cases) {
    const h = await harness(c.options);
    const state = newState();
    if (c.open !== null) openState(h.db, state, c.open ?? {});
    const result = decodeShopifyInstallResult(
      await h.broker.installComplete(h.env, appKey, (c.query ?? callback)(state), sha(state), 9000),
    );
    assert.equal(result.outcome, c.outcome, c.name);
    assert.deepEqual(h.db.events, c.events, c.name);
    assert.deepEqual(h.db.credentials, [], c.name);
    assert.equal(h.db.installations.size, 0, c.name);
    assert.equal(result.workspaceId, null, c.name);
    assert.equal(result.continuationToken, null, c.name);
  }
});

test("install: an unsigned or stale callback cannot burn the merchant's state", async () => {
  const h = await harness();
  const state = newState();
  openState(h.db, state);
  for (const query of [
    `code=forged&shop=${shop}&state=${state}&timestamp=${nowSeconds}&hmac=${"0".repeat(64)}`,
    callback(state, { timestamp: String(nowSeconds - 120) }),
  ])
    assert.equal(
      decodeShopifyInstallResult(
        await h.broker.installComplete(h.env, appKey, query, sha(state), 9000),
      ).outcome,
      "refused",
    );
  assert.equal(h.db.states.get(sha(state)).claimed, false);
  assert.deepEqual(h.db.events, []);
  // The merchant's own signed callback still installs.
  assert.equal(
    decodeShopifyInstallResult(
      await h.broker.installComplete(h.env, appKey, callback(state), sha(state), 9000),
    ).outcome,
    "installed",
  );
});

test("install: a lost COMMIT acknowledgement is outcome_unknown, a lost claim is state_invalid", async () => {
  const unknown = await harness({ loseCommit: 1 });
  const state = newState();
  openState(unknown.db, state);
  assert.deepEqual(
    decodeShopifyInstallResult(
      await unknown.broker.installComplete(unknown.env, appKey, callback(state), sha(state), 9000),
    ),
    { outcome: "outcome_unknown", workspaceId: null, continuationToken: null },
  );
  assert.deepEqual(unknown.db.events, ["claim", "exchange", "identity", "prepare", "store"]);
  const claim = await harness({ loseCommit: 0 });
  const second = newState();
  openState(claim.db, second);
  assert.equal(
    decodeShopifyInstallResult(
      await claim.broker.installComplete(claim.env, appKey, callback(second), sha(second), 9000),
    ).outcome,
    "state_invalid",
  );
  assert.deepEqual(claim.db.events, ["claim"]);
});

test("install input: wrong types hold; budgets outside 1..10000 hold; production holds the vault", async () => {
  const h = await harness();
  await assert.rejects(
    () => h.broker.installComplete(h.env, appKey, "x", "d", "9000"),
    /BROKER_HELD|INPUT/,
  );
  for (const budget of [0, 10001, 1.5])
    await assert.rejects(() =>
      h.broker.installComplete(h.env, appKey, "x", "a".repeat(64), budget),
    );
  await assert.rejects(() =>
    h.broker.launchVerify(
      { ...env(), MORROW_ENVIRONMENT: "production" },
      appKey,
      signed({ shop, timestamp: String(nowSeconds) }),
    ),
  );
});

test("webhooks: raw-body HMAC before any parse; topic allowlist; recorded with its minimised body", async () => {
  const h = await harness();
  const body = JSON.stringify({
    shop_id: 987,
    shop_domain: shop,
    customer: { id: 5, email: "a@b.test", phone: "555-0100" },
    orders_to_redact: [1, 2],
  });
  const headers = (overrides = {}, text = body) =>
    JSON.stringify({
      "x-shopify-api-version": "2026-10",
      "x-shopify-hmac-sha256": createHmac("sha256", secret).update(text).digest("base64"),
      "x-shopify-shop-domain": shop,
      "x-shopify-topic": "customers/redact",
      "x-shopify-webhook-id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
      ...overrides,
    });
  const raw = Buffer.from(body).toString("base64");
  const verdict = decodeShopifyWebhookVerdict(
    await h.broker.webhookVerify(h.env, appKey, headers(), raw),
  );
  assert.equal(verdict.verdict, "recorded");
  assert.match(verdict.inboxId, /^[a-f0-9-]{36}$/);
  assert.equal(verdict.settled, false);
  // One record statement, in the verifying transaction, with the minimised body only: the
  // shop id and a keyed digest of the customer id (never the email, phone or order ids).
  assert.equal(h.db.transactions, 1);
  assert.deepEqual(h.db.events, ["record"]);
  const recorded = h.db.recorded[0];
  assert.deepEqual(
    [recorded.key, recorded.domain, recorded.topic, recorded.webhookId, recorded.apiVersion],
    [appKey, shop, "customers/redact", "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043", "2026-10"],
  );
  assert.deepEqual(recorded.body, {
    shopId: "987",
    customerDigest: createHmac("sha256", secret)
      .update("morrow.shopify.customer.v1|5")
      .digest("hex"),
  });
  assert.doesNotMatch(JSON.stringify(h.db.recorded), /a@b\.test|555-0100|"orders/);
  // A redelivery is the same row, reported with whether it is settled.
  const again = decodeShopifyWebhookVerdict(
    await h.broker.webhookVerify(h.env, appKey, headers(), raw),
  );
  assert.deepEqual(again, { verdict: "duplicate", inboxId: verdict.inboxId, settled: false });
  h.db.inbox.get("b54557e4-bdd9-4b37-8a5f-bf7d70bcd043").settled = true;
  assert.equal(
    decodeShopifyWebhookVerdict(await h.broker.webhookVerify(h.env, appKey, headers(), raw))
      .settled,
    true,
  );
  // Refused (401): another signature, a changed body, an unsubscribed topic, a missing
  // header, a body that is not base64, and a shop the registry does not hold for the app.
  const records = h.db.recorded.length;
  for (const [h2, b2] of [
    [
      headers({ "x-shopify-hmac-sha256": createHmac("sha256", "x").update(body).digest("base64") }),
      raw,
    ],
    [headers(), Buffer.from(body + " ").toString("base64")],
    [headers({ "x-shopify-topic": "orders/create" }), raw],
    [JSON.stringify({ "x-shopify-topic": "shop/redact" }), raw],
    [headers(), "!!!"],
  ])
    assert.equal(
      decodeShopifyWebhookVerdict(await h.broker.webhookVerify(h.env, appKey, h2, b2)).verdict,
      "refused",
    );
  assert.equal(h.db.recorded.length, records);
  // Invalid (400): Shopify-signed, but not a body of its topic. The topic header is not
  // signed, so a customers/redact body sent as shop/redact (or app/uninstalled) is refused,
  // as is a compliance body naming another shop than the header's; nothing is recorded.
  for (const [topic, text, shopHeader] of [
    ["shop/redact", body, shop],
    ["app/uninstalled", body, shop],
    ["customers/data_request", body, shop],
    ["customers/redact", JSON.stringify({ shop_id: 987, shop_domain: shop }), shop],
    ["shop/redact", JSON.stringify({ shop_id: 987, shop_domain: "other.myshopify.com" }), shop],
    ["app/uninstalled", JSON.stringify({ id: 987, myshopify_domain: "other.myshopify.com" }), shop],
    ["app/scopes_update", JSON.stringify({ previous: ["read_products"] }), shop],
    ["shop/redact", "[1,2]", shop],
  ])
    assert.equal(
      decodeShopifyWebhookVerdict(
        await h.broker.webhookVerify(
          h.env,
          appKey,
          headers(
            {
              "x-shopify-topic": topic,
              "x-shopify-shop-domain": shopHeader,
              "x-shopify-webhook-id": randomUUID(),
            },
            text,
          ),
          Buffer.from(text).toString("base64"),
        ),
      ).verdict,
      "invalid",
      topic + " " + text,
    );
  assert.equal(h.db.recorded.length, records);
  // Each topic's own body is recorded with its minimised shape.
  for (const [topic, text, expected] of [
    [
      "app/uninstalled",
      JSON.stringify({ id: 987, name: "Dev", myshopify_domain: shop, email: "o@x.test" }),
      { shopId: "987" },
    ],
    [
      "app/scopes_update",
      JSON.stringify({
        id: 1,
        previous: ["write_products"],
        current: ["read_products"],
        updated_at: "2026-10-22T00:00:00Z",
      }),
      { previous: ["write_products"], current: ["read_products"] },
    ],
    [
      "customers/data_request",
      JSON.stringify({
        shop_id: 987,
        shop_domain: shop,
        orders_requested: [7],
        customer: { id: 5, email: "a@b.test" },
        data_request: { id: 77 },
      }),
      null,
    ],
    ["shop/redact", JSON.stringify({ shop_id: 987, shop_domain: shop }), { shopId: "987" }],
  ]) {
    const v = decodeShopifyWebhookVerdict(
      await h.broker.webhookVerify(
        h.env,
        appKey,
        headers({ "x-shopify-topic": topic, "x-shopify-webhook-id": randomUUID() }, text),
        Buffer.from(text).toString("base64"),
      ),
    );
    assert.equal(v.verdict, "recorded", topic);
    const last = h.db.recorded.at(-1).body;
    if (expected) assert.deepEqual(last, expected, topic);
    else {
      assert.deepEqual(Object.keys(last).sort(), ["customerDigest", "dataRequestId", "shopId"]);
      assert.equal(last.dataRequestId, "77");
    }
  }
  assert.doesNotMatch(JSON.stringify(h.db.recorded), /a@b\.test|o@x\.test|"Dev"/);
  // An app the registry does not hold for this shop is refused, and the database's own
  // refusal of a body is invalid.
  h.db.registered = false;
  const refusedText = JSON.stringify({ shop_id: 987, shop_domain: shop });
  assert.equal(
    decodeShopifyWebhookVerdict(
      await h.broker.webhookVerify(
        h.env,
        appKey,
        headers(
          { "x-shopify-topic": "shop/redact", "x-shopify-webhook-id": randomUUID() },
          refusedText,
        ),
        Buffer.from(refusedText).toString("base64"),
      ),
    ).verdict,
    "refused",
  );
  const strict = await harness({ recordInvalid: true });
  assert.equal(
    decodeShopifyWebhookVerdict(
      await strict.broker.webhookVerify(
        strict.env,
        appKey,
        headers({ "x-shopify-topic": "shop/redact" }, refusedText),
        Buffer.from(refusedText).toString("base64"),
      ),
    ).verdict,
    "invalid",
  );
  // A signature header that is not base64 of 32 bytes opens no vault transaction.
  h.db.transactions = 0;
  for (const value of ["x".repeat(44), "a".repeat(64), "=" + "A".repeat(43)])
    assert.equal(
      decodeShopifyWebhookVerdict(
        await h.broker.webhookVerify(
          h.env,
          appKey,
          headers({ "x-shopify-hmac-sha256": value }),
          raw,
        ),
      ).verdict,
      "refused",
    );
  assert.equal(h.db.transactions, 0);
});

test("webhooks: a lost COMMIT acknowledgement of the record is OUTCOME_UNKNOWN, never a verdict", async () => {
  const h = await harness({ loseCommit: 0 });
  const text = JSON.stringify({ shop_id: 987, shop_domain: shop });
  const headers = JSON.stringify({
    "x-shopify-api-version": "2026-10",
    "x-shopify-hmac-sha256": createHmac("sha256", secret).update(text).digest("base64"),
    "x-shopify-shop-domain": shop,
    "x-shopify-topic": "shop/redact",
    "x-shopify-webhook-id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
  });
  await assert.rejects(
    () => h.broker.webhookVerify(h.env, appKey, headers, Buffer.from(text).toString("base64")),
    (error) => error.code === "OUTCOME_UNKNOWN",
  );
  // The redelivery finds the row the lost COMMIT wrote.
  assert.equal(
    decodeShopifyWebhookVerdict(
      await h.broker.webhookVerify(h.env, appKey, headers, Buffer.from(text).toString("base64")),
    ).verdict,
    "duplicate",
  );
});

test("credential destruction: ids and a known reason only, one vault statement, closed result", async () => {
  const h = await harness();
  const installation = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    decodeShopifyCredentialResult(
      await h.broker.credentialDestroy(h.env, installation, "uninstalled"),
    ),
    "destroyed",
  );
  assert.deepEqual(h.db.events, ["destroy:" + installation + ":uninstalled"]);
  for (const outcome of ["already_destroyed", "ineligible", "not_found"]) {
    h.db.destroyOutcome = outcome;
    assert.equal(
      decodeShopifyCredentialResult(
        await h.broker.credentialDestroy(h.env, installation, "scopes_changed"),
      ),
      outcome,
    );
  }
  h.db.destroyOutcome = "denied";
  await assert.rejects(() => h.broker.credentialDestroy(h.env, installation, "uninstalled"));
  for (const [id, reason] of [
    [installation, "reauthorised"],
    [installation, "UNINSTALLED"],
    ["bad id!", "uninstalled"],
    [7, "uninstalled"],
    [installation, null],
  ])
    await assert.rejects(
      () => h.broker.credentialDestroy(h.env, id, reason),
      (error) => error.code === "INPUT_INVALID",
    );
  const lost = await harness({ loseCommit: 0 });
  await assert.rejects(
    () => lost.broker.credentialDestroy(lost.env, installation, "uninstalled"),
    (error) => error.code === "OUTCOME_UNKNOWN",
  );
  await assert.rejects(() =>
    h.broker.credentialDestroy(
      { ...env(), MORROW_ENVIRONMENT: "production" },
      installation,
      "uninstalled",
    ),
  );
});

// ---------------------------------------------------------------------------
// The vault transport (vault-database.ts) over a faked driver.
function fakeDriver(options = {}) {
  const sent = [];
  let config;
  const driver = (c) => {
    config = c;
    return {
      async connect() {
        new c.socket(`wss://${c.hostname}/v2?address=${c.hostname}:5432`);
      },
      async query(text, values) {
        sent.push(text);
        if (options.fail === text) throw new Error("server error");
        if (text === vaultTransactionSql.commit && options.loseCommit)
          throw new Error("socket closed");
        if (text === vaultTransactionSql.role)
          return {
            rows: [
              {
                role: options.role ?? "morrow_vault_broker",
                login: "morrow_vault_broker",
                rolsuper: false,
                rolbypassrls: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                rolinherit: false,
                role_member: options.member ?? false,
              },
            ],
          };
        if (text === vaultStatements.appSecretGet) return { rows: [{ values }] };
        return { rows: [] };
      },
      async end() {
        sent.push("end");
        if (options.endHangs) await new Promise(() => {});
      },
      on() {},
    };
  };
  class Socket {
    static opened = [];
    constructor(url) {
      Socket.opened.push(url);
    }
    close() {}
  }
  return { driver, sent, Socket, config: () => config };
}
const vaultCapability = async () => ({
  keyring: await createVaultKeyring("development", new Map([[1, kek]])),
  databasePassword: "vault-password-0123456789",
  binding,
});

test("transport: one Client as the vault login, preflight, timeouts, registered statements, COMMIT", async () => {
  const f = fakeDriver();
  const vault = await vaultCapability();
  const value = await runVaultTransactionWithDriver(
    f.driver,
    vault,
    3000,
    async (query) => {
      const rows = await query(vaultStatements.appSecretGet, ["app-1"]);
      return rows[0].values;
    },
    Date.now,
    f.Socket,
  );
  assert.deepEqual(value, ["app-1"]);
  assert.equal(f.config().user, "morrow_vault_broker");
  assert.equal(f.config().password, "vault-password-0123456789");
  assert.equal(f.config().hostname, binding.hostname);
  assert.deepEqual(f.Socket.opened, [
    `wss://${binding.hostname}/v2?address=${binding.hostname}:5432`,
  ]);
  assert.deepEqual(f.sent, [
    vaultTransactionSql.begin,
    vaultTransactionSql.role,
    vaultTransactionSql.statementTimeout,
    vaultTransactionSql.lockTimeout,
    vaultTransactionSql.idleTimeout,
    vaultStatements.appSecretGet,
    vaultTransactionSql.commit,
    "end",
  ]);
});

test("transport: refusals are fixed VaultError codes; a lost COMMIT is VAULT_OUTCOME_UNKNOWN", async () => {
  const vault = await vaultCapability();
  const code = async (
    f,
    body = async (q) => q(vaultStatements.appSecretGet, ["a"]),
    budget = 3000,
  ) => {
    try {
      await runVaultTransactionWithDriver(f.driver, vault, budget, body, Date.now, f.Socket);
      return "ok";
    } catch (error) {
      assert.ok(error instanceof VaultError);
      assert.ok(!String(error.message).includes("vault-password"));
      return error.code;
    }
  };
  assert.equal(await code(fakeDriver(), async (q) => q("SELECT 1", [])), "VAULT_STATEMENT_DENIED");
  assert.equal(
    await code(fakeDriver(), async (q) => q(vaultStatements.appSecretGet, [1])),
    "VAULT_STATEMENT_DENIED",
  );
  assert.equal(
    await code(fakeDriver(), async (q) => q(vaultStatements.appSecretGet, [])),
    "VAULT_STATEMENT_DENIED",
  );
  assert.equal(await code(fakeDriver({ role: "morrow_api" })), "VAULT_DATABASE_UNAVAILABLE");
  assert.equal(await code(fakeDriver({ member: true })), "VAULT_DATABASE_UNAVAILABLE");
  assert.equal(
    await code(fakeDriver({ fail: vaultStatements.appSecretGet })),
    "VAULT_DATABASE_UNAVAILABLE",
  );
  assert.equal(await code(fakeDriver({ loseCommit: true })), "VAULT_OUTCOME_UNKNOWN");
  for (const budget of [0, 10001, 2.5])
    assert.equal(await code(fakeDriver(), undefined, budget), "VAULT_INPUT_INVALID");
  // A body failure rolls back; nothing is committed.
  const f = fakeDriver();
  assert.equal(
    await code(f, async () => {
      throw new VaultError("VAULT_RECORD_INVALID");
    }),
    "VAULT_RECORD_INVALID",
  );
  assert.ok(
    f.sent.includes(vaultTransactionSql.rollback) && !f.sent.includes(vaultTransactionSql.commit),
  );
});

test("transport: a committed value is returned by the deadline even when the close hangs", async () => {
  const vault = await vaultCapability();
  const f = fakeDriver({ endHangs: true });
  const started = Date.now();
  const value = await runVaultTransactionWithDriver(
    f.driver,
    vault,
    300,
    async (query) => (await query(vaultStatements.appSecretGet, ["app-1"]))[0].values,
    Date.now,
    f.Socket,
  );
  assert.deepEqual(value, ["app-1"]);
  assert.ok(f.sent.includes(vaultTransactionSql.commit) && f.sent.includes("end"));
  // Bounded by the 300 ms budget, not by the 1 s close allowance.
  assert.ok(Date.now() - started < 800, "returned within the budget");
});
