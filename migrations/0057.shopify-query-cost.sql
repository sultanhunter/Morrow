BEGIN;
-- Plan row SD5 of docs/plan/store-data-foundation-implementation.md (a P09.T03 child; ADR-0043,
-- ADR-0044; docs/briefs/sd5-shopify-query-cost.md): per-shop buckets for Shopify's API query
-- cost. Shopify's rate limit, counted in Shopify's GraphQL query-cost points, never money:
-- nothing here holds, draws or checks credits (ADR-0039, OD-2026-10-26-12).
-- Executes AS morrow_work_owner, after 0056 (credits-only-catalogue). No external effect:
-- nothing here sends a request; the broker calls the two definers around each fixed Shopify
-- document while its switch (MORROW_SHOPIFY_QUERY_COST, docs/decisions/
-- shopify-query-cost-staging.json) is on, and the switch is committed off.
--   * morrow_work.rate_buckets: one token bucket per (workspace, provider, subject). For
--     Shopify the subject is the store installation, which is one (shop, app) pair while it
--     is live (0053's store_installations_one_live_app_shop), so the bucket models Shopify's
--     own per-app, per-shop bucket: its capacity, its restore rate per second and the points
--     available at as_of, refilled by the database clock and corrected from the
--     throttleStatus each reply carries. Content-free: ids, numbers, times and three counts
--     (reads admitted, told to wait, and THROTTLED replies) for the operator's metrics (SD22).
--     A reinstall is a new installation and starts a new bucket at the defaults, which the
--     first reply corrects. CS7's per-connection buckets reuse the table and both helpers
--     with their own provider value, in their own forward migration.
--   * morrow_work.rate_bucket_policy(): the classes in priority order and the share of the
--     bucket each leaves untouched for the classes above it (write 0, person_read 0.10,
--     agent_read 0.30, reconciliation 0.50, bulk 0.70: the headroom kept for writes), the
--     defaults before Shopify's first report (1,000 points, 50 a second: Shopify's smallest
--     published bucket) and the dearest single document Shopify runs (1,000 points). Its
--     values are policy, drift-tested against apps/broker/src/shopify-query-cost.ts; the
--     CHECKs below hold only safety ranges.
--   * morrow_work.rate_bucket_take and rate_bucket_settle: INVOKER helpers owned by the owner,
--     EXECUTE for the command role only (the definers below are their only callers), each
--     under the bucket's row lock:
--       take    refills by time, then charges the document's known cost before it is sent.
--               A write is always admitted (it never waits on the bucket: Shopify's own
--               THROTTLED reply, which proves nothing ran, is its only limit, and the
--               gateway's one wait and resend stay as they are), taking the points down to 0
--               at most. Every other class is admitted only while the points left after it
--               stay at or above its share; otherwise it is told how long to wait
--               (`wait`, 1 ms to one hour), and the broker waits or parks the read (an agent
--               read parks; H7b's run.wait consumes the parked result). A document dearer
--               than the bucket can ever hold for its class is `too_costly`. The first take
--               creates the bucket at the defaults.
--       settle  refunds what the reply proves was not used (all of it for THROTTLED, which
--               ran nothing; the requested cost less Shopify's actualQueryCost otherwise),
--               adopts Shopify's reported capacity and restore rate, and never keeps more
--               points than Shopify reported available: the model only ever errs low.
--   * morrow_vault.shopify_query_cost_take and shopify_query_cost_settle: the broker's own
--     definers (SECURITY DEFINER, owned by morrow_work_command after the transfer below,
--     guarded by work_executor_safe('morrow_vault_broker'), EXECUTE for morrow_vault_broker
--     only). Ids, closed codes and numbers in; codes and a wait out. The tenant comes only
--     from the installation row (work_shopify_check_target: a live installation of an active
--     app), never from the caller. Each is one round trip: one statement does the check, the
--     lock, the arithmetic and the write.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.rate_buckets') IS NOT NULL
 OR to_regprocedure('morrow_work.rate_bucket_policy()') IS NOT NULL
 OR to_regprocedure('morrow_vault.shopify_query_cost_take(text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_vault.shopify_query_cost_settle(text,text,text,text,text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_check_target(text)','EXECUTE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_work' AND p.policyname='broker_rate_bucket')
 THEN RAISE EXCEPTION 'SHOPIFY_QUERY_COST_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The policy (IMMUTABLE, owned by the owner, EXECUTE for the command role only): one row per
-- class of the provider, in priority order. A later forward migration revises the values.
CREATE FUNCTION morrow_work.rate_bucket_policy()
RETURNS TABLE(provider text,unit text,class text,priority integer,floor_share numeric,default_capacity numeric,
 default_restore_rate numeric,max_cost integer)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT 'shopify'::text,'query_cost_points'::text,c.class,c.priority,c.floor_share,1000::numeric,50::numeric,1000
 FROM (VALUES ('write',1,0.00::numeric),('person_read',2,0.10::numeric),('agent_read',3,0.30::numeric),
  ('reconciliation',4,0.50::numeric),('bulk',5,0.70::numeric)) c(class,priority,floor_share)
$$;

-- ---------------------------------------------------------------------------
-- The buckets. Every stored time is millisecond-truncated; points are kept to 3 decimals.
CREATE TABLE morrow_work.rate_buckets (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 provider text NOT NULL CHECK (provider='shopify'),
 subject_id morrow_work.record_id NOT NULL,
 unit text NOT NULL CHECK (unit='query_cost_points'),
 capacity numeric(12,3) NOT NULL CHECK (capacity BETWEEN 100 AND 1000000),
 restore_rate numeric(12,3) NOT NULL CHECK (restore_rate BETWEEN 1 AND 100000),
 available numeric(12,3) NOT NULL CHECK (available>=0),
 as_of timestamptz NOT NULL CHECK (as_of=date_trunc('milliseconds',as_of) AND isfinite(as_of)),
 observed_at timestamptz CHECK (observed_at=date_trunc('milliseconds',observed_at) AND isfinite(observed_at)),
 admitted_count bigint NOT NULL CHECK (admitted_count>=0),
 waited_count bigint NOT NULL CHECK (waited_count>=0),
 throttled_count bigint NOT NULL CHECK (throttled_count>=0),
 revision morrow_work.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z'
  AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,provider,subject_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT rate_buckets_points CHECK (available<=capacity),
 CONSTRAINT rate_buckets_times CHECK (as_of>=created_at AND (observed_at IS NULL OR observed_at>=created_at))
);
-- One bucket per subject across every tenant (an installation id is global).
CREATE UNIQUE INDEX rate_buckets_subject ON morrow_work.rate_buckets (provider,subject_id);

-- The guard (INVOKER, owned by the owner, granted to nobody): a bucket is born at revision 1
-- with nothing counted or observed and as_of at its creation; afterwards revision+1, its
-- identity and creation never change, as_of and observed_at never go back, and the counts
-- only grow. Nothing is deleted or truncated.
CREATE FUNCTION morrow_work.rate_bucket_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['capacity','restore_rate','available','as_of','observed_at','admitted_count','waited_count',
 'throttled_count','revision'];
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'RATE_BUCKET_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.as_of<>NEW.created_at OR NEW.observed_at IS NOT NULL OR NEW.admitted_count<>0 OR NEW.waited_count<>0
   OR NEW.throttled_count<>0 THEN
   RAISE EXCEPTION 'RATE_BUCKET_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.as_of<OLD.as_of
  OR (OLD.observed_at IS NOT NULL AND (NEW.observed_at IS NULL OR NEW.observed_at<OLD.observed_at))
  OR NEW.admitted_count<OLD.admitted_count OR NEW.waited_count<OLD.waited_count OR NEW.throttled_count<OLD.throttled_count
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'RATE_BUCKET_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.rate_bucket_guard() FROM PUBLIC;
CREATE TRIGGER rate_bucket_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_work.rate_buckets
 FOR EACH ROW EXECUTE FUNCTION morrow_work.rate_bucket_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.rate_buckets FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();

-- Row security: ENABLE + FORCE; the maintenance-only owner policy; the session template, read
-- only (tenant_command FOR SELECT: no session definer reads or writes a bucket); and the
-- broker's context: the session user is the broker's own login and morrow.vault_rate_bucket
-- names exactly org|ws|provider|subject. Only the two definers below write that setting,
-- from the installation row itself, and clear it before they return; the broker's login
-- holds no table privilege, so a setting it forges reaches nothing.
ALTER TABLE morrow_work.rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_work.rate_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON morrow_work.rate_buckets FROM PUBLIC;
CREATE POLICY work_owner ON morrow_work.rate_buckets TO morrow_work_owner USING (true) WITH CHECK (true);
CREATE POLICY tenant_command ON morrow_work.rate_buckets FOR SELECT TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
CREATE POLICY broker_rate_bucket ON morrow_work.rate_buckets TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||provider||'|'||subject_id::text=pg_catalog.current_setting('morrow.vault_rate_bucket',true))
 WITH CHECK (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||provider||'|'||subject_id::text=pg_catalog.current_setting('morrow.vault_rate_bucket',true));
-- Privileges: SELECT and INSERT, column-scoped UPDATE; no DELETE or TRUNCATE for anyone.
GRANT SELECT,INSERT ON morrow_work.rate_buckets TO morrow_work_command;
GRANT UPDATE (capacity,restore_rate,available,as_of,observed_at,admitted_count,waited_count,throttled_count,revision)
 ON morrow_work.rate_buckets TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- The take (see the header). Outcomes: admitted (wait_ms 0), wait (wait_ms 1 to 3,600,000),
-- too_costly, invalid. Never back-dated: the clock is the later of the database's and as_of.
CREATE FUNCTION morrow_work.rate_bucket_take(p_org text,p_ws text,p_provider text,p_subject text,p_class text,p_cost integer)
RETURNS TABLE(outcome text,wait_ms integer)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; b morrow_work.rate_buckets%ROWTYPE; v_now timestamptz; v_avail numeric; v_floor numeric; v_wait numeric; n integer;
BEGIN
 SELECT x.unit,x.floor_share,x.default_capacity,x.default_restore_rate,x.max_cost INTO p
  FROM morrow_work.rate_bucket_policy() x WHERE x.provider=p_provider AND x.class=p_class;
 IF NOT FOUND OR p_org IS NULL OR p_ws IS NULL OR p_subject IS NULL OR p_cost IS NULL OR p_cost<1 OR p_cost>p.max_cost THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
 END IF;
 SELECT * INTO b FROM morrow_work.rate_buckets x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.provider=p_provider AND x.subject_id=p_subject FOR UPDATE;
 IF NOT FOUND THEN
  -- The first take: the bucket at the defaults (a concurrent first take may win the insert;
  -- either way the row is then locked here).
  v_now:=date_trunc('milliseconds',clock_timestamp());
  INSERT INTO morrow_work.rate_buckets(organization_id,workspace_id,provider,subject_id,unit,capacity,restore_rate,available,as_of,
   observed_at,admitted_count,waited_count,throttled_count,revision,created_at)
  VALUES (p_org,p_ws,p_provider,p_subject,p.unit,p.default_capacity,p.default_restore_rate,p.default_capacity,v_now,NULL,0,0,0,1,v_now)
  ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM morrow_work.rate_buckets x
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.provider=p_provider AND x.subject_id=p_subject FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RATE_BUCKET_INVALID'; END IF;
 END IF;
 v_now:=greatest(date_trunc('milliseconds',clock_timestamp()),b.as_of);
 v_avail:=round(least(b.capacity,b.available+b.restore_rate*extract(epoch FROM (v_now-b.as_of))),3);
 v_floor:=b.capacity*p.floor_share;
 IF v_floor+p_cost>b.capacity THEN RETURN QUERY SELECT 'too_costly'::text,NULL::integer; RETURN; END IF;
 IF p_class='write' OR v_avail-p_cost>=v_floor THEN
  UPDATE morrow_work.rate_buckets x SET available=greatest(0,v_avail-p_cost),as_of=v_now,admitted_count=x.admitted_count+1,
   revision=x.revision+1
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.provider=p_provider AND x.subject_id=p_subject;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'RATE_BUCKET_INVALID'; END IF;
  RETURN QUERY SELECT 'admitted'::text,0; RETURN;
 END IF;
 v_wait:=ceil((v_floor+p_cost-v_avail)/b.restore_rate*1000);
 UPDATE morrow_work.rate_buckets x SET available=v_avail,as_of=v_now,waited_count=x.waited_count+1,revision=x.revision+1
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.provider=p_provider AND x.subject_id=p_subject;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'RATE_BUCKET_INVALID'; END IF;
 RETURN QUERY SELECT 'wait'::text,least(3600000,greatest(1,v_wait))::integer;
END $$;
-- The settle (see the header): p_charged is what this call's take charged (0 when it took
-- nothing), p_actual Shopify's actualQueryCost (NULL when the reply did not say), p_available,
-- p_maximum and p_restore_rate Shopify's throttleStatus (each NULL when absent). Outcomes:
-- settled, not_found (no bucket yet: nothing was taken), invalid.
CREATE FUNCTION morrow_work.rate_bucket_settle(p_org text,p_ws text,p_provider text,p_subject text,p_charged integer,p_actual integer,
 p_available numeric,p_maximum numeric,p_restore_rate numeric,p_throttled boolean)
RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_max integer; b morrow_work.rate_buckets%ROWTYPE; v_now timestamptz; v_avail numeric; v_cap numeric; v_rate numeric;
 v_refund numeric; v_new numeric; v_observed boolean; n integer;
BEGIN
 SELECT max(x.max_cost) INTO v_max FROM morrow_work.rate_bucket_policy() x WHERE x.provider=p_provider;
 IF v_max IS NULL OR p_org IS NULL OR p_ws IS NULL OR p_subject IS NULL OR p_throttled IS NULL
  OR p_charged IS NULL OR p_charged<0 OR p_charged>v_max OR (p_actual IS NOT NULL AND (p_actual<0 OR p_actual>v_max))
  OR (p_available IS NOT NULL AND (p_available<0 OR p_available>1000000))
  OR (p_maximum IS NOT NULL AND (p_maximum<100 OR p_maximum>1000000))
  OR (p_restore_rate IS NOT NULL AND (p_restore_rate<1 OR p_restore_rate>100000)) THEN
  RETURN 'invalid';
 END IF;
 SELECT * INTO b FROM morrow_work.rate_buckets x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.provider=p_provider AND x.subject_id=p_subject FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 v_now:=greatest(date_trunc('milliseconds',clock_timestamp()),b.as_of);
 v_avail:=least(b.capacity,b.available+b.restore_rate*extract(epoch FROM (v_now-b.as_of)));
 v_cap:=COALESCE(round(p_maximum,3),b.capacity);
 v_rate:=COALESCE(round(p_restore_rate,3),b.restore_rate);
 v_refund:=CASE WHEN p_throttled THEN p_charged WHEN p_actual IS NOT NULL THEN greatest(0,p_charged-p_actual) ELSE 0 END;
 v_new:=least(v_cap,v_avail+v_refund);
 IF p_available IS NOT NULL THEN v_new:=least(v_new,p_available); END IF;
 v_new:=round(greatest(0,v_new),3);
 IF v_new>v_cap THEN v_new:=v_cap; END IF;
 v_observed:=p_available IS NOT NULL OR p_maximum IS NOT NULL OR p_restore_rate IS NOT NULL;
 UPDATE morrow_work.rate_buckets x SET capacity=v_cap,restore_rate=v_rate,available=v_new,as_of=v_now,
  observed_at=CASE WHEN v_observed THEN greatest(v_now,COALESCE(x.observed_at,v_now)) ELSE x.observed_at END,
  throttled_count=x.throttled_count+CASE WHEN p_throttled THEN 1 ELSE 0 END,revision=x.revision+1
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.provider=p_provider AND x.subject_id=p_subject;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'RATE_BUCKET_INVALID'; END IF;
 RETURN 'settled';
END $$;

-- ---------------------------------------------------------------------------
-- The broker's definers (see the header). Text parameters only: a class from the closed
-- list, a cost of 1 to 9,999 points (the helper bounds it by the policy's max_cost), and the
-- settle's counts and throttleStatus as decimal text (an absent value is NULL; the broker's
-- statement turns its empty string into NULL).
-- take: admitted, wait (with wait_ms), too_costly, not_found (no live installation of an
-- active app), invalid, denied.
CREATE FUNCTION morrow_vault.shopify_query_cost_take(p_installation_id text,p_class text,p_cost text)
RETURNS TABLE(outcome text,wait_ms text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; r record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_class IS NULL OR p_class NOT IN ('write','person_read','agent_read','reconciliation','bulk')
  OR p_cost IS NULL OR p_cost !~ '^[1-9][0-9]{0,3}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_check_target(p_installation_id);
 IF t.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT CASE WHEN t.outcome='invalid' THEN 'invalid' ELSE 'not_found' END::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_rate_bucket',t.organization_id||'|'||t.workspace_id||'|shopify|'||p_installation_id,true);
 SELECT x.outcome,x.wait_ms INTO r
  FROM morrow_work.rate_bucket_take(t.organization_id,t.workspace_id,'shopify',p_installation_id,p_class,p_cost::integer) x;
 PERFORM pg_catalog.set_config('morrow.vault_rate_bucket','',true);
 RETURN QUERY SELECT COALESCE(r.outcome,'invalid'),r.wait_ms::text;
END $$;
-- settle: settled, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_query_cost_settle(p_installation_id text,p_charged text,p_actual text,p_available text,p_maximum text,
 p_restore_rate text,p_throttled text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE t record; v_outcome text;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 IF p_charged IS NULL OR p_charged !~ '^(0|[1-9][0-9]{0,3})$' OR (p_actual IS NOT NULL AND p_actual !~ '^(0|[1-9][0-9]{0,3})$')
  OR (p_available IS NOT NULL AND p_available !~ '^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$')
  OR (p_maximum IS NOT NULL AND p_maximum !~ '^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$')
  OR (p_restore_rate IS NOT NULL AND p_restore_rate !~ '^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$')
  OR p_throttled IS NULL OR p_throttled NOT IN ('true','false') THEN
  RETURN 'invalid';
 END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_check_target(p_installation_id);
 IF t.outcome IS DISTINCT FROM 'found' THEN RETURN CASE WHEN t.outcome='invalid' THEN 'invalid' ELSE 'not_found' END; END IF;
 PERFORM pg_catalog.set_config('morrow.vault_rate_bucket',t.organization_id||'|'||t.workspace_id||'|shopify|'||p_installation_id,true);
 v_outcome:=morrow_work.rate_bucket_settle(t.organization_id,t.workspace_id,'shopify',p_installation_id,p_charged::integer,
  p_actual::integer,p_available::numeric,p_maximum::numeric,p_restore_rate::numeric,p_throttled::boolean);
 PERFORM pg_catalog.set_config('morrow.vault_rate_bucket','',true);
 RETURN COALESCE(v_outcome,'invalid');
END $$;

-- ---------------------------------------------------------------------------
-- Grants and owners.
REVOKE ALL ON FUNCTION morrow_work.rate_bucket_policy(),
 morrow_work.rate_bucket_take(text,text,text,text,text,integer),
 morrow_work.rate_bucket_settle(text,text,text,text,integer,integer,numeric,numeric,numeric,boolean),
 morrow_vault.shopify_query_cost_take(text,text,text),
 morrow_vault.shopify_query_cost_settle(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.rate_bucket_policy(),
 morrow_work.rate_bucket_take(text,text,text,text,text,integer),
 morrow_work.rate_bucket_settle(text,text,text,text,integer,integer,numeric,numeric,numeric,boolean) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_vault.shopify_query_cost_take(text,text,text),
 morrow_vault.shopify_query_cost_settle(text,text,text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_query_cost_take(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_query_cost_settle(text,text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
