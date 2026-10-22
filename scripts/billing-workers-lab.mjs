// M5 PR-1 workerd laboratory (lab:billing-workers, Miniflare 4, pg-work): the Morrow-direct
// Stripe route end to end over HTTP, with the api and the broker as two workerd Workers
// joined by a real service binding to the broker's ApiBroker entrypoint
// (scripts/fixtures/billing-api-worker.ts). The api runs the api Worker's dispatch with the
// billing API and the Stripe webhook as deployed-worker.ts composes them, and calls the
// broker through createBrokerStripe (the RPC codecs). The broker runs the real Stripe
// handlers (apps/broker/src/stripe.ts) with its own capabilities from its bindings and the
// vault login's real transport (M2 PR-2's runVaultTransactionWithDriver: BEGIN, the D5 role
// preflight, the timeouts, the registry, COMMIT). Each Worker's SQL crosses its own service
// binding to an isolated network-none PostgreSQL 17 engine with the whole manifest applied
// by the Neon-shaped CREATEROLE administrator: the api's as morrow_api_worker only, the
// broker's as morrow_vault_broker only. The broker's only outbound origin is the fake
// Stripe (scripts/fixtures/stripe-fake.mjs); every other request, and any from the api, is
// counted and refused, so no real Stripe call is possible.
//   C  the billing view and checkout: the customer and the session through the RPC binding
//      and the vault login, the Stripe-hosted URL, and an Idempotency-Key replay;
//   W  webhooks signed by the fake: a bad signature is 400 with no row; a held broker (its
//      vault login refused) is 503 with no row and the retry applies the route, the
//      account, the wallet and the grant, 200 only after the commit; a redelivery changes
//      nothing; a lost commit acknowledgement is read back before the 200;
//   P  the portal through the saved configuration;
//   D  the dispatch rows of the api Worker: the webhook's exact path and method, the
//      unbound work family;
//   O  zero unexpected outbound requests, and no secret or session in any log or SQL.
// Synthetic owner-seeded fixtures only; the D5 preflight runs against the real roles.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import {
  fixtureGrant,
  grantInsert,
  literal,
  withWorkDatabase,
  workFixtureOrigin,
} from "../tests/tenant-conformance/harness.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import {
  createStripeFake,
  fakeStripeKey,
  fakeStripeWebhookSecret,
} from "./fixtures/stripe-fake.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const checks = [];
const failures = [];
const started = Date.now();
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("BILLING_WORKERS_LAB_CHECK_NAME:" + name);
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
  throw Error("BILLING_WORKERS_PINNED_RUNTIME_REQUIRED");
// Migrations are found by slug (integration renumbering rule), never by number.
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const migrations = [
  ".shopify-install-identity.sql",
  ".shopify-vault-install.sql",
  ".billing-identity-bridge.sql",
  ".billing-records.sql",
].map((slug) => manifest.migrations.find((m) => m.file.endsWith(slug))?.file);
if (migrations.some((f) => !f)) throw Error("BILLING_WORKERS_MIGRATIONS_REQUIRED");
const sourceDigests = Object.fromEntries(
  [
    "scripts/billing-workers-lab.mjs",
    "scripts/fixtures/billing-api-worker.ts",
    "scripts/fixtures/stripe-fake.mjs",
    "apps/api/src/worker.ts",
    "apps/api/src/broker-client.ts",
    "apps/broker/src/stripe.ts",
    "apps/broker/src/stripe-broker.ts",
    "apps/broker/src/vault-database.ts",
    "apps/broker/src/vault-statements-billing.ts",
    "packages/work/src/billing/http.ts",
    "packages/work/src/billing/webhook.ts",
    "packages/work/src/billing/commands.ts",
    ...migrations.map((f) => "migrations/" + f),
  ].map((p) => [p, sha(readFileSync(p))]),
);

const bundled = await build({
  entryPoints: ["scripts/fixtures/billing-api-worker.ts"],
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
  "apps/api/src/worker.ts",
  "apps/api/src/broker-client.ts",
  "apps/broker/src/stripe.ts",
  "apps/broker/src/stripe-broker.ts",
  "apps/broker/src/vault-database.ts",
  "packages/work/src/billing/http.ts",
  "packages/work/src/billing/webhook.ts",
])
  check(
    "B1:bundle_includes_" + required.replace(/\W/g, "_").toLowerCase(),
    inputs.includes(required),
  );
check(
  "B2:no_runtime_schema_compiler",
  !inputs.some((p) => /ajv\/dist\/(compile|core|2020)/.test(p)),
);

const origin = workFixtureOrigin;
const terms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8")).environments
  .development[0];
const PRICE = terms.terms.entries[0].priceKey;
const nowS = Math.floor(Date.now() / 1000);
const periodNow = { start: nowS - 3600, end: nowS + 30 * 86400 };
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-billing-lab",
  branchId: "br-billing-lab",
  hostname: "ep-billing-lab.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const portalConfigurationId = "bpc_" + "LabWorkersPortal".padEnd(24, "0");
const vaultPassword = "lab-vault-" + randomBytes(12).toString("hex");
const kek = randomBytes(32).toString("hex");
const login = JSON.parse(createPlatformWorkosProviderOracle({ origin }).configurationJson);
const people = ["billing_wa", "billing_wb"].map((key) => {
  const secret = randomBytes(32).toString("base64url");
  return {
    key,
    principal: "person_" + key,
    membership: "membership_" + key,
    org: "org_" + key,
    workspace: "ws_" + key,
    secret,
    digest: sha(secret),
  };
});
const privateMarkers = [
  fakeStripeKey,
  fakeStripeWebhookSecret,
  vaultPassword,
  kek,
  ...people.map((p) => p.secret),
];

await withWorkDatabase(
  "M5PR1.billing-workers",
  async (db) => {
    // ---- fixtures (owner roles): tenants with a session and the billing grant, their
    // website routes (unfixed), and the development terms.
    for (const p of people) {
      const grant = fixtureGrant(
        p,
        "governance.billing.manage",
        ["view", "execute"],
        ["action", "priceKey"],
      );
      db.admin(`INSERT INTO morrow_identity.organizations VALUES(${literal(p.org)},'Synthetic',true,1);
INSERT INTO morrow_identity.workspaces VALUES(${literal(p.workspace)},${literal(p.org)},'Synthetic',true);
INSERT INTO morrow_identity.principals VALUES(${literal(p.principal)},'human',true);
INSERT INTO morrow_identity.memberships VALUES(${literal(p.membership)},${literal(p.org)},${literal(p.principal)},true);
INSERT INTO morrow_identity.sessions VALUES(${literal("session_" + p.key)},${literal(p.principal)},${literal(p.org)},${literal(p.digest)},'workos',${literal("provider_session_" + p.key)},clock_timestamp()+interval '1 day',NULL);
INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(p.org)},${literal(p.workspace)},${literal(p.membership)},true);
${grantInsert(p, grant)}`);
      db.workOwner(
        `INSERT INTO morrow_billing.workspace_billing_routes VALUES(${literal(p.org)},${literal(p.workspace)},'website',NULL,NULL,NULL,NULL,NULL,1,date_trunc('milliseconds',transaction_timestamp()),date_trunc('milliseconds',transaction_timestamp()));`,
      );
    }
    db.workOwner(
      `INSERT INTO morrow_billing.billing_terms VALUES(1,${literal(JSON.stringify(terms.terms))}::jsonb,${literal(JSON.stringify(terms.offers))}::jsonb,${literal(terms.digest)},date_trunc('milliseconds',clock_timestamp()));`,
    );
    const one = (query) => db.rows(query)[0] ?? null;
    const count = (query) => Number(one(`SELECT count(*)::int AS n FROM (${query}) x`)?.n ?? -1);

    // ---- the SQL bridges: each Worker's binding serves exactly one login, one psql
    // connection per workerd connection. Faults are the laboratory's: refuse the next
    // vault-login connections, or execute the api's next COMMIT and lose its reply.
    const faults = { refuseVault: 0, loseApiCommit: false };
    const sqlLog = { morrow_api_worker: [], morrow_vault_broker: [] };
    const opened = { morrow_api_worker: 0, morrow_vault_broker: 0, refused: 0, lostCommits: 0 };
    const reply = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const sqlBindingFor = (user) => {
      const connections = new Map();
      return async (request) => {
        const message = await request.json();
        sqlLog[user].push(JSON.stringify(message));
        try {
          if (message.op === "open") {
            if (user === "morrow_vault_broker" && faults.refuseVault > 0) {
              faults.refuseVault--;
              opened.refused++;
              return reply({ error: true }, 503);
            }
            opened[user]++;
            const connection = await db.connector({ user }).open({
              signal: new AbortController().signal,
              deadlineMs: Date.now() + 60000,
              waitUntil() {},
            });
            const id = randomUUID();
            connections.set(id, connection);
            return reply({ id });
          }
          const connection = connections.get(message.id);
          if (!connection) return reply({ error: true }, 400);
          if (message.op === "query") {
            const result = await connection.query(
              message.text,
              message.values,
              new AbortController().signal,
            );
            if (user === "morrow_api_worker" && message.text === "COMMIT" && faults.loseApiCommit) {
              // The COMMIT ran; its reply is lost with the connection.
              faults.loseApiCommit = false;
              opened.lostCommits++;
              connections.delete(message.id);
              await connection.close();
              return reply({ error: true }, 503);
            }
            return reply({ rows: result.rows });
          }
          if (message.op === "close") {
            connections.delete(message.id);
            await connection.close();
            return reply({ closed: true });
          }
          return reply({ error: true }, 400);
        } catch {
          return reply({ error: true }, 503);
        }
      };
    };

    const fake = createStripeFake();
    const outbound = { stripe: 0, broker: [], api: [] };
    const logs = [];
    const common = {
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"],
    };
    const mf = new Miniflare({
      workers: [
        {
          ...common,
          name: "billing-api",
          bindings: { LAB_API_ORIGIN: origin },
          serviceBindings: {
            SQL: sqlBindingFor("morrow_api_worker"),
            BROKER: { name: "billing-broker", entrypoint: "ApiBroker" },
          },
          outboundService(request) {
            outbound.api.push(new URL(request.url).host);
            return new Response(null, { status: 502 });
          },
        },
        {
          ...common,
          name: "billing-broker",
          bindings: {
            MORROW_ENVIRONMENT: "development",
            LOGIN_CONFIGURATION_JSON: JSON.stringify({ ...login, retentionTier: "development" }),
            MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
            MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: vaultPassword,
            MORROW_VAULT_KEK_V1: kek,
            // The Stripe switch on (owner decision (c), 2026-10-21; its runtime image): this
            // lab is the switched-on pair. Switched off is lab:edge-workers' and lab:billing D1b.
            MORROW_STRIPE_MODE: "test",
            STRIPE_RESTRICTED_KEY: fakeStripeKey,
            STRIPE_WEBHOOK_SECRET: fakeStripeWebhookSecret,
            STRIPE_CONFIGURATION_JSON: JSON.stringify({
              schemaVersion: 1,
              portalConfigurationId,
              automaticTax: false,
              billingAddressCollection: "auto",
            }),
          },
          serviceBindings: { SQL: sqlBindingFor("morrow_vault_broker") },
          async outboundService(request) {
            const url = new URL(request.url);
            if (url.origin === "https://api.stripe.com") {
              outbound.stripe++;
              return fake.fetch(request);
            }
            outbound.broker.push(url.host);
            return new Response(null, { status: 502 });
          },
        },
      ],
      log: new Log(LogLevel.NONE),
      handleRuntimeStdio(stdout, stderr) {
        stdout.on("data", (chunk) => logs.push(String(chunk)));
        stderr.on("data", (chunk) => logs.push(String(chunk)));
      },
    });
    try {
      await mf.ready;
      const api = await mf.getWorker("billing-api");
      async function send(url, { method = "GET", headers = {}, body = null } = {}) {
        const response = await api.fetch("http://lab.invalid/__lab/request", {
          method: "POST",
          body: JSON.stringify({ method, url, headers, body }),
        });
        const described = await response.json();
        let parsed = null;
        try {
          parsed = JSON.parse(described.body);
        } catch {}
        return { status: described.status, body: parsed };
      }
      const browser = (p) => ({
        Cookie: "__Host-morrow_session=" + p.secret,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      });
      const billing = (p, path = "") =>
        send(`${origin}/workspace/${p.workspace}/billing${path}`, { headers: browser(p) });
      const purchase = (p, path, body, key = randomUUID()) =>
        send(`${origin}/workspace/${p.workspace}/billing${path}`, {
          method: "POST",
          headers: {
            ...browser(p),
            Origin: origin,
            "Content-Type": "application/json",
            "X-Morrow-Request": "1",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        });
      const deliver = async (delivery, signature = delivery.signature) =>
        (
          await send(`${origin}/api/billing/stripe/webhook`, {
            method: "POST",
            headers: { "stripe-signature": signature, "content-type": "application/json" },
            body: delivery.body,
          })
        ).status;
      const intents = (p) =>
        db.rows(
          `SELECT id::text AS id,status,stripe_session_id,customer_operation_id::text AS customer_op,checkout_operation_id::text AS checkout_op FROM morrow_billing.checkout_intents WHERE workspace_id=${literal(p.workspace)} ORDER BY created_at,id`,
        );
      const routeOf = (p) =>
        one(
          `SELECT route,mode,fixing_payment_key FROM morrow_billing.workspace_billing_routes WHERE workspace_id=${literal(p.workspace)}`,
        );
      const walletOf = (p) =>
        one(
          `SELECT available::text AS available FROM morrow_billing.credit_wallets WHERE workspace_id=${literal(p.workspace)}`,
        )?.available ?? null;
      const grants = (key) =>
        count(`SELECT 1 FROM morrow_billing.credit_grants WHERE payment_key=${literal(key)}`);
      const receipts = () => count("SELECT 1 FROM morrow_billing.stripe_event_receipts");
      const vaultStatementsSent = (pattern) =>
        sqlLog.morrow_vault_broker.filter((m) => {
          const message = JSON.parse(m);
          return message.op === "query" && pattern.test(message.text);
        }).length;

      // ---- C: the billing view and checkout through both Workers.
      const [a, b] = people;
      const view = await billing(a);
      check(
        "C1:the_billing_view_reads_in_phase_open_through_the_dispatch",
        view.status === 200 &&
          view.body?.phase === "open" &&
          view.body.callToAction?.kind === "morrow_plans" &&
          opened.morrow_vault_broker === 0,
        { status: view.status },
      );
      const key = randomUUID();
      const checkout = await purchase(a, "/morrow/checkout", { priceKey: PRICE }, key);
      const [intent] = intents(a);
      const customer = one(
        `SELECT stripe_customer_id FROM morrow_billing.stripe_customers WHERE workspace_id=${literal(a.workspace)}`,
      )?.stripe_customer_id;
      const posts = fake.requests.filter((r) => r.method === "POST");
      check(
        "C2:checkout_creates_the_customer_and_session_through_the_rpc_binding_and_the_vault_login",
        checkout.status === 201 &&
          checkout.body?.checkoutUrl ===
            "https://checkout.stripe.com/c/pay/" + intent?.stripe_session_id &&
          fake.state.customers.has(customer) &&
          fake.state.sessions.get(intent.stripe_session_id)?.customer === customer &&
          JSON.stringify(posts.map((r) => [r.path, r.idempotencyKey])) ===
            JSON.stringify([
              ["/v1/customers", "morrow-development-" + intent.customer_op],
              ["/v1/checkout/sessions", "morrow-development-" + intent.checkout_op],
            ]) &&
          count(
            `SELECT 1 FROM morrow_work.operations WHERE id IN (${literal(intent.customer_op)},${literal(intent.checkout_op)}) AND status='verified'`,
          ) === 2,
        { status: checkout.status, code: checkout.body?.code },
      );
      // The vault login ran each operation's two transactions, each behind the D5 role
      // preflight and the local timeouts, and sent only registry statements.
      check(
        "C3:each_vault_transaction_runs_the_d5_preflight_and_only_registry_statements",
        opened.morrow_vault_broker === 4 &&
          vaultStatementsSent(/^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE$/) === 4 &&
          vaultStatementsSent(/^SELECT current_user AS role,session_user AS login,/) === 4 &&
          vaultStatementsSent(/^SET LOCAL statement_timeout='3s'$/) === 4 &&
          vaultStatementsSent(/morrow_billing\.stripe_op_begin\(\$1\)/) === 2 &&
          vaultStatementsSent(/morrow_billing\.stripe_op_settle\(/) === 2 &&
          vaultStatementsSent(/^COMMIT$/) === 4,
        { opened: opened.morrow_vault_broker },
      );
      const replay = await purchase(a, "/morrow/checkout", { priceKey: PRICE }, key);
      check(
        "C4:an_idempotency_key_replay_returns_the_same_session_without_a_stripe_call",
        replay.status === 200 &&
          replay.body?.operationId === checkout.body?.operationId &&
          replay.body?.checkoutUrl === checkout.body?.checkoutUrl &&
          fake.requests.filter((r) => r.method === "POST").length === 2,
        { status: replay.status },
      );

      // ---- W: webhooks signed by the fake.
      const paid = fake.complete(intent.stripe_session_id, {
        periodStart: periodNow.start,
        periodEnd: periodNow.end,
      });
      const paymentKey = "stripe:invoice:" + paid.invoice.id;
      const before = receipts();
      const vaultOpensBefore = opened.morrow_vault_broker;
      const forged = await deliver(
        fake.signedEvent("invoice.paid", paid.invoice, {
          secret: "whsec_" + "Wrong".padEnd(32, "0"),
        }),
      );
      check(
        "W1:a_bad_signature_is_400_with_no_row_and_no_vault_transaction",
        forged === 400 && receipts() === before && opened.morrow_vault_broker === vaultOpensBefore,
        { forged },
      );
      const invoiceEvent = fake.signedEvent("invoice.paid", paid.invoice);
      faults.refuseVault = 1;
      const heldStatus = await deliver(invoiceEvent);
      check(
        "W2:a_held_broker_is_503_and_writes_nothing",
        heldStatus === 503 &&
          faults.refuseVault === 0 &&
          opened.refused === 1 &&
          receipts() === before &&
          routeOf(a)?.route === null,
        { heldStatus },
      );
      const paidStatus = await deliver(invoiceEvent);
      const route = routeOf(a);
      check(
        "W3:the_retry_applies_route_account_wallet_and_grant_and_answers_after_the_commit",
        paidStatus === 200 &&
          route?.route === "morrow_direct" &&
          route.mode === "test" &&
          route.fixing_payment_key === paymentKey &&
          walletOf(a) === "300" &&
          grants(paymentKey) === 1 &&
          count(
            `SELECT 1 FROM morrow_billing.billing_accounts WHERE workspace_id=${literal(a.workspace)} AND route='morrow_direct'`,
          ) === 1 &&
          count(
            `SELECT 1 FROM morrow_billing.receipt_applications ra JOIN morrow_billing.stripe_event_receipts r ON r.id=ra.receipt_id WHERE r.event_id=${literal(invoiceEvent.id)} AND ra.outcome='applied'`,
          ) === 1,
        { paidStatus, route },
      );
      const redelivered = await deliver(invoiceEvent);
      const completed = await deliver(fake.signedEvent("checkout.session.completed", paid.session));
      check(
        "W4:a_redelivery_and_the_completed_session_change_nothing",
        redelivered === 200 &&
          completed === 200 &&
          grants(paymentKey) === 1 &&
          walletOf(a) === "300" &&
          intents(a).every((i) => i.status === "verified"),
        { redelivered, completed },
      );
      const cycle = fake.cycle(paid.subscription.id, {
        periodStart: periodNow.end,
        periodEnd: periodNow.end + 30 * 86400,
      });
      faults.loseApiCommit = true;
      const readStatusBefore = sqlLog.morrow_api_worker.filter((m) =>
        /morrow_billing\.receipt_status\(/.test(m),
      ).length;
      const lostAck = await deliver(fake.signedEvent("invoice.paid", cycle));
      check(
        "W5:a_lost_commit_acknowledgement_is_read_back_before_the_200",
        lostAck === 200 &&
          faults.loseApiCommit === false &&
          opened.lostCommits === 1 &&
          sqlLog.morrow_api_worker.filter((m) => /morrow_billing\.receipt_status\(/.test(m))
            .length ===
            readStatusBefore + 1 &&
          grants("stripe:invoice:" + cycle.id) === 1 &&
          walletOf(a) === "600",
        { lostAck },
      );

      // ---- P: the portal.
      const portal = await purchase(a, "/morrow/portal", {});
      const portalPost = fake.requests
        .filter((r) => r.path === "/v1/billing_portal/sessions")
        .at(-1);
      check(
        "P1:the_portal_session_uses_the_mapped_customer_and_the_saved_configuration",
        portal.status === 201 &&
          portal.body?.portalUrl?.startsWith("https://billing.stripe.com/p/session/") &&
          portalPost?.form.customer === customer &&
          portalPost.form.configuration === portalConfigurationId &&
          portalPost.form.return_url === `${origin}/w/${a.workspace}/settings/billing` &&
          portalPost.idempotencyKey === "morrow-development-" + portal.body.operationId,
        { status: portal.status },
      );

      // ---- D: the api Worker's dispatch rows around the two families.
      const requestsBefore = fake.requests.length;
      const opensBefore = opened.morrow_vault_broker;
      const getWebhook = await send(`${origin}/api/billing/stripe/webhook`);
      const queryWebhook = await send(`${origin}/api/billing/stripe/webhook?x=1`, {
        method: "POST",
        headers: { "stripe-signature": invoiceEvent.signature },
        body: invoiceEvent.body,
      });
      const work = await send(`${origin}/workspace/${b.workspace}/work/goals`, {
        headers: browser(b),
      });
      const otherView = await billing(b);
      check(
        "D1:the_webhook_row_is_one_exact_post_and_the_unbound_work_family_is_401",
        getWebhook.status === 405 &&
          queryWebhook.status === 404 &&
          work.status === 401 &&
          otherView.status === 200 &&
          otherView.body?.phase === "open" &&
          fake.requests.length === requestsBefore &&
          opened.morrow_vault_broker === opensBefore,
        { get: getWebhook.status, query: queryWebhook.status, work: work.status },
      );

      // ---- O: outbound, logs and the SQL bridge.
      check(
        "O1:zero_unexpected_outbound_requests",
        outbound.api.length === 0 &&
          outbound.broker.length === 0 &&
          outbound.stripe === fake.requests.length &&
          fake.requests.every(
            (r) =>
              r.authorised &&
              /^\/v1\/(customers|checkout\/sessions|billing_portal\/sessions|invoices|subscriptions)(\/|$)/.test(
                r.path,
              ),
          ),
        { api: outbound.api, broker: outbound.broker },
      );
      const logText = logs.join("");
      const bridged = [...sqlLog.morrow_api_worker, ...sqlLog.morrow_vault_broker].join("\n");
      check(
        "O2:no_secret_or_session_in_any_log_or_sql_message",
        privateMarkers.every((m) => !logText.includes(m) && !bridged.includes(m)) &&
          logText.includes('"event":"morrow_billing_webhook"'),
      );
      check(
        "O3:the_broker_logged_its_one_held_method_and_no_other_failure",
        (logText.match(/"event":"morrow_broker"/g) ?? []).length === 1 &&
          /"entrypoint":"ApiBroker","method":"stripeWebhookVerify","code":"CAPABILITY_UNAVAILABLE"/.test(
            logText,
          ),
      );
    } finally {
      await mf.dispose();
    }
  },
  { administrator: "createrole" },
);

const report = {
  lab: "billing-workers",
  generated_at: new Date().toISOString(),
  elapsed_seconds: Math.round((Date.now() - started) / 1000),
  runtime: { miniflare: packageVersion("miniflare"), workerd: packageVersion("workerd") },
  source_digests: sourceDigests,
  checks: checks.length,
  failures,
  results: checks,
};
writeArtifact("labs/billing-workers.json", report);
console.log(JSON.stringify({ lab: "billing-workers", checks: checks.length, failures }));
if (failures.length) process.exit(1);
