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
//   B  refusals persist nothing: entitlement, credits, the member ceiling, the run product
//      limit, an unknown selection, a foreign task and an inactive installation; run reads
//      need view on task.read and on the run's store (another tenant, a grantless member and
//      a member without the store read see no run; the grantless member cannot reconcile);
//   W  a run: products read, drafted through the gateway, checked in code, proposed as one
//      catalog.content.publish Proposal@2 by the installation's agent on behalf of the
//      requester, credits settled at the products proposed, cost booked from the catalogue's
//      rates, the lease released; durable step results carry ids and codes only;
//   M  the selection: none is the workspace default; a member picks Opus high once the owner
//      raises the ceiling; xhigh is refused;
//   O  item 10's outcomes in one run: a refusal then a draft, a throttle resent within the
//      attempt, an input over the cap never sent, invalid output twice (failed, accrued as
//      unrecovered), an uncertain send booked at its worst case, a draft steered to another
//      product (product_mismatch, twice);
//   E  a spend limit ends the run (drafted work is still proposed); K the three-failure breaker;
//   U  the unrecovered-cost cap stops a running run before its next product and refuses
//      admission;
//   F  the fence as the broker's login: replay, in flight, one open call per run, attempts,
//      digests, closed inputs, a reply from another model, cost overflow never dropped and the
//      run stopped, a spent reservation refused at the fence with no request, forged settings
//      reaching nothing and no other login executing it;
//   D  one lock order (the workspace stream, then the run, then the rest): a run finishing or
//      starting while a session holds the stream as an admission or a stop does waits on
//      the stream first, and neither deadlocks;
//   P  the pending approvals cap: admission refuses a run whose proposals could not fit, and
//      a proposal refused at the cap ends the run promptly (proposal_refused), never a
//      retried step;
//   S  "Stop AI work" mid-run: the next step is refused, the run reads as interrupted, and
//      the stale close returns its credits and accrues its cost; admission is refused; a
//      call in flight at the stop is still recorded and booked (its close needs no lease);
//      a fence a dead broker left open is booked as uncertain at its worst case, and a late
//      close is refused (never promoted to success);
//   L  no provider id, model id, stop reason, request text, product or draft content reaches
//      the api's reads, the outbox or a durable step result.
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
import { listingsRun, RunStepRetry } from "../packages/work/src/runs/workflow.ts";
import { createRuntimeAttempt, runLeaseStep } from "../packages/work/src/runtime/leases.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { createClaudeAdapter } from "../apps/broker/src/claude-adapter.ts";
import { createModelGateway, listingPromptDigest } from "../apps/broker/src/model-gateway.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
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
      id: "g_" + p.key.toLowerCase() + "_" + capabilityId.replaceAll(".", "_"),
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
    async readProduct(_ref, productId) {
      const p = catalog.get(productId);
      return p ? { outcome: "read", product: structuredClone(p) } : { outcome: "not_found" };
    },
    environment: "development",
    now: () => Date.now(),
    sleep: (wait) => sleep(Math.min(wait, 50)),
    ids: () => randomUUID(),
  };
  // A Workflow's durable steps: a RunStepRetry is retried (as the orchestrator's step.do with
  // four retries), results cross a JSON boundary, and every result is kept for the L checks.
  const stepResults = [];
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
        }
      }
    },
  });
  const admitBody = (products, over = {}) => ({
    storeId: S,
    products,
    fields: ["descriptionHtml", "title"],
    selection: { model: "claude_sonnet_5_5", effort: "low" },
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
    "SELECT input_usd8_per_token::int AS input,output_usd8_per_token::int AS output FROM morrow_work.model_catalogue_rates WHERE version=1 AND model_key='claude_sonnet_5_5'",
  );
  const worst = one(
    "SELECT worst_case_per_attempt_usd::text AS attempt,worst_case_per_product_usd::text AS product,credits_per_product::int AS credits FROM morrow_work.model_catalogue_entries WHERE version=1 AND model_key='claude_sonnet_5_5' AND effort_key='low'",
  );
  const completedUnits = 900 * rates.input + 300 * rates.output;
  const completedCost = usd8(completedUnits);
  async function execute(runId, hooks) {
    return within(listingsRun(ports, durable(hooks), leaseOf(runId)), 600000, "run " + runId);
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
        String(admitted.body.creditsReserved) === "3" &&
        run?.status === "queued" &&
        run.status_actor === "work_service" &&
        run.model_key === "claude_sonnet_5_5" &&
        run.effort_key === "low" &&
        run.cpp === 1 &&
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
        manifest.provider_model_id === "claude-sonnet-5-5" &&
        manifest.unbound === true &&
        credit(happyRun)?.status === "reserved" &&
        credit(happyRun).reserved === 3 &&
        wallet().available === 297 &&
        wallet().reserved === 3 &&
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
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=1 WHERE billing_account_id=${literal(account)};`,
    );
    const poor = await admit(P.A, T, admitBody(["product:1", "product:2"]));
    replica(
      `UPDATE morrow_billing.credit_wallets SET available=297 WHERE billing_account_id=${literal(account)};`,
    );
    check(
      "B2:insufficient_credits_409",
      poor.status === 409 && poor.body.code === "budget_exhausted" && footprint() === before2,
      poor.body,
    );
    // A member above the default ceiling (1 credit per product): Sonnet medium costs 2.
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
      admitBody(["product:1"], { selection: { model: "claude_sonnet_5_5", effort: "medium" } }),
    );
    check(
      "B3:member_above_ceiling_403",
      above.status === 403 &&
        above.body.safeMessage === "That model or effort is above your workspace's limit." &&
        footprint() === before3,
      above.body,
    );
    // Opus high admits at most nine products (US$7 per run).
    const limit = await admit(
      P.A,
      T,
      admitBody(
        Array.from({ length: 10 }, (_, i) => "product:" + (100 + i)),
        { selection: { model: "claude_opus_5_5", effort: "high" } },
      ),
    );
    check(
      "B4:run_product_limit_409",
      limit.status === 409 &&
        limit.body.safeMessage === "Too many products for this model and effort." &&
        footprint() === before3,
      limit.body,
    );
    const unknown = await admit(
      P.A,
      T,
      admitBody(["product:1"], { selection: { model: "claude_unknown", effort: "low" } }),
    );
    check(
      "B5:unknown_selection_400",
      unknown.status === 400 && unknown.body.code === "missing_input" && footprint() === before3,
      unknown.body,
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
        credit(happyRun).settled === 3 &&
        wallet().consumed === 3 &&
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
        oracle.requests.every((r) => r.model === "claude-sonnet-5-5"),
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
        finishedRead.body.credits.settled === 3 &&
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
    // M1: no selection is the workspace default (Sonnet low, 1 credit), within A1's ceiling.
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
        defaulted.body.selection.model === "claude_sonnet_5_5" &&
        defaulted.body.selection.effort === "low" &&
        defaulted.body.creditsReserved === 1,
      defaulted.body,
    );
    // M2: the owner raises the ceiling to 6; the member may then pick Opus high.
    const raised = await agentsCall(P.A, "PUT", "/settings/model-default", {
      model: "claude_sonnet_5_5",
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
        credit(defaulted.body.runId)?.settled === 1 &&
        credit(opus.body.runId)?.settled === 6 &&
        oracle.requests.some((r) => r.model === "claude-opus-5-5"),
      { ended },
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
      credit(runId)?.status === "settled" && credit(runId).settled === 3,
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
        credit(runId)?.settled === 1,
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
    // U1: once this period's unrecovered cost plus one product's worst case would pass the
    // cap (US$4.50), a running run stops before its next product and admission refuses new
    // runs until the next period. The ledger is raised near the cap (sim), then restored.
    const ids = [product(91), product(92)];
    const admitted = await admit(P.A, T, admitBody(ids));
    const runId = admitted.body.runId;
    const saved = one(
      `SELECT period_start::text AS period,amount_usd::text AS amount FROM morrow_billing.unrecovered_costs WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)}`,
    );
    replica(
      `UPDATE morrow_billing.unrecovered_costs SET amount_usd=4.45 WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};`,
    );
    const result = await execute(runId);
    const refused = await admit(P.A, T, admitBody([product(93)]));
    replica(
      `UPDATE morrow_billing.unrecovered_costs SET amount_usd=${saved.amount} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};`,
    );
    check(
      "U1:the_unrecovered_cost_cap_stops_the_run_and_refuses_admission",
      result.kind === "ended" &&
        result.status === "failed" &&
        runRow(runId).ended_reason === "unrecovered_cost_cap" &&
        oracle.sends(ids[0]) === 0 &&
        credit(runId)?.status === "released" &&
        refused.status === 409 &&
        refused.body.safeMessage ===
          "Too many products failed this billing period. Drafting resumes next period.",
      { result, run: runRow(runId), refused: refused.body },
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
    const end = (callId, outcome, usage, model = "claude-sonnet-5-5") =>
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
        `SELECT outcome||'|'||coalesce(recorded_outcome,'') FROM morrow_vault.model_call_end(${literal(open[1])},'completed','end_turn','req_late','claude-sonnet-5-5','900','900','300','0','0');`,
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
      "claude-sonnet-5-5",
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
      "The product read is a lab stand-in for M2 PR-3's shopifyRead productContent; the orchestrator keeps dispatch disabled until it lands.",
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
