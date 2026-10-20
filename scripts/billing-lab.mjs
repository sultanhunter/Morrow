// M5 PR-1 PostgreSQL 17 laboratory (lab:billing, pg-http): the billing records (migrations
// 0026-0027 of this branch) on an isolated network-none engine with the whole manifest.
//   A  owner template v2: the founder backfill (founders seeded before 0026), idempotence,
//      the widened grant_template CHECK.
//   B  checkout through the real billing HTTP handler and the purchase guard: replay,
//      command conflict, reuse, one open intent under concurrency, the lazy close, denials
//      with zero broker calls.
//   C  the broker's own definers as morrow_vault_broker: the send fence, an uncertain send
//      never promoted without a provider result, readback settlement, failures.
//   D  receipts recorded by the broker login and applied through the real webhook handler
//      (receipt-only ingress): invoice.paid fixes the route and funds the wallet in one
//      commit, de-duplication, double invoice.paid, either event order, a later period,
//      the cancellation fold, held, unattributed, no-charge and route-mismatch outcomes,
//      and forged plans refused.
//   E  isolation probes: the ingress refuses a session context, a forged receipt context
//      reads nothing, cross-tenant reads are empty, other logins cannot run the definers.
//   F  the P01.T04a decision tables, row by row, against the persisted path (the Stripe
//      subscription-period rows M5 persists; reversals and App Pricing are M6/P18.T01b),
//      and the purchase-decision rows of the two purchase routes.
//   G  the real broker code (apps/broker/src/stripe.ts) against the fake Stripe origin
//      (scripts/fixtures/stripe-fake.mjs), with M2 PR-2's vault transport signature over
//      this engine's broker login: checkout end to end, signed webhooks (bad signature,
//      a held readback, redelivery, a lost commit read back), the portal, an unknown
//      Stripe outcome read back and never resent, and zero unexpected outbound requests.
// Sections B-F drive the broker definers through a fake broker port with synthetic
// provider results; G runs the real broker. Owner-seeded synthetic fixtures only.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  fixtureGrant,
  grantInsert,
  literal,
  migrationPlan,
  psql,
  seedWorkFixtures,
  withWorkDatabase,
  workFixtureOrigin,
} from "../tests/tenant-conformance/harness.mjs";
import { loadMigrationChain } from "./migration-chain.mjs";
import { stripeEvent, stripeFixture } from "../tests/fixtures/stripe-fixtures.mjs";
import {
  createBillingApiHandler,
  createStripeWebhookHandler,
  normalizeCheckoutSession,
  normalizeInvoice,
  normalizeSubscription,
  stripeObjectDigest,
} from "../packages/work/src/billing/index.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { BILLING_DENIAL_ENVELOPES } from "../packages/policy/src/billing-state.ts";
import {
  stripeCheckoutCreate,
  stripeCustomerEnsure,
  stripePortalCreate,
  stripeWebhookVerify,
} from "../apps/broker/src/stripe.ts";
import { vaultStatements } from "../apps/broker/src/vault.ts";
import {
  decodeStripeCheckoutResult,
  decodeStripeCustomerResult,
  decodeStripePortalResult,
  decodeStripeWebhookResult,
  encodeStripeCheckoutResult,
  encodeStripeCustomerResult,
  encodeStripePortalResult,
  encodeStripeWebhookResult,
} from "../packages/identity/src/broker-protocol.ts";
import {
  createStripeFake,
  fakeStripeKey,
  fakeStripeWebhookSecret,
} from "./fixtures/stripe-fake.mjs";
import { writeArtifact } from "./artifacts.mjs";

const checks = [];
const failures = [];
function check(name, passed) {
  checks.push({ name, passed: passed === true });
  if (passed !== true) failures.push(name);
  console.log(JSON.stringify({ check: name, passed: passed === true }));
}
const started = Date.now();
const terms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8")).environments
  .development[0];
const PRICE = terms.terms.entries[0].priceKey;
const lit = literal;
const nowS = Math.floor(Date.now() / 1000);
// A period around now, so a granted entitlement is billable at the lab's clock.
const periodNow = { start: nowS - 3600, end: nowS + 30 * 86400 };
const withPeriod = (start, end) => (object) => {
  if (object.object === "invoice") object.lines.data[0].period = { start, end };
  if (object.object === "subscription")
    for (const item of object.items.data) {
      item.current_period_start = start;
      item.current_period_end = end;
    }
};
const chain = loadMigrationChain();
const firstBilling = chain.find((m) => m.file.endsWith(".billing-identity-bridge.sql"));
if (!firstBilling || !chain.some((m) => m.file.endsWith(".billing-records.sql")))
  throw Error("BILLING_LAB_CHAIN_REQUIRED");

await withWorkDatabase(
  "M5.billing",
  async (db) => {
    const sql = (text) => psql(db.id, text);
    const scalar = (text) => sql(text).split("\n").at(-1);
    // -----------------------------------------------------------------------------
    // A. Template v2 backfill: founders recorded by organization_signups before 0026.
    const profile = "profile_billing_lab";
    const founders = [
      { key: "f1", active: true },
      { key: "f2", active: false },
    ];
    const founderSql = founders
      .map(
        (
          f,
        ) => `INSERT INTO morrow_identity.principals VALUES(${lit("person_" + f.key)},'human',true);
INSERT INTO morrow_identity.organizations VALUES(${lit("org_" + f.key)},'Founder org',true,3);
INSERT INTO morrow_identity.workspaces VALUES(${lit("ws_" + f.key)},${lit("org_" + f.key)},'Main',true);
INSERT INTO morrow_identity.memberships VALUES(${lit("member_" + f.key)},${lit("org_" + f.key)},${lit("person_" + f.key)},true);
INSERT INTO morrow_identity.workspace_memberships VALUES(${lit("org_" + f.key)},${lit("ws_" + f.key)},${lit("member_" + f.key)},${f.active});
INSERT INTO morrow_identity.organization_signups(principal_id,command_id,request_digest,profile_id,organization_id,workspace_id,membership_id,grant_template,recorded_at)
 VALUES(${lit("person_" + f.key)},gen_random_uuid()::text,repeat('a',64),${lit(profile)},${lit("org_" + f.key)},${lit("ws_" + f.key)},${lit("member_" + f.key)},'owner-bootstrap-v1',clock_timestamp());`,
      )
      .join("\n");
    db.admin(
      `INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest)
 VALUES(${lit(profile)},'workos','environment_'||repeat('A',26),'app_'||repeat('A',26),'client_'||repeat('A',26),'https://api.workos.com/user_management/client_'||repeat('A',26),1,repeat('b',64));
${founderSql}`,
    );
    // The rest of the chain: the backfill runs in 0026.
    for (const step of migrationPlan(chain.filter((m) => m.sequence >= firstBilling.sequence))) {
      if (step.kind === "prerequisite") sql(step.text);
      else sql("SET ROLE " + step.executeAs + ";\n" + step.text);
    }
    const v2Grants = (key) =>
      db.rows(
        `SELECT g.payload FROM morrow_identity.grants g WHERE g.membership_id=${lit("member_" + key)} AND g.payload->>'capabilityId' IN ('governance.billing.manage','governance.model_default.revise') ORDER BY g.payload->>'capabilityId'`,
      );
    const f1 = v2Grants("f1").map((r) => r.payload);
    check(
      "A_backfill_gives_an_active_founder_the_two_v2_grants",
      f1.length === 2 &&
        f1[0].capabilityId === "governance.billing.manage" &&
        JSON.stringify(f1[0].verbs) === '["view","execute"]' &&
        JSON.stringify(f1[0].scope.fields) === '["action","priceKey"]' &&
        f1[1].capabilityId === "governance.model_default.revise" &&
        JSON.stringify(f1[1].verbs) === '["execute"]' &&
        JSON.stringify(f1[1].scope.fields) ===
          '["effort","expectedRevision","maxCreditsPerProduct","model"]' &&
        f1.every(
          (g) =>
            g.issuedBy.kind === "service" &&
            g.issuedBy.principalId === "morrow.onboarding" &&
            g.policyRevision === 3 &&
            g.scope.resources[0].kind === "workspace" &&
            validateCurrentDefinition("Grant", g),
        ),
    );
    check("A_backfill_skips_an_inactive_founder", v2Grants("f2").length === 0);
    const backfill = readFileSync("migrations/" + firstBilling.file, "utf8");
    const block = backfill.slice(
      backfill.indexOf("DO $$ DECLARE s record; g record;"),
      backfill.lastIndexOf("COMMIT;"),
    );
    db.admin(block);
    check("A_backfill_is_idempotent", v2Grants("f1").length === 2 && v2Grants("f2").length === 0);
    const checkAttempt = (template) =>
      db.tryRun(
        `SET ROLE morrow_identity_owner; BEGIN; INSERT INTO morrow_identity.principals VALUES('person_t','human',true);
INSERT INTO morrow_identity.organizations VALUES('org_t','T',true,1); INSERT INTO morrow_identity.workspaces VALUES('ws_t','org_t','T',true);
INSERT INTO morrow_identity.memberships VALUES('member_t','org_t','person_t',true);
INSERT INTO morrow_identity.organization_signups(principal_id,command_id,request_digest,profile_id,organization_id,workspace_id,membership_id,grant_template,recorded_at)
 VALUES('person_t',gen_random_uuid()::text,repeat('a',64),${lit(profile)},'org_t','ws_t','member_t',${lit(template)},clock_timestamp()); ROLLBACK;`,
      ).ok;
    check("A_signup_template_check_admits_v2", checkAttempt("owner-bootstrap-v2"));
    check("A_signup_template_check_refuses_v3", !checkAttempt("owner-bootstrap-v3"));

    // A real first-owner signup on the full chain: the replaced create_first_organization,
    // called as the onboarding executor with a seeded browser session family, issues and
    // records owner-bootstrap-v2 (the eight v1 rows plus the two Governance controls) and
    // the 0021 trigger still writes the website route row in the same transaction.
    {
      const env = "environment_" + "C".repeat(26),
        client = "client_" + "C".repeat(26);
      const sp = "profile_signup_v2",
        person = "person_signup_v2",
        mapping = "mapping_signup_v2";
      const secret = createHash("sha256").update(randomUUID()).digest().toString("base64url");
      const sessionDigest = createHash("sha256").update(secret).digest("hex");
      db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state)
 VALUES(${lit(sp)},'workos',${lit(env)},'app_'||repeat('C',26),${lit(client)},'https://api.workos.com/user_management/'||${lit(client)},1,repeat('c',64),1,'active');
INSERT INTO morrow_identity.principals VALUES(${lit(person)},'human',true);
INSERT INTO morrow_identity.provider_subject_mappings(id,provider_id,environment_id,subject_id,principal_id,record_revision,state) VALUES(${lit(mapping)},'workos',${lit(env)},'user_'||repeat('C',26),${lit(person)},1,'active');
INSERT INTO morrow_identity.provider_subject_profile_bindings(mapping_id,profile_id,provider_id,environment_id,record_revision,state) VALUES(${lit(mapping)},${lit(sp)},'workos',${lit(env)},1,'active');
INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at) VALUES('binding_signup_v2','workos',${lit(env)},${lit(client)},'session_'||repeat('C',26),${lit(mapping)},${lit(sp)},clock_timestamp()-interval '1 minute');
INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at) SELECT 'family_signup_v2','binding_signup_v2',1,1,1,t,t+interval '15 minutes' FROM (SELECT date_trunc('milliseconds',clock_timestamp())-interval '1 minute' t) x;
INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at) SELECT 'generation_signup_v2',id,${lit(sessionDigest)},created_at,expires_at FROM morrow_identity.browser_session_families WHERE id='family_signup_v2';
INSERT INTO morrow_identity.account_enrollments(principal_id,mapping_id,profile_id,command_id,recorded_at) VALUES(${lit(person)},${lit(mapping)},${lit(sp)},gen_random_uuid()::text,clock_timestamp());
INSERT INTO morrow_identity.self_service_revisions(profile_id,revision,enrollment,organization_signup,reason,approval_ref,recorded_by,recorded_at) VALUES(${lit(sp)},1,'enabled','enabled','lab signup','lab_signup_ref',session_user,clock_timestamp());`);
      // The lab's executor login (hosted executors have LOGIN through provisioning).
      db.sql("ALTER ROLE morrow_identity_onboarding LOGIN;");
      const created = db
        .sql(
          `SELECT outcome||'|'||coalesce(organization_id,'')||'|'||coalesce(workspace_id,'') FROM morrow_identity.create_first_organization(${lit(sessionDigest)},${lit(randomUUID())},${lit(sp)},'Signup Org','Main');`,
          { user: "morrow_identity_onboarding" },
        )
        .split("\n")
        .at(-1)
        .split("|");
      const issued = db
        .rows(
          `SELECT payload::text AS payload FROM morrow_identity.grants WHERE principal_id=${lit(person)} ORDER BY payload->>'capabilityId'`,
        )
        .map((r) => JSON.parse(r.payload));
      const signupRow = db.rows(
        `SELECT s.grant_template,r.origin,r.route FROM morrow_identity.organization_signups s JOIN morrow_billing.workspace_billing_routes r ON r.organization_id=s.organization_id AND r.workspace_id=s.workspace_id WHERE s.principal_id=${lit(person)}`,
      );
      check(
        "A_a_real_signup_issues_and_records_owner_bootstrap_v2_with_its_route_row",
        created[0] === "created" &&
          signupRow.length === 1 &&
          signupRow[0].grant_template === "owner-bootstrap-v2" &&
          signupRow[0].origin === "website" &&
          signupRow[0].route === null &&
          issued.length === 10 &&
          issued.some((g) => g.capabilityId === "governance.billing.manage") &&
          issued.some((g) => g.capabilityId === "governance.model_default.revise") &&
          issued.every(
            (g) =>
              g.scope.workspaceId === created[2] &&
              g.issuedBy.principalId === "morrow.onboarding" &&
              g.policyRevision === 1 &&
              validateCurrentDefinition("Grant", g),
          ),
      );
      db.sql("ALTER ROLE morrow_identity_onboarding NOLOGIN;");
    }

    // -----------------------------------------------------------------------------
    // B. Tenants, grants, routes and terms.
    const P = seedWorkFixtures(db);
    const billingGrant = (p) =>
      fixtureGrant(p, "governance.billing.manage", ["view", "execute"], ["action", "priceKey"]);
    db.admin(
      [P.A, P.R, P.S, P.Y, P.A2].map((p) => grantInsert(p, billingGrant(p))).join("\n") +
        "\n" +
        grantInsert(P.V, fixtureGrant(P.V, "governance.usage.read", ["view"], ["period", "scope"])),
    );
    const routeRow = (p) =>
      `INSERT INTO morrow_billing.workspace_billing_routes VALUES(${lit(p.org)},${lit(p.workspace)},'website',NULL,NULL,NULL,NULL,NULL,1,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()));`;
    // Fresh single-owner tenants for the receipt cases (the work fixtures share ws_w).
    const tenant = (key) => {
      const secret = createHash("sha256").update(randomUUID()).digest().toString("base64url");
      const p = {
        key,
        principal: "person_" + key,
        membership: "membership_" + key,
        org: "org_" + key,
        workspace: "ws_" + key,
        secret,
        digest: createHash("sha256").update(secret).digest("hex"),
      };
      db.admin(`INSERT INTO morrow_identity.organizations VALUES(${lit(p.org)},'Synthetic',true,1);
INSERT INTO morrow_identity.workspaces VALUES(${lit(p.workspace)},${lit(p.org)},'Synthetic',true);
INSERT INTO morrow_identity.principals VALUES(${lit(p.principal)},'human',true);
INSERT INTO morrow_identity.memberships VALUES(${lit(p.membership)},${lit(p.org)},${lit(p.principal)},true);
INSERT INTO morrow_identity.sessions VALUES(${lit("session_" + key)},${lit(p.principal)},${lit(p.org)},${lit(p.digest)},'workos',${lit("provider_session_" + key)},clock_timestamp()+interval '1 day',NULL);
INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(p.org)},${lit(p.workspace)},${lit(p.membership)},true);
${grantInsert(p, billingGrant(p))}`);
      db.workOwner(routeRow(p));
      return p;
    };
    db.workOwner(
      [P.A, P.Y, P.A2].map(routeRow).join("\n") +
        `\nINSERT INTO morrow_billing.billing_terms VALUES(1,${lit(JSON.stringify(terms.terms))}::jsonb,${lit(JSON.stringify(terms.offers))}::jsonb,${lit(terms.digest)},date_trunc('milliseconds',clock_timestamp()));`,
    );
    check(
      "B_terms_are_immutable",
      !db.tryRun(
        `SET ROLE morrow_work_owner; UPDATE morrow_billing.billing_terms SET digest=repeat('0',64);`,
      ).ok &&
        !db.tryRun(
          `SET ROLE morrow_work_owner; INSERT INTO morrow_billing.billing_terms VALUES(3,'{"schemaVersion":1,"termsRevision":3,"entries":[],"planChanges":[]}','[]','${"c".repeat(64)}',date_trunc('milliseconds',clock_timestamp()));`,
        ).ok,
    );

    // The fake broker port: the broker definers as morrow_vault_broker, with synthetic
    // provider results (lab:billing-workers runs the real broker and Stripe client).
    const vaultConnector = db.connector({ user: "morrow_vault_broker" });
    const brokerCalls = { customer: 0, checkout: 0, portal: 0, verify: 0 };
    async function vault(statements) {
      const c = await vaultConnector.open({
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 30000,
        waitUntil() {},
      });
      try {
        await c.query("BEGIN", [], new AbortController().signal);
        const out = [];
        for (const [text, values] of statements)
          out.push((await c.query(text, values, new AbortController().signal)).rows);
        await c.query("COMMIT", [], new AbortController().signal);
        return out;
      } finally {
        await c.close();
      }
    }
    const opBegin = async (id) =>
      (await vault([["SELECT * FROM morrow_billing.stripe_op_begin($1)", [id]]]))[0][0];
    const opSettle = async (id, result, object = "", request = "") =>
      (
        await vault([
          [
            "SELECT morrow_billing.stripe_op_settle($1,$2,NULLIF($3,''),NULLIF($4,'')) AS outcome",
            [id, result, object, request],
          ],
        ])
      )[0][0].outcome;
    const sessions = new Map();
    const broker = {
      faults: {},
      async customerEnsure(operationId) {
        brokerCalls.customer++;
        const begun = await opBegin(operationId);
        if (begun.outcome === "verified") return { outcome: "verified" };
        if (begun.outcome !== "send" && begun.outcome !== "reconcile") return { outcome: "failed" };
        // A send, or a readback that finds the customer the first send created.
        const object = "cus_" + operationId.replaceAll("-", "").slice(0, 20);
        const settled = await opSettle(operationId, "verified", object, "req_LabCustomer01");
        return {
          outcome: ["verified", "already_verified"].includes(settled) ? "verified" : "uncertain",
        };
      },
      async checkoutCreate(operationId) {
        brokerCalls.checkout++;
        const begun = await opBegin(operationId);
        if (begun.outcome === "verified")
          return {
            outcome: "verified",
            checkoutUrl: "https://checkout.stripe.com/c/pay/" + begun.provider_object_id,
            expiresAtMs: sessions.get(begun.provider_object_id) ?? Date.now() + 3600000,
          };
        if (begun.outcome !== "send" && begun.outcome !== "reconcile")
          return { outcome: "pending", checkoutUrl: null, expiresAtMs: null };
        const params = JSON.parse(begun.params);
        const id = "cs_test_" + operationId.replaceAll("-", "");
        sessions.set(id, Number(params.expiresAt) * 1000);
        if (broker.faults.checkout === "uncertain") {
          await opSettle(operationId, "uncertain");
          return { outcome: "uncertain", checkoutUrl: null, expiresAtMs: null };
        }
        const settled = await opSettle(operationId, "verified", id, "req_LabCheckout01");
        return {
          outcome: ["verified", "already_verified"].includes(settled) ? "verified" : "uncertain",
          checkoutUrl: "https://checkout.stripe.com/c/pay/" + id,
          expiresAtMs: Number(params.expiresAt) * 1000,
        };
      },
      async portalCreate(operationId) {
        brokerCalls.portal++;
        const begun = await opBegin(operationId);
        if (begun.outcome !== "send" && begun.outcome !== "verified")
          return { outcome: "failed", portalUrl: null };
        const id = "bps_" + operationId.replaceAll("-", "");
        if (begun.outcome === "send")
          await opSettle(operationId, "verified", id, "req_LabPortal001");
        return { outcome: "verified", portalUrl: "https://billing.stripe.com/p/session/" + id };
      },
      // The lab body is {eventId, type, object, subscription}: the readback the real broker
      // performs, given directly. The signature is checked by the real broker only.
      async webhookVerify(rawBase64) {
        brokerCalls.verify++;
        const body = JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8"));
        const kind = body.object.object;
        const normalized =
          kind === "invoice"
            ? normalizeInvoice(body.object, body.subscription ?? null)
            : kind === "subscription"
              ? normalizeSubscription(body.object)
              : normalizeCheckoutSession(body.object);
        const digest = await stripeObjectDigest(normalized);
        const [row] = (
          await vault([
            [
              "SELECT * FROM morrow_billing.stripe_receipt_record($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                body.eventId,
                body.type,
                String(normalized.livemode),
                normalized.kind,
                normalized.id,
                normalized.customer,
                JSON.stringify(normalized),
                digest,
                String(body.observedAtMs ?? Date.now()),
              ],
            ],
          ])
        )[0];
        if (row.outcome !== "recorded" && row.outcome !== "duplicate")
          return { verdict: "rejected", receiptId: null, objectDigest: null, attributed: null };
        return {
          verdict: row.outcome,
          receiptId: row.receipt_id,
          objectDigest: row.object_digest,
          attributed: row.attributed === "true",
        };
      },
    };
    const api = createBillingApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(),
      environment: "development",
      broker,
      now: () => Date.now(),
    });
    const webhook = createStripeWebhookHandler({
      connector: db.connector(),
      environment: "development",
      broker,
      now: () => Date.now(),
    });
    const ctx = { waitUntil() {} };
    async function call(p, method, path, body, options = {}) {
      const headers = {
        Cookie: "__Host-morrow_session=" + p.secret,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      };
      if (method === "POST")
        Object.assign(headers, {
          Origin: workFixtureOrigin,
          "Content-Type": "application/json",
          "X-Morrow-Request": "1",
          "Idempotency-Key": options.key ?? randomUUID(),
        });
      const response = await api.fetch(
        new Request(
          workFixtureOrigin +
            "/workspace/" +
            (options.workspace ?? p.workspace) +
            "/billing" +
            path,
          {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        ),
        {},
        ctx,
      );
      return { status: response.status, body: await response.json() };
    }
    let eventSeq = 0;
    // Observation times a minute in the past and increasing, so the database clock (which
    // evaluates entitlement) is never behind an observation.
    const observed = () => Date.now() - 60000 + eventSeq * 10;
    async function deliver(type, object, subscription = null, observedAtMs = observed()) {
      const eventId = "evt_lab" + String(++eventSeq).padStart(10, "0") + randomUUID().slice(0, 8);
      return deliverEvent(eventId, type, object, subscription, observedAtMs);
    }
    async function deliverEvent(eventId, type, object, subscription, observedAtMs = observed()) {
      const response = await webhook.fetch(
        new Request("https://work.morrow.test/api/billing/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": "t=1,v1=lab", "content-type": "application/json" },
          body: JSON.stringify({ eventId, type, object, subscription, observedAtMs }),
        }),
        {},
        ctx,
      );
      return { status: response.status, eventId };
    }
    const one = (query) => db.rows(query)[0] ?? null;
    const count = (query) => Number(scalar(`SELECT count(*) FROM (${query}) x;`));
    const intents = (p) =>
      db.rows(
        `SELECT id::text AS id,status,stripe_session_id,customer_operation_id::text AS customer_op,checkout_operation_id::text AS checkout_op FROM morrow_billing.checkout_intents WHERE workspace_id=${lit(p.workspace)} ORDER BY created_at,id`,
      );

    // B1. GET /billing and /plans in phase open.
    const view = await call(P.A, "GET", "");
    check(
      "B_billing_view_open_phase_with_the_morrow_call_to_action",
      view.status === 200 &&
        view.body.phase === "open" &&
        view.body.state === "no_route" &&
        view.body.callToAction.kind === "morrow_plans" &&
        view.body.callToAction.href === `/workspace/${P.A.workspace}/billing/morrow/plans` &&
        view.body.credits === null,
    );
    const plans = await call(P.A, "GET", "/morrow/plans");
    check(
      "B_plans_list_the_beta_offer",
      plans.status === 200 &&
        plans.body.offers.length === 1 &&
        plans.body.offers[0].priceKey === PRICE &&
        plans.body.offers[0].amount === "49.00" &&
        plans.body.offers[0].creditUnits === "300" &&
        plans.body.actions.subscribe === true &&
        plans.body.actions.billingPortal === false,
    );
    const usageOnly = await call(P.V, "GET", "");
    check(
      "B_usage_read_views_billing_without_a_purchase_link",
      usageOnly.status === 200 && usageOnly.body.callToAction.kind === "none",
    );
    const noGrant = await call(P.B, "GET", "");
    check("B_a_member_without_either_grant_is_denied", noGrant.status === 403);

    // B2. Denials before any SQL write or broker call.
    let before = { ...brokerCalls };
    const beforeOps = count("SELECT 1 FROM morrow_work.operations");
    const deniedMember = await call(P.B, "POST", "/morrow/checkout", { priceKey: PRICE });
    const badBody = await call(P.A, "POST", "/morrow/checkout", {
      priceKey: PRICE,
      route: "morrow_direct",
    });
    const unknownPrice = await call(P.A, "POST", "/morrow/checkout", {
      priceKey: "stripe:price:price_UnknownPrice01",
    });
    const portalOpen = await call(P.A, "POST", "/morrow/portal", {});
    const unmapped = await call(P.A, "POST", "/morrow/top-up", {});
    check(
      "B_denials_decided_before_any_write_or_broker_call",
      deniedMember.status === 403 &&
        badBody.status === 400 &&
        unknownPrice.status === 409 &&
        unknownPrice.body.code === "conflict" &&
        portalOpen.status === 409 &&
        portalOpen.body.safeMessage === "Choose a plan first." &&
        unmapped.status === 404 &&
        JSON.stringify(brokerCalls) === JSON.stringify(before) &&
        count("SELECT 1 FROM morrow_work.operations") === beforeOps,
    );

    // B3. Checkout, replay, conflict and reuse.
    const key = randomUUID();
    const first = await call(P.A, "POST", "/morrow/checkout", { priceKey: PRICE }, { key });
    const opA = first.body.operationId;
    const iA = intents(P.A);
    check(
      "B_checkout_opens_one_intent_with_customer_and_session",
      first.status === 201 &&
        first.body.checkoutUrl.startsWith("https://checkout.stripe.com/") &&
        iA.length === 1 &&
        iA[0].status === "open" &&
        iA[0].stripe_session_id === "cs_test_" + opA.replaceAll("-", "") &&
        count(
          `SELECT 1 FROM morrow_billing.stripe_customers WHERE workspace_id=${lit(P.A.workspace)}`,
        ) === 1 &&
        count(
          `SELECT 1 FROM morrow_work.operations WHERE workspace_id=${lit(P.A.workspace)} AND kind='stripe_write' AND status='verified' AND task_id IS NULL AND capability_id='governance.billing.manage'`,
        ) === 2,
    );
    const transitions = db.rows(
      `SELECT string_agg(from_status||'>'||to_status,',' ORDER BY revision) AS path FROM morrow_work.operation_transitions WHERE operation_id=${lit(opA)}`,
    )[0].path;
    check(
      "B_checkout_operation_path_follows_the_operation_machine",
      transitions ===
        "planned>authorized,authorized>dispatching,dispatching>submitted,submitted>verifying,verifying>verified",
    );
    const replay = await call(P.A, "POST", "/morrow/checkout", { priceKey: PRICE }, { key });
    check(
      "B_replay_returns_the_same_operation_and_writes_nothing",
      replay.status === 200 && replay.body.operationId === opA && intents(P.A).length === 1,
    );
    db.workOwner(
      `INSERT INTO morrow_billing.billing_terms VALUES(2,${lit(JSON.stringify({ ...terms.terms, termsRevision: 2, entries: [...terms.terms.entries, { ...terms.terms.entries[0], priceKey: "stripe:price:price_MorrowDevOther01" }] }))}::jsonb,${lit(JSON.stringify([...terms.offers, { ...terms.offers[0], priceKey: "stripe:price:price_MorrowDevOther01" }]))}::jsonb,${lit("d".repeat(64))},date_trunc('milliseconds',clock_timestamp()));`,
    );
    const conflict = await call(
      P.A,
      "POST",
      "/morrow/checkout",
      { priceKey: "stripe:price:price_MorrowDevOther01" },
      { key },
    );
    check(
      "B_same_key_other_body_is_a_command_conflict",
      conflict.status === 409 && conflict.body.retryClass === "never",
    );
    const other = await call(P.A, "POST", "/morrow/checkout", {
      priceKey: "stripe:price:price_MorrowDevOther01",
    });
    const reused = await call(P.A, "POST", "/morrow/checkout", { priceKey: PRICE });
    check(
      "B_one_open_intent_per_workspace_reused_for_its_price",
      other.status === 409 &&
        other.body.safeMessage === "A checkout is already in progress for this workspace." &&
        reused.status === 200 &&
        reused.body.operationId !== undefined &&
        intents(P.A).filter((i) => i.status === "open").length === 1,
    );

    // B4. Concurrent checkouts on a fresh workspace: exactly one open intent.
    const racers = await Promise.all(
      [0, 1, 2].map(() => call(P.A2, "POST", "/morrow/checkout", { priceKey: PRICE })),
    );
    check(
      "B_concurrent_checkouts_leave_one_open_intent_and_one_customer",
      racers.every((r) => r.status === 201 || r.status === 200) &&
        new Set(racers.map((r) => r.body.operationId)).size === 1 &&
        intents(P.A2).filter((i) => i.status === "open").length === 1 &&
        count(
          `SELECT 1 FROM morrow_billing.stripe_customers WHERE workspace_id=${lit(P.A2.workspace)}`,
        ) === 1,
    );

    // B5. The lazy close: an intent past its Stripe expiry plus five minutes is expired.
    db.workOwner(
      `UPDATE morrow_billing.checkout_intents SET status='failed',revision=revision+1,updated_at=updated_at WHERE workspace_id=${lit(P.A2.workspace)} AND status='open';`,
    );
    const staleIntent = randomUUID();
    const staleOp = randomUUID();
    db.workOwner(
      `INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,status,request_digest,attempt,created_at,updated_at) VALUES(${lit(P.A2.org)},${lit(P.A2.workspace)},${lit(staleOp)},1,'stripe_write','governance.billing.manage','planned',repeat('e',64),0,date_trunc('milliseconds',clock_timestamp())-interval '2 hours',date_trunc('milliseconds',clock_timestamp())-interval '2 hours');
INSERT INTO morrow_billing.checkout_intents VALUES(${lit(P.A2.org)},${lit(P.A2.workspace)},${lit(staleIntent)},1,'open',${lit(PRICE)},1,1,'test',${lit(P.A2.principal)},${lit(P.A2.membership)},${lit(randomUUID())},repeat('f',64),'lab',NULL,${lit(staleOp)},NULL,date_trunc('second',clock_timestamp())-interval '1 hour',date_trunc('milliseconds',clock_timestamp())-interval '2 hours',date_trunc('milliseconds',clock_timestamp())-interval '2 hours');`,
    );
    const afterExpiry = await call(P.A2, "POST", "/morrow/checkout", { priceKey: PRICE });
    check(
      "B_lazy_close_expires_the_stale_intent_and_a_new_checkout_opens",
      afterExpiry.status === 201 &&
        one(`SELECT status FROM morrow_billing.checkout_intents WHERE id=${lit(staleIntent)}`)
          ?.status === "expired" &&
        intents(P.A2).filter((i) => i.status === "open").length === 1,
    );

    // -----------------------------------------------------------------------------
    // C. The broker definers' semantics.
    const intentA2 = intents(P.A2).find((i) => i.status === "open");
    // A fresh checkout operation whose first send is lost.
    db.workOwner(
      `UPDATE morrow_billing.checkout_intents SET status='failed',revision=revision+1 WHERE id=${lit(intentA2.id)};`,
    );
    broker.faults.checkout = "uncertain";
    const lost = await call(P.A2, "POST", "/morrow/checkout", { priceKey: PRICE });
    broker.faults.checkout = undefined;
    const lostOp = lost.body.operationId;
    const lostRow = () =>
      one(
        `SELECT status,attempt::text AS attempt,uncertainty_reason FROM morrow_work.operations WHERE id=${lit(lostOp)}`,
      );
    check(
      "C_an_unknown_send_is_uncertain_and_the_client_reconciles_with_the_same_key",
      lost.status === 503 &&
        lost.body.code === "uncertain" &&
        lost.body.retryClass === "reconcile_before_retry" &&
        lost.body.operationId === lostOp &&
        lostRow().status === "uncertain" &&
        lostRow().attempt === "1" &&
        lostRow().uncertainty_reason === "transport_after_dispatch",
    );
    const reconcile = await opBegin(lostOp);
    check(
      "C_begin_on_an_uncertain_operation_is_reconcile_never_a_second_send",
      reconcile.outcome === "reconcile" &&
        lostRow().attempt === "1" &&
        lostRow().status === "uncertain",
    );
    check(
      "C_uncertain_is_never_promoted_without_a_provider_result",
      (await opSettle(lostOp, "uncertain")) === "uncertain" && lostRow().status === "uncertain",
    );
    const sessionId = "cs_test_" + lostOp.replaceAll("-", "");
    check(
      "C_readback_settles_uncertain_to_verified",
      (await opSettle(lostOp, "verified", sessionId)) === "verified" &&
        lostRow().status === "verified" &&
        (await opSettle(lostOp, "verified", sessionId)) === "already_verified" &&
        (await opSettle(lostOp, "verified", "cs_test_someotherSession01")) === "conflict",
    );
    // A send fence that was set, with no settle: the next begin moves it to uncertain.
    db.workOwner(
      `UPDATE morrow_billing.checkout_intents SET status='failed',revision=revision+1 WHERE workspace_id=${lit(P.A2.workspace)} AND status='open';`,
    );
    const fenced = await call(P.A2, "POST", "/morrow/checkout", { priceKey: PRICE });
    // That request settled; build a second operation and stop after its fence.
    db.workOwner(
      `UPDATE morrow_billing.checkout_intents SET status='failed',revision=revision+1 WHERE workspace_id=${lit(P.A2.workspace)} AND status='open';`,
    );
    broker.faults.checkout = "uncertain";
    const fenceCase = await call(P.A2, "POST", "/morrow/checkout", { priceKey: PRICE });
    broker.faults.checkout = undefined;
    check("C_setup_fence_case", fenced.status === 201 && fenceCase.status === 503);
    // A failed provider result (verified_no_effect) fails the operation and its intent.
    const failOp = fenceCase.body.operationId;
    check(
      "C_a_definite_failure_fails_the_operation_and_its_open_intent",
      (await opSettle(failOp, "failed")) === "failed" &&
        one(`SELECT status FROM morrow_work.operations WHERE id=${lit(failOp)}`)?.status ===
          "failed" &&
        one(
          `SELECT i.status FROM morrow_billing.checkout_intents i WHERE i.checkout_operation_id=${lit(failOp)}`,
        )?.status === "failed",
    );
    check(
      "C_settle_refuses_a_malformed_provider_id",
      (await opSettle(randomUUID(), "verified", "cus_bad")) === "invalid" &&
        (await opSettle(failOp, "verified", "bps_" + "a".repeat(20))) !== "verified",
    );
    // The send fence: a begin that finds dispatching with the fence set moves to uncertain.
    db.workOwner(
      `UPDATE morrow_billing.checkout_intents SET status='failed',revision=revision+1 WHERE workspace_id=${lit(P.A2.workspace)} AND status IN ('open','completed');`,
    );
    const fenceKey = randomUUID();
    const pending = { ...broker };
    const fenceIntent = await (async () => {
      // Open through the handler with a broker that only begins (and never settles).
      const quiet = createBillingApiHandler({
        origin: workFixtureOrigin,
        connector: db.connector(),
        environment: "development",
        broker: {
          ...pending,
          async customerEnsure(id) {
            return broker.customerEnsure(id);
          },
          async checkoutCreate(id) {
            await opBegin(id);
            return { outcome: "uncertain", checkoutUrl: null, expiresAtMs: null };
          },
        },
        now: () => Date.now(),
      });
      const r = await quiet.fetch(
        new Request(
          workFixtureOrigin + "/workspace/" + P.A2.workspace + "/billing/morrow/checkout",
          {
            method: "POST",
            headers: {
              Cookie: "__Host-morrow_session=" + P.A2.secret,
              Origin: workFixtureOrigin,
              "Content-Type": "application/json",
              "X-Morrow-Request": "1",
              "Idempotency-Key": fenceKey,
              "Sec-Fetch-Site": "same-origin",
            },
            body: JSON.stringify({ priceKey: PRICE }),
          },
        ),
        {},
        ctx,
      );
      return (await r.json()).operationId;
    })();
    const fenceRow = () =>
      one(
        `SELECT status,attempt::text AS attempt,send_started_at IS NOT NULL AS fenced,uncertainty_reason FROM morrow_work.operations WHERE id=${lit(fenceIntent)}`,
      );
    const fenceBefore = fenceRow();
    const second = await opBegin(fenceIntent);
    check(
      "C_send_fence_set_before_send_and_a_second_begin_is_never_a_second_send",
      fenceBefore.status === "dispatching" &&
        fenceBefore.fenced === true &&
        fenceBefore.attempt === "1" &&
        second.outcome === "reconcile" &&
        fenceRow().status === "uncertain" &&
        fenceRow().uncertainty_reason === "unknown_submission" &&
        fenceRow().attempt === "1",
    );
    const replayFence = await call(
      P.A2,
      "POST",
      "/morrow/checkout",
      { priceKey: PRICE },
      { key: fenceKey },
    );
    check(
      "C_the_same_key_replays_the_uncertain_operation_never_a_new_one",
      replayFence.body.operationId === fenceIntent &&
        count(
          `SELECT 1 FROM morrow_billing.checkout_intents WHERE workspace_id=${lit(P.A2.workspace)} AND idempotency_key=${lit(fenceKey)}`,
        ) === 1,
    );

    // -----------------------------------------------------------------------------
    // D. Receipts.
    const ids = (p, extra = {}) => ({
      customer: one(
        `SELECT stripe_customer_id FROM morrow_billing.stripe_customers WHERE workspace_id=${lit(p.workspace)}`,
      )?.stripe_customer_id,
      operationId: one(
        `SELECT checkout_operation_id::text AS op FROM morrow_billing.checkout_intents WHERE workspace_id=${lit(p.workspace)} ORDER BY created_at DESC LIMIT 1`,
      )?.op,
      workspaceId: p.workspace,
      organizationId: p.org,
      subscription: "sub_" + p.workspace.replaceAll("_", "") + "Subscr01",
      ...extra,
    });
    const invoiceFor = (name, patch, period = periodNow, edit = () => {}) =>
      stripeFixture(name, patch, (o) => {
        withPeriod(period.start, period.end)(o);
        edit(o);
      });
    const subscriptionFor = (name, patch, period = periodNow, edit = () => {}) =>
      stripeFixture(name, patch, (o) => {
        withPeriod(period.start, period.end)(o);
        edit(o);
      });
    const routeOf = (p) =>
      one(
        `SELECT route,mode,fixing_payment_key,revision::text AS revision FROM morrow_billing.workspace_billing_routes WHERE workspace_id=${lit(p.workspace)}`,
      );
    const walletOf = (p) =>
      one(
        `SELECT available::text AS available,reserved::text AS reserved,consumed::text AS consumed,revision::text AS revision FROM morrow_billing.credit_wallets WHERE workspace_id=${lit(p.workspace)}`,
      );
    const applicationOf = (eventId) =>
      one(
        `SELECT a.outcome,a.outcome_code FROM morrow_billing.receipt_applications a JOIN morrow_billing.stripe_event_receipts r ON r.id=a.receipt_id WHERE r.event_id=${lit(eventId)}`,
      );

    // D1. invoice.paid (subscription_create) for A: one commit fixes and funds.
    const a = ids(P.A, { invoice: "in_LabCreateA00001" });
    const createA = invoiceFor("invoice.paid.subscription_create", a);
    const paid = await deliver("invoice.paid", createA, subscriptionFor("subscription.active", a));
    const fixed = routeOf(P.A);
    const xmins = db.rows(
      `SELECT (SELECT xmin::text FROM morrow_billing.workspace_billing_routes WHERE workspace_id=${lit(P.A.workspace)}) AS route,
       (SELECT xmin::text FROM morrow_billing.billing_accounts WHERE workspace_id=${lit(P.A.workspace)}) AS account,
       (SELECT xmin::text FROM morrow_billing.credit_wallets WHERE workspace_id=${lit(P.A.workspace)}) AS wallet,
       (SELECT xmin::text FROM morrow_billing.verified_payment_events WHERE workspace_id=${lit(P.A.workspace)}) AS vpe,
       (SELECT xmin::text FROM morrow_billing.credit_grants WHERE workspace_id=${lit(P.A.workspace)}) AS grant,
       (SELECT xmin::text FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(P.A.workspace)}) AS snapshot,
       (SELECT a.xmin::text FROM morrow_billing.receipt_applications a WHERE a.workspace_id=${lit(P.A.workspace)}) AS application`,
    )[0];
    check(
      "D_invoice_paid_fixes_morrow_direct_and_grants_300_in_one_commit",
      paid.status === 200 &&
        fixed.route === "morrow_direct" &&
        fixed.mode === "test" &&
        fixed.fixing_payment_key === "stripe:invoice:in_LabCreateA00001" &&
        walletOf(P.A).available === "300" &&
        walletOf(P.A).revision === "2" &&
        count(
          `SELECT 1 FROM morrow_billing.credit_grants WHERE workspace_id=${lit(P.A.workspace)} AND credit_units=300 AND expires_at IS NULL AND funded_wallet_revision=2`,
        ) === 1 &&
        one(
          `SELECT outcome,operation_id::text AS op,amount,currency FROM morrow_billing.verified_payment_events WHERE workspace_id=${lit(P.A.workspace)}`,
        )?.op === a.operationId &&
        one(
          `SELECT status FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(P.A.workspace)}`,
        )?.status === "active" &&
        intents(P.A).some((i) => i.status === "verified") &&
        new Set(Object.values(xmins)).size === 1,
    );
    const billable = await call(P.A, "GET", "");
    check(
      "D_the_workspace_is_billable_with_300_credits_and_a_billing_period",
      billable.status === 200 &&
        billable.body.phase === "morrow_direct" &&
        billable.body.state === "billable" &&
        billable.body.credits.available === "300" &&
        billable.body.billingPeriod.end === new Date(periodNow.end * 1000).toISOString() &&
        billable.body.callToAction.label === "Manage plan",
    );
    // D2. The same event again, and a second event for the same invoice.
    const again = await deliverEvent(
      paid.eventId,
      "invoice.paid",
      createA,
      subscriptionFor("subscription.active", a),
    );
    const secondEvent = await deliver(
      "invoice.paid",
      createA,
      subscriptionFor("subscription.active", a),
    );
    check(
      "D_duplicate_event_and_double_invoice_paid_grant_once",
      again.status === 200 &&
        secondEvent.status === 200 &&
        count(
          `SELECT 1 FROM morrow_billing.stripe_event_receipts WHERE event_id=${lit(paid.eventId)}`,
        ) === 1 &&
        applicationOf(secondEvent.eventId)?.outcome === "already_granted" &&
        count(
          `SELECT 1 FROM morrow_billing.credit_grants WHERE workspace_id=${lit(P.A.workspace)}`,
        ) === 1 &&
        walletOf(P.A).available === "300",
    );
    // D3. checkout.session.completed after the payment: nothing more.
    const sessionA = one(
      `SELECT stripe_session_id FROM morrow_billing.checkout_intents WHERE workspace_id=${lit(P.A.workspace)} AND status='verified'`,
    ).stripe_session_id;
    const completedLate = await deliver(
      "checkout.session.completed",
      stripeFixture("checkout.session.completed", { ...a, session: sessionA }),
    );
    check(
      "D_checkout_completed_after_payment_changes_nothing",
      completedLate.status === 200 && applicationOf(completedLate.eventId)?.outcome === "ignored",
    );
    // D4. The other order (R): completed first, then paid. Same end state.
    const r = tenant("billing_r");
    const rCheckout = await call(r, "POST", "/morrow/checkout", { priceKey: PRICE });
    const rIds = ids(r, { invoice: "in_LabCreateR00001" });
    const rSession = one(
      `SELECT stripe_session_id FROM morrow_billing.checkout_intents WHERE workspace_id=${lit(r.workspace)}`,
    ).stripe_session_id;
    const completedFirst = await deliver(
      "checkout.session.completed",
      stripeFixture("checkout.session.completed", { ...rIds, session: rSession }),
    );
    const rPaid = await deliver(
      "invoice.paid",
      invoiceFor("invoice.paid.subscription_create", rIds),
      subscriptionFor("subscription.active", rIds),
    );
    check(
      "D_either_order_reaches_the_same_end_state",
      rCheckout.status === 201 &&
        applicationOf(completedFirst.eventId)?.outcome === "applied" &&
        rPaid.status === 200 &&
        routeOf(r).route === "morrow_direct" &&
        walletOf(r).available === walletOf(P.A).available &&
        intents(r).every((i) => i.status === "verified"),
    );
    // D5. A later period: a second grant.
    const cycle = await deliver(
      "invoice.paid",
      invoiceFor(
        "invoice.paid.subscription_cycle",
        { ...a, invoice: "in_LabCycleA000001" },
        { start: periodNow.end, end: periodNow.end + 30 * 86400 },
      ),
      subscriptionFor("subscription.active", a, {
        start: periodNow.end,
        end: periodNow.end + 30 * 86400,
      }),
    );
    check(
      "D_subscription_cycle_grants_a_second_month",
      cycle.status === 200 &&
        applicationOf(cycle.eventId)?.outcome === "applied" &&
        walletOf(P.A).available === "600" &&
        walletOf(P.A).revision === "3" &&
        count(
          `SELECT 1 FROM morrow_billing.credit_grants WHERE workspace_id=${lit(P.A.workspace)}`,
        ) === 2,
    );
    // D6. Cancellation via cancel_at: still active until cancel_at; then deleted.
    const cancelAt = nowS + 7 * 86400;
    const updated = await deliver(
      "customer.subscription.updated",
      subscriptionFor("subscription.cancel_at", a, periodNow, (o) => (o.cancel_at = cancelAt)),
    );
    const latest = () =>
      one(
        `SELECT status,to_char(valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_until,revision::text AS revision FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(P.A.workspace)} ORDER BY revision DESC LIMIT 1`,
      );
    check(
      "D_cancel_at_folds_to_active_until_cancel_at",
      updated.status === 200 &&
        latest().status === "active" &&
        latest().valid_until === new Date(cancelAt * 1000).toISOString(),
    );
    const deleted = await deliver(
      "customer.subscription.deleted",
      subscriptionFor("subscription.deleted", a),
    );
    check(
      "D_deletion_folds_to_cancelled_and_the_account_follows",
      deleted.status === 200 &&
        latest().status === "cancelled" &&
        one(
          `SELECT status FROM morrow_billing.billing_accounts WHERE workspace_id=${lit(P.A.workspace)}`,
        )?.status === "cancelled",
    );
    const revive = await deliver(
      "customer.subscription.updated",
      subscriptionFor("subscription.active", a),
    );
    check(
      "D_a_cancelled_subscription_is_absorbing",
      revive.status === 200 &&
        latest().status === "cancelled" &&
        applicationOf(revive.eventId)?.outcome === "ignored",
    );
    // D7. Unattributed, not Morrow-initiated, terms mismatch and no charge.
    const stranger = await deliver(
      "invoice.paid",
      invoiceFor("invoice.paid.subscription_create", {
        customer: "cus_UnknownCustomer1",
        invoice: "in_LabStranger0001",
      }),
      subscriptionFor("subscription.active", { customer: "cus_UnknownCustomer1" }),
    );
    check(
      "D_an_unmapped_customer_is_held_unattributed",
      stranger.status === 200 &&
        applicationOf(stranger.eventId)?.outcome === "held" &&
        applicationOf(stranger.eventId)?.outcome_code === "CUSTOMER_NOT_MAPPED" &&
        one(
          `SELECT organization_id FROM morrow_billing.stripe_event_receipts WHERE event_id=${lit(stranger.eventId)}`,
        )?.organization_id === null,
    );
    const s = tenant("billing_s");
    await call(s, "POST", "/morrow/checkout", { priceKey: PRICE });
    const sIds = ids(s);
    const foreignMeta = await deliver(
      "invoice.paid",
      invoiceFor("invoice.paid.subscription_create", {
        ...sIds,
        invoice: "in_LabForeign0001",
        workspaceId: P.A.workspace,
      }),
      subscriptionFor("subscription.active", sIds),
    );
    const wrongPrice = await deliver(
      "invoice.paid",
      invoiceFor("invoice.paid.subscription_create", {
        ...sIds,
        invoice: "in_LabPrice000001",
        price: "price_UnknownPrice01",
      }),
      subscriptionFor("subscription.active", { ...sIds, price: "price_UnknownPrice01" }),
    );
    const zero = await deliver(
      "invoice.paid",
      invoiceFor(
        "invoice.paid.subscription_create",
        { ...sIds, invoice: "in_LabZero0000001" },
        periodNow,
        (o) => {
          o.amount_paid = 0;
          o.amount_due = 0;
        },
      ),
      subscriptionFor("subscription.active", sIds),
    );
    const vpe = (invoice) =>
      one(
        `SELECT outcome,outcome_code,operation_id FROM morrow_billing.verified_payment_events WHERE payment_key=${lit("stripe:invoice:" + invoice)}`,
      );
    check(
      "D_metadata_naming_another_workspace_is_held_not_morrow_initiated",
      applicationOf(foreignMeta.eventId)?.outcome_code === "NOT_MORROW_INITIATED" &&
        vpe("in_LabForeign0001")?.outcome === "held" &&
        vpe("in_LabForeign0001")?.operation_id === null,
    );
    check(
      "D_a_price_outside_the_terms_is_held_terms_mismatch",
      applicationOf(wrongPrice.eventId)?.outcome_code === "TERMS_MISMATCH" &&
        vpe("in_LabPrice000001")?.outcome === "held",
    );
    check(
      "D_a_zero_invoice_is_no_charge_and_fixes_nothing",
      applicationOf(zero.eventId)?.outcome === "no_charge" &&
        vpe("in_LabZero0000001")?.outcome === "no_charge" &&
        routeOf(s).route === null &&
        walletOf(s) === null,
    );
    // D8. A payment after a store link (defence case: the link is a superuser fixture).
    const y = P.Y;
    await call(y, "POST", "/morrow/checkout", { priceKey: PRICE });
    const yIds = ids(y);
    const installation = "installation_lab_y";
    db.admin(
      `INSERT INTO morrow_identity.linking_candidates VALUES('candidate_lab_y','shopify','synthetic_app','synthetic_env','1001','lab-y.myshopify.com',${lit(installation)},1,true,1,'controlled_fixture','proof_lab_y',1,repeat('a',64),${lit(y.principal)},clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 minute',NULL);
INSERT INTO morrow_identity.workspace_store_links VALUES('link_lab_y','candidate_lab_y',${lit(y.org)},${lit(y.workspace)},${lit(installation)},1,1,${lit(y.principal)},clock_timestamp());`,
    );
    const afterLink = await deliver(
      "invoice.paid",
      invoiceFor("invoice.paid.subscription_create", { ...yIds, invoice: "in_LabLinked00001" }),
      subscriptionFor("subscription.active", yIds),
    );
    check(
      "D_a_payment_after_a_store_link_is_route_mismatch_never_morrow_direct",
      afterLink.status === 200 &&
        applicationOf(afterLink.eventId)?.outcome === "conflict" &&
        applicationOf(afterLink.eventId)?.outcome_code === "ROUTE_MISMATCH" &&
        routeOf(y).route === null &&
        walletOf(y) === null,
    );
    const linkedPlans = await call(y, "GET", "/morrow/plans");
    const linkedCheckout = await call(y, "POST", "/morrow/checkout", { priceKey: PRICE });
    check(
      "D_a_linked_workspace_gets_purchase_route_mismatch",
      linkedPlans.status === 403 &&
        linkedPlans.body.safeMessage === "Manage this workspace's plan where it was purchased." &&
        linkedCheckout.status === 403,
    );
    // D9. Forged plans: receipt_apply re-derives and refuses.
    // A receipt recorded by the broker login (a zero invoice), applied with forged plans.
    const forgeId = randomUUID();
    const forgeObject = normalizeInvoice(
      invoiceFor(
        "invoice.paid.subscription_create",
        { ...sIds, invoice: "in_LabForgeB00001" },
        periodNow,
        (o) => {
          o.amount_paid = 0;
          o.amount_due = 0;
        },
      ),
      subscriptionFor("subscription.active", sIds),
    );
    const forgeDigest = await stripeObjectDigest(forgeObject);
    const [recorded] = (
      await vault([
        [
          "SELECT * FROM morrow_billing.stripe_receipt_record($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            "evt_labforge" + forgeId.replaceAll("-", ""),
            "invoice.paid",
            "false",
            "invoice",
            forgeObject.id,
            forgeObject.customer,
            JSON.stringify(forgeObject),
            forgeDigest,
            String(Date.now()),
          ],
        ],
      ])
    )[0];
    const forge = (plan) =>
      db.tryRun(
        `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT outcome FROM morrow_billing.receipt_begin(${lit(recorded.receipt_id)},${lit(forgeDigest)});
SELECT outcome FROM morrow_billing.receipt_apply(${lit(recorded.receipt_id)},${lit(forgeDigest)},${lit(JSON.stringify(plan))}); ROLLBACK;`,
        { user: "morrow_api_worker" },
      );
    const grantPlan = (action, extra = {}) => ({
      schemaVersion: 1,
      outcome: "applied",
      code: null,
      payment: { action, outcome: "granted", code: null, termsRevision: 2 },
      snapshot: { revision: 1 },
      intent: null,
      ...extra,
    });
    const zeroGrant = forge(grantPlan("fix_route_and_grant"));
    const wrongTerms = forge({
      ...grantPlan("fix_route_and_grant"),
      payment: { action: "fix_route_and_grant", outcome: "granted", code: null, termsRevision: 1 },
    });
    check(
      "D_forged_plans_are_refused_and_write_nothing",
      zeroGrant.ok &&
        zeroGrant.stdout.split("\n").at(-1) === "invalid" &&
        wrongTerms.stdout.split("\n").at(-1) === "conflict" &&
        routeOf(s).route === null &&
        count(
          `SELECT 1 FROM morrow_billing.receipt_applications WHERE receipt_id=${lit(recorded.receipt_id)}`,
        ) === 0,
    );

    // -----------------------------------------------------------------------------
    // E. Isolation probes.
    const e = tenant("billing_e");
    const underSession = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${lit(e.digest)},${lit(e.workspace)});
SELECT outcome FROM morrow_billing.receipt_begin(${lit(recorded.receipt_id)},${lit(forgeDigest)}); ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    check(
      "E_ingress_refuses_a_session_context",
      underSession.stdout.split("\n").at(-1) === "denied",
    );
    const forged = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT set_config('morrow.billing_receipt_entered',${lit(randomUUID())},true);
SELECT outcome FROM morrow_billing.receipt_apply(${lit(recorded.receipt_id)},${lit(forgeDigest)},${lit(JSON.stringify(grantPlan("fix_route_and_grant")))}); ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    check("E_a_forged_receipt_context_is_denied", forged.stdout.split("\n").at(-1) === "denied");
    const crossRead = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${lit(P.Y.digest)},${lit(P.Y.workspace)});
SELECT count(*) FROM morrow_billing.billing_accounts WHERE workspace_id<>${lit(P.Y.workspace)}; SELECT count(*) FROM morrow_billing.credit_wallets WHERE workspace_id<>${lit(P.Y.workspace)}; SELECT count(*) FROM morrow_billing.verified_payment_events WHERE workspace_id<>${lit(P.Y.workspace)}; ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    check(
      "E_cross_tenant_session_reads_are_empty",
      crossRead.ok &&
        crossRead.stdout
          .split("\n")
          .slice(-3)
          .every((n) => n === "0"),
    );
    for (const login of [
      "morrow_api_worker",
      "morrow_runtime_executor",
      "morrow_connector_ingress",
    ])
      check(
        "E_" + login + "_cannot_run_the_broker_definers",
        !db.tryRun(`SELECT * FROM morrow_billing.stripe_op_begin(${lit(randomUUID())});`, {
          user: login,
        }).ok,
      );
    check(
      "E_the_vault_login_cannot_run_the_ingress_or_read_billing_tables",
      !db.tryRun(`SELECT * FROM morrow_billing.receipt_status(${lit(recorded.receipt_id)});`, {
        user: "morrow_vault_broker",
      }).ok &&
        !db.tryRun(`SELECT count(*) FROM morrow_billing.stripe_customers;`, {
          user: "morrow_vault_broker",
        }).ok,
    );
    const sessionStatus = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${lit(e.digest)},${lit(e.workspace)});
SELECT outcome FROM morrow_billing.receipt_status(${lit(recorded.receipt_id)}); ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    check(
      "E_receipt_status_refuses_a_session_context",
      sessionStatus.stdout.split("\n").at(-1) === "denied",
    );
    const sessionFix = db.tryRun(
      `BEGIN; SELECT set_config('morrow.work_session_digest',${lit(e.digest)},true),set_config('morrow.work_workspace',${lit(e.workspace)},true);
SET LOCAL ROLE morrow_work_command;
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=date_trunc('milliseconds',clock_timestamp()),fixing_payment_key='stripe:invoice:in_ForgedFix00001',revision=revision+1 WHERE workspace_id=${lit(e.workspace)}; ROLLBACK;`,
    );
    check(
      "E_the_command_role_cannot_fix_a_route_outside_a_receipt_context",
      !sessionFix.ok && /BILLING_ROUTE_FIX_DENIED/.test(sessionFix.stderr),
    );

    // -----------------------------------------------------------------------------
    // F. The P01.T04a decision tables, row by row, against the persisted path.
    // classify-payment: every Stripe subscription-period row of the environment's mode that
    // M5 can persist (phases open, shopify_bound and morrow_direct; payers none, active and
    // suspended). Each row gets a fresh tenant built through the real checkout, receipt and
    // fold paths (owner SQL only for a suspended account, for an account without a recorded
    // subscription, and for the store link), then one invoice.paid through the webhook; the
    // persisted application, payment event, grant and route must match the row. Reversed
    // payers (M6 payment_reversals), App Pricing (P18.T01b), plan changes and top-ups (not
    // sold in M5) are outside the persisted path.
    const tsv = (name) => {
      const [head, ...lines] = readFileSync(`docs/contracts/decision-tables/${name}.tsv`, "utf8")
        .trim()
        .split("\n");
      const columns = head.split("\t");
      return lines.map((line) =>
        Object.fromEntries(line.split("\t").map((value, i) => [columns[i], value])),
      );
    };
    const classifyRows = tsv("classify-payment").filter(
      (r) =>
        r.provider === "stripe" &&
        r.kind === "subscription_period" &&
        r.mode === "matches" &&
        r.outcome !== "input_invalid" &&
        ["open", "shopify_bound", "morrow_direct"].includes(r.phase) &&
        ["none", "active", "suspended"].includes(r.payer),
    );
    const grantFor = (paymentKey) =>
      count(`SELECT 1 FROM morrow_billing.credit_grants WHERE payment_key=${lit(paymentKey)}`);
    const linkStore = (p, n) =>
      db.admin(
        `INSERT INTO morrow_identity.linking_candidates VALUES(${lit("candidate_" + p.key)},'shopify','synthetic_app','synthetic_env',${lit(String(2000 + n))},${lit("lab-" + n + ".myshopify.com")},${lit("installation_" + p.key)},1,true,1,'controlled_fixture',${lit("proof_" + p.key)},1,repeat('a',64),${lit(p.principal)},clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 minute',NULL);
INSERT INTO morrow_identity.workspace_store_links VALUES(${lit("link_" + p.key)},${lit("candidate_" + p.key)},${lit(p.org)},${lit(p.workspace)},${lit("installation_" + p.key)},1,1,${lit(p.principal)},clock_timestamp());`,
      );
    const suspend = (p) =>
      db.workOwner(
        `UPDATE morrow_billing.billing_accounts SET status='suspended',revision=revision+1,updated_at=greatest(updated_at,date_trunc('milliseconds',clock_timestamp())) WHERE workspace_id=${lit(p.workspace)};`,
      );
    const classifyMismatches = [];
    let fRow = 0;
    for (const row of classifyRows) {
      const n = ++fRow;
      const p = tenant("billing_fc" + n);
      await call(p, "POST", "/morrow/checkout", { priceKey: PRICE });
      const base = ids(p, { invoice: `in_LabFc${String(n).padStart(3, "0")}Base01` });
      if (row.phase === "shopify_bound") linkStore(p, n);
      if (row.phase === "morrow_direct") {
        if (row.relation === "none") {
          // An account without a recorded subscription (owner maintenance fixture).
          db.workOwner(
            `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=date_trunc('milliseconds',clock_timestamp()),fixing_payment_key=${lit("stripe:invoice:in_LabFc" + n + "Owner01")},revision=revision+1,updated_at=greatest(updated_at,date_trunc('milliseconds',clock_timestamp())) WHERE workspace_id=${lit(p.workspace)};
INSERT INTO morrow_billing.billing_accounts VALUES(${lit(p.org)},${lit(p.workspace)},${lit(randomUUID())},'morrow_direct','test','USD','active',1,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()));`,
          );
        } else {
          await deliver(
            "invoice.paid",
            invoiceFor("invoice.paid.subscription_create", base),
            subscriptionFor("subscription.active", base),
          );
          if (["current_terminal", "new_after_terminal"].includes(row.relation))
            await deliver(
              "customer.subscription.deleted",
              subscriptionFor("subscription.deleted", base),
            );
        }
        if (row.payer === "suspended") suspend(p);
      }
      // The event: the current subscription's next period, another subscription, or an
      // unmapped customer's invoice.
      const other = ["other_live", "new_after_terminal"].includes(row.relation);
      const eventIds =
        row.attribution === "unattributed"
          ? {
              customer: "cus_LabUnmappedFc" + n,
              invoice: `in_LabFc${String(n).padStart(3, "0")}Event1`,
            }
          : {
              ...base,
              invoice: `in_LabFc${String(n).padStart(3, "0")}Event1`,
              subscription: other
                ? base.subscription.replace("Subscr01", "Subscr02")
                : base.subscription,
            };
      const zero = row.amount === "zero";
      const nextPeriod = { start: periodNow.end, end: periodNow.end + 30 * 86400 };
      const cycle = row.phase === "morrow_direct" && !other && row.relation !== "none";
      const event = await deliver(
        "invoice.paid",
        invoiceFor(
          cycle ? "invoice.paid.subscription_cycle" : "invoice.paid.subscription_create",
          eventIds,
          cycle ? nextPeriod : periodNow,
          (o) => {
            if (zero) {
              o.amount_paid = 0;
              o.amount_due = 0;
            }
          },
        ),
        subscriptionFor(
          row.relation === "current_terminal" ? "subscription.deleted" : "subscription.active",
          eventIds,
          cycle ? nextPeriod : periodNow,
        ),
      );
      const applied = applicationOf(event.eventId);
      const paymentKey = "stripe:invoice:" + eventIds.invoice;
      const [kind, code] = row.outcome.split(":");
      const route = routeOf(p);
      const ok =
        event.status === 200 &&
        (kind === "fix_route_and_grant"
          ? applied?.outcome === "applied" &&
            route.route === "morrow_direct" &&
            route.fixing_payment_key === paymentKey &&
            grantFor(paymentKey) === 1
          : kind === "grant"
            ? applied?.outcome === "applied" && grantFor(paymentKey) === 1
            : kind === "no_charge"
              ? applied?.outcome === "no_charge" && grantFor(paymentKey) === 0
              : applied?.outcome === kind &&
                applied?.outcome_code === code &&
                grantFor(paymentKey) === 0) &&
        (row.phase !== "morrow_direct" && kind !== "fix_route_and_grant"
          ? route.route === null
          : true);
      if (!ok)
        classifyMismatches.push({
          row: Object.values(row).join(" "),
          status: event.status,
          applied,
          route: route?.route,
        });
    }
    check(
      "F_classify_payment_rows_hold_on_the_persisted_path",
      classifyRows.length === 30 && classifyMismatches.length === 0,
    );
    if (classifyMismatches.length) console.log(JSON.stringify({ classifyMismatches }));

    // purchase-decision: the two purchase actions M5 serves (subscribe = POST /checkout,
    // billing_portal = POST /portal) in the three persisted phases. The link dimension does
    // not change these actions; the payer and subscription dimensions are built as an
    // active, a suspended and a cancelled account. One stricter persisted outcome is
    // deliberate: subscribe in morrow_direct after a terminal subscription (the library
    // allows a resubscription) is refused by cmd_checkout_open's fixed-route recheck
    // (route_conflict, 403) until M6's held-payment re-classification exists.
    const purchaseRows = tsv("purchase-decision").filter(
      (r) =>
        ["subscribe", "billing_portal"].includes(r.action) &&
        ["open", "shopify_bound", "morrow_direct"].includes(r.phase),
    );
    const states = new Map();
    const stateFor = async (row) => {
      const key =
        row.phase === "morrow_direct"
          ? row.subscription === "terminal"
            ? "md_terminal"
            : row.payer === "billable"
              ? "md_live"
              : "md_suspended"
          : row.phase;
      if (states.has(key)) return states.get(key);
      const p = tenant("billing_fp_" + key);
      if (row.phase === "shopify_bound") linkStore(p, 900 + states.size);
      if (row.phase === "morrow_direct") {
        await call(p, "POST", "/morrow/checkout", { priceKey: PRICE });
        const base = ids(p, { invoice: "in_LabFp" + key.replace("_", "") + "Base1" });
        await deliver(
          "invoice.paid",
          invoiceFor("invoice.paid.subscription_create", base),
          subscriptionFor("subscription.active", base),
        );
        if (key === "md_terminal")
          await deliver(
            "customer.subscription.deleted",
            subscriptionFor("subscription.deleted", base),
          );
        if (key === "md_suspended") suspend(p);
      }
      states.set(key, p);
      return p;
    };
    const purchaseMismatches = [];
    for (const row of purchaseRows) {
      const p = await stateFor(row);
      const response =
        row.action === "subscribe"
          ? await call(p, "POST", "/morrow/checkout", { priceKey: PRICE })
          : await call(p, "POST", "/morrow/portal", {});
      const denial = BILLING_DENIAL_ENVELOPES[row.outcome];
      const stricter =
        row.phase === "morrow_direct" && row.action === "subscribe" && row.outcome === "allowed";
      const ok =
        row.outcome === "allowed" && !stricter
          ? [200, 201].includes(response.status) &&
            (row.action === "subscribe"
              ? response.body.checkoutUrl?.startsWith("https://checkout.stripe.com/")
              : response.body.portalUrl?.startsWith("https://billing.stripe.com/"))
          : stricter
            ? response.status === 403 && response.body.code === "denied"
            : response.body.code === denial.code &&
              response.body.retryClass === denial.retryClass &&
              response.body.safeMessage === denial.safeMessage;
      if (!ok)
        purchaseMismatches.push({
          row: Object.values(row).join(" "),
          status: response.status,
          body: response.body,
        });
    }
    check(
      "F_purchase_decision_rows_hold_on_the_persisted_path",
      purchaseRows.length === 48 && purchaseMismatches.length === 0,
    );
    if (purchaseMismatches.length) console.log(JSON.stringify({ purchaseMismatches }));

    // -----------------------------------------------------------------------------
    // G. The real broker code (apps/broker/src/stripe.ts) against the fake Stripe origin,
    // with M2 PR-2's vault transport signature implemented over this engine's broker login
    // (registry-checked statements, text values, one transaction per call). The api's
    // billing and webhook handlers call it through the same closed result codecs the RPC
    // uses. The workerd pair (lab:billing-workers) waits for M2 PR-2's transport.
    const fake = createStripeFake();
    const registered = new Set(Object.values(vaultStatements));
    async function vaultTransaction(budgetMs, body) {
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 10000)
        throw Error("VAULT_INPUT_INVALID");
      const signal = new AbortController().signal;
      const c = await vaultConnector.open({
        signal,
        deadlineMs: Date.now() + budgetMs + 20000,
        waitUntil() {},
      });
      try {
        await c.query("BEGIN", [], signal);
        const out = await body(async (text, values) => {
          if (!registered.has(text) || !values.every((v) => typeof v === "string"))
            throw Error("VAULT_STATEMENT_DENIED");
          return (await c.query(text, values, signal)).rows;
        });
        await c.query("COMMIT", [], signal);
        return out;
      } catch (error) {
        await c.query("ROLLBACK", [], signal).catch(() => {});
        throw error;
      } finally {
        await c.close();
      }
    }
    const stripeDeps = {
      stripe: {
        environment: "development",
        restrictedKey: fakeStripeKey,
        webhookSecret: fakeStripeWebhookSecret,
        configuration: {
          portalConfigurationId: "bpc_" + "LabPortal".padEnd(24, "0"),
          automaticTax: false,
          billingAddressCollection: "auto",
        },
        returnOrigin: workFixtureOrigin,
      },
      fetch: fake.fetch,
      transaction: vaultTransaction,
      now: () => Date.now(),
    };
    const realBroker = {
      customerEnsure: async (id) =>
        decodeStripeCustomerResult(
          encodeStripeCustomerResult(await stripeCustomerEnsure(stripeDeps, id, 8000)),
        ),
      checkoutCreate: async (id) =>
        decodeStripeCheckoutResult(
          encodeStripeCheckoutResult(await stripeCheckoutCreate(stripeDeps, id, 8000)),
        ),
      portalCreate: async (id) =>
        decodeStripePortalResult(
          encodeStripePortalResult(await stripePortalCreate(stripeDeps, id, 8000)),
        ),
      webhookVerify: async (raw, signature) =>
        decodeStripeWebhookResult(
          encodeStripeWebhookResult(await stripeWebhookVerify(stripeDeps, raw, signature, 8000)),
        ),
    };
    const realApi = createBillingApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(),
      environment: "development",
      broker: realBroker,
      now: () => Date.now(),
    });
    let loseCommit = false;
    const realWebhook = createStripeWebhookHandler({
      connector: db.connector({
        async afterQuery(record, connection) {
          if (loseCommit && record.text === "COMMIT") {
            loseCommit = false;
            await connection.loseReply();
          }
        },
      }),
      environment: "development",
      broker: realBroker,
      now: () => Date.now(),
    });
    const realCall = async (p, method, path, body, key = randomUUID()) => {
      const response = await realApi.fetch(
        new Request(workFixtureOrigin + "/workspace/" + p.workspace + "/billing" + path, {
          method,
          headers: {
            Cookie: "__Host-morrow_session=" + p.secret,
            "Sec-Fetch-Site": "same-origin",
            ...(method === "POST"
              ? {
                  Origin: workFixtureOrigin,
                  "Content-Type": "application/json",
                  "X-Morrow-Request": "1",
                  "Idempotency-Key": key,
                }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        {},
        ctx,
      );
      return { status: response.status, body: await response.json() };
    };
    const post = async (delivery, signature = delivery.signature) =>
      (
        await realWebhook.fetch(
          new Request(workFixtureOrigin + "/api/billing/stripe/webhook", {
            method: "POST",
            headers: { "stripe-signature": signature, "content-type": "application/json" },
            body: delivery.body,
          }),
          {},
          ctx,
        )
      ).status;
    const receipts = () => count("SELECT 1 FROM morrow_billing.stripe_event_receipts");

    // G1. Checkout end to end: the customer and the session through the real broker.
    const g = tenant("billing_g");
    const gCheckout = await realCall(g, "POST", "/morrow/checkout", { priceKey: PRICE });
    const gIntent = intents(g)[0];
    const gCustomer = one(
      `SELECT stripe_customer_id FROM morrow_billing.stripe_customers WHERE workspace_id=${lit(g.workspace)}`,
    )?.stripe_customer_id;
    const gPosts = fake.requests.filter((r) => r.method === "POST");
    check(
      "G_checkout_end_to_end_through_the_real_broker_and_the_fake_origin",
      gCheckout.status === 201 &&
        gCheckout.body.checkoutUrl ===
          "https://checkout.stripe.com/c/pay/" + gIntent.stripe_session_id &&
        fake.state.customers.has(gCustomer) &&
        fake.state.sessions.get(gIntent.stripe_session_id)?.customer === gCustomer &&
        JSON.stringify(gPosts.map((r) => [r.path, r.idempotencyKey])) ===
          JSON.stringify([
            ["/v1/customers", "morrow-development-" + gIntent.customer_op],
            ["/v1/checkout/sessions", "morrow-development-" + gIntent.checkout_op],
          ]) &&
        gPosts[1].form["line_items[0][price]"] === PRICE.slice("stripe:price:".length) &&
        gPosts[1].form["metadata[morrow_operation_id]"] === gIntent.checkout_op &&
        gPosts[1].form["subscription_data[metadata][morrow_workspace_id]"] === g.workspace &&
        !Object.keys(gPosts[0].form).some((k) => /email/.test(k)),
    );
    // G2. The customer pays; Stripe signs and delivers; the api applies after the commit.
    const paidG = fake.complete(gIntent.stripe_session_id, {
      periodStart: periodNow.start,
      periodEnd: periodNow.end,
    });
    const receiptsBefore = receipts();
    const badSignature = await post(
      fake.signedEvent("invoice.paid", paidG.invoice, {
        secret: "whsec_" + "Wrong".padEnd(32, "0"),
      }),
    );
    check(
      "G_a_bad_signature_is_400_with_no_row",
      badSignature === 400 && receipts() === receiptsBefore,
    );
    // A held readback (500) is 503 with no row; Stripe's retry then applies.
    fake.faults.push({
      method: "GET",
      path: "/v1/invoices/" + paidG.invoice.id,
      kind: "500_before",
    });
    const invoiceEvent = fake.signedEvent("invoice.paid", paidG.invoice);
    const held = await post(invoiceEvent);
    check(
      "G_a_held_broker_is_503_and_writes_nothing",
      held === 503 && receipts() === receiptsBefore,
    );
    const paidStatus = await post(invoiceEvent);
    const gRoute = routeOf(g);
    check(
      "G_the_retry_applies_route_wallet_and_grant_after_the_commit",
      paidStatus === 200 &&
        gRoute.route === "morrow_direct" &&
        gRoute.fixing_payment_key === "stripe:invoice:" + paidG.invoice.id &&
        walletOf(g).available === "300" &&
        grantFor("stripe:invoice:" + paidG.invoice.id) === 1,
    );
    const replayed = await post(invoiceEvent);
    const completed = await post(fake.signedEvent("checkout.session.completed", paidG.session));
    check(
      "G_redelivery_and_the_completed_session_change_nothing",
      replayed === 200 &&
        completed === 200 &&
        grantFor("stripe:invoice:" + paidG.invoice.id) === 1 &&
        walletOf(g).available === "300" &&
        intents(g).every((i) => i.status === "verified"),
    );
    // G3. A lost commit acknowledgement is read back before the answer.
    const cycleG = fake.cycle(paidG.subscription.id, {
      periodStart: periodNow.end,
      periodEnd: periodNow.end + 30 * 86400,
    });
    loseCommit = true;
    const lostAck = await post(fake.signedEvent("invoice.paid", cycleG));
    check(
      "G_an_unknown_commit_is_read_back_before_the_acknowledgement",
      lostAck === 200 &&
        loseCommit === false &&
        grantFor("stripe:invoice:" + cycleG.id) === 1 &&
        walletOf(g).available === "600",
    );
    // G4. The portal through the saved configuration.
    const portal = await realCall(g, "POST", "/morrow/portal", {});
    const portalPost = fake.requests.filter((r) => r.path === "/v1/billing_portal/sessions").at(-1);
    check(
      "G_the_portal_session_uses_the_mapped_customer_and_the_saved_configuration",
      portal.status === 201 &&
        portal.body.portalUrl.startsWith("https://billing.stripe.com/p/session/") &&
        portalPost.form.customer === gCustomer &&
        portalPost.form.configuration === stripeDeps.stripe.configuration.portalConfigurationId &&
        portalPost.form.return_url === `${workFixtureOrigin}/w/${g.workspace}/settings/billing` &&
        portalPost.idempotencyKey === "morrow-development-" + portal.body.operationId,
    );
    // G5. An unknown Stripe outcome: readback before replay, never a new key.
    const h = tenant("billing_h");
    fake.faults.push({ method: "POST", path: "/v1/checkout/sessions", kind: "lost_after" });
    const hKey = randomUUID();
    const lostCheckout = await realCall(h, "POST", "/morrow/checkout", { priceKey: PRICE }, hKey);
    const hSessions = () =>
      [...fake.state.sessions.values()].filter(
        (s) => s.metadata.morrow_workspace_id === h.workspace,
      ).length;
    const hOp = lostCheckout.body.operationId;
    const opRow = () =>
      one(
        `SELECT status,attempt::text AS attempt FROM morrow_work.operations WHERE id=${lit(hOp)}`,
      );
    const sendsBefore = fake.requests.filter(
      (r) => r.path === "/v1/checkout/sessions" && r.method === "POST",
    ).length;
    const uncertainState = opRow();
    const retried = await realCall(h, "POST", "/morrow/checkout", { priceKey: PRICE }, hKey);
    const sendsAfter = fake.requests.filter(
      (r) => r.path === "/v1/checkout/sessions" && r.method === "POST",
    ).length;
    check(
      "G_an_unknown_outcome_is_read_back_and_never_resent_with_a_new_key",
      lostCheckout.status === 503 &&
        lostCheckout.body.code === "uncertain" &&
        uncertainState.status === "uncertain" &&
        retried.status === 200 &&
        retried.body.operationId === hOp &&
        retried.body.checkoutUrl?.startsWith("https://checkout.stripe.com/") &&
        sendsAfter === sendsBefore &&
        hSessions() === 1 &&
        opRow().status === "verified" &&
        opRow().attempt === "1",
    );
    // G6. Stripe expires an open session: checkout.session.expired closes the intent, and a
    // new checkout then opens a new session for the same customer.
    const x = tenant("billing_x");
    const xFirst = await realCall(x, "POST", "/morrow/checkout", { priceKey: PRICE });
    const xIntent = intents(x)[0];
    const expiredSession = fake.expire(xIntent.stripe_session_id);
    const expiredStatus = await post(fake.signedEvent("checkout.session.expired", expiredSession));
    const xAgain = await realCall(x, "POST", "/morrow/checkout", { priceKey: PRICE });
    const xIntents = intents(x);
    check(
      "G_an_expired_session_closes_its_intent_and_a_new_checkout_works",
      xFirst.status === 201 &&
        expiredStatus === 200 &&
        xIntents.find((i) => i.id === xIntent.id)?.status === "expired" &&
        xAgain.status === 201 &&
        xAgain.body.operationId !== xFirst.body.operationId &&
        xIntents.filter((i) => i.status === "open").length === 1 &&
        fake.state.sessions.get(xIntents.find((i) => i.status === "open").stripe_session_id)
          ?.customer === fake.state.sessions.get(xIntent.stripe_session_id)?.customer,
    );
    // G7. Only the fake Stripe origin was called, always with the broker's key.
    check(
      "G_zero_unexpected_outbound_requests",
      fake.requests.length > 0 &&
        fake.requests.every(
          (r) =>
            r.authorised &&
            /^\/v1\/(customers|checkout\/sessions|billing_portal\/sessions|invoices|subscriptions)(\/|$)/.test(
              r.path,
            ),
        ),
    );
  },
  { stopBefore: firstBilling.sequence },
);

const report = {
  lab: "billing",
  generated_at: new Date().toISOString(),
  elapsed_seconds: Math.round((Date.now() - started) / 1000),
  checks: checks.length,
  failures,
  results: checks,
};
writeArtifact("labs/billing.json", report);
console.log(JSON.stringify({ lab: "billing", checks: checks.length, failures: failures.length }));
if (failures.length) process.exit(1);
