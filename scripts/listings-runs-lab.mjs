// M3 PR-2 PostgreSQL 17 laboratory: listings runs (the listings-runs migration) on an
// isolated network-none engine, the full manifest applied by the Neon-shaped non-superuser
// CREATEROLE administrator (ADR-0020 D4). It drives the real code end to end: the runs
// handler (Node, the psql work connector logged in as morrow_api_worker), ListingsRunWorkflow's
// logic (runs/workflow.ts) over the runtime executor's lease steps, and the broker's model
// gateway over the vault login's real transport (runVaultTransactionWithDriver) with the Claude
// adapter answering from an in-process Messages API stand-in (scripts/fixtures/anthropic-
// oracle.mjs). Nothing reaches a provider. It proves:
//   A  admission: with the model-provider switch off, 503 before any write; on, one
//      transaction creates the run, its products, manifest, credit and vendor reservations,
//      run lease, child task T' (ready, owned by the human), envelope, hop, Coordinator grant
//      and events; a replay returns the recorded run; pending_starts lists ids only;
//   B  refusals persist nothing: entitlement, credits, the member ceiling, the product count
//      (25 for every entry since catalogue version 4, ADR-0039: 26 Opus 5.5 high products
//      refused by the request's own bound, 25 at 149 credits refused for credits alone), an
//      unknown selection, a foreign task and an inactive installation; run reads
//      need view on task.read and on the run's store (another tenant, a grantless member and
//      a member without the store read see no run; the grantless member cannot reconcile);
//   W  a run: products read, drafted through the gateway, checked in code, proposed as one
//      catalog.content.publish Proposal@2 by the installation's agent on behalf of the
//      requester, credits settled at the products proposed, cost booked from the catalogue's
//      rates, the lease released; durable step results carry ids and codes only;
//   M  the selection: none is the workspace default (catalogue version 4: version 3's Opus 5.5
//      at medium, ADR-0036 and ADR-0039); a member picks Opus high once the owner raises the
//      ceiling; xhigh is refused; 25 Opus 5.5 high products are admitted for 150 credits and
//      drafted (no US$7 run cap, ADR-0039 item 4). Version 4 lists Claude Opus 5.5 only (the
//      owner, 2026-10-26), so the lab's runs are Opus 5.5 at low, 2 credits a product, and
//      Haiku 5.5 or Sonnet 5.5 is refused as an unknown selection (B5);
//   O  item 10's outcomes in one run: a refusal then a draft, a throttle resent within the
//      attempt, an input over the cap never sent, invalid output twice (failed, accrued as
//      unrecovered), an uncertain send booked at its worst case, a draft steered to another
//      product (product_mismatch, twice);
//   E  a spend limit ends the run (drafted work is still proposed); K the three-failure breaker;
//   U  no unrecovered-cost cap (ADR-0036, migration 0051): past the former US$4.50 a run
//      drafts every product and admission still admits;
//   F  the fence as the broker's login: replay, in flight, one open call per run, attempts,
//      digests, closed inputs, a reply from another model, cost overflow never dropped and the
//      run stopped, a spent reservation refused at the fence with no request, forged settings
//      reaching nothing and no other login executing it;
//   D  one lock order (the workspace stream, then the run, then the rest): a run finishing or
//      starting while a session holds the stream as an admission or a stop does waits on
//      the stream first, and neither deadlocks;
//   C  no daily cap (ADR-0039, migration 0053): an overflow booking (real spend beyond a
//      reservation) is still booked and counted, and the next run is admitted past US$25 of
//      the day's cost;
//   P  the pending approvals cap: admission refuses a run whose proposals could not fit, and
//      a proposal refused at the cap ends the run promptly (proposal_refused), never a
//      retried step;
//   S  "Stop AI work" mid-run: the next step is refused, the run reads as interrupted, and
//      the stale close returns its credits and accrues its cost; admission is refused; a
//      call in flight at the stop is still recorded and booked (its close needs no lease);
//      a fence a dead broker left open is booked as uncertain at its worst case, and a late
//      close is refused (never promoted to success);
//   L  no provider id, model id, stop reason, request text, product or draft content reaches
//      the api's reads, the outbox or a durable step result;
//   R  M2 PR-3's read resolution (shopify_read_resolve, as the broker's login) under a real run
//      lease: the run's own product in progress resolves, a product not yet begun or already
//      finished, another run's id, a read lease, a released lease and a stop are refused;
//      runs whose product read is the orchestrator's createProductReader over the broker's
//      own shopifyRead against the synthetic Shopify draft and propose; a read that fails once
//      is tried again within the step; a product whose every read is refused (a Shopify 500,
//      a description over the read's limit) fails read_failed while the rest are proposed, and
//      a store that cannot be read ends the run read_unavailable with its drafts proposed;
//   X  shop/redact (connector_inbox_apply, as the connector's login) deletes a store's
//      snapshots and drafts and leaves other stores' content; racing it, a snapshot put, a
//      draft finish and an agent submit that entered their lease first wait on the store's
//      stop key and write nothing, a write that commits first is deleted by the pass, and an
//      agent submit that commits first has its parameters emptied by the pass; the request
//      completes once the token is destroyed, with per-pass deletion counts; a run it stopped
//      still settles its proposed products and accrues its pending draft's cost;
//   T  a staging operator test entitlement (sim, the last phase: no verified payment event,
//      the route and the latest snapshot name the operator grant): admission reads the
//      snapshot's period, as the api's billingPeriodLatest does, the run's billing facts
//      carry the same period, and the run succeeds.
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data. Shapes
// marked sim stand in for states no API path reaches yet. CI pg-work group.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createAgentsApiHandler } from "../packages/work/src/agents/http.ts";
import { createWorkApiHandler } from "../packages/work/src/http.ts";
import { createRunsApiHandler } from "../packages/work/src/runs/http.ts";
import { snapshotCanonical } from "../packages/work/src/runs/drafting.ts";
import {
  createProductReader,
  listingsRun,
  proposeDrafts,
  RunStepRetry,
  runModelBudgetMs,
} from "../packages/work/src/runs/workflow.ts";
import { storeContentHandlers } from "../packages/work/src/redaction.ts";
import { createRuntimeAttempt, runLeaseStep } from "../packages/work/src/runtime/leases.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { createClaudeAdapter } from "../apps/broker/src/claude-adapter.ts";
import { createModelGateway, listingPromptDigest } from "../apps/broker/src/model-gateway.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import { sealVaultRecord, vaultBytesHex } from "../apps/broker/src/vault.ts";
import { createShopifyReader } from "../apps/broker/src/shopify-read.ts";
import { listingDraftSchemaDigest } from "../packages/policy/src/generated/listing-draft-schema.ts";
import {
  capabilityFields,
  fixtureGrant,
  grantInsert,
  literal,
  seedWorkFixtures,
  sleep,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
} from "../tests/tenant-conformance/harness.mjs";
import { createAnthropicOracle, fakeAnthropicKey } from "./fixtures/anthropic-oracle.mjs";
import { createShopifyOracle } from "./fixtures/shopify-oracle.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const checks = [];
const failures = [];
const labStarted = Date.now();
let stage = "start";
const phase = (value) => {
  stage = value;
  console.error(
    "RUNS_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
};
function within(promise, timeoutMs, wait) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("RUNS_LAB_STALLED:" + stage + ":" + wait)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("RUNS_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
  }
  return passed === true;
}
const last = (out) => (Array.isArray(out) ? out : out.split("\n")).at(-1);
const ms = "date_trunc('milliseconds',clock_timestamp())";
const print = console.log.bind(console);
const workerLines = [];
// The catalogue's rates (10^-8 USD per token) and worst cases, from SQL.
const usd8 = (n) => (n / 1e8).toFixed(8);

export async function runListingsRunsLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  const O = P.A.org,
    W = P.A.workspace;
  const S = "store_runs",
    C = "connection_runs",
    S2 = "store_runs2";
  const store = storeResource(O, W, S, C);
  const actorOf = (p) => ({
    kind: "human",
    principalId: p.principal,
    organizationId: p.org,
    workspaceId: p.workspace,
    membershipId: p.membership,
    installationId: null,
    mandateId: null,
  });
  const linking = (p) => ({
    ...actorOf(p),
    kind: "service",
    principalId: "morrow.linking",
    membershipId: null,
  });
  function storeGrant(p, capabilityId, verbs, fields = [...listingFieldPaths], resource = store) {
    const g = {
      // Another store's grant names that store (the redaction phase's stores).
      id:
        "g_" +
        p.key.toLowerCase() +
        "_" +
        capabilityId.replaceAll(".", "_") +
        (resource.storeId === null || resource.storeId === S ? "" : "_" + resource.storeId),
      principal: actorOf(p),
      capabilityId,
      verbs,
      scope: {
        organizationId: O,
        workspaceId: W,
        storeIds: resource.storeId === null ? [] : [resource.storeId],
        accountIds: [],
        resources: [resource],
        fields,
      },
      issuedBy: linking(p),
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 1,
    };
    if (!validateCurrentDefinition("Grant", g)) throw Error("RUNS_LAB_GRANT_INVALID");
    return `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(O)},${literal(W)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`;
  }
  const catalogGrants = (p) => [
    storeGrant(p, "catalog.products.read", ["view", "delegate"]),
    storeGrant(p, "catalog.content.propose", ["execute", "delegate"]),
    storeGrant(p, "catalog.content.publish", ["propose", "approve", "execute", "delegate"]),
  ];
  const workspaceRes = {
    organizationId: O,
    workspaceId: W,
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: W,
  };
  // The founder (organization_signups) holds M2's store-link template on S and the model
  // default grant; A1 is a member with the catalog grants only.
  db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_runs','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(P.A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_runs',${literal(O)},${literal(W)},${literal(P.A.membership)},'owner-bootstrap-v1',clock_timestamp());`);
  db.admin(
    [
      ...catalogGrants(P.A),
      storeGrant(
        P.A,
        "agents.installation.activate",
        ["execute"],
        ["evaluation", "grant", "installationId", "revision"],
      ),
      storeGrant(
        P.A,
        "governance.model_default.revise",
        ["execute"],
        ["effort", "expectedRevision", "maxCreditsPerProduct", "model"],
        workspaceRes,
      ),
      ...catalogGrants(P.A1),
      // A1 also creates its own goal (the ceiling case needs a member's own task).
      grantInsert(
        P.A1,
        fixtureGrant(
          P.A1,
          "workspace.goal.create",
          ["view", "execute"],
          capabilityFields().get("workspace.goal.create"),
        ),
      ),
    ].join("\n"),
  );
  // M5's billing records of an entitled Morrow-direct workspace (sim: owner-seeded with the
  // triggers off; lab:billing proves the receipt path that writes them): the route fixed by a
  // verified invoice, the active account, an active entitlement snapshot, the granted
  // subscription period and a wallet of 300 credits.
  const terms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8")).environments
    .development[0];
  const account = randomUUID(),
    receipt = randomUUID();
  db.workOwner(
    `INSERT INTO morrow_billing.billing_terms VALUES(1,${literal(JSON.stringify(terms.terms))}::jsonb,${literal(JSON.stringify(terms.offers))}::jsonb,${literal(terms.digest)},${ms});`,
  );
  const replica = (statements) => {
    const r = db.tryRun(
      `BEGIN; SET LOCAL session_replication_role=replica;\n${statements}\nCOMMIT;`,
    );
    if (!r.ok) {
      if (process.env.MORROW_LAB_DEBUG === "1") console.error(r.stderr.slice(0, 1500));
      throw Error("RUNS_LAB_FIXTURE_FAILED:" + stage);
    }
    return r.stdout;
  };
  replica(`INSERT INTO morrow_billing.workspace_billing_routes VALUES(${literal(O)},${literal(W)},'website',NULL,NULL,NULL,NULL,NULL,1,${ms},${ms}) ON CONFLICT DO NOTHING;
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',created_at=${ms}-interval '2 days',route_fixed_at=${ms}-interval '1 day',fixing_payment_key='stripe:invoice:in_LabRunsPay00001',revision=2,updated_at=${ms} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};
INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},'morrow_direct','test','USD','active',1,${ms},${ms});
INSERT INTO morrow_billing.stripe_event_receipts(organization_id,workspace_id,id,event_id,event_type,livemode,mode,object_type,object_id,customer_id,object,object_digest,observed_at,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(receipt)},'evt_labruns000001','invoice.paid',false,'test','invoice','in_LabRunsPay00001',NULL,'{"kind":"invoice","id":"in_LabRunsPay00001","livemode":false}'::jsonb,${literal("d".repeat(64))},${ms},${ms});
INSERT INTO morrow_billing.entitlement_snapshots VALUES(${literal(O)},${literal(W)},${literal(account)},1,'morrow_direct','test','stripe:sub:sub_LabRunsSub00001','active',${literal("c".repeat(64))},${ms}-interval '1 hour',${ms}+interval '29 days',${literal(receipt)},${ms});
INSERT INTO morrow_billing.verified_payment_events(organization_id,workspace_id,id,route,mode,payment_key,kind,subscription_key,price_key,period_start,period_end,operation_id,amount,currency,provider_evidence_ref,verified_at,outcome,outcome_code,receipt_id,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},'morrow_direct','test','stripe:invoice:in_LabRunsPay00001','subscription_period','stripe:sub:sub_LabRunsSub00001','stripe:price:price_MorrowDevBeta0049',${ms}-interval '1 day',${ms}+interval '29 days',${literal(randomUUID())},'49','USD',${literal("e".repeat(64))},${ms}-interval '1 hour','granted',NULL,${literal(receipt)},${ms});
INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,terms_revision,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},300,0,0,1,1,2,${ms},${ms});`);
  // The stores link after the route is fixed (a Morrow-direct route is never Shopify-bound).
  db.admin(
    storeInstallationSql({
      org: O,
      workspace: W,
      principal: P.A.principal,
      storeId: S,
      connectionId: C,
      installationId: "storeinst_runs",
    }) +
      "\n" +
      storeInstallationSql({
        org: O,
        workspace: W,
        principal: P.A.principal,
        storeId: S2,
        connectionId: "connection_runs2",
        installationId: "storeinst_runs2",
      }),
  );
  const wallet = () =>
    db.rows(
      `SELECT available::int,reserved::int,consumed::int FROM morrow_billing.credit_wallets WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)}`,
    )[0];
  const count = (query) => Number(last(db.sql(`SELECT (${query})::bigint;`)));
  const one = (query) => db.rows(query)[0] ?? null;
  // What any admission writes: a refusal must leave every count unchanged.
  const footprint = () =>
    JSON.stringify({
      runs: count("SELECT count(*) FROM morrow_work.runs"),
      reservations: count("SELECT count(*) FROM morrow_billing.credit_reservations"),
      vendor: count("SELECT count(*) FROM morrow_billing.vendor_cost_reservations"),
      leases: count("SELECT count(*) FROM morrow_work.work_leases"),
      tasks: count("SELECT count(*) FROM morrow_work.tasks"),
      envelopes: count("SELECT count(*) FROM morrow_work.work_envelopes"),
      hops: count("SELECT count(*) FROM morrow_work.delegation_hops"),
      events: count("SELECT count(*) FROM morrow_work.outbox_events"),
      commands: count("SELECT count(*) FROM morrow_work.commands"),
      grants: count("SELECT count(*) FROM morrow_identity.grants"),
      wallet: wallet(),
    });

  // The handlers.
  const ctx = { waitUntil() {} };
  const debugSql =
    process.env.MORROW_LAB_DEBUG === "1"
      ? { stderr: (text) => console.error("SQL_STDERR " + text.slice(0, 800)) }
      : {};
  const runsOn = createRunsApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(debugSql),
    now: Date.now,
    environment: "development",
    admission: true,
  });
  const runsOff = createRunsApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
    environment: "development",
    admission: false,
  });
  const agents = createAgentsApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  const workApi = createWorkApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  let retries = 0;
  async function call(handler, p, method, path, body, options = {}) {
    const key = options.key ?? randomUUID();
    for (let n = 1; ; n++) {
      console.log = (...args) => workerLines.push(args.map(String).join(" "));
      let response;
      try {
        response = await within(
          handler.fetch(
            workRequest(p, method, path, body, { key, workspace: options.workspace }),
            undefined,
            ctx,
          ),
          60000,
          "request",
        );
      } finally {
        console.log = print;
      }
      const text = await response.text();
      const reply = { status: response.status, body: JSON.parse(text), text };
      // A loaded host may time a request out before its definer: retry with the same key.
      if (reply.status === 503 && reply.body.code === "unavailable" && !options.once && n < 4) {
        retries++;
        await sleep(250);
        continue;
      }
      return reply;
    }
  }
  // The agents routes live under /workspace/:ws, not /work.
  async function agentsCall(p, method, path, body) {
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
      headers["Idempotency-Key"] = randomUUID();
    }
    for (let n = 1; ; n++) {
      console.log = () => {};
      let response;
      try {
        response = await agents.fetch(
          new Request(workFixtureOrigin + "/workspace/" + p.workspace + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          undefined,
          ctx,
        );
      } finally {
        console.log = print;
      }
      const reply = { status: response.status, body: await response.json() };
      if (reply.status !== 503 || n >= 4) return reply;
      await sleep(250);
    }
  }
  const work = (p, path, body) => call(workApi, p, "POST", path, body);

  // The parent task T (A's own) and the Listings installation (the enable document flow).
  const goal = await work(P.A, "/goals", {
    objective: "Better listings",
    storeIds: [],
    successCriteria: [
      { description: "Done", verificationCapabilityId: null, evidenceRequired: false },
    ],
  });
  const objective = "Rewrite the titles and descriptions to be clearer for summer shoppers";
  const taskOf = async (p, text = objective, goalId = goal.body.goalId) =>
    (await work(p, "/tasks", { goalId, objective: text, allowedResources: [] })).body.taskId;
  const T = await taskOf(P.A);
  const listings = `/stores/${S}/agents/listings`;
  const document = await agentsCall(P.A, "POST", listings + "/document", {});
  const enabled = await agentsCall(P.A, "POST", listings, {
    documentDigest: document.body.documentDigest,
    nonce: document.body.nonce,
  });
  const installation = one(
    `SELECT id::text AS id,agent_principal_id::text AS agent,status FROM morrow_work.agent_installations WHERE store_id=${literal(S)}`,
  );
  check(
    "A0:fixtures_task_installation_and_entitlement",
    typeof T === "string" &&
      document.status === 201 &&
      enabled.status === 200 &&
      installation?.status === "active" &&
      wallet().available === 300,
    { goal: goal.status, document: document.status, enabled: enabled.body, installation },
  );

  // The broker: the model-provider switch on, the vault login over this engine, the Claude
  // adapter answering from the in-process stand-in.
  const anthropicKey = fakeAnthropicKey();
  const binding = {
    schemaVersion: 1,
    environment: "development",
    projectId: "morrow-runs-lab",
    branchId: "br-runs-lab",
    hostname: "ep-runs-lab.c-14.us-east-1.aws.neon.tech",
    database: "morrow",
  };
  const brokerEnv = {
    MORROW_ENVIRONMENT: "development",
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
    MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "lab-vault-" + randomBytes(12).toString("hex"),
    MORROW_VAULT_KEK_V1: randomBytes(32).toString("hex"),
    MORROW_MODEL_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: anthropicKey,
  };
  const capabilities = await brokerCapabilities(brokerEnv);
  const oracle = createAnthropicOracle({
    key: anthropicKey,
    models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  });
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
  const gateway = createModelGateway({
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
    providers: Object.freeze({
      anthropic: createClaudeAdapter((request) => oracle.fetch(request)),
    }),
    now: () => Date.now(),
  });
  const brokerLines = [];
  const modelRespond = async (leaseId, generation, callJson, budgetMs) => {
    console.log = (line) => brokerLines.push(String(line));
    try {
      return await gateway.modelRespond(brokerEnv, leaseId, generation, callJson, budgetMs);
    } finally {
      console.log = print;
    }
  };
  check(
    "A0:broker_holds_the_model_and_vault_capabilities",
    capabilities.modelMode === "anthropic" &&
      capabilities.model !== null &&
      capabilities.vault !== null,
  );

  // The runtime executor's pool and the Workflow's ports, as the orchestrator builds them.
  const runtimeConnector = db.connector({ user: "morrow_runtime_executor" });
  const runtimePool = {
    async connect(control) {
      const connection = await runtimeConnector.open({
        signal: control.signal,
        deadlineMs: control.deadlineMs,
        waitUntil() {},
      });
      return {
        query: (text, values, c) => connection.query(text, [...values], c.signal),
        release: () => connection.close(),
      };
    },
  };
  // The store as the product read (M2 PR-3's shopifyRead) will return it: synthetic products.
  const catalog = new Map();
  const product = (n, over = {}) => {
    const p = {
      productId: "product:" + n,
      title: "Linen shirt " + n,
      descriptionHtml: "<p>Original description of shirt " + n + ".</p>",
      seo: { title: null, description: null },
      tags: ["summer"],
      ...over,
    };
    catalog.set(p.productId, p);
    return p.productId;
  };
  const ports = {
    async lease(ref, body) {
      const attempt = createRuntimeAttempt(30000, new AbortController().signal);
      try {
        const result = await within(runLeaseStep(runtimePool, attempt, ref, body), 120000, "lease");
        return result.ok ? result.value : "failed";
      } finally {
        attempt.end();
      }
    },
    modelRespond,
    async readProduct(_ref, _runId, productId) {
      const p = catalog.get(productId);
      return p ? { outcome: "read", product: structuredClone(p) } : { outcome: "not_found" };
    },
    environment: "development",
    now: () => Date.now(),
    sleep: (wait) => sleep(Math.min(wait, 50)),
    ids: () => randomUUID(),
  };
  // A Workflow's durable steps: a RunStepRetry is retried (as the orchestrator's step.do with
  // four retries), results cross a JSON boundary, and every result is kept for the L checks;
  // every retry is counted (a read that never clears must not spend them).
  const stepResults = [];
  const stepRetries = [];
  const durable = (hooks = {}) => ({
    async do(name, body) {
      for (let n = 1; ; n++) {
        try {
          const value = JSON.parse(JSON.stringify(await body()));
          stepResults.push({ name, value });
          await hooks.after?.(name, value);
          return value;
        } catch (error) {
          if (!(error instanceof RunStepRetry) || n >= 5) throw error;
          stepRetries.push(name + ":" + error.code);
        }
      }
    },
  });
  const admitBody = (products, over = {}) => ({
    storeId: S,
    products,
    fields: ["descriptionHtml", "title"],
    selection: { model: "claude_opus_5_5", effort: "low" },
    ...over,
  });
  const admit = (p, task, body, options) =>
    call(runsOn, p, "POST", "/tasks/" + task + "/runs", body, options);
  const leaseOf = (runId) => {
    const r = one(
      `SELECT lease_id::text AS lease_id,lease_generation::int AS generation FROM morrow_work.runs WHERE id=${literal(runId)}`,
    );
    return { leaseId: r.lease_id, generation: r.generation };
  };
  const runRow = (runId) =>
    one(
      `SELECT status,status_actor,status_guard,ended_reason,products_drafted::int AS drafted,products_failed::int AS failed,consecutive_failed::int AS consecutive FROM morrow_work.runs WHERE id=${literal(runId)}`,
    );
  const credit = (runId) =>
    one(
      `SELECT status,credits_reserved::int AS reserved,credits_settled::int AS settled FROM morrow_billing.credit_reservations WHERE root_run_id=${literal(runId)}`,
    );
  const calls = (runId) =>
    db.rows(
      `SELECT product_index::int AS i,attempt::int AS a,sequence::int AS s,status,outcome,counted,cost_usd::text AS cost,overflow_usd::text AS overflow,booking_id FROM morrow_work.run_model_calls WHERE run_id=${literal(runId)} ORDER BY product_index,attempt,sequence`,
    );
  const productsOf = (runId) =>
    db.rows(
      `SELECT product_index::int AS i,status,attempts::int AS attempts,failure_code FROM morrow_work.run_products WHERE run_id=${literal(runId)} ORDER BY product_index`,
    );
  const rates = one(
    "SELECT input_usd8_per_token::int AS input,output_usd8_per_token::int AS output FROM morrow_work.model_catalogue_rates WHERE version=4 AND model_key='claude_opus_5_5'",
  );
  const worst = one(
    "SELECT worst_case_per_attempt_usd::text AS attempt,worst_case_per_product_usd::text AS product,credits_per_product::int AS credits FROM morrow_work.model_catalogue_entries WHERE version=4 AND model_key='claude_opus_5_5' AND effort_key='low'",
  );
  const completedUnits = 900 * rates.input + 300 * rates.output;
  const completedCost = usd8(completedUnits);
  async function execute(runId, hooks) {
    return within(
      listingsRun(ports, durable(hooks), leaseOf(runId), runId),
      600000,
      "run " + runId,
    );
  }

  // ---------------------------------------------------------------------------
  phase("admission");
  let happyRun;
  {
    const before = footprint();
    const off = await call(runsOff, P.A, "POST", "/tasks/" + T + "/runs", admitBody(["product:1"]));
    check(
      "A1:switch_off_refuses_before_any_write",
      off.status === 503 &&
        off.body.code === "unavailable" &&
        off.body.safeMessage === "AI drafting is not available yet." &&
        footprint() === before,
      off.body,
    );
    const products = [product(1), product(2), product(3)];
    const key = randomUUID();
    const admitted = await admit(P.A, T, admitBody(products), { key });
    happyRun = admitted.body.runId;
    const run = one(
      `SELECT r.status,r.status_actor,r.status_guard,r.model_key,r.effort_key,r.credits_per_product::int AS cpp,r.product_count::int AS n,to_jsonb(r.fields)::text AS fields,r.route_canonical,r.route_digest::text AS route_digest,r.child_task_id::text AS child,r.installation_id::text AS installation,r.agent_principal_id::text AS agent,r.coordinator_principal_id::text AS coordinator,r.requester_principal_id::text AS requester,r.billing_account_id::text AS account,r.workflow_version,r.lease_id::text AS lease FROM morrow_work.runs r WHERE r.id=${literal(happyRun ?? "")}`,
    );
    const child = one(
      `SELECT status,owner_principal_id::text AS owner,initiator_principal_id::text AS initiator,goal_id::text AS goal FROM morrow_work.tasks WHERE id=${literal(run?.child ?? "")}`,
    );
    const lease = one(
      `SELECT kind,subject_id::text AS subject,status,store_id::text AS store,installation_id::text AS installation,initiator_principal_id::text AS initiator,started_at IS NULL AS unstarted FROM morrow_work.work_leases WHERE id=${literal(run?.lease ?? "")}`,
    );
    const manifest = one(
      `SELECT provider,provider_model_id,model_key,effort_key,credits_per_product::int AS cpp,attempts::int AS attempts,prompt_digest IS NULL AS unbound FROM morrow_work.run_manifests WHERE run_id=${literal(happyRun ?? "")}`,
    );
    const coordinatorGrant = one(
      `SELECT payload->>'capabilityId' AS capability,payload#>>'{scope,resources,0,id}' AS task,payload#>>'{issuedBy,principalId}' AS issuer,(payload->>'expiresAt')::timestamptz<=clock_timestamp()+interval '24 hours' AS bounded FROM morrow_identity.grants WHERE principal_id=${literal(run?.coordinator ?? "")} ORDER BY payload->>'validFrom' DESC LIMIT 1`,
    );
    const route = run ? JSON.parse(run.route_canonical) : null;
    check(
      "A2:admission_creates_the_run_and_its_records",
      admitted.status === 201 &&
        admitted.body.status === "queued" &&
        String(admitted.body.creditsReserved) === "6" &&
        run?.status === "queued" &&
        run.status_actor === "work_service" &&
        run.model_key === "claude_opus_5_5" &&
        run.effort_key === "low" &&
        run.cpp === 2 &&
        run.n === 3 &&
        run.fields === '["descriptionHtml", "title"]' &&
        run.installation === installation.id &&
        run.agent === installation.agent &&
        run.requester === P.A.principal &&
        run.account === account &&
        run.workflow_version === "listings-run@1" &&
        run.route_digest === sha(run.route_canonical) &&
        validateCurrentDefinition("CoordinatorRoute", route) &&
        route.runId === happyRun &&
        JSON.stringify(route.products) === JSON.stringify(products) &&
        count(
          `SELECT count(*) FROM morrow_work.run_products WHERE run_id=${literal(happyRun)} AND status='pending'`,
        ) === 3 &&
        manifest?.provider === "anthropic" &&
        manifest.provider_model_id === "claude-opus-5-5" &&
        manifest.unbound === true &&
        credit(happyRun)?.status === "reserved" &&
        credit(happyRun).reserved === 6 &&
        wallet().available === 294 &&
        wallet().reserved === 6 &&
        child?.status === "ready" &&
        child.owner === P.A.principal &&
        child.initiator === P.A.principal &&
        lease?.kind === "run" &&
        lease.subject === happyRun &&
        lease.status === "active" &&
        lease.store === S &&
        lease.installation === installation.id &&
        lease.unstarted === true &&
        coordinatorGrant?.capability === "workspace.task.delegate" &&
        coordinatorGrant.task === T &&
        coordinatorGrant.issuer === P.A.principal &&
        coordinatorGrant.bounded === true &&
        count(
          `SELECT count(*) FROM morrow_work.work_envelopes WHERE task_id=${literal(T)} AND requester_principal_id=${literal(P.A.principal)}`,
        ) >= 1 &&
        count(
          `SELECT count(*) FROM morrow_work.delegation_hops WHERE child_task_id=${literal(run.child)} AND recipient_installation_id=${literal(installation.id)} AND dispatcher_kind='builtin_coordinator'`,
        ) === 1 &&
        count(
          `SELECT count(*) FROM morrow_work.outbox_events WHERE event_type='run.admitted' AND aggregate_id=${literal(happyRun)}`,
        ) === 1,
      { admitted: admitted.body, run, child, lease, manifest, coordinatorGrant },
    );
    const after = footprint();
    const replay = await admit(P.A, T, admitBody(products), { key });
    const conflict = await admit(P.A, T, admitBody([products[0]]), { key });
    check(
      "A3:replay_returns_the_recorded_run_and_a_changed_body_conflicts",
      replay.status === 200 &&
        replay.body.replayed === true &&
        replay.body.runId === happyRun &&
        conflict.status === 409 &&
        conflict.body.code === "conflict" &&
        footprint() === after,
      { replay: replay.body, conflict: conflict.body },
    );
    const pending = db.rows(
      "SELECT kind,subject_id::text AS subject,lease_id::text AS lease,generation::text AS generation FROM morrow_work.pending_starts()",
      { prefix: "", user: "morrow_runtime_executor" },
    );
    check(
      "A4:pending_starts_lists_the_run_ids_only",
      pending.some((p) => p.kind === "run" && p.subject === happyRun && p.lease === run.lease) &&
        pending.every((p) => Object.keys(p).sort().join() === "generation,kind,lease,subject"),
      pending,
    );
  }

  // ---------------------------------------------------------------------------
  phase("refusals");
  {
    const before = footprint();
    const refusal = async (name, p, task, body, status, code) => {
      const r = await admit(p, task, body);
      return check(name, r.status === status && r.body.code === code && footprint() === before, {
        status: r.status,
        body: r.body,
      });
    };
    // Entitlement lost (a later snapshot past due; sim): SQL and TypeScript both refuse.
    replica(
      `INSERT INTO morrow_billing.entitlement_snapshots SELECT organization_id,workspace_id,billing_account_id,2,route,mode,subscription_key,'past_due',provider_evidence_ref,verified_at,valid_until,receipt_id,${ms} FROM morrow_billing.entitlement_snapshots WHERE billing_account_id=${literal(account)} AND revision=1;`,
    );
    await refusal("B1:no_entitlement_403", P.A, T, admitBody(["product:1"]), 403, "denied");
    replica(
      `INSERT INTO morrow_billing.entitlement_snapshots SELECT organization_id,workspace_id,billing_account_id,3,route,mode,subscription_key,'active',provider_evidence_ref,verified_at,valid_until,receipt_id,${ms} FROM morrow_billing.entitlement_snapshots WHERE billing_account_id=${literal(account)} AND revision=1;`,
    );
    const before2 = footprint();
    // Not enough credits (the wallet drained; sim), then restored.
    const kept = wallet().available;
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=3 WHERE billing_account_id=${literal(account)};`,
    );
    const poor = await admit(P.A, T, admitBody(["product:1", "product:2"]));
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=${kept} WHERE billing_account_id=${literal(account)};`,
    );
    check(
      "B2:insufficient_credits_409",
      poor.status === 409 && poor.body.code === "budget_exhausted" && footprint() === before2,
      poor.body,
    );
    // A member above the default ceiling (4 credits per product since catalogue version 3,
    // ADR-0036; 1 at version 1): Opus high costs 6.
    const memberGoal = await work(P.A1, "/goals", {
      objective: "Member's listings",
      storeIds: [],
      successCriteria: [
        { description: "Done", verificationCapabilityId: null, evidenceRequired: false },
      ],
    });
    const memberTask = await taskOf(P.A1, "Member's listings", memberGoal.body.goalId);
    const before3 = footprint();
    const above = await admit(
      P.A1,
      memberTask,
      admitBody(["product:1"], { selection: { model: "claude_opus_5_5", effort: "high" } }),
    );
    check(
      "B3:member_above_ceiling_403",
      above.status === 403 &&
        above.body.safeMessage === "That model or effort is above your workspace's limit." &&
        footprint() === before3,
      above.body,
    );
    // B4 (ADR-0039 item 4): Opus high admits at most 25 products (catalogue version 4: no
    // US$7 run cap lowers the limit). 26 are refused: since every entry's limit is now the
    // request's own 25-product bound, the request check refuses them first (400, before any
    // database access); SQL's run_product_limit is lab:run-credits C5's. 25 cost 150 credits,
    // refused at 149 for credits alone (the wallet drained; sim), then restored. M5 admits 25
    // for 150.
    const opusHigh = { selection: { model: "claude_opus_5_5", effort: "high" } };
    const products = (n) => Array.from({ length: n }, (_, i) => "product:" + (100 + i));
    const limit = await admit(P.A, T, admitBody(products(26), opusHigh));
    const available = wallet().available;
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=149 WHERE billing_account_id=${literal(account)};`,
    );
    const short = await admit(P.A, T, admitBody(products(25), opusHigh));
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=${available} WHERE billing_account_id=${literal(account)};`,
    );
    check(
      "B4:twenty_six_products_refused_and_insufficient_credits_at_149",
      limit.status === 400 &&
        limit.body.code === "missing_input" &&
        short.status === 409 &&
        short.body.code === "budget_exhausted" &&
        short.body.safeMessage === "Not enough credits for this run." &&
        footprint() === before3,
      { limit: limit.body, short: short.body },
    );
    const unknown = await admit(
      P.A,
      T,
      admitBody(["product:1"], { selection: { model: "claude_unknown", effort: "low" } }),
    );
    // Version 4 lists Claude Opus 5.5 only (the owner, 2026-10-26): Haiku 5.5 and Sonnet 5.5,
    // entries of versions 1 and 3, are unknown selections now.
    const haiku = await admit(
      P.A,
      T,
      admitBody(["product:1"], { selection: { model: "claude_haiku_5_5", effort: "low" } }),
    );
    const sonnet = await admit(
      P.A,
      T,
      admitBody(["product:1"], { selection: { model: "claude_sonnet_5_5", effort: "high" } }),
    );
    check(
      "B5:unknown_selection_400",
      [unknown, haiku, sonnet].every((r) => r.status === 400 && r.body.code === "missing_input") &&
        footprint() === before3,
      { unknown: unknown.body, haiku: haiku.body, sonnet: sonnet.body },
    );
    // Another workspace's task is not found; a store without the Listings agent is refused.
    const foreign = await admit(P.A, "task_" + randomUUID(), admitBody(["product:1"]));
    const inactive = await admit(P.A, T, admitBody(["product:1"], { storeId: S2 }));
    check(
      "B6:foreign_task_and_inactive_installation",
      foreign.status === 404 &&
        inactive.status === 409 &&
        inactive.body.safeMessage === "The Listings agent is not enabled for this store." &&
        footprint() === before3,
      { foreign: foreign.body, inactive: inactive.body },
    );
    // Another tenant cannot read A's run.
    const foreignRead = await call(runsOn, P.Y, "GET", "/runs/" + happyRun);
    check("B7:another_tenant_reads_nothing", foreignRead.status === 404, foreignRead.body);
    // A member of the same workspace with no grant (X): the run is 404 like an absent one, the
    // task's runs are 403, and the reconcile is refused (default deny, P06.T01a).
    const grantlessRun = await call(runsOn, P.X, "GET", "/runs/" + happyRun);
    const grantlessList = await call(runsOn, P.X, "GET", "/tasks/" + T + "/runs");
    const grantlessReconcile = await call(runsOn, P.X, "POST", "/runs-reconcile", {});
    check(
      "B8:a_grantless_member_reads_and_reconciles_nothing",
      grantlessRun.status === 404 &&
        grantlessList.status === 403 &&
        grantlessReconcile.status === 403 &&
        count(
          `SELECT count(*) FROM morrow_work.commands WHERE actor_principal_id=${literal(P.X.principal)}`,
        ) === 0,
      { run: grantlessRun.body, list: grantlessList.body, reconcile: grantlessReconcile.body },
    );
    // A member who views tasks but not the store's products (C): the run is 404 and the
    // task's runs leave it out.
    const taskOnlyRun = await call(runsOn, P.C, "GET", "/runs/" + happyRun);
    const taskOnlyList = await call(runsOn, P.C, "GET", "/tasks/" + T + "/runs");
    check(
      "B9:a_member_without_the_store_read_sees_no_run",
      taskOnlyRun.status === 404 &&
        taskOnlyList.status === 200 &&
        Array.isArray(taskOnlyList.body.runs) &&
        taskOnlyList.body.runs.length === 0,
      { run: taskOnlyRun.body, list: taskOnlyList.body },
    );
  }

  // ---------------------------------------------------------------------------
  phase("happy_run");
  {
    const result = await execute(happyRun);
    const row = runRow(happyRun);
    const drafts = db.rows(
      `SELECT status,proposal_id::text AS proposal,fields::text AS fields FROM morrow_work.run_drafts WHERE run_id=${literal(happyRun)} ORDER BY product_index`,
    );
    const proposalIds = [...new Set(drafts.map((d) => d.proposal))];
    const proposal = one(
      `SELECT p.canonical,p.digest::text AS digest,p.proposer_kind,p.proposer_principal_id::text AS proposer,p.proposer_installation_id::text AS proposer_installation,p.requester_principal_id::text AS requester,p.capability_id,p.target_count::int AS targets,p.maximum_credits::text AS credits,pp.canonical AS parameters,pp.digest::text AS parameters_digest,a.status AS approval,a.proposal_digest::text AS approval_digest FROM morrow_work.proposals p JOIN morrow_work.proposal_parameters pp ON pp.organization_id=p.organization_id AND pp.workspace_id=p.workspace_id AND pp.id=p.parameters_id JOIN morrow_work.approvals a ON a.organization_id=p.organization_id AND a.workspace_id=p.workspace_id AND a.proposal_id=p.id WHERE p.id=${literal(proposalIds[0] ?? "")}`,
    );
    const document = proposal ? JSON.parse(proposal.canonical) : null;
    const lease = one(
      `SELECT status FROM morrow_work.work_leases WHERE id=${literal(leaseOf(happyRun).leaseId)}`,
    );
    check(
      "W1:a_run_drafts_proposes_and_succeeds",
      result.kind === "ended" &&
        result.status === "succeeded" &&
        row.status === "succeeded" &&
        row.status_actor === "runtime" &&
        row.status_guard === "completion_evidence" &&
        row.drafted === 3 &&
        productsOf(happyRun).every((p) => p.status === "drafted" && p.attempts === 1) &&
        drafts.length === 3 &&
        drafts.every((d) => d.status === "packed") &&
        proposalIds.length === 1 &&
        proposal?.proposer_kind === "agent" &&
        proposal.proposer === installation.agent &&
        proposal.proposer_installation === installation.id &&
        proposal.requester === P.A.principal &&
        proposal.capability_id === "catalog.content.publish" &&
        proposal.targets === 3 &&
        proposal.approval === "pending" &&
        proposal.approval_digest === proposal.digest &&
        proposal.digest === sha(proposal.canonical) &&
        proposal.parameters_digest === sha(proposal.parameters) &&
        document.contextTaint === "untrusted_external" &&
        document.maximumCredits === "0" &&
        validateCurrentDefinition("CatalogContentChangeSet", JSON.parse(proposal.parameters)) &&
        lease?.status === "released",
      { result, row, drafts, proposal: proposal && { ...proposal, canonical: undefined } },
    );
    const bookings = db.rows(
      `SELECT kind,amount_usd::text AS amount FROM morrow_billing.run_cost_bookings WHERE root_run_id=${literal(happyRun)} ORDER BY id`,
    );
    const vendor = one(
      `SELECT status,booked_cost_usd::text AS booked FROM morrow_billing.vendor_cost_reservations WHERE root_run_id=${literal(happyRun)}`,
    );
    const manifest = one(
      `SELECT attempts::int AS attempts,input_tokens::int AS input,output_tokens::int AS output,booked_cost_usd::text AS booked,prompt_digest::text AS prompt,schema_digest::text AS schema FROM morrow_work.run_manifests WHERE run_id=${literal(happyRun)}`,
    );
    check(
      "W2:credits_settle_at_the_products_proposed_and_cost_is_booked_from_the_rates",
      credit(happyRun)?.status === "settled" &&
        credit(happyRun).settled === 6 &&
        wallet().consumed === 6 &&
        wallet().reserved === 0 &&
        calls(happyRun).length === 3 &&
        calls(happyRun).every(
          (c) => c.outcome === "completed" && c.counted === true && c.cost === completedCost,
        ) &&
        bookings.length === 3 &&
        bookings.every((b) => b.kind === "attempt" && b.amount === completedCost) &&
        vendor?.booked === usd8(3 * completedUnits) &&
        manifest?.attempts === 3 &&
        manifest.input === 2700 &&
        manifest.output === 900 &&
        manifest.booked === usd8(3 * completedUnits) &&
        manifest.prompt === (await listingPromptDigest()) &&
        manifest.schema === listingDraftSchemaDigest,
      {
        credit: credit(happyRun),
        wallet: wallet(),
        calls: calls(happyRun),
        bookings,
        vendor,
        manifest,
      },
    );
    check(
      "W3:the_provider_saw_exactly_the_reviewed_requests",
      oracle.violations.length === 0 &&
        oracle.requests.filter((r) => r.path === "/v1/messages/count_tokens").length === 3 &&
        oracle.requests.filter((r) => r.path === "/v1/messages").length === 3 &&
        oracle.requests.every((r) => r.model === "claude-opus-5-5"),
      { violations: oracle.violations, requests: oracle.requests.length },
    );
    const events = db.rows(
      `SELECT event_type,payload::text AS payload,actor_principal_id::text AS actor FROM morrow_work.outbox_events WHERE aggregate_id=${literal(happyRun)} OR (event_type='proposal.submitted' AND aggregate_id=${literal(proposalIds[0] ?? "")}) ORDER BY position`,
    );
    check(
      "W4:events_name_the_requester_and_carry_ids_and_codes",
      events.map((e) => e.event_type).join() ===
        "run.admitted,run.status_changed,proposal.submitted,run.status_changed" &&
        events.every((e) => e.actor === P.A.principal) &&
        JSON.parse(events[1].payload).to === "running" &&
        JSON.parse(events[3].payload).to === "succeeded",
      events,
    );
    const finishedRead = await call(runsOn, P.A, "GET", "/runs/" + happyRun);
    check(
      "W5:the_run_reads_with_its_products_proposals_and_credits",
      finishedRead.status === 200 &&
        finishedRead.body.run.status === "succeeded" &&
        finishedRead.body.credits.settled === 6 &&
        finishedRead.body.usage.attempts === 3 &&
        finishedRead.body.products.length === 3 &&
        finishedRead.body.products.every(
          (p) => p.status === "drafted" && p.proposalId === proposalIds[0] && p.flags !== null,
        ) &&
        finishedRead.body.interrupted === false,
      finishedRead.body,
    );
  }

  // ---------------------------------------------------------------------------
  phase("selection");
  {
    // M1: no selection is the workspace default, catalogue version 4's (version 3's) Opus 5.5
    // at medium (4 credits a product, ADR-0036), within A1's default ceiling of 4.
    const memberGoal = await work(P.A1, "/goals", {
      objective: "Member's runs",
      storeIds: [],
      successCriteria: [
        { description: "Done", verificationCapabilityId: null, evidenceRequired: false },
      ],
    });
    const memberTask = await taskOf(P.A1, "Member's runs", memberGoal.body.goalId);
    const defaulted = await admit(P.A1, memberTask, admitBody([product(81)], { selection: null }));
    check(
      "M1:no_selection_is_the_workspace_default",
      defaulted.status === 201 &&
        defaulted.body.selection.model === "claude_opus_5_5" &&
        defaulted.body.selection.effort === "medium" &&
        defaulted.body.catalogueVersion === 4 &&
        defaulted.body.creditsReserved === 4,
      defaulted.body,
    );
    // M2: the owner raises the ceiling to 6; the member may then pick Opus high.
    const raised = await agentsCall(P.A, "PUT", "/settings/model-default", {
      model: "claude_opus_5_5",
      effort: "low",
      maxCreditsPerProduct: 6,
      expectedRevision: null,
    });
    const opus = await admit(
      P.A1,
      memberTask,
      admitBody([product(82)], { selection: { model: "claude_opus_5_5", effort: "high" } }),
    );
    check(
      "M2:a_member_picks_opus_high_after_the_ceiling_is_raised",
      raised.status === 200 && opus.status === 201 && opus.body.creditsReserved === 6,
      { raised: raised.body, opus: opus.body },
    );
    // M3: xhigh is never in the catalogue.
    const xhigh = await admit(
      P.A,
      T,
      admitBody([product(83)], { selection: { model: "claude_opus_5_5", effort: "xhigh" } }),
    );
    check("M3:xhigh_is_refused", xhigh.status === 400, xhigh.body);
    // Both runs complete, so no admitted run lingers into the later sections.
    const ended = [await execute(defaulted.body.runId), await execute(opus.body.runId)];
    check(
      "M4:both_member_runs_draft_and_settle",
      ended.every((r) => r.kind === "ended" && r.status === "succeeded") &&
        credit(defaulted.body.runId)?.settled === 4 &&
        credit(opus.body.runId)?.settled === 6 &&
        oracle.requests.some((r) => r.model === "claude-opus-5-5"),
      { ended },
    );
    // The default now costs 4 credits, not version 1's 1: the 3 more are returned to W's
    // 300-credit wallet (sim), so the later phases keep the budget they were written for.
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=available+3 WHERE billing_account_id=${literal(account)};`,
    );
    // M5 (ADR-0039 item 4): the owner admits 25 Opus 5.5 high products in one run, 150 credits
    // held up front (US$17.60 of worst case, past the former US$7), and the run drafts them
    // all and settles 150. The 150 are returned to W's wallet (sim) for the later phases.
    const many = Array.from({ length: 25 }, (_, i) => product(200 + i));
    const before = wallet();
    const big = await admit(
      P.A,
      T,
      admitBody(many, { selection: { model: "claude_opus_5_5", effort: "high" } }),
    );
    const vendor = one(
      `SELECT maximum_cost_usd::text AS maximum,catalogue_version::int AS version FROM morrow_billing.vendor_cost_reservations WHERE root_run_id=${literal(big.body.runId ?? "")}`,
    );
    const bigResult = big.status === 201 ? await execute(big.body.runId) : null;
    check(
      "M5:twenty_five_opus_high_products_admitted_for_150_credits_and_drafted",
      big.status === 201 &&
        big.body.catalogueVersion === 4 &&
        big.body.creditsReserved === 150 &&
        vendor?.maximum === "17.60000000" &&
        vendor.version === 4 &&
        bigResult?.kind === "ended" &&
        bigResult.status === "succeeded" &&
        runRow(big.body.runId).drafted === 25 &&
        credit(big.body.runId)?.settled === 150 &&
        wallet().consumed === before.consumed + 150,
      { big: big.body, vendor, bigResult, run: big.body.runId && runRow(big.body.runId) },
    );
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=available+150 WHERE billing_account_id=${literal(account)};`,
    );
  }

  // ---------------------------------------------------------------------------
  phase("outcomes");
  {
    const ids = [product(11), product(12), product(13), product(14), product(15), product(16)];
    oracle.script(ids[0], [{ kind: "stop", reason: "refusal" }, { kind: "completed" }]);
    oracle.script(ids[1], [
      { kind: "status", status: 429, retryAfter: "1", type: "rate_limit_error", message: "Slow" },
      { kind: "completed" },
    ]);
    oracle.count(ids[2], { tokens: 7500 });
    oracle.script(ids[3], [{ kind: "invalid_json" }, { kind: "invalid_json" }]);
    // A 503 after the send (a gateway failure, not a refusal): uncertain, counted at its
    // worst case like a 500 or 504, never a free provider_error.
    oracle.script(ids[4], [{ kind: "status", status: 503 }, { kind: "completed" }]);
    // Product text that steers the draft to another product: product_mismatch, twice.
    const steered = (p) => ({
      productId: "product:999",
      title: p.title + " - improved",
      descriptionHtml: null,
      seo: null,
      tags: null,
    });
    oracle.script(ids[5], [
      { kind: "completed", draft: steered },
      { kind: "completed", draft: steered },
    ]);
    const unrecoveredBefore = count(
      "SELECT coalesce(sum(amount_usd),0)*100000000 FROM morrow_billing.unrecovered_cost_entries",
    );
    const admitted = await admit(P.A, T, admitBody(ids));
    const runId = admitted.body.runId;
    const result = await execute(runId);
    const c = calls(runId);
    const products = productsOf(runId);
    const entries = db.rows(
      `SELECT kind,amount_usd::text AS amount FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(runId)} ORDER BY kind,amount_usd`,
    );
    check(
      "O1:item_10_outcomes_and_a_steered_draft_in_one_run",
      result.kind === "ended" &&
        result.status === "succeeded" &&
        JSON.stringify(products.map((p) => [p.status, p.attempts, p.failure_code])) ===
          JSON.stringify([
            ["drafted", 2, null],
            ["drafted", 1, null],
            ["failed", 0, "input_over_cap"],
            ["failed", 2, "invalid_output"],
            ["drafted", 2, null],
            ["failed", 2, "product_mismatch"],
          ]) &&
        JSON.stringify(c.map((x) => [x.i, x.a, x.s, x.outcome, x.counted])) ===
          JSON.stringify([
            [0, 1, 1, "refusal", true],
            [0, 2, 1, "completed", true],
            [1, 1, 1, "not_sent", false],
            [1, 1, 2, "completed", true],
            [2, 1, 1, "input_over_cap", false],
            [3, 1, 1, "invalid_output", true],
            [3, 2, 1, "invalid_output", true],
            [4, 1, 1, "uncertain", true],
            [4, 2, 1, "completed", true],
            [5, 1, 1, "completed", true],
            [5, 2, 1, "completed", true],
          ]),
      { result, products, calls: c },
    );
    check(
      "O2:the_over_cap_product_was_never_sent_and_the_throttle_resent_once",
      oracle.sends(ids[2]) === 0 && oracle.sends(ids[1]) === 2 && oracle.sends(ids[3]) === 2,
    );
    const uncertain = c.find((x) => x.outcome === "uncertain");
    check(
      "O3:an_uncertain_send_is_booked_at_its_worst_case_and_accrued",
      Number(uncertain?.cost) === Number(worst.attempt) &&
        entries.some(
          (e) => e.kind === "uncertain_attempt" && Number(e.amount) === Number(worst.attempt),
        ) &&
        entries.filter((e) => e.kind === "failed_product").length === 4 &&
        entries
          .filter((e) => e.kind === "failed_product")
          .every((e) => Number(e.amount) === Number(completedCost)) &&
        count(
          "SELECT coalesce(sum(amount_usd),0)*100000000 FROM morrow_billing.unrecovered_cost_entries",
        ) > unrecoveredBefore,
      { entries, uncertain, worst },
    );
    check(
      "O4:credits_settle_at_the_three_products_proposed",
      credit(runId)?.status === "settled" && credit(runId).settled === 6,
      credit(runId),
    );
  }

  // ---------------------------------------------------------------------------
  phase("run_ending");
  {
    const ids = [product(21), product(22), product(23)];
    oracle.script(ids[1], [
      {
        kind: "status",
        status: 400,
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    ]);
    const admitted = await admit(P.A, T, admitBody(ids));
    const runId = admitted.body.runId;
    const result = await execute(runId);
    check(
      "E1:a_spend_limit_ends_the_run_and_drafted_work_is_still_proposed",
      result.kind === "ended" &&
        result.status === "failed" &&
        runRow(runId).ended_reason === "spend_limit" &&
        JSON.stringify(productsOf(runId).map((p) => [p.status, p.failure_code])) ===
          JSON.stringify([
            ["drafted", null],
            ["failed", "spend_limit"],
            ["skipped", null],
          ]) &&
        oracle.sends(ids[2]) === 0 &&
        count(
          `SELECT count(*) FROM morrow_work.run_drafts WHERE run_id=${literal(runId)} AND status='packed'`,
        ) === 1 &&
        credit(runId)?.settled === 2,
      { result, run: runRow(runId), products: productsOf(runId), credit: credit(runId) },
    );
    // The breaker: three consecutive failed products end the run; the rest are skipped.
    const ids2 = [product(31), product(32), product(33), product(34)];
    for (const id of ids2.slice(0, 3))
      oracle.script(id, [{ kind: "invalid_json" }, { kind: "invalid_json" }]);
    const admitted2 = await admit(P.A, T, admitBody(ids2));
    const run2 = admitted2.body.runId;
    const result2 = await execute(run2);
    check(
      "K1:three_consecutive_failed_products_stop_the_run",
      result2.kind === "ended" &&
        result2.status === "failed" &&
        runRow(run2).ended_reason === "breaker" &&
        JSON.stringify(productsOf(run2).map((p) => p.status)) ===
          JSON.stringify(["failed", "failed", "failed", "skipped"]) &&
        oracle.sends(ids2[3]) === 0 &&
        credit(run2)?.status === "released" &&
        count(
          `SELECT count(*) FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(run2)} AND kind='failed_product'`,
        ) === 6,
      { result2, run: runRow(run2), credit: credit(run2) },
    );
  }

  // ---------------------------------------------------------------------------
  phase("unrecovered_cap");
  {
    // U1 (ADR-0036, migration 0051): no unrecovered-cost cap. With this period's unrecovered
    // cost raised far past the former US$4.50 (sim), a running run still drafts every product
    // and admission still admits; the ledger is restored after. The run limit and the breaker
    // still stop runs (B4, K1 and lab:run-credits C4); no daily cap does (C1, ADR-0039).
    const ids = [product(91), product(92)];
    const walletBefore = wallet();
    const admitted = await admit(P.A, T, admitBody(ids));
    const runId = admitted.body.runId;
    const saved = one(
      `SELECT period_start::text AS period,amount_usd::text AS amount FROM morrow_billing.unrecovered_costs WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)}`,
    );
    replica(
      `UPDATE morrow_billing.unrecovered_costs SET amount_usd=1000 WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};`,
    );
    const result = await execute(runId);
    const next = await admit(P.A, T, admitBody([product(93)]));
    const nextResult = next.status === 201 ? await execute(next.body.runId) : null;
    replica(
      `UPDATE morrow_billing.unrecovered_costs SET amount_usd=${saved.amount} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};`,
    );
    check(
      "U1:no_unrecovered_cost_cap_past_the_former_limit",
      admitted.status === 201 &&
        result.kind === "ended" &&
        result.status === "succeeded" &&
        runRow(runId).ended_reason === null &&
        runRow(runId).drafted === 2 &&
        oracle.sends(ids[0]) === 1 &&
        oracle.sends(ids[1]) === 1 &&
        next.status === 201 &&
        nextResult?.kind === "ended" &&
        nextResult.status === "succeeded",
      {
        admitted: admitted.status,
        sends: ids.map((id) => oracle.sends(id)),
        calls: calls(runId),
        result,
        run: runRow(runId),
        next: next.body,
        nextResult,
      },
    );
    // The cap stopped these runs before ADR-0036, so they spent no credits; the 6 they now
    // spend are returned to W's wallet (sim), so the later phases keep their budget.
    const spent = walletBefore.available - wallet().available;
    if (spent > 0)
      replica(
        `UPDATE morrow_billing.credit_wallets SET available=available+${spent} WHERE billing_account_id=${literal(account)};`,
      );
  }

  // ---------------------------------------------------------------------------
  phase("lock_order");
  {
    // D1-D2: one lock order, the workspace stream first, then the run, then the rest (every
    // API command's prelude takes the stream first). A session takes the stream as an
    // admission's or a stop's prelude does and waits, inside the database, until another
    // backend is blocked behind it; a run step starts and must wait on the stream before it
    // takes the run, the wallet or the lease; the session then takes the wallet (an
    // admission's run_reserve, D1) or the run lease (a stop's revocation, D2) and commits
    // well within the step's 1 s lock_timeout. The old order (the stream last) deadlocked
    // both: the step held the wallet or the lease while it waited on the stream.
    const blockedBehindMe =
      "EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE NOT l.granted AND pg_catalog.pg_backend_pid()=ANY(pg_catalog.pg_blocking_pids(l.pid)))";
    const gated = async (name, then) => {
      const session = db.runAsync(
        `BEGIN;
SELECT 1 FROM morrow_work.workspace_streams WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} FOR UPDATE;
DO $gate$ BEGIN
 FOR i IN 1..1500 LOOP
  EXIT WHEN ${blockedBehindMe};
  PERFORM pg_catalog.pg_sleep(0.02);
 END LOOP;
END $gate$;
SELECT 'blocked:'||${blockedBehindMe}::text;
${then}
COMMIT;`,
        { applicationName: name },
      );
      // The session holds the stream once it waits in its loop.
      const deadline = Date.now() + 30000;
      let holding = false;
      while (!holding && Date.now() < deadline) {
        const r = await db.runAsync(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(name)} AND wait_event='PgSleep';`,
        );
        holding = r.ok && last(r.stdout) === "1";
        if (!holding) await sleep(25);
      }
      return { holding, session };
    };
    // D1: a run finishing (settle: the wallet) while an admission holds the stream.
    const d1Run = (await admit(P.A, T, admitBody([product(101)]))).body.runId;
    const d1Ref = leaseOf(d1Run);
    await ports.lease(d1Ref, (step) => step.run.start());
    const d1 = await gated(
      "runs_lock_order_d1",
      `SELECT 1 FROM morrow_billing.credit_wallets WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} FOR UPDATE;`,
    );
    const d1Finished = await ports.lease(d1Ref, (step) => step.run.finish("time_budget"));
    const d1Session = await d1.session;
    check(
      "D1:a_run_finish_waits_on_the_stream_an_admission_holds_and_neither_deadlocks",
      d1.holding &&
        d1Session.ok &&
        d1Session.stdout.includes("blocked:true") &&
        d1Finished.value?.outcome === "ended" &&
        runRow(d1Run).status === "failed" &&
        credit(d1Run)?.status === "released",
      {
        holding: d1.holding,
        session: d1Session.stdout + d1Session.stderr.slice(0, 400),
        d1Finished,
      },
    );
    // D2: a run starting (its lease marked started) while a stop holds the stream.
    const d2Run = (await admit(P.A, T, admitBody([product(102)]))).body.runId;
    const d2Ref = leaseOf(d2Run);
    const d2 = await gated(
      "runs_lock_order_d2",
      `SELECT 1 FROM morrow_work.work_leases WHERE id=${literal(d2Ref.leaseId)} FOR UPDATE;`,
    );
    const d2Started = await ports.lease(d2Ref, (step) => step.run.start());
    const d2Session = await d2.session;
    const d2Ended = await ports.lease(d2Ref, (step) => step.run.finish("time_budget"));
    check(
      "D2:a_run_start_waits_on_the_stream_a_stop_holds_and_neither_deadlocks",
      d2.holding &&
        d2Session.ok &&
        d2Session.stdout.includes("blocked:true") &&
        d2Started.value?.outcome === "started" &&
        d2Ended.value?.outcome === "ended" &&
        credit(d2Run)?.status === "released",
      {
        holding: d2.holding,
        session: d2Session.stdout + d2Session.stderr.slice(0, 400),
        d2Started,
        d2Ended,
      },
    );
  }

  // ---------------------------------------------------------------------------
  phase("approvals_cap");
  {
    // P1-P2: the workspace's 1,000 live pending approvals (the agent submit's cap). The
    // pending count is raised with clones of a live pending approval (sim), then removed.
    const pending = () =>
      count(
        `SELECT count(*) FROM morrow_work.approvals WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND status='pending' AND expires_at>clock_timestamp()`,
      );
    const source = one(
      `SELECT id::text AS id FROM morrow_work.approvals WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND status='pending' AND expires_at>clock_timestamp() ORDER BY created_at LIMIT 1`,
    );
    let clones = 0;
    const raiseTo = (target) => {
      const add = target - pending();
      replica(
        `INSERT INTO morrow_work.approvals SELECT a.organization_id,a.workspace_id,'sim_approval_'||g,a.revision,'sim_proposal_'||g,a.proposal_digest,'sim_proposal_'||g,a.status,a.required_approvals,a.self_approval,a.pending_expiry_seconds,a.approved_validity_seconds,a.cool_down_seconds,a.quiet_period_seconds,a.eligible_reviewer_principal_ids,a.counted_reviewer_principal_ids,a.scope_digest,a.review_policy_revision,a.policy_revision,a.effective_at,a.expires_at,a.invalidation_reason,a.created_at,a.updated_at FROM morrow_work.approvals a,generate_series(${clones + 1},${clones + add}) g WHERE a.id=${literal(source.id)};`,
      );
      clones += add;
    };
    // P1: admission refuses a run whose proposals could not fit, before any spend.
    raiseTo(999);
    const before = footprint();
    const full = await admit(P.A, T, admitBody([product(111), product(112)]));
    check(
      "P1:admission_refuses_a_run_whose_proposals_could_not_fit",
      full.status === 409 &&
        full.body.safeMessage ===
          "Too many changes are waiting for review. Approve or reject some, then try again." &&
        footprint() === before,
      full.body,
    );
    // P2: a run admitted at 999 finds the cap reached when it proposes (another proposal
    // landed meanwhile): the propose step is not retried until the Workflow fails; the run
    // ends promptly as proposal_refused, its drafted cost accrued, its credits returned.
    const fits = await admit(P.A, T, admitBody([product(113)]));
    const runId = fits.body.runId;
    raiseTo(1000);
    const proposalsBefore = count("SELECT count(*) FROM morrow_work.proposals");
    const result = await execute(runId);
    const proposeResults = stepResults.filter(
      (r) => r.name === "propose" && r.value?.stop === "proposal_refused",
    );
    check(
      "P2:a_refused_proposal_ends_the_run_promptly",
      fits.status === 201 &&
        result.kind === "ended" &&
        result.status === "failed" &&
        runRow(runId).ended_reason === "proposal_refused" &&
        productsOf(runId)[0]?.status === "drafted" &&
        count("SELECT count(*) FROM morrow_work.proposals") === proposalsBefore &&
        proposeResults.length >= 1 &&
        credit(runId)?.status === "released" &&
        count(
          `SELECT count(*) FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(runId)} AND kind='failed_product'`,
        ) === 1,
      { fits: fits.body, result, run: runRow(runId), credit: credit(runId) },
    );
    replica(
      `DELETE FROM morrow_work.approvals WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND id::text LIKE 'sim\\_approval\\_%';`,
    );
  }

  // ---------------------------------------------------------------------------
  phase("no_daily_cap");
  {
    // C1 (ADR-0039, migration 0053): overflow is real spend and is still booked and counted,
    // but no daily cap refuses on it. One overflow booking (sim) takes today's reservations
    // and overflow past US$25, so the next run's worst case would have passed the former cap:
    // it is admitted and drafted all the same, while the booking stays recorded. The booking
    // is then removed and the run's credit returned to W's wallet (sim) for the later phases.
    const today = `(clock_timestamp() AT TIME ZONE 'UTC')::date`;
    const daySpent = () =>
      Number(
        one(
          `SELECT (COALESCE((SELECT sum(CASE WHEN status='reserved' THEN maximum_cost_usd ELSE booked_cost_usd END) FROM morrow_billing.vendor_cost_reservations WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND created_day=${today}),0)+COALESCE((SELECT sum(b.amount_usd) FROM morrow_billing.run_cost_bookings b JOIN morrow_billing.vendor_cost_reservations x ON x.organization_id=b.organization_id AND x.workspace_id=b.workspace_id AND x.id=b.vendor_reservation_id WHERE x.organization_id=${literal(O)} AND x.workspace_id=${literal(W)} AND x.created_day=${today} AND b.kind='overflow'),0))::text AS spent`,
        ).spent,
      );
    const reservation = one(
      `SELECT id::text AS id,root_run_id::text AS run FROM morrow_billing.vendor_cost_reservations WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND created_day=${today} ORDER BY created_at DESC LIMIT 1`,
    );
    const overflow = Math.max(1, 26 - daySpent()).toFixed(8);
    replica(
      `INSERT INTO morrow_billing.run_cost_bookings(organization_id,workspace_id,id,root_run_id,vendor_reservation_id,kind,amount_usd,booked_usd,unrecovered_usd,recorded_at) VALUES(${literal(O)},${literal(W)},'sim_overflow_daily',${literal(reservation.run)},${literal(reservation.id)},'overflow',${overflow},0,0,${ms});`,
    );
    const spent = daySpent();
    const admitted = await admit(P.A, T, admitBody([product(121)]));
    const result = admitted.status === 201 ? await execute(admitted.body.runId) : null;
    const booked = count(
      "SELECT count(*) FROM morrow_billing.run_cost_bookings WHERE id='sim_overflow_daily' AND kind='overflow'",
    );
    replica(
      `DELETE FROM morrow_billing.run_cost_bookings WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND id='sim_overflow_daily';`,
    );
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=available+2 WHERE billing_account_id=${literal(account)};`,
    );
    check(
      "C1:an_overflow_is_still_booked_with_no_daily_refusal",
      spent > 25 &&
        spent + Number(worst.product) > 25 &&
        booked === 1 &&
        admitted.status === 201 &&
        result?.kind === "ended" &&
        result.status === "succeeded" &&
        credit(admitted.body.runId)?.settled === 2,
      { spent, overflow, admitted: admitted.body, result },
    );
  }

  // ---------------------------------------------------------------------------
  phase("fence");
  {
    // A run started and one product begun with its snapshot bound, through the lease steps.
    const id = product(41);
    const admitted = await admit(P.A, T, admitBody([id, product(42)]));
    const runId = admitted.body.runId;
    const ref = leaseOf(runId);
    const begun = await ports.lease(ref, async (step) => {
      await step.run.start();
      const b = await step.run.productBegin(0);
      const put = await step.run.snapshotPut(0, snapshotCanonical(catalog.get(id)));
      return [b.outcome, put.outcome];
    });
    const prompt = await listingPromptDigest();
    const broker = (text) => last(db.sql(text, { user: "morrow_vault_broker" }));
    const begin = (index, attempt, sequence, over = {}) =>
      broker(
        `SELECT outcome||'|'||coalesce(call_id,'')||'|'||coalesce(recorded_outcome,'') FROM morrow_vault.model_call_begin(${literal(over.lease ?? ref.leaseId)},${literal(String(over.generation ?? ref.generation))},'${index}','${attempt}','${sequence}','90000',${literal(over.prompt ?? prompt)},${literal(over.schema ?? listingDraftSchemaDigest)});`,
      ).split("|");
    const end = (callId, outcome, usage, model = "claude-opus-5-5") =>
      broker(
        `SELECT outcome||'|'||coalesce(recorded_outcome,'')||'|'||coalesce(booked_usd,'')||'|'||coalesce(overflow::text,'') FROM morrow_vault.model_call_end(${literal(callId)},${literal(outcome)},${usage ? "'end_turn'" : "NULL"},'req_fence',${literal(model)},'900',${usage ? `'${usage[0]}','${usage[1]}','0','0'` : "NULL,NULL,NULL,NULL"});`,
      ).split("|");
    const first = begin(0, 1, 1);
    const again = begin(0, 1, 1);
    const other = begin(0, 1, 2);
    const secondProduct = begin(1, 1, 1);
    check(
      "F1:one_fence_one_send_one_open_call_per_run",
      begun.entered === true &&
        JSON.stringify(begun.value) === '["begun","stored"]' &&
        first[0] === "begun" &&
        again[0] === "in_flight" &&
        other[0] === "call_open" &&
        secondProduct[0] === "product_state",
      { begun, first, again, other, secondProduct },
    );
    const badEnd = [
      end(first[1], "completed", null),
      broker(
        `SELECT outcome FROM morrow_vault.model_call_end(${literal(first[1])},'uncertain',NULL,NULL,NULL,NULL,'1','1','0','0');`,
      ),
      broker(
        `SELECT outcome FROM morrow_vault.model_call_end(${literal(first[1])},'done',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);`,
      ),
    ];
    // A reply from another model is recorded as a provider error (no fallback), counted.
    const closed = end(first[1], "completed", [900, 300], "claude-other-model");
    const replay = begin(0, 1, 1);
    const reclose = end(first[1], "completed", [900, 300]);
    check(
      "F2:closed_inputs_another_model_and_replay",
      badEnd[0][0] === "invalid" &&
        badEnd[1] === "invalid" &&
        badEnd[2] === "invalid" &&
        closed[0] === "closed" &&
        closed[1] === "provider_error" &&
        replay[0] === "replay" &&
        replay[1] === first[1] &&
        replay[2] === "provider_error" &&
        reclose[0] === "already_closed",
      { badEnd, closed, replay, reclose },
    );
    // An unknown fence or lease is not_found (FOUND is read before the settings are reset),
    // never a "closed" fence that does not exist, whether or not its outcome would count.
    const unknownEnds = ["not_sent", "spend_limit", "input_over_cap", "uncertain"].map((outcome) =>
      broker(
        `SELECT outcome FROM morrow_vault.model_call_end(${literal(randomUUID())},${literal(outcome)},NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);`,
      ),
    );
    const unknownLease = begin(0, 1, 1, { lease: randomUUID() });
    check(
      "F8:an_unknown_fence_or_lease_is_not_found",
      unknownEnds.every((o) => o === "not_found") && unknownLease[0] === "not_found",
      { unknownEnds, unknownLease },
    );
    // Attempts: attempt 1 is counted, so 1 again is invalid and 3 is never valid; a new
    // attempt 2 opens. The prompt digest is bound by the run's first call.
    const repeat = begin(0, 1, 3);
    const mismatch = begin(0, 2, 1, { prompt: "0".repeat(64) });
    const wrongGeneration = begin(0, 2, 1, { generation: ref.generation + 1 });
    const second = begin(0, 2, 1);
    check(
      "F3:attempts_digests_and_generation",
      repeat[0] === "attempt_invalid" &&
        mismatch[0] === "prompt_mismatch" &&
        wrongGeneration[0] !== "begun" &&
        second[0] === "begun",
      { repeat, mismatch, wrongGeneration, second },
    );
    // Cost overflow: a usage the reservation cannot hold is booked to the limit, the rest as
    // overflow (never dropped, accrued as unrecovered), and the run must stop. The usage is
    // sized to exceed what the reservation still holds by about one cent.
    const remaining = one(
      `SELECT (maximum_cost_usd-booked_cost_usd)::text AS left FROM morrow_billing.vendor_cost_reservations WHERE root_run_id=${literal(runId)}`,
    );
    const outputTokens = Math.ceil(((Number(remaining.left) + 0.01) * 1e8) / rates.output);
    const overflow = end(second[1], "completed", [0, outputTokens]);
    const bookings = db.rows(
      `SELECT id,kind,amount_usd::text AS amount FROM morrow_billing.run_cost_bookings WHERE root_run_id=${literal(runId)} ORDER BY id`,
    );
    const stopped = await ports.lease(ref, (step) => step.run.productBegin(1));
    check(
      "F4:cost_overflow_is_booked_and_stops_the_run",
      overflow[0] === "closed" &&
        overflow[3] === "true" &&
        bookings.some(
          (b) => b.kind === "overflow" && b.id.endsWith(":x") && Number(b.amount) > 0,
        ) &&
        count(
          `SELECT count(*) FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(runId)} AND kind='overflow'`,
        ) === 1 &&
        stopped.entered === true &&
        stopped.value.outcome === "stop" &&
        stopped.value.reason === "cost_overflow",
      { overflow, bookings, stopped },
    );
    const finished = await ports.lease(ref, async (step) => {
      await step.run.productFinish(0, { outcome: "failed", code: "provider_error" });
      return step.run.finish("cost_overflow");
    });
    check(
      "F5:the_overflowed_run_ends_failed_and_releases_its_credits",
      finished.entered === true &&
        finished.value.outcome === "ended" &&
        finished.value.status === "failed" &&
        runRow(runId).ended_reason === "cost_overflow" &&
        credit(runId)?.status === "released",
      { finished, run: runRow(runId), credit: credit(runId) },
    );
    // Only the broker's login executes the model definers; forged settings reach nothing.
    const denied = (user) =>
      !db.tryRun(
        `SELECT * FROM morrow_vault.model_call_begin(${literal(ref.leaseId)},'1','0','1','1','90000',${literal(prompt)},${literal(listingDraftSchemaDigest)});`,
        { user },
      ).ok;
    const forged = last(
      db.sql(
        `BEGIN; SET LOCAL ROLE morrow_work_command; SELECT set_config('morrow.vault_model_run',${literal(O + "|" + W + "|" + runId)},true),set_config('morrow.vault_model_tenant',${literal(O + "|" + W)},true),set_config('morrow.vault_model_task',${literal(O + "|" + W + "|" + T)},true) IS NOT NULL; SELECT (SELECT count(*) FROM morrow_work.runs)+(SELECT count(*) FROM morrow_work.run_model_calls)+(SELECT count(*) FROM morrow_work.tasks)+(SELECT count(*) FROM morrow_billing.run_cost_bookings); ROLLBACK;`,
      ),
    );
    const runtimeDenied = !db.tryRun(
      `SELECT * FROM morrow_vault.model_call_end(${literal(first[1])},'not_sent',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);`,
      { user: "morrow_runtime_executor" },
    ).ok;
    check(
      "F6:only_the_broker_login_and_no_forged_setting",
      denied("morrow_api_worker") &&
        denied("morrow_runtime_executor") &&
        denied("morrow_connector_ingress") &&
        runtimeDenied &&
        forged === "0",
      { forged },
    );
  }

  {
    // F7: a call whose worst case the run's remaining vendor reservation cannot hold is
    // refused at the fence, before any provider request (the reservation used up: sim).
    const id = product(45);
    const admitted = await admit(P.A, T, admitBody([id]));
    const runId = admitted.body.runId;
    const ref = leaseOf(runId);
    await ports.lease(ref, async (step) => {
      await step.run.start();
      await step.run.productBegin(0);
      return step.run.snapshotPut(0, snapshotCanonical(catalog.get(id)));
    });
    replica(
      `UPDATE morrow_billing.vendor_cost_reservations SET booked_cost_usd=maximum_cost_usd WHERE root_run_id=${literal(runId)};`,
    );
    const sent = oracle.requests.length;
    const exhausted = last(
      db.sql(
        `SELECT outcome FROM morrow_vault.model_call_begin(${literal(ref.leaseId)},${literal(String(ref.generation))},'0','1','1','90000',${literal(await listingPromptDigest())},${literal(listingDraftSchemaDigest)});`,
        { user: "morrow_vault_broker" },
      ),
    );
    const held = await modelRespond(
      ref.leaseId,
      ref.generation,
      JSON.stringify({
        schemaVersion: 1,
        purpose: "listing_draft",
        productIndex: 0,
        attempt: 1,
        sequence: 1,
        request: objective,
        fields: ["descriptionHtml", "title"],
        product: catalog.get(id),
      }),
      90000,
    ).then(
      () => "answered",
      (error) => error.message,
    );
    const finished = await ports.lease(ref, async (step) => {
      await step.run.productFinish(0, { outcome: "failed", code: "reservation_exhausted" });
      return step.run.finish("reservation_exhausted");
    });
    check(
      "F7:a_spent_reservation_is_refused_at_the_fence_with_no_request",
      exhausted === "reservation_exhausted" &&
        held === "BROKER_HELD" &&
        oracle.requests.length === sent &&
        finished.value?.status === "failed" &&
        credit(runId)?.status === "released",
      { exhausted, held, finished },
    );
  }

  // ---------------------------------------------------------------------------
  phase("stop");
  {
    const ids = [product(51), product(52), product(53)];
    const admitted = await admit(P.A, T, admitBody(ids));
    const runId = admitted.body.runId;
    let stop = null;
    const result = await within(
      listingsRun(
        ports,
        durable({
          async after(name) {
            if (name === "product-0" && stop === null)
              stop = await agentsCall(P.A, "POST", listings + "/stop", {
                control: { reason: "Pause the drafts", sourceProposalRef: null },
              });
          },
        }),
        leaseOf(runId),
        runId,
      ),
      600000,
      "stopped run",
    );
    const read = await call(runsOn, P.A, "GET", "/runs/" + runId);
    const blocked = await admit(P.A, T, admitBody([product(54)]));
    const reconcile = await call(runsOn, P.A, "POST", "/runs-reconcile", {});
    const row = runRow(runId);
    check(
      "S1:a_stop_interrupts_the_run_at_its_next_step",
      stop?.status === 200 &&
        result.kind === "interrupted" &&
        read.status === 200 &&
        read.body.interrupted === true &&
        read.body.run.status === "running" &&
        blocked.status === 409 &&
        oracle.sends(ids[1]) === 0,
      { stop: stop?.body, result, read: read.body, blocked: blocked.body },
    );
    check(
      "S2:the_stale_close_cancels_the_run_and_returns_its_credits",
      reconcile.status === 200 &&
        reconcile.body.closed === 1 &&
        row.status === "cancelled" &&
        row.status_actor === "work_service" &&
        row.status_guard === "submitted_effects_reconciled" &&
        row.ended_reason === "stopped" &&
        credit(runId)?.status === "released" &&
        JSON.stringify(productsOf(runId).map((p) => p.status)) ===
          JSON.stringify(["drafted", "skipped", "skipped"]) &&
        count(
          `SELECT count(*) FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(runId)} AND kind='failed_product'`,
        ) === 1 &&
        count(
          `SELECT count(*) FROM morrow_work.work_envelopes e JOIN morrow_work.runs r ON r.envelope_id=e.id WHERE r.id=${literal(runId)} AND e.revoked_at IS NOT NULL`,
        ) === 1,
      { reconcile: reconcile.body, row, credit: credit(runId), products: productsOf(runId) },
    );
  }

  // ---------------------------------------------------------------------------
  phase("stop_mid_call");
  {
    const confirmOf = (reply) => ({
      documentDigest: reply.body.documentDigest,
      nonce: reply.body.nonce,
    });
    const resume = async () => {
      const doc = await agentsCall(P.A, "POST", listings + "/document", {});
      return agentsCall(P.A, "POST", listings, confirmOf(doc));
    };
    const stopNow = () =>
      agentsCall(P.A, "POST", listings + "/stop", {
        control: { reason: "Pause the drafts", sourceProposalRef: null },
      });
    // S3: the stop lands while a provider call is in flight. The close needs no lease, so the
    // call is still recorded and booked; the next step is refused; the stale close fails the
    // product as interrupted and accrues its cost; no credit is charged.
    const resumed = await resume();
    const ids = [product(61), product(62)];
    let stopped = null;
    oracle.script(ids[0], [
      {
        kind: "completed",
        async before() {
          stopped = await stopNow();
        },
      },
    ]);
    const admitted = await admit(P.A, T, admitBody(ids));
    const runId = admitted.body.runId;
    const result = await execute(runId);
    const call0 = calls(runId);
    const reconcile = await call(runsOn, P.A, "POST", "/runs-reconcile", {});
    check(
      "S3:a_call_in_flight_at_a_stop_is_recorded_booked_and_never_credited",
      resumed.status === 200 &&
        stopped?.status === 200 &&
        result.kind === "interrupted" &&
        call0.length === 1 &&
        call0[0].status === "closed" &&
        call0[0].outcome === "completed" &&
        call0[0].cost === completedCost &&
        reconcile.status === 200 &&
        reconcile.body.closed === 1 &&
        runRow(runId).status === "cancelled" &&
        JSON.stringify(productsOf(runId).map((p) => [p.status, p.failure_code])) ===
          JSON.stringify([
            ["failed", "interrupted"],
            ["skipped", null],
          ]) &&
        count(
          `SELECT count(*) FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(runId)} AND kind='failed_product'`,
        ) === 1 &&
        credit(runId)?.status === "released",
      {
        resumed: resumed.body,
        stopped: stopped?.body,
        result,
        calls: call0,
        reconcile: reconcile.body,
      },
    );
    // S4: a broker that died mid-call leaves its fence open; the stale close books it as
    // uncertain at its worst case (never free, never success), and a late close is refused.
    const resumed2 = await resume();
    const id = product(71);
    const admitted2 = await admit(P.A, T, admitBody([id]));
    const run2 = admitted2.body.runId;
    const ref = leaseOf(run2);
    await ports.lease(ref, async (step) => {
      await step.run.start();
      await step.run.productBegin(0);
      return step.run.snapshotPut(0, snapshotCanonical(catalog.get(id)));
    });
    const open = last(
      db.sql(
        `SELECT outcome||'|'||coalesce(call_id,'') FROM morrow_vault.model_call_begin(${literal(ref.leaseId)},${literal(String(ref.generation))},'0','1','1','90000',${literal(await listingPromptDigest())},${literal(listingDraftSchemaDigest)});`,
        { user: "morrow_vault_broker" },
      ),
    ).split("|");
    const stopped2 = await stopNow();
    const reconcile2 = await call(runsOn, P.A, "POST", "/runs-reconcile", {});
    const fence = calls(run2);
    const late = last(
      db.sql(
        `SELECT outcome||'|'||coalesce(recorded_outcome,'') FROM morrow_vault.model_call_end(${literal(open[1])},'completed','end_turn','req_late','claude-opus-5-5','900','900','300','0','0');`,
        { user: "morrow_vault_broker" },
      ),
    );
    check(
      "S4:an_abandoned_fence_is_booked_uncertain_at_the_stale_close",
      resumed2.status === 200 &&
        open[0] === "begun" &&
        stopped2?.status === 200 &&
        reconcile2.body.closed === 1 &&
        fence.length === 1 &&
        fence[0].outcome === "uncertain" &&
        fence[0].counted === true &&
        Number(fence[0].cost) === Number(worst.attempt) &&
        count(
          `SELECT count(*) FROM morrow_billing.run_cost_bookings WHERE root_run_id=${literal(run2)} AND kind='uncertain_attempt'`,
        ) === 1 &&
        late === "already_closed|uncertain" &&
        runRow(run2).status === "cancelled" &&
        credit(run2)?.status === "released",
      { open, reconcile: reconcile2.body, fence, late },
    );
  }

  // ---------------------------------------------------------------------------
  phase("leakage");
  {
    const forbidden = [
      "claude-opus-5-5",
      "claude-other-model",
      "req_lab",
      "req_fence",
      "req_late",
      "end_turn",
      objective,
      "Linen shirt",
      "Original description",
      "improved",
      anthropicKey,
    ];
    const reads = [
      await call(runsOn, P.A, "GET", "/runs/" + happyRun),
      await call(runsOn, P.A, "GET", "/tasks/" + T + "/runs"),
    ];
    const outbox = db.rows(
      "SELECT payload::text AS payload FROM morrow_work.outbox_events WHERE event_type LIKE 'run.%'",
    );
    const steps = JSON.stringify(stepResults);
    const leaked = (text) => forbidden.filter((f) => text.includes(f));
    check(
      "L1:no_provider_id_or_content_in_reads_events_or_step_results",
      reads.every((r) => r.status === 200 && leaked(r.text).length === 0) &&
        outbox.every((e) => leaked(e.payload).length === 0) &&
        outbox.every((e) =>
          ["childTaskId,productCount", "from,reason,to"].includes(
            Object.keys(JSON.parse(e.payload)).sort().join(),
          ),
        ) &&
        leaked(steps).length === 0 &&
        stepResults.length > 0,
      { reads: reads.map((r) => leaked(r.text)), steps: leaked(steps) },
    );
    const apiDenied = (column, table) =>
      !db.tryRun(
        `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT ${column} FROM morrow_work.${table} LIMIT 1; ROLLBACK;`,
        { user: "morrow_api_worker" },
      ).ok;
    check(
      "L2:the_api_role_cannot_select_provider_ids_or_content",
      apiDenied("provider_request_id", "run_model_calls") &&
        apiDenied("provider_model_id", "run_model_calls") &&
        apiDenied("raw_stop_reason", "run_model_calls") &&
        apiDenied("canonical", "product_snapshots") &&
        apiDenied("set_canonical", "run_drafts") &&
        apiDenied("route_canonical", "runs") &&
        apiDenied("provider_model_id", "run_manifests"),
    );
    check(
      "L3:one_fixed_log_line_per_request_and_broker_hold",
      workerLines.length > 0 &&
        workerLines.every((line) => {
          const r = JSON.parse(line);
          return (
            ["morrow_runs", "morrow_work"].includes(r.event) &&
            Object.keys(r).sort().join() === "correlationId,event,outcome,route"
          );
        }) &&
        brokerLines.every((line) => {
          const r = JSON.parse(line);
          return Object.keys(r).sort().join() === "code,entrypoint,event,method";
        }),
      { sample: workerLines.slice(0, 3), broker: brokerLines.slice(0, 3) },
    );
  }

  // ---------------------------------------------------------------------------
  // M2 PR-3 integrated: the vault credential of a linked store's installation (the
  // envelope binds the tenant, the credential and the store installation as its subject),
  // as M2 PR-2's install would store it; the read resolution returns it, and shop/redact
  // completes once the broker destroys it.
  const storeCredential = async (installationId) => {
    const token = "shpat_" + randomBytes(16).toString("hex");
    const sealed = await sealVaultRecord(
      capabilities.vault.keyring,
      {
        kind: "shopify_offline_token",
        organizationId: O,
        workspaceId: W,
        credentialId: "credential_" + installationId,
        subjectId: installationId,
        provider: "shopify",
        version: 1,
      },
      new TextEncoder().encode(token),
    );
    db.workOwner(
      `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at) VALUES(${literal(O)},${literal(W)},${literal("credential_" + installationId)},1,'shopify','shopify_offline_token',${literal(installationId)},'active',1,${literal("\\x" + vaultBytesHex(sealed.wrappedKey))}::bytea,${literal("\\x" + vaultBytesHex(sealed.sealedValue))}::bytea,date_trunc('milliseconds',clock_timestamp()));`,
    );
    return token;
  };
  const enableListings = async (storeId) => {
    const path = `/stores/${storeId}/agents/listings`;
    const doc = await agentsCall(P.A, "POST", path + "/document", {});
    return agentsCall(P.A, "POST", path, {
      documentDigest: doc.body.documentDigest,
      nonce: doc.body.nonce,
    });
  };
  // A run's state up to one write: started, its first product begun, and optionally its
  // snapshot, a counted attempt (the broker's fence opened and closed as the broker's login)
  // and a pending draft.
  const draftSet = (n) => canonicalize({ title: "Linen shirt " + n + ", an airy summer cut" });
  const noFlags = { newUrls: 0, newEmails: 0, newPhones: 0, tagsAdded: 0, tagsRemoved: 0 };
  async function prepared(storeId, n, through) {
    const id = product(n);
    const admitted = await admit(P.A, T, admitBody([id], { storeId }));
    // A refused admission names its refusal here, not as a missing lease further on.
    if (!admitted.body.runId)
      throw new Error(
        `prepared ${storeId} ${n}: ${admitted.status} ${JSON.stringify(admitted.body)}`,
      );
    const runId = admitted.body.runId;
    const ref = leaseOf(runId);
    const canonical = snapshotCanonical(catalog.get(id));
    const steps = await ports.lease(ref, async (step) => {
      const started = await step.run.start();
      const begun = await step.run.productBegin(0);
      const put = through === "begun" ? null : await step.run.snapshotPut(0, canonical);
      return { started: started?.outcome, begun: begun.outcome, put: put?.outcome ?? null };
    });
    let call = null,
      finished = null;
    if (through === "attempted" || through === "drafted") {
      const open = last(
        db.sql(
          `SELECT outcome||'|'||coalesce(call_id,'') FROM morrow_vault.model_call_begin(${literal(ref.leaseId)},${literal(String(ref.generation))},'0','1','1','90000',${literal(await listingPromptDigest())},${literal(listingDraftSchemaDigest)});`,
          { user: "morrow_vault_broker" },
        ),
      ).split("|");
      call = [
        open[0],
        last(
          db.sql(
            `SELECT outcome FROM morrow_vault.model_call_end(${literal(open[1])},'completed','end_turn','req_redact','claude-opus-5-5','900','900','300','0','0');`,
            { user: "morrow_vault_broker" },
          ),
        ),
      ];
    }
    if (through === "drafted")
      finished = await ports.lease(ref, (step) =>
        step.run.productFinish(0, {
          outcome: "drafted",
          setCanonical: draftSet(n),
          fields: ["title"],
          flags: noFlags,
        }),
      );
    return { runId, ref, id, canonical, steps: steps.value ?? steps, call, finished };
  }

  // ---------------------------------------------------------------------------
  phase("product_read");
  {
    // R1-R5: M2 PR-3's read resolution (morrow_vault.shopify_read_resolve, as the broker's
    // login) under a real run lease, with run_product_readable as listings-runs revises it:
    // a product of the lease's own running run, while that product is in progress.
    const resumed = await enableListings(S);
    const token = await storeCredential("storeinst_runs");
    const resolveAs = (ref, subject, productId, user = "morrow_vault_broker") => {
      const r = db.tryRun(
        `SELECT outcome||'|'||COALESCE(installation_id,'') FROM morrow_vault.shopify_read_resolve(${literal(ref.leaseId)},${literal(String(ref.generation))},${literal(subject)},'productContent',${literal(productId)});`,
        { user },
      );
      return r.ok ? last(r.stdout) : "error";
    };
    const ids = [product(81), product(82)];
    const runId = (await admit(P.A, T, admitBody(ids))).body.runId;
    const ref = leaseOf(runId);
    const queued = resolveAs(ref, runId, ids[0]);
    await ports.lease(ref, async (step) => {
      await step.run.start();
      return step.run.productBegin(0);
    });
    check(
      "R1:a_run_lease_reads_its_own_product_in_progress",
      resumed.status === 200 &&
        queued === "product_not_in_run|" &&
        resolveAs(ref, runId, ids[0]) === "resolved|storeinst_runs" &&
        ["morrow_api_worker", "morrow_connector_ingress", "morrow_runtime_executor"].every(
          (user) => resolveAs(ref, runId, ids[0], user) === "error",
        ),
      { resumed: resumed.status, queued, resolved: resolveAs(ref, runId, ids[0]) },
    );
    // Another run's id names no product of this lease; a product of this run not yet begun,
    // and a product of no run, are refused. So is a product the run already finished while
    // its lease is live (review: only a product in progress reads): product 0 fails
    // read_failed, and product 1 begins (R7 reads it).
    const other = (await admit(P.A, T, admitBody([product(83)]))).body.runId;
    const pendingRead = resolveAs(ref, runId, ids[1]);
    const finished0 = await ports.lease(ref, (step) =>
      step.run.productFinish(0, { outcome: "failed", code: "read_failed" }),
    );
    const finishedRead = resolveAs(ref, runId, ids[0]);
    const begun1 = await ports.lease(ref, (step) => step.run.productBegin(1));
    check(
      "R2:a_product_not_in_progress_in_the_run_is_refused",
      pendingRead === "product_not_in_run|" &&
        resolveAs(ref, runId, "product:999") === "product_not_in_run|" &&
        resolveAs(ref, runId, product(83)) === "product_not_in_run|" &&
        resolveAs(ref, other, ids[0]) === "subject_mismatch|" &&
        finished0.value?.outcome === "recorded" &&
        finishedRead === "product_not_in_run|" &&
        begun1.value?.outcome === "begun" &&
        resolveAs(ref, runId, ids[1]) === "resolved|storeinst_runs",
      {
        pendingRead,
        foreign: resolveAs(ref, other, ids[0]),
        finished0,
        finishedRead,
        begun1: begun1.value?.outcome,
        inProgress: resolveAs(ref, runId, ids[1]),
      },
    );
    // A read lease (the catalogue routes') never reads product content.
    const readLease = db.rows(
      `SELECT * FROM morrow_work.catalog_read_lease(${literal(S)},${literal(C)})`,
      {
        prefix: `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${literal(P.A.digest)},${literal(P.A.workspace)});\n`,
        suffix: "\nCOMMIT;",
        user: "morrow_api_worker",
      },
    )[0];
    check(
      "R3:product_content_under_a_read_lease_is_a_purpose_mismatch",
      readLease?.outcome === "opened" &&
        resolveAs(
          { leaseId: readLease.lease_id, generation: readLease.generation },
          readLease.subject_id,
          ids[0],
        ) === "purpose_mismatch|",
      readLease,
    );
    // A run whose finish released its lease reads nothing.
    const ended = (await admit(P.A, T, admitBody([product(84)]))).body.runId;
    const endedRef = leaseOf(ended);
    await ports.lease(endedRef, (step) => step.run.start());
    const endedFinish = await ports.lease(endedRef, (step) => step.run.finish("time_budget"));
    check(
      "R4:after_run_finish_released_the_lease_the_read_is_ended",
      endedFinish.value?.outcome === "ended" &&
        resolveAs(endedRef, ended, product(84)) === "ended|",
      { endedFinish },
    );
    // R5-R6 and R8-R10: the Workflow's product read is the orchestrator's own
    // createProductReader over a RuntimeBroker-shaped object whose shopifyRead is the broker's
    // reader (the reader RuntimeBroker serves, on the vault login's transport, against the
    // synthetic Shopify with the store's sealed token): a thrown read is unavailable, a reply
    // is decoded by productReadOf. The read names the run id, which the resolution requires
    // as the lease's subject (the reads are counted by the subject the broker receives).
    const shopOracle = createShopifyOracle({
      secret: "lab-runs-secret",
      clientId: createHash("md5").update(S).digest("hex"),
      shop: "lab-store-runs.myshopify.com",
      shopId: String(BigInt("0x" + sha(S).slice(0, 12)) + 1n),
    });
    shopOracle.state.tokens.push(token);
    let shopifyFailures = 0;
    // Products whose every read Shopify answers 500 (READ_REFUSED in the broker), by GID.
    const failingProducts = new Set();
    const gidOf = (init) => {
      try {
        return JSON.parse(String(init?.body ?? "null"))?.variables?.id ?? null;
      } catch {
        return null;
      }
    };
    const reader = createShopifyReader({
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
      fetch: (url, init) => {
        if (failingProducts.has(gidOf(init)))
          return Promise.resolve(new Response('{"errors":"Internal"}', { status: 500 }));
        if (shopifyFailures > 0) {
          shopifyFailures--;
          return Promise.resolve(new Response('{"errors":"Internal"}', { status: 500 }));
        }
        return shopOracle.fetch(url, init);
      },
      now: () => Date.now(),
    });
    const readsOf = new Map();
    const runtimeBroker = {
      shopifyRead(leaseId, generation, subjectId, queryName, variablesJson, budgetMs) {
        readsOf.set(subjectId, (readsOf.get(subjectId) ?? 0) + 1);
        return reader.read(
          brokerEnv,
          "runtime",
          leaseId,
          generation,
          subjectId,
          queryName,
          variablesJson,
          budgetMs,
        );
      },
    };
    const shopifyPorts = { ...ports, readProduct: createProductReader(runtimeBroker) };
    const shopifyRun = async (runIdOf) =>
      within(
        listingsRun(shopifyPorts, durable(), leaseOf(runIdOf), runIdOf),
        600000,
        "shopify read run " + runIdOf,
      );
    const contentCalls = () =>
      shopOracle.state.calls.filter((c) => JSON.stringify(c).includes("ProductContent")).length;
    const realRun = (await admit(P.A, T, admitBody(["product:101", "product:102"]))).body.runId;
    const realResult = await shopifyRun(realRun);
    const oracleProduct = shopOracle.state.catalog.products.find((p) => p.id === "101");
    const expectedSnapshot = snapshotCanonical({
      productId: "product:101",
      title: oracleProduct.title,
      descriptionHtml: oracleProduct.descriptionHtml,
      seo: { title: null, description: null },
      tags: oracleProduct.tags,
    });
    check(
      "R5:a_run_reads_its_products_through_the_brokers_shopify_read_and_proposes",
      realResult.kind === "ended" &&
        realResult.status === "succeeded" &&
        runRow(realRun).drafted === 2 &&
        readsOf.get(realRun) === 2 &&
        contentCalls() === 2 &&
        count(
          `SELECT count(*) FROM morrow_work.product_snapshots WHERE store_id=${literal(S)} AND digest=${literal(sha(expectedSnapshot))}`,
        ) === 1,
      { realResult, row: runRow(realRun), reads: readsOf.get(realRun), calls: contentCalls() },
    );
    // A read that fails once (here Shopify's 500, READ_REFUSED in the broker) is tried again
    // within the product step: the product is drafted and never counts as a failed product,
    // and no durable step retries.
    const retryRun = (await admit(P.A, T, admitBody(["product:103"]))).body.runId;
    shopifyFailures = 1;
    const retriesBefore = stepRetries.length;
    const retryResult = await shopifyRun(retryRun);
    check(
      "R6:a_read_that_fails_once_is_tried_again_within_the_step_and_never_fails_the_product",
      retryResult.kind === "ended" &&
        stepRetries.length === retriesBefore &&
        retryResult.status === "succeeded" &&
        readsOf.get(retryRun) === 2 &&
        shopifyFailures === 0 &&
        runRow(retryRun).failed === 0 &&
        runRow(retryRun).consecutive === 0 &&
        JSON.stringify(productsOf(retryRun).map((p) => [p.status, p.attempts, p.failure_code])) ===
          JSON.stringify([["drafted", 1, null]]),
      { retryResult, row: runRow(retryRun), products: productsOf(retryRun) },
    );
    // R8-R10 (review: a read refused on every try used to spend the durable step's retries
    // and fail the Workflow, with no propose and no finish). R8: Shopify answers 500 for every
    // read of one product: it fails read_failed after the step's three reads, the run's other
    // products draft, and the run proposes them and finishes; no durable step retries.
    const packedOf = (id) =>
      one(
        `SELECT count(*)::int AS drafts,count(DISTINCT proposal_id)::int AS proposals FROM morrow_work.run_drafts WHERE run_id=${literal(id)} AND status='packed'`,
      );
    const shape = (id) =>
      JSON.stringify(productsOf(id).map((p) => [p.status, p.attempts, p.failure_code]));
    const refusedRun = (
      await admit(P.A, T, admitBody(["product:104", "product:105", "product:106"]))
    ).body.runId;
    failingProducts.add("gid://shopify/Product/105");
    const refusedRetries = stepRetries.length;
    const refusedResult = await shopifyRun(refusedRun);
    failingProducts.clear();
    check(
      "R8:a_product_whose_every_read_is_refused_fails_read_failed_and_the_run_proposes_the_rest",
      refusedResult.kind === "ended" &&
        refusedResult.status === "succeeded" &&
        readsOf.get(refusedRun) === 5 &&
        stepRetries.length === refusedRetries &&
        shape(refusedRun) ===
          JSON.stringify([
            ["drafted", 1, null],
            ["failed", 0, "read_failed"],
            ["drafted", 1, null],
          ]) &&
        JSON.stringify(packedOf(refusedRun)) === JSON.stringify({ drafts: 2, proposals: 1 }) &&
        credit(refusedRun).settled === 2 * worst.credits,
      {
        refusedResult,
        reads: readsOf.get(refusedRun),
        retries: stepRetries.slice(refusedRetries),
        products: productsOf(refusedRun),
        packed: packedOf(refusedRun),
        credit: credit(refusedRun),
      },
    );
    // R9: a description over the read's 196,608-byte limit: the broker refuses the reply on
    // every try (READ_REFUSED), so the product fails read_failed (it never reaches the 64 KiB
    // too_large check) and the run's other product drafts and is proposed.
    const big = shopOracle.state.catalog.products.find((p) => p.id === "108");
    big.descriptionHtml = "<p>" + "d".repeat(200_000) + "</p>";
    const bigRun = (await admit(P.A, T, admitBody(["product:107", "product:108"]))).body.runId;
    const bigResult = await shopifyRun(bigRun);
    check(
      "R9:a_description_over_the_reads_limit_fails_read_failed_and_the_run_proposes_the_rest",
      bigResult.kind === "ended" &&
        bigResult.status === "succeeded" &&
        readsOf.get(bigRun) === 4 &&
        shape(bigRun) ===
          JSON.stringify([
            ["drafted", 1, null],
            ["failed", 0, "read_failed"],
          ]) &&
        JSON.stringify(packedOf(bigRun)) === JSON.stringify({ drafts: 1, proposals: 1 }),
      { bigResult, reads: readsOf.get(bigRun), products: productsOf(bigRun) },
    );
    // R10: one product drafted, then every read refused: three products fail read_failed, the
    // breaker they alone tripped ends the run read_unavailable ("the store couldn't be read"),
    // the fifth product never begins, and the drafted product is still proposed and settled.
    const unreadableRun = (
      await admit(
        P.A,
        T,
        admitBody(["product:109", "product:110", "product:111", "product:112", "product:113"]),
      )
    ).body.runId;
    for (const id of ["110", "111", "112", "113"])
      failingProducts.add("gid://shopify/Product/" + id);
    const unreadableResult = await shopifyRun(unreadableRun);
    failingProducts.clear();
    check(
      "R10:a_store_that_cannot_be_read_ends_the_run_read_unavailable_with_its_drafts_proposed",
      unreadableResult.kind === "ended" &&
        unreadableResult.status === "failed" &&
        runRow(unreadableRun).status === "failed" &&
        runRow(unreadableRun).ended_reason === "read_unavailable" &&
        readsOf.get(unreadableRun) === 1 + 3 * 3 &&
        shape(unreadableRun) ===
          JSON.stringify([
            ["drafted", 1, null],
            ["failed", 0, "read_failed"],
            ["failed", 0, "read_failed"],
            ["failed", 0, "read_failed"],
            ["skipped", 0, null],
          ]) &&
        JSON.stringify(packedOf(unreadableRun)) === JSON.stringify({ drafts: 1, proposals: 1 }) &&
        credit(unreadableRun).settled === worst.credits,
      {
        unreadableResult,
        row: runRow(unreadableRun),
        reads: readsOf.get(unreadableRun),
        products: productsOf(unreadableRun),
        credit: credit(unreadableRun),
      },
    );
    // R7: a stop the lease outlived (sim: a connection stop inserted with the triggers off, so
    // its revocation never ran) is stopped; "Stop AI work" itself revokes the run's lease in
    // its own transaction, so the read is then ended (R1's run, its product 1 in progress).
    const simStop = randomUUID();
    db.sql(`BEGIN; SET LOCAL session_replication_role=replica; SET LOCAL ROLE morrow_work_owner;
INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,set_by_operator_id,reason_code,reason,created_at) VALUES(${literal(O)},${literal(W)},${literal(simStop)},'connection',${literal(S)},${literal(C)},'system',NULL,NULL,NULL,'shopify_app_uninstalled','sim',date_trunc('milliseconds',clock_timestamp()));
COMMIT;`);
    const stoppedRead = resolveAs(ref, runId, ids[1]);
    db.sql(`BEGIN; SET LOCAL session_replication_role=replica; SET LOCAL ROLE morrow_work_owner;
DELETE FROM morrow_work.stop_controls WHERE id=${literal(simStop)};
COMMIT;`);
    const again = resolveAs(ref, runId, ids[1]);
    const stop = await agentsCall(P.A, "POST", listings + "/stop", {
      control: { reason: "Pause the drafts", sourceProposalRef: null },
    });
    check(
      "R7:a_stop_refuses_the_read_stopped_or_with_its_revoked_lease_ended",
      stoppedRead === "stopped|" &&
        again === "resolved|storeinst_runs" &&
        stop.status === 200 &&
        resolveAs(ref, runId, ids[1]) === "ended|",
      { stoppedRead, again, stop: stop.status, after: resolveAs(ref, runId, ids[1]) },
    );
  }

  // ---------------------------------------------------------------------------
  phase("redaction");
  {
    // X1-X9: shop/redact (M2 PR-3's connector_inbox_apply, as the connector's login) deletes a
    // store's snapshots and drafts (store_content_redact as listings-runs revises it), and it
    // races the run steps that write store content. Each store-content writer takes the
    // store's stop key shared before its run's lock and reads its lease again; shop/redact
    // holds that key exclusively from its system stop through the redaction. Six more linked
    // stores, each with the Listings agent, so each shop/redact ends only its own store; S
    // keeps its content throughout (the two-store case).
    const stores = [
      "store_runs2",
      "store_runs3",
      "store_runs4",
      "store_runs5",
      "store_runs6",
      "store_runs7",
    ].map((storeId) => {
      const installationId = storeId.replace(/^store_/, "storeinst_");
      const app = ("lab-" + storeId.replaceAll("_", "-")).slice(0, 63);
      return {
        storeId,
        connectionId:
          storeId === S2 ? "connection_runs2" : storeId.replace(/^store_/, "connection_"),
        installationId,
        app,
        shop: app + ".myshopify.com",
        shopId: String(BigInt("0x" + sha(storeId).slice(0, 12)) + 1n),
      };
    });
    // SF: the agent submit committed first (X7); SC: the completing pass and the stopped
    // run's close (X8-X9).
    const [X2, X3, X4, X5, SF, SC] = stores;
    db.admin(
      [X3, X4, X5, SF, SC]
        .map((x) =>
          storeInstallationSql({
            org: O,
            workspace: W,
            principal: P.A.principal,
            storeId: x.storeId,
            connectionId: x.connectionId,
            installationId: x.installationId,
          }),
        )
        .join("\n"),
    );
    db.admin(
      stores
        .flatMap((x) => {
          const resource = storeResource(O, W, x.storeId, x.connectionId);
          return [
            storeGrant(P.A, "catalog.products.read", ["view", "delegate"], undefined, resource),
            storeGrant(
              P.A,
              "catalog.content.propose",
              ["execute", "delegate"],
              undefined,
              resource,
            ),
            storeGrant(
              P.A,
              "catalog.content.publish",
              ["propose", "approve", "execute", "delegate"],
              undefined,
              resource,
            ),
            storeGrant(
              P.A,
              "agents.installation.activate",
              ["execute"],
              ["evaluation", "grant", "installationId", "revision"],
              resource,
            ),
          ];
        })
        .join("\n"),
    );
    const enabled = [];
    for (const x of stores) enabled.push((await enableListings(x.storeId)).status);
    await storeCredential(X2.installationId);
    const resumed = await enableListings(S);
    // The broker's record of a verified shop/redact (morrow_vault.shopify_webhook_record, in
    // the transaction that verified the signature), as the broker's login.
    const recordShopRedact = (x) => {
      const r = last(
        db.sql(
          `SELECT outcome||'|'||COALESCE(inbox_id,'') FROM morrow_vault.shopify_webhook_record(${literal(x.app)},${literal(x.shop)},'shop/redact',${literal("redact-" + randomUUID())},'2026-10',${literal(JSON.stringify({ shopId: x.shopId }))});`,
          { user: "morrow_vault_broker" },
        ),
      ).split("|");
      return r[0] === "recorded" ? r[1] : null;
    };
    const apply = (inboxId) =>
      `SELECT 'applied:'||outcome FROM morrow_work.connector_inbox_apply(${literal(inboxId)});`;
    const contentOf = (storeId) => ({
      snapshots: count(
        `SELECT count(*) FROM morrow_work.product_snapshots WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND store_id=${literal(storeId)}`,
      ),
      drafts: count(
        `SELECT count(*) FROM morrow_work.run_drafts WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND store_id=${literal(storeId)}`,
      ),
      parameters: count(
        `SELECT count(*) FROM morrow_work.proposal_parameters q JOIN morrow_work.proposals p ON p.organization_id=q.organization_id AND p.workspace_id=q.workspace_id AND p.parameters_id=q.id WHERE p.organization_id=${literal(O)} AND p.workspace_id=${literal(W)} AND p.store_id=${literal(storeId)} AND q.redacted_at IS NULL`,
      ),
    });
    const keptS = contentOf(S);
    // X1: S2 holds content of a whole run (snapshots, packed drafts, its proposal's parameters).
    const s2Run = (await admit(P.A, T, admitBody([product(91), product(92)], { storeId: S2 }))).body
      .runId;
    const s2Result = await execute(s2Run);
    const s2Content = contentOf(S2);
    check(
      "X1:six_more_stores_with_the_listings_agent_and_one_drafted_run",
      enabled.every((status) => status === 200) &&
        resumed.status === 200 &&
        s2Result.kind === "ended" &&
        s2Result.status === "succeeded" &&
        s2Content.snapshots === 2 &&
        s2Content.drafts === 2 &&
        s2Content.parameters === 1 &&
        keptS.snapshots > 0 &&
        keptS.drafts > 0 &&
        keptS.parameters > 0,
      { enabled, resumed: resumed.status, s2Result, s2Content, keptS },
    );
    // X2-X4: shop/redact first. A session applies it as the connector does and, before it
    // commits (its system stop, the leases' revocation and the redaction all done), waits
    // until a run step is blocked behind it. That step entered its lease before the stop
    // committed (enter_lease takes no row lock), then waits on the store's stop key, reads its
    // lease again once the stop commits, and writes nothing: the snapshot put (S3), the draft
    // finish (S4), the agent submit (S5). Each within the step's 1 s lock_timeout.
    const blockedBehindMe =
      "EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE NOT l.granted AND pg_catalog.pg_backend_pid()=ANY(pg_catalog.pg_blocking_pids(l.pid)))";
    const redactFirst = async (x, name, write) => {
      const inboxId = recordShopRedact(x);
      const session = db.runAsync(
        `BEGIN;
${apply(inboxId)}
DO $gate$ BEGIN
 FOR i IN 1..1500 LOOP
  EXIT WHEN ${blockedBehindMe};
  PERFORM pg_catalog.pg_sleep(0.02);
 END LOOP;
END $gate$;
SELECT 'blocked:'||${blockedBehindMe}::text;
COMMIT;`,
        { user: "morrow_connector_ingress", applicationName: name },
      );
      const deadline = Date.now() + 30000;
      let holding = false;
      while (!holding && Date.now() < deadline) {
        const r = await db.runAsync(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(name)} AND wait_event='PgSleep';`,
        );
        holding = r.ok && last(r.stdout) === "1";
        if (!holding) await sleep(25);
      }
      const written = await write();
      const applied = await session;
      return {
        inboxId,
        holding,
        written,
        applied: applied.stdout + (applied.ok ? "" : applied.stderr.slice(0, 400)),
        ok:
          applied.ok &&
          applied.stdout.includes("applied:pending") &&
          applied.stdout.includes("blocked:true"),
      };
    };
    const putRun = await prepared(X3.storeId, 93, "begun");
    const put = await redactFirst(X3, "runs_redact_x2", () =>
      ports.lease(putRun.ref, (step) => step.run.snapshotPut(0, putRun.canonical)),
    );
    check(
      "X2:a_snapshot_put_racing_shop_redact_waits_and_writes_nothing",
      putRun.steps.begun === "begun" &&
        put.holding &&
        put.ok &&
        put.written?.entered === true &&
        put.written.value?.outcome === "denied" &&
        JSON.stringify(contentOf(X3.storeId)) ===
          JSON.stringify({ snapshots: 0, drafts: 0, parameters: 0 }),
      { putRun: putRun.steps, put, content: contentOf(X3.storeId) },
    );
    const finishRun = await prepared(X4.storeId, 94, "attempted");
    const finish = await redactFirst(X4, "runs_redact_x3", () =>
      ports.lease(finishRun.ref, (step) =>
        step.run.productFinish(0, {
          outcome: "drafted",
          setCanonical: draftSet(94),
          fields: ["title"],
          flags: noFlags,
        }),
      ),
    );
    check(
      "X3:a_draft_finish_racing_shop_redact_waits_and_writes_nothing",
      finishRun.steps.put === "stored" &&
        JSON.stringify(finishRun.call) === JSON.stringify(["begun", "closed"]) &&
        finish.holding &&
        finish.ok &&
        finish.written?.entered === true &&
        finish.written.value?.outcome === "denied" &&
        JSON.stringify(contentOf(X4.storeId)) ===
          JSON.stringify({ snapshots: 0, drafts: 0, parameters: 0 }),
      { finishRun: finishRun.steps, call: finishRun.call, finish, content: contentOf(X4.storeId) },
    );
    const submitRun = await prepared(X5.storeId, 95, "drafted");
    const factsOf = (runId) => ({
      runId,
      envelopeId: one(
        `SELECT envelope_id::text AS envelope FROM morrow_work.runs WHERE id=${literal(runId)}`,
      ).envelope,
      fields: ["descriptionHtml", "title"],
      modelBudgetMs: runModelBudgetMs(4, "claude_opus_5_5", "low"),
    });
    // The agent submit's own outcome (review: proposeDrafts refuses every non-applied outcome
    // alike, so only `denied` shows the lease re-read after the stop key refused it; without
    // the interlock the submit finds its draft deleted, not_found).
    let submitOutcome = null;
    const recordingPorts = {
      ...ports,
      lease: (leaseRef, body) =>
        ports.lease(leaseRef, (step) =>
          body({
            ...step,
            run: {
              ...step.run,
              submitProposal: async (input) =>
                (submitOutcome = await step.run.submitProposal(input)),
            },
          }),
        ),
    };
    const submit = await redactFirst(X5, "runs_redact_x4", () =>
      proposeDrafts(recordingPorts, submitRun.ref, factsOf(submitRun.runId)),
    );
    check(
      "X4:an_agent_submit_racing_shop_redact_waits_and_proposes_nothing",
      submitRun.finished?.value?.outcome === "recorded" &&
        submit.holding &&
        submit.ok &&
        submitOutcome === "denied" &&
        submit.written?.kind === "proposed" &&
        submit.written.proposals === 0 &&
        submit.written.stop === "proposal_refused" &&
        count(
          `SELECT count(*) FROM morrow_work.proposals WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND store_id=${literal(X5.storeId)}`,
        ) === 0 &&
        JSON.stringify(contentOf(X5.storeId)) ===
          JSON.stringify({ snapshots: 0, drafts: 0, parameters: 0 }),
      { finished: submitRun.finished, submit, submitOutcome, content: contentOf(X5.storeId) },
    );
    // X5: the write first. A snapshot put on S2 holds the store's stop key shared until the
    // connector's shop/redact waits behind it; the write commits, and the pass then deletes
    // it with the rest of S2's content. S keeps its own (the two-store case).
    const lateRun = await prepared(S2, 96, "begun");
    const inboxS2 = recordShopRedact(X2);
    let redactS2 = null;
    const held = await ports.lease(lateRun.ref, async (step) => {
      const stored = await step.run.snapshotPut(0, lateRun.canonical);
      redactS2 = db.runAsync(apply(inboxS2), {
        user: "morrow_connector_ingress",
        applicationName: "runs_redact_x5",
      });
      const waited = await db.waitForLockWait("application_name='runs_redact_x5'", 4000);
      return { stored: stored.outcome, waited };
    });
    const afterS2 = await redactS2;
    check(
      "X5:a_snapshot_committed_first_is_deleted_by_the_pass_and_another_store_keeps_its_content",
      held.entered === true &&
        held.value.stored === "stored" &&
        held.value.waited === true &&
        afterS2.ok &&
        afterS2.stdout.includes("applied:pending") &&
        JSON.stringify(contentOf(S2)) ===
          JSON.stringify({ snapshots: 0, drafts: 0, parameters: 0 }) &&
        JSON.stringify(contentOf(S)) === JSON.stringify(keptS),
      {
        held,
        afterS2: afterS2.stdout + afterS2.stderr.slice(0, 400),
        s2: contentOf(S2),
        s: contentOf(S),
      },
    );
    // X6: S2's token destroyed (the broker, the uninstall reason the installation records),
    // the re-drive completes the request: every handler in the evidence, nothing
    // outstanding, and the deletions counted per pass (this pass deleted nothing more).
    const destroyed = last(
      db.sql(
        `SELECT morrow_vault.shopify_credential_destroy(${literal(X2.installationId)},'uninstalled');`,
        { user: "morrow_vault_broker" },
      ),
    );
    const completed = db.tryRun(apply(inboxS2), { user: "morrow_connector_ingress" });
    const request = db.rows(
      `SELECT status,evidence FROM morrow_identity.privacy_requests WHERE inbox_id=${literal(inboxS2)}`,
      { role: "morrow_identity_owner" },
    )[0];
    const handlers = request?.evidence?.handlers ?? [];
    const rowsOf = (table) => handlers.find((h) => h.table === table)?.rows;
    check(
      "X6:the_request_completes_with_every_handler_and_per_pass_deletion_counts",
      destroyed === "destroyed" &&
        completed.ok &&
        completed.stdout.includes("applied:applied") &&
        request?.status === "completed" &&
        JSON.stringify(handlers.map((h) => h.table).sort()) ===
          JSON.stringify(storeContentHandlers.map((h) => h.table).sort()) &&
        handlers
          .filter((h) =>
            ["morrow_work.product_snapshots", "morrow_work.run_drafts"].includes(h.table),
          )
          .every((h) => h.action === "delete_rows") &&
        rowsOf("morrow_work.product_snapshots") === 0 &&
        rowsOf("morrow_work.run_drafts") === 0 &&
        rowsOf("morrow_work.proposal_parameters") === 1 &&
        JSON.stringify(request.evidence.outstanding) === "[]",
      { destroyed, completed: completed.stdout, request },
    );
    // X7: the agent submit first (review: X4's order cannot show the interlock). A drafted
    // run on SF submits its proposal inside its lease and, before that transaction commits,
    // the connector's shop/redact starts and waits behind it (on the store's stop key the
    // submit holds shared). Once the submit commits, the pass empties the proposal's
    // parameters; without the interlock it would run first, find no parameters, report none
    // remaining, and the committed parameters would keep their content.
    const firstRun = await prepared(SF.storeId, 97, "drafted");
    const inboxSF = recordShopRedact(SF);
    let redactSF = null;
    let waitedSF = null;
    const submittedFirst = await proposeDrafts(
      {
        ...ports,
        lease: (leaseRef, body) =>
          ports.lease(leaseRef, async (step) => {
            const value = await body(step);
            redactSF = db.runAsync(apply(inboxSF), {
              user: "morrow_connector_ingress",
              applicationName: "runs_redact_x7",
            });
            waitedSF = await db.waitForLockWait("application_name='runs_redact_x7'", 4000);
            return value;
          }),
      },
      firstRun.ref,
      factsOf(firstRun.runId),
    );
    const afterSF = await redactSF;
    check(
      "X7:an_agent_submit_committed_first_has_its_parameters_emptied_by_the_pass",
      firstRun.finished?.value?.outcome === "recorded" &&
        submittedFirst.kind === "proposed" &&
        submittedFirst.proposals === 1 &&
        submittedFirst.stop === null &&
        waitedSF === true &&
        afterSF.ok &&
        afterSF.stdout.includes("applied:pending") &&
        count(
          `SELECT count(*) FROM morrow_work.proposals WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND store_id=${literal(SF.storeId)}`,
        ) === 1 &&
        JSON.stringify(contentOf(SF.storeId)) ===
          JSON.stringify({ snapshots: 0, drafts: 0, parameters: 0 }),
      {
        submittedFirst,
        waitedSF,
        afterSF: afterSF?.stdout + (afterSF?.stderr ?? "").slice(0, 400),
        content: contentOf(SF.storeId),
      },
    );
    // X8-X9: the pass that completes the request is also the pass that deletes content
    // (review: no completed evidence had reported a deleted row). SC's run has one product
    // proposed, one draft pending and a third product read (a snapshot, no draft) when
    // app/uninstalled stops it, so each handler's count differs; its token is destroyed,
    // then one shop/redact pass deletes everything and completes. The stopped run, closed
    // afterwards by the reconcile, still settles its proposed product's credits and accrues
    // its pending draft's attempt cost as unrecovered: it settles from run_products, never
    // from the drafts the pass deleted.
    await storeCredential(SC.installationId);
    const closeRunId = (
      await admit(
        P.A,
        T,
        admitBody([product(98), product(99), product(100)], { storeId: SC.storeId }),
      )
    ).body.runId;
    const closeRef = leaseOf(closeRunId);
    const draftAt = async (index, n) => {
      const canonical = snapshotCanonical(catalog.get("product:" + n));
      const put = await ports.lease(closeRef, async (step) => {
        const begun = await step.run.productBegin(index);
        return [begun.outcome, (await step.run.snapshotPut(index, canonical)).outcome];
      });
      const open = last(
        db.sql(
          `SELECT outcome||'|'||coalesce(call_id,'') FROM morrow_vault.model_call_begin(${literal(closeRef.leaseId)},${literal(String(closeRef.generation))},${literal(String(index))},'1','1','90000',${literal(await listingPromptDigest())},${literal(listingDraftSchemaDigest)});`,
          { user: "morrow_vault_broker" },
        ),
      ).split("|");
      const closed = last(
        db.sql(
          `SELECT outcome FROM morrow_vault.model_call_end(${literal(open[1])},'completed','end_turn',${literal("req_close" + index)},'claude-opus-5-5','900','900','300','0','0');`,
          { user: "morrow_vault_broker" },
        ),
      );
      const finished = await ports.lease(closeRef, (step) =>
        step.run.productFinish(index, {
          outcome: "drafted",
          setCanonical: draftSet(n),
          fields: ["title"],
          flags: noFlags,
        }),
      );
      return [...(put.value ?? []), open[0], closed, finished.value?.outcome].join(",");
    };
    const closeStarted = await ports.lease(closeRef, (step) => step.run.start());
    const drafted0 = await draftAt(0, 98);
    const proposed0 = await proposeDrafts(ports, closeRef, factsOf(closeRunId));
    const drafted1 = await draftAt(1, 99);
    const read2 = await ports.lease(closeRef, async (step) =>
      [
        (await step.run.productBegin(2)).outcome,
        (await step.run.snapshotPut(2, snapshotCanonical(catalog.get("product:100")))).outcome,
      ].join(","),
    );
    const heldBefore = contentOf(SC.storeId);
    const uninstall = last(
      db.sql(
        `SELECT outcome||'|'||COALESCE(inbox_id,'') FROM morrow_vault.shopify_webhook_record(${literal(SC.app)},${literal(SC.shop)},'app/uninstalled',${literal("uninstall-" + randomUUID())},'2026-10',${literal(JSON.stringify({ shopId: SC.shopId }))});`,
        { user: "morrow_vault_broker" },
      ),
    ).split("|");
    const uninstalled = db.tryRun(apply(uninstall[1]), { user: "morrow_connector_ingress" });
    const destroyedSC = last(
      db.sql(
        `SELECT morrow_vault.shopify_credential_destroy(${literal(SC.installationId)},'uninstalled');`,
        { user: "morrow_vault_broker" },
      ),
    );
    const inboxSC = recordShopRedact(SC);
    const completedSC = db.tryRun(apply(inboxSC), { user: "morrow_connector_ingress" });
    const requestSC = db.rows(
      `SELECT status,evidence FROM morrow_identity.privacy_requests WHERE inbox_id=${literal(inboxSC)}`,
      { role: "morrow_identity_owner" },
    )[0];
    const rowsSC = (table) =>
      (requestSC?.evidence?.handlers ?? []).find((h) => h.table === table)?.rows;
    check(
      "X8:the_completing_pass_reports_the_rows_it_deleted",
      closeStarted.value?.outcome === "started" &&
        drafted0 === "begun,stored,begun,closed,recorded" &&
        proposed0.kind === "proposed" &&
        proposed0.proposals === 1 &&
        drafted1 === "begun,stored,begun,closed,recorded" &&
        read2.value === "begun,stored" &&
        JSON.stringify(heldBefore) === JSON.stringify({ snapshots: 3, drafts: 2, parameters: 1 }) &&
        uninstall[0] === "recorded" &&
        uninstalled.ok &&
        uninstalled.stdout.includes("applied:applied") &&
        destroyedSC === "destroyed" &&
        completedSC.ok &&
        completedSC.stdout.includes("applied:applied") &&
        requestSC?.status === "completed" &&
        rowsSC("morrow_work.product_snapshots") === heldBefore.snapshots &&
        rowsSC("morrow_work.run_drafts") === heldBefore.drafts &&
        rowsSC("morrow_work.proposal_parameters") === heldBefore.parameters &&
        JSON.stringify(requestSC.evidence.outstanding) === "[]" &&
        JSON.stringify(contentOf(SC.storeId)) ===
          JSON.stringify({ snapshots: 0, drafts: 0, parameters: 0 }),
      {
        closeStarted: closeStarted.value?.outcome,
        drafted0,
        proposed0,
        drafted1,
        read2: read2.value,
        heldBefore,
        uninstall,
        uninstalled: uninstalled.stdout + uninstalled.stderr.slice(0, 400),
        destroyedSC,
        completed: completedSC.stdout + completedSC.stderr.slice(0, 400),
        request: requestSC,
      },
    );
    const reconcileSC = await call(runsOn, P.A, "POST", "/runs-reconcile", {});
    const closedRow = runRow(closeRunId);
    const lost = db.rows(
      `SELECT id::text AS id,kind,amount_usd::text AS amount FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(closeRunId)} ORDER BY id`,
    );
    const vendorLost = one(
      `SELECT unrecovered_cost_usd::text AS amount FROM morrow_billing.vendor_cost_reservations WHERE root_run_id=${literal(closeRunId)}`,
    );
    check(
      "X9:a_run_stopped_before_shop_redact_settles_its_proposed_products_after_the_pass",
      reconcileSC.status === 200 &&
        reconcileSC.body.closed >= 1 &&
        closedRow.status === "cancelled" &&
        closedRow.status_guard === "submitted_effects_reconciled" &&
        closedRow.ended_reason === "stopped" &&
        credit(closeRunId)?.status === "settled" &&
        credit(closeRunId)?.settled === worst.credits &&
        JSON.stringify(lost) ===
          JSON.stringify([
            { id: closeRunId + ":1:1", kind: "failed_product", amount: completedCost },
          ]) &&
        Number(vendorLost?.amount) === Number(completedCost) &&
        JSON.stringify(productsOf(closeRunId).map((p) => [p.status, p.failure_code])) ===
          JSON.stringify([
            ["drafted", null],
            ["drafted", null],
            ["failed", "interrupted"],
          ]) &&
        count(
          `SELECT count(*) FROM morrow_work.run_products WHERE run_id=${literal(closeRunId)} AND proposal_id IS NOT NULL`,
        ) === 1,
      {
        reconcile: reconcileSC.body,
        row: closedRow,
        credit: credit(closeRunId),
        lost,
        vendorLost,
        products: productsOf(closeRunId),
      },
    );
  }

  // ---------------------------------------------------------------------------
  phase("operator_entitlement");
  {
    // T1-T2: a staging operator test entitlement (migrations 0034-0035; the ADR-0022 item 5
    // amendment) fixes the route and writes the account, the wallet and one snapshot keyed
    // morrow:operator_entitlement:<id>, valid for its period, and no verified payment event.
    // Its billing period is that snapshot's (billing-entitlements.md), as the api's
    // billingPeriodLatest reads it, so admission and the run's billing facts read the same
    // two sources. Sim, and the lab's last phase: W's payment events are removed and its route
    // and latest snapshot name an operator grant, with the triggers off (lab:test-entitlement
    // proves the grant that writes them). R7's "Stop AI work" on S was lifted by the redaction
    // phase's enable, so S's Listings agent is enabled here; a second enable would answer 400.
    // The admission below (201, queued) is what proves it.
    const grantKey = "morrow:operator_entitlement:" + randomUUID();
    const revision = count(
      `SELECT max(revision) FROM morrow_billing.entitlement_snapshots WHERE billing_account_id=${literal(account)}`,
    );
    replica(`DELETE FROM morrow_billing.verified_payment_events WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};
UPDATE morrow_billing.workspace_billing_routes SET fixing_payment_key=${literal(grantKey)} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};
INSERT INTO morrow_billing.entitlement_snapshots VALUES(${literal(O)},${literal(W)},${literal(account)},${revision + 1},'morrow_direct','test',${literal(grantKey)},'active',${literal("f".repeat(64))},${ms}-interval '2 hours',${ms}+interval '29 days',NULL,${ms});`);
    if (wallet().available < 2)
      replica(
        `UPDATE morrow_billing.credit_wallets SET available=available+2 WHERE billing_account_id=${literal(account)};`,
      );
    const payments = count(
      `SELECT count(*) FROM morrow_billing.verified_payment_events WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)}`,
    );
    const snapshot = one(
      `SELECT verified_at::text AS start,valid_until::text AS "end",extract(epoch FROM verified_at)*1000 AS start_ms,extract(epoch FROM valid_until)*1000 AS end_ms FROM morrow_billing.entitlement_snapshots WHERE billing_account_id=${literal(account)} AND subscription_key=${literal(grantKey)}`,
    );
    const ids = [product(131)];
    const admitted = await admit(P.A, T, admitBody(ids));
    const runId = admitted.body.runId ?? "";
    const runPeriod = one(
      `SELECT r.period_start=s.verified_at AS same FROM morrow_work.runs r JOIN morrow_billing.entitlement_snapshots s ON s.organization_id=r.organization_id AND s.workspace_id=r.workspace_id AND s.billing_account_id=r.billing_account_id AND s.subscription_key=${literal(grantKey)} WHERE r.id=${literal(runId)}`,
    );
    check(
      "T1:an_operator_entitled_workspace_admits_a_run_in_the_snapshot_period",
      payments === 0 &&
        snapshot !== null &&
        admitted.status === 201 &&
        admitted.body.status === "queued" &&
        runPeriod?.same === true &&
        credit(runId)?.status === "reserved",
      { payments, snapshot, admitted: admitted.body, runPeriod },
    );
    // The run's billing facts (run_billing_facts under its lease) carry the snapshot's period,
    // and the run drafts, proposes and settles through the agent kernel's entitlement.
    const facts =
      admitted.status === 201
        ? await ports.lease(leaseOf(runId), (step) => step.run.billingFacts())
        : null;
    const period = facts?.value?.billingPeriodLatest ?? [];
    const result = admitted.status === 201 ? await execute(runId) : null;
    check(
      "T2:the_run_billing_facts_carry_the_snapshot_period_and_the_run_succeeds",
      facts?.entered === true &&
        period.length === 1 &&
        Date.parse(period[0].period_start) === Number(snapshot?.start_ms) &&
        Date.parse(period[0].period_end) === Number(snapshot?.end_ms) &&
        result?.kind === "ended" &&
        result.status === "succeeded" &&
        runRow(runId)?.status === "succeeded" &&
        credit(runId)?.status === "settled" &&
        credit(runId).settled === 2,
      { facts: facts?.value ? period : facts, snapshot, result, row: runRow(runId) },
    );
  }
  return { checks, failures, retries };
}

async function main() {
  const started = Date.now();
  let result;
  phase("engine_and_migrations");
  try {
    await withWorkDatabase(
      "M3.PR2.listings-runs",
      async (db) => {
        result = await runListingsRunsLab(db);
      },
      { administrator: "createrole" },
    );
  } catch (error) {
    console.error("RUNS_LAB_FAILED_IN:" + stage);
    throw error;
  }
  phase("report");
  writeArtifact("labs/listings-runs.json", {
    task: "M3 PR-2",
    qualification: "local_postgresql17_network_none_listings_runs",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    unavailableRetries: result.retries,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "The runs handler, the Workflow logic and the broker's gateway run in Node over psql connectors (morrow_api_worker, morrow_runtime_executor, morrow_vault_broker), not in workerd over the Neon transport; the Messages API is an in-process stand-in.",
      "Most runs' product read is a lab stand-in for M2 PR-3's shopifyRead productContent; R5-R6 and R8-R10 use the orchestrator's createProductReader over the broker's own reader in Node (a RuntimeBroker-shaped object, not the RPC) against the synthetic Shopify oracle, and the R cases call the vault resolution directly as the broker's login. The workerd leg with the Shopify and Anthropic oracles is open.",
      "The shop/redact deliveries are recorded through the broker's own definer (morrow_vault.shopify_webhook_record) without the signature check, which lab:shopify-privacy covers; the sim connection stop of R5 is inserted with the triggers off.",
      "M5's billing records (route, account, entitlement, period, wallet) are owner-seeded with the triggers off (sim); lab:billing proves the receipt path that writes them.",
      "Durable steps are an in-process stand-in for Cloudflare Workflows' step.do (a RunStepRetry is retried; results cross a JSON boundary).",
    ],
  });
  if (result.failures.length) {
    print("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else print(`PASS: ${result.checks.length} M3 PR-2 listings run checks.`);
}

await main();
