// v1 PR 4 PostgreSQL 17 laboratory: Undo, the apply history's undo state, "Approve several at
// once" and the product picker's reads (migration 0047 catalog-undo on top of 0044-0045) on an
// isolated network-none engine, the full manifest applied by the Neon-shaped non-superuser
// CREATEROLE administrator (ADR-0020 D4). It drives the real code end to end, as
// lab:catalog-apply does: a Listings run drafts real proposals (runs handler, the Workflow
// logic and the broker's model gateway against the in-process Messages API stand-in); the
// review handler (packages/work/src/review/http.ts, Node, the psql work connector logged in as
// morrow_api_worker) reviews, decides, applies, undoes and batches them; and the broker's
// writer (apps/broker/src/shopify-write.ts: apply, read-back and the undo check) runs over the
// vault login's real transport against an in-process Shopify stand-in, never a store.
// It proves:
//   U  Undo: offered on a change confirmed in Shopify, for 90 days; the request reads the
//      product once (never a write) and stores a NEW proposal back to the values read before
//      the apply, proposed by the Listings installation for the person, with its own digest
//      and pending approval; the review shows it as an undo; no shortcut (the original's
//      approval, an unapproved undo or another digest writes nothing); approved, it goes
//      through the same gateway and Shopify holds the values read before the apply again;
//      a second undo is refused (requested, then undone); a product changed since the apply
//      stops Undo (nothing written), and a change between the undo and its apply is refused
//      by the gateway's pre-send read (nothing written); after 90 days or the shop's data
//      being deleted it is "no longer available"; another workspace gets not_found; a person
//      without the propose and delegate grants is denied before any read; the broker's undo
//      definers refuse every other login;
//   B  "Approve several at once": the server-built document lists the task's pending changes
//      with their exact digests; a stale, tampered or expired document approves nothing; one
//      member decided elsewhere refuses them all; one confirmation records one exact approval
//      per change; a replay replays, a second use refuses; each is still claimed and
//      rechecked by the gateway (a stop between refuses the next); another tenant gets
//      not_found;
//   P  the picker's catalogue reads: only the workspace's linked store, under the product
//      read rule, ids and titles only; another workspace gets not_found and nothing is read;
//   W  the SPA's closed decoders accept exactly the server's replies;
//   L  no product text reaches a log line.
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data. Shapes
// marked sim stand in for states no API path reaches yet (90 days passing, shop/redact's
// effects). CI pg-linking group.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createAgentsApiHandler } from "../packages/work/src/agents/http.ts";
import { createCatalogApiHandler } from "../packages/work/src/catalog/http.ts";
import { createWorkApiHandler } from "../packages/work/src/http.ts";
import { createRunsApiHandler } from "../packages/work/src/runs/http.ts";
import { createReviewApiHandler } from "../packages/work/src/review/http.ts";
import { batchDigest } from "../packages/work/src/review/batch.ts";
import { listingsRun, RunStepRetry } from "../packages/work/src/runs/workflow.ts";
import { listingSnapshotText } from "../packages/work/src/runs/listing-canonical.ts";
import { normalisedValue } from "../packages/work/src/runs/listing-compare.ts";
import { createRuntimeAttempt, runLeaseStep } from "../packages/work/src/runtime/leases.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { createClaudeAdapter } from "../apps/broker/src/claude-adapter.ts";
import { createModelGateway } from "../apps/broker/src/model-gateway.ts";
import { createShopifyWriter } from "../apps/broker/src/shopify-write.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import { sealVaultRecord, vaultBytesHex } from "../apps/broker/src/vault.ts";
import {
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
import {
  decodeBatchDecided,
  decodeBatchDocument,
  decodeOperationsOfTask,
  decodeReview,
  decodeUndoRequested,
} from "../apps/workspace-web/src/http/review-decoders.ts";
import { decodeCatalogProducts } from "../apps/workspace-web/src/http/catalog-decoders.ts";

const checks = [];
const failures = [];
const labStarted = Date.now();
let stage = "start";
const phase = (value) => {
  stage = value;
  console.error(
    "UNDO_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
};
function within(promise, timeoutMs, wait) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("UNDO_LAB_STALLED:" + stage + ":" + wait)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
const workerLines = [];
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("UNDO_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
    console.error(
      "RECENT_ROUTE_OUTCOMES " +
        JSON.stringify(
          workerLines
            .filter((l) => l.includes('"event":"morrow_review"'))
            .slice(-4)
            .map((l) => {
              const r = JSON.parse(l);
              return r.route + " " + r.outcome;
            }),
        ),
    );
  }
  return passed === true;
}
const last = (out) => (Array.isArray(out) ? out : out.split("\n")).at(-1);
const ms = "date_trunc('milliseconds',clock_timestamp())";
const print = console.log.bind(console);
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// The Shopify stand-in (lab:catalog-apply's, without its faults): the Admin GraphQL endpoint
// of one shop answering the gateway's two fixed documents from a synthetic catalogue, shaped
// from Shopify's documentation. productUpdate replaces each given field (tags as the full
// list, seo as a whole); updatedAt advances on every change. Every request is recorded.
function createShopStandIn({ shop, token }) {
  const products = new Map();
  const calls = [];
  let clock = Date.parse("2026-10-01T00:00:00.000Z");
  const stamp = () => new Date((clock += 1000)).toISOString().replace(".000Z", "Z");
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const put = (n, p) =>
    products.set(String(n), {
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      tags: [...p.tags],
      seo: { title: p.seo?.title ?? null, description: p.seo?.description ?? null },
      updatedAt: stamp(),
    });
  const view = (n) => {
    const p = products.get(String(n));
    return p
      ? {
          id: "gid://shopify/Product/" + n,
          title: p.title,
          descriptionHtml: p.descriptionHtml,
          tags: [...p.tags],
          seo: { ...p.seo },
          updatedAt: p.updatedAt,
        }
      : null;
  };
  const applyInput = (n, input) => {
    const p = products.get(String(n));
    if (input.title !== undefined) p.title = input.title;
    if (input.descriptionHtml !== undefined) p.descriptionHtml = input.descriptionHtml;
    if (input.tags !== undefined) p.tags = [...input.tags];
    if (input.seo !== undefined)
      p.seo = { title: input.seo.title ?? null, description: input.seo.description ?? null };
    p.updatedAt = stamp();
  };
  return {
    products,
    calls,
    put,
    view,
    /** A merchant's own edit in the Shopify admin (not through Morrow). */
    edit(n, change) {
      applyInput(n, change);
    },
    count: (operation, n) =>
      calls.filter((c) => c.operation === operation && (n === undefined || c.product === String(n)))
        .length,
    async fetch(url, init) {
      const target = new URL(url);
      if (target.host !== shop || target.pathname !== "/admin/api/2026-10/graphql.json")
        return json(404, { errors: "Not Found" });
      if (init.method !== "POST" || init.redirect !== "manual")
        return json(400, { errors: "Bad Request" });
      const headers = new Headers(init.headers);
      if (headers.get("x-shopify-access-token") !== token)
        return json(401, { errors: "[API] Invalid API key or access token" });
      const request = JSON.parse(init.body);
      const operation = /^(?:query|mutation) ([A-Za-z]+)/.exec(request.query ?? "")?.[1] ?? null;
      const variables = request.variables ?? {};
      if (operation === "ProductWriteState") {
        const n = /^gid:\/\/shopify\/Product\/([0-9]+)$/.exec(variables.id ?? "")?.[1] ?? null;
        calls.push({ operation, product: n });
        return json(200, {
          data: { product: n === null ? null : view(n) },
          extensions: { cost: { requestedQueryCost: 2, actualQueryCost: 2 } },
        });
      }
      if (operation === "ProductUpdate") {
        const input = variables.product ?? {};
        const n = /^gid:\/\/shopify\/Product\/([0-9]+)$/.exec(input.id ?? "")?.[1] ?? null;
        calls.push({ operation, product: n, keys: Object.keys(input).sort() });
        if (n === null || !products.has(String(n)))
          return json(200, {
            data: {
              productUpdate: { product: null, userErrors: [{ field: ["id"], message: "x" }] },
            },
          });
        applyInput(n, input);
        return json(
          200,
          {
            data: {
              productUpdate: {
                product: { id: input.id, updatedAt: products.get(String(n)).updatedAt },
                userErrors: [],
              },
            },
            extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10 } },
          },
          { "x-request-id": randomUUID() },
        );
      }
      calls.push({ operation, product: null });
      return json(200, { errors: [{ message: "unexpected document" }] });
    },
  };
}

export async function runCatalogUndoLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  const O = P.A.org,
    W = P.A.workspace;
  const S = "store_undo",
    C = "connection_undo",
    INSTALLATION = "storeinst_undo";
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
    if (!validateCurrentDefinition("Grant", g)) throw Error("UNDO_LAB_GRANT_INVALID");
    return `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(O)},${literal(W)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`;
  }
  const catalogGrants = (p) => [
    storeGrant(p, "catalog.products.read", ["view", "delegate"]),
    storeGrant(p, "catalog.content.propose", ["execute", "delegate"]),
    storeGrant(p, "catalog.content.publish", ["propose", "approve", "execute", "delegate"]),
  ];
  // The founder holds the owner bootstrap grants and the catalogue grants; A1 is a member
  // with the catalogue grants and approval decide (a second reviewer); X has no store grant.
  db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_undo','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(P.A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_undo',${literal(O)},${literal(W)},${literal(P.A.membership)},'owner-bootstrap-v1',clock_timestamp());`);
  db.admin(
    [
      ...catalogGrants(P.A),
      storeGrant(
        P.A,
        "agents.installation.activate",
        ["execute"],
        ["evaluation", "grant", "installationId", "revision"],
      ),
      ...catalogGrants(P.A1),
      ...[P.A, P.A1].flatMap((p) => [
        grantInsert(
          p,
          fixtureGrant(
            p,
            "governance.approval.decide",
            ["approve"],
            ["decision", "expectedRevision", "proposalRef"],
          ),
        ),
        grantInsert(
          p,
          fixtureGrant(
            p,
            "governance.approval.preview",
            ["view"],
            ["proposalRef", "selectedTargetIndexes"],
          ),
        ),
      ]),
    ].join("\n"),
  );
  // M5's billing records of an entitled Morrow-direct workspace (sim: owner-seeded with the
  // triggers off, as lab:catalog-apply does).
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
      throw Error("UNDO_LAB_FIXTURE_FAILED:" + stage);
    }
    return r.stdout;
  };
  replica(`INSERT INTO morrow_billing.workspace_billing_routes VALUES(${literal(O)},${literal(W)},'website',NULL,NULL,NULL,NULL,NULL,1,${ms},${ms}) ON CONFLICT DO NOTHING;
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',created_at=${ms}-interval '2 days',route_fixed_at=${ms}-interval '1 day',fixing_payment_key='stripe:invoice:in_LabUndoPay00001',revision=2,updated_at=${ms} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};
INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},'morrow_direct','test','USD','active',1,${ms},${ms});
INSERT INTO morrow_billing.stripe_event_receipts(organization_id,workspace_id,id,event_id,event_type,livemode,mode,object_type,object_id,customer_id,object,object_digest,observed_at,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(receipt)},'evt_labundo000001','invoice.paid',false,'test','invoice','in_LabUndoPay00001',NULL,'{"kind":"invoice","id":"in_LabUndoPay00001","livemode":false}'::jsonb,${literal("d".repeat(64))},${ms},${ms});
INSERT INTO morrow_billing.entitlement_snapshots VALUES(${literal(O)},${literal(W)},${literal(account)},1,'morrow_direct','test','stripe:sub:sub_LabUndoSub00001','active',${literal("c".repeat(64))},${ms}-interval '1 hour',${ms}+interval '29 days',${literal(receipt)},${ms});
INSERT INTO morrow_billing.verified_payment_events(organization_id,workspace_id,id,route,mode,payment_key,kind,subscription_key,price_key,period_start,period_end,operation_id,amount,currency,provider_evidence_ref,verified_at,outcome,outcome_code,receipt_id,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},'morrow_direct','test','stripe:invoice:in_LabUndoPay00001','subscription_period','stripe:sub:sub_LabUndoSub00001','stripe:price:price_MorrowDevBeta0049',${ms}-interval '1 day',${ms}+interval '29 days',${literal(randomUUID())},'49','USD',${literal("e".repeat(64))},${ms}-interval '1 hour','granted',NULL,${literal(receipt)},${ms});
INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,terms_revision,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},300,0,0,1,1,2,${ms},${ms});`);
  db.admin(
    storeInstallationSql({
      org: O,
      workspace: W,
      principal: P.A.principal,
      storeId: S,
      connectionId: C,
      installationId: INSTALLATION,
    }),
  );
  const count = (query) => Number(last(db.sql(`SELECT (${query})::bigint;`)));
  const one = (query) => db.rows(query)[0] ?? null;

  // The broker: the model-provider and apply switches on, the vault login over this engine.
  const anthropicKey = fakeAnthropicKey();
  const binding = {
    schemaVersion: 1,
    environment: "development",
    projectId: "morrow-undo-lab",
    branchId: "br-undo-lab",
    hostname: "ep-undo-lab.c-14.us-east-1.aws.neon.tech",
    database: "morrow",
  };
  const brokerEnv = {
    MORROW_ENVIRONMENT: "development",
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
    MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "lab-vault-" + randomBytes(12).toString("hex"),
    MORROW_VAULT_KEK_V1: randomBytes(32).toString("hex"),
    MORROW_MODEL_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: anthropicKey,
    MORROW_SHOPIFY_WRITE: "on",
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
      Math.min(10000, budgetMs * 4),
      body,
      Date.now,
      class {
        close() {}
      },
    );
  const oracle = createAnthropicOracle({
    key: anthropicKey,
    models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  });
  const gateway = createModelGateway({
    transaction,
    providers: Object.freeze({
      anthropic: createClaudeAdapter((request) => oracle.fetch(request)),
    }),
    now: () => Date.now(),
  });
  const brokerLines = [];
  const quiet = async (body) => {
    const previous = console.log;
    console.log = (...args) => brokerLines.push(args.map(String).join(" "));
    try {
      return await body();
    } finally {
      console.log = previous;
    }
  };
  // The store's sealed token (sim: owner-seeded as the install callback would store it) and
  // the Shopify stand-in that accepts exactly that token.
  const token = "shpat_" + randomBytes(16).toString("hex");
  const sealed = await sealVaultRecord(
    capabilities.vault.keyring,
    {
      kind: "shopify_offline_token",
      organizationId: O,
      workspaceId: W,
      credentialId: "credential_" + INSTALLATION,
      subjectId: INSTALLATION,
      provider: "shopify",
      version: 1,
    },
    new TextEncoder().encode(token),
  );
  db.workOwner(
    `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at) VALUES(${literal(O)},${literal(W)},${literal("credential_" + INSTALLATION)},1,'shopify','shopify_offline_token',${literal(INSTALLATION)},'active',1,${literal("\\x" + vaultBytesHex(sealed.wrappedKey))}::bytea,${literal("\\x" + vaultBytesHex(sealed.sealedValue))}::bytea,${ms});`,
  );
  const shop = createShopStandIn({ shop: "lab-store-undo.myshopify.com", token });
  const writer = createShopifyWriter({
    transaction,
    fetch: (url, init) => shop.fetch(url, init),
    now: () => Date.now(),
    sleep: (wait) => sleep(Math.min(wait, 200)),
  });
  // The ApiBroker binding as the api sees it (createBrokerApplyPort's shape).
  const brokerCalls = [];
  const brokerPort = {
    async apply(operationId, budgetMs) {
      brokerCalls.push({ method: "apply", operationId });
      return quiet(() => writer.apply(brokerEnv, operationId, budgetMs));
    },
    async reconcile(operationId, budgetMs) {
      brokerCalls.push({ method: "reconcile", operationId });
      return quiet(() => writer.reconcile(brokerEnv, operationId, budgetMs));
    },
    async undoCheck(operationId, budgetMs) {
      brokerCalls.push({ method: "undoCheck", operationId });
      return quiet(() => writer.undoCheck(brokerEnv, operationId, budgetMs));
    },
  };
  const undoChecks = () => brokerCalls.filter((c) => c.method === "undoCheck").length;

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
  const reviewOn = createReviewApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
    environment: "development",
    applyOpen: true,
    broker: brokerPort,
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
          240000,
          "request",
        );
      } finally {
        console.log = print;
      }
      const text = await response.text();
      const reply = { status: response.status, body: JSON.parse(text), text };
      // A loaded host may time a transaction out: retry with the same key, as the API asks.
      if (
        reply.status === 503 &&
        (reply.body.code === "unavailable" || reply.body.code === "uncertain") &&
        !options.once &&
        n < 5
      ) {
        retries++;
        await sleep(300);
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
      if (reply.status !== 503 || n >= 5) return reply;
      await sleep(300);
    }
  }
  const work = (p, path, body) => call(workApi, p, "POST", path, body);
  const listings = `/stores/${S}/agents/listings`;
  const enableListings = async () => {
    const doc = await agentsCall(P.A, "POST", listings + "/document", {});
    return agentsCall(P.A, "POST", listings, {
      documentDigest: doc.body.documentDigest,
      nonce: doc.body.nonce,
    });
  };
  const stopListings = () =>
    agentsCall(P.A, "POST", listings + "/stop", {
      control: { reason: "Pause the store changes", sourceProposalRef: null },
    });
  const goal = await work(P.A, "/goals", {
    objective: "Better listings",
    storeIds: [],
    successCriteria: [
      { description: "Done", verificationCapabilityId: null, evidenceRequired: false },
    ],
  });
  const newTask = async (objective) =>
    (
      await work(P.A, "/tasks", {
        goalId: goal.body.goalId,
        objective,
        allowedResources: [],
      })
    ).body.taskId;
  const T = await newTask("Rewrite the titles and descriptions to be clearer for summer shoppers");
  const enabled = await enableListings();
  const installation = one(
    `SELECT id::text AS id,agent_principal_id::text AS agent,status FROM morrow_work.agent_installations WHERE store_id=${literal(S)}`,
  );
  check(
    "U0:fixtures_task_installation_entitlement_and_the_undo_port",
    typeof T === "string" &&
      enabled.status === 200 &&
      installation?.status === "active" &&
      capabilities.shopifyWrite === "on",
    { goal: goal.status, enabled: enabled.body, installation },
  );

  // A Listings run drafts real proposals from the stand-in's current state.
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
  const productOf = (n) => {
    const v = shop.view(n);
    return {
      productId: "product:" + n,
      title: v.title,
      descriptionHtml: v.descriptionHtml,
      seo: { ...v.seo },
      tags: [...v.tags],
    };
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
    modelRespond: (leaseId, generation, callJson, budgetMs) =>
      quiet(() => gateway.modelRespond(brokerEnv, leaseId, generation, callJson, budgetMs)),
    async readProduct(_ref, _runId, productId) {
      const n = /^product:([0-9]+)$/.exec(productId)?.[1];
      return n && shop.products.has(n)
        ? { outcome: "read", product: productOf(n) }
        : { outcome: "not_found" };
    },
    environment: "development",
    now: () => Date.now(),
    sleep: (wait) => sleep(Math.min(wait, 50)),
    ids: () => randomUUID(),
  };
  const durable = () => ({
    async do(_name, body) {
      for (let n = 1; ; n++) {
        try {
          return JSON.parse(JSON.stringify(await body()));
        } catch (error) {
          if (!(error instanceof RunStepRetry) || n >= 5) throw error;
        }
      }
    },
  });
  const allFields = ["descriptionHtml", "seo.description", "seo.title", "tags", "title"];
  let productNumber = 200;
  const original = new Map();
  const newProduct = () => {
    const n = ++productNumber;
    const p = {
      title: "Linen shirt " + n,
      descriptionHtml: "<p>Original description of shirt " + n + ".</p>",
      tags: ["summer", "linen"],
      seo: { title: null, description: null },
    };
    shop.put(n, p);
    original.set(n, p);
    return n;
  };
  // One run over these products on a task, executed to its end; returns its one proposal.
  async function draft(numbers, task = T, fields = allFields) {
    const admitted = await call(runsOn, P.A, "POST", "/tasks/" + task + "/runs", {
      storeId: S,
      products: numbers.map((n) => "product:" + n),
      fields,
      selection: { model: "claude_sonnet_5_5", effort: "low" },
    });
    const runId = admitted.body.runId;
    if (admitted.status !== 201)
      throw Error("UNDO_LAB_RUN_REFUSED:" + JSON.stringify(admitted.body));
    const lease = one(
      `SELECT lease_id::text AS lease_id,lease_generation::int AS generation FROM morrow_work.runs WHERE id=${literal(runId)}`,
    );
    const result = await within(
      listingsRun(
        ports,
        durable(),
        { leaseId: lease.lease_id, generation: lease.generation },
        runId,
      ),
      600000,
      "run " + runId,
    );
    const proposals = db.rows(
      `SELECT DISTINCT proposal_id::text AS id FROM morrow_work.run_products WHERE run_id=${literal(runId)} AND proposal_id IS NOT NULL`,
    );
    if (result.kind !== "ended" || proposals.length !== 1)
      throw Error(
        "UNDO_LAB_RUN_FAILED:" +
          JSON.stringify({ result, proposals, violations: oracle.violations }),
      );
    return proposals[0].id;
  }
  const review = (p, id, query = "") =>
    call(reviewOn, p, "GET", "/proposals/" + id + "/review" + query);
  const decision = (digest, revision = 1) => ({
    decision: {
      decision: "approve",
      selectedTargetIndexes: null,
      expectedDecisionDigest: digest,
      soloOwnerConfirmation: null,
      comment: null,
    },
    expectedRevision: revision,
  });
  const decide = (p, id, body) => call(reviewOn, p, "POST", "/proposals/" + id + "/decision", body);
  async function approveAll(id, p = P.A) {
    const r = await review(p, id);
    const d = await decide(p, id, decision(r.body.proposal.digest, r.body.approval.revision));
    if (d.status !== 201) throw Error("UNDO_LAB_DECIDE_FAILED:" + JSON.stringify(d.body));
    return { proposalRef: d.body.proposalRef, approvalRef: d.body.approvalRef };
  }
  async function apply(p, id, refs, options = {}) {
    const key = options.key ?? randomUUID();
    let reply;
    for (let n = 0; n < 6; n++) {
      reply = await call(reviewOn, p, "POST", "/proposals/" + id + "/apply", refs, { key });
      if (reply.status !== 200 || reply.body.pending === 0) break;
    }
    return reply;
  }
  const ops = (familyRootId) =>
    db.rows(
      `SELECT id::text AS id,target_index::int AS i,target_resource_id::text AS product,status,(SELECT t.reason FROM morrow_work.operation_transitions t WHERE t.operation_id=o.id ORDER BY t.revision DESC LIMIT 1) AS reason FROM morrow_work.operations o WHERE claim_family_root_id=${literal(familyRootId)} ORDER BY target_index`,
    );
  const undo = (p, operationId, options = {}) =>
    call(reviewOn, p, "POST", "/operations/" + operationId + "/undo", {}, options);
  const history = (p, task = T, options = {}) =>
    call(reviewOn, p, "GET", "/tasks/" + task + "/operations", undefined, options);
  const undoOf = (h, operationId) => {
    const i = h.body.operations?.findIndex((o) => o.operationId === operationId) ?? -1;
    return i < 0 ? null : h.body.undo[i];
  };
  // What Undo must never leave behind when it refuses.
  const footprint = () =>
    JSON.stringify({
      undos: count("SELECT count(*) FROM morrow_work.catalog_undos"),
      proposals: count("SELECT count(*) FROM morrow_work.proposals"),
      approvals: count("SELECT count(*) FROM morrow_work.approvals"),
      claims: count("SELECT count(*) FROM morrow_work.approval_claims"),
      operations: count("SELECT count(*) FROM morrow_work.operations"),
      updates: shop.count("ProductUpdate"),
    });
  // The listing as Shopify holds it, compared the way a read-back compares it.
  const sameListing = (n, want) => {
    const v = shop.view(n);
    const got = {
      title: v.title,
      descriptionHtml: v.descriptionHtml,
      "seo.title": v.seo.title,
      "seo.description": v.seo.description,
      tags: v.tags,
    };
    const expected = {
      title: want.title,
      descriptionHtml: want.descriptionHtml,
      "seo.title": want.seo.title,
      "seo.description": want.seo.description,
      tags: want.tags,
    };
    return Object.keys(got).every(
      (f) => normalisedValue(f, got[f]) === normalisedValue(f, expected[f]),
    );
  };
  const spa = {};

  // ---------------------------------------------------------------------------
  phase("apply");
  const p1 = [newProduct(), newProduct()];
  const X1 = await draft(p1);
  const refs1 = await approveAll(X1);
  const applied1 = await apply(P.A, X1, refs1);
  const ops1 = ops(X1);
  {
    const h = await history(P.A);
    const u0 = undoOf(h, ops1[0].id);
    const until = Date.parse(u0?.availableUntil ?? "");
    check(
      "U1:undo_is_offered_on_a_change_confirmed_in_shopify_for_90_days",
      applied1.status === 200 &&
        ops1.every((o) => o.status === "verified") &&
        h.status === 200 &&
        h.body.undo.length === h.body.operations.length &&
        u0?.state === "available" &&
        u0.undoProposalId === null &&
        until > Date.now() + 89 * 86400_000 &&
        until <= Date.now() + 90 * 86400_000 + 60_000 &&
        undoOf(h, ops1[1].id)?.state === "available",
      { applied: applied1.body, h: h.body },
    );
  }

  // ---------------------------------------------------------------------------
  phase("undo");
  let U1;
  {
    const n = p1[0];
    const op = ops1[0].id;
    const reads = shop.count("ProductWriteState", n);
    const updates = shop.count("ProductUpdate");
    const key = randomUUID();
    const requested = await undo(P.A, op, { key });
    spa.undo = { body: requested.body, op };
    U1 = requested.body.proposalId;
    const stored = one(
      `SELECT p.proposer_kind,p.proposer_installation_id::text AS installation,p.proposer_principal_id::text AS proposer,p.requester_principal_id::text AS requester,p.task_id::text AS task,p.store_id::text AS store,p.target_count::int AS targets,p.digest::text AS digest,p.canonical,q.canonical AS parameters,a.status AS approval FROM morrow_work.proposals p JOIN morrow_work.proposal_parameters q ON q.id=p.parameters_id JOIN morrow_work.approvals a ON a.proposal_id=p.id WHERE p.id=${literal(U1 ?? "absent")}`,
    );
    const target = stored ? JSON.parse(stored.canonical).targets[0] : null;
    const set = stored ? JSON.parse(stored.parameters).items[0]?.set : null;
    const originalTarget = JSON.parse(
      one(`SELECT canonical FROM morrow_work.proposals WHERE id=${literal(X1)}`).canonical,
    ).targets[0];
    const current = listingSnapshotText({
      productId: "product:" + n,
      title: shop.view(n).title,
      descriptionHtml: shop.view(n).descriptionHtml,
      seo: shop.view(n).seo,
      tags: shop.view(n).tags,
    });
    const record = one(
      `SELECT operation_id::text AS op,check_sequence::int AS sequence,requester_principal_id::text AS requester FROM morrow_work.catalog_undos WHERE proposal_id=${literal(U1 ?? "absent")}`,
    );
    const checkRow = one(
      `SELECT verdict,current_digest::text AS digest,field_verdicts FROM morrow_work.operation_undo_checks WHERE operation_id=${literal(op)} ORDER BY sequence DESC LIMIT 1`,
    );
    check(
      "U2:undo_reads_the_product_once_and_stores_a_new_exact_proposal_back_to_the_values_before",
      requested.status === 201 &&
        requested.body.outcome === "applied" &&
        requested.body.status === "pending" &&
        requested.body.operationId === op &&
        stored?.proposer_kind === "agent" &&
        stored.installation === installation.id &&
        stored.proposer === installation.agent &&
        stored.requester === P.A.principal &&
        stored.task === T &&
        stored.store === S &&
        stored.targets === 1 &&
        stored.digest === requested.body.proposalDigest &&
        stored.approval === "pending" &&
        stored.digest !== refs1.proposalRef.digest &&
        target.resource.id === "product:" + n &&
        JSON.stringify(target.fields) === JSON.stringify(originalTarget.fields) &&
        target.expectedSourceRevision === sha(current) &&
        checkRow?.verdict === "unchanged" &&
        checkRow.digest === sha(current) &&
        set.title === original.get(n).title &&
        set.descriptionHtml === original.get(n).descriptionHtml &&
        JSON.stringify(set.tags) === JSON.stringify(original.get(n).tags) &&
        set.seo.title === "" &&
        set.seo.description === "" &&
        record?.op === op &&
        record.requester === P.A.principal &&
        shop.count("ProductWriteState", n) === reads + 1 &&
        shop.count("ProductUpdate") === updates &&
        count(
          `SELECT count(*) FROM morrow_work.outbox_events WHERE event_type='proposal.submitted' AND aggregate_id=${literal(U1 ?? "absent")} AND actor_principal_id=${literal(P.A.principal)}`,
        ) === 1,
      { requested: requested.body, stored, target, set, checkRow },
    );
    const r = await review(P.A, U1);
    spa.undoReview = { body: r.body, id: U1 };
    const changes = r.body.products?.[0]?.changes ?? [];
    const title = changes.find((c) => c.field === "title");
    check(
      "U3:the_review_shows_the_undo_before_as_now_and_after_as_the_values_before_the_apply",
      r.status === 200 &&
        r.body.undoOf?.operationId === op &&
        r.body.undoOf.proposalId === X1 &&
        r.body.undoOf.productId === "product:" + n &&
        r.body.products.length === 1 &&
        r.body.products[0].source === "available" &&
        title?.before === shop.view(n).title &&
        title.after === original.get(n).title &&
        r.body.approval.status === "pending" &&
        r.body.actionable === true,
      r.body,
    );
    // The same key replays; another key while it waits is refused; nothing more is read.
    const before = footprint();
    const checks0 = undoChecks();
    const replay = await undo(P.A, op, { key });
    const again = await undo(P.A, op);
    check(
      "U4:a_replay_returns_the_same_undo_and_a_second_undo_while_one_waits_is_refused",
      replay.status === 200 &&
        replay.body.outcome === "replayed" &&
        replay.body.proposalId === U1 &&
        again.status === 409 &&
        /already waiting/.test(again.body.safeMessage) &&
        footprint() === before &&
        undoChecks() === checks0,
      { replay: replay.body, again: again.body },
    );
    // No shortcut: the original's approval, the undo's own pending approval and another
    // digest each write nothing.
    const writes = footprint();
    const withOriginal = await call(reviewOn, P.A, "POST", "/proposals/" + U1 + "/apply", refs1);
    const unapproved = await call(reviewOn, P.A, "POST", "/proposals/" + U1 + "/apply", {
      proposalRef: r.body.proposalRef,
      approvalRef: r.body.approvalRef,
    });
    const wrongDigest = await decide(P.A, U1, decision(refs1.proposalRef.digest));
    check(
      "U5:an_undo_has_no_shortcut_past_its_own_exact_approval",
      withOriginal.status === 400 &&
        [409, 403].includes(unapproved.status) &&
        wrongDigest.status === 409 &&
        footprint() === writes,
      {
        withOriginal: withOriginal.body,
        unapproved: unapproved.body,
        wrongDigest: wrongDigest.body,
      },
    );
    // Approved with its own digest, applied through the same gateway.
    const refsU = await approveAll(U1);
    const updatesBefore = shop.count("ProductUpdate", n);
    const appliedU = await apply(P.A, U1, refsU);
    const opsU = ops(U1);
    const sent = shop.calls.filter(
      (c) => c.operation === "ProductUpdate" && c.product === String(n),
    );
    check(
      "U6:the_approved_undo_goes_through_the_same_gateway_and_restores_the_values_before",
      appliedU.status === 200 &&
        refsU.proposalRef.digest === stored.digest &&
        refsU.approvalRef.id !== refs1.approvalRef.id &&
        opsU.length === 1 &&
        opsU[0].status === "verified" &&
        shop.count("ProductUpdate", n) === updatesBefore + 1 &&
        sent.at(-1)?.keys.join() === "descriptionHtml,id,seo,tags,title" &&
        sameListing(n, original.get(n)),
      { appliedU: appliedU.body, opsU, view: shop.view(n) },
    );
    const h = await history(P.A);
    spa.history = h.body;
    const before2 = footprint();
    const checks1 = undoChecks();
    const twice = await undo(P.A, op);
    check(
      "U7:the_history_shows_it_undone_and_a_second_undo_of_the_same_change_is_refused",
      undoOf(h, op)?.state === "undone" &&
        undoOf(h, op).undoProposalId === U1 &&
        undoOf(h, opsU[0].id)?.undoOfOperationId === op &&
        twice.status === 409 &&
        /already undone/.test(twice.body.safeMessage) &&
        footprint() === before2 &&
        undoChecks() === checks1,
      { h: h.body, twice: twice.body },
    );
  }

  // ---------------------------------------------------------------------------
  phase("changed");
  let op2;
  {
    // The merchant edits the second product's title in Shopify after the apply.
    const n = p1[1];
    const op = ops1[1].id;
    shop.edit(n, { title: "Merchant's own title " + n });
    const before = footprint();
    const stopped = await undo(P.A, op);
    const checkRow = one(
      `SELECT verdict,field_verdicts FROM morrow_work.operation_undo_checks WHERE operation_id=${literal(op)} ORDER BY sequence DESC LIMIT 1`,
    );
    check(
      "U8:a_product_changed_since_the_apply_stops_undo_and_nothing_is_written",
      stopped.status === 409 &&
        /^The title changed in Shopify after Morrow applied this change, so Undo stopped\. Nothing was written\.$/.test(
          stopped.body.safeMessage,
        ) &&
        checkRow?.verdict === "changed" &&
        JSON.parse(JSON.stringify(checkRow.field_verdicts)).title === "changed" &&
        footprint() === before &&
        shop.view(n).title === "Merchant's own title " + n,
      { stopped: stopped.body, checkRow },
    );
    // A change between the undo and its apply: the gateway's pre-send read refuses it.
    const p2 = [newProduct()];
    const X2 = await draft(p2);
    await apply(P.A, X2, await approveAll(X2));
    op2 = ops(X2)[0].id;
    const requested = await undo(P.A, op2);
    const U2 = requested.body.proposalId;
    const refsU2 = await approveAll(U2);
    shop.edit(p2[0], { tags: ["merchant", "own"] });
    const updates = shop.count("ProductUpdate", p2[0]);
    const appliedU2 = await apply(P.A, U2, refsU2);
    const opsU2 = ops(U2);
    check(
      "U9:a_change_between_the_undo_and_its_apply_is_refused_by_the_gateway_with_nothing_written",
      requested.status === 201 &&
        appliedU2.status === 200 &&
        opsU2[0]?.status === "failed" &&
        opsU2[0].reason === "source_changed" &&
        shop.count("ProductUpdate", p2[0]) === updates &&
        JSON.stringify(shop.view(p2[0]).tags) === '["merchant","own"]',
      { appliedU2: appliedU2.body, opsU2 },
    );
  }

  // ---------------------------------------------------------------------------
  phase("window");
  {
    // Two products applied together. sim: 91 days pass after the first one's apply (its send
    // and creation moved back, triggers off).
    const p3 = [newProduct(), newProduct()];
    const X3 = await draft(p3);
    await apply(P.A, X3, await approveAll(X3));
    const [op3, op4] = ops(X3).map((o) => o.id);
    replica(
      `UPDATE morrow_work.operations SET send_started_at=send_started_at-interval '91 days',submitted_at=submitted_at-interval '91 days',created_at=created_at-interval '91 days' WHERE id=${literal(op3)};`,
    );
    const h90 = await history(P.A);
    // sim: then shop/redact's effects on the second one's records (the proposal's parameters
    // emptied, digest kept, and the product's snapshots deleted), owner-applied as
    // store_content_redact does (lab:shopify-privacy runs the real redaction).
    db.workOwner(
      `UPDATE morrow_work.proposal_parameters q SET canonical='{}',redacted_at=greatest(${ms},q.created_at) WHERE q.id=(SELECT parameters_id FROM morrow_work.proposals WHERE id=${literal(X3)});
DELETE FROM morrow_work.product_snapshots WHERE product_id=${literal("product:" + p3[1])};`,
    );
    const h = await history(P.A);
    const before = footprint();
    const checks0 = undoChecks();
    const late = await undo(P.A, op3);
    const redacted = await undo(P.A, op4);
    check(
      "U10:after_90_days_or_the_shops_data_deleted_undo_is_no_longer_available",
      undoOf(h90, op3)?.state === "unavailable" &&
        undoOf(h90, op3).availableUntil === null &&
        undoOf(h90, op4)?.state === "available" &&
        undoOf(h, op4)?.state === "unavailable" &&
        late.status === 409 &&
        /no longer available/.test(late.body.safeMessage) &&
        redacted.status === 409 &&
        /no longer available/.test(redacted.body.safeMessage) &&
        footprint() === before &&
        undoChecks() === checks0,
      { h: h.body.undo, late: late.body, redacted: redacted.body },
    );
  }

  // ---------------------------------------------------------------------------
  phase("authority");
  {
    // The second change of phase "changed": verified, and available again after its undo
    // was refused with nothing written.
    const op5 = op2;
    const before = footprint();
    const checks0 = undoChecks();
    const absent = await undo(P.A, randomUUID());
    const foreign = [
      await undo(P.Y, op5),
      await undo(P.Y, op5, { workspace: W }),
      await undo(P.A2, op5),
      await undo(P.X, op5),
    ];
    const foreignHistory = [await history(P.Y), await history(P.A2), await history(P.X)];
    const definerRows = (p) =>
      last(
        db.sql(
          `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${literal(p.digest)},${literal(p.workspace)}); SELECT (SELECT count(*) FROM morrow_work.catalog_undo_source(${literal(op5)}))+(SELECT count(*) FROM morrow_work.catalog_undo_states(${literal(T)})); ROLLBACK;`,
          { user: "morrow_api_worker" },
        ),
      );
    const shape = (x) => JSON.stringify({ status: x.status, code: x.body.code });
    check(
      "U11:another_workspace_tenant_or_member_without_the_store_read_gets_not_found",
      absent.status === 404 &&
        foreign.every((x) => [401, 404].includes(x.status)) &&
        foreign.filter((x) => x.status === 404).every((x) => shape(x) === shape(absent)) &&
        foreign[2].status === 404 &&
        foreign[3].status === 404 &&
        foreignHistory.every(
          (x) => x.status === 200 && x.body.operations.length === 0 && x.body.undo.length === 0,
        ) &&
        definerRows(P.Y) === "0" &&
        definerRows(P.A2) === "0" &&
        definerRows(P.A) !== "0" &&
        footprint() === before &&
        undoChecks() === checks0,
      {
        absent: absent.body,
        foreign: foreign.map((x) => [x.status, x.body.code]),
        history: foreignHistory.map((x) => x.status),
      },
    );
    // A person without `delegate` on catalog.content.publish (the Listings agent proposes the
    // undo on their behalf) is denied before any read.
    const grantId = "g_a_catalog_content_publish";
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{verbs}','["propose","approve","execute"]'::jsonb) WHERE id=${literal(grantId)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(O)};`,
    );
    let denied;
    try {
      denied = await undo(P.A, op5);
    } finally {
      db.admin(
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{verbs}','["propose","approve","execute","delegate"]'::jsonb) WHERE id=${literal(grantId)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(O)};`,
      );
    }
    check(
      "U12:a_person_without_the_propose_and_delegate_grants_is_denied_before_any_read",
      denied.status === 403 && footprint() === before && undoChecks() === checks0,
      denied.body,
    );
    // The broker's undo definers: no other login executes them, the api role neither, and a
    // setting the broker's login forges reaches nothing.
    const others = ["morrow_api_worker", "morrow_runtime_executor", "morrow_connector_ingress"].map(
      (user) =>
        db.tryRun(`SELECT * FROM morrow_vault.catalog_undo_resolve(${literal(op5)});`, { user }),
    );
    const apiDirect = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT * FROM morrow_vault.catalog_undo_record(${literal(op5)},'not_found',NULL,NULL,'missing'); ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    const forged = db.tryRun(
      `SELECT set_config('morrow.vault_undo_product',${literal(O + "|" + W + "|" + S + "|" + ops1[1].product)},false),set_config('morrow.vault_catalog_operation',${literal(op5)},false) IS NOT NULL; SELECT count(*) FROM morrow_work.operation_undo_checks;`,
      { user: "morrow_vault_broker" },
    );
    const resolved = db.tryRun(
      `SELECT outcome FROM morrow_vault.catalog_undo_resolve(${literal(op5)});`,
      { user: "morrow_vault_broker" },
    );
    check(
      "U13:only_the_brokers_login_executes_the_undo_definers_and_forged_settings_reach_nothing",
      others.every((r) => r.ok === false && /permission denied/.test(r.stderr)) &&
        apiDirect.ok === false &&
        forged.ok === false &&
        /permission denied/.test(forged.stderr) &&
        resolved.ok &&
        last(resolved.stdout) === "resolved",
      {
        others: others.map((r) => r.stderr.slice(0, 120)),
        forged: forged.stderr.slice(0, 160),
        resolved: resolved.stdout,
      },
    );
  }

  // ---------------------------------------------------------------------------
  phase("batch");
  {
    const T2 = await newTask("Tidy the summer collection");
    const Y1 = await draft([newProduct()], T2);
    const Y2 = await draft([newProduct()], T2);
    const doc = await call(reviewOn, P.A, "GET", "/proposals/" + Y1 + "/batch");
    const digests = db.rows(
      `SELECT id::text AS id,digest::text AS digest FROM morrow_work.proposals WHERE task_id=${literal(T2)} ORDER BY created_at,id`,
    );
    check(
      "B1:the_server_built_document_lists_the_tasks_pending_changes_with_their_exact_digests",
      doc.status === 200 &&
        doc.body.unavailable === null &&
        doc.body.taskId === T2 &&
        doc.body.items.length === 2 &&
        doc.body.items.every(
          (i, k) =>
            i.proposalId === digests[k].id && i.digest === digests[k].digest && i.revision === 1,
        ) &&
        Date.parse(doc.body.expiresAt) - Date.parse(doc.body.issuedAt) === 300_000,
      doc.body,
    );
    const body = (d) => ({
      documentDigest: d.documentDigest,
      issuedAt: d.issuedAt,
      items: d.items.map((i) => ({
        proposalId: i.proposalId,
        digest: i.digest,
        approvalId: i.approvalId,
        revision: i.revision,
      })),
    });
    const status = (id) =>
      one(`SELECT status FROM morrow_work.approvals WHERE proposal_id=${literal(id)}`)?.status;
    const decisions = () => count("SELECT count(*) FROM morrow_work.approval_decisions");
    const decide2 = (d, options) =>
      call(reviewOn, P.A, "POST", "/proposals/" + Y1 + "/batch-decision", d, options);
    // A new change arrives after the person opened the document: it approves nothing.
    const Y3 = await draft([newProduct()], T2);
    const decisions0 = decisions();
    const stale = await decide2(body(doc.body));
    // A tampered member (another digest, the document's digest recomputed) approves nothing.
    const actor = { actor: { principalId: P.A.principal, membershipId: P.A.membership } };
    const tamperedItems = doc.body.items.map((i, k) =>
      k === 1 ? { ...i, digest: "f".repeat(64) } : i,
    );
    const tampered = await decide2({
      ...body({ ...doc.body, items: tamperedItems }),
      documentDigest: await batchDigest(W, actor, P.A.digest, doc.body.issuedAt, tamperedItems),
    });
    // One member decided by someone else after the document was read refuses them all.
    const doc3 = await call(reviewOn, P.A, "GET", "/proposals/" + Y1 + "/batch");
    await approveAll(Y3, P.A1);
    const decisions3 = decisions();
    const elsewhere = await decide2(body(doc3.body));
    // An expired document (issued 6 minutes ago, its digest recomputed) approves nothing.
    const fresh = await call(reviewOn, P.A, "GET", "/proposals/" + Y1 + "/batch");
    const oldAt = new Date(Date.parse(fresh.body.issuedAt) - 360_000).toISOString();
    const expired = await decide2({
      ...body({ ...fresh.body, issuedAt: oldAt }),
      documentDigest: await batchDigest(W, actor, P.A.digest, oldAt, fresh.body.items),
    });
    check(
      "B2:a_stale_tampered_or_expired_document_approves_nothing",
      stale.status === 409 &&
        /not the same as when you opened them/.test(stale.body.safeMessage) &&
        tampered.status === 409 &&
        expired.status === 409 &&
        /has expired/.test(expired.body.safeMessage) &&
        decisions() === decisions0 + 1 &&
        status(Y1) === "pending" &&
        status(Y2) === "pending",
      { stale: stale.body, tampered: tampered.body, expired: expired.body },
    );
    check(
      "B3:one_member_decided_elsewhere_refuses_them_all",
      doc3.body.items?.length === 3 &&
        elsewhere.status === 409 &&
        decisions() === decisions3 &&
        status(Y3) === "approved" &&
        status(Y1) === "pending" &&
        status(Y2) === "pending",
      { doc3: doc3.body, elsewhere: elsewhere.body },
    );
    // One confirmation: one exact approval per change, in one transaction.
    const key = randomUUID();
    const decided = await decide2(body(fresh.body), { key });
    spa.batchDocument = { body: fresh.body, id: Y1 };
    spa.batchDecided = decided.body;
    check(
      "B4:one_confirmation_records_one_exact_approval_per_change",
      fresh.body.items.length === 2 &&
        decided.status === 201 &&
        decided.body.outcome === "applied" &&
        decided.body.decided.length === 2 &&
        fresh.body.items.every(
          (item) =>
            status(item.proposalId) === "approved" &&
            one(
              `SELECT proposal_digest::text AS digest FROM morrow_work.approvals WHERE proposal_id=${literal(item.proposalId)}`,
            )?.digest === item.digest,
        ) &&
        decided.body.decided.every(
          (d, k) =>
            d.proposalRef.id === fresh.body.items[k].proposalId &&
            d.proposalRef.digest === fresh.body.items[k].digest &&
            validateCurrentDefinition("ApprovalRef", d.approvalRef),
        ) &&
        decisions() === decisions3 + 2,
      { decided: decided.body },
    );
    const replay = await decide2(body(fresh.body), { key });
    const reuse = await decide2(body(fresh.body));
    check(
      "B5:a_replay_replays_and_a_second_use_of_the_document_is_refused",
      replay.status === 200 &&
        replay.body.outcome === "replayed" &&
        replay.body.decided.length === 2 &&
        reuse.status === 409 &&
        decisions() === decisions3 + 2,
      { replay: replay.body, reuse: reuse.body },
    );
    const foreign = [
      await call(reviewOn, P.Y, "GET", "/proposals/" + Y1 + "/batch"),
      await call(reviewOn, P.A2, "GET", "/proposals/" + Y1 + "/batch"),
      await call(reviewOn, P.Y, "POST", "/proposals/" + Y1 + "/batch-decision", body(fresh.body)),
    ];
    check(
      "B6:another_tenant_or_workspace_gets_not_found",
      foreign.every((x) => [401, 404].includes(x.status)) &&
        foreign[0].status === 404 &&
        foreign[1].status === 404,
      foreign.map((x) => [x.status, x.body.code]),
    );
    // Each approved change is still claimed on its own and rechecked by the gateway: a stop
    // between two applies refuses the second, with nothing written.
    const [d1, d2] = decided.body.decided;
    const a1 = await apply(P.A, d1.proposalRef.id, {
      proposalRef: d1.proposalRef,
      approvalRef: d1.approvalRef,
    });
    const stopped = await stopListings();
    const updates = shop.count("ProductUpdate");
    const a2 = await apply(P.A, d2.proposalRef.id, {
      proposalRef: d2.proposalRef,
      approvalRef: d2.approvalRef,
    });
    check(
      "B7:each_batch_approval_is_still_claimed_alone_and_rechecked_by_the_gateway",
      a1.status === 200 &&
        ops(d1.proposalRef.id)[0]?.status === "verified" &&
        stopped.status === 200 &&
        a2.status === 409 &&
        ops(d2.proposalRef.id).length === 0 &&
        shop.count("ProductUpdate") === updates,
      { a1: a1.body, a2: a2.body },
    );
    await enableListings();
  }

  // ---------------------------------------------------------------------------
  phase("picker");
  {
    // The picker reads through the catalogue routes: the linked store under the product read
    // rule and a read lease; ids and titles only. The broker's reader is a recorder here
    // (lab:shopify-privacy runs the real one).
    const reads = [];
    const catalog = createCatalogApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(),
      now: () => Date.now(),
      reader: {
        async read(lease, queryName, variablesJson) {
          reads.push({ queryName, variables: JSON.parse(variablesJson), lease: lease.leaseId });
          return JSON.stringify({
            schemaVersion: 1,
            outcome: "read",
            products: [{ id: "product:" + p1[0], title: "Linen shirt", status: "active" }],
            nextCursor: null,
          });
        },
      },
    });
    const get = async (p, storeId, options = {}) => {
      console.log = (...args) => workerLines.push(args.map(String).join(" "));
      try {
        const response = await catalog.fetch(
          new Request(
            workFixtureOrigin +
              "/workspace/" +
              (options.workspace ?? p.workspace) +
              "/stores/" +
              storeId +
              "/catalog/products?query=linen",
            {
              method: "GET",
              headers: {
                Cookie: "__Host-morrow_session=" + p.secret,
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
              },
            },
          ),
          undefined,
          ctx,
        );
        return { status: response.status, body: await response.json() };
      } finally {
        console.log = print;
      }
    };
    const own = await get(P.A, S);
    spa.products = { body: own.body, storeId: S };
    const readsAfterOwn = reads.length;
    const foreign = [
      await get(P.Y, S),
      await get(P.Y, S, { workspace: W }),
      await get(P.A2, S),
      await get(P.X, S),
      await get(P.A, "store_absent"),
    ];
    check(
      "P1:the_picker_reads_only_the_linked_store_under_the_product_read_rule",
      own.status === 200 &&
        own.body.products.length === 1 &&
        readsAfterOwn === 1 &&
        reads[0].queryName === "productsPage" &&
        reads[0].variables.search === "linen" &&
        decodeCatalogProducts(own.body, S) !== null,
      { own: own.body, reads },
    );
    check(
      "P2:another_workspace_or_a_member_without_the_read_gets_nothing_and_nothing_is_read",
      foreign.every((x) => [401, 403, 404].includes(x.status)) &&
        foreign[0].status === 404 &&
        foreign[2].status === 404 &&
        foreign[4].status === 404 &&
        reads.length === readsAfterOwn,
      foreign.map((x) => [x.status, x.body.code]),
    );
  }

  // ---------------------------------------------------------------------------
  phase("spa_decoders");
  {
    const requested = decodeUndoRequested(spa.undo.body, spa.undo.op);
    const undoReview = decodeReview(spa.undoReview.body, spa.undoReview.id);
    const h = decodeOperationsOfTask(spa.history, T);
    const document = decodeBatchDocument(spa.batchDocument.body, spa.batchDocument.id);
    const decided = decodeBatchDecided(spa.batchDecided);
    check(
      "W1:the_spa_decoders_accept_exactly_the_server_replies",
      requested !== null &&
        requested.proposalId === U1 &&
        undoReview?.undoOf?.operationId === spa.undo.op &&
        h !== null &&
        h.some((o) => o.undo.state === "undone") &&
        document !== null &&
        document.items.length === 2 &&
        decided !== null &&
        decided.decided.length === 2 &&
        // A wider body never decodes.
        decodeUndoRequested({ ...spa.undo.body, extra: 1 }, spa.undo.op) === null &&
        decodeOperationsOfTask({ ...spa.history, undo: spa.history.undo.slice(1) }, T) === null &&
        decodeBatchDocument({ ...spa.batchDocument.body, extra: 1 }, spa.batchDocument.id) === null,
      { requested, h: !!h, document: !!document, decided: !!decided },
    );
  }

  // ---------------------------------------------------------------------------
  phase("logs");
  {
    const text = workerLines.join("\n") + "\n" + brokerLines.join("\n");
    const titles = [...original.values()].map((p) => p.title);
    check(
      "L1:no_product_text_reaches_a_log_line",
      workerLines.length > 0 &&
        titles.every((t) => !text.includes(t)) &&
        !text.includes("Original description") &&
        !text.includes("Merchant") &&
        !text.includes(token),
      { lines: workerLines.length, broker: brokerLines.length },
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
      "v1.PR4.catalog-undo",
      async (db) => {
        result = await runCatalogUndoLab(db);
      },
      { administrator: "createrole" },
    );
  } catch (error) {
    console.error("UNDO_LAB_FAILED_IN:" + stage);
    throw error;
  }
  phase("report");
  writeArtifact("labs/catalog-undo.json", {
    task: "v1 PR 4",
    qualification: "local_postgresql17_network_none_catalog_undo",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    unavailableRetries: result.retries,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "The review handler and the broker's writer run in Node over psql connectors (morrow_api_worker, morrow_runtime_executor, morrow_vault_broker), not in workerd over the Neon transport; the ApiBroker RPC is a direct call.",
      "Shopify is an in-process stand-in shaped from Shopify's documentation (the product read and productUpdate); the owner's first undo on a draft product checks the live shapes.",
      "90 days passing and shop/redact's effects are owner-seeded (sim); lab:shopify-privacy runs the real redaction. The picker's broker reader is a recorder; lab:shopify-privacy runs the real reader.",
    ],
  });
  if (result.failures.length) {
    print("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else print(`PASS: ${result.checks.length} v1 PR 4 catalog undo checks.`);
}

await main();
