// v1 PR 3 PostgreSQL 17 laboratory: review, approve and apply to Shopify (migrations 0044
// catalog-review and 0045 catalog-apply) on an isolated network-none engine, the full
// manifest applied by the Neon-shaped non-superuser CREATEROLE administrator (ADR-0020 D4).
// It drives the real code end to end: a Listings run (runs handler, the Workflow logic and
// the broker's model gateway against the in-process Messages API stand-in) drafts real
// proposals; the review handler (packages/work/src/review/http.ts, Node, the psql work
// connector logged in as morrow_api_worker) reviews, decides and applies them; and the
// broker's writer (apps/broker/src/shopify-write.ts) runs over the vault login's real
// transport (runVaultTransactionWithDriver) against an in-process Shopify stand-in shaped
// from Shopify's documentation (productUpdate and the product read-back), never a store.
// It proves:
//   V  review: before and after per product and field from the draft's own snapshot, tag
//      changes and reviewer flags, the description as text; a subset previews its own exact
//      digest; another tenant, another workspace and a member without the store's product
//      read get the same not_found, and the review definers return nothing to them;
//   D  digest binding: a decision on another digest is refused and writes nothing; approve
//      all binds the root's digest; approve some binds the derived proposal's own digest; an
//      approval never applies another digest, a derived proposal or a re-drafted ("edited")
//      proposal: each is DIGEST_MISMATCH and writes nothing;
//   A  apply: with the switch off, 503 before any write; on, one claim, one lease and one
//      authorized operation per product, each bound to its exact approved item; one
//      productUpdate per product carrying only the approved fields; read back and verified;
//      the history and the transitions; a replay, a second tab and another claimant change
//      nothing; a person who lost the execute grant writes nothing;
//   S  stops: "Stop AI work" before the apply refuses the claim and writes nothing; a stop or
//      a disconnect between the claim and the write closes the operation with nothing sent;
//      and, last, v1 PR 2's real "Disconnect store" (its connections handler and the
//      broker's token destruction) between the claim and the write: nothing is sent, a later
//      approved proposal is refused at its claim, and the token is erased (S4-S6);
//   C  a product changed in Shopify since the draft is refused (source_changed), nothing is
//      written and the other products still apply;
//   O  Shopify's answers: userErrors (failed, nothing applied), THROTTLED then success (one
//      execution), 401 (failed), a 5xx and a lost reply after Shopify applied it (uncertain,
//      then verified by reading back, never sent again), an edit at the same moment
//      (read-back differs: uncertain, needs attention), Shopify reformatting tags and HTML
//      (verified), and a lost reply that never applied (uncertain until two read-backs 60 s
//      apart prove no effect);
//   F  the fence as the broker's login: in flight and settled operations are never sent, a
//      late close is never promoted, forged settings reach nothing and no other login
//      executes the catalog definers;
//   B  one open write per product (review F2): an uncertain write holds its product only until
//      it is read back after its send window; then a new approved change applies; a read-back
//      taken after that later write never settles the earlier one; the person who applied it
//      sets it aside (not before its window, never someone else), and it is still read back;
//   L  no product text, Shopify text or token reaches a response, a log line or a record.
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data. Shapes
// marked sim stand in for states no API path reaches yet. CI pg-linking group.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { disconnectFields } from "../packages/policy/src/store-link-template.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createAgentsApiHandler } from "../packages/work/src/agents/http.ts";
import { createWorkApiHandler } from "../packages/work/src/http.ts";
import { createRunsApiHandler } from "../packages/work/src/runs/http.ts";
import { createReviewApiHandler } from "../packages/work/src/review/http.ts";
import { createConnectionsApiHandler } from "../packages/work/src/connections/http.ts";
import { listingsRun, RunStepRetry } from "../packages/work/src/runs/workflow.ts";
import { createRuntimeAttempt, runLeaseStep } from "../packages/work/src/runtime/leases.ts";
import { createBrokerCredentialDestroyer } from "../apps/api/src/broker-client.ts";
import { brokerCapabilities } from "../apps/broker/src/capabilities.ts";
import { createClaudeAdapter } from "../apps/broker/src/claude-adapter.ts";
import { createModelGateway } from "../apps/broker/src/model-gateway.ts";
import { createShopifyBroker } from "../apps/broker/src/shopify-install.ts";
import { createShopifyWriter } from "../apps/broker/src/shopify-write.ts";
import { runVaultTransactionWithDriver } from "../apps/broker/src/vault-database.ts";
import { sealVaultRecord, vaultBytesHex } from "../apps/broker/src/vault.ts";
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
import {
  decodeApplied,
  decodeDecided,
  decodeOperationsOfTask,
  decodePendingApprovals,
  decodeRechecked,
  decodeReview,
  decodeSetAside,
} from "../apps/workspace-web/src/http/review-decoders.ts";

const checks = [];
const failures = [];
const labStarted = Date.now();
let stage = "start";
const phase = (value) => {
  stage = value;
  console.error(
    "APPLY_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
};
function within(promise, timeoutMs, wait) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("APPLY_LAB_STALLED:" + stage + ":" + wait)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("APPLY_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
    // The route's own outcome codes of the last requests (ids and codes only).
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
const workerLines = [];

// ---------------------------------------------------------------------------
// The Shopify stand-in: the Admin GraphQL endpoint of one shop, answering the gateway's two
// fixed documents (ProductWriteState and ProductUpdate) by operation name from a synthetic
// catalogue, shaped from Shopify's documentation. productUpdate replaces each given field (tags
// as the full list, seo as a whole); updatedAt advances on every change. Faults are queued per
// product and consumed by its next productUpdate:
//   throttled         a THROTTLED reply; nothing applied (the broker waits and resends once)
//   user_errors       userErrors; nothing applied
//   unauthorized      401; nothing applied
//   server_error      applied, then a 500
//   lost              applied, then the connection is lost (fetch throws)
//   lost_unapplied    the connection is lost before Shopify ran it
//   edit_after        applied, then the merchant edits the title at the same moment
//   normalise         applied as Shopify reformats it: tags reordered and re-cased, HTML
//                     whitespace changed
// Every request is recorded (operation, product number, the input's keys) for the checks.
function createShopStandIn({ shop, token }) {
  const products = new Map();
  const calls = [];
  const faults = new Map();
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
    fault(n, ...kinds) {
      faults.set(String(n), [...(faults.get(String(n)) ?? []), ...kinds]);
    },
    updates: (n) =>
      calls.filter((c) => c.operation === "ProductUpdate" && (n === undefined || c.product === n))
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
        const fault = faults.get(String(n))?.shift() ?? null;
        if (fault === "throttled")
          return json(200, {
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: {
              cost: {
                requestedQueryCost: 10,
                throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 9, restoreRate: 50 },
              },
            },
          });
        if (fault === "unauthorized")
          return json(401, { errors: "[API] Invalid API key or access token" });
        if (fault === "lost_unapplied") throw new TypeError("network connection lost");
        if (n === null || !products.has(String(n)))
          return json(200, {
            data: {
              productUpdate: { product: null, userErrors: [{ field: ["id"], message: "x" }] },
            },
          });
        if (fault === "user_errors")
          return json(200, {
            data: {
              productUpdate: {
                product: null,
                userErrors: [{ field: ["title"], message: "Title is invalid" }],
              },
            },
          });
        applyInput(n, input);
        if (fault === "normalise") {
          const p = products.get(String(n));
          p.tags = [...p.tags].reverse().map((t) => t.toUpperCase());
          p.descriptionHtml = p.descriptionHtml.replace("<p>", "<p>\n  ").replace("</p>", " </p>");
        }
        if (fault === "edit_after") applyInput(n, { title: "Merchant's own title " + n });
        if (fault === "server_error") return json(502, { errors: "Bad Gateway" });
        if (fault === "lost") throw new TypeError("network connection lost");
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

export async function runCatalogApplyLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  const O = P.A.org,
    W = P.A.workspace;
  const S = "store_apply",
    C = "connection_apply",
    INSTALLATION = "storeinst_apply";
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
    if (!validateCurrentDefinition("Grant", g)) throw Error("APPLY_LAB_GRANT_INVALID");
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
  // The founder (organization_signups) holds the owner bootstrap grants (approval decide
  // among them) and M2's store-link template on S; A1 is a member with the catalogue grants
  // and approval decide, so it could claim; X is a member without any store grant.
  db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_apply','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(P.A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_apply',${literal(O)},${literal(W)},${literal(P.A.membership)},'owner-bootstrap-v1',clock_timestamp());`);
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
      // The owner bootstrap's review grants (owner-bootstrap-v1: approval decide and preview,
      // workspace scoped), for A and for A1.
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
      storeGrant(
        P.A,
        "governance.model_default.revise",
        ["execute"],
        ["effort", "expectedRevision", "maxCreditsPerProduct", "model"],
        workspaceRes,
      ),
    ].join("\n"),
  );
  void capabilityFields;
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
      throw Error("APPLY_LAB_FIXTURE_FAILED:" + stage);
    }
    return r.stdout;
  };
  replica(`INSERT INTO morrow_billing.workspace_billing_routes VALUES(${literal(O)},${literal(W)},'website',NULL,NULL,NULL,NULL,NULL,1,${ms},${ms}) ON CONFLICT DO NOTHING;
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',created_at=${ms}-interval '2 days',route_fixed_at=${ms}-interval '1 day',fixing_payment_key='stripe:invoice:in_LabApplyPay0001',revision=2,updated_at=${ms} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};
INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},'morrow_direct','test','USD','active',1,${ms},${ms});
INSERT INTO morrow_billing.stripe_event_receipts(organization_id,workspace_id,id,event_id,event_type,livemode,mode,object_type,object_id,customer_id,object,object_digest,observed_at,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(receipt)},'evt_labapply00001','invoice.paid',false,'test','invoice','in_LabApplyPay0001',NULL,'{"kind":"invoice","id":"in_LabApplyPay0001","livemode":false}'::jsonb,${literal("d".repeat(64))},${ms},${ms});
INSERT INTO morrow_billing.entitlement_snapshots VALUES(${literal(O)},${literal(W)},${literal(account)},1,'morrow_direct','test','stripe:sub:sub_LabApplySub0001','active',${literal("c".repeat(64))},${ms}-interval '1 hour',${ms}+interval '29 days',${literal(receipt)},${ms});
INSERT INTO morrow_billing.verified_payment_events(organization_id,workspace_id,id,route,mode,payment_key,kind,subscription_key,price_key,period_start,period_end,operation_id,amount,currency,provider_evidence_ref,verified_at,outcome,outcome_code,receipt_id,recorded_at) VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},'morrow_direct','test','stripe:invoice:in_LabApplyPay0001','subscription_period','stripe:sub:sub_LabApplySub0001','stripe:price:price_MorrowDevBeta0049',${ms}-interval '1 day',${ms}+interval '29 days',${literal(randomUUID())},'49','USD',${literal("e".repeat(64))},${ms}-interval '1 hour','granted',NULL,${literal(receipt)},${ms});
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
  // What a refused apply must leave unchanged.
  const footprint = () =>
    JSON.stringify({
      claims: count("SELECT count(*) FROM morrow_work.approval_claims"),
      operations: count("SELECT count(*) FROM morrow_work.operations"),
      transitions: count("SELECT count(*) FROM morrow_work.operation_transitions"),
      leases: count("SELECT count(*) FROM morrow_work.work_leases WHERE kind='operation'"),
      writes: count("SELECT count(*) FROM morrow_work.operation_writes"),
      readbacks: count("SELECT count(*) FROM morrow_work.operation_readbacks"),
      events: count("SELECT count(*) FROM morrow_work.outbox_events"),
    });

  // The broker: the model-provider and apply switches on, the vault login over this engine.
  const anthropicKey = fakeAnthropicKey();
  const binding = {
    schemaVersion: 1,
    environment: "development",
    projectId: "morrow-apply-lab",
    branchId: "br-apply-lab",
    hostname: "ep-apply-lab.c-14.us-east-1.aws.neon.tech",
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
  const brokerOff = { ...brokerEnv };
  delete brokerOff.MORROW_SHOPIFY_WRITE;
  const capabilitiesOff = await brokerCapabilities(brokerOff);
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
  // The broker logs nothing on these paths; anything it would print is kept out of the
  // captured api lines, and the caller's capture is restored after.
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
  check(
    "A0:broker_holds_the_apply_switch_and_the_vault",
    capabilities.shopifyWrite === "on" &&
      capabilities.vault !== null &&
      capabilities.modelMode === "anthropic" &&
      capabilitiesOff.shopifyWrite === "off",
    { on: capabilities.shopifyWrite, off: capabilitiesOff.shopifyWrite },
  );

  // The store's sealed token (sim: owner-seeded as M2 PR-2's callback would store it) and the
  // Shopify stand-in that accepts exactly that token.
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
  const shop = createShopStandIn({ shop: "lab-store-apply.myshopify.com", token });
  const writer = createShopifyWriter({
    transaction,
    fetch: (url, init) => shop.fetch(url, init),
    now: () => Date.now(),
    sleep: (wait) => sleep(Math.min(wait, 200)),
  });
  // The ApiBroker binding as the api sees it (createBrokerApplyPort's shape): ids and a budget.
  const brokerCalls = [];
  const hooks = { beforeApply: null };
  const brokerPort = {
    async apply(operationId, budgetMs) {
      brokerCalls.push({ method: "apply", operationId });
      if (hooks.beforeApply) await hooks.beforeApply(operationId);
      return quiet(() => writer.apply(brokerEnv, operationId, budgetMs));
    },
    async reconcile(operationId, budgetMs) {
      brokerCalls.push({ method: "reconcile", operationId });
      return quiet(() => writer.reconcile(brokerEnv, operationId, budgetMs));
    },
  };

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
  const reviewOff = createReviewApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
    environment: "development",
    applyOpen: false,
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
      // A loaded host may time a transaction out (unavailable, or uncertain when the commit's
      // acknowledgement was lost): retry with the same key, as the API asks; a committed
      // command answers as replayed.
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
  const T = (
    await work(P.A, "/tasks", {
      goalId: goal.body.goalId,
      objective: "Rewrite the titles and descriptions to be clearer for summer shoppers",
      allowedResources: [],
    })
  ).body.taskId;
  const enabled = await enableListings();
  const installation = one(
    `SELECT id::text AS id,status FROM morrow_work.agent_installations WHERE store_id=${literal(S)}`,
  );
  check(
    "A0:fixtures_task_installation_and_entitlement",
    typeof T === "string" && enabled.status === 200 && installation?.status === "active",
    { goal: goal.status, enabled: enabled.body, installation },
  );

  // A Listings run drafts real proposals: the product read is the Shopify stand-in's current
  // state (as M2 PR-3's productContent would return it), so each snapshot's digest is the
  // product as Shopify holds it at the draft.
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
  let productNumber = 100;
  const newProduct = (over = {}) => {
    const n = ++productNumber;
    shop.put(n, {
      title: "Linen shirt " + n,
      descriptionHtml: "<p>Original description of shirt " + n + ".</p>",
      tags: ["summer", "linen"],
      seo: { title: null, description: null },
      ...over,
    });
    return n;
  };
  // One run over these products and fields, executed to its end; returns its one proposal.
  async function draft(numbers, fields = allFields) {
    const admitted = await call(runsOn, P.A, "POST", "/tasks/" + T + "/runs", {
      storeId: S,
      products: numbers.map((n) => "product:" + n),
      fields,
      selection: { model: "claude_sonnet_5_5", effort: "low" },
    });
    const runId = admitted.body.runId;
    if (admitted.status !== 201)
      throw Error("APPLY_LAB_RUN_REFUSED:" + JSON.stringify(admitted.body));
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
        "APPLY_LAB_RUN_FAILED:" +
          JSON.stringify({
            result,
            proposals,
            run: one(`SELECT status,ended_reason FROM morrow_work.runs WHERE id=${literal(runId)}`),
            products: db.rows(
              `SELECT product_index,status,failure_code FROM morrow_work.run_products WHERE run_id=${literal(runId)} ORDER BY product_index`,
            ),
            violations: oracle.violations,
            requests: oracle.requests?.slice(-4),
            broker: brokerLines.slice(-6),
          }),
      );
    return proposals[0].id;
  }
  const review = (p, id, query = "") =>
    call(reviewOn, p, "GET", "/proposals/" + id + "/review" + query);
  const decision = (digest, selected = null) => ({
    decision: {
      decision: "approve",
      selectedTargetIndexes: selected,
      expectedDecisionDigest: digest,
      soloOwnerConfirmation: null,
      comment: null,
    },
    expectedRevision: 1,
  });
  const decide = (p, id, body) => call(reviewOn, p, "POST", "/proposals/" + id + "/decision", body);
  // Approve all: the root's own digest.
  async function approveAll(id, p = P.A) {
    const r = await review(p, id);
    const d = await decide(p, id, decision(r.body.proposal.digest));
    if (d.status !== 201) throw Error("APPLY_LAB_DECIDE_FAILED:" + JSON.stringify(d.body));
    return { proposalRef: d.body.proposalRef, approvalRef: d.body.approvalRef };
  }
  // Applies until no product is left authorized (each request runs within its own budget;
  // the same key continues the same claim).
  async function apply(p, id, refs, options = {}) {
    const key = options.key ?? randomUUID();
    const handler = options.handler ?? reviewOn;
    let reply;
    for (let n = 0; n < 6; n++) {
      reply = await call(handler, p, "POST", "/proposals/" + id + "/apply", refs, { key });
      if (reply.status !== 200 || reply.body.pending === 0) break;
    }
    return reply;
  }
  const ops = (familyRootId) =>
    db.rows(
      `SELECT id::text AS id,target_index::int AS i,target_resource_id::text AS product,status,uncertainty_reason,attempt::int AS attempt,(SELECT t.reason FROM morrow_work.operation_transitions t WHERE t.operation_id=o.id ORDER BY t.revision DESC LIMIT 1) AS reason FROM morrow_work.operations o WHERE claim_family_root_id=${literal(familyRootId)} ORDER BY target_index`,
    );
  const path = (operationId) =>
    db
      .rows(
        `SELECT to_status FROM morrow_work.operation_transitions WHERE operation_id=${literal(operationId)} ORDER BY revision`,
      )
      .map((r) => r.to_status)
      .join(">");

  // ---------------------------------------------------------------------------
  // The real replies the SPA's closed decoders must accept (W1).
  const spa = {};
  phase("review");
  const p1 = [newProduct(), newProduct({ tags: ["summer", "Linen", "summer"] }), newProduct()];
  const X1 = await draft(p1);
  if (process.env.MORROW_LAB_PROBE === "1") await probeReview(db, P.A, X1);
  {
    const r = await review(P.A, X1);
    const stored = one(
      `SELECT digest::text AS digest,canonical FROM morrow_work.proposals WHERE id=${literal(X1)}`,
    );
    const products = r.body.products ?? [];
    const first = products[0];
    const title = first?.changes.find((c) => c.field === "title");
    const description = first?.changes.find((c) => c.field === "descriptionHtml");
    check(
      "V1:review_shows_before_and_after_per_field_from_the_draft_snapshot",
      r.status === 200 &&
        r.body.proposal.digest === stored.digest &&
        r.body.proposalRef.digest === stored.digest &&
        r.body.proposalRef.storeId === S &&
        r.body.approval.status === "pending" &&
        r.body.viewerRole === "reviewer" &&
        r.body.actionable === true &&
        r.body.blocked === null &&
        r.body.claim === null &&
        products.length === 3 &&
        products.every((p, i) => p.productId === "product:" + p1[i] && p.source === "available") &&
        first.changes.map((c) => c.field).join() ===
          "title,descriptionHtml,seo.title,seo.description,tags" &&
        title.before === "Linen shirt " + p1[0] &&
        title.after === "Linen shirt " + p1[0] + " - improved" &&
        description.before === "<p>Original description of shirt " + p1[0] + ".</p>" &&
        description.after === "<p>A clearer description of product:" + p1[0] + ".</p>" &&
        first.changes.find((c) => c.field === "seo.title").before === null &&
        JSON.stringify(first.tags) === JSON.stringify({ added: ["improved"], removed: [] }) &&
        first.flags !== null &&
        Number.isSafeInteger(first.flags.newUrls),
      r.body,
    );
    const subset = await review(P.A, X1, "?selected=0,2");
    check(
      "V2:a_subset_previews_its_own_exact_digest",
      subset.status === 200 &&
        subset.body.proposal.digest !== stored.digest &&
        subset.body.proposal.derivedFromId === X1 &&
        JSON.stringify(subset.body.proposal.selectedTargetIndexes) === "[0,2]" &&
        subset.body.products.map((p) => p.productId).join() ===
          ["product:" + p1[0], "product:" + p1[2]].join() &&
        subset.body.products.map((p) => p.targetIndex).join() === "0,2",
      subset.body,
    );
    // Tenant isolation of the review records: another organization's member (Y, in its own
    // workspace path and in A's), a member of another workspace of the same organization
    // (A2) and a member of W without the store's product read (X) all get the same
    // not_found as an absent id; the review definers return nothing outside the tenant.
    const absent = await review(P.A, "proposal_absent");
    const foreign = [
      await review(P.Y, X1),
      await call(reviewOn, P.Y, "GET", "/proposals/" + X1 + "/review", undefined, {
        workspace: W,
      }),
      await review(P.A2, X1),
      await review(P.X, X1),
    ];
    const definerRows = (p) =>
      last(
        db.sql(
          `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${literal(p.digest)},${literal(p.workspace)}); SELECT (SELECT count(*) FROM morrow_work.catalog_review_sources(${literal(X1)}))+(SELECT count(*) FROM morrow_work.catalog_claim_of(${literal(X1)})); ROLLBACK;`,
          { user: "morrow_api_worker" },
        ),
      );
    const shape = (x) => JSON.stringify({ status: x.status, code: x.body.code });
    check(
      "V3:another_tenant_workspace_or_member_without_the_store_read_sees_not_found",
      absent.status === 404 &&
        foreign.every((x) => [404, 401].includes(x.status)) &&
        foreign.filter((x) => x.status === 404).every((x) => shape(x) === shape(absent)) &&
        foreign[2].status === 404 &&
        foreign[3].status === 404 &&
        definerRows(P.Y) === "0" &&
        definerRows(P.A2) === "0" &&
        definerRows(P.A) !== "0",
      { absent: absent.body, foreign: foreign.map((x) => [x.status, x.body.code]) },
    );
  }

  // ---------------------------------------------------------------------------
  phase("decisions");
  let refs1;
  {
    const r = await review(P.A, X1);
    const before = footprint();
    const wrong = await decide(P.A, X1, decision("f".repeat(64)));
    const decisions = count(
      `SELECT count(*) FROM morrow_work.approval_decisions d JOIN morrow_work.approvals a ON a.id=d.approval_id WHERE a.family_root_id=${literal(X1)}`,
    );
    check(
      "D1:a_decision_on_another_digest_is_refused_and_writes_nothing",
      wrong.status === 409 && decisions === 0 && footprint() === before,
      wrong.body,
    );
    spa.review = r.body;
    spa.pending = (await call(reviewOn, P.A, "GET", "/approvals")).body;
    const approved = await decide(P.A, X1, decision(r.body.proposal.digest));
    spa.decided = approved.body;
    refs1 = { proposalRef: approved.body.proposalRef, approvalRef: approved.body.approvalRef };
    const after = await review(P.A, X1);
    check(
      "D2:approve_all_binds_the_root_digest",
      approved.status === 201 &&
        approved.body.status === "approved" &&
        approved.body.proposalRef.id === X1 &&
        approved.body.proposalRef.digest === r.body.proposal.digest &&
        approved.body.proposalRef.storeId === S &&
        validateCurrentDefinition("ApprovalRef", approved.body.approvalRef) &&
        after.body.approval.status === "approved",
      approved.body,
    );
  }

  // ---------------------------------------------------------------------------
  phase("apply_switch_off");
  {
    const before = footprint();
    const off = await call(reviewOff, P.A, "POST", "/proposals/" + X1 + "/apply", refs1);
    check(
      "A1:switch_off_refuses_before_any_write",
      off.status === 503 &&
        off.body.code === "unavailable" &&
        footprint() === before &&
        shop.updates() === 0 &&
        brokerCalls.length === 0,
      off.body,
    );
  }

  // ---------------------------------------------------------------------------
  phase("edits_void_approvals");
  {
    // D3-D5: an approval applies only the exact digest it names. A tampered digest, the
    // root's approval on a derived proposal, a derived approval on the root and the root's
    // approval on a re-drafted proposal of the same product ("an edit makes a new
    // proposal") are each DIGEST_MISMATCH or not found, with nothing written.
    const p2 = [newProduct(), newProduct()];
    const X2 = await draft(p2);
    const refs2 = await approveAll(X2);
    const before = footprint();
    const tampered = await apply(P.A, X2, {
      proposalRef: { ...refs2.proposalRef, digest: "e".repeat(64) },
      approvalRef: refs2.approvalRef,
    });
    const crossed = await apply(P.A, X2, {
      proposalRef: refs1.proposalRef,
      approvalRef: refs2.approvalRef,
    });
    const otherApproval = await apply(P.A, X2, {
      proposalRef: refs2.proposalRef,
      approvalRef: refs1.approvalRef,
    });
    check(
      "D3:an_approval_never_applies_another_digest",
      tampered.status === 409 &&
        crossed.status === 400 &&
        // Another proposal's approval names no approval of this one: not found.
        otherApproval.status === 404 &&
        footprint() === before &&
        shop.updates() === 0,
      { tampered: tampered.body, crossed: crossed.body, other: otherApproval.body },
    );
    // Approve some: a derived proposal with its own digest and approval.
    const p3 = [newProduct(), newProduct()];
    const X3 = await draft(p3);
    const preview = await review(P.A, X3, "?selected=1");
    const some = await decide(P.A, X3, decision(preview.body.proposal.digest, [1]));
    const rootRefs = {
      proposalRef: (await review(P.A, X3)).body.proposalRef,
      approvalRef: some.body.approvalRef,
    };
    const derivedId = some.body.proposalRef?.id;
    const before3 = footprint();
    const mixed = await apply(P.A, X3, rootRefs);
    check(
      "D4:approve_some_binds_the_derived_digest_and_never_the_root",
      some.status === 201 &&
        some.body.status === "approved" &&
        derivedId !== X3 &&
        some.body.proposalRef.digest === preview.body.proposal.digest &&
        // The derived approval names no approval of the root: not found, as in D3.
        mixed.status === 404 &&
        footprint() === before3,
      { some: some.body, mixed: mixed.body },
    );
    // A re-draft of the same product is a new proposal (new digest, pending); the earlier
    // approval cannot apply it.
    const X2b = await draft([p2[0]]);
    const redraft = await review(P.A, X2b);
    const before4 = footprint();
    const stale = await apply(P.A, X2b, {
      proposalRef: redraft.body.proposalRef,
      approvalRef: refs2.approvalRef,
    });
    check(
      "D5:an_edit_is_a_new_proposal_the_old_approval_cannot_apply",
      redraft.status === 200 &&
        redraft.body.approval.status === "pending" &&
        redraft.body.proposal.digest !== refs2.proposalRef.digest &&
        stale.status === 404 &&
        footprint() === before4 &&
        shop.updates() === 0,
      { stale: stale.body },
    );
    // The derived selection applies exactly its one product (D6 runs it to the end).
    const derivedApply = await apply(P.A, derivedId, {
      proposalRef: some.body.proposalRef,
      approvalRef: some.body.approvalRef,
    });
    const derivedOps = ops(X3);
    check(
      "D6:a_derived_approval_applies_only_its_selected_product",
      derivedApply.status === 200 &&
        derivedOps.length === 1 &&
        derivedOps[0].i === 1 &&
        derivedOps[0].product === "product:" + p3[1] &&
        derivedOps[0].status === "verified" &&
        shop.updates(String(p3[0])) === 0 &&
        shop.updates(String(p3[1])) === 1 &&
        shop.view(p3[1]).title === "Linen shirt " + p3[1] + " - improved",
      { derivedApply: derivedApply.body, derivedOps },
    );
  }

  // ---------------------------------------------------------------------------
  phase("apply");
  {
    const key = randomUUID();
    const before = shop.updates();
    const applied = await apply(P.A, X1, refs1, { key });
    const rows = ops(X1);
    const claim = one(
      `SELECT approval_id::text AS approval,claimant_principal_id::text AS claimant,consumer FROM morrow_work.approval_claims WHERE family_root_id=${literal(X1)}`,
    );
    const lease = one(
      `SELECT l.kind,l.status,l.started_at IS NOT NULL AS started,l.store_id::text AS store,l.installation_id::text AS installation FROM morrow_work.work_leases l JOIN morrow_work.operations o ON o.lease_id=l.id WHERE o.claim_family_root_id=${literal(X1)} LIMIT 1`,
    );
    const updates = shop.calls.filter(
      (c) => c.operation === "ProductUpdate" && p1.map(String).includes(c.product),
    );
    const parameters = JSON.parse(
      one(
        `SELECT p.canonical FROM morrow_work.proposal_parameters p JOIN morrow_work.proposals x ON x.parameters_id=p.id WHERE x.id=${literal(X1)}`,
      ).canonical,
    );
    const digests = db.rows(
      `SELECT o.target_index::int AS i,o.request_digest::text AS digest FROM morrow_work.operations o WHERE o.claim_family_root_id=${literal(X1)} ORDER BY o.target_index`,
    );
    const itemDigest = (i) => {
      const item = parameters.items.find((x) => x.targetIndex === i);
      const canonical = JSON.stringify({
        productId: item.productId,
        set: sortKeys(item.set),
        targetIndex: item.targetIndex,
      });
      return createHash("sha256").update(canonical, "utf8").digest("hex");
    };
    check(
      "A2:one_claim_one_lease_one_operation_per_product_bound_to_its_exact_item",
      applied.status === 200 &&
        applied.body.pending === 0 &&
        applied.body.operations.length === 3 &&
        claim?.claimant === P.A.principal &&
        claim.consumer === "catalog.apply" &&
        claim.approval === refs1.approvalRef.id &&
        lease?.kind === "operation" &&
        lease.started === true &&
        lease.store === S &&
        lease.installation === installation.id &&
        rows.length === 3 &&
        rows.every((r, i) => r.i === i && r.product === "product:" + p1[i]) &&
        digests.every((d) => d.digest === itemDigest(d.i)),
      { applied: applied.body, claim, lease, rows, digests },
    );
    check(
      "A3:one_product_update_per_product_with_only_the_approved_fields_then_verified",
      shop.updates() - before === 3 &&
        updates.length === 3 &&
        updates.every((u) => u.keys.join() === "descriptionHtml,id,seo,tags,title") &&
        rows.every((r) => r.status === "verified" && r.attempt === 1) &&
        rows.every(
          (r) =>
            path(r.id) === "awaiting_approval>authorized>dispatching>submitted>verifying>verified",
        ) &&
        p1.every(
          (n) =>
            shop.view(n).title === "Linen shirt " + n + " - improved" &&
            shop.view(n).seo.title === "SEO product:" + n &&
            shop.view(n).tags.includes("improved"),
        ) &&
        count(
          `SELECT count(*) FROM morrow_work.operation_writes w JOIN morrow_work.operations o ON o.id=w.operation_id WHERE o.claim_family_root_id=${literal(X1)} AND w.credential_id='credential_${INSTALLATION}' AND w.credential_version=1`,
        ) === 3 &&
        count(
          `SELECT count(*) FROM morrow_work.operation_readbacks r JOIN morrow_work.operations o ON o.id=r.operation_id WHERE o.claim_family_root_id=${literal(X1)} AND r.verdict='approved' AND r.outcome='read'`,
        ) === 3 &&
        count(
          `SELECT count(*) FROM morrow_work.outbox_events WHERE event_type='approval.claimed' AND aggregate_id=${literal(refs1.approvalRef.id)}`,
        ) === 1,
      { rows, paths: rows.map((r) => path(r.id)), updates },
    );
    // The history reads (codes only).
    spa.applied = applied.body;
    const history = await call(reviewOn, P.A, "GET", "/tasks/" + T + "/operations");
    spa.history = history.body;
    spa.reviewAfter = (await review(P.A, X1)).body;
    const detail = await call(reviewOn, P.A, "GET", "/operations/" + rows[0].id);
    const afterReview = await review(P.A, X1);
    check(
      "A4:the_apply_history_and_one_operation_read_codes_only",
      history.status === 200 &&
        rows.every((r) => history.body.operations.some((o) => o.operationId === r.id)) &&
        detail.status === 200 &&
        detail.body.operation.status === "verified" &&
        detail.body.operation.verdict === "approved" &&
        detail.body.transitions.length === 6 &&
        detail.body.readbacks.length === 1 &&
        detail.body.readbacks[0].fields.title === "approved" &&
        afterReview.body.claim?.mine === true &&
        afterReview.body.claim.operations.length === 3,
      { history: history.body, detail: detail.body },
    );
    // A replay (same key), a second tab (another key) and the same person again change
    // nothing; another member with the same grants is refused; another tenant sees nothing.
    const updatesBefore = shop.updates();
    const footprintBefore = footprint();
    const replay = await apply(P.A, X1, refs1, { key });
    const secondTab = await apply(P.A, X1, refs1);
    const other = await apply(P.A1, X1, refs1);
    const foreign = await call(reviewOn, P.Y, "POST", "/proposals/" + X1 + "/apply", refs1, {
      workspace: W,
    });
    const foreignRead = await call(reviewOn, P.Y, "GET", "/operations/" + rows[0].id, undefined, {
      workspace: W,
    });
    const foreignOwn = await call(reviewOn, P.Y, "GET", "/operations/" + rows[0].id);
    check(
      "A5:a_replay_a_second_tab_or_another_claimant_writes_nothing_more",
      replay.status === 200 &&
        replay.body.replayed === true &&
        secondTab.status === 200 &&
        secondTab.body.replayed === true &&
        other.status === 409 &&
        [401, 404].includes(foreign.status) &&
        [401, 404].includes(foreignRead.status) &&
        foreignOwn.status === 404 &&
        shop.updates() === updatesBefore &&
        footprint() === footprintBefore,
      {
        replay: replay.body,
        secondTab: secondTab.body,
        other: other.body,
        foreign: [foreign.status, foreignRead.status, foreignOwn.status],
      },
    );
  }

  // ---------------------------------------------------------------------------
  phase("authority");
  {
    // A person who lost the execute grant after approving writes nothing.
    const p4 = [newProduct()];
    const X4 = await draft(p4);
    const refs4 = await approveAll(X4);
    const grantId = "g_a_catalog_content_publish";
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{verbs}','["propose","approve","delegate"]'::jsonb) WHERE id=${literal(grantId)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(O)};`,
    );
    const before = footprint();
    let lost;
    try {
      lost = await apply(P.A, X4, refs4);
    } finally {
      db.admin(
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{verbs}','["propose","approve","execute","delegate"]'::jsonb) WHERE id=${literal(grantId)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(O)};`,
      );
    }
    check(
      "A6:a_claimant_without_execute_writes_nothing",
      lost.status === 403 && footprint() === before && shop.updates(String(p4[0])) === 0,
      lost.body,
    );
    // Restored, the same approval applies (the policy revision moved, so it is re-decided
    // only if the review policy changed; it did not).
    const again = await apply(P.A, X4, refs4);
    check(
      "A7:with_the_grant_back_the_same_approval_applies",
      again.status === 200 && ops(X4)[0]?.status === "verified",
      again.body,
    );
  }

  // ---------------------------------------------------------------------------
  phase("stale_product");
  {
    const p5 = [newProduct(), newProduct()];
    const X5 = await draft(p5);
    const refs5 = await approveAll(X5);
    // The merchant edits the first product in Shopify after the draft.
    shop.edit(p5[0], { title: "Changed in Shopify " + p5[0] });
    const updatesBefore = shop.updates(String(p5[0]));
    const applied = await apply(P.A, X5, refs5);
    const rows = ops(X5);
    check(
      "C1:a_product_changed_since_the_draft_is_not_written_and_the_rest_apply",
      applied.status === 200 &&
        rows[0].status === "failed" &&
        rows[0].reason === "source_changed" &&
        rows[0].attempt === 0 &&
        shop.updates(String(p5[0])) === updatesBefore &&
        shop.view(p5[0]).title === "Changed in Shopify " + p5[0] &&
        rows[1].status === "verified" &&
        applied.body.operations.find((o) => o.operationId === rows[0].id)?.reason ===
          "source_changed",
      { applied: applied.body, rows },
    );
  }

  // ---------------------------------------------------------------------------
  phase("stops");
  {
    // S1: "Stop AI work" after approving: the claim is refused and nothing is written.
    const p6 = [newProduct()];
    const X6 = await draft(p6);
    const refs6 = await approveAll(X6);
    const stopped = await stopListings();
    const before = footprint();
    const refused = await apply(P.A, X6, refs6);
    check(
      "S1:stop_ai_work_before_the_apply_refuses_it_and_writes_nothing",
      stopped.status === 200 &&
        refused.status === 409 &&
        footprint() === before &&
        shop.updates(String(p6[0])) === 0,
      { stopped: stopped.body, refused: refused.body },
    );
    const resumed = await enableListings();
    // S2: a stop between the claim and the write: the broker refuses the send.
    const p7 = [newProduct(), newProduct()];
    const resumedOk = resumed.status === 200;
    const X7 = await draft(p7);
    const refs7 = await approveAll(X7);
    hooks.beforeApply = async () => {
      hooks.beforeApply = null;
      await stopListings();
    };
    const mid = await apply(P.A, X7, refs7);
    const rows = ops(X7);
    check(
      "S2:a_stop_between_the_claim_and_the_write_sends_nothing",
      resumedOk &&
        mid.status === 200 &&
        rows[0].status === "failed" &&
        rows[0].reason === "stopped" &&
        rows[0].attempt === 0 &&
        rows[1].status === "conflict" &&
        ["stopped", "installation_inactive"].includes(rows[1].reason) &&
        shop.updates(String(p7[0])) === 0 &&
        shop.updates(String(p7[1])) === 0,
      { mid: mid.body, rows },
    );
    await enableListings();
    // S3: a disconnect between the claim and the write (sim: the system connection stop the
    // connector records on app/uninstalled, inserted with the triggers off): nothing is sent.
    const p8 = [newProduct()];
    const X8 = await draft(p8);
    const refs8 = await approveAll(X8);
    const stopId = randomUUID();
    hooks.beforeApply = async () => {
      hooks.beforeApply = null;
      replica(
        `SET LOCAL ROLE morrow_work_owner; INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,set_by_operator_id,reason_code,reason,created_at) VALUES(${literal(O)},${literal(W)},${literal(stopId)},'connection',${literal(S)},${literal(C)},'system',NULL,NULL,NULL,'shopify_app_uninstalled','sim',${ms});`,
      );
    };
    const disconnected = await apply(P.A, X8, refs8);
    const rows8 = ops(X8);
    check(
      "S3:a_disconnect_between_the_claim_and_the_write_sends_nothing",
      disconnected.status === 200 &&
        rows8[0].status === "failed" &&
        rows8[0].reason === "stopped" &&
        shop.updates(String(p8[0])) === 0,
      { disconnected: disconnected.body, rows8 },
    );
    replica(
      `SET LOCAL ROLE morrow_work_owner; DELETE FROM morrow_work.stop_controls WHERE id=${literal(stopId)};`,
    );
  }

  // The O6 operation (uncertain: an edit at the same moment), for the product rule (B).
  const held = { op: null, n: null };
  // ---------------------------------------------------------------------------
  phase("shopify_outcomes");
  {
    // O1-O7: one product per Shopify answer, in one claim.
    const kinds = [
      "user_errors",
      "throttled",
      "unauthorized",
      "server_error",
      "lost",
      "edit_after",
      "normalise",
    ];
    const numbers = kinds.map(() => newProduct());
    const X9 = await draft(numbers, ["descriptionHtml", "tags", "title"]);
    const refs9 = await approveAll(X9);
    kinds.forEach((kind, i) => shop.fault(numbers[i], kind));
    const applied = await apply(P.A, X9, refs9);
    const rows = ops(X9);
    check(
      "O0:the_claim_records_one_operation_per_product",
      applied.status === 200 && rows.length === kinds.length,
      { applied: applied.body, rows },
    );
    const at = (kind) => rows[kinds.indexOf(kind)] ?? {};
    const n = (kind) => String(numbers[kinds.indexOf(kind)]);
    held.op = at("edit_after").id;
    held.n = n("edit_after");
    check(
      "O1:user_errors_fail_with_nothing_applied",
      at("user_errors").status === "failed" &&
        at("user_errors").reason === "provider_rejected" &&
        shop.updates(n("user_errors")) === 1 &&
        shop.view(n("user_errors")).title === "Linen shirt " + n("user_errors"),
      at("user_errors"),
    );
    check(
      "O2:throttled_then_success_executes_once_and_verifies",
      at("throttled").status === "verified" &&
        shop.updates(n("throttled")) === 2 &&
        shop.view(n("throttled")).title === "Linen shirt " + n("throttled") + " - improved",
      at("throttled"),
    );
    check(
      "O3:a_401_fails_with_nothing_applied",
      at("unauthorized").status === "failed" &&
        at("unauthorized").reason === "connection_unauthorized" &&
        shop.view(n("unauthorized")).title === "Linen shirt " + n("unauthorized"),
      at("unauthorized"),
    );
    check(
      "O4:a_5xx_after_shopify_applied_it_is_uncertain_then_verified_by_reading_back",
      at("server_error").status === "verified" &&
        path(at("server_error").id) ===
          "awaiting_approval>authorized>dispatching>uncertain>verifying>verified" &&
        at("server_error").uncertainty_reason === "transport_after_dispatch" &&
        shop.updates(n("server_error")) === 1,
      { row: at("server_error"), path: path(at("server_error").id) },
    );
    check(
      "O5:a_lost_reply_after_shopify_applied_it_is_settled_by_reading_back_never_resent",
      at("lost").status === "verified" &&
        path(at("lost").id) ===
          "awaiting_approval>authorized>dispatching>uncertain>verifying>verified" &&
        shop.updates(n("lost")) === 1,
      { row: at("lost"), path: path(at("lost").id) },
    );
    check(
      "O6:an_edit_at_the_same_moment_leaves_the_read_back_mismatched_needs_attention",
      at("edit_after").status === "uncertain" &&
        at("edit_after").uncertainty_reason === "partial_result" &&
        at("edit_after").reason === "readback_differs" &&
        shop.updates(n("edit_after")) === 1 &&
        one(
          `SELECT field_verdicts->>'title' AS title FROM morrow_work.operation_readbacks WHERE operation_id=${literal(at("edit_after").id)} ORDER BY sequence DESC LIMIT 1`,
        )?.title === "other",
      at("edit_after"),
    );
    check(
      "O7:shopify_reformatting_tags_and_html_still_verifies",
      at("normalise").status === "verified" && shop.updates(n("normalise")) === 1,
      at("normalise"),
    );
    check(
      "O8:the_claim_reports_each_product_result",
      applied.status === 200 && applied.body.operations.length === kinds.length,
      applied.body,
    );
    // A read-back of a mismatched operation through the route stays uncertain (codes only),
    // and another tenant's read-back request reaches no broker.
    await sleep(10500);
    const foreignBefore = brokerCalls.length;
    const foreign = await call(
      reviewOn,
      P.Y,
      "POST",
      "/operations/" + at("edit_after").id + "/reconcile",
      {},
    );
    const callsBefore = brokerCalls.length;
    const retriesBefore = retries;
    const reread = await call(
      reviewOn,
      P.A,
      "POST",
      "/operations/" + at("edit_after").id + "/reconcile",
      {},
    );
    // One read-back per request. On a loaded host the route's own transaction after the
    // read-back can time out (503 unavailable); the same request again (the lab's retry with
    // the same key) then reads back once more or finds it too soon. Only read-backs of this
    // operation ever reach the broker, and nothing is sent.
    const rereadCalls = brokerCalls.slice(callsBefore);
    const rereadRetries = retries - retriesBefore;
    spa.rechecked = reread.body;
    spa.recheckedId = at("edit_after").id;
    check(
      "O9:a_read_back_on_request_keeps_a_mismatch_uncertain_and_another_tenant_reaches_nothing",
      foreign.status === 404 &&
        callsBefore === foreignBefore &&
        reread.status === 200 &&
        reread.body.operation.status === "uncertain" &&
        rereadCalls.length >= 1 &&
        rereadCalls.length <= 1 + rereadRetries &&
        rereadCalls.every(
          (c) => c.method === "reconcile" && c.operationId === at("edit_after").id,
        ) &&
        (rereadRetries === 0
          ? reread.body.outcome === "recorded"
          : ["recorded", "too_soon"].includes(reread.body.outcome)) &&
        shop.updates(n("edit_after")) === 1,
      {
        foreign: foreign.body,
        reread: reread.body,
        rereadCalls: rereadCalls.length,
        rereadRetries,
      },
    );
  }

  // ---------------------------------------------------------------------------
  phase("spa_decoders");
  {
    const review1 = decodeReview(spa.review, X1);
    const after1 = decodeReview(spa.reviewAfter, X1);
    const pending = decodePendingApprovals(spa.pending);
    const decided = decodeDecided(spa.decided);
    const applied = decodeApplied(spa.applied);
    const history = decodeOperationsOfTask(spa.history, T);
    const rechecked = decodeRechecked(spa.rechecked, spa.recheckedId);
    check(
      "W1:the_spa_decoders_accept_exactly_the_server_replies",
      review1 !== null &&
        review1.products.length === 3 &&
        after1 !== null &&
        after1.claim?.operations.length === 3 &&
        pending !== null &&
        pending.some((x) => x.proposalId === X1) &&
        decided !== null &&
        decided.status === "approved" &&
        applied !== null &&
        applied.pending === 0 &&
        history !== null &&
        history.length >= 3 &&
        rechecked !== null &&
        rechecked.status === "uncertain" &&
        // A wider body never decodes.
        decodeReview({ ...spa.review, extra: 1 }, X1) === null &&
        decodeApplied({
          ...spa.applied,
          operations: [{ ...spa.applied.operations[0], title: "x" }],
        }) === null,
      {
        review1: !!review1,
        after1: !!after1,
        pending,
        decided,
        applied: !!applied,
        history: !!history,
        rechecked,
      },
    );
  }

  // ---------------------------------------------------------------------------
  phase("fence");
  {
    // F1-F4 as the broker's login: a settled operation is never resolved again, a late close
    // is never promoted, forged settings reach nothing, and no other login executes the
    // catalog definers.
    const settledOp = db.rows(
      `SELECT id::text AS id FROM morrow_work.operations WHERE kind='catalog_write' AND status='verified' LIMIT 1`,
    )[0].id;
    const asBroker = (statement) => db.tryRun(statement, { user: "morrow_vault_broker" });
    const resolve = asBroker(
      `SELECT outcome||'|'||status FROM morrow_vault.catalog_write_resolve(${literal(settledOp)});`,
    );
    const begin = asBroker(
      `SELECT outcome||'|'||status FROM morrow_vault.catalog_write_begin(${literal(settledOp)},'read',${literal("a".repeat(64))},'2026-10-01T00:00:00Z','1');`,
    );
    const end = asBroker(
      `SELECT morrow_vault.catalog_write_end(${literal(settledOp)},'submitted','provider_accepted',NULL);`,
    );
    check(
      "F1:a_settled_operation_is_never_sent_and_a_late_close_is_never_promoted",
      resolve.ok &&
        last(resolve.stdout) === "settled|verified" &&
        begin.ok &&
        last(begin.stdout) === "settled|verified" &&
        end.ok &&
        last(end.stdout) === "state_conflict",
      { resolve: resolve.stdout, begin: begin.stdout, end: end.stdout },
    );
    const forged = asBroker(
      `SELECT set_config('morrow.vault_catalog_operation',${literal(settledOp)},false),set_config('morrow.vault_catalog_tenant',${literal(O + "|" + W)},false) IS NOT NULL; SELECT count(*) FROM morrow_work.operations;`,
    );
    check(
      "F2:forged_catalog_settings_reach_nothing",
      forged.ok === false && /permission denied/.test(forged.stderr),
      forged.stderr.slice(0, 200),
    );
    const others = ["morrow_api_worker", "morrow_runtime_executor", "morrow_connector_ingress"].map(
      (user) =>
        db.tryRun(`SELECT * FROM morrow_vault.catalog_write_resolve(${literal(settledOp)});`, {
          user,
        }),
    );
    const apiDirect = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT * FROM morrow_vault.catalog_reconcile_resolve(${literal(settledOp)}); ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    check(
      "F3:no_other_login_executes_the_catalog_definers",
      others.every((r) => r.ok === false && /permission denied/.test(r.stderr)) &&
        apiDirect.ok === false,
      others.map((r) => r.stderr.slice(0, 120)),
    );
    // The broker with the switch off: held before any input, database or Shopify access.
    const callsBefore = shop.calls.length;
    let held = null;
    try {
      await writer.apply(brokerOff, settledOp, 5000);
    } catch (error) {
      held = error?.code ?? String(error);
    }
    check(
      "F4:the_broker_with_the_switch_off_holds_before_anything",
      held === "WRITE_UNAVAILABLE" && shop.calls.length === callsBefore,
      held,
    );
  }

  // ---------------------------------------------------------------------------
  phase("leakage");
  {
    const texts = [...workerLines, ...brokerLines];
    const products = [...shop.products.values()];
    const leaked = (text) =>
      text.includes(token) ||
      products.some((p) => text.includes(p.title) || text.includes(p.descriptionHtml)) ||
      text.includes("improved") ||
      text.includes("Invalid API key");
    const records = db.sql(
      `SELECT coalesce(string_agg(row_to_json(o)::text,' '),'') FROM morrow_work.operations o;`,
    );
    const others = db.sql(
      `SELECT coalesce(string_agg(t::text,' '),'') FROM (SELECT row_to_json(w)::text AS t FROM morrow_work.operation_writes w UNION ALL SELECT row_to_json(r)::text FROM morrow_work.operation_readbacks r UNION ALL SELECT row_to_json(x)::text FROM morrow_work.operation_transitions x) y;`,
    );
    check(
      "L1:no_product_text_shopify_text_or_token_in_logs_or_records",
      texts.length > 0 &&
        texts.every((t) => !leaked(t)) &&
        !leaked(records) &&
        !leaked(others) &&
        texts.filter((t) => t.includes('"event":"morrow_review"')).length > 0,
      { leakedLines: texts.filter(leaked).slice(0, 3) },
    );
  }

  // ---------------------------------------------------------------------------
  phase("no_effect");
  {
    // N1: a reply lost before Shopify ran it: uncertain; read-backs show every field as
    // drafted with updatedAt unchanged; only two of them, 60 s apart and 30 s after the
    // fence, prove no effect (failed, verified_no_effect). Never resent.
    const p10 = [newProduct()];
    const X10 = await draft(p10, ["title"]);
    const refs10 = await approveAll(X10);
    shop.fault(p10[0], "lost_unapplied");
    const applied = await apply(P.A, X10, refs10);
    const op = ops(X10)[0];
    const first = op.status;
    const reconcile = () => call(reviewOn, P.A, "POST", "/operations/" + op.id + "/reconcile", {});
    await sleep(31000);
    const r1 = await reconcile();
    await sleep(61000);
    const r2 = await reconcile();
    const row = ops(X10)[0];
    check(
      "N1:a_lost_reply_that_never_applied_is_proven_no_effect_by_two_spaced_read_backs",
      applied.status === 200 &&
        first === "uncertain" &&
        op.uncertainty_reason === "transport_after_dispatch" &&
        r1.status === 200 &&
        r1.body.operation.status === "uncertain" &&
        r2.status === 200 &&
        row.status === "failed" &&
        row.reason === "readback_no_effect" &&
        shop.updates(String(p10[0])) === 1 &&
        shop.view(p10[0]).title === "Linen shirt " + p10[0],
      { first, op, r1: r1.body, r2: r2.body, row },
    );
  }
  // ---------------------------------------------------------------------------
  phase("product_rule");
  {
    // B1: the O6 write is uncertain and was read back only within its send window (at once,
    // and by O9): a new approved change to its product is refused (product_busy), unsent.
    const asBroker = (statement) => db.tryRun(statement, { user: "morrow_vault_broker" });
    const window = one(
      `SELECT (now()>=send_started_at+interval '90 seconds') AS past,(SELECT count(*) FROM morrow_work.operation_readbacks b WHERE b.operation_id=o.id AND b.observed_at>=o.send_started_at+interval '90 seconds')::int AS late FROM morrow_work.operations o WHERE id=${literal(held.op)}`,
    );
    const updates0 = shop.updates(held.n);
    const XB1 = await draft([Number(held.n)], ["title"]);
    const busy = await apply(P.A, XB1, await approveAll(XB1));
    const b1 = ops(XB1)[0];
    check(
      "B1:an_uncertain_write_not_read_back_after_its_window_holds_its_product",
      window?.past === true &&
        window?.late === 0 &&
        busy.status === 200 &&
        b1.status === "failed" &&
        b1.reason === "product_busy" &&
        b1.attempt === 0 &&
        shop.updates(held.n) === updates0,
      { window, busy: busy.body, b1 },
    );
    // B2: a read-back after the window (it stays uncertain: the merchant's edit) frees the
    // product; the next approved change applies and verifies; the earlier one is unchanged.
    await sleep(10500);
    const late = await call(reviewOn, P.A, "POST", "/operations/" + held.op + "/reconcile", {});
    const XB2 = await draft([Number(held.n)], ["title"]);
    const freed = await apply(P.A, XB2, await approveAll(XB2));
    const b2 = ops(XB2)[0];
    check(
      "B2:after_a_read_back_past_its_window_a_new_approved_change_applies",
      late.status === 200 &&
        late.body.operation.status === "uncertain" &&
        freed.status === 200 &&
        b2.status === "verified" &&
        shop.updates(held.n) === updates0 + 1 &&
        one(`SELECT status FROM morrow_work.operations WHERE id=${literal(held.op)}`)?.status ===
          "uncertain",
      { late: late.body, freed: freed.body, b2 },
    );
    // B3 (sim: the broker's own login records a read-back whose every field matches the earlier
    // write's approved values): once a later write to the product was fenced, Shopify's
    // product may hold that write's values, so the earlier one is never verified by it.
    await sleep(10500);
    const sent =
      one(
        `SELECT to_json(fields) AS fields FROM morrow_work.operation_writes WHERE operation_id=${literal(held.op)}`,
      )?.fields ?? [];
    const allApproved = JSON.stringify(Object.fromEntries(sent.map((f) => [f, "approved"])));
    const superseded = asBroker(
      `SELECT outcome||'|'||status FROM morrow_vault.catalog_reconcile_record(${literal(held.op)},'read','2026-10-24T00:00:00Z',${literal(allApproved)},'approved');`,
    );
    check(
      "B3:a_read_back_after_a_later_write_never_settles_the_earlier_one",
      sent.length > 0 &&
        superseded.ok &&
        last(superseded.stdout) === "recorded|uncertain" &&
        one(`SELECT status FROM morrow_work.operations WHERE id=${literal(held.op)}`)?.status ===
          "uncertain",
      { sent, superseded: superseded.stdout, stderr: superseded.stderr.slice(0, 200) },
    );
    // B4: only the person who applied it sets it aside, and only after its send window: a
    // write lost moments ago is too soon; another tenant gets not_found and another member
    // with the same grants is refused; the claimant's request sets it aside once (the same
    // request again answers unchanged). Nothing is sent.
    const pS = [newProduct()];
    const XS = await draft(pS, ["title"]);
    shop.fault(pS[0], "lost_unapplied");
    await apply(P.A, XS, await approveAll(XS));
    const fresh = ops(XS)[0];
    const setAside = (p, id, options) =>
      call(reviewOn, p, "POST", "/operations/" + id + "/set-aside", {}, options);
    const tooSoon = await setAside(P.A, fresh.id);
    const foreign = await setAside(P.Y, held.op);
    const other = await setAside(P.A1, held.op);
    const updatesBefore = shop.updates();
    const callsBefore = brokerCalls.length;
    const aside = await setAside(P.A, held.op);
    const again = await setAside(P.A, held.op);
    check(
      "B4:the_claimant_sets_an_uncertain_write_aside_after_its_window_and_no_one_else",
      fresh.status === "uncertain" &&
        tooSoon.status === 409 &&
        ops(XS)[0].status === "uncertain" &&
        foreign.status === 404 &&
        other.status === 403 &&
        other.body.code === "denied" &&
        aside.status === 200 &&
        aside.body.outcome === "set_aside" &&
        aside.body.operation.status === "cancel_requested" &&
        decodeSetAside(aside.body, held.op)?.status === "cancel_requested" &&
        again.status === 200 &&
        again.body.outcome === "unchanged" &&
        path(held.op).endsWith(">uncertain>cancel_requested") &&
        brokerCalls.length === callsBefore &&
        shop.updates() === updatesBefore,
      {
        fresh,
        tooSoon: tooSoon.body,
        foreign: foreign.status,
        other: other.body,
        aside: aside.body,
        again: again.body,
        path: path(held.op),
      },
    );
    // B5: a set-aside write is still read back (reconciliation continues); the later write
    // still means the read-back settles nothing, and nothing is sent.
    await sleep(10500);
    const reread = await call(reviewOn, P.A, "POST", "/operations/" + held.op + "/reconcile", {});
    check(
      "B5:a_set_aside_write_is_still_read_back_and_never_resent",
      reread.status === 200 &&
        ["recorded", "too_soon"].includes(reread.body.outcome) &&
        reread.body.operation.status === "cancel_requested" &&
        shop.updates(held.n) === updates0 + 1,
      reread.body,
    );
  }

  // ---------------------------------------------------------------------------
  phase("disconnect_store");
  {
    // v1 PR 2's "Disconnect store" (#53) through its own handler as the api login, with the
    // broker's destruction of the token over the vault login (the ApiBroker binding as
    // createBrokerCredentialDestroyer sees it). It runs last: nothing lifts a person's
    // connection stop, so no later phase could use this store. The founder holds store-link
    // template v2's disconnect grant on S (sim: owner-seeded as the link would issue it).
    db.admin(
      storeGrant(P.A, "governance.connection.disconnect", ["execute"], [...disconnectFields]),
    );
    const shopifyBroker = createShopifyBroker({
      transaction,
      fetch: (url, init) => shop.fetch(url, init),
      now: () => Date.now(),
    });
    const destroyCalls = [];
    const connections = createConnectionsApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(),
      now: () => Date.now(),
      credentials: createBrokerCredentialDestroyer({
        async shopifyCredentialDestroy(installationId) {
          destroyCalls.push(installationId);
          return quiet(() =>
            shopifyBroker.credentialDestroy(brokerEnv, installationId, "disconnected"),
          );
        },
      }),
    });
    const disconnect = async () => {
      console.log = () => {};
      try {
        const response = await connections.fetch(
          new Request(`${workFixtureOrigin}/workspace/${W}/connections/${C}/disconnect`, {
            method: "POST",
            headers: {
              Cookie: "__Host-morrow_session=" + P.A.secret,
              "Sec-Fetch-Site": "same-origin",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Dest": "empty",
              Origin: workFixtureOrigin,
              "Content-Type": "application/json",
              "X-Morrow-Request": "1",
              "Idempotency-Key": randomUUID(),
            },
            body: JSON.stringify({
              control: { reason: "The store is moving to a new owner", sourceProposalRef: null },
            }),
          }),
          {},
          ctx,
        );
        return { status: response.status, body: await response.json() };
      } finally {
        console.log = print;
      }
    };
    // Two approved proposals, drafted and decided while the store is still connected.
    const pD1 = [newProduct(), newProduct()];
    const XD1 = await draft(pD1, ["title"]);
    const refsD1 = await approveAll(XD1);
    const pD2 = [newProduct()];
    const XD2 = await draft(pD2, ["title"]);
    const refsD2 = await approveAll(XD2);
    // S4: the person disconnects the store between the claim and the first write.
    let disconnected = null;
    hooks.beforeApply = async () => {
      hooks.beforeApply = null;
      disconnected = await disconnect();
    };
    const mid = await apply(P.A, XD1, refsD1);
    const rowsD1 = ops(XD1);
    check(
      "S4:a_persons_disconnect_between_the_claim_and_the_write_sends_nothing",
      disconnected?.status === 200 &&
        disconnected.body?.status === "disconnected" &&
        disconnected.body.connectionId === C &&
        disconnected.body.installationId === INSTALLATION &&
        disconnected.body.endReason === "disconnected" &&
        mid.status === 200 &&
        rowsD1.length === 2 &&
        rowsD1[0].status === "failed" &&
        rowsD1[0].reason === "stopped" &&
        rowsD1[0].attempt === 0 &&
        rowsD1[1].status !== "verified" &&
        rowsD1[1].status !== "uncertain" &&
        pD1.every((n) => shop.updates(String(n)) === 0),
      { disconnected, mid: mid.body, rowsD1 },
    );
    // S5: another approved proposal on the disconnected store is refused at its claim and
    // records nothing.
    const before = footprint();
    const callsBefore = shop.calls.length;
    const refused = await apply(P.A, XD2, refsD2);
    check(
      "S5:after_a_disconnect_an_approved_proposal_is_refused_at_its_claim",
      refused.status === 409 &&
        refused.body.code === "conflict" &&
        footprint() === before &&
        shop.calls.length === callsBefore &&
        shop.updates(String(pD2[0])) === 0,
      { refused: refused.body },
    );
    // S6: the installation ended as a person's disconnect, the person's connection stop
    // stands, and the broker erased the token, so no later send can find one.
    const installationRow = one(
      `SELECT status,suspended_reason FROM morrow_identity.store_installations WHERE id=${literal(INSTALLATION)}`,
    );
    const credentialRow = one(
      `SELECT status,wrapped_key IS NULL AND sealed_value IS NULL AS erased,destroy_reason FROM morrow_vault.credentials WHERE subject_id=${literal(INSTALLATION)} ORDER BY version DESC LIMIT 1`,
    );
    const stopRow = one(
      `SELECT set_by_kind,reason_code,lifted_at IS NULL AS active FROM morrow_work.stop_controls WHERE scope='connection' AND target_id=${literal(C)} AND set_by_kind='human'`,
    );
    check(
      "S6:the_disconnect_ends_the_installation_and_erases_the_token",
      installationRow?.status === "suspended" &&
        installationRow.suspended_reason === "disconnected" &&
        credentialRow?.status === "destroyed" &&
        credentialRow.erased === true &&
        credentialRow.destroy_reason === "disconnected" &&
        stopRow?.reason_code === "human_disconnect" &&
        stopRow.active === true &&
        destroyCalls.length === 1 &&
        destroyCalls[0] === INSTALLATION,
      { installationRow, credentialRow, stopRow, destroyCalls },
    );
  }
  return { checks, failures, retries };
}

// A diagnostic of the review read's steps (MORROW_LAB_PROBE=1): each decision the route takes.
async function probeReview(db, p, proposalId) {
  const { withWorkTransaction } = await import("../packages/work/src/connection.ts");
  const { enterWorkContext } = await import("../packages/work/src/context.ts");
  const { readProposalRow } = await import("../packages/work/src/approvals/family.ts");
  const { viewerRole, readProposal } = await import("../packages/work/src/approvals/reads.ts");
  const { proposalStore, permits, eligibleReviewer } = await import(
    "../packages/work/src/approvals/kernel.ts"
  );
  const { decideOn } = await import("../packages/work/src/agents/commands.ts");
  const connection = await db.connector().open({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 60000,
    waitUntil() {},
  });
  try {
    await withWorkTransaction(
      connection,
      { readOnly: false, deadlineMs: Date.now() + 60000, signal: new AbortController().signal },
      async (tx) => {
        const a = await enterWorkContext(tx, p.digest, p.workspace);
        const out = { a: typeof a === "string" ? a : "ok" };
        const stored = await readProposalRow(tx, a, proposalId).catch((e) => String(e));
        out.stored = stored === null ? null : typeof stored === "string" ? stored : "ok";
        if (stored && typeof stored !== "string") {
          const pr = stored.proposal;
          out.storeId = pr.storeId;
          out.targets = pr.targets.map((t) => t.resource);
          out.store = proposalStore(pr);
          out.reviewerRead = await permits(a, "approval.reviewer_read", pr);
          out.eligible = await eligibleReviewer(a, pr, null);
          out.ownRead = await permits(a, "approval.own_read", pr);
          out.requester = stored.requester;
          out.actor = { principal: a.actor.principalId, membership: a.actor.membershipId };
          out.grants = a.grants.map((g) => [
            g.capabilityId,
            g.verbs,
            g.scope.resources.map((r) => r.kind + ":" + r.id),
          ]);
          out.role = await viewerRole(a, stored);
          const view = await readProposal(tx, a, proposalId, null).catch((e) => String(e));
          out.view = typeof view === "string" ? view : "ok";
          if (out.store && typeof out.store === "object")
            out.read = (
              await decideOn(a, out.store, "catalog.products.read", "view", listingFieldPaths)
            ).decision;
        }
        if (stored && typeof stored !== "string") {
          const { decideApproval } = await import("../packages/work/src/approvals/decide.ts");
          const body = {
            decision: {
              decision: "approve",
              selectedTargetIndexes: null,
              expectedDecisionDigest: stored.proposal.proposalDigest,
              soloOwnerConfirmation: null,
              comment: null,
            },
            expectedRevision: 1,
          };
          const sqlLog = [];
          const traced = Object.fromEntries(
            Object.keys(tx).map((k) => [k, typeof tx[k] === "function" ? tx[k].bind(tx) : tx[k]]),
          );
          traced.run = async (name, values) => {
            try {
              const rows = await tx.run(name, values);
              sqlLog.push([name, rows.length, JSON.stringify(rows).slice(0, 300)]);
              return rows;
            } catch (error) {
              sqlLog.push([name, "error", String(error?.code ?? error)]);
              throw error;
            }
          };
          try {
            out.decide = await decideApproval(traced, a, {
              commandId: randomUUID(),
              requestDigest: "c".repeat(64),
              proposalId,
              body,
            });
          } catch (error) {
            out.decideError =
              String(error) + " " + (error?.stack ?? "").split("\n").slice(0, 6).join(" | ");
          }
          out.sql = sqlLog;
          tx.rollbackOnly();
        }
        console.error("PROBE " + JSON.stringify(out));
      },
    );
  } finally {
    await connection.close();
  }
}

// The canonical JSON of the gateway's item text (canonicalJson: sorted keys, no spaces).
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

async function main() {
  const started = Date.now();
  let result;
  phase("engine_and_migrations");
  try {
    await withWorkDatabase(
      "v1.PR3.catalog-apply",
      async (db) => {
        result = await runCatalogApplyLab(db);
      },
      { administrator: "createrole" },
    );
  } catch (error) {
    console.error("APPLY_LAB_FAILED_IN:" + stage);
    throw error;
  }
  phase("report");
  writeArtifact("labs/catalog-apply.json", {
    task: "v1 PR 3",
    qualification: "local_postgresql17_network_none_catalog_apply",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    unavailableRetries: result.retries,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "The review handler and the broker's writer run in Node over psql connectors (morrow_api_worker, morrow_runtime_executor, morrow_vault_broker), not in workerd over the Neon transport; the ApiBroker RPC is a direct call.",
      "Shopify is an in-process stand-in shaped from Shopify's documentation (productUpdate, the product read-back, THROTTLED and userErrors); its reformatting of tags and HTML is a stand-in for the live shapes, which the owner's first applies check.",
      "M5's billing records, the store's sealed token and S3's system connection stop are owner-seeded with the triggers off (sim); S4-S6 disconnect through v1 PR 2's real handler and the broker's vault definer, with the founder's disconnect grant owner-seeded as store-link template v2 would issue it.",
    ],
  });
  if (result.failures.length) {
    print("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else print(`PASS: ${result.checks.length} v1 PR 3 catalog apply checks.`);
}

await main();
