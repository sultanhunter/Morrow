// M2 PR-3 PostgreSQL 17 laboratory: Shopify webhooks, privacy requests, the token's
// destruction and the catalogue reads (migrations shopify-privacy-identity and
// shopify-privacy-work, located by slug) on an isolated network-none engine with the whole
// manifest applied by the Neon-shaped non-superuser CREATEROLE administrator (ADR-0020 D4).
// The real TypeScript runs against it, in Node:
//   connector  createConnectorHandler (webhooks, the waitUntil apply, the cron's redrive) on
//              its own login's transport (createConnectorDatabase over a psql bridge logged
//              in as morrow_connector_ingress);
//   broker     createShopifyBroker (webhookVerify, credentialDestroy, launchVerify) and
//              createShopifyReader (shopifyRead) on the vault login's transport
//              (runVaultTransactionWithDriver as morrow_vault_broker), with the broker's own
//              capabilities (the lab keyring) and its outbound fetch to the synthetic Shopify;
//   api        createCatalogApiHandler (the catalogue routes) on the api Worker's login
//              (morrow_api_worker) with the reader as its ApiBroker.
// It proves: W  only signature-verified deliveries are recorded, under the registry's tenant
// for the verified shop (never a tenant the sender names); C  customers/* complete "none
// held" and keep no customer value; T  closed catalogue reads under a read lease, closed
// variables, closed results, the vault resolution's refusals and the read budget;
// U  app/uninstalled ends the installation, stops the connection, revokes its leases and
// destroys the token (idempotent, tenant-local); G  scope changes (v1 PR 5: the connection
// and its token stay, and a Reconnect item is raised); D  the cron re-drives a
// lost apply and a failed destruction; S  shop/redact executes every store-content handler
// and completes only when nothing is outstanding, an overdue request is counted and logged,
// an uninstalled installation's app offers its link for a reinstall (v1 PR 5) while a
// redacted one's is cleared, and the redaction clears only its own
// app's link, never a replacement app's in another tenant; K  no other login applies deliveries or
// ends an installation, and the connector's login cannot forge its context; I  the customer
// identifier screen (H9a; ADR-0041 item 31): under a real run lease of the runtime login, an
// agent's knowledge.propose and notebook.write holding the customer customers/* named (its
// email, plain or obfuscated, a phone, a street address, a customer GID) are refused before the
// command and nothing of them reaches any table of any Morrow schema, while a clean text is
// written through the same lease; a post naming that customer is refused content-free;
// O  logs and outbound requests. Owner-seeded synthetic fixtures only (two tenants, four linked
// development stores); no provider, credential or merchant data. Runs in the CI pg-work
// group. The local superuser is used only for fixtures and the shapes marked "sim".
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";
import { createShopifyBroker } from "../apps/broker/src/shopify-install.ts";
import { createShopifyReader } from "../apps/broker/src/shopify-read.ts";
import { sealVaultRecord, createVaultKeyring, vaultBytesHex } from "../apps/broker/src/vault.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import { createConnectorHandler } from "../apps/shopify-connector/worker/connector.ts";
import { createConnectorDatabase } from "../apps/shopify-connector/worker/database.ts";
import {
  decodeShopifyCredentialResult,
  decodeShopifyLaunchVerdict,
  decodeShopifyWebhookVerdict,
  shopifyReadLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createCatalogApiHandler } from "../packages/work/src/catalog/http.ts";
import {
  knowledgeProposeStep,
  notebookWriteStep,
} from "../packages/work/src/knowledge/run-steps.ts";
import { customerDataSafeMessage, screenPost } from "../packages/policy/src/customer-screen.ts";
import { storeContentHandlers } from "../packages/work/src/redaction.ts";
import {
  asApi,
  asCommandRole,
  literal,
  seedWorkFixtures,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
} from "../tests/tenant-conformance/harness.mjs";
import { createShopifyOracle } from "./fixtures/shopify-oracle.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
// jsonb orders object keys by length: compare JSON values canonically.
const same = (a, b) => canonicalize(a) === canonicalize(b);
const checks = [];
const failures = [];
const labStarted = Date.now();
const phase = (value) =>
  console.error(
    "SHOPIFY_PRIVACY_LAB_PHASE:" +
      value +
      " t=" +
      Math.round((Date.now() - labStarted) / 1000) +
      "s",
  );
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("SHOPIFY_PRIVACY_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
  }
  return passed === true;
}
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const files = [".shopify-privacy-identity.sql", ".shopify-privacy-work.sql"].map(
  (slug) => manifest.migrations.find((m) => m.file.endsWith(slug))?.file,
);
if (files.some((f) => !f)) throw Error("SHOPIFY_PRIVACY_LAB_MIGRATIONS_REQUIRED");
const sourceDigests = Object.fromEntries(
  [
    "scripts/shopify-privacy-lab.mjs",
    "scripts/fixtures/shopify-oracle.mjs",
    "apps/shopify-connector/worker/connector.ts",
    "apps/shopify-connector/worker/database.ts",
    "apps/broker/src/shopify-install.ts",
    "apps/broker/src/shopify-read.ts",
    "apps/broker/src/shopify.ts",
    "apps/broker/src/vault-database.ts",
    "packages/identity/src/broker-protocol.ts",
    "packages/work/src/catalog/http.ts",
    "packages/work/src/redaction.ts",
    "packages/work/src/knowledge/run-steps.ts",
    "packages/policy/src/knowledge/tools.ts",
    "packages/policy/src/customer-screen.ts",
    ...files.map((f) => "migrations/" + f),
  ].map((p) => [p, sha(readFileSync(p))]),
);

const kek = randomBytes(32).toString("hex");
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-privacy-lab",
  branchId: "br-privacy-lab",
  hostname: "ep-privacy-lab.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const brokerEnv = {
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "lab-vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
};
const connectorOrigin = "https://connector.lab.example.test";
const customerEmail = "lab-customer-" + randomBytes(6).toString("hex") + "@example.test";
// Phase I's planted customer details: a phone in the UK drama range, a street and a
// customer GID, each unique to this run so a whole-database search finds only what it planted.
const screenPhoneDigits = "447700900" + String(100 + (randomBytes(2).readUInt16BE() % 900));
const screenPhone = "+44 7700 900" + screenPhoneDigits.slice(-3);
const screenStreet = "Quill" + randomBytes(4).toString("hex") + " Street";
const screenGidNumber = "7" + String(randomBytes(6).readUIntBE(0, 6)).padStart(12, "0").slice(-12);
const privateMarkers = [
  kek,
  brokerEnv.MORROW_DB_PASSWORD_MORROW_VAULT_BROKER,
  customerEmail,
  screenPhoneDigits,
  screenStreet,
  screenGidNumber,
];
// Worker console lines are captured: no secret, token or customer value may appear.
const consoleLines = [];
const print = console.log.bind(console);
console.log = (...args) => {
  consoleLines.push(args.map(String).join(" "));
};

const report = await withWorkDatabase(
  "M2PR3.shopify-privacy",
  async (db) => {
    // -------------------------------------------------------------------------
    phase("fixtures");
    db.sql("ALTER ROLE morrow_identity_linking LOGIN;");
    const P = seedWorkFixtures(db);
    const A = P.A,
      X = P.X,
      Y = P.Y;
    // Four linked development stores: S, G (scope changes) and R (shop/redact) in O/W, owned
    // by A; T in the other tenant P/WP, owned by Y.
    const stores = {
      S: { owner: A, store: "store_priv" },
      G: { owner: A, store: "store_scopes" },
      R: { owner: Y, store: "store_redact" },
      T: { owner: Y, store: "store_tenant" },
    };
    const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
    const statements = [];
    for (const s of Object.values(stores)) {
      const key = s.store.replaceAll("_", "-");
      s.org = s.owner.org;
      s.ws = s.owner.workspace;
      s.connection = s.store.replace(/^store_/, "connection_");
      s.installation = s.store.replace(/^store_/, "storeinst_");
      s.appKey = ("lab-" + key).slice(0, 63);
      s.shop = s.appKey + ".myshopify.com";
      s.shopId = String(BigInt("0x" + sha(s.store).slice(0, 12)) + 1n);
      s.credential = "credential_" + s.installation;
      s.secret = "shpss_" + randomBytes(16).toString("hex");
      s.token = "shpat_" + randomBytes(16).toString("hex");
      privateMarkers.push(s.secret, s.token);
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
    // The catalogue read grant (M2 PR-2's store-link template issues it at link): A on S and
    // G, Y on R and T. X holds none.
    const grants = [];
    for (const s of Object.values(stores)) {
      const p = s.owner;
      const actor = {
        kind: "human",
        principalId: p.principal,
        organizationId: p.org,
        workspaceId: p.workspace,
        membershipId: p.membership,
        installationId: null,
        mandateId: null,
      };
      const g = {
        id: "g_" + p.key.toLowerCase() + "_catalog_read_" + s.store,
        principal: actor,
        capabilityId: "catalog.products.read",
        verbs: ["view", "delegate"],
        scope: {
          organizationId: p.org,
          workspaceId: p.workspace,
          storeIds: [s.store],
          accountIds: [],
          resources: [storeResource(p.org, p.workspace, s.store, s.connection)],
          fields: [...listingFieldPaths],
        },
        issuedBy: { ...actor, kind: "service", principalId: "morrow.linking", membershipId: null },
        validFrom: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        policyRevision: 1,
      };
      if (!validateCurrentDefinition("Grant", g)) throw Error("LAB_GRANT_INVALID");
      grants.push(
        `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(p.org)},${literal(p.workspace)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`,
      );
    }
    db.admin(grants.join("\n"));
    // Each app's secret (app_secret_put) and each installation's sealed offline token (the
    // envelope binds the tenant, the credential and the store installation as its subject).
    const oracles = new Map();
    for (const s of Object.values(stores)) {
      s.clientId = db.rows(
        `SELECT client_id FROM morrow_identity.shopify_apps WHERE app_key=${literal(s.appKey)}`,
        { role: "morrow_identity_owner" },
      )[0].client_id;
      const app = await sealVaultRecord(
        keyring,
        { kind: "app_secret", appKey: s.appKey, provider: "shopify", version: 1 },
        new TextEncoder().encode(s.secret),
      );
      s.secretStored = db.rows(
        `SELECT outcome FROM morrow_vault.app_secret_put(${literal(s.appKey)},'1',${literal(vaultBytesHex(app.wrappedKey))},${literal(vaultBytesHex(app.sealedValue))})`,
        { role: "morrow_work_owner" },
      )[0]?.outcome;
      const token = await sealVaultRecord(
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
        `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at) VALUES(${literal(s.org)},${literal(s.ws)},${literal(s.credential)},1,'shopify','shopify_offline_token',${literal(s.installation)},'active',1,${literal("\\x" + vaultBytesHex(token.wrappedKey))}::bytea,${literal("\\x" + vaultBytesHex(token.sealedValue))}::bytea,date_trunc('milliseconds',clock_timestamp()));`,
      );
      s.oracle = createShopifyOracle({
        secret: s.secret,
        clientId: s.clientId,
        shop: s.shop,
        shopId: s.shopId,
      });
      s.oracle.state.tokens.push(s.token);
      oracles.set(s.shop, s.oracle);
    }
    const ownerRows = (q) => db.rows(q, { role: "morrow_identity_owner" });
    const workRows = (q) => db.rows(q, { role: "morrow_work_owner" });
    const installationOf = (s) =>
      ownerRows(
        `SELECT status,suspended_reason,uninstalled_at IS NOT NULL AS uninstalled,credential_destroyed_at IS NOT NULL AS token_destroyed,redacted_at IS NOT NULL AS redacted,shop_domain FROM morrow_identity.store_installations WHERE id=${literal(s.installation)}`,
      )[0];
    const credentialOf = (s) =>
      workRows(
        `SELECT status,wrapped_key IS NULL AS erased,destroy_reason FROM morrow_vault.credentials WHERE subject_id=${literal(s.installation)} ORDER BY version`,
      );
    const stopsOf = (s) =>
      workRows(
        `SELECT reason_code,set_by_kind,lifted_at IS NULL AS active FROM morrow_work.stop_controls WHERE store_id=${literal(s.store)} AND scope='connection' AND target_id=${literal(s.connection)}`,
      );
    const inboxRows = () =>
      ownerRows(
        `SELECT id::text,app_key,organization_id::text AS org,workspace_id::text AS ws,installation_id::text AS installation,topic,webhook_id,status,outcome,body,effects FROM morrow_identity.shopify_webhook_inbox ORDER BY received_at,id`,
      );
    // Each evidence entry carries its handler's declared action (M3 PR-2's snapshots and drafts:
    // delete_rows, since the integration revised store_content_redact).
    const actionsDeclared = (evidence) =>
      (evidence?.handlers ?? []).every(
        (h) => storeContentHandlers.find((x) => x.table === h.table)?.action === h.action,
      ) &&
      ["morrow_work.product_snapshots", "morrow_work.run_drafts"].every(
        (table) =>
          (evidence?.handlers ?? []).find((h) => h.table === table)?.action === "delete_rows",
      );
    const requestsOf = (inboxId) =>
      ownerRows(
        `SELECT organization_id::text AS org,workspace_id::text AS ws,topic,status,evidence,row_to_json(r)::text AS raw FROM morrow_identity.privacy_requests r WHERE inbox_id=${literal(inboxId)}`,
      );
    check(
      "F1:four_linked_stores_in_two_tenants_with_secrets_and_sealed_tokens",
      Object.values(stores).every(
        (s) =>
          s.secretStored === "stored" &&
          installationOf(s)?.status === "linked" &&
          credentialOf(s).length === 1 &&
          credentialOf(s)[0].status === "active",
      ),
    );

    // The transports: one psql connection per transaction, as the login each names.
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
    const outbound = { unexpected: [] };
    const shopifyFetch = (url, init) => {
      const oracle = oracles.get(new URL(url).host);
      if (!oracle) {
        outbound.unexpected.push(new URL(url).host);
        return Promise.resolve(new Response(null, { status: 502 }));
      }
      return oracle.fetch(url, init);
    };
    // Loaded hosts: each vault transaction's budget is stretched (the transport caps it).
    const transaction = (vault, budgetMs, body) =>
      runVaultTransactionWithDriver(
        bridged,
        vault,
        Math.min(10000, budgetMs * 3),
        body,
        Date.now,
        NoSocket,
      );
    const broker = createShopifyBroker({ transaction, fetch: shopifyFetch, now: () => Date.now() });
    const reader = createShopifyReader({ transaction, fetch: shopifyFetch, now: () => Date.now() });
    const faults = { destroy: false };
    const destroyCalls = [];
    const connector = createConnectorHandler({
      configuration: { origin: connectorOrigin, apiOrigin: workFixtureOrigin },
      broker: {
        shopifyLaunchVerify: (appKey, rawQuery) => broker.launchVerify(brokerEnv, appKey, rawQuery),
        shopifyInstallComplete: (appKey, rawQuery, digest, budgetMs) =>
          broker.installComplete(brokerEnv, appKey, rawQuery, digest, budgetMs),
        shopifyWebhookVerify: (appKey, headersJson, rawBodyBase64) =>
          broker.webhookVerify(brokerEnv, appKey, headersJson, rawBodyBase64),
        async shopifyCredentialDestroy(installationId, reason) {
          destroyCalls.push({ installationId, reason });
          if (faults.destroy) throw Error("lab: the ConnectorBroker binding is unreachable");
          return broker.credentialDestroy(brokerEnv, installationId, reason);
        },
      },
      database: createConnectorDatabase(
        binding,
        {
          neonLease: async () =>
            JSON.stringify({
              schemaVersion: 1,
              password: "lab-" + randomBytes(12).toString("hex"),
            }),
        },
        bridged,
        Date.now,
        NoSocket,
      ),
      limiters: null,
    });
    // One delivery through the connector's /webhooks; the waitUntil work is awaited before
    // the reply is returned, so every check sees the applied state.
    async function deliver(s, topic, body, overrides = {}) {
      const hook = s.oracle.webhook(topic, body, overrides);
      const pending = [];
      const response = await connector.fetch(
        new Request(`${connectorOrigin}/shopify/a/${overrides.appKey ?? s.appKey}/webhooks`, {
          method: "POST",
          headers: { "content-type": "application/json", ...hook.headers },
          body: hook.body,
        }),
        { waitUntil: (p) => pending.push(p) },
      );
      const waited = await Promise.all(pending);
      return {
        status: response.status,
        body: await response.json(),
        webhookId: hook.headers["x-shopify-webhook-id"],
        applied: waited[0] ?? null,
      };
    }
    const shopBody = (s) => ({ id: Number(s.shopId), name: "Lab", myshopify_domain: s.shop });
    const compliance = (s, extra = {}) => ({
      shop_id: Number(s.shopId),
      shop_domain: s.shop,
      ...extra,
    });

    // -------------------------------------------------------------------------
    // W: only verified deliveries are recorded, under the registry's tenant.
    phase("webhooks");
    const { S, G, R, T } = stores;
    const forged = await deliver(S, "app/uninstalled", shopBody(S), { secret: "wrong-secret" });
    const crossApp = await deliver(S, "app/uninstalled", shopBody(S), {
      secret: T.secret,
    });
    // S's own secret, but the delivery names T's shop: the registry has no such app and shop.
    const crossShop = await deliver(S, "app/uninstalled", shopBody(T), { shop: T.shop });
    check(
      "W1:a_bad_or_foreign_signature_and_a_shop_the_app_is_not_registered_for_record_nothing",
      forged.status === 401 &&
        crossApp.status === 401 &&
        crossShop.status === 401 &&
        inboxRows().length === 0 &&
        installationOf(S).status === "linked" &&
        installationOf(T).status === "linked",
      { forged: forged.status, crossApp: crossApp.status, crossShop: crossShop.status },
    );
    const noShopId = await deliver(S, "shop/redact", { shop_domain: S.shop });
    const piiInUninstall = await deliver(S, "app/uninstalled", {
      ...shopBody(S),
      customer: { id: 1 },
    });
    const wrongDomain = await deliver(S, "shop/redact", compliance(S, { shop_domain: T.shop }));
    check(
      "W2:an_invalid_body_is_400_and_records_nothing",
      noShopId.status === 400 &&
        piiInUninstall.status === 400 &&
        wrongDomain.status === 400 &&
        inboxRows().length === 0,
      { noShopId: noShopId.status, pii: piiInUninstall.status, domain: wrongDomain.status },
    );
    // A verified delivery whose body names another tenant's shop id is recorded for the
    // registry's tenant with no installation, and changes nothing anywhere.
    const foreignId = await deliver(S, "app/uninstalled", { id: Number(T.shopId) });
    const foreignRow = inboxRows().find((r) => r.webhook_id === foreignId.webhookId);
    check(
      "W3:the_tenant_is_the_registrys_for_the_verified_shop_never_one_the_body_names",
      foreignId.status === 200 &&
        foreignRow?.org === S.org &&
        foreignRow.ws === S.ws &&
        foreignRow.installation === null &&
        foreignRow.status === "ignored" &&
        foreignRow.outcome === "no_installation" &&
        installationOf(T).status === "linked" &&
        stopsOf(T).length === 0 &&
        installationOf(S).status === "linked",
      { foreignRow },
    );
    const recordAs = (user) =>
      db.tryRun(
        `SELECT * FROM morrow_vault.shopify_webhook_record(${literal(S.appKey)},${literal(S.shop)},'app/uninstalled','lab-direct','2026-10','{"shopId":"${S.shopId}"}');`,
        { user },
      ).ok;
    check(
      "W4:only_the_brokers_login_records_a_delivery",
      ["morrow_connector_ingress", "morrow_api_worker", "morrow_runtime_executor"].every(
        (user) => !recordAs(user),
      ) &&
        !db.tryRun(
          `SELECT * FROM morrow_identity.work_shopify_webhook_record(${literal(S.appKey)},${literal(S.shop)},'app/uninstalled','lab-direct2','2026-10','{"shopId":"${S.shopId}"}');`,
          { user: "morrow_vault_broker" },
        ).ok &&
        inboxRows().length === 1,
    );

    // -------------------------------------------------------------------------
    // C: customers/* complete "none held"; no customer value is kept.
    phase("customers");
    const customer = { id: 987650001234, email: customerEmail, phone: "+15550000000" };
    const dataRequest = await deliver(
      S,
      "customers/data_request",
      compliance(S, { customer, orders_requested: [1], data_request: { id: 9001 } }),
    );
    const dataRow = inboxRows().find((r) => r.webhook_id === dataRequest.webhookId);
    const dataRequestRows = requestsOf(dataRow?.id ?? "");
    const allText = () =>
      JSON.stringify(inboxRows()) +
      JSON.stringify(
        ownerRows("SELECT row_to_json(r)::text AS t FROM morrow_identity.privacy_requests r"),
      );
    check(
      "C1:a_data_request_completes_none_held_under_the_registrys_tenant",
      dataRequest.status === 200 &&
        dataRow?.status === "applied" &&
        dataRow.outcome === "none_held" &&
        Object.keys(dataRow.body).sort().join(",") === "customerDigest,dataRequestId,shopId" &&
        /^[a-f0-9]{64}$/.test(dataRow.body.customerDigest) &&
        dataRequestRows.length === 1 &&
        dataRequestRows[0].org === S.org &&
        dataRequestRows[0].ws === S.ws &&
        dataRequestRows[0].status === "completed" &&
        dataRequestRows[0].evidence.kind === "none_held" &&
        JSON.stringify(dataRequestRows[0].evidence.outstanding) === "[]",
      { dataRow, dataRequestRows },
    );
    const again = await deliver(
      S,
      "customers/data_request",
      compliance(S, { customer, orders_requested: [1], data_request: { id: 9001 } }),
      { webhookId: dataRequest.webhookId },
    );
    // The same data request delivered again under a new webhook id: its own inbox row,
    // ignored, and still one privacy request for that request id.
    const sameRequest = await deliver(
      S,
      "customers/data_request",
      compliance(S, { customer, orders_requested: [1], data_request: { id: 9001 } }),
    );
    const sameRequestRow = inboxRows().find((r) => r.webhook_id === sameRequest.webhookId);
    const requestsFor9001 = ownerRows(
      "SELECT count(*)::int AS n FROM morrow_identity.privacy_requests WHERE data_request_id='9001'",
    )[0].n;
    const redact = await deliver(
      S,
      "customers/redact",
      compliance(S, { customer, orders_to_redact: [1] }),
    );
    const redactRow = inboxRows().find((r) => r.webhook_id === redact.webhookId);
    check(
      "C2:a_redelivery_is_a_duplicate_and_customers_redact_completes_none_held",
      again.status === 200 &&
        inboxRows().filter((r) => r.webhook_id === dataRequest.webhookId).length === 1 &&
        requestsOf(dataRow.id).length === 1 &&
        sameRequest.status === 200 &&
        sameRequestRow?.status === "ignored" &&
        sameRequestRow.outcome === "duplicate_request" &&
        requestsFor9001 === 1 &&
        redact.status === 200 &&
        redactRow?.status === "applied" &&
        requestsOf(redactRow.id)[0]?.status === "completed" &&
        requestsOf(redactRow.id)[0]?.evidence.kind === "none_held",
      { again: again.status, sameRequestRow, requestsFor9001, redactRow },
    );
    check(
      "C3:no_customer_id_email_or_phone_is_stored",
      !allText().includes(customerEmail) &&
        !allText().includes("15550000000") &&
        !allText().includes("987650001234") &&
        !ownerRows(
          "SELECT string_agg(column_name,',') AS c FROM information_schema.columns WHERE table_schema='morrow_identity' AND table_name='privacy_requests'",
        )[0].c.includes("customer"),
    );

    // -------------------------------------------------------------------------
    // T: the catalogue reads.
    phase("reads");
    const catalog = createCatalogApiHandler({
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
    async function read(p, s, route, query = "", ws = p.workspace) {
      const response = await catalog.fetch(
        new Request(
          `${workFixtureOrigin}/workspace/${ws}/stores/${s.store}/catalog/${route}${query ? "?" + query : ""}`,
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
      );
      let body = null;
      try {
        body = await response.json();
      } catch {}
      return { status: response.status, body };
    }
    const leases = (s) =>
      workRows(
        `SELECT id::text,kind,status,revoked_reason,initiator_principal_id::text AS principal FROM morrow_work.work_leases WHERE store_id=${literal(s.store)} ORDER BY created_at,id`,
      );
    const graphqlCalls = (s) => s.oracle.state.calls.filter((c) => c.operation);
    const collections = await read(A, S, "collections");
    const page1 = await read(A, S, "products");
    const page2 = await read(A, S, "products", "after=" + (page1.body?.nextCursor ?? ""));
    check(
      "T1:the_owner_reads_collections_and_paged_products_under_one_read_lease_each",
      collections.status === 200 &&
        JSON.stringify(collections.body) ===
          JSON.stringify({
            schemaVersion: 1,
            collections: [
              { id: "collection:11", title: "Summer" },
              { id: "collection:12", title: "Winter" },
            ],
            nextCursor: null,
            storeId: S.store,
          }) &&
        page1.status === 200 &&
        page1.body.products.length === 25 &&
        page1.body.nextCursor === "c25" &&
        page2.status === 200 &&
        page2.body.products.length === 5 &&
        page2.body.nextCursor === null &&
        page2.body.products.at(-1).status === "draft" &&
        leases(S).length === 3 &&
        leases(S).every((l) => l.kind === "read" && l.principal === A.principal),
      {
        collections: collections.status,
        page1: page1.status,
        page2: page2.status,
        leases: leases(S),
      },
    );
    const search = await read(A, S, "products", "query=summer");
    const inCollection = await read(A, S, "products", "collectionId=collection%3A11");
    const missingCollection = await read(A, S, "products", "collectionId=collection%3A99");
    const calls = graphqlCalls(S);
    const searchCall = calls.at(-3);
    const collectionCall = calls.at(-2);
    check(
      "T2:filters_reach_shopify_only_as_variables_the_broker_built",
      search.status === 200 &&
        search.body.products.length === 5 &&
        JSON.stringify(searchCall?.variables) ===
          JSON.stringify({ first: 25, after: null, query: "title:summer*" }) &&
        inCollection.status === 200 &&
        inCollection.body.products.length === 5 &&
        collectionCall?.operation === "CollectionProductsPage" &&
        JSON.stringify(collectionCall.variables) ===
          JSON.stringify({ id: "gid://shopify/Collection/11", first: 25, after: null }) &&
        missingCollection.status === 404,
      { search: search.status, searchCall, collectionCall, missing: missingCollection.status },
    );
    S.oracle.state.extraFields = true;
    const extra = await read(A, S, "products");
    S.oracle.state.extraFields = false;
    check(
      "T3:the_result_is_closed_and_fields_shopify_adds_never_leave_the_broker",
      extra.status === 200 &&
        Object.keys(extra.body).sort().join(",") === "nextCursor,products,schemaVersion,storeId" &&
        extra.body.products.every(
          (p) =>
            Object.keys(p).sort().join(",") === "id,status,title" && /^product:[0-9]+$/.test(p.id),
        ),
    );
    const leaseCount = leases(S).length;
    const callCount = S.oracle.state.calls.length;
    const invalid = [
      await read(A, S, "products", "query=" + encodeURIComponent("title:*")),
      await read(A, S, "products", "vendor=x"),
      await read(A, S, "collections", "after=" + "a".repeat(shopifyReadLimits.cursorMaxChars + 1)),
      await read(A, S, "products", "collectionId=11"),
    ];
    check(
      "T4:invalid_variables_are_400_before_any_lease_or_shopify_call",
      invalid.every((r) => r.status === 400) &&
        leases(S).length === leaseCount &&
        S.oracle.state.calls.length === callCount,
      invalid.map((r) => r.status),
    );
    const noGrant = await read(X, S, "collections");
    const foreignStore = await read(A, T, "collections");
    const otherTenant = await read(Y, S, "collections", "", A.workspace);
    check(
      "T5:no_grant_another_workspaces_store_or_another_tenant_reads_nothing",
      noGrant.status === 403 &&
        foreignStore.status === 404 &&
        [401, 403, 404].includes(otherTenant.status) &&
        leases(S).length === leaseCount &&
        leases(T).length === 0 &&
        S.oracle.state.calls.length === callCount &&
        T.oracle.state.calls.length === 0,
      { noGrant: noGrant.status, foreignStore: foreignStore.status, other: otherTenant.status },
    );
    // A read lease opened by the api's login and role (the catalogue route's definer), then
    // the vault resolution as the broker's login.
    const openLease = (p, s) =>
      db.rows(
        `SELECT * FROM morrow_work.catalog_read_lease(${literal(s.store)},${literal(s.connection)})`,
        {
          prefix: `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${literal(p.digest)},${literal(p.workspace)});\n`,
          suffix: "\nCOMMIT;",
          user: "morrow_api_worker",
        },
      )[0];
    const resolve = (
      lease,
      {
        generation = lease.generation,
        subject = lease.subject_id,
        query = "collectionsPage",
        product = "",
      } = {},
      user = "morrow_vault_broker",
    ) => {
      const r = db.tryRun(
        `SELECT outcome||'|'||COALESCE(installation_id,'') FROM morrow_vault.shopify_read_resolve(${literal(lease.lease_id)},${literal(String(generation))},${literal(subject)},${literal(query)},NULLIF(${literal(product)},''));`,
        { user },
      );
      return r.ok ? r.stdout.split("\n").at(-1) : "error";
    };
    const leaseS = openLease(A, S);
    const leaseT = openLease(Y, T);
    check(
      "T6:the_vault_resolution_refuses_every_mismatch_and_resolves_the_lease_alone",
      leaseS?.outcome === "opened" &&
        leaseT?.outcome === "opened" &&
        resolve(leaseS) === "resolved|" + S.installation &&
        resolve(leaseT) === "resolved|" + T.installation &&
        !resolve(leaseS, { generation: 2 }).startsWith("resolved") &&
        !resolve(leaseS, { subject: leaseT.subject_id }).startsWith("resolved") &&
        resolve(leaseS, { query: "productContent", product: "product:101" }) ===
          "purpose_mismatch|" &&
        resolve(leaseS, { query: "productContent", product: "101" }) === "invalid|" &&
        resolve(leaseS, { query: "ordersPage" }) === "invalid|" &&
        ["morrow_api_worker", "morrow_connector_ingress", "morrow_runtime_executor"].every(
          (user) => resolve(leaseS, {}, user) === "error",
        ),
      { leaseS, leaseT, generation: resolve(leaseS, { generation: 2 }) },
    );
    const brokerRead = (lease, budget, query = "collectionsPage", variables = '{"after":null}') =>
      reader
        .read(
          brokerEnv,
          "api",
          lease.lease_id,
          Number(lease.generation),
          lease.subject_id,
          query,
          variables,
          budget,
        )
        .then(
          (text) => ({ ok: true, text }),
          (error) => ({ ok: false, code: error?.code ?? "error" }),
        );
    const overBudget = await brokerRead(leaseS, 15001);
    const runtimeQuery = await brokerRead(
      leaseS,
      5000,
      "productContent",
      '{"productId":"product:101"}',
    );
    const before = S.oracle.state.calls.length;
    S.oracle.state.fault = "throttled_once";
    const throttled = await brokerRead(leaseS, 15000);
    const afterThrottle = S.oracle.state.calls.length;
    check(
      "T7:the_read_budget_is_bounded_throttling_waits_once_and_the_api_reads_no_product_content",
      overBudget.ok === false &&
        overBudget.code === "BUDGET_INVALID" &&
        runtimeQuery.ok === false &&
        runtimeQuery.code === "INPUT_INVALID" &&
        throttled.ok === true &&
        JSON.parse(throttled.text).collections.length === 2 &&
        afterThrottle - before === 2 &&
        S.oracle.state.fault === null,
      { overBudget, runtimeQuery, throttled: throttled.ok, calls: afterThrottle - before },
    );

    // -------------------------------------------------------------------------
    // U: app/uninstalled ends the installation, stops the connection, revokes its leases
    // and destroys the token; idempotent and tenant-local.
    phase("uninstall");
    const leaseById = (id) =>
      workRows(
        `SELECT status,revoked_reason FROM morrow_work.work_leases WHERE id=${literal(id)}`,
      )[0];
    const candidateOf = (s) =>
      ownerRows(
        `SELECT proof_revoked_at IS NOT NULL AS revoked,redacted_at IS NOT NULL AS redacted,shop_domain FROM morrow_identity.linking_candidates WHERE installation_id=${literal(s.installation)}`,
      )[0];
    const uninstall = await deliver(S, "app/uninstalled", shopBody(S));
    const uninstallRow = inboxRows().find((r) => r.webhook_id === uninstall.webhookId);
    check(
      "U1:an_uninstall_ends_the_installation_stops_its_connection_and_revokes_its_leases",
      uninstall.status === 200 &&
        uninstall.applied === "applied" &&
        uninstallRow?.status === "applied" &&
        uninstallRow.outcome === "uninstalled" &&
        same(uninstallRow.effects, { installation: "uninstalled", stop: "set" }) &&
        installationOf(S).status === "uninstalled" &&
        installationOf(S).uninstalled === true &&
        JSON.stringify(stopsOf(S)) ===
          JSON.stringify([
            { reason_code: "shopify_app_uninstalled", set_by_kind: "system", active: true },
          ]) &&
        leases(S).every((l) => l.status !== "active") &&
        leaseById(leaseS.lease_id)?.status === "revoked" &&
        leaseById(leaseS.lease_id).revoked_reason === "stop" &&
        candidateOf(S)?.revoked === true,
      { uninstallRow, stops: stopsOf(S), lease: leaseById(leaseS.lease_id) },
    );
    check(
      "U2:the_token_is_destroyed_with_the_reason_the_installation_records",
      JSON.stringify(credentialOf(S)) ===
        JSON.stringify([{ status: "destroyed", erased: true, destroy_reason: "uninstalled" }]) &&
        installationOf(S).token_destroyed === true &&
        destroyCalls.some((c) => c.installationId === S.installation && c.reason === "uninstalled"),
      { credential: credentialOf(S), destroyCalls },
    );
    const redelivered = await deliver(S, "app/uninstalled", shopBody(S), {
      webhookId: uninstall.webhookId,
    });
    const second = await deliver(S, "app/uninstalled", shopBody(S));
    const secondRow = inboxRows().find((r) => r.webhook_id === second.webhookId);
    const destroyed = await broker.credentialDestroy(brokerEnv, S.installation, "uninstalled");
    check(
      "U3:a_redelivery_and_a_second_uninstall_change_nothing",
      redelivered.status === 200 &&
        redelivered.applied === null &&
        inboxRows().filter((r) => r.webhook_id === uninstall.webhookId).length === 1 &&
        second.status === 200 &&
        same(secondRow?.effects, { installation: "unchanged", stop: "already_stopped" }) &&
        stopsOf(S).length === 1 &&
        decodeShopifyCredentialResult(destroyed) === "already_destroyed",
      { redelivered, secondRow, destroyed },
    );
    const callsBefore = S.oracle.state.calls.length;
    const afterUninstall = await read(A, S, "collections");
    const staleLease = await brokerRead(leaseS, 5000);
    check(
      "U4:reads_after_the_uninstall_are_refused_before_shopify",
      [404, 409].includes(afterUninstall.status) &&
        staleLease.ok === false &&
        staleLease.code === "READ_REFUSED" &&
        S.oracle.state.calls.length === callsBefore,
      { afterUninstall: afterUninstall.status, staleLease },
    );
    check(
      "U5:another_tenants_store_lease_and_token_are_untouched",
      installationOf(T).status === "linked" &&
        stopsOf(T).length === 0 &&
        leaseById(leaseT.lease_id)?.status === "active" &&
        credentialOf(T)[0]?.status === "active" &&
        installationOf(G).status === "linked" &&
        credentialOf(G)[0]?.status === "active",
    );

    // -------------------------------------------------------------------------
    // G: scope changes. v1 PR 5 (ADR-0025 item 10) rewrote G1 to G3: a scope change keeps the
    // connection and its token; the delivery's scopes only narrow the record, the agents that
    // need a missing scope stop (G has none here: lab:connection-health covers them) and one
    // Reconnect item names the missing scope; a later uninstall ends it as any uninstall.
    phase("scopes");
    const noticesOf = (s) =>
      workRows(
        `SELECT missing_scopes,stopped_installations,cleared_reason FROM morrow_work.connection_notices WHERE connection_id=${literal(s.connection)} ORDER BY created_at,id`,
      );
    const scopesOf = (s) =>
      ownerRows(
        `SELECT array_to_string(granted_scopes,',') AS scopes FROM morrow_identity.store_installations WHERE id=${literal(s.installation)}`,
      )[0]?.scopes;
    const unchanged = await deliver(G, "app/scopes_update", {
      id: 1,
      previous: ["write_products"],
      current: ["write_products"],
    });
    const unchangedRow = inboxRows().find((r) => r.webhook_id === unchanged.webhookId);
    check(
      "G1:write_products_alone_is_recorded_unchanged_and_stops_nothing",
      unchanged.status === 200 &&
        unchangedRow?.status === "applied" &&
        unchangedRow.outcome === "scopes_recorded" &&
        unchangedRow.effects?.scopes === "unchanged" &&
        installationOf(G).status === "linked" &&
        scopesOf(G) === "read_products,write_products" &&
        stopsOf(G).length === 0 &&
        noticesOf(G).length === 0,
      { unchangedRow },
    );
    const narrowed = await deliver(G, "app/scopes_update", {
      id: 1,
      previous: ["write_products"],
      current: ["read_products"],
    });
    check(
      "G2:a_scope_change_keeps_the_connection_and_its_token_and_raises_reconnect",
      narrowed.status === 200 &&
        installationOf(G).status === "linked" &&
        installationOf(G).suspended_reason === null &&
        installationOf(G).token_destroyed === false &&
        scopesOf(G) === "read_products" &&
        stopsOf(G).length === 0 &&
        JSON.stringify(credentialOf(G)) ===
          JSON.stringify([{ status: "active", erased: false, destroy_reason: null }]) &&
        JSON.stringify(noticesOf(G)) ===
          JSON.stringify([
            { missing_scopes: ["write_products"], stopped_installations: [], cleared_reason: null },
          ]),
      {
        installation: installationOf(G),
        stops: stopsOf(G),
        credential: credentialOf(G),
        notices: noticesOf(G),
      },
    );
    const thenUninstalled = await deliver(G, "app/uninstalled", shopBody(G));
    check(
      "G3:an_uninstall_after_a_scope_change_ends_it_destroys_the_token_and_clears_the_item",
      thenUninstalled.status === 200 &&
        installationOf(G).status === "uninstalled" &&
        JSON.stringify(stopsOf(G)) ===
          JSON.stringify([
            { reason_code: "shopify_app_uninstalled", set_by_kind: "system", active: true },
          ]) &&
        credentialOf(G).length === 1 &&
        credentialOf(G)[0].status === "destroyed" &&
        credentialOf(G)[0].destroy_reason === "uninstalled" &&
        noticesOf(G)[0]?.cleared_reason === "connection_ended",
      { installation: installationOf(G), stops: stopsOf(G), notices: noticesOf(G) },
    );

    // -------------------------------------------------------------------------
    // D: the cron's re-drives. T's uninstall is recorded by the broker but its apply is lost
    // (no connector waitUntil ran); sim: the row is backdated past the two-minute window.
    phase("redrive");
    const backdate = (id) =>
      db.sql(
        `SET session_replication_role=replica; UPDATE morrow_identity.shopify_webhook_inbox SET received_at=received_at-interval '3 minutes',expires_at=expires_at-interval '3 minutes' WHERE id=${literal(id)}; SET session_replication_role=origin;`,
      );
    const hookT = T.oracle.webhook("app/uninstalled", JSON.stringify(shopBody(T)));
    const lostApply = decodeShopifyWebhookVerdict(
      await broker.webhookVerify(
        brokerEnv,
        T.appKey,
        JSON.stringify(hookT.headers),
        Buffer.from(hookT.body).toString("base64"),
      ),
    );
    const early = await connector.redrive();
    backdate(lostApply.inboxId);
    faults.destroy = true;
    const first = await connector.redrive();
    const tAfterFirst = installationOf(T);
    const pendingTokens = db.tryRun(
      "SELECT string_agg(installation_id||':'||reason,',') FROM morrow_work.connector_credentials_pending();",
      { user: "morrow_connector_ingress" },
    );
    check(
      "D1:a_lost_apply_is_applied_by_the_cron_after_two_minutes",
      lostApply.verdict === "recorded" &&
        early.inbox === 0 &&
        first.inbox === 1 &&
        first.applied === 1 &&
        tAfterFirst.status === "uninstalled" &&
        stopsOf(T).length === 1 &&
        leaseById(leaseT.lease_id)?.status === "revoked",
      { lostApply, early, first, tAfterFirst },
    );
    check(
      "D2:a_failed_destruction_stays_pending_and_the_next_cron_destroys_the_token",
      first.credentials >= 1 &&
        first.destroyed === 0 &&
        credentialOf(T)[0]?.status === "active" &&
        tAfterFirst.token_destroyed === false &&
        pendingTokens.ok &&
        pendingTokens.stdout
          .split("\n")
          .at(-1)
          .includes(T.installation + ":uninstalled"),
      { first, pendingTokens: pendingTokens.stdout },
    );
    faults.destroy = false;
    const second2 = await connector.redrive();
    check(
      "D3:the_redrive_destroys_it_and_then_has_nothing_left",
      second2.destroyed >= 1 &&
        credentialOf(T)[0]?.status === "destroyed" &&
        installationOf(T).token_destroyed === true &&
        (await connector.redrive()).credentials === 0,
      { second2 },
    );

    // -------------------------------------------------------------------------
    // S: shop/redact before the uninstall arrives; every store-content handler.
    phase("shop_redact");
    faults.destroy = true;
    const shopRedact = await deliver(R, "shop/redact", compliance(R));
    const redactInbox = inboxRows().find((r) => r.webhook_id === shopRedact.webhookId);
    const openRequest = requestsOf(redactInbox?.id ?? "")[0];
    check(
      "S1:shop_redact_ends_the_installation_redacts_identity_and_waits_for_the_token",
      shopRedact.status === 200 &&
        shopRedact.applied === "pending" &&
        redactInbox?.status === "received" &&
        openRequest?.status === "open" &&
        installationOf(R).status === "uninstalled" &&
        installationOf(R).redacted === true &&
        /^redacted-[a-f0-9]{24}\.myshopify\.com$/.test(installationOf(R).shop_domain) &&
        candidateOf(R)?.redacted === true &&
        candidateOf(R).shop_domain === installationOf(R).shop_domain &&
        stopsOf(R).length === 1 &&
        credentialOf(R)[0]?.status === "active",
      { shopRedact, redactInbox, openRequest, installation: installationOf(R) },
    );
    // The privacy deadline check (M2 PR-3 review; ADR-0022 item 14): R's request is still
    // open; sim: backdated 31 days, so it is past its 24-hour target and its 30-day due
    // time. The cron counts it and logs both fixed codes; nothing else is open.
    db.sql(
      `SET session_replication_role=replica; UPDATE morrow_identity.privacy_requests SET received_at=received_at-interval '31 days',target_at=target_at-interval '31 days',due_at=due_at-interval '31 days' WHERE inbox_id=${literal(redactInbox.id)}; SET session_replication_role=origin;`,
    );
    const linesBefore = consoleLines.length;
    const overdueRun = await connector.redrive();
    const privacyLines = consoleLines
      .slice(linesBefore)
      .filter((l) => l.includes('"event":"morrow_connector_privacy"'));
    check(
      "S6:an_open_shop_redact_past_its_target_and_due_time_is_counted_and_logged",
      overdueRun.targetMissed === 1 &&
        overdueRun.dueMissed === 1 &&
        privacyLines.some((l) => l.includes('"code":"PRIVACY_TARGET_MISSED","requests":1')) &&
        privacyLines.some((l) => l.includes('"code":"PRIVACY_DUE_MISSED","requests":1')) &&
        requestsOf(redactInbox.id)[0]?.status === "open",
      { overdueRun, privacyLines },
    );
    faults.destroy = false;
    backdate(redactInbox.id);
    const completedRun = await connector.redrive();
    const done = requestsOf(redactInbox.id)[0];
    const handlerTables = (done?.evidence?.handlers ?? []).map((h) => h.table).sort();
    check(
      "S2:the_request_completes_after_the_token_with_every_store_content_handler",
      completedRun.applied >= 1 &&
        done?.status === "completed" &&
        done.org === R.org &&
        done.ws === R.ws &&
        done.evidence.kind === "shop_redacted" &&
        done.evidence.credential === "destroyed" &&
        JSON.stringify(done.evidence.outstanding) === "[]" &&
        JSON.stringify(handlerTables) ===
          JSON.stringify(storeContentHandlers.map((h) => h.table).sort()) &&
        actionsDeclared(done.evidence) &&
        credentialOf(R)[0]?.status === "destroyed" &&
        inboxRows().find((r) => r.id === redactInbox.id)?.status === "applied" &&
        completedRun.targetMissed === 0 &&
        completedRun.dueMissed === 0,
      { completedRun, done },
    );
    const noInstallation = await deliver(S, "shop/redact", compliance(S, { shop_id: 999 }));
    const noneHeld = requestsOf(
      inboxRows().find((r) => r.webhook_id === noInstallation.webhookId)?.id ?? "",
    )[0];
    const launch = decodeShopifyLaunchVerdict(
      await broker.launchVerify(brokerEnv, R.appKey, R.oracle.launchQuery()),
    );
    check(
      "S3:a_shop_with_no_installation_completes_none_held_and_a_redacted_store_launches_as_uninstalled",
      noInstallation.status === 200 &&
        noneHeld?.status === "completed" &&
        noneHeld.evidence.kind === "none_held" &&
        launch.verdict === "verified" &&
        launch.installation === "uninstalled",
      { noneHeld, launch },
    );
    check(
      "S4:the_redaction_touched_only_its_own_store",
      [S, G, T].every(
        (s) => installationOf(s).shop_domain === s.shop && !installationOf(s).redacted,
      ),
    );
    // shop/redact after the uninstall (G: uninstalled, its token destroyed at the
    // uninstall): completes in one apply, with the same handlers.
    const redactedAfter = await deliver(G, "shop/redact", compliance(G));
    const afterRow = inboxRows().find((r) => r.webhook_id === redactedAfter.webhookId);
    const afterDone = requestsOf(afterRow?.id ?? "")[0];
    check(
      "S5:shop_redact_after_the_uninstall_completes_at_once_with_every_handler",
      redactedAfter.status === 200 &&
        redactedAfter.applied === "applied" &&
        afterRow?.status === "applied" &&
        afterDone?.status === "completed" &&
        afterDone.evidence.kind === "shop_redacted" &&
        JSON.stringify((afterDone.evidence.handlers ?? []).map((h) => h.table).sort()) ===
          JSON.stringify(storeContentHandlers.map((h) => h.table).sort()) &&
        actionsDeclared(afterDone.evidence) &&
        installationOf(G).redacted === true &&
        stopsOf(G).length === 1 &&
        installationOf(T).redacted === false,
      { afterRow, afterDone },
    );
    // v1 PR 5 (rewrites M2 PR-3 review's S7): an app whose installation was uninstalled
    // offers its install link again (a reinstall is a new installation, linked only by a
    // person); a redacted installation's app has its link cleared. A's workspace has two
    // active apps: S's (uninstalled in U, its link kept) and G's (redacted above, its link
    // cleared), so S's is offered.
    const connectionsRead = (p) =>
      db.rows(
        `SELECT app_registered,install_url FROM morrow_identity.workspace_connections(${literal(p.digest)},${literal(p.workspace)})`,
        { user: "morrow_identity_linking" },
      )[0] ?? null;
    const appOf = (key) =>
      ownerRows(
        `SELECT status,install_url,revision FROM morrow_identity.shopify_apps WHERE app_key=${literal(key)}`,
      )[0] ?? null;
    const endedOffer = connectionsRead(A);
    check(
      "S7:an_uninstalled_apps_link_is_offered_for_a_reinstall_and_a_redacted_ones_is_cleared",
      appOf(S.appKey)?.status === "active" &&
        appOf(S.appKey).install_url !== null &&
        installationOf(S).status === "uninstalled" &&
        appOf(G.appKey)?.install_url === null &&
        endedOffer?.app_registered === true &&
        endedOffer.install_url === appOf(S.appKey).install_url,
      { endedOffer, app: appOf(S.appKey) },
    );
    // M2 PR-3 review: shop/redact clears only its own app's install link. T (uninstalled in
    // D, token destroyed) has its app retired, and a replacement app is registered for T's
    // shop that invites A's workspace, another tenant. T's shop/redact, applied and then
    // re-driven (recorded again with its apply lost), clears and counts T's app only: the
    // replacement keeps its link and A's workspace is offered exactly what it was before
    // (v1 PR 5: S's link, offered for a reinstall, comes first).
    const retired = ownerRows(
      `SELECT outcome FROM morrow_identity.shopify_app_retire(${literal(T.appKey)})`,
    )[0]?.outcome;
    const replacementKey = "lab-store-tenant-replacement";
    const replacementUrl = "https://" + T.shop + "/admin/oauth/install_custom_app?app=replacement";
    const registered = ownerRows(
      `SELECT outcome FROM morrow_identity.shopify_app_register(${literal(replacementKey)},${literal(randomBytes(16).toString("hex"))},'development',${literal(sha(T.shop))},${literal(A.org)},${literal(A.workspace)},${literal(replacementUrl)})`,
    )[0]?.outcome;
    const offeredBefore = connectionsRead(A);
    const linkRows = (request) =>
      request?.evidence?.handlers?.find((h) => h.table === "morrow_identity.shopify_apps")?.rows;
    const tRedact = await deliver(T, "shop/redact", compliance(T));
    const tRow = inboxRows().find((r) => r.webhook_id === tRedact.webhookId);
    const tDone = requestsOf(tRow?.id ?? "")[0];
    const hookRedactT = T.oracle.webhook("shop/redact", JSON.stringify(compliance(T)));
    const lostRedact = decodeShopifyWebhookVerdict(
      await broker.webhookVerify(
        brokerEnv,
        T.appKey,
        JSON.stringify(hookRedactT.headers),
        Buffer.from(hookRedactT.body).toString("base64"),
      ),
    );
    backdate(lostRedact.inboxId);
    const tRedrive = await connector.redrive();
    const tAgain = requestsOf(lostRedact.inboxId ?? "")[0];
    const offeredAfter = connectionsRead(A);
    check(
      "S8:shop_redact_clears_only_its_own_apps_link_never_a_replacement_apps_in_another_tenant",
      retired === "retired" &&
        registered === "registered" &&
        offeredBefore?.app_registered === true &&
        offeredBefore.install_url !== null &&
        tRedact.status === 200 &&
        tRedact.applied === "applied" &&
        tDone?.status === "completed" &&
        tDone.org === T.org &&
        tDone.ws === T.ws &&
        linkRows(tDone) === 1 &&
        installationOf(T).redacted === true &&
        lostRedact.verdict === "recorded" &&
        tRedrive.applied >= 1 &&
        tAgain?.status === "completed" &&
        linkRows(tAgain) === 1 &&
        appOf(T.appKey)?.install_url === null &&
        appOf(replacementKey)?.status === "active" &&
        appOf(replacementKey).install_url === replacementUrl &&
        appOf(replacementKey).revision === 1 &&
        offeredAfter?.app_registered === true &&
        offeredAfter.install_url === offeredBefore.install_url,
      {
        retired,
        registered,
        offeredBefore,
        tRow,
        tDone,
        lostRedact,
        tRedrive,
        tAgain,
        replacement: appOf(replacementKey),
        offeredAfter,
      },
    );

    // -------------------------------------------------------------------------
    // K: only Shopify's verified deliveries end an installation in this release (a person's
    // disconnect is the owner-gated follow-up); no other login applies a delivery or ends an
    // installation, and the connector's login cannot forge its stop or redaction context.
    phase("authority");
    const anyInbox = inboxRows()[0].id;
    const asUser = (user, text) => db.tryRun(text, { user }).ok;
    check(
      "K1:no_login_but_the_connectors_applies_a_delivery_or_reads_the_redrive",
      ["morrow_api_worker", "morrow_vault_broker", "morrow_runtime_executor"].every(
        (user) =>
          !asUser(user, `SELECT * FROM morrow_work.connector_inbox_apply(${literal(anyInbox)});`) &&
          !asUser(user, "SELECT * FROM morrow_work.connector_inbox_pending();") &&
          !asUser(user, "SELECT * FROM morrow_work.connector_credentials_pending();") &&
          !asUser(user, "SELECT * FROM morrow_work.connector_privacy_overdue();"),
      ),
    );
    check(
      "K2:no_login_ends_an_installation_or_destroys_a_token_directly",
      [
        "morrow_connector_ingress",
        "morrow_api_worker",
        "morrow_vault_broker",
        "morrow_runtime_executor",
      ].every(
        (user) =>
          !asUser(
            user,
            `SELECT * FROM morrow_identity.work_shopify_installation_end(${literal(T.org)},${literal(T.ws)},${literal(T.installation)},'disconnected');`,
          ) &&
          !asUser(
            user,
            `SELECT * FROM morrow_identity.work_shopify_redact_identity(${literal(T.org)},${literal(T.ws)},${literal(T.installation)});`,
          ),
      ) &&
        ["morrow_connector_ingress", "morrow_api_worker", "morrow_runtime_executor"].every(
          (user) =>
            !asUser(
              user,
              `SELECT morrow_vault.shopify_credential_destroy(${literal(T.installation)},'uninstalled');`,
            ),
        ),
    );
    const forge = (text) =>
      asUser(
        "morrow_connector_ingress",
        `BEGIN; SELECT set_config('morrow.connector_stop',${literal(`${A.org}|${A.workspace}|store_priv|connection_priv`)},true),set_config('morrow.connector_redact',${literal(`${A.org}|${A.workspace}|store_priv`)},true);\n${text}\nCOMMIT;`,
      );
    check(
      "K3:the_connectors_login_cannot_forge_its_stop_or_redaction_context",
      !forge(
        `INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,reason_code,reason,created_at) VALUES(${literal(A.org)},${literal(A.workspace)},'forged','connection','store_priv','connection_priv','system','shopify_app_uninstalled','x',now());`,
      ) &&
        !forge(
          `UPDATE morrow_work.work_leases SET status='revoked',revoked_reason='stop' WHERE store_id='store_tenant';`,
        ) &&
        !forge(
          `SELECT * FROM morrow_work.parameters_redact_for_store(${literal(A.org)},${literal(A.workspace)},'store_priv');`,
        ) &&
        !forge(
          `SELECT * FROM morrow_work.store_content_redact(${literal(A.org)},${literal(A.workspace)},'store_priv');`,
        ),
    );

    // -------------------------------------------------------------------------
    // I: the customer identifier screen (H9a; ADR-0041 item 31). The model-written texts that
    // reach storage today are knowledge.propose's and notebook.write's; an agent's run on a
    // fresh store of A's tenant writes through both under a real run lease of the runtime
    // login, the way the loop's tool-call step will (lab:shop-knowledge's fake caller).
    phase("screen");
    const screen = {
      store: "store_screen",
      connection: "connection_screen",
      storeInstallation: "storeinst_screen",
      installation: "installation_screen",
      agent: "agent_" + randomUUID(),
    };
    db.admin(
      storeInstallationSql({
        org: A.org,
        workspace: A.workspace,
        principal: A.principal,
        storeId: screen.store,
        connectionId: screen.connection,
        installationId: screen.storeInstallation,
      }) +
        `\nINSERT INTO morrow_identity.principals VALUES(${literal(screen.agent)},'agent',true);
INSERT INTO morrow_identity.agent_principals VALUES(${literal(screen.agent)},'agent',${literal(A.org)},${literal(A.workspace)},'installation',${literal(screen.installation)},date_trunc('milliseconds',clock_timestamp()));`,
    );
    db.workOwner(`BEGIN; INSERT INTO morrow_work.agent_installations(organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,connection_id,agent_principal_id,owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at)
SELECT ${literal(A.org)},${literal(A.workspace)},${literal(screen.installation)},1,r.id,r.revision,r.digest,${literal(screen.store)},${literal(screen.connection)},${literal(screen.agent)},${literal(A.principal)},${literal(A.membership)},'active',morrow_work.listings_scope(${literal(A.org)},${literal(A.workspace)},${literal(screen.store)},${literal(screen.connection)}),(SELECT jsonb_agg(jsonb_build_object('organizationId',${literal(A.org)},'workspaceId',${literal(A.workspace)},'storeId',${literal(screen.store)},'kind','grant','id','g_ref_'||n,'revision',1,'digest',repeat('a',64))) FROM generate_series(1,3) n),repeat('b',64),t,t FROM morrow_work.agent_releases r, (SELECT date_trunc('milliseconds',clock_timestamp()) AS t) x WHERE r.id='morrow.listings' AND r.revision=1; COMMIT;`);
    const leaseOut = db
      .sql(
        asCommandRole(
          A,
          `SELECT concat_ws('|',outcome,lease_id,generation) FROM morrow_work.lease_open('run','run_screen',${literal(screen.store)},${literal(screen.connection)},${literal(screen.installation)});`,
          { end: "COMMIT" },
        ),
      )
      .split("\n")
      .at(-1)
      .split("|");
    const runtime = db.connector({
      user: "morrow_runtime_executor",
      stderr: (text) => process.env.MORROW_LAB_DEBUG === "1" && process.stderr.write(text),
    });
    // One transaction of the runtime login under the entered lease, as runLeaseStep runs it.
    const underLease = async (body) => {
      const connection = await runtime.open({
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 60000,
        waitUntil() {},
      });
      const signal = new AbortController().signal;
      const query = async (text, values = []) =>
        (await connection.query(text, [...values], signal)).rows;
      try {
        await query("BEGIN");
        const [entered] = await query("SELECT outcome FROM morrow_work.enter_lease($1,$2)", [
          leaseOut[1],
          leaseOut[2],
        ]);
        if (entered?.outcome !== "entered") throw Error("SHOPIFY_PRIVACY_LAB_LEASE_NOT_ENTERED");
        const value = await body(query);
        await query("COMMIT");
        return value;
      } catch (error) {
        await query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        await connection.close();
      }
    };
    const runFacts = {
      context: "routed",
      readTags: [{ storeId: screen.store, capability: "catalog.products.read" }],
      taint: "untrusted_external",
      agentTools: "on",
    };
    const allTagsViewer = { mayView: () => true };
    const toolCall = (step, toolUseId, input) =>
      underLease((query) =>
        step(query, { toolUseId, input, run: runFacts, viewer: allTagsViewer }),
      );
    const footprintOf = () =>
      db.rows(
        `SELECT (SELECT count(*) FROM morrow_work.knowledge_proposals)::int AS proposals, (SELECT count(*) FROM morrow_work.agent_notebook_entries)::int AS entries, (SELECT count(*) FROM morrow_work.commands)::int AS commands`,
      )[0];
    const screenBefore = footprintOf();
    const propose = (title, text, sources = []) => ({
      pageId: null,
      kind: "policy",
      title,
      text,
      sources,
    });
    const screened = [];
    for (const [id, step, input] of [
      ["toolu_i1", notebookWriteStep, { text: `Reach her at ${customerEmail} about the parcel.` }],
      ["toolu_i2", notebookWriteStep, { text: `Her mobile is ${screenPhone}.` }],
      [
        "toolu_i3",
        knowledgeProposeStep,
        propose("Returns", `Customers post returns to 12 ${screenStreet}.`),
      ],
      [
        "toolu_i4",
        knowledgeProposeStep,
        propose("Gift notes", "Keep gift notes short.", [
          { kind: "note", value: `gid://shopify/Customer/${screenGidNumber}` },
        ]),
      ],
      [
        "toolu_i5",
        knowledgeProposeStep,
        propose(
          "Replies",
          `Write to ${customerEmail.replace("@", " (at) ").replace(/\.test$/, " (dot) test")}.`,
        ),
      ],
    ])
      screened.push(await toolCall(step, id, input));
    const screenAfter = footprintOf();
    check(
      "I1:model_written_customer_identifiers_are_refused_before_the_command",
      screened.length === 5 &&
        screened.every((r) => r.outcome === "refused" && r.refusal === "customer_data") &&
        same(screenAfter, screenBefore),
      { screened, screenBefore, screenAfter },
    );
    // The control: a clean text through the same lease is written (order numbers and ids are
    // not customer data), so the refusals above are the screen's and the search below sees
    // what lands.
    const controlMarker = "titles-run-long-" + randomBytes(6).toString("hex");
    const control = await toolCall(notebookWriteStep, "toolu_i6", {
      text: `Order #1042 (gid://shopify/Order/5123456789012) shipped; ${controlMarker}.`,
    });
    // Every row of every table in every Morrow schema, read as the superuser (read only, an
    // oracle beside RLS), searched for each planted value.
    const morrowTables = db
      .rows(
        "SELECT format('%I.%I',n.nspname,c.relname) AS t FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname LIKE 'morrow\\_%' ORDER BY 1",
      )
      .map((r) => r.t);
    const tablesHolding = (needle) =>
      db
        .rows(
          morrowTables
            .map(
              (t) =>
                `SELECT ${literal(t)} AS t, count(*)::int AS n FROM ${t} x WHERE strpos(lower(row_to_json(x)::text),lower(${literal(needle)}))>0`,
            )
            .join(" UNION ALL "),
        )
        .filter((r) => r.n > 0)
        .map((r) => r.t);
    const controlTables = tablesHolding(controlMarker);
    check(
      "I2:a_clean_text_is_written_through_the_same_lease",
      control.outcome === "ok" &&
        control.record.kind === "notebook_entry" &&
        control.replayed === false &&
        same(controlTables, ["morrow_work.agent_notebook_entries"]) &&
        footprintOf().entries === screenBefore.entries + 1,
      { control, controlTables },
    );
    const planted = {
      email: tablesHolding(customerEmail),
      emailLocal: tablesHolding(customerEmail.split("@")[0]),
      phone: tablesHolding(screenPhone.slice(4)),
      phoneDigits: tablesHolding(screenPhoneDigits),
      street: tablesHolding(screenStreet),
      gid: tablesHolding(screenGidNumber),
    };
    check(
      "I3:no_planted_customer_value_is_in_any_table_of_any_morrow_schema",
      morrowTables.length > 50 &&
        morrowTables.includes("morrow_work.agent_notebook_entries") &&
        morrowTables.includes("morrow_work.knowledge_proposals") &&
        Object.values(planted).every((tables) => tables.length === 0),
      { planted, tables: morrowTables.length },
    );
    // The post command (ADR-0040 item 2; H11b) runs screenPost before anything is stored: the
    // customer customers/* named, in each form a person could type it, is refused with the
    // record's own words and a content-free refusal.
    const posts = [];
    for (const text of [
      `Refund ${customerEmail} for order #1042`,
      `She called from ${screenPhone}`,
      `Ship it to 12 ${screenStreet}`,
      `https://admin.shopify.com/store/lab-store/customers/${screenGidNumber}`,
    ])
      posts.push(await screenPost(text));
    check(
      "I4:a_post_naming_the_customer_is_refused_content_free_with_the_records_words",
      posts.every(
        (p) =>
          p.ok === false &&
          p.delivery === "not_started" &&
          p.code === "customer_data" &&
          p.safeMessage === customerDataSafeMessage &&
          validateCurrentDefinition("CustomerScreenRefusal", p.refusal) &&
          !privateMarkers.some((m) => JSON.stringify(p).includes(m)),
      ) &&
        same(
          posts.map((p) => p.refusal.kinds),
          [["email"], ["phone"], ["street_address"], ["customer_gid"]],
        ) &&
        (await screenPost("Raise the tote's price by 10% on order #1042")).ok === true,
      posts,
    );

    // -------------------------------------------------------------------------
    // O: logs and outbound.
    phase("observability");
    const logged = consoleLines.join("\n");
    check(
      "O1:no_secret_token_customer_value_or_shop_reply_in_any_log",
      privateMarkers.every((m) => typeof m === "string" && m.length > 8 && !logged.includes(m)) &&
        !logged.includes("Summer dress") &&
        consoleLines.some((l) => l.includes('"event":"morrow_connector_redrive"')) &&
        consoleLines.some((l) => l.includes('"event":"morrow_catalog"')),
    );
    check(
      "O2:only_the_oracles_shops_were_called",
      outbound.unexpected.length === 0 &&
        Object.values(stores).every((s) => s.oracle.state.calls.every((c) => c.host === s.shop)),
      outbound,
    );
    return { checks, failures };
  },
  { administrator: "createrole" },
);

console.log = print;
writeArtifact("labs/shopify-privacy.json", {
  task: "M2 PR-3",
  qualification: "local_postgresql17_network_none_shopify_privacy",
  observedAt: new Date().toISOString(),
  durationMs: Date.now() - labStarted,
  administrator: "createrole",
  sourceDigests,
  checks: report.checks,
  providerRequests: 0,
  limitations: [
    "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data. Shopify is the synthetic oracle (scripts/fixtures/shopify-oracle.mjs), shaped from Shopify's documentation; its payloads and documents are verified against the pinned 2026-10 schema and recorded development-store fixtures only after the owner-approved smoke.",
    "The connector, broker and catalogue handlers run in Node over psql bridges logged in as each login, not in workerd over the Neon transport (lab:shopify-connect-workers runs the connector's webhook path in workerd).",
    "The store installations, store-link read grants, app secrets and sealed tokens are owner-seeded (lab:shopify-install proves the install and link that write them). Shapes marked sim: inbox rows backdated past the cron's two-minute window.",
    "No catalog proposal exists in this lab's stores, so the proposal-parameters handler empties zero rows here; lab:listings-authority P6 proves it on real proposals through the same connector path.",
    "A person's disconnect (governance.connection.disconnect) is not in this PR: it waits on the owner's ADR-0022 amendments for its grant and its kill-switch record.",
    "Phase I (H9a) drives the model-written write paths that exist on main, knowledge.propose and notebook.write, with a fake caller under a real run lease (the agent loop is not merged), and screenPost in Node: the post command, messages, run turns, summaries and checkpoints have no table yet, so their cases land with the PRs that write them (H11b, H7d, H12c). A customer's name typed as free text is not detected (ADR-0041 item 31).",
  ],
});
if (report.failures.length) {
  print("FAILED: " + report.failures.join(", "));
  process.exitCode = 1;
} else print(`PASS: ${report.checks.length} M2 PR-3 Shopify privacy checks.`);
