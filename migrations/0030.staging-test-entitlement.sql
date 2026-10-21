BEGIN;
-- The staging test entitlement (owner decision (b), 2026-10-21; ADR-0022 item 5 amendment;
-- staging-card-1 E13; docs/briefs/staging-test-entitlement.md). Executes AS
-- morrow_work_owner, after 0029. While the Stripe switch is off, an operator command,
-- approved by the owner and recorded per use, puts one named staging workspace on the beta
-- plan without Stripe: its route is fixed to morrow_direct (test) exactly as a verified
-- payment fixes it, with its billing account, its first entitlement snapshot and a funded
-- credit wallet, all in one transaction. It is an operator grant, never a payment: no
-- receipt, verified payment event or credit_grants row is written, and the keys it uses
-- (morrow:operator_entitlement:<id>) are not payment keys.
--   * platform_environment: the platform's one environment mark (development, staging or
--     production), written once by the owner's seed (staging:seed-platform) and never
--     changed. The operator path refuses unless it says staging.
--   * billing_terms: a revision may carry one operator_test_entitlement entry (the beta
--     plan's credits without a price; test mode, development or staging marks only), and
--     only a revision with no priced subscription has no offer. Credits still come only
--     from the terms (R10).
--   * operator_test_entitlements: the operator grant record (approval reference, operator,
--     live-evidence path, credit units and terms revision, the period), one per workspace
--     and one per approval; append-only, owner only, no runtime role holds anything.
--   * Forward changes to 0020's and 0029's records so they can hold it: the route variant
--     admits an operator key in test mode; a snapshot names either a recorded receipt or
--     an operator entitlement; wallet_guard admits the operator grant as the funding of
--     the wallet's first funded revision; route_fix_guard and snapshot_guard admit operator
--     keys only from the owner, naming the grant of the same tenant.
--   * operator_test_entitlement_grant: the operator function (the 0020 operator idiom:
--     owned by the owner, INVOKER, granted to nobody). Only the owner's audited script runs
--     it, as morrow_work_owner inside the administrator's own transaction (the ADR-0020
--     runner shape; staging:test-entitlement). Not SECURITY DEFINER: a definer would act as
--     the owner for any future EXECUTE grantee, while INVOKER with the current_user check
--     admits only a session that has SET ROLE morrow_work_owner. It refuses every work
--     session, lease or receipt context and every Morrow login as session user.
-- No runtime login, session or definer gains a privilege; checkout, the receipt ingress and
-- the broker's definers are unchanged.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_billing.workspace_billing_routes') IS NULL OR to_regclass('morrow_billing.billing_terms') IS NULL
 OR to_regclass('morrow_billing.billing_accounts') IS NULL OR to_regclass('morrow_billing.entitlement_snapshots') IS NULL
 OR to_regclass('morrow_billing.credit_wallets') IS NULL OR to_regclass('morrow_billing.stripe_customers') IS NULL
 OR to_regprocedure('morrow_billing.terms_guard()') IS NULL OR to_regprocedure('morrow_billing.snapshot_guard()') IS NULL
 OR to_regprocedure('morrow_billing.wallet_guard()') IS NULL OR to_regprocedure('morrow_billing.route_fix_guard()') IS NULL
 OR to_regprocedure('morrow_billing.receipt_tenant(text,text)') IS NULL
 OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL
 OR to_regclass('morrow_billing.platform_environment') IS NOT NULL OR to_regclass('morrow_billing.operator_test_entitlements') IS NOT NULL
 OR to_regprocedure('morrow_billing.operator_test_entitlement_grant(text,text,text,text)') IS NOT NULL
 OR (SELECT count(*) FROM pg_catalog.pg_constraint c WHERE c.contype='c' AND (c.conrelid,c.conname) IN (
   ('morrow_billing.workspace_billing_routes'::regclass,'workspace_billing_routes_variant'),
   ('morrow_billing.billing_terms'::regclass,'billing_terms_offers_check'),
   ('morrow_billing.entitlement_snapshots'::regclass,'entitlement_snapshots_subscription_key_check')))<>3
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_billing.entitlement_snapshots'::regclass
   AND a.attname='receipt_id' AND a.attnotnull AND NOT a.attisdropped)
 THEN RAISE EXCEPTION 'STAGING_TEST_ENTITLEMENT_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The platform's environment mark: one row, inserted once by the owner's seed and never
-- changed, deleted or truncated. A database without the mark is no environment the
-- operator path accepts.
CREATE TABLE morrow_billing.platform_environment (
 singleton boolean NOT NULL PRIMARY KEY CHECK (singleton),
 environment text NOT NULL CHECK (environment IN ('development','staging','production')),
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=timestamptz '2000-01-01T00:00:00Z' AND recorded_at<timestamptz '9000-01-01T00:00:00Z')
);

-- The operator grant (ADR-0022 item 5 amendment): one staging test entitlement of one
-- workspace, under one owner approval recorded in chat and one live-evidence record. Its
-- credits and terms revision come from the terms' operator entry; it funds the wallet's
-- first funded revision (2); its period is the 30 days its snapshot is valid. The id names
-- the route's fixing key and the snapshot's subscription key. Fixed grammars only; no
-- free text.
CREATE TABLE morrow_billing.operator_test_entitlements (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 billing_account_id morrow_work.record_id NOT NULL,
 approval_ref text NOT NULL UNIQUE CHECK (approval_ref ~ '^[a-z0-9][a-z0-9-]{0,40}[.]e[1-9][0-9]{0,2}[.][0-9]{4}-[0-9]{2}-[0-9]{2}[.][1-9][0-9]{0,2}$'),
 operator_id text NOT NULL CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 evidence_ref text NOT NULL CHECK (evidence_ref ~ '^docs/evidence/live/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]{1,80}[.]md$'),
 mode text NOT NULL CHECK (mode='test'),
 credit_units bigint NOT NULL CHECK (credit_units BETWEEN 1 AND 999999999999999999),
 terms_revision morrow_work.revision NOT NULL REFERENCES morrow_billing.billing_terms(terms_revision),
 funded_wallet_revision morrow_work.revision NOT NULL CHECK (funded_wallet_revision=2),
 period_start timestamptz NOT NULL CHECK (period_start=date_trunc('milliseconds',period_start) AND period_start>=timestamptz '2000-01-01T00:00:00Z' AND period_start<timestamptz '9000-01-01T00:00:00Z'),
 period_end timestamptz NOT NULL,
 evidence_digest morrow_work.digest NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,billing_account_id) REFERENCES morrow_billing.billing_accounts(organization_id,workspace_id,id),
 CONSTRAINT operator_test_entitlements_period CHECK (period_end=period_start+interval '30 days' AND recorded_at=period_start)
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['platform_environment','operator_test_entitlements'] LOOP
  EXECUTE format('ALTER TABLE morrow_billing.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_billing.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_billing.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_billing.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_billing.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_billing.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Forward changes to the records the operator grant writes.
-- The route (0020): a Morrow-direct route fixed by an operator test entitlement names its
-- grant, in test mode only. Every other variant is unchanged.
ALTER TABLE morrow_billing.workspace_billing_routes DROP CONSTRAINT workspace_billing_routes_variant,
 ADD CONSTRAINT workspace_billing_routes_variant CHECK (CASE
  WHEN route IS NULL THEN mode IS NULL AND route_fixed_at IS NULL AND fixing_payment_key IS NULL
  WHEN route='morrow_direct' THEN origin='website' AND shopify_bound_at IS NULL AND mode IS NOT NULL AND route_fixed_at IS NOT NULL
   AND fixing_payment_key IS NOT NULL AND (fixing_payment_key ~ '^stripe:invoice:in_[A-Za-z0-9]{8,100}$'
    OR (mode='test' AND fixing_payment_key ~ '^morrow:operator_entitlement:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'))
  ELSE shopify_bound_at IS NOT NULL AND mode IS NOT NULL AND route_fixed_at IS NOT NULL AND fixing_payment_key IS NOT NULL
   AND fixing_payment_key ~ '^shopify:app:(0|[1-9][0-9]{0,19}):shop:(0|[1-9][0-9]{0,19}):cycle:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$' END);
-- The terms (0029): a revision with no priced subscription (the staging revision while
-- the Stripe switch is off) has no offer; terms_guard below still requires an offer of
-- every revision that has one.
ALTER TABLE morrow_billing.billing_terms DROP CONSTRAINT billing_terms_offers_check,
 ADD CONSTRAINT billing_terms_offers_check CHECK (jsonb_typeof(offers)='array' AND jsonb_array_length(offers) BETWEEN 0 AND 20);
-- Snapshots (0029): either a verified receipt's fold (a Stripe subscription key and its
-- receipt) or an operator test entitlement (its key, test mode, no receipt).
ALTER TABLE morrow_billing.entitlement_snapshots ALTER COLUMN receipt_id DROP NOT NULL,
 DROP CONSTRAINT entitlement_snapshots_subscription_key_check,
 ADD CONSTRAINT entitlement_snapshots_subscription_key_check CHECK (subscription_key ~ '^stripe:sub:sub_[A-Za-z0-9]{8,100}$'
  OR subscription_key ~ '^morrow:operator_entitlement:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 ADD CONSTRAINT entitlement_snapshots_source CHECK (CASE WHEN subscription_key ~ '^morrow:operator_entitlement:'
  THEN receipt_id IS NULL AND mode='test' ELSE receipt_id IS NOT NULL END);

-- ---------------------------------------------------------------------------
-- Triggers, replaced with the same signatures (CREATE OR REPLACE keeps their owner, ACL
-- and the triggers that call them). INVOKER: they run with the writer's privileges, and
-- they read operator_test_entitlements only after checking that the writer is the owner,
-- so a command-role writer never reaches a table it cannot read.
-- Terms (0029), plus: one operator_test_entitlement entry at most, of the fixed shape, and
-- only in a database marked development or staging; a revision without an offer has no
-- priced Morrow-direct subscription.
CREATE OR REPLACE FUNCTION morrow_billing.terms_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_previous bigint; e jsonb; f jsonb; v_operator integer:=0; v_environment text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BILLING_TERMS_IMMUTABLE'; END IF;
 SELECT max(t.terms_revision) INTO v_previous FROM morrow_billing.billing_terms t;
 IF NEW.terms_revision<>COALESCE(v_previous,0)+1 OR NEW.recorded_at IS NULL THEN RAISE EXCEPTION 'BILLING_TERMS_INVALID'; END IF;
 FOR e IN SELECT x FROM jsonb_array_elements(NEW.terms->'entries') x LOOP
  IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(e) k)
    IS DISTINCT FROM ARRAY['creditUnits','currency','kind','mode','priceKey','route']
   OR jsonb_typeof(e->'creditUnits')<>'string' OR e->>'creditUnits' !~ '^(0|[1-9][0-9]{0,17})$' THEN
   RAISE EXCEPTION 'BILLING_TERMS_INVALID';
  END IF;
  IF e->>'kind'='operator_test_entitlement' THEN
   IF e->>'route' IS DISTINCT FROM 'morrow_direct' OR e->>'mode' IS DISTINCT FROM 'test' OR e->>'currency' IS DISTINCT FROM 'USD'
    OR e->>'priceKey' IS DISTINCT FROM 'morrow:operator_plan:beta' OR e->>'creditUnits' !~ '^[1-9]' THEN
    RAISE EXCEPTION 'BILLING_TERMS_INVALID';
   END IF;
   v_operator:=v_operator+1;
  ELSIF e->>'route' NOT IN ('morrow_direct','shopify_app_pricing') OR e->>'mode' NOT IN ('live','test')
   OR e->>'kind' NOT IN ('subscription_period','top_up') OR e->>'currency' !~ '^[A-Z]{3}$'
   OR (e->>'route'='morrow_direct' AND e->>'priceKey' !~ '^stripe:price:price_[A-Za-z0-9]{8,100}$') THEN
   RAISE EXCEPTION 'BILLING_TERMS_INVALID';
  END IF;
 END LOOP;
 IF v_operator>1 THEN RAISE EXCEPTION 'BILLING_TERMS_INVALID'; END IF;
 IF v_operator=1 THEN
  SELECT x.environment INTO v_environment FROM morrow_billing.platform_environment x;
  IF v_environment IS NULL OR v_environment NOT IN ('development','staging') THEN RAISE EXCEPTION 'BILLING_TERMS_INVALID'; END IF;
 END IF;
 FOR f IN SELECT x FROM jsonb_array_elements(NEW.offers) x LOOP
  IF jsonb_typeof(f)<>'object' OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(f) k)
    IS DISTINCT FROM ARRAY['currency','interval','priceKey','unitAmount']
   OR f->>'interval'<>'month' OR f->>'currency' !~ '^[A-Z]{3}$' OR jsonb_typeof(f->'unitAmount')<>'string'
   OR f->>'unitAmount' !~ '^[1-9][0-9]{0,8}$'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.terms->'entries') x WHERE x->>'route'='morrow_direct'
    AND x->>'kind'='subscription_period' AND x->>'priceKey'=f->>'priceKey' AND x->>'currency'=f->>'currency') THEN
   RAISE EXCEPTION 'BILLING_TERMS_INVALID';
  END IF;
 END LOOP;
 -- A priced revision still offers its price; only a revision without one has no offer.
 IF jsonb_array_length(NEW.offers)=0 AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.terms->'entries') x
   WHERE x->>'route'='morrow_direct' AND x->>'kind'='subscription_period') THEN
  RAISE EXCEPTION 'BILLING_TERMS_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Snapshots (0029), plus: an operator entitlement's snapshot is its account's first and
-- only one (no snapshot follows it), active for exactly the grant's period, written by the
-- owner and naming the grant of the same tenant and account with its evidence digest.
CREATE OR REPLACE FUNCTION morrow_billing.snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE a record; p record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BILLING_SNAPSHOT_IMMUTABLE'; END IF;
 SELECT x.route,x.mode INTO a FROM morrow_billing.billing_accounts x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.billing_account_id;
 SELECT x.revision::bigint AS revision,x.subscription_key,x.status INTO p FROM morrow_billing.entitlement_snapshots x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.billing_account_id=NEW.billing_account_id
  ORDER BY x.revision DESC LIMIT 1;
 IF a.route IS DISTINCT FROM NEW.route OR a.mode IS DISTINCT FROM NEW.mode
  OR NEW.revision<>COALESCE(p.revision,0)+1
  OR (p.status='cancelled' AND p.subscription_key=NEW.subscription_key AND NEW.status<>'cancelled')
  OR p.subscription_key ~ '^morrow:operator_entitlement:' THEN
  RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID';
 END IF;
 IF NEW.subscription_key ~ '^morrow:operator_entitlement:' THEN
  IF current_user<>'morrow_work_owner' OR NEW.revision<>1 OR NEW.status<>'active' THEN RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM morrow_billing.operator_test_entitlements g WHERE g.organization_id=NEW.organization_id
    AND g.workspace_id=NEW.workspace_id AND g.billing_account_id=NEW.billing_account_id
    AND 'morrow:operator_entitlement:'||g.id::text=NEW.subscription_key AND g.evidence_digest=NEW.provider_evidence_ref
    AND g.period_start=NEW.verified_at AND g.period_end=NEW.valid_until) THEN
   RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID';
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- Wallets (0029), plus: the owner's operator path funds the wallet revision its grant names
-- with exactly the grant's units. Moves (M3 PR-1) are unchanged.
CREATE OR REPLACE FUNCTION morrow_billing.wallet_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['available','reserved','consumed','revision','updated_at']; v_delta numeric;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.available<>0 OR NEW.reserved<>0 OR NEW.consumed<>0 OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'BILLING_WALLET_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) OR NEW.consumed<OLD.consumed THEN
  RAISE EXCEPTION 'BILLING_WALLET_INVALID';
 END IF;
 v_delta:=(NEW.available::numeric+NEW.reserved+NEW.consumed)-(OLD.available::numeric+OLD.reserved+OLD.consumed);
 IF v_delta=0 THEN RETURN NEW; END IF;
 IF v_delta>0 AND NEW.reserved=OLD.reserved AND NEW.consumed=OLD.consumed THEN
  IF EXISTS(SELECT 1 FROM morrow_billing.credit_grants g WHERE g.organization_id=NEW.organization_id AND g.workspace_id=NEW.workspace_id
    AND g.billing_account_id=NEW.billing_account_id AND g.funded_wallet_revision=NEW.revision AND g.credit_units=v_delta) THEN
   RETURN NEW;
  END IF;
  IF current_user='morrow_work_owner' THEN
   IF EXISTS(SELECT 1 FROM morrow_billing.operator_test_entitlements g WHERE g.organization_id=NEW.organization_id
     AND g.workspace_id=NEW.workspace_id AND g.billing_account_id=NEW.billing_account_id AND g.funded_wallet_revision=NEW.revision
     AND g.credit_units=v_delta) THEN
    RETURN NEW;
   END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'BILLING_WALLET_INVALID';
END $$;
-- The route fix (0029), plus: a route fixed by an operator key is fixed by the owner only,
-- naming the grant of the same tenant. A receipt's fix is unchanged; route_guard (0020)
-- still decides fix-once.
CREATE OR REPLACE FUNCTION morrow_billing.route_fix_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
BEGIN
 IF OLD.route IS NULL AND NEW.route IS NOT NULL THEN
  IF NEW.fixing_payment_key ~ '^morrow:operator_entitlement:' THEN
   IF current_user<>'morrow_work_owner' THEN RAISE EXCEPTION 'BILLING_ROUTE_FIX_DENIED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM morrow_billing.operator_test_entitlements g WHERE g.organization_id=NEW.organization_id
     AND g.workspace_id=NEW.workspace_id AND 'morrow:operator_entitlement:'||g.id::text=NEW.fixing_payment_key) THEN
    RAISE EXCEPTION 'BILLING_ROUTE_FIX_DENIED';
   END IF;
  ELSIF current_user='morrow_work_command' AND NOT morrow_billing.receipt_tenant(NEW.organization_id::text,NEW.workspace_id::text) THEN
   RAISE EXCEPTION 'BILLING_ROUTE_FIX_DENIED';
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The operator path: owned by the owner, INVOKER, granted to nobody. Only the owner's
-- audited script runs it (staging:test-entitlement, card E13: the owner's per-use approval
-- in chat and a committed live-evidence record), as morrow_work_owner inside the
-- administrator's own transaction under the D4 SET-row protocol. It puts one workspace on
-- the beta plan from the terms' operator entry:
--   refuses: any work session, lease or receipt context, any Morrow login as session user
--   (denied); a database not marked staging (not_staging); a reused approval for another
--   workspace, operator or record (approval_conflict); no route row (route_missing); a
--   route already fixed, Shopify-bound or not website, or an account or grant already
--   present (route_conflict); any Stripe customer, operation, intent or receipt of the
--   workspace (stripe_conflict); no operator entry in the current terms (terms_missing).
--   replays: the same approval for the same workspace, operator and record (replayed),
--   writing nothing.
--   grants, in this order and this one transaction: the Morrow-direct test account
--   (active, USD), the grant record, the wallet (born empty at revision 1 under the terms
--   revision) funded to revision 2 with the entry's credits, the snapshot (active for 30
--   days) and the route fix, with the same columns and guards a verified payment's fix
--   uses and the operator key in place of a payment key (granted).
-- The workspace is named by its id alone (the route row's key); its organization comes
-- from the route row. The result names ids, units, the terms revision and the period.
CREATE FUNCTION morrow_billing.operator_test_entitlement_grant(p_operator_id text,p_workspace_id text,p_approval_ref text,
 p_evidence_ref text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE
 g record; r record; v_environment text; v_terms record; v_entry jsonb; v_count integer; v_units bigint; v_at timestamptz;
 v_end timestamptz; v_id text; v_account text; v_key text; v_digest text; v_org text; v_route_revision bigint;
BEGIN
 IF current_user<>'morrow_work_owner' OR session_user::text LIKE 'morrow\_%'
  OR COALESCE(pg_catalog.current_setting('morrow.work_session_digest',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_workspace',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_lease_id',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.billing_receipt_entered',true),'')<>'' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END IF;
 IF p_operator_id IS NULL OR p_operator_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_approval_ref IS NULL OR p_approval_ref !~ '^[a-z0-9][a-z0-9-]{0,40}[.]e[1-9][0-9]{0,2}[.][0-9]{4}-[0-9]{2}-[0-9]{2}[.][1-9][0-9]{0,2}$'
  OR p_evidence_ref IS NULL OR p_evidence_ref !~ '^docs/evidence/live/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]{1,80}[.]md$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.environment INTO v_environment FROM morrow_billing.platform_environment x;
 IF v_environment IS DISTINCT FROM 'staging' THEN RETURN QUERY SELECT 'not_staging'::text,NULL::text; RETURN; END IF;
 -- One approval, one use: the approval's lock, then its record.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.billing.operator_test_entitlement',p_approval_ref)::text,0));
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.id::text AS id,
  x.billing_account_id::text AS billing_account_id,x.operator_id,x.evidence_ref,x.credit_units,x.terms_revision::bigint AS terms_revision,
  x.period_start,x.period_end INTO g
  FROM morrow_billing.operator_test_entitlements x WHERE x.approval_ref=p_approval_ref;
 IF FOUND THEN
  IF g.workspace_id<>p_workspace_id OR g.operator_id<>p_operator_id OR g.evidence_ref<>p_evidence_ref THEN
   RETURN QUERY SELECT 'approval_conflict'::text,NULL::text; RETURN;
  END IF;
  SELECT x.revision::bigint INTO v_route_revision FROM morrow_billing.workspace_billing_routes x
   WHERE x.organization_id=g.organization_id AND x.workspace_id=g.workspace_id;
  RETURN QUERY SELECT 'replayed'::text,jsonb_build_object('entitlementId',g.id,'organizationId',g.organization_id,
   'workspaceId',g.workspace_id,'billingAccountId',g.billing_account_id,'creditUnits',g.credit_units::text,
   'termsRevision',g.terms_revision::text,'periodStart',morrow_work.utc_text(g.period_start),
   'periodEnd',morrow_work.utc_text(g.period_end),'routeRevision',v_route_revision::text)::text;
  RETURN;
 END IF;
 -- The route row's lock serialises this with checkout and every receipt application.
 SELECT x.organization_id::text AS organization_id,x.origin,x.shopify_bound_at,x.route,x.revision::bigint AS revision,x.created_at,
  x.updated_at INTO r FROM morrow_billing.workspace_billing_routes x WHERE x.workspace_id=p_workspace_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'route_missing'::text,NULL::text; RETURN; END IF;
 v_org:=r.organization_id;
 IF r.route IS NOT NULL OR r.origin<>'website' OR r.shopify_bound_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM morrow_billing.billing_accounts x WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id)
  OR EXISTS(SELECT 1 FROM morrow_billing.operator_test_entitlements x WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id) THEN
  RETURN QUERY SELECT 'route_conflict'::text,NULL::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_billing.stripe_customers x WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id)
  OR EXISTS(SELECT 1 FROM morrow_billing.stripe_operations x WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id)
  OR EXISTS(SELECT 1 FROM morrow_billing.checkout_intents x WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id)
  OR EXISTS(SELECT 1 FROM morrow_billing.stripe_event_receipts x WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id) THEN
  RETURN QUERY SELECT 'stripe_conflict'::text,NULL::text; RETURN;
 END IF;
 -- R10: the credits come only from the current terms' operator entry.
 SELECT x.terms_revision::bigint AS terms_revision,x.terms INTO v_terms FROM morrow_billing.billing_terms x
  ORDER BY x.terms_revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'terms_missing'::text,NULL::text; RETURN; END IF;
 SELECT count(*)::integer,(array_agg(e))[1] INTO v_count,v_entry FROM jsonb_array_elements(v_terms.terms->'entries') e
  WHERE e->>'kind'='operator_test_entitlement' AND e->>'route'='morrow_direct' AND e->>'mode'='test';
 IF v_count<>1 THEN RETURN QUERY SELECT 'terms_missing'::text,NULL::text; RETURN; END IF;
 v_units:=(v_entry->>'creditUnits')::bigint;
 IF v_units<=0 THEN RETURN QUERY SELECT 'terms_missing'::text,NULL::text; RETURN; END IF;
 v_at:=greatest(date_trunc('milliseconds',clock_timestamp()),r.created_at,r.updated_at);
 v_end:=v_at+interval '30 days';
 v_id:=gen_random_uuid()::text; v_account:=gen_random_uuid()::text; v_key:='morrow:operator_entitlement:'||v_id;
 v_digest:=morrow_work.sha256_text(array_to_json(ARRAY['morrow.billing.operator_test_entitlement','1',v_id,v_org,p_workspace_id,v_account,
  p_approval_ref,p_operator_id,p_evidence_ref,v_units::text,v_terms.terms_revision::text,morrow_work.utc_text(v_at),
  morrow_work.utc_text(v_end)])::text);
 INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at)
 VALUES (v_org,p_workspace_id,v_account,'morrow_direct','test',v_entry->>'currency','active',1,v_at,v_at);
 INSERT INTO morrow_billing.operator_test_entitlements(organization_id,workspace_id,id,billing_account_id,approval_ref,operator_id,
  evidence_ref,mode,credit_units,terms_revision,funded_wallet_revision,period_start,period_end,evidence_digest,recorded_at)
 VALUES (v_org,p_workspace_id,v_id,v_account,p_approval_ref,p_operator_id,p_evidence_ref,'test',v_units,v_terms.terms_revision,2,
  v_at,v_end,v_digest,v_at);
 INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,
  terms_revision,revision,created_at,updated_at)
 VALUES (v_org,p_workspace_id,v_account,0,0,0,1,v_terms.terms_revision,1,v_at,v_at);
 UPDATE morrow_billing.credit_wallets x SET available=x.available+v_units,revision=x.revision+1,updated_at=v_at
  WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id AND x.billing_account_id=v_account;
 INSERT INTO morrow_billing.entitlement_snapshots(organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,
  provider_evidence_ref,verified_at,valid_until,receipt_id,recorded_at)
 VALUES (v_org,p_workspace_id,v_account,1,'morrow_direct','test',v_key,'active',v_digest,v_at,v_end,NULL,v_at);
 UPDATE morrow_billing.workspace_billing_routes x SET route='morrow_direct',mode='test',route_fixed_at=v_at,fixing_payment_key=v_key,
  revision=x.revision+1,updated_at=v_at
  WHERE x.organization_id=v_org AND x.workspace_id=p_workspace_id;
 RETURN QUERY SELECT 'granted'::text,jsonb_build_object('entitlementId',v_id,'organizationId',v_org,'workspaceId',p_workspace_id,
  'billingAccountId',v_account,'creditUnits',v_units::text,'termsRevision',v_terms.terms_revision::text,
  'periodStart',morrow_work.utc_text(v_at),'periodEnd',morrow_work.utc_text(v_end),'routeRevision',(r.revision+1)::text)::text;
END $$;
REVOKE ALL ON FUNCTION morrow_billing.operator_test_entitlement_grant(text,text,text,text) FROM PUBLIC;
COMMIT;
