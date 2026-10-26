BEGIN;
-- v1 build order PR 6, "Credits for your own workspace" (ADR-0035 items 3 and 4;
-- docs/briefs/v1-renew-test-credits.md). Executes AS morrow_work_owner, after 0035 (the
-- operator test entitlement it renews). Until Shopify billing exists, the owner's workspace
-- gets its test credits from the operator grant 0035 wrote (300 credits for 30 days). This
-- file lets the owner's audited script renew that grant once per 30-day period, with no
-- payment of any kind:
--   * operator_test_entitlement_renewals: one row per renewed period of one grant (the
--     grant, the period's number, its credits and the terms revision they came from, what
--     the renewal added to the wallet, the snapshot and wallet revisions it wrote, the
--     standing approval, the operator, the live record and a digest); append-only, owner
--     only, one per grant and period; no runtime role holds anything.
--   * renewal_guard (review R1): a renewal record, even one the owner writes by hand, names
--     exactly what the renewal would write at that moment: the grant of its own account, a
--     route, account, wallet and latest snapshot that are that grant's, the period on the
--     grant's grid that contains the database's clock (its recorded time), the next
--     snapshot revision, the current terms' credits and revision, and units added that are
--     exactly the room the wallet's unspent credits leave below those credits.
--   * wallet_guard and snapshot_guard (0035), replaced with the same signatures: the owner
--     may fund the wallet revision a renewal names with exactly the units it added, which
--     must be the room below the current terms' credits (review R1), and an operator
--     snapshot takes a successor only of the same grant, from the owner, for an active
--     account (review R3), naming the renewal of that revision, its digest and its period,
--     which starts no earlier than the previous period ended. Everything 0035 refused is
--     still refused.
--   * operator_test_entitlement_renew: the operator function (0035's idiom: owned by the
--     owner, INVOKER, granted to nobody; only staging:test-credits runs it, as
--     morrow_work_owner inside the administrator's own transaction under the D4 SET-row
--     protocol).
-- Credits come only from the versioned terms (P01.T04a R10), read exactly as 0035's grant
-- reads them: a period's credits are the units of the current terms revision's one
-- operator_test_entitlement entry, the source the grant's own credits came from, and the
-- renewal records that revision. No argument names an amount. Raising them (ADR-0035 item
-- 4) is a new staging BillingTerms revision, published only with the owner's per-use
-- approval; the next renewal reads it. A renewal tops the wallet's unspent credits
-- (available plus reserved) up to the period's credits and never above them; it adds
-- nothing when they are already there. Periods follow one grid: the grant's period is
-- period 0; period k (k >= 1) starts 720 hours times (k - 1) after the grant's period
-- ended and lasts 720 hours. A renewal writes only the period that contains the
-- database's clock, so a second run in the same period writes nothing (current). No
-- receipt, verified payment event or credit_grants row is written, and the route, the
-- account and the grant record are never changed.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_billing.operator_test_entitlements') IS NULL OR to_regclass('morrow_billing.platform_environment') IS NULL
 OR to_regclass('morrow_billing.billing_terms') IS NULL
 OR to_regclass('morrow_billing.credit_wallets') IS NULL OR to_regclass('morrow_billing.entitlement_snapshots') IS NULL
 OR to_regclass('morrow_billing.billing_accounts') IS NULL OR to_regclass('morrow_billing.workspace_billing_routes') IS NULL
 OR to_regprocedure('morrow_billing.operator_test_entitlement_grant(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL
 OR to_regclass('morrow_billing.operator_test_entitlement_renewals') IS NOT NULL
 OR to_regprocedure('morrow_billing.operator_test_entitlement_renew(text,text,text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_billing.renewal_guard()') IS NOT NULL
 -- The two guards this file replaces, exactly as 0035 wrote them (a later revision is
 -- never overwritten blind).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_billing.wallet_guard()'))
  IS DISTINCT FROM 'fe1661bb147dcb19093955eae4d1858f'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_billing.snapshot_guard()'))
  IS DISTINCT FROM '51bed727bde380b2117303dbfe731eee'
 THEN RAISE EXCEPTION 'STAGING_TEST_CREDITS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- One renewed period of one operator grant. Fixed grammars only; no free text. credit_units
-- are the operator entry's units in terms_revision, the current revision when the renewal
-- ran. funded_wallet_revision is the wallet revision the renewal funded, absent when it
-- added nothing.
CREATE TABLE morrow_billing.operator_test_entitlement_renewals (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 entitlement_id morrow_work.record_id NOT NULL,
 billing_account_id morrow_work.record_id NOT NULL,
 period_number integer NOT NULL CHECK (period_number BETWEEN 1 AND 100000),
 standing_approval text NOT NULL CHECK (standing_approval ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
 operator_id text NOT NULL CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 evidence_ref text NOT NULL CHECK (evidence_ref ~ '^docs/evidence/live/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]{1,80}[.]md$'),
 mode text NOT NULL CHECK (mode='test'),
 credit_units bigint NOT NULL CHECK (credit_units BETWEEN 1 AND 999999999999999999),
 terms_revision morrow_work.revision NOT NULL REFERENCES morrow_billing.billing_terms(terms_revision),
 added_units bigint NOT NULL CHECK (added_units>=0 AND added_units<=credit_units),
 funded_wallet_revision morrow_work.revision,
 snapshot_revision morrow_work.revision NOT NULL CHECK (snapshot_revision>=2),
 period_start timestamptz NOT NULL CHECK (period_start=date_trunc('milliseconds',period_start) AND period_start>=timestamptz '2000-01-01T00:00:00Z' AND period_start<timestamptz '9000-01-01T00:00:00Z'),
 period_end timestamptz NOT NULL,
 evidence_digest morrow_work.digest NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,entitlement_id,period_number),
 UNIQUE (organization_id,workspace_id,billing_account_id,snapshot_revision),
 UNIQUE (organization_id,workspace_id,billing_account_id,funded_wallet_revision),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,billing_account_id) REFERENCES morrow_billing.billing_accounts(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,entitlement_id) REFERENCES morrow_billing.operator_test_entitlements(organization_id,workspace_id,id),
 CONSTRAINT operator_test_entitlement_renewals_period CHECK (period_end=period_start+interval '720 hours'
  AND recorded_at>=period_start AND recorded_at<period_end),
 CONSTRAINT operator_test_entitlement_renewals_funding CHECK ((funded_wallet_revision IS NULL)=(added_units=0))
);
ALTER TABLE morrow_billing.operator_test_entitlement_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_billing.operator_test_entitlement_renewals FORCE ROW LEVEL SECURITY;
CREATE POLICY work_owner ON morrow_billing.operator_test_entitlement_renewals TO morrow_work_owner USING (true) WITH CHECK (true);
REVOKE ALL ON morrow_billing.operator_test_entitlement_renewals FROM PUBLIC;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_billing.operator_test_entitlement_renewals
 FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_billing.operator_test_entitlement_renewals
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();

-- A renewal record names exactly what the renewal would write now (review R1 of the PR 6
-- security review): the operator function is not the owner role's only way to insert, so
-- an INSERT by hand is held to the function's own reads. The grant is of the same tenant
-- and account; the route, account, wallet and latest snapshot are that grant's (the
-- function's route_conflict rules: Morrow-direct test route fixed by the grant's key,
-- never Shopify-bound, an active account); the period is the one on the grant's grid that
-- contains the database's clock and starts no earlier than the latest snapshot's period
-- ended; the snapshot revision is the next one; the credits and terms revision are the
-- current terms' one operator entry; and the units added are exactly the room the
-- wallet's unspent credits (available plus reserved) leave below those credits, funding
-- the wallet's next revision, or nothing. The recorded time is the database's clock, not
-- the writer's value.
CREATE FUNCTION morrow_billing.renewal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE g record; rt record; a record; w record; s record; t record; v_environment text; v_count integer; v_units bigint;
 v_key text; v_now timestamptz; v_k bigint; v_start timestamptz; v_room numeric;
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'morrow_work_owner' THEN RAISE EXCEPTION 'BILLING_RENEWAL_INVALID'; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 NEW.recorded_at:=v_now;
 v_key:='morrow:operator_entitlement:'||NEW.entitlement_id::text;
 SELECT x.environment INTO v_environment FROM morrow_billing.platform_environment x;
 SELECT x.billing_account_id::text AS billing_account_id,x.period_end INTO g FROM morrow_billing.operator_test_entitlements x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.entitlement_id;
 SELECT x.route,x.mode,x.fixing_payment_key,x.shopify_bound_at INTO rt FROM morrow_billing.workspace_billing_routes x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id;
 SELECT x.route,x.mode,x.status INTO a FROM morrow_billing.billing_accounts x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.billing_account_id;
 SELECT x.available,x.reserved,x.revision::bigint AS revision INTO w FROM morrow_billing.credit_wallets x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.billing_account_id=NEW.billing_account_id;
 SELECT x.revision::bigint AS revision,x.subscription_key,x.valid_until INTO s FROM morrow_billing.entitlement_snapshots x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.billing_account_id=NEW.billing_account_id
  ORDER BY x.revision DESC LIMIT 1;
 -- The current terms' one operator entry, as the renewal reads it (R10).
 SELECT x.terms_revision::bigint AS terms_revision,x.terms INTO t FROM morrow_billing.billing_terms x
  ORDER BY x.terms_revision DESC LIMIT 1;
 SELECT count(*)::integer,max((e->>'creditUnits')::bigint) INTO v_count,v_units FROM jsonb_array_elements(t.terms->'entries') e
  WHERE e->>'kind'='operator_test_entitlement' AND e->>'route'='morrow_direct' AND e->>'mode'='test';
 -- The period on the grant's grid that contains the clock.
 v_k:=1+floor((extract(epoch FROM v_now)-extract(epoch FROM g.period_end))/2592000);
 v_start:=g.period_end+(v_k-1)*interval '720 hours';
 v_room:=v_units::numeric-(w.available::numeric+w.reserved);
 IF v_environment IS DISTINCT FROM 'staging' OR g.billing_account_id IS DISTINCT FROM NEW.billing_account_id::text
  OR rt.route IS DISTINCT FROM 'morrow_direct' OR rt.mode IS DISTINCT FROM 'test' OR rt.fixing_payment_key IS DISTINCT FROM v_key
  OR rt.shopify_bound_at IS NOT NULL
  OR a.route IS DISTINCT FROM 'morrow_direct' OR a.mode IS DISTINCT FROM 'test' OR a.status IS DISTINCT FROM 'active'
  OR w.revision IS NULL OR s.subscription_key IS DISTINCT FROM v_key
  OR NEW.period_number IS DISTINCT FROM v_k OR NEW.period_start IS DISTINCT FROM v_start
  OR COALESCE(v_start<s.valid_until,true) OR NEW.snapshot_revision IS DISTINCT FROM s.revision+1
  OR v_count IS DISTINCT FROM 1 OR NEW.terms_revision IS DISTINCT FROM t.terms_revision
  OR NEW.credit_units IS DISTINCT FROM v_units OR v_room IS NULL
  OR NEW.added_units IS DISTINCT FROM greatest(0,v_room)
  OR NEW.funded_wallet_revision IS DISTINCT FROM (CASE WHEN v_room>0 THEN w.revision+1 END) THEN
  RAISE EXCEPTION 'BILLING_RENEWAL_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_billing.renewal_guard() FROM PUBLIC;
CREATE TRIGGER renewal_guard BEFORE INSERT ON morrow_billing.operator_test_entitlement_renewals
 FOR EACH ROW EXECUTE FUNCTION morrow_billing.renewal_guard();

-- ---------------------------------------------------------------------------
-- Snapshots (0035), plus: an operator snapshot's successor is the same grant's renewal.
-- Revision 1 is still the grant's own snapshot, exactly as 0035 checks it. A later
-- revision of an operator snapshot must keep its key, be active, come from the owner,
-- be of an active account (review R3: the renewal refuses any other), start no earlier
-- than the previous period ended, and match the renewal record that names this revision
-- (the grant's key, the renewal's digest and its period). Any other successor of an
-- operator snapshot, a Stripe one included, is still refused.
CREATE OR REPLACE FUNCTION morrow_billing.snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE a record; p record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BILLING_SNAPSHOT_IMMUTABLE'; END IF;
 SELECT x.route,x.mode,x.status INTO a FROM morrow_billing.billing_accounts x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.billing_account_id;
 SELECT x.revision::bigint AS revision,x.subscription_key,x.status,x.valid_until INTO p FROM morrow_billing.entitlement_snapshots x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.billing_account_id=NEW.billing_account_id
  ORDER BY x.revision DESC LIMIT 1;
 IF a.route IS DISTINCT FROM NEW.route OR a.mode IS DISTINCT FROM NEW.mode
  OR NEW.revision<>COALESCE(p.revision,0)+1
  OR (p.status='cancelled' AND p.subscription_key=NEW.subscription_key AND NEW.status<>'cancelled')
  OR (p.subscription_key ~ '^morrow:operator_entitlement:' AND NEW.subscription_key IS DISTINCT FROM p.subscription_key) THEN
  RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID';
 END IF;
 IF NEW.subscription_key ~ '^morrow:operator_entitlement:' THEN
  IF current_user<>'morrow_work_owner' OR NEW.status<>'active' THEN RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID'; END IF;
  IF NEW.revision=1 THEN
   IF NOT EXISTS(SELECT 1 FROM morrow_billing.operator_test_entitlements g WHERE g.organization_id=NEW.organization_id
     AND g.workspace_id=NEW.workspace_id AND g.billing_account_id=NEW.billing_account_id
     AND 'morrow:operator_entitlement:'||g.id::text=NEW.subscription_key AND g.evidence_digest=NEW.provider_evidence_ref
     AND g.period_start=NEW.verified_at AND g.period_end=NEW.valid_until) THEN
    RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID';
   END IF;
  ELSE
   IF p.subscription_key IS DISTINCT FROM NEW.subscription_key OR NEW.verified_at<p.valid_until
    OR a.status IS DISTINCT FROM 'active'
    OR NOT EXISTS(SELECT 1 FROM morrow_billing.operator_test_entitlement_renewals r
     JOIN morrow_billing.operator_test_entitlements g ON g.organization_id=r.organization_id AND g.workspace_id=r.workspace_id
      AND g.id=r.entitlement_id AND g.billing_account_id=r.billing_account_id
     WHERE r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.billing_account_id=NEW.billing_account_id
      AND r.snapshot_revision=NEW.revision AND 'morrow:operator_entitlement:'||g.id::text=NEW.subscription_key
      AND r.evidence_digest=NEW.provider_evidence_ref AND r.period_start=NEW.verified_at AND r.period_end=NEW.valid_until) THEN
    RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- Wallets (0035), plus: the owner's renewal funds the wallet revision its record names
-- with exactly the units it added, and only when those are the room the wallet's unspent
-- credits leave below the renewal's credits, which are the current terms' one operator
-- entry of the current terms revision (review R1: a record alone never bounds a funding).
-- Every other rule is 0035's: a payment's grant, the operator grant's first funding, and
-- moves that keep the sum.
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
   IF EXISTS(SELECT 1 FROM morrow_billing.operator_test_entitlement_renewals r
     CROSS JOIN LATERAL (SELECT x.terms_revision::bigint AS terms_revision,x.terms FROM morrow_billing.billing_terms x
      ORDER BY x.terms_revision DESC LIMIT 1) t
     WHERE r.organization_id=NEW.organization_id
     AND r.workspace_id=NEW.workspace_id AND r.billing_account_id=NEW.billing_account_id AND r.funded_wallet_revision=NEW.revision
     AND r.added_units=v_delta AND v_delta=r.credit_units-(OLD.available::numeric+OLD.reserved)
     AND r.terms_revision=t.terms_revision
     AND r.credit_units=(SELECT CASE WHEN count(*)=1 THEN max((e->>'creditUnits')::bigint) END
      FROM jsonb_array_elements(t.terms->'entries') e
      WHERE e->>'kind'='operator_test_entitlement' AND e->>'route'='morrow_direct' AND e->>'mode'='test')) THEN
    RETURN NEW;
   END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'BILLING_WALLET_INVALID';
END $$;

-- ---------------------------------------------------------------------------
-- The renewal (0035's operator idiom: owned by the owner, INVOKER, granted to nobody). Only
-- the owner's audited script runs it (staging:test-credits renew), as morrow_work_owner
-- inside the administrator's own transaction under the D4 SET-row protocol, after that
-- transaction has read, as morrow_identity_owner, that the workspace is the one the
-- environment's live-store app invites. The workspace and the grant come from the
-- committed record the script reads at verified main, never from a client value, and no
-- argument names an amount: the credits are the current terms' (R10).
--   refuses: any work session, lease or receipt context, any Morrow login as session user
--   (denied); a malformed value (invalid); a database not marked staging (not_staging); no
--   grant under that approval reference, or one of another workspace (grant_missing); a
--   route, account, wallet or latest snapshot that is not the grant's own (route_conflict);
--   no single operator entry in the current terms when a period is due (terms_missing).
--   current: the latest snapshot's period still contains the clock; writes nothing and
--   reports that period with the credits and terms revision it was written with.
--   renewed, in this order and this one transaction: the renewal record, the wallet's
--   top-up when it adds anything, and the next snapshot (active for the period).
-- The result names ids, the period, credits, the terms revision, units added and the
-- revisions; never store data.
CREATE FUNCTION morrow_billing.operator_test_entitlement_renew(p_operator_id text,p_workspace_id text,p_grant_approval_ref text,
 p_standing_approval text,p_evidence_ref text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE
 g record; r record; a record; w record; s record; n record; v_environment text; v_terms record; v_entry jsonb;
 v_count integer; v_units bigint; v_now timestamptz; v_k integer; v_start timestamptz; v_end timestamptz; v_added bigint;
 v_funded bigint; v_wallet_revision bigint; v_available bigint; v_id text; v_key text; v_digest text;
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
  OR p_grant_approval_ref IS NULL OR p_grant_approval_ref !~ '^[a-z0-9][a-z0-9-]{0,40}[.]e[1-9][0-9]{0,2}[.][0-9]{4}-[0-9]{2}-[0-9]{2}[.][1-9][0-9]{0,2}$'
  OR p_standing_approval IS NULL OR p_standing_approval !~ '^[a-z0-9][a-z0-9-]{0,40}$'
  OR p_evidence_ref IS NULL OR p_evidence_ref !~ '^docs/evidence/live/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]{1,80}[.]md$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.environment INTO v_environment FROM morrow_billing.platform_environment x;
 IF v_environment IS DISTINCT FROM 'staging' THEN RETURN QUERY SELECT 'not_staging'::text,NULL::text; RETURN; END IF;
 -- One renewal of a workspace at a time: its lock, then the grant, then the wallet's row
 -- lock (the lock every reservation takes).
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.billing.operator_test_entitlement_renew',p_workspace_id)::text,0));
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.id::text AS id,
  x.billing_account_id::text AS billing_account_id,x.credit_units,x.terms_revision::bigint AS terms_revision,x.period_end INTO g
  FROM morrow_billing.operator_test_entitlements x WHERE x.approval_ref=p_grant_approval_ref;
 IF NOT FOUND OR g.workspace_id<>p_workspace_id THEN RETURN QUERY SELECT 'grant_missing'::text,NULL::text; RETURN; END IF;
 v_key:='morrow:operator_entitlement:'||g.id;
 SELECT x.route,x.mode,x.fixing_payment_key,x.shopify_bound_at INTO r FROM morrow_billing.workspace_billing_routes x
  WHERE x.organization_id=g.organization_id AND x.workspace_id=g.workspace_id;
 SELECT x.route,x.mode,x.status INTO a FROM morrow_billing.billing_accounts x
  WHERE x.organization_id=g.organization_id AND x.workspace_id=g.workspace_id AND x.id=g.billing_account_id;
 SELECT x.available,x.reserved,x.revision::bigint AS revision,x.updated_at INTO w FROM morrow_billing.credit_wallets x
  WHERE x.organization_id=g.organization_id AND x.workspace_id=g.workspace_id AND x.billing_account_id=g.billing_account_id FOR UPDATE;
 SELECT x.revision::bigint AS revision,x.subscription_key,x.verified_at,x.valid_until INTO s FROM morrow_billing.entitlement_snapshots x
  WHERE x.organization_id=g.organization_id AND x.workspace_id=g.workspace_id AND x.billing_account_id=g.billing_account_id
  ORDER BY x.revision DESC LIMIT 1;
 IF r.route IS DISTINCT FROM 'morrow_direct' OR r.mode IS DISTINCT FROM 'test' OR r.fixing_payment_key IS DISTINCT FROM v_key
  OR r.shopify_bound_at IS NOT NULL
  OR a.route IS DISTINCT FROM 'morrow_direct' OR a.mode IS DISTINCT FROM 'test' OR a.status IS DISTINCT FROM 'active'
  OR w.revision IS NULL OR s.subscription_key IS DISTINCT FROM v_key THEN
  RETURN QUERY SELECT 'route_conflict'::text,NULL::text; RETURN;
 END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 IF v_now<s.valid_until THEN
  -- The period that contains the clock is already written: the grant's (period 0) or a
  -- renewal's. Nothing is written.
  SELECT x.id::text AS id,x.period_number,x.credit_units,x.terms_revision::bigint AS terms_revision,x.added_units INTO n
   FROM morrow_billing.operator_test_entitlement_renewals x
   WHERE x.organization_id=g.organization_id AND x.workspace_id=g.workspace_id AND x.billing_account_id=g.billing_account_id
    AND x.snapshot_revision=s.revision;
  RETURN QUERY SELECT 'current'::text,jsonb_build_object('entitlementId',g.id,'organizationId',g.organization_id,
   'workspaceId',g.workspace_id,'billingAccountId',g.billing_account_id,'renewalId',n.id,
   'period',COALESCE(n.period_number,0)::text,'periodStart',morrow_work.utc_text(s.verified_at),
   'periodEnd',morrow_work.utc_text(s.valid_until),'creditUnits',COALESCE(n.credit_units,g.credit_units)::text,
   'termsRevision',COALESCE(n.terms_revision,g.terms_revision)::text,
   'addedUnits',COALESCE(n.added_units,g.credit_units)::text,'snapshotRevision',s.revision::text,
   'walletRevision',w.revision::text,'available',w.available::text)::text;
  RETURN;
 END IF;
 -- The period that contains the clock, on the grid that starts where the grant's ended.
 v_k:=1+floor((extract(epoch FROM v_now)-extract(epoch FROM g.period_end))/2592000)::integer;
 v_start:=g.period_end+(v_k-1)*interval '720 hours';
 v_end:=v_start+interval '720 hours';
 IF v_k<1 OR v_k>100000 OR v_start<s.valid_until OR v_now<v_start OR v_now>=v_end THEN
  RETURN QUERY SELECT 'route_conflict'::text,NULL::text; RETURN;
 END IF;
 -- R10: the period's credits come only from the current terms' one operator entry, read
 -- exactly as 0035's grant reads it. A later staging terms revision (the owner's raise)
 -- reaches the next renewal; nothing the caller passes does.
 SELECT x.terms_revision::bigint AS terms_revision,x.terms INTO v_terms FROM morrow_billing.billing_terms x
  ORDER BY x.terms_revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'terms_missing'::text,NULL::text; RETURN; END IF;
 SELECT count(*)::integer,(array_agg(e))[1] INTO v_count,v_entry FROM jsonb_array_elements(v_terms.terms->'entries') e
  WHERE e->>'kind'='operator_test_entitlement' AND e->>'route'='morrow_direct' AND e->>'mode'='test';
 IF v_count<>1 THEN RETURN QUERY SELECT 'terms_missing'::text,NULL::text; RETURN; END IF;
 v_units:=(v_entry->>'creditUnits')::bigint;
 IF v_units<=0 THEN RETURN QUERY SELECT 'terms_missing'::text,NULL::text; RETURN; END IF;
 -- Top up the unspent credits (available plus reserved) to the period's credits, never
 -- above them.
 v_added:=greatest(0,v_units-(w.available+w.reserved));
 v_funded:=CASE WHEN v_added>0 THEN w.revision+1 ELSE NULL END;
 v_id:=gen_random_uuid()::text;
 v_digest:=morrow_work.sha256_text(array_to_json(ARRAY['morrow.billing.operator_test_entitlement_renewal','1',v_id,g.organization_id,
  g.workspace_id,g.billing_account_id,g.id,p_grant_approval_ref,p_standing_approval,p_operator_id,p_evidence_ref,
  v_k::text,v_units::text,v_terms.terms_revision::text,v_added::text,morrow_work.utc_text(v_start),
  morrow_work.utc_text(v_end)])::text);
 INSERT INTO morrow_billing.operator_test_entitlement_renewals(organization_id,workspace_id,id,entitlement_id,billing_account_id,
  period_number,standing_approval,operator_id,evidence_ref,mode,credit_units,terms_revision,added_units,funded_wallet_revision,
  snapshot_revision,period_start,period_end,evidence_digest,recorded_at)
 VALUES (g.organization_id,g.workspace_id,v_id,g.id,g.billing_account_id,v_k,p_standing_approval,p_operator_id,p_evidence_ref,
  'test',v_units,v_terms.terms_revision,v_added,v_funded,s.revision+1,v_start,v_end,v_digest,v_now);
 v_wallet_revision:=w.revision; v_available:=w.available;
 IF v_added>0 THEN
  UPDATE morrow_billing.credit_wallets x SET available=x.available+v_added,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=g.organization_id AND x.workspace_id=g.workspace_id AND x.billing_account_id=g.billing_account_id
   RETURNING x.revision::bigint,x.available INTO v_wallet_revision,v_available;
 END IF;
 INSERT INTO morrow_billing.entitlement_snapshots(organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,
  provider_evidence_ref,verified_at,valid_until,receipt_id,recorded_at)
 VALUES (g.organization_id,g.workspace_id,g.billing_account_id,s.revision+1,'morrow_direct','test',v_key,'active',v_digest,v_start,v_end,
  NULL,v_now);
 RETURN QUERY SELECT 'renewed'::text,jsonb_build_object('entitlementId',g.id,'organizationId',g.organization_id,
  'workspaceId',g.workspace_id,'billingAccountId',g.billing_account_id,'renewalId',v_id,'period',v_k::text,
  'periodStart',morrow_work.utc_text(v_start),'periodEnd',morrow_work.utc_text(v_end),'creditUnits',v_units::text,
  'termsRevision',v_terms.terms_revision::text,'addedUnits',v_added::text,'snapshotRevision',(s.revision+1)::text,
  'walletRevision',v_wallet_revision::text,'available',v_available::text)::text;
END $$;
REVOKE ALL ON FUNCTION morrow_billing.operator_test_entitlement_renew(text,text,text,text,text) FROM PUBLIC;
COMMIT;
