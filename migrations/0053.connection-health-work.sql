BEGIN;
-- v1 PR 5, "Keep the store connection healthy": the work, connector and vault side (ADR-0025
-- items 9 and 10; ADR-0031 item 3; docs/briefs/v1-connection-health.md). Executes AS
-- morrow_work_owner, after connection-health-identity (0052). It adds:
--   * connection_notices: the "Reconnect" item of a store connection (ADR-0025 item 10), one
--     open per connection, for the connection steward and the Owner, naming the scopes the
--     app requests that are missing (or that Shopify refused the token) and the agent
--     installations stopped for it. Content-free (ids, scope names, codes and times); the
--     Inbox reads it through connection_notices_open() (the Inbox screen and its item kind
--     are PR 15's and PR 10b's: this table is the seam). Cleared when the scopes are back
--     (a re-authorisation or an observation) or when the connection ends; a cleared notice
--     never changes again. Nothing resumes by itself: the stops stay until a person lifts them;
--   * the system installation stop of a scope change (StopRecord@1, actor system, reason
--     shopify_scope_missing, or shopify_token_refused when Shopify refused the token) on each
--     agent installation of the store whose release needs a scope no longer granted
--     (release_shopify_scopes; read_products is the connection's required scope, so its loss
--     stops every agent). The other agents keep running. An installation a person already
--     stopped keeps the person's stop alone (0020's one open stop per target) and is named
--     in the notice; if the person lifts it while the scope is still missing, the cron's
--     reconcile stops it again. Every reconcile marks the notice's reconciled_at, and the
--     cron's list takes the least recently reconciled first, so every open item is
--     reconciled again however many there are (PR 5 review finding F3);
--   * the connector definers (EXECUTE for morrow_connector_ingress only; each overwrites every
--     connector setting on entry): connector_inbox_apply_v2 (app/scopes_update keeps the
--     connection and its token: it records the delivery's current scopes, which only narrow,
--     and reconciles; every other topic is 0037's connector_inbox_apply, unchanged, followed
--     by the reconcile that clears the notice of an ended connection), connector_health_reconcile
--     (after the broker's read-back), and the clean-up jobs' ids-only lists and steps: the
--     read-backs due, the open notices and the connections that need reconnecting, the
--     48-hour deletions due, connector_deletion_apply
--     (ADR-0031 item 3: every store-content and identity handler of an installation
--     uninstalled 48 hours ago whose shop/redact never completed, once, with its record) and
--     the stuck-delivery close;
--   * the vault definers (EXECUTE for morrow_vault_broker only): shopify_install_prepare_v2
--     (0027's prepare, and for a reinstall the earlier installations' leftover tokens
--     destroyed in the same install transaction), shopify_check_resolve and
--     shopify_check_record (the read-back of the granted scopes with the installation's own
--     token, ADR-0025 item 10, and the record of what Shopify answered, refused as stale when
--     the installation changed after the read began);
--   * the api's read of the viewer's Reconnect items (connection_notices_open, session only).
-- No definer here sends a request; nothing deletes outside the 0038 store-content handlers.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.connection_notices') IS NOT NULL
 OR to_regprocedure('morrow_work.connector_inbox_apply(text)') IS NULL
 OR to_regprocedure('morrow_work.connector_inbox_apply_v2(text)') IS NOT NULL
 OR to_regprocedure('morrow_work.store_content_redact(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_vault.shopify_credential_destroy(text,text)') IS NULL
 OR to_regprocedure('morrow_vault.shopify_install_prepare(text,text,text,text)') IS NULL
 OR to_regclass('morrow_work.agent_installations') IS NULL OR to_regclass('morrow_work.stop_controls') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_scopes_record(text,text,text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_health_target(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_check_target(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_checks_due()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_reconnect_due()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_reinstall_leftovers(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_deletions_due()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_deletion_open(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_redact_identity(text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_deletion_complete(text,text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_stuck()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_take(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_settle(text,text,text,jsonb)','EXECUTE')
 -- The 0020 index this file relies on: one open stop per installation target.
 OR (SELECT pg_catalog.pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i
   WHERE i.indexrelid=to_regclass('morrow_work.stop_controls_one_per_target'))
  IS DISTINCT FROM 'CREATE UNIQUE INDEX stop_controls_one_per_target ON morrow_work.stop_controls USING btree (organization_id, workspace_id, scope, target_id) WHERE ((scope <> ''platform''::text) AND (lifted_at IS NULL))'
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_work' AND p.policyname LIKE 'connector\_health%')
 THEN RAISE EXCEPTION 'CONNECTION_HEALTH_WORK_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner. CHECK constraints run with the writer's
-- privileges, so the command role holds EXECUTE (the 0015 valid_scope pattern).
-- The Shopify scopes an agent release needs (ADR-0025 items 6 and 10). The Listings release
-- reads and writes products. Any other release is unknown here and needs every scope the
-- app requests (the reconcile's fallback), so it stops on any loss. A new release that needs
-- other scopes revises this function in its own forward migration.
CREATE FUNCTION morrow_work.release_shopify_scopes(p_release_id text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE p_release_id WHEN 'morrow.listings' THEN ARRAY['read_products','write_products']::text[] END
$$;
-- A notice's scope list: at most 8 distinct scope names.
CREATE FUNCTION morrow_work.notice_scopes_valid(p_list jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_list IS NOT NULL AND jsonb_typeof(p_list)='array' AND jsonb_array_length(p_list)<=8
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_list) e WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[a-z][a-z_]{0,63}$')
  AND (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_list) e)=jsonb_array_length(p_list)
$$;
-- A notice's id list (agent installations, recipients): at most p_max distinct ids.
CREATE FUNCTION morrow_work.notice_ids_valid(p_list jsonb,p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_list IS NOT NULL AND jsonb_typeof(p_list)='array' AND jsonb_array_length(p_list)<=p_max
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_list) e WHERE jsonb_typeof(e)<>'string'
   OR (e#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  AND (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_list) e)=jsonb_array_length(p_list)
$$;

-- ---------------------------------------------------------------------------
-- The Reconnect item of one store connection (ADR-0025 item 10). Born open at revision 1;
-- while open, each reconcile may revise what it names (revision+1), and every reconcile marks
-- reconciled_at (alone, without a revision, when nothing it names changed: the cron's list
-- rotates by it); cleared once, then never changed. One open per connection. No delete or
-- truncate.
CREATE TABLE morrow_work.connection_notices (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind='reconnect'),
 cause text NOT NULL CHECK (cause IN ('scopes_missing','token_refused')),
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 missing_scopes jsonb NOT NULL CHECK (morrow_work.notice_scopes_valid(missing_scopes)),
 stopped_installations jsonb NOT NULL CHECK (morrow_work.notice_ids_valid(stopped_installations,32)),
 recipients jsonb NOT NULL CHECK (morrow_work.notice_ids_valid(recipients,2)),
 source_inbox_id text CHECK (source_inbox_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 cleared_at timestamptz CHECK (cleared_at=date_trunc('milliseconds',cleared_at) AND isfinite(cleared_at)),
 cleared_reason text CHECK (cleared_reason IN ('scopes_restored','connection_ended')),
 reconciled_at timestamptz NOT NULL CHECK (reconciled_at=date_trunc('milliseconds',reconciled_at) AND isfinite(reconciled_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT connection_notices_clear CHECK ((cleared_at IS NULL)=(cleared_reason IS NULL)),
 CONSTRAINT connection_notices_times CHECK (updated_at>=created_at AND (cleared_at IS NULL OR cleared_at>=created_at)
  AND reconciled_at>=created_at)
);
CREATE UNIQUE INDEX connection_notices_one_open ON morrow_work.connection_notices (organization_id,workspace_id,connection_id)
 WHERE cleared_at IS NULL;
CREATE INDEX connection_notices_open ON morrow_work.connection_notices (reconciled_at,id) WHERE cleared_at IS NULL;
CREATE INDEX connection_notices_open_installation ON morrow_work.connection_notices (installation_id) WHERE cleared_at IS NULL;
-- The notice guard (INVOKER, owned by the owner, granted to nobody).
CREATE FUNCTION morrow_work.connection_notice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','cause','missing_scopes','stopped_installations','recipients','source_inbox_id','updated_at',
 'cleared_at','cleared_reason','reconciled_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.cleared_at IS NOT NULL OR NEW.updated_at<>NEW.created_at OR NEW.reconciled_at<>NEW.created_at THEN
   RAISE EXCEPTION 'WORK_NOTICE_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.cleared_at IS NULL AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
  AND NEW.reconciled_at>=OLD.reconciled_at AND (to_jsonb(NEW)-v_mutable)=(to_jsonb(OLD)-v_mutable)
  AND (NEW.cleared_at IS NULL OR NEW.cleared_at>=OLD.updated_at) THEN
  RETURN NEW;
 END IF;
 -- A reconcile that changed nothing the item names marks only when it ran.
 IF TG_OP='UPDATE' AND OLD.cleared_at IS NULL AND NEW.reconciled_at>=OLD.reconciled_at
  AND (to_jsonb(NEW)-'reconciled_at')=(to_jsonb(OLD)-'reconciled_at') THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'WORK_NOTICE_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_work.connection_notice_guard() FROM PUBLIC;
CREATE TRIGGER connection_notice_guard BEFORE INSERT OR UPDATE ON morrow_work.connection_notices
 FOR EACH ROW EXECUTE FUNCTION morrow_work.connection_notice_guard();
CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.connection_notices FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.connection_notices FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();
ALTER TABLE morrow_work.connection_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_work.connection_notices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON morrow_work.connection_notices FROM PUBLIC;
CREATE POLICY work_owner ON morrow_work.connection_notices TO morrow_work_owner USING (true) WITH CHECK (true);
-- The session template, read only: the api's read definer (connection_notices_open). No
-- session definer writes a notice.
CREATE POLICY tenant_command ON morrow_work.connection_notices FOR SELECT TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
-- The connector's health context. morrow.connector_health names exactly one
-- org|ws|store|connection and morrow.connector_agent_stop one org|ws|store; only
-- connection_health_reconcile (called by the connector definers below) writes them, from the
-- installation row itself, and clears them. The connector login holds no table privilege,
-- so a setting it forges reaches nothing; every connector definer overwrites them on entry.
CREATE POLICY connector_health_read ON morrow_work.connection_notices FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_health',true));
CREATE POLICY connector_health_raise ON morrow_work.connection_notices FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_connector_ingress' AND cleared_at IS NULL
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_health',true));
CREATE POLICY connector_health_revise ON morrow_work.connection_notices FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_health',true))
 WITH CHECK (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_health',true));
-- The cron's open-notice list (connector_notices_due, ids only): every open notice, only
-- while that definer's own setting is on.
CREATE POLICY connector_health_sweep ON morrow_work.connection_notices FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND cleared_at IS NULL
  AND pg_catalog.current_setting('morrow.connector_sweep',true)='open');
GRANT SELECT,INSERT ON morrow_work.connection_notices TO morrow_work_command;
GRANT UPDATE (revision,cause,missing_scopes,stopped_installations,recipients,source_inbox_id,updated_at,cleared_at,cleared_reason,
 reconciled_at) ON morrow_work.connection_notices TO morrow_work_command;
-- The store's agent installations, read in the health context.
CREATE POLICY connector_health_agents ON morrow_work.agent_installations FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_health',true));
-- The system installation stop of a scope change (StopRecord@1): the store's installation
-- stops, read and set by the system only, with the two reasons; never a lift, a person's
-- stop, a connection stop or an update. stop_guard revokes the installation's run and
-- operation leases under connector_health_lease_*.
CREATE POLICY connector_health_stop_read ON morrow_work.stop_controls FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND scope='installation'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_agent_stop',true));
CREATE POLICY connector_health_stop_set ON morrow_work.stop_controls FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_connector_ingress' AND scope='installation' AND set_by_kind='system' AND lifted_at IS NULL
  AND kill_switch_record_id IS NULL AND reason_code IN ('shopify_scope_missing','shopify_token_refused')
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_agent_stop',true));
CREATE POLICY connector_health_stop_record ON morrow_work.stop_records FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_connector_ingress' AND action='set' AND actor_kind='system' AND operator_id IS NULL
  AND scope='installation' AND reason_code IN ('shopify_scope_missing','shopify_token_refused')
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_agent_stop',true));
CREATE POLICY connector_health_lease_read ON morrow_work.work_leases FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND installation_id IS NOT NULL
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_agent_stop',true));
CREATE POLICY connector_health_lease_revoke ON morrow_work.work_leases FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND installation_id IS NOT NULL
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_agent_stop',true))
 WITH CHECK (status='revoked' AND revoked_reason='stop' AND session_user='morrow_connector_ingress' AND installation_id IS NOT NULL
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_agent_stop',true));

-- ---------------------------------------------------------------------------
-- The reconcile (a revisable owner helper: INVOKER, owned by the owner, EXECUTE for the
-- command role only; the connector definers below are its only callers). From the store
-- installation's own state (work_shopify_health_target: the scopes it records, the scopes its
-- app requests, a token refusal, its status), under the store's stop interlock:
--   * an ended connection (not unlinked or linked) clears its open notice (connection_ended);
--   * otherwise each agent installation of the store whose release needs a scope that is not
--     granted (every scope when Shopify refused the token) is stopped, unless a stop already
--     stands on it: one system installation stop (shopify_scope_missing or
--     shopify_token_refused) and its StopRecord@1 (stop_guard revokes its run and operation
--     leases);
--   * one open notice per connection names the missing requested scopes and the stopped
--     agents, for the steward and the Owner; it is revised when either changes, and cleared
--     (scopes_restored) once nothing is missing and no agent needs a scope. The stops stay:
--     nothing resumes by itself;
--   * every pass marks the notice's reconciled_at, an unchanged one included, so the cron's
--     list (connector_notices_due) reaches every open item in turn.
-- Returns {outcome, notice, missing, stopped, newly}.
CREATE FUNCTION morrow_work.connection_health_reconcile(p_org text,p_ws text,p_installation_id text,p_inbox_id text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE t record; n record; a record; v_granted text[]; v_requested text[]; v_missing text[]; v_needs text[]; v_stopped text[]:='{}';
 v_new integer:=0; v_cause text; v_code text; v_reason text; v_stop_id text; v_at timestamptz; v_recipients jsonb; v_notice text:='none';
BEGIN
 SELECT * INTO t FROM morrow_identity.work_shopify_health_target(p_installation_id);
 IF t.outcome IS DISTINCT FROM 'found' OR t.organization_id IS DISTINCT FROM p_org OR t.workspace_id IS DISTINCT FROM p_ws THEN
  RETURN jsonb_build_object('outcome','not_found','notice','none','missing',0,'stopped',0,'newly',0);
 END IF;
 PERFORM pg_catalog.set_config('morrow.connector_health',p_org||'|'||p_ws||'|'||t.store_id||'|'||t.connection_id,true),
  pg_catalog.set_config('morrow.connector_agent_stop',p_org||'|'||p_ws||'|'||t.store_id,true);
 -- The store's stop interlock (stop_guard's key), so a run or a person's stop on this store
 -- is serialised with this pass.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  p_org,p_ws,t.store_id)::text,0));
 SELECT x.* INTO n FROM morrow_work.connection_notices x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
  AND x.connection_id=t.connection_id AND x.cleared_at IS NULL FOR UPDATE;
 v_at:=morrow_work.db_now();
 IF t.status NOT IN ('unlinked','linked') THEN
  IF n.id IS NOT NULL THEN
   UPDATE morrow_work.connection_notices x SET cleared_at=greatest(v_at,x.updated_at),cleared_reason='connection_ended',
    revision=x.revision+1,updated_at=greatest(v_at,x.updated_at),reconciled_at=greatest(v_at,x.reconciled_at)
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=n.id;
   v_notice:='cleared';
  END IF;
  PERFORM pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true);
  RETURN jsonb_build_object('outcome','ended','notice',v_notice,'missing',0,'stopped',0,'newly',0);
 END IF;
 v_requested:=string_to_array(t.requested_scopes,',');
 v_granted:=CASE WHEN t.token_refused THEN '{}'::text[] ELSE COALESCE(string_to_array(NULLIF(t.granted_scopes,''),','),'{}'::text[]) END;
 v_cause:=CASE WHEN t.token_refused THEN 'token_refused' ELSE 'scopes_missing' END;
 v_code:=CASE WHEN t.token_refused THEN 'shopify_token_refused' ELSE 'shopify_scope_missing' END;
 v_reason:=CASE WHEN t.token_refused THEN 'Shopify no longer accepts the store connection''s access token.'
  ELSE 'The Shopify app no longer has a permission this agent needs.' END;
 SELECT COALESCE(array_agg(s ORDER BY s),'{}') INTO v_missing FROM unnest(v_requested) s WHERE NOT (s=ANY(v_granted));
 FOR a IN SELECT x.id::text AS id,x.release_id FROM morrow_work.agent_installations x
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=t.store_id AND x.connection_id=t.connection_id
    AND x.status<>'uninstalled' ORDER BY x.created_at,x.id LOOP
  v_needs:=COALESCE(morrow_work.release_shopify_scopes(a.release_id),v_requested)||ARRAY['read_products']::text[];
  IF v_needs<@v_granted THEN CONTINUE; END IF;
  v_stopped:=v_stopped||a.id;
  IF NOT EXISTS(SELECT 1 FROM morrow_work.stop_controls s WHERE s.organization_id=p_org AND s.workspace_id=p_ws
    AND s.scope='installation' AND s.target_id=a.id AND s.lifted_at IS NULL) THEN
   v_stop_id:=gen_random_uuid()::text;
   INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,
    set_by_membership_id,set_by_operator_id,reason_code,reason,created_at)
   VALUES (p_org,p_ws,v_stop_id,'installation',t.store_id,a.id,'system',NULL,NULL,NULL,v_code,v_reason,v_at);
   INSERT INTO morrow_work.stop_records(organization_id,workspace_id,id,stop_control_id,action,scope,store_id,target_id,actor_kind,
    operator_id,reason_code,reason,recorded_at)
   VALUES (p_org,p_ws,gen_random_uuid()::text,v_stop_id,'set','installation',t.store_id,a.id,'system',NULL,v_code,v_reason,v_at);
   v_new:=v_new+1;
  END IF;
 END LOOP;
 IF cardinality(v_missing)>0 OR cardinality(v_stopped)>0 THEN
  SELECT COALESCE(jsonb_agg(DISTINCT p),'[]'::jsonb) INTO v_recipients FROM unnest(ARRAY[t.steward_principal_id,t.owner_principal_id]) p
   WHERE p IS NOT NULL;
  IF n.id IS NULL THEN
   INSERT INTO morrow_work.connection_notices(organization_id,workspace_id,id,revision,kind,cause,store_id,connection_id,installation_id,
    missing_scopes,stopped_installations,recipients,source_inbox_id,created_at,updated_at,cleared_at,cleared_reason,reconciled_at)
   VALUES (p_org,p_ws,gen_random_uuid()::text,1,'reconnect',v_cause,t.store_id,t.connection_id,p_installation_id,to_jsonb(v_missing),
    to_jsonb(v_stopped),v_recipients,p_inbox_id,v_at,v_at,NULL,NULL,v_at);
   v_notice:='raised';
  ELSIF n.missing_scopes IS DISTINCT FROM to_jsonb(v_missing) OR n.stopped_installations IS DISTINCT FROM to_jsonb(v_stopped)
   OR n.cause IS DISTINCT FROM v_cause OR n.recipients IS DISTINCT FROM v_recipients THEN
   UPDATE morrow_work.connection_notices x SET cause=v_cause,missing_scopes=to_jsonb(v_missing),stopped_installations=to_jsonb(v_stopped),
    recipients=v_recipients,source_inbox_id=COALESCE(p_inbox_id,x.source_inbox_id),revision=x.revision+1,updated_at=greatest(v_at,x.updated_at),
    reconciled_at=greatest(v_at,x.reconciled_at)
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=n.id;
   v_notice:='revised';
  ELSE
   UPDATE morrow_work.connection_notices x SET reconciled_at=greatest(v_at,x.reconciled_at)
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=n.id;
   v_notice:='unchanged';
  END IF;
 ELSIF n.id IS NOT NULL THEN
  UPDATE morrow_work.connection_notices x SET cleared_at=greatest(v_at,x.updated_at),cleared_reason='scopes_restored',
   revision=x.revision+1,updated_at=greatest(v_at,x.updated_at),reconciled_at=greatest(v_at,x.reconciled_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=n.id;
  v_notice:='cleared';
 END IF;
 PERFORM pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true);
 RETURN jsonb_build_object('outcome','reconciled','notice',v_notice,'missing',cardinality(v_missing),'stopped',cardinality(v_stopped),
  'newly',v_new);
END $$;

-- ---------------------------------------------------------------------------
-- The connector definers: SECURITY DEFINER, owned by the command role after the transfer
-- below, EXECUTE for morrow_connector_ingress only (work_executor_safe). Each takes ids only
-- and overwrites every connector setting on entry.
-- The applier of one recorded inbox row (replaces 0037's for the connector; 0037's stays
-- and runs every topic but app/scopes_update, unchanged). The tenant and installation come
-- only from the row the broker recorded:
--   app/scopes_update  the connection and its token stay (ADR-0025 item 10): the delivery's
--     current scopes are recorded (they only narrow: deliveries arrive out of order, and the
--     broker's read-back or a re-authorisation adds a scope back), then the reconcile stops
--     the agents that need a missing scope and raises or revises the Reconnect item. An
--     ended installation changes nothing (ignored). No token is destroyed;
--   every other topic  0037's applier, then, for an uninstall or shop/redact, the reconcile
--     clears the ended connection's Reconnect item.
-- Outcomes as 0037's: applied, pending, settled, not_found, invalid, denied.
CREATE FUNCTION morrow_work.connector_inbox_apply_v2(p_inbox_id text)
RETURNS TABLE(outcome text,topic text,installation_id text,credential text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE x record; r record; s record; h jsonb; v_body jsonb;
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_inbox_id IS NULL OR p_inbox_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO x FROM morrow_identity.work_shopify_inbox_take(p_inbox_id);
 IF x.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT COALESCE(x.outcome,'not_found'),NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF x.topic<>'app/scopes_update' THEN
  SELECT * INTO r FROM morrow_work.connector_inbox_apply(p_inbox_id);
  IF r.outcome IN ('applied','pending') AND x.topic IN ('app/uninstalled','shop/redact') AND x.installation_id IS NOT NULL THEN
   PERFORM morrow_work.connection_health_reconcile(x.organization_id,x.workspace_id,x.installation_id,NULL);
  END IF;
  RETURN QUERY SELECT r.outcome,r.topic,r.installation_id,r.credential,r.reason; RETURN;
 END IF;
 IF x.status<>'received' THEN RETURN QUERY SELECT 'settled'::text,x.topic,x.installation_id,NULL::text,NULL::text; RETURN; END IF;
 IF x.installation_id IS NULL THEN
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'ignored','no_installation','{}'::jsonb) NOT IN ('settled','already_settled') THEN
   RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED';
  END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,NULL::text,'none'::text,NULL::text; RETURN;
 END IF;
 v_body:=x.body::jsonb;
 SELECT * INTO s FROM morrow_identity.work_shopify_scopes_record(x.organization_id,x.workspace_id,x.installation_id,'narrow',
  (v_body->'current')::text,NULL,NULL);
 IF s.outcome IS NULL OR s.outcome NOT IN ('applied','unchanged','ineligible') THEN RAISE EXCEPTION 'CONNECTOR_SCOPES_REFUSED'; END IF;
 IF s.outcome='ineligible' THEN
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'ignored','installation_ended',jsonb_build_object('installation',s.status))
   NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
 END IF;
 h:=morrow_work.connection_health_reconcile(x.organization_id,x.workspace_id,x.installation_id,p_inbox_id);
 IF h->>'outcome' IS DISTINCT FROM 'reconciled' THEN RAISE EXCEPTION 'CONNECTOR_RECONCILE_REFUSED'; END IF;
 IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'applied','scopes_recorded',jsonb_build_object(
   'scopes',CASE WHEN s.outcome='applied' THEN 'narrowed' ELSE 'unchanged' END,'notice',h->>'notice',
   'agents_stopped',(h->>'stopped')::integer,'agents_newly_stopped',(h->>'newly')::integer))
  NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
 RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text;
END $$;
-- The reconcile of one installation after the broker's read-back (or for the cron's open
-- notices): the tenant comes from the installation itself. Outcomes: reconciled, ended,
-- not_found, invalid, denied; with what the reconcile did to the notice and the agents.
CREATE FUNCTION morrow_work.connector_health_reconcile(p_installation_id text)
RETURNS TABLE(outcome text,notice text,stopped integer,newly integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; h jsonb;
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::integer,NULL::integer; RETURN;
 END IF;
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::integer,NULL::integer; RETURN;
 END IF;
 SELECT x.outcome,x.organization_id,x.workspace_id INTO t FROM morrow_identity.work_shopify_health_target(p_installation_id) x;
 IF t.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT COALESCE(t.outcome,'not_found'),NULL::text,NULL::integer,NULL::integer; RETURN;
 END IF;
 h:=morrow_work.connection_health_reconcile(t.organization_id,t.workspace_id,p_installation_id,NULL);
 RETURN QUERY SELECT h->>'outcome',h->>'notice',(h->>'stopped')::integer,(h->>'newly')::integer;
END $$;
-- The cron's read-back list (ids only, across tenants): live installations whose scopes were
-- not observed in the last 24 hours, at most 20.
CREATE FUNCTION morrow_work.connector_checks_due()
RETURNS TABLE(installation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 RETURN QUERY SELECT d.installation_id FROM morrow_identity.work_shopify_checks_due() d;
END $$;
-- The cron's reconcile list (ids only, across tenants): the live installations that need
-- reconnecting and have no open Reconnect item (work_shopify_reconnect_due: a recorded
-- narrowing or refusal whose reconcile was lost gets its stops and its item) first, then the
-- store installations of open Reconnect items, least recently reconciled first (cleared once
-- their scopes are back; an agent a person resumed while a scope is missing is stopped
-- again), at most 20. Every reconcile marks its item's reconciled_at, so successive runs
-- reach every open item, and an installation without an item gets one from its first
-- reconcile and leaves the first group (PR 5 review finding F3).
CREATE FUNCTION morrow_work.connector_notices_due()
RETURNS TABLE(installation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 PERFORM pg_catalog.set_config('morrow.connector_sweep','open',true);
 RETURN QUERY SELECT u.id FROM (
   SELECT n.installation_id::text AS id,n.reconciled_at AS at FROM morrow_work.connection_notices n WHERE n.cleared_at IS NULL
   UNION ALL SELECT d.installation_id,NULL::timestamptz FROM morrow_identity.work_shopify_reconnect_due() d
    WHERE NOT EXISTS(SELECT 1 FROM morrow_work.connection_notices n WHERE n.cleared_at IS NULL AND n.installation_id::text=d.installation_id)) u
  GROUP BY u.id ORDER BY min(u.at) NULLS FIRST,u.id LIMIT 20;
 PERFORM pg_catalog.set_config('morrow.connector_sweep','',true);
END $$;
-- The cron's 48-hour deletion list (ids only, across tenants; ADR-0031 item 3).
CREATE FUNCTION morrow_work.connector_deletions_due()
RETURNS TABLE(installation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 RETURN QUERY SELECT d.installation_id FROM morrow_identity.work_shopify_deletions_due() d;
END $$;
-- The 48-hour deletion of one installation (ADR-0031 item 3; owner question 2: a reinstall
-- within the 48 hours does not stop it, because the reinstall is another installation with its
-- own store). Once per installation, with its record (store_data_deletions): every
-- store-content handler of its store in the connector's redaction context
-- (store_content_redact, as shop/redact runs it), the identity handlers (shop/redact's own
-- work_shopify_redact_identity, as 0052 revises it: the domain becomes the pseudonym; the
-- install link is cleared unless a reinstall is live), the Reconnect item
-- of the ended connection cleared, and the record completed only when nothing is outstanding,
-- the token's destruction included: until it is recorded the outcome is pending with the
-- credential to destroy (reason uninstalled), as shop/redact's. Outcomes: applied, pending,
-- settled (completed before), ineligible (not uninstalled 48 hours ago), not_found, invalid,
-- denied.
CREATE FUNCTION morrow_work.connector_deletion_apply(p_installation_id text)
RETURNS TABLE(outcome text,installation_id text,credential text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE d record; v_identity record; v_content jsonb; v_handlers jsonb; v_outstanding jsonb; v_evidence jsonb; v_completed text;
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO d FROM morrow_identity.work_shopify_deletion_open(p_installation_id);
 IF d.outcome='settled' THEN
  RETURN QUERY SELECT 'settled'::text,p_installation_id,'destroyed'::text,'uninstalled'::text; RETURN;
 END IF;
 IF d.outcome IS NULL OR d.outcome NOT IN ('opened','open') THEN
  RETURN QUERY SELECT COALESCE(d.outcome,'invalid'),NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 -- The store's content (work schema), in the connector's redaction context, under the
 -- store's stop interlock (store_content_redact's run-step rule), then its identity.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  d.organization_id,d.workspace_id,d.store_id)::text,0));
 PERFORM pg_catalog.set_config('morrow.connector_redact',d.organization_id||'|'||d.workspace_id||'|'||d.store_id,true);
 v_content:=morrow_work.store_content_redact(d.organization_id,d.workspace_id,d.store_id);
 PERFORM pg_catalog.set_config('morrow.connector_redact','',true);
 SELECT * INTO v_identity FROM morrow_identity.work_shopify_redact_identity(d.organization_id,d.workspace_id,p_installation_id);
 IF v_identity.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CONNECTOR_IDENTITY_REDACT_REFUSED'; END IF;
 PERFORM morrow_work.connection_health_reconcile(d.organization_id,d.workspace_id,p_installation_id,NULL);
 SELECT COALESCE(jsonb_agg(c-'remaining' ORDER BY c->>'table'),'[]'::jsonb),
  COALESCE(jsonb_agg(c->'table' ORDER BY c->>'table') FILTER (WHERE (c->>'remaining')::bigint>0),'[]'::jsonb)
  INTO v_handlers,v_outstanding FROM jsonb_array_elements(v_content) c;
 v_handlers:=v_handlers||jsonb_build_array(
  jsonb_build_object('table','morrow_identity.linking_candidates','action','pseudonymise','rows',v_identity.candidates),
  jsonb_build_object('table','morrow_identity.shopify_apps','action','clear_install_link','rows',v_identity.apps),
  jsonb_build_object('table','morrow_identity.store_installations','action','pseudonymise','rows',v_identity.installations));
 IF d.credential_destroyed THEN
  v_handlers:=jsonb_build_array(jsonb_build_object('table','morrow_vault.credentials','action','destroy_credential',
   'rows',d.credential_version))||v_handlers;
 ELSE
  v_outstanding:=v_outstanding||'["morrow_vault.credentials"]'::jsonb;
 END IF;
 IF v_outstanding<>'[]'::jsonb THEN
  RETURN QUERY SELECT 'pending'::text,p_installation_id,CASE WHEN d.credential_destroyed THEN 'destroyed' ELSE 'pending' END,
   'uninstalled'::text;
  RETURN;
 END IF;
 v_evidence:=jsonb_build_object('schemaVersion',1,'kind','store_deleted','scopes','["read_products","write_products"]'::jsonb,
  'handlers',v_handlers,'credential','destroyed','outstanding','[]'::jsonb);
 v_completed:=morrow_identity.work_shopify_deletion_complete(d.organization_id,d.workspace_id,p_installation_id,v_evidence);
 IF v_completed NOT IN ('completed','already_completed') THEN RAISE EXCEPTION 'CONNECTOR_DELETION_REFUSED'; END IF;
 RETURN QUERY SELECT 'applied'::text,p_installation_id,'destroyed'::text,'uninstalled'::text;
END $$;
-- The cron's stuck-delivery close (ADR-0025 item 10's reconcile covers the scopes): counts
-- only, across tenants.
CREATE FUNCTION morrow_work.connector_inbox_stuck()
RETURNS TABLE(closed integer,stuck integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 RETURN QUERY SELECT s.closed,s.stuck FROM morrow_identity.work_shopify_inbox_stuck() s;
END $$;

-- ---------------------------------------------------------------------------
-- The vault definers: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_vault_broker only.
-- The install's prepare (0027's, same outcomes and columns), for the broker's one install
-- transaction: for a fresh install of an app and shop that had installations before (a
-- reinstall), every earlier installation's token that is still undestroyed is destroyed first,
-- through 0037's shopify_credential_destroy (recorded on its installation in this same
-- transaction), so the new token is stored only once the old ones are erased; the identity
-- record refuses the reinstall otherwise.
CREATE FUNCTION morrow_vault.shopify_install_prepare_v2(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,installation_id text,store_id text,connection_id text,
 credential_id text,credential_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; l record; v_destroyed text;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_identity.work_shopify_install_prepare(p_app_key,p_state_digest,p_shop_id,p_shop_domain);
 IF r.outcome='install' THEN
  FOR l IN SELECT x.installation_id FROM morrow_identity.work_shopify_reinstall_leftovers(p_app_key,p_shop_id) x LOOP
   v_destroyed:=morrow_vault.shopify_credential_destroy(l.installation_id,'uninstalled');
   IF v_destroyed IS NULL OR v_destroyed NOT IN ('destroyed','already_destroyed') THEN RAISE EXCEPTION 'SHOPIFY_REINSTALL_LEFTOVER_REFUSED'; END IF;
  END LOOP;
 END IF;
 RETURN QUERY SELECT COALESCE(r.outcome,'state_invalid'),r.organization_id,r.workspace_id,r.installation_id,r.store_id,
  r.connection_id,r.credential_id,r.credential_version;
END $$;
-- The read-back's resolution (ADR-0025 item 10): a live installation's shop domain, its
-- revision (which the record must find unchanged) and its active credential's envelope (the
-- subject the envelope binds), for one fixed request of the granted scopes. Outcomes:
-- resolved, ineligible, credential_unavailable, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_check_resolve(p_installation_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,shop_domain text,credential_id text,credential_version text,
 revision text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; c record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_check_target(p_installation_id);
 IF t.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT COALESCE(t.outcome,'invalid'),NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text;
  RETURN;
 END IF;
 SELECT x.kek_version::text AS kek_version,encode(x.wrapped_key,'hex') AS wrapped_key,encode(x.sealed_value,'hex') AS sealed_value INTO c
  FROM morrow_vault.credentials x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=t.credential_id
   AND x.version::text=t.credential_version AND x.subject_id=p_installation_id AND x.status='active';
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'credential_unavailable'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT 'resolved'::text,t.organization_id,t.workspace_id,t.shop_domain,t.credential_id,t.credential_version,t.revision,
  c.kek_version,c.wrapped_key,c.sealed_value;
END $$;
-- The read-back's record: what Shopify answered for the token of p_credential_version, read
-- after the resolution found the installation at p_revision (observed with its granted
-- scopes as a JSON array of names, or refused); stale when the token or the installation
-- changed since (a delivery's narrowing in between is never undone by the earlier read).
-- Outcomes: applied, unchanged, stale, ineligible, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_check_record(p_installation_id text,p_credential_version text,p_revision text,p_result text,
 p_scopes text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE t record; s record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 IF p_result IS NULL OR p_result NOT IN ('observed','refused') OR (p_result='observed')<>(p_scopes IS NOT NULL) THEN RETURN 'invalid'; END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_check_target(p_installation_id);
 IF t.outcome IS DISTINCT FROM 'found' THEN RETURN COALESCE(t.outcome,'invalid'); END IF;
 SELECT * INTO s FROM morrow_identity.work_shopify_scopes_record(t.organization_id,t.workspace_id,p_installation_id,p_result,p_scopes,
  p_credential_version,p_revision);
 RETURN COALESCE(s.outcome,'invalid');
END $$;

-- ---------------------------------------------------------------------------
-- The api's read of the viewer's open Reconnect items (session only): the session tenant's
-- open notices whose recipients name the viewer, with whether each is still open against the
-- installation's current state (a re-authorisation clears it before the cron does). Ids,
-- scope names, codes and times only; at most 20.
CREATE FUNCTION morrow_work.connection_notices_open()
RETURNS TABLE(notice_id text,kind text,cause text,store_id text,connection_id text,installation_id text,missing_scopes text,
 stopped_installations text,revision text,created_at text,updated_at text,still_open text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 SELECT c.organization_id,c.workspace_id,c.principal_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT n.id::text,n.kind,n.cause,n.store_id::text,n.connection_id::text,n.installation_id::text,
  (SELECT COALESCE(string_agg(s,',' ORDER BY s),'') FROM jsonb_array_elements_text(n.missing_scopes) s),n.stopped_installations::text,
  n.revision::text,morrow_work.utc_text(n.created_at),morrow_work.utc_text(n.updated_at),
  EXISTS(SELECT 1 FROM morrow_identity.work_shopify_health_target(n.installation_id::text) h WHERE h.outcome='found'
   AND h.status IN ('unlinked','linked') AND (h.token_refused OR NOT (string_to_array(h.requested_scopes,',')
    <@COALESCE(string_to_array(NULLIF(h.granted_scopes,''),','),'{}'::text[]))))::text
  FROM morrow_work.connection_notices n
  WHERE n.organization_id=t.organization_id AND n.workspace_id=t.workspace_id AND n.cleared_at IS NULL
   AND n.recipients ? t.principal_id
  ORDER BY n.updated_at DESC,n.id LIMIT 20;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.release_shopify_scopes(text),morrow_work.notice_scopes_valid(jsonb),
 morrow_work.notice_ids_valid(jsonb,integer),morrow_work.connection_health_reconcile(text,text,text,text),
 morrow_work.connector_inbox_apply_v2(text),morrow_work.connector_health_reconcile(text),morrow_work.connector_checks_due(),
 morrow_work.connector_notices_due(),morrow_work.connector_deletions_due(),morrow_work.connector_deletion_apply(text),
 morrow_work.connector_inbox_stuck(),morrow_work.connection_notices_open(),
 morrow_vault.shopify_install_prepare_v2(text,text,text,text),morrow_vault.shopify_check_resolve(text),
 morrow_vault.shopify_check_record(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.release_shopify_scopes(text),morrow_work.notice_scopes_valid(jsonb),
 morrow_work.notice_ids_valid(jsonb,integer),morrow_work.connection_health_reconcile(text,text,text,text) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.connector_inbox_apply_v2(text),morrow_work.connector_health_reconcile(text),
 morrow_work.connector_checks_due(),morrow_work.connector_notices_due(),morrow_work.connector_deletions_due(),
 morrow_work.connector_deletion_apply(text),morrow_work.connector_inbox_stuck() TO morrow_connector_ingress;
GRANT EXECUTE ON FUNCTION morrow_vault.shopify_install_prepare_v2(text,text,text,text),morrow_vault.shopify_check_resolve(text),
 morrow_vault.shopify_check_record(text,text,text,text,text) TO morrow_vault_broker;
GRANT EXECUTE ON FUNCTION morrow_work.connection_notices_open() TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_inbox_apply_v2(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_health_reconcile(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_checks_due() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_notices_due() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_deletions_due() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_deletion_apply(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_inbox_stuck() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connection_notices_open() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_install_prepare_v2(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_check_resolve(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_check_record(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
