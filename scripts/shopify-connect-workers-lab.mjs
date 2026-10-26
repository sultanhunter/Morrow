// M2 PR-2 workerd laboratory (Miniflare 4): the Shopify install and link end to end over
// HTTP. The real connector, broker and api handler code runs inside workerd
// (scripts/fixtures/shopify-connect-worker.ts); its SQL crosses a service binding to an
// isolated network-none PostgreSQL 17 engine with the whole manifest applied by the
// Neon-shaped CREATEROLE administrator, as the connector's, the vault's and the linking
// login each; every outbound request goes to the synthetic Shopify oracle
// (scripts/fixtures/shopify-oracle.mjs) or is counted and refused. The app is registered
// with the owner script's own statement (scripts/shopify-app.mjs). Journey: launch,
// authorize redirect and state cookie, callback (vault row, installation, continuation),
// re-authorisation on relaunch, the fragment redirect, connections read, preview (the
// issuer), apply, status, store-link grants, launch of a linked store (no OAuth), and (M2
// PR-3) the webhook inbox: a bad signature is 401; a verified app/uninstalled is 200 once
// recorded, then applied in waitUntil (the installation ends, the connection stops, the
// token is destroyed); a redelivery is a duplicate; the cron's redrive finds nothing left.
// The shop-specific webhook subscriptions (docs/briefs/shopify-shop-specific-webhooks.md):
// after the install, in waitUntil, the broker's sync lists the store's subscriptions and
// creates app/uninstalled and app/scopes_update to the connector's own webhook path, leaving
// another app path's subscription alone, and records them for the credential version; after
// the re-authorisation it lists again and creates nothing (H checks).
// Synthetic data only; runs in the CI pg-work group.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { sealVaultRecord, createVaultKeyring, vaultBytesHex } from "../apps/broker/src/vault.ts";
import { shopifyStageKeys } from "../apps/broker/src/shopify-stage.ts";
import { literal, withWorkDatabase } from "../tests/tenant-conformance/harness.mjs";
import { shopifyIdToken } from "../tests/fixtures/shopify-live-shapes.mjs";
import { createShopifyOracle } from "./fixtures/shopify-oracle.mjs";
import { shopifyAppRegisterStatement } from "./shopify-app.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const checks = [];
const failures = [];
const started = Date.now();
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("SHOPIFY_CONNECT_WORKERS_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
  }
}
const packageVersion = (name) =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
if (packageVersion("miniflare") !== "4.20260730.0" || packageVersion("workerd") !== "1.20260730.1")
  throw Error("SHOPIFY_CONNECT_WORKERS_PINNED_RUNTIME_REQUIRED");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const migrations = [
  ".shopify-link-route-read.sql",
  ".shopify-install-identity.sql",
  ".shopify-vault-install.sql",
  ".shopify-privacy-identity.sql",
  ".shopify-privacy-work.sql",
  ".shopify-webhook-registrations-identity.sql",
  ".shopify-webhook-registrations-vault.sql",
].map((slug) => manifest.migrations.find((m) => m.file.endsWith(slug))?.file);
if (migrations.some((f) => !f)) throw Error("SHOPIFY_CONNECT_WORKERS_MIGRATIONS_REQUIRED");
const sourceDigests = Object.fromEntries(
  [
    "scripts/shopify-connect-workers-lab.mjs",
    "scripts/fixtures/shopify-connect-worker.ts",
    "scripts/fixtures/shopify-oracle.mjs",
    "scripts/shopify-app.mjs",
    "apps/shopify-connector/worker/connector.ts",
    "apps/shopify-connector/worker/database.ts",
    "apps/shopify-connector/worker/webhooks.ts",
    "apps/shopify-connector/worker/oauth-state.ts",
    "apps/broker/src/shopify-install.ts",
    "apps/broker/src/shopify-webhooks.ts",
    "apps/broker/src/shopify-stage.ts",
    "apps/broker/src/shopify.ts",
    "apps/broker/src/vault-database.ts",
    "packages/identity/src/shopify-link-issuer.ts",
    "packages/identity/src/standalone-store-linking.ts",
    "packages/policy/src/connection-authority.ts",
    ...migrations.map((f) => "migrations/" + f),
  ].map((p) => [p, sha(readFileSync(p))]),
);

const bundled = await build({
  entryPoints: ["scripts/fixtures/shopify-connect-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["node:*", "cloudflare:*"],
  metafile: true,
  logLevel: "silent",
});
const inputs = Object.keys(bundled.metafile.inputs);
for (const required of [
  "apps/shopify-connector/worker/connector.ts",
  "apps/broker/src/shopify-install.ts",
  "apps/broker/src/shopify-webhooks.ts",
  "apps/broker/src/vault-database.ts",
  "packages/identity/src/shopify-link-issuer.ts",
  "packages/policy/src/connection-authority.ts",
])
  check(
    "B1:bundle_includes_" + required.split("/").at(-1).replace(/\W/g, "_"),
    inputs.includes(required),
  );
check(
  "B2:no_runtime_schema_compiler",
  !inputs.some((p) => /ajv\/dist\/(compile|core|2020)/.test(p)),
);

const ids = { org: "org_connect", ws: "ws_connect", profile: "profile_connect" };
const people = {
  F: {
    principal: "person_connect_founder",
    membership: "membership_connect_founder",
    connect: true,
  },
  M: {
    principal: "person_connect_member",
    membership: "membership_connect_member",
    connect: false,
  },
};
const appKey = "lab-connect-1";
const clientId = randomBytes(16).toString("hex");
const appSecret = "shpss_" + randomBytes(16).toString("hex");
const shop = "lab-connect-dev.myshopify.com";
const kek = randomBytes(32).toString("hex");
const connectorOrigin = "https://connector.lab.example.test";
const apiOrigin = "https://workspace.lab.example.test";
const installUrl = `https://admin.shopify.com/oauth/install_custom_app?client_id=${clientId}&signature=lab`;
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-connect-lab",
  branchId: "br-connect-lab",
  hostname: "ep-connect-lab.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const vaultPassword = "lab-vault-" + randomBytes(12).toString("hex");
const leasePassword = "lab-lease-" + randomBytes(12).toString("hex");
const sessions = Object.fromEntries(
  Object.keys(people).map((key) => [key, randomBytes(32).toString("base64url")]),
);
const privateMarkers = [appSecret, kek, vaultPassword, leasePassword, ...Object.values(sessions)];
const connectGrant = (p, id) => {
  const actor = {
    kind: "human",
    principalId: p.principal,
    organizationId: ids.org,
    workspaceId: ids.ws,
    membershipId: p.membership,
    installationId: null,
    mandateId: null,
  };
  return {
    id,
    principal: actor,
    capabilityId: "governance.connection.connect",
    verbs: ["administer", "approve"],
    scope: {
      organizationId: ids.org,
      workspaceId: ids.ws,
      storeIds: [],
      accountIds: [],
      resources: [
        {
          organizationId: ids.org,
          workspaceId: ids.ws,
          storeId: null,
          connectionId: null,
          kind: "workspace",
          id: ids.ws,
        },
      ],
      fields: ["providerId", "installationProof", "scope"],
    },
    issuedBy: { ...actor, kind: "service", principalId: "morrow.onboarding", membershipId: null },
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  };
};

await withWorkDatabase(
  "M2PR2.shopify-connect-workers",
  async (db) => {
    // ---- fixtures (superuser or owner roles; the journey itself runs as the logins).
    db.sql("ALTER ROLE morrow_identity_linking LOGIN;");
    const statements = [
      `INSERT INTO morrow_identity.organizations VALUES(${literal(ids.org)},'Lab connect',true,1);`,
      `INSERT INTO morrow_identity.workspaces VALUES(${literal(ids.ws)},${literal(ids.org)},'Connect',true);`,
      `INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES(${literal(ids.profile)},'workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');`,
    ];
    for (const [key, p] of Object.entries(people)) {
      statements.push(
        `INSERT INTO morrow_identity.principals VALUES(${literal(p.principal)},'human',true);`,
        `INSERT INTO morrow_identity.memberships VALUES(${literal(p.membership)},${literal(ids.org)},${literal(p.principal)},true);`,
        `INSERT INTO morrow_identity.sessions VALUES(${literal("session_connect_" + key)},${literal(p.principal)},${literal(ids.org)},${literal(sha(sessions[key]))},'workos',${literal("provider_connect_" + key)},clock_timestamp()+interval '1 day',NULL);`,
        `INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(ids.org)},${literal(ids.ws)},${literal(p.membership)},true);`,
      );
      if (p.connect) {
        const grant = connectGrant(p, "grant_connect_" + key);
        statements.push(
          `INSERT INTO morrow_identity.grants VALUES(${literal(grant.id)},${literal(ids.org)},${literal(ids.ws)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(grant))}::jsonb);`,
        );
      }
    }
    // The founder's website signup (0021 records the unfixed route), then the route fixed
    // to morrow_direct (superuser fixture: M5's Stripe receipt is the real writer).
    statements.push(
      `INSERT INTO morrow_identity.organization_signups VALUES(${literal(people.F.principal)},${literal(randomUUID())},${literal("b".repeat(64))},${literal(ids.profile)},${literal(ids.org)},${literal(ids.ws)},${literal(people.F.membership)},'owner-bootstrap-v1',clock_timestamp());`,
    );
    db.admin(statements.join("\n"));
    db.workOwner(
      `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=date_trunc('milliseconds',clock_timestamp()),fixing_payment_key='stripe:invoice:in_lab00000009',revision=2,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE workspace_id=${literal(ids.ws)};`,
    );
    // The owner's registration, through the owner script's own statement.
    const statement = shopifyAppRegisterStatement({
      environment: "development",
      "app-key": appKey,
      "client-id": clientId,
      shop,
      organization: ids.org,
      workspace: ids.ws,
      "install-url": installUrl,
    });
    const inlined = statement.text.replace(/\$(\d)/g, (_, n) => literal(statement.values[n - 1]));
    const registered = db.rows(inlined, { role: statement.executeAs })[0]?.outcome;
    const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
    const envelope = await sealVaultRecord(
      keyring,
      { kind: "app_secret", appKey, provider: "shopify", version: 1 },
      new TextEncoder().encode(appSecret),
    );
    const stored = db.rows(
      `SELECT outcome FROM morrow_vault.app_secret_put(${literal(appKey)},'1',${literal(vaultBytesHex(envelope.wrappedKey))},${literal(vaultBytesHex(envelope.sealedValue))})`,
      { role: "morrow_work_owner" },
    )[0]?.outcome;
    check(
      "S1:the_owner_statement_registers_the_app_and_its_secret_is_stored",
      registered === statement.expectedOutcome && stored === "stored",
    );

    // ---- the SQL bridge: one psql connection per workerd connection, as the named login.
    const allowedUsers = [
      "morrow_connector_ingress",
      "morrow_vault_broker",
      "morrow_identity_linking",
    ];
    const connections = new Map();
    const sqlCalls = { open: {}, query: 0 };
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    async function sqlBinding(request) {
      const message = await request.json();
      try {
        if (message.op === "open") {
          if (!allowedUsers.includes(message.user)) return json({ error: true }, 403);
          sqlCalls.open[message.user] = (sqlCalls.open[message.user] ?? 0) + 1;
          const connection = await db.connector({ user: message.user }).open({
            signal: new AbortController().signal,
            deadlineMs: Date.now() + 60000,
            waitUntil() {},
          });
          const id = randomUUID();
          connections.set(id, connection);
          return json({ id });
        }
        const connection = connections.get(message.id);
        if (!connection) return json({ error: true }, 400);
        if (message.op === "query") {
          sqlCalls.query++;
          const reply = await connection.query(
            message.text,
            message.values,
            new AbortController().signal,
          );
          return json({ rows: reply.rows });
        }
        if (message.op === "close") {
          connections.delete(message.id);
          await connection.close();
          return json({ closed: true });
        }
        return json({ error: true }, 400);
      } catch {
        return json({ error: true }, 503);
      }
    }
    const oracle = createShopifyOracle({ secret: appSecret, clientId, shop, shopId: "4242424242" });
    // Another app path's subscription already on the store: never Morrow's, never touched.
    const foreignSubscription = {
      id: "6001",
      topic: "APP_UNINSTALLED",
      uri: "https://elsewhere.example.test/shopify/webhooks",
    };
    oracle.state.subscriptions.push({ ...foreignSubscription });
    const webhookPath = `${connectorOrigin}/shopify/a/${appKey}/webhooks`;
    const outbound = { shopify: 0, unexpected: [] };
    const logs = [];
    const mf = new Miniflare({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"],
      bindings: {
        MORROW_ENVIRONMENT: "development",
        MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
        MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: vaultPassword,
        MORROW_VAULT_KEK_V1: kek,
        // The broker's copy of the connector's configuration: each subscription's URL.
        CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
          schemaVersion: 1,
          origin: connectorOrigin,
          apiOrigin,
        }),
        LAB_CONNECTOR_ORIGIN: connectorOrigin,
        LAB_API_ORIGIN: apiOrigin,
        LAB_LEASE_PASSWORD: leasePassword,
      },
      serviceBindings: { SQL: sqlBinding },
      async outboundService(request) {
        const url = new URL(request.url);
        if (url.host === shop) {
          outbound.shopify++;
          const body = request.method === "GET" ? undefined : await request.text();
          return oracle.fetch(request.url, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body,
          });
        }
        outbound.unexpected.push(url.host);
        return new Response(null, { status: 502 });
      },
      log: new Log(LogLevel.NONE),
      handleRuntimeStdio(stdout, stderr) {
        stdout.on("data", (chunk) => logs.push(String(chunk)));
        stderr.on("data", (chunk) => logs.push(String(chunk)));
      },
    });
    try {
      await mf.ready;
      // The exact request is built inside workerd from this closed description, and the
      // response comes back described too (a redirect is never followed).
      async function send(url, { method = "GET", headers = {}, body = null } = {}) {
        const response = await mf.dispatchFetch("http://lab.invalid/__lab/request", {
          method: "POST",
          body: JSON.stringify({ method, url, headers, body }),
        });
        const described = await response.json();
        let parsed = null;
        try {
          parsed = JSON.parse(described.body);
        } catch {}
        return {
          status: described.status,
          location: described.location,
          cookies: described.cookies,
          text: described.body,
          body: parsed,
        };
      }
      const connector = (route, query, headers) =>
        send(`${connectorOrigin}/shopify/a/${appKey}/${route}?${query}`, { headers });
      const asBrowser = (who) => ({
        Cookie: "__Host-morrow_session=" + sessions[who],
        "Sec-Fetch-Site": "same-origin",
      });
      const linkPost = (who, route, token, key, csrf = null) =>
        send(`${apiOrigin}/workspace/${ids.ws}/${route}`, {
          method: "POST",
          headers: {
            ...asBrowser(who),
            Origin: apiOrigin,
            "Content-Type": "application/json",
            "X-Morrow-Request": "1",
            "Idempotency-Key": key,
            ...(csrf ? { "X-Morrow-CSRF": csrf } : {}),
          },
          body: JSON.stringify({ handoffToken: token }),
        });
      const connectionsOf = (who) =>
        send(`${apiOrigin}/workspace/${ids.ws}/connections`, { headers: asBrowser(who) });
      const owner = (query) => db.rows(query, { role: "morrow_identity_owner" });
      const vaultRows = () =>
        db.rows(
          `SELECT version::int,status,wrapped_key IS NULL AS erased FROM morrow_vault.credentials ORDER BY version`,
          { role: "morrow_work_owner" },
        );
      const exchanges = () =>
        oracle.state.calls.filter((c) => c.path === "/admin/oauth/access_token").length;
      const stateCookie = (cookies) =>
        /^__Host-morrow_shopify_state=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/.exec(
          cookies.find((c) => c.startsWith("__Host-morrow_shopify_state=")) ?? "",
        )?.[1];

      // ---- E: launch, authorize redirect and the state cookie.
      const install = async () => {
        const launch = await connector("launch", oracle.launchQuery());
        const state = stateCookie(launch.cookies);
        const authorize = launch.location ? new URL(launch.location) : null;
        const callbackQuery = state ? oracle.callbackQuery(state) : null;
        return { launch, state, authorize, callbackQuery };
      };
      const first = await install();
      check(
        "E1:launch_redirects_to_the_verified_shops_authorize_url_with_a_state_cookie",
        first.launch.status === 302 &&
          first.authorize?.origin === `https://${shop}` &&
          first.authorize.pathname === "/admin/oauth/authorize" &&
          [...first.authorize.searchParams.keys()].join(",") ===
            "client_id,scope,redirect_uri,state" &&
          first.authorize.searchParams.get("client_id") === clientId &&
          first.authorize.searchParams.get("scope") === "read_products,write_products" &&
          first.authorize.searchParams.get("redirect_uri") ===
            `${connectorOrigin}/shopify/a/${appKey}/callback` &&
          first.authorize.searchParams.get("state") === first.state &&
          owner("SELECT count(*)::int AS n FROM morrow_identity.shopify_oauth_states")[0].n === 1,
        { status: first.launch.status, location: first.launch.location?.slice(0, 60) },
      );
      privateMarkers.push(first.state);
      const noCookie = await connector("callback", first.callbackQuery, asBrowser("F"));
      check(
        "E2:a_callback_without_the_state_cookie_reaches_no_broker",
        noCookie.status === 403 &&
          exchanges() === 0 &&
          owner(
            "SELECT count(*)::int AS n FROM morrow_identity.shopify_oauth_states WHERE claimed_at IS NOT NULL",
          )[0].n === 0,
      );
      const withCookie = { Cookie: `__Host-morrow_shopify_state=${first.state}` };
      const callback = await connector("callback", first.callbackQuery, withCookie);
      const landing = callback.location ? new URL(callback.location) : null;
      const token = /^#handoff=([A-Za-z0-9_-]{43})$/.exec(landing?.hash ?? "")?.[1];
      privateMarkers.push(token);
      const installation = owner(
        "SELECT id::text,status,credential_version::int AS version,development_store FROM morrow_identity.store_installations",
      );
      check(
        "E3:callback_stores_v1_and_lands_on_the_connections_screen_with_the_continuation",
        callback.status === 303 &&
          landing?.origin === apiOrigin &&
          landing.pathname === `/w/${ids.ws}/connections` &&
          landing.search === "" &&
          typeof token === "string" &&
          callback.cookies.some((c) => c.startsWith("__Host-morrow_shopify_state=;")) &&
          installation.length === 1 &&
          installation[0].status === "unlinked" &&
          installation[0].development_store === true &&
          JSON.stringify(vaultRows()) === '[{"version":1,"status":"active","erased":false}]' &&
          owner(
            `SELECT count(*)::int AS n FROM morrow_identity.install_continuations WHERE token_digest=${literal(sha(token ?? ""))}`,
          )[0].n === 1 &&
          exchanges() === 1,
        { status: callback.status, installation },
      );
      // ---- H: the shop-specific webhook subscriptions, after the install's response.
      const registrations = () =>
        owner(
          "SELECT organization_id::text AS org,workspace_id::text AS ws,installation_id::text AS installation,credential_version::int AS version,status,uninstalled_subscription_id AS uninstalled,scopes_update_subscription_id AS scopes,attempts,revision::int AS revision FROM morrow_identity.shopify_webhook_registrations",
        );
      const creates = () =>
        oracle.state.calls.filter((c) => c.operation === "WebhookSubscriptionCreate");
      const morrowSubscriptions = () =>
        oracle.state.subscriptions.filter((w) => w.uri === webhookPath);
      const afterInstall = registrations();
      check(
        "H1:the_install_registers_both_shop_specific_subscriptions_to_the_connectors_path",
        morrowSubscriptions().length === 2 &&
          JSON.stringify(morrowSubscriptions().map((w) => w.topic)) ===
            '["APP_UNINSTALLED","APP_SCOPES_UPDATE"]' &&
          creates().length === 2 &&
          creates().every(
            (c) =>
              JSON.stringify(Object.keys(c.variables)) === '["topic","uri"]' &&
              c.variables.uri === webhookPath,
          ) &&
          JSON.stringify(oracle.state.subscriptions[0]) === JSON.stringify(foreignSubscription) &&
          oracle.state.subscriptions.length === 3 &&
          afterInstall.length === 1 &&
          afterInstall[0].org === ids.org &&
          afterInstall[0].ws === ids.ws &&
          afterInstall[0].installation === installation[0]?.id &&
          afterInstall[0].version === 1 &&
          afterInstall[0].status === "registered" &&
          afterInstall[0].uninstalled === morrowSubscriptions()[0].id &&
          afterInstall[0].scopes === morrowSubscriptions()[1].id &&
          afterInstall[0].attempts === 0,
        { subscriptions: oracle.state.subscriptions, afterInstall, creates: creates().length },
      );
      const replay = await connector("callback", first.callbackQuery, withCookie);
      check(
        "E4:a_replayed_callback_is_refused_before_any_exchange",
        replay.status === 400 && exchanges() === 1,
      );
      // A relaunch of the unlinked store re-authorises: v2, v1 erased, a fresh continuation.
      const second = await install();
      privateMarkers.push(second.state);
      const reauthorised = await connector("callback", second.callbackQuery, {
        Cookie: `__Host-morrow_shopify_state=${second.state}`,
      });
      const token2 = /^#handoff=([A-Za-z0-9_-]{43})$/.exec(
        reauthorised.location ? new URL(reauthorised.location).hash : "",
      )?.[1];
      privateMarkers.push(token2);
      check(
        "E5:a_relaunch_reauthorises_with_v2_and_supersedes_the_continuation",
        second.launch.status === 302 &&
          reauthorised.status === 303 &&
          typeof token2 === "string" &&
          token2 !== token &&
          owner("SELECT count(*)::int AS n FROM morrow_identity.store_installations")[0].n === 1 &&
          JSON.stringify(vaultRows()) ===
            '[{"version":1,"status":"destroyed","erased":true},{"version":2,"status":"active","erased":false}]' &&
          owner(
            `SELECT superseded_at IS NOT NULL AS superseded FROM morrow_identity.install_continuations WHERE token_digest=${literal(sha(token ?? ""))}`,
          )[0]?.superseded === true,
        {
          launch: second.launch.status,
          callback: reauthorised.status,
          title: /<title>([^<]*)<\/title>/.exec(reauthorised.text ?? "")?.[1],
          vault: vaultRows(),
        },
      );

      // The re-authorisation's new token lists the subscriptions again and creates nothing.
      const afterReauthorise = registrations();
      check(
        "H2:a_reauthorisation_lists_again_creates_nothing_and_records_the_new_version",
        creates().length === 2 &&
          morrowSubscriptions().length === 2 &&
          oracle.state.subscriptions.length === 3 &&
          oracle.state.calls.filter((c) => c.operation === "WebhookSubscriptions").length === 2 &&
          afterReauthorise.length === 1 &&
          afterReauthorise[0].version === 2 &&
          afterReauthorise[0].status === "registered" &&
          afterReauthorise[0].revision === 2 &&
          afterReauthorise[0].uninstalled === afterInstall[0]?.uninstalled,
        { afterReauthorise, calls: oracle.state.calls.map((c) => c.operation ?? c.path) },
      );

      // ---- L: connections read, preview (issuer), apply and status over the api guard.
      const before = await connectionsOf("F");
      check(
        "L1:the_owner_reads_the_unlinked_store_and_is_offered_the_install_link",
        before.status === 200 &&
          before.body.installations.length === 1 &&
          before.body.installations[0].status === "unlinked" &&
          before.body.installations[0].shopDomain === shop &&
          JSON.stringify(before.body.installations[0].grantedScopes) ===
            '["read_products","write_products"]' &&
          before.body.installLink.offered === true &&
          before.body.installLink.url === installUrl,
      );
      const memberRead = await connectionsOf("M");
      check(
        "L2:a_member_without_connect_reads_status_but_no_install_link",
        memberRead.status === 200 &&
          memberRead.body.installations.length === 1 &&
          memberRead.body.installLink.reason === "not_permitted" &&
          memberRead.body.installLink.url === null,
      );
      const stale = await linkPost("F", "store-links/preview", token, randomUUID());
      const memberPreview = await linkPost("M", "store-links/preview", token2, randomUUID());
      check(
        "L3:a_superseded_continuation_and_a_member_without_the_grant_get_nothing",
        stale.status === 404 &&
          stale.body?.code === "linking_not_found" &&
          memberPreview.status === 404 &&
          owner(
            `SELECT consumed_at IS NULL AS open FROM morrow_identity.install_continuations WHERE token_digest=${literal(sha(token2 ?? ""))}`,
          )[0]?.open === true,
      );
      const key = randomUUID();
      const preview = await linkPost("F", "store-links/preview", token2, key);
      const csrf = preview.body?.csrfToken;
      privateMarkers.push(csrf);
      check(
        "L4:preview_issues_the_handoff_and_answers_the_csrf_value",
        preview.status === 200 &&
          preview.body.link.installationId === installation[0].id &&
          preview.body.link.purpose === "workspace_first" &&
          /^[A-Za-z0-9_-]{43}$/.test(csrf ?? ""),
        { status: preview.status, code: preview.body?.code ?? preview.body?.outcome ?? null },
      );
      const forged = await linkPost("F", "store-links", token2, key, "A".repeat(43));
      const applied = await linkPost("F", "store-links", token2, key, csrf);
      const status = await linkPost("F", "store-links/status", token2, key);
      const replayed = await linkPost("F", "store-links", token2, key, csrf);
      check(
        "L5:apply_needs_the_csrf_value_links_once_and_status_confirms",
        forged.status === 403 &&
          applied.status === 200 &&
          applied.body.outcome === "applied" &&
          status.status === 200 &&
          status.body.outcome === "applied" &&
          status.body.linkId === applied.body.linkId &&
          replayed.status === 200 &&
          replayed.body.linkId === applied.body.linkId &&
          owner("SELECT count(*)::int AS n FROM morrow_identity.workspace_store_links")[0].n === 1,
        { forged: forged.status, applied: applied.status, status: status.status },
      );
      const grants = owner(
        `SELECT payload->>'capabilityId' AS capability,payload->'verbs' AS verbs,payload#>'{scope,resources,0}' AS resource,payload#>'{scope,storeIds}' AS stores,principal_id::text AS principal FROM morrow_identity.grants WHERE payload#>>'{issuedBy,principalId}'='morrow.linking' ORDER BY 1`,
      );
      const linked = owner(
        "SELECT status,store_id::text AS store,connection_id::text AS connection,link_id::text AS link FROM morrow_identity.store_installations",
      )[0];
      check(
        "L6:the_link_issues_exactly_the_store_link_grants_to_the_linking_owner",
        JSON.stringify(grants.map((g) => [g.capability, g.verbs])) ===
          JSON.stringify([
            ["agents.installation.activate", ["execute"]],
            ["catalog.content.propose", ["execute", "delegate"]],
            ["catalog.content.publish", ["propose", "approve", "execute", "delegate"]],
            ["catalog.products.read", ["view", "delegate"]],
            // Store-link template v2 ("Disconnect store", the ADR-0022 item 3 amendment).
            ["governance.connection.disconnect", ["execute"]],
          ]) &&
          grants.every(
            (g) =>
              g.principal === people.F.principal &&
              g.resource.kind === "store" &&
              g.resource.id === linked.store &&
              g.resource.storeId === linked.store &&
              g.resource.connectionId === linked.connection &&
              JSON.stringify(g.stores) === JSON.stringify([linked.store]),
          ) &&
          linked.status === "linked" &&
          linked.link === applied.body.linkId,
        { grants: grants.length, linked },
      );
      const after = await connectionsOf("F");
      check(
        "L7:connections_show_the_linked_store_and_no_install_link",
        after.status === 200 &&
          after.body.installations[0].status === "linked" &&
          after.body.installLink.reason === "linked" &&
          after.body.installLink.url === null,
      );

      // ---- R: a linked store's launch needs no OAuth; status shows the same page.
      const statesBefore = owner(
        "SELECT count(*)::int AS n FROM morrow_identity.shopify_oauth_states",
      )[0].n;
      const relaunch = await connector("launch", oracle.launchQuery());
      const statusPage = await connector("status", oracle.launchQuery());
      check(
        "R1:a_linked_store_launch_shows_status_with_no_oauth",
        relaunch.status === 200 &&
          relaunch.location === null &&
          relaunch.cookies.length === 0 &&
          statusPage.status === 200 &&
          owner("SELECT count(*)::int AS n FROM morrow_identity.shopify_oauth_states")[0].n ===
            statesBefore &&
          relaunch.text.includes(`${apiOrigin}/w/${ids.ws}/connections`) &&
          !relaunch.text.includes("#handoff"),
      );
      // fix-shopify-install-live: the admin's app-open launch of the installed app, with an
      // embedded app's keys (embedded, id_token, locale, session) beside host, shop and
      // timestamp: signed data, verified like any launch, through the deployed handlers.
      const appOpen = await connector(
        "launch",
        oracle.launchQuery({
          embedded: "1",
          id_token: shopifyIdToken(shop, clientId, Math.trunc(Date.now() / 1000)),
          locale: "en-GB",
          session: randomBytes(32).toString("hex"),
        }),
      );
      check(
        "R2:an_admin_app_open_launch_with_embedded_keys_shows_status_with_no_oauth",
        appOpen.status === 200 &&
          appOpen.location === null &&
          appOpen.cookies.length === 0 &&
          owner("SELECT count(*)::int AS n FROM morrow_identity.shopify_oauth_states")[0].n ===
            statesBefore &&
          appOpen.text.includes(`${apiOrigin}/w/${ids.ws}/connections`),
        { status: appOpen.status },
      );

      // ---- W: the M2 PR-3 webhook inbox, in workerd.
      const uninstall = oracle.webhook("app/uninstalled", {
        id: 4242424242,
        name: "Lab",
        myshopify_domain: shop,
      });
      const forgedHook = oracle.webhook("app/uninstalled", { id: 4242424242 }, { secret: "wrong" });
      const webhook = (hook) =>
        send(`${connectorOrigin}/shopify/a/${appKey}/webhooks`, {
          method: "POST",
          headers: { "content-type": "application/json", ...hook.headers },
          body: hook.body,
        });
      const inbox = () =>
        owner(
          "SELECT status,outcome,body,effects FROM morrow_identity.shopify_webhook_inbox ORDER BY received_at",
        );
      const refused = await webhook(forgedHook);
      check(
        "W1:a_bad_hmac_is_401_and_records_nothing",
        refused.status === 401 &&
          inbox().length === 0 &&
          owner("SELECT status FROM morrow_identity.store_installations")[0].status === "linked",
      );
      const verified = await webhook(uninstall);
      const ended = owner(
        "SELECT status,store_id::text AS store,connection_id::text AS connection,credential_destroyed_at IS NOT NULL AS destroyed FROM morrow_identity.store_installations",
      )[0];
      const stops = db.rows(
        "SELECT scope,store_id::text AS store,target_id::text AS target,reason_code,set_by_kind FROM morrow_work.stop_controls",
        { role: "morrow_work_owner" },
      );
      check(
        "W2:a_verified_uninstall_is_200_once_recorded_then_applied_in_wait_until",
        verified.status === 200 &&
          verified.text === JSON.stringify({ schemaVersion: 1, received: true }) &&
          inbox().length === 1 &&
          inbox()[0].status === "applied" &&
          inbox()[0].outcome === "uninstalled" &&
          JSON.stringify(inbox()[0].body) === JSON.stringify({ shopId: "4242424242" }) &&
          ended.status === "uninstalled" &&
          ended.destroyed === true &&
          JSON.stringify(vaultRows()) ===
            '[{"version":1,"status":"destroyed","erased":true},{"version":2,"status":"destroyed","erased":true}]' &&
          stops.length === 1 &&
          stops[0].scope === "connection" &&
          stops[0].store === ended.store &&
          stops[0].target === ended.connection &&
          stops[0].reason_code === "shopify_app_uninstalled" &&
          stops[0].set_by_kind === "system",
        { status: verified.status, inbox: inbox(), ended, stops, vault: vaultRows() },
      );
      const redelivered = await webhook(uninstall);
      const describedRedrive = await mf.dispatchFetch("http://lab.invalid/__lab/request", {
        method: "POST",
        body: JSON.stringify({ method: "POST", url: "lab:redrive", headers: {}, body: null }),
      });
      const redrive = JSON.parse((await describedRedrive.json()).body);
      check(
        "W3:a_redelivery_is_a_duplicate_and_the_cron_finds_nothing_left",
        redelivered.status === 200 &&
          inbox().length === 1 &&
          JSON.stringify(redrive) ===
            JSON.stringify({
              inbox: 0,
              applied: 0,
              credentials: 0,
              destroyed: 0,
              targetMissed: 0,
              dueMissed: 0,
              subscriptionsChecked: 0,
              subscriptionsRegistered: 0,
              unavailable: 0,
              // v1 PR 5: the open Reconnect items (none: the uninstall cleared none), and,
              // with the clean-up switch off here, no read-back, deletion or stuck count.
              notices: 0,
              reconciled: 0,
              checks: 0,
              observed: 0,
              refused: 0,
              deletions: 0,
              deleted: 0,
              stuckClosed: 0,
              stuck: 0,
            }),
        {
          redelivered: redelivered.status,
          redrive,
          // fix-connector-cron-latency: each failed step's closed stage line, if any.
          stages: logs
            .join("")
            .split("\n")
            .filter((line) =>
              /"event":"morrow_(connector_(cron|privacy|webhooks|inbox|credential)|broker)"/.test(
                line,
              ),
            )
            .slice(-12),
        },
      );

      // ---- O: logins, outbound and logs.
      check(
        "O1:each_transport_used_its_own_login",
        sqlCalls.open.morrow_connector_ingress >= 2 &&
          sqlCalls.open.morrow_vault_broker >= 4 &&
          sqlCalls.open.morrow_identity_linking >= 4,
        sqlCalls.open,
      );
      check(
        "O2:zero_unoracled_outbound_requests",
        outbound.unexpected.length === 0 &&
          outbound.shopify === oracle.state.calls.length &&
          oracle.state.calls.every((c) => c.host === shop),
        outbound,
      );
      privateMarkers.push(...oracle.state.tokens);
      const logged = logs.join("");
      check(
        "O3:no_secret_token_or_continuation_in_worker_logs",
        privateMarkers.every((marker) => typeof marker === "string" && !logged.includes(marker)),
      );
      // fix-shopify-install-live: the broker's stage lines in workerd's own output. The
      // replayed callback (E4) logged one, naming its claim; every line holds exactly the
      // allow-listed keys and no shop, app key or long hex or base64url run.
      const stageLines = logged
        .split("\n")
        .filter((line) => line.includes('"event":"morrow_broker_shopify_stage"'))
        .map((line) => {
          try {
            return JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1));
          } catch {
            return null;
          }
        });
      check(
        "O4:failed_installs_log_one_closed_stage_line",
        stageLines.length >= 1 &&
          stageLines.every(
            (line) => line !== null && Object.keys(line).join(",") === shopifyStageKeys.join(","),
          ) &&
          stageLines.some(
            (line) =>
              line?.method === "shopifyInstallComplete" &&
              line.stage === "claim" &&
              line.result === "state_invalid" &&
              line.reason === "claim_replayed" &&
              // The claim's transaction committed; the transport observed it in workerd.
              line.vaultPhase === "done" &&
              line.vaultCause === null &&
              line.statements === 8 &&
              line.vault === null,
          ) &&
          stageLines.every((line) => {
            const text = JSON.stringify(line);
            return (
              !text.includes(shop) &&
              !text.includes(appKey) &&
              !/myshopify|shpat_|[a-f0-9]{32,}|[A-Za-z0-9_-]{40,}/i.test(text)
            );
          }),
        { lines: stageLines.length, stages: stageLines.map((l) => l?.stage ?? null) },
      );
    } finally {
      await mf.dispose();
      for (const connection of connections.values()) await connection.close().catch(() => {});
    }
  },
  { administrator: "createrole" },
);

writeArtifact("shopify-connect-workers-lab/report.json", {
  scope:
    "M2 PR-2 Shopify install and link end to end in workerd over PostgreSQL 17 (synthetic Shopify oracle; no provider effect)",
  sourceDigests,
  checks,
  failures,
  seconds: Math.round((Date.now() - started) / 1000),
});
console.log(JSON.stringify({ checks: checks.length, failures }));
if (failures.length) process.exit(1);
