BEGIN;
-- M3 PR-1 run credits (P11.T04a minimum; ADR-0022 item 11; mvp-architecture §9). Executes AS
-- morrow_work_owner. Credit and vendor-cost reservations of one run, the US$25 daily cap
-- and the per-billing-period unrecovered-cost ledger, with the helpers M3 PR-2's admission
-- and run definers call. Every amount is exact: credits are bigint, money numeric(20,8) USD.
--   * credit_reservations: one per run, keyed to M5 PR-1's credit wallet (billing account)
--     and a single-payer CostAllocation@2 (allocation id and digest, CreditReservation@1);
--     products x the selection's credits per product, settled at most at the reservation.
--   * vendor_cost_reservations: one per run, products x the selection's worst case, at the
--     run's catalogue version; booked cost never exceeds it; the run's billing period and
--     UTC day are recorded for the caps.
--   * unrecovered_costs and unrecovered_cost_entries: the AI cost of products that earned
--     no credit, `uncertain` bookings included, per workspace and billing period (M5 PR-1's
--     billingPeriod start); append-only entries and a monotone total.
--   * Helpers (owned by the owner, INVOKER, EXECUTE for the command role only, so a later
--     owner migration can revise them): run_reserve (under the wallet's row lock and the
--     workspace's daily interlock: refuses insufficient_credits, daily_cap,
--     unrecovered_cost_cap, run_product_limit, catalogue_inactive, no_billing_period or a
--     duplicate run), run_book_cost, run_settle, run_release and unrecovered_allows. Every
--     wallet move keeps available+reserved+consumed constant (M5's wallet_guard).
-- Wallet-dependent SQL (the foreign key and the wallet's lease policy) is isolated at the
-- end of this file so it can be reconciled with M5 PR-1's credit_wallets at rebase.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regclass('morrow_billing.credit_wallets') IS NULL
 OR to_regclass('morrow_work.model_catalogue_entries') IS NULL
 OR to_regclass('morrow_billing.credit_reservations') IS NOT NULL
 OR to_regprocedure('morrow_work.current_lease()') IS NULL OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_billing.credit_wallets'::regclass AND a.attname='billing_account_id')
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'RUN_CREDITS_PREREQUISITES_INVALID'; END IF;
END $$;

CREATE TABLE morrow_billing.credit_reservations (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 billing_account_id morrow_work.record_id NOT NULL,
 root_run_id morrow_work.record_id NOT NULL,
 allocation_id morrow_work.record_id NOT NULL,
 allocation_digest morrow_work.digest NOT NULL,
 catalogue_version integer NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 credits_per_product integer NOT NULL CHECK (credits_per_product BETWEEN 1 AND 99),
 product_count integer NOT NULL CHECK (product_count BETWEEN 1 AND 1000),
 credits_reserved bigint NOT NULL CHECK (credits_reserved>0),
 credits_settled bigint CHECK (credits_settled>=0),
 status text NOT NULL CHECK (status IN ('reserved','settled','released')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 settled_at timestamptz CHECK (settled_at=date_trunc('milliseconds',settled_at) AND isfinite(settled_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,root_run_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.model_catalogue_entries(version,model_key,effort_key),
 CONSTRAINT credit_reservations_amounts CHECK (credits_reserved=product_count::bigint*credits_per_product
  AND (credits_settled IS NULL OR credits_settled<=credits_reserved)),
 CONSTRAINT credit_reservations_status CHECK (CASE status WHEN 'reserved' THEN credits_settled IS NULL AND settled_at IS NULL
  WHEN 'settled' THEN credits_settled IS NOT NULL AND settled_at IS NOT NULL AND settled_at>=created_at
  ELSE credits_settled=0 AND settled_at IS NOT NULL AND settled_at>=created_at END)
);
CREATE TABLE morrow_billing.vendor_cost_reservations (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 root_run_id morrow_work.record_id NOT NULL,
 credit_reservation_id morrow_work.record_id NOT NULL,
 vendor_id text NOT NULL CHECK (vendor_id='anthropic'),
 catalogue_version integer NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 maximum_cost_usd numeric(20,8) NOT NULL CHECK (maximum_cost_usd>0),
 booked_cost_usd numeric(20,8) NOT NULL CHECK (booked_cost_usd>=0),
 unrecovered_cost_usd numeric(20,8) NOT NULL CHECK (unrecovered_cost_usd>=0),
 period_start timestamptz NOT NULL CHECK (period_start=date_trunc('milliseconds',period_start) AND isfinite(period_start)),
 created_day date NOT NULL,
 status text NOT NULL CHECK (status IN ('reserved','settled','released')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,root_run_id),
 FOREIGN KEY (organization_id,workspace_id,credit_reservation_id) REFERENCES morrow_billing.credit_reservations(organization_id,workspace_id,id),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.model_catalogue_entries(version,model_key,effort_key),
 CONSTRAINT vendor_cost_reservations_amounts CHECK (booked_cost_usd<=maximum_cost_usd AND unrecovered_cost_usd<=booked_cost_usd),
 CONSTRAINT vendor_cost_reservations_times CHECK (updated_at>=created_at AND created_day=(created_at AT TIME ZONE 'UTC')::date)
);
CREATE INDEX vendor_cost_reservations_day ON morrow_billing.vendor_cost_reservations (organization_id,workspace_id,created_day);
CREATE TABLE morrow_billing.unrecovered_costs (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 period_start timestamptz NOT NULL CHECK (period_start=date_trunc('milliseconds',period_start) AND isfinite(period_start)),
 amount_usd numeric(20,8) NOT NULL CHECK (amount_usd>=0),
 revision morrow_work.revision NOT NULL,
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,period_start),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id)
);
CREATE TABLE morrow_billing.unrecovered_cost_entries (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 period_start timestamptz NOT NULL,
 root_run_id morrow_work.record_id NOT NULL,
 vendor_reservation_id morrow_work.record_id NOT NULL,
 kind text NOT NULL CHECK (kind IN ('failed_product','uncertain_attempt')),
 amount_usd numeric(20,8) NOT NULL CHECK (amount_usd>0),
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND isfinite(recorded_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,period_start) REFERENCES morrow_billing.unrecovered_costs(organization_id,workspace_id,period_start),
 FOREIGN KEY (organization_id,workspace_id,vendor_reservation_id) REFERENCES morrow_billing.vendor_cost_reservations(organization_id,workspace_id,id)
);

-- Row security: ENABLE + FORCE, the owner's maintenance policy, the session's
-- tenant_command and the lease twin tenant_lease (M3 PR-2's run steps settle under a run
-- lease); the api reads the reservations column by column.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['credit_reservations','vendor_cost_reservations','unrecovered_costs','unrecovered_cost_entries'] LOOP
  EXECUTE format('ALTER TABLE morrow_billing.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_billing.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_billing.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_billing.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY tenant_command ON morrow_billing.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_billing.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
  EXECUTE format('GRANT SELECT,INSERT ON morrow_billing.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['credit_reservations','vendor_cost_reservations'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_billing.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
END $$;
GRANT UPDATE (status,credits_settled,settled_at,revision) ON morrow_billing.credit_reservations TO morrow_work_command;
GRANT UPDATE (booked_cost_usd,unrecovered_cost_usd,status,updated_at,revision) ON morrow_billing.vendor_cost_reservations TO morrow_work_command;
GRANT UPDATE (amount_usd,revision,updated_at) ON morrow_billing.unrecovered_costs TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,id,revision,billing_account_id,root_run_id,allocation_id,allocation_digest,catalogue_version,model_key,
 effort_key,credits_per_product,product_count,credits_reserved,credits_settled,status,created_at,settled_at)
 ON morrow_billing.credit_reservations TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,root_run_id,credit_reservation_id,vendor_id,catalogue_version,model_key,effort_key,
 maximum_cost_usd,booked_cost_usd,unrecovered_cost_usd,period_start,created_day,status,created_at,updated_at)
 ON morrow_billing.vendor_cost_reservations TO morrow_work_api;

-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- A credit reservation is born reserved at revision 1 and ends once, settled (at most the
-- reservation) or released (nothing consumed).
CREATE FUNCTION morrow_billing.credit_reservation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','credits_settled','settled_at','revision'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'reserved' THEN RAISE EXCEPTION 'CREDIT_RESERVATION_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'reserved' OR NEW.status NOT IN ('settled','released') OR NEW.revision IS DISTINCT FROM OLD.revision+1
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'CREDIT_RESERVATION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- A vendor reservation books monotonically up to its maximum while reserved, and ends once.
CREATE FUNCTION morrow_billing.vendor_reservation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['booked_cost_usd','unrecovered_cost_usd','status','updated_at','revision'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'reserved' OR NEW.booked_cost_usd<>0 OR NEW.unrecovered_cost_usd<>0 OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'reserved' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.booked_cost_usd<OLD.booked_cost_usd OR NEW.unrecovered_cost_usd<OLD.unrecovered_cost_usd
  OR NEW.unrecovered_cost_usd-OLD.unrecovered_cost_usd>NEW.booked_cost_usd-OLD.booked_cost_usd THEN
  RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- The period's unrecovered total only grows, by revision+1.
CREATE FUNCTION morrow_billing.unrecovered_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'UNRECOVERED_COST_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.amount_usd<OLD.amount_usd OR NEW.updated_at<OLD.updated_at
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
  OR NEW.period_start IS DISTINCT FROM OLD.period_start THEN
  RAISE EXCEPTION 'UNRECOVERED_COST_INVALID';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION morrow_billing.billing_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'BILLING_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_billing.credit_reservation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_billing.vendor_reservation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_billing.unrecovered_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_billing.billing_append_only() FROM PUBLIC;
CREATE TRIGGER credit_reservation_guard BEFORE INSERT OR UPDATE ON morrow_billing.credit_reservations FOR EACH ROW EXECUTE FUNCTION morrow_billing.credit_reservation_guard();
CREATE TRIGGER vendor_reservation_guard BEFORE INSERT OR UPDATE ON morrow_billing.vendor_cost_reservations FOR EACH ROW EXECUTE FUNCTION morrow_billing.vendor_reservation_guard();
CREATE TRIGGER unrecovered_guard BEFORE INSERT OR UPDATE ON morrow_billing.unrecovered_costs FOR EACH ROW EXECUTE FUNCTION morrow_billing.unrecovered_guard();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_billing.unrecovered_cost_entries FOR EACH ROW EXECUTE FUNCTION morrow_billing.billing_append_only();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['credit_reservations','vendor_cost_reservations','unrecovered_costs'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_billing.%I FOR EACH ROW EXECUTE FUNCTION morrow_billing.billing_append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['credit_reservations','vendor_cost_reservations','unrecovered_costs','unrecovered_cost_entries'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_billing.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_billing.billing_append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers: owned by the owner (revisable), INVOKER, EXECUTE for the command role only.
-- They run under the caller's session or lease policies; they take no actor.
-- Whether the period's unrecovered cost plus the next worst case stays within the version's
-- cap (ADR-0022 item 11). False for an unknown version or a null period.
CREATE FUNCTION morrow_billing.unrecovered_allows(p_org text,p_ws text,p_period_start timestamptz,p_catalogue_version integer,p_worst_case_usd numeric)
RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
 SELECT COALESCE((SELECT COALESCE((SELECT u.amount_usd FROM morrow_billing.unrecovered_costs u WHERE u.organization_id=p_org
   AND u.workspace_id=p_ws AND u.period_start=p_period_start),0)+p_worst_case_usd<=v.workspace_period_unrecovered_cost_cap_usd
  FROM morrow_work.model_catalogue_versions v WHERE v.version=p_catalogue_version AND p_period_start IS NOT NULL AND p_worst_case_usd>=0),false)
$$;
-- Reserves one run's credits and vendor cost at the active catalogue version. Under the
-- workspace's daily interlock and the wallet's row lock: the entry exists in the active
-- version; 1 <= products <= the entry's run limit; the wallet holds the credits; the UTC
-- day's settled cost plus open reservations plus this one stays within the daily cap; the
-- billing period's unrecovered cost plus one product's worst case stays within its cap.
-- The wallet moves available -> reserved. Outcomes: reserved, invalid, catalogue_inactive,
-- run_product_limit, no_billing_period, wallet_not_found, insufficient_credits, daily_cap,
-- unrecovered_cost_cap, duplicate.
CREATE FUNCTION morrow_billing.run_reserve(p_org text,p_ws text,p_billing_account_id text,p_run_id text,p_reservation_id text,
 p_vendor_reservation_id text,p_allocation_id text,p_allocation_digest text,p_catalogue_version integer,p_model text,p_effort text,
 p_product_count integer,p_period_start timestamptz)
RETURNS TABLE(outcome text,credits_reserved text,vendor_maximum_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; v record; w record; v_now timestamptz; v_credits bigint; v_vendor numeric(20,8); v_day date; v_today numeric;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_billing_account_id IS NULL OR p_billing_account_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_reservation_id IS NULL OR p_reservation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_vendor_reservation_id IS NULL OR p_vendor_reservation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_allocation_id IS NULL OR p_allocation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_allocation_digest IS NULL OR p_allocation_digest !~ '^[a-f0-9]{64}$'
  OR p_catalogue_version IS NULL OR p_model IS NULL OR p_effort IS NULL OR p_product_count IS NULL THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_period_start IS NULL OR NOT isfinite(p_period_start) THEN RETURN QUERY SELECT 'no_billing_period'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.credits_per_product,x.worst_case_per_product_usd,x.run_product_limit INTO e FROM morrow_work.model_catalogue_entries x
  JOIN morrow_work.model_catalogue_versions y ON y.version=x.version AND y.status='active'
  WHERE x.version=p_catalogue_version AND x.model_key=p_model AND x.effort_key=p_effort;
 IF NOT FOUND THEN RETURN QUERY SELECT 'catalogue_inactive'::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_product_count<1 OR p_product_count>e.run_product_limit THEN RETURN QUERY SELECT 'run_product_limit'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT y.workspace_daily_cost_cap_usd INTO v FROM morrow_work.model_catalogue_versions y WHERE y.version=p_catalogue_version;
 -- The workspace's daily interlock, then the wallet row: concurrent reservations of one
 -- workspace serialize, so a balance or a cap is never spent twice.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.billing.run_reserve',p_org,p_ws)::text,0));
 SELECT x.available,x.reserved,x.consumed,x.revision::bigint AS revision,x.updated_at INTO w FROM morrow_billing.credit_wallets x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=p_billing_account_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'wallet_not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_billing.credit_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id) THEN
  RETURN QUERY SELECT 'duplicate'::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_credits:=p_product_count::bigint*e.credits_per_product;
 v_vendor:=p_product_count*e.worst_case_per_product_usd;
 IF w.available<v_credits THEN RETURN QUERY SELECT 'insufficient_credits'::text,NULL::text,NULL::text; RETURN; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_day:=(v_now AT TIME ZONE 'UTC')::date;
 SELECT COALESCE(sum(CASE WHEN x.status='reserved' THEN x.maximum_cost_usd ELSE x.booked_cost_usd END),0) INTO v_today
  FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.created_day=v_day;
 IF v_today+v_vendor>v.workspace_daily_cost_cap_usd THEN RETURN QUERY SELECT 'daily_cap'::text,NULL::text,NULL::text; RETURN; END IF;
 IF NOT morrow_billing.unrecovered_allows(p_org,p_ws,date_trunc('milliseconds',p_period_start),p_catalogue_version,e.worst_case_per_product_usd) THEN
  RETURN QUERY SELECT 'unrecovered_cost_cap'::text,NULL::text,NULL::text; RETURN;
 END IF;
 BEGIN
  UPDATE morrow_billing.credit_wallets x SET available=x.available-v_credits,reserved=x.reserved+v_credits,revision=x.revision+1,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=p_billing_account_id;
  INSERT INTO morrow_billing.credit_reservations(organization_id,workspace_id,id,revision,billing_account_id,root_run_id,allocation_id,
   allocation_digest,catalogue_version,model_key,effort_key,credits_per_product,product_count,credits_reserved,credits_settled,status,created_at,settled_at)
  VALUES (p_org,p_ws,p_reservation_id,1,p_billing_account_id,p_run_id,p_allocation_id,p_allocation_digest,p_catalogue_version,p_model,p_effort,
   e.credits_per_product,p_product_count,v_credits,NULL,'reserved',v_now,NULL);
  INSERT INTO morrow_billing.vendor_cost_reservations(organization_id,workspace_id,id,revision,root_run_id,credit_reservation_id,vendor_id,
   catalogue_version,model_key,effort_key,maximum_cost_usd,booked_cost_usd,unrecovered_cost_usd,period_start,created_day,status,created_at,updated_at)
  VALUES (p_org,p_ws,p_vendor_reservation_id,1,p_run_id,p_reservation_id,'anthropic',p_catalogue_version,p_model,p_effort,v_vendor,0,0,
   date_trunc('milliseconds',p_period_start),v_day,'reserved',v_now,v_now);
 EXCEPTION WHEN unique_violation THEN RETURN QUERY SELECT 'duplicate'::text,NULL::text,NULL::text; RETURN;
  WHEN check_violation OR foreign_key_violation OR not_null_violation OR raise_exception THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END;
 RETURN QUERY SELECT 'reserved'::text,v_credits::text,to_char(v_vendor,'FM999999999990.00000000');
END $$;
-- Books one attempt's cost against the run's vendor reservation, at the run's catalogue
-- version (the caller computed it from usage at that version's rates, or its worst case
-- when uncertain). A failed product's or uncertain attempt's cost is also unrecovered: it
-- accrues to the run's billing period. The booked total never exceeds the reservation.
-- Outcomes: booked, invalid, not_found, reservation_exceeded, ended.
CREATE FUNCTION morrow_billing.run_book_cost(p_org text,p_ws text,p_run_id text,p_entry_id text,p_amount_usd numeric,p_kind text)
RETURNS TABLE(outcome text,booked_usd text,unrecovered_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; v_now timestamptz; v_unrecovered boolean; n integer;
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_run_id IS NULL OR p_amount_usd IS NULL OR p_amount_usd<0 OR p_amount_usd<>round(p_amount_usd,8)
  OR p_kind IS NULL OR p_kind NOT IN ('drafted','failed_product','uncertain_attempt')
  OR (p_kind<>'drafted' AND (p_entry_id IS NULL OR p_entry_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id,x.status,x.maximum_cost_usd,x.booked_cost_usd,x.unrecovered_cost_usd,x.period_start,x.revision::bigint AS revision,x.updated_at
  INTO r FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 IF r.status<>'reserved' THEN RETURN QUERY SELECT 'ended'::text,NULL::text,NULL::text; RETURN; END IF;
 IF r.booked_cost_usd+p_amount_usd>r.maximum_cost_usd THEN RETURN QUERY SELECT 'reservation_exceeded'::text,NULL::text,NULL::text; RETURN; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_unrecovered:=p_kind<>'drafted' AND p_amount_usd>0;
 UPDATE morrow_billing.vendor_cost_reservations x SET booked_cost_usd=x.booked_cost_usd+p_amount_usd,
  unrecovered_cost_usd=x.unrecovered_cost_usd+CASE WHEN v_unrecovered THEN p_amount_usd ELSE 0 END,revision=r.revision+1,
  updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.id;
 IF v_unrecovered THEN
  INSERT INTO morrow_billing.unrecovered_costs(organization_id,workspace_id,period_start,amount_usd,revision,updated_at)
  VALUES (p_org,p_ws,r.period_start,0,1,v_now) ON CONFLICT DO NOTHING;
  UPDATE morrow_billing.unrecovered_costs u SET amount_usd=u.amount_usd+p_amount_usd,revision=u.revision+1,updated_at=greatest(v_now,u.updated_at)
   WHERE u.organization_id=p_org AND u.workspace_id=p_ws AND u.period_start=r.period_start;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'UNRECOVERED_COST_INVALID'; END IF;
  INSERT INTO morrow_billing.unrecovered_cost_entries(organization_id,workspace_id,id,period_start,root_run_id,vendor_reservation_id,kind,amount_usd,recorded_at)
  VALUES (p_org,p_ws,p_entry_id,r.period_start,p_run_id,r.id,p_kind,p_amount_usd,v_now);
 END IF;
 RETURN QUERY SELECT 'booked'::text,to_char(r.booked_cost_usd+p_amount_usd,'FM999999999990.00000000'),
  to_char(r.unrecovered_cost_usd+CASE WHEN v_unrecovered THEN p_amount_usd ELSE 0 END,'FM999999999990.00000000');
END $$;
-- Settles one run: credits at the products drafted x the multiplier, never above the
-- reservation; the rest returns to available; the vendor reservation ends with what it
-- booked. The wallet moves reserved -> consumed and reserved -> available. Outcomes:
-- settled, released (nothing drafted), invalid, not_found, ended.
CREATE FUNCTION morrow_billing.run_settle(p_org text,p_ws text,p_run_id text,p_products_drafted integer)
RETURNS TABLE(outcome text,credits_settled text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE c record; v_now timestamptz; v_settled bigint; v_status text;
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_run_id IS NULL OR p_products_drafted IS NULL OR p_products_drafted<0 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id,x.billing_account_id::text AS billing_account_id,x.status,x.credits_reserved,x.credits_per_product,x.revision::bigint AS revision
  INTO c FROM morrow_billing.credit_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 -- The lock order of run_reserve: the wallet row first, then the reservation.
 PERFORM 1 FROM morrow_billing.credit_wallets x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=c.billing_account_id FOR UPDATE;
 SELECT x.status,x.revision::bigint AS revision INTO c.status,c.revision FROM morrow_billing.credit_reservations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=c.id FOR UPDATE;
 IF c.status<>'reserved' THEN RETURN QUERY SELECT 'ended'::text,NULL::text; RETURN; END IF;
 v_settled:=least(c.credits_reserved,p_products_drafted::bigint*c.credits_per_product);
 v_status:=CASE WHEN v_settled=0 THEN 'released' ELSE 'settled' END;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 UPDATE morrow_billing.credit_wallets x SET reserved=x.reserved-c.credits_reserved,consumed=x.consumed+v_settled,
  available=x.available+(c.credits_reserved-v_settled),revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=c.billing_account_id;
 UPDATE morrow_billing.credit_reservations x SET status=v_status,credits_settled=v_settled,settled_at=greatest(v_now,x.created_at),revision=c.revision+1
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=c.id;
 UPDATE morrow_billing.vendor_cost_reservations x SET status=v_status,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id AND x.status='reserved';
 RETURN QUERY SELECT v_status,v_settled::text;
END $$;
-- Releases one run that drafted nothing (a failed or refused run): run_settle with zero.
CREATE FUNCTION morrow_billing.run_release(p_org text,p_ws text,p_run_id text)
RETURNS TABLE(outcome text,credits_settled text)
LANGUAGE sql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
 SELECT s.outcome,s.credits_settled FROM morrow_billing.run_settle(p_org,p_ws,p_run_id,0) s
$$;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p WHERE p.pronamespace='morrow_billing'::regnamespace AND p.proname IN (
  'credit_reservation_guard','vendor_reservation_guard','unrecovered_guard','billing_append_only','unrecovered_allows','run_reserve',
  'run_book_cost','run_settle','run_release') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_billing.unrecovered_allows(text,text,timestamptz,integer,numeric),
 morrow_billing.run_reserve(text,text,text,text,text,text,text,text,integer,text,text,integer,timestamptz),
 morrow_billing.run_book_cost(text,text,text,text,numeric,text),morrow_billing.run_settle(text,text,text,integer),
 morrow_billing.run_release(text,text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- Wallet-dependent SQL, isolated for the rebase onto M5 PR-1's credit_wallets: every
-- reservation names its wallet, and run steps (M3 PR-2) settle under a run lease.
ALTER TABLE morrow_billing.credit_reservations ADD CONSTRAINT credit_reservations_wallet FOREIGN KEY (organization_id,workspace_id,billing_account_id)
 REFERENCES morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id);
CREATE POLICY tenant_lease ON morrow_billing.credit_wallets TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
 WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c));
COMMIT;
