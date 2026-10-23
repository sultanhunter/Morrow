// "Disconnect store" PostgreSQL 17 laboratory (ADR-0022 items 2, 3, 13 and 15 with the
// amendments of 2026-10-22; ADR-0005; migrations disconnect-store-identity and
// disconnect-store-work, located by slug) on an isolated network-none engine. The chain is
// applied up to the two migrations; stores linked under store-link template v1 are seeded;
// then the two migrations run, so the backfill meets real v1 links. The real TypeScript then
// runs against it, in Node:
//   api        createConnectionsApiHandler (GET and POST /connections/:connectionId/disconnect)
//              and createCatalogApiHandler on the api Worker's login (morrow_api_worker), with
//              the api's broker adapters (createBrokerCredentialDestroyer over an ApiBroker
//              whose shopifyCredentialDestroy fixes the reason, and the reader of shopifyRead)
//              on the vault login's transport (morrow_vault_broker);
//   connector  createConnectorHandler: the app/uninstalled webhook after a disconnect, and the
//              cron's re-drive of a token destruction that did not complete.
// It proves: B the backfill gives the disconnect grant to exactly the linking owners of linked
// stores and changes nothing else; K only a current holder of the capability disconnects, and
// every refusal writes nothing; D one disconnect ends the installation, commits the
// KillSwitchRecord and the person's connection stop, revokes the connection's leases and
// destroys the token; I a replay and a repeat are idempotent; R every read and apply path
// refuses the disconnected store, and the other stores keep working; C a destruction that did
// not complete is pending and the cron finishes it; U a later uninstall changes nothing more;
// O logs and outbound. Owner-seeded synthetic fixtures only (two tenants, five development
// stores); no provider, credential or merchant data. Runs in the CI pg-work group. The local
// superuser is used only for fixtures and the shapes marked "sim".
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createBrokerCredentialDestroyer } from "../apps/api/src/broker-client.ts";
import { createShopifyBroker } from "../apps/broker/src/shopify-install.ts";
import { createShopifyReader } from "../apps/broker/src/shopify-read.ts";
import { createVaultKeyring, sealVaultRecord, vaultBytesHex } from "../apps/broker/src/vault.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import { createConnectorHandler } from "../apps/shopify-connector/worker/connector.ts";
import { createConnectorDatabase } from "../apps/shopify-connector/worker/database.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  disconnectFields,
  storeLinkGrantTemplate,
  storeLinkGrantTemplateV1,
} from "../packages/policy/src/store-link-template.ts";
import { storeResource } from "../packages/policy/src/store-resource.ts";
import { createCatalogApiHandler } from "../packages/work/src/catalog/http.ts";
import { createConnectionsApiHandler } from "../packages/work/src/connections/http.ts";
import { loadMigrationChain } from "./migration-chain.mjs";
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
const checks = [];
const failures = [];
const labStarted = Date.now();
const phase = (value) =>
  console.error(
    "DISCONNECT_STORE_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("DISCONNECT_STORE_LAB_CHECK_NAME:" + name);
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
const rowOf = (slug) => manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const identityRow = rowOf("disconnect-store-identity");
const workRow = rowOf("disconnect-store-work");
if (!identityRow || !workRow || workRow.sequence !== identityRow.sequence + 1)
  throw Error("DISCONNECT_STORE_LAB_MIGRATIONS_REQUIRED");
const sourceDigests = Object.fromEntries(
  [
    "scripts/disconnect-store-lab.mjs",
    "packages/work/src/connections/http.ts",
    "packages/work/src/connections/commands.ts",
    "packages/work/src/connections/sql.ts",
    "packages/work/src/stops.ts",
    "packages/policy/src/store-link-template.ts",
    "apps/api/src/broker-client.ts",
    "apps/broker/src/shopify-install.ts",
    "migrations/" + identityRow.file,
    "migrations/" + workRow.file,
  ].map((p) => [p, sha(readFileSync(p))]),
);

const kek = randomBytes(32).toString("hex");
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-disconnect-lab",
  branchId: "br-disconnect-lab",
  hostname: "ep-disconnect-lab.c-14.us-east-1.aws.neon.tech",
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
const reason = "The store is moving to a new owner; stop everything now.";
// Worker console lines are captured: no secret, token or reason may appear.
const consoleLines = [];
const print = console.log.bind(console);
console.log = (...args) => {
  consoleLines.push(args.map(String).join(" "));
};

const report = await withWorkDatabase(
  "disconnect-store",
  async (db) => {
    // -------------------------------------------------------------------------
    phase("fixtures");
    const P = seedWorkFixtures(db);
    const A = P.A,
      X = P.X,
      Y = P.Y;
    // Each organization's founding signup (0013): review_context's ownership facts read it.
    db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_disconnect','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_disconnect',${literal(A.org)},${literal(A.workspace)},${literal(A.membership)},'owner-bootstrap-v1',clock_timestamp());
INSERT INTO morrow_identity.organization_signups VALUES(${literal(Y.principal)},${literal(randomUUID())},${literal("c".repeat(64))},'profile_disconnect',${literal(Y.org)},${literal(Y.workspace)},${literal(Y.membership)},'owner-bootstrap-v1',clock_timestamp());`);
    // Five development stores: D (disconnected), E (a sibling that keeps working) and F (a
    // destruction that does not complete) in O/W, owned by A; W2 (installed, never linked)
    // in O/W; T in the other tenant P/WP, owned by Y.
    const stores = {
      D: { owner: A, store: "store_disc", link: true },
      E: { owner: A, store: "store_keep", link: true },
      F: { owner: A, store: "store_fail", link: true },
      N: { owner: A, store: "store_wait", link: false },
      T: { owner: Y, store: "store_other", link: true },
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
          link: s.link,
        }),
      );
    }
    db.admin(statements.join("\n"));
    // Store-link template v1 on each linked store, as 0026's link issued it to the
    // organization's founding principal (issued by morrow.linking on the store resource).
    const actorOf = (p) => ({
      kind: "human",
      principalId: p.principal,
      organizationId: p.org,
      workspaceId: p.workspace,
      membershipId: p.membership,
      installationId: null,
      mandateId: null,
    });
    const v1Grants = [];
    for (const s of Object.values(stores).filter((x) => x.link))
      for (const row of storeLinkGrantTemplateV1) {
        const p = s.owner;
        const g = {
          id: "g_v1_" + row.capabilityId.replaceAll(".", "_") + "_" + s.store,
          principal: actorOf(p),
          capabilityId: row.capabilityId,
          verbs: [...row.verbs],
          scope: {
            organizationId: p.org,
            workspaceId: p.workspace,
            storeIds: [s.store],
            accountIds: [],
            resources: [storeResource(p.org, p.workspace, s.store, s.connection)],
            fields: [...row.fields],
          },
          issuedBy: { ...actorOf(p), kind: "service", principalId: "morrow.linking", membershipId: null },
          validFrom: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          revokedAt: null,
          policyRevision: 1,
        };
        if (!validateCurrentDefinition("Grant", g)) throw Error("LAB_GRANT_INVALID");
        v1Grants.push(
          `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(p.org)},${literal(p.workspace)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`,
        );
      }
    db.admin(v1Grants.join("\n"));
    // Each app's secret and each installation's sealed offline token.
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
    const { D, E, F, N, T } = stores;
    const ownerRows = (q) => db.rows(q, { role: "morrow_identity_owner" });
    const workRows = (q) => db.rows(q, { role: "morrow_work_owner" });
    const grantRows = () =>
      ownerRows(
        `SELECT id::text,principal_id::text AS principal,membership_id::text AS membership,payload FROM morrow_identity.grants ORDER BY id`,
      );

    // -------------------------------------------------------------------------
    // B: the two migrations meet real v1 links.
    phase("migrations");
    const before = grantRows();
    for (const entry of loadMigrationChain().filter((e) => e.sequence >= identityRow.sequence)) {
      if (!/^morrow_[a-z]+_owner$/.test(entry.executeAs)) throw Error("LAB_EXECUTE_AS_INVALID");
      db.sql("SET ROLE " + entry.executeAs + ";\n" + entry.text);
    }
    const after = grantRows();
    const added = after.filter((g) => !before.some((b) => b.id === g.id));
    const policyRevision = (org) =>
      Number(
        ownerRows(`SELECT policy_revision::text AS r FROM morrow_identity.organizations WHERE id=${literal(org)}`)[0].r,
      );
    const expectedGrant = (s, g) => ({
      id: g.id,
      principal: actorOf(s.owner),
      capabilityId: "governance.connection.disconnect",
      verbs: ["execute"],
      scope: {
        organizationId: s.org,
        workspaceId: s.ws,
        storeIds: [s.store],
        accountIds: [],
        resources: [storeResource(s.org, s.ws, s.store, s.connection)],
        fields: [...disconnectFields],
      },
      issuedBy: { ...actorOf(s.owner), kind: "service", principalId: "morrow.linking", membershipId: null },
      validFrom: g.payload.validFrom,
      expiresAt: null,
      revokedAt: null,
      policyRevision: policyRevision(s.org),
    });
    const linked = [D, E, F, T];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const canonicalOf = (value) =>
      JSON.stringify(value, Object.keys(value).sort()) && JSON.stringify(sortKeys(value));
    function sortKeys(value) {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sortKeys(value[k])]),
        );
      return value;
    }
    check(
      "B1:the_backfill_gives_each_linking_owner_of_a_linked_store_exactly_the_disconnect_grant",
      added.length === linked.length &&
        linked.every((s) => {
          const g = added.find((x) => x.payload.scope.storeIds[0] === s.store);
          return (
            g &&
            g.principal === s.owner.principal &&
            g.membership === s.owner.membership &&
            validateCurrentDefinition("Grant", g.payload) &&
            canonicalOf(g.payload) === canonicalOf(expectedGrant(s, g))
          );
        }) &&
        !added.some((g) => g.payload.scope.storeIds[0] === N.store || g.principal === X.principal),
      { added: added.map((g) => [g.principal, g.payload.capabilityId, g.payload.scope.storeIds]) },
    );
    check(
      "B2:the_backfill_revises_or_revokes_no_other_grant",
      before.every((b) => same(after.find((g) => g.id === b.id)?.payload, b.payload)) &&
        after.length === before.length + added.length,
    );
    const backfill = /INSERT INTO morrow_identity\.grants[\s\S]*?;\nCOMMIT;/.exec(
      readFileSync("migrations/" + identityRow.file, "utf8"),
    )?.[0];
    const rerun = db.tryRun(
      "BEGIN; SET LOCAL ROLE morrow_identity_owner;\n" + (backfill ?? "").replace(/\nCOMMIT;$/, "") + "\nCOMMIT;",
    );
    check(
      "B3:the_backfill_is_once_only_a_second_run_inserts_nothing",
      Boolean(backfill) && rerun.ok && grantRows().length === after.length,
      { rerun: rerun.stderr?.slice(0, 200) },
    );
    check(
      "B4:a_link_from_now_on_applies_template_v2",
      same(
        ownerRows(
          "SELECT capability_id,verbs,fields FROM morrow_identity.store_link_grants_v2() ORDER BY capability_id",
        ),
        [...storeLinkGrantTemplate]
          .sort((a, b) => (a.capabilityId < b.capabilityId ? -1 : 1))
          .map((r) => ({ capability_id: r.capabilityId, verbs: [...r.verbs], fields: [...r.fields] })),
      ) &&
        db.rows(
          "SELECT position('store_link_grants_v2()' IN prosrc)>0 AS v2,position('store_link_grants_v1()' IN prosrc)>0 AS v1 FROM pg_proc WHERE oid='morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)'::regprocedure",
        )[0].v2 === true,
    );

    // -------------------------------------------------------------------------
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
        query: (text, values = []) => connection.query(text, [...values], new AbortController().signal),
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
      runVaultTransactionWithDriver(bridged, vault, Math.min(10000, budgetMs * 3), body, Date.now, NoSocket);
    const broker = createShopifyBroker({ transaction, fetch: shopifyFetch, now: () => Date.now() });
    const reader = createShopifyReader({ transaction, fetch: shopifyFetch, now: () => Date.now() });
    // The ApiBroker's shopifyCredentialDestroy: one argument, the reason fixed (index.ts).
    const faults = { destroy: false };
    const apiDestroyCalls = [];
    const apiBroker = {
      async shopifyCredentialDestroy(installationId) {
        apiDestroyCalls.push(installationId);
        if (faults.destroy) throw Error("lab: the ApiBroker binding is unreachable");
        return broker.credentialDestroy(brokerEnv, installationId, "disconnected");
      },
    };
    const ctx = { waitUntil() {} };
    const connections = createConnectionsApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(),
      now: () => Date.now(),
      credentials: createBrokerCredentialDestroyer(apiBroker),
    });
    const catalog = createCatalogApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(),
      now: () => Date.now(),
      reader: {
        read: (lease, queryName, variablesJson, _signal, budgetMs) =>
          reader.read(brokerEnv, "api", lease.leaseId, lease.generation, lease.subjectId, queryName, variablesJson, budgetMs),
      },
    });
    const connector = createConnectorHandler({
      configuration: { origin: connectorOrigin, apiOrigin: workFixtureOrigin },
      broker: {
        shopifyLaunchVerify: (appKey, rawQuery) => broker.launchVerify(brokerEnv, appKey, rawQuery),
        shopifyInstallComplete: (appKey, rawQuery, digest, budgetMs) =>
          broker.installComplete(brokerEnv, appKey, rawQuery, digest, budgetMs),
        shopifyWebhookVerify: (appKey, headersJson, rawBodyBase64) =>
          broker.webhookVerify(brokerEnv, appKey, headersJson, rawBodyBase64),
        shopifyCredentialDestroy: (installationId, why) =>
          broker.credentialDestroy(brokerEnv, installationId, why),
      },
      database: createConnectorDatabase(
        binding,
        {
          neonLease: async () =>
            JSON.stringify({ schemaVersion: 1, password: "lab-" + randomBytes(12).toString("hex") }),
        },
        bridged,
        Date.now,
        NoSocket,
      ),
      limiters: null,
    });
    const headersFor = (p, method, key) => {
      const headers = {
        Cookie: "__Host-morrow_session=" + p.secret,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      };
      if (method !== "GET") {
        headers.Origin = workFixtureOrigin;
        headers["Content-Type"] = "application/json";
        headers["X-Morrow-Request"] = "1";
        headers["Idempotency-Key"] = key ?? randomUUID();
      }
      return headers;
    };
    async function disconnectCall(p, method, s, options = {}) {
      const ws = options.workspace ?? p.workspace;
      const body =
        method === "GET"
          ? undefined
          : JSON.stringify(options.body ?? { control: { reason, sourceProposalRef: null } });
      const response = await connections.fetch(
        new Request(`${workFixtureOrigin}/workspace/${ws}/connections/${options.connectionId ?? s.connection}/disconnect`, {
          method,
          headers: headersFor(p, method, options.key),
          body,
        }),
        {},
        ctx,
      );
      let json = null;
      try {
        json = await response.json();
      } catch {}
      return { status: response.status, body: json };
    }
    async function catalogRead(p, s) {
      const response = await catalog.fetch(
        new Request(`${workFixtureOrigin}/workspace/${p.workspace}/stores/${s.store}/catalog/collections`, {
          headers: headersFor(p, "GET"),
        }),
        {},
        ctx,
      );
      return response.status;
    }
    const installationOf = (s) =>
      ownerRows(
        `SELECT status,suspended_reason,revision::text AS revision,credential_destroyed_at IS NOT NULL AS token_destroyed FROM morrow_identity.store_installations WHERE id=${literal(s.installation)}`,
      )[0];
    const credentialOf = (s) =>
      workRows(
        `SELECT status,wrapped_key IS NULL AND sealed_value IS NULL AS erased,destroy_reason FROM morrow_vault.credentials WHERE subject_id=${literal(s.installation)} ORDER BY version`,
      );
    const stopsOf = (s) =>
      workRows(
        `SELECT id::text,set_by_kind,set_by_principal_id::text AS principal,reason_code,reason,kill_switch_record_id::text AS record,lifted_at IS NULL AS active FROM morrow_work.stop_controls WHERE scope='connection' AND target_id=${literal(s.connection)} ORDER BY created_at`,
      );
    const recordsOf = (s) =>
      workRows(
        `SELECT id::text,capability_id,target_kind,target_id::text AS target,store_id::text AS store,connection_id::text AS connection,actor_principal_id::text AS actor,canonical,prior_state_observed AS prior FROM morrow_work.kill_switch_records WHERE connection_id=${literal(s.connection)} ORDER BY created_at`,
      );
    const leasesOf = (s) =>
      workRows(
        `SELECT id::text,kind,status,revoked_reason FROM morrow_work.work_leases WHERE connection_id=${literal(s.connection)} ORDER BY created_at`,
      );
    // The whole state a disconnect could change on one store.
    const stateOf = (s) =>
      JSON.stringify({
        installation: installationOf(s),
        credential: credentialOf(s),
        stops: stopsOf(s),
        records: recordsOf(s).map((r) => r.id),
        leases: leasesOf(s),
        commands: workRows(
          `SELECT count(*)::int AS n FROM morrow_work.commands WHERE command_type='connection.disconnect' AND aggregate_id=${literal(s.connection)}`,
        )[0].n,
      });
    const openLease = (p, s) =>
      db.rows(
        `SELECT * FROM morrow_work.catalog_read_lease(${literal(s.store)},${literal(s.connection)})`,
        {
          prefix: `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${literal(p.digest)},${literal(p.workspace)});\n`,
          suffix: "\nCOMMIT;",
          user: "morrow_api_worker",
        },
      )[0];
    const resolve = (lease) => {
      const r = db.tryRun(
        `SELECT outcome FROM morrow_vault.shopify_read_resolve(${literal(lease.lease_id)},${literal(String(lease.generation))},${literal(lease.subject_id)},'collectionsPage',NULL);`,
        { user: "morrow_vault_broker" },
      );
      return r.ok ? r.stdout.split("\n").at(-1) : "error";
    };
    // lease_open in a tenant's session context, as an api command's definer calls it; the
    // transaction rolls back (a refusal writes nothing, and an opened lease is discarded).
    const leaseOpen = (p, s, kind, installation = null) => {
      const r = db.tryRun(
        asCommandRole(
          p,
          `SELECT outcome FROM morrow_work.lease_open(${literal(kind)},${literal("subject_" + randomUUID())},${literal(s.store)},${literal(s.connection)},${installation === null ? "NULL" : literal(installation)});`,
        ),
      );
      return r.ok ? r.stdout.split("\n").filter(Boolean).at(-1) : "error";
    };
    const stopActive = (s, kind) =>
      db.rows(
        `SELECT morrow_work.stop_active(${literal(s.org)},${literal(s.ws)},${literal(kind)},${literal(s.connection)},NULL) AS stopped`,
        { role: "morrow_work_command" },
      )[0].stopped;
    check(
      "F1:five_stores_in_two_tenants_with_secrets_sealed_tokens_and_the_linked_ones_current",
      Object.values(stores).every(
        (s) =>
          s.secretStored === "stored" &&
          installationOf(s)?.status === (s.link ? "linked" : "unlinked") &&
          credentialOf(s).length === 1 &&
          credentialOf(s)[0].status === "active",
      ),
    );

    // -------------------------------------------------------------------------
    // K: only a current holder of governance.connection.disconnect disconnects.
    phase("authority");
    const readLeaseD = openLease(A, D);
    const readLeaseE = openLease(A, E);
    const statusA = await disconnectCall(A, "GET", D);
    const statusX = await disconnectCall(X, "GET", D);
    check(
      "K1:the_status_read_offers_disconnect_only_to_the_holder",
      statusA.status === 200 &&
        same(statusA.body, {
          schemaVersion: 1,
          connectionId: D.connection,
          storeId: D.store,
          installationStatus: "linked",
          stop: null,
          actions: { disconnect: true },
        }) &&
        statusX.status === 200 &&
        statusX.body.actions.disconnect === false,
      { statusA, statusX },
    );
    const untouched = stateOf(D);
    const member = await disconnectCall(X, "POST", D);
    const foreign = await disconnectCall(Y, "POST", D);
    const crossWorkspace = await disconnectCall(Y, "POST", D, { workspace: A.workspace });
    const unknown = await disconnectCall(A, "POST", D, { connectionId: "connection_absent" });
    const unlinked = await disconnectCall(A, "POST", N);
    check(
      "K2:a_member_without_the_grant_another_tenant_an_unknown_or_never_linked_connection_change_nothing",
      member.status === 403 &&
        foreign.status === 404 &&
        [401, 403, 404].includes(crossWorkspace.status) &&
        unknown.status === 404 &&
        unlinked.status === 404 &&
        stateOf(D) === untouched &&
        installationOf(N).status === "unlinked" &&
        apiDestroyCalls.length === 0,
      { member: member.status, foreign: foreign.status, cross: crossWorkspace.status, unknown: unknown.status, unlinked: unlinked.status },
    );
    // A revoked grant confers nothing (the owner-maintenance revocation of one grant).
    const disconnectGrantOf = (s) =>
      ownerRows(
        `SELECT id::text FROM morrow_identity.grants WHERE payload->>'capabilityId'='governance.connection.disconnect' AND payload#>>'{scope,storeIds,0}'=${literal(s.store)}`,
      )[0].id;
    const setRevoked = (id, revoked) =>
      db.admin(`BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',${literal(A.org)}::text)::text,0));
UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',${revoked ? "to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))" : "'null'::jsonb"}) WHERE id=${literal(id)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(A.org)};
COMMIT;`);
    const grantE = disconnectGrantOf(E);
    const untouchedE = stateOf(E);
    setRevoked(grantE, true);
    const revoked = await disconnectCall(A, "POST", E);
    const revokedStatus = await disconnectCall(A, "GET", E);
    setRevoked(grantE, false);
    check(
      "K3:a_revoked_grant_disconnects_nothing",
      revoked.status === 403 && revokedStatus.body?.actions?.disconnect === false && stateOf(E) === untouchedE,
      { revoked: revoked.status },
    );
    const direct = (user, sql) => db.tryRun(sql, { user });
    const probeRecord = '{"id":"record_probe","createdAt":"2026-10-23T00:00:00.000Z"}';
    const cmdSql = `SELECT outcome FROM morrow_work.cmd_store_disconnect('${randomUUID()}','${"a".repeat(64)}','corr',${literal(D.connection)},${literal(probeRecord)},${literal(sha(probeRecord))});`;
    const noContext = direct(
      "morrow_api_worker",
      `BEGIN; SET LOCAL ROLE morrow_work_api; ${cmdSql} ROLLBACK;`,
    );
    check(
      "K4:no_context_and_no_other_login_reaches_the_disconnect_or_ends_an_installation",
      noContext.ok &&
        noContext.stdout.split("\n").at(-1) === "ineligible" &&
        ["morrow_connector_ingress", "morrow_runtime_executor", "morrow_vault_broker"].every(
          (user) =>
            !direct(user, cmdSql).ok &&
            !direct(user, `SELECT * FROM morrow_work.connection_target(${literal(D.connection)});`).ok,
        ) &&
        !direct(
          "morrow_api_worker",
          `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT * FROM morrow_identity.work_shopify_installation_end(${literal(A.org)},${literal(A.workspace)},${literal(D.installation)},'disconnected'); ROLLBACK;`,
        ).ok &&
        // The api's role cannot write a stop or a record itself, even in its own context.
        !direct(
          "morrow_api_worker",
          asApi(
            A,
            `INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,reason_code,reason,created_at) VALUES(${literal(A.org)},${literal(A.workspace)},'forged','connection',${literal(D.store)},${literal(D.connection)},'human',${literal(A.principal)},${literal(A.membership)},'human_disconnect','x',now());`,
          ),
        ).ok &&
        stateOf(D) === untouched,
    );

    // -------------------------------------------------------------------------
    // D: one disconnect by the holder.
    phase("disconnect");
    const callsBefore = Object.values(stores).map((s) => s.oracle.state.calls.length);
    const key = randomUUID();
    const first = await disconnectCall(A, "POST", D, { key });
    const installationD = installationOf(D);
    const recordD = recordsOf(D);
    const stopD = stopsOf(D);
    const canonical = recordD[0] ? JSON.parse(recordD[0].canonical) : null;
    check(
      "D1:the_reply_reports_the_disconnect_and_the_destroyed_token",
      first.status === 200 &&
        first.body?.status === "disconnected" &&
        first.body.priorStateObserved === "active" &&
        first.body.connectionId === D.connection &&
        first.body.storeId === D.store &&
        first.body.installationId === D.installation &&
        first.body.installation === "suspended" &&
        first.body.endReason === "disconnected" &&
        first.body.credential === "destroyed" &&
        same(apiDestroyCalls, [D.installation]),
      first,
    );
    check(
      "D2:the_installation_is_suspended_as_disconnected_and_the_token_is_erased",
      installationD.status === "suspended" &&
        installationD.suspended_reason === "disconnected" &&
        installationD.token_destroyed === true &&
        credentialOf(D).length === 1 &&
        credentialOf(D)[0].status === "destroyed" &&
        credentialOf(D)[0].erased === true &&
        credentialOf(D)[0].destroy_reason === "disconnected",
      { installationD, credential: credentialOf(D) },
    );
    check(
      "D3:the_killswitchrecord_names_the_connection_and_the_persons_stop_names_the_record",
      recordD.length === 1 &&
        recordD[0].capability_id === "governance.connection.disconnect" &&
        recordD[0].target_kind === "connection" &&
        recordD[0].target === D.connection &&
        recordD[0].store === D.store &&
        recordD[0].actor === A.principal &&
        recordD[0].prior === "active" &&
        validateCurrentDefinition("KillSwitchRecord", canonical) &&
        same(canonical.targets, [
          { organizationId: A.org, workspaceId: A.workspace, storeId: D.store, connectionId: D.connection, kind: "connection", id: D.connection },
        ]) &&
        canonical.control.reason === reason &&
        canonical.actor.principalId === A.principal &&
        stopD.length === 1 &&
        stopD[0].set_by_kind === "human" &&
        stopD[0].principal === A.principal &&
        stopD[0].reason_code === "human_disconnect" &&
        stopD[0].reason === reason &&
        stopD[0].record === recordD[0].id &&
        stopD[0].active === true &&
        first.body.killSwitchRecordId === recordD[0].id &&
        first.body.stopId === stopD[0].id &&
        workRows(
          `SELECT count(*)::int AS n FROM morrow_work.outbox_events WHERE event_type='kill_switch.executed' AND aggregate_id=${literal(recordD[0].id)} AND payload->>'capabilityId'='governance.connection.disconnect'`,
        )[0].n === 1,
      { recordD, stopD },
    );
    check(
      "D4:no_shopify_call_and_nothing_else_changed",
      Object.values(stores).every((s, i) => s.oracle.state.calls.length === callsBefore[i]) &&
        [E, F, T].every(
          (s) =>
            installationOf(s).status === "linked" &&
            credentialOf(s)[0].status === "active" &&
            stopsOf(s).length === 0 &&
            recordsOf(s).length === 0,
        ),
    );
    const statusAfter = await disconnectCall(A, "GET", D);
    check(
      "D5:the_status_read_shows_the_persons_disconnect_and_offers_nothing",
      statusAfter.status === 200 &&
        statusAfter.body.installationStatus === "suspended" &&
        statusAfter.body.stop?.setBy === "human" &&
        statusAfter.body.stop.reasonCode === "human_disconnect" &&
        statusAfter.body.actions.disconnect === false,
      statusAfter,
    );

    // -------------------------------------------------------------------------
    // R: every read and apply path refuses the disconnected store; the others keep working.
    phase("refusals");
    const leasesD = leasesOf(D);
    const leaseCountD = leasesD.length;
    const readD = await catalogRead(A, D);
    const readE = await catalogRead(A, E);
    check(
      "R1:the_read_lease_opened_before_the_disconnect_is_revoked_and_the_vault_refuses_it",
      readLeaseD?.outcome === "opened" &&
        leasesD.find((l) => l.id === readLeaseD.lease_id)?.status === "revoked" &&
        leasesD.find((l) => l.id === readLeaseD.lease_id)?.revoked_reason === "stop" &&
        resolve(readLeaseD) === "ended" &&
        resolve(readLeaseE) === "resolved",
      { leasesD, d: resolve(readLeaseD), e: resolve(readLeaseE) },
    );
    const brokerRead = await reader
      .read(brokerEnv, "api", readLeaseD.lease_id, Number(readLeaseD.generation), readLeaseD.subject_id, "collectionsPage", '{"after":null}', 5000)
      .then(
        () => "read",
        (error) => error?.code ?? "error",
      );
    check(
      "R2:the_brokers_read_under_that_lease_is_refused_before_shopify",
      brokerRead === "READ_REFUSED" && D.oracle.state.calls.length === callsBefore[0],
      { brokerRead },
    );
    check(
      "R3:the_catalogue_routes_answer_not_found_and_open_no_lease",
      readD === 404 && leasesOf(D).length === leaseCountD && readE === 200,
      { readD, readE },
    );
    const opened = ["read", "run", "operation"].map((kind) =>
      leaseOpen(A, D, kind, kind === "read" ? null : "installation_probe"),
    );
    check(
      "R4:no_read_run_or_operation_lease_opens_on_the_connection",
      same(opened, ["stopped", "stopped", "stopped"]) &&
        leaseOpen(A, E, "read") === "opened" &&
        leasesOf(D).length === leaseCountD,
      { opened, e: leaseOpen(A, E, "read") },
    );
    check(
      "R5:the_stop_blocks_reads_runs_and_the_gateways_operations_on_this_connection_only",
      ["read", "run", "operation"].every((kind) => stopActive(D, kind) === true) &&
        ["read", "run", "operation"].every((kind) => stopActive(E, kind) === false),
    );
    const association = (p, s) =>
      db.tryRun(asApi(p, `SELECT count(*) FROM morrow_work.store_association(${literal(s.store)});`), {
        user: "morrow_api_worker",
      }).stdout.split("\n").filter(Boolean).at(-1);
    const catalogLease = (p, s) =>
      db.tryRun(
        asApi(p, `SELECT outcome FROM morrow_work.catalog_read_lease(${literal(s.store)},${literal(s.connection)});`),
        { user: "morrow_api_worker" },
      ).stdout.split("\n").filter(Boolean).at(-1);
    check(
      "R6:the_store_is_no_longer_current_so_agent_enable_and_run_admission_find_nothing",
      association(A, D) === "0" &&
        association(A, E) === "1" &&
        catalogLease(A, D) === "not_found" &&
        catalogLease(A, E) === "opened",
    );

    // -------------------------------------------------------------------------
    // I: a replay and a repeat change nothing more.
    phase("idempotency");
    const settled = stateOf(D);
    const replay = await disconnectCall(A, "POST", D, { key });
    const conflict = await disconnectCall(A, "POST", D, {
      key,
      body: { control: { reason: "A different reason.", sourceProposalRef: null } },
    });
    check(
      "I1:a_replay_returns_the_recorded_result_and_asks_the_broker_again",
      replay.status === 200 &&
        replay.body.replayed === true &&
        replay.body.killSwitchRecordId === first.body.killSwitchRecordId &&
        replay.body.stopId === first.body.stopId &&
        replay.body.credential === "destroyed" &&
        same(apiDestroyCalls, [D.installation, D.installation]) &&
        conflict.status === 409 &&
        stateOf(D) === settled,
      { replay, conflict: conflict.status },
    );
    const again = await disconnectCall(A, "POST", D);
    const recordsAgain = recordsOf(D);
    check(
      "I2:a_new_disconnect_records_already_stopped_and_keeps_the_one_stop",
      again.status === 200 &&
        again.body.priorStateObserved === "already_stopped" &&
        again.body.stopId === first.body.stopId &&
        again.body.installation === "suspended" &&
        again.body.credential === "destroyed" &&
        recordsAgain.length === 2 &&
        recordsAgain[1].prior === "already_stopped" &&
        stopsOf(D).length === 1 &&
        installationOf(D).revision === installationD.revision &&
        credentialOf(D)[0].status === "destroyed",
      { again, records: recordsAgain.length },
    );

    // -------------------------------------------------------------------------
    // C: a destruction that does not complete is pending; the connector's cron finishes it.
    phase("credential");
    faults.destroy = true;
    const pending = await disconnectCall(A, "POST", F);
    faults.destroy = false;
    const pendingTokens = db.tryRun(
      "SELECT string_agg(installation_id||':'||reason,',') FROM morrow_work.connector_credentials_pending();",
      { user: "morrow_connector_ingress" },
    );
    check(
      "C1:the_disconnect_stands_and_the_token_is_reported_pending",
      pending.status === 200 &&
        pending.body.credential === "pending" &&
        pending.body.priorStateObserved === "active" &&
        installationOf(F).status === "suspended" &&
        installationOf(F).token_destroyed === false &&
        credentialOf(F)[0].status === "active" &&
        stopsOf(F).length === 1 &&
        pendingTokens.ok &&
        pendingTokens.stdout.split("\n").at(-1).includes(F.installation + ":disconnected"),
      { pending, tokens: pendingTokens.stdout },
    );
    const redrive = await connector.redrive();
    check(
      "C2:the_cron_destroys_the_disconnected_token_and_records_it",
      redrive.destroyed >= 1 &&
        credentialOf(F)[0].status === "destroyed" &&
        credentialOf(F)[0].destroy_reason === "disconnected" &&
        installationOf(F).token_destroyed === true &&
        (await connector.redrive()).credentials === 0,
      { redrive },
    );

    // -------------------------------------------------------------------------
    // U: an uninstall after the disconnect ends the installation and stops nothing twice.
    phase("uninstall");
    const hook = D.oracle.webhook(
      "app/uninstalled",
      JSON.stringify({ id: Number(D.shopId), name: "Lab", myshopify_domain: D.shop }),
    );
    const pendingWork = [];
    const delivered = await connector.fetch(
      new Request(`${connectorOrigin}/shopify/a/${D.appKey}/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hook.headers },
        body: hook.body,
      }),
      { waitUntil: (p) => pendingWork.push(p) },
    );
    await Promise.all(pendingWork);
    const inbox = ownerRows(
      `SELECT status,effects FROM morrow_identity.shopify_webhook_inbox WHERE app_key=${literal(D.appKey)} ORDER BY received_at DESC LIMIT 1`,
    )[0];
    check(
      "U1:the_uninstall_finds_the_persons_stop_standing_and_the_token_already_gone",
      delivered.status === 200 &&
        installationOf(D).status === "uninstalled" &&
        stopsOf(D).length === 1 &&
        stopsOf(D)[0].set_by_kind === "human" &&
        inbox?.status === "applied" &&
        inbox.effects?.stop === "already_stopped" &&
        credentialOf(D)[0].status === "destroyed" &&
        credentialOf(D)[0].destroy_reason === "disconnected",
      { inbox, installation: installationOf(D) },
    );

    // -------------------------------------------------------------------------
    // O: logs and outbound.
    phase("observability");
    const logged = consoleLines.join("\n");
    check(
      "O1:no_secret_token_or_reason_in_any_log",
      privateMarkers.every((m) => typeof m === "string" && m.length > 8 && !logged.includes(m)) &&
        !logged.includes(reason) &&
        consoleLines.some((l) => l.includes('"event":"morrow_connections"')),
    );
    check(
      "O2:only_the_oracles_shops_were_called",
      outbound.unexpected.length === 0 &&
        Object.values(stores).every((s) => s.oracle.state.calls.every((c) => c.host === s.shop)),
      outbound,
    );
    return { checks, failures };
  },
  { stopBefore: identityRow.sequence },
);

console.log = print;
writeArtifact("labs/disconnect-store.json", {
  task: "v1 PR 2: Disconnect store",
  qualification: "local_postgresql17_network_none_disconnect_store",
  observedAt: new Date().toISOString(),
  durationMs: Date.now() - labStarted,
  administrator: "superuser",
  sourceDigests,
  checks: report.checks,
  providerRequests: 0,
  limitations: [
    "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data. Shopify is the synthetic oracle (scripts/fixtures/shopify-oracle.mjs).",
    "The connections, catalogue and connector handlers run in Node over psql bridges logged in as each login, not in workerd over the Neon transport.",
    "The store installations, v1 store-link grants, app secrets and sealed tokens are owner-seeded (lab:shopify-install proves the install and link that write them). The migrations of this PR run as the harness's superuser shape (SET ROLE to each executeAs), after the seeding.",
    "The run and operation leases are refused by lease_open before any row is written, so no Listings installation or operation is seeded; lab:listings-runs proves the run steps' own stop checks, and the gateway's claim and dispatch (v1 PR 3) must recheck the same stop.",
  ],
});
if (report.failures.length) {
  print("FAILED: " + report.failures.join(", "));
  process.exitCode = 1;
} else print(`PASS: ${report.checks.length} disconnect-store checks.`);
