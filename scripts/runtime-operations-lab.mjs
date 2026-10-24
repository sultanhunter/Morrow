// Build order PR 7 PostgreSQL 17 laboratory: the computer's operation ledger (migration
// runtime-operations, 0043) on an isolated network-none engine, the full manifest applied by
// the Neon-shaped non-superuser CREATEROLE administrator (ADR-0020 D4). It drives the broker's
// real runtime gateway (apps/broker/src/runtime-gateway.ts) over the vault login's real
// transport (runVaultTransactionWithDriver) and the vault ledger
// (apps/broker/src/runtime-ledger.ts), with the deterministic fake adapter
// (apps/broker/src/runtime-fake.ts) as the provider. No provider is reached. It proves:
//   A  fixtures: an entitled workspace, the Listings installation and a running Listings run
//      under its run lease (the runs handler and the runtime executor's lease steps);
//   C  runtime.execution.use: the Listings release does not declare it, so the send mark
//      refuses (capability_missing) and nothing is written, booked or created;
//   J  a job on a release that declares it: the send mark commits first (sending, booked at
//      the worst case as sandbox_compute on the run's vendor reservation, the platform's open
//      count and month moved), one create, the job, the checked outputs, the kill, settled
//      killed; the result carries no sandbox id, token or key; the same run and call key
//      again never creates (replay);
//   U  a lost create is unknown_effect with a runtime hold that refuses every create; the
//      sweep sees only stale operations, finds the sandbox by its metadata and kills it, and
//      never lifts the hold; only the owner's operator function lifts it (never the broker's
//      login or any runtime login);
//   N  not_found alone is never deletion: unqualified it stays unknown_effect, the definer
//      refuses absent_verified before the deadline plus the grace (too_early), and only a
//      qualified sweep past the grace settles absent_verified;
//   K  the caps in SQL: three open sandboxes per workspace, the platform's concurrency, the
//      monthly budget (a new month starts at zero) and the run's vendor reservation each
//      refuse before any row; not_created settles only a `sending` operation;
//   L  the lease: another generation is not_found, a queued run is run_inactive, and "Stop AI
//      work" refuses the send mark while the sweep still kills a stopped run's sandbox;
//   G  the guards and grants: the broker's login holds no table privilege, no other login
//      executes its definers, a terminal operation never changes, nothing is deleted, the
//      sweep's list is ids only, and the settle definer's edges hold; the ledger's tables are
//      morrow_work's, so the vault keeps its two sealed-secret tables only, and the ledger's
//      ACL is exactly the command role's.
// Build order PR 8 (migration 0047, runtime-e2b) adds:
//   J5 the sandbox's envd token is a sealed vault record while the job runs (never the
//      plaintext) and the kill's settlement destroys it;
//   T  the token definers: stored once, only while `created`; opened only then; any
//      settlement destroys it (sandbox_killed, sandbox_absent, sandbox_unknown); only the
//      broker's login executes them; the credentials constraints keep E2B and Shopify rows
//      apart;
//   L2 (revised) a stop makes its run's open operations `stopped` in the sweep's list, stale or
//      not, and the very next sweep kills their sandboxes and destroys their tokens.
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data. Shapes
// marked sim stand in for states no API path reaches yet. CI pg-work group.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createAgentsApiHandler } from "../packages/work/src/agents/http.ts";
import { createWorkApiHandler } from "../packages/work/src/http.ts";
import { createRunsApiHandler } from "../packages/work/src/runs/http.ts";
import { createRuntimeAttempt, runLeaseStep } from "../packages/work/src/runtime/leases.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { createFakeRuntime } from "../apps/broker/src/runtime-fake.ts";
import { createRuntimeGateway } from "../apps/broker/src/runtime-gateway.ts";
import { createVaultRuntimeLedger } from "../apps/broker/src/runtime-ledger.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import {
  computerProfile,
  runtimeCaps,
  runtimeJobCanonical,
  parseRuntimeJob,
} from "../packages/policy/src/runtime-computer.ts";
import {
  literal,
  seedWorkFixtures,
  sleep,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
} from "../tests/tenant-conformance/harness.mjs";
import { makePng, makeXlsx } from "../tests/fixtures/runtime-files.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const checks = [];
const failures = [];
const labStarted = Date.now();
let stage = "start";
const phase = (value) => {
  stage = value;
  console.error(
    "RUNTIME_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
};
function within(promise, timeoutMs, wait) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("RUNTIME_LAB_STALLED:" + stage + ":" + wait)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("RUNTIME_LAB_CHECK_NAME:" + name);
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

export async function runRuntimeOperationsLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  const O = P.A.org,
    W = P.A.workspace;
  const S = "store_computer",
    C = "connection_computer";
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
    if (!validateCurrentDefinition("Grant", g)) throw Error("RUNTIME_LAB_GRANT_INVALID");
    return `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(O)},${literal(W)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`;
  }
  db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_computer','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(P.A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_computer',${literal(O)},${literal(W)},${literal(P.A.membership)},'owner-bootstrap-v1',clock_timestamp());`);
  db.admin(
    [
      storeGrant(P.A, "catalog.products.read", ["view", "delegate"]),
      storeGrant(P.A, "catalog.content.propose", ["execute", "delegate"]),
      storeGrant(P.A, "catalog.content.publish", ["propose", "approve", "execute", "delegate"]),
      storeGrant(
        P.A,
        "agents.installation.activate",
        ["execute"],
        ["evaluation", "grant", "installationId", "revision"],
      ),
    ].join("\n"),
  );
  // M5's billing records of an entitled Morrow-direct workspace (sim: owner-seeded with the
  // triggers off, as lab:listings-runs does; lab:billing proves the receipt path).
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
      throw Error("RUNTIME_LAB_FIXTURE_FAILED:" + stage);
    }
    return r.stdout;
  };
  replica(`INSERT INTO morrow_billing.workspace_billing_routes VALUES(${literal(O)},${literal(W)},'website',NULL,NULL,NULL,NULL,NULL,1,${ms},${ms}) ON CONFLICT DO NOTHING;
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',created_at=${ms}-interval '2 days',route_fixed_at=${ms}-interval '1 day',fixing_payment_key='stripe:invoice:in_LabComputer0001',revision=2,updated_at=${ms} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};
INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},'morrow_direct','test','USD','active',1,${ms},${ms});
INSERT INTO morrow_billing.stripe_event_receipts(organization_id,workspace_id,id,event_id,event_type,livemode,mode,object_type,object_id,customer_id,object,object_digest,observed_at,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(receipt)},'evt_labcomputer001','invoice.paid',false,'test','invoice','in_LabComputer0001',NULL,'{"kind":"invoice","id":"in_LabComputer0001","livemode":false}'::jsonb,${literal("d".repeat(64))},${ms},${ms});
INSERT INTO morrow_billing.entitlement_snapshots VALUES(${literal(O)},${literal(W)},${literal(account)},1,'morrow_direct','test','stripe:sub:sub_LabComputer001','active',${literal("c".repeat(64))},${ms}-interval '1 hour',${ms}+interval '29 days',${literal(receipt)},${ms});
INSERT INTO morrow_billing.verified_payment_events(organization_id,workspace_id,id,route,mode,payment_key,kind,subscription_key,price_key,period_start,period_end,operation_id,amount,currency,provider_evidence_ref,verified_at,outcome,outcome_code,receipt_id,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},'morrow_direct','test','stripe:invoice:in_LabComputer0001','subscription_period','stripe:sub:sub_LabComputer001','stripe:price:price_MorrowDevBeta0049',${ms}-interval '1 day',${ms}+interval '29 days',${literal(randomUUID())},'49','USD',${literal("e".repeat(64))},${ms}-interval '1 hour','granted',NULL,${literal(receipt)},${ms});
INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,terms_revision,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},300,0,0,1,1,2,${ms},${ms});`);
  db.admin(
    storeInstallationSql({
      org: O,
      workspace: W,
      principal: P.A.principal,
      storeId: S,
      connectionId: C,
      installationId: "storeinst_computer",
    }),
  );
  const count = (query) => Number(last(db.sql(`SELECT (${query})::bigint;`)));
  const one = (query) => db.rows(query)[0] ?? null;

  // The handlers.
  const ctx = { waitUntil() {} };
  const runsOn = createRunsApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
    environment: "development",
    admission: true,
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
  async function call(handler, p, method, path, body) {
    const key = randomUUID();
    for (let n = 1; ; n++) {
      console.log = () => {};
      let response;
      try {
        response = await within(
          handler.fetch(workRequest(p, method, path, body, { key }), undefined, ctx),
          60000,
          "request",
        );
      } finally {
        console.log = print;
      }
      const reply = { status: response.status, body: JSON.parse(await response.text()) };
      if (reply.status === 503 && reply.body.code === "unavailable" && n < 4) {
        await sleep(250);
        continue;
      }
      return reply;
    }
  }
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
  const goal = await call(workApi, P.A, "POST", "/goals", {
    objective: "Understand the catalogue",
    storeIds: [],
    successCriteria: [
      { description: "Done", verificationCapabilityId: null, evidenceRequired: false },
    ],
  });
  const T = (
    await call(workApi, P.A, "POST", "/tasks", {
      goalId: goal.body.goalId,
      objective: "Chart the catalogue's prices and stock for the summer review",
      allowedResources: [],
    })
  ).body.taskId;
  const listings = `/stores/${S}/agents/listings`;
  const document = await agentsCall(P.A, "POST", listings + "/document", {});
  const enabled = await agentsCall(P.A, "POST", listings, {
    documentDigest: document.body.documentDigest,
    nonce: document.body.nonce,
  });
  const installation = one(
    `SELECT id::text AS id,status,release_id,release_revision::int AS revision FROM morrow_work.agent_installations WHERE store_id=${literal(S)}`,
  );
  // The runtime executor's pool, as the orchestrator builds it.
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
  const lease = async (ref, body) => {
    const attempt = createRuntimeAttempt(30000, new AbortController().signal);
    try {
      const result = await within(runLeaseStep(runtimePool, attempt, ref, body), 120000, "lease");
      return result.ok ? result.value : "failed";
    } finally {
      attempt.end();
    }
  };
  const admit = (products) =>
    call(runsOn, P.A, "POST", "/tasks/" + T + "/runs", {
      storeId: S,
      products,
      fields: ["descriptionHtml", "title"],
      selection: { model: "claude_sonnet_5_5", effort: "low" },
    });
  const leaseOf = (runId) => {
    const r = one(
      `SELECT lease_id::text AS lease_id,lease_generation::int AS generation FROM morrow_work.runs WHERE id=${literal(runId)}`,
    );
    return { leaseId: r.lease_id, generation: r.generation };
  };
  // A running run: admitted, then started under its lease (ListingsRunWorkflow's first step).
  async function runningRun(products) {
    const admitted = await admit(products);
    const runId = admitted.body.runId;
    const started = await lease(leaseOf(runId), (step) => step.run.start());
    return { runId, ref: leaseOf(runId), admitted, started };
  }
  // Five products: the vendor reservation (five times Sonnet low's worst case) holds every
  // sandbox this lab books.
  const main = await runningRun(["product:1", "product:2", "product:3", "product:4", "product:5"]);
  // A second run left queued (admitted, never started) for the lease phase.
  const queued = (await admit(["product:9"])).body.runId;
  const runState = (runId) =>
    one(`SELECT status FROM morrow_work.runs WHERE id=${literal(runId)}`)?.status;
  check(
    "A1:fixtures_a_running_run_under_its_lease",
    typeof T === "string" &&
      document.status === 201 &&
      enabled.status === 200 &&
      installation?.status === "active" &&
      installation.release_id === "morrow.listings" &&
      main.admitted.status === 201 &&
      main.started !== "failed" &&
      main.started.entered === true &&
      runState(main.runId) === "running" &&
      runState(queued) === "queued",
    { installation, admitted: main.admitted.body, started: main.started },
  );

  // The broker: the runtime switch on, the vault login over this engine, the fake adapter.
  const e2bKey = "e2b_" + randomBytes(20).toString("hex");
  const binding = {
    schemaVersion: 1,
    environment: "development",
    projectId: "morrow-runtime-lab",
    branchId: "br-runtime-lab",
    hostname: "ep-runtime-lab.c-14.us-east-1.aws.neon.tech",
    database: "morrow",
  };
  const brokerEnv = {
    MORROW_ENVIRONMENT: "development",
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
    MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "lab-vault-" + randomBytes(12).toString("hex"),
    MORROW_VAULT_KEK_V1: randomBytes(32).toString("hex"),
    MORROW_RUNTIME_SWITCH: "on",
    E2B_API_KEY: e2bKey,
  };
  const capabilities = await brokerCapabilities(brokerEnv);
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
  const transaction = (vault, budgetMs, body) =>
    runVaultTransactionWithDriver(
      vaultDriver,
      vault,
      Math.min(10000, budgetMs),
      body,
      Date.now,
      class {
        close() {}
      },
    );
  const fake = createFakeRuntime({ credential: e2bKey, now: () => Date.now() });
  // PR 8: the fake as the gateway sees it, with a look at the vault while each command runs.
  let duringExec = null;
  const watched = Object.freeze({
    provider: fake.provider,
    create: (...a) => fake.create(...a),
    status: (...a) => fake.status(...a),
    writeFile: (...a) => fake.writeFile(...a),
    readFile: (...a) => fake.readFile(...a),
    kill: (...a) => fake.kill(...a),
    exec: async (sandbox, ...rest) => {
      if (duringExec) duringExec(sandbox);
      return fake.exec(sandbox, ...rest);
    },
  });
  const gatewayOf = (qualified) =>
    createRuntimeGateway({
      ledger: (vault) => createVaultRuntimeLedger(vault, transaction),
      providers: Object.freeze({ e2b: watched }),
      now: () => Date.now(),
      template: "morrow-computer-fake-v1",
      qualified,
    });
  const gateway = gatewayOf(false);
  const qualifiedGateway = gatewayOf(true);
  const brokerLines = [];
  const quiet = async (fn) => {
    console.log = (line) => brokerLines.push(String(line));
    try {
      return await fn();
    } finally {
      console.log = print;
    }
  };
  // One execute: the parsed RuntimeResult@1, or {held: code} for BROKER_HELD.
  const execute = (job, over = {}) =>
    quiet(async () => {
      try {
        return JSON.parse(
          await within(
            (over.gateway ?? gateway).runtimeExecute(
              brokerEnv,
              over.ref?.leaseId ?? main.ref.leaseId,
              over.ref?.generation ?? main.ref.generation,
              JSON.stringify(job),
              300000,
            ),
            400000,
            "execute",
          ),
        );
      } catch (error) {
        if (error?.message !== "BROKER_HELD") throw error;
        const code = brokerLines
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return {};
            }
          })
          .filter((r) => r.event === "morrow_broker" && r.method === "runtimeExecute")
          .at(-1)?.code;
        return { held: code ?? null };
      }
    });
  const sweep = (g = gateway) =>
    quiet(async () => JSON.parse(await within(g.runtimeSweep(brokerEnv, 120000), 200000, "sweep")));
  const directive = (path, bytes) =>
    "#!fake write " + path + " " + Buffer.from(bytes).toString("base64");
  const job = (callKey, script) => ({
    schemaVersion: 1,
    kind: "python_analysis",
    callKey,
    script:
      script ??
      [
        "#!fake stdout charted 1 product",
        directive("/home/agent/output/chart.png", makePng()),
        directive("/home/agent/output/table.csv", Buffer.from("sku,note\nA1,=1+2\n")),
        directive("/home/agent/output/book.xlsx", makeXlsx()),
      ].join("\n") + "\n",
    inputs: [
      {
        name: "products",
        kind: "products",
        rows: [
          [
            "7001",
            "Linen shirt",
            null,
            null,
            "active",
            null,
            1,
            "10.00",
            "10.00",
            4,
            "2026-10-01T00:00:00Z",
            "2026-10-02T00:00:00Z",
          ],
        ],
      },
    ],
    outputs: [
      { name: "chart", type: "png" },
      { name: "table", type: "csv" },
      { name: "book", type: "xlsx" },
    ],
  });
  const ops = (runId = main.runId) =>
    db.rows(
      `SELECT id::text AS id,call_key,status,unknown_reason AS reason,provider,sandbox_ref,worst_case_usd::text AS worst,booking_id,job_digest::text AS digest,installation_id::text AS installation,settled_at IS NOT NULL AS settled,deadline_at-send_started_at AS span FROM morrow_work.runtime_operations WHERE run_id=${literal(runId)} ORDER BY send_started_at,id`,
    );
  const op = (id) =>
    one(
      `SELECT status,unknown_reason AS reason,sandbox_ref,settled_at IS NOT NULL AS settled,revision::int AS revision FROM morrow_work.runtime_operations WHERE id=${literal(id)}`,
    );
  const capacity = () =>
    one(
      "SELECT open_operations::int AS open,budget_month::text AS month,month_committed_usd::text AS committed FROM morrow_work.runtime_capacity",
    );
  const holds = (active = true) =>
    db.rows(
      `SELECT id::text AS id,reason,operation_id::text AS operation FROM morrow_work.runtime_holds${active ? " WHERE lifted_at IS NULL" : ""} ORDER BY created_at,id`,
    );
  const bookings = (runId = main.runId) =>
    db.rows(
      `SELECT id,kind,amount_usd::text AS amount FROM morrow_billing.run_cost_bookings WHERE root_run_id=${literal(runId)} AND kind='sandbox_compute' ORDER BY recorded_at,id`,
    );
  const vendor = (runId = main.runId) =>
    one(
      `SELECT booked_cost_usd::text AS booked,maximum_cost_usd::text AS maximum FROM morrow_billing.vendor_cost_reservations WHERE root_run_id=${literal(runId)}`,
    );
  const broker = (text) => last(db.sql(text, { user: "morrow_vault_broker" }));
  // PR 8: an operation's envd token row in the vault (metadata only, and whether the plaintext
  // token appears anywhere in its sealed bytes).
  const tokenRow = (id, plaintext = "") =>
    one(
      `SELECT provider,kind,version::text AS version,subject_id::text AS subject,status,destroy_reason AS reason,(wrapped_key IS NOT NULL AND sealed_value IS NOT NULL) AS material,(sealed_value IS NOT NULL AND ${literal(plaintext)}<>'' AND position(convert_to(${literal(plaintext)},'UTF8') IN sealed_value)>0) AS clear FROM morrow_vault.credentials WHERE id=${literal(id)}`,
    );
  const hex = (bytes) => randomBytes(bytes).toString("hex");
  const tokenPut = (id, wrapped = hex(60), sealed = hex(48)) =>
    broker(
      `SELECT outcome FROM morrow_vault.runtime_token_put(${literal(id)},'1',${literal(wrapped)},${literal(sealed)});`,
    );
  const tokenGet = (id) =>
    broker(
      `SELECT outcome||'|'||coalesce(wrapped_key,'')||'|'||coalesce(sealed_value,'') FROM morrow_vault.runtime_token_get(${literal(id)});`,
    ).split("|");
  const as = (user, text) => db.tryRun(text, { user });
  const begin = (callKey, ref = main.ref, provider = "fake") =>
    broker(
      `SELECT outcome||'|'||coalesce(operation_id,'')||'|'||coalesce(deadline_at,'') FROM morrow_vault.runtime_operation_begin(${literal(ref.leaseId)},${literal(String(ref.generation))},${literal(callKey)},${literal("a".repeat(64))},${literal(provider)});`,
    ).split("|");
  const settle = (id, status, reason = null) =>
    broker(
      `SELECT outcome||'|'||coalesce(status,'') FROM morrow_vault.runtime_operation_settle(${literal(id)},${literal(status)},${reason === null ? "NULL" : literal(reason)});`,
    ).split("|");
  // sim: an operation's clock moved back (the guard off), so the sweep's staleness and the
  // absent grace can be reached without waiting 11 or 26 minutes.
  const age = (id, seconds) =>
    replica(
      `UPDATE morrow_work.runtime_operations SET send_started_at=send_started_at-interval '${seconds} seconds',deadline_at=deadline_at-interval '${seconds} seconds',reconciled_at=CASE WHEN reconciled_at IS NULL THEN NULL ELSE reconciled_at-interval '${seconds} seconds' END WHERE id=${literal(id)};`,
    );
  const liftAll = () => {
    for (const h of holds())
      db.workOwner(
        `SELECT outcome FROM morrow_work.runtime_hold_lift('operator_lab',${literal(h.id)},'checked the provider console: nothing left running');`,
      );
  };
  check(
    "A2:broker_holds_the_runtime_and_vault_capabilities",
    capabilities.computerMode === "on" &&
      capabilities.computer !== null &&
      capabilities.computer.provider === "e2b" &&
      capabilities.vault !== null,
  );

  // ---------------------------------------------------------------------------
  phase("capability");
  {
    const before = { ops: ops().length, bookings: bookings().length, capacity: capacity() };
    const refused = await execute(job("listings-has-no-computer"));
    check(
      "C1:a_release_without_runtime_execution_use_never_reaches_a_sandbox",
      refused.outcome === "refused" &&
        refused.code === "capability_missing" &&
        refused.traceRef === null &&
        ops().length === before.ops &&
        bookings().length === before.bookings &&
        JSON.stringify(capacity()) === JSON.stringify(before.capacity) &&
        fake.created() === 0,
      { refused, before, capacity: capacity() },
    );
  }
  // sim: the installation's release becomes one whose package declares a computer skill
  // (runtime.execution.use with execute), as the analyst's will; installations change release
  // only through the upgrade flow, which lands later, so it is owner-seeded with the guard off.
  const manifest = JSON.stringify({
    capabilities: {
      "catalog.products.read": ["view"],
      "runtime.execution.use": ["execute"],
    },
    fields: ["descriptionHtml", "title"],
    id: "morrow.lab_computer",
    kind: "specialist",
    revision: 1,
  });
  db.workOwner(
    `INSERT INTO morrow_work.agent_releases(id,revision,status,manifest,digest,published_at) VALUES('morrow.lab_computer',1,'published',${literal(manifest)},morrow_work.sha256_text(${literal(manifest)}),${ms});`,
  );
  replica(
    `UPDATE morrow_work.agent_installations SET release_id='morrow.lab_computer',release_revision=1,release_digest=morrow_work.sha256_text(${literal(manifest)}) WHERE id=${literal(installation.id)};`,
  );

  // ---------------------------------------------------------------------------
  phase("job");
  {
    const vendorBefore = vendor();
    const theJob = job("chart-1");
    let seenActive = null;
    duringExec = (sandbox) => {
      const [current] = ops().filter((o) => o.status === "created");
      seenActive = current ? tokenRow(current.id, sandbox.accessToken ?? "") : null;
    };
    const result = await execute(theJob);
    duringExec = null;
    const [row] = ops();
    const [booking] = bookings();
    const cap = capacity();
    const text = JSON.stringify(result);
    check(
      "J1:the_send_mark_one_create_the_job_the_kill_settled",
      result.outcome === "completed" &&
        result.exitCode === 0 &&
        result.stdout === "charted 1 product\n" &&
        JSON.stringify(result.outputs.map((o) => [o.name, o.type])) ===
          '[["chart","png"],["table","csv"],["book","xlsx"]]' &&
        Buffer.from(result.outputs[1].base64, "base64").toString("utf8") ===
          "sku,note\r\nA1,'=1+2\r\n" &&
        result.traceRef?.kind === "runtime_operation" &&
        result.traceRef.id === row?.id &&
        ops().length === 1 &&
        row.status === "killed" &&
        row.settled === true &&
        row.provider === "fake" &&
        typeof row.sandbox_ref === "string" &&
        row.call_key === "chart-1" &&
        row.installation === installation.id &&
        row.digest === sha(runtimeJobCanonical(parseRuntimeJob(JSON.stringify(theJob)))) &&
        row.span === "00:16:00" &&
        fake.created() === 1 &&
        fake.alive().length === 0,
      { result, row },
    );
    check(
      "J2:the_worst_case_is_booked_as_sandbox_compute_before_the_create",
      row?.worst === "0.03000000" &&
        runtimeCaps.worstCaseUsd === "0.03" &&
        booking?.id === row.booking_id &&
        booking.amount === "0.03000000" &&
        (Number(vendor().booked) - Number(vendorBefore.booked)).toFixed(8) === "0.03000000" &&
        cap.open === 0 &&
        cap.committed === "0.03000000",
      { row, booking, vendor: vendor(), vendorBefore, cap },
    );
    check(
      "J3:no_sandbox_id_token_key_or_provider_crosses_back",
      !text.includes(e2bKey) &&
        !text.includes(row?.sandbox_ref ?? "@") &&
        !/fake-envd|"provider"|sandbox/i.test(text) &&
        fake.guest.commands.every((c) => JSON.stringify(c.environment) === "{}") &&
        fake.guest.creates.every(
          (c) =>
            c.internet === false &&
            JSON.stringify(Object.keys(c.metadata)) === '["operation"]' &&
            c.timeoutSeconds === computerProfile.sandboxTimeoutSeconds,
        ) &&
        !JSON.stringify(
          fake.guest.files.map((f) => Buffer.from(f.bytes).toString("utf8")),
        ).includes(e2bKey),
      { text: text.slice(0, 400) },
    );
    const token = tokenRow(row?.id ?? "");
    check(
      "J5:the_envd_token_was_a_sealed_vault_record_destroyed_with_the_kill",
      seenActive?.status === "active" &&
        seenActive.material === true &&
        seenActive.clear === false &&
        seenActive.provider === "e2b" &&
        seenActive.kind === "e2b_envd_token" &&
        token?.status === "destroyed" &&
        token.reason === "sandbox_killed" &&
        token.material === false &&
        token.version === "1" &&
        token.subject === row.id,
      { seenActive, token },
    );
    const replay = await execute(theJob);
    check(
      "J4:the_same_run_and_call_key_never_creates_again",
      replay.outcome === "unknown" &&
        replay.code === "replayed" &&
        replay.traceRef?.id === row?.id &&
        fake.created() === 1 &&
        ops().length === 1 &&
        bookings().length === 1,
      { replay },
    );
  }

  // ---------------------------------------------------------------------------
  phase("unknown");
  let lost;
  {
    fake.fault({ op: "create", outcome: "unknown_effect", created: true });
    const result = await execute(job("lost-1"));
    lost = ops().find((o) => o.call_key === "lost-1");
    const [hold] = holds();
    check(
      "U1:a_lost_create_is_unknown_effect_with_a_hold_never_retried",
      result.outcome === "unknown" &&
        result.code === "create_unknown" &&
        lost?.status === "unknown_effect" &&
        lost.reason === "create_unknown" &&
        lost.settled === false &&
        hold?.reason === "unknown_effect" &&
        hold.operation === lost.id &&
        capacity().open === 1 &&
        fake.created() === 2 &&
        fake.alive().length === 1,
      { result, lost, hold, capacity: capacity() },
    );
    const createsBefore = fake.calls.filter((c) => c.op === "create").length;
    const held = await execute(job("after-the-hold"));
    check(
      "U2:the_hold_refuses_every_create_before_any_row",
      held.outcome === "refused" &&
        held.code === "runtime_held" &&
        !ops().some((o) => o.call_key === "after-the-hold") &&
        fake.calls.filter((c) => c.op === "create").length === createsBefore,
      { held },
    );
    // The sweep: nothing is stale yet; then the lost operation's clock passes the longest
    // execute and the sweep finds its sandbox by the operation's metadata and kills it.
    const early = await sweep();
    age(lost.id, 700);
    const swept = await sweep();
    check(
      "U3:the_sweep_finds_the_lost_sandbox_by_metadata_and_kills_it",
      early.examined === 0 &&
        swept.examined === 1 &&
        swept.killed === 1 &&
        op(lost.id).status === "killed" &&
        op(lost.id).reason === "create_unknown" &&
        fake.alive().length === 0 &&
        capacity().open === 0 &&
        holds().length === 1,
      { early, swept, op: op(lost.id), holds: holds() },
    );
    // Only a person lifts the hold: the owner's operator function, never a runtime login.
    const [h] = holds();
    const denied = ["morrow_vault_broker", "morrow_runtime_executor", "morrow_api_worker"].map(
      (user) =>
        as(
          user,
          `SELECT outcome FROM morrow_work.runtime_hold_lift('operator_lab',${literal(h.id)},'not mine to lift');`,
        ),
    );
    const brokerUpdate = as(
      "morrow_vault_broker",
      `UPDATE morrow_work.runtime_holds SET lifted_at=clock_timestamp() WHERE id=${literal(h.id)};`,
    );
    const bad = last(
      db.workOwner(
        `SELECT outcome FROM morrow_work.runtime_hold_lift('operator_lab',${literal(h.id)},' ');`,
      ),
    );
    const lifted = last(
      db.workOwner(
        `SELECT outcome FROM morrow_work.runtime_hold_lift('operator_lab',${literal(h.id)},'checked the provider console: nothing left running');`,
      ),
    );
    const again = last(
      db.workOwner(
        `SELECT outcome FROM morrow_work.runtime_hold_lift('operator_lab',${literal(h.id)},'twice');`,
      ),
    );
    const record = one(
      `SELECT lifted_by_operator_id AS operator,lift_reason IS NOT NULL AS reason FROM morrow_work.runtime_holds WHERE id=${literal(h.id)}`,
    );
    const resumed = await execute(job("after-the-lift"));
    check(
      "U4:only_the_owner_lifts_a_hold_once_then_creates_resume",
      denied.every((r) => !r.ok) &&
        !brokerUpdate.ok &&
        bad === "invalid" &&
        lifted === "lifted" &&
        again === "not_found" &&
        record?.operator === "operator_lab" &&
        record.reason === true &&
        holds().length === 0 &&
        resumed.outcome === "completed",
      { denied: denied.map((r) => r.ok), lifted, again, resumed: resumed.outcome },
    );
  }

  // ---------------------------------------------------------------------------
  phase("not_found");
  {
    fake.fault({ op: "create", outcome: "unknown_effect" });
    const result = await execute(job("lost-absent"));
    const gone = ops().find((o) => o.call_key === "lost-absent");
    age(gone.id, 700);
    const unqualified = await sweep();
    const tooEarly = settle(gone.id, "absent_verified");
    // Past the deadline plus the grace, unqualified: still unknown.
    age(gone.id, 1000);
    const lateUnqualified = await sweep();
    const stillUnknown = op(gone.id);
    const qualified = await sweep(qualifiedGateway);
    check(
      "N1:not_found_alone_is_never_deletion",
      result.code === "create_unknown" &&
        unqualified.unknown === 1 &&
        tooEarly[0] === "too_early" &&
        lateUnqualified.unknown === 1 &&
        stillUnknown.status === "unknown_effect" &&
        stillUnknown.reason === "not_found_unverified" &&
        qualified.absentVerified === 1 &&
        op(gone.id).status === "absent_verified" &&
        op(gone.id).settled === true &&
        capacity().open === 0 &&
        holds().length === 1,
      { result, unqualified, tooEarly, lateUnqualified, stillUnknown, qualified, op: op(gone.id) },
    );
    liftAll();
  }

  // ---------------------------------------------------------------------------
  phase("caps");
  {
    // Three open sandboxes per workspace (sending marks, as three jobs in flight would leave).
    const marks = ["cap-1", "cap-2", "cap-3"].map((key) => begin(key));
    const fourth = begin("cap-4");
    const open = capacity().open;
    const settled = marks.map(([, id]) => settle(id, "not_created")[0]);
    const twice = settle(marks[0][1], "not_created");
    check(
      "K1:three_open_sandboxes_per_workspace_then_not_created_closes_them",
      marks.every(([outcome]) => outcome === "begun") &&
        fourth[0] === "workspace_limit" &&
        open === 3 &&
        settled.every((s) => s === "settled") &&
        twice[0] === "already_settled" &&
        capacity().open === 0 &&
        !ops().some((o) => o.call_key === "cap-4"),
      { marks, fourth, open, settled, twice },
    );
    // sim: the platform's other workspaces hold the concurrency cap.
    replica(
      `UPDATE morrow_work.runtime_capacity SET open_operations=${runtimeCaps.concurrentSandboxes};`,
    );
    const busy = begin("cap-busy");
    replica("UPDATE morrow_work.runtime_capacity SET open_operations=0;");
    // sim: this month's committed worst cases leave less than one sandbox of the budget.
    const committed = capacity().committed;
    replica("UPDATE morrow_work.runtime_capacity SET month_committed_usd=9.98;");
    const spent = begin("cap-spent");
    // A new month starts from zero.
    replica(
      "UPDATE morrow_work.runtime_capacity SET budget_month=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month')::date,month_committed_usd=10.00;",
    );
    const fresh = begin("cap-new-month");
    const afterMonth = capacity();
    settle(fresh[1], "not_created");
    replica(`UPDATE morrow_work.runtime_capacity SET month_committed_usd=${committed};`);
    check(
      "K2:the_platform_concurrency_and_the_monthly_budget_refuse_before_any_row",
      busy[0] === "concurrency_limit" &&
        spent[0] === "monthly_budget" &&
        fresh[0] === "begun" &&
        afterMonth.committed === "0.03000000" &&
        !ops().some((o) => ["cap-busy", "cap-spent"].includes(o.call_key)) &&
        Number(runtimeCaps.monthlyBudgetUsd) < Number(runtimeCaps.providerUsageLimitUsd),
      { busy, spent, fresh, afterMonth },
    );
    // sim: the run's vendor reservation is spent.
    const before = vendor();
    replica(
      `UPDATE morrow_billing.vendor_cost_reservations SET booked_cost_usd=maximum_cost_usd WHERE root_run_id=${literal(main.runId)};`,
    );
    const exhausted = await execute(job("cap-exhausted"));
    replica(
      `UPDATE morrow_billing.vendor_cost_reservations SET booked_cost_usd=${before.booked} WHERE root_run_id=${literal(main.runId)};`,
    );
    check(
      "K3:a_spent_vendor_reservation_refuses_the_send_mark",
      exhausted.outcome === "refused" &&
        exhausted.code === "reservation_exhausted" &&
        !ops().some((o) => o.call_key === "cap-exhausted") &&
        capacity().open === 0,
      { exhausted },
    );
  }

  // ---------------------------------------------------------------------------
  phase("settle_edges");
  {
    const [, id] = begin("edge-1");
    const created = broker(
      `SELECT outcome||'|'||coalesce(status,'') FROM morrow_vault.runtime_operation_created(${literal(id)},'sbx_edge_1');`,
    );
    const createdAgain = broker(
      `SELECT outcome||'|'||coalesce(status,'') FROM morrow_vault.runtime_operation_created(${literal(id)},'sbx_edge_1');`,
    );
    const otherRef = broker(
      `SELECT outcome||'|'||coalesce(status,'') FROM morrow_vault.runtime_operation_created(${literal(id)},'sbx_other');`,
    );
    const notCreated = settle(id, "not_created");
    const invalid = [
      settle(id, "unknown_effect"),
      settle(id, "killed", "kill_unknown"),
      settle(id, "deleted"),
      settle(id, "unknown_effect", "because"),
    ];
    const killed = settle(id, "killed");
    const terminal = settle(id, "unknown_effect", "kill_unknown");
    const guarded = [
      db.tryRun(
        `SET ROLE morrow_work_owner; UPDATE morrow_work.runtime_operations SET status='created',revision=revision+1 WHERE id=${literal(id)};`,
      ),
      db.tryRun(
        `SET ROLE morrow_work_owner; DELETE FROM morrow_work.runtime_operations WHERE id=${literal(id)};`,
      ),
      db.tryRun("SET ROLE morrow_work_owner; DELETE FROM morrow_work.runtime_holds;"),
      db.tryRun("SET ROLE morrow_work_owner; TRUNCATE morrow_work.runtime_operations;"),
    ];
    check(
      "G1:the_settle_edges_hold_and_a_terminal_operation_never_changes",
      created === "recorded|created" &&
        createdAgain === "recorded|created" &&
        otherRef === "refused|created" &&
        notCreated.join("|") === "refused|created" &&
        invalid.every(([outcome]) => outcome === "invalid") &&
        killed.join("|") === "settled|killed" &&
        terminal.join("|") === "already_settled|killed" &&
        guarded.every((r) => !r.ok) &&
        op(id).status === "killed",
      { created, createdAgain, otherRef, notCreated, invalid, killed, terminal },
    );
    // The broker's login holds no table privilege, no other login executes its definers, and
    // the sweep's list is ids only.
    const tables = ["runtime_operations", "runtime_holds", "runtime_capacity"].map((t) =>
      as("morrow_vault_broker", `SELECT count(*) FROM morrow_work.${t};`),
    );
    const others = ["morrow_api_worker", "morrow_runtime_executor", "morrow_connector_ingress"].map(
      (user) =>
        as(
          user,
          `SELECT outcome FROM morrow_vault.runtime_operation_begin(${literal(main.ref.leaseId)},'1','x','${"a".repeat(64)}','fake');`,
        ),
    );
    const apiRead = as("morrow_api_worker", "SELECT count(*) FROM morrow_work.runtime_operations;");
    const [, openId] = begin("list-1");
    age(openId, 700);
    const columns = last(
      db.sql(
        "SELECT array_to_string(p.proargnames,',') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_vault' AND p.proname='runtime_operations_open';",
      ),
    );
    const asBroker = broker(
      "SELECT count(*)||'|'||string_agg(operation_id,',') FROM morrow_vault.runtime_operations_open('25');",
    );
    const badLimit = broker("SELECT count(*) FROM morrow_vault.runtime_operations_open('0');");
    settle(openId, "not_created");
    check(
      "G2:no_login_but_the_brokers_reaches_the_ledger_and_the_list_is_ids_only",
      tables.every((r) => !r.ok) &&
        others.every((r) => !r.ok) &&
        !apiRead.ok &&
        // The definer's columns carry no tenant key, run or content; the broker's call lists
        // the one stale open operation.
        columns ===
          "p_limit,operation_id,provider,sandbox_ref,status,deadline_at,stale,past_grace" &&
        asBroker === "1|" + openId &&
        badLimit === "0",
      {
        tables: tables.map((r) => r.ok),
        others: others.map((r) => r.ok),
        columns,
        asBroker,
        badLimit,
      },
    );
    // The ledger lives in morrow_work, so the vault still holds its two sealed-secret tables
    // only (lab:spine-foundation V3 pins the command role's vault privileges to them), and the
    // ledger's whole ACL is exactly the command role's: SELECT and INSERT, the column
    // UPDATEs its definers write, nothing for anyone else.
    const ledger = "('runtime_operations','runtime_holds','runtime_capacity')";
    // Compared as sorted lists in JavaScript, so the database's collation never matters.
    const list = (query) =>
      db
        .rows(query)
        .map((r) => r.x)
        .sort()
        .join(",");
    const vault = list(
      "SELECT c.relname::text AS x FROM pg_catalog.pg_class c WHERE c.relnamespace='morrow_vault'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')",
    );
    const tableAcl = list(
      `SELECT c.relname::text||':'||a.grantee::regrole::text||':'||a.privilege_type AS x FROM pg_catalog.pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace='morrow_work'::regnamespace AND c.relname IN ${ledger} AND a.grantee<>c.relowner`,
    );
    const columnAcl = list(
      `SELECT c.relname::text||'.'||t.attname::text||':'||a.grantee::regrole::text||':'||a.privilege_type AS x FROM pg_catalog.pg_attribute t JOIN pg_catalog.pg_class c ON c.oid=t.attrelid, aclexplode(t.attacl) a WHERE c.relnamespace='morrow_work'::regnamespace AND c.relname IN ${ledger} AND t.attacl IS NOT NULL`,
    );
    const expectedTableAcl = [
      "runtime_capacity:SELECT",
      "runtime_holds:INSERT",
      "runtime_holds:SELECT",
      "runtime_operations:INSERT",
      "runtime_operations:SELECT",
    ]
      .map((e) => e.replace(":", ":morrow_work_command:"))
      .sort()
      .join(",");
    const expectedColumnAcl = [
      ...["budget_month", "month_committed_usd", "open_operations", "revision", "updated_at"].map(
        (c) => "runtime_capacity." + c,
      ),
      ...[
        "reconciled_at",
        "revision",
        "sandbox_ref",
        "settled_at",
        "status",
        "unknown_reason",
        "updated_at",
      ].map((c) => "runtime_operations." + c),
    ]
      .map((e) => e + ":morrow_work_command:UPDATE")
      .sort()
      .join(",");
    check(
      "G3:the_vault_keeps_its_two_secret_tables_and_the_ledger_acl_is_exact",
      vault === "app_secrets,credentials" &&
        tableAcl === expectedTableAcl &&
        columnAcl === expectedColumnAcl,
      { vault, tableAcl, columnAcl },
    );
  }

  // ---------------------------------------------------------------------------
  phase("token");
  {
    // T1: stored once, only while `created`; opened only then; settlement destroys it.
    const [, id] = begin("token-1");
    const whileSending = tokenPut(id);
    broker(
      `SELECT outcome FROM morrow_vault.runtime_operation_created(${literal(id)},'sbx_token_1');`,
    );
    const wrapped = hex(60),
      sealed = hex(48);
    const stored = tokenPut(id, wrapped, sealed);
    const again = tokenPut(id);
    const opened = tokenGet(id);
    const invalid = [
      tokenPut(id, "zz", sealed),
      tokenPut(id, wrapped, "ab"),
      tokenPut("not-an-id"),
      broker(
        `SELECT outcome FROM morrow_vault.runtime_token_put(${literal(id)},'0',${literal(wrapped)},${literal(sealed)});`,
      ),
    ];
    const absent = tokenPut(randomUUID());
    const killed = settle(id, "killed");
    const afterKill = tokenGet(id);
    const row = tokenRow(id);
    const putAfter = tokenPut(id);
    // An unknown effect destroys it too; an absent one (past the grace) as well.
    const [, id2] = begin("token-2");
    broker(
      `SELECT outcome FROM morrow_vault.runtime_operation_created(${literal(id2)},'sbx_token_2');`,
    );
    tokenPut(id2);
    const unknown = settle(id2, "unknown_effect", "kill_unknown");
    const row2 = tokenRow(id2);
    const openedUnknown = tokenGet(id2);
    age(id2, 1700);
    const absentSettle = settle(id2, "absent_verified");
    liftAll();
    check(
      "T1:the_token_is_stored_once_while_created_and_dies_with_any_settlement",
      whileSending === "refused" &&
        stored === "stored" &&
        again === "refused" &&
        opened.join("|") === "active|" + wrapped + "|" + sealed &&
        invalid.every((o) => o === "invalid") &&
        absent === "not_found" &&
        killed.join("|") === "settled|killed" &&
        afterKill[0] === "unavailable" &&
        row?.status === "destroyed" &&
        row.reason === "sandbox_killed" &&
        row.material === false &&
        putAfter === "refused" &&
        unknown.join("|") === "settled|unknown_effect" &&
        row2?.status === "destroyed" &&
        row2.reason === "sandbox_unknown" &&
        openedUnknown[0] === "unavailable" &&
        absentSettle.join("|") === "settled|absent_verified" &&
        capacity().open === 0,
      {
        whileSending,
        stored,
        again,
        invalid,
        absent,
        killed,
        afterKill,
        row,
        putAfter,
        unknown,
        row2,
        openedUnknown,
        absentSettle,
      },
    );
    // T2: only the broker's login executes the token definers; it reads no vault table.
    const others = [
      "morrow_api_worker",
      "morrow_runtime_executor",
      "morrow_connector_ingress",
    ].flatMap((user) => [
      as(user, `SELECT outcome FROM morrow_vault.runtime_token_get(${literal(id)});`),
      as(
        user,
        `SELECT outcome FROM morrow_vault.runtime_token_put(${literal(id)},'1',${literal(wrapped)},${literal(sealed)});`,
      ),
    ]);
    const direct = as("morrow_vault_broker", "SELECT count(*) FROM morrow_vault.credentials;");
    const acl = db
      .rows(
        "SELECT p.proname::text||':'||coalesce((SELECT string_agg(a.grantee::regrole::text,',' ORDER BY a.grantee::regrole::text) FROM aclexplode(p.proacl) a WHERE a.grantee<>p.proowner),'') AS x FROM pg_catalog.pg_proc p WHERE p.pronamespace='morrow_vault'::regnamespace AND p.proname IN ('runtime_token_put','runtime_token_get','runtime_operations_sweep','runtime_operations_open','runtime_operation_settle')",
      )
      .map((r) => r.x)
      .sort()
      .join(";");
    check(
      "T2:only_the_brokers_login_executes_the_token_definers",
      others.every((r) => !r.ok) &&
        !direct.ok &&
        acl ===
          [
            "runtime_operation_settle:morrow_vault_broker",
            "runtime_operations_open:morrow_vault_broker",
            "runtime_operations_sweep:morrow_vault_broker",
            "runtime_token_get:morrow_vault_broker",
            "runtime_token_put:morrow_vault_broker",
          ].join(";"),
      { others: others.map((r) => r.ok), direct: direct.ok, acl },
    );
    // T3: the constraints keep the two kinds apart (owner-run, as maintenance would be).
    const insert = (over) => {
      const v = {
        id: randomUUID(),
        provider: "e2b",
        kind: "e2b_envd_token",
        version: 1,
        subject: null,
        ...over,
      };
      return db.tryRun(
        `SET ROLE morrow_work_owner; INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at,destroyed_at,destroy_reason) VALUES(${literal(O)},${literal(W)},${literal(v.id)},${v.version},${literal(v.provider)},${literal(v.kind)},${literal(v.subject ?? v.id)},'active',1,decode(${literal(hex(60))},'hex'),decode(${literal(hex(48))},'hex'),${ms},NULL,NULL);`,
      );
    };
    const valid = randomUUID();
    const ok = insert({ id: valid });
    const refused = [
      insert({ kind: "shopify_offline_token" }),
      insert({ provider: "shopify" }),
      insert({ subject: randomUUID() }),
      insert({ id: "not_a_uuid", subject: "not_a_uuid" }),
    ];
    const wrongReason = db.tryRun(
      `SET ROLE morrow_work_owner; UPDATE morrow_vault.credentials SET status='destroyed',wrapped_key=NULL,sealed_value=NULL,destroyed_at=${ms},destroy_reason='uninstalled' WHERE id=${literal(valid)};`,
    );
    const rightReason = db.tryRun(
      `SET ROLE morrow_work_owner; UPDATE morrow_vault.credentials SET status='destroyed',wrapped_key=NULL,sealed_value=NULL,destroyed_at=${ms},destroy_reason='sandbox_unknown' WHERE id=${literal(valid)};`,
    );
    check(
      "T3:the_credentials_constraints_keep_e2b_tokens_and_shopify_tokens_apart",
      ok.ok && refused.every((r) => !r.ok) && !wrongReason.ok && rightReason.ok,
      { ok: ok.ok, refused: refused.map((r) => r.ok), wrongReason: wrongReason.ok },
    );
  }

  // ---------------------------------------------------------------------------
  phase("lease");
  {
    const wrongGeneration = await execute(job("lease-gen"), {
      ref: { leaseId: main.ref.leaseId, generation: main.ref.generation + 1 },
    });
    const sqlGeneration = begin("lease-gen-sql", {
      leaseId: main.ref.leaseId,
      generation: main.ref.generation + 1,
    });
    const queuedRef = leaseOf(queued);
    const inactive = begin("lease-queued", queuedRef);
    check(
      "L1:another_generation_and_a_queued_run_never_mark_a_send",
      wrongGeneration.held === "STATE_INVALID" &&
        sqlGeneration[0] === "not_found" &&
        ["run_inactive", "not_found", "ended"].includes(inactive[0]) &&
        ops(queued).length === 0 &&
        !ops().some((o) => o.call_key.startsWith("lease-")),
      { wrongGeneration, sqlGeneration, inactive },
    );
    // PR 8: an operation whose sandbox is up and whose envd token is in the vault (its job
    // between two calls), marked through the definers as the gateway would.
    const [, runningId] = begin("running-at-stop");
    const runningBox = await fake.create(
      {
        operationId: runningId,
        template: "morrow-computer-fake-v1",
        timeoutSeconds: computerProfile.sandboxTimeoutSeconds,
        internet: false,
        metadata: { operation: runningId },
      },
      e2bKey,
      10000,
    );
    broker(
      `SELECT outcome FROM morrow_vault.runtime_operation_created(${literal(runningId)},${literal(runningBox.sandboxRef)});`,
    );
    const runningToken = tokenPut(runningId);
    // A sandbox lost before "Stop AI work": the stop refuses every send mark of the run, and
    // the sweep (which no stop or hold blocks) still finds and kills the sandbox.
    fake.fault({ op: "create", outcome: "unknown_effect", created: true });
    const lostBefore = await execute(job("lost-before-stop"));
    const lostOp = ops().find((o) => o.call_key === "lost-before-stop");
    liftAll();
    // The installation back on the Listings release (sim, as above), whose stop route this is.
    replica(
      `UPDATE morrow_work.agent_installations SET release_id='morrow.listings',release_revision=1,release_digest=(SELECT r.digest FROM morrow_work.agent_releases r WHERE r.id='morrow.listings' AND r.revision=1) WHERE id=${literal(installation.id)};`,
    );
    const stop = await agentsCall(P.A, "POST", listings + "/stop", {
      control: { reason: "Pause the computer", sourceProposalRef: null },
    });
    const stopped = await execute(job("after-stop"));
    const stoppedSql = begin("after-stop-sql");
    // PR 8: no aging. The stop alone puts both operations on the sweep's list (stale false,
    // stopped true), and the next sweep kills both sandboxes and destroys the token.
    const listed = db
      .rows(
        "SELECT operation_id,stale::text AS stale,stopped::text AS stopped FROM morrow_vault.runtime_operations_sweep('25')",
        { user: "morrow_vault_broker" },
      )
      .filter((r) => r.operation_id === lostOp.id || r.operation_id === runningId)
      .map((r) => r.stale + "|" + r.stopped);
    const swept = await sweep();
    const runningRow = tokenRow(runningId);
    check(
      "L2:a_stop_refuses_the_send_mark_kills_its_runs_sandboxes_at_once_and_never_blocks_cleanup",
      lostBefore.code === "create_unknown" &&
        runningToken === "stored" &&
        stop.status === 200 &&
        stopped.held === "STATE_INVALID" &&
        // The stop revokes the run's lease, so the send mark finds it ended (a stop committed
        // while the lease is still active answers stopped).
        ["stopped", "ended"].includes(stoppedSql[0]) &&
        !ops().some((o) => o.call_key.startsWith("after-stop")) &&
        JSON.stringify(listed) === '["false|true","false|true"]' &&
        swept.killed === 2 &&
        op(lostOp.id).status === "killed" &&
        op(runningId).status === "killed" &&
        runningRow?.status === "destroyed" &&
        runningRow.reason === "sandbox_killed" &&
        fake.alive().length === 0 &&
        capacity().open === 0,
      {
        lostBefore,
        runningToken,
        stop: stop.status,
        stopped,
        stoppedSql,
        listed,
        swept,
        runningRow,
      },
    );
  }
  return { checks, failures };
}

async function main() {
  const started = Date.now();
  let result;
  phase("engine_and_migrations");
  try {
    await withWorkDatabase(
      "PR7.runtime-operations",
      async (db) => {
        result = await runRuntimeOperationsLab(db);
      },
      { administrator: "createrole" },
    );
  } catch (error) {
    console.error("RUNTIME_LAB_FAILED_IN:" + stage);
    throw error;
  }
  phase("report");
  writeArtifact("labs/runtime-operations.json", {
    task: "Build order PR 7 and PR 8",
    qualification: "local_postgresql17_network_none_runtime_operations",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "The runtime gateway runs in Node over psql connectors (morrow_vault_broker, morrow_runtime_executor, morrow_api_worker), not in workerd over the Neon transport; the provider is the deterministic fake adapter, not E2B (build order PR 8's adapter is proved over E2B's recorded wire in tests/runtime-e2b.test.mjs, and on E2B itself only by PR 9's qualification).",
      "The computer release and the installation's move to it are owner-seeded with the guard off (sim): installations change release only through the upgrade flow, which lands later.",
      "Staleness, the absent grace, the concurrency cap, the monthly budget and a spent vendor reservation are reached by owner-seeded clock and counter changes with the triggers off (sim).",
      "M5's billing records are owner-seeded with the triggers off (sim), as in lab:listings-runs; lab:billing proves the receipt path that writes them.",
    ],
  });
  if (result.failures.length) {
    print("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else print(`PASS: ${result.checks.length} build order PR 7 and PR 8 runtime operation checks.`);
}

await main();
