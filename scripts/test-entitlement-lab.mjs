// lab:test-entitlement (pg-http): the staging test entitlement (owner decision (b),
// 2026-10-21; the ADR-0022 item 5 amendment; card E13; migrations 0034-0035) on an isolated,
// network-none PostgreSQL 17 engine with the whole manifest, applied by a Neon-shaped
// non-superuser CREATEROLE administrator (ADR-0020, the hosted shape). The runner's own
// code (scripts/staging-runner.mjs) seeds the staging mark and staging's published terms
// and grants the entitlement through the D4 SET-row protocol over a psql connector; the
// real billing HTTP handler reads the result as the deployed staging api does (Stripe
// switch off: no broker).
//   S  the mark: refused before it, refused in a database marked development, the operator
//      terms entry refused in one marked production; the seed writes it once, idempotent,
//      immutable.
//   R  refusals: every runtime login and role, the superuser without the owner role, a
//      work session context, a reused approval, a fixed route, a Stripe customer, a
//      Stripe receipt, a missing route row, a store association (an installation that is
//      or was linked; one never linked is not one); forged operator keys on the route and
//      snapshot.
//   G  the grant: route, account, wallet, snapshot and grant record in one commit; replay
//      writes nothing; no receipt, payment event or payment credit grant anywhere; the
//      wallet's sum is the grant's units and only moves keep it.
//   L  the route admits linking; the billing view reads the beta plan, 300 credits and the
//      period, offers no purchase, and a production reader refuses the test route.
//   V  v1 PR 1 (ADR-0035 items 2 to 4): the runner's registerShopifyApp registers the
//      owner's app with the live-store mark and stores its sealed client secret at the
//      app's next version (a rerun replays the registration and rotates the secret); a
//      second live-store app is refused and stores nothing; under the standing approval the
//      entitlement goes only to the workspace the live-store app invites. No statement
//      carries the secret.
//   N  v1 build order PR 6 (migration staging-test-credits-renewal): the runner's
//      renewTestCredits renews the owner's grant once per 30-day period. Refused without the
//      staging mark, for a workspace the live-store app does not invite, for another
//      workspace's grant, in a session context and for every runtime login; within the
//      grant's period it writes nothing (current); after it (the fixture's clock moved back
//      by the superuser with triggers off), it writes the renewal record, tops the unspent
//      credits up to the grant's and never above them, and writes the next snapshot, with no
//      payment row; a second run in the period writes nothing; lapsed periods skip to the
//      one that contains the clock; the billing view reads the renewed period; no caller
//      value names the credits: they are the current terms' (R10), so a new staging terms
//      revision, published by the seed, changes the next renewal's credits and not the
//      current period's, and terms without the operator entry refuse (terms_missing);
//      forged successors, fundings and edits fail. The PR 6 security review's cases: each
//      context setting alone is denied and each malformed value is invalid in the function
//      itself (R3 c, d); an account that is not active and a Shopify-bound route are
//      route conflicts while a period is due, and an operator snapshot's successor needs
//      an active account (R3 a); a renewal record written by hand as the owner must be the
//      one the renewal would write now, so the reviewer's forged record and its funding
//      are refused (BILLING_RENEWAL_INVALID), and with that record guard switched off a
//      funding still needs the room below the current terms' credits
//      (BILLING_WALLET_INVALID) (R1).
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  fixtureGrant,
  grantInsert,
  literal,
  withWorkDatabase,
  workFixtureOrigin,
} from "../tests/tenant-conformance/harness.mjs";
import { repositoryRoot, writeArtifact } from "./artifacts.mjs";
import { stagingBillingTermsRows } from "./staging.mjs";
import {
  billingTermsSeedRows,
  grantTestEntitlement,
  registerShopifyApp,
  renewTestCredits,
  seedBillingTerms,
} from "./staging-runner.mjs";
import { checkEnvelope, sealAppSecretWithKek } from "./vault.mjs";
import { psqlConnector } from "./fixtures/staging-psql-connection.mjs";
import {
  administrator as neonAdministrator,
  morrowSetRows,
} from "./fixtures/createrole-administrator.mjs";
import { labBinding } from "../tests/fixtures/staging-fakes.mjs";
import { createBillingApiHandler } from "../packages/work/src/billing/index.ts";
import { parseTermsDocument, termsDocumentDigest } from "../packages/work/src/billing/terms.ts";

const checks = [];
const failures = [];
function check(name, passed) {
  checks.push({ name, passed: passed === true });
  if (passed !== true) failures.push(name);
  console.log(JSON.stringify({ check: name, passed: passed === true }));
}
const started = Date.now();
const lit = literal;
const administrator = Object.freeze({ name: neonAdministrator, mode: "createrole" });
const evidence = (slug) =>
  ["docs/evidence/live/2026-10-22-neon-test-entitlement-" + slug, "md"].join(".");
const approval = (n) => `staging-card-1.e13.2026-10-22.${n}`;
const rejection = (promise) =>
  promise.then(
    () => null,
    (error) => error,
  );

await withWorkDatabase(
  "M5.test-entitlement",
  async (db) => {
    const scalar = (text) => db.sql(text).split("\n").at(-1);
    const runner = () => psqlConnector(db.id, { user: neonAdministrator, database: "morrow" });
    const grant = (input) =>
      grantTestEntitlement({
        connect: runner().connect,
        binding: labBinding,
        administrator,
        input,
      });
    const seed = async () =>
      seedBillingTerms({
        connect: runner().connect,
        binding: labBinding,
        administrator,
        rows: await stagingBillingTermsRows(repositoryRoot, "staging"),
      });
    const callSql = (input) =>
      `SELECT outcome FROM morrow_billing.operator_test_entitlement_grant(${lit(input.operatorId)},${lit(input.workspaceId)},${lit(input.approvalRef)},${lit(input.evidenceRef)});`;
    // The renewal's operator function called directly (N cases).
    const renewSql = (input) =>
      `SELECT outcome FROM morrow_billing.operator_test_entitlement_renew(${[
        input.operatorId,
        input.workspaceId,
        input.grantApprovalRef,
        input.standingApproval,
        input.evidenceRef,
      ]
        .map(lit)
        .join(",")});`;
    const standingEvidence = ["docs/evidence/live/2026-10-23-standing-approval", "md"].join(".");
    const renewInput = (p, grantApprovalRef) => ({
      operatorId: "operator_lab",
      workspaceId: p.workspace,
      grantApprovalRef,
      standingApproval: "adr-0035",
      evidenceRef: standingEvidence,
    });
    const counts = () =>
      db.rows(`SELECT
 (SELECT count(*) FROM morrow_billing.billing_accounts)::int AS accounts,
 (SELECT count(*) FROM morrow_billing.credit_wallets)::int AS wallets,
 (SELECT count(*) FROM morrow_billing.entitlement_snapshots)::int AS snapshots,
 (SELECT count(*) FROM morrow_billing.operator_test_entitlements)::int AS grants,
 (SELECT count(*) FROM morrow_billing.workspace_billing_routes WHERE route IS NOT NULL)::int AS fixed,
 (SELECT count(*) FROM morrow_billing.verified_payment_events)::int AS payments,
 (SELECT count(*) FROM morrow_billing.credit_grants)::int AS payment_grants,
 (SELECT count(*) FROM morrow_billing.stripe_event_receipts)::int AS receipts,
 (SELECT count(*) FROM morrow_billing.receipt_applications)::int AS applications`)[0];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // Tenants: one owner each with the billing view grant and a website route row (the
    // signup's), except D, which has no route row.
    const tenant = (key, { route = true } = {}) => {
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
${grantInsert(p, fixtureGrant(p, "governance.billing.manage", ["view", "execute"], ["action", "priceKey"]))}`);
      if (route)
        db.workOwner(
          // route_guard (0020) requires updated_at = created_at on insert: one clock reading.
          `INSERT INTO morrow_billing.workspace_billing_routes SELECT ${lit(p.org)},${lit(p.workspace)},'website',NULL,NULL,NULL,NULL,NULL,1,stamp,stamp FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS stamp) clock;`,
        );
      return p;
    };
    const A = tenant("te_a");
    const B = tenant("te_b");
    const C = tenant("te_c");
    const D = tenant("te_d", { route: false });
    const E = tenant("te_e");
    const F = tenant("te_f");
    const input = (p, n, slug = p.key.replace("_", "-"), operator = "operator_lab") => ({
      operatorId: operator,
      workspaceId: p.workspace,
      approvalRef: approval(n),
      evidenceRef: evidence(slug),
    });
    // A store installation through M2 PR-2's identity tables (identity-owner fixtures, as
    // lab:billing's): the app registry row, the installation (born unlinked, as
    // shopify_preserve_record requires) and, with `link`, the 0005 candidate and link and
    // the installation's unlinked -> linked change. morrow_identity.work_store_installations
    // reads exactly these rows; an association is an installation that is or was linked.
    // The linking rule never links into an unfixed route, so the linked fixture stands for
    // any path that might: the operator function must refuse it like every route fix.
    const installStore = (p, key, shopId, { link }) => {
      const app = "lab-" + key.replaceAll("_", "-");
      const shop = app + ".myshopify.com";
      const installation = "installation_" + key;
      const at = "date_trunc('milliseconds',clock_timestamp())";
      db.admin(`INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at)
 VALUES(${lit(app)},md5(${lit(key)}),'development',encode(sha256(convert_to(${lit(shop)},'UTF8')),'hex'),${lit(p.org)},${lit(p.workspace)},'read_products,write_products','2026-10',${lit("https://" + shop + "/admin/oauth/install_custom_app")},'active',1,${at},NULL);
INSERT INTO morrow_identity.store_installations(organization_id,workspace_id,id,app_key,shop_id,shop_domain,store_id,connection_id,generation,status,granted_scopes,credential_id,credential_version,development_store,link_id,revision,created_at,updated_at,reauthorised_at,linked_at)
 SELECT ${lit(p.org)},${lit(p.workspace)},${lit(installation)},${lit(app)},${lit(shopId)},${lit(shop)},${lit("store_" + key)},${lit("connection_" + key)},1,'unlinked',ARRAY['read_products','write_products'],${lit("credential_" + key)},1,true,NULL,1,t,t,NULL,NULL FROM (SELECT ${at} AS t) x;`);
      if (!link) return installation;
      db.admin(`INSERT INTO morrow_identity.linking_candidates VALUES(${lit("candidate_" + key)},'shopify','synthetic_app','synthetic_env',${lit(shopId)},${lit(shop)},${lit(installation)},1,true,1,'controlled_fixture',${lit("proof_" + key)},1,repeat('a',64),${lit(p.principal)},clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 minute',NULL);
INSERT INTO morrow_identity.workspace_store_links VALUES(${lit("link_" + key)},${lit("candidate_" + key)},${lit(p.org)},${lit(p.workspace)},${lit(installation)},1,1,${lit(p.principal)},clock_timestamp());
UPDATE morrow_identity.store_installations SET status='linked',link_id=${lit("link_" + key)},linked_at=greatest(${at},created_at),updated_at=greatest(${at},created_at),revision=revision+1 WHERE id=${lit(installation)};`);
      return installation;
    };
    const linkRoute = (p) =>
      scalar(
        `SET ROLE morrow_identity_owner; SELECT morrow_billing.link_route_current(${lit(p.org)},${lit(p.workspace)});`,
      );

    // -------------------------------------------------------------------------------
    // S. The staging mark.
    const empty = counts();
    const unmarked = await rejection(grant(input(A, 1)));
    check(
      "S_refused_in_a_database_without_the_staging_mark",
      unmarked?.code === "STAGING_TEST_ENTITLEMENT_REFUSED" &&
        unmarked.details.outcome === "not_staging" &&
        same(counts(), empty) &&
        morrowSetRows(db.id) === 0,
    );
    const unmarkedRenewal = db.tryRun(
      `SET ROLE morrow_work_owner; ${renewSql(renewInput(A, approval(1)))}`,
    );
    check(
      "S_a_renewal_is_refused_in_a_database_without_the_staging_mark",
      unmarkedRenewal.ok &&
        unmarkedRenewal.stdout.split("\n").at(-1) === "not_staging" &&
        same(counts(), empty),
    );
    const development = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; INSERT INTO morrow_billing.platform_environment VALUES(true,'development',date_trunc('milliseconds',clock_timestamp())); ${callSql(input(A, 1))} ROLLBACK;`,
    );
    check(
      "S_refused_in_a_database_marked_development",
      development.ok &&
        development.stdout.split("\n").at(-1) === "not_staging" &&
        scalar("SELECT count(*) FROM morrow_billing.platform_environment;") === "0",
    );
    const operatorTerms = (await stagingBillingTermsRows(repositoryRoot, "staging"))[0];
    const production = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; INSERT INTO morrow_billing.platform_environment VALUES(true,'production',date_trunc('milliseconds',clock_timestamp()));
INSERT INTO morrow_billing.billing_terms VALUES(1,${lit(operatorTerms[1])}::jsonb,${lit(operatorTerms[2])}::jsonb,${lit(operatorTerms[3])},date_trunc('milliseconds',clock_timestamp())); ROLLBACK;`,
    );
    check(
      "S_operator_terms_entry_refused_in_a_database_marked_production",
      !production.ok &&
        /BILLING_TERMS_INVALID/.test(production.stderr) &&
        scalar("SELECT count(*) FROM morrow_billing.billing_terms;") === "0",
    );
    const seeded = await seed();
    const reseeded = await seed();
    check(
      "S_seed_writes_the_staging_mark_once_with_staging_terms_revision_1",
      seeded.environmentMark === "inserted" &&
        seeded.environment === "staging" &&
        seeded.termsInserted === 1 &&
        reseeded.environmentMark === "present" &&
        reseeded.termsInserted === 0 &&
        scalar(
          "SELECT environment||'|'||(SELECT count(*) FROM morrow_billing.billing_terms) FROM morrow_billing.platform_environment;",
        ) === "staging|1" &&
        morrowSetRows(db.id) === 0,
    );
    const developmentTerms = (await stagingBillingTermsRows(repositoryRoot, "development"))[0];
    const unoffered = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; INSERT INTO morrow_billing.billing_terms VALUES(2,${lit(developmentTerms[1].replace('"termsRevision":1', '"termsRevision":2'))}::jsonb,'[]'::jsonb,repeat('f',64),date_trunc('milliseconds',clock_timestamp())); ROLLBACK;`,
    );
    check(
      "S_a_priced_terms_revision_without_an_offer_is_refused",
      !unoffered.ok && /BILLING_TERMS_INVALID/.test(unoffered.stderr),
    );
    check(
      "S_the_mark_is_immutable",
      !db.tryRun(
        "SET ROLE morrow_work_owner; UPDATE morrow_billing.platform_environment SET environment='production';",
      ).ok &&
        !db.tryRun("SET ROLE morrow_work_owner; DELETE FROM morrow_billing.platform_environment;")
          .ok &&
        !db.tryRun(
          "SET ROLE morrow_work_owner; INSERT INTO morrow_billing.platform_environment VALUES(true,'production',date_trunc('milliseconds',clock_timestamp()));",
        ).ok &&
        scalar("SELECT environment FROM morrow_billing.platform_environment;") === "staging",
    );

    // -------------------------------------------------------------------------------
    // R. Refusals before the grant.
    const logins = db
      .rows(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolcanlogin AND rolname IN ('morrow_api_worker','morrow_vault_broker','morrow_runtime_executor','morrow_connector_ingress') ORDER BY rolname",
      )
      .map((r) => r.rolname);
    const attempts = logins.map((user) => db.tryRun(callSql(input(A, 1)), { user }));
    const roles = ["morrow_work_command", "morrow_work_api", "morrow_identity_owner"].map((role) =>
      db.tryRun(`SET ROLE ${role}; ${callSql(input(A, 1))}`),
    );
    check(
      "R_every_runtime_login_and_role_is_refused_before_the_function_runs",
      logins.includes("morrow_api_worker") &&
        [...attempts, ...roles].every((r) => !r.ok && /permission denied/.test(r.stderr)) &&
        same(counts(), empty),
    );
    const superuser = db.tryRun(callSql(input(A, 1)));
    const sessionContext = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; SELECT set_config('morrow.work_session_digest',repeat('a',64),true); ${callSql(input(A, 1))} ROLLBACK;`,
    );
    check(
      "R_the_superuser_without_the_owner_role_and_any_session_context_are_denied",
      superuser.ok &&
        superuser.stdout.split("\n").at(-1) === "denied" &&
        sessionContext.ok &&
        sessionContext.stdout.split("\n").at(-1) === "denied" &&
        same(counts(), empty),
    );
    // B has a Stripe customer (a planned customer operation and its mapping); C's route was
    // fixed by a Stripe payment (an owner fixture); E has a recorded Stripe receipt.
    const operationB = randomUUID();
    db.workOwner(`INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,task_id,store_id,connection_id,target_index,
 target_resource_id,proposal_id,proposal_digest,approval_id,approval_revision,approval_digest,claim_family_root_id,lease_id,status,request_digest,attempt,
 send_started_at,submitted_at,provider_request_id,uncertainty_reason,created_at,updated_at)
 SELECT ${lit(B.org)},${lit(B.workspace)},${lit(operationB)},1,'stripe_write','governance.billing.manage',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  'planned',repeat('d',64),0,NULL,NULL,NULL,NULL,t,t FROM (SELECT date_trunc('milliseconds',clock_timestamp()) t) x;
INSERT INTO morrow_billing.stripe_customers VALUES(${lit(B.org)},${lit(B.workspace)},'cus_LabTestEntitlementB','test',${lit(operationB)},date_trunc('milliseconds',clock_timestamp()));
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=greatest(date_trunc('milliseconds',clock_timestamp()),created_at),fixing_payment_key='stripe:invoice:in_LabTestEntitlementC',revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(C.workspace)};
INSERT INTO morrow_billing.stripe_event_receipts(organization_id,workspace_id,id,event_id,event_type,livemode,mode,object_type,object_id,customer_id,object,object_digest,observed_at,recorded_at)
 SELECT ${lit(E.org)},${lit(E.workspace)},gen_random_uuid()::text,'evt_LabTestEntitlementE','invoice.payment_failed',false,'test','invoice','in_LabTestEntitlementE','cus_LabTestEntitlementE',
  '{"kind":"invoice","id":"in_LabTestEntitlementE","livemode":false}'::jsonb,repeat('e',64),t,t FROM (SELECT date_trunc('milliseconds',clock_timestamp()) t) x;`);
    const before = counts();
    const refusals = {
      stripeCustomer: await rejection(grant(input(B, 2))),
      stripeRoute: await rejection(grant(input(C, 3))),
      stripeReceipt: await rejection(grant(input(E, 4))),
      noRoute: await rejection(grant(input(D, 5))),
    };
    check(
      "R_a_stripe_customer_a_fixed_route_a_receipt_and_no_route_row_are_refused",
      refusals.stripeCustomer?.details?.outcome === "stripe_conflict" &&
        refusals.stripeRoute?.details?.outcome === "route_conflict" &&
        refusals.stripeReceipt?.details?.outcome === "stripe_conflict" &&
        refusals.noRoute?.details?.outcome === "route_missing" &&
        Object.values(refusals).every((e) => e?.code === "STAGING_TEST_ENTITLEMENT_REFUSED") &&
        same(counts(), before) &&
        morrowSetRows(db.id) === 0,
    );
    // F has a linked store (an association) on its unfixed website route; A has an
    // installation that was never linked, which is no association and does not block
    // its grant below.
    installStore(F, "te_f_linked", "3001", { link: true });
    installStore(A, "te_a_unlinked", "3002", { link: false });
    // The work owner reads the associations through M2 PR-2's bridge (0034's grant); the
    // runtime logins and the api role still cannot.
    const associations = (p) => {
      const r = db.tryRun(
        `SET ROLE morrow_work_owner; SELECT count(*) FILTER (WHERE linked_at IS NOT NULL)||'/'||count(*) FROM morrow_identity.work_store_installations(${lit(p.org)},${lit(p.workspace)});`,
      );
      return r.ok ? r.stdout.split("\n").at(-1) : "error";
    };
    const bridgeSql = `SELECT count(*) FROM morrow_identity.work_store_installations(${lit(F.org)},${lit(F.workspace)});`;
    const readers = [
      ...logins.map((user) => db.tryRun(bridgeSql, { user })),
      db.tryRun("SET ROLE morrow_work_api; " + bridgeSql),
    ];
    const linkedStore = await rejection(grant(input(F, 7)));
    check(
      "R_a_store_association_is_refused_and_an_installation_never_linked_is_not_one",
      linkedStore?.code === "STAGING_TEST_ENTITLEMENT_REFUSED" &&
        linkedStore.details.outcome === "route_conflict" &&
        associations(F) === "1/1" &&
        associations(A) === "0/1" &&
        readers.every((r) => !r.ok && /permission denied/.test(r.stderr)) &&
        linkRoute(F) === "unfixed" &&
        same(counts(), before) &&
        morrowSetRows(db.id) === 0,
    );
    const forgedKey = "morrow:operator_entitlement:" + randomUUID();
    const forgedRoute = db.tryRun(
      `SET ROLE morrow_work_owner; UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=greatest(date_trunc('milliseconds',clock_timestamp()),created_at),fixing_payment_key=${lit(forgedKey)},revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(A.workspace)};`,
    );
    const liveKey = db.tryRun(
      `SET ROLE morrow_work_owner; UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='live',route_fixed_at=greatest(date_trunc('milliseconds',clock_timestamp()),created_at),fixing_payment_key=${lit(forgedKey)},revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(A.workspace)};`,
    );
    check(
      "R_a_route_fix_naming_no_grant_or_in_live_mode_is_refused",
      !forgedRoute.ok &&
        /BILLING_ROUTE_FIX_DENIED/.test(forgedRoute.stderr) &&
        !liveKey.ok &&
        /workspace_billing_routes_variant|BILLING_ROUTE_FIX_DENIED/.test(liveKey.stderr) &&
        linkRoute(A) === "unfixed",
    );

    // -------------------------------------------------------------------------------
    // G. The grant.
    const first = await grant(input(A, 1));
    const after = counts();
    const facts =
      db.rows(`SELECT r.route,r.mode,r.fixing_payment_key,r.revision::text AS route_revision,
 a.id::text AS account,a.route AS account_route,a.mode AS account_mode,a.currency,a.status AS account_status,
 w.available::text AS available,w.reserved::text AS reserved,w.consumed::text AS consumed,w.revision::text AS wallet_revision,w.terms_revision::text AS wallet_terms,
 s.revision::text AS snapshot_revision,s.subscription_key,s.status AS snapshot_status,s.receipt_id::text AS receipt_id,s.provider_evidence_ref::text AS evidence_ref,
 morrow_work.utc_text(s.verified_at) AS verified_at,morrow_work.utc_text(s.valid_until) AS valid_until,
 g.id::text AS grant_id,g.approval_ref,g.operator_id,g.evidence_ref AS record,g.credit_units::text AS units,g.terms_revision::text AS grant_terms,
 g.evidence_digest::text AS grant_digest,g.funded_wallet_revision::text AS funded
 FROM morrow_billing.workspace_billing_routes r
 JOIN morrow_billing.billing_accounts a ON a.organization_id=r.organization_id AND a.workspace_id=r.workspace_id
 JOIN morrow_billing.credit_wallets w ON w.organization_id=a.organization_id AND w.workspace_id=a.workspace_id AND w.billing_account_id=a.id
 JOIN morrow_billing.entitlement_snapshots s ON s.organization_id=a.organization_id AND s.workspace_id=a.workspace_id AND s.billing_account_id=a.id
 JOIN morrow_billing.operator_test_entitlements g ON g.organization_id=a.organization_id AND g.workspace_id=a.workspace_id AND g.billing_account_id=a.id
 WHERE r.workspace_id=${lit(A.workspace)}`);
    const f = facts[0] ?? {};
    const key = "morrow:operator_entitlement:" + first.entitlementId;
    check(
      "G_the_grant_fixes_the_route_and_writes_account_wallet_snapshot_and_grant_in_one_commit",
      first.outcome === "granted" &&
        first.workspaceId === A.workspace &&
        first.organizationId === A.org &&
        first.creditUnits === "300" &&
        first.termsRevision === "1" &&
        first.routeRevision === "2" &&
        Date.parse(first.periodEnd) - Date.parse(first.periodStart) === 30 * 86400000 &&
        facts.length === 1 &&
        f.route === "morrow_direct" &&
        f.mode === "test" &&
        f.fixing_payment_key === key &&
        f.route_revision === "2" &&
        f.account === first.billingAccountId &&
        f.account_route === "morrow_direct" &&
        f.account_mode === "test" &&
        f.currency === "USD" &&
        f.account_status === "active" &&
        f.available === "300" &&
        f.reserved === "0" &&
        f.consumed === "0" &&
        f.wallet_revision === "2" &&
        f.wallet_terms === "1" &&
        f.snapshot_revision === "1" &&
        f.subscription_key === key &&
        f.snapshot_status === "active" &&
        f.receipt_id === null &&
        f.evidence_ref === f.grant_digest &&
        f.verified_at === first.periodStart &&
        f.valid_until === first.periodEnd &&
        f.grant_id === first.entitlementId &&
        f.approval_ref === approval(1) &&
        f.operator_id === "operator_lab" &&
        f.record === evidence("te-a") &&
        f.units === "300" &&
        f.grant_terms === "1" &&
        f.funded === "2" &&
        after.accounts === before.accounts + 1 &&
        after.grants === before.grants + 1 &&
        after.fixed === before.fixed + 1 &&
        morrowSetRows(db.id) === 0,
    );
    check(
      "G_no_receipt_payment_event_or_payment_credit_grant_is_written",
      after.payments === 0 &&
        after.payment_grants === 0 &&
        after.receipts === before.receipts &&
        after.applications === 0 &&
        scalar(
          `SELECT count(*) FROM morrow_billing.stripe_customers WHERE workspace_id=${lit(A.workspace)};`,
        ) === "0",
    );
    const replay = await grant(input(A, 1));
    check(
      "G_the_same_approval_replays_the_same_result_and_writes_nothing",
      replay.outcome === "replayed" &&
        same({ ...replay, outcome: "granted" }, first) &&
        same(counts(), after) &&
        morrowSetRows(db.id) === 0,
    );
    const reused = {
      otherWorkspace: await rejection(grant({ ...input(E, 1), approvalRef: approval(1) })),
      otherRecord: await rejection(grant({ ...input(A, 1), evidenceRef: evidence("other") })),
      otherOperator: await rejection(grant(input(A, 1, "te-a", "operator_other"))),
      newApproval: await rejection(grant(input(A, 6))),
    };
    check(
      "G_a_reused_approval_conflicts_and_a_new_approval_for_the_workspace_is_refused",
      reused.otherWorkspace?.details?.outcome === "approval_conflict" &&
        reused.otherRecord?.details?.outcome === "approval_conflict" &&
        reused.otherOperator?.details?.outcome === "approval_conflict" &&
        reused.newApproval?.details?.outcome === "route_conflict" &&
        same(counts(), after),
    );
    // The wallet: its sum is the grant's units; a move keeps it (M3 PR-1's reservations);
    // nothing raises it without a funding grant, and the grant funds one revision only.
    const sum = () =>
      scalar(
        `SELECT (available+reserved+consumed)::text||'|'||revision FROM morrow_billing.credit_wallets WHERE workspace_id=${lit(A.workspace)};`,
      );
    const wallet = (set) =>
      db.tryRun(
        `SET ROLE morrow_work_owner; UPDATE morrow_billing.credit_wallets SET ${set},revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(A.workspace)};`,
      );
    const sumAfterGrant = sum();
    const moved = wallet("available=available-5,reserved=reserved+5");
    const sumAfterMove = sum();
    const raised = wallet("available=available+1");
    const regranted = wallet("available=available+300");
    check(
      "G_the_wallet_sum_is_the_grant_and_only_moves_keep_it",
      sumAfterGrant === "300|2" &&
        moved.ok &&
        sumAfterMove === "300|3" &&
        !raised.ok &&
        /BILLING_WALLET_INVALID/.test(raised.stderr) &&
        !regranted.ok &&
        /BILLING_WALLET_INVALID/.test(regranted.stderr) &&
        sum() === "300|3",
    );
    const forgedSnapshot = db.tryRun(
      `SET ROLE morrow_work_owner; INSERT INTO morrow_billing.entitlement_snapshots(organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,provider_evidence_ref,verified_at,valid_until,receipt_id,recorded_at)
 SELECT organization_id,workspace_id,billing_account_id,2,'morrow_direct','test',subscription_key,'active',provider_evidence_ref,verified_at,valid_until+interval '30 days',NULL,recorded_at FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(A.workspace)};`,
    );
    check(
      "G_an_operator_snapshot_takes_no_successor_and_cannot_be_extended",
      !forgedSnapshot.ok &&
        /BILLING_SNAPSHOT_INVALID/.test(forgedSnapshot.stderr) &&
        !db.tryRun(
          `SET ROLE morrow_work_owner; UPDATE morrow_billing.operator_test_entitlements SET period_end=period_end+interval '30 days' WHERE workspace_id=${lit(A.workspace)};`,
        ).ok &&
        scalar(
          `SELECT count(*) FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(A.workspace)};`,
        ) === "1",
    );

    // -------------------------------------------------------------------------------
    // L. Linking and the billing view.
    check(
      "L_the_route_then_admits_linking",
      linkRoute(A) === "morrow_direct" && linkRoute(E) === "unfixed",
    );
    const handler = (environment) =>
      createBillingApiHandler({
        origin: workFixtureOrigin,
        connector: db.connector(),
        environment,
        broker: null,
        now: () => Date.now(),
      });
    const view = async (p, environment, path = "") => {
      const response = await handler(environment).fetch(
        new Request(workFixtureOrigin + "/workspace/" + p.workspace + "/billing" + path, {
          method: "GET",
          headers: {
            Cookie: "__Host-morrow_session=" + p.secret,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
          },
        }),
        {},
        { waitUntil() {} },
      );
      return { status: response.status, body: await response.json() };
    };
    const staged = await view(A, "staging");
    const plans = await view(A, "staging", "/morrow/plans");
    check(
      "L_the_staging_billing_view_reads_the_beta_plan_credits_and_period",
      staged.status === 200 &&
        staged.body.phase === "morrow_direct" &&
        staged.body.state === "billable" &&
        staged.body.plan?.status === "active" &&
        staged.body.plan?.validUntil === first.periodEnd &&
        same(staged.body.credits, { available: "295", reserved: "5", consumed: "0" }) &&
        same(staged.body.billingPeriod, { start: first.periodStart, end: first.periodEnd }) &&
        staged.body.checkout === null &&
        plans.status === 200 &&
        plans.body.termsRevision === 1 &&
        same(plans.body.offers, []) &&
        same(plans.body.actions, { subscribe: false, billingPortal: false }),
    );
    const produced = await view(A, "production");
    check(
      "L_a_production_reader_refuses_the_test_route",
      produced.status === 200 &&
        produced.body.phase === "morrow_direct" &&
        produced.body.state === "not_billable",
    );

    // -------------------------------------------------------------------------------
    // V. The owner's live-store app (v1 PR 1; ADR-0035 items 2 to 4).
    const V = tenant("te_v");
    const W = tenant("te_w");
    const labKek = randomBytes(32).toString("hex");
    const labSecret = "shpss_" + randomBytes(16).toString("hex");
    const liveShop = "lab-owner-live.myshopify.com";
    const liveInput = (p, key, shop) => ({
      appKey: key,
      clientId: randomBytes(16).toString("hex"),
      shopDigest: createHash("sha256").update(shop).digest("hex"),
      workspaceId: p.workspace,
      installUrl: `https://admin.shopify.com/oauth/install_custom_app?client_id=${key}&signature=lab`,
    });
    const owned = liveInput(V, "lab-owner-live", liveShop);
    const sealWith = (appKey) => async (version) =>
      sealAppSecretWithKek(
        { environment: "staging", "app-key": appKey, version: String(version), "kek-version": "1" },
        labSecret,
        () => labKek,
      );
    const registered = [];
    const registerLive = async (input) => {
      const connector = runner();
      registered.push(connector);
      return registerShopifyApp({
        connect: connector.connect,
        binding: labBinding,
        administrator,
        input,
        seal: sealWith(input.appKey),
      });
    };
    const standingGrant = (p, n) =>
      grantTestEntitlement({
        connect: runner().connect,
        binding: labBinding,
        administrator,
        input: {
          operatorId: "operator_lab",
          workspaceId: p.workspace,
          approvalRef: `adr-0035.e13.2026-10-23.${n}`,
          evidenceRef: ["docs/evidence/live/2026-10-23-standing-approval", "md"].join("."),
        },
        requireLiveStoreWorkspace: true,
      });
    const secrets = (key) =>
      db.rows(
        `SELECT version::int AS version,status,wrapped_key IS NULL AS erased,encode(wrapped_key,'hex') AS wrapped,encode(sealed_value,'hex') AS sealed FROM morrow_vault.app_secrets WHERE app_key=${lit(key)} ORDER BY version`,
      );
    const apps = () =>
      db.rows(
        `SELECT app_key,live_store,status,invited_workspace_id::text AS ws,intended_shop_digest AS digest FROM morrow_identity.shopify_apps WHERE live_store ORDER BY app_key`,
      );
    const beforeLive = counts();
    const early = await rejection(standingGrant(V, 1));
    check(
      "V_the_standing_entitlement_refuses_the_workspace_before_its_live_store_app_exists",
      early?.code === "STAGING_TEST_ENTITLEMENT_NOT_OWNER_WORKSPACE" &&
        same(counts(), beforeLive) &&
        morrowSetRows(db.id) === 0,
    );
    const firstLive = await registerLive(owned);
    const [secret1] = secrets(owned.appKey);
    const opens = async (row) =>
      checkEnvelope(
        {
          environment: "staging",
          appKey: owned.appKey,
          version: row.version,
          kekVersion: 1,
          wrappedKeyHex: row.wrapped,
          sealedValueHex: row.sealed,
        },
        labKek,
      ).then(
        () => true,
        () => false,
      );
    check(
      "V_registration_writes_the_marked_app_and_its_sealed_secret_at_version_1",
      firstLive.registration === "registered" &&
        firstLive.secretVersion === "1" &&
        firstLive.organizationId === V.org &&
        same(apps(), [
          {
            app_key: owned.appKey,
            live_store: true,
            status: "active",
            ws: V.workspace,
            digest: owned.shopDigest,
          },
        ]) &&
        secret1?.version === 1 &&
        secret1.status === "active" &&
        (await opens(secret1)) &&
        morrowSetRows(db.id) === 0,
    );
    const again = await registerLive(owned);
    const rotated = secrets(owned.appKey);
    check(
      "V_a_rerun_replays_the_registration_and_rotates_the_secret_to_the_next_version",
      again.registration === "already_registered" &&
        again.secretVersion === "2" &&
        rotated.length === 2 &&
        rotated[0].status === "retired" &&
        rotated[0].erased === true &&
        rotated[1].status === "active" &&
        (await opens(rotated[1])) &&
        apps().length === 1,
    );
    const second = liveInput(W, "lab-other-live", "lab-other-live.myshopify.com");
    const refused = await rejection(registerLive(second));
    check(
      "V_a_second_live_store_app_is_refused_and_stores_nothing",
      refused?.code === "STAGING_SHOPIFY_APP_REFUSED" &&
        refused.details?.outcome === "live_store_taken" &&
        apps().length === 1 &&
        secrets(second.appKey).length === 0 &&
        morrowSetRows(db.id) === 0,
    );
    const other = await rejection(standingGrant(W, 2));
    const granted = await standingGrant(V, 3);
    check(
      "V_the_standing_entitlement_goes_only_to_the_live_store_apps_workspace",
      other?.code === "STAGING_TEST_ENTITLEMENT_NOT_OWNER_WORKSPACE" &&
        granted.outcome === "granted" &&
        granted.workspaceId === V.workspace &&
        granted.creditUnits === "300" &&
        linkRoute(V) === "morrow_direct" &&
        linkRoute(W) === "unfixed" &&
        morrowSetRows(db.id) === 0,
    );
    const statements = registered.flatMap((connector) => connector.statements).join("\n");
    check(
      "V_no_statement_carries_the_secret_the_kek_or_the_shop",
      statements.includes("app_secret_put") &&
        !statements.includes(labSecret) &&
        !statements.includes(Buffer.from(labSecret).toString("hex")) &&
        !statements.includes(labKek) &&
        !statements.includes(liveShop),
    );

    // -------------------------------------------------------------------------------
    // N. Renewing the owner's test credits (v1 build order PR 6).
    const ownerGrant = "adr-0035.e13.2026-10-23.3";
    const renew = (p, grantApprovalRef) =>
      renewTestCredits({
        connect: runner().connect,
        binding: labBinding,
        administrator,
        input: renewInput(p, grantApprovalRef),
      });
    const renewals = () =>
      db.rows(
        `SELECT r.id::text AS id,r.entitlement_id::text AS entitlement,r.period_number::text AS period,r.standing_approval,r.operator_id,r.evidence_ref AS record,r.terms_revision::text AS terms,r.mode,
 r.credit_units::text AS units,r.added_units::text AS added,r.funded_wallet_revision::text AS funded,r.snapshot_revision::text AS snapshot,
 morrow_work.utc_text(r.period_start) AS period_start,morrow_work.utc_text(r.period_end) AS period_end,r.evidence_digest::text AS digest
 FROM morrow_billing.operator_test_entitlement_renewals r WHERE r.workspace_id=${lit(V.workspace)} ORDER BY r.period_number`,
      );
    const latestSnapshot = (p) =>
      db.rows(
        `SELECT revision::text AS revision,subscription_key,status,receipt_id::text AS receipt_id,provider_evidence_ref::text AS evidence,
 morrow_work.utc_text(verified_at) AS verified_at,morrow_work.utc_text(valid_until) AS valid_until
 FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(p.workspace)} ORDER BY revision DESC LIMIT 1`,
      )[0] ?? {};
    const walletOf = (p) =>
      db.rows(
        `SELECT available::text AS available,reserved::text AS reserved,consumed::text AS consumed,revision::text AS revision
 FROM morrow_billing.credit_wallets WHERE workspace_id=${lit(p.workspace)}`,
      )[0] ?? {};
    // The route, the account and the grant record a renewal never changes (the grant's
    // times move only with the fixture's clock below).
    const fixedRows = (p) =>
      scalar(
        `SELECT r.revision||'|'||r.fixing_payment_key||'|'||a.status||'|'||a.revision||'|'||g.credit_units||'|'||g.approval_ref||'|'||g.evidence_digest FROM morrow_billing.workspace_billing_routes r
 JOIN morrow_billing.billing_accounts a ON a.organization_id=r.organization_id AND a.workspace_id=r.workspace_id
 JOIN morrow_billing.operator_test_entitlements g ON g.organization_id=a.organization_id AND g.workspace_id=a.workspace_id
 WHERE r.workspace_id=${lit(p.workspace)};`,
      );
    // The fixture's clock: moves the workspace's grant, renewals and snapshots `hours`
    // into the past, as the superuser with triggers off (session_replication_role), so the
    // database's real clock lands in a later period. Every CHECK still holds.
    const travel = (p, hours) =>
      db.sql(`SET session_replication_role = replica;
UPDATE morrow_billing.operator_test_entitlements SET period_start=period_start-interval '${hours} hours',period_end=period_end-interval '${hours} hours',recorded_at=recorded_at-interval '${hours} hours' WHERE workspace_id=${lit(p.workspace)};
UPDATE morrow_billing.operator_test_entitlement_renewals SET period_start=period_start-interval '${hours} hours',period_end=period_end-interval '${hours} hours',recorded_at=recorded_at-interval '${hours} hours' WHERE workspace_id=${lit(p.workspace)};
UPDATE morrow_billing.entitlement_snapshots SET verified_at=verified_at-interval '${hours} hours',valid_until=valid_until-interval '${hours} hours',recorded_at=recorded_at-interval '${hours} hours' WHERE workspace_id=${lit(p.workspace)};
SET session_replication_role = origin;`);
    const paymentRows = () =>
      scalar(
        "SELECT (SELECT count(*) FROM morrow_billing.credit_grants)||'|'||(SELECT count(*) FROM morrow_billing.verified_payment_events)||'|'||(SELECT count(*) FROM morrow_billing.stripe_event_receipts)||'|'||(SELECT count(*) FROM morrow_billing.receipt_applications);",
      );
    const paymentsBefore = paymentRows();
    const beforeRenewals = counts();
    const fixedBefore = fixedRows(V);
    const notInvited = await rejection(renew(A, approval(1)));
    const otherGrant = await rejection(renew(V, approval(1)));
    const noGrant = await rejection(renew(V, "adr-0035.e13.2026-10-23.9"));
    check(
      "N_refused_for_a_workspace_the_live_store_app_does_not_invite_or_another_workspaces_grant",
      notInvited?.code === "STAGING_TEST_CREDITS_NOT_OWNER_WORKSPACE" &&
        otherGrant?.code === "STAGING_TEST_CREDITS_REFUSED" &&
        otherGrant.details.outcome === "grant_missing" &&
        noGrant?.code === "STAGING_TEST_CREDITS_REFUSED" &&
        noGrant.details.outcome === "grant_missing" &&
        renewals().length === 0 &&
        same(counts(), beforeRenewals) &&
        morrowSetRows(db.id) === 0,
    );
    const renewLogins = logins.map((user) =>
      db.tryRun(renewSql(renewInput(V, ownerGrant)), { user }),
    );
    const renewRoles = ["morrow_work_command", "morrow_work_api", "morrow_identity_owner"].map(
      (role) => db.tryRun(`SET ROLE ${role}; ${renewSql(renewInput(V, ownerGrant))}`),
    );
    const renewSession = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; SELECT set_config('morrow.work_workspace',${lit(V.workspace)},true); ${renewSql(renewInput(V, ownerGrant))} ROLLBACK;`,
    );
    const renewSuperuser = db.tryRun(renewSql(renewInput(V, ownerGrant)));
    check(
      "N_every_runtime_login_and_role_is_refused_and_a_session_context_or_the_superuser_is_denied",
      [...renewLogins, ...renewRoles].every((r) => !r.ok && /permission denied/.test(r.stderr)) &&
        renewSession.ok &&
        renewSession.stdout.split("\n").at(-1) === "denied" &&
        renewSuperuser.ok &&
        renewSuperuser.stdout.split("\n").at(-1) === "denied" &&
        renewals().length === 0,
    );
    // Review R3 (c): each of the four context settings alone is denied, not only the
    // workspace's (above).
    const contextSettings = [
      ["morrow.work_session_digest", "a".repeat(64)],
      ["morrow.work_lease_id", randomUUID()],
      ["morrow.billing_receipt_entered", "1"],
    ].map(([name, value]) =>
      db.tryRun(
        `SET ROLE morrow_work_owner; BEGIN; SELECT set_config(${lit(name)},${lit(value)},true); ${renewSql(renewInput(V, ownerGrant))} ROLLBACK;`,
      ),
    );
    check(
      "N_a_session_digest_lease_or_receipt_context_alone_is_denied",
      contextSettings.length === 3 &&
        contextSettings.every((r) => r.ok && r.stdout.split("\n").at(-1) === "denied") &&
        renewals().length === 0,
    );
    // Review R3 (d): the function's own grammar, called directly: each of the five values
    // malformed or absent is invalid, and nothing is written.
    const malformed = [
      { operatorId: "operator lab" },
      { operatorId: null },
      { workspaceId: "ws te_v" },
      { grantApprovalRef: "adr-0035.e13.2026-10-23" },
      { grantApprovalRef: ownerGrant + ".1" },
      { standingApproval: "ADR-0035" },
      { standingApproval: null },
      { evidenceRef: ["docs/evidence/live/standing-approval", "md"].join(".") },
      { evidenceRef: ["docs/evidence/other/2026-10-23-standing-approval", "md"].join(".") },
    ].map((change) =>
      db.tryRun(
        `SET ROLE morrow_work_owner; ${renewSql({ ...renewInput(V, ownerGrant), ...change })}`,
      ),
    );
    check(
      "N_a_malformed_or_absent_value_is_invalid_in_the_function_itself",
      malformed.every((r) => r.ok && r.stdout.split("\n").at(-1) === "invalid") &&
        renewals().length === 0,
    );
    const within = await renew(V, ownerGrant);
    check(
      "N_within_the_grants_period_it_reports_period_0_and_writes_nothing",
      within.outcome === "current" &&
        within.period === "0" &&
        within.renewalId === null &&
        within.entitlementId === granted.entitlementId &&
        within.periodStart === granted.periodStart &&
        within.periodEnd === granted.periodEnd &&
        within.creditUnits === "300" &&
        within.termsRevision === "1" &&
        within.snapshotRevision === "1" &&
        renewals().length === 0 &&
        same(counts(), beforeRenewals) &&
        morrowSetRows(db.id) === 0,
    );
    // The owner's workspace spends: 100 consumed and 20 held (moves that keep the sum).
    db.workOwner(
      `UPDATE morrow_billing.credit_wallets SET available=available-120,reserved=reserved+20,consumed=consumed+100,revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(V.workspace)};`,
    );
    const spent = walletOf(V);
    // The grant's period ended a day ago.
    travel(V, 744);
    const grantEnd = scalar(
      `SELECT morrow_work.utc_text(period_end) FROM morrow_billing.operator_test_entitlements WHERE workspace_id=${lit(V.workspace)};`,
    );
    const first1 = await renew(V, ownerGrant);
    const [r1] = renewals();
    const s1 = latestSnapshot(V);
    const w1 = walletOf(V);
    const hours720 = 720 * 3600000;
    check(
      "N_after_the_grants_period_it_renews_period_1_and_tops_the_unspent_credits_up_to_the_grant",
      spent.available === "180" &&
        spent.reserved === "20" &&
        spent.consumed === "100" &&
        first1.outcome === "renewed" &&
        first1.period === "1" &&
        first1.periodStart === grantEnd &&
        Date.parse(first1.periodEnd) - Date.parse(first1.periodStart) === hours720 &&
        Date.parse(first1.periodStart) <= Date.now() &&
        Date.now() < Date.parse(first1.periodEnd) &&
        first1.creditUnits === "300" &&
        first1.termsRevision === "1" &&
        first1.addedUnits === "100" &&
        first1.available === "280" &&
        first1.snapshotRevision === "2" &&
        first1.walletRevision === String(Number(spent.revision) + 1) &&
        r1?.id === first1.renewalId &&
        r1.entitlement === granted.entitlementId &&
        r1.period === "1" &&
        r1.standing_approval === "adr-0035" &&
        r1.operator_id === "operator_lab" &&
        r1.record === standingEvidence &&
        r1.terms === "1" &&
        r1.mode === "test" &&
        r1.units === "300" &&
        r1.added === "100" &&
        r1.funded === first1.walletRevision &&
        r1.snapshot === "2" &&
        r1.period_start === first1.periodStart &&
        r1.period_end === first1.periodEnd &&
        s1.revision === "2" &&
        s1.subscription_key === "morrow:operator_entitlement:" + granted.entitlementId &&
        s1.status === "active" &&
        s1.receipt_id === null &&
        s1.evidence === r1.digest &&
        s1.verified_at === first1.periodStart &&
        s1.valid_until === first1.periodEnd &&
        w1.available === "280" &&
        w1.reserved === "20" &&
        w1.consumed === "100" &&
        morrowSetRows(db.id) === 0,
    );
    check(
      "N_a_renewal_writes_no_payment_row_and_leaves_the_route_account_and_grant_unchanged",
      paymentRows() === paymentsBefore && fixedRows(V) === fixedBefore,
    );
    const again1 = await renew(V, ownerGrant);
    check(
      "N_a_second_run_in_the_same_period_writes_nothing",
      again1.outcome === "current" &&
        again1.period === "1" &&
        again1.renewalId === first1.renewalId &&
        again1.periodStart === first1.periodStart &&
        again1.addedUnits === "100" &&
        renewals().length === 1 &&
        latestSnapshot(V).revision === "2" &&
        same(walletOf(V), w1) &&
        morrowSetRows(db.id) === 0,
    );
    const viewed = await view(V, "staging");
    check(
      "N_the_billing_view_reads_the_renewed_period_and_its_credits",
      viewed.status === 200 &&
        viewed.body.state === "billable" &&
        viewed.body.plan?.validUntil === first1.periodEnd &&
        same(viewed.body.billingPeriod, { start: first1.periodStart, end: first1.periodEnd }) &&
        same(viewed.body.credits, { available: "280", reserved: "20", consumed: "100" }),
    );
    // A full wallet (280 available and 20 held) takes nothing more in period 2.
    travel(V, 720);
    const period2 = await renew(V, ownerGrant);
    const w2 = walletOf(V);
    check(
      "N_unspent_credits_are_never_topped_above_the_grant",
      period2.outcome === "renewed" &&
        period2.period === "2" &&
        period2.addedUnits === "0" &&
        period2.available === "280" &&
        period2.walletRevision === w1.revision &&
        period2.snapshotRevision === "3" &&
        renewals()[1]?.funded === null &&
        same(w2, w1) &&
        latestSnapshot(V).valid_until === period2.periodEnd,
    );
    // Lapsed periods are never written: three periods later the renewal is period 5. The
    // grant's end has moved 2,880 hours back since grantEnd was read, so period 5 (four
    // periods after it) starts at grantEnd again in the real clock.
    travel(V, 2160);
    const lapsed = await renew(V, ownerGrant);
    check(
      "N_lapsed_periods_skip_to_the_one_that_contains_the_clock",
      lapsed.outcome === "renewed" &&
        lapsed.period === "5" &&
        lapsed.periodStart === grantEnd &&
        renewals()
          .map((r) => r.period)
          .join() === "1,2,5",
    );
    // No caller value names the credits (R10): the function takes five closed text values,
    // none an amount, and the renewal record has no raise column; the old raise call (an
    // amount and its record) does not exist, and the runner refuses an amount before it
    // connects.
    const raiseRecord = ["docs/evidence/live/2026-10-25-test-credits-raise", "md"].join(".");
    const amountCall = db.tryRun(
      `SET ROLE morrow_work_owner; SELECT outcome FROM morrow_billing.operator_test_entitlement_renew(${[
        ...Object.values(renewInput(V, ownerGrant)),
        "1000",
        raiseRecord,
      ]
        .map(lit)
        .join(",")});`,
    );
    const amountInput = await rejection(
      renewTestCredits({
        connect: runner().connect,
        binding: labBinding,
        administrator,
        input: { ...renewInput(V, ownerGrant), creditUnits: "1000", raiseEvidenceRef: raiseRecord },
      }),
    );
    check(
      "N_no_caller_value_names_the_credits",
      scalar(
        "SELECT pg_catalog.pg_get_function_identity_arguments('morrow_billing.operator_test_entitlement_renew(text,text,text,text,text)'::regprocedure);",
      ) ===
        "p_operator_id text, p_workspace_id text, p_grant_approval_ref text, p_standing_approval text, p_evidence_ref text" &&
        scalar(
          "SELECT count(*) FROM pg_catalog.pg_proc WHERE proname='operator_test_entitlement_renew';",
        ) === "1" &&
        scalar(
          "SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid='morrow_billing.operator_test_entitlement_renewals'::regclass AND attname ~ 'raise' AND NOT attisdropped;",
        ) === "0" &&
        !amountCall.ok &&
        /does not exist/.test(amountCall.stderr) &&
        amountInput?.code === "STAGING_USAGE" &&
        renewals().length === 3,
    );
    // The owner's raise is a new staging terms revision (ADR-0035 item 4), parsed by the
    // billing module and written by the same seed as revision 1: revision 2's operator entry
    // carries 1,000 credits. The current period keeps the credits it was written with; the
    // next renewal reads revision 2 and tops the wallet up to 1,000.
    const [publishedRow] = await stagingBillingTermsRows(repositoryRoot, "staging");
    const published = {
      terms: JSON.parse(publishedRow[1]),
      offers: JSON.parse(publishedRow[2]),
      digest: publishedRow[3],
    };
    const raisedTerms = {
      ...published.terms,
      termsRevision: 2,
      entries: published.terms.entries.map((e) =>
        e.kind === "operator_test_entitlement" ? { ...e, creditUnits: "1000" } : e,
      ),
    };
    parseTermsDocument(raisedTerms, published.offers);
    const raisedRevision = {
      terms: raisedTerms,
      offers: published.offers,
      digest: await termsDocumentDigest(raisedTerms, published.offers),
    };
    const reseededTerms = await seedBillingTerms({
      connect: runner().connect,
      binding: labBinding,
      administrator,
      rows: billingTermsSeedRows([published, raisedRevision]),
    });
    const walletBeforeRaise = walletOf(V);
    const sameRaisedPeriod = await renew(V, ownerGrant);
    const walletInSamePeriod = walletOf(V);
    travel(V, 720);
    const raisedRenewal = await renew(V, ownerGrant);
    const r6 = renewals().at(-1);
    check(
      "N_a_new_terms_revision_changes_the_next_renewals_credits_and_not_the_current_period",
      reseededTerms.termsInserted === 1 &&
        sameRaisedPeriod.outcome === "current" &&
        sameRaisedPeriod.period === "5" &&
        sameRaisedPeriod.creditUnits === "300" &&
        sameRaisedPeriod.termsRevision === "1" &&
        same(walletInSamePeriod, walletBeforeRaise) &&
        raisedRenewal.outcome === "renewed" &&
        raisedRenewal.period === "6" &&
        raisedRenewal.creditUnits === "1000" &&
        raisedRenewal.termsRevision === "2" &&
        raisedRenewal.addedUnits === "700" &&
        raisedRenewal.available === "980" &&
        r6?.period === "6" &&
        r6.units === "1000" &&
        r6.terms === "2" &&
        r6.added === "700" &&
        paymentRows() === paymentsBefore &&
        fixedRows(V) === fixedBefore,
    );
    // Terms without the one operator entry: a due period is refused (terms_missing) and
    // nothing is written (revision 3 is rolled back with the call).
    travel(V, 720);
    const noOperatorTerms = JSON.stringify({ ...raisedTerms, termsRevision: 3, entries: [] });
    const termsMissing = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; INSERT INTO morrow_billing.billing_terms VALUES(3,${lit(noOperatorTerms)}::jsonb,'[]'::jsonb,repeat('e',64),date_trunc('milliseconds',clock_timestamp())); ${renewSql(renewInput(V, ownerGrant))} ROLLBACK;`,
    );
    check(
      "N_terms_without_the_operator_entry_refuse_a_due_period",
      termsMissing.ok &&
        termsMissing.stdout.split("\n").at(-1) === "terms_missing" &&
        scalar("SELECT count(*) FROM morrow_billing.billing_terms;") === "2" &&
        renewals().length === 4 &&
        latestSnapshot(V).revision === "5",
    );
    // Review R3 (a): the route and account rules, each alone, while a period is due (the
    // control renews it in a transaction that rolls back): an account that is not active,
    // and a route that is Shopify-bound. Route rows cannot hold a Shopify-bound
    // Morrow-direct route (0035's variant CHECK), so the superuser drops that CHECK inside
    // a transaction that rolls back, to show that the function's own rule refuses it.
    const ownerTxn = (sql) =>
      db.tryRun(`SET ROLE morrow_work_owner; BEGIN; ${sql} ROLLBACK;`).stdout.split("\n").at(-1);
    const accountStatus = (status) =>
      `UPDATE morrow_billing.billing_accounts SET status=${lit(status)},revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(V.workspace)};`;
    const dueControl = ownerTxn(renewSql(renewInput(V, ownerGrant)));
    const notActive = ["suspended", "cancelled", "pending"].map((status) =>
      ownerTxn(`${accountStatus(status)} ${renewSql(renewInput(V, ownerGrant))}`),
    );
    const shopifyBound = db.tryRun(`BEGIN;
ALTER TABLE morrow_billing.workspace_billing_routes DROP CONSTRAINT workspace_billing_routes_variant;
SET LOCAL session_replication_role = replica;
UPDATE morrow_billing.workspace_billing_routes SET shopify_bound_at=route_fixed_at WHERE workspace_id=${lit(V.workspace)};
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE morrow_work_owner;
${renewSql(renewInput(V, ownerGrant))}
ROLLBACK;`);
    check(
      "N_an_account_that_is_not_active_or_a_shopify_bound_route_is_a_route_conflict",
      dueControl === "renewed" &&
        same(notActive, ["route_conflict", "route_conflict", "route_conflict"]) &&
        shopifyBound.ok &&
        shopifyBound.stdout.split("\n").at(-1) === "route_conflict" &&
        renewals().length === 4 &&
        latestSnapshot(V).revision === "5" &&
        scalar(
          `SELECT status||'|'||(SELECT shopify_bound_at IS NULL FROM morrow_billing.workspace_billing_routes WHERE workspace_id=${lit(V.workspace)}) FROM morrow_billing.billing_accounts WHERE workspace_id=${lit(V.workspace)};`,
        ) === "active|true",
    );
    // Review R1: a renewal record written by hand as the owner. forgeRenewal writes, as the
    // owner, the row the renewal would write now (the grant's grid, the current terms'
    // operator entry, the room below it), with any value replaced by a SQL expression over
    // g (grant), w (wallet), s (latest snapshot), t (current terms' entry) and k (the period
    // that contains the clock). Its recorded time is given as the period's start.
    const forgeRenewal = (o = {}) => {
      const period = o.period ?? "k.k";
      const units = o.units ?? "t.units";
      const terms = o.terms ?? "t.terms_revision";
      const added = o.added ?? `greatest(0,(${units})-(w.available+w.reserved))`;
      const funded = o.funded ?? `CASE WHEN (${added})>0 THEN w.revision+1 END`;
      const snapshot = o.snapshot ?? "s.revision+1";
      const start = `g.period_end+((${period})-1)*interval '720 hours'`;
      const ws = lit(V.workspace);
      return `WITH g AS (SELECT * FROM morrow_billing.operator_test_entitlements WHERE workspace_id=${ws}),
 w AS (SELECT available,reserved,revision::bigint AS revision FROM morrow_billing.credit_wallets WHERE workspace_id=${ws}),
 s AS (SELECT revision::bigint AS revision FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${ws} ORDER BY revision DESC LIMIT 1),
 t AS (SELECT x.terms_revision::bigint AS terms_revision,(SELECT (e->>'creditUnits')::bigint FROM jsonb_array_elements(x.terms->'entries') e WHERE e->>'kind'='operator_test_entitlement') AS units FROM morrow_billing.billing_terms x ORDER BY x.terms_revision DESC LIMIT 1),
 k AS (SELECT (1+floor((extract(epoch FROM date_trunc('milliseconds',clock_timestamp()))-extract(epoch FROM g.period_end))/2592000))::integer AS k FROM g)
INSERT INTO morrow_billing.operator_test_entitlement_renewals(organization_id,workspace_id,id,entitlement_id,billing_account_id,period_number,standing_approval,operator_id,evidence_ref,mode,credit_units,terms_revision,added_units,funded_wallet_revision,snapshot_revision,period_start,period_end,evidence_digest,recorded_at)
SELECT g.organization_id,g.workspace_id,gen_random_uuid()::text,g.id,g.billing_account_id,${period},'adr-0035','operator_lab',${lit(standingEvidence)},'test',${units},${terms},${added},${funded},${snapshot},${start},${start}+interval '720 hours',repeat('c',64),${start} FROM g,w,s,t,k;`;
    };
    // The wallet funding a renewal record names (its funded revision is the next one).
    const fundRenewal = `UPDATE morrow_billing.credit_wallets w SET available=w.available+r.added_units,revision=w.revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),w.updated_at)
 FROM morrow_billing.operator_test_entitlement_renewals r WHERE w.workspace_id=${lit(V.workspace)} AND r.organization_id=w.organization_id AND r.workspace_id=w.workspace_id AND r.billing_account_id=w.billing_account_id AND r.funded_wallet_revision=w.revision+1;`;
    const walletSum = `SELECT available||'|'||reserved||'|'||revision FROM morrow_billing.credit_wallets WHERE workspace_id=${lit(V.workspace)};`;
    // Spend 900 of the 980 available (a move that keeps the sum), so a top-up has room.
    const spend900 = `UPDATE morrow_billing.credit_wallets SET available=available-900,consumed=consumed+900,revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(V.workspace)};`;
    const huge = "1000000000000000";
    // The reviewer's forgery: an unused period, 10^15 credits, the room below them added,
    // funding the wallet's next revision, with its funding.
    const reviewerForgery = forgeRenewal({ period: "99", units: huge });
    const forgedRows = [
      reviewerForgery + fundRenewal,
      forgeRenewal({ units: huge }),
      forgeRenewal({ period: "k.k+1" }),
      forgeRenewal({ snapshot: "s.revision+2" }),
      forgeRenewal({ terms: "1", units: "300" }),
      // 1,000 added although the wallet already holds 1,000 unspent (no room).
      forgeRenewal({ added: "1000", funded: "w.revision+1" }),
      spend900 + forgeRenewal({ added: "50", funded: "w.revision+1" }),
      spend900 + forgeRenewal({ funded: "w.revision+2" }),
      accountStatus("suspended") + forgeRenewal(),
    ].map((sql) => db.tryRun(`SET ROLE morrow_work_owner; BEGIN; ${sql} ROLLBACK;`));
    // The control: the row the renewal would write is accepted, its recorded time is the
    // database's clock, and with room its funding passes.
    const exactRow = db.tryRun(`SET ROLE morrow_work_owner; BEGIN; ${spend900} ${forgeRenewal()}
SELECT (recorded_at>period_start)::text||'|'||period_number||'|'||credit_units||'|'||added_units FROM morrow_billing.operator_test_entitlement_renewals WHERE workspace_id=${lit(V.workspace)} ORDER BY snapshot_revision DESC LIMIT 1;
${fundRenewal} ${walletSum} ROLLBACK;`);
    const exactLines = exactRow.stdout.split("\n");
    check(
      "N_a_renewal_record_written_by_hand_must_be_the_one_the_renewal_would_write_now",
      forgedRows.every((r) => !r.ok && /BILLING_RENEWAL_INVALID/.test(r.stderr)) &&
        exactRow.ok &&
        exactLines.at(-2) === "true|7|1000|900" &&
        exactLines.at(-1) === `980|20|${Number(walletOf(V).revision) + 2}` &&
        renewals().length === 4 &&
        walletOf(V).available === "980",
    );
    // The wallet's rule alone (review R1, defence in depth): with the record's trigger
    // switched off inside a transaction that rolls back, a funding still needs the room
    // below the current terms' operator credits of the current terms revision. Each forged
    // record below passes 0035's wallet rule (its added units equal the funding).
    const withoutRecordGuard = (sql) =>
      db.tryRun(`BEGIN;
ALTER TABLE morrow_billing.operator_test_entitlement_renewals DISABLE TRIGGER renewal_guard;
SET LOCAL ROLE morrow_work_owner;
${sql}
ROLLBACK;`);
    const walletForgeries = [
      // The reviewer's forgery: 10^15 credits that are not the terms' entry.
      reviewerForgery + fundRenewal,
      // The terms' credits, but more added than the room (none).
      forgeRenewal({ period: "98", added: "1000", funded: "w.revision+1" }) + fundRenewal,
      // An earlier terms revision's credits (300 of revision 1) with room below them.
      spend900 + forgeRenewal({ period: "97", terms: "1", units: "300" }) + fundRenewal,
    ].map(withoutRecordGuard);
    const walletControl = withoutRecordGuard(
      `${spend900} ${forgeRenewal({ period: "96" })} ${fundRenewal} ${walletSum}`,
    );
    check(
      "N_without_the_record_guard_a_funding_still_needs_the_room_below_the_current_terms_credits",
      walletForgeries.every((r) => !r.ok && /BILLING_WALLET_INVALID/.test(r.stderr)) &&
        walletControl.ok &&
        walletControl.stdout.split("\n").at(-1) === `980|20|${Number(walletOf(V).revision) + 2}` &&
        walletOf(V).available === "980",
    );
    // Review R3 (a): an operator snapshot's successor needs an active account. The record
    // the renewal would write is accepted while the account is active; the account is then
    // suspended, and the snapshot naming that record is refused (the control, without the
    // suspension, is accepted).
    const successorOf = `INSERT INTO morrow_billing.entitlement_snapshots(organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,provider_evidence_ref,verified_at,valid_until,receipt_id,recorded_at)
 SELECT r.organization_id,r.workspace_id,r.billing_account_id,r.snapshot_revision,'morrow_direct','test','morrow:operator_entitlement:'||r.entitlement_id::text,'active',r.evidence_digest,r.period_start,r.period_end,NULL,date_trunc('milliseconds',clock_timestamp())
 FROM morrow_billing.operator_test_entitlement_renewals r WHERE r.workspace_id=${lit(V.workspace)} ORDER BY r.snapshot_revision DESC LIMIT 1;`;
    const latestRevision = `SELECT max(revision) FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(V.workspace)};`;
    const suspendedSuccessor = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; ${forgeRenewal()} ${accountStatus("suspended")} ${successorOf} ROLLBACK;`,
    );
    const activeSuccessor = db.tryRun(
      `SET ROLE morrow_work_owner; BEGIN; ${forgeRenewal()} ${successorOf} ${latestRevision} ROLLBACK;`,
    );
    check(
      "N_an_operator_snapshots_successor_needs_an_active_account",
      !suspendedSuccessor.ok &&
        /BILLING_SNAPSHOT_INVALID/.test(suspendedSuccessor.stderr) &&
        activeSuccessor.ok &&
        activeSuccessor.stdout.split("\n").at(-1) === "6" &&
        latestSnapshot(V).revision === "5",
    );
    // Forgeries: a successor snapshot with no renewal record (even one copying the last
    // period forward), a wallet funding with no renewal, a Stripe successor (refused by the
    // snapshot guard itself, which runs before the receipt CHECK: review R3 (b)), an edit
    // of a renewal record.
    const forgedSuccessor = db.tryRun(
      `SET ROLE morrow_work_owner; INSERT INTO morrow_billing.entitlement_snapshots(organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,provider_evidence_ref,verified_at,valid_until,receipt_id,recorded_at)
 SELECT organization_id,workspace_id,billing_account_id,revision+1,'morrow_direct','test',subscription_key,'active',provider_evidence_ref,valid_until,valid_until+interval '720 hours',NULL,date_trunc('milliseconds',clock_timestamp()) FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(V.workspace)} ORDER BY revision DESC LIMIT 1;`,
    );
    const forgedFunding = db.tryRun(
      `SET ROLE morrow_work_owner; UPDATE morrow_billing.credit_wallets SET available=available+700,revision=revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),updated_at) WHERE workspace_id=${lit(V.workspace)};`,
    );
    const stripeSuccessor = db.tryRun(
      `SET ROLE morrow_work_owner; INSERT INTO morrow_billing.entitlement_snapshots(organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,provider_evidence_ref,verified_at,valid_until,receipt_id,recorded_at)
 SELECT organization_id,workspace_id,billing_account_id,revision+1,'morrow_direct','test','stripe:sub:sub_LabForgedSuccessor','active',provider_evidence_ref,valid_until,valid_until+interval '720 hours',NULL,date_trunc('milliseconds',clock_timestamp()) FROM morrow_billing.entitlement_snapshots WHERE workspace_id=${lit(V.workspace)} ORDER BY revision DESC LIMIT 1;`,
    );
    const editedRenewal = db.tryRun(
      `SET ROLE morrow_work_owner; UPDATE morrow_billing.operator_test_entitlement_renewals SET credit_units=credit_units+1 WHERE workspace_id=${lit(V.workspace)};`,
    );
    const deletedRenewal = db.tryRun(
      `SET ROLE morrow_work_owner; DELETE FROM morrow_billing.operator_test_entitlement_renewals WHERE workspace_id=${lit(V.workspace)};`,
    );
    check(
      "N_forged_successors_fundings_and_edits_of_a_renewal_are_refused",
      !forgedSuccessor.ok &&
        /BILLING_SNAPSHOT_INVALID/.test(forgedSuccessor.stderr) &&
        !forgedFunding.ok &&
        /BILLING_WALLET_INVALID/.test(forgedFunding.stderr) &&
        !stripeSuccessor.ok &&
        /BILLING_SNAPSHOT_INVALID/.test(stripeSuccessor.stderr) &&
        !editedRenewal.ok &&
        !deletedRenewal.ok &&
        renewals().length === 4 &&
        latestSnapshot(V).revision === "5" &&
        walletOf(V).available === "980",
    );
  },
  { administrator: "createrole" },
);

const report = {
  lab: "test-entitlement",
  generated_at: new Date().toISOString(),
  elapsed_seconds: Math.round((Date.now() - started) / 1000),
  checks: checks.length,
  failures,
  results: checks,
};
writeArtifact("labs/test-entitlement.json", report);
console.log(
  JSON.stringify({ lab: "test-entitlement", checks: checks.length, failures: failures.length }),
);
if (failures.length) process.exit(1);
