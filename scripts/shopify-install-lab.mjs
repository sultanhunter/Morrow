// M2 PR-2 PostgreSQL 17 laboratory: the Shopify install and link (migrations located by slug:
// shopify-link-route-read, shopify-install-identity, shopify-vault-install) on an isolated
// network-none engine with the whole manifest applied by the Neon-shaped non-superuser
// CREATEROLE administrator (ADR-0020 D4, the hosted shape). The real TypeScript runs against
// it: the broker's install handlers (createShopifyBroker) on the vault login's transport
// (runVaultTransactionWithDriver over a psql bridge logged in as morrow_vault_broker), the
// connector's OAuth state as morrow_connector_ingress, and the identity issuer, lookup, apply
// and connections read as morrow_identity_linking with the policy package's connection kernel.
// Shopify is the synthetic oracle (scripts/fixtures/shopify-oracle.mjs); no provider,
// credential or merchant data. Runs in the CI pg-linking group. The local superuser is used
// only for fixtures and the shapes marked "sim". v1 PR 1 (ADR-0035 item 2) adds the V
// cases: one app per environment carries the live-store mark for one intended shop; its
// live store installs and links into the owner's workspace; another live store using its
// install link stores nothing; a second marked app is refused; every unmarked app still
// refuses live stores, in the broker and in the database; its end states (uninstall, the
// credential's destruction, shop/redact) still pass. The shop-specific webhook subscriptions
// (docs/briefs/shopify-shop-specific-webhooks.md) add the H cases: the broker's vault login
// alone lists the active installations whose subscriptions are not registered (ids only),
// reads one target with its envelope and records one outcome for the version it used; the
// real sync registers both stores' app/uninstalled and app/scopes_update to the connector's
// path against the synthetic Shopify, idempotently, through a failure's backoff and a
// re-authorisation's new version; an ended installation is never pending; a registered
// store is listed again after 24 hours and only a subscription Shopify removed is created
// again.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";
import { createShopifyBroker } from "../apps/broker/src/shopify-install.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { sealVaultRecord, createVaultKeyring, vaultBytesHex } from "../apps/broker/src/vault.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import { createShopifyWebhookSync } from "../apps/broker/src/shopify-webhooks.ts";
import {
  decodeShopifyInstallResult,
  decodeShopifyLaunchVerdict,
  decodeShopifyWebhookSyncResult,
} from "../packages/identity/src/broker-protocol.ts";
import { createControlledWorkspaceStoreLinking } from "../packages/identity/src/workspace-store-linking-control.ts";
import {
  executeWorkspaceConnections,
  runShopifyLinkIssuer,
} from "../packages/identity/src/shopify-link-issuer.ts";
import { createConnectionKernel } from "../packages/policy/src/connection-authority.ts";
import { createHumanPolicyService, storeResource } from "../packages/policy/src/index.ts";
import { storeLinkGrantTemplate } from "../packages/policy/src/store-link-template.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createConnectorDatabase } from "../apps/shopify-connector/worker/database.ts";
import { literal, withWorkDatabase } from "../tests/tenant-conformance/harness.mjs";
import { createShopifyOracle } from "./fixtures/shopify-oracle.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const checks = [];
const failures = [];
const labStarted = Date.now();
const phase = (value) =>
  console.error(
    "SHOPIFY_INSTALL_LAB_PHASE:" +
      value +
      " t=" +
      Math.round((Date.now() - labStarted) / 1000) +
      "s",
  );
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("SHOPIFY_INSTALL_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
  }
}
// The three migrations of this PR, by slug (numbers change at the final rebase), and v1
// PR 1's two (the live store, ADR-0035 item 2: the V cases).
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const slugs = [
  ".shopify-link-route-read.sql",
  ".shopify-install-identity.sql",
  ".shopify-vault-install.sql",
  ".shopify-live-store-identity.sql",
  ".shopify-live-store-vault.sql",
  ".shopify-webhook-registrations-identity.sql",
  ".shopify-webhook-registrations-vault.sql",
];
const files = slugs.map((slug) => manifest.migrations.find((m) => m.file.endsWith(slug))?.file);
if (files.some((f) => !f)) throw Error("SHOPIFY_INSTALL_LAB_MIGRATIONS_REQUIRED");
const sourceDigests = Object.fromEntries(
  [
    "scripts/shopify-install-lab.mjs",
    "scripts/fixtures/shopify-oracle.mjs",
    "apps/broker/src/shopify-install.ts",
    "apps/broker/src/shopify-webhooks.ts",
    "apps/broker/src/shopify.ts",
    "apps/broker/src/vault-database.ts",
    "packages/identity/src/shopify-link-issuer.ts",
    "packages/identity/src/workspace-store-linking-control.ts",
    "packages/identity/src/executor-role-preflight.ts",
    "packages/policy/src/connection-authority.ts",
    ...files.map((f) => "migrations/" + f),
  ].map((p) => [p, sha(readFileSync(p))]),
);

// Fixture ids. O has workspaces W (a website signup, founder F) and W2; P is another tenant.
// v1 PR 1: V is the owner's own organization and workspace (a website signup, founder L),
// which the app carrying the live-store mark invites.
const ids = {
  org: "org_shop",
  ws: "ws_shop",
  ws2: "ws_shop2",
  orgP: "org_other",
  wsP: "ws_other",
  orgL: "org_live",
  wsL: "ws_live",
  profile: "profile_shop",
};
const people = {
  F: {
    principal: "person_founder",
    membership: "membership_founder",
    workspaces: ["ws_shop", "ws_shop2"],
    org: "org_shop",
    connect: true,
  },
  A: {
    principal: "person_admin",
    membership: "membership_admin",
    workspaces: ["ws_shop"],
    org: "org_shop",
    connect: true,
  },
  M: {
    principal: "person_member",
    membership: "membership_member",
    workspaces: ["ws_shop"],
    org: "org_shop",
    connect: false,
  },
  Q: {
    principal: "person_other",
    membership: "membership_other",
    workspaces: ["ws_other"],
    org: "org_other",
    connect: true,
  },
  L: {
    principal: "person_live_owner",
    membership: "membership_live_owner",
    workspaces: ["ws_live"],
    org: "org_live",
    connect: true,
  },
};
const appKey = "lab-shop-1";
const clientId = randomBytes(16).toString("hex");
const appSecret = "shpss_" + randomBytes(16).toString("hex");
const shop = "lab-dev-store.myshopify.com";
const kek = randomBytes(32).toString("hex");
const installUrl = `https://admin.shopify.com/oauth/install_custom_app?client_id=${clientId}&no_redirect=true&signature=lab`;
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-shopify-lab",
  branchId: "br-shopify-lab",
  hostname: "ep-shopify-lab.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const brokerEnv = {
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "lab-vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
};
const connectGrant = (p, ws, id) => ({
  id,
  principal: {
    kind: "human",
    principalId: p.principal,
    organizationId: p.org,
    workspaceId: ws,
    membershipId: p.membership,
    installationId: null,
    mandateId: null,
  },
  capabilityId: "governance.connection.connect",
  verbs: ["administer", "approve"],
  scope: {
    organizationId: p.org,
    workspaceId: ws,
    storeIds: [],
    accountIds: [],
    resources: [
      {
        organizationId: p.org,
        workspaceId: ws,
        storeId: null,
        connectionId: null,
        kind: "workspace",
        id: ws,
      },
    ],
    fields: ["providerId", "installationProof", "scope"],
  },
  issuedBy: {
    kind: "service",
    principalId: "morrow.onboarding",
    organizationId: p.org,
    workspaceId: ws,
    membershipId: null,
    installationId: null,
    mandateId: null,
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
});

const report = await withWorkDatabase(
  "M2PR2.shopify-install",
  async (db) => {
    phase("fixtures");
    db.sql("ALTER ROLE morrow_identity_linking LOGIN;");
    const sessions = {};
    const statements = [
      `INSERT INTO morrow_identity.organizations VALUES(${literal(ids.org)},'Lab shop',true,1),(${literal(ids.orgP)},'Lab other',true,1),(${literal(ids.orgL)},'Lab live',true,1);`,
      `INSERT INTO morrow_identity.workspaces VALUES(${literal(ids.ws)},${literal(ids.org)},'Shop',true),(${literal(ids.ws2)},${literal(ids.org)},'Second',true),(${literal(ids.wsP)},${literal(ids.orgP)},'Other',true),(${literal(ids.wsL)},${literal(ids.orgL)},'Live',true);`,
      `INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES(${literal(ids.profile)},'workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');`,
    ];
    for (const [key, p] of Object.entries(people)) {
      const secret = randomBytes(32).toString("base64url");
      sessions[key] = sha(secret);
      statements.push(
        `INSERT INTO morrow_identity.principals VALUES(${literal(p.principal)},'human',true);`,
        `INSERT INTO morrow_identity.memberships VALUES(${literal(p.membership)},${literal(p.org)},${literal(p.principal)},true);`,
        `INSERT INTO morrow_identity.sessions VALUES(${literal("session_" + key)},${literal(p.principal)},${literal(p.org)},${literal(sessions[key])},'workos',${literal("provider_" + key)},clock_timestamp()+interval '1 day',NULL);`,
      );
      for (const ws of p.workspaces) {
        statements.push(
          `INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(p.org)},${literal(ws)},${literal(p.membership)},true);`,
        );
        if (p.connect) {
          const grant = connectGrant(p, ws, `grant_connect_${key}_${ws}`);
          statements.push(
            `INSERT INTO morrow_identity.grants VALUES(${literal(grant.id)},${literal(p.org)},${literal(ws)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(grant))}::jsonb);`,
          );
        }
      }
    }
    // The founder's website signup: 0021's trigger records W's unfixed website route.
    statements.push(
      `INSERT INTO morrow_identity.organization_signups VALUES(${literal(people.F.principal)},${literal(randomUUID())},${literal("b".repeat(64))},${literal(ids.profile)},${literal(ids.org)},${literal(ids.ws)},${literal(people.F.membership)},'owner-bootstrap-v1',clock_timestamp());`,
      // v1 PR 1: the owner's own website signup (V cases).
      `INSERT INTO morrow_identity.organization_signups VALUES(${literal(people.L.principal)},${literal(randomUUID())},${literal("c".repeat(64))},${literal(ids.profile)},${literal(ids.orgL)},${literal(ids.wsL)},${literal(people.L.membership)},'owner-bootstrap-v1',clock_timestamp());`,
    );
    db.admin(statements.join("\n"));
    const routeOf = () =>
      db.rows(
        `SELECT route,mode,revision::int FROM morrow_billing.workspace_billing_routes WHERE workspace_id=${literal(ids.ws)}`,
      )[0];
    const linkRoute = (org, ws) =>
      db
        .sql(
          `SET ROLE morrow_identity_owner; SELECT morrow_billing.link_route_current(${literal(org)},${literal(ws)});`,
        )
        .split("\n")
        .at(-1);
    const fixRoute = () =>
      db.workOwner(
        `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=date_trunc('milliseconds',clock_timestamp()),fixing_payment_key='stripe:invoice:in_lab00000001',revision=2,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE workspace_id=${literal(ids.ws)};`,
      );

    // -------------------------------------------------------------------------
    // R: the route read (0025).
    phase("route_read");
    check(
      "R1:route_read_answers_unfixed_missing_invalid",
      routeOf()?.route === null &&
        linkRoute(ids.org, ids.ws) === "unfixed" &&
        linkRoute(ids.org, ids.ws2) === "missing" &&
        linkRoute("bad id", ids.ws) === "invalid",
    );
    const routeAcl = db.tryRun(
      "SET ROLE morrow_identity_linking; SELECT morrow_billing.link_route_current('org_shop','ws_shop');",
    );
    const routeRead = db.tryRun(
      "SET ROLE morrow_work_command; SELECT count(*) FROM morrow_billing.workspace_billing_routes;",
    );
    check(
      "R2:only_the_identity_owner_executes_it_and_the_setting_is_cleared",
      !routeAcl.ok &&
        routeRead.ok &&
        routeRead.stdout.split("\n").at(-1) === "0" &&
        db
          .sql(
            "SET ROLE morrow_identity_owner; SELECT morrow_billing.link_route_current('org_shop','ws_shop'); SELECT 'cleared:'||COALESCE(current_setting('morrow.billing_route_read',true),'');",
          )
          .split("\n")
          .at(-1) === "cleared:",
    );

    // -------------------------------------------------------------------------
    // A: the registry and the app secret.
    phase("registry");
    const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
    const envelope = await sealVaultRecord(
      keyring,
      { kind: "app_secret", appKey, provider: "shopify", version: 1 },
      new TextEncoder().encode(appSecret),
    );
    const stored = db.rows(
      `SELECT outcome,version FROM morrow_vault.app_secret_put(${literal(appKey)},'1',${literal(vaultBytesHex(envelope.wrappedKey))},${literal(vaultBytesHex(envelope.sealedValue))})`,
      { role: "morrow_work_owner" },
    )[0];
    const register = (key, client, digest, ws, url = installUrl) =>
      db.rows(
        `SELECT outcome FROM morrow_identity.shopify_app_register(${literal(key)},${literal(client)},'development',${literal(digest)},${literal(ids.org)},${literal(ws)},${literal(url)})`,
        { role: "morrow_identity_owner" },
      )[0]?.outcome;
    check(
      "A1:app_registered_once_and_its_secret_stored",
      stored?.outcome === "stored" &&
        register(appKey, clientId, sha(shop), ids.ws) === "registered" &&
        register(appKey, clientId, sha(shop), ids.ws) === "exists" &&
        register("lab-shop-2", randomBytes(16).toString("hex"), sha(shop), ids.ws) === "exists" &&
        register(
          "lab-shop-3",
          randomBytes(16).toString("hex"),
          sha("x.myshopify.com"),
          ids.ws,
          "http://evil.test/",
        ) === "invalid" &&
        register("lab-shop-4", "NOTHEX", sha("y.myshopify.com"), ids.ws) === "invalid",
    );
    const registerAsOther = db.tryRun(
      `SET ROLE morrow_work_command; SELECT * FROM morrow_identity.shopify_app_register('lab-shop-9','${"a".repeat(32)}','development','${"b".repeat(64)}','org_shop','ws_shop','${installUrl}');`,
    );
    check("A2:registration_is_granted_to_nobody", !registerAsOther.ok);
    // The install link names the shop (store content): retirement clears it, and the guard
    // admits no change that restores it (M2 PR-2 review).
    const throwaway = register(
      "lab-shop-r",
      randomBytes(16).toString("hex"),
      sha("lab-retired.myshopify.com"),
      ids.ws,
    );
    const retiredOutcome = db.rows(
      `SELECT outcome FROM morrow_identity.shopify_app_retire('lab-shop-r')`,
      {
        role: "morrow_identity_owner",
      },
    )[0]?.outcome;
    const retiredRow = db.rows(
      `SELECT status,install_url IS NULL AS cleared,revision::int FROM morrow_identity.shopify_apps WHERE app_key='lab-shop-r'`,
      { role: "morrow_identity_owner" },
    )[0];
    const restoreLink = db.tryRun(
      `SET ROLE morrow_identity_owner; UPDATE morrow_identity.shopify_apps SET install_url=${literal(installUrl)},revision=revision+1 WHERE app_key='lab-shop-r';`,
    );
    check(
      "A3:retirement_clears_the_install_link_and_nothing_restores_it",
      throwaway === "registered" &&
        retiredOutcome === "retired" &&
        retiredRow?.status === "retired" &&
        retiredRow.cleared === true &&
        retiredRow.revision === 2 &&
        !restoreLink.ok,
      { throwaway, retiredOutcome, retiredRow },
    );

    // -------------------------------------------------------------------------
    // C: the connector login's OAuth state (connector_oauth_state_open).
    phase("connector_state");
    const asConnector = (sql) => db.tryRun(sql, { user: "morrow_connector_ingress" });
    const stateOpen = (key, domain, digest) => {
      const r = asConnector(
        `SELECT outcome||'|'||COALESCE(client_id,'')||'|'||COALESCE(scopes,'') FROM morrow_identity.connector_oauth_state_open(${literal(key)},${literal(domain)},${literal(digest)});`,
      );
      return r.ok ? r.stdout.split("\n").at(-1) : "error";
    };
    const opened = stateOpen(appKey, shop, sha("s1"));
    check(
      "C1:state_opens_for_the_registered_shop_only",
      opened === `opened|${clientId}|read_products,write_products` &&
        stateOpen("unknown-app", shop, sha("s2")).startsWith("not_found") &&
        stateOpen(appKey, "other.myshopify.com", sha("s3")).startsWith("not_found") &&
        stateOpen(appKey, shop, "nothex").startsWith("invalid") &&
        db.rows(`SELECT count(*)::int AS n FROM morrow_identity.shopify_oauth_states`, {
          role: "morrow_identity_owner",
        })[0].n === 1,
    );
    for (let i = 0; i < 9; i++) stateOpen(appKey, shop, sha("cap" + i));
    check(
      "C2:at_most_ten_open_states_per_app",
      stateOpen(appKey, shop, sha("cap-over")) === "limited||",
    );
    // Superuser sim: the cap is per open state; claimed states free it.
    db.admin(
      `UPDATE morrow_identity.shopify_oauth_states SET claimed_at=date_trunc('milliseconds',clock_timestamp()) WHERE claimed_at IS NULL AND state_digest LIKE '%';`,
    );
    const otherLogins = ["morrow_vault_broker", "morrow_api_worker", "morrow_runtime_executor"].map(
      (user) =>
        db.tryRun(
          `SELECT * FROM morrow_identity.connector_oauth_state_open('${appKey}','${shop}','${"c".repeat(64)}');`,
          { user },
        ).ok,
    );
    const connectorReads = [
      "SELECT count(*) FROM morrow_identity.shopify_apps",
      "SELECT count(*) FROM morrow_identity.store_installations",
      "SELECT count(*) FROM morrow_identity.shopify_oauth_states",
      "SELECT count(*) FROM morrow_vault.credentials",
    ].map((q) => asConnector(q + ";").ok);
    check(
      "C3:only_the_connector_login_opens_states_and_it_reads_no_table",
      otherLogins.every((ok) => !ok) && connectorReads.every((ok) => !ok),
    );
    // The connector's TypeScript transport (database.ts) over a psql bridge.
    const connectorDriver = (config) => {
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
    const leaseBroker = {
      neonLease: async () =>
        JSON.stringify({ schemaVersion: 1, password: "lab-" + randomBytes(12).toString("hex") }),
    };
    const connectorDatabase = createConnectorDatabase(
      binding,
      leaseBroker,
      connectorDriver,
      Date.now,
      class {
        constructor() {}
        close() {}
      },
    );
    const viaTs = await connectorDatabase.stateOpen(appKey, shop, sha("ts-state"), 10000);
    check(
      "C4:connector_transport_opens_a_state_as_its_own_login",
      viaTs.outcome === "opened" && viaTs.clientId === clientId,
    );

    // -------------------------------------------------------------------------
    // I: the broker's install over the vault login.
    phase("install");
    const oracle = createShopifyOracle({ secret: appSecret, clientId, shop, shopId: "424242" });
    const vaultDriver = (config) => {
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
    // Loaded hosts: each transaction's budget is stretched (the transport caps it at 10 s).
    const broker = createShopifyBroker({
      transaction: (vault, budgetMs, body) =>
        runVaultTransactionWithDriver(
          vaultDriver,
          vault,
          Math.min(10000, budgetMs * 3),
          body,
          Date.now,
          class {
            close() {}
          },
        ),
      fetch: (url, init) => oracle.fetch(url, init),
      now: () => Date.now(),
    });
    check(
      "I0:the_broker_vault_capability_is_held_with_the_lab_secrets",
      (await brokerCapabilities(brokerEnv)).vault !== null,
    );
    const launch = decodeShopifyLaunchVerdict(
      await broker.launchVerify(brokerEnv, appKey, oracle.launchQuery()),
    );
    check(
      "I1:launch_verifies_the_registered_shop_and_names_the_invited_workspace",
      launch.verdict === "verified" &&
        launch.installation === "none" &&
        launch.workspaceId === ids.ws,
    );
    const install = async (overrides = {}) => {
      const state = randomBytes(32).toString("base64url");
      const opened = stateOpen(appKey, shop, sha(state));
      const query = oracle.callbackQuery(state, overrides.query ?? {});
      const result = decodeShopifyInstallResult(
        await broker.installComplete(brokerEnv, appKey, query, sha(state), 10000),
      );
      return { state, opened, query, result };
    };
    // The owner role sees identity rows; the work owner the vault rows.
    const identityCounts = () =>
      db.rows(
        `SELECT (SELECT count(*) FROM morrow_identity.store_installations)::int AS installations,(SELECT count(*) FROM morrow_identity.linking_candidates)::int AS candidates,(SELECT count(*) FROM morrow_identity.install_continuations)::int AS continuations`,
        { role: "morrow_identity_owner" },
      )[0];
    const vaultRows = () =>
      db.rows(
        `SELECT version::int,status,subject_id,wrapped_key IS NULL AS erased,destroy_reason FROM morrow_vault.credentials ORDER BY version`,
        { role: "morrow_work_owner" },
      );
    // A non-development store stores nothing (ADR-0022 item 4).
    oracle.state.development = false;
    const notDev = await install();
    oracle.state.development = true;
    check(
      "I2:a_non_development_store_stores_nothing",
      notDev.result.outcome === "store_not_development" &&
        identityCounts().installations === 0 &&
        vaultRows().length === 0,
    );
    oracle.state.scope = "write_products,read_orders";
    const extra = await install();
    oracle.state.scope = "write_products";
    check(
      "I3:an_extra_scope_stores_nothing",
      extra.result.outcome === "scopes_mismatch" &&
        identityCounts().installations === 0 &&
        vaultRows().length === 0,
    );
    const first = await install();
    const installation = db.rows(
      `SELECT id::text,store_id::text,connection_id::text,status,granted_scopes::text AS scopes,credential_version::int AS version,development_store,organization_id::text AS org,workspace_id::text AS ws,shop_id FROM morrow_identity.store_installations`,
      { role: "morrow_identity_owner" },
    )[0];
    const candidate = db.rows(
      `SELECT proof_kind,eligible_principal_id::text AS eligible,proof_revision::int AS revision,installation_id::text AS installation,application_id::text AS application FROM morrow_identity.linking_candidates`,
      { role: "morrow_identity_owner" },
    )[0];
    const continuations = () =>
      db.rows(
        `SELECT token_digest,consumed_at IS NOT NULL AS consumed,superseded_at IS NOT NULL AS superseded FROM morrow_identity.install_continuations ORDER BY created_at,id`,
        { role: "morrow_identity_owner" },
      );
    check(
      "I4:first_install_writes_installation_candidate_continuation_and_credential_v1",
      first.result.outcome === "installed" &&
        first.result.workspaceId === ids.ws &&
        installation?.status === "unlinked" &&
        installation.org === ids.org &&
        installation.ws === ids.ws &&
        installation.shop_id === "424242" &&
        installation.scopes === "{read_products,write_products}" &&
        installation.development_store === true &&
        candidate?.proof_kind === "shopify_oauth" &&
        candidate.eligible === people.F.principal &&
        candidate.installation === installation.id &&
        candidate.application === clientId &&
        continuations().length === 1 &&
        continuations()[0].token_digest === sha(first.result.continuationToken) &&
        JSON.stringify(vaultRows()) ===
          JSON.stringify([
            {
              version: 1,
              status: "active",
              subject_id: installation.id,
              erased: false,
              destroy_reason: null,
            },
          ]),
      { first: first.result.outcome, installation, candidate },
    );
    const replay = decodeShopifyInstallResult(
      await broker.installComplete(brokerEnv, appKey, first.query, sha(first.state), 10000),
    );
    check(
      "I5:a_replayed_callback_is_refused_before_any_exchange",
      replay.outcome === "state_invalid" &&
        oracle.state.calls.filter((c) => c.path.endsWith("access_token")).length === 3,
    );
    // An expired state (sim: inserted already past its window).
    const expiredState = randomBytes(32).toString("base64url");
    db.admin(
      `INSERT INTO morrow_identity.shopify_oauth_states SELECT ${literal(randomUUID())},${literal(appKey)},${literal(sha(shop))},${literal(sha(expiredState))},t,t+interval '10 minutes',NULL,NULL FROM (SELECT date_trunc('milliseconds',clock_timestamp())-interval '11 minutes' AS t) x;`,
    );
    const expired = decodeShopifyInstallResult(
      await broker.installComplete(
        brokerEnv,
        appKey,
        oracle.callbackQuery(expiredState),
        sha(expiredState),
        10000,
      ),
    );
    check("I6:an_expired_state_is_refused", expired.outcome === "state_invalid");
    const second = await install();
    check(
      "I7:a_relaunch_reauthorises_one_installation_with_credential_v2_and_v1_erased",
      second.result.outcome === "reauthorised" &&
        second.result.continuationToken !== null &&
        identityCounts().installations === 1 &&
        JSON.stringify(vaultRows()) ===
          JSON.stringify([
            {
              version: 1,
              status: "destroyed",
              subject_id: installation.id,
              erased: true,
              destroy_reason: "reauthorised",
            },
            {
              version: 2,
              status: "active",
              subject_id: installation.id,
              erased: false,
              destroy_reason: null,
            },
          ]) &&
        JSON.stringify(continuations().map((c) => c.superseded)) === "[true,false]",
    );
    const vaultRead = [
      "morrow_connector_ingress",
      "morrow_identity_linking",
      "morrow_api_worker",
    ].map(
      (user) =>
        db.tryRun(
          "SELECT count(*) FROM morrow_vault.credentials; SELECT count(*) FROM morrow_identity.store_installations;",
          { user },
        ).ok,
    );
    check(
      "I8:no_other_login_reads_vault_or_installation_rows",
      vaultRead.every((ok) => !ok),
    );
    // One shop, one installation that is not uninstalled, under any app (M2 PR-2 review).
    // Sim, in one transaction that is rolled back: the lab app is retired by hand, so a
    // second app for the same shop could otherwise be registered and installed.
    const appB = "lab-shop-b";
    const clientB = randomBytes(16).toString("hex");
    const stateB = sha("state-b");
    const ineligibleUuid = () => literal(randomUUID());
    const shopUniqueness = db
      .tryRun(
        `BEGIN;
CREATE FUNCTION pg_temp.second_live_installation() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE t timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 INSERT INTO morrow_identity.store_installations(organization_id,workspace_id,id,app_key,shop_id,shop_domain,store_id,connection_id,
  generation,status,granted_scopes,credential_id,credential_version,development_store,link_id,revision,created_at,updated_at,reauthorised_at,linked_at)
 VALUES (${literal(ids.org)},${literal(ids.ws2)},${ineligibleUuid()},${literal(appB)},'424242',${literal(shop)},${ineligibleUuid()},${ineligibleUuid()},1,'unlinked',
  ARRAY['read_products','write_products'],${ineligibleUuid()},1,true,NULL,1,t,t,NULL,NULL);
 RETURN 'inserted';
EXCEPTION WHEN unique_violation THEN RETURN 'unique_violation';
END $f$;
SET LOCAL ROLE morrow_identity_owner;
ALTER TABLE morrow_identity.shopify_apps DISABLE TRIGGER shopify_record_guard;
UPDATE morrow_identity.shopify_apps SET status='retired',retired_at=date_trunc('milliseconds',clock_timestamp()) WHERE app_key=${literal(appKey)};
SELECT 'register:'||outcome FROM morrow_identity.shopify_app_register(${literal(appB)},${literal(clientB)},'development',${literal(sha(shop))},${literal(ids.org)},${literal(ids.ws2)},${literal(installUrl)});
INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at)
 VALUES(${literal(appB)},${literal(clientB)},'development',${literal(sha(shop))},${literal(ids.org)},${literal(ids.ws2)},'read_products,write_products','2026-10',${literal(installUrl)},'active',1,date_trunc('milliseconds',clock_timestamp()),NULL);
ALTER TABLE morrow_identity.shopify_oauth_states DISABLE TRIGGER shopify_record_guard;
INSERT INTO morrow_identity.shopify_oauth_states SELECT ${literal(randomUUID())},${literal(appB)},${literal(sha(shop))},${literal(stateB)},t,t+interval '10 minutes',t,NULL
 FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS t) x;
SELECT 'index:'||pg_temp.second_live_installation();
SET LOCAL ROLE morrow_work_command;
SELECT 'prepare:'||outcome FROM morrow_identity.work_shopify_install_prepare(${literal(appB)},${literal(stateB)},'424242',${literal(shop)});
SELECT 'record:'||outcome FROM morrow_identity.work_shopify_install_record(${literal(appB)},${literal(stateB)},'424242',${literal(shop)},'read_products,write_products','true',${ineligibleUuid()},${ineligibleUuid()},${ineligibleUuid()},${ineligibleUuid()},'1',${literal(sha("continuation-b"))});
ROLLBACK;`,
      )
      .stdout.split("\n")
      .filter((line) => /^(register|index|prepare|record):/.test(line));
    check(
      "I9:one_shop_has_one_live_installation_under_any_app",
      JSON.stringify(shopUniqueness) ===
        JSON.stringify([
          "register:exists",
          "index:unique_violation",
          "prepare:ineligible",
          "record:ineligible",
        ]) &&
        db.rows(
          `SELECT status FROM morrow_identity.shopify_apps WHERE app_key=${literal(appKey)}`,
          { role: "morrow_identity_owner" },
        )[0]?.status === "active" &&
        identityCounts().installations === 1,
      shopUniqueness,
    );

    // -------------------------------------------------------------------------
    // L: the issuer, lookup and apply as the linking login.
    phase("link");
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
    const context = (who, ws, token, command = randomUUID()) => {
      const abort = new AbortController();
      return Object.freeze({
        workspaceId: ws,
        sessionDigest: sessions[who],
        commandId: command,
        nonceDigest: token === null ? null : sha(token),
        csrfToken: null,
        control: Object.freeze({ deadlineMs: Date.now() + 60000, signal: abort.signal }),
        check: () => Date.now(),
        wait: (p) => p,
      });
    };
    const service = createControlledWorkspaceStoreLinking({ pool: linkingPool, now: Date.now });
    const preview = async (who, ws, token, command) => {
      const ctx = context(who, ws, token, command);
      const issued = await runShopifyLinkIssuer(linkingPool, Date.now, kernel, ctx);
      if (issued !== "proceed") return { status: issued.status, body: await issued.json(), ctx };
      const input = await service.lookup(
        JSON.stringify({
          sessionDigest: ctx.sessionDigest,
          workspaceId: ws,
          nonceDigest: ctx.nonceDigest,
          commandId: ctx.commandId,
        }),
        ctx.control,
      );
      return { status: input ? 200 : 404, input, ctx };
    };
    const issueSql = (who, ws, token, grant, command = randomUUID()) =>
      db
        .tryRun(
          `SELECT morrow_identity.issue_shopify_link_handoff(${literal(sessions[who])},${literal(ws)},${literal(sha(token))},${literal(command)},${literal(grant)});`,
          { user: "morrow_identity_linking" },
        )
        .stdout.split("\n")
        .at(-1);
    const connectionsOf = async (who, ws) => {
      const response = await executeWorkspaceConnections(
        linkingPool,
        Date.now,
        kernel,
        context(who, ws, null),
      );
      return { status: response.status, body: await response.json() };
    };
    const token = second.result.continuationToken;
    // Unpaid: the route is unfixed, so the issuer refuses after session and grant pass.
    const unpaid = await preview("F", ids.ws, token);
    check(
      "L1:an_unpaid_workspace_gets_billing_route_required",
      unpaid.status === 409 &&
        unpaid.body.code === "billing_route_required" &&
        continuations()[1].consumed === false,
    );
    fixRoute();
    check("L2:route_fixed_morrow_direct", linkRoute(ids.org, ids.ws) === "morrow_direct");
    // ADR-0022 item 3: the store-link template goes to the linking owner, so only the
    // organization's owner (its founding principal) is offered the link; a connect holder
    // who is not the owner is not (M2 PR-2 review).
    const ownerOffer = await connectionsOf("F", ids.ws);
    const adminOffer = await connectionsOf("A", ids.ws);
    check(
      "K4:only_the_owner_is_offered_the_install_link",
      ownerOffer.body.installLink?.reason === "offered" &&
        adminOffer.status === 200 &&
        adminOffer.body.installLink?.reason === "not_permitted",
      { owner: ownerOffer.body.installLink, admin: adminOffer.body.installLink },
    );
    const wrongWorkspace = await preview("F", ids.ws2, token);
    const memberOnly = await preview("M", ids.ws, token);
    const foreign = await preview("Q", ids.wsP, token);
    check(
      "L3:wrong_workspace_missing_grant_and_foreign_tenant_get_nothing",
      wrongWorkspace.status === 404 &&
        memberOnly.status === 404 &&
        foreign.status === 404 &&
        continuations()[1].consumed === false,
    );
    check(
      "L4:sql_recheck_refuses_a_grant_that_is_not_the_actors_connect_grant",
      issueSql("A", ids.ws, token, "grant_connect_F_ws_shop") === "denied" &&
        issueSql("M", ids.ws, token, "grant_connect_F_ws_shop") === "denied" &&
        issueSql("F", ids.ws, "not-the-token", "grant_connect_F_ws_shop") === "not_found",
    );
    // The admin holds its own current connect/administer grant but is not the owner: the
    // kernel allows it, the SQL recheck refuses it, and the continuation stays open.
    const notOwner = await preview("A", ids.ws, token);
    check(
      "L14:a_connect_holder_who_is_not_the_owner_gets_no_handoff",
      notOwner.status === 404 &&
        issueSql("A", ids.ws, token, "grant_connect_A_ws_shop") === "denied" &&
        continuations()[1].consumed === false,
    );
    // The owner issues: the proof is rebound to the owner.
    const issued = await preview("F", ids.ws, token);
    const rebound = db.rows(
      `SELECT eligible_principal_id::text AS eligible,proof_revision::int AS revision FROM morrow_identity.linking_candidates`,
      { role: "morrow_identity_owner" },
    )[0];
    check(
      "L5:the_owner_issues_one_handoff_and_the_continuation_is_consumed",
      issued.status === 200 &&
        issued.input.purpose === "workspace_first" &&
        issued.input.installationId === installation.id &&
        rebound.eligible === people.F.principal &&
        rebound.revision === 3 &&
        continuations()[1].consumed === true,
      { status: issued.status, rebound },
    );
    const again = await preview("F", ids.ws, token, issued.ctx.commandId);
    const replayOther = await preview("F", ids.ws, token);
    const otherSession = await preview("A", ids.ws, token);
    check(
      "L6:same_command_replays_exists_another_command_or_session_is_refused",
      again.status === 200 && replayOther.status === 404 && otherSession.status === 404,
    );
    // A relaunch while the handoff is open: a new continuation and proof revision, so the
    // open handoff can never apply (two handoffs racing on one candidate link at most once).
    const third = await install();
    const staleApply = await service.apply(JSON.stringify(issued.input), issued.ctx.control);
    check(
      "L7:a_relaunch_invalidates_the_open_handoff",
      third.result.outcome === "reauthorised" &&
        staleApply.outcome === "denied" &&
        db.rows(
          `SELECT reason FROM morrow_identity.workspace_link_results ORDER BY recorded_at DESC LIMIT 1`,
          { role: "morrow_identity_owner" },
        )[0]?.reason === "proof_invalid",
    );
    // An expired continuation (sim: moved past its window) is refused.
    const fourth = await install();
    db.admin(
      `ALTER TABLE morrow_identity.install_continuations DISABLE TRIGGER shopify_record_guard; UPDATE morrow_identity.install_continuations SET created_at=created_at-interval '6 minutes',expires_at=expires_at-interval '6 minutes' WHERE token_digest=${literal(sha(fourth.result.continuationToken))}; ALTER TABLE morrow_identity.install_continuations ENABLE TRIGGER shopify_record_guard;`,
    );
    check(
      "L8:an_expired_continuation_is_refused",
      (await preview("F", ids.ws, fourth.result.continuationToken)).status === 404,
    );
    const fifth = await install();
    // Two commands of the owner and the admin race to issue from one continuation: one
    // handoff at most, and never the admin's.
    const raced = await Promise.all([
      preview("F", ids.ws, fifth.result.continuationToken),
      preview("F", ids.ws, fifth.result.continuationToken),
      preview("A", ids.ws, fifth.result.continuationToken),
    ]);
    const winners = raced.filter((r) => r.status === 200);
    check(
      "L9:issuers_racing_on_one_continuation_issue_one_handoff",
      winners.length === 1 && raced[2].status === 404,
      raced.map((r) => r.status),
    );
    // The app is retired after the handoff was issued (sim: by hand, then restored): the
    // apply refuses with installation_ineligible and issues nothing (M2 PR-2 review).
    const lastReason = () =>
      db.rows(
        `SELECT reason FROM morrow_identity.workspace_link_results ORDER BY recorded_at DESC LIMIT 1`,
        { role: "morrow_identity_owner" },
      )[0]?.reason;
    const setAppStatus = (active) =>
      db.admin(
        `ALTER TABLE morrow_identity.shopify_apps DISABLE TRIGGER shopify_record_guard; UPDATE morrow_identity.shopify_apps SET status=${active ? "'active'" : "'retired'"},retired_at=${active ? "NULL" : "date_trunc('milliseconds',clock_timestamp())"} WHERE app_key=${literal(appKey)}; ALTER TABLE morrow_identity.shopify_apps ENABLE TRIGGER shopify_record_guard;`,
      );
    setAppStatus(false);
    const retiredApply = await service.apply(
      JSON.stringify(winners[0].input),
      winners[0].ctx.control,
    );
    setAppStatus(true);
    check(
      "L15:a_link_after_the_app_was_retired_is_refused",
      retiredApply.outcome === "denied" &&
        lastReason() === "installation_ineligible" &&
        db.rows(
          `SELECT count(*)::int AS n FROM morrow_identity.grants WHERE payload->'issuedBy'->>'principalId'='morrow.linking'`,
          { role: "morrow_identity_owner" },
        )[0].n === 0,
    );
    // A fresh continuation for the owner's link.
    const linkInstall = await install();
    const winner = await preview("F", ids.ws, linkInstall.result.continuationToken);
    const applied = await service.apply(JSON.stringify(winner.input), winner.ctx.control);
    const linked = db.rows(
      `SELECT status,link_id IS NOT NULL AS has_link,linked_at IS NOT NULL AS has_time,revision::int FROM morrow_identity.store_installations`,
      { role: "morrow_identity_owner" },
    )[0];
    const linkGrants = db
      .rows(
        `SELECT payload FROM morrow_identity.grants WHERE payload->'issuedBy'->>'principalId'='morrow.linking' ORDER BY payload->>'capabilityId'`,
        { role: "morrow_identity_owner" },
      )
      .map((r) => r.payload);
    const owner = people.F;
    const resource = storeResource(
      ids.org,
      ids.ws,
      installation.store_id,
      installation.connection_id,
    );
    check(
      "L10:the_link_applies_marks_the_installation_and_issues_exactly_the_store_link_grants",
      applied.outcome === "applied" &&
        linked.status === "linked" &&
        linked.has_link &&
        linked.has_time &&
        // Store-link template v2: five rows ("Disconnect store", the ADR-0022 item 3
        // amendment of 2026-10-22).
        linkGrants.length === storeLinkGrantTemplate.length &&
        storeLinkGrantTemplate.length === 5 &&
        linkGrants.every(
          (g) =>
            validateCurrentDefinition("Grant", g) &&
            g.principal.principalId === owner.principal &&
            g.principal.membershipId === owner.membership &&
            // jsonb reorders object keys: compare canonical JSON.
            canonicalize(g.scope.resources) === canonicalize([resource]) &&
            canonicalize(g.scope.storeIds) === canonicalize([installation.store_id]) &&
            g.expiresAt === null &&
            g.issuedBy.kind === "service",
        ) &&
        canonicalize(linkGrants.map((g) => [g.capabilityId, g.verbs, g.scope.fields]).sort()) ===
          canonicalize(
            storeLinkGrantTemplate.map((r) => [r.capabilityId, [...r.verbs], [...r.fields]]).sort(),
          ),
      {
        applied,
        linked,
        grants: linkGrants.length,
        valid: linkGrants.map((g) => validateCurrentDefinition("Grant", g)),
      },
    );
    // The owner's kernel now allows a listing proposal on exactly that store.
    const authority = await service.authority(
      JSON.stringify({ sessionDigest: sessions.F, workspaceId: ids.ws }),
      winner.ctx.control,
    );
    const actor = {
      kind: "human",
      principalId: owner.principal,
      organizationId: ids.org,
      workspaceId: ids.ws,
      membershipId: owner.membership,
      installationId: null,
      mandateId: null,
    };
    const decision = await createHumanPolicyService({
      readCurrent: async () => ({
        actor,
        policyRevision: authority.policyRevision,
        grantsRevision: authority.policyRevision,
        principalActive: true,
        organizationActive: true,
        workspaceActive: true,
        membershipActive: true,
        sessionCurrent: true,
        resource,
        accountId: null,
        providerAllowed: true,
        entitlementAllowed: false,
        grants: authority.grants,
      }),
    }).decide({
      capabilityId: "catalog.content.propose",
      verb: "execute",
      resource,
      accountId: null,
      fields: ["title", "tags"],
    });
    check(
      "L11:the_linked_owner_kernel_allows_a_listing_draft_on_that_store",
      decision.decision.allowed === true,
    );
    const sixth = await install();
    check(
      "L12:a_linked_installation_reauthorises_without_a_continuation_or_new_grants",
      sixth.result.outcome === "reauthorised" &&
        sixth.result.continuationToken === null &&
        db.rows(
          `SELECT count(*)::int AS n FROM morrow_identity.grants WHERE payload->'issuedBy'->>'principalId'='morrow.linking'`,
          { role: "morrow_identity_owner" },
        )[0].n === storeLinkGrantTemplate.length,
    );
    // The workspace's shared read bridge: ids and states only.
    const bridge = db.rows(
      `SELECT * FROM morrow_identity.work_store_installations(${literal(ids.org)},${literal(ids.ws)})`,
      { role: "morrow_work_command" },
    );
    check(
      "L13:work_store_installations_returns_ids_and_the_linked_state_only",
      bridge.length === 1 &&
        Object.keys(bridge[0]).sort().join(",") ===
          "connection_id,installation_id,linked_at,status,store_id" &&
        bridge[0].status === "linked" &&
        bridge[0].store_id === installation.store_id,
    );

    // The apply rechecks the owner too: a shopify_oauth handoff for the admin (sim: written
    // by hand, since the issuer never writes one) is refused as actor_ineligible although
    // the admin's membership, session and grant are current.
    const shopifyCandidate = db.rows(
      `SELECT id::text,generation::int,proof_id::text,proof_revision::int,proof_digest,ownership_revision::int FROM morrow_identity.linking_candidates WHERE proof_kind='shopify_oauth'`,
      { role: "morrow_identity_owner" },
    )[0];
    {
      const suffix = randomUUID().replaceAll("-", "");
      const nonce = sha(randomBytes(8).toString("hex"));
      const command = randomUUID();
      const digest = sha("admin-handoff-" + suffix);
      const grantA = db.rows(
        `SELECT payload FROM morrow_identity.grants WHERE id='grant_connect_A_ws_shop'`,
        { role: "morrow_identity_owner" },
      )[0].payload;
      const scope = {
        organizationId: ids.org,
        workspaceId: ids.ws,
        storeIds: [],
        accountIds: [],
        resources: grantA.scope.resources,
        fields: ["installationProof", "providerId", "scope"],
      };
      const policy = db.rows(
        `SELECT policy_revision::text AS r FROM morrow_identity.organizations WHERE id=${literal(ids.org)}`,
        { role: "morrow_identity_owner" },
      )[0].r;
      const c = shopifyCandidate;
      const common = `${literal(ids.org)},${literal(ids.ws)},${literal(people.A.principal)},${literal(people.A.membership)},${literal(sessions.A)},${literal(nonce)}`;
      db.admin(`INSERT INTO morrow_identity.linking_reviews(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,handoff_id,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,scope_snapshot,evidence_kind,created_at,expires_at)
VALUES(${literal("rev_" + suffix)},${common},${literal("hand_" + suffix)},${literal(c.id)},${literal(installation.id)},${c.generation},${literal(command)},${literal(digest)},'workspace_first',${policy},${c.ownership_revision},${literal(c.proof_id)},${c.proof_revision},${literal(c.proof_digest)},${literal(JSON.stringify(scope))}::jsonb,'shopify_oauth',clock_timestamp(),clock_timestamp()+interval '200 seconds');
INSERT INTO morrow_identity.linking_handoffs(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,review_id,authorizing_grant_id,authorizing_grant_snapshot,requested_scope_snapshot,created_at,expires_at)
VALUES(${literal("hand_" + suffix)},${common},${literal(c.id)},${literal(installation.id)},${c.generation},${literal(command)},${literal(digest)},'workspace_first',${policy},${c.ownership_revision},${literal(c.proof_id)},${c.proof_revision},${literal(c.proof_digest)},${literal("rev_" + suffix)},'grant_connect_A_ws_shop',${literal(JSON.stringify(grantA))}::jsonb,${literal(JSON.stringify(scope))}::jsonb,clock_timestamp(),clock_timestamp()+interval '200 seconds');`);
      const outcome = db.rows(
        `SELECT outcome FROM morrow_identity.link_workspace_store(${literal("hand_" + suffix)},${literal(command)},${literal(digest)},${literal(sessions.A)},${literal(nonce)},${literal(ids.org)},${literal(ids.ws)},${literal(installation.id)},'workspace_first',${literal(policy)},${literal(String(c.ownership_revision))})`,
        { user: "morrow_identity_linking" },
      )[0]?.outcome;
      check(
        "L16:the_apply_refuses_a_shopify_handoff_for_a_non_owner",
        outcome === "denied" &&
          lastReason() === "actor_ineligible" &&
          db.rows(
            `SELECT count(*)::int AS n FROM morrow_identity.grants WHERE payload->'issuedBy'->>'principalId'='morrow.linking' AND principal_id=${literal(people.A.principal)}`,
            { role: "morrow_identity_owner" },
          )[0].n === 0,
        { outcome, reason: lastReason() },
      );
    }

    // -------------------------------------------------------------------------
    // P: the P05.T03a controlled-fixture path under the new route rule (sim fixtures).
    phase("controlled_fixture");
    const fixtureLink = (ws, who) => {
      const p = people[who];
      const suffix = randomUUID().replaceAll("-", "");
      const nonce = sha(randomBytes(8).toString("hex"));
      const command = randomUUID();
      const grant = db.rows(
        `SELECT payload FROM morrow_identity.grants WHERE id=${literal(`grant_connect_${who}_${ws}`)}`,
        { role: "morrow_identity_owner" },
      )[0].payload;
      const scope = {
        organizationId: p.org,
        workspaceId: ws,
        storeIds: [],
        accountIds: [],
        resources: grant.scope.resources,
        fields: grant.scope.fields,
      };
      const digest = sha(canonicalize({ suffix }));
      db.admin(`INSERT INTO morrow_identity.linking_candidates VALUES(${literal("cand_" + suffix)},'shopify','synthetic_app','synthetic_env',${literal("shop_" + suffix)},${literal("synthetic-" + suffix + ".myshopify.com")},${literal("inst_" + suffix)},1,true,1,'controlled_fixture',${literal("proof_" + suffix)},1,${literal(digest)},${literal(p.principal)},clock_timestamp()-interval '1 second',clock_timestamp()+interval '200 seconds',NULL);
INSERT INTO morrow_identity.linking_reviews(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,handoff_id,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,scope_snapshot,evidence_kind,created_at,expires_at)
VALUES(${literal("rev_" + suffix)},${literal(p.org)},${literal(ws)},${literal(p.principal)},${literal(p.membership)},${literal(sessions[who])},${literal(nonce)},${literal("hand_" + suffix)},${literal("cand_" + suffix)},${literal("inst_" + suffix)},1,${literal(command)},${literal(digest)},'workspace_first',(SELECT policy_revision FROM morrow_identity.organizations WHERE id=${literal(p.org)}),1,${literal("proof_" + suffix)},1,${literal(digest)},${literal(JSON.stringify(scope))}::jsonb,'controlled_review',clock_timestamp(),clock_timestamp()+interval '200 seconds');
INSERT INTO morrow_identity.linking_handoffs(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,review_id,authorizing_grant_id,authorizing_grant_snapshot,requested_scope_snapshot,created_at,expires_at)
VALUES(${literal("hand_" + suffix)},${literal(p.org)},${literal(ws)},${literal(p.principal)},${literal(p.membership)},${literal(sessions[who])},${literal(nonce)},${literal("cand_" + suffix)},${literal("inst_" + suffix)},1,${literal(command)},${literal(digest)},'workspace_first',(SELECT policy_revision FROM morrow_identity.organizations WHERE id=${literal(p.org)}),1,${literal("proof_" + suffix)},1,${literal(digest)},${literal("rev_" + suffix)},${literal(grant.id)},${literal(JSON.stringify(grant))}::jsonb,${literal(JSON.stringify(scope))}::jsonb,clock_timestamp(),clock_timestamp()+interval '200 seconds');`);
      // The linking login reads no table: the expected revision is read as the owner.
      const policy = db.rows(
        `SELECT policy_revision::text AS r FROM morrow_identity.organizations WHERE id=${literal(p.org)}`,
        { role: "morrow_identity_owner" },
      )[0].r;
      return db.rows(
        `SELECT outcome FROM morrow_identity.link_workspace_store(${literal("hand_" + suffix)},${literal(command)},${literal(digest)},${literal(sessions[who])},${literal(nonce)},${literal(p.org)},${literal(ws)},${literal("inst_" + suffix)},'workspace_first',${literal(policy)},'1')`,
        { user: "morrow_identity_linking" },
      )[0]?.outcome;
    };
    const unpaidFixture = fixtureLink(ids.ws2, "F");
    const reason = db.rows(
      `SELECT reason FROM morrow_identity.workspace_link_results ORDER BY recorded_at DESC LIMIT 1`,
      { role: "morrow_identity_owner" },
    )[0]?.reason;
    check(
      "P1:a_controlled_fixture_link_needs_a_morrow_direct_route_too",
      unpaidFixture === "denied" &&
        reason === "billing_route_required" &&
        linkRoute(ids.org, ids.ws2) === "missing",
    );
    const paidFixture = fixtureLink(ids.ws, "F");
    check(
      "P2:a_controlled_fixture_link_into_a_paid_workspace_applies_and_issues_no_store_grant",
      paidFixture === "applied" &&
        db.rows(
          `SELECT count(*)::int AS n FROM morrow_identity.grants WHERE payload->'issuedBy'->>'principalId'='morrow.linking'`,
          { role: "morrow_identity_owner" },
        )[0].n === storeLinkGrantTemplate.length,
    );
    const neverBound = db.rows(
      `SELECT shopify_bound_at IS NULL AS unbound FROM morrow_billing.workspace_billing_routes`,
      { role: "morrow_work_owner" },
    );
    check(
      "P3:no_link_ever_sets_shopify_bound_at",
      neverBound.length > 0 && neverBound.every((r) => r.unbound),
    );

    // -------------------------------------------------------------------------
    // K: the connections read.
    phase("connections");
    const asOwner = await connectionsOf("F", ids.ws);
    const asMember = await connectionsOf("M", ids.ws);
    const second2 = await connectionsOf("F", ids.ws2);
    const foreignRead = await connectionsOf("Q", ids.ws);
    check(
      "K1:connections_list_the_installation_and_the_offer_reason",
      asOwner.status === 200 &&
        validateCurrentDefinition("WorkspaceConnections", asOwner.body) &&
        asOwner.body.installations.length === 1 &&
        asOwner.body.installations[0].status === "linked" &&
        asOwner.body.installations[0].owningWorkspaceId === ids.ws &&
        asOwner.body.installLink.reason === "linked" &&
        asMember.status === 200 &&
        asMember.body.installLink.offered === false &&
        second2.status === 200 &&
        second2.body.installations.length === 0 &&
        second2.body.installLink.reason === "not_registered" &&
        foreignRead.status === 401,
      {
        asOwner: asOwner.body.installLink,
        asMember: asMember.body?.installLink,
        second2: second2.body?.installLink,
      },
    );
    // An app invites W2 (unpaid): offered only once the route is morrow_direct.
    register("lab-shop-w2", randomBytes(16).toString("hex"), sha("lab-w2.myshopify.com"), ids.ws2);
    const w2 = await connectionsOf("F", ids.ws2);
    check(
      "K2:an_unpaid_workspace_is_not_offered_the_install_link",
      w2.body.installLink.reason === "route_not_ready" && w2.body.installLink.url === null,
    );
    db.workOwner(
      `INSERT INTO morrow_billing.workspace_billing_routes(organization_id,workspace_id,origin,shopify_bound_at,route,mode,route_fixed_at,fixing_payment_key,revision,created_at,updated_at) VALUES(${literal(ids.org)},${literal(ids.ws2)},'website',NULL,NULL,NULL,NULL,NULL,1,date_trunc('milliseconds',transaction_timestamp()),date_trunc('milliseconds',transaction_timestamp()));
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=date_trunc('milliseconds',clock_timestamp()),fixing_payment_key='stripe:invoice:in_lab00000002',revision=2,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE workspace_id=${literal(ids.ws2)};`,
    );
    const offered = await connectionsOf("F", ids.ws2);
    check(
      "K3:a_paid_workspace_with_a_registered_app_is_offered_its_link",
      offered.body.installLink.offered === true &&
        offered.body.installLink.reason === "offered" &&
        offered.body.installLink.url === installUrl,
    );

    // -------------------------------------------------------------------------
    // V: the owner's live store (v1 PR 1; ADR-0035 item 2). One app per environment carries
    // the live-store mark, for one intended shop; only that app installs and links a store
    // that is not a development store, and only that shop. Every other app still refuses
    // live stores, in the broker and in the database.
    phase("live_store");
    const liveKey = "lab-live-1";
    const liveClient = randomBytes(16).toString("hex");
    const liveSecret = "shpss_" + randomBytes(16).toString("hex");
    const liveShop = "lab-live-store.myshopify.com";
    const otherLiveShop = "lab-other-live.myshopify.com";
    const liveInstallUrl = `https://admin.shopify.com/oauth/install_custom_app?client_id=${liveClient}&no_redirect=true&signature=live`;
    const registerLive = (key, client, digest, ws = ids.wsL, org = ids.orgL) =>
      db.rows(
        `SELECT outcome FROM morrow_identity.shopify_app_register_live(${literal(key)},${literal(client)},'development',${literal(digest)},${literal(org)},${literal(ws)},${literal(liveInstallUrl)})`,
        { role: "morrow_identity_owner" },
      )[0]?.outcome;
    const liveEnvelope = await sealVaultRecord(
      keyring,
      { kind: "app_secret", appKey: liveKey, provider: "shopify", version: 1 },
      new TextEncoder().encode(liveSecret),
    );
    const liveStored = db.rows(
      `SELECT outcome,version FROM morrow_vault.app_secret_put(${literal(liveKey)},'1',${literal(vaultBytesHex(liveEnvelope.wrappedKey))},${literal(vaultBytesHex(liveEnvelope.sealedValue))})`,
      { role: "morrow_work_owner" },
    )[0];
    const registeredLive = registerLive(liveKey, liveClient, sha(liveShop));
    const secondLive = registerLive(
      "lab-live-2",
      randomBytes(16).toString("hex"),
      sha(otherLiveShop),
    );
    const sameShopLive = registerLive("lab-live-3", randomBytes(16).toString("hex"), sha(liveShop));
    const unmarkedSameShop = register(
      "lab-live-4",
      randomBytes(16).toString("hex"),
      sha(liveShop),
      ids.ws2,
    );
    const liveAsOther = db.tryRun(
      `SET ROLE morrow_work_command; SELECT * FROM morrow_identity.shopify_app_register_live('lab-live-9','${"a".repeat(32)}','development','${"b".repeat(64)}','org_live','ws_live','${liveInstallUrl}');`,
    );
    const liveRows = () =>
      db.rows(
        `SELECT app_key,status,live_store FROM morrow_identity.shopify_apps WHERE live_store ORDER BY app_key`,
        { role: "morrow_identity_owner" },
      );
    check(
      "V1:one_marked_app_per_environment_for_one_shop_and_only_the_operator_registers_it",
      liveStored?.outcome === "stored" &&
        registeredLive === "registered" &&
        secondLive === "live_store_taken" &&
        sameShopLive === "exists" &&
        unmarkedSameShop === "exists" &&
        !liveAsOther.ok &&
        JSON.stringify(liveRows()) ===
          JSON.stringify([{ app_key: liveKey, status: "active", live_store: true }]),
      { registeredLive, secondLive, sameShopLive, unmarkedSameShop, rows: liveRows() },
    );
    // The database's own rules, written around the operator function (sim, each in a
    // transaction that is rolled back): a second active marked app, a marked app for
    // another shop, a mark changed on an existing app, and a live installation row under
    // an unmarked app or for another shop are all refused.
    const refusedSql = (sql) => {
      const r = db.tryRun(`BEGIN; SET LOCAL ROLE morrow_identity_owner; ${sql} ROLLBACK;`);
      return r.ok ? "accepted" : (/SHOPIFY_[A-Z_]+|unique/.exec(r.stderr ?? "")?.[0] ?? "refused");
    };
    const appInsert = (key, digest) =>
      `INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at,live_store) VALUES(${literal(key)},${literal(randomBytes(16).toString("hex"))},'development',${literal(digest)},${literal(ids.orgL)},${literal(ids.wsL)},'read_products,write_products','2026-10',${literal(liveInstallUrl)},'active',1,date_trunc('milliseconds',clock_timestamp()),NULL,true);`;
    const liveInstallationInsert = (app, domain) =>
      `INSERT INTO morrow_identity.store_installations(organization_id,workspace_id,id,app_key,shop_id,shop_domain,store_id,connection_id,generation,status,granted_scopes,credential_id,credential_version,development_store,link_id,revision,created_at,updated_at,reauthorised_at,linked_at) SELECT ${literal(ids.orgL)},${literal(ids.wsL)},${literal(randomUUID())},${literal(app)},'717171',${literal(domain)},${literal(randomUUID())},${literal(randomUUID())},1,'unlinked',ARRAY['read_products','write_products'],${literal(randomUUID())},1,false,NULL,1,t,t,NULL,NULL FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS t) x;`;
    const devAppInsert = `INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at) VALUES('lab-dev-v',${literal(randomBytes(16).toString("hex"))},'development',${literal(sha("lab-dev-v.myshopify.com"))},${literal(ids.orgL)},${literal(ids.wsL)},'read_products,write_products','2026-10',${literal(liveInstallUrl)},'active',1,date_trunc('milliseconds',clock_timestamp()),NULL);`;
    const dbRules = {
      secondActive: refusedSql(appInsert("lab-live-5", sha(liveShop))),
      otherShop: refusedSql(appInsert("lab-live-6", sha(otherLiveShop))),
      markChanged: refusedSql(
        `UPDATE morrow_identity.shopify_apps SET live_store=true,revision=revision+1 WHERE app_key=${literal(appKey)};`,
      ),
      unmarkedLiveRow: refusedSql(
        devAppInsert + liveInstallationInsert("lab-dev-v", "lab-dev-v.myshopify.com"),
      ),
      otherShopRow: refusedSql(liveInstallationInsert(liveKey, otherLiveShop)),
    };
    check(
      "V2:the_database_refuses_a_second_mark_another_shop_a_changed_mark_and_unmarked_live_rows",
      dbRules.secondActive === "unique" &&
        dbRules.otherShop === "SHOPIFY_LIVE_STORE_TAKEN" &&
        dbRules.markChanged === "SHOPIFY_RECORD_IMMUTABLE" &&
        dbRules.unmarkedLiveRow === "SHOPIFY_STORE_NOT_DEVELOPMENT" &&
        dbRules.otherShopRow === "SHOPIFY_STORE_NOT_DEVELOPMENT",
      dbRules,
    );
    // The broker's admission, as its own login only.
    const admission = (key, domain) =>
      db.rows(
        `SELECT morrow_vault.shopify_live_store_admission(${literal(key)},${literal(domain)}) AS outcome`,
        { user: "morrow_vault_broker" },
      )[0]?.outcome;
    const admissionOthers = [
      "morrow_connector_ingress",
      "morrow_api_worker",
      "morrow_identity_linking",
    ].map(
      (user) =>
        db.tryRun(
          `SELECT morrow_vault.shopify_live_store_admission(${literal(liveKey)},${literal(liveShop)});`,
          { user },
        ).ok,
    );
    check(
      "V3:only_the_marked_apps_own_shop_is_admitted_and_only_the_broker_asks",
      admission(liveKey, liveShop) === "admitted" &&
        admission(liveKey, otherLiveShop) === "refused" &&
        admission(appKey, shop) === "refused" &&
        admission("unknown-app", liveShop) === "refused" &&
        admission(liveKey, "Not A Shop") === "invalid" &&
        admissionOthers.every((ok) => !ok),
    );
    // The broker installs the live store through the marked app (Shopify reports it is not a
    // development store).
    const liveOracle = createShopifyOracle({
      secret: liveSecret,
      clientId: liveClient,
      shop: liveShop,
      shopId: "525252",
    });
    liveOracle.state.development = false;
    const liveBroker = createShopifyBroker({
      transaction: (vault, budgetMs, body) =>
        runVaultTransactionWithDriver(
          vaultDriver,
          vault,
          Math.min(10000, budgetMs * 3),
          body,
          Date.now,
          class {
            close() {}
          },
        ),
      fetch: (url, init) => liveOracle.fetch(url, init),
      now: () => Date.now(),
    });
    const liveInstall = async (overrides = {}) => {
      const state = randomBytes(32).toString("base64url");
      const opened = stateOpen(liveKey, liveShop, sha(state));
      const query = liveOracle.callbackQuery(state, overrides.query ?? {});
      const result = decodeShopifyInstallResult(
        await liveBroker.installComplete(brokerEnv, liveKey, query, sha(state), 10000),
      );
      return { state, opened, query, result };
    };
    const liveInstallations = () =>
      db.rows(
        `SELECT id::text,status,development_store,organization_id::text AS org,workspace_id::text AS ws,store_id::text,connection_id::text FROM morrow_identity.store_installations WHERE app_key=${literal(liveKey)}`,
        { role: "morrow_identity_owner" },
      );
    const liveLaunch = decodeShopifyLaunchVerdict(
      await liveBroker.launchVerify(brokerEnv, liveKey, liveOracle.launchQuery()),
    );
    const liveFirst = await liveInstall();
    check(
      "V4:the_marked_apps_live_store_installs_into_the_owners_workspace",
      liveLaunch.verdict === "verified" &&
        liveLaunch.workspaceId === ids.wsL &&
        liveFirst.result.outcome === "installed" &&
        liveFirst.result.workspaceId === ids.wsL &&
        liveInstallations().length === 1 &&
        liveInstallations()[0].development_store === false &&
        liveInstallations()[0].ws === ids.wsL,
      { launch: liveLaunch.verdict, outcome: liveFirst.result.outcome },
    );
    // Another live store using the marked app's install link stores nothing: its launch is
    // refused, no state opens for it, and a callback naming it is refused.
    const otherOracle = createShopifyOracle({
      secret: liveSecret,
      clientId: liveClient,
      shop: otherLiveShop,
      shopId: "626262",
    });
    otherOracle.state.development = false;
    const otherLaunch = decodeShopifyLaunchVerdict(
      await liveBroker.launchVerify(brokerEnv, liveKey, otherOracle.launchQuery()),
    );
    const otherState = randomBytes(32).toString("base64url");
    const otherOpened = stateOpen(liveKey, otherLiveShop, sha(otherState));
    const liveState = randomBytes(32).toString("base64url");
    stateOpen(liveKey, liveShop, sha(liveState));
    const otherCallback = decodeShopifyInstallResult(
      await liveBroker.installComplete(
        brokerEnv,
        liveKey,
        otherOracle.callbackQuery(liveState),
        sha(liveState),
        10000,
      ),
    );
    const allLive = () =>
      db.rows(
        `SELECT count(*)::int AS n FROM morrow_identity.store_installations WHERE NOT development_store`,
        { role: "morrow_identity_owner" },
      )[0].n;
    check(
      "V5:another_live_store_using_the_marked_apps_link_stores_nothing",
      otherLaunch.verdict === "refused" &&
        otherOpened.startsWith("not_found") &&
        otherCallback.outcome === "refused" &&
        allLive() === 1,
      { otherLaunch: otherLaunch.verdict, otherOpened, otherCallback: otherCallback.outcome },
    );
    // Every unmarked app still refuses a live store: the development app's own store, now
    // reported as not a development store, re-authorises nothing and stores nothing.
    const credentialsBefore = vaultRows().length;
    oracle.state.development = false;
    const unmarked = await install();
    oracle.state.development = true;
    check(
      "V6:an_unmarked_app_still_refuses_a_store_that_is_not_a_development_store",
      unmarked.result.outcome === "store_not_development" &&
        vaultRows().length === credentialsBefore &&
        allLive() === 1,
      { outcome: unmarked.result.outcome },
    );
    // The owner links the live store into the owner's workspace (paid by the test
    // entitlement in staging; here the route is fixed by hand, as for W).
    db.workOwner(
      `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=date_trunc('milliseconds',clock_timestamp()),fixing_payment_key='stripe:invoice:in_lab00000003',revision=2,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE workspace_id=${literal(ids.wsL)};`,
    );
    const liveOffer = await connectionsOf("L", ids.wsL);
    // A relaunch first: the live installation re-authorises under the mark (the database
    // guard admits its next credential version) with a fresh continuation.
    const liveFresh = await liveInstall();
    const liveLink = await preview("L", ids.wsL, liveFresh.result.continuationToken);
    const liveApplied =
      liveLink.status === 200
        ? await service.apply(JSON.stringify(liveLink.input), liveLink.ctx.control)
        : null;
    const liveGrants = db.rows(
      `SELECT count(*)::int AS n FROM morrow_identity.grants WHERE payload->'issuedBy'->>'principalId'='morrow.linking' AND principal_id=${literal(people.L.principal)}`,
      { role: "morrow_identity_owner" },
    )[0].n;
    const foreignLive = await connectionsOf("Q", ids.wsL);
    check(
      "V7:the_owner_links_the_live_store_and_receives_the_store_link_grants",
      liveOffer.body.installLink?.reason === "offered" &&
        liveOffer.body.installLink.url === liveInstallUrl &&
        liveFresh.result.outcome === "reauthorised" &&
        liveLink.status === 200 &&
        liveApplied?.outcome === "applied" &&
        liveInstallations()[0].status === "linked" &&
        // Store-link template v2 ("Disconnect store"): the live link issues its five rows.
        liveGrants === storeLinkGrantTemplate.length &&
        foreignLive.status === 401,
      {
        offer: liveOffer.body.installLink,
        fresh: liveFresh.result.outcome,
        link: liveLink.status,
        applied: liveApplied?.outcome,
        grants: liveGrants,
      },
    );
    // The live store's end states pass the live-store guard (sim, rolled back): an
    // uninstall, the credential's destruction and shop/redact's pseudonym change neither the
    // development flag nor the credential version, so Shopify's uninstall and deletion
    // requests still end the owner's store through M2 PR-3's paths (0036's record guard
    // holds each shape).
    const at = "greatest(date_trunc('milliseconds',clock_timestamp()),x.updated_at)";
    const ended = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_identity_owner;
UPDATE morrow_identity.store_installations x SET status='uninstalled',uninstalled_at=${at},revision=x.revision+1,updated_at=${at} WHERE x.app_key=${literal(liveKey)};
UPDATE morrow_identity.store_installations x SET credential_destroyed_at=${at},revision=x.revision+1,updated_at=${at} WHERE x.app_key=${literal(liveKey)};
UPDATE morrow_identity.store_installations x SET shop_domain=morrow_identity.shop_pseudonym(x.id::text),redacted_at=${at},revision=x.revision+1,updated_at=${at} WHERE x.app_key=${literal(liveKey)};
SELECT concat_ws('|',status,development_store::text,(credential_destroyed_at IS NOT NULL)::text,(redacted_at IS NOT NULL)::text,(shop_domain<>${literal(liveShop)})::text) FROM morrow_identity.store_installations WHERE app_key=${literal(liveKey)};
ROLLBACK;`,
    );
    check(
      "V8:the_live_stores_uninstall_credential_destruction_and_redaction_pass_the_guard",
      ended.ok &&
        ended.stdout.split("\n").includes("uninstalled|false|true|true|true") &&
        liveInstallations()[0].status === "linked",
      { ok: ended.ok, stdout: ended.stdout, stderr: ended.stderr?.slice(0, 300) },
    );

    // -------------------------------------------------------------------------
    // H: the shop-specific webhook subscriptions (migrations shopify-webhook-registrations-
    // identity and -vault; apps/broker/src/shopify-webhooks.ts). Both stores (the development
    // app's and the marked live app's) are active and linked here.
    phase("subscriptions");
    const hookOrigin = "https://connector.lab.example.test";
    const hookEnv = {
      ...brokerEnv,
      CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
        schemaVersion: 1,
        origin: hookOrigin,
        apiOrigin: "https://workspace.lab.example.test",
      }),
    };
    const hookPath = (key) => `${hookOrigin}/shopify/a/${key}/webhooks`;
    const devId = installation.id;
    const liveId = liveInstallations()[0].id;
    const asBroker = (sql) => db.rows(sql, { user: "morrow_vault_broker" });
    const pendingIds = () =>
      asBroker("SELECT installation_id FROM morrow_vault.shopify_webhook_registrations_pending()")
        .map((r) => r.installation_id)
        .sort();
    const registrationRows = () =>
      db.rows(
        `SELECT organization_id::text AS org,workspace_id::text AS ws,installation_id::text AS installation,credential_version::int AS version,status,uninstalled_subscription_id AS uninstalled,scopes_update_subscription_id AS scopes,attempts,revision::int AS revision FROM morrow_identity.shopify_webhook_registrations ORDER BY installation_id`,
        { role: "morrow_identity_owner" },
      );
    const tenantOf = (id) =>
      db.rows(
        `SELECT organization_id::text AS org,workspace_id::text AS ws,credential_version::int AS version FROM morrow_identity.store_installations WHERE id=${literal(id)}`,
        { role: "morrow_identity_owner" },
      )[0];
    const deniedToOthers = (sql) =>
      ["morrow_connector_ingress", "morrow_api_worker", "morrow_identity_linking"].every(
        (user) => !db.tryRun(sql, { user }).ok,
      );
    const pendingRows = asBroker(
      "SELECT * FROM morrow_vault.shopify_webhook_registrations_pending()",
    );
    check(
      "H1:only_the_broker_lists_the_active_installations_without_subscriptions_ids_only",
      JSON.stringify(pendingIds()) === JSON.stringify([devId, liveId].sort()) &&
        pendingRows.every((r) => Object.keys(r).join(",") === "installation_id") &&
        deniedToOthers("SELECT * FROM morrow_vault.shopify_webhook_registrations_pending();") &&
        deniedToOthers(`SELECT * FROM morrow_vault.shopify_webhook_target(${literal(devId)});`) &&
        deniedToOthers(
          `SELECT morrow_vault.shopify_webhook_registration_record(${literal(devId)},'2','failed',NULL,NULL);`,
        ) &&
        deniedToOthers("SELECT count(*) FROM morrow_identity.shopify_webhook_registrations;") &&
        deniedToOthers(
          "SELECT * FROM morrow_identity.work_shopify_webhook_registrations_pending();",
        ),
      { pending: pendingIds(), devId, liveId },
    );
    const target = (id) =>
      asBroker(
        `SELECT outcome,organization_id,workspace_id,app_key,shop_domain,credential_version,kek_version,length(wrapped_key)::int AS wrapped,length(sealed_value)::int AS sealed FROM morrow_vault.shopify_webhook_target(${literal(id)})`,
      )[0];
    const devTarget = target(devId);
    const liveTarget = target(liveId);
    check(
      "H2:the_target_is_the_installations_own_tenant_app_shop_and_current_envelope",
      devTarget?.outcome === "found" &&
        devTarget.organization_id === ids.org &&
        devTarget.workspace_id === ids.ws &&
        devTarget.app_key === appKey &&
        devTarget.shop_domain === shop &&
        Number(devTarget.credential_version) === tenantOf(devId).version &&
        devTarget.kek_version === "1" &&
        devTarget.wrapped > 0 &&
        devTarget.sealed > 0 &&
        liveTarget?.outcome === "found" &&
        liveTarget.organization_id === ids.orgL &&
        liveTarget.app_key === liveKey &&
        target(randomUUID())?.outcome === "not_found" &&
        target("bad id!")?.outcome === "invalid",
      {
        dev: devTarget && { ...devTarget, wrapped: undefined, sealed: undefined },
        live: liveTarget?.outcome,
      },
    );
    // The real sync over the vault login, against both synthetic stores. The development
    // store already carries another app path's subscription.
    const foreignSubscription = {
      id: "6001",
      topic: "APP_UNINSTALLED",
      uri: "https://elsewhere.example.test/shopify/webhooks",
    };
    oracle.state.subscriptions.push({ ...foreignSubscription });
    const hooks = createShopifyWebhookSync({
      transaction: (vault, budgetMs, body) =>
        runVaultTransactionWithDriver(
          vaultDriver,
          vault,
          Math.min(10000, budgetMs * 3),
          body,
          Date.now,
          class {
            close() {}
          },
        ),
      fetch: (url, init) => (new URL(url).host === liveShop ? liveOracle : oracle).fetch(url, init),
      now: () => Date.now(),
    });
    // Loaded hosts: a sync may run out of budget before both stores; it is run again until
    // nothing is pending (at most three times), as the cron would.
    const syncUntilDone = async () => {
      const totals = [];
      for (let i = 0; i < 3; i++) {
        totals.push(decodeShopifyWebhookSyncResult(await hooks.sync(hookEnv, 25000)));
        if (pendingIds().length === 0) break;
      }
      return totals;
    };
    const firstSync = await syncUntilDone();
    const ours = (o, key) => o.state.subscriptions.filter((w) => w.uri === hookPath(key));
    const rowsAfter = registrationRows();
    const rowOf = (id) => rowsAfter.find((r) => r.installation === id);
    const matches = (id, o, key, org, ws) => {
      const row = rowOf(id);
      const subs = ours(o, key);
      return (
        row?.status === "registered" &&
        row.org === org &&
        row.ws === ws &&
        row.version === tenantOf(id).version &&
        row.attempts === 0 &&
        JSON.stringify(subs.map((w) => w.topic)) === '["APP_UNINSTALLED","APP_SCOPES_UPDATE"]' &&
        row.uninstalled === subs[0].id &&
        row.scopes === subs[1].id
      );
    };
    check(
      "H3:the_sync_registers_both_stores_subscriptions_to_the_connectors_path_and_records_them",
      firstSync.reduce((n, t) => n + t.registered, 0) === 2 &&
        firstSync.every((t) => t.failed + t.unknown + t.unauthorized + t.skipped === 0) &&
        pendingIds().length === 0 &&
        rowsAfter.length === 2 &&
        matches(devId, oracle, appKey, ids.org, ids.ws) &&
        matches(liveId, liveOracle, liveKey, ids.orgL, ids.wsL) &&
        JSON.stringify(oracle.state.subscriptions[0]) === JSON.stringify(foreignSubscription) &&
        oracle.state.subscriptions.length === 3 &&
        liveOracle.state.subscriptions.length === 2,
      {
        firstSync,
        rowsAfter,
        dev: oracle.state.subscriptions,
        live: liveOracle.state.subscriptions,
      },
    );
    const webhookCalls = () =>
      [...oracle.state.calls, ...liveOracle.state.calls].filter((c) =>
        /^WebhookSubscription/.test(c.operation ?? ""),
      ).length;
    const callsBefore = webhookCalls();
    const idle = decodeShopifyWebhookSyncResult(await hooks.sync(hookEnv, 25000));
    check(
      "H4:a_second_sync_finds_nothing_pending_and_calls_shopify_for_nothing",
      idle.checked === 0 && webhookCalls() === callsBefore,
      { idle },
    );
    // The record's own rules, as the broker's login: closed inputs, the current version only,
    // the tenant from the installation row.
    const record = (id, version, status, a = "NULL", b = "NULL") =>
      asBroker(
        `SELECT morrow_vault.shopify_webhook_registration_record(${literal(id)},${literal(version)},${literal(status)},${a},${b}) AS outcome`,
      )[0]?.outcome;
    const devVersion = String(tenantOf(devId).version);
    const rules = {
      stale: record(devId, String(Number(devVersion) - 1), "failed"),
      newer: record(devId, String(Number(devVersion) + 1), "failed"),
      registeredWithoutIds: record(devId, devVersion, "registered"),
      failedWithIds: record(devId, devVersion, "failed", "'1'", "'2'"),
      sameIds: record(devId, devVersion, "registered", "'5'", "'5'"),
      badStatus: record(devId, devVersion, "deleted"),
      badId: record(devId, devVersion, "registered", "'gid://x'", "'2'"),
      unknownInstallation: record(randomUUID(), "1", "failed"),
    };
    check(
      "H5:the_record_takes_closed_inputs_for_the_current_version_only",
      rules.stale === "stale" &&
        rules.newer === "stale" &&
        rules.registeredWithoutIds === "invalid" &&
        rules.failedWithIds === "invalid" &&
        rules.sameIds === "invalid" &&
        rules.badStatus === "invalid" &&
        rules.badId === "invalid" &&
        rules.unknownInstallation === "not_found" &&
        JSON.stringify(registrationRows()) === JSON.stringify(rowsAfter),
      rules,
    );
    // A failed outcome waits for its backoff (4 minutes per attempt), then the next sync
    // lists, finds both subscriptions and records registered again without creating.
    const failedRecord = record(devId, devVersion, "failed");
    const failedRow = registrationRows().find((r) => r.installation === devId);
    const pendingInBackoff = pendingIds();
    db.sql(
      `SET session_replication_role=replica; UPDATE morrow_identity.shopify_webhook_registrations SET updated_at=updated_at-interval '5 minutes',created_at=created_at-interval '5 minutes' WHERE installation_id=${literal(devId)}; SET session_replication_role=origin;`,
    );
    const pendingAfterBackoff = pendingIds();
    const createsBefore = oracle.state.calls.filter(
      (c) => c.operation === "WebhookSubscriptionCreate",
    ).length;
    const retried = decodeShopifyWebhookSyncResult(await hooks.sync(hookEnv, 25000));
    const retriedRow = registrationRows().find((r) => r.installation === devId);
    check(
      "H6:a_failed_outcome_backs_off_then_is_registered_again_without_a_create",
      failedRecord === "recorded" &&
        failedRow.status === "failed" &&
        failedRow.attempts === 1 &&
        failedRow.uninstalled === null &&
        failedRow.revision === rowOf(devId).revision + 1 &&
        pendingInBackoff.length === 0 &&
        JSON.stringify(pendingAfterBackoff) === JSON.stringify([devId]) &&
        retried.checked === 1 &&
        retried.registered === 1 &&
        retriedRow.status === "registered" &&
        retriedRow.attempts === 0 &&
        retriedRow.uninstalled === rowOf(devId).uninstalled &&
        oracle.state.calls.filter((c) => c.operation === "WebhookSubscriptionCreate").length ===
          createsBefore,
      { failedRecord, failedRow, pendingInBackoff, pendingAfterBackoff, retried, retriedRow },
    );
    // A re-authorisation adds a credential version: the installation is pending again, the
    // sync lists with the new token, creates nothing and records the new version; an outcome
    // for the old version is stale.
    const liveBefore = registrationRows().find((r) => r.installation === liveId);
    const liveReauthorised = await liveInstall();
    const pendingAfterReauthorise = pendingIds();
    const liveCreates = () =>
      liveOracle.state.calls.filter((c) => c.operation === "WebhookSubscriptionCreate").length;
    const liveCreatesBefore = liveCreates();
    const reSynced = decodeShopifyWebhookSyncResult(await hooks.sync(hookEnv, 25000));
    const liveAfter = registrationRows().find((r) => r.installation === liveId);
    check(
      "H7:a_reauthorisation_is_pending_again_and_records_the_new_version_without_a_create",
      liveReauthorised.result.outcome === "reauthorised" &&
        JSON.stringify(pendingAfterReauthorise) === JSON.stringify([liveId]) &&
        reSynced.registered === 1 &&
        liveCreates() === liveCreatesBefore &&
        liveAfter.version === liveBefore.version + 1 &&
        liveAfter.version === tenantOf(liveId).version &&
        liveAfter.revision === liveBefore.revision + 1 &&
        liveAfter.uninstalled === liveBefore.uninstalled &&
        record(liveId, String(liveBefore.version), "failed") === "stale",
      {
        outcome: liveReauthorised.result.outcome,
        pendingAfterReauthorise,
        reSynced,
        liveBefore,
        liveAfter,
      },
    );
    // An ended installation is never pending and has no target (sim, rolled back: the
    // uninstall's own update, then the identity bridges as their executor).
    const endedPending = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_identity_owner;
UPDATE morrow_identity.store_installations x SET status='uninstalled',uninstalled_at=${at},revision=x.revision+1,updated_at=${at} WHERE x.id=${literal(devId)};
SET LOCAL ROLE morrow_work_command;
SELECT 'pending:'||count(*) FROM morrow_identity.work_shopify_webhook_registrations_pending() p WHERE p.installation_id=${literal(devId)};
SELECT 'target:'||outcome FROM morrow_identity.work_shopify_webhook_target(${literal(devId)});
SELECT 'record:'||morrow_identity.work_shopify_webhook_registration_record(${literal(devId)},${literal(String(tenantOf(devId).version))},'failed',NULL,NULL);
ROLLBACK;`,
    );
    const endedLines = endedPending.stdout
      .split("\n")
      .filter((line) => /^(pending|target|record):/.test(line));
    check(
      "H8:an_ended_installation_is_never_pending_has_no_target_and_records_nothing",
      endedPending.ok &&
        JSON.stringify(endedLines) ===
          JSON.stringify(["pending:0", "target:not_found", "record:stale"]) &&
        tenantOf(devId) !== undefined,
      { ok: endedPending.ok, endedLines, stderr: endedPending.stderr?.slice(0, 300) },
    );
    // Shopify removes a shop-specific subscription whose deliveries keep failing (eight
    // retries over about four hours), and only a new create brings it back. A registered row
    // is not pending for 24 hours after its record; then the sync lists the store again. The
    // development store lost its app/scopes_update subscription: exactly that one is
    // created again, the other one and another app path's are left alone. The live store
    // still has both: one list, no create. Both are recorded registered again (a new
    // revision and time, so the next re-check is a day later).
    const before = {
      dev: registrationRows().find((r) => r.installation === devId),
      live: registrationRows().find((r) => r.installation === liveId),
    };
    const ageBoth = (interval) =>
      db.sql(
        `SET session_replication_role=replica; UPDATE morrow_identity.shopify_webhook_registrations SET updated_at=updated_at-interval '${interval}',created_at=created_at-interval '${interval}' WHERE installation_id IN (${literal(devId)},${literal(liveId)}); SET session_replication_role=origin;`,
      );
    const removedAt = oracle.state.subscriptions.findIndex(
      (w) => w.uri === hookPath(appKey) && w.topic === "APP_SCOPES_UPDATE",
    );
    const [removed] = removedAt >= 0 ? oracle.state.subscriptions.splice(removedAt, 1) : [];
    ageBoth("23 hours");
    const pendingWithinDay = pendingIds();
    ageBoth("90 minutes");
    const pendingAfterDay = pendingIds();
    const webhookOps = (o) =>
      o.state.calls.filter((c) => /^WebhookSubscription/.test(c.operation ?? "")).length;
    const opsBefore = { dev: webhookOps(oracle), live: webhookOps(liveOracle) };
    const devCreatesBefore = oracle.state.calls.filter(
      (c) => c.operation === "WebhookSubscriptionCreate",
    ).length;
    const rechecks = await syncUntilDone();
    const devNewCreates = oracle.state.calls
      .filter((c) => c.operation === "WebhookSubscriptionCreate")
      .slice(devCreatesBefore);
    const after = {
      dev: registrationRows().find((r) => r.installation === devId),
      live: registrationRows().find((r) => r.installation === liveId),
    };
    const devOurs = ours(oracle, appKey);
    const reRegistered = (b, a) =>
      b?.status === "registered" &&
      a?.status === "registered" &&
      a.version === b.version &&
      a.attempts === 0 &&
      a.revision === b.revision + 1;
    check(
      "H9:a_registered_row_is_rechecked_after_24_hours_and_only_a_removed_subscription_is_created_again",
      removed !== undefined &&
        pendingWithinDay.length === 0 &&
        JSON.stringify(pendingAfterDay) === JSON.stringify([devId, liveId].sort()) &&
        rechecks.reduce((n, t) => n + t.registered, 0) === 2 &&
        rechecks.every((t) => t.failed + t.unknown + t.unauthorized + t.skipped === 0) &&
        devNewCreates.length === 1 &&
        devNewCreates[0].variables?.topic === "APP_SCOPES_UPDATE" &&
        devNewCreates[0].variables?.uri === hookPath(appKey) &&
        webhookOps(oracle) - opsBefore.dev === 2 &&
        webhookOps(liveOracle) - opsBefore.live === 1 &&
        reRegistered(before.dev, after.dev) &&
        reRegistered(before.live, after.live) &&
        after.dev.uninstalled === before.dev.uninstalled &&
        after.dev.scopes !== removed.id &&
        after.dev.scopes === devOurs.find((w) => w.topic === "APP_SCOPES_UPDATE")?.id &&
        devOurs.length === 2 &&
        after.live.uninstalled === before.live.uninstalled &&
        after.live.scopes === before.live.scopes &&
        JSON.stringify(oracle.state.subscriptions[0]) === JSON.stringify(foreignSubscription) &&
        pendingIds().length === 0,
      {
        removed: removed?.topic,
        pendingWithinDay,
        pendingAfterDay,
        rechecks,
        devNewCreates: devNewCreates.map((c) => c.variables?.topic),
        before,
        after,
      },
    );
  },
  { administrator: "createrole" },
);
void report;

writeArtifact("shopify-install-lab/report.json", {
  scope:
    "M2 PR-2 Shopify install and link on PostgreSQL 17 (synthetic Shopify oracle; no provider effect)",
  sourceDigests,
  checks,
  failures,
  seconds: Math.round((Date.now() - labStarted) / 1000),
});
console.log(JSON.stringify({ checks: checks.length, failures }));
if (failures.length) process.exit(1);
