// v1 PR 5 PostgreSQL 17 laboratory, "Keep the store connection healthy" (ADR-0025 items 9 and
// 10; ADR-0031 item 3; migrations connection-health-identity and connection-health-work,
// located by slug) on an isolated network-none engine with the whole manifest applied by the
// Neon-shaped non-superuser CREATEROLE administrator (ADR-0020 D4). The real TypeScript runs
// against it, in Node:
//   connector  createConnectorHandler (webhooks, the waitUntil apply, the launch, the cron) on
//              its own login's transport (createConnectorDatabase over a psql bridge logged in
//              as morrow_connector_ingress), with the clean-up switch off and then on;
//   broker     createShopifyBroker (launch, install, webhooks, token destruction) and
//              createShopifyHealthChecker (the scopes read-back) on the vault login's
//              transport (runVaultTransactionWithDriver as morrow_vault_broker), with the
//              broker's keyring and its outbound fetch to the synthetic Shopify;
//   identity   the linking issuer, lookup and apply as morrow_identity_linking, for the
//              person who links a reinstalled store again.
// It proves: G  a scope change keeps the connection and its token, records the scopes (which
// a delivery only narrows), stops only the agents that need a missing scope (system
// installation stop, StopRecord@1, leases revoked; another store's and another tenant's agents
// untouched), raises one Reconnect item for the steward and the Owner, and nothing resumes by
// itself; the re-authorisation through the install link clears the item and leaves the stop;
// C  the read-back (switch on) reconciles a missed scope change and a refused token, records
// nothing from an unclear answer and nothing for a stale token; R  a reinstall after an
// uninstall is a new installation with a new token, the old token destroyed in the same
// transaction, born unlinked and linked only by a person; D  the 48-hour deletion of an
// installation whose shop/redact never completed runs once with its record, waits for the
// token, deletes the store's content and identity, keeps a live reinstall's link and never
// reaches another tenant; S  stuck deliveries are closed (scope changes) or counted and
// logged (everything else); K  no other login runs the new definers, the old applier can no
// longer end an installation on a scope change, and the guard refuses a widening without an
// observation; O  logs and outbound requests. Owner-seeded synthetic fixtures only; no
// provider, credential or merchant data. Runs last in the CI pg-work group. The local
// superuser is used only for fixtures and the shapes marked "sim".
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createShopifyBroker } from "../apps/broker/src/shopify-install.ts";
import { createShopifyHealthChecker } from "../apps/broker/src/shopify-health.ts";
import { sealVaultRecord, createVaultKeyring, vaultBytesHex } from "../apps/broker/src/vault.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import { createConnectorHandler } from "../apps/shopify-connector/worker/connector.ts";
import { createConnectorDatabase } from "../apps/shopify-connector/worker/database.ts";
import {
  decodeShopifyConnectionCheck,
  decodeShopifyInstallResult,
  decodeShopifyLaunchVerdict,
  decodeShopifyWebhookVerdict,
} from "../packages/identity/src/broker-protocol.ts";
import { createControlledWorkspaceStoreLinking } from "../packages/identity/src/workspace-store-linking-control.ts";
import { runShopifyLinkIssuer } from "../packages/identity/src/shopify-link-issuer.ts";
import { createConnectionKernel } from "../packages/policy/src/connection-authority.ts";
import { decodeReconnectNotices } from "../packages/work/src/connection-health/notices.ts";
import { systemInstallationStopReasons } from "../packages/work/src/stops.ts";
import { storeContentHandlers } from "../packages/work/src/redaction.ts";
import {
  asApi,
  literal,
  seedWorkFixtures,
  withWorkDatabase,
  workFixtureOrigin,
} from "../tests/tenant-conformance/harness.mjs";
import { createShopifyOracle } from "./fixtures/shopify-oracle.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const checks = [];
const failures = [];
const labStarted = Date.now();
const phase = (value) =>
  console.error(
    "CONNECTION_HEALTH_LAB_PHASE:" +
      value +
      " t=" +
      Math.round((Date.now() - labStarted) / 1000) +
      "s",
  );
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("CONNECTION_HEALTH_LAB_CHECK_NAME:" + name);
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
const files = [".connection-health-identity.sql", ".connection-health-work.sql"].map(
  (slug) => manifest.migrations.find((m) => m.file.endsWith(slug))?.file,
);
if (files.some((f) => !f)) throw Error("CONNECTION_HEALTH_LAB_MIGRATIONS_REQUIRED");
const sourceDigests = Object.fromEntries(
  [
    "scripts/connection-health-lab.mjs",
    "scripts/fixtures/shopify-oracle.mjs",
    "apps/shopify-connector/worker/connector.ts",
    "apps/shopify-connector/worker/database.ts",
    "apps/broker/src/shopify-install.ts",
    "apps/broker/src/shopify-health.ts",
    "apps/broker/src/shopify.ts",
    "apps/broker/src/vault-database.ts",
    "packages/identity/src/broker-protocol.ts",
    "packages/work/src/connection-health/notices.ts",
    ...files.map((f) => "migrations/" + f),
  ].map((p) => [p, sha(readFileSync(p))]),
);

const kek = randomBytes(32).toString("hex");
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-health-lab",
  branchId: "br-health-lab",
  hostname: "ep-health-lab.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const brokerEnv = {
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "lab-vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
};
const connectorOrigin = "https://connector.lab.example.test";
const privateMarkers = [kek, brokerEnv.MORROW_DB_PASSWORD_MORROW_VAULT_BROKER];
// Worker console lines are captured: no secret or token may appear.
const consoleLines = [];
const print = console.log.bind(console);
console.log = (...args) => {
  consoleLines.push(args.map(String).join(" "));
};

const report = await withWorkDatabase(
  "V1PR5.connection-health",
  async (db) => {
    // -------------------------------------------------------------------------
    phase("fixtures");
    db.sql("ALTER ROLE morrow_identity_linking LOGIN;");
    const P = seedWorkFixtures(db);
    const A = P.A,
      X = P.X,
      Y = P.Y;
    // The Owner of each organization (its founding principal, a website signup) and A's
    // connect grant: the steward and the Owner a Reconnect item names, and the person who
    // links a reinstalled store (ADR-0025 item 2).
    const profile = "profile_health";
    db.admin(
      [
        `INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES(${literal(profile)},'workos','environment_${"B".repeat(26)}','app_${"B".repeat(26)}','client_${"B".repeat(26)}','https://api.workos.com/user_management/client_${"B".repeat(26)}',1,${literal("a".repeat(64))},1,'active');`,
        ...[A, Y].map(
          (p) =>
            `INSERT INTO morrow_identity.organization_signups VALUES(${literal(p.principal)},${literal(randomUUID())},${literal(sha(p.principal))},${literal(profile)},${literal(p.org)},${literal(p.workspace)},${literal(p.membership)},'owner-bootstrap-v1',clock_timestamp());`,
        ),
      ].join("\n"),
    );
    const connectGrant = {
      id: "grant_health_connect_a",
      principal: {
        kind: "human",
        principalId: A.principal,
        organizationId: A.org,
        workspaceId: A.workspace,
        membershipId: A.membership,
        installationId: null,
        mandateId: null,
      },
      capabilityId: "governance.connection.connect",
      verbs: ["administer", "approve"],
      scope: {
        organizationId: A.org,
        workspaceId: A.workspace,
        storeIds: [],
        accountIds: [],
        resources: [
          {
            organizationId: A.org,
            workspaceId: A.workspace,
            storeId: null,
            connectionId: null,
            kind: "workspace",
            id: A.workspace,
          },
        ],
        fields: ["providerId", "installationProof", "scope"],
      },
      issuedBy: {
        kind: "service",
        principalId: "morrow.onboarding",
        organizationId: A.org,
        workspaceId: A.workspace,
        membershipId: null,
        installationId: null,
        mandateId: null,
      },
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 1,
    };
    db.admin(
      `INSERT INTO morrow_identity.grants VALUES(${literal(connectGrant.id)},${literal(A.org)},${literal(A.workspace)},${literal(A.membership)},${literal(A.principal)},${literal(JSON.stringify(connectGrant))}::jsonb);`,
    );
    // A's workspace route fixed to morrow_direct (ADR-0022 item 5), so a person may link.
    db.workOwner(
      `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=date_trunc('milliseconds',clock_timestamp()),fixing_payment_key='stripe:invoice:in_health0001',revision=2,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE workspace_id=${literal(A.workspace)};`,
    );
    // Linked development stores (owner-seeded, as lab:shopify-privacy): G (scope changes) and
    // H (a second store) in A's tenant, D (the 48-hour deletion) in A's tenant, T in Y's.
    const stores = { G: { owner: A }, H: { owner: A }, D: { owner: A }, T: { owner: Y } };
    const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
    const oracles = new Map();
    const statements = [];
    // The harness's storeInstallationSql with every id a UUID, as the broker allocates them,
    // so the real re-authorisation (the reconnect) accepts these installations.
    const storeSql = (s) => {
      const at = "date_trunc('milliseconds',clock_timestamp())";
      const candidate = randomUUID();
      const link = randomUUID();
      return [
        `INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at)
 VALUES(${literal(s.appKey)},md5(${literal(s.appKey)}),'development',${literal(sha(s.shop))},${literal(s.org)},${literal(s.ws)},'read_products,write_products','2026-10',${literal("https://" + s.shop + "/admin/oauth/install_custom_app")},'active',1,${at},NULL);`,
        `INSERT INTO morrow_identity.store_installations(organization_id,workspace_id,id,app_key,shop_id,shop_domain,store_id,connection_id,generation,status,granted_scopes,credential_id,credential_version,development_store,link_id,revision,created_at,updated_at,reauthorised_at,linked_at)
 SELECT ${literal(s.org)},${literal(s.ws)},${literal(s.installation)},${literal(s.appKey)},${literal(s.shopId)},${literal(s.shop)},${literal(s.store)},${literal(s.connection)},1,'unlinked',ARRAY['read_products','write_products'],${literal(s.credential)},1,true,NULL,1,t,t,NULL,NULL FROM (SELECT ${at}-interval '2 seconds' AS t) x;`,
        `INSERT INTO morrow_identity.linking_candidates VALUES(${literal(candidate)},'shopify','synthetic_app','synthetic_env',${literal(s.shopId)},${literal(s.shop)},${literal(s.installation)},1,true,1,'controlled_fixture',${literal(randomUUID())},1,${literal(sha(s.installation))},${literal(s.owner.principal)},clock_timestamp()-interval '2 seconds',clock_timestamp()+interval '1 hour',NULL);`,
        `INSERT INTO morrow_identity.workspace_store_links VALUES(${literal(link)},${literal(candidate)},${literal(s.org)},${literal(s.ws)},${literal(s.installation)},1,1,${literal(s.owner.principal)},clock_timestamp()-interval '1 second');`,
        `UPDATE morrow_identity.store_installations SET status='linked',link_id=${literal(link)},linked_at=greatest(${at}-interval '1 second',created_at),updated_at=greatest(${at}-interval '1 second',created_at),revision=revision+1 WHERE id=${literal(s.installation)};`,
      ].join("\n");
    };
    for (const [name, s] of Object.entries(stores)) {
      s.org = s.owner.org;
      s.ws = s.owner.workspace;
      s.store = randomUUID();
      s.connection = randomUUID();
      s.installation = randomUUID();
      s.credential = randomUUID();
      s.agent = "agentinst_" + name.toLowerCase();
      s.agentPrincipal = "agent_" + randomUUID();
      s.appKey = "lab-health-" + name.toLowerCase();
      s.shop = s.appKey + ".myshopify.com";
      s.shopId = String(BigInt("0x" + sha(s.appKey).slice(0, 12)) + 1n);
      s.secret = "shpss_" + randomBytes(16).toString("hex");
      s.token = "shpat_" + randomBytes(16).toString("hex");
      privateMarkers.push(s.secret, s.token);
      statements.push(
        storeSql(s),
        `INSERT INTO morrow_identity.principals VALUES(${literal(s.agentPrincipal)},'agent',true);`,
        `INSERT INTO morrow_identity.agent_principals(principal_id,organization_id,workspace_id,role,installation_id,created_at) VALUES(${literal(s.agentPrincipal)},${literal(s.org)},${literal(s.ws)},'installation',${literal(s.agent)},date_trunc('milliseconds',clock_timestamp()));`,
      );
    }
    db.admin(statements.join("\n"));
    const tx = "date_trunc('milliseconds',clock_timestamp())";
    for (const s of Object.values(stores)) {
      // The store's Listings agent (sim: owner-seeded, as lab:listings-authority D10) and an
      // active run lease of it, which a stop of that agent revokes.
      db.workOwner(
        `INSERT INTO morrow_work.agent_installations(organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,connection_id,agent_principal_id,owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at)
SELECT ${literal(s.org)},${literal(s.ws)},${literal(s.agent)},1,r.id,r.revision,r.digest,${literal(s.store)},${literal(s.connection)},${literal(s.agentPrincipal)},${literal(s.owner.principal)},${literal(s.owner.membership)},'active',morrow_work.listings_scope(${literal(s.org)},${literal(s.ws)},${literal(s.store)},${literal(s.connection)}),(SELECT jsonb_agg(jsonb_build_object('organizationId',${literal(s.org)},'workspaceId',${literal(s.ws)},'storeId',${literal(s.store)},'kind','grant','id','g_ref_'||n,'revision',1,'digest',repeat('a',64))) FROM generate_series(1,3) n),repeat('b',64),${tx},${tx} FROM morrow_work.agent_releases r WHERE r.id='morrow.listings' AND r.revision=1;
INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,initiator_principal_id,initiator_membership_id,status,revoked_reason,created_at,expires_at,started_at,ended_at)
SELECT ${literal(s.org)},${literal(s.ws)},${literal(randomUUID())},1,'run',${literal("run_" + s.store)},${literal(s.store)},${literal(s.connection)},${literal(s.agent)},${literal(s.owner.principal)},${literal(s.owner.membership)},'active',NULL,t,t+interval '30 minutes',NULL,NULL FROM (SELECT ${tx} AS t) x;`,
      );
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
    // D's store content: one product snapshot (sim: owner-seeded, as a run's read writes it).
    const snapshot = JSON.stringify({
      productId: "product:101",
      title: "Lab product",
      descriptionHtml: "<p>Lab</p>",
      seo: { title: null, description: null },
      tags: [],
    });
    db.workOwner(
      `INSERT INTO morrow_work.product_snapshots(organization_id,workspace_id,store_id,digest,product_id,canonical,read_at,expires_at) SELECT ${literal(stores.D.org)},${literal(stores.D.ws)},${literal(stores.D.store)},morrow_work.sha256_text(${literal(snapshot)}),'product:101',${literal(snapshot)},t,t+interval '90 days' FROM (SELECT ${tx} AS t) x;`,
    );
    const ownerRows = (q) => db.rows(q, { role: "morrow_identity_owner" });
    const workRows = (q) => db.rows(q, { role: "morrow_work_owner" });
    const installationOf = (id) =>
      ownerRows(
        `SELECT id::text,status,array_to_string(granted_scopes,',') AS scopes,scopes_observed_at IS NOT NULL AS observed,token_refused_at IS NOT NULL AS refused,credential_destroyed_at IS NOT NULL AS token_destroyed,redacted_at IS NOT NULL AS redacted,store_id::text,connection_id::text,credential_version::int AS version,link_id IS NOT NULL AS linked FROM morrow_identity.store_installations WHERE id=${literal(id)}`,
      )[0];
    const credentialsOf = (id) =>
      workRows(
        `SELECT version::int,status,wrapped_key IS NULL AS erased,destroy_reason FROM morrow_vault.credentials WHERE subject_id=${literal(id)} ORDER BY version`,
      );
    const connectionStops = (s) =>
      workRows(
        `SELECT reason_code,set_by_kind FROM morrow_work.stop_controls WHERE scope='connection' AND target_id=${literal(s.connection)} AND lifted_at IS NULL`,
      );
    const agentStops = (s) =>
      workRows(
        `SELECT reason_code,set_by_kind,reason FROM morrow_work.stop_controls WHERE scope='installation' AND target_id=${literal(s.agent)} AND lifted_at IS NULL`,
      );
    const agentRecords = (s) =>
      workRows(
        `SELECT action,actor_kind,reason_code FROM morrow_work.stop_records WHERE scope='installation' AND target_id=${literal(s.agent)}`,
      );
    const leaseOf = (s) =>
      workRows(
        `SELECT status,revoked_reason FROM morrow_work.work_leases WHERE kind='run' AND installation_id=${literal(s.agent)}`,
      )[0];
    const noticesOf = (s) =>
      workRows(
        `SELECT id::text,cause,missing_scopes,stopped_installations,recipients,cleared_reason,revision::int,source_inbox_id FROM morrow_work.connection_notices WHERE connection_id=${literal(s.connection)} ORDER BY created_at,id`,
      );
    const inboxRow = (webhookId) =>
      ownerRows(
        `SELECT id::text,status,outcome,effects,installation_id::text AS installation FROM morrow_identity.shopify_webhook_inbox WHERE webhook_id=${literal(webhookId)}`,
      )[0];
    check(
      "F1:four_linked_stores_each_with_a_listings_agent_a_run_lease_and_a_sealed_token",
      Object.values(stores).every(
        (s) =>
          s.secretStored === "stored" &&
          installationOf(s.installation)?.status === "linked" &&
          credentialsOf(s.installation)[0]?.status === "active" &&
          leaseOf(s)?.status === "active",
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
    const checker = createShopifyHealthChecker({
      transaction,
      fetch: shopifyFetch,
      now: () => Date.now(),
    });
    const faults = { destroy: false };
    const calls = { check: 0, destroy: [] };
    const connectorDatabase = createConnectorDatabase(
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
    );
    const connectorBroker = {
      shopifyLaunchVerify: (appKey, rawQuery) => broker.launchVerify(brokerEnv, appKey, rawQuery),
      shopifyInstallComplete: (appKey, rawQuery, digest, budgetMs) =>
        broker.installComplete(brokerEnv, appKey, rawQuery, digest, budgetMs),
      shopifyWebhookVerify: (appKey, headersJson, rawBodyBase64) =>
        broker.webhookVerify(brokerEnv, appKey, headersJson, rawBodyBase64),
      async shopifyCredentialDestroy(installationId, reason) {
        calls.destroy.push({ installationId, reason });
        if (faults.destroy) throw Error("lab: the ConnectorBroker binding is unreachable");
        return broker.credentialDestroy(brokerEnv, installationId, reason);
      },
      async shopifyConnectionCheck(installationId, budgetMs) {
        calls.check++;
        return checker.check(brokerEnv, installationId, Math.min(10000, budgetMs));
      },
    };
    const makeConnector = (cleanup) =>
      createConnectorHandler({
        configuration: { origin: connectorOrigin, apiOrigin: workFixtureOrigin },
        broker: connectorBroker,
        database: connectorDatabase,
        limiters: null,
        cleanup,
      });
    const connector = makeConnector(false);
    const cleaning = makeConnector(true);
    // One delivery through a connector's /webhooks; the waitUntil work is awaited first.
    async function deliver(s, topic, body, overrides = {}, via = connector) {
      const hook = s.oracle.webhook(topic, body, overrides);
      const pending = [];
      const response = await via.fetch(
        new Request(`${connectorOrigin}/shopify/a/${s.appKey}/webhooks`, {
          method: "POST",
          headers: { "content-type": "application/json", ...hook.headers },
          body: hook.body,
        }),
        { waitUntil: (p) => pending.push(p) },
      );
      const waited = await Promise.all(pending);
      return {
        status: response.status,
        webhookId: hook.headers["x-shopify-webhook-id"],
        applied: waited[0] ?? null,
      };
    }
    const scopesBody = (current, previous = ["write_products"]) => ({ id: 1, previous, current });
    // The broker's launch verdict for a store; a held call is reported, never thrown.
    const launchOf = (s) =>
      broker
        .launchVerify(brokerEnv, s.appKey, s.oracle.launchQuery())
        .then(decodeShopifyLaunchVerdict)
        .catch((error) => ({ verdict: "error", code: error?.code ?? "unknown" }));
    const shopBody = (s) => ({ id: Number(s.shopId), name: "Lab", myshopify_domain: s.shop });
    const viewerNotices = (p) => {
      const out = db.sql(
        asApi(
          p,
          `SELECT COALESCE(json_agg(row_to_json(n)),'[]'::json)::text FROM morrow_work.connection_notices_open() n;`,
        ),
        { user: "morrow_api_worker" },
      );
      return decodeReconnectNotices(JSON.parse(out.split("\n").at(-1) ?? "[]"));
    };
    const { G, H, D, T } = stores;
    const reasonText = systemInstallationStopReasons.shopify_scope_missing;

    // -------------------------------------------------------------------------
    // G: a scope change keeps the connection (ADR-0025 item 10).
    phase("scopes");
    const unchanged = await deliver(G, "app/scopes_update", scopesBody(["write_products"]));
    const unchangedRow = inboxRow(unchanged.webhookId);
    check(
      "G1:a_delivery_that_keeps_the_scopes_records_them_unchanged_and_stops_nothing",
      unchanged.status === 200 &&
        unchanged.applied === "applied" &&
        unchangedRow?.status === "applied" &&
        unchangedRow.outcome === "scopes_recorded" &&
        unchangedRow.effects?.scopes === "unchanged" &&
        unchangedRow.effects?.notice === "none" &&
        installationOf(G.installation).scopes === "read_products,write_products" &&
        agentStops(G).length === 0 &&
        noticesOf(G).length === 0,
      { unchangedRow },
    );
    const narrowed = await deliver(G, "app/scopes_update", scopesBody(["read_products"]));
    const narrowedRow = inboxRow(narrowed.webhookId);
    const gNotice = noticesOf(G);
    check(
      "G2:a_lost_scope_keeps_the_connection_and_its_token",
      narrowed.status === 200 &&
        narrowedRow?.status === "applied" &&
        narrowedRow.effects?.scopes === "narrowed" &&
        installationOf(G.installation).status === "linked" &&
        installationOf(G.installation).scopes === "read_products" &&
        installationOf(G.installation).token_destroyed === false &&
        JSON.stringify(credentialsOf(G.installation).map((c) => c.status)) === '["active"]' &&
        connectionStops(G).length === 0 &&
        !calls.destroy.some((c) => c.installationId === G.installation),
      { installation: installationOf(G.installation), narrowedRow },
    );
    check(
      "G3:only_the_agent_that_needs_the_scope_stops_with_a_system_stop_and_its_lease_revoked",
      JSON.stringify(agentStops(G)) ===
        JSON.stringify([
          { reason_code: "shopify_scope_missing", set_by_kind: "system", reason: reasonText },
        ]) &&
        JSON.stringify(agentRecords(G)) ===
          JSON.stringify([
            { action: "set", actor_kind: "system", reason_code: "shopify_scope_missing" },
          ]) &&
        leaseOf(G)?.status === "revoked" &&
        leaseOf(G).revoked_reason === "stop" &&
        narrowedRow.effects?.agents_stopped === 1 &&
        narrowedRow.effects?.agents_newly_stopped === 1 &&
        [H, D, T].every((s) => agentStops(s).length === 0 && leaseOf(s)?.status === "active"),
      { stops: agentStops(G), lease: leaseOf(G) },
    );
    check(
      "G4:one_reconnect_item_names_the_missing_scope_the_stopped_agent_and_the_steward_and_owner",
      gNotice.length === 1 &&
        gNotice[0].cause === "scopes_missing" &&
        JSON.stringify(gNotice[0].missing_scopes) === '["write_products"]' &&
        JSON.stringify(gNotice[0].stopped_installations) === JSON.stringify([G.agent]) &&
        JSON.stringify(gNotice[0].recipients) === JSON.stringify([A.principal]) &&
        gNotice[0].cleared_reason === null &&
        gNotice[0].source_inbox_id === narrowedRow.id &&
        narrowedRow.effects?.notice === "raised",
      gNotice,
    );
    const seenByA = viewerNotices(A);
    check(
      "G5:the_inbox_seam_shows_the_item_to_its_recipients_only",
      seenByA.length === 1 &&
        seenByA[0].kind === "reconnect" &&
        seenByA[0].open === true &&
        seenByA[0].connectionId === G.connection &&
        JSON.stringify(seenByA[0].missingScopes) === '["write_products"]' &&
        viewerNotices(X).length === 0 &&
        viewerNotices(Y).length === 0,
      { seenByA },
    );
    // Out of order: a delivery that names write_products again only narrows (the read-back or
    // a re-authorisation adds a scope back), and nothing resumes.
    const restoredLate = await deliver(
      G,
      "app/scopes_update",
      scopesBody(["write_products"], ["read_products"]),
    );
    check(
      "G6:a_later_delivery_never_widens_the_scopes_and_nothing_resumes_by_itself",
      restoredLate.applied === "applied" &&
        installationOf(G.installation).scopes === "read_products" &&
        agentStops(G).length === 1 &&
        noticesOf(G).length === 1 &&
        noticesOf(G)[0].cleared_reason === null &&
        inboxRow(restoredLate.webhookId)?.effects?.notice === "unchanged",
    );
    // The launch offers the reconnect: a re-authorisation through OAuth with the app's scopes.
    const gLaunch = await launchOf(G);
    const gLaunchPage = await connector.fetch(
      new Request(`${connectorOrigin}/shopify/a/${G.appKey}/launch?${G.oracle.launchQuery()}`),
      { waitUntil() {} },
    );
    const authorize = gLaunchPage.headers.get("location") ?? "";
    check(
      "G7:the_launch_reports_reconnect_and_starts_oauth_for_the_apps_scopes",
      gLaunch.verdict === "verified" &&
        gLaunch.installation === "reconnect" &&
        gLaunchPage.status === 302 &&
        authorize.startsWith(`https://${G.shop}/admin/oauth/authorize?`) &&
        new URL(authorize).searchParams.get("scope") === "read_products,write_products",
      { gLaunch, status: gLaunchPage.status },
    );
    // The reconnect: the callback's re-authorisation records the new token's scopes.
    const stateOpen = (s, digest) =>
      db
        .sql(
          `SELECT outcome FROM morrow_identity.connector_oauth_state_open(${literal(s.appKey)},${literal(s.shop)},${literal(digest)});`,
          { user: "morrow_connector_ingress" },
        )
        .split("\n")
        .at(-1);
    const oauth = async (s) => {
      const state = randomBytes(32).toString("base64url");
      const opened = stateOpen(s, sha(state));
      const result = decodeShopifyInstallResult(
        await broker.installComplete(
          brokerEnv,
          s.appKey,
          s.oracle.callbackQuery(state),
          sha(state),
          10000,
        ),
      );
      return { opened, result };
    };
    const reconnected = await oauth(G);
    const afterReconnect = viewerNotices(A);
    check(
      "G8:reconnecting_through_the_install_link_restores_the_scopes_and_the_item_reads_closed",
      reconnected.opened === "opened" &&
        reconnected.result.outcome === "reauthorised" &&
        installationOf(G.installation).scopes === "read_products,write_products" &&
        installationOf(G.installation).version === 2 &&
        installationOf(G.installation).observed === true &&
        afterReconnect.length === 1 &&
        afterReconnect[0].open === false,
      { reconnected: reconnected.result.outcome, afterReconnect },
    );
    const cron = await connector.redrive();
    check(
      "G9:the_cron_clears_the_item_and_the_agent_stays_stopped_until_a_person_resumes_it",
      cron.notices >= 1 &&
        noticesOf(G)[0].cleared_reason === "scopes_restored" &&
        viewerNotices(A).length === 0 &&
        agentStops(G).length === 1 &&
        leaseOf(G)?.status === "revoked" &&
        cron.checks === 0,
      { cron, notice: noticesOf(G) },
    );
    // A stop already stands on H's agent (sim: an operator's installation stop, as a person's
    // own "Stop AI work" would): a scope change keeps that stop alone (0020's one open stop per
    // target) and names the agent; once it is lifted while the scope is still missing, the
    // cron's reconcile stops the agent again.
    const standingStopId = randomUUID();
    db.workOwner(
      `INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,set_by_operator_id,reason_code,reason,created_at) VALUES(${literal(H.org)},${literal(H.ws)},${literal(standingStopId)},'installation',${literal(H.store)},${literal(H.agent)},'operator',NULL,NULL,'operator_lab','operator_pause','Paused by the operator.',${tx});`,
    );
    const hNarrowed = await deliver(H, "app/scopes_update", scopesBody([]));
    const hStopsBefore = agentStops(H);
    db.workOwner(
      `UPDATE morrow_work.stop_controls SET lifted_at=greatest(${tx},created_at),lifted_by_kind='operator',lifted_by_operator_id='operator_lab' WHERE id=${literal(standingStopId)};`,
    );
    await connector.redrive();
    check(
      "G10:a_standing_stop_stays_alone_and_a_lift_while_a_scope_is_missing_is_stopped_again",
      hNarrowed.applied === "applied" &&
        installationOf(H.installation).scopes === "" &&
        JSON.stringify(hStopsBefore.map((s) => s.set_by_kind)) === '["operator"]' &&
        JSON.stringify(noticesOf(H)[0]?.stopped_installations) === JSON.stringify([H.agent]) &&
        JSON.stringify(noticesOf(H)[0]?.missing_scopes) === '["read_products","write_products"]' &&
        JSON.stringify(agentStops(H).map((s) => [s.set_by_kind, s.reason_code])) ===
          '[["system","shopify_scope_missing"]]',
      { hStopsBefore, after: agentStops(H), notice: noticesOf(H) },
    );

    // -------------------------------------------------------------------------
    // C: the read-back (the clean-up switch on): what Shopify answers, recorded.
    phase("read_back");
    const offRun = calls.check;
    check(
      "C1:with_the_switch_off_no_read_back_is_asked",
      offRun === 0 && T.oracle.state.calls.length === 0,
    );
    // H's scopes are back at Shopify (a missed scopes_update): the cron's read-back records
    // them, the item clears, and H's agent stays stopped.
    H.oracle.state.accessScopes = ["read_products", "write_products"];
    const onRun = await cleaning.redrive();
    // G was observed at its re-authorisation, so H, D and T are due.
    check(
      "C2:the_daily_read_back_reconciles_a_missed_scope_change_and_resumes_nothing",
      onRun.checks === 3 &&
        onRun.observed === 3 &&
        installationOf(H.installation).scopes === "read_products,write_products" &&
        installationOf(H.installation).observed === true &&
        noticesOf(H)[0]?.cleared_reason === "scopes_restored" &&
        agentStops(H).length === 1 &&
        installationOf(T.installation).observed === true &&
        T.oracle.state.calls.filter((c) => c.operation === "AccessScopes").length === 1,
      { onRun, h: installationOf(H.installation) },
    );
    // Not due again within 24 hours.
    const again = await cleaning.redrive();
    // A refused token (sim: the oracle no longer holds D's token, as after a missed
    // uninstall): recorded, every agent of the store stopped, a Reconnect item with the token
    // cause; the launch offers the reconnect. Nothing is assumed ended.
    D.oracle.state.tokens.length = 0;
    db.sql(
      `SET session_replication_role=replica; UPDATE morrow_identity.store_installations SET scopes_observed_at=scopes_observed_at-interval '25 hours',created_at=created_at-interval '25 hours' WHERE id=${literal(D.installation)}; SET session_replication_role=origin;`,
    );
    const refusedRun = await cleaning.redrive();
    const dLaunch = await launchOf(D);
    check(
      "C3:a_refused_token_is_recorded_stops_the_stores_agents_and_raises_reconnect_never_an_uninstall",
      again.checks === 0 &&
        refusedRun.checks === 1 &&
        refusedRun.refused === 1 &&
        installationOf(D.installation).refused === true &&
        installationOf(D.installation).status === "linked" &&
        JSON.stringify(agentStops(D).map((s) => s.reason_code)) === '["shopify_token_refused"]' &&
        noticesOf(D)[0]?.cause === "token_refused" &&
        dLaunch.installation === "reconnect" &&
        consoleLines.some((l) => l.includes('"code":"TOKEN_REFUSED"')),
      { again, refusedRun, d: installationOf(D.installation), stops: agentStops(D) },
    );
    // An unclear answer records nothing; a stale token version records nothing.
    T.oracle.state.fault = "oversize";
    const unclear = decodeShopifyConnectionCheck(
      await checker.check(brokerEnv, T.installation, 10000),
    );
    T.oracle.state.fault = null;
    const stale = db
      .sql(
        `SELECT morrow_vault.shopify_check_record(${literal(T.installation)},'9','observed','[]');`,
        { user: "morrow_vault_broker" },
      )
      .split("\n")
      .at(-1);
    const notLive = decodeShopifyConnectionCheck(
      await checker.check(brokerEnv, "storeinst_absent", 10000),
    );
    check(
      "C4:an_unclear_answer_or_a_stale_token_records_nothing",
      unclear === "unavailable" &&
        stale === "stale" &&
        notLive === "not_applicable" &&
        installationOf(T.installation).scopes === "read_products,write_products",
      { unclear, stale, notLive },
    );
    // A recorded narrowing whose reconcile was lost (sim: H's scopes narrowed by the identity
    // owner, the guard's narrowing path, with no reconcile): the cron's reconcile list names
    // it, so its item is raised again, and H's agent keeps its system stop.
    // (It narrows from C2's restored scopes; reported, not thrown, if C2 did not restore them.)
    const lostNarrowing = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_identity_owner; UPDATE morrow_identity.store_installations SET granted_scopes=ARRAY['read_products'],revision=revision+1,updated_at=greatest(${tx},updated_at) WHERE id=${literal(H.installation)}; COMMIT;`,
    );
    const lostRun = await connector.redrive();
    const hOpen = noticesOf(H).filter((n) => n.cleared_reason === null);
    check(
      "C5:a_recorded_narrowing_whose_reconcile_was_lost_is_reconciled_by_the_cron",
      lostNarrowing.ok &&
        lostRun.notices >= 1 &&
        hOpen.length === 1 &&
        JSON.stringify(hOpen[0].missing_scopes) === '["write_products"]' &&
        JSON.stringify(hOpen[0].stopped_installations) === JSON.stringify([H.agent]) &&
        JSON.stringify(agentStops(H).map((s) => s.reason_code)) === '["shopify_scope_missing"]' &&
        agentStops(T).length === 0,
      { narrowed: lostNarrowing.ok, lostRun, notices: noticesOf(H) },
    );

    // -------------------------------------------------------------------------
    // R: reinstall after an uninstall.
    phase("reinstall");
    const R = { owner: A, store: null };
    R.appKey = "lab-reinstall";
    R.shop = "lab-reinstall.myshopify.com";
    R.shopId = "777001";
    R.secret = "shpss_" + randomBytes(16).toString("hex");
    privateMarkers.push(R.secret);
    R.installUrl = `https://${R.shop}/admin/oauth/install_custom_app?client_id=lab`;
    R.clientId = randomBytes(16).toString("hex");
    const registered = ownerRows(
      `SELECT outcome FROM morrow_identity.shopify_app_register(${literal(R.appKey)},${literal(R.clientId)},'development',${literal(sha(R.shop))},${literal(A.org)},${literal(A.workspace)},${literal(R.installUrl)})`,
    )[0]?.outcome;
    const rApp = await sealVaultRecord(
      keyring,
      { kind: "app_secret", appKey: R.appKey, provider: "shopify", version: 1 },
      new TextEncoder().encode(R.secret),
    );
    workRows(
      `SELECT outcome FROM morrow_vault.app_secret_put(${literal(R.appKey)},'1',${literal(vaultBytesHex(rApp.wrappedKey))},${literal(vaultBytesHex(rApp.sealedValue))})`,
    );
    R.oracle = createShopifyOracle({
      secret: R.secret,
      clientId: R.clientId,
      shop: R.shop,
      shopId: R.shopId,
    });
    oracles.set(R.shop, R.oracle);
    const rInstallations = () =>
      ownerRows(
        `SELECT id::text,status,store_id::text,connection_id::text,credential_id::text,link_id IS NOT NULL AS linked,credential_destroyed_at IS NOT NULL AS token_destroyed FROM morrow_identity.store_installations WHERE app_key=${literal(R.appKey)} ORDER BY created_at,id`,
      );
    const rCandidates = () =>
      ownerRows(
        `SELECT installation_id::text,active,proof_revoked_at IS NOT NULL AS revoked FROM morrow_identity.linking_candidates WHERE application_id=${literal(R.clientId)} ORDER BY proof_created_at,id`,
      );
    // The person's link (the issuer, lookup and apply as the linking login).
    const linkingPool = {
      async connect(control) {
        const c = await db.connector({ user: "morrow_identity_linking" }).open({
          signal: control.signal,
          deadlineMs: control.deadlineMs,
          waitUntil() {},
        });
        return {
          query: (text, values, ctl) => c.query(text, [...values], ctl.signal),
          release: () => c.close(),
        };
      },
    };
    const kernel = createConnectionKernel();
    const service = createControlledWorkspaceStoreLinking({ pool: linkingPool, now: Date.now });
    // A thrown error (an unclear outcome under a loaded engine) is reported as the outcome, so
    // the checks that need it fail with a reason and the later phases still run.
    const linkAs = (p, token) =>
      linkOnce(p, token).catch((error) => ({ outcome: "error_" + (error?.code ?? "unknown") }));
    const linkOnce = async (p, token) => {
      const abort = new AbortController();
      const ctx = Object.freeze({
        workspaceId: p.workspace,
        sessionDigest: p.digest,
        commandId: randomUUID(),
        nonceDigest: sha(token),
        csrfToken: null,
        control: Object.freeze({ deadlineMs: Date.now() + 60000, signal: abort.signal }),
        check: () => Date.now(),
        wait: (x) => x,
      });
      const issued = await runShopifyLinkIssuer(linkingPool, Date.now, kernel, ctx);
      if (issued !== "proceed") return { outcome: "issuer_" + issued.status };
      const input = await service.lookup(
        JSON.stringify({
          sessionDigest: ctx.sessionDigest,
          workspaceId: p.workspace,
          nonceDigest: ctx.nonceDigest,
          commandId: ctx.commandId,
        }),
        ctx.control,
      );
      if (!input) return { outcome: "lookup_none" };
      return service.apply(JSON.stringify(input), ctx.control);
    };
    const first = await oauth(R);
    const firstLink = await linkAs(A, first.result.continuationToken);
    const r1 = rInstallations()[0];
    check(
      "R1:a_first_install_is_linked_by_the_owner",
      registered === "registered" &&
        first.result.outcome === "installed" &&
        firstLink.outcome === "applied" &&
        r1?.status === "linked",
      { registered, first: first.result.outcome, firstLink },
    );
    // The uninstall, with the token's destruction lost (the binding is unreachable): the
    // installation ends, its connection stops, and the token is left for the re-drive.
    faults.destroy = true;
    R.oracle.state.tokens.length = 0;
    const rUninstall = await deliver(R, "app/uninstalled", shopBody(R));
    faults.destroy = false;
    check(
      "R2:an_uninstall_ends_the_installation_and_stops_its_connection",
      rUninstall.status === 200 &&
        rInstallations()[0]?.status === "uninstalled" &&
        rInstallations()[0].token_destroyed === false &&
        credentialsOf(r1.id)[0]?.status === "active" &&
        workRows(
          `SELECT count(*)::int AS n FROM morrow_work.stop_controls WHERE scope='connection' AND target_id=${literal(r1.connection_id)} AND lifted_at IS NULL`,
        )[0].n === 1,
    );
    const rLaunch = await launchOf(R);
    const rLaunchPage = await connector.fetch(
      new Request(`${connectorOrigin}/shopify/a/${R.appKey}/launch?${R.oracle.launchQuery()}`),
      { waitUntil() {} },
    );
    const offer = db.rows(
      `SELECT app_registered,install_url FROM morrow_identity.workspace_connections(${literal(A.digest)},${literal(A.workspace)})`,
      { user: "morrow_identity_linking" },
    )[0];
    check(
      "R3:an_uninstalled_app_launches_a_reinstall_and_its_install_link_is_offered",
      rLaunch.installation === "uninstalled" &&
        rLaunchPage.status === 302 &&
        offer?.app_registered === true &&
        offer.install_url !== null,
      { rLaunch, status: rLaunchPage.status, offer },
    );
    const reinstall = await oauth(R);
    const [oldR, newR] = rInstallations();
    check(
      "R4:the_reinstall_is_a_new_installation_with_a_new_token_and_the_old_one_destroyed",
      reinstall.result.outcome === "installed" &&
        reinstall.result.continuationToken !== null &&
        rInstallations().length === 2 &&
        oldR.status === "uninstalled" &&
        oldR.token_destroyed === true &&
        JSON.stringify(credentialsOf(oldR.id)) ===
          JSON.stringify([
            { version: 1, status: "destroyed", erased: true, destroy_reason: "uninstalled" },
          ]) &&
        newR.status === "unlinked" &&
        newR.linked === false &&
        newR.store_id !== oldR.store_id &&
        newR.connection_id !== oldR.connection_id &&
        newR.credential_id !== oldR.credential_id &&
        JSON.stringify(credentialsOf(newR.id).map((c) => c.status)) === '["active"]',
      { rInstallations: rInstallations(), old: credentialsOf(oldR.id) },
    );
    check(
      "R5:the_old_candidate_steps_aside_and_nothing_links_without_a_person",
      JSON.stringify(rCandidates().map((c) => [c.installation_id === newR.id, c.active])) ===
        JSON.stringify([
          [false, false],
          [true, true],
        ]) &&
        ownerRows(
          `SELECT count(*)::int AS n FROM morrow_identity.workspace_store_links WHERE installation_id=${literal(newR.id)}`,
        )[0].n === 0,
      rCandidates(),
    );
    const relink = await linkAs(A, reinstall.result.continuationToken);
    const linkedR = rInstallations()[1];
    const newGrants = ownerRows(
      `SELECT count(*)::int AS n FROM morrow_identity.grants WHERE payload->'issuedBy'->>'principalId'='morrow.linking' AND payload->'scope'->'storeIds'=jsonb_build_array(${literal(newR.store_id)}::text)`,
    )[0].n;
    check(
      "R6:the_person_links_the_reinstalled_store_and_gets_the_store_link_grants_on_the_new_store",
      relink.outcome === "applied" && linkedR.status === "linked" && newGrants === 5,
      { relink, linkedR, newGrants },
    );

    // -------------------------------------------------------------------------
    // D: the 48-hour deletion (ADR-0031 item 3).
    phase("deletion");
    const dUninstall = await deliver(D, "app/uninstalled", shopBody(D));
    const deletionsOf = (id) =>
      ownerRows(
        `SELECT status,evidence,trigger,(due_at=uninstalled_at+interval '48 hours') AS due_ok FROM morrow_identity.store_data_deletions WHERE installation_id=${literal(id)}`,
      );
    const snapshotsOf = (s) =>
      workRows(
        `SELECT count(*)::int AS n FROM morrow_work.product_snapshots WHERE store_id=${literal(s.store)}`,
      )[0].n;
    const early = await cleaning.redrive();
    check(
      "D1:an_uninstall_starts_the_clock_and_nothing_is_deleted_before_48_hours",
      dUninstall.status === 200 &&
        installationOf(D.installation).status === "uninstalled" &&
        installationOf(D.installation).token_destroyed === true &&
        early.deletions === 0 &&
        deletionsOf(D.installation).length === 0 &&
        snapshotsOf(D) === 1 &&
        noticesOf(D)[0]?.cleared_reason === "connection_ended",
      { early, notice: noticesOf(D) },
    );
    const backdateUninstall = (id, hours) =>
      db.sql(
        `SET session_replication_role=replica; UPDATE morrow_identity.store_installations SET uninstalled_at=uninstalled_at-interval '${hours} hours',created_at=created_at-interval '${hours} hours' WHERE id=${literal(id)}; SET session_replication_role=origin;`,
      );
    backdateUninstall(D.installation, 49);
    const deletedRun = await connector.redrive();
    const offDeletion = deletionsOf(D.installation).length;
    const onDeletion = await cleaning.redrive();
    const dRecord = deletionsOf(D.installation)[0];
    const dHandlers = (dRecord?.evidence?.handlers ?? []).map((h) => h.table).sort();
    check(
      "D2:after_48_hours_the_stores_data_is_deleted_once_with_its_record",
      deletedRun.deletions === 0 &&
        offDeletion === 0 &&
        onDeletion.deletions === 1 &&
        onDeletion.deleted === 1 &&
        dRecord?.status === "completed" &&
        dRecord.trigger === "uninstall_48h" &&
        dRecord.due_ok === true &&
        dRecord.evidence.kind === "store_deleted" &&
        dRecord.evidence.credential === "destroyed" &&
        JSON.stringify(dRecord.evidence.outstanding) === "[]" &&
        JSON.stringify(dHandlers) ===
          JSON.stringify(storeContentHandlers.map((h) => h.table).sort()) &&
        snapshotsOf(D) === 0 &&
        installationOf(D.installation).redacted === true &&
        ownerRows(
          `SELECT install_url IS NULL AS cleared FROM morrow_identity.shopify_apps WHERE app_key=${literal(D.appKey)}`,
        )[0]?.cleared === true,
      { onDeletion, dRecord },
    );
    const settled = await connectorDatabase.deletionApply(D.installation, 10000);
    const afterOnce = await cleaning.redrive();
    check(
      "D3:it_runs_once",
      settled.outcome === "ineligible" || settled.outcome === "settled"
        ? afterOnce.deletions === 0 &&
            ownerRows(
              `SELECT count(*)::int AS n FROM morrow_identity.store_data_deletions WHERE installation_id=${literal(D.installation)}`,
            )[0].n === 1
        : false,
      { settled, afterOnce },
    );
    // R's first installation, reinstalled within the 48 hours (ADR-0031 owner question 2:
    // delete anyway): the earlier installation's data is deleted (its token was destroyed by
    // the reinstall), and the live reinstall keeps its link, its connection and its install
    // link.
    backdateUninstall(oldR.id, 49);
    const rRun = await cleaning.redrive();
    check(
      "D4:a_reinstall_within_48_hours_does_not_keep_the_earlier_installations_data",
      rRun.deleted === 1 &&
        deletionsOf(oldR.id)[0]?.status === "completed" &&
        rInstallations()[0].token_destroyed === true &&
        ownerRows(
          `SELECT redacted_at IS NOT NULL AS r FROM morrow_identity.store_installations WHERE id=${literal(oldR.id)}`,
        )[0].r === true &&
        rInstallations()[1].status === "linked" &&
        ownerRows(
          `SELECT install_url IS NOT NULL AS kept FROM morrow_identity.shopify_apps WHERE app_key=${literal(R.appKey)}`,
        )[0]?.kept === true,
      { rRun, deletion: deletionsOf(oldR.id) },
    );
    // A later uninstall names the live installation, never the old one.
    const second = await deliver(R, "app/uninstalled", shopBody(R));
    check(
      "D7:a_later_uninstall_ends_the_reinstalled_installation_and_its_token",
      second.status === 200 &&
        inboxRow(second.webhookId)?.installation === newR.id &&
        rInstallations()[1].status === "uninstalled" &&
        rInstallations()[1].token_destroyed === true &&
        credentialsOf(newR.id)[0]?.status === "destroyed",
    );
    // A deletion waits for the token: T is uninstalled with its destruction lost, 49 hours ago.
    faults.destroy = true;
    const tUninstall = await deliver(T, "app/uninstalled", shopBody(T));
    backdateUninstall(T.installation, 49);
    const tPending = await cleaning.redrive();
    const tWaiting = deletionsOf(T.installation)[0];
    faults.destroy = false;
    const tDone = await cleaning.redrive();
    check(
      "D5:a_deletion_waits_for_the_tokens_destruction_then_completes_in_its_own_tenant",
      tUninstall.status === 200 &&
        tPending.deletions === 1 &&
        tPending.deleted === 0 &&
        tWaiting?.status === "open" &&
        deletionsOf(T.installation)[0]?.status === "completed" &&
        tDone.destroyed >= 1 &&
        credentialsOf(T.installation)[0]?.status === "destroyed" &&
        installationOf(G.installation).redacted === false &&
        installationOf(H.installation).redacted === false,
      { tPending, tWaiting, tDone },
    );
    // shop/redact after the self-deletion completes at once.
    const lateRedact = await deliver(D, "shop/redact", {
      shop_id: Number(D.shopId),
      shop_domain: D.shop,
    });
    const lateRequest = ownerRows(
      `SELECT status,evidence->>'kind' AS kind FROM morrow_identity.privacy_requests WHERE inbox_id=${literal(inboxRow(lateRedact.webhookId)?.id ?? "")}`,
    )[0];
    check(
      "D6:a_shop_redact_after_the_deletion_completes_at_once",
      lateRedact.status === 200 &&
        lateRedact.applied === "applied" &&
        lateRequest?.status === "completed" &&
        lateRequest.kind === "shop_redacted",
      { lateRequest },
    );

    // -------------------------------------------------------------------------
    // S: stuck deliveries.
    phase("stuck");
    const recordOnly = async (s, topic, body) => {
      const hook = s.oracle.webhook(topic, JSON.stringify(body));
      return decodeShopifyWebhookVerdict(
        await broker.webhookVerify(
          brokerEnv,
          s.appKey,
          JSON.stringify(hook.headers),
          Buffer.from(hook.body).toString("base64"),
        ),
      );
    };
    const backdateInbox = (id, hours) =>
      db.sql(
        `SET session_replication_role=replica; UPDATE morrow_identity.shopify_webhook_inbox SET received_at=received_at-interval '${hours} hours',expires_at=expires_at-interval '${hours} hours' WHERE id=${literal(id)}; SET session_replication_role=origin;`,
      );
    const stuckScopes = await recordOnly(G, "app/scopes_update", scopesBody(["write_products"]));
    const stuckRedact = await recordOnly(G, "shop/redact", {
      shop_id: Number(G.shopId),
      shop_domain: G.shop,
    });
    backdateInbox(stuckScopes.inboxId, 25);
    backdateInbox(stuckRedact.inboxId, 25);
    const stuck = await connectorDatabase.inboxStuck(10000);
    const statusOf = (id) =>
      ownerRows(
        `SELECT status,outcome FROM morrow_identity.shopify_webhook_inbox WHERE id=${literal(id)}`,
      )[0];
    check(
      "S1:a_stuck_scope_change_is_closed_with_its_reason_and_a_privacy_delivery_only_counted",
      stuck.closed === 1 &&
        stuck.stuck === 1 &&
        JSON.stringify(statusOf(stuckScopes.inboxId)) ===
          JSON.stringify({ status: "ignored", outcome: "stuck_closed" }) &&
        statusOf(stuckRedact.inboxId)?.status === "received",
      { stuck },
    );

    // -------------------------------------------------------------------------
    // K: authority.
    phase("authority");
    const asUser = (user, text) => db.tryRun(text, { user }).ok;
    const anyInbox = ownerRows(
      "SELECT id::text FROM morrow_identity.shopify_webhook_inbox ORDER BY received_at LIMIT 1",
    )[0].id;
    check(
      "K1:no_login_but_the_connectors_runs_the_connector_definers",
      ["morrow_api_worker", "morrow_vault_broker", "morrow_runtime_executor"].every(
        (user) =>
          !asUser(
            user,
            `SELECT * FROM morrow_work.connector_inbox_apply_v2(${literal(anyInbox)});`,
          ) &&
          !asUser(
            user,
            `SELECT * FROM morrow_work.connector_health_reconcile(${literal(G.installation)});`,
          ) &&
          !asUser(user, "SELECT * FROM morrow_work.connector_checks_due();") &&
          !asUser(user, "SELECT * FROM morrow_work.connector_notices_due();") &&
          !asUser(user, "SELECT * FROM morrow_work.connector_deletions_due();") &&
          !asUser(
            user,
            `SELECT * FROM morrow_work.connector_deletion_apply(${literal(G.installation)});`,
          ) &&
          !asUser(user, "SELECT * FROM morrow_work.connector_inbox_stuck();"),
      ),
    );
    check(
      "K2:no_login_but_the_brokers_resolves_or_records_a_read_back",
      ["morrow_api_worker", "morrow_connector_ingress", "morrow_runtime_executor"].every(
        (user) =>
          !asUser(
            user,
            `SELECT * FROM morrow_vault.shopify_check_resolve(${literal(G.installation)});`,
          ) &&
          !asUser(
            user,
            `SELECT morrow_vault.shopify_check_record(${literal(G.installation)},'2','observed','["write_products"]');`,
          ) &&
          !asUser(
            user,
            `SELECT * FROM morrow_vault.shopify_install_prepare_v2(${literal(R.appKey)},${literal("a".repeat(64))},${literal(R.shopId)},${literal(R.shop)});`,
          ),
      ),
    );
    // The M2 PR-3 applier can no longer end an installation on a scope change: its row stays
    // received and nothing changes.
    const legacy = await recordOnly(G, "app/scopes_update", scopesBody(["read_products"]));
    const legacyApply = db.tryRun(
      `SELECT outcome FROM morrow_work.connector_inbox_apply(${literal(legacy.inboxId)});`,
      { user: "morrow_connector_ingress" },
    );
    check(
      "K3:the_old_applier_cannot_end_an_installation_on_a_scope_change",
      !legacyApply.ok &&
        statusOf(legacy.inboxId)?.status === "received" &&
        installationOf(G.installation).status === "linked",
    );
    // The guard: a narrowing passes, a widening without an observation is refused (sim: the
    // identity owner, rolled back).
    const narrowOnly = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_identity_owner; UPDATE morrow_identity.store_installations SET granted_scopes='{}',revision=revision+1,updated_at=greatest(${tx},updated_at) WHERE id=${literal(G.installation)}; ROLLBACK;`,
    );
    const widen = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_identity_owner; UPDATE morrow_identity.store_installations SET granted_scopes='{}',revision=revision+1,updated_at=greatest(${tx},updated_at) WHERE id=${literal(G.installation)}; UPDATE morrow_identity.store_installations SET granted_scopes=ARRAY['read_products','write_products'],revision=revision+1,updated_at=greatest(${tx},updated_at) WHERE id=${literal(G.installation)}; ROLLBACK;`,
    );
    check(
      "K4:the_guard_refuses_a_widening_without_a_fresh_observation",
      narrowOnly.ok &&
        !widen.ok &&
        /SHOPIFY_RECORD_IMMUTABLE/.test(widen.stderr) &&
        installationOf(G.installation).scopes === "read_products,write_products",
    );

    // S2: the cron logs stuck deliveries with a fixed code. G's backdated shop/redact (S1) is
    // applied by the cron's re-drive (G is live, so it is ended first) and waits for its
    // token, whose destruction is lost here: it stays received, counted and logged.
    faults.destroy = true;
    const linesBefore = consoleLines.length;
    const stuckRun = await cleaning.redrive();
    faults.destroy = false;
    check(
      "S2:the_cron_logs_inbox_stuck_with_a_count",
      statusOf(stuckRedact.inboxId)?.status === "received" &&
        consoleLines
          .slice(linesBefore)
          .some((l) => l.includes('"code":"INBOX_STUCK"') && l.includes('"deliveries":1')),
      { stuckRun, row: statusOf(stuckRedact.inboxId), lines: consoleLines.slice(linesBefore) },
    );

    // -------------------------------------------------------------------------
    // O: logs and outbound.
    phase("observability");
    const logged = consoleLines.join("\n");
    check(
      "O1:no_secret_or_token_in_any_log",
      privateMarkers.every((m) => typeof m === "string" && m.length > 8 && !logged.includes(m)) &&
        consoleLines.some((l) => l.includes('"event":"morrow_connector_redrive"')),
    );
    check(
      "O2:only_the_oracles_shops_were_called",
      outbound.unexpected.length === 0 &&
        [...oracles.entries()].every(([shop, o]) => o.state.calls.every((c) => c.host === shop)),
      outbound,
    );
    return { checks, failures };
  },
  { administrator: "createrole" },
);

console.log = print;
writeArtifact("labs/connection-health.json", {
  task: "v1 PR 5",
  qualification: "local_postgresql17_network_none_connection_health",
  observedAt: new Date().toISOString(),
  durationMs: Date.now() - labStarted,
  administrator: "createrole",
  sourceDigests,
  checks: report.checks,
  providerRequests: 0,
  limitations: [
    "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data. Shopify is the synthetic oracle (scripts/fixtures/shopify-oracle.mjs), shaped from Shopify's documentation (AccessScopes answers currentAppInstallation.accessScopes).",
    "The connector, broker and identity handlers run in Node over psql bridges logged in as each login, not in workerd over the Neon transport.",
    "The four linked stores, their Listings agents, run leases, sealed tokens and one product snapshot are owner-seeded; a person's Stop AI work and its lift are owner-seeded (sim). Shapes marked sim: inbox rows, uninstall times and observation times backdated past their windows.",
    "Only the Listings release exists, so every agent needs read_products and write_products; the selectivity of the stop across releases is proven in TypeScript (planReconnect, tests/connection-health.test.mjs) and across stores and tenants here.",
    "Resuming an agent after a scope stop is a person's command on ADR-0024 item 2's document (not in this PR): the stops stay, as the checks show.",
  ],
});
if (report.failures.length) {
  print("FAILED: " + report.failures.join(", "));
  process.exitCode = 1;
} else print(`PASS: ${report.checks.length} v1 PR 5 connection health checks.`);
