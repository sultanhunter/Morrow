// lab:shopify-query-cost (plan row SD5; docs/briefs/sd5-shopify-query-cost.md): the per-shop
// buckets of Shopify's API query cost (Shopify's rate limit in its cost points, never money)
// against PostgreSQL 17 with the whole migration manifest applied by the Neon-shaped createrole
// administrator. The broker's real TypeScript runs on the vault login's transport
// (runVaultTransactionWithDriver as morrow_vault_broker over psql bridges), with the switch on
// in this lab's own broker environment (never a committed one), against the synthetic Shopify
// with its leaky bucket on. It proves:
//   Q1 only the broker's login runs the two definers; every other login is refused, and the
//      broker's login reaches no table or helper directly;
//   Q2 the first take creates the bucket at Shopify's smallest published bucket, in the
//      tenant of the installation row (never the caller's), and an unknown installation, a
//      class outside the list or a cost past the dearest document records nothing;
//   Q3 priority: on one bucket a person read is admitted where an agent read must wait,
//      reconciliation and bulk wait longer still, a write is never told to wait (down to 0),
//      and a document dearer than its class could ever be given is too_costly;
//   Q4 the settle refunds what the reply proves unused, adopts Shopify's capacity and rate,
//      never keeps more than Shopify reported, counts THROTTLED replies, and refuses values
//      outside the safety ranges;
//   Q5 a background read never delays an approved write: agent reads hammering one store
//      through bucketedShopifyCall park instead of failing, Shopify never throttles anything,
//      every write's take is admitted at once and Shopify answers every write, and no read
//      ever took Shopify's real bucket below the agents' share;
//   Q6 the catalogue route with the switch on: a person read is charged and settled; one the
//      bucket cannot cover within the budget is 429 with Retry-After and is never sent;
//   Q7 a stale model (another client drained Shopify's bucket): Shopify answers THROTTLED,
//      the settle corrects the bucket from the throttleStatus, and the read waits in the
//      broker and succeeds;
//   Q8 tenant isolation: the session template reads only its own tenant's buckets and writes
//      none; a forged setting outside the broker's session reaches nothing;
//   Q9 the guard: no delete or truncate, revisions and clocks forward only, counts only grow;
//   Q10 the policy in SQL equals the broker's (drift);
//   Q11 the broker's init line names the switch; the protocol decodes every parked reply.
// Synthetic fixtures only; no provider, credential or merchant data. Run by
// `npm run lab:shopify-query-cost` (CI's postgres `http` leg).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createShopifyReader } from "../../apps/broker/src/shopify-read.ts";
import {
  bucketedShopifyCall,
  queryCostClasses,
  settleShopifyQueryCost,
  shopifyQueryCostPolicy,
  takeShopifyQueryCost,
} from "../../apps/broker/src/shopify-query-cost.ts";
import { shopifyAdminGraphqlOnce, shopifyReadDocuments } from "../../apps/broker/src/shopify.ts";
import { shopifyAdminWrite, shopifyWriteDocuments } from "../../apps/broker/src/shopify-write.ts";
import { brokerCapabilities } from "../../apps/broker/src/capabilities.ts";
import { createVaultKeyring, sealVaultRecord, vaultBytesHex } from "../../apps/broker/src/vault.ts";
import { runVaultTransactionWithDriver } from "../../apps/broker/src/vault-database.ts";
import { decodeShopifyReadResult } from "../../packages/identity/src/broker-protocol.ts";
import { createCatalogApiHandler } from "../../packages/work/src/catalog/http.ts";
import { listingFieldPaths, storeResource } from "../../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../../packages/contracts/src/validation.ts";
import {
  asCommandRole,
  literal,
  seedWorkFixtures,
  sha,
  sleep,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
} from "../tenant-conformance/harness.mjs";
import { createShopifyOracle } from "../../scripts/fixtures/shopify-oracle.mjs";

const kek = randomBytes(32).toString("hex");
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-query-cost-lab",
  branchId: "br-query-cost-lab",
  hostname: "ep-query-cost-lab.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
// This lab's own broker environment, with the switch on (the committed record is off).
const brokerEnv = {
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "lab-vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
  MORROW_SHOPIFY_QUERY_COST: "on",
};
let db, release, started, P, vault, transaction, reader, catalog;
const stores = {};
const oracles = new Map();
// A one-shot change to a shop's synthetic Shopify just before the broker's next call (Q7).
const beforeFetch = new Map();
const consoleLines = [];

before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  started = withWorkDatabase(
    "SD5.shopify-query-cost",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole" },
  );
  await Promise.race([opened, started]);
  P = seedWorkFixtures(db);
  // Four linked development stores: S (catalogue reads), B (the background and write case)
  // and Z (the guard) in A's tenant; T in Y's tenant.
  const specs = {
    S: { owner: P.A, store: "store_qc_s" },
    B: { owner: P.A, store: "store_qc_b" },
    Z: { owner: P.A, store: "store_qc_z" },
    T: { owner: P.Y, store: "store_qc_t" },
  };
  const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
  const statements = [];
  for (const [key, spec] of Object.entries(specs)) {
    const s = { key, ...spec };
    s.org = s.owner.org;
    s.ws = s.owner.workspace;
    s.connection = s.store.replace(/^store_/, "connection_");
    s.installation = s.store.replace(/^store_/, "storeinst_");
    const storeKey = s.store.replaceAll("_", "-");
    s.appKey = ("lab-" + storeKey).slice(0, 63);
    s.shop = s.appKey + ".myshopify.com";
    s.shopId = String(BigInt("0x" + sha(s.store).slice(0, 12)) + 1n);
    s.credential = "credential_" + s.installation;
    s.token = "shpat_" + randomBytes(16).toString("hex");
    stores[key] = s;
    statements.push(
      storeInstallationSql({
        org: s.org,
        workspace: s.ws,
        principal: s.owner.principal,
        storeId: s.store,
        connectionId: s.connection,
        installationId: s.installation,
      }),
    );
  }
  db.admin(statements.join("\n"));
  // A's catalogue read grant on S (the store-link template issues it at link).
  const actor = {
    kind: "human",
    principalId: P.A.principal,
    organizationId: P.A.org,
    workspaceId: P.A.workspace,
    membershipId: P.A.membership,
    installationId: null,
    mandateId: null,
  };
  const grant = {
    id: "g_a_catalog_read_qc",
    principal: actor,
    capabilityId: "catalog.products.read",
    verbs: ["view", "delegate"],
    scope: {
      organizationId: P.A.org,
      workspaceId: P.A.workspace,
      storeIds: [stores.S.store],
      accountIds: [],
      resources: [storeResource(P.A.org, P.A.workspace, stores.S.store, stores.S.connection)],
      fields: [...listingFieldPaths],
    },
    issuedBy: { ...actor, kind: "service", principalId: "morrow.linking", membershipId: null },
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  };
  if (!validateCurrentDefinition("Grant", grant)) throw Error("LAB_GRANT_INVALID");
  db.admin(
    `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(grant.id)},${literal(P.A.org)},${literal(P.A.workspace)},${literal(P.A.membership)},${literal(P.A.principal)},${literal(JSON.stringify(grant))}::jsonb);`,
  );
  // Each installation's sealed offline token, and its synthetic Shopify (bucket off until a
  // case turns it on).
  for (const s of Object.values(stores)) {
    const sealed = await sealVaultRecord(
      keyring,
      {
        kind: "shopify_offline_token",
        organizationId: s.org,
        workspaceId: s.ws,
        credentialId: s.credential,
        subjectId: s.installation,
        provider: "shopify",
        version: 1,
      },
      new TextEncoder().encode(s.token),
    );
    db.workOwner(
      `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at) VALUES(${literal(s.org)},${literal(s.ws)},${literal(s.credential)},1,'shopify','shopify_offline_token',${literal(s.installation)},'active',1,${literal("\\x" + vaultBytesHex(sealed.wrappedKey))}::bytea,${literal("\\x" + vaultBytesHex(sealed.sealedValue))}::bytea,date_trunc('milliseconds',clock_timestamp()));`,
    );
    s.oracle = createShopifyOracle({
      secret: "shpss_" + randomBytes(16).toString("hex"),
      clientId: randomBytes(16).toString("hex"),
      shop: s.shop,
      shopId: s.shopId,
    });
    s.oracle.state.tokens.push(s.token);
    oracles.set(s.shop, s.oracle);
  }
  // The vault login's transport: one psql connection per transaction, as the broker's login.
  const bridged = (config) => {
    let connection;
    return {
      async connect() {
        connection = await db.connector({ user: config.user }).open({
          signal: new AbortController().signal,
          deadlineMs: Date.now() + 60000,
          waitUntil() {},
        });
      },
      query: (text, values = []) =>
        connection.query(text, [...values], new AbortController().signal),
      async end() {
        await connection?.close();
      },
      on() {},
    };
  };
  const NoSocket = class {
    close() {}
  };
  // Loaded hosts: each vault transaction's budget is stretched (the transport caps it).
  transaction = (v, budgetMs, body) =>
    runVaultTransactionWithDriver(
      bridged,
      v,
      Math.min(10000, budgetMs * 3),
      body,
      Date.now,
      NoSocket,
    );
  const shopifyFetch = (url, init) => {
    const host = new URL(url).host;
    const hook = beforeFetch.get(host);
    if (hook) {
      beforeFetch.delete(host);
      hook();
    }
    const oracle = oracles.get(host);
    return oracle ? oracle.fetch(url, init) : Promise.resolve(new Response(null, { status: 502 }));
  };
  const log = console.log;
  console.log = (...args) => consoleLines.push(args.map(String).join(" "));
  try {
    vault = (await brokerCapabilities(brokerEnv)).vault;
  } finally {
    console.log = log;
  }
  assert.ok(vault, "the lab broker's vault capability");
  reader = createShopifyReader({ transaction, fetch: shopifyFetch, now: () => Date.now() });
  catalog = createCatalogApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: () => Date.now(),
    reader: {
      read: (lease, queryName, variablesJson, _signal, budgetMs) =>
        reader.read(
          brokerEnv,
          "api",
          lease.leaseId,
          lease.generation,
          lease.subjectId,
          queryName,
          variablesJson,
          budgetMs,
        ),
    },
  });
});
after(async () => {
  release?.();
  await started;
});

// ---------------------------------------------------------------------------
// Helpers.
const transact = (body) => transaction(vault, 3000, body);
const take = (s, cls, cost) =>
  transact((query) => takeShopifyQueryCost(query, s.installation, cls, cost));
const settle = (s, charged, report, throttled) =>
  transact((query) => settleShopifyQueryCost(query, s.installation, charged, report, throttled));
const asBroker = (call) =>
  db.rows(`SELECT * FROM ${call}`, { user: "morrow_vault_broker" })[0] ?? null;
const bucketOf = (s) =>
  db.rows(
    `SELECT organization_id::text AS org,workspace_id::text AS ws,provider,subject_id::text AS subject,unit,capacity::float8 AS capacity,restore_rate::float8 AS rate,available::float8 AS available,observed_at IS NOT NULL AS observed,admitted_count::int AS admitted,waited_count::int AS waited,throttled_count::int AS throttled,revision::int AS revision FROM morrow_work.rate_buckets WHERE subject_id=${literal(s.installation)}`,
    { role: "morrow_work_owner" },
  )[0] ?? null;
// Owner maintenance (the guard admits it: revision+1, clocks forward).
const setBucket = (s, { capacity, rate, available }) =>
  db.workOwner(
    `UPDATE morrow_work.rate_buckets SET capacity=${capacity},restore_rate=${rate},available=${available},as_of=greatest(as_of,date_trunc('milliseconds',clock_timestamp())),revision=revision+1 WHERE subject_id=${literal(s.installation)};`,
  );
const quietly = async (body) => {
  const log = console.log;
  console.log = (...args) => consoleLines.push(args.map(String).join(" "));
  try {
    return await body();
  } finally {
    console.log = log;
  }
};
async function catalogRead(p, s, route) {
  const response = await quietly(() =>
    catalog.fetch(
      new Request(
        `${workFixtureOrigin}/workspace/${p.workspace}/stores/${s.store}/catalog/${route}`,
        {
          headers: {
            Cookie: "__Host-morrow_session=" + p.secret,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
          },
        },
      ),
      {},
      { waitUntil() {} },
    ),
  );
  let body = null;
  try {
    body = await response.json();
  } catch {}
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body };
}
const graphqlCalls = (s) => s.oracle.state.calls.filter((c) => c.operation);

// ---------------------------------------------------------------------------
test("Q1: only the broker's login runs the definers; it reaches no table or helper directly", () => {
  const { S } = stores;
  const takeSql = `SELECT * FROM morrow_vault.shopify_query_cost_take(${literal(S.installation)},'person_read','2');`;
  const settleSql = `SELECT morrow_vault.shopify_query_cost_settle(${literal(S.installation)},'2',NULL,NULL,NULL,NULL,'false');`;
  for (const user of ["morrow_api_worker", "morrow_runtime_executor", "morrow_connector_ingress"]) {
    assert.equal(db.tryRun(takeSql, { user }).ok, false, user);
    assert.equal(db.tryRun(settleSql, { user }).ok, false, user);
  }
  // Another session user (the local superuser here) is answered `denied` by the guard.
  assert.equal(
    db.rows(
      `SELECT * FROM morrow_vault.shopify_query_cost_take(${literal(S.installation)},'person_read','2')`,
    )[0].outcome,
    "denied",
  );
  for (const statement of [
    "SELECT count(*) FROM morrow_work.rate_buckets;",
    `SELECT * FROM morrow_work.rate_bucket_take('org_o','ws_w','shopify',${literal(S.installation)},'write',1);`,
    "SELECT * FROM morrow_work.rate_bucket_policy();",
  ])
    assert.equal(db.tryRun(statement, { user: "morrow_vault_broker" }).ok, false, statement);
  assert.equal(bucketOf(S), null, "nothing was written");
});

test("Q2: the first take creates the bucket in the installation's tenant; bad inputs record nothing", async () => {
  const { S, T } = stores;
  assert.deepEqual(await take(S, "person_read", 27), { kind: "admitted" });
  const s = bucketOf(S);
  assert.equal(s.org, S.org);
  assert.equal(s.ws, S.ws);
  assert.equal(s.provider, "shopify");
  assert.equal(s.unit, "query_cost_points");
  assert.equal(s.capacity, shopifyQueryCostPolicy.defaultCapacity);
  assert.equal(s.rate, shopifyQueryCostPolicy.defaultRestoreRate);
  assert.equal(s.available, shopifyQueryCostPolicy.defaultCapacity - 27);
  assert.equal(s.admitted, 1);
  assert.equal(s.revision, 2);
  // The other tenant's installation gets its own bucket in its own tenant.
  assert.deepEqual(await take(T, "agent_read", 2), { kind: "admitted" });
  assert.equal(bucketOf(T).org, T.org);
  assert.equal(bucketOf(T).ws, T.ws);
  // An unknown installation, a malformed id, a class outside the list, a cost past the
  // dearest document: no row.
  for (const [installation, cls, cost, outcome] of [
    ["storeinst_unknown", "person_read", "2", "not_found"],
    ["has space", "person_read", "2", "invalid"],
    [S.installation, "everything", "2", "invalid"],
    [S.installation, "person_read", "0", "invalid"],
    [S.installation, "person_read", "1001", "invalid"],
    [S.installation, "person_read", "2.5", "invalid"],
  ])
    assert.equal(
      asBroker(
        `morrow_vault.shopify_query_cost_take(${literal(installation)},${literal(cls)},${literal(cost)})`,
      ).outcome,
      outcome,
      installation + " " + cls + " " + cost,
    );
  assert.equal(
    db.rows("SELECT count(*)::int AS n FROM morrow_work.rate_buckets", {
      role: "morrow_work_owner",
    })[0].n,
    2,
  );
  assert.equal(bucketOf(S).revision, 2, "a refused take changes nothing");
});

test("Q3: priority classes on one bucket; a write never waits; too_costly", async () => {
  const { S } = stores;
  // A slow bucket (1 point a second) so the clock barely moves the numbers.
  setBucket(S, { capacity: 1000, rate: 1, available: 310 });
  const agent = await take(S, "agent_read", 27);
  assert.equal(agent.kind, "wait", "310 - 27 is below the agents' 300");
  assert.ok(agent.waitMs >= 1 && agent.waitMs <= 17_000, String(agent.waitMs));
  const reconciliation = await take(S, "reconciliation", 27);
  const bulk = await take(S, "bulk", 27);
  assert.equal(reconciliation.kind, "wait");
  assert.equal(bulk.kind, "wait");
  assert.ok(agent.waitMs < reconciliation.waitMs && reconciliation.waitMs < bulk.waitMs);
  assert.ok(reconciliation.waitMs - agent.waitMs >= 190_000, "200 points more at 1 a second");
  // A person read is admitted on the same bucket (it leaves the 100 writes need).
  assert.deepEqual(await take(S, "person_read", 27), { kind: "admitted" });
  const b = bucketOf(S);
  assert.ok(b.available >= 283 && b.available < 305, String(b.available));
  assert.equal(b.waited, 3);
  // A write is admitted even with fewer points than it costs, down to 0, and never waits.
  setBucket(S, { capacity: 1000, rate: 1, available: 0 });
  assert.deepEqual(await take(S, "write", 10), { kind: "admitted" });
  assert.ok(bucketOf(S).available < 1);
  assert.deepEqual(await take(S, "write", 10), { kind: "admitted" });
  // A person read now waits for the writes' 100 plus its own cost.
  const person = await take(S, "person_read", 27);
  assert.equal(person.kind, "wait");
  assert.ok(person.waitMs >= 100_000, String(person.waitMs));
  // A document dearer than its class could ever be given.
  assert.deepEqual(await take(S, "bulk", 400), { kind: "refused", reason: "too_costly" });
  assert.deepEqual(await take(S, "agent_read", 701), { kind: "refused", reason: "too_costly" });
  setBucket(S, { capacity: 1000, rate: 1, available: 1000 });
  assert.deepEqual(await take(S, "write", 1000), { kind: "admitted" });
});

test("Q4: the settle refunds, adopts Shopify's report, never keeps more than Shopify said", async () => {
  const { S, T, Z } = stores;
  setBucket(S, { capacity: 1000, rate: 1, available: 900 });
  const report = (over = {}) => ({
    requested: 27,
    actual: 20,
    available: 950,
    maximum: 2000,
    restoreRate: 100,
    ...over,
  });
  assert.equal(await settle(S, 27, report(), false), "settled");
  let b = bucketOf(S);
  assert.equal(b.capacity, 2000);
  assert.equal(b.rate, 100);
  assert.ok(b.available >= 907 && b.available < 925, "900 + the 7 points unused: " + b.available);
  assert.equal(b.observed, true);
  // Shopify reports fewer points than the model: the model follows Shopify down.
  assert.equal(await settle(S, 27, report({ available: 120 }), false), "settled");
  b = bucketOf(S);
  assert.ok(b.available >= 120 && b.available <= 120.1, String(b.available));
  // THROTTLED refunds the whole charge, takes Shopify's count, and is counted.
  assert.equal(await settle(S, 27, { ...report({ available: 3 }), actual: null }, true), "settled");
  b = bucketOf(S);
  assert.ok(b.available >= 3 && b.available < 4, String(b.available));
  assert.equal(b.throttled, 1);
  // No report: the refund only (never more than capacity).
  setBucket(S, { capacity: 1000, rate: 1, available: 990 });
  assert.equal(
    await settle(S, 27, { ...report(), available: null, maximum: null, restoreRate: null }, false),
    "settled",
  );
  b = bucketOf(S);
  assert.ok(b.available >= 997 && b.available <= 1000, String(b.available));
  assert.equal(b.capacity, 1000);
  // Values outside the safety ranges are refused by SQL (the broker drops them first).
  const revision = bucketOf(S).revision;
  for (const args of [
    "'27','20','10','50','100','false'",
    "'27','20','10','2000','0','false'",
    "'27','20','1000001','2000','100','false'",
    "'1001','20','10','2000','100','false'",
    "'27','1001','10','2000','100','false'",
    "'27','20','-1','2000','100','false'",
    "'27','20','10','2000','100','yes'",
  ])
    assert.equal(
      asBroker(
        `morrow_vault.shopify_query_cost_settle(${literal(S.installation)},${args}) AS outcome`,
      ).outcome,
      "invalid",
      args,
    );
  assert.equal(bucketOf(S).revision, revision);
  // A settle before any take (no bucket) records nothing; another tenant's settle touches
  // only its own bucket.
  assert.equal(await settle(Z, 2, report(), false), "not_found");
  assert.equal(bucketOf(Z), null);
  const before = bucketOf(S).revision;
  assert.equal(await settle(T, 2, report({ available: 500 }), false), "settled");
  assert.equal(bucketOf(S).revision, before);
});

test("Q5: a background read never delays an approved write", async () => {
  const { B } = stores;
  // Morrow's model and Shopify's bucket for this app and shop, equal at the start: 400 of
  // 1,000 points restored at 5 a second, so the six readers below reach the agents' share
  // (300) after a few reads even on a loaded host.
  assert.deepEqual(await take(B, "write", 1), { kind: "admitted" });
  setBucket(B, { capacity: 1000, rate: 5, available: 400 });
  B.oracle.state.bucket = { maximum: 1000, restoreRate: 5, available: 400, at: Date.now() };
  const background = { replies: 0, parked: 0, refused: 0, failed: 0 };
  const sendRead = async () => {
    const attempt = await shopifyAdminGraphqlOnce(
      (url, init) => B.oracle.fetch(url, init),
      B.shop,
      B.token,
      shopifyReadDocuments.productsPage,
      { first: 25, after: null, query: null },
      Date.now() + 10000,
    );
    const answered = attempt.kind === "data" || attempt.kind === "throttled";
    return {
      reply: attempt,
      cost: answered ? attempt.cost : null,
      throttled: attempt.kind === "throttled",
      answered,
    };
  };
  let running = true;
  const loop = async () => {
    while (running) {
      const outcome = await bucketedShopifyCall({
        installationId: B.installation,
        cls: "agent_read",
        cost: 27,
        deadlineMs: Date.now() + 15000,
        now: Date.now,
        sleep,
        transact,
        send: sendRead,
      }).catch(() => ({ kind: "failed" }));
      if (outcome.kind === "reply")
        background[outcome.reply.kind === "data" ? "replies" : "failed"]++;
      else if (outcome.kind === "parked") {
        background.parked++;
        await sleep(Math.min(outcome.retryAfterMs, 400));
      } else background[outcome.kind === "refused" ? "refused" : "failed"]++;
    }
  };
  const loops = Array.from({ length: 6 }, loop);
  // Approved writes while the background reads run and are already parking: the gateway's
  // write class, then the gateway's fixed mutation through its own transport.
  const writes = [];
  for (let waited = 0; background.parked < 2 && waited < 60_000; waited += 100) await sleep(100);
  for (let i = 0; i < 4; i++) {
    const taken = await take(B, "write", 10);
    const reply = await shopifyAdminWrite(
      (url, init) => B.oracle.fetch(url, init),
      B.shop,
      B.token,
      shopifyWriteDocuments.productUpdate,
      { product: { id: "gid://shopify/Product/10" + (i + 1), title: "Approved title " + i } },
      Date.now() + 10000,
    );
    writes.push({ taken, reply: reply.kind });
    await sleep(500);
  }
  running = false;
  await Promise.all(loops);
  // Every write was admitted by the bucket at once and answered by Shopify.
  assert.deepEqual(
    writes.map((w) => [w.taken.kind, w.reply]),
    writes.map(() => ["admitted", "data"]),
  );
  // The background reads were under real pressure, parked instead of failing, and Shopify
  // never had to throttle anyone.
  assert.ok(background.replies >= 3, JSON.stringify(background));
  assert.ok(background.parked >= 2, JSON.stringify(background));
  assert.equal(background.refused, 0, JSON.stringify(background));
  assert.equal(background.failed, 0, JSON.stringify(background));
  assert.deepEqual(B.oracle.state.throttled, []);
  // No read ever took Shopify's real bucket below the agents' share (300 of 1,000), less
  // the one write that may be in flight beside it, so a write always found its points.
  const reads = B.oracle.state.charges.filter((c) => c.operation === "ProductsPage");
  const productWrites = B.oracle.state.charges.filter((c) => c.operation === "ProductUpdate");
  assert.equal(productWrites.length, 4);
  assert.ok(reads.length === background.replies);
  const lowest = Math.min(...reads.map((c) => c.left));
  assert.ok(lowest >= 300 - 10 - 1, "lowest " + lowest);
  // The model followed Shopify: its capacity and rate are Shopify's report.
  const b = bucketOf(B);
  assert.equal(b.capacity, 1000);
  assert.equal(b.rate, 5);
  assert.ok(b.waited >= 1 && b.admitted >= background.replies + 5);
  B.oracle.state.bucket = null;
});

test("Q6: the catalogue route with the switch on: charged and settled; parked as 429, never sent", async () => {
  const { S } = stores;
  setBucket(S, { capacity: 1000, rate: 50, available: 1000 });
  S.oracle.state.bucket = { maximum: 1000, restoreRate: 50, available: 1000, at: Date.now() };
  const first = await catalogRead(P.A, S, "collections");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.collections, [
    { id: "collection:11", title: "Summer" },
    { id: "collection:12", title: "Winter" },
  ]);
  const after1 = bucketOf(S);
  assert.ok(after1.available <= 1000 - 27 + 5 && after1.available >= 900, String(after1.available));
  assert.equal(after1.observed, true);
  // A bucket that cannot cover the read within its budget: 429 with Retry-After, never sent.
  setBucket(S, { capacity: 1000, rate: 1, available: 0 });
  const callsBefore = graphqlCalls(S).length;
  const parked = await catalogRead(P.A, S, "collections");
  assert.equal(parked.status, 429, JSON.stringify(parked.body));
  assert.equal(parked.body.code, "rate_limited");
  assert.ok(
    Number(parked.retryAfter) >= 120 && Number(parked.retryAfter) <= 128,
    parked.retryAfter,
  );
  assert.equal(parked.body.retryAfterSeconds, Number(parked.retryAfter));
  assert.equal(graphqlCalls(S).length, callsBefore, "nothing reached Shopify");
  assert.ok(consoleLines.some((l) => l.includes('"outcome":"read_parked"')));
});

test("Q7: a stale model: Shopify answers THROTTLED, the settle corrects it, the read waits and succeeds", async () => {
  const { S } = stores;
  setBucket(S, { capacity: 1000, rate: 100, available: 1000 });
  S.oracle.state.bucket = { maximum: 1000, restoreRate: 100, available: 1000, at: Date.now() };
  S.oracle.state.throttled = [];
  // Another client of the same app drained Shopify's bucket just before the send: Morrow's
  // model still says 1,000.
  beforeFetch.set(S.shop, () => {
    S.oracle.state.bucket.available = 0;
    S.oracle.state.bucket.at = Date.now();
  });
  const throttledBefore = bucketOf(S).throttled;
  const r = await catalogRead(P.A, S, "collections");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(S.oracle.state.throttled.length, 1, "Shopify throttled the first send once");
  const b = bucketOf(S);
  assert.equal(b.throttled, throttledBefore + 1);
  assert.equal(b.capacity, 1000);
  assert.equal(b.rate, 100);
  assert.ok(b.available < 200, "the model followed Shopify down: " + b.available);
  S.oracle.state.bucket = null;
});

test("Q8: tenant isolation: the session template reads its own tenant only and writes nothing", async () => {
  const { S, T } = stores;
  const visible = (p) =>
    db
      .sql(
        asCommandRole(
          p,
          "SELECT string_agg(subject_id::text,',' ORDER BY subject_id) FROM morrow_work.rate_buckets;",
        ),
      )
      .split("\n")
      .at(-1);
  assert.equal(visible(P.A), [stores.B.installation, S.installation].sort().join(","));
  assert.equal(visible(P.Y), T.installation);
  const updated = db
    .sql(
      asCommandRole(
        P.A,
        "WITH u AS (UPDATE morrow_work.rate_buckets SET available=0,revision=revision+1 RETURNING 1) SELECT count(*) FROM u;",
      ),
    )
    .split("\n")
    .at(-1);
  assert.equal(updated, "0");
  // A forged setting outside the broker's own session reaches nothing.
  const forged = db
    .sql(
      `BEGIN; SELECT set_config('morrow.vault_rate_bucket',${literal(S.org + "|" + S.ws + "|shopify|" + S.installation)},true); SET LOCAL ROLE morrow_work_command; SELECT count(*) FROM morrow_work.rate_buckets; ROLLBACK;`,
    )
    .split("\n")
    .at(-1);
  assert.equal(forged, "0");
  // The policy's exact shape (registered in tests/tenant-conformance/static.test.mjs).
  const [policy] = db.rows(
    "SELECT cmd,roles::text AS roles,qual,with_check FROM pg_policies WHERE schemaname='morrow_work' AND tablename='rate_buckets' AND policyname='broker_rate_bucket'",
  );
  assert.equal(policy.cmd, "ALL");
  assert.equal(policy.roles, "{morrow_work_command}");
  assert.equal(policy.qual, policy.with_check);
  assert.match(policy.qual, /SESSION_USER = 'morrow_vault_broker'::name/);
  assert.match(policy.qual, /current_setting\('morrow\.vault_rate_bucket'::text, true\)/);
  process.env.MORROW_LAB_DEBUG === "1" && process.stderr.write(policy.qual + "\n");
});

test("Q9: the guard: no delete or truncate, revisions and clocks forward, counts only grow", () => {
  const { S } = stores;
  const owner = (statement) => db.tryRun("SET ROLE morrow_work_owner;\n" + statement);
  const where = `WHERE subject_id=${literal(S.installation)}`;
  for (const statement of [
    `DELETE FROM morrow_work.rate_buckets ${where};`,
    "TRUNCATE morrow_work.rate_buckets;",
    `UPDATE morrow_work.rate_buckets SET available=1 ${where};`,
    `UPDATE morrow_work.rate_buckets SET admitted_count=0,revision=revision+1 ${where};`,
    `UPDATE morrow_work.rate_buckets SET as_of=as_of-interval '1 second',revision=revision+1 ${where};`,
    `UPDATE morrow_work.rate_buckets SET organization_id='org_p',revision=revision+1 ${where};`,
    `UPDATE morrow_work.rate_buckets SET available=capacity+1,revision=revision+1 ${where};`,
    `UPDATE morrow_work.rate_buckets SET capacity=99,available=0,revision=revision+1 ${where};`,
  ])
    assert.equal(owner(statement).ok, false, statement);
  assert.ok(bucketOf(S));
});

test("Q10 and Q11: the SQL policy equals the broker's; the init line names the switch", () => {
  const rows = db.rows("SELECT * FROM morrow_work.rate_bucket_policy() ORDER BY priority", {
    role: "morrow_work_owner",
  });
  assert.deepEqual(
    rows.map((r) => [r.class, Number(r.floor_share)]),
    queryCostClasses.map((c) => [c, shopifyQueryCostPolicy.floorShare[c]]),
  );
  for (const r of rows) {
    assert.equal(r.provider, shopifyQueryCostPolicy.provider);
    assert.equal(r.unit, shopifyQueryCostPolicy.unit);
    assert.equal(Number(r.default_capacity), shopifyQueryCostPolicy.defaultCapacity);
    assert.equal(Number(r.default_restore_rate), shopifyQueryCostPolicy.defaultRestoreRate);
    assert.equal(r.max_cost, shopifyQueryCostPolicy.maxCost);
  }
  const init = consoleLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((l) => l?.event === "morrow_broker_init");
  assert.equal(init?.shopifyQueryCost, "on");
  assert.equal(init?.vault, true);
  // No token, password or KEK in any console line.
  const text = consoleLines.join("\n");
  for (const secret of [
    kek,
    brokerEnv.MORROW_DB_PASSWORD_MORROW_VAULT_BROKER,
    ...Object.values(stores).map((s) => s.token),
  ])
    assert.ok(!text.includes(secret));
  assert.deepEqual(
    decodeShopifyReadResult(
      "collectionsPage",
      JSON.stringify({ schemaVersion: 1, outcome: "parked", retryAfterMs: 5 }),
    ),
    { schemaVersion: 1, outcome: "parked", retryAfterMs: 5 },
  );
});
