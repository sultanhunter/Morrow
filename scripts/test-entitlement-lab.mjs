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
import { grantTestEntitlement, registerShopifyApp, seedBillingTerms } from "./staging-runner.mjs";
import { checkEnvelope, sealAppSecretWithKek } from "./vault.mjs";
import { psqlConnector } from "./fixtures/staging-psql-connection.mjs";
import {
  administrator as neonAdministrator,
  morrowSetRows,
} from "./fixtures/createrole-administrator.mjs";
import { labBinding } from "../tests/fixtures/staging-fakes.mjs";
import { createBillingApiHandler } from "../packages/work/src/billing/index.ts";

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
          `INSERT INTO morrow_billing.workspace_billing_routes VALUES(${lit(p.org)},${lit(p.workspace)},'website',NULL,NULL,NULL,NULL,NULL,1,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()));`,
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
