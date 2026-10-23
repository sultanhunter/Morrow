BEGIN;
-- Build order PR 7, the computer foundation (ADR-0029 items 2, 7, 8 and 9; P12.T01's
-- RuntimeProviderPort ledger). Executes AS morrow_work_owner, after M3 PR-2's listings runs
-- (0038). No external effect: nothing here creates, reads or kills a sandbox; the broker's
-- runtime gateway (apps/broker/src/runtime-gateway.ts) calls these definers on its own login
-- around each provider request, and its switch is committed off.
--   * morrow_vault.runtime_operations: one row per sandbox (a runtime operation), tenant-keyed,
--     content-free (ids, digests, codes and times). Its send mark (status `sending`) commits
--     before any create; a create, kill or lookup the broker cannot prove becomes
--     `unknown_effect` and is reconciled by its metadata before anything else, never promoted
--     to success, and `not_found` alone never settles it. One row per run and call key, so a
--     retried step never creates twice.
--   * morrow_vault.runtime_holds: the runtime hold (ADR-0029 item 9). A quota or billing block,
--     an unreconciled unknown effect or a profile violation sets one; while any is active no
--     create is admitted (cleanup is never blocked). Only a person lifts it, through the
--     owner's runtime_hold_lift (INVOKER, owned by the owner, granted to nobody).
--   * morrow_vault.runtime_capacity: the platform's one row of runtime caps in use (open
--     sandboxes and the month's committed worst cases), so the monthly budget below E2B's
--     usage limit and the concurrency cap are checked under one row lock without any
--     cross-tenant read.
--   * morrow_vault.runtime_caps(): the caps in code (ADR-0029 item 8), drift-tested against
--     packages/policy/src/runtime-computer.ts: a monthly budget of US$10 (E2B's limit is
--     US$20), 10 concurrent sandboxes (half of Hobby's 20), 3 per workspace, US$0.03 a
--     sandbox's worst case at list rates, a 960 s deadline (900 s lifetime plus the create's
--     60 s), a 600 s absent grace and a 660 s staleness (the longest execute plus a minute).
--   * The reservation hook: morrow_billing.run_book_cost (0038's revision) admits the kind
--     `sandbox_compute`, booked against the run's vendor reservation like an `attempt` (never
--     unrecovered); runtime_operation_begin books each sandbox's worst case before its send
--     mark (ADR-0029 item 8; ADR-0026 prices computer seconds later).
--   * Definers for morrow_vault_broker only: runtime_operation_begin (the lease resolved as
--     for a model call, the run running under it, the installation's package declaring
--     runtime.execution.use, no active hold, the caps, the booking, the send mark),
--     runtime_operation_created, runtime_operation_settle and runtime_operations_open (the
--     sweep's ids-only, cross-tenant list of stale open operations; ADR-0029's accepted
--     residual).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.runs') IS NULL OR to_regclass('morrow_work.agent_installations') IS NULL
 OR to_regclass('morrow_work.agent_releases') IS NULL OR to_regclass('morrow_billing.run_cost_bookings') IS NULL
 OR to_regclass('morrow_billing.vendor_cost_reservations') IS NULL
 OR to_regprocedure('morrow_billing.run_book_cost(text,text,text,text,numeric,text)') IS NULL
 OR to_regprocedure('morrow_vault.resolve_call(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.model_call_begin(text,text,text,text,text,text,text,text)') IS NULL
 OR to_regclass('morrow_vault.runtime_operations') IS NOT NULL OR to_regclass('morrow_vault.runtime_holds') IS NOT NULL
 OR to_regclass('morrow_vault.runtime_capacity') IS NOT NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 THEN RAISE EXCEPTION 'RUNTIME_OPERATIONS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The reservation hook. run_book_cost (0038), revised: the kind `sandbox_compute` (one
-- sandbox's worst case, booked against the run's vendor reservation and not unrecovered).
-- Every other rule is 0038's, unchanged.
ALTER TABLE morrow_billing.run_cost_bookings DROP CONSTRAINT run_cost_bookings_kind_check,
 ADD CONSTRAINT run_cost_bookings_kind_check CHECK (kind IN ('drafted','failed_product','uncertain_attempt','attempt','overflow','sandbox_compute'));
CREATE OR REPLACE FUNCTION morrow_billing.run_book_cost(p_org text,p_ws text,p_run_id text,p_entry_id text,p_amount_usd numeric,p_kind text)
RETURNS TABLE(outcome text,booked_usd text,unrecovered_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; b record; v_now timestamptz; v_unrecovered boolean; n integer; v_booked numeric(20,8); v_lost numeric(20,8);
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_run_id IS NULL OR p_amount_usd IS NULL OR p_amount_usd<0 OR p_amount_usd<>round(p_amount_usd,8)
  OR p_kind IS NULL OR p_kind NOT IN ('drafted','failed_product','uncertain_attempt','attempt','overflow','sandbox_compute')
  OR (p_kind='overflow' AND p_amount_usd=0)
  OR p_entry_id IS NULL OR p_entry_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id,x.status,x.maximum_cost_usd,x.booked_cost_usd,x.unrecovered_cost_usd,x.period_start,x.revision::bigint AS revision,x.updated_at
  INTO r FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.root_run_id::text AS root_run_id,x.kind,x.amount_usd,x.booked_usd,x.unrecovered_usd INTO b FROM morrow_billing.run_cost_bookings x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_entry_id;
 IF FOUND THEN
  IF b.root_run_id=p_run_id AND b.kind=p_kind AND b.amount_usd=p_amount_usd THEN
   RETURN QUERY SELECT 'booked'::text,to_char(b.booked_usd,'FM999999999990.00000000'),to_char(b.unrecovered_usd,'FM999999999990.00000000');
  ELSE
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text;
  END IF;
  RETURN;
 END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 IF p_kind='overflow' THEN
  BEGIN
   INSERT INTO morrow_billing.run_cost_bookings(organization_id,workspace_id,id,root_run_id,vendor_reservation_id,kind,amount_usd,booked_usd,
    unrecovered_usd,recorded_at)
   VALUES (p_org,p_ws,p_entry_id,p_run_id,r.id,'overflow',p_amount_usd,r.booked_cost_usd,r.unrecovered_cost_usd,v_now);
   INSERT INTO morrow_billing.unrecovered_costs(organization_id,workspace_id,period_start,amount_usd,revision,updated_at)
   VALUES (p_org,p_ws,r.period_start,0,1,v_now) ON CONFLICT DO NOTHING;
   UPDATE morrow_billing.unrecovered_costs u SET amount_usd=u.amount_usd+p_amount_usd,revision=u.revision+1,updated_at=greatest(v_now,u.updated_at)
    WHERE u.organization_id=p_org AND u.workspace_id=p_ws AND u.period_start=r.period_start;
   GET DIAGNOSTICS n=ROW_COUNT;
   IF n<>1 THEN RAISE EXCEPTION 'UNRECOVERED_COST_INVALID'; END IF;
   INSERT INTO morrow_billing.unrecovered_cost_entries(organization_id,workspace_id,id,period_start,root_run_id,vendor_reservation_id,kind,amount_usd,recorded_at)
   VALUES (p_org,p_ws,p_entry_id,r.period_start,p_run_id,r.id,'overflow',p_amount_usd,v_now);
  EXCEPTION WHEN unique_violation THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
  END;
  RETURN QUERY SELECT 'booked'::text,to_char(r.booked_cost_usd,'FM999999999990.00000000'),to_char(r.unrecovered_cost_usd,'FM999999999990.00000000');
  RETURN;
 END IF;
 IF r.status<>'reserved' THEN RETURN QUERY SELECT 'ended'::text,NULL::text,NULL::text; RETURN; END IF;
 IF r.booked_cost_usd+p_amount_usd>r.maximum_cost_usd THEN RETURN QUERY SELECT 'reservation_exceeded'::text,NULL::text,NULL::text; RETURN; END IF;
 v_unrecovered:=p_kind IN ('failed_product','uncertain_attempt') AND p_amount_usd>0;
 v_booked:=r.booked_cost_usd+p_amount_usd;
 v_lost:=r.unrecovered_cost_usd+CASE WHEN v_unrecovered THEN p_amount_usd ELSE 0 END;
 BEGIN
  INSERT INTO morrow_billing.run_cost_bookings(organization_id,workspace_id,id,root_run_id,vendor_reservation_id,kind,amount_usd,booked_usd,
   unrecovered_usd,recorded_at)
  VALUES (p_org,p_ws,p_entry_id,p_run_id,r.id,p_kind,p_amount_usd,v_booked,v_lost,v_now);
  UPDATE morrow_billing.vendor_cost_reservations x SET booked_cost_usd=v_booked,unrecovered_cost_usd=v_lost,revision=r.revision+1,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID'; END IF;
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
 EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END;
 RETURN QUERY SELECT 'booked'::text,to_char(v_booked,'FM999999999990.00000000'),to_char(v_lost,'FM999999999990.00000000');
END $$;

-- ---------------------------------------------------------------------------
-- Tables. Every stored time is millisecond-truncated.
-- One runtime operation: one sandbox of the profile morrow.computer v1, from its send mark
-- to its settlement. `sending` is committed before the create leaves the broker; `created`
-- records the provider's opaque id; `unknown_effect` means the broker cannot prove whether a
-- sandbox exists (with the last reason); `killed`, `absent_verified` and `not_created` are
-- terminal. reconciled_at is the sweep's last look. Content-free: ids, digests, codes, times.
CREATE TABLE morrow_vault.runtime_operations (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 lease_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 call_key text NOT NULL CHECK (call_key ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
 job_digest morrow_work.digest NOT NULL,
 profile text NOT NULL CHECK (profile='morrow.computer'),
 profile_version integer NOT NULL CHECK (profile_version=1),
 provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
 status text NOT NULL CHECK (status IN ('sending','created','unknown_effect','killed','absent_verified','not_created')),
 unknown_reason text CHECK (unknown_reason IN ('create_unknown','quota_exhausted','billing_blocked','reply_invalid','kill_unknown',
  'kill_not_found','status_unknown','not_found_unverified','paused_found')),
 sandbox_ref text CHECK (sandbox_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
 worst_case_usd numeric(20,8) NOT NULL CHECK (worst_case_usd>0),
 booking_id text NOT NULL CHECK (booking_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 send_started_at timestamptz NOT NULL CHECK (send_started_at=date_trunc('milliseconds',send_started_at) AND send_started_at>=timestamptz '2000-01-01T00:00:00Z' AND send_started_at<timestamptz '9000-01-01T00:00:00Z'),
 deadline_at timestamptz NOT NULL,
 reconciled_at timestamptz CHECK (reconciled_at=date_trunc('milliseconds',reconciled_at) AND isfinite(reconciled_at)),
 settled_at timestamptz CHECK (settled_at=date_trunc('milliseconds',settled_at) AND isfinite(settled_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,call_key),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.runs(organization_id,workspace_id,id),
 CONSTRAINT runtime_operations_deadline CHECK (deadline_at=send_started_at+interval '960 seconds'),
 CONSTRAINT runtime_operations_status CHECK ((status IN ('killed','absent_verified','not_created'))=(settled_at IS NOT NULL)
  AND (status<>'unknown_effect' OR unknown_reason IS NOT NULL) AND (status<>'created' OR sandbox_ref IS NOT NULL)
  AND (status<>'not_created' OR sandbox_ref IS NULL)),
 CONSTRAINT runtime_operations_times CHECK (updated_at>=send_started_at AND (settled_at IS NULL OR settled_at>=send_started_at)
  AND (reconciled_at IS NULL OR reconciled_at>=send_started_at))
);
CREATE UNIQUE INDEX runtime_operations_id ON morrow_vault.runtime_operations (id);
CREATE INDEX runtime_operations_open ON morrow_vault.runtime_operations (send_started_at,id) WHERE status IN ('sending','created','unknown_effect');
CREATE INDEX runtime_operations_workspace_open ON morrow_vault.runtime_operations (organization_id,workspace_id)
 WHERE status IN ('sending','created','unknown_effect');
-- A runtime hold (platform): raised by the settle definer at most once per operation and
-- class, lifted once, only by a person (the owner's runtime_hold_lift). Content-free.
CREATE TABLE morrow_vault.runtime_holds (
 id morrow_work.record_id NOT NULL PRIMARY KEY CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 reason text NOT NULL CHECK (reason IN ('unknown_effect','quota_exhausted','billing_blocked','profile_violation')),
 operation_id morrow_work.record_id NOT NULL CHECK (operation_id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 lifted_at timestamptz CHECK (lifted_at=date_trunc('milliseconds',lifted_at) AND isfinite(lifted_at)),
 lifted_by_operator_id morrow_work.record_id,
 lift_reason text CHECK (char_length(lift_reason) BETWEEN 1 AND 1024 AND lift_reason ~ '\S'),
 UNIQUE (operation_id,reason),
 CONSTRAINT runtime_holds_lift CHECK ((lifted_at IS NULL)=(lifted_by_operator_id IS NULL) AND (lifted_at IS NULL)=(lift_reason IS NULL)
  AND (lifted_at IS NULL OR lifted_at>=created_at))
);
CREATE INDEX runtime_holds_active ON morrow_vault.runtime_holds (created_at,id) WHERE lifted_at IS NULL;
-- The platform's runtime caps in use: one row, moved only by the begin and settle definers
-- under the capacity lock. The bounds repeat runtime_caps() as a backstop.
CREATE TABLE morrow_vault.runtime_capacity (
 scope text NOT NULL PRIMARY KEY CHECK (scope='platform'),
 open_operations integer NOT NULL CHECK (open_operations BETWEEN 0 AND 10),
 budget_month date NOT NULL CHECK (budget_month=date_trunc('month',budget_month)::date),
 month_committed_usd numeric(20,8) NOT NULL CHECK (month_committed_usd>=0 AND month_committed_usd<=10),
 revision morrow_work.revision NOT NULL,
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at))
);
INSERT INTO morrow_vault.runtime_capacity(scope,open_operations,budget_month,month_committed_usd,revision,updated_at)
VALUES ('platform',0,date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,0,1,date_trunc('milliseconds',clock_timestamp()));

-- ---------------------------------------------------------------------------
-- Guards: INVOKER, owned by the owner, granted to nobody. An operation is born `sending` at
-- revision 1 with nothing settled; afterwards revision+1, never back-dated, only the status,
-- its reason, the sandbox ref and the times change, along the edges below; a terminal
-- operation never changes. A hold changes once, to lifted. The capacity row only moves by
-- revision. Nothing is deleted or truncated.
CREATE FUNCTION morrow_vault.runtime_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE v_mutable text[];
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'RUNTIME_RECORD_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='runtime_operations' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.revision<>1 OR NEW.status<>'sending' OR NEW.sandbox_ref IS NOT NULL OR NEW.unknown_reason IS NOT NULL OR NEW.settled_at IS NOT NULL
    OR NEW.reconciled_at IS NOT NULL OR NEW.updated_at<>NEW.send_started_at THEN
    RAISE EXCEPTION 'RUNTIME_RECORD_INVALID';
   END IF;
   RETURN NEW;
  END IF;
  v_mutable:=ARRAY['revision','status','unknown_reason','sandbox_ref','reconciled_at','settled_at','updated_at'];
  IF OLD.status IN ('killed','absent_verified','not_created') OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
   OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
   OR (OLD.sandbox_ref IS NOT NULL AND NEW.sandbox_ref IS DISTINCT FROM OLD.sandbox_ref)
   OR NOT ((OLD.status,NEW.status) IN (('sending','created'),('sending','not_created'),('sending','unknown_effect'),('sending','killed'),
    ('sending','absent_verified'),('created','unknown_effect'),('created','killed'),('created','absent_verified'),
    ('unknown_effect','unknown_effect'),('unknown_effect','killed'),('unknown_effect','absent_verified'))) THEN
   RAISE EXCEPTION 'RUNTIME_RECORD_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='runtime_holds' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.lifted_at IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_RECORD_INVALID'; END IF;
   RETURN NEW;
  END IF;
  IF OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['lifted_at','lifted_by_operator_id','lift_reason']) IS NOT DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['lifted_at','lifted_by_operator_id','lift_reason']) THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'RUNTIME_RECORD_IMMUTABLE';
 END IF;
 IF TG_OP='UPDATE' AND NEW.scope=OLD.scope AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'RUNTIME_RECORD_INVALID';
END $$;
REVOKE ALL ON FUNCTION morrow_vault.runtime_guard() FROM PUBLIC;
CREATE TRIGGER runtime_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_vault.runtime_operations FOR EACH ROW EXECUTE FUNCTION morrow_vault.runtime_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_vault.runtime_operations FOR EACH STATEMENT EXECUTE FUNCTION morrow_vault.runtime_guard();
CREATE TRIGGER runtime_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_vault.runtime_holds FOR EACH ROW EXECUTE FUNCTION morrow_vault.runtime_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_vault.runtime_holds FOR EACH STATEMENT EXECUTE FUNCTION morrow_vault.runtime_guard();
CREATE TRIGGER runtime_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_vault.runtime_capacity FOR EACH ROW EXECUTE FUNCTION morrow_vault.runtime_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_vault.runtime_capacity FOR EACH STATEMENT EXECUTE FUNCTION morrow_vault.runtime_guard();

-- ---------------------------------------------------------------------------
-- Row security: ENABLE + FORCE, the maintenance-only owner policy and the vault's one
-- policy, the broker's own login through its definers (it holds no table privilege).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['runtime_operations','runtime_holds','runtime_capacity'] LOOP
  EXECUTE format('ALTER TABLE morrow_vault.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_vault.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_vault.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('CREATE POLICY vault_broker ON morrow_vault.%I TO morrow_work_command
   USING (session_user=''morrow_vault_broker'') WITH CHECK (session_user=''morrow_vault_broker'')',t);
  EXECUTE format('REVOKE ALL ON morrow_vault.%I FROM PUBLIC',t);
 END LOOP;
END $$;
-- Privileges: SELECT and INSERT, column-scoped UPDATE; no DELETE or TRUNCATE for anyone.
GRANT SELECT,INSERT ON morrow_vault.runtime_operations,morrow_vault.runtime_holds TO morrow_work_command;
GRANT UPDATE (revision,status,unknown_reason,sandbox_ref,reconciled_at,settled_at,updated_at) ON morrow_vault.runtime_operations TO morrow_work_command;
GRANT SELECT ON morrow_vault.runtime_capacity TO morrow_work_command;
GRANT UPDATE (open_operations,budget_month,month_committed_usd,revision,updated_at) ON morrow_vault.runtime_capacity TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- The runtime caps in code (ADR-0029 item 8): INVOKER, owned by the owner (a later owner
-- migration may revise them), EXECUTE for the command role only. Drift-tested against
-- packages/policy/src/runtime-computer.ts (tests/runtime-computer.test.mjs).
CREATE FUNCTION morrow_vault.runtime_caps()
RETURNS TABLE(monthly_budget_usd numeric,concurrent_sandboxes integer,sandboxes_per_workspace integer,worst_case_usd numeric,
 deadline_seconds integer,absent_grace_seconds integer,stale_seconds integer)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT 10.00::numeric(20,8),10,3,0.03::numeric(20,8),960,600,660
$$;

-- ---------------------------------------------------------------------------
-- The broker's definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_vault_broker only, each guarded by work_executor_safe. Ids, digests and codes only.

-- The send mark. The lease resolves exactly as for a model call (resolve_call's run-lease
-- rules: active, this generation, unexpired, its member current, no stop, the installation
-- active on its store and connection, the connection current), under the stop interlock;
-- the run is the lease's, running; the run and call key have no operation yet (else the
-- recorded one is replayed, never created again); the run's installation's published
-- release declares runtime.execution.use with execute (ADR-0029 item 7); then, under the
-- platform capacity lock: no runtime hold is active, the month's committed worst cases plus
-- this one stay within the budget, fewer than the concurrent cap are open on the platform
-- and fewer than the per-workspace cap in this workspace; the run's vendor reservation
-- books this sandbox's worst case (`sandbox_compute`); and the operation is written
-- `sending` with its deadline, the capacity row moved in the same transaction. Outcomes:
-- begun (with the operation id and the deadline), replay (with the recorded id),
-- runtime_held, monthly_budget, concurrency_limit, workspace_limit, reservation_exhausted,
-- capability_missing, run_inactive, and resolve_call's refusals.
CREATE FUNCTION morrow_vault.runtime_operation_begin(p_lease_id text,p_generation text,p_call_key text,p_job_digest text,p_provider text)
RETURNS TABLE(outcome text,operation_id text,deadline_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE
 k record; lz record; rc record; r record; o record; i record; rel record; cap record; b record; v_found boolean; v_outcome text; v_now timestamptz;
 v_month date; v_committed numeric(20,8); v_open integer; v_op text; v_entry text; v_deadline timestamptz; n integer;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_lease_id IS NULL OR p_lease_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation IS NULL OR p_generation !~ '^[1-9][0-9]{0,15}$'
  OR p_call_key IS NULL OR p_call_key !~ '^[a-z0-9][a-z0-9_.:-]{0,63}$' OR p_job_digest IS NULL OR p_job_digest !~ '^[a-f0-9]{64}$'
  OR p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO k FROM morrow_vault.runtime_caps();
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
  SELECT x.id::text AS id INTO o FROM morrow_vault.runtime_operations x WHERE x.organization_id=rc.organization_id AND x.workspace_id=rc.workspace_id
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
  -- The platform's caps under one lock: holds, the month's budget, concurrency, the workspace.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.vault.runtime_capacity')::text,0));
  SELECT x.open_operations,x.budget_month,x.month_committed_usd INTO cap FROM morrow_vault.runtime_capacity x WHERE x.scope='platform' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_CAPACITY_MISSING'; END IF;
  v_now:=date_trunc('milliseconds',clock_timestamp());
  v_month:=date_trunc('month',v_now AT TIME ZONE 'UTC')::date;
  v_committed:=CASE WHEN cap.budget_month=v_month THEN cap.month_committed_usd ELSE 0 END;
  SELECT count(*)::integer INTO v_open FROM morrow_vault.runtime_operations x WHERE x.organization_id=rc.organization_id
   AND x.workspace_id=rc.workspace_id AND x.status IN ('sending','created','unknown_effect');
  IF EXISTS(SELECT 1 FROM morrow_vault.runtime_holds h WHERE h.lifted_at IS NULL) THEN v_outcome:='runtime_held';
  ELSIF v_committed+k.worst_case_usd>k.monthly_budget_usd THEN v_outcome:='monthly_budget';
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
 INSERT INTO morrow_vault.runtime_operations(organization_id,workspace_id,id,revision,run_id,lease_id,installation_id,call_key,job_digest,profile,
  profile_version,provider,status,unknown_reason,sandbox_ref,worst_case_usd,booking_id,send_started_at,deadline_at,reconciled_at,settled_at,updated_at)
 VALUES (rc.organization_id,rc.workspace_id,v_op,1,r.id,p_lease_id,rc.installation_id,p_call_key,p_job_digest,'morrow.computer',1,p_provider,
  'sending',NULL,NULL,k.worst_case_usd,v_entry,v_now,v_deadline,NULL,NULL,v_now);
 UPDATE morrow_vault.runtime_capacity x SET open_operations=cap.open_operations+1,budget_month=v_month,month_committed_usd=v_committed+k.worst_case_usd,
  revision=x.revision+1,updated_at=greatest(v_now,x.updated_at) WHERE x.scope='platform';
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'RUNTIME_CAPACITY_MISSING'; END IF;
 PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
 RETURN QUERY SELECT 'begun'::text,v_op,to_char(v_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END $$;

-- The create's reply: a `sending` operation records the provider's opaque id and becomes
-- `created`; the same id again is a replay. Outcomes: recorded, refused (with the status it
-- has), not_found, denied, invalid.
CREATE FUNCTION morrow_vault.runtime_operation_created(p_operation_id text,p_sandbox_ref text)
RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; v_now timestamptz;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_sandbox_ref IS NULL OR p_sandbox_ref !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.status,x.sandbox_ref INTO o
  FROM morrow_vault.runtime_operations x WHERE x.id=p_operation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF o.status='created' AND o.sandbox_ref=p_sandbox_ref THEN RETURN QUERY SELECT 'recorded'::text,'created'::text; RETURN; END IF;
 IF o.status<>'sending' THEN RETURN QUERY SELECT 'refused'::text,o.status; RETURN; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 UPDATE morrow_vault.runtime_operations x SET status='created',sandbox_ref=p_sandbox_ref,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=p_operation_id;
 RETURN QUERY SELECT 'recorded'::text,'created'::text;
END $$;

-- Settles one operation, under the capacity lock. To `unknown_effect` (with its reason): the
-- operation stays open and a runtime hold of the reason's class is raised once per operation
-- and class (quota_exhausted, billing_blocked, profile_violation for a paused sandbox,
-- unknown_effect otherwise); an operation already unknown keeps its status, records the
-- reason and the look (already_unknown). To `killed`, `absent_verified` (only once its
-- deadline plus the absent grace has passed) or `not_created` (only from `sending`): terminal,
-- and the platform's open count drops by one. A terminal operation never changes
-- (already_settled). Outcomes: settled, already_unknown, already_settled, too_early, refused,
-- not_found, denied, invalid.
CREATE FUNCTION morrow_vault.runtime_operation_settle(p_operation_id text,p_status text,p_reason text)
RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE k record; o record; v_now timestamptz; v_class text; n integer;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_status IS NULL OR p_status NOT IN ('killed','absent_verified','not_created','unknown_effect')
  OR (p_status='unknown_effect')<>(p_reason IS NOT NULL)
  OR (p_reason IS NOT NULL AND p_reason NOT IN ('create_unknown','quota_exhausted','billing_blocked','reply_invalid','kill_unknown',
   'kill_not_found','status_unknown','not_found_unverified','paused_found')) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO k FROM morrow_vault.runtime_caps();
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.vault.runtime_capacity')::text,0));
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.status,x.deadline_at INTO o
  FROM morrow_vault.runtime_operations x WHERE x.id=p_operation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF o.status IN ('killed','absent_verified','not_created') THEN RETURN QUERY SELECT 'already_settled'::text,o.status; RETURN; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 IF p_status='unknown_effect' THEN
  UPDATE morrow_vault.runtime_operations x SET status='unknown_effect',unknown_reason=p_reason,reconciled_at=greatest(v_now,x.send_started_at),
   revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=p_operation_id;
  v_class:=CASE p_reason WHEN 'quota_exhausted' THEN 'quota_exhausted' WHEN 'billing_blocked' THEN 'billing_blocked'
   WHEN 'paused_found' THEN 'profile_violation' ELSE 'unknown_effect' END;
  INSERT INTO morrow_vault.runtime_holds(id,reason,operation_id,created_at,lifted_at,lifted_by_operator_id,lift_reason)
  VALUES (gen_random_uuid()::text,v_class,p_operation_id,v_now,NULL,NULL,NULL) ON CONFLICT (operation_id,reason) DO NOTHING;
  RETURN QUERY SELECT CASE WHEN o.status='unknown_effect' THEN 'already_unknown' ELSE 'settled' END::text,'unknown_effect'::text; RETURN;
 END IF;
 IF p_status='not_created' AND o.status<>'sending' THEN RETURN QUERY SELECT 'refused'::text,o.status; RETURN; END IF;
 IF p_status='absent_verified' AND v_now<o.deadline_at+make_interval(secs=>k.absent_grace_seconds) THEN
  RETURN QUERY SELECT 'too_early'::text,o.status; RETURN;
 END IF;
 UPDATE morrow_vault.runtime_operations x SET status=p_status,settled_at=greatest(v_now,x.send_started_at),
  reconciled_at=CASE WHEN p_status='not_created' THEN x.reconciled_at ELSE greatest(v_now,x.send_started_at) END,
  revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=p_operation_id;
 UPDATE morrow_vault.runtime_capacity x SET open_operations=x.open_operations-1,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.scope='platform';
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'RUNTIME_CAPACITY_MISSING'; END IF;
 RETURN QUERY SELECT 'settled'::text,p_status;
END $$;

-- The sweep's list (ADR-0029 item 2's orphan sweep): open operations past the longest
-- execute, least recently reconciled first, across tenants, ids only: the operation, its
-- provider, its opaque sandbox id, its status, its deadline and whether the absent grace has
-- passed. Never content, a tenant key or a run. Outcomes are rows (none when denied).
CREATE FUNCTION morrow_vault.runtime_operations_open(p_limit text)
RETURNS TABLE(operation_id text,provider text,sandbox_ref text,status text,deadline_at text,stale boolean,past_grace boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE k record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') OR p_limit IS NULL OR p_limit !~ '^[1-9][0-9]?$' THEN RETURN; END IF;
 SELECT * INTO k FROM morrow_vault.runtime_caps();
 RETURN QUERY SELECT x.id::text,x.provider,x.sandbox_ref,x.status,to_char(x.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),true,
  pg_catalog.clock_timestamp()>=x.deadline_at+make_interval(secs=>k.absent_grace_seconds)
  FROM morrow_vault.runtime_operations x WHERE x.status IN ('sending','created','unknown_effect')
   AND x.send_started_at+make_interval(secs=>k.stale_seconds)<=pg_catalog.clock_timestamp()
  ORDER BY COALESCE(x.reconciled_at,x.send_started_at),x.id LIMIT p_limit::integer;
END $$;

-- ---------------------------------------------------------------------------
-- The operator's lift (ADR-0029 item 9): only a person lifts a runtime hold, by the owner's
-- audited script as morrow_work_owner, naming the operator and the reason. INVOKER, owned by
-- the owner, granted to nobody: no runtime login, the broker's included, can call it.
-- Outcomes: lifted, not_found (unknown or already lifted), invalid, denied.
CREATE FUNCTION morrow_vault.runtime_hold_lift(p_operator_id text,p_hold_id text,p_reason text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE v_now timestamptz; n integer;
BEGIN
 IF current_user<>'morrow_work_owner' THEN RETURN QUERY SELECT 'denied'::text; RETURN; END IF;
 IF p_operator_id IS NULL OR p_operator_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_hold_id IS NULL OR p_hold_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 1024 OR p_reason !~ '\S' THEN
  RETURN QUERY SELECT 'invalid'::text; RETURN;
 END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 UPDATE morrow_vault.runtime_holds h SET lifted_at=greatest(v_now,h.created_at),lifted_by_operator_id=p_operator_id,lift_reason=p_reason
  WHERE h.id=p_hold_id AND h.lifted_at IS NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN QUERY SELECT CASE WHEN n=1 THEN 'lifted' ELSE 'not_found' END::text;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S7 reads proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_vault.runtime_caps() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.runtime_operation_created(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.runtime_operation_settle(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.runtime_operations_open(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.runtime_hold_lift(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_vault.runtime_caps() TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text),morrow_vault.runtime_operation_created(text,text),
 morrow_vault.runtime_operation_settle(text,text,text),morrow_vault.runtime_operations_open(text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_operation_created(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_operation_settle(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_operations_open(text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
