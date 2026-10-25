BEGIN;
-- ADR-0039 (OD-2026-10-25-4): credits are the only spend limit. Implementation plan PR 1 (the
-- listings and the catalogue, credits only) with PR 4's removal of the runtime budget.
-- Executes AS morrow_work_owner, after 0051. No external effect: nothing here sends a
-- request, reserves money or dispatches.
--   * model_catalogue_versions.run_cost_cap_usd and workspace_daily_cost_cap_usd become
--     nullable: versions 1 and 3 keep their published US$7 and US$25, which nothing enforces
--     once version 4 is active, and no later version may carry either (CHECK).
--   * Catalogue version 4 (per product, listings-run@1), published on OD-2026-10-25-4
--     (docs/decisions/model-policy.json; the generated catalogue's version 4, drift-tested by
--     tests/credits-only.test.mjs): version 3's entries, credits, rates, default selection
--     and default member ceiling, with no run or daily cost cap, so every entry's run product
--     limit is the version's 25 (Opus 5.5 at high goes from 9 to 25 products, at medium from
--     12, Sonnet 5.5 at high from 19). A run still holds its products times the entry's
--     credits up front, so it never runs out mid-run. Version 3 is retired, not removed: a run
--     recorded at version 1 or 3 is still booked at its version. The append-only trigger is
--     lifted for that one status change only, inside this transaction.
--   * morrow_billing.run_reserve (0038's revision), revised: no daily cap, so it never returns
--     daily_cap. Every other check is unchanged: the active version's entry, 1 to the entry's
--     run product limit, the workspace's reservation interlock and the wallet's row lock,
--     no duplicate run, insufficient_credits, unrecovered_allows (0051), and the credit and
--     vendor reservations with the vendor reservation's created_day. Its owner, INVOKER
--     security and EXECUTE for morrow_work_command alone are 0033's, kept by OR REPLACE. The
--     product limit of run_product_begin and cmd_run_admit is the entry's, now 25.
--   * morrow_work.runtime_caps() (0043), replaced without monthly_budget_usd (ADR-0039 item 6:
--     E2B's usage limit in the owner's account is the outside backstop, and its refusal sets
--     the runtime hold). Its return type changes, so it is dropped and created again with
--     0043's owner (the work owner), INVOKER security and EXECUTE for morrow_work_command
--     alone; its callers (runtime_operation_settle, runtime_operations_open and 0047's
--     runtime_operations_sweep) read only the columns it keeps. The concurrency (10), the
--     per-workspace limit (3), a sandbox's worst case (US$0.03, still booked on the run's
--     vendor reservation), the 960 s deadline, the 600 s grace and the 660 s staleness are
--     unchanged (packages/policy/src/runtime-computer.ts, drift-tested).
--   * morrow_vault.runtime_operation_begin (0043), replaced without the monthly budget: it
--     never returns monthly_budget and no longer reads or moves runtime_capacity's
--     budget_month and month_committed_usd, which keep the last values 0043's definer wrote
--     (nothing reads them). Every other rule is 0043's: the lease, the run, the release's
--     runtime.execution.use, the runtime hold, the concurrency and per-workspace caps under
--     the capacity lock, the sandbox_compute booking and the send mark. The broker's closed
--     refusal set keeps monthly_budget for replies from before this migration. It is dropped
--     by the schema's owner and created again as 0043 created it: SECURITY DEFINER, EXECUTE
--     for morrow_vault_broker alone, then owned by morrow_work_command (CREATE on the vault
--     schema lent to that role for the transfer only, as 0043 did).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.model_catalogue_versions') IS NULL OR to_regclass('morrow_work.model_catalogue_entries') IS NULL
 OR to_regclass('morrow_work.model_catalogue_rates') IS NULL OR to_regclass('morrow_work.runtime_capacity') IS NULL
 OR to_regprocedure('morrow_billing.run_reserve(text,text,text,text,text,text,text,text,integer,text,text,integer,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_billing.unrecovered_allows(text,text,timestamp with time zone,integer,numeric)') IS NULL
 OR to_regprocedure('morrow_work.runtime_caps()') IS NULL
 OR to_regprocedure('morrow_vault.runtime_operation_begin(text,text,text,text,text)') IS NULL
 -- The helpers this file replaces, exactly as 0038 and 0043 wrote them (shared protocol: a
 -- later revision is never overwritten blind).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_billing.run_reserve(text,text,text,text,text,text,text,text,integer,text,text,integer,timestamp with time zone)'))
  IS DISTINCT FROM 'e6a0261e610871211bee32a59d16756b'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.runtime_caps()'))
  IS DISTINCT FROM '024515922e27febf545c90f4315d011c'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_vault.runtime_operation_begin(text,text,text,text,text)'))
  IS DISTINCT FROM '7512940151ea4c9d7874c6478a163b6f'
 OR (SELECT p.proowner::regrole::text FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_vault.runtime_operation_begin(text,text,text,text,text)'))
  IS DISTINCT FROM 'morrow_work_command'
 -- The catalogue as 0051 left it: version 1 retired, version 3 active at its pinned digest.
 OR (SELECT count(*) FROM morrow_work.model_catalogue_versions)<>2
 OR NOT EXISTS(SELECT 1 FROM morrow_work.model_catalogue_versions v WHERE v.version=1 AND v.status='retired'
   AND v.run_cost_cap_usd=7.00000000 AND v.workspace_daily_cost_cap_usd=25.00000000)
 OR NOT EXISTS(SELECT 1 FROM morrow_work.model_catalogue_versions v WHERE v.version=3 AND v.status='active'
   AND v.digest='f1f15d4f3b952234693f15aee1943e937f8c421ab1f4809e73345469c616d6c0'
   AND v.run_cost_cap_usd=7.00000000 AND v.workspace_daily_cost_cap_usd=25.00000000)
 OR (SELECT count(*) FROM morrow_work.model_catalogue_entries)<>18 OR (SELECT count(*) FROM morrow_work.model_catalogue_rates)<>6
 THEN RAISE EXCEPTION 'CREDITS_ONLY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Versions 1 and 3 keep their published run and daily caps; no other version has either.
ALTER TABLE morrow_work.model_catalogue_versions ALTER COLUMN run_cost_cap_usd DROP NOT NULL,
 ALTER COLUMN workspace_daily_cost_cap_usd DROP NOT NULL,
 ADD CONSTRAINT model_catalogue_versions_cost_caps CHECK ((run_cost_cap_usd IS NOT NULL)=(version IN (1,3))
  AND (workspace_daily_cost_cap_usd IS NOT NULL)=(version IN (1,3)));

-- Version 3 retires (its row is otherwise unchanged; status is outside its pinned digest).
ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;
UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=3 AND status='active';
ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;

-- Version 4, active: exactly as scripts/generate-model-catalogue.mjs computes it.
INSERT INTO morrow_work.model_catalogue_versions(version,status,digest,default_model,default_effort,default_member_credit_ceiling,
 max_products_per_run,run_cost_cap_usd,workspace_daily_cost_cap_usd,workspace_period_unrecovered_cost_cap_usd)
VALUES (4,'active','013de2e441ad4d30db5acb75a9a40d953e34d0e973e06f47b7c2dc8766ff1d42','claude_opus_5_5','medium',4,25,NULL,NULL,NULL);
INSERT INTO morrow_work.model_catalogue_entries(version,model_key,effort_key,credits_per_product,worst_case_per_product_usd,
 worst_case_per_attempt_usd,run_product_limit) VALUES
 (4,'claude_haiku_5_5','low',1,0.00660000,0.00330000,25),
 (4,'claude_haiku_5_5','medium',1,0.01360000,0.00680000,25),
 (4,'claude_haiku_5_5','high',1,0.01760000,0.00880000,25),
 (4,'claude_sonnet_5_5','low',1,0.13200000,0.06600000,25),
 (4,'claude_sonnet_5_5','medium',2,0.27200000,0.13600000,25),
 (4,'claude_sonnet_5_5','high',3,0.35200000,0.17600000,25),
 (4,'claude_opus_5_5','low',2,0.26400000,0.13200000,25),
 (4,'claude_opus_5_5','medium',4,0.54400000,0.27200000,25),
 (4,'claude_opus_5_5','high',6,0.70400000,0.35200000,25);
INSERT INTO morrow_work.model_catalogue_rates(version,model_key,provider,provider_model_id,input_usd8_per_token,output_usd8_per_token,max_input_tokens) VALUES
 (4,'claude_haiku_5_5','anthropic','claude-haiku-5-5',10,50,8000),
 (4,'claude_sonnet_5_5','anthropic','claude-sonnet-5-5',200,1000,8000),
 (4,'claude_opus_5_5','anthropic','claude-opus-5-5',400,2000,8000);

-- ---------------------------------------------------------------------------
-- run_reserve (0038's revision), revised: no daily cap (ADR-0039 items 1 and 4). Credits
-- are the only spend limit: the wallet holds products times the entry's credits up front.
CREATE OR REPLACE FUNCTION morrow_billing.run_reserve(p_org text,p_ws text,p_billing_account_id text,p_run_id text,p_reservation_id text,
 p_vendor_reservation_id text,p_allocation_id text,p_allocation_digest text,p_catalogue_version integer,p_model text,p_effort text,
 p_product_count integer,p_period_start timestamptz)
RETURNS TABLE(outcome text,credits_reserved text,vendor_maximum_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; w record; v_now timestamptz; v_credits bigint; v_vendor numeric(20,8); v_day date; n integer;
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
 -- The workspace's reservation interlock (0033's key, kept so every lock order stays as it
 -- was), then the wallet row: concurrent reservations of one workspace serialize, so a
 -- balance is never spent twice.
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
 IF NOT morrow_billing.unrecovered_allows(p_org,p_ws,date_trunc('milliseconds',p_period_start),p_catalogue_version,e.worst_case_per_product_usd) THEN
  RETURN QUERY SELECT 'unrecovered_cost_cap'::text,NULL::text,NULL::text; RETURN;
 END IF;
 BEGIN
  UPDATE morrow_billing.credit_wallets x SET available=x.available-v_credits,reserved=x.reserved+v_credits,revision=x.revision+1,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=p_billing_account_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'CREDIT_WALLET_INVALID'; END IF;
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

-- ---------------------------------------------------------------------------
-- The runtime caps in code (ADR-0029 item 8 as ADR-0039 item 6 amends it): no monthly
-- budget. INVOKER, owned by the owner, EXECUTE for the command role only, as 0043 made it.
-- Drift-tested against packages/policy/src/runtime-computer.ts (tests/credits-only.test.mjs).
DROP FUNCTION morrow_work.runtime_caps();
CREATE FUNCTION morrow_work.runtime_caps()
RETURNS TABLE(concurrent_sandboxes integer,sandboxes_per_workspace integer,worst_case_usd numeric,
 deadline_seconds integer,absent_grace_seconds integer,stale_seconds integer)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT 10,3,0.03::numeric(20,8),960,600,660
$$;
REVOKE ALL ON FUNCTION morrow_work.runtime_caps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.runtime_caps() TO morrow_work_command;

-- The send mark (0043), without the monthly budget. Outcomes: begun (with the operation id
-- and the deadline), replay (with the recorded id), runtime_held, concurrency_limit,
-- workspace_limit, reservation_exhausted, capability_missing, run_inactive, and
-- resolve_call's refusals; never monthly_budget.
DROP FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text);
CREATE FUNCTION morrow_vault.runtime_operation_begin(p_lease_id text,p_generation text,p_call_key text,p_job_digest text,p_provider text)
RETURNS TABLE(outcome text,operation_id text,deadline_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE
 k record; lz record; rc record; r record; o record; i record; rel record; cap record; b record; v_found boolean; v_outcome text; v_now timestamptz;
 v_open integer; v_op text; v_entry text; v_deadline timestamptz; n integer;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_lease_id IS NULL OR p_lease_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation IS NULL OR p_generation !~ '^[1-9][0-9]{0,15}$'
  OR p_call_key IS NULL OR p_call_key !~ '^[a-z0-9][a-z0-9_.:-]{0,63}$' OR p_job_digest IS NULL OR p_job_digest !~ '^[a-f0-9]{64}$'
  OR p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO k FROM morrow_work.runtime_caps();
 -- The lease's tenant, store and subject (resolve_call's own lease policy, keyed by its setting).
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease',p_lease_id,true);
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.subject_id::text AS subject_id,x.store_id::text AS store_id,
  x.kind INTO lz FROM morrow_work.work_leases x WHERE x.id=p_lease_id;
 -- FOUND is captured before the PERFORM below resets it.
 v_found:=FOUND;
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease','',true);
 IF NOT v_found OR lz.kind<>'run' THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 -- The stop interlock, shared (lease_open's order), then resolve_call as a new statement.
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  lz.organization_id,lz.workspace_id,lz.store_id)::text,0));
 SELECT * INTO rc FROM morrow_vault.resolve_call(p_lease_id,p_generation,'model',lz.subject_id);
 IF rc.outcome IS DISTINCT FROM 'resolved' THEN
  RETURN QUERY SELECT COALESCE(rc.outcome,'denied'),NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',rc.organization_id,rc.workspace_id,
  rc.subject_id)::text,0));
 -- The run and its billing rows through the broker's model settings (0038's policies), written
 -- before reading and cleared after.
 PERFORM pg_catalog.set_config('morrow.vault_model_run',rc.organization_id||'|'||rc.workspace_id||'|'||rc.subject_id,true),
  pg_catalog.set_config('morrow.vault_model_tenant',rc.organization_id||'|'||rc.workspace_id,true);
 SELECT x.id::text AS id,x.lease_id::text AS lease_id,x.lease_generation::text AS lease_generation,x.status,x.installation_id::text AS installation_id
  INTO r FROM morrow_work.runs x WHERE x.organization_id=rc.organization_id AND x.workspace_id=rc.workspace_id AND x.id=rc.subject_id;
 IF NOT FOUND OR r.lease_id<>p_lease_id OR r.lease_generation<>p_generation OR r.status<>'running' OR r.installation_id IS DISTINCT FROM rc.installation_id THEN
  v_outcome:='run_inactive';
 END IF;
 IF v_outcome IS NULL THEN
  -- The same run and call key again: the recorded operation, never a second create.
  SELECT x.id::text AS id INTO o FROM morrow_work.runtime_operations x WHERE x.organization_id=rc.organization_id AND x.workspace_id=rc.workspace_id
   AND x.run_id=r.id AND x.call_key=p_call_key;
  IF FOUND THEN
   PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
   RETURN QUERY SELECT 'replay'::text,o.id,NULL::text; RETURN;
  END IF;
  -- The installation's package declares the computer (ADR-0029 item 7).
  PERFORM pg_catalog.set_config('morrow.vault_resolve_installation',rc.organization_id||'|'||rc.workspace_id||'|'||rc.installation_id,true);
  SELECT x.release_id,x.release_revision INTO i FROM morrow_work.agent_installations x WHERE x.organization_id=rc.organization_id
   AND x.workspace_id=rc.workspace_id AND x.id=rc.installation_id AND x.status='active';
  v_found:=FOUND;
  PERFORM pg_catalog.set_config('morrow.vault_resolve_installation','',true);
  IF v_found THEN
   SELECT x.manifest INTO rel FROM morrow_work.agent_releases x WHERE x.id=i.release_id AND x.revision=i.release_revision AND x.status='published';
   v_found:=FOUND;
  END IF;
  IF NOT v_found THEN v_outcome:='capability_missing';
  ELSIF NOT COALESCE(((rel.manifest::jsonb)->'capabilities'->'runtime.execution.use') ? 'execute',false) THEN v_outcome:='capability_missing';
  END IF;
 END IF;
 IF v_outcome IS NULL THEN
  -- The platform's caps under one lock: holds, concurrency, the workspace (no monthly budget:
  -- ADR-0039 item 6).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.runtime_capacity')::text,0));
  SELECT x.open_operations INTO cap FROM morrow_work.runtime_capacity x WHERE x.scope='platform' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_CAPACITY_MISSING'; END IF;
  v_now:=date_trunc('milliseconds',clock_timestamp());
  SELECT count(*)::integer INTO v_open FROM morrow_work.runtime_operations x WHERE x.organization_id=rc.organization_id
   AND x.workspace_id=rc.workspace_id AND x.status IN ('sending','created','unknown_effect');
  IF EXISTS(SELECT 1 FROM morrow_work.runtime_holds h WHERE h.lifted_at IS NULL) THEN v_outcome:='runtime_held';
  ELSIF cap.open_operations>=k.concurrent_sandboxes THEN v_outcome:='concurrency_limit';
  ELSIF v_open>=k.sandboxes_per_workspace THEN v_outcome:='workspace_limit';
  END IF;
 END IF;
 IF v_outcome IS NULL THEN
  v_op:=gen_random_uuid()::text;
  v_entry:=r.id||':rt:'||v_op;
  SELECT * INTO b FROM morrow_billing.run_book_cost(rc.organization_id,rc.workspace_id,r.id,v_entry,k.worst_case_usd,'sandbox_compute');
  IF b.outcome IS DISTINCT FROM 'booked' THEN v_outcome:='reservation_exhausted'; END IF;
 END IF;
 IF v_outcome IS NOT NULL THEN
  PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
  RETURN QUERY SELECT v_outcome,NULL::text,NULL::text; RETURN;
 END IF;
 v_deadline:=v_now+make_interval(secs=>k.deadline_seconds);
 INSERT INTO morrow_work.runtime_operations(organization_id,workspace_id,id,revision,run_id,lease_id,installation_id,call_key,job_digest,profile,
  profile_version,provider,status,unknown_reason,sandbox_ref,worst_case_usd,booking_id,send_started_at,deadline_at,reconciled_at,settled_at,updated_at)
 VALUES (rc.organization_id,rc.workspace_id,v_op,1,r.id,p_lease_id,rc.installation_id,p_call_key,p_job_digest,'morrow.computer',1,p_provider,
  'sending',NULL,NULL,k.worst_case_usd,v_entry,v_now,v_deadline,NULL,NULL,v_now);
 UPDATE morrow_work.runtime_capacity x SET open_operations=cap.open_operations+1,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.scope='platform';
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'RUNTIME_CAPACITY_MISSING'; END IF;
 PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
 RETURN QUERY SELECT 'begun'::text,v_op,to_char(v_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END $$;

REVOKE ALL ON FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
